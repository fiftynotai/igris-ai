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

/** Whitelist of allowed vec0 virtual table names */
const ALLOWED_VEC_TABLES = new Set(['learnings_vec', 'briefs_vec', 'errors_vec']);

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

// ---------------------------------------------------------------------------
// Generic helpers (work with any vec0 table name)
// ---------------------------------------------------------------------------

/**
 * Insert (or replace) an embedding into a named vec0 virtual table.
 *
 * @param db - Database connection
 * @param tableName - The vec0 table name (e.g. 'learnings_vec', 'briefs_vec')
 * @param rowid - The integer rowid for the embedding
 * @param embedding - The Float32Array embedding to store
 */
function insertEmbeddingInto(
  db: Database.Database,
  tableName: string,
  rowid: number,
  embedding: Float32Array,
): void {
  if (!ALLOWED_VEC_TABLES.has(tableName)) {
    throw new Error(`Invalid vec table name: "${tableName}"`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO ${tableName}(rowid, embedding) VALUES (?, ?)`,
  ).run(rowid, embeddingToBuffer(embedding));
}

/**
 * Delete an embedding from a named vec0 virtual table.
 *
 * @param db - Database connection
 * @param tableName - The vec0 table name
 * @param rowid - The rowid to remove
 */
function deleteEmbeddingFrom(db: Database.Database, tableName: string, rowid: number): void {
  if (!ALLOWED_VEC_TABLES.has(tableName)) {
    throw new Error(`Invalid vec table name: "${tableName}"`);
  }
  db.prepare(`DELETE FROM ${tableName} WHERE rowid = ?`).run(rowid);
}

/** Row returned by a KNN vector search */
interface VectorSearchResult {
  rowid: number;
  distance: number;
}

/**
 * Run a KNN (K-Nearest Neighbour) vector search against a named vec0 table.
 *
 * Returns the closest `limit` embeddings ordered by L2 distance
 * (ascending — smaller distance = more similar).
 *
 * @param db - Database connection
 * @param tableName - The vec0 table name
 * @param queryEmbedding - The query vector (384 dimensions)
 * @param limit - Maximum number of results (default 10)
 * @returns Array of { rowid, distance } ordered by distance ascending
 */
function vectorSearchFrom(
  db: Database.Database,
  tableName: string,
  queryEmbedding: Float32Array,
  limit: number = 10,
): VectorSearchResult[] {
  if (!ALLOWED_VEC_TABLES.has(tableName)) {
    throw new Error(`Invalid vec table name: "${tableName}"`);
  }
  return db.prepare(
    `SELECT rowid, distance FROM ${tableName} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
  ).all(embeddingToBuffer(queryEmbedding), limit) as VectorSearchResult[];
}

// ---------------------------------------------------------------------------
// Convenience wrappers for learnings_vec (backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Insert (or replace) an embedding in the learnings_vec virtual table.
 *
 * Convenience wrapper around insertEmbeddingInto for the learnings domain.
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
  insertEmbeddingInto(db, 'learnings_vec', learningId, embedding);
}

/**
 * Delete an embedding from the learnings_vec virtual table.
 *
 * Convenience wrapper around deleteEmbeddingFrom for the learnings domain.
 *
 * @param db - Database connection
 * @param learningId - The learning ID whose embedding to remove
 */
function deleteEmbedding(db: Database.Database, learningId: number): void {
  deleteEmbeddingFrom(db, 'learnings_vec', learningId);
}

/**
 * Run a KNN vector search against the learnings_vec table.
 *
 * Convenience wrapper around vectorSearchFrom for the learnings domain.
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
  return vectorSearchFrom(db, 'learnings_vec', queryEmbedding, limit);
}

export {
  isVectorSearchAvailable,
  insertEmbedding,
  deleteEmbedding,
  vectorSearch,
  insertEmbeddingInto,
  deleteEmbeddingFrom,
  vectorSearchFrom,
  ALLOWED_VEC_TABLES,
};
export type { VectorSearchResult };
