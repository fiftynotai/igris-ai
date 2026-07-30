/**
 * FR-239 — the five node shapes, the entity mapping, and the hit-target
 * reconciliation.
 *
 * F3, stated once so the expectation is right: `force-graph` takes the RISKY
 * 40% off us — force integration, camera, drag, resize, hit-testing. **The
 * paint layer stays ours, because it is the brand.** No library can express
 * five specific silhouettes without approximating the spec, so this file draws
 * them as literal 2D paths.
 *
 * THE VOCABULARY IS CLOSED. dataviz.md rule 03: *"Five node shapes. There is no
 * sixth — if a node doesn't fit, it's two nodes or an attribute."* The finer
 * domain type is carried as TEXT (`attrs`, the inspector, the label), never as
 * geometry.
 */

import type { GraphNode } from "../lib/api";
import { monoFont } from "./palette";

/**
 * The five inherited shapes.
 *
 * Named EXTERNAL rather than diagrams.md's EDGE: on a canvas where *edge*
 * already means a line between nodes, the collision is not survivable.
 * dataviz.md §02 makes the rename normative — same shape, same treatment.
 */
export type ShapeKind = "SERVICE" | "AGENT" | "STORE" | "TOOL" | "EXTERNAL";

/**
 * D9 — the entity -> shape mapping, by dataviz.md §07's procedure: classify by
 * BEHAVIOUR, not by name.
 *
 * | type                        | shape    | why                                   |
 * |-----------------------------|----------|---------------------------------------|
 * | brief, session              | SERVICE  | a unit of work done on request        |
 * | learning, concept, decision | STORE    | held state — knowledge                |
 * | goal                        | AGENT    | decides; has a loop                   |
 * | error                       | TOOL     | see the flag below                    |
 *
 * **`error` -> TOOL is a FLAGGED WEAK FIT, recorded rather than smoothed over.**
 * TOOL means *causes a side-effect outside itself*. An error is the **trace of**
 * a side-effect, not itself side-effecting — it is closer to held state, but
 * mapping it to STORE would put it in the same silhouette as a learning, and
 * the operational distinction between "something we know" and "something that
 * broke" is the one a reader most needs at a glance. TOOL's dashed border reads
 * as "provisional / external consequence", which is the least wrong of five
 * options. Live population is **2 nodes**, so the cost of being wrong is small
 * and the flag is cheap to act on later. If `error` ever grows, revisit —
 * §07 rule 2 says a type that does not fit is two types or an attribute.
 */
const ENTITY_SHAPE: Readonly<Record<string, ShapeKind>> = {
  brief: "SERVICE",
  session: "SERVICE",
  learning: "STORE",
  concept: "STORE",
  decision: "STORE",
  goal: "AGENT",
  error: "TOOL",
};

/**
 * Resolve a node to its shape.
 *
 * `boundary` and `phantom` outrank the entity type, and deliberately so:
 * dataviz.md defines EXTERNAL as *"lives outside the system boundary"*, and
 * that is exactly what both flags mean. A boundary node pulled in by a
 * drill-down IS outside the scope being viewed; a phantom endpoint has no
 * backing row anywhere. Drawing them as their entity type would claim they are
 * part of the set the query returned, which is the one thing the query twin
 * says they are not.
 */
export function shapeFor(node: GraphNode): ShapeKind {
  if (node.phantom === true || node.boundary === true) return "EXTERNAL";
  return ENTITY_SHAPE[node.type] ?? "EXTERNAL";
}

/** Every entity type the builder can emit, for the T20 exhaustiveness check. */
export const MAPPED_ENTITY_TYPES = Object.keys(ENTITY_SHAPE);

/** The five, as data — so a test can assert there is no sixth. */
export const SHAPES: readonly ShapeKind[] = [
  "SERVICE",
  "AGENT",
  "STORE",
  "TOOL",
  "EXTERNAL",
];

/**
 * The role glyphs, drawn only at Tier A (`chrome: "full"`).
 *
 * dataviz.md §04 names three (`⬢`, `≡`, `[ ]`) against five shapes; the two
 * unnamed ones take the nearest mono mark in the same family. They are the
 * FIRST thing rung 2 drops, so they are never load-bearing.
 */
const GLYPH: Readonly<Record<ShapeKind, string>> = {
  SERVICE: "[ ]",
  AGENT: "⬢",
  STORE: "≡",
  TOOL: "⌁",
  EXTERNAL: "//",
};

export type Chrome = "full" | "silhouette-padded" | "silhouette";

export interface NodeVisual {
  shape: ShapeKind;
  /** Screen-space size in CSS pixels. Always sourced from a `--s-*` token. */
  sizePx: number;
  /** A `--dataviz-*` role value. Never a literal. */
  fill: string;
  /** A `--dataviz-*` role value for the border. Never a literal. */
  stroke: string;
  chrome: Chrome;
  /** 0..1. Rung 3's dimension, and the filter/emphasis tweens' output. */
  alpha: number;
}

/**
 * The STORE shape's corner radius, as a fraction of its size.
 *
 * BRAND_RULES bans border-radius; dataviz.md §02 records STORE's rounded base
 * as *"the one inherited exception"*. It is scoped to this constant so the
 * exception cannot spread.
 */
const STORE_RADIUS_RATIO = 0.28;

/** EXTERNAL's slant, as a fraction of its height — the "italic block". */
const EXTERNAL_SLANT_RATIO = 0.3;

/** TOOL's dashed border, in screen pixels. */
const TOOL_DASH: readonly number[] = [3, 3];

/**
 * Trace one shape's path into `ctx`, centred on the origin, `s` across.
 *
 * Paths only — no fill, no stroke, no state changes. That keeps every shape
 * usable for painting, for the offscreen pointer-area buffer, and for a hit
 * test, from one definition.
 */
export function tracePath(
  ctx: CanvasPath,
  shape: ShapeKind,
  x: number,
  y: number,
  s: number,
): void {
  const h = s / 2;
  switch (shape) {
    case "SERVICE": {
      // Sharp rectangle. BRAND_RULES #2.
      ctx.moveTo(x - h, y - h);
      ctx.lineTo(x + h, y - h);
      ctx.lineTo(x + h, y + h);
      ctx.lineTo(x - h, y + h);
      ctx.closePath();
      return;
    }
    case "AGENT": {
      // Flat-top hexagon — the "decides; has a loop" silhouette.
      const r = h;
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      return;
    }
    case "STORE": {
      const r = Math.min(h, s * STORE_RADIUS_RATIO);
      ctx.moveTo(x - h + r, y - h);
      ctx.lineTo(x + h - r, y - h);
      ctx.arcTo(x + h, y - h, x + h, y - h + r, r);
      ctx.lineTo(x + h, y + h - r);
      ctx.arcTo(x + h, y + h, x + h - r, y + h, r);
      ctx.lineTo(x - h + r, y + h);
      ctx.arcTo(x - h, y + h, x - h, y + h - r, r);
      ctx.lineTo(x - h, y - h + r);
      ctx.arcTo(x - h, y - h, x - h + r, y - h, r);
      ctx.closePath();
      return;
    }
    case "TOOL": {
      // Same rectangle as SERVICE; the DASH is what distinguishes it, applied
      // by the caller via `setLineDash`. Keeping the path identical means the
      // pointer-area buffer gets the same capture shape for both.
      ctx.moveTo(x - h, y - h);
      ctx.lineTo(x + h, y - h);
      ctx.lineTo(x + h, y + h);
      ctx.lineTo(x - h, y + h);
      ctx.closePath();
      return;
    }
    case "EXTERNAL": {
      // Slanted block — "italic", i.e. outside the system boundary.
      const k = s * EXTERNAL_SLANT_RATIO;
      ctx.moveTo(x - h + k, y - h);
      ctx.lineTo(x + h + k, y - h);
      ctx.lineTo(x + h - k, y + h);
      ctx.lineTo(x - h - k, y + h);
      ctx.closePath();
      return;
    }
  }
}

/** Does this shape draw a dashed border? (TOOL, and only TOOL.) */
export function isDashed(shape: ShapeKind): boolean {
  return shape === "TOOL";
}

/**
 * Paint one node.
 *
 * `globalScale` is force-graph's zoom factor: the context is already in GRAPH
 * coordinates, so a constant screen size means dividing by it. That is what
 * keeps a silhouette at the `--s-1` floor 8 CSS px across at every zoom level,
 * which is what the floor means.
 */
export function drawNode(
  ctx: CanvasRenderingContext2D,
  visual: NodeVisual,
  x: number,
  y: number,
  globalScale: number,
): void {
  const s = visual.sizePx / globalScale;
  ctx.save();
  ctx.globalAlpha = visual.alpha;

  ctx.beginPath();
  tracePath(ctx, visual.shape, x, y, s);

  if (visual.chrome === "silhouette") {
    // Rung 2 fully engaged: silhouette only. Role is carried by shape plus
    // colour role — no glyph, no padding, no border.
    ctx.fillStyle = visual.fill;
    ctx.fill();
  } else {
    ctx.fillStyle = visual.fill;
    ctx.fill();
    // The border tells the story — motion.md interaction 03, no drop-shadows.
    ctx.lineWidth = Math.max(0.5, 1 / globalScale);
    ctx.strokeStyle = visual.stroke;
    if (isDashed(visual.shape)) {
      ctx.setLineDash(TOOL_DASH.map((d) => d / globalScale));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (visual.chrome === "full") {
    const glyph = GLYPH[visual.shape];
    const fontPx = (visual.sizePx * 0.42) / globalScale;
    // `ctx.font` is parsed by the CSS font shorthand grammar, which does NOT
    // substitute `var()`. `monoFont` resolves the `--mono` token first.
    ctx.font = monoFont(fontPx);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = visual.stroke;
    ctx.fillText(glyph, x, y);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Tap targets — the Rule 2.4 reconciliation (dataviz.md §04)
// ---------------------------------------------------------------------------

/**
 * The coding-guideline minimum for an interactive element, in CSS pixels.
 *
 * At Tier C the CANVAS is the interactive element, which satisfies the rule
 * trivially. Selection *inside* it is mediated by a pointer-capture radius,
 * and the spec is explicit that on touch that radius — not the node — is what
 * must meet the minimum.
 */
export const TAP_TARGET_MIN_PX = 44;

/**
 * The capture radius on a FINE pointer.
 *
 * A mouse resolves to a pixel, so a 44 px capture radius here would make it
 * impossible to select the intended node in a dense cluster — it would trade a
 * real precision problem for an imaginary accessibility one. dataviz.md sets
 * the 44 px floor for TOUCH specifically ("at least the tap-target minimum on
 * touch"), so a fine pointer gets a radius sized for pointing, not for fingers.
 */
export const FINE_POINTER_CAPTURE_PX = 12;

/**
 * The capture radius the pointer-area buffer should paint, in CSS pixels.
 *
 * This is a DIAMETER-equivalent: it is passed to `tracePath` as the shape's
 * size, so a coarse pointer gets a 44x44 capture area — exactly the rule's
 * minimum, and never smaller than the node itself.
 */
export function captureSizePx(nodeSizePx: number, coarsePointer: boolean): number {
  const floor = coarsePointer ? TAP_TARGET_MIN_PX : FINE_POINTER_CAPTURE_PX;
  return Math.max(nodeSizePx, floor);
}

/**
 * Paint one node into force-graph's offscreen colour-tracker buffer.
 *
 * This is the hit-testing mechanism, and it is the reason the library's
 * approach is count-independent: every node is painted in a unique colour on a
 * shadow canvas, and a pointer position resolves to a node by reading ONE
 * pixel. O(1) per query at 2,422 nodes or at 20,000.
 *
 * `color` is opaque and library-assigned — it is an IDENTITY, not a brand
 * colour, and it is never composited onto the visible canvas. AC #3 is about
 * what a reader sees; this buffer is never seen.
 */
export function paintPointerArea(
  ctx: CanvasRenderingContext2D,
  shape: ShapeKind,
  color: string,
  x: number,
  y: number,
  nodeSizePx: number,
  globalScale: number,
  coarsePointer: boolean,
): void {
  const s = captureSizePx(nodeSizePx, coarsePointer) / globalScale;
  ctx.fillStyle = color;
  ctx.beginPath();
  tracePath(ctx, shape, x, y, s);
  ctx.fill();
}
