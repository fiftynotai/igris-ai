/**
 * Synapse candidate-generation tests (FR-211).
 *
 * Covers the cheap deterministic pre-filter `buildCandidatePairs`:
 *   - shared-brief secondary signal (vec-independent, always testable);
 *   - existing-edge exclusion + pending-`edge_inference`-suggestion exclusion;
 *   - sorted-id dedup + deterministic ORDER + the max_pairs cap;
 *   - degrade-to-shared-brief when sqlite-vec is unavailable;
 *   - embedding-cosine PRIMARY signal (skipped when the vec binary is absent).
 *
 * No mocks (L-159): `buildCandidatePairs` takes the DB + config directly.
 *
 * @module engine/components/synapse/__tests__/candidates.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { buildCandidatePairs } from '../candidates.js';
import { DEFAULT_SYNAPSE_CONFIG, type SynapseConfig } from '../types.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { edgeMigrations } from '../../edges/schema.js';
import { embeddingToBuffer } from '../../../../utils/embeddings.js';
import { insertEmbeddingInto } from '../../../../utils/vector-search.js';

// ---------------------------------------------------------------------------
// sqlite-vec availability (mirrors vector-search.test.ts)
// ---------------------------------------------------------------------------

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

/** A unit basis vector — dim d = 1, rest 0. unit(a) vs unit(a) → cosine 1; unit(a) vs unit(b≠a) → cosine 0. */
function unit(dim: number): Float32Array {
  const arr = new Float32Array(384);
  arr[dim] = 1;
  return arr;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildSchema(db: Database.Database): void {
  for (const m of subconsciousMigrations) db.exec(m.sql);
  for (const m of edgeMigrations) db.exec(m.sql);
  db.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL DEFAULT 'p',
      category TEXT NOT NULL DEFAULT 'pattern',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_brief TEXT DEFAULT '',
      embedding BLOB
    );
  `);
}

function seedLearning(
  db: Database.Database,
  id: number,
  title: string,
  content: string,
  sourceBrief = '',
  embedding: Float32Array | null = null,
): void {
  db.prepare(
    `INSERT INTO learnings (id, project, category, title, content, source_brief, embedding)
     VALUES (?, 'p', 'pattern', ?, ?, ?, ?)`,
  ).run(id, title, content, sourceBrief, embedding ? embeddingToBuffer(embedding) : null);
}

// ---------------------------------------------------------------------------
// Shared-brief + exclusions + cap (vec-independent)
// ---------------------------------------------------------------------------

describe('buildCandidatePairs — shared-brief signal (vec-independent)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    buildSchema(db);
  });
  afterEach(() => db.close());

  it('pairs learnings that share a source_brief', () => {
    seedLearning(db, 1, 'A', 'alpha', 'BR-1');
    seedLearning(db, 2, 'B', 'beta', 'BR-1');
    seedLearning(db, 3, 'C', 'gamma', 'BR-9'); // different brief → no pair
    const pairs = buildCandidatePairs(db, DEFAULT_SYNAPSE_CONFIG);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ from_id: 1, to_id: 2, signal: 'shared_brief', shared_brief: 'BR-1' });
  });

  it('ignores empty source_brief (no all-pairs explosion)', () => {
    seedLearning(db, 1, 'A', 'alpha', '');
    seedLearning(db, 2, 'B', 'beta', '');
    const pairs = buildCandidatePairs(db, DEFAULT_SYNAPSE_CONFIG);
    expect(pairs).toHaveLength(0);
  });

  it('excludes a pair that already has an entity_edge (any edge_type)', () => {
    seedLearning(db, 1, 'A', 'alpha', 'BR-1');
    seedLearning(db, 2, 'B', 'beta', 'BR-1');
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
       VALUES ('learning','1','learning','2','related_to')`,
    ).run();
    const pairs = buildCandidatePairs(db, DEFAULT_SYNAPSE_CONFIG);
    expect(pairs).toHaveLength(0);
  });

  it('excludes a pair already pending as an edge_inference suggestion', () => {
    seedLearning(db, 1, 'A', 'alpha', 'BR-1');
    seedLearning(db, 2, 'B', 'beta', 'BR-1');
    db.prepare(
      `INSERT INTO suggestions (source_module, title, evidence, priority, status, suggested_action, type_inferred)
       VALUES ('edge_inference','x','{}','low','pending', ?, 1)`,
    ).run(
      JSON.stringify({
        kind: 'add_edge',
        from: { type: 'learning', id: '1' },
        to: { type: 'learning', id: '2' },
        edge_type: 'related_to',
      }),
    );
    const pairs = buildCandidatePairs(db, DEFAULT_SYNAPSE_CONFIG);
    expect(pairs).toHaveLength(0);
  });

  it('does NOT exclude on a pending suggestion from a DIFFERENT source_module', () => {
    seedLearning(db, 1, 'A', 'alpha', 'BR-1');
    seedLearning(db, 2, 'B', 'beta', 'BR-1');
    db.prepare(
      `INSERT INTO suggestions (source_module, title, evidence, priority, status, suggested_action, type_inferred)
       VALUES ('scope_drift','x','{}','low','pending', ?, 1)`,
    ).run(
      JSON.stringify({
        kind: 'add_edge',
        from: { type: 'learning', id: '1' },
        to: { type: 'learning', id: '2' },
        edge_type: 'related_to',
      }),
    );
    const pairs = buildCandidatePairs(db, DEFAULT_SYNAPSE_CONFIG);
    expect(pairs).toHaveLength(1);
  });

  it('enforces the max_pairs cap deterministically', () => {
    // 5 learnings share a brief → C(5,2) = 10 pairs; cap at 3.
    for (let i = 1; i <= 5; i++) seedLearning(db, i, `L${i}`, `c${i}`, 'BR-1');
    const cfg: SynapseConfig = { ...DEFAULT_SYNAPSE_CONFIG, max_pairs: 3 };
    const pairs = buildCandidatePairs(db, cfg);
    expect(pairs).toHaveLength(3);
    // Deterministic id order (all same signal): (1,2),(1,3),(1,4).
    expect(pairs.map((p) => [p.from_id, p.to_id])).toEqual([
      [1, 2],
      [1, 3],
      [1, 4],
    ]);
  });

  it('produces a stable ordering across repeated runs', () => {
    for (let i = 1; i <= 4; i++) seedLearning(db, i, `L${i}`, `c${i}`, 'BR-1');
    const a = buildCandidatePairs(db, DEFAULT_SYNAPSE_CONFIG);
    const b = buildCandidatePairs(db, DEFAULT_SYNAPSE_CONFIG);
    expect(a.map((p) => [p.from_id, p.to_id])).toEqual(b.map((p) => [p.from_id, p.to_id]));
  });

  it('degrades to shared-brief only when sqlite-vec is unavailable', () => {
    // Raw in-memory DB has no vec extension loaded → cosine pass is skipped.
    seedLearning(db, 1, 'A', 'alpha', 'BR-1', unit(0));
    seedLearning(db, 2, 'B', 'beta', 'BR-1', unit(0));
    const pairs = buildCandidatePairs(db, DEFAULT_SYNAPSE_CONFIG);
    // Still gets the shared-brief pair; none marked 'cosine'.
    expect(pairs.every((p) => p.signal === 'shared_brief')).toBe(true);
    expect(pairs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Embedding-cosine PRIMARY signal (requires the vec binary)
// ---------------------------------------------------------------------------

describe('buildCandidatePairs — cosine signal (vec-gated)', () => {
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

  it.skipIf(!HAS_VEC)('pairs high-cosine neighbours and excludes below-floor ones', () => {
    // 1 & 2 identical (cosine 1.0); 3 orthogonal (cosine 0.0 with 1/2).
    seedLearning(db, 1, 'A', 'alpha', '', unit(0));
    seedLearning(db, 2, 'B', 'beta', '', unit(0));
    seedLearning(db, 3, 'C', 'gamma', '', unit(1));
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 3, unit(1));

    const pairs = buildCandidatePairs(db, DEFAULT_SYNAPSE_CONFIG);
    // Only the (1,2) cosine pair clears the 0.80 floor.
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ from_id: 1, to_id: 2, signal: 'cosine' });
    expect(pairs[0].cosine).toBeGreaterThanOrEqual(DEFAULT_SYNAPSE_CONFIG.cosine_floor);
  });

  it.skipIf(!HAS_VEC)('excludes a high-cosine pair that already has an edge', () => {
    seedLearning(db, 1, 'A', 'alpha', '', unit(0));
    seedLearning(db, 2, 'B', 'beta', '', unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, unit(0));
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
       VALUES ('learning','1','learning','2','duplicates')`,
    ).run();
    const pairs = buildCandidatePairs(db, DEFAULT_SYNAPSE_CONFIG);
    expect(pairs).toHaveLength(0);
  });
});
