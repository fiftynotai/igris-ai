/**
 * Migration v20 Tests — TD-265 (worker-subsystem table teardown)
 *
 * Verifies the one-time idempotent DROP migration that removes the 7
 * autonomous-execution (worker) substrate tables left behind when the `tasks`
 * + `coordination` brain components were deleted:
 *   tasks, task_deps, task_assignments, task_results,
 *   agent_capabilities, autonomous_decisions, coordination_config.
 *
 * The DROP lives in the unconditional db.ts legacy chain (NOT in the deleted
 * component's schema.ts) because the engine migration runner is forward-only
 * and per-component — once the component is gone, its migrations never run
 * again, so a DROP homed there would never execute on an existing DB
 * (memory #53: two migration registries).
 *
 * Cases:
 *   1. A populated v19 DB carrying task + coordination rows: boot succeeds, all
 *      7 tables are gone, the engine_migrations rows for tasks/coordination are
 *      removed, the autonomous-priority-adjust schedule row is removed, and
 *      schema_version advances to exactly 21.
 *   2. A fresh DB that never had the tables: the idempotent DROP TABLE IF EXISTS
 *      is a clean no-op and schema_version still reaches 21.
 *   3. Idempotency — a second migrateSchema() changes nothing and does not throw.
 *
 * Exercises the REAL migrateSchema() from db.js (no SUT mock, per L-159/#159).
 *
 * @module __tests__/db-migration-v20
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateSchema } from '../db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  );
}

/** The 7 worker-substrate tables TD-265 drops, in any order. */
const WORKER_TABLES = [
  'tasks',
  'task_deps',
  'task_assignments',
  'task_results',
  'agent_capabilities',
  'autonomous_decisions',
  'coordination_config',
] as const;

/**
 * Build the brain schema (no vec), force schema_version to exactly 19 so the
 * next migrateSchema() call fires v20. The vec-less chain stalls at v12; we top
 * the version ladder up to 19 with INSERT OR IGNORE (idempotent).
 */
function buildSchemaAtV19(db: Database.Database): void {
  migrateSchema(db);
  for (let v = 13; v <= 19; v++) {
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
  }
}

/**
 * Create the 7 worker-substrate tables and seed representative rows, simulating
 * an existing v19 DB that carried real task/coordination state before the
 * teardown. The shapes mirror the (now-deleted) tasks/coordination component
 * DDL closely enough to exercise the FK-ordered DROP (children → parent).
 */
function seedWorkerSubstrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      task_type TEXT,
      title TEXT,
      status TEXT,
      parent_id TEXT REFERENCES tasks(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE task_deps (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, depends_on)
    );
    CREATE TABLE task_assignments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent TEXT,
      assigned_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE task_results (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      result_type TEXT,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_capabilities (
      agent TEXT NOT NULL,
      capability TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (agent, capability)
    );
    CREATE TABLE autonomous_decisions (
      id TEXT PRIMARY KEY,
      decision_type TEXT,
      task_id TEXT,
      agent TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE coordination_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.prepare(`INSERT INTO tasks (id, task_type, title, status) VALUES (?, ?, ?, ?)`).run(
    't-parent', 'brief', 'Parent task', 'pending',
  );
  db.prepare(`INSERT INTO tasks (id, task_type, title, status, parent_id) VALUES (?, ?, ?, ?, ?)`).run(
    't-child', 'operational', 'Child task', 'pending', 't-parent',
  );
  db.prepare(`INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)`).run('t-child', 't-parent');
  db.prepare(`INSERT INTO task_assignments (id, task_id, agent) VALUES (?, ?, ?)`).run(
    'a-1', 't-child', 'forger',
  );
  db.prepare(`INSERT INTO task_results (id, task_id, result_type, content) VALUES (?, ?, ?, ?)`).run(
    'r-1', 't-child', 'log', 'done',
  );
  db.prepare(`INSERT INTO agent_capabilities (agent, capability) VALUES (?, ?)`).run('forger', 'code');
  db.prepare(
    `INSERT INTO autonomous_decisions (id, decision_type, task_id, agent, detail) VALUES (?, ?, ?, ?, ?)`,
  ).run('d-1', 'auto_route', 't-child', 'forger', '{}');
  db.prepare(`INSERT INTO coordination_config (key, value) VALUES (?, ?)`).run('autonomous', 'true');
}

/**
 * Create a minimal `engine_migrations` ledger with rows for the removed
 * components plus a survivor, so the v20 DELETE can be observed precisely.
 */
function seedEngineMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_migrations (
      component TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (component, version)
    )
  `);
  db.prepare(`INSERT INTO engine_migrations (component, version) VALUES (?, ?)`).run('tasks', 5);
  db.prepare(`INSERT INTO engine_migrations (component, version) VALUES (?, ?)`).run('coordination', 1);
  db.prepare(`INSERT INTO engine_migrations (component, version) VALUES (?, ?)`).run('schedules', 3);
}

/**
 * Create a minimal `schedules` table with the orphaned autonomous-routing row
 * plus a survivor row, so the v20 schedule DELETE can be observed precisely.
 */
function seedSchedules(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.prepare(`INSERT INTO schedules (id, name) VALUES (?, ?)`).run('sch-1', 'autonomous-priority-adjust');
  db.prepare(`INSERT INTO schedules (id, name) VALUES (?, ?)`).run('sch-2', 'nightly-cleanup');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migration v20 — worker-subsystem table teardown (TD-265)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  describe('populated v19 DB carrying task + coordination rows', () => {
    beforeEach(() => {
      buildSchemaAtV19(db);
      seedWorkerSubstrate(db);
      seedEngineMigrations(db);
      seedSchedules(db);
    });

    it('all 7 worker-substrate tables exist before the migration', () => {
      for (const t of WORKER_TABLES) {
        expect(tableExists(db, t), `${t} should exist pre-migration`).toBe(true);
      }
      expect(getSchemaVersion(db)).toBe(19);
    });

    it('boots clean and drops all 7 tables', () => {
      expect(() => migrateSchema(db)).not.toThrow();

      for (const t of WORKER_TABLES) {
        expect(tableExists(db, t), `${t} should be dropped post-migration`).toBe(false);
      }
    });

    it('advances schema_version to exactly 23', () => {
      migrateSchema(db);
      expect(getSchemaVersion(db)).toBe(23);
    });

    it('removes the engine_migrations rows for tasks + coordination, keeps survivors', () => {
      migrateSchema(db);

      const rows = db
        .prepare(`SELECT component FROM engine_migrations ORDER BY component`)
        .all() as { component: string }[];
      const components = rows.map((r) => r.component);

      expect(components).not.toContain('tasks');
      expect(components).not.toContain('coordination');
      expect(components).toContain('schedules');
    });

    it('deletes the orphaned autonomous-priority-adjust schedule row, keeps survivors', () => {
      migrateSchema(db);

      const names = (
        db.prepare(`SELECT name FROM schedules ORDER BY name`).all() as { name: string }[]
      ).map((r) => r.name);

      expect(names).not.toContain('autonomous-priority-adjust');
      expect(names).toContain('nightly-cleanup');
    });

    it('is idempotent — a second migrateSchema() does not throw and keeps version at 23', () => {
      migrateSchema(db);
      expect(getSchemaVersion(db)).toBe(23);

      expect(() => migrateSchema(db)).not.toThrow();
      expect(getSchemaVersion(db)).toBe(23);
      for (const t of WORKER_TABLES) {
        expect(tableExists(db, t)).toBe(false);
      }
    });
  });

  describe('fresh v19 DB that never had the worker tables (idempotent drop)', () => {
    beforeEach(() => {
      buildSchemaAtV19(db);
      // No seedWorkerSubstrate / engine_migrations / schedules — simulate a DB
      // that never ran the deleted components.
    });

    it('boots clean with no worker tables present', () => {
      for (const t of WORKER_TABLES) {
        expect(tableExists(db, t)).toBe(false);
      }
      expect(() => migrateSchema(db)).not.toThrow();
    });

    it('advances schema_version to exactly 23 with the no-op drop', () => {
      migrateSchema(db);
      expect(getSchemaVersion(db)).toBe(23);
      for (const t of WORKER_TABLES) {
        expect(tableExists(db, t)).toBe(false);
      }
    });
  });
});
