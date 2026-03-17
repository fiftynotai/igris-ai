/**
 * Brain Engine v5.0 — Tasks Component Handlers
 *
 * Handler functions for the 10 task management MCP tools.
 * Each handler takes Record<string, unknown> args, validates
 * at runtime, and returns a ToolResult.
 *
 * Task IDs use the format: t-{first 8 chars of randomUUID()}
 *
 * @module engine/components/tasks/handlers
 * @author Fifty.ai
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult, now, WhereBuilder } from '../../helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a task ID: t- prefix + first 8 chars of a UUID */
function generateTaskId(): string {
  return 't-' + randomUUID().substring(0, 8);
}

/** Generate an assignment ID: first 8 chars of a UUID */
function generateAssignmentId(): string {
  return randomUUID().substring(0, 8);
}

/** Valid task statuses for create/update validation */
const VALID_STATUSES = ['pending', 'active', 'blocked', 'done', 'cancelled', 'failed'] as const;

/** Valid task scopes for create/update validation */
const VALID_SCOPES = ['project', 'personal', 'system'] as const;

/** Valid task types for create validation */
const VALID_TYPES = ['brief', 'operational', 'personal', 'system', 'dev', 'content', 'social-media', 'media-gen', 'research'] as const;

/** Valid result types for task_results */
const VALID_RESULT_TYPES = ['commit', 'file', 'text', 'image', 'url', 'json', 'error'] as const;

/** Generate a task result ID: tr- prefix + first 8 chars of a UUID */
function generateTaskResultId(): string {
  return 'tr-' + randomUUID().substring(0, 8);
}

// ---------------------------------------------------------------------------
// handleTaskCreate
// ---------------------------------------------------------------------------

/**
 * Create a new task.
 *
 * Required: task_type, title, scope
 * Optional: description, brief_id, project_slug, parent_id, priority,
 *           assignee, due_at, defer_until, created_by, metadata, status,
 *           required_capabilities, max_retries
 */
export function handleTaskCreate(args: Record<string, unknown>): ToolResult {
  const taskType = args.task_type as string | undefined;
  const title = args.title as string | undefined;
  const scope = args.scope as string | undefined;

  if (!taskType || !title || !scope) {
    return errorResult('Missing required fields: task_type, title, scope');
  }

  if (!(VALID_TYPES as readonly string[]).includes(taskType)) {
    return errorResult(`Invalid task_type: ${taskType}. Must be one of: ${VALID_TYPES.join(', ')}`);
  }

  if (!(VALID_SCOPES as readonly string[]).includes(scope)) {
    return errorResult(`Invalid scope: ${scope}. Must be one of: ${VALID_SCOPES.join(', ')}`);
  }

  const priority = args.priority !== undefined ? Number(args.priority) : 3;
  if (priority < 1 || priority > 5 || !Number.isInteger(priority)) {
    return errorResult('Priority must be an integer between 1 and 5');
  }

  const status = (args.status as string | undefined) ?? 'pending';
  if (!(VALID_STATUSES as readonly string[]).includes(status)) {
    return errorResult(`Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const db = getDb();
  const id = generateTaskId();
  const timestamp = now();
  const metadata = args.metadata !== undefined ? JSON.stringify(args.metadata) : '{}';
  const requiredCapabilities = args.required_capabilities !== undefined
    ? JSON.stringify(args.required_capabilities)
    : '[]';
  const maxRetries = args.max_retries !== undefined ? Number(args.max_retries) : 3;

  db.prepare(`
    INSERT INTO tasks (id, task_type, scope, title, description, brief_id, project_slug,
                       parent_id, status, priority, assignee, due_at, defer_until,
                       created_by, metadata, created_at, updated_at,
                       required_capabilities, max_retries)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    taskType,
    scope,
    title,
    (args.description as string | undefined) ?? null,
    (args.brief_id as string | undefined) ?? null,
    (args.project_slug as string | undefined) ?? null,
    (args.parent_id as string | undefined) ?? null,
    status,
    priority,
    (args.assignee as string | undefined) ?? null,
    (args.due_at as string | undefined) ?? null,
    (args.defer_until as string | undefined) ?? null,
    (args.created_by as string | undefined) ?? null,
    metadata,
    timestamp,
    timestamp,
    requiredCapabilities,
    maxRetries,
  );

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>;

  return successResult(JSON.stringify({ task }, null, 2));
}

// ---------------------------------------------------------------------------
// handleTaskList
// ---------------------------------------------------------------------------

/**
 * List tasks with optional filters.
 *
 * All optional: status, task_type, scope, project_slug, assignee, limit, offset
 * ORDER BY priority ASC, created_at ASC
 */
export function handleTaskList(args: Record<string, unknown>): ToolResult {
  const db = getDb();

  const where = new WhereBuilder()
    .add('status = ?', args.status)
    .add('task_type = ?', args.task_type)
    .add('scope = ?', args.scope)
    .add('project_slug = ?', args.project_slug)
    .add('assignee = ?', args.assignee);

  const limit = args.limit !== undefined ? Number(args.limit) : 25;
  const offset = args.offset !== undefined ? Number(args.offset) : 0;

  const rows = db.prepare(`
    SELECT * FROM tasks ${where.toSQL()}
    ORDER BY priority ASC, created_at ASC
    LIMIT ? OFFSET ?
  `).all(...where.values(), limit, offset) as Record<string, unknown>[];

  const countRow = db.prepare(
    `SELECT COUNT(*) as total FROM tasks ${where.toSQL()}`
  ).get(...where.values()) as { total: number };

  return successResult(JSON.stringify({
    tasks: rows,
    count: rows.length,
    total: countRow.total,
    limit,
    offset,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleTaskGet
// ---------------------------------------------------------------------------

/**
 * Get a single task with its dependencies and assignments.
 *
 * Required: task_id
 */
export function handleTaskGet(args: Record<string, unknown>): ToolResult {
  const taskId = args.task_id as string | undefined;
  if (!taskId) {
    return errorResult('Missing required field: task_id');
  }

  const db = getDb();

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) {
    return errorResult(`Task not found: ${taskId}`);
  }

  const deps = db.prepare(`
    SELECT td.depends_on, t.title, t.status
    FROM task_deps td
    JOIN tasks t ON t.id = td.depends_on
    WHERE td.task_id = ?
  `).all(taskId) as Record<string, unknown>[];

  const assignments = db.prepare(`
    SELECT * FROM task_assignments WHERE task_id = ? ORDER BY assigned_at DESC
  `).all(taskId) as Record<string, unknown>[];

  return successResult(JSON.stringify({ task, deps, assignments }, null, 2));
}

// ---------------------------------------------------------------------------
// handleTaskAssign
// ---------------------------------------------------------------------------

/**
 * Assign an agent to a task.
 *
 * Required: task_id, agent
 * Creates an assignment record and updates the task status to 'active'.
 */
export function handleTaskAssign(args: Record<string, unknown>): ToolResult {
  const taskId = args.task_id as string | undefined;
  const agent = args.agent as string | undefined;

  if (!taskId || !agent) {
    return errorResult('Missing required fields: task_id, agent');
  }

  const db = getDb();

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) {
    return errorResult(`Task not found: ${taskId}`);
  }

  const assignmentId = generateAssignmentId();
  const timestamp = now();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO task_assignments (id, task_id, agent, assigned_at)
      VALUES (?, ?, ?, ?)
    `).run(assignmentId, taskId, agent, timestamp);

    db.prepare(`
      UPDATE tasks SET status = 'active', assignee = ?, updated_at = ? WHERE id = ?
    `).run(agent, timestamp, taskId);
  })();

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;

  return successResult(JSON.stringify({
    task: updated,
    assignment: { id: assignmentId, task_id: taskId, agent, assigned_at: timestamp },
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleTaskComplete
// ---------------------------------------------------------------------------

/**
 * Mark a task as done.
 *
 * Required: task_id
 * Optional: result (text result to attach to the open assignment)
 *
 * After completing, checks for newly unblocked tasks (tasks whose ALL
 * dependencies are now done). Returns the completed task and unblocked IDs.
 */
export function handleTaskComplete(args: Record<string, unknown>): ToolResult {
  const taskId = args.task_id as string | undefined;
  if (!taskId) {
    return errorResult('Missing required field: task_id');
  }

  const db = getDb();

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) {
    return errorResult(`Task not found: ${taskId}`);
  }

  if (task.status === 'done') {
    return successResult(JSON.stringify({ task, unblocked: [], message: 'Task is already done' }, null, 2));
  }

  const timestamp = now();
  const resultText = (args.result as string | undefined) ?? null;

  let unblockedIds: string[] = [];

  db.transaction(() => {
    // Mark task as done
    db.prepare(`
      UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?
    `).run(timestamp, taskId);

    // Update open assignment (the most recent one without a completed_at)
    db.prepare(`
      UPDATE task_assignments
      SET completed_at = ?, result = ?
      WHERE task_id = ? AND completed_at IS NULL
    `).run(timestamp, resultText, taskId);

    // Find tasks that depended on this task and check if they are now unblocked
    // A task is unblocked if ALL its dependencies are done
    const dependents = db.prepare(`
      SELECT DISTINCT td.task_id
      FROM task_deps td
      WHERE td.depends_on = ?
    `).all(taskId) as { task_id: string }[];

    for (const dep of dependents) {
      const blockedDeps = db.prepare(`
        SELECT 1 FROM task_deps td
        JOIN tasks t ON t.id = td.depends_on
        WHERE td.task_id = ? AND t.status != 'done'
      `).get(dep.task_id) as Record<string, unknown> | undefined;

      if (!blockedDeps) {
        // All deps are done — check if task is currently blocked
        const depTask = db.prepare(
          'SELECT status FROM tasks WHERE id = ?'
        ).get(dep.task_id) as { status: string } | undefined;

        if (depTask && depTask.status === 'blocked') {
          db.prepare(`
            UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?
          `).run(timestamp, dep.task_id);
          unblockedIds.push(dep.task_id);
        }
      }
    }
  })();

  const completed = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;

  return successResult(JSON.stringify({
    task: completed,
    unblocked: unblockedIds,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleTaskBlock — helpers
// ---------------------------------------------------------------------------

/**
 * Add a dependency from taskId -> dependsOn with cycle detection.
 * Blocks the task if the dependency is not done.
 */
function addDependency(
  db: ReturnType<typeof getDb>,
  taskId: string,
  dependsOn: string,
  timestamp: string,
): ToolResult {
  // Cycle detection: check if dependsOn transitively depends on taskId
  const cycle = db.prepare(`
    WITH RECURSIVE dep_chain(id) AS (
      SELECT depends_on FROM task_deps WHERE task_id = ?
      UNION
      SELECT td.depends_on FROM task_deps td JOIN dep_chain dc ON td.task_id = dc.id
    )
    SELECT 1 FROM dep_chain WHERE id = ?
  `).get(dependsOn, taskId) as Record<string, unknown> | undefined;

  if (cycle) {
    return errorResult(`Adding this dependency would create a cycle: ${dependsOn} transitively depends on ${taskId}`);
  }

  // Check if dependency already exists
  const existing = db.prepare(
    'SELECT 1 FROM task_deps WHERE task_id = ? AND depends_on = ?'
  ).get(taskId, dependsOn) as Record<string, unknown> | undefined;

  if (existing) {
    return errorResult(`Dependency already exists: ${taskId} -> ${dependsOn}`);
  }

  db.transaction(() => {
    db.prepare(`
      INSERT INTO task_deps (task_id, depends_on, created_at) VALUES (?, ?, ?)
    `).run(taskId, dependsOn, timestamp);

    // If the dependency task is not done, mark the dependent task as blocked
    const depStatus = db.prepare(
      'SELECT status FROM tasks WHERE id = ?'
    ).get(dependsOn) as { status: string };

    if (depStatus.status !== 'done') {
      db.prepare(`
        UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?
      `).run(timestamp, taskId);
    }
  })();

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;
  return successResult(JSON.stringify({
    action: 'added',
    task: updated,
    dependency: dependsOn,
  }, null, 2));
}

/**
 * Remove a dependency from taskId -> dependsOn.
 * Unblocks the task if no remaining undone dependencies exist.
 */
function removeDependency(
  db: ReturnType<typeof getDb>,
  taskId: string,
  dependsOn: string,
  taskStatus: string,
  timestamp: string,
): ToolResult {
  const deleted = db.prepare(
    'DELETE FROM task_deps WHERE task_id = ? AND depends_on = ?'
  ).run(taskId, dependsOn);

  if (deleted.changes === 0) {
    return errorResult(`No dependency found: ${taskId} -> ${dependsOn}`);
  }

  // Check if the task is now unblocked (no remaining undone deps)
  const remainingBlockers = db.prepare(`
    SELECT 1 FROM task_deps td
    JOIN tasks t ON t.id = td.depends_on
    WHERE td.task_id = ? AND t.status != 'done'
  `).get(taskId) as Record<string, unknown> | undefined;

  if (!remainingBlockers && taskStatus === 'blocked') {
    db.prepare(`
      UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?
    `).run(timestamp, taskId);
  }

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;
  return successResult(JSON.stringify({
    action: 'removed',
    task: updated,
    dependency: dependsOn,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleTaskBlock
// ---------------------------------------------------------------------------

/**
 * Add or remove a dependency between tasks.
 *
 * Required: task_id, depends_on
 * Optional: action ('add' or 'remove', default 'add')
 *
 * For 'add': performs cycle detection via recursive CTE, then inserts.
 * For 'remove': deletes the dependency.
 */
export function handleTaskBlock(args: Record<string, unknown>): ToolResult {
  const taskId = args.task_id as string | undefined;
  const dependsOn = args.depends_on as string | undefined;
  const action = (args.action as string | undefined) ?? 'add';

  if (!taskId || !dependsOn) {
    return errorResult('Missing required fields: task_id, depends_on');
  }

  if (action !== 'add' && action !== 'remove') {
    return errorResult(`Invalid action: ${action}. Must be 'add' or 'remove'`);
  }

  if (taskId === dependsOn) {
    return errorResult('A task cannot depend on itself');
  }

  const db = getDb();

  // Verify both tasks exist
  const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId) as { id: string; status: string } | undefined;
  if (!task) {
    return errorResult(`Task not found: ${taskId}`);
  }
  const depTask = db.prepare('SELECT id FROM tasks WHERE id = ?').get(dependsOn) as { id: string } | undefined;
  if (!depTask) {
    return errorResult(`Dependency task not found: ${dependsOn}`);
  }

  const timestamp = now();

  if (action === 'add') {
    return addDependency(db, taskId, dependsOn, timestamp);
  } else {
    return removeDependency(db, taskId, dependsOn, task.status, timestamp);
  }
}

// ---------------------------------------------------------------------------
// handleTaskNext — helpers
// ---------------------------------------------------------------------------

/**
 * Resolve agent capabilities from explicit parameter or agent_capabilities table.
 * Returns the resolved capabilities array, or undefined if none found.
 */
function resolveCapabilities(
  db: ReturnType<typeof getDb>,
  agent: string | undefined,
  explicitCaps: string[] | undefined,
): string[] | undefined {
  if (explicitCaps) return explicitCaps;
  if (!agent) return undefined;

  try {
    const capRows = db.prepare(
      'SELECT capability FROM agent_capabilities WHERE agent = ?'
    ).all(agent) as { capability: string }[];
    if (capRows.length > 0) {
      return capRows.map((r) => r.capability);
    }
  } catch {
    // agent_capabilities table may not exist yet (pre-v2 migration)
  }
  return undefined;
}

/**
 * Assign a task to an agent: create assignment record, update task status,
 * and log an autonomous_decisions record.
 * Returns the refreshed task and assignment objects.
 */
function assignTaskToAgent(
  db: ReturnType<typeof getDb>,
  task: Record<string, unknown>,
  agent: string,
  timestamp: string,
): { task: Record<string, unknown>; assignment: Record<string, unknown> } {
  const assignmentId = generateAssignmentId();

  db.prepare(`
    INSERT INTO task_assignments (id, task_id, agent, assigned_at)
    VALUES (?, ?, ?, ?)
  `).run(assignmentId, task.id, agent, timestamp);

  db.prepare(`
    UPDATE tasks SET status = 'active', assignee = ?, updated_at = ? WHERE id = ?
  `).run(agent, timestamp, task.id);

  // Log assignment decision
  try {
    db.prepare(`
      INSERT INTO autonomous_decisions (decision_type, task_id, agent, detail, created_at)
      VALUES ('assignment', ?, ?, ?, ?)
    `).run(
      task.id as string,
      agent,
      `Auto-assigned via task_next to agent ${agent}`,
      timestamp,
    );
  } catch {
    // autonomous_decisions table may not exist yet (pre-v2 migration)
  }

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<string, unknown>;
  return {
    task: updated,
    assignment: { id: assignmentId, task_id: task.id, agent, assigned_at: timestamp },
  };
}

// ---------------------------------------------------------------------------
// handleTaskNext
// ---------------------------------------------------------------------------

/**
 * Find the next highest-priority unblocked, non-deferred, pending task.
 *
 * Optional: agent, project_slug, scope, task_type, capabilities
 * If agent is provided, auto-assigns the found task and logs an
 * autonomous_decisions assignment record.
 * If capabilities provided, filters tasks by matching required_capabilities.
 * If agent is provided without capabilities, looks up agent_capabilities table.
 * Uses a transaction for atomicity.
 */
export function handleTaskNext(args: Record<string, unknown>): ToolResult {
  const db = getDb();
  const timestamp = now();
  const agent = args.agent as string | undefined;

  const where = new WhereBuilder()
    .addAlways("tasks.status = 'pending'")
    .addAlways("(tasks.defer_until IS NULL OR tasks.defer_until <= ?)", timestamp)
    .add('tasks.project_slug = ?', args.project_slug)
    .add('tasks.scope = ?', args.scope)
    .add('tasks.task_type = ?', args.task_type);

  // Resolve capabilities: explicit param > agent_capabilities table lookup
  const capabilities = resolveCapabilities(db, agent, args.capabilities as string[] | undefined);

  // Capability-based filtering: match tasks with no requirements OR at least one overlap
  if (capabilities && capabilities.length > 0) {
    const capPlaceholders = capabilities.map(() => '?').join(', ');
    where.addAlways(`
      (tasks.required_capabilities = '[]'
       OR EXISTS (
         SELECT 1 FROM json_each(tasks.required_capabilities) je
         WHERE je.value IN (${capPlaceholders})
       ))
    `, ...capabilities);
  }

  // Exclude tasks with undone dependencies
  where.addAlways(`
    NOT EXISTS (
      SELECT 1 FROM task_deps td
      JOIN tasks dep ON dep.id = td.depends_on
      WHERE td.task_id = tasks.id AND dep.status != 'done'
    )
  `);

  let resultTask: Record<string, unknown> | null = null;
  let assignment: Record<string, unknown> | null = null;

  db.transaction(() => {
    const task = db.prepare(`
      SELECT * FROM tasks ${where.toSQL()}
      ORDER BY
        priority ASC,
        CASE WHEN tasks.due_at IS NOT NULL THEN 0 ELSE 1 END ASC,
        tasks.due_at ASC,
        created_at ASC
      LIMIT 1
    `).get(...where.values()) as Record<string, unknown> | undefined;

    if (!task) return;

    if (agent) {
      const result = assignTaskToAgent(db, task, agent, timestamp);
      resultTask = result.task;
      assignment = result.assignment;
    } else {
      resultTask = task;
    }
  })();

  if (!resultTask) {
    return successResult(JSON.stringify({
      task: null,
      message: 'No eligible tasks found matching the criteria.',
    }, null, 2));
  }

  return successResult(JSON.stringify({
    task: resultTask,
    ...(assignment ? { assignment } : {}),
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleTaskUpdate
// ---------------------------------------------------------------------------

/**
 * Update task fields.
 *
 * Required: task_id
 * Optional: title, description, priority, status, due_at, defer_until,
 *           metadata, scope, assignee
 * Always updates updated_at.
 */
export function handleTaskUpdate(args: Record<string, unknown>): ToolResult {
  const taskId = args.task_id as string | undefined;
  if (!taskId) {
    return errorResult('Missing required field: task_id');
  }

  const db = getDb();

  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!existing) {
    return errorResult(`Task not found: ${taskId}`);
  }

  const setClauses: string[] = [];
  const setValues: unknown[] = [];

  const updatableFields = [
    'title', 'description', 'due_at', 'defer_until', 'assignee', 'scope',
  ];

  for (const field of updatableFields) {
    if (args[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      setValues.push(args[field]);
    }
  }

  if (args.priority !== undefined) {
    const priority = Number(args.priority);
    if (priority < 1 || priority > 5 || !Number.isInteger(priority)) {
      return errorResult('Priority must be an integer between 1 and 5');
    }
    setClauses.push('priority = ?');
    setValues.push(priority);
  }

  if (args.status !== undefined) {
    if (!(VALID_STATUSES as readonly string[]).includes(args.status as string)) {
      return errorResult(`Invalid status: ${args.status}. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    if (args.status === 'done') {
      return errorResult('Use igris_task_complete to mark tasks as done (ensures cascade unblocking)');
    }
    if (args.status === 'failed') {
      return errorResult('Use igris_task_fail to mark tasks as failed (ensures retry tracking)');
    }
    setClauses.push('status = ?');
    setValues.push(args.status);
  }

  if (args.scope !== undefined) {
    if (!(VALID_SCOPES as readonly string[]).includes(args.scope as string)) {
      return errorResult(`Invalid scope: ${args.scope}. Must be one of: ${VALID_SCOPES.join(', ')}`);
    }
  }

  if (args.metadata !== undefined) {
    setClauses.push('metadata = ?');
    setValues.push(JSON.stringify(args.metadata));
  }

  if (setClauses.length === 0) {
    return errorResult('No fields to update. Provide at least one of: title, description, priority, status, due_at, defer_until, metadata, scope, assignee');
  }

  // Always update updated_at
  const timestamp = now();
  setClauses.push('updated_at = ?');
  setValues.push(timestamp);

  setValues.push(taskId);

  db.prepare(
    `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`
  ).run(...setValues);

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;

  return successResult(JSON.stringify({ task: updated }, null, 2));
}

// ---------------------------------------------------------------------------
// handleTaskFail
// ---------------------------------------------------------------------------

/**
 * Mark a task as failed with a reason.
 *
 * Required: task_id, reason
 * Increments retry_count and sets fail_reason. Does NOT auto-retry —
 * the coordination component listens for task.failed events to handle
 * self-healing logic.
 */
export function handleTaskFail(args: Record<string, unknown>): ToolResult {
  const taskId = args.task_id as string | undefined;
  const reason = args.reason as string | undefined;

  if (!taskId || !reason) {
    return errorResult('Missing required fields: task_id, reason');
  }

  const db = getDb();

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) {
    return errorResult(`Task not found: ${taskId}`);
  }

  const timestamp = now();

  db.prepare(`
    UPDATE tasks
    SET status = 'failed', fail_reason = ?, retry_count = retry_count + 1, updated_at = ?
    WHERE id = ?
  `).run(reason, timestamp, taskId);

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;

  return successResult(JSON.stringify({ task: updated }, null, 2));
}

// ---------------------------------------------------------------------------
// handleTaskRetry
// ---------------------------------------------------------------------------

/**
 * Retry a failed task by resetting its status to pending.
 *
 * Required: task_id
 * Optional: fix_context (string merged into metadata as "fix_context" key)
 * Only works on tasks in 'failed' status.
 */
export function handleTaskRetry(args: Record<string, unknown>): ToolResult {
  const taskId = args.task_id as string | undefined;

  if (!taskId) {
    return errorResult('Missing required field: task_id');
  }

  const db = getDb();

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) {
    return errorResult(`Task not found: ${taskId}`);
  }

  if (task.status !== 'failed') {
    return errorResult(`Task ${taskId} is not in failed status (current: ${task.status}). Only failed tasks can be retried.`);
  }

  const timestamp = now();
  const fixContext = args.fix_context as string | undefined;

  if (fixContext) {
    // Merge fix_context into existing metadata
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse((task.metadata as string) || '{}') as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    metadata.fix_context = fixContext;

    db.prepare(`
      UPDATE tasks SET status = 'pending', metadata = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(metadata), timestamp, taskId);
  } else {
    db.prepare(`
      UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?
    `).run(timestamp, taskId);
  }

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;

  return successResult(JSON.stringify({ task: updated }, null, 2));
}

// ---------------------------------------------------------------------------
// handleTaskClaim
// ---------------------------------------------------------------------------

/**
 * Atomically claim a specific task by ID for an agent.
 *
 * Required: task_id, agent
 * Only works on tasks in 'pending' status. Atomically updates the task
 * status to 'active', sets the assignee, and creates an assignment record.
 */
export function handleTaskClaim(args: Record<string, unknown>): ToolResult {
  const taskId = args.task_id as string | undefined;
  const agent = args.agent as string | undefined;

  if (!taskId || !agent) {
    return errorResult('Missing required fields: task_id, agent');
  }

  const db = getDb();

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) {
    return errorResult(`Task not found: ${taskId}`);
  }

  if (task.status !== 'pending') {
    return errorResult(
      `Task ${taskId} is not in pending status (current: ${task.status}). Only pending tasks can be claimed.`
    );
  }

  const assignmentId = generateAssignmentId();
  const timestamp = now();

  db.transaction(() => {
    db.prepare(`
      UPDATE tasks SET status = 'active', assignee = ?, updated_at = ? WHERE id = ?
    `).run(agent, timestamp, taskId);

    db.prepare(`
      INSERT INTO task_assignments (id, task_id, agent, assigned_at)
      VALUES (?, ?, ?, ?)
    `).run(assignmentId, taskId, agent, timestamp);
  })();

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;

  return successResult(JSON.stringify({
    task: updated,
    assignment: { id: assignmentId, task_id: taskId, agent, assigned_at: timestamp },
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleTaskResultAdd
// ---------------------------------------------------------------------------

/**
 * Add a structured result to a task.
 *
 * Required: task_id, result_type, content
 * Optional: file_path, metadata
 *
 * Result IDs use the format: tr-{first 8 chars of randomUUID()}
 */
export function handleTaskResultAdd(args: Record<string, unknown>): ToolResult {
  const taskId = args.task_id as string | undefined;
  const resultType = args.result_type as string | undefined;
  const content = args.content as string | undefined;

  if (!taskId || !resultType || !content) {
    return errorResult('Missing required fields: task_id, result_type, content');
  }

  if (!(VALID_RESULT_TYPES as readonly string[]).includes(resultType)) {
    return errorResult(`Invalid result_type: ${resultType}. Must be one of: ${VALID_RESULT_TYPES.join(', ')}`);
  }

  const db = getDb();

  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) {
    return errorResult(`Task not found: ${taskId}`);
  }

  const id = generateTaskResultId();
  const timestamp = now();
  const filePath = (args.file_path as string | undefined) ?? null;
  const metadata = args.metadata !== undefined ? JSON.stringify(args.metadata) : '{}';

  db.prepare(`
    INSERT INTO task_results (id, task_id, result_type, content, file_path, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, taskId, resultType, content, filePath, metadata, timestamp);

  const result = db.prepare('SELECT * FROM task_results WHERE id = ?').get(id) as Record<string, unknown>;

  return successResult(JSON.stringify({ result }, null, 2));
}

// ---------------------------------------------------------------------------
// handleTaskResultGet
// ---------------------------------------------------------------------------

/**
 * Get all results for a task, optionally filtered by result_type.
 *
 * Required: task_id
 * Optional: result_type (filter)
 */
export function handleTaskResultGet(args: Record<string, unknown>): ToolResult {
  const taskId = args.task_id as string | undefined;

  if (!taskId) {
    return errorResult('Missing required field: task_id');
  }

  const db = getDb();

  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) {
    return errorResult(`Task not found: ${taskId}`);
  }

  const resultType = args.result_type as string | undefined;

  let rows: Record<string, unknown>[];
  if (resultType) {
    if (!(VALID_RESULT_TYPES as readonly string[]).includes(resultType)) {
      return errorResult(`Invalid result_type: ${resultType}. Must be one of: ${VALID_RESULT_TYPES.join(', ')}`);
    }
    rows = db.prepare(
      'SELECT * FROM task_results WHERE task_id = ? AND result_type = ? ORDER BY created_at ASC'
    ).all(taskId, resultType) as Record<string, unknown>[];
  } else {
    rows = db.prepare(
      'SELECT * FROM task_results WHERE task_id = ? ORDER BY created_at ASC'
    ).all(taskId) as Record<string, unknown>[];
  }

  return successResult(JSON.stringify({ results: rows, count: rows.length }, null, 2));
}
