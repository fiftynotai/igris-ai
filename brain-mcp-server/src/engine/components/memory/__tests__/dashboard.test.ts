/**
 * TD-171 M1 — igris_memory_dashboard handler tests.
 *
 * Coverage:
 *   - happy path: returns the canonical _dashboard shape
 *     (totals.total, by_category, by_scope, by_provenance, by_review_status,
 *      recent.last_n_days, recent.stored, recent.top_tags, samples)
 *   - summary_only=true omits the samples array
 *   - project filter narrows totals AND recent + samples
 *   - days filter changes the recent.last_n_days echo
 *   - all VALID_CATEGORIES + VALID_LEARNING_PROVENANCE keys present even
 *     with zero rows of that type (canonical-shape contract for downstream
 *     UI / summarizers)
 *   - rejects unknown args via gateway strict-input contract (TD-128)
 *   - rejects negative days
 *
 * @module engine/components/memory/__tests__/dashboard.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  processInBatches: vi.fn(),
}));

vi.mock('../../../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbedding: vi.fn(),
  vectorSearch: vi.fn(() => []),
}));

import { getDb } from '../../../../db.js';
import { handleMemoryDashboard } from '../../../../tools/memory.js';
import { createGateway } from '../../../gateway.js';
import { createMemoryComponent } from '../index.js';

const mockedGetDb = vi.mocked(getDb);

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
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
      provenance TEXT NOT NULL DEFAULT 'observed',
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual'
    );
  `);
  return db;
}

interface SeedSpec {
  project?: string;
  category?: string;
  title?: string;
  content?: string;
  tags?: string;
  scope?: string;
  provenance?: string;
  review_status?: string;
  // ISO timestamp; pass an old date to push a row outside the recent window.
  created_at?: string;
}

function seed(db: Database.Database, spec: SeedSpec = {}): number {
  const data = {
    project: 'test-project',
    category: 'pattern',
    title: 'A learning',
    content: 'Some content here',
    tags: 'a,b',
    scope: 'local',
    provenance: 'observed',
    review_status: 'approved',
    created_at: null as string | null,
    ...spec,
  };
  const sql = data.created_at
    ? `INSERT INTO learnings (project, category, title, content, tags, scope, provenance, review_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    : `INSERT INTO learnings (project, category, title, content, tags, scope, provenance, review_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  const params: (string | null)[] = [
    data.project,
    data.category,
    data.title,
    data.content,
    data.tags,
    data.scope,
    data.provenance,
    data.review_status,
  ];
  if (data.created_at) params.push(data.created_at);
  const result = db.prepare(sql).run(...params);
  return result.lastInsertRowid as number;
}

function parseJsonResult(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('handleMemoryDashboard (TD-171 M1)', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns the canonical _dashboard shape with counts populated', () => {
    seed(db, { category: 'pattern', scope: 'local', provenance: 'observed' });
    seed(db, { category: 'decision', scope: 'global', provenance: 'inferred' });
    seed(db, { category: 'mistake', scope: 'local', provenance: 'human_asserted', review_status: 'pending_review' });

    const result = handleMemoryDashboard({});
    const payload = parseJsonResult(result) as Record<string, Record<string, unknown>>;

    // Top-level keys
    expect(Object.keys(payload).sort()).toEqual(['recent', 'samples', 'totals'].sort());

    // totals.*
    expect(payload.totals.total).toBe(3);
    const byCategory = payload.totals.by_category as Record<string, number>;
    // Every VALID_CATEGORIES key must be present (zero-defaulted)
    expect(Object.keys(byCategory).sort()).toEqual(
      ['decision', 'discovery', 'mistake', 'optimization', 'pattern'].sort(),
    );
    expect(byCategory.pattern).toBe(1);
    expect(byCategory.decision).toBe(1);
    expect(byCategory.mistake).toBe(1);
    expect(byCategory.discovery).toBe(0);
    expect(byCategory.optimization).toBe(0);

    const byScope = payload.totals.by_scope as Record<string, number>;
    expect(byScope).toEqual({ local: 2, global: 1 });

    const byProv = payload.totals.by_provenance as Record<string, number>;
    expect(Object.keys(byProv).sort()).toEqual(
      ['ambiguous', 'human_asserted', 'inferred', 'observed', 'synthesized'].sort(),
    );
    expect(byProv.observed).toBe(1);
    expect(byProv.inferred).toBe(1);
    expect(byProv.human_asserted).toBe(1);
    expect(byProv.synthesized).toBe(0);
    expect(byProv.ambiguous).toBe(0);

    const byReview = payload.totals.by_review_status as Record<string, number>;
    expect(byReview).toEqual({ approved: 2, pending_review: 1 });

    // recent.*
    expect(payload.recent.last_n_days).toBe(30);
    expect(payload.recent.stored).toBe(3);
    expect(Array.isArray(payload.recent.top_tags)).toBe(true);

    // samples present and bounded
    expect(Array.isArray(payload.samples)).toBe(true);
    expect((payload.samples as unknown[]).length).toBe(3);
  });

  it('omits samples when summary_only=true', () => {
    seed(db);
    seed(db);
    const result = handleMemoryDashboard({ summary_only: true });
    const payload = parseJsonResult(result);
    expect(payload.samples).toBeUndefined();
    // Counts are still computed
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total).toBe(2);
  });

  it('narrows totals + recent + samples when project filter is set', () => {
    seed(db, { project: 'project-a' });
    seed(db, { project: 'project-a' });
    seed(db, { project: 'project-b' });

    const result = handleMemoryDashboard({ project: 'project-a' });
    const payload = parseJsonResult(result);

    expect(payload.project).toBe('project-a');
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total).toBe(2);
    const recent = payload.recent as Record<string, unknown>;
    expect(recent.stored).toBe(2);
    const samples = payload.samples as Record<string, unknown>[];
    expect(samples.every((s) => s.project === 'project-a')).toBe(true);
  });

  it('echoes the days filter and limits the recent window accordingly', () => {
    // Two recent rows + one old row (60 days ago) — with days=30 we expect 2 recent.
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    seed(db);
    seed(db);
    seed(db, { created_at: oldDate });

    const result = handleMemoryDashboard({ days: 30 });
    const payload = parseJsonResult(result);
    const recent = payload.recent as Record<string, unknown>;
    const totals = payload.totals as Record<string, unknown>;

    expect(recent.last_n_days).toBe(30);
    expect(recent.stored).toBe(2);
    // Total counts ALL rows, recent counts only rows within the window.
    expect(totals.total).toBe(3);
  });

  it('aggregates top_tags across rows in the recent window', () => {
    seed(db, { tags: 'sqlite,fts5' });
    seed(db, { tags: 'sqlite,perf' });
    seed(db, { tags: 'fts5' });
    const result = handleMemoryDashboard({});
    const payload = parseJsonResult(result);
    const recent = payload.recent as Record<string, unknown>;
    const topTags = recent.top_tags as { tag: string; count: number }[];
    const tagMap = new Map(topTags.map((t) => [t.tag, t.count]));
    expect(tagMap.get('sqlite')).toBe(2);
    expect(tagMap.get('fts5')).toBe(2);
    expect(tagMap.get('perf')).toBe(1);
  });

  it('returns zero-counts for an empty DB without throwing', () => {
    const result = handleMemoryDashboard({});
    const payload = parseJsonResult(result) as Record<string, Record<string, unknown>>;
    expect(payload.totals.total).toBe(0);
    expect((payload.totals.by_category as Record<string, number>).pattern).toBe(0);
    expect((payload.recent as Record<string, unknown>).stored).toBe(0);
    expect((payload.recent as Record<string, unknown>).top_tags).toEqual([]);
  });

  it('rejects negative days', () => {
    const result = handleMemoryDashboard({ days: -5 });
    expect(result.content[0].text).toContain('days must be a non-negative number');
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128) — gateway-level
  // -------------------------------------------------------------------------

  it('rejects unknown args via the gateway strict-input contract (TD-128)', async () => {
    const gateway = createGateway();
    const component = createMemoryComponent();
    gateway.register(component.tools());

    await expect(
      gateway.dispatch('igris_memory_dashboard', { bogus_extra: 'should-throw' }),
    ).rejects.toThrowError(
      /igris_memory_dashboard: unknown argument 'bogus_extra'\. Accepted keys: .*\. \(strict-input contract; TD-128\)/,
    );
  });

  it('dispatches cleanly via the gateway with no args (defaults applied)', async () => {
    const gateway = createGateway();
    const component = createMemoryComponent();
    gateway.register(component.tools());

    seed(db);
    const result = await gateway.dispatch('igris_memory_dashboard', {});
    const payload = parseJsonResult(result as { content: { text: string }[] });
    const recent = payload.recent as Record<string, unknown>;
    expect(recent.last_n_days).toBe(30);
  });
});
