/**
 * FR-188 — Scorecard aggregation + Markdown rendering.
 *
 * Combines the MVP dimension results into one JSON object (the machine-readable
 * regression artifact) and renders a human Markdown twin. Deferred dimensions
 * carry an explicit `"deferred"` marker (no silent scope-cut).
 *
 * @module eval/memory/scorecard
 */

import type { RecallDimResult } from './dimensions/recall.js';
import type { NoAnswerDimResult } from './dimensions/no_answer.js';
import type { GatingDimResult } from './dimensions/gating.js';
import type { PromotionDimResult } from './dimensions/promotion.js';

export interface DeferredMarker {
  dimension: string;
  status: 'deferred';
  reason: string;
  followup: string;
}

export const DEFERRED_DIMENSIONS: DeferredMarker[] = [
  {
    dimension: '4-affinity-boost-ab',
    status: 'deferred',
    reason: 'True A/B needs boost-off vs boost-on ranking; boosts live inside handleMemoryRecall and are not parameterizable without a reproduce-ranking harness.',
    followup: 'FR-188 follow-up brief: parameterize boosts or add a boost-off reproduce-ranking harness.',
  },
  {
    dimension: '5-dedup-correctness',
    status: 'deferred',
    reason: 'Already covered by scripts/dedup_corpus_eval.ts + engine/components/perception/__tests__/dedup.test.ts.',
    followup: 'No new work — point at existing dedup coverage.',
  },
  {
    dimension: '8-staleness',
    status: 'deferred',
    reason: 'No staleness metric defined yet (needs a last_accessed_at aging model).',
    followup: 'FR-188 follow-up brief: define a staleness/aging metric.',
  },
];

export interface Scorecard {
  brief: string;
  generated_at: string;
  db_path: string;
  corpus_size: number;
  k: number;
  vector_channel: boolean;
  headline: {
    blind_low_band_hit_at_5: number | null;
    note: string;
  };
  dimensions: {
    recall: RecallDimResult;
    no_answer: NoAnswerDimResult;
    gating: GatingDimResult;
    promotion: PromotionDimResult;
  };
  latency_ms: RecallDimResult['latency_ms'];
  deferred: DeferredMarker[];
}

export interface BuildScorecardInput {
  dbPath: string;
  corpusSize: number;
  k: number;
  vectorChannel: boolean;
  recall: RecallDimResult;
  noAnswer: NoAnswerDimResult;
  gating: GatingDimResult;
  promotion: PromotionDimResult;
}

export function buildScorecard(i: BuildScorecardInput): Scorecard {
  return {
    brief: 'FR-188',
    generated_at: new Date().toISOString(),
    db_path: i.dbPath,
    corpus_size: i.corpusSize,
    k: i.k,
    vector_channel: i.vectorChannel,
    headline: {
      blind_low_band_hit_at_5: i.recall.headline_low_band_hit_at_5,
      note: 'Blind hit@5 on the LOW lexical-overlap band (query shares no distinctive tokens with its target). Expected to be lower than a lexically-overlapping benchmark — this is the genuine-semantic-recall number.',
    },
    dimensions: {
      recall: i.recall,
      no_answer: i.noAnswer,
      gating: i.gating,
      promotion: i.promotion,
    },
    latency_ms: i.recall.latency_ms,
    deferred: DEFERRED_DIMENSIONS,
  };
}

function fmt(x: number | null): string {
  return x === null ? 'n/a' : String(x);
}

export function renderMarkdown(s: Scorecard): string {
  const r = s.dimensions.recall;
  const na = s.dimensions.no_answer;
  const g = s.dimensions.gating;
  const p = s.dimensions.promotion;

  const bandLines = r.bands
    .map((b) => `| ${b.band} | ${b.n} | ${fmt(b.hit_at_5)} | ${fmt(b.hit_at_1)} | ${fmt(b.mrr)} | ${fmt(b.ndcg_at_5)} |`)
    .join('\n');

  const deferredLines = s.deferred
    .map((d) => `| ${d.dimension} | ${d.status.toUpperCase()} | ${d.reason} |`)
    .join('\n');

  return `# FR-188 Memory-System Eval Scorecard

- **Generated:** ${s.generated_at}
- **Corpus size:** ${s.corpus_size} learnings
- **k:** ${s.k}
- **Vector channel:** ${s.vector_channel ? 'ON (BM25 + vector RRF)' : 'OFF (BM25-only)'}

## Headline

**Blind LOW-band hit@5 = ${fmt(s.headline.blind_low_band_hit_at_5)}**

${s.headline.note}

## Dim 1+3 — Blind recall + ranking (${r.n} queries)

Aggregate: hit@1=${r.aggregate.hit_at['1']} hit@3=${r.aggregate.hit_at['3']} hit@5=${r.aggregate.hit_at['5']} hit@10=${r.aggregate.hit_at['10']} | precision@1=${r.aggregate.precision_at['1']} precision@5=${r.aggregate.precision_at['5']} | MRR=${r.aggregate.mrr} | nDCG@5=${r.aggregate.ndcg_at_5}

| band | n | hit@5 | hit@1 | MRR | nDCG@5 |
|------|---|-------|-------|-----|--------|
${bandLines}

## Dim 2 — No-answer precision (${na.n} queries)

| channel | refusal rate | false-positive rate | error rate |
|---------|--------------|---------------------|------------|
| search (BM25, refusal-capable) | ${na.refusal_rate.search} | ${na.false_positive_rate.search} | ${na.error_rate.search} |
| recall (vector RRF) | ${na.refusal_rate.recall} | ${na.false_positive_rate.recall} | ${na.error_rate.recall} |
| hybrid (vector RRF) | ${na.refusal_rate.hybrid} | ${na.false_positive_rate.hybrid} | ${na.error_rate.hybrid} |

Headline (search refusal rate): **${na.headline_search_refusal_rate}**

> ${na.note}

## Dim 7 — Review-status gating (${g.n} pending cases)

- **Leaked into ranked results:** ${g.leaked_count} (MUST be 0)
- **handleMemoryGet returns all by id:** ${g.get_returns_all}
- **PASS:** ${g.pass}

## Dim 6 — Cross-project promotion (${p.n} pairs)

- TP=${p.tp} FP=${p.fp} FN=${p.fn} TN=${p.tn}
- precision=${fmt(p.precision)} recall=${fmt(p.recall)}
${p.per_case.map((c) => `- ${c.id} (expect ${c.expect}): promoted=${c.promoted} note_fired=${c.note_fired} → ${c.correct ? 'correct' : 'WRONG'}`).join('\n')}

## Dim 9 — Latency (informational, not a gate)

recall handler ms — mean=${s.latency_ms.mean} p50=${s.latency_ms.p50} max=${s.latency_ms.max}

## Deferred dimensions (explicit — no silent scope-cut)

| dimension | status | reason |
|-----------|--------|--------|
${deferredLines}
`;
}
