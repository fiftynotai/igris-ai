/**
 * Igris Brain -- Agent Event Tools
 *
 * The brain-timed hunt-cost record (FR-267). Every agent invocation is one
 * `start` row plus one `stop`/`error` row in `agent_events`. The brain stamps
 * both timestamps, computes `duration_ms` on the closing row from its own
 * clock, assigns `round` (a resumed or re-run agent is a new invocation and a
 * new round) and derives `project` from the instance at write time. Nothing
 * time-related is accepted from the caller. Per-phase and per-hunt costs are
 * GROUP BYs over the `hunt_runs` view (instances component, migration v3) —
 * never stored.
 *
 * Tools:
 * - igris_agent_event: Record an agent lifecycle event (start/stop/error/retry)
 *
 * REST helpers:
 * - handleAgentEventList: Per-instance aggregated agent stats
 * - handleAgentEventLog: Per-instance chronological event log
 * - handleAgentMetricsSummary: Cross-instance agent performance summary (optional project filter)
 * - handleAgentMetricsByProject: Per-project metrics breakdown for a specific agent
 *
 * @module tools/agent_events
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { getDb } from '../db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The four lifecycle event kinds. Mirrors the DDL CHECK on `agent_events.event_type`. */
export type AgentEventType = 'start' | 'stop' | 'error' | 'retry';

const EVENT_TYPES: ReadonlySet<string> = new Set<AgentEventType>(['start', 'stop', 'error', 'retry']);

/**
 * Input shape for igris_agent_event.
 *
 * `duration_ms` and `round` are deliberately ABSENT: the brain computes both
 * (FR-267). A caller passing them is rejected at the gateway
 * (`additionalProperties: false`) and dropped by the REST route.
 */
export interface AgentEventInput {
  instance_id: string;
  agent: string;
  event_type: AgentEventType;
  /** The model the caller chose for this agent, or `inherit:<caller model>`. Required on every event. */
  model_requested: string;
  /** The model the harness reports the agent actually ran on. Stop/error only; omit when unknown. */
  model_resolved?: string;
  phase?: string;
  brief_id?: string;
  /** Token counts: omit when unknown — never 0 (stored NULL). */
  input_tokens?: number;
  output_tokens?: number;
  cache_read?: number;
  cache_create?: number;
  result?: string;
  error_message?: string;
  metadata?: string;
}

/** Input shape for handleAgentEventList */
export interface AgentEventListInput {
  instance_id: string;
}

/** Input shape for handleAgentEventLog */
export interface AgentEventLogInput {
  instance_id: string;
  limit?: number;
}

/** Input shape for handleAgentMetricsSummary */
export interface AgentMetricsSummaryInput {
  project_slug?: string;
}

/** Input shape for handleAgentMetricsByProject */
export interface AgentMetricsByProjectInput {
  agent: string;
}

/** Per-project metrics row */
interface ProjectMetricsRow {
  project_slug: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_create: number;
  total_duration_ms: number;
  event_count: number;
  last_event_at: string;
}

/** What the brain recorded for one event — the wrapper emits from it and the REST route reads `id`. */
export interface RecordedAgentEvent {
  id: number;
  instance_id: string;
  agent: string;
  event_type: AgentEventType;
  brief_id: string | null;
  /** Derived from `instances.project_slug` at write time; NULL when the instance row is gone. */
  project: string | null;
  /** 1 + the number of earlier `start` rows for the round key (see {@link deriveRound}). */
  round: number;
  /** Brain-computed on stop/error when an open start exists; NULL on every other row. Read back from the stored row. */
  duration_ms: number | null;
  /** The `start` row a stop/error was paired with, or NULL when none was open. */
  paired_start_id: number | null;
  model_requested: string;
  model_resolved: string | null;
}

/** MCP envelope plus the structured record (stripped by the tool wrapper before it reaches the wire). */
export interface AgentEventResult {
  content: { type: string; text: string }[];
  event: RecordedAgentEvent;
}

/** The FR-267 rejection text. Pinned verbatim by `agent-events.test.ts`. */
export const MODEL_REQUESTED_REQUIRED_MESSAGE =
  'igris_agent_event: model_requested is required (FR-267) — pass the model you chose or inherit:<your model>';

/**
 * Thrown by {@link handleAgentEvent} on an invalid input. The gateway wraps it
 * as `isError: true`; `POST /api/agent-event` maps it to HTTP 400 (it bypasses
 * the gateway, so the handler is the only validator on that path).
 */
export class AgentEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentEventValidationError';
  }
}

/** The key `round` is derived over. */
export interface RoundKey {
  project: string | null;
  brief_id: string | null;
  instance_id: string;
  agent: string;
}

/** An open `start` row: the pairing target for a stop/error. */
export interface OpenStartRow {
  id: number;
  round: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Pure SQL helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Find the latest `start` for the pairing key `(instance_id, agent, brief_id)`
 * that no later `stop`/`error` for the same key has closed. `IS` is the
 * NULL-safe equality, so brief-less events pair among themselves.
 *
 * Any later closing row closes EVERY earlier start of the key, so an orphaned
 * start (agent crashed, no stop) is never paired with a much later stop.
 *
 * @param db - Brain database handle
 * @param instance_id - Instance the agent ran under
 * @param agent - Agent role name
 * @param brief_id - Brief the agent worked, or null
 * @returns The open start row, or undefined when none is open
 */
export function findOpenStart(
  db: Database.Database,
  instance_id: string,
  agent: string,
  brief_id: string | null,
): OpenStartRow | undefined {
  return db.prepare(`
    SELECT s.id, s.round, s.created_at FROM agent_events s
    WHERE s.event_type = 'start' AND s.instance_id = ? AND s.agent = ? AND s.brief_id IS ?
      AND NOT EXISTS (
        SELECT 1 FROM agent_events e
        WHERE e.event_type IN ('stop', 'error')
          AND e.instance_id = s.instance_id AND e.agent = s.agent AND e.brief_id IS s.brief_id
          AND e.id > s.id
      )
    ORDER BY s.id DESC LIMIT 1
  `).get(instance_id, agent, brief_id) as OpenStartRow | undefined;
}

/**
 * Count the `start` rows already recorded for the round key. A brief is
 * `(project, brief_id)`, so a brief-keyed event counts across instances
 * (`project IS ?, brief_id IS ?, agent`); a brief-less event falls back to the
 * pairing key (`instance_id, agent, brief_id IS NULL`).
 *
 * @param db - Brain database handle
 * @param key - Round key
 * @returns Number of prior start rows
 */
function countStarts(db: Database.Database, key: RoundKey): number {
  if (key.brief_id !== null) {
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM agent_events
      WHERE event_type = 'start' AND project IS ? AND brief_id IS ? AND agent = ?
    `).get(key.project, key.brief_id, key.agent) as { c: number };
    return row.c;
  }
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM agent_events
    WHERE event_type = 'start' AND instance_id = ? AND agent = ? AND brief_id IS NULL
  `).get(key.instance_id, key.agent) as { c: number };
  return row.c;
}

/**
 * Derive the `round` for a new row. A `start` opens a new invocation
 * (`1 + prior starts`); any other event reports the invocation in flight
 * (`max(1, starts so far)`) — a paired stop/error uses its start's round
 * instead, see {@link handleAgentEvent}.
 *
 * @param db - Brain database handle
 * @param event_type - The event being recorded
 * @param key - Round key
 * @returns The round to store
 */
export function deriveRound(db: Database.Database, event_type: AgentEventType, key: RoundKey): number {
  const starts = countStarts(db, key);
  return event_type === 'start' ? starts + 1 : Math.max(1, starts);
}

/** `instances.project_slug` for the instance, or null when the row is gone (removed on /rest). */
function lookupProject(db: Database.Database, instance_id: string): string | null {
  const row = db.prepare('SELECT project_slug FROM instances WHERE id = ?')
    .get(instance_id) as { project_slug: string | null } | undefined;
  return row?.project_slug ?? null;
}

/**
 * Handler-level validation. Lives here (not only at the gateway) because
 * `POST /api/agent-event` reaches the handler without the gateway's
 * `required` walk.
 */
function validateAgentEventInput(args: AgentEventInput): void {
  if (!EVENT_TYPES.has(String(args.event_type))) {
    throw new AgentEventValidationError(
      `igris_agent_event: event_type must be one of start, stop, error, retry (got ${JSON.stringify(args.event_type)})`,
    );
  }
  if (typeof args.model_requested !== 'string' || args.model_requested.trim().length === 0) {
    throw new AgentEventValidationError(MODEL_REQUESTED_REQUIRED_MESSAGE);
  }
}

// ---------------------------------------------------------------------------
// MCP Tool Handler
// ---------------------------------------------------------------------------

const INSERT_COLUMNS =
  'instance_id, agent, event_type, phase, brief_id, ' +
  'duration_ms, input_tokens, output_tokens, cache_read, cache_create, ' +
  'result, error_message, metadata, model_requested, model_resolved, round, project';

/**
 * Duration computed IN SQL from the brain's own clock: one clock for both ends
 * of the bracket (`created_at` defaults to `datetime('now')`, second
 * precision — ±1 s, adequate for minutes-level diagnosis). Binds the start id.
 */
const DURATION_FROM_START_SQL =
  "CAST((julianday('now') - julianday((SELECT created_at FROM agent_events WHERE id = ?))) * 86400000 AS INTEGER)";

function isClosing(event_type: AgentEventType): boolean {
  return event_type === 'stop' || event_type === 'error';
}

/** Render the confirmation line so the orchestrator SEES what the brain computed. */
function formatRecorded(e: RecordedAgentEvent): string {
  const model = e.model_resolved
    ? `model ${e.model_requested}, resolved ${e.model_resolved}`
    : `model ${e.model_requested}`;
  const duration = isClosing(e.event_type) ? `, duration_ms ${e.duration_ms ?? 'NULL'}` : '';
  const note = isClosing(e.event_type) && e.paired_start_id === null
    ? ' (no matching start — duration not computed)'
    : '';
  return `Agent event recorded: ${e.agent} ${e.event_type} (id: ${e.id}, round ${e.round}${duration}, ${model})${note}`;
}

/**
 * Record an agent lifecycle event in the durable hunt-cost record.
 *
 * - `start`: opens an invocation — `round = 1 + prior starts` for the round
 *   key, `duration_ms` NULL.
 * - `stop` / `error`: closes the latest open start for the pairing key
 *   `(instance_id, agent, brief_id)`; `duration_ms` is computed in SQL from
 *   that start's `created_at`, `round` is the start's. With no open start the
 *   row is stored with `duration_ms` NULL and the response says so.
 * - `retry`: a marker row; it never consumes an open start.
 *
 * Tokens are stored as given and NULL when omitted (never 0). `project` comes
 * from `instances.project_slug` at write time because instance rows are
 * deleted on /rest. Pairing is re-derivable from the rows on any replica — no
 * local-id foreign key is stored (ids differ per machine).
 *
 * Known limitation: two concurrent same-role agents on the same brief AND
 * instance may mis-pair (per-invocation counts stay right, durations may
 * swap). See FR-267.
 *
 * @param args - Agent event data; `model_requested` is required
 * @returns MCP-formatted response plus the structured record
 * @throws AgentEventValidationError on an invalid `event_type` or a missing/empty `model_requested`
 */
export function handleAgentEvent(args: AgentEventInput): AgentEventResult {
  const db = getDb();
  validateAgentEventInput(args);

  const briefId = args.brief_id ?? null;
  const project = lookupProject(db, args.instance_id);
  const roundKey: RoundKey = {
    project,
    brief_id: briefId,
    instance_id: args.instance_id,
    agent: args.agent,
  };
  const modelResolved = args.model_resolved ?? null;

  const headValues = [args.instance_id, args.agent, args.event_type, args.phase ?? null, briefId];
  const tailValues = (round: number): unknown[] => [
    args.input_tokens ?? null,
    args.output_tokens ?? null,
    args.cache_read ?? null,
    args.cache_create ?? null,
    args.result ?? null,
    args.error_message ?? null,
    args.metadata ?? '{}',
    args.model_requested,
    modelResolved,
    round,
    project,
  ];

  const open = isClosing(args.event_type)
    ? findOpenStart(db, args.instance_id, args.agent, briefId)
    : undefined;

  let round: number;
  let pairedStartId: number | null = null;
  let inserted: Database.RunResult;

  if (open) {
    round = open.round;
    pairedStartId = open.id;
    inserted = db.prepare(`
      INSERT INTO agent_events (${INSERT_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ${DURATION_FROM_START_SQL}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...headValues, open.id, ...tailValues(round));
  } else {
    round = deriveRound(db, args.event_type, roundKey);
    inserted = db.prepare(`
      INSERT INTO agent_events (${INSERT_COLUMNS})
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...headValues, ...tailValues(round));
  }

  const id = Number(inserted.lastInsertRowid);
  // Report what the ROW holds, not a JS-side computation (L-1248).
  const stored = db.prepare('SELECT duration_ms FROM agent_events WHERE id = ?')
    .get(id) as { duration_ms: number | null };

  const event: RecordedAgentEvent = {
    id,
    instance_id: args.instance_id,
    agent: args.agent,
    event_type: args.event_type,
    brief_id: briefId,
    project,
    round,
    duration_ms: stored.duration_ms,
    paired_start_id: pairedStartId,
    model_requested: args.model_requested,
    model_resolved: modelResolved,
  };

  return {
    content: [{ type: 'text', text: formatRecorded(event) }],
    event,
  };
}

// ---------------------------------------------------------------------------
// REST API Helpers
// ---------------------------------------------------------------------------

/**
 * Get aggregated per-agent stats for a specific instance.
 *
 * Groups agent events by agent name and returns a summary including
 * latest event type (current status), total tokens, total duration,
 * and event count for each agent.
 *
 * @param args - Instance ID to query
 * @returns JSON response with per-agent aggregated statistics
 */
export function handleAgentEventList(
  args: AgentEventListInput
): { agents: Record<string, unknown>[]; instance_id: string } {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      agent,
      (SELECT CASE
         WHEN ae2.event_type = 'start' THEN 'WORKING'
         WHEN ae2.event_type = 'stop' AND ae2.result IN ('success', 'APPROVE', 'PASS') THEN 'DONE'
         WHEN ae2.event_type = 'stop' THEN 'FAIL'
         WHEN ae2.event_type = 'error' THEN 'FAIL'
         ELSE 'IDLE'
       END
       FROM agent_events ae2
       WHERE ae2.instance_id = ae.instance_id AND ae2.agent = ae.agent
       ORDER BY created_at DESC LIMIT 1) as status,
      (SELECT phase FROM agent_events ae3
       WHERE ae3.instance_id = ae.instance_id AND ae3.agent = ae.agent
       ORDER BY created_at DESC LIMIT 1) as latest_phase,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      (SUM(input_tokens) + SUM(output_tokens)) as total_tokens,
      SUM(cache_read) as total_cache_read,
      SUM(cache_create) as total_cache_create,
      SUM(duration_ms) as total_duration_ms,
      COUNT(*) as event_count,
      MAX(created_at) as last_event_at
    FROM agent_events ae
    WHERE instance_id = ?
    GROUP BY agent
    ORDER BY last_event_at DESC
  `).all(args.instance_id) as Record<string, unknown>[];

  return {
    instance_id: args.instance_id,
    agents: rows,
  };
}

/**
 * Get chronological event log for a specific instance.
 *
 * Returns recent agent events ordered by creation time (newest first),
 * with a configurable limit (default: 50). Carries the FR-267 columns
 * (`model_requested`, `model_resolved`, `round`, `project`) so a reader can
 * see the record the brain wrote.
 *
 * @param args - Instance ID and optional limit
 * @returns JSON response with array of agent events
 */
export function handleAgentEventLog(
  args: AgentEventLogInput
): { instance_id: string; events: Record<string, unknown>[]; count: number } {
  const db = getDb();
  const limit = args.limit ?? 50;

  const rows = db.prepare(`
    SELECT
      id, instance_id, agent, event_type, phase, brief_id,
      duration_ms, input_tokens, output_tokens, cache_read, cache_create,
      result, error_message, metadata, created_at,
      model_requested, model_resolved, round, project
    FROM agent_events
    WHERE instance_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(args.instance_id, limit) as Record<string, unknown>[];

  return {
    instance_id: args.instance_id,
    events: rows,
    count: rows.length,
  };
}

/**
 * Get cross-instance agent performance summary.
 *
 * Aggregates agent events across all instances to produce per-agent
 * performance metrics including success rate, average tokens, average
 * duration, and recent events for sparkline visualization.
 *
 * When `project_slug` is provided, filters to only events from instances
 * belonging to that project.
 *
 * @param args - Optional project_slug filter
 * @returns JSON response with per-agent performance metrics
 */
export function handleAgentMetricsSummary(args?: AgentMetricsSummaryInput): {
  agents: Record<string, unknown>[];
  recent_by_agent: Record<string, Record<string, unknown>[]>;
} {
  const db = getDb();
  const projectSlug = args?.project_slug;

  // Build query parts conditionally for project filtering
  const joinClause = projectSlug
    ? 'LEFT JOIN instances i ON ae.instance_id = i.id'
    : '';
  const projectFilter = projectSlug
    ? 'AND i.project_slug = ?'
    : '';
  const statsParams = projectSlug ? [projectSlug] : [];

  // Per-agent aggregation for stop and error events
  const agentStats = db.prepare(`
    SELECT
      ae.agent,
      COUNT(*) as total_events,
      SUM(CASE WHEN ae.event_type = 'stop' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN ae.event_type = 'error' THEN 1 ELSE 0 END) as error_count,
      ROUND(
        CAST(SUM(CASE WHEN ae.event_type = 'stop' THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(COUNT(*), 0), 3
      ) as success_rate,
      ROUND(AVG(ae.input_tokens + ae.output_tokens), 0) as avg_tokens,
      ROUND(AVG(ae.duration_ms), 0) as avg_duration_ms,
      SUM(ae.input_tokens) as total_input_tokens,
      SUM(ae.output_tokens) as total_output_tokens,
      MAX(ae.created_at) as last_event_at
    FROM agent_events ae
    ${joinClause}
    WHERE ae.event_type IN ('stop', 'error')
    ${projectFilter}
    GROUP BY ae.agent
    ORDER BY total_events DESC
  `).all(...statsParams) as Record<string, unknown>[];

  // Recent events per agent for sparkline data (last 20 per agent)
  const recentByAgent: Record<string, Record<string, unknown>[]> = {};

  const agents = db.prepare(`
    SELECT DISTINCT ae.agent FROM agent_events ae
    ${joinClause}
    WHERE ae.event_type IN ('stop', 'error')
    ${projectFilter}
  `).all(...statsParams) as { agent: string }[];

  for (const { agent } of agents) {
    const recentParams: string[] = [agent, ...statsParams];
    const recentEvents = db.prepare(`
      SELECT ae.event_type, ae.duration_ms, ae.input_tokens, ae.output_tokens, ae.created_at
      FROM agent_events ae
      ${joinClause}
      WHERE ae.agent = ? AND ae.event_type IN ('stop', 'error')
      ${projectFilter}
      ORDER BY ae.created_at DESC
      LIMIT 20
    `).all(...recentParams) as Record<string, unknown>[];

    recentByAgent[agent] = recentEvents;
  }

  return {
    agents: agentStats,
    recent_by_agent: recentByAgent,
  };
}

/**
 * Get per-project metrics breakdown for a specific agent.
 *
 * Aggregates agent_events by project (via instances join) for the given
 * agent, returning token usage, duration, and event counts per project
 * over the last 30 days.
 *
 * @param args - Agent name to query
 * @returns Per-project metrics array for the specified agent
 */
export function handleAgentMetricsByProject(args: AgentMetricsByProjectInput): {
  agent: string;
  projects: ProjectMetricsRow[];
} {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      i.project_slug,
      SUM(ae.input_tokens) as input_tokens,
      SUM(ae.output_tokens) as output_tokens,
      SUM(ae.cache_read) as cache_read,
      SUM(ae.cache_create) as cache_create,
      SUM(ae.duration_ms) as total_duration_ms,
      COUNT(*) as event_count,
      MAX(ae.created_at) as last_event_at
    FROM agent_events ae
    LEFT JOIN instances i ON ae.instance_id = i.id
    WHERE ae.agent = ?
      AND ae.event_type = 'stop'
      AND ae.created_at >= datetime('now', '-30 days')
    GROUP BY i.project_slug
    ORDER BY event_count DESC
  `).all(args.agent) as ProjectMetricsRow[];

  return {
    agent: args.agent,
    projects: rows,
  };
}
