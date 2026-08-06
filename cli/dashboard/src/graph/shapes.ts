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

// ---------------------------------------------------------------------------
// FR-244 — THE SIZE LAW. One function, and every node geometry goes through it.
// ---------------------------------------------------------------------------

/**
 * The zoom below which node size stops being constant on SCREEN and becomes
 * constant in the WORLD.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MEASURED, NOT PICKED. G-BR-11, `dense` world, 710 nodes / 352 edges at
 * Tier C, canvas 1058x502, 2026-08-02:
 *
 *   k        k/k_fit   connected components   share of the FIT reading
 *   0.15877  1.00      358                    100%     <- zoomToFit()
 *   0.10533  0.66      349                     97.5%
 *   0.07851  0.49       57                     15.9%   <- collapse
 *   0.05237  0.33        1                      0.3%
 *   0.03969  0.25        1                      0.3%
 *   0.01000  0.06        1                      0.3%   <- library scale extent
 *
 * The transition is a PERCOLATION transition, not a gentle fade: the field
 * goes from 97.5% of its structure to 0.3% across a factor of two in `k`. That
 * is the shape the arithmetic predicts. With a constant screen size `p` and a
 * world nearest-neighbour distance `d`, the on-screen gap is `d·k − p`, so
 * every gap in the field crosses zero within a narrow band of `k` and the
 * whole picture fuses at once.
 *
 * `K_FLOOR` is therefore the LAST MEASURED ZOOM AT WHICH THE PICTURE STILL
 * HELD ITS STRUCTURE, rounded up for margin: 0.10533 measured, 0.11 taken.
 * Rounded UP rather than down on purpose — the frozen picture is then at least
 * as separable as the 97.5% reading, and separability is the property under
 * repair.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ABSOLUTE `k` COLUMN IS NOT PORTABLE. THE RATIO IS. READ THIS BEFORE
 * CONCLUDING THE CONSTANT IS WRONG.
 * ─────────────────────────────────────────────────────────────────────────
 * `k_fit` is whatever `zoomToFit()` needs for THIS payload in THIS canvas box,
 * so the `k` column above is a function of both. Re-run the sweep on a
 * different box and every absolute number moves: FR-244's own layout reflow
 * changed the canvas from 1058x502 to 1058x423 and `k_fit` fell 0.15877 ->
 * 0.13275 within the same brief. A reader who re-measures today, gets a last
 * intact reading near 0.088, and compares it to 0.10533 will think the constant
 * is 25% wrong when nothing has changed.
 *
 * **The portable figure is the RATIO: `0.10533 / 0.15877 = 0.663`** — the
 * picture holds its structure down to about two-thirds of fit and collapses by
 * half of it. To re-derive `K_FLOOR` on any box: measure `k_fit`, find the last
 * `k` holding ~97% of the FIT component count, and confirm it lands near
 * `0.66 · k_fit`.
 *
 * SECOND-ORDER CONSEQUENCE, recorded because it is invisible otherwise: this
 * constant is ABSOLUTE while `k_fit` is not, so as the canvas shrinks the clamp
 * engages EARLIER relative to fit. Derived at `0.10533 / 0.15877 = 0.66·k_fit`,
 * it now binds at `0.11 / 0.13275 = 0.83·k_fit` on the post-reflow box. That is
 * SAFE — the clamped regime is the photograph regime, and engaging it sooner
 * only means giving up the 8 px floor slightly earlier — but it is not what the
 * derivation intended, and a much smaller canvas would push it past `k_fit`
 * entirely, at which point nodes are below 8 px even at fit. That would still be
 * an improvement (the sweep says an 8 px node at that density is a fused mass),
 * but if it is ever measured to look wrong, THIS is the mechanism.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS CONSTANT HAS A CROSS-PACKAGE CONSUMER — TD-337. MOVING IT MOVES A GATE.
 * ─────────────────────────────────────────────────────────────────────────
 * `cli/scripts/browser-gate.mjs` MIRRORS this value as `K_FLOOR` and anchors
 * four checks to it: `11a` (separability at `K_FLOOR/2` against `K_FLOOR`),
 * `11b` (the merge control at the `K_FLOOR` anchor), `11e` (box-invariance) and
 * `11-range` (the working range is non-empty). It mirrors rather than reading
 * the value from the page, and since TD-347 the reason is PLACEMENT, not bytes.
 * This module is reached only from `pages/Graph.tsx` (via `graph/useGraph.ts`
 * and `components/graph/NodeInspector.tsx`), so it ships in the DEFERRED
 * `Graph-<hash>` chunk and is charged against `TOTAL_JS_CEILING` — not against
 * the initial set. A `window` export here would cost deferred bytes, which is a
 * far weaker objection than the pre-split one. What still carries the decision
 * is that a gate reading a value out of the page cannot detect the value
 * DRIFTING; the mirror plus its pin can. Pinned by
 * `dashboard-graph-source.test.ts`, mapped in `MAINTAINING.md`.
 *
 * So: **moving `NODE_SIZE_ZOOM_FLOOR` re-bases those four checks.** Re-run the
 * gate's invariance probe and re-derive `FROZEN_PRESERVATION_FLOOR` in the same
 * change. And note the constant is a LEGIBILITY decision wearing a number —
 * the derivation above is a design argument, so the sweep also belongs wherever
 * the design tokens are eventually written down (TD-335).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS BEING TRADED, STATED PLAINLY. Above `K_FLOOR` nothing changes: the
 * `--s-1` legibility floor is honoured over the whole working range, exactly
 * as before. Below it the node is frozen at `sizePx / K_FLOOR` WORLD units, so
 * the entire picture — field and nodes together — scales down as one
 * photograph and every gap in it is preserved.
 *
 * The 8 CSS px floor is given up below `K_FLOOR` because the table above says
 * it buys nothing there: at `k = 0.0785` the 8 px nodes are a single fused
 * mass. This trades an UNREADABLE 8 px node for a READABLE 5.7 px one. The
 * floor's purpose is legibility, and at that zoom the floor was defeating it.
 *
 * A node's screen size is `sizePx · min(1, k / K_FLOOR)` — never LARGER than
 * `sizePx`, at any zoom. There is no path here that grows a node.
 *
 * **TWO FLOORS ARE TRADED HERE, NOT ONE.** The second is the Rule 2.4 TAP
 * TARGET. `paintPointerArea` routes `captureSizePx(...)` through this same law,
 * so below `K_FLOOR` the coarse-pointer capture area is `44 · k / K_FLOOR` CSS
 * px — 36 px at `k = 0.09`, 22 px at `k = 0.055`. Shrinking it is CORRECT and
 * the reason is at `paintPointerArea`: a capture area that stayed 44 px while
 * the nodes shrank around it would overlap its neighbours and select the wrong
 * node, which is a worse accessibility outcome than a smaller target. But it IS
 * a trade, it IS made below `K_FLOOR`, and it should not have to be inferred
 * from a call site. The 44 px minimum still holds over the whole working range
 * `k >= K_FLOOR`, which is where a touch user zoomed to a legible view actually
 * is.
 *
 * `T20`'s tap-target assertions keep passing through this change, and that is
 * not an oversight to fix: they exercise the PURE `captureSizePx`, one layer
 * above the transform that now scales it, so they pin the 44 px rule itself
 * while `nodeWorldSize`'s own tests pin what the zoom does to it.
 *
 * WHAT THIS DOES NOT FIX, so the next reader does not have to rediscover it:
 * separability AT FIT — with a correction TD-337 measured and this comment
 * used to get wrong.
 *
 * It used to read: "the FIT reading is 358 components for 710 nodes, and the
 * shortfall is exactly the 352 seeded edges… because at FIT the picture
 * depends only on the layout's SHAPE: any uniform force change that spreads
 * the layout is undone by `zoomToFit()` zooming out to match."
 *
 * BOTH HALVES ARE NOW FALSE. FR-250 doubled the canvas and the FIT reading
 * moved **358 -> 710 of 710** on a byte-identical bundle and an identical
 * payload. So the FIT picture is NOT box-invariant — it is a function of the
 * canvas box, which is exactly what the "depends only on SHAPE" argument
 * denied. The 352-pair fusion it described does not manifest at FIT on the
 * shipped box at all.
 *
 * That is precisely why TD-337 re-anchored `11a`: a reading whose denominator
 * moves when the layout does cannot calibrate anything. The gate now measures
 * at `K_FLOOR` and `K_FLOOR/2`, both absolute. See `docs/dashboard.md`'s
 * rung-6 section, and note that rung 6 was aimed at a problem this
 * measurement shows no longer manifests where it was aimed.
 */
export const NODE_SIZE_ZOOM_FLOOR = 0.11;

/**
 * The ONE size law. Every node geometry on this canvas derives from it.
 *
 * `globalScale` is force-graph's zoom factor `k`: the context handed to a
 * paint accessor is already in GRAPH coordinates, so a constant SCREEN size
 * means dividing by `k`.
 *
 * WHY THE CLAMP IS ON THE DIVISOR, stated precisely — the loose version of this
 * comment claimed clamping the divisor is what buys continuity, and that is not
 * quite the mechanism: `min(p/k, p/K_FLOOR)` is algebraically identical to
 * `p / max(k, K_FLOOR)`, so a result-clamp AT THE SAME VALUE would be continuous
 * too. The real property is that the clamp meets at `p / K_FLOOR` **for every
 * numerator `p`**, so the law is continuous at `K_FLOOR` for all six things
 * that go through it — the 8 px node, the 1 px border, the 1.5 px ring stroke,
 * the 2.6x ring radius, the 44 px capture area and the 0.42x glyph. A result
 * clamped to one FIXED world size would hold for whichever numerator it was
 * tuned against and step for the other five, and the node would visibly come
 * apart at that zoom: border thicker than the silhouette, glyph outside it,
 * capture area detached from the shape. Expressing the clamp on the divisor is
 * what makes "one law, six numerators" true rather than approximately true.
 *
 * **There must be exactly one of these.** `dashboard-graph-source.test.ts`
 * scans for a node-size expression divided by the zoom factor anywhere else in
 * the graph source, because the paint, the pointer-capture buffer, the
 * selection ring and the label obstacle boxes must all agree: a call site that
 * kept its own division would make hit-testing disagree with the rendered
 * picture at low zoom, which is a silent selection bug that looks exactly like
 * FR-239's dead-canvas defect.
 */
export function nodeWorldSize(sizePx: number, globalScale: number): number {
  return sizePx / Math.max(globalScale, NODE_SIZE_ZOOM_FLOOR);
}

/**
 * Paint one node.
 *
 * Every metric here — the silhouette, its border, its dash and its glyph —
 * goes through `nodeWorldSize`, so the whole node scales as one object at
 * every zoom. A border that stayed 1 screen px while the silhouette shrank
 * below the floor would end up drawing the node as a ring.
 */
export function drawNode(
  ctx: CanvasRenderingContext2D,
  visual: NodeVisual,
  x: number,
  y: number,
  globalScale: number,
): void {
  const s = nodeWorldSize(visual.sizePx, globalScale);
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
    ctx.lineWidth = Math.max(0.5, nodeWorldSize(1, globalScale));
    ctx.strokeStyle = visual.stroke;
    if (isDashed(visual.shape)) {
      ctx.setLineDash(TOOL_DASH.map((d) => nodeWorldSize(d, globalScale)));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (visual.chrome === "full") {
    const glyph = GLYPH[visual.shape];
    // Through the size law too: the glyph is drawn INSIDE the silhouette, so a
    // glyph that kept a constant screen size would burst out of a node that
    // had stopped growing.
    const fontPx = nodeWorldSize(visual.sizePx * 0.42, globalScale);
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
  // THE SAME LAW AS THE PAINT. If these two ever diverge, the colour a pointer
  // resolves to stops matching the silhouette under it, and at low zoom a
  // click selects a node the operator is not pointing at.
  const s = nodeWorldSize(captureSizePx(nodeSizePx, coarsePointer), globalScale);
  ctx.fillStyle = color;
  ctx.beginPath();
  tracePath(ctx, shape, x, y, s);
  ctx.fill();
}
