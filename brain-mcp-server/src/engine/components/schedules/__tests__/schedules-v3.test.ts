/**
 * TD-361 — schedules component migration v3.
 *
 * What it gates:
 *   - the four owner columns exist on `schedule_runs` after v3, on a FRESH DB
 *     and on a DB that stopped at v2 (every operator brain before TD-361);
 *   - the chain reads exactly 1,2,3 and a second boot is idempotent;
 *   - the frozen v1 CREATE never names the new columns and v3 adds them by
 *     ALTER only (L-53), and a legacy-shaped INSERT (the old bundle's 5-column
 *     form, still written by un-restarted siblings) lands with NULL owners;
 *   - the TD-327 duplicate pair (two `subconscious_engine` rows, both carrying
 *     runs) collapses to ONE row by the survivor rule, every run re-pointed;
 *   - FK orphans — made the way the real ones were, by a `foreign_keys=OFF`
 *     delete — are removed (AC-5), and `foreign_key_check` is empty after;
 *   - `schedules.name` is UNIQUE afterwards (AC-4).
 *
 * Boot order reproduces production (`bootEngine`): the REAL legacy
 * `migrateSchema`, then the component chain through the REAL `runMigrations`.
 * Every DB is a temp file under `mkdtemp`.
 *
 * @module engine/components/schedules/__tests__/schedules-v3.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteAdapter } from '../../../storage/sqlite.js';
import { migrateSchema } from '../../../../db.js';
import { scheduleMigrations } from '../schema.js';
import type { StorageAdapter } from '../../../types.js';

const OWNER_COLUMNS = ['machine_id', 'machine_hostname', 'owner_pid', 'owner_started_at'];

const tmpDirs: string[] = [];
const open: StorageAdapter[] = [];

afterEach(() => {
  while (open.length) {
    try { open.pop()?.close(); } catch { /* already closed */ }
  }
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmpDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'td361-v3-'));
  tmpDirs.push(d);
  return join(d, 'brain.db');
}

/** Production boot order: legacy chain, then the schedules chain up to `upTo`. */
function bootSchedules(path: string, upTo = Infinity): StorageAdapter {
  const storage = createSqliteAdapter(path);
  open.push(storage);
  migrateSchema(storage.rawConnection);
  storage.runMigrations('schedules', scheduleMigrations.filter((m) => m.version <= upTo));
  return storage;
}

function closeAll(): void {
  while (open.length) open.pop()!.close();
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

function versions(db: Database.Database): number[] {
  return (db.prepare(
    "SELECT version FROM engine_migrations WHERE component = 'schedules' ORDER BY version",
  ).all() as { version: number }[]).map((r) => r.version);
}

function seedSchedule(
  db: Database.Database,
  s: { id: string; name: string; enabled: number; last_run_at: string | null; created_at: string },
): void {
  db.prepare(`
    INSERT INTO schedules (id, name, cron_expr, handler_type, enabled, last_run_at, created_at, updated_at)
    VALUES (?, ?, '0 */6 * * *', 'mcp-tool', ?, ?, ?, ?)
  `).run(s.id, s.name, s.enabled, s.last_run_at, s.created_at, s.created_at);
}

function seedRuns(db: Database.Database, scheduleId: string, n: number, status = 'success'): void {
  const ins = db.prepare(
    'INSERT INTO schedule_runs (id, schedule_id, status, started_at) VALUES (?, ?, ?, ?)',
  );
  for (let i = 0; i < n; i++) ins.run(`run-${scheduleId}-${i}`, scheduleId, status, `2026-05-0${1 + (i % 9)}T00:00:0${i % 10}Z`);
}

describe('schedules migration v3 (TD-361)', () => {
  it('a fresh DB: the four owner columns exist and the chain reads 1,2,3', () => {
    const db = bootSchedules(tmpDbPath()).rawConnection;
    expect(columnsOf(db, 'schedule_runs')).toEqual(expect.arrayContaining(OWNER_COLUMNS));
    expect(versions(db)).toEqual([1, 2, 3]);
  });

  it('a DB that stopped at v2 takes v3 on the next boot; a second boot is idempotent', () => {
    const path = tmpDbPath();
    const v2 = bootSchedules(path, 2);
    expect(versions(v2.rawConnection)).toEqual([1, 2]);
    for (const c of OWNER_COLUMNS) expect(columnsOf(v2.rawConnection, 'schedule_runs')).not.toContain(c);
    closeAll();

    const v3 = bootSchedules(path).rawConnection;
    expect(versions(v3)).toEqual([1, 2, 3]);
    expect(columnsOf(v3, 'schedule_runs')).toEqual(expect.arrayContaining(OWNER_COLUMNS));
    closeAll();

    const again = bootSchedules(path).rawConnection; // must not throw on a re-ALTER
    expect(versions(again)).toEqual([1, 2, 3]);
  });

  it('the frozen v1 CREATE never names an owner column; v3 adds them by ALTER only', () => {
    const v1 = scheduleMigrations.find((m) => m.version === 1)!;
    const v3 = scheduleMigrations.find((m) => m.version === 3)!;
    for (const c of OWNER_COLUMNS) expect(v1.sql).not.toContain(c);
    for (const c of OWNER_COLUMNS) {
      expect(v3.sql).toMatch(new RegExp(`ALTER TABLE schedule_runs ADD COLUMN ${c} (TEXT|INTEGER);`));
    }
    // No CREATE TABLE in v3: evolution is ALTER-only.
    expect(v3.sql).not.toMatch(/CREATE TABLE/i);
  });

  it("a legacy-shaped INSERT (the old bundle's 5-column form) lands with NULL owner columns", () => {
    const db = bootSchedules(tmpDbPath()).rawConnection;
    seedSchedule(db, { id: 'sch-a', name: 'a', enabled: 1, last_run_at: null, created_at: '2026-01-01T00:00:00Z' });
    db.prepare(`INSERT INTO schedule_runs (id, schedule_id, status, started_at, attempt)
                VALUES ('run-legacy', 'sch-a', 'running', '2026-09-24T10:00:00Z', 1)`).run();
    const row = db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get('run-legacy') as Record<string, unknown>;
    for (const c of OWNER_COLUMNS) expect(row[c]).toBeNull();
  });

  it('dedupe (the TD-327 pair): two subconscious_engine rows collapse to the ENABLED one, all runs re-pointed', () => {
    const path = tmpDbPath();
    const db = bootSchedules(path, 2).rawConnection;
    // The measured pair, 2026-08-06: sch-b06ad450 disabled with 8 runs,
    // sch-ca730782 enabled with 665 (here 7, the shape is what matters).
    seedSchedule(db, { id: 'sch-b06ad450', name: 'subconscious_engine', enabled: 0, last_run_at: '2026-05-04T14:00:00.073Z', created_at: '2026-05-03T20:42:05.022Z' });
    seedSchedule(db, { id: 'sch-ca730782', name: 'subconscious_engine', enabled: 1, last_run_at: '2026-05-19T06:00:00.429Z', created_at: '2026-04-29T13:18:48.077Z' });
    seedSchedule(db, { id: 'sch-janitor', name: 'janitor_engine', enabled: 1, last_run_at: null, created_at: '2026-07-02T06:51:56.020Z' });
    seedRuns(db, 'sch-b06ad450', 8);
    seedRuns(db, 'sch-ca730782', 7);
    seedRuns(db, 'sch-janitor', 2);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM schedule_runs').get() as { n: number }).n;
    closeAll();

    const after = bootSchedules(path).rawConnection;
    const rows = after.prepare("SELECT id FROM schedules WHERE name = 'subconscious_engine'").all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['sch-ca730782']);
    const repointed = (after.prepare("SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = 'sch-ca730782'").get() as { n: number }).n;
    expect(repointed).toBe(15);
    expect((after.prepare('SELECT COUNT(*) AS n FROM schedule_runs').get() as { n: number }).n).toBe(before);
    // The unrelated schedule is untouched.
    expect((after.prepare("SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = 'sch-janitor'").get() as { n: number }).n).toBe(2);
  });

  it('dedupe survivor rule: enabled first, then the latest last_run_at (NULL last), then oldest created_at, then id', () => {
    const path = tmpDbPath();
    const db = bootSchedules(path, 2).rawConnection;
    // Both enabled: the one that fired most recently survives; NULL never wins over a value.
    seedSchedule(db, { id: 'sch-x1', name: 'x', enabled: 1, last_run_at: null, created_at: '2026-01-01T00:00:00Z' });
    seedSchedule(db, { id: 'sch-x2', name: 'x', enabled: 1, last_run_at: '2026-09-01T00:00:00Z', created_at: '2026-03-01T00:00:00Z' });
    seedSchedule(db, { id: 'sch-x3', name: 'x', enabled: 1, last_run_at: '2026-08-01T00:00:00Z', created_at: '2026-02-01T00:00:00Z' });
    // A full tie on everything but created_at, then on everything but id.
    seedSchedule(db, { id: 'sch-y2', name: 'y', enabled: 1, last_run_at: null, created_at: '2026-01-01T00:00:00Z' });
    seedSchedule(db, { id: 'sch-y1', name: 'y', enabled: 1, last_run_at: null, created_at: '2026-02-01T00:00:00Z' });
    seedSchedule(db, { id: 'sch-z2', name: 'z', enabled: 0, last_run_at: null, created_at: '2026-01-01T00:00:00Z' });
    seedSchedule(db, { id: 'sch-z1', name: 'z', enabled: 0, last_run_at: null, created_at: '2026-01-01T00:00:00Z' });
    closeAll();

    const after = bootSchedules(path).rawConnection;
    const survivors = after.prepare('SELECT name, id FROM schedules ORDER BY name').all();
    expect(survivors).toEqual([
      { name: 'x', id: 'sch-x2' },
      { name: 'y', id: 'sch-y2' },
      { name: 'z', id: 'sch-z1' },
    ]);
  });

  it('AC-5: FK orphans (a parent deleted with foreign_keys=OFF) are deleted and foreign_key_check is empty', () => {
    const path = tmpDbPath();
    const db = bootSchedules(path, 2).rawConnection;
    seedSchedule(db, { id: 'sch-b06ad450', name: 'subconscious_engine', enabled: 0, last_run_at: null, created_at: '2026-05-03T20:42:05.022Z' });
    seedSchedule(db, { id: 'sch-keep', name: 'keep', enabled: 1, last_run_at: null, created_at: '2026-05-03T20:42:05.022Z' });
    seedRuns(db, 'sch-b06ad450', 8);
    seedRuns(db, 'sch-keep', 3);
    closeAll();

    // The way the real orphans were made: the sqlite3 CLI (foreign_keys OFF by
    // default) deleted the parent during the TD-327 reap, so CASCADE never ran.
    const raw = new Database(path);
    raw.pragma('foreign_keys = OFF');
    raw.prepare("DELETE FROM schedules WHERE id = 'sch-b06ad450'").run();
    expect((raw.pragma('foreign_key_check(schedule_runs)') as unknown[]).length).toBe(8);
    raw.close();

    const after = bootSchedules(path).rawConnection;
    expect(after.pragma('foreign_key_check(schedule_runs)')).toEqual([]);
    expect((after.prepare('SELECT COUNT(*) AS n FROM schedule_runs').get() as { n: number }).n).toBe(3);
  });

  it('AC-4: after v3 a second row under an existing name is refused by the UNIQUE index', () => {
    const db = bootSchedules(tmpDbPath()).rawConnection;
    seedSchedule(db, { id: 'sch-one', name: 'synapse_engine', enabled: 1, last_run_at: null, created_at: '2026-07-02T06:51:56.016Z' });
    expect(() =>
      seedSchedule(db, { id: 'sch-two', name: 'synapse_engine', enabled: 1, last_run_at: null, created_at: '2026-07-02T06:51:56.016Z' }),
    ).toThrow(/UNIQUE constraint failed: schedules\.name/);
  });
});
