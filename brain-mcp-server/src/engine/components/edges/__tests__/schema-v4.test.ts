/**
 * BR-083 — `edges@4` rebuild fidelity, and the `pre`/`post` hook contract.
 *
 * v4 DROPS AND RECREATES `entity_edges` on a live brain. Everything below is a
 * property the rebuild must not lose, asserted on a table seeded to look like
 * the real one: explicit ids (`source_edge_id`, `igris_edge_remove` and the
 * janitor's undo all address rows BY ID), a continuing `AUTOINCREMENT`
 * sequence, the full index inventory, and referential integrity.
 *
 * The `pre` hook is tested through `runMigrations` rather than by calling it,
 * because the thing that matters is the ABORT SEMANTICS — a `false` return has
 * to leave the component at the previous version so the next boot retries.
 * Calling the hook directly would assert its return value and prove nothing
 * about what the runner does with it.
 *
 * @module engine/components/edges/__tests__/schema-v4.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createSqliteAdapter } from '../../../storage/sqlite.js';
import { edgeMigrations, EDGES_V4_BACKUP_SUFFIX } from '../schema.js';
import type { Migration } from '../../../types.js';

/** The v1..v3 migrations — the shape a pre-BR-083 brain is actually in. */
const PRE_V4 = edgeMigrations.filter((m) => m.version < 4);
const V4 = edgeMigrations.find((m) => m.version === 4)!;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'br083-schema-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A file-backed brain at v3 with `rows` seeded edges (ids 1..n, with a gap). */
function seedV3(path: string, ids: number[]): void {
  const db = new Database(path);
  for (const m of PRE_V4) db.exec(m.sql);
  const ins = db.prepare(
    `INSERT INTO entity_edges (id, from_type, from_id, to_type, to_id, edge_type,
                               confidence, provenance, created_at, metadata)
     VALUES (?, 'brief', ?, 'brief', ?, 'parent_of', 0.5, 'backfill', '2026-01-01 00:00:00', ?)`,
  );
  for (const id of ids) ins.run(id, `BR-${id}`, `BR-${id + 1000}`, `{"seed":${id}}`);
  db.close();
}

describe('edges@4 — rebuild fidelity', () => {
  it('preserves every id, every column value, and the row count', () => {
    const path = join(dir, 'brain.db');
    seedV3(path, [1, 2, 7, 99]);

    const adapter = createSqliteAdapter(path);
    adapter.runMigrations('edges', edgeMigrations);
    const db = adapter.rawConnection;

    const rows = db
      .prepare('SELECT * FROM entity_edges ORDER BY id ASC')
      .all() as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual([1, 2, 7, 99]);
    expect(rows[0]).toMatchObject({
      from_type: 'brief',
      from_id: 'BR-1',
      to_id: 'BR-1001',
      edge_type: 'parent_of',
      confidence: 0.5,
      provenance: 'backfill',
      created_at: '2026-01-01 00:00:00',
      metadata: '{"seed":1}',
      // The point of the whole migration — present, and NULL, not absent.
      from_project: null,
      to_project: null,
    });
    adapter.close();
  });

  it('the AUTOINCREMENT sequence CONTINUES — a new row cannot reuse an id', () => {
    const path = join(dir, 'brain.db');
    seedV3(path, [1, 2, 7, 99]);

    const adapter = createSqliteAdapter(path);
    adapter.runMigrations('edges', edgeMigrations);
    const db = adapter.rawConnection;

    // `DROP TABLE` deletes the old `sqlite_sequence` row; the rename carries
    // the new one over. If that ordering were wrong the next insert would be
    // id 1 and would collide with a live row that other tables reference.
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
       VALUES ('brief', 'BR-NEW', 'brief', 'BR-OLD', 'related_to')`,
    ).run();
    const maxId = (
      db.prepare('SELECT MAX(id) AS n FROM entity_edges').get() as { n: number }
    ).n;
    expect(maxId).toBe(100);
    adapter.close();
  });

  it('recreates the full index inventory, plus the three new ones', () => {
    const path = join(dir, 'brain.db');
    seedV3(path, [1]);
    const adapter = createSqliteAdapter(path);
    adapter.runMigrations('edges', edgeMigrations);
    const db = adapter.rawConnection;

    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='entity_edges' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    // The four pre-v4 indexes SURVIVE...
    expect(names).toContain('idx_edges_from');
    expect(names).toContain('idx_edges_to');
    expect(names).toContain('idx_edges_type');
    expect(names).toContain('idx_edges_compound');
    // ...and the three v4 ones exist.
    expect(names).toContain('idx_edges_unique');
    expect(names).toContain('idx_edges_from_proj');
    expect(names).toContain('idx_edges_to_proj');

    // The table-level UNIQUE is GONE — that is what made two edges differing
    // only by project storable. Its autoindex must not survive the rebuild.
    expect(names).not.toContain('sqlite_autoindex_entity_edges_1');
    adapter.close();
  });

  it('leaves foreign_key_check(entity_edges) empty and foreign_keys back ON', () => {
    const path = join(dir, 'brain.db');
    seedV3(path, [1, 2]);
    const adapter = createSqliteAdapter(path);
    adapter.runMigrations('edges', edgeMigrations);
    const db = adapter.rawConnection;

    expect(db.pragma('foreign_key_check(entity_edges)')).toEqual([]);
    // `pre` turned it OFF for the rebuild; `post` must hand the connection back
    // hardened, or every later write on this boot runs unchecked.
    expect(db.pragma('foreign_keys')).toEqual([{ foreign_keys: 1 }]);
    adapter.close();
  });

  it('takes a VERIFIED backup beside the database, and it opens', () => {
    const path = join(dir, 'brain.db');
    seedV3(path, [1, 2, 3]);
    const adapter = createSqliteAdapter(path);
    adapter.runMigrations('edges', edgeMigrations);
    adapter.close();

    const backup = `${path}${EDGES_V4_BACKUP_SUFFIX}`;
    expect(existsSync(backup)).toBe(true);

    // Openable and PRE-migration: 3 rows, and NO project columns. A "backup"
    // that already contained the migration would be useless for rolling back.
    const b = new Database(backup, { readonly: true, fileMustExist: true });
    expect((b.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number }).n).toBe(3);
    const cols = (b.prepare('PRAGMA table_info(entity_edges)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).not.toContain('from_project');
    b.close();
  });

  it('re-running the migration set is a no-op (version already recorded)', () => {
    const path = join(dir, 'brain.db');
    seedV3(path, [1, 2]);
    const adapter = createSqliteAdapter(path);
    adapter.runMigrations('edges', edgeMigrations);
    adapter.runMigrations('edges', edgeMigrations);
    const db = adapter.rawConnection;
    expect((db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number }).n).toBe(2);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM engine_migrations WHERE component='edges'")
          .get() as { n: number }
      ).n,
    ).toBe(edgeMigrations.length);
    adapter.close();
  });

  it('applies cleanly to a FRESH brain (v1 creates, v4 rebuilds)', () => {
    const path = join(dir, 'brain.db');
    const adapter = createSqliteAdapter(path);
    adapter.runMigrations('edges', edgeMigrations);
    const db = adapter.rawConnection;
    const cols = (db.prepare('PRAGMA table_info(entity_edges)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('from_project');
    expect(cols).toContain('to_project');
    adapter.close();
  });
});

describe('edges@4 — the pre-flight ABORTS rather than migrating unprotected', () => {
  it('a false pre-flight leaves the component at the previous version', () => {
    const path = join(dir, 'brain.db');
    seedV3(path, [1, 2]);

    const refusing: Migration[] = edgeMigrations.map((m) =>
      m.version === 4 ? { ...m, pre: () => false } : m,
    );

    const adapter = createSqliteAdapter(path);
    adapter.runMigrations('edges', refusing);
    const db = adapter.rawConnection;

    // v3 applied, v4 did NOT: the table still has no qualifiers and the
    // migrations table stops at 3, so the next boot retries.
    const cols = (db.prepare('PRAGMA table_info(entity_edges)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).not.toContain('from_project');
    const max = (
      db
        .prepare("SELECT MAX(version) AS v FROM engine_migrations WHERE component='edges'")
        .get() as { v: number }
    ).v;
    expect(max).toBe(3);

    // ARM CHECK — the same runner with the REAL pre-flight does apply v4 on
    // this very database. Without this, the assertion above would also pass if
    // v4 were broken, missing, or never reached.
    adapter.runMigrations('edges', edgeMigrations);
    const colsAfter = (
      db.prepare('PRAGMA table_info(entity_edges)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(colsAfter).toContain('from_project');
    adapter.close();
  });

  it('a THROWING pre-flight is treated as a refusal, not a crash', () => {
    const path = join(dir, 'brain.db');
    seedV3(path, [1]);
    const throwing: Migration[] = edgeMigrations.map((m) =>
      m.version === 4
        ? {
            ...m,
            pre: () => {
              throw new Error('disk full');
            },
          }
        : m,
    );
    const adapter = createSqliteAdapter(path);
    expect(() => adapter.runMigrations('edges', throwing)).not.toThrow();
    const max = (
      adapter.rawConnection
        .prepare("SELECT MAX(version) AS v FROM engine_migrations WHERE component='edges'")
        .get() as { v: number }
    ).v;
    expect(max).toBe(3);
    adapter.close();
  });

  it('an in-memory brain skips the backup but still migrates', () => {
    // `:memory:` has nothing to back up — the copy could not outlive the
    // failure it protects against. It must not be a reason to refuse.
    expect(V4.pre).toBeDefined();
    const db = new Database(':memory:');
    expect(V4.pre!(db)).toBe(true);
    db.close();
  });
});
