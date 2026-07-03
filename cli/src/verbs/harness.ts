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

/**
 * FR-180: a machine-readable summary of one adapter run. The exit-code path
 * (`runHarness`) stays for back-compat + the `harness` verb; `add-orchestrate`
 * needs to distinguish "0 targets matched" (the TD-235 silent-no-op root) and
 * the loud `FAIL core <surface>` / visible `WARN  core skills` lines from a
 * genuine OK run. The adapter already prints these to its summary; the
 * structured path captures stdout (instead of inheriting it) and parses the
 * per-row verdicts.
 */
export interface HarnessStructuredResult {
  /** Adapter exit code (passthrough). */
  code: number;
  /** Whole captured stdout+stderr (for surfacing the adapter's own message). */
  output: string;
  /** True when the adapter printed its "No … targets matched" empty-match line. */
  noTargetsMatched: boolean;
  /** Per-row `OK    <surface> -> …` summary lines (verbatim, trimmed). */
  okRows: string[];
  /** Per-row `FAIL  <surface> — …` summary lines (verbatim, trimmed). */
  failRows: string[];
  /**
   * FR-218: the loud `WARN  core skills are (re)projected …` line the adapter
   * emits when a NON-OWNER (consumer) compile/drift touches the GLOBAL skills
   * store, else undefined. (Pre-FR-218 this captured the retired `SKIPPED core
   * surfaces (personal-project compile)` line — the ownership gate used to skip
   * core for non-owners; FR-218 makes core always-global so it is reprojected,
   * not skipped. Field name kept for result-shape stability.)
   */
  skippedCoreLine?: string;
}

export interface HarnessOptions {
  /** Which adapter to run. */
  action: HarnessAction;
  /** Root that canonical/target paths resolve against. Defaults to cwd. */
  projectRoot?: string;
  /** Explicit base manifest path override (else adapter default applies). */
  manifest?: string;
  /** Explicit personal-overlay path override (else adapter auto-discovers). */
  overlay?: string;
  /** Restrict to one target type (compile only): claude | codex | gemini | opencode | all. */
  target?: string;
  /** Restrict to one projection surface (compile only): agents | skills | mcp | hook | all. */
  surface?: string;
  /** Only process agents whose name matches this glob. */
  filter?: string;
  /**
   * FR-180 (D5): assert that the run EXPECTS core surfaces (it was routed from
   * `igris add` in core mode, or via an explicit `--surface` request). The
   * adapter then makes the ownership-gate skip a LOUD failure rather than a
   * silent / merely-visible skip. Omitted/false → incidental compile posture
   * (an unrelated personal-project compile stays exit-0 with a visible
   * SKIPPED line).
   */
  expectCore?: boolean;
  /**
   * Test seam: invoke the adapter and return its exit code. Default spawns
   * the real bash script with inherited stdio. Tests pass a spy to assert
   * the resolved script path + args without spawning a shell.
   */
  runAdapter?: AdapterRunFn;
  /**
   * FR-180 test seam: capturing runner for the structured path. Default
   * spawns the real bash script and captures stdout+stderr. Tests inject a
   * fake returning a synthetic summary string to assert parsing.
   */
  captureAdapter?: AdapterCaptureFn;
  /** Test seam: brain root override (defaults to brainDir()). */
  brainRoot?: string;
}

export type AdapterRunFn = (scriptPath: string, args: string[]) => number;

/**
 * FR-180: a capturing runner used by the structured path. Unlike
 * `AdapterRunFn` it returns BOTH the exit code and the combined stdout+stderr
 * so the caller can parse the adapter's self-evidencing summary. Tests inject
 * a fake to assert parsing without spawning a shell.
 */
export type AdapterCaptureFn = (
  scriptPath: string,
  args: string[],
) => { code: number; output: string };

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
 * FR-180 default capturing runner: spawn `bash <script> <args>` and capture
 * stdout+stderr together (the adapter prints its summary to stdout and the
 * empty-match / loud-fail lines to stderr). The captured output is echoed
 * back to the parent process's streams so the user still sees the live
 * adapter output (parity with the inherited path), then returned for parsing.
 */
const defaultAdapterCapture: AdapterCaptureFn = (scriptPath, args) => {
  try {
    const out = execFileSync("bash", [scriptPath, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout.write(out);
    return { code: 0, output: out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    if (out.length > 0) {
      process.stderr.write(out);
    }
    const status = typeof e.status === "number" ? e.status : 1;
    return { code: status, output: out };
  }
};

/**
 * Resolve the adapter script path + the argv vector for a harness run. Shared
 * by `runHarness` (exit-code path) and `runHarnessStructured` (FR-180) so the
 * two paths build identical command lines. Returns `null` on a bad action.
 *
 * FR-180: `expectCore` appends the `--expect-core` flag the adapters use to
 * distinguish a LOUD core-surface skip (add requested it) from the visible-but-
 * exit-0 incidental skip (an unrelated personal-project compile). See D5.
 */
function resolveAdapterInvocation(
  opts: HarnessOptions,
): { scriptPath: string; args: string[] } | null {
  const script = SCRIPT_BY_ACTION[opts.action];
  if (script === undefined) {
    return null;
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
  if (opts.surface !== undefined) {
    args.push("--surface", opts.surface);
  }
  if (opts.filter !== undefined) {
    args.push("--filter", opts.filter);
  }
  if (opts.expectCore === true) {
    args.push("--expect-core");
  }
  return { scriptPath, args };
}

/**
 * Run the harness verb. Returns the adapter's exit code (passthrough), or 2
 * on a usage error (bad action).
 */
export async function runHarness(opts: HarnessOptions): Promise<number> {
  const inv = resolveAdapterInvocation(opts);
  if (inv === null) {
    logError(
      `unknown harness action '${String(opts.action)}'. Valid: compile, check.`,
    );
    return 2;
  }

  const runner = opts.runAdapter ?? defaultAdapterRunner;
  return runner(inv.scriptPath, inv.args);
}

/**
 * FR-180: parse one adapter run's captured output into a structured verdict.
 * The adapter's summary uses `  OK    …`, `  FAIL  …` row prefixes, prints
 * `No … targets matched` on the empty-match path, and (FR-218) the loud
 * `WARN  core skills are (re)projected …` non-owner info line. We parse the
 * verbatim lines rather than re-deriving — the adapter is the single source of
 * truth for the verdict (L-519: compile/drift own the contract).
 */
export function parseHarnessOutput(
  code: number,
  output: string,
): HarnessStructuredResult {
  const lines = output.split("\n");
  const okRows: string[] = [];
  const failRows: string[] = [];
  let noTargetsMatched = false;
  let skippedCoreLine: string | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    // PARSER↔ADAPTER COUPLING: these row prefixes (`OK `/`FAIL `, the
    // "… targets matched" empty-match line, and FR-218's "WARN  core skills"
    // non-owner diagnostic) are produced by the summary-emit block in
    // core/scripts/cli-adapters/compile_harnesses.sh (and the drift summary in
    // check_harness_drift.sh). If you change those literals on the bash side,
    // update this parser in the SAME change — there is a matching breadcrumb
    // comment at the bash summary-emit block. Phase-2 implementers: keep this
    // pairing in lockstep when adding surfaces.
    if (line.startsWith("OK ") || line.startsWith("OK\t")) {
      okRows.push(line);
    } else if (line.startsWith("FAIL ") || line.startsWith("FAIL\t")) {
      failRows.push(line);
    } else if (line.includes("targets matched")) {
      // "No agent/skills/mcp/hook targets matched (…)." (compile + check).
      noTargetsMatched = true;
    } else if (line.startsWith("WARN  core skills")) {
      // FR-218: a non-owner compile/drift (re)projected the GLOBAL core skills.
      // NOT a failure — core is always global; surfaced as info via add's
      // coreSkipped passthrough.
      skippedCoreLine = line;
    }
  }

  return {
    code,
    output,
    noTargetsMatched,
    okRows,
    failRows,
    skippedCoreLine,
  };
}

/**
 * FR-180: run the harness adapter and return a parsed, machine-readable
 * verdict instead of just an exit code. Used by `add-orchestrate` to detect
 * the TD-235 silent-no-op (0 targets) + the loud core-skip FAIL row. Returns
 * `code: 2` on a bad action (matches `runHarness`).
 */
export async function runHarnessStructured(
  opts: HarnessOptions,
): Promise<HarnessStructuredResult> {
  const inv = resolveAdapterInvocation(opts);
  if (inv === null) {
    logError(
      `unknown harness action '${String(opts.action)}'. Valid: compile, check.`,
    );
    return {
      code: 2,
      output: "",
      noTargetsMatched: false,
      okRows: [],
      failRows: [],
    };
  }

  const capture = opts.captureAdapter ?? defaultAdapterCapture;
  const { code, output } = capture(inv.scriptPath, inv.args);
  return parseHarnessOutput(code, output);
}
