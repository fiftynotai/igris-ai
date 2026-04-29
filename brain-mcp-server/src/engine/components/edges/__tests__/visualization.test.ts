/**
 * Edges Component — visualization data-layer unit tests (FR-111)
 *
 * Verifies fetchProjectGraphRows + assembleGraphPayload + detectGodNodes
 * against an in-memory SQLite DB seeded with brief_status, entity_edges,
 * goals, and brief_files rows.
 *
 * @module engine/components/edges/__tests__/visualization.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  fetchProjectGraphRows,
  assembleGraphPayload,
  detectGodNodes,
  MAX_CONTENT_BYTES,
  TRUNCATION_SUFFIX,
} from '../visualization.js';
import { edgeMigrations } from '../schema.js';

// ---------------------------------------------------------------------------
// Test DB setup
// ---------------------------------------------------------------------------

/**
 * Build an in-memory SQLite DB with all tables visualization.ts touches:
 *   - brief_status (legacy db.ts v2)
 *   - brief_files  (legacy db.ts v6)
 *   - goals        (FR-110 component schema, copied here for isolation)
 *   - entity_edges (FR-105 component schema)
 *
 * Goals migration is duplicated rather than imported because the goals
 * component owns its own schema and would couple this test to that module.
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // brief_status (legacy db.ts v2)
  db.exec(`
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
  `);

  // brief_files (legacy db.ts v6)
  db.exec(`
    CREATE TABLE brief_files (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
  `);

  // goals (FR-110)
  db.exec(`
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL UNIQUE,
      project_slug TEXT,
      title TEXT NOT NULL,
      description TEXT,
      outcome TEXT NOT NULL,
      deadline TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      priority TEXT NOT NULL DEFAULT 'P2-Medium',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      achieved_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
  `);

  // entity_edges (FR-105) — apply both migrations
  for (const migration of edgeMigrations) {
    db.exec(migration.sql);
  }

  return db;
}

function seedBrief(
  db: Database.Database,
  project: string,
  brief_id: string,
  fields: Partial<{
    brief_type: string;
    title: string;
    status: string;
    priority: string;
    effort: string;
    phase: string;
  }> = {},
): void {
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    project,
    brief_id,
    fields.brief_type ?? 'Feature Request',
    fields.title ?? `Title for ${brief_id}`,
    fields.status ?? 'In Progress',
    fields.priority ?? 'P2-Medium',
    fields.effort ?? 'M-Medium (1-2d)',
    fields.phase ?? null,
  );
}

function seedEdge(
  db: Database.Database,
  fromId: string,
  toId: string,
  edgeType: string,
  options: { fromType?: string; toType?: string; deleted?: boolean; confidence?: number } = {},
): number {
  const fromType = options.fromType ?? 'brief';
  const toType = options.toType ?? 'brief';
  const metadata = options.deleted
    ? JSON.stringify({ deleted: true, deleted_at: '2026-04-01T00:00:00Z' })
    : '{}';
  const result = db
    .prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
       VALUES (?, ?, ?, ?, ?, ?, 'observed', ?)`,
    )
    .run(
      fromType,
      fromId,
      toType,
      toId,
      edgeType,
      options.confidence ?? 1.0,
      metadata,
    );
  return result.lastInsertRowid as number;
}

function seedGoal(db: Database.Database, goalId: string, title: string): void {
  db.prepare(
    `INSERT INTO goals (goal_id, project_slug, title, description, outcome, status, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(goalId, 'igris-ai', title, '', 'shipped', 'active', 'P1-High');
}

function seedBriefFile(
  db: Database.Database,
  project: string,
  briefId: string,
  content: string,
): void {
  db.prepare(
    `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`${project}-${briefId}`, project, briefId, `${briefId}-test.md`, content, 'h');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchProjectGraphRows + assembleGraphPayload', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // §4.1 #1 — Empty project
  // -------------------------------------------------------------------------
  it('returns empty payload for a project with no briefs', () => {
    const rows = fetchProjectGraphRows(db, 'empty-project');
    expect(rows.briefs).toEqual([]);
    expect(rows.edges).toEqual([]);
    expect(rows.goals).toEqual([]);

    const payload = assembleGraphPayload(rows, 'empty-project', '2026-04-29T00:00:00Z');
    expect(payload.nodes).toEqual([]);
    expect(payload.edges).toEqual([]);
    expect(payload.god_nodes).toEqual([]);
    expect(payload.stats).toEqual({ brief_count: 0, edge_count: 0, goal_count: 0 });
  });

  // -------------------------------------------------------------------------
  // §4.1 #2 — Briefs only, no edges
  // -------------------------------------------------------------------------
  it('builds nodes-only payload when briefs have no edges', () => {
    for (let i = 1; i <= 5; i++) {
      seedBrief(db, 'igris-ai', `FR-${i.toString().padStart(3, '0')}`);
    }
    const rows = fetchProjectGraphRows(db, 'igris-ai');
    const payload = assembleGraphPayload(rows, 'igris-ai', '2026-04-29T00:00:00Z');

    expect(payload.nodes).toHaveLength(5);
    expect(payload.edges).toHaveLength(0);
    expect(payload.nodes.every((n) => n.degree === 0)).toBe(true);
    expect(payload.stats.brief_count).toBe(5);
    expect(payload.stats.edge_count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // §4.1 #3 — Cross-project edges filtered
  // -------------------------------------------------------------------------
  it('excludes edges where one endpoint is in a different project', () => {
    seedBrief(db, 'project-x', 'FR-001');
    seedBrief(db, 'project-y', 'FR-002');
    seedEdge(db, 'FR-001', 'FR-002', 'depends_on');

    const rows = fetchProjectGraphRows(db, 'project-x');
    const payload = assembleGraphPayload(rows, 'project-x', '2026-04-29T00:00:00Z');

    expect(payload.nodes).toHaveLength(1);
    expect(payload.nodes[0].brief_id).toBe('FR-001');
    expect(payload.edges).toHaveLength(0);
    expect(payload.nodes[0].degree).toBe(0);
  });

  // -------------------------------------------------------------------------
  // §4.1 #4 — Soft-delete respected
  // -------------------------------------------------------------------------
  it('excludes soft-deleted edges (metadata.deleted = true)', () => {
    seedBrief(db, 'igris-ai', 'FR-001');
    seedBrief(db, 'igris-ai', 'FR-002');
    seedEdge(db, 'FR-001', 'FR-002', 'depends_on'); // active
    seedEdge(db, 'FR-002', 'FR-001', 'depends_on', { deleted: true }); // soft-deleted

    const rows = fetchProjectGraphRows(db, 'igris-ai');
    const payload = assembleGraphPayload(rows, 'igris-ai', '2026-04-29T00:00:00Z');

    expect(payload.edges).toHaveLength(1);
    expect(payload.edges[0].from).toBe('brief|FR-001');
    expect(payload.edges[0].to).toBe('brief|FR-002');
  });

  // -------------------------------------------------------------------------
  // §4.1 #5 — Self-loops preserved
  // -------------------------------------------------------------------------
  it('preserves self-loop recurs_with edges', () => {
    seedBrief(db, 'igris-ai', 'FR-001');
    seedEdge(db, 'FR-001', 'FR-001', 'recurs_with');

    const rows = fetchProjectGraphRows(db, 'igris-ai');
    const payload = assembleGraphPayload(rows, 'igris-ai', '2026-04-29T00:00:00Z');

    expect(payload.edges).toHaveLength(1);
    expect(payload.edges[0].from).toBe('brief|FR-001');
    expect(payload.edges[0].to).toBe('brief|FR-001');
    // Self-loop contributes 2 to degree (one from from-side, one from to-side).
    expect(payload.nodes[0].degree).toBe(2);
  });

  // -------------------------------------------------------------------------
  // §4.1 #6 — God-node selection on a known degree distribution
  // -------------------------------------------------------------------------
  it('selects top-K god nodes by degree (ties broken by id)', () => {
    // Hub-and-spoke: FR-HUB connects to 8 leaves, two leaves are connected
    // to each other (so both have degree 2). Hub has degree 8.
    seedBrief(db, 'igris-ai', 'FR-HUB');
    for (let i = 1; i <= 8; i++) {
      const id = `FR-LEAF${i}`;
      seedBrief(db, 'igris-ai', id);
      seedEdge(db, 'FR-HUB', id, 'depends_on');
    }
    // Add one inter-leaf edge so two specific leaves have degree 2.
    seedEdge(db, 'FR-LEAF1', 'FR-LEAF2', 'related_to');

    const rows = fetchProjectGraphRows(db, 'igris-ai');
    const payload = assembleGraphPayload(rows, 'igris-ai', '2026-04-29T00:00:00Z');

    // Hub dominates with degree 8.
    const hubNode = payload.nodes.find((n) => n.brief_id === 'FR-HUB')!;
    expect(hubNode.degree).toBe(8);

    expect(payload.god_nodes[0]).toBe('brief|FR-HUB');
    // Top 3 should be hub + the two degree-2 leaves.
    expect(payload.god_nodes).toHaveLength(3);
    expect(payload.god_nodes).toContain('brief|FR-LEAF1');
    expect(payload.god_nodes).toContain('brief|FR-LEAF2');
  });

  // -------------------------------------------------------------------------
  // §4.1 #7 — Goal node inclusion
  // -------------------------------------------------------------------------
  it('includes goal nodes targeted by serves_goal edges from project briefs', () => {
    seedBrief(db, 'igris-ai', 'FR-001');
    seedBrief(db, 'igris-ai', 'FR-002');
    seedGoal(db, 'GL-001', 'Ship v6.0');
    seedEdge(db, 'FR-001', 'GL-001', 'serves_goal', { toType: 'goal' });
    seedEdge(db, 'FR-002', 'GL-001', 'serves_goal', { toType: 'goal' });

    const rows = fetchProjectGraphRows(db, 'igris-ai');
    const payload = assembleGraphPayload(rows, 'igris-ai', '2026-04-29T00:00:00Z');

    expect(payload.stats.goal_count).toBe(1);
    const goalNode = payload.nodes.find((n) => n.id === 'goal|GL-001');
    expect(goalNode).toBeDefined();
    expect(goalNode!.label).toBe('Ship v6.0');
    expect(goalNode!.group).toBe('goal');

    // Two serves_goal edges in payload.
    const goalEdges = payload.edges.filter((e) => e.type === 'serves_goal');
    expect(goalEdges).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // §4.1 #8 — Brief without optional metadata renders without crash
  // -------------------------------------------------------------------------
  it('handles briefs with null priority/effort/phase fields gracefully', () => {
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, title, status)
       VALUES (?, ?, ?, ?)`,
    ).run('igris-ai', 'FR-099', 'Bare-bones brief', 'Draft');

    const rows = fetchProjectGraphRows(db, 'igris-ai');
    const payload = assembleGraphPayload(rows, 'igris-ai', '2026-04-29T00:00:00Z');

    expect(payload.nodes).toHaveLength(1);
    const node = payload.nodes[0];
    expect(node.priority).toBeNull();
    expect(node.effort).toBeNull();
    expect(node.phase).toBeNull();
    expect(node.brief_type).toBeNull();
    expect(node.label).toBe('Bare-bones brief');
  });

  // -------------------------------------------------------------------------
  // Extras: content cap + group derivation + missing goals table
  // -------------------------------------------------------------------------
  it('caps embedded brief content at MAX_CONTENT_BYTES', () => {
    seedBrief(db, 'igris-ai', 'FR-001');
    const big = 'x'.repeat(MAX_CONTENT_BYTES * 2);
    seedBriefFile(db, 'igris-ai', 'FR-001', big);

    const rows = fetchProjectGraphRows(db, 'igris-ai');
    const payload = assembleGraphPayload(rows, 'igris-ai', '2026-04-29T00:00:00Z');

    const node = payload.nodes[0];
    expect(node.content).not.toBeNull();
    expect(node.content!.length).toBeLessThan(big.length);
    expect(node.content!.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it('derives group from brief_id prefix (FR/TD/BR/PI/MG)', () => {
    seedBrief(db, 'igris-ai', 'FR-001');
    seedBrief(db, 'igris-ai', 'TD-002');
    seedBrief(db, 'igris-ai', 'BR-003');
    seedBrief(db, 'igris-ai', 'PI-004');
    seedBrief(db, 'igris-ai', 'MG-005');

    const rows = fetchProjectGraphRows(db, 'igris-ai');
    const payload = assembleGraphPayload(rows, 'igris-ai', '2026-04-29T00:00:00Z');

    const groups = new Map(payload.nodes.map((n) => [n.brief_id, n.group]));
    expect(groups.get('FR-001')).toBe('FR');
    expect(groups.get('TD-002')).toBe('TD');
    expect(groups.get('BR-003')).toBe('BR');
    expect(groups.get('PI-004')).toBe('PI');
    expect(groups.get('MG-005')).toBe('MG');
  });

  it('returns empty goals when goals table is absent (FR-110 not shipped)', () => {
    seedBrief(db, 'igris-ai', 'FR-001');
    // Drop the goals table to simulate older brain instance.
    db.exec('DROP TABLE goals');
    seedEdge(db, 'FR-001', 'GL-001', 'serves_goal', { toType: 'goal' });

    const rows = fetchProjectGraphRows(db, 'igris-ai');
    expect(rows.goals).toEqual([]);
    // Goal node not surfaced because no rows in `goals`.
    const payload = assembleGraphPayload(rows, 'igris-ai', '2026-04-29T00:00:00Z');
    expect(payload.nodes.find((n) => n.type === 'goal')).toBeUndefined();
  });
});

describe('detectGodNodes', () => {
  it('returns empty array for graphs with fewer than 2 nodes', () => {
    const single = detectGodNodes({
      nodes: [
        {
          id: 'brief|FR-001',
          type: 'brief',
          brief_id: 'FR-001',
          label: 'one',
          group: 'FR',
          status: 'In Progress',
          priority: null,
          effort: null,
          phase: null,
          updated_at: null,
          brief_type: null,
          degree: 0,
          content: null,
        },
      ],
    });
    expect(single).toEqual([]);

    expect(detectGodNodes({ nodes: [] })).toEqual([]);
  });

  it('filters out degree-0 nodes from god-node candidates', () => {
    const result = detectGodNodes({
      nodes: [
        {
          id: 'brief|FR-001',
          type: 'brief',
          brief_id: 'FR-001',
          label: '',
          group: 'FR',
          status: 'In Progress',
          priority: null,
          effort: null,
          phase: null,
          updated_at: null,
          brief_type: null,
          degree: 0,
          content: null,
        },
        {
          id: 'brief|FR-002',
          type: 'brief',
          brief_id: 'FR-002',
          label: '',
          group: 'FR',
          status: 'In Progress',
          priority: null,
          effort: null,
          phase: null,
          updated_at: null,
          brief_type: null,
          degree: 0,
          content: null,
        },
      ],
    });
    expect(result).toEqual([]);
  });

  it('honors k parameter (returns up to k entries)', () => {
    const nodes = [10, 9, 8, 7, 6].map((d, i) => ({
      id: `brief|FR-${i}`,
      type: 'brief' as const,
      brief_id: `FR-${i}`,
      label: '',
      group: 'FR',
      status: 'In Progress',
      priority: null,
      effort: null,
      phase: null,
      updated_at: null,
      brief_type: null,
      degree: d,
      content: null,
    }));

    expect(detectGodNodes({ nodes }, 2)).toEqual(['brief|FR-0', 'brief|FR-1']);
    expect(detectGodNodes({ nodes }, 5)).toHaveLength(5);
  });
});
