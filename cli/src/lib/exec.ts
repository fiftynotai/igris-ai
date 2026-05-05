/**
 * Thin wrapper around `child_process.execFileSync` for invoking external
 * shell scripts. Phase 1 uses this to delegate the symlink layer to
 * `scripts/igris_install.sh`; Phase 2 will reimplement those primitives in TS.
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
