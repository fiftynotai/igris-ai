/**
 * Brain Engine v7.0 — Subconscious Component Schema
 *
 * Database migrations for FR-106. Phase 1 shipped two tables in a single v1
 * migration:
 *   - `suggestions` — canonical store for queued findings
 *   - `dismissed_patterns` — UPSERT-target for the dismiss-reason learning
 *     loop (Q3=B in the FR-106 plan answers).
 *
 * Phase 2 adds `pattern_observations` for multi-run smoothing of the
 * pattern detector (v2).
 *
 * Idempotent via IF NOT EXISTS; safe to re-run.
 *
 * @module engine/components/subconscious/schema
 * @author fifty.dev
 */

import type { Migration } from '../../types.js';

/**
 * Subconscious schema migrations.
 *
 * Version 1: suggestions + dismissed_patterns + 5 indexes.
 *   The composite UNIQUE on `dismissed_patterns(source_module,
 *   project_slug, evidence_signature)` is what allows the dismiss-loop
 *   UPSERT to be a single INSERT ... ON CONFLICT statement. Note that
 *   SQLite treats NULL as distinct in UNIQUE constraints, which is fine
 *   here: we always serialize the project_slug to a stable empty-string
 *   sentinel before persisting to avoid that quirk (see runner.ts).
 *
 * Version 2 (FR-106 Phase 2): pattern_observations + 2 indexes.
 *   The pattern detector's 3-run smoothing gate reads
 *   `COUNT(DISTINCT run_id) WHERE pattern_key = ? AND observed_at within
 *   pattern_smoothing_window_days`. Working table — auto-pruned in
 *   `runner.ts:expireStaleRows` based on `pattern_observation_ttl_days`.
 *   Not added to SYNC_TABLES (re-derivable from raw aggregations on the
 *   next run; no cross-machine merge value).
 */
export const subconsciousMigrations: Migration[] = [
  {
    version: 1,
    description:
      'Create suggestions and dismissed_patterns tables with lookup indexes (FR-106 Phase 1)',
    sql: `
      CREATE TABLE IF NOT EXISTS suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_module TEXT NOT NULL
          CHECK (source_module IN ('stalled', 'conflict', 'gap', 'pattern')),
        project_slug TEXT,
        title TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '{}',
        priority TEXT NOT NULL DEFAULT 'medium'
          CHECK (priority IN ('high', 'medium', 'low')),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'dismissed', 'acted')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,
        dismissed_at TEXT,
        dismissed_reason TEXT,
        acted_at TEXT,
        acted_brief_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);
      CREATE INDEX IF NOT EXISTS idx_suggestions_project ON suggestions(project_slug);
      CREATE INDEX IF NOT EXISTS idx_suggestions_priority ON suggestions(priority);

      CREATE TABLE IF NOT EXISTS dismissed_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_module TEXT NOT NULL,
        project_slug TEXT NOT NULL DEFAULT '',
        evidence_signature TEXT NOT NULL,
        dismiss_count INTEGER NOT NULL DEFAULT 1,
        last_dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
        reasons TEXT NOT NULL DEFAULT '[]',
        UNIQUE(source_module, project_slug, evidence_signature)
      );

      CREATE INDEX IF NOT EXISTS idx_dismissed_patterns_lookup
        ON dismissed_patterns(source_module, project_slug, evidence_signature);
    `,
  },
  {
    version: 2,
    description:
      'Add pattern_observations working table for multi-run smoothing (FR-106 Phase 2)',
    sql: `
      CREATE TABLE IF NOT EXISTS pattern_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        observed_at TEXT NOT NULL DEFAULT (datetime('now')),
        effect_size REAL NOT NULL,
        sample_size INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_pattern_observations_key
        ON pattern_observations(pattern_key, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pattern_observations_run
        ON pattern_observations(run_id);
    `,
  },
];
