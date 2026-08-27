/**
 * Brain MCP Server — stdio lifecycle management (BR-067)
 *
 * A stdio MCP server's lifetime is bound to its client (a Claude Code
 * session). When the client exits the OS closes the pipe and the server's
 * stdin hits EOF — at which point the server must exit. This module provides:
 *
 *   - `installStdioTeardown()` — wires `process.stdin` EOF/close to a single
 *     idempotent shutdown function shared with the SIGINT/SIGTERM handlers
 *     (Phase 2 — the H2 teardown fix).
 *   - A per-client pidfile registry under `~/.igris/brain-mcp-server.pids/`
 *     plus an opportunistic stale-instance reaper (Phase 4 — the H3 fix).
 *
 * The reaper SIGTERMs ONLY instances that are provably orphaned: the
 * server process is alive but its recorded parent is dead. It never uses a
 * blunt `pkill` and never touches a server whose parent is still alive.
 *
 * @module stdio-lifecycle
 * @author fifty.dev
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Pidfile registry
// ---------------------------------------------------------------------------

/**
 * Directory holding one pidfile per live stdio brain-mcp-server instance.
 *
 * Resolved at call time (not module load). Precedence mirrors the middle tier
 * of `db.ts#resolveDbPath` (TD-426); empty strings fall through:
 *
 *   1. `IGRIS_PIDS_DIR`   — explicit registry override
 *   2. `IGRIS_BRAIN_DIR`  — sandboxed brain dir → `<dir>/brain-mcp-server.pids`
 *                           (a sandboxed boot must not write pidfiles into the
 *                           real ~/.igris — the build smoke guard did)
 *   3. default            — `~/.igris/brain-mcp-server.pids/`
 */
export function pidsDir(): string {
  const override = process.env.IGRIS_PIDS_DIR;
  if (override && override.length > 0) return override;
  const brainDir = process.env.IGRIS_BRAIN_DIR;
  if (brainDir && brainDir.length > 0) {
    return path.join(brainDir, 'brain-mcp-server.pids');
  }
  return path.join(os.homedir(), '.igris', 'brain-mcp-server.pids');
}

/** Shape of a pidfile record. */
export interface InstanceRecord {
  /** This server process's PID. */
  pid: number;
  /** The parent (client) process's PID at boot time. */
  ppid: number;
  /** ISO timestamp when the server booted. */
  started_at: string;
  /** Brain DB path this server is bound to. */
  db_path: string;
}

/**
 * Resolve the pidfile path for a given parent PID. Keyed by parent so the
 * registry caps redundant instances PER CLIENT — each Claude Code session
 * (one parent process) gets exactly one slot, while distinct live sessions
 * each legitimately get their own server.
 */
function pidfilePath(ppid: number): string {
  return path.join(pidsDir(), `${ppid}.json`);
}

/**
 * Check whether a process is alive. `process.kill(pid, 0)` sends no signal —
 * it only probes existence/permission. Returns false for a dead PID
 * (ESRCH) and true otherwise (including EPERM, which means the process
 * exists but is owned by another user — still "alive").
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM — process exists but we may not signal it. Treat as alive.
    return code === 'EPERM';
  }
}

/**
 * Register this server instance: write a pidfile keyed by parent PID.
 *
 * This is the singleton/liveness guard (Phase 4). It does NOT hard-exit
 * when a prior pidfile exists for the same parent — a stdio server cannot
 * "reuse" another process (Claude Code already spawned and connected to
 * THIS process on stdin). Instead it overwrites the slot, claiming it for
 * the current process. Any prior duplicate for the same parent is left to
 * the reaper, which will SIGTERM it once its parent dies.
 *
 * @returns the pidfile path written, or null if registration failed
 *          (registration failure is non-fatal — the server still runs).
 */
export function registerInstance(record: InstanceRecord): string | null {
  try {
    mkdirSync(pidsDir(), { recursive: true });
    const file = pidfilePath(record.ppid);
    writeFileSync(file, JSON.stringify(record), 'utf-8');
    return file;
  } catch (err) {
    console.error(`[brain] could not register instance pidfile: ${String(err)}`);
    return null;
  }
}

/**
 * Remove this instance's pidfile. Called from the shutdown path so a
 * cleanly-exiting server does not leave a stale registry entry.
 */
export function deregisterInstance(ppid: number): void {
  try {
    const file = pidfilePath(ppid);
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // Best-effort — a leftover pidfile is harmless (the reaper validates
    // liveness before acting on any entry).
  }
}

/**
 * Read and parse every pidfile in the registry. Malformed or unreadable
 * pidfiles are skipped (and reported), never thrown on.
 */
export function readInstanceRegistry(): Array<{ file: string; record: InstanceRecord }> {
  const out: Array<{ file: string; record: InstanceRecord }> = [];
  let entries: string[];
  const dir = pidsDir();
  try {
    entries = readdirSync(dir);
  } catch {
    // Registry dir does not exist yet — nothing registered.
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const raw = readFileSync(file, 'utf-8');
      const record = JSON.parse(raw) as InstanceRecord;
      if (
        typeof record.pid === 'number' &&
        typeof record.ppid === 'number'
      ) {
        out.push({ file, record });
      }
    } catch {
      console.error(`[brain] skipping malformed instance pidfile: ${file}`);
      // Best-effort prune of the malformed file so it doesn't accumulate
      // across sweeps. Same idempotency contract as the reaper's prune
      // (lines 201-206 / 227-232) — a concurrent unlink is fine.
      try { unlinkSync(file); } catch { /* ignore */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reaper
// ---------------------------------------------------------------------------

/** Result of a reap sweep — returned for logging and tests. */
export interface ReapResult {
  /** PIDs that were SIGTERM'd because they were provably orphaned. */
  reaped: number[];
  /** PIDs left alone because their parent is still alive. */
  skippedAlive: number[];
  /** Pidfiles removed because their server process was already dead. */
  prunedStale: string[];
}

/**
 * Opportunistic stale-instance reaper (Phase 4 — H3 fix).
 *
 * Scans the pidfile registry and, for each recorded instance:
 *   - If the server process is dead → prune the stale pidfile.
 *   - If the server is alive but its recorded parent is dead → the server
 *     is a provable orphan (reparented to launchd). SIGTERM it and prune
 *     the pidfile.
 *   - If the server is alive AND its parent is alive → leave it untouched
 *     (a live session legitimately owns it).
 *
 * `self` is the current process's PID — it is never reaped even though its
 * own parent could momentarily appear dead during a race.
 *
 * The reaper uses SIGTERM only — never SIGKILL, never `pkill`. A
 * brain-mcp-server responds cleanly to SIGTERM (verified during the BR-067
 * incident: all 62 orphans terminated without SIGKILL).
 *
 * @param self - the current process PID, exempt from reaping
 * @returns a {@link ReapResult} describing what the sweep did
 */
export function reapStaleInstances(self: number = process.pid): ReapResult {
  const result: ReapResult = { reaped: [], skippedAlive: [], prunedStale: [] };

  for (const { file, record } of readInstanceRegistry()) {
    // Never act on our own pidfile.
    if (record.pid === self) continue;

    const serverAlive = isProcessAlive(record.pid);

    if (!serverAlive) {
      // The server is gone — its pidfile is stale. Prune it.
      try {
        unlinkSync(file);
        result.prunedStale.push(file);
      } catch {
        // Already removed by a concurrent sweep — fine.
      }
      continue;
    }

    // Server is alive. Decide orphan vs. live by parent liveness.
    //
    // PID-recycling caveat: the recorded `ppid` is a snapshot from boot
    // time. In principle the OS could recycle that PID to an unrelated
    // live process between server start and this sweep, producing a
    // false-NEGATIVE — we'd see "parent alive" and leave a real orphan
    // untouched. The symmetrical false-POSITIVE (reap a non-orphan
    // because we wrongly read its parent as dead) is impossible: we
    // only reap when the parent is provably DEAD, never the reverse.
    // The current code therefore prefers the safer failure mode —
    // a missed orphan is opportunistically reaped on the next sweep
    // (or on the next server boot's pre-flight reap).
    const parentAlive = isProcessAlive(record.ppid);

    if (parentAlive) {
      // Parent still alive — a live session owns this server. Leave it.
      result.skippedAlive.push(record.pid);
      continue;
    }

    // Server alive, parent provably dead → orphan. SIGTERM it.
    try {
      process.kill(record.pid, 'SIGTERM');
      result.reaped.push(record.pid);
    } catch {
      // Could not signal (race: just exited) — treat as gone.
    }
    // The pidfile is no longer meaningful — prune it regardless.
    try {
      unlinkSync(file);
      result.prunedStale.push(file);
    } catch {
      // Already removed — fine.
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// stdio teardown
// ---------------------------------------------------------------------------

/**
 * Wire stdio teardown for a stdio MCP server (Phase 2 — the H2 fix).
 *
 * Installs ONE idempotent shutdown function and binds it to four triggers:
 *   - `process.stdin` `'end'`  — the client closed its write side (EOF).
 *   - `process.stdin` `'close'` — the stdin stream fully closed.
 *   - `SIGINT`  — interrupt signal.
 *   - `SIGTERM` — termination signal (including from the reaper).
 *
 * The stdin EOF/close handlers are the actual leak fix: before BR-067 the
 * server wired only SIGINT/SIGTERM, so a Claude Code session that simply
 * exited (without signalling the server) left the server alive forever
 * (the 14-day orphan in the diagnosis). `StdioServerTransport` listens for
 * `'data'`/`'error'` on stdin but NOT `'end'`/`'close'`, so wiring them
 * here does not conflict with the transport.
 *
 * @param opts.onShutdown - the work to run exactly once before exit
 *        (typically `engine.shutdown()` + pidfile deregistration).
 * @param opts.exit - exit function (default `process.exit`); injectable for tests.
 * @param opts.stdin - the readable to watch (default `process.stdin`); injectable for tests.
 * @returns the idempotent shutdown function (also useful for tests).
 */
export function installStdioTeardown(opts: {
  onShutdown: () => void;
  exit?: (code: number) => never;
  stdin?: NodeJS.ReadStream | NodeJS.ReadableStream;
}): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const stdin = opts.stdin ?? process.stdin;

  let shuttingDown = false;
  const shutdown = (): void => {
    // Idempotency guard: stdin 'end' and 'close' both fire on a client
    // disconnect, and a signal could race them. Run the teardown once.
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      opts.onShutdown();
    } catch (err) {
      console.error(`[brain] error during shutdown: ${String(err)}`);
    }
    exit(0);
  };

  // Phase 2: the stdin-EOF teardown.
  //
  // Defensive-only `resume()`: in production, `StdioServerTransport`
  // attaches a `'data'` listener on `process.stdin` which Node treats as
  // an implicit `resume()` — flowing mode is already in effect by the
  // time we arrive here, so this call is a no-op for the real transport.
  // We retain it as belt-and-braces for test harnesses that inject a
  // plain `Readable` (no `'data'` listener) where the stream would
  // otherwise stay paused and never emit `'end'`. Zero-cost when the
  // stream is already flowing.
  if (typeof (stdin as NodeJS.ReadStream).resume === 'function') {
    (stdin as NodeJS.ReadStream).resume();
  }
  stdin.on('end', shutdown);
  stdin.on('close', shutdown);

  // Existing signal-driven teardown — now sharing the one idempotent fn.
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return shutdown;
}
