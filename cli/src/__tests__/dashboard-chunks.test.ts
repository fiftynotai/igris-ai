/**
 * TD-347 — the dashboard bundle's TWO executable byte ceilings.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Before TD-347 the dashboard's chunk budget was enforced by ONE thing:
 * `dashboard/vite.config.ts`'s `chunkSizeWarningLimit`. That is a build-time
 * WARNING. `cli/scripts/build-dashboard.sh` runs `vite build` and exits 0
 * whether it fires or not, and nothing under `src/__tests__/**` asserted a chunk
 * size at all — so for six briefs the "chunk gate" was a line of yellow text
 * that a scrolling reader could miss and a CI job could not fail on.
 *
 * A warning cannot go red. This file can, and it is the authoritative chunk
 * gate from TD-347 forward. `chunkSizeWarningLimit` is KEPT as a loud
 * always-visible surprise detector on the largest single chunk, re-aimed
 * downward so it is capable of firing again — it is not the gate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT "THE INITIAL SET" IS, AND WHY IT IS NOT THE ENTRY FILE
 * ─────────────────────────────────────────────────────────────────────────────
 *   INITIAL SET = the `<script type="module" src>` in `dist/dashboard/index.html`
 *                 PLUS every `<link rel="modulepreload" href>` in it.
 *
 * That is exactly the set of JavaScript the browser downloads before it can
 * paint: Vite emits a `modulepreload` link for the entry's whole STATIC-import
 * closure, so the closure is readable off the document rather than inferred
 * from a module graph.
 *
 * Measuring the ENTRY FILE alone — or the largest chunk, which is what
 * `chunkSizeWarningLimit` does — is a metric that can be gamed without moving a
 * single byte off the critical path.
 * A vendor `build.rollupOptions.output.manualChunks` split moves React out of
 * the entry FILE, shrinks the headline, and barely moves the initial LOAD,
 * because the browser still has to fetch the vendor chunk before it can run the
 * entry. TD-347 demonstrated exactly that on purpose (plant C), and these are
 * the MEASURED figures rather than the plan's estimate:
 *
 *   entry FILE   285_390 -> 95_394 B   (-189_996)
 *   initial SET  285_390 -> 285_047 B  (-343, now spread over two files)
 *
 * The gate stayed GREEN, correctly. `initialSet()` reads the modulepreload links
 * precisely so that trick is refused.
 *
 * (An earlier draft of this paragraph carried the PLAN's hypothesis — "~145 KB"
 * and "by zero". Both were wrong: 190 KB, and 343 B rather than 0. Recorded
 * because this file states the ledger's re-derivation rule and then broke it.)
 *
 * NOTE THE FORM: under Vite 8 / rolldown the OBJECT form
 * `manualChunks: { react: [...] }` throws `TypeError: manualChunks is not a
 * function`. Plant C used the function form.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE ARE TWO CEILINGS AND NOT ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * `INITIAL_JS_CEILING` alone would make `React.lazy` a way to spend infinite
 * bytes: move the bulk behind a lazy boundary and the initial set never notices.
 * That is "the thing it measured moved elsewhere", the defect class this repo
 * keeps filing, and TD-347's plant B is its recorded demonstration — bulk
 * imported ONLY from `pages/Graph.tsx` left the initial assertion GREEN and was
 * caught by `TOTAL_JS_CEILING` alone.
 *
 * The third assertion (a non-initial chunk EXISTS) names the cause of a future
 * un-split. It is partly self-enforcing — un-splitting also busts the initial
 * ceiling — but a failure that says "the app is one chunk again" is worth more
 * than a failure that says "the initial set is 559 KB".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DERIVATION OF THE TWO CONSTANTS — RE-DERIVE, DO NOT GUESS
 * ─────────────────────────────────────────────────────────────────────────────
 *   INITIAL_JS_CEILING = measured_initial_after_TD-347 + HEADROOM
 *   TOTAL_JS_CEILING   = measured_total_after_TD-347   + HEADROOM
 *
 * `HEADROOM` is a round 24_000 B, chosen as ≈ FOUR briefs at FR-247's measured
 * 5_899 B of chunk spend (4 x 5_899 = 23_596; the constant is the round number
 * ABOVE it, and saying so beats implying the multiplication produced it).
 * FR-247 is the largest single-brief chunk figure **in this ledger**
 * (FR-246 spent 3_654 B, BR-085 132 B, FR-250 0 B). The divisor is stated so the
 * next planner can re-derive the ceiling from a new measurement rather than
 * inherit a round number nobody can explain.
 *
 * SAY WHAT THAT SUPERLATIVE IS SCOPED TO, because unscoped it is misleading:
 * `tarball.test.ts`'s ledger only starts recording CHUNK deltas at FR-246, and
 * the repo contains a much larger out-of-ledger counterexample. `vite.config.ts`'s
 * own comment history puts the chunk at ~477 KB after FR-239 and 524.69 KB after
 * FR-240 — roughly **+47_700 B in a single brief, about 8x FR-247's figure**. One
 * FR-240-shaped brief busts either ceiling outright.
 *
 * That is deliberately NOT a reason to widen HEADROOM. The error runs in the SAFE
 * direction: too little headroom yields a red test and a forced conversation,
 * which is exactly what "raise neither ceiling to make room" exists to produce. A
 * headroom sized for the worst brief ever recorded would absorb that brief
 * silently, which is the failure mode worth avoiding. Recorded here so the next
 * planner meets the ceiling with the counterexample already in hand rather than
 * discovering it at the moment they want to argue the number up.
 * (Found by sentinel during TD-347's own validation — the superlative was true as
 * scoped and read as absolute.)
 *
 * MEASURED AT TD-347 (`bash cli/scripts/build-dashboard.sh` prints both figures
 * on every run, so this is re-derivable rather than remembered):
 *
 *   initial set    285_390 B over 1 file    assets/index-<hash>.js
 *   total JS       562_923 B over 7 chunks
 *   deferred       277_533 B off the critical path over 6 chunks
 *   ceilings       309_390 B initial   (285_390 + 24_000)
 *                  586_923 B total     (562_923 + 24_000)
 *
 * Every subtraction re-derived from the two operands beside it, per the
 * ledger's own rule — a delta carries no copy of either operand, so a
 * class-grep for a value walks straight past a stale difference:
 *   309_390 - 285_390 = 24_000    (the initial headroom)
 *   586_923 - 562_923 = 24_000    (the total headroom)
 *   559_516 - 285_390 = 274_126   (off the critical path vs the pre-split chunk)
 *   562_923 - 559_516 =   3_407   (what the split COST in total bytes: the
 *                                  per-chunk preload plumbing and runtime)
 *   300_000 - 285_390 =  14_610   (slack against `chunkSizeWarningLimit`, which
 *                                  is deliberately TIGHTER than this gate so the
 *                                  build warns before the test reddens)
 *
 * ONE HONEST NOTE ABOUT THE MODULEPRELOAD HALF. At TD-347 the built
 * `index.html` carries NO `<link rel="modulepreload">`, because every shared
 * chunk here is reached only from ASYNC chunks — so today the initial set
 * happens to EQUAL the entry file, and a reader could conclude that half of
 * `initialSet()` is dead code. It is not — see the plant-C reading in
 * `tarball.test.ts`'s TD-347 ledger row, where a vendor `manualChunks` split
 * makes Vite emit the preload link and the two figures separate. The link
 * reader is what makes the metric a LOAD rather than a FILE, and the day it
 * starts matching is exactly the day it is load-bearing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMPOSITION — WHICH CHUNK IS YOUR CHANGE CHARGED AGAINST
 * ─────────────────────────────────────────────────────────────────────────────
 * (`DASH_BUNDLE_REPORT=1 bash cli/scripts/build-dashboard.sh` re-derives this
 * into `dist/dashboard/.bundle-report.json`. The full table with per-package
 * bytes is in `tarball.test.ts`'s TD-347 ledger row.)
 *
 *   chunk            on disk   route it serves   what it is charged for
 *   ───────────────  ────────  ────────────────  ────────────────────────────
 *   index-<hash>     285_689   INITIAL / every   react-dom (459_831 rendered),
 *                                                gsap (153_215 — see below),
 *                                                react, scheduler, `App.tsx`,
 *                                                `router.tsx`, `main.tsx`,
 *                                                `layers/model.ts`,
 *                                                `components/chrome/**`,
 *                                                `components/ui/**`, `lib/**`,
 *                                                `pages/Overview.tsx`
 *   Graph-<hash>     206_455   #/graph           `pages/Graph.tsx`, `graph/**`,
 *                                                and the WHOLE force-graph + d3
 *                                                family: force-graph, bezier-js,
 *                                                tinycolor2, @tweenjs/tween.js,
 *                                                every d3-*, kapsule,
 *                                                float-tooltip + its preact,
 *                                                canvas-color-tracker,
 *                                                accessor-fn, index-array-by
 *   Search-<hash>      7_364   #/search          FR-248: `pages/Search.tsx`,
 *                                                `search/model.ts`
 *   SearchReadout-<h>  6_181   layers + triage   FR-248 re-partition: Rollup
 *                                + search        moved `components/record/**`
 *                                                (`RecordList`, `FilterBar`,
 *                                                `SearchReadout`) OUT of
 *                                                `useQFilter` when `#/search`
 *                                                became a THIRD async importer.
 *                                                Nothing duplicated; the sharing
 *                                                set changed, so the partition
 *                                                did. Net +948 B for the split.
 *                                                `15d-search` asserts the search
 *                                                route fetches THIS and NOT
 *                                                `useQFilter`.
 *   Layers-<hash>      46_789   #/layers          `pages/Layers.tsx`,
 *                                                `pages/layers/**`,
 *                                                `markdown/**`
 *   Triage-<hash>     12_721   #/triage          `pages/Triage.tsx`
 *   useQFilter-<h>     6_707   layers + triage   `triage/**` + the layer hooks
 *                                                + `ui/Badge` — SHARED between
 *                                                two async chunks, so Rollup
 *                                                hoisted it and Vite fetches it
 *                                                in PARALLEL with the route
 *                                                chunk, not after it. SHRANK
 *                                                11_448 -> 6_215 at FR-248 when
 *                                                `components/record/**` left for
 *                                                `SearchReadout-<h>` (above).
 *                                                A row that still said
 *                                                "`components/record/**`" would
 *                                                send the next author to the
 *                                                wrong chunk. GREW again at
 *                                                FR-249 (6_215 -> 6_707), which
 *                                                is where `triage/**` living
 *                                                here becomes visible: the
 *                                                create builder and the third
 *                                                `useTriage` wrapper are charged
 *                                                to THIS chunk, not to `Layers`,
 *                                                even though the only surface
 *                                                that renders them is a briefs
 *                                                page. Layers took 45_577 ->
 *                                                46_789 for the form itself.
 *   neighbours-<h>     1_036   graph + layers    `graph/neighbours.ts`,
 *                                                `lib/graphCache.ts`
 *   Button-<hash>        380   graph + layers    `components/ui/Button.tsx`
 *                                + triage         (THREE routes — importers are
 *                                                 `pages/layers/Briefs.tsx`,
 *                                                 `components/triage/BulkBar.tsx`
 *                                                 AND `components/graph/
 *                                                 GraphControls.tsx`. An earlier
 *                                                 draft of this row said
 *                                                 "layers + triage"; `15d-graph`
 *                                                 enumerates Button among the
 *                                                 graph route's chunks and the
 *                                                 two disagreed. Re-derive this
 *                                                 column by grepping importers,
 *                                                 never from the group table.)
 *
 * SO: a change to `pages/layers/**`, `components/record/**` or `markdown/**` is
 * charged to a LAZY chunk and to `TOTAL_JS_CEILING` only. A change to
 * `App.tsx`, `router.tsx`, `components/chrome/**`, `lib/**`, `layers/model.ts`
 * or `pages/Overview.tsx` is charged to the INITIAL set and therefore to BOTH
 * ceilings.
 *
 * `components/ui/**` IS NOT WHOLESALE EAGER — read the table. Most of it is in
 * the initial set, but `ui/Button.tsx` is shared by three LAZY routes and no
 * eager one, so Rollup hoisted it into its own deferred `Button-<hash>` chunk.
 * A change to `ui/Button.tsx` is charged to `TOTAL_JS_CEILING` only. The
 * enumeration above is a shorthand; the table is the authority.
 *
 * `gsap` IS NOT PART OF THIS WIN, and saying so is the point of putting it in
 * the table. `components/chrome/Cursor.tsx` is a SHELL component and imports
 * it, so gsap is eager whatever happens to the routes. It is the largest
 * non-React eager item and it is the next planner's candidate; removing it is a
 * behaviour change, which is why TD-347 (a delivery-only brief) left it alone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RAISE NEITHER CEILING TO MAKE ROOM
 * ─────────────────────────────────────────────────────────────────────────────
 * The TD-329 discipline applies to both: that raise was an OPERATOR decision
 * with a named date, taken BEFORE the work that needed it and with the estimate
 * on the record — not a response to a failing assertion. If a brief does not
 * fit, it cuts scope, vendors less, or lazies another surface. A ceiling raised
 * to make a red test green measures nothing afterwards.
 *
 * If you DO make a route eager or lazy, you must re-measure BOTH constants,
 * re-run `node cli/scripts/browser-gate.mjs` unfiltered (G-BR-15 is the
 * behavioural twin of these numbers — it asserts what is fetched WHEN), and
 * update the composition table above in the same commit.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLE = join(CLI_ROOT, "dist", "dashboard");
const INDEX = join(BUNDLE, "index.html");
const ASSETS = join(BUNDLE, "assets");

/**
 * See the derivation block in this file's header. RAISE NEITHER TO MAKE ROOM.
 *
 * The operands are written as `measured + HEADROOM` rather than as a single
 * literal on purpose: the measurement and the allowance are two different
 * decisions, and collapsing them into one number is how a later brief widens
 * the allowance while appearing to record a new measurement.
 */
const HEADROOM = 24_000;
const MEASURED_INITIAL = 285_390;
const MEASURED_TOTAL = 562_923;
const INITIAL_JS_CEILING = MEASURED_INITIAL + HEADROOM;
const TOTAL_JS_CEILING = MEASURED_TOTAL + HEADROOM;

const REMEASURE = "re-measure with `bash cli/scripts/build-dashboard.sh` (it prints both figures)";

interface Asset {
  /** Bundle-relative, forward-slashed — e.g. `assets/index-DxYX0w9s.js`. */
  rel: string;
  bytes: number;
}

function asset(rel: string): Asset {
  const abs = join(BUNDLE, rel);
  if (!existsSync(abs)) throw new Error(`index.html references a missing asset: ${rel}`);
  return { rel, bytes: statSync(abs).size };
}

/**
 * The JS the browser must have before it can paint.
 *
 * Parsed off the BUILT `index.html` rather than derived from the source module
 * graph, because the document is what the browser actually reads — and because
 * a source-graph derivation would agree with a wrong build.
 *
 * Attribute ORDER is not assumed: Vite emits
 * `<link rel="modulepreload" crossorigin href="...">`, but a Vite upgrade that
 * reorders those attributes must not silently empty this set. Each tag is
 * matched whole and its attributes read individually.
 */
function initialSet(): { files: Asset[]; bytes: number } {
  const html = readFileSync(INDEX, "utf-8");
  const attr = (tag: string, name: string): string | null => {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
    return m === null ? null : m[1];
  };
  const rels: string[] = [];

  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0];
    if ((attr(tag, "type") ?? "").toLowerCase() !== "module") continue;
    const src = attr(tag, "src");
    if (src !== null && src.trim() !== "") rels.push(src);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if ((attr(tag, "rel") ?? "").toLowerCase() !== "modulepreload") continue;
    const href = attr(tag, "href");
    if (href !== null && href.trim() !== "") rels.push(href);
  }

  const files = [...new Set(rels.map((r) => r.replace(/^\.?\//, "")))].map(asset);
  return { files, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}

/** Every emitted JS asset, initial or not. */
function allJs(): { files: Asset[]; bytes: number } {
  // Each `it` is independent, so the first one's REMEASURE guidance is not
  // guaranteed to be the message a developer sees — a bare ENOENT out of
  // `readdirSync` would be. Fail with the same actionable line instead.
  if (!existsSync(ASSETS)) {
    throw new Error(
      `No built dashboard at ${ASSETS}. Run: bash cli/scripts/build-dashboard.sh ` +
        `(NEVER \`npm run build\` in cli/ — that is a live deploy).`,
    );
  }
  const files = readdirSync(ASSETS)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => asset(`assets/${f}`));
  return { files, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}

const breakdown = (files: Asset[]): string =>
  files.map((f) => `    ${String(f.bytes).padStart(8)}  ${f.rel}`).join("\n");

describe("TD-347 — the dashboard bundle's byte ceilings", () => {
  it("the bundle is built (these assertions read the ARTIFACT, never the source)", () => {
    expect(existsSync(INDEX), `no bundle at ${BUNDLE} — ${REMEASURE}`).toBe(true);
    expect(existsSync(ASSETS), `no assets dir at ${ASSETS} — ${REMEASURE}`).toBe(true);
  });

  /**
   * Catches: eager growth, an accidental STATIC import of a lazy page (which
   * pulls its whole subtree back into the entry's preload closure), a route
   * re-eagered, and a `manualChunks` vendor split that only moves the headline.
   */
  it("the INITIAL SET is under INITIAL_JS_CEILING", () => {
    const initial = initialSet();
    expect(
      initial.files.length,
      `index.html referenced NO module script — the parser or the build shape changed. ${REMEASURE}`,
    ).toBeGreaterThan(0);
    expect(
      initial.bytes,
      `INITIAL SET is ${initial.bytes} B over ${initial.files.length} file(s), ceiling ${INITIAL_JS_CEILING} B ` +
        `(over by ${initial.bytes - INITIAL_JS_CEILING} B):\n${breakdown(initial.files)}\n` +
        `  The initial set is index.html's module <script> plus every <link rel="modulepreload"> — ` +
        `i.e. what the browser fetches before it can paint, NOT the entry file alone.\n` +
        `  DO NOT RAISE THE CEILING. Lazy another route, cut scope, or vendor less. ${REMEASURE}.`,
    ).toBeLessThanOrEqual(INITIAL_JS_CEILING);
  });

  /**
   * Catches "the thing it measured moved elsewhere" — unbounded growth hidden
   * behind a lazy boundary. Without this half, `React.lazy` is a way to spend
   * infinite bytes while the initial ceiling stays green forever.
   */
  it("TOTAL JS across every chunk is under TOTAL_JS_CEILING", () => {
    const all = allJs();
    expect(
      all.bytes,
      `TOTAL JS is ${all.bytes} B over ${all.files.length} chunk(s), ceiling ${TOTAL_JS_CEILING} B ` +
        `(over by ${all.bytes - TOTAL_JS_CEILING} B):\n${breakdown(all.files)}\n` +
        `  A lazy boundary defers bytes; it does not make them free. ` +
        `DO NOT RAISE THE CEILING. ${REMEASURE}.`,
    ).toBeLessThanOrEqual(TOTAL_JS_CEILING);
  });

  /**
   * Names the cause when someone un-splits the app back to one chunk. The
   * initial ceiling would catch that too, but it would report a byte count
   * rather than the reason for it.
   */
  it("at least one JS chunk is NOT in the initial set (the app is still split)", () => {
    const initial = new Set(initialSet().files.map((f) => f.rel));
    const deferred = allJs().files.filter((f) => !initial.has(f.rel));
    expect(
      deferred.map((f) => f.rel),
      `every emitted JS chunk is in the INITIAL SET — the route split is gone, and every route's ` +
        `code is back on the critical path.\n  initial: ${[...initial].join(", ")}\n` +
        `  Restore the \`React.lazy\` boundaries in dashboard/src/App.tsx. ${REMEASURE}.`,
    ).not.toEqual([]);
  });

  /**
   * NOT a ceiling — a printed reading, so a green run still states the two
   * numbers the ledger quotes. `expect` on a tautology would be a vacuous
   * assertion; this deliberately asserts nothing and prints instead.
   */
  it("records the measured figures", () => {
    const initial = initialSet();
    const all = allJs();
    const deferred = all.files.filter((f) => !initial.files.some((i) => i.rel === f.rel));
    process.stdout.write(
      `\nTD-347 chunk ledger\n` +
        `  INITIAL SET  ${initial.bytes} B over ${initial.files.length} file(s), ceiling ${INITIAL_JS_CEILING} B ` +
        `(${INITIAL_JS_CEILING - initial.bytes} B of slack)\n${breakdown(initial.files)}\n` +
        `  TOTAL JS     ${all.bytes} B over ${all.files.length} chunk(s), ceiling ${TOTAL_JS_CEILING} B ` +
        `(${TOTAL_JS_CEILING - all.bytes} B of slack)\n${breakdown(all.files)}\n` +
        `  DEFERRED     ${deferred.length} chunk(s), ${deferred.reduce((n, f) => n + f.bytes, 0)} B off the critical path\n`,
    );
    expect(initial.files.length + all.files.length).toBeGreaterThan(0);
  });
});
