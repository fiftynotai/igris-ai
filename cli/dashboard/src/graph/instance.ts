/**
 * FR-239 — **the only file that exercises the `force-graph` API.**
 *
 * That is a rule, not a description, and `dashboard-graph-source.test.ts`
 * enforces it mechanically (T8). The reason is F3: the library owns the risky
 * 40% — force integration, camera, drag, resize, hit-testing — and we own every
 * painted pixel. Keeping the seam in one file is what makes "swap the library"
 * a bounded change rather than an archaeology project, and it is the residual
 * insurance on an operator override that traded a structural stillness
 * guarantee for less code to maintain.
 *
 * WHY THE SEAM IS TWO FILES AND NOT ONE, MEASURED NOT ASSUMED
 * ------------------------------------------------------------
 * `force-graph` dereferences `window` at IMPORT time (verified: a bare
 * `import('force-graph')` under node throws `window is not defined`). This
 * file's state machine is the AC-#5 mechanism, so it must be reachable by the
 * node-environment vitest run — which means this file cannot import the
 * library. The `new ForceGraph(...)` call therefore lives alone in
 * `instance-factory.ts`, which is one line long and is the only module in the
 * app that imports the package.
 *
 * The split is narrower than it looks: `instance-factory.ts` performs a TYPED
 * cast to `ForceGraphLike`, so if the real API drifts from the interface below
 * the build fails there. And an untestable pause/resume machine would be a much
 * worse trade than a two-file seam — the whole point of this brief's third
 * layer of AC-#5 defence is that our code cannot silently reintroduce motion.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE STILLNESS STATE MACHINE — AC #5's mechanism
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   mount ──▶ SETTLING ──(onEngineStop)──▶ STILL ◀──┐
 *                                            │      │
 *                                   beginInteraction│      │endInteraction
 *                                            ▼      │
 *                                        INTERACTING ┘
 *
 * - **SETTLING.** `cooldownTime = // CINE`. The live simulation *is* the
 *   entrance — the token is the mechanism, not a decoration. Fires ONCE per
 *   mount; it never re-fires on a filter or a re-layout.
 * - **STILL.** `onEngineStop` -> `pauseAnimation()`. The render loop halts
 *   outright. This is the closest any candidate library got to the guarantee
 *   the override gave up, and it is why `force-graph` won D1.
 * - **INTERACTING.** `resumeAnimation()` on interaction ENTRY only, refcounted,
 *   with an automatic re-pause when the last interaction ends. Refcounted
 *   because a hover can start while a filter tween is still running, and a
 *   naive pause-on-complete would freeze the canvas mid-tween.
 *
 * Under `prefers-reduced-motion` the layout converges BEFORE first paint
 * (`warmupTicks = N`, `cooldownTicks = 0`) and the settled state appears with
 * no journey. That is the reduced-motion contract satisfied by configuration
 * rather than by a disabled animation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS NO LONGER PROVES, STATED PLAINLY
 * ─────────────────────────────────────────────────────────────────────────
 * `pauseAnimation()` is an explicit library API for exactly this, and the
 * structural checks below (pause wired to `onEngineStop`, zero `rAF` sites in
 * our code, the API confined to this file) are real. They guard OUR code
 * against reintroducing motion. They do **not** prove the library is still —
 * its internals are outside our reach. Stillness is established empirically by
 * `stillness.ts` and the operator checkpoint in `docs/dashboard.md`, and the
 * checkpoint requires a recorded FAILURE (the negative control) alongside the
 * pass. Nothing here should be read as more than it is.
 */

import type { GraphEdge, GraphNode } from "../lib/api";
import type { Camera } from "./motion";

/** A node as the simulation sees it — our fields plus the library's mutables. */
export interface GraphDatum extends GraphNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
}

/** A link as the simulation sees it. `source`/`target` are the library's names. */
export interface LinkDatum extends GraphEdge {
  source: string | GraphDatum;
  target: string | GraphDatum;
}

/**
 * The subset of `force-graph`'s API this file uses.
 *
 * Declared structurally so `instance.test.ts` can drive the whole state machine
 * over a stub with no DOM and no canvas. Every method here is one the real
 * library provides; nothing is invented.
 */
export interface ForceGraphLike {
  graphData(data: { nodes: GraphDatum[]; links: LinkDatum[] }): ForceGraphLike;
  nodeId(id: string): ForceGraphLike;
  linkSource(s: string): ForceGraphLike;
  linkTarget(t: string): ForceGraphLike;
  width(w: number): ForceGraphLike;
  height(h: number): ForceGraphLike;
  backgroundColor(c: string): ForceGraphLike;
  nodeRelSize(n: number): ForceGraphLike;
  nodeCanvasObject(
    fn: (n: GraphDatum, ctx: CanvasRenderingContext2D, scale: number) => void,
  ): ForceGraphLike;
  nodePointerAreaPaint(
    fn: (
      n: GraphDatum,
      colour: string,
      ctx: CanvasRenderingContext2D,
      scale: number,
    ) => void,
  ): ForceGraphLike;
  nodeLabel(fn: (n: GraphDatum) => string): ForceGraphLike;
  linkLabel(fn: (l: LinkDatum) => string): ForceGraphLike;
  linkColor(fn: (l: LinkDatum) => string): ForceGraphLike;
  linkWidth(fn: (l: LinkDatum) => number): ForceGraphLike;
  linkLineDash(fn: (l: LinkDatum) => number[] | null): ForceGraphLike;
  linkDirectionalArrowLength(fn: (l: LinkDatum) => number): ForceGraphLike;
  linkDirectionalArrowRelPos(p: number): ForceGraphLike;
  onRenderFramePost(
    fn: (ctx: CanvasRenderingContext2D, scale: number) => void,
  ): ForceGraphLike;
  onNodeHover(fn: (n: GraphDatum | null) => void): ForceGraphLike;
  onNodeClick(fn: (n: GraphDatum) => void): ForceGraphLike;
  onBackgroundClick(fn: () => void): ForceGraphLike;
  /**
   * Zoom and drag callbacks. These fire from d3-zoom / d3-drag DOM handlers,
   * which run OUTSIDE the render loop — so unlike `onNodeHover`, they still
   * arrive while the loop is halted and are therefore valid wake-up paths.
   * They were absent from this interface entirely until the C1 fix, which is
   * why there was no seam to wire them through.
   */
  onZoom(fn: () => void): ForceGraphLike;
  onZoomEnd(fn: () => void): ForceGraphLike;
  onNodeDrag(fn: () => void): ForceGraphLike;
  onNodeDragEnd(fn: () => void): ForceGraphLike;
  onEngineStop(fn: () => void): ForceGraphLike;
  cooldownTime(ms: number): ForceGraphLike;
  cooldownTicks(n: number): ForceGraphLike;
  warmupTicks(n: number): ForceGraphLike;
  d3AlphaDecay(n: number): ForceGraphLike;
  d3VelocityDecay(n: number): ForceGraphLike;
  enableNodeDrag(on: boolean): ForceGraphLike;
  autoPauseRedraw(on: boolean): ForceGraphLike;
  pauseAnimation(): ForceGraphLike;
  resumeAnimation(): ForceGraphLike;
  centerAt(): { x: number; y: number };
  centerAt(x: number, y: number): ForceGraphLike;
  zoom(): number;
  zoom(k: number): ForceGraphLike;
  zoomToFit(ms?: number, px?: number): ForceGraphLike;
  screen2GraphCoords(x: number, y: number): { x: number; y: number };
  graph2ScreenCoords(x: number, y: number): { x: number; y: number };
  _destructor(): void;
}

export type ForceGraphFactory = (el: HTMLElement) => ForceGraphLike;

/**
 * The DOM events that may wake a halted canvas.
 *
 * `pointerenter` matters as much as `pointermove`: a pointer that enters and
 * clicks without moving must still wake the loop in time for the library to
 * compute `hoverObj` before `pointerup` reads it.
 */
export const POINTER_WAKE_EVENTS = [
  "pointerenter",
  "pointermove",
  "pointerdown",
  "pointerup",
  "pointerleave",
  "wheel",
] as const;

/**
 * Attach the interaction boundary to a DOM element. Returns its own detacher.
 *
 * **This function is the C1 fix.** It is a named, exported, independently
 * testable unit rather than an inline block inside a React effect, and that is
 * deliberate: as an inline block it could be deleted wholesale with every test
 * still green, because the tests drove `controller.pointerActivity()` directly
 * and nothing asserted that anything ever CALLED it from a DOM event.
 *
 * The behavioural test dispatches a real `Event` at a real `EventTarget` and
 * asserts the instance resumed — which fails if this wiring ever moves back to
 * a library callback, because a library callback does not fire from an element
 * event.
 *
 * `passive: true` — none of these ever call `preventDefault`; the library's own
 * d3-zoom handler owns wheel behaviour.
 */
export function attachPointerBoundary(
  el: Pick<HTMLElement, "addEventListener" | "removeEventListener">,
  controller: Pick<GraphController, "pointerActivity">,
): () => void {
  const onActivity = (): void => controller.pointerActivity();
  for (const type of POINTER_WAKE_EVENTS) {
    el.addEventListener(type, onActivity, { passive: true });
  }
  return () => {
    for (const type of POINTER_WAKE_EVENTS) {
      el.removeEventListener(type, onActivity);
    }
  };
}

export type LoopState = "settling" | "still" | "interacting";

/** Everything the paint accessors need, re-read per frame from live state. */
export interface PaintHooks {
  drawNode: (
    node: GraphDatum,
    ctx: CanvasRenderingContext2D,
    scale: number,
  ) => void;
  paintPointerArea: (
    node: GraphDatum,
    colour: string,
    ctx: CanvasRenderingContext2D,
    scale: number,
  ) => void;
  linkColor: (link: LinkDatum) => string;
  linkWidth: (link: LinkDatum) => number;
  linkLineDash: (link: LinkDatum) => number[] | null;
  linkArrowLength: (link: LinkDatum) => number;
  /** Labels are drawn AFTER the graph so they sit above every glyph. */
  drawOverlay: (ctx: CanvasRenderingContext2D, scale: number) => void;
}

export interface GraphInstanceOptions {
  container: HTMLElement;
  paint: PaintHooks;
  /**
   * The entrance duration in ms — `// CINE` on first mount, `// SLOW` for a
   * drill-down (a subgraph swap is a page transition, not a second entrance).
   * Passed in so every token stays resolved in one file.
   */
  entranceMs: number;
  /**
   * How long after the last pointer event the canvas is considered idle and
   * re-pauses. A debounce, not an animation — but it is still a timing on the
   * canvas, so it is expressed as a `motion.md` token by its caller rather than
   * as a free number.
   */
  pointerIdleMs: number;
  reducedMotion: boolean;
  onHover: (node: GraphDatum | null) => void;
  onSelect: (node: GraphDatum | null) => void;
  /** Fires when the entrance settles. The AC-#5 checkpoint's starting gun. */
  onSettled?: () => void;
  /**
   * How to construct the library instance.
   *
   * REQUIRED, with no default, precisely so this module has no import edge to
   * `force-graph`. `useGraph.ts` passes `forceGraphFactory` from
   * `instance-factory.ts`; `instance.test.ts` passes a stub.
   */
  factory: ForceGraphFactory;
}

export interface GraphController {
  /** Replace the node/edge set. A drill-down, not a re-entrance. */
  setData: (
    nodes: readonly GraphNode[],
    edges: readonly GraphEdge[],
    seed?: PositionCache,
  ) => void;
  /** The instantaneous camera. F2 — there is no timed variant anywhere. */
  camera: Camera;
  /** Refcounted. Resumes the render loop on the FIRST concurrent interaction. */
  beginInteraction: () => void;
  /** Refcounted. Re-pauses when the LAST concurrent interaction ends. */
  endInteraction: () => void;
  /**
   * **The wake-up path (C1).** Call from a DOM listener on the container.
   *
   * Latched and idle-debounced, so a stream of `pointermove`s costs one
   * refcount slot. This exists because hit-testing, hover dispatch and the
   * shadow-canvas refresh all live INSIDE the render loop — so once the loop
   * is halted no library callback can ever restart it. The boundary must come
   * from outside.
   */
  pointerActivity: () => void;
  /** Current loop state — what `instance.test.ts` asserts against. */
  state: () => LoopState;
  /** Live snapshot of every node's settled position, for D6's back-out. */
  positions: () => PositionCache;
  /** The rendered canvas, for the AC-#5 probe. `null` before first paint. */
  canvas: () => HTMLCanvasElement | null;
  /** Re-run the layout deliberately. NEVER called on a timer (D8). */
  reheat: () => void;
  resize: (width: number, height: number) => void;
  zoomToFit: () => void;
  destroy: () => void;
}

export type PositionCache = Record<string, { x: number; y: number }>;

/**
 * Ticks run before first paint under reduced motion.
 *
 * Enough for d3-force to converge on a 2,400-node graph, which is what makes
 * "renders its settled state immediately" true rather than "renders a tangle
 * immediately". Not a duration token — it is a simulation step count, and it is
 * never used as a timing.
 */
const PRM_WARMUP_TICKS = 200;

export function createGraphInstance(
  opts: GraphInstanceOptions,
): GraphController {
  const fg = opts.factory(opts.container);

  let loopState: LoopState = "settling";
  let interactions = 0;
  let settledOnce = false;
  let data: { nodes: GraphDatum[]; links: LinkDatum[] } = {
    nodes: [],
    links: [],
  };

  // -------------------------------------------------------------------------
  // Accessor wiring. Every one delegates to a hook that re-reads live state, so
  // a palette swap, a tier change or a filter tween lands on the NEXT PAINT
  // with no re-binding. That is the property that makes AC #3 cheap (D1).
  // -------------------------------------------------------------------------
  fg.nodeId("key")
    .linkSource("from")
    .linkTarget("to")
    // `backgroundColor` sets the canvas ELEMENT's CSS background (verified in
    // the package source — the render loop itself only `clearRect`s). Any real
    // colour here would occlude the container's 24 px GRID-role texture, which
    // is exemption 01's obligation. `transparent` is a CSS-wide keyword, not a
    // colour literal, so it also survives the T13 scan intact.
    .backgroundColor("transparent")
    .nodeRelSize(1)
    .nodeCanvasObject((n, ctx, scale) => opts.paint.drawNode(n, ctx, scale))
    .nodePointerAreaPaint((n, colour, ctx, scale) =>
      opts.paint.paintPointerArea(n, colour, ctx, scale),
    )
    // The library's own tooltip is a stock-styled DOM element with no brand
    // token in it — a `--dataviz-*` role cannot reach it, so it would be the
    // one surviving piece of stock palette (AC #3). Emptied outright; every
    // label on this surface is ours and is painted by `labels.ts`.
    .nodeLabel(() => "")
    .linkLabel(() => "")
    .linkColor((l) => opts.paint.linkColor(l))
    .linkWidth((l) => opts.paint.linkWidth(l))
    .linkLineDash((l) => opts.paint.linkLineDash(l))
    .linkDirectionalArrowLength((l) => opts.paint.linkArrowLength(l))
    .linkDirectionalArrowRelPos(1)
    .onRenderFramePost((ctx, scale) => opts.paint.drawOverlay(ctx, scale))
    .enableNodeDrag(true)
    /*
     * OFF, deliberately — and this was a MEASURED bug, not a precaution.
     *
     * `autoPauseRedraw` (default: on) skips a redraw when the library judges
     * that nothing has changed. It can only judge its OWN props: the node/link
     * arrays and the accessors bound to them. But every visual state this
     * canvas has — hover emphasis, filter progress, the selection ring, and the
     * ACTIVE PALETTE — lives in a mutable object that the accessors read and
     * the library knows nothing about. So the library's answer to "did anything
     * change?" is structurally wrong here: it says no while our state says yes.
     *
     * Caught by the FR-239 end-to-end run: switching `data-palette` resolved
     * all five role tokens correctly in CSS and the canvas kept painting the
     * old palette, byte for byte (`changed: false` on a before/after pixel
     * hash). Hover and filter had the same defect, invisibly.
     *
     * Turning it off costs nothing that matters: the render loop is PAUSED at
     * rest by `pauseAnimation()`, which is the actual AC #5 mechanism, and it
     * only ever runs while an interaction is live — which is exactly when we
     * want every frame repainted.
     */
    .autoPauseRedraw(false);

  // -------------------------------------------------------------------------
  // The entrance, and the halt.
  // -------------------------------------------------------------------------
  if (opts.reducedMotion) {
    // Converge BEFORE first paint, then never animate. motion.md: "content
    // appears in the same order with the same emphasis, only the journey
    // changes."
    fg.warmupTicks(PRM_WARMUP_TICKS).cooldownTicks(0).cooldownTime(0);
  } else {
    // The live simulation IS the entrance. `// CINE`, once per mount.
    fg.cooldownTime(opts.entranceMs);
  }

  /**
   * Halt the render loop — DEFERRED OUT OF THE CURRENT FRAME. This is not
   * defensive tidiness; a direct call does not work, and the reason is worth
   * the paragraph.
   *
   * `force-graph`'s frame callback is shaped like this (verified in the
   * package source, `force-graph.mjs`):
   *
   *     function animate() {
   *       ...
   *       state.forceGraph.tickFrame();        // <- fires onEngineStop()
   *       ...
   *       state.animationFrameRequestId = requestAnimationFrame(animate);
   *     }
   *
   * and `pauseAnimation()` is `cancelAnimationFrame(state.animationFrameRequestId)`.
   *
   * `onEngineStop` therefore fires from INSIDE `animate`, BEFORE the trailing
   * re-arm. Calling `pauseAnimation()` there cancels the id of the frame that
   * has already fired, nulls the field — and then `animate` finishes by
   * scheduling a fresh frame. **The loop never stops.** The same hazard applies
   * to a pause requested from a GSAP `onComplete`, because GSAP's ticker is
   * itself an rAF callback that can run before `animate` in the same frame.
   *
   * MEASURED, not theorised. With a direct call, the FR-239 end-to-end run
   * reported `state: "still"` and a stable pixel hash while a painted-frame
   * counter climbed from 68 to 501 over 17 seconds — ~25 fps of repainting
   * identical pixels. The pixel-diff AC passes in that state, which is exactly
   * the weakness the plan named when the operator chose a library:
   * *"a library that repaints identical pixels forever now passes."* It does.
   * A frame counter is what tells the two apart, so `useGraph` exposes one on
   * the diagnostic and `docs/dashboard.md` makes it part of the checkpoint.
   *
   * `setTimeout(..., 0)` rather than `queueMicrotask`: a macrotask is
   * guaranteed to run after EVERY rAF callback in the frame has completed, so
   * the id it cancels is the one `animate` just armed. The cost is that the
   * loop survives at most one extra frame, which is the honest price.
   */
  let pausePending = false;
  const haltLoop = (): void => {
    if (pausePending) return;
    pausePending = true;
    // Bare `setTimeout`, not `window.setTimeout`: this module is deliberately
    // DOM-free so the node-environment vitest run can drive the whole state
    // machine (see the header). `window` does not exist there.
    setTimeout(() => {
      pausePending = false;
      // An interaction may have started while the halt was in flight; pausing
      // then would freeze a live tween.
      if (interactions > 0) return;
      fg.pauseAnimation();
      loopState = "still";
    }, 0);
  };

  fg.onEngineStop(() => {
    // THE halt. Not a flag, not a throttle — the render loop stops. See above
    // for why it cannot be called straight from here.
    loopState = "still";
    haltLoop();
    if (!settledOnce) {
      settledOnce = true;
      opts.onSettled?.();
    }
  });

  fg.onNodeHover((n) => opts.onHover(n));
  fg.onNodeClick((n) => opts.onSelect(n));
  fg.onBackgroundClick(() => opts.onSelect(null));


  // -------------------------------------------------------------------------
  // The interaction refcount.
  // -------------------------------------------------------------------------
  const beginInteraction = (): void => {
    interactions += 1;
    if (interactions === 1 && loopState === "still") {
      fg.resumeAnimation();
      loopState = "interacting";
    }
  };

  const endInteraction = (): void => {
    if (interactions === 0) return;
    interactions -= 1;
    // Re-pause only when the LAST concurrent interaction ends. A hover that
    // starts mid-filter-tween must not freeze the tween on its own completion.
    if (interactions === 0 && loopState === "interacting") {
      loopState = "still";
      // Deferred for the same reason as the engine-stop halt: this usually runs
      // from a GSAP `onComplete`, and GSAP's ticker is an rAF callback that can
      // run before the library's `animate` in the same frame.
      haltLoop();
    }
  };
  /*
   * ───────────────────────────────────────────────────────────────────────
   * C1 — WHY THE INTERACTION BOUNDARY CANNOT BE A LIBRARY CALLBACK
   * ───────────────────────────────────────────────────────────────────────
   * `pauseAnimation()` is `cancelAnimationFrame`, and the vendored source puts
   * far more than painting inside that loop:
   *
   *   - `getObjUnderPointer()`, the `onNodeHover` dispatch and
   *     `refreshShadowCanvas()` all run INSIDE `animate()`;
   *   - the d3-zoom handler only sets `state.needsRedraw = true`, and
   *     `animate()` is its sole consumer;
   *   - `pointerup` dispatches the click from its own rAF, but reads
   *     `state.hoverObj`, which ONLY `animate()` ever writes.
   *
   * So a halted loop is not a still canvas, it is a DEAD one:
   *
   *   hover  -> `onNodeHover` never fires, so it can never wake the loop
   *   pan    -> transform moves, nothing repaints, view jumps later
   *   drag   -> `fx`/`fy` move, nothing repaints
   *   click  -> `hoverObj` is frozen at null, so `onBackgroundClick` fires and
   *             the canvas DESELECTS instead of selecting
   *
   * The first version of this file used `onNodeHover` as the wake-up path,
   * which is circular: a callback that lives inside the paused loop can never
   * restart it. Every AC #5 reading passed, because a dead canvas is
   * trivially still. The negative control was a PALETTE switch — driven from
   * outside the canvas via a MutationObserver — which is exactly why it kept
   * working and why the deadness went unseen.
   *
   * The boundary therefore has to sit OUTSIDE the loop. `pointerActivity()` is
   * called from real DOM listeners on the container (wired in `useGraph`) and
   * from the zoom/drag callbacks below, which are d3 DOM handlers rather than
   * loop callbacks. It is latched, so a stream of `pointermove`s costs one
   * refcount slot, and it re-pauses after an idle window.
   */
  let pointerAwake = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const pointerActivity = (): void => {
    if (!pointerAwake) {
      pointerAwake = true;
      beginInteraction();
    }
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      pointerAwake = false;
      endInteraction();
    }, opts.pointerIdleMs);
  };

  // d3-zoom and d3-drag fire from DOM handlers, not from inside `animate`, so
  // these still arrive while the loop is halted. Routed through the same latch
  // so a continuous gesture costs one refcount slot, not one per event.
  fg.onZoom(() => pointerActivity())
    .onZoomEnd(() => pointerActivity())
    .onNodeDrag(() => pointerActivity())
    .onNodeDragEnd(() => pointerActivity());

  // -------------------------------------------------------------------------
  // The camera. INSTANTANEOUS ONLY — see F2 in `motion.ts`.
  //
  // `centerAt` and `zoom` are called here with at most TWO and ONE argument
  // respectively. A third argument would hand the move to the library's own
  // easing, which is not one of motion.md's four. T8 scans for it.
  // -------------------------------------------------------------------------
  const camera: Camera = {
    centre: () => fg.centerAt(),
    setCentre: (x, y) => {
      fg.centerAt(x, y);
    },
    scale: () => fg.zoom(),
    setScale: (k) => {
      fg.zoom(k);
    },
  };

  const setData: GraphController["setData"] = (nodes, edges, seed) => {
    const byKey = new Set(nodes.map((n) => n.key));
    const next: GraphDatum[] = nodes.map((n) => {
      const at = seed?.[n.key];
      // Seeding from the previous layout is what makes a drill-down a PAGE
      // TRANSITION rather than a second entrance (D6): nodes that were already
      // on screen stay where the reader last saw them.
      return at === undefined ? { ...n } : { ...n, x: at.x, y: at.y };
    });
    const links: LinkDatum[] = edges
      // The builder can only emit edges whose endpoints it also emitted, but a
      // client-side filter can narrow `nodes`. Dropping a dangling link is
      // correct; handing one to d3-force throws.
      .filter((e) => byKey.has(e.from) && byKey.has(e.to))
      .map((e) => ({ ...e, source: e.from, target: e.to }));
    data = { nodes: next, links };
    fg.graphData(data);
  };

  const positions = (): PositionCache => {
    const out: PositionCache = {};
    for (const n of data.nodes) {
      if (typeof n.x === "number" && typeof n.y === "number") {
        out[n.key] = { x: n.x, y: n.y };
      }
    }
    return out;
  };

  return {
    setData,
    camera,
    beginInteraction,
    endInteraction,
    pointerActivity,
    state: () => loopState,
    positions,
    canvas: () => opts.container.querySelector("canvas"),
    reheat: () => {
      // A DELIBERATE re-layout, only ever from an explicit user action. D8:
      // there is no timer anywhere that can reach this. A `live.tick`-driven
      // reheat would be ambient motion dressed as freshness — and with a
      // library we cannot prove is still, exactly the failure AC #5 exists to
      // catch.
      loopState = "settling";
      fg.cooldownTime(opts.reducedMotion ? 0 : opts.entranceMs);
      fg.resumeAnimation();
    },
    resize: (width, height) => {
      fg.width(width).height(height);
    },
    zoomToFit: () => {
      // No duration argument — the untimed form fits instantly. A timed fit
      // would be the library's easing, which is F2's whole problem.
      fg.zoomToFit();
    },
    destroy: () => {
      // A pending idle timer holds a closure over the instance; firing it after
      // teardown would call into a destroyed graph.
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      fg.pauseAnimation();
      fg._destructor();
    },
  };
}
