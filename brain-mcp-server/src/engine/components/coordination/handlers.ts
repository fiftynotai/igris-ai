/**
 * Brain Engine v7.0 — Coordination Component Handlers
 *
 * Handler functions for the 6 coordination MCP tools:
 * agent capability management, priority adjustment,
 * configuration, and audit trail.
 *
 * @module engine/components/coordination/handlers
 * @author Fifty.ai
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult, now, WhereBuilder } from '../../helpers.js';

/** Generate an assignment ID: first 8 chars of a UUID */
function generateAssignmentId(): string {
  return randomUUID().substring(0, 8);
}

// ---------------------------------------------------------------------------
// handleAgentCapabilitySet
// ---------------------------------------------------------------------------

/**
 * Set capabilities for an agent (replace all existing).
 *
 * Required: agent (string), capabilities (string[])
 * Deletes existing capabilities for the agent and inserts the new set.
 * Returns the full capability list for the agent.
 */
export function handleAgentCapabilitySet(args: Record<string, unknown>): ToolResult {
  const agent = args.agent as string | undefined;
  const capabilities = args.capabilities as string[] | undefined;

  if (!agent || !capabilities || !Array.isArray(capabilities)) {
    return errorResult('Missing required fields: agent (string), capabilities (string[])');
  }

  const db = getDb();
  const timestamp = now();

  db.transaction(() => {
    db.prepare('DELETE FROM agent_capabilities WHERE agent = ?').run(agent);

    const insert = db.prepare(
      'INSERT INTO agent_capabilities (agent, capability, created_at) VALUES (?, ?, ?)'
    );
    for (const cap of capabilities) {
      insert.run(agent, cap, timestamp);
    }
  })();

  const rows = db.prepare(
    'SELECT capability FROM agent_capabilities WHERE agent = ? ORDER BY capability'
  ).all(agent) as { capability: string }[];

  return successResult(JSON.stringify({
    agent,
    capabilities: rows.map((r) => r.capability),
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleAgentCapabilityList
// ---------------------------------------------------------------------------

/**
 * List agent capabilities, optionally filtered by agent.
 *
 * Optional: agent (string)
 * Returns capabilities grouped by agent.
 */
export function handleAgentCapabilityList(args: Record<string, unknown>): ToolResult {
  const db = getDb();
  const agent = args.agent as string | undefined;

  let rows: { agent: string; capability: string }[];
  if (agent) {
    rows = db.prepare(
      'SELECT agent, capability FROM agent_capabilities WHERE agent = ? ORDER BY capability'
    ).all(agent) as { agent: string; capability: string }[];
  } else {
    rows = db.prepare(
      'SELECT agent, capability FROM agent_capabilities ORDER BY agent, capability'
    ).all() as { agent: string; capability: string }[];
  }

  // Group by agent
  const grouped: Record<string, string[]> = {};
  for (const row of rows) {
    if (!grouped[row.agent]) {
      grouped[row.agent] = [];
    }
    grouped[row.agent].push(row.capability);
  }

  return successResult(JSON.stringify({
    agents: grouped,
    total: rows.length,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleAdjustPriorities — helpers
// ---------------------------------------------------------------------------

/** Adjustment record for priority changes and unblocks. */
interface PriorityAdjustment {
  type: string;
  task_id: string;
  detail: string;
}

/**
 * Boost priority of overdue tasks (due_at < now, status pending/active).
 * Priority is decremented by 1, bounded at the ceiling.
 */
function boostOverdueTasks(
  db: ReturnType<typeof getDb>,
  timestamp: string,
  ceiling: number,
  dryRun: boolean,
): { count: number; adjustments: PriorityAdjustment[] } {
  const adjustments: PriorityAdjustment[] = [];
  let count = 0;

  const overdueTasks = db.prepare(`
    SELECT id, priority, title FROM tasks
    WHERE due_at IS NOT NULL AND due_at < ?
      AND status IN ('pending', 'active')
      AND priority > ?
  `).all(timestamp, ceiling) as { id: string; priority: number; title: string }[];

  for (const task of overdueTasks) {
    const newPriority = Math.max(ceiling, task.priority - 1);
    if (newPriority !== task.priority) {
      if (!dryRun) {
        db.prepare(
          'UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?'
        ).run(newPriority, timestamp, task.id);
      }
      adjustments.push({
        type: 'overdue_boost',
        task_id: task.id,
        detail: `Overdue task "${task.title}" priority ${task.priority} -> ${newPriority}`,
      });
      count++;
    }
  }

  return { count, adjustments };
}

/**
 * Unblock stale blocked tasks (blocked >24h where all blockers are done/cancelled)
 * and boost priority of freshly unblocked tasks with priority > 2.
 */
function unblockStaleTasks(
  db: ReturnType<typeof getDb>,
  timestamp: string,
  ceiling: number,
  dryRun: boolean,
): { unblocked: number; boosted: number; adjustments: PriorityAdjustment[] } {
  const adjustments: PriorityAdjustment[] = [];
  let unblocked = 0;
  let boosted = 0;

  const staleBlocked = db.prepare(`
    SELECT t.id, t.title, t.priority, t.updated_at FROM tasks t
    WHERE t.status = 'blocked'
      AND datetime(t.updated_at, '+24 hours') < ?
      AND NOT EXISTS (
        SELECT 1 FROM task_deps td
        JOIN tasks dep ON dep.id = td.depends_on
        WHERE td.task_id = t.id AND dep.status NOT IN ('done', 'cancelled')
      )
  `).all(timestamp) as { id: string; title: string; priority: number; updated_at: string }[];

  for (const task of staleBlocked) {
    if (!dryRun) {
      db.prepare(
        "UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?"
      ).run(timestamp, task.id);
    }
    adjustments.push({
      type: 'stale_unblock',
      task_id: task.id,
      detail: `Stale blocked task "${task.title}" unblocked to pending (blocked since ${task.updated_at})`,
    });
    unblocked++;

    // Freshly unblocked: boost priority if > 2
    if (task.priority > 2) {
      const newPriority = Math.max(ceiling, task.priority - 1);
      if (newPriority !== task.priority) {
        if (!dryRun) {
          db.prepare(
            'UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?'
          ).run(newPriority, timestamp, task.id);
        }
        adjustments.push({
          type: 'unblock_boost',
          task_id: task.id,
          detail: `Unblocked task "${task.title}" priority ${task.priority} -> ${newPriority}`,
        });
        boosted++;
      }
    }
  }

  return { unblocked, boosted, adjustments };
}

// ---------------------------------------------------------------------------
// handleAdjustPriorities
// ---------------------------------------------------------------------------

/**
 * Autonomous priority adjustment algorithm.
 *
 * 1. Overdue tasks (due_at < now, status pending/active): priority -= 1
 *    (bounded at priority_ceiling config, default 1)
 * 2. Stale blocked tasks (blocked >24h where ALL blockers are done/cancelled):
 *    unblock to pending
 * 3. Freshly unblocked tasks (blocked->pending): priority -= 1 if > 2
 *
 * Optional: dry_run (boolean, default false)
 * Each adjustment is logged in autonomous_decisions.
 * Returns counts of adjustments made.
 */
export function handleAdjustPriorities(args: Record<string, unknown>): ToolResult {
  const db = getDb();
  const dryRun = args.dry_run === true;
  const timestamp = now();

  // Read config values
  let ceiling = 1;
  try {
    const row = db.prepare(
      "SELECT value FROM coordination_config WHERE key = 'priority_ceiling'"
    ).get() as { value: string } | undefined;
    if (row) {
      ceiling = parseInt(row.value, 10) || 1;
    }
  } catch {
    // Use default
  }

  let allAdjustments: PriorityAdjustment[] = [];
  let overdueAdjusted = 0;
  let staleUnblocked = 0;
  let priorityBoosted = 0;

  db.transaction(() => {
    const overdueResult = boostOverdueTasks(db, timestamp, ceiling, dryRun);
    overdueAdjusted = overdueResult.count;
    allAdjustments.push(...overdueResult.adjustments);

    const staleResult = unblockStaleTasks(db, timestamp, ceiling, dryRun);
    staleUnblocked = staleResult.unblocked;
    priorityBoosted = staleResult.boosted;
    allAdjustments.push(...staleResult.adjustments);

    // Log all adjustments in autonomous_decisions
    if (!dryRun && allAdjustments.length > 0) {
      const insertDecision = db.prepare(`
        INSERT INTO autonomous_decisions (decision_type, task_id, detail, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const adj of allAdjustments) {
        insertDecision.run(adj.type, adj.task_id, adj.detail, timestamp);
      }
    }
  })();

  return successResult(JSON.stringify({
    dry_run: dryRun,
    overdue_adjusted: overdueAdjusted,
    stale_unblocked: staleUnblocked,
    priority_boosted: priorityBoosted,
    total_adjustments: allAdjustments.length,
    adjustments: allAdjustments,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleCoordinationConfigSet
// ---------------------------------------------------------------------------

/**
 * Set a coordination configuration value.
 *
 * Required: key (string), value (string)
 * Uses INSERT OR REPLACE (upsert) semantics.
 */
export function handleCoordinationConfigSet(args: Record<string, unknown>): ToolResult {
  const key = args.key as string | undefined;
  const value = args.value as string | undefined;

  if (!key || value === undefined || value === null) {
    return errorResult('Missing required fields: key, value');
  }

  const db = getDb();
  const timestamp = now();

  db.prepare(`
    INSERT INTO coordination_config (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), timestamp);

  const row = db.prepare(
    'SELECT * FROM coordination_config WHERE key = ?'
  ).get(key) as Record<string, unknown>;

  return successResult(JSON.stringify({ config: row }, null, 2));
}

// ---------------------------------------------------------------------------
// handleCoordinationConfigGet
// ---------------------------------------------------------------------------

/**
 * Get coordination configuration value(s).
 *
 * Optional: key (string). If omitted, returns all config.
 */
export function handleCoordinationConfigGet(args: Record<string, unknown>): ToolResult {
  const db = getDb();
  const key = args.key as string | undefined;

  if (key) {
    const row = db.prepare(
      'SELECT * FROM coordination_config WHERE key = ?'
    ).get(key) as Record<string, unknown> | undefined;

    if (!row) {
      return errorResult(`Configuration key not found: ${key}`);
    }

    return successResult(JSON.stringify({ config: row }, null, 2));
  }

  const rows = db.prepare(
    'SELECT * FROM coordination_config ORDER BY key'
  ).all() as Record<string, unknown>[];

  return successResult(JSON.stringify({
    config: rows,
    count: rows.length,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleAuditList
// ---------------------------------------------------------------------------

/**
 * Query the autonomous_decisions audit trail.
 *
 * Optional filters: decision_type, task_id, agent, since (ISO datetime),
 *                   limit (default 50)
 * Returns decisions in reverse chronological order.
 */
export function handleAuditList(args: Record<string, unknown>): ToolResult {
  const db = getDb();

  const where = new WhereBuilder()
    .add('decision_type = ?', args.decision_type)
    .add('task_id = ?', args.task_id)
    .add('agent = ?', args.agent)
    .add('created_at >= ?', args.since);

  const limit = args.limit !== undefined ? Number(args.limit) : 50;

  const rows = db.prepare(`
    SELECT * FROM autonomous_decisions
    ${where.toSQL()}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...where.values(), limit) as Record<string, unknown>[];

  return successResult(JSON.stringify({
    decisions: rows,
    count: rows.length,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleAutoRoute — helpers
// ---------------------------------------------------------------------------

/** Record of a single auto-route assignment (or would-be assignment in dry_run). */
interface RouteAssignment {
  task_id: string;
  task_title: string;
  agent: string;
  assignment_id: string | null;
}

/**
 * Check if an agent's capabilities are a superset of the required capabilities.
 * Returns true if every required capability exists in agentCaps.
 */
function isSuperset(agentCaps: string[], required: string[]): boolean {
  return required.every((cap) => agentCaps.includes(cap));
}

// ---------------------------------------------------------------------------
// handleAutoRoute
// ---------------------------------------------------------------------------

/**
 * Auto-assign pending tasks to online agents by capability match.
 *
 * Optional: dry_run (boolean, default false)
 *
 * 1. Checks coordination_config for 'auto_route_enabled' — returns early if 'false'
 * 2. Queries all pending tasks that have required_capabilities (not empty '[]')
 * 3. Queries all active instances (heartbeat within 30 minutes)
 * 4. For each instance, looks up capabilities from agent_capabilities table
 * 5. For each pending task (ordered by priority ASC = highest priority first):
 *    a. Parses task's required_capabilities JSON array
 *    b. Finds first instance whose capabilities are a SUPERSET of required
 *    c. If match found and not dry_run: assigns the task
 *    d. If match found and dry_run: records the would-be match
 * 6. Returns summary of assignments made (or would-be assignments if dry_run)
 */
export function handleAutoRoute(args: Record<string, unknown>): ToolResult {
  const db = getDb();
  const dryRun = args.dry_run === true;
  const timestamp = now();

  // Check if auto-routing is enabled
  try {
    const configRow = db.prepare(
      "SELECT value FROM coordination_config WHERE key = 'auto_route_enabled'"
    ).get() as { value: string } | undefined;

    if (!configRow || configRow.value !== 'true') {
      return successResult(JSON.stringify({
        message: 'Auto-routing is disabled. Set auto_route_enabled to "true" in coordination config to enable.',
        assignments: [],
        count: 0,
      }, null, 2));
    }
  } catch {
    return errorResult('Failed to read coordination config');
  }

  // Get pending tasks with non-empty required_capabilities, ordered by priority
  const pendingTasks = db.prepare(`
    SELECT id, title, priority, required_capabilities, project_slug, scope
    FROM tasks
    WHERE status = 'pending'
      AND required_capabilities != '[]'
      AND required_capabilities IS NOT NULL
    ORDER BY priority ASC, created_at ASC
  `).all() as {
    id: string;
    title: string;
    priority: number;
    required_capabilities: string;
    project_slug: string | null;
    scope: string;
  }[];

  if (pendingTasks.length === 0) {
    return successResult(JSON.stringify({
      message: 'No pending tasks with required capabilities found.',
      assignments: [],
      count: 0,
    }, null, 2));
  }

  // Get active instances (heartbeat within 30 minutes)
  const activeInstances = db.prepare(`
    SELECT id FROM instances
    WHERE status = 'active'
      AND last_heartbeat_at >= datetime('now', '-30 minutes')
  `).all() as { id: string }[];

  if (activeInstances.length === 0) {
    return successResult(JSON.stringify({
      message: 'No active instances online. Cannot auto-route tasks.',
      assignments: [],
      count: 0,
    }, null, 2));
  }

  // Build capability map for each active instance
  // Capabilities are stored by agent name in agent_capabilities table
  // Instances use their instance_id as agent key when capabilities are set via heartbeat
  const instanceCaps: Map<string, string[]> = new Map();
  for (const instance of activeInstances) {
    const caps = db.prepare(
      'SELECT capability FROM agent_capabilities WHERE agent = ?'
    ).all(instance.id) as { capability: string }[];
    if (caps.length > 0) {
      instanceCaps.set(instance.id, caps.map((c) => c.capability));
    }
  }

  if (instanceCaps.size === 0) {
    return successResult(JSON.stringify({
      message: 'No active instances have registered capabilities. Use heartbeat with capabilities or igris_agent_capability_set.',
      assignments: [],
      count: 0,
    }, null, 2));
  }

  // Track which instances have been assigned to avoid double-assigning
  const assignedInstances = new Set<string>();
  const assignments: RouteAssignment[] = [];

  const performAssignments = (): void => {
    for (const task of pendingTasks) {
      let requiredCaps: string[];
      try {
        requiredCaps = JSON.parse(task.required_capabilities) as string[];
      } catch {
        continue; // Skip tasks with malformed capabilities
      }

      if (requiredCaps.length === 0) continue;

      // Find first matching instance (not yet assigned this round)
      let matchedInstance: string | null = null;
      for (const [instanceId, caps] of instanceCaps) {
        if (assignedInstances.has(instanceId)) continue;
        if (isSuperset(caps, requiredCaps)) {
          matchedInstance = instanceId;
          break;
        }
      }

      if (!matchedInstance) continue;

      assignedInstances.add(matchedInstance);

      if (dryRun) {
        assignments.push({
          task_id: task.id,
          task_title: task.title,
          agent: matchedInstance,
          assignment_id: null,
        });
      } else {
        const assignmentId = generateAssignmentId();

        db.prepare(`
          UPDATE tasks SET status = 'active', assignee = ?, updated_at = ? WHERE id = ?
        `).run(matchedInstance, timestamp, task.id);

        db.prepare(`
          INSERT INTO task_assignments (id, task_id, agent, assigned_at)
          VALUES (?, ?, ?, ?)
        `).run(assignmentId, task.id, matchedInstance, timestamp);

        // Log decision in autonomous_decisions
        db.prepare(`
          INSERT INTO autonomous_decisions (decision_type, task_id, agent, detail, created_at)
          VALUES ('auto_route', ?, ?, ?, ?)
        `).run(
          task.id,
          matchedInstance,
          `Auto-routed task "${task.title}" to instance ${matchedInstance} (capabilities matched)`,
          timestamp,
        );

        assignments.push({
          task_id: task.id,
          task_title: task.title,
          agent: matchedInstance,
          assignment_id: assignmentId,
        });
      }
    }
  };

  if (dryRun) {
    performAssignments();
  } else {
    db.transaction(() => {
      performAssignments();
    })();
  }

  return successResult(JSON.stringify({
    dry_run: dryRun,
    assignments,
    count: assignments.length,
    pending_tasks_checked: pendingTasks.length,
    active_instances: activeInstances.length,
    instances_with_capabilities: instanceCaps.size,
  }, null, 2));
}
