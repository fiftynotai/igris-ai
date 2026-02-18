/**
 * Igris Brain -- Instance Tools
 *
 * Provides live instance registry for tracking active Igris sessions
 * across machines. Instances heartbeat to the brain with machine info,
 * current project, brief, and phase. Stale instances are auto-detected
 * when no heartbeat is received for 30+ minutes.
 *
 * Tools:
 * - igris_instance_heartbeat: Register or update a live instance
 * - igris_instance_list: List all active instances
 * - igris_instance_remove: Deregister an instance on /rest
 *
 * @module tools/instances
 * @author Fifty.ai
 */

import { getDb } from '../db.js';
import { randomUUID } from 'node:crypto';

/** Input shape for igris_instance_heartbeat */
interface InstanceHeartbeatInput {
  instance_id?: string;
  machine_hostname: string;
  machine_os?: string;
  project_slug?: string;
  project_path?: string;
  current_brief?: string;
  current_phase?: string;
  current_task?: string;
}

/** Input shape for igris_instance_list */
interface InstanceListInput {
  status?: string;
  project?: string;
  include_stale?: boolean;
}

/** Input shape for igris_instance_remove */
interface InstanceRemoveInput {
  instance_id: string;
}

/**
 * Register or update a live Igris instance in the brain.
 *
 * If an instance_id is provided, attempts to update the existing row.
 * If no instance_id is provided or the update affects zero rows,
 * generates a new UUID and inserts a fresh instance record.
 *
 * @param args - Instance data including machine hostname and optional fields
 * @returns MCP-formatted response with the instance ID
 */
function handleInstanceHeartbeat(args: InstanceHeartbeatInput): { content: { type: string; text: string }[] } {
  const db = getDb();
  const instanceId = args.instance_id ?? randomUUID();

  const result = db.prepare(`
    INSERT INTO instances (id, machine_hostname, machine_os, project_slug, project_path, current_brief, current_phase, current_task, status, last_heartbeat_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      machine_hostname = excluded.machine_hostname,
      machine_os = excluded.machine_os,
      project_slug = excluded.project_slug,
      project_path = excluded.project_path,
      current_brief = excluded.current_brief,
      current_phase = excluded.current_phase,
      current_task = excluded.current_task,
      status = 'active',
      last_heartbeat_at = datetime('now')
  `).run(
    instanceId,
    args.machine_hostname,
    args.machine_os ?? null,
    args.project_slug ?? null,
    args.project_path ?? null,
    args.current_brief ?? null,
    args.current_phase ?? null,
    args.current_task ?? null
  );

  const action = result.changes > 0 && args.instance_id ? 'heartbeat updated' : 'registered';

  return {
    content: [{
      type: 'text',
      text: `Instance ${action}: ${instanceId}`,
    }],
  };
}

/**
 * List all active Igris instances across machines.
 *
 * Automatically marks instances with no heartbeat for 30+ minutes as stale
 * before returning results. Supports filtering by status and project.
 *
 * @param args - Optional filters for status and project
 * @returns MCP-formatted response with instance table
 */
function handleInstanceList(args: InstanceListInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  // Purge instances stale for longer than 2 hours (120 minutes)
  db.prepare(
    "DELETE FROM instances WHERE last_heartbeat_at < datetime('now', '-120 minutes')"
  ).run();

  // Purge agent_events older than 7 days
  db.prepare(
    "DELETE FROM agent_events WHERE created_at < datetime('now', '-7 days')"
  ).run();

  // Auto-mark stale instances
  db.prepare(
    "UPDATE instances SET status = 'stale' WHERE last_heartbeat_at < datetime('now', '-30 minutes') AND status != 'stale'"
  ).run();

  // Build dynamic WHERE clause
  const conditions: string[] = [];
  const params: string[] = [];

  // By default, exclude stale instances unless explicitly requested
  if (!args.include_stale) {
    conditions.push("status != 'stale'");
  }

  if (args.status && args.status !== 'all') {
    conditions.push('status = ?');
    params.push(args.status);
  }
  if (args.project) {
    conditions.push('project_slug = ?');
    params.push(args.project);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT id, machine_hostname, machine_os, project_slug, current_brief,
           current_phase, current_task, status, last_heartbeat_at
    FROM instances
    ${whereClause}
    ORDER BY last_heartbeat_at DESC
  `).all(...params) as Record<string, unknown>[];

  if (rows.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No instances found.',
      }],
    };
  }

  // Format as markdown table
  const header = '| ID | Machine | OS | Project | Brief | Phase | Task | Status | Last Heartbeat |';
  const separator = '|----|---------|----|---------| ------|-------|------|--------|----------------|';
  const tableRows = rows.map(r => {
    const shortId = (r.id as string).substring(0, 8);
    return `| ${shortId} | ${r.machine_hostname || '-'} | ${r.machine_os || '-'} | ${r.project_slug || '-'} | ${r.current_brief || '-'} | ${r.current_phase || '-'} | ${r.current_task || '-'} | ${r.status || '-'} | ${r.last_heartbeat_at || '-'} |`;
  });

  return {
    content: [{
      type: 'text',
      text: [
        `# Live Instances (${rows.length} total)`,
        '',
        header,
        separator,
        ...tableRows,
      ].join('\n'),
    }],
  };
}

/**
 * Remove an Igris instance from the registry.
 *
 * Called on /rest to deregister the instance cleanly.
 *
 * @param args - The instance ID to remove
 * @returns MCP-formatted response confirming removal
 */
function handleInstanceRemove(args: InstanceRemoveInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  const result = db.prepare('DELETE FROM instances WHERE id = ?').run(args.instance_id);

  if (result.changes === 0) {
    return {
      content: [{
        type: 'text',
        text: `Instance not found: ${args.instance_id}`,
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: 'Instance removed successfully.',
    }],
  };
}

export { handleInstanceHeartbeat, handleInstanceList, handleInstanceRemove };
export type { InstanceHeartbeatInput, InstanceListInput, InstanceRemoveInput };
