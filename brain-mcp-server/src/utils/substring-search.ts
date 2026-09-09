/**
 * Igris Brain — honest substring filtering for list readers (FR-246 D3-f).
 *
 * Four dashboard surfaces (goals, suggestions, candidates, context docs) take a
 * `q` that is a **substring filter, not retrieval**. There is no ranking, no
 * stemming, no recall — it is `LIKE '%q%'` over a named field list, and the
 * whole point of this module is that the payload SAYS SO.
 *
 * WHY A PAYLOAD FIELD AND NOT A UI SENTENCE. The cheap way to satisfy "the
 * retrieval mode must be visible" is a hard-coded line of copy in the client.
 * That line is exactly the claim that goes stale the day someone swaps the
 * implementation underneath it, and NO gate can catch a stale sentence. A
 * payload field can be asserted by a test and by the browser gate — which is
 * what `G-BR-13b` does: no surface reporting `mode: "substring"` may render a
 * hybrid/recall readout.
 *
 * WHY THE ESCAPING MATTERS. `LIKE` gives `%` and `_` wildcard meaning, so an
 * unescaped `?q=%` matches EVERY row while appearing to filter — a filter that
 * silently does nothing is worse than one that errors. {@link likePattern}
 * escapes both plus the escape character itself, and every caller must pair it
 * with `ESCAPE '\'` ({@link LIKE_ESCAPE_CLAUSE}).
 *
 * This module is deliberately dependency-free (the `graph-keys.ts` shape) so
 * that the pure `db`-param readers can share it without acquiring an import
 * edge to anything that touches `db.js`.
 *
 * @module utils/substring-search
 * @author fifty.dev
 */

/**
 * How a `q`-bearing list payload reports what it actually did.
 *
 * `mode` is a one-member union on purpose: the moment a surface gains real
 * retrieval it stops using this type and returns a `RetrievalReport` instead,
 * so there is no way to widen this into a label that lies.
 */
export interface SubstringSearchReport {
  mode: 'substring';
  /** The columns the LIKE was applied to, in SQL order. */
  fields: string[];
}

/** The ESCAPE clause every caller of {@link likePattern} must append. */
export const LIKE_ESCAPE_CLAUSE = "ESCAPE '\\'";

/**
 * Build a parameterised `%…%` LIKE pattern with wildcards neutralised.
 *
 * Returns a LOWERCASED pattern; callers wrap the column in `LOWER(...)` so the
 * match is case-insensitive for non-ASCII too (SQLite's built-in `LIKE` folds
 * ASCII only).
 *
 * @param q - Raw operator input. Never interpolated into SQL — the return value
 *            is a BOUND PARAMETER.
 */
export function likePattern(q: string): string {
  const escaped = q
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  return `%${escaped.toLowerCase()}%`;
}

/**
 * The `search` block for a payload, or `null` when no `q` was supplied.
 *
 * `null` rather than an omitted key so the client can distinguish "this surface
 * supports substring filtering and none was applied" from "this surface has no
 * search at all" — the second is what an absent key would mean.
 */
export function substringReport(
  q: string | undefined,
  fields: string[],
): SubstringSearchReport | null {
  return q && q.trim() !== '' ? { mode: 'substring', fields } : null;
}
