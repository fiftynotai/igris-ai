/**
 * FR-237 — whole-brain graph builder tests.
 *
 * The builder is PURE (takes a `db` param), so this file injects an in-memory
 * database directly and never calls `vi.mock`. The module mock for `db.js`
 * lives in `whole-graph-tool.test.ts` so it cannot leak into this suite.
 *
 * Placement: vitest under `edges/__tests__/`, co-located with the component,
 * matching `graph-dashboard.test.ts` / `visualization.test.ts`. Per
 * `coding_guidelines` §12 "The two bats suites (TD-303)", `test/*.test.bash`
 * is the repo shell/script suite and `cli/tests/integration/*.bats` drives the
 * compiled CLI — FR-237 adds neither, so neither bats suite applies.
 *
 * @module engine/components/edges/__tests__/whole-graph.test
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { edgeMigrations } from '../schema.js';
import { VALID_EDGE_TYPES } from '../handlers.js';
import { buildBrainGraph, type BrainGraph } from '../whole-graph.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Column sets mirror the live brain schema (verified against knowledge.db). */
const KNOWLEDGE_TABLES: Record<string, string> = {
  brief_status: `
    CREATE TABLE brief_status (
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
    CREATE UNIQUE INDEX idx_brief_status_unique ON brief_status(project, brief_id);`,
  learnings: `
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      scope TEXT DEFAULT 'local',
      source_brief TEXT DEFAULT '',
      confidence REAL DEFAULT 0.8,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      review_status TEXT NOT NULL DEFAULT 'approved'
    );`,
  goals: `
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL UNIQUE,
      project_slug TEXT,
      title TEXT NOT NULL,
      description TEXT,
      outcome TEXT NOT NULL DEFAULT '',
      deadline TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      priority TEXT NOT NULL DEFAULT 'P2-Medium',
      achieved_at TEXT
    );`,
  errors: `
    CREATE TABLE errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      fingerprint TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      scope TEXT DEFAULT 'local',
      occurrence_count INTEGER DEFAULT 1,
      resolved_at TEXT
    );`,
  sessions: `
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT,
      phase TEXT,
      summary TEXT,
      started_at TEXT,
      ended_at TEXT
    );`,
};

/**
 * Build an in-memory brain. `omit` drops tables so the degraded-brain path can
 * be exercised; `entity_edges` + `graph_nodes` always come from edgeMigrations.
 */
function createTestDb(omit: string[] = []): Database.Database {
  const db = new Database(':memory:');
  for (const migration of edgeMigrations) db.exec(migration.sql);
  for (const [name, ddl] of Object.entries(KNOWLEDGE_TABLES)) {
    if (omit.includes(name)) continue;
    db.exec(ddl);
  }
  return db;
}

function addBrief(
  db: Database.Database,
  project: string,
  briefId: string,
  extra: Partial<{ title: string; status: string; phase: string }> = {},
): void {
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
     VALUES (?, ?, 'feature', ?, ?, 'P1-High', 'M-Medium', ?, '2026-07-28')`,
  ).run(
    project,
    briefId,
    extra.title ?? `${briefId} in ${project}`,
    extra.status ?? 'Open',
    extra.phase ?? 'BUILDING',
  );
}

function addLearning(
  db: Database.Database,
  project: string,
  title: string,
  extra: Partial<{ scope: string; reviewStatus: string; sourceBrief: string }> = {},
): number {
  const info = db
    .prepare(
      `INSERT INTO learnings (project, category, title, content, scope, source_brief, confidence, review_status)
       VALUES (?, 'pattern', ?, 'BODY CONTENT THAT MUST NEVER APPEAR IN THE PAYLOAD', ?, ?, 0.9, ?)`,
    )
    .run(
      project,
      title,
      extra.scope ?? 'local',
      extra.sourceBrief ?? '',
      extra.reviewStatus ?? 'approved',
    );
  return Number(info.lastInsertRowid);
}

function addGoal(
  db: Database.Database,
  goalId: string,
  projectSlug: string | null,
  title = 'A goal',
): void {
  db.prepare(
    `INSERT INTO goals (goal_id, project_slug, title, description, outcome, status, priority)
     VALUES (?, ?, ?, 'DESCRIPTION BODY', 'outcome', 'active', 'P1-High')`,
  ).run(goalId, projectSlug, title);
}

function addError(db: Database.Database, project: string, message: string): number {
  const info = db
    .prepare(`INSERT INTO errors (project, message, occurrence_count) VALUES (?, ?, 3)`)
    .run(project, message);
  return Number(info.lastInsertRowid);
}

function addSession(db: Database.Database, project: string, summary: string): number {
  const info = db
    .prepare(`INSERT INTO sessions (project, brief_id, phase, summary) VALUES (?, 'BR-001', 'BUILDING', ?)`)
    .run(project, summary);
  return Number(info.lastInsertRowid);
}

function addConcept(
  db: Database.Database,
  externalId: string,
  label: string,
  project: string | null,
  nodeType = 'concept',
): void {
  db.prepare(
    `INSERT INTO graph_nodes (node_type, node_external_id, label, properties) VALUES (?, ?, ?, ?)`,
  ).run(nodeType, externalId, label, JSON.stringify(project ? { project } : {}));
}

function addEdge(
  db: Database.Database,
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  edgeType: string,
  extra: Partial<{ confidence: number; metadata: Record<string, unknown> }> = {},
): number {
  const info = db
    .prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
       VALUES (?, ?, ?, ?, ?, ?, 'backfill', ?)`,
    )
    .run(
      fromType,
      fromId,
      toType,
      toId,
      edgeType,
      extra.confidence ?? 1.0,
      JSON.stringify(extra.metadata ?? { source: 'backfill' }),
    );
  return Number(info.lastInsertRowid);
}

/** Top-level keys of the payload contract — asserted identical filtered/unfiltered. */
const TOP_LEVEL_KEYS = [
  'generated_at',
  'project',
  'nodes',
  'edges',
  'stats',
  'edge_resolution',
  'truncated',
  'truncation_reason',
  'degraded',
].sort();

function keyOf(g: BrainGraph, k: string): boolean {
  return g.nodes.some((n) => n.key === k);
}

// ---------------------------------------------------------------------------
// 6 / 7 — shape (whole brain and drilled-down are the SAME shape)
// ---------------------------------------------------------------------------

describe('buildBrainGraph — shape', () => {
  function fourTypeFixture(): Database.Database {
    const db = createTestDb();
    addBrief(db, 'proj-a', 'FR-001');
    addBrief(db, 'proj-b', 'FR-002');
    addLearning(db, 'proj-a', 'A learning');
    addGoal(db, 'GL-001', 'proj-a');
    addError(db, 'proj-a', 'boom');
    addConcept(db, 'concept:vector-search', 'Vector search', 'proj-a');
    addConcept(db, 'decision:swap-db', 'Swap the DB', 'proj-a', 'decision');
    return db;
  }

  it('returns a whole-brain graph spanning briefs, learnings, goals and concept nodes', () => {
    const db = fourTypeFixture();
    const g = buildBrainGraph(db, { generatedAt: 'T' });

    expect(Object.keys(g).sort()).toEqual(TOP_LEVEL_KEYS);
    expect(g.project).toBeNull();

    // AC #1 — all four required layers present in one query.
    expect(g.stats.by_node_type.brief).toBe(2);
    expect(g.stats.by_node_type.learning).toBe(1);
    expect(g.stats.by_node_type.goal).toBe(1);
    expect(g.stats.by_node_type.error).toBe(1);
    expect(g.stats.by_node_type.concept).toBe(1);
    expect(g.stats.by_node_type.decision).toBe(1);
    // Adjacency-only type is a declared key with an honest zero.
    expect(g.stats.by_node_type.session).toBe(0);
    expect(g.stats.node_count).toBe(7);
    expect(g.stats.project_count).toBe(2);

    // AC #5 — ALL TEN catalog edge types appear, zeros included.
    for (const t of VALID_EDGE_TYPES) {
      expect(g.stats.by_edge_type[t]).toBe(0);
    }
    expect(Object.keys(g.stats.by_edge_type).sort()).toEqual([...VALID_EDGE_TYPES].sort());

    expect(g.truncated).toBe(false);
    expect(g.degraded.missing_tables).toEqual([]);
    db.close();
  });

  it('never returns body content (the scale strategy, not an oversight)', () => {
    const db = fourTypeFixture();
    const serialized = JSON.stringify(buildBrainGraph(db, { generatedAt: 'T' }));
    expect(serialized).not.toContain('BODY CONTENT THAT MUST NEVER APPEAR');
    expect(serialized).not.toContain('DESCRIPTION BODY');
    db.close();
  });

  it('bounds every unbounded payload term: labels capped, property bag capped', () => {
    const db = createTestDb();
    const longTitle = 'T'.repeat(500);
    addBrief(db, 'proj-a', 'FR-001', { title: longTitle });
    addLearning(db, 'proj-a', longTitle);
    addGoal(db, 'GL-001', 'proj-a', longTitle);
    addError(db, 'proj-a', longTitle);
    addConcept(db, 'concept:long', longTitle, 'proj-a');
    // A free-form operator-supplied property bag far over the cap.
    db.prepare(`UPDATE graph_nodes SET properties = ? WHERE node_external_id = 'concept:long'`)
      .run(JSON.stringify({ project: 'proj-a', blob: 'X'.repeat(8000) }));

    const g = buildBrainGraph(db, { generatedAt: 'T' });

    // Every label from every source table is bounded.
    expect(g.nodes.length).toBeGreaterThan(0);
    for (const n of g.nodes) {
      expect(n.label.length, `${n.type} label unbounded`).toBeLessThanOrEqual(120);
    }
    // The property bag is replaced by a bounded marker that keeps `project`.
    const concept = g.nodes.find((n) => n.type === 'concept')!;
    const props = concept.attrs.properties as Record<string, unknown>;
    expect(props._truncated).toBe(true);
    expect(props.project).toBe('proj-a');
    expect(props.blob).toBeUndefined();
    expect(JSON.stringify(concept.attrs).length).toBeLessThan(2048);
    // A small bag passes through untouched.
    addConcept(db, 'concept:small', 'Small', 'proj-b');
    const g2 = buildBrainGraph(db, { generatedAt: 'T' });
    const small = g2.nodes.find((n) => n.id === 'concept:small')!;
    expect(small.attrs.properties).toEqual({ project: 'proj-b' });
    db.close();
  });

  it('project filter returns the IDENTICAL top-level shape and echoes the slug', () => {
    const db = fourTypeFixture();
    const whole = buildBrainGraph(db, { generatedAt: 'T' });
    const drilled = buildBrainGraph(db, { project: 'proj-a', generatedAt: 'T' });

    expect(Object.keys(drilled).sort()).toEqual(Object.keys(whole).sort());
    expect(Object.keys(drilled.stats).sort()).toEqual(Object.keys(whole.stats).sort());
    expect(Object.keys(drilled.edge_resolution).sort()).toEqual(
      Object.keys(whole.edge_resolution).sort(),
    );
    expect(drilled.project).toBe('proj-a');

    // Only proj-a-owned nodes survive (nothing here is global or adjacent).
    expect(drilled.nodes.every((n) => n.project === 'proj-a')).toBe(true);
    expect(keyOf(drilled, 'brief|proj-b|FR-002')).toBe(false);
    db.close();
  });

  it('node_types narrows the emitted set without a second query', () => {
    const db = fourTypeFixture();
    const g = buildBrainGraph(db, { node_types: ['brief'], generatedAt: 'T' });
    expect(g.nodes.every((n) => n.type === 'brief')).toBe(true);
    expect(Object.keys(g.stats.by_node_type)).toEqual(['brief']);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 8 / 9 / 10 / 11 / 12 — the collision + resolution family
// ---------------------------------------------------------------------------

describe('buildBrainGraph — colliding ids and edge resolution', () => {
  it('COLLIDING-ID: same brief id in two projects stays two nodes with NO edge between them', () => {
    const db = createTestDb();
    addBrief(db, 'proj-a', 'BR-001');
    addBrief(db, 'proj-b', 'BR-001');
    addBrief(db, 'proj-a', 'BR-002');
    addEdge(db, 'brief', 'BR-002', 'brief', 'BR-001', 'parent_of');

    const g = buildBrainGraph(db, { generatedAt: 'T' });

    // Two distinct nodes for the same brief id.
    expect(keyOf(g, 'brief|proj-a|BR-001')).toBe(true);
    expect(keyOf(g, 'brief|proj-b|BR-001')).toBe(true);
    expect(g.nodes.filter((n) => n.id === 'BR-001')).toHaveLength(2);

    // Exactly one edge, strictly inside proj-a.
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].from).toBe('brief|proj-a|BR-002');
    expect(g.edges[0].to).toBe('brief|proj-a|BR-001');
    expect(g.edges[0].resolution).toBe('unique');

    // NO edge touches proj-b's BR-001.
    expect(
      g.edges.some(
        (e) => e.from === 'brief|proj-b|BR-001' || e.to === 'brief|proj-b|BR-001',
      ),
    ).toBe(false);

    expect(g.edge_resolution.unique).toBe(1);
    expect(g.edge_resolution.replicated_sources).toBe(0);
    db.close();
  });

  it('REPLICATION: both endpoints ambiguous with |C| = 2 emits two intra-project instances', () => {
    const db = createTestDb();
    for (const p of ['proj-a', 'proj-b']) {
      addBrief(db, p, 'BR-001');
      addBrief(db, p, 'BR-002');
    }
    const edgeId = addEdge(db, 'brief', 'BR-002', 'brief', 'BR-001', 'parent_of', {
      confidence: 1.0,
    });

    const g = buildBrainGraph(db, { generatedAt: 'T' });

    expect(g.edges).toHaveLength(2);
    expect(g.edges.map((e) => e.id).sort()).toEqual(
      [`${edgeId}#proj-a`, `${edgeId}#proj-b`].sort(),
    );
    for (const e of g.edges) {
      expect(e.resolution).toBe('replicated');
      expect(e.source_edge_id).toBe(edgeId);
      expect(e.confidence).toBe(0.5);
      // Strictly intra-project — replication can never invent a cross-project bridge.
      const fromProj = g.nodes.find((n) => n.key === e.from)!.project;
      const toProj = g.nodes.find((n) => n.key === e.to)!.project;
      expect(fromProj).toBe(toProj);
    }
    // No proj-a -> proj-b bridge.
    expect(
      g.edges.some(
        (e) => e.from === 'brief|proj-a|BR-002' && e.to === 'brief|proj-b|BR-001',
      ),
    ).toBe(false);

    expect(g.edge_resolution.replicated_sources).toBe(1);
    expect(g.edge_resolution.replicas_emitted).toBe(2);
    expect(g.edge_resolution.candidate_count_histogram['2']).toBe(1);
    expect(g.edge_resolution.by_endpoint_pair['brief->brief']).toBe(1);
    db.close();
  });

  it('CAP: |C| beyond max_edge_replicas drops the edge and reports its id', () => {
    const db = createTestDb();
    for (let i = 0; i < 9; i++) {
      addBrief(db, `proj-${i}`, 'BR-001');
      addBrief(db, `proj-${i}`, 'BR-002');
    }
    const edgeId = addEdge(db, 'brief', 'BR-002', 'brief', 'BR-001', 'parent_of');

    const g = buildBrainGraph(db, { maxEdgeReplicas: 8, generatedAt: 'T' });

    expect(g.edges).toHaveLength(0);
    expect(g.edge_resolution.over_replicated).toBe(1);
    expect(g.edge_resolution.over_replicated_edge_ids).toEqual([edgeId]);
    expect(g.edge_resolution.candidate_count_histogram['9']).toBe(1);
    db.close();
  });

  it('OWNER HINT: a fixed endpoint resolves an ambiguous one for free', () => {
    const db = createTestDb();
    addBrief(db, 'proj-a', 'BR-001');
    addBrief(db, 'proj-b', 'BR-001');
    const lid = addLearning(db, 'proj-a', 'Derived from BR-001');
    addEdge(db, 'learning', String(lid), 'brief', 'BR-001', 'derived_from');

    const g = buildBrainGraph(db, { generatedAt: 'T' });

    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].from).toBe(`learning|proj-a|${lid}`);
    expect(g.edges[0].to).toBe('brief|proj-a|BR-001');
    expect(g.edges[0].resolution).toBe('unique');
    expect(g.edge_resolution.unique).toBe(1);
    expect(g.edge_resolution.by_endpoint_pair['learning->brief']).toBe(1);
    db.close();
  });

  it('preserves a LEGITIMATE cross-project edge (both endpoints fixed)', () => {
    const db = createTestDb();
    addBrief(db, 'proj-b', 'BR-009');
    const lid = addLearning(db, 'proj-a', 'Cross-project learning');
    addEdge(db, 'learning', String(lid), 'brief', 'BR-009', 'derived_from');

    const g = buildBrainGraph(db, { generatedAt: 'T' });

    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].from).toBe(`learning|proj-a|${lid}`);
    expect(g.edges[0].to).toBe('brief|proj-b|BR-009');
    expect(g.edges[0].resolution).toBe('unique');
    expect(g.edge_resolution.replicated_sources).toBe(0);
    db.close();
  });

  it('AMBIGUOUS_UNRESOLVED: one-ambiguous with a failing hint emits NOTHING, never a bridge', () => {
    // BR-003 is proj-c-only (fixed); BR-001 is in proj-a and proj-b (ambiguous).
    // The hint cannot fire because proj-c is not in {proj-a, proj-b}. Replicating
    // here would emit proj-c->proj-a AND proj-c->proj-b: two fabricated
    // cross-project bridges from one asserted relationship, at most one real.
    const db = createTestDb();
    addBrief(db, 'proj-a', 'BR-001');
    addBrief(db, 'proj-b', 'BR-001');
    addBrief(db, 'proj-c', 'BR-003');
    addEdge(db, 'brief', 'BR-003', 'brief', 'BR-001', 'blocks');

    const g = buildBrainGraph(db, { generatedAt: 'T' });

    // The whole point: ZERO edges, not a replicated pair.
    expect(g.edges).toHaveLength(0);
    expect(g.edge_resolution.ambiguous_unresolved).toBe(1);
    expect(g.edge_resolution.replicated_sources).toBe(0);
    expect(g.edge_resolution.replicas_emitted).toBe(0);
    // Distinct bucket from dangling — a common project was never required here.
    expect(g.edge_resolution.dangling).toBe(0);
    // All three nodes still exist; only the unresolvable EDGE is withheld.
    expect(g.nodes).toHaveLength(3);
    db.close();
  });

  it('GUARANTEE: no emitted edge is a cross-project bridge unless BOTH endpoints are fixed', () => {
    // Exercises every branch at once and asserts the invariant FR-238/FR-239
    // design against: a replicated instance is ALWAYS intra-project.
    const db = createTestDb();
    addBrief(db, 'proj-a', 'BR-001');
    addBrief(db, 'proj-b', 'BR-001');
    addBrief(db, 'proj-a', 'BR-002');
    addBrief(db, 'proj-b', 'BR-002');
    addBrief(db, 'proj-c', 'BR-003');
    const lid = addLearning(db, 'proj-a', 'L');
    addEdge(db, 'brief', 'BR-002', 'brief', 'BR-001', 'parent_of'); // branch 4 -> replicated x2
    addEdge(db, 'brief', 'BR-003', 'brief', 'BR-001', 'blocks'); // branch 3 -> nothing
    addEdge(db, 'learning', String(lid), 'brief', 'BR-001', 'derived_from'); // branch 2 -> unique
    addEdge(db, 'learning', String(lid), 'brief', 'BR-003', 'related_to'); // branch 1 -> unique, cross-project

    const g = buildBrainGraph(db, { generatedAt: 'T' });
    const proj = (k: string) => g.nodes.find((n) => n.key === k)!.project;

    for (const e of g.edges) {
      if (e.resolution === 'replicated') {
        // A replica can NEVER span projects — this is the guarantee.
        expect(proj(e.from), `replica ${e.id} spans projects`).toBe(proj(e.to));
      }
    }
    // The only cross-project edge present is the branch-1 one, where BOTH
    // endpoints carry a real column and the span is genuine.
    const crossProject = g.edges.filter((e) => proj(e.from) !== proj(e.to));
    expect(crossProject).toHaveLength(1);
    expect(crossProject[0].resolution).toBe('unique');
    expect(crossProject[0].from).toBe(`learning|proj-a|${lid}`);
    expect(crossProject[0].to).toBe('brief|proj-c|BR-003');
    db.close();
  });

  it('counters reconcile: unique + replicated + dangling + ambiguous_unresolved + over_replicated === source_edges', () => {
    const db = createTestDb();
    addBrief(db, 'proj-a', 'BR-001');
    addBrief(db, 'proj-b', 'BR-001');
    addBrief(db, 'proj-a', 'BR-002');
    addBrief(db, 'proj-b', 'BR-002');
    addBrief(db, 'proj-c', 'BR-003');
    addEdge(db, 'brief', 'BR-002', 'brief', 'BR-001', 'parent_of'); // replicated x2
    addEdge(db, 'brief', 'BR-003', 'brief', 'BR-001', 'blocks'); // ambiguous_unresolved

    const g = buildBrainGraph(db, { generatedAt: 'T' });
    const r = g.edge_resolution;
    expect(
      r.unique + r.replicated_sources + r.dangling + r.ambiguous_unresolved + r.over_replicated,
    ).toBe(r.source_edges);
    // Histogram sums to source_edges too.
    const histTotal = Object.values(r.candidate_count_histogram).reduce((a, b) => a + b, 0);
    expect(histTotal).toBe(r.source_edges);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 13 / 14 — edge-type and direction fidelity
// ---------------------------------------------------------------------------

describe('buildBrainGraph — edge type + direction fidelity', () => {
  it('all ten catalog edge types survive the round trip with direction intact', () => {
    const db = createTestDb();
    // One unambiguous brief per edge type endpoint, all in one project.
    for (let i = 0; i < VALID_EDGE_TYPES.length + 1; i++) {
      addBrief(db, 'proj-a', `BR-${String(i).padStart(3, '0')}`);
    }
    VALID_EDGE_TYPES.forEach((t, i) => {
      const from = `BR-${String(i).padStart(3, '0')}`;
      // recurs_with is the one catalog type permitted to self-loop.
      const to = t === 'recurs_with' ? from : `BR-${String(i + 1).padStart(3, '0')}`;
      addEdge(db, 'brief', from, 'brief', to, t);
    });

    const g = buildBrainGraph(db, { generatedAt: 'T' });

    expect(g.edges).toHaveLength(VALID_EDGE_TYPES.length);
    VALID_EDGE_TYPES.forEach((t, i) => {
      const found = g.edges.find((e) => e.type === t);
      expect(found, `edge type ${t} did not survive`).toBeDefined();
      const from = `brief|proj-a|BR-${String(i).padStart(3, '0')}`;
      const to =
        t === 'recurs_with' ? from : `brief|proj-a|BR-${String(i + 1).padStart(3, '0')}`;
      // Direction intact — from/to are NEVER swapped, normalised or coalesced.
      expect(found!.from).toBe(from);
      expect(found!.to).toBe(to);
      expect(g.stats.by_edge_type[t]).toBe(1);
    });
    db.close();
  });

  it('a bidirectional relationship stays TWO edges with opposite direction', () => {
    const db = createTestDb();
    addBrief(db, 'proj-a', 'BR-001');
    addBrief(db, 'proj-a', 'BR-002');
    addEdge(db, 'brief', 'BR-001', 'brief', 'BR-002', 'related_to');
    addEdge(db, 'brief', 'BR-002', 'brief', 'BR-001', 'related_to');

    const g = buildBrainGraph(db, { generatedAt: 'T' });
    expect(g.edges).toHaveLength(2);
    expect(g.stats.by_edge_type.related_to).toBe(2);
    const [a, b] = g.edges;
    expect(a.from).toBe(b.to);
    expect(a.to).toBe(b.from);
    db.close();
  });

  it('excludes soft-deleted edges (parity with igris_edge_list)', () => {
    const db = createTestDb();
    addBrief(db, 'proj-a', 'BR-001');
    addBrief(db, 'proj-a', 'BR-002');
    addEdge(db, 'brief', 'BR-001', 'brief', 'BR-002', 'related_to');
    addEdge(db, 'brief', 'BR-002', 'brief', 'BR-001', 'related_to', {
      metadata: { deleted: true },
    });

    const g = buildBrainGraph(db, { generatedAt: 'T' });
    expect(g.edges).toHaveLength(1);
    expect(g.edge_resolution.source_edges).toBe(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 15 / 16 / 17 — global entities and adjacency-only types
// ---------------------------------------------------------------------------

describe('buildBrainGraph — global entities and adjacency-only types', () => {
  it('a project-less goal is neither dropped nor falsely attributed', () => {
    const db = createTestDb();
    addBrief(db, 'proj-a', 'BR-001');
    addGoal(db, 'GL-001', null, 'A global goal');
    addEdge(db, 'brief', 'BR-001', 'goal', 'GL-001', 'serves_goal');

    const whole = buildBrainGraph(db, { generatedAt: 'T' });
    const goalNode = whole.nodes.find((n) => n.type === 'goal')!;
    expect(goalNode.key).toBe('goal||GL-001');
    expect(goalNode.project).toBeNull();

    // Present in the drilled-down call too, still with no invented owner.
    const drilled = buildBrainGraph(db, { project: 'proj-a', generatedAt: 'T' });
    const drilledGoal = drilled.nodes.find((n) => n.type === 'goal')!;
    expect(drilledGoal).toBeDefined();
    expect(drilledGoal.project).toBeNull();
    expect(drilledGoal.boundary).toBeUndefined();
    expect(drilled.edges).toHaveLength(1);
    db.close();
  });

  it('a scope=global learning is keyed by its OWNING project, scope is a display attr', () => {
    const db = createTestDb();
    const lid = addLearning(db, 'proj-a', 'Global lesson', { scope: 'global' });

    const g = buildBrainGraph(db, { generatedAt: 'T' });
    const node = g.nodes.find((n) => n.type === 'learning')!;
    expect(node.project).toBe('proj-a');
    expect(node.key).toBe(`learning|proj-a|${lid}`);
    expect(node.attrs.scope).toBe('global');
    db.close();
  });

  it('sessions are adjacency-only: present iff an edge references them', () => {
    const db = createTestDb();
    addBrief(db, 'proj-a', 'BR-001');
    const linked = addSession(db, 'proj-a', 'Linked session');
    addSession(db, 'proj-a', 'Unlinked session');
    addEdge(db, 'session', String(linked), 'brief', 'BR-001', 'related_to');

    const g = buildBrainGraph(db, { generatedAt: 'T' });
    const sessions = g.nodes.filter((n) => n.type === 'session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].key).toBe(`session|proj-a|${linked}`);
    expect(sessions[0].phantom).toBeUndefined();
    expect(g.stats.by_node_type.session).toBe(1);
    // The edge kept its session endpoint — never dropped (AC #6).
    expect(g.edges).toHaveLength(1);
    db.close();
  });

  it('boundary nodes are pulled in at depth 1 and flagged', () => {
    const db = createTestDb();
    addBrief(db, 'proj-a', 'FR-100');
    addBrief(db, 'proj-b', 'FR-200');
    addBrief(db, 'proj-b', 'FR-201');
    addEdge(db, 'brief', 'FR-100', 'brief', 'FR-200', 'depends_on');
    addEdge(db, 'brief', 'FR-200', 'brief', 'FR-201', 'depends_on');

    const g = buildBrainGraph(db, { project: 'proj-a', generatedAt: 'T' });
    expect(keyOf(g, 'brief|proj-a|FR-100')).toBe(true);
    // FR-200 is one hop away -> kept, flagged boundary.
    const far = g.nodes.find((n) => n.key === 'brief|proj-b|FR-200')!;
    expect(far.boundary).toBe(true);
    // FR-201 is two hops away -> not kept (boundary nodes do not anchor).
    expect(keyOf(g, 'brief|proj-b|FR-201')).toBe(false);
    expect(g.stats.boundary_node_count).toBe(1);
    expect(g.edges).toHaveLength(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 19 / 20 / 21 / 22 — hygiene, phantoms and degradation
// ---------------------------------------------------------------------------

describe('buildBrainGraph — hygiene and degradation', () => {
  it('excludes non-approved learnings (FR-116 soft-delete parity)', () => {
    const db = createTestDb();
    addLearning(db, 'proj-a', 'Approved');
    addLearning(db, 'proj-a', 'Pending', { reviewStatus: 'pending' });
    addLearning(db, 'proj-a', 'Merged away', { reviewStatus: 'merged' });
    addLearning(db, 'proj-a', 'Superseded', { reviewStatus: 'superseded' });
    addLearning(db, 'proj-a', 'Pruned', { reviewStatus: 'pruned' });

    const g = buildBrainGraph(db, { generatedAt: 'T' });
    expect(g.stats.by_node_type.learning).toBe(1);
    expect(g.nodes.find((n) => n.type === 'learning')!.label).toBe('Approved');
    db.close();
  });

  it('synthesises a phantom node for an endpoint with no backing row', () => {
    const db = createTestDb();
    addBrief(db, 'proj-a', 'BR-001');
    addEdge(db, 'brief', 'BR-001', 'brief', 'BR-GHOST', 'related_to');

    const g = buildBrainGraph(db, { generatedAt: 'T' });
    const ghost = g.nodes.find((n) => n.id === 'BR-GHOST')!;
    expect(ghost).toBeDefined();
    expect(ghost.phantom).toBe(true);
    expect(ghost.project).toBeNull();
    expect(ghost.key).toBe('brief||BR-GHOST');
    expect(g.degraded.phantom_nodes).toBe(1);
    expect(g.edges).toHaveLength(1);
    db.close();
  });

  it('degraded brain (missing tables) returns an empty graph and does NOT throw', () => {
    const db = createTestDb(['brief_status', 'learnings', 'goals', 'errors', 'sessions']);
    let g!: BrainGraph;
    expect(() => {
      g = buildBrainGraph(db, { generatedAt: 'T' });
    }).not.toThrow();

    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.stats.node_count).toBe(0);
    expect(g.degraded.missing_tables).toEqual(
      expect.arrayContaining(['brief_status', 'learnings', 'goals']),
    );
    // Shape is unchanged even when degraded.
    expect(Object.keys(g).sort()).toEqual(TOP_LEVEL_KEYS);
    db.close();
  });

  it('a brain with NO tables at all returns an empty graph without throwing', () => {
    const bare = new Database(':memory:');
    const g = buildBrainGraph(bare, { generatedAt: 'T' });
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.degraded.missing_tables).toContain('entity_edges');
    bare.close();
  });

  it('a fully-migrated but EMPTY brain returns all-zero stats', () => {
    const db = createTestDb();
    const g = buildBrainGraph(db, { generatedAt: 'T' });
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.stats.node_count).toBe(0);
    expect(g.stats.edge_count).toBe(0);
    expect(g.stats.project_count).toBe(0);
    expect(g.edge_resolution.source_edges).toBe(0);
    expect(g.degraded.missing_tables).toEqual([]);
    expect(g.truncated).toBe(false);
    db.close();
  });

  it('omits the approved-only filter on a brain without learnings.review_status', () => {
    const db = createTestDb(['learnings']);
    db.exec(`CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, scope TEXT DEFAULT 'local',
      source_brief TEXT DEFAULT '', confidence REAL DEFAULT 0.8,
      updated_at TEXT DEFAULT '2026-01-01');`);
    db.prepare(
      `INSERT INTO learnings (project, category, title, content) VALUES ('p','pattern','Legacy','x')`,
    ).run();

    const g = buildBrainGraph(db, { generatedAt: 'T' });
    expect(g.stats.by_node_type.learning).toBe(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 16b — the tripwire
// ---------------------------------------------------------------------------

describe('buildBrainGraph — scale tripwire', () => {
  it('truncates deterministically by degree when the node cap is exceeded', () => {
    const db = createTestDb();
    for (let i = 0; i < 10; i++) addBrief(db, 'proj-a', `BR-${String(i).padStart(3, '0')}`);
    // BR-000 is the hub -> highest degree -> survives an aggressive cap.
    for (let i = 1; i < 10; i++) {
      addEdge(db, 'brief', 'BR-000', 'brief', `BR-${String(i).padStart(3, '0')}`, 'related_to');
    }

    const g = buildBrainGraph(db, { maxNodes: 3, generatedAt: 'T' });
    expect(g.truncated).toBe(true);
    expect(g.truncation_reason).toContain('max_nodes 3');
    expect(g.nodes).toHaveLength(3);
    expect(g.nodes[0].key).toBe('brief|proj-a|BR-000');
    // Every surviving edge has both endpoints among the survivors.
    const keys = new Set(g.nodes.map((n) => n.key));
    expect(g.edges.every((e) => keys.has(e.from) && keys.has(e.to))).toBe(true);
    db.close();
  });

  it('stays silent at today\'s brain scale (the tripwire will not fire)', () => {
    const db = createTestDb();
    addBrief(db, 'proj-a', 'BR-001');
    const g = buildBrainGraph(db, { generatedAt: 'T' });
    expect(g.truncated).toBe(false);
    expect(g.truncation_reason).toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 23 / 24 — realistic scale + determinism
// ---------------------------------------------------------------------------

describe('buildBrainGraph — realistic scale and determinism', () => {
  /**
   * Reproduce the measured live-brain collision profile:
   *   35 projects x 50 briefs = 1 750 briefs, 900 learnings, 5 goals,
   *   ~550 edges of which ~70 % carry at least one ambiguous endpoint.
   *   Head ids seeded across 25 / 16 / 15 / 15 / 14 / 13 projects.
   */
  function scaleFixture(): { db: Database.Database; briefCount: number; edgeCount: number } {
    const db = createTestDb();
    const PROJECTS = 35;
    const BRIEFS_PER_PROJECT = 50;
    const HEAD_SPREAD = [25, 16, 15, 15, 14, 13];

    const insertBrief = db.prepare(
      `INSERT OR IGNORE INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
       VALUES (?, ?, 'feature', ?, 'Open', 'P1-High', 'M-Medium', 'BUILDING', '2026-07-28')`,
    );
    const briefIdsByProject: string[][] = [];
    let briefCount = 0;

    const seed = db.transaction(() => {
      for (let p = 0; p < PROJECTS; p++) {
        const project = `proj-${String(p).padStart(2, '0')}`;
        const ids: string[] = [];
        for (let j = 0; j < BRIEFS_PER_PROJECT; j++) {
          let id: string;
          if (j < HEAD_SPREAD.length && p < HEAD_SPREAD[j]) {
            // The steep head — BR-001 in 25 projects, BR-002 in 16, ...
            id = `BR-${String(j + 1).padStart(3, '0')}`;
          } else if (j >= 10 && j < 24) {
            // The long thin tail — ids shared by ~3 projects.
            id = `SH-${(p % 12) * 100 + j}`;
          } else {
            id = `P${p}-${j}`;
          }
          ids.push(id);
          insertBrief.run(project, id, `${id} in ${project}`);
          briefCount++;
        }
        briefIdsByProject.push(ids);
      }
      for (let i = 0; i < 900; i++) {
        addLearning(db, `proj-${String(i % PROJECTS).padStart(2, '0')}`, `Learning ${i}`);
      }
      for (let i = 0; i < 5; i++) addGoal(db, `GL-${i}`, i === 0 ? null : 'proj-00');
    });
    seed();

    // ~550 edges, ~70 % touching at least one ambiguous (head/shared) endpoint.
    // Deduped on the entity_edges UNIQUE tuple — colliding head ids naturally
    // produce the same (from,to,type) from several projects, which is exactly
    // why the live brain holds 424 brief->brief rows over 1 698 briefs.
    const TARGET_EDGES = 550;
    let edgeCount = 0;
    const seen = new Set<string>();
    const seedEdges = db.transaction(() => {
      for (let i = 0; edgeCount < TARGET_EDGES && i < 20_000; i++) {
        const p = i % PROJECTS;
        const ids = briefIdsByProject[p];
        const ambiguous = i % 10 < 7;
        const from = ambiguous ? ids[i % 24] : ids[30 + (i % 20)];
        const to = ambiguous ? ids[(i + 3) % 24] : ids[30 + ((i + 7) % 20)];
        const edgeType = VALID_EDGE_TYPES[i % VALID_EDGE_TYPES.length];
        if (from === to) continue;
        const tuple = `${from}|${to}|${edgeType}`;
        if (seen.has(tuple)) continue;
        seen.add(tuple);
        addEdge(db, 'brief', from, 'brief', to, edgeType);
        edgeCount++;
      }
    });
    seedEdges();

    return { db, briefCount, edgeCount };
  }

  it('handles the measured order of magnitude within budget, tripwire silent', () => {
    const { db, briefCount } = scaleFixture();
    const distinctBriefs = (
      db.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }
    ).c;
    const sourceEdges = (
      db.prepare('SELECT COUNT(*) AS c FROM entity_edges').get() as { c: number }
    ).c;

    const t0 = Date.now();
    const g = buildBrainGraph(db, { generatedAt: 'T' });
    const elapsed = Date.now() - t0;
    const bytes = Buffer.byteLength(JSON.stringify(g), 'utf8');

    // eslint-disable-next-line no-console
    console.log(
      `[FR-237 scale] seeded=${briefCount} briefs (${distinctBriefs} rows), ` +
        `source_edges=${sourceEdges}, nodes=${g.stats.node_count}, edges=${g.stats.edge_count}, ` +
        `replicas=${g.edge_resolution.replicas_emitted}, over_replicated=${g.edge_resolution.over_replicated}, ` +
        `elapsed=${elapsed}ms, payload=${(bytes / 1024).toFixed(1)}KB`,
    );

    expect(elapsed).toBeLessThan(2000);
    expect(g.truncated).toBe(false);
    expect(g.stats.by_node_type.brief).toBe(distinctBriefs);
    expect(g.stats.by_node_type.learning).toBe(900);
    expect(g.stats.by_node_type.goal).toBe(5);
    expect(g.stats.project_count).toBe(35);

    const r = g.edge_resolution;
    expect(r.source_edges).toBe(sourceEdges);
    expect(r.unique + r.replicated_sources + r.dangling + r.over_replicated).toBe(
      r.source_edges,
    );
    db.close();
  });

  it('is deterministic: two consecutive builds are byte-identical', () => {
    const { db } = scaleFixture();
    const a = buildBrainGraph(db, { generatedAt: 'T' });
    const b = buildBrainGraph(db, { generatedAt: 'T' });
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes));
    expect(JSON.stringify(a.edges)).toBe(JSON.stringify(b.edges));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    db.close();
  });
});
