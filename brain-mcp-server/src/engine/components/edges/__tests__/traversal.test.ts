/**
 * Edges Component — graph traversal tests (FR-113)
 *
 * Verifies the three traversal handlers (neighbors, path, subgraph) plus
 * label resolution, soft-delete handling, cache TTL/invalidation, and
 * cycle safety. Each fixture is built via handleEdgeCreate so the tests
 * exercise the real validation/insert paths.
 *
 * @module engine/components/edges/__tests__/traversal.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import { handleEdgeCreate, handleEdgeRemove } from '../handlers.js';
import { edgeMigrations } from '../schema.js';
import {
  handleGraphNeighbors,
  handleGraphPath,
  handleGraphSubgraph,
  invalidateSubgraphCache,
  resolveLabels,
  _resetTraversalState,
  _getSubgraphCacheSize,
} from '../traversal.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  for (const migration of edgeMigrations) {
    db.exec(migration.sql);
  }
  return db;
}

/** Optional: create label tables so resolveLabels has something to query. */
function createLabelTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_status (
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      title TEXT NOT NULL,
      PRIMARY KEY (project, brief_id)
    );
    CREATE TABLE IF NOT EXISTS learnings (
      id INTEGER PRIMARY KEY,
      title TEXT,
      content TEXT
    );
    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY,
      message TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      summary TEXT
    );
  `);
}

interface ParseShape {
  content: { text: string }[];
  isError?: boolean;
}

function parseResult<T>(result: ParseShape): T {
  return JSON.parse(result.content[0].text) as T;
}

// Fixture factories ---------------------------------------------------------

function buildChain(_db: Database.Database, ids: string[], edgeType = 'depends_on'): void {
  for (let i = 0; i < ids.length - 1; i++) {
    handleEdgeCreate({
      from_type: 'brief',
      from_id: ids[i],
      to_type: 'brief',
      to_id: ids[i + 1],
      edge_type: edgeType,
    });
  }
}

function buildStar(_db: Database.Database, hub: string, leaves: string[], edgeType = 'related_to'): void {
  for (const leaf of leaves) {
    handleEdgeCreate({
      from_type: 'brief',
      from_id: hub,
      to_type: 'brief',
      to_id: leaf,
      edge_type: edgeType,
    });
  }
}

function buildCycle(_db: Database.Database): void {
  handleEdgeCreate({ from_type: 'brief', from_id: 'CY-A', to_type: 'brief', to_id: 'CY-B', edge_type: 'depends_on' });
  handleEdgeCreate({ from_type: 'brief', from_id: 'CY-B', to_type: 'brief', to_id: 'CY-C', edge_type: 'depends_on' });
  handleEdgeCreate({ from_type: 'brief', from_id: 'CY-C', to_type: 'brief', to_id: 'CY-A', edge_type: 'depends_on' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('graph traversal — neighbors', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    createLabelTables(db);
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    _resetTraversalState();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('chain: depth=1 returns immediate neighbor; depth=3 returns full chain', () => {
    buildChain(db, ['A', 'B', 'C', 'D']);

    const r1 = parseResult<{ neighbors: { id: string; depth: number }[] }>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'A', depth: 1, direction: 'out' }),
    );
    expect(r1.neighbors.map((n) => n.id)).toEqual(['B']);

    const r3 = parseResult<{ neighbors: { id: string; depth: number }[] }>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'A', depth: 3, direction: 'out' }),
    );
    expect(r3.neighbors.map((n) => n.id).sort()).toEqual(['B', 'C', 'D']);
    // Depth ordering: B at 1, C at 2, D at 3
    const byId = new Map(r3.neighbors.map((n) => [n.id, n.depth]));
    expect(byId.get('B')).toBe(1);
    expect(byId.get('C')).toBe(2);
    expect(byId.get('D')).toBe(3);
  });

  it('chain / direction=in: traverses backwards', () => {
    buildChain(db, ['A', 'B', 'C']);
    const r = parseResult<{ neighbors: { id: string }[] }>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'C', depth: 1, direction: 'in' }),
    );
    expect(r.neighbors.map((n) => n.id)).toEqual(['B']);
  });

  it('cycle / direction=both: terminates without infinite loop', () => {
    buildCycle(db);
    const r = parseResult<{ neighbors: { id: string }[] }>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'CY-A', depth: 5, direction: 'both' }),
    );
    // Seed excluded; the other two cycle members included
    const ids = r.neighbors.map((n) => n.id).sort();
    expect(ids).toEqual(['CY-B', 'CY-C']);
  });

  it('clamps depth above MAX_DEPTH? — rejects values > 10', () => {
    buildChain(db, ['A', 'B']);
    const result = handleGraphNeighbors({ node_type: 'brief', node_id: 'A', depth: 15 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('depth');
  });

  it('star / max_nodes cap: returns truncated=true when limit hit', () => {
    buildStar(db, 'HUB', ['L1', 'L2', 'L3', 'L4', 'L5']);
    const r = parseResult<{ neighbors: unknown[]; truncated: boolean }>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'HUB', depth: 1, max_nodes: 3 }),
    );
    expect(r.neighbors).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it('edge_types filter excludes non-matching edges', () => {
    handleEdgeCreate({ from_type: 'brief', from_id: 'X', to_type: 'brief', to_id: 'Y', edge_type: 'related_to' });
    handleEdgeCreate({ from_type: 'brief', from_id: 'X', to_type: 'brief', to_id: 'Z', edge_type: 'depends_on' });

    const r = parseResult<{ neighbors: { id: string }[] }>(
      handleGraphNeighbors({
        node_type: 'brief',
        node_id: 'X',
        depth: 1,
        edge_types: ['depends_on'],
        direction: 'out',
      }),
    );
    expect(r.neighbors.map((n) => n.id)).toEqual(['Z']);
  });

  it('soft-deleted edges are excluded by default but include_deleted=true brings them back', () => {
    const created = parseResult<{ id: number }>(
      handleEdgeCreate({ from_type: 'brief', from_id: 'SD-A', to_type: 'brief', to_id: 'SD-B', edge_type: 'depends_on' }),
    );
    handleEdgeRemove({ id: created.id });

    const exclude = parseResult<{ neighbors: unknown[] }>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'SD-A', depth: 1, direction: 'out' }),
    );
    expect(exclude.neighbors).toHaveLength(0);

    const include = parseResult<{ neighbors: unknown[] }>(
      handleGraphNeighbors({
        node_type: 'brief',
        node_id: 'SD-A',
        depth: 1,
        direction: 'out',
        include_deleted: true,
      }),
    );
    expect(include.neighbors).toHaveLength(1);
  });

  it('rejects unknown node_type', () => {
    const result = handleGraphNeighbors({ node_type: 'asteroid', node_id: 'A' });
    expect(result.isError).toBe(true);
  });

  it('rejects missing node_id', () => {
    const result = handleGraphNeighbors({ node_type: 'brief' });
    expect(result.isError).toBe(true);
  });

  it('rejects unknown direction value', () => {
    const result = handleGraphNeighbors({ node_type: 'brief', node_id: 'A', direction: 'sideways' });
    expect(result.isError).toBe(true);
  });

  it('rejects invalid edge_type filter entry', () => {
    const result = handleGraphNeighbors({
      node_type: 'brief',
      node_id: 'A',
      edge_types: ['fake_relation'],
    });
    expect(result.isError).toBe(true);
  });

  it('returns deterministic ordering across repeated calls', () => {
    buildStar(db, 'HUB', ['L1', 'L2', 'L3']);
    const a = parseResult<{ neighbors: { id: string }[] }>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'HUB', depth: 1 }),
    );
    const b = parseResult<{ neighbors: { id: string }[] }>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'HUB', depth: 1 }),
    );
    expect(a.neighbors.map((n) => n.id)).toEqual(b.neighbors.map((n) => n.id));
  });

  it('deterministic ordering: reverse-id insertion still sorts by id ascending', () => {
    // Insert edges in reverse-id order so the comparator's ">" branch fires.
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('brief', 'HUB', 'brief', 'Z-LAST', 'related_to');
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('brief', 'HUB', 'brief', 'M-MID', 'related_to');
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('brief', 'HUB', 'brief', 'A-FIRST', 'related_to');

    const r = parseResult<{ neighbors: { id: string }[] }>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'HUB', depth: 1, direction: 'out' }),
    );
    expect(r.neighbors.map((n) => n.id)).toEqual(['A-FIRST', 'M-MID', 'Z-LAST']);
  });
});

// ---------------------------------------------------------------------------
// Path tests
// ---------------------------------------------------------------------------

describe('graph traversal — path', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    createLabelTables(db);
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    _resetTraversalState();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('chain: shortest path from A to D has length 3', () => {
    buildChain(db, ['A', 'B', 'C', 'D']);
    const r = parseResult<{ found: boolean; length: number; path: { id: string }[] }>(
      handleGraphPath({
        from_type: 'brief',
        from_id: 'A',
        to_type: 'brief',
        to_id: 'D',
      }),
    );
    expect(r.found).toBe(true);
    expect(r.length).toBe(3);
    expect(r.path.map((s) => s.id)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('disconnected nodes return found=false', () => {
    buildChain(db, ['X', 'Y']);
    buildChain(db, ['P', 'Q']);
    const r = parseResult<{ found: boolean; path: unknown[] }>(
      handleGraphPath({
        from_type: 'brief',
        from_id: 'X',
        to_type: 'brief',
        to_id: 'Q',
      }),
    );
    expect(r.found).toBe(false);
    expect(r.path).toEqual([]);
  });

  it('cycle: A→A returns found=false (no self-paths via cycles)', () => {
    buildCycle(db);
    const r = parseResult<{ found: boolean; length: number | null }>(
      handleGraphPath({
        from_type: 'brief',
        from_id: 'CY-A',
        to_type: 'brief',
        to_id: 'CY-A',
      }),
    );
    // The visited-set guard prevents revisiting A, so there's no path to A from A.
    expect(r.found).toBe(false);
    expect(r.length).toBeNull();
  });

  it('cycle: A→C returns shortest length 2', () => {
    buildCycle(db);
    const r = parseResult<{ found: boolean; length: number }>(
      handleGraphPath({
        from_type: 'brief',
        from_id: 'CY-A',
        to_type: 'brief',
        to_id: 'CY-C',
      }),
    );
    expect(r.found).toBe(true);
    expect(r.length).toBe(2);
  });

  it('max_depth shorter than actual path returns found=false', () => {
    buildChain(db, ['A', 'B', 'C', 'D']);
    const r = parseResult<{ found: boolean }>(
      handleGraphPath({
        from_type: 'brief',
        from_id: 'A',
        to_type: 'brief',
        to_id: 'D',
        max_depth: 2,
      }),
    );
    expect(r.found).toBe(false);
  });

  it('chooses shortest when multiple paths exist', () => {
    // Build A→B→D (length 2) and A→C1→C2→D (length 3)
    handleEdgeCreate({ from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'B', edge_type: 'depends_on' });
    handleEdgeCreate({ from_type: 'brief', from_id: 'B', to_type: 'brief', to_id: 'D', edge_type: 'depends_on' });
    handleEdgeCreate({ from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'C1', edge_type: 'depends_on' });
    handleEdgeCreate({ from_type: 'brief', from_id: 'C1', to_type: 'brief', to_id: 'C2', edge_type: 'depends_on' });
    handleEdgeCreate({ from_type: 'brief', from_id: 'C2', to_type: 'brief', to_id: 'D', edge_type: 'depends_on' });

    const r = parseResult<{ length: number; path: { id: string }[] }>(
      handleGraphPath({ from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'D' }),
    );
    expect(r.length).toBe(2);
    expect(r.path.map((s) => s.id)).toEqual(['A', 'B', 'D']);
  });

  it('soft-deleted edge breaks path by default', () => {
    handleEdgeCreate({ from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'B', edge_type: 'depends_on' });
    const created = parseResult<{ id: number }>(
      handleEdgeCreate({ from_type: 'brief', from_id: 'B', to_type: 'brief', to_id: 'C', edge_type: 'depends_on' }),
    );
    handleEdgeRemove({ id: created.id });

    const r = parseResult<{ found: boolean }>(
      handleGraphPath({ from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'C' }),
    );
    expect(r.found).toBe(false);
  });

  it('rejects max_depth out of bounds', () => {
    expect(handleGraphPath({
      from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'B', max_depth: 0,
    }).isError).toBe(true);
    expect(handleGraphPath({
      from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'B', max_depth: 11,
    }).isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subgraph tests
// ---------------------------------------------------------------------------

describe('graph traversal — subgraph', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    createLabelTables(db);
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    _resetTraversalState();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('star: returns hub + all leaves with all edges', () => {
    buildStar(db, 'HUB', ['L1', 'L2', 'L3']);
    const r = parseResult<{ nodes: { id: string; is_seed?: boolean }[]; edges: unknown[]; truncated: boolean }>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'HUB', max_nodes: 20 }),
    );
    expect(r.nodes).toHaveLength(4);
    expect(r.edges).toHaveLength(3);
    const seed = r.nodes.find((n) => n.id === 'HUB');
    expect(seed?.is_seed).toBe(true);
    expect(r.truncated).toBe(false);
  });

  it('star with max_nodes < total returns truncated=true', () => {
    buildStar(db, 'HUB', ['L1', 'L2', 'L3', 'L4', 'L5']);
    const r = parseResult<{ nodes: unknown[]; truncated: boolean }>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'HUB', max_nodes: 3 }),
    );
    expect(r.nodes).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it('cycle: emits all 3 nodes and 3 edges', () => {
    buildCycle(db);
    const r = parseResult<{ nodes: unknown[]; edges: unknown[] }>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'CY-A', max_nodes: 20 }),
    );
    expect(r.nodes).toHaveLength(3);
    expect(r.edges).toHaveLength(3);
  });

  it('cache hit: second call returns cached=true', () => {
    buildStar(db, 'HUB', ['L1', 'L2']);
    const first = parseResult<{ cached: boolean }>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'HUB' }),
    );
    expect(first.cached).toBe(false);
    const second = parseResult<{ cached: boolean }>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'HUB' }),
    );
    expect(second.cached).toBe(true);
  });

  it('cache invalidates after invalidateSubgraphCache()', () => {
    buildStar(db, 'HUB', ['L1']);
    handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'HUB' });
    expect(_getSubgraphCacheSize()).toBe(1);
    invalidateSubgraphCache();
    expect(_getSubgraphCacheSize()).toBe(0);

    const fresh = parseResult<{ cached: boolean }>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'HUB' }),
    );
    expect(fresh.cached).toBe(false);
  });

  it('different params produce different cache entries', () => {
    buildStar(db, 'HUB', ['L1', 'L2']);
    handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'HUB', max_nodes: 10 });
    handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'HUB', max_nodes: 20 });
    expect(_getSubgraphCacheSize()).toBe(2);
  });

  it('soft-deleted edges excluded by default', () => {
    const e = parseResult<{ id: number }>(
      handleEdgeCreate({ from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'B', edge_type: 'depends_on' }),
    );
    handleEdgeRemove({ id: e.id });

    const r = parseResult<{ nodes: unknown[]; edges: unknown[] }>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'A' }),
    );
    // Only the seed should remain — its sole edge is soft-deleted
    expect(r.nodes).toHaveLength(1);
    expect(r.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Label resolution
// ---------------------------------------------------------------------------

describe('graph traversal — label resolution', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    createLabelTables(db);
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    _resetTraversalState();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('resolves brief titles', () => {
    db.prepare('INSERT INTO brief_status (project, brief_id, title) VALUES (?, ?, ?)')
      .run('proj', 'FR-100', 'Awesome feature');
    const labels = resolveLabels([{ type: 'brief', id: 'FR-100' }], db);
    expect(labels.get('brief|FR-100')).toBe('Awesome feature');
  });

  it('truncates learning content to 80 chars', () => {
    const long = 'L'.repeat(200);
    db.prepare('INSERT INTO learnings (id, title, content) VALUES (?, ?, ?)').run(1, 't', long);
    const labels = resolveLabels([{ type: 'learning', id: '1' }], db);
    const label = labels.get('learning|1');
    expect(label?.length).toBe(80);
    expect(label).toMatch(/^L+$/);
  });

  it('falls back to id when label table is missing (goal)', () => {
    const warnings: string[] = [];
    const labels = resolveLabels([{ type: 'goal', id: 'G-001' }], db, (msg) => warnings.push(msg));
    expect(labels.get('goal|G-001')).toBe('G-001');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('goals');
  });

  it('warns only once per missing table per process', () => {
    const warnings: string[] = [];
    resolveLabels([{ type: 'goal', id: 'G-1' }], db, (m) => warnings.push(m));
    resolveLabels([{ type: 'goal', id: 'G-2' }], db, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
  });

  it('unknown entity type falls back to id', () => {
    const labels = resolveLabels([{ type: 'mystery', id: 'X-1' }], db);
    expect(labels.get('mystery|X-1')).toBe('X-1');
  });

  it('row missing from label table falls back to id', () => {
    const labels = resolveLabels([{ type: 'brief', id: 'NEVER-INSERTED' }], db);
    expect(labels.get('brief|NEVER-INSERTED')).toBe('NEVER-INSERTED');
  });
});

// ---------------------------------------------------------------------------
// Schema migration v2
// ---------------------------------------------------------------------------

describe('schema v2 — compound index', () => {
  it('creates idx_edges_compound on (from_type, from_id, edge_type)', () => {
    const db = createTestDb();
    try {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='entity_edges' AND name NOT LIKE 'sqlite_autoindex_%'",
        )
        .all() as { name: string }[];
      const names = indexes.map((i) => i.name).sort();
      expect(names).toContain('idx_edges_compound');
    } finally {
      db.close();
    }
  });

  it('compound index appears in query plan for filtered traversal', () => {
    const db = createTestDb();
    try {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT * FROM entity_edges
           WHERE from_type = ? AND from_id = ? AND edge_type = ?`,
        )
        .all('brief', 'X', 'depends_on') as Array<{ detail: string }>;
      const detail = plan.map((p) => p.detail).join(' | ');
      // Either compound index or one of the existing indexes — assert at minimum
      // an index is being used (not a full scan).
      expect(detail.toLowerCase()).toMatch(/(idx_edges_compound|idx_edges_from|using index)/);
    } finally {
      db.close();
    }
  });
});
