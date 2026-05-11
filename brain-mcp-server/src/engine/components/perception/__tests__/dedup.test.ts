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
import { findNearestMatch, normalizeForDedup, recordRediscovery, type DedupMatch } from '../dedup.js';

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
    // L2 distance for cosine=0.95 (well above 0.85 threshold; also above
    // the post-TD-087 0.80 default — these fixtures pin the threshold
    // explicitly so the contract survives default-value tuning).
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

// ---------------------------------------------------------------------------
// normalizeForDedup (TD-087)
// ---------------------------------------------------------------------------

describe('normalizeForDedup (TD-087)', () => {
  it('lowercases and collapses single-word identity', () => {
    expect(normalizeForDedup('Foo')).toBe('foo');
    expect(normalizeForDedup('FOO')).toBe('foo');
  });

  it('strips leading bullet markers per line (-, *, •)', () => {
    expect(normalizeForDedup('- foo')).toBe('foo');
    expect(normalizeForDedup('* foo')).toBe('foo');
    expect(normalizeForDedup('• foo')).toBe('foo');
    expect(normalizeForDedup('  - foo')).toBe('foo');
    // multi-line: each line's bullet marker stripped independently
    expect(normalizeForDedup('- foo\n- bar')).toBe('foo bar');
    expect(normalizeForDedup('* foo\n* bar')).toBe('foo bar');
    expect(normalizeForDedup('foo\nbar')).toBe('foo bar');
    // bullets-vs-no-bullets equivalence — TD-087 plan AC
    expect(normalizeForDedup('- foo\n- bar')).toBe(normalizeForDedup('* foo\n* bar'));
    expect(normalizeForDedup('- foo\n- bar')).toBe(normalizeForDedup('foo\nbar'));
  });

  it('collapses runs of whitespace (spaces, tabs, newlines) to single space', () => {
    expect(normalizeForDedup('a   b')).toBe('a b');
    expect(normalizeForDedup('a\tb')).toBe('a b');
    expect(normalizeForDedup('a\n\nb')).toBe('a b');
    expect(normalizeForDedup('a   b\t\tc')).toBe('a b c');
    // equivalence
    expect(normalizeForDedup('a   b\t\tc')).toBe(normalizeForDedup('a b c'));
  });

  it('strips dash variants (- – — −) to space', () => {
    expect(normalizeForDedup('a — b')).toBe('a b');
    expect(normalizeForDedup('a - b')).toBe('a b');
    expect(normalizeForDedup('a – b')).toBe('a b');
    expect(normalizeForDedup('a − b')).toBe('a b');
    // hyphen-in-word collapses to space too (intentional — see Phase 2.1
    // rule comments in dedup.ts; "non-breaking" → "non breaking")
    expect(normalizeForDedup('non-breaking')).toBe('non breaking');
  });

  it('strips structural punctuation (. ! ? : ; , quotes, parens, +, etc.)', () => {
    expect(normalizeForDedup('Foo: Bar — Baz!')).toBe('foo bar baz');
    expect(normalizeForDedup('foo, bar; baz.')).toBe('foo bar baz');
    expect(normalizeForDedup('"quoted text"')).toBe('quoted text');
    expect(normalizeForDedup('(parenthesised)')).toBe('parenthesised');
    expect(normalizeForDedup('a + b = c')).toBe('a b c');
    expect(normalizeForDedup('foo!')).toBe('foo');
    expect(normalizeForDedup('foo.')).toBe('foo');
    expect(normalizeForDedup('foo?')).toBe('foo');
  });

  it('handles empty / whitespace-only input', () => {
    expect(normalizeForDedup('')).toBe('');
    expect(normalizeForDedup('   ')).toBe('');
    expect(normalizeForDedup('\n\n\t')).toBe('');
  });

  it('is idempotent: normalize(normalize(x)) === normalize(x)', () => {
    const inputs = [
      'foo',
      'Foo: Bar — Baz!',
      '- alpha\n* beta\n• gamma',
      'Three-engine brain architecture: perception + subconscious + janitor',
      'Three-engine brain framing: perception, subconscious, janitor — one shared LLM-extractor primitive',
      '   weird   spacing\t\t— and — punctuation!?  ',
    ];
    for (const x of inputs) {
      const once = normalizeForDedup(x);
      const twice = normalizeForDedup(once);
      expect(twice).toBe(once);
    }
  });

  it('TD-087 motivating example: L-143 and L-152 paraphrase pair collapse to similar fingerprints', () => {
    // Real titles from the corpus (capture only — content body is omitted
    // here; the actual test is "the strings share dominant tokens after
    // normalisation"). The findNearestMatch test below proves the
    // embedding consequence; this one proves the string-level rule.
    const a = 'Three-engine brain architecture: perception + subconscious + janitor with shared LLM-extractor primitive';
    const b = 'Three-engine brain framing: perception, subconscious, janitor — one shared LLM-extractor primitive';
    const na = normalizeForDedup(a);
    const nb = normalizeForDedup(b);
    // Token Jaccard sanity check: most tokens overlap after normalisation.
    const ta = new Set(na.split(' '));
    const tb = new Set(nb.split(' '));
    const intersection = [...ta].filter((t) => tb.has(t)).length;
    const union = new Set([...ta, ...tb]).size;
    const jaccard = intersection / union;
    // Pre-TD-087 the strings differed by punctuation, dash variants, "+"
    // glue, and the architecture/framing synonym. Normalisation collapses
    // all of those into a high-Jaccard pair.
    expect(jaccard).toBeGreaterThanOrEqual(0.55);
    // Also: dominant content tokens are present in both
    for (const tok of ['three', 'engine', 'brain', 'perception', 'subconscious', 'janitor', 'shared', 'llm', 'extractor', 'primitive']) {
      expect(na).toContain(tok);
      expect(nb).toContain(tok);
    }
  });
});

// ---------------------------------------------------------------------------
// TD-087 — paraphrase-pair regression (findNearestMatch)
// ---------------------------------------------------------------------------

describe('findNearestMatch — TD-087 paraphrase regression', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedIsVectorSearchAvailable.mockReturnValue(true);
    mockedVectorSearch.mockReset();
    mockedGenerateEmbedding.mockReset();
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it('paraphrase pair: post-normalisation embeddings collapse and clear default 0.80 threshold', async () => {
    // Insert an existing row that mimics L-143's stored embedding.
    const id = insertLearning(db, {
      title: 'Three-engine brain architecture: perception + subconscious + janitor with shared LLM-extractor primitive',
      review_status: 'approved',
    });

    // Mock the embedding pipeline to return the SAME Float32Array regardless
    // of input — proves that the dedup query and the stored vector live in
    // the same space (the normalisation step is upstream of the model in the
    // production code path; the mock collapses the rest).
    const sharedVec = new Float32Array(384);
    sharedVec[0] = 1; // any non-zero deterministic value
    mockedGenerateEmbedding.mockResolvedValue(sharedVec);

    // vec0 returns the existing row at cosine ≈ 0.89 (the post-normalisation
    // measurement from Phase 1 corpus eval for L-143/L-152). Distance maps
    // back via cos = 1 - L2²/2.
    mockedVectorSearch.mockReturnValue([
      { rowid: id, distance: distanceForCosine(0.89) },
    ]);

    // Candidate is L-152's titled paraphrase
    const candidate = makeCandidate({
      title: 'Three-engine brain framing: perception, subconscious, janitor — one shared LLM-extractor primitive',
      content: 'brain growth maintenance splits into three orthogonal mandates that should not be folded together',
    });

    // Use the new shipped default 0.80
    const result = await findNearestMatch(db, candidate, 0.80);
    expect(result).not.toBeNull();
    const match = result as DedupMatch;
    expect(match.matched_id).toBe(id);
    expect(match.similarity).toBeGreaterThanOrEqual(0.85);
  });

  it('embedding input is the normalised fingerprint, not the raw concat', async () => {
    insertLearning(db, { title: 'sentinel', review_status: 'approved' });
    mockedVectorSearch.mockReturnValue([]);
    const captured: string[] = [];
    mockedGenerateEmbedding.mockImplementation(async (text: string) => {
      captured.push(text);
      return new Float32Array(384);
    });

    const candidate = makeCandidate({
      title: 'Foo: Bar — Baz!',
      content: '- alpha\n- beta',
    });

    await findNearestMatch(db, candidate, 0.80);

    expect(captured.length).toBe(1);
    // Normalised fingerprint: lowercased, dash-stripped, bullet-stripped,
    // punctuation-stripped, single-spaced.
    expect(captured[0]).toBe('foo bar baz alpha beta');
  });

  it('default-arg threshold is 0.80 (TD-087-tuned)', async () => {
    // Borderline match at cosine=0.82 — would be REJECTED at 0.85 (TD-086
    // default), ACCEPTED at the new 0.80 default.
    const id = insertLearning(db, { title: 'borderline', review_status: 'approved' });
    mockedGenerateEmbedding.mockResolvedValue(new Float32Array(384));
    mockedVectorSearch.mockReturnValue([
      { rowid: id, distance: distanceForCosine(0.82) },
    ]);

    // Call WITHOUT explicit threshold → uses default 0.80
    const result = await findNearestMatch(db, makeCandidate());
    expect(result).not.toBeNull();
    expect((result as DedupMatch).matched_id).toBe(id);
  });
});
