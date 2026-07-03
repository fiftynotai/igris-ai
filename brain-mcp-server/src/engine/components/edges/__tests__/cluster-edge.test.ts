/**
 * cluster_member_of edge-vocabulary tests (FR-116 M4, Decision #3a).
 *
 * Proves the ONE VALID_EDGE_TYPES addition in M4 is wired end-to-end:
 *   - `cluster_member_of` is a member of VALID_EDGE_TYPES;
 *   - a `cluster_member_of` edge can be CREATED via handleEdgeCreate and TRAVERSED
 *     via igris_graph_neighbors (the edge participates in the graph like any other);
 *   - ROW-100 LOCKSTEP: the `igris_memory_store` `edges[]` enum
 *     (`memory/index.ts`, which imports VALID_EDGE_TYPES) includes it — a mismatch
 *     would let the store tool reject an edge the graph accepts (or vice-versa).
 *
 * @module engine/components/edges/__tests__/cluster-edge.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { handleEdgeCreate, VALID_EDGE_TYPES } from '../handlers.js';
import { handleGraphNeighbors } from '../traversal.js';
import { edgeMigrations } from '../schema.js';
import { createMemoryComponent } from '../../memory/index.js';
import { getDb } from '../../../../db.js';

vi.mock('../../../../db.js', () => ({ getDb: vi.fn() }));

interface ToolInputSchema {
  properties: Record<string, unknown>;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  for (const m of edgeMigrations) db.exec(m.sql);
  return db;
}

describe('FR-116 M4 cluster_member_of edge vocabulary', () => {
  let db: Database.Database;
  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('cluster_member_of is a member of VALID_EDGE_TYPES', () => {
    expect((VALID_EDGE_TYPES as readonly string[]).includes('cluster_member_of')).toBe(true);
  });

  it('a cluster_member_of edge can be created and traversed', () => {
    const created = handleEdgeCreate({
      from_type: 'learning',
      from_id: '101',
      to_type: 'learning',
      to_id: '999', // the meta-learning
      edge_type: 'cluster_member_of',
    });
    expect(created.isError).toBeFalsy();

    // Traverse from the member — the meta node is a neighbour.
    const neighbors = handleGraphNeighbors({
      node_type: 'learning',
      node_id: '101',
      edge_types: ['cluster_member_of'],
      direction: 'out',
    });
    expect(neighbors.isError).toBeFalsy();
    const payload = JSON.parse(neighbors.content[0].text) as {
      neighbors: Array<{ type: string; id: string }>;
    };
    expect(payload.neighbors.some((n) => n.type === 'learning' && n.id === '999')).toBe(true);
  });

  it('ROW-100 LOCKSTEP: the memory-store edges enum includes cluster_member_of', () => {
    const component = createMemoryComponent();
    const store = component.tools().find((t) => t.name === 'igris_memory_store');
    const schema = store!.inputSchema as unknown as ToolInputSchema;
    const edges = schema.properties.edges as {
      items: { properties: { edge_type: { enum: string[] } } };
    };
    expect(edges.items.properties.edge_type.enum).toContain('cluster_member_of');
    // Full lockstep: the store enum IS VALID_EDGE_TYPES (imported by reference).
    expect([...edges.items.properties.edge_type.enum].sort()).toEqual(
      [...VALID_EDGE_TYPES].sort(),
    );
  });
});
