/**
 * Brain Engine v7.0 — Briefs Component Schema
 *
 * Database migrations for the briefs component.
 *
 * Version 1 creates the `brief_files` table (idempotent with the legacy
 * v6 inline DDL — every existing brain DB already records `briefs@1`, so
 * v1 never re-runs there; it survives only so a fresh DB still builds the
 * table). It is byte-equivalent to the literal previously inlined in
 * `index.ts`'s `schema()`.
 *
 * Version 2 (FR-127) adds `claimed_by` + `claimed_at` to `brief_status` —
 * the atomic brief-claim gate. `brief_status` itself is created by the
 * legacy `db.ts` `migrateSchema()` (schema_version v2), which `bootEngine()`
 * runs BEFORE component migrations; so by the time `briefs@2` runs, the
 * table already exists and the `ALTER` targets it safely.
 *
 * Design note (L-142): the owning component owns its ALTERs. The engine
 * migration runner (`engine/storage/sqlite.ts`) tracks per-component
 * versions in `engine_migrations` and applies only migrations with
 * `version > currentVersion`, each wrapped in its own transaction. This
 * matches the `sessions/schema.ts` and `tasks/schema.ts` pattern.
 *
 * @module engine/components/briefs/schema
 * @author fifty.dev
 */

import type { Migration } from '../../types.js';

/**
 * Briefs schema migrations.
 *
 * Version 1: brief_files table + project index (idempotent with legacy v6).
 * Version 2: claimed_by + claimed_at columns on brief_status — the FR-127
 *            atomic brief-claim gate.
 */
export const briefMigrations: Migration[] = [
  {
    version: 1,
    description: 'Create brief_files table (idempotent with legacy v6)',
    sql: `
            CREATE TABLE IF NOT EXISTS brief_files (
              id TEXT PRIMARY KEY,
              project TEXT NOT NULL,
              brief_id TEXT NOT NULL,
              filename TEXT NOT NULL,
              content TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              UNIQUE(project, brief_id)
            );
            CREATE INDEX IF NOT EXISTS idx_brief_files_project ON brief_files(project);
          `,
  },
  {
    version: 2,
    description: 'Add claimed_by + claimed_at to brief_status (FR-127 atomic claim gate)',
    sql: `
      -- FR-127: brief_status gains a nullable claim pair. Plain ALTER ADD
      -- COLUMN — both columns are nullable with no DEFAULT, so no table
      -- rebuild and no backfill: every existing row reads NULL/NULL
      -- (= unclaimed), which is the correct initial state.
      ALTER TABLE brief_status ADD COLUMN claimed_by TEXT;
      ALTER TABLE brief_status ADD COLUMN claimed_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_brief_status_claimed_by ON brief_status(claimed_by);
    `,
  },
];
