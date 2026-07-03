/**
 * Arbiter opposition candidate-generation tests (FR-116 M2).
 *
 * Covers `buildContradictionPairs`:
 *   - same-topic (high-cosine, in the 0.80–0.995 band) + a NEGATION-polarity-XOR
 *     cue → a contradiction candidate;
 *   - antonym opposition (enable/disable) → a candidate;
 *   - a same-topic near-dupe WITHOUT any opposition cue → EXCLUDED (that is the
 *     janitor's mandate, not the arbiter's);
 *   - a near-IDENTICAL pair (cosine above the ceiling) → EXCLUDED even with a cue;
 *   - only APPROVED learnings are scanned (superseded excluded);
 *   - already-pending arbiter suggestions are excluded;
 *   - fail-soft [] when sqlite-vec is unavailable.
 *
 * Vec-gated: the cosine KNN needs the sqlite-vec binary; tests skip when absent.
 * No mocks of the SUT (L-159): `buildContradictionPairs` takes db/config/embed deps.
 *
 * @module engine/components/arbiter/__tests__/candidates.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { buildContradictionPairs, oppositionCue } from '../candidates.js';
import { DEFAULT_ARBITER_CONFIG } from '../types.js';
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

/** A unit vector at cosine 0.92 to unit(0) — inside the [0.80, 0.995] band. */
function angleVec(): Float32Array {
  const arr = new Float32Array(384);
  arr[0] = 0.92;
  arr[1] = Math.sqrt(1 - 0.92 * 0.92);
  return arr;
}

/**
 * Angle embedder: a fingerprint containing 'backoff' → angleVec (cosine 0.92 to
 * unit(0)); anything else → unit(0). For unit vectors l2ToCosine returns the dot
 * product exactly, so the KNN cosine between the two stored vectors is 0.92.
 */
async function embedAngle(text: string): Promise<Float32Array> {
  return text.includes('backoff') ? angleVec() : unit(0);
}

/** Embedder keyed on 'disable' → angleVec (0.92), else unit(0). */
async function embedDisable(text: string): Promise<Float32Array> {
  return text.includes('disable') ? angleVec() : unit(0);
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
      embedding BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function seed(db: Database.Database, id: number, title: string, content: string, reviewStatus = 'approved'): void {
  db.prepare(
    `INSERT INTO learnings (id, title, content, review_status) VALUES (?, ?, ?, ?)`,
  ).run(id, title, content, reviewStatus);
}

describe('oppositionCue — deterministic opposition signal (unit)', () => {
  const cues = DEFAULT_ARBITER_CONFIG.negation_cues;
  it('fires on negation-polarity XOR', () => {
    expect(oppositionCue('Retry', 'use retry backoff', 'Retry', 'never use retry backoff it is wrong', cues)).toContain('negation');
  });
  it('does NOT fire when both sides assert (near-dupe, no cue)', () => {
    expect(oppositionCue('Retry', 'use retry backoff', 'Retry', 'use retry backoff policy', cues)).toBeNull();
  });
  it('fires on an antonym pair (enable/disable)', () => {
    expect(oppositionCue('Cache', 'enable the cache', 'Cache', 'disable the cache', cues)).toBe('antonym');
  });
});

describe('buildContradictionPairs — opposition KNN (vec-gated)', () => {
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

  it.skipIf(!HAS_VEC)('surfaces a same-topic negation-XOR pair inside the cosine band', async () => {
    seed(db, 1, 'Retry', 'use retry policy for failed calls'); // no negation, no backoff → unit(0)
    seed(db, 2, 'Retry', 'never use retry backoff it is wrong'); // negation + backoff → angleVec (0.92)
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, angleVec());

    const pairs = await buildContradictionPairs(db, DEFAULT_ARBITER_CONFIG, { embed: embedAngle });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ from_id: 1, to_id: 2 });
    expect(pairs[0].cosine).toBeGreaterThanOrEqual(DEFAULT_ARBITER_CONFIG.contradiction_cosine_floor);
    expect(pairs[0].cosine).toBeLessThanOrEqual(DEFAULT_ARBITER_CONFIG.contradiction_cosine_ceil);
    expect(pairs[0].cue).toContain('negation');
  });

  it.skipIf(!HAS_VEC)('surfaces an antonym-opposition pair inside the band', async () => {
    seed(db, 1, 'Cache', 'enable the cache layer'); // no 'disable' → unit(0)
    seed(db, 2, 'Cache', 'disable the cache layer'); // 'disable' → angleVec (0.92)
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, angleVec());

    const pairs = await buildContradictionPairs(db, DEFAULT_ARBITER_CONFIG, { embed: embedDisable });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ from_id: 1, to_id: 2, cue: 'antonym' });
  });

  it.skipIf(!HAS_VEC)('EXCLUDES a same-topic near-dupe with no opposition cue', async () => {
    seed(db, 1, 'Retry', 'use retry backoff policy'); // backoff → angleVec, no cue
    seed(db, 2, 'Retry', 'use retry policy always'); // no backoff → unit(0), no negation cue
    insertEmbeddingInto(db, 'learnings_vec', 1, angleVec());
    insertEmbeddingInto(db, 'learnings_vec', 2, unit(0));

    const pairs = await buildContradictionPairs(db, DEFAULT_ARBITER_CONFIG, { embed: embedAngle });
    expect(pairs).toHaveLength(0); // in-band, but no negation-XOR / antonym → not the arbiter's concern
  });

  it.skipIf(!HAS_VEC)('EXCLUDES a near-identical pair above the cosine ceiling (janitor dedup territory)', async () => {
    // Both embed to unit(0) → cosine 1.0 > 0.995 ceiling, even though 2 negates.
    seed(db, 1, 'Retry', 'use retry policy');
    seed(db, 2, 'Retry', 'never use retry policy it is wrong');
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, unit(0));

    const pairs = await buildContradictionPairs(db, DEFAULT_ARBITER_CONFIG, { embed: embedAngle });
    expect(pairs).toHaveLength(0);
  });

  it.skipIf(!HAS_VEC)('excludes a superseded learning from the scan', async () => {
    seed(db, 1, 'Retry', 'use retry policy for failed calls');
    seed(db, 2, 'Retry', 'never use retry backoff it is wrong', 'superseded'); // not scanned
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, angleVec());
    const pairs = await buildContradictionPairs(db, DEFAULT_ARBITER_CONFIG, { embed: embedAngle });
    expect(pairs).toHaveLength(0);
  });

  it.skipIf(!HAS_VEC)('excludes a pair already pending as an arbiter suggestion', async () => {
    seed(db, 1, 'Retry', 'use retry policy for failed calls');
    seed(db, 2, 'Retry', 'never use retry backoff it is wrong');
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, angleVec());
    db.prepare(
      `INSERT INTO suggestions (source_module, title, evidence, priority, status, suggested_action, type_inferred)
       VALUES ('arbiter','x','{}','low','pending', ?, 1)`,
    ).run(JSON.stringify({ kind: 'resolve_contradiction', resolution: 'newer_wins', winner_id: 2, loser_id: 1 }));
    const pairs = await buildContradictionPairs(db, DEFAULT_ARBITER_CONFIG, { embed: embedAngle });
    expect(pairs).toHaveLength(0);
  });
});

describe('buildContradictionPairs — degrade when sqlite-vec is unavailable', () => {
  it('returns [] with no vec extension (fail-soft)', async () => {
    const db = new Database(':memory:');
    buildSchema(db);
    seed(db, 1, 'A', 'use retry policy');
    seed(db, 2, 'B', 'never use retry it is wrong');
    const pairs = await buildContradictionPairs(db, DEFAULT_ARBITER_CONFIG, { embed: embedAngle });
    expect(pairs).toEqual([]);
    db.close();
  });
});
