/**
 * FR-273 — projects migration v3: `project_relation_kinds` +
 * `project_relations` and the five seed kinds (plan §4.2 S-series).
 *
 *   - S1 a fresh DB has chain [1, 2, 3] and both tables with every D1 column;
 *   - S2 (AC1) the 5 seed kinds, each with a non-empty meaning, direction,
 *     forward label, inverse label, example and aliases;
 *   - S3 the seeds carry the FIXED timestamps (byte-identical on every machine);
 *   - S4 a second boot is idempotent (chain, row count, seed bytes);
 *   - S5 a DB whose LEGACY chain is far ahead still takes v3, and a DB already
 *     at projects:2 (the live state) takes v3 alone;
 *   - S6 seed aliases are globally unique (no alias equals a name or another
 *     kind's alias);
 *   - S7 `integrity_check` is `ok`;
 *   - plus: no FK and no vocabulary CHECK in the DDL (D1 rule 4), and the
 *     `(from_slug, kind, to_slug)` uniqueness the sync key relies on.
 *
 * Boot order reproduces production (`relations-fixture.ts#bootRelationsStorage`).
 *
 * @module engine/components/projects/__tests__/relations-schema-v3.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { join } from 'node:path';

import {
  bootRelationsStorage,
  bootRelationsDb,
  cleanupRelationsFixtures,
  tmpRoot,
} from './relations-fixture.js';
import { SEED_KINDS_TIMESTAMP } from '../relations/schema.js';
import { migrateSchema } from '../../../../db.js';

afterEach(() => cleanupRelationsFixtures());

const KIND_COLUMNS = [
  'name', 'meaning', 'direction', 'forward_label', 'inverse_label', 'example',
  'aliases', 'status', 'merged_into', 'created_at', 'updated_at',
];
const RELATION_COLUMNS = [
  'id', 'from_slug', 'kind', 'to_slug', 'detail', 'provenance', 'removed_at',
  'created_at', 'updated_at',
];

function appliedVersions(db: Database.Database): number[] {
  return (db.prepare(
    "SELECT version FROM engine_migrations WHERE component = 'projects' ORDER BY version",
  ).all() as { version: number }[]).map((r) => r.version);
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

function seedKinds(db: Database.Database): Record<string, string | null>[] {
  return db.prepare('SELECT * FROM project_relation_kinds ORDER BY name').all() as Record<string, string | null>[];
}

describe('projects migration v3 — project relations (FR-273)', () => {
  it('S1: a fresh DB has chain [1, 2, 3] and both tables with every D1 column', () => {
    const db = bootRelationsDb();
    expect(appliedVersions(db)).toEqual([1, 2, 3]);
    expect(columnsOf(db, 'project_relation_kinds')).toEqual(KIND_COLUMNS);
    expect(columnsOf(db, 'project_relations')).toEqual(RELATION_COLUMNS);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_project_relations_to'").get();
    expect(idx).toBeDefined();
  });

  it('S2 (AC1): the 5 seed kinds, each with every field non-empty', () => {
    const rows = seedKinds(bootRelationsDb());
    expect(rows.map((r) => r.name)).toEqual(
      ['calls_service', 'supersedes', 'uses_package', 'variant_of', 'white_label_of'],
    );
    for (const r of rows) {
      for (const f of ['meaning', 'direction', 'forward_label', 'inverse_label', 'example', 'aliases']) {
        expect(typeof r[f], `${r.name}.${f}`).toBe('string');
        expect((r[f] as string).trim(), `${r.name}.${f}`).not.toBe('');
      }
      expect(r.status).toBe('active');
      expect(r.merged_into).toBeNull();
    }
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.uses_package.inverse_label).toBe('used by');
    expect(byName.calls_service.inverse_label).toBe('called by');
    expect(byName.white_label_of.inverse_label).toBe('white-labelled as');
    expect(byName.variant_of.inverse_label).toBe('has variant');
    expect(byName.supersedes.inverse_label).toBe('superseded by');
    expect(byName.uses_package.meaning).toBe("A imports B's code (compile-time)");
  });

  it('S3: the seeds carry the FIXED timestamps', () => {
    for (const r of seedKinds(bootRelationsDb())) {
      expect(r.created_at).toBe(SEED_KINDS_TIMESTAMP);
      expect(r.updated_at).toBe(SEED_KINDS_TIMESTAMP);
    }
    expect(SEED_KINDS_TIMESTAMP).toBe('2026-09-29 00:00:00');
  });

  it('S4: a second boot is idempotent — chain, row count and seed bytes unchanged', () => {
    const dbPath = join(tmpRoot(), 'brain.db');
    const first = bootRelationsStorage({ dbPath });
    const before = JSON.stringify(seedKinds(first.rawConnection));
    first.close();
    const db = bootRelationsDb({ dbPath });
    expect(appliedVersions(db)).toEqual([1, 2, 3]);
    expect(JSON.stringify(seedKinds(db))).toBe(before);
    expect((db.prepare('SELECT COUNT(*) AS n FROM project_relation_kinds').get() as { n: number }).n).toBe(5);
  });

  it('S5: a legacy chain far ahead still takes v3; a DB already at projects:2 takes v3 alone', () => {
    // (a) the component registry is independent of `schema_version`.
    const dbPath = join(tmpRoot(), 'brain.db');
    const storage = bootRelationsStorage({ dbPath, maxVersion: 0 });
    const raw = storage.rawConnection;
    const ins = raw.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)');
    for (const v of [90, 91, 92]) ins.run(v);
    storage.close();
    expect(appliedVersions(bootRelationsDb({ dbPath }))).toEqual([1, 2, 3]);

    // (b) the live state: projects at [1, 2]; the next boot applies v3 only.
    const livePath = join(tmpRoot(), 'brain.db');
    const at2 = bootRelationsStorage({ dbPath: livePath, maxVersion: 2 });
    expect(appliedVersions(at2.rawConnection)).toEqual([1, 2]);
    expect(at2.rawConnection.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'project_relation%'").all()).toEqual([]);
    at2.close();
    const db = bootRelationsDb({ dbPath: livePath });
    expect(appliedVersions(db)).toEqual([1, 2, 3]);
    expect(seedKinds(db)).toHaveLength(5);
  });

  it('S6: seed aliases are globally unique — no alias is a name or another kind\'s alias', () => {
    const rows = seedKinds(bootRelationsDb());
    const names = new Set(rows.map((r) => r.name as string));
    const seen = new Map<string, string>();
    for (const r of rows) {
      const aliases = (r.aliases as string).split(',');
      expect(aliases, `${r.name} aliases are stored sorted`).toEqual([...aliases].sort());
      for (const a of aliases) {
        expect(names.has(a), `${a} collides with a kind name`).toBe(false);
        expect(seen.has(a), `${a} is on ${seen.get(a)} and ${r.name}`).toBe(false);
        seen.set(a, r.name as string);
      }
    }
    expect(seen.size).toBe(12);
  });

  it('S7: integrity_check is ok', () => {
    const db = bootRelationsDb();
    expect(String(db.pragma('integrity_check', { simple: true }))).toBe('ok');
  });

  it('D1 rule: no FK and no CHECK on either table; (from_slug, kind, to_slug) is UNIQUE', () => {
    const db = bootRelationsDb();
    for (const t of ['project_relation_kinds', 'project_relations']) {
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t) as { sql: string }).sql;
      expect(sql, t).not.toMatch(/\bREFERENCES\b/i);
      expect(sql, t).not.toMatch(/\bCHECK\b/i);
      expect(db.pragma(`foreign_key_list(${t})`), t).toEqual([]);
    }
    const ins = db.prepare("INSERT INTO project_relations (from_slug, kind, to_slug) VALUES ('a', 'uses_package', 'b')");
    ins.run();
    expect(() => ins.run()).toThrow(/UNIQUE/);
  });

  it('v3 lives in the component registry: the legacy chain alone never creates the tables', () => {
    const raw = openLegacyOnly();
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'project_relation%'").all()).toEqual([]);
  });
});

function openLegacyOnly(): Database.Database {
  const storage = bootRelationsStorage({ maxVersion: 0 });
  migrateSchema(storage.rawConnection);
  return storage.rawConnection;
}
