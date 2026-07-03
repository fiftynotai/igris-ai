/**
 * TD-171 M2 — igris_graph_dashboard handler tests.
 *
 * Coverage:
 *   - canonical _dashboard shape: totals + recent + samples blocks
 *   - totals.by_node_type / by_edge_type populated correctly
 *   - orphan_node_count counts nodes with zero non-deleted edges
 *   - summary_only=true omits the samples block (totals/recent still computed)
 *   - project filter narrows graph_nodes (via properties.project) AND the
 *     filter is echoed back in the response
 *   - days window narrows recent.* but NOT totals.* (canonical M1 contract)
 *   - top_god_nodes ranked by total_degree desc (in + out, soft-deletes
 *     excluded)
 *   - empty DB returns zeroed shape without throwing
 *   - rejects negative days
 *   - gateway strict-input contract (TD-128)
 *
 * @module engine/components/edges/__tests__/graph-dashboard.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import {
  handleGraphDashboard,
  handleGraphNodeCreate,
} from '../nodes-handlers.js';
import { handleEdgeCreate } from '../handlers.js';
import { edgeMigrations } from '../schema.js';
import { createGateway } from '../../../gateway.js';
import { createEdgesComponent } from '../index.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  for (const migration of edgeMigrations) {
    db.exec(migration.sql);
  }
  return db;
}

interface DashboardShape {
  totals: {
    total_nodes: number;
    by_node_type: Record<string, number>;
    total_edges: number;
    by_edge_type: Record<string, number>;
    orphan_node_count: number;
  };
  recent: {
    last_n_days: number;
    nodes_created: number;
    edges_created: number;
  };
  samples?: {
    top_god_nodes: {
      id: number;
      node_type: string;
      node_external_id: string;
      label: string;
      total_degree: number;
    }[];
  };
  project?: string;
}

function parseResult(result: { content: { text: string }[] }): DashboardShape {
  return JSON.parse(result.content[0].text) as DashboardShape;
}

describe('handleGraphDashboard (TD-171 M2)', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns the canonical _dashboard shape with totals + recent + samples', () => {
    handleGraphNodeCreate({
      node_type: 'concept', node_external_id: 'concept:a', label: 'A',
      properties: { project: 'p' },
    });
    handleGraphNodeCreate({
      node_type: 'decision', node_external_id: 'decision:b', label: 'B',
      properties: { project: 'p' },
    });
    handleEdgeCreate({
      from_type: 'concept', from_id: 'concept:a',
      to_type: 'decision', to_id: 'decision:b',
      edge_type: 'related_to',
    });

    const payload = parseResult(handleGraphDashboard({}));

    // Top-level keys
    expect(Object.keys(payload).sort()).toEqual(['recent', 'samples', 'totals'].sort());

    // totals.*
    expect(payload.totals.total_nodes).toBe(2);
    expect(payload.totals.by_node_type.concept).toBe(1);
    expect(payload.totals.by_node_type.decision).toBe(1);
    expect(payload.totals.total_edges).toBe(1);
    expect(payload.totals.by_edge_type.related_to).toBe(1);

    // Both nodes are linked => 0 orphans.
    expect(payload.totals.orphan_node_count).toBe(0);

    // recent.* (default days=30)
    expect(payload.recent.last_n_days).toBe(30);
    expect(payload.recent.nodes_created).toBe(2);
    expect(payload.recent.edges_created).toBe(1);

    // samples.top_god_nodes present, ordered by degree desc.
    expect(payload.samples).toBeDefined();
    expect(payload.samples!.top_god_nodes.length).toBe(2);
  });

  it('omits samples when summary_only=true', () => {
    handleGraphNodeCreate({ node_type: 'concept', node_external_id: 'c:1', label: '1' });
    const payload = parseResult(handleGraphDashboard({ summary_only: true }));
    expect(payload.samples).toBeUndefined();
    expect(payload.totals.total_nodes).toBe(1);
  });

  it('counts orphan nodes (zero non-deleted edges in or out)', () => {
    handleGraphNodeCreate({ node_type: 'concept', node_external_id: 'c:linked', label: 'L' });
    handleGraphNodeCreate({ node_type: 'concept', node_external_id: 'c:orphan', label: 'O' });
    handleEdgeCreate({
      from_type: 'concept', from_id: 'c:linked',
      to_type: 'brief', to_id: 'FR-1',
      edge_type: 'related_to',
    });

    const payload = parseResult(handleGraphDashboard({}));
    expect(payload.totals.orphan_node_count).toBe(1);
  });

  it('treats soft-deleted edges as non-existent for orphan count and degree', () => {
    handleGraphNodeCreate({ node_type: 'concept', node_external_id: 'c:hub', label: 'Hub' });

    const r = handleEdgeCreate({
      from_type: 'concept', from_id: 'c:hub',
      to_type: 'brief', to_id: 'FR-1',
      edge_type: 'related_to',
    });
    const edgeId = (JSON.parse(r.content[0].text) as { edge: { id: number } }).edge.id;
    db.prepare('UPDATE entity_edges SET metadata = ? WHERE id = ?').run(
      JSON.stringify({ deleted: true }),
      edgeId,
    );

    const payload = parseResult(handleGraphDashboard({}));
    // The only node now has 0 non-deleted edges -> counted as orphan.
    expect(payload.totals.orphan_node_count).toBe(1);
    // Edge totals also exclude soft-deleted (parity with igris_edge_list).
    expect(payload.totals.total_edges).toBe(0);
  });

  it('narrows graph_nodes by project filter and echoes the filter back', () => {
    handleGraphNodeCreate({
      node_type: 'concept', node_external_id: 'c:in-a', label: 'A1',
      properties: { project: 'project-a' },
    });
    handleGraphNodeCreate({
      node_type: 'concept', node_external_id: 'c:in-a-2', label: 'A2',
      properties: { project: 'project-a' },
    });
    handleGraphNodeCreate({
      node_type: 'concept', node_external_id: 'c:in-b', label: 'B1',
      properties: { project: 'project-b' },
    });

    const payload = parseResult(handleGraphDashboard({ project: 'project-a' }));
    expect(payload.project).toBe('project-a');
    expect(payload.totals.total_nodes).toBe(2);
    expect(payload.totals.by_node_type.concept).toBe(2);
    // top_god_nodes also filtered to project-a (all 2 nodes are orphans here).
    expect(payload.samples!.top_god_nodes.every((g) => g.label.startsWith('A'))).toBe(true);
  });

  it('days window narrows recent.* but NOT totals.* (canonical M1 contract)', () => {
    // Backdate one node 60 days ago via direct insert (bypassing handler so
    // we control created_at). The handler always uses datetime('now').
    db.prepare(
      `INSERT INTO graph_nodes (node_type, node_external_id, label, properties, created_at)
       VALUES (?, ?, ?, ?, datetime('now', '-60 days'))`,
    ).run('concept', 'c:old', 'Old', '{}');

    // Two recent nodes.
    handleGraphNodeCreate({ node_type: 'concept', node_external_id: 'c:new1', label: 'New1' });
    handleGraphNodeCreate({ node_type: 'concept', node_external_id: 'c:new2', label: 'New2' });

    const payload = parseResult(handleGraphDashboard({ days: 30 }));
    // Totals see all 3.
    expect(payload.totals.total_nodes).toBe(3);
    // Recent window (30 days) sees only the 2 fresh ones.
    expect(payload.recent.last_n_days).toBe(30);
    expect(payload.recent.nodes_created).toBe(2);
  });

  it('ranks top_god_nodes by total_degree desc', () => {
    handleGraphNodeCreate({ node_type: 'concept', node_external_id: 'c:hub', label: 'Hub' });
    handleGraphNodeCreate({ node_type: 'concept', node_external_id: 'c:leaf', label: 'Leaf' });

    // 3 outgoing from hub -> 3 different briefs (degree 3).
    for (let i = 0; i < 3; i++) {
      handleEdgeCreate({
        from_type: 'concept', from_id: 'c:hub',
        to_type: 'brief', to_id: `FR-${i}`,
        edge_type: 'related_to',
      });
    }
    // 1 outgoing from leaf -> 1 brief (degree 1).
    handleEdgeCreate({
      from_type: 'concept', from_id: 'c:leaf',
      to_type: 'brief', to_id: 'FR-99',
      edge_type: 'related_to',
    });

    const payload = parseResult(handleGraphDashboard({}));
    const top = payload.samples!.top_god_nodes;
    expect(top[0].label).toBe('Hub');
    expect(top[0].total_degree).toBe(3);
    expect(top[1].label).toBe('Leaf');
    expect(top[1].total_degree).toBe(1);
  });

  it('returns zeroed shape on an empty DB without throwing', () => {
    const payload = parseResult(handleGraphDashboard({}));
    expect(payload.totals.total_nodes).toBe(0);
    expect(payload.totals.total_edges).toBe(0);
    expect(payload.totals.orphan_node_count).toBe(0);
    expect(payload.totals.by_node_type).toEqual({});
    expect(payload.totals.by_edge_type).toEqual({});
    expect(payload.recent.nodes_created).toBe(0);
    expect(payload.recent.edges_created).toBe(0);
    expect(payload.samples!.top_god_nodes).toEqual([]);
  });

  it('rejects negative days', () => {
    const result = handleGraphDashboard({ days: -1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('days must be a non-negative number');
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128)
  // -------------------------------------------------------------------------

  it('rejects unknown args via gateway strict-input contract (TD-128)', async () => {
    const gateway = createGateway();
    const component = createEdgesComponent();
    gateway.register(component.tools());

    await expect(
      gateway.dispatch('igris_graph_dashboard', { bogus: true }),
    ).rejects.toThrowError(/igris_graph_dashboard: unknown argument 'bogus'/);
  });

  it('dispatches cleanly via the gateway with no args (defaults applied)', async () => {
    const gateway = createGateway();
    const component = createEdgesComponent();
    gateway.register(component.tools());

    handleGraphNodeCreate({ node_type: 'concept', node_external_id: 'c:a', label: 'A' });
    const result = await gateway.dispatch('igris_graph_dashboard', {});
    const payload = JSON.parse(
      (result as { content: { text: string }[] }).content[0].text,
    ) as DashboardShape;
    expect(payload.recent.last_n_days).toBe(30);
    expect(payload.totals.total_nodes).toBe(1);
  });
});
