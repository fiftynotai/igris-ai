/**
 * TD-171 M4 — igris_goal_dashboard handler tests.
 *
 * Coverage:
 *   - happy path: returns the canonical _dashboard shape (totals.total,
 *     totals.by_status with all 4 statuses zero-defaulted, recent.upcoming_deadlines,
 *     samples.stalled_goals)
 *   - summary_only=true omits the samples block
 *   - project filter narrows totals + recent + samples
 *   - upcoming_deadlines respects the 30-day forward window and active-only filter
 *   - stalled_goals respects the 30-day "no update" rule and active-only filter
 *   - serving-brief counts are correct (mirrors handleGoalProgress math)
 *   - rejects unknown args via gateway strict-input contract (TD-128)
 *
 * @module engine/components/goals/__tests__/dashboard.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import { handleGoalDashboard } from '../handlers.js';
import { goalMigrations } from '../schema.js';
import { edgeMigrations } from '../../edges/schema.js';
import { createGateway } from '../../../gateway.js';
import { createGoalsComponent } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  for (const m of goalMigrations) db.exec(m.sql);
  for (const m of edgeMigrations) db.exec(m.sql);
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'P2-Medium',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
  `);
  return db;
}

interface GoalSeed {
  goal_id: string;
  project_slug?: string | null;
  title?: string;
  outcome?: string;
  deadline?: string | null;
  status?: string;
  /** ISO timestamp; pass an old date to push a row outside the recent window. */
  updated_at?: string;
}

function seedGoal(db: Database.Database, spec: GoalSeed): void {
  const cols: string[] = ['goal_id', 'project_slug', 'title', 'outcome', 'status'];
  const vals: (string | null)[] = [
    spec.goal_id,
    spec.project_slug === undefined ? 'p' : spec.project_slug,
    spec.title ?? `${spec.goal_id} title`,
    spec.outcome ?? 'shipped',
    spec.status ?? 'active',
  ];
  if (spec.deadline !== undefined) {
    cols.push('deadline');
    vals.push(spec.deadline);
  }
  if (spec.updated_at !== undefined) {
    cols.push('updated_at');
    vals.push(spec.updated_at);
  }
  const placeholders = vals.map(() => '?').join(', ');
  db.prepare(
    `INSERT INTO goals (${cols.join(', ')}) VALUES (${placeholders})`,
  ).run(...vals);
}

function seedBrief(db: Database.Database, briefId: string, status: string): void {
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status)
     VALUES ('p', ?, ?, ?)`,
  ).run(briefId, `${briefId} title`, status);
}

function linkServesGoal(
  db: Database.Database,
  fromType: string,
  fromId: string,
  goalId: string,
  metadata: Record<string, unknown> = {},
): void {
  db.prepare(
    `INSERT INTO entity_edges
       (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
     VALUES (?, ?, 'goal', ?, 'serves_goal', 1.0, 'observed', ?)`,
  ).run(fromType, fromId, goalId, JSON.stringify(metadata));
}

function parseJsonResult(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

/** ISO timestamp `daysAgo` days in the past (SQLite-compatible format). */
function isoDaysAgo(daysAgo: number): string {
  const t = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().replace('T', ' ').slice(0, 19);
}

/** ISO date string `daysAhead` days in the future. */
function isoDateDaysAhead(daysAhead: number): string {
  const t = Date.now() + daysAhead * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleGoalDashboard (TD-171 M4)', () => {
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

  it('returns the canonical _dashboard shape with all by_status keys zero-defaulted', () => {
    seedGoal(db, { goal_id: 'GL-001', status: 'active' });
    seedGoal(db, { goal_id: 'GL-002', status: 'achieved' });
    seedGoal(db, { goal_id: 'GL-003', status: 'active' });

    const result = handleGoalDashboard({});
    const payload = parseJsonResult(result) as Record<string, Record<string, unknown>>;

    // Top-level keys
    expect(Object.keys(payload).sort()).toEqual(['recent', 'samples', 'totals'].sort());

    // totals.*
    expect(payload.totals.total).toBe(3);
    const byStatus = payload.totals.by_status as Record<string, number>;
    // Every VALID_GOAL_STATUSES key must be present (zero-defaulted) — canonical shape.
    expect(Object.keys(byStatus).sort()).toEqual(
      ['abandoned', 'achieved', 'active', 'deferred'].sort(),
    );
    expect(byStatus.active).toBe(2);
    expect(byStatus.achieved).toBe(1);
    expect(byStatus.abandoned).toBe(0);
    expect(byStatus.deferred).toBe(0);

    // recent.upcoming_deadlines is an array (empty here — no deadlines seeded)
    expect(Array.isArray(payload.recent.upcoming_deadlines)).toBe(true);
    expect((payload.recent.upcoming_deadlines as unknown[]).length).toBe(0);

    // samples present and an object with stalled_goals array
    expect(typeof payload.samples).toBe('object');
    const samples = payload.samples as Record<string, unknown>;
    expect(Array.isArray(samples.stalled_goals)).toBe(true);
  });

  it('omits samples when summary_only=true', () => {
    seedGoal(db, { goal_id: 'GL-001' });
    const result = handleGoalDashboard({ summary_only: true });
    const payload = parseJsonResult(result);
    expect(payload.samples).toBeUndefined();
    // Counts + upcoming_deadlines still computed
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total).toBe(1);
    expect(payload.recent).toBeDefined();
  });

  it('narrows totals + recent + samples when project filter is set', () => {
    seedGoal(db, { goal_id: 'GL-001', project_slug: 'project-a', status: 'active', updated_at: isoDaysAgo(40) });
    seedGoal(db, { goal_id: 'GL-002', project_slug: 'project-a', status: 'active' });
    seedGoal(db, { goal_id: 'GL-003', project_slug: 'project-b', status: 'active', updated_at: isoDaysAgo(40) });

    const result = handleGoalDashboard({ project: 'project-a' });
    const payload = parseJsonResult(result);

    expect(payload.project).toBe('project-a');
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total).toBe(2);
    const samples = payload.samples as Record<string, unknown>;
    const stalled = samples.stalled_goals as { goal_id: string; project_slug: string | null }[];
    expect(stalled.length).toBe(1);
    expect(stalled[0].goal_id).toBe('GL-001');
    expect(stalled[0].project_slug).toBe('project-a');
  });

  it('upcoming_deadlines includes only active goals with deadlines in next 30 days', () => {
    seedGoal(db, { goal_id: 'GL-001', status: 'active', deadline: isoDateDaysAhead(7) });   // include
    seedGoal(db, { goal_id: 'GL-002', status: 'active', deadline: isoDateDaysAhead(14) });  // include
    seedGoal(db, { goal_id: 'GL-003', status: 'active', deadline: isoDateDaysAhead(45) });  // exclude (>30d)
    seedGoal(db, { goal_id: 'GL-004', status: 'achieved', deadline: isoDateDaysAhead(7) }); // exclude (achieved)
    seedGoal(db, { goal_id: 'GL-005', status: 'active', deadline: null });                  // exclude (no deadline)

    const result = handleGoalDashboard({});
    const payload = parseJsonResult(result);
    const recent = payload.recent as Record<string, unknown>;
    const upcoming = recent.upcoming_deadlines as {
      goal_id: string;
      days_remaining: number;
      serving_brief_count: number;
      completed_brief_count: number;
    }[];

    expect(upcoming.length).toBe(2);
    const ids = upcoming.map((u) => u.goal_id).sort();
    expect(ids).toEqual(['GL-001', 'GL-002']);
    // Sort: ASC by deadline -> GL-001 (sooner) first
    expect(upcoming[0].goal_id).toBe('GL-001');
    // days_remaining is an integer >= 0
    for (const u of upcoming) {
      expect(Number.isInteger(u.days_remaining)).toBe(true);
      expect(u.days_remaining).toBeGreaterThanOrEqual(0);
      expect(u.serving_brief_count).toBe(0);
      expect(u.completed_brief_count).toBe(0);
    }
  });

  it('stalled_goals includes only active goals with updated_at >= 30 days ago', () => {
    seedGoal(db, { goal_id: 'GL-001', status: 'active', updated_at: isoDaysAgo(45) });  // include
    seedGoal(db, { goal_id: 'GL-002', status: 'active', updated_at: isoDaysAgo(60) });  // include
    seedGoal(db, { goal_id: 'GL-003', status: 'active' });                                // exclude (fresh)
    seedGoal(db, { goal_id: 'GL-004', status: 'achieved', updated_at: isoDaysAgo(45) }); // exclude (not active)
    seedGoal(db, { goal_id: 'GL-005', status: 'abandoned', updated_at: isoDaysAgo(45) });// exclude (not active)

    const result = handleGoalDashboard({});
    const payload = parseJsonResult(result);
    const samples = payload.samples as Record<string, unknown>;
    const stalled = samples.stalled_goals as {
      goal_id: string;
      days_since_update: number;
    }[];

    expect(stalled.length).toBe(2);
    // Sort: ASC by updated_at -> oldest (GL-002) first
    expect(stalled[0].goal_id).toBe('GL-002');
    expect(stalled[1].goal_id).toBe('GL-001');
    for (const s of stalled) {
      expect(s.days_since_update).toBeGreaterThanOrEqual(30);
    }
  });

  it('counts serving_brief_count and completed_brief_count correctly via entity_edges', () => {
    seedGoal(db, { goal_id: 'GL-001', status: 'active', deadline: isoDateDaysAhead(10) });
    seedBrief(db, 'BR-001', 'Done');
    seedBrief(db, 'BR-002', 'Archived');
    seedBrief(db, 'BR-003', 'In Progress');
    seedBrief(db, 'BR-004', 'Ready');
    seedBrief(db, 'BR-005', 'Done');
    linkServesGoal(db, 'brief', 'BR-001', 'GL-001');
    linkServesGoal(db, 'brief', 'BR-002', 'GL-001');
    linkServesGoal(db, 'brief', 'BR-003', 'GL-001');
    linkServesGoal(db, 'brief', 'BR-004', 'GL-001');
    // Soft-deleted edge on a distinct brief (the UNIQUE constraint on
    // entity_edges covers from_type+from_id+to_type+to_id+edge_type, so
    // we cannot duplicate (BR-001, GL-001, serves_goal) — use BR-005
    // which has Done status but is excluded by the deleted=1 metadata).
    linkServesGoal(db, 'brief', 'BR-005', 'GL-001', { deleted: 1 });

    const result = handleGoalDashboard({});
    const payload = parseJsonResult(result);
    const recent = payload.recent as Record<string, unknown>;
    const upcoming = recent.upcoming_deadlines as {
      goal_id: string;
      serving_brief_count: number;
      completed_brief_count: number;
    }[];

    expect(upcoming.length).toBe(1);
    expect(upcoming[0].goal_id).toBe('GL-001');
    // 4 distinct serving edges (soft-deleted excluded)
    expect(upcoming[0].serving_brief_count).toBe(4);
    // 2 in terminal states (Done + Archived)
    expect(upcoming[0].completed_brief_count).toBe(2);
  });

  it('returns zero counts on an empty DB without throwing', () => {
    const result = handleGoalDashboard({});
    const payload = parseJsonResult(result) as Record<string, Record<string, unknown>>;
    expect(payload.totals.total).toBe(0);
    const byStatus = payload.totals.by_status as Record<string, number>;
    expect(byStatus.active).toBe(0);
    expect(byStatus.achieved).toBe(0);
    expect((payload.recent.upcoming_deadlines as unknown[]).length).toBe(0);
    const samples = payload.samples as Record<string, unknown>;
    expect((samples.stalled_goals as unknown[]).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128) — gateway-level
  // -------------------------------------------------------------------------

  it('rejects unknown args via the gateway strict-input contract (TD-128)', async () => {
    const gateway = createGateway();
    const component = createGoalsComponent();
    gateway.register(component.tools());

    await expect(
      gateway.dispatch('igris_goal_dashboard', { bogus_extra: 'should-throw' }),
    ).rejects.toThrowError(
      /igris_goal_dashboard: unknown argument 'bogus_extra'\. Accepted keys: .*\. \(strict-input contract; TD-128\)/,
    );
  });

  it('dispatches cleanly via the gateway with no args (defaults applied)', async () => {
    const gateway = createGateway();
    const component = createGoalsComponent();
    gateway.register(component.tools());

    seedGoal(db, { goal_id: 'GL-001' });
    const result = await gateway.dispatch('igris_goal_dashboard', {});
    const payload = parseJsonResult(result as { content: { text: string }[] });
    const totals = payload.totals as Record<string, unknown>;
    expect(totals.total).toBe(1);
  });
});
