/**
 * Graph Traversal Integration Tests (FR-113)
 *
 * Boots the edges component against an in-memory DB and verifies:
 *   1. The 6 MCP tools (3 CRUD + 3 traversal) are registered
 *   2. edge.removed event is emitted on igris_edge_remove
 *   3. Subgraph cache is invalidated by edge.created and edge.removed events
 *   4. Performance benchmarks against synthetic 500-edge graph
 *   5. Smoke benchmark against real igris-ai DB if available
 *
 * @module engine/__tests__/graph-traversal.integration.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../db.js';
import { createEdgesComponent } from '../components/edges/index.js';
import { createEventBus } from '../bus.js';
import { edgeMigrations } from '../components/edges/schema.js';
import { _resetTraversalState } from '../components/edges/traversal.js';
import type { ComponentContext, EventBus } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  for (const migration of edgeMigrations) {
    db.exec(migration.sql);
  }
  // Label tables so resolveLabels has somewhere to look. BR-078 T7 compares
  // against igris_graph_brain, whose loaders select a wider column set — a
  // narrower shape here makes buildBrainGraph degrade to an empty graph and the
  // consistency assertion would pass vacuously, so these carry the real columns.
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_status (
      project TEXT NOT NULL, brief_id TEXT NOT NULL, title TEXT NOT NULL,
      brief_type TEXT, status TEXT, priority TEXT, effort TEXT, phase TEXT,
      updated_at TEXT,
      PRIMARY KEY (project, brief_id)
    );
    CREATE TABLE IF NOT EXISTS learnings (
      id INTEGER PRIMARY KEY, project TEXT, title TEXT, content TEXT,
      category TEXT, scope TEXT, confidence REAL, source_brief TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY, project TEXT, message TEXT,
      occurrence_count INTEGER, scope TEXT, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY, project TEXT, summary TEXT,
      brief_id TEXT, phase TEXT, started_at TEXT, ended_at TEXT
    );
  `);
  return db;
}

function makeCtx(bus: EventBus): ComponentContext {
  return {
    storage: {} as unknown as ComponentContext['storage'],
    bus,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    config: {},
  };
}

interface ToolResultLike {
  content: { text: string }[];
  isError?: boolean;
}

function parseResult<T>(r: ToolResultLike): T {
  return JSON.parse(r.content[0].text) as T;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe('FR-113 graph traversal — MCP roundtrip', () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    bus = createEventBus();
    _resetTraversalState();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // FR-237 added igris_graph_brain (whole-brain graph data layer), 11 -> 12.
  it('exposes 12 MCP tools (3 edge CRUD + 3 traversal + 4 node tools + 1 visualization + 1 whole-brain)', () => {
    const comp = createEdgesComponent();
    const tools = comp.tools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'igris_brief_graph_render',
      'igris_edge_create',
      'igris_edge_list',
      'igris_edge_remove',
      'igris_graph_brain',
      'igris_graph_dashboard',
      'igris_graph_neighbors',
      'igris_graph_node_create',
      'igris_graph_node_get',
      'igris_graph_path',
      'igris_graph_search',
      'igris_graph_subgraph',
    ]);
  });

  it('reports version 1.5.0 (BR-078 bump — project-qualified traversal)', () => {
    const comp = createEdgesComponent();
    expect(comp.version).toBe('1.5.0');
  });

  // -------------------------------------------------------------------------
  // BR-078 T7 — cross-tool consistency (the anti-fork mechanism)
  // -------------------------------------------------------------------------
  //
  // `node-project.ts` re-implements FR-237's resolution rule in its degenerate
  // one-endpoint-fixed form rather than importing `resolveEdgeProjects` (whose
  // signature is edge-row-shaped, whose ProjectIndex costs a whole-brain load,
  // and which can return replicas traversal must never produce). This test —
  // not an import — is what stops the two implementations drifting into two
  // different truths about the same graph.
  it('BR-078 T7: igris_graph_neighbors agrees with igris_graph_brain on a collision fixture', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    // proj-a and proj-b BOTH have a BR-001. One edge is really A's, one is
    // really B's, and entity_edges cannot tell them apart.
    const insBrief = db.prepare(
      'INSERT INTO brief_status (project, brief_id, title) VALUES (?,?,?)',
    );
    insBrief.run('proj-a', 'BR-001', "A's BR-001");
    insBrief.run('proj-b', 'BR-001', "B's BR-001");
    insBrief.run('proj-a', 'BR-002', "A's BR-002");
    insBrief.run('proj-b', 'BR-009', "B's BR-009");

    const create = comp.tools().find((t) => t.name === 'igris_edge_create')!;
    for (const to of ['BR-002', 'BR-009']) {
      create.handler({
        from_type: 'brief',
        from_id: 'BR-001',
        to_type: 'brief',
        to_id: to,
        edge_type: 'depends_on',
      });
    }

    const neighbors = comp.tools().find((t) => t.name === 'igris_graph_neighbors')!;
    const nb = parseResult<{
      neighbors: Array<{ type: string; id: string; project: string | null }>;
    }>(
      neighbors.handler({
        node_type: 'brief',
        node_id: 'BR-001',
        node_project: 'proj-a',
        depth: 1,
        direction: 'both',
      }),
    );

    const brainTool = comp.tools().find((t) => t.name === 'igris_graph_brain')!;
    const brain = parseResult<{
      nodes: Array<{ key: string; type: string; id: string; project: string | null }>;
      edges: Array<{ from: string; to: string }>;
      degraded: { reason: string | null };
    }>(brainTool.handler({ project: 'proj-a' }));

    // Guard against a vacuous pass: an empty/degraded whole-brain graph would
    // make every "is a subset of" assertion below trivially true.
    expect(brain.degraded.reason).toBeNull();
    expect(brain.nodes.length).toBeGreaterThan(0);
    expect(nb.neighbors.length).toBeGreaterThan(0);

    // 1. Every neighbour the traversal returned exists as a node in the SAME
    //    (type, project, id) identity in the whole-brain graph.
    for (const n of nb.neighbors) {
      const match = brain.nodes.find(
        (bn) => bn.type === n.type && bn.id === n.id && bn.project === n.project,
      );
      expect(match, `whole-brain graph is missing ${n.type}/${n.project}/${n.id}`).toBeTruthy();
    }

    // 2. Every neighbour is in the depth-1 neighbourhood of A's BR-001 there.
    //    SCOPE: this holds for THIS fixture, whose edges are all branch 2/3
    //    (max |P| = 2 on one endpoint only, so the both-ambiguous branch 4 is
    //    unreachable here). It is NOT a universal — an edge with
    //    |A ∩ C| > max_edge_replicas is walked by traversal and dropped by
    //    igris_graph_brain, deliberately. Branch 4 is covered on both sides of
    //    the cap by the two tests below; do not generalise this assertion.
    const seedKey = brain.nodes.find(
      (bn) => bn.type === 'brief' && bn.id === 'BR-001' && bn.project === 'proj-a',
    )!.key;
    const adjacentKeys = new Set<string>();
    for (const e of brain.edges) {
      if (e.from === seedKey) adjacentKeys.add(e.to);
      if (e.to === seedKey) adjacentKeys.add(e.from);
    }
    for (const n of nb.neighbors) {
      const key = brain.nodes.find(
        (bn) => bn.type === n.type && bn.id === n.id && bn.project === n.project,
      )!.key;
      expect(adjacentKeys.has(key), `${n.id} is not adjacent to the seed in igris_graph_brain`).toBe(
        true,
      );
    }

    // 3. Neither tool invents a cross-project edge: B's BR-009 is absent from
    //    the traversal, and no proj-a edge in the whole-brain graph touches it.
    expect(nb.neighbors.map((n) => n.id)).not.toContain('BR-009');
    const bKey = brain.nodes.find((bn) => bn.id === 'BR-009' && bn.project === 'proj-b')?.key;
    if (bKey) {
      expect(brain.edges.some((e) => e.from === seedKey && e.to === bKey)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // BR-078 — branch 4 cross-tool coverage (warden r1 M-1)
  // -------------------------------------------------------------------------
  //
  // T7 above reaches only branches 2/3: its fixture maxes out at |P| = 2 on ONE
  // endpoint, so `resolveEdgeProjects` never takes the both-ambiguous path.
  // These two tests are the branch-4 coverage that was missing, and they
  // bracket the replica cap from both sides.

  /** Put `briefId` in every one of `projects`, so |P(briefId)| = projects.length. */
  function seedInProjects(briefId: string, projects: string[]): void {
    const ins = db.prepare(
      'INSERT INTO brief_status (project, brief_id, title) VALUES (?,?,?)',
    );
    for (const p of projects) ins.run(p, briefId, `${briefId} in ${p}`);
  }

  it('BR-078 branch 4 UNDER the cap: neighbors and igris_graph_brain agree', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    // |A ∩ C| = 2 <= max_edge_replicas (8) -> whole-graph REPLICATES, one
    // strictly intra-project instance per shared project.
    seedInProjects('BR-100', ['p1', 'p2']);
    seedInProjects('BR-200', ['p1', 'p2']);
    comp.tools().find((t) => t.name === 'igris_edge_create')!.handler({
      from_type: 'brief', from_id: 'BR-100', to_type: 'brief', to_id: 'BR-200',
      edge_type: 'depends_on',
    });

    const nb = parseResult<{ neighbors: Array<{ id: string; project: string | null }> }>(
      comp.tools().find((t) => t.name === 'igris_graph_neighbors')!.handler({
        node_type: 'brief', node_id: 'BR-100', node_project: 'p1', depth: 1, direction: 'both',
      }),
    );
    const brain = parseResult<{
      nodes: Array<{ key: string; type: string; id: string; project: string | null }>;
      edges: Array<{ from: string; to: string; resolution: string }>;
      edge_resolution: { replicated_sources: number; over_replicated: number };
      degraded: { reason: string | null };
    }>(comp.tools().find((t) => t.name === 'igris_graph_brain')!.handler({}));

    expect(brain.degraded.reason).toBeNull();
    // The fixture really does exercise the replicating branch.
    expect(brain.edge_resolution.replicated_sources).toBe(1);
    expect(brain.edge_resolution.over_replicated).toBe(0);

    // Traversal walks it, staying in p1.
    expect(nb.neighbors).toEqual([{ id: 'BR-200', project: 'p1' }].map((x) => expect.objectContaining(x)));

    // ...and the whole-brain graph HAS that exact edge. Agreement.
    const keyOf = (id: string, project: string): string =>
      brain.nodes.find((n) => n.type === 'brief' && n.id === id && n.project === project)!.key;
    expect(
      brain.edges.some((e) => e.from === keyOf('BR-100', 'p1') && e.to === keyOf('BR-200', 'p1')),
    ).toBe(true);
  });

  it('BR-078 branch 4 OVER the cap: the divergence is DELIBERATE and pinned here', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    // |A ∩ C| = 10 > max_edge_replicas (8) -> whole-graph drops the edge for
    // EVERY project (`over_replicated`), while traversal still walks it.
    const projects = Array.from({ length: 10 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);
    seedInProjects('BR-300', projects);
    seedInProjects('BR-400', projects);
    comp.tools().find((t) => t.name === 'igris_edge_create')!.handler({
      from_type: 'brief', from_id: 'BR-300', to_type: 'brief', to_id: 'BR-400',
      edge_type: 'depends_on',
    });

    const nb = parseResult<{ neighbors: Array<{ id: string; project: string | null }> }>(
      comp.tools().find((t) => t.name === 'igris_graph_neighbors')!.handler({
        node_type: 'brief', node_id: 'BR-300', node_project: 'p01', depth: 1, direction: 'both',
      }),
    );
    const brainTool = comp.tools().find((t) => t.name === 'igris_graph_brain')!;
    const brain = parseResult<{
      nodes: Array<{ key: string; type: string; id: string; project: string | null }>;
      edges: Array<{ from: string; to: string }>;
      edge_resolution: { over_replicated: number; over_replicated_edge_ids: number[] };
    }>(brainTool.handler({}));

    // whole-graph really did drop it, for everyone.
    expect(brain.edge_resolution.over_replicated).toBe(1);
    expect(brain.edges).toHaveLength(0);

    // Traversal DOES return the neighbour. This assertion is the decision made
    // executable: the replica cap is a replication-noise control for the
    // whole-brain payload, and traversal emits at most one instance per hop, so
    // it is deliberately not modelled here. Applying it would mean "the more
    // projects share an id, the fewer neighbours you get".
    expect(nb.neighbors.map((n) => `${n.project}/${n.id}`)).toEqual(['p01/BR-400']);

    // The divergence, stated outright so neither side can be silently
    // "corrected" into the other later.
    const seedKey = brain.nodes.find(
      (n) => n.type === 'brief' && n.id === 'BR-300' && n.project === 'p01',
    )!.key;
    expect(brain.edges.some((e) => e.from === seedKey)).toBe(false);

    // ...and it is PURELY the cap: raise it above |A ∩ C| and the two agree
    // again. This is what proves the deviation is one parameter, not a
    // different rule.
    const raised = parseResult<{
      nodes: Array<{ key: string; type: string; id: string; project: string | null }>;
      edges: Array<{ from: string; to: string }>;
      edge_resolution: { over_replicated: number; replicated_sources: number };
    }>(brainTool.handler({ max_edge_replicas: 16 }));
    expect(raised.edge_resolution.over_replicated).toBe(0);
    expect(raised.edge_resolution.replicated_sources).toBe(1);
    const rKey = (id: string, project: string): string =>
      raised.nodes.find((n) => n.type === 'brief' && n.id === id && n.project === project)!.key;
    expect(
      raised.edges.some((e) => e.from === rKey('BR-300', 'p01') && e.to === rKey('BR-400', 'p01')),
    ).toBe(true);
  });

  it('declares edge.removed emit and self-listens on edge.created/edge.removed', () => {
    const comp = createEdgesComponent();
    const events = comp.events();
    expect(events.emits.map((e) => e.name).sort()).toEqual(['edge.created', 'edge.removed']);
    const listenNames = events.listens.map((l) => l.name).sort();
    expect(listenNames).toContain('brief.created');
    expect(listenNames).toContain('edge.created');
    expect(listenNames).toContain('edge.removed');
  });

  it('emits edge.removed when igris_edge_remove succeeds', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    const create = comp.tools().find((t) => t.name === 'igris_edge_create')!;
    const created = parseResult<{ id: number }>(
      create.handler({
        from_type: 'brief',
        from_id: 'A',
        to_type: 'brief',
        to_id: 'B',
        edge_type: 'depends_on',
      }) as ToolResultLike,
    );

    const removedEvents: Record<string, unknown>[] = [];
    bus.on('edge.removed', (p) => removedEvents.push(p.data));

    const remove = comp.tools().find((t) => t.name === 'igris_edge_remove')!;
    remove.handler({ id: created.id });

    expect(removedEvents).toHaveLength(1);
    expect(removedEvents[0].id).toBe(created.id);
    expect(removedEvents[0].source).toBe('tool');

    comp.destroy();
  });

  it('subgraph cache is invalidated when edge.created fires', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    const tools = comp.tools();
    const create = tools.find((t) => t.name === 'igris_edge_create')!;
    const subgraph = tools.find((t) => t.name === 'igris_graph_subgraph')!;

    create.handler({
      from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'B',
      edge_type: 'related_to',
    });

    // Warm cache
    const r1 = parseResult<{ cached: boolean }>(
      subgraph.handler({ seed_node_type: 'brief', seed_node_id: 'A' }) as ToolResultLike,
    );
    expect(r1.cached).toBe(false);

    // Hit cache
    const r2 = parseResult<{ cached: boolean }>(
      subgraph.handler({ seed_node_type: 'brief', seed_node_id: 'A' }) as ToolResultLike,
    );
    expect(r2.cached).toBe(true);

    // Mutate via tool — should invalidate
    create.handler({
      from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'C',
      edge_type: 'related_to',
    });

    const r3 = parseResult<{ cached: boolean; nodes: unknown[] }>(
      subgraph.handler({ seed_node_type: 'brief', seed_node_id: 'A' }) as ToolResultLike,
    );
    expect(r3.cached).toBe(false);
    expect(r3.nodes).toHaveLength(3); // A, B, C

    comp.destroy();
  });

  it('subgraph cache is invalidated when edge.removed fires', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    const tools = comp.tools();
    const create = tools.find((t) => t.name === 'igris_edge_create')!;
    const remove = tools.find((t) => t.name === 'igris_edge_remove')!;
    const subgraph = tools.find((t) => t.name === 'igris_graph_subgraph')!;

    const created = parseResult<{ id: number }>(
      create.handler({
        from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'B',
        edge_type: 'depends_on',
      }) as ToolResultLike,
    );

    subgraph.handler({ seed_node_type: 'brief', seed_node_id: 'A' });
    const cached = parseResult<{ cached: boolean }>(
      subgraph.handler({ seed_node_type: 'brief', seed_node_id: 'A' }) as ToolResultLike,
    );
    expect(cached.cached).toBe(true);

    remove.handler({ id: created.id });

    const fresh = parseResult<{ cached: boolean }>(
      subgraph.handler({ seed_node_type: 'brief', seed_node_id: 'A' }) as ToolResultLike,
    );
    expect(fresh.cached).toBe(false);

    comp.destroy();
  });

  it('init/destroy cleans up bus listeners', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));
    comp.destroy();
    // After destroy, emitting an event should not crash and not invoke the handler.
    expect(() => bus.emit('edge.created', {})).not.toThrow();
    expect(() => bus.emit('edge.removed', {})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Performance benchmarks
// ---------------------------------------------------------------------------

describe('FR-113 graph traversal — performance', () => {
  let db: Database.Database;

  // TD-131: histogram constants for warm-cache P95 stability.
  // Sentinel observed 7.93ms P95 on pre-TD-126 baseline (5+ runs, dev laptop).
  // 100 samples + 5 warm-up iters drops scheduler-noise impact below the
  // architecturally-recorded threshold. If this still flakes after the
  // forger's 5-consecutive-runs validation, bump WARM_CACHE_P95_MS to 10.
  const WARM_CACHE_P95_MS = 5;
  const WARM_CACHE_SAMPLES = 100;
  const WARM_CACHE_WARMUP_ITERS = 5;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    _resetTraversalState();

    // Build a synthetic graph: 200 nodes, ~500 edges, scale-free-ish.
    // Seed a small ring then attach new nodes preferentially to high-degree
    // vertices.
    const NODE_COUNT = 200;
    const EDGE_COUNT = 500;
    const nodes = Array.from({ length: NODE_COUNT }, (_, i) => `N-${i}`);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO entity_edges
         (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const txn = db.transaction(() => {
      for (let i = 0; i < EDGE_COUNT; i++) {
        const a = nodes[Math.floor(Math.random() * NODE_COUNT)];
        let b = nodes[Math.floor(Math.random() * NODE_COUNT)];
        if (a === b) b = nodes[(nodes.indexOf(b) + 1) % NODE_COUNT];
        insert.run('brief', a, 'brief', b, 'related_to', 1.0, 'observed', '{}');
      }
    });
    txn();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('neighbors(depth=2) P95 < 100ms over 50 runs', async () => {
    const { handleGraphNeighbors } = await import('../components/edges/traversal.js');
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      handleGraphNeighbors({
        node_type: 'brief',
        node_id: `N-${Math.floor(Math.random() * 200)}`,
        depth: 2,
        direction: 'both',
      });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    // eslint-disable-next-line no-console
    console.log(`[bench] neighbors(depth=2) P95: ${p95.toFixed(2)}ms (median ${samples[25].toFixed(2)}ms)`);
    expect(p95).toBeLessThan(100);
  });

  it('path(max_depth=5) P95 < 50ms over 50 runs', async () => {
    const { handleGraphPath } = await import('../components/edges/traversal.js');
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const a = Math.floor(Math.random() * 200);
      const b = Math.floor(Math.random() * 200);
      const start = performance.now();
      handleGraphPath({
        from_type: 'brief',
        from_id: `N-${a}`,
        to_type: 'brief',
        to_id: `N-${b}`,
        max_depth: 5,
      });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    // eslint-disable-next-line no-console
    console.log(`[bench] path(max_depth=5) P95: ${p95.toFixed(2)}ms (median ${samples[25].toFixed(2)}ms)`);
    expect(p95).toBeLessThan(50);
  });

  it('subgraph(max_nodes=20) cold P95 < 100ms over 50 runs', async () => {
    const { handleGraphSubgraph, invalidateSubgraphCache } = await import('../components/edges/traversal.js');
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      invalidateSubgraphCache(); // ensure cold
      const start = performance.now();
      handleGraphSubgraph({
        seed_node_type: 'brief',
        seed_node_id: `N-${Math.floor(Math.random() * 200)}`,
        max_nodes: 20,
      });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    // eslint-disable-next-line no-console
    console.log(`[bench] subgraph(max_nodes=20) cold P95: ${p95.toFixed(2)}ms (median ${samples[25].toFixed(2)}ms)`);
    expect(p95).toBeLessThan(100);
  });

  it(`subgraph(max_nodes=20) warm cache P95 < ${WARM_CACHE_P95_MS}ms`, async () => {
    const { handleGraphSubgraph } = await import('../components/edges/traversal.js');
    // Prime cache with the seed we'll measure.
    handleGraphSubgraph({
      seed_node_type: 'brief',
      seed_node_id: 'N-0',
      max_nodes: 20,
    });

    // Warm-up: discard the first WARM_CACHE_WARMUP_ITERS to settle V8
    // inline caches and SQLite statement caches before the measured loop.
    for (let i = 0; i < WARM_CACHE_WARMUP_ITERS; i++) {
      handleGraphSubgraph({
        seed_node_type: 'brief',
        seed_node_id: 'N-0',
        max_nodes: 20,
      });
    }

    const samples: number[] = [];
    for (let i = 0; i < WARM_CACHE_SAMPLES; i++) {
      const start = performance.now();
      handleGraphSubgraph({
        seed_node_type: 'brief',
        seed_node_id: 'N-0',
        max_nodes: 20,
      });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    const median = samples[Math.floor(samples.length * 0.5)];
    // eslint-disable-next-line no-console
    console.log(
      `[bench] subgraph warm-cache P95: ${p95.toFixed(2)}ms (median ${median.toFixed(2)}ms, n=${WARM_CACHE_SAMPLES})`,
    );
    expect(p95).toBeLessThan(WARM_CACHE_P95_MS);
  });
});

// ---------------------------------------------------------------------------
// Real DB smoke benchmark (skipped if absent)
// ---------------------------------------------------------------------------

describe('FR-113 graph traversal — real DB smoke', () => {
  const REAL_DB_PATH = join(homedir(), '.igris', 'memory', 'knowledge.db');
  const haveDb = existsSync(REAL_DB_PATH);

  /**
   * BR-078: pick a seed AND the project qualifier it needs.
   *
   * These smoke tests seed on `entity_edges LIMIT 1`, which on the live brain
   * is a brief whose id exists in many projects. Pre-BR-078 that call silently
   * fused them; it now returns the ambiguity error, so an unqualified call is
   * no longer a valid smoke. Resolving the project here is what a real caller
   * does, and it keeps the benchmark measuring the traversal rather than an
   * early error return.
   */
  function pickSeed(
    realDb: Database.Database,
  ): { type: string; id: string; project?: string } | undefined {
    const seed = realDb
      .prepare('SELECT from_type, from_id FROM entity_edges LIMIT 1')
      .get() as { from_type: string; from_id: string } | undefined;
    if (!seed) return undefined;

    let project: string | undefined;
    if (seed.from_type === 'brief') {
      const rows = realDb
        .prepare('SELECT DISTINCT project FROM brief_status WHERE brief_id = ? ORDER BY project')
        .all(seed.from_id) as Array<{ project: string }>;
      if (rows.length > 1) project = rows[0].project;
    }
    return { type: seed.from_type, id: seed.from_id, ...(project ? { project } : {}) };
  }

  it.skipIf(!haveDb)('runs neighbors against real igris-ai DB without throwing', async () => {
    const realDb = new Database(REAL_DB_PATH, { readonly: true });
    try {
      vi.mocked(getDb).mockReturnValue(realDb as unknown as ReturnType<typeof getDb>);
      _resetTraversalState();

      const { handleGraphNeighbors } = await import('../components/edges/traversal.js');

      // Pick a known seed: the first edge's from_type/from_id, qualified.
      const seed = pickSeed(realDb);

      if (!seed) {
        // eslint-disable-next-line no-console
        console.log('[bench] real DB has no edges — skipping smoke');
        return;
      }

      const start = performance.now();
      const result = handleGraphNeighbors({
        node_type: seed.type,
        node_id: seed.id,
        ...(seed.project ? { node_project: seed.project } : {}),
        depth: 2,
        direction: 'both',
      });
      const elapsed = performance.now() - start;
      // eslint-disable-next-line no-console
      console.log(
        `[bench] real DB neighbors(depth=2) from ${seed.type}:${seed.project ?? '-'}:${seed.id} took ${elapsed.toFixed(2)}ms`,
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text) as {
        neighbors: unknown[];
        unresolved_hops: number;
      };
      // BR-078: the residual counter is on every response, real data included.
      expect(typeof parsed.unresolved_hops).toBe('number');
      // eslint-disable-next-line no-console
      console.log(
        `[bench] real DB returned ${parsed.neighbors.length} neighbors, unresolved_hops=${parsed.unresolved_hops}`,
      );
    } finally {
      realDb.close();
    }
  });

  it.skipIf(!haveDb)('runs subgraph against real igris-ai DB without throwing', async () => {
    const realDb = new Database(REAL_DB_PATH, { readonly: true });
    try {
      vi.mocked(getDb).mockReturnValue(realDb as unknown as ReturnType<typeof getDb>);
      _resetTraversalState();

      const { handleGraphSubgraph } = await import('../components/edges/traversal.js');

      const seed = pickSeed(realDb);
      if (!seed) return;

      const start = performance.now();
      const result = handleGraphSubgraph({
        seed_node_type: seed.type,
        seed_node_id: seed.id,
        ...(seed.project ? { seed_node_project: seed.project } : {}),
        max_nodes: 20,
      });
      const elapsed = performance.now() - start;
      // eslint-disable-next-line no-console
      console.log(`[bench] real DB subgraph(20) took ${elapsed.toFixed(2)}ms`);

      expect(result.isError).toBeUndefined();
    } finally {
      realDb.close();
    }
  });
});
