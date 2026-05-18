/**
 * Briefs Component — schema migration tests (FR-127)
 *
 * Verifies the briefs component's migrations:
 *   - v1 builds `brief_files` with its original 7 columns.
 *   - v2 adds `claimed_by` + `claimed_at` to `brief_status` (the atomic
 *     brief-claim gate) and the `idx_brief_status_claimed_by` index.
 *   - v2 is idempotent: re-running the migration set never re-applies the
 *     non-`IF NOT EXISTS` `ALTER ADD COLUMN`s (the runner skips applied
 *     versions, recorded in `engine_migrations`).
 *   - Existing `brief_status` rows read `claimed_by`/`claimed_at` NULL after
 *     v2 — no backfill needed, NULL/NULL is the correct "unclaimed" state.
 *
 * `brief_status` is created by legacy `db.ts` `migrateSchema()` (schema_version
 * v2), which runs BEFORE component migrations. The test reproduces that
 * ordering by creating `brief_status` first, then running `briefMigrations`.
 *
 * Uses the real `createSqliteAdapter` + `runMigrations` so the idempotency
 * assertion exercises the production migration runner, not a bare `db.exec`
 * loop. Mirrors `sessions/__tests__/schema.test.ts` (FR-130).
 *
 * @module engine/components/briefs/__tests__/schema.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSqliteAdapter } from '../../../storage/sqlite.js';
import type { StorageAdapter } from '../../../types.js';
import { briefMigrations } from '../schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ColumnInfo {
  name: string;
}

interface IndexInfo {
  name: string;
}

/**
 * Legacy `brief_status` DDL — byte-equivalent to `db.ts` schema_version v2.
 * The briefs component's v2 migration only ALTERs this table; it does not
 * create it. The test reproduces the boot ordering (legacy migrateSchema
 * before component migrations) by creating it up front.
 */
const LEGACY_BRIEF_STATUS_DDL = `
  CREATE TABLE IF NOT EXISTS brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_type TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      effort TEXT,
      phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_status_unique ON brief_status(project, brief_id);
`;

function columnNames(adapter: StorageAdapter, table: string): string[] {
  const info = adapter.pragma(`table_info(${table})`) as ColumnInfo[];
  return info.map((c) => c.name);
}

function indexNames(adapter: StorageAdapter, table: string): string[] {
  const info = adapter.pragma(`index_list(${table})`) as IndexInfo[];
  return info.map((i) => i.name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('briefs schema migrations (FR-127)', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createSqliteAdapter(':memory:');
    // Reproduce boot ordering: legacy brief_status exists before briefs@2.
    adapter.exec(LEGACY_BRIEF_STATUS_DDL);
  });

  afterEach(() => {
    adapter.close();
  });

  describe('group 1 — v1 builds brief_files', () => {
    it('produces all 7 expected brief_files columns', () => {
      adapter.runMigrations('briefs', briefMigrations);
      const cols = columnNames(adapter, 'brief_files');
      expect(cols).toEqual(
        expect.arrayContaining([
          'id',
          'project',
          'brief_id',
          'filename',
          'content',
          'content_hash',
          'updated_at',
        ]),
      );
      expect(cols).toHaveLength(7);
    });
  });

  describe('group 2 — v2 adds claim columns to brief_status', () => {
    beforeEach(() => {
      adapter.runMigrations('briefs', briefMigrations);
    });

    it('adds claimed_by and claimed_at columns', () => {
      const cols = columnNames(adapter, 'brief_status');
      expect(cols).toContain('claimed_by');
      expect(cols).toContain('claimed_at');
    });

    it('creates the idx_brief_status_claimed_by index', () => {
      const idx = indexNames(adapter, 'brief_status');
      expect(idx).toContain('idx_brief_status_claimed_by');
    });

    it('reads claimed_by/claimed_at NULL for a row inserted after v2 (unclaimed default)', () => {
      adapter
        .prepare(
          `INSERT INTO brief_status (project, brief_id, title, status)
           VALUES ('proj', 'FR-001', 'Test brief', 'Ready')`,
        )
        .run();
      const row = adapter
        .prepare(`SELECT claimed_by, claimed_at FROM brief_status WHERE brief_id = 'FR-001'`)
        .get() as { claimed_by: string | null; claimed_at: string | null };
      expect(row.claimed_by).toBeNull();
      expect(row.claimed_at).toBeNull();
    });
  });

  describe('group 3 — existing rows survive v2 with NULL claim columns', () => {
    it('an existing brief_status row reads claimed_by/claimed_at NULL after v2 (no backfill)', () => {
      // Insert BEFORE the briefs migrations run — simulates a pre-FR-127 row.
      adapter
        .prepare(
          `INSERT INTO brief_status (project, brief_id, title, status)
           VALUES ('proj', 'FR-000', 'Pre-existing brief', 'Done')`,
        )
        .run();

      adapter.runMigrations('briefs', briefMigrations);

      const row = adapter
        .prepare(`SELECT claimed_by, claimed_at FROM brief_status WHERE brief_id = 'FR-000'`)
        .get() as { claimed_by: string | null; claimed_at: string | null };
      expect(row.claimed_by).toBeNull();
      expect(row.claimed_at).toBeNull();
    });
  });

  describe('group 4 — v2 idempotency', () => {
    it('re-running the migration set does not re-apply ALTER ADD COLUMN', () => {
      adapter.runMigrations('briefs', briefMigrations);
      // A naive re-run would throw "duplicate column name" on the
      // non-IF-NOT-EXISTS ALTERs. The runner records briefs@2 and skips it.
      expect(() => adapter.runMigrations('briefs', briefMigrations)).not.toThrow();

      const cols = columnNames(adapter, 'brief_status');
      // Each new column appears exactly once.
      expect(cols.filter((c) => c === 'claimed_by')).toHaveLength(1);
      expect(cols.filter((c) => c === 'claimed_at')).toHaveLength(1);
    });
  });
});
