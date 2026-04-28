/**
 * Vector Search Round-Trip Tests — TD-051
 *
 * Verifies that insertEmbeddingInto / vectorSearchFrom / deleteEmbeddingFrom
 * correctly round-trip rows through sqlite-vec's vec0 virtual tables.
 *
 * The bug being guarded against: sqlite-vec v0.1.7 rejects plain JS numbers
 * for rowid bindings ("Only integers are allows for primary key values"),
 * silently breaking every production embedding write. The fix wraps rowid
 * in BigInt() at the binding site; these tests prove the conversion works
 * end-to-end (insert -> search -> delete) and at the integer-range boundary.
 *
 * Tests use `it.skipIf(!HAS_VEC_BINARY)` so CI runners without the optional
 * native dep stay green (mirrors db-migration-v13.test.ts).
 *
 * @module utils/__tests__/vector-search.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { migrateSchema } from '../../db.js';
import {
  insertEmbeddingInto,
  deleteEmbeddingFrom,
  vectorSearchFrom,
} from '../vector-search.js';

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

/** Deterministic 384-dim embedding (matches v13 migration test pattern). */
function makeEmbedding(seed: number): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.sin(seed * 0.1 + i * 0.001);
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vector-search round-trip — TD-051 (BigInt rowid binding)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    if (HAS_VEC_BINARY) {
      loadVec(db);
      // Run full migrations through v13 so vec tables exist on this connection.
      migrateSchema(db);
    }
  });

  afterEach(() => {
    db.close();
  });

  it.skipIf(!HAS_VEC_BINARY)(
    'insertEmbeddingInto round-trips a row into learnings_vec',
    () => {
      const before = db
        .prepare('SELECT COUNT(*) AS n FROM learnings_vec')
        .get() as { n: number };
      expect(before.n).toBe(0);

      insertEmbeddingInto(db, 'learnings_vec', 1, makeEmbedding(1));

      const after = db
        .prepare('SELECT COUNT(*) AS n FROM learnings_vec')
        .get() as { n: number };
      expect(after.n).toBe(1);
    },
  );

  it.skipIf(!HAS_VEC_BINARY)(
    'vectorSearchFrom returns the row inserted by insertEmbeddingInto',
    () => {
      const target = makeEmbedding(42);
      insertEmbeddingInto(db, 'learnings_vec', 7, target);
      // Insert a dissimilar neighbour to confirm ordering by distance.
      insertEmbeddingInto(db, 'learnings_vec', 8, makeEmbedding(9999));

      const results = vectorSearchFrom(db, 'learnings_vec', target, 5);

      expect(results.length).toBeGreaterThanOrEqual(1);
      // Closest match must be rowid 7 (zero distance against itself).
      expect(results[0].rowid).toBe(7);
      expect(results[0].distance).toBeCloseTo(0, 5);
    },
  );

  it.skipIf(!HAS_VEC_BINARY)(
    'deleteEmbeddingFrom removes the row (covers WHERE rowid = ? path)',
    () => {
      insertEmbeddingInto(db, 'learnings_vec', 11, makeEmbedding(11));
      const before = db
        .prepare('SELECT COUNT(*) AS n FROM learnings_vec')
        .get() as { n: number };
      expect(before.n).toBe(1);

      deleteEmbeddingFrom(db, 'learnings_vec', 11);

      const after = db
        .prepare('SELECT COUNT(*) AS n FROM learnings_vec')
        .get() as { n: number };
      expect(after.n).toBe(0);
    },
  );

  it.skipIf(!HAS_VEC_BINARY)(
    'handles rowid at Number.MAX_SAFE_INTEGER (proves BigInt conversion is correct)',
    () => {
      const id = Number.MAX_SAFE_INTEGER; // 9007199254740991
      const emb = makeEmbedding(123);

      // Insert at the safe-integer boundary — would explode if BigInt
      // conversion were lossy or if a plain Number were passed through.
      expect(() =>
        insertEmbeddingInto(db, 'learnings_vec', id, emb),
      ).not.toThrow();

      const rows = db
        .prepare('SELECT rowid FROM learnings_vec')
        .all() as Array<{ rowid: number | bigint }>;
      expect(rows).toHaveLength(1);
      // sqlite-vec returns rowids as BigInt for values beyond 2^31 (depending
      // on better-sqlite3 safeIntegers config). Compare via BigInt to be safe.
      expect(BigInt(rows[0].rowid)).toBe(BigInt(id));

      // Vector search should still locate the row.
      const results = vectorSearchFrom(db, 'learnings_vec', emb, 1);
      expect(results.length).toBe(1);
      expect(BigInt(results[0].rowid)).toBe(BigInt(id));

      // Delete must also accept the same id without throwing.
      expect(() =>
        deleteEmbeddingFrom(db, 'learnings_vec', id),
      ).not.toThrow();

      const after = db
        .prepare('SELECT COUNT(*) AS n FROM learnings_vec')
        .get() as { n: number };
      expect(after.n).toBe(0);
    },
  );
});
