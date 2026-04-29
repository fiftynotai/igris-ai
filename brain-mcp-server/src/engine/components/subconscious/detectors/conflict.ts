/**
 * Brain Engine v5.0 — Conflict Detector (FR-106 Phase 2)
 *
 * Pair-wise scan over recent learnings flagging probable contradictions.
 * Heuristic: cosine similarity (semantic closeness) gated against Jaccard
 * similarity (lexical overlap). A pair high in cosine AND low in Jaccard
 * is the signature of "same topic, different vocabulary" — the most
 * common shape of a contradicting fact.
 *
 * Vector access — the cosine-vs-L2 trap (plan §"Vector access"):
 *   We deliberately bypass `learnings_vec`. The vec0 virtual table only
 *   exposes L2 distance via `MATCH ... distance`; cosine would require a
 *   conversion (`cosine = 1 - L2^2 / 2` for unit-normalised vectors)
 *   that is fiddly, fragile, and doesn't help us when we want pair-wise
 *   comparisons rather than k-NN queries. Instead we read the raw
 *   `learnings.embedding` BLOB, decode via `bufferToEmbedding`, and
 *   compute cosine directly as a 384-dim dot product (since the pipeline
 *   already L2-normalises in `utils/embeddings.ts:70-85`).
 *
 * Latency budget: <500 ms for 100 learnings × all projects in a typical
 * brain (≤10 projects). Verified by the latency test in `conflict.test.ts`.
 *
 * Pure function: takes a `ReadOnlyDb` and a `DetectorConfig`, returns
 * `SuggestionCandidate[]`. Never writes, never throws on missing tables —
 * returns `[]` if `learnings` is absent (mirrors `gap.ts:103, 150`).
 *
 * @module engine/components/subconscious/detectors/conflict
 * @author Fifty.ai
 */

import { bufferToEmbedding } from '../../../../utils/embeddings.js';
import type {
  DetectorConfig,
  ReadOnlyDb,
  SuggestionCandidate,
  SuggestionPriority,
} from '../types.js';

/** Bytes-per-float * dims = 4 * 384. Matches the production embedding pipeline. */
const EXPECTED_BYTES = 1536;

/** Row shape pulled from `learnings` for pair-wise comparison. */
interface LearningRow {
  id: number;
  project: string;
  title: string;
  content: string;
  embedding: Buffer;
  created_at: string;
}

/** Decoded form retained for the O(N^2) sweep so we don't re-tokenize. */
interface Decoded {
  id: number;
  vec: Float32Array;
  tokens: Set<string>;
}

/** Match retained between sort and emit. */
interface PairMatch {
  a: Decoded;
  b: Decoded;
  cosine: number;
  jaccard: number;
}

/**
 * Run the conflict detector over every active project that has at least
 * one row in `learnings`. Returns one `SuggestionCandidate` per
 * conflicting pair, capped at `conflict_max_pairs_emitted` per project.
 */
export function detectConflict(
  db: ReadOnlyDb,
  config: DetectorConfig,
): SuggestionCandidate[] {
  // Empty-vectors early return — keeps the detector a no-op on a fresh
  // brain. Cheap query (single COUNT, indexed on embedding nullability is
  // not present but the table is bounded).
  let totalEmbeddings: number;
  try {
    totalEmbeddings = (
      db.prepare(
        `SELECT COUNT(*) AS n FROM learnings WHERE embedding IS NOT NULL`,
      ).get() as { n: number }
    ).n;
  } catch {
    // `learnings` table missing — fail-soft per detector contract.
    return [];
  }
  if (totalEmbeddings === 0) return [];

  // Find every project with at least one learning. Keeps the per-project
  // loop bounded to projects that can plausibly emit a conflict.
  let projects: { project: string }[];
  try {
    projects = db
      .prepare(
        `SELECT DISTINCT project FROM learnings
         WHERE project IS NOT NULL AND project != ''
         ORDER BY project ASC`,
      )
      .all() as { project: string }[];
  } catch {
    return [];
  }

  const out: SuggestionCandidate[] = [];
  for (const { project } of projects) {
    out.push(...detectForProject(db, project, config));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-project sweep
// ---------------------------------------------------------------------------

/**
 * Pull the most-recent N learnings for a project, decode all embeddings
 * up-front, then do an O(N^2) symmetric sweep. The cosine short-circuit
 * skips the (more expensive) Jaccard tokenisation for pairs that aren't
 * topically related, which is most of them.
 */
function detectForProject(
  db: ReadOnlyDb,
  project: string,
  config: DetectorConfig,
): SuggestionCandidate[] {
  let rows: LearningRow[];
  try {
    rows = db
      .prepare(
        `SELECT id, project, title, content, embedding, created_at
         FROM learnings
         WHERE project = ?
           AND embedding IS NOT NULL
           AND length(embedding) = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(
        project,
        EXPECTED_BYTES,
        config.conflict_max_pairs_per_project,
      ) as LearningRow[];
  } catch {
    return [];
  }
  if (rows.length < 2) return [];

  // Decode once, materialise tokens once. Decoding is zero-copy
  // (Float32Array view over the underlying buffer), so the cost is the
  // tokenisation, which is cheap enough to do up-front for the entire
  // sample window.
  const decoded: Decoded[] = rows.map((r) => ({
    id: r.id,
    vec: bufferToEmbedding(r.embedding),
    tokens: tokenize(`${r.title} ${r.content}`),
  }));

  const matches: PairMatch[] = [];
  for (let i = 0; i < decoded.length; i++) {
    for (let j = i + 1; j < decoded.length; j++) {
      const cosine = cosineSimNormalized(decoded[i].vec, decoded[j].vec);
      if (cosine < config.conflict_cosine_threshold) continue;

      const jaccard = jaccardSim(decoded[i].tokens, decoded[j].tokens);
      if (jaccard >= config.conflict_jaccard_threshold) continue;

      matches.push({ a: decoded[i], b: decoded[j], cosine, jaccard });
    }
  }
  if (matches.length === 0) return [];

  // Sort by cosine descending so the strongest conflicts surface first;
  // cap per-project emissions so a project full of similar bug-fix
  // learnings can't drown the user in noise.
  matches.sort((m1, m2) => m2.cosine - m1.cosine);
  const capped = matches.slice(0, config.conflict_max_pairs_emitted);

  const out: SuggestionCandidate[] = [];
  for (const m of capped) {
    const priority = priorityForConflict(m.cosine, m.jaccard);
    if (priority === null) continue;

    const [smaller, larger] = m.a.id < m.b.id ? [m.a.id, m.b.id] : [m.b.id, m.a.id];
    out.push({
      source_module: 'conflict',
      project_slug: project || null,
      title: `Possible contradiction: Learning #${smaller} vs #${larger}`,
      evidence: {
        learning_ids: [smaller, larger],
        cosine: round4(m.cosine),
        jaccard: round4(m.jaccard),
        project_slug: project,
      },
      priority,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

/**
 * Cosine similarity for L2-normalised vectors (cosine = dot product).
 *
 * Pre-condition: both vectors come from `utils/embeddings.ts:generateEmbedding`
 * which sets `normalize: true`. The defensive `Math.max(-1, Math.min(1, ...))`
 * clip protects against future drift if the normalisation invariant ever
 * regresses; for production data the unclipped dot product is already in
 * range.
 */
function cosineSimNormalized(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}

/**
 * Tokenize for Jaccard. Lowercase, split on non-word characters, drop
 * tokens of length <= 2 to filter common stop-shapes ("a", "an", "of",
 * "to") without pulling in a stopword list.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2),
  );
}

/**
 * Jaccard similarity: |A ∩ B| / |A ∪ B|. Two empty sets are treated as
 * fully overlapping (returns 1) — matches the convention that an undefined
 * lexical overlap should NOT classify the pair as a conflict.
 */
function jaccardSim(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

/**
 * Map (cosine, jaccard) -> priority bucket, or null for "do not emit".
 * Bands per FR-106 plan Concern 7:
 *   cosine > 0.92 AND jaccard < 0.3 -> high
 *   cosine > 0.85 AND jaccard < 0.5 -> medium
 *   below -> filtered out (noise)
 *
 * The `low` priority is intentionally not emitted by this detector —
 * conflict signals below the medium band are too noisy to be useful.
 */
function priorityForConflict(cosine: number, jaccard: number): SuggestionPriority | null {
  if (cosine > 0.92 && jaccard < 0.3) return 'high';
  if (cosine > 0.85 && jaccard < 0.5) return 'medium';
  return null;
}

/**
 * Round a similarity score to 4 decimal places for storage in `evidence`.
 * Avoids surfacing floating-point garbage like 0.9200000000000003.
 */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
