/**
 * Brain Engine — Perception cheap-dedup helper (TD-086).
 *
 * Single responsibility: given a candidate (title + content), look up the
 * nearest existing learning by cosine similarity over the local embeddings
 * and report whether it crosses the dedup threshold. The runner uses this
 * BEFORE `persistCandidate` to skip near-duplicate inserts and instead
 * increment a forensic counter on the matched row.
 *
 * Why a separate module:
 *   - keeps the runner slim (one extra `if (match)` branch);
 *   - lets unit tests drive the helper without standing up the full
 *     transcript pipeline;
 *   - makes the embedding-singleton reuse explicit (the runner already
 *     calls `generateEmbedding` once per candidate during `persistCandidate`,
 *     so we share the same Xenova/all-MiniLM-L6-v2 pipeline load).
 *
 * sqlite-vec returns L2 distance (not cosine), but our embedding pipeline
 * normalises vectors (`normalize: true` in `utils/embeddings.ts:83`), so
 * for unit vectors the identity holds:
 *   cosine_similarity = 1 - (L2_distance² / 2)
 * which collapses to `(2 - L2²) / 2`. We invert L2 once per match and
 * apply the threshold against cosine — the user-facing knob is cosine, so
 * preserving that vocabulary at the API surface keeps the operator config
 * (`dedup_cosine_threshold`) intuitive.
 *
 * TODO(FR-116): when soft-delete (`deleted_at`) lands on `learnings`, add
 * `WHERE deleted_at IS NULL` to the lookup so deleted rows do not pollute
 * the dedup pass.
 *
 * @module engine/components/perception/dedup
 * @author Fifty.ai
 */

import type Database from 'better-sqlite3';
import type { PerceptionCandidate } from './types.js';
import { generateEmbedding } from '../../../utils/embeddings.js';
import { isVectorSearchAvailable, vectorSearch } from '../../../utils/vector-search.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A successful dedup match — a candidate fingerprint already exists in the corpus. */
export interface DedupMatch {
  /** `learnings.id` of the matched row. */
  matched_id: number;
  /** `learnings.review_status` of the matched row at lookup time. */
  status: string;
  /** Cosine similarity in [0, 1]. Higher = more similar. */
  similarity: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * K nearest neighbours to consider per candidate. The vec0 query orders
 * results by L2 ascending, so duplicates concentrate in the top 1-3. K=10
 * is generous headroom — if a true match somehow lands at K=11 we will
 * insert a dup and the next janitor pass cleans it up. Raise K only if
 * empirical observation shows misses.
 */
const KNN_LIMIT = 10;

/**
 * Convert sqlite-vec's L2 distance (between two unit vectors) to cosine
 * similarity. Embeddings are L2-normalised (`normalize: true`) so the
 * identity holds without a re-normalisation step:
 *
 *   cosine = 1 - (L2² / 2)
 *
 * Bounded clamp to [-1, 1] guards against floating-point drift on identical
 * vectors (where L2 should be exactly 0 but may surface as 1e-7).
 */
function l2DistanceToCosine(l2Distance: number): number {
  const cos = 1 - (l2Distance * l2Distance) / 2;
  if (cos > 1) return 1;
  if (cos < -1) return -1;
  return cos;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find the nearest existing learning whose cosine similarity to the
 * candidate fingerprint meets `threshold`.
 *
 * Returns `null` when:
 *   - sqlite-vec is unavailable (e.g. test in-memory DB without the vec0
 *     virtual table) — defensive zero-cost early exit;
 *   - no neighbour crosses the threshold;
 *   - the embedding pipeline throws (best-effort: dedup never gates the
 *     pipeline; we fall through to insert).
 *
 * Match selection: the closest neighbour by L2 ascending that crosses the
 * threshold wins. We do NOT pick the highest cosine across ALL crossings —
 * with K=10 and L2-ordered results, the first crossing is also the closest.
 *
 * @param db        Open better-sqlite3 handle (must have `learnings_vec`
 *                  available for a non-null return).
 * @param candidate The pre-persistence candidate emitted by an extractor.
 *                  We embed `${title} ${content}` — matches the input shape
 *                  used by `persistCandidate` so the cosine geometry is
 *                  identical.
 * @param threshold Cosine threshold in [0, 1]. Default 0.85.
 */
export async function findNearestMatch(
  db: Database.Database,
  candidate: PerceptionCandidate,
  threshold: number = 0.85,
): Promise<DedupMatch | null> {
  if (!isVectorSearchAvailable(db)) {
    return null;
  }

  let embedding: Float32Array;
  try {
    embedding = await generateEmbedding(`${candidate.title} ${candidate.content}`);
  } catch (err) {
    console.error(
      '[perception.dedup] embedding generation failed — skipping dedup for this candidate:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  let neighbours: Array<{ rowid: number; distance: number }>;
  try {
    neighbours = vectorSearch(db, embedding, KNN_LIMIT);
  } catch (err) {
    console.error(
      '[perception.dedup] vectorSearch failed — skipping dedup for this candidate:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  if (neighbours.length === 0) return null;

  // Prepared once per call — reused across the K lookups. `learnings.id`
  // matches `learnings_vec.rowid` by construction (insertEmbedding writes
  // the same id into both).
  // TODO(FR-116): add `AND deleted_at IS NULL` once soft-delete column ships.
  const lookup = db.prepare(
    'SELECT id, review_status FROM learnings WHERE id = ?',
  );

  for (const neighbour of neighbours) {
    const cosine = l2DistanceToCosine(neighbour.distance);
    if (cosine < threshold) continue;

    const row = lookup.get(neighbour.rowid) as
      | { id: number; review_status: string }
      | undefined;
    if (!row) {
      // Orphan: the vec row outlived the learnings row (rejected hard-delete
      // race, manual cleanup, etc.). Skip — the next janitor pass will
      // reconcile.
      continue;
    }
    return {
      matched_id: row.id,
      status: row.review_status,
      similarity: cosine,
    };
  }

  return null;
}

/**
 * Record a rediscovery against an existing learning. Single UPDATE that
 * bumps the perception-channel counter and stamps the moment of last
 * re-extraction. Call exactly once per matched candidate.
 *
 * Notes:
 *   - `updated_at` is intentionally NOT touched. `updated_at` semantically
 *     means "row content was edited"; rediscovery is a counter bump, not
 *     an edit. (Sync uses `created_at` for LWW on learnings, so neither
 *     column matters for sync — this is purely about semantic clarity.)
 *   - `seen_again_count` and `last_seen_at` are EXCLUDED from SYNC_TABLES
 *     by design: rediscovery counts are per-machine usage signals; LWW
 *     across machines would be wrong.
 */
export function recordRediscovery(
  db: Database.Database,
  matchedId: number,
): void {
  db.prepare(
    `UPDATE learnings
       SET seen_again_count = seen_again_count + 1,
           last_seen_at = datetime('now')
       WHERE id = ?`,
  ).run(matchedId);
}
