/**
 * TD-086 — perception/dedup.ts unit tests.
 *
 * Covers the cheap-dedup helper in isolation, with the embedding pipeline
 * and sqlite-vec stubbed out so the test does not need to load the
 * Xenova/all-MiniLM-L6-v2 model or load the native vec0 extension.
 *
 * Test paths:
 *   T1 vec0 unavailable -> returns null without generating an embedding
 *   T2 No neighbours    -> returns null
 *   T3 Approved match   -> returns DedupMatch with status=approved
 *   T4 Pending match    -> returns DedupMatch with status=pending_review
 *   T5 Sub-threshold    -> returns null even when a neighbour exists
 *   T6 Orphan vec row   -> skips the orphan, returns next valid match
 *   T7 Embedding throws -> returns null gracefully
 *   T8 vectorSearch throws -> returns null gracefully
 *   T9 recordRediscovery -> bumps counter and stamps last_seen_at
 *
 * @module engine/components/perception/__tests__/dedup.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { PerceptionCandidate } from '../types.js';

// ---------------------------------------------------------------------------
// Mocks — declared before the SUT import so vitest hoists them correctly.
// ---------------------------------------------------------------------------

vi.mock('../../../../utils/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(384)),
  embeddingToBuffer: vi.fn((e: Float32Array) =>
    Buffer.from(e.buffer, e.byteOffset, e.byteLength),
  ),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DIMENSIONS: 384,
}));

vi.mock('../../../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => true),
  vectorSearch: vi.fn(() => []),
  insertEmbedding: vi.fn(),
}));

import { generateEmbedding } from '../../../../utils/embeddings.js';
import { isVectorSearchAvailable, vectorSearch } from '../../../../utils/vector-search.js';
import { findNearestMatch, recordRediscovery, type DedupMatch } from '../dedup.js';

const mockedIsVectorSearchAvailable = vi.mocked(isVectorSearchAvailable);
const mockedVectorSearch = vi.mocked(vectorSearch);
const mockedGenerateEmbedding = vi.mocked(generateEmbedding);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'pattern',
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      review_status TEXT NOT NULL DEFAULT 'approved',
      seen_again_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function makeCandidate(over: Partial<PerceptionCandidate> = {}): PerceptionCandidate {
  return {
    category: 'pattern',
    title: 'A new finding from the LLM',
    content: 'Some body content describing the finding.',
    tags: [],
    confidence: 0.7,
    source_extractor: 'llm',
    evidence: {},
    ...over,
  };
}

/**
 * Distance for a target cosine similarity (under unit-vector geometry):
 *   cosine = 1 - L2² / 2  ->  L2 = sqrt(2 * (1 - cosine))
 *
 * Tests use this to fabricate vec0 results that produce a known cosine.
 */
function distanceForCosine(cosine: number): number {
  return Math.sqrt(2 * (1 - cosine));
}

function insertLearning(
  db: Database.Database,
  args: {
    title: string;
    review_status?: string;
    project?: string;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO learnings (project, title, review_status)
       VALUES (?, ?, ?)`,
    )
    .run(args.project ?? 'p', args.title, args.review_status ?? 'approved');
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// findNearestMatch
// ---------------------------------------------------------------------------

describe('findNearestMatch', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedIsVectorSearchAvailable.mockReturnValue(true);
    mockedVectorSearch.mockReturnValue([]);
    mockedGenerateEmbedding.mockClear();
    mockedGenerateEmbedding.mockResolvedValue(new Float32Array(384));
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it('T1: returns null when sqlite-vec is unavailable, without generating an embedding', async () => {
    mockedIsVectorSearchAvailable.mockReturnValue(false);
    const result = await findNearestMatch(db, makeCandidate(), 0.85);
    expect(result).toBeNull();
    expect(mockedGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockedVectorSearch).not.toHaveBeenCalled();
  });

  it('T2: returns null when vectorSearch yields no neighbours', async () => {
    mockedVectorSearch.mockReturnValue([]);
    const result = await findNearestMatch(db, makeCandidate(), 0.85);
    expect(result).toBeNull();
    expect(mockedGenerateEmbedding).toHaveBeenCalledTimes(1);
  });

  it('T3: returns approved match when a neighbour crosses threshold', async () => {
    const id = insertLearning(db, { title: 'existing approved', review_status: 'approved' });
    // L2 distance for cosine=0.95 (well above 0.85 default).
    mockedVectorSearch.mockReturnValue([
      { rowid: id, distance: distanceForCosine(0.95) },
    ]);

    const result = await findNearestMatch(db, makeCandidate(), 0.85);
    expect(result).not.toBeNull();
    const match = result as DedupMatch;
    expect(match.matched_id).toBe(id);
    expect(match.status).toBe('approved');
    expect(match.similarity).toBeGreaterThanOrEqual(0.94);
    expect(match.similarity).toBeLessThanOrEqual(0.96);
  });

  it('T4: returns pending_review match when neighbour crosses threshold', async () => {
    const id = insertLearning(db, { title: 'existing pending', review_status: 'pending_review' });
    mockedVectorSearch.mockReturnValue([
      { rowid: id, distance: distanceForCosine(0.92) },
    ]);

    const result = await findNearestMatch(db, makeCandidate(), 0.85);
    expect(result).not.toBeNull();
    const match = result as DedupMatch;
    expect(match.matched_id).toBe(id);
    expect(match.status).toBe('pending_review');
  });

  it('T5: returns null when nearest neighbour is below threshold', async () => {
    const id = insertLearning(db, { title: 'distant row', review_status: 'approved' });
    // cosine=0.70, threshold=0.85 -> sub-threshold.
    mockedVectorSearch.mockReturnValue([
      { rowid: id, distance: distanceForCosine(0.7) },
    ]);

    const result = await findNearestMatch(db, makeCandidate(), 0.85);
    expect(result).toBeNull();
  });

  it('T6: skips orphan vec rows (vec exists but learnings row deleted) and returns next valid match', async () => {
    // The first neighbour is an orphan id (no learnings row). The second is
    // a real row above threshold. Helper must skip the orphan and return
    // the real match instead of falling through to null.
    const realId = insertLearning(db, { title: 'real row', review_status: 'approved' });
    const orphanId = 9999; // no learnings row with this id
    mockedVectorSearch.mockReturnValue([
      { rowid: orphanId, distance: distanceForCosine(0.99) },
      { rowid: realId, distance: distanceForCosine(0.90) },
    ]);

    const result = await findNearestMatch(db, makeCandidate(), 0.85);
    expect(result).not.toBeNull();
    const match = result as DedupMatch;
    expect(match.matched_id).toBe(realId);
    expect(match.status).toBe('approved');
  });

  it('T7: returns null gracefully when generateEmbedding throws', async () => {
    mockedGenerateEmbedding.mockRejectedValueOnce(new Error('pipeline boom'));
    const result = await findNearestMatch(db, makeCandidate(), 0.85);
    expect(result).toBeNull();
    expect(mockedVectorSearch).not.toHaveBeenCalled();
  });

  it('T8: returns null gracefully when vectorSearch throws', async () => {
    mockedVectorSearch.mockImplementationOnce(() => {
      throw new Error('vec0 unavailable');
    });
    const result = await findNearestMatch(db, makeCandidate(), 0.85);
    expect(result).toBeNull();
  });

  it('threshold tuning: 0.99 rejects what 0.85 accepted', async () => {
    const id = insertLearning(db, { title: 'borderline', review_status: 'approved' });
    mockedVectorSearch.mockReturnValue([
      { rowid: id, distance: distanceForCosine(0.90) },
    ]);

    const lenient = await findNearestMatch(db, makeCandidate(), 0.85);
    expect(lenient).not.toBeNull();

    const strict = await findNearestMatch(db, makeCandidate(), 0.99);
    expect(strict).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordRediscovery
// ---------------------------------------------------------------------------

describe('recordRediscovery', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('T9: bumps seen_again_count and stamps last_seen_at on the matched row', () => {
    const id = insertLearning(db, { title: 'row to bump' });
    // Pre-condition.
    const before = db
      .prepare('SELECT seen_again_count, last_seen_at FROM learnings WHERE id = ?')
      .get(id) as { seen_again_count: number; last_seen_at: string | null };
    expect(before.seen_again_count).toBe(0);
    expect(before.last_seen_at).toBeNull();

    recordRediscovery(db, id);

    const after = db
      .prepare('SELECT seen_again_count, last_seen_at FROM learnings WHERE id = ?')
      .get(id) as { seen_again_count: number; last_seen_at: string | null };
    expect(after.seen_again_count).toBe(1);
    expect(after.last_seen_at).not.toBeNull();
    // SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS'.
    expect(after.last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('multiple calls accumulate', () => {
    const id = insertLearning(db, { title: 'frequent rediscovery' });
    recordRediscovery(db, id);
    recordRediscovery(db, id);
    recordRediscovery(db, id);

    const row = db
      .prepare('SELECT seen_again_count FROM learnings WHERE id = ?')
      .get(id) as { seen_again_count: number };
    expect(row.seen_again_count).toBe(3);
  });

  it('does not touch updated_at (rediscovery is a counter bump, not an edit)', () => {
    const id = insertLearning(db, { title: 'preserve updated_at' });
    const before = db
      .prepare('SELECT updated_at FROM learnings WHERE id = ?')
      .get(id) as { updated_at: string };
    recordRediscovery(db, id);
    const after = db
      .prepare('SELECT updated_at FROM learnings WHERE id = ?')
      .get(id) as { updated_at: string };
    expect(after.updated_at).toBe(before.updated_at);
  });
});
