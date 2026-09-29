/**
 * FR-274 — projects component migration v2: the knowledge watermark columns
 * `projects.knowledge_sha`, `projects.knowledge_branch`,
 * `projects.knowledge_recorded_at`.
 *
 * What it gates (plan §4.2 B1–B8):
 *   - B1 a fresh DB gets all three columns and the component chain reads [1, 2];
 *   - B2 a second boot is idempotent (still [1, 2], one of each column);
 *   - B3 the migration lives in the COMPONENT registry: a DB whose legacy
 *     `schema_version` chain is already at 26, 27, 28 still takes v2;
 *   - B4 ALTER-only (L-53): the legacy chain never creates the columns and
 *     `db.ts` never names `knowledge_`;
 *   - B5 all three columns ALREADY present: no throw, v2 is RECORDED, and a
 *     later (v3 probe) migration still applies — a declining pre-flight would
 *     pin the component at v1 forever (mutation M10);
 *   - B6 only `knowledge_sha` present (a partial crash between two ALTERs): the
 *     other two are added and v2 is recorded;
 *   - B7 crash-idempotence: columns present, version row missing → [1, 2];
 *   - B8 `integrity_check` is `ok` before and after, and `trusted_schema` is OFF
 *     again after the pre-flight's scoped toggle (BR-089).
 *
 * Boot order reproduces production (`bootEngine`): the REAL legacy
 * `migrateSchema` chain, then the component chain through the REAL
 * `runMigrations`. Every DB is a temp file under `mkdtemp`; nothing here opens
 * `~/.igris/memory/knowledge.db`.
 *
 * @module engine/components/projects/__tests__/watermark-v2.test
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteAdapter } from '../../../storage/sqlite.js';
import { migrateSchema } from '../../../../db.js';
import { createProjectsComponent } from '../index.js';
import type { Migration, StorageAdapter } from '../../../types.js';

const WATERMARK_COLUMNS = ['knowledge_sha', 'knowledge_branch', 'knowledge_recorded_at'] as const;

const tmpDirs: string[] = [];
const openStorages: StorageAdapter[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (openStorages.length) {
    try { openStorages.pop()?.close(); } catch { /* already closed */ }
  }
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function tmpDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'fr274-v2-'));
  tmpDirs.push(d);
  return join(d, 'brain.db');
}

function open(dbPath: string): StorageAdapter {
  const storage = createSqliteAdapter(dbPath);
  openStorages.push(storage);
  return storage;
}

/** Production boot order: legacy chain, then the projects chain (+ any extra migrations). */
function bootProjects(dbPath: string, extra: Migration[] = []): StorageAdapter {
  const storage = open(dbPath);
  migrateSchema(storage.rawConnection);
  storage.runMigrations('projects', [...createProjectsComponent().schema(), ...extra]);
  return storage;
}

function columnsOf(db: Database.Database): string[] {
  return (db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name);
}

function appliedVersions(db: Database.Database): number[] {
  return (db.prepare(
    "SELECT version FROM engine_migrations WHERE component = 'projects' ORDER BY version",
  ).all() as { version: number }[]).map((r) => r.version);
}

function integrity(db: Database.Database): string {
  return String(db.pragma('integrity_check', { simple: true }));
}

function countOf(db: Database.Database, col: string): number {
  return columnsOf(db).filter((c) => c === col).length;
}

describe('projects migration v2 — the knowledge watermark columns (FR-274)', () => {
  it('B1: a fresh DB has all three columns and the chain reads exactly [1, 2]', () => {
    const db = bootProjects(tmpDbPath()).rawConnection;
    for (const c of WATERMARK_COLUMNS) expect(columnsOf(db)).toContain(c);
    expect(appliedVersions(db)).toEqual([1, 2]);
    // All three are nullable TEXT with no default — a row without a watermark reads NULL.
    const info = db.pragma('table_info(projects)') as { name: string; type: string; notnull: number; dflt_value: unknown }[];
    for (const c of WATERMARK_COLUMNS) {
      const col = info.find((i) => i.name === c)!;
      expect(col).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    }
  });

  it('B2: a second boot is idempotent — still [1, 2] and exactly one of each column', () => {
    const path = tmpDbPath();
    bootProjects(path).close();
    const db = bootProjects(path).rawConnection;
    expect(appliedVersions(db)).toEqual([1, 2]);
    for (const c of WATERMARK_COLUMNS) expect(countOf(db, c)).toBe(1);
  });

  it('B3: applies on a DB whose LEGACY chain is already at 26, 27, 28 (the component registry is independent)', () => {
    const storage = open(tmpDbPath());
    const db = storage.rawConnection;
    migrateSchema(db);
    const ins = db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)');
    for (const v of [26, 27, 28]) ins.run(v);
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(28);

    storage.runMigrations('projects', createProjectsComponent().schema());
    expect(appliedVersions(db)).toEqual([1, 2]);
    for (const c of WATERMARK_COLUMNS) expect(columnsOf(db)).toContain(c);
  });

  it('B4: ALTER-only (L-53) — the legacy chain never creates the columns, and db.ts never names knowledge_', () => {
    const storage = open(tmpDbPath());
    migrateSchema(storage.rawConnection);
    for (const c of WATERMARK_COLUMNS) expect(columnsOf(storage.rawConnection)).not.toContain(c);
    const dbTs = readFileSync(join(__dirname, '..', '..', '..', '..', 'db.ts'), 'utf-8');
    expect(dbTs).toContain('CREATE TABLE IF NOT EXISTS projects'); // the scan reads the right file
    expect(dbTs).not.toMatch(/knowledge_/);
    const v2 = createProjectsComponent().schema().find((m) => m.version === 2);
    expect(v2).toBeDefined();
    expect(v2!.description).toMatch(/knowledge_sha/);
    expect(v2!.sql).toBe('SELECT 1;');
  });

  it('B5: all three columns ALREADY present — no throw, v2 RECORDED, and a later v3 probe still applies (M10)', () => {
    const path = tmpDbPath();
    const pre = open(path);
    migrateSchema(pre.rawConnection);
    for (const c of WATERMARK_COLUMNS) pre.rawConnection.exec(`ALTER TABLE projects ADD COLUMN ${c} TEXT`);
    pre.close();

    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    const probe: Migration = { version: 3, description: 'probe', sql: 'CREATE TABLE _probe_v3(x);' };
    let storage: StorageAdapter | undefined;
    expect(() => { storage = bootProjects(path, [probe]); }).not.toThrow();
    const db = storage!.rawConnection;
    expect(appliedVersions(db)).toEqual([1, 2, 3]);
    for (const c of WATERMARK_COLUMNS) expect(countOf(db, c)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_probe_v3'").get()).toBeDefined();
    expect(logged.some((l) => l.includes('projects@2') && l.includes('already present'))).toBe(true);
  });

  it('B6: only knowledge_sha present (a partial crash) — the other two are added and v2 is recorded', () => {
    const path = tmpDbPath();
    const pre = open(path);
    migrateSchema(pre.rawConnection);
    pre.rawConnection.exec('ALTER TABLE projects ADD COLUMN knowledge_sha TEXT');
    pre.close();

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = bootProjects(path).rawConnection;
    expect(appliedVersions(db)).toEqual([1, 2]);
    for (const c of WATERMARK_COLUMNS) expect(countOf(db, c)).toBe(1);
  });

  it('B7: crash-idempotence — the pre-flight ran (columns added) but the version insert never did; the next boot records [1, 2]', () => {
    const path = tmpDbPath();
    const first = open(path);
    migrateSchema(first.rawConnection);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    first.runMigrations('projects', createProjectsComponent().schema().filter((m) => m.version === 1));
    const v2 = createProjectsComponent().schema().find((m) => m.version === 2)!;
    expect(v2.pre!(first.rawConnection)).toBe(true); // the ALTERs happened ...
    expect(appliedVersions(first.rawConnection)).toEqual([1]); // ... the record did not
    first.close();

    const db = bootProjects(path).rawConnection;
    expect(appliedVersions(db)).toEqual([1, 2]);
    for (const c of WATERMARK_COLUMNS) expect(countOf(db, c)).toBe(1);
  });

  it('B8: integrity_check is ok before and after, and trusted_schema is OFF again after the pre-flight', () => {
    const storage = open(tmpDbPath());
    const db = storage.rawConnection;
    migrateSchema(db);
    expect(integrity(db)).toBe('ok');
    storage.runMigrations('projects', createProjectsComponent().schema());
    expect(integrity(db)).toBe('ok');
    expect(db.pragma('trusted_schema', { simple: true })).toBe(0);
    expect(appliedVersions(db)).toEqual([1, 2]);
  });

  it('no projects table (fixture only): v1 and v2 both decline, and both apply on the next boot', () => {
    const storage = open(tmpDbPath());
    const db = storage.rawConnection;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => storage.runMigrations('projects', createProjectsComponent().schema())).not.toThrow();
    expect(appliedVersions(db)).toEqual([]);
    db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL)');
    storage.runMigrations('projects', createProjectsComponent().schema());
    expect(appliedVersions(db)).toEqual([1, 2]);
    for (const c of WATERMARK_COLUMNS) expect(columnsOf(db)).toContain(c);
  });
});
