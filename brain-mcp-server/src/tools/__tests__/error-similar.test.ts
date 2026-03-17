/**
 * Error Similarity Tests (FR-094)
 *
 * Tests for:
 * 1. handleErrorSimilar — hybrid BM25 + vector search for errors
 * 2. handleErrorLookup — auto-embed on store
 * 3. handleErrorBackfillEmbeddings
 *
 * @module tools/__tests__/error-similar.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module mocks — declared before imports
// ---------------------------------------------------------------------------

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

// Mock embedding utilities
vi.mock('../../utils/embeddings.js', () => {
  function fakeEmbedding(text: string): Float32Array {
    const arr = new Float32Array(384);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < 384; i++) {
      hash = ((hash << 5) - hash + i) | 0;
      arr[i] = (hash & 0xffff) / 0xffff;
    }
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < 384; i++) arr[i] /= norm;
    return arr;
  }

  return {
    generateEmbedding: vi.fn(async (text: string) => fakeEmbedding(text)),
    embeddingToBuffer: vi.fn((embedding: Float32Array) =>
      Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
    ),
    EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
    EMBEDDING_DIMENSIONS: 384,
  };
});

// Mock vector-search utilities
let _vecAvailable = false;
const _errorVecStore = new Map<number, Buffer>();

vi.mock('../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => _vecAvailable),
  insertEmbeddingInto: vi.fn((_db: unknown, _table: string, id: number, embedding: Float32Array) => {
    _errorVecStore.set(id, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
  }),
  vectorSearchFrom: vi.fn((_db: unknown, _table: string, _embedding: Float32Array, limit: number) => {
    return Array.from(_errorVecStore.entries())
      .map(([rowid]) => ({ rowid, distance: rowid * 0.1 }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }),
  insertEmbedding: vi.fn(),
  deleteEmbedding: vi.fn(),
  vectorSearch: vi.fn(() => []),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../db.js';
import {
  handleErrorLookup,
  handleErrorSimilar,
  handleErrorBackfillEmbeddings,
} from '../errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockedGetDb = vi.mocked(getDb);

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      message TEXT NOT NULL,
      solution TEXT DEFAULT '',
      context TEXT DEFAULT '',
      tech_stack TEXT DEFAULT '',
      scope TEXT DEFAULT 'local' CHECK (scope IN ('local', 'global')),
      occurrence_count INTEGER DEFAULT 1,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      embedding BLOB,
      embedding_model TEXT DEFAULT ''
    );

    CREATE VIRTUAL TABLE errors_fts USING fts5(
      message, solution, context,
      content=errors,
      content_rowid=id
    );

    CREATE TRIGGER errors_ai AFTER INSERT ON errors BEGIN
      INSERT INTO errors_fts(rowid, message, solution, context)
      VALUES (new.id, new.message, new.solution, new.context);
    END;

    CREATE TRIGGER errors_au AFTER UPDATE ON errors BEGIN
      INSERT INTO errors_fts(errors_fts, rowid, message, solution, context)
      VALUES ('delete', old.id, old.message, old.solution, old.context);
      INSERT INTO errors_fts(rowid, message, solution, context)
      VALUES (new.id, new.message, new.solution, new.context);
    END;

    CREATE TRIGGER errors_ad AFTER DELETE ON errors BEGIN
      INSERT INTO errors_fts(errors_fts, rowid, message, solution, context)
      VALUES ('delete', old.id, old.message, old.solution, old.context);
    END;

    CREATE INDEX idx_errors_project ON errors(project);
    CREATE INDEX idx_errors_fingerprint ON errors(fingerprint);
  `);

  return db;
}

function insertError(
  db: Database.Database,
  overrides: Partial<{
    project: string;
    fingerprint: string;
    message: string;
    solution: string;
    context: string;
    embedding: Buffer | null;
    embedding_model: string;
  }> = {},
): number {
  const defaults = {
    project: 'test-project',
    fingerprint: 'fp-default',
    message: 'Test error message',
    solution: 'Test solution',
    context: '',
    embedding: null as Buffer | null,
    embedding_model: '',
  };
  const data = { ...defaults, ...overrides };
  const result = db.prepare(`
    INSERT INTO errors (project, fingerprint, message, solution, context, embedding, embedding_model)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(data.project, data.fingerprint, data.message, data.solution, data.context, data.embedding, data.embedding_model);
  return result.lastInsertRowid as number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Error Similarity — FR-094', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
    _vecAvailable = false;
    _errorVecStore.clear();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. handleErrorSimilar
  // -------------------------------------------------------------------------

  describe('handleErrorSimilar', () => {
    it('should return BM25-only results when vector search is unavailable', async () => {
      _vecAvailable = false;

      insertError(db, {
        message: 'TypeError: Cannot read property of undefined',
        solution: 'Check for null before accessing property',
        fingerprint: 'fp-type-1',
      });

      const result = await handleErrorSimilar({
        message: 'TypeError Cannot read property undefined',
      });

      const text = result.content[0].text;
      expect(text).toContain('bm25-only');
      expect(text).toContain('TypeError');
    });

    it('should return hybrid results when vector search is available', async () => {
      _vecAvailable = true;

      const id = insertError(db, {
        message: 'Connection refused ECONNREFUSED',
        solution: 'Check if the service is running',
        fingerprint: 'fp-conn-1',
      });
      _errorVecStore.set(id, Buffer.alloc(384 * 4));

      const result = await handleErrorSimilar({
        message: 'Connection refused',
      });

      const text = result.content[0].text;
      expect(text).toContain('hybrid');
    });

    it('should return no results for non-matching query', async () => {
      _vecAvailable = false;

      const result = await handleErrorSimilar({
        message: 'xyznonexistent',
      });

      expect(result.content[0].text).toContain('No similar errors found');
    });

    it('should filter by project when include_cross_project is false', async () => {
      _vecAvailable = false;

      insertError(db, {
        project: 'project-a',
        message: 'Unique error in project A for testing cross-project filter',
        solution: 'Fix A',
        fingerprint: 'fp-a',
      });
      insertError(db, {
        project: 'project-b',
        message: 'Unique error in project B for testing cross-project filter',
        solution: 'Fix B',
        fingerprint: 'fp-b',
      });

      const result = await handleErrorSimilar({
        message: 'error testing cross-project filter',
        project: 'project-a',
        include_cross_project: false,
      });

      const text = result.content[0].text;
      expect(text).toContain('project-a');
      expect(text).not.toContain('project-b');
    });

    it('should include cross-project results by default', async () => {
      _vecAvailable = false;

      insertError(db, {
        project: 'project-a',
        message: 'Shared error message across projects for testing',
        solution: 'Fix shared',
        fingerprint: 'fp-shared',
      });
      insertError(db, {
        project: 'project-b',
        message: 'Shared error message across projects for testing again',
        solution: 'Fix shared B',
        fingerprint: 'fp-shared-b',
      });

      const result = await handleErrorSimilar({
        message: 'Shared error message across projects testing',
        project: 'project-a',
      });

      const text = result.content[0].text;
      // Default include_cross_project = true, so project-b should appear
      expect(text).toContain('project-b');
    });

    it('should respect limit parameter', async () => {
      _vecAvailable = false;

      for (let i = 1; i <= 5; i++) {
        insertError(db, {
          message: `Error limit test number ${i} for pagination`,
          solution: `Solution ${i}`,
          fingerprint: `fp-limit-${i}`,
        });
      }

      const result = await handleErrorSimilar({
        message: 'Error limit test number pagination',
        limit: 2,
      });

      const matches = result.content[0].text.match(/--- Match/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeLessThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // 2. handleErrorLookup — auto-embed on store
  // -------------------------------------------------------------------------

  describe('handleErrorLookup — auto-embed', () => {
    it('should auto-embed when storing a new error with solution', async () => {
      _vecAvailable = true;

      const result = await handleErrorLookup({
        project: 'test-project',
        message: 'New error for embedding test',
        solution: 'Fix by checking inputs',
      });

      const text = result.content[0].text;
      expect(text).toContain('Error solution stored');
      expect(text).toContain('Embedding: generated');
    });

    it('should auto-embed when updating an existing error', async () => {
      _vecAvailable = true;

      // First, store the error
      await handleErrorLookup({
        project: 'test-project',
        message: 'Existing error for update test',
        solution: 'Original fix',
      });

      // Update it
      const result = await handleErrorLookup({
        project: 'test-project',
        message: 'Existing error for update test',
        solution: 'Better fix',
      });

      const text = result.content[0].text;
      expect(text).toContain('Error solution updated');
      expect(text).toContain('Embedding: updated');
    });

    it('should store error without embedding when vec is unavailable', async () => {
      _vecAvailable = false;

      const result = await handleErrorLookup({
        project: 'test-project',
        message: 'Error without vec',
        solution: 'Fix it',
      });

      const text = result.content[0].text;
      expect(text).toContain('Error solution stored');
      expect(text).not.toContain('Embedding:');
    });
  });

  // -------------------------------------------------------------------------
  // 3. handleErrorBackfillEmbeddings
  // -------------------------------------------------------------------------

  describe('handleErrorBackfillEmbeddings', () => {
    it('should skip when sqlite-vec is not available', async () => {
      _vecAvailable = false;

      const result = await handleErrorBackfillEmbeddings({});

      expect(result.content[0].text).toContain('sqlite-vec extension is not available');
    });

    it('should process errors without embeddings', async () => {
      _vecAvailable = true;

      insertError(db, {
        message: 'Backfill target error',
        solution: 'Fix for backfill',
        embedding: null,
      });

      const result = await handleErrorBackfillEmbeddings({ batch_size: 10 });

      expect(result.content[0].text).toContain('Processed: 1');
    });

    it('should skip errors without solutions', async () => {
      _vecAvailable = true;

      insertError(db, {
        message: 'Error without solution',
        solution: '',
        embedding: null,
      });

      const result = await handleErrorBackfillEmbeddings({ batch_size: 10 });

      // Should report all-done since no errors with solutions need embedding
      expect(result.content[0].text).toContain('already have embeddings');
    });

    it('should report all-done when no errors need embedding', async () => {
      _vecAvailable = true;

      insertError(db, {
        message: 'Already embedded',
        solution: 'Fix',
        embedding: Buffer.alloc(384 * 4),
        embedding_model: 'model',
      });

      const result = await handleErrorBackfillEmbeddings({});

      expect(result.content[0].text).toContain('already have embeddings');
    });

    it('should filter by project', async () => {
      _vecAvailable = true;

      insertError(db, {
        project: 'project-a',
        message: 'Error A',
        solution: 'Fix A',
        fingerprint: 'fp-backfill-a',
        embedding: null,
      });
      insertError(db, {
        project: 'project-b',
        message: 'Error B',
        solution: 'Fix B',
        fingerprint: 'fp-backfill-b',
        embedding: null,
      });

      const result = await handleErrorBackfillEmbeddings({ project: 'project-a', batch_size: 10 });

      expect(result.content[0].text).toContain('Processed: 1');
      expect(result.content[0].text).toContain('Remaining: 0');
    });

    it('should respect batch_size limit', async () => {
      _vecAvailable = true;

      for (let i = 0; i < 5; i++) {
        insertError(db, {
          message: `Batch error ${i}`,
          solution: `Fix ${i}`,
          fingerprint: `fp-batch-${i}`,
          embedding: null,
        });
      }

      const result = await handleErrorBackfillEmbeddings({ batch_size: 2 });

      expect(result.content[0].text).toContain('Processed: 2');
      expect(result.content[0].text).toContain('Remaining: 3');
    });
  });
});
