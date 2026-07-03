/**
 * Brain Engine v7.1 — Cognition daily-budget gate (FR-118 M0).
 *
 * The daily-budget gate counts how many `cognition.<instance>.run_started`
 * rows landed in `event_log` TODAY (UTC) and reports whether another run is
 * within budget. Manual `*_run` MCP triggers and the cron schedule share ONE
 * envelope (brief decision R-BUDGET-DRAIN): both write `run_started`, both are
 * counted, so a flurry of manual runs cannot exhaust the day's budget unnoticed.
 *
 * Counting `run_started` (not a terminal event) means a run that is in-flight or
 * crashed still consumes budget — the gate is intentionally conservative: a
 * misbehaving instance burning runs is throttled even if none completes.
 *
 * @module engine/components/cognition/budget
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { eventName } from './lifecycle.js';

/** The verdict of the daily-budget gate for one prospective run. */
export interface BudgetVerdict {
  /** True when another run is allowed (today's count < budget). */
  withinBudget: boolean;
  /** How many `run_started` rows have been logged today (UTC). */
  usedToday: number;
  /** The configured daily budget. */
  budget: number;
  /** Runs remaining today (never negative). */
  remaining: number;
}

/**
 * Count today's (UTC) `cognition.<instance>.run_started` rows in `event_log`.
 *
 * Uses `date('now')` (SQLite UTC date) compared against `date(created_at)` so
 * the window is a calendar day, not a rolling 24h — matching how the operator
 * reads "suggested_today" in /scan. `created_at` is written by the lifecycle
 * writer with `datetime('now')` (UTC), so the comparison is apples-to-apples.
 *
 * @param db         the brain DB
 * @param instanceId the instance id
 */
export function countRunsToday(db: Database.Database, instanceId: string): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM event_log
          WHERE event_name = ?
            AND date(created_at) = date('now')`,
      )
      .get(eventName(instanceId, 'run_started')) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    // event_log absent / query failure → treat as zero used so the gate never
    // hard-fails a run on an observability hiccup (fail-open: budget is a
    // throttle, not a correctness gate).
    return 0;
  }
}

/**
 * Evaluate the daily-budget gate for one prospective run.
 *
 * A non-positive `budget` is treated as "no limit" (`Infinity`) — an instance
 * that does not want budget throttling sets `daily_budget: 0`. Otherwise the
 * run is within budget iff `usedToday < budget`.
 *
 * @param db         the brain DB
 * @param instanceId the instance id
 * @param budget     the configured `daily_budget` (≤0 ⇒ unlimited)
 */
export function evaluateBudget(
  db: Database.Database,
  instanceId: string,
  budget: number,
): BudgetVerdict {
  const usedToday = countRunsToday(db, instanceId);
  const effectiveBudget = budget > 0 ? budget : Number.POSITIVE_INFINITY;
  const withinBudget = usedToday < effectiveBudget;
  const remaining = Number.isFinite(effectiveBudget)
    ? Math.max(0, effectiveBudget - usedToday)
    : Number.POSITIVE_INFINITY;
  return { withinBudget, usedToday, budget, remaining };
}
