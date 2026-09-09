/**
 * FR-239 — label placement, and the rejection pass that is the point of it.
 *
 * dataviz.md's DON'T list, in full because it is the whole spec of this file:
 *
 * > **No label occluding a node.** A label that covers a glyph — its own or a
 * > neighbour's — has defeated its own purpose, and hidden a second node to do
 * > it. Place it clear; where local density leaves no clear placement, the
 * > label **degrades** (ladder rung 1) rather than overlapping. **Contact
 * > counts as overlap: *nearly clear* is not clear.**
 *
 * So this module's real output is not "where does the label go" — it is
 * "**does this label get drawn at all**". A greedy placer that always finds
 * somewhere would satisfy the first sentence and break the last one.
 *
 * CONTACT COUNTS AS OVERLAP. The intersection test below uses `<` / `>` on the
 * exclusive edges, so two boxes sharing an edge REJECT. That is a deliberate
 * one-character decision and it is what `labels.test.ts` pins.
 */

/** An axis-aligned box in SCREEN space (CSS pixels). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LabelCandidate {
  /** Node key — the identity the rest of the graph uses. */
  key: string;
  /** The text, already uppercased and capped by the caller. */
  text: string;
  /** Node centre, screen space. */
  cx: number;
  cy: number;
  /** Node size in CSS pixels — its own glyph box is this wide and tall. */
  nodeSizePx: number;
  /** Measured text width in CSS pixels. */
  textWidth: number;
  /**
   * Rank. Higher wins a contested placement. Degree-descending is the
   * deterministic ordering `whole-graph.ts` uses for truncation, so reusing it
   * keeps "which label survived" reproducible across renders.
   */
  rank: number;
}

export interface PlacedLabel {
  key: string;
  text: string;
  /** Baseline-left anchor, screen space. */
  x: number;
  y: number;
  box: Box;
}

export interface PlacementResult {
  placed: PlacedLabel[];
  /** Keys whose label DEGRADED — no clear placement existed. Not a failure. */
  degraded: string[];
}

/** Label line height in CSS pixels. Mono, so the box is predictable. */
export const LABEL_LINE_PX = 11;

/** Gap between a node and its label, in CSS pixels. */
export const LABEL_GAP_PX = 4;

/**
 * Metrics in whatever space the caller is working in.
 *
 * The canvas renderer places labels in GRAPH coordinates (force-graph hands us
 * a context already transformed by the zoom), which is sound because overlap is
 * invariant under uniform scaling: two boxes that touch at one zoom touch at
 * every zoom. The caller divides its pixel metrics by `globalScale` and the
 * geometry below is unchanged.
 */
export interface PlacementMetrics {
  lineHeight: number;
  gap: number;
}

const DEFAULT_METRICS: PlacementMetrics = {
  lineHeight: LABEL_LINE_PX,
  gap: LABEL_GAP_PX,
};

/**
 * Candidate offsets, in preference order: right, left, below, above.
 *
 * Right first because the label reads left-to-right away from the node, which
 * is the placement that stays legible when two labels are near each other.
 */
type Side = "right" | "left" | "below" | "above";
const SIDES: readonly Side[] = ["right", "left", "below", "above"];

function boxFor(c: LabelCandidate, side: Side, m: PlacementMetrics): Box {
  const half = c.nodeSizePx / 2;
  const w = c.textWidth;
  const h = m.lineHeight;
  switch (side) {
    case "right":
      return { x: c.cx + half + m.gap, y: c.cy - h / 2, width: w, height: h };
    case "left":
      return { x: c.cx - half - m.gap - w, y: c.cy - h / 2, width: w, height: h };
    case "below":
      return { x: c.cx - w / 2, y: c.cy + half + m.gap, width: w, height: h };
    case "above":
      return { x: c.cx - w / 2, y: c.cy - half - m.gap - h, width: w, height: h };
  }
}

/**
 * Do two boxes overlap — **or touch**?
 *
 * `a.x + a.width <= b.x` would treat shared edges as clear. The spec says
 * contact counts as overlap, so the comparison is strict.
 */
export function overlaps(a: Box, b: Box): boolean {
  const clear =
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y;
  return !clear;
}

/** A node's own glyph box — what a label must not cover. */
export function glyphBox(c: { cx: number; cy: number; nodeSizePx: number }): Box {
  return {
    x: c.cx - c.nodeSizePx / 2,
    y: c.cy - c.nodeSizePx / 2,
    width: c.nodeSizePx,
    height: c.nodeSizePx,
  };
}

/**
 * Place as many labels as fit clear of every glyph and every other label.
 *
 * `obstacles` is EVERY node's glyph box, not just the labelled ones — a label
 * covering an unlabelled neighbour has still *"hidden a second node"*.
 *
 * Greedy by rank. Greedy is the right shape here because rung 1 makes failure
 * cheap: a label with no clear placement degrades, so the placer never has to
 * backtrack to find a globally optimal arrangement it could not justify anyway.
 */
export function placeLabels(
  candidates: readonly LabelCandidate[],
  obstacles: readonly Box[],
  metrics: PlacementMetrics = DEFAULT_METRICS,
): PlacementResult {
  const placed: PlacedLabel[] = [];
  const degraded: string[] = [];
  // Labels already placed become obstacles for the ones after them.
  const taken: Box[] = [];

  const ordered = [...candidates].sort(
    (a, b) => b.rank - a.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  for (const c of ordered) {
    let chosen: Box | null = null;
    for (const side of SIDES) {
      const box = boxFor(c, side, metrics);
      const blocked =
        obstacles.some((o) => overlaps(box, o)) ||
        taken.some((o) => overlaps(box, o));
      if (!blocked) {
        chosen = box;
        break;
      }
    }
    if (chosen === null) {
      // RUNG 1. Not an error, not a fallback placement — the label is simply
      // not drawn, which is the spec's instruction.
      degraded.push(c.key);
      continue;
    }
    taken.push(chosen);
    placed.push({
      key: c.key,
      text: c.text,
      x: chosen.x,
      // Canvas `textBaseline: "middle"` anchors at the box's vertical centre.
      y: chosen.y + chosen.height / 2,
      box: chosen,
    });
  }

  return { placed, degraded };
}

/**
 * The diagrams.md §01 label rule, inherited by name: **mono, fixed tracking,
 * uppercase.**
 *
 * Capped because a brief title is up to 120 characters from the builder and a
 * 120-character label is not a label — it is a paragraph lying across the
 * canvas, which is rung 1's problem arriving by another door.
 */
export const LABEL_MAX_CHARS = 28;

export function labelText(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim().toUpperCase();
  return flat.length <= LABEL_MAX_CHARS
    ? flat
    : `${flat.slice(0, LABEL_MAX_CHARS - 1)}…`;
}
