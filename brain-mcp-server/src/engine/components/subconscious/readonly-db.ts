/**
 * Brain Engine v5.0 — Subconscious Component ReadOnlyDb Wrapper
 *
 * Thin wrapper around `better-sqlite3` that rejects any non-SELECT/WITH
 * SQL at `prepare()` time. Detectors receive a `ReadOnlyDb`, not a raw
 * `Database`, so accidental writes are caught at the call site rather
 * than at integration-test time.
 *
 * Defense in depth: the integrity test in `__tests__/integrity.test.ts`
 * additionally asserts `PRAGMA data_version` is unchanged after a full
 * `runAllDetectors` invocation. The wrapper is the first line; the
 * data_version assertion is the safety net.
 *
 * Two layered guards (TD-053):
 *   1. Leading SQL comments are stripped before whitelist evaluation so
 *      that `/* note *\/ SELECT 1` is not mistakenly rejected.
 *   2. CTE-then-DML statements (e.g. `WITH cte AS (...) DELETE FROM x`)
 *      are rejected even though they start with `WITH`. Modern SQLite
 *      lets a `WITH` clause precede `INSERT`/`UPDATE`/`DELETE`, so a
 *      naive `startsWith('with')` whitelist is insufficient.
 *
 * @module engine/components/subconscious/readonly-db
 * @author Fifty.ai
 */

import type Database from 'better-sqlite3';
import type { ReadOnlyDb } from './types.js';

/**
 * Matches a single leading block comment (`/* ... *\/`) or a single
 * line comment (`-- ...\n`). Applied iteratively until no more leading
 * comments remain.
 */
const COMMENT_PREFIX = /^\s*(\/\*[\s\S]*?\*\/|--[^\n]*\n)\s*/;

/**
 * Word-boundary scan for DML keywords inside a CTE body. Word boundaries
 * are essential — a CTE named `is_deleted` should NOT trigger this
 * check, only the literal keywords `INSERT`, `UPDATE`, or `DELETE`.
 */
const CTE_DML_REGEX = /\b(insert|update|delete)\b/i;

/**
 * Wrap a `Database` so detectors can only read.
 *
 * The check trims leading whitespace, strips any leading SQL comments,
 * then asserts the statement starts with `select` or `with` (the latter
 * for CTE queries that ultimately SELECT). Statements starting with
 * `with` are additionally scanned for `INSERT`/`UPDATE`/`DELETE`
 * keywords so that `WITH ... DELETE FROM ...` forms are rejected.
 *
 * Anything else — INSERT, UPDATE, DELETE, CREATE, DROP, PRAGMA writes,
 * ATTACH — throws.
 *
 * Statements are still prepared against the underlying connection, so
 * SQLite's syntax validation runs as usual on legitimate SELECTs.
 */
export function makeReadOnlyDb(db: Database.Database): ReadOnlyDb {
  return {
    prepare(sql: string) {
      // Strip leading block + line comments iteratively, then lowercase
      // for case-insensitive whitelist matching. We work on the
      // lowercased copy throughout; the original `sql` is only used for
      // the error preview and for the underlying `db.prepare()` call.
      const lowered = sql.toLowerCase();
      let stripped = lowered.trimStart();
      while (COMMENT_PREFIX.test(stripped)) {
        stripped = stripped.replace(COMMENT_PREFIX, '');
      }

      const startsWithSelect = stripped.startsWith('select');
      const startsWithWith = stripped.startsWith('with');

      if (!startsWithSelect && !startsWithWith) {
        const preview = sql.length > 80 ? `${sql.substring(0, 80)}...` : sql;
        throw new Error(`ReadOnlyDb: non-SELECT/WITH SQL rejected: ${preview}`);
      }

      // CTE-then-DML guard: a `WITH` clause may legitimately wrap a
      // SELECT, but modern SQLite also accepts `WITH cte AS (...)
      // DELETE FROM foo`. Scan the rest of the statement for DML
      // keywords as whole words so that identifiers like `is_deleted`
      // are not misclassified.
      if (startsWithWith && CTE_DML_REGEX.test(stripped)) {
        const preview = sql.length > 80 ? `${sql.substring(0, 80)}...` : sql;
        throw new Error(`ReadOnlyDb: CTE-then-DML SQL rejected: ${preview}`);
      }

      const stmt = db.prepare(sql);
      return {
        all: (...params: unknown[]) => stmt.all(...(params as unknown[])) as unknown[],
        get: (...params: unknown[]) => stmt.get(...(params as unknown[])) as unknown,
      };
    },
  };
}
