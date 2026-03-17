/**
 * Igris Brain — Vector Search Wrapper
 *
 * Thin abstraction over sqlite-vec's vec0 virtual table for vector
 * similarity search on learning embeddings.
 *
 * Provides:
 * - isVectorSearchAvailable(db): boolean — runtime check for sqlite-vec
 * - insertEmbedding(db, id, embedding): void — upsert into learnings_vec
 * - deleteEmbedding(db, id): void — remove from learnings_vec
 * - vectorSearch(db, queryEmbedding, limit): { rowid, distance }[]
 *
 * @module utils/vector-search
 * @author Fifty.ai
 */

import type Database from 'better-sqlite3';
import { embeddingToBuffer } from './embeddings.js';

/**
 * Check whether sqlite-vec is available on the given connection.
 *
 * Runs `SELECT vec_version()` — if it succeeds, the extension is loaded.
 *
 * @param db - The database connection to test
 * @returns true if sqlite-vec functions are available
 */
function isVectorSearchAvailable(db: Database.Database): boolean {
  try {
    db.prepare('SELECT vec_version()').get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Insert (or replace) an embedding in the learnings_vec virtual table.
 *
 * The rowid must correspond to a learnings.id for the cleanup trigger
 * to work correctly on DELETE.
 *
 * @param db - Database connection
 * @param learningId - The learning ID (becomes the vec table rowid)
 * @param embedding - The Float32Array embedding to store
 */
function insertEmbedding(
  db: Database.Database,
  learningId: number,
  embedding: Float32Array,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO learnings_vec(rowid, embedding) VALUES (?, ?)',
  ).run(learningId, embeddingToBuffer(embedding));
}

/**
 * Delete an embedding from the learnings_vec virtual table.
 *
 * Note: There is also an AFTER DELETE trigger on the learnings table
 * that handles this automatically. This function is provided for
 * explicit cleanup when needed outside of a DELETE cascade.
 *
 * @param db - Database connection
 * @param learningId - The learning ID whose embedding to remove
 */
function deleteEmbedding(db: Database.Database, learningId: number): void {
  db.prepare('DELETE FROM learnings_vec WHERE rowid = ?').run(learningId);
}

/** Row returned by a KNN vector search */
interface VectorSearchResult {
  rowid: number;
  distance: number;
}

/**
 * Run a KNN (K-Nearest Neighbour) vector search.
 *
 * Returns the closest `limit` embeddings ordered by L2 distance
 * (ascending — smaller distance = more similar).
 *
 * @param db - Database connection
 * @param queryEmbedding - The query vector (384 dimensions)
 * @param limit - Maximum number of results (default 10)
 * @returns Array of { rowid, distance } ordered by distance ascending
 */
function vectorSearch(
  db: Database.Database,
  queryEmbedding: Float32Array,
  limit: number = 10,
): VectorSearchResult[] {
  return db.prepare(
    'SELECT rowid, distance FROM learnings_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
  ).all(embeddingToBuffer(queryEmbedding), limit) as VectorSearchResult[];
}

export {
  isVectorSearchAvailable,
  insertEmbedding,
  deleteEmbedding,
  vectorSearch,
};
export type { VectorSearchResult };
