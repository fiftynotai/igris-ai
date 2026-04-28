/**
 * Brain Engine v5.0 — Goals Component Schema
 *
 * Database migrations for the goals (outcome-level entities) component.
 * Creates the `goals` table with a UNIQUE constraint on `goal_id` and
 * three lookup indexes (project, status, deadline). The deadline index
 * is partial: only active goals carry deadlines worth indexing for the
 * "approaching deadline" surface in /awaken.
 *
 * Design note (FR-110): the brief originally proposed adding migration
 * v15 to `db.ts`. The engine has since switched to per-component
 * migrations recorded in the `engine_migrations` table (see
 * `engine/storage/sqlite.ts`). Goals therefore ship migration v1 inside
 * the component, NOT in db.ts — this matches the FR-105 edges pattern
 * and keeps schema ownership encapsulated.
 *
 * @module engine/components/goals/schema
 * @author Fifty.ai
 */

import type { Migration } from '../../types.js';

/**
 * Goals schema migrations.
 *
 * Version 1: goals table + 3 indexes (project, status, partial deadline).
 *   Idempotent via IF NOT EXISTS on every DDL statement, safe to re-run.
 */
export const goalMigrations: Migration[] = [
  {
    version: 1,
    description: 'Create goals table with UNIQUE goal_id, status CHECK, and 3 lookup indexes',
    sql: `
      CREATE TABLE IF NOT EXISTS goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL UNIQUE,
        project_slug TEXT,
        title TEXT NOT NULL,
        description TEXT,
        outcome TEXT NOT NULL,
        deadline TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'achieved', 'abandoned', 'deferred')),
        priority TEXT NOT NULL DEFAULT 'P2-Medium',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        achieved_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project_slug);
      CREATE INDEX IF NOT EXISTS idx_goals_status  ON goals(status);
      CREATE INDEX IF NOT EXISTS idx_goals_deadline ON goals(deadline)
        WHERE status = 'active';
    `,
  },
];
