/**
 * Brain Engine v7.1 — Janitor Component Schema (FR-119).
 *
 * Unlike synapse (which reused existing tables and declared `schema(): []`), the
 * janitor OWNS one new table and extends `learnings` with two audit columns:
 *
 *   - `brain_maintenance_runs` — one row per `runJanitor` invocation with the
 *     audit counters (merges proposed/applied, confidence bumps, stale rejected,
 *     re-eval surfaced) + status/trigger/error. FR-116 will later SHARE this
 *     table (it does not exist yet — FR-119 creates it here).
 *   - `learnings.deleted_at` (TEXT) + `learnings.merged_into` (INTEGER) — the
 *     Decision-A1 audit/lineage columns stamped when a duplicate is soft-deleted
 *     by a merge. NEITHER is a recall gate: the soft-delete is done by setting
 *     `review_status='merged'`, which the ~10 `review_status='approved'` readers
 *     already exclude (KEY FINDING 3). `deleted_at` is audit-only.
 *
 * Per-component migration registry (memory #53): these are applied by
 * `storage.runMigrations('janitor', janitorMigrations)` keyed on
 * `(component, version)` in `engine_migrations` — NOT the legacy `db.ts`
 * `schema_version` chain. The `learnings` ALTER under a component key mirrors the
 * established perception pattern (`perception/schema.ts:106` adds
 * `seen_again_count`/`last_seen_at` under the 'perception' key; db.ts v15 adds
 * `review_status`). engine_migrations keyed by (component, version) keeps it
 * idempotent — a brain that already applied v1 skips it.
 *
 * ALTER TABLE ADD COLUMN cannot use IF NOT EXISTS in SQLite, but the migration
 * runner only applies each (component, version) once. The CREATE TABLE / CREATE
 * INDEX use IF NOT EXISTS so re-runs (or a hand-rolled column add) do not fail.
 *
 * NOTE (columns EXCLUDED from SYNC_TABLES): `deleted_at`/`merged_into` are
 * per-machine audit fields on `learnings`, not conscious-channel content. Like
 * perception's `seen_again_count`, they are intentionally NOT added to
 * `tools/sync.ts` SYNC_TABLES — the merge's terminal signal that DOES ride sync
 * is `review_status='merged'` (already an LWW column), stamped with `updated_at`
 * so it wins over a stale remote `'approved'` (Risk: LWW divergence, accepted).
 *
 * @module engine/components/janitor/schema
 * @author fifty.dev
 */

import type { Migration } from '../../types.js';

/**
 * Janitor schema migrations. FR-116 SHARES this component key (the docstring
 * promised it); M2 adds a v2 additive ALTER — the migration runner keys by
 * `(janitor, version)` so a live brain that already applied v1 applies ONLY v2.
 *
 * Version 1: `brain_maintenance_runs` table (+ a created-time index) and the
 *   `learnings.deleted_at` / `learnings.merged_into` audit columns (Decision A1).
 * Version 2 (FR-116 M2, Decision #8): additive audit columns —
 *   `brain_maintenance_runs.contradictions_proposed` / `.contradictions_resolved`
 *   (the arbiter counters aggregated into the shared audit row) and
 *   `learnings.superseded_by` (the AUDIT-ONLY winner id stamped when a
 *   contradiction resolution supersedes the older learning — mirrors
 *   `merged_into`; NEITHER is a recall gate, the `review_status='superseded'`
 *   value is what the ~10 `='approved'` readers auto-exclude → ZERO read-path
 *   sweep).
 * Version 3 (FR-116 M3, Decisions #1/#2/#5/#8): the outdated-pruning + UNDO infra.
 *   - `brain_maintenance_undo` — the per-learning pre-state log EVERY destructive
 *     resolver writes at apply time (Decision #2). `igris_brain_maintenance_undo`
 *     replays the inverse from it. Brand-new table; no reader today besides the
 *     undo tool.
 *   - `brain_maintenance_runs.outdated_proposed` / `.outdated_pruned` / `.undone`
 *     — the curator counters + the reversal counter aggregated into the shared
 *     audit row.
 *   - `learnings.last_reviewed_at` — AUDIT-ONLY, stamped by the curator `keep`
 *     verdict + `lower_confidence`; the deterministic staleness detector skips a
 *     row reviewed within the stale window so a kept row is not re-flagged
 *     immediately. NOT a recall gate. The `review_status='pruned'` soft-delete is
 *     what the ~10 `='approved'` readers auto-exclude → ZERO read-path sweep.
 */
export const janitorMigrations: Migration[] = [
  {
    version: 1,
    description:
      'Create brain_maintenance_runs audit table + learnings.deleted_at/merged_into audit columns (FR-119 Decision A1)',
    sql: `
      CREATE TABLE IF NOT EXISTS brain_maintenance_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        merges_proposed INTEGER NOT NULL DEFAULT 0,
        merges_applied INTEGER NOT NULL DEFAULT 0,
        confidence_bumps INTEGER NOT NULL DEFAULT 0,
        stale_rejected INTEGER NOT NULL DEFAULT 0,
        re_eval_surfaced INTEGER NOT NULL DEFAULT 0,
        trigger TEXT,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_brain_maintenance_runs_started
        ON brain_maintenance_runs(started_at DESC);

      ALTER TABLE learnings ADD COLUMN deleted_at TEXT;
      ALTER TABLE learnings ADD COLUMN merged_into INTEGER;
    `,
  },
  {
    version: 2,
    description:
      'FR-116 M2: brain_maintenance_runs.contradictions_proposed/resolved (arbiter counters) + learnings.superseded_by audit column (Decision #8)',
    sql: `
      ALTER TABLE brain_maintenance_runs ADD COLUMN contradictions_proposed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE brain_maintenance_runs ADD COLUMN contradictions_resolved INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE learnings ADD COLUMN superseded_by INTEGER;
    `,
  },
  {
    version: 3,
    description:
      'FR-116 M3: brain_maintenance_undo pre-state log (Decision #2) + brain_maintenance_runs.outdated_proposed/outdated_pruned/undone (curator counters) + learnings.last_reviewed_at (Decisions #1/#5/#8)',
    sql: `
      CREATE TABLE IF NOT EXISTS brain_maintenance_undo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        action_kind TEXT NOT NULL,
        learning_id INTEGER NOT NULL,
        related_learning_id INTEGER,
        edge_type TEXT,
        prior_review_status TEXT,
        prior_confidence REAL,
        prior_content TEXT,
        prior_seen_again_count INTEGER,
        prior_embedding_nulled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        undone_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_brain_maintenance_undo_run
        ON brain_maintenance_undo(run_id);
      CREATE INDEX IF NOT EXISTS idx_brain_maintenance_undo_learning
        ON brain_maintenance_undo(learning_id);

      ALTER TABLE brain_maintenance_runs ADD COLUMN outdated_proposed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE brain_maintenance_runs ADD COLUMN outdated_pruned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE brain_maintenance_runs ADD COLUMN undone INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE learnings ADD COLUMN last_reviewed_at TEXT;
    `,
  },
];
