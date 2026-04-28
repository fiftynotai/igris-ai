/**
 * Edges Component — handler unit tests
 *
 * Verifies the three core handlers (create, list, remove) plus
 * the schema migration's idempotency. Uses an in-memory SQLite DB
 * with the edges component migrations applied.
 *
 * @module engine/components/edges/__tests__/handlers.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// Mock the db module so handlers resolve getDb() to our in-memory DB.
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import {
  handleEdgeCreate,
  handleEdgeList,
  handleEdgeRemove,
  VALID_EDGE_TYPES,
} from '../handlers.js';
import { edgeMigrations } from '../schema.js';

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
  created: boolean;
  edge: {
    id: number;
    from_type: string;
    from_id: string;
    to_type: string;
    to_id: string;
    edge_type: string;
    confidence: number;
    provenance: string;
    metadata: string;
    created_at: string;
  };
}

function parseResult<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('edges handlers', () => {
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
  // handleEdgeCreate
  // -------------------------------------------------------------------------

  describe('handleEdgeCreate', () => {
    it('creates a new edge with default confidence and provenance', () => {
      const result = handleEdgeCreate({
        from_type: 'brief',
        from_id: 'FR-053',
        to_type: 'brief',
        to_id: 'FR-051',
        edge_type: 'parent_of',
      });

      expect(result.isError).toBeUndefined();
      const parsed = parseResult<ParsedCreate>(result);
      expect(parsed.created).toBe(true);
      expect(parsed.edge.from_id).toBe('FR-053');
      expect(parsed.edge.to_id).toBe('FR-051');
      expect(parsed.edge.edge_type).toBe('parent_of');
      expect(parsed.edge.confidence).toBe(1.0);
      expect(parsed.edge.provenance).toBe('observed');
      expect(parsed.edge.metadata).toBe('{}');
    });

    it('returns created=false on duplicate (UNIQUE constraint)', () => {
      const first = parseResult<ParsedCreate>(
        handleEdgeCreate({
          from_type: 'brief',
          from_id: 'A',
          to_type: 'brief',
          to_id: 'B',
          edge_type: 'depends_on',
        }),
      );

      const second = parseResult<ParsedCreate>(
        handleEdgeCreate({
          from_type: 'brief',
          from_id: 'A',
          to_type: 'brief',
          to_id: 'B',
          edge_type: 'depends_on',
        }),
      );

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);

      // Confirm only one row in the DB
      const count = db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number };
      expect(count.n).toBe(1);
    });

    it('treats different edge_types between same nodes as distinct', () => {
      handleEdgeCreate({
        from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'B',
        edge_type: 'depends_on',
      });
      handleEdgeCreate({
        from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'B',
        edge_type: 'related_to',
      });

      const count = db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number };
      expect(count.n).toBe(2);
    });

    it('clamps confidence into [0, 1]', () => {
      const tooHigh = parseResult<ParsedCreate>(
        handleEdgeCreate({
          from_type: 'brief', from_id: 'X1', to_type: 'brief', to_id: 'Y1',
          edge_type: 'related_to', confidence: 5,
        }),
      );
      const tooLow = parseResult<ParsedCreate>(
        handleEdgeCreate({
          from_type: 'brief', from_id: 'X2', to_type: 'brief', to_id: 'Y2',
          edge_type: 'related_to', confidence: -1,
        }),
      );

      expect(tooHigh.edge.confidence).toBe(1.0);
      expect(tooLow.edge.confidence).toBe(0);
    });

    it('persists metadata as JSON', () => {
      const result = parseResult<ParsedCreate>(
        handleEdgeCreate({
          from_type: 'brief', from_id: 'M1', to_type: 'brief', to_id: 'M2',
          edge_type: 'related_to',
          metadata: { source: 'test', confidence_note: 'manual' },
        }),
      );

      const parsedMeta = JSON.parse(result.edge.metadata) as Record<string, unknown>;
      expect(parsedMeta.source).toBe('test');
      expect(parsedMeta.confidence_note).toBe('manual');
    });

    it('rejects self-loops for non-recurrence edge types', () => {
      const result = handleEdgeCreate({
        from_type: 'brief', from_id: 'SELF', to_type: 'brief', to_id: 'SELF',
        edge_type: 'parent_of',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Self-loops');
    });

    it('allows self-loops for recurs_with', () => {
      const result = handleEdgeCreate({
        from_type: 'error', from_id: 'E-1', to_type: 'error', to_id: 'E-1',
        edge_type: 'recurs_with',
      });

      expect(result.isError).toBeUndefined();
      const parsed = parseResult<ParsedCreate>(result);
      expect(parsed.created).toBe(true);
    });

    it('rejects unknown edge_type', () => {
      const result = handleEdgeCreate({
        from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'B',
        edge_type: 'invented_relation',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid edge_type');
    });

    it('rejects unknown from_type / to_type', () => {
      const result = handleEdgeCreate({
        from_type: 'asteroid', from_id: 'A', to_type: 'brief', to_id: 'B',
        edge_type: 'related_to',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid from_type');
    });

    it('rejects missing required fields', () => {
      const result = handleEdgeCreate({
        from_type: 'brief',
        // from_id missing
        to_type: 'brief',
        to_id: 'B',
        edge_type: 'related_to',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required fields');
    });

    it('accepts every edge type from the catalog', () => {
      for (const edgeType of VALID_EDGE_TYPES) {
        // Use distinct nodes per iteration so UNIQUE doesn't conflict.
        // recurs_with uses a self-loop because that's its semantic case.
        const fromId = `N-${edgeType}-A`;
        const toId = edgeType === 'recurs_with' ? fromId : `N-${edgeType}-B`;
        const fromType = edgeType === 'recurs_with' ? 'error' : 'brief';
        const toType = edgeType === 'serves_goal' ? 'goal' : fromType;

        const result = handleEdgeCreate({
          from_type: fromType,
          from_id: fromId,
          to_type: toType,
          to_id: toId,
          edge_type: edgeType,
        });
        expect(result.isError, `edge_type=${edgeType}`).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // handleEdgeList
  // -------------------------------------------------------------------------

  describe('handleEdgeList', () => {
    beforeEach(() => {
      handleEdgeCreate({ from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'B', edge_type: 'parent_of' });
      handleEdgeCreate({ from_type: 'brief', from_id: 'A', to_type: 'brief', to_id: 'C', edge_type: 'depends_on' });
      handleEdgeCreate({ from_type: 'brief', from_id: 'D', to_type: 'brief', to_id: 'B', edge_type: 'parent_of' });
      handleEdgeCreate({
        from_type: 'brief', from_id: 'E', to_type: 'brief', to_id: 'F',
        edge_type: 'related_to', confidence: 0.4, provenance: 'inferred',
      });
    });

    it('returns all edges with no filter', () => {
      const parsed = parseResult<{ edges: unknown[]; total: number }>(handleEdgeList({}));
      expect(parsed.total).toBe(4);
      expect(parsed.edges).toHaveLength(4);
    });

    it('filters by from_type + from_id', () => {
      const parsed = parseResult<{ edges: { from_id: string }[]; total: number }>(
        handleEdgeList({ from_type: 'brief', from_id: 'A' }),
      );
      expect(parsed.total).toBe(2);
      for (const edge of parsed.edges) expect(edge.from_id).toBe('A');
    });

    it('filters by edge_type', () => {
      const parsed = parseResult<{ edges: { edge_type: string }[] }>(
        handleEdgeList({ edge_type: 'parent_of' }),
      );
      expect(parsed.edges).toHaveLength(2);
      for (const edge of parsed.edges) expect(edge.edge_type).toBe('parent_of');
    });

    it('combines from_id and edge_type filters', () => {
      const parsed = parseResult<{ edges: unknown[] }>(
        handleEdgeList({ from_type: 'brief', from_id: 'A', edge_type: 'depends_on' }),
      );
      expect(parsed.edges).toHaveLength(1);
    });

    it('filters by min_confidence', () => {
      const parsed = parseResult<{ edges: { confidence: number }[] }>(
        handleEdgeList({ min_confidence: 0.5 }),
      );
      // 3 edges at 1.0, 1 at 0.4 -> only 3 should match
      expect(parsed.edges).toHaveLength(3);
      for (const edge of parsed.edges) expect(edge.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('filters by provenance', () => {
      const parsed = parseResult<{ edges: { provenance: string }[] }>(
        handleEdgeList({ provenance: 'inferred' }),
      );
      expect(parsed.edges).toHaveLength(1);
      expect(parsed.edges[0].provenance).toBe('inferred');
    });

    it('rejects min_confidence outside [0, 1]', () => {
      const result = handleEdgeList({ min_confidence: 1.5 });
      expect(result.isError).toBe(true);
    });

    it('rejects unknown edge_type filter', () => {
      const result = handleEdgeList({ edge_type: 'totally-fake' });
      expect(result.isError).toBe(true);
    });

    it('honors pagination (limit/offset)', () => {
      const page1 = parseResult<{ edges: unknown[]; total: number }>(
        handleEdgeList({ limit: 2, offset: 0 }),
      );
      const page2 = parseResult<{ edges: unknown[]; total: number }>(
        handleEdgeList({ limit: 2, offset: 2 }),
      );
      expect(page1.total).toBe(4);
      expect(page1.edges).toHaveLength(2);
      expect(page2.edges).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // handleEdgeRemove
  // -------------------------------------------------------------------------

  describe('handleEdgeRemove', () => {
    it('soft-deletes by default and excludes from list', () => {
      const created = parseResult<ParsedCreate>(
        handleEdgeCreate({
          from_type: 'brief', from_id: 'X', to_type: 'brief', to_id: 'Y',
          edge_type: 'related_to',
        }),
      );

      const removed = parseResult<{ removed: boolean; soft: boolean }>(
        handleEdgeRemove({ id: created.id }),
      );
      expect(removed.removed).toBe(true);
      expect(removed.soft).toBe(true);

      // Default list excludes soft-deleted edges
      const visible = parseResult<{ edges: unknown[] }>(handleEdgeList({}));
      expect(visible.edges).toHaveLength(0);

      // include_deleted=true brings them back
      const all = parseResult<{ edges: unknown[] }>(
        handleEdgeList({ include_deleted: true }),
      );
      expect(all.edges).toHaveLength(1);
    });

    it('hard-deletes when hard=true', () => {
      const created = parseResult<ParsedCreate>(
        handleEdgeCreate({
          from_type: 'brief', from_id: 'H1', to_type: 'brief', to_id: 'H2',
          edge_type: 'related_to',
        }),
      );

      const removed = parseResult<{ removed: boolean; soft: boolean }>(
        handleEdgeRemove({ id: created.id, hard: true }),
      );
      expect(removed.removed).toBe(true);
      expect(removed.soft).toBe(false);

      const count = db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number };
      expect(count.n).toBe(0);
    });

    it('returns isError when id does not exist', () => {
      const result = handleEdgeRemove({ id: 9999 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Edge not found');
    });

    it('rejects non-integer ids', () => {
      const result = handleEdgeRemove({ id: 'abc' });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Schema migration idempotency
  // -------------------------------------------------------------------------

  describe('schema migration idempotency', () => {
    it('re-running migration is a no-op', () => {
      // Run migration a second time on the existing db — should not throw.
      for (const migration of edgeMigrations) {
        expect(() => db.exec(migration.sql)).not.toThrow();
      }

      // FR-105 ships 3 indexes; FR-113 v2 migration adds the compound index.
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entity_edges' AND name NOT LIKE 'sqlite_autoindex_%'",
        )
        .all() as { name: string }[];
      const names = indexes.map((i) => i.name).sort();
      expect(names).toEqual([
        'idx_edges_compound',
        'idx_edges_from',
        'idx_edges_to',
        'idx_edges_type',
      ]);
    });

    it('UNIQUE constraint enforces (from_type,from_id,to_type,to_id,edge_type)', () => {
      handleEdgeCreate({
        from_type: 'brief', from_id: 'U1', to_type: 'brief', to_id: 'U2',
        edge_type: 'related_to',
      });
      // Direct INSERT (bypassing the handler's INSERT OR IGNORE) should fail
      expect(() => {
        db.prepare(
          `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
           VALUES (?, ?, ?, ?, ?)`,
        ).run('brief', 'U1', 'brief', 'U2', 'related_to');
      }).toThrow();
    });
  });
});
