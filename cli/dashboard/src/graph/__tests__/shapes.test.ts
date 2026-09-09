/**
 * FR-239 (T20) — D9's entity mapping, the closed shape vocabulary, and the
 * Rule 2.4 capture radius.
 */

import { describe, expect, it } from "vitest";
import {
  FINE_POINTER_CAPTURE_PX,
  MAPPED_ENTITY_TYPES,
  NODE_SIZE_ZOOM_FLOOR,
  SHAPES,
  TAP_TARGET_MIN_PX,
  captureSizePx,
  isDashed,
  nodeWorldSize,
  shapeFor,
  tracePath,
  type ShapeKind,
} from "../shapes.js";
import type { GraphNode } from "../../lib/api.js";

function node(over: Partial<GraphNode> = {}): GraphNode {
  return {
    key: "brief|p|X",
    type: "brief",
    id: "X",
    project: "p",
    label: "X",
    attrs: {},
    degree: 0,
    ...over,
  };
}

/** Every entity type `whole-graph.ts` can materialise, from its own constants. */
const BUILDER_ENTITY_TYPES = [
  "brief",
  "learning",
  "goal",
  "error",
  "concept",
  "decision",
  "session",
];

describe("T20 — every entity type maps to one of exactly five shapes", () => {
  it("the vocabulary is closed at five — there is no sixth", () => {
    expect([...SHAPES]).toEqual([
      "SERVICE",
      "AGENT",
      "STORE",
      "TOOL",
      "EXTERNAL",
    ]);
    expect(new Set(SHAPES).size).toBe(5);
  });

  it("covers every type the builder can emit — no type falls through", () => {
    for (const type of BUILDER_ENTITY_TYPES) {
      expect(
        MAPPED_ENTITY_TYPES,
        `${type} has no explicit shape mapping`,
      ).toContain(type);
    }
  });

  it("maps D9 exactly", () => {
    expect(shapeFor(node({ type: "brief" }))).toBe("SERVICE");
    expect(shapeFor(node({ type: "session" }))).toBe("SERVICE");
    expect(shapeFor(node({ type: "learning" }))).toBe("STORE");
    expect(shapeFor(node({ type: "concept" }))).toBe("STORE");
    expect(shapeFor(node({ type: "decision" }))).toBe("STORE");
    expect(shapeFor(node({ type: "goal" }))).toBe("AGENT");
    // FLAGGED WEAK FIT, recorded in `shapes.ts`: an error is the TRACE of a
    // side-effect, not itself side-effecting. Live population is 2 nodes. The
    // mapping is asserted so a future change is a deliberate one.
    expect(shapeFor(node({ type: "error" }))).toBe("TOOL");
  });

  it("an UNKNOWN type falls back to EXTERNAL rather than inventing a shape", () => {
    // §07 rule 2: never invent a shape. A type the builder grows before this
    // file learns about it renders as "outside the system boundary", which is
    // the honest reading of a node we cannot classify.
    expect(shapeFor(node({ type: "brand-new-type" }))).toBe("EXTERNAL");
  });

  it("boundary and phantom OUTRANK the entity type", () => {
    // Both mean "lives outside the system boundary", which IS the EXTERNAL
    // definition. Drawing them as their entity type would claim they are part
    // of the set the query returned — the one thing the twin says they are not.
    expect(shapeFor(node({ type: "brief", boundary: true }))).toBe("EXTERNAL");
    expect(shapeFor(node({ type: "learning", phantom: true }))).toBe("EXTERNAL");
  });

  it("only TOOL is dashed", () => {
    for (const s of SHAPES) {
      expect(isDashed(s)).toBe(s === "TOOL");
    }
  });
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Records the path commands so geometry can be asserted without a canvas. */
function recorder() {
  const ops: Array<{ op: string; args: number[] }> = [];
  const path = {
    moveTo: (...a: number[]) => ops.push({ op: "moveTo", args: a }),
    lineTo: (...a: number[]) => ops.push({ op: "lineTo", args: a }),
    arcTo: (...a: number[]) => ops.push({ op: "arcTo", args: a }),
    arc: (...a: number[]) => ops.push({ op: "arc", args: a }),
    closePath: () => ops.push({ op: "closePath", args: [] }),
    bezierCurveTo: (...a: number[]) => ops.push({ op: "bezier", args: a }),
    quadraticCurveTo: (...a: number[]) => ops.push({ op: "quad", args: a }),
    ellipse: (...a: number[]) => ops.push({ op: "ellipse", args: a }),
    rect: (...a: number[]) => ops.push({ op: "rect", args: a }),
    roundRect: (...a: number[]) => ops.push({ op: "roundRect", args: a }),
  } as unknown as CanvasPath;
  return { path, ops };
}

describe("T20 — every shape traces a closed path within its bounds", () => {
  const SIZE = 20;
  const PAD = 0.001;

  for (const shape of SHAPES) {
    it(`${shape} closes and stays inside its box`, () => {
      const { path, ops } = recorder();
      tracePath(path, shape as ShapeKind, 0, 0, SIZE);

      expect(ops.length, `${shape} traced nothing`).toBeGreaterThan(0);
      expect(ops.at(-1)?.op, `${shape} is not closed`).toBe("closePath");

      // EXTERNAL's slant deliberately extends past the half-width — it is an
      // "italic block". Every other shape stays inside.
      const limit = shape === "EXTERNAL" ? SIZE : SIZE / 2 + PAD;
      for (const { op, args } of ops) {
        if (op === "closePath") continue;
        for (const v of args.slice(0, 2)) {
          expect(Math.abs(v), `${shape}/${op} escapes its box`).toBeLessThanOrEqual(
            limit,
          );
        }
      }
    });
  }

  it("AGENT is a hexagon — six vertices", () => {
    const { path, ops } = recorder();
    tracePath(path, "AGENT", 0, 0, SIZE);
    const vertices = ops.filter((o) => o.op === "moveTo" || o.op === "lineTo");
    expect(vertices).toHaveLength(6);
  });

  it("SERVICE is sharp — four vertices, no arc", () => {
    const { path, ops } = recorder();
    tracePath(path, "SERVICE", 0, 0, SIZE);
    // BRAND_RULES #2: sharp corners. STORE is the one inherited exception.
    expect(ops.some((o) => o.op.startsWith("arc"))).toBe(false);
    expect(ops.filter((o) => o.op === "moveTo" || o.op === "lineTo")).toHaveLength(4);
  });

  it("STORE is the ONE rounded shape", () => {
    for (const shape of SHAPES) {
      const { path, ops } = recorder();
      tracePath(path, shape as ShapeKind, 0, 0, SIZE);
      const rounded = ops.some((o) => o.op === "arcTo");
      expect(rounded, `${shape} rounding`).toBe(shape === "STORE");
    }
  });

  it("translates with its centre", () => {
    const { path, ops } = recorder();
    tracePath(path, "SERVICE", 100, 50, SIZE);
    for (const { op, args } of ops) {
      if (op === "closePath") continue;
      expect(Math.abs(args[0] - 100)).toBeLessThanOrEqual(SIZE / 2 + PAD);
      expect(Math.abs(args[1] - 50)).toBeLessThanOrEqual(SIZE / 2 + PAD);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-244 — the size law
// ---------------------------------------------------------------------------

describe("FR-244 — nodeWorldSize is one law with two regimes and no step", () => {
  /** A node's size ON SCREEN at zoom `k`: world size times the zoom factor. */
  const screenPx = (sizePx: number, k: number) => nodeWorldSize(sizePx, k) * k;

  it("holds a CONSTANT SCREEN SIZE at and above the floor", () => {
    // This is the `--s-1` legibility floor's whole meaning, and FR-244 does not
    // touch it over the working range. Above K_FLOOR the law is byte-for-byte
    // the pre-FR-244 behaviour: `sizePx / k`.
    for (const k of [NODE_SIZE_ZOOM_FLOOR, 0.25, 0.5, 1, 2.5, 12]) {
      expect(screenPx(8, k)).toBeCloseTo(8, 9);
      expect(nodeWorldSize(8, k)).toBeCloseTo(8 / k, 9);
    }
  });

  it("holds a CONSTANT WORLD SIZE below the floor, so the picture scales as one", () => {
    // Below the floor the node stops growing in world units, so the field and
    // the nodes in it shrink together — every gap in the picture is preserved
    // as a photographic reduction. That is the separability property G-BR-11
    // measures in a real browser.
    const frozen = 8 / NODE_SIZE_ZOOM_FLOOR;
    for (const k of [NODE_SIZE_ZOOM_FLOOR / 2, 0.03, 0.01, 0.0001]) {
      expect(nodeWorldSize(8, k)).toBeCloseTo(frozen, 9);
    }
    // And the on-screen consequence, stated as an equality rather than a
    // direction: screen size falls in exact proportion to the zoom.
    expect(screenPx(8, NODE_SIZE_ZOOM_FLOOR / 2)).toBeCloseTo(4, 9);
    expect(screenPx(8, NODE_SIZE_ZOOM_FLOOR / 4)).toBeCloseTo(2, 9);
  });

  it("is CONTINUOUS at the floor — no step as the operator zooms through it", () => {
    // Clamping the DIVISOR rather than the result is what buys this. A law that
    // clamped the output would jump at K_FLOOR, and a node that pops as you
    // scroll past a magic zoom is a worse defect than the one being fixed.
    // Asserted RELATIVELY, not with a fixed absolute epsilon. The world size
    // at the floor is ~72.7, so an absolute tolerance is really a statement
    // about that magnitude rather than about continuity; the relative form
    // says the actual thing — an arbitrarily small step in `k` produces an
    // arbitrarily small step in the size.
    const at = nodeWorldSize(8, NODE_SIZE_ZOOM_FLOOR);
    // Steps a camera could plausibly take, and then some. Nothing smaller than
    // 1e-9 is tested because the analytic bound at that scale is a few parts
    // in 1e8 of a double's own resolution here — the assertion would be
    // measuring IEEE-754, not the size law.
    for (const eps of [1e-3, 1e-6, 1e-9]) {
      const below = nodeWorldSize(8, NODE_SIZE_ZOOM_FLOOR - eps);
      const above = nodeWorldSize(8, NODE_SIZE_ZOOM_FLOOR + eps);
      // Below the floor the clamp binds, so it is EXACTLY the floor value.
      expect(below).toBe(at);
      // Above it the law is `8/k`, whose relative sensitivity at `k` is
      // `1/k` — so a step of `eps` in `k` moves the size by `eps / K_FLOOR`
      // relatively, and no more. Stating the exact bound rather than a loose
      // one is what makes this a continuity assertion instead of a tolerance.
      // The `1 + 1e-4` is FLOATING-POINT SLACK on the bound, not slack on the
      // claim: the analytic value is `eps / (K_FLOOR + eps)`, and evaluating
      // two reciprocals in doubles lands a few ulps either side of it. It is
      // four orders of magnitude tighter than any discontinuity a clamped
      // RESULT would produce — that failure mode is a ~9% step, not a 0.01%
      // one.
      expect(Math.abs(above - at) / at).toBeLessThanOrEqual(
        (eps / NODE_SIZE_ZOOM_FLOOR) * (1 + 1e-4),
      );
    }
    // The mirror of the above: a law that clamped the RESULT instead of the
    // divisor would be discontinuous here. `8 / K_FLOOR` and `8 / k` meet.
    expect(at).toBeCloseTo(8 / NODE_SIZE_ZOOM_FLOOR, 9);
  });

  it("NEVER draws a node larger than its own screen size, at any zoom", () => {
    // The clamp only ever makes the divisor BIGGER, so it can only ever make
    // the node smaller. Asserted because the opposite failure — a node that
    // grows without bound as you zoom out — would be a far louder bug.
    for (const k of [1e-6, 0.001, 0.05, NODE_SIZE_ZOOM_FLOOR, 1, 40]) {
      expect(screenPx(24, k)).toBeLessThanOrEqual(24 + 1e-9);
    }
  });

  it("never returns zero, negative or non-finite, for any zoom a camera can report", () => {
    for (const k of [0, -1, -0.5, 1e-12, Number.MIN_VALUE]) {
      const v = nodeWorldSize(8, k);
      expect(Number.isFinite(v), `k=${k} produced ${v}`).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    // A zero or negative `k` is not reachable through d3-zoom, but a divisor
    // that produced Infinity would paint a shape the size of the world and
    // freeze the tab, so the clamp is asserted rather than assumed.
    expect(nodeWorldSize(8, 0)).toBeCloseTo(8 / NODE_SIZE_ZOOM_FLOOR, 9);
  });

  it("the floor is the MEASURED one, not a round number someone liked", () => {
    // G-BR-11's sweep put the last structurally-intact reading at k = 0.10533
    // and the collapse at k = 0.07851. If this constant is ever changed, the
    // sweep is what has to be re-run — see the derivation in `shapes.ts`.
    expect(NODE_SIZE_ZOOM_FLOOR).toBe(0.11);
    expect(NODE_SIZE_ZOOM_FLOOR).toBeGreaterThan(0.10533);
  });

  it("ALL FOUR geometry consumers derive from the ONE law at the same k", () => {
    /*
     * The paint size, the pointer-capture size, the selection-ring radius and
     * the label obstacle size. This reproduces each call site's arithmetic and
     * asserts they agree — the property that keeps hit-testing on top of the
     * picture. `dashboard-graph-source.test.ts` is the sibling that forbids a
     * FIFTH site from being open-coded; this is the half that says the four
     * that exist actually line up.
     */
    const nodeSizePx = 8;
    for (const k of [1, 0.5, NODE_SIZE_ZOOM_FLOOR, 0.02]) {
      const paint = nodeWorldSize(nodeSizePx, k);
      const capture = nodeWorldSize(captureSizePx(nodeSizePx, false), k);
      const ring = nodeWorldSize(nodeSizePx * (1.2 + 1.4 * 1), k) * 0.5;
      const obstacle = nodeWorldSize(nodeSizePx, k);

      expect(obstacle).toBe(paint);
      // The capture area is the node scaled by the capture/node ratio — the
      // SAME law, a different numerator. If the two ever used different laws
      // this ratio would drift with `k`, which is the drift the scan forbids.
      expect(capture / paint).toBeCloseTo(
        FINE_POINTER_CAPTURE_PX / nodeSizePx,
        9,
      );
      expect(ring / paint).toBeCloseTo(2.6 / 2, 9);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 2.4 — the tap-target reconciliation
// ---------------------------------------------------------------------------

describe("T20 — the capture radius, not the node, meets the tap-target minimum", () => {
  it("a coarse pointer always gets at least 44 CSS px", () => {
    // At the Tier C 8 px floor the node is arithmetically far below 44 px. The
    // spec resolves this by making the CANVAS the interactive element and the
    // capture radius the thing that must meet the minimum.
    expect(captureSizePx(8, true)).toBe(TAP_TARGET_MIN_PX);
    expect(captureSizePx(24, true)).toBe(TAP_TARGET_MIN_PX);
  });

  it("a fine pointer gets a radius sized for pointing, not for fingers", () => {
    // 44 px on a mouse would make selecting the intended node in a dense
    // cluster impossible — trading a real precision problem for an imaginary
    // accessibility one. dataviz.md sets the 44 px floor for TOUCH.
    expect(captureSizePx(8, false)).toBe(FINE_POINTER_CAPTURE_PX);
  });

  it("never shrinks below the node it is capturing", () => {
    expect(captureSizePx(64, false)).toBe(64);
    expect(captureSizePx(64, true)).toBe(64);
  });

  it("the minimum is the coding-guideline value", () => {
    expect(TAP_TARGET_MIN_PX).toBe(44);
  });
});
