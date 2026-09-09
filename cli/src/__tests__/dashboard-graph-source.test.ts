/**
 * FR-239 (T8, T13) — the mechanical scope scans over the graph source.
 *
 * These are source scans and they are honest about what that means. T13 (zero
 * colour literals) is a real proof: a literal in the source is a literal in the
 * bundle, and the ONLY way a colour reaches the canvas is through
 * `palette.ts`'s computed-token read.
 *
 * T8 is narrower. It proves **our** code does not reintroduce motion and does
 * not hand the library a duration. It does NOT prove the library is still —
 * that is measured by `stillness.test.ts` (the instrument) and by the operator
 * checkpoint with its mandatory negative control. The plan says this plainly
 * and so does this file, because a structural check that quietly gets read as a
 * stillness guarantee is how the AC gets faked.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DASH_SRC = join(CLI_ROOT, "dashboard", "src");
const GRAPH_DIR = join(DASH_SRC, "graph");
const GRAPH_COMPONENTS = join(DASH_SRC, "components", "graph");
const GRAPH_PAGE = join(DASH_SRC, "pages", "Graph.tsx");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Every graph-owned source file. Tests included — a literal there counts too. */
function graphSources(): string[] {
  const files = [...walk(GRAPH_DIR), ...walk(GRAPH_COMPONENTS)];
  if (existsSync(GRAPH_PAGE)) files.push(GRAPH_PAGE);
  return files;
}

/** Non-test graph sources — what actually ships in the bundle. */
function shippedSources(): string[] {
  return graphSources().filter((f) => !f.includes("__tests__"));
}

/** Strip comments so prose explaining a rule cannot trip the rule. */
function code(file: string): string {
  return readFileSync(file, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function rel(file: string): string {
  return relative(CLI_ROOT, file);
}

describe("the scan has a corpus — it cannot pass by finding nothing", () => {
  it("finds the graph engine, its components and its page", () => {
    const files = graphSources().map(rel);
    // A scan over an empty file list passes every assertion below and proves
    // nothing. This is the guard against a moved directory silently disarming
    // both T8 and T13.
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const expected of [
      "dashboard/src/graph/instance.ts",
      "dashboard/src/graph/stillness.ts",
      "dashboard/src/graph/palette.ts",
      "dashboard/src/graph/shapes.ts",
      "dashboard/src/graph/edges.ts",
      "dashboard/src/graph/motion.ts",
      "dashboard/src/graph/useGraph.ts",
      "dashboard/src/pages/Graph.tsx",
    ]) {
      expect(files, `${expected} not scanned`).toContain(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// T13 — AC #3: zero colours outside the role tokens
// ---------------------------------------------------------------------------

describe("T13 — AC #3: no colour literal anywhere in the graph source", () => {
  /**
   * `transparent` is a CSS-wide keyword meaning "no paint", not a colour
   * choice, and it is the honest value for both an unresolved role token and
   * the canvas element's background (exemption 01 needs the grid to show
   * through). It is the ONLY allowed word, and it is allowed by name rather
   * than by pattern.
   */
  const ALLOWED_KEYWORDS = new Set(["transparent", "currentColor", "none"]);

  const CSS_NAMED = [
    "black", "white", "red", "green", "blue", "yellow", "orange", "purple",
    "grey", "gray", "cyan", "magenta", "pink", "brown", "teal", "navy",
    "olive", "maroon", "silver", "gold", "lime", "aqua", "fuchsia",
  ];

  it("no hex colour", () => {
    const found: string[] = [];
    for (const file of shippedSources()) {
      for (const m of code(file).matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        found.push(`${rel(file)}: ${m[0]}`);
      }
    }
    expect(found, `hex colour literals:\n${found.join("\n")}`).toEqual([]);
  });

  it("no rgb / rgba / hsl / hsla function", () => {
    const found: string[] = [];
    for (const file of shippedSources()) {
      for (const m of code(file).matchAll(/\b(?:rgba?|hsla?)\s*\(/g)) {
        found.push(`${rel(file)}: ${m[0]}`);
      }
    }
    expect(found, `colour functions:\n${found.join("\n")}`).toEqual([]);
  });

  it("no CSS named colour used as a value", () => {
    const found: string[] = [];
    for (const file of shippedSources()) {
      const src = code(file);
      for (const name of CSS_NAMED) {
        // Only as a STRING value — `black` inside an identifier like
        // `blackboard` is not a colour, and neither is a prop named `green`.
        const re = new RegExp(`["'\`]${name}["'\`]`, "gi");
        for (const m of src.matchAll(re)) found.push(`${rel(file)}: ${m[0]}`);
      }
    }
    expect(found, `named colours:\n${found.join("\n")}`).toEqual([]);
  });

  it("every colour-valued string is a role token, a var(), or an allowed keyword", () => {
    // The positive form of the rule. `fillStyle` / `strokeStyle` assignments
    // are where a stock palette would actually land on the canvas.
    const found: string[] = [];
    for (const file of shippedSources()) {
      const src = code(file);
      for (const m of src.matchAll(
        /\b(?:fillStyle|strokeStyle|shadowColor)\s*=\s*(.+)/g,
      )) {
        const value = m[1].trim();
        const literal = /^["'`]([^"'`]*)["'`]/.exec(value);
        if (literal === null) continue; // an expression — covered by the scans above
        if (ALLOWED_KEYWORDS.has(literal[1])) continue;
        if (literal[1].includes("var(--dataviz-")) continue;
        found.push(`${rel(file)}: ${m[0].trim()}`);
      }
    }
    expect(found, `non-token canvas colours:\n${found.join("\n")}`).toEqual([]);
  });

  it("palette.ts names exactly the five sanctioned role properties, and no others", () => {
    const src = readFileSync(join(GRAPH_DIR, "palette.ts"), "utf-8");
    const props = new Set(
      [...src.matchAll(/--dataviz-[a-z-]+/g)].map((m) => m[0]),
    );
    // dataviz.md §02: "A data-viz surface may define exactly these custom
    // properties, and no others."
    expect([...props].sort()).toEqual([
      "--dataviz-accent",
      "--dataviz-bone",
      "--dataviz-edge-dim",
      "--dataviz-grid",
      "--dataviz-muted",
    ]);
  });

  it("the graph CSS block defines no colour literal either", () => {
    const css = readFileSync(join(DASH_SRC, "styles", "base.css"), "utf-8");
    const start = css.indexOf("FR-239 · the graph surface");
    expect(start, "the FR-239 CSS block is missing").toBeGreaterThan(0);
    const block = css
      .slice(start)
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/#[0-9a-fA-F]{3,8}\b/.test(block), "hex in the graph CSS").toBe(false);
    expect(/\b(?:rgba?|hsla?)\s*\(/.test(block), "rgb() in the graph CSS").toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// T8 — AC #5 / AC #6 structural guards over OUR code
// ---------------------------------------------------------------------------

describe("T8 — F2: the library's timed camera API is never used", () => {
  /**
   * `centerAt(x, y, ms)` and `zoom(k, ms)` accept a duration but apply the
   * LIBRARY's own easing, which is not one of motion.md's four. Every camera
   * move is a GSAP tween on a token duration and a token easing whose
   * `onUpdate` calls the instantaneous variants (`motion.ts#moveCamera`).
   *
   * This scan is the pin. It counts arguments at the call site.
   */
  it("centerAt is never called with a third argument", () => {
    const found: string[] = [];
    for (const file of graphSources()) {
      for (const m of code(file).matchAll(/\.centerAt\s*\(([^)]*)\)/g)) {
        const args = m[1].trim();
        const arity = args === "" ? 0 : args.split(",").length;
        if (arity >= 3) found.push(`${rel(file)}: ${m[0]}`);
      }
    }
    expect(found, `timed centerAt calls:\n${found.join("\n")}`).toEqual([]);
  });

  it("zoom is never called with a second argument", () => {
    const found: string[] = [];
    for (const file of graphSources()) {
      for (const m of code(file).matchAll(/\.zoom\s*\(([^)]*)\)/g)) {
        const args = m[1].trim();
        const arity = args === "" ? 0 : args.split(",").length;
        if (arity >= 2) found.push(`${rel(file)}: ${m[0]}`);
      }
    }
    expect(found, `timed zoom calls:\n${found.join("\n")}`).toEqual([]);
  });

  it("the Camera interface has no duration parameter to pass one through", () => {
    // Belt: even if a call site were added, there would be nowhere to put the
    // duration. `setCentre(x, y)` and `setScale(k)` are the whole surface.
    const src = readFileSync(join(GRAPH_DIR, "motion.ts"), "utf-8");
    expect(src).toContain("setCentre: (x: number, y: number) => void;");
    expect(src).toContain("setScale: (k: number) => void;");
  });
});

describe("T8 — the library API is confined", () => {
  it("only instance-factory.ts imports force-graph", () => {
    const importers = graphSources().filter((f) =>
      /from\s+["']force-graph["']/.test(readFileSync(f, "utf-8")),
    );
    // The seam is two files for a MEASURED reason: `force-graph` dereferences
    // `window` at import time, so `instance.ts` — which carries the AC #5
    // state machine — must stay importable by the node-environment vitest run.
    // `instance-factory.ts` is one line long and does nothing else.
    expect(importers.map(rel)).toEqual([
      "dashboard/src/graph/instance-factory.ts",
    ]);
  });

  it("instance-factory.ts really is only the constructor", () => {
    const src = code(join(GRAPH_DIR, "instance-factory.ts"))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    // If this file grows, the seam has moved out of `instance.ts` and the scan
    // above stops meaning what it says.
    expect(src.length).toBeLessThanOrEqual(6);
    expect(src.join("\n")).toContain("new ForceGraph(el)");
  });

  it("no file outside instance.ts touches a force-graph-only accessor", () => {
    // A representative set of methods that exist ONLY on the library instance.
    // Their appearance anywhere else means the wrapper has been bypassed.
    const LIBRARY_ONLY = [
      "pauseAnimation",
      "resumeAnimation",
      "onEngineStop",
      "cooldownTime",
      "cooldownTicks",
      "warmupTicks",
      "graphData",
      "nodeCanvasObject",
      "nodePointerAreaPaint",
      "linkDirectionalArrowLength",
      "d3ReheatSimulation",
      "d3AlphaDecay",
      "autoPauseRedraw",
    ];
    const found: string[] = [];
    for (const file of shippedSources()) {
      const name = rel(file);
      if (name.endsWith("graph/instance.ts")) continue;
      const src = code(file);
      for (const method of LIBRARY_ONLY) {
        if (new RegExp(`\\b${method}\\s*\\(`).test(src)) {
          found.push(`${name}: ${method}()`);
        }
      }
    }
    expect(found, `library API outside instance.ts:\n${found.join("\n")}`).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// FR-244 — ONE size law. No node geometry divides by the zoom factor itself.
// ---------------------------------------------------------------------------

/**
 * A node-size expression divided directly by force-graph's zoom factor.
 *
 * `*sizePx` (`sizePx`, `nodeSizePx`, and `captureSizePx(...)`'s result) is the
 * screen-space size of a NODE. `globalScale` / `scale` is `k`. A line holding
 * both, with the second as an immediate divisor, is an open-coded size law.
 *
 * Deliberately NARROW. It does not flag `LABEL_LINE_PX / scale` or
 * `LABEL_GAP_PX / scale`, and it must not: those are TYPE metrics with their
 * own legibility floor, and `useGraph.ts` records why they stay constant on
 * screen while node geometry does not.
 */
const OPEN_CODED_SIZE_LAW = /\w*[sS]izePx[^\n]*\/\s*(?:globalScale|scale)\b/;

describe("FR-244 — every node geometry goes through nodeWorldSize", () => {
  /**
   * WHY THIS SCAN EXISTS. FR-244 found FIVE places dividing a node size by the
   * zoom factor: the paint, the pointer-area buffer, the selection ring, the
   * pointer-capture size and the label obstacle boxes. They must move together
   * — a call site that kept its own division would make hit-testing disagree
   * with the rendered picture at low zoom, which presents as a click selecting
   * a node the operator is not pointing at. That is indistinguishable, from the
   * outside, from FR-239's dead-canvas defect.
   *
   * WHAT IT PROVES: no sixth site written in the OBVIOUS form — a `*sizePx`
   * expression and the divisor on ONE line — can be added without this going
   * red. That is the form all five original sites were written in, and the form
   * a copy-paste of any of them would take.
   *
   * WHAT IT DOES NOT PROVE, precisely:
   *  - **Aliasing defeats it.** `const n = s.nodeSizePx;` on one line and
   *    `const world = n / globalScale;` on the next puts the size and the
   *    divisor on different lines with no `sizePx` token on the second, and
   *    this regex cannot see it. A line-oriented scan over a comment-stripped
   *    source is the wrong instrument for that; catching it needs the AST, and
   *    the honest position is that this guard covers the likely mistake rather
   *    than the adversarial one.
   *  - That the law is CORRECT, or that the existing consumers agree
   *    numerically.
   *
   * **Sibling for BOTH gaps:** `dashboard/src/graph/__tests__/shapes.test.ts`
   * drives `nodeWorldSize` at every `k` and asserts the four distinct geometry
   * laws derive from one function — an aliased division that produced a
   * DIFFERENT number would have to disagree there. Do not weaken it on the
   * assumption this scan has it covered; it does not.
   */
  it("no node-size expression is divided by the zoom factor outside the law", () => {
    const found: string[] = [];
    for (const file of shippedSources()) {
      const lines = code(file).split("\n");
      lines.forEach((line, i) => {
        if (OPEN_CODED_SIZE_LAW.test(line)) {
          found.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      found,
      `open-coded node size law (route it through shapes.ts#nodeWorldSize):\n${found.join("\n")}`,
    ).toEqual([]);
  });

  /**
   * SELF-NEGATIVE-CONTROL (learning 1094). A guard whose only observed output
   * is an empty array is indistinguishable from a guard that cannot match
   * anything — and the four accidental ways to break this one (a typo in the
   * identifier, a stray `^`, an `m` flag left off, `code()` stripping the wrong
   * thing) all produce exactly that empty array.
   *
   * WHAT THIS CONTROL DOES NOT COVER: the CORPUS. If `shippedSources()` ever
   * stopped returning the graph files, the scan above would pass while
   * examining nothing, and this control — which never touches the corpus —
   * would still be green. The sibling that covers that gap is T8's
   * "only instance-factory.ts imports force-graph", which asserts a NON-empty
   * expected value over the same corpus and therefore fails loudly if it
   * empties. Do not weaken T8 on the assumption this one has it covered.
   */
  it("the scan REPORTS a planted violation, so its empty result means something", () => {
    const planted = [
      "const s = visual.sizePx / globalScale;",
      "const size = captureSizePx(s.nodeSizePx, s.coarsePointer) / scale;",
      "const r = (visual.sizePx * (1.2 + 1.4 * s.ring)) / scale * 0.5;",
    ];
    for (const line of planted) {
      expect(OPEN_CODED_SIZE_LAW.test(line), `not flagged: ${line}`).toBe(true);
    }
    // And the type metrics it must NOT flag, so the scan cannot be "tightened"
    // into one that forbids every division and forces labels through the node
    // law too.
    for (const line of [
      "const fontPx = LABEL_LINE_PX / scale;",
      "const pad = 240 / scale;",
    ]) {
      expect(OPEN_CODED_SIZE_LAW.test(line), `wrongly flagged: ${line}`).toBe(false);
    }
  });

  /**
   * TD-337 — `browser-gate.mjs` MIRRORS `NODE_SIZE_ZOOM_FLOOR`, and this is the
   * pin that pays for the mirror.
   *
   * WHY THERE IS A MIRROR AT ALL. `G-BR-11`'s `11a` / `11b` / `11e` / `11-range`
   * are anchored to this constant — it is the boundary the size law is defined
   * by, and the only anchor that is absolute (`k_fit`, the previous anchor, is
   * `zoomToFit()`'s scale and therefore a function of the canvas box, which
   * moves). The gate could have read the value out of the page the way FR-250's
   * `11c` reads `--graph-column-scale`, but that token was already a CSS custom
   * property in the DOM at zero cost, whereas exposing a JS constant to `window`
   * costs bundle surface. Since TD-347 that surface is the DEFERRED `Graph-<hash>`
   * chunk — `shapes.ts` is reached only from `pages/Graph.tsx`, so it is charged
   * against `TOTAL_JS_CEILING`, never the initial set — which makes the byte
   * argument much weaker than it was pre-split. The argument that still carries
   * the decision is DRIFT DETECTION: a gate reading the value out of the page
   * agrees with whatever the page says and can never notice the constant moving,
   * whereas a mirror plus this pin turns a move into a red test. So the gate
   * mirrors, and pays
   * mechanically: THIS test, plus a `MAINTAINING.md` contract row whose change
   * procedure names the re-derivation the gate owes when the constant moves.
   *
   * The two literals are read out of the two files and compared as NUMBERS, so
   * `0.11` and `0.110` would agree and a re-based `0.09` would not.
   */
  it("browser-gate.mjs's K_FLOOR mirror equals shapes.ts's NODE_SIZE_ZOOM_FLOOR", () => {
    const shapes = readFileSync(join(GRAPH_DIR, "shapes.ts"), "utf-8");
    const owner = /export const NODE_SIZE_ZOOM_FLOOR\s*=\s*([0-9.]+)\s*;/.exec(shapes);
    expect(owner, "NODE_SIZE_ZOOM_FLOOR is no longer declared in shapes.ts").not.toBeNull();

    const gatePath = join(CLI_ROOT, "scripts", "browser-gate.mjs");
    const gate = readFileSync(gatePath, "utf-8");
    const mirror = /^const K_FLOOR\s*=\s*([0-9.]+)\s*;/m.exec(gate);
    expect(
      mirror,
      "browser-gate.mjs no longer declares `const K_FLOOR = <number>;` — if the gate now reads the value from the page instead, delete this test AND the MAINTAINING row it pays for",
    ).not.toBeNull();

    expect(
      Number(mirror![1]),
      "the browser gate's K_FLOOR mirror has drifted from shapes.ts#NODE_SIZE_ZOOM_FLOOR. Moving this constant RE-BASES G-BR-11's 11a / 11b / 11e / 11-range: re-run the invariance probe and re-derive FROZEN_PRESERVATION_FLOOR before shipping the move (MAINTAINING.md)",
    ).toBe(Number(owner![1]));
  });

  it("SELF-NEGATIVE-CONTROL — the mirror detector rejects a drifted literal", () => {
    // Without this, a regex that matched nothing would make the pin above pass
    // by comparing `undefined` with `undefined`… except it would throw on the
    // non-null assertion, which is why the two `expect(...).not.toBeNull()`
    // lines exist. What this adds is proof the COMPARISON discriminates: two
    // different literals must not be read as equal.
    const drifted = "const K_FLOOR = 0.09;\n";
    const m = /^const K_FLOOR\s*=\s*([0-9.]+)\s*;/m.exec(drifted);
    expect(m).not.toBeNull();
    expect(Number(m![1])).not.toBe(0.11);
  });

  it("the law itself is exported from shapes.ts and used by both files", () => {
    // The scan above is satisfied by DELETING every consumer, so this is the
    // half that says the consumers exist and reach the one law.
    const shapes = code(join(GRAPH_DIR, "shapes.ts"));
    expect(shapes).toMatch(/export function nodeWorldSize\(/);
    expect(shapes).toMatch(/Math\.max\(globalScale, NODE_SIZE_ZOOM_FLOOR\)/);
    const useGraph = code(join(GRAPH_DIR, "useGraph.ts"));
    // Ring radius, pointer-capture size, label obstacle size.
    expect([...useGraph.matchAll(/nodeWorldSize\(/g)].length).toBeGreaterThanOrEqual(3);
    // Paint and the pointer-area buffer.
    expect([...shapes.matchAll(/nodeWorldSize\(/g)].length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// C1 — the interaction boundary must stay OUTSIDE the render loop
// ---------------------------------------------------------------------------

describe("C1 — the wake path is a DOM listener, not a library callback", () => {
  /**
   * `pauseAnimation()` is `cancelAnimationFrame`, and the library puts
   * hit-testing, the `onNodeHover` dispatch and the shadow-canvas refresh INSIDE
   * that loop. So a wake path built on a library callback is circular: once the
   * loop is halted the callback can never fire to restart it, and the canvas is
   * dead rather than still — hover does nothing, and a click reads a `hoverObj`
   * frozen at `null`, which DESELECTS instead of selecting.
   *
   * The behavioural half of this guard lives in `graph/__tests__/instance.test.ts`
   * (a real `Event` dispatched at a real `EventTarget`). This half asserts the
   * WIRING: that `useGraph` actually attaches the boundary to the canvas host.
   * Both halves exist because the first version had neither — the fix could be
   * deleted wholesale with every test still green.
   */
  const useGraphSrc = () => code(join(GRAPH_DIR, "useGraph.ts"));
  const instanceSrc = () => code(join(GRAPH_DIR, "instance.ts"));

  it("useGraph attaches the boundary to the container element", () => {
    const src = useGraphSrc();
    // Comments are stripped by `code()`, so a comment MENTIONING the call
    // cannot satisfy this.
    expect(src).toMatch(/attachPointerBoundary\(\s*el\s*,\s*ctrl\s*\)/);
    expect(src).toContain("attachPointerBoundary");
  });

  it("useGraph detaches it on teardown", () => {
    // A leaked listener would call into a destroyed instance.
    expect(useGraphSrc()).toMatch(/detachPointerBoundary\(\)/);
  });

  it("the boundary routes DOM events to pointerActivity", () => {
    const src = instanceSrc();
    expect(src).toMatch(/addEventListener\(\s*type\s*,\s*onActivity/);
    expect(src).toMatch(/controller\.pointerActivity\(\)/);
    expect(src).toMatch(/removeEventListener\(\s*type\s*,\s*onActivity/);
  });

  it("the pointer set covers enter, move, down, up, leave and wheel", () => {
    const src = instanceSrc();
    for (const type of [
      "pointerenter",
      "pointermove",
      "pointerdown",
      "pointerup",
      "pointerleave",
      "wheel",
    ]) {
      expect(src, `POINTER_WAKE_EVENTS is missing ${type}`).toContain(
        `"${type}"`,
      );
    }
  });

  it("zoom and drag are wired to the wake path, not left dangling", () => {
    // These fire from d3 DOM handlers, outside the loop, so they are valid
    // wake paths — unlike `onNodeHover`.
    const src = instanceSrc();
    for (const cb of ["onZoom", "onZoomEnd", "onNodeDrag", "onNodeDragEnd"]) {
      expect(src).toMatch(new RegExp(`\\.${cb}\\(\\(\\) => pointerActivity\\(\\)\\)`));
    }
  });
});

describe("T8 — our code owns no animation loop", () => {
  it("no requestAnimationFrame call site in the graph source", () => {
    const found: string[] = [];
    for (const file of shippedSources()) {
      if (/\brequestAnimationFrame\b/.test(code(file))) found.push(rel(file));
    }
    // This guards OUR code. It says nothing about the library's internals —
    // see this file's header. Stillness is MEASURED, not proved here.
    expect(found, `rAF sites:\n${found.join("\n")}`).toEqual([]);
  });

  it("no setInterval anywhere in the graph source (D8)", () => {
    const found: string[] = [];
    for (const file of shippedSources()) {
      if (/\bsetInterval\b/.test(code(file))) found.push(rel(file));
    }
    // A timer here would be an ambient re-layout: motion nobody asked for,
    // and the exact failure AC #5 is written to catch.
    expect(found, `setInterval sites:\n${found.join("\n")}`).toEqual([]);
  });

  it("every setTimeout in the graph source is one of the five known ones", () => {
    /**
     * SCOPE, stated because the previous version of this guard silently had a
     * narrower one: `instance.test.ts` pins the two timers in `instance.ts`
     * (the deferred halt and the pointer-idle debounce) and nothing pinned the
     * two in `useGraph.ts` at all.
     *
     * All five are one-shots that END motion, bound a repaint window, or pace
     * the stillness probe's sampler. None repeats. The count is pinned across
     * the WHOLE graph source so a sixth cannot arrive unexamined — which is how
     * an ambient one eventually lands. (Widening this from "instance.ts only"
     * immediately surfaced the `stillness.ts` site, which nothing had pinned.)
     */
    const sites: Array<{ file: string; count: number }> = [];
    for (const file of shippedSources()) {
      const n = [...code(file).matchAll(/(?<!typeof )\bsetTimeout\s*\(/g)].length;
      if (n > 0) sites.push({ file: rel(file), count: n });
    }
    expect(sites).toEqual([
      // 1 — the deferred halt (bug 1). 2 — the pointer-idle re-pause (C1).
      { file: "dashboard/src/graph/instance.ts", count: 2 },
      // 3 — the AC #5 probe's sample interval. Injectable, and the unit tests
      //     drive it on a fake clock; this is only the real-browser default.
      { file: "dashboard/src/graph/stillness.ts", count: 1 },
      // 4 — the palette repaint window. 5 — the camera focus release.
      { file: "dashboard/src/graph/useGraph.ts", count: 2 },
    ]);

    const useGraph = code(join(GRAPH_DIR, "useGraph.ts"));
    // Both are bounded by a TOKEN duration, not a free number.
    expect(useGraph).toMatch(/window\.setTimeout\(\s*\n?\s*\(\) => ctrl\.endInteraction\(\)/);
    expect(useGraph).toMatch(/durationMs\(/);
    expect(useGraph).not.toMatch(/setTimeout\([^)]*,\s*\d{2,}\s*\)/);
  });

  it("the graph page does not key any fetch off live.tick (D8)", () => {
    const src = code(GRAPH_PAGE);
    expect(src).not.toContain("live.tick");
    expect(src).not.toContain("useLive");
  });
});

// ---------------------------------------------------------------------------
// AC #6 — every timing on the canvas is a token
// ---------------------------------------------------------------------------

describe("T8 — no free duration anywhere on the canvas", () => {
  it("no gsap tween outside motion.ts", () => {
    const found: string[] = [];
    for (const file of shippedSources()) {
      if (rel(file).endsWith("graph/motion.ts")) continue;
      if (/from\s+["']gsap["']/.test(readFileSync(file, "utf-8"))) {
        found.push(rel(file));
      }
    }
    // Every timing is resolved from a `--t-*` / `--e-*` token inside
    // `motion.ts`. A tween created anywhere else could carry a free number.
    expect(found, `gsap imports outside motion.ts:\n${found.join("\n")}`).toEqual(
      [],
    );
  });

  it("no per-hop duration term ANYWHERE in the graph source", () => {
    // This scan used to live inside `motion.test.ts` and cover `motion.ts`
    // only — which is how a per-hop trace could be written in `useGraph.ts`
    // with nothing noticing. Widened to the whole graph source.
    const found: string[] = [];
    for (const file of shippedSources()) {
      const src = code(file);
      for (const re of [
        /\bhops?\s*\*/,
        /\*\s*hops?\b/,
        /\bchain\.length\s*\*/,
        /\*\s*chain\.length\b/,
        /duration\w*\s*\*\s*\w+\.length/,
        /\w+\.length\s*\*\s*duration/i,
      ]) {
        if (re.test(src)) found.push(`${rel(file)}: ${re}`);
      }
    }
    expect(
      found,
      `a duration scaled by path length:\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("the path trace is ONE tween, un-chainable per hop WITHIN the unit", () => {
    /**
     * The structural half of the time cap. A per-hop chain — tween hop 1, then
     * hop 2 from its `onComplete`, and so on — makes a 30-hop trace take 18
     * seconds while every duration in the file still reads `// SLOW`. That
     * mutation was written and passed the entire suite.
     *
     * `edges.test.ts` now MEASURES the wall clock and catches it. This makes it
     * hard to write in the first place: the interaction is invoked from exactly
     * one place, that place holds exactly one tween, and it does not re-enter.
     */
    const motion = code(join(GRAPH_DIR, "motion.ts"));

    // The trace token is confined to `motion.ts`. No other file can start a
    // trace, so there is exactly one place a per-hop chain could be written and
    // the assertions below cover it.
    const traceFiles = shippedSources()
      .filter((f) => /"path-trace"/.test(code(f)))
      .map(rel);
    expect(traceFiles).toEqual(["dashboard/src/graph/motion.ts"]);

    /*
     * MUTATION B — the per-hop chain written in the CALLER.
     *
     * `runPathTrace(1, …)` once per hop, chained through `onComplete`, evades
     * the confinement and `hops *` bans: no `"path-trace"` literal moves into
     * the caller, the unit's own body is untouched, and no per-hop arithmetic
     * appears. A 30-hop trace becomes 18 seconds and the suite stays green.
     *
     * WHAT THE TWO ASSERTIONS BELOW ACTUALLY CLOSE — stated precisely, because
     * an overstated guard is the same defect as a test titled for a property it
     * does not check; it just fails at review time instead of at runtime.
     *
     * They close **every per-hop composition writable inside the unit** — that
     * is, inside `startTrace`, which is where the composition now lives. Any
     * such rewrite must either call `runPathTrace` more than once or pass it
     * something other than `chain.length`, and both are caught here. The
     * wall-clock test in `graph/__tests__/edges.test.ts` catches the same
     * mutation independently, by driving `startTrace` end to end at 3 and 30
     * hops.
     *
     * THE RESIDUAL, NAMED: a CALLER that re-enters `startTrace` from one of its
     * own hooks — advancing the trace a segment at a time from `onEnd` — is not
     * caught. It satisfies every assertion here: `runPathTrace` is still called
     * exactly once with `chain.length`, `startTrace(` still appears textually
     * once in `useGraph`, and `motion.ts` is untouched. Measured through the
     * real function it is linear in hops (3-hop 1801 ms, 8-hop 4811 ms, ratio
     * 2.67), so 30 hops would again be ~18 s.
     *
     * No static ban can stop a caller invoking a correct function twice in
     * sequence. Closing it needs either a React-level test of
     * `useGraph#traceFrom`, or a rule that `startTrace` is unreachable from its
     * own hooks. Deliberately NOT attempted here — it is filed as a follow-up,
     * and writing that evasion means building a segmented-trace feature on
     * purpose rather than slipping during a refactor.
     */
    const traceCalls: string[] = [];
    for (const file of shippedSources()) {
      // The lookbehind excludes the declaration; every remaining match is a
      // real CALL SITE.
      for (const m of code(file).matchAll(
        /(?<!export function )runPathTrace\(([^,)]*)/g,
      )) {
        traceCalls.push(`${rel(file)}: runPathTrace(${m[1].trim()}`);
      }
    }
    expect(
      traceCalls,
      `runPathTrace must be called EXACTLY ONCE, with chain.length:\n${traceCalls.join("\n")}`,
    ).toEqual(["dashboard/src/graph/motion.ts: runPathTrace(chain.length"]);

    // And the composition is invoked exactly once, from the React seam.
    const startCalls: string[] = [];
    for (const file of shippedSources()) {
      for (const m of code(file).matchAll(/startTrace\(/g)) {
        void m;
        startCalls.push(rel(file));
      }
    }
    expect(startCalls.filter((f) => f.endsWith("useGraph.ts"))).toHaveLength(1);

    // `runPathTrace` holds exactly ONE tween...
    const decl = motion.indexOf("export function runPathTrace");
    expect(decl, "runPathTrace not found").toBeGreaterThan(0);
    // Slice past the SIGNATURE (so the declaration cannot satisfy the
    // anti-recursion check) and stop at the NEXT top-level export, so a later
    // function that legitimately calls `runPathTrace` is not read as recursion.
    const bodyStart = motion.indexOf("{", motion.indexOf(")", decl));
    const nextExport = motion.indexOf("\nexport ", bodyStart);
    const body = motion.slice(
      bodyStart,
      nextExport < 0 ? motion.length : nextExport,
    );
    expect([...body.matchAll(/tweenScalar\(/g)]).toHaveLength(1);
    // ...and does not call itself, directly or through a local step function.
    expect(body).not.toMatch(/runPathTrace\s*\(/);
    expect(body).not.toMatch(/onComplete:\s*\(\)\s*=>\s*step\(/);
    // The hop count is used to INDEX progress, never to scale a duration.
    expect(body).toMatch(/Math\.ceil\(v \* hopCount\)/);
    expect(body).not.toMatch(/duration\w*[^\n]*hopCount/i);
  });

  it("motion.ts declares exactly the five canvas durations and four easings", () => {
    const src = readFileSync(join(GRAPH_DIR, "motion.ts"), "utf-8");
    // `// LOOP` is forbidden on the canvas BY NAME, so it has no token here and
    // no CSS alias in tokens.css. Its absence is the guardrail.
    expect(src).not.toMatch(/--t-loop/);
    expect(src).toMatch(/"instant",\s*\n?\s*"quick",\s*\n?\s*"std",\s*\n?\s*"slow",\s*\n?\s*"cine",/);
  });

  it("tokens.css declares --t-* and --e-* but never --t-loop", () => {
    const css = readFileSync(join(DASH_SRC, "styles", "tokens.css"), "utf-8");
    for (const token of [
      "--t-instant",
      "--t-quick",
      "--t-std",
      "--t-slow",
      "--t-cine",
      "--e-linear",
      "--e-std",
      "--e-spring",
      "--e-step",
    ]) {
      expect(css, `tokens.css is missing ${token}`).toContain(`${token}:`);
    }
    expect(css).not.toContain("--t-loop:");
  });
});
