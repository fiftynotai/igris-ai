/**
 * Igris Brain — FTS5 Query Utilities
 *
 * Shared sanitizer for SQLite FTS5 MATCH queries.
 * Strips characters and operators that have special meaning in FTS5 syntax
 * so that user-supplied strings can be safely used in MATCH expressions.
 *
 * @module utils/fts5
 * @author fifty.dev
 */

/**
 * Sanitize a string for use in FTS5 MATCH queries.
 *
 * Uses a *whitelist* strategy (TD-290): every character that is not a Unicode
 * letter, digit, underscore, or whitespace is replaced with a space. This
 * neutralizes the ENTIRE class of FTS5-special / bareword-invalid punctuation
 * — quotes, parentheses, colon, asterisk, plus/minus, caret, tilde, at, hash,
 * backslash, and the question mark (`?`) that the previous denylist regex
 * silently let through into `MATCH '?'`, raising an FTS5 syntax error. Unlike a
 * denylist, a whitelist cannot be defeated by the NEXT unlisted special
 * character, so a pure-punctuation query always collapses to the empty string
 * and a query like `what?` degrades to the safe bareword `what`.
 *
 * The FTS5 boolean keywords (AND/OR/NOT/NEAR) survive the character filter as
 * barewords, so they are stripped in a second pass — preserving the prior
 * operator-neutralizing behavior for normal queries.
 *
 * @param input - Raw user-supplied query string
 * @returns Cleaned string safe for FTS5 MATCH, or empty string if nothing remains
 */
export function sanitizeFts5Query(input: string): string {
  const cleaned = input.replace(/[^\p{L}\p{N}_\s]/gu, ' ');
  const withoutOperators = cleaned.replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ');
  return withoutOperators.replace(/\s+/g, ' ').trim();
}
