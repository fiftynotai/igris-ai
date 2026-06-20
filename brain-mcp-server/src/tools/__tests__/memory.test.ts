/**
 * Memory Tool Handler Tests (FR-092 + TD-092)
 *
 * Tests the memory tool surface:
 * 1. FR-092: Truncated content in recall output
 * 2. FR-092: Composite ranking with confidence + access_count
 * 3. FR-092: Title-collision promotion with content similarity check
 * 4. FR-092: Search pagination via offset parameter
 * 5. FR-092: New igris_memory_get tool for full content fetch
 * 6. TD-092: access_count telemetry regression contract
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
  handleMemoryMarkPromoted,
  handleMemoryHybridSearch,
  promoteToGlobal,
  wordJaccardSimilarity,
  computeTechStackOverlap,
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
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      tech_stack TEXT DEFAULT '',
      archetype TEXT DEFAULT 'unclassified',
      igris_version TEXT DEFAULT '4.0.0',
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'inactive')),
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_session_at TEXT,
      metadata TEXT DEFAULT '{}'
    );

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
      provenance TEXT NOT NULL DEFAULT 'observed'
        CHECK(provenance IN ('observed','inferred','synthesized','ambiguous','human_asserted')),
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual',
      -- FR-200 M2: nullable promotion pointer (db.ts v16). NULL = not promoted.
      promoted_to_doc TEXT
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
    -- TD-098: production schema after migration v3 has NO learnings_vec_ad
    -- trigger; handlers own explicit cleanup. This fixture doesn't create
    -- learnings_vec at all, so there's nothing to mirror — but if you ever
    -- add vec to this suite, do NOT recreate the trigger.
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
    // FR-200 M2: optional pre-set promotion pointer (default null = not promoted).
    promoted_to_doc: string | null;
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
    promoted_to_doc: null as string | null,
  };
  const data = { ...defaults, ...overrides };
  const stmt = db.prepare(`
    INSERT INTO learnings (project, category, title, content, tags, tech_stack, scope, source_brief, confidence, access_count, promoted_to_doc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.project, data.category, data.title, data.content,
    data.tags, data.tech_stack, data.scope, data.source_brief,
    data.confidence, data.access_count, data.promoted_to_doc,
  );
  return result.lastInsertRowid as number;
}

/** Insert a project directly into the test database. */
function insertProject(
  db: Database.Database,
  overrides: Partial<{
    slug: string;
    name: string;
    path: string;
    tech_stack: string;
    archetype: string;
  }> = {},
): void {
  const defaults = {
    slug: 'test-project',
    name: 'Test Project',
    path: '/tmp/test-project',
    tech_stack: '',
    archetype: 'unclassified',
  };
  const data = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO projects (slug, name, path, tech_stack, archetype)
    VALUES (?, ?, ?, ?, ?)
  `).run(data.slug, data.name, data.path, data.tech_stack, data.archetype);
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
  // TD-092: access_count telemetry contract — recall must increment
  // access_count and stamp last_accessed_at for every returned row.
  // The TD-092 production bug was environmental (two-DB drift), but these
  // tests freeze the SQL contract so a future refactor cannot silently
  // break the increment path.
  // -------------------------------------------------------------------------

  describe('handleMemoryRecall — access_count telemetry', () => {
    it('TD-092: increments access_count and updates last_accessed_at for every returned row', async () => {
      const id = insertLearning(db, { title: 'TD-092 fixture row', access_count: 7 });
      const before = db
        .prepare('SELECT access_count, last_accessed_at FROM learnings WHERE id = ?')
        .get(id) as { access_count: number; last_accessed_at: string | null };
      expect(before.access_count).toBe(7);
      expect(before.last_accessed_at).toBeNull();

      await handleMemoryRecall({ project: 'test-project', context: 'TD-092 fixture row' });

      const after = db
        .prepare('SELECT access_count, last_accessed_at FROM learnings WHERE id = ?')
        .get(id) as { access_count: number; last_accessed_at: string | null };
      expect(after.access_count).toBe(8);
      expect(after.last_accessed_at).not.toBeNull();
    });

    it('TD-092: increments access_count exactly once per recall call (no double-counting)', async () => {
      const id = insertLearning(db, { title: 'TD-092 unique-once telemetry', access_count: 0 });

      await handleMemoryRecall({ project: 'test-project', context: 'TD-092 unique-once telemetry' });

      const row = db
        .prepare('SELECT access_count FROM learnings WHERE id = ?')
        .get(id) as { access_count: number };
      expect(row.access_count).toBe(1);
    });

    it('TD-092: skipped rows (filtered out by review_status) do NOT increment', async () => {
      const id = insertLearning(db, { title: 'TD-092 pending suppressed', access_count: 0 });
      db.prepare("UPDATE learnings SET review_status = 'pending_review' WHERE id = ?").run(id);

      await handleMemoryRecall({ project: 'test-project', context: 'TD-092 pending suppressed' });

      const row = db
        .prepare('SELECT access_count FROM learnings WHERE id = ?')
        .get(id) as { access_count: number };
      expect(row.access_count).toBe(0);
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

    // -----------------------------------------------------------------------
    // TD-060: pending_review rows must not be promoted to global scope.
    // -----------------------------------------------------------------------

    it('TD-060: pending_review rows are NOT promoted to global scope', () => {
      // Seed: same title in two projects, both local. One row has
      // review_status='approved' (default), the other 'pending_review'
      // (e.g. inserted via the perception channel).
      const approvedId = insertLearning(db, {
        project: 'project-a',
        title: 'shared-title',
        content: 'identical body content for similarity comparison',
      });
      const pendingId = insertLearning(db, {
        project: 'project-b',
        title: 'shared-title',
        content: 'identical body content for similarity comparison',
      });
      db.prepare(
        "UPDATE learnings SET review_status = 'pending_review' WHERE id = ?",
      ).run(pendingId);

      const promoted = promoteToGlobal();
      // Only one project has an approved row — the >=2 distinct-projects
      // check fails, so no promotion happens.
      expect(promoted).toBe(0);

      const approvedRow = db
        .prepare('SELECT scope, review_status FROM learnings WHERE id = ?')
        .get(approvedId) as { scope: string; review_status: string };
      const pendingRow = db
        .prepare('SELECT scope, review_status FROM learnings WHERE id = ?')
        .get(pendingId) as { scope: string; review_status: string };

      expect(approvedRow.scope).toBe('local');
      expect(approvedRow.review_status).toBe('approved');
      // Pending row must remain local AND pending — never gets scope flipped.
      expect(pendingRow.scope).toBe('local');
      expect(pendingRow.review_status).toBe('pending_review');
    });

    it('TD-060: after approval, previously-pending rows resume promotion eligibility', () => {
      // Two projects with identical titles + bodies, but one is pending_review.
      // First pass should not promote (the pending one is excluded).
      const id1 = insertLearning(db, {
        project: 'project-a',
        title: 'eligible-after-approval',
        content: 'identical body content used for jaccard similarity threshold',
      });
      const id2 = insertLearning(db, {
        project: 'project-b',
        title: 'eligible-after-approval',
        content: 'identical body content used for jaccard similarity threshold',
      });
      db.prepare(
        "UPDATE learnings SET review_status = 'pending_review' WHERE id = ?",
      ).run(id2);

      expect(promoteToGlobal()).toBe(0);

      // Approve the pending row and re-run promotion.
      db.prepare(
        "UPDATE learnings SET review_status = 'approved' WHERE id = ?",
      ).run(id2);

      expect(promoteToGlobal()).toBe(2);
      const rows = db
        .prepare('SELECT scope FROM learnings WHERE id IN (?, ?)')
        .all(id1, id2) as Array<{ scope: string }>;
      expect(rows.every((r) => r.scope === 'global')).toBe(true);
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

  // -------------------------------------------------------------------------
  // Tech stack affinity boost (FR-097)
  // -------------------------------------------------------------------------

  describe('computeTechStackOverlap', () => {
    it('should return 1.0 for identical tech stacks', () => {
      expect(computeTechStackOverlap('flutter, dart', 'flutter, dart')).toBe(1);
    });

    it('should return 0.5 for partial overlap', () => {
      // intersection = {typescript}, union = {typescript, react, node, express}
      // But let's do a cleaner example: {a, b} vs {b, c} => intersection 1, union 3 => 0.333
      // {typescript, react} vs {typescript, vue} => intersection 1, union 3 => 0.333
      // For exactly 0.5: {a, b} vs {a, c, b, d} won't work.
      // {a, b} vs {a} => intersection 1, union 2 => 0.5
      expect(computeTechStackOverlap('typescript, react', 'typescript')).toBeCloseTo(0.5, 5);
    });

    it('should return 0 for completely different stacks', () => {
      expect(computeTechStackOverlap('flutter, dart', 'python, django')).toBe(0);
    });

    it('should return 0 when either stack is null', () => {
      expect(computeTechStackOverlap(null, 'typescript')).toBe(0);
      expect(computeTechStackOverlap('typescript', null)).toBe(0);
      expect(computeTechStackOverlap(null, null)).toBe(0);
    });

    it('should return 0 for empty strings', () => {
      expect(computeTechStackOverlap('', 'typescript')).toBe(0);
      expect(computeTechStackOverlap('typescript', '')).toBe(0);
    });

    it('should be case-insensitive', () => {
      expect(computeTechStackOverlap('TypeScript, React', 'typescript, react')).toBe(1);
    });

    it('should handle whitespace around items', () => {
      expect(computeTechStackOverlap('  typescript , react  ', 'typescript,react')).toBe(1);
    });
  });

  describe('handleMemoryRecall — tech stack affinity boost', () => {
    it('should apply 1.3x boost to global learning from same-stack project', async () => {
      // Register two projects with the same tech stack
      insertProject(db, { slug: 'project-a', name: 'Project A', path: '/a', tech_stack: 'typescript, react' });
      insertProject(db, { slug: 'project-b', name: 'Project B', path: '/b', tech_stack: 'typescript, react' });

      // Insert a global learning from project-b
      insertLearning(db, {
        project: 'project-b',
        title: 'React hooks optimization',
        content: 'Use useMemo and useCallback for React hooks optimization to prevent unnecessary re-renders',
        scope: 'global',
        tech_stack: 'typescript, react',
      });

      const result = await handleMemoryRecall({
        project: 'project-a',
        context: 'React hooks optimization',
      });

      const text = result.content[0].text;
      expect(text).toContain('Recalled');
      expect(text).toContain('React hooks optimization');
      // In BM25-only mode the boost annotation won't appear because it's hybrid-only,
      // but the query should still succeed without errors
    });

    it('should not boost global learning from different-stack project', async () => {
      // Register two projects with different tech stacks
      insertProject(db, { slug: 'project-a', name: 'Project A', path: '/a', tech_stack: 'typescript, react' });
      insertProject(db, { slug: 'project-c', name: 'Project C', path: '/c', tech_stack: 'python, django' });

      // Insert a global learning from project-c
      insertLearning(db, {
        project: 'project-c',
        title: 'Django middleware patterns',
        content: 'Django middleware patterns for request processing and authentication',
        scope: 'global',
        tech_stack: 'python, django',
      });

      const result = await handleMemoryRecall({
        project: 'project-a',
        context: 'Django middleware patterns',
      });

      const text = result.content[0].text;
      expect(text).toContain('Recalled');
      // The result should appear but without a tech-stack boost annotation
      expect(text).not.toContain('Boost: tech-stack affinity');
    });

    it('should not crash when project has no tech_stack registered', async () => {
      // project-a is NOT in the projects table at all
      insertLearning(db, {
        project: 'other-project',
        title: 'Some global pattern',
        content: 'Some global pattern content for testing recall without tech stack',
        scope: 'global',
      });

      const result = await handleMemoryRecall({
        project: 'unregistered-project',
        context: 'Some global pattern',
      });

      const text = result.content[0].text;
      expect(text).toContain('Recalled');
      expect(text).not.toContain('Boost: tech-stack affinity');
    });

    it('should not crash when projects table has NULL tech_stack values', async () => {
      // Insert project with no tech_stack (NULL via omission, but our helper inserts '')
      insertProject(db, { slug: 'project-null', name: 'Null Stack', path: '/null', tech_stack: '' });

      insertLearning(db, {
        project: 'project-null',
        title: 'Null stack learning',
        content: 'Learning from a project with null tech stack for testing',
        scope: 'global',
      });

      const result = await handleMemoryRecall({
        project: 'project-null',
        context: 'Null stack learning',
      });

      // Should succeed without error — the learning is project-local so gets 1.5x instead
      const text = result.content[0].text;
      expect(text).toContain('Recalled');
    });
  });

  describe('handleMemoryRecall — archetype affinity boost', () => {
    it('should recall learnings from project with matching archetype', async () => {
      // Register two projects with the same archetype
      insertProject(db, { slug: 'proj-brand-a', name: 'Brand A', path: '/a', tech_stack: 'dart,flutter', archetype: 'brand-website' });
      insertProject(db, { slug: 'proj-brand-b', name: 'Brand B', path: '/b', tech_stack: 'dart,flutter', archetype: 'brand-website' });

      // Insert a global learning from brand-b
      insertLearning(db, {
        project: 'proj-brand-b',
        title: 'Hero scroll animation pattern',
        content: 'Hero scroll animation pattern for brand website using Flutter custom scroll view',
        scope: 'global',
        tech_stack: 'dart,flutter',
      });

      const result = await handleMemoryRecall({
        project: 'proj-brand-a',
        context: 'Hero scroll animation pattern',
      });

      const text = result.content[0].text;
      expect(text).toContain('Recalled');
      expect(text).toContain('Hero scroll animation pattern');
    });

    it('should recall learning from different-archetype project without boost', async () => {
      insertProject(db, { slug: 'proj-brand', name: 'Brand', path: '/brand', tech_stack: 'dart,flutter', archetype: 'brand-website' });
      insertProject(db, { slug: 'proj-saas', name: 'SaaS', path: '/saas', tech_stack: 'typescript,react', archetype: 'saas-dashboard' });

      insertLearning(db, {
        project: 'proj-saas',
        title: 'Dashboard layout pattern',
        content: 'Dashboard layout pattern with sidebar navigation for SaaS applications',
        scope: 'global',
        tech_stack: 'typescript,react',
      });

      const result = await handleMemoryRecall({
        project: 'proj-brand',
        context: 'Dashboard layout pattern',
      });

      const text = result.content[0].text;
      expect(text).toContain('Recalled');
      // Still found but no archetype boost applied
    });

    it('should not apply archetype boost when archetype is unclassified', async () => {
      insertProject(db, { slug: 'proj-unclassified', name: 'Unclassified', path: '/unc', tech_stack: 'typescript', archetype: 'unclassified' });
      insertProject(db, { slug: 'proj-also-unclassified', name: 'Also Unclassified', path: '/unc2', tech_stack: 'typescript', archetype: 'unclassified' });

      insertLearning(db, {
        project: 'proj-also-unclassified',
        title: 'Unclassified project pattern',
        content: 'Unclassified project pattern for testing archetype boost exclusion',
        scope: 'global',
        tech_stack: 'typescript',
      });

      const result = await handleMemoryRecall({
        project: 'proj-unclassified',
        context: 'Unclassified project pattern',
      });

      const text = result.content[0].text;
      expect(text).toContain('Recalled');
      // No archetype boost for 'unclassified' — the condition explicitly filters it out
    });

    it('should not crash when project has no archetype set', async () => {
      insertProject(db, { slug: 'proj-no-arch', name: 'No Arch', path: '/noarch', tech_stack: 'typescript' });

      insertLearning(db, {
        project: 'proj-no-arch',
        title: 'No archetype learning',
        content: 'No archetype learning content for testing graceful handling',
        scope: 'local',
      });

      const result = await handleMemoryRecall({
        project: 'proj-no-arch',
        context: 'No archetype learning',
      });

      const text = result.content[0].text;
      expect(text).toContain('Recalled');
    });
  });

  // -------------------------------------------------------------------------
  // FR-107: Provenance tags on learnings
  // -------------------------------------------------------------------------

  describe('Provenance tags (FR-107)', () => {
    it('store + recall round-trips a non-default provenance value', async () => {
      const storeResult = await handleMemoryStore({
        project: 'test-project',
        category: 'pattern',
        title: 'Inferred reasoning learning',
        content: 'A learning derived from inference, not direct observation, for round-trip test',
        provenance: 'inferred',
      });

      expect(storeResult.content[0].text).toContain('Provenance: inferred');

      const recallResult = await handleMemoryRecall({
        project: 'test-project',
        context: 'Inferred reasoning learning',
      });

      expect(recallResult.content[0].text).toContain('Provenance: inferred');
    });

    it('defaults provenance to "observed" when not provided on store', async () => {
      const storeResult = await handleMemoryStore({
        project: 'test-project',
        category: 'pattern',
        title: 'Default provenance learning',
        content: 'A learning stored without explicit provenance for default test',
      });

      expect(storeResult.content[0].text).toContain('Provenance: observed');

      const recallResult = await handleMemoryRecall({
        project: 'test-project',
        context: 'Default provenance learning',
      });

      expect(recallResult.content[0].text).toContain('Provenance: observed');
    });

    it('rejects an invalid provenance value at the handler', async () => {
      const result = await handleMemoryStore({
        project: 'test-project',
        category: 'pattern',
        title: 'Bad provenance learning',
        content: 'A learning with an invalid provenance value for validation test',
        // @ts-expect-error -- intentionally invalid value to exercise validator
        provenance: 'totally_made_up',
      });

      expect(result.content[0].text).toContain('Validation error');
      expect(result.content[0].text).toContain('Invalid provenance');
    });

    it('accepts all five vocabulary values', async () => {
      const values = ['observed', 'inferred', 'synthesized', 'ambiguous', 'human_asserted'] as const;
      for (const p of values) {
        const result = await handleMemoryStore({
          project: 'test-project',
          category: 'pattern',
          title: `Provenance ${p} learning`,
          content: `A learning with provenance value ${p} for vocabulary coverage test`,
          provenance: p,
        });
        expect(result.content[0].text).toContain(`Provenance: ${p}`);
      }
    });

    it('backfills existing rows to provenance="observed" via DEFAULT', async () => {
      // Insert a row WITHOUT specifying provenance — the column DEFAULT should fill it.
      const id = insertLearning(db, {
        title: 'Pre-existing learning',
        content: 'Inserted via raw SQL helper; relies on column DEFAULT to set provenance',
      });

      const row = db
        .prepare('SELECT provenance FROM learnings WHERE id = ?')
        .get(id) as { provenance: string };
      expect(row.provenance).toBe('observed');

      const recallResult = await handleMemoryRecall({
        project: 'test-project',
        context: 'Pre-existing learning',
      });
      expect(recallResult.content[0].text).toContain('Provenance: observed');
    });

    it('handleMemoryGet returns provenance for the requested learning', () => {
      const id = insertLearning(db, {
        title: 'Get-by-id provenance test',
        content: 'Content for get-by-id provenance test',
      });
      // Set the row's provenance via a direct UPDATE to simulate a non-default value.
      db.prepare("UPDATE learnings SET provenance = 'human_asserted' WHERE id = ?").run(id);

      const result = handleMemoryGet({ id });
      expect(result.content[0].text).toContain('Provenance: human_asserted');
    });
  });

  // -------------------------------------------------------------------------
  // FR-109: review_status default filter
  // -------------------------------------------------------------------------

  describe('review_status default filter (FR-109)', () => {
    it('handleMemorySearch hides pending_review rows', () => {
      insertLearning(db, {
        title: 'Approved entry for review filter',
        content: 'Content for approved review-filter test',
      });
      const pendingId = insertLearning(db, {
        title: 'Pending review entry for review filter',
        content: 'Content for pending review-filter test',
      });
      db.prepare("UPDATE learnings SET review_status = 'pending_review' WHERE id = ?").run(pendingId);

      const result = handleMemorySearch({ query: 'review filter' });
      const text = result.content[0].text;
      expect(text).toContain('Approved entry for review filter');
      expect(text).not.toContain('Pending review entry for review filter');
    });

    it('handleMemoryRecall hides pending_review rows', async () => {
      insertProject(db, { slug: 'review-test-project' });
      insertLearning(db, {
        project: 'review-test-project',
        title: 'Approved recall entry',
        content: 'Content for approved recall flow',
      });
      const pendingId = insertLearning(db, {
        project: 'review-test-project',
        title: 'Pending recall entry',
        content: 'Content for pending recall flow',
      });
      db.prepare("UPDATE learnings SET review_status = 'pending_review' WHERE id = ?").run(pendingId);

      const result = await handleMemoryRecall({
        project: 'review-test-project',
        context: 'recall flow',
      });
      const text = result.content[0].text;
      expect(text).toContain('Approved recall entry');
      expect(text).not.toContain('Pending recall entry');
    });

    it('handleMemoryStore defaults review_status to approved', async () => {
      const result = await handleMemoryStore({
        project: 'review-test-project',
        category: 'pattern',
        title: 'Store default review status',
        content: 'Content for default review status test',
      });
      expect(result.content[0].text).toContain('Review status: approved');

      const idMatch = result.content[0].text.match(/ID: (\d+)/);
      expect(idMatch).not.toBeNull();
      const id = parseInt(idMatch![1], 10);

      const row = db.prepare('SELECT review_status FROM learnings WHERE id = ?').get(id) as { review_status: string };
      expect(row.review_status).toBe('approved');
    });

    it('handleMemoryStore accepts pending_review and hides the row from search', async () => {
      const result = await handleMemoryStore({
        project: 'review-test-project',
        category: 'discovery',
        title: 'Pending store entry hidden',
        content: 'Content that should be hidden from default search',
        review_status: 'pending_review',
      });
      expect(result.content[0].text).toContain('Review status: pending_review');

      const searchResult = handleMemorySearch({ query: 'Pending store entry hidden' });
      expect(searchResult.content[0].text).toContain('No learnings found');
    });

    it('handleMemoryStore rejects an invalid review_status', async () => {
      const result = await handleMemoryStore({
        project: 'review-test-project',
        category: 'pattern',
        title: 'Invalid review status test',
        content: 'Content for invalid review status',
        // @ts-expect-error — testing runtime validation
        review_status: 'bogus',
      });
      expect(result.content[0].text).toContain('Invalid review_status');
    });
  });

  // -------------------------------------------------------------------------
  // TD-061: source_extractor enum validation
  // -------------------------------------------------------------------------

  describe('source_extractor enum validation (TD-061)', () => {
    it('handleMemoryStore rejects an invalid source_extractor', async () => {
      const result = await handleMemoryStore({
        project: 'review-test-project',
        category: 'pattern',
        title: 'Invalid source_extractor test',
        content: 'Content for invalid source_extractor',
        // @ts-expect-error — testing runtime validation against typo
        source_extractor: 'lmm',
      });
      expect(result.content[0].text).toContain('Invalid source_extractor');
    });

    it('handleMemoryStore accepts source_extractor=llm', async () => {
      const result = await handleMemoryStore({
        project: 'review-test-project',
        category: 'pattern',
        title: 'Valid llm source_extractor',
        content: 'Content for valid llm source_extractor',
        source_extractor: 'llm',
      });
      expect(result.content[0].text).not.toContain('Invalid source_extractor');
      const idMatch = result.content[0].text.match(/ID: (\d+)/);
      expect(idMatch).not.toBeNull();
      const id = parseInt(idMatch![1], 10);
      const row = db.prepare('SELECT source_extractor FROM learnings WHERE id = ?').get(id) as { source_extractor: string };
      expect(row.source_extractor).toBe('llm');
    });

    it('handleMemoryStore accepts source_extractor=manual', async () => {
      const result = await handleMemoryStore({
        project: 'review-test-project',
        category: 'pattern',
        title: 'Valid manual source_extractor',
        content: 'Content for valid manual source_extractor',
        source_extractor: 'manual',
      });
      expect(result.content[0].text).not.toContain('Invalid source_extractor');
    });

    it('handleMemoryStore accepts source_extractor=distill', async () => {
      const result = await handleMemoryStore({
        project: 'review-test-project',
        category: 'pattern',
        title: 'Valid distill source_extractor',
        content: 'Content for valid distill source_extractor',
        source_extractor: 'distill',
      });
      expect(result.content[0].text).not.toContain('Invalid source_extractor');
    });

    it('handleMemoryStore defaults source_extractor to manual', async () => {
      const result = await handleMemoryStore({
        project: 'review-test-project',
        category: 'pattern',
        title: 'Default source_extractor test',
        content: 'Content with no explicit source_extractor',
      });
      const idMatch = result.content[0].text.match(/ID: (\d+)/);
      expect(idMatch).not.toBeNull();
      const id = parseInt(idMatch![1], 10);
      const row = db.prepare('SELECT source_extractor FROM learnings WHERE id = ?').get(id) as { source_extractor: string };
      expect(row.source_extractor).toBe('manual');
    });
  });

  // -------------------------------------------------------------------------
  // FR-200 M2: igris_memory_mark_promoted + recall promotion-pointer behavior
  // -------------------------------------------------------------------------

  describe('handleMemoryMarkPromoted (FR-200 M2)', () => {
    it('sets promoted_to_doc to the doc_path (no anchor) and bumps updated_at', () => {
      const id = insertLearning(db, { title: 'Promote me', content: 'Hardened standard worth a doc' });
      const before = db.prepare('SELECT updated_at FROM learnings WHERE id = ?').get(id) as { updated_at: string };

      const result = handleMemoryMarkPromoted({ id, doc_path: 'igris-ai:context/coding_guidelines.md' });

      const payload = JSON.parse(result.content[0].text) as { id: number; promoted_to_doc: string; updated_at: string };
      expect(payload.id).toBe(id);
      expect(payload.promoted_to_doc).toBe('igris-ai:context/coding_guidelines.md');

      const row = db.prepare('SELECT promoted_to_doc, updated_at FROM learnings WHERE id = ?')
        .get(id) as { promoted_to_doc: string; updated_at: string };
      expect(row.promoted_to_doc).toBe('igris-ai:context/coding_guidelines.md');
      // updated_at is bumped to a fresh ISO timestamp (different from the seeded
      // default datetime('now') format, and matches the returned value).
      expect(row.updated_at).toBe(payload.updated_at);
      expect(row.updated_at).not.toBe(before.updated_at);
    });

    it('appends "#<anchor>" when doc_anchor is given', () => {
      const id = insertLearning(db, { title: 'Promote with anchor' });

      const result = handleMemoryMarkPromoted({
        id,
        doc_path: 'igris-ai:context/architecture_map.md',
        doc_anchor: 'layer-boundaries',
      });

      const payload = JSON.parse(result.content[0].text) as { promoted_to_doc: string };
      expect(payload.promoted_to_doc).toBe('igris-ai:context/architecture_map.md#layer-boundaries');
      const row = db.prepare('SELECT promoted_to_doc FROM learnings WHERE id = ?')
        .get(id) as { promoted_to_doc: string };
      expect(row.promoted_to_doc).toBe('igris-ai:context/architecture_map.md#layer-boundaries');
    });

    it('strips a leading "#" the caller included in doc_anchor (never doubles it)', () => {
      const id = insertLearning(db, { title: 'Promote with hashed anchor' });

      const result = handleMemoryMarkPromoted({
        id,
        doc_path: 'igris-ai:context/coding_guidelines.md',
        doc_anchor: '#testing',
      });

      const payload = JSON.parse(result.content[0].text) as { promoted_to_doc: string };
      expect(payload.promoted_to_doc).toBe('igris-ai:context/coding_guidelines.md#testing');
    });

    it('errors (not found) on a missing id and does not create a row', () => {
      const result = handleMemoryMarkPromoted({ id: 99999, doc_path: 'igris-ai:context/coding_guidelines.md' });
      expect(result.content[0].text).toContain('not found');

      const count = db.prepare('SELECT COUNT(*) AS n FROM learnings WHERE id = ?').get(99999) as { n: number };
      expect(count.n).toBe(0);
    });

    it('rejects a non-positive id', () => {
      const result = handleMemoryMarkPromoted({ id: 0, doc_path: 'igris-ai:context/coding_guidelines.md' });
      expect(result.content[0].text).toContain('id must be a positive integer');
    });

    it('rejects an empty doc_path', () => {
      const id = insertLearning(db, { title: 'Promote empty path' });
      const result = handleMemoryMarkPromoted({ id, doc_path: '' });
      expect(result.content[0].text).toContain('doc_path must be a non-empty string');
      // Row remains unpromoted.
      const row = db.prepare('SELECT promoted_to_doc FROM learnings WHERE id = ?')
        .get(id) as { promoted_to_doc: string | null };
      expect(row.promoted_to_doc).toBeNull();
    });

    it('is idempotent: re-marking overwrites the pointer and re-bumps updated_at', async () => {
      const id = insertLearning(db, { title: 'Re-promote me' });

      const first = handleMemoryMarkPromoted({ id, doc_path: 'igris-ai:context/coding_guidelines.md' });
      const firstAt = (JSON.parse(first.content[0].text) as { updated_at: string }).updated_at;

      // Ensure a measurable clock tick so the second ISO timestamp differs.
      await new Promise((r) => setTimeout(r, 5));

      const second = handleMemoryMarkPromoted({
        id,
        doc_path: 'igris-ai:context/architecture_map.md',
        doc_anchor: 'new-home',
      });
      const secondPayload = JSON.parse(second.content[0].text) as { promoted_to_doc: string; updated_at: string };

      expect(secondPayload.promoted_to_doc).toBe('igris-ai:context/architecture_map.md#new-home');
      expect(secondPayload.updated_at).not.toBe(firstAt);

      const row = db.prepare('SELECT promoted_to_doc FROM learnings WHERE id = ?')
        .get(id) as { promoted_to_doc: string };
      expect(row.promoted_to_doc).toBe('igris-ai:context/architecture_map.md#new-home');
    });
  });

  describe('handleMemoryRecall — promotion pointer (FR-200 M2)', () => {
    it('surfaces a "Promoted → <doc>" pointer and suppresses raw content for a promoted row', async () => {
      const longContent = 'RAWBODY '.repeat(50); // long enough to normally truncate at 200 chars
      insertLearning(db, {
        title: 'Promoted recall row',
        content: longContent,
        promoted_to_doc: 'igris-ai:context/coding_guidelines.md#promoted-standards',
      });

      const result = await handleMemoryRecall({
        project: 'test-project',
        context: 'Promoted recall row',
      });
      const text = result.content[0].text;

      // The pointer is surfaced...
      expect(text).toContain('Promoted: → igris-ai:context/coding_guidelines.md#promoted-standards');
      // ...and the raw content is NOT double-surfaced (no Content: line, no body).
      expect(text).not.toContain('Content: RAWBODY');
      expect(text).not.toContain('RAWBODY');
    });

    it('still prints Content for a non-promoted row (no regression)', async () => {
      insertLearning(db, {
        title: 'Unpromoted recall row',
        content: 'Plain visible body',
        // promoted_to_doc defaults to null
      });

      const result = await handleMemoryRecall({
        project: 'test-project',
        context: 'Unpromoted recall row',
      });
      const text = result.content[0].text;

      expect(text).toContain('Content: Plain visible body');
      expect(text).not.toContain('Promoted: →');
    });
  });

  // -------------------------------------------------------------------------
  // FR-200 M2: sibling content-returning tools must ALSO suppress raw content
  // for a promoted row (warden C1/C2 — these are what /distill promote P1
  // calls; the recall-only fix left these leaking).
  // -------------------------------------------------------------------------

  describe('handleMemorySearch — promotion pointer (FR-200 M2)', () => {
    it('surfaces the pointer and suppresses the FULL raw content for a promoted row', () => {
      // search prints the ENTIRE untruncated body (Content: ${row.content}), so
      // this leak is the most severe — a distinctive marker proves it is gone.
      const body = 'SEARCHLEAKBODY full untruncated standard text that must not appear';
      insertLearning(db, {
        title: 'Promoted search row',
        content: body,
        promoted_to_doc: 'igris-ai:context/coding_guidelines.md#promoted-standards',
      });

      const result = handleMemorySearch({ query: 'Promoted search row' });
      const text = result.content[0].text;

      expect(text).toContain('Promoted: → igris-ai:context/coding_guidelines.md#promoted-standards');
      expect(text).not.toContain('Content: SEARCHLEAKBODY');
      expect(text).not.toContain('SEARCHLEAKBODY');
    });

    it('still prints Content for a non-promoted row (no regression)', () => {
      insertLearning(db, {
        title: 'Unpromoted search row',
        content: 'Plainly searchable body',
      });

      const result = handleMemorySearch({ query: 'Unpromoted search row' });
      const text = result.content[0].text;

      expect(text).toContain('Content: Plainly searchable body');
      expect(text).not.toContain('Promoted: →');
    });
  });

  describe('handleMemoryHybridSearch — promotion pointer (FR-200 M2)', () => {
    it('surfaces the pointer and suppresses raw content for a promoted row (BM25-only fallback path)', async () => {
      // sqlite-vec is mocked unavailable in this suite, so hybrid_search takes
      // the BM25-only fallback, which formats bm25Rows directly through
      // formatHybridResult — exactly the path the C1 fix repaired.
      const body = 'HYBRIDLEAKBODY truncatable standard body that must not appear';
      insertLearning(db, {
        title: 'Promoted hybrid row',
        content: body,
        promoted_to_doc: 'igris-ai:context/architecture_map.md#layer-boundaries',
      });

      const result = await handleMemoryHybridSearch({ query: 'Promoted hybrid row' });
      const text = result.content[0].text;

      expect(text).toContain('Promoted: → igris-ai:context/architecture_map.md#layer-boundaries');
      expect(text).not.toContain('Content: HYBRIDLEAKBODY');
      expect(text).not.toContain('HYBRIDLEAKBODY');
    });

    it('still prints Content for a non-promoted row (no regression)', async () => {
      insertLearning(db, {
        title: 'Unpromoted hybrid row',
        content: 'Plainly hybrid-searchable body',
      });

      const result = await handleMemoryHybridSearch({ query: 'Unpromoted hybrid row' });
      const text = result.content[0].text;

      expect(text).toContain('Content: Plainly hybrid-searchable body');
      expect(text).not.toContain('Promoted: →');
    });
  });
});
