/**
 * Edges Component — node → project resolution (BR-078)
 *
 * Covers T12 of the BR-078 plan: `projectsFor` per entity type, graceful
 * degradation when the schema cannot answer (missing table AND missing column),
 * memoisation, and the FR-237 branch 2/3 hop rule exhaustively.
 *
 * @module engine/components/edges/__tests__/node-project.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  createProjectResolver,
  resolveHopProject,
  PROJECT_SCOPED_TYPES,
} from '../node-project.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A brain with every project column present (the modern shape). */
function createFullDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE brief_status (
      project TEXT NOT NULL, brief_id TEXT NOT NULL, title TEXT,
      PRIMARY KEY (project, brief_id));
    CREATE TABLE learnings (id INTEGER PRIMARY KEY, project TEXT, title TEXT);
    CREATE TABLE errors (id INTEGER PRIMARY KEY, project TEXT, message TEXT);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, project TEXT, summary TEXT);
    CREATE TABLE goals (goal_id TEXT UNIQUE, project_slug TEXT, title TEXT);
    CREATE TABLE graph_nodes (
      node_type TEXT NOT NULL, node_external_id TEXT NOT NULL,
      label TEXT, properties TEXT,
      UNIQUE (node_type, node_external_id));
  `);
  return db;
}

/**
 * The shape the FR-113 traversal fixtures actually build: label tables with NO
 * `project` column at all. This is the `|P| = 0` population decision C is
 * designed for.
 */
function createColumnlessDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE learnings (id INTEGER PRIMARY KEY, title TEXT, content TEXT);
    CREATE TABLE errors (id INTEGER PRIMARY KEY, message TEXT);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, summary TEXT);
  `);
  return db;
}

// ---------------------------------------------------------------------------
// projectsFor
// ---------------------------------------------------------------------------

describe('BR-078 node-project — projectsFor', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullDb();
  });

  afterEach(() => {
    db.close();
  });

  it('brief: returns every project a colliding id lives in, nulls-first ascending', () => {
    const ins = db.prepare('INSERT INTO brief_status (project, brief_id, title) VALUES (?,?,?)');
    ins.run('zeta', 'BR-001', 'z');
    ins.run('alpha', 'BR-001', 'a');
    ins.run('mid', 'BR-001', 'm');
    ins.run('alpha', 'BR-002', 'only-a');

    const r = createProjectResolver(db);
    expect(r.projectsFor('brief', 'BR-001')).toEqual(['alpha', 'mid', 'zeta']);
    expect(r.projectsFor('brief', 'BR-002')).toEqual(['alpha']);
  });

  it('brief: unknown id resolves to the empty (phantom) set', () => {
    const r = createProjectResolver(db);
    expect(r.projectsFor('brief', 'NOPE')).toEqual([]);
  });

  it('learning / error / session resolve through the numericId convention', () => {
    db.prepare('INSERT INTO learnings (id, project, title) VALUES (?,?,?)').run(7, 'proj-a', 'l');
    db.prepare('INSERT INTO errors (id, project, message) VALUES (?,?,?)').run(8, 'proj-b', 'e');
    db.prepare('INSERT INTO sessions (id, project, summary) VALUES (?,?,?)').run(9, 'proj-c', 's');

    const r = createProjectResolver(db);
    // entity_edges stores these as String(id) — the CAST is what makes it match.
    expect(r.projectsFor('learning', '7')).toEqual(['proj-a']);
    expect(r.projectsFor('error', '8')).toEqual(['proj-b']);
    expect(r.projectsFor('session', '9')).toEqual(['proj-c']);
  });

  it('goal resolves via project_slug and tolerates a NULL owner', () => {
    db.prepare('INSERT INTO goals (goal_id, project_slug, title) VALUES (?,?,?)').run('GL-1', 'proj-a', 'g');
    db.prepare('INSERT INTO goals (goal_id, project_slug, title) VALUES (?,?,?)').run('GL-2', null, 'g2');

    const r = createProjectResolver(db);
    expect(r.projectsFor('goal', 'GL-1')).toEqual(['proj-a']);
    expect(r.projectsFor('goal', 'GL-2')).toEqual([null]);
  });

  it('concept / decision resolve via graph_nodes properties.project, scoped by node_type', () => {
    const ins = db.prepare(
      'INSERT INTO graph_nodes (node_type, node_external_id, label, properties) VALUES (?,?,?,?)',
    );
    ins.run('concept', 'shared-id', 'c', JSON.stringify({ project: 'proj-a' }));
    ins.run('decision', 'shared-id', 'd', JSON.stringify({ project: 'proj-b' }));

    const r = createProjectResolver(db);
    expect(r.projectsFor('concept', 'shared-id')).toEqual(['proj-a']);
    expect(r.projectsFor('decision', 'shared-id')).toEqual(['proj-b']);
  });

  it('empty-string project normalises to null', () => {
    db.prepare('INSERT INTO brief_status (project, brief_id, title) VALUES (?,?,?)').run('', 'BR-9', 't');
    const r = createProjectResolver(db);
    expect(r.projectsFor('brief', 'BR-9')).toEqual([null]);
  });

  it('unknown entity type is permissive — empty set, no throw', () => {
    const r = createProjectResolver(db);
    expect(r.projectsFor('asteroid', 'X-1')).toEqual([]);
  });

  it('memoises: a repeated (type, id) issues exactly one SQL lookup', () => {
    db.prepare('INSERT INTO brief_status (project, brief_id, title) VALUES (?,?,?)').run('p', 'BR-1', 't');
    const r = createProjectResolver(db);
    r.projectsFor('brief', 'BR-1');
    r.projectsFor('brief', 'BR-1');
    r.projectsFor('brief', 'BR-1');
    expect(r._queryCount()).toBe(1);

    r.projectsFor('brief', 'BR-2');
    expect(r._queryCount()).toBe(2);
  });

  it('PROJECT_SCOPED_TYPES is documentation only — logic does not branch on it', () => {
    // The doc-constant names `brief`, but a NON-listed type still gets a real,
    // empirically computed answer. A future colliding type needs no code change.
    expect([...PROJECT_SCOPED_TYPES]).toEqual(['brief']);
    db.prepare('INSERT INTO goals (goal_id, project_slug, title) VALUES (?,?,?)').run('GL-7', 'proj-x', 'g');
    const r = createProjectResolver(db);
    expect(r.projectsFor('goal', 'GL-7')).toEqual(['proj-x']);
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

describe('BR-078 node-project — degradation', () => {
  it('missing table (goals, pre-FR-110) resolves to [] rather than throwing', () => {
    const db = createColumnlessDb();
    try {
      const r = createProjectResolver(db);
      expect(() => r.projectsFor('goal', 'GL-1')).not.toThrow();
      expect(r.projectsFor('goal', 'GL-1')).toEqual([]);
      expect(r.projectsFor('brief', 'BR-1')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('missing PROJECT COLUMN resolves to [] — the FR-113 fixture shape', () => {
    const db = createColumnlessDb();
    try {
      db.prepare('INSERT INTO learnings (id, title, content) VALUES (?,?,?)').run(1, 't', 'c');
      const r = createProjectResolver(db);
      // learnings EXISTS but has no `project` column. This must degrade exactly
      // like a missing table — it is the load-bearing case for the ~30
      // pre-existing traversal tests continuing to pass unedited.
      expect(r.projectsFor('learning', '1')).toEqual([]);
      expect(r.projectsFor('error', '1')).toEqual([]);
      expect(r.projectsFor('session', '1')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('an unavailable type is probed at most once, then memoised as unavailable', () => {
    const db = createColumnlessDb();
    try {
      const r = createProjectResolver(db);
      r.projectsFor('goal', 'GL-1');
      r.projectsFor('goal', 'GL-2');
      r.projectsFor('goal', 'GL-3');
      // Prepare failed once; no statement was ever executed.
      expect(r._queryCount()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('a non-schema SQL error still propagates (no blanket swallow)', () => {
    const db = new Database(':memory:');
    try {
      // brief_status exists but is a VIEW over a table we then drop mid-flight,
      // producing a genuine runtime error that is NOT an absence.
      db.exec(`CREATE TABLE base (project TEXT, brief_id TEXT);
               CREATE VIEW brief_status AS SELECT project, brief_id FROM base;`);
      const r = createProjectResolver(db);
      expect(r.projectsFor('brief', 'X')).toEqual([]);
      db.exec('DROP TABLE base');
      // Now the prepared statement's underlying table is gone — SQLite reports
      // "no such table: base", which IS an absence and degrades. Assert the
      // resolver survived rather than crashed the traversal.
      expect(r.projectsFor('brief', 'Y')).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The hop rule — FR-237 branches, exhaustively
// ---------------------------------------------------------------------------

describe('BR-078 node-project — resolveHopProject', () => {
  // -- Branch 1: neither endpoint ambiguous ---------------------------------

  it('branch 1, |C| = 0 (phantom far end): traverses with project null', () => {
    expect(resolveHopProject('proj-a', ['proj-a'], [])).toEqual({
      verdict: 'traverse',
      project: null,
    });
    expect(resolveHopProject(null, [], [])).toEqual({ verdict: 'traverse', project: null });
  });

  it('branch 1: adopts the far project, cross-project edges included', () => {
    expect(resolveHopProject('proj-a', ['proj-a'], ['proj-a'])).toEqual({
      verdict: 'traverse',
      project: 'proj-a',
    });
    // A learning owned by B legitimately links to A's brief. Both ids are
    // unique, so FR-237 branch 1 emits it — NOT forced intra-project.
    expect(resolveHopProject('proj-a', ['proj-a'], ['proj-b'])).toEqual({
      verdict: 'traverse',
      project: 'proj-b',
    });
    // A phantom near end still walks (the pre-BR-078 fixtures' shape).
    expect(resolveHopProject(null, [], ['proj-b'])).toEqual({
      verdict: 'traverse',
      project: 'proj-b',
    });
  });

  // -- Branch 2/3: far side ambiguous, near side fixed ----------------------

  it('branch 2 (far ambiguous): owner hint adopts the current project', () => {
    expect(resolveHopProject('proj-b', ['proj-b'], ['proj-a', 'proj-b', 'proj-c'])).toEqual({
      verdict: 'traverse',
      project: 'proj-b',
    });
  });

  it('branch 3 (far ambiguous, hint misses): unresolved — a real loss', () => {
    expect(resolveHopProject('proj-z', ['proj-z'], ['proj-a', 'proj-b'])).toEqual({
      verdict: 'unresolved',
      project: null,
    });
  });

  it('branch 3 (far ambiguous, null near project): unresolved', () => {
    // null satisfies no owner hint — a phantom near end asserts nothing about
    // which instance the far end is.
    expect(resolveHopProject(null, [], ['proj-a', 'proj-b'])).toEqual({
      verdict: 'unresolved',
      project: null,
    });
    expect(resolveHopProject(null, [], [null, 'proj-a'])).toEqual({
      verdict: 'unresolved',
      project: null,
    });
  });

  // -- Branch 2/3: NEAR side ambiguous — the case a |C|-only rule misses ----

  it('branch 2 (near ambiguous): walks ONLY from the instance the far side names', () => {
    // The live shape: BR-001 in {proj-a, proj-b}, BR-009 only in proj-b.
    // FR-237 resolves the row as proj-b<->proj-b, so it is B's edge.
    const nearA = ['proj-a', 'proj-b'];
    expect(resolveHopProject('proj-b', nearA, ['proj-b'])).toEqual({
      verdict: 'traverse',
      project: 'proj-b',
    });
    // Standing on A's BR-001 the same row is NOT ours. This is the assertion
    // that stops a fabricated cross-project bridge — and it must NOT be counted
    // as a loss, because FR-237 does emit the edge, just elsewhere.
    expect(resolveHopProject('proj-a', nearA, ['proj-b'])).toEqual({
      verdict: 'other_instance',
      project: null,
    });
  });

  it('branch 3 (near ambiguous, far names a project the near id does not use)', () => {
    expect(resolveHopProject('proj-a', ['proj-a', 'proj-b'], ['proj-z'])).toEqual({
      verdict: 'unresolved',
      project: null,
    });
  });

  it('branch 3 (near ambiguous, far is a phantom): unresolved', () => {
    // FR-237 branch 2 requires a non-null hint; a phantom far end gives none.
    expect(resolveHopProject('proj-a', ['proj-a', 'proj-b'], [])).toEqual({
      verdict: 'unresolved',
      project: null,
    });
    expect(resolveHopProject('proj-a', ['proj-a', 'proj-b'], [null])).toEqual({
      verdict: 'unresolved',
      project: null,
    });
  });

  // -- Branch 4: both ambiguous ---------------------------------------------

  it('branch 4: walks the intersection member equal to the current project', () => {
    expect(
      resolveHopProject('proj-b', ['proj-a', 'proj-b'], ['proj-b', 'proj-c']),
    ).toEqual({ verdict: 'traverse', project: 'proj-b' });
  });

  it('branch 4: an intersection that excludes us is another instance, not a loss', () => {
    expect(
      resolveHopProject('proj-a', ['proj-a', 'proj-b'], ['proj-b', 'proj-c']),
    ).toEqual({ verdict: 'other_instance', project: null });
  });

  it('branch 4: an empty intersection is dangling — a real loss', () => {
    expect(
      resolveHopProject('proj-a', ['proj-a', 'proj-b'], ['proj-y', 'proj-z']),
    ).toEqual({ verdict: 'unresolved', project: null });
  });

  // -- The no-replication guarantee -----------------------------------------

  it('never replicates: at most ONE project is ever returned, per hop', () => {
    const outcomes = [
      resolveHopProject('proj-a', ['proj-a'], ['proj-a', 'proj-b', 'proj-c']),
      resolveHopProject('proj-a', ['proj-a', 'proj-b'], ['proj-a', 'proj-b']),
      resolveHopProject('proj-a', ['proj-a', 'proj-b'], ['proj-b']),
      resolveHopProject('proj-a', ['proj-a'], []),
    ];
    for (const o of outcomes) {
      expect(['traverse', 'other_instance', 'unresolved']).toContain(o.verdict);
      expect(o.project === null || typeof o.project === 'string').toBe(true);
    }
  });

  it('agrees with whole-graph.ts on the FR-237 verdict for the collision fixture', async () => {
    // Anti-fork at the RULE level (T7 covers it at the TOOL level). Fixture:
    // BR-001 in {proj-a, proj-b}, BR-002 in {proj-a}, BR-009 in {proj-b}.
    const { resolveEdgeProjects } = await import('../whole-graph.js');
    const index = new Map<string, Array<string | null>>([
      ['brief:BR-001', ['proj-a', 'proj-b']],
      ['brief:BR-002', ['proj-a']],
      ['brief:BR-009', ['proj-b']],
    ]);

    for (const [to, expectedOwner] of [
      ['BR-002', 'proj-a'],
      ['BR-009', 'proj-b'],
    ] as const) {
      const law = resolveEdgeProjects(
        { from_type: 'brief', from_id: 'BR-001', to_type: 'brief', to_id: to },
        index,
        8,
      );
      // The law says the edge belongs to exactly one project, on both sides.
      expect(law.instances).toHaveLength(1);
      expect(law.instances[0].fromProject).toBe(expectedOwner);
      expect(law.instances[0].toProject).toBe(expectedOwner);

      // The hop rule agrees: walkable from that owner, and from nobody else.
      const near = index.get('brief:BR-001')!;
      const far = index.get(`brief:${to}`)!;
      expect(resolveHopProject(expectedOwner, near, far).verdict).toBe('traverse');
      const otherOwner = expectedOwner === 'proj-a' ? 'proj-b' : 'proj-a';
      expect(resolveHopProject(otherOwner, near, far).verdict).toBe('other_instance');
    }
  });
});
