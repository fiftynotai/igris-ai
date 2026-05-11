/**
 * Bridge orchestration.
 *
 * For each detected (or `--cli-bridge=` opted-in) CLI target, invoke
 * the corresponding adapter script under `~/.igris/core/scripts/cli-adapters/`.
 *
 * Adapters remain in shell intentionally — they encode per-CLI knowledge
 * (TOML formatting for Codex, AGENTS.md compilation for Gemini, hooks
 * dir conventions for OpenCode) that doesn't belong in TS. This module
 * is pure orchestration.
 *
 * Adapter contract:
 *
 *   ~/.igris/core/scripts/cli-adapters/<target>.sh <project-path>
 *
 * The adapter is responsible for materializing whatever the CLI needs
 * (config dir entries, symlinks, etc.). It's invoked synchronously
 * with `inheritStdio: true` so the user sees its output live.
 *
 * Errors from an adapter are surfaced as `BridgeError` with the
 * target's name and the underlying exit code (or stderr message). The
 * verb layer decides whether to abort the whole `igris init` run or
 * continue with degraded bridge support — for now: hard fail, on the
 * principle that silent bridge failure is worse than a noisy abort
 * (TD-100 lesson).
 *
 * Test seam: `runAdapter` is parameterizable so tests can swap with a
 * spy that records invocations without spawning a real shell.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "./exec.js";
import { brainDir } from "./paths.js";
import type { CLITarget } from "../types.js";

export class BridgeError extends Error {
  readonly target: CLITarget;
  readonly cause: string;
  constructor(target: CLITarget, cause: string) {
    super(`bridge for '${target}' failed: ${cause}`);
    this.name = "BridgeError";
    this.target = target;
    this.cause = cause;
  }
}

export interface MaterializeBridgesOptions {
  /** Set of CLI targets to bridge to (after detection + override). */
  targets: ReadonlySet<CLITarget>;
  /** Absolute project path, passed as the adapter's first argument. */
  projectPath: string;
  /**
   * Test seam: invoke an adapter. Default uses `child_process.execFile`
   * via the lib/exec.ts wrapper. Returns the captured stdout (or
   * empty string when stdio is inherited).
   */
  runAdapter?: AdapterRunFn;
  /** Test seam: brain root override (defaults to `brainDir()`). */
  brainRoot?: string;
}

export type AdapterRunFn = (
  scriptPath: string,
  args: string[],
) => string;

/**
 * Default adapter runner. Inherits stdio so the user sees the
 * adapter's output live.
 */
export const defaultAdapterRunner: AdapterRunFn = (scriptPath, args) =>
  execFile("bash", [scriptPath, ...args], { inheritStdio: true });

/**
 * Materialize bridges for each target. Returns a list of results, one
 * per target. On error, throws BridgeError; we DO NOT swallow because
 * bridge failure means the install is incomplete (TD-100 ethic: be
 * loud, not silent).
 */
export function materializeBridges(
  opts: MaterializeBridgesOptions,
): { target: CLITarget; scriptPath: string }[] {
  const root = opts.brainRoot ?? brainDir();
  const adaptersDir = join(root, "core", "scripts", "cli-adapters");
  const runner = opts.runAdapter ?? defaultAdapterRunner;

  const results: { target: CLITarget; scriptPath: string }[] = [];
  for (const target of opts.targets) {
    const scriptPath = join(adaptersDir, `${target}.sh`);
    if (!existsSync(scriptPath)) {
      // Missing adapter is not a hard error — we just skip. Some CLI
      // targets may not have an adapter shipped yet (especially in
      // early V7 releases). The verb layer surfaces the skip via
      // dry-run output.
      continue;
    }
    try {
      runner(scriptPath, [opts.projectPath]);
      results.push({ target, scriptPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BridgeError(target, msg);
    }
  }
  return results;
}
