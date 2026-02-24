/**
 * Brain Engine v5.0 — Schedule Daemon
 *
 * Smart-sleep daemon that runs in-process via setTimeout.
 * Queries the database for the next due schedule, sleeps until
 * that time, then fires all due schedules.
 *
 * Features:
 * - Smart sleep: only wakes when the next schedule is due
 * - Double-fire guard: skips schedules with a 'running' run
 * - Recalculate: external trigger to re-query and reset timer
 * - Graceful stop: clears timeout on shutdown
 *
 * @module engine/components/schedules/daemon
 * @author Fifty.ai
 */

import { getDb } from '../../../db.js';
import { nextRunAfter } from './cron.js';
import { now, generateRunId, executeWithRetries } from './utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context required by the daemon for dispatching and event emission */
export interface DaemonContext {
  getDispatch: () => ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null;
  bus: { emit: (event: string, data: Record<string, unknown>) => void };
}

/** Handle returned by startDaemon for external control */
export interface DaemonHandle {
  /** Re-query the database and reset the timer (e.g. after a new schedule is created) */
  recalculate: () => void;
  /** Stop the daemon and clear the timer */
  stop: () => void;
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
 * @returns A handle with recalculate() and stop() methods
 */
export function startDaemon(ctx: DaemonContext): DaemonHandle {
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Execute a single due schedule: create run, execute handler, update records.
   */
  async function fireSchedule(schedule: Record<string, unknown>): Promise<void> {
    const scheduleId = schedule.id as string;
    const db = getDb();

    // Double-fire guard: skip if a run is already in 'running' status
    const activeRun = db.prepare(
      "SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND status = 'running' LIMIT 1"
    ).get(scheduleId) as Record<string, unknown> | undefined;

    if (activeRun) {
      return;
    }

    const runId = generateRunId();
    const startedAt = now();
    const dispatchTool = ctx.getDispatch();

    // Create run record
    db.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, status, started_at, attempt)
      VALUES (?, ?, 'running', ?, 1)
    `).run(runId, scheduleId, startedAt);

    ctx.bus.emit('schedule.run_start', { schedule_id: scheduleId, run_id: runId });

    // Execute handler with retry support
    const startTime = Date.now();
    const { outcome, attempt } = await executeWithRetries(schedule, dispatchTool);
    const durationMs = Date.now() - startTime;
    const finishedAt = now();

    // Update run record with actual attempt count
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

    // Recompute next_run_at and update last_run_at
    let nextRun: string | null = null;
    try {
      nextRun = nextRunAfter(schedule.cron_expr as string);
    } catch {
      // If cron can't compute, leave null
    }

    db.prepare(`
      UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?
    `).run(finishedAt, nextRun, finishedAt, scheduleId);

    ctx.bus.emit('schedule.run_complete', {
      schedule_id: scheduleId,
      run_id: runId,
      status: outcome.status,
    });
  }

  /**
   * Main tick: query all due schedules and fire them.
   */
  async function tick(): Promise<void> {
    if (!running) return;

    try {
      const db = getDb();
      const currentTime = now();

      // Find all due schedules
      const dueSchedules = db.prepare(`
        SELECT * FROM schedules
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC
      `).all(currentTime) as Record<string, unknown>[];

      // Fire each due schedule
      for (const schedule of dueSchedules) {
        try {
          await fireSchedule(schedule);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[schedules] Error firing schedule ${schedule.id}: ${message}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[schedules] Daemon tick error: ${message}`);
    }

    // Schedule next tick
    if (running) {
      scheduleNextTick();
    }
  }

  /**
   * Determine when the next schedule is due and set a timer.
   */
  function scheduleNextTick(): void {
    if (!running) return;

    try {
      const db = getDb();

      // Find the next due schedule
      const next = db.prepare(`
        SELECT next_run_at FROM schedules
        WHERE enabled = 1 AND next_run_at IS NOT NULL
        ORDER BY next_run_at ASC
        LIMIT 1
      `).get() as { next_run_at: string } | undefined;

      if (!next) {
        // No schedules — sleep for default interval
        timer = setTimeout(() => { void tick(); }, DEFAULT_SLEEP_MS);
        return;
      }

      const nextTime = Date.parse(next.next_run_at);

      // Guard against corrupted next_run_at — NaN delay would fire immediately,
      // causing a tight infinite loop
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
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[schedules] Error scheduling next tick: ${message}`);
      // Retry after default interval on error
      timer = setTimeout(() => { void tick(); }, DEFAULT_SLEEP_MS);
    }
  }

  // Start the daemon
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
  };
}
