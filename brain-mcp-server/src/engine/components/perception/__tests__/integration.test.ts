/**
 * Perception channel — end-to-end integration tests (FR-109 Phase F).
 *
 * Drives the full pipeline:
 *   submit -> rule extraction -> dedupe -> persist as pending_review
 *   review_pending -> approve -> recall now sees the row
 *   reject -> row is hard-deleted
 *
 * Plus Mode B: rule + LLM both fire, dedupe handles overlap.
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
      source_extractor TEXT NOT NULL DEFAULT 'manual'
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
    const transcript = [
      JSON.stringify({
        role: 'assistant',
        content: 'LEARNED: parametrise SQL queries in better-sqlite3 to avoid injection',
        timestamp: '2026-04-29T10:00:00Z',
      }),
    ].join('\n');

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
    expect(recallAfter.content[0].text).toContain('parametrise SQL queries');

    // 7. provenance permanence: still 'inferred' even after approval
    const row = db.prepare('SELECT provenance, review_status FROM learnings WHERE id = ?').get(learningId) as {
      provenance: string;
      review_status: string;
    };
    expect(row.provenance).toBe('inferred');
    expect(row.review_status).toBe('approved');
  });

  it('reject deletes the row entirely', async () => {
    const transcript = JSON.stringify({
      role: 'assistant',
      content: 'LEARNED: noisy and not useful',
      timestamp: '',
    });
    await handlePerceptionSubmit({
      project: 'p',
      transcript_text: transcript,
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

  it('Mode B: rule + LLM both fire, dedupe with rule priority preserves rule', async () => {
    // Big enough transcript to pass the bytes gate; rules sparse enough to
    // pass the rules-sufficient gate.
    const transcript = [
      JSON.stringify({
        role: 'assistant',
        content: `LEARNED: Mode B integration pattern — rules and LLM both fire on the same window.\n${'X'.repeat(2000)}`,
        timestamp: '',
      }),
    ].join('\n');

    const stubLlm = vi.fn(async (): Promise<PerceptionCandidate[]> => [
      {
        category: 'pattern',
        title: 'LLM-only finding from this window',
        content: 'A unique observation only the LLM caught — not present in rules.',
        tags: ['llm-test'],
        confidence: 0.7,
        source_extractor: 'llm',
        evidence: { transcript_excerpt: 'unique observation' },
      },
      {
        // Will dedupe with the rule-extracted LEARNED finding (same normalized title).
        category: 'pattern',
        title: 'Mode B integration pattern — rules and LLM both fire on the same window.',
        content: 'LLM phrasing of the same idea.',
        tags: ['llm-test'],
        confidence: 0.85, // tied with rule
        source_extractor: 'llm',
        evidence: { transcript_excerpt: 'mode b' },
      },
    ]);

    setHandlerContext({
      bus: noopBus,
      config: { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_skip_threshold: 99 },
      llmExtractor: stubLlm,
    });

    const result = await handlePerceptionSubmit({
      project: 'p',
      transcript_text: transcript,
      source: 'session_end',
    });
    const out = JSON.parse(result.content[0].text) as {
      rule_extracted: number;
      llm_extracted: number;
      suppressed: number;
      inserted: number;
      llm_status: string;
      by_source: Record<string, number>;
    };

    expect(stubLlm).toHaveBeenCalledTimes(1);
    expect(out.llm_status).toBe('ran');
    expect(out.rule_extracted).toBe(1);
    expect(out.llm_extracted).toBe(2);
    expect(out.suppressed).toBe(1); // dedupe killed the LLM-vs-rule overlap
    expect(out.inserted).toBe(2); // rule + 1 unique llm survived
    expect(out.by_source['rule:learned_marker']).toBe(1);
    expect(out.by_source.llm).toBe(1);

    // Confirm both pending rows visible to review.
    const review = handlePerceptionReviewPending({ project: 'p' });
    const reviewOut = JSON.parse(review.content[0].text) as {
      count: number;
      candidates: Array<{ title: string }>;
    };
    expect(reviewOut.count).toBe(2);
  });

  it('regression: pending rows never returned by recall, search, or hybrid', async () => {
    await handlePerceptionSubmit({
      project: 'p',
      transcript_text: JSON.stringify({
        role: 'assistant',
        content: 'LEARNED: regression check pattern phrase',
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
  // FR-109 round-2 review fix: source_extractor persists on the row
  // (was: discarded via `void evidence;` — /awaken couldn't tell rule from LLM)
  // -------------------------------------------------------------------------
  it('persists source_extractor on the row for both rule and LLM candidates', async () => {
    // Rule trigger (LEARNED:) + LLM stub. Force the LLM gate via a large
    // transcript and a high skip threshold.
    const transcript = JSON.stringify({
      role: 'assistant',
      content: `LEARNED: rule-extracted finding for source_extractor test\n${'Y'.repeat(2000)}`,
      timestamp: '',
    });

    const stubLlm = vi.fn(async (): Promise<PerceptionCandidate[]> => [
      {
        category: 'pattern',
        title: 'LLM-only candidate for source_extractor test',
        content: 'Distinct from the rule candidate so dedupe leaves both alive.',
        tags: [],
        confidence: 0.7,
        source_extractor: 'llm',
        evidence: { transcript_excerpt: 'llm-only' },
      },
    ]);

    setHandlerContext({
      bus: noopBus,
      config: { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_skip_threshold: 99 },
      llmExtractor: stubLlm,
    });

    const result = await handlePerceptionSubmit({
      project: 'p',
      transcript_text: transcript,
      source: 'session_end',
    });
    expect(result.isError).toBeFalsy();

    // Both rows persisted with their source_extractor value.
    const rows = db
      .prepare(
        `SELECT title, source_extractor, review_status, provenance
         FROM learnings WHERE project = ? ORDER BY id ASC`,
      )
      .all('p') as Array<{
        title: string;
        source_extractor: string;
        review_status: string;
        provenance: string;
      }>;
    expect(rows).toHaveLength(2);

    const ruleRow = rows.find((r) => r.title.includes('rule-extracted finding'));
    const llmRow = rows.find((r) => r.title.includes('LLM-only candidate'));
    expect(ruleRow?.source_extractor).toBe('rule:learned_marker');
    expect(llmRow?.source_extractor).toBe('llm');
    // All perception rows are pending+inferred until approved.
    expect(ruleRow?.review_status).toBe('pending_review');
    expect(llmRow?.review_status).toBe('pending_review');
    expect(ruleRow?.provenance).toBe('inferred');
    expect(llmRow?.provenance).toBe('inferred');

    // Approve both — source_extractor must remain UNCHANGED (permanent, like
    // provenance). Approval is a status flip, not a re-extraction.
    const ruleId = db
      .prepare('SELECT id FROM learnings WHERE title LIKE ?')
      .get('%rule-extracted finding%') as { id: number };
    const llmId = db
      .prepare('SELECT id FROM learnings WHERE title LIKE ?')
      .get('%LLM-only candidate%') as { id: number };
    handlePerceptionApprove({ learning_id: ruleId.id });
    handlePerceptionApprove({ learning_id: llmId.id });

    const afterApproval = db
      .prepare(
        `SELECT title, source_extractor, review_status FROM learnings
         WHERE id IN (?, ?) ORDER BY id ASC`,
      )
      .all(ruleId.id, llmId.id) as Array<{
        title: string;
        source_extractor: string;
        review_status: string;
      }>;
    expect(afterApproval[0].source_extractor).toBe('rule:learned_marker');
    expect(afterApproval[1].source_extractor).toBe('llm');
    expect(afterApproval[0].review_status).toBe('approved');
    expect(afterApproval[1].review_status).toBe('approved');

    // review_pending response must include source_extractor — emit one new
    // pending row to verify the SELECT shape (existing rows are now approved).
    setHandlerContext({
      bus: noopBus,
      config: DEFAULT_PERCEPTION_CONFIG,
      llmExtractor: async () => [],
    });
    await handlePerceptionSubmit({
      project: 'p',
      transcript_text: JSON.stringify({
        role: 'assistant',
        content: 'LEARNED: review surface check phrase',
        timestamp: '',
      }),
      source: 'session_end',
    });
    const review = handlePerceptionReviewPending({ project: 'p' });
    const out = JSON.parse(review.content[0].text) as {
      candidates: Array<{ title: string; source_extractor: string }>;
    };
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].source_extractor).toBe('rule:learned_marker');
  });
});
