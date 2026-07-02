/**
 * Janitor near-dupe candidate-generation tests (FR-119).
 *
 * Covers `buildDuplicatePairs`:
 *   - normalized-fingerprint embedding KNN (the #930/TD-087 discipline — an
 *     INJECTED deterministic embedder stands in for generateEmbedding);
 *   - the 0.95 cosine floor excludes below-floor neighbours;
 *   - only APPROVED learnings are scanned (merged/pending excluded);
 *   - already-pending janitor merge suggestions are excluded;
 *   - sorted-id dedup + deterministic ORDER + the max_pairs cap;
 *   - fail-soft [] when sqlite-vec is unavailable.
 *
 * Vec-gated: the cosine KNN needs the sqlite-vec binary. The shared-brief
 * fallback synapse has does NOT exist here (janitor is dedup-only), so these
 * tests skip cleanly when the binary is absent.
 *
 * No mocks of the SUT (L-159): `buildDuplicatePairs` takes db/config/embed deps.
 *
 * @module engine/components/janitor/__tests__/candidates.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { buildDuplicatePairs } from '../candidates.js';
import { DEFAULT_JANITOR_CONFIG, type JanitorConfig } from '../types.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { insertEmbeddingInto } from '../../../../utils/vector-search.js';

function vecBinaryAvailable(): boolean {
  try {
    const requireCjs = createRequire(import.meta.url);
    const sqliteVec = requireCjs('sqlite-vec') as { getLoadablePath?: () => string };
    if (typeof sqliteVec.getLoadablePath === 'function') {
      const p = sqliteVec.getLoadablePath();
      return typeof p === 'string' && p.length > 0;
    }
    return true;
  } catch {
    return false;
  }
}
const HAS_VEC = vecBinaryAvailable();

function loadVec(db: Database.Database): void {
  const requireCjs = createRequire(import.meta.url);
  const sqliteVec = requireCjs('sqlite-vec') as { load: (db: Database.Database) => void };
  sqliteVec.load(db);
}

/** A unit basis vector — dim d = 1, rest 0. */
function unit(dim: number): Float32Array {
  const arr = new Float32Array(384);
  arr[dim] = 1;
  return arr;
}

/**
 * Deterministic embedder: content containing 'alpha' → unit(0), else unit(1).
 * Mirrors the stored vec geometry so a KNN over learnings_vec reproduces the
 * query's cosine exactly (this is a stand-in for generateEmbedding).
 */
async function fakeEmbed(text: string): Promise<Float32Array> {
  return text.includes('alpha') ? unit(0) : unit(1);
}

function buildSchema(db: Database.Database): void {
  for (const m of subconsciousMigrations) db.exec(m.sql);
  db.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL DEFAULT 'p',
      category TEXT NOT NULL DEFAULT 'pattern',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      review_status TEXT NOT NULL DEFAULT 'approved',
      embedding BLOB
    );
  `);
}

function seed(db: Database.Database, id: number, title: string, content: string, reviewStatus = 'approved'): void {
  db.prepare(
    `INSERT INTO learnings (id, title, content, review_status) VALUES (?, ?, ?, ?)`,
  ).run(id, title, content, reviewStatus);
}

describe('buildDuplicatePairs — near-dupe KNN (vec-gated)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    if (HAS_VEC) {
      loadVec(db);
      db.exec(`CREATE VIRTUAL TABLE learnings_vec USING vec0(embedding float[384]);`);
    }
    buildSchema(db);
  });
  afterEach(() => db.close());

  it.skipIf(!HAS_VEC)('pairs high-cosine near-dupes and excludes below-floor ones', async () => {
    seed(db, 1, 'A', 'alpha rule'); // unit(0)
    seed(db, 2, 'B', 'alpha rule restated'); // unit(0) — near-dupe of 1
    seed(db, 3, 'C', 'gamma unrelated'); // unit(1)
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 3, unit(1));

    const pairs = await buildDuplicatePairs(db, DEFAULT_JANITOR_CONFIG, { embed: fakeEmbed });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ from_id: 1, to_id: 2 });
    expect(pairs[0].cosine).toBeGreaterThanOrEqual(DEFAULT_JANITOR_CONFIG.dupe_cosine_floor);
  });

  it.skipIf(!HAS_VEC)('excludes a soft-deleted (merged) learning from the scan', async () => {
    seed(db, 1, 'A', 'alpha rule');
    seed(db, 2, 'B', 'alpha rule restated', 'merged'); // already merged → not scanned
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, unit(0));
    const pairs = await buildDuplicatePairs(db, DEFAULT_JANITOR_CONFIG, { embed: fakeEmbed });
    expect(pairs).toHaveLength(0);
  });

  it.skipIf(!HAS_VEC)('excludes a pair already pending as a janitor merge suggestion', async () => {
    seed(db, 1, 'A', 'alpha rule');
    seed(db, 2, 'B', 'alpha rule restated');
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, unit(0));
    db.prepare(
      `INSERT INTO suggestions (source_module, title, evidence, priority, status, suggested_action, type_inferred)
       VALUES ('janitor','x','{}','low','pending', ?, 1)`,
    ).run(JSON.stringify({ kind: 'merge_learnings', survivor_id: 1, duplicate_id: 2 }));
    const pairs = await buildDuplicatePairs(db, DEFAULT_JANITOR_CONFIG, { embed: fakeEmbed });
    expect(pairs).toHaveLength(0);
  });

  it.skipIf(!HAS_VEC)('does NOT exclude on a pending suggestion from a DIFFERENT source_module', async () => {
    seed(db, 1, 'A', 'alpha rule');
    seed(db, 2, 'B', 'alpha rule restated');
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, unit(0));
    db.prepare(
      `INSERT INTO suggestions (source_module, title, evidence, priority, status, suggested_action, type_inferred)
       VALUES ('edge_inference','x','{}','low','pending', ?, 1)`,
    ).run(JSON.stringify({ kind: 'add_edge', from: { id: '1' }, to: { id: '2' } }));
    const pairs = await buildDuplicatePairs(db, DEFAULT_JANITOR_CONFIG, { embed: fakeEmbed });
    expect(pairs).toHaveLength(1);
  });

  it.skipIf(!HAS_VEC)('produces a stable ordering + honours the max_pairs cap', async () => {
    for (let i = 1; i <= 4; i++) seed(db, i, `L${i}`, 'alpha shared');
    for (let i = 1; i <= 4; i++) insertEmbeddingInto(db, 'learnings_vec', i, unit(0));
    const cfg: JanitorConfig = { ...DEFAULT_JANITOR_CONFIG, top_k: 10, max_pairs: 3 };
    const a = await buildDuplicatePairs(db, cfg, { embed: fakeEmbed });
    const b = await buildDuplicatePairs(db, cfg, { embed: fakeEmbed });
    expect(a).toHaveLength(3);
    expect(a.map((p) => [p.from_id, p.to_id])).toEqual(b.map((p) => [p.from_id, p.to_id]));
  });
});

describe('buildDuplicatePairs — degrade when sqlite-vec is unavailable', () => {
  it('returns [] with no vec extension (fail-soft)', async () => {
    const db = new Database(':memory:');
    buildSchema(db);
    seed(db, 1, 'A', 'alpha');
    seed(db, 2, 'B', 'alpha');
    const pairs = await buildDuplicatePairs(db, DEFAULT_JANITOR_CONFIG, { embed: fakeEmbed });
    expect(pairs).toEqual([]);
    db.close();
  });
});
