/**
 * Igris Brain -- Instance Tools
 *
 * Provides live instance registry for tracking active Igris sessions
 * across machines. Liveness is proven locally with PID/start-time metadata,
 * while cross-machine coordination rides brief claims / work leases. Instance
 * state/activity updates are visibility metadata, not liveness proof.
 *
 * Tools:
 * - igris_instance_state: Register/update instance state
 * - igris_instance_list: List all active instances
 * - igris_instance_remove: Deregister an instance on /rest
 *
 * @module tools/instances
 * @author fifty.dev
 */

import { getDb } from '../db.js';
import { randomUUID } from 'node:crypto';

/** Input shape for the igris_instance_state tool. */
interface InstanceStateInput {
  instance_id?: string;
  machine_hostname: string;
  machine_os?: string;
  project_slug?: string;
  project_path?: string;
  current_brief?: string;
  current_phase?: string;
  current_task?: string;
  harness?: string;
  harness_session_id?: string;
  owner_pid?: number;
  owner_started_at?: string;
  liveness_method?: string;
  liveness_status?: string;
  liveness_checked_at?: string;
  lease_expires_at?: string;
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

function tableColumns(name: string): Set<string> {
  const db = getDb();
  const rows = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function ensureInstancesActivityColumn(): Set<string> {
  const db = getDb();
  let columns = tableColumns('instances');
  if (columns.has('last_activity_at')) return columns;
  if (columns.has('last_heartbeat_at')) {
    db.exec('ALTER TABLE instances RENAME COLUMN last_heartbeat_at TO last_activity_at');
    columns = tableColumns('instances');
  }
  return columns;
}

function optionalProjection(
  columns: ReadonlySet<string>,
  name: string,
  fallback = 'NULL',
): string {
  return columns.has(name) ? name : `${fallback} AS ${name}`;
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
function handleInstanceState(args: InstanceStateInput): { content: { type: string; text: string }[] } {
  const db = getDb();
  const instanceId = args.instance_id ?? randomUUID();
  const columns = ensureInstancesActivityColumn();
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const insertColumns = [
    'id',
    'machine_hostname',
    'machine_os',
    'project_slug',
    'project_path',
    'current_brief',
    'current_phase',
    'current_task',
    'status',
    'last_activity_at',
  ];
  const values: unknown[] = [
    instanceId,
    args.machine_hostname,
    args.machine_os ?? null,
    args.project_slug ?? null,
    args.project_path ?? null,
    args.current_brief ?? null,
    args.current_phase ?? null,
    args.current_task ?? null,
    'active',
    now,
  ];
  const updates = [
    'machine_hostname = excluded.machine_hostname',
    'machine_os = excluded.machine_os',
    'project_slug = excluded.project_slug',
    'project_path = excluded.project_path',
    'current_brief = excluded.current_brief',
    'current_phase = excluded.current_phase',
    'current_task = excluded.current_task',
    "status = 'active'",
    'last_activity_at = excluded.last_activity_at',
  ];

  for (const [name, value] of [
    ['harness', args.harness ?? null],
    ['harness_session_id', args.harness_session_id ?? null],
    ['owner_pid', args.owner_pid ?? null],
    ['owner_started_at', args.owner_started_at ?? null],
    ['liveness_method', args.liveness_method ?? null],
    ['liveness_status', args.liveness_status ?? null],
    ['liveness_checked_at', args.liveness_checked_at ?? null],
    ['lease_expires_at', args.lease_expires_at ?? null],
    ['state_updated_at', now],
  ] as Array<[string, unknown]>) {
    if (!columns.has(name)) continue;
    insertColumns.push(name);
    values.push(value);
    updates.push(`${name} = excluded.${name}`);
  }

  const result = db.prepare(`
    INSERT INTO instances (${insertColumns.join(', ')})
    VALUES (${insertColumns.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET
      ${updates.join(',\n      ')}
  `).run(...values);

  const action = result.changes > 0 && args.instance_id ? 'state updated' : 'registered';

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
 * Supports filtering by status and project. Ordinary listing does not mutate
 * rows based on activity age; activity time is not liveness.
 *
 * @param args - Optional filters for status and project
 * @returns MCP-formatted response with instance table
 */
function handleInstanceList(args: InstanceListInput): { content: { type: string; text: string }[] } {
  const db = getDb();
  const columns = ensureInstancesActivityColumn();

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
           current_phase, current_task, status, last_activity_at,
           ${optionalProjection(columns, 'harness')},
           ${optionalProjection(columns, 'harness_session_id')},
           ${optionalProjection(columns, 'owner_pid')},
           ${optionalProjection(columns, 'owner_started_at')},
           ${optionalProjection(columns, 'liveness_method')},
           ${optionalProjection(columns, 'liveness_status')},
           ${optionalProjection(columns, 'liveness_checked_at')},
           ${optionalProjection(columns, 'lease_expires_at')},
           ${optionalProjection(columns, 'state_updated_at')}
    FROM instances
    ${whereClause}
    ORDER BY last_activity_at DESC
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
  const header = '| ID | Harness | Machine | OS | Project | Brief | Phase | Task | Status | Liveness | Lease | Last Activity |';
  const separator = '|----|---------|---------|----|---------|-------|-------|------|--------|----------|-------|---------------|';
  const tableRows = rows.map(r => {
    const shortId = (r.id as string).substring(0, 8);
    return `| ${shortId} | ${r.harness || '-'} | ${r.machine_hostname || '-'} | ${r.machine_os || '-'} | ${r.project_slug || '-'} | ${r.current_brief || '-'} | ${r.current_phase || '-'} | ${r.current_task || '-'} | ${r.status || '-'} | ${r.liveness_status || '-'} | ${r.lease_expires_at || '-'} | ${r.state_updated_at || r.last_activity_at || '-'} |`;
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

export { handleInstanceState, handleInstanceList, handleInstanceRemove };
export type { InstanceStateInput, InstanceListInput, InstanceRemoveInput };
