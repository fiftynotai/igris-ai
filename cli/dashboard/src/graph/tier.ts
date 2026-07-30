/**
 * FR-239 — density tiers and the normative degradation ladder.
 *
 * `docs/brand/dataviz.md` §04. Three tiers by node count, and a SIX-RUNG
 * ladder that is explicitly *"normative and ordered. Never skip a rung to reach
 * a lower one."*
 *
 * THE TIER IS A FUNCTION, NOT A CONSTANT. It is declared from *"the size of the
 * current result set, not from the size of the underlying store."* That is what
 * makes drill-down work: the whole brain is 2,422 nodes and sits at Tier C with
 * labels off; drilling into a project under 50 flips the SAME accessors to
 * Tier A — every label on, full node chrome, arrowheads at rest. D5/N2's
 * "should Tier A labels be on?" question resolves through the ladder rather
 * than through a special case.
 *
 * WHY THE LADDER IS DATA AND NOT AN `if`-CHAIN. F1 — the reason `force-graph`
 * won over cytoscape — is that cytoscape's performance remedies
 * (`textureOnViewport`, `hideEdgesOnViewport`) are a DIFFERENT ladder, fired by
 * a trigger (viewport motion) the spec does not recognise, and
 * `hideEdgesOnViewport` drops every edge at once, skipping rungs 3, 4 and 5 to
 * land past rung 5. Expressing the ladder as an ordered, testable list is how
 * this canvas guarantees the ladder is the SPEC's.
 */

export type Tier = "A" | "B" | "C";

/**
 * Tier boundaries.
 *
 * dataviz.md's table reads "under 50" / "50-500" / "500+", which overlaps at
 * 500. Resolved half-open and stated once here so the two boundary cases are
 * not decided differently in two places: A is `n < 50`, B is `50 <= n < 500`,
 * C is `n >= 500`. Exactly 500 is Tier C — the denser reading, which is the
 * safe direction for a boundary that governs legibility.
 */
export const TIER_B_MIN = 50;
export const TIER_C_MIN = 500;

export function tierFor(nodeCount: number): Tier {
  if (nodeCount < TIER_B_MIN) return "A";
  if (nodeCount < TIER_C_MIN) return "B";
  return "C";
}

/**
 * The six rungs, in the order they give way. The index IS the rung number.
 *
 * `dataviz.md` §04: *"The degradation ladder — what gives way first. Normative
 * and ordered."*
 */
export const LADDER = [
  "labels",
  "node-chrome",
  "edge-opacity",
  "edge-direction-markers",
  "edge-culling",
  "node-aggregation",
] as const;

export type Rung = (typeof LADDER)[number];

/** 1-based rung number, as the spec numbers them. */
export function rungOf(rung: Rung): number {
  return LADDER.indexOf(rung) + 1;
}

/**
 * What is degraded AT REST at each tier.
 *
 * Rung 4 (direction markers) is Tier-C-only by the spec's own carve-out:
 * *"At Tier A and Tier B every edge carries its arrowhead at rest."* Rung 5
 * (culling) and rung 6 (aggregation) are not engaged by tier alone — culling
 * follows from the active set, aggregation from `fitsAtFloor`.
 */
const RESTING_DEGRADATION: Readonly<Record<Tier, readonly Rung[]>> = {
  A: [],
  B: ["labels", "node-chrome"],
  C: ["labels", "node-chrome", "edge-opacity", "edge-direction-markers"],
};

export function restingRungs(tier: Tier): readonly Rung[] {
  return RESTING_DEGRADATION[tier];
}

/** Is a rung engaged at rest at this tier? */
export function isDegradedAtRest(tier: Tier, rung: Rung): boolean {
  return RESTING_DEGRADATION[tier].includes(rung);
}

/**
 * Never degrades, at any tier. dataviz.md §04.
 *
 * Held as data so `tier.test.ts` can assert the ladder never reaches them —
 * a rung that starts touching one of these is a brand break, not a tuning
 * decision.
 */
export const NEVER_DEGRADES = [
  "colour-roles",
  "role-semantics",
  "five-shape-vocabulary",
  "edge-direction", // the MARKER may be withheld at rest; the direction never is
  "type-system",
] as const;

// ---------------------------------------------------------------------------
// Per-tier policy — the accessors read this, they do not branch on the tier
// ---------------------------------------------------------------------------

export type LabelPolicy = "all" | "ranked" | "active-only";
export type NodeChrome = "full" | "silhouette-padded" | "silhouette";
export type EdgeRest = "role-colour" | "data-dimmed" | "all-dimmed";

export interface TierPolicy {
  tier: Tier;
  /** Which nodes carry a label at rest. */
  labels: LabelPolicy;
  /** How much of the node's chrome survives. */
  chrome: NodeChrome;
  /** How resting edges are coloured. */
  edgesAtRest: EdgeRest;
  /** Whether a RESTING edge draws its arrowhead (the §04 carve-out). */
  arrowheadsAtRest: boolean;
  /** Node size floor, as a `--s-*` token name. Never a bare pixel value. */
  floorToken: "--s-1" | "--s-2" | null;
  /** Whether the canvas — rather than the node — is the interactive element. */
  canvasIsHitTarget: boolean;
}

const POLICIES: Readonly<Record<Tier, TierPolicy>> = {
  A: {
    tier: "A",
    labels: "all",
    chrome: "full",
    edgesAtRest: "role-colour",
    arrowheadsAtRest: true,
    floorToken: null, // no floor is reached at this density
    canvasIsHitTarget: false,
  },
  B: {
    tier: "B",
    labels: "ranked",
    chrome: "silhouette-padded",
    edgesAtRest: "data-dimmed",
    arrowheadsAtRest: true,
    floorToken: "--s-2",
    canvasIsHitTarget: false,
  },
  C: {
    tier: "C",
    labels: "active-only",
    chrome: "silhouette",
    edgesAtRest: "all-dimmed",
    // The one carve-out. Direction is DEFERRED, never discarded: every edge in
    // the active set gets its arrowhead back (see `edges.ts`). A canvas that
    // never restores direction fails the spec — "undirected at rest is
    // permitted; undirectable is not".
    arrowheadsAtRest: false,
    floorToken: "--s-1",
    canvasIsHitTarget: true,
  },
};

export function policyFor(nodeCount: number): TierPolicy {
  return POLICIES[tierFor(nodeCount)];
}

export function policyForTier(tier: Tier): TierPolicy {
  return POLICIES[tier];
}

// ---------------------------------------------------------------------------
// Rung 6 — aggregation. The last rung, and the only one with a real predicate.
// ---------------------------------------------------------------------------

export interface Viewport {
  width: number;
  height: number;
}

/**
 * The fraction of the viewport that nodes at the floor may occupy before the
 * canvas stops reading as a graph and starts reading as a texture.
 *
 * dataviz.md gives the RULE ("below the floor a node does not shrink — it
 * aggregates") but no number, so this one is ours and is stated rather than
 * buried. A node at the `--s-1` floor is 8 px of silhouette; at 100% occupancy
 * the field is solid and no shape is legible, which is the outcome the
 * five-shape vocabulary exists to prevent. A quarter leaves every silhouette
 * with roughly its own width of clear field around it.
 */
export const LEGIBLE_OCCUPANCY = 0.25;

/**
 * Can `count` nodes be drawn at `floorPx` without crossing the occupancy
 * ceiling?
 *
 * **RUNG 6 IS NOT IMPLEMENTED, AND THIS PREDICATE DOES NOT PRETEND IT IS.**
 * The spec says that below the floor a node aggregates into a cluster node
 * carrying its count. Nothing here aggregates and no cluster node is drawn —
 * at this density silhouettes simply overlap. Nothing VANISHES, so the spec's
 * "a node never silently disappears" still holds, but the honest remedy today
 * is to narrow the set, and that is what the banner says.
 *
 * The predicate ships and is tested because it is the trigger rung 6 will use,
 * and because the surface needs to tell the operator when the set is past the
 * legible floor. A `clusterSize` helper used to live beside it, referenced only
 * from its own test; it was deleted rather than left as evidence of a feature
 * that does not exist. The gap is recorded in `docs/dashboard.md`.
 */
export function fitsAtFloor(
  viewport: Viewport,
  count: number,
  floorPx: number,
): boolean {
  if (count <= 0) return true;
  const area = Math.max(0, viewport.width) * Math.max(0, viewport.height);
  if (area <= 0) return false;
  return count * floorPx * floorPx <= area * LEGIBLE_OCCUPANCY;
}

/** Rung 6's trigger. Aggregation is the LAST resort, never an optimisation. */
export function shouldAggregate(
  viewport: Viewport,
  count: number,
  floorPx: number,
): boolean {
  return !fitsAtFloor(viewport, count, floorPx);
}
