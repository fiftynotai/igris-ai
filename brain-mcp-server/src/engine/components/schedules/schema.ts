/**
 * Brain Engine v7.0 — Schedules Component Schema
 *
 * Database migrations for the scheduling system.
 * Creates schedules and schedule_runs tables with
 * indexes for efficient querying.
 *
 * @module engine/components/schedules/schema
 * @author Fifty.ai
 */

import type { Migration } from '../../types.js';

/**
 * Schedule management schema migrations.
 *
 * Version 1: Core schedule tables (schedules, schedule_runs)
 * with indexes for enabled, next_run, project, schedule, status,
 * and started_at lookups.
 *
 * Version 2: Add composite index on (enabled, next_run_at) for daemon
 * polling query.
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
];
