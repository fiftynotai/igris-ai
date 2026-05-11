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

import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { generateEmbedding, embeddingToBuffer, processInBatches, EMBEDDING_MODEL } from '../utils/embeddings.js';
import { isVectorSearchAvailable, insertEmbeddingInto, vectorSearchFrom } from '../utils/vector-search.js';
import { l2ToCosine } from '../utils/hybrid-search.js';

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
  summary_only?: boolean;
}

/** Input shape for igris_brief_get */
interface BriefGetInput {
  project: string;
  brief_id: string;
}

/** Input shape for igris_brief_list */
interface BriefListInput {
  project?: string;
  status?: string;
  brief_type?: string;
  priority?: string;
  include_content?: boolean;
  limit?: number;
  offset?: number;
}

/** Input shape for igris_brief_create */
interface BriefCreateInput {
  project: string;
  brief_id: string;
  title: string;
  content: string;
  filename?: string;
  brief_type?: string;
  status?: string;
  priority?: string;
  effort?: string;
  phase?: string;
  /**
   * Explicit parent brief id (e.g. "FR-051"). When omitted the briefs
   * component falls back to scanning the markdown for a `**Parent Brief:**`
   * header. Surfaced in the brief.created event payload so the edges
   * component can auto-create a parent_of edge (FR-105).
   */
  parent_brief?: string;
}

/**
 * Extract a parent brief id from markdown content.
 *
 * Recognizes the canonical Igris brief header format `**Parent Brief:** FR-XXX`
 * (and a few common variants: `Parent: FR-XXX`, `## Parent: FR-XXX`).
 * Returns the first match or null. Used by the briefs component to enrich
 * the brief.created event payload (FR-105 hook target).
 *
 * Exported for unit tests.
 */
export function extractParentBriefId(content: string): string | null {
  if (!content) return null;
  // Tolerant pattern: optional bold/heading prefix, "Parent" optionally
  // followed by " Brief", a colon, optional closing bold stars, then a
  // brief id (FR-/BR-/TD-/MG- + digits). In markdown bold the colon lives
  // BEFORE the closing `**` (`**Parent Brief:**`), so the colon is matched
  // before the optional trailing `\*?\*?`.
  const re = /(?:\*\*|^|\n)\s*(?:#+\s*)?\*?\*?Parent(?:\s+Brief)?:\*?\*?\s*([A-Z]{2,3}-\d+)/im;
  const match = re.exec(content);
  return match ? match[1] : null;
}

/** Input shape for igris_brief_update */
interface BriefUpdateInput {
  project: string;
  brief_id: string;
  content?: string;
  title?: string;
  status?: string;
  priority?: string;
  effort?: string;
  phase?: string;
  brief_type?: string;
  filename?: string;
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

  if (summaryCounts.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No briefs tracked. Brief status is synced when briefs change status during /hunt, /rest, or /archive.',
      }],
    };
  }

  // Format summary by status
  const summaryLines = summaryCounts.map(s => `- ${s.status}: ${s.count}`);

  // Priority breakdown (project filter only, not status filter)
  const priorityCounts = db.prepare(`
    SELECT priority, COUNT(*) as count
    FROM brief_status
    ${summaryWhere}
    GROUP BY priority
    ORDER BY count DESC
  `).all(...summaryParams) as Record<string, unknown>[];

  const priorityLines = priorityCounts.map(p => `- ${p.priority || 'Unset'}: ${p.count}`);

  // Total count
  const totalCount = summaryCounts.reduce((sum, s) => sum + (s.count as number), 0);

  // Build filter description
  const filters: string[] = [];
  if (args.status) filters.push(`status=${args.status}`);
  if (args.project) filters.push(`project=${args.project}`);
  const filterDesc = filters.length > 0 ? ` (filtered: ${filters.join(', ')})` : '';

  // If summary_only, return just the counts — no full brief table
  if (args.summary_only) {
    return {
      content: [{
        type: 'text',
        text: [
          `# Brief Dashboard Summary${filterDesc}`,
          '',
          `Total: ${totalCount}`,
          '',
          '## By Status',
          ...summaryLines,
          '',
          '## By Priority',
          ...priorityLines,
        ].join('\n'),
      }],
    };
  }

  // Full dashboard: query all briefs for the table
  const rows = db.prepare(`
    SELECT bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
           bs.priority, bs.effort, bs.phase, bs.updated_at,
           p.name as project_name
    FROM brief_status bs
    LEFT JOIN projects p ON p.slug = bs.project
    ${whereClause}
    ORDER BY bs.updated_at DESC
  `).all(...params) as Record<string, unknown>[];

  // Format table
  const header = '| Project | Brief | Type | Title | Status | Priority | Phase | Updated |';
  const separator = '|---------|-------|------|-------|--------|----------|-------|---------|';
  const tableRows = rows.map(r =>
    `| ${r.project_name || r.project} | ${r.brief_id} | ${r.brief_type || '-'} | ${r.title} | ${r.status} | ${r.priority || '-'} | ${r.phase || '-'} | ${r.updated_at} |`
  );

  return {
    content: [{
      type: 'text',
      text: [
        `# Cross-Project Brief Dashboard${filterDesc}`,
        '',
        '## Summary',
        ...summaryLines,
        '',
        '## By Priority',
        ...priorityLines,
        '',
        `## Briefs (${rows.length})`,
        header,
        separator,
        ...tableRows,
      ].join('\n'),
    }],
  };
}

/**
 * Get a single brief by project and brief_id.
 *
 * JOINs brief_files and brief_status to return content + metadata.
 * Falls back to brief_status alone when no brief_files row exists.
 *
 * @param args - Project slug and brief ID
 * @returns MCP-formatted response with brief data
 */
function handleBriefGet(args: BriefGetInput): { content: { type: string; text: string }[] } {
  if (!args.project || !args.brief_id) {
    return {
      content: [{
        type: 'text',
        text: 'Error: "project" and "brief_id" are required.',
      }],
    };
  }

  const db = getDb();

  // Try JOIN first for full data (content + metadata)
  const joined = db.prepare(`
    SELECT bf.content, bf.filename, bf.content_hash, bf.updated_at AS file_updated_at,
           bs.title, bs.status, bs.priority, bs.effort, bs.phase, bs.brief_type,
           bs.updated_at AS status_updated_at
    FROM brief_files bf
    LEFT JOIN brief_status bs ON bs.project = bf.project AND bs.brief_id = bf.brief_id
    WHERE bf.project = ? AND bf.brief_id = ?
  `).get(args.project, args.brief_id) as Record<string, unknown> | undefined;

  if (joined) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          project: args.project,
          brief_id: args.brief_id,
          content: joined.content,
          filename: joined.filename,
          content_hash: joined.content_hash,
          title: joined.title ?? null,
          status: joined.status ?? null,
          priority: joined.priority ?? null,
          effort: joined.effort ?? null,
          phase: joined.phase ?? null,
          brief_type: joined.brief_type ?? null,
          updated_at: joined.status_updated_at ?? joined.file_updated_at,
        }, null, 2),
      }],
    };
  }

  // Fallback: metadata-only from brief_status
  const statusOnly = db.prepare(`
    SELECT title, status, priority, effort, phase, brief_type, updated_at
    FROM brief_status
    WHERE project = ? AND brief_id = ?
  `).get(args.project, args.brief_id) as Record<string, unknown> | undefined;

  if (statusOnly) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          project: args.project,
          brief_id: args.brief_id,
          content: null,
          filename: null,
          content_hash: null,
          title: statusOnly.title,
          status: statusOnly.status,
          priority: statusOnly.priority ?? null,
          effort: statusOnly.effort ?? null,
          phase: statusOnly.phase ?? null,
          brief_type: statusOnly.brief_type ?? null,
          updated_at: statusOnly.updated_at,
        }, null, 2),
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: `Brief not found: ${args.brief_id} in project ${args.project}`,
    }],
  };
}

/**
 * List briefs with optional filters.
 *
 * Supports filtering by project, status, brief_type, and priority.
 * Optionally includes full content via LEFT JOIN to brief_files.
 *
 * @param args - Optional filters and include_content flag
 * @returns MCP-formatted response with brief array
 */
function handleBriefList(args: BriefListInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  // Resolve pagination params (0 = return all, default 25, clamped to non-negative integers)
  const limit = args.limit === 0 ? 0 : Math.max(1, Math.floor(args.limit ?? 25));
  const offset = Math.max(0, Math.floor(args.offset ?? 0));

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (args.project) {
    conditions.push('bs.project = ?');
    params.push(args.project);
  }
  if (args.status) {
    conditions.push('bs.status = ?');
    params.push(args.status);
  }
  if (args.brief_type) {
    conditions.push('bs.brief_type = ?');
    params.push(args.brief_type);
  }
  if (args.priority) {
    conditions.push('bs.priority = ?');
    params.push(args.priority);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Total count (same filters, no pagination)
  const countRow = db.prepare(`
    SELECT COUNT(*) AS total FROM brief_status bs ${whereClause}
  `).get(...params) as { total: number };
  const total = countRow.total;

  const includeContent = args.include_content === true;

  const selectCols = includeContent
    ? `bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
       bs.priority, bs.effort, bs.phase, bs.updated_at,
       bf.content, bf.filename, bf.content_hash`
    : `bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
       bs.priority, bs.effort, bs.phase, bs.updated_at`;

  const joinClause = includeContent
    ? 'LEFT JOIN brief_files bf ON bf.project = bs.project AND bf.brief_id = bs.brief_id'
    : '';

  // Build LIMIT/OFFSET clause conditionally
  const dataParams = [...params];
  let limitClause = '';
  if (limit > 0) {
    limitClause = 'LIMIT ? OFFSET ?';
    dataParams.push(limit, offset);
  }

  const rows = db.prepare(`
    SELECT ${selectCols}
    FROM brief_status bs
    ${joinClause}
    ${whereClause}
    ORDER BY bs.updated_at DESC
    ${limitClause}
  `).all(...dataParams) as Record<string, unknown>[];

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ briefs: rows, count: rows.length, total, limit, offset }, null, 2),
    }],
  };
}

/**
 * Create a new brief with content and metadata.
 *
 * Atomically inserts/upserts into both brief_files and brief_status
 * within a transaction. Auto-embeds the brief for similarity search
 * and warns if similar briefs are detected (>= 0.85 cosine similarity).
 *
 * @param args - Brief data including project, brief_id, title, content
 * @returns MCP-formatted response confirming creation
 */
async function handleBriefCreate(args: BriefCreateInput): Promise<{ content: { type: string; text: string }[] }> {
  if (!args.project || !args.brief_id || !args.title || !args.content) {
    return {
      content: [{
        type: 'text',
        text: 'Error: "project", "brief_id", "title", and "content" are required.',
      }],
    };
  }

  const db = getDb();
  const contentHash = createHash('sha256').update(args.content).digest('hex');
  const fileId = randomUUID();
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const filename = args.filename ?? `${args.brief_id}.md`;
  const status = args.status ?? 'Ready';

  db.transaction(() => {
    // Upsert brief_files
    db.prepare(`
      INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, brief_id) DO UPDATE SET
        filename = excluded.filename,
        content = excluded.content,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `).run(fileId, args.project, args.brief_id, filename, args.content, contentHash, now);

    // Upsert brief_status
    db.prepare(`
      INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      status,
      args.priority ?? null,
      args.effort ?? null,
      args.phase ?? null,
      now
    );
  })();

  // Get the brief_status.id (integer PK) for embedding storage
  const statusRow = db.prepare(
    'SELECT id FROM brief_status WHERE project = ? AND brief_id = ?',
  ).get(args.project, args.brief_id) as { id: number } | undefined;

  // Auto-embed and similarity check (non-blocking on failure)
  let embeddingNote = '';
  let similarityWarning = '';

  try {
    if (statusRow && isVectorSearchAvailable(db)) {
      const textToEmbed = extractBriefProblem(args.title, args.content);
      const embedding = await generateEmbedding(textToEmbed);

      // Store embedding in brief_status
      db.prepare('UPDATE brief_status SET embedding = ?, embedding_model = ? WHERE id = ?')
        .run(embeddingToBuffer(embedding), EMBEDDING_MODEL, statusRow.id);

      // Insert into briefs_vec
      insertEmbeddingInto(db, 'briefs_vec', statusRow.id, embedding);
      embeddingNote = '\nEmbedding: generated';

      // Check for similar briefs
      const vecResults = vectorSearchFrom(db, 'briefs_vec', embedding, 10);
      const similarBriefs: { brief_id: string; title: string; similarity: number }[] = [];

      for (const result of vecResults) {
        // Skip self
        if (result.rowid === statusRow.id) continue;

        const similarity = l2ToCosine(result.distance);
        if (similarity >= 0.85) {
          const row = db.prepare(
            'SELECT brief_id, title FROM brief_status WHERE id = ?',
          ).get(result.rowid) as { brief_id: string; title: string } | undefined;
          if (row) {
            similarBriefs.push({
              brief_id: row.brief_id,
              title: row.title,
              similarity,
            });
          }
        }
      }

      if (similarBriefs.length > 0) {
        const warnings = similarBriefs.map(
          b => `- ${b.brief_id}: ${b.title} (similarity: ${b.similarity.toFixed(4)})`,
        );
        similarityWarning = `\n\nWARNING: ${similarBriefs.length} similar brief(s) detected (similarity >= 0.85):\n${warnings.join('\n')}`;
      }
    }
  } catch (err) {
    console.error('[briefs] Auto-embed failed for brief', args.brief_id, ':', err);
    embeddingNote = '\nEmbedding: skipped (will be generated on backfill)';
  }

  return {
    content: [{
      type: 'text',
      text: [
        'Brief created successfully.',
        '',
        `Project: ${args.project}`,
        `Brief: ${args.brief_id}`,
        `Title: ${args.title}`,
        `Status: ${status}`,
        `Content hash: ${contentHash.substring(0, 12)}...`,
        `Size: ${args.content.length} chars`,
      ].join('\n') + embeddingNote + similarityWarning,
    }],
  };
}

/**
 * Update an existing brief's content and/or metadata.
 *
 * Only updates fields that are provided. Uses a transaction to update
 * brief_files (if content provided) and brief_status (if metadata provided).
 * Uses a whitelist for brief_status columns to prevent SQL injection.
 *
 * @param args - Project, brief_id, and optional fields to update
 * @returns MCP-formatted response confirming what was updated
 */
function handleBriefUpdate(args: BriefUpdateInput): { content: { type: string; text: string }[] } {
  if (!args.project || !args.brief_id) {
    return {
      content: [{
        type: 'text',
        text: 'Error: "project" and "brief_id" are required.',
      }],
    };
  }

  const db = getDb();

  // Check brief exists in either table
  const existsInFiles = db.prepare(
    'SELECT 1 FROM brief_files WHERE project = ? AND brief_id = ?'
  ).get(args.project, args.brief_id);

  const existsInStatus = db.prepare(
    'SELECT 1 FROM brief_status WHERE project = ? AND brief_id = ?'
  ).get(args.project, args.brief_id);

  if (!existsInFiles && !existsInStatus) {
    return {
      content: [{
        type: 'text',
        text: `Brief not found: ${args.brief_id} in project ${args.project}`,
      }],
    };
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const updated: string[] = [];

  db.transaction(() => {
    // Update brief_files if content or filename provided
    if (args.content !== undefined || args.filename !== undefined) {
      if (args.content !== undefined) {
        const contentHash = createHash('sha256').update(args.content).digest('hex');

        if (existsInFiles) {
          // Update existing row
          const setClauses: string[] = ['content = ?', 'content_hash = ?', 'updated_at = ?'];
          const setValues: unknown[] = [args.content, contentHash, now];

          if (args.filename !== undefined) {
            setClauses.push('filename = ?');
            setValues.push(args.filename);
          }

          db.prepare(`
            UPDATE brief_files SET ${setClauses.join(', ')}
            WHERE project = ? AND brief_id = ?
          `).run(...setValues, args.project, args.brief_id);
        } else {
          // Insert new row
          const fileId = randomUUID();
          const filename = args.filename ?? `${args.brief_id}.md`;
          db.prepare(`
            INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(fileId, args.project, args.brief_id, filename, args.content, contentHash, now);
        }
        updated.push('content');
      } else if (args.filename !== undefined && existsInFiles) {
        db.prepare(`
          UPDATE brief_files SET filename = ?, updated_at = ?
          WHERE project = ? AND brief_id = ?
        `).run(args.filename, now, args.project, args.brief_id);
        updated.push('filename');
      }
    }

    // Update brief_status if metadata fields provided
    // Whitelist of allowed columns to prevent SQL injection
    const allowedColumns: Record<string, unknown> = {
      title: args.title,
      status: args.status,
      priority: args.priority,
      effort: args.effort,
      phase: args.phase,
      brief_type: args.brief_type,
    };

    const setClauses: string[] = [];
    const setValues: unknown[] = [];

    for (const [col, val] of Object.entries(allowedColumns)) {
      if (val !== undefined) {
        setClauses.push(`${col} = ?`);
        setValues.push(val);
        updated.push(col);
      }
    }

    if (setClauses.length > 0) {
      setClauses.push('updated_at = ?');
      setValues.push(now);

      if (existsInStatus) {
        db.prepare(`
          UPDATE brief_status SET ${setClauses.join(', ')}
          WHERE project = ? AND brief_id = ?
        `).run(...setValues, args.project, args.brief_id);
      } else {
        // Insert a new brief_status row with provided fields
        db.prepare(`
          INSERT INTO brief_status (project, brief_id, title, status, priority, effort, phase, brief_type, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          args.project,
          args.brief_id,
          args.title ?? '',
          args.status ?? 'Ready',
          args.priority ?? null,
          args.effort ?? null,
          args.phase ?? null,
          args.brief_type ?? null,
          now
        );
        updated.push('brief_status (created)');
      }
    }
  })();

  if (updated.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No fields to update for brief ${args.brief_id} in project ${args.project}. Provide at least one field to update.`,
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: [
        'Brief updated successfully.',
        '',
        `Project: ${args.project}`,
        `Brief: ${args.brief_id}`,
        `Updated fields: ${updated.join(', ')}`,
      ].join('\n'),
    }],
  };
}

// ---------------------------------------------------------------------------
// Brief Velocity (FR-079)
// ---------------------------------------------------------------------------

/** Input shape for brief velocity query */
interface BriefVelocityInput {
  /** Optional project slug filter */
  project?: string;
  /** Number of weeks to include (default 4, max 52) */
  weeks?: number;
}

/** Output shape for brief velocity query */
interface BriefVelocityOutput {
  project: string | null;
  weeks: number;
  weekly: { week: string; completed: number }[];
  completion_rate: { done: number; total: number; percentage: number };
  trend: { current_week: number; previous_week: number; change_pct: number | null; direction: string } | null;
}

/**
 * Compute brief completion velocity metrics.
 *
 * Returns weekly completion counts, overall completion rate, and a week-over-week
 * trend indicator. All queries use parameterized statements against `brief_status`.
 */
function handleBriefVelocity(input?: BriefVelocityInput): BriefVelocityOutput {
  const db = getDb();
  const projectFilter = input?.project;
  const weeks = Math.min(52, Math.max(1, input?.weeks ?? 4));

  // Build optional project filter clause
  const projectCondition = projectFilter ? ' AND project = ?' : '';
  const projectParams = projectFilter ? [projectFilter] : [];

  // 1. Weekly completions — Done briefs grouped by ISO week, last N weeks
  const weeklyRows = db.prepare(
    `SELECT strftime('%Y-W%W', updated_at) AS week, COUNT(*) AS completed
     FROM brief_status
     WHERE status = 'Done'
       AND updated_at >= datetime('now', '-' || ? || ' days')${projectCondition}
     GROUP BY week
     ORDER BY week ASC`
  ).all(weeks * 7, ...projectParams) as { week: string; completed: number }[];

  // 2. Completion rate — Done vs total (optionally filtered by project)
  const totalRow = db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'Done' THEN 1 ELSE 0 END) AS done,
       COUNT(*) AS total
     FROM brief_status
     WHERE 1=1${projectCondition}`
  ).get(...projectParams) as { done: number; total: number } | undefined;

  const done = totalRow?.done ?? 0;
  const total = totalRow?.total ?? 0;
  const percentage = total > 0 ? Math.round((done / total) * 1000) / 10 : 0;

  // 3. Trend — compare last 7 days vs 7-14 days ago
  const currentWeekRow = db.prepare(
    `SELECT COUNT(*) AS count FROM brief_status
     WHERE status = 'Done'
       AND updated_at >= datetime('now', '-7 days')${projectCondition}`
  ).get(...projectParams) as { count: number } | undefined;

  const previousWeekRow = db.prepare(
    `SELECT COUNT(*) AS count FROM brief_status
     WHERE status = 'Done'
       AND updated_at >= datetime('now', '-14 days')
       AND updated_at < datetime('now', '-7 days')${projectCondition}`
  ).get(...projectParams) as { count: number } | undefined;

  const currentWeek = currentWeekRow?.count ?? 0;
  const previousWeek = previousWeekRow?.count ?? 0;

  let trend: BriefVelocityOutput['trend'] = null;
  if (currentWeek > 0 || previousWeek > 0) {
    let changePct: number | null = null;
    let direction = 'flat';
    if (previousWeek > 0) {
      changePct = Math.round(((currentWeek - previousWeek) / previousWeek) * 1000) / 10;
      direction = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat';
    } else if (currentWeek > 0) {
      // Previous week was zero, current is positive — "up" but no meaningful percentage
      changePct = null;
      direction = 'up';
    }
    trend = { current_week: currentWeek, previous_week: previousWeek, change_pct: changePct, direction };
  }

  return {
    project: projectFilter ?? null,
    weeks,
    weekly: weeklyRows,
    completion_rate: { done, total, percentage },
    trend,
  };
}

// ---------------------------------------------------------------------------
// Brief Similarity Detection (FR-094)
// ---------------------------------------------------------------------------

/** Input shape for igris_brief_similar */
interface BriefSimilarInput {
  query: string;
  project?: string;
  threshold?: number;
  limit?: number;
}

/** Input shape for backfill tools */
interface BriefBackfillInput {
  batch_size?: number;
  project?: string;
}

/**
 * Extract the problem/intent text from a brief's content for embedding.
 *
 * Looks for a `## Problem` or `## Problem Statement` section and extracts
 * the text up to the next heading. Falls back to the first 500 characters
 * of content if no structured section is found.
 *
 * @param title - The brief title
 * @param content - The full brief content (markdown)
 * @returns Combined text suitable for embedding
 */
function extractBriefProblem(title: string, content: string): string {
  // Try to find ## Problem or ## Problem Statement section
  const problemMatch = content.match(
    /##\s+Problem(?:\s+Statement)?\s*\n([\s\S]*?)(?=\n##\s|\n---\s|$)/i,
  );

  const problemText = problemMatch
    ? problemMatch[1].trim()
    : content.substring(0, 500).trim();

  return `${title} ${problemText}`;
}

/**
 * Find briefs that are semantically similar to a query.
 *
 * Uses vector search against briefs_vec and converts L2 distance to
 * cosine similarity, filtering by threshold.
 *
 * @param args - Search parameters
 * @returns MCP-formatted response with similar briefs
 */
async function handleBriefSimilar(args: BriefSimilarInput): Promise<{ content: { type: string; text: string }[] }> {
  const db = getDb();
  const threshold = args.threshold ?? 0.85;
  const limit = args.limit ?? 5;

  if (!isVectorSearchAvailable(db)) {
    return {
      content: [{
        type: 'text',
        text: 'Brief similarity search unavailable: sqlite-vec extension is not loaded.',
      }],
    };
  }

  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await generateEmbedding(args.query);
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `Failed to generate embedding for query: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }

  // Search with extra headroom for filtering
  const vecResults = vectorSearchFrom(db, 'briefs_vec', queryEmbedding, limit * 3);

  if (vecResults.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No similar briefs found.',
      }],
    };
  }

  // Convert to cosine similarity and filter by threshold
  const candidates = vecResults
    .map(r => ({ rowid: r.rowid, similarity: l2ToCosine(r.distance) }))
    .filter(r => r.similarity >= threshold);

  if (candidates.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No briefs found above similarity threshold (${threshold}).`,
      }],
    };
  }

  // Fetch full brief metadata
  const ids = candidates.map(c => c.rowid);
  const placeholders = ids.map(() => '?').join(',');
  let sql = `
    SELECT bs.id, bs.project, bs.brief_id, bs.title, bs.status, bs.priority, bs.brief_type
    FROM brief_status bs
    WHERE bs.id IN (${placeholders})
  `;
  const params: unknown[] = [...ids];

  if (args.project) {
    sql += ' AND bs.project = ?';
    params.push(args.project);
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  // Build lookup
  const rowMap = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    rowMap.set(row.id as number, row);
  }

  // Format results in similarity order
  const results: string[] = [];
  for (const candidate of candidates) {
    const row = rowMap.get(candidate.rowid);
    if (!row) continue;
    results.push([
      `--- Similarity: ${candidate.similarity.toFixed(4)} ---`,
      `Brief: ${row.brief_id}`,
      `Project: ${row.project}`,
      `Title: ${row.title}`,
      `Status: ${row.status}`,
      `Priority: ${row.priority || '(none)'}`,
      `Type: ${row.brief_type || '(none)'}`,
    ].join('\n'));
    if (results.length >= limit) break;
  }

  if (results.length === 0) {
    return {
      content: [{
        type: 'text',
        text: args.project
          ? `No similar briefs found in project "${args.project}" above threshold (${threshold}).`
          : `No briefs found above similarity threshold (${threshold}).`,
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: `Found ${results.length} similar brief(s) (threshold >= ${threshold}):\n\n${results.join('\n\n')}`,
    }],
  };
}

/**
 * Batch-embed existing briefs that lack embeddings.
 *
 * Processes briefs where brief_status.embedding IS NULL in batches,
 * generating embeddings from brief_files content and storing them in
 * both the brief_status.embedding column and the briefs_vec virtual table.
 *
 * @param args - Optional batch_size and project filter
 * @returns MCP-formatted response with processing summary
 */
async function handleBriefBackfillEmbeddings(args: BriefBackfillInput): Promise<{ content: { type: string; text: string }[] }> {
  const db = getDb();
  const batchSize = args.batch_size ?? 50;

  if (!isVectorSearchAvailable(db)) {
    return {
      content: [{
        type: 'text',
        text: 'Backfill skipped: sqlite-vec extension is not available. Vector search is disabled.',
      }],
    };
  }

  let sql = `
    SELECT bs.id, bs.brief_id, bs.title, bf.content
    FROM brief_status bs
    JOIN brief_files bf ON bs.project = bf.project AND bs.brief_id = bf.brief_id
    WHERE bs.embedding IS NULL
  `;
  const params: unknown[] = [];
  if (args.project) {
    sql += ' AND bs.project = ?';
    params.push(args.project);
  }
  sql += ' ORDER BY bs.id LIMIT ?';

  const briefs = db.prepare(sql).all(...params, batchSize) as { id: number; brief_id: string; title: string; content: string }[];

  if (briefs.length === 0) {
    let countSql = `
      SELECT COUNT(*) as total
      FROM brief_status bs
      JOIN brief_files bf ON bs.project = bf.project AND bs.brief_id = bf.brief_id
    `;
    const countParams: unknown[] = [];
    if (args.project) {
      countSql += ' WHERE bs.project = ?';
      countParams.push(args.project);
    }
    const countRow = db.prepare(countSql).get(...countParams) as { total: number };

    return {
      content: [{
        type: 'text',
        text: `Backfill complete -- all ${countRow.total} briefs already have embeddings.`,
      }],
    };
  }

  const startTime = Date.now();

  const { succeeded: processed, failed } = await processInBatches(
    briefs,
    async (brief) => {
      const textToEmbed = extractBriefProblem(brief.title, brief.content);
      const embedding = await generateEmbedding(textToEmbed);
      db.prepare('UPDATE brief_status SET embedding = ?, embedding_model = ? WHERE id = ?')
        .run(embeddingToBuffer(embedding), EMBEDDING_MODEL, brief.id);
      insertEmbeddingInto(db, 'briefs_vec', brief.id, embedding);
    },
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Check remaining
  let remainingSql = `
    SELECT COUNT(*) as remaining
    FROM brief_status bs
    JOIN brief_files bf ON bs.project = bf.project AND bs.brief_id = bf.brief_id
    WHERE bs.embedding IS NULL
  `;
  const remainingParams: unknown[] = [];
  if (args.project) {
    remainingSql += ' AND bs.project = ?';
    remainingParams.push(args.project);
  }
  const remainingRow = db.prepare(remainingSql).get(...remainingParams) as { remaining: number };

  return {
    content: [{
      type: 'text',
      text: `Backfill batch complete.\n\nProcessed: ${processed}\nFailed: ${failed}\nRemaining: ${remainingRow.remaining}\nTime: ${elapsed}s\n\n${remainingRow.remaining > 0 ? 'Run again to process more.' : 'All briefs now have embeddings.'}`,
    }],
  };
}

export {
  handleBriefSync,
  handleBriefDashboard,
  handleBriefGet,
  handleBriefList,
  handleBriefCreate,
  handleBriefUpdate,
  handleBriefVelocity,
  handleBriefSimilar,
  handleBriefBackfillEmbeddings,
  extractBriefProblem,
};
export type {
  BriefSyncInput,
  BriefDashboardInput,
  BriefGetInput,
  BriefListInput,
  BriefCreateInput,
  BriefUpdateInput,
  BriefVelocityInput,
  BriefVelocityOutput,
  BriefSimilarInput,
  BriefBackfillInput,
};
