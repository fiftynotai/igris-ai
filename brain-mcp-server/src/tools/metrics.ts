/**
 * Igris Brain — Metrics Tools
 *
 * Provides agent performance metrics recording and querying.
 * Tracks success rates, durations, and retry counts per agent and project.
 *
 * Tools:
 * - igris_metrics_record: Record an agent metric
 * - igris_metrics_query: Query agent performance metrics
 *
 * @module tools/metrics
 * @author Fifty.ai
 */

import { getDb } from '../db.js';

/** Input shape for igris_metrics_record */
interface MetricsRecordInput {
  project: string;
  agent: string;
  brief_id?: string;
  action: string;
  result: 'success' | 'failure' | 'partial' | 'blocked';
  duration_ms?: number;
  retry_count?: number;
}

/** Input shape for igris_metrics_query */
interface MetricsQueryInput {
  project?: string;
  agent?: string;
  limit?: number;
}

/**
 * Record an agent metric in the database.
 *
 * @param args - Metric data to record
 * @returns MCP-formatted confirmation response
 */
function handleMetricsRecord(args: MetricsRecordInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  const result = db.prepare(`
    INSERT INTO agent_metrics (project, agent, brief_id, action, result, duration_ms, retry_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.project,
    args.agent,
    args.brief_id ?? '',
    args.action,
    args.result,
    args.duration_ms ?? 0,
    args.retry_count ?? 0
  );

  return {
    content: [{
      type: 'text',
      text: [
        'Metric recorded successfully.',
        '',
        `ID: ${result.lastInsertRowid}`,
        `Project: ${args.project}`,
        `Agent: ${args.agent}`,
        `Action: ${args.action}`,
        `Result: ${args.result}`,
        args.duration_ms ? `Duration: ${args.duration_ms}ms` : null,
        args.retry_count ? `Retries: ${args.retry_count}` : null,
        args.brief_id ? `Brief: ${args.brief_id}` : null,
      ].filter(Boolean).join('\n'),
    }],
  };
}

/**
 * Query agent performance metrics.
 *
 * Returns recent metric entries and summary statistics including
 * success rate by agent and average duration.
 *
 * @param args - Query filters (project, agent, limit)
 * @returns MCP-formatted response with metrics and summary stats
 */
function handleMetricsQuery(args: MetricsQueryInput): { content: { type: string; text: string }[] } {
  const db = getDb();
  const limit = args.limit ?? 20;

  // Build dynamic WHERE clause
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (args.project) {
    conditions.push('project = ?');
    params.push(args.project);
  }
  if (args.agent) {
    conditions.push('agent = ?');
    params.push(args.agent);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get recent metrics
  const recentSql = `
    SELECT id, project, agent, brief_id, action, result, duration_ms, retry_count, recorded_at
    FROM agent_metrics
    ${whereClause}
    ORDER BY recorded_at DESC
    LIMIT ?
  `;
  const recentRows = db.prepare(recentSql).all(...params, limit) as Record<string, unknown>[];

  // Get summary stats (success rate by agent)
  const summarySql = `
    SELECT agent,
           COUNT(*) as total,
           SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) as successes,
           ROUND(AVG(duration_ms), 0) as avg_duration_ms
    FROM agent_metrics
    ${whereClause}
    GROUP BY agent
    ORDER BY total DESC
  `;
  const summaryRows = db.prepare(summarySql).all(...params) as Record<string, unknown>[];

  // Format recent entries
  let recentSection: string;
  if (recentRows.length === 0) {
    recentSection = '(no metrics found)';
  } else {
    recentSection = recentRows.map((m, i) =>
      `  ${i + 1}. [${m.recorded_at}] ${m.project}/${m.agent}/${m.action} -> ${m.result}${m.duration_ms ? ` (${m.duration_ms}ms)` : ''}${m.brief_id ? ` [${m.brief_id}]` : ''}${(m.retry_count as number) > 0 ? ` (${m.retry_count} retries)` : ''}`
    ).join('\n');
  }

  // Format summary stats
  let summarySection: string;
  if (summaryRows.length === 0) {
    summarySection = '(no data)';
  } else {
    const header = '| Agent | Total | Successes | Success Rate | Avg Duration |';
    const separator = '|-------|-------|-----------|-------------|-------------|';
    const rows = summaryRows.map(s => {
      const total = s.total as number;
      const successes = s.successes as number;
      const rate = total > 0 ? Math.round((successes / total) * 100) : 0;
      const avgDur = s.avg_duration_ms ? `${s.avg_duration_ms}ms` : 'N/A';
      return `| ${s.agent} | ${total} | ${successes} | ${rate}% | ${avgDur} |`;
    });
    summarySection = `${header}\n${separator}\n${rows.join('\n')}`;
  }

  // Build filter description
  const filters: string[] = [];
  if (args.project) filters.push(`project=${args.project}`);
  if (args.agent) filters.push(`agent=${args.agent}`);
  const filterDesc = filters.length > 0 ? ` (filtered: ${filters.join(', ')})` : '';

  return {
    content: [{
      type: 'text',
      text: [
        `# Agent Metrics${filterDesc}`,
        '',
        '## Summary by Agent',
        summarySection,
        '',
        `## Recent Entries (last ${limit})`,
        recentSection,
      ].join('\n'),
    }],
  };
}

export { handleMetricsRecord, handleMetricsQuery };
export type { MetricsRecordInput, MetricsQueryInput };
