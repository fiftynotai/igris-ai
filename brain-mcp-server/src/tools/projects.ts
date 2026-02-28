/**
 * Igris Brain — Project Tools
 *
 * Provides project registration, listing, and status dashboards.
 * Projects are registered in the brain's SQLite database and tracked
 * across sessions.
 *
 * Tools:
 * - igris_project_register: Register a project in the brain
 * - igris_project_list: List all registered projects
 * - igris_project_status: Get detailed project status dashboard
 *
 * @module tools/projects
 * @author Fifty.ai
 */

import { getDb } from '../db.js';

/** Input shape for igris_project_register */
interface ProjectRegisterInput {
  slug: string;
  name: string;
  path: string;
  tech_stack?: string;
}

/** Input shape for igris_project_list */
interface ProjectListInput {
  status?: 'active' | 'archived' | 'inactive';
}

/** Input shape for igris_project_status */
interface ProjectStatusInput {
  slug: string;
}

/**
 * Register a project in the brain.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE to safely upsert without
 * destroying columns not included in the INSERT.
 * Automatically updates last_session_at to the current timestamp.
 *
 * @param args - Project registration data
 * @returns MCP-formatted response with the project record
 */
function handleProjectRegister(args: ProjectRegisterInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  db.prepare(`
    INSERT INTO projects (slug, name, path, tech_stack, last_session_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      tech_stack = excluded.tech_stack,
      last_session_at = excluded.last_session_at
  `).run(args.slug, args.name, args.path, args.tech_stack ?? '');

  const project = db.prepare(
    'SELECT * FROM projects WHERE slug = ?'
  ).get(args.slug) as Record<string, unknown>;

  return {
    content: [{
      type: 'text',
      text: [
        'Project registered successfully.',
        '',
        `Slug: ${project.slug}`,
        `Name: ${project.name}`,
        `Path: ${project.path}`,
        `Tech Stack: ${project.tech_stack || '(none)'}`,
        `Status: ${project.status}`,
        `Registered: ${project.registered_at}`,
        `Last Session: ${project.last_session_at}`,
      ].join('\n'),
    }],
  };
}

/**
 * List all registered projects, optionally filtered by status.
 *
 * @param args - Optional status filter
 * @returns MCP-formatted response with project list
 */
function handleProjectList(args: ProjectListInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  let sql = 'SELECT slug, name, path, tech_stack, status, last_session_at FROM projects';
  const params: string[] = [];

  if (args.status) {
    sql += ' WHERE status = ?';
    params.push(args.status);
  }

  sql += ' ORDER BY last_session_at DESC';

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  if (rows.length === 0) {
    const filterMsg = args.status ? ` with status "${args.status}"` : '';
    return {
      content: [{
        type: 'text',
        text: `No projects found${filterMsg}.`,
      }],
    };
  }

  const header = '| Slug | Name | Path | Status | Last Session |';
  const separator = '|------|------|------|--------|--------------|';
  const tableRows = rows.map(row =>
    `| ${row.slug} | ${row.name} | ${row.path} | ${row.status} | ${row.last_session_at || 'Never'} |`
  );

  return {
    content: [{
      type: 'text',
      text: `# Registered Projects\n\nFound ${rows.length} project(s)\n\n${header}\n${separator}\n${tableRows.join('\n')}`,
    }],
  };
}

/**
 * Get detailed status dashboard for a specific project.
 *
 * Includes project record, learning count, error count, and
 * the 10 most recent agent metrics.
 *
 * @param args - Project slug to query
 * @returns MCP-formatted response with combined status dashboard
 */
function handleProjectStatus(args: ProjectStatusInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  // Get project record
  const project = db.prepare(
    'SELECT * FROM projects WHERE slug = ?'
  ).get(args.slug) as Record<string, unknown> | undefined;

  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `Project "${args.slug}" not found. Use igris_project_register to register it first.`,
      }],
    };
  }

  // Count learnings
  const learningCount = db.prepare(
    'SELECT COUNT(*) as count FROM learnings WHERE project = ?'
  ).get(args.slug) as { count: number };

  // Count errors
  const errorCount = db.prepare(
    'SELECT COUNT(*) as count FROM errors WHERE project = ?'
  ).get(args.slug) as { count: number };

  // Get recent agent metrics
  const recentMetrics = db.prepare(`
    SELECT agent, action, result, duration_ms, brief_id, recorded_at
    FROM agent_metrics
    WHERE project = ?
    ORDER BY recorded_at DESC
    LIMIT 10
  `).all(args.slug) as Record<string, unknown>[];

  // Format metrics
  let metricsSection: string;
  if (recentMetrics.length === 0) {
    metricsSection = '(no metrics recorded)';
  } else {
    metricsSection = recentMetrics.map((m, i) =>
      `  ${i + 1}. [${m.recorded_at}] ${m.agent}/${m.action} -> ${m.result}${m.duration_ms ? ` (${m.duration_ms}ms)` : ''}${m.brief_id ? ` [${m.brief_id}]` : ''}`
    ).join('\n');
  }

  const dashboard = [
    `# Project Status: ${args.slug}`,
    '',
    '## Project Info',
    `Name: ${project.name}`,
    `Path: ${project.path}`,
    `Tech Stack: ${project.tech_stack || '(none)'}`,
    `Status: ${project.status}`,
    `Igris Version: ${project.igris_version}`,
    `Registered: ${project.registered_at}`,
    `Last Session: ${project.last_session_at || 'Never'}`,
    '',
    '## Knowledge Base',
    `Learnings: ${learningCount.count}`,
    `Errors: ${errorCount.count}`,
    '',
    '## Recent Agent Metrics (last 10)',
    metricsSection,
  ].join('\n');

  return {
    content: [{
      type: 'text',
      text: dashboard,
    }],
  };
}

// ---------------------------------------------------------------------------
// Budget tracking
// ---------------------------------------------------------------------------

/** Input shape for handleProjectBudget */
interface ProjectBudgetInput {
  slug: string;
}

/** Input shape for handleProjectBudgetSet */
interface ProjectBudgetSetInput {
  slug: string;
  budget_limit: number;
  budget_period?: string;
}

/** Per-agent token aggregation row */
interface AgentTokenRow {
  agent: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_create: number;
  event_count: number;
}

/**
 * Get per-project budget and token usage summary.
 *
 * Aggregates token consumption from agent_events (stop events only)
 * over the last 30 days, grouped by agent. Also reads any budget
 * configuration stored in the project's metadata JSON.
 *
 * @param args - Project slug to query
 * @returns Budget config, per-agent token breakdown, and totals
 */
function handleProjectBudget(args: ProjectBudgetInput): {
  project_slug: string;
  period: string;
  budget_limit: number | null;
  by_agent: AgentTokenRow[];
  totals: {
    input_tokens: number;
    output_tokens: number;
    cache_read: number;
    cache_create: number;
    event_count: number;
  };
} {
  const db = getDb();

  // Aggregate tokens per agent for the project (last 30 days, stop events)
  const agentRows = db.prepare(`
    SELECT
      ae.agent,
      SUM(ae.input_tokens) as input_tokens,
      SUM(ae.output_tokens) as output_tokens,
      SUM(ae.cache_read) as cache_read,
      SUM(ae.cache_create) as cache_create,
      COUNT(*) as event_count
    FROM agent_events ae
    LEFT JOIN instances i ON ae.instance_id = i.id
    WHERE i.project_slug = ?
      AND ae.event_type = 'stop'
      AND ae.created_at >= datetime('now', '-30 days')
    GROUP BY ae.agent
    ORDER BY input_tokens DESC
  `).all(args.slug) as AgentTokenRow[];

  // Read budget config from project metadata
  const projectRow = db.prepare(
    `SELECT metadata FROM projects WHERE slug = ?`
  ).get(args.slug) as { metadata: string } | undefined;

  let budgetLimit: number | null = null;
  let budgetPeriod = 'monthly';

  if (projectRow?.metadata) {
    try {
      const meta = JSON.parse(projectRow.metadata);
      if (typeof meta.budget_limit === 'number') {
        budgetLimit = meta.budget_limit;
      }
      if (typeof meta.budget_period === 'string') {
        budgetPeriod = meta.budget_period;
      }
    } catch {
      // metadata is not valid JSON — ignore
    }
  }

  // Compute totals
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_create: 0,
    event_count: 0,
  };

  for (const row of agentRows) {
    totals.input_tokens += row.input_tokens ?? 0;
    totals.output_tokens += row.output_tokens ?? 0;
    totals.cache_read += row.cache_read ?? 0;
    totals.cache_create += row.cache_create ?? 0;
    totals.event_count += row.event_count ?? 0;
  }

  return {
    project_slug: args.slug,
    period: budgetPeriod,
    budget_limit: budgetLimit,
    by_agent: agentRows,
    totals,
  };
}

/**
 * Set or update budget configuration for a project.
 *
 * Stores budget_limit and budget_period in the project's metadata JSON
 * using SQLite's json_set function.
 *
 * @param args - Project slug, budget limit, and optional period
 * @returns Updated budget configuration
 */
function handleProjectBudgetSet(args: ProjectBudgetSetInput): {
  project_slug: string;
  budget_limit: number;
  budget_period: string;
  updated: boolean;
} {
  const db = getDb();

  const period = args.budget_period ?? 'monthly';

  const result = db.prepare(`
    UPDATE projects
    SET metadata = json_set(COALESCE(metadata, '{}'), '$.budget_limit', ?, '$.budget_period', ?)
    WHERE slug = ?
  `).run(args.budget_limit, period, args.slug);

  return {
    project_slug: args.slug,
    budget_limit: args.budget_limit,
    budget_period: period,
    updated: result.changes > 0,
  };
}

export { handleProjectRegister, handleProjectList, handleProjectStatus, handleProjectBudget, handleProjectBudgetSet };
export type { ProjectRegisterInput, ProjectListInput, ProjectStatusInput, ProjectBudgetInput, ProjectBudgetSetInput };
