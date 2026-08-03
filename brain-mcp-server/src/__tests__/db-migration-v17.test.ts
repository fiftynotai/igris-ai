/**
 * Migration v17 Tests — FR-198 (reusable-assets catalog)
 *
 * Verifies the additive registry generalization:
 *   1. v17 adds the three asset-reference columns (when_to_use, source,
 *      source_ref) to the reusable-assets store table.
 *   2. Existing rows survive the migration with NULL new fields
 *      (pure ALTER TABLE ADD COLUMN is metadata-only, NULL-safe).
 *   3. Re-running migrations is idempotent (the PRAGMA table_info guard).
 *
 * The store table is created in v12, which has no vec dependency, so these
 * tests run without the optional sqlite-vec binary. When vec IS available the
 * migration chain advances all the way to v19 (TD-259 renamed the table
 * registry→catalog after v18) — so once a full migrateSchema() runs vec-on,
 * the columns + rows live on the `catalog` table (the post-v19 name).
 *
 * @module __tests__/db-migration-v17
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { migrateSchema } from '../db.js';

// ---------------------------------------------------------------------------
// Native binary detection (mirrors db-migration-v13.test.ts)
// ---------------------------------------------------------------------------

function vecBinaryAvailable(): boolean {
  try {
    const requireCjs = createRequire(import.meta.url);
    const sqliteVec = requireCjs('sqlite-vec') as {
      getLoadablePath?: () => string;
    };
    if (typeof sqliteVec.getLoadablePath === 'function') {
      const p = sqliteVec.getLoadablePath();
      return typeof p === 'string' && p.length > 0;
    }
    return true;
  } catch {
    return false;
  }
}

const HAS_VEC_BINARY = vecBinaryAvailable();

function loadVec(db: Database.Database): void {
  const requireCjs = createRequire(import.meta.url);
  const sqliteVec = requireCjs('sqlite-vec') as {
    load: (db: Database.Database) => void;
  };
  sqliteVec.load(db);
}

// After a full vec-on migrateSchema(), v19 renames registry→catalog, so the
// asset-reference columns live on `catalog`.
function catalogColumns(db: Database.Database): string[] {
  const cols = db.prepare('PRAGMA table_info(catalog)').all() as Array<{ name: string }>;
  return cols.map((c) => c.name);
}

function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migration v17 — registry asset-reference columns (FR-198)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it.skipIf(!HAS_VEC_BINARY)(
    'adds when_to_use / source / source_ref and advances to v17 (vec available)',
    () => {
      loadVec(db);
      migrateSchema(db);

      const cols = catalogColumns(db);
      expect(cols).toContain('when_to_use');
      expect(cols).toContain('source');
      expect(cols).toContain('source_ref');

      // With vec available the whole chain runs to the terminal version, now
      // v23 (FR-246 `briefs_fts`).
      expect(getSchemaVersion(db)).toBe(23);
    },
  );

  it.skipIf(!HAS_VEC_BINARY)(
    'preserves existing store rows with NULL new fields (vec available)',
    () => {
      // First boot: build the schema (full chain renames the store → catalog),
      // then seed rows as a pre-FR-198 DB would have (without the new columns).
      loadVec(db);
      migrateSchema(db);

      // Simulate a pre-FR-198 row by inserting only the old columns.
      db.prepare(
        `INSERT INTO catalog (id, name, type, github_repo)
         VALUES ('legacy-1', 'legacy-template', 'template', 'github.com/org/legacy')`,
      ).run();
      db.prepare(
        `INSERT INTO catalog (id, name, type, github_repo, description)
         VALUES ('legacy-2', 'legacy-module', 'module', 'github.com/org/legacy2', 'a module')`,
      ).run();

      // Re-run migrations (idempotent) — rows must survive untouched.
      migrateSchema(db);

      const rows = db
        .prepare('SELECT id, name, when_to_use, source, source_ref FROM catalog ORDER BY id')
        .all() as Array<{
        id: string;
        name: string;
        when_to_use: string | null;
        source: string | null;
        source_ref: string | null;
      }>;

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.when_to_use).toBeNull();
        expect(row.source).toBeNull();
        expect(row.source_ref).toBeNull();
      }
      expect(rows[0].name).toBe('legacy-template');
      expect(rows[1].name).toBe('legacy-module');
    },
  );

  it.skipIf(!HAS_VEC_BINARY)(
    'is idempotent — running migrations twice does not error or duplicate columns (vec available)',
    () => {
      loadVec(db);
      migrateSchema(db);
      expect(() => migrateSchema(db)).not.toThrow();

      const cols = catalogColumns(db).filter(
        (c) => c === 'when_to_use' || c === 'source' || c === 'source_ref',
      );
      // Exactly one of each — no duplicate ADD COLUMN.
      expect(cols.sort()).toEqual(['source', 'source_ref', 'when_to_use']);
      // Chain runs to the terminal version once vec is available — v23 (FR-246).
      expect(getSchemaVersion(db)).toBe(23);
    },
  );

  it.skipIf(!HAS_VEC_BINARY)(
    'a v17-migrated DB accepts inserts that set the new columns (vec available)',
    () => {
      loadVec(db);
      migrateSchema(db);

      db.prepare(
        `INSERT INTO catalog (id, name, type, github_repo, when_to_use, source, source_ref)
         VALUES ('pkg-1', 'fifty_buttons', 'module', 'github.com/fiftynotai/kit',
                 'when a flutter app needs branded buttons', 'pub.dev', 'fifty_buttons')`,
      ).run();

      const row = db
        .prepare('SELECT when_to_use, source, source_ref FROM catalog WHERE id = ?')
        .get('pkg-1') as { when_to_use: string; source: string; source_ref: string };
      expect(row.when_to_use).toBe('when a flutter app needs branded buttons');
      expect(row.source).toBe('pub.dev');
      expect(row.source_ref).toBe('fifty_buttons');
    },
  );
});
