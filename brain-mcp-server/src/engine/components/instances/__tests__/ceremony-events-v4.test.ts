/**
 * FR-268 — instances component migration v4: the ceremony record.
 *
 * What it gates:
 *   - `ceremony_events`, its `(project, ceremony, event_type, created_at)`
 *     index and the `ceremony_runs` view exist after v4;
 *   - the `event_type` CHECK admits start/stop only (a `retry` is refused —
 *     a ceremony has no retry semantics);
 *   - the pairing + duration contract the CLI writer implements
 *     (`cli/src/lib/brain-db.ts#ceremonyEventWrite`, a mirror of
 *     `tools/agent_events.ts` `findOpenStart` / `DURATION_FROM_START_SQL`):
 *     a stop pairs with the latest open start of `(project, ceremony,
 *     machine_hostname)` and its `duration_ms` is computed IN SQL from the
 *     brain's own clock — read back from the ROW, never from a return value;
 *   - a second stop after a stop pairs with nothing (duration NULL, never 0);
 *   - `ceremony_runs` yields `minutes` / `started_at` from `duration_ms` and
 *     stop rows only;
 *   - idempotency: a second boot leaves `engine_migrations` at exactly 1,2,3,4;
 *   - v4 never touches `agent_events` (its column set is the post-v3 set).
 *
 * Boot order reproduces production (`bootEngine`): the REAL legacy
 * `migrateSchema` chain, then the component chain through the REAL
 * `runMigrations`. Every DB is a temp file under `mkdtemp`; nothing here opens
 * `~/.igris/memory/knowledge.db`.
 *
 * @module engine/components/instances/__tests__/ceremony-events-v4.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteAdapter } from '../../../storage/sqlite.js';
import { migrateSchema } from '../../../../db.js';
import { createInstancesComponent } from '../index.js';
import type { StorageAdapter } from '../../../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  const d = mkdtempSync(join(tmpdir(), 'fr268-v4-'));
  tmpDirs.push(d);
  return join(d, 'brain.db');
}

/** Production boot order on `dbPath`: legacy chain, then the instances chain. */
function bootInstances(dbPath: string): StorageAdapter {
  const storage = createSqliteAdapter(dbPath);
  openStorages.push(storage);
  migrateSchema(storage.rawConnection);
  storage.runMigrations('instances', createInstancesComponent().schema());
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

/**
 * The pairing predicate — the CLI writer's `findOpenCeremonyStart`
 * (`cli/src/lib/brain-db.ts`), itself a mirror of `tools/agent_events.ts`
 * `findOpenStart`: the latest start of the key that no later stop has closed.
 */
function findOpenStart(
  db: Database.Database,
  project: string,
  ceremony: string,
  host: string,
): { id: number; created_at: string } | undefined {
  return db.prepare(`
    SELECT s.id, s.created_at FROM ceremony_events s
     WHERE s.event_type = 'start' AND s.project = ? AND s.ceremony = ? AND s.machine_hostname = ?
       AND NOT EXISTS (SELECT 1 FROM ceremony_events e
                        WHERE e.event_type = 'stop' AND e.project = s.project AND e.ceremony = s.ceremony
                          AND e.machine_hostname = s.machine_hostname AND e.id > s.id)
     ORDER BY s.id DESC LIMIT 1
  `).get(project, ceremony, host) as { id: number; created_at: string } | undefined;
}

/** Mirror of `tools/agent_events.ts` `DURATION_FROM_START_SQL`, over ceremony_events. */
const DURATION_FROM_START_SQL =
  "CAST((julianday('now') - julianday((SELECT created_at FROM ceremony_events WHERE id = ?))) * 86400000 AS INTEGER)";

/** Write a stop the way the CLI writer does: paired → SQL duration, unpaired → NULL. */
function writeStop(db: Database.Database, project: string, ceremony: string, host: string): number {
  const open = findOpenStart(db, project, ceremony, host);
  const info = open
    ? db.prepare(
        `INSERT INTO ceremony_events (project, ceremony, event_type, machine_hostname, duration_ms)
         VALUES (?, ?, 'stop', ?, ${DURATION_FROM_START_SQL})`,
      ).run(project, ceremony, host, open.id)
    : db.prepare(
        `INSERT INTO ceremony_events (project, ceremony, event_type, machine_hostname, duration_ms)
         VALUES (?, ?, 'stop', ?, NULL)`,
      ).run(project, ceremony, host);
  return Number(info.lastInsertRowid);
}

function seedStart(db: Database.Database, project: string, ceremony: string, host: string, createdAtSql: string): number {
  const info = db.prepare(
    `INSERT INTO ceremony_events (project, ceremony, event_type, machine_hostname, created_at)
     VALUES (?, ?, 'start', ?, ${createdAtSql})`,
  ).run(project, ceremony, host);
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('instances migration v4 — ceremony_events record (FR-268)', () => {
  it('creates the table, its key index and the ceremony_runs view; instances at 1,2,3,4', () => {
    const db = bootInstances(tmpDbPath()).rawConnection;

    expect(columnsOf(db, 'ceremony_events')).toEqual([
      'id', 'project', 'ceremony', 'event_type', 'machine_hostname', 'instance_id',
      'brief_id', 'duration_ms', 'metadata', 'created_at',
      'machine_id', // BR-100 (2026-09-06): instances v5 ALTER, appended after the frozen v4 shape
    ]);
    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ceremony_events'",
    ).all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain('idx_ceremony_events_key');
    const view = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'ceremony_runs'").get();
    expect(view).toBeDefined();
    // BR-100 (2026-09-06): instances 4→5 — `machine_id` on instances + ceremony_events.
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
  });

  it('the event_type CHECK admits start and stop only — a retry row is refused', () => {
    const db = bootInstances(tmpDbPath()).rawConnection;
    expect(() =>
      db.prepare("INSERT INTO ceremony_events (project, ceremony, event_type, machine_hostname) VALUES ('p', 'boot', 'retry', 'h')").run(),
    ).toThrow(/CHECK constraint failed/);
    const count = db.prepare('SELECT COUNT(*) AS c FROM ceremony_events').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('created_at defaults to the DB clock and duration_ms / instance_id / brief_id default to NULL, metadata to {}', () => {
    const db = bootInstances(tmpDbPath()).rawConnection;
    seedStart(db, 'igris-ai', 'boot', 'host-a', "datetime('now')");
    const row = db.prepare(
      'SELECT duration_ms, instance_id, brief_id, metadata, created_at FROM ceremony_events',
    ).get() as Record<string, unknown>;
    expect(row.duration_ms).toBeNull();
    expect(row.instance_id).toBeNull();
    expect(row.brief_id).toBeNull();
    expect(row.metadata).toBe('{}');
    const now = (db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t;
    const skew = Math.abs(Date.parse(`${row.created_at as string}Z`) - Date.parse(`${now}Z`));
    expect(skew).toBeLessThanOrEqual(2_000);
  });

  it('a stop pairs with the open start and its duration_ms is SQL-computed from the brain clock (read from the row)', () => {
    const db = bootInstances(tmpDbPath()).rawConnection;
    const startId = seedStart(db, 'igris-ai', 'boot', 'host-a', "datetime('now', '-90 seconds')");
    const stopId = writeStop(db, 'igris-ai', 'boot', 'host-a');

    const row = db.prepare('SELECT duration_ms FROM ceremony_events WHERE id = ?').get(stopId) as { duration_ms: number | null };
    expect(row.duration_ms).not.toBeNull();
    expect(row.duration_ms as number).toBeGreaterThanOrEqual(88_000);
    expect(row.duration_ms as number).toBeLessThanOrEqual(92_000);
    // The start is now closed: no open start remains for the key.
    expect(findOpenStart(db, 'igris-ai', 'boot', 'host-a')).toBeUndefined();
    expect(stopId).toBeGreaterThan(startId);
  });

  it('a second stop after a stop pairs with nothing — duration_ms NULL, never 0', () => {
    const db = bootInstances(tmpDbPath()).rawConnection;
    seedStart(db, 'igris-ai', 'boot', 'host-a', "datetime('now', '-90 seconds')");
    writeStop(db, 'igris-ai', 'boot', 'host-a');
    const secondStop = writeStop(db, 'igris-ai', 'boot', 'host-a');

    const row = db.prepare('SELECT duration_ms FROM ceremony_events WHERE id = ?').get(secondStop) as { duration_ms: number | null };
    expect(row.duration_ms).toBeNull();
  });

  it('pairing is keyed by (project, ceremony, machine_hostname): another host or project never closes this start', () => {
    const db = bootInstances(tmpDbPath()).rawConnection;
    seedStart(db, 'igris-ai', 'boot', 'host-a', "datetime('now', '-90 seconds')");
    seedStart(db, 'igris-ai', 'boot', 'host-b', "datetime('now', '-30 seconds')");
    seedStart(db, 'moca', 'boot', 'host-a', "datetime('now', '-10 seconds')");

    const stopB = writeStop(db, 'igris-ai', 'boot', 'host-b');
    const rowB = db.prepare('SELECT duration_ms FROM ceremony_events WHERE id = ?').get(stopB) as { duration_ms: number | null };
    expect(rowB.duration_ms as number).toBeGreaterThanOrEqual(28_000);
    expect(rowB.duration_ms as number).toBeLessThanOrEqual(32_000);

    // host-a / igris-ai and host-a / moca are still open.
    expect(findOpenStart(db, 'igris-ai', 'boot', 'host-a')?.id).toBe(1);
    expect(findOpenStart(db, 'moca', 'boot', 'host-a')?.id).toBe(3);
    expect(findOpenStart(db, 'igris-ai', 'boot', 'host-b')).toBeUndefined();
  });

  it('ceremony_runs yields minutes and started_at from duration_ms, stop rows only, NULLs on an unpaired stop', () => {
    const db = bootInstances(tmpDbPath()).rawConnection;
    const insert = db.prepare(`
      INSERT INTO ceremony_events (project, ceremony, event_type, machine_hostname, instance_id, brief_id, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('igris-ai', 'boot', 'start', 'host-a', null, null, null, '2026-08-27 07:00:00');
    insert.run('igris-ai', 'boot', 'stop', 'host-a', 'inst-1', null, 90_000, '2026-08-27 07:01:30');
    insert.run('igris-ai', 'rest', 'stop', 'host-a', 'inst-1', null, null, '2026-08-27 07:05:00');

    const rows = db.prepare('SELECT * FROM ceremony_runs ORDER BY event_id').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2); // the start row is not a run
    expect(rows[0]).toEqual({
      project: 'igris-ai',
      ceremony: 'boot',
      machine_hostname: 'host-a',
      instance_id: 'inst-1',
      brief_id: null,
      duration_ms: 90_000,
      minutes: 1.5,
      started_at: '2026-08-27 07:00:00',
      ended_at: '2026-08-27 07:01:30',
      event_id: 2,
    });
    expect(rows[1]).toMatchObject({
      ceremony: 'rest',
      duration_ms: null,
      minutes: null,
      started_at: null,
      ended_at: '2026-08-27 07:05:00',
    });
  });

  it('is idempotent: a second boot leaves engine_migrations for instances at exactly 1,2,3,4,5', () => {
    const path = tmpDbPath();
    bootInstances(path).close();

    const db = bootInstances(path).rawConnection; // must not throw
    // BR-100 (2026-09-06): instances 4→5.
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
    expect(columnsOf(db, 'ceremony_events')).toContain('duration_ms');
  });

  it('v4 never touches agent_events: its column set is the post-v3 set and the v4 SQL does not name the table', () => {
    const v4 = createInstancesComponent().schema().find((m) => m.version === 4);
    expect(v4).toBeDefined();
    expect(v4!.sql).not.toMatch(/agent_events/);
    expect(v4!.sql).toMatch(/CREATE TABLE IF NOT EXISTS ceremony_events/);
    expect(v4!.sql).toMatch(/CREATE VIEW IF NOT EXISTS ceremony_runs/);
    // No CHECK on `ceremony` — the vocabulary is the CLI verb's allowlist.
    expect(v4!.sql).not.toMatch(/ceremony\s+TEXT\s+NOT\s+NULL\s+CHECK/);

    const db = bootInstances(tmpDbPath()).rawConnection;
    expect(columnsOf(db, 'agent_events')).toEqual([
      'id', 'instance_id', 'agent', 'event_type', 'phase', 'brief_id',
      'duration_ms', 'input_tokens', 'output_tokens', 'cache_read', 'cache_create',
      'result', 'error_message', 'metadata', 'created_at',
      'model_requested', 'model_resolved', 'round', 'project',
    ]);
  });
});
