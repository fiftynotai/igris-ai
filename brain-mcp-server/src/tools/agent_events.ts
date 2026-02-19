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
 * - handleAgentMetricsSummary: Cross-instance agent performance summary
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
 * @returns JSON response with per-agent performance metrics
 */
export function handleAgentMetricsSummary(): {
  agents: Record<string, unknown>[];
  recent_by_agent: Record<string, Record<string, unknown>[]>;
} {
  const db = getDb();

  // Per-agent aggregation for stop and error events
  const agentStats = db.prepare(`
    SELECT
      agent,
      COUNT(*) as total_events,
      SUM(CASE WHEN event_type = 'stop' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END) as error_count,
      ROUND(
        CAST(SUM(CASE WHEN event_type = 'stop' THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(COUNT(*), 0), 3
      ) as success_rate,
      ROUND(AVG(input_tokens + output_tokens), 0) as avg_tokens,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      MAX(created_at) as last_event_at
    FROM agent_events
    WHERE event_type IN ('stop', 'error')
    GROUP BY agent
    ORDER BY total_events DESC
  `).all() as Record<string, unknown>[];

  // Recent events per agent for sparkline data (last 20 per agent)
  const recentByAgent: Record<string, Record<string, unknown>[]> = {};

  const agents = db.prepare(`
    SELECT DISTINCT agent FROM agent_events
    WHERE event_type IN ('stop', 'error')
  `).all() as { agent: string }[];

  for (const { agent } of agents) {
    const recentEvents = db.prepare(`
      SELECT event_type, duration_ms, input_tokens, output_tokens, created_at
      FROM agent_events
      WHERE agent = ? AND event_type IN ('stop', 'error')
      ORDER BY created_at DESC
      LIMIT 20
    `).all(agent) as Record<string, unknown>[];

    recentByAgent[agent] = recentEvents;
  }

  return {
    agents: agentStats,
    recent_by_agent: recentByAgent,
  };
}
