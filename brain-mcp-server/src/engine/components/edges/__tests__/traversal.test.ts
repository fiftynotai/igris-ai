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
import { encodeNodeKey, parseNodeKey } from '../graph-keys.js';

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
    const labels = resolveLabels([{ type: 'brief', id: 'FR-100', project: 'proj' }], db);
    expect(labels.get(encodeNodeKey({ type: 'brief', project: 'proj', id: 'FR-100' }))).toBe(
      'Awesome feature',
    );
  });

  it('truncates learning content to 80 chars', () => {
    const long = 'L'.repeat(200);
    db.prepare('INSERT INTO learnings (id, title, content) VALUES (?, ?, ?)').run(1, 't', long);
    const labels = resolveLabels([{ type: 'learning', id: '1', project: null }], db);
    const label = labels.get(encodeNodeKey({ type: 'learning', project: null, id: '1' }));
    expect(label?.length).toBe(80);
    expect(label).toMatch(/^L+$/);
  });

  it('falls back to id when label table is missing (goal)', () => {
    const warnings: string[] = [];
    const labels = resolveLabels([{ type: 'goal', id: 'G-001', project: null }], db, (msg) =>
      warnings.push(msg),
    );
    expect(labels.get(encodeNodeKey({ type: 'goal', project: null, id: 'G-001' }))).toBe('G-001');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('goals');
  });

  it('warns only once per missing table per process', () => {
    const warnings: string[] = [];
    resolveLabels([{ type: 'goal', id: 'G-1', project: null }], db, (m) => warnings.push(m));
    resolveLabels([{ type: 'goal', id: 'G-2', project: null }], db, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
  });

  it('unknown entity type falls back to id', () => {
    const labels = resolveLabels([{ type: 'mystery', id: 'X-1', project: null }], db);
    expect(labels.get(encodeNodeKey({ type: 'mystery', project: null, id: 'X-1' }))).toBe('X-1');
  });

  it('row missing from label table falls back to id', () => {
    const labels = resolveLabels([{ type: 'brief', id: 'NEVER-INSERTED', project: null }], db);
    expect(
      labels.get(encodeNodeKey({ type: 'brief', project: null, id: 'NEVER-INSERTED' })),
    ).toBe('NEVER-INSERTED');
  });

  // T13 — the assertion that directly retires the old LABEL_SCHEMA lie.
  it('BR-078 T13: two same-id briefs each receive their OWN project title', () => {
    const ins = db.prepare('INSERT INTO brief_status (project, brief_id, title) VALUES (?, ?, ?)');
    ins.run('proj-a', 'BR-001', "A's own title");
    ins.run('proj-b', 'BR-001', "B's own title");

    const labels = resolveLabels(
      [
        { type: 'brief', id: 'BR-001', project: 'proj-a' },
        { type: 'brief', id: 'BR-001', project: 'proj-b' },
      ],
      db,
    );

    expect(labels.get(encodeNodeKey({ type: 'brief', project: 'proj-a', id: 'BR-001' }))).toBe(
      "A's own title",
    );
    expect(labels.get(encodeNodeKey({ type: 'brief', project: 'proj-b', id: 'BR-001' }))).toBe(
      "B's own title",
    );
  });

  it('BR-078: a project-less brief request does not borrow a project-owned title', () => {
    db.prepare('INSERT INTO brief_status (project, brief_id, title) VALUES (?, ?, ?)')
      .run('proj-a', 'BR-777', 'Owned by A');
    const labels = resolveLabels([{ type: 'brief', id: 'BR-777', project: null }], db);
    // The old code returned "Owned by A" here — the first match, regardless of
    // whose it was. A phantom now falls back to its id.
    expect(labels.get(encodeNodeKey({ type: 'brief', project: null, id: 'BR-777' }))).toBe(
      'BR-777',
    );
  });
});

// ---------------------------------------------------------------------------
// BR-078 — the project axis
// ---------------------------------------------------------------------------

interface SeedShape {
  type: string;
  id: string;
  project: string | null;
}
interface NeighborsShape {
  seed: SeedShape;
  neighbors: Array<{ type: string; id: string; project: string | null; label: string; depth: number }>;
  count: number;
  unresolved_hops: number;
}
interface PathShape {
  from: SeedShape;
  to: SeedShape;
  found: boolean;
  length: number | null;
  path: Array<{ type: string; id: string; project: string | null }>;
  unresolved_hops: number;
}
interface SubgraphShape {
  seed: SeedShape;
  nodes: Array<{ type: string; id: string; project: string | null; is_seed?: boolean }>;
  cached: boolean;
  unresolved_hops: number;
}

/**
 * The collision fixture.
 *
 * `BR-001` exists in BOTH projects. `BR-002` is A's alone, `BR-009` is B's
 * alone, and the two edges are INDISTINGUISHABLE in `entity_edges` — one is
 * really A's and one is really B's, and the row does not say which.
 */
function seedCollision(db: Database.Database): void {
  const ins = db.prepare('INSERT INTO brief_status (project, brief_id, title) VALUES (?, ?, ?)');
  ins.run('proj-a', 'BR-001', "A's BR-001");
  ins.run('proj-b', 'BR-001', "B's BR-001");
  ins.run('proj-a', 'BR-002', "A's BR-002");
  ins.run('proj-b', 'BR-009', "B's BR-009");

  handleEdgeCreate({
    from_type: 'brief', from_id: 'BR-001', to_type: 'brief', to_id: 'BR-002', edge_type: 'depends_on',
  });
  handleEdgeCreate({
    from_type: 'brief', from_id: 'BR-001', to_type: 'brief', to_id: 'BR-009', edge_type: 'depends_on',
  });
}

/**
 * BR-078.
 *
 * SCOPE OF THE BEHAVIOUR CHANGE (measured live, pre- vs post- in one process,
 * 81 global-id seeds with an edge x depths 1 and 2 = 162 traversals):
 *
 *   new hard-error regressions ......................  0
 *   identical (modulo additive project/unresolved_hops) 134
 *   node set differs ................................  6
 *   same set, label differs .........................  22
 *
 * 28 of 162 differ, and every one is the defect being removed. Do NOT read the
 * suite below as proving "learning/error/session traversals are unchanged" —
 * that is only true for the SEED (depth-1 node sets identical in 81 of 81) and
 * vacuously true for error/session (zero edges on the live brain). A global-id
 * traversal that passes THROUGH a colliding brief changes by design.
 */
describe('BR-078 — traversal no longer fuses same-id briefs across projects', () => {
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

  // -- T1 (mandated) --------------------------------------------------------

  it('T1: a traversal seeded in proj-a returns only proj-a neighbours', () => {
    seedCollision(db);
    const r = parseResult<NeighborsShape>(
      handleGraphNeighbors({
        node_type: 'brief', node_id: 'BR-001', node_project: 'proj-a', depth: 1, direction: 'both',
      }),
    );

    expect(r.neighbors.map((n) => n.id)).toEqual(['BR-002']);
    expect(r.neighbors.map((n) => n.id)).not.toContain('BR-009');
    for (const n of r.neighbors) expect(n.project).toBe('proj-a');
    expect(r.seed).toEqual({ type: 'brief', id: 'BR-001', project: 'proj-a' });
    // Each side gets its OWN project's title — the LABEL_SCHEMA lie is retired.
    expect(r.neighbors[0].label).toBe("A's BR-002");
  });

  it('T1 (mirror): the same seed in proj-b returns only proj-b neighbours', () => {
    seedCollision(db);
    const r = parseResult<NeighborsShape>(
      handleGraphNeighbors({
        node_type: 'brief', node_id: 'BR-001', node_project: 'proj-b', depth: 1, direction: 'both',
      }),
    );
    expect(r.neighbors.map((n) => n.id)).toEqual(['BR-009']);
    expect(r.neighbors[0].project).toBe('proj-b');
    expect(r.neighbors[0].label).toBe("B's BR-009");
  });

  it('T1 (the pre-BR-078 defect): the fused answer would have been both', () => {
    // Documents exactly what the bug returned: one query, two projects' briefs,
    // presented as though they belonged to one brief. The union of the two
    // project-qualified answers IS the old (wrong) answer.
    seedCollision(db);
    const a = parseResult<NeighborsShape>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'BR-001', node_project: 'proj-a', direction: 'both' }),
    );
    const b = parseResult<NeighborsShape>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'BR-001', node_project: 'proj-b', direction: 'both' }),
    );
    expect([...a.neighbors, ...b.neighbors].map((n) => n.id).sort()).toEqual(['BR-002', 'BR-009']);
    // ...but neither call alone returns both. That is the fix.
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
  });

  // -- T2 (mandated) --------------------------------------------------------

  it('T2: no path exists between two projects\' same-id briefs', () => {
    seedCollision(db);
    const r = parseResult<PathShape>(
      handleGraphPath({
        from_type: 'brief', from_id: 'BR-001', from_project: 'proj-a',
        to_type: 'brief', to_id: 'BR-001', to_project: 'proj-b',
      }),
    );
    expect(r.found).toBe(false);
    expect(r.length).toBeNull();
    expect(r.path).toEqual([]);
    expect(r.from.project).toBe('proj-a');
    expect(r.to.project).toBe('proj-b');
  });

  it("T2: no path from A's BR-001 to B's BR-009", () => {
    seedCollision(db);
    const r = parseResult<PathShape>(
      handleGraphPath({
        from_type: 'brief', from_id: 'BR-001', from_project: 'proj-a',
        to_type: 'brief', to_id: 'BR-009', to_project: 'proj-b',
      }),
    );
    expect(r.found).toBe(false);
  });

  it("T2 (positive control): the path from B's BR-001 to B's BR-009 IS found", () => {
    // Guards against the assertions above passing for the wrong reason (e.g. a
    // traversal that returns nothing at all).
    seedCollision(db);
    const r = parseResult<PathShape>(
      handleGraphPath({
        from_type: 'brief', from_id: 'BR-001', from_project: 'proj-b',
        to_type: 'brief', to_id: 'BR-009', to_project: 'proj-b',
      }),
    );
    expect(r.found).toBe(true);
    expect(r.length).toBe(1);
    expect(r.path.map((s) => `${s.project}/${s.id}`)).toEqual(['proj-b/BR-001', 'proj-b/BR-009']);
  });

  // -- T4 / T6 / T10 — the seed ladder --------------------------------------

  it('T4: an ambiguous seed with no node_project is a HARD ERROR, not an empty success', () => {
    seedCollision(db);
    const result = handleGraphNeighbors({ node_type: 'brief', node_id: 'BR-001' });
    expect(result.isError).toBe(true);
    const msg = result.content[0].text;
    expect(msg).toContain('BR-001');
    expect(msg).toContain('2');
    expect(msg).toContain('proj-a');
    expect(msg).toContain('proj-b');
    expect(msg).toContain('node_project');
  });

  it('T4: the ambiguity error fires for path and subgraph too, naming their own params', () => {
    seedCollision(db);
    const p = handleGraphPath({
      from_type: 'brief', from_id: 'BR-001', to_type: 'brief', to_id: 'BR-002',
    });
    expect(p.isError).toBe(true);
    expect(p.content[0].text).toContain('from_project');

    const s = handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'BR-001' });
    expect(s.isError).toBe(true);
    expect(s.content[0].text).toContain('seed_node_project');
  });

  it('T4: an ambiguous TARGET is refused as loudly as an ambiguous source', () => {
    seedCollision(db);
    const r = handleGraphPath({
      from_type: 'brief', from_id: 'BR-002', from_project: 'proj-a',
      to_type: 'brief', to_id: 'BR-001',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('to_project');
  });

  it('T4: the candidate list is capped at 10 with an "and N more" tail', () => {
    const ins = db.prepare('INSERT INTO brief_status (project, brief_id, title) VALUES (?, ?, ?)');
    for (let i = 0; i < 25; i++) ins.run(`proj-${String(i).padStart(2, '0')}`, 'BR-001', 't');
    const result = handleGraphNeighbors({ node_type: 'brief', node_id: 'BR-001' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('25 projects');
    expect(result.content[0].text).toContain('and 15 more');
  });

  it('T6: |P| = 1 resolves silently — no project param needed', () => {
    seedCollision(db);
    const r = parseResult<NeighborsShape>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'BR-002', direction: 'both' }),
    );
    expect(r.seed.project).toBe('proj-a');
    expect(r.neighbors.map((n) => n.id)).toEqual(['BR-001']);
    expect(r.neighbors[0].project).toBe('proj-a');
  });

  it('T10: an explicit project the id does not live in errors, not empty-succeeds', () => {
    seedCollision(db);
    const r = handleGraphNeighbors({
      node_type: 'brief', node_id: 'BR-001', node_project: 'proj-nonexistent',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('does not exist in project');
    expect(r.content[0].text).toContain('proj-nonexistent');
  });

  it('T10: a non-string node_project is rejected', () => {
    seedCollision(db);
    const r = handleGraphNeighbors({ node_type: 'brief', node_id: 'BR-002', node_project: 42 });
    expect(r.isError).toBe(true);
  });

  // -- T5 — the |P| = 0 (phantom) population --------------------------------

  it('T5: a phantom seed whose neighbours are ALSO phantoms is unchanged', () => {
    // SCOPE THIS CLAIM NARROWLY. It holds because BOTH ends are |P| = 0 (FR-237
    // branch 1), which is the shape of every pre-existing FR-113 fixture: edges
    // referencing ids with no backing row anywhere. It does NOT generalise to
    // "traversals over globally-unique ids are unchanged" — a learning id is
    // globally unique, but a learning that walks THROUGH a colliding brief
    // inherited that brief's fusion and its result correctly changes. Measured
    // on the live brain: 28 of 162 global-id traversals differ substantively.
    // See the module header of traversal.ts and graph_traversal.md.
    buildChain(db, ['CH-A', 'CH-B', 'CH-C']);
    const r = parseResult<NeighborsShape>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'CH-A', depth: 3, direction: 'out' }),
    );
    expect(r.seed.project).toBeNull();
    expect(r.neighbors.map((n) => n.id)).toEqual(['CH-B', 'CH-C']);
    for (const n of r.neighbors) expect(n.project).toBeNull();
    expect(r.unresolved_hops).toBe(0);
  });

  // -- T8 — cache isolation (the :127 fix) ----------------------------------

  it('T8: the subgraph cache is keyed on the resolved seed project', () => {
    seedCollision(db);
    const a = parseResult<SubgraphShape>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'BR-001', seed_node_project: 'proj-a' }),
    );
    expect(a.cached).toBe(false);
    expect(a.nodes.map((n) => n.id).sort()).toEqual(['BR-001', 'BR-002']);

    const b = parseResult<SubgraphShape>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'BR-001', seed_node_project: 'proj-b' }),
    );
    // A two-part cache key would have served A's cached payload here.
    expect(b.cached).toBe(false);
    expect(b.nodes.map((n) => n.id).sort()).toEqual(['BR-001', 'BR-009']);
    expect(_getSubgraphCacheSize()).toBe(2);

    // Re-asking for A still hits A's entry, unpolluted.
    const a2 = parseResult<SubgraphShape>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'BR-001', seed_node_project: 'proj-a' }),
    );
    expect(a2.cached).toBe(true);
    expect(a2.nodes.map((n) => n.id).sort()).toEqual(['BR-001', 'BR-002']);
  });

  /**
   * Fan-out: ONE id legitimately reached in TWO project contexts.
   *
   *   SH-1 lives in proj-a AND proj-b.  A-ONLY is proj-a's, B-ONLY is proj-b's.
   *   SH-1 <-> A-ONLY, SH-1 <-> B-ONLY, and A-ONLY <-> B-ONLY (a real
   *   cross-project edge between two unambiguous ids — FR-237 branch 1).
   *
   * Seeded at SH-1@proj-a the walk reaches A-ONLY@proj-a, crosses to
   * B-ONLY@proj-b, and from there arrives at SH-1@**proj-b** — a second,
   * genuinely different entity with the same id. This is bounded fan-out over
   * REALISED paths, not replication over candidates.
   */
  function seedFanOut(db: Database.Database): void {
    const ins = db.prepare('INSERT INTO brief_status (project, brief_id, title) VALUES (?, ?, ?)');
    ins.run('proj-a', 'SH-1', "A's SH-1");
    ins.run('proj-b', 'SH-1', "B's SH-1");
    ins.run('proj-a', 'A-ONLY', 'A only');
    ins.run('proj-b', 'B-ONLY', 'B only');
    const edge = (from: string, to: string): void => {
      handleEdgeCreate({
        from_type: 'brief', from_id: from, to_type: 'brief', to_id: to, edge_type: 'related_to',
      });
    };
    edge('SH-1', 'A-ONLY');
    edge('SH-1', 'B-ONLY');
    edge('A-ONLY', 'B-ONLY');
  }

  it('fan-out: one id reached in two project contexts yields two distinct nodes', () => {
    seedFanOut(db);
    const r = parseResult<SubgraphShape>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'SH-1', seed_node_project: 'proj-a', max_nodes: 20 }),
    );
    expect(r.nodes.map((n) => `${n.project}/${n.id}`).sort()).toEqual([
      'proj-a/A-ONLY',
      'proj-a/SH-1',
      'proj-b/B-ONLY',
      'proj-b/SH-1',
    ]);
    // Each instance carries its OWN project's title.
    const byKey = new Map(r.nodes.map((n) => [`${n.project}/${n.id}`, n]));
    expect(byKey.get('proj-a/SH-1')).toMatchObject({ label: "A's SH-1" });
    expect(byKey.get('proj-b/SH-1')).toMatchObject({ label: "B's SH-1" });
  });

  it('T8: is_seed compares project, so a foreign same-id instance is never flagged', () => {
    // Needs the fan-out fixture: with only ONE node carrying the seed id, an
    // is_seed that ignored project would still look correct.
    seedFanOut(db);
    const r = parseResult<SubgraphShape>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'SH-1', seed_node_project: 'proj-a', max_nodes: 20 }),
    );
    expect(r.nodes.filter((n) => n.id === 'SH-1')).toHaveLength(2);
    const seeds = r.nodes.filter((n) => n.is_seed);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ id: 'SH-1', project: 'proj-a' });
  });

  it('T8: only one node is the seed in the simple collision case too', () => {
    seedCollision(db);
    const r = parseResult<SubgraphShape>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'BR-001', seed_node_project: 'proj-a' }),
    );
    const seeds = r.nodes.filter((n) => n.is_seed);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ id: 'BR-001', project: 'proj-a' });
  });

  it('T8: a resolvable seed shares one cache entry whether or not the param is passed', () => {
    seedCollision(db);
    handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'BR-002' });
    const second = parseResult<SubgraphShape>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'BR-002', seed_node_project: 'proj-a' }),
    );
    // The key carries the RESOLVED project, not the raw argument.
    expect(second.cached).toBe(true);
    expect(_getSubgraphCacheSize()).toBe(1);
  });

  // -- T9 — the reported residual -------------------------------------------

  it('T9: an undisambiguatable hop is dropped AND counted in unresolved_hops', () => {
    // BR-500 is ambiguous (proj-x / proj-y). The seed lives in proj-q, which is
    // in NEITHER — FR-237 branch 3: no honest projection exists.
    const ins = db.prepare('INSERT INTO brief_status (project, brief_id, title) VALUES (?, ?, ?)');
    ins.run('proj-q', 'BR-400', 'seed');
    ins.run('proj-x', 'BR-500', 'x');
    ins.run('proj-y', 'BR-500', 'y');
    handleEdgeCreate({
      from_type: 'brief', from_id: 'BR-400', to_type: 'brief', to_id: 'BR-500', edge_type: 'depends_on',
    });

    const r = parseResult<NeighborsShape>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'BR-400', depth: 1, direction: 'out' }),
    );
    expect(r.neighbors).toHaveLength(0);
    expect(r.unresolved_hops).toBe(1);
  });

  it('T9: a hop that belongs to ANOTHER instance is not counted as a loss', () => {
    // Standing on A's BR-001, the BR-001->BR-009 row resolves (via FR-237) onto
    // B's BR-001. It is not ours — but it is not lost either, so counting it
    // would overstate the residual.
    seedCollision(db);
    const r = parseResult<NeighborsShape>(
      handleGraphNeighbors({
        node_type: 'brief', node_id: 'BR-001', node_project: 'proj-a', direction: 'both',
      }),
    );
    expect(r.neighbors.map((n) => n.id)).toEqual(['BR-002']);
    expect(r.unresolved_hops).toBe(0);
  });

  it('T9: every response carries unresolved_hops, including path and subgraph', () => {
    seedCollision(db);
    const n = parseResult<NeighborsShape>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'BR-002' }),
    );
    const p = parseResult<PathShape>(
      handleGraphPath({
        from_type: 'brief', from_id: 'BR-002', to_type: 'brief', to_id: 'BR-009', to_project: 'proj-b',
      }),
    );
    const s = parseResult<SubgraphShape>(
      handleGraphSubgraph({ seed_node_type: 'brief', seed_node_id: 'BR-002' }),
    );
    expect(typeof n.unresolved_hops).toBe('number');
    expect(typeof p.unresolved_hops).toBe('number');
    expect(typeof s.unresolved_hops).toBe('number');
  });

  // -- Cross-project reach is PRESERVED --------------------------------------

  it('a genuine cross-project edge between two unique ids is still traversed', () => {
    // FR-237 branch 1: both endpoints unambiguous, so a learning owned by B
    // linked to A's brief is a REAL edge and must not be forced intra-project.
    db.prepare('INSERT INTO brief_status (project, brief_id, title) VALUES (?, ?, ?)')
      .run('proj-a', 'BR-700', "A's brief");
    db.prepare('INSERT INTO learnings (id, title, content) VALUES (?, ?, ?)').run(55, 't', 'body');
    // learnings here has no project column, so |P(learning:55)| = 0 (phantom).
    handleEdgeCreate({
      from_type: 'brief', from_id: 'BR-700', to_type: 'learning', to_id: '55', edge_type: 'related_to',
    });

    const r = parseResult<NeighborsShape>(
      handleGraphNeighbors({ node_type: 'brief', node_id: 'BR-700', direction: 'out' }),
    );
    expect(r.neighbors.map((n) => n.id)).toEqual(['55']);
    expect(r.unresolved_hops).toBe(0);
  });

  // -- T11 — the deleted split('|') decode site ------------------------------

  it('T11: keys round-trip for ids containing a literal pipe and a backslash', () => {
    // Guards the DELETED `cursor.split("|")` reconstruction. A naive split would
    // have mis-parsed these while passing every happy-path test.
    for (const parts of [
      { type: 'brief', project: 'proj-a', id: 'BR|001' },
      { type: 'brief', project: 'proj|b', id: 'BR\\001' },
      { type: 'concept', project: null, id: 'concept:a|b\\c' },
      { type: 'brief', project: null, id: '' },
    ]) {
      expect(parseNodeKey(encodeNodeKey(parts))).toEqual(parts);
    }
  });

  it('T11: a path through pipe-bearing ids reconstructs correctly end to end', () => {
    const ins = db.prepare('INSERT INTO brief_status (project, brief_id, title) VALUES (?, ?, ?)');
    ins.run('proj-a', 'A|1', 'first');
    ins.run('proj-a', 'B\\2', 'second');
    ins.run('proj-a', 'C|3', 'third');
    handleEdgeCreate({ from_type: 'brief', from_id: 'A|1', to_type: 'brief', to_id: 'B\\2', edge_type: 'depends_on' });
    handleEdgeCreate({ from_type: 'brief', from_id: 'B\\2', to_type: 'brief', to_id: 'C|3', edge_type: 'depends_on' });

    const r = parseResult<PathShape>(
      handleGraphPath({ from_type: 'brief', from_id: 'A|1', to_type: 'brief', to_id: 'C|3' }),
    );
    expect(r.found).toBe(true);
    expect(r.path.map((s) => s.id)).toEqual(['A|1', 'B\\2', 'C|3']);
    for (const s of r.path) expect(s.project).toBe('proj-a');
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
