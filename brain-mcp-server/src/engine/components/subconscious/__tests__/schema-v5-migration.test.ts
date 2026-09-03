/**
 * TD-440 — subconscious schema v5: additive, idempotent, and out of the wire.
 *
 * v3 was a table REBUILD (SQLite cannot drop a CHECK via ALTER), which is the
 * expensive shape and the one that loses ids if it goes wrong. v5 is
 * deliberately not that: six `ADD COLUMN`s and two indexes. These tests pin the
 * difference, because "additive" is a claim about row identity that a
 * description cannot make on its own.
 *
 * @module engine/components/subconscious/__tests__/schema-v5-migration.test
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { subconsciousMigrations } from '../schema.js';

const V5 = subconsciousMigrations.find((m) => m.version === 5)!;
const THROUGH_V4 = subconsciousMigrations.filter((m) => m.version <= 4);

const NEW_COLUMNS = [
  'dedupe_key',
  'entity_key',
  'seen_count',
  'last_seen_at',
  'recurrence_titles',
  'source_instance',
];

function preV5(): Database.Database {
  const db = new Database(':memory:');
  for (const m of THROUGH_V4) db.exec(m.sql);
  return db;
}

function columns(db: Database.Database): string[] {
  return (
    db.prepare(`PRAGMA table_info(suggestions)`).all() as { name: string }[]
  ).map((c) => c.name);
}

describe('subconscious schema v5 (TD-440)', () => {
  it('exists and is registered exactly once', () => {
    expect(V5).toBeDefined();
    expect(subconsciousMigrations.filter((m) => m.version === 5)).toHaveLength(1);
    // Versions are dense and ordered — a gap means a migration was edited in
    // place rather than added, which the per-component registry forbids.
    expect(subconsciousMigrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it('adds exactly the six columns and removes none', () => {
    const db = preV5();
    try {
      const before = columns(db);
      expect(before).not.toContain('dedupe_key');

      db.exec(V5.sql);

      const after = columns(db);
      for (const c of before) expect(after).toContain(c);
      expect(after).toEqual([...before, ...NEW_COLUMNS]);
    } finally {
      db.close();
    }
  });

  it('is ADDITIVE: existing rows keep their ids and every value', () => {
    const db = preV5();
    try {
      db.prepare(
        `INSERT INTO suggestions (id, source_module, project_slug, title, evidence, priority, status, created_at)
         VALUES (7, 'abandoned_project', 'fifty_eco_system', 'a stale backlog', '{"brief_id":"BR-1"}', 'high', 'pending', '2026-01-01 00:00:00')`,
      ).run();

      db.exec(V5.sql);

      const row = db.prepare(`SELECT * FROM suggestions`).get() as Record<string, unknown>;
      // Row identity is the thing a rebuild loses. `id=7` surviving is the
      // assertion that this was an ALTER.
      expect(row.id).toBe(7);
      expect(row.title).toBe('a stale backlog');
      expect(row.priority).toBe('high');
      expect(row.created_at).toBe('2026-01-01 00:00:00');
      // Defaults on the pre-existing row.
      expect(row.seen_count).toBe(1);
      expect(row.recurrence_titles).toBe('[]');
      expect(row.dedupe_key).toBeNull();
      expect(row.entity_key).toBeNull();
      expect(row.source_instance).toBeNull();
    } finally {
      db.close();
    }
  });

  it('creates both lookup indexes', () => {
    const db = preV5();
    try {
      db.exec(V5.sql);
      const idx = (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='suggestions'`)
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(idx).toContain('idx_suggestions_entity_key');
      expect(idx).toContain('idx_suggestions_dedupe_key');
    } finally {
      db.close();
    }
  });

  it('the full chain applies cleanly from empty', () => {
    const db = new Database(':memory:');
    try {
      for (const m of subconsciousMigrations) db.exec(m.sql);
      expect(columns(db)).toEqual(expect.arrayContaining(NEW_COLUMNS));
      // v4 dropped it; v5 must not resurrect it.
      const tables = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(tables).not.toContain('pattern_observations');
    } finally {
      db.close();
    }
  });

  it('the index half is idempotent (IF NOT EXISTS), which is what a re-run hits', () => {
    const db = preV5();
    try {
      db.exec(V5.sql);
      const indexSql = V5.sql
        .split(';')
        .filter((s) => s.trim().startsWith('CREATE INDEX'))
        .join(';');
      expect(() => db.exec(indexSql)).not.toThrow();
      // The ALTERs are NOT idempotent on their own — SQLite has no
      // `ADD COLUMN IF NOT EXISTS` — and they do not need to be: the
      // `engine_migrations` version guard is what makes re-entry impossible.
      // Asserted so nobody "fixes" the migration by making it re-runnable.
      expect(() => db.exec('ALTER TABLE suggestions ADD COLUMN dedupe_key TEXT')).toThrow(
        /duplicate column/i,
      );
    } finally {
      db.close();
    }
  });
});
