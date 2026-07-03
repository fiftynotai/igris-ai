/**
 * Brain Engine v7.1 — Arbiter opposition candidate generation (FR-116 M2).
 *
 * The cheap, deterministic pre-filter (learning #153) that bounds the LLM's
 * prompt cost over the whole learning corpus. `buildContradictionPairs(db, cfg)`
 * surfaces at most `cfg.max_pairs` APPROVED learning↔learning pairs that look
 * like CONTRADICTIONS (not near-duplicates):
 *
 *   For each APPROVED learning, embed its NORMALIZED fingerprint
 *   (`normalizedFingerprint(title, content)` — the ONE canonical derivation,
 *   #930/TD-087) and run a vec0 KNN over `learnings_vec` (top-k), keeping
 *   neighbours whose `l2ToCosine` similarity is in the SAME-TOPIC band
 *   [`contradiction_cosine_floor`, `contradiction_cosine_ceil`] AND that fire a
 *   cheap deterministic OPPOSITION cue (Decision #7):
 *
 *     - NEGATION POLARITY XOR: exactly ONE side carries a negation cue
 *       ("not"/"avoid"/"wrong"/"deprecated"/…) — the "use X" vs "X is wrong"
 *       shape; OR
 *     - ANTONYM OPPOSITION: the two sides carry an antonym pair
 *       (enable/disable, always/never, …).
 *
 *   Both gates must clear: high cosine (same topic) makes the pair COMPARABLE;
 *   the opposition cue makes it likely OPPOSING (not merely near-duplicate — that
 *   is the janitor's mandate). The upper cosine ceiling excludes near-identical
 *   restatements so the arbiter + janitor candidate sets stay disjoint.
 *
 * CRITICAL (#930/TD-087): the QUERY embedding is derived from the NORMALIZED
 * fingerprint (the same shape `perception/dedup.ts:findNearestMatch` +
 * `janitor/candidates.ts:buildDuplicatePairs` use), NOT the raw stored text — a
 * raw-embedding cosine UNDERSTATES similarity. We reuse the shipped
 * `generateEmbedding` (injectable for tests) + `normalizedFingerprint` +
 * `vectorSearch` + `l2ToCosine` primitives; we do NOT roll a new raw-cosine path.
 *
 * EXCLUSIONS: soft-deleted / superseded rows never appear (only approved rows are
 * scanned) AND any pair already pending as an `arbiter` `resolve_contradiction`
 * suggestion is dropped (never double-queue). Pairs are sorted-id deduped,
 * ordered deterministically (cosine desc, then id) and capped.
 *
 * Every read is fail-soft: if sqlite-vec is unavailable the whole pass yields
 * `[]`. Never throws.
 *
 * @module engine/components/arbiter/candidates
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { generateEmbedding } from '../../../utils/embeddings.js';
import { isVectorSearchAvailable, vectorSearch } from '../../../utils/vector-search.js';
import { l2ToCosine } from '../../../utils/hybrid-search.js';
import { normalizedFingerprint } from '../../../utils/learning-embed.js';
import { normalizeForDedup } from '../perception/dedup.js';
import {
  DEFAULT_ANTONYM_PAIRS,
  DEFAULT_ARBITER_CONFIG,
  type ArbiterConfig,
  type ContradictionPair,
} from './types.js';

/** An embedder — production default is the shipped `generateEmbedding`. */
export type Embedder = (text: string) => Promise<Float32Array>;

/** Injectable seams for `buildContradictionPairs` (tests inject a deterministic embedder). */
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

/**
 * True when `text` carries any negation cue. Matched against the
 * `normalizeForDedup`-normalized text (apostrophes/punctuation collapsed on BOTH
 * cue + text so "don't" → "don t" matches identically). Space-padded whole-token
 * match so a cue is not matched mid-word.
 */
export function hasNegationCue(text: string, cues: readonly string[]): boolean {
  const norm = ` ${normalizeForDedup(text)} `;
  for (const cue of cues) {
    const nc = normalizeForDedup(cue);
    if (nc.length > 0 && norm.includes(` ${nc} `)) return true;
  }
  return false;
}

/** Normalized whole-token set for the antonym check. */
function tokenSet(text: string): Set<string> {
  return new Set(normalizeForDedup(text).split(' ').filter((w) => w.length > 0));
}

/**
 * True when the two texts carry an antonym pair in EITHER direction (a has w1 &
 * b has w2, or a has w2 & b has w1) — a likely opposition signal.
 */
export function hasAntonymOpposition(
  aText: string,
  bText: string,
  pairs: ReadonlyArray<readonly [string, string]> = DEFAULT_ANTONYM_PAIRS,
): boolean {
  const A = tokenSet(aText);
  const B = tokenSet(bText);
  for (const [w1, w2] of pairs) {
    if ((A.has(w1) && B.has(w2)) || (A.has(w2) && B.has(w1))) return true;
  }
  return false;
}

/**
 * Compute the deterministic opposition cue for a candidate pair, or `null` when
 * the pair shows no opposition (a mere near-duplicate / same-polarity pair). The
 * cue string is advisory for the LLM ('negation' | 'antonym' | 'negation+antonym').
 */
export function oppositionCue(
  aTitle: string,
  aContent: string,
  bTitle: string,
  bContent: string,
  cues: readonly string[],
): string | null {
  const aText = `${aTitle} ${aContent}`;
  const bText = `${bTitle} ${bContent}`;
  // NEGATION POLARITY XOR — one side negates, the other asserts.
  const negA = hasNegationCue(aText, cues);
  const negB = hasNegationCue(bText, cues);
  const negationXor = negA !== negB;
  const antonym = hasAntonymOpposition(aText, bText);
  if (negationXor && antonym) return 'negation+antonym';
  if (negationXor) return 'negation';
  if (antonym) return 'antonym';
  return null;
}

/** A learning row the candidate generator reads (id + display fields + recency). */
interface LearningRow {
  id: number;
  title: string;
  content: string;
  created_at: string | null;
}

/**
 * The set of learning↔learning pairs already pending as an `arbiter`
 * `resolve_contradiction` suggestion. Parsed from each pending suggestion's
 * `suggested_action` (`winner_id`/`loser_id` OR `learning_a_id`/`learning_b_id`).
 * Fail-soft: absent table / malformed action → skipped. Excluded so the arbiter
 * does not double-queue the same proposed resolution across runs.
 */
export function loadPendingContradictionPairs(db: Database.Database): Set<string> {
  const set = new Set<string>();
  try {
    const rows = db
      .prepare(
        `SELECT suggested_action FROM suggestions
          WHERE status = 'pending' AND source_module = 'arbiter'`,
      )
      .all() as Array<{ suggested_action: string | null }>;
    for (const r of rows) {
      if (!r.suggested_action) continue;
      try {
        const action = JSON.parse(r.suggested_action) as {
          winner_id?: unknown;
          loser_id?: unknown;
          learning_a_id?: unknown;
          learning_b_id?: unknown;
        };
        const a = Number(action?.winner_id ?? action?.learning_a_id);
        const b = Number(action?.loser_id ?? action?.learning_b_id);
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
 * Build the capped, deduped, deterministically-ordered contradiction candidate
 * set for one arbiter run. See the module docstring for the KNN band + the
 * opposition cue + the exclusions. Never throws — every read is fail-soft; an
 * absent vec extension (or an empty corpus) yields `[]`.
 *
 * @param db     the brain DB
 * @param config the resolved arbiter config (cosine band / cues / top_k / max_pairs)
 * @param deps   injectable embedder seam (default: the shipped generateEmbedding)
 */
export async function buildContradictionPairs(
  db: Database.Database,
  config: ArbiterConfig = DEFAULT_ARBITER_CONFIG,
  deps: CandidateDeps = {},
): Promise<ContradictionPair[]> {
  // Fail-soft: no vec extension → no same-topic KNN → empty candidate set.
  if (!isVectorSearchAvailable(db)) return [];

  const embed = deps.embed ?? generateEmbedding;
  const pending = loadPendingContradictionPairs(db);

  let learnings: LearningRow[] = [];
  try {
    // Only APPROVED learnings — merged/superseded/pending/rejected are not scanned.
    learnings = db
      .prepare(
        `SELECT id, title, content, created_at
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
  const pairs: ContradictionPair[] = [];

  for (const l of learnings) {
    // Re-embed the NORMALIZED fingerprint as the query (#930/TD-087) — never the
    // raw stored text. Matches perception/dedup + janitor candidate geometry.
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
      // SAME-TOPIC band: high cosine (comparable) but not near-identical (that is
      // the janitor's dedup mandate — the ceiling keeps the sets disjoint).
      if (cosine < config.contradiction_cosine_floor) continue;
      if (cosine > config.contradiction_cosine_ceil) continue;
      const [loId, hiId] = l.id < nid ? [l.id, nid] : [nid, l.id];
      const key = sortedKey(loId, hiId);
      if (seen.has(key)) continue;
      if (pending.has(key)) continue;
      const lo = byId.get(loId)!;
      const hi = byId.get(hiId)!;
      // OPPOSITION cue (Decision #7): negation-polarity XOR OR antonym. A pair
      // with no cue is a mere near-dupe / agreement → NOT the arbiter's concern.
      // A cue-less pair is NOT marked `seen` — if the reverse KNN direction
      // re-surfaces it the gate rejects it again identically (deterministic).
      const cue = oppositionCue(lo.title, lo.content, hi.title, hi.content, config.negation_cues);
      if (cue === null) continue;
      seen.add(key);
      pairs.push({
        from_id: loId,
        to_id: hiId,
        from_title: lo.title,
        from_snippet: snippet(lo.content),
        from_created_at: lo.created_at ?? '',
        to_title: hi.title,
        to_snippet: snippet(hi.content),
        to_created_at: hi.created_at ?? '',
        cosine: Number(cosine.toFixed(4)),
        cue,
      });
    }
  }

  // Deterministic ORDER — highest cosine first (most comparable pairs under the
  // cap), then id. `toFixed(4)`-rounded cosine keeps the sort stable.
  pairs.sort(
    (x, y) => y.cosine - x.cosine || x.from_id - y.from_id || x.to_id - y.to_id,
  );

  return pairs.slice(0, config.max_pairs);
}
