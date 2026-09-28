/**
 * FR-265 — projects component migration v1: `projects.repo_url`.
 * TD-365 S3 — every NOT NULL, no-default `projects` column is validated.
 *
 * What it gates (FR-265 AC1, the code half — the live half is runtime R2/R4):
 *   - a fresh DB gets the column and the component chain reads exactly [1];
 *   - a second boot is idempotent;
 *   - the migration lives in the COMPONENT registry on purpose: a DB whose
 *     legacy `schema_version` chain is already at 26, 27, 28 (the live brain;
 *     develop's chain ends at 25) still takes v1 (GL-012 / TD-433);
 *   - it is ALTER-only (L-53): the legacy chain never creates the column, and
 *     `db.ts` never names it;
 *   - a DB whose `projects` ALREADY has `repo_url` boots without throwing and
 *     still RECORDS v1 — a declining pre-flight would pin the component at v0
 *     and silently skip every later `projects` migration, forever;
 *   - so a later migration (a v2 probe) still applies on that DB;
 *   - a DB with no `projects` table declines, stays at [], and applies v1 on
 *     the next boot once the table exists (a retry, not a stall);
 *   - a crash between the ALTER and the version insert heals on the next boot;
 *   - `PRAGMA integrity_check` is `ok` before and after, and the connection is
 *     left with `trusted_schema = OFF` (the pre-flight's scoped toggle, BR-089).
 *
 * Boot order reproduces production (`bootEngine`): the REAL legacy
 * `migrateSchema` chain, then the component chain through the REAL
 * `runMigrations`. Every DB is a temp file under `mkdtemp`; nothing here opens
 * `~/.igris/memory/knowledge.db`.
 *
 * @module engine/components/projects/__tests__/repo-url-v1.test
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteAdapter } from '../../../storage/sqlite.js';
import { migrateSchema } from '../../../../db.js';
import { createProjectsComponent } from '../index.js';
import { PROJECT_REGISTER_REQUIRED_KEYS } from '../../../../tools/projects.js';
import type { Migration, StorageAdapter } from '../../../types.js';

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
  const d = mkdtempSync(join(tmpdir(), 'fr265-v1-'));
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

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

function appliedVersions(db: Database.Database): number[] {
  return (db.prepare(
    "SELECT version FROM engine_migrations WHERE component = 'projects' ORDER BY version",
  ).all() as { version: number }[]).map((r) => r.version);
}

function integrity(db: Database.Database): string {
  return String(db.pragma('integrity_check', { simple: true }));
}

describe('projects migration v1 — projects.repo_url (FR-265)', () => {
  it('a fresh DB: the column is present and the chain reads exactly [1]', () => {
    const db = bootProjects(tmpDbPath()).rawConnection;
    expect(columnsOf(db, 'projects')).toContain('repo_url');
    expect(appliedVersions(db)).toEqual([1]);
  });

  it('is idempotent: a second boot leaves [1] and exactly one repo_url column', () => {
    const path = tmpDbPath();
    bootProjects(path).close();
    const db = bootProjects(path).rawConnection;
    expect(appliedVersions(db)).toEqual([1]);
    expect(columnsOf(db, 'projects').filter((c) => c === 'repo_url')).toHaveLength(1);
  });

  it('applies on a DB whose LEGACY chain is already at 26, 27, 28 (the live brain) — the component registry is independent of schema_version', () => {
    const storage = open(tmpDbPath());
    const db = storage.rawConnection;
    migrateSchema(db);
    const legacyTop = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    const ins = db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)');
    for (const v of [26, 27, 28]) ins.run(v);
    expect(legacyTop).toBeLessThan(26);
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(28);

    storage.runMigrations('projects', createProjectsComponent().schema());
    expect(appliedVersions(db)).toEqual([1]);
    expect(columnsOf(db, 'projects')).toContain('repo_url');
  });

  it('is ALTER-only (L-53): the legacy chain never creates the column, and db.ts never names it', () => {
    const storage = open(tmpDbPath());
    migrateSchema(storage.rawConnection);
    expect(columnsOf(storage.rawConnection, 'projects')).not.toContain('repo_url');
    const dbTs = readFileSync(join(__dirname, '..', '..', '..', '..', 'db.ts'), 'utf-8');
    expect(dbTs).toContain('CREATE TABLE IF NOT EXISTS projects'); // the scan reads the right file
    expect(dbTs).not.toMatch(/repo_url/);
    // The declaration carries the three reasons, so a refactor meets them first.
    const v1 = createProjectsComponent().schema().find((m) => m.version === 1)!;
    expect(v1.description).toMatch(/repo_url/);
  });

  it('PRAGMA integrity_check is ok before and after, and trusted_schema is OFF again after the pre-flight', () => {
    const storage = open(tmpDbPath());
    const db = storage.rawConnection;
    migrateSchema(db);
    expect(integrity(db)).toBe('ok');
    storage.runMigrations('projects', createProjectsComponent().schema());
    expect(integrity(db)).toBe('ok');
    expect(db.pragma('trusted_schema', { simple: true })).toBe(0);
    expect(appliedVersions(db)).toEqual([1]);
  });

  it('a DB whose projects ALREADY has repo_url: no throw, v1 is RECORDED ([1], not []), one column, and the log says so', () => {
    const path = tmpDbPath();
    const pre = open(path);
    migrateSchema(pre.rawConnection);
    pre.rawConnection.exec('ALTER TABLE projects ADD COLUMN repo_url TEXT');
    pre.close();

    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    let storage: StorageAdapter | undefined;
    expect(() => { storage = bootProjects(path); }).not.toThrow();
    const db = storage!.rawConnection;
    expect(appliedVersions(db)).toEqual([1]);
    expect(columnsOf(db, 'projects').filter((c) => c === 'repo_url')).toHaveLength(1);
    expect(logged.some((l) => l.includes('already present'))).toBe(true);
  });

  it('...and a LATER projects migration still applies on that DB (v1 did not stall the component at v0)', () => {
    const path = tmpDbPath();
    const pre = open(path);
    migrateSchema(pre.rawConnection);
    pre.rawConnection.exec('ALTER TABLE projects ADD COLUMN repo_url TEXT');
    pre.close();

    const probe: Migration = { version: 2, description: 'probe', sql: 'CREATE TABLE _probe_v2(x);' };
    const db = bootProjects(path, [probe]).rawConnection;
    expect(appliedVersions(db)).toEqual([1, 2]);
    const probeTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_probe_v2'").get();
    expect(probeTable).toBeDefined();
  });

  it('no projects table (fixture only): declines without throwing, stays at [], and applies on the next boot once the table exists', () => {
    const path = tmpDbPath();
    const storage = open(path);
    const db = storage.rawConnection;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => storage.runMigrations('projects', createProjectsComponent().schema())).not.toThrow();
    expect(appliedVersions(db)).toEqual([]);

    db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL)');
    storage.runMigrations('projects', createProjectsComponent().schema());
    expect(appliedVersions(db)).toEqual([1]);
    expect(columnsOf(db, 'projects')).toContain('repo_url');
  });

  it('crash-idempotence: the pre-flight ran (column added) but the version insert never did — the next boot records [1] without throwing', () => {
    const path = tmpDbPath();
    const first = open(path);
    migrateSchema(first.rawConnection);
    const v1 = createProjectsComponent().schema().find((m) => m.version === 1)!;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(v1.pre!(first.rawConnection)).toBe(true); // the ALTER happened ...
    expect(appliedVersions(first.rawConnection)).toEqual([]); // ... the record did not
    first.close();

    const db = bootProjects(path).rawConnection;
    expect(appliedVersions(db)).toEqual([1]);
    expect(columnsOf(db, 'projects').filter((c) => c === 'repo_url')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TD-365 S3 — structural: every `projects` column the INSERT cannot default is
// covered by the handler's truthiness validator, so a raw NOT NULL constraint
// error cannot reach a caller from `igris_project_register`.
// ---------------------------------------------------------------------------

interface ColumnInfo { name: string; notnull: number; dflt_value: unknown; pk: number }

/** Columns that MUST arrive with content: NOT NULL, no default, not the rowid pk. */
function uncoveredNotNull(cols: ColumnInfo[], validated: readonly string[]): string[] {
  return cols
    .filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0)
    .map((c) => c.name)
    .filter((n) => !validated.includes(n));
}

describe('TD-365 S3 — the register validator covers every NOT NULL, no-default projects column', () => {
  it('on the REAL migrated schema, nothing is left uncovered', () => {
    const db = bootProjects(tmpDbPath()).rawConnection;
    const cols = db.pragma('table_info(projects)') as ColumnInfo[];
    // The checker is armed: the schema really has NOT NULL no-default columns.
    expect(cols.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0).map((c) => c.name).sort())
      .toEqual(['name', 'path', 'slug']);
    expect(uncoveredNotNull(cols, PROJECT_REGISTER_REQUIRED_KEYS)).toEqual([]);
  });

  it('SELF-NEGATIVE: the same checker reports a synthetic extra NOT NULL column', () => {
    const db = bootProjects(tmpDbPath()).rawConnection;
    const cols = db.pragma('table_info(projects)') as ColumnInfo[];
    const planted = [...cols, { name: 'owner', notnull: 1, dflt_value: null, pk: 0 }];
    expect(uncoveredNotNull(planted, PROJECT_REGISTER_REQUIRED_KEYS)).toEqual(['owner']);
  });
});
