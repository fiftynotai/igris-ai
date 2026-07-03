/**
 * FR-188 — Dimensions 1 + 3: blind recall + ranking quality.
 *
 * For each golden query, call the REAL `handleMemoryRecall`, parse the ranked
 * ids from the envelope, and score hit@{1,3,5,10} / precision@{1,5} / MRR /
 * nDCG@5 against the golden target set. Each query is tagged with its
 * query↔target lexical-overlap band; the HEADLINE is hit@5 on the LOW band —
 * the adversarial "no shared distinctive tokens" case that is genuine semantic
 * recall, and the citable "expected lower than B3's 100%" number.
 *
 * @module eval/memory/dimensions/recall
 */

import { handleMemoryRecall } from '../../../../src/tools/memory.js';
import { parseRankedIds, envelopeText } from '../parse.js';
import {
  K_LEVELS, P_LEVELS, hitAtK, precisionAtK, reciprocalRank, ndcgAtK,
  contentWords, jaccard, bandOf, mean, r4, type Band,
} from '../metrics.js';
import type { CorpusEntry } from '../seed.js';

export interface GoldenQuery {
  qid: string;
  project: string;
  query: string;
  target_keys: string[];
  sibling_keys?: string[];
  author: string;
  notes?: string;
}

export interface RecallQueryResult {
  qid: string;
  project: string;
  author: string;
  band: Band;
  overlap_jaccard: number;
  target_ids: number[];
  ranked_ids: number[];
  first_hit_rank: number | null;
  hit_at: Record<string, 0 | 1>;
  precision_at: Record<string, number>;
  reciprocal_rank: number;
  ndcg_at_5: number;
  latency_ms: number;
}

export interface BandRow {
  band: Band;
  n: number;
  hit_at_5: number | null;
  hit_at_1: number | null;
  mrr: number | null;
  ndcg_at_5: number | null;
}

export interface RecallDimResult {
  n: number;
  aggregate: {
    hit_at: Record<string, number>;
    precision_at: Record<string, number>;
    mrr: number;
    ndcg_at_5: number;
  };
  bands: BandRow[];
  headline_low_band_hit_at_5: number | null;
  per_query: RecallQueryResult[];
  latency_ms: { mean: number; p50: number; max: number };
}

function keysToIds(keys: string[], keyToId: Map<string, number>): number[] {
  const ids: number[] = [];
  for (const k of keys) {
    const id = keyToId.get(k);
    if (id === undefined) throw new Error(`[eval:recall] unknown corpus key in golden set: ${k}`);
    ids.push(id);
  }
  return ids;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

export async function runRecallDimension(
  queries: GoldenQuery[],
  keyToId: Map<string, number>,
  corpusByKey: Map<string, CorpusEntry>,
  k: number,
): Promise<RecallDimResult> {
  const per: RecallQueryResult[] = [];

  for (const q of queries) {
    const targetIds = keysToIds(q.target_keys, keyToId);
    const siblingIds = keysToIds(q.sibling_keys ?? [], keyToId);
    const positives = new Set<number>([...targetIds, ...siblingIds]);

    const t0 = performance.now();
    const res = await handleMemoryRecall({ project: q.project, context: q.query, limit: k });
    const latency = performance.now() - t0;
    const ranked = parseRankedIds(envelopeText(res));

    const hit_at: Record<string, 0 | 1> = {};
    for (const n of K_LEVELS) hit_at[String(n)] = hitAtK(ranked, positives, n);
    const precision_at: Record<string, number> = {};
    for (const n of P_LEVELS) precision_at[String(n)] = r4(precisionAtK(ranked, positives, n));

    // Band from the query vs the FIRST target's content (recall_bench convention).
    const targetContent = corpusByKey.get(q.target_keys[0])?.content ?? '';
    const oj = jaccard(contentWords(q.query), contentWords(targetContent));

    let firstHit: number | null = null;
    for (let i = 0; i < ranked.length; i++) {
      if (positives.has(ranked[i])) { firstHit = i + 1; break; }
    }

    per.push({
      qid: q.qid,
      project: q.project,
      author: q.author,
      band: bandOf(oj),
      overlap_jaccard: r4(oj),
      target_ids: targetIds,
      ranked_ids: ranked,
      first_hit_rank: firstHit,
      hit_at,
      precision_at,
      reciprocal_rank: r4(reciprocalRank(ranked, positives)),
      ndcg_at_5: r4(ndcgAtK(ranked, positives, 5)),
      latency_ms: r4(latency),
    });
  }

  const aggregate = {
    hit_at: {} as Record<string, number>,
    precision_at: {} as Record<string, number>,
    mrr: r4(mean(per.map((p) => p.reciprocal_rank))),
    ndcg_at_5: r4(mean(per.map((p) => p.ndcg_at_5))),
  };
  for (const n of K_LEVELS) aggregate.hit_at[String(n)] = r4(mean(per.map((p) => p.hit_at[String(n)])));
  for (const n of P_LEVELS) aggregate.precision_at[String(n)] = r4(mean(per.map((p) => p.precision_at[String(n)])));

  const bandGroups: Record<Band, RecallQueryResult[]> = { low: [], med: [], high: [] };
  for (const p of per) bandGroups[p.band].push(p);
  const bands: BandRow[] = (['low', 'med', 'high'] as Band[]).map((band) => {
    const rs = bandGroups[band];
    return {
      band,
      n: rs.length,
      hit_at_5: rs.length ? r4(mean(rs.map((r) => r.hit_at['5']))) : null,
      hit_at_1: rs.length ? r4(mean(rs.map((r) => r.hit_at['1']))) : null,
      mrr: rs.length ? r4(mean(rs.map((r) => r.reciprocal_rank))) : null,
      ndcg_at_5: rs.length ? r4(mean(rs.map((r) => r.ndcg_at_5))) : null,
    };
  });
  const headline = bandGroups.low.length ? r4(mean(bandGroups.low.map((r) => r.hit_at['5']))) : null;

  const lat = per.map((p) => p.latency_ms).sort((a, b) => a - b);
  return {
    n: per.length,
    aggregate,
    bands,
    headline_low_band_hit_at_5: headline,
    per_query: per,
    latency_ms: { mean: r4(mean(lat)), p50: r4(percentile(lat, 0.5)), max: r4(lat[lat.length - 1] ?? 0) },
  };
}
