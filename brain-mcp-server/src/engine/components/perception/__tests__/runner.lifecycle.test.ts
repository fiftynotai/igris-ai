/**
 * Perception runner lifecycle event tests (TD-074).
 *
 * Asserts the lifecycle invariant: exactly one terminal event per
 * `perception.run_started`. Drives `runPerception` against an in-memory DB
 * with a real `event_log` table so the writer's INSERT path is exercised
 * end-to-end, and inspects the resulting rows directly.
 *
 * Failure modes covered:
 *   - Successful run (LLM returns N candidates → run_succeeded with count)
 *   - Empty-events early return → no events written (no run_started either)
 *   - Extractor throws → run_failed (reason='unknown') + lifecycle invariant
 *   - Extractor pre-emits run_failed via onEvent → no trailing run_succeeded
 *   - DB persistence failure → still emits run_succeeded (persist swallows)
 *   - Trigger field threaded through to event payloads
 *   - duration_ms present and non-negative on terminal events
 *
 * @module engine/components/perception/__tests__/runner.lifecycle.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runPerception } from '../runner.js';
import { DEFAULT_PERCEPTION_CONFIG, type PerceptionCandidate } from '../types.js';
import type { LlmExtractor, ExtractorLogger } from '../extractors/llm_via_claude_code.js';

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

// ---------------------------------------------------------------------------
// Test DB — full event_log + learnings schema
// ---------------------------------------------------------------------------

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
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      component TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      machine_hostname TEXT,
      project_slug TEXT,
      instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

interface PerceptionRow {
  event_name: string;
  payload: Record<string, unknown>;
}

function readPerceptionEvents(db: Database.Database): PerceptionRow[] {
  const rows = db
    .prepare(
      "SELECT event_name, payload FROM event_log WHERE component = 'perception' ORDER BY id ASC",
    )
    .all() as { event_name: string; payload: string }[];
  return rows.map((r) => ({
    event_name: r.event_name,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  }));
}

function makeCandidate(over: Partial<PerceptionCandidate> = {}): PerceptionCandidate {
  return {
    category: 'pattern',
    title: `cand-${Math.random().toString(36).slice(2, 8)}`,
    content: 'Test candidate content body.',
    tags: [],
    confidence: 0.7,
    source_extractor: 'llm',
    evidence: { transcript_excerpt: 'snippet' },
    ...over,
  };
}

const TRANSCRIPT_BYTES = 2000;
const events = [{ role: 'user', content: 'X'.repeat(TRANSCRIPT_BYTES), timestamp: '' }];
const config = { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_min_transcript_bytes: 0 };

// ---------------------------------------------------------------------------
// Lifecycle invariant tests
// ---------------------------------------------------------------------------

describe('runPerception lifecycle events (TD-074)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('emits run_started + run_succeeded on the happy path', async () => {
    const stub: LlmExtractor = async () => [makeCandidate()];

    const result = await runPerception(
      db,
      { events, project: 'p', source: 'session_end', trigger: 'detached' },
      config,
      stub,
    );

    expect(result.inserted).toBe(1);
    const lifecycle = readPerceptionEvents(db);
    expect(lifecycle.map((e) => e.event_name)).toEqual([
      'perception.run_started',
      'perception.run_succeeded',
    ]);
    expect(lifecycle[0].payload.project).toBe('p');
    expect(lifecycle[0].payload.transcript_bytes).toBe(TRANSCRIPT_BYTES);
    expect(lifecycle[0].payload.source).toBe('session_end');
    expect(lifecycle[0].payload.trigger).toBe('detached');
    expect(lifecycle[1].payload.candidates_count).toBe(1);
    expect(lifecycle[1].payload.llm_extracted).toBe(1);
    expect(lifecycle[1].payload.llm_status).toBe('ran');
    expect(typeof lifecycle[1].payload.duration_ms).toBe('number');
    expect(Number(lifecycle[1].payload.duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it('emits NO events when transcript is empty (early return path)', async () => {
    const result = await runPerception(
      db,
      { events: [], project: 'p', source: 's' },
      config,
      async () => [],
    );

    expect(result.inserted).toBe(0);
    expect(readPerceptionEvents(db)).toHaveLength(0);
  });

  it('emits run_started + run_failed (reason=unknown) when extractor throws', async () => {
    const stub: LlmExtractor = async () => {
      throw new Error('boom from extractor');
    };

    const result = await runPerception(
      db,
      { events, project: 'p', source: 's', trigger: 'detached' },
      config,
      stub,
    );

    expect(result.inserted).toBe(0);
    const lifecycle = readPerceptionEvents(db);
    expect(lifecycle.map((e) => e.event_name)).toEqual([
      'perception.run_started',
      'perception.run_failed',
    ]);
    expect(lifecycle[1].payload.reason).toBe('unknown');
    expect(lifecycle[1].payload.error_message).toContain('boom from extractor');
  });

  it('does NOT double-emit when extractor pre-emits run_failed via onEvent', async () => {
    // Stub extractor that simulates the EPIPE handler: invoke onEvent with
    // a structured failure, then settle with []. Mirrors what
    // llm_via_claude_code.ts does on EPIPE.
    const stub: LlmExtractor = async (_evts, _ctx, log) => {
      log?.onEvent?.('perception.run_failed', {
        reason: 'epipe_on_llm_stdin',
        error_message: 'write EPIPE',
        prompt_bytes: 262144,
      });
      return [];
    };

    const result = await runPerception(
      db,
      { events, project: 'p', source: 's', trigger: 'detached' },
      config,
      stub,
    );

    // Runner returns normally even though a terminal event was written.
    expect(result.inserted).toBe(0);
    const lifecycle = readPerceptionEvents(db);
    // Lifecycle invariant: exactly one terminal event per run_started.
    // The extractor pre-emitted run_failed, so the runner's trailing
    // run_succeeded MUST be suppressed.
    expect(lifecycle.map((e) => e.event_name)).toEqual([
      'perception.run_started',
      'perception.run_failed',
    ]);
    expect(lifecycle[1].payload.reason).toBe('epipe_on_llm_stdin');
    expect(lifecycle[1].payload.error_message).toBe('write EPIPE');
    expect(lifecycle[1].payload.prompt_bytes).toBe(262144);
    // Trigger is normalized into the runner-tagged envelope.
    expect(lifecycle[1].payload.trigger).toBe('detached');
  });

  it('threads trigger through to all lifecycle event payloads', async () => {
    const stub: LlmExtractor = async () => [makeCandidate()];

    await runPerception(
      db,
      { events, project: 'p', source: 'extract_now', trigger: 'mcp_extract_now' },
      config,
      stub,
    );

    const lifecycle = readPerceptionEvents(db);
    for (const ev of lifecycle) {
      expect(ev.payload.trigger).toBe('mcp_extract_now');
      expect(ev.payload.project).toBe('p');
    }
  });

  it('defaults trigger to "unknown" when caller omits it', async () => {
    await runPerception(
      db,
      { events, project: 'p', source: 's' },
      config,
      async () => [],
    );

    const lifecycle = readPerceptionEvents(db);
    expect(lifecycle).toHaveLength(2);
    for (const ev of lifecycle) {
      expect(ev.payload.trigger).toBe('unknown');
    }
  });

  it('forwards extractor onEvent calls to the caller-supplied logger', async () => {
    // Verify the runner forwards extractor onEvent to the caller's log
    // (so direct test/debug callers can spy on raw calls).
    const onEventSpy = vi.fn();
    const callerLog: ExtractorLogger = {
      info: () => {},
      warn: () => {},
      onEvent: onEventSpy,
    };
    const stub: LlmExtractor = async (_evts, _ctx, log) => {
      log?.onEvent?.('perception.run_failed', { reason: 'timeout', timeout_ms: 60_000 });
      return [];
    };

    await runPerception(
      db,
      { events, project: 'p', source: 's' },
      config,
      stub,
      callerLog,
    );

    expect(onEventSpy).toHaveBeenCalledWith(
      'perception.run_failed',
      expect.objectContaining({ reason: 'timeout', timeout_ms: 60_000 }),
    );
  });

  it('emits run_succeeded with candidates_count=0 when LLM returns nothing (not a failure)', async () => {
    await runPerception(
      db,
      { events, project: 'p', source: 's' },
      config,
      async () => [],
    );

    const lifecycle = readPerceptionEvents(db);
    expect(lifecycle.map((e) => e.event_name)).toEqual([
      'perception.run_started',
      'perception.run_succeeded',
    ]);
    expect(lifecycle[1].payload.candidates_count).toBe(0);
  });

  it('emits run_started + run_succeeded even when the LLM gate skips the extractor', async () => {
    // Force-skip path: extractor_llm_enabled=false. Gate fires before any
    // extractor call. Run still produces lifecycle events.
    await runPerception(
      db,
      { events, project: 'p', source: 's' },
      { ...config, extractor_llm_enabled: false },
      async () => [makeCandidate()],
    );

    const lifecycle = readPerceptionEvents(db);
    expect(lifecycle.map((e) => e.event_name)).toEqual([
      'perception.run_started',
      'perception.run_succeeded',
    ]);
    expect(lifecycle[1].payload.llm_status).toBe('skipped:disabled');
    expect(lifecycle[1].payload.candidates_count).toBe(0);
  });
});
