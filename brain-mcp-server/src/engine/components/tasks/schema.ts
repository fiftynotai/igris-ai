/**
 * Brain Engine v5.0 — Tasks Component Schema
 *
 * Database migrations for the task management system.
 * Creates tasks, task_deps, and task_assignments tables with
 * indexes for efficient querying.
 *
 * @module engine/components/tasks/schema
 * @author Fifty.ai
 */

import type { Migration } from '../../types.js';

/**
 * Task management schema migrations.
 *
 * Version 1: Core task tables (tasks, task_deps, task_assignments)
 * with indexes for status, type, scope, project, brief, priority,
 * parent, defer, agent lookups.
 */
export const taskMigrations: Migration[] = [
  {
    version: 1,
    description: 'Create tasks, task_deps, and task_assignments tables',
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL CHECK (task_type IN ('brief','operational','personal','system')),
        scope TEXT NOT NULL CHECK (scope IN ('project','personal','system')),
        title TEXT NOT NULL,
        description TEXT,
        brief_id TEXT,
        project_slug TEXT,
        parent_id TEXT REFERENCES tasks(id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','blocked','done','cancelled')),
        priority INTEGER NOT NULL DEFAULT 3 CHECK (priority >= 1 AND priority <= 5),
        assignee TEXT,
        due_at TEXT,
        defer_until TEXT,
        created_by TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_slug) REFERENCES projects(slug)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);
      CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks(scope);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_slug);
      CREATE INDEX IF NOT EXISTS idx_tasks_brief ON tasks(brief_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_defer ON tasks(defer_until);

      CREATE TABLE IF NOT EXISTS task_deps (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_id, depends_on),
        CHECK (task_id != depends_on)
      );

      CREATE TABLE IF NOT EXISTS task_assignments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        result TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_assignments_agent ON task_assignments(agent);
    `,
  },
];
