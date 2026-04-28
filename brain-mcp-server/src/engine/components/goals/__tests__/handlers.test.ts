/**
 * Goals Component — handler unit tests
 *
 * Verifies the five core handlers (create, list, get, update, progress)
 * and the schema migration's idempotency. Uses an in-memory SQLite DB
 * with the goals + edges + brief_status migrations applied so the
 * cross-table queries in goal_get/goal_progress have realistic targets.
 *
 * @module engine/components/goals/__tests__/handlers.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// Mock db module so handlers resolve getDb() to our in-memory DB.
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import {
  handleGoalCreate,
  handleGoalList,
  handleGoalGet,
  handleGoalUpdate,
  handleGoalProgress,
  VALID_GOAL_STATUSES,
  type GoalRow,
} from '../handlers.js';
import { goalMigrations } from '../schema.js';
import { edgeMigrations } from '../../edges/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh in-memory DB with goals, edges, and a minimal brief_status
 * table. The brief_status DDL here mirrors the columns the goal handlers
 * reference (brief_id, title, status, priority); we don't need every
 * column from the production schema.
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  // goals + edges
  for (const m of goalMigrations) db.exec(m.sql);
  for (const m of edgeMigrations) db.exec(m.sql);
  // minimal brief_status mock — only columns the goal handlers query.
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

interface CreateResult {
  created: boolean;
  goal: GoalRow;
}

interface ListResult {
  goals: (GoalRow & { serving_briefs_count: number })[];
  count: number;
  total: number;
  limit: number;
  offset: number;
}

interface GetResult {
  goal: GoalRow;
  serving_briefs: { brief_id: string; title: string; status: string; priority: string }[];
  serving_learnings_count: number;
}

interface UpdateResult {
  updated: boolean;
  achieved_now: boolean;
  goal: GoalRow;
}

function parseResult<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

/** Convenience: insert a brief into the mock brief_status table. */
function seedBrief(
  db: Database.Database,
  briefId: string,
  status: string,
  title = `${briefId} title`,
  project = 'igris-ai',
): void {
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status, priority)
     VALUES (?, ?, ?, ?, 'P2-Medium')`,
  ).run(project, briefId, title, status);
}

/** Convenience: link a brief to a goal via a serves_goal edge. */
function linkBriefToGoal(
  db: Database.Database,
  briefId: string,
  goalId: string,
  metadata: Record<string, unknown> = {},
): void {
  db.prepare(
    `INSERT INTO entity_edges
       (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
     VALUES ('brief', ?, 'goal', ?, 'serves_goal', 1.0, 'observed', ?)`,
  ).run(briefId, goalId, JSON.stringify(metadata));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('goals handlers', () => {
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

  // -------------------------------------------------------------------------
  // handleGoalCreate
  // -------------------------------------------------------------------------

  describe('handleGoalCreate', () => {
    it('creates a goal with required fields and allocates GL-001', () => {
      const result = handleGoalCreate({
        project: 'igris-ai',
        title: 'Ship v6.1',
        outcome: 'shipped',
      });

      expect(result.isError).toBeUndefined();
      const parsed = parseResult<CreateResult>(result);
      expect(parsed.created).toBe(true);
      expect(parsed.goal.goal_id).toBe('GL-001');
      expect(parsed.goal.title).toBe('Ship v6.1');
      expect(parsed.goal.outcome).toBe('shipped');
      expect(parsed.goal.status).toBe('active');
      expect(parsed.goal.priority).toBe('P2-Medium');
      expect(parsed.goal.project_slug).toBe('igris-ai');
      expect(parsed.goal.achieved_at).toBeNull();
    });

    it('allocates sequential GL-XXX ids', () => {
      const a = parseResult<CreateResult>(
        handleGoalCreate({ project: 'p', title: 'A', outcome: 'shipped' }),
      );
      const b = parseResult<CreateResult>(
        handleGoalCreate({ project: 'p', title: 'B', outcome: 'shipped' }),
      );
      const c = parseResult<CreateResult>(
        handleGoalCreate({ project: 'p', title: 'C', outcome: 'shipped' }),
      );
      expect(a.goal.goal_id).toBe('GL-001');
      expect(b.goal.goal_id).toBe('GL-002');
      expect(c.goal.goal_id).toBe('GL-003');
    });

    it('continues numbering when goals already exist (max GL-005 -> GL-006)', () => {
      // Pre-seed GL-005 directly.
      db.prepare(
        `INSERT INTO goals (goal_id, project_slug, title, outcome, status)
         VALUES ('GL-005', 'p', 'pre-existing', 'shipped', 'active')`,
      ).run();

      const next = parseResult<CreateResult>(
        handleGoalCreate({ project: 'p', title: 'next', outcome: 'shipped' }),
      );
      expect(next.goal.goal_id).toBe('GL-006');
    });

    it('rejects missing required fields (title, outcome)', () => {
      const r1 = handleGoalCreate({ project: 'p', outcome: 'shipped' });
      const r2 = handleGoalCreate({ project: 'p', title: 'A' });
      expect(r1.isError).toBe(true);
      expect(r2.isError).toBe(true);
    });

    it('rejects title longer than 256 chars (defense-in-depth)', () => {
      const result = handleGoalCreate({
        project: 'p',
        title: 'x'.repeat(257),
        outcome: 'shipped',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('title exceeds maximum length');
    });

    it('accepts cross-project goals (project omitted -> NULL)', () => {
      const result = parseResult<CreateResult>(
        handleGoalCreate({ title: 'global', outcome: 'measured' }),
      );
      expect(result.goal.project_slug).toBeNull();
    });

    it('rejects malformed deadline', () => {
      const result = handleGoalCreate({
        project: 'p',
        title: 'T',
        outcome: 'shipped',
        deadline: 'not-a-date',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid deadline');
    });

    it('accepts ISO date deadline', () => {
      const result = parseResult<CreateResult>(
        handleGoalCreate({
          project: 'p',
          title: 'T',
          outcome: 'shipped',
          deadline: '2026-05-01',
        }),
      );
      expect(result.goal.deadline).toBe('2026-05-01');
    });

    it('rejects invalid status', () => {
      const result = handleGoalCreate({
        project: 'p',
        title: 'T',
        outcome: 'shipped',
        status: 'in-flight', // not in catalog
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid status');
    });

    it('respects all VALID_GOAL_STATUSES on create', () => {
      for (const status of VALID_GOAL_STATUSES) {
        const result = handleGoalCreate({
          project: 'p',
          title: `t-${status}`,
          outcome: 'shipped',
          status,
        });
        expect(result.isError, `status=${status}`).toBeUndefined();
      }
    });

    it('CHECK constraint rejects bad status on direct INSERT', () => {
      // Validates schema-level safety net.
      expect(() => {
        db.prepare(
          `INSERT INTO goals (goal_id, project_slug, title, outcome, status)
           VALUES ('GL-X', 'p', 't', 'shipped', 'bogus')`,
        ).run();
      }).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // handleGoalList
  // -------------------------------------------------------------------------

  describe('handleGoalList', () => {
    beforeEach(() => {
      // Seed 4 goals across 2 projects with mixed statuses + deadlines.
      handleGoalCreate({
        project: 'igris-ai', title: 'A', outcome: 'shipped',
        deadline: '2026-05-01', status: 'active',
      });
      handleGoalCreate({
        project: 'igris-ai', title: 'B', outcome: 'shipped',
        deadline: '2026-12-31', status: 'active',
      });
      handleGoalCreate({
        project: 'other', title: 'C', outcome: 'measured', status: 'active',
      });
      handleGoalCreate({
        project: 'igris-ai', title: 'D', outcome: 'shipped', status: 'achieved',
      });
    });

    it('returns all goals with no filter', () => {
      const parsed = parseResult<ListResult>(handleGoalList({}));
      expect(parsed.total).toBe(4);
      expect(parsed.goals).toHaveLength(4);
    });

    it('filters by project', () => {
      const parsed = parseResult<ListResult>(handleGoalList({ project: 'igris-ai' }));
      expect(parsed.total).toBe(3);
      for (const g of parsed.goals) expect(g.project_slug).toBe('igris-ai');
    });

    it('filters by status', () => {
      const parsed = parseResult<ListResult>(handleGoalList({ status: 'active' }));
      expect(parsed.total).toBe(3);
    });

    it('rejects invalid status filter', () => {
      const result = handleGoalList({ status: 'totally-fake' });
      expect(result.isError).toBe(true);
    });

    it('honors limit/offset pagination', () => {
      const page1 = parseResult<ListResult>(handleGoalList({ limit: 2, offset: 0 }));
      const page2 = parseResult<ListResult>(handleGoalList({ limit: 2, offset: 2 }));
      expect(page1.total).toBe(4);
      expect(page1.goals).toHaveLength(2);
      expect(page2.goals).toHaveLength(2);
    });

    it('sorts by deadline ASC NULLS LAST', () => {
      const parsed = parseResult<ListResult>(handleGoalList({ status: 'active' }));
      // Two with deadlines come before the one without.
      expect(parsed.goals[0].deadline).toBe('2026-05-01');
      expect(parsed.goals[1].deadline).toBe('2026-12-31');
      expect(parsed.goals[2].deadline).toBeNull();
    });

    it('upcoming_days filters to active goals within window', () => {
      // Goal with deadline 2026-05-01 is far in the future; goal with
      // 2026-12-31 is even further. With upcoming_days=99999, both
      // should appear; with =0, none.
      const wide = parseResult<ListResult>(handleGoalList({ upcoming_days: 99999 }));
      // Should include both deadlined active goals (excludes the
      // achieved one because that is filtered by the upcoming clause).
      expect(wide.goals.every((g) => g.deadline !== null && g.status === 'active')).toBe(true);
      expect(wide.total).toBeGreaterThanOrEqual(2);

      const tight = parseResult<ListResult>(handleGoalList({ upcoming_days: 0 }));
      // Today's date is well before 2026-05-01 — expect 0.
      expect(tight.total).toBe(0);
    });

    it('serving_briefs_count enriches each row', () => {
      // Link two briefs to GL-001.
      seedBrief(db, 'BR-001', 'Ready');
      seedBrief(db, 'BR-002', 'Done');
      linkBriefToGoal(db, 'BR-001', 'GL-001');
      linkBriefToGoal(db, 'BR-002', 'GL-001');

      const parsed = parseResult<ListResult>(handleGoalList({ project: 'igris-ai' }));
      const gl001 = parsed.goals.find((g) => g.goal_id === 'GL-001');
      expect(gl001?.serving_briefs_count).toBe(2);
      const gl002 = parsed.goals.find((g) => g.goal_id === 'GL-002');
      expect(gl002?.serving_briefs_count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // handleGoalGet
  // -------------------------------------------------------------------------

  describe('handleGoalGet', () => {
    beforeEach(() => {
      handleGoalCreate({ project: 'p', title: 'A', outcome: 'shipped' });
    });

    it('returns isError when goal_id does not exist', () => {
      const result = handleGoalGet({ goal_id: 'GL-999' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Goal not found');
    });

    it('returns the goal with empty serving lists by default', () => {
      const parsed = parseResult<GetResult>(handleGoalGet({ goal_id: 'GL-001' }));
      expect(parsed.goal.goal_id).toBe('GL-001');
      expect(parsed.serving_briefs).toHaveLength(0);
      expect(parsed.serving_learnings_count).toBe(0);
    });

    it('returns serving briefs joined via serves_goal edges', () => {
      seedBrief(db, 'BR-001', 'Ready', 'Brief One');
      seedBrief(db, 'BR-002', 'Done', 'Brief Two');
      linkBriefToGoal(db, 'BR-001', 'GL-001');
      linkBriefToGoal(db, 'BR-002', 'GL-001');

      const parsed = parseResult<GetResult>(handleGoalGet({ goal_id: 'GL-001' }));
      expect(parsed.serving_briefs).toHaveLength(2);
      expect(parsed.serving_briefs.map((b) => b.brief_id).sort()).toEqual(['BR-001', 'BR-002']);
    });

    it('counts serving learnings (count-only, not full rows)', () => {
      // Insert a learning edge directly — the learnings row itself
      // doesn't exist in this test DB, but the count query only
      // reads entity_edges so it still returns 1.
      db.prepare(
        `INSERT INTO entity_edges
           (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
         VALUES ('learning', 'L-001', 'goal', 'GL-001', 'serves_goal', 1.0, 'observed', '{}')`,
      ).run();

      const parsed = parseResult<GetResult>(handleGoalGet({ goal_id: 'GL-001' }));
      expect(parsed.serving_learnings_count).toBe(1);
    });

    it('excludes soft-deleted edges', () => {
      seedBrief(db, 'BR-001', 'Ready');
      linkBriefToGoal(db, 'BR-001', 'GL-001', { deleted: 1 });

      const parsed = parseResult<GetResult>(handleGoalGet({ goal_id: 'GL-001' }));
      expect(parsed.serving_briefs).toHaveLength(0);
    });

    it('rejects missing goal_id', () => {
      const result = handleGoalGet({});
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // handleGoalUpdate
  // -------------------------------------------------------------------------

  describe('handleGoalUpdate', () => {
    beforeEach(() => {
      handleGoalCreate({
        project: 'p', title: 'Original', outcome: 'shipped',
        deadline: '2026-05-01', status: 'active',
      });
    });

    it('rejects non-existent goal', () => {
      const result = handleGoalUpdate({ goal_id: 'GL-999', title: 'X' });
      expect(result.isError).toBe(true);
    });

    it('returns updated=false on no-op (no fields)', () => {
      const parsed = parseResult<UpdateResult>(handleGoalUpdate({ goal_id: 'GL-001' }));
      expect(parsed.updated).toBe(false);
      expect(parsed.achieved_now).toBe(false);
    });

    it('patches title without affecting other fields', () => {
      const parsed = parseResult<UpdateResult>(
        handleGoalUpdate({ goal_id: 'GL-001', title: 'New' }),
      );
      expect(parsed.updated).toBe(true);
      expect(parsed.goal.title).toBe('New');
      expect(parsed.goal.outcome).toBe('shipped');
      expect(parsed.goal.deadline).toBe('2026-05-01');
    });

    it('rejects empty title or outcome', () => {
      const r1 = handleGoalUpdate({ goal_id: 'GL-001', title: '' });
      const r2 = handleGoalUpdate({ goal_id: 'GL-001', outcome: '' });
      expect(r1.isError).toBe(true);
      expect(r2.isError).toBe(true);
    });

    it('rejects invalid deadline', () => {
      const result = handleGoalUpdate({ goal_id: 'GL-001', deadline: 'bogus' });
      expect(result.isError).toBe(true);
    });

    it('clears deadline when set to null', () => {
      const parsed = parseResult<UpdateResult>(
        handleGoalUpdate({ goal_id: 'GL-001', deadline: null }),
      );
      expect(parsed.goal.deadline).toBeNull();
    });

    it('rejects invalid status', () => {
      const result = handleGoalUpdate({ goal_id: 'GL-001', status: 'in-flight' });
      expect(result.isError).toBe(true);
    });

    it("auto-sets achieved_at on transition to 'achieved'", () => {
      const parsed = parseResult<UpdateResult>(
        handleGoalUpdate({ goal_id: 'GL-001', status: 'achieved' }),
      );
      expect(parsed.updated).toBe(true);
      expect(parsed.achieved_now).toBe(true);
      expect(parsed.goal.status).toBe('achieved');
      expect(parsed.goal.achieved_at).not.toBeNull();
    });

    it("clears achieved_at when reverting from 'achieved'", () => {
      // First, achieve.
      handleGoalUpdate({ goal_id: 'GL-001', status: 'achieved' });
      // Then revert.
      const parsed = parseResult<UpdateResult>(
        handleGoalUpdate({ goal_id: 'GL-001', status: 'active' }),
      );
      expect(parsed.goal.status).toBe('active');
      expect(parsed.goal.achieved_at).toBeNull();
      expect(parsed.achieved_now).toBe(false);
    });

    it('does not re-fire achieved_now when already achieved', () => {
      handleGoalUpdate({ goal_id: 'GL-001', status: 'achieved' });
      const parsed = parseResult<UpdateResult>(
        handleGoalUpdate({ goal_id: 'GL-001', status: 'achieved', priority: 'P0' }),
      );
      expect(parsed.achieved_now).toBe(false);
      expect(parsed.goal.priority).toBe('P0');
    });

    it('bumps updated_at on any patch', () => {
      const before = parseResult<GetResult>(handleGoalGet({ goal_id: 'GL-001' })).goal.updated_at;
      const parsed = parseResult<UpdateResult>(
        handleGoalUpdate({ goal_id: 'GL-001', priority: 'P1-High' }),
      );
      // updated_at is set via sqlNow() (1-second resolution) so it is
      // lexically >= the previous value, even if the second hasn't
      // advanced. The value must be a valid datetime string.
      expect(parsed.goal.updated_at >= before).toBe(true);
      expect(parsed.goal.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
  });

  // -------------------------------------------------------------------------
  // handleGoalProgress (basic — full edge cases in progress.test.ts)
  // -------------------------------------------------------------------------

  describe('handleGoalProgress (smoke)', () => {
    beforeEach(() => {
      handleGoalCreate({ project: 'p', title: 'A', outcome: 'shipped' });
    });

    it('returns isError on non-existent goal', () => {
      const result = handleGoalProgress({ goal_id: 'GL-999' });
      expect(result.isError).toBe(true);
    });

    it('returns zero buckets and null pct when no serving briefs', () => {
      const parsed = parseResult<{
        goal_id: string;
        serving_briefs_total: number;
        completion_pct: number | null;
      }>(handleGoalProgress({ goal_id: 'GL-001' }));
      expect(parsed.serving_briefs_total).toBe(0);
      expect(parsed.completion_pct).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Schema migration idempotency
  // -------------------------------------------------------------------------

  describe('schema migration idempotency', () => {
    it('re-running migrations is a no-op', () => {
      for (const m of goalMigrations) {
        expect(() => db.exec(m.sql)).not.toThrow();
      }

      // Verify the 3 indexes exist (project, status, partial deadline).
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'goals' AND name NOT LIKE 'sqlite_autoindex_%'",
        )
        .all() as { name: string }[];
      const names = indexes.map((i) => i.name).sort();
      expect(names).toEqual(['idx_goals_deadline', 'idx_goals_project', 'idx_goals_status']);
    });

    it('UNIQUE constraint enforces goal_id', () => {
      db.prepare(
        `INSERT INTO goals (goal_id, project_slug, title, outcome)
         VALUES ('GL-DUPE', 'p', 't', 'shipped')`,
      ).run();
      expect(() => {
        db.prepare(
          `INSERT INTO goals (goal_id, project_slug, title, outcome)
           VALUES ('GL-DUPE', 'p', 't', 'shipped')`,
        ).run();
      }).toThrow();
    });
  });
});
