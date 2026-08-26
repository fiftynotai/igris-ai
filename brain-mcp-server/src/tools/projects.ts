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
 * - igris_project_update: Partial UPDATE of an existing project record (TD-171 M3)
 * - igris_project_dashboard: Unified per-project / cross-project view (TD-171 M3)
 *
 * @module tools/projects
 * @author fifty.dev
 */

import { existsSync, realpathSync } from 'node:fs';

import { getDb } from '../db.js';

/** Input shape for igris_project_register */
interface ProjectRegisterInput {
  slug: string;
  name: string;
  path: string;
  tech_stack?: string;
  archetype?: string;
}

/** Input shape for igris_project_list */
interface ProjectListInput {
  status?: 'active' | 'archived' | 'inactive';
}

/** Input shape for igris_project_status */
interface ProjectStatusInput {
  slug: string;
}

/** Input shape for igris_project_update (TD-171 M3) */
interface ProjectUpdateInput {
  slug: string;
  name?: string;
  path?: string;
  tech_stack?: string;
  archetype?: string;
  status?: 'active' | 'archived' | 'inactive';
}

/** Input shape for igris_project_dashboard (TD-171 M3 — operator override 2026-05-15) */
interface ProjectDashboardInput {
  /** When set, returns single-project detail view (replaces igris_project_status use case). */
  slug?: string;
  /** Cross-project filter — omit for all statuses. Ignored when `slug` is set. */
  status?: 'active' | 'archived' | 'inactive';
  /** Cross-project filter (e.g., "ai-agent-system"). Ignored when `slug` is set. */
  archetype?: string;
  /** Cross-project filter — substring match on tech_stack column. Ignored when `slug` is set. */
  tech_stack?: string;
  /** Join brief counts per project. Default true. */
  include_briefs?: boolean;
  /** Join last_session_at per project. Default true. */
  include_last_session?: boolean;
  /** Counts only, no per-project rows. Default false. */
  summary_only?: boolean;
  /** Time window for "recent" stats. Default 30. */
  days?: number;
}

/**
 * Resolve a path for identity comparison.
 *
 * Falls back to the raw string when `realpathSync` throws — which it does for a
 * path that does not exist on disk, so a missing directory compares by string
 * rather than dropping out of the comparison entirely.
 */
function resolveForCompare(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The `projects` row OTHER THAN `slug` whose path resolves to the same directory
 * as `path`, or `undefined` when the directory is free (the return value is
 * `Array.prototype.find`'s, so it is `undefined` and never `null`).
 *
 * ONE DEFINITION, TWO CALLERS, on purpose (TD-402 retry 1). Both writes in this
 * module that can set `projects.path` ask this same question, so the predicate
 * cannot drift between them: `handleProjectRegister` before its upsert and
 * `handleProjectUpdate` before its UPDATE. Excluding `slug` itself is what keeps
 * a same-slug re-registration an upsert and lets a row re-set its own path.
 *
 * Note the comparison is `realpathSync`-resolved on BOTH sides, so a symlink and
 * its target are one directory; `resolveForCompare` falls back to the raw string
 * for a path that does not exist, so a machine that lacks the directory still
 * compares.
 */
function findPathHolder(
  db: ReturnType<typeof getDb>,
  slug: string,
  path: string,
): { slug: string; path: string } | undefined {
  const incoming = resolveForCompare(path);
  const others = db
    .prepare('SELECT slug, path FROM projects WHERE slug != ?')
    .all(slug) as { slug: string; path: string }[];
  return others.find((r) => resolveForCompare(r.path) === incoming);
}

/**
 * Register a project in the brain.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE to safely upsert without
 * destroying columns not included in the INSERT.
 * Automatically updates last_session_at to the current timestamp.
 *
 * Refuses when a DIFFERENT slug already holds the same resolved path (TD-402).
 * Same-slug re-registration stays an upsert — that is `/boot`'s per-session
 * refresh.
 *
 * OTHER WRITERS EXIST AND DO NOT REFUSE. This handler and `handleProjectUpdate`
 * are not the only paths that can set `projects.path`. The census, how to
 * DERIVE it, and its limits live in MAINTAINING.md's BR-080 strict-input row (row 113), in its Notes cell —
 * derive it there, never recall it.
 * `igris doctor`'s `duplicate-path` class is the writer-agnostic detector: it
 * reads STATE, so it reports a duplicate whoever minted it.
 *
 * SCOPE — SOURCE, NOT RUNTIME. This refusal is in source as of TD-402 and is
 * NOT in the compiled bundle: `findPathHolder` appears 0 times in
 * `brain-mcp-server/dist/` and in `cli/dist/brain-mcp-server/dist/` (measured
 * 2026-08-17, both stale builds that still carry `handleProjectRegister`). It
 * takes effect at the next bundle rebuild. Until then this path can still mint
 * a duplicate, which is a second route into TD-404's hazard.
 *
 * @param args - Project registration data
 * @returns MCP-formatted response with the project record
 */
function handleProjectRegister(args: ProjectRegisterInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  const holder = findPathHolder(db, args.slug, args.path);
  if (holder) {
    return {
      content: [{
        type: 'text',
        text: [
          `Error: path already registered under slug "${holder.slug}".`,
          '',
          `Requested slug: ${args.slug}`,
          `Requested path: ${args.path}`,
          `Resolved path:  ${resolveForCompare(args.path)}`,
          `Held by:        ${holder.slug} (${holder.path})`,
          '',
          'One directory gets ONE project row. The slug is basename(realpath(project_root))',
          'verbatim — no case change, no -/_ normalisation, no substitution of a package name.',
          // Deliberately NOT "use igris_project_update to point this slug at the
          // path": that tool can set `path`, and until TD-402 retry 1 it did so
          // unchecked, so the message was recommending its own bypass. It now
          // refuses the same duplicate, which is why the remedies below are the
          // only two that exist.
          `Remedies, and there are two: correct the existing "${holder.slug}" row with`,
          'igris_project_update (name, path, tech_stack, archetype, status — a path a THIRD',
          'slug holds is refused there the same way), or register a different path. The slug',
          'itself is not updatable: it is derived from the directory name, so a wrong slug is',
          'a row to remove and re-register, not a field to edit.',
        ].join('\n'),
      }],
    };
  }

  const pathMissing = !existsSync(args.path);

  db.prepare(`
    INSERT INTO projects (slug, name, path, tech_stack, archetype, last_session_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      tech_stack = excluded.tech_stack,
      archetype = COALESCE(excluded.archetype, projects.archetype),
      last_session_at = excluded.last_session_at
  `).run(args.slug, args.name, args.path, args.tech_stack ?? '', args.archetype ?? null);

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
        `Archetype: ${project.archetype || 'unclassified'}`,
        `Status: ${project.status}`,
        `Registered: ${project.registered_at}`,
        `Last Session: ${project.last_session_at}`,
        ...(pathMissing
          ? ['', `Warning: path does not exist on this machine: ${args.path}`,
            'The row was written anyway (paths are machine-dependent). `igris doctor` reports this as path-missing.']
          : []),
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

  // Recent agent invocations. FR-267: read from the agent_events hunt-cost
  // record (the retired metrics table is frozen history, unread); `project` is stamped on
  // the row at write time, so no join to `instances` (removed on /rest).
  const recentMetrics = db.prepare(`
    SELECT agent, event_type, phase, result, duration_ms, brief_id, round, model_requested, created_at
    FROM agent_events
    WHERE project = ? AND event_type IN ('stop', 'error')
    ORDER BY created_at DESC
    LIMIT 10
  `).all(args.slug) as Record<string, unknown>[];

  // Format invocations
  let metricsSection: string;
  if (recentMetrics.length === 0) {
    metricsSection = '(no agent events recorded)';
  } else {
    metricsSection = recentMetrics.map((m, i) =>
      `  ${i + 1}. [${m.created_at}] ${m.agent}/${m.event_type}${m.phase ? ` ${m.phase}` : ''} -> ${m.result ?? '-'}${m.duration_ms ? ` (${m.duration_ms}ms)` : ''}${m.brief_id ? ` [${m.brief_id}]` : ''}${m.model_requested ? ` model=${m.model_requested}` : ''}`
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
    '## Recent Agent Invocations (last 10)',
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
// igris_project_update (TD-171 M3)
// ---------------------------------------------------------------------------

/**
 * Subset of ProjectUpdateInput fields that may be UPDATEd via this handler.
 *
 * `path` is in this list, which is why `handleProjectUpdate` carries the same
 * duplicate-path refusal as `handleProjectRegister` — see the DECISION comment
 * in that handler.
 */
const PROJECT_UPDATABLE_FIELDS = [
  'name',
  'path',
  'tech_stack',
  'archetype',
  'status',
] as const;

const PROJECT_VALID_STATUSES = ['active', 'archived', 'inactive'] as const;

/**
 * Partial UPDATE of an existing project record.
 *
 * Mirrors `handleProjectRegister`'s upsert semantics but rejects on missing
 * slug instead of inserting. Only the fields explicitly present in `args`
 * are written — omitted fields retain their existing values. Returns the
 * list of fields actually updated for caller observability.
 *
 * @param args - Partial project record (slug required, at least one optional field)
 * @returns MCP-formatted response with the updated field list
 */
function handleProjectUpdate(args: ProjectUpdateInput): { content: { type: string; text: string }[] } {
  if (!args.slug || typeof args.slug !== 'string') {
    return {
      content: [{ type: 'text', text: 'Error: slug is required' }],
    };
  }

  const db = getDb();

  const existing = db
    .prepare('SELECT slug FROM projects WHERE slug = ?')
    .get(args.slug) as { slug: string } | undefined;
  if (!existing) {
    return {
      content: [{
        type: 'text',
        text: `Error: project "${args.slug}" not found. Use igris_project_register to create it first.`,
      }],
    };
  }

  // TD-402 — duplicate-path refusal on the UPDATE path too.
  //
  // Guarded here because the register refusal's own message names this tool as
  // the remedy, and `PROJECT_UPDATABLE_FIELDS` includes `path` — so before this,
  // the guard advertised its own bypass. Measured: an unguarded
  // `handleProjectUpdate({slug:'other', path:<a dir another slug held>})`
  // returned `{"updated_fields":["path"]}` and left two rows on one directory.
  //
  // The self-exclusion is load-bearing at both callers: mutating it out reds
  // exactly one test per caller.
  //
  // Bounded: the other writers still do not refuse, and this is source-only
  // until the bundle is rebuilt. See MAINTAINING.md's BR-080 strict-input row (row 113), in its Notes cell and
  // TD-404 (INSERT branch now refused; UPDATE branch and push side open).
  if (args.path !== undefined && typeof args.path === 'string') {
    const holder = findPathHolder(db, args.slug, args.path);
    if (holder) {
      return {
        content: [{
          type: 'text',
          text: [
            `Error: path already registered under slug "${holder.slug}".`,
            '',
            `Requested slug: ${args.slug}`,
            `Requested path: ${args.path}`,
            `Resolved path:  ${resolveForCompare(args.path)}`,
            `Held by:        ${holder.slug} (${holder.path})`,
            '',
            'One directory gets ONE project row (TD-402). No field was written — this',
            'refusal precedes the UPDATE, so the other fields in this call were not',
            'applied either. Re-send them without `path`, or free the directory first.',
          ].join('\n'),
        }],
      };
    }
  }

  // Validate status if present.
  if (args.status !== undefined) {
    if (!PROJECT_VALID_STATUSES.includes(args.status as typeof PROJECT_VALID_STATUSES[number])) {
      return {
        content: [{
          type: 'text',
          text: `Error: invalid status "${args.status}". Allowed: ${PROJECT_VALID_STATUSES.join(', ')}`,
        }],
      };
    }
  }

  // Build SET clauses only for fields present in args.
  const setClauses: string[] = [];
  const params: unknown[] = [];
  const updatedFields: string[] = [];

  for (const field of PROJECT_UPDATABLE_FIELDS) {
    const value = (args as unknown as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      return {
        content: [{
          type: 'text',
          text: `Error: field "${field}" must be a string`,
        }],
      };
    }
    setClauses.push(`${field} = ?`);
    params.push(value);
    updatedFields.push(field);
  }

  if (setClauses.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'Error: no updatable fields provided. Pass at least one of: name, path, tech_stack, archetype, status.',
      }],
    };
  }

  params.push(args.slug);
  db.prepare(`UPDATE projects SET ${setClauses.join(', ')} WHERE slug = ?`).run(...params);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ slug: args.slug, updated_fields: updatedFields }, null, 2),
    }],
  };
}

// ---------------------------------------------------------------------------
// igris_project_dashboard (TD-171 M3 — operator override 2026-05-15)
// ---------------------------------------------------------------------------

/**
 * Unified project dashboard.
 *
 * Single filterable tool that subsumes the historic `_status` (single-project
 * detail) and `_list` (cross-project listing) patterns:
 *
 *   - When `slug` is set → single-project detail view. Mirrors
 *     `handleProjectStatus`'s shape and ALSO emits a `recent` block
 *     (sessions / brief completions in the last `days` window).
 *   - When `slug` omitted → cross-project view filtered by `status` /
 *     `archetype` / `tech_stack`. Returns the canonical TD-171 dashboard
 *     shape: `{ totals, projects, recent }`.
 *
 * `summary_only: true` collapses the per-project rows (cross-project mode)
 * or the recent metrics list (single-project mode) — counts are still
 * computed.
 *
 * Defaults: `include_briefs=true`, `include_last_session=true`, `days=30`.
 *
 * Per L-152, this dashboard concerns the projects channel only. Perception
 * and subconscious aggregations belong to their own dashboards.
 */
function handleProjectDashboard(args: ProjectDashboardInput): { content: { type: string; text: string }[] } {
  const days = args.days !== undefined ? Number(args.days) : 30;
  if (!Number.isFinite(days) || days < 0) {
    return { content: [{ type: 'text', text: 'Error: days must be a non-negative number' }] };
  }
  const summaryOnly = args.summary_only === true;
  const includeBriefs = args.include_briefs !== false; // default true
  const includeLastSession = args.include_last_session !== false; // default true

  const db = getDb();

  // -------------------------------------------------------------------------
  // Single-project mode (slug set)
  // -------------------------------------------------------------------------
  if (typeof args.slug === 'string' && args.slug.length > 0) {
    const project = db
      .prepare('SELECT * FROM projects WHERE slug = ?')
      .get(args.slug) as Record<string, unknown> | undefined;
    if (!project) {
      return {
        content: [{
          type: 'text',
          text: `Error: project "${args.slug}" not found.`,
        }],
      };
    }

    const learningCount = db
      .prepare('SELECT COUNT(*) AS n FROM learnings WHERE project = ?')
      .get(args.slug) as { n: number };
    const errorCount = db
      .prepare('SELECT COUNT(*) AS n FROM errors WHERE project = ?')
      .get(args.slug) as { n: number };

    let briefCounts: { total: number; by_status: Record<string, number> } | undefined;
    if (includeBriefs) {
      try {
        const briefRows = db
          .prepare('SELECT status, COUNT(*) AS n FROM brief_status WHERE project = ? GROUP BY status')
          .all(args.slug) as { status: string; n: number }[];
        const byStatus: Record<string, number> = {};
        let totalBriefs = 0;
        for (const r of briefRows) {
          byStatus[r.status] = r.n;
          totalBriefs += r.n;
        }
        briefCounts = { total: totalBriefs, by_status: byStatus };
      } catch {
        // brief_status table absent (test fixtures, fresh DB) — skip silently.
        briefCounts = undefined;
      }
    }

    // recent: sessions + brief completions in last `days` window.
    let recentSessions = 0;
    let recentBriefCompletions = 0;
    try {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sessions
           WHERE project = ? AND ended_at IS NOT NULL
             AND ended_at >= datetime('now', ?)`,
        )
        .get(args.slug, `-${days} days`) as { n: number };
      recentSessions = r.n;
    } catch {
      // sessions table absent — leave at 0.
    }
    try {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM brief_status
           WHERE project = ? AND status IN ('Done', 'Completed', 'Closed')
             AND COALESCE(updated_at, created_at) >= datetime('now', ?)`,
        )
        .get(args.slug, `-${days} days`) as { n: number };
      recentBriefCompletions = r.n;
    } catch {
      // brief_status table absent — leave at 0.
    }

    // FR-267: `recent_metrics` keeps its TD-171 key name but is read from the
    // agent_events hunt-cost record (the retired metrics table is frozen history, unread);
    // `project` is stamped on the row at write time — no `instances` join.
    let recentMetrics: Record<string, unknown>[] = [];
    if (!summaryOnly) {
      try {
        recentMetrics = db
          .prepare(
            `SELECT agent, event_type, phase, result, duration_ms, brief_id, round, model_requested, created_at
             FROM agent_events
             WHERE project = ? AND event_type IN ('stop', 'error')
             ORDER BY created_at DESC
             LIMIT 10`,
          )
          .all(args.slug) as Record<string, unknown>[];
      } catch {
        recentMetrics = [];
      }
    }

    const result: Record<string, unknown> = {
      mode: 'single',
      project: {
        slug: project.slug,
        name: project.name,
        path: project.path,
        tech_stack: project.tech_stack ?? '',
        archetype: project.archetype ?? 'unclassified',
        status: project.status,
        igris_version: project.igris_version,
        registered_at: project.registered_at,
        last_session_at: includeLastSession ? (project.last_session_at ?? null) : undefined,
      },
      totals: {
        learnings: learningCount.n,
        errors: errorCount.n,
        briefs: briefCounts ?? null,
      },
      recent: {
        last_n_days: days,
        sessions: recentSessions,
        brief_completions: recentBriefCompletions,
      },
    };
    if (!summaryOnly) {
      result.recent_metrics = recentMetrics;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  // -------------------------------------------------------------------------
  // Cross-project mode (slug omitted)
  // -------------------------------------------------------------------------

  const filters: string[] = [];
  const filterParams: unknown[] = [];

  if (args.status !== undefined) {
    if (!PROJECT_VALID_STATUSES.includes(args.status as typeof PROJECT_VALID_STATUSES[number])) {
      return {
        content: [{
          type: 'text',
          text: `Error: invalid status "${args.status}". Allowed: ${PROJECT_VALID_STATUSES.join(', ')}`,
        }],
      };
    }
    filters.push('status = ?');
    filterParams.push(args.status);
  }
  if (args.archetype !== undefined) {
    filters.push('archetype = ?');
    filterParams.push(args.archetype);
  }
  if (args.tech_stack !== undefined) {
    // Substring match — tech_stack is a comma-separated string column.
    filters.push('tech_stack LIKE ?');
    filterParams.push(`%${args.tech_stack}%`);
  }

  const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  // --- totals.total ---
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM projects ${whereSql}`)
    .get(...filterParams) as { n: number };

  // --- totals.by_status ---
  // Always grouped over the full filtered set (e.g., user filtered by
  // archetype but still wants to see status breakdown across that slice).
  const byStatusRows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM projects ${whereSql} GROUP BY status`)
    .all(...filterParams) as { status: string; n: number }[];
  const byStatus: Record<string, number> = { active: 0, archived: 0, inactive: 0 };
  for (const r of byStatusRows) byStatus[r.status] = r.n;

  // --- totals.by_archetype ---
  const byArchetypeRows = db
    .prepare(`SELECT archetype, COUNT(*) AS n FROM projects ${whereSql} GROUP BY archetype`)
    .all(...filterParams) as { archetype: string | null; n: number }[];
  const byArchetype: Record<string, number> = {};
  for (const r of byArchetypeRows) {
    byArchetype[r.archetype ?? 'unclassified'] = r.n;
  }

  // --- totals.by_tech_stack ---
  // tech_stack is a comma-separated string. Split per row, count token
  // membership across the filtered set.
  const techRows = db
    .prepare(`SELECT tech_stack FROM projects ${whereSql}`)
    .all(...filterParams) as { tech_stack: string | null }[];
  const byTechStack: Record<string, number> = {};
  for (const r of techRows) {
    if (!r.tech_stack) continue;
    const tokens = r.tech_stack.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
    for (const t of tokens) {
      byTechStack[t] = (byTechStack[t] ?? 0) + 1;
    }
  }

  // --- recent: sessions + brief completions across all matching projects ---
  let recentSessions = 0;
  let recentBriefCompletions = 0;
  // Reuse the matching-project slugs to scope the recent counters. If the
  // project filter is empty the set is "all projects" so no extra IN-clause
  // is needed.
  if (filters.length === 0) {
    try {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sessions
           WHERE ended_at IS NOT NULL AND ended_at >= datetime('now', ?)`,
        )
        .get(`-${days} days`) as { n: number };
      recentSessions = r.n;
    } catch {
      recentSessions = 0;
    }
    try {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM brief_status
           WHERE status IN ('Done', 'Completed', 'Closed')
             AND COALESCE(updated_at, created_at) >= datetime('now', ?)`,
        )
        .get(`-${days} days`) as { n: number };
      recentBriefCompletions = r.n;
    } catch {
      recentBriefCompletions = 0;
    }
  } else {
    // Filtered: select matching slugs, then scope the counters.
    const slugRows = db
      .prepare(`SELECT slug FROM projects ${whereSql}`)
      .all(...filterParams) as { slug: string }[];
    const slugs = slugRows.map((r) => r.slug);
    if (slugs.length > 0) {
      const placeholders = slugs.map(() => '?').join(',');
      try {
        const r = db
          .prepare(
            `SELECT COUNT(*) AS n FROM sessions
             WHERE project IN (${placeholders}) AND ended_at IS NOT NULL
               AND ended_at >= datetime('now', ?)`,
          )
          .get(...slugs, `-${days} days`) as { n: number };
        recentSessions = r.n;
      } catch {
        recentSessions = 0;
      }
      try {
        const r = db
          .prepare(
            `SELECT COUNT(*) AS n FROM brief_status
             WHERE project IN (${placeholders}) AND status IN ('Done', 'Completed', 'Closed')
               AND COALESCE(updated_at, created_at) >= datetime('now', ?)`,
          )
          .get(...slugs, `-${days} days`) as { n: number };
        recentBriefCompletions = r.n;
      } catch {
        recentBriefCompletions = 0;
      }
    }
  }

  // --- per-project rows (omitted when summary_only) ---
  const result: Record<string, unknown> = {
    mode: 'cross',
    totals: {
      total: totalRow.n,
      by_status: byStatus,
      by_archetype: byArchetype,
      by_tech_stack: byTechStack,
    },
    recent: {
      last_n_days: days,
      sessions: recentSessions,
      brief_completions: recentBriefCompletions,
    },
  };

  if (!summaryOnly) {
    const selectFields = [
      'slug',
      'name',
      'path',
      'tech_stack',
      'archetype',
      'status',
      'registered_at',
    ];
    if (includeLastSession) selectFields.push('last_session_at');
    const projectsSql = `SELECT ${selectFields.join(', ')} FROM projects ${whereSql} ORDER BY last_session_at DESC`;
    const rows = db.prepare(projectsSql).all(...filterParams) as Record<string, unknown>[];

    if (includeBriefs && rows.length > 0) {
      // Bulk-fetch brief counts for the matching slug set, then attach.
      try {
        const slugs = rows.map((r) => r.slug as string);
        const placeholders = slugs.map(() => '?').join(',');
        const briefRows = db
          .prepare(
            `SELECT project, COUNT(*) AS n FROM brief_status
             WHERE project IN (${placeholders}) GROUP BY project`,
          )
          .all(...slugs) as { project: string; n: number }[];
        const briefMap = new Map<string, number>();
        for (const r of briefRows) briefMap.set(r.project, r.n);
        for (const row of rows) {
          row.brief_count = briefMap.get(row.slug as string) ?? 0;
        }
      } catch {
        // brief_status absent — leave brief_count off the rows.
      }
    }

    result.projects = rows;
  }

  // Echo applied filters for caller observability.
  if (args.status !== undefined) (result as Record<string, unknown>).status_filter = args.status;
  if (args.archetype !== undefined) (result as Record<string, unknown>).archetype_filter = args.archetype;
  if (args.tech_stack !== undefined) (result as Record<string, unknown>).tech_stack_filter = args.tech_stack;

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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

export {
  handleProjectRegister,
  handleProjectList,
  handleProjectStatus,
  handleProjectUpdate,
  handleProjectDashboard,
  handleProjectBudget,
  handleProjectBudgetSet,
};
export type {
  ProjectRegisterInput,
  ProjectListInput,
  ProjectStatusInput,
  ProjectUpdateInput,
  ProjectDashboardInput,
  ProjectBudgetInput,
  ProjectBudgetSetInput,
};
