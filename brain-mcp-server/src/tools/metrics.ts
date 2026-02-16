/**
 * Igris Brain — Metrics Tools
 *
 * Provides agent performance metrics recording and querying.
 * Tracks success rates, durations, and retry counts per agent and project.
 *
 * Tools:
 * - igris_metrics_record: Record an agent metric
 * - igris_metrics_query: Query agent performance metrics
 * - igris_metrics_velocity: Velocity dashboard with weekly completion rates
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

/** Input shape for igris_metrics_velocity */
interface MetricsVelocityInput {
  project?: string;
  days?: number;
}

/**
 * Generate a velocity dashboard showing brief completion rates,
 * average completion time, agent utilization, and week-over-week trends.
 *
 * @param args - Optional project filter and time window (days, default 30)
 * @returns MCP-formatted markdown velocity dashboard
 */
function handleMetricsVelocity(args: MetricsVelocityInput): { content: { type: string; text: string }[] } {
  const db = getDb();
  const days = args.days ?? 30;

  // Build dynamic WHERE clause for optional project filter
  const projectCondition = args.project ? ' AND project = ?' : '';
  const projectParams: string[] = args.project ? [args.project] : [];

  // --- Briefs completed per week ---
  const weeklyBriefsSql = `
    SELECT strftime('%Y-W%W', recorded_at) as week,
           COUNT(DISTINCT brief_id) as briefs_completed
    FROM agent_metrics
    WHERE action = 'implement'
      AND result = 'success'
      AND brief_id != ''
      AND recorded_at >= datetime('now', '-' || ? || ' days')
      ${projectCondition}
    GROUP BY week
    ORDER BY week DESC
  `;
  const weeklyBriefsRows = db.prepare(weeklyBriefsSql).all(days, ...projectParams) as Record<string, unknown>[];

  // --- Average brief completion time (proxy: first to last metric per brief_id) ---
  const avgTimeSql = `
    SELECT brief_id,
           ROUND((julianday(MAX(recorded_at)) - julianday(MIN(recorded_at))) * 24 * 60, 1) as duration_minutes
    FROM agent_metrics
    WHERE brief_id != ''
      AND recorded_at >= datetime('now', '-' || ? || ' days')
      ${projectCondition}
    GROUP BY brief_id
    HAVING COUNT(*) >= 2
  `;
  const avgTimeRows = db.prepare(avgTimeSql).all(days, ...projectParams) as Record<string, unknown>[];

  let avgCompletionTime = 'N/A';
  if (avgTimeRows.length > 0) {
    const totalMinutes = avgTimeRows.reduce((sum, row) => sum + (row.duration_minutes as number), 0);
    const avg = totalMinutes / avgTimeRows.length;
    if (avg >= 60) {
      avgCompletionTime = `${(avg / 60).toFixed(1)}h`;
    } else {
      avgCompletionTime = `${avg.toFixed(1)}min`;
    }
  }

  // --- Agent utilization ---
  const agentUtilSql = `
    SELECT agent,
           COUNT(*) as total_actions,
           SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) as successes,
           ROUND(AVG(duration_ms), 0) as avg_ms
    FROM agent_metrics
    WHERE recorded_at >= datetime('now', '-' || ? || ' days')
      ${projectCondition}
    GROUP BY agent
    ORDER BY total_actions DESC
  `;
  const agentUtilRows = db.prepare(agentUtilSql).all(days, ...projectParams) as Record<string, unknown>[];

  // --- Week-over-week trend ---
  const currentWeekSql = `
    SELECT COUNT(*) as actions,
           COUNT(DISTINCT brief_id) as briefs
    FROM agent_metrics
    WHERE recorded_at >= datetime('now', '-7 days')
      AND result = 'success'
      ${projectCondition}
  `;
  const currentWeek = db.prepare(currentWeekSql).get(...projectParams) as Record<string, unknown> | undefined;

  const previousWeekSql = `
    SELECT COUNT(*) as actions,
           COUNT(DISTINCT brief_id) as briefs
    FROM agent_metrics
    WHERE recorded_at >= datetime('now', '-14 days')
      AND recorded_at < datetime('now', '-7 days')
      AND result = 'success'
      ${projectCondition}
  `;
  const previousWeek = db.prepare(previousWeekSql).get(...projectParams) as Record<string, unknown> | undefined;

  // --- Format dashboard ---
  const filterDesc = args.project ? ` (project: ${args.project})` : ' (all projects)';

  // Weekly briefs section
  let weeklySection: string;
  if (weeklyBriefsRows.length === 0) {
    weeklySection = '(no completed briefs in this period)';
  } else {
    const wHeader = '| Week | Briefs Completed |';
    const wSep = '|------|-----------------|';
    const wRows = weeklyBriefsRows.map(r => `| ${r.week} | ${r.briefs_completed} |`);
    weeklySection = `${wHeader}\n${wSep}\n${wRows.join('\n')}`;
  }

  // Agent utilization section
  let agentSection: string;
  if (agentUtilRows.length === 0) {
    agentSection = '(no agent activity in this period)';
  } else {
    const aHeader = '| Agent | Actions | Success Rate | Avg Duration |';
    const aSep = '|-------|---------|-------------|-------------|';
    const aRows = agentUtilRows.map(r => {
      const total = r.total_actions as number;
      const successes = r.successes as number;
      const rate = total > 0 ? Math.round((successes / total) * 100) : 0;
      const avgDur = r.avg_ms ? `${r.avg_ms}ms` : 'N/A';
      return `| ${r.agent} | ${total} | ${rate}% | ${avgDur} |`;
    });
    agentSection = `${aHeader}\n${aSep}\n${aRows.join('\n')}`;
  }

  // Trend section
  const curActions = (currentWeek?.actions as number) ?? 0;
  const prevActions = (previousWeek?.actions as number) ?? 0;
  const curBriefs = (currentWeek?.briefs as number) ?? 0;
  const prevBriefs = (previousWeek?.briefs as number) ?? 0;

  let trendEmoji: string;
  if (prevActions === 0) {
    trendEmoji = '(no previous week data for comparison)';
  } else {
    const changePct = Math.round(((curActions - prevActions) / prevActions) * 100);
    const direction = changePct >= 0 ? 'up' : 'down';
    trendEmoji = `Actions: ${curActions} vs ${prevActions} (${direction} ${Math.abs(changePct)}%) | Briefs: ${curBriefs} vs ${prevBriefs}`;
  }

  return {
    content: [{
      type: 'text',
      text: [
        `# Velocity Dashboard${filterDesc}`,
        `Period: last ${days} days`,
        '',
        '## Briefs Completed Per Week',
        weeklySection,
        '',
        '## Average Brief Completion Time',
        `${avgCompletionTime} (based on ${avgTimeRows.length} briefs with 2+ metrics)`,
        '',
        '## Agent Utilization',
        agentSection,
        '',
        '## Week-over-Week Trend (current vs previous)',
        trendEmoji,
      ].join('\n'),
    }],
  };
}

export { handleMetricsRecord, handleMetricsQuery, handleMetricsVelocity };
export type { MetricsRecordInput, MetricsQueryInput, MetricsVelocityInput };
