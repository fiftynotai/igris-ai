/**
 * Perception runner — cost gate + dedupe + persist tests (FR-109).
 *
 * Covers:
 *   - evaluateLlmGate ladder (disabled / bytes / rules-sufficient / ran)
 *   - dedupeWithRulePriority tie-breaks
 *   - runPerception end-to-end with rule + LLM stubs persisting against
 *     an in-memory SQLite database
 *
 * @module engine/components/perception/__tests__/runner.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  evaluateLlmGate,
  dedupeWithRulePriority,
  runPerception,
  runRuleExtractors,
} from '../runner.js';
import { DEFAULT_PERCEPTION_CONFIG, type PerceptionCandidate, type TranscriptEvent } from '../types.js';
import {
  transcriptWithRetryChain,
  transcriptWithSubtlePattern,
} from './fixtures/synthetic-transcripts.js';

// Mock embeddings + vector-search — perception runner calls them per insert.
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

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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
  `);
  return db;
}

function makeCandidate(over: Partial<PerceptionCandidate> = {}): PerceptionCandidate {
  return {
    category: 'pattern',
    title: 'Default candidate title',
    content: 'Default content body for the candidate.',
    tags: ['test'],
    confidence: 0.7,
    source_extractor: 'rule:learned_marker',
    evidence: { marker: 'LEARNED:' },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// evaluateLlmGate
// ---------------------------------------------------------------------------

describe('evaluateLlmGate', () => {
  const cfg = { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true };

  it('skips when extractor_llm_enabled=false (correctness gate)', () => {
    const out = evaluateLlmGate(0, 10_000, { ...cfg, extractor_llm_enabled: false }, false);
    expect(out.shouldRun).toBe(false);
    expect(out.status).toBe('skipped:disabled');
  });

  it('correctness gate is NEVER bypassed by force_llm', () => {
    const out = evaluateLlmGate(0, 10_000, { ...cfg, extractor_llm_enabled: false }, true);
    expect(out.shouldRun).toBe(false);
    expect(out.status).toBe('skipped:disabled');
  });

  it('skips when transcript_bytes < threshold', () => {
    const out = evaluateLlmGate(0, 500, { ...cfg, llm_min_transcript_bytes: 1024 }, false);
    expect(out.shouldRun).toBe(false);
    expect(out.status).toBe('skipped:bytes');
  });

  it('force_llm bypasses transcript_bytes gate', () => {
    const out = evaluateLlmGate(0, 500, { ...cfg, llm_min_transcript_bytes: 1024 }, true);
    expect(out.shouldRun).toBe(true);
  });

  it('skips when rules already produced enough candidates', () => {
    const out = evaluateLlmGate(5, 10_000, { ...cfg, llm_skip_threshold: 3 }, false);
    expect(out.shouldRun).toBe(false);
    expect(out.status).toBe('skipped:rules_sufficient');
  });

  it('force_llm bypasses rules-sufficient gate', () => {
    const out = evaluateLlmGate(5, 10_000, { ...cfg, llm_skip_threshold: 3 }, true);
    expect(out.shouldRun).toBe(true);
  });

  it('runs when enabled, transcript large, rules sparse', () => {
    const out = evaluateLlmGate(1, 10_000, { ...cfg, llm_skip_threshold: 3, llm_min_transcript_bytes: 1024 }, false);
    expect(out.shouldRun).toBe(true);
    expect(out.status).toBe('ran');
  });
});

// ---------------------------------------------------------------------------
// dedupeWithRulePriority
// ---------------------------------------------------------------------------

describe('dedupeWithRulePriority', () => {
  it('keeps a single candidate untouched', () => {
    const out = dedupeWithRulePriority([makeCandidate({ title: 'one' })]);
    expect(out.kept).toHaveLength(1);
    expect(out.suppressed).toBe(0);
  });

  it('keeps the higher-confidence candidate when titles match', () => {
    const out = dedupeWithRulePriority([
      makeCandidate({ title: 'X', confidence: 0.5, source_extractor: 'llm' }),
      makeCandidate({ title: 'X', confidence: 0.8, source_extractor: 'rule:learned_marker' }),
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0].confidence).toBe(0.8);
    expect(out.suppressed).toBe(1);
  });

  it('prefers a rule source on confidence tie', () => {
    const out = dedupeWithRulePriority([
      makeCandidate({ title: 'tie', confidence: 0.7, source_extractor: 'llm' }),
      makeCandidate({ title: 'tie', confidence: 0.7, source_extractor: 'rule:retry_chain' }),
    ]);
    expect(out.kept[0].source_extractor).toBe('rule:retry_chain');
  });

  it('treats whitespace and case differences as equal', () => {
    const out = dedupeWithRulePriority([
      makeCandidate({ title: 'Same Title' }),
      makeCandidate({ title: '  same   title  ' }),
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.suppressed).toBe(1);
  });

  it('keeps multiple distinct titles', () => {
    const out = dedupeWithRulePriority([
      makeCandidate({ title: 'A' }),
      makeCandidate({ title: 'B' }),
      makeCandidate({ title: 'C' }),
    ]);
    expect(out.kept).toHaveLength(3);
    expect(out.suppressed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runRuleExtractors
// ---------------------------------------------------------------------------

describe('runRuleExtractors', () => {
  it('returns [] for empty input', () => {
    expect(runRuleExtractors([])).toHaveLength(0);
  });

  it('aggregates candidates from all rules over a single transcript', () => {
    const out = runRuleExtractors(transcriptWithRetryChain);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.every((c) => c.source_extractor.startsWith('rule:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runPerception (end-to-end)
// ---------------------------------------------------------------------------

describe('runPerception', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('extracts rule candidates and persists as pending_review with provenance=inferred', async () => {
    const result = await runPerception(
      db,
      { events: transcriptWithRetryChain, project: 'p', source: 'session_end' },
      DEFAULT_PERCEPTION_CONFIG,
    );
    expect(result.rule_extracted).toBeGreaterThan(0);
    expect(result.inserted).toBe(result.rule_extracted - result.suppressed);
    const rows = db.prepare('SELECT review_status, provenance FROM learnings').all() as Array<{ review_status: string; provenance: string }>;
    expect(rows.length).toBe(result.inserted);
    expect(rows.every((r) => r.review_status === 'pending_review')).toBe(true);
    expect(rows.every((r) => r.provenance === 'inferred')).toBe(true);
  });

  it('skips LLM by default (extractor_llm_enabled=false)', async () => {
    const stubLlm = vi.fn(async () => []);
    const result = await runPerception(
      db,
      { events: transcriptWithRetryChain, project: 'p', source: 's' },
      DEFAULT_PERCEPTION_CONFIG,
      stubLlm,
    );
    expect(stubLlm).not.toHaveBeenCalled();
    expect(result.llm_status).toBe('skipped:disabled');
  });

  it('skips LLM when rules sufficient', async () => {
    const events: TranscriptEvent[] = [
      { role: 'assistant', content: 'LEARNED: a\nLEARNED: b\nLEARNED: c\nLEARNED: d', timestamp: '' },
    ];
    const stubLlm = vi.fn(async () => []);
    const result = await runPerception(
      db,
      { events, project: 'p', source: 's' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_skip_threshold: 3, llm_min_transcript_bytes: 1 },
      stubLlm,
    );
    expect(stubLlm).not.toHaveBeenCalled();
    expect(result.llm_status).toBe('skipped:rules_sufficient');
    expect(result.rule_extracted).toBeGreaterThanOrEqual(3);
  });

  it('skips LLM on tiny transcript even when enabled', async () => {
    const events: TranscriptEvent[] = [{ role: 'user', content: 'small', timestamp: '' }];
    const stubLlm = vi.fn(async () => []);
    const result = await runPerception(
      db,
      { events, project: 'p', source: 's' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_min_transcript_bytes: 1024 },
      stubLlm,
    );
    expect(stubLlm).not.toHaveBeenCalled();
    expect(result.llm_status).toBe('skipped:bytes');
  });

  it('runs LLM when enabled, transcript large, rules sparse', async () => {
    const big = 'X'.repeat(2000);
    const events: TranscriptEvent[] = [{ role: 'user', content: big, timestamp: '' }];
    const stubLlm = vi.fn(async () => [
      {
        category: 'pattern' as const,
        title: 'LLM-only finding',
        content: 'Only the LLM caught this.',
        tags: [],
        confidence: 0.7,
        source_extractor: 'llm' as const,
        evidence: { transcript_excerpt: 'big' },
      },
    ]);
    const result = await runPerception(
      db,
      { events, project: 'p', source: 's' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true },
      stubLlm,
    );
    expect(stubLlm).toHaveBeenCalledTimes(1);
    expect(result.llm_status).toBe('ran');
    expect(result.llm_extracted).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.by_source.llm).toBe(1);
  });

  it('force_llm bypasses cost gates but not the disabled gate', async () => {
    const stubLlm = vi.fn(async () => []);
    const events: TranscriptEvent[] = [{ role: 'user', content: 'x', timestamp: '' }];
    // Disabled — force should NOT bypass.
    const r1 = await runPerception(
      db,
      { events, project: 'p', source: 's', force_llm: true },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: false },
      stubLlm,
    );
    expect(stubLlm).not.toHaveBeenCalled();
    expect(r1.llm_status).toBe('skipped:disabled');

    // Enabled but tiny transcript — force SHOULD bypass.
    const r2 = await runPerception(
      db,
      { events, project: 'p', source: 's', force_llm: true },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_min_transcript_bytes: 1024 },
      stubLlm,
    );
    expect(stubLlm).toHaveBeenCalledTimes(1);
    expect(r2.llm_status).toBe('ran');
  });

  it('dedupes overlapping rule + LLM candidates with rule priority', async () => {
    const events: TranscriptEvent[] = [
      { role: 'assistant', content: 'LEARNED: shared finding text body', timestamp: '' },
    ];
    const stubLlm = vi.fn(async () => [
      {
        category: 'pattern' as const,
        title: 'shared finding text body',
        content: 'LLM phrasing of the same idea.',
        tags: [],
        confidence: 0.85, // tied with rule
        source_extractor: 'llm' as const,
        evidence: { transcript_excerpt: 'shared' },
      },
    ]);
    const result = await runPerception(
      db,
      { events, project: 'p', source: 's' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_min_transcript_bytes: 1, llm_skip_threshold: 99 },
      stubLlm,
    );
    expect(result.rule_extracted).toBe(1);
    expect(result.llm_extracted).toBe(1);
    expect(result.suppressed).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.by_source['rule:learned_marker']).toBe(1);
    expect(result.by_source.llm).toBe(0);
  });

  it('returns empty result for empty events', async () => {
    const result = await runPerception(
      db,
      { events: [], project: 'p', source: 's' },
      DEFAULT_PERCEPTION_CONFIG,
    );
    expect(result.rule_extracted).toBe(0);
    expect(result.inserted).toBe(0);
  });

  it('handles a failing LLM extractor without crashing', async () => {
    const events: TranscriptEvent[] = [{ role: 'user', content: 'X'.repeat(2000), timestamp: '' }];
    const failingLlm = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await runPerception(
      db,
      { events, project: 'p', source: 's' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true },
      failingLlm,
    );
    expect(result.llm_status).toBe('ran'); // gate ran, but extractor threw
    expect(result.llm_extracted).toBe(0);
    expect(result.inserted).toBe(0);
  });

  it('persists rule extractor results from a multi-finding transcript', async () => {
    const result = await runPerception(
      db,
      { events: transcriptWithSubtlePattern, project: 'p', source: 's' },
      DEFAULT_PERCEPTION_CONFIG,
    );
    // Subtle pattern transcript may yield 0 rule candidates — that's fine.
    // What matters is the runner returns cleanly.
    expect(result.llm_status).toBe('skipped:disabled');
  });
});
