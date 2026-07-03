/**
 * FR-188 — Dimension 2: precision / no-answer behavior.
 *
 * Runs each no-answer query (a topic absent from the corpus) through all three
 * read channels and records, per channel, whether it correctly refused (emitted
 * the no-answer sentinel) or surfaced ids (false positives).
 *
 * HONESTY NOTE (measured, not a bug): the vector channel (recall/hybrid) has NO
 * relevance floor — `vectorSearch` always returns the k nearest neighbours, so
 * for a non-empty corpus it surfaces *something* even for an irrelevant query.
 * Only the BM25 channel (`handleMemorySearch`) can genuinely refuse (no FTS
 * match → sentinel). The HEADLINE no-answer metric is therefore the SEARCH
 * channel's refusal rate; recall/hybrid rates are reported as informational
 * system-property measurements, not pass/fail.
 *
 * @module eval/memory/dimensions/no_answer
 */

import {
  handleMemoryRecall, handleMemorySearch, handleMemoryHybridSearch,
} from '../../../../src/tools/memory.js';
import { parseRankedIds, parseNoAnswer } from '../parse.js';
import { safeInvoke } from '../invoke.js';
import { r4 } from '../metrics.js';

export interface NoAnswerQuery {
  qid: string;
  project: string;
  query: string;
  notes?: string;
}

type Channel = 'recall' | 'search' | 'hybrid';

export interface NoAnswerQueryResult {
  qid: string;
  refused: Record<Channel, boolean>;
  surfaced_count: Record<Channel, number>;
  errored: Record<Channel, boolean>;
}

export interface NoAnswerDimResult {
  n: number;
  refusal_rate: Record<Channel, number>;
  false_positive_rate: Record<Channel, number>;
  error_rate: Record<Channel, number>;
  headline_search_refusal_rate: number;
  per_query: NoAnswerQueryResult[];
  note: string;
}

export async function runNoAnswerDimension(
  queries: NoAnswerQuery[],
  k: number,
): Promise<NoAnswerDimResult> {
  const per: NoAnswerQueryResult[] = [];

  for (const q of queries) {
    const recall = await safeInvoke(() => handleMemoryRecall({ project: q.project, context: q.query, limit: k }));
    const search = await safeInvoke(() => handleMemorySearch({ query: q.query, project: q.project, limit: k }));
    const hybrid = await safeInvoke(() => handleMemoryHybridSearch({ query: q.query, project: q.project, limit: k }));

    per.push({
      qid: q.qid,
      refused: {
        recall: !recall.errored && parseNoAnswer(recall.text),
        search: !search.errored && parseNoAnswer(search.text),
        hybrid: !hybrid.errored && parseNoAnswer(hybrid.text),
      },
      surfaced_count: {
        recall: recall.errored ? 0 : parseRankedIds(recall.text).length,
        search: search.errored ? 0 : parseRankedIds(search.text).length,
        hybrid: hybrid.errored ? 0 : parseRankedIds(hybrid.text).length,
      },
      errored: { recall: recall.errored, search: search.errored, hybrid: hybrid.errored },
    });
  }

  const channels: Channel[] = ['recall', 'search', 'hybrid'];
  const refusal_rate = {} as Record<Channel, number>;
  const false_positive_rate = {} as Record<Channel, number>;
  const error_rate = {} as Record<Channel, number>;
  for (const c of channels) {
    refusal_rate[c] = r4(per.filter((p) => p.refused[c]).length / (per.length || 1));
    false_positive_rate[c] = r4(per.filter((p) => p.surfaced_count[c] > 0).length / (per.length || 1));
    error_rate[c] = r4(per.filter((p) => p.errored[c]).length / (per.length || 1));
  }

  return {
    n: per.length,
    refusal_rate,
    false_positive_rate,
    error_rate,
    headline_search_refusal_rate: refusal_rate.search,
    per_query: per,
    note: 'Vector channel (recall/hybrid) has no relevance floor — kNN always returns nearest neighbours, so its FP rate is a system property, not a defect. The BM25 SEARCH channel is the refusal-capable path. FINDING: handleMemorySearch/_hybrid_search THROW on FTS5-special input (e.g. a literal "?") that handleMemoryRecall swallows via its internal try/catch — see error_rate; sanitizeFts5Query does not strip "?".',
  };
}
