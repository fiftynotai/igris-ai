/**
 * FR-188 — Envelope parsers for the memory handler text output.
 *
 * The memory handlers (`handleMemoryRecall`/`_search`/`_hybrid_search`) return
 * an MCP text envelope: a header line, then one block per result. Each block is
 * headed `--- Recall N ---` / `--- Result N ---` and carries an `ID: <n>` line.
 * Block order == rank order. The no-answer path returns a single sentinel line
 * with no result blocks.
 *
 * This module is the ONE place the eval couples to that text format. It is pure
 * and unit-tested (see `__tests__/smoke.test.ts`) so a format change surfaces
 * as a failing parser test rather than a silently wrong scorecard.
 *
 * COUPLING: mirrors the `ID:` / `--- Recall|Result N ---` block format + the two
 * no-answer sentinel prefixes emitted by `src/tools/memory.ts`. If those strings
 * change, update the constants below.
 *
 * @module eval/memory/parse
 */

/** No-answer sentinel prefixes emitted by the three read handlers. */
export const NO_ANSWER_PREFIXES = [
  'No relevant learnings found', // handleMemoryRecall
  'No learnings found matching', // handleMemorySearch + handleMemoryHybridSearch
] as const;

/**
 * Extract the ranked learning ids from a recall/search/hybrid envelope, in rank
 * order (block order). Returns [] for a no-answer envelope (no `ID:` lines).
 */
export function parseRankedIds(text: string): number[] {
  const ids: number[] = [];
  const re = /^ID: (\d+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ids.push(parseInt(m[1], 10));
  }
  return ids;
}

/**
 * True when the envelope is a no-answer sentinel (the handler declined to
 * surface any learning). Matches the recall + search/hybrid prefixes.
 */
export function parseNoAnswer(text: string): boolean {
  const head = text.trimStart();
  return NO_ANSWER_PREFIXES.some((p) => head.startsWith(p));
}

/**
 * Convenience: pull the flat text out of the `{ content: [{ type, text }] }`
 * MCP envelope the handlers return.
 */
export function envelopeText(res: { content: { type: string; text: string }[] }): string {
  return res.content.map((c) => c.text).join('\n');
}
