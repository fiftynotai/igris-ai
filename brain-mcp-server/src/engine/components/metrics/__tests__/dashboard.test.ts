/**
 * TD-171 M4 — igris_metrics_dashboard handler tests.
 *
 * Coverage:
 *   - happy path: returns the canonical _dashboard shape
 *     (totals.total_invocations, by_agent, by_action, by_result with all
 *     four CHECK-constraint values zero-defaulted; recent.* with WoW delta;
 *     samples.top_durations)
 *   - summary_only=true omits the samples block
 *   - project filter scopes all aggregations
 *   - agent filter scopes all aggregations (and is combinable with project)
 *   - days filter narrows the recent.invocations count
 *   - WoW delta is null when prior week has zero invocations
 *   - rejects negative days
 *   - rejects unknown args via gateway strict-input contract (TD-128)
 *
 * @module engine/components/metrics/__tests__/dashboard.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import { handleMetricsDashboard } from '../../../../tools/metrics.js';
import { createGateway } from '../../../gateway.js';
import { createMetricsComponent } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      agent TEXT NOT NULL,
      brief_id TEXT DEFAULT '',
      action TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'partial', 'blocked')),
      duration_ms INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

interface MetricSeed {
  project?: string;
  agent?: string;
  brief_id?: string;
  action?: string;
  result?: 'success' | 'failure' | 'partial' | 'blocked';
  duration_ms?: number;
  retry_count?: number;
  /** ISO timestamp; pass an old date to push a row outside the recent window. */
  recorded_at?: string;
}

function seed(db: Database.Database, spec: MetricSeed = {}): void {
  const data = {
    project: 'p',
    agent: 'forger',
    brief_id: '',
    action: 'implement',
    result: 'success' as const,
    duration_ms: 100,
    retry_count: 0,
    recorded_at: null as string | null,
    ...spec,
  };
  if (data.recorded_at) {
    db.prepare(
      `INSERT INTO agent_metrics
         (project, agent, brief_id, action, result, duration_ms, retry_count, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      data.project,
      data.agent,
      data.brief_id,
      data.action,
      data.result,
      data.duration_ms,
      data.retry_count,
      data.recorded_at,
    );
  } else {
    db.prepare(
      `INSERT INTO agent_metrics
         (project, agent, brief_id, action, result, duration_ms, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      data.project,
      data.agent,
      data.brief_id,
      data.action,
      data.result,
      data.duration_ms,
      data.retry_count,
    );
  }
}

function parseJsonResult(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

/** ISO timestamp `daysAgo` days in the past (SQLite-compatible format). */
function isoDaysAgo(daysAgo: number): string {
  const t = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleMetricsDashboard (TD-171 M4)', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns the canonical _dashboard shape with by_result zero-defaulted', () => {
    seed(db, { agent: 'forger', action: 'implement', result: 'success', duration_ms: 100, retry_count: 0 });
    seed(db, { agent: 'forger', action: 'implement', result: 'failure', duration_ms: 200, retry_count: 1 });
    seed(db, { agent: 'sentinel', action: 'test', result: 'success', duration_ms: 50, retry_count: 0 });

    const result = handleMetricsDashboard({});
    const payload = parseJsonResult(result) as Record<string, Record<string, unknown>>;

    // Top-level keys
    expect(Object.keys(payload).sort()).toEqual(['recent', 'samples', 'totals'].sort());

    // totals.total_invocations
    expect(payload.totals.total_invocations).toBe(3);

    // totals.by_agent
    const byAgent = payload.totals.by_agent as Record<string, Record<string, number>>;
    expect(Object.keys(byAgent).sort()).toEqual(['forger', 'sentinel'].sort());
    expect(byAgent.forger.invocations).toBe(2);
    expect(byAgent.forger.success_rate).toBe(0.5);
    expect(byAgent.forger.avg_duration_ms).toBe(150);
    expect(byAgent.forger.retries).toBe(1);
    expect(byAgent.sentinel.invocations).toBe(1);
    expect(byAgent.sentinel.success_rate).toBe(1);

    // totals.by_action
    const byAction = payload.totals.by_action as Record<string, Record<string, number>>;
    expect(byAction.implement.invocations).toBe(2);
    expect(byAction.implement.success_rate).toBe(0.5);
    expect(byAction.test.invocations).toBe(1);
    expect(byAction.test.success_rate).toBe(1);

    // totals.by_result — every CHECK-constraint key zero-defaulted
    const byResult = payload.totals.by_result as Record<string, number>;
    expect(Object.keys(byResult).sort()).toEqual(['blocked', 'failure', 'partial', 'success'].sort());
    expect(byResult.success).toBe(2);
    expect(byResult.failure).toBe(1);
    expect(byResult.partial).toBe(0);
    expect(byResult.blocked).toBe(0);

    // recent.*
    expect(payload.recent.last_n_days).toBe(30);
    expect(payload.recent.invocations).toBe(3);

    // samples.top_durations sorted DESC
    expect(typeof payload.samples).toBe('object');
    const samples = payload.samples as Record<string, unknown>;
    const top = samples.top_durations as Record<string, unknown>[];
    expect(top.length).toBe(3);
    expect(top[0].duration_ms).toBe(200);
    expect(top[1].duration_ms).toBe(100);
    expect(top[2].duration_ms).toBe(50);
  });

  it('omits samples when summary_only=true', () => {
    seed(db);
    seed(db);
    const result = handleMetricsDashboard({ summary_only: true });
    const payload = parseJsonResult(result);
    expect(payload.samples).toBeUndefined();
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total_invocations).toBe(2);
  });

  it('narrows totals + recent + samples when project filter is set', () => {
    seed(db, { project: 'project-a', agent: 'forger' });
    seed(db, { project: 'project-a', agent: 'forger' });
    seed(db, { project: 'project-b', agent: 'forger' });

    const result = handleMetricsDashboard({ project: 'project-a' });
    const payload = parseJsonResult(result);

    expect(payload.project).toBe('project-a');
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total_invocations).toBe(2);
    const samples = payload.samples as Record<string, unknown>;
    const top = samples.top_durations as { project: string }[];
    expect(top.every((t) => t.project === 'project-a')).toBe(true);
  });

  it('narrows totals + recent + samples when agent filter is set', () => {
    seed(db, { agent: 'forger' });
    seed(db, { agent: 'forger' });
    seed(db, { agent: 'sentinel' });

    const result = handleMetricsDashboard({ agent: 'forger' });
    const payload = parseJsonResult(result);

    expect(payload.agent).toBe('forger');
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total_invocations).toBe(2);
    const byAgent = totals.by_agent as Record<string, unknown>;
    expect(Object.keys(byAgent)).toEqual(['forger']);
  });

  it('combines project + agent filters (both ANDed)', () => {
    seed(db, { project: 'project-a', agent: 'forger' });
    seed(db, { project: 'project-a', agent: 'sentinel' });
    seed(db, { project: 'project-b', agent: 'forger' });

    const result = handleMetricsDashboard({ project: 'project-a', agent: 'forger' });
    const payload = parseJsonResult(result);

    expect(payload.project).toBe('project-a');
    expect(payload.agent).toBe('forger');
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total_invocations).toBe(1);
  });

  it('echoes the days filter and narrows recent.invocations accordingly', () => {
    // Two recent + one old (60 days ago); days=30 -> recent should be 2.
    seed(db);
    seed(db);
    seed(db, { recorded_at: isoDaysAgo(60) });

    const result = handleMetricsDashboard({ days: 30 });
    const payload = parseJsonResult(result);
    const recent = payload.recent as Record<string, unknown>;
    const totals = payload.totals as Record<string, unknown>;

    expect(recent.last_n_days).toBe(30);
    expect(recent.invocations).toBe(2);
    // total_invocations counts ALL rows (no time bound)
    expect(totals.total_invocations).toBe(3);
  });

  it('returns null week_over_week_delta_pct when prior week has no invocations', () => {
    // Only current-week activity; prior-week window (8-14 days ago) is empty.
    seed(db);
    seed(db);
    const result = handleMetricsDashboard({});
    const payload = parseJsonResult(result);
    const recent = payload.recent as Record<string, unknown>;
    expect(recent.week_over_week_delta_pct).toBeNull();
  });

  it('computes week_over_week_delta_pct when prior week has activity', () => {
    // 4 in current week, 2 in prior week -> +100%
    seed(db);
    seed(db);
    seed(db);
    seed(db);
    seed(db, { recorded_at: isoDaysAgo(10) });
    seed(db, { recorded_at: isoDaysAgo(11) });

    const result = handleMetricsDashboard({});
    const payload = parseJsonResult(result);
    const recent = payload.recent as Record<string, unknown>;
    expect(recent.week_over_week_delta_pct).toBe(100);
  });

  it('returns zero counts on an empty DB without throwing', () => {
    const result = handleMetricsDashboard({});
    const payload = parseJsonResult(result) as Record<string, Record<string, unknown>>;
    expect(payload.totals.total_invocations).toBe(0);
    expect(payload.totals.by_agent).toEqual({});
    expect(payload.totals.by_action).toEqual({});
    const byResult = payload.totals.by_result as Record<string, number>;
    expect(byResult.success).toBe(0);
    expect(byResult.failure).toBe(0);
    expect(byResult.partial).toBe(0);
    expect(byResult.blocked).toBe(0);
    expect((payload.recent as Record<string, unknown>).invocations).toBe(0);
    const samples = payload.samples as Record<string, unknown>;
    expect((samples.top_durations as unknown[]).length).toBe(0);
  });

  it('rejects negative days', () => {
    const result = handleMetricsDashboard({ days: -5 });
    expect(result.content[0].text).toContain('days must be a non-negative number');
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128) — gateway-level
  // -------------------------------------------------------------------------

  it('rejects unknown args via the gateway strict-input contract (TD-128)', async () => {
    const gateway = createGateway();
    const component = createMetricsComponent();
    gateway.register(component.tools());

    await expect(
      gateway.dispatch('igris_metrics_dashboard', { bogus_extra: 'should-throw' }),
    ).rejects.toThrowError(
      /igris_metrics_dashboard: unknown argument 'bogus_extra'\. Accepted keys: .*\. \(strict-input contract; TD-128\)/,
    );
  });

  it('dispatches cleanly via the gateway with no args (defaults applied)', async () => {
    const gateway = createGateway();
    const component = createMetricsComponent();
    gateway.register(component.tools());

    seed(db);
    const result = await gateway.dispatch('igris_metrics_dashboard', {});
    const payload = parseJsonResult(result as { content: { text: string }[] });
    const recent = payload.recent as Record<string, unknown>;
    expect(recent.last_n_days).toBe(30);
  });
});
