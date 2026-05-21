/**
 * `igris harness <compile|check> [options]` — the FR-136 harness verb.
 *
 * Thin TS wrapper that shells out to the TD-021 bash adapters under
 * `~/.igris/core/scripts/cli-adapters/`:
 *   - compile -> compile_harnesses.sh   (regenerate harness files)
 *   - check   -> check_harness_drift.sh (CI-style drift guard)
 *
 * The verb resolves the adapter dir the same way bridges.ts computes the
 * brain dir (join(brainDir(), "core", "scripts", "cli-adapters")), then
 * invokes the chosen script with `inheritStdio: true` so the user sees the
 * adapter's self-evidencing output live. The script's exit code is passed
 * through unchanged (exit-code discipline).
 *
 * Adapter-naming note (FR-138): this verb wraps the `compile_*`/`check_*`
 * (TD-021) family directly. It does NOT touch the dormant `<target>.sh`
 * bridges contract in bridges.ts (a third naming family alongside `sync_*`
 * and `md_to_*`). Reconciling the three families is FR-138's job; this verb
 * deliberately stays in its lane and never invokes bridges.ts.
 */

import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { brainDir } from "../lib/paths.js";
import { error as logError } from "../lib/log.js";

export type HarnessAction = "compile" | "check";

export interface HarnessOptions {
  /** Which adapter to run. */
  action: HarnessAction;
  /** Root that canonical/target paths resolve against. Defaults to cwd. */
  projectRoot?: string;
  /** Explicit base manifest path override (else adapter default applies). */
  manifest?: string;
  /** Explicit personal-overlay path override (else adapter auto-discovers). */
  overlay?: string;
  /** Restrict to one target type (compile only): claude | codex | all. */
  target?: string;
  /** Only process agents whose name matches this glob. */
  filter?: string;
  /**
   * Test seam: invoke the adapter and return its exit code. Default spawns
   * the real bash script with inherited stdio. Tests pass a spy to assert
   * the resolved script path + args without spawning a shell.
   */
  runAdapter?: AdapterRunFn;
  /** Test seam: brain root override (defaults to brainDir()). */
  brainRoot?: string;
}

export type AdapterRunFn = (scriptPath: string, args: string[]) => number;

const SCRIPT_BY_ACTION: Record<HarnessAction, string> = {
  compile: "compile_harnesses.sh",
  check: "check_harness_drift.sh",
};

/**
 * Default adapter runner: spawn `bash <script> <args>` with inherited stdio.
 * Returns the child's exit code (execFileSync throws on non-zero, so we read
 * the status off the thrown error rather than letting it propagate).
 */
const defaultAdapterRunner: AdapterRunFn = (scriptPath, args) => {
  try {
    execFileSync("bash", [scriptPath, ...args], { stdio: "inherit" });
    return 0;
  } catch (err) {
    const status = (err as { status?: number }).status;
    return typeof status === "number" ? status : 1;
  }
};

/**
 * Run the harness verb. Returns the adapter's exit code (passthrough), or 2
 * on a usage error (bad action).
 */
export async function runHarness(opts: HarnessOptions): Promise<number> {
  const script = SCRIPT_BY_ACTION[opts.action];
  if (script === undefined) {
    logError(
      `unknown harness action '${String(opts.action)}'. Valid: compile, check.`,
    );
    return 2;
  }

  const root = opts.brainRoot ?? brainDir();
  const adaptersDir = join(root, "core", "scripts", "cli-adapters");
  const scriptPath = join(adaptersDir, script);

  const projectRoot = opts.projectRoot ?? process.cwd();
  const args: string[] = ["--project-root", projectRoot];
  if (opts.manifest !== undefined) {
    args.push("--manifest", opts.manifest);
  }
  if (opts.overlay !== undefined) {
    args.push("--overlay", opts.overlay);
  }
  if (opts.target !== undefined) {
    args.push("--target", opts.target);
  }
  if (opts.filter !== undefined) {
    args.push("--filter", opts.filter);
  }

  const runner = opts.runAdapter ?? defaultAdapterRunner;
  return runner(scriptPath, args);
}
