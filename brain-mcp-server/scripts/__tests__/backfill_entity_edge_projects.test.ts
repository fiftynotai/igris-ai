/**
 * BR-083 — the backfill's class assignment, and the control that matters most.
 *
 * THE CONTROL THAT MATTERS MOST is `never guesses`: a synthetic `|C| = 2` row —
 * the single largest unattributable class on the live brain (283 of 785) — must
 * be left NULL. Every other assertion here is about attributing correctly; that
 * one is about REFUSING correctly, and it is the assertion that would fail if
 * someone later "improved" the backfill by picking the first candidate.
 *
 * A WRONG ATTRIBUTION IS WORSE THAN A NULL. That ruling has to be a test, not
 * a comment, because it is the only part of this script a future change is
 * tempted to relax.
 *
 * @module scripts/__tests__/backfill_entity_edge_projects.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runBackfill, classifyResolved } from '../backfill_entity_edge_projects.js';
import type { BackfillDecision } from '../backfill_entity_edge_projects.js';
import { edgeMigrations } from '../../src/engine/components/edges/schema.js';
import { goalMigrations } from '../../src/engine/components/goals/schema.js';

let dir: string;
let db: Database.Database;

/**
 * A fixture with one row in every class the live brain actually populates.
 *
 *   BR-UNIQ      only in proj-a          |  BR-DUP2   in proj-a + proj-b
 *   BR-DUP2B     in proj-a + proj-b      |  BR-DUP9   in nine projects
 *   BR-DUP9B     in the same nine
 *   GL-A         a goal owned by proj-a
 *   learning 5   owned by proj-a
 */
function seed(): Database.Database {
  const d = new Database(join(dir, 'fixture.db'));
  for (const m of edgeMigrations) d.exec(m.sql);
  for (const m of goalMigrations) d.exec(m.sql);
  d.exec(`
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL, brief_type TEXT, title TEXT NOT NULL,
      status TEXT NOT NULL, priority TEXT DEFAULT 'P2-Medium',
      effort TEXT, phase TEXT, updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project, brief_id));
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'pattern', scope TEXT DEFAULT 'project',
      confidence REAL DEFAULT 1.0, source_brief TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')));
  `);

  const b = d.prepare(
    'INSERT INTO brief_status (project, brief_id, title, status) VALUES (?, ?, ?, ?)',
  );
  b.run('proj-a', 'BR-UNIQ', 'unique', 'Ready');
  for (const p of ['proj-a', 'proj-b']) {
    b.run(p, 'BR-DUP2', 'two', 'Ready');
    b.run(p, 'BR-DUP2B', 'two b', 'Ready');
  }
  const nine = Array.from({ length: 9 }, (_, i) => `p${i}`);
  for (const p of nine) {
    b.run(p, 'BR-DUP9', 'nine', 'Ready');
    b.run(p, 'BR-DUP9B', 'nine b', 'Ready');
  }

  d.prepare(
    `INSERT INTO goals (goal_id, project_slug, title, description, outcome,
                        deadline, status, priority, metadata)
     VALUES ('GL-A', 'proj-a', 'goal', NULL, 'outcome', NULL, 'active', 'P2-Medium', '{}')`,
  ).run();
  d.prepare('INSERT INTO learnings (id, project, title) VALUES (5, ?, ?)').run(
    'proj-a',
    'l',
  );
  return d;
}

/** Insert one UNQUALIFIED edge (the shape every pre-BR-083 row has). */
function edge(
  d: Database.Database,
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  edgeType = 'related_to',
): number {
  const info = d
    .prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(fromType, fromId, toType, toId, edgeType);
  return Number(info.lastInsertRowid);
}

function decisionFor(decisions: BackfillDecision[], id: number): BackfillDecision {
  const d = decisions.find((x) => x.edge_id === id);
  if (!d) throw new Error(`no decision recorded for edge ${id} — the report is incomplete`);
  return d;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'br083-backfill-'));
  db = seed();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('BR-083 backfill — classification', () => {
  it('C1: neither endpoint ambiguous -> each endpoint keeps its OWN project', () => {
    // Deliberately CROSS-PROJECT: a learning in proj-a linked to a goal in
    // proj-a is trivial; the interesting property is that branch 1 is never
    // forced intra-project. Both sides here happen to be proj-a, and the
    // assertion is that both are written, not that they were made to match.
    const id = edge(db, 'learning', '5', 'brief', 'BR-UNIQ', 'derived_from');
    const { decisions } = runBackfill(db, {
      dbPath: '', apply: true, reportPath: null, verbose: false,
    });
    const d = decisionFor(decisions, id);
    expect(d.class).toBe('C1');
    expect(d.verdict).toBe('attributed');
    expect(d.from_project).toBe('proj-a');
    expect(d.to_project).toBe('proj-a');

    const row = db.prepare('SELECT * FROM entity_edges WHERE id = ?').get(id) as {
      from_project: string;
      to_project: string;
    };
    expect(row.from_project).toBe('proj-a');
    expect(row.to_project).toBe('proj-a');
  });

  it('C2: owner hint applies -> the hinted project on BOTH sides', () => {
    // BR-DUP2 is ambiguous; the goal's `project_slug` is a REAL column and
    // names proj-a, which BR-DUP2 lives in. FR-237 branch 2.
    const id = edge(db, 'brief', 'BR-DUP2', 'goal', 'GL-A', 'serves_goal');
    const { decisions } = runBackfill(db, {
      dbPath: '', apply: true, reportPath: null, verbose: false,
    });
    const d = decisionFor(decisions, id);
    expect(d.class).toBe('C2');
    expect(d.verdict).toBe('attributed');
    expect(d.from_project).toBe('proj-a');
    expect(d.to_project).toBe('proj-a');
  });

  it('C3: both ambiguous but |C| = 1 -> the single shared project', () => {
    // BR-DUP2 is in {proj-a, proj-b}; BR-DUP9 is in {p0..p8}. Give them exactly
    // ONE project in common by adding BR-DUP9 to proj-b.
    db.prepare(
      'INSERT INTO brief_status (project, brief_id, title, status) VALUES (?, ?, ?, ?)',
    ).run('proj-b', 'BR-DUP9', 'nine', 'Ready');
    const id = edge(db, 'brief', 'BR-DUP2', 'brief', 'BR-DUP9', 'depends_on');

    const { decisions } = runBackfill(db, {
      dbPath: '', apply: true, reportPath: null, verbose: false,
    });
    const d = decisionFor(decisions, id);
    expect(d.class).toBe('C3');
    expect(d.verdict).toBe('attributed');
    expect(d.from_project).toBe('proj-b');
    expect(d.to_project).toBe('proj-b');
  });

  // ---- THE CONTROL --------------------------------------------------------
  it('NEVER GUESSES: a |C| = 2 row is left NULL, in the DB and in the report', () => {
    const id = edge(db, 'brief', 'BR-DUP2', 'brief', 'BR-DUP2B', 'depends_on');

    const { decisions, histogram } = runBackfill(db, {
      dbPath: '', apply: true, reportPath: null, verbose: false,
    });
    const d = decisionFor(decisions, id);
    expect(d.class).toBe('C4');
    expect(d.verdict).toBe('unattributable');
    expect(d.candidates).toBe(2);
    expect(d.from_project).toBeNull();
    expect(d.to_project).toBeNull();
    expect(histogram.attributed).toBe(0);

    // APPLY WAS ON. The row is still NULL because the script refused, not
    // because nothing ran — that distinction is the whole test.
    const row = db.prepare('SELECT * FROM entity_edges WHERE id = ?').get(id) as {
      from_project: string | null;
      to_project: string | null;
    };
    expect(row.from_project).toBeNull();
    expect(row.to_project).toBeNull();

    // ARM CHECK: the same run, same flags, DOES write a provable row. Without
    // it, "still NULL" is also what a no-op script produces.
    const provable = edge(db, 'learning', '5', 'brief', 'BR-UNIQ', 'derived_from');
    runBackfill(db, { dbPath: '', apply: true, reportPath: null, verbose: false });
    const written = db.prepare('SELECT * FROM entity_edges WHERE id = ?').get(provable) as {
      from_project: string | null;
    };
    expect(written.from_project).toBe('proj-a');
  });

  it('C5: |C| > 8 is over the replica cap and stays NULL', () => {
    const id = edge(db, 'brief', 'BR-DUP9', 'brief', 'BR-DUP9B', 'depends_on');
    const { decisions } = runBackfill(db, {
      dbPath: '', apply: true, reportPath: null, verbose: false,
    });
    const d = decisionFor(decisions, id);
    expect(d.class).toBe('C5');
    expect(d.verdict).toBe('unattributable');
    expect(d.candidates).toBe(9);
  });

  it('C6: one ambiguous, the hint FAILS -> NULL (no fabricated bridge)', () => {
    // `learning 5` is proj-a; BR-DUP9 lives in p0..p8 and NOT in proj-a, so the
    // fixed side gives no honest way to choose. Every choice would invent a
    // cross-project bridge.
    const id = edge(db, 'learning', '5', 'brief', 'BR-DUP9', 'derived_from');
    const { decisions } = runBackfill(db, {
      dbPath: '', apply: true, reportPath: null, verbose: false,
    });
    const d = decisionFor(decisions, id);
    expect(d.class).toBe('C6');
    expect(d.verdict).toBe('unattributable');
  });

  it('C7: |C| = 0 is dangling and reported as such', () => {
    // BR-DUP2 in {proj-a, proj-b}, BR-DUP9 in {p0..p8}: no common project.
    const id = edge(db, 'brief', 'BR-DUP2', 'brief', 'BR-DUP9', 'depends_on');
    const { decisions } = runBackfill(db, {
      dbPath: '', apply: true, reportPath: null, verbose: false,
    });
    const d = decisionFor(decisions, id);
    expect(d.class).toBe('C7');
    expect(d.verdict).toBe('unattributable');
    expect(d.candidates).toBe(0);
  });
});

describe('BR-083 backfill — reporting and safety', () => {
  it('reports EVERY source row, attributed or not (AC-4)', () => {
    edge(db, 'learning', '5', 'brief', 'BR-UNIQ', 'derived_from');
    edge(db, 'brief', 'BR-DUP2', 'brief', 'BR-DUP2B', 'depends_on');
    edge(db, 'brief', 'BR-DUP9', 'brief', 'BR-DUP9B', 'blocks');

    const reportPath = join(dir, 'report.jsonl');
    const { histogram } = runBackfill(db, {
      dbPath: '', apply: false, reportPath, verbose: false,
    });

    const lines = readFileSync(reportPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(histogram.source_edges).toBe(3);
    expect(histogram.attributed + histogram.unattributable).toBe(3);
    for (const line of lines) {
      const d = JSON.parse(line) as BackfillDecision;
      expect(d.edge_id).toBeGreaterThan(0);
      expect(['attributed', 'unattributable']).toContain(d.verdict);
      expect(d.resolution).toBeTruthy();
    }
  });

  it('DRY RUN writes nothing', () => {
    const id = edge(db, 'learning', '5', 'brief', 'BR-UNIQ', 'derived_from');
    const { histogram } = runBackfill(db, {
      dbPath: '', apply: false, reportPath: null, verbose: false,
    });
    expect(histogram.attributed).toBe(1);

    const row = db.prepare('SELECT * FROM entity_edges WHERE id = ?').get(id) as {
      from_project: string | null;
    };
    expect(row.from_project).toBeNull();
  });

  it('is IDEMPOTENT: a second apply re-decides nothing', () => {
    edge(db, 'learning', '5', 'brief', 'BR-UNIQ', 'derived_from');
    const first = runBackfill(db, {
      dbPath: '', apply: true, reportPath: null, verbose: false,
    });
    expect(first.histogram.attributed).toBe(1);

    const second = runBackfill(db, {
      dbPath: '', apply: true, reportPath: null, verbose: false,
    });
    expect(second.histogram.already_qualified).toBe(1);
    expect(second.histogram.attributed).toBe(0);
    expect(second.decisions).toHaveLength(0);
  });

  it('leaves an ALREADY-qualified row alone even when it disagrees with the ladder', () => {
    // A writer that knew more than an inference can. The row says proj-b; the
    // ladder, given the same endpoints, would say proj-a. The backfill must not
    // "correct" it — its job is to fill NULLs.
    const id = edge(db, 'brief', 'BR-DUP2', 'goal', 'GL-A', 'serves_goal');
    db.prepare(
      'UPDATE entity_edges SET from_project = ?, to_project = ? WHERE id = ?',
    ).run('proj-b', 'proj-b', id);

    runBackfill(db, { dbPath: '', apply: true, reportPath: null, verbose: false });
    const row = db.prepare('SELECT * FROM entity_edges WHERE id = ?').get(id) as {
      from_project: string;
    };
    expect(row.from_project).toBe('proj-b');
  });

  it('skips soft-deleted rows entirely', () => {
    const id = edge(db, 'learning', '5', 'brief', 'BR-UNIQ', 'derived_from');
    db.prepare('UPDATE entity_edges SET metadata = ? WHERE id = ?').run(
      '{"deleted":true}',
      id,
    );
    const { histogram } = runBackfill(db, {
      dbPath: '', apply: true, reportPath: null, verbose: false,
    });
    expect(histogram.source_edges).toBe(0);
  });
});

describe('classifyResolved — the class letters map onto FR-237 verdicts', () => {
  it('an UNKNOWN resolution refuses rather than attributes', () => {
    // If `ResolvedEdge['resolution']` ever gains a member, the default must be
    // a refusal. A default of C1 would attribute a verdict nobody wrote a rule
    // for, which is the failure mode this whole script is built to avoid.
    expect(classifyResolved('some_future_verdict', 3, true, true)).toBe('C6');
  });

  it('distinguishes C1/C2/C3 by WHICH endpoints were ambiguous', () => {
    expect(classifyResolved('unique', 1, false, false)).toBe('C1');
    expect(classifyResolved('unique', 1, true, false)).toBe('C2');
    expect(classifyResolved('unique', 1, false, true)).toBe('C2');
    expect(classifyResolved('unique', 1, true, true)).toBe('C3');
  });
});
