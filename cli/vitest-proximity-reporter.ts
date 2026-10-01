/**
 * TD-344 — the PROXIMITY reporter.
 *
 * vitest's default reporter names a test only once it CROSSES its budget.
 * TD-336 and TD-344 both found tests sitting at 77–83% of the 5 s default
 * that later crossed under load with no code change ("a test near the line is
 * not passing comfortably, it is pre-failing"). This reporter ranks every
 * finished test by `duration / timeout` and prints the top ratios after the
 * run: `>= 0.8` is NEAR BUDGET, `>= 1.0` is CROSSED. It never changes the exit
 * code — it is an instrument, not a gate.
 *
 * The denominator is the test's EFFECTIVE timeout: `options.timeout` (vitest
 * fills it from `testTimeout` when a test sets none), falling back to the
 * config default. So an explicit per-test budget is what an explicit test is
 * measured against.
 *
 * Hook time is NOT the test's budget. A first test's reported duration can
 * include a cold `beforeEach`, which `hookTimeout` bounds, not `testTimeout`
 * (TD-344 Phase 0: `dashboard-triage-endpoint`'s 83% "deviation set" reading
 * was 3655 ms of cold engine import in its file-level `beforeEach`; the other
 * 86 tests in the file, same hook, ran at a median of 194 ms). Read a lone
 * high ratio on a file's FIRST test with that in mind.
 *
 * `IGRIS_PROXIMITY_OUT=<path>` also writes the full ranking as JSON (the
 * evidence form the TD-344 load runs archive). `IGRIS_PROXIMITY_TOP=<n>` sets
 * how many rows print (default 10).
 *
 * Not compiled into `dist` (`tsconfig.json` includes `src/**` only) and not
 * in `package.json` `files`, so it costs 0 packed bytes.
 */

import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import type { Reporter, TestCase } from "vitest/node";

/** A ratio at or above this is NEAR BUDGET. */
export const NEAR_BUDGET = 0.8;
/** A ratio at or above this is CROSSED. */
export const CROSSED = 1.0;

export interface ProximityInput {
  name: string;
  file: string;
  /** Wall time vitest reported for the test, ms. */
  duration: number;
  /** The test's effective timeout, ms. */
  timeout: number;
  /** vitest's final state for the case. */
  state: "passed" | "failed" | "skipped" | "pending";
}

export interface ProximityRow {
  name: string;
  file: string;
  duration: number;
  timeout: number;
  ratio: number;
  flag: "CROSSED" | "NEAR BUDGET" | "";
}

/**
 * Rank finished tests by `duration / timeout`, descending. Skipped, todo and
 * still-pending cases are excluded (they did not run), as is any case with no
 * positive timeout (no budget to be near).
 */
export function rankProximity(cases: readonly ProximityInput[]): ProximityRow[] {
  const rows: ProximityRow[] = [];
  for (const c of cases) {
    if (c.state !== "passed" && c.state !== "failed") continue;
    if (!(c.timeout > 0)) continue;
    const ratio = c.duration / c.timeout;
    const flag = ratio >= CROSSED ? "CROSSED" : ratio >= NEAR_BUDGET ? "NEAR BUDGET" : "";
    rows.push({ name: c.name, file: c.file, duration: c.duration, timeout: c.timeout, ratio, flag });
  }
  return rows.sort((a, b) => b.ratio - a.ratio);
}

/** The printed block. Empty input prints nothing. */
export function formatProximity(rows: readonly ProximityRow[], top: number): string {
  if (rows.length === 0) return "";
  const lines = [
    "",
    `Test-budget proximity (duration / timeout), top ${Math.min(top, rows.length)} of ${rows.length}:`,
  ];
  for (const r of rows.slice(0, top)) {
    const pct = `${(r.ratio * 100).toFixed(0)}%`.padStart(5);
    const tag = r.flag === "" ? "" : `  ${r.flag}`;
    lines.push(
      `  ${pct}  ${Math.round(r.duration)}/${r.timeout} ms  ${r.file} > ${r.name}${tag}`,
    );
  }
  return lines.join("\n") + "\n";
}

export default class ProximityReporter implements Reporter {
  private cases: ProximityInput[] = [];
  private defaultTimeout = 0;
  private root = process.cwd();

  onInit(vitest: { config: { testTimeout: number; root: string } }): void {
    this.defaultTimeout = vitest.config.testTimeout;
    this.root = vitest.config.root;
  }

  onTestCaseResult(testCase: TestCase): void {
    const diag = testCase.diagnostic();
    if (diag === undefined) return;
    this.cases.push({
      name: testCase.fullName,
      file: relative(this.root, testCase.module.moduleId),
      duration: diag.duration,
      timeout: testCase.options.timeout ?? this.defaultTimeout,
      state: testCase.result().state,
    });
  }

  onTestRunEnd(): void {
    const rows = rankProximity(this.cases);
    const top = Number(process.env.IGRIS_PROXIMITY_TOP ?? "10");
    process.stdout.write(formatProximity(rows, Number.isFinite(top) && top > 0 ? top : 10));
    const out = process.env.IGRIS_PROXIMITY_OUT;
    if (out !== undefined && out.length > 0) {
      writeFileSync(
        out,
        JSON.stringify({ defaultTimeout: this.defaultTimeout, rows }, null, 1) + "\n",
      );
    }
  }
}
