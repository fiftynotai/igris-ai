/**
 * FR-239 — the ONLY place the canvas learns what a colour is.
 *
 * AC #3: *"Zero colours outside the fifty.dev role tokens. No stock library
 * palette survives anywhere."* This module is how that is true by construction
 * rather than by review: every accessor in `edges.ts` and `shapes.ts` asks
 * THIS for a colour, and this only ever reads the five `--dataviz-*` custom
 * properties off computed style. There is no literal here to get wrong.
 *
 * WHY THIS IS WHY force-graph WON (D1). `force-graph` resolves colours by
 * calling our accessors AT PAINT TIME. So a `data-palette` swap is correct on
 * the very next repaint with zero re-binding code — we invalidate a memo and
 * ask for one frame. The runner-up (cytoscape) snapshots resolved colour
 * VALUES into its stylesheet and needs the sheet re-injected on every palette
 * change; that is ~20 lines and, more to the point, a place where two systems
 * can silently drift.
 *
 * WHY IT IS MEMOISED. The accessors run per node and per edge, per frame — at
 * 2,422 nodes that is thousands of `getComputedStyle` calls a frame, each of
 * which can force style recalculation. The memo is invalidated on `data-palette`
 * change and on nothing else, because nothing else changes these five values.
 *
 * THE FIVE ROLES, and no sixth. dataviz.md §02: *"A data-viz surface may define
 * exactly these custom properties, and no others."*
 */

/** The four inherited colour roles plus the one derived alias. */
export interface DatavizPalette {
  /** `--dataviz-bone` -> `var(--fg)`. Node fill, data edges at Tier A. */
  bone: string;
  /** `--dataviz-accent` -> `var(--accent)`. Hot path, selection, optional edges. */
  accent: string;
  /** `--dataviz-muted` -> `var(--muted)`. Control edges, filtered-out nodes. */
  muted: string;
  /** `--dataviz-grid` -> `var(--line)`. The background texture role. */
  grid: string;
  /** `--dataviz-edge-dim` — the Tier C resting-edge alias. */
  edgeDim: string;
}

/** The custom-property name for each role. The complete §02 list. */
export const ROLE_PROPERTIES: Readonly<Record<keyof DatavizPalette, string>> = {
  bone: "--dataviz-bone",
  accent: "--dataviz-accent",
  muted: "--dataviz-muted",
  grid: "--dataviz-grid",
  edgeDim: "--dataviz-edge-dim",
};

/**
 * What a role resolves to when the sheet has not loaded yet.
 *
 * `transparent` and NOT a colour. A hard-coded hex here would be exactly the
 * "stock palette surviving somewhere" that AC #3 forbids, and it would survive
 * silently — an unstyled first frame is visible and fixable, a wrong-but-
 * plausible colour is not.
 */
const UNRESOLVED = "transparent";

/** Anything that can answer "what is this custom property's value". */
export interface StyleSource {
  getPropertyValue: (property: string) => string;
}

let memo: DatavizPalette | null = null;
let memoKey: string | null = null;

/** Read the five roles from a style source. Pure — no memo, no DOM lookup. */
export function readPalette(style: StyleSource): DatavizPalette {
  const get = (prop: string): string => {
    const v = style.getPropertyValue(prop).trim();
    return v === "" ? UNRESOLVED : v;
  };
  return {
    bone: get(ROLE_PROPERTIES.bone),
    accent: get(ROLE_PROPERTIES.accent),
    muted: get(ROLE_PROPERTIES.muted),
    grid: get(ROLE_PROPERTIES.grid),
    edgeDim: get(ROLE_PROPERTIES.edgeDim),
  };
}

/**
 * The memoised live palette, keyed on the active `data-palette` value.
 *
 * Read off `document.body` rather than the canvas: the palette is stamped on
 * `<body data-palette>` by `usePalette`, and reading from the same element that
 * carries the stamp makes the memo key and the values provably consistent.
 */
export function currentPalette(): DatavizPalette {
  const key = document.body.getAttribute("data-palette") ?? "blood";
  if (memo !== null && memoKey === key) return memo;
  memo = readPalette(getComputedStyle(document.body));
  memoKey = key;
  return memo;
}

/**
 * Drop the memo.
 *
 * Called on a `data-palette` change. Also exported for tests, which must never
 * inherit a memo from a previous case.
 */
export function invalidatePalette(): void {
  memo = null;
  memoKey = null;
}

/**
 * Watch `<body data-palette>` and run `onChange` after invalidating.
 *
 * A MutationObserver rather than a React effect on the palette state, because
 * the pre-hydration inline script in `index.html` can stamp the attribute
 * before React exists — and because this must also fire if anything else ever
 * writes the attribute. Returns its own disposer.
 */
export function observePalette(onChange: () => void): () => void {
  const observer = new MutationObserver(() => {
    invalidatePalette();
    onChange();
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-palette"],
  });
  return () => observer.disconnect();
}

/**
 * The mono family, read from the `--mono` token.
 *
 * WHY THIS EXISTS: `CanvasRenderingContext2D.font` is parsed by the CSS FONT
 * shorthand grammar, which does **not** substitute `var()`. Assigning
 * `"11px var(--mono)"` is silently invalid — the browser rejects the whole
 * assignment and the context keeps its previous font, which is the 10px
 * sans-serif default. So a canvas label cannot reference the token directly the
 * way a CSS rule can; it has to resolve it first.
 *
 * dataviz.md inherits the 3-tier type system BY NAME and forbids a new font
 * ("No new fonts. The 3-tier system covers every label on the canvas"), so the
 * value comes from the token rather than from a literal here. The fallback is
 * the generic mono stack, never a specific family we chose.
 */
const MONO_FALLBACK = "ui-monospace, monospace";

let monoMemo: string | null = null;

export function monoFamily(): string {
  if (monoMemo !== null) return monoMemo;
  try {
    const raw = getComputedStyle(document.body).getPropertyValue("--mono").trim();
    monoMemo = raw === "" ? MONO_FALLBACK : raw;
  } catch {
    monoMemo = MONO_FALLBACK;
  }
  return monoMemo;
}

/** `11` -> `"11px 'JetBrains Mono', ui-monospace, monospace"`. */
export function monoFont(sizePx: number): string {
  return `${sizePx}px ${monoFamily()}`;
}

/**
 * Blend two ROLE colours, without inventing a third.
 *
 * `t = 1` is all `from`, `t = 0` is all `to`. Like `withAlpha`, this defers to
 * the CSS colour engine rather than parsing four syntaxes, so the result is
 * always a blend of two values the palette authorised — never a hue that came
 * from anywhere else. Used to ease an accent emphasis back to bone on a
 * deselect, which is a change of ROLE over time, not a new colour.
 */
export function mix(from: string, to: string, t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  // ENDPOINTS RETURN THE ROLE TOKEN ITSELF, not a 0%/100% blend.
  //
  // `color-mix(in srgb, X 0%, Y)` is Y in intent, but it travels through the
  // colour engine's interpolation and can round one channel differently from
  // plain `Y`. That is enough to leave a single anti-aliased pixel behind: the
  // last frame of a deselect tween would paint the 0% blend while the resting
  // frame paints the raw token, and the two hashes differ by one pixel out of
  // ~158,000. Returning the endpoint exactly makes the final tween frame
  // byte-identical to the resting frame BY CONSTRUCTION.
  if (clamped === 0) return to;
  if (clamped === 1) return from;
  return `color-mix(in srgb, ${from} ${clamped * 100}%, ${to})`;
}

/**
 * Apply an alpha to a role colour without inventing one.
 *
 * The role tokens arrive as `rgb(...)`, `rgba(...)`, `#rrggbb` or a
 * `color-mix(...)` expression depending on palette and browser. Rather than
 * parse four syntaxes — and risk producing a colour the palette never
 * authorised — this composes a `color-mix` against `transparent`, which the
 * canvas resolves through the same CSS colour engine that produced the token.
 *
 * The HUE is always the role's. Only opacity moves, which is what the
 * degradation ladder's rung 3 ("edge opacity") is allowed to change.
 */
export function withAlpha(role: string, alpha: number): string {
  const pct = Math.max(0, Math.min(1, alpha)) * 100;
  return `color-mix(in srgb, ${role} ${pct}%, transparent)`;
}
