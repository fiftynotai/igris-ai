/**
 * Brain Engine v7.0 — Subconscious Component Schema
 *
 * Database migrations for FR-106. Phase 1 shipped two tables in a single v1
 * migration:
 *   - `suggestions` — canonical store for queued findings
 *   - `dismissed_patterns` — UPSERT-target for the dismiss-reason learning
 *     loop (Q3=B in the FR-106 plan answers).
 *
 * Phase 2 added `pattern_observations` for multi-run smoothing of the
 * pattern detector (v2). FR-118 M4b DROPS it again (v4) — the rule-detector
 * pipeline that wrote/read it is gone (the LLM subconscious instance replaced
 * it), so the table is dead.
 *
 * FR-118 M2 adds v3: the `suggestions` table is REBUILT to OPEN the
 * `source_module` CHECK (the LLM extractor emits open-typed kinds) and to add
 * the `suggested_action` / `confidence` / `type_inferred` columns the extractor
 * writes. SQLite cannot drop a CHECK constraint via ALTER, so v3 is a
 * table-rebuild (create `suggestions_new`, copy rows with `type_inferred=0`,
 * drop + rename, recreate the 3 indexes). Pulled FORWARD from M3 into M2
 * because the M2 engine cannot persist (open `source_module` + new columns)
 * without it.
 *
 * FR-118 M4b adds v4: `DROP TABLE IF EXISTS pattern_observations`. The rule
 * detectors + smoothing gate that owned it were deleted; the table is dead and
 * was never in SYNC_TABLES (nothing to migrate cross-machine). `suggestions`
 * and `dismissed_patterns` are untouched by the drop.
 *
 * Per-component migration registry (memory #53): these are applied by
 * `storage.runMigrations('subconscious', subconsciousMigrations)` keyed on
 * `(component, version)` in `engine_migrations` — NOT the legacy `db.ts`
 * `schema_version` chain. A new suggestions column belongs HERE.
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
 *   The pattern detector's 3-run smoothing gate read
 *   `COUNT(DISTINCT run_id) WHERE pattern_key = ? AND observed_at within
 *   pattern_smoothing_window_days`. Working table — never in SYNC_TABLES.
 *   DROPPED by v4 (FR-118 M4b): the smoothing gate and its readers are gone.
 *
 * Version 4 (FR-118 M4b): `DROP TABLE IF EXISTS pattern_observations`.
 *   Idempotent; safe on a brain that never applied v2 (the table is simply
 *   absent). `suggestions` / `dismissed_patterns` are not touched.
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
  {
    version: 3,
    description:
      'Rebuild suggestions: OPEN source_module + add suggested_action/confidence/type_inferred (FR-118 M2)',
    // Table-REBUILD — SQLite cannot DROP a CHECK constraint via ALTER, so we
    // create a new table without the closed `source_module` CHECK, copy every
    // existing row across (legacy rule rows get type_inferred=0, NULL action,
    // NULL confidence), drop the old table, rename, and recreate the indexes.
    //
    // `runMigrations` wraps this whole `sql` in a single db.transaction(), so
    // no explicit BEGIN/COMMIT here (and none is allowed — nested BEGIN errors).
    // `IF NOT EXISTS` on suggestions_new keeps the migration safe to re-run if a
    // prior partial apply left the scratch table behind (the version guard in
    // runMigrations normally prevents re-entry, but defence-in-depth is cheap).
    //
    // The priority + status CHECKs are PRESERVED (only source_module opens).
    sql: `
      CREATE TABLE IF NOT EXISTS suggestions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_module TEXT NOT NULL,
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
        acted_brief_id TEXT,
        confidence REAL,
        suggested_action TEXT,
        type_inferred INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO suggestions_new
        (id, source_module, project_slug, title, evidence, priority, status,
         created_at, expires_at, dismissed_at, dismissed_reason, acted_at,
         acted_brief_id, confidence, suggested_action, type_inferred)
      SELECT
        id, source_module, project_slug, title, evidence, priority, status,
        created_at, expires_at, dismissed_at, dismissed_reason, acted_at,
        acted_brief_id, NULL, NULL, 0
      FROM suggestions;

      DROP TABLE suggestions;
      ALTER TABLE suggestions_new RENAME TO suggestions;

      CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);
      CREATE INDEX IF NOT EXISTS idx_suggestions_project ON suggestions(project_slug);
      CREATE INDEX IF NOT EXISTS idx_suggestions_priority ON suggestions(priority);
    `,
  },
  {
    version: 4,
    description:
      'Drop the dead pattern_observations table — the rule-detector smoothing gate that owned it is gone (FR-118 M4b)',
    // The FR-106 pattern detector + its `runner.ts:smoothPatterns` smoothing gate
    // and `expireStaleRows` pruner were DELETED in FR-118 M4b. Nothing reads or
    // writes `pattern_observations` any more. DROP IF EXISTS so this is safe on a
    // brain that applied v2 (table present) AND on one that never did (absent).
    // `suggestions` / `dismissed_patterns` are untouched. The table was never in
    // SYNC_TABLES, so there is no cross-machine merge state to preserve.
    sql: `
      DROP TABLE IF EXISTS pattern_observations;
    `,
  },
];
