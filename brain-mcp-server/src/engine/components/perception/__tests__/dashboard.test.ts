/**
 * TD-171 M3 — igris_perception_dashboard handler tests.
 *
 * Coverage:
 *   - canonical _dashboard shape: totals + recent + samples blocks
 *   - summary_only=true omits samples block
 *   - days window narrows recent.* AND _last_n totals
 *   - project filter narrows totals AND recent
 *   - run_outcomes aggregated from event_log
 *   - dedup_rediscoveries counted from event_log
 *   - pending count includes all pending_review rows (no TTL filter)
 *   - empty DB returns zeroed shape without throwing
 *   - rejects negative days
 *   - rejects unknown args via gateway strict-input contract (TD-128)
 *
 * Per L-152: scope is strictly the perception channel — no subconscious or
 * janitor concerns.
 *
 * @module engine/components/perception/__tests__/dashboard.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

import { getDb } from '../../../../db.js';
import { handlePerceptionDashboard, setHandlerContext } from '../handlers.js';
import { DEFAULT_PERCEPTION_CONFIG } from '../types.js';
import { createGateway } from '../../../gateway.js';
import { createPerceptionComponent } from '../index.js';

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
      provenance TEXT NOT NULL DEFAULT 'observed',
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      component TEXT NOT NULL DEFAULT 'perception',
      payload TEXT NOT NULL DEFAULT '{}',
      machine_hostname TEXT,
      project_slug TEXT,
      instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seedLearning(
  db: Database.Database,
  overrides: Partial<{
    project: string;
    review_status: string;
    provenance: string;
    source_extractor: string;
    created_at: string | null;
  }> = {},
): number {
  const data = {
    project: 'p',
    review_status: 'pending_review',
    provenance: 'inferred',
    source_extractor: 'llm_via_claude_code',
    created_at: null as string | null,
    ...overrides,
  };
  const sql = data.created_at
    ? `INSERT INTO learnings (project, category, title, content, review_status, provenance, source_extractor, created_at)
       VALUES (?, 'pattern', 't', 'c', ?, ?, ?, ?)`
    : `INSERT INTO learnings (project, category, title, content, review_status, provenance, source_extractor)
       VALUES (?, 'pattern', 't', 'c', ?, ?, ?)`;
  const params: (string | null)[] = [
    data.project,
    data.review_status,
    data.provenance,
    data.source_extractor,
  ];
  if (data.created_at) params.push(data.created_at);
  const r = db.prepare(sql).run(...params);
  return r.lastInsertRowid as number;
}

function seedEvent(
  db: Database.Database,
  overrides: Partial<{
    event_name: string;
    project_slug: string | null;
    created_at: string | null;
  }> = {},
): void {
  const data = {
    event_name: 'perception.run_succeeded',
    project_slug: 'p' as string | null,
    created_at: null as string | null,
    ...overrides,
  };
  if (data.created_at) {
    db.prepare(
      `INSERT INTO event_log (event_name, component, project_slug, created_at)
       VALUES (?, 'perception', ?, ?)`,
    ).run(data.event_name, data.project_slug, data.created_at);
  } else {
    db.prepare(
      `INSERT INTO event_log (event_name, component, project_slug)
       VALUES (?, 'perception', ?)`,
    ).run(data.event_name, data.project_slug);
  }
}

function parseJson(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

const noopBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };

beforeEach(() => {
  setHandlerContext({
    bus: noopBus,
    config: DEFAULT_PERCEPTION_CONFIG,
    llmExtractor: async () => [],
  });
});

describe('handlePerceptionDashboard (TD-171 M3)', () => {
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

  it('returns the canonical _dashboard shape with totals + recent + samples', () => {
    seedLearning(db, { review_status: 'pending_review' });
    seedLearning(db, { review_status: 'pending_review' });
    seedLearning(db, { review_status: 'approved', provenance: 'inferred' });
    seedEvent(db, { event_name: 'perception.run_succeeded' });
    seedEvent(db, { event_name: 'perception.run_succeeded' });
    seedEvent(db, { event_name: 'perception.run_failed' });
    seedEvent(db, { event_name: 'perception.run_skipped' });
    seedEvent(db, { event_name: 'perception.rediscovery' });
    seedEvent(db, { event_name: 'perception.rediscovery' });
    seedEvent(db, { event_name: 'perception.candidate_rejected' });

    const result = handlePerceptionDashboard({});
    const payload = parseJson(result);

    expect(Object.keys(payload).sort()).toEqual(['recent', 'samples', 'totals'].sort());

    const totals = payload.totals as Record<string, number>;
    expect(totals.pending).toBe(2);
    expect(totals.approved_last_n).toBe(1);
    expect(totals.rejected_last_n).toBe(1);

    const recent = payload.recent as Record<string, unknown>;
    expect(recent.last_n_days).toBe(30);
    const outcomes = recent.run_outcomes as Record<string, number>;
    expect(outcomes.succeeded).toBe(2);
    expect(outcomes.failed).toBe(1);
    expect(outcomes.skipped).toBe(1);
    expect(recent.dedup_rediscoveries).toBe(2);

    const samples = payload.samples as Record<string, unknown>;
    expect(Array.isArray(samples.top_extractors)).toBe(true);
    const topExtractors = samples.top_extractors as { source_extractor: string; n: number }[];
    expect(topExtractors[0].source_extractor).toBe('llm_via_claude_code');
  });

  it('omits samples when summary_only=true', () => {
    seedLearning(db);
    const result = handlePerceptionDashboard({ summary_only: true });
    const payload = parseJson(result);
    expect(payload.samples).toBeUndefined();
    // counts still computed
    const totals = payload.totals as Record<string, number>;
    expect(totals.pending).toBe(1);
  });

  it('narrows totals + recent when project filter is set', () => {
    seedLearning(db, { project: 'project-a', review_status: 'pending_review' });
    seedLearning(db, { project: 'project-a', review_status: 'pending_review' });
    seedLearning(db, { project: 'project-b', review_status: 'pending_review' });
    seedEvent(db, { event_name: 'perception.run_succeeded', project_slug: 'project-a' });
    seedEvent(db, { event_name: 'perception.run_succeeded', project_slug: 'project-b' });

    const result = handlePerceptionDashboard({ project: 'project-a' });
    const payload = parseJson(result);

    expect(payload.project).toBe('project-a');
    const totals = payload.totals as Record<string, number>;
    expect(totals.pending).toBe(2);
    const outcomes = (payload.recent as Record<string, unknown>).run_outcomes as Record<
      string,
      number
    >;
    expect(outcomes.succeeded).toBe(1); // project-b's row excluded
  });

  it('narrows recent and _last_n totals via the days window', () => {
    // Approved row outside the window — should be excluded from approved_last_n.
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    seedLearning(db, {
      review_status: 'approved',
      provenance: 'inferred',
      created_at: oldDate,
    });
    seedLearning(db, { review_status: 'approved', provenance: 'inferred' }); // recent

    seedEvent(db, { event_name: 'perception.run_succeeded' }); // recent
    seedEvent(db, { event_name: 'perception.run_succeeded', created_at: oldDate }); // old

    const result = handlePerceptionDashboard({ days: 30 });
    const payload = parseJson(result);

    const totals = payload.totals as Record<string, number>;
    expect(totals.approved_last_n).toBe(1);
    const outcomes = (payload.recent as Record<string, unknown>).run_outcomes as Record<
      string,
      number
    >;
    expect(outcomes.succeeded).toBe(1);
    expect((payload.recent as Record<string, unknown>).last_n_days).toBe(30);
  });

  it('pending count includes ALL pending_review rows (no TTL filter)', () => {
    // Even very old pending rows show up in the operator inbox count.
    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    seedLearning(db, { review_status: 'pending_review', created_at: oldDate });
    seedLearning(db, { review_status: 'pending_review' });

    const result = handlePerceptionDashboard({});
    const payload = parseJson(result);
    const totals = payload.totals as Record<string, number>;
    expect(totals.pending).toBe(2);
  });

  it('returns zero-counts for an empty DB without throwing', () => {
    const result = handlePerceptionDashboard({});
    const payload = parseJson(result);
    const totals = payload.totals as Record<string, number>;
    expect(totals.pending).toBe(0);
    expect(totals.approved_last_n).toBe(0);
    expect(totals.rejected_last_n).toBe(0);
    const outcomes = (payload.recent as Record<string, unknown>).run_outcomes as Record<
      string,
      number
    >;
    expect(outcomes).toEqual({ succeeded: 0, failed: 0, skipped: 0 });
  });

  it('rejects negative days', () => {
    const result = handlePerceptionDashboard({ days: -5 });
    expect(result.content[0].text).toContain('days must be a non-negative number');
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128) — gateway-level
  // -------------------------------------------------------------------------

  it('rejects unknown args via the gateway strict-input contract (TD-128)', async () => {
    const gateway = createGateway();
    const component = createPerceptionComponent();
    gateway.register(component.tools());

    await expect(
      gateway.dispatch('igris_perception_dashboard', { bogus: 'x' }),
    ).rejects.toThrowError(/igris_perception_dashboard: unknown argument 'bogus'/);
  });
});
