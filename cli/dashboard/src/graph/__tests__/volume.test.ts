/**
 * FR-239 (T11) — AC #8 at the real node count, and the 20,000-node ceiling.
 *
 * WHAT THIS CAN AND CANNOT SHOW, STATED UP FRONT
 * ----------------------------------------------
 * **Real frame timing is not reachable from vitest.** There is no compositor,
 * no rAF, and no GPU here. What IS reachable — and what actually decides
 * whether the canvas holds a frame — is the cost of the work WE own: the
 * accessors force-graph calls once per node and once per edge, per frame, plus
 * the tier computation. Those are measured against the real distribution and
 * budgeted below.
 *
 * The last mile (T12) is an operator checkpoint with a DevTools frame chart,
 * and `docs/dashboard.md` says so. A green test here is a necessary condition,
 * not a sufficient one, and saying that beats a green test that proves less
 * than a reader assumes.
 *
 * HOW THE TIMINGS ARE READ. A tight wall-clock assertion on a single cold
 * sample is a flake generator, and a flaky gate gets disabled — which is worse
 * than a loose one. (Measured: the edge-accessor case first failed at 1.68 ms
 * against a 1.6 ms budget purely from cold-JIT cost under parallel workers.)
 * So every timing here is a BEST-OF-N after a warm-up: the steady-state cost
 * when the CPU is available, which is the question a per-frame budget actually
 * asks. The budgets themselves stay generous enough to catch a regression in
 * kind rather than in degree.
 */

import { describe, expect, it } from "vitest";
import {
  LIVE_EDGE_COUNT,
  LIVE_NODE_COUNT,
  LIVE_NODE_MIX,
  graphFixture,
} from "./_fixture.js";
import { edgeAccessors, type EdgeActivity } from "../edges.js";
import { shapeFor, captureSizePx } from "../shapes.js";
import { policyFor, policyForTier, shouldAggregate, tierFor } from "../tier.js";
import type { DatavizPalette } from "../palette.js";

const PALETTE: DatavizPalette = {
  bone: "var(--dataviz-bone)",
  accent: "var(--dataviz-accent)",
  muted: "var(--dataviz-muted)",
  grid: "var(--dataviz-grid)",
  edgeDim: "var(--dataviz-edge-dim)",
};

/** One frame's worth of accessor budget, in ms. ~10% of a 60 fps frame. */
const FRAME_ACCESSOR_BUDGET_MS = 1.6;

/**
 * Best-of-N after a warm-up.
 *
 * A single cold sample measures JIT compilation and whatever else the machine
 * was doing, not the steady-state per-frame cost — and this suite runs across
 * parallel vitest workers, so contention is the norm rather than the exception.
 * Taking the MINIMUM of several runs is the standard way to read a per-frame
 * budget under noise: it answers "how fast is this code when the CPU is
 * available", which is the question a frame budget asks.
 *
 * The alternative — a wider budget on one cold sample — hides a real
 * regression behind the same slack it uses to absorb noise.
 */
function bestOf(fn: () => void, runs = 7): number {
  fn(); // warm-up, discarded
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("T11 — the fixture reproduces the measured brain", () => {
  it("has the live cardinality", () => {
    const { nodes, edges } = graphFixture();
    expect(nodes).toHaveLength(LIVE_NODE_COUNT);
    expect(edges.length).toBeLessThanOrEqual(LIVE_EDGE_COUNT);
    expect(edges.length).toBeGreaterThan(LIVE_EDGE_COUNT * 0.95);
  });

  it("has the live type distribution", () => {
    const { nodes } = graphFixture();
    const counts = new Map<string, number>();
    for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    for (const [type, expectedCount] of LIVE_NODE_MIX) {
      expect(counts.get(type), type).toBe(expectedCount);
    }
  });

  it("is DETERMINISTIC — the same seed produces the same graph", () => {
    // dataviz.md's determinism limit: "the same query plus the same seed
    // produces the same canvas. A layout that cannot be re-derived violates
    // exemption 04's obligation."
    const a = graphFixture();
    const b = graphFixture();
    expect(a.nodes.map((n) => n.key)).toEqual(b.nodes.map((n) => n.key));
    expect(a.edges.map((e) => `${e.from}>${e.to}`)).toEqual(
      b.edges.map((e) => `${e.from}>${e.to}`),
    );
  });

  it("a different seed produces a different graph", () => {
    const a = graphFixture(LIVE_NODE_COUNT, LIVE_EDGE_COUNT, 1);
    const b = graphFixture(LIVE_NODE_COUNT, LIVE_EDGE_COUNT, 2);
    expect(a.edges.map((e) => e.from)).not.toEqual(b.edges.map((e) => e.from));
  });
});

describe("T11 — accessor cost at the real node count", () => {
  it("node accessors evaluate for 2,422 nodes inside the frame budget", () => {
    const { nodes } = graphFixture();
    const policy = policyFor(nodes.length);
    let sink = 0;

    const ms = bestOf(() => {
      for (const n of nodes) {
        // What force-graph calls per node, per frame: the shape resolution and
        // the pointer-area sizing.
        sink += shapeFor(n).length;
        sink += captureSizePx(8, false);
        sink += policy.arrowheadsAtRest ? 1 : 0;
      }
    });

    expect(sink).toBeGreaterThan(0);
    expect(
      ms,
      `node accessors took ${ms.toFixed(2)}ms for ${nodes.length} nodes`,
    ).toBeLessThan(FRAME_ACCESSOR_BUDGET_MS);
  });

  it("edge accessors evaluate for 1,003 edges inside the frame budget", () => {
    const { edges } = graphFixture();
    const acc = edgeAccessors(() => ({
      policy: policyForTier("C"),
      palette: PALETTE,
      activityOf: (): EdgeActivity => "rest",
      deselectProgress: 1,
      filterProgress: 0,
      matchesFilter: () => true,
    }));
    let sink = 0;

    const ms = bestOf(() => {
      for (const e of edges) {
        sink += acc.color(e).length;
        sink += acc.width(e);
        sink += acc.arrowLength(e);
        sink += acc.lineDash(e) === null ? 0 : 1;
      }
    });

    expect(sink).toBeGreaterThan(0);
    expect(
      ms,
      `edge accessors took ${ms.toFixed(2)}ms for ${edges.length} edges`,
    ).toBeLessThan(FRAME_ACCESSOR_BUDGET_MS);
  });

  it("a bulk filter costs ONE scalar change, not N tweens", () => {
    // Interaction 4 tweens a single `filterProgress`; the accessors read it.
    // This asserts the cost model: re-evaluating every edge under an active
    // filter stays in the same budget as evaluating them at rest.
    const { edges } = graphFixture();
    let progress = 0;
    const acc = edgeAccessors(() => ({
      policy: policyForTier("C"),
      palette: PALETTE,
      activityOf: (): EdgeActivity => "rest",
      deselectProgress: 1,
      filterProgress: progress,
      matchesFilter: (e) => e.type === "parent_of",
    }));

    const ms = bestOf(() => {
      for (let frame = 0; frame < 10; frame++) {
        progress = frame / 10;
        for (const e of edges) acc.color(e);
      }
    });

    // Ten frames of a full-canvas filter tween.
    expect(ms, `${ms.toFixed(2)}ms for 10 filter frames`).toBeLessThan(
      FRAME_ACCESSOR_BUDGET_MS * 10,
    );
  });
});

describe("T11 — tier computation is O(1) at any size", () => {
  it("costs the same at 2,422 and at 20,000", () => {
    const small = bestOf(() => {
      for (let i = 0; i < 10_000; i++) policyFor(2422);
    });
    const large = bestOf(() => {
      for (let i = 0; i < 10_000; i++) policyFor(20_000);
    });
    // The tier is a lookup, not a scan — which is what lets it be recomputed
    // freely as the result set changes.
    expect(small).toBeLessThan(50);
    expect(large).toBeLessThan(50);
  });
});

describe("T11 — the 20,000-node aggregation path", () => {
  const VIEWPORT = { width: 1400, height: 900 };
  // Built ONCE. This suite runs across parallel vitest workers alongside tests
  // that shell out under a 5 s timeout; regenerating 20,000 nodes per case is
  // avoidable CPU that lands on someone else's clock.
  const big = graphFixture(20_000, 8_000);

  it("builds a 20,000-node fixture with the same distribution", () => {
    expect(big.nodes).toHaveLength(20_000);
    expect(tierFor(big.nodes.length)).toBe("C");
  });

  it("rung 6 fires at 20,000 and does NOT fire at 2,422", () => {
    expect(shouldAggregate(VIEWPORT, 20_000, 8)).toBe(true);
    expect(shouldAggregate(VIEWPORT, LIVE_NODE_COUNT, 8)).toBe(false);
  });

  it("accessors still evaluate 20,000 nodes inside a 10x budget", () => {
    let sink = 0;
    const ms = bestOf(() => {
      for (const n of big.nodes) sink += shapeFor(n).length;
    });
    expect(sink).toBeGreaterThan(0);
    // 8.3x the live count, so a 10x budget is the honest comparison. If the
    // accessors were superlinear this is where it would show.
    expect(
      ms,
      `${ms.toFixed(2)}ms for 20,000 nodes`,
    ).toBeLessThan(FRAME_ACCESSOR_BUDGET_MS * 10);
  });
});
