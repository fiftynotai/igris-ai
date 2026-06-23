/**
 * FR-118 M4a — perception flip CHARACTERIZATION test (the anti-weakening proof).
 *
 * The behavioral contract that makes "behavior preserved" a CHECKED ARTIFACT,
 * not a claim. For a FIXED corpus of canned transcripts + canned LLM responses
 * (reused from `perception/__tests__/fixtures/`), it captures the FULL
 * observable output of the live perception path:
 *
 *   1. the `learnings` rows inserted (the EXACT persisted columns)
 *   2. the dedup / rediscovery decisions (`inserted` / `suppressed` / `deduped`
 *      counts + `deduped_ids` + the `seen_again_count` bumps + the
 *      `perception.rediscovery` event payloads)
 *   3. the ORDERED lifecycle event list (`event_log` rows under
 *      `component='perception'`, in id order, with their payloads)
 *
 * The golden (`CHARACTERIZATION_GOLDEN` below) was captured against the
 * COMMITTED M3 path (the `runPerception` orchestration) BEFORE the A1/A2 flip.
 * After the flip — where `runPerception` delegates persistence + cosine dedup
 * to the now-complete perception INSTANCE's `persistCandidate` — the SAME corpus
 * driven through the SAME `runPerception` entry point MUST reproduce this golden
 * byte-for-byte. A weakened oracle (e.g. a dropped dedup or a missing
 * rediscovery event) fails HERE even if the lighter structural tests are
 * loosened.
 *
 * Why drive `runPerception` (not `runExtractor` directly): `runPerception` is
 * the entry point the perception handler + the 6 oracle tests assert against
 * (the `RunPerceptionResult` contract). Capturing at that boundary means the
 * golden is invariant to HOW the flip rewires the internals — it pins WHAT the
 * caller observes.
 *
 * @module engine/components/cognition/__tests__/perception-flip-characterization.test
 * @author fifty.dev
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The perception runner calls embeddings + vector-search per insert. Stub them
// so the characterization runs without the Xenova model or the vec0 extension —
// `isVectorSearchAvailable=false` means the persist path skips embedding writes
// and the cosine dedup pre-filter early-exits to null (no match) UNLESS a test
// drives the dedup branch via the runner-level `findNearestMatch` seam below.
vi.mock('../../../../utils/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(384)),
  embeddingToBuffer: vi.fn((e: Float32Array) =>
    Buffer.from(e.buffer, e.byteOffset, e.byteLength),
  ),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DIMENSIONS: 384,
}));
vi.mock('../../../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbedding: vi.fn(),
  vectorSearch: vi.fn(() => []),
}));

import { runPerception } from '../../perception/runner.js';
import {
  DEFAULT_PERCEPTION_CONFIG,
  type PerceptionCandidate,
  type TranscriptEvent,
} from '../../perception/types.js';
import type { LlmExtractor } from '../../perception/extractors/llm_via_claude_code.js';

// ---------------------------------------------------------------------------
// Fixed test DB — full learnings + event_log column shape
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
      source_extractor TEXT NOT NULL DEFAULT 'manual',
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

// ---------------------------------------------------------------------------
// The fixed canned corpus (reuses the perception fixtures' vocabulary)
// ---------------------------------------------------------------------------

const BIG = 'X'.repeat(2000);
const EVENTS: TranscriptEvent[] = [{ role: 'user', content: BIG, timestamp: '' }];

/** A stable candidate factory — no Math.random so the golden is deterministic. */
function cand(over: Partial<PerceptionCandidate> = {}): PerceptionCandidate {
  return {
    category: 'pattern',
    title: 'default title',
    content: 'default content body',
    tags: ['t'],
    confidence: 0.7,
    source_extractor: 'llm',
    evidence: { transcript_excerpt: 'snippet' },
    ...over,
  };
}

/** Three valid, distinct candidates — the happy persist path. */
const CANNED_THREE: PerceptionCandidate[] = [
  cand({ title: 'Alpha finding', content: 'alpha body', confidence: 0.6, tags: ['a'] }),
  cand({ title: 'Beta finding', content: 'beta body', confidence: 0.8, category: 'decision', tags: ['b', 'c'] }),
  cand({ title: 'Gamma finding', content: 'gamma body', confidence: 0.5, category: 'mistake', tags: [] }),
];

/** Overlapping titles — intra-run dedupeByTitle drops the lower-confidence dup. */
const CANNED_DEDUP: PerceptionCandidate[] = [
  cand({ title: 'Shared finding', content: 'first phrasing', confidence: 0.5 }),
  cand({ title: 'SHARED FINDING', content: 'second phrasing', confidence: 0.85 }),
  cand({ title: 'Unique finding', content: 'distinct', confidence: 0.7 }),
];

const stubLlm = (out: PerceptionCandidate[]): LlmExtractor => async () => out;

// ---------------------------------------------------------------------------
// Capture helpers — the three observable surfaces
// ---------------------------------------------------------------------------

interface CapturedRow {
  project: string;
  category: string;
  title: string;
  content: string;
  tags: string;
  tech_stack: string;
  scope: string;
  source_brief: string;
  confidence: number;
  provenance: string;
  review_status: string;
  source_extractor: string;
  seen_again_count: number;
}

function captureRows(db: Database.Database): CapturedRow[] {
  return db
    .prepare(
      `SELECT project, category, title, content, tags, tech_stack, scope,
              source_brief, confidence, provenance, review_status,
              source_extractor, seen_again_count
       FROM learnings ORDER BY id ASC`,
    )
    .all() as CapturedRow[];
}

interface CapturedEvent {
  event_name: string;
  /** Payload minus the volatile duration_ms (timing is not part of the contract). */
  payload: Record<string, unknown>;
}

function captureEvents(db: Database.Database): CapturedEvent[] {
  const rows = db
    .prepare(
      `SELECT event_name, payload FROM event_log
       WHERE component = 'perception' ORDER BY id ASC`,
    )
    .all() as { event_name: string; payload: string }[];
  return rows.map((r) => {
    const payload = JSON.parse(r.payload) as Record<string, unknown>;
    // duration_ms is wall-clock and not behaviorally meaningful — drop it so
    // the golden is reproducible across runs.
    delete payload.duration_ms;
    // transcript_window_ts is an ISO 'now' on rediscovery — also volatile.
    delete payload.transcript_window_ts;
    return { event_name: r.event_name, payload };
  });
}

interface Captured {
  result: {
    llm_extracted: number;
    suppressed: number;
    inserted: number;
    inserted_ids_len: number;
    llm_status: string;
    by_source: Record<string, number>;
    deduped: number;
    deduped_ids: number[];
  };
  rows: CapturedRow[];
  events: CapturedEvent[];
}

// ---------------------------------------------------------------------------
// THE GOLDEN — captured against the committed M3 `runPerception` path.
// ---------------------------------------------------------------------------
//
// Every field here is the OBSERVABLE behavior the flip must reproduce. The
// `inserted_ids_len` (not the literal ids — AUTOINCREMENT is seed-dependent)
// plus the row columns + the event sequence + the result counts are the
// contract. The dedup scenario seeds an existing row and drives the cosine
// pre-filter via the runner's `findNearestMatch` seam.

const GOLDEN_HAPPY: Captured = {
  result: {
    llm_extracted: 3,
    suppressed: 0,
    inserted: 3,
    inserted_ids_len: 3,
    llm_status: 'ran',
    by_source: { llm: 3, manual: 0, distill: 0 },
    deduped: 0,
    deduped_ids: [],
  },
  rows: [
    {
      project: 'p', category: 'pattern', title: 'Alpha finding', content: 'alpha body',
      tags: 'a', tech_stack: '', scope: 'local', source_brief: '', confidence: 0.6,
      provenance: 'inferred', review_status: 'pending_review', source_extractor: 'llm',
      seen_again_count: 0,
    },
    {
      project: 'p', category: 'decision', title: 'Beta finding', content: 'beta body',
      tags: 'b,c', tech_stack: '', scope: 'local', source_brief: '', confidence: 0.8,
      provenance: 'inferred', review_status: 'pending_review', source_extractor: 'llm',
      seen_again_count: 0,
    },
    {
      project: 'p', category: 'mistake', title: 'Gamma finding', content: 'gamma body',
      tags: '', tech_stack: '', scope: 'local', source_brief: '', confidence: 0.5,
      provenance: 'inferred', review_status: 'pending_review', source_extractor: 'llm',
      seen_again_count: 0,
    },
  ],
  events: [
    {
      event_name: 'perception.run_started',
      payload: { project: 'p', transcript_bytes: 2000, source: 'session_end', trigger: 'detached' },
    },
    {
      event_name: 'perception.run_succeeded',
      payload: {
        project: 'p', trigger: 'detached', candidates_count: 3, llm_extracted: 3,
        suppressed: 0, deduped: 0, llm_status: 'ran', transcript_bytes: 2000,
      },
    },
  ],
};

const GOLDEN_DEDUP_TITLE: Captured = {
  result: {
    llm_extracted: 3,
    suppressed: 1,
    inserted: 2,
    inserted_ids_len: 2,
    llm_status: 'ran',
    by_source: { llm: 2, manual: 0, distill: 0 },
    deduped: 0,
    deduped_ids: [],
  },
  rows: [
    // dedupeByTitle keeps the HIGHEST-CONFIDENCE candidate verbatim (its
    // original 'SHARED FINDING' casing), not the normalized dedupe key.
    {
      project: 'p', category: 'pattern', title: 'SHARED FINDING', content: 'second phrasing',
      tags: 't', tech_stack: '', scope: 'local', source_brief: '', confidence: 0.85,
      provenance: 'inferred', review_status: 'pending_review', source_extractor: 'llm',
      seen_again_count: 0,
    },
    {
      project: 'p', category: 'pattern', title: 'Unique finding', content: 'distinct',
      tags: 't', tech_stack: '', scope: 'local', source_brief: '', confidence: 0.7,
      provenance: 'inferred', review_status: 'pending_review', source_extractor: 'llm',
      seen_again_count: 0,
    },
  ],
  events: [
    {
      event_name: 'perception.run_started',
      payload: { project: 'p', transcript_bytes: 2000, source: 'session_end', trigger: 'detached' },
    },
    {
      event_name: 'perception.run_succeeded',
      payload: {
        project: 'p', trigger: 'detached', candidates_count: 2, llm_extracted: 3,
        suppressed: 1, deduped: 0, llm_status: 'ran', transcript_bytes: 2000,
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// The characterization assertions
// ---------------------------------------------------------------------------

describe('FR-118 M4a — perception flip characterization (behavior-preserving)', () => {
  let db: Database.Database;
  const config = {
    ...DEFAULT_PERCEPTION_CONFIG,
    extractor_llm_enabled: true,
    llm_min_transcript_bytes: 0,
  };

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('HAPPY: three distinct candidates → 3 inserts, exact columns + lifecycle', async () => {
    const result = await runPerception(
      db,
      { events: EVENTS, project: 'p', source: 'session_end', trigger: 'detached' },
      config,
      stubLlm(CANNED_THREE),
    );

    const captured: Captured = {
      result: {
        llm_extracted: result.llm_extracted,
        suppressed: result.suppressed,
        inserted: result.inserted,
        inserted_ids_len: result.inserted_ids.length,
        llm_status: result.llm_status,
        by_source: result.by_source,
        deduped: result.deduped,
        deduped_ids: result.deduped_ids,
      },
      rows: captureRows(db),
      events: captureEvents(db),
    };

    expect(captured).toEqual(GOLDEN_HAPPY);
  });

  it('INTRA-RUN TITLE DEDUP: overlapping titles → highest-confidence wins, 1 suppressed', async () => {
    const result = await runPerception(
      db,
      { events: EVENTS, project: 'p', source: 'session_end', trigger: 'detached' },
      config,
      stubLlm(CANNED_DEDUP),
    );

    const captured: Captured = {
      result: {
        llm_extracted: result.llm_extracted,
        suppressed: result.suppressed,
        inserted: result.inserted,
        inserted_ids_len: result.inserted_ids.length,
        llm_status: result.llm_status,
        by_source: result.by_source,
        deduped: result.deduped,
        deduped_ids: result.deduped_ids,
      },
      rows: captureRows(db),
      events: captureEvents(db),
    };

    expect(captured).toEqual(GOLDEN_DEDUP_TITLE);
  });

  it('COSINE DEDUP + REDISCOVERY: a near-duplicate skips insert, bumps seen_again_count, emits perception.rediscovery', async () => {
    // Pre-seed an existing learning the dedup seam will pretend to match.
    const existingId = Number(
      db
        .prepare(
          `INSERT INTO learnings (project, category, title, content,
            provenance, review_status, source_extractor, seen_again_count)
           VALUES ('p', 'pattern', 'existing finding', 'body',
            'inferred', 'approved', 'llm', 0)`,
        )
        .run().lastInsertRowid,
    );

    // Drive the cosine pre-filter deterministically via the runner's dedup seam.
    // The flip keeps this seam working: the cosine check + recordRediscovery +
    // the `perception.rediscovery` event must reproduce identically whether the
    // check lives in the runner or the instance's persistCandidate.
    vi.doMock('../../perception/dedup.js', async () => {
      const actual = await vi.importActual<typeof import('../../perception/dedup.js')>(
        '../../perception/dedup.js',
      );
      return {
        ...actual,
        findNearestMatch: vi.fn(async () => ({
          matched_id: existingId,
          status: 'approved',
          similarity: 0.92,
        })),
      };
    });
    // FR-118 M4a: the cosine dedup pre-filter now lives in the perception
    // INSTANCE's persistCandidate (the runner delegates persistence). The
    // instance module imports dedup.js, so the mock must reach it — reset the
    // module graph so the freshly-imported runner re-evaluates the instance
    // (and its dedup.js import) UNDER the doMock, not the stale cached binding.
    vi.resetModules();
    const { runPerception: runStubbed } = await import('../../perception/runner.js');

    const result = await runStubbed(
      db,
      { events: EVENTS, project: 'p', source: 'session_end', trigger: 'detached' },
      config,
      stubLlm([cand({ title: 'paraphrase of existing finding', content: 'dup body' })]),
    );

    // Decisions: 0 inserted, 1 deduped, the matched id bumped.
    expect(result.inserted).toBe(0);
    expect(result.deduped).toBe(1);
    expect(result.deduped_ids).toEqual([existingId]);

    const bumped = db
      .prepare('SELECT seen_again_count, last_seen_at FROM learnings WHERE id = ?')
      .get(existingId) as { seen_again_count: number; last_seen_at: string | null };
    expect(bumped.seen_again_count).toBe(1);
    expect(bumped.last_seen_at).not.toBeNull();

    // The rediscovery event payload (the contract the oracle + /scan read).
    const rediscovery = db
      .prepare(
        "SELECT payload FROM event_log WHERE event_name='perception.rediscovery'",
      )
      .all() as { payload: string }[];
    expect(rediscovery).toHaveLength(1);
    const payload = JSON.parse(rediscovery[0].payload) as Record<string, unknown>;
    expect(payload.existing_learning_id).toBe(existingId);
    expect(payload.existing_status).toBe('approved');
    expect(payload.similarity_score).toBeCloseTo(0.92, 2);
    expect(payload.trigger).toBe('detached');

    // No fresh learnings row inserted (the dup was the only candidate).
    const total = db.prepare('SELECT COUNT(*) AS n FROM learnings').get() as { n: number };
    expect(total.n).toBe(1); // only the pre-seeded row

    // Lifecycle: started + succeeded (rediscovery is an in-loop event, the run
    // still succeeds with candidates_count=0).
    const lifecycle = db
      .prepare(
        "SELECT event_name FROM event_log WHERE component='perception' AND event_name LIKE 'perception.run_%' ORDER BY id ASC",
      )
      .all() as { event_name: string }[];
    expect(lifecycle.map((e) => e.event_name)).toEqual([
      'perception.run_started',
      'perception.run_succeeded',
    ]);

    vi.doUnmock('../../perception/dedup.js');
  });

  it('GATE SKIP (disabled): no extractor call, lifecycle still started+succeeded with skipped:disabled status', async () => {
    const calledLlm = vi.fn(async () => CANNED_THREE);
    const result = await runPerception(
      db,
      { events: EVENTS, project: 'p', source: 'session_end', trigger: 'detached' },
      { ...config, extractor_llm_enabled: false },
      calledLlm,
    );

    expect(calledLlm).not.toHaveBeenCalled();
    expect(result.llm_status).toBe('skipped:disabled');
    expect(result.inserted).toBe(0);
    expect(captureRows(db)).toHaveLength(0);
    expect(captureEvents(db).map((e) => e.event_name)).toEqual([
      'perception.run_started',
      'perception.run_succeeded',
    ]);
  });
});
