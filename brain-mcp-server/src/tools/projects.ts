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
 * Uses INSERT OR REPLACE to handle both new registrations and updates.
 * Automatically updates last_session_at to the current timestamp.
 *
 * @param args - Project registration data
 * @returns MCP-formatted response with the project record
 */
function handleProjectRegister(args: ProjectRegisterInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  db.prepare(`
    INSERT OR REPLACE INTO projects (slug, name, path, tech_stack, last_session_at)
    VALUES (?, ?, ?, ?, datetime('now'))
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

export { handleProjectRegister, handleProjectList, handleProjectStatus };
export type { ProjectRegisterInput, ProjectListInput, ProjectStatusInput };
