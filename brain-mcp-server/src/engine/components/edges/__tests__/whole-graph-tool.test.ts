/**
 * FR-237 — `igris_graph_brain` handler tests.
 *
 * Kept in its own file so the `db.js` module mock cannot leak into the pure
 * builder suite (`whole-graph.test.ts` injects a db directly and mocks nothing).
 *
 * Coverage:
 *   - the handler returns the builder payload verbatim under a getDb() mock
 *   - `project` / `node_types` / `max_edge_replicas` are forwarded
 *   - unknown entity types and out-of-range replica caps are rejected
 *   - gateway strict-input contract (TD-128)
 *   - degraded handler path: getDb() throws -> NOT isError, empty graph with
 *     degraded.reason (AC #8)
 *
 * @module engine/components/edges/__tests__/whole-graph-tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import { handleGraphBrain } from '../whole-graph-tool.js';
import { edgeMigrations } from '../schema.js';
import { createGateway } from '../../../gateway.js';
import { createEdgesComponent } from '../index.js';
import type { BrainGraph } from '../whole-graph.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  for (const migration of edgeMigrations) db.exec(migration.sql);
  db.exec(`
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, brief_id TEXT NOT NULL,
      brief_type TEXT, title TEXT NOT NULL, status TEXT NOT NULL, priority TEXT,
      effort TEXT, phase TEXT, updated_at TEXT);
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, category TEXT NOT NULL,
      title TEXT NOT NULL, content TEXT NOT NULL, scope TEXT DEFAULT 'local',
      source_brief TEXT DEFAULT '', confidence REAL DEFAULT 0.8, updated_at TEXT,
      review_status TEXT NOT NULL DEFAULT 'approved');
  `);
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status) VALUES ('proj-a','FR-001','First','Open')`,
  ).run();
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status) VALUES ('proj-b','FR-002','Second','Open')`,
  ).run();
  db.prepare(
    `INSERT INTO learnings (project, category, title, content) VALUES ('proj-a','pattern','L1','body')`,
  ).run();
  db.prepare(
    `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
     VALUES ('brief','FR-001','brief','FR-002','related_to',1.0,'observed','{}')`,
  ).run();
  return db;
}

function parse(result: { content: { text: string }[] }): BrainGraph {
  return JSON.parse(result.content[0].text) as BrainGraph;
}

describe('handleGraphBrain (FR-237)', () => {
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

  it('returns the builder payload verbatim', () => {
    const result = handleGraphBrain({});
    expect(result.isError).toBeFalsy();
    const payload = parse(result);
    expect(payload.project).toBeNull();
    expect(payload.stats.node_count).toBe(3);
    expect(payload.stats.edge_count).toBe(1);
    expect(payload.edge_resolution.rule).toBe('intra_project_projection');
    expect(payload.edge_resolution.max_edge_replicas).toBe(8);
  });

  it('forwards the project arg (drill-down, same shape)', () => {
    const whole = parse(handleGraphBrain({}));
    const drilled = parse(handleGraphBrain({ project: 'proj-a' }));
    expect(Object.keys(drilled).sort()).toEqual(Object.keys(whole).sort());
    expect(drilled.project).toBe('proj-a');
    // FR-002 lives in proj-b but is one hop away -> boundary node.
    expect(drilled.nodes.find((n) => n.id === 'FR-002')!.boundary).toBe(true);
    expect(drilled.stats.boundary_node_count).toBe(1);
  });

  it('forwards node_types', () => {
    const payload = parse(handleGraphBrain({ node_types: ['brief'] }));
    expect(payload.nodes.every((n) => n.type === 'brief')).toBe(true);
    expect(payload.stats.node_count).toBe(2);
  });

  it('rejects an unknown entity type in node_types', () => {
    const result = handleGraphBrain({ node_types: ['brief', 'sandwich'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown entity type');
  });

  it('rejects a non-array node_types and an empty project', () => {
    expect(handleGraphBrain({ node_types: 'brief' }).isError).toBe(true);
    expect(handleGraphBrain({ project: '' }).isError).toBe(true);
  });

  it('forwards max_edge_replicas and rejects out-of-range values', () => {
    const payload = parse(handleGraphBrain({ max_edge_replicas: 2 }));
    expect(payload.edge_resolution.max_edge_replicas).toBe(2);

    expect(handleGraphBrain({ max_edge_replicas: 0 }).isError).toBe(true);
    expect(handleGraphBrain({ max_edge_replicas: 33 }).isError).toBe(true);
    expect(handleGraphBrain({ max_edge_replicas: 2.5 }).isError).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128)
  // -------------------------------------------------------------------------

  it('rejects unknown args via the gateway strict-input contract (TD-128)', async () => {
    const gateway = createGateway();
    gateway.register(createEdgesComponent().tools());
    await expect(gateway.dispatch('igris_graph_brain', { bogus: true })).rejects.toThrowError(
      /igris_graph_brain: unknown argument 'bogus'/,
    );
  });

  it('dispatches cleanly via the gateway with no args', async () => {
    const gateway = createGateway();
    gateway.register(createEdgesComponent().tools());
    const result = (await gateway.dispatch('igris_graph_brain', {})) as {
      content: { text: string }[];
    };
    expect(parse(result).stats.node_count).toBe(3);
  });

  // -------------------------------------------------------------------------
  // AC #8 — degraded brain does not throw
  // -------------------------------------------------------------------------

  it('a throwing getDb() yields a SUCCESS result with an empty graph and degraded.reason', () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error('unable to open database file');
    });

    const result = handleGraphBrain({ project: 'proj-a' });
    expect(result.isError).toBeFalsy();

    const payload = parse(result);
    expect(payload.nodes).toEqual([]);
    expect(payload.edges).toEqual([]);
    expect(payload.stats.node_count).toBe(0);
    expect(payload.project).toBe('proj-a');
    expect(payload.degraded.reason).toContain('unable to open database file');
    // Shape parity: an operator dashboard renders an empty brain, not an error.
    expect(Object.keys(payload).sort()).toEqual(
      [
        'degraded',
        'edge_resolution',
        'edges',
        'generated_at',
        'nodes',
        'project',
        'stats',
        'truncated',
        'truncation_reason',
      ].sort(),
    );
  });
});
