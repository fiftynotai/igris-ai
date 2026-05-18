/**
 * Sessions Component — schema migration tests (FR-130)
 *
 * Verifies the sessions component's migrations:
 *   - v1 builds `session_files` with its original 6 columns.
 *   - v2 adds `instance_id` + `state` (per-instance keying + 3-state
 *     lifecycle) and the 2 lookup indexes.
 *   - v2 is idempotent: re-running the migration set never re-applies the
 *     non-`IF NOT EXISTS` `ALTER ADD COLUMN`s (the runner skips applied
 *     versions, recorded in `engine_migrations`).
 *   - The `state` CHECK + DEFAULT behave as specified.
 *   - N concurrent per-instance writes (distinct filenames) do not clobber.
 *
 * Uses the real `createSqliteAdapter` + `runMigrations` so the idempotency
 * assertion exercises the production migration runner, not a bare
 * `db.exec` loop.
 *
 * @module engine/components/sessions/__tests__/schema.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSqliteAdapter } from '../../../storage/sqlite.js';
import type { StorageAdapter } from '../../../types.js';
import { sessionMigrations } from '../schema.js';

// Mock the db module so handleSessionFileUpdate resolves getDb() to our
// in-memory adapter's raw connection.
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import { handleSessionFileUpdate } from '../../../../tools/sessions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

interface IndexInfo {
  name: string;
}

function columnNames(adapter: StorageAdapter): string[] {
  const info = adapter.pragma('table_info(session_files)') as ColumnInfo[];
  return info.map((c) => c.name);
}

function indexNames(adapter: StorageAdapter): string[] {
  const info = adapter.pragma('index_list(session_files)') as IndexInfo[];
  return info.map((i) => i.name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sessions schema migrations (FR-130)', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSqliteAdapter(':memory:');
    vi.mocked(getDb).mockReturnValue(adapter.rawConnection);
  });

  afterEach(() => {
    adapter.close();
    vi.clearAllMocks();
  });

  describe('group 1 — v1 + v2 apply cleanly', () => {
    it('produces all 8 expected columns', () => {
      adapter.runMigrations('sessions', sessionMigrations);
      const cols = columnNames(adapter);
      expect(cols).toEqual(
        expect.arrayContaining([
          'id',
          'project',
          'filename',
          'content',
          'content_hash',
          'updated_at',
          'instance_id',
          'state',
        ]),
      );
      expect(cols).toHaveLength(8);
    });
  });

  describe('group 2 — state CHECK + default', () => {
    beforeEach(() => {
      adapter.runMigrations('sessions', sessionMigrations);
    });

    it("defaults state to 'live' when omitted on insert", () => {
      adapter
        .prepare(
          `INSERT INTO session_files (id, project, filename, content, content_hash)
           VALUES ('s1', 'proj', 'a.md', 'body', 'hash')`,
        )
        .run();
      const row = adapter
        .prepare(`SELECT state FROM session_files WHERE id = 's1'`)
        .get() as { state: string };
      expect(row.state).toBe('live');
    });

    it('rejects an out-of-domain state via the CHECK constraint', () => {
      expect(() =>
        adapter
          .prepare(
            `INSERT INTO session_files (id, project, filename, content, content_hash, state)
             VALUES ('s2', 'proj', 'b.md', 'body', 'hash', 'bogus')`,
          )
          .run(),
      ).toThrow(/CHECK constraint/i);
    });

    it("accepts all three valid states ('live', 'rested', 'archived')", () => {
      for (const [i, state] of (['live', 'rested', 'archived'] as const).entries()) {
        expect(() =>
          adapter
            .prepare(
              `INSERT INTO session_files (id, project, filename, content, content_hash, state)
               VALUES (?, 'proj', ?, 'body', 'hash', ?)`,
            )
            .run(`ok-${i}`, `valid-${i}.md`, state),
        ).not.toThrow();
      }
    });
  });

  describe('group 3 — v2 idempotency', () => {
    it('re-running the migration set does not re-apply ALTER ADD COLUMN', () => {
      adapter.runMigrations('sessions', sessionMigrations);
      // A naive re-run would throw "duplicate column name" on the
      // non-IF-NOT-EXISTS ALTERs. The runner records sessions@2 and skips it.
      expect(() => adapter.runMigrations('sessions', sessionMigrations)).not.toThrow();

      const cols = columnNames(adapter);
      // Each new column appears exactly once.
      expect(cols.filter((c) => c === 'instance_id')).toHaveLength(1);
      expect(cols.filter((c) => c === 'state')).toHaveLength(1);
    });
  });

  describe('group 4 — indexes exist', () => {
    it('creates idx_session_files_instance and idx_session_files_state', () => {
      adapter.runMigrations('sessions', sessionMigrations);
      const idx = indexNames(adapter);
      expect(idx).toContain('idx_session_files_instance');
      expect(idx).toContain('idx_session_files_state');
    });
  });

  describe('group 5 — concurrent N-instance writes do not clobber', () => {
    beforeEach(() => {
      adapter.runMigrations('sessions', sessionMigrations);
    });

    it('keeps N distinct rows when N instances write distinct filenames', () => {
      const instances = [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444',
        '55555555-5555-5555-5555-555555555555',
      ];

      for (const id of instances) {
        handleSessionFileUpdate({
          project: 'multi-harness',
          filename: `instances/${id}.md`,
          content: `state owned by ${id}`,
          instance_id: id,
        });
      }

      const rows = adapter
        .prepare(
          `SELECT filename, content, instance_id FROM session_files
           WHERE project = 'multi-harness' ORDER BY filename`,
        )
        .all() as { filename: string; content: string; instance_id: string }[];

      expect(rows).toHaveLength(instances.length);
      // Each row carries its own writer's content — no overwrite.
      for (const row of rows) {
        expect(row.content).toBe(`state owned by ${row.instance_id}`);
        expect(row.filename).toBe(`instances/${row.instance_id}.md`);
      }
    });

    it('upserts in place when the same filename is re-written', () => {
      const id = '11111111-1111-1111-1111-111111111111';
      const filename = `instances/${id}.md`;

      handleSessionFileUpdate({
        project: 'multi-harness',
        filename,
        content: 'first',
        instance_id: id,
      });
      handleSessionFileUpdate({
        project: 'multi-harness',
        filename,
        content: 'second',
        instance_id: id,
      });

      const rows = adapter
        .prepare(
          `SELECT content FROM session_files WHERE project = 'multi-harness' AND filename = ?`,
        )
        .all(filename) as { content: string }[];

      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe('second');
    });
  });
});
