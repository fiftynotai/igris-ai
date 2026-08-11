/**
 * BR-083 — project qualification: the ladder, the collision fixture, and the
 * two anti-vacuity controls.
 *
 * =========================================================================
 * THE VACUOUS-GATE TRAP THIS FILE EXISTS TO DEFUSE
 * =========================================================================
 * The brief NAMES the trap: *"a red-first test with the SAME brief ID in two
 * projects, both linked to different goals, proves they do not fuse. A fixture
 * with unique IDs passes before and after."* The defect is a COLLISION defect.
 * Unique ids never collide, so a fixture built from unique ids is green on both
 * sides of the fix and proves nothing at all.
 *
 * Three independent proofs are therefore carried here, because one is not
 * enough:
 *
 *  1. A GENUINE RED-FIRST, run by hand against the pre-fix `goals/read.ts` on
 *     this exact fixture. Recorded verbatim in the brief's AC evidence rather
 *     than asserted in prose. It returned TWO rows for ONE edge.
 *
 *  2. A SELF-NEGATIVE-CONTROL THAT SHIPS (`the fixture is not vacuous`). It
 *     runs the DELIBERATELY UNQUALIFIED join — the pre-BR-083 SQL, quoted — on
 *     the SAME fixture and asserts it returns 2. If anyone later weakens the
 *     fixture to unique brief ids, that control goes green-when-it-should-be-
 *     red and FAILS, so the fixture cannot rot into a vacuous one silently.
 *     This is the mechanism; proof 1 is a moment in time and proof 2 is what
 *     outlives it.
 *
 *  3. A STORAGE-LEVEL RED. Two edges differing ONLY by project are IMPOSSIBLE
 *     to store under the pre-v4 table UNIQUE and store cleanly under v4's
 *     expression index. A read-path fix alone could never have caught that,
 *     and it is why v4 REBUILDS the table rather than adding two columns.
 *
 * ANTI-VACUITY CHECKLIST for a future reviewer — the fixture is INVALID unless
 * all four hold: (i) the brief id appears in >= 2 projects; (ii) both instances
 * are linked, to DIFFERENT goals; (iii) the assertion is on ROW COUNT, not
 * merely on the presence of the right brief; (iv) proof 2 asserts the
 * unqualified SQL still returns the FUSED count.
 *
 * @module engine/components/edges/__tests__/project-qualification.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({ getDb: vi.fn() }));

import { getDb } from '../../../../db.js';
import { handleEdgeCreate, handleEdgeList } from '../handlers.js';
import { edgeMigrations } from '../schema.js';
import { goalMigrations } from '../../goals/schema.js';
import { getGoal } from '../../goals/read.js';

// ---------------------------------------------------------------------------
// The collision fixture
// ---------------------------------------------------------------------------

/**
 * THE fixture. Every id below that matters COLLIDES on purpose.
 *
 *   brief_status:  ('proj-a', 'BR-999', 'A-side title')
 *                  ('proj-b', 'BR-999', 'B-side title')   <- SAME id, two projects
 *                  ('proj-a', 'BR-500', ...)              <- also in both
 *                  ('proj-b', 'BR-500', ...)
 *                  ('proj-a', 'BR-001', ...)              <- UNIQUE brain-wide
 *   goals:         GL-A (proj-a), GL-B (proj-b)
 */
function createFixtureDb(): Database.Database {
  const db = new Database(':memory:');
  for (const m of edgeMigrations) db.exec(m.sql);
  for (const m of goalMigrations) db.exec(m.sql);
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL, brief_id TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'P2-Medium',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
    CREATE TABLE IF NOT EXISTS learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL, title TEXT NOT NULL DEFAULT ''
    );
  `);

  const brief = db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status) VALUES (?, ?, ?, ?)`,
  );
  brief.run('proj-a', 'BR-999', 'A-side title', 'Ready');
  brief.run('proj-b', 'BR-999', 'B-side title', 'Done');
  brief.run('proj-a', 'BR-500', 'A-side 500', 'Ready');
  brief.run('proj-b', 'BR-500', 'B-side 500', 'Ready');
  brief.run('proj-a', 'BR-001', 'Unique brain-wide', 'Ready');

  const goal = db.prepare(
    `INSERT INTO goals (goal_id, project_slug, title, description, outcome,
                        deadline, status, priority, metadata)
     VALUES (?, ?, ?, NULL, ?, NULL, 'active', 'P2-Medium', '{}')`,
  );
  goal.run('GL-A', 'proj-a', 'A goal', 'A outcome');
  goal.run('GL-B', 'proj-b', 'B goal', 'B outcome');

  db.prepare(`INSERT INTO learnings (id, project, title) VALUES (?, ?, ?)`).run(
    7,
    'proj-a',
    'a learning',
  );
  return db;
}

/** Link both instances of BR-999 to THEIR OWN goal, qualified. */
function linkBothInstances(): void {
  const a = handleEdgeCreate({
    from_type: 'brief',
    from_id: 'BR-999',
    from_project: 'proj-a',
    to_type: 'goal',
    to_id: 'GL-A',
    edge_type: 'serves_goal',
  });
  expect(a.isError).toBeFalsy();
  const b = handleEdgeCreate({
    from_type: 'brief',
    from_id: 'BR-999',
    from_project: 'proj-b',
    to_type: 'goal',
    to_id: 'GL-B',
    edge_type: 'serves_goal',
  });
  expect(b.isError).toBeFalsy();
}

/**
 * The pre-BR-083 join, QUOTED VERBATIM from `goals/read.ts` before this brief.
 *
 * It is here as an INSTRUMENT, not as dead code: the self-negative-control
 * below runs it to prove the fixture still collides. Do not "modernise" it —
 * the moment it grows a project predicate it stops being able to detect a
 * vacuous fixture.
 */
const PRE_BR083_SERVING_BRIEFS_SQL = `
  SELECT bs.brief_id, bs.title, bs.status, bs.priority
  FROM entity_edges e
  JOIN brief_status bs ON bs.brief_id = e.from_id
  WHERE e.to_type = 'goal'
    AND e.to_id = ?
    AND e.from_type = 'brief'
    AND e.edge_type = 'serves_goal'
    AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) != 1
  ORDER BY bs.brief_id ASC`;

// ---------------------------------------------------------------------------

describe('BR-083 — project qualification', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createFixtureDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // PROOF 1's assertion — the demonstrating bug, fixed
  // -------------------------------------------------------------------------

  describe('two projects, same brief id, different goals — they do NOT fuse', () => {
    it('getGoal(GL-A) returns exactly ONE row, and it is the A-side instance', () => {
      linkBothInstances();

      const a = getGoal(db, 'GL-A')!;
      expect(a.serving_briefs).toHaveLength(1);
      expect(a.serving_briefs[0]).toMatchObject({
        brief_id: 'BR-999',
        project: 'proj-a',
        title: 'A-side title',
      });
    });

    it('getGoal(GL-B) is symmetric — ONE row, the B-side instance', () => {
      linkBothInstances();

      const b = getGoal(db, 'GL-B')!;
      expect(b.serving_briefs).toHaveLength(1);
      expect(b.serving_briefs[0]).toMatchObject({
        brief_id: 'BR-999',
        project: 'proj-b',
        title: 'B-side title',
      });
    });

    // ---- PROOF 2 — THE SELF-NEGATIVE-CONTROL THAT SHIPS --------------------
    it('the fixture is NOT vacuous: the pre-BR-083 join still returns 2 rows for 1 edge', () => {
      linkBothInstances();

      // ONE edge into GL-A...
      const edgeCount = db
        .prepare(
          `SELECT COUNT(*) AS n FROM entity_edges
           WHERE to_type = 'goal' AND to_id = 'GL-A'
             AND from_type = 'brief' AND edge_type = 'serves_goal'`,
        )
        .get() as { n: number };
      expect(edgeCount.n).toBe(1);

      // ...but the unqualified join fans it out to TWO. If this ever returns 1,
      // the fixture no longer collides and EVERY assertion in this describe
      // block has become vacuous. That is the failure this control exists to
      // produce, loudly, instead of a green suite that proves nothing.
      const fused = db.prepare(PRE_BR083_SERVING_BRIEFS_SQL).all('GL-A') as unknown[];
      expect(fused).toHaveLength(2);

      // And the fixed reader disagrees with it — the whole point.
      expect(getGoal(db, 'GL-A')!.serving_briefs).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // PROOF 3 — the storage-level red
  // -------------------------------------------------------------------------

  describe('storage: two edges differing ONLY by project', () => {
    it('v4 stores BOTH as two distinct rows', () => {
      const a = handleEdgeCreate({
        from_type: 'brief', from_id: 'BR-999', from_project: 'proj-a',
        to_type: 'brief', to_id: 'BR-500', to_project: 'proj-a',
        edge_type: 'depends_on',
      });
      const b = handleEdgeCreate({
        from_type: 'brief', from_id: 'BR-999', from_project: 'proj-b',
        to_type: 'brief', to_id: 'BR-500', to_project: 'proj-b',
        edge_type: 'depends_on',
      });
      expect(a.isError).toBeFalsy();
      expect(b.isError).toBeFalsy();

      const rows = db
        .prepare(
          `SELECT id, from_project, to_project FROM entity_edges
           WHERE from_id = 'BR-999' AND to_id = 'BR-500' AND edge_type = 'depends_on'
           ORDER BY id ASC`,
        )
        .all() as Array<{ id: number; from_project: string; to_project: string }>;

      expect(rows).toHaveLength(2);
      expect(rows[0].id).not.toBe(rows[1].id);
      expect(rows.map((r) => r.from_project)).toEqual(['proj-a', 'proj-b']);
    });

    it('the PRE-v4 table shape could not store them — one row, silently', () => {
      // The v1 DDL, quoted. This is the red: the same two logical edges collapse
      // to ONE row under the old table-level UNIQUE, so no read-path fix could
      // ever have recovered the second one. It is why v4 is a REBUILD.
      const legacy = new Database(':memory:');
      legacy.exec(`
        CREATE TABLE entity_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_type TEXT NOT NULL, from_id TEXT NOT NULL,
          to_type TEXT NOT NULL, to_id TEXT NOT NULL,
          edge_type TEXT NOT NULL,
          UNIQUE(from_type, from_id, to_type, to_id, edge_type)
        );
      `);
      const ins = legacy.prepare(
        `INSERT OR IGNORE INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
         VALUES ('brief', 'BR-999', 'brief', 'BR-500', 'depends_on')`,
      );
      ins.run();
      ins.run();
      const n = (legacy.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number }).n;
      expect(n).toBe(1);
      legacy.close();
    });

    it('idempotency SURVIVES for project-less edges — NULL is folded, not distinct', () => {
      // The D2 trap: NULL is DISTINCT in a SQLite UNIQUE, so a plain
      // `UNIQUE(..., from_project, ...)` would let these two BOTH insert and
      // silently break idempotency for exactly the population that legitimately
      // has no project. The expression index over COALESCE(...,'') folds them.
      const first = handleEdgeCreate({
        from_type: 'concept', from_id: 'graph-keys',
        to_type: 'concept', to_id: 'node-identity',
        edge_type: 'related_to',
      });
      const second = handleEdgeCreate({
        from_type: 'concept', from_id: 'graph-keys',
        to_type: 'concept', to_id: 'node-identity',
        edge_type: 'related_to',
      });
      const p1 = JSON.parse(first.content[0].text) as { id: number; created: boolean };
      const p2 = JSON.parse(second.content[0].text) as { id: number; created: boolean };

      expect(p1.created).toBe(true);
      expect(p2.created).toBe(false);
      expect(p2.id).toBe(p1.id);
      const n = (
        db.prepare("SELECT COUNT(*) AS n FROM entity_edges WHERE from_type='concept'").get() as {
          n: number;
        }
      ).n;
      expect(n).toBe(1);
    });

    it('idempotency reads back the RIGHT row when two differ only by project', () => {
      // Without the two `IS ?` predicates on the follow-up SELECT, this returns
      // the FIRST matching row and reports the wrong id for the second edge.
      const a = JSON.parse(
        handleEdgeCreate({
          from_type: 'brief', from_id: 'BR-999', from_project: 'proj-a',
          to_type: 'goal', to_id: 'GL-A', edge_type: 'serves_goal',
        }).content[0].text,
      ) as { id: number };
      const b = JSON.parse(
        handleEdgeCreate({
          from_type: 'brief', from_id: 'BR-999', from_project: 'proj-b',
          to_type: 'goal', to_id: 'GL-A', edge_type: 'serves_goal',
        }).content[0].text,
      ) as { id: number };
      expect(b.id).not.toBe(a.id);

      const again = JSON.parse(
        handleEdgeCreate({
          from_type: 'brief', from_id: 'BR-999', from_project: 'proj-b',
          to_type: 'goal', to_id: 'GL-A', edge_type: 'serves_goal',
        }).content[0].text,
      ) as { id: number; created: boolean };
      expect(again.created).toBe(false);
      expect(again.id).toBe(b.id);
    });
  });

  // -------------------------------------------------------------------------
  // The ladder — all six cells
  // -------------------------------------------------------------------------

  describe('the ladder: |P| x {omitted, supplied}', () => {
    it('|P| = 0, omitted -> NULL', () => {
      const r = handleEdgeCreate({
        from_type: 'concept', from_id: 'no-such-node',
        to_type: 'concept', to_id: 'other', edge_type: 'related_to',
      });
      const e = JSON.parse(r.content[0].text) as { edge: { from_project: null } };
      expect(e.edge.from_project).toBeNull();
    });

    it('|P| = 0, supplied -> stored VERBATIM (D4: existence was never validated)', () => {
      const r = handleEdgeCreate({
        from_type: 'brief', from_id: 'BR-NOT-YET', from_project: 'proj-z',
        to_type: 'goal', to_id: 'GL-A', edge_type: 'serves_goal',
      });
      expect(r.isError).toBeFalsy();
      const e = JSON.parse(r.content[0].text) as { edge: { from_project: string } };
      expect(e.edge.from_project).toBe('proj-z');
    });

    it('|P| = 1, omitted -> RESOLVED FOR FREE', () => {
      const r = handleEdgeCreate({
        from_type: 'brief', from_id: 'BR-001',
        to_type: 'goal', to_id: 'GL-A', edge_type: 'serves_goal',
      });
      expect(r.isError).toBeFalsy();
      const e = JSON.parse(r.content[0].text) as {
        edge: { from_project: string; to_project: string };
      };
      expect(e.edge.from_project).toBe('proj-a');
      // The goal side resolves for free too — `goals.project_slug`.
      expect(e.edge.to_project).toBe('proj-a');
    });

    it('|P| = 1, supplied and MATCHING -> accepted', () => {
      const r = handleEdgeCreate({
        from_type: 'brief', from_id: 'BR-001', from_project: 'proj-a',
        to_type: 'goal', to_id: 'GL-A', edge_type: 'serves_goal',
      });
      expect(r.isError).toBeFalsy();
    });

    it('|P| = 1, supplied and WRONG -> REJECTED, naming where it does live', () => {
      const r = handleEdgeCreate({
        from_type: 'brief', from_id: 'BR-001', from_project: 'proj-b',
        to_type: 'goal', to_id: 'GL-A', edge_type: 'serves_goal',
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(
        'brief "BR-001" does not exist in project "proj-b"',
      );
      expect(r.content[0].text).toContain('It exists in: proj-a.');
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number }).n,
      ).toBe(0);
    });

    it('|P| > 1, omitted -> REJECTED, listing the candidates', () => {
      const r = handleEdgeCreate({
        from_type: 'brief', from_id: 'BR-999',
        to_type: 'goal', to_id: 'GL-A', edge_type: 'serves_goal',
      });
      expect(r.isError).toBe(true);
      const text = r.content[0].text;
      // ONE dialect with BR-078's seed error: same clause order, same renderer,
      // same `Pass <param> to qualify <id param>` sentence.
      expect(text).toContain('Ambiguous endpoint: brief "BR-999" exists in 2 projects');
      expect(text).toContain('(proj-a, proj-b)');
      expect(text).toContain('Pass from_project to qualify from_id.');
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number }).n,
      ).toBe(0);
    });

    it('|P| > 1, supplied and a MEMBER -> accepted', () => {
      const r = handleEdgeCreate({
        from_type: 'brief', from_id: 'BR-999', from_project: 'proj-b',
        to_type: 'goal', to_id: 'GL-B', edge_type: 'serves_goal',
      });
      expect(r.isError).toBeFalsy();
    });

    it('|P| > 1, supplied and NOT a member -> REJECTED', () => {
      const r = handleEdgeCreate({
        from_type: 'brief', from_id: 'BR-999', from_project: 'proj-z',
        to_type: 'goal', to_id: 'GL-B', edge_type: 'serves_goal',
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('does not exist in project "proj-z"');
    });

    it('the TO side goes through the same ladder', () => {
      const r = handleEdgeCreate({
        from_type: 'learning', from_id: '7',
        to_type: 'brief', to_id: 'BR-999',
        edge_type: 'derived_from',
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('Pass to_project to qualify to_id.');
    });

    it('a non-string qualifier is refused before any lookup', () => {
      const r = handleEdgeCreate({
        from_type: 'brief', from_id: 'BR-001', from_project: 42,
        to_type: 'goal', to_id: 'GL-A', edge_type: 'serves_goal',
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(
        'from_project must be a non-empty string when provided',
      );
    });
  });

  // -------------------------------------------------------------------------
  // igris_edge_list filters
  // -------------------------------------------------------------------------

  describe('handleEdgeList project filters', () => {
    it('filters to the stored qualifier, and NULL rows match no value', () => {
      linkBothInstances();
      handleEdgeCreate({
        from_type: 'concept', from_id: 'c1',
        to_type: 'concept', to_id: 'c2', edge_type: 'related_to',
      });

      const a = JSON.parse(
        handleEdgeList({ from_project: 'proj-a' }).content[0].text,
      ) as { total: number };
      expect(a.total).toBe(1);

      const all = JSON.parse(handleEdgeList({}).content[0].text) as { total: number };
      expect(all.total).toBe(3);

      // The residual is visible by subtraction, never by a filter that quietly
      // includes it.
      const b = JSON.parse(
        handleEdgeList({ from_project: 'proj-b' }).content[0].text,
      ) as { total: number };
      expect(all.total - a.total - b.total).toBe(1);
    });
  });
});
