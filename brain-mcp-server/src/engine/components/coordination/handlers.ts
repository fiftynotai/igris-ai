/**
 * Brain Engine v5.0 — Coordination Component Handlers
 *
 * Handler functions for the 6 coordination MCP tools:
 * agent capability management, priority adjustment,
 * configuration, and audit trail.
 *
 * @module engine/components/coordination/handlers
 * @author Fifty.ai
 */

import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return an error ToolResult */
function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/** Return a success ToolResult with text */
function successResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

/** Current timestamp in ISO 8601 format */
function now(): string {
  return new Date().toISOString();
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

  let overdueAdjusted = 0;
  let staleUnblocked = 0;
  let priorityBoosted = 0;
  const adjustments: { type: string; task_id: string; detail: string }[] = [];

  db.transaction(() => {
    // 1. Overdue tasks: priority -= 1 (bounded at ceiling)
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
        overdueAdjusted++;
      }
    }

    // 2. Stale blocked tasks: blocked >24h where all blockers are done/cancelled
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
      staleUnblocked++;

      // 3. Freshly unblocked: boost priority if > 2
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
          priorityBoosted++;
        }
      }
    }

    // Log all adjustments in autonomous_decisions
    if (!dryRun && adjustments.length > 0) {
      const insertDecision = db.prepare(`
        INSERT INTO autonomous_decisions (decision_type, task_id, detail, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const adj of adjustments) {
        insertDecision.run(adj.type, adj.task_id, adj.detail, timestamp);
      }
    }
  })();

  return successResult(JSON.stringify({
    dry_run: dryRun,
    overdue_adjusted: overdueAdjusted,
    stale_unblocked: staleUnblocked,
    priority_boosted: priorityBoosted,
    total_adjustments: adjustments.length,
    adjustments,
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

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (args.decision_type !== undefined) {
    conditions.push('decision_type = ?');
    params.push(args.decision_type);
  }
  if (args.task_id !== undefined) {
    conditions.push('task_id = ?');
    params.push(args.task_id);
  }
  if (args.agent !== undefined) {
    conditions.push('agent = ?');
    params.push(args.agent);
  }
  if (args.since !== undefined) {
    conditions.push('created_at >= ?');
    params.push(args.since);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = args.limit !== undefined ? Number(args.limit) : 50;

  const rows = db.prepare(`
    SELECT * FROM autonomous_decisions
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit) as Record<string, unknown>[];

  return successResult(JSON.stringify({
    decisions: rows,
    count: rows.length,
  }, null, 2));
}
