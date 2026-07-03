/**
 * Cognition perception INSTANCE tests (FR-118 M1).
 *
 * The perception instance is the proving instance: it declares the
 * `CognitionInstance` contract over perception's existing pure helpers, so the
 * agnostic engine (`runExtractor`) reproduces today's perception behavior. The
 * end-to-end behavioral ORACLE lives in `perception/__tests__/*` (unchanged);
 * THIS file covers the instance's slot wiring in isolation:
 *   - buildContext   parses the transcript + measures input bytes
 *   - promptBuilder  builds perception's system + user prompt
 *   - parseResponse  validates/caps the LLM JSON
 *   - persistCandidate INSERTs a learnings row (provenance/review_status)
 *   - the instance is discoverable in the OPEN registry (zero-host-change)
 *
 * @module engine/components/cognition/__tests__/perception-instance.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Embeddings + vector-search are called per insert — stub them out.
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

import {
  createPerceptionInstance as createPerceptionInstanceBundle,
  perceptionInstance,
  perceptionInstanceConfig,
  type PerceptionContext,
} from '../extractors/perception.js';
import type { CognitionInstance } from '../types.js';
import type { PerceptionExtractorConfig, PerceptionCandidate } from '../../perception/types.js';
import { createCognitionRegistry, discoverInstances } from '../registry.js';
import { DEFAULT_PERCEPTION_CONFIG } from '../../perception/types.js';
import { LLM_CONFIDENCE_CAP } from '../../perception/extractors/llm_via_claude_code.js';

// FR-118 M4a: createPerceptionInstance now returns a {instance, takeOutcomes,
// takeSuppressed} bundle (the instance owns persistence + dedup; the
// accumulator surfaces inserted/deduped counts to runPerception). These slot-
// wiring tests only need the CognitionInstance — unwrap `.instance`. This is a
// STRUCTURAL adaptation (how the instance is constructed), not a behavioral
// assertion change.
function createPerceptionInstance(
  config?: PerceptionExtractorConfig,
): CognitionInstance<PerceptionContext, PerceptionCandidate> {
  return createPerceptionInstanceBundle(config).instance;
}

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
      embedding BLOB,
      embedding_model TEXT DEFAULT '',
      provenance TEXT NOT NULL DEFAULT 'observed',
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual'
    );
  `);
  return db;
}

const JSONL = JSON.stringify({
  role: 'assistant',
  content: 'X'.repeat(2000),
  timestamp: '2026-06-23T00:00:00Z',
});

describe('perceptionInstance — identity + config', () => {
  it('declares id="perception"', () => {
    expect(perceptionInstance.id).toBe('perception');
  });

  it('maps perception config onto the engine config envelope (default harness inherits global)', () => {
    const cfg = perceptionInstanceConfig(DEFAULT_PERCEPTION_CONFIG);
    expect(cfg.timeout_ms).toBe(DEFAULT_PERCEPTION_CONFIG.llm_timeout_ms);
    expect(cfg.min_input_bytes).toBe(DEFAULT_PERCEPTION_CONFIG.llm_min_transcript_bytes);
    expect(cfg.enabled).toBe(DEFAULT_PERCEPTION_CONFIG.extractor_llm_enabled);
    // null = inherit the global llm_extractor.harness default (claude) — perception
    // does NOT pin claude on the instance (back-compat preserved by the global).
    expect(cfg.harness).toBeNull();
  });
});

describe('perceptionInstance — buildContext (slot 1)', () => {
  it('parses the transcript into events and measures input bytes', async () => {
    const inst = createPerceptionInstance();
    const ctx = await inst.buildContext(makeTestDb(), {
      project: 'p',
      transcript_text: JSONL,
      brief_id: 'FR-118',
    });
    expect(ctx.project).toBe('p');
    expect(ctx.brief_id).toBe('FR-118');
    expect(ctx.events.length).toBe(1);
    expect(ctx.transcript_bytes).toBe(2000);
    expect(inst.inputBytes?.(ctx)).toBe(2000);
  });
});

describe('perceptionInstance — promptBuilder (slot 3)', () => {
  it('builds the perception system + user prompt with the transcript delimiter', async () => {
    const inst = createPerceptionInstance();
    const ctx: PerceptionContext = {
      events: [{ role: 'user', content: 'a learning happened', timestamp: '' }],
      project: 'igris-ai',
      config: DEFAULT_PERCEPTION_CONFIG,
      transcript_bytes: 18,
      brief_id: 'FR-118',
    };
    const prompt = inst.promptBuilder(ctx);
    expect(prompt.system).toContain('JSON array');
    expect(prompt.system).toContain('CONSERVATIVE');
    expect(prompt.user).toContain('<transcript>');
    expect(prompt.user).toContain('Project: igris-ai');
    expect(prompt.user).toContain('Brief: FR-118');
  });
});

describe('perceptionInstance — parseResponse (validate + cap)', () => {
  it('validates + caps confidence and drops invalid candidates', () => {
    const inst = createPerceptionInstance();
    const raw = JSON.stringify([
      { category: 'pattern', title: 'good', content: 'body', tags: [], confidence: 0.99, evidence: {} },
      { category: 'gossip', title: 'bad-cat', content: 'body', tags: [], confidence: 0.5, evidence: {} },
    ]);
    const out = inst.parseResponse(raw, {} as PerceptionContext);
    expect(out.length).toBe(1);
    expect(out[0].title).toBe('good');
    expect(out[0].confidence).toBe(LLM_CONFIDENCE_CAP);
  });

  it('returns [] for a non-array / garbage response', () => {
    const inst = createPerceptionInstance();
    expect(inst.parseResponse('not json', {} as PerceptionContext)).toEqual([]);
    expect(inst.parseResponse('{"foo":"bar"}', {} as PerceptionContext)).toEqual([]);
  });
});

describe('perceptionInstance — persistCandidate (slot 2)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('INSERTs a learnings row with provenance=inferred + pending_review (default) + project from ctx', async () => {
    const inst = createPerceptionInstance(DEFAULT_PERCEPTION_CONFIG);
    // buildContext stashes the run context that persistCandidate reads.
    await inst.buildContext(db, { project: 'proj-x', transcript_text: JSONL, brief_id: 'BR-9' });
    await inst.persistCandidate(db, {
      category: 'pattern',
      title: 'a finding',
      content: 'body',
      tags: ['t'],
      confidence: 0.7,
      source_extractor: 'llm',
      evidence: {},
    });
    const row = db
      .prepare('SELECT project, provenance, review_status, source_extractor, source_brief FROM learnings')
      .get() as {
      project: string;
      provenance: string;
      review_status: string;
      source_extractor: string;
      source_brief: string;
    };
    expect(row.project).toBe('proj-x');
    expect(row.provenance).toBe('inferred');
    expect(row.review_status).toBe('pending_review');
    expect(row.source_extractor).toBe('llm');
    expect(row.source_brief).toBe('BR-9');
  });

  it('honours auto_approve_enabled=true (review_status=approved, provenance still inferred)', async () => {
    const inst = createPerceptionInstance({ ...DEFAULT_PERCEPTION_CONFIG, auto_approve_enabled: true });
    await inst.buildContext(db, { project: 'p', transcript_text: JSONL });
    await inst.persistCandidate(db, {
      category: 'decision',
      title: 'auto-approved',
      content: 'body',
      tags: [],
      confidence: 0.6,
      source_extractor: 'llm',
      evidence: {},
    });
    const row = db
      .prepare('SELECT review_status, provenance FROM learnings')
      .get() as { review_status: string; provenance: string };
    expect(row.review_status).toBe('approved');
    expect(row.provenance).toBe('inferred');
  });
});

describe('perceptionInstance — registry discovery (FR-202 zero-host-change)', () => {
  it('is discovered by the OPEN registry from the extractors barrel', () => {
    const registry = createCognitionRegistry();
    discoverInstances(registry);
    expect(registry.has('perception')).toBe(true);
    expect(registry.get('perception')?.id).toBe('perception');
  });
});
