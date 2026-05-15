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
 * @author fifty.dev
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

/** Input shape for igris_metrics_dashboard (TD-171 M4) */
interface MetricsDashboardInput {
  project?: string;
  days?: number;
  agent?: string;
  summary_only?: boolean;
}

/**
 * Aggregate dashboard over the `agent_metrics` table (TD-171 M4).
 *
 * Mirrors the canonical TD-171 `_dashboard` shape established by M1's
 * `handleMemoryDashboard` and reused by M2/M3 dashboards:
 *
 *   {
 *     totals: {
 *       total_invocations: N,
 *       by_agent: { [agent]: { invocations, success_rate, avg_duration_ms, retries }, ... },
 *       by_action: { [action]: { invocations, success_rate }, ... },
 *       by_result: { success, failure, partial, blocked },
 *     },
 *     recent: {
 *       last_n_days: <days>,
 *       invocations: N,
 *       week_over_week_delta_pct: number | null,
 *     },
 *     samples: {
 *       top_durations: [{ id, project, agent, action, duration_ms, recorded_at }, ...],
 *     },                                                // omitted when summary_only
 *     project?: 'foo',                                  // echoed when filter set
 *     agent?: 'forger',                                 // echoed when filter set
 *   }
 *
 * Filter semantics:
 *   - `project`: scopes totals + recent + samples to one project.
 *   - `agent`: scopes totals + recent + samples to one agent (combinable
 *     with project; both ANDed). Per-agent breakdown then collapses to a
 *     single key, kept in the shape for downstream-UI consistency.
 *   - `days`: window for `recent.invocations` and the WoW delta. Default 30.
 *   - `summary_only`: omits the `samples` block (counts still computed).
 *
 * Per L-152, scope is strictly the metrics channel — no goals, learnings,
 * or perception aggregations leak in. Pair with `igris_brief_velocity` for
 * completion-rate context.
 *
 * SQL is built via parameterized WHERE fragments — agent and project come
 * from typed args (string), but we still bind them rather than interpolate.
 */
function handleMetricsDashboard(args: MetricsDashboardInput): { content: { type: string; text: string }[] } {
  const days = args.days !== undefined ? Number(args.days) : 30;
  if (!Number.isFinite(days) || days < 0) {
    return { content: [{ type: 'text', text: 'Error: days must be a non-negative number' }] };
  }
  const summaryOnly = args.summary_only === true;
  const projectFilter = typeof args.project === 'string' && args.project.length > 0 ? args.project : null;
  const agentFilter = typeof args.agent === 'string' && args.agent.length > 0 ? args.agent : null;

  const db = getDb();

  // Build a reusable WHERE fragment + params list. All aggregations share
  // the same project/agent filter; only the recent window adds a time
  // bound on top.
  const baseConditions: string[] = [];
  const baseParams: string[] = [];
  if (projectFilter) {
    baseConditions.push('project = ?');
    baseParams.push(projectFilter);
  }
  if (agentFilter) {
    baseConditions.push('agent = ?');
    baseParams.push(agentFilter);
  }
  const baseWhere = baseConditions.length > 0 ? `WHERE ${baseConditions.join(' AND ')}` : '';

  // --- totals.total_invocations ---
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM agent_metrics ${baseWhere}`)
    .get(...baseParams) as { n: number };

  // --- totals.by_agent ---
  // Per-agent: invocations, success_rate, avg_duration_ms, retries (sum).
  // Round success_rate to 3 decimal places (matches goals' completion_pct
  // convention). Empty DB yields zero rows — render as {}.
  const byAgentRows = db
    .prepare(
      `SELECT agent,
              COUNT(*) AS invocations,
              SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) AS successes,
              ROUND(AVG(duration_ms), 0) AS avg_duration_ms,
              SUM(retry_count) AS retries
       FROM agent_metrics
       ${baseWhere}
       GROUP BY agent
       ORDER BY invocations DESC`,
    )
    .all(...baseParams) as {
      agent: string;
      invocations: number;
      successes: number;
      avg_duration_ms: number | null;
      retries: number | null;
    }[];
  const byAgent: Record<string, { invocations: number; success_rate: number; avg_duration_ms: number; retries: number }> = {};
  for (const r of byAgentRows) {
    const successRate = r.invocations > 0 ? Math.round((r.successes / r.invocations) * 1000) / 1000 : 0;
    byAgent[r.agent] = {
      invocations: r.invocations,
      success_rate: successRate,
      avg_duration_ms: r.avg_duration_ms ?? 0,
      retries: r.retries ?? 0,
    };
  }

  // --- totals.by_action ---
  const byActionRows = db
    .prepare(
      `SELECT action,
              COUNT(*) AS invocations,
              SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) AS successes
       FROM agent_metrics
       ${baseWhere}
       GROUP BY action
       ORDER BY invocations DESC`,
    )
    .all(...baseParams) as { action: string; invocations: number; successes: number }[];
  const byAction: Record<string, { invocations: number; success_rate: number }> = {};
  for (const r of byActionRows) {
    const successRate = r.invocations > 0 ? Math.round((r.successes / r.invocations) * 1000) / 1000 : 0;
    byAction[r.action] = { invocations: r.invocations, success_rate: successRate };
  }

  // --- totals.by_result ---
  // Initialize all four valid result codes to zero so the shape is stable
  // even when a particular outcome hasn't fired.
  const byResultRows = db
    .prepare(`SELECT result, COUNT(*) AS n FROM agent_metrics ${baseWhere} GROUP BY result`)
    .all(...baseParams) as { result: string; n: number }[];
  const byResult: Record<string, number> = { success: 0, failure: 0, partial: 0, blocked: 0 };
  for (const r of byResultRows) byResult[r.result] = r.n;

  // --- recent.invocations (last `days` window) ---
  const recentConditions = [...baseConditions, "recorded_at >= datetime('now', ?)"];
  const recentWhere = `WHERE ${recentConditions.join(' AND ')}`;
  const recentParams: (string | number)[] = [...baseParams, `-${days} days`];
  const recentRow = db
    .prepare(`SELECT COUNT(*) AS n FROM agent_metrics ${recentWhere}`)
    .get(...recentParams) as { n: number };

  // --- recent.week_over_week_delta_pct ---
  // Compares last 7 days vs prior 7 days (each filtered by project/agent).
  // null when the previous window has zero invocations (no comparable base).
  const curWeekConditions = [...baseConditions, "recorded_at >= datetime('now', '-7 days')"];
  const curWeekWhere = `WHERE ${curWeekConditions.join(' AND ')}`;
  const curWeekRow = db
    .prepare(`SELECT COUNT(*) AS n FROM agent_metrics ${curWeekWhere}`)
    .get(...baseParams) as { n: number };

  const prevWeekConditions = [
    ...baseConditions,
    "recorded_at >= datetime('now', '-14 days')",
    "recorded_at < datetime('now', '-7 days')",
  ];
  const prevWeekWhere = `WHERE ${prevWeekConditions.join(' AND ')}`;
  const prevWeekRow = db
    .prepare(`SELECT COUNT(*) AS n FROM agent_metrics ${prevWeekWhere}`)
    .get(...baseParams) as { n: number };

  const wowDelta =
    prevWeekRow.n === 0
      ? null
      : Math.round(((curWeekRow.n - prevWeekRow.n) / prevWeekRow.n) * 1000) / 10;

  // --- samples.top_durations (omitted when summary_only) ---
  let samples: Record<string, unknown> | undefined;
  if (!summaryOnly) {
    // Top 10 longest-running invocations across the filter window. Useful
    // for spotting outlier slow calls without scrolling the full _query
    // surface.
    const topDurSql = `SELECT id, project, agent, action, duration_ms, recorded_at, brief_id, result
                       FROM agent_metrics
                       ${baseWhere}
                       ORDER BY duration_ms DESC, recorded_at DESC
                       LIMIT 10`;
    const topDurations = db.prepare(topDurSql).all(...baseParams) as Record<string, unknown>[];
    samples = { top_durations: topDurations };
  }

  const result: Record<string, unknown> = {
    totals: {
      total_invocations: totalRow.n,
      by_agent: byAgent,
      by_action: byAction,
      by_result: byResult,
    },
    recent: {
      last_n_days: days,
      invocations: recentRow.n,
      week_over_week_delta_pct: wowDelta,
    },
  };
  if (!summaryOnly) {
    result.samples = samples;
  }
  if (projectFilter) {
    result.project = projectFilter;
  }
  if (agentFilter) {
    result.agent = agentFilter;
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

export { handleMetricsRecord, handleMetricsQuery, handleMetricsVelocity, handleMetricsDashboard };
export type { MetricsRecordInput, MetricsQueryInput, MetricsVelocityInput, MetricsDashboardInput };
