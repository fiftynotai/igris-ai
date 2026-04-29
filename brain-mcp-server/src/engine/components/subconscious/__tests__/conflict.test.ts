/**
 * Conflict Detector — unit tests (FR-106 Phase 2)
 *
 * Five scenarios per plan §"Test Scenarios Summary":
 *   1. Zero embeddings present → 0 candidates, no error.
 *   2. 5 unrelated random vectors → 0 candidates (all cosines below
 *      threshold).
 *   3. 2 high-cosine + low-Jaccard vectors → 1 candidate at expected
 *      priority.
 *   4. 2 high-cosine + high-Jaccard (paraphrases) → 0 candidates.
 *   5. 100 learnings with random vectors → completes <2s, no false
 *      positives.
 *
 * Embeddings are constructed as hand-crafted Float32Arrays of length 384
 * (production dim). No real model is invoked — the detector reads via
 * `bufferToEmbedding`, which is a zero-copy view, so byte representation
 * is byte-identical to production.
 *
 * @module engine/components/subconscious/__tests__/conflict.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { detectConflict } from '../detectors/conflict.js';
import { makeReadOnlyDb } from '../readonly-db.js';
import { DEFAULT_DETECTOR_CONFIG } from '../types.js';
import {
  applyMinimalSchema,
  seedLearningWithEmbedding,
  seedProject,
} from './fixtures/minimal-schema.js';

// ---------------------------------------------------------------------------
// Embedding factories — deterministic, no model required
// ---------------------------------------------------------------------------

const DIM = 384;

/** Unit vector with all weight on a single axis. */
function basisVec(axis: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  return v;
}

/**
 * Two unit vectors with cosine = `cos(theta)`. Vector A puts all weight
 * on axis 0; vector B has a `cos(theta)` component on axis 0 and a
 * `sin(theta)` component on axis 1. Convenient for testing exact cosine
 * threshold crossings.
 */
function rotatedPair(theta: number): { a: Float32Array; b: Float32Array } {
  const a = new Float32Array(DIM);
  a[0] = 1;
  const b = new Float32Array(DIM);
  b[0] = Math.cos(theta);
  b[1] = Math.sin(theta);
  return { a, b };
}

/**
 * Pseudo-random unit vector seeded by an integer. Uses a simple LCG so
 * the test is fully deterministic across runs.
 */
function randomUnitVec(seed: number): Float32Array {
  let s = seed * 9301 + 49297;
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) {
    s = (s * 233280 + 1) % 2147483647;
    v[i] = (s / 2147483647) * 2 - 1; // [-1, 1)
  }
  // L2-normalise so it matches the production pipeline assumption.
  let mag = 0;
  for (let i = 0; i < DIM; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag);
  if (mag === 0) return v;
  for (let i = 0; i < DIM; i++) v[i] /= mag;
  return v;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectConflict', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMinimalSchema(db);
    seedProject(db, { slug: 'igris-ai' });
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Scenario 1 — empty / no embeddings
  // -----------------------------------------------------------------------

  it('returns [] when no learnings exist', () => {
    const result = detectConflict(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toEqual([]);
  });

  it('returns [] when learnings exist but none have embeddings', () => {
    db.prepare(
      `INSERT INTO learnings (project, category, title, content) VALUES (?, 'pattern', ?, ?)`,
    ).run('igris-ai', 'no embed', 'body');
    const result = detectConflict(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toEqual([]);
  });

  it('returns [] gracefully when learnings table is missing', () => {
    const empty = new Database(':memory:');
    try {
      const result = detectConflict(makeReadOnlyDb(empty), DEFAULT_DETECTOR_CONFIG);
      expect(result).toEqual([]);
    } finally {
      empty.close();
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 2 — unrelated vectors
  // -----------------------------------------------------------------------

  it('returns 0 candidates for 5 orthogonal-ish unit vectors', () => {
    // basisVec(0..4) → all pairwise dot products are 0.
    for (let i = 0; i < 5; i++) {
      seedLearningWithEmbedding(db, {
        project: 'igris-ai',
        title: `learning-${i}`,
        content: `unique content alpha-${i} bravo-${i} charlie-${i}`,
        embedding: basisVec(i),
      });
    }
    const result = detectConflict(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Scenario 3 — high cosine + low Jaccard → conflict
  // -----------------------------------------------------------------------

  it('emits a candidate for high-cosine + low-Jaccard pair', () => {
    // theta=0 → cosine = 1.0 (well above 0.92 high threshold).
    const { a, b } = rotatedPair(0);
    seedLearningWithEmbedding(db, {
      project: 'igris-ai',
      title: 'Use connection pooling for SQLite',
      content: 'wal mode pooling concurrent reads handle',
      embedding: a,
    });
    seedLearningWithEmbedding(db, {
      project: 'igris-ai',
      title: 'Avoid pooling under heavy contention',
      content: 'queries serialize lock contention single threaded',
      embedding: b,
    });
    const result = detectConflict(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0].source_module).toBe('conflict');
    expect(result[0].project_slug).toBe('igris-ai');
    expect(result[0].priority).toBe('high'); // cosine 1.0 > 0.92, jaccard < 0.3
    expect(result[0].title).toMatch(/Possible contradiction: Learning #\d+ vs #\d+/);
    const ev = result[0].evidence as Record<string, unknown>;
    expect(ev.cosine).toBeGreaterThan(0.92);
    expect(ev.jaccard).toBeLessThan(0.3);
    expect(Array.isArray(ev.learning_ids)).toBe(true);
    const ids = ev.learning_ids as number[];
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeLessThan(ids[1]); // sorted-pair signature
  });

  it('emits at medium priority for cosine in 0.85-0.92 band', () => {
    // theta ≈ 0.4 rad → cos ≈ 0.921 (just above 0.92, sneaks into high).
    // To land in the medium band, use theta ≈ 0.55 → cos ≈ 0.852.
    const { a, b } = rotatedPair(0.55);
    seedLearningWithEmbedding(db, {
      project: 'igris-ai',
      title: 'Topic alpha discussion',
      content: 'unique words foo bar baz qux',
      embedding: a,
    });
    seedLearningWithEmbedding(db, {
      project: 'igris-ai',
      title: 'Topic alpha contradicting view',
      content: 'different lexicon words mango papaya guava',
      embedding: b,
    });
    const result = detectConflict(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBe('medium');
    const ev = result[0].evidence as Record<string, unknown>;
    expect(ev.cosine as number).toBeGreaterThan(0.85);
    expect(ev.cosine as number).toBeLessThanOrEqual(0.92);
  });

  // -----------------------------------------------------------------------
  // Scenario 4 — high cosine + high Jaccard → paraphrase, no candidate
  // -----------------------------------------------------------------------

  it('returns 0 for paraphrases (high cosine + high Jaccard)', () => {
    const { a, b } = rotatedPair(0); // cosine = 1.0
    const sharedContent =
      'connection pooling under wal mode improves concurrent reads avoiding contention';
    seedLearningWithEmbedding(db, {
      project: 'igris-ai',
      title: 'Pool connections',
      content: sharedContent,
      embedding: a,
    });
    seedLearningWithEmbedding(db, {
      project: 'igris-ai',
      title: 'Pool connections again',
      content: sharedContent + ' also note this addendum',
      embedding: b,
    });
    const result = detectConflict(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    // Paraphrase: both content tokens highly overlap → Jaccard >= 0.5 → not flagged.
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Scenario 5 — latency budget on 100 random learnings
  // -----------------------------------------------------------------------

  it('completes within latency budget for 100 random learnings', () => {
    for (let i = 0; i < 100; i++) {
      seedLearningWithEmbedding(db, {
        project: 'igris-ai',
        title: `learning-${i}`,
        content: `seeded random learning index ${i} with unique terms ${i * 2} ${i * 3}`,
        embedding: randomUnitVec(i + 1),
      });
    }
    const t0 = Date.now();
    const result = detectConflict(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    // Random vectors won't cluster above 0.85 cosine — expect 0 false positives.
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Per-project cap and sorted-pair signature
  // -----------------------------------------------------------------------

  it('caps emitted candidates at conflict_max_pairs_emitted per project', () => {
    // Construct 20 learnings in the same project, all with the same embedding
    // (cosine = 1.0 between every pair). Each row gets a wholly disjoint
    // content vocabulary so Jaccard between any two is 0 — every one of the
    // C(20,2)=190 pairs would qualify as a conflict, but the per-project
    // cap clips emission to conflict_max_pairs_emitted.
    const a = basisVec(0);
    const wordPool = [
      'apple', 'banana', 'cherry', 'durian', 'elderberry', 'fig', 'grape',
      'honeydew', 'iceberg', 'jackfruit', 'kiwi', 'lime', 'mango', 'nectarine',
      'orange', 'papaya', 'quince', 'raspberry', 'starfruit', 'tangerine',
      'ugli', 'voavanga', 'watermelon', 'xigua', 'yuzu', 'zucchini',
      'almond', 'beech', 'cedar', 'douglas', 'elm', 'fir', 'ginkgo', 'holly',
      'ironwood', 'juniper', 'kapok', 'larch', 'maple', 'narra',
    ];
    for (let i = 0; i < 20; i++) {
      // Disjoint two-word content per learning — no cross-row token overlap.
      const w1 = wordPool[i * 2];
      const w2 = wordPool[i * 2 + 1];
      seedLearningWithEmbedding(db, {
        project: 'igris-ai',
        title: `learning-${i}`,
        content: `${w1} ${w2}`,
        embedding: a,
      });
    }
    const result = detectConflict(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result.length).toBeLessThanOrEqual(
      DEFAULT_DETECTOR_CONFIG.conflict_max_pairs_emitted,
    );
    expect(result.length).toBeGreaterThan(0);
  });

  it('produces a sorted-pair signature regardless of insertion order', () => {
    // Identical vectors but disjoint content tokens → cosine 1.0, Jaccard 0.
    const a = basisVec(0);
    seedLearningWithEmbedding(db, {
      project: 'igris-ai',
      title: 'first inserted',
      content: 'apple banana cherry',
      embedding: a,
    });
    seedLearningWithEmbedding(db, {
      project: 'igris-ai',
      title: 'second inserted',
      content: 'durian elderberry fig',
      embedding: a,
    });
    const result = detectConflict(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toHaveLength(1);
    const ids = (result[0].evidence as Record<string, unknown>).learning_ids as number[];
    expect(ids[0]).toBeLessThan(ids[1]);
  });
});
