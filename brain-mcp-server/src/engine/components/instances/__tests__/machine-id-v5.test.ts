/**
 * BR-100 — instances component migration v5: the machine-identity stamp.
 *
 * What it gates:
 *   - `instances.machine_id` and `ceremony_events.machine_id` exist after v5,
 *     on a FRESH DB and on a DB that stopped at v4 (the upgrade path every
 *     operator brain takes);
 *   - the chain reads exactly 1,2,3,4,5 and a second boot is idempotent;
 *   - the frozen base CREATEs (v2's `instances`, v4's `ceremony_events`) do NOT
 *     name the column — evolution is ALTER-only (L-53), or a fresh DB's CREATE
 *     would carry it and the ADD COLUMN would abort the chain;
 *   - v5 is ALTER-only and touches nothing else (no `agent_events`, no view);
 *   - the column is NULLABLE with no default: a legacy-shaped writer (the bash
 *     hooks, an un-upgraded CLI) still inserts, and its row reads NULL —
 *     which is the "not mine unless an alias says so" posture the readers key on.
 *
 * Boot order reproduces production (`bootEngine`): the REAL legacy
 * `migrateSchema` chain, then the component chain through the REAL
 * `runMigrations`. Every DB is a temp file under `mkdtemp`; nothing here opens
 * `~/.igris/memory/knowledge.db`.
 *
 * @module engine/components/instances/__tests__/machine-id-v5.test
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
  const d = mkdtempSync(join(tmpdir(), 'br100-v5-'));
  tmpDirs.push(d);
  return join(d, 'brain.db');
}

/** Production boot order on `dbPath`: legacy chain, then the instances chain up to `upTo`. */
function bootInstances(dbPath: string, upTo = Infinity): StorageAdapter {
  const storage = createSqliteAdapter(dbPath);
  openStorages.push(storage);
  migrateSchema(storage.rawConnection);
  storage.runMigrations(
    'instances',
    createInstancesComponent().schema().filter((m) => m.version <= upTo),
  );
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

describe('instances migration v5 — machine_id on instances + ceremony_events (BR-100)', () => {
  it('a fresh DB: both columns present, chain reads 1,2,3,4,5', () => {
    const db = bootInstances(tmpDbPath()).rawConnection;
    expect(columnsOf(db, 'instances')).toContain('machine_id');
    expect(columnsOf(db, 'ceremony_events')).toContain('machine_id');
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a DB that stopped at v4 (every operator brain before BR-100) takes v5 on the next boot', () => {
    const path = tmpDbPath();
    const v4 = bootInstances(path, 4);
    expect(appliedVersions(v4.rawConnection)).toEqual([1, 2, 3, 4]);
    expect(columnsOf(v4.rawConnection, 'instances')).not.toContain('machine_id');
    expect(columnsOf(v4.rawConnection, 'ceremony_events')).not.toContain('machine_id');
    v4.close();

    const db = bootInstances(path).rawConnection;
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
    expect(columnsOf(db, 'instances')).toContain('machine_id');
    expect(columnsOf(db, 'ceremony_events')).toContain('machine_id');
  });

  it('is idempotent: a second full boot leaves the chain at exactly 1,2,3,4,5', () => {
    const path = tmpDbPath();
    bootInstances(path).close();
    const db = bootInstances(path).rawConnection; // must not throw on a re-ALTER
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
  });

  it('the frozen base CREATEs never name the column; v5 is ALTER-only and names nothing else', () => {
    const schema = createInstancesComponent().schema();
    const v2 = schema.find((m) => m.version === 2)!;
    const v4 = schema.find((m) => m.version === 4)!;
    const v5 = schema.find((m) => m.version === 5)!;
    expect(v2.sql).not.toMatch(/machine_id/);
    expect(v4.sql).not.toMatch(/machine_id/);
    const statements = v5.sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
    expect(statements).toEqual([
      'ALTER TABLE instances ADD COLUMN machine_id TEXT',
      'ALTER TABLE ceremony_events ADD COLUMN machine_id TEXT',
    ]);
    // The declaration site carries the non-replication decision (the orchestrator's L-849 note).
    expect(v5.sql + (v5.description ?? '')).toMatch(/machine_id/);
  });

  it('the column is nullable with no default: a legacy-shaped INSERT lands with machine_id NULL', () => {
    const db = bootInstances(tmpDbPath()).rawConnection;
    db.prepare(
      "INSERT INTO instances (id, machine_hostname, project_slug, status, last_activity_at) VALUES ('i-legacy', 'MacBookAir', 'p', 'active', datetime('now'))",
    ).run();
    db.prepare(
      "INSERT INTO ceremony_events (project, ceremony, event_type, machine_hostname) VALUES ('p', 'boot', 'start', 'MacBookAir')",
    ).run();
    expect((db.prepare("SELECT machine_id FROM instances WHERE id = 'i-legacy'").get() as { machine_id: unknown }).machine_id).toBeNull();
    expect((db.prepare('SELECT machine_id FROM ceremony_events').get() as { machine_id: unknown }).machine_id).toBeNull();
  });
});
