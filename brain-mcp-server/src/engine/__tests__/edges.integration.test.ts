/**
 * Edges Component — integration tests
 *
 * Boots the edges component against an in-memory DB and verifies:
 *   1. The 3 MCP tools are registered with the expected names
 *   2. A brief.created event with parent_brief_id auto-creates a parent_of edge
 *   3. The integration is idempotent (re-firing brief.created is a no-op)
 *   4. Tool registration matches the component contract
 *
 * @module engine/__tests__/edges.integration.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// Mock db.ts so handlers see our in-memory DB.
vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../db.js';
import { createEdgesComponent } from '../components/edges/index.js';
import { createEventBus } from '../bus.js';
import { edgeMigrations } from '../components/edges/schema.js';
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
  return db;
}

function makeCtx(bus: EventBus): ComponentContext {
  return {
    storage: {} as unknown as ComponentContext['storage'],
    bus,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    config: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('edges component integration', () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    bus = createEventBus();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('exposes the FR-105 CRUD tools and FR-113 traversal tools', () => {
    const comp = createEdgesComponent();
    const tools = comp.tools();
    const names = tools.map((t) => t.name).sort();
    // FR-105 baseline must remain present; FR-113 added 3 traversal tools.
    expect(names).toContain('igris_edge_create');
    expect(names).toContain('igris_edge_list');
    expect(names).toContain('igris_edge_remove');
    expect(names).toContain('igris_graph_neighbors');
    expect(names).toContain('igris_graph_path');
    expect(names).toContain('igris_graph_subgraph');
  });

  it('declares dependency on the briefs component', () => {
    const comp = createEdgesComponent();
    expect(comp.depends).toContain('briefs');
  });

  it('declares brief.created listen and edge.created emit', () => {
    const comp = createEdgesComponent();
    const events = comp.events();
    expect(events.listens.map((e) => e.name)).toContain('brief.created');
    expect(events.emits.map((e) => e.name)).toContain('edge.created');
  });

  it('auto-creates parent_of edge when brief.created carries parent_brief_id', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    bus.emit('brief.created', {
      project: 'igris-ai',
      brief_id: 'FR-053',
      title: 'Brain v5 Phase 2',
      parent_brief_id: 'FR-051',
    });

    const rows = db
      .prepare('SELECT * FROM entity_edges')
      .all() as { from_id: string; to_id: string; edge_type: string; provenance: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].from_id).toBe('FR-053');
    expect(rows[0].to_id).toBe('FR-051');
    expect(rows[0].edge_type).toBe('parent_of');
    expect(rows[0].provenance).toBe('observed');

    comp.destroy();
  });

  it('emits edge.created when the auto-hook fires', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    const seen: Record<string, unknown>[] = [];
    bus.on('edge.created', (payload) => seen.push(payload.data));

    bus.emit('brief.created', {
      project: 'igris-ai',
      brief_id: 'FR-054',
      title: 'Phase 3',
      parent_brief_id: 'FR-051',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].edge_type).toBe('parent_of');
    expect(seen[0].source).toBe('brief.created');

    comp.destroy();
  });

  it('is a no-op when brief.created has no parent_brief_id', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    bus.emit('brief.created', {
      project: 'igris-ai',
      brief_id: 'FR-001',
      title: 'Bare brief',
    });

    const count = db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number };
    expect(count.n).toBe(0);

    comp.destroy();
  });

  it('is idempotent on duplicate brief.created events', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    for (let i = 0; i < 3; i++) {
      bus.emit('brief.created', {
        project: 'igris-ai',
        brief_id: 'FR-055',
        title: 'Phase 4',
        parent_brief_id: 'FR-051',
      });
    }

    const count = db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number };
    expect(count.n).toBe(1);

    comp.destroy();
  });

  it('refuses degenerate self-parent payloads silently', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    // Defensive check inside onBriefCreated: brief_id === parent_brief_id
    // is no-oped before reaching the handler.
    bus.emit('brief.created', {
      project: 'igris-ai',
      brief_id: 'FR-105',
      title: 'Self-parent',
      parent_brief_id: 'FR-105',
    });

    const count = db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number };
    expect(count.n).toBe(0);

    comp.destroy();
  });

  it('routes through the registered tool handler for igris_edge_create', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    const create = comp.tools().find((t) => t.name === 'igris_edge_create');
    expect(create).toBeDefined();

    const result = create!.handler({
      from_type: 'brief',
      from_id: 'FR-200',
      to_type: 'brief',
      to_id: 'FR-100',
      edge_type: 'depends_on',
    }) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text) as { created: boolean };
    expect(parsed.created).toBe(true);

    comp.destroy();
  });

  // -------------------------------------------------------------------------
  // FR-210 — store-side edge population via the enriched memory.stored payload
  // -------------------------------------------------------------------------

  type EdgeRow = {
    from_type: string;
    from_id: string;
    to_type: string;
    to_id: string;
    edge_type: string;
    provenance: string;
    metadata: string;
  };

  it('declares the memory.stored listen (FR-210)', () => {
    const comp = createEdgesComponent();
    expect(comp.events().listens.map((e) => e.name)).toContain('memory.stored');
  });

  it('Path A: source_brief with no edges auto-creates learning→brief derived_from (observed)', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    bus.emit('memory.stored', {
      project: 'igris-ai',
      id: 42,
      category: 'decision',
      source_brief: 'FR-210',
    });

    const rows = db.prepare('SELECT * FROM entity_edges').all() as EdgeRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].from_type).toBe('learning');
    expect(rows[0].from_id).toBe('42');
    expect(rows[0].to_type).toBe('brief');
    expect(rows[0].to_id).toBe('FR-210');
    expect(rows[0].edge_type).toBe('derived_from');
    expect(rows[0].provenance).toBe('observed');
    expect(JSON.parse(rows[0].metadata).source).toBe('memory.stored');

    comp.destroy();
  });

  it('Path B: edges[] captures learning→learning + learning→brief edges (observed)', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    bus.emit('memory.stored', {
      project: 'igris-ai',
      id: 100,
      category: 'pattern',
      edges: [
        { to_type: 'learning', to_id: '950', edge_type: 'supersedes' },
        { to_type: 'brief', to_id: 'FR-113', edge_type: 'derived_from' },
      ],
    });

    const rows = db
      .prepare('SELECT * FROM entity_edges ORDER BY to_id')
      .all() as EdgeRow[];
    expect(rows).toHaveLength(2);

    const l2l = rows.find((r) => r.to_type === 'learning')!;
    expect(l2l.from_id).toBe('100');
    expect(l2l.to_id).toBe('950');
    expect(l2l.edge_type).toBe('supersedes');
    expect(l2l.provenance).toBe('observed');
    expect(JSON.parse(l2l.metadata).source).toBe('memory.stored.edges');

    const l2b = rows.find((r) => r.to_type === 'brief')!;
    expect(l2b.to_id).toBe('FR-113');
    expect(l2b.edge_type).toBe('derived_from');
    expect(l2b.provenance).toBe('observed');

    comp.destroy();
  });

  it('Path A + Path B together on one store', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    bus.emit('memory.stored', {
      project: 'igris-ai',
      id: 7,
      source_brief: 'FR-210',
      edges: [{ to_type: 'learning', to_id: '206', edge_type: 'related_to' }],
    });

    const rows = db.prepare('SELECT * FROM entity_edges').all() as EdgeRow[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.from_type === 'learning' && r.from_id === '7')).toBe(true);
    expect(rows.every((r) => r.provenance === 'observed')).toBe(true);
    expect(rows.map((r) => r.edge_type).sort()).toEqual(['derived_from', 'related_to']);

    comp.destroy();
  });

  it('emits edge.created for each auto-created store-time edge', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    const seen: Record<string, unknown>[] = [];
    bus.on('edge.created', (payload) => seen.push(payload.data));

    bus.emit('memory.stored', {
      project: 'igris-ai',
      id: 11,
      source_brief: 'FR-210',
      edges: [{ to_type: 'learning', to_id: '950', edge_type: 'supersedes' }],
    });

    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.source).sort()).toEqual(['memory.stored', 'memory.stored.edges']);

    comp.destroy();
  });

  it('is idempotent on re-fire (INSERT OR IGNORE) — no duplicate edges', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    for (let i = 0; i < 3; i++) {
      bus.emit('memory.stored', {
        project: 'igris-ai',
        id: 55,
        source_brief: 'FR-210',
        edges: [{ to_type: 'learning', to_id: '950', edge_type: 'supersedes' }],
      });
    }

    const count = db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number };
    expect(count.n).toBe(2);

    comp.destroy();
  });

  it('is a no-op when neither source_brief nor edges is present', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    bus.emit('memory.stored', {
      project: 'igris-ai',
      id: 88,
      category: 'discovery',
    });

    const count = db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number };
    expect(count.n).toBe(0);

    comp.destroy();
  });

  it('is a no-op when the payload carries no learning id', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    // Legacy/thin payload (pre-FR-210) — no id means no anchor, skip silently.
    bus.emit('memory.stored', { project: 'igris-ai', source_brief: 'FR-210' });

    const count = db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number };
    expect(count.n).toBe(0);

    comp.destroy();
  });

  it('guards a degenerate learning→self edge in edges[]', () => {
    const comp = createEdgesComponent();
    comp.init(makeCtx(bus));

    bus.emit('memory.stored', {
      project: 'igris-ai',
      id: 500,
      edges: [{ to_type: 'learning', to_id: '500', edge_type: 'related_to' }],
    });

    const count = db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number };
    expect(count.n).toBe(0);

    comp.destroy();
  });
});
