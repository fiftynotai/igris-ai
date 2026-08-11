/**
 * Brain Engine v7.0 — SQLite Storage Adapter
 *
 * Wraps better-sqlite3 to implement the StorageAdapter interface.
 * Sets pragmas (WAL, busy_timeout, foreign_keys, trusted_schema=OFF).
 * Provides a migration runner that tracks per-component schema versions
 * in the engine_migrations table.
 *
 * @module engine/storage/sqlite
 * @author fifty.dev
 */

import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import type { StorageAdapter, Migration } from '../types.js';

/**
 * CommonJS require shim for ESM modules.
 *
 * `brain-mcp-server` is ESM (`"type": "module"`), but `sqlite-vec` ships
 * both CJS (`./index.cjs`) and ESM (`./index.mjs`) entries. We use
 * `createRequire` here instead of dynamic `import()` because
 * `createSqliteAdapter` is a synchronous factory called at engine boot
 * (engine/index.ts -> bootEngine), before `migrateSchema` and
 * `setAdapter`. Switching to async would cascade into bootEngine and
 * every caller (mcp/server.ts, tests, scripts). createRequire keeps
 * this one line, zero callsite changes.
 */
const requireCjs = createRequire(import.meta.url);

/**
 * Decide whether sqlite-vec is required (load failure aborts startup).
 *
 * Production environments (`NODE_ENV=production`) MUST have the
 * extension or hybrid search silently degrades to FTS-only. The
 * `IGRIS_REQUIRE_VEC` env var is the explicit override:
 *   - `1` forces required mode (loud-fail) anywhere
 *   - `0` forces optional mode (soft-fail) anywhere
 *   - unset: required iff NODE_ENV=production
 */
function isVecRequired(): boolean {
  const flag = process.env.IGRIS_REQUIRE_VEC;
  if (flag === '1') return true;
  if (flag === '0') return false;
  return process.env.NODE_ENV === 'production';
}

/** Minimal shape of the sqlite-vec module surface we use. */
interface SqliteVecModule {
  load(db: Database.Database): void;
}

/**
 * Load the sqlite-vec extension into the given connection.
 *
 * Three modes (selected at runtime via env vars):
 *   1. **Default soft-fail** (dev/test): logs and continues without
 *      vector search if the extension is unavailable.
 *   2. **Required loud-fail** (prod, or `IGRIS_REQUIRE_VEC=1`): throws
 *      so startup aborts loudly rather than silently disabling search.
 *   3. **Disabled** (`IGRIS_DISABLE_VEC=1`): skips the load entirely.
 *      This is the kill-switch — set on the VPS to keep the brain
 *      running on FTS-only without redeploying when the native binary
 *      is broken or missing.
 *
 * After `sqliteVec.load(db)` succeeds, runs `SELECT vec_version()` as a
 * smoke check. The JS shim can resolve fine while the platform-specific
 * `.so`/`.dylib` is missing or ABI-mismatched — only an actual function
 * call against the loaded extension proves it works.
 */
function loadVecExtension(db: Database.Database): void {
  if (process.env.IGRIS_DISABLE_VEC === '1') {
    console.error('[engine] sqlite-vec disabled via IGRIS_DISABLE_VEC=1');
    return;
  }

  const required = isVecRequired();

  try {
    const sqliteVec = requireCjs('sqlite-vec') as SqliteVecModule;
    sqliteVec.load(db);
    // Smoke check — proves the native binary is actually loaded, not
    // just the JS shim. Without this, a missing .so/.dylib slips
    // through silently and only surfaces when a vec0 query runs.
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string };
    console.error(`[engine] sqlite-vec loaded successfully (vec_version=${row.v})`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const baseMsg = `[engine] sqlite-vec extension not available — vector search disabled: ${detail}`;
    if (required) {
      throw new Error(
        `${baseMsg}\n\nStartup aborted. Set IGRIS_DISABLE_VEC=1 to bypass and run with FTS-only.`,
      );
    }
    console.error(baseMsg);
  }
}

/**
 * Create a SQLite storage adapter for the given database path.
 *
 * Opens the database, sets pragmas, and creates the engine_migrations
 * tracking table if it does not exist.
 *
 * @param dbPath - Absolute path to the SQLite database file
 * @returns A StorageAdapter backed by better-sqlite3
 */
export function createSqliteAdapter(dbPath: string): StorageAdapter {
  const db = new Database(dbPath);

  // Set pragmas matching the existing db.ts behavior
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = OFF');

  // Load sqlite-vec extension. See loadVecExtension JSDoc for the
  // three modes (soft-fail dev, loud-fail prod, kill-switch override).
  loadVecExtension(db);

  // Create engine migration tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_migrations (
      component TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (component, version)
    )
  `);

  function runMigrations(componentName: string, migrations: Migration[]): void {
    if (migrations.length === 0) return;

    // Get current version for this component
    let currentVersion = 0;
    try {
      const row = db.prepare(
        'SELECT MAX(version) as version FROM engine_migrations WHERE component = ?'
      ).get(componentName) as { version: number | null } | undefined;
      if (row?.version) {
        currentVersion = row.version;
      }
    } catch {
      // Table may not exist yet on very first run
    }

    // Sort migrations by version and apply pending ones
    const sorted = [...migrations].sort((a, b) => a.version - b.version);

    for (const migration of sorted) {
      if (migration.version <= currentVersion) continue;

      // MIGRATE WITH `trusted_schema = ON`, THEN HARDEN AGAIN (BR-089).
      //
      // The SECOND door with this problem, and the reason it needs its own fix
      // rather than inheriting `db.ts`'s: this adapter opens its OWN connection
      // (`new Database(dbPath)` above) and sets its own pragmas. A pragma is a
      // property of a CONNECTION, not of a database file, so hardening one door
      // does nothing for the other.
      //
      // `trusted_schema = OFF` is right at runtime — it stops a virtual table
      // being reached from inside a trigger or view. But migration SQL is
      // arbitrary DDL, and any `ALTER TABLE ... RENAME` in it makes SQLite
      // re-parse every trigger in the schema, including the `vec0` cleanup
      // triggers. Under `OFF` that re-parse is refused with
      // `unsafe use of virtual table "learnings_vec"`, which surfaces here as
      // `brain write engine boot failed` — 64 cli assertions at once, none of
      // them naming a pragma.
      //
      // Latent under better-sqlite3 v11, live at v12 (BR-089). Scoped in TIME,
      // and the `finally` means a migration that throws still leaves the
      // connection hardened rather than trusting.
      db.pragma('trusted_schema = ON');
      try {
        db.transaction(() => {
          db.exec(migration.sql);
          db.prepare(
            'INSERT INTO engine_migrations (component, version) VALUES (?, ?)'
          ).run(componentName, migration.version);
        })();
      } finally {
        db.pragma('trusted_schema = OFF');
      }

      console.error(
        `[engine] Migration ${componentName}@${migration.version}: ${migration.description}`
      );
    }
  }

  const adapter: StorageAdapter = {
    get rawConnection(): Database.Database {
      return db;
    },

    exec(sql: string): void {
      db.exec(sql);
    },

    prepare(sql: string): Database.Statement {
      return db.prepare(sql);
    },

    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
      return db.transaction(fn) as (...args: unknown[]) => T;
    },

    pragma(directive: string): unknown {
      return db.pragma(directive);
    },

    runMigrations,

    close(): void {
      db.close();
    },
  };

  return adapter;
}
