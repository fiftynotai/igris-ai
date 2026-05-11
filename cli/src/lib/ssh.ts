/**
 * Thin async wrapper around `child_process.execFile("ssh", ...)` and
 * `child_process.execFile("rsync", ...)`. Used exclusively by
 * `cli/src/lib/sync/code.ts` for VPS code-sync (M4 of MG-014).
 *
 * Why a separate module from `lib/exec.ts`?
 *   - `exec.ts` is a synchronous `execFileSync` wrapper used at install/update
 *     time, where stdio inheritance is the desired UX.
 *   - This module is async (Promise-based) because sync code-sync wants
 *     piped stdio capture (so we can surface rsync's per-file output AND
 *     the final summary), AND because tests mock `child_process.execFile`
 *     at the boundary (per L-159 / TD-098: never `vi.mock` the module
 *     under test).
 *
 * Tests mock `node:child_process` directly; this module is exercised
 * end-to-end by `cli/src/__tests__/sync-code.test.ts`.
 */

import { execFile, type ExecFileException } from "node:child_process";

export interface SshExecResult {
  /** Process exit code (0 == success). */
  exitCode: number;
  /** Captured stdout (utf-8). */
  stdout: string;
  /** Captured stderr (utf-8). */
  stderr: string;
}

export interface SshOptions {
  /** Connection timeout in seconds passed via `-o ConnectTimeout=N`. Default 30. */
  connectTimeoutSeconds?: number;
  /** Total command timeout in milliseconds. Default 5 minutes. */
  timeoutMs?: number;
}

export interface RsyncOptions {
  /** When true, pass `--dry-run -v -i` so the user sees what would change. */
  dryRun?: boolean;
  /** When true, pass `-a` (archive). Default true. */
  archive?: boolean;
  /** Extra flags inserted between the standard ones and source/dest. */
  extraFlags?: string[];
  /** Total command timeout in milliseconds. Default 10 minutes. */
  timeoutMs?: number;
}

/**
 * Execute `ssh -o ConnectTimeout=N user@host -- <remoteCommand>`.
 *
 * Resolves to `{exitCode, stdout, stderr}`. The promise NEVER rejects; SSH
 * failure (host unreachable, command exited non-zero) surfaces as a non-zero
 * exitCode with stderr populated. Callers that want to throw on failure
 * should check exitCode explicitly.
 */
export async function sshExec(
  user: string,
  host: string,
  remoteCommand: string,
  opts: SshOptions = {},
): Promise<SshExecResult> {
  const connectTimeout = opts.connectTimeoutSeconds ?? 30;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const args = [
    "-o",
    `ConnectTimeout=${connectTimeout}`,
    "-o",
    "BatchMode=yes",
    `${user}@${host}`,
    "--",
    remoteCommand,
  ];
  return runChild("ssh", args, timeoutMs);
}

/**
 * Execute `rsync [flags] <src> <dst>`.
 *
 * `src` and `dst` are passed verbatim — caller is responsible for trailing-
 * slash semantics (rsync treats `foo/` and `foo` differently). Both args
 * may be local paths OR `user@host:path` strings.
 *
 * Standard flags applied:
 *   - `-a` (archive) when archive != false
 *   - `-z` (compress in transit, safe for SSH transport)
 *   - `--delete` (mirror semantics; the VPS repo should match source)
 *   - `--dry-run -v -i` when dryRun is true
 *
 * Returns `{exitCode, stdout, stderr}`; promise never rejects.
 */
export async function rsyncExec(
  src: string,
  dst: string,
  opts: RsyncOptions = {},
): Promise<SshExecResult> {
  const archive = opts.archive !== false;
  const flags: string[] = [];
  if (archive) flags.push("-a");
  flags.push("-z", "--delete");
  if (opts.dryRun === true) flags.push("--dry-run", "-v", "-i");
  if (opts.extraFlags !== undefined) flags.push(...opts.extraFlags);
  const args = [...flags, src, dst];
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  return runChild("rsync", args, timeoutMs);
}

/**
 * Internal: run a child process and capture its output, returning
 * `{exitCode, stdout, stderr}`. Never rejects.
 */
function runChild(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<SshExecResult> {
  return new Promise<SshExecResult>((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
      (
        err: ExecFileException | null,
        stdout: string | Buffer,
        stderr: string | Buffer,
      ) => {
        const out = typeof stdout === "string" ? stdout : stdout.toString("utf-8");
        const errOut =
          typeof stderr === "string" ? stderr : stderr.toString("utf-8");
        if (err === null) {
          resolve({ exitCode: 0, stdout: out, stderr: errOut });
          return;
        }
        // ENOENT (binary missing) — surface a synthetic 127 (POSIX
        // "command not found") with stderr explaining what failed.
        if (err.code === "ENOENT") {
          resolve({
            exitCode: 127,
            stdout: out,
            stderr: errOut + `\n${bin} not found on PATH`,
          });
          return;
        }
        // Process exited non-zero — err.code is the numeric exit code.
        if (typeof err.code === "number") {
          resolve({ exitCode: err.code, stdout: out, stderr: errOut });
          return;
        }
        // Spawn or other error — surface as exit 1 with err.message.
        resolve({
          exitCode: 1,
          stdout: out,
          stderr: errOut + `\n${err.message}`,
        });
      },
    );
  });
}
