/**
 * Brain Engine v7.0 — Schedule Daemon
 *
 * Smart-sleep daemon that runs in-process via setTimeout.
 * Queries the database for the next due schedule, sleeps until
 * that time, then fires all due schedules.
 *
 * Features:
 * - Smart sleep: only wakes when the next schedule is due
 * - Double-fire guard: skips schedules with a 'running' run AND
 *   skips schedules whose cron slot has already been fired (BR-067)
 * - Atomic claim: SELECT-due + UPDATE next_run_at run inside a single
 *   IMMEDIATE transaction so a rapid/re-entrant tick cannot observe a
 *   stale next_run_at and double-fire (BR-067)
 * - Re-entrancy guard: a tick already in flight cannot be overlapped
 *   by a recalculate()-triggered tick (BR-067)
 * - Recalculate: external trigger to re-query and reset timer
 * - Graceful stop: clears timeout on shutdown
 *
 * @module engine/components/schedules/daemon
 * @author fifty.dev
 */

import type { Database } from 'better-sqlite3';
import { getDb } from '../../../db.js';
import { errMsg } from '../../helpers.js';
import { nextRunAfter } from './cron.js';
import { now, generateRunId, executeWithRetries } from './utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context required by the daemon for dispatching and event emission */
export interface DaemonContext {
  getDispatch: () => ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null;
  bus: { emit: (event: string, data: Record<string, unknown>) => void };
  /**
   * Optional database accessor. Defaults to the production `getDb()` singleton.
   * Tests inject an in-memory `better-sqlite3` connection here so the daemon's
   * fire-loop can be exercised against a sandbox DB without touching the
   * global brain DB — this is the dependency-injection seam the BR-067
   * fire-loop tests spy at (per coding_guidelines §12 "spy at dependency
   * boundaries").
   */
  getDb?: () => Database;
}

/** Handle returned by startDaemon for external control */
export interface DaemonHandle {
  /** Re-query the database and reset the timer (e.g. after a new schedule is created) */
  recalculate: () => void;
  /** Stop the daemon and clear the timer */
  stop: () => void;
  /**
   * Run a single tick synchronously-awaitable. Exposed for tests so the
   * fire-loop can be driven deterministically without waiting on setTimeout.
   * @internal
   */
  tickOnce: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default sleep interval when no schedules are found (1 hour) */
const DEFAULT_SLEEP_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

/**
 * Start the schedule daemon.
 *
 * The daemon queries for the next due schedule, sleeps until that time,
 * then fires all due schedules. After firing, it recomputes next_run_at
 * for each schedule and loops.
 *
 * @param ctx - Daemon context with dispatch and bus
 * @returns A handle with recalculate(), stop() and tickOnce() methods
 */
export function startDaemon(ctx: DaemonContext): DaemonHandle {
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Re-entrancy guard (BR-067). `recalculate()` clears the timer and
   * re-runs `scheduleNextTick()`; without this flag a recalculate()-
   * triggered tick could overlap a tick already in flight and double-fire.
   * Set true for the entire duration of `tick()`, including the async
   * handler execution.
   */
  let ticking = false;

  /** Resolve the active DB — the production singleton unless a test injects one. */
  const resolveDb = ctx.getDb ?? getDb;

  /**
   * Atomically claim a due schedule for firing (BR-067).
   *
   * Inside a single `BEGIN IMMEDIATE` transaction this:
   *   1. Re-reads the schedule row (the in-memory copy from the SELECT-due
   *      query may already be stale).
   *   2. Rejects the claim if the schedule was disabled, deleted, or its
   *      `next_run_at` already advanced past `claimTime` (a concurrent or
   *      rapid re-entrant tick already claimed this cron slot).
   *   3. Rejects the claim if a run is already `'running'` (overlap guard).
   *   4. Computes the next run anchored to `fireStartIso` — a STABLE instant
   *      captured before the handler runs, never a post-handler `new Date()`
   *      — and writes it back immediately.
   *
   * Because the next_run_at UPDATE commits before the transaction releases,
   * the schedule cannot be re-selected as due by a subsequent tick. The
   * async handler then runs OUTSIDE this transaction (the lock is NOT held
   * across the handler — per the BR-067 plan's risk table).
   *
   * @returns the claimed schedule row, or null if the claim was rejected.
   */
  function claimSchedule(
    db: Database,
    scheduleId: string,
    claimTime: string,
    fireStartIso: string,
  ): Record<string, unknown> | null {
    const claim = db.transaction((): Record<string, unknown> | null => {
      // Re-read the authoritative row inside the lock.
      const row = db.prepare('SELECT * FROM schedules WHERE id = ?')
        .get(scheduleId) as Record<string, unknown> | undefined;

      if (!row) return null;
      if (row.enabled !== 1) return null;

      // Sequential-refire guard: if next_run_at already advanced past the
      // tick's claim time, another (possibly re-entrant) tick already
      // claimed this cron slot. Reject — never double-fire a single slot.
      const nextRunAt = row.next_run_at as string | null;
      if (nextRunAt === null || nextRunAt > claimTime) {
        return null;
      }

      // Overlap guard: a run is still in 'running' status.
      const activeRun = db.prepare(
        "SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND status = 'running' LIMIT 1",
      ).get(scheduleId) as Record<string, unknown> | undefined;
      if (activeRun) return null;

      // Compute the next run anchored to the STABLE fire-start instant.
      // This is the BR-067 root-cause fix: nextRunAfter() previously used
      // an implicit post-handler `new Date()`, which under handler-duration
      // drift could land in the past and re-fire immediately.
      let nextRun: string | null = null;
      try {
        nextRun = nextRunAfter(row.cron_expr as string, fireStartIso);
      } catch {
        // If cron can't compute, leave null — the schedule will not be
        // re-selected as due (next_run_at IS NULL filters it out).
      }

      // Advance next_run_at immediately so this cron slot cannot be
      // re-claimed by a concurrent/subsequent tick. last_run_at is set
      // here too (to the fire-start instant) so post-handler completion
      // does not need to touch next_run_at again.
      db.prepare(
        'UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
      ).run(fireStartIso, nextRun, fireStartIso, scheduleId);

      return row;
    });

    return claim.immediate();
  }

  /**
   * Execute a single due schedule: claim atomically, create run record,
   * execute handler (outside the claim lock), update the run record.
   *
   * @param schedule - the schedule row from the SELECT-due query (may be stale)
   * @param claimTime - the tick's currentTime; used as the slot-claim cutoff
   */
  async function fireSchedule(
    schedule: Record<string, unknown>,
    claimTime: string,
  ): Promise<void> {
    const scheduleId = schedule.id as string;
    const db = resolveDb();

    // Capture the STABLE fire-start instant BEFORE any async work. The next
    // run is anchored to this instant, never to a post-handler clock read.
    const fireStartIso = now();

    // Atomically claim the slot (re-validate + advance next_run_at).
    const claimed = claimSchedule(db, scheduleId, claimTime, fireStartIso);
    if (!claimed) {
      // Slot already claimed / schedule disabled / overlapping run — skip.
      return;
    }

    const runId = generateRunId();
    const dispatchTool = ctx.getDispatch();

    // Create the run record.
    db.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, status, started_at, attempt)
      VALUES (?, ?, 'running', ?, 1)
    `).run(runId, scheduleId, fireStartIso);

    ctx.bus.emit('schedule.run_start', { schedule_id: scheduleId, run_id: runId });

    // Execute handler with retry support — OUTSIDE the claim transaction.
    // The IMMEDIATE lock is intentionally NOT held across this await
    // (BR-067 risk mitigation: holding it would block the single-connection
    // engine for the handler's full duration).
    const startTime = Date.now();
    const { outcome, attempt } = await executeWithRetries(claimed, dispatchTool);
    const durationMs = Date.now() - startTime;
    const finishedAt = now();

    // Update run record with the final outcome. next_run_at / last_run_at
    // were already written in the claim transaction — completion only
    // updates the run row, so a slow handler cannot un-advance next_run_at.
    db.prepare(`
      UPDATE schedule_runs
      SET status = ?, finished_at = ?, duration_ms = ?, result = ?, error = ?, attempt = ?
      WHERE id = ?
    `).run(
      outcome.status,
      finishedAt,
      durationMs,
      outcome.result ?? null,
      outcome.error ?? null,
      attempt,
      runId,
    );

    ctx.bus.emit('schedule.run_complete', {
      schedule_id: scheduleId,
      run_id: runId,
      status: outcome.status,
    });
  }

  /**
   * Main tick: query all due schedules and fire them.
   *
   * Re-entrancy guarded (BR-067): if a tick is already in flight, this
   * returns immediately. The in-flight tick reschedules itself on
   * completion, so no fire is dropped.
   */
  async function tick(): Promise<void> {
    if (!running) return;

    // Re-entrancy guard: a tick already in flight (e.g. a recalculate()
    // fired during the async handler) must not overlap. The in-flight
    // tick's own scheduleNextTick() at the end covers any newly-due work.
    if (ticking) return;
    ticking = true;

    try {
      const db = resolveDb();
      const currentTime = now();

      // Find all due schedules.
      const dueSchedules = db.prepare(`
        SELECT * FROM schedules
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC
      `).all(currentTime) as Record<string, unknown>[];

      // Fire each due schedule. fireSchedule re-validates and atomically
      // claims the slot, so a stale row from this SELECT cannot double-fire.
      for (const schedule of dueSchedules) {
        try {
          await fireSchedule(schedule, currentTime);
        } catch (err) {
          console.error(`[schedules] Error firing schedule ${schedule.id}: ${errMsg(err)}`);
        }
      }
    } catch (err) {
      console.error(`[schedules] Daemon tick error: ${errMsg(err)}`);
    } finally {
      ticking = false;
    }

    // Schedule next tick.
    if (running) {
      scheduleNextTick();
    }
  }

  /**
   * Determine when the next schedule is due and set a timer.
   */
  function scheduleNextTick(): void {
    if (!running) return;

    // If a tick is in flight, do not arm a second timer — the in-flight
    // tick reschedules itself when it finishes.
    if (ticking) return;

    try {
      const db = resolveDb();

      // Find the next due schedule.
      const next = db.prepare(`
        SELECT next_run_at FROM schedules
        WHERE enabled = 1 AND next_run_at IS NOT NULL
        ORDER BY next_run_at ASC
        LIMIT 1
      `).get() as { next_run_at: string } | undefined;

      if (!next) {
        // No schedules — sleep for default interval.
        timer = setTimeout(() => { void tick(); }, DEFAULT_SLEEP_MS);
        return;
      }

      const nextTime = Date.parse(next.next_run_at);

      // Guard against corrupted next_run_at — NaN delay would fire immediately,
      // causing a tight infinite loop.
      if (isNaN(nextTime)) {
        console.error(
          `[schedules] Invalid next_run_at for next due schedule: "${next.next_run_at}"`,
        );
        timer = setTimeout(() => { void tick(); }, DEFAULT_SLEEP_MS);
        return;
      }

      const delay = Math.max(0, nextTime - Date.now());

      timer = setTimeout(() => { void tick(); }, delay);
    } catch (err) {
      console.error(`[schedules] Error scheduling next tick: ${errMsg(err)}`);
      // Retry after default interval on error.
      timer = setTimeout(() => { void tick(); }, DEFAULT_SLEEP_MS);
    }
  }

  // Start the daemon.
  scheduleNextTick();

  return {
    recalculate(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (running) {
        scheduleNextTick();
      }
    },

    stop(): void {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },

    tickOnce(): Promise<void> {
      return tick();
    },
  };
}
