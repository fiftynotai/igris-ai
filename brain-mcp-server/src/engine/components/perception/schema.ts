/**
 * Brain Engine v5.0 — Perception Component Schema (FR-109)
 *
 * Database migrations specific to the perception channel. The
 * `learnings.review_status` column is added in `db.ts` v15 — global,
 * shared with the conscious channel. This module owns only the
 * watermark table.
 *
 * Idempotent via IF NOT EXISTS; safe to re-run.
 *
 * @module engine/components/perception/schema
 * @author Fifty.ai
 */

import type { Migration } from '../../types.js';

/**
 * Perception schema migrations.
 *
 * Version 1: `perception_watermarks` per-project last-extracted-at table.
 *   The runner reads/writes this table to bound transcript ingest windows;
 *   the hook writes inbox files which the runner drains and clamps to
 *   `last_extracted_at..now()`. Working table (re-derivable from session
 *   transcripts), so it is not added to SYNC_TABLES.
 *
 * Version 2 (TD-086): cheap-dedup tracking columns on `learnings`.
 *   Adds `seen_again_count INTEGER` and `last_seen_at TEXT` so the runner
 *   can record perception-side rediscoveries (cosine ≥ threshold against
 *   any existing learning, status-aware) without inserting duplicate
 *   pending_review rows. The columns belong semantically to the perception
 *   channel (forensic counters of "how often the LLM re-extracted this"),
 *   so the migration lives here even though the table is owned by `db.ts`
 *   v1 and extended by `db.ts` v15 (review_status). Cross-component
 *   ALTER TABLE is the established pattern (see db.ts v15).
 *
 *   These columns are intentionally EXCLUDED from SYNC_TABLES (`tools/sync.ts`)
 *   — rediscovery counts are per-machine usage signals; LWW-summing them
 *   across machines would be wrong. The conscious-channel content (title,
 *   content, embedding) is what syncs.
 *
 *   Defensive: ALTER TABLE ADD COLUMN cannot use IF NOT EXISTS in SQLite,
 *   but the migration runner tracks per-component versions in
 *   `engine_migrations` and only applies each version once. The CREATE INDEX
 *   uses IF NOT EXISTS so re-runs (or hand-rolled column adds) do not fail.
 *
 *   TODO(FR-116): when soft-delete (`deleted_at`) ships on `learnings`, the
 *   dedup helper should add `WHERE deleted_at IS NULL` to its lookup; this
 *   migration does not need to change.
 */
export const perceptionMigrations: Migration[] = [
  {
    version: 1,
    description:
      'Create perception_watermarks for per-project transcript ingest tracking (FR-109)',
    sql: `
      CREATE TABLE IF NOT EXISTS perception_watermarks (
        project TEXT PRIMARY KEY,
        last_extracted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 2,
    description:
      'TD-086 cheap-dedup tracking columns: learnings.seen_again_count + last_seen_at + partial index',
    sql: `
      ALTER TABLE learnings ADD COLUMN seen_again_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE learnings ADD COLUMN last_seen_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_learnings_seen_again
        ON learnings(seen_again_count) WHERE seen_again_count > 0;
    `,
  },
];
