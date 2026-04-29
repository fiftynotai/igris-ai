/**
 * Perception MCP handler tests (FR-109 Phase C).
 *
 * Covers all six handlers + the parseTranscript helper:
 *   - parseTranscript: JSONL vs plain-text
 *   - submit: persists, advances watermark, returns counts
 *   - review_pending: lists, ttl filter, project filter
 *   - approve: status flip, edit fields, idempotent
 *   - reject: deletes, refuses already-approved
 *   - extract_now: force_llm bypass, no watermark advance by default
 *   - expire_stale: hard-deletes old pending rows
 *
 * @module engine/components/perception/__tests__/handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

vi.mock('../../../../utils/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(384)),
  embeddingToBuffer: vi.fn((e: Float32Array) => Buffer.from(e.buffer, e.byteOffset, e.byteLength)),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DIMENSIONS: 384,
}));

vi.mock('../../../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbedding: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import {
  handlePerceptionApprove,
  handlePerceptionExpireStale,
  handlePerceptionExtractNow,
  handlePerceptionReject,
  handlePerceptionReviewPending,
  handlePerceptionSubmit,
  parseTranscript,
  setHandlerContext,
} from '../handlers.js';
import { DEFAULT_PERCEPTION_CONFIG } from '../types.js';

const mockedGetDb = vi.mocked(getDb);

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      tech_stack TEXT DEFAULT '',
      scope TEXT DEFAULT 'local',
      source_brief TEXT DEFAULT '',
      confidence REAL DEFAULT 0.8,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT,
      embedding BLOB,
      embedding_model TEXT DEFAULT '',
      provenance TEXT NOT NULL DEFAULT 'observed',
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE TABLE perception_watermarks (
      project TEXT PRIMARY KEY,
      last_extracted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

const noopBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };

beforeEach(() => {
  setHandlerContext({
    bus: noopBus,
    config: DEFAULT_PERCEPTION_CONFIG,
    llmExtractor: async () => [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseTranscript
// ---------------------------------------------------------------------------

describe('parseTranscript', () => {
  it('parses a JSONL transcript', () => {
    const text = [
      JSON.stringify({ role: 'user', content: 'hi', timestamp: 't1' }),
      JSON.stringify({ role: 'assistant', content: 'hello', timestamp: 't2' }),
    ].join('\n');
    const events = parseTranscript(text);
    expect(events).toHaveLength(2);
    expect(events[0].role).toBe('user');
    expect(events[1].content).toBe('hello');
  });

  it('falls back to plain-text on a non-JSONL blob', () => {
    const events = parseTranscript('a regular text blob without JSON');
    expect(events).toHaveLength(1);
    expect(events[0].role).toBe('user');
    expect(events[0].content).toContain('regular text');
  });

  it('returns [] for empty input', () => {
    expect(parseTranscript('')).toHaveLength(0);
    expect(parseTranscript('   \n   ')).toHaveLength(0);
  });

  it('preserves tool_name when present', () => {
    const text = JSON.stringify({
      role: 'tool',
      content: 'output',
      timestamp: 't',
      tool_name: 'Read',
    });
    const events = parseTranscript(text);
    expect(events[0].tool_name).toBe('Read');
  });

  it('skips lines that fail to parse mid-stream', () => {
    const text = [
      JSON.stringify({ role: 'user', content: 'a', timestamp: '' }),
      'not-json-junk',
      JSON.stringify({ role: 'assistant', content: 'b', timestamp: '' }),
    ].join('\n');
    const events = parseTranscript(text);
    expect(events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

describe('handlePerceptionSubmit', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
  });
  afterEach(() => db.close());

  it('rejects missing project', async () => {
    const r = await handlePerceptionSubmit({ transcript_text: 'x', source: 's' });
    expect(r.isError).toBe(true);
  });

  it('rejects missing transcript_text', async () => {
    const r = await handlePerceptionSubmit({ project: 'p', source: 's' });
    expect(r.isError).toBe(true);
  });

  it('persists rule candidates and advances watermark', async () => {
    const transcript = [
      JSON.stringify({ role: 'assistant', content: 'LEARNED: use parametrised SQL', timestamp: '' }),
    ].join('\n');

    const r = await handlePerceptionSubmit({
      project: 'p',
      transcript_text: transcript,
      source: 'session_end',
      window_end_ts: '2026-04-29T10:00:00Z',
    });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content[0].text) as Record<string, unknown>;
    expect(out.inserted).toBe(1);
    expect(out.watermark_advanced).toBe(true);
    const watermarkRow = db
      .prepare('SELECT last_extracted_at FROM perception_watermarks WHERE project = ?')
      .get('p') as { last_extracted_at: string };
    expect(watermarkRow.last_extracted_at).toBe('2026-04-29T10:00:00Z');
    const learning = db.prepare('SELECT review_status, provenance FROM learnings').get() as {
      review_status: string;
      provenance: string;
    };
    expect(learning.review_status).toBe('pending_review');
    expect(learning.provenance).toBe('inferred');
  });

  it('rejects oversize transcript', async () => {
    const huge = 'X'.repeat(6 * 1024 * 1024); // 6 MB
    const r = await handlePerceptionSubmit({
      project: 'p',
      transcript_text: huge,
      source: 's',
    });
    expect(r.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// review_pending
// ---------------------------------------------------------------------------

describe('handlePerceptionReviewPending', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
  });
  afterEach(() => db.close());

  it('returns pending rows ordered by confidence DESC', () => {
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, confidence, provenance, review_status) VALUES ('p', 'pattern', 'low', 'lc', 0.4, 'inferred', 'pending_review')",
    ).run();
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, confidence, provenance, review_status) VALUES ('p', 'pattern', 'high', 'hc', 0.8, 'inferred', 'pending_review')",
    ).run();

    const r = handlePerceptionReviewPending({ project: 'p' });
    const out = JSON.parse(r.content[0].text) as { count: number; candidates: Array<{ title: string }> };
    expect(out.count).toBe(2);
    expect(out.candidates[0].title).toBe('high');
    expect(out.candidates[1].title).toBe('low');
  });

  it('hides approved rows', () => {
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, provenance, review_status) VALUES ('p', 'pattern', 'a', 'b', 'observed', 'approved')",
    ).run();
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, provenance, review_status) VALUES ('p', 'pattern', 'c', 'd', 'inferred', 'pending_review')",
    ).run();

    const r = handlePerceptionReviewPending({});
    const out = JSON.parse(r.content[0].text) as { count: number };
    expect(out.count).toBe(1);
  });

  it('lazy-on-read TTL filter excludes very old rows', () => {
    // Force a created_at far enough in the past to exceed the default 14 day TTL
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, created_at, provenance, review_status) VALUES ('p', 'pattern', 'old', 'b', datetime('now', '-30 days'), 'inferred', 'pending_review')",
    ).run();
    const r = handlePerceptionReviewPending({});
    const out = JSON.parse(r.content[0].text) as { count: number };
    expect(out.count).toBe(0);
  });

  it('respects project filter', () => {
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, provenance, review_status) VALUES ('a', 'pattern', 't1', 'b', 'inferred', 'pending_review')",
    ).run();
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, provenance, review_status) VALUES ('b', 'pattern', 't2', 'b', 'inferred', 'pending_review')",
    ).run();
    const r = handlePerceptionReviewPending({ project: 'a' });
    const out = JSON.parse(r.content[0].text) as { count: number };
    expect(out.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

describe('handlePerceptionApprove', () => {
  let db: Database.Database;
  let id: number;
  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
    const result = db
      .prepare(
        "INSERT INTO learnings (project, category, title, content, provenance, review_status) VALUES ('p', 'pattern', 't', 'c', 'inferred', 'pending_review')",
      )
      .run();
    id = result.lastInsertRowid as number;
  });
  afterEach(() => db.close());

  it('flips status to approved', () => {
    handlePerceptionApprove({ learning_id: id });
    const row = db.prepare('SELECT review_status, provenance FROM learnings WHERE id = ?').get(id) as {
      review_status: string;
      provenance: string;
    };
    expect(row.review_status).toBe('approved');
    expect(row.provenance).toBe('inferred'); // permanent
  });

  it('applies edits before flipping status', () => {
    handlePerceptionApprove({
      learning_id: id,
      edit: {
        title: 'edited title',
        content: 'edited content',
        confidence: 0.95,
        category: 'decision',
        tags: ['a', 'b'],
        tech_stack: 'typescript',
      },
    });
    const row = db.prepare('SELECT * FROM learnings WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.title).toBe('edited title');
    expect(row.content).toBe('edited content');
    expect(row.confidence).toBe(0.95);
    expect(row.category).toBe('decision');
    expect(row.tags).toBe('a,b');
    expect(row.tech_stack).toBe('typescript');
    expect(row.review_status).toBe('approved');
  });

  it('rejects unsupported edit fields', () => {
    const r = handlePerceptionApprove({
      learning_id: id,
      edit: { project: 'malicious' },
    });
    expect(r.isError).toBe(true);
  });

  it('rejects invalid category', () => {
    const r = handlePerceptionApprove({
      learning_id: id,
      edit: { category: 'gossip' },
    });
    expect(r.isError).toBe(true);
  });

  it('rejects invalid confidence', () => {
    const r = handlePerceptionApprove({
      learning_id: id,
      edit: { confidence: 1.5 },
    });
    expect(r.isError).toBe(true);
  });

  it('is idempotent on already-approved rows', () => {
    db.prepare("UPDATE learnings SET review_status = 'approved' WHERE id = ?").run(id);
    const r = handlePerceptionApprove({ learning_id: id });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content[0].text) as { updated: boolean };
    expect(out.updated).toBe(false);
  });

  it('rejects missing or invalid id', () => {
    expect(handlePerceptionApprove({}).isError).toBe(true);
    expect(handlePerceptionApprove({ learning_id: 0 }).isError).toBe(true);
    expect(handlePerceptionApprove({ learning_id: -1 }).isError).toBe(true);
    expect(handlePerceptionApprove({ learning_id: 'x' }).isError).toBe(true);
  });

  it('returns error when learning not found', () => {
    const r = handlePerceptionApprove({ learning_id: 9999 });
    expect(r.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

describe('handlePerceptionReject', () => {
  let db: Database.Database;
  let id: number;
  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
    id = (
      db
        .prepare(
          "INSERT INTO learnings (project, category, title, content, provenance, review_status) VALUES ('p', 'pattern', 't', 'c', 'inferred', 'pending_review')",
        )
        .run().lastInsertRowid as number
    );
  });
  afterEach(() => db.close());

  it('hard-deletes a pending row', () => {
    const r = handlePerceptionReject({ learning_id: id, reason: 'noisy' });
    expect(r.isError).toBeFalsy();
    const after = db.prepare('SELECT id FROM learnings WHERE id = ?').get(id);
    expect(after).toBeUndefined();
  });

  it('refuses to delete an already-approved row', () => {
    db.prepare("UPDATE learnings SET review_status = 'approved' WHERE id = ?").run(id);
    const r = handlePerceptionReject({ learning_id: id });
    expect(r.isError).toBe(true);
  });

  it('rejects missing id', () => {
    expect(handlePerceptionReject({}).isError).toBe(true);
  });

  it('returns error when learning not found', () => {
    const r = handlePerceptionReject({ learning_id: 9999 });
    expect(r.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extract_now
// ---------------------------------------------------------------------------

describe('handlePerceptionExtractNow', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
  });
  afterEach(() => db.close());

  it('extracts from inline transcript', async () => {
    const transcript = [
      JSON.stringify({ role: 'assistant', content: 'LEARNED: x', timestamp: '' }),
    ].join('\n');
    const r = await handlePerceptionExtractNow({
      project: 'p',
      transcript_text: transcript,
    });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content[0].text) as Record<string, unknown>;
    expect(out.inserted).toBe(1);
    expect(out.watermark_advanced).toBe(false); // default
  });

  it('advances watermark when advance_watermark=true', async () => {
    const transcript = [
      JSON.stringify({ role: 'assistant', content: 'LEARNED: y', timestamp: '' }),
    ].join('\n');
    await handlePerceptionExtractNow({
      project: 'p',
      transcript_text: transcript,
      advance_watermark: true,
    });
    const watermarkRow = db
      .prepare('SELECT last_extracted_at FROM perception_watermarks WHERE project = ?')
      .get('p') as { last_extracted_at: string } | undefined;
    expect(watermarkRow).toBeDefined();
  });

  it('rejects missing project', async () => {
    const r = await handlePerceptionExtractNow({ transcript_text: 'x' });
    expect(r.isError).toBe(true);
  });

  it('rejects missing transcript_text', async () => {
    const r = await handlePerceptionExtractNow({ project: 'p' });
    expect(r.isError).toBe(true);
  });

  it('force_llm flag passes through to runner gate', async () => {
    const stubLlm = vi.fn(async () => []);
    setHandlerContext({
      bus: noopBus,
      config: { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_min_transcript_bytes: 1024 },
      llmExtractor: stubLlm,
    });
    const transcript = JSON.stringify({ role: 'user', content: 'tiny', timestamp: '' });
    const r = await handlePerceptionExtractNow({
      project: 'p',
      transcript_text: transcript,
      force_llm: true,
    });
    expect(r.isError).toBeFalsy();
    expect(stubLlm).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// expire_stale
// ---------------------------------------------------------------------------

describe('handlePerceptionExpireStale', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
  });
  afterEach(() => db.close());

  it('deletes pending rows older than ttl_days', () => {
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, created_at, provenance, review_status) VALUES ('p', 'pattern', 'old', 'c', datetime('now', '-30 days'), 'inferred', 'pending_review')",
    ).run();
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, provenance, review_status) VALUES ('p', 'pattern', 'fresh', 'c', 'inferred', 'pending_review')",
    ).run();

    const r = handlePerceptionExpireStale({ ttl_days: 14 });
    const out = JSON.parse(r.content[0].text) as { expired: number };
    expect(out.expired).toBe(1);
    const remaining = db.prepare('SELECT title FROM learnings').all() as Array<{ title: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('fresh');
  });

  it('does not delete approved rows', () => {
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, created_at, provenance, review_status) VALUES ('p', 'pattern', 'old-approved', 'c', datetime('now', '-30 days'), 'observed', 'approved')",
    ).run();
    handlePerceptionExpireStale({ ttl_days: 14 });
    const remaining = db.prepare('SELECT count(*) AS n FROM learnings').get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it('respects project filter', () => {
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, created_at, provenance, review_status) VALUES ('a', 'pattern', 'p1', 'c', datetime('now', '-30 days'), 'inferred', 'pending_review')",
    ).run();
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, created_at, provenance, review_status) VALUES ('b', 'pattern', 'p2', 'c', datetime('now', '-30 days'), 'inferred', 'pending_review')",
    ).run();
    handlePerceptionExpireStale({ ttl_days: 14, project: 'a' });
    const remaining = db.prepare('SELECT project FROM learnings').all() as Array<{ project: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].project).toBe('b');
  });

  it('rejects negative ttl', () => {
    const r = handlePerceptionExpireStale({ ttl_days: -1 });
    expect(r.isError).toBe(true);
  });
});
