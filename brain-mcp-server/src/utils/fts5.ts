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
 * Strips characters and operators that have special meaning in FTS5 syntax:
 * quotes, parentheses, colons, asterisks, plus/minus, caret, tilde, at,
 * hash, backslash, and the boolean keywords AND/OR/NOT/NEAR.
 *
 * @param input - Raw user-supplied query string
 * @returns Cleaned string safe for FTS5 MATCH, or empty string if nothing remains
 */
export function sanitizeFts5Query(input: string): string {
  const cleaned = input.replace(/['",():*+\-^~@#\\]/g, ' ');
  const withoutOperators = cleaned.replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ');
  return withoutOperators.replace(/\s+/g, ' ').trim();
}
