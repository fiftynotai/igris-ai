/**
 * Thin wrapper around `child_process.execFileSync` for invoking external
 * shell scripts. M3+ verbs (sync code, etc.) delegate ssh/rsync via this
 * helper. The install verb no longer shells out (M2 absorbed the symlink
 * layer into TS via cli/src/lib/symlinks.ts).
 */

import { execFileSync } from "node:child_process";

export interface ExecOptions {
  /** Working directory for the child process. */
  cwd?: string;
  /** Timeout in milliseconds. Defaults to 5 minutes. */
  timeout?: number;
  /** When true, inherit stdio so the user sees the subprocess output live. */
  inheritStdio?: boolean;
  /** Extra env vars merged on top of process.env. */
  env?: Record<string, string>;
}

/**
 * Execute a binary with explicit args. Throws on non-zero exit.
 * `execFile` (not `exec`) is intentional — args are passed as an array, no
 * shell quoting drama.
 */
export function execFile(
  bin: string,
  args: string[],
  opts: ExecOptions = {},
): string {
  const result = execFileSync(bin, args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 5 * 60_000,
    encoding: "utf-8",
    stdio: opts.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return typeof result === "string" ? result : "";
}
