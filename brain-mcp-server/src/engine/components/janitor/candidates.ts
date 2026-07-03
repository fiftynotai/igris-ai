/**
 * Brain Engine v7.1 — Janitor near-dupe candidate generation (FR-119).
 *
 * The cheap, deterministic pre-filter (learning #153) that bounds the LLM's
 * prompt cost over the whole learning corpus. `buildDuplicatePairs(db, cfg)`
 * surfaces at most `cfg.max_pairs` APPROVED learning↔learning pairs that look
 * like near-duplicates:
 *
 *   For each APPROVED learning, embed its NORMALIZED fingerprint
 *   (`normalizedFingerprint(title, content)` — the ONE canonical derivation,
 *   #930/TD-087) and run a vec0 KNN over `learnings_vec` (top-k), keeping
 *   neighbours whose `l2ToCosine` similarity ≥ `cfg.dupe_cosine_floor` (0.90,
 *   M1/FR-116) AND whose normalized-token Jaccard `overlap` ≥
 *   `cfg.dupe_min_overlap` (0.6). BOTH gates must clear — the overlap gate is
 *   what lets the cosine floor drop to 0.90 without flooding the LLM with
 *   same-topic-but-lexically-distinct pairs (#163).
 *
 * CRITICAL (#930/TD-087): the QUERY embedding is derived from the NORMALIZED
 * fingerprint (the same shape `perception/dedup.ts:findNearestMatch` uses),
 * NOT the raw stored text — a raw-embedding cosine UNDERSTATES similarity. We
 * reuse the shipped `generateEmbedding` (injectable for tests) +
 * `normalizedFingerprint` + `vectorSearch` + `l2ToCosine`; we do NOT roll a new
 * raw-cosine path (MAINTAINING row 96 invariant).
 *
 * EXCLUSIONS: soft-deleted (`review_status='merged'`) rows never appear (only
 * approved rows are scanned) AND any pair already pending as a `janitor`
 * `merge_learnings` suggestion is dropped (never double-queue the same merge).
 * Pairs are sorted-id deduped, ordered deterministically (cosine desc, then id)
 * and capped.
 *
 * Every read is fail-soft: if sqlite-vec is unavailable the whole pass yields
 * `[]` (the LLM near-dupe duty degrades to no-op — the deterministic hygiene
 * duties in the runner still run). Never throws.
 *
 * @module engine/components/janitor/candidates
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { generateEmbedding } from '../../../utils/embeddings.js';
import { isVectorSearchAvailable, vectorSearch } from '../../../utils/vector-search.js';
import { l2ToCosine } from '../../../utils/hybrid-search.js';
import { normalizedFingerprint } from '../../../utils/learning-embed.js';
import { normalizeForDedup } from '../perception/dedup.js';
import { DEFAULT_JANITOR_CONFIG, type DuplicatePair, type JanitorConfig } from './types.js';

/** An embedder — production default is the shipped `generateEmbedding`. */
export type Embedder = (text: string) => Promise<Float32Array>;

/** Injectable seams for `buildDuplicatePairs` (tests inject a deterministic embedder). */
export interface CandidateDeps {
  /** Embed the normalized fingerprint. Default: the shipped `generateEmbedding`. */
  embed?: Embedder;
}

/** Max chars of a learning's content carried into the candidate digest. */
const SNIPPET_MAX = 200;

/** Unordered pair key — `${min}:${max}` so the same pair maps to one string. */
function sortedKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Collapse whitespace + truncate a learning's content for the digest. */
function snippet(content: string): string {
  const s = (content ?? '').trim().replace(/\s+/g, ' ');
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s;
}

/** Cheap normalized-token Jaccard overlap in [0, 1] — M1 gate (>= dupe_min_overlap) + LLM advisory. */
function tokenOverlap(aTitle: string, aContent: string, bTitle: string, bContent: string): number {
  const toks = (t: string, c: string): Set<string> =>
    new Set(`${normalizeForDedup(t)} ${normalizeForDedup(c)}`.split(' ').filter((w) => w.length > 0));
  const A = toks(aTitle, aContent);
  const B = toks(bTitle, bContent);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : Number((inter / union).toFixed(4));
}

/** A learning row the candidate generator reads (id + display fields). */
interface LearningRow {
  id: number;
  title: string;
  content: string;
}

/**
 * The set of learning↔learning pairs already pending as a `janitor`
 * `merge_learnings` suggestion (parsed from each pending suggestion's
 * `suggested_action.survivor_id/duplicate_id`). Fail-soft: absent table /
 * malformed action → skipped. Excluded so the janitor does not double-queue the
 * same proposed merge across runs.
 */
export function loadPendingMergePairs(db: Database.Database): Set<string> {
  const set = new Set<string>();
  try {
    const rows = db
      .prepare(
        `SELECT suggested_action FROM suggestions
          WHERE status = 'pending' AND source_module = 'janitor'`,
      )
      .all() as Array<{ suggested_action: string | null }>;
    for (const r of rows) {
      if (!r.suggested_action) continue;
      try {
        const action = JSON.parse(r.suggested_action) as {
          survivor_id?: unknown;
          duplicate_id?: unknown;
        };
        const a = Number(action?.survivor_id);
        const b = Number(action?.duplicate_id);
        if (Number.isInteger(a) && Number.isInteger(b)) set.add(sortedKey(a, b));
      } catch {
        /* malformed action — skip */
      }
    }
  } catch {
    /* suggestions absent — empty exclusion set */
  }
  return set;
}

/**
 * Build the capped, deduped, deterministically-ordered near-dupe candidate set
 * for one janitor run. See the module docstring for the KNN signal + the
 * normalization discipline + the exclusions. Never throws — every read is
 * fail-soft; an absent vec extension (or an empty corpus) yields `[]`.
 *
 * @param db     the brain DB
 * @param config the resolved janitor config (dupe_cosine_floor / dupe_min_overlap / top_k / max_pairs)
 * @param deps   injectable embedder seam (default: the shipped generateEmbedding)
 */
export async function buildDuplicatePairs(
  db: Database.Database,
  config: JanitorConfig = DEFAULT_JANITOR_CONFIG,
  deps: CandidateDeps = {},
): Promise<DuplicatePair[]> {
  // Fail-soft: no vec extension → no near-dupe KNN → empty candidate set.
  if (!isVectorSearchAvailable(db)) return [];

  const embed = deps.embed ?? generateEmbedding;
  const pending = loadPendingMergePairs(db);

  let learnings: LearningRow[] = [];
  try {
    // Only APPROVED learnings — merged/pending/rejected rows are not deduped.
    learnings = db
      .prepare(
        `SELECT id, title, content
           FROM learnings
          WHERE COALESCE(review_status, 'approved') = 'approved'
          ORDER BY id ASC`,
      )
      .all() as LearningRow[];
  } catch {
    learnings = [];
  }

  const byId = new Map<number, LearningRow>();
  for (const l of learnings) byId.set(l.id, l);

  const seen = new Set<string>();
  const pairs: DuplicatePair[] = [];

  for (const l of learnings) {
    // Re-embed the NORMALIZED fingerprint as the query (#930/TD-087) — never the
    // raw stored text. Matches perception/dedup.ts:findNearestMatch geometry.
    let emb: Float32Array;
    try {
      emb = await embed(normalizedFingerprint(l.title, l.content));
    } catch {
      continue;
    }
    let neighbours: Array<{ rowid: number; distance: number }>;
    try {
      // top_k + 1 so the learning's own zero-distance self-match can be dropped.
      neighbours = vectorSearch(db, emb, config.top_k + 1);
    } catch {
      continue;
    }
    for (const n of neighbours) {
      const nid = Number(n.rowid);
      if (nid === l.id) continue;
      const other = byId.get(nid);
      if (!other) continue; // neighbour not in the approved set — skip
      const cosine = l2ToCosine(n.distance);
      if (cosine < config.dupe_cosine_floor) continue;
      const [loId, hiId] = l.id < nid ? [l.id, nid] : [nid, l.id];
      const key = sortedKey(loId, hiId);
      if (seen.has(key)) continue;
      if (pending.has(key)) continue;
      const lo = byId.get(loId)!;
      const hi = byId.get(hiId)!;
      // M1 (FR-116): the Jaccard overlap GATE. With the cosine floor lowered to
      // 0.90 the KNN admits same-topic-but-distinct pairs (high cosine, low
      // lexical overlap); requiring `overlap >= dupe_min_overlap` too keeps only
      // genuine near-dupes so the LLM is not flooded (#163). A gated pair is NOT
      // marked `seen` — if the reverse KNN direction re-surfaces it the gate
      // rejects it again identically (deterministic).
      const overlap = tokenOverlap(lo.title, lo.content, hi.title, hi.content);
      if (overlap < config.dupe_min_overlap) continue;
      seen.add(key);
      pairs.push({
        from_id: loId,
        to_id: hiId,
        from_title: lo.title,
        from_snippet: snippet(lo.content),
        to_title: hi.title,
        to_snippet: snippet(hi.content),
        cosine: Number(cosine.toFixed(4)),
        overlap,
      });
    }
  }

  // Deterministic ORDER — highest cosine first (most confident dupes under the
  // cap), then id. `toFixed(4)`-rounded cosine keeps the sort stable.
  pairs.sort(
    (x, y) => y.cosine - x.cosine || x.from_id - y.from_id || x.to_id - y.to_id,
  );

  return pairs.slice(0, config.max_pairs);
}
