/**
 * FR-239 (T16, T17) — every timing is a token, and PRM creates no timeline.
 *
 * dataviz.md rule 07: *"Every duration is a `motion.md` token. `// LOOP` never
 * touches the canvas."* motion.md: *"Tokens, not free numbers. If you find
 * yourself writing `340ms`, you're outside the system."*
 *
 * These tests run in the node environment, where `document` does not exist, so
 * the resolvers exercise their FALLBACK path. That is not a weakness — the
 * fallbacks are asserted below to equal what `tokens.css` actually declares,
 * which is the real drift risk. The live-CSS path is exercised by the operator
 * checkpoint in a browser.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  DURATION_TOKENS,
  EASING_TOKENS,
  INTERACTIONS,
  REVEAL_STAGGER_MS,
  cubicBezier,
  durationMs,
  durationSec,
  easing,
  moveCamera,
  parseDuration,
  tweenScalar,
  type Camera,
  type InteractionName,
} from "../motion.js";

const TOKENS_CSS = readFileSync(
  new URL("../../styles/tokens.css", import.meta.url),
  "utf-8",
);

// ---------------------------------------------------------------------------
// T16 — the token sets
// ---------------------------------------------------------------------------

describe("T16 — five canvas durations, four easings, and no LOOP", () => {
  it("declares exactly the five durations the canvas may use", () => {
    expect([...DURATION_TOKENS]).toEqual([
      "instant",
      "quick",
      "std",
      "slow",
      "cine",
    ]);
  });

  it("LOOP is absent from the token set AND from the stylesheet", () => {
    // "Anything on `// LOOP` — Forbidden on the canvas, BY NAME. This includes
    // idling physics." Its absence is the guardrail: there is nothing to
    // accidentally reference.
    expect([...DURATION_TOKENS]).not.toContain("loop");
    expect(TOKENS_CSS).not.toContain("--t-loop:");
  });

  it("declares exactly the four easings", () => {
    expect([...EASING_TOKENS]).toEqual(["linear", "std", "spring", "step"]);
  });

  it("resolves every duration to motion.md's published value", () => {
    expect(durationMs("instant")).toBe(120);
    expect(durationMs("quick")).toBe(180);
    expect(durationMs("std")).toBe(320);
    expect(durationMs("slow")).toBe(600);
    expect(durationMs("cine")).toBe(1400);
  });

  it("the fallbacks EQUAL what tokens.css declares — the real drift risk", () => {
    // A resolver that falls back to a different number than the stylesheet
    // would make the canvas and the CSS disagree on what `// STD` means, and
    // nothing else in the system would notice.
    for (const token of DURATION_TOKENS) {
      const m = new RegExp(`--t-${token}:\\s*([^;]+);`).exec(TOKENS_CSS);
      expect(m, `tokens.css has no --t-${token}`).not.toBeNull();
      expect(parseDuration((m as RegExpExecArray)[1]), `--t-${token}`).toBe(
        durationMs(token),
      );
    }
  });

  it("tokens.css declares the four easings with motion.md's control points", () => {
    expect(TOKENS_CSS).toContain("--e-linear: linear;");
    expect(TOKENS_CSS).toContain("--e-std: cubic-bezier(0.4, 0, 0.2, 1);");
    expect(TOKENS_CSS).toContain(
      "--e-spring: cubic-bezier(0.34, 1.56, 0.64, 1);",
    );
    expect(TOKENS_CSS).toContain("--e-step: steps(8, end);");
  });

  it("converts to GSAP seconds in exactly one place", () => {
    expect(durationSec("std")).toBeCloseTo(0.32, 5);
    expect(durationSec("cine")).toBeCloseTo(1.4, 5);
  });
});

describe("T16 — the six interactions map to tokens, and nothing else", () => {
  it("every interaction names a real duration and a real easing", () => {
    for (const [name, timing] of Object.entries(INTERACTIONS)) {
      expect(DURATION_TOKENS as readonly string[], name).toContain(
        timing.duration,
      );
      expect(EASING_TOKENS as readonly string[], name).toContain(timing.ease);
    }
  });

  it("matches dataviz.md's interaction table exactly", () => {
    expect(INTERACTIONS["entrance-settle"]).toEqual({
      duration: "cine",
      ease: "std",
    });
    expect(INTERACTIONS["hover-highlight"]).toEqual({
      duration: "instant",
      ease: "std",
    });
    expect(INTERACTIONS["filter-to-muted"]).toEqual({
      duration: "quick",
      ease: "std",
    });
    expect(INTERACTIONS["path-trace"]).toEqual({
      duration: "slow",
      ease: "linear",
    });
    expect(INTERACTIONS["drill-down"]).toEqual({ duration: "slow", ease: "std" });
  });

  it("D7 — focus runs STD/STD; SPRING appears ONLY on the selection ring", () => {
    // The brief said focus/click `// SPRING`. SPRING is an EASING, and the spec
    // assigns focus STD/STD while reserving SPRING for a spawn. The spec wins.
    expect(INTERACTIONS["focus-select"]).toEqual({
      duration: "std",
      ease: "std",
    });
    expect(INTERACTIONS["selection-ring"].ease).toBe("spring");

    const springs = Object.entries(INTERACTIONS).filter(
      ([, t]) => t.ease === "spring",
    );
    expect(springs.map(([n]) => n)).toEqual(["selection-ring"]);
  });

  it("path-trace is capped at SLOW regardless of hop count", () => {
    // "One continuous tween over normalised path position, capped at SLOW
    // regardless of path length — long paths trace FASTER, not LONGER." The cap
    // is structural: the interaction carries ONE duration and there is no
    // per-hop multiplier anywhere.
    expect(INTERACTIONS["path-trace"].duration).toBe("slow");
    // COMMENTS STRIPPED. A JSDoc line is `... per hop` followed by `\n * `, so
    // an unstripped scan matches `hops?\s*\*` on the comment's own leading
    // asterisk and fails on prose. Same class as the corpus scan below, and the
    // reason that one was routed through a stripper too.
    const src = readFileSync(new URL("../motion.ts", import.meta.url), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/hops?\s*\*/);
    expect(src).not.toMatch(/\*\s*hops?\b/);
  });

  it("no interaction uses LOOP or an invented duration", () => {
    for (const timing of Object.values(INTERACTIONS)) {
      expect(timing.duration).not.toBe("loop");
    }
  });

  it("the reveal stagger is inherited by name, not invented", () => {
    // motion.md, signature interaction 05 · Reveal: "Stagger 150ms between
    // siblings." It is NOT a duration token and must never be used as one.
    expect(REVEAL_STAGGER_MS).toBe(150);
    expect(DURATION_TOKENS as readonly string[]).not.toContain("reveal");
  });
});

describe("T16 — no free number can enter through the resolvers", () => {
  it("durationMs only accepts a token name", () => {
    // The type system forbids `durationMs(340)`. This asserts the runtime
    // behaviour matches: an unknown key yields NaN-free garbage-in handling
    // rather than silently becoming a free duration.
    const rogue = durationMs("nope" as never);
    expect(Number.isFinite(rogue)).toBe(false);
  });

  it("parseDuration rejects a bare number", () => {
    expect(parseDuration("340")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("fast")).toBeNull();
    expect(parseDuration("320ms")).toBe(320);
    expect(parseDuration("0.32s")).toBeCloseTo(320, 5);
  });
});

// ---------------------------------------------------------------------------
// Easing curves
// ---------------------------------------------------------------------------

describe("T16 — the easing token's own curve is evaluated, not approximated", () => {
  it("cubicBezier is anchored at both ends", () => {
    const std = cubicBezier(0.4, 0, 0.2, 1);
    expect(std(0)).toBe(0);
    expect(std(1)).toBe(1);
  });

  it("STD is monotonic and eases in", () => {
    const std = cubicBezier(0.4, 0, 0.2, 1);
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const v = std(Math.min(1, p));
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
    // Eases in: at 20% of the time, less than 20% of the distance.
    expect(std(0.2)).toBeLessThan(0.2);
  });

  it("SPRING overshoots — which is what makes it a spawn", () => {
    const spring = cubicBezier(0.34, 1.56, 0.64, 1);
    let max = 0;
    for (let p = 0; p <= 1; p += 0.01) max = Math.max(max, spring(p));
    expect(max).toBeGreaterThan(1);
  });

  it("LINEAR is the identity", () => {
    const lin = easing("linear");
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      expect(lin(p)).toBeCloseTo(p, 6);
    }
  });

  it("resolves STD from the fallback to the same curve as the token", () => {
    const fromToken = easing("std");
    const direct = cubicBezier(0.4, 0, 0.2, 1);
    for (const p of [0.1, 0.3, 0.5, 0.9]) {
      expect(fromToken(p)).toBeCloseTo(direct(p), 6);
    }
  });

  it("clamps outside [0,1]", () => {
    const std = easing("std");
    expect(std(-1)).toBe(0);
    expect(std(2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T17 — reduced motion creates NO timeline
// ---------------------------------------------------------------------------

function fakeCamera(): Camera & { centreValue: { x: number; y: number }; k: number } {
  const c = {
    centreValue: { x: 0, y: 0 },
    k: 1,
    centre: () => c.centreValue,
    setCentre: (x: number, y: number) => {
      c.centreValue = { x, y };
    },
    scale: () => c.k,
    setScale: (k: number) => {
      c.k = k;
    },
  };
  return c;
}

describe("T17 — prefers-reduced-motion", () => {
  it("moveCamera applies the target in ONE write and creates no tween", () => {
    const cam = fakeCamera();
    const onUpdate = vi.fn();
    const handle = moveCamera(
      cam,
      { x: 100, y: 50, k: 2 },
      "focus-select",
      { reducedMotion: true, onUpdate },
    );
    expect(cam.centre()).toEqual({ x: 100, y: 50 });
    expect(cam.scale()).toBe(2);
    // One write, not a per-frame stream. The CSS PRM block can zero a
    // transition; it cannot reach a JS timeline — so the gate is here.
    expect(onUpdate).toHaveBeenCalledTimes(1);
    // A no-op handle: there is nothing to cancel because nothing was created.
    expect(() => handle.cancel()).not.toThrow();
  });

  it("tweenScalar jumps to the end value and completes synchronously", () => {
    const seen: number[] = [];
    const onComplete = vi.fn();
    tweenScalar("filter-to-muted", 0, 1, (v) => seen.push(v), {
      reducedMotion: true,
      onComplete,
    });
    expect(seen).toEqual([1]);
    // The completion callback still fires, so the interaction refcount in
    // `instance.ts` balances and the loop is not left resumed forever.
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("partial targets leave the other axes alone", () => {
    const cam = fakeCamera();
    cam.setCentre(5, 6);
    cam.setScale(3);
    moveCamera(cam, { x: 9 }, "drill-down", { reducedMotion: true });
    expect(cam.centre()).toEqual({ x: 9, y: 6 });
    expect(cam.scale()).toBe(3);
  });
});

describe("T17 — the camera surface cannot express a duration (F2)", () => {
  it("moveCamera drives the INSTANTANEOUS setters only", () => {
    const calls: string[] = [];
    const cam: Camera = {
      centre: () => ({ x: 0, y: 0 }),
      setCentre: (...a) => calls.push(`setCentre/${a.length}`),
      scale: () => 1,
      setScale: (...a) => calls.push(`setScale/${a.length}`),
    };
    moveCamera(cam, { x: 1, y: 2, k: 3 }, "focus-select", {
      reducedMotion: true,
    });
    // Two args and one arg. There is no third parameter to smuggle a duration
    // through, which is what routes around F2 structurally rather than by
    // convention.
    expect(calls).toEqual(["setCentre/2", "setScale/1"]);
  });
});

describe("every interaction name is actually INVOKED", () => {
  /**
   * This test previously had this title and asserted only `toHaveLength(7)`
   * plus set-uniqueness — it checked neither usage nor orphanhood, and two
   * interactions (`path-trace`, `drill-down`) sat declared-but-never-invoked
   * behind it. `path-trace` in particular is the ONLY producer of the `hot`
   * edge role, one of the four `dataviz.md` rule 04 binds unconditionally, so
   * its absence silently reduced the canvas to three edge types.
   *
   * The body now reads the consumers and asserts each name appears at a real
   * call site. A declared timing nobody invokes is a claim the surface does not
   * honour.
   */
  /**
   * Comments are STRIPPED, the way the sibling scan in
   * `dashboard-graph-source.test.ts` does it. Without this the guard proves only
   * that a string appears somewhere in the file — a single
   * `// NOTE: "path-trace" …` comment would satisfy it while the interaction
   * stayed uninvoked. It is not lying today, but it was one comment away from
   * being vacuous.
   */
  const strip = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  /**
   * THE CORPUS IS THE CONSUMERS ONLY — `motion.ts` is deliberately EXCLUDED.
   *
   * It used to be included, with the `INTERACTIONS` object literal excised so
   * the declaration could not count as a call site. That excision was
   * ineffective and the guard was vacuous: `export type InteractionName` is a
   * union of all seven string literals and it sits ABOVE `INTERACTIONS`, so
   * slicing from the object literal onward left every name in the corpus.
   * `strip()` does not touch it either — a type is not a comment. Every entry
   * satisfied the guard by being declared, which is precisely the vacuity the
   * rename was supposed to end.
   *
   * Excluding the declaring file removes the whole class of self-satisfaction.
   */
  const consumers = [
    strip(readFileSync(new URL("../useGraph.ts", import.meta.url), "utf-8")),
    strip(readFileSync(new URL("../instance.ts", import.meta.url), "utf-8")),
  ];
  const corpus = consumers.join("\n");

  /**
   * The six interactions whose call site lives in the consumer layer.
   *
   * `path-trace` is NOT here, and its absence is a fact about where the code
   * lives rather than an exemption: its only call site is
   * `INTERACTIONS["path-trace"]` inside `motion.ts#runPathTrace`, which this
   * corpus no longer reads. It is pinned instead — and more strongly — by
   * `dashboard-graph-source.test.ts`, which asserts `runPathTrace` is called
   * exactly once with `chain.length`, and by the wall-clock tests that drive
   * `startTrace` end to end.
   */
  const SEAM_INVOKED = [
    "entrance-settle",
    "hover-highlight",
    "focus-select",
    "selection-ring",
    "filter-to-muted",
    "drill-down",
  ] as const;

  /** A name that is declared nowhere and invoked nowhere. */
  const NEVER_INVOKED = "sentinel-never-invoked";

  /** The guard's actual logic, factored out so it can be aimed at a control. */
  const orphansAmong = (names: readonly string[]): string[] =>
    names.filter((name) => !corpus.includes(`"${name}"`));

  it("reads a non-empty consumer corpus", () => {
    // Guard against the scan passing by finding nothing.
    expect(corpus.length).toBeGreaterThan(2000);
    expect(corpus).toContain("tweenScalar");
  });

  it("SELF-NEGATIVE-CONTROL: the guard REPORTS an uninvoked name", () => {
    /*
     * WHAT THIS PROVES, EXACTLY: that `orphansAmong` can return a NON-EMPTY
     * result. Nothing more.
     *
     * That is worth having on its own terms. The defect class this brief kept
     * producing is a guard whose body cannot fail the property its title names,
     * and the only way to rule it out is to watch the logic report a failure.
     * `SEAM_INVOKED` alone can only ever produce `[]`, so a broken
     * `orphansAmong` would look identical to a healthy one; adding a name that
     * is invoked nowhere is what separates them.
     *
     * WHAT IT DOES *NOT* PROVE — the corpus is composed correctly.
     * Re-adding `motion.ts` (whose `InteractionName` union names every literal)
     * would make the orphan assertions vacuous, and this control would still
     * pass: `"sentinel-never-invoked"` is absent from `motion.ts` too, so
     * `orphansAmong` returns `[NEVER_INVOKED]` either way. Verified — with
     * `motion.ts` re-added AND `drill-down`'s invocation deleted, this control
     * passes and only the corpus-composition test below fails.
     *
     * Re-addition is caught by that separate test, NOT by this one. Do not
     * weaken it on the assumption that this control has it covered.
     */
    expect(orphansAmong([...SEAM_INVOKED, NEVER_INVOKED])).toEqual([
      NEVER_INVOKED,
    ]);
  });

  it("the corpus does not contain the declaring file", () => {
    /*
     * THE ONLY GUARD AGAINST RE-ADDING `motion.ts` TO THE CORPUS — not a
     * duplicate of the self-negative-control above, which does not cover this.
     *
     * `export type InteractionName` is a union of all seven string literals and
     * sits ABOVE `export const INTERACTIONS`, so any attempt to include
     * `motion.ts` while excising the object literal leaves every name in the
     * corpus and makes the orphan assertions vacuous. That is the exact defect
     * this file shipped with, and it survived three readings.
     *
     * Verified by construction: with `motion.ts` re-added AND `drill-down`'s
     * invocation deleted, the orphan assertions and the self-negative-control
     * ALL pass, and this test is the single thing that fails. If it is ever
     * weakened, the guard above becomes decorative.
     */
    expect(corpus).not.toContain("export type InteractionName");
    expect(corpus).not.toContain("export const INTERACTIONS");
    expect(corpus).not.toContain(`"${NEVER_INVOKED}"`);
  });

  it("every seam interaction appears at a real call site", () => {
    const orphans = orphansAmong(SEAM_INVOKED);
    expect(
      orphans,
      `declared but never invoked: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("declares the six spec interactions plus the selection ring", () => {
    const names = Object.keys(INTERACTIONS) as InteractionName[];
    expect(names).toHaveLength(7);
    expect(new Set(names).size).toBe(names.length);
    // Every declared name is either invoked from the seam or is `path-trace`,
    // whose call site is pinned elsewhere. A NEW entry lands in neither bucket
    // and fails here.
    for (const name of names) {
      expect(
        [...SEAM_INVOKED, "path-trace"],
        `${name} has no recorded call site`,
      ).toContain(name);
    }
  });

  it("path-trace reaches the canvas through the seam, so `hot` is reachable", () => {
    /*
     * Exemption 03 makes `hot` per-interaction: if nothing ever populates
     * `traced`, `EdgeActivity === "traced"` is unreachable and the canvas has
     * three edge types, not four.
     *
     * The previous version of this test asserted `/runPathTrace\(/` and
     * `/s\.traced = new Set\(/` against a corpus containing `motion.ts` — the
     * first matched the FUNCTION DECLARATION, and the second matched
     * `useGraph.ts`'s DESELECT clearing line, not the trace. Both were satisfied
     * with no trace invoked at all.
     */
    expect(corpus).toMatch(/startTrace\(/);
    // The hot set is populated from the trace's own hook, not from a clear.
    expect(corpus).toMatch(/onTraced:\s*\(ids\)\s*=>/);
    expect(corpus).toMatch(/s\.traced = ids/);
  });

  it("drill-down is invoked, so a subgraph swap is not a second entrance", () => {
    // The ONLY assertion in the repo that `drill-down` is invoked. With
    // `motion.ts` in the corpus this passed even with the invocation deleted.
    expect(corpus).toContain('"drill-down"');
  });
});
