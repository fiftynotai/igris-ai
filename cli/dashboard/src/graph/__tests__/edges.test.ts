/**
 * FR-239 (T20) — the four edge types, exemption 03, and the Tier C carve-out.
 *
 * The two assertions that carry weight:
 *   - **`hot` is unreachable at rest.** Exemption 03 makes hot per-interaction,
 *     never per-figure. If `roleFor` could ever return it, the canvas would
 *     have a hot path with nobody interacting.
 *   - **Direction is restored.** *"A canvas that never restores direction under
 *     any interaction fails this spec. Undirected at rest is permitted;
 *     undirectable is not."*
 */

import { describe, expect, it } from "vitest";
import {
  CONTROL_EDGE_TYPES,
  TRACE_MAX_HOPS,
  buildTraceChain,
  EDGE_ROLES,
  edgeAccessors,
  roleColour,
  roleFor,
  styleFor,
  type EdgeActivity,
} from "../edges.js";
import { policyForTier } from "../tier.js";
import type { DatavizPalette } from "../palette.js";
import { durationMs, runPathTrace, startTrace } from "../motion.js";
import type { GraphEdge } from "../../lib/api.js";

const PALETTE: DatavizPalette = {
  bone: "var(--dataviz-bone)",
  accent: "var(--dataviz-accent)",
  muted: "var(--dataviz-muted)",
  grid: "var(--dataviz-grid)",
  edgeDim: "var(--dataviz-edge-dim)",
};

function edge(over: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: "1",
    source_edge_id: 1,
    from: "a",
    to: "b",
    type: "related_to",
    confidence: 1,
    provenance: "observed",
    resolution: "unique",
    ...over,
  };
}

/** The full live catalog, measured on the real brain in phase 0. */
const CATALOG = [
  "parent_of",
  "depends_on",
  "blocks",
  "supersedes",
  "related_to",
  "serves_goal",
  "duplicates",
  "derived_from",
  "recurs_with",
  "cluster_member_of",
];

const PROVENANCES = ["backfill", "observed", "user", "inferred"];

describe("T20 — classification covers the catalog and returns only three roles", () => {
  it("every catalog type x every provenance resolves", () => {
    for (const type of CATALOG) {
      for (const provenance of PROVENANCES) {
        const role = roleFor(edge({ type, provenance }));
        expect(["data", "control", "optional"], `${type}/${provenance}`).toContain(
          role,
        );
      }
    }
  });

  it("D9's order: provenance OUTRANKS type", () => {
    // An inferred `blocks` is still a guess. Showing it with the same weight as
    // a human-asserted one would launder a machine's suggestion into a fact.
    expect(roleFor(edge({ type: "blocks", provenance: "inferred" }))).toBe(
      "optional",
    );
    expect(roleFor(edge({ type: "blocks", provenance: "user" }))).toBe("control");
  });

  it("the four control types, and only those", () => {
    expect([...CONTROL_EDGE_TYPES].sort()).toEqual([
      "blocks",
      "depends_on",
      "serves_goal",
      "supersedes",
    ]);
    for (const type of CATALOG) {
      const expected = CONTROL_EDGE_TYPES.includes(type) ? "control" : "data";
      expect(roleFor(edge({ type, provenance: "observed" })), type).toBe(expected);
    }
  });

  it("`suggested` provenance is optional too", () => {
    expect(roleFor(edge({ provenance: "suggested" }))).toBe("optional");
  });
});

describe("T20 — exemption 03: HOT is unreachable at rest", () => {
  it("roleFor can never return hot, for any input", () => {
    for (const type of [...CATALOG, "unknown_type"]) {
      for (const provenance of [...PROVENANCES, "whatever"]) {
        expect(roleFor(edge({ type, provenance }))).not.toBe("hot");
      }
    }
  });

  it("no resting edge is hot at ANY tier", () => {
    // "At rest the canvas has zero hot edges."
    for (const tier of ["A", "B", "C"] as const) {
      for (const type of CATALOG) {
        const s = styleFor(edge({ type }), "rest", policyForTier(tier), PALETTE);
        expect(s.color, `${tier}/${type}`).not.toBe(PALETTE.accent);
      }
    }
  });

  it("hot is reachable ONLY through the traced activity", () => {
    const traced = styleFor(edge(), "traced", policyForTier("C"), PALETTE);
    expect(traced.color).toBe(PALETTE.accent);
    // ...and only while the trace is active. "At most one hot path exists at a
    // time, and only while an interaction is active."
    const after = styleFor(edge(), "rest", policyForTier("C"), PALETTE);
    expect(after.color).toBe(PALETTE.edgeDim);
  });

  it("a hot edge is always directed", () => {
    // Being traced puts it in the active set by definition, so the Tier C
    // carve-out cannot reach it.
    expect(
      styleFor(edge(), "traced", policyForTier("C"), PALETTE).arrowLength,
    ).toBeGreaterThan(0);
  });

  it("declares exactly four roles", () => {
    expect([...EDGE_ROLES]).toEqual(["data", "control", "hot", "optional"]);
  });
});

describe("T20 — the Tier C direction carve-out, and its obligation", () => {
  it("resting edges at Tier C draw NO arrowhead", () => {
    for (const type of CATALOG) {
      const s = styleFor(edge({ type }), "rest", policyForTier("C"), PALETTE);
      expect(s.arrowLength, type).toBe(0);
    }
  });

  it("Tier A and Tier B keep arrowheads at rest", () => {
    for (const tier of ["A", "B"] as const) {
      const s = styleFor(edge(), "rest", policyForTier(tier), PALETTE);
      expect(s.arrowLength, tier).toBeGreaterThan(0);
    }
  });

  it("the ACTIVE set restores direction — direction is deferred, not discarded", () => {
    // The obligation the carve-out ships with. "A canvas that never restores
    // direction under any interaction FAILS this spec."
    for (const activity of ["active", "traced"] as EdgeActivity[]) {
      const s = styleFor(edge(), activity, policyForTier("C"), PALETTE);
      expect(s.arrowLength, activity).toBeGreaterThan(0);
    }
  });

  it("direction and full role colour return TOGETHER", () => {
    // "Direction is restored by the same interaction that returns the edge to
    // full role colour." One branch, so they cannot diverge.
    const resting = styleFor(edge(), "rest", policyForTier("C"), PALETTE);
    const active = styleFor(edge(), "active", policyForTier("C"), PALETTE);
    expect(resting.arrowLength).toBe(0);
    expect(resting.color).toBe(PALETTE.edgeDim);
    expect(active.arrowLength).toBeGreaterThan(0);
    expect(active.color).toBe(PALETTE.bone);
  });
});

describe("T20 — rung 3: edge opacity, and only opacity", () => {
  it("Tier A renders full role colour", () => {
    const p = policyForTier("A");
    expect(styleFor(edge({ type: "related_to" }), "rest", p, PALETTE).color).toBe(
      PALETTE.bone,
    );
    expect(styleFor(edge({ type: "blocks" }), "rest", p, PALETTE).color).toBe(
      PALETTE.muted,
    );
  });

  it("Tier B steps DATA down first — control keeps its role", () => {
    // "Data edges dim before control, hot, or optional."
    const p = policyForTier("B");
    expect(styleFor(edge({ type: "related_to" }), "rest", p, PALETTE).color).toBe(
      PALETTE.muted,
    );
    expect(styleFor(edge({ type: "blocks" }), "rest", p, PALETTE).color).toBe(
      PALETTE.muted,
    );
    // Optional keeps ACCENT at Tier B.
    expect(
      styleFor(edge({ provenance: "inferred" }), "rest", p, PALETTE).color,
    ).toBe(PALETTE.accent);
  });

  it("Tier C dims resting data and control to the derived alias", () => {
    const p = policyForTier("C");
    expect(styleFor(edge({ type: "related_to" }), "rest", p, PALETTE).color).toBe(
      PALETTE.edgeDim,
    );
    expect(styleFor(edge({ type: "blocks" }), "rest", p, PALETTE).color).toBe(
      PALETTE.edgeDim,
    );
  });

  it("optional keeps its ACCENT hue even when dimmed — role semantics never degrade", () => {
    const s = styleFor(
      edge({ provenance: "inferred" }),
      "rest",
      policyForTier("C"),
      PALETTE,
    );
    expect(s.color).toContain(PALETTE.accent);
    // A colour-mix against transparent: the hue is the role's, only alpha moves.
    expect(s.color).toContain("transparent");
  });

  it("every colour it can emit dereferences a role token — never a literal", () => {
    for (const tier of ["A", "B", "C"] as const) {
      for (const activity of ["rest", "active", "traced"] as EdgeActivity[]) {
        for (const type of CATALOG) {
          for (const provenance of PROVENANCES) {
            const s = styleFor(
              edge({ type, provenance }),
              activity,
              policyForTier(tier),
              PALETTE,
            );
            expect(s.color, `${tier}/${activity}/${type}`).toContain(
              "var(--dataviz-",
            );
          }
        }
      }
    }
  });

  it("roleColour maps each role to exactly one token", () => {
    expect(roleColour("data", PALETTE)).toBe(PALETTE.bone);
    expect(roleColour("control", PALETTE)).toBe(PALETTE.muted);
    expect(roleColour("optional", PALETTE)).toBe(PALETTE.accent);
    expect(roleColour("hot", PALETTE)).toBe(PALETTE.accent);
  });
});

describe("T20 — dashes carry the optional role at every tier", () => {
  it("optional is dashed, data and control are not", () => {
    const p = policyForTier("C");
    expect(
      styleFor(edge({ provenance: "inferred" }), "rest", p, PALETTE).lineDash,
    ).not.toBeNull();
    expect(styleFor(edge(), "rest", p, PALETTE).lineDash).toBeNull();
  });

  it("the dash survives the dimming — it IS the role", () => {
    for (const tier of ["A", "B", "C"] as const) {
      const s = styleFor(
        edge({ provenance: "inferred" }),
        "rest",
        policyForTier(tier),
        PALETTE,
      );
      expect(s.lineDash, tier).not.toBeNull();
    }
  });
});

describe("interaction 4 — one scalar drives a bulk change", () => {
  function ctx(filterProgress: number, matches: (e: GraphEdge) => boolean) {
    return () => ({
      policy: policyForTier("C"),
      palette: PALETTE,
      activityOf: (): EdgeActivity => "rest",
      deselectProgress: 1,
      filterProgress,
      matchesFilter: matches,
    });
  }

  it("a non-matching edge dims further as the tween runs", () => {
    const acc = edgeAccessors(ctx(1, () => false));
    const dimmed = acc.color(edge());
    // The HUE is untouched — a filtered-out control edge is still a control
    // edge, and category never lives in hue anyway.
    expect(dimmed).toContain("var(--dataviz-");
    expect(dimmed).toContain("transparent");
  });

  it("a matching edge is untouched by the filter", () => {
    const acc = edgeAccessors(ctx(1, () => true));
    expect(acc.color(edge())).toBe(PALETTE.edgeDim);
  });

  it("at progress 0 nothing is dimmed, matching or not", () => {
    const acc = edgeAccessors(ctx(0, () => false));
    expect(acc.color(edge())).toBe(PALETTE.edgeDim);
  });

  it("C2 — an active edge EASES back to rest, it does not snap", () => {
    // The deselect is driven by the same scalar as the selection ring. Without
    // this, the 1-hop edges held full role colour for the entire 320 ms clear
    // tween and then jumped to their resting style when it completed — the node
    // easing while its edges snapped.
    let deselect = 1;
    const acc = edgeAccessors(() => ({
      policy: policyForTier("C"),
      palette: PALETTE,
      activityOf: (): EdgeActivity => "active",
      filterProgress: 0,
      deselectProgress: deselect,
      matchesFilter: () => true,
    }));

    const held = acc.width(edge());
    deselect = 0.5;
    const midway = acc.width(edge());
    deselect = 0;
    const released = acc.width(edge());

    // Strictly monotonic: a genuine interpolation, not a two-state flip.
    expect(midway).toBeLessThan(held);
    expect(midway).toBeGreaterThan(released);
    // And it lands exactly on the resting style.
    expect(released).toBe(
      styleFor(edge(), "rest", policyForTier("C"), PALETTE).width,
    );
  });

  it("C2 — the eased colour stays a blend of ROLE tokens", () => {
    const acc = edgeAccessors(() => ({
      policy: policyForTier("C"),
      palette: PALETTE,
      activityOf: (): EdgeActivity => "active",
      filterProgress: 0,
      deselectProgress: 0.5,
      matchesFilter: () => true,
    }));
    const c = acc.color(edge());
    // Never a third colour — only a mix of two the palette authorised.
    expect(c).toContain("var(--dataviz-");
    expect(c).toContain("color-mix");
  });

  it("the accessors re-read the context on EVERY call", () => {
    // This is the property that makes a palette swap correct on the next
    // repaint with zero re-binding (D1) — and that a bulk filter costs ONE
    // tween rather than N.
    let progress = 0;
    const acc = edgeAccessors(() => ({
      policy: policyForTier("C"),
      palette: PALETTE,
      activityOf: (): EdgeActivity => "rest",
      deselectProgress: 1,
      filterProgress: progress,
      matchesFilter: () => false,
    }));
    const before = acc.color(edge());
    progress = 1;
    const after = acc.color(edge());
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Interaction 5 — the trace chain and its UNEXERCISED bound
// ---------------------------------------------------------------------------

describe("the 30-hop trace cap — driven by a synthetic chain, not the live brain", () => {
  /** `n` edges in a straight line: n0 -> n1 -> … -> n{n}. */
  function chainOf(n: number): GraphEdge[] {
    return Array.from({ length: n }, (_, i) =>
      edge({
        // Zero-padded so lexical id ordering matches hop order — the builder
        // sorts by id, and an unpadded "10" would sort before "2".
        id: String(i).padStart(4, "0"),
        from: `n${i}`,
        to: `n${i + 1}`,
      }),
    );
  }

  it("a 50-hop chain is capped at 30", () => {
    // The live brain's longest deterministic outgoing chain is SIX hops across
    // ~2,438 nodes — nothing real reaches 10, so this bound was structural only
    // until this fixture existed. A bound nothing exercises is where the next
    // duration-per-hop bug hides.
    expect(buildTraceChain(chainOf(50), "n0")).toHaveLength(TRACE_MAX_HOPS);
  });

  it("a chain SHORTER than the cap is returned whole", () => {
    expect(buildTraceChain(chainOf(6), "n0")).toHaveLength(6);
  });

  it("the TIME cap is MEASURED: a 30-hop trace takes as long as a 3-hop one", async () => {
    /*
     * The previous version of this test was a tautology. It built `short` and
     * `long`, then called a zero-argument helper that read
     * `durationMs(INTERACTIONS["path-trace"].duration)` twice and compared the
     * results — `600 === 600`. The chains never reached it.
     *
     * The consequence was demonstrated, not theorised: rewriting `traceFrom` to
     * chain one `// SLOW` tween per hop via `onComplete` recursion makes a
     * 30-hop trace take EIGHTEEN SECONDS, and the whole suite stayed green.
     *
     * So this drives the REAL trace and measures the wall clock. GSAP runs
     * headless (verified: a 300 ms tween completes in ~298 ms), so a per-hop
     * chain would blow the bound by ~30x and fail loudly.
     */
    const short = buildTraceChain(chainOf(3), "n0");
    const long = buildTraceChain(chainOf(50), "n0");
    expect(short).toHaveLength(3);
    expect(long).toHaveLength(TRACE_MAX_HOPS);

    const run = async (hops: number): Promise<{ ms: number; declared: number }> => {
      const t0 = performance.now();
      let declared = 0;
      await new Promise<void>((resolve) => {
        const h = runPathTrace(hops, () => undefined, {
          reducedMotion: false,
          onComplete: () => resolve(),
        });
        declared = h.durationMs;
      });
      return { ms: performance.now() - t0, declared };
    };

    const a = await run(short.length);
    const b = await run(long.length);

    // Both land on the token, within timer jitter.
    const SLOW = durationMs("slow");
    expect(SLOW).toBe(600);
    expect(a.declared).toBe(SLOW);
    expect(b.declared).toBe(SLOW);
    expect(a.ms).toBeGreaterThan(SLOW * 0.6);
    expect(a.ms).toBeLessThan(SLOW * 1.8);
    expect(b.ms).toBeGreaterThan(SLOW * 0.6);
    expect(b.ms).toBeLessThan(SLOW * 1.8);

    // THE ASSERTION THAT MATTERS: 10x the hops must not cost 10x the time.
    // A per-hop chain would make `b.ms` ~6000 ms against `a.ms` ~600 ms.
    expect(Math.abs(b.ms - a.ms)).toBeLessThan(SLOW * 0.5);
    expect(b.ms).toBeLessThan(a.ms * 2);
  }, 15_000);

  it("the COMPOSITION is wall-clocked too: 3 hops and 30 hops take the same time", async () => {
    /*
     * MUTATION B. The unit (`runPathTrace`) being one tween says nothing about
     * how the CALLER composes it. Chaining `runPathTrace(1, …)` once per hop
     * through `onComplete` makes a 30-hop trace take 18 seconds while
     * satisfying every structural ban — no `"path-trace"` literal in the
     * caller, the unit's body untouched, no `hops *` term. It passed 237/237.
     *
     * So the composition is driven directly here, end to end, at both lengths.
     */
    const run = async (edges: GraphEdge[]): Promise<number> => {
      const t0 = performance.now();
      await new Promise<void>((resolve) => {
        const h = startTrace(
          edges,
          "n0",
          { onTraced: () => undefined, onStart: () => undefined, onEnd: () => resolve() },
          { reducedMotion: false },
        );
        // A null handle would resolve nothing and hang the test — assert it ran.
        expect(h).not.toBeNull();
      });
      return performance.now() - t0;
    };

    const shortMs = await run(chainOf(3));
    const longMs = await run(chainOf(50));   // capped to 30 hops
    const SLOW = durationMs("slow");

    expect(shortMs).toBeGreaterThan(SLOW * 0.6);
    expect(shortMs).toBeLessThan(SLOW * 1.8);
    expect(longMs).toBeGreaterThan(SLOW * 0.6);
    expect(longMs).toBeLessThan(SLOW * 1.8);
    // 10x the hops must not cost 10x the time. A per-hop chain in the CALLER
    // would put `longMs` at ~18,000 ms.
    expect(Math.abs(longMs - shortMs)).toBeLessThan(SLOW * 0.5);
  }, 25_000);

  it("startTrace returns null when there is nothing to trace", () => {
    // The common case, not an edge case: 1,780 of 2,438 live nodes have no
    // outgoing chain, so `traceFrom` must produce no hot edges and no tween.
    let started = false;
    const h = startTrace(
      chainOf(5),
      "n5",
      { onTraced: () => undefined, onStart: () => { started = true; }, onEnd: () => undefined },
      { reducedMotion: false },
    );
    expect(h).toBeNull();
    // ...and it must not have opened an interaction it will never close.
    expect(started).toBe(false);
  });

  it("startTrace clears the hot set when the trace ends", async () => {
    const seen: number[] = [];
    await new Promise<void>((resolve) => {
      startTrace(
        chainOf(6),
        "n0",
        {
          onTraced: (ids) => seen.push(ids.size),
          onStart: () => undefined,
          onEnd: () => resolve(),
        },
        { reducedMotion: true },
      );
    });
    // Grows during the trace, and the LAST report is empty — "at rest the
    // canvas has zero hot edges".
    expect(Math.max(...seen)).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(0);
  });

  it("progress maps onto hops — a longer chain advances FASTER per hop", () => {
    // The other half of "long paths trace faster": the same normalised progress
    // covers more hops on a longer chain.
    const reached: number[] = [];
    runPathTrace(30, (n) => reached.push(n), {
      reducedMotion: true,
      onComplete: () => undefined,
    });
    // Reduced motion jumps straight to the end: all 30 hops, one update.
    expect(reached.at(-1)).toBe(30);
  });

  it("is deterministic — the same start always traces the same chain", () => {
    const edges = chainOf(40);
    const a = buildTraceChain(edges, "n0").map((e) => e.id);
    const b = buildTraceChain([...edges].reverse(), "n0").map((e) => e.id);
    // Input order must not change the result.
    expect(b).toEqual(a);
  });

  it("never revisits a node, so a cycle terminates short of closing", () => {
    const cycle = [
      edge({ id: "0001", from: "a", to: "b" }),
      edge({ id: "0002", from: "b", to: "c" }),
      edge({ id: "0003", from: "c", to: "a" }), // closes back to the start
    ];
    const walked = buildTraceChain(cycle, "a");
    // The closing edge is EXCLUDED: its target is already on the path. Without
    // that, a cycle would walk until the hop cap and the hot path would be a
    // loop rather than a lineage.
    expect(walked.map((e) => e.id)).toEqual(["0001", "0002"]);
    expect(new Set(walked.map((e) => e.id)).size).toBe(walked.length);
  });

  it("a node with no outgoing edge traces nothing", () => {
    expect(buildTraceChain(chainOf(5), "n5")).toEqual([]);
  });

  it("every traced edge becomes HOT, and only while traced", () => {
    const chain = buildTraceChain(chainOf(50), "n0");
    const traced = new Set(chain.map((e) => e.id));
    for (const e of chain) {
      expect(styleFor(e, "traced", policyForTier("C"), PALETTE).color).toBe(
        PALETTE.accent,
      );
      expect(traced.has(e.id)).toBe(true);
    }
    // ...and the same edge at rest is not hot. Exemption 03.
    expect(styleFor(chain[0], "rest", policyForTier("C"), PALETTE).color).toBe(
      PALETTE.edgeDim,
    );
  });
});
