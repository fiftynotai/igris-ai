/**
 * FR-239 (T7, T10) — the pause/resume state machine and layout determinism.
 *
 * These assertions guard **our** code against reintroducing motion. They do not
 * — and this file does not pretend they do — prove the library is still; its
 * internals are outside our reach. Stillness is established empirically by
 * `stillness.test.ts` (the instrument) and by the operator checkpoint with its
 * mandatory negative control (`docs/dashboard.md`). What this file proves is
 * narrower and still worth having: that `pauseAnimation()` is wired to
 * `onEngineStop`, that `resumeAnimation()` is reachable ONLY from an
 * interaction entry, and that the last interaction to finish re-pauses.
 *
 * The stub below is why `instance.ts` takes its factory as a parameter: the
 * real package dereferences `window` at import time, so a node-environment test
 * could not reach the state machine at all if the import lived there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  POINTER_WAKE_EVENTS,
  attachPointerBoundary,
  createGraphInstance,
  type ForceGraphLike,
  type GraphController,
  type GraphDatum,
  type LinkDatum,
} from "../instance.js";
import type { GraphEdge, GraphNode } from "../../lib/api.js";

/**
 * The pause is deferred by one macrotask (see `instance.ts#haltLoop`), so every
 * assertion about it has to cross a task boundary first.
 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Records every call, and lets the test fire `onEngineStop` by hand. */
interface Stub extends ForceGraphLike {
  calls: string[];
  fireEngineStop: () => void;
  fireNodeClick: (n: GraphDatum) => void;
  fireBackgroundClick: () => void;
  fireZoom: () => void;
  fireNodeDrag: () => void;
  data: { nodes: GraphDatum[]; links: LinkDatum[] } | null;
  centre: { x: number; y: number };
  scaleValue: number;
}

function makeStub(): Stub {
  let engineStop: () => void = () => undefined;
  let nodeClick: (n: GraphDatum) => void = () => undefined;
  let backgroundClick: () => void = () => undefined;
  let zoom: () => void = () => undefined;
  let drag: () => void = () => undefined;

  const stub = {
    calls: [] as string[],
    data: null as { nodes: GraphDatum[]; links: LinkDatum[] } | null,
    centre: { x: 0, y: 0 },
    scaleValue: 1,
    fireEngineStop: () => engineStop(),
    fireNodeClick: (n: GraphDatum) => nodeClick(n),
    fireBackgroundClick: () => backgroundClick(),
    fireZoom: () => zoom(),
    fireNodeDrag: () => drag(),
  } as unknown as Stub;

  const chain = (name: string) => {
    stub.calls.push(name);
    return stub;
  };

  Object.assign(stub, {
    graphData: (d: { nodes: GraphDatum[]; links: LinkDatum[] }) => {
      stub.data = d;
      return chain("graphData");
    },
    nodeId: () => chain("nodeId"),
    linkSource: () => chain("linkSource"),
    linkTarget: () => chain("linkTarget"),
    width: () => chain("width"),
    height: () => chain("height"),
    backgroundColor: (c: string) => chain(`backgroundColor:${c}`),
    nodeRelSize: () => chain("nodeRelSize"),
    nodeCanvasObject: () => chain("nodeCanvasObject"),
    nodePointerAreaPaint: () => chain("nodePointerAreaPaint"),
    nodeLabel: () => chain("nodeLabel"),
    linkLabel: () => chain("linkLabel"),
    linkColor: () => chain("linkColor"),
    linkWidth: () => chain("linkWidth"),
    linkLineDash: () => chain("linkLineDash"),
    linkDirectionalArrowLength: () => chain("linkDirectionalArrowLength"),
    linkDirectionalArrowRelPos: () => chain("linkDirectionalArrowRelPos"),
    onRenderFramePost: () => chain("onRenderFramePost"),
    onNodeHover: () => chain("onNodeHover"),
    onNodeClick: (fn: (n: GraphDatum) => void) => {
      nodeClick = fn;
      return chain("onNodeClick");
    },
    onBackgroundClick: (fn: () => void) => {
      backgroundClick = fn;
      return chain("onBackgroundClick");
    },
    onZoom: (fn: () => void) => {
      zoom = fn;
      return chain("onZoom");
    },
    onZoomEnd: () => chain("onZoomEnd"),
    onNodeDrag: (fn: () => void) => {
      drag = fn;
      return chain("onNodeDrag");
    },
    onNodeDragEnd: () => chain("onNodeDragEnd"),
    onEngineStop: (fn: () => void) => {
      engineStop = fn;
      return chain("onEngineStop");
    },
    cooldownTime: (ms: number) => chain(`cooldownTime:${ms}`),
    cooldownTicks: (n: number) => chain(`cooldownTicks:${n}`),
    warmupTicks: (n: number) => chain(`warmupTicks:${n}`),
    d3AlphaDecay: () => chain("d3AlphaDecay"),
    d3VelocityDecay: () => chain("d3VelocityDecay"),
    enableNodeDrag: () => chain("enableNodeDrag"),
    autoPauseRedraw: (on: boolean) => chain(`autoPauseRedraw:${on}`),
    pauseAnimation: () => chain("pauseAnimation"),
    resumeAnimation: () => chain("resumeAnimation"),
    centerAt: (...args: number[]) => {
      if (args.length === 0) return stub.centre;
      stub.centre = { x: args[0], y: args[1] };
      return chain(`centerAt/${args.length}`);
    },
    zoom: (...args: number[]) => {
      if (args.length === 0) return stub.scaleValue;
      stub.scaleValue = args[0];
      return chain(`zoom/${args.length}`);
    },
    zoomToFit: () => chain("zoomToFit"),
    screen2GraphCoords: (x: number, y: number) => ({ x, y }),
    graph2ScreenCoords: (x: number, y: number) => ({ x, y }),
    _destructor: () => chain("_destructor"),
  });

  return stub;
}

/** The pointer-idle debounce the real seam resolves from the `// STD` token. */
const IDLE_MS = 20;

const NOOP_PAINT = {
  drawNode: () => undefined,
  paintPointerArea: () => undefined,
  linkColor: () => "var(--dataviz-bone)",
  linkWidth: () => 1,
  linkLineDash: () => null,
  linkArrowLength: () => 0,
  drawOverlay: () => undefined,
};

function node(key: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    key,
    type: "brief",
    id: key,
    project: "p",
    label: key,
    attrs: {},
    degree: 0,
    ...over,
  };
}

function edge(from: string, to: string, id = `${from}->${to}`): GraphEdge {
  return {
    id,
    source_edge_id: 1,
    from,
    to,
    type: "parent_of",
    confidence: 1,
    provenance: "observed",
    resolution: "unique",
  };
}

let stub: Stub;
let container: HTMLElement;

function build(over: Partial<Parameters<typeof createGraphInstance>[0]> = {}): GraphController {
  return createGraphInstance({
    container,
    paint: NOOP_PAINT,
    entranceMs: 1400,
    pointerIdleMs: IDLE_MS,
    reducedMotion: false,
    onHover: () => undefined,
    onSelect: () => undefined,
    factory: () => stub,
    ...over,
  });
}

beforeEach(() => {
  stub = makeStub();
  // `instance.ts` only ever calls `container.querySelector`, so a stub object
  // is enough — no DOM is needed to drive the state machine.
  container = { querySelector: () => null } as unknown as HTMLElement;
});

// ---------------------------------------------------------------------------
// T7 — the state machine
// ---------------------------------------------------------------------------

describe("T7 — pauseAnimation is wired to onEngineStop", () => {
  it("registers an onEngineStop handler at construction", () => {
    build();
    expect(stub.calls).toContain("onEngineStop");
  });

  it("starts in SETTLING and does not pause before the engine stops", () => {
    const g = build();
    expect(g.state()).toBe("settling");
    expect(stub.calls).not.toContain("pauseAnimation");
  });

  it("engine stop -> pauseAnimation() -> STILL", async () => {
    const g = build();
    stub.fireEngineStop();
    await tick();
    expect(stub.calls).toContain("pauseAnimation");
    expect(g.state()).toBe("still");
  });

  it("the pause is DEFERRED out of the frame, never called inline", () => {
    // THE REGRESSION GUARD FOR THE BUG THAT MADE THIS CANVAS NEVER STOP.
    //
    // `force-graph` fires `onEngineStop` from inside its rAF callback, and that
    // callback RE-ARMS the next frame after the callback returns:
    //
    //     function animate() { ... tickFrame(); ... rafId = rAF(animate); }
    //
    // `pauseAnimation()` is `cancelAnimationFrame(rafId)`. Called inline from
    // `onEngineStop`, it cancels the id of the frame that already fired and is
    // then immediately undone by the trailing re-arm. The loop runs forever.
    //
    // Measured before the fix: `state: "still"` with a stable pixel hash while
    // a painted-frame counter climbed 68 -> 501 over 17 seconds. The pixel-diff
    // AC passes in that state, which is precisely the weakness the plan named
    // when the library path was chosen.
    const g = build();
    stub.fireEngineStop();
    // Synchronously: the state machine has committed, but the library has NOT
    // been touched yet.
    expect(g.state()).toBe("still");
    expect(stub.calls).not.toContain("pauseAnimation");
  });

  it("a halt in flight is abandoned if an interaction starts first", async () => {
    const g = build();
    stub.fireEngineStop();
    // The deferral opens a one-frame window. An interaction that starts inside
    // it must not be frozen by the pause that was already scheduled.
    g.beginInteraction();
    await tick();
    expect(stub.calls).not.toContain("pauseAnimation");
    expect(g.state()).toBe("interacting");
  });

  it("the entrance is cooldownTime = the CINE token, once", () => {
    build();
    // The live simulation IS the entrance. The token is the mechanism.
    expect(stub.calls.filter((c) => c.startsWith("cooldownTime:"))).toEqual([
      "cooldownTime:1400",
    ]);
  });

  it("onSettled fires exactly once, even if the engine stops repeatedly", () => {
    const onSettled = vi.fn();
    build({ onSettled });
    stub.fireEngineStop();
    stub.fireEngineStop();
    stub.fireEngineStop();
    // "Fires once per mount. It never re-fires on filter or re-layout."
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

describe("T7 — resumeAnimation only on interaction entry", () => {
  it("is never called during construction or settling", () => {
    const g = build();
    expect(stub.calls).not.toContain("resumeAnimation");
    expect(g.state()).toBe("settling");
  });

  it("first interaction resumes; last interaction re-pauses", async () => {
    const g = build();
    stub.fireEngineStop();
    await tick();
    stub.calls.length = 0;

    g.beginInteraction();
    expect(stub.calls).toEqual(["resumeAnimation"]);
    expect(g.state()).toBe("interacting");

    g.endInteraction();
    await tick();
    expect(stub.calls).toEqual(["resumeAnimation", "pauseAnimation"]);
    expect(g.state()).toBe("still");
  });

  it("CONCURRENT interactions resume once and pause once", async () => {
    const g = build();
    stub.fireEngineStop();
    await tick();
    stub.calls.length = 0;

    // A hover starting mid-filter-tween is the real case. A naive
    // pause-on-complete would freeze the tween the moment the hover ended.
    g.beginInteraction(); // filter tween
    g.beginInteraction(); // hover
    g.beginInteraction(); // selection ring
    expect(stub.calls.filter((c) => c === "resumeAnimation")).toHaveLength(1);

    g.endInteraction();
    g.endInteraction();
    await tick();
    expect(stub.calls).not.toContain("pauseAnimation");
    expect(g.state()).toBe("interacting");

    g.endInteraction();
    await tick();
    expect(stub.calls.filter((c) => c === "pauseAnimation")).toHaveLength(1);
    expect(g.state()).toBe("still");
  });

  it("an unbalanced endInteraction cannot drive the refcount negative", async () => {
    const g = build();
    stub.fireEngineStop();
    await tick();
    stub.calls.length = 0;

    // If this underflowed, the NEXT beginInteraction would not resume and the
    // canvas would silently stop responding to hover.
    g.endInteraction();
    g.endInteraction();
    expect(stub.calls).toEqual([]);

    g.beginInteraction();
    expect(stub.calls).toEqual(["resumeAnimation"]);
  });

  it("interacting while still SETTLING does not resume an already-live loop", () => {
    const g = build();
    g.beginInteraction();
    // The loop is already running during the entrance; resuming it would be a
    // no-op at best and a state-machine lie at worst.
    expect(stub.calls).not.toContain("resumeAnimation");
    expect(g.state()).toBe("settling");
  });
});

// ---------------------------------------------------------------------------
// C1 — the pointer wake-up path. THE guard that was missing entirely.
// ---------------------------------------------------------------------------

describe("C1 — a halted loop can still be woken by a pointer", () => {
  const idle = (): Promise<void> =>
    new Promise((r) => setTimeout(r, IDLE_MS * 3));

  it("pointerActivity resumes the loop from STILL", async () => {
    const g = build();
    stub.fireEngineStop();
    await tick();
    stub.calls.length = 0;

    // Without this path the canvas is DEAD, not still: hit-testing, hover
    // dispatch and the shadow-canvas refresh all live inside the render loop,
    // so `onNodeHover` can never fire to restart it. Hover did nothing, pan and
    // drag did not repaint, and a click read a `hoverObj` frozen at null —
    // which meant clicking a node DESELECTED it.
    g.pointerActivity();
    expect(stub.calls).toContain("resumeAnimation");
    expect(g.state()).toBe("interacting");
  });

  it("is LATCHED — a stream of pointermoves costs one refcount slot", () => {
    const g = build();
    stub.fireEngineStop();
    stub.calls.length = 0;

    for (let i = 0; i < 50; i++) g.pointerActivity();
    expect(stub.calls.filter((c) => c === "resumeAnimation")).toHaveLength(1);
    expect(g.state()).toBe("interacting");
  });

  it("re-pauses after the idle window, and only then", async () => {
    const g = build();
    stub.fireEngineStop();
    await tick();
    stub.calls.length = 0;

    g.pointerActivity();
    expect(stub.calls).not.toContain("pauseAnimation");

    await idle();
    expect(stub.calls).toContain("pauseAnimation");
    expect(g.state()).toBe("still");
  });

  it("continued activity keeps deferring the re-pause", async () => {
    const g = build();
    stub.fireEngineStop();
    await tick();
    stub.calls.length = 0;

    // A pointer moving steadily must never let the canvas pause underneath it.
    for (let i = 0; i < 4; i++) {
      g.pointerActivity();
      await new Promise((r) => setTimeout(r, IDLE_MS / 2));
    }
    expect(stub.calls).not.toContain("pauseAnimation");
    expect(g.state()).toBe("interacting");

    await idle();
    expect(stub.calls).toContain("pauseAnimation");
  });

  it("can be woken AGAIN after re-pausing — the latch resets", async () => {
    const g = build();
    stub.fireEngineStop();
    await tick();

    g.pointerActivity();
    await idle();
    expect(g.state()).toBe("still");
    stub.calls.length = 0;

    // A latch that failed to reset would leave the canvas dead after the first
    // hover — the same failure, one interaction later.
    g.pointerActivity();
    expect(stub.calls).toContain("resumeAnimation");
    expect(g.state()).toBe("interacting");
  });

  it("zoom and drag are wired to the wake path", () => {
    // These fire from d3 DOM handlers, OUTSIDE the loop, so they still arrive
    // while it is halted — unlike `onNodeHover`, which does not.
    for (const fire of ["fireZoom", "fireNodeDrag"] as const) {
      stub = makeStub();
      const g = build();
      stub.fireEngineStop();
      stub.calls.length = 0;
      stub[fire]();
      expect(stub.calls, fire).toContain("resumeAnimation");
      expect(g.state(), fire).toBe("interacting");
    }
  });

  it("registers all four zoom/drag callbacks", () => {
    build();
    for (const c of ["onZoom", "onZoomEnd", "onNodeDrag", "onNodeDragEnd"]) {
      expect(stub.calls, c).toContain(c);
    }
  });

  it("teardown clears a pending idle timer", async () => {
    const g = build();
    stub.fireEngineStop();
    await tick();
    g.pointerActivity();
    g.destroy();
    stub.calls.length = 0;
    // A surviving timer would call into a destroyed instance.
    await idle();
    expect(stub.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C1 — the BOUNDARY itself, not just the function it calls.
//
// The 11 tests above drive `controller.pointerActivity()` directly. That is NOT
// the fix: deleting the DOM-listener wiring entirely left every one of them
// green, because nothing asserted that a real DOM event ever reaches it.
//
// These tests dispatch a REAL `Event` at a REAL `EventTarget` (node has both)
// and assert the instance resumed. They fail if the wake path ever moves back
// inside the render loop, because a library callback does not fire from an
// element event.
// ---------------------------------------------------------------------------

describe("C1 — a real DOM event on the container wakes the canvas", () => {
  /** A real EventTarget standing in for the canvas host. No DOM library needed. */
  function host(): Pick<HTMLElement, "addEventListener" | "removeEventListener"> &
    { dispatch: (type: string) => void } {
    const target = new EventTarget();
    return {
      addEventListener: target.addEventListener.bind(target) as never,
      removeEventListener: target.removeEventListener.bind(target) as never,
      dispatch: (type: string) => target.dispatchEvent(new Event(type)),
    };
  }

  it("exports the pointer set the boundary listens on", () => {
    expect([...POINTER_WAKE_EVENTS]).toEqual([
      "pointerenter",
      "pointermove",
      "pointerdown",
      "pointerup",
      "pointerleave",
      "wheel",
    ]);
  });

  it.each([...POINTER_WAKE_EVENTS])(
    "a dispatched %s resumes a halted loop",
    async (type) => {
      stub = makeStub();
      const g = build();
      const el = host();
      attachPointerBoundary(el, g);
      stub.fireEngineStop();
      await tick();
      stub.calls.length = 0;

      el.dispatch(type);

      expect(stub.calls, type).toContain("resumeAnimation");
      expect(g.state(), type).toBe("interacting");
    },
  );

  it("an event on the element re-pauses after the idle window", async () => {
    const g = build();
    const el = host();
    attachPointerBoundary(el, g);
    stub.fireEngineStop();
    await tick();
    stub.calls.length = 0;

    el.dispatch("pointermove");
    expect(stub.calls).not.toContain("pauseAnimation");

    await new Promise((r) => setTimeout(r, IDLE_MS * 3));
    expect(stub.calls).toContain("pauseAnimation");
    expect(g.state()).toBe("still");
  });

  it("the detacher really detaches — a later event does NOT wake it", async () => {
    const g = build();
    const el = host();
    const detach = attachPointerBoundary(el, g);
    stub.fireEngineStop();
    await tick();

    detach();
    stub.calls.length = 0;
    for (const type of POINTER_WAKE_EVENTS) el.dispatch(type);

    // A leaked listener after unmount would call into a torn-down instance.
    expect(stub.calls).toEqual([]);
    expect(g.state()).toBe("still");
  });

  it("registers a listener for every event in the set, and no others", () => {
    const seen: string[] = [];
    const el = {
      addEventListener: (t: string) => seen.push(t),
      removeEventListener: () => undefined,
    } as unknown as HTMLElement;
    attachPointerBoundary(el, build());
    expect(seen).toEqual([...POINTER_WAKE_EVENTS]);
  });

  it("attaches passively — it must never preventDefault the wheel", () => {
    const opts: unknown[] = [];
    const el = {
      addEventListener: (_t: string, _f: unknown, o: unknown) => opts.push(o),
      removeEventListener: () => undefined,
    } as unknown as HTMLElement;
    attachPointerBoundary(el, build());
    for (const o of opts) expect(o).toEqual({ passive: true });
  });
});

describe("T7 — reduced motion converges before first paint", () => {
  it("uses warmupTicks + cooldownTicks 0, and no CINE cooldown", () => {
    build({ reducedMotion: true });
    expect(stub.calls.some((c) => c.startsWith("warmupTicks:"))).toBe(true);
    expect(stub.calls).toContain("cooldownTicks:0");
    expect(stub.calls).toContain("cooldownTime:0");
    expect(stub.calls).not.toContain("cooldownTime:1400");
  });

  it("still halts the loop when the engine stops", async () => {
    const g = build({ reducedMotion: true });
    stub.fireEngineStop();
    await tick();
    expect(stub.calls).toContain("pauseAnimation");
    expect(g.state()).toBe("still");
  });
});

describe("T7 — the camera never hands a duration to the library (F2)", () => {
  it("centerAt is called with exactly two arguments", () => {
    const g = build();
    g.camera.setCentre(12, 34);
    // `centerAt/3` would mean the library's own easing is driving the move.
    expect(stub.calls).toContain("centerAt/2");
    expect(stub.calls.some((c) => c === "centerAt/3")).toBe(false);
  });

  it("zoom is called with exactly one argument", () => {
    const g = build();
    g.camera.setScale(2.5);
    expect(stub.calls).toContain("zoom/1");
    expect(stub.calls.some((c) => c === "zoom/2")).toBe(false);
  });

  it("reads the camera back through the zero-argument forms", () => {
    const g = build();
    g.camera.setCentre(7, 8);
    g.camera.setScale(3);
    expect(g.camera.centre()).toEqual({ x: 7, y: 8 });
    expect(g.camera.scale()).toBe(3);
  });
});

describe("T7 — the canvas background is transparent (exemption 01)", () => {
  it("so the container's CSS grid texture shows through", () => {
    build();
    expect(stub.calls).toContain("backgroundColor:transparent");
  });
});

describe("T7 — autoPauseRedraw is OFF, and that is not an oversight", () => {
  it("is explicitly disabled", () => {
    build();
    // The library's redraw-skipping can only judge ITS OWN props. Every visual
    // state this canvas has — hover emphasis, filter progress, the selection
    // ring, the active palette — lives in a mutable object the accessors read
    // and the library knows nothing about, so its answer to "did anything
    // change?" is structurally wrong here.
    //
    // Measured, not theorised: with it ON, the FR-239 end-to-end run showed a
    // `data-palette` swap resolving all five role tokens correctly in CSS while
    // the canvas kept painting the old palette, byte for byte.
    expect(stub.calls).toContain("autoPauseRedraw:false");
    expect(stub.calls).not.toContain("autoPauseRedraw:true");
  });

  it("stillness does not depend on it — pauseAnimation is the mechanism", async () => {
    const g = build();
    stub.fireEngineStop();
    await tick();
    // The loop is halted outright at rest regardless of the redraw heuristic,
    // which is why turning the heuristic off costs nothing AC #5 relies on.
    expect(stub.calls).toContain("pauseAnimation");
    expect(g.state()).toBe("still");
  });
});

describe("T7 — teardown", () => {
  it("pauses before destroying, so no frame can land after unmount", () => {
    const g = build();
    g.destroy();
    const pauseAt = stub.calls.indexOf("pauseAnimation");
    const destructAt = stub.calls.indexOf("_destructor");
    expect(pauseAt).toBeGreaterThanOrEqual(0);
    expect(destructAt).toBeGreaterThan(pauseAt);
  });
});

// ---------------------------------------------------------------------------
// T10 — layout determinism and the D6 position seed
// ---------------------------------------------------------------------------

describe("T10 — data, positions, and the drill-down seed", () => {
  it("passes nodes through and maps from/to onto source/target", () => {
    const g = build();
    g.setData([node("a"), node("b")], [edge("a", "b")]);
    expect(stub.data?.nodes.map((n) => n.key)).toEqual(["a", "b"]);
    expect(stub.data?.links[0].source).toBe("a");
    expect(stub.data?.links[0].target).toBe("b");
  });

  it("drops an edge whose endpoint is not in the node set", () => {
    const g = build();
    // A client-side filter can narrow `nodes`; handing d3-force a dangling
    // link throws, and a thrown layout is an empty canvas.
    g.setData([node("a")], [edge("a", "ghost")]);
    expect(stub.data?.links).toEqual([]);
  });

  it("seeded positions are applied — a drill-down is not a second entrance", () => {
    const g = build();
    g.setData([node("a"), node("b")], [], { a: { x: 10, y: 20 } });
    const a = stub.data?.nodes.find((n) => n.key === "a");
    const b = stub.data?.nodes.find((n) => n.key === "b");
    expect(a?.x).toBe(10);
    expect(a?.y).toBe(20);
    // An unseeded node is left for the simulation to place.
    expect(b?.x).toBeUndefined();
  });

  it("positions() round-trips through setData — the same payload lands the same", () => {
    const g = build();
    g.setData([node("a"), node("b")], []);
    // Simulate the engine settling.
    for (const n of stub.data?.nodes ?? []) {
      n.x = n.key === "a" ? 1 : 2;
      n.y = n.key === "a" ? 3 : 4;
    }
    const cached = g.positions();
    expect(cached).toEqual({ a: { x: 1, y: 3 }, b: { x: 2, y: 4 } });

    // Re-seeding with the cache reproduces the canvas exactly. dataviz.md's
    // determinism limit: "the same query plus the same seed produces the same
    // canvas" — which is what makes exemption 04's twin honest.
    g.setData([node("a"), node("b")], [], cached);
    expect(g.positions()).toEqual(cached);
  });

  it("positions() omits nodes the simulation has not placed yet", () => {
    const g = build();
    g.setData([node("a")], []);
    expect(g.positions()).toEqual({});
  });

  it("a click selects, and a background click clears", () => {
    const onSelect = vi.fn();
    build({ onSelect });
    stub.fireNodeClick({ ...node("a") } as GraphDatum);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "a" }));
    stub.fireBackgroundClick();
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});

describe("T10 — reheat is deliberate, never ambient (D8)", () => {
  it("re-enters SETTLING and resumes the loop", async () => {
    const g = build();
    stub.fireEngineStop();
    await tick();
    stub.calls.length = 0;

    g.reheat();
    expect(g.state()).toBe("settling");
    expect(stub.calls).toContain("resumeAnimation");
  });

  it("instance.ts contains no RECURRING timer that could reach it", async () => {
    // D8's structural half. The graph fetches once per scope and re-layouts
    // only on an explicit REFRESH; a 5-second reheat would be ambient motion
    // dressed as freshness, and with a library we cannot prove is still, that
    // is precisely the failure AC #5 exists to catch.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../instance.ts", import.meta.url), "utf-8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const re of [
      /\bsetInterval\b/,
      /\brequestAnimationFrame\b/,
      /\bd3ReheatSimulation\b/,
    ]) {
      expect(re.test(code), `instance.ts must not match ${re}`).toBe(false);
    }
    // EXACTLY TWO `setTimeout` CALL SITES, both named. Neither starts motion:
    // one STOPS the loop, the other stops it again after a pointer goes idle.
    // The count is pinned and each site is identified, because "some timers,
    // all fine" is how an ambient one eventually arrives unnoticed.
    const callSites = [...code.matchAll(/(?<!typeof )\bsetTimeout\s*\(/g)];
    expect(callSites).toHaveLength(2);
    // 1 — the deferred halt (the C-bug-1 fix).
    expect(code).toMatch(/pausePending = true;\s*\n\s*setTimeout\(/);
    // 2 — the pointer-idle debounce that re-pauses after activity stops (C1).
    expect(code).toMatch(/idleTimer = setTimeout\(/);
    // And the only `clearTimeout`s are the ones that cancel that debounce.
    expect(code).toMatch(/clearTimeout\(idleTimer\)/);
  });
});
