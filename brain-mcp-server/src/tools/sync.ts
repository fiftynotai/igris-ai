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
 *
 * @module tools/sync
 * @author Fifty.ai
 */

import type Database from 'better-sqlite3';
import { getDb } from '../db.js';

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
async function fetchWithRetry(
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

  // POST to remote
  const payload = {
    tables,
    pushed_at: pushedAt,
    schema_version: 4,
  };

  try {
    const response = await fetchWithRetry(`${remoteUrl}/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${args.api_key}`,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json() as Record<string, unknown>;

    // Update sync_state for each pushed table
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
          `Tables:`,
          tablesSummary,
          '',
          `Remote response: ${JSON.stringify(result)}`,
        ].join('\n'),
      }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{
        type: 'text',
        text: `Brain push failed: ${message}\n\nRemote: ${remoteUrl}\nRows queued: ${totalRows}\n\nSync state was NOT updated. Retry with the same command.`,
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
      tables: Record<string, Record<string, unknown>[]>;
    };

    if (!data.tables) {
      return {
        content: [{
          type: 'text',
          text: 'Pull response contained no tables. Nothing to merge.',
        }],
      };
    }

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
        const rows = data.tables[config.table];
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
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{
        type: 'text',
        text: `Brain pull failed: ${message}\n\nRemote: ${remoteUrl}\n\nSync state was NOT updated. Retry with the same command.`,
      }],
      isError: true,
    } as { content: { type: string; text: string }[]; isError: boolean };
  }
}

export { handleBrainPush, handleBrainPull };
export type { SyncTableConfig };
