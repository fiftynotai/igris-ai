/**
 * FR-188 — Dimension 7: review-status gating (FR-109).
 *
 * For each gating case (a `pending_review` learning + a query worded to match
 * it), assert the pending id NEVER appears in recall/search/hybrid ranked ids,
 * AND that `handleMemoryGet(id)` still returns it (by-ID intentionally bypasses
 * the gate for the approval UI). A single leak fails the dimension.
 *
 * @module eval/memory/dimensions/gating
 */

import {
  handleMemoryRecall, handleMemorySearch, handleMemoryHybridSearch, handleMemoryGet,
} from '../../../../src/tools/memory.js';
import { parseRankedIds, envelopeText } from '../parse.js';
import { safeInvoke } from '../invoke.js';

export interface GatingCase {
  key: string;
  project: string;
  query: string;
}

export interface GatingCasesFile {
  description?: string;
  cases: GatingCase[];
}

export interface GatingCaseResult {
  key: string;
  id: number;
  leaked_in: string[]; // channels where the pending id wrongly surfaced
  get_returns_it: boolean;
}

export interface GatingDimResult {
  n: number;
  leaked_count: number; // MUST be 0
  get_returns_all: boolean;
  pass: boolean;
  per_case: GatingCaseResult[];
}

export async function runGatingDimension(
  cases: GatingCase[],
  keyToId: Map<string, number>,
  k: number,
): Promise<GatingDimResult> {
  const per: GatingCaseResult[] = [];

  for (const c of cases) {
    const id = keyToId.get(c.key);
    if (id === undefined) throw new Error(`[eval:gating] unknown corpus key: ${c.key}`);

    const recall = await safeInvoke(() => handleMemoryRecall({ project: c.project, context: c.query, limit: k }));
    const search = await safeInvoke(() => handleMemorySearch({ query: c.query, project: c.project, limit: k }));
    const hybrid = await safeInvoke(() => handleMemoryHybridSearch({ query: c.query, project: c.project, limit: k }));
    const recallIds = recall.errored ? [] : parseRankedIds(recall.text);
    const searchIds = search.errored ? [] : parseRankedIds(search.text);
    const hybridIds = hybrid.errored ? [] : parseRankedIds(hybrid.text);

    const leaked_in: string[] = [];
    if (recallIds.includes(id)) leaked_in.push('recall');
    if (searchIds.includes(id)) leaked_in.push('search');
    if (hybridIds.includes(id)) leaked_in.push('hybrid');

    const getText = envelopeText(handleMemoryGet({ id }));
    const get_returns_it = getText.includes(`ID: ${id}`) && !getText.includes('not found');

    per.push({ key: c.key, id, leaked_in, get_returns_it });
  }

  const leaked_count = per.reduce((a, p) => a + p.leaked_in.length, 0);
  const get_returns_all = per.every((p) => p.get_returns_it);

  return {
    n: per.length,
    leaked_count,
    get_returns_all,
    pass: leaked_count === 0 && get_returns_all,
    per_case: per,
  };
}
