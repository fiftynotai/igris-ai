/**
 * Brain Engine v7.0 — Sync Component
 *
 * Wraps the existing sync tool handlers as a BrainComponent.
 * Provides: igris_brain_push, igris_brain_pull, igris_sync_queue_status,
 *           igris_sync_queue_drain, igris_brief_file_sync,
 *           igris_session_file_sync, igris_session_file_pull,
 *           igris_definition_sync, igris_definition_pull,
 *           igris_file_push, igris_file_pull
 *
 * Event-driven auto-push: When auto_push is enabled in ~/.igris/config.json,
 * domain events trigger automatic replication to the remote brain.
 * - Immediate events (brief/session/instance changes): push specific rows instantly
 * - Batched events (memory/errors/projects/metrics): buffer for 10s then flush
 *
 * @module engine/components/sync
 * @author fifty.dev
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  BrainComponent,
  ComponentContext,
  Migration,
  ToolDefinition,
  EventDef,
  EventPayload,
} from '../../types.js';
import {
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
  fetchWithRetry,
  queueFailedRows,
  chunkTablesForPush,
  SYNC_TABLES,
} from '../../../tools/sync.js';
import type {
  BrainPushInput,
  BrainPullInput,
  SyncQueueDrainInput,
  BriefFileSyncInput,
  SessionFileSyncInput,
  SessionFilePullInput,
  DefinitionSyncInput,
  DefinitionPullInput,
  FilePushInput,
  FilePullInput,
  SyncTableConfig,
} from '../../../tools/sync.js';
import { getDb } from '../../../db.js';
import { errMsg } from '../../helpers.js';

// ---------------------------------------------------------------------------
// Auto-push config
// ---------------------------------------------------------------------------

interface AutoPushConfig {
  enabled: boolean;
  remoteUrl: string;
  apiKey: string;
}

/**
 * Load auto-push configuration from ~/.igris/config.json.
 *
 * Returns a valid config when auto_push is true AND remote_brain.url
 * AND remote_brain.api_key are present. Returns null otherwise.
 */
function loadAutoPushConfig(): AutoPushConfig | null {
  try {
    const configPath = join(homedir(), '.igris', 'config.json');
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;

    if (config.auto_push !== true) return null;

    const remote = config.remote_brain as Record<string, unknown> | undefined;
    if (!remote || typeof remote !== 'object') return null;

    const url = remote.url;
    const apiKey = remote.api_key;
    if (typeof url !== 'string' || !url) return null;
    if (typeof apiKey !== 'string' || !apiKey) return null;

    return {
      enabled: true,
      remoteUrl: url.replace(/\/+$/, ''),
      apiKey,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event-to-table mapping
// ---------------------------------------------------------------------------

/** Batched events accumulate tables and flush after a 10s window */
const BATCH_EVENT_TABLE_MAP: Record<string, string[]> = {
  'memory.stored': ['learnings'],
  'error.stored': ['errors'],
  'project.registered': ['projects'],
  'metrics.recorded': ['agent_metrics'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Look up a SyncTableConfig by table name */
function findSyncTable(tableName: string): SyncTableConfig | undefined {
  return SYNC_TABLES.find((t) => t.table === tableName);
}

/**
 * Query rows from specified tables and push them to the remote brain.
 *
 * On success, updates sync_state with the push timestamp.
 * On failure, queues rows for retry via sync_queue.
 * This function is fire-and-forget (async, never awaited by callers).
 */
async function pushTables(
  tables: Record<string, Record<string, unknown>[]>,
  config: AutoPushConfig,
  log: ComponentContext['log'],
): Promise<void> {
  const totalRows = Object.values(tables).reduce((sum, rows) => sum + rows.length, 0);
  if (totalRows === 0) return;

  const pushedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const chunks = chunkTablesForPush(tables);

  try {
    // BR-066 (auto-push retry): the server now returns HTTP 207 Multi-Status
    // when some tables errored at table-level. Both 200 and 207 are 2xx so
    // `response.ok` is true and `fetchWithRetry` resolves rather than throws.
    // We must inspect the body and treat per-table `errors` as a partial
    // failure: advance sync_state ONLY for the OK tables, and enqueue the
    // failed-table rows with the SPECIFIC table-level error message rather
    // than silently dropping them at the next push horizon.
    //
    // Aggregate failures across all chunks because a single auto-push call
    // can split into multiple HTTP requests, and we want sync_state to
    // advance for a table iff every chunk that touched it succeeded.
    const failedTables: Record<string, string> = {};

    for (const chunk of chunks) {
      const payload = {
        tables: chunk,
        pushed_at: pushedAt,
        schema_version: 9,
      };

      const response = await fetchWithRetry(`${config.remoteUrl}/sync/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      const body = await response.json() as {
        ok?: boolean;
        results?: Record<string, unknown>;
        errors?: Record<string, string>;
      };

      // Truly broken response: no `results` field at all. Existing catch
      // path handles it correctly (queue everything for retry).
      if (!body || typeof body !== 'object' || !('results' in body)) {
        throw new Error('malformed sync push response');
      }

      // HTTP 207 partial: collect per-table errors. The chunk may have
      // touched only a subset of `tables`; only the keys present here
      // are blocked from advancing sync_state.
      if (body.ok === false && body.errors && typeof body.errors === 'object') {
        for (const [tableName, errMessage] of Object.entries(body.errors)) {
          // First failure wins; subsequent chunks for the same table do
          // not overwrite — keeps the queue's error_message stable.
          if (!(tableName in failedTables)) {
            failedTables[tableName] = errMessage;
          }
        }
      }
    }

    const db = getDb();
    const upsertState = db.prepare(`
      INSERT INTO sync_state (remote_url, table_name, last_push_at)
      VALUES (?, ?, ?)
      ON CONFLICT(remote_url, table_name)
      DO UPDATE SET last_push_at = excluded.last_push_at
    `);

    // Advance sync_state ONLY for tables that didn't error in any chunk.
    db.transaction(() => {
      for (const tableName of Object.keys(tables)) {
        if (tableName in failedTables) continue;
        upsertState.run(config.remoteUrl, tableName, pushedAt);
      }
    })();

    // Queue the failed-table rows with their SPECIFIC error message so
    // the next drain has actionable diagnostics (not a generic "HTTP 500").
    if (Object.keys(failedTables).length > 0) {
      for (const [tableName, errMessage] of Object.entries(failedTables)) {
        const rows = tables[tableName];
        if (!rows || rows.length === 0) continue;
        try {
          queueFailedRows(
            db,
            { [tableName]: rows },
            `HTTP 207 — table=${tableName}: ${errMessage}`,
          );
          log.warn(
            `Auto-push partial failure on table=${tableName}: ${errMessage} ` +
            `(${rows.length} row(s) queued for retry)`,
          );
        } catch (queueErr) {
          log.error(
            `Failed to queue ${tableName} rows for retry: ${errMsg(queueErr)}`,
          );
        }
      }
    }
  } catch (err) {
    const message = errMsg(err);
    log.warn(`Auto-push failed: ${message}`);

    try {
      const db = getDb();
      queueFailedRows(db, tables, message);
    } catch (queueErr) {
      log.error(`Failed to queue rows for retry: ${errMsg(queueErr)}`);
    }
  }
}

/**
 * Query rows from specific tables based on column definitions in SYNC_TABLES.
 */
function queryTableRows(
  tableName: string,
  whereClause: string,
  params: unknown[],
): Record<string, unknown>[] {
  const tableConfig = findSyncTable(tableName);
  if (!tableConfig) return [];

  const db = getDb();
  const cols = tableConfig.columns.join(', ');
  return db.prepare(
    `SELECT ${cols} FROM ${tableName} ${whereClause}`
  ).all(...params) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Component factory
// ---------------------------------------------------------------------------

export function createSyncComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;
  let _autoPushConfig: AutoPushConfig | null = null;
  let _batchPending: Set<string> = new Set();
  let _batchTimer: ReturnType<typeof setTimeout> | null = null;

  // -------------------------------------------------------------------------
  // Immediate event handler
  // -------------------------------------------------------------------------

  function onImmediateEvent(payload: EventPayload): void {
    if (!_autoPushConfig || !_ctx) return;

    const config = _autoPushConfig;
    const log = _ctx.log;
    const { event, data } = payload;
    const tables: Record<string, Record<string, unknown>[]> = {};

    switch (event) {
      case 'brief.synced':
      case 'brief.created': {
        const project = data.project as string;
        const briefId = data.brief_id as string;
        const statusRows = queryTableRows('brief_status', 'WHERE project = ? AND brief_id = ?', [project, briefId]);
        if (statusRows.length > 0) tables['brief_status'] = statusRows;
        const fileRows = queryTableRows('brief_files', 'WHERE project = ? AND brief_id = ?', [project, briefId]);
        if (fileRows.length > 0) tables['brief_files'] = fileRows;
        break;
      }

      case 'brief.completed': {
        const project = data.project as string;
        const briefId = data.brief_id as string;
        const rows = queryTableRows('brief_status', 'WHERE project = ? AND brief_id = ?', [project, briefId]);
        if (rows.length > 0) tables['brief_status'] = rows;
        break;
      }

      case 'session.synced': {
        const project = data.project as string;
        const rows = queryTableRows(
          'sessions',
          'WHERE project = ? ORDER BY started_at DESC LIMIT 1',
          [project],
        );
        if (rows.length > 0) tables['sessions'] = rows;
        break;
      }

      case 'session.file.updated': {
        const project = data.project as string;
        const filename = data.filename as string;
        const rows = queryTableRows('session_files', 'WHERE project = ? AND filename = ?', [project, filename]);
        if (rows.length > 0) tables['session_files'] = rows;
        break;
      }

      case 'instance.state_updated': {
        const hostname = data.machine_hostname as string;
        const rows = queryTableRows(
          'instances',
          'WHERE machine_hostname = ? ORDER BY last_activity_at DESC LIMIT 1',
          [hostname],
        );
        if (rows.length > 0) tables['instances'] = rows;
        break;
      }
    }

    // Fire-and-forget push
    void pushTables(tables, config, log);
  }

  // -------------------------------------------------------------------------
  // Batched event handler
  // -------------------------------------------------------------------------

  function flushBatch(): void {
    _batchTimer = null;

    if (!_autoPushConfig || !_ctx || _batchPending.size === 0) {
      _batchPending.clear();
      return;
    }

    const config = _autoPushConfig;
    const log = _ctx.log;
    const pendingTables = [..._batchPending];
    _batchPending.clear();

    const tables: Record<string, Record<string, unknown>[]> = {};
    const db = getDb();

    for (const tableName of pendingTables) {
      const tableConfig = findSyncTable(tableName);
      if (!tableConfig) continue;

      // Query rows changed since last push for this table
      const stateRow = db.prepare(
        'SELECT last_push_at FROM sync_state WHERE remote_url = ? AND table_name = ?'
      ).get(config.remoteUrl, tableName) as { last_push_at: string } | undefined;

      const lastPushAt = stateRow?.last_push_at ?? '1970-01-01T00:00:00';
      const cols = tableConfig.columns.join(', ');
      const rows = db.prepare(
        `SELECT ${cols} FROM ${tableName} WHERE ${tableConfig.timestampCol} > ?`
      ).all(lastPushAt) as Record<string, unknown>[];

      if (rows.length > 0) {
        tables[tableName] = rows;
      }
    }

    // Fire-and-forget push
    void pushTables(tables, config, log);
  }

  function onBatchedEvent(payload: EventPayload): void {
    if (!_autoPushConfig) return;

    const tableNames = BATCH_EVENT_TABLE_MAP[payload.event];
    if (!tableNames) return;

    for (const t of tableNames) {
      _batchPending.add(t);
    }

    // Start timer on FIRST event; do NOT reset on subsequent events
    if (_batchTimer === null) {
      _batchTimer = setTimeout(flushBatch, 10_000);
      _batchTimer.unref();
    }
  }

  // -------------------------------------------------------------------------
  // Component definition
  // -------------------------------------------------------------------------

  return {
    name: 'sync',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      return [
        {
          version: 1,
          description: 'Create sync_queue table (idempotent with legacy v5)',
          sql: `
            CREATE TABLE IF NOT EXISTS sync_queue (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              table_name TEXT NOT NULL,
              row_data TEXT NOT NULL,
              operation TEXT DEFAULT 'push' CHECK (operation IN ('push', 'pull')),
              status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'sent', 'failed')),
              retry_count INTEGER DEFAULT 0,
              max_retries INTEGER DEFAULT 5,
              error_message TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              last_retry_at TEXT,
              sent_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);
          `,
        },
      ];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_brain_push',
          description: 'Push local brain changes to a remote brain server. Syncs learnings, errors, projects, sessions, brief_status, agent_metrics changed since last push. Uses last-write-wins for conflict resolution.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              remote_url: {
                type: 'string',
                description: 'URL of the remote brain server (e.g., "https://brain.example.com")',
              },
              api_key: {
                type: 'string',
                description: 'API key for authenticating with the remote brain server',
              },
            },
            required: ['remote_url', 'api_key'],
          },
          handler: (args) => handleBrainPush(args as unknown as BrainPushInput),
        },
        {
          name: 'igris_brain_pull',
          description: 'Pull remote brain changes to local brain. Syncs all tables changed since last pull. Uses last-write-wins for conflict resolution.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              remote_url: {
                type: 'string',
                description: 'URL of the remote brain server (e.g., "https://brain.example.com")',
              },
              api_key: {
                type: 'string',
                description: 'API key for authenticating with the remote brain server',
              },
            },
            required: ['remote_url', 'api_key'],
          },
          handler: (args) => handleBrainPull(args as unknown as BrainPullInput),
        },
        {
          name: 'igris_sync_queue_status',
          description: 'Show the current sync queue status. Displays pending, retrying, sent, and failed counts plus per-table breakdown of actionable items.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {},
          },
          handler: () => handleSyncQueueStatus(),
        },
        {
          name: 'igris_sync_queue_drain',
          description: 'Process pending sync queue items by pushing them to the remote brain. Retries failed push operations with exponential backoff tracking.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              remote_url: {
                type: 'string',
                description: 'URL of the remote brain server',
              },
              api_key: {
                type: 'string',
                description: 'API key for authenticating with the remote brain server',
              },
            },
            required: ['remote_url', 'api_key'],
          },
          handler: (args) => handleSyncQueueDrain(args as unknown as SyncQueueDrainInput),
        },
        {
          name: 'igris_brief_file_sync',
          description: 'Sync a brief file content to the brain. Computes content hash and upserts into brief_files table. Use this to store the full markdown content of brief files for cross-device access.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              brief_id: {
                type: 'string',
                description: 'Brief ID (e.g., "BR-008", "FR-026")',
              },
              filename: {
                type: 'string',
                description: 'Brief filename (e.g., "FR-026-feature-name.md")',
              },
              content: {
                type: 'string',
                description: 'Full markdown content of the brief file',
              },
            },
            required: ['project', 'brief_id', 'filename', 'content'],
          },
          handler: (args) => handleBriefFileSync(args as unknown as BriefFileSyncInput),
        },
        {
          name: 'igris_session_file_sync',
          description: 'Sync a session file content to the brain. Stores session files (CURRENT_SESSION.md, BLOCKERS.md, etc.) for cross-device access.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              filename: {
                type: 'string',
                description: 'Session filename (e.g., "CURRENT_SESSION.md")',
              },
              content: {
                type: 'string',
                description: 'Full content of the session file',
              },
            },
            required: ['project', 'filename', 'content'],
          },
          handler: (args) => handleSessionFileSync(args as unknown as SessionFileSyncInput),
        },
        {
          name: 'igris_session_file_pull',
          description: 'Pull all session files for a project from the brain. Returns all stored session files with their content.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug to pull session files for',
              },
            },
            required: ['project'],
          },
          handler: (args) => handleSessionFilePull(args as unknown as SessionFilePullInput),
        },
        {
          name: 'igris_definition_sync',
          description: 'Sync a definition file (agent, skill, rule, or prompt) to the brain. Stores the full content for cross-device and cross-project sharing.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              type: {
                type: 'string',
                enum: ['agent', 'skill', 'rule', 'prompt'],
                description: 'Definition type',
              },
              name: {
                type: 'string',
                description: 'Definition name (e.g., "forger", "hunt", "01-igris-init")',
              },
              filename: {
                type: 'string',
                description: 'Filename (e.g., "forger.md", "SKILL.md")',
              },
              content: {
                type: 'string',
                description: 'Full content of the definition file',
              },
              version: {
                type: 'string',
                description: 'Version string (optional)',
              },
            },
            required: ['type', 'name', 'filename', 'content'],
          },
          handler: (args) => handleDefinitionSync(args as unknown as DefinitionSyncInput),
        },
        {
          name: 'igris_definition_pull',
          description: 'Pull definitions from the brain. Optionally filter by timestamp to get only recently updated definitions.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              since: {
                type: 'string',
                description: 'ISO timestamp — only return definitions updated after this time (optional)',
              },
            },
          },
          handler: (args) => handleDefinitionPull(args as unknown as DefinitionPullInput),
        },
        {
          name: 'igris_file_push',
          description: 'Push a flat file (events.jsonl, agent-metrics.json, budget.json) to the remote brain server via HTTP. Updates sync_state for dashboard tracking.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              file_type: {
                type: 'string',
                enum: ['events', 'agent_metrics', 'budget'],
                description: 'File type: "events" for events.jsonl (cost tracking), "agent_metrics" for agent-metrics.json (agent stats), "budget" for budget.json (daily budget thresholds)',
              },
              content: {
                type: 'string',
                description: 'Full file content to push',
              },
              remote_url: {
                type: 'string',
                description: 'URL of the remote brain server (e.g., "https://brain.example.com")',
              },
              api_key: {
                type: 'string',
                description: 'API key for authenticating with the remote brain server',
              },
            },
            required: ['file_type', 'content', 'remote_url', 'api_key'],
          },
          handler: (args) => handleFilePush(args as unknown as FilePushInput),
        },
        {
          name: 'igris_file_pull',
          description: 'Pull a flat file from the remote brain server.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              file_type: {
                type: 'string',
                enum: ['events', 'agent_metrics', 'budget'],
                description: 'File type: "events" for events.jsonl, "agent_metrics" for agent-metrics.json, "budget" for budget.json',
              },
              remote_url: {
                type: 'string',
                description: 'URL of the remote brain server',
              },
              api_key: {
                type: 'string',
                description: 'API key for authenticating with the remote brain server',
              },
            },
            required: ['file_type', 'remote_url', 'api_key'],
          },
          handler: (args) => handleFilePull(args as unknown as FilePullInput),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [],
        listens: [
          // Immediate push events
          { name: 'brief.synced', description: 'Auto-push brief status and file on sync' },
          { name: 'brief.created', description: 'Auto-push brief status and file on creation' },
          { name: 'brief.completed', description: 'Auto-push brief status on completion' },
          { name: 'session.synced', description: 'Auto-push latest session on sync' },
          { name: 'session.file.updated', description: 'Auto-push session file on update' },
          { name: 'instance.state_updated', description: 'Auto-push instance data on state update' },
          // Batched push events (10s window)
          { name: 'memory.stored', description: 'Batch-push learnings table' },
          { name: 'error.stored', description: 'Batch-push errors table' },
          { name: 'project.registered', description: 'Batch-push projects table' },
          { name: 'metrics.recorded', description: 'Batch-push agent_metrics table' },
        ],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      _autoPushConfig = loadAutoPushConfig();

      // ALWAYS wire listeners (event-bus integrity tests require it).
      // Handlers early-return when _autoPushConfig is null.
      ctx.bus.on('brief.synced', onImmediateEvent);
      ctx.bus.on('brief.created', onImmediateEvent);
      ctx.bus.on('brief.completed', onImmediateEvent);
      ctx.bus.on('session.synced', onImmediateEvent);
      ctx.bus.on('session.file.updated', onImmediateEvent);
      ctx.bus.on('instance.state_updated', onImmediateEvent);
      ctx.bus.on('memory.stored', onBatchedEvent);
      ctx.bus.on('error.stored', onBatchedEvent);
      ctx.bus.on('project.registered', onBatchedEvent);
      ctx.bus.on('metrics.recorded', onBatchedEvent);

      const status = _autoPushConfig
        ? `enabled, remote: ${_autoPushConfig.remoteUrl}`
        : 'disabled';
      ctx.log.info(`Sync component initialized (auto-push ${status})`);
    },

    destroy(): void {
      if (_batchTimer !== null) {
        clearTimeout(_batchTimer);
        _batchTimer = null;
      }
      _batchPending.clear();

      if (_ctx) {
        _ctx.bus.off('brief.synced', onImmediateEvent);
        _ctx.bus.off('brief.created', onImmediateEvent);
        _ctx.bus.off('brief.completed', onImmediateEvent);
        _ctx.bus.off('session.synced', onImmediateEvent);
        _ctx.bus.off('session.file.updated', onImmediateEvent);
        _ctx.bus.off('instance.state_updated', onImmediateEvent);
        _ctx.bus.off('memory.stored', onBatchedEvent);
        _ctx.bus.off('error.stored', onBatchedEvent);
        _ctx.bus.off('project.registered', onBatchedEvent);
        _ctx.bus.off('metrics.recorded', onBatchedEvent);
      }

      _ctx = null;
      _autoPushConfig = null;
    },
  };
}
