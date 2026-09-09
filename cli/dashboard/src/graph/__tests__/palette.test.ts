/**
 * FR-239 (T14) — AC #3: all four palettes resolve, and nothing else can.
 *
 * `readPalette` is pure over an injected `StyleSource`, so the four palettes
 * are drivable here without a browser. The LIVE `getComputedStyle` path — the
 * one that makes a `data-palette` swap correct on the next repaint — is checked
 * in the browser during the operator checkpoint; what is asserted here is the
 * part that can silently rot: that the reader names exactly the five sanctioned
 * properties, and that `tokens.css` actually declares all four palettes plus
 * the five aliases.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ROLE_PROPERTIES,
  mix,
  invalidatePalette,
  readPalette,
  withAlpha,
  type StyleSource,
} from "../palette.js";

const TOKENS_CSS = readFileSync(
  new URL("../../styles/tokens.css", import.meta.url),
  "utf-8",
);

/**
 * The four palettes, as a browser COMPUTES them from `tokens.css`.
 *
 * `--dataviz-bone: var(--fg)` computes to the palette's `--fg` literal, and
 * `--dataviz-edge-dim: color-mix(in srgb, var(--muted) 38%, transparent)`
 * computes to the muted alpha times 0.38 (0.55 x 0.38 = 0.209). These stubs
 * stand in for `getComputedStyle`; the assertions below are pass-through, and
 * the live resolution is checked in the browser at the operator checkpoint.
 */
const PALETTE_VALUES: Record<string, Record<string, string>> = {
  blood: {
    "--dataviz-bone": "#f6efe6",
    "--dataviz-accent": "#ff5a1f",
    "--dataviz-muted": "rgba(246, 239, 230, 0.55)",
    "--dataviz-grid": "rgba(246, 239, 230, 0.14)",
    "--dataviz-edge-dim": "rgba(246, 239, 230, 0.209)",
  },
  cyber: {
    "--dataviz-bone": "#e9f2ff",
    "--dataviz-accent": "#3b82f6",
    "--dataviz-muted": "rgba(233, 242, 255, 0.55)",
    "--dataviz-grid": "rgba(233, 242, 255, 0.12)",
    "--dataviz-edge-dim": "rgba(233, 242, 255, 0.209)",
  },
  acid: {
    "--dataviz-bone": "#f1ffd6",
    "--dataviz-accent": "#c5f200",
    "--dataviz-muted": "rgba(241, 255, 214, 0.55)",
    "--dataviz-grid": "rgba(241, 255, 214, 0.14)",
    "--dataviz-edge-dim": "rgba(241, 255, 214, 0.209)",
  },
  mono: {
    "--dataviz-bone": "#ededed",
    "--dataviz-accent": "#ededed",
    "--dataviz-muted": "rgba(237, 237, 237, 0.5)",
    "--dataviz-grid": "rgba(237, 237, 237, 0.12)",
    "--dataviz-edge-dim": "rgba(237, 237, 237, 0.19)",
  },
};

/** A `getComputedStyle`-shaped stub — the browser's answer, without a browser. */
function source(values: Record<string, string>): StyleSource {
  return { getPropertyValue: (p) => values[p] ?? "" };
}

describe("T14 — all four palettes re-read correctly", () => {
  for (const [name, values] of Object.entries(PALETTE_VALUES)) {
    it(`${name} resolves all five roles`, () => {
      const p = readPalette(source(values));
      expect(p.bone).toBe(values["--dataviz-bone"]);
      expect(p.accent).toBe(values["--dataviz-accent"]);
      expect(p.muted).toBe(values["--dataviz-muted"]);
      expect(p.grid).toBe(values["--dataviz-grid"]);
      expect(p.edgeDim).toBe(values["--dataviz-edge-dim"]);
    });
  }

  it("the four palettes really are DIFFERENT — the test is not vacuous", () => {
    const accents = Object.values(PALETTE_VALUES).map(
      (v) => readPalette(source(v)).accent,
    );
    // blood / cyber / acid differ; mono deliberately reuses its own bone value
    // as its accent, which is the palette's whole point.
    expect(new Set(accents).size).toBeGreaterThanOrEqual(3);
  });

  it("re-reading after a swap yields the new palette, with no re-binding", () => {
    // This is the D1 argument in one assertion: force-graph asks our accessors
    // for a colour at PAINT time, so invalidating the memo is the entire
    // mechanism. Cytoscape would need its stylesheet re-injected here.
    invalidatePalette();
    const before = readPalette(source(PALETTE_VALUES.blood));
    const after = readPalette(source(PALETTE_VALUES.cyber));
    expect(after.accent).not.toBe(before.accent);
  });
});

describe("T14 — the reader names exactly the five sanctioned properties", () => {
  it("no sixth role exists", () => {
    // dataviz.md §02: "A data-viz surface may define exactly these custom
    // properties, and no others."
    expect(Object.keys(ROLE_PROPERTIES).sort()).toEqual([
      "accent",
      "bone",
      "edgeDim",
      "grid",
      "muted",
    ]);
    expect(Object.values(ROLE_PROPERTIES).sort()).toEqual([
      "--dataviz-accent",
      "--dataviz-bone",
      "--dataviz-edge-dim",
      "--dataviz-grid",
      "--dataviz-muted",
    ]);
  });

  it("an unresolved property yields TRANSPARENT, never a fallback colour", () => {
    // A hard-coded hex fallback would BE the "stock palette surviving
    // somewhere" that AC #3 forbids — and it would survive silently. An
    // unstyled first frame is visible and fixable; a wrong-but-plausible colour
    // is not.
    const p = readPalette(source({}));
    expect(Object.values(p)).toEqual([
      "transparent",
      "transparent",
      "transparent",
      "transparent",
      "transparent",
    ]);
  });

  it("trims whitespace, which getComputedStyle emits freely", () => {
    const p = readPalette(source({ "--dataviz-bone": "  #f6efe6  " }));
    expect(p.bone).toBe("#f6efe6");
  });
});

describe("T14 — tokens.css declares what the reader expects", () => {
  it("defines all five role aliases against palette variables, not literals", () => {
    for (const prop of Object.values(ROLE_PROPERTIES)) {
      const m = new RegExp(`${prop}:\\s*([^;]+);`).exec(TOKENS_CSS);
      expect(m, `tokens.css does not declare ${prop}`).not.toBeNull();
      // Each alias DEREFERENCES the active palette (§02), which is what makes
      // `data-palette` swaps work for free.
      expect((m as RegExpExecArray)[1], prop).toContain("var(--");
    }
  });

  it("declares the aliases on `body`, NOT on `:root` — the cascade bug", () => {
    // THE REGRESSION GUARD FOR A BUG THAT ACTUALLY SHIPPED IN THIS BRIEF.
    //
    // A custom property's `var()` references are substituted using the computed
    // values of the element it is DECLARED ON. The palette overrides live on
    // `body[data-palette=...]`. So `:root { --dataviz-bone: var(--fg) }`
    // resolves against HTML's `--fg` — the default palette — and freezes: every
    // palette then renders identically, and nothing in the unit suite notices,
    // because these tests drive `readPalette` over an INJECTED style source and
    // therefore never exercise the cascade at all.
    //
    // The FR-239 end-to-end browser run caught it (all four palettes reported
    // `bone: #f6efe6`). This assertion is the cheap mechanical stand-in.
    const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(TOKENS_CSS);
    expect(rootBlock, ":root block not found").not.toBeNull();
    expect(
      (rootBlock as RegExpExecArray)[1],
      "--dataviz-* aliases must NOT be declared in :root — they would freeze " +
        "to the default palette. Declare them on `body`.",
    ).not.toContain("--dataviz-");

    const bodyBlock = /\nbody\s*\{([\s\S]*?)\n\}/.exec(TOKENS_CSS);
    expect(bodyBlock, "no plain `body {}` token block").not.toBeNull();
    for (const prop of Object.values(ROLE_PROPERTIES)) {
      expect((bodyBlock as RegExpExecArray)[1], prop).toContain(prop);
    }
  });

  it("declares all four palette blocks", () => {
    for (const name of ["cyber", "acid", "mono"]) {
      expect(TOKENS_CSS).toContain(`body[data-palette="${name}"]`);
    }
    // `blood` is the default and IS `:root` — it deliberately has no block.
    expect(TOKENS_CSS).not.toContain('body[data-palette="blood"]');
    expect(TOKENS_CSS).toContain(":root {");
  });

  it("declares no --dataviz-* property beyond the five", () => {
    const declared = new Set(
      [...TOKENS_CSS.matchAll(/(--dataviz-[a-z-]+)\s*:/g)].map((m) => m[1]),
    );
    expect([...declared].sort()).toEqual(Object.values(ROLE_PROPERTIES).sort());
  });
});

describe("mix() returns the ROLE TOKEN exactly at its endpoints", () => {
  it("t = 0 is the `to` token verbatim, not a 0% blend", () => {
    // A 0% `color-mix` is `to` in intent, but it travels through the colour
    // engine's interpolation and can round a channel differently. The final
    // frame of a deselect tween paints t = 0 while the resting frame paints the
    // raw token — a mismatch there leaves one anti-aliased pixel behind, and
    // "the canvas is at rest" stops being byte-true.
    expect(mix("var(--dataviz-accent)", "var(--dataviz-bone)", 0)).toBe(
      "var(--dataviz-bone)",
    );
  });

  it("t = 1 is the `from` token verbatim", () => {
    expect(mix("var(--dataviz-accent)", "var(--dataviz-bone)", 1)).toBe(
      "var(--dataviz-accent)",
    );
  });

  it("clamps out-of-range values onto those exact endpoints", () => {
    expect(mix("A", "B", -0.5)).toBe("B");
    expect(mix("A", "B", 2)).toBe("A");
  });

  it("interpolates in between, through the CSS colour engine", () => {
    expect(mix("A", "B", 0.5)).toBe("color-mix(in srgb, A 50%, B)");
  });
});

describe("withAlpha moves opacity and nothing else", () => {
  it("composes against transparent through the CSS colour engine", () => {
    // Rather than parsing four colour syntaxes — and risking producing a colour
    // the palette never authorised — this defers to `color-mix`. The HUE is
    // always the role's; only opacity moves, which is all rung 3 may change.
    expect(withAlpha("var(--dataviz-accent)", 0.5)).toBe(
      "color-mix(in srgb, var(--dataviz-accent) 50%, transparent)",
    );
  });

  it("clamps out-of-range alpha", () => {
    expect(withAlpha("var(--dataviz-bone)", -1)).toContain(" 0%,");
    expect(withAlpha("var(--dataviz-bone)", 9)).toContain(" 100%,");
  });

  it("always carries the role token through", () => {
    for (const role of Object.values(ROLE_PROPERTIES)) {
      expect(withAlpha(`var(${role})`, 0.38)).toContain(role);
    }
  });
});
