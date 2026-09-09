/**
 * FR-239 (T19) — label occlusion and rung 1.
 *
 * The assertion that matters is the NEGATIVE one: a label with no clear
 * placement must DEGRADE, not shift to somewhere nearly clear. dataviz.md is
 * unusually explicit — *"Contact counts as overlap: nearly clear is not
 * clear."* — so the boundary case gets its own test.
 */

import { describe, expect, it } from "vitest";
import {
  LABEL_MAX_CHARS,
  glyphBox,
  labelText,
  overlaps,
  placeLabels,
  type Box,
  type LabelCandidate,
} from "../labels.js";

function candidate(over: Partial<LabelCandidate> = {}): LabelCandidate {
  return {
    key: "k",
    text: "NODE",
    cx: 0,
    cy: 0,
    nodeSizePx: 10,
    textWidth: 40,
    rank: 1,
    ...over,
  };
}

describe("T19 — contact counts as overlap", () => {
  it("touching boxes REJECT", () => {
    const a: Box = { x: 0, y: 0, width: 10, height: 10 };
    const b: Box = { x: 10, y: 0, width: 10, height: 10 };
    // `a.x + a.width === b.x`. A `<=` comparison would call this clear; the
    // spec says it is not. This is the one-character decision the rule turns on.
    expect(overlaps(a, b)).toBe(true);
  });

  it("a one-pixel gap is clear", () => {
    const a: Box = { x: 0, y: 0, width: 10, height: 10 };
    const b: Box = { x: 11, y: 0, width: 10, height: 10 };
    expect(overlaps(a, b)).toBe(false);
  });

  it("touching on the vertical axis also rejects", () => {
    const a: Box = { x: 0, y: 0, width: 10, height: 10 };
    const b: Box = { x: 0, y: 10, width: 10, height: 10 };
    expect(overlaps(a, b)).toBe(true);
  });

  it("full containment overlaps", () => {
    expect(
      overlaps(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 10, y: 10, width: 5, height: 5 },
      ),
    ).toBe(true);
  });
});

describe("T19 — placement finds clear space when it exists", () => {
  it("places an isolated label to the right", () => {
    const { placed, degraded } = placeLabels([candidate()], []);
    expect(degraded).toEqual([]);
    expect(placed).toHaveLength(1);
    // Right first: the label reads away from the node.
    expect(placed[0].box.x).toBeGreaterThan(0);
  });

  it("falls back to another side when the preferred one is blocked", () => {
    const blocker: Box = { x: 4, y: -20, width: 200, height: 40 };
    const { placed, degraded } = placeLabels([candidate()], [blocker]);
    expect(degraded).toEqual([]);
    // Right is blocked, so it went left — still clear of every glyph.
    expect(placed[0].box.x).toBeLessThan(0);
  });

  it("labels placed earlier become obstacles for later ones", () => {
    const a = candidate({ key: "a", cx: 0, cy: 0, rank: 10 });
    const b = candidate({ key: "b", cx: 0, cy: 2, rank: 1 });
    const { placed } = placeLabels([a, b], []);
    const boxes = placed.map((p) => p.box);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j]), "two labels collided").toBe(false);
      }
    }
  });
});

describe("T19 — where no clear placement exists, the label DEGRADES", () => {
  it("returns it as degraded rather than overlapping something", () => {
    // Boxed in on all four sides.
    const walls: Box[] = [
      { x: 6, y: -60, width: 400, height: 120 },   // right
      { x: -406, y: -60, width: 400, height: 120 }, // left
      { x: -200, y: 6, width: 400, height: 200 },   // below
      { x: -200, y: -206, width: 400, height: 200 },// above
    ];
    const { placed, degraded } = placeLabels([candidate()], walls);
    expect(placed).toEqual([]);
    expect(degraded).toEqual(["k"]);
  });

  it("a degraded label is NOT an error and does not stop the others", () => {
    const trapped = candidate({ key: "trapped", cx: 0, cy: 0, rank: 1 });
    const free = candidate({ key: "free", cx: 5000, cy: 5000, rank: 2 });
    const walls: Box[] = [
      { x: 6, y: -60, width: 400, height: 120 },
      { x: -406, y: -60, width: 400, height: 120 },
      { x: -200, y: 6, width: 400, height: 200 },
      { x: -200, y: -206, width: 400, height: 200 },
    ];
    const { placed, degraded } = placeLabels([trapped, free], walls);
    expect(degraded).toEqual(["trapped"]);
    expect(placed.map((p) => p.key)).toEqual(["free"]);
  });

  it("never covers a NEIGHBOUR's glyph, even an unlabelled one", () => {
    // "A label that covers a glyph — its own or a neighbour's — has defeated
    // its own purpose, and hidden a second node to do it."
    const neighbour = glyphBox({ cx: 40, cy: 0, nodeSizePx: 10 });
    const { placed, degraded } = placeLabels([candidate()], [neighbour]);
    for (const p of placed) expect(overlaps(p.box, neighbour)).toBe(false);
    expect(placed.length + degraded.length).toBe(1);
  });
});

describe("T19 — placement is deterministic", () => {
  it("higher rank wins a contested placement, ties broken by key", () => {
    const a = candidate({ key: "zzz", rank: 5, cx: 0, cy: 0 });
    const b = candidate({ key: "aaa", rank: 5, cx: 0, cy: 1 });
    const first = placeLabels([a, b], []);
    const second = placeLabels([b, a], []);
    // Input order must not change the outcome — "the same query plus the same
    // seed produces the same canvas".
    expect(first.placed.map((p) => p.key)).toEqual(
      second.placed.map((p) => p.key),
    );
    expect(first.placed[0].key).toBe("aaa");
  });

  it("degree-descending ordering places the highest-degree label first", () => {
    const low = candidate({ key: "low", rank: 1, cx: 0, cy: 0 });
    const high = candidate({ key: "high", rank: 99, cx: 0, cy: 1 });
    const { placed } = placeLabels([low, high], []);
    expect(placed[0].key).toBe("high");
  });
});

describe("T19 — the inherited label rule: mono, uppercase, capped", () => {
  it("uppercases and collapses whitespace", () => {
    expect(labelText("  a   brief\ntitle ")).toBe("A BRIEF TITLE");
  });

  it("caps long labels — a 120-char builder label is not a label", () => {
    const long = "x".repeat(200);
    const out = labelText(long);
    expect(out.length).toBe(LABEL_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a short label alone", () => {
    expect(labelText("FR-239")).toBe("FR-239");
  });
});

describe("T19 — placement is scale-invariant", () => {
  it("the same arrangement decides the same way at any zoom", () => {
    // The renderer places labels in GRAPH coordinates by dividing every metric
    // by `globalScale`. That is only sound because overlap is invariant under
    // uniform scaling — asserted here rather than assumed.
    const scale = (c: LabelCandidate, k: number): LabelCandidate => ({
      ...c,
      cx: c.cx * k,
      cy: c.cy * k,
      nodeSizePx: c.nodeSizePx * k,
      textWidth: c.textWidth * k,
    });
    const cands = [
      candidate({ key: "a", cx: 0, cy: 0 }),
      candidate({ key: "b", cx: 30, cy: 0 }),
      candidate({ key: "c", cx: 60, cy: 0 }),
    ];
    const metrics = (k: number) => ({ lineHeight: 11 * k, gap: 4 * k });

    const at1 = placeLabels(cands, [], metrics(1));
    const at4 = placeLabels(
      cands.map((c) => scale(c, 4)),
      [],
      metrics(4),
    );
    expect(at4.placed.map((p) => p.key)).toEqual(at1.placed.map((p) => p.key));
    expect(at4.degraded).toEqual(at1.degraded);
  });
});
