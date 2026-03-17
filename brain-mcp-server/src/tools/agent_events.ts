/**
 * Igris Brain -- Agent Event Tools
 *
 * Provides real-time agent lifecycle event tracking for the Crimson Arena
 * dashboard. Events are recorded during /hunt workflow phase transitions
 * and consumed by the dashboard for live agent activity visualization.
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
 * @author Fifty.ai
 */

import { getDb } from '../db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input shape for igris_agent_event */
export interface AgentEventInput {
  instance_id: string;
  agent: string;
  event_type: 'start' | 'stop' | 'error' | 'retry';
  phase?: string;
  brief_id?: string;
  duration_ms?: number;
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

// ---------------------------------------------------------------------------
// MCP Tool Handler
// ---------------------------------------------------------------------------

/**
 * Record an agent lifecycle event in the brain database.
 *
 * Called during /hunt workflow at each agent phase transition to track
 * agent start, stop, error, and retry events for live dashboard updates.
 *
 * @param args - Agent event data including instance_id, agent name, and event type
 * @returns MCP-formatted response confirming the recorded event
 */
export function handleAgentEvent(
  args: AgentEventInput
): { content: { type: string; text: string }[] } {
  const db = getDb();

  const result = db.prepare(`
    INSERT INTO agent_events
      (instance_id, agent, event_type, phase, brief_id,
       duration_ms, input_tokens, output_tokens, cache_read, cache_create,
       result, error_message, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.instance_id,
    args.agent,
    args.event_type,
    args.phase ?? null,
    args.brief_id ?? null,
    args.duration_ms ?? 0,
    args.input_tokens ?? 0,
    args.output_tokens ?? 0,
    args.cache_read ?? 0,
    args.cache_create ?? 0,
    args.result ?? null,
    args.error_message ?? null,
    args.metadata ?? '{}'
  );

  return {
    content: [{
      type: 'text',
      text: `Agent event recorded: ${args.agent} ${args.event_type} (id: ${result.lastInsertRowid})`,
    }],
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
 * with a configurable limit (default: 50).
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
      result, error_message, metadata, created_at
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
