/**
 * Migration v13 Tests — TD-050
 *
 * Verifies the vec0 backfill migration:
 *   1. Real-load happy path: vec tables and triggers exist after migrations.
 *   2. Backfill: pre-seeded BLOB embeddings end up in the vec tables.
 *   3. Skip-without-recording: when vec is unavailable, schema_version stays
 *      at 12 so the next boot retries (the inverse of the v10/v11 bug).
 *   4. Idempotency: running migrations twice does not duplicate or error.
 *   5. Corrupt-row resilience: malformed embeddings are skipped, not fatal.
 *
 * Tests that depend on the native sqlite-vec binary use `it.skipIf` so CI
 * runners without the optional dep remain green.
 *
 * @module __tests__/db-migration-v13.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { migrateSchema } from '../db.js';

// ---------------------------------------------------------------------------
// Native binary detection (mirrors src/engine/storage/__tests__/sqlite-vec.test.ts)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load sqlite-vec into a connection. Throws if the binary isn't available. */
function loadVec(db: Database.Database): void {
  const requireCjs = createRequire(import.meta.url);
  const sqliteVec = requireCjs('sqlite-vec') as {
    load: (db: Database.Database) => void;
  };
  sqliteVec.load(db);
}

/** Create a 384-dim Float32Array filled with a deterministic pattern. */
function makeEmbedding(seed: number): Buffer {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.sin(seed * 0.1 + i * 0.001);
  }
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Pre-seed the parent tables (learnings, errors, brief_status) with rows
 *  that have BLOB embeddings, simulating a DB that had embeddings written
 *  while the vec tables were missing (the live brain DB scenario). */
function seedParentTables(
  db: Database.Database,
  counts: { learnings: number; errors: number; briefs: number },
  malformed = false,
): void {
  // brief_status has a FK to projects(slug). Even when seeding briefs:0 the
  // statement is harmless, but for any non-zero brief count we need a project.
  if (counts.briefs > 0) {
    db.prepare(
      `INSERT OR IGNORE INTO projects (slug, name, path) VALUES ('test', 'test', '/tmp/test')`,
    ).run();
  }

  const insLearning = db.prepare(
    `INSERT INTO learnings (project, category, title, content, embedding, embedding_model)
     VALUES (?, 'pattern', ?, ?, ?, 'test-model')`,
  );
  for (let i = 0; i < counts.learnings; i++) {
    const blob = malformed && i === 0 ? Buffer.alloc(100) : makeEmbedding(i + 1);
    insLearning.run('test', `t${i}`, `c${i}`, blob);
  }

  const insError = db.prepare(
    `INSERT INTO errors (project, fingerprint, message, embedding, embedding_model)
     VALUES (?, ?, ?, ?, 'test-model')`,
  );
  for (let i = 0; i < counts.errors; i++) {
    insError.run('test', `fp${i}`, `msg${i}`, makeEmbedding(100 + i));
  }

  const insBrief = db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status, embedding, embedding_model)
     VALUES (?, ?, ?, 'open', ?, 'test-model')`,
  );
  for (let i = 0; i < counts.briefs; i++) {
    insBrief.run('test', `BR-${i}`, `title${i}`, makeEmbedding(200 + i));
  }
}

/** Roll the schema forward to v12 by running migrateSchema on a connection
 *  WITHOUT vec loaded. This reproduces the live-DB state (v12 + missing
 *  vec tables) before v13 runs. */
function migrateToV12WithoutVec(db: Database.Database): void {
  // No vec loaded. migrateSchema will run v1-v12 (vec gates skip silently)
  // and STOP at v12 if vec is unavailable on the connection.
  // We need to halt v13 — easiest way is to advance schema_version past 12
  // before calling migrate, but we want migrate to actually create v1-v12
  // tables. So: run migrate, then expect v13 to skip-without-recording.
  migrateSchema(db);
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(name);
  return !!row;
}

function triggerExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name = ?")
    .get(name);
  return !!row;
}

function getSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null };
  return row.v ?? 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migration v13 — vec0 backfill (TD-050)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it.skipIf(!HAS_VEC_BINARY)(
    'creates vec tables and triggers when vec is loaded on the connection',
    () => {
      loadVec(db);
      migrateSchema(db);

      expect(tableExists(db, 'learnings_vec')).toBe(true);
      expect(tableExists(db, 'errors_vec')).toBe(true);
      expect(tableExists(db, 'briefs_vec')).toBe(true);

      expect(triggerExists(db, 'learnings_vec_ad')).toBe(true);
      expect(triggerExists(db, 'errors_vec_ad')).toBe(true);
      expect(triggerExists(db, 'briefs_vec_ad')).toBe(true);

      expect(getSchemaVersion(db)).toBe(13);
    },
  );

  it.skipIf(!HAS_VEC_BINARY)(
    'backfills existing BLOB embeddings into the vec tables',
    () => {
      // First boot WITHOUT vec — reproduces the live brain DB state where
      // v10/v11 ran but the vec creation paths silently skipped, then
      // application code stored BLOB embeddings in the parent tables.
      migrateSchema(db);
      // schema is at v12, no vec tables, no v13 row recorded.
      expect(getSchemaVersion(db)).toBe(12);
      expect(tableExists(db, 'learnings_vec')).toBe(false);

      // Application code runs and writes embeddings into BLOB columns.
      seedParentTables(db, { learnings: 3, errors: 2, briefs: 1 });

      // Second boot WITH vec — v13 should run, create tables, and backfill.
      loadVec(db);
      migrateSchema(db);

      expect(getSchemaVersion(db)).toBe(13);

      const learningsCount = db
        .prepare('SELECT COUNT(*) AS n FROM learnings_vec')
        .get() as { n: number };
      const errorsCount = db
        .prepare('SELECT COUNT(*) AS n FROM errors_vec')
        .get() as { n: number };
      const briefsCount = db
        .prepare('SELECT COUNT(*) AS n FROM briefs_vec')
        .get() as { n: number };

      expect(learningsCount.n).toBe(3);
      expect(errorsCount.n).toBe(2);
      expect(briefsCount.n).toBe(1);

      // Rowid mapping: parent.id → vec.rowid
      const ids = db
        .prepare('SELECT rowid FROM learnings_vec ORDER BY rowid')
        .all() as Array<{ rowid: number }>;
      expect(ids.map((r) => r.rowid)).toEqual([1, 2, 3]);
    },
  );

  it('skips v13 without recording when vec is unavailable on the connection', () => {
    // No vec loaded — migrate runs v1-v12, v13 must skip and NOT advance
    // schema_version. Next boot (with vec) will retry.
    migrateToV12WithoutVec(db);

    expect(getSchemaVersion(db)).toBe(12);
    expect(tableExists(db, 'learnings_vec')).toBe(false);
    expect(tableExists(db, 'errors_vec')).toBe(false);
    expect(tableExists(db, 'briefs_vec')).toBe(false);

    // Re-running migrations without vec must remain at v12 — no infinite
    // loop, no error, just a stable skip.
    migrateSchema(db);
    expect(getSchemaVersion(db)).toBe(12);
  });

  it.skipIf(!HAS_VEC_BINARY)(
    'recovers on next boot when vec becomes available (skip-then-heal)',
    () => {
      // Boot 1: no vec — schema stops at v12.
      migrateSchema(db);
      expect(getSchemaVersion(db)).toBe(12);
      expect(tableExists(db, 'learnings_vec')).toBe(false);

      // Boot 2: vec loaded — v13 finally runs.
      loadVec(db);
      migrateSchema(db);

      expect(getSchemaVersion(db)).toBe(13);
      expect(tableExists(db, 'learnings_vec')).toBe(true);
      expect(tableExists(db, 'errors_vec')).toBe(true);
      expect(tableExists(db, 'briefs_vec')).toBe(true);
    },
  );

  it.skipIf(!HAS_VEC_BINARY)(
    'is idempotent — running migrations twice does not duplicate or error',
    () => {
      loadVec(db);
      migrateSchema(db);
      seedParentTables(db, { learnings: 2, errors: 0, briefs: 0 });

      // Manually backfill once (simulates v13 already having run).
      // Then run migrate again — must be a no-op (currentVersion >= 13).
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO learnings_vec(rowid, embedding) VALUES (?, ?)',
      );
      // sqlite-vec requires BigInt rowid binding (see migration v13 comment).
      stmt.run(1n, makeEmbedding(1));
      stmt.run(2n, makeEmbedding(2));

      const before = db
        .prepare('SELECT COUNT(*) AS n FROM learnings_vec')
        .get() as { n: number };
      expect(before.n).toBe(2);

      // Second migrate call — already at v13, should be a no-op.
      expect(() => migrateSchema(db)).not.toThrow();

      const after = db
        .prepare('SELECT COUNT(*) AS n FROM learnings_vec')
        .get() as { n: number };
      expect(after.n).toBe(2);
      expect(getSchemaVersion(db)).toBe(13);
    },
  );

  it.skipIf(!HAS_VEC_BINARY)(
    'skips malformed embedding rows but backfills the rest',
    () => {
      // Roll forward to v12 without vec, seed with a corrupt row + good rows,
      // then load vec and run v13.
      migrateSchema(db);
      seedParentTables(db, { learnings: 3, errors: 0, briefs: 0 }, /*malformed*/ true);

      loadVec(db);
      migrateSchema(db);

      expect(getSchemaVersion(db)).toBe(13);

      // 3 rows seeded, row 0 had a malformed (100-byte) embedding → skipped.
      // Other 2 must still be backfilled.
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM learnings_vec')
        .get() as { n: number };
      expect(count.n).toBe(2);

      // The skipped row's id is 1 (first inserted). It must NOT appear.
      const rows = db
        .prepare('SELECT rowid FROM learnings_vec ORDER BY rowid')
        .all() as Array<{ rowid: number }>;
      expect(rows.map((r) => r.rowid)).toEqual([2, 3]);
    },
  );
});
