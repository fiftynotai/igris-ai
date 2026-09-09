/**
 * Migration v21 Tests — TD-277 (instance activity timestamp rename)
 *
 * Verifies the terminal schema rename from the retired instance timestamp
 * column to `last_activity_at`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateSchema } from '../db.js';

let db: Database.Database;

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((row) => row.name);
}

function getSchemaVersion(): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

function advanceLedgerTo20(): void {
  for (let v = 1; v <= 20; v++) {
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
  }
}

describe('migration v21 — instance activity timestamp rename (TD-277)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE instances (
        id TEXT PRIMARY KEY,
        machine_hostname TEXT NOT NULL,
        machine_os TEXT,
        project_slug TEXT,
        project_path TEXT,
        current_brief TEXT,
        current_phase TEXT,
        current_task TEXT,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'stale')),
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT DEFAULT '{}'
      );
    `);
    advanceLedgerTo20();
  });

  afterEach(() => {
    db.close();
  });

  it('renames the legacy column and preserves existing values', () => {
    db.prepare(
      "INSERT INTO instances (id, machine_hostname, last_heartbeat_at) VALUES ('inst-1', 'host-1', '2026-06-29 01:02:03')",
    ).run();

    migrateSchema(db);

    expect(columns('instances')).toContain('last_activity_at');
    expect(columns('instances')).not.toContain('last_heartbeat_at');
    // Terminal is 21, NOT 22: this fixture has no `brief_status` table, so the
    // v22 brief_type fold (TD-328) hits its precondition guard and SKIPS
    // WITHOUT RECORDING — a partial schema must not be marked as migrated. The
    // next boot retries once the table exists (v13 skip-then-heal precedent).
    expect(getSchemaVersion()).toBe(21);

    const row = db
      .prepare("SELECT last_activity_at FROM instances WHERE id = 'inst-1'")
      .get() as { last_activity_at: string };
    expect(row.last_activity_at).toBe('2026-06-29 01:02:03');
  });

  it('is idempotent once v21 is recorded', () => {
    migrateSchema(db);
    expect(getSchemaVersion()).toBe(21);

    expect(() => migrateSchema(db)).not.toThrow();
    expect(getSchemaVersion()).toBe(21);
  });
});
