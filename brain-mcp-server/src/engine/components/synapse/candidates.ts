/**
 * Brain Engine v7.1 — Synapse candidate generation (FR-211).
 *
 * The cheap, deterministic pre-filter (learning #153) that bounds the LLM's
 * prompt cost over the whole learning corpus. `buildCandidatePairs(db, cfg)`
 * surfaces at most `cfg.max_pairs` learning↔learning pairs worth judging:
 *
 *   PRIMARY (embedding-cosine): for each learning with an embedding, a vec0 KNN
 *     over `learnings_vec` (top-k), keeping neighbours whose `l2ToCosine`
 *     similarity ≥ `cfg.cosine_floor`. Fail-soft: if sqlite-vec is unavailable
 *     the whole cosine pass is skipped (degrade to shared-brief only).
 *   SECONDARY (shared source_brief): learnings that share a non-empty
 *     `source_brief` are candidate `related_to` pairs (a cheap GROUP BY).
 *
 * EXCLUSIONS: any pair already in `entity_edges` (any edge_type) AND any pair
 * already pending as an `edge_inference` suggestion are dropped — synapse never
 * re-proposes an existing or queued edge. Pairs are sorted-id deduped, ordered
 * deterministically (cosine signal first, then id) and capped.
 *
 * M1 scope = learnings↔learnings (decisions have no `decisions_vec`; a
 * shared-brief-only decision pass is a later milestone). Every SQL read is
 * fail-soft (a partial/absent schema yields fewer pairs, never a throw).
 *
 * @module engine/components/synapse/candidates
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { bufferToEmbedding } from '../../../utils/embeddings.js';
import { isVectorSearchAvailable, vectorSearch } from '../../../utils/vector-search.js';
import { l2ToCosine } from '../../../utils/hybrid-search.js';
import { DEFAULT_SYNAPSE_CONFIG, type CandidatePair, type SynapseConfig } from './types.js';

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

/** A learning row the candidate generator reads (id + display + embedding). */
interface LearningRow {
  id: number;
  title: string;
  content: string;
  source_brief: string | null;
  embedding: Buffer | null;
}

/**
 * The set of learning↔learning pairs that already have an `entity_edge` (any
 * edge_type). Fail-soft: absent table → empty set. These are excluded from
 * candidate generation so synapse never re-proposes an existing edge.
 */
export function loadExistingEdgePairs(db: Database.Database): Set<string> {
  const set = new Set<string>();
  try {
    const rows = db
      .prepare(
        `SELECT from_id, to_id FROM entity_edges
          WHERE from_type = 'learning' AND to_type = 'learning'`,
      )
      .all() as Array<{ from_id: string; to_id: string }>;
    for (const r of rows) {
      const a = Number(r.from_id);
      const b = Number(r.to_id);
      if (Number.isInteger(a) && Number.isInteger(b)) set.add(sortedKey(a, b));
    }
  } catch {
    /* entity_edges absent — empty exclusion set */
  }
  return set;
}

/**
 * The set of learning↔learning pairs already pending as an `edge_inference`
 * suggestion (parsed from each pending suggestion's `suggested_action.from/to`).
 * Fail-soft: absent table / malformed action → skipped. Excluded so synapse does
 * not double-queue the same proposed edge across runs.
 */
export function loadPendingEdgePairs(db: Database.Database): Set<string> {
  const set = new Set<string>();
  try {
    const rows = db
      .prepare(
        `SELECT suggested_action FROM suggestions
          WHERE status = 'pending' AND source_module = 'edge_inference'`,
      )
      .all() as Array<{ suggested_action: string | null }>;
    for (const r of rows) {
      if (!r.suggested_action) continue;
      try {
        const action = JSON.parse(r.suggested_action) as {
          from?: { id?: unknown };
          to?: { id?: unknown };
        };
        const a = Number(action?.from?.id);
        const b = Number(action?.to?.id);
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

/** Numeric rank so the deterministic ORDER favours the higher-quality signal. */
function signalRank(signal: CandidatePair['signal']): number {
  return signal === 'cosine' ? 0 : 1;
}

/**
 * Build the capped, deduped, deterministically-ordered candidate-pair set for
 * one synapse run. See the module docstring for the two signals + the exclusion
 * discipline. Never throws — every read is fail-soft; an empty corpus (or an
 * absent vec extension with no shared briefs) yields `[]`.
 *
 * @param db     the brain DB
 * @param config the resolved synapse config (cosine_floor / top_k / max_pairs)
 */
export function buildCandidatePairs(
  db: Database.Database,
  config: SynapseConfig = DEFAULT_SYNAPSE_CONFIG,
): CandidatePair[] {
  const existing = loadExistingEdgePairs(db);
  const pending = loadPendingEdgePairs(db);
  const isExcluded = (a: number, b: number): boolean => {
    const key = sortedKey(a, b);
    return existing.has(key) || pending.has(key);
  };

  let learnings: LearningRow[] = [];
  try {
    learnings = db
      .prepare(
        `SELECT id, title, content, source_brief, embedding
           FROM learnings
          ORDER BY id ASC`,
      )
      .all() as LearningRow[];
  } catch {
    learnings = [];
  }

  const byId = new Map<number, LearningRow>();
  for (const l of learnings) byId.set(l.id, l);

  const seen = new Set<string>();
  const pairs: CandidatePair[] = [];

  const makePair = (a: number, b: number, signal: CandidatePair['signal'], extra: Partial<CandidatePair>): void => {
    const [loId, hiId] = a < b ? [a, b] : [b, a];
    const lo = byId.get(loId);
    const hi = byId.get(hiId);
    if (!lo || !hi) return;
    pairs.push({
      from_id: loId,
      to_id: hiId,
      from_title: lo.title,
      from_snippet: snippet(lo.content),
      to_title: hi.title,
      to_snippet: snippet(hi.content),
      signal,
      ...extra,
    });
  };

  // PRIMARY — embedding-cosine KNN (fail-soft when sqlite-vec is unavailable).
  if (isVectorSearchAvailable(db)) {
    for (const l of learnings) {
      if (!l.embedding) continue;
      let emb: Float32Array;
      try {
        emb = bufferToEmbedding(l.embedding);
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
        if (!byId.has(nid)) continue;
        const cosine = l2ToCosine(n.distance);
        if (cosine < config.cosine_floor) continue;
        const key = sortedKey(l.id, nid);
        if (seen.has(key)) continue;
        if (isExcluded(l.id, nid)) continue;
        seen.add(key);
        makePair(l.id, nid, 'cosine', { cosine: Number(cosine.toFixed(4)) });
      }
    }
  }

  // SECONDARY — learnings sharing a non-empty source_brief.
  const byBrief = new Map<string, number[]>();
  for (const l of learnings) {
    const brief = (l.source_brief ?? '').trim();
    if (!brief) continue;
    const bucket = byBrief.get(brief);
    if (bucket) bucket.push(l.id);
    else byBrief.set(brief, [l.id]);
  }
  for (const [brief, ids] of byBrief) {
    if (ids.length < 2) continue;
    const sorted = ids.slice().sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        const key = sortedKey(a, b);
        if (seen.has(key)) continue;
        if (isExcluded(a, b)) continue;
        seen.add(key);
        makePair(a, b, 'shared_brief', { shared_brief: brief });
      }
    }
  }

  // Deterministic ORDER — cosine signal first (favoured under the cap), then id.
  pairs.sort(
    (x, y) =>
      signalRank(x.signal) - signalRank(y.signal) ||
      x.from_id - y.from_id ||
      x.to_id - y.to_id,
  );

  return pairs.slice(0, config.max_pairs);
}
