/**
 * BR-106 — the FIRST vitest config for `cli/`. Before this file the suite ran
 * on vitest's built-in defaults (`cli/package.json` -> `"test": "vitest run"`).
 *
 * `include` / `exclude` are deliberately left at the defaults: a hand-written
 * `include` is how a new config silently drops test files, and the default
 * set spans BOTH `src/__tests__/` and `dashboard/src/**\/__tests__/`. BR-106
 * measured 140 files / 3151 tests at e908493 before this file existed, and
 * 142 / 3183 after it. That is the abort check: a config edit that LOWERS the
 * file count narrowed the suite and must be reverted. TD-344 re-took it: 152
 * files at b88bfaf before its keys were added; 154 after, the 2 being new
 * test files in the same bundle (TD-344's reporter test, TD-350's push test).
 *
 * Keys: `setupFiles` (BR-106, the HOME belt), `testTimeout` and `reporters`
 * (TD-344, below).
 *
 * `testTimeout` — TD-344, MEASURED 2026-10-01 on the dev machine (darwin
 * arm64, `hw.ncpu` 8, node v22). The 5000 ms default was set for the wrong
 * workload: six files had crossed it with no code change, all CPU-bound
 * static scans or subprocess tests. Four full-suite runs under K=2 busy-loop
 * burners (the suite's own workers drive the 1-min load to 30-48) and one with
 * K=0 (load peak 42 — the suite IS the load):
 *
 *   test (no explicit timeout)                     loaded worst  K=0 (peak 42)
 *   vitest-home-fence  TRIAGED_EXEMPT mechanism         6636 ms      4710 ms
 *   vitest-home-fence  VACUITY: string/comparison       5712 ms      3854 ms
 *   dashboard-count-derivation  no unmarked count       5194 ms      3795 ms
 *
 *   crossings of 5000: 2, 1, 1, 2 in the four loaded runs; 0 at K=0.
 *
 * These bodies are SYNCHRONOUS scans, so the reported duration is the whole
 * body — vitest cannot pre-empt them and marks them timed out after the fact.
 * Formula: max(10_000, roundUpTo5s(2 x worst loaded duration of a test with no
 * explicit timeout)) = max(10_000, roundUpTo5s(2 x 6636)) = 15_000.
 *
 * THE LOAD ENVELOPE (sentinel, the same day). The default is not load-proof.
 * The run set: 13 full-suite runs with ARCHIVED per-test durations, 1-min load
 * peaks 30-277 — forger's nine (seven sampled at 30-48, `final-cli`
 * unsampled, `heavy-1` with K=6 burners at 277) and sentinel's L1-L4 (30-127,
 * an Android emulator running). Sentinel REPORTED six runs (peaks down to 7);
 * two have no archived JSON, so their per-test figures are on report only.
 * 15_000 held every test without its own budget at peaks up to 48 (worst
 * 37%, forger) and 30 (worst 51%, sentinel L4). Of the archived runs plus
 * sentinel's six on report, every run peaking at 63 or more crossed it —
 * sentinel's 3 of 6 (peaks 63 / 104 / 127) and forger's `heavy-1` (277) —
 * always in the same synchronous scans (worst 24_802 ms, sentinel L3, peak
 * 63; the duration does not track the sampled peak). So: the default covers the light
 * majority, and a test whose worst OBSERVED ratio reached ~61% of it at any
 * measured load carries its own budget, 2x its worst observed duration
 * (TD-336 shape, provenance in each constant): the five `vitest-home-fence`
 * scans (50_000), the `dashboard-count-derivation` corpus scan (50_000) and
 * `harness-registry`'s FR-218 case (30_000); tarball's shared npm-pack budget
 * `PACK_TIMEOUT_MS` rose 30_000 -> 40_000 by the same rule.
 * Re-scored with those budgets,
 * sentinel's four archived runs read worst 34 / 57 / 50 / 26% (the 57% is tarball's
 * FR-238 pack test against its own 30_000) and the K=6 run 36%. Run with the
 * budgets in place: three full suites at peaks 151, 223 and 191 (K=6), all
 * 3387/3387, worst 34 / 33 / 57% (the 57% is the triage file's first test,
 * mostly hook time — see `hookTimeout`), and the budgeted files alone under
 * K=6 at peak 155, 281/281, worst 21%. A fifth run, at peak 206, put the
 * corpus scan at 24_220 ms (61% of the 40_000 it then had) and FR-238's pack
 * test at 63% of 30_000; both budgets were re-derived from those worsts.
 *
 * The rise does not lengthen a real hang where it matters: every synchronous
 * spawn in the tier carries its own `options.timeout` (TD-336's two halves;
 * TD-344 added the missing ones in harness-registry, tarball and
 * dashboard-count-derivation), which is what actually stops a hung child.
 * Async tests whose own spawn half exceeds this default carry an explicit,
 * larger budget (dashboard-server's curl probe).
 *
 * `hookTimeout` — TD-344, the other half of the envelope. The 83%
 * `dashboard-triage-endpoint` "deviation set" reading was its file's cold
 * `beforeEach` (the first `import()` of the vendored engine), which this
 * budget, not `testTimeout`, bounds. That first test, hook included, measured
 * worst 8565 ms at a 1-min peak of 191 (K=6 burners) while the file's other
 * 86 tests ran at a median of ~0.5 s: ~86% of vitest's 10_000 default. 2x the
 * worst, rounded up to the next 5 s = 20_000. Set here rather than on the
 * hook, because that file's line numbers are cited by MAINTAINING and
 * coding_guidelines.
 *
 * `reporters` — the default reporter plus `vitest-proximity-reporter.ts`, which
 * prints every test's `duration / timeout` ranking after the run (>= 0.8 NEAR
 * BUDGET, >= 1.0 CROSSED), so the next test drifting toward its budget is seen
 * before it fails. It never changes the exit code. Read its worst ratio
 * together with the run's 1-min load peak: a ratio is a statement about one
 * load, never about the suite.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 20_000,
    reporters: ["default", "./vitest-proximity-reporter.ts"],
  },
});
