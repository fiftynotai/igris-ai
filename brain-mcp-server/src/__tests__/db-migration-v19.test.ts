/**
 * Migration v19 Tests — TD-259 (reusable-assets store rename: registry → catalog)
 *
 * Verifies the one-time idempotent RENAME migration:
 *   1. The base table `registry` is renamed to `catalog` (ALTER TABLE RENAME TO).
 *   2. Rows + the 3 FR-198 columns (when_to_use/source/source_ref) survive the
 *      rename byte-for-byte.
 *   3. The 4 indexes are renamed idx_registry_* → idx_catalog_*.
 *   4. The FTS5 table + 3 triggers are rebuilt against `catalog`; the
 *      pre-existing rows remain searchable after the 'rebuild' step.
 *   5. The catalog_ai/au/ad triggers fire on INSERT/UPDATE/DELETE post-rename.
 *   6. Idempotency — a second migrateSchema() changes nothing and does not throw.
 *   7. schema_version runs the chain to completion (terminal v24 after TD-338).
 *   8. A DB stalled at v12 (registry only) reaches v19 via the L-209 re-read gate.
 *
 * Gate-dodge proof: this migration has NO vec dependency, so the suite runs
 * WITHOUT loading sqlite-vec. On a vec-less machine the v13 vec backfill stops
 * the chain at v12 (where the `registry` table is created), so we drive
 * schema_version up to 18 manually (INSERT OR IGNORE) before running
 * migrateSchema — the L-209 re-read gate must still fire v19 from version 18
 * regardless of how the chain reached it.
 *
 * @module __tests__/db-migration-v19
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateSchema } from '../db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  );
}

function indexExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get(name) !== undefined
  );
}

function triggerExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
      .get(name) !== undefined
  );
}

/**
 * Add the v17 FR-198 asset-reference columns to the `registry` table if they
 * are missing. On a vec-less chain migrateSchema stalls at v12 (where `registry`
 * is created WITHOUT these columns), so a test that forces the version ladder
 * past 17 must add them by hand — mirroring what the real v17 ALTER would do —
 * before seeding rows that set them.
 */
function ensureFr198Columns(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(registry)`).all() as Array<{ name: string }>;
  const has = (n: string): boolean => cols.some((c) => c.name === n);
  if (!has('when_to_use')) db.exec(`ALTER TABLE registry ADD COLUMN when_to_use TEXT`);
  if (!has('source')) db.exec(`ALTER TABLE registry ADD COLUMN source TEXT`);
  if (!has('source_ref')) db.exec(`ALTER TABLE registry ADD COLUMN source_ref TEXT`);
}

/**
 * Build the brain schema (tables) without vec, then force schema_version to
 * exactly 18 so the next migrateSchema() call fires v19. migrateSchema builds
 * the tables (the `registry` table + registry_fts + triggers land at v12, where
 * the vec-less chain stalls); we add the v17 FR-198 columns by hand, then top up
 * the version ladder to 18 with INSERT OR IGNORE (idempotent).
 */
function buildSchemaAtV18(db: Database.Database): void {
  migrateSchema(db);
  ensureFr198Columns(db);
  for (let v = 13; v <= 18; v++) {
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
  }
}

interface CatalogSeed {
  id: string;
  name: string;
  type: 'template' | 'module';
  github_repo: string;
  description?: string;
  tags?: string;
  framework?: string;
  when_to_use?: string;
  source?: string;
  source_ref?: string;
}

/** Seed a row into the OLD `registry` table (pre-rename). */
function seedRegistryRow(db: Database.Database, r: CatalogSeed): void {
  db.prepare(
    `INSERT INTO registry (id, name, type, github_repo, description, tags, framework,
       when_to_use, source, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.name,
    r.type,
    r.github_repo,
    r.description ?? null,
    r.tags ?? '[]',
    r.framework ?? null,
    r.when_to_use ?? null,
    r.source ?? null,
    r.source_ref ?? null,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migration v19 — reusable-assets store rename registry → catalog (TD-259)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    buildSchemaAtV18(db);
  });

  afterEach(() => {
    db.close();
  });

  it('renames the base table registry → catalog', () => {
    expect(tableExists(db, 'registry')).toBe(true);
    expect(tableExists(db, 'catalog')).toBe(false);

    migrateSchema(db);

    expect(tableExists(db, 'registry')).toBe(false);
    expect(tableExists(db, 'catalog')).toBe(true);
  });

  it('preserves rows + the 3 FR-198 columns through the rename', () => {
    seedRegistryRow(db, {
      id: 'pkg-fifty-buttons',
      name: 'fifty_buttons',
      type: 'module',
      github_repo: 'github.com/fiftynotai/fifty_flutter_kit',
      description: 'Branded button component set',
      framework: 'flutter',
      tags: '["ui", "buttons"]',
      when_to_use: 'when a Flutter project needs the fifty.dev branded button system',
      source: 'pub.dev',
      source_ref: 'fifty_buttons',
    });
    seedRegistryRow(db, {
      id: 'tmpl-brand-flutter',
      name: 'brand-website-flutter',
      type: 'template',
      github_repo: 'github.com/org/brand',
      description: 'Flutter brand website template',
      framework: 'flutter',
    });

    migrateSchema(db);

    const rows = db
      .prepare('SELECT id, name, type, when_to_use, source, source_ref FROM catalog ORDER BY id')
      .all() as Array<{
        id: string;
        name: string;
        type: string;
        when_to_use: string | null;
        source: string | null;
        source_ref: string | null;
      }>;
    expect(rows).toHaveLength(2);

    const pkg = rows.find((r) => r.id === 'pkg-fifty-buttons')!;
    expect(pkg.name).toBe('fifty_buttons');
    expect(pkg.type).toBe('module');
    expect(pkg.when_to_use).toBe(
      'when a Flutter project needs the fifty.dev branded button system',
    );
    expect(pkg.source).toBe('pub.dev');
    expect(pkg.source_ref).toBe('fifty_buttons');

    const tmpl = rows.find((r) => r.id === 'tmpl-brand-flutter')!;
    expect(tmpl.name).toBe('brand-website-flutter');
    // FR-198 columns are NULL on rows that did not set them — preserved.
    expect(tmpl.when_to_use).toBeNull();
    expect(tmpl.source).toBeNull();
  });

  it('renames the 4 indexes idx_registry_* → idx_catalog_*', () => {
    migrateSchema(db);

    for (const suffix of ['type', 'archetype', 'framework', 'status']) {
      expect(indexExists(db, `idx_registry_${suffix}`)).toBe(false);
      expect(indexExists(db, `idx_catalog_${suffix}`)).toBe(true);
    }
  });

  it('rebuilds FTS5 against catalog — pre-existing rows stay searchable', () => {
    seedRegistryRow(db, {
      id: 'mod-hero-scroll',
      name: 'hero_scroll_module',
      type: 'module',
      github_repo: 'github.com/org/brand',
      description: 'Hero scroll animation module for brand websites',
      framework: 'flutter',
      tags: '["animation", "scroll", "hero"]',
    });

    migrateSchema(db);

    // The old FTS table + triggers are gone; the new ones exist.
    expect(tableExists(db, 'registry_fts')).toBe(false);
    expect(tableExists(db, 'catalog_fts')).toBe(true);
    expect(triggerExists(db, 'registry_ai')).toBe(false);
    expect(triggerExists(db, 'catalog_ai')).toBe(true);
    expect(triggerExists(db, 'catalog_au')).toBe(true);
    expect(triggerExists(db, 'catalog_ad')).toBe(true);

    // The 'rebuild' step re-indexed the pre-existing row → still searchable.
    const hits = db
      .prepare(
        `SELECT c.name FROM catalog_fts f JOIN catalog c ON c.rowid = f.rowid
           WHERE catalog_fts MATCH 'hero'`,
      )
      .all() as Array<{ name: string }>;
    expect(hits.map((h) => h.name)).toContain('hero_scroll_module');
  });

  it('catalog_ai/au/ad triggers fire on INSERT/UPDATE/DELETE post-rename', () => {
    migrateSchema(db);

    // INSERT → searchable (catalog_ai)
    db.prepare(
      `INSERT INTO catalog (id, name, type, github_repo, description, tags)
       VALUES ('t1', 'searchable_widget', 'module', 'github.com/org/repo', 'a unique widget', '[]')`,
    ).run();
    let hits = db
      .prepare(
        `SELECT c.id FROM catalog_fts f JOIN catalog c ON c.rowid = f.rowid
           WHERE catalog_fts MATCH 'searchable_widget'`,
      )
      .all() as Array<{ id: string }>;
    expect(hits.map((h) => h.id)).toContain('t1');

    // UPDATE → old term gone, new term present (catalog_au)
    db.prepare(`UPDATE catalog SET name = 'renamed_gadget' WHERE id = 't1'`).run();
    hits = db
      .prepare(
        `SELECT c.id FROM catalog_fts f JOIN catalog c ON c.rowid = f.rowid
           WHERE catalog_fts MATCH 'renamed_gadget'`,
      )
      .all() as Array<{ id: string }>;
    expect(hits.map((h) => h.id)).toContain('t1');
    const oldTerm = db
      .prepare(
        `SELECT c.id FROM catalog_fts f JOIN catalog c ON c.rowid = f.rowid
           WHERE catalog_fts MATCH 'searchable_widget'`,
      )
      .all() as Array<{ id: string }>;
    expect(oldTerm).toHaveLength(0);

    // DELETE → gone from the index (catalog_ad)
    db.prepare(`DELETE FROM catalog WHERE id = 't1'`).run();
    const afterDelete = db
      .prepare(
        `SELECT c.id FROM catalog_fts f JOIN catalog c ON c.rowid = f.rowid
           WHERE catalog_fts MATCH 'renamed_gadget'`,
      )
      .all() as Array<{ id: string }>;
    expect(afterDelete).toHaveLength(0);
  });

  it('records v19 and runs the chain to completion (terminal v24 — TD-338)', () => {
    expect(getSchemaVersion(db)).toBe(18);
    migrateSchema(db);
    // v19 is recorded in the ladder...
    expect(db.prepare('SELECT 1 FROM schema_version WHERE version = 19').get()).toBeDefined();
    // ...and migrateSchema runs to completion (v20 worker-subsystem teardown,
    // v21 rename, v22 brief_type fold and v23 briefs_fts follow v19 in the same
    // call).
    expect(getSchemaVersion(db)).toBe(24);
  });

  it('is idempotent — a second migration changes nothing and does not throw', () => {
    seedRegistryRow(db, {
      id: 'idem-1',
      name: 'idem_module',
      type: 'module',
      github_repo: 'github.com/org/repo',
      description: 'idempotency probe',
    });

    migrateSchema(db);
    const after1 = db.prepare('SELECT * FROM catalog ORDER BY id').all();
    expect(getSchemaVersion(db)).toBe(24);

    // Second run: no version bump, no row change, no throw.
    expect(() => migrateSchema(db)).not.toThrow();
    const after2 = db.prepare('SELECT * FROM catalog ORDER BY id').all();
    expect(getSchemaVersion(db)).toBe(24);
    expect(after2).toEqual(after1);
    // catalog still present, registry still gone.
    expect(tableExists(db, 'catalog')).toBe(true);
    expect(tableExists(db, 'registry')).toBe(false);
  });

  it('applies v19 even when the chain stalled at v12 (vec-less gate dodge)', () => {
    // Fresh DB: build tables but DELETE every schema_version row above 12 to
    // simulate a vec-less machine where v13 never recorded — then force the top
    // to 18 (as a partial migration that ran v14-18 steps would) and assert v19
    // still fires from the re-read gate.
    const fresh = new Database(':memory:');
    fresh.pragma('foreign_keys = ON');
    migrateSchema(fresh);
    ensureFr198Columns(fresh);
    fresh.prepare('DELETE FROM schema_version WHERE version > 12').run();
    for (let v = 13; v <= 18; v++) {
      fresh.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
    }
    seedRegistryRow(fresh, {
      id: 'stall-1',
      name: 'stalled_module',
      type: 'module',
      github_repo: 'github.com/org/repo',
      description: 'survived the vec-less chain',
      when_to_use: 'gate-dodge probe',
      source: 'github',
    });

    migrateSchema(fresh);

    expect(getSchemaVersion(fresh)).toBe(24);
    expect(tableExists(fresh, 'catalog')).toBe(true);
    expect(tableExists(fresh, 'registry')).toBe(false);
    const row = fresh
      .prepare('SELECT name, when_to_use, source FROM catalog WHERE id = ?')
      .get('stall-1') as { name: string; when_to_use: string; source: string };
    expect(row.name).toBe('stalled_module');
    expect(row.when_to_use).toBe('gate-dodge probe');
    expect(row.source).toBe('github');
    fresh.close();
  });
});
