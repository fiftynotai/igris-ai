/**
 * Igris Brain — Brief READ layer (pure, `db`-param).
 *
 * FR-240 D1. This module is the second instance of the pure-layer / MCP-wrapper
 * split that `whole-graph.ts` / `whole-graph-tool.ts` established (FR-237) and
 * that `architecture_map.md` § "Brain Engine — Pure Data Layer vs MCP Wrapper"
 * records as the convention. The rule it exists to hold:
 *
 *   **This file MUST NOT import `../db.js`, and MUST NOT write.**
 *
 * Mechanically enforced by `__tests__/pure-read-purity.test.ts`.
 *
 * WHY THE SPLIT
 * -------------
 * `getDb()` opens the brain READ-WRITE and runs `migrateSchema` (`db.ts:1309`).
 * Any consumer that is not the MCP gateway — the FR-238 dashboard server, a CLI
 * verb, a fixture-backed test — would mutate the brain before reading a single
 * row. Taking the handle as a parameter lets those callers bring their own
 * `{readonly:true, query_only:ON}` connection while the SQL stays defined
 * exactly ONCE.
 *
 * PROVENANCE
 * ----------
 * Every SELECT below was MOVED verbatim from `briefs.ts` and is annotated with
 * its pre-extraction origin line. The one deliberate addition is the `effort`
 * filter in {@link listBriefs} (FR-240 closes that gap; the column already
 * exists in `brief_status`, only the filter was missing).
 *
 * CONSUMERS (MAINTAINING — the pure `db`-param READ layer row)
 * ------------------------------------------------------------
 * `tools/briefs.ts#handleBriefList` / `#handleBriefGet` (MCP wrappers) ·
 * `cli/src/lib/brain-bridge.ts` (type facade + runtime import) ·
 * `cli/src/lib/dashboard/routes.ts`. A change to a signature or a returned row
 * shape MUST sweep all of them in the same commit.
 *
 * @module tools/briefs-read
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Row and option shapes
// ---------------------------------------------------------------------------

/** Filters and pagination accepted by {@link listBriefs}. */
export interface ListBriefsOptions {
  project?: string;
  status?: string;
  brief_type?: string;
  priority?: string;
  /** FR-240 addition — the column existed in `brief_status`, the filter did not. */
  effort?: string;
  /** When true, LEFT JOIN `brief_files` and include `content`/`filename`/`content_hash`. */
  include_content?: boolean;
  /**
   * `0` means "no LIMIT clause at all" — the `igris_brief_list` semantic, kept
   * verbatim (briefs.ts:409). Callers that must not be able to ask for the
   * whole table (the dashboard) clamp before calling.
   */
  limit?: number;
  offset?: number;
}

/**
 * The `igris_brief_list` payload, key-for-key.
 *
 * The MCP wrapper `JSON.stringify`s this object DIRECTLY, so the key ORDER here
 * is part of the wire contract the SKILLS parse. Verified by grep at FR-240,
 * not assumed: `igris_brief_list` is called by the `register`, `audit` and
 * `team` skills and `igris_brief_get` by `hunt`, `archive` and `team`.
 * Re-derive rather than trust this list — the FR-240 plan named `/awaken` and
 * `/distill` here and BOTH were wrong (`/awaken` calls neither tool, and
 * `/distill` is the retired name of `/harvest`):
 *   grep -rl igris_brief_list ~/.igris/core/skills/
 * Pinned by `__tests__/wrapper-wire-parity.test.ts`.
 */
export interface ListBriefsResult {
  briefs: Record<string, unknown>[];
  count: number;
  total: number;
  limit: number;
  offset: number;
}

/**
 * One brief as `igris_brief_get` returns it.
 *
 * Both the JOIN path and the metadata-only fallback produce this identical key
 * set in this identical order (briefs.ts:341-354 / :370-383) — that symmetry is
 * why one interface suffices, and it must be preserved.
 */
export interface BriefRecord {
  project: string;
  brief_id: string;
  content: unknown;
  filename: unknown;
  content_hash: unknown;
  title: unknown;
  status: unknown;
  priority: unknown;
  effort: unknown;
  phase: unknown;
  brief_type: unknown;
  updated_at: unknown;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * List briefs with optional filters, `updated_at DESC`, and a `total` count.
 *
 * SQL moved verbatim from `briefs.ts:405-476` (`handleBriefList`).
 *
 * @param db - A connection. May be read-only; this function never writes.
 * @param opts - Filters + pagination.
 */
export function listBriefs(
  db: Database.Database,
  opts: ListBriefsOptions = {},
): ListBriefsResult {
  // briefs.ts:409 — 0 = return all, default 25, clamped to non-negative ints.
  const limit = opts.limit === 0 ? 0 : Math.max(1, Math.floor(opts.limit ?? 25));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  const conditions: string[] = [];
  const params: unknown[] = [];

  // briefs.ts:415-430 — one AND-ed equality per supplied filter.
  if (opts.project) {
    conditions.push('bs.project = ?');
    params.push(opts.project);
  }
  if (opts.status) {
    conditions.push('bs.status = ?');
    params.push(opts.status);
  }
  if (opts.brief_type) {
    conditions.push('bs.brief_type = ?');
    params.push(opts.brief_type);
  }
  if (opts.priority) {
    conditions.push('bs.priority = ?');
    params.push(opts.priority);
  }
  // FR-240 — the added filter. Same parameterised shape as its four siblings.
  if (opts.effort) {
    conditions.push('bs.effort = ?');
    params.push(opts.effort);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // briefs.ts:435-438 — total under the same filters, before pagination.
  const countRow = db.prepare(`
    SELECT COUNT(*) AS total FROM brief_status bs ${whereClause}
  `).get(...params) as { total: number };
  const total = countRow.total;

  const includeContent = opts.include_content === true;

  // briefs.ts:442-451
  const selectCols = includeContent
    ? `bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
       bs.priority, bs.effort, bs.phase, bs.updated_at,
       bf.content, bf.filename, bf.content_hash`
    : `bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
       bs.priority, bs.effort, bs.phase, bs.updated_at`;

  const joinClause = includeContent
    ? 'LEFT JOIN brief_files bf ON bf.project = bs.project AND bf.brief_id = bs.brief_id'
    : '';

  // briefs.ts:453-459
  const dataParams = [...params];
  let limitClause = '';
  if (limit > 0) {
    limitClause = 'LIMIT ? OFFSET ?';
    dataParams.push(limit, offset);
  }

  // briefs.ts:461-468
  const rows = db.prepare(`
    SELECT ${selectCols}
    FROM brief_status bs
    ${joinClause}
    ${whereClause}
    ORDER BY bs.updated_at DESC
    ${limitClause}
  `).all(...dataParams) as Record<string, unknown>[];

  return { briefs: rows, count: rows.length, total, limit, offset };
}

/**
 * Fetch one brief by the `(project, brief_id)` pair.
 *
 * SQL moved verbatim from `briefs.ts:315-394` (`handleBriefGet`). Returns
 * `null` when neither table has the row — the caller owns the not-found
 * message, because that string is a wire contract and belongs with the wrapper.
 *
 * BR-078: `project` is REQUIRED. `BR-001` names a different brief in 25
 * projects, so an id-only lookup would fuse records across projects.
 *
 * @param db - A connection. May be read-only; this function never writes.
 */
export function getBrief(
  db: Database.Database,
  project: string,
  briefId: string,
): BriefRecord | null {
  // briefs.ts:328-335 — JOIN first for full data (content + metadata).
  const joined = db.prepare(`
    SELECT bf.content, bf.filename, bf.content_hash, bf.updated_at AS file_updated_at,
           bs.title, bs.status, bs.priority, bs.effort, bs.phase, bs.brief_type,
           bs.updated_at AS status_updated_at
    FROM brief_files bf
    LEFT JOIN brief_status bs ON bs.project = bf.project AND bs.brief_id = bf.brief_id
    WHERE bf.project = ? AND bf.brief_id = ?
  `).get(project, briefId) as Record<string, unknown> | undefined;

  if (joined) {
    // briefs.ts:341-354 — key order is the wire contract.
    return {
      project,
      brief_id: briefId,
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
    };
  }

  // briefs.ts:360-364 — metadata-only fallback from brief_status.
  const statusOnly = db.prepare(`
    SELECT title, status, priority, effort, phase, brief_type, updated_at
    FROM brief_status
    WHERE project = ? AND brief_id = ?
  `).get(project, briefId) as Record<string, unknown> | undefined;

  if (statusOnly) {
    // briefs.ts:370-383 — note `title` is NOT `?? null` here; verbatim.
    return {
      project,
      brief_id: briefId,
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
    };
  }

  return null;
}
