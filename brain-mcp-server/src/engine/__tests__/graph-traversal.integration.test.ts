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
  // Minimal label tables so resolveLabels has somewhere to look.
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_status (
      project TEXT NOT NULL, brief_id TEXT NOT NULL, title TEXT NOT NULL,
      PRIMARY KEY (project, brief_id)
    );
    CREATE TABLE IF NOT EXISTS learnings (id INTEGER PRIMARY KEY, title TEXT, content TEXT);
    CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY, message TEXT);
    CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, summary TEXT);
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

  it('exposes 7 MCP tools (3 CRUD + 3 traversal + 1 visualization)', () => {
    const comp = createEdgesComponent();
    const tools = comp.tools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'igris_brief_graph_render',
      'igris_edge_create',
      'igris_edge_list',
      'igris_edge_remove',
      'igris_graph_neighbors',
      'igris_graph_path',
      'igris_graph_subgraph',
    ]);
  });

  it('reports version 1.2.0 (FR-111 bump)', () => {
    const comp = createEdgesComponent();
    expect(comp.version).toBe('1.2.0');
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

  it.skipIf(!haveDb)('runs neighbors against real igris-ai DB without throwing', async () => {
    const realDb = new Database(REAL_DB_PATH, { readonly: true });
    try {
      vi.mocked(getDb).mockReturnValue(realDb as unknown as ReturnType<typeof getDb>);
      _resetTraversalState();

      const { handleGraphNeighbors } = await import('../components/edges/traversal.js');

      // Pick a known seed: the first edge's from_type/from_id
      const seed = realDb
        .prepare('SELECT from_type, from_id FROM entity_edges LIMIT 1')
        .get() as { from_type: string; from_id: string } | undefined;

      if (!seed) {
        // eslint-disable-next-line no-console
        console.log('[bench] real DB has no edges — skipping smoke');
        return;
      }

      const start = performance.now();
      const result = handleGraphNeighbors({
        node_type: seed.from_type,
        node_id: seed.from_id,
        depth: 2,
        direction: 'both',
      });
      const elapsed = performance.now() - start;
      // eslint-disable-next-line no-console
      console.log(
        `[bench] real DB neighbors(depth=2) from ${seed.from_type}:${seed.from_id} took ${elapsed.toFixed(2)}ms`,
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text) as { neighbors: unknown[] };
      // eslint-disable-next-line no-console
      console.log(`[bench] real DB returned ${parsed.neighbors.length} neighbors`);
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

      const seed = realDb
        .prepare('SELECT from_type, from_id FROM entity_edges LIMIT 1')
        .get() as { from_type: string; from_id: string } | undefined;
      if (!seed) return;

      const start = performance.now();
      const result = handleGraphSubgraph({
        seed_node_type: seed.from_type,
        seed_node_id: seed.from_id,
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
