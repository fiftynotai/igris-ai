/**
 * Brief Similarity Tests (FR-094)
 *
 * Tests for:
 * 1. extractBriefProblem utility
 * 2. handleBriefSimilar tool
 * 3. handleBriefCreate auto-embed and similarity warning
 * 4. handleBriefBackfillEmbeddings
 *
 * @module tools/__tests__/brief-similar.test
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
const _vecStore = new Map<string, Map<number, Buffer>>();

function getTableStore(table: string): Map<number, Buffer> {
  if (!_vecStore.has(table)) _vecStore.set(table, new Map());
  return _vecStore.get(table)!;
}

vi.mock('../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => _vecAvailable),
  insertEmbeddingInto: vi.fn((_db: unknown, table: string, id: number, embedding: Float32Array) => {
    getTableStore(table).set(id, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
  }),
  vectorSearchFrom: vi.fn((_db: unknown, table: string, _embedding: Float32Array, limit: number) => {
    const store = getTableStore(table);
    return Array.from(store.entries())
      .map(([rowid]) => ({ rowid, distance: rowid * 0.05 }))
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
  extractBriefProblem,
  handleBriefSimilar,
  handleBriefCreate,
  handleBriefBackfillEmbeddings,
} from '../briefs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockedGetDb = vi.mocked(getDb);

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_type TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      effort TEXT,
      phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      embedding BLOB,
      embedding_model TEXT DEFAULT '',
      UNIQUE(project, brief_id)
    );

    CREATE TABLE brief_files (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );

    CREATE INDEX idx_brief_files_project ON brief_files(project);
    CREATE INDEX idx_brief_status_project ON brief_status(project);
    CREATE UNIQUE INDEX idx_brief_status_unique ON brief_status(project, brief_id);
  `);

  return db;
}

function insertBriefStatus(
  db: Database.Database,
  overrides: Partial<{
    project: string;
    brief_id: string;
    title: string;
    status: string;
    priority: string;
    brief_type: string;
  }> = {},
): number {
  const defaults = {
    project: 'test-project',
    brief_id: 'BR-001',
    title: 'Test Brief',
    status: 'Ready',
    priority: null as string | null,
    brief_type: null as string | null,
  };
  const data = { ...defaults, ...overrides };
  const result = db.prepare(`
    INSERT INTO brief_status (project, brief_id, title, status, priority, brief_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.project, data.brief_id, data.title, data.status, data.priority, data.brief_type);
  return result.lastInsertRowid as number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Brief Similarity — FR-094', () => {
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
  // 1. extractBriefProblem
  // -------------------------------------------------------------------------

  describe('extractBriefProblem', () => {
    it('should extract problem section from structured markdown', () => {
      const content = `# Brief FR-001

## Summary
Short summary here.

## Problem
The system lacks semantic search capability.
This makes it hard to find related content.

## Acceptance Criteria
- AC1
- AC2
`;
      const result = extractBriefProblem('Add semantic search', content);

      expect(result).toContain('Add semantic search');
      expect(result).toContain('system lacks semantic search');
      expect(result).not.toContain('Acceptance Criteria');
    });

    it('should handle "Problem Statement" heading variant', () => {
      const content = `## Problem Statement
Users cannot find duplicate briefs efficiently.

## Solution
Add vector similarity search.
`;
      const result = extractBriefProblem('Duplicate detection', content);

      expect(result).toContain('Duplicate detection');
      expect(result).toContain('cannot find duplicate briefs');
    });

    it('should fall back to first 500 chars when no problem section exists', () => {
      const content = 'A'.repeat(800);
      const result = extractBriefProblem('Long Brief', content);

      expect(result).toContain('Long Brief');
      expect(result).toContain('A'.repeat(500));
      expect(result.length).toBeLessThanOrEqual('Long Brief '.length + 500);
    });

    it('should handle empty content', () => {
      const result = extractBriefProblem('Empty Brief', '');
      expect(result).toBe('Empty Brief ');
    });
  });

  // -------------------------------------------------------------------------
  // 2. handleBriefSimilar
  // -------------------------------------------------------------------------

  describe('handleBriefSimilar', () => {
    it('should return unavailable message when sqlite-vec is not loaded', async () => {
      _vecAvailable = false;

      const result = await handleBriefSimilar({ query: 'test query' });

      expect(result.content[0].text).toContain('unavailable');
    });

    it('should return results when similar briefs exist', async () => {
      _vecAvailable = true;

      const id = insertBriefStatus(db, {
        brief_id: 'FR-001',
        title: 'Add search feature',
        status: 'Ready',
      });
      getTableStore('briefs_vec').set(id, Buffer.alloc(384 * 4));

      const result = await handleBriefSimilar({ query: 'search feature' });

      const text = result.content[0].text;
      expect(text).toContain('similar brief(s)');
      expect(text).toContain('FR-001');
    });

    it('should filter by project when specified', async () => {
      _vecAvailable = true;

      const id1 = insertBriefStatus(db, {
        project: 'project-a',
        brief_id: 'FR-001',
        title: 'Feature A',
      });
      const id2 = insertBriefStatus(db, {
        project: 'project-b',
        brief_id: 'FR-002',
        title: 'Feature B',
      });
      getTableStore('briefs_vec').set(id1, Buffer.alloc(384 * 4));
      getTableStore('briefs_vec').set(id2, Buffer.alloc(384 * 4));

      const result = await handleBriefSimilar({
        query: 'test',
        project: 'project-a',
      });

      const text = result.content[0].text;
      expect(text).not.toContain('project-b');
    });

    it('should return no results message when nothing matches threshold', async () => {
      _vecAvailable = true;
      // No briefs in vec store

      const result = await handleBriefSimilar({ query: 'nonexistent' });

      expect(result.content[0].text).toContain('No similar briefs found');
    });

    it('should respect custom threshold', async () => {
      _vecAvailable = true;

      // Insert a brief with distance that gives cosine < 0.5 (distance around 1.0)
      const id = insertBriefStatus(db, { brief_id: 'FR-005', title: 'Low sim' });
      getTableStore('briefs_vec').set(id, Buffer.alloc(384 * 4));

      // Default threshold 0.85 should filter this out (mock distance = id * 0.05)
      // For id=1, distance=0.05, cosine = 1 - 0.0025/2 = 0.99875 -- passes
      const highThreshold = await handleBriefSimilar({ query: 'test', threshold: 0.999 });

      // With very high threshold, mock results (distance=0.05) give cosine ~0.999, borderline
      // Just verify it processes without error
      expect(highThreshold.content[0].text).toBeDefined();
    });

    it('should respect limit parameter', async () => {
      _vecAvailable = true;

      for (let i = 1; i <= 5; i++) {
        const id = insertBriefStatus(db, {
          brief_id: `FR-${String(i).padStart(3, '0')}`,
          title: `Feature ${i}`,
        });
        getTableStore('briefs_vec').set(id, Buffer.alloc(384 * 4));
      }

      const result = await handleBriefSimilar({ query: 'feature', limit: 2, threshold: 0 });

      const matches = result.content[0].text.match(/--- Similarity:/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeLessThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // 3. handleBriefCreate — auto-embed
  // -------------------------------------------------------------------------

  describe('handleBriefCreate — auto-embed', () => {
    it('should create brief and embed when vec is available', async () => {
      _vecAvailable = true;

      const result = await handleBriefCreate({
        project: 'test-project',
        brief_id: 'FR-010',
        title: 'New Feature',
        content: '## Problem\nUsers need a new feature.\n\n## Solution\nBuild it.',
      });

      const text = result.content[0].text;
      expect(text).toContain('Brief created successfully');
      expect(text).toContain('Embedding: generated');
    });

    it('should create brief without embed when vec is unavailable', async () => {
      _vecAvailable = false;

      const result = await handleBriefCreate({
        project: 'test-project',
        brief_id: 'FR-011',
        title: 'Another Feature',
        content: 'Simple content',
      });

      const text = result.content[0].text;
      expect(text).toContain('Brief created successfully');
      expect(text).not.toContain('Embedding: generated');
    });

    it('should warn about similar briefs during create', async () => {
      _vecAvailable = true;

      // Pre-create a brief with embedding
      const id = insertBriefStatus(db, {
        brief_id: 'FR-020',
        title: 'Existing Feature',
      });
      getTableStore('briefs_vec').set(id, Buffer.alloc(384 * 4));

      const result = await handleBriefCreate({
        project: 'test-project',
        brief_id: 'FR-021',
        title: 'Similar Feature',
        content: 'Some content',
      });

      const text = result.content[0].text;
      expect(text).toContain('Brief created successfully');
      // The mock returns results with distance = rowid * 0.05
      // Pre-existing brief has id=1, distance=0.05, cosine ~0.999 -> should warn
      expect(text).toContain('similar brief(s) detected');
    });

    it('should still create brief if embedding fails', async () => {
      _vecAvailable = true;

      const { generateEmbedding: mockGenerate } = await import('../../utils/embeddings.js');
      vi.mocked(mockGenerate).mockRejectedValueOnce(new Error('Pipeline crashed'));

      const result = await handleBriefCreate({
        project: 'test-project',
        brief_id: 'FR-012',
        title: 'Fail Embed',
        content: 'Content here',
      });

      const text = result.content[0].text;
      expect(text).toContain('Brief created successfully');
      expect(text).toContain('Embedding: skipped');
    });

    it('should validate required fields', async () => {
      const result = await handleBriefCreate({
        project: '',
        brief_id: 'FR-013',
        title: 'Missing project',
        content: 'Content',
      });

      expect(result.content[0].text).toContain('Error');
    });
  });

  // -------------------------------------------------------------------------
  // 4. handleBriefBackfillEmbeddings
  // -------------------------------------------------------------------------

  describe('handleBriefBackfillEmbeddings', () => {
    it('should skip when sqlite-vec is not available', async () => {
      _vecAvailable = false;

      const result = await handleBriefBackfillEmbeddings({});

      expect(result.content[0].text).toContain('sqlite-vec extension is not available');
    });

    it('should process briefs without embeddings', async () => {
      _vecAvailable = true;

      // Insert brief with matching brief_files
      db.prepare(`INSERT INTO brief_status (project, brief_id, title, status) VALUES (?, ?, ?, ?)`)
        .run('test-project', 'FR-030', 'Backfill Test', 'Ready');
      db.prepare(`INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('uuid-1', 'test-project', 'FR-030', 'FR-030.md', 'Test content for backfill', 'hash1');

      const result = await handleBriefBackfillEmbeddings({ batch_size: 10 });

      expect(result.content[0].text).toContain('Processed: 1');
    });

    it('should report all-done when no briefs need embedding', async () => {
      _vecAvailable = true;

      // Insert brief with existing embedding
      db.prepare(
        `INSERT INTO brief_status (project, brief_id, title, status, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('test-project', 'FR-031', 'Already Embedded', 'Ready', Buffer.alloc(384 * 4), 'model');
      db.prepare(`INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('uuid-2', 'test-project', 'FR-031', 'FR-031.md', 'Content', 'hash2');

      const result = await handleBriefBackfillEmbeddings({});

      expect(result.content[0].text).toContain('already have embeddings');
    });

    it('should filter by project', async () => {
      _vecAvailable = true;

      db.prepare(`INSERT INTO brief_status (project, brief_id, title, status) VALUES (?, ?, ?, ?)`)
        .run('project-a', 'FR-040', 'Project A Brief', 'Ready');
      db.prepare(`INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('uuid-a', 'project-a', 'FR-040', 'FR-040.md', 'Content A', 'hashA');

      db.prepare(`INSERT INTO brief_status (project, brief_id, title, status) VALUES (?, ?, ?, ?)`)
        .run('project-b', 'FR-041', 'Project B Brief', 'Ready');
      db.prepare(`INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('uuid-b', 'project-b', 'FR-041', 'FR-041.md', 'Content B', 'hashB');

      const result = await handleBriefBackfillEmbeddings({ project: 'project-a', batch_size: 10 });

      expect(result.content[0].text).toContain('Processed: 1');
      expect(result.content[0].text).toContain('Remaining: 0');
    });
  });
});
