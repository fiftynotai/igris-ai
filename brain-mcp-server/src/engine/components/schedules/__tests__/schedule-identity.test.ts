/**
 * TD-361 AC-4 — two brains cannot produce two `schedules` rows under one name.
 *
 * The TD-327 duplicate had two causes, and both are closed here:
 *   1. REPLICATION. `schedules` synced on `['id']` — a per-machine random
 *      `sch-XXXXXXXX` — while the bootstraps de-duplicate by NAME, so every
 *      receiving brain kept one row per machine under one name. Both tables
 *      are now out of `SYNC_TABLES` (I1). The removal is deploy-order-free in
 *      BOTH directions, which I2 and I3 pin: a NEW remote drops an OLD client's
 *      `schedules` payload (processSyncPush iterates only its own list), and a
 *      NEW client ignores `schedules` in an OLD remote's pull body.
 *   2. THE LOCAL RACE. The bootstrap's `WHERE name = ?` pre-check is not atomic
 *      with the create it guards. `schedules.name` is UNIQUE since v3, so the
 *      second of two racing creates is refused by the INDEX (I4), and the tool
 *      reports it as a named refusal, not a raw constraint error (I5).
 *
 * @module engine/components/schedules/__tests__/schedule-identity.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

import { getDb } from '../../../../db.js';
import { SYNC_TABLES, processSyncPush, handleBrainPull } from '../../../../tools/sync.js';
import { handleScheduleCreate } from '../handlers.js';
import { scheduleMigrations } from '../schema.js';

const mockedGetDb = vi.mocked(getDb);

/** A foreign brain's copy of the same-named schedule: same NAME, its own random id. */
const FOREIGN_SCHEDULE = {
  id: 'sch-f0re1gn0', name: 'subconscious_engine', description: 'from another machine',
  cron_expr: '0 */6 * * *', handler_type: 'mcp-tool',
  handler_config: '{"tool":"igris_subconscious_run","args":{}}', enabled: 1,
  project_slug: null, tags: '[]', max_retries: 0, timeout_ms: 30000,
  next_run_at: '2026-09-24T12:00:00.000Z', last_run_at: '2026-09-24T06:00:00.000Z',
  created_at: '2026-05-03T20:42:05.022Z', updated_at: '2099-01-01T00:00:00.000Z',
};
const FOREIGN_RUN = {
  id: 'run-f0re1gn0', schedule_id: 'sch-f0re1gn0', status: 'running',
  started_at: '2026-09-24T06:00:00.000Z', finished_at: null, duration_ms: null,
  result: null, error: null, attempt: 1,
};

let db: Database.Database;
let originalFetch: typeof globalThis.fetch;

function makeDb(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  for (const m of scheduleMigrations) d.exec(m.sql);
  d.exec(`
    CREATE TABLE sync_state (remote_url TEXT NOT NULL, table_name TEXT NOT NULL,
      last_push_at TEXT, last_pull_at TEXT, PRIMARY KEY (remote_url, table_name));
    CREATE TABLE sync_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL,
      row_data TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL,
      error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  d.prepare(`INSERT INTO schedules (id, name, cron_expr, handler_type) VALUES ('sch-10ca1000', 'subconscious_engine', '0 */6 * * *', 'mcp-tool')`).run();
  return d;
}

function namedRows(name: string): { id: string }[] {
  return db.prepare('SELECT id FROM schedules WHERE name = ? ORDER BY id').all(name) as { id: string }[];
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(() => {
  db = makeDb();
  mockedGetDb.mockReturnValue(db);
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  db.close();
});

describe('two brains cannot produce two schedules rows under one name (AC-4)', () => {
  it('I1: SYNC_TABLES carries neither schedules nor schedule_runs — execution state is per-DB-file', () => {
    const tables = SYNC_TABLES.map((t) => t.table);
    expect(tables).not.toContain('schedules');
    expect(tables).not.toContain('schedule_runs');
  });

  it("I2: a NEW remote drops an OLD client's schedules payload — ok, no result entry, one row by name", () => {
    const beforeSchedules = count('schedules');
    const beforeRuns = count('schedule_runs');
    const r = processSyncPush(db, { schedules: [FOREIGN_SCHEDULE], schedule_runs: [FOREIGN_RUN] });
    expect(r.ok).toBe(true);
    expect(r.results).not.toHaveProperty('schedules');
    expect(r.results).not.toHaveProperty('schedule_runs');
    expect(count('schedules')).toBe(beforeSchedules);
    expect(count('schedule_runs')).toBe(beforeRuns);
    expect(namedRows('subconscious_engine')).toEqual([{ id: 'sch-10ca1000' }]);
  });

  it("I3: a NEW client ignores schedules in an OLD remote's pull body — local rows unchanged", async () => {
    // A hand-shaped body is the right instrument HERE: the case is ABOUT an old
    // remote, which still serves both tables (test_standards, BR-097 idiom).
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ tables: { schedules: [FOREIGN_SCHEDULE], schedule_runs: [FOREIGN_RUN] } }),
      text: async () => '',
    })) as unknown as typeof globalThis.fetch;

    await handleBrainPull({ remote_url: 'https://old-remote.example', api_key: 'k' });

    expect(namedRows('subconscious_engine')).toEqual([{ id: 'sch-10ca1000' }]);
    expect(count('schedule_runs')).toBe(0);
    // The pull did not even ASK for them.
    const url = String(vi.mocked(globalThis.fetch).mock.calls[0][0]);
    expect(url).not.toContain('since_schedules');
    expect(url).not.toContain('since_schedule_runs');
  });

  it('I4: two bootstraps that BOTH passed the `WHERE name = ?` pre-check leave exactly ONE row', () => {
    // The bootstrap (janitor/subconscious/synapse `ensureScheduleExists`) reads,
    // then awaits a dispatch — two sibling processes can both read "absent".
    db.prepare("DELETE FROM schedules WHERE name = 'subconscious_engine'").run();
    const preA = db.prepare('SELECT id FROM schedules WHERE name = ?').get('synapse_engine');
    const preB = db.prepare('SELECT id FROM schedules WHERE name = ?').get('synapse_engine');
    expect(preA).toBeUndefined();
    expect(preB).toBeUndefined();

    const args = { name: 'synapse_engine', cron_expr: '0 3 * * *', handler_type: 'noop' };
    const a = handleScheduleCreate(args);
    const b = handleScheduleCreate(args);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBe(true);
    expect(namedRows('synapse_engine')).toHaveLength(1);
  });

  it('I5: igris_schedule_create with a taken name returns a named refusal carrying the existing id', () => {
    const r = handleScheduleCreate({ name: 'subconscious_engine', cron_expr: '0 */6 * * *', handler_type: 'noop' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Error: schedule named "subconscious_engine" already exists (sch-10ca1000)');
    expect(namedRows('subconscious_engine')).toHaveLength(1);
  });
});
