/**
 * Memory Tool Handler Tests (FR-092)
 *
 * Tests the 4 quick-fix improvements to memory tools:
 * 1. Truncated content in recall output
 * 2. Composite ranking with confidence + access_count
 * 3. Title-collision promotion with content similarity check
 * 4. Search pagination via offset parameter
 * 5. New igris_memory_get tool for full content fetch
 *
 * @module tools/__tests__/memory.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

// Mock embedding utilities — handleMemoryRecall now uses hybrid search
vi.mock('../../utils/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(384)),
  embeddingToBuffer: vi.fn((embedding: Float32Array) =>
    Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
  ),
  bufferToEmbedding: vi.fn(),
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
}));

// Mock vector-search — not available in these tests (recall falls back to BM25)
vi.mock('../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbedding: vi.fn(),
  deleteEmbedding: vi.fn(),
  vectorSearch: vi.fn(() => []),
  insertEmbeddingInto: vi.fn(),
  deleteEmbeddingFrom: vi.fn(),
  vectorSearchFrom: vi.fn(() => []),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../db.js';
import {
  handleMemoryStore,
  handleMemorySearch,
  handleMemoryRecall,
  handleMemoryGet,
  promoteToGlobal,
  wordJaccardSimilarity,
} from '../memory.js';

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
      last_accessed_at TEXT
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
  };
  const data = { ...defaults, ...overrides };
  const stmt = db.prepare(`
    INSERT INTO learnings (project, category, title, content, tags, tech_stack, scope, source_brief, confidence, access_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.project, data.category, data.title, data.content,
    data.tags, data.tech_stack, data.scope, data.source_brief,
    data.confidence, data.access_count,
  );
  return result.lastInsertRowid as number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Memory Tools (FR-092)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Truncated content in recall
  // -------------------------------------------------------------------------

  describe('handleMemoryRecall — truncated content', () => {
    it('should return truncated content (200 chars + ellipsis) for long learnings', async () => {
      const longContent = 'A'.repeat(500);
      insertLearning(db, { content: longContent, title: 'Long Learning' });

      const result = await handleMemoryRecall({
        project: 'test-project',
        context: 'Long Learning',
      });

      const text = result.content[0].text;
      expect(text).toContain('A'.repeat(200) + '...');
      expect(text).not.toContain('A'.repeat(201));
    });

    it('should return full content when under 200 chars', async () => {
      const shortContent = 'Short content here';
      insertLearning(db, { content: shortContent, title: 'Short Learning' });

      const result = await handleMemoryRecall({
        project: 'test-project',
        context: 'Short Learning',
      });

      const text = result.content[0].text;
      expect(text).toContain(`Content: ${shortContent}`);
      expect(text).not.toContain('...');
    });

    it('should mention igris_memory_get in recall output', async () => {
      insertLearning(db, { title: 'Recall Hint' });

      const result = await handleMemoryRecall({
        project: 'test-project',
        context: 'Recall Hint',
      });

      expect(result.content[0].text).toContain('igris_memory_get');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Composite ranking with confidence + access_count
  // -------------------------------------------------------------------------

  describe('handleMemoryRecall — composite ranking', () => {
    it('should rank higher-confidence learnings above lower-confidence for same FTS match', async () => {
      // Insert two learnings with same title/content but different confidence
      insertLearning(db, {
        title: 'SQLite optimization pattern',
        content: 'Use WAL mode for better concurrent read performance in SQLite databases',
        confidence: 0.3,
        access_count: 0,
      });
      insertLearning(db, {
        title: 'SQLite optimization technique',
        content: 'Use WAL mode for better concurrent read performance in SQLite databases',
        confidence: 1.0,
        access_count: 0,
      });

      const result = await handleMemoryRecall({
        project: 'test-project',
        context: 'SQLite WAL optimization',
        limit: 2,
      });

      const text = result.content[0].text;
      // The higher-confidence one should appear first (Recall 1)
      const recall1Match = text.match(/--- Recall 1 ---[\s\S]*?Confidence: ([\d.]+)/);
      const recall2Match = text.match(/--- Recall 2 ---[\s\S]*?Confidence: ([\d.]+)/);

      expect(recall1Match).not.toBeNull();
      expect(recall2Match).not.toBeNull();
      expect(parseFloat(recall1Match![1])).toBeGreaterThanOrEqual(parseFloat(recall2Match![1]));
    });

    it('should rank frequently-accessed learnings higher', async () => {
      insertLearning(db, {
        title: 'Rarely accessed pattern for testing',
        content: 'Some testing pattern that is rarely used in practice',
        confidence: 0.8,
        access_count: 0,
      });
      insertLearning(db, {
        title: 'Popular pattern for testing',
        content: 'Some testing pattern that is frequently used in practice',
        confidence: 0.8,
        access_count: 100,
      });

      const result = await handleMemoryRecall({
        project: 'test-project',
        context: 'testing pattern',
        limit: 2,
      });

      const text = result.content[0].text;
      // The popular one (access_count=100) should appear first
      const recall1Match = text.match(/--- Recall 1 ---[\s\S]*?Title: (.+)/);
      expect(recall1Match).not.toBeNull();
      expect(recall1Match![1]).toContain('Popular');
    });

    it('should include composite score in output', async () => {
      insertLearning(db, { title: 'Score Check' });

      const result = await handleMemoryRecall({
        project: 'test-project',
        context: 'Score Check',
      });

      expect(result.content[0].text).toContain('Score:');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Title-collision promotion with content similarity
  // -------------------------------------------------------------------------

  describe('promoteToGlobal — content similarity check', () => {
    it('should promote learnings with same title and similar content across projects', () => {
      insertLearning(db, {
        project: 'project-a',
        title: 'WAL Mode Best Practice',
        content: 'Always use WAL mode for SQLite databases in production for concurrent read performance',
      });
      insertLearning(db, {
        project: 'project-b',
        title: 'WAL Mode Best Practice',
        content: 'Always use WAL mode for SQLite databases in production for concurrent read performance',
      });

      const promoted = promoteToGlobal();
      expect(promoted).toBe(2);

      // Verify both are now global
      const rows = db.prepare("SELECT scope FROM learnings WHERE scope = 'global'").all();
      expect(rows.length).toBe(2);
    });

    it('should NOT promote learnings with same title but different content', () => {
      insertLearning(db, {
        project: 'project-a',
        title: 'Database Pattern',
        content: 'Use connection pooling for PostgreSQL to manage concurrent connections efficiently',
      });
      insertLearning(db, {
        project: 'project-b',
        title: 'Database Pattern',
        content: 'Always normalize your MongoDB schemas to avoid data duplication and inconsistency',
      });

      const promoted = promoteToGlobal();
      expect(promoted).toBe(0);

      // Verify both are still local
      const rows = db.prepare("SELECT scope FROM learnings WHERE scope = 'local'").all();
      expect(rows.length).toBe(2);
    });

    it('should use case-insensitive title matching', () => {
      insertLearning(db, {
        project: 'project-a',
        title: 'Caching Strategy',
        content: 'Use Redis for caching frequently accessed data to reduce database load',
      });
      insertLearning(db, {
        project: 'project-b',
        title: 'caching strategy',
        content: 'Use Redis for caching frequently accessed data to reduce database load',
      });

      const promoted = promoteToGlobal();
      expect(promoted).toBe(2);
    });

    it('should not promote when only one project has the learning', () => {
      insertLearning(db, {
        project: 'project-a',
        title: 'Unique Pattern',
        content: 'This pattern is only in one project',
      });

      const promoted = promoteToGlobal();
      expect(promoted).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Search pagination via offset
  // -------------------------------------------------------------------------

  describe('handleMemorySearch — pagination', () => {
    it('should support offset parameter for pagination', () => {
      // Insert 5 learnings with searchable content
      for (let i = 1; i <= 5; i++) {
        insertLearning(db, {
          title: `Pagination test learning number ${i}`,
          content: `Content for pagination test learning entry number ${i}`,
        });
      }

      const page1 = handleMemorySearch({
        query: 'pagination test learning',
        limit: 2,
        offset: 0,
      });

      const page2 = handleMemorySearch({
        query: 'pagination test learning',
        limit: 2,
        offset: 2,
      });

      // Both pages should have results
      expect(page1.content[0].text).toContain('Result 1');
      expect(page1.content[0].text).toContain('Result 2');
      expect(page2.content[0].text).toContain('Result 1');

      // Results on different pages should be different
      const page1Ids = page1.content[0].text.match(/ID: (\d+)/g);
      const page2Ids = page2.content[0].text.match(/ID: (\d+)/g);
      expect(page1Ids).not.toBeNull();
      expect(page2Ids).not.toBeNull();

      // No overlap between pages
      const page1Set = new Set(page1Ids);
      for (const id of page2Ids!) {
        expect(page1Set.has(id)).toBe(false);
      }
    });

    it('should default offset to 0 when not provided', () => {
      insertLearning(db, {
        title: 'Default offset test',
        content: 'Content for default offset test',
      });

      const result = handleMemorySearch({
        query: 'default offset test',
      });

      expect(result.content[0].text).toContain('Result 1');
    });
  });

  // -------------------------------------------------------------------------
  // 5. igris_memory_get — full content fetch
  // -------------------------------------------------------------------------

  describe('handleMemoryGet', () => {
    it('should return full content for a valid learning ID', () => {
      const longContent = 'B'.repeat(1000);
      const id = insertLearning(db, {
        title: 'Full Content Learning',
        content: longContent,
        tags: 'test,full',
        tech_stack: 'typescript',
      });

      const result = handleMemoryGet({ id });

      const text = result.content[0].text;
      expect(text).toContain(`ID: ${id}`);
      expect(text).toContain('Title: Full Content Learning');
      expect(text).toContain(longContent); // Full content, not truncated
      expect(text).toContain('Tags: test,full');
    });

    it('should return error for non-existent ID', () => {
      const result = handleMemoryGet({ id: 99999 });

      expect(result.content[0].text).toContain('not found');
    });

    it('should increment access_count', () => {
      const id = insertLearning(db, {
        title: 'Access Count Test',
        content: 'Content for access count test',
        access_count: 5,
      });

      handleMemoryGet({ id });

      const row = db.prepare('SELECT access_count FROM learnings WHERE id = ?').get(id) as { access_count: number };
      expect(row.access_count).toBe(6);
    });

    it('should update last_accessed_at', () => {
      const id = insertLearning(db, {
        title: 'Last Accessed Test',
        content: 'Content for last accessed test',
      });

      handleMemoryGet({ id });

      const row = db.prepare('SELECT last_accessed_at FROM learnings WHERE id = ?').get(id) as { last_accessed_at: string };
      expect(row.last_accessed_at).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // wordJaccardSimilarity utility
  // -------------------------------------------------------------------------

  describe('wordJaccardSimilarity', () => {
    it('should return 1.0 for identical strings', () => {
      expect(wordJaccardSimilarity('hello world', 'hello world')).toBe(1);
    });

    it('should return 0 for completely different strings', () => {
      expect(wordJaccardSimilarity('alpha beta', 'gamma delta')).toBe(0);
    });

    it('should be case-insensitive', () => {
      expect(wordJaccardSimilarity('Hello World', 'hello world')).toBe(1);
    });

    it('should handle empty strings', () => {
      expect(wordJaccardSimilarity('', '')).toBe(1);
      expect(wordJaccardSimilarity('hello', '')).toBe(0);
      expect(wordJaccardSimilarity('', 'hello')).toBe(0);
    });

    it('should compute correct partial similarity', () => {
      // 2 words in common (hello, world) out of 3 unique (hello, world, foo)
      // Jaccard = 2/3 = 0.666...
      const sim = wordJaccardSimilarity('hello world', 'hello world foo');
      expect(sim).toBeCloseTo(2 / 3, 5);
    });
  });
});
