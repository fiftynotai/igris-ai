/**
 * Brain Engine v5.0 — Tasks Component Schema
 *
 * Database migrations for the task management system.
 * Creates tasks, task_deps, and task_assignments tables with
 * indexes for efficient querying.
 *
 * Version 2 adds coordination columns (required_capabilities,
 * retry_count, max_retries, fail_reason, failed status) and
 * three new tables for autonomous coordination.
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
 *
 * Version 2: Add coordination columns to tasks, create agent_capabilities,
 * autonomous_decisions, and coordination_config tables.
 *
 * Version 3: Add index on autonomous_decisions.agent for audit queries.
 *
 * Version 4: Expand task_type CHECK constraint to include semantic types
 * (dev, content, social-media, media-gen, research). Backward compatible.
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
  {
    version: 2,
    description: 'Add coordination columns to tasks, create agent_capabilities, autonomous_decisions, and coordination_config tables',
    sql: `
      -- NOTE: These PRAGMA foreign_keys statements are no-ops because the migration
      -- runner (sqlite.ts) wraps each migration in a transaction, and SQLite silently
      -- ignores PRAGMA foreign_keys changes inside transactions. This is benign: the
      -- table-recreation pattern (CREATE new -> copy -> DROP old -> RENAME) preserves
      -- FK integrity through explicit FOREIGN KEY clauses in the new table definitions.
      PRAGMA foreign_keys = OFF;

      -- Recreate tasks table with new columns and updated CHECK constraint
      CREATE TABLE tasks_v2 (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL CHECK (task_type IN ('brief','operational','personal','system')),
        scope TEXT NOT NULL CHECK (scope IN ('project','personal','system')),
        title TEXT NOT NULL,
        description TEXT,
        brief_id TEXT,
        project_slug TEXT,
        parent_id TEXT REFERENCES tasks_v2(id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','blocked','done','cancelled','failed')),
        priority INTEGER NOT NULL DEFAULT 3 CHECK (priority >= 1 AND priority <= 5),
        assignee TEXT,
        due_at TEXT,
        defer_until TEXT,
        created_by TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        required_capabilities TEXT DEFAULT '[]',
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        fail_reason TEXT,
        FOREIGN KEY (project_slug) REFERENCES projects(slug)
      );

      INSERT INTO tasks_v2 SELECT *, '[]', 0, 3, NULL FROM tasks;

      DROP TABLE tasks;
      ALTER TABLE tasks_v2 RENAME TO tasks;

      -- Recreate all indexes on tasks
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);
      CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks(scope);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_slug);
      CREATE INDEX IF NOT EXISTS idx_tasks_brief ON tasks(brief_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_defer ON tasks(defer_until);

      -- Recreate task_deps with FK references to the new tasks table
      CREATE TABLE task_deps_v2 (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_id, depends_on),
        CHECK (task_id != depends_on)
      );

      INSERT INTO task_deps_v2 SELECT * FROM task_deps;
      DROP TABLE task_deps;
      ALTER TABLE task_deps_v2 RENAME TO task_deps;

      -- Recreate task_assignments with FK references to the new tasks table
      CREATE TABLE task_assignments_v2 (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        result TEXT
      );

      INSERT INTO task_assignments_v2 SELECT * FROM task_assignments;
      DROP TABLE task_assignments;
      ALTER TABLE task_assignments_v2 RENAME TO task_assignments;

      CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_assignments_agent ON task_assignments(agent);

      -- Agent capabilities table
      CREATE TABLE IF NOT EXISTS agent_capabilities (
        agent TEXT NOT NULL,
        capability TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent, capability)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_cap_agent ON agent_capabilities(agent);

      -- Autonomous decisions audit log
      CREATE TABLE IF NOT EXISTS autonomous_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_type TEXT NOT NULL,
        task_id TEXT,
        agent TEXT,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_auto_decisions_task ON autonomous_decisions(task_id);
      CREATE INDEX IF NOT EXISTS idx_auto_decisions_type ON autonomous_decisions(decision_type);
      CREATE INDEX IF NOT EXISTS idx_auto_decisions_time ON autonomous_decisions(created_at);

      -- Coordination configuration key-value store
      CREATE TABLE IF NOT EXISTS coordination_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      PRAGMA foreign_keys = ON;
    `,
  },
  {
    version: 3,
    description: 'Add index on autonomous_decisions.agent for audit queries',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_auto_decisions_agent ON autonomous_decisions(agent);
    `,
  },
  {
    version: 4,
    description: 'Expand task_type CHECK to include semantic types (dev, content, social-media, media-gen, research)',
    sql: `
      PRAGMA foreign_keys = OFF;

      -- Recreate tasks table with expanded task_type CHECK constraint
      CREATE TABLE tasks_v4 (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL CHECK (task_type IN ('brief','operational','personal','system','dev','content','social-media','media-gen','research')),
        scope TEXT NOT NULL CHECK (scope IN ('project','personal','system')),
        title TEXT NOT NULL,
        description TEXT,
        brief_id TEXT,
        project_slug TEXT,
        parent_id TEXT REFERENCES tasks_v4(id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','blocked','done','cancelled','failed')),
        priority INTEGER NOT NULL DEFAULT 3 CHECK (priority >= 1 AND priority <= 5),
        assignee TEXT,
        due_at TEXT,
        defer_until TEXT,
        created_by TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        required_capabilities TEXT DEFAULT '[]',
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        fail_reason TEXT,
        FOREIGN KEY (project_slug) REFERENCES projects(slug)
      );

      INSERT INTO tasks_v4 SELECT * FROM tasks;

      DROP TABLE tasks;
      ALTER TABLE tasks_v4 RENAME TO tasks;

      -- Recreate all indexes on tasks
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);
      CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks(scope);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_slug);
      CREATE INDEX IF NOT EXISTS idx_tasks_brief ON tasks(brief_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_defer ON tasks(defer_until);

      -- Recreate task_deps with FK references to the new tasks table
      CREATE TABLE task_deps_v4 (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_id, depends_on),
        CHECK (task_id != depends_on)
      );

      INSERT INTO task_deps_v4 SELECT * FROM task_deps;
      DROP TABLE task_deps;
      ALTER TABLE task_deps_v4 RENAME TO task_deps;

      -- Recreate task_assignments with FK references to the new tasks table
      CREATE TABLE task_assignments_v4 (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        result TEXT
      );

      INSERT INTO task_assignments_v4 SELECT * FROM task_assignments;
      DROP TABLE task_assignments;
      ALTER TABLE task_assignments_v4 RENAME TO task_assignments;

      CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_assignments_agent ON task_assignments(agent);

      PRAGMA foreign_keys = ON;
    `,
  },
];
