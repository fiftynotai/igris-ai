/**
 * Brain Engine v5.0 — SQLite Storage Adapter
 *
 * Wraps better-sqlite3 to implement the StorageAdapter interface.
 * Sets pragmas (WAL, busy_timeout, foreign_keys, trusted_schema=OFF).
 * Provides a migration runner that tracks per-component schema versions
 * in the engine_migrations table.
 *
 * @module engine/storage/sqlite
 * @author Fifty.ai
 */

import Database from 'better-sqlite3';
import type { StorageAdapter, Migration } from '../types.js';

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

  // Load sqlite-vec extension (graceful degradation if unavailable)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);
    console.error('[engine] sqlite-vec extension loaded successfully');
  } catch (err) {
    console.error('[engine] sqlite-vec extension not available — vector search disabled:', err);
  }

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

      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(
          'INSERT INTO engine_migrations (component, version) VALUES (?, ?)'
        ).run(componentName, migration.version);
      })();

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
