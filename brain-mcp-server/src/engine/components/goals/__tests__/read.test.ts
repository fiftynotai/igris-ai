/**
 * FR-240 — `goals/read.ts` unit tests.
 *
 * Like the other two reader suites, this file mocks NOTHING: the reader takes a
 * handle, so a fixture DB is enough. `handlers.test.ts` (which mocks `getDb`)
 * remains the wrapper's suite.
 *
 * WHAT THESE GATES PROVE
 * ----------------------
 * That the filters bind, that the deadline-ASC-nulls-last ordering survived the
 * move, that `serving_briefs_count` counts the right edges, and that
 * soft-deleted edges are excluded on BOTH the count and the detail path.
 *
 * WHAT THEY DO NOT PROVE
 * ----------------------
 *  - That `handleGoalList` / `handleGoalGet` still emit the same bytes.
 *    **Sibling:** `../../../../tools/__tests__/wrapper-wire-parity.test.ts`.
 *  - That the validation messages are unchanged — validation deliberately did
 *    NOT move. **Sibling:** `handlers.test.ts`.
 *  - That the module is import-pure. **Sibling:**
 *    `../../../../tools/__tests__/pure-read-purity.test.ts`.
 *
 * @module engine/components/goals/__tests__/read.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { listGoals, getGoal } from '../read.js';
import { goalMigrations } from '../schema.js';
import { edgeMigrations } from '../../edges/schema.js';

let db: Database.Database;

/**
 * Fixture with disagreeing partitions:
 *
 *  goal   | project  | status   | deadline    | serving briefs
 *  GL-001 | igris-ai | active   | 2026-08-31  | FR-240 (live), TD-001 (soft-deleted edge)
 *  GL-002 | igris-ai | active   | NULL        | —
 *  GL-003 | other    | achieved | 2026-05-01  | —
 *  GL-004 | igris-ai | active   | 2026-06-30  | —
 */
function makeDb(): Database.Database {
  const d = new Database(':memory:');
  for (const m of goalMigrations) d.exec(m.sql);
  for (const m of edgeMigrations) d.exec(m.sql);
  d.exec(`
    CREATE TABLE IF NOT EXISTS brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL, brief_id TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'P2-Medium',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
  `);

  const insGoal = d.prepare(
    `INSERT INTO goals
       (goal_id, project_slug, title, description, outcome, deadline, status,
        priority, created_at, updated_at, achieved_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insGoal.run('GL-001', 'igris-ai', 'Ship the lens', null, 'Browsable brain', '2026-08-31', 'active', 'P1-High', '2026-06-01 10:00:00', '2026-06-01 10:00:00', null, '{}');
  insGoal.run('GL-002', 'igris-ai', 'Undated goal', null, 'Sorts last', null, 'active', 'P2-Medium', '2026-06-02 10:00:00', '2026-06-02 10:00:00', null, '{}');
  insGoal.run('GL-003', 'other', 'Achieved goal', null, 'Done', '2026-05-01', 'achieved', 'P3-Low', '2026-06-03 10:00:00', '2026-06-03 10:00:00', '2026-05-01 12:00:00', '{}');
  insGoal.run('GL-004', 'igris-ai', 'Nearer deadline', null, 'Sorts first', '2026-06-30', 'active', 'P2-Medium', '2026-06-04 10:00:00', '2026-06-04 10:00:00', null, '{}');

  const insBrief = d.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status, priority)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insBrief.run('igris-ai', 'FR-240', 'Layer views', 'In Progress', 'P1-High');
  insBrief.run('igris-ai', 'TD-001', 'Retired link', 'Pending', 'P3-Low');

  const insEdge = d.prepare(
    `INSERT INTO entity_edges
       (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insEdge.run('brief', 'FR-240', 'goal', 'GL-001', 'serves_goal', 1.0, 'observed', '{}');
  // Soft-deleted: must be invisible to BOTH the count and the detail list.
  insEdge.run('brief', 'TD-001', 'goal', 'GL-001', 'serves_goal', 1.0, 'observed', '{"deleted":1}');
  insEdge.run('learning', '42', 'goal', 'GL-001', 'serves_goal', 1.0, 'observed', '{}');
  insEdge.run('learning', '43', 'goal', 'GL-001', 'serves_goal', 1.0, 'observed', '{"deleted":1}');
  // A different edge_type on the same endpoints must NOT be counted.
  insEdge.run('brief', 'FR-240', 'goal', 'GL-002', 'relates_to', 1.0, 'observed', '{}');

  return d;
}

beforeEach(() => {
  db = makeDb();
});
afterEach(() => {
  db.close();
});

const gids = (r: { goals: { goal_id: string }[] }): string[] => r.goals.map((g) => g.goal_id);

describe('listGoals — ordering', () => {
  it('deadline ASC with NULLS LAST, then created_at DESC', () => {
    const r = listGoals(db, { limit: 25, offset: 0 });
    // GL-003 (2026-05-01) < GL-004 (2026-06-30) < GL-001 (2026-08-31) < GL-002 (null)
    expect(gids(r)).toEqual(['GL-003', 'GL-004', 'GL-001', 'GL-002']);
    // Discriminating: a plain `ORDER BY deadline ASC` in SQLite sorts NULL
    // FIRST, so GL-002 leading would be the exact regression this pins.
    expect(gids(r)[0]).not.toBe('GL-002');
  });

  it('reports count/total/limit/offset and paginates', () => {
    const page = listGoals(db, { limit: 2, offset: 2 });
    expect(gids(page)).toEqual(['GL-001', 'GL-002']);
    expect(page.count).toBe(2);
    expect(page.total).toBe(4);
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(2);
  });
});

describe('listGoals — filters bind', () => {
  it('project', () => {
    const r = listGoals(db, { project: 'other', limit: 25, offset: 0 });
    expect(gids(r)).toEqual(['GL-003']);
    expect(r.total).toBe(1);
  });

  it('status', () => {
    const r = listGoals(db, { status: 'active', limit: 25, offset: 0 });
    expect(gids(r)).toEqual(['GL-004', 'GL-001', 'GL-002']);
    expect(gids(r)).not.toContain('GL-003');
  });

  it('upcoming_days narrows to deadlined ACTIVE goals inside the window', () => {
    const wide = listGoals(db, { upcoming_days: 100000, limit: 25, offset: 0 });
    // Undated GL-002 is excluded (deadline IS NOT NULL) and achieved GL-003 is
    // excluded (status='active') even though its deadline is in the window.
    expect(gids(wide)).toEqual(['GL-004', 'GL-001']);
    expect(gids(wide)).not.toContain('GL-002');
    expect(gids(wide)).not.toContain('GL-003');

    const narrow = listGoals(db, { upcoming_days: 0, limit: 25, offset: 0 });
    // Both fixture deadlines are historical relative to any run after
    // 2026-08-31, so a zero-day window is asserted only for its SHAPE: it must
    // be a subset of the wide window, never a superset.
    for (const g of gids(narrow)) expect(gids(wide)).toContain(g);
  });

  it('`total` reflects the filters, not the table', () => {
    expect(listGoals(db, { status: 'achieved', limit: 25, offset: 0 }).total).toBe(1);
  });
});

describe('listGoals — serving_briefs_count', () => {
  it('counts live serves_goal brief edges only', () => {
    const rows = listGoals(db, { limit: 25, offset: 0 }).goals;
    const byId = new Map(rows.map((g) => [g.goal_id, g.serving_briefs_count]));
    // GL-001 has TWO brief edges; one is soft-deleted. Count must be 1, not 2 —
    // a fixture where both were live could not tell the two apart.
    expect(byId.get('GL-001')).toBe(1);
    // GL-002's only edge is `relates_to`, not `serves_goal`.
    expect(byId.get('GL-002')).toBe(0);
    expect(byId.get('GL-003')).toBe(0);
  });
});

describe('getGoal', () => {
  it('returns the goal, its live serving briefs, and the live learning count', () => {
    const d = getGoal(db, 'GL-001');
    expect(d).not.toBeNull();
    expect(d?.goal.goal_id).toBe('GL-001');
    expect(d?.serving_briefs.map((b) => b.brief_id)).toEqual(['FR-240']);
    // Soft-deleted learning edge 43 excluded; live edge 42 counted.
    expect(d?.serving_learnings_count).toBe(1);
  });

  it('a goal with no edges returns empty collections, not nulls', () => {
    const d = getGoal(db, 'GL-002');
    expect(d?.serving_briefs).toEqual([]);
    expect(d?.serving_learnings_count).toBe(0);
  });

  it('returns null (not a message) when absent — the string is the wrapper’s', () => {
    expect(getGoal(db, 'GL-999')).toBeNull();
  });
});

describe('the reader never writes (AC #7, structurally)', () => {
  it('both functions work on a query_only handle', () => {
    db.pragma('query_only = ON');
    expect(() => listGoals(db, { limit: 25, offset: 0 })).not.toThrow();
    expect(() => getGoal(db, 'GL-001')).not.toThrow();

    // Self-negative-control — prove the pragma is armed on THIS handle.
    expect(() =>
      db.prepare("UPDATE goals SET status = 'abandoned' WHERE goal_id = 'GL-001'").run(),
    ).toThrow();
  });
});
