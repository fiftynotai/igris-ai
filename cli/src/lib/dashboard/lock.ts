/**
 * FR-238 (D4) — single-instance lockfile for `igris dashboard`.
 *
 * `~/.igris/dashboard.lock` records `{pid, port, url, started_at,
 * process_start_time}`. A second invocation reads it, classifies liveness with
 * the EXISTING `process-liveness.ts` primitives (`isProcessAlive` +
 * `getProcessStartTime`), and — when a live instance is found — re-opens the
 * browser at the running URL and exits 0 instead of binding a second port.
 *
 * Why pid alone is not enough: pids are recycled. A stale lock whose pid has
 * been reassigned to an unrelated process would make the verb permanently
 * refuse to start. Comparing `ps -o lstart=` against the recorded start time
 * makes the check pid-reuse-proof — the same reasoning (and the same helpers)
 * as the FR-190 instance-liveness model.
 *
 * Crash-safety (R5): a stale lock is ALWAYS reclaimable, so a hard kill can
 * never permanently wedge the verb. Release is idempotent and only ever
 * deletes a lock this process owns.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { dashboardLockPath } from "../paths.js";
import { getProcessStartTime, isProcessAlive } from "../process-liveness.js";
import type { DashboardLock } from "../../types.js";

/** Why a lock is not usable as evidence of a live instance. */
export type LockStaleReason =
  | "absent"
  | "unreadable"
  | "malformed"
  | "dead_pid"
  | "pid_reused";

export type LockState =
  | { kind: "live"; lock: DashboardLock }
  | { kind: "stale"; reason: LockStaleReason; lock: DashboardLock | null };

function isDashboardLock(value: unknown): value is DashboardLock {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pid === "number" &&
    Number.isInteger(v.pid) &&
    v.pid > 0 &&
    typeof v.port === "number" &&
    typeof v.url === "string" &&
    typeof v.started_at === "string" &&
    (v.process_start_time === null || typeof v.process_start_time === "string")
  );
}

/** Read the lockfile. Returns null when absent, unreadable, or malformed. */
export function readLock(): DashboardLock | null {
  const path = dashboardLockPath();
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isDashboardLock(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Classify the current lockfile.
 *
 * `live` means a second invocation MUST NOT bind — it should re-open
 * `lock.url` and exit 0. Every other outcome means the lock may be reclaimed.
 */
export function inspectLock(): LockState {
  const path = dashboardLockPath();
  if (!existsSync(path)) return { kind: "stale", reason: "absent", lock: null };

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { kind: "stale", reason: "unreadable", lock: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "stale", reason: "malformed", lock: null };
  }
  if (!isDashboardLock(parsed)) {
    return { kind: "stale", reason: "malformed", lock: null };
  }
  const lock = parsed;

  if (!isProcessAlive(lock.pid)) {
    return { kind: "stale", reason: "dead_pid", lock };
  }

  // Pid is alive — but is it OUR process, or a recycled pid? A recorded
  // start-time of null means the writer could not read `ps`; in that case the
  // liveness check degrades to pid-only rather than declaring a live lock
  // stale (a false "stale" would double-bind, which is the worse failure).
  if (lock.process_start_time !== null) {
    const current = getProcessStartTime(lock.pid);
    if (current === null || current !== lock.process_start_time) {
      return { kind: "stale", reason: "pid_reused", lock };
    }
  }

  return { kind: "live", lock };
}

/**
 * Write the lockfile atomically (tmp + rename), creating the brain dir if
 * needed. Atomicity matters because `inspectLock` reads it concurrently from a
 * second invocation: a torn write would read as `malformed` and be reclaimed,
 * producing a double-bind.
 */
export function writeLock(input: {
  pid: number;
  port: number;
  url: string;
}): DashboardLock {
  const path = dashboardLockPath();
  mkdirSync(dirname(path), { recursive: true });

  const lock: DashboardLock = {
    pid: input.pid,
    port: input.port,
    url: input.url,
    started_at: new Date().toISOString(),
    process_start_time: getProcessStartTime(input.pid),
  };

  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  // The `mode` above is the open(2) mode argument: it applies ONLY when the
  // file is created, and is silently ignored when it already exists. The tmp
  // name is keyed on OUR pid, so a crash between write and rename leaves a file
  // that a later run of the same pid reuses — and a permissive mode on that
  // leftover would survive the rewrite and be carried onto the real lock by the
  // rename below. chmod unconditionally so the mode is a property of the write,
  // not of whether the write happened to create the file.
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return lock;
}

/**
 * Delete the lockfile IF it belongs to `pid`. Idempotent and never throws —
 * it runs from signal handlers, where a throw would mask the shutdown.
 *
 * The ownership check stops a crashed-then-restarted instance from deleting the
 * live instance's lock on its way out.
 */
export function releaseLock(pid: number = process.pid): boolean {
  const path = dashboardLockPath();
  try {
    if (!existsSync(path)) return false;
    const lock = readLock();
    if (lock !== null && lock.pid !== pid) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}
