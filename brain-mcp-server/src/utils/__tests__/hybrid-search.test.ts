/**
 * Shared Hybrid Search Utility Tests (FR-094)
 *
 * Tests for the extracted computeRRF function and l2ToCosine conversion.
 * These are pure logic tests -- no DB or mocking needed.
 *
 * @module utils/__tests__/hybrid-search.test
 */

import { describe, it, expect } from 'vitest';
import { computeRRF, l2ToCosine } from '../hybrid-search.js';

describe('Shared Hybrid Search Utilities — FR-094', () => {
  // -------------------------------------------------------------------------
  // computeRRF
  // -------------------------------------------------------------------------

  describe('computeRRF', () => {
    it('should merge results from both BM25 and vector lists', () => {
      const bm25 = [{ id: 1 }, { id: 2 }];
      const vec = [
        { rowid: 2, distance: 0.1 },
        { rowid: 3, distance: 0.5 },
      ];

      const results = computeRRF(bm25, vec, 0.5, 0.5, 60);

      expect(results).toHaveLength(3);
      // ID 2 appears in both, should have highest score
      expect(results[0].id).toBe(2);
      expect(results[0].bm25_rank).toBe(2);
      expect(results[0].vector_rank).toBe(1);
    });

    it('should handle empty BM25 results', () => {
      const results = computeRRF(
        [],
        [{ rowid: 1, distance: 0.1 }, { rowid: 2, distance: 0.5 }],
      );

      expect(results).toHaveLength(2);
      expect(results[0].bm25_rank).toBeNull();
      expect(results[0].vector_rank).toBe(1);
    });

    it('should handle empty vector results', () => {
      const results = computeRRF(
        [{ id: 1 }, { id: 2 }],
        [],
      );

      expect(results).toHaveLength(2);
      expect(results[0].vector_rank).toBeNull();
      expect(results[0].bm25_rank).toBe(1);
    });

    it('should handle both lists empty', () => {
      expect(computeRRF([], [])).toHaveLength(0);
    });

    it('should respect weight parameters', () => {
      const bm25 = [{ id: 1 }];
      const vec = [{ rowid: 2, distance: 0.1 }];

      // BM25 weight = 1.0, vector weight = 0
      const bm25Only = computeRRF(bm25, vec, 1.0, 0.0, 60);
      expect(bm25Only[0].id).toBe(1);
      expect(bm25Only[0].score).toBeGreaterThan(0);
      expect(bm25Only[1].score).toBe(0);

      // BM25 weight = 0, vector weight = 1.0
      const vecOnly = computeRRF(bm25, vec, 0.0, 1.0, 60);
      expect(vecOnly[0].id).toBe(2);
      expect(vecOnly[0].score).toBeGreaterThan(0);
      expect(vecOnly[1].score).toBe(0);
    });

    it('should use default weights of 0.5/0.5', () => {
      const bm25 = [{ id: 1 }];
      const vec = [{ rowid: 1, distance: 0.1 }];

      const results = computeRRF(bm25, vec);

      // With default weights (0.5, 0.5) and k=60:
      // score = 0.5/(60+1) + 0.5/(60+1) = 1/(61)
      expect(results[0].score).toBeCloseTo(1 / 61, 6);
    });

    it('should sort by score descending', () => {
      const bm25 = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const vec = [
        { rowid: 3, distance: 0.1 },
        { rowid: 1, distance: 0.5 },
      ];

      const results = computeRRF(bm25, vec, 0.5, 0.5, 60);

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('should use custom k constant', () => {
      const bm25 = [{ id: 1 }];
      const vec: { rowid: number; distance: number }[] = [];

      const k10 = computeRRF(bm25, vec, 1.0, 0, 10);
      const k100 = computeRRF(bm25, vec, 1.0, 0, 100);

      // Smaller k = higher score for top ranks
      expect(k10[0].score).toBeGreaterThan(k100[0].score);
    });

    it('should record vector_distance from vector results', () => {
      const vec = [{ rowid: 1, distance: 0.42 }];
      const results = computeRRF([], vec);

      expect(results[0].vector_distance).toBeCloseTo(0.42);
    });
  });

  // -------------------------------------------------------------------------
  // l2ToCosine
  // -------------------------------------------------------------------------

  describe('l2ToCosine', () => {
    it('should return 1.0 for distance 0 (identical vectors)', () => {
      expect(l2ToCosine(0)).toBe(1.0);
    });

    it('should return 0.5 for distance 1.0', () => {
      // cosine_sim = 1 - (1^2 / 2) = 1 - 0.5 = 0.5
      expect(l2ToCosine(1.0)).toBeCloseTo(0.5, 6);
    });

    it('should return 0 for distance sqrt(2) (orthogonal unit vectors)', () => {
      // cosine_sim = 1 - (2 / 2) = 0
      expect(l2ToCosine(Math.sqrt(2))).toBeCloseTo(0, 6);
    });

    it('should clamp to 0 for distances beyond sqrt(2)', () => {
      // For distance = 2, formula gives 1 - (4/2) = -1, but clamped to 0
      expect(l2ToCosine(2)).toBe(0);
    });

    it('should handle small distances correctly', () => {
      // distance = 0.1, cosine = 1 - 0.005 = 0.995
      expect(l2ToCosine(0.1)).toBeCloseTo(0.995, 3);
    });
  });
});
