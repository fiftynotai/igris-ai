/**
 * Tests for the retroactive sweep script (scripts/sweep-stale-brief-tasks.ts).
 *
 * Covers:
 *   - findStale identifies tasks whose linked brief is Done/Archived but whose
 *     own status is non-terminal, scoped to task_type='brief'.
 *   - findStale respects the optional project filter.
 *   - findStale ignores control rows (task already done, brief not terminal,
 *     non-brief task_type).
 *   - sweepStale in dry-run mode does not mutate state.
 *   - sweepStale (real mode) transitions each stale task to 'done'.
 *   - sweepStale is idempotent: running twice in a row is a no-op.
 *
 * Note: The sweep script calls `handleTaskComplete` directly (not the wrapper
 * in `tasks/index.ts`), so event emission is out of scope for these tests.
 * The end-state DB assertion is the load-bearing check.
 *
 * @module engine/components/tasks/__tests__/sweep-stale-brief-tasks.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

// Mock the db module so handleTaskComplete (used inside sweepStale) resolves
// getDb() to our in-memory DB.
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../../../db.js';
import { findStale, sweepStale } from '../../../../../scripts/sweep-stale-brief-tasks.js';
import { taskMigrations } from '../schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an in-memory SQLite database with task migrations AND the
 * brief_status table applied. The sweep query joins tasks -> brief_status,
 * so both must exist.
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Apply task migrations (creates tasks, task_deps, task_assignments, etc.).
  // The migration SQL flips foreign_keys to ON at the end of v2/v4, so we
  // disable them after migrations complete — we don't seed a projects table.
  for (const migration of taskMigrations) {
    db.exec(migration.sql);
  }
  db.pragma('foreign_keys = OFF');

  // Create brief_status table (defined in db.ts at schema version 2)
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_type TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      effort TEXT,
      phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_status_unique ON brief_status(project, brief_id);
  `);

  return db;
}

/** Insert a brief_status row. */
function insertBrief(
  db: Database.Database,
  project: string,
  briefId: string,
  status: string,
  title: string = `Brief ${briefId}`,
): void {
  db.prepare(`
    INSERT INTO brief_status (project, brief_id, title, status)
    VALUES (?, ?, ?, ?)
  `).run(project, briefId, title, status);
}

/** Insert a task row. */
function insertTask(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    task_type: string;
    scope: string;
    title: string;
    brief_id: string | null;
    project_slug: string | null;
    status: string;
    priority: number;
  }> = {},
): void {
  const defaults = {
    id: 't-' + Math.random().toString(36).slice(2, 10),
    task_type: 'brief',
    scope: 'project',
    title: 'Test task',
    brief_id: null as string | null,
    project_slug: 'igris-ai',
    status: 'pending',
    priority: 3,
  };
  const row = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO tasks (id, task_type, scope, title, brief_id, project_slug, status, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.task_type, row.scope, row.title, row.brief_id, row.project_slug, row.status, row.priority);
}

/** Read the status of a task directly. */
function getTaskStatus(db: Database.Database, taskId: string): string | undefined {
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
  return row?.status;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sweep-stale-brief-tasks', () => {
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
  // findStale
  // -------------------------------------------------------------------------

  describe('findStale', () => {
    it('returns tasks whose brief is Done but task is not done/cancelled', () => {
      insertBrief(db, 'proj-a', 'BR-001', 'Done');
      insertTask(db, { id: 't-stale01', brief_id: 'BR-001', project_slug: 'proj-a', status: 'pending' });

      const stale = findStale(db);

      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatchObject({
        task_id: 't-stale01',
        brief_id: 'BR-001',
        project_slug: 'proj-a',
        brief_status: 'Done',
        task_status: 'pending',
      });
    });

    it('returns tasks whose brief is Archived but task is blocked', () => {
      insertBrief(db, 'proj-a', 'BR-002', 'Archived');
      insertTask(db, { id: 't-stale02', brief_id: 'BR-002', project_slug: 'proj-a', status: 'blocked' });

      const stale = findStale(db);

      expect(stale).toHaveLength(1);
      expect(stale[0].task_id).toBe('t-stale02');
      expect(stale[0].brief_status).toBe('Archived');
    });

    it('ignores tasks whose brief is not in a terminal state', () => {
      insertBrief(db, 'proj-a', 'BR-003', 'In Progress');
      insertTask(db, { id: 't-healthy01', brief_id: 'BR-003', project_slug: 'proj-a', status: 'pending' });

      const stale = findStale(db);

      expect(stale).toHaveLength(0);
    });

    it('ignores tasks that are already done or cancelled (the control case)', () => {
      insertBrief(db, 'proj-a', 'BR-004', 'Done');
      insertTask(db, { id: 't-done01', brief_id: 'BR-004', project_slug: 'proj-a', status: 'done' });
      insertBrief(db, 'proj-a', 'BR-005', 'Archived');
      insertTask(db, { id: 't-cancelled01', brief_id: 'BR-005', project_slug: 'proj-a', status: 'cancelled' });

      const stale = findStale(db);

      expect(stale).toHaveLength(0);
    });

    it('ignores non-brief task_types even if they reference a Done brief', () => {
      insertBrief(db, 'proj-a', 'BR-006', 'Done');
      insertTask(db, {
        id: 't-operational01',
        task_type: 'operational',
        brief_id: 'BR-006',
        project_slug: 'proj-a',
        status: 'pending',
      });

      const stale = findStale(db);

      expect(stale).toHaveLength(0);
    });

    it('respects the projectFilter argument', () => {
      insertBrief(db, 'proj-a', 'BR-100', 'Done');
      insertBrief(db, 'proj-b', 'BR-101', 'Done');
      insertTask(db, { id: 't-pa01', brief_id: 'BR-100', project_slug: 'proj-a', status: 'pending' });
      insertTask(db, { id: 't-pb01', brief_id: 'BR-101', project_slug: 'proj-b', status: 'pending' });

      const staleAll = findStale(db);
      expect(staleAll).toHaveLength(2);

      const staleA = findStale(db, 'proj-a');
      expect(staleA).toHaveLength(1);
      expect(staleA[0].project_slug).toBe('proj-a');

      const staleB = findStale(db, 'proj-b');
      expect(staleB).toHaveLength(1);
      expect(staleB[0].project_slug).toBe('proj-b');
    });

    it('returns results ordered by project_slug then brief_id', () => {
      insertBrief(db, 'proj-b', 'BR-300', 'Done');
      insertBrief(db, 'proj-a', 'BR-200', 'Done');
      insertBrief(db, 'proj-a', 'BR-100', 'Archived');
      insertTask(db, { id: 't-ord-b1', brief_id: 'BR-300', project_slug: 'proj-b', status: 'pending' });
      insertTask(db, { id: 't-ord-a2', brief_id: 'BR-200', project_slug: 'proj-a', status: 'pending' });
      insertTask(db, { id: 't-ord-a1', brief_id: 'BR-100', project_slug: 'proj-a', status: 'pending' });

      const stale = findStale(db);

      expect(stale.map((r) => r.task_id)).toEqual(['t-ord-a1', 't-ord-a2', 't-ord-b1']);
    });
  });

  // -------------------------------------------------------------------------
  // sweepStale
  // -------------------------------------------------------------------------

  describe('sweepStale', () => {
    /**
     * Seed the 4-scenario set used by multiple tests:
     *   - 2 briefs Done with pending tasks (stale)
     *   - 1 brief Archived with blocked task (stale)
     *   - 1 brief Done with already-done task (control, must not be touched)
     */
    function seedScenarios(): { staleIds: string[]; controlId: string } {
      insertBrief(db, 'proj-a', 'BR-D1', 'Done');
      insertTask(db, { id: 't-stale-d1', brief_id: 'BR-D1', project_slug: 'proj-a', status: 'pending' });

      insertBrief(db, 'proj-a', 'BR-D2', 'Done');
      insertTask(db, { id: 't-stale-d2', brief_id: 'BR-D2', project_slug: 'proj-a', status: 'pending' });

      insertBrief(db, 'proj-b', 'BR-A1', 'Archived');
      insertTask(db, { id: 't-stale-a1', brief_id: 'BR-A1', project_slug: 'proj-b', status: 'blocked' });

      insertBrief(db, 'proj-a', 'BR-DONE', 'Done');
      insertTask(db, { id: 't-control01', brief_id: 'BR-DONE', project_slug: 'proj-a', status: 'done' });

      return {
        staleIds: ['t-stale-d1', 't-stale-d2', 't-stale-a1'],
        controlId: 't-control01',
      };
    }

    it('dry-run mode does not mutate any task state', () => {
      const { staleIds, controlId } = seedScenarios();
      const logs: string[] = [];

      const result = sweepStale(db, true, undefined, (msg) => logs.push(msg));

      expect(result.found).toBe(3);
      expect(result.completed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(logs.some((l) => l.includes('[DRY]'))).toBe(true);

      // DB unchanged
      expect(getTaskStatus(db, staleIds[0])).toBe('pending');
      expect(getTaskStatus(db, staleIds[1])).toBe('pending');
      expect(getTaskStatus(db, staleIds[2])).toBe('blocked');
      expect(getTaskStatus(db, controlId)).toBe('done');
    });

    it('transitions all stale tasks to done and leaves control untouched', () => {
      const { staleIds, controlId } = seedScenarios();

      const result = sweepStale(db, false, undefined, () => {});

      expect(result.found).toBe(3);
      expect(result.completed).toBe(3);
      expect(result.skipped).toBe(0);

      for (const id of staleIds) {
        expect(getTaskStatus(db, id)).toBe('done');
      }
      expect(getTaskStatus(db, controlId)).toBe('done');
    });

    it('running sweepStale twice is idempotent (second run finds zero)', () => {
      seedScenarios();

      const first = sweepStale(db, false, undefined, () => {});
      expect(first.completed).toBe(3);

      const second = sweepStale(db, false, undefined, () => {});
      expect(second.found).toBe(0);
      expect(second.completed).toBe(0);
      expect(second.skipped).toBe(0);
    });

    it('projectFilter limits the sweep to one project', () => {
      const { staleIds } = seedScenarios();

      const result = sweepStale(db, false, 'proj-a', () => {});

      expect(result.found).toBe(2);
      expect(result.completed).toBe(2);
      // proj-a tasks should now be done
      expect(getTaskStatus(db, 't-stale-d1')).toBe('done');
      expect(getTaskStatus(db, 't-stale-d2')).toBe('done');
      // proj-b task remains stale
      expect(getTaskStatus(db, 't-stale-a1')).toBe('blocked');
      // Control unchanged
      expect(staleIds.length).toBe(3);
    });

    it('reports zero found when there are no stale rows', () => {
      insertBrief(db, 'proj-a', 'BR-X', 'In Progress');
      insertTask(db, { id: 't-x', brief_id: 'BR-X', project_slug: 'proj-a', status: 'pending' });

      const result = sweepStale(db, false, undefined, () => {});

      expect(result.found).toBe(0);
      expect(result.completed).toBe(0);
    });

    it('records per-task completion lines in the log callback', () => {
      insertBrief(db, 'proj-a', 'BR-LOG', 'Done');
      insertTask(db, { id: 't-log1', brief_id: 'BR-LOG', project_slug: 'proj-a', status: 'pending' });

      const logs: string[] = [];
      sweepStale(db, false, undefined, (msg) => logs.push(msg));

      expect(logs.some((l) => l.includes('OK t-log1'))).toBe(true);
      expect(logs.some((l) => l.includes('BR-LOG'))).toBe(true);
    });
  });
});
