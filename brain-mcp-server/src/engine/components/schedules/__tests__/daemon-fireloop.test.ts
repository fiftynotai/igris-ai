/**
 * Schedule daemon — fire-loop correctness tests (BR-067).
 *
 * BR-067 root cause: the daemon recomputed `next_run_at` AFTER the async
 * handler ran, from an implicit `new Date()`. Under handler-duration drift
 * the recomputed value could land in the past, so the schedule re-fired
 * immediately — 20–76× per hour instead of 1×, cascading into a host-pinning
 * brain-mcp-server spawn-storm.
 *
 * These tests drive the daemon's `tickOnce()` deterministically against an
 * in-memory DB injected via `DaemonContext.getDb` (the dependency-injection
 * seam) and assert:
 *   1. A correctly-spaced schedule fires exactly once per cron slot — no
 *      re-fire — even under a SLOW handler (the drift scenario).
 *   2. `next_run_at` is always strictly in the future after a fire.
 *   3. Rapid back-to-back ticks within the same cron slot do not double-fire.
 *   4. A re-entrant tick (one started while another is in flight) does not
 *      double-fire and does not drop the legitimate fire.
 *   5. A legitimately-due schedule (positive case) still fires — the fix
 *      eliminates re-fires, it must not skip real fires.
 *
 * @module engine/components/schedules/__tests__/daemon-fireloop.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { startDaemon } from '../daemon.js';
import type { DaemonHandle } from '../daemon.js';
import { scheduleMigrations } from '../schema.js';

// ---------------------------------------------------------------------------
// Test DB
// ---------------------------------------------------------------------------

function createScheduleDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  for (const m of scheduleMigrations) db.exec(m.sql);
  return db;
}

/**
 * Insert a schedule whose `next_run_at` is in the past so the next tick
 * sees it as due. `cron` defaults to hourly (`0 * * * *`).
 */
function seedDueSchedule(
  db: Database.Database,
  opts: { id?: string; cron?: string; nextRunAt?: string } = {},
): string {
  const id = opts.id ?? 'sch-test01';
  const cron = opts.cron ?? '0 * * * *';
  // Default: due one hour ago.
  const nextRunAt = opts.nextRunAt ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO schedules (id, name, cron_expr, handler_type, handler_config, enabled, next_run_at)
    VALUES (?, ?, ?, 'noop', '{}', 1, ?)
  `).run(id, `test ${id}`, cron, nextRunAt);
  return id;
}

function runCount(db: Database.Database, scheduleId: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM schedule_runs WHERE schedule_id = ?',
  ).get(scheduleId) as { c: number };
  return row.c;
}

function nextRunAt(db: Database.Database, scheduleId: string): string | null {
  const row = db.prepare('SELECT next_run_at FROM schedules WHERE id = ?')
    .get(scheduleId) as { next_run_at: string | null };
  return row.next_run_at;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('schedule daemon — fire-loop correctness (BR-067)', () => {
  let db: Database.Database;
  let daemon: DaemonHandle | null = null;

  beforeEach(() => {
    db = createScheduleDb();
  });

  afterEach(() => {
    if (daemon) {
      daemon.stop();
      daemon = null;
    }
    db.close();
  });

  it('fires a due schedule exactly once on a single tick', async () => {
    const id = seedDueSchedule(db);
    daemon = startDaemon({ getDispatch: () => null, bus: { emit: () => {} }, getDb: () => db });

    await daemon.tickOnce();

    expect(runCount(db, id)).toBe(1);
  });

  it('advances next_run_at strictly into the future after a fire', async () => {
    const id = seedDueSchedule(db);
    daemon = startDaemon({ getDispatch: () => null, bus: { emit: () => {} }, getDb: () => db });
    const before = Date.now();

    await daemon.tickOnce();

    const next = nextRunAt(db, id);
    expect(next).not.toBeNull();
    expect(Date.parse(next as string)).toBeGreaterThan(before);
  });

  it('does NOT re-fire on a second tick within the same cron slot', async () => {
    const id = seedDueSchedule(db);
    daemon = startDaemon({ getDispatch: () => null, bus: { emit: () => {} }, getDb: () => db });

    // First tick fires the schedule and advances next_run_at to the next
    // hour boundary. Subsequent ticks in the same slot must NOT re-fire.
    await daemon.tickOnce();
    await daemon.tickOnce();
    await daemon.tickOnce();

    expect(runCount(db, id)).toBe(1);
  });

  it('does NOT re-fire under a SLOW handler (the BR-067 drift scenario)', async () => {
    // mcp-tool handler whose dispatch resolves after a delay — this models
    // the 1–320ms+ handler durations the diagnosis observed. Pre-fix, the
    // post-handler `new Date()` recompute drifted the next run into the past.
    db.prepare(`
      INSERT INTO schedules (id, name, cron_expr, handler_type, handler_config, enabled, next_run_at)
      VALUES ('sch-slow01', 'slow', '0 * * * *', 'mcp-tool', ?, 1, ?)
    `).run(
      JSON.stringify({ tool: 'noop_tool', args: {} }),
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    );

    const slowDispatch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true };
    });

    daemon = startDaemon({
      getDispatch: () => slowDispatch,
      bus: { emit: () => {} },
      getDb: () => db,
    });

    await daemon.tickOnce();
    // A drift-recompute would have left next_run_at in the past — a second
    // tick would then re-fire. Assert it does not.
    await daemon.tickOnce();

    expect(runCount(db, 'sch-slow01')).toBe(1);
    const next = nextRunAt(db, 'sch-slow01');
    expect(Date.parse(next as string)).toBeGreaterThan(Date.now());
  });

  it('does NOT double-fire under rapid back-to-back ticks', async () => {
    const id = seedDueSchedule(db);
    daemon = startDaemon({ getDispatch: () => null, bus: { emit: () => {} }, getDb: () => db });

    // Fire many ticks as fast as possible. The re-entrancy guard makes all
    // but the first a no-op while in flight; the atomic claim makes the
    // rest no-ops because next_run_at has already advanced.
    await Promise.all([
      daemon.tickOnce(),
      daemon.tickOnce(),
      daemon.tickOnce(),
      daemon.tickOnce(),
      daemon.tickOnce(),
    ]);

    expect(runCount(db, id)).toBe(1);
  });

  it('does NOT double-fire when a re-entrant tick overlaps an in-flight tick', async () => {
    // A slow handler keeps tick #1 in flight while we fire tick #2. The
    // re-entrancy guard must reject the overlap and the slot must fire once.
    db.prepare(`
      INSERT INTO schedules (id, name, cron_expr, handler_type, handler_config, enabled, next_run_at)
      VALUES ('sch-reentry', 'reentry', '0 * * * *', 'mcp-tool', ?, 1, ?)
    `).run(
      JSON.stringify({ tool: 'noop_tool', args: {} }),
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    );
    const slowDispatch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { ok: true };
    });
    daemon = startDaemon({
      getDispatch: () => slowDispatch,
      bus: { emit: () => {} },
      getDb: () => db,
    });

    const inFlight = daemon.tickOnce();      // tick #1 — starts the slow handler
    await daemon.tickOnce();                  // tick #2 — fires while #1 in flight
    await inFlight;

    expect(runCount(db, 'sch-reentry')).toBe(1);
  });

  it('still fires a legitimately-due schedule across cron slots (no skipped fires)', async () => {
    // Positive case: the fix must not over-correct and SKIP real fires.
    const id = seedDueSchedule(db, { cron: '0 * * * *' });
    daemon = startDaemon({ getDispatch: () => null, bus: { emit: () => {} }, getDb: () => db });

    // Slot 1.
    await daemon.tickOnce();
    expect(runCount(db, id)).toBe(1);

    // Simulate the next cron slot arriving by rewinding next_run_at into
    // the past again (as wall-clock time would do an hour later).
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), id);

    // Slot 2 — a genuinely-due schedule must fire again.
    await daemon.tickOnce();
    expect(runCount(db, id)).toBe(2);
  });

  it('does not fire a schedule whose next_run_at is in the future', async () => {
    // Negative case: a not-yet-due schedule must be left alone.
    const id = seedDueSchedule(db, {
      nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    daemon = startDaemon({ getDispatch: () => null, bus: { emit: () => {} }, getDb: () => db });

    await daemon.tickOnce();

    expect(runCount(db, id)).toBe(0);
  });

  it('does not fire a disabled schedule', async () => {
    const id = seedDueSchedule(db);
    db.prepare('UPDATE schedules SET enabled = 0 WHERE id = ?').run(id);
    daemon = startDaemon({ getDispatch: () => null, bus: { emit: () => {} }, getDb: () => db });

    await daemon.tickOnce();

    expect(runCount(db, id)).toBe(0);
  });

  it('skips a schedule with an already-running run (overlap guard)', async () => {
    const id = seedDueSchedule(db);
    // Pre-existing 'running' run — models a long-running prior fire.
    db.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, status, started_at, attempt)
      VALUES ('run-stuck', ?, 'running', ?, 1)
    `).run(id, new Date().toISOString());

    daemon = startDaemon({ getDispatch: () => null, bus: { emit: () => {} }, getDb: () => db });
    await daemon.tickOnce();

    // No NEW run created — only the pre-existing 'running' one remains.
    expect(runCount(db, id)).toBe(1);
    const stillRunning = db.prepare(
      "SELECT COUNT(*) AS c FROM schedule_runs WHERE schedule_id = ? AND status = 'running'",
    ).get(id) as { c: number };
    expect(stillRunning.c).toBe(1);
  });
});
