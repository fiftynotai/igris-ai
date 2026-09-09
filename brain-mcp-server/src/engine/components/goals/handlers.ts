/**
 * Brain Engine v7.0 — Goals Component Handlers
 *
 * Pure handlers for the goal MCP tools:
 *   - igris_goal_create    — server-side GL-XXX allocation, atomic insert
 *   - igris_goal_list      — filtered query with optional upcoming_days
 *   - igris_goal_get       — goal + serving briefs/learnings (via entity_edges)
 *   - igris_goal_update    — partial patch with status->achieved auto-stamp
 *   - igris_goal_progress  — count-based completion across serving briefs
 *   - igris_goal_dashboard — status counts, upcoming deadlines, stalled goals
 *
 * Handlers are pure functions: they take Record<string, unknown> args,
 * validate at runtime, and return a ToolResult. They do NOT emit events;
 * the component wrapper in `./index.ts` handles event emission so these
 * stay reusable from contexts without a bus.
 *
 * @module engine/components/goals/handlers
 * @author fifty.dev
 */

import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult } from '../../helpers.js';
// FR-240 D1 — the pure `db`-param read layer. This file is the MCP WRAPPER over
// it for list/get; `read.ts` imports no singleton and issues no writes, which is
// what lets the FR-238 dashboard reach the same queries with its own read-only
// handle. Do not move query logic back up here.
import { listGoals, getGoal } from './read.js';
// BR-083 — PROBE, do not assume. A brain predating `edges@4` (an older export,
// a VPS mid-deploy, a hand-rolled fixture) has no qualifier columns and must
// degrade rather than throw `no such column`.
import { edgeProjectPredicate } from '../edges/node-project.js';
import type { GoalRow } from './read.js';

/**
 * SQLite-compatible "now" formatter: `YYYY-MM-DD HH:MM:SS`.
 *
 * This matches the format produced by SQLite's `datetime('now')` so the
 * column stores a single canonical shape across both creation (DEFAULT
 * datetime('now')) and updates from JS. Mirrors the convention used in
 * `tools/briefs.ts`.
 */
function sqlNow(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

// ---------------------------------------------------------------------------
// Validation catalogs (runtime defense, complementary to JSON Schema enums)
// ---------------------------------------------------------------------------

/** Accepted goal lifecycle states. Mirrors the CHECK constraint in schema.ts. */
export const VALID_GOAL_STATUSES = [
  'active',
  'achieved',
  'abandoned',
  'deferred',
] as const;

/**
 * Brief statuses that count as "done" for progress computation.
 *
 * Matches `TERMINAL_STATUSES` in `briefs/index.ts` and the semantics of
 * the `brief.completed` event. Treating Archived as "done" is correct
 * because the goal is "served" regardless of whether the brief was
 * completed cleanly or rolled into another effort.
 */
export const TERMINAL_BRIEF_STATUSES = ['Done', 'Archived'] as const;

/** Goal ID prefix for auto-allocation. */
const GOAL_ID_PREFIX = 'GL-';

/**
 * Length caps for free-text goal fields. Enforced pre-INSERT/UPDATE so
 * pathological payloads don't bloat the goals table or the JSON envelopes
 * `igris_goal_get` returns. Caps were chosen to match typical product
 * limits: ~256 chars for headline-style fields, ~4KB for descriptions.
 */
export const MAX_TITLE_LEN = 256;
export const MAX_DESCRIPTION_LEN = 4096;
export const MAX_OUTCOME_LEN = 256;

/** ISO-8601 date validator (YYYY-MM-DD or full ISO timestamp). */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * Shape of a row in `goals` as returned to callers.
 *
 * DECLARED in `./read.ts` (FR-240 lifted it there so the pure reader does not
 * have to reach up into this `db.js`-importing file for a type) and re-exported
 * here so every existing `import { GoalRow } from './handlers.js'` still
 * resolves. The declaration must not be duplicated back into this file.
 */
export type { GoalRow };

/** Result shape for handleGoalProgress. */
export interface GoalProgress {
  goal_id: string;
  serving_briefs_total: number;
  serving_briefs_done: number;
  serving_briefs_in_progress: number;
  serving_briefs_pending: number;
  /** done / total, or null when total === 0 (not "0%" — "no measurement") */
  completion_pct: number | null;
  /** Count-only — learnings have no terminal status, see plan section "Learnings". */
  serving_learnings_count: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Validate ISO-8601 date or short YYYY-MM-DD; returns true if usable. */
function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_REGEX.test(value)) return false;
  // Defensive: catch "2026-13-45" style strings that pass the regex.
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/**
 * Allocate the next sequential GL-XXX id.
 *
 * Reads MAX(numeric suffix) from the goals table; the caller wraps the
 * INSERT in the same transaction so the read+write is atomic. The UNIQUE
 * constraint on `goal_id` is the safety net for the rare cross-connection
 * race; the create handler retries once on collision.
 */
function nextGoalId(db: ReturnType<typeof getDb>): string {
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(goal_id, ${GOAL_ID_PREFIX.length + 1}) AS INTEGER)) AS max_n
       FROM goals
       WHERE goal_id LIKE ?`,
    )
    .get(`${GOAL_ID_PREFIX}%`) as { max_n: number | null };

  const next = (row?.max_n ?? 0) + 1;
  return `${GOAL_ID_PREFIX}${String(next).padStart(3, '0')}`;
}

/**
 * Insert a goal row using a freshly allocated id. Returns the id used.
 *
 * Wrapped in a transaction by the caller so the SELECT MAX + INSERT are
 * atomic on the same connection. SQLite's UNIQUE constraint will raise
 * if a concurrent writer slipped a row in between — the create handler
 * retries once.
 */
function insertGoal(
  db: ReturnType<typeof getDb>,
  fields: {
    goalId: string;
    projectSlug: string | null;
    title: string;
    description: string | null;
    outcome: string;
    deadline: string | null;
    status: string;
    priority: string;
    metadata: string;
  },
): void {
  db.prepare(
    `INSERT INTO goals
       (goal_id, project_slug, title, description, outcome, deadline,
        status, priority, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.goalId,
    fields.projectSlug,
    fields.title,
    fields.description,
    fields.outcome,
    fields.deadline,
    fields.status,
    fields.priority,
    fields.metadata,
  );
}

/** Serialize metadata to JSON; tolerate already-stringified input. */
function normalizeMetadata(raw: unknown): string {
  if (raw === undefined || raw === null) return '{}';
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return raw;
    } catch {
      // fall through
    }
    return JSON.stringify({ value: raw });
  }
  return JSON.stringify(raw);
}

/** Count serving briefs grouped by completion bucket for a single goal. */
interface ServingBriefBuckets {
  total: number;
  done: number;
  in_progress: number;
  pending: number;
}

function queryServingBriefBuckets(
  db: ReturnType<typeof getDb>,
  goalId: string,
): ServingBriefBuckets {
  const row = db
    .prepare(
      // BR-083 — the same project predicate as `goals/read.ts::getGoal`. This
      // is `igris_goal_progress`'s counter, and without it a Done brief that
      // merely SHARES an id with a serving brief counted toward completion in
      // another project's goal. The `IS NULL` arm preserves today's behaviour
      // for deliberately unattributed rows rather than deleting them.
      `WITH serving AS (
         SELECT bs.status AS s
         FROM entity_edges e
         JOIN brief_status bs
           ON bs.brief_id = e.from_id
          AND ${edgeProjectPredicate(db, 'e', 'bs')}
         WHERE e.to_type = 'goal'
           AND e.to_id = ?
           AND e.from_type = 'brief'
           AND e.edge_type = 'serves_goal'
           AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) != 1
       )
       SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN s IN ('Done', 'Archived') THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN s = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN s NOT IN ('Done', 'Archived', 'In Progress') THEN 1 ELSE 0 END) AS pending
       FROM serving`,
    )
    .get(goalId) as {
      total: number;
      done: number | null;
      in_progress: number | null;
      pending: number | null;
    };

  return {
    total: row.total ?? 0,
    done: row.done ?? 0,
    in_progress: row.in_progress ?? 0,
    pending: row.pending ?? 0,
  };
}

/** Count serving learnings (count-only — see plan). */
function queryServingLearningsCount(
  db: ReturnType<typeof getDb>,
  goalId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM entity_edges
       WHERE to_type = 'goal'
         AND to_id = ?
         AND from_type = 'learning'
         AND edge_type = 'serves_goal'
         AND COALESCE(json_extract(metadata, '$.deleted'), 0) != 1`,
    )
    .get(goalId) as { n: number };
  return row.n ?? 0;
}

// ---------------------------------------------------------------------------
// handleGoalCreate
// ---------------------------------------------------------------------------

/**
 * Create a new goal.
 *
 * Required: project, title, outcome
 * Optional: description, deadline (ISO date), priority, status, metadata
 *
 * Auto-allocates the next sequential `goal_id` (GL-XXX) server-side. The
 * MAX+1 read and the INSERT run in the same transaction; on the rare
 * UNIQUE collision (concurrent writers, different connection) the
 * handler retries once with a refreshed MAX.
 */
export function handleGoalCreate(args: Record<string, unknown>): ToolResult {
  const projectSlug = args.project as string | undefined;
  const title = args.title as string | undefined;
  const outcome = args.outcome as string | undefined;

  if (!title || !outcome) {
    return errorResult('Missing required fields: title, outcome');
  }
  if (title.length > MAX_TITLE_LEN) {
    return errorResult(`title exceeds maximum length of ${MAX_TITLE_LEN} characters`);
  }
  if (outcome.length > MAX_OUTCOME_LEN) {
    return errorResult(`outcome exceeds maximum length of ${MAX_OUTCOME_LEN} characters`);
  }
  // project is required by the brief but goals may also be cross-project
  // (project_slug = NULL). Accept undefined/empty -> stored as NULL so the
  // /ops surface can render "Cross-project" without a sentinel value.
  const projectSlugCol: string | null =
    projectSlug && projectSlug.length > 0 ? projectSlug : null;

  const description = (args.description as string | undefined) ?? null;
  if (description !== null && description.length > MAX_DESCRIPTION_LEN) {
    return errorResult(`description exceeds maximum length of ${MAX_DESCRIPTION_LEN} characters`);
  }
  const deadline = (args.deadline as string | undefined) ?? null;
  if (deadline !== null && !isValidIsoDate(deadline)) {
    return errorResult(`Invalid deadline: ${deadline}. Expected ISO-8601 date (e.g. "2026-05-01").`);
  }

  const priority = (args.priority as string | undefined) ?? 'P2-Medium';

  const status = (args.status as string | undefined) ?? 'active';
  if (!(VALID_GOAL_STATUSES as readonly string[]).includes(status)) {
    return errorResult(
      `Invalid status: ${status}. Must be one of: ${VALID_GOAL_STATUSES.join(', ')}`,
    );
  }

  const metadata = normalizeMetadata(args.metadata);

  const db = getDb();

  // Atomic allocate-and-insert. Wrap in a transaction so a concurrent
  // writer on the same connection is serialized; cross-connection races
  // are caught by the UNIQUE constraint and retried once below.
  const allocateAndInsert = db.transaction((): string => {
    const goalId = nextGoalId(db);
    insertGoal(db, {
      goalId,
      projectSlug: projectSlugCol,
      title,
      description,
      outcome,
      deadline,
      status,
      priority,
      metadata,
    });
    return goalId;
  });

  let goalId: string;
  try {
    goalId = allocateAndInsert();
  } catch (err) {
    // Likely a UNIQUE collision under cross-connection contention. Retry
    // once with a fresh MAX read; if it still fails, surface the error.
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('UNIQUE')) {
      return errorResult(`Failed to create goal: ${message}`);
    }
    try {
      goalId = allocateAndInsert();
    } catch (err2) {
      const m2 = err2 instanceof Error ? err2.message : String(err2);
      return errorResult(`Failed to create goal after retry: ${m2}`);
    }
  }

  const row = db
    .prepare('SELECT * FROM goals WHERE goal_id = ?')
    .get(goalId) as GoalRow | undefined;
  if (!row) {
    return errorResult('Goal insert succeeded but row could not be read back');
  }

  return successResult(JSON.stringify({ created: true, goal: row }, null, 2));
}

// ---------------------------------------------------------------------------
// handleGoalList
// ---------------------------------------------------------------------------

/**
 * List goals with optional filters.
 *
 * Filters (all ANDed): project, status, upcoming_days, limit, offset.
 *
 * `upcoming_days` is a convenience for /awaken: filters goals with
 *   `deadline <= now() + N days AND status = 'active'`. Combine with
 *   limit=3 to bound /awaken's token surface.
 *
 * Each row is enriched with `serving_briefs_count`: a COUNT subquery on
 * entity_edges (excluding soft-deleted edges) so the caller can render a
 * one-line "X briefs" summary without round-tripping per row.
 */
export function handleGoalList(args: Record<string, unknown>): ToolResult {
  const db = getDb();

  if (
    args.status !== undefined &&
    !(VALID_GOAL_STATUSES as readonly string[]).includes(args.status as string)
  ) {
    return errorResult(
      `Invalid status filter: ${args.status as string}. Must be one of: ${VALID_GOAL_STATUSES.join(', ')}`,
    );
  }

  // upcoming_days narrows to active goals with deadlines within N days. The
  // VALIDATION stays here (its message is a wire contract); the clause itself
  // lives in `read.ts#listGoals`.
  let upcomingDays: number | undefined;
  if (args.upcoming_days !== undefined) {
    const days = Number(args.upcoming_days);
    if (!Number.isFinite(days) || days < 0) {
      return errorResult('upcoming_days must be a non-negative number');
    }
    upcomingDays = Math.floor(days);
  }

  const rawLimit = args.limit !== undefined ? Number(args.limit) : 25;
  if (!Number.isFinite(rawLimit) || rawLimit < 1) {
    return errorResult('limit must be a positive integer');
  }
  const limit = Math.min(rawLimit, 1000);
  const rawOffset = args.offset !== undefined ? Number(args.offset) : 0;
  if (!Number.isFinite(rawOffset) || rawOffset < 0) {
    return errorResult('offset must be a non-negative integer');
  }
  const offset = rawOffset;

  // FR-240 D1: filters, the `serving_briefs_count` subquery and the
  // deadline-ASC-nulls-last ordering all live in `read.ts#listGoals`. The
  // returned object IS the wire payload — key order is the contract.
  const result = listGoals(db, {
    project: args.project,
    status: args.status,
    upcoming_days: upcomingDays,
    limit,
    offset,
  });

  // FR-246: `search` is a DASHBOARD field and is projected out here on purpose.
  // This object is `JSON.stringify`d STRAIGHT onto the MCP wire, whose exact key
  // set `tools/__tests__/wrapper-wire-parity.test.ts` pins, and `igris_goal_list`
  // has no `q` to report — so emitting it would add a permanently-`null` key to
  // a contract the skills parse, in exchange for nothing. Listing the keys
  // explicitly rather than deleting one also makes the wire shape readable at
  // the call site.
  return successResult(
    JSON.stringify(
      {
        goals: result.goals,
        count: result.count,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// handleGoalGet
// ---------------------------------------------------------------------------

/**
 * Get a single goal by goal_id, plus serving briefs and learning count.
 *
 * Returns:
 *   { goal, serving_briefs: [{ brief_id, title, status }], serving_learnings_count }
 *
 * Soft-deleted edges (metadata.deleted=1) are excluded.
 */
export function handleGoalGet(args: Record<string, unknown>): ToolResult {
  const goalId = args.goal_id as string | undefined;
  if (!goalId) {
    return errorResult('Missing required field: goal_id');
  }

  // FR-240 D1: both SELECTs and the learning count live in `read.ts#getGoal`.
  const detail = getGoal(getDb(), goalId);

  if (detail === null) {
    return errorResult(`Goal not found: ${goalId}`);
  }

  return successResult(JSON.stringify(detail, null, 2));
}

// ---------------------------------------------------------------------------
// handleGoalUpdate
// ---------------------------------------------------------------------------

/**
 * Patch any subset of goal fields. Returns the updated row plus a flag
 * indicating whether the status transitioned to 'achieved' on this call
 * (so the component wrapper can emit `goal.achieved` exactly once).
 *
 * Status transitions:
 *   any -> 'achieved' : auto-set achieved_at = now()
 *   'achieved' -> any : clear achieved_at (revert)
 */
export interface GoalUpdateResult {
  updated: boolean;
  achieved_now: boolean;
  goal: GoalRow;
}

export function handleGoalUpdate(args: Record<string, unknown>): ToolResult {
  const goalId = args.goal_id as string | undefined;
  if (!goalId) {
    return errorResult('Missing required field: goal_id');
  }

  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM goals WHERE goal_id = ?')
    .get(goalId) as GoalRow | undefined;

  if (!existing) {
    return errorResult(`Goal not found: ${goalId}`);
  }

  const updates: { col: string; value: unknown }[] = [];

  if (args.title !== undefined) {
    if (typeof args.title !== 'string' || args.title.length === 0) {
      return errorResult('title must be a non-empty string');
    }
    if (args.title.length > MAX_TITLE_LEN) {
      return errorResult(`title exceeds maximum length of ${MAX_TITLE_LEN} characters`);
    }
    updates.push({ col: 'title', value: args.title });
  }
  if (args.description !== undefined) {
    const desc = args.description as string | null;
    if (desc !== null && typeof desc === 'string' && desc.length > MAX_DESCRIPTION_LEN) {
      return errorResult(`description exceeds maximum length of ${MAX_DESCRIPTION_LEN} characters`);
    }
    updates.push({ col: 'description', value: desc });
  }
  if (args.outcome !== undefined) {
    if (typeof args.outcome !== 'string' || args.outcome.length === 0) {
      return errorResult('outcome must be a non-empty string');
    }
    if (args.outcome.length > MAX_OUTCOME_LEN) {
      return errorResult(`outcome exceeds maximum length of ${MAX_OUTCOME_LEN} characters`);
    }
    updates.push({ col: 'outcome', value: args.outcome });
  }
  if (args.deadline !== undefined) {
    const d = args.deadline as string | null;
    if (d !== null && !isValidIsoDate(d)) {
      return errorResult(`Invalid deadline: ${d}. Expected ISO-8601 date.`);
    }
    updates.push({ col: 'deadline', value: d });
  }
  if (args.priority !== undefined) {
    updates.push({ col: 'priority', value: args.priority as string });
  }
  if (args.project !== undefined) {
    const p = args.project as string | null;
    updates.push({ col: 'project_slug', value: p && p.length > 0 ? p : null });
  }
  if (args.metadata !== undefined) {
    updates.push({ col: 'metadata', value: normalizeMetadata(args.metadata) });
  }

  let achievedNow = false;
  if (args.status !== undefined) {
    const newStatus = args.status as string;
    if (!(VALID_GOAL_STATUSES as readonly string[]).includes(newStatus)) {
      return errorResult(
        `Invalid status: ${newStatus}. Must be one of: ${VALID_GOAL_STATUSES.join(', ')}`,
      );
    }
    updates.push({ col: 'status', value: newStatus });

    if (newStatus === 'achieved' && existing.status !== 'achieved') {
      updates.push({ col: 'achieved_at', value: sqlNow() });
      achievedNow = true;
    } else if (newStatus !== 'achieved' && existing.status === 'achieved') {
      // Revert from achieved: clear the timestamp.
      updates.push({ col: 'achieved_at', value: null });
    }
  }

  if (updates.length === 0) {
    // No-op update; return existing row so callers don't have to special-case.
    const result: GoalUpdateResult = {
      updated: false,
      achieved_now: false,
      goal: existing,
    };
    return successResult(JSON.stringify(result, null, 2));
  }

  // Always bump updated_at on any patch.
  updates.push({ col: 'updated_at', value: sqlNow() });

  const setClauses = updates.map((u) => `${u.col} = ?`).join(', ');
  const values = updates.map((u) => u.value);

  db.prepare(`UPDATE goals SET ${setClauses} WHERE goal_id = ?`).run(...values, goalId);

  const updated = db
    .prepare('SELECT * FROM goals WHERE goal_id = ?')
    .get(goalId) as GoalRow;

  const result: GoalUpdateResult = {
    updated: true,
    achieved_now: achievedNow,
    goal: updated,
  };
  return successResult(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// handleGoalProgress
// ---------------------------------------------------------------------------

/**
 * Compute completion progress for a goal based on serving briefs.
 *
 * Rules (per FR-110 plan):
 *   - "Done" = brief.status IN ('Done', 'Archived'), matching the briefs
 *     component's TERMINAL_STATUSES and the brief.completed event semantics.
 *   - No effort weighting — count-based, transparent, self-correcting.
 *   - completion_pct = done / total, or null when total === 0.
 *   - Soft-deleted edges (metadata.deleted=1) are excluded.
 *   - Learnings are surfaced as a count only; they have no terminal status
 *     and so are not part of completion_pct.
 */
export function handleGoalProgress(args: Record<string, unknown>): ToolResult {
  const goalId = args.goal_id as string | undefined;
  if (!goalId) {
    return errorResult('Missing required field: goal_id');
  }

  const db = getDb();

  // Verify the goal exists so we don't silently return a "0/0" row for a
  // typo'd id — that's a validation surface, not a data surface. Use
  // EXISTS-style probe (SELECT 1 ... LIMIT 1) so SQLite doesn't bother
  // materializing column data we'll never read.
  const exists = db
    .prepare('SELECT 1 FROM goals WHERE goal_id = ? LIMIT 1')
    .get(goalId) as { 1: number } | undefined;
  if (!exists) {
    return errorResult(`Goal not found: ${goalId}`);
  }

  const buckets = queryServingBriefBuckets(db, goalId);
  const learningsCount = queryServingLearningsCount(db, goalId);

  const completionPct =
    buckets.total === 0 ? null : Math.round((buckets.done / buckets.total) * 1000) / 1000;

  const result: GoalProgress = {
    goal_id: goalId,
    serving_briefs_total: buckets.total,
    serving_briefs_done: buckets.done,
    serving_briefs_in_progress: buckets.in_progress,
    serving_briefs_pending: buckets.pending,
    completion_pct: completionPct,
    serving_learnings_count: learningsCount,
  };
  return successResult(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// handleGoalDashboard (TD-171 M4)
// ---------------------------------------------------------------------------

/**
 * Aggregate dashboard over the `goals` table (TD-171 M4).
 *
 * Mirrors the canonical TD-171 `_dashboard` shape established by M1's
 * `handleMemoryDashboard` and reused by M2/M3 dashboards:
 *
 *   {
 *     totals: {
 *       total: N,
 *       by_status: { active, achieved, abandoned, deferred },
 *     },
 *     recent: {
 *       upcoming_deadlines: [
 *         { goal_id, title, deadline, days_remaining,
 *           serving_brief_count, completed_brief_count }, ...
 *       ],
 *     },
 *     samples: {
 *       stalled_goals: [
 *         { goal_id, title, project_slug, days_since_update,
 *           serving_brief_count, completed_brief_count }, ...
 *       ],
 *     },                                                // omitted when summary_only
 *     project?: 'foo',                                  // echoed when filter set
 *   }
 *
 * Filter semantics:
 *   - `project`: scopes totals + recent + samples to one project's goals.
 *   - `summary_only`: omits `samples` (counts + upcoming deadlines still
 *     computed because they are headline-line content, not detail).
 *
 * Per L-152, scope is strictly the goals component — no perception or
 * memory aggregations leak in. Serving-brief counts are read via the
 * existing `entity_edges` JOIN reused from `handleGoalProgress`'s helpers
 * so the math is consistent across `_progress` and `_dashboard`.
 *
 * "Stalled" = active goal with no `goal.updated` event in the last 30 days
 * (proxy: `updated_at >= 30 days ago`). Goals never updated since creation
 * are always candidates if active.
 */
export function handleGoalDashboard(args: Record<string, unknown>): ToolResult {
  const summaryOnly = args.summary_only === true;
  const projectFilter =
    typeof args.project === 'string' && args.project.length > 0 ? args.project : null;

  const db = getDb();

  const projectWhere = projectFilter ? 'WHERE project_slug = ?' : '';
  const projectParams: string[] = projectFilter ? [projectFilter] : [];

  // --- totals.total ---
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM goals ${projectWhere}`)
    .get(...projectParams) as { n: number };

  // --- totals.by_status ---
  // Initialize every VALID_GOAL_STATUSES key to zero so downstream UI never
  // has to handle missing keys (canonical-shape contract per M1 dashboard).
  const statusRows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM goals ${projectWhere} GROUP BY status`)
    .all(...projectParams) as { status: string; n: number }[];
  const byStatus: Record<string, number> = {};
  for (const s of VALID_GOAL_STATUSES) byStatus[s] = 0;
  for (const r of statusRows) byStatus[r.status] = r.n;

  // --- recent.upcoming_deadlines ---
  // Active goals with deadlines in the next 30 days. Limit 10 — this is a
  // quick-glance surface, not a full report. Days-remaining is computed in
  // SQL (julianday diff) so callers get an integer rather than re-parsing.
  // Serving-brief counts are subqueries on entity_edges (mirrors handleGoalList).
  //
  // BR-083 — `serving_brief_count` counts EDGES and joins nothing, so it was
  // never a fan-out victim and is deliberately left alone. It is also what
  // makes the pair readable: after this brief `serving_brief_count` and
  // `getGoal(...).serving_briefs.length` finally AGREE (on the live brain,
  // GL-006: 32 edges vs 44 joined rows before, 32 vs 32 after).
  // `completed_brief_count` DOES join `brief_status`, so a Done brief in
  // another project that merely shares an id inflated it — those four sites
  // carry the project predicate.
  const upcomingSql = projectFilter
    ? `SELECT
         g.goal_id,
         g.title,
         g.deadline,
         CAST(julianday(g.deadline) - julianday('now') AS INTEGER) AS days_remaining,
         (
           SELECT COUNT(*) FROM entity_edges e
           WHERE e.to_type = 'goal' AND e.to_id = g.goal_id
             AND e.from_type = 'brief' AND e.edge_type = 'serves_goal'
             AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) != 1
         ) AS serving_brief_count,
         (
           SELECT COUNT(*) FROM entity_edges e
           JOIN brief_status bs
             ON bs.brief_id = e.from_id
            AND ${edgeProjectPredicate(db, 'e', 'bs')}
           WHERE e.to_type = 'goal' AND e.to_id = g.goal_id
             AND e.from_type = 'brief' AND e.edge_type = 'serves_goal'
             AND bs.status IN ('Done', 'Archived')
             AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) != 1
         ) AS completed_brief_count
       FROM goals g
       WHERE g.project_slug = ?
         AND g.status = 'active'
         AND g.deadline IS NOT NULL
         AND date(g.deadline) <= date('now', '+30 days')
       ORDER BY g.deadline ASC
       LIMIT 10`
    : `SELECT
         g.goal_id,
         g.title,
         g.deadline,
         CAST(julianday(g.deadline) - julianday('now') AS INTEGER) AS days_remaining,
         (
           SELECT COUNT(*) FROM entity_edges e
           WHERE e.to_type = 'goal' AND e.to_id = g.goal_id
             AND e.from_type = 'brief' AND e.edge_type = 'serves_goal'
             AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) != 1
         ) AS serving_brief_count,
         (
           SELECT COUNT(*) FROM entity_edges e
           JOIN brief_status bs
             ON bs.brief_id = e.from_id
            AND ${edgeProjectPredicate(db, 'e', 'bs')}
           WHERE e.to_type = 'goal' AND e.to_id = g.goal_id
             AND e.from_type = 'brief' AND e.edge_type = 'serves_goal'
             AND bs.status IN ('Done', 'Archived')
             AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) != 1
         ) AS completed_brief_count
       FROM goals g
       WHERE g.status = 'active'
         AND g.deadline IS NOT NULL
         AND date(g.deadline) <= date('now', '+30 days')
       ORDER BY g.deadline ASC
       LIMIT 10`;
  const upcomingDeadlines = db
    .prepare(upcomingSql)
    .all(...projectParams) as {
      goal_id: string;
      title: string;
      deadline: string;
      days_remaining: number;
      serving_brief_count: number;
      completed_brief_count: number;
    }[];

  // --- samples.stalled_goals (omitted when summary_only) ---
  // Active goals whose updated_at is older than 30 days. These are the
  // candidates for revisit/abandon during a release/quarterly review.
  let samples: Record<string, unknown> | undefined;
  if (!summaryOnly) {
    const stalledSql = projectFilter
      ? `SELECT
           g.goal_id,
           g.title,
           g.project_slug,
           CAST(julianday('now') - julianday(g.updated_at) AS INTEGER) AS days_since_update,
           (
             SELECT COUNT(*) FROM entity_edges e
             WHERE e.to_type = 'goal' AND e.to_id = g.goal_id
               AND e.from_type = 'brief' AND e.edge_type = 'serves_goal'
               AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) != 1
           ) AS serving_brief_count,
           (
             SELECT COUNT(*) FROM entity_edges e
             JOIN brief_status bs
               ON bs.brief_id = e.from_id
              AND ${edgeProjectPredicate(db, 'e', 'bs')}
             WHERE e.to_type = 'goal' AND e.to_id = g.goal_id
               AND e.from_type = 'brief' AND e.edge_type = 'serves_goal'
               AND bs.status IN ('Done', 'Archived')
               AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) != 1
           ) AS completed_brief_count
         FROM goals g
         WHERE g.project_slug = ?
           AND g.status = 'active'
           AND g.updated_at <= datetime('now', '-30 days')
         ORDER BY g.updated_at ASC
         LIMIT 10`
      : `SELECT
           g.goal_id,
           g.title,
           g.project_slug,
           CAST(julianday('now') - julianday(g.updated_at) AS INTEGER) AS days_since_update,
           (
             SELECT COUNT(*) FROM entity_edges e
             WHERE e.to_type = 'goal' AND e.to_id = g.goal_id
               AND e.from_type = 'brief' AND e.edge_type = 'serves_goal'
               AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) != 1
           ) AS serving_brief_count,
           (
             SELECT COUNT(*) FROM entity_edges e
             JOIN brief_status bs
               ON bs.brief_id = e.from_id
              AND ${edgeProjectPredicate(db, 'e', 'bs')}
             WHERE e.to_type = 'goal' AND e.to_id = g.goal_id
               AND e.from_type = 'brief' AND e.edge_type = 'serves_goal'
               AND bs.status IN ('Done', 'Archived')
               AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) != 1
           ) AS completed_brief_count
         FROM goals g
         WHERE g.status = 'active'
           AND g.updated_at <= datetime('now', '-30 days')
         ORDER BY g.updated_at ASC
         LIMIT 10`;
    const stalledGoals = db.prepare(stalledSql).all(...projectParams) as {
      goal_id: string;
      title: string;
      project_slug: string | null;
      days_since_update: number;
      serving_brief_count: number;
      completed_brief_count: number;
    }[];
    samples = { stalled_goals: stalledGoals };
  }

  const result: Record<string, unknown> = {
    totals: {
      total: totalRow.n,
      by_status: byStatus,
    },
    recent: {
      upcoming_deadlines: upcomingDeadlines,
    },
  };
  if (!summaryOnly) {
    result.samples = samples;
  }
  if (projectFilter) {
    result.project = projectFilter;
  }

  return successResult(JSON.stringify(result, null, 2));
}
