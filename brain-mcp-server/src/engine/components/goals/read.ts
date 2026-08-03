/**
 * Brain Engine — Goals READ layer (pure, `db`-param).
 *
 * FR-240 D1, the same pure-layer / MCP-wrapper split as `tools/briefs-read.ts`
 * and `tools/memory-read.ts`.
 *
 *   **This file MUST NOT import `db.js`, and MUST NOT write.**
 *
 * Mechanically enforced by `tools/__tests__/pure-read-purity.test.ts`.
 *
 * `WhereBuilder` is imported from `../../helpers.js`, which has NO `db.js`
 * import edge (it exports only `errorResult` / `successResult` / `now` /
 * `errMsg` / `WhereBuilder` over `./types.js`). That is the disclosure the
 * architecture-map rule asks for when a pure module reaches through a shared
 * helper: the helper is side-effect-free at import time and singleton-free.
 *
 * VALIDATION IS NOT HERE. `handleGoalList` rejects an unknown `status`, a
 * non-finite `upcoming_days`, a non-positive `limit` and a negative `offset`
 * with `errorResult` strings that are themselves wire contracts. Those stay in
 * the wrapper; this module receives already-normalised numbers.
 *
 * CONSUMERS (MAINTAINING — the pure `db`-param READ layer row)
 * ------------------------------------------------------------
 * `goals/handlers.ts#handleGoalList` / `#handleGoalGet` (MCP wrappers) ·
 * `cli/src/lib/brain-bridge.ts` · `cli/src/lib/dashboard/routes.ts`.
 *
 * @module engine/components/goals/read
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { WhereBuilder } from '../../helpers.js';
import {
  likePattern,
  substringReport,
  LIKE_ESCAPE_CLAUSE,
} from '../../../utils/substring-search.js';
import type { SubstringSearchReport } from '../../../utils/substring-search.js';

/**
 * Shape of a row in `goals` as returned to callers.
 *
 * LIFTED here from `handlers.ts:80` by FR-240. `handlers.ts` re-exports it, so
 * every existing `import { GoalRow } from './handlers.js'` still resolves. The
 * lift is the architecture-map's prescribed remedy for a pure module needing a
 * type that lives in a `db.js`-importing file: move the dependency-free
 * declaration DOWN rather than reaching UP (the `graph-keys.ts` pattern).
 */
export interface GoalRow {
  id: number;
  goal_id: string;
  project_slug: string | null;
  title: string;
  description: string | null;
  outcome: string;
  deadline: string | null;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
  achieved_at: string | null;
  metadata: string;
}

/** A goal row plus the count of briefs that serve it. */
export type GoalListRow = GoalRow & { serving_briefs_count: number };

/** Options for {@link listGoals}. All values are pre-validated by the caller. */
export interface ListGoalsOptions {
  project?: unknown;
  status?: unknown;
  /** Already `Math.floor`-ed and known non-negative. */
  upcoming_days?: number;
  /**
   * FR-246 — an honest SUBSTRING filter over `title` + `description`. Not
   * retrieval: no ranking, no recall, and the payload's `search` block says so.
   *
   * Substring is proportionate here and the number is the argument, measured
   * read-only on the operator brain rather than assumed: `SELECT COUNT(*) FROM
   * goals` = **6**. Goals are hand-created, one per objective. There is no
   * `goals_fts` and no `goals_vec`, and a schema migration to rank six rows
   * would be ceremony. If that population ever grows by an order of magnitude,
   * this is the line to revisit.
   */
  q?: string;
  /** Already clamped to `1..1000`. */
  limit: number;
  /** Already known non-negative. */
  offset: number;
}

/**
 * The `igris_goal_list` payload, key-for-key.
 *
 * The MCP wrapper `JSON.stringify`s this object directly, so key ORDER is part
 * of the wire contract. Pinned by `tools/__tests__/wrapper-wire-parity.test.ts`.
 */
export interface ListGoalsResult {
  goals: GoalListRow[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  /**
   * FR-246 D3-f — what the `q` filter actually did, or `null` when no `q` was
   * supplied. A PAYLOAD field, not a UI sentence, so a gate can assert it.
   *
   * Appended LAST so the pre-FR-246 key order — which the MCP wrapper
   * `JSON.stringify`s straight onto the wire and `wrapper-wire-parity.test.ts`
   * pins — is unchanged for every existing consumer.
   */
  search: SubstringSearchReport | null;
}

/** One brief serving a goal, as `igris_goal_get` returns it. */
export interface ServingBrief {
  brief_id: string;
  title: string;
  status: string;
  priority: string;
}

/** The `igris_goal_get` payload, key-for-key. */
export interface GoalDetail {
  goal: GoalRow;
  serving_briefs: ServingBrief[];
  serving_learnings_count: number;
}

/**
 * List goals with optional project / status / upcoming-deadline filters.
 *
 * SQL moved verbatim from `handlers.ts:396-445` (`handleGoalList`), including
 * the `serving_briefs_count` correlated subquery, the soft-delete exclusion
 * (`metadata.$.deleted != 1`) and the deadline-ASC-nulls-last ordering.
 *
 * @param db - A connection. May be read-only; this function never writes.
 */
export function listGoals(
  db: Database.Database,
  opts: ListGoalsOptions,
): ListGoalsResult {
  // handlers.ts:396-398
  const where = new WhereBuilder()
    .add('project_slug = ?', opts.project)
    .add('status = ?', opts.status);

  // handlers.ts:400-408 — upcoming_days narrows to active goals with deadlines
  // within N days. The caller has already floored and range-checked `days`.
  if (opts.upcoming_days !== undefined) {
    where.addAlways("deadline IS NOT NULL AND status = 'active'");
    where.addAlways("date(deadline) <= date('now', ?)", `+${opts.upcoming_days} days`);
  }

  // FR-246 — the substring filter. BOUND parameters and an explicit ESCAPE, so
  // `?q=%` matches rows containing a literal per-cent sign rather than matching
  // everything while looking like a filter.
  const searchFields = ['title', 'description'];
  if (opts.q && opts.q.trim() !== '') {
    const pattern = likePattern(opts.q);
    where.addAlways(
      `(LOWER(title) LIKE ? ${LIKE_ESCAPE_CLAUSE}` +
        ` OR LOWER(COALESCE(description, '')) LIKE ? ${LIKE_ESCAPE_CLAUSE})`,
      pattern,
      pattern,
    );
  }

  // handlers.ts:421-441 — deadline ASC NULLS LAST, then created_at DESC. Goals
  // approaching a deadline sort to the top; deadline-less goals stay visible at
  // the bottom rather than disappearing.
  const rows = db
    .prepare(
      `SELECT
         g.*,
         (
           SELECT COUNT(*)
           FROM entity_edges e
           WHERE e.to_type = 'goal'
             AND e.to_id = g.goal_id
             AND e.from_type = 'brief'
             AND e.edge_type = 'serves_goal'
             AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) != 1
         ) AS serving_briefs_count
       FROM goals g
       ${where.toSQL()}
       ORDER BY (g.deadline IS NULL) ASC, g.deadline ASC, g.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...where.values(), opts.limit, opts.offset) as GoalListRow[];

  // handlers.ts:443-445
  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM goals ${where.toSQL()}`)
    .get(...where.values()) as { total: number };

  return {
    goals: rows,
    count: rows.length,
    total: countRow.total,
    limit: opts.limit,
    offset: opts.offset,
    search: substringReport(opts.q, searchFields),
  };
}

/**
 * Count learnings serving a goal.
 *
 * Moved verbatim from `handlers.ts:244-260` (`queryServingLearningsCount`). It
 * stays PRIVATE here for the same reason it was private there: it is one leg of
 * {@link getGoal}'s payload, not a surface of its own.
 */
function servingLearningsCount(db: Database.Database, goalId: string): number {
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

/**
 * Fetch one goal plus its serving briefs and learning count.
 *
 * SQL moved verbatim from `handlers.ts:481-503` (`handleGoalGet`). Returns
 * `null` when the goal does not exist — the caller owns the not-found string,
 * because `errorResult('Goal not found: …')` is a wire contract.
 *
 * @param db - A connection. May be read-only; this function never writes.
 */
export function getGoal(db: Database.Database, goalId: string): GoalDetail | null {
  const goal = db
    .prepare('SELECT * FROM goals WHERE goal_id = ?')
    .get(goalId) as GoalRow | undefined;

  if (!goal) return null;

  // Soft-deleted edges (metadata.deleted=1) are excluded.
  const serving_briefs = db
    .prepare(
      `SELECT bs.brief_id, bs.title, bs.status, bs.priority
       FROM entity_edges e
       JOIN brief_status bs ON bs.brief_id = e.from_id
       WHERE e.to_type = 'goal'
         AND e.to_id = ?
         AND e.from_type = 'brief'
         AND e.edge_type = 'serves_goal'
         AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) != 1
       ORDER BY bs.brief_id ASC`,
    )
    .all(goalId) as ServingBrief[];

  return {
    goal,
    serving_briefs,
    serving_learnings_count: servingLearningsCount(db, goalId),
  };
}
