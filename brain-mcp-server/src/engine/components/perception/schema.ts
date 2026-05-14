/**
 * Brain Engine v7.0 — Perception Component Schema (FR-109)
 *
 * Database migrations specific to the perception channel. The
 * `learnings.review_status` column is added in `db.ts` v15 — global,
 * shared with the conscious channel. This module owns only the
 * watermark table.
 *
 * Idempotent via IF NOT EXISTS; safe to re-run.
 *
 * @module engine/components/perception/schema
 * @author fifty.dev
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
 *
 * Version 3 (TD-098): drop the `learnings_vec_ad` AFTER DELETE trigger.
 *   The trigger executes `DELETE FROM learnings_vec WHERE rowid = old.id`
 *   from inside trigger context, which sqlite-vec's `vec0` virtual table
 *   rejects with `unsafe use of virtual table "learnings_vec"` whenever
 *   the connection has `PRAGMA trusted_schema = OFF` (which production
 *   sets in db.ts:868 for security hygiene). The empirically-verified
 *   consequence: every `igris_perception_reject` and
 *   `igris_perception_expire_stale` invocation against the production DB
 *   raised that error, blocking the perception review loop entirely.
 *
 *   Phase 0 isolation testing (Path A1) confirmed that the FTS5
 *   `learnings_ad` trigger does NOT trip the same guard — the FTS5
 *   contentless-table 'delete' command is allowed from trigger context.
 *   Only `learnings_vec_ad` is the offender, so this migration drops
 *   ONLY that trigger. `learnings_ad` (and `learnings_ai`/`learnings_au`)
 *   remain in place; FTS5 cleanup continues to fire automatically.
 *
 *   The `handlePerceptionReject` and `handlePerceptionExpireStale` MCP
 *   handlers in `perception/handlers.ts` now own explicit transactional
 *   cleanup of `learnings_vec` via a private `cleanupLearningArtifacts`
 *   helper, wrapping the vec delete + the learnings delete in a single
 *   `db.transaction(() => {...})()` block. The helper try/catches the
 *   vec delete so test fixtures lacking sqlite-vec do not regress.
 *
 *   The migration lives here (perception/schema.ts) rather than db.ts
 *   per L-142 (component-owned migration on a globally-shared table):
 *   the trigger is logically owned by the perception delete path now
 *   that the conscious channel never DELETEs from learnings (see audit
 *   in handlers.ts), and any future re-introduction of vec0 cleanup
 *   logic for other channels should follow the same handler-owned
 *   pattern rather than re-introducing the trigger.
 *
 *   Idempotency: `DROP TRIGGER IF EXISTS` is a no-op if absent (e.g. on
 *   a fresh DB built after this migration ships and never had v10's
 *   trigger), so re-running this migration after a manual schema fix is
 *   safe. The migration runner's per-component version tracking in
 *   `engine_migrations` prevents normal re-application anyway.
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
  {
    version: 3,
    description:
      'TD-098 drop learnings_vec_ad trigger; handlers own transactional vec cleanup',
    sql: `
      DROP TRIGGER IF EXISTS learnings_vec_ad;
    `,
  },
];
