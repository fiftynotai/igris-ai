/**
 * Brain Engine v7.1 — Cognition backend: process-group exec.
 *
 * PORTED FROM FR-201 (COPY, don't import — R-PORT-DRIFT):
 *   - `execHarness` (process-group spawn + grandchild reap + the 'close'-is-
 *     authoritative drain handling)
 *       ← `~/StudioProjects/igris-os-eval/b5/harness/exec.ts:execHarness:28-120`.
 *
 * GENERALIZED for the cognition backend:
 *   - DUAL TIMEOUT escalation SIGTERM → SIGKILL: FR-201's soft timer SIGKILLed
 *     immediately; here we send SIGTERM first (graceful) then SIGKILL after a
 *     grace, matching the perception extractor's `kill('SIGTERM')` → 5s →
 *     `kill('SIGKILL')` shape, so a well-behaved CLI can flush its output.
 *   - STDIN delivery: the perception/claude path pipes the prompt on stdin; this
 *     exec accepts an optional `stdin` to write-then-end (with EPIPE tolerated,
 *     per TD-073) so claude/codex spawns work unchanged.
 *
 * The detached process group + grandchild reap is the LOAD-BEARING part: the
 * extraction child may spawn a grandchild (a stray MCP) that keeps the stdout
 * pipe open; killing the WHOLE group on timeout prevents the runner deadlocking.
 *
 * @module engine/components/cognition/backend/exec
 * @author fifty.dev
 */

import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timed_out: boolean;
  duration_ms: number;
}

export interface ExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Hard wall-clock budget (ms). SIGTERM at this point, SIGKILL after the grace. */
  timeout_ms: number;
  /** Optional prompt body to write to the child's stdin then end it. */
  stdin?: string;
}

/** Grace between the soft SIGTERM and the hard SIGKILL (ms). Matches the perception extractor's 5s. */
const SIGTERM_TO_SIGKILL_GRACE_MS = 5_000;

/** Grace after 'exit' for stdout to finish draining before we resolve (and reap the group). */
const EXIT_DRAIN_GRACE_MS = 2_000;

/** Extra grace after the hard SIGKILL before we force-resolve so a hung grandchild can't deadlock. */
const HARD_RESOLVE_GRACE_MS = 15_000;

/**
 * Run a harness CLI headlessly with a wall-clock timeout. The child is its OWN
 * process group (`detached:true`) so the whole group can be killed on timeout —
 * otherwise a grandchild (a stray MCP) orphans, keeps the stdout pipe open, and
 * 'close' never fires (the runner deadlocks).
 *
 * Returns raw stdout/stderr + exit code; the instance's `parseResponse` (via the
 * backend's `extractText`) parses its own shape.
 *
 * @param cmd   the executable
 * @param args  argv
 * @param opts  cwd, env, timeout, optional stdin
 */
export function execHarness(
  cmd: string,
  args: string[],
  opts: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    // detached:true → own process group, so we can kill the WHOLE group (grandchildren too).
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      // stdin is piped so we can deliver a prompt body; ignored when opts.stdin is absent.
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    /** Kill the child AND its process group (negative pid), reaping grandchildren. */
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (typeof child.pid === 'number') process.kill(-child.pid, signal);
      } catch {
        /* group already gone */
      }
      try {
        child.kill(signal);
      } catch {
        /* already dead */
      }
    };

    const finish = (code: number | null, errMsg?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      // Reap any orphaned grandchildren by killing the process group. Harmless if gone.
      killGroup('SIGKILL');
      resolvePromise({
        stdout,
        stderr: errMsg ? stderr + `\n[exec error] ${errMsg}` : stderr,
        code,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
      });
    };

    // SOFT timeout: SIGTERM the group (graceful), then escalate to SIGKILL after a grace.
    const softTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), SIGTERM_TO_SIGKILL_GRACE_MS);
    }, opts.timeout_ms);

    // HARD fallback: if the pipes stay open (orphaned grandchild), resolve anyway after
    // a grace so a single hung boot can never deadlock the matrix.
    const hardTimer = setTimeout(() => {
      killGroup('SIGKILL');
      finish(null, 'hard-timeout: pipes did not close after SIGKILL');
    }, opts.timeout_ms + SIGTERM_TO_SIGKILL_GRACE_MS + HARD_RESOLVE_GRACE_MS);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => finish(null, err.message));

    // TD-073: EPIPE on stdin arrives as an async 'error' event — without this
    // listener Node crashes the whole process. Tolerate it: the child closed
    // stdin during our write; the close handler below still resolves the result.
    child.stdin?.on('error', () => {
      /* child closed stdin during write — tolerated; close/exit drives the result */
    });

    // 'close' fires only after ALL stdio is fully drained — the ONLY event we
    // resolve normal completion from, so the full stdout is captured. (Resolving
    // on 'exit' truncated fast commands' output — the antigravity/codex
    // empty-capture bug. 'close' is authoritative.)
    child.on('close', (code) => finish(code));

    // 'exit' (process gone, pipes maybe still open) ARMS a short grace timer: if a
    // grandchild keeps the pipe open and 'close' never comes, resolve after the grace.
    child.on('exit', (code) => {
      if (settled) return;
      setTimeout(() => finish(code), EXIT_DRAIN_GRACE_MS);
    });

    // Deliver the prompt body on stdin (claude/codex path), then end. Sync throws
    // (stdin already destroyed) are tolerated — the async 'error' listener above
    // and the close handler drive the result.
    if (opts.stdin !== undefined) {
      try {
        child.stdin?.end(opts.stdin);
      } catch {
        /* stdin already gone — tolerated (TD-073) */
      }
    } else {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
    }
  });
}
