/**
 * Perception runner — cost gate + dedupe + persist tests (FR-109 + TD-066).
 *
 * Covers:
 *   - evaluateLlmGate ladder (disabled / bytes / ran)
 *   - dedupeByTitle: highest-confidence wins on collision
 *   - runPerception end-to-end with stub LLM extractor against an in-memory
 *     SQLite database
 *   - auto_approve_enabled flag round-trip (TD-066)
 *   - sync-visibility regression for legacy `rule:*` source_extractor rows
 *
 * @module engine/components/perception/__tests__/runner.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  evaluateLlmGate,
  dedupeByTitle,
  runPerception,
} from '../runner.js';
import { DEFAULT_PERCEPTION_CONFIG, type PerceptionCandidate, type TranscriptEvent } from '../types.js';
import type { LlmExtractor } from '../extractors/llm_via_claude_code.js';

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
      source_extractor TEXT NOT NULL DEFAULT 'manual',
      -- TD-086: cheap-dedup tracking columns mirror the perception schema v2
      -- migration. The runner UPDATEs both on every dedup hit.
      seen_again_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT
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

function makeCandidate(over: Partial<PerceptionCandidate> = {}): PerceptionCandidate {
  return {
    category: 'pattern',
    title: 'Default candidate title',
    content: 'Default content body for the candidate.',
    tags: ['test'],
    confidence: 0.7,
    source_extractor: 'llm',
    evidence: { transcript_excerpt: 'snippet' },
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

  it('runs when enabled and transcript large', () => {
    const out = evaluateLlmGate(0, 10_000, { ...cfg, llm_min_transcript_bytes: 1024 }, false);
    expect(out.shouldRun).toBe(true);
    expect(out.status).toBe('ran');
  });

  it('TD-066 regression: ruleCount param is ignored (no skipped:rules_sufficient)', () => {
    // Pass huge ruleCount — gate must still run.
    const out = evaluateLlmGate(9999, 10_000, cfg, false);
    expect(out.shouldRun).toBe(true);
    expect(out.status).toBe('ran');
  });
});

// ---------------------------------------------------------------------------
// dedupeByTitle
// ---------------------------------------------------------------------------

describe('dedupeByTitle', () => {
  it('keeps a single candidate untouched', () => {
    const out = dedupeByTitle([makeCandidate({ title: 'one' })]);
    expect(out.kept).toHaveLength(1);
    expect(out.suppressed).toBe(0);
  });

  it('keeps the higher-confidence candidate when titles match', () => {
    const out = dedupeByTitle([
      makeCandidate({ title: 'X', confidence: 0.5 }),
      makeCandidate({ title: 'X', confidence: 0.8 }),
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0].confidence).toBe(0.8);
    expect(out.suppressed).toBe(1);
  });

  it('treats whitespace and case differences as equal', () => {
    const out = dedupeByTitle([
      makeCandidate({ title: 'Same Title' }),
      makeCandidate({ title: '  same   title  ' }),
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.suppressed).toBe(1);
  });

  it('keeps multiple distinct titles', () => {
    const out = dedupeByTitle([
      makeCandidate({ title: 'A' }),
      makeCandidate({ title: 'B' }),
      makeCandidate({ title: 'C' }),
    ]);
    expect(out.kept).toHaveLength(3);
    expect(out.suppressed).toBe(0);
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

  it('returns empty result for empty events', async () => {
    const result = await runPerception(
      db,
      { events: [], project: 'p', source: 's' },
      DEFAULT_PERCEPTION_CONFIG,
    );
    expect(result.llm_extracted).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.suppressed).toBe(0);
  });

  it('skips LLM when explicitly disabled (extractor_llm_enabled=false)', async () => {
    const stubLlm = vi.fn(async () => []);
    const result = await runPerception(
      db,
      {
        events: [{ role: 'user', content: 'X'.repeat(2000), timestamp: '' }],
        project: 'p',
        source: 's',
      },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: false },
      stubLlm,
    );
    expect(stubLlm).not.toHaveBeenCalled();
    expect(result.llm_status).toBe('skipped:disabled');
  });

  it('skips LLM on tiny transcript', async () => {
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

  it('runs LLM when enabled and transcript large enough', async () => {
    const big = 'X'.repeat(2000);
    const events: TranscriptEvent[] = [{ role: 'user', content: big, timestamp: '' }];
    const stubLlm = vi.fn(async () => [
      makeCandidate({ title: 'LLM-only finding', confidence: 0.7 }),
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

  it('persists pending_review with provenance=inferred and source_extractor=llm', async () => {
    const events: TranscriptEvent[] = [{ role: 'user', content: 'X'.repeat(2000), timestamp: '' }];
    const stubLlm = vi.fn(async () => [makeCandidate({ title: 'finding A' })]);
    await runPerception(
      db,
      { events, project: 'p', source: 'session_end' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true },
      stubLlm,
    );
    const row = db.prepare('SELECT review_status, provenance, source_extractor FROM learnings').get() as {
      review_status: string;
      provenance: string;
      source_extractor: string;
    };
    expect(row.review_status).toBe('pending_review');
    expect(row.provenance).toBe('inferred');
    expect(row.source_extractor).toBe('llm');
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

  it('dedupes overlapping LLM candidates by title', async () => {
    const events: TranscriptEvent[] = [
      { role: 'user', content: 'X'.repeat(2000), timestamp: '' },
    ];
    const stubLlm = vi.fn(async () => [
      makeCandidate({ title: 'shared finding', confidence: 0.5 }),
      makeCandidate({ title: 'SHARED FINDING', confidence: 0.8 }),
      makeCandidate({ title: 'unique finding', confidence: 0.6 }),
    ]);
    const result = await runPerception(
      db,
      { events, project: 'p', source: 's' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_min_transcript_bytes: 1 },
      stubLlm,
    );
    expect(result.llm_extracted).toBe(3);
    expect(result.suppressed).toBe(1);
    expect(result.inserted).toBe(2);
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
    // TD-079: extractor throws map to `failed:unknown` (the inner catch
    // emits `perception.run_failed` with reason='unknown' and the runner
    // mirrors that into result.llm_status).
    expect(result.llm_status).toBe('failed:unknown');
    expect(result.llm_extracted).toBe(0);
    expect(result.inserted).toBe(0);
  });

  // -------------------------------------------------------------------------
  // TD-066: auto_approve_enabled config flag
  // -------------------------------------------------------------------------

  it('auto_approve_enabled=true inserts rows with review_status=approved', async () => {
    const events: TranscriptEvent[] = [
      { role: 'user', content: 'X'.repeat(2000), timestamp: '' },
    ];
    const stubLlm = vi.fn(async () => [makeCandidate({ title: 'auto-approve finding' })]);
    const result = await runPerception(
      db,
      { events, project: 'p', source: 'session_end' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, auto_approve_enabled: true },
      stubLlm,
    );
    expect(result.inserted).toBeGreaterThan(0);
    const rows = db.prepare('SELECT review_status, provenance FROM learnings').all() as Array<{
      review_status: string;
      provenance: string;
    }>;
    expect(rows.every((r) => r.review_status === 'approved')).toBe(true);
    // provenance stays 'inferred' so the forensic trail survives.
    expect(rows.every((r) => r.provenance === 'inferred')).toBe(true);
  });

  it('auto_approve_enabled=false (default) inserts as pending_review', async () => {
    const events: TranscriptEvent[] = [
      { role: 'user', content: 'X'.repeat(2000), timestamp: '' },
    ];
    const stubLlm = vi.fn(async () => [makeCandidate({ title: 'pending finding' })]);
    const result = await runPerception(
      db,
      { events, project: 'p', source: 'session_end' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true }, // auto_approve_enabled defaults false
      stubLlm,
    );
    expect(result.inserted).toBeGreaterThan(0);
    const rows = db.prepare('SELECT review_status FROM learnings').all() as Array<{ review_status: string }>;
    expect(rows.every((r) => r.review_status === 'pending_review')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TD-079: extractor terminal failure reasons mirror onto result.llm_status
  // -------------------------------------------------------------------------

  it('runPerception: timeout from extractor lands in result.llm_status as failed:timeout (TD-079)', async () => {
    // Stub mirrors what llm_via_claude_code.ts does on the soft timer:
    // emit `perception.run_failed` with reason='timeout' via onEvent, then
    // settle the promise with []. The runner observes the event through
    // wrappedLog and rewrites result.llm_status from 'ran' to 'failed:timeout'.
    const events: TranscriptEvent[] = [{ role: 'user', content: 'X'.repeat(2000), timestamp: '' }];
    const stub: LlmExtractor = async (_evts, _ctx, log) => {
      log?.onEvent?.('perception.run_failed', {
        reason: 'timeout',
        timeout_ms: 300_000,
        prompt_bytes: 1234,
      });
      return [];
    };

    const result = await runPerception(
      db,
      { events, project: 'p', source: 's', trigger: 'detached' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_min_transcript_bytes: 0 },
      stub,
    );

    expect(result.llm_status).toBe('failed:timeout');
    expect(result.inserted).toBe(0);
    expect(result.llm_extracted).toBe(0);

    // Lifecycle invariant: exactly one terminal event per run_started.
    // The extractor pre-emitted run_failed, so the runner's trailing
    // run_succeeded MUST be suppressed.
    const lifecycle = db
      .prepare(
        "SELECT event_name FROM event_log WHERE component = 'perception' ORDER BY id ASC",
      )
      .all() as { event_name: string }[];
    expect(lifecycle.map((r) => r.event_name)).toEqual([
      'perception.run_started',
      'perception.run_failed',
    ]);
  });

  it('runPerception: epipe from extractor lands as failed:epipe (TD-079)', async () => {
    // Locks the reason → status mapping for the EPIPE failure mode.
    const events: TranscriptEvent[] = [{ role: 'user', content: 'X'.repeat(2000), timestamp: '' }];
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
      { events, project: 'p', source: 's' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_min_transcript_bytes: 0 },
      stub,
    );

    expect(result.llm_status).toBe('failed:epipe');
    expect(result.inserted).toBe(0);
  });

  it('runPerception: spawn_error from extractor lands as failed:spawn_error (TD-079)', async () => {
    const events: TranscriptEvent[] = [{ role: 'user', content: 'X'.repeat(2000), timestamp: '' }];
    const stub: LlmExtractor = async (_evts, _ctx, log) => {
      log?.onEvent?.('perception.run_failed', {
        reason: 'spawn_error',
        error_message: 'ENOENT',
      });
      return [];
    };

    const result = await runPerception(
      db,
      { events, project: 'p', source: 's' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_min_transcript_bytes: 0 },
      stub,
    );

    expect(result.llm_status).toBe('failed:spawn_error');
  });

  it('runPerception: non_zero_exit from extractor lands as failed:non_zero_exit (TD-079)', async () => {
    const events: TranscriptEvent[] = [{ role: 'user', content: 'X'.repeat(2000), timestamp: '' }];
    const stub: LlmExtractor = async (_evts, _ctx, log) => {
      log?.onEvent?.('perception.run_failed', {
        reason: 'non_zero_exit',
        exit_code: 137,
        error_message: 'OOM',
      });
      return [];
    };

    const result = await runPerception(
      db,
      { events, project: 'p', source: 's' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_min_transcript_bytes: 0 },
      stub,
    );

    expect(result.llm_status).toBe('failed:non_zero_exit');
  });

  it('runPerception: unrecognised reason collapses to failed:unknown (TD-079)', async () => {
    const events: TranscriptEvent[] = [{ role: 'user', content: 'X'.repeat(2000), timestamp: '' }];
    const stub: LlmExtractor = async (_evts, _ctx, log) => {
      log?.onEvent?.('perception.run_failed', {
        reason: 'something_we_did_not_anticipate',
      });
      return [];
    };

    const result = await runPerception(
      db,
      { events, project: 'p', source: 's' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true, llm_min_transcript_bytes: 0 },
      stub,
    );

    expect(result.llm_status).toBe('failed:unknown');
  });

  // -------------------------------------------------------------------------
  // TD-086: cheap-dedup pre-filter integration with runner
  // -------------------------------------------------------------------------

  describe('dedup pre-filter (TD-086)', () => {
    // The runner-level dedup tests stub `findNearestMatch` so we can drive
    // the skip path deterministically without standing up the embedding
    // pipeline + vec0 extension. The dedup helper itself is tested in
    // isolation in dedup.test.ts.

    it('R1: match -> skip insert + bump seen_again_count + emit rediscovery', async () => {
      // Pre-seed an existing learning that the stub will pretend to match.
      const insertResult = db
        .prepare(
          `INSERT INTO learnings (project, category, title, content,
            provenance, review_status, source_extractor, seen_again_count)
           VALUES ('p', 'pattern', 'existing finding', 'body',
            'inferred', 'approved', 'llm', 0)`,
        )
        .run();
      const existingId = Number(insertResult.lastInsertRowid);

      // Stub the dedup helper module via dynamic mock — vi.doMock keeps the
      // stub local to this test (vi.mock would be hoisted globally).
      vi.doMock('../dedup.js', async () => {
        const actual = await vi.importActual<typeof import('../dedup.js')>('../dedup.js');
        return {
          ...actual,
          findNearestMatch: vi.fn(async () => ({
            matched_id: existingId,
            status: 'approved',
            similarity: 0.92,
          })),
        };
      });
      // Re-import so the runner picks up the stubbed module.
      const { runPerception: runPerceptionStubbed } = await import('../runner.js?t=r1');

      const events: TranscriptEvent[] = [
        { role: 'user', content: 'X'.repeat(2000), timestamp: '' },
      ];
      const stubLlm = vi.fn(async () => [
        makeCandidate({ title: 'duplicate of existing finding' }),
      ]);

      const result = await runPerceptionStubbed(
        db,
        { events, project: 'p', source: 's', trigger: 'unit_test' },
        { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true },
        stubLlm,
      );

      expect(result.inserted).toBe(0);
      expect(result.deduped).toBe(1);
      expect(result.deduped_ids).toEqual([existingId]);

      // seen_again_count incremented + last_seen_at populated.
      const row = db
        .prepare('SELECT seen_again_count, last_seen_at FROM learnings WHERE id = ?')
        .get(existingId) as { seen_again_count: number; last_seen_at: string | null };
      expect(row.seen_again_count).toBe(1);
      expect(row.last_seen_at).not.toBeNull();

      // event_log row with correct shape.
      const ev = db
        .prepare(
          "SELECT event_name, payload FROM event_log WHERE event_name='perception.rediscovery'",
        )
        .all() as { event_name: string; payload: string }[];
      expect(ev).toHaveLength(1);
      const payload = JSON.parse(ev[0].payload);
      expect(payload.existing_learning_id).toBe(existingId);
      expect(payload.existing_status).toBe('approved');
      expect(payload.similarity_score).toBeCloseTo(0.92, 2);
      expect(payload.trigger).toBe('unit_test');

      vi.doUnmock('../dedup.js');
    });

    it('R2: no match -> insert proceeds, no rediscovery event', async () => {
      vi.doMock('../dedup.js', async () => {
        const actual = await vi.importActual<typeof import('../dedup.js')>('../dedup.js');
        return {
          ...actual,
          findNearestMatch: vi.fn(async () => null),
        };
      });
      const { runPerception: runPerceptionStubbed } = await import('../runner.js?t=r2');

      const events: TranscriptEvent[] = [
        { role: 'user', content: 'X'.repeat(2000), timestamp: '' },
      ];
      const stubLlm = vi.fn(async () => [makeCandidate({ title: 'fresh finding' })]);

      const result = await runPerceptionStubbed(
        db,
        { events, project: 'p', source: 's' },
        { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true },
        stubLlm,
      );

      expect(result.inserted).toBe(1);
      expect(result.deduped).toBe(0);
      expect(result.deduped_ids).toEqual([]);

      const ev = db
        .prepare(
          "SELECT event_name FROM event_log WHERE event_name='perception.rediscovery'",
        )
        .all();
      expect(ev).toHaveLength(0);

      vi.doUnmock('../dedup.js');
    });

    it('R3: dedup_enabled=false -> dedup helper never called, all candidates insert', async () => {
      const findNearestMatchStub = vi.fn(async () => null);
      vi.doMock('../dedup.js', async () => {
        const actual = await vi.importActual<typeof import('../dedup.js')>('../dedup.js');
        return {
          ...actual,
          findNearestMatch: findNearestMatchStub,
        };
      });
      const { runPerception: runPerceptionStubbed } = await import('../runner.js?t=r3');

      const events: TranscriptEvent[] = [
        { role: 'user', content: 'X'.repeat(2000), timestamp: '' },
      ];
      const stubLlm = vi.fn(async () => [
        makeCandidate({ title: 'finding one' }),
        makeCandidate({ title: 'finding two' }),
      ]);

      const result = await runPerceptionStubbed(
        db,
        { events, project: 'p', source: 's' },
        {
          ...DEFAULT_PERCEPTION_CONFIG,
          extractor_llm_enabled: true,
          dedup_enabled: false,
        },
        stubLlm,
      );

      expect(result.inserted).toBe(2);
      expect(result.deduped).toBe(0);
      expect(findNearestMatchStub).not.toHaveBeenCalled();

      vi.doUnmock('../dedup.js');
    });

    it('R4: pending_review match -> event payload carries existing_status=pending_review', async () => {
      const insertResult = db
        .prepare(
          `INSERT INTO learnings (project, category, title, content,
            provenance, review_status, source_extractor)
           VALUES ('p', 'pattern', 'pending finding', 'body',
            'inferred', 'pending_review', 'llm')`,
        )
        .run();
      const existingId = Number(insertResult.lastInsertRowid);

      vi.doMock('../dedup.js', async () => {
        const actual = await vi.importActual<typeof import('../dedup.js')>('../dedup.js');
        return {
          ...actual,
          findNearestMatch: vi.fn(async () => ({
            matched_id: existingId,
            status: 'pending_review',
            similarity: 0.88,
          })),
        };
      });
      const { runPerception: runPerceptionStubbed } = await import('../runner.js?t=r4');

      const events: TranscriptEvent[] = [
        { role: 'user', content: 'X'.repeat(2000), timestamp: '' },
      ];
      const stubLlm = vi.fn(async () => [makeCandidate({ title: 'paraphrased pending' })]);

      const result = await runPerceptionStubbed(
        db,
        { events, project: 'p', source: 's' },
        { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true },
        stubLlm,
      );

      expect(result.deduped).toBe(1);
      const ev = db
        .prepare(
          "SELECT payload FROM event_log WHERE event_name='perception.rediscovery'",
        )
        .get() as { payload: string } | undefined;
      expect(ev).toBeDefined();
      const payload = JSON.parse(ev!.payload);
      expect(payload.existing_status).toBe('pending_review');
      expect(payload.existing_learning_id).toBe(existingId);

      vi.doUnmock('../dedup.js');
    });

    it('R5: mixed run -> some dedupe, some insert, counts add up', async () => {
      const matchedId = Number(
        db
          .prepare(
            `INSERT INTO learnings (project, category, title, content,
              provenance, review_status, source_extractor)
             VALUES ('p', 'pattern', 'matched row', 'body',
              'inferred', 'approved', 'llm')`,
          )
          .run().lastInsertRowid,
      );

      // Helper returns a match for any candidate whose title contains 'dup'
      // and null otherwise — simulates real-world mixed extraction.
      vi.doMock('../dedup.js', async () => {
        const actual = await vi.importActual<typeof import('../dedup.js')>('../dedup.js');
        return {
          ...actual,
          findNearestMatch: vi.fn(async (_db, c) =>
            c.title.includes('dup')
              ? { matched_id: matchedId, status: 'approved', similarity: 0.91 }
              : null,
          ),
        };
      });
      const { runPerception: runPerceptionStubbed } = await import('../runner.js?t=r5');

      const events: TranscriptEvent[] = [
        { role: 'user', content: 'X'.repeat(2000), timestamp: '' },
      ];
      const stubLlm = vi.fn(async () => [
        makeCandidate({ title: 'dup one' }),
        makeCandidate({ title: 'fresh one' }),
        makeCandidate({ title: 'dup two' }),
      ]);

      const result = await runPerceptionStubbed(
        db,
        { events, project: 'p', source: 's' },
        { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true },
        stubLlm,
      );

      expect(result.inserted).toBe(1);
      expect(result.deduped).toBe(2);
      // Same matched_id surfaced twice — that is intentional; the counter
      // reflects re-extraction frequency, so two hits against the same
      // existing row count as two rediscoveries.
      expect(result.deduped_ids).toEqual([matchedId, matchedId]);

      const row = db
        .prepare('SELECT seen_again_count FROM learnings WHERE id = ?')
        .get(matchedId) as { seen_again_count: number };
      expect(row.seen_again_count).toBe(2);

      vi.doUnmock('../dedup.js');
    });

    it('R6: run_succeeded payload includes deduped count', async () => {
      vi.doMock('../dedup.js', async () => {
        const actual = await vi.importActual<typeof import('../dedup.js')>('../dedup.js');
        return {
          ...actual,
          findNearestMatch: vi.fn(async () => null),
        };
      });
      const { runPerception: runPerceptionStubbed } = await import('../runner.js?t=r6');

      const events: TranscriptEvent[] = [
        { role: 'user', content: 'X'.repeat(2000), timestamp: '' },
      ];
      const stubLlm = vi.fn(async () => [makeCandidate({ title: 'one' })]);

      await runPerceptionStubbed(
        db,
        { events, project: 'p', source: 's' },
        { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true },
        stubLlm,
      );

      const ev = db
        .prepare(
          "SELECT payload FROM event_log WHERE event_name='perception.run_succeeded'",
        )
        .get() as { payload: string };
      const payload = JSON.parse(ev.payload);
      expect(payload).toHaveProperty('deduped');
      expect(payload.deduped).toBe(0);

      vi.doUnmock('../dedup.js');
    });
  });

  // -------------------------------------------------------------------------
  // TD-066 / Risk #3 regression: legacy `rule:*` rows remain readable
  // -------------------------------------------------------------------------

  it('legacy source_extractor=rule:* rows persist to DB and are readable post-narrowing', async () => {
    // Insert with a legacy rule:* value directly (simulating pre-TD-066 row).
    // The TS narrowing is insert-side only; the DB column is just TEXT.
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, provenance,
        review_status, source_extractor)
       VALUES ('p', 'pattern', 'legacy rule row', 'body', 'inferred',
        'pending_review', 'rule:learned_marker')`,
    ).run();

    const row = db
      .prepare(`SELECT source_extractor, review_status FROM learnings WHERE title = 'legacy rule row'`)
      .get() as { source_extractor: string; review_status: string };
    expect(row.source_extractor).toBe('rule:learned_marker');
    expect(row.review_status).toBe('pending_review');
  });

  // -------------------------------------------------------------------------
  // TD-062: persisted source_extractor column reflects candidate value across
  // both LLM (perception path) and manual (conscious path) inserts, and
  // survives a review_status flip during approval.
  // -------------------------------------------------------------------------
  //
  // Brief vocabulary drift: TD-062 originally asked for an assertion of
  // `source_extractor='rule:learned_marker'`, but TD-066 deleted the rule
  // extractors. Adapted to the current canonical 3-value enum
  // (`'llm' | 'manual' | 'distill'` — see VALID_SOURCE_EXTRACTOR in
  // tools/memory.ts and SourceExtractor in perception/types.ts).

  it('TD-062: persists source_extractor verbatim and is unchanged after approval', async () => {
    const events: TranscriptEvent[] = [
      { role: 'user', content: 'X'.repeat(2000), timestamp: '' },
    ];
    const stubLlm = vi.fn(async () => [
      makeCandidate({ title: 'finding-llm-1', source_extractor: 'llm' }),
      makeCandidate({ title: 'finding-llm-2', source_extractor: 'llm' }),
    ]);
    await runPerception(
      db,
      { events, project: 'p', source: 'session_end' },
      { ...DEFAULT_PERCEPTION_CONFIG, extractor_llm_enabled: true },
      stubLlm,
    );

    // Insert a manual row directly (simulates igris_memory_store conscious path).
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, scope,
        provenance, review_status, source_extractor)
       VALUES ('p', 'pattern', 'manual-row', 'body', 'local',
        'human_asserted', 'approved', 'manual')`,
    ).run();

    const rows = db
      .prepare(
        `SELECT title, source_extractor, review_status FROM learnings ORDER BY id`,
      )
      .all() as Array<{ title: string; source_extractor: string; review_status: string }>;

    expect(rows).toHaveLength(3);
    expect(rows[0].source_extractor).toBe('llm');
    expect(rows[0].review_status).toBe('pending_review');
    expect(rows[1].source_extractor).toBe('llm');
    expect(rows[1].review_status).toBe('pending_review');
    expect(rows[2].source_extractor).toBe('manual');
    expect(rows[2].review_status).toBe('approved');

    // Simulate approval: flip review_status. source_extractor must NOT change.
    db.prepare(
      `UPDATE learnings SET review_status='approved' WHERE source_extractor='llm'`,
    ).run();
    const after = db
      .prepare(
        `SELECT source_extractor, review_status FROM learnings WHERE title='finding-llm-1'`,
      )
      .get() as { source_extractor: string; review_status: string };
    expect(after.source_extractor).toBe('llm');
    expect(after.review_status).toBe('approved');
  });
});
