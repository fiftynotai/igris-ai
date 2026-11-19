/**
 * Brain Engine v7.0 — Schedules Component Schema
 *
 * Database migrations for the scheduling system.
 * Creates schedules and schedule_runs tables with
 * indexes for efficient querying.
 *
 * @module engine/components/schedules/schema
 * @author fifty.dev
 */

import type { Migration } from '../../types.js';

/** Survivor order within one name: enabled, latest last_run_at (NULL last), oldest created_at, id. */
const RANKED = `SELECT id, name,
  FIRST_VALUE(id) OVER w AS survivor, ROW_NUMBER() OVER w AS rn
  FROM schedules
  WINDOW w AS (PARTITION BY name ORDER BY enabled DESC, last_run_at IS NULL, last_run_at DESC, created_at ASC, id ASC)`;

/**
 * Schedule management schema migrations.
 *
 * Version 1: Core schedule tables (schedules, schedule_runs)
 * with indexes for enabled, next_run, project, schedule, status,
 * and started_at lookups.
 *
 * Version 2: Add composite index on (enabled, next_run_at) for daemon
 * polling query.
 *
 * Version 3 (TD-361): run owner stamp, one row per name, no FK orphans.
 */
export const scheduleMigrations: Migration[] = [
  {
    version: 1,
    description: 'Create schedules and schedule_runs tables',
    sql: `
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        cron_expr TEXT NOT NULL,
        handler_type TEXT NOT NULL CHECK (handler_type IN ('mcp-tool', 'shell', 'noop')),
        handler_config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        project_slug TEXT,
        tags TEXT DEFAULT '[]',
        max_retries INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER NOT NULL DEFAULT 30000,
        next_run_at TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
      CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at);
      CREATE INDEX IF NOT EXISTS idx_schedules_project ON schedules(project_slug);

      CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'timeout')),
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        duration_ms INTEGER,
        result TEXT,
        error TEXT,
        attempt INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id);
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_status ON schedule_runs(status);
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_started ON schedule_runs(started_at);
    `,
  },
  {
    version: 2,
    description: 'Add composite index for daemon polling query',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next ON schedules(enabled, next_run_at);
    `,
  },
  {
    version: 3,
    // TD-361. The legs, so the next reader does not re-derive them:
    // (1) OWNER STAMP, ALTER-only (L-53), nullable: a run is judged dead by its
    //     owner process, never by age; an old-bundle sibling still inserts the
    //     5-column form and its row lands NULL-owner (the legacy-horizon rule).
    // (2) ONE ROW PER NAME: the bootstraps de-duplicate by name while sync keyed
    //     on a per-machine random id. Losers' runs are re-pointed to the survivor
    //     BEFORE the losers are deleted, so no run cascades away.
    // (3) ORPHANS: runs whose parent a foreign_keys=OFF connection deleted are
    //     removed — exactly what ON DELETE CASCADE would have done.
    // Both tables left SYNC_TABLES in the same change: nothing re-imports a
    // duplicate, and no remote needs this schema first.
    description: 'TD-361: schedule_runs owner stamp; one schedules row per name; FK orphans removed',
    sql: `
      ALTER TABLE schedule_runs ADD COLUMN machine_id TEXT;
      ALTER TABLE schedule_runs ADD COLUMN machine_hostname TEXT;
      ALTER TABLE schedule_runs ADD COLUMN owner_pid INTEGER;
      ALTER TABLE schedule_runs ADD COLUMN owner_started_at TEXT;

      UPDATE schedule_runs
        SET schedule_id = (SELECT r.survivor FROM (${RANKED}) r WHERE r.id = schedule_runs.schedule_id)
        WHERE schedule_id IN (SELECT id FROM (${RANKED}) WHERE rn > 1);
      DELETE FROM schedules WHERE id IN (SELECT id FROM (${RANKED}) WHERE rn > 1);
      DELETE FROM schedule_runs WHERE schedule_id NOT IN (SELECT id FROM schedules);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_name ON schedules(name);
    `,
    post: (db: unknown): void => {
      const orphans = (db as { pragma: (s: string) => unknown[] }).pragma('foreign_key_check(schedule_runs)');
      console.error(`[engine] schedules@3 post-check: ${orphans.length} schedule_runs FK violation(s)`);
    },
  },
];
