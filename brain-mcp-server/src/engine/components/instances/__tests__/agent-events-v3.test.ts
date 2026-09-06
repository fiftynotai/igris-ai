/**
 * FR-267 — instances component migration v3: the hunt-cost record.
 *
 * What it gates:
 *   - the four columns (`model_requested`, `model_resolved`, `round`,
 *     `project`) and the `(brief_id, agent)` index exist after v3;
 *   - `round` defaults to 1;
 *   - the 0 -> NULL fold: pre-v3 rows whose `duration_ms` was 0 read back
 *     NULL, all-zero token rows read back NULL, and a real measurement is
 *     left alone;
 *   - `project` is backfilled from a present instance and stays NULL for an
 *     absent one;
 *   - the `hunt_runs` view yields `size` from `brief_status`, `minutes` and
 *     `started_at` from `duration_ms`, and stop/error rows only;
 *   - idempotency: a second boot leaves `engine_migrations` at exactly 1,2,3,4
 *     (v4 = FR-268's ceremony record; the v3 assertions are unchanged);
 *   - the §2.1 rule (L-53): BOTH base creators — legacy `db.ts` v9 and the
 *     component's v1 — stay a strict subset of the post-v3 column set, and
 *     v3 itself never CREATEs the table (evolution is ALTER-only).
 *
 * Boot order reproduces production (`bootEngine`): the REAL legacy
 * `migrateSchema` chain on the adapter's connection, then the component chain
 * through the REAL `runMigrations` — so `engine_migrations` bookkeeping is the
 * thing under test, not a hand-rolled loop. Every DB is a temp file under
 * `mkdtemp`; nothing here opens `~/.igris/memory/knowledge.db`.
 *
 * @module engine/components/instances/__tests__/agent-events-v3.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createSqliteAdapter } from '../../../storage/sqlite.js';
import { migrateSchema } from '../../../../db.js';
import { createInstancesComponent } from '../index.js';
import type { StorageAdapter } from '../../../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DB_TS_PATH = resolve(import.meta.dirname, '../../../../db.ts');
const V3_COLUMNS = ['model_requested', 'model_resolved', 'round', 'project'];

const tmpDirs: string[] = [];
const openStorages: StorageAdapter[] = [];

afterEach(() => {
  while (openStorages.length) {
    try { openStorages.pop()?.close(); } catch { /* already closed */ }
  }
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function tmpDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'fr267-v3-'));
  tmpDirs.push(d);
  return join(d, 'brain.db');
}

/**
 * Production boot order on `dbPath`: legacy chain, then the instances
 * component chain through the real runner. `upTo` limits the component
 * versions applied (to seed an archaeology-shaped DB before v3 runs).
 */
function bootInstances(dbPath: string, upTo = Number.MAX_SAFE_INTEGER): StorageAdapter {
  const storage = createSqliteAdapter(dbPath);
  openStorages.push(storage);
  migrateSchema(storage.rawConnection);
  const migrations = createInstancesComponent().schema().filter((m) => m.version <= upTo);
  storage.runMigrations('instances', migrations);
  return storage;
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

function appliedVersions(db: Database.Database): number[] {
  return (db.prepare(
    "SELECT version FROM engine_migrations WHERE component = 'instances' ORDER BY version",
  ).all() as { version: number }[]).map((r) => r.version);
}

function seedInstance(db: Database.Database, id: string, project: string): void {
  db.prepare('INSERT INTO instances (id, machine_hostname, project_slug) VALUES (?, ?, ?)')
    .run(id, 'host', project);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('instances migration v3 — agent_events hunt-cost record (FR-267)', () => {
  it('adds the four columns and the (brief_id, agent) index', () => {
    const storage = bootInstances(tmpDbPath());
    const db = storage.rawConnection;

    expect(columnsOf(db, 'agent_events')).toEqual(expect.arrayContaining(V3_COLUMNS));

    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_events'",
    ).all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain('idx_agent_events_brief');
    // FR-268 (2026-08-27): the chain now ends at v4 (ceremony_events), 1,2,3 -> 1,2,3,4.
    // BR-100 (2026-09-06): instances 4→5 — `machine_id` on instances + ceremony_events.
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
  });

  it('round defaults to 1 for a row that does not set it', () => {
    const db = bootInstances(tmpDbPath()).rawConnection;
    db.prepare(
      "INSERT INTO agent_events (instance_id, agent, event_type) VALUES ('i', 'forger', 'start')",
    ).run();
    const row = db.prepare('SELECT round FROM agent_events').get() as { round: number };
    expect(row.round).toBe(1);
  });

  it('folds pre-v3 zeros to NULL and leaves real measurements alone', () => {
    const path = tmpDbPath();

    // Seed at the v2 (v9-shaped) schema — the archaeology the live brain holds.
    const before = bootInstances(path, 2);
    expect(columnsOf(before.rawConnection, 'agent_events')).not.toContain('round');
    const seed = before.rawConnection.prepare(`
      INSERT INTO agent_events
        (instance_id, agent, event_type, brief_id, duration_ms, input_tokens, output_tokens, cache_read, cache_create)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    seed.run('i', 'all-zero', 'stop', 'FR-1', 0, 0, 0, 0, 0);
    seed.run('i', 'real-duration', 'stop', 'FR-1', 1834000, 0, 0, 0, 0);
    seed.run('i', 'real-tokens', 'stop', 'FR-1', 0, 12, 0, 0, 0);
    seed.run('i', 'already-null', 'stop', 'FR-1', null, null, null, null, null);
    before.close();

    // Second boot applies v3 over the seeded rows.
    const db = bootInstances(path).rawConnection;
    const byAgent = (agent: string) =>
      db.prepare(
        'SELECT duration_ms, input_tokens, output_tokens, cache_read, cache_create FROM agent_events WHERE agent = ?',
      ).get(agent) as Record<string, number | null>;

    expect(byAgent('all-zero')).toEqual({
      duration_ms: null, input_tokens: null, output_tokens: null, cache_read: null, cache_create: null,
    });
    expect(byAgent('real-duration')).toEqual({
      duration_ms: 1834000, input_tokens: null, output_tokens: null, cache_read: null, cache_create: null,
    });
    // Not all four tokens were 0, so the token quartet is a measurement and stays.
    expect(byAgent('real-tokens')).toEqual({
      duration_ms: null, input_tokens: 12, output_tokens: 0, cache_read: 0, cache_create: 0,
    });
    expect(byAgent('already-null')).toEqual({
      duration_ms: null, input_tokens: null, output_tokens: null, cache_read: null, cache_create: null,
    });
  });

  it('backfills project from a present instance and leaves it NULL for an absent one', () => {
    const path = tmpDbPath();
    const before = bootInstances(path, 2);
    seedInstance(before.rawConnection, 'inst-present', 'igris-ai');
    before.rawConnection.prepare(
      "INSERT INTO agent_events (instance_id, agent, event_type) VALUES ('inst-present', 'forger', 'start')",
    ).run();
    before.rawConnection.prepare(
      "INSERT INTO agent_events (instance_id, agent, event_type) VALUES ('inst-gone', 'forger', 'start')",
    ).run();
    before.close();

    const db = bootInstances(path).rawConnection;
    const rows = db.prepare('SELECT instance_id, project FROM agent_events ORDER BY id').all() as
      { instance_id: string; project: string | null }[];
    expect(rows).toEqual([
      { instance_id: 'inst-present', project: 'igris-ai' },
      { instance_id: 'inst-gone', project: null },
    ]);
  });

  it('hunt_runs yields size from brief_status, minutes/started_at from duration_ms, stop/error rows only', () => {
    const db = bootInstances(tmpDbPath()).rawConnection;
    // brief_status has an FK to projects(slug); the adapter enforces foreign keys.
    db.prepare("INSERT INTO projects (slug, name, path) VALUES ('igris-ai', 'Igris', '/tmp/igris')").run();
    db.prepare(
      "INSERT INTO brief_status (project, brief_id, title, status, effort) VALUES ('igris-ai', 'FR-267', 'record', 'In Progress', 'L')",
    ).run();
    seedInstance(db, 'inst-1', 'igris-ai');

    const insert = db.prepare(`
      INSERT INTO agent_events
        (instance_id, agent, event_type, phase, brief_id, duration_ms, model_requested, round, project, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('inst-1', 'forger', 'start', 'BUILDING', 'FR-267', null, 'claude-fable-5', 1, 'igris-ai', '2026-08-26 17:00:00');
    insert.run('inst-1', 'forger', 'stop', 'BUILDING', 'FR-267', 90000, 'claude-fable-5', 1, 'igris-ai', '2026-08-26 17:01:30');
    insert.run('inst-1', 'sentinel', 'error', 'TESTING', 'FR-267', null, 'inherit:claude-fable-5', 1, 'igris-ai', '2026-08-26 17:05:00');

    const rows = db.prepare('SELECT * FROM hunt_runs ORDER BY event_id').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2); // the start row is not a run
    expect(rows[0]).toMatchObject({
      project: 'igris-ai',
      brief_id: 'FR-267',
      size: 'L',
      agent: 'forger',
      round: 1,
      phase: 'BUILDING',
      model_requested: 'claude-fable-5',
      ended_with: 'stop',
      duration_ms: 90000,
      minutes: 1.5,
      started_at: '2026-08-26 17:00:00',
      ended_at: '2026-08-26 17:01:30',
      instance_id: 'inst-1',
    });
    expect(rows[1]).toMatchObject({
      agent: 'sentinel',
      ended_with: 'error',
      duration_ms: null,
      minutes: null,
      started_at: null,
      size: 'L',
    });
  });

  it('is idempotent: a second boot leaves engine_migrations for instances at exactly 1,2,3,4', () => {
    const path = tmpDbPath();
    bootInstances(path).close();

    const db = bootInstances(path).rawConnection; // must not throw `duplicate column`
    // FR-268 (2026-08-27): v4 (ceremony_events) joined the chain, 1,2,3 -> 1,2,3,4.
    // BR-100 (2026-09-06): instances 4→5 — `machine_id` on instances + ceremony_events.
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
    expect(columnsOf(db, 'agent_events')).toEqual(expect.arrayContaining(V3_COLUMNS));
    const view = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'hunt_runs'").get();
    expect(view).toBeDefined();
  });

  describe('§2.1 rule — base CREATEs stay frozen at the v9 shape (L-53)', () => {
    /** Columns a CREATE statement yields on a bare DB. */
    function columnsFromDdl(sql: string): string[] {
      const scratch = new Database(':memory:');
      try {
        scratch.exec(sql);
        return columnsOf(scratch, 'agent_events');
      } finally {
        scratch.close();
      }
    }

    it('legacy db.ts v9 CREATE and component v1 CREATE agree, and both are a strict subset of post-v3', () => {
      const dbTsSource = readFileSync(DB_TS_PATH, 'utf8');
      const legacyCreate = dbTsSource.match(/CREATE TABLE IF NOT EXISTS agent_events \([\s\S]*?\);/);
      expect(legacyCreate, 'db.ts must still carry the v9 CREATE TABLE agent_events').not.toBeNull();
      const legacyCols = columnsFromDdl(legacyCreate![0]);

      const componentV1 = createInstancesComponent().schema()[0];
      expect(componentV1.version).toBe(1);
      const v1Cols = columnsFromDdl(componentV1.sql);

      const postV3Cols = columnsOf(bootInstances(tmpDbPath()).rawConnection, 'agent_events');

      // The two registries create the same base shape (L-53: a column added to
      // only one leaves "no such column" on the other path).
      expect(v1Cols).toEqual(legacyCols);
      // Strict subset: every base column survives, and the ONLY additions are v3's.
      for (const col of legacyCols) expect(postV3Cols).toContain(col);
      const added = postV3Cols.filter((c) => !legacyCols.includes(c)).sort();
      expect(added).toEqual([...V3_COLUMNS].sort());
      // Negative half of "frozen": neither base creator carries a v3 column.
      for (const col of V3_COLUMNS) {
        expect(legacyCols).not.toContain(col);
        expect(v1Cols).not.toContain(col);
      }
    });

    it('v3 evolves by ALTER only — it never CREATEs agent_events', () => {
      const v3 = createInstancesComponent().schema().find((m) => m.version === 3);
      expect(v3).toBeDefined();
      expect(v3!.sql).not.toMatch(/CREATE\s+TABLE/i);
      expect(v3!.sql.match(/ALTER TABLE agent_events ADD COLUMN/g)).toHaveLength(4);
      expect(v3!.sql).toMatch(/CREATE VIEW IF NOT EXISTS hunt_runs/);
    });
  });
});
