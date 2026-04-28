/**
 * Hybrid Search Tests (FR-093)
 *
 * Tests for:
 * 1. RRF scoring computation
 * 2. Hybrid search tool (BM25 + vector fallback)
 * 3. Auto-embed on store
 * 4. Backfill embeddings tool
 * 5. Buffer conversion utilities
 * 6. Vector search available check
 *
 * Note: Tests that require actual embedding generation or sqlite-vec
 * are marked with a longer timeout. Tests for pure logic (RRF, buffer
 * conversion) run instantly.
 *
 * @module tools/__tests__/hybrid-search.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module mocks — declared before imports
// ---------------------------------------------------------------------------

const { fakeEmbedding } = vi.hoisted(() => {
  // Hoisted copy of fakeEmbedding from test-helpers.ts for use in vi.mock() factories
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
  return { fakeEmbedding };
});

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

// Mock embedding utilities — avoid loading the actual HF model in tests
vi.mock('../../utils/embeddings.js', () => {
  return {
    generateEmbedding: vi.fn(async (text: string) => fakeEmbedding(text)),
    embeddingToBuffer: vi.fn((embedding: Float32Array) =>
      Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
    ),
    bufferToEmbedding: vi.fn((buf: Buffer) =>
      new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
    ),
    isEmbeddingAvailable: vi.fn(() => true),
    processInBatches: vi.fn(async (items: unknown[], fn: (item: unknown) => Promise<void>) => {
      let succeeded = 0;
      let failed = 0;
      for (const item of items) {
        try {
          await fn(item);
          succeeded++;
        } catch {
          failed++;
        }
      }
      return { succeeded, failed };
    }),
    EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
    EMBEDDING_DIMENSIONS: 384,
  };
});

// Mock vector-search utilities — sqlite-vec is not available in test :memory: DBs
let _vecAvailable = false;
const _vecStore = new Map<number, Buffer>();

vi.mock('../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => _vecAvailable),
  insertEmbedding: vi.fn((_db: unknown, id: number, embedding: Float32Array) => {
    _vecStore.set(id, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
  }),
  deleteEmbedding: vi.fn((_db: unknown, id: number) => {
    _vecStore.delete(id);
  }),
  vectorSearch: vi.fn((_db: unknown, _queryEmbedding: Float32Array, limit: number) => {
    // Return stored embeddings sorted by rowid (fake distance = rowid * 0.1)
    const entries = Array.from(_vecStore.entries())
      .map(([rowid]) => ({ rowid, distance: rowid * 0.1 }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
    return entries;
  }),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../db.js';
import {
  handleMemoryStore,
  handleMemoryHybridSearch,
  handleMemoryBackfillEmbeddings,
} from '../memory.js';
import { computeRRF } from '../../utils/hybrid-search.js';
import { embeddingToBuffer, bufferToEmbedding } from '../../utils/embeddings.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockedGetDb = vi.mocked(getDb);

/** Create an in-memory database with the learnings tables and FTS5. */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('pattern', 'decision', 'discovery', 'mistake', 'optimization')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      tech_stack TEXT DEFAULT '',
      scope TEXT DEFAULT 'local' CHECK (scope IN ('local', 'global')),
      source_brief TEXT DEFAULT '',
      confidence REAL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT,
      embedding BLOB,
      embedding_model TEXT DEFAULT '',
      provenance TEXT NOT NULL DEFAULT 'observed'
        CHECK(provenance IN ('observed','inferred','synthesized','ambiguous','human_asserted'))
    );

    CREATE VIRTUAL TABLE learnings_fts USING fts5(
      title, content, tags, tech_stack,
      content=learnings,
      content_rowid=id
    );

    CREATE TRIGGER learnings_ai AFTER INSERT ON learnings BEGIN
      INSERT INTO learnings_fts(rowid, title, content, tags, tech_stack)
      VALUES (new.id, new.title, new.content, new.tags, new.tech_stack);
    END;

    CREATE TRIGGER learnings_au AFTER UPDATE ON learnings BEGIN
      INSERT INTO learnings_fts(learnings_fts, rowid, title, content, tags, tech_stack)
      VALUES ('delete', old.id, old.title, old.content, old.tags, old.tech_stack);
      INSERT INTO learnings_fts(rowid, title, content, tags, tech_stack)
      VALUES (new.id, new.title, new.content, new.tags, new.tech_stack);
    END;

    CREATE TRIGGER learnings_ad AFTER DELETE ON learnings BEGIN
      INSERT INTO learnings_fts(learnings_fts, rowid, title, content, tags, tech_stack)
      VALUES ('delete', old.id, old.title, old.content, old.tags, old.tech_stack);
    END;
  `);

  return db;
}

/** Insert a learning directly into the test database. */
function insertLearning(
  db: Database.Database,
  overrides: Partial<{
    project: string;
    category: string;
    title: string;
    content: string;
    tags: string;
    tech_stack: string;
    scope: string;
    source_brief: string;
    confidence: number;
    access_count: number;
    embedding: Buffer | null;
    embedding_model: string;
  }> = {},
): number {
  const defaults = {
    project: 'test-project',
    category: 'pattern',
    title: 'Test Learning',
    content: 'This is test content for a learning entry.',
    tags: 'test',
    tech_stack: 'typescript',
    scope: 'local',
    source_brief: '',
    confidence: 0.8,
    access_count: 0,
    embedding: null as Buffer | null,
    embedding_model: '',
  };
  const data = { ...defaults, ...overrides };
  const stmt = db.prepare(`
    INSERT INTO learnings (project, category, title, content, tags, tech_stack, scope,
                           source_brief, confidence, access_count, embedding, embedding_model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.project, data.category, data.title, data.content,
    data.tags, data.tech_stack, data.scope, data.source_brief,
    data.confidence, data.access_count, data.embedding, data.embedding_model,
  );
  return result.lastInsertRowid as number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Hybrid Search — FR-093', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
    _vecAvailable = false;
    _vecStore.clear();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. RRF Scoring
  // -------------------------------------------------------------------------

  describe('computeRRF', () => {
    it('should compute RRF scores for results appearing in both lists', () => {
      const bm25Rows = [
        { id: 1, rank: -5 } as unknown as Parameters<typeof computeRRF>[0][0],
        { id: 2, rank: -3 } as unknown as Parameters<typeof computeRRF>[0][0],
      ];
      const vecResults = [
        { rowid: 2, distance: 0.1 },
        { rowid: 1, distance: 0.5 },
      ];

      const results = computeRRF(bm25Rows, vecResults, 0.5, 0.5, 60);

      // ID 2: BM25 rank=2, Vec rank=1 -> 0.5/(60+2) + 0.5/(60+1) = 0.00806... + 0.00819... = 0.01626...
      // ID 1: BM25 rank=1, Vec rank=2 -> 0.5/(60+1) + 0.5/(60+2) = 0.00819... + 0.00806... = 0.01626...
      // Both should have approximately equal scores (symmetric)
      expect(results).toHaveLength(2);
      expect(Math.abs(results[0].score - results[1].score)).toBeLessThan(0.001);
    });

    it('should boost results appearing in both BM25 and vector', () => {
      const bm25Rows = [
        { id: 1, rank: -5 } as unknown as Parameters<typeof computeRRF>[0][0],
        { id: 2, rank: -3 } as unknown as Parameters<typeof computeRRF>[0][0],
      ];
      const vecResults = [
        { rowid: 1, distance: 0.1 },
        { rowid: 3, distance: 0.2 },
      ];

      const results = computeRRF(bm25Rows, vecResults, 0.5, 0.5, 60);

      // ID 1 appears in both lists, should have the highest score
      expect(results[0].id).toBe(1);
      expect(results[0].bm25_rank).toBe(1);
      expect(results[0].vector_rank).toBe(1);
    });

    it('should handle empty BM25 results', () => {
      const bm25Rows: Parameters<typeof computeRRF>[0] = [];
      const vecResults = [
        { rowid: 1, distance: 0.1 },
        { rowid: 2, distance: 0.5 },
      ];

      const results = computeRRF(bm25Rows, vecResults, 0.5, 0.5, 60);

      expect(results).toHaveLength(2);
      expect(results[0].bm25_rank).toBeNull();
      expect(results[0].vector_rank).toBe(1);
    });

    it('should handle empty vector results', () => {
      const bm25Rows = [
        { id: 1, rank: -5 } as unknown as Parameters<typeof computeRRF>[0][0],
      ];
      const vecResults: { rowid: number; distance: number }[] = [];

      const results = computeRRF(bm25Rows, vecResults, 0.5, 0.5, 60);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(1);
      expect(results[0].vector_rank).toBeNull();
      expect(results[0].bm25_rank).toBe(1);
    });

    it('should handle both lists empty', () => {
      const results = computeRRF([], [], 0.5, 0.5, 60);
      expect(results).toHaveLength(0);
    });

    it('should respect weight parameters', () => {
      const bm25Rows = [
        { id: 1, rank: -5 } as unknown as Parameters<typeof computeRRF>[0][0],
      ];
      const vecResults = [
        { rowid: 2, distance: 0.1 },
      ];

      // BM25 weight = 1.0, vector weight = 0
      const bm25Only = computeRRF(bm25Rows, vecResults, 1.0, 0.0, 60);
      expect(bm25Only[0].id).toBe(1);
      expect(bm25Only[0].score).toBeGreaterThan(0);
      expect(bm25Only[1].id).toBe(2);
      expect(bm25Only[1].score).toBe(0);

      // BM25 weight = 0, vector weight = 1.0
      const vecOnly = computeRRF(bm25Rows, vecResults, 0.0, 1.0, 60);
      expect(vecOnly[0].id).toBe(2);
      expect(vecOnly[0].score).toBeGreaterThan(0);
      expect(vecOnly[1].id).toBe(1);
      expect(vecOnly[1].score).toBe(0);
    });

    it('should sort by score descending', () => {
      const bm25Rows = [
        { id: 1, rank: -5 } as unknown as Parameters<typeof computeRRF>[0][0],
        { id: 2, rank: -3 } as unknown as Parameters<typeof computeRRF>[0][0],
        { id: 3, rank: -1 } as unknown as Parameters<typeof computeRRF>[0][0],
      ];
      const vecResults = [
        { rowid: 3, distance: 0.1 },
        { rowid: 1, distance: 0.5 },
      ];

      const results = computeRRF(bm25Rows, vecResults, 0.5, 0.5, 60);

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Buffer conversion roundtrip
  // -------------------------------------------------------------------------

  describe('Buffer conversion', () => {
    it('should roundtrip Float32Array through Buffer and back', () => {
      const original = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      const buf = embeddingToBuffer(original);
      const restored = bufferToEmbedding(buf);

      expect(restored.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 6);
      }
    });

    it('should handle 384-dimension embedding', () => {
      const original = new Float32Array(384);
      for (let i = 0; i < 384; i++) original[i] = i / 384;

      const buf = embeddingToBuffer(original);
      expect(buf.byteLength).toBe(384 * 4); // Float32 = 4 bytes each

      const restored = bufferToEmbedding(buf);
      expect(restored.length).toBe(384);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Hybrid search tool — BM25-only fallback
  // -------------------------------------------------------------------------

  describe('handleMemoryHybridSearch', () => {
    it('should return BM25-only results when vector search is unavailable', async () => {
      _vecAvailable = false;

      insertLearning(db, {
        title: 'SQLite WAL mode optimization',
        content: 'Use WAL mode for better concurrent read performance',
      });

      const result = await handleMemoryHybridSearch({ query: 'SQLite WAL' });

      const text = result.content[0].text;
      expect(text).toContain('BM25 only');
      expect(text).toContain('SQLite WAL mode optimization');
    });

    it('should return hybrid results when vector search is available', async () => {
      _vecAvailable = true;

      const id = insertLearning(db, {
        title: 'Promise rejection patterns',
        content: 'Always handle async errors with try-catch blocks',
      });
      _vecStore.set(id, Buffer.alloc(384 * 4)); // Fake embedding

      const result = await handleMemoryHybridSearch({ query: 'async error handling' });

      const text = result.content[0].text;
      expect(text).toContain('hybrid BM25 + vector');
    });

    it('should return no results message for non-matching query', async () => {
      _vecAvailable = false;

      const result = await handleMemoryHybridSearch({ query: 'xyznonexistent' });

      expect(result.content[0].text).toContain('No learnings found');
    });

    it('should filter by project when specified', async () => {
      _vecAvailable = false;

      insertLearning(db, {
        project: 'project-a',
        title: 'Project A pattern for testing filtering',
        content: 'Content for project A testing filtering',
      });
      insertLearning(db, {
        project: 'project-b',
        title: 'Project B pattern for testing filtering',
        content: 'Content for project B testing filtering',
      });

      const result = await handleMemoryHybridSearch({
        query: 'pattern testing filtering',
        project: 'project-a',
      });

      const text = result.content[0].text;
      expect(text).toContain('Project: project-a');
      expect(text).not.toContain('Project: project-b');
    });

    it('should respect limit parameter', async () => {
      _vecAvailable = false;

      for (let i = 1; i <= 5; i++) {
        insertLearning(db, {
          title: `Hybrid limit test learning ${i}`,
          content: `Content for hybrid limit test learning ${i}`,
        });
      }

      const result = await handleMemoryHybridSearch({
        query: 'hybrid limit test learning',
        limit: 2,
      });

      const text = result.content[0].text;
      expect(text).toContain('Result 1');
      expect(text).toContain('Result 2');
      expect(text).not.toContain('Result 3');
    });

    it('should include RRF score in hybrid results', async () => {
      _vecAvailable = true;

      const id = insertLearning(db, {
        title: 'RRF score display test',
        content: 'Content for RRF score display test',
      });
      _vecStore.set(id, Buffer.alloc(384 * 4));

      const result = await handleMemoryHybridSearch({ query: 'RRF score display test' });

      expect(result.content[0].text).toContain('RRF Score:');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Auto-embed on store
  // -------------------------------------------------------------------------

  describe('handleMemoryStore — auto-embed', () => {
    it('should store embedding when vector search is available', async () => {
      _vecAvailable = true;

      const result = await handleMemoryStore({
        project: 'test-project',
        category: 'pattern',
        title: 'Auto-embed test',
        content: 'This learning should be auto-embedded',
      });

      const text = result.content[0].text;
      expect(text).toContain('Embedding: generated');
      expect(text).toContain('Learning stored successfully');
    });

    it('should still store learning when vector search is unavailable', async () => {
      _vecAvailable = false;

      const result = await handleMemoryStore({
        project: 'test-project',
        category: 'pattern',
        title: 'No-embed test',
        content: 'This learning should store without embedding',
      });

      const text = result.content[0].text;
      expect(text).toContain('Learning stored successfully');
      expect(text).not.toContain('Embedding: generated');
    });

    it('should store learning even if embedding generation fails', async () => {
      _vecAvailable = true;

      // Temporarily make generateEmbedding throw
      const { generateEmbedding: mockGenerate } = await import('../../utils/embeddings.js');
      vi.mocked(mockGenerate).mockRejectedValueOnce(new Error('Model download failed'));

      const result = await handleMemoryStore({
        project: 'test-project',
        category: 'pattern',
        title: 'Embed failure test',
        content: 'This learning should store despite embed failure',
      });

      const text = result.content[0].text;
      expect(text).toContain('Learning stored successfully');
      expect(text).toContain('Embedding: skipped');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Backfill embeddings
  // -------------------------------------------------------------------------

  describe('handleMemoryBackfillEmbeddings', () => {
    it('should skip when sqlite-vec is not available', async () => {
      _vecAvailable = false;

      const result = await handleMemoryBackfillEmbeddings({});

      expect(result.content[0].text).toContain('sqlite-vec extension is not available');
    });

    it('should process learnings without embeddings', async () => {
      _vecAvailable = true;

      insertLearning(db, {
        title: 'Backfill target 1',
        content: 'Content for backfill target 1',
        embedding: null,
      });
      insertLearning(db, {
        title: 'Backfill target 2',
        content: 'Content for backfill target 2',
        embedding: null,
      });

      const result = await handleMemoryBackfillEmbeddings({ batch_size: 10 });

      const text = result.content[0].text;
      expect(text).toContain('Processed: 2');
      expect(text).toContain('Failed: 0');
    });

    it('should skip already-embedded learnings (resumability)', async () => {
      _vecAvailable = true;

      // One with embedding, one without
      insertLearning(db, {
        title: 'Already embedded',
        content: 'This one has an embedding already',
        embedding: Buffer.alloc(384 * 4),
        embedding_model: 'Xenova/all-MiniLM-L6-v2',
      });
      insertLearning(db, {
        title: 'Needs embedding',
        content: 'This one lacks an embedding',
        embedding: null,
      });

      const result = await handleMemoryBackfillEmbeddings({ batch_size: 10 });

      const text = result.content[0].text;
      expect(text).toContain('Processed: 1');
    });

    it('should report all-done when no learnings need embedding', async () => {
      _vecAvailable = true;

      insertLearning(db, {
        title: 'Fully embedded',
        content: 'This one already has an embedding',
        embedding: Buffer.alloc(384 * 4),
        embedding_model: 'Xenova/all-MiniLM-L6-v2',
      });

      const result = await handleMemoryBackfillEmbeddings({});

      expect(result.content[0].text).toContain('already have embeddings');
    });

    it('should filter by project when specified', async () => {
      _vecAvailable = true;

      insertLearning(db, {
        project: 'project-a',
        title: 'Backfill project A',
        content: 'Content for backfill project A',
        embedding: null,
      });
      insertLearning(db, {
        project: 'project-b',
        title: 'Backfill project B',
        content: 'Content for backfill project B',
        embedding: null,
      });

      const result = await handleMemoryBackfillEmbeddings({
        batch_size: 10,
        project: 'project-a',
      });

      const text = result.content[0].text;
      expect(text).toContain('Processed: 1');
      expect(text).toContain('Remaining: 0'); // Only project-a remaining = 0
    });

    it('should respect batch_size limit', async () => {
      _vecAvailable = true;

      for (let i = 0; i < 5; i++) {
        insertLearning(db, {
          title: `Batch test ${i}`,
          content: `Content for batch test ${i}`,
          embedding: null,
        });
      }

      const result = await handleMemoryBackfillEmbeddings({ batch_size: 2 });

      const text = result.content[0].text;
      expect(text).toContain('Processed: 2');
      expect(text).toContain('Remaining: 3');
      expect(text).toContain('Run again to process more');
    });

    it('should handle embedding failures gracefully', async () => {
      _vecAvailable = true;

      insertLearning(db, {
        title: 'Fail embed test',
        content: 'Content for fail embed test',
        embedding: null,
      });

      // Make generateEmbedding throw for this call
      const { generateEmbedding: mockGenerate } = await import('../../utils/embeddings.js');
      vi.mocked(mockGenerate).mockRejectedValueOnce(new Error('GPU OOM'));

      const result = await handleMemoryBackfillEmbeddings({ batch_size: 10 });

      const text = result.content[0].text;
      expect(text).toContain('Failed: 1');
    });
  });

  // -------------------------------------------------------------------------
  // FR-107: Provenance flows through hybrid search results
  // -------------------------------------------------------------------------

  describe('Hybrid search — provenance pass-through (FR-107)', () => {
    it('returns provenance per row from BM25-only fallback', async () => {
      _vecAvailable = false;

      // Insert two learnings with distinct provenance values via direct UPDATE
      const idA = insertLearning(db, {
        title: 'Provenance flow A',
        content: 'Content for provenance flow A in BM25-only path',
      });
      const idB = insertLearning(db, {
        title: 'Provenance flow B',
        content: 'Content for provenance flow B in BM25-only path',
      });
      db.prepare("UPDATE learnings SET provenance = 'inferred' WHERE id = ?").run(idA);
      db.prepare("UPDATE learnings SET provenance = 'human_asserted' WHERE id = ?").run(idB);

      const result = await handleMemoryHybridSearch({ query: 'provenance flow' });

      const text = result.content[0].text;
      expect(text).toContain('Provenance: inferred');
      expect(text).toContain('Provenance: human_asserted');
    });

    it('returns provenance per row in hybrid (BM25 + vector) path', async () => {
      _vecAvailable = true;

      const id = insertLearning(db, {
        title: 'Hybrid provenance result',
        content: 'Content for hybrid provenance result vector flow',
      });
      db.prepare("UPDATE learnings SET provenance = 'synthesized' WHERE id = ?").run(id);
      _vecStore.set(id, Buffer.alloc(384 * 4));

      const result = await handleMemoryHybridSearch({ query: 'hybrid provenance result' });

      const text = result.content[0].text;
      expect(text).toContain('Provenance: synthesized');
    });
  });
});
