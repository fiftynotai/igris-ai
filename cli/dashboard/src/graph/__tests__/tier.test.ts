/**
 * FR-239 (T18, T21) — density tiers, the ordered ladder, and rung 6.
 *
 * The ladder is *"normative and ordered. Never skip a rung to reach a lower
 * one."* That is the property F1 turns on: cytoscape's `hideEdgesOnViewport`
 * drops every edge at once, skipping rungs 3, 4 and 5 to land past rung 5. This
 * file is where "the ladder is the spec's" stops being a claim.
 */

import { describe, expect, it } from "vitest";
import {
  LADDER,
  LEGIBLE_OCCUPANCY,
  NEVER_DEGRADES,
  TIER_B_MIN,
  TIER_C_MIN,
  fitsAtFloor,
  isDegradedAtRest,
  policyFor,
  policyForTier,
  restingRungs,
  rungOf,
  shouldAggregate,
  tierFor,
} from "../tier.js";

describe("T18 — tier boundaries", () => {
  it("declares A / B / C at 50 and 500", () => {
    expect(tierFor(0)).toBe("A");
    expect(tierFor(49)).toBe("A");
    expect(tierFor(50)).toBe("B");
    expect(tierFor(499)).toBe("B");
    // Exactly 500 is Tier C — the denser reading, which is the safe direction
    // for a boundary that governs legibility.
    expect(tierFor(500)).toBe("C");
    expect(tierFor(2422)).toBe("C");
  });

  it("the boundaries are the published ones", () => {
    expect(TIER_B_MIN).toBe(50);
    expect(TIER_C_MIN).toBe(500);
  });

  it("the LIVE brain sits at Tier C", () => {
    // 2,422 nodes measured on the real brain during phase 0.
    expect(tierFor(2422)).toBe("C");
  });

  it("the tier is a FUNCTION of the current result set, not of the store", () => {
    // Drilling into a small project flips the same accessors to Tier A. This is
    // how D5/N2's "are Tier A labels on?" resolves through the ladder rather
    // than through a special case.
    expect(policyFor(2422).labels).toBe("active-only");
    expect(policyFor(30).labels).toBe("all");
    expect(policyFor(30).arrowheadsAtRest).toBe(true);
  });
});

describe("T18 — the ladder is ordered and complete", () => {
  it("has exactly six rungs in the published order", () => {
    expect([...LADDER]).toEqual([
      "labels",
      "node-chrome",
      "edge-opacity",
      "edge-direction-markers",
      "edge-culling",
      "node-aggregation",
    ]);
  });

  it("numbers them 1..6", () => {
    expect(rungOf("labels")).toBe(1);
    expect(rungOf("node-aggregation")).toBe(6);
  });

  it("no tier skips a rung to reach a lower one", () => {
    // The property F1 turns on. Each tier's resting degradation must be a
    // PREFIX of the ladder — engaging rung 4 without rung 3 would be exactly
    // cytoscape's `hideEdgesOnViewport` failure in our own code.
    for (const tier of ["A", "B", "C"] as const) {
      const engaged = restingRungs(tier);
      const expected = LADDER.slice(0, engaged.length);
      expect([...engaged], `tier ${tier} skips a rung`).toEqual([...expected]);
    }
  });

  it("Tier C engages rungs 1-4 at rest, and no more", () => {
    expect([...restingRungs("C")]).toHaveLength(4);
    // Rungs 5 and 6 do NOT follow from the tier: culling follows from the
    // active set, aggregation from `fitsAtFloor`.
    expect(isDegradedAtRest("C", "edge-culling")).toBe(false);
    expect(isDegradedAtRest("C", "node-aggregation")).toBe(false);
  });

  it("Tier A degrades nothing at rest", () => {
    expect([...restingRungs("A")]).toEqual([]);
  });

  it("the direction-marker carve-out is Tier C ONLY", () => {
    // "At Tier A and Tier B every edge carries its arrowhead at rest."
    expect(policyForTier("A").arrowheadsAtRest).toBe(true);
    expect(policyForTier("B").arrowheadsAtRest).toBe(true);
    expect(policyForTier("C").arrowheadsAtRest).toBe(false);
  });

  it("names what never degrades, including edge DIRECTION", () => {
    expect([...NEVER_DEGRADES]).toContain("edge-direction");
    expect([...NEVER_DEGRADES]).toContain("colour-roles");
    expect([...NEVER_DEGRADES]).toContain("five-shape-vocabulary");
    // The marker may be withheld at rest; the direction never is. No rung is
    // permitted to name one of these.
    for (const never of NEVER_DEGRADES) {
      expect(LADDER as readonly string[]).not.toContain(never);
    }
  });
});

describe("T18 — size floors are expressed against the 8-pt scale", () => {
  it("Tier C floors at --s-1, Tier B at --s-2, Tier A has no floor", () => {
    // "Node size floors are expressed against this scale, never as bare pixels."
    expect(policyForTier("C").floorToken).toBe("--s-1");
    expect(policyForTier("B").floorToken).toBe("--s-2");
    expect(policyForTier("A").floorToken).toBeNull();
  });

  it("the canvas is the hit target at Tier C only", () => {
    expect(policyForTier("C").canvasIsHitTarget).toBe(true);
    expect(policyForTier("B").canvasIsHitTarget).toBe(false);
    expect(policyForTier("A").canvasIsHitTarget).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rung 6 — aggregation
// ---------------------------------------------------------------------------

const VIEWPORT = { width: 1400, height: 900 };
const FLOOR = 8; // --s-1

describe("T18 — rung 6 fires only when the set cannot fit at the floor", () => {
  it("does NOT trigger on today's real brain", () => {
    // 2,422 nodes at the 8 px floor need 154,624 px^2; a 1400x900 canvas offers
    // 1,260,000 px^2, of which the occupancy ceiling allows 315,000. The rule
    // ships and is tested; it simply does not fire yet.
    expect(fitsAtFloor(VIEWPORT, 2422, FLOOR)).toBe(true);
    expect(shouldAggregate(VIEWPORT, 2422, FLOOR)).toBe(false);
  });

  it("DOES trigger on the 20,000-node synthetic case", () => {
    expect(fitsAtFloor(VIEWPORT, 20_000, FLOOR)).toBe(false);
    expect(shouldAggregate(VIEWPORT, 20_000, FLOOR)).toBe(true);
  });

  it("is exact at the occupancy boundary", () => {
    const capacity = Math.floor(
      (VIEWPORT.width * VIEWPORT.height * LEGIBLE_OCCUPANCY) / (FLOOR * FLOOR),
    );
    expect(fitsAtFloor(VIEWPORT, capacity, FLOOR)).toBe(true);
    expect(fitsAtFloor(VIEWPORT, capacity + 1, FLOOR)).toBe(false);
  });

  it("a smaller viewport aggregates sooner", () => {
    expect(fitsAtFloor({ width: 320, height: 240 }, 2422, FLOOR)).toBe(false);
  });

  it("a degenerate viewport aggregates rather than dividing by zero", () => {
    expect(fitsAtFloor({ width: 0, height: 0 }, 10, FLOOR)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T21 — the empty graph
// ---------------------------------------------------------------------------

describe("T21 — zero nodes", () => {
  it("declares Tier A and degrades nothing", () => {
    expect(tierFor(0)).toBe("A");
    expect([...restingRungs("A")]).toEqual([]);
  });

  it("fits trivially — no aggregation, no division by a zero count", () => {
    expect(fitsAtFloor(VIEWPORT, 0, FLOOR)).toBe(true);
    expect(shouldAggregate(VIEWPORT, 0, FLOOR)).toBe(false);
  });

  it("a negative count cannot crash the predicate", () => {
    expect(fitsAtFloor(VIEWPORT, -1, FLOOR)).toBe(true);
  });
});
