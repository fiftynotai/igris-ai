/**
 * TD-361 — schedule-run OWNER liveness: every `running` row records the process
 * that owns it, and a sweep fails a row only when that owner provably cannot
 * finish it. Never by age (a healthy janitor run took 74.7 min). Rationale and
 * the full verdict table: docs/COGNITION.md "How a wedge is released".
 * @module engine/components/schedules/run-liveness
 */

import type { Database } from 'better-sqlite3';
import { realpathSync } from 'node:fs';
import { isSameMachine, readMachineIdentity, type MachineIdentity } from '../../../machine-identity.js';
import { getProcessElapsedMs, getProcessStartTime, isProcessAlive } from '../../../process-liveness.js';
import { readInstanceRegistry } from '../../../stdio-lifecycle.js';
import { now } from '../../helpers.js';

/** The `schedule_runs` columns the classifier reads; owner columns are absent/NULL on a legacy row. */
export interface RunOwnerRow {
  id: string;
  started_at: string | null;
  machine_id?: string | null;
  machine_hostname?: string | null;
  owner_pid?: number | null;
  owner_started_at?: string | null;
}

/** Every fact and probe the classifier needs, injected so the classifier stays pure. */
export interface LivenessEnv {
  me: MachineIdentity;
  selfPid: number;
  selfStartedAt: string | null;
  inFlight: ReadonlySet<string>;
  isAlive: (pid: number) => boolean;
  startTimeOf: (pid: number) => string | null;
  /** Earliest start (epoch ms) of any live brain process that could own a row here; null = unknown. */
  legacyHorizonMs: number | null;
}

export type RunOwnerReason =
  | 'owner_foreign_machine' | 'self_in_flight' | 'self_not_in_flight' | 'owner_dead'
  | 'owner_pid_reused' | 'pid_only_unverified' | 'pid_start_time'
  | 'legacy_predates_live_processes' | 'legacy_unprovable';

export interface RunOwnerVerdict {
  alive: boolean;
  reason: RunOwnerReason;
}

/** Run ids a process is executing right now. Process-global: shared by every daemon and fire_now. */
export const inFlightRuns = new Set<string>();

/** `started_at` → epoch ms; the SQLite `YYYY-MM-DD HH:MM:SS` form (no zone) is UTC, never local. */
export function normalizeStartedAt(s: string | null | undefined): number | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(t);
  const ms = Date.parse(zoned ? t : `${t.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Classify one `running` row. DEAD only when the owner provably cannot finish it; unknown ⇒ ALIVE. */
export function classifyRunOwner(row: RunOwnerRow, env: LivenessEnv): RunOwnerVerdict {
  const pid = row.owner_pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    const started = normalizeStartedAt(row.started_at);
    if (env.legacyHorizonMs !== null && started !== null && started < env.legacyHorizonMs) {
      return { alive: false, reason: 'legacy_predates_live_processes' };
    }
    return { alive: true, reason: 'legacy_unprovable' };
  }
  if (!isSameMachine({ machine_id: row.machine_id ?? null, machine_hostname: row.machine_hostname ?? null }, env.me)) {
    return { alive: false, reason: 'owner_foreign_machine' };
  }
  const stamped = row.owner_started_at ?? null;
  if (pid === env.selfPid && stamped === env.selfStartedAt) {
    return env.inFlight.has(row.id)
      ? { alive: true, reason: 'self_in_flight' }
      : { alive: false, reason: 'self_not_in_flight' };
  }
  if (!env.isAlive(pid)) return { alive: false, reason: 'owner_dead' };
  if (stamped === null) return { alive: true, reason: 'pid_only_unverified' };
  const current = env.startTimeOf(pid);
  if (current === null) return { alive: true, reason: 'pid_only_unverified' };
  return current === stamped
    ? { alive: true, reason: 'pid_start_time' }
    : { alive: false, reason: 'owner_pid_reused' };
}

function realOrNull(p: string | null | undefined): string | null {
  if (typeof p !== 'string' || p.length === 0) return null;
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Earliest start among this process and every LIVE pidfile-registry process on
 * the same DB file (a record on a provably different file is skipped; an
 * unresolvable path is kept). Null on any probe failure — nothing is reaped.
 */
export function computeLegacyHorizon(dbPath: string | null): number | null {
  try {
    let horizon = Date.now() - process.uptime() * 1000;
    const mine = realOrNull(dbPath);
    for (const { record } of readInstanceRegistry()) {
      if (record.pid === process.pid || !isProcessAlive(record.pid)) continue;
      const theirs = realOrNull(record.db_path);
      if (mine !== null && theirs !== null && mine !== theirs) continue;
      const elapsed = getProcessElapsedMs(record.pid);
      if (elapsed === null) return null;
      horizon = Math.min(horizon, Date.now() - elapsed - 1000); // etime floors to the second
    }
    return horizon;
  } catch {
    return null;
  }
}

let selfStartedAt: string | null | undefined;

function ownStartTime(): string | null {
  if (selfStartedAt === undefined) selfStartedAt = getProcessStartTime(process.pid);
  return selfStartedAt;
}

/** The owner columns every `running`-row writer stamps. */
export function ownerStamp(): {
  machine_id: string | null; machine_hostname: string; owner_pid: number; owner_started_at: string | null;
} {
  const me = readMachineIdentity();
  return { machine_id: me.machine_id, machine_hostname: me.hostname, owner_pid: process.pid, owner_started_at: ownStartTime() };
}

const ownerColumnsCache = new WeakMap<Database, boolean>();

function hasOwnerColumns(db: Database): boolean {
  let has = ownerColumnsCache.get(db);
  if (has === undefined) {
    const cols = (db.prepare('PRAGMA table_info(schedule_runs)').all() as { name: string }[]).map((c) => c.name);
    has = cols.includes('owner_pid');
    ownerColumnsCache.set(db, has);
  }
  return has;
}

/**
 * The ONE writer of a `running` row: stamps the owner (column-tolerant — an
 * un-migrated DB gets the legacy shape) and registers the id in
 * {@link inFlightRuns}. A writer that bypasses this is reaped as `self_not_in_flight`.
 */
export function insertRunningRow(db: Database, runId: string, scheduleId: string, startedAt: string): void {
  if (hasOwnerColumns(db)) {
    const o = ownerStamp();
    db.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, status, started_at, attempt,
                                 machine_id, machine_hostname, owner_pid, owner_started_at)
      VALUES (?, ?, 'running', ?, 1, ?, ?, ?, ?)
    `).run(runId, scheduleId, startedAt, o.machine_id, o.machine_hostname, o.owner_pid, o.owner_started_at);
  } else {
    db.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, status, started_at, attempt)
      VALUES (?, ?, 'running', ?, 1)
    `).run(runId, scheduleId, startedAt);
  }
  inFlightRuns.add(runId);
}

/** Mark this process's own still-`running` runs `interrupted:` (graceful shutdown). Returns rows changed. */
export function interruptRuns(db: Database, runIds: Iterable<string>): number {
  const upd = db.prepare(
    "UPDATE schedule_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'",
  );
  const at = now();
  let n = 0;
  for (const id of runIds) {
    n += upd.run(at, 'interrupted: brain process shut down mid-run (TD-361)', id).changes;
  }
  return n;
}

/** One reaped row, for the caller to emit `schedule.run_complete` after commit. */
export interface ReapedRun {
  run_id: string;
  schedule_id: string;
  reason: RunOwnerReason;
  owner_pid: number | null;
}

/**
 * Probe every `running` row OUTSIDE any transaction, then fail the DEAD ones in
 * one IMMEDIATE transaction (`AND status = 'running'`, so a row that finished
 * meanwhile is left alone). `overrides` is the test seam over the real probes.
 */
export function sweepAbandonedRuns(db: Database, overrides: Partial<LivenessEnv> = {}): ReapedRun[] {
  ownStartTime(); // warm the cached `ps` probe here, so no claim transaction ever spawns it
  const rows = db.prepare("SELECT * FROM schedule_runs WHERE status = 'running'").all() as
    (RunOwnerRow & { schedule_id: string })[];
  if (rows.length === 0) return [];
  const needsHorizon = rows.some((r) => r.owner_pid === null || r.owner_pid === undefined);
  const env: LivenessEnv = {
    me: readMachineIdentity(),
    selfPid: process.pid,
    selfStartedAt: ownStartTime(),
    inFlight: inFlightRuns,
    isAlive: isProcessAlive,
    startTimeOf: getProcessStartTime,
    legacyHorizonMs: needsHorizon && !('legacyHorizonMs' in overrides) ? computeLegacyHorizon(db.name) : null,
    ...overrides,
  };
  const dead = rows
    .map((row) => ({ row, verdict: classifyRunOwner(row, env) }))
    .filter((x) => !x.verdict.alive);
  if (dead.length === 0) return [];

  const upd = db.prepare(
    "UPDATE schedule_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'",
  );
  const reaped: ReapedRun[] = [];
  db.transaction(() => {
    const at = now();
    for (const { row, verdict } of dead) {
      const where = row.machine_hostname ?? row.machine_id ?? 'unrecorded host';
      const error =
        `abandoned: owner ${row.owner_pid ?? 'unrecorded'} (${row.owner_started_at ?? 'no start time'}) on ${where} ` +
        `is not a live process on this machine [${verdict.reason}] — reaped by pid ${process.pid} (TD-361)`;
      if (upd.run(at, error, row.id).changes === 1) {
        reaped.push({ run_id: row.id, schedule_id: row.schedule_id, reason: verdict.reason, owner_pid: row.owner_pid ?? null });
      }
    }
  }).immediate();
  return reaped;
}
