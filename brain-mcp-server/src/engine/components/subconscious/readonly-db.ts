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
 * @module engine/components/subconscious/readonly-db
 * @author Fifty.ai
 */

import type Database from 'better-sqlite3';
import type { ReadOnlyDb } from './types.js';

/**
 * Wrap a `Database` so detectors can only read.
 *
 * The check trims leading whitespace and lowercases for case-insensitive
 * matching, then asserts the statement starts with `select` or `with`
 * (the latter for CTE queries that ultimately SELECT). Anything else —
 * INSERT, UPDATE, DELETE, CREATE, DROP, PRAGMA writes, ATTACH — throws.
 *
 * Statements are still prepared against the underlying connection, so
 * SQLite's syntax validation runs as usual on legitimate SELECTs.
 */
export function makeReadOnlyDb(db: Database.Database): ReadOnlyDb {
  return {
    prepare(sql: string) {
      const trimmed = sql.trim().toLowerCase();
      if (!trimmed.startsWith('select') && !trimmed.startsWith('with')) {
        const preview = sql.length > 80 ? `${sql.substring(0, 80)}...` : sql;
        throw new Error(`ReadOnlyDb: non-SELECT/WITH SQL rejected: ${preview}`);
      }
      const stmt = db.prepare(sql);
      return {
        all: (...params: unknown[]) => stmt.all(...(params as unknown[])) as unknown[],
        get: (...params: unknown[]) => stmt.get(...(params as unknown[])) as unknown,
      };
    },
  };
}
