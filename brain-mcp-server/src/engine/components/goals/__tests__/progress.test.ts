/**
 * Goals Component — progress integration tests
 *
 * Exercises handleGoalProgress against a realistic edge graph:
 * - mixed brief statuses (Done, Archived, In Progress, Ready, Draft)
 * - soft-deleted edges (metadata.deleted = 1)
 * - non-brief from_type rows (learning, error) which must be excluded
 *   from the brief-progress buckets but counted separately for
 *   serving_learnings_count.
 *
 * @module engine/components/goals/__tests__/progress.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import {
  handleGoalCreate,
  handleGoalProgress,
  type GoalProgress,
} from '../handlers.js';
import { goalMigrations } from '../schema.js';
import { edgeMigrations } from '../../edges/schema.js';

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

function parseResult<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('goal progress', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    handleGoalCreate({ project: 'p', title: 'A', outcome: 'shipped' });
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns total=0 and completion_pct=null on a goal with no serving edges', () => {
    const parsed = parseResult<GoalProgress>(handleGoalProgress({ goal_id: 'GL-001' }));
    expect(parsed.serving_briefs_total).toBe(0);
    expect(parsed.serving_briefs_done).toBe(0);
    expect(parsed.serving_briefs_in_progress).toBe(0);
    expect(parsed.serving_briefs_pending).toBe(0);
    expect(parsed.completion_pct).toBeNull();
    expect(parsed.serving_learnings_count).toBe(0);
  });

  it('counts Done and Archived as "done"', () => {
    seedBrief(db, 'BR-001', 'Done');
    seedBrief(db, 'BR-002', 'Archived');
    seedBrief(db, 'BR-003', 'Ready');
    linkServesGoal(db, 'brief', 'BR-001', 'GL-001');
    linkServesGoal(db, 'brief', 'BR-002', 'GL-001');
    linkServesGoal(db, 'brief', 'BR-003', 'GL-001');

    const parsed = parseResult<GoalProgress>(handleGoalProgress({ goal_id: 'GL-001' }));
    expect(parsed.serving_briefs_total).toBe(3);
    expect(parsed.serving_briefs_done).toBe(2);
    expect(parsed.serving_briefs_pending).toBe(1);
    // 2/3 = 0.667
    expect(parsed.completion_pct).toBeCloseTo(0.667, 3);
  });

  it('counts In Progress separately from done and pending', () => {
    seedBrief(db, 'BR-001', 'In Progress');
    seedBrief(db, 'BR-002', 'Ready');
    seedBrief(db, 'BR-003', 'Done');
    linkServesGoal(db, 'brief', 'BR-001', 'GL-001');
    linkServesGoal(db, 'brief', 'BR-002', 'GL-001');
    linkServesGoal(db, 'brief', 'BR-003', 'GL-001');

    const parsed = parseResult<GoalProgress>(handleGoalProgress({ goal_id: 'GL-001' }));
    expect(parsed.serving_briefs_total).toBe(3);
    expect(parsed.serving_briefs_done).toBe(1);
    expect(parsed.serving_briefs_in_progress).toBe(1);
    expect(parsed.serving_briefs_pending).toBe(1);
  });

  it('returns 1.0 when all serving briefs are terminal', () => {
    seedBrief(db, 'BR-001', 'Done');
    seedBrief(db, 'BR-002', 'Done');
    seedBrief(db, 'BR-003', 'Archived');
    linkServesGoal(db, 'brief', 'BR-001', 'GL-001');
    linkServesGoal(db, 'brief', 'BR-002', 'GL-001');
    linkServesGoal(db, 'brief', 'BR-003', 'GL-001');

    const parsed = parseResult<GoalProgress>(handleGoalProgress({ goal_id: 'GL-001' }));
    expect(parsed.serving_briefs_total).toBe(3);
    expect(parsed.serving_briefs_done).toBe(3);
    expect(parsed.completion_pct).toBe(1);
  });

  it('returns 0 when serving briefs exist but none are terminal', () => {
    seedBrief(db, 'BR-001', 'Ready');
    seedBrief(db, 'BR-002', 'Draft');
    linkServesGoal(db, 'brief', 'BR-001', 'GL-001');
    linkServesGoal(db, 'brief', 'BR-002', 'GL-001');

    const parsed = parseResult<GoalProgress>(handleGoalProgress({ goal_id: 'GL-001' }));
    expect(parsed.serving_briefs_total).toBe(2);
    expect(parsed.serving_briefs_done).toBe(0);
    expect(parsed.completion_pct).toBe(0);
  });

  it('excludes soft-deleted edges from all buckets', () => {
    seedBrief(db, 'BR-001', 'Done');
    seedBrief(db, 'BR-002', 'Done');
    linkServesGoal(db, 'brief', 'BR-001', 'GL-001');
    linkServesGoal(db, 'brief', 'BR-002', 'GL-001', { deleted: 1 });

    const parsed = parseResult<GoalProgress>(handleGoalProgress({ goal_id: 'GL-001' }));
    expect(parsed.serving_briefs_total).toBe(1);
    expect(parsed.serving_briefs_done).toBe(1);
    expect(parsed.completion_pct).toBe(1);
  });

  it('counts serving learnings separately, not in completion_pct', () => {
    seedBrief(db, 'BR-001', 'Done');
    linkServesGoal(db, 'brief', 'BR-001', 'GL-001');
    // 3 learnings serving the same goal.
    linkServesGoal(db, 'learning', 'L-001', 'GL-001');
    linkServesGoal(db, 'learning', 'L-002', 'GL-001');
    linkServesGoal(db, 'learning', 'L-003', 'GL-001');

    const parsed = parseResult<GoalProgress>(handleGoalProgress({ goal_id: 'GL-001' }));
    expect(parsed.serving_briefs_total).toBe(1);
    expect(parsed.serving_briefs_done).toBe(1);
    expect(parsed.completion_pct).toBe(1);
    expect(parsed.serving_learnings_count).toBe(3);
  });

  it('ignores non-brief, non-learning from_types', () => {
    // An edge from a session entity should NOT influence brief progress
    // and should NOT increment the learnings count.
    seedBrief(db, 'BR-001', 'Done');
    linkServesGoal(db, 'brief', 'BR-001', 'GL-001');
    linkServesGoal(db, 'session', 'S-001', 'GL-001');
    linkServesGoal(db, 'error', 'E-001', 'GL-001');

    const parsed = parseResult<GoalProgress>(handleGoalProgress({ goal_id: 'GL-001' }));
    expect(parsed.serving_briefs_total).toBe(1);
    expect(parsed.serving_learnings_count).toBe(0);
  });

  it('only counts serves_goal edges (not parent_of, depends_on, etc.)', () => {
    seedBrief(db, 'BR-001', 'Done');
    seedBrief(db, 'BR-002', 'Done');
    // BR-001 serves the goal — counts.
    linkServesGoal(db, 'brief', 'BR-001', 'GL-001');
    // BR-002 has a parent_of edge to GL-001, which is wrong semantically
    // but must not be counted as serving.
    db.prepare(
      `INSERT INTO entity_edges
         (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
       VALUES ('brief', 'BR-002', 'goal', 'GL-001', 'related_to', 1.0, 'observed', '{}')`,
    ).run();

    const parsed = parseResult<GoalProgress>(handleGoalProgress({ goal_id: 'GL-001' }));
    expect(parsed.serving_briefs_total).toBe(1);
    expect(parsed.serving_briefs_done).toBe(1);
  });

  it('only counts edges pointing to the requested goal', () => {
    handleGoalCreate({ project: 'p', title: 'B', outcome: 'shipped' }); // GL-002
    seedBrief(db, 'BR-001', 'Done');
    seedBrief(db, 'BR-002', 'Done');
    linkServesGoal(db, 'brief', 'BR-001', 'GL-001');
    linkServesGoal(db, 'brief', 'BR-002', 'GL-002');

    const gl001 = parseResult<GoalProgress>(handleGoalProgress({ goal_id: 'GL-001' }));
    const gl002 = parseResult<GoalProgress>(handleGoalProgress({ goal_id: 'GL-002' }));
    expect(gl001.serving_briefs_total).toBe(1);
    expect(gl002.serving_briefs_total).toBe(1);
  });
});
