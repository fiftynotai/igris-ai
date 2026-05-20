/**
 * stdio-lifecycle — teardown + singleton/reaper tests (BR-067).
 *
 * Covers:
 *   - installStdioTeardown: stdin 'end'/'close' triggers the idempotent
 *     shutdown exactly once (the H2 leak fix — Phase 2).
 *   - registerInstance / deregisterInstance: per-client pidfile registry.
 *   - reapStaleInstances: SIGTERMs a provably-orphaned instance (alive
 *     server, dead parent), prunes a stale pidfile (dead server), and
 *     LEAVES a live-parent instance untouched (Phase 4).
 *
 * The reaper tests spawn real `sleep` subprocesses as stand-in "servers" so
 * `process.kill(pid, 0)` liveness probes are genuine. The pidfile registry
 * is sandboxed to a temp dir via `IGRIS_PIDS_DIR`.
 *
 * @module __tests__/stdio-lifecycle.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  installStdioTeardown,
  registerInstance,
  deregisterInstance,
  readInstanceRegistry,
  reapStaleInstances,
  isProcessAlive,
} from '../stdio-lifecycle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spawn a long-lived `sleep` subprocess to act as a stand-in server. */
function spawnSleeper(): ChildProcess {
  return spawn('sleep', ['30'], { stdio: 'ignore' });
}

/** Wait until `pred()` is true or the timeout elapses. */
async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// installStdioTeardown
// ---------------------------------------------------------------------------

describe('installStdioTeardown — stdin EOF teardown (BR-067 Phase 2)', () => {
  it('runs shutdown exactly once when stdin emits "end"', () => {
    const fakeStdin = new EventEmitter() as unknown as NodeJS.ReadableStream;
    let shutdownCalls = 0;
    let exitCode: number | null = null;

    installStdioTeardown({
      stdin: fakeStdin,
      onShutdown: () => { shutdownCalls += 1; },
      exit: ((code: number) => { exitCode = code; }) as (c: number) => never,
    });

    fakeStdin.emit('end');
    expect(shutdownCalls).toBe(1);
    expect(exitCode).toBe(0);
  });

  it('is idempotent across "end" then "close" (both fire on disconnect)', () => {
    const fakeStdin = new EventEmitter() as unknown as NodeJS.ReadableStream;
    let shutdownCalls = 0;

    installStdioTeardown({
      stdin: fakeStdin,
      onShutdown: () => { shutdownCalls += 1; },
      exit: (() => {}) as (c: number) => never,
    });

    fakeStdin.emit('end');
    fakeStdin.emit('close');
    // Both events fire on a client disconnect — teardown must run ONCE.
    expect(shutdownCalls).toBe(1);
  });

  it('runs shutdown when stdin emits "close" (no prior "end")', () => {
    const fakeStdin = new EventEmitter() as unknown as NodeJS.ReadableStream;
    let shutdownCalls = 0;

    installStdioTeardown({
      stdin: fakeStdin,
      onShutdown: () => { shutdownCalls += 1; },
      exit: (() => {}) as (c: number) => never,
    });

    fakeStdin.emit('close');
    expect(shutdownCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pidfile registry + reaper
// ---------------------------------------------------------------------------

describe('instance registry + reaper (BR-067 Phase 4)', () => {
  let tmpDir: string;
  const sleepers: ChildProcess[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'br067-pids-'));
    process.env.IGRIS_PIDS_DIR = tmpDir;
  });

  afterEach(() => {
    for (const c of sleepers.splice(0)) {
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
    delete process.env.IGRIS_PIDS_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers and deregisters a pidfile', () => {
    const file = registerInstance({
      pid: 12345,
      ppid: 6789,
      started_at: new Date().toISOString(),
      db_path: '/tmp/x.db',
    });
    expect(file).not.toBeNull();
    expect(existsSync(file as string)).toBe(true);

    const registry = readInstanceRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].record.pid).toBe(12345);

    deregisterInstance(6789);
    expect(readInstanceRegistry()).toHaveLength(0);
  });

  it('registry keyed by parent PID — a re-register for the same client overwrites the slot', () => {
    registerInstance({ pid: 100, ppid: 42, started_at: 't1', db_path: 'd' });
    registerInstance({ pid: 200, ppid: 42, started_at: 't2', db_path: 'd' });
    const registry = readInstanceRegistry();
    // Same parent → one slot. The newer PID claimed it.
    expect(registry).toHaveLength(1);
    expect(registry[0].record.pid).toBe(200);
  });

  it('reaps a provably-orphaned instance (alive server, dead parent)', async () => {
    const sleeper = spawnSleeper();
    sleepers.push(sleeper);
    const serverPid = sleeper.pid as number;

    // Register the sleeper as a "server" whose parent is a definitely-dead
    // PID. A high unallocated PID models a parent that has exited (the
    // launchd-reparented ppid==1 orphan, generalised).
    const deadParent = 999_999;
    expect(isProcessAlive(deadParent)).toBe(false);
    registerInstance({
      pid: serverPid,
      ppid: deadParent,
      started_at: new Date().toISOString(),
      db_path: '/tmp/x.db',
    });

    const result = reapStaleInstances();

    expect(result.reaped).toContain(serverPid);
    // The orphan was SIGTERM'd — it should exit.
    await waitFor(() => !isProcessAlive(serverPid));
    // Its pidfile was pruned.
    expect(readInstanceRegistry()).toHaveLength(0);
  });

  it('leaves a live-parent instance UNTOUCHED (no false-positive reap)', async () => {
    const sleeper = spawnSleeper();
    sleepers.push(sleeper);
    const serverPid = sleeper.pid as number;

    // Parent is the test runner itself — provably alive.
    registerInstance({
      pid: serverPid,
      ppid: process.pid,
      started_at: new Date().toISOString(),
      db_path: '/tmp/x.db',
    });

    const result = reapStaleInstances();

    // A live-parent server is a legitimate session — never reaped.
    expect(result.reaped).not.toContain(serverPid);
    expect(result.skippedAlive).toContain(serverPid);
    // Still alive after the sweep.
    expect(isProcessAlive(serverPid)).toBe(true);
    expect(readInstanceRegistry()).toHaveLength(1);
  });

  it('prunes a stale pidfile whose server process is already dead', () => {
    // A PID that does not exist — models a server that already exited
    // without deregistering.
    registerInstance({
      pid: 999_998,
      ppid: 999_999,
      started_at: new Date().toISOString(),
      db_path: '/tmp/x.db',
    });
    expect(readInstanceRegistry()).toHaveLength(1);

    const result = reapStaleInstances();

    expect(result.prunedStale).toHaveLength(1);
    expect(result.reaped).toHaveLength(0); // dead process — nothing to SIGTERM
    expect(readInstanceRegistry()).toHaveLength(0);
  });

  it('never reaps the current process even if its pidfile is present', () => {
    registerInstance({
      pid: process.pid,
      ppid: 999_999, // dead parent — but self must still be exempt
      started_at: new Date().toISOString(),
      db_path: '/tmp/x.db',
    });

    const result = reapStaleInstances();

    expect(result.reaped).not.toContain(process.pid);
    // Self pidfile is left in place (not pruned as stale — we are alive).
    expect(readInstanceRegistry().some((e) => e.record.pid === process.pid)).toBe(true);
  });

  it('mixed sweep: reaps the orphan, keeps the live one, prunes the dead one', async () => {
    const liveSleeper = spawnSleeper();
    const orphanSleeper = spawnSleeper();
    sleepers.push(liveSleeper, orphanSleeper);

    // Live: parent alive.
    registerInstance({
      pid: liveSleeper.pid as number,
      ppid: process.pid,
      started_at: 't', db_path: 'd',
    });
    // Orphan: parent dead.
    registerInstance({
      pid: orphanSleeper.pid as number,
      ppid: 999_999,
      started_at: 't', db_path: 'd',
    });
    // Stale: server dead.
    registerInstance({ pid: 999_998, ppid: 999_997, started_at: 't', db_path: 'd' });

    const result = reapStaleInstances();

    expect(result.reaped).toContain(orphanSleeper.pid);
    expect(result.skippedAlive).toContain(liveSleeper.pid);
    expect(result.prunedStale.length).toBeGreaterThanOrEqual(2); // orphan pidfile + stale pidfile

    await waitFor(() => !isProcessAlive(orphanSleeper.pid as number));
    expect(isProcessAlive(liveSleeper.pid as number)).toBe(true);
  });

  it('reaper is a no-op when the registry directory does not exist', () => {
    process.env.IGRIS_PIDS_DIR = path.join(tmpDir, 'does-not-exist');
    const result = reapStaleInstances();
    expect(result.reaped).toHaveLength(0);
    expect(result.prunedStale).toHaveLength(0);
    expect(result.skippedAlive).toHaveLength(0);
  });
});
