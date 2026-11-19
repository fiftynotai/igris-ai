/**
 * TD-344 AC5 — the proximity reporter's ranking is the instrument that makes a
 * test near its budget visible BEFORE it crosses. These pin the pure ranking
 * and formatting; the reporter class is a thin adapter over vitest's
 * `TestCase` (`options.timeout`, `diagnostic().duration`, `result().state`).
 */

import { describe, expect, it } from "vitest";
import {
  CROSSED,
  NEAR_BUDGET,
  formatProximity,
  rankProximity,
  type ProximityInput,
} from "../../vitest-proximity-reporter.js";

const c = (
  name: string,
  duration: number,
  timeout: number,
  state: ProximityInput["state"] = "passed",
): ProximityInput => ({ name, file: "src/__tests__/x.test.ts", duration, timeout, state });

describe("TD-344 — rankProximity", () => {
  it("P1: ranks by duration / timeout, descending — not by raw duration", () => {
    const rows = rankProximity([
      c("slow-but-budgeted", 9_000, 30_000), // 0.30
      c("fast-but-tight", 3_000, 5_000), // 0.60
      c("middle", 2_000, 5_000), // 0.40
    ]);
    expect(rows.map((r) => r.name)).toEqual(["fast-but-tight", "middle", "slow-but-budgeted"]);
    expect(rows[0].ratio).toBeCloseTo(0.6, 10);
  });

  it("P2: 0.8 <= r < 1.0 is NEAR BUDGET, r >= 1.0 is CROSSED — both boundaries exact", () => {
    expect(NEAR_BUDGET).toBe(0.8);
    expect(CROSSED).toBe(1.0);
    const byName = Object.fromEntries(
      rankProximity([
        c("just-under-near", 3_999, 5_000), // 0.7998
        c("at-near", 4_000, 5_000), // 0.8 exactly
        c("just-under-crossed", 4_999, 5_000),
        c("at-crossed", 5_000, 5_000), // 1.0 exactly
        c("over", 5_712, 5_000, "failed"),
      ]).map((r) => [r.name, r.flag]),
    );
    expect(byName).toEqual({
      "just-under-near": "",
      "at-near": "NEAR BUDGET",
      "just-under-crossed": "NEAR BUDGET",
      "at-crossed": "CROSSED",
      over: "CROSSED",
    });
  });

  it("P3: a per-test override is the denominator, not the suite default", () => {
    // 9 s against an explicit 30 s budget is 30% — the same 9 s against the
    // 5 s default would read 180% CROSSED. The reporter must use the former.
    const [row] = rankProximity([c("explicit", 9_000, 30_000)]);
    expect(row.timeout).toBe(30_000);
    expect(row.ratio).toBeCloseTo(0.3, 10);
    expect(row.flag).toBe("");
  });

  it("P4: skipped / todo / pending cases are excluded (they did not run)", () => {
    const rows = rankProximity([
      c("ran", 100, 5_000),
      c("skipped", 0, 5_000, "skipped"),
      c("pending", 4_900, 5_000, "pending"),
      c("no-budget", 100, 0),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["ran"]);
  });

  it("P5: empty input prints nothing and does not throw", () => {
    expect(rankProximity([])).toEqual([]);
    expect(formatProximity([], 10)).toBe("");
  });

  it("formatProximity prints the top N with the flag, and says how many it ranked", () => {
    const out = formatProximity(
      rankProximity([c("a", 5_712, 5_000, "failed"), c("b", 4_100, 5_000), c("c", 10, 5_000)]),
      2,
    );
    expect(out).toContain("top 2 of 3");
    expect(out).toMatch(/114%\s+5712\/5000 ms\s+\S+ > a\s+CROSSED/);
    expect(out).toMatch(/82%\s+4100\/5000 ms\s+\S+ > b\s+NEAR BUDGET/);
    expect(out).not.toContain("> c");
  });
});
