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
];
