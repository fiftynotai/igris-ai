/**
 * TD-171 M2 — igris_graph_node_create + igris_graph_node_get handler tests.
 *
 * Coverage:
 *   - happy path: create returns id + created=true with the persisted row
 *   - idempotency: re-create with same (node_type, node_external_id) returns
 *     created=false and the SAME id; only one row exists in the table
 *   - rejects missing required fields (node_type, node_external_id, label)
 *   - properties bag persists as JSON; defaults to {}
 *   - get returns the row plus edge_count_in / edge_count_out (with
 *     soft-deleted edges excluded)
 *   - get returns isError=true when the node does not exist
 *   - VALID_ENTITY_TYPES extension regression: existing edge_create still
 *     works with the original 5 types AND accepts the new concept/decision
 *   - gateway strict-input contract (TD-128): rejects unknown args
 *
 * @module engine/components/edges/__tests__/nodes.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// Mock the db module so handlers resolve getDb() to our in-memory DB.
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import {
  handleGraphNodeCreate,
  handleGraphNodeGet,
} from '../nodes-handlers.js';
import { handleEdgeCreate, VALID_ENTITY_TYPES } from '../handlers.js';
import { edgeMigrations } from '../schema.js';
import { createGateway } from '../../../gateway.js';
import { createEdgesComponent } from '../index.js';

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

interface ParsedCreate {
  id: number;
  node_type: string;
  node_external_id: string;
  label: string;
  created: boolean;
}

interface ParsedGet {
  id: number;
  node_type: string;
  node_external_id: string;
  label: string;
  properties: Record<string, unknown>;
  created_at: string;
  edge_count_in: number;
  edge_count_out: number;
}

function parseResult<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('graph node handlers (TD-171 M2)', () => {
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

  // -------------------------------------------------------------------------
  // handleGraphNodeCreate
  // -------------------------------------------------------------------------

  describe('handleGraphNodeCreate', () => {
    it('creates a new node with default empty properties', () => {
      const result = handleGraphNodeCreate({
        node_type: 'concept',
        node_external_id: 'concept:vector-search',
        label: 'Vector search',
      });

      expect(result.isError).toBeUndefined();
      const parsed = parseResult<ParsedCreate>(result);
      expect(parsed.created).toBe(true);
      expect(parsed.node_type).toBe('concept');
      expect(parsed.node_external_id).toBe('concept:vector-search');
      expect(parsed.label).toBe('Vector search');
      expect(parsed.id).toBeGreaterThan(0);

      // Confirm row landed with default properties = '{}'
      const row = db
        .prepare('SELECT * FROM graph_nodes WHERE id = ?')
        .get(parsed.id) as { properties: string };
      expect(row.properties).toBe('{}');
    });

    it('returns created=false on duplicate (UNIQUE constraint, idempotent)', () => {
      const first = parseResult<ParsedCreate>(
        handleGraphNodeCreate({
          node_type: 'decision',
          node_external_id: 'decision:swap-libsql',
          label: 'Swap to libsql',
        }),
      );

      const second = parseResult<ParsedCreate>(
        handleGraphNodeCreate({
          node_type: 'decision',
          node_external_id: 'decision:swap-libsql',
          // Different label — handler MUST preserve the original (per docstring).
          label: 'A completely different label',
        }),
      );

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      // The SECOND call's response surfaces the EXISTING (first) label,
      // not the caller's attempted update.
      expect(second.label).toBe('Swap to libsql');

      const count = db.prepare('SELECT COUNT(*) AS n FROM graph_nodes').get() as { n: number };
      expect(count.n).toBe(1);
    });

    it('persists a properties JSON bag when provided', () => {
      const r = parseResult<ParsedCreate>(
        handleGraphNodeCreate({
          node_type: 'concept',
          node_external_id: 'concept:foo',
          label: 'Foo',
          properties: { project: 'igris-ai', tags: ['graph', 'm2'] },
        }),
      );

      const row = db
        .prepare('SELECT properties FROM graph_nodes WHERE id = ?')
        .get(r.id) as { properties: string };
      const parsed = JSON.parse(row.properties) as Record<string, unknown>;
      expect(parsed.project).toBe('igris-ai');
      expect(parsed.tags).toEqual(['graph', 'm2']);
    });

    it('rejects missing required fields', () => {
      const r1 = handleGraphNodeCreate({ node_external_id: 'x', label: 'l' });
      expect(r1.isError).toBe(true);
      expect(r1.content[0].text).toContain('Missing required fields');

      const r2 = handleGraphNodeCreate({ node_type: 'concept', label: 'l' });
      expect(r2.isError).toBe(true);
      expect(r2.content[0].text).toContain('Missing required fields');

      const r3 = handleGraphNodeCreate({ node_type: 'concept', node_external_id: 'x' });
      expect(r3.isError).toBe(true);
      expect(r3.content[0].text).toContain('Missing required fields');
    });
  });

  // -------------------------------------------------------------------------
  // handleGraphNodeGet
  // -------------------------------------------------------------------------

  describe('handleGraphNodeGet', () => {
    it('returns the node with zero degree counts when no edges reference it', () => {
      handleGraphNodeCreate({
        node_type: 'concept',
        node_external_id: 'concept:lonely',
        label: 'Lonely node',
        properties: { project: 'p' },
      });

      const result = handleGraphNodeGet({
        node_type: 'concept',
        node_external_id: 'concept:lonely',
      });
      expect(result.isError).toBeUndefined();
      const parsed = parseResult<ParsedGet>(result);
      expect(parsed.node_type).toBe('concept');
      expect(parsed.node_external_id).toBe('concept:lonely');
      expect(parsed.label).toBe('Lonely node');
      expect(parsed.properties).toEqual({ project: 'p' });
      expect(parsed.edge_count_in).toBe(0);
      expect(parsed.edge_count_out).toBe(0);
      expect(parsed.created_at).toBeTruthy();
    });

    it('counts non-deleted in/out edges separately', () => {
      // Register the seed node + two neighbour briefs.
      handleGraphNodeCreate({
        node_type: 'concept',
        node_external_id: 'concept:hub',
        label: 'Hub',
      });

      // 2 outgoing edges (hub -> X, hub -> Y).
      handleEdgeCreate({
        from_type: 'concept', from_id: 'concept:hub',
        to_type: 'brief', to_id: 'FR-001',
        edge_type: 'related_to',
      });
      handleEdgeCreate({
        from_type: 'concept', from_id: 'concept:hub',
        to_type: 'brief', to_id: 'FR-002',
        edge_type: 'related_to',
      });

      // 1 incoming edge (FR-003 -> hub).
      handleEdgeCreate({
        from_type: 'brief', from_id: 'FR-003',
        to_type: 'concept', to_id: 'concept:hub',
        edge_type: 'derived_from',
      });

      // 1 incoming edge that gets soft-deleted (must NOT count).
      const softCreate = handleEdgeCreate({
        from_type: 'brief', from_id: 'FR-004',
        to_type: 'concept', to_id: 'concept:hub',
        edge_type: 'related_to',
      });
      const softId = (parseResult<{ edge: { id: number } }>(softCreate)).edge.id;
      // Mark as soft-deleted directly (skip edge_remove handler — keeping the
      // test focused on the count semantics).
      db.prepare(`UPDATE entity_edges SET metadata = ? WHERE id = ?`).run(
        JSON.stringify({ deleted: true }),
        softId,
      );

      const parsed = parseResult<ParsedGet>(
        handleGraphNodeGet({ node_type: 'concept', node_external_id: 'concept:hub' }),
      );
      expect(parsed.edge_count_out).toBe(2);
      expect(parsed.edge_count_in).toBe(1); // soft-deleted excluded
    });

    it('errors when the node does not exist', () => {
      const result = handleGraphNodeGet({
        node_type: 'concept',
        node_external_id: 'concept:missing',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Node not found');
    });

    it('rejects missing required fields', () => {
      const r = handleGraphNodeGet({ node_type: 'concept' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('Missing required fields');
    });
  });

  // -------------------------------------------------------------------------
  // VALID_ENTITY_TYPES extension regression (operator-locked Decision 2)
  // -------------------------------------------------------------------------

  describe('VALID_ENTITY_TYPES extension (TD-171 M2 Decision 2)', () => {
    it('still includes the original 5 types', () => {
      const types = [...VALID_ENTITY_TYPES];
      expect(types).toEqual(
        expect.arrayContaining(['brief', 'learning', 'error', 'session', 'goal']),
      );
    });

    it('now includes concept and decision', () => {
      const types = [...VALID_ENTITY_TYPES];
      expect(types).toContain('concept');
      expect(types).toContain('decision');
    });

    it('handleEdgeCreate accepts the original brief-to-brief edge (regression)', () => {
      const r = handleEdgeCreate({
        from_type: 'brief', from_id: 'FR-100',
        to_type: 'brief', to_id: 'FR-099',
        edge_type: 'parent_of',
      });
      expect(r.isError).toBeUndefined();
    });

    it('handleEdgeCreate accepts a concept→brief edge (new path)', () => {
      const r = handleEdgeCreate({
        from_type: 'concept', from_id: 'concept:auth-rewrite',
        to_type: 'brief', to_id: 'FR-200',
        edge_type: 'related_to',
      });
      expect(r.isError).toBeUndefined();
    });

    it('handleEdgeCreate accepts a decision→decision supersedes edge (new path)', () => {
      const r = handleEdgeCreate({
        from_type: 'decision', from_id: 'decision:libsql',
        to_type: 'decision', to_id: 'decision:better-sqlite3',
        edge_type: 'supersedes',
      });
      expect(r.isError).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128) — gateway-level
  // -------------------------------------------------------------------------

  describe('strict-input contract (TD-128)', () => {
    it('igris_graph_node_create rejects unknown args via gateway', async () => {
      const gateway = createGateway();
      const component = createEdgesComponent();
      gateway.register(component.tools());

      await expect(
        gateway.dispatch('igris_graph_node_create', {
          node_type: 'concept',
          node_external_id: 'concept:foo',
          label: 'Foo',
          bogus_extra: 'should-throw',
        }),
      ).rejects.toThrowError(
        /igris_graph_node_create: unknown argument 'bogus_extra'\. Accepted keys: .*\. \(strict-input contract; TD-128\)/,
      );
    });

    it('igris_graph_node_get rejects unknown args via gateway', async () => {
      const gateway = createGateway();
      const component = createEdgesComponent();
      gateway.register(component.tools());

      await expect(
        gateway.dispatch('igris_graph_node_get', {
          node_type: 'concept',
          node_external_id: 'concept:foo',
          extra: true,
        }),
      ).rejects.toThrowError(
        /igris_graph_node_get: unknown argument 'extra'/,
      );
    });
  });
});
