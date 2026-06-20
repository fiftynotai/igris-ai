/**
 * Perception channel — end-to-end integration tests (FR-109 + TD-066).
 *
 * Drives the full pipeline:
 *   submit -> LLM extraction -> dedupe -> persist
 *   review_pending -> approve -> recall now sees the row
 *   reject -> row is hard-deleted
 *
 * Plus regression tests for:
 *   - source_extractor persistence across approval
 *   - Risk #3: legacy `rule:*` rows remain visible to review_pending
 *
 * @module engine/components/perception/__tests__/integration.test
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
  bufferToEmbedding: vi.fn(),
  isEmbeddingAvailable: vi.fn(() => true),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DIMENSIONS: 384,
}));

vi.mock('../../../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbedding: vi.fn(),
  vectorSearch: vi.fn(() => []),
}));

import { getDb } from '../../../../db.js';
import {
  handlePerceptionApprove,
  handlePerceptionReject,
  handlePerceptionReviewPending,
  handlePerceptionSubmit,
  setHandlerContext,
} from '../handlers.js';
import { handleMemoryRecall, handleMemorySearch } from '../../../../tools/memory.js';
import { DEFAULT_PERCEPTION_CONFIG, type PerceptionCandidate } from '../types.js';

const mockedGetDb = vi.mocked(getDb);

function makeFullSchemaDb(): Database.Database {
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
      status TEXT DEFAULT 'active',
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
      embedding BLOB,
      embedding_model TEXT DEFAULT '',
      provenance TEXT NOT NULL DEFAULT 'observed'
        CHECK(provenance IN ('observed','inferred','synthesized','ambiguous','human_asserted')),
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual',
      -- FR-200 M2: nullable promotion pointer (db.ts v16); recall/search SELECT it.
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
    -- trigger (vec0 rejects writes from trigger context under
    -- trusted_schema=OFF). The handlers own explicit cleanup. This fixture
    -- doesn't create the learnings_vec table at all (no sqlite-vec loaded
    -- in this suite) so there's nothing to mirror — but DO NOT add the
    -- trigger here.

    CREATE TABLE perception_watermarks (
      project TEXT PRIMARY KEY,
      last_extracted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO projects (slug, name, path) VALUES ('p', 'Test Project', '/tmp/p');
  `);
  return db;
}

const noopBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };

/** Default config tuned for tests: bytes gate floored so any non-empty content triggers LLM. */
const TEST_CONFIG = {
  ...DEFAULT_PERCEPTION_CONFIG,
  extractor_llm_enabled: true,
  llm_min_transcript_bytes: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Perception channel — end-to-end', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeFullSchemaDb();
    mockedGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
  });

  it('submit -> review -> approve -> recall sees the row', async () => {
    setHandlerContext({
      bus: noopBus,
      config: TEST_CONFIG,
      llmExtractor: async (): Promise<PerceptionCandidate[]> => [
        {
          category: 'pattern',
          title: 'parametrise SQL queries in better-sqlite3 to avoid injection',
          content: 'Always use parameterised SQL queries to avoid SQL injection.',
          tags: ['sql', 'security'],
          confidence: 0.7,
          source_extractor: 'llm',
          evidence: { transcript_excerpt: 'parametrise SQL' },
        },
      ],
    });

    const transcript = JSON.stringify({
      role: 'assistant',
      content: 'discussion about parametrise SQL queries in better-sqlite3 to avoid injection',
      timestamp: '2026-04-29T10:00:00Z',
    });

    // 1. Submit
    const submitResult = await handlePerceptionSubmit({
      project: 'p',
      transcript_text: transcript,
      source: 'session_end',
      window_end_ts: '2026-04-29T10:00:00Z',
    });
    expect(submitResult.isError).toBeFalsy();
    const submitOut = JSON.parse(submitResult.content[0].text) as Record<string, unknown>;
    expect(submitOut.inserted).toBe(1);

    // 2. recall does NOT see the pending row
    const recallBefore = await handleMemoryRecall({
      project: 'p',
      context: 'parametrise SQL injection',
    });
    expect(recallBefore.content[0].text).toContain('No relevant learnings');

    // 3. search does NOT see the pending row either
    const searchBefore = handleMemorySearch({ query: 'parametrise SQL injection' });
    expect(searchBefore.content[0].text).toContain('No learnings found');

    // 4. review_pending DOES see it
    const reviewResult = handlePerceptionReviewPending({ project: 'p' });
    const reviewOut = JSON.parse(reviewResult.content[0].text) as {
      count: number;
      candidates: Array<{ id: number; title: string }>;
    };
    expect(reviewOut.count).toBe(1);
    const learningId = reviewOut.candidates[0].id;

    // 5. Approve flips status
    const approveResult = handlePerceptionApprove({ learning_id: learningId });
    expect(approveResult.isError).toBeFalsy();

    // 6. recall NOW sees the row
    const recallAfter = await handleMemoryRecall({
      project: 'p',
      context: 'parametrise SQL injection',
    });
    expect(recallAfter.content[0].text).toContain('parametrise SQL');

    // 7. provenance permanence: still 'inferred' even after approval
    const row = db.prepare('SELECT provenance, review_status FROM learnings WHERE id = ?').get(learningId) as {
      provenance: string;
      review_status: string;
    };
    expect(row.provenance).toBe('inferred');
    expect(row.review_status).toBe('approved');
  });

  it('reject deletes the row entirely', async () => {
    setHandlerContext({
      bus: noopBus,
      config: TEST_CONFIG,
      llmExtractor: async (): Promise<PerceptionCandidate[]> => [
        {
          category: 'pattern',
          title: 'noisy and not useful',
          content: 'should be rejected',
          tags: [],
          confidence: 0.4,
          source_extractor: 'llm',
          evidence: { transcript_excerpt: 'noisy' },
        },
      ],
    });

    await handlePerceptionSubmit({
      project: 'p',
      transcript_text: JSON.stringify({
        role: 'assistant',
        content: 'noisy content body',
        timestamp: '',
      }),
      source: 'session_end',
    });

    const reviewBefore = handlePerceptionReviewPending({ project: 'p' });
    const id = (JSON.parse(reviewBefore.content[0].text) as { candidates: Array<{ id: number }> })
      .candidates[0].id;

    const rejectResult = handlePerceptionReject({ learning_id: id, reason: 'noisy' });
    expect(rejectResult.isError).toBeFalsy();

    const reviewAfter = handlePerceptionReviewPending({ project: 'p' });
    expect((JSON.parse(reviewAfter.content[0].text) as { count: number }).count).toBe(0);

    // Confirm the row is gone — not just hidden.
    const row = db.prepare('SELECT id FROM learnings WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  it('LLM extractor + dedupe handles overlapping titles within a single window', async () => {
    const stubLlm = vi.fn(async (): Promise<PerceptionCandidate[]> => [
      {
        category: 'pattern',
        title: 'Shared finding',
        content: 'first phrasing',
        tags: ['llm-test'],
        confidence: 0.5,
        source_extractor: 'llm',
        evidence: { transcript_excerpt: 'one' },
      },
      {
        category: 'pattern',
        title: 'shared finding', // same after normalize
        content: 'second phrasing',
        tags: ['llm-test'],
        confidence: 0.85,
        source_extractor: 'llm',
        evidence: { transcript_excerpt: 'two' },
      },
      {
        category: 'pattern',
        title: 'Unique finding',
        content: 'distinct',
        tags: ['llm-test'],
        confidence: 0.7,
        source_extractor: 'llm',
        evidence: { transcript_excerpt: 'three' },
      },
    ]);

    setHandlerContext({
      bus: noopBus,
      config: TEST_CONFIG,
      llmExtractor: stubLlm,
    });

    const result = await handlePerceptionSubmit({
      project: 'p',
      transcript_text: JSON.stringify({
        role: 'assistant',
        content: 'X'.repeat(2000),
        timestamp: '',
      }),
      source: 'session_end',
    });
    const out = JSON.parse(result.content[0].text) as {
      llm_extracted: number;
      suppressed: number;
      inserted: number;
      llm_status: string;
      by_source: Record<string, number>;
    };

    expect(stubLlm).toHaveBeenCalledTimes(1);
    expect(out.llm_status).toBe('ran');
    expect(out.llm_extracted).toBe(3);
    expect(out.suppressed).toBe(1);
    expect(out.inserted).toBe(2);
    expect(out.by_source.llm).toBe(2);
  });

  it('regression: pending rows never returned by recall, search, or hybrid', async () => {
    setHandlerContext({
      bus: noopBus,
      config: TEST_CONFIG,
      llmExtractor: async (): Promise<PerceptionCandidate[]> => [
        {
          category: 'pattern',
          title: 'regression check pattern phrase',
          content: 'still pending — should not appear in conscious channel',
          tags: [],
          confidence: 0.6,
          source_extractor: 'llm',
          evidence: { transcript_excerpt: 'snippet' },
        },
      ],
    });

    await handlePerceptionSubmit({
      project: 'p',
      transcript_text: JSON.stringify({
        role: 'assistant',
        content: 'arbitrary content',
        timestamp: '',
      }),
      source: 'session_end',
    });

    const recall = await handleMemoryRecall({ project: 'p', context: 'regression check pattern' });
    expect(recall.content[0].text).toContain('No relevant learnings');

    const search = handleMemorySearch({ query: 'regression check pattern' });
    expect(search.content[0].text).toContain('No learnings found');
  });

  // -------------------------------------------------------------------------
  // FR-109 round-2 review fix: source_extractor persists on the row + survives approval
  // -------------------------------------------------------------------------

  it('persists source_extractor on the row and preserves it across approval', async () => {
    setHandlerContext({
      bus: noopBus,
      config: TEST_CONFIG,
      llmExtractor: async (): Promise<PerceptionCandidate[]> => [
        {
          category: 'pattern',
          title: 'LLM finding for source_extractor test',
          content: 'body content',
          tags: [],
          confidence: 0.7,
          source_extractor: 'llm',
          evidence: { transcript_excerpt: 'snippet' },
        },
      ],
    });

    const result = await handlePerceptionSubmit({
      project: 'p',
      transcript_text: JSON.stringify({
        role: 'assistant',
        content: 'X'.repeat(2000),
        timestamp: '',
      }),
      source: 'session_end',
    });
    expect(result.isError).toBeFalsy();

    const row = db
      .prepare(
        `SELECT id, title, source_extractor, review_status, provenance
         FROM learnings WHERE project = ?`,
      )
      .get('p') as {
        id: number;
        title: string;
        source_extractor: string;
        review_status: string;
        provenance: string;
      };
    expect(row.source_extractor).toBe('llm');
    expect(row.review_status).toBe('pending_review');
    expect(row.provenance).toBe('inferred');

    handlePerceptionApprove({ learning_id: row.id });

    const after = db
      .prepare(`SELECT source_extractor, review_status FROM learnings WHERE id = ?`)
      .get(row.id) as { source_extractor: string; review_status: string };
    // Approval is a status flip, not a re-extraction — source_extractor unchanged.
    expect(after.source_extractor).toBe('llm');
    expect(after.review_status).toBe('approved');
  });

  // -------------------------------------------------------------------------
  // TD-066 / Risk #3: legacy `rule:*` rows remain visible to review_pending
  // (the source_extractor enum narrowing is insert-side ONLY; existing
  //  pre-TD-066 rows must keep flowing through the read surface unchanged.)
  // -------------------------------------------------------------------------

  it('Risk #3 regression: legacy rule:* rows still surfaced by review_pending', async () => {
    // Insert a row with the legacy source_extractor value, mimicking what the
    // pre-TD-066 runner would have written. The TS narrowing does NOT change
    // the DB column type — it stays plain TEXT.
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, provenance,
        review_status, source_extractor)
       VALUES ('p', 'pattern', 'legacy LEARNED finding', 'body', 'inferred',
        'pending_review', 'rule:learned_marker')`,
    ).run();

    const r = handlePerceptionReviewPending({ project: 'p' });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content[0].text) as {
      count: number;
      candidates: Array<{ title: string; source_extractor: string }>;
    };
    expect(out.count).toBe(1);
    expect(out.candidates[0].title).toBe('legacy LEARNED finding');
    // Read-side widening: legacy values render verbatim.
    expect(out.candidates[0].source_extractor).toBe('rule:learned_marker');
  });

  // -------------------------------------------------------------------------
  // TD-066 / Risk #3: sync push still excludes pending_review rows
  // (defense-in-depth filter `review_status='approved' OR null` in sync.ts)
  // -------------------------------------------------------------------------

  it('Risk #3 regression: pending rows excluded from sync push payload', async () => {
    // Insert a legacy rule:* pending row. The sync push SELECT should NOT
    // emit it because review_status is 'pending_review'.
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, provenance,
        review_status, source_extractor, created_at, updated_at)
       VALUES ('p', 'pattern', 'legacy pending row', 'body', 'inferred',
        'pending_review', 'rule:learned_marker',
        datetime('now'), datetime('now'))`,
    ).run();

    db.prepare(
      `INSERT INTO learnings (project, category, title, content, provenance,
        review_status, source_extractor, created_at, updated_at)
       VALUES ('p', 'pattern', 'approved row', 'body', 'inferred',
        'approved', 'llm',
        datetime('now'), datetime('now'))`,
    ).run();

    // Mirror the SELECT used in handleBrainPush: changed-rows filter +
    // defense-in-depth review_status filter. We don't import handleBrainPush
    // here (heavy dependencies); we exercise the SQL directly to ensure the
    // pending row is excluded.
    //
    // Schema enforces NOT NULL DEFAULT 'approved' for review_status (migration v15);
    // NULL is impossible going forward. Production sync filter at tools/sync.ts:600
    // uses only `review_status = 'approved'` — this test mirrors that.
    const rows = db
      .prepare(
        `SELECT title, review_status FROM learnings
         WHERE project = ?
           AND review_status = 'approved'`,
      )
      .all('p') as Array<{ title: string; review_status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('approved row');
    // Pending row stays out of the push payload.
    expect(rows.find((r) => r.title === 'legacy pending row')).toBeUndefined();
  });
});
