/**
 * Igris Brain -- Brief Tools
 *
 * Provides cross-project brief status tracking and dashboard.
 * Brief status is synced during /hunt, /rest, and /archive to
 * enable portfolio-wide brief visibility.
 *
 * Tools:
 * - igris_brief_sync: Store brief status change
 * - igris_brief_dashboard: Cross-project brief dashboard
 *
 * @module tools/briefs
 * @author Fifty.ai
 */

import { getDb } from '../db.js';

/** Input shape for igris_brief_sync */
interface BriefSyncInput {
  project: string;
  brief_id: string;
  brief_type?: string;
  title: string;
  status: string;
  priority?: string;
  effort?: string;
  phase?: string;
}

/** Input shape for igris_brief_dashboard */
interface BriefDashboardInput {
  status?: string;
  project?: string;
}

/**
 * Sync a brief status change to the brain.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE to maintain one record per
 * project+brief_id without destroying columns not in the INSERT.
 * Called when brief status changes during /hunt, /rest, or /archive.
 *
 * @param args - Brief status data to sync
 * @returns MCP-formatted response confirming the sync
 */
function handleBriefSync(args: BriefSyncInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  db.prepare(`
    INSERT INTO brief_status
      (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project, brief_id) DO UPDATE SET
      brief_type = excluded.brief_type,
      title = excluded.title,
      status = excluded.status,
      priority = excluded.priority,
      effort = excluded.effort,
      phase = excluded.phase,
      updated_at = excluded.updated_at
  `).run(
    args.project,
    args.brief_id,
    args.brief_type ?? null,
    args.title,
    args.status,
    args.priority ?? null,
    args.effort ?? null,
    args.phase ?? null
  );

  return {
    content: [{
      type: 'text',
      text: [
        'Brief status synced successfully.',
        '',
        `Project: ${args.project}`,
        `Brief: ${args.brief_id}`,
        `Title: ${args.title}`,
        `Status: ${args.status}`,
        args.priority ? `Priority: ${args.priority}` : null,
        args.effort ? `Effort: ${args.effort}` : null,
        args.phase ? `Phase: ${args.phase}` : null,
      ].filter(Boolean).join('\n'),
    }],
  };
}

/**
 * Display a cross-project brief dashboard.
 *
 * Shows all tracked briefs with status counts. Supports filtering
 * by status and project.
 *
 * @param args - Optional filters for status and project
 * @returns MCP-formatted response with dashboard
 */
function handleBriefDashboard(args: BriefDashboardInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  // Build WHERE clause for main query
  const conditions: string[] = [];
  const params: string[] = [];

  if (args.status) {
    conditions.push('bs.status = ?');
    params.push(args.status);
  }
  if (args.project) {
    conditions.push('bs.project = ?');
    params.push(args.project);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Query briefs
  const rows = db.prepare(`
    SELECT bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
           bs.priority, bs.effort, bs.phase, bs.updated_at,
           p.name as project_name
    FROM brief_status bs
    LEFT JOIN projects p ON p.slug = bs.project
    ${whereClause}
    ORDER BY bs.updated_at DESC
  `).all(...params) as Record<string, unknown>[];

  // Summary counts (project filter only, not status filter)
  const summaryConditions: string[] = [];
  const summaryParams: string[] = [];
  if (args.project) {
    summaryConditions.push('project = ?');
    summaryParams.push(args.project);
  }
  const summaryWhere = summaryConditions.length > 0 ? `WHERE ${summaryConditions.join(' AND ')}` : '';

  const summaryCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM brief_status
    ${summaryWhere}
    GROUP BY status
    ORDER BY count DESC
  `).all(...summaryParams) as Record<string, unknown>[];

  if (rows.length === 0 && summaryCounts.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No briefs tracked. Brief status is synced when briefs change status during /hunt, /rest, or /archive.',
      }],
    };
  }

  // Format summary
  const summaryLines = summaryCounts.map(s => `- ${s.status}: ${s.count}`);

  // Format table
  const header = '| Project | Brief | Type | Title | Status | Priority | Phase | Updated |';
  const separator = '|---------|-------|------|-------|--------|----------|-------|---------|';
  const tableRows = rows.map(r =>
    `| ${r.project_name || r.project} | ${r.brief_id} | ${r.brief_type || '-'} | ${r.title} | ${r.status} | ${r.priority || '-'} | ${r.phase || '-'} | ${r.updated_at} |`
  );

  // Build filter description
  const filters: string[] = [];
  if (args.status) filters.push(`status=${args.status}`);
  if (args.project) filters.push(`project=${args.project}`);
  const filterDesc = filters.length > 0 ? ` (filtered: ${filters.join(', ')})` : '';

  return {
    content: [{
      type: 'text',
      text: [
        `# Cross-Project Brief Dashboard${filterDesc}`,
        '',
        '## Summary',
        ...summaryLines,
        '',
        `## Briefs (${rows.length})`,
        header,
        separator,
        ...tableRows,
      ].join('\n'),
    }],
  };
}

export { handleBriefSync, handleBriefDashboard };
export type { BriefSyncInput, BriefDashboardInput };
