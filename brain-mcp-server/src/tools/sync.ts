/**
 * Igris Brain -- Sync Tools
 *
 * Provides bidirectional sync between local and remote brain instances.
 * Push sends local changes to a remote brain server.
 * Pull retrieves remote changes into the local brain.
 *
 * Conflict resolution uses last-write-wins (LWW) based on timestamps,
 * with special merge strategies for tags (union) and counts (max).
 * Append-only tables (sessions, agent_metrics) use composite key
 * deduplication instead of LWW.
 *
 * Tools:
 * - igris_brain_push: Push local changes to remote brain
 * - igris_brain_pull: Pull remote changes to local brain
 * - igris_file_push: Push a flat file to the remote brain server
 * - igris_file_pull: Pull a flat file from the remote brain server
 *
 * @module tools/sync
 * @author Fifty.ai
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { errMsg } from '../engine/helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input shape for igris_brain_push */
export interface BrainPushInput {
  remote_url: string;
  api_key: string;
}

/** Input shape for igris_brain_pull */
export interface BrainPullInput {
  remote_url: string;
  api_key: string;
}

/** Valid file types for flat file sync */
export type SyncFileType = 'events' | 'agent_metrics' | 'budget';

/** Input shape for igris_file_push */
export interface FilePushInput {
  file_type: SyncFileType;
  content: string;
  remote_url: string;
  api_key: string;
}

/** Input shape for igris_file_pull */
export interface FilePullInput {
  file_type: SyncFileType;
  remote_url: string;
  api_key: string;
}

/** Configuration for a syncable table */
interface SyncTableConfig {
  table: string;
  syncKey: string[];
  timestampCol: string;
  strategy: 'lww' | 'append';
  mergeFields?: Record<string, 'max' | 'merge_tags'>;
  columns: string[];
}

// ---------------------------------------------------------------------------
// Sync table definitions
// ---------------------------------------------------------------------------

export const SYNC_TABLES: SyncTableConfig[] = [
  {
    table: 'learnings',
    syncKey: ['project', 'category', 'title'],
    timestampCol: 'created_at',
    strategy: 'lww',
    mergeFields: { tags: 'merge_tags' },
    columns: [
      'project', 'category', 'title', 'content', 'tags', 'tech_stack',
      'scope', 'source_brief', 'confidence', 'created_at', 'updated_at',
      'access_count', 'last_accessed_at',
    ],
  },
  {
    table: 'errors',
    syncKey: ['project', 'fingerprint'],
    timestampCol: 'last_seen_at',
    strategy: 'lww',
    mergeFields: { occurrence_count: 'max' },
    columns: [
      'project', 'fingerprint', 'message', 'solution', 'context',
      'tech_stack', 'scope', 'occurrence_count', 'first_seen_at',
      'last_seen_at', 'resolved_at',
    ],
  },
  {
    table: 'projects',
    syncKey: ['slug'],
    timestampCol: 'last_session_at',
    strategy: 'lww',
    columns: [
      'slug', 'name', 'path', 'tech_stack', 'igris_version', 'status',
      'registered_at', 'last_session_at', 'metadata',
    ],
  },
  {
    table: 'sessions',
    syncKey: ['project', 'started_at'],
    timestampCol: 'started_at',
    strategy: 'append',
    columns: [
      'project', 'brief_id', 'phase', 'mode', 'summary',
      'started_at', 'ended_at',
    ],
  },
  {
    table: 'brief_status',
    syncKey: ['project', 'brief_id'],
    timestampCol: 'updated_at',
    strategy: 'lww',
    columns: [
      'project', 'brief_id', 'brief_type', 'title', 'status',
      'priority', 'effort', 'phase', 'updated_at',
    ],
  },
  {
    table: 'instances',
    syncKey: ['id'],
    timestampCol: 'last_heartbeat_at',
    strategy: 'lww',
    columns: [
      'id', 'machine_hostname', 'machine_os', 'project_slug', 'project_path',
      'current_brief', 'current_phase', 'current_task', 'status',
      'started_at', 'last_heartbeat_at', 'metadata',
    ],
  },
  {
    table: 'agent_metrics',
    syncKey: ['project', 'agent', 'action', 'recorded_at'],
    timestampCol: 'recorded_at',
    strategy: 'append',
    columns: [
      'project', 'agent', 'brief_id', 'action', 'result',
      'duration_ms', 'retry_count', 'metadata', 'recorded_at',
    ],
  },
  {
    table: 'brief_files',
    syncKey: ['project', 'brief_id'],
    timestampCol: 'updated_at',
    strategy: 'lww',
    columns: ['project', 'brief_id', 'filename', 'content', 'content_hash', 'updated_at'],
  },
  {
    table: 'session_files',
    syncKey: ['project', 'filename'],
    timestampCol: 'updated_at',
    strategy: 'lww',
    columns: ['project', 'filename', 'content', 'content_hash', 'updated_at'],
  },
  {
    table: 'definition_files',
    syncKey: ['type', 'name'],
    timestampCol: 'updated_at',
    strategy: 'lww',
    columns: ['type', 'name', 'filename', 'content', 'content_hash', 'version', 'updated_at'],
  },
  {
    table: 'agent_events',
    syncKey: ['instance_id', 'agent', 'event_type', 'created_at'],
    timestampCol: 'created_at',
    strategy: 'append',
    columns: [
      'instance_id', 'agent', 'event_type', 'phase', 'brief_id',
      'duration_ms', 'input_tokens', 'output_tokens', 'cache_read', 'cache_create',
      'result', 'error_message', 'metadata', 'created_at',
    ],
  },
  {
    table: 'tasks',
    syncKey: ['id'],
    timestampCol: 'updated_at',
    strategy: 'lww',
    columns: [
      'id', 'task_type', 'scope', 'title', 'description', 'brief_id',
      'project_slug', 'parent_id', 'status', 'priority', 'assignee',
      'due_at', 'defer_until', 'created_by', 'metadata',
      'created_at', 'updated_at',
    ],
  },
  {
    table: 'task_deps',
    syncKey: ['task_id', 'depends_on'],
    timestampCol: 'created_at',
    strategy: 'lww',
    columns: ['task_id', 'depends_on', 'created_at'],
  },
  {
    table: 'task_results',
    syncKey: ['id'],
    strategy: 'lww',
    timestampCol: 'created_at',
    columns: ['id', 'task_id', 'result_type', 'content', 'file_path', 'metadata', 'created_at'],
  },
  {
    table: 'task_assignments',
    syncKey: ['id'],
    timestampCol: 'assigned_at',
    strategy: 'lww',
    columns: [
      'id', 'task_id', 'agent', 'assigned_at', 'completed_at', 'result',
    ],
  },
  {
    table: 'agent_capabilities',
    syncKey: ['agent', 'capability'],
    timestampCol: 'created_at',
    strategy: 'lww',
    columns: ['agent', 'capability', 'created_at'],
  },
  {
    table: 'autonomous_decisions',
    syncKey: ['id'],
    timestampCol: 'created_at',
    strategy: 'append',
    columns: ['id', 'decision_type', 'task_id', 'agent', 'detail', 'created_at'],
  },
  {
    table: 'coordination_config',
    syncKey: ['key'],
    timestampCol: 'updated_at',
    strategy: 'lww',
    columns: ['key', 'value', 'updated_at'],
  },
  {
    table: 'schedules',
    syncKey: ['id'],
    timestampCol: 'updated_at',
    strategy: 'lww',
    columns: [
      'id', 'name', 'description', 'cron_expr', 'handler_type', 'handler_config',
      'enabled', 'project_slug', 'tags', 'max_retries', 'timeout_ms',
      'next_run_at', 'last_run_at', 'created_at', 'updated_at',
    ],
  },
  {
    table: 'schedule_runs',
    syncKey: ['id'],
    timestampCol: 'started_at',
    strategy: 'append',
    columns: [
      'id', 'schedule_id', 'status', 'started_at', 'finished_at',
      'duration_ms', 'result', 'error', 'attempt',
    ],
  },
  {
    table: 'event_log',
    syncKey: ['id'],
    timestampCol: 'created_at',
    strategy: 'append',
    columns: [
      'id', 'event_name', 'component', 'payload', 'machine_hostname',
      'project_slug', 'instance_id', 'created_at',
    ],
  },
];

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Merge two comma-separated tag strings into a sorted union.
 *
 * @param localTags - Comma-separated tags from the local record
 * @param remoteTags - Comma-separated tags from the remote record
 * @returns Sorted, deduplicated comma-separated tags
 */
function mergeTags(localTags: string, remoteTags: string): string {
  const localSet = new Set(localTags.split(',').map(t => t.trim()).filter(Boolean));
  const remoteSet = new Set(remoteTags.split(',').map(t => t.trim()).filter(Boolean));
  const merged = new Set([...localSet, ...remoteSet]);
  return Array.from(merged).sort().join(',');
}

/**
 * Fetch with retry logic and timeout.
 *
 * Retries on 5xx errors with exponential backoff.
 * Throws immediately on 4xx errors (client errors).
 *
 * @param url - The URL to fetch
 * @param options - Fetch options (headers, body, method, etc.)
 * @param maxRetries - Maximum number of retries (default: 2)
 * @returns The successful Response object
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 2
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok) return response;
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Don't retry client errors
      if (lastError.message.startsWith('HTTP 4')) {
        throw lastError;
      }
    }
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError ?? new Error('Fetch failed');
}

/** Maximum approximate payload size per chunk in bytes (5 MB). */
const CHUNK_SIZE_LIMIT = 5 * 1024 * 1024;

/**
 * Split a tables payload into multiple chunks, each under CHUNK_SIZE_LIMIT.
 * Iterates rows across tables, accumulating into chunks. A single oversized
 * row is allowed in its own chunk (never split a row).
 */
export function chunkTablesForPush(
  tables: Record<string, Record<string, unknown>[]>
): Record<string, Record<string, unknown>[]>[] {
  const chunks: Record<string, Record<string, unknown>[]>[] = [];
  let currentChunk: Record<string, Record<string, unknown>[]> = {};
  let currentSize = 0;

  for (const [tableName, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const rowSize = Buffer.byteLength(JSON.stringify(row), 'utf8');

      if (currentSize + rowSize > CHUNK_SIZE_LIMIT && currentSize > 0) {
        chunks.push(currentChunk);
        currentChunk = {};
        currentSize = 0;
      }

      if (!currentChunk[tableName]) {
        currentChunk[tableName] = [];
      }
      currentChunk[tableName].push(row);
      currentSize += rowSize;
    }
  }

  if (currentSize > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// mergeRows — core merge logic (used by both pull handler and push endpoint)
// ---------------------------------------------------------------------------

/**
 * Merge incoming rows into the local database for a given table config.
 *
 * For LWW tables: insert if new, update if remote timestamp is newer, skip otherwise.
 * For append tables: insert if composite key doesn't exist, skip otherwise.
 *
 * Special merge strategies:
 * - merge_tags: union of comma-separated tag lists
 * - max: take the larger numeric value
 *
 * @param db - The database instance to merge into
 * @param config - The sync table configuration
 * @param rows - The incoming rows to merge
 * @returns Counts of inserted, updated, and skipped rows
 */
export function mergeRows(
  db: Database.Database,
  config: SyncTableConfig,
  rows: Record<string, unknown>[]
): { inserted: number; updated: number; skipped: number } {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const lookupSql = `SELECT * FROM ${config.table} WHERE ${
    config.syncKey.map(k => `${k} = ?`).join(' AND ')
  }`;
  const lookupStmt = db.prepare(lookupSql);

  for (const row of rows) {
    const keyValues = config.syncKey.map(k => row[k]);
    const existing = lookupStmt.get(...keyValues) as Record<string, unknown> | undefined;

    if (!existing) {
      const cols = config.columns.filter(c => row[c] !== undefined);
      const placeholders = cols.map(() => '?').join(', ');
      db.prepare(
        `INSERT INTO ${config.table} (${cols.join(', ')}) VALUES (${placeholders})`
      ).run(...cols.map(c => row[c] ?? null));
      inserted++;
    } else if (config.strategy === 'append') {
      skipped++;
    } else {
      // LWW strategy: compare timestamps
      const localTs = (existing[config.timestampCol] as string) ?? '';
      const remoteTs = (row[config.timestampCol] as string) ?? '';

      if (remoteTs > localTs) {
        const setClauses: string[] = [];
        const setValues: unknown[] = [];

        for (const col of config.columns) {
          if (config.syncKey.includes(col)) continue;

          if (config.mergeFields?.[col] === 'merge_tags') {
            setClauses.push(`${col} = ?`);
            setValues.push(mergeTags(
              (existing[col] as string) || '',
              (row[col] as string) || ''
            ));
          } else if (config.mergeFields?.[col] === 'max') {
            setClauses.push(`${col} = ?`);
            setValues.push(Math.max(
              (existing[col] as number) || 0,
              (row[col] as number) || 0
            ));
          } else {
            setClauses.push(`${col} = ?`);
            setValues.push(row[col] ?? null);
          }
        }

        if (setClauses.length > 0) {
          const whereClause = config.syncKey.map(k => `${k} = ?`).join(' AND ');
          db.prepare(
            `UPDATE ${config.table} SET ${setClauses.join(', ')} WHERE ${whereClause}`
          ).run(...setValues, ...keyValues);
          updated++;
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    }
  }

  return { inserted, updated, skipped };
}

// ---------------------------------------------------------------------------
// handleBrainPush
// ---------------------------------------------------------------------------

/**
 * Push local brain changes to a remote brain server.
 *
 * For each sync table, queries rows changed since the last push timestamp,
 * POSTs them to the remote server, and updates the local sync_state on success.
 *
 * @param args - Remote URL and API key
 * @returns MCP-formatted response with push summary
 */
async function handleBrainPush(
  args: BrainPushInput
): Promise<{ content: { type: string; text: string }[] }> {
  const db = getDb();
  const remoteUrl = args.remote_url.replace(/\/+$/, '');
  const pushedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const tables: Record<string, Record<string, unknown>[]> = {};
  let totalRows = 0;

  for (const config of SYNC_TABLES) {
    // Get last push timestamp for this table
    const stateRow = db.prepare(
      'SELECT last_push_at FROM sync_state WHERE remote_url = ? AND table_name = ?'
    ).get(remoteUrl, config.table) as { last_push_at: string } | undefined;

    const lastPushAt = stateRow?.last_push_at ?? '1970-01-01T00:00:00';

    // Query rows changed since last push
    const cols = config.columns.join(', ');
    const rows = db.prepare(
      `SELECT ${cols} FROM ${config.table} WHERE ${config.timestampCol} > ?`
    ).all(lastPushAt) as Record<string, unknown>[];

    if (rows.length > 0) {
      tables[config.table] = rows;
      totalRows += rows.length;
    }
  }

  if (totalRows === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No changes to push. All tables are up to date with the remote brain.',
      }],
    };
  }

  // Chunk and POST to remote
  const chunks = chunkTablesForPush(tables);

  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunkPayload = {
        tables: chunks[i],
        pushed_at: pushedAt,
        schema_version: 9,
      };

      const response = await fetchWithRetry(`${remoteUrl}/sync/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${args.api_key}`,
        },
        body: JSON.stringify(chunkPayload),
      });

      const result = await response.json() as Record<string, unknown>;

      // Validate remote response before continuing
      if (!result.ok || !result.results) {
        console.error(`[brain] Remote sync response missing 'ok' or 'results' for chunk ${i + 1}/${chunks.length}:`, JSON.stringify(result));
        throw new Error(`Remote returned invalid response for chunk ${i + 1}/${chunks.length}`);
      }
    }

    // Update sync_state for each pushed table only after ALL chunks succeed
    const upsertState = db.prepare(`
      INSERT INTO sync_state (remote_url, table_name, last_push_at)
      VALUES (?, ?, ?)
      ON CONFLICT(remote_url, table_name)
      DO UPDATE SET last_push_at = excluded.last_push_at
    `);

    db.transaction(() => {
      for (const tableName of Object.keys(tables)) {
        upsertState.run(remoteUrl, tableName, pushedAt);
      }
    })();

    // Format summary
    const tablesSummary = Object.entries(tables)
      .map(([name, rows]) => `  - ${name}: ${rows.length} row(s)`)
      .join('\n');

    return {
      content: [{
        type: 'text',
        text: [
          'Brain push completed successfully.',
          '',
          `Remote: ${remoteUrl}`,
          `Total rows pushed: ${totalRows}`,
          `Chunks sent: ${chunks.length}`,
          `Tables:`,
          tablesSummary,
        ].join('\n'),
      }],
    };
  } catch (err) {
    const message = errMsg(err);

    // Queue failed rows for later retry via sync_queue
    let queued = 0;
    try {
      queued = queueFailedRows(db, tables, message);
    } catch (queueErr) {
      console.error('[brain] Failed to queue rows for retry:', queueErr);
    }

    return {
      content: [{
        type: 'text',
        text: `Brain push failed: ${message}\n\nRemote: ${remoteUrl}\nRows queued for retry: ${queued}\n\nUse igris_sync_queue_drain to retry failed pushes.`,
      }],
      isError: true,
    } as { content: { type: string; text: string }[]; isError: boolean };
  }
}

// ---------------------------------------------------------------------------
// handleBrainPull
// ---------------------------------------------------------------------------

/**
 * Pull remote brain changes to the local brain.
 *
 * For each sync table, queries the remote server for rows changed since the
 * last pull timestamp, then merges them into the local database.
 *
 * @param args - Remote URL and API key
 * @returns MCP-formatted response with pull summary
 */
async function handleBrainPull(
  args: BrainPullInput
): Promise<{ content: { type: string; text: string }[] }> {
  const db = getDb();
  const remoteUrl = args.remote_url.replace(/\/+$/, '');
  const pulledAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // Build query params with per-table timestamps
  const params = new URLSearchParams();
  for (const config of SYNC_TABLES) {
    const stateRow = db.prepare(
      'SELECT last_pull_at FROM sync_state WHERE remote_url = ? AND table_name = ?'
    ).get(remoteUrl, config.table) as { last_pull_at: string } | undefined;

    const lastPullAt = stateRow?.last_pull_at ?? '1970-01-01T00:00:00';
    params.set(`since_${config.table}`, lastPullAt);
  }

  try {
    const response = await fetchWithRetry(`${remoteUrl}/sync/pull?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${args.api_key}`,
      },
    });

    const data = await response.json() as {
      tables?: Record<string, Record<string, unknown>[]>;
    };

    if (!data || typeof data !== 'object' || !data.tables || typeof data.tables !== 'object') {
      return {
        content: [{
          type: 'text',
          text: `Pull response invalid or contained no tables. Nothing to merge. Sync state was NOT updated.`,
        }],
      };
    }

    const validatedTables = data.tables;

    // Merge rows within a transaction for performance
    const summary: string[] = [];
    let totalMerged = 0;

    const upsertState = db.prepare(`
      INSERT INTO sync_state (remote_url, table_name, last_pull_at)
      VALUES (?, ?, ?)
      ON CONFLICT(remote_url, table_name)
      DO UPDATE SET last_pull_at = excluded.last_pull_at
    `);

    db.transaction(() => {
      for (const config of SYNC_TABLES) {
        const rows = validatedTables[config.table];
        if (!rows || rows.length === 0) continue;

        const result = mergeRows(db, config, rows);
        totalMerged += result.inserted + result.updated;
        summary.push(
          `  - ${config.table}: ${rows.length} received (${result.inserted} inserted, ${result.updated} updated, ${result.skipped} skipped)`
        );

        upsertState.run(remoteUrl, config.table, pulledAt);
      }
    })();

    if (summary.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No new changes from remote brain. Local brain is up to date.',
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: [
          'Brain pull completed successfully.',
          '',
          `Remote: ${remoteUrl}`,
          `Total merged: ${totalMerged}`,
          `Tables:`,
          ...summary,
        ].join('\n'),
      }],
    };
  } catch (err) {
    const message = errMsg(err);
    return {
      content: [{
        type: 'text',
        text: `Brain pull failed: ${message}\n\nRemote: ${remoteUrl}\n\nSync state was NOT updated. Retry with the same command.`,
      }],
      isError: true,
    } as { content: { type: string; text: string }[]; isError: boolean };
  }
}

// ---------------------------------------------------------------------------
// Sync Queue — FR-036
// ---------------------------------------------------------------------------

/** Input shape for igris_sync_queue_drain */
export interface SyncQueueDrainInput {
  remote_url: string;
  api_key: string;
}

/**
 * Queue failed push rows into the sync_queue table for later retry.
 *
 * @param db - The database instance
 * @param tables - Map of table name to rows that failed to push
 * @param error - The error message from the failed push
 */
export function queueFailedRows(
  db: Database.Database,
  tables: Record<string, Record<string, unknown>[]>,
  error: string
): number {
  const insertStmt = db.prepare(`
    INSERT INTO sync_queue (table_name, row_data, operation, status, error_message)
    VALUES (?, ?, 'push', 'pending', ?)
  `);

  let queued = 0;
  db.transaction(() => {
    for (const [tableName, rows] of Object.entries(tables)) {
      for (const row of rows) {
        insertStmt.run(tableName, JSON.stringify(row), error);
        queued++;
      }
    }
  })();

  return queued;
}

/**
 * Get sync queue status summary.
 *
 * @returns MCP-formatted response with queue depth and status counts
 */
function handleSyncQueueStatus(): { content: { type: string; text: string }[] } {
  const db = getDb();

  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) as count FROM sync_queue GROUP BY status
  `).all() as { status: string; count: number }[];

  const tableCounts = db.prepare(`
    SELECT table_name, COUNT(*) as count FROM sync_queue WHERE status IN ('pending', 'retrying') GROUP BY table_name
  `).all() as { table_name: string; count: number }[];

  const total = statusCounts.reduce((sum, r) => sum + r.count, 0);
  const pending = statusCounts.find(r => r.status === 'pending')?.count ?? 0;
  const retrying = statusCounts.find(r => r.status === 'retrying')?.count ?? 0;
  const sent = statusCounts.find(r => r.status === 'sent')?.count ?? 0;
  const failed = statusCounts.find(r => r.status === 'failed')?.count ?? 0;

  const lines = [
    '# Sync Queue Status',
    '',
    `Total entries: ${total}`,
    `Pending: ${pending}`,
    `Retrying: ${retrying}`,
    `Sent: ${sent}`,
    `Failed: ${failed}`,
  ];

  if (tableCounts.length > 0) {
    lines.push('', '## Actionable by Table');
    for (const tc of tableCounts) {
      lines.push(`- ${tc.table_name}: ${tc.count} row(s)`);
    }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * Process pending sync queue items by pushing them to the remote.
 *
 * Selects rows with status 'pending' or 'retrying' and retry_count < max_retries,
 * groups them by table, attempts to push via fetchWithRetry, and updates status.
 *
 * @param args - Remote URL and API key
 * @returns MCP-formatted response with drain summary
 */
async function handleSyncQueueDrain(
  args: SyncQueueDrainInput
): Promise<{ content: { type: string; text: string }[] }> {
  const db = getDb();
  const remoteUrl = args.remote_url.replace(/\/+$/, '');

  // Select actionable queue items
  const items = db.prepare(`
    SELECT id, table_name, row_data, retry_count, max_retries
    FROM sync_queue
    WHERE status IN ('pending', 'retrying') AND retry_count < max_retries
    ORDER BY created_at ASC
    LIMIT 500
  `).all() as { id: number; table_name: string; row_data: string; retry_count: number; max_retries: number }[];

  if (items.length === 0) {
    return {
      content: [{ type: 'text', text: 'Sync queue is empty. No items to drain.' }],
    };
  }

  // Group by table
  const grouped: Record<string, { ids: number[]; rows: Record<string, unknown>[] }> = {};
  for (const item of items) {
    if (!grouped[item.table_name]) {
      grouped[item.table_name] = { ids: [], rows: [] };
    }
    grouped[item.table_name].ids.push(item.id);
    grouped[item.table_name].rows.push(JSON.parse(item.row_data));
  }

  // Build tables map for chunking
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const [tableName, group] of Object.entries(grouped)) {
    tables[tableName] = group.rows;
  }

  const chunks = chunkTablesForPush(tables);

  // Build a mapping from each chunk index to the queue item IDs it contains.
  // We use object reference identity (indexOf) to match rows back to their IDs.
  const chunkItemIds: number[][] = [];
  for (const chunk of chunks) {
    const ids: number[] = [];
    for (const [tableName, chunkRows] of Object.entries(chunk)) {
      const group = grouped[tableName];
      for (const row of chunkRows) {
        const rowIndex = group.rows.indexOf(row);
        if (rowIndex !== -1) {
          ids.push(group.ids[rowIndex]);
        }
      }
    }
    chunkItemIds.push(ids);
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const markSent = db.prepare(`
    UPDATE sync_queue SET status = 'sent', sent_at = ? WHERE id = ?
  `);
  const updateRetry = db.prepare(`
    UPDATE sync_queue
    SET retry_count = retry_count + 1,
        last_retry_at = ?,
        status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE 'retrying' END,
        error_message = ?
    WHERE id = ?
  `);

  let totalSent = 0;
  let totalFailed = 0;

  for (let i = 0; i < chunks.length; i++) {
    try {
      await fetchWithRetry(`${remoteUrl}/sync/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${args.api_key}`,
        },
        body: JSON.stringify({ tables: chunks[i], pushed_at: now, schema_version: 9 }),
      });

      // Per-chunk success: mark items as sent
      db.transaction(() => {
        for (const id of chunkItemIds[i]) {
          markSent.run(now, id);
        }
      })();
      totalSent += chunkItemIds[i].length;
    } catch (err) {
      const message = errMsg(err);

      // Per-chunk failure: mark items as retrying/failed
      db.transaction(() => {
        for (const id of chunkItemIds[i]) {
          updateRetry.run(now, message, id);
        }
      })();
      totalFailed += chunkItemIds[i].length;
    }
  }

  const tablesSummary = Object.entries(tables)
    .map(([name, rows]) => `  - ${name}: ${rows.length} row(s)`)
    .join('\n');

  if (totalSent === 0) {
    return {
      content: [{
        type: 'text',
        text: [
          'Sync queue drain failed: all chunks failed.',
          '',
          `Remote: ${remoteUrl}`,
          `Chunks attempted: ${chunks.length}`,
          `Items sent: ${totalSent}`,
          `Items failed: ${totalFailed}`,
          `Tables:`,
          tablesSummary,
        ].join('\n'),
      }],
      isError: true,
    } as { content: { type: string; text: string }[]; isError: boolean };
  }

  return {
    content: [{
      type: 'text',
      text: [
        totalFailed === 0
          ? 'Sync queue drain completed successfully.'
          : 'Sync queue drain completed with partial success.',
        '',
        `Remote: ${remoteUrl}`,
        `Chunks sent: ${chunks.length}`,
        `Items sent: ${totalSent}`,
        ...(totalFailed > 0 ? [`Items failed: ${totalFailed}`] : []),
        `Tables:`,
        tablesSummary,
      ].join('\n'),
    }],
  };
}

// ---------------------------------------------------------------------------
// Brief File Sync — FR-037
// ---------------------------------------------------------------------------

/** Input shape for igris_brief_file_sync */
export interface BriefFileSyncInput {
  project: string;
  brief_id: string;
  filename: string;
  content: string;
}

/**
 * Sync a brief file's content to the brain.
 *
 * Computes a SHA-256 hash of the content, then upserts into brief_files.
 *
 * @param args - Brief file data
 * @returns MCP-formatted response confirming the sync
 */
function handleBriefFileSync(
  args: BriefFileSyncInput
): { content: { type: string; text: string }[] } {
  const db = getDb();
  const contentHash = createHash('sha256').update(args.content).digest('hex');
  const id = randomUUID();
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  db.prepare(`
    INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, brief_id) DO UPDATE SET
      filename = excluded.filename,
      content = excluded.content,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `).run(id, args.project, args.brief_id, args.filename, args.content, contentHash, now);

  return {
    content: [{
      type: 'text',
      text: [
        'Brief file synced successfully.',
        '',
        `Project: ${args.project}`,
        `Brief: ${args.brief_id}`,
        `Filename: ${args.filename}`,
        `Content hash: ${contentHash.substring(0, 12)}...`,
        `Size: ${args.content.length} chars`,
      ].join('\n'),
    }],
  };
}

// ---------------------------------------------------------------------------
// Session File Sync — FR-038
// ---------------------------------------------------------------------------

/** Input shape for igris_session_file_sync */
export interface SessionFileSyncInput {
  project: string;
  filename: string;
  content: string;
}

/** Input shape for igris_session_file_pull */
export interface SessionFilePullInput {
  project: string;
}

/**
 * Sync a session file's content to the brain.
 *
 * @param args - Session file data
 * @returns MCP-formatted response confirming the sync
 */
function handleSessionFileSync(
  args: SessionFileSyncInput
): { content: { type: string; text: string }[] } {
  const db = getDb();
  const contentHash = createHash('sha256').update(args.content).digest('hex');
  const id = randomUUID();
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  db.prepare(`
    INSERT INTO session_files (id, project, filename, content, content_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, filename) DO UPDATE SET
      content = excluded.content,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `).run(id, args.project, args.filename, args.content, contentHash, now);

  return {
    content: [{
      type: 'text',
      text: [
        'Session file synced successfully.',
        '',
        `Project: ${args.project}`,
        `Filename: ${args.filename}`,
        `Content hash: ${contentHash.substring(0, 12)}...`,
        `Size: ${args.content.length} chars`,
      ].join('\n'),
    }],
  };
}

/**
 * Pull all session files for a project.
 *
 * @param args - Project to pull session files for
 * @returns MCP-formatted response with all session files
 */
function handleSessionFilePull(
  args: SessionFilePullInput
): { content: { type: string; text: string }[] } {
  const db = getDb();

  const rows = db.prepare(`
    SELECT filename, content, content_hash, updated_at
    FROM session_files
    WHERE project = ?
    ORDER BY updated_at DESC
  `).all(args.project) as { filename: string; content: string; content_hash: string; updated_at: string }[];

  if (rows.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No session files found for project: ${args.project}`,
      }],
    };
  }

  const files = rows.map(r => ({
    filename: r.filename,
    content: r.content,
    content_hash: r.content_hash,
    updated_at: r.updated_at,
  }));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ project: args.project, files, count: files.length }, null, 2),
    }],
  };
}

// ---------------------------------------------------------------------------
// Definition File Sync — FR-039
// ---------------------------------------------------------------------------

/** Input shape for igris_definition_sync */
export interface DefinitionSyncInput {
  type: 'agent' | 'skill' | 'rule' | 'prompt';
  name: string;
  filename: string;
  content: string;
  version?: string;
}

/** Input shape for igris_definition_pull */
export interface DefinitionPullInput {
  since?: string;
}

/**
 * Sync a definition file (agent, skill, rule, prompt) to the brain.
 *
 * @param args - Definition file data
 * @returns MCP-formatted response confirming the sync
 */
function handleDefinitionSync(
  args: DefinitionSyncInput
): { content: { type: string; text: string }[] } {
  const db = getDb();
  const contentHash = createHash('sha256').update(args.content).digest('hex');
  const id = randomUUID();
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  db.prepare(`
    INSERT INTO definition_files (id, type, name, filename, content, content_hash, version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(type, name) DO UPDATE SET
      filename = excluded.filename,
      content = excluded.content,
      content_hash = excluded.content_hash,
      version = excluded.version,
      updated_at = excluded.updated_at
  `).run(id, args.type, args.name, args.filename, args.content, contentHash, args.version ?? null, now);

  return {
    content: [{
      type: 'text',
      text: [
        'Definition synced successfully.',
        '',
        `Type: ${args.type}`,
        `Name: ${args.name}`,
        `Filename: ${args.filename}`,
        `Content hash: ${contentHash.substring(0, 12)}...`,
        args.version ? `Version: ${args.version}` : null,
        `Size: ${args.content.length} chars`,
      ].filter(Boolean).join('\n'),
    }],
  };
}

/**
 * Pull definitions newer than a given timestamp.
 *
 * @param args - Optional since timestamp
 * @returns MCP-formatted response with definitions
 */
function handleDefinitionPull(
  args: DefinitionPullInput
): { content: { type: string; text: string }[] } {
  const db = getDb();
  const since = args.since ?? '1970-01-01T00:00:00';

  const rows = db.prepare(`
    SELECT type, name, filename, content, content_hash, version, updated_at
    FROM definition_files
    WHERE updated_at > ?
    ORDER BY type, name
  `).all(since) as { type: string; name: string; filename: string; content: string; content_hash: string; version: string | null; updated_at: string }[];

  if (rows.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No definitions found newer than ${since}.`,
      }],
    };
  }

  const definitions = rows.map(r => ({
    type: r.type,
    name: r.name,
    filename: r.filename,
    content: r.content,
    content_hash: r.content_hash,
    version: r.version,
    updated_at: r.updated_at,
  }));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ definitions, count: definitions.length, since }, null, 2),
    }],
  };
}

// ---------------------------------------------------------------------------
// File Sync — BR-023
// ---------------------------------------------------------------------------

/**
 * Push a flat file (events.jsonl, agent-metrics.json, budget.json) to the
 * remote brain server via HTTP. Updates local sync_state for dashboard tracking.
 *
 * @param args - File type, content, remote URL, and API key
 * @returns MCP-formatted response with push summary
 */
async function handleFilePush(
  args: FilePushInput
): Promise<{ content: { type: string; text: string }[] }> {
  const db = getDb();
  const remoteUrl = args.remote_url.replace(/\/+$/, '');
  const pushedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const byteSize = Buffer.byteLength(args.content, 'utf8');

  try {
    await fetchWithRetry(`${remoteUrl}/sync/file-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${args.api_key}`,
      },
      body: JSON.stringify({
        file_type: args.file_type,
        content: args.content,
      }),
    });

    // Update local sync_state
    db.prepare(`
      INSERT INTO sync_state (remote_url, table_name, last_push_at)
      VALUES (?, ?, ?)
      ON CONFLICT(remote_url, table_name)
      DO UPDATE SET last_push_at = excluded.last_push_at
    `).run(remoteUrl, `file:${args.file_type}`, pushedAt);

    return {
      content: [{
        type: 'text',
        text: [
          'File push completed successfully.',
          '',
          `Remote: ${remoteUrl}`,
          `File type: ${args.file_type}`,
          `Bytes pushed: ${byteSize}`,
          `Pushed at: ${pushedAt}`,
        ].join('\n'),
      }],
    };
  } catch (err) {
    const message = errMsg(err);
    return {
      content: [{
        type: 'text',
        text: `File push failed: ${message}\n\nRemote: ${remoteUrl}\nFile type: ${args.file_type}`,
      }],
      isError: true,
    } as { content: { type: string; text: string }[]; isError: boolean };
  }
}

/**
 * Pull a flat file from the remote brain server.
 *
 * @param args - File type, remote URL, and API key
 * @returns MCP-formatted response with file content
 */
async function handleFilePull(
  args: FilePullInput
): Promise<{ content: { type: string; text: string }[] }> {
  const remoteUrl = args.remote_url.replace(/\/+$/, '');

  try {
    const response = await fetchWithRetry(
      `${remoteUrl}/sync/file-pull/${args.file_type}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${args.api_key}`,
        },
      },
    );

    const data = await response.json() as {
      file_type: string;
      content: string;
      size: number;
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          file_type: data.file_type,
          content: data.content,
          size: data.size,
        }, null, 2),
      }],
    };
  } catch (err) {
    const message = errMsg(err);
    return {
      content: [{
        type: 'text',
        text: `File pull failed: ${message}\n\nRemote: ${remoteUrl}\nFile type: ${args.file_type}`,
      }],
      isError: true,
    } as { content: { type: string; text: string }[]; isError: boolean };
  }
}

export {
  handleBrainPush,
  handleBrainPull,
  handleSyncQueueStatus,
  handleSyncQueueDrain,
  handleBriefFileSync,
  handleSessionFileSync,
  handleSessionFilePull,
  handleDefinitionSync,
  handleDefinitionPull,
  handleFilePush,
  handleFilePull,
};
export type { SyncTableConfig };
