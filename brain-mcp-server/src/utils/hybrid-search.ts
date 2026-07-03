/**
 * Igris Brain — Shared Hybrid Search Utilities
 *
 * Provides Reciprocal Rank Fusion (RRF) scoring for merging BM25 and
 * vector search results. Shared across memory, briefs, and errors domains.
 *
 * Extracted from tools/memory.ts (FR-094) to enable reuse without
 * duplicating the RRF logic in each domain module.
 *
 * @module utils/hybrid-search
 * @author fifty.dev
 */

import type { VectorSearchResult } from './vector-search.js';

/** Minimum shape required for a BM25 result row in RRF merge. */
interface RankedRow {
  id: number;
}

/** An entry in the RRF-scored merged result set. */
interface RrfEntry {
  id: number;
  score: number;
  bm25_rank: number | null;
  vector_rank: number | null;
  vector_distance: number | null;
}

/**
 * Compute Reciprocal Rank Fusion (RRF) scores from two ranked lists.
 *
 * RRF formula: score(doc) = w1/(k + rank_bm25) + w2/(k + rank_vec)
 * Where rank is 1-based (first result = rank 1).
 *
 * @param bm25Rows - BM25-ranked results (position in array = rank - 1)
 * @param vecResults - Vector KNN results (position in array = rank - 1)
 * @param bm25Weight - Weight for BM25 component (default 0.5)
 * @param vectorWeight - Weight for vector component (default 0.5)
 * @param k - RRF constant (default 60)
 * @returns Merged results sorted by combined RRF score descending
 */
function computeRRF(
  bm25Rows: RankedRow[],
  vecResults: VectorSearchResult[],
  bm25Weight: number = 0.5,
  vectorWeight: number = 0.5,
  k: number = 60,
): RrfEntry[] {
  const scoreMap = new Map<number, RrfEntry>();

  // Score BM25 results
  for (let i = 0; i < bm25Rows.length; i++) {
    const id = bm25Rows[i].id;
    const rank = i + 1;
    scoreMap.set(id, {
      id,
      score: bm25Weight / (k + rank),
      bm25_rank: rank,
      vector_rank: null,
      vector_distance: null,
    });
  }

  // Score vector results and merge
  for (let i = 0; i < vecResults.length; i++) {
    const id = vecResults[i].rowid;
    const rank = i + 1;
    const existing = scoreMap.get(id);
    if (existing) {
      existing.score += vectorWeight / (k + rank);
      existing.vector_rank = rank;
      existing.vector_distance = vecResults[i].distance;
    } else {
      scoreMap.set(id, {
        id,
        score: vectorWeight / (k + rank),
        bm25_rank: null,
        vector_rank: rank,
        vector_distance: vecResults[i].distance,
      });
    }
  }

  // Sort by combined score descending
  return Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
}

/**
 * Convert L2 distance (from sqlite-vec) to cosine similarity.
 *
 * For L2-normalised vectors (unit vectors), the relationship is:
 *   cosine_similarity = 1 - (L2_distance^2 / 2)
 *
 * @param distance - L2 distance from vector search
 * @returns Cosine similarity in range [0, 1]
 */
function l2ToCosine(distance: number): number {
  return Math.max(0, 1 - (distance * distance / 2));
}

export { computeRRF, l2ToCosine };
export type { RrfEntry, RankedRow };
