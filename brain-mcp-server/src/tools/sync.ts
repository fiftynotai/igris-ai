/**
 * Igris Brain -- Sync Tools
 *
 * Provides bidirectional sync between local and remote brain instances.
 * Push sends local changes to a remote brain server.
 * Pull retrieves remote changes into the local brain.
 *
 * Conflict resolution uses last-write-wins (LWW) based on timestamps,
 * with special merge strategies for tags (union) and counts (max).
 * Append-only tables (sessions, agent_metrics, agent_events) use composite key
 * deduplication instead of LWW.
 *
 * Tools:
 * - igris_brain_push: Push local changes to remote brain
 * - igris_brain_pull: Pull remote changes to local brain
 * - igris_file_push: Push a flat file to the remote brain server
 * - igris_file_pull: Pull a flat file from the remote brain server
 *
 * @module tools/sync
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, sep } from 'node:path';
import { getDb } from '../db.js';
import { normalizeSyncRow } from './brief-normalize.js';
import { errMsg } from '../engine/helpers.js';
import { embedNullLearnings } from '../utils/learning-embed.js';
import { deleteEmbedding, isVectorSearchAvailable } from '../utils/vector-search.js';

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
  /**
   * TD-253: columns holding absolute LOCAL filesystem paths that must be
   * relativized before any row egresses to a remote brain. This ONE array is
   * the source for BOTH the disclosure-manifest annotation (egress-manifest.ts)
   * AND the runtime redaction (`redactTablesForEgress`). Every entry MUST also
   * appear in `columns` (asserted by the parity test).
   */
  redactCols?: string[];
  /**
   * BR-090: the syncKey this table used BEFORE {@link qualifierCols} were added
   * to it. Declaring it opts the table into the migration-aware reconciliation
   * in {@link mergeRows}; a table that has never widened its key omits both
   * fields and is completely unaffected.
   *
   * WHY THIS EXISTS. A syncKey is an identity claim, so widening one silently
   * redefines identity for every replica that has not migrated. The same
   * logical row, keyed narrowly on one side and widely on the other, does not
   * match — `mergeRows` takes the INSERT branch and the receiver ends up
   * holding BOTH copies. `strategy: 'append'` never removes the older one.
   *
   * MUST be a strict prefix-in-spirit of `syncKey`: every entry here also
   * appears in `syncKey`, and `syncKey` minus `qualifierCols` must equal this
   * array as a SET. Asserted by `sync-legacy-key-parity.test.ts`, not trusted
   * to this sentence.
   */
  legacySyncKey?: string[];
  /**
   * BR-090: the NULLABLE columns added to `syncKey` when it widened. The
   * reconciliation only ever adopts an attribution onto a stored row whose
   * qualifiers are ALL NULL, so it can never overwrite one attribution with a
   * different one. Every entry MUST appear in both `syncKey` and `columns`.
   */
  qualifierCols?: string[];
}

function tableColumns(db: Database.Database, name: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
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
      // FR-109 perception channel: review_status gates conscious-channel
      // visibility, provenance records origin/trust. Defense-in-depth: the
      // push SELECT also filters review_status='approved' so pending rows
      // stay LOCAL until a human approves them. Listed last to minimize diff
      // churn against the original column ordering.
      'review_status', 'provenance', 'source_extractor',
      // FR-200 M2: promoted_to_doc records the project-context doc a learning's
      // standard was promoted into (NULL = not promoted). It MUST replicate so
      // a recall on any synced machine surfaces the same "Promoted → <doc>"
      // pointer (one-fact-one-source). LWW on the row carries it; unlike the
      // perception-only seen_again_count counters (deliberately excluded), this
      // is conscious-channel state shared across machines.
      'promoted_to_doc',
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
      'slug', 'name', 'path', 'tech_stack', 'archetype', 'igris_version', 'status',
      'registered_at', 'last_session_at', 'metadata',
    ],
    // TD-253: `path` is the absolute local checkout dir — relativized to ~ (or
    // basename for a foreign-absolute path) before egress. See egress-manifest.ts.
    redactCols: ['path'],
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
    timestampCol: 'last_activity_at',
    strategy: 'lww',
    columns: [
      'id', 'machine_hostname', 'machine_os', 'project_slug', 'project_path',
      'current_brief', 'current_phase', 'current_task', 'status',
      'started_at', 'last_activity_at', 'metadata',
      'harness', 'harness_session_id', 'owner_pid', 'owner_started_at',
      'liveness_method', 'liveness_status', 'liveness_checked_at',
      'lease_expires_at', 'state_updated_at',
    ],
    // TD-253: `project_path` is the absolute local checkout dir for this
    // instance — relativized to ~ before egress. See egress-manifest.ts.
    redactCols: ['project_path'],
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
    columns: ['project', 'filename', 'content', 'content_hash', 'updated_at', 'instance_id', 'state'],
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
      // FR-267 hunt-cost record (instances migration v3); syncKey unchanged.
      // A remote without v3 fails these rows per-row (HTTP 207) and the local
      // watermark is held (BR-097) — deploy the remote first.
      'model_requested', 'model_resolved', 'round', 'project',
    ],
  },
  {
    table: 'ceremony_events',
    // FR-268 (2026-08-27). Hostname is in the key so two machines' same-second
    // rows never collide. A remote without instances v4 SKIPS the whole table
    // (named in `skipped[]`, HTTP 207) and the local watermark is held
    // (BR-097) — deploy first; the held rows travel on the next push.
    syncKey: ['machine_hostname', 'project', 'ceremony', 'event_type', 'created_at'],
    timestampCol: 'created_at',
    strategy: 'append',
    columns: [
      'project', 'ceremony', 'event_type', 'machine_hostname', 'instance_id', 'brief_id',
      'duration_ms', 'metadata', 'created_at',
    ],
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
  {
    table: 'catalog',
    syncKey: ['id'],
    timestampCol: 'updated_at',
    strategy: 'lww',
    columns: [
      'id', 'name', 'type', 'archetype', 'framework', 'github_repo',
      'github_path', 'github_branch', 'description', 'install_command',
      'standalone', 'parent_template', 'tags', 'rebrand_checklist',
      'source_project', 'status',
      // FR-198 asset-reference columns — MUST be listed here or they silently
      // don't replicate to/from VPS (R-4).
      'when_to_use', 'source', 'source_ref',
      'created_at', 'updated_at',
    ],
  },
  {
    // FR-105: typed-edges graph layer.
    // Append strategy + composite syncKey including edge_type matches the
    // local UNIQUE so remote INSERT OR IGNORE has the same idempotency
    // semantics. Soft-deletes are captured as metadata mutations, not row
    // deletions.
    //
    // BR-083 D7 — THE QUALIFIERS JOIN BOTH `columns` AND `syncKey`, AND THAT
    // MAKES THIS A DEPLOY-ORDERING HAZARD.
    //
    // `syncKey` exists to MIRROR the local uniqueness so the remote
    // `INSERT OR IGNORE` shares it. The local rule is now the expression index
    // over `(from_type, from_id, COALESCE(from_project,''), to_type, to_id,
    // COALESCE(to_project,''), edge_type)`. Leaving the two projects out of
    // the key would re-create the FUSION on the VPS: two edges that differ
    // only by project would collapse into one remote row, which is this
    // brief's defect reproduced on the other machine.
    //
    // DEPLOY ORDER IS NOT OPTIONAL: the VPS must run `edges@4` BEFORE the
    // first local push, or every INSERT fails on `no such column:
    // from_project`. Confirm `engine_migrations` shows `edges@4` on
    // brain.fifty.dev first. A receiver that predates the migration cannot be
    // degraded around from this side — the column list IS the payload.
    table: 'entity_edges',
    syncKey: [
      'from_type', 'from_id', 'from_project',
      'to_type', 'to_id', 'to_project',
      'edge_type',
    ],
    // BR-090 — THE KEY ABOVE WIDENED, AND THAT IS A BREAKING CHANGE FOR EVERY
    // REPLICA THAT HAS NOT MIGRATED. These two fields are what let a qualified
    // row recognise its own unqualified self on the other side. Both directions
    // are affected and PULL is the worse one: it corrupts the origin. See the
    // reconciliation block in `mergeRows` for the full argument.
    //
    // At most ONE all-NULL row can exist per 5-tuple — the `edges@4` expression
    // UNIQUE INDEX over `COALESCE(from_project,'')` / `COALESCE(to_project,'')`
    // guarantees it — so the adopt below is never ambiguous.
    legacySyncKey: ['from_type', 'from_id', 'to_type', 'to_id', 'edge_type'],
    qualifierCols: ['from_project', 'to_project'],
    timestampCol: 'created_at',
    strategy: 'append',
    columns: [
      'from_type', 'from_id', 'to_type', 'to_id', 'edge_type',
      'confidence', 'provenance', 'created_at', 'metadata',
      'from_project', 'to_project',
    ],
  },
  {
    // TD-171 M2: graph_nodes — free-standing concept/decision nodes.
    // Append strategy + composite syncKey on (node_type, node_external_id)
    // matches the local UNIQUE constraint so remote INSERT OR IGNORE shares
    // idempotency semantics with handleGraphNodeCreate. Properties bag is
    // free-form JSON; LWW would risk stomping merged property changes —
    // append + UNIQUE handles the dominant create-once pattern correctly.
    table: 'graph_nodes',
    syncKey: ['node_type', 'node_external_id'],
    timestampCol: 'created_at',
    strategy: 'append',
    columns: [
      'node_type', 'node_external_id', 'label', 'properties', 'created_at',
    ],
  },
  {
    // FR-110: goals (outcome-level entities).
    // LWW on goal_id (UNIQUE) using updated_at — matches the briefs/projects
    // pattern. The auto-increment `id` column is intentionally omitted from
    // the synced columns; goal_id is the portable identity. achieved_at is
    // a derived timestamp (server-set on status->achieved) so it ships with
    // the row to preserve the transition timestamp across machines.
    table: 'goals',
    syncKey: ['goal_id'],
    timestampCol: 'updated_at',
    strategy: 'lww',
    columns: [
      'goal_id', 'project_slug', 'title', 'description', 'outcome',
      'deadline', 'status', 'priority', 'created_at', 'updated_at',
      'achieved_at', 'metadata',
    ],
  },
  {
    // FR-106 Phase 1: subconscious engine output.
    // LWW on auto-incrementing id is meaningless across machines, so we
    // sync on the natural identity (source_module, project_slug, title)
    // — which is the same key the runner uses to dedupe within a run.
    // updated_at proxy: created_at | dismissed_at | acted_at — pick
    // dismissed_at where present, else acted_at, else created_at via
    // COALESCE in a generated column would be ideal, but to stay
    // schema-light we sync on created_at and let LWW resolve based on
    // status changes via a separate sync pass when statuses flip.
    // Acceptable trade-off: a dismiss on machine A and an act on
    // machine B will resolve last-write-wins on created_at — but the
    // suggestion table is regenerated every 6h anyway, so divergence
    // self-corrects within a cycle.
    table: 'suggestions',
    syncKey: ['source_module', 'project_slug', 'title'],
    timestampCol: 'created_at',
    strategy: 'lww',
    // FR-118 M2: confidence/suggested_action/type_inferred ADDED. The LLM
    // extractor writes them; without them here they would replicate as silent
    // NULLs on the remote brain (the loader/schema/writer-must-agree trap —
    // memory #133/#213). New cols are nullable, so older rows replicate clean.
    columns: [
      'source_module', 'project_slug', 'title', 'evidence', 'priority',
      'status', 'created_at', 'expires_at', 'dismissed_at',
      'dismissed_reason', 'acted_at', 'acted_brief_id',
      'confidence', 'suggested_action', 'type_inferred',
    ],
  },
  {
    // FR-106 Phase 1: dismiss-reason learning loop.
    // LWW on (source_module, project_slug, evidence_signature) so a
    // dismiss recorded on one machine raises dismiss_count on the merged
    // brain. The mergeFields entry promotes dismiss_count via max() so
    // independent dismisses on two machines accumulate correctly rather
    // than overwriting.
    table: 'dismissed_patterns',
    syncKey: ['source_module', 'project_slug', 'evidence_signature'],
    timestampCol: 'last_dismissed_at',
    strategy: 'lww',
    mergeFields: { dismiss_count: 'max' },
    columns: [
      'source_module', 'project_slug', 'evidence_signature',
      'dismiss_count', 'last_dismissed_at', 'reasons',
    ],
  },
];

// ---------------------------------------------------------------------------
// Egress path redaction (TD-253)
// ---------------------------------------------------------------------------

/**
 * Relativize an absolute LOCAL filesystem path so a remote brain never sees the
 * source machine's directory layout. Idempotent (re-applying is a no-op):
 *   - the home directory itself → `~`
 *   - a path under home         → `~` + the suffix (e.g. `~/code/app`)
 *   - any other absolute path   → its basename (strip the foreign prefix)
 *   - an already-relative value → unchanged
 * Non-string / empty values pass through untouched.
 *
 * Runs on the SOURCE machine (push side) where `homedir()` is the correct
 * relativization base — the receiver/VPS is never given the real path.
 */
export function relativizeEgressPath(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return value;
  const home = homedir();
  if (value === home) return '~';
  if (value.startsWith(home + sep)) return '~' + value.slice(home.length);
  if (isAbsolute(value)) return basename(value);
  return value;
}

/**
 * Redact the `redactCols` of every table IN PLACE, running each value through
 * {@link relativizeEgressPath}. Returns the same object for call-site chaining.
 *
 * MUST be applied at each egress choke point BEFORE chunking AND before any
 * `queueFailedRows` — mutating in place means the `tables` object reused by the
 * failure-path re-queue is already redacted, so retries never leak (the
 * load-bearing ordering decision, TD-253). Idempotent, so a second application
 * (e.g. defense-in-depth in the queue-drain path) is a harmless no-op.
 */
export function redactTablesForEgress(
  tables: Record<string, Record<string, unknown>[]>,
): Record<string, Record<string, unknown>[]> {
  for (const [tableName, rows] of Object.entries(tables)) {
    const cfg = SYNC_TABLES.find((t) => t.table === tableName);
    if (!cfg?.redactCols || cfg.redactCols.length === 0) continue;
    for (const row of rows) {
      for (const col of cfg.redactCols) {
        if (col in row) row[col] = relativizeEgressPath(row[col]);
      }
    }
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Build a human-readable key string for a row using its SyncTableConfig
 * syncKey columns. Used by the bisect-on-failure path to surface a
 * specific row diagnostic in error_message instead of a generic "HTTP
 * 500". Returns "unknown" when the table has no SYNC_TABLES entry, and
 * stringifies non-scalar key values as JSON.
 */
function describeRowKey(row: Record<string, unknown>, tableName: string): string {
  const config = SYNC_TABLES.find((c) => c.table === tableName);
  if (!config) return 'unknown';
  return config.syncKey.map((k) => {
    const v = row[k];
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch { return '<unserializable>'; }
  }).join('|');
}

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
 * Conservative cap for the sync_queue drain path (BR-066).
 *
 * Was implicitly 5 MB via `chunkTablesForPush`, which under bulk drain
 * conditions packs ~hundreds of rows per chunk. When one row blew up
 * server-side, the whole chunk's worth of rows hit retry as a unit and
 * — worse — the error message was a generic "HTTP 500" with no clue
 * which row was bad. Lowering the drain cap to 256 KB bounds blast
 * radius (~50-200 rows depending on table) and pairs with bisect-on-
 * failure so the caller can isolate a single offending row in log2(N)
 * push attempts. Internal-only; not user-facing config.
 */
const CHUNK_SIZE_LIMIT_DRAIN = 256 * 1024;

/**
 * Split a tables payload into multiple chunks, each under the given cap.
 * Iterates rows across tables, accumulating into chunks. A single oversized
 * row is allowed in its own chunk (never split a row).
 *
 * @param tables - Map of table name -> rows
 * @param sizeLimit - Optional byte cap per chunk; defaults to CHUNK_SIZE_LIMIT
 */
export function chunkTablesForPushSafe(
  tables: Record<string, Record<string, unknown>[]>,
  sizeLimit: number = CHUNK_SIZE_LIMIT,
): Record<string, Record<string, unknown>[]>[] {
  const chunks: Record<string, Record<string, unknown>[]>[] = [];
  let currentChunk: Record<string, Record<string, unknown>[]> = {};
  let currentSize = 0;

  for (const [tableName, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const rowSize = Buffer.byteLength(JSON.stringify(row), 'utf8');

      if (currentSize + rowSize > sizeLimit && currentSize > 0) {
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

/**
 * Backwards-compatible wrapper using the default CHUNK_SIZE_LIMIT (5 MB).
 * Used by handleBrainPush and the auto-push hot path where rows are
 * incremental (low row counts, low risk of bad-row poisoning).
 */
export function chunkTablesForPush(
  tables: Record<string, Record<string, unknown>[]>
): Record<string, Record<string, unknown>[]>[] {
  return chunkTablesForPushSafe(tables, CHUNK_SIZE_LIMIT);
}

// ---------------------------------------------------------------------------
// mergeRows — core merge logic (used by both pull handler and push endpoint)
// ---------------------------------------------------------------------------

/**
 * Per-row failure record produced by mergeRows. The `key` field is the
 * `|`-joined syncKey values for the offending row, useful for surfacing
 * which row blew up without dumping the whole payload.
 */
export interface MergeRowFailure {
  key: string;
  error: string;
}

/**
 * TD-338 — one field folded on ingress, on a row that was actually STORED.
 * `key` is the `|`-joined syncKey, matching {@link MergeRowFailure.key}.
 */
export interface MergeRowNormalization {
  key: string;
  field: string;
  from: string;
  to: string | null;
}

/**
 * TD-338 — one non-canonical value STORED VERBATIM on ingress (never folded).
 * This is the "arrived via sync" observer the TD-328 write-boundary echo
 * structurally cannot see: an inbound row is an LWW column copy, not a tool
 * call, so no response exists to append a NOTE to.
 */
export interface MergeRowNonCanonical {
  key: string;
  field: string;
  value: string;
}

/**
 * BR-090 — one row whose identity was reconciled across a widened syncKey.
 *
 * `action` names WHICH side won, because the two are not symmetric and a fix
 * that got the direction wrong would look identical in a count:
 *   - `adopted`  — the stored row had NULL qualifiers and took the incoming
 *                  attribution. This is the PUSH shape (qualified row arrives
 *                  at an unmigrated receiver).
 *   - `retained` — the stored row was already qualified and the incoming row
 *                  was NULL, so the local attribution was KEPT and the incoming
 *                  NULL discarded. This is the PULL shape, and getting it
 *                  backwards would null out every attribution on the origin.
 */
export interface MergeRowReconciliation {
  key: string;
  action: 'adopted' | 'retained';
  /** The qualifier columns and the values now stored, after reconciliation. */
  qualifiers: Record<string, string | null>;
}

/** Result of a mergeRows call including row-level failure breakdown. */
export interface MergeRowsResult {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  /**
   * BR-090: rows matched across a widened syncKey instead of being duplicated.
   * Always present; 0 for every table that never widened a key.
   */
  reconciled: number;
  /** Per-row reconciliation detail. Present (and non-empty) only when > 0. */
  reconciliations?: MergeRowReconciliation[];
  /** Present (and non-empty) only when failed > 0. */
  failures?: MergeRowFailure[];
  /**
   * TD-338: count of ROWS (not fields) whose stored value differed from the
   * inbound value because a write-boundary normalizer folded it. Always
   * present; 0 on a clean merge.
   */
  normalized: number;
  /** Per-field fold detail. Present (and non-empty) only when normalized > 0. */
  normalizations?: MergeRowNormalization[];
  /** Non-canonical values stored verbatim. Present only when non-empty. */
  nonCanonical?: MergeRowNonCanonical[];
}

/**
 * Render a row's syncKey values as the `|`-joined diagnostic key used by
 * {@link MergeRowFailure}, {@link MergeRowNormalization} and
 * {@link MergeRowNonCanonical}. Defensive: some entries may be objects.
 */
function formatSyncKey(keyValues: unknown[]): string {
  return keyValues
    .map((v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        return String(v);
      }
      try { return JSON.stringify(v); } catch { return '<unserializable>'; }
    })
    .join('|');
}

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
 * BR-066: each row is wrapped in its own try/catch. A row that throws (e.g.
 * an unbindable column value, NOT NULL violation, CHECK constraint failure)
 * increments `failed` and appends to `failures` instead of aborting the
 * whole call. The caller is expected to wrap mergeRows in a transaction;
 * row-level catches mean a single bad row no longer poisons sibling rows
 * in the same call.
 *
 * TD-338 — THIS IS A NORMALIZATION BOUNDARY. Every inbound row for a table in
 * `SYNC_NORMALIZED_FIELDS` passes through the SAME normalizers the MCP write
 * boundary applies (`normalizeSyncRow`), so replication can no longer write a
 * spelling `igris_brief_create` would have folded. Three properties make this
 * safe rather than a new source of divergence:
 *
 *   1. **Only declared synonyms fold.** `P1 ≡ P1-High` is a fold-table fact,
 *      not a guess. Unknown values (`P4-Trivial`, `Spike`) are stored VERBATIM
 *      and reported in `nonCanonical`.
 *   2. **`updated_at` is not in the map, so the fold cannot bump it.** No merge
 *      path in this codebase writes a timestamp it did not receive, so a folded
 *      row produces no delta with a newer timestamp: the remote's
 *      `WHERE updated_at > since` stops selecting it, and our next push carries
 *      EQUAL timestamps so the remote's own `remoteTs > localTs` is false and it
 *      skips. The system reaches its fixed point on the FIRST arrival of each
 *      row version. Pinned by `sync-ingress-normalize.test.ts` (T3), not
 *      trusted to this paragraph.
 *   3. **The fold is recorded only for rows actually WRITTEN.** A row that loses
 *      LWW is skipped before any fold is counted, so normalization can never
 *      resurrect a stale row nor inflate the report.
 *
 * THE REJECTED LEVER, RECORDED: folding AND bumping `updated_at` WOULD heal an
 * un-migrated remote on our next push (and still would not oscillate — older
 * remote code never re-writes a row spontaneously). It is rejected because it
 * manufactures a write no operator made and mutates a column the dashboard,
 * `briefStatusSummary` and velocity ordering all read. See the v22 comment in
 * `db.ts` for the same discipline. Pull this lever only on an explicit operator
 * decision to make sync heal remotes.
 *
 * @param db - The database instance to merge into
 * @param config - The sync table configuration
 * @param rows - The incoming rows to merge
 * @returns Counts of inserted/updated/skipped/failed plus per-row failures and
 *          the TD-338 normalization report
 */
export function mergeRows(
  db: Database.Database,
  config: SyncTableConfig,
  rows: Record<string, unknown>[]
): MergeRowsResult {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let normalized = 0;
  let reconciled = 0;
  const failures: MergeRowFailure[] = [];
  const normalizations: MergeRowNormalization[] = [];
  const nonCanonical: MergeRowNonCanonical[] = [];
  const reconciliations: MergeRowReconciliation[] = [];

  // BR-090 — prepared ONCE, and only for a table that declares it widened.
  // `legacyLookupStmt` stays null for all 19 other tables, so the reconciliation
  // block below is unreachable for them: this cannot change the behaviour of a
  // table that never widened a key.
  const qualifierCols = config.qualifierCols ?? [];
  // NOTE the absence of a qualifier predicate here: this deliberately returns
  // EVERY row sharing the legacy key, qualified or not, because the two
  // directions need different subsets of it (adopt wants the all-NULL row;
  // retain wants to know whether ANY qualified row exists). Constraining it to
  // `IS NULL` here would silently make the pull direction fall through to
  // INSERT — which is the bug.
  const legacyLookupStmt =
    config.legacySyncKey && qualifierCols.length > 0
      ? db.prepare(
          `SELECT * FROM ${config.table} WHERE ${
            config.legacySyncKey.map(k => `${k} IS ?`).join(' AND ')
          }`,
        )
      : null;

  // BR-083 — `IS`, NOT `=`. `entity_edges.from_project` / `to_project` are the
  // first NULLABLE syncKey columns in the table set, and `col = NULL` is NULL,
  // never true: the lookup would MISS every deliberately-unattributed row, the
  // merge would take the insert branch, and each pull would append a duplicate
  // of the ~half of the graph this brief leaves NULL. `IS` is equivalent to `=`
  // for non-NULL operands, so every other table's behaviour is unchanged, and
  // SQLite plans it against the same indexes.
  const lookupSql = `SELECT * FROM ${config.table} WHERE ${
    config.syncKey.map(k => `${k} IS ?`).join(' AND ')
  }`;
  const lookupStmt = db.prepare(lookupSql);

  for (const row of rows) {
    const keyValues = config.syncKey.map(k => row[k]);
    // TD-338: fold BEFORE the row can reach either writer. `normalizeSyncRow`
    // returns the SAME object for an unmapped table or an already-canonical
    // row, so this is one map lookup on the hot path. syncKey columns are never
    // in the map, so the lookup key above is unaffected by the fold.
    const { row: normRow, folds, nonCanonical: rowNonCanonical } =
      normalizeSyncRow(config.table, row);
    // Recorded ONLY from a branch that actually wrote the row — a row that
    // loses LWW must not appear in the report (T5).
    const recordNormalization = (): void => {
      if (folds.length === 0 && rowNonCanonical.length === 0) return;
      const key = formatSyncKey(keyValues);
      if (folds.length > 0) {
        normalized++;
        for (const f of folds) normalizations.push({ key, ...f });
      }
      for (const nc of rowNonCanonical) nonCanonical.push({ key, ...nc });
    };
    try {
      const existing = lookupStmt.get(...keyValues) as Record<string, unknown> | undefined;

      // BR-090 — RECONCILE ACROSS A WIDENED syncKey BEFORE INSERTING.
      //
      // A miss on the full key does NOT mean "new row". Once a syncKey gains a
      // column, the same logical row keyed narrowly on one side and widely on
      // the other misses — and inserting is how the duplicate is born. Ask the
      // narrower question before concluding the row is new.
      //
      // THE TWO DIRECTIONS ARE NOT MIRROR IMAGES, and this is the whole
      // subtlety of the fix:
      //
      //   PUSH  incoming QUALIFIED -> stored NULL  : ADOPT the attribution.
      //   PULL  incoming NULL      -> stored QUALIFIED : RETAIN the local one.
      //
      // A "symmetric" implementation that just copied the incoming qualifiers
      // over would, on the pull, null out every attribution on the ORIGIN —
      // 458 of them here — which is strictly worse than the duplication it was
      // written to prevent. The direction is asserted, not assumed.
      //
      // The conflict case is deliberately NOT reconciled: two rows sharing the
      // legacy key with DIFFERENT non-NULL attributions are genuinely different
      // edges (`BR-082` in one project vs another — exactly the ambiguity
      // BR-083 existed to fix), so they fall through and insert.
      let reconciledThisRow = false;
      if (!existing && legacyLookupStmt && config.legacySyncKey) {
        const legacyValues = config.legacySyncKey.map(k => row[k]);
        const candidates = legacyLookupStmt.all(...legacyValues) as Record<string, unknown>[];
        const incomingIsQualified = qualifierCols.some(c => normRow[c] != null);

        if (incomingIsQualified) {
          // At most one all-NULL row can exist per legacy key (the `edges@4`
          // expression UNIQUE INDEX over COALESCE(...,'') enforces it), so this
          // find is unambiguous by construction rather than by luck.
          const unattributed = candidates.find(c => qualifierCols.every(q => c[q] == null));
          if (unattributed) {
            const setSql = qualifierCols.map(c => `${c} = ?`).join(', ');
            const whereSql =
              config.legacySyncKey.map(k => `${k} IS ?`).join(' AND ') +
              ' AND ' + qualifierCols.map(c => `${c} IS NULL`).join(' AND ');
            db.prepare(`UPDATE ${config.table} SET ${setSql} WHERE ${whereSql}`).run(
              ...qualifierCols.map(c => (normRow[c] ?? null) as string | null),
              ...legacyValues,
            );
            reconciled++;
            reconciliations.push({
              key: formatSyncKey(keyValues),
              action: 'adopted',
              qualifiers: Object.fromEntries(
                qualifierCols.map(c => [c, (normRow[c] ?? null) as string | null]),
              ),
            });
            recordNormalization();
            reconciledThisRow = true;
          }
        } else if (candidates.length > 0) {
          // Incoming carries no attribution and a stored row shares the legacy
          // key. That stored row MUST be qualified — an unqualified one would
          // have matched the full key above — so this is the pull shape. Keep
          // what we have and drop the incoming NULL on the floor.
          reconciled++;
          reconciliations.push({
            key: formatSyncKey(keyValues),
            action: 'retained',
            qualifiers: Object.fromEntries(
              qualifierCols.map(c => [c, (candidates[0][c] ?? null) as string | null]),
            ),
          });
          reconciledThisRow = true;
        }
      }

      if (reconciledThisRow) {
        // Handled above. Deliberately NOT counted as inserted/updated/skipped:
        // a reconciliation is its own outcome and is reported as one.
      } else if (!existing) {
        const cols = config.columns.filter(c => normRow[c] !== undefined);
        const placeholders = cols.map(() => '?').join(', ');
        db.prepare(
          `INSERT INTO ${config.table} (${cols.join(', ')}) VALUES (${placeholders})`
        ).run(...cols.map(c => normRow[c] ?? null));
        inserted++;
        recordNormalization();
      } else if (config.strategy === 'append') {
        skipped++;
      } else {
        // LWW strategy: compare timestamps
        const localTs = (existing[config.timestampCol] as string) ?? '';
        // TD-338: `timestampCol` is deliberately absent from
        // SYNC_NORMALIZED_FIELDS, so normRow[timestampCol] === row[timestampCol]
        // by construction — the fold can neither advance nor retard LWW.
        const remoteTs = (normRow[config.timestampCol] as string) ?? '';

        if (remoteTs > localTs) {
          const setClauses: string[] = [];
          const setValues: unknown[] = [];

          for (const col of config.columns) {
            if (config.syncKey.includes(col)) continue;

            if (config.mergeFields?.[col] === 'merge_tags') {
              setClauses.push(`${col} = ?`);
              setValues.push(mergeTags(
                (existing[col] as string) || '',
                (normRow[col] as string) || ''
              ));
            } else if (config.mergeFields?.[col] === 'max') {
              setClauses.push(`${col} = ?`);
              setValues.push(Math.max(
                (existing[col] as number) || 0,
                (normRow[col] as number) || 0
              ));
            } else {
              setClauses.push(`${col} = ?`);
              setValues.push(normRow[col] ?? null);
            }
          }

          // FR-220: stale-embedding invalidation. An LWW update that changes a
          // learnings row's title/content makes the stored embedding (derived
          // from the OLD text) stale — and a stale NON-NULL embedding is
          // invisible to the post-merge `WHERE embedding IS NULL` scan. NULL
          // both embedding columns HERE and delete the vec row below, inside
          // the SAME per-table sync transaction the caller wraps mergeRows in,
          // so the BLOB-null and the vec-delete stay lockstep. The row then
          // falls into the post-merge NULL-scan (scheduleLearningEmbedAfterMerge)
          // and is re-embedded via the normalized fingerprint. Guarded to the
          // learnings table only.
          const learningTextChanged =
            config.table === 'learnings' &&
            (existing.title !== normRow.title || existing.content !== normRow.content);
          if (learningTextChanged) {
            setClauses.push('embedding = ?', 'embedding_model = ?');
            setValues.push(null, null);
          }

          if (setClauses.length > 0) {
            // `IS` for the same reason as the lookup above (BR-083): an UPDATE
            // keyed on a NULL qualifier with `=` would match zero rows and the
            // LWW winner would be silently dropped.
            const whereClause = config.syncKey.map(k => `${k} IS ?`).join(' AND ');
            db.prepare(
              `UPDATE ${config.table} SET ${setClauses.join(', ')} WHERE ${whereClause}`
            ).run(...setValues, ...keyValues);
            updated++;
            recordNormalization();

            // Lockstep vec-delete for the just-NULLed embedding. DEFENSIVE:
            // only when sqlite-vec is available. If the extension is missing the
            // columns are already NULLed above and the row degrades to FTS until
            // the next embed pass re-derives it (#213) — guarding here means a
            // missing extension can never throw out of the merge and abort the
            // sync transaction.
            // NOTE (FR-220): with the extension DOWN, the stale learnings_vec row
            // survives (vec-delete is skipped). It is inert while vec is down (no
            // vector query can run), and self-heals on the next embed pass, which
            // DELETE-then-INSERTs the vec row. The only window is a later
            // vec-available process that hasn't re-embedded yet — a transient
            // old-text ranking, never corruption. See TD-288 for a boot-time
            // NULL-scan that would close that window proactively.
            if (learningTextChanged && isVectorSearchAvailable(db)) {
              deleteEmbedding(db, existing.id as number);
            }
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
      }
    } catch (rowErr) {
      // Row-level failure: record key+error so the caller can surface a
      // specific diagnostic (e.g. "table=brief_files key=igris-ai|FR-111
      // error=Too few parameter values were provided") instead of a
      // generic "HTTP 500".
      failed++;
      const keyStr = formatSyncKey(keyValues);
      failures.push({ key: keyStr, error: errMsg(rowErr) });
      console.error(`[brain] mergeRows row failed: table=${config.table} key=${keyStr} error=${errMsg(rowErr)}`);
    }
  }

  const result: MergeRowsResult = { inserted, updated, skipped, failed, normalized, reconciled };
  if (failed > 0) result.failures = failures;
  if (normalizations.length > 0) result.normalizations = normalizations;
  if (nonCanonical.length > 0) result.nonCanonical = nonCanonical;
  if (reconciliations.length > 0) result.reconciliations = reconciliations;
  return result;
}

// ---------------------------------------------------------------------------
// processSyncPush — the body of POST /sync/push, extracted for testability
// ---------------------------------------------------------------------------

/** Result of processSyncPush — mirrors the JSON body of POST /sync/push. */
export interface SyncPushResult {
  /** Per-table merge counts. Tables in `errors` or `skipped` are absent here. */
  results: Record<string, MergeRowsResult>;
  /** Per-table fatal errors (table-level, not row-level). */
  errors: Record<string, string>;
  /**
   * Tables the payload named that this DB lacks (BR-097). ALWAYS present —
   * its absence tells a client the remote predates BR-097. Never in `errors`.
   */
  skipped: string[];
  /** True iff `errors` and `skipped` are both empty — drives 200 vs 207. */
  ok: boolean;
}

/**
 * Apply a sync push payload against the local DB with per-table isolation.
 *
 * BR-066: each table's mergeRows runs in its OWN db.transaction() inside
 * its OWN try/catch. A row-level crash inside mergeRows is now caught at
 * row level (see mergeRows itself); this outer per-table guard handles
 * table-level errors (e.g. prepare() failures, schema mismatches). A
 * missing table on the local schema is skipped with a stderr log and named
 * in `skipped` (BR-064 carry-over; BR-097 makes the skip visible).
 *
 * @param db - The database to merge into
 * @param tables - Wire-format payload from POST /sync/push
 * @returns SyncPushResult with per-table results, errors, and ok flag
 */
export function processSyncPush(
  db: Database.Database,
  tables: Record<string, Record<string, unknown>[]>,
): SyncPushResult {
  const localTableRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  const localTables = new Set(localTableRows.map((r) => r.name));

  const results: Record<string, MergeRowsResult> = {};
  const errors: Record<string, string> = {};
  const skipped: string[] = [];

  for (const config of SYNC_TABLES) {
    const rows = tables[config.table];
    if (!rows || rows.length === 0) continue;
    if (!localTables.has(config.table)) {
      console.error(`[brain] /sync/push skip: table '${config.table}' not present locally`);
      skipped.push(config.table);
      continue;
    }
    try {
      const merged = db.transaction(() => mergeRows(db, config, rows))();
      results[config.table] = merged;
    } catch (err) {
      const message = errMsg(err);
      errors[config.table] = message;
      console.error(`[brain] /sync/push table=${config.table} failed:`, message);
    }
  }

  return {
    results,
    errors,
    skipped,
    ok: Object.keys(errors).length === 0 && skipped.length === 0,
  };
}

// ---------------------------------------------------------------------------
// FR-220 — post-merge learning-embedding pass (fire-and-forget, coalescing)
// ---------------------------------------------------------------------------

/**
 * Progress-log batch granularity for the post-merge NULL-embedding scan.
 * Forwarded to `embedNullLearnings` — it does NOT cap the rows processed
 * (the pass drains the whole NULL backlog); it only controls log cadence.
 */
const EMBED_BATCH = 50;

/**
 * Coalescing guard for the post-merge embed pass. At most one pass runs at a
 * time; a schedule call that arrives while a pass is in flight sets
 * `embedRerun` so exactly ONE follow-up pass runs after the current one drains
 * (collapsing N overlapping syncs into one redundant-CPU-free follow-up).
 *
 * Race-free by construction: the event loop is single-threaded and there is no
 * `await` between the `!embedRerun` break check and clearing `embedInFlight`,
 * so no schedule call can slip through that gap unobserved. Correctness does
 * not depend on the guard — `embedNullLearnings` is idempotent (`WHERE
 * embedding IS NULL` + per-row txn) — the guard only prevents wasted model runs.
 */
let embedInFlight = false;
let embedRerun = false;

/**
 * Schedule a fire-and-forget post-merge embed pass IFF the just-committed merge
 * inserted or updated a learnings row. A clean merge (learnings absent, or
 * `inserted + updated === 0`) is a no-op — no pass is scheduled.
 *
 * NEVER blocks the caller: the pass runs on a LATER tick via `setImmediate`,
 * after the sync response has already been queued/flushed (#224 — both halves
 * of the background feature stay background). It is `void`-invoked and never
 * awaited, so it cannot delay the response or the caller's return.
 *
 * @param db - The database the merge committed into.
 * @param results - Per-table `MergeRowsResult` map from the merge.
 */
export function scheduleLearningEmbedAfterMerge(
  db: Database.Database,
  results: Record<string, MergeRowsResult>,
): void {
  const l = results['learnings'];
  if (!l || l.inserted + l.updated === 0) return; // AC4 clean-merge no-op
  if (embedInFlight) {
    embedRerun = true; // coalesce overlapping syncs into one follow-up pass
    return;
  }
  embedInFlight = true;
  setImmediate(() => {
    void runPostMergeEmbedPass(db);
  });
}

/**
 * Drain the NULL-embedding backlog by delegating to the shipped
 * `embedNullLearnings` core, looping once more if an overlapping schedule call
 * set `embedRerun` while the pass ran.
 *
 * NEVER rejects out of the `setImmediate` callback (#224): the inner core call
 * is wrapped in its own try/catch (a failed pass leaves rows NULL for the next
 * merge to re-derive — degrade-not-crash, #213/AC2), and the outer try/finally
 * guarantees `embedInFlight` clears even on an unexpected throw. There is NO
 * success log at schedule time (#125 observability honesty) — the only
 * completion signal is the core's own post-pass progress/summary log.
 *
 * Exported for direct unit testing (drive it with a fake embedder + a tick).
 */
export async function runPostMergeEmbedPass(db: Database.Database): Promise<void> {
  try {
    for (;;) {
      embedRerun = false;
      try {
        await embedNullLearnings(db, { dryRun: false, batchSize: EMBED_BATCH });
      } catch (err) {
        // AC2: never break the sync path. #125: no success-implying line here.
        console.error(
          '[fr220] post-merge embed pass failed (rows left NULL for next pass):',
          errMsg(err),
        );
      }
      if (!embedRerun) break; // no await between here and the finally → race-free
    }
  } finally {
    embedInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// handleBrainPush
// ---------------------------------------------------------------------------

/**
 * Push local brain changes to a remote brain server.
 *
 * For each sync table, queries rows changed since the last push timestamp,
 * POSTs them to the remote server, and advances `sync_state` only for the
 * tables the remote acknowledged in `results` and not in `errors` (BR-097);
 * a held table is re-selected in full by the next push.
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

  // BR-064 Fix B (defense-in-depth): filter SYNC_TABLES to those that
  // physically exist on the local connection. A missing table on a
  // partially-migrated DB (e.g. a CLI invocation that bypassed bootEngine,
  // or a future component gated off via env flag) MUST NOT abort the push
  // of sibling tables. Logs once per skipped table for /scan visibility.
  //
  // We use a per-call filtered local copy and intentionally do NOT mutate
  // the exported SYNC_TABLES array — index.ts also iterates SYNC_TABLES for
  // the HTTP /sync/push endpoint and must keep the full set for schema
  // documentation/handshake purposes.
  const localTableRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  const localTables = new Set(localTableRows.map((r) => r.name));
  const activeSyncTables = SYNC_TABLES.filter((cfg) => {
    if (localTables.has(cfg.table)) return true;
    console.error(`[brain] sync skip: table '${cfg.table}' not present locally`);
    return false;
  });

  const tables: Record<string, Record<string, unknown>[]> = {};
  let totalRows = 0;

  for (const config of activeSyncTables) {
    const existingColumns = tableColumns(db, config.table);
    const selectedColumns = config.columns.filter((c) => existingColumns.has(c));
    if (!existingColumns.has(config.timestampCol)) continue;
    // Get last push timestamp for this table
    const stateRow = db.prepare(
      'SELECT last_push_at FROM sync_state WHERE remote_url = ? AND table_name = ?'
    ).get(remoteUrl, config.table) as { last_push_at: string } | undefined;

    const lastPushAt = stateRow?.last_push_at ?? '1970-01-01T00:00:00';

    // Query rows changed since last push.
    //
    // FR-109 perception channel: defense-in-depth filter. `learnings` rows
    // with `review_status='pending_review'` stay LOCAL — only approved rows
    // propagate to the VPS. Pairs with the column-list addition above:
    // even if the column list ever drifts, this filter keeps the privacy
    // posture intact (pending candidates are session-private until approved).
    // Other tables remain unfiltered.
    const cols = selectedColumns.join(', ');
    const extraFilter = config.table === 'learnings' ? " AND review_status = 'approved'" : '';
    const rows = db.prepare(
      `SELECT ${cols} FROM ${config.table} WHERE ${config.timestampCol} > ?${extraFilter}`
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

  // TD-253: relativize local FS paths IN PLACE before both chunking and the
  // failure-path `queueFailedRows` (line ~982). Mutating `tables` here means the
  // re-queued object is already redacted, so retries never leak absolute paths.
  redactTablesForEgress(tables);

  // Chunk and POST to remote
  const chunks = chunkTablesForPush(tables);

  // BR-097: stamp a table iff the remote named it in `results` (any chunk)
  // and never in `errors`. `skipped` is absent on a pre-BR-097 remote.
  const acked = new Set<string>();
  const failed = new Map<string, string>();
  const skippedByRemote = new Set<string>();

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

      // BR-066: the server now returns HTTP 207 with `ok:false` and a
      // populated `errors` map when at least one table failed. We accept
      // partial success (results present) but log the per-table errors
      // so they surface in /scan and operator logs. Treat truly broken
      // responses (missing `results` entirely) as fatal.
      if (!result.results) {
        console.error(`[brain] Remote sync response missing 'results' for chunk ${i + 1}/${chunks.length}:`, JSON.stringify(result));
        throw new Error(`Remote returned invalid response for chunk ${i + 1}/${chunks.length}`);
      }
      for (const t of Object.keys(result.results as Record<string, unknown>)) acked.add(t);
      const remoteErrors = (result.errors ?? {}) as Record<string, string>;
      for (const [tableName, errMessage] of Object.entries(remoteErrors)) {
        console.error(`[brain] Remote sync table=${tableName} error: ${errMessage}`);
        if (!failed.has(tableName)) failed.set(tableName, errMessage);
      }
      if (Array.isArray(result.skipped)) {
        for (const t of result.skipped) skippedByRemote.add(String(t));
      }
    }

    // Advance sync_state only for acknowledged tables, after ALL chunks succeed
    const upsertState = db.prepare(`
      INSERT INTO sync_state (remote_url, table_name, last_push_at)
      VALUES (?, ?, ?)
      ON CONFLICT(remote_url, table_name)
      DO UPDATE SET last_push_at = excluded.last_push_at
    `);

    const notMerged = new Set<string>();
    db.transaction(() => {
      for (const tableName of Object.keys(tables)) {
        if (!acked.has(tableName) || failed.has(tableName)) {
          notMerged.add(tableName);
          continue;
        }
        upsertState.run(remoteUrl, tableName, pushedAt);
      }
    })();

    // One line per held table (skipped / errored / unacknowledged), for /scan.
    const holdReason = (name: string): [string, string] => {
      if (failed.has(name)) {
        return [
          `ERROR — ${failed.get(name)} (rows retained locally)`,
          `${name}: remote error ${failed.get(name)}; rows retained locally`,
        ];
      }
      if (skippedByRemote.has(name)) {
        return [
          'SKIPPED — not on remote yet (deploy first; rows retained locally)',
          `${name} not on remote yet — deploy first; rows retained locally`,
        ];
      }
      return [
        'UNACKNOWLEDGED — remote returned no result (pre-BR-097 remote?); rows retained locally',
        `${name} sent but not acknowledged by the remote (pre-BR-097 remote?); rows retained locally`,
      ];
    };
    for (const name of notMerged) console.error(`[brain] sync: ${holdReason(name)[1]}`);

    // Format summary
    const tablesSummary = Object.entries(tables)
      .map(([name, rows]) =>
        notMerged.has(name)
          ? `  - ${name}: ${holdReason(name)[0]}`
          : `  - ${name}: ${rows.length} row(s)`)
      .join('\n');
    const headline = notMerged.size === 0
      ? 'Brain push completed successfully.'
      : `Brain push completed — ${notMerged.size} table(s) not merged by the remote (rows retained locally).`;

    return {
      content: [{
        type: 'text',
        text: [
          headline,
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
    // FR-220: per-table merge counts, kept alongside totalMerged so the
    // post-merge embed pass can fire on a learnings insert/update (pull site
    // symmetry with the /sync/push route).
    const results: Record<string, MergeRowsResult> = {};

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
        results[config.table] = result;
        // BR-090: an ADOPTED row changed the database and must be counted, or a
        // pull that repaired 458 attributions reports "Total merged: 0" while
        // 458 rows moved — the exact report-success-without-checking shape this
        // brief exists to kill. A RETAINED row is deliberately NOT counted:
        // nothing was written, the incoming NULL was discarded, and inflating
        // the total would be the mirror-image lie.
        const adopted = (result.reconciliations ?? []).filter(r => r.action === 'adopted').length;
        totalMerged += result.inserted + result.updated + adopted;
        const failedSuffix = result.failed > 0 ? `, ${result.failed} failed` : '';
        // TD-338: silent when zero — a clean pull gains no new noise.
        const normalizedSuffix = result.normalized > 0 ? `, ${result.normalized} normalized` : '';
        // BR-090: silent when zero, like the TD-338 fold above. A non-zero count
        // means rows were matched across a widened syncKey instead of being
        // duplicated — the operator should see that it happened AND which way.
        const reconciledSuffix = result.reconciled > 0 ? `, ${result.reconciled} reconciled` : '';
        summary.push(
          `  - ${config.table}: ${rows.length} received (${result.inserted} inserted, ${result.updated} updated, ${result.skipped} skipped${failedSuffix}${normalizedSuffix}${reconciledSuffix})`
        );
        for (const r of result.reconciliations ?? []) {
          summary.push(
            `      reconciled ${config.table} ${r.key}: ${r.action} ${JSON.stringify(r.qualifiers)}`
          );
        }
        // TD-338: name every fold and every non-canonical passthrough. The
        // brief's honesty contract — the fold is allowed to be lossy only in
        // the sense the fold table already licenses, and never silently.
        for (const n of result.normalizations ?? []) {
          summary.push(
            `      normalized ${config.table} ${n.key}: ${n.field} ${JSON.stringify(n.from)} -> ${JSON.stringify(n.to)}`
          );
        }
        for (const nc of result.nonCanonical ?? []) {
          summary.push(
            `      NON-CANONICAL (stored as-is) ${config.table} ${nc.key}: ${nc.field}=${JSON.stringify(nc.value)}`
          );
        }
        if (result.failures && result.failures.length > 0) {
          // BR-066: surface row-level failures during pull. We do not abort
          // the pull on row failures (last-write-wins is best-effort by
          // design) but operators need visibility into which rows the
          // local DB rejected from the remote payload.
          for (const f of result.failures) {
            console.error(`[brain] /sync/pull mergeRows row failed: table=${config.table} key=${f.key} error=${f.error}`);
          }
        }

        upsertState.run(remoteUrl, config.table, pulledAt);
      }
    })();

    // FR-220: after the merge transaction commits, fire the fire-and-forget
    // post-merge embed pass so synced-in learnings (sync excludes the embedding
    // column) get embedded on receive. Non-blocking — the pull response returns
    // without awaiting the pass. Same helper + core as the /sync/push route.
    scheduleLearningEmbedAfterMerge(db, results);

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
//
// Strict-input contract: igris_sync_queue_drain enforces an allow-list
// of arg keys at handler entry (TD-120). Canonical contract test:
// src/tools/__tests__/sync-queue-drain-contract.test.ts
// ---------------------------------------------------------------------------

/** Input shape for igris_sync_queue_drain */
export interface SyncQueueDrainInput {
  remote_url: string;
  api_key: string;
}

/**
 * Allow-list of argument keys accepted by `igris_sync_queue_drain`.
 *
 * TD-120: silently dropping unknown fields is the exact silent-data-loss
 * class M4 self-heal exposed (callers passed `local_entries` expecting it
 * to drive drain selection; the brain ignored it and read from sync_queue
 * regardless, returning a misleading "drained N" body). The allow-list
 * guard at handler entry rejects any caller-supplied key outside this
 * set, surfacing the bug at red-test time instead of silent runtime.
 *
 * Zero-dep design: the brain has no Zod dependency. Adding one for a
 * single tool's strict-input contract is scope creep; the explicit
 * Object.keys() walk is the same guarantee with no new deps.
 */
const ALLOWED_DRAIN_KEYS = new Set(['remote_url', 'api_key']);

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
  // Strict-input contract (TD-120): reject unknown arg keys upfront so
  // any caller passing extras gets a JSON-RPC error envelope, not a 200
  // with a misleading "drained N" body. See ALLOWED_DRAIN_KEYS docstring.
  const argsRecord = args as unknown as Record<string, unknown>;
  for (const key of Object.keys(argsRecord)) {
    if (!ALLOWED_DRAIN_KEYS.has(key)) {
      throw new Error(
        `igris_sync_queue_drain: unknown argument '${key}'. ` +
        `Accepted keys: ${[...ALLOWED_DRAIN_KEYS].join(', ')}. ` +
        `(strict-input contract; TD-120)`,
      );
    }
  }

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

  /**
   * BR-066: a "tagged row" carries the queue item id alongside the parsed
   * row payload. We chunk and bisect on tagged rows so that after a
   * recursive split, we still know which sync_queue.id each row maps to
   * — without relying on object reference identity (which breaks once
   * payloads are JSON.stringify+parse'd through halves).
   */
  type TaggedRow = { id: number; table: string; row: Record<string, unknown> };
  type TaggedChunk = TaggedRow[];

  const tagged: TaggedRow[] = items.map((item) => ({
    id: item.id,
    table: item.table_name,
    row: JSON.parse(item.row_data) as Record<string, unknown>,
  }));

  /** Convert a TaggedChunk to the wire-format `tables` map. */
  function toTablesPayload(chunk: TaggedChunk): Record<string, Record<string, unknown>[]> {
    const out: Record<string, Record<string, unknown>[]> = {};
    for (const t of chunk) {
      if (!out[t.table]) out[t.table] = [];
      out[t.table].push(t.row);
    }
    // TD-253: idempotent defense-in-depth. Queued rows are already redacted
    // (sites 1 & 2 redact before queueing), so this is a no-op on relative
    // paths — but it guards any future queue-population path that skips redaction.
    return redactTablesForEgress(out);
  }

  // Initial chunking: pack tagged rows up to CHUNK_SIZE_LIMIT_DRAIN. We can't
  // directly reuse chunkTablesForPushSafe because we need to preserve the
  // id<->row binding. Reproduce the same byte-budgeting algorithm on
  // TaggedRow shape.
  const initialChunks: TaggedChunk[] = [];
  {
    let current: TaggedChunk = [];
    let currentSize = 0;
    for (const t of tagged) {
      const rowSize = Buffer.byteLength(JSON.stringify(t.row), 'utf8');
      if (currentSize + rowSize > CHUNK_SIZE_LIMIT_DRAIN && currentSize > 0) {
        initialChunks.push(current);
        current = [];
        currentSize = 0;
      }
      current.push(t);
      currentSize += rowSize;
    }
    if (current.length > 0) initialChunks.push(current);
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

  /**
   * POST one chunk to the remote. Returns:
   *   - { ok: true }                         all rows merged successfully
   *   - { ok: false, errors }                HTTP 207 — partial success;
   *     `errors[table]` is the message for tables that failed
   *   - { ok: false, fatal: message }        network/HTTP-5xx, no body
   *
   * The caller decides what to do per chunk shape (single-row → mark
   * failed; multi-row → bisect-on-failure).
   */
  async function postChunk(chunk: TaggedChunk): Promise<
    | { ok: true }
    | { ok: false; errors: Record<string, string> }
    | { ok: false; fatal: string }
  > {
    try {
      const response = await fetchWithRetry(`${remoteUrl}/sync/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${args.api_key}`,
        },
        body: JSON.stringify({ tables: toTablesPayload(chunk), pushed_at: now, schema_version: 9 }),
      });
      const body = await response.json() as Record<string, unknown>;
      const errors = (body.errors ?? {}) as Record<string, string>;
      if (Object.keys(errors).length === 0) return { ok: true };
      return { ok: false, errors };
    } catch (err) {
      return { ok: false, fatal: errMsg(err) };
    }
  }

  /**
   * Bisect-on-failure: when a multi-row chunk fails wholesale (network or
   * HTTP 5xx with no per-table errors), split it in half and retry each
   * half. A single-row chunk that still fails marks the row as
   * retrying/failed with a SPECIFIC error message — so post-drain
   * inspection shows "table=brief_files key=igris-ai|FR-111 ..." rather
   * than the historical generic "HTTP 500".
   *
   * Recursion depth is bounded by log2(initial_chunk_size). With a 256 KB
   * cap, worst-case ~7 levels. No stack risk.
   */
  async function attemptChunk(chunk: TaggedChunk): Promise<void> {
    if (chunk.length === 0) return;

    const result = await postChunk(chunk);

    if (result.ok) {
      db.transaction(() => {
        for (const t of chunk) markSent.run(now, t.id);
      })();
      totalSent += chunk.length;
      return;
    }

    if ('errors' in result) {
      // HTTP 207: per-table partial failure. Mark rows in successful
      // tables as sent; mark rows in failed tables as retrying with the
      // specific table-level error message. This is precise enough that
      // we don't need to bisect within a 207 response — the server has
      // already isolated which tables failed, and per-table mergeRows now
      // does row-level catch internally so a successful table means ALL
      // its rows merged.
      const failedTables = result.errors;
      db.transaction(() => {
        for (const t of chunk) {
          if (failedTables[t.table]) {
            const tableErr = failedTables[t.table];
            updateRetry.run(now, `HTTP 207 — table=${t.table}: ${tableErr}`, t.id);
            totalFailed++;
          } else {
            markSent.run(now, t.id);
            totalSent++;
          }
        }
      })();
      return;
    }

    // Wholesale fatal (no body, network, or 5xx). Bisect.
    if (chunk.length === 1) {
      const t = chunk[0];
      const message = `${result.fatal} — table=${t.table} key=${describeRowKey(t.row, t.table)}`;
      db.transaction(() => {
        updateRetry.run(now, message, t.id);
      })();
      totalFailed++;
      return;
    }

    const mid = Math.floor(chunk.length / 2);
    await attemptChunk(chunk.slice(0, mid));
    await attemptChunk(chunk.slice(mid));
  }

  for (const chunk of initialChunks) {
    await attemptChunk(chunk);
  }

  // Recompute the surface tables map for the human-readable summary.
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const t of tagged) {
    if (!tables[t.table]) tables[t.table] = [];
    tables[t.table].push(t.row);
  }
  const chunks = initialChunks; // retained for the summary line

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
  `).all(args.project) as { filename: string; content: unknown; content_hash: string; updated_at: string }[];

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
    // TD-280: coerce a BLOB-stored content (Buffer) to a UTF-8 string, mirroring
    // the CLI read boundary (getSessionFileContent).
    content: Buffer.isBuffer(r.content)
      ? r.content.toString('utf8')
      : r.content == null ? null : String(r.content),
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
