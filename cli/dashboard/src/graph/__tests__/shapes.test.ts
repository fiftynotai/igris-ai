/**
 * FR-239 (T20) — D9's entity mapping, the closed shape vocabulary, and the
 * Rule 2.4 capture radius.
 */

import { describe, expect, it } from "vitest";
import {
  FINE_POINTER_CAPTURE_PX,
  MAPPED_ENTITY_TYPES,
  SHAPES,
  TAP_TARGET_MIN_PX,
  captureSizePx,
  isDashed,
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
