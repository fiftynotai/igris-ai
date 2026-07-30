/**
 * FR-240 (D6) — **behavioural gate over the hoisted scope cache.**
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `lib/graphCache.ts` is a NEW module: the Phase-3 hoist of the `ScopeCache`
 * that FR-239 kept in a `useRef<Map<...>>` private to `pages/Graph.tsx`. Before
 * this file its only coverage was a string grep in
 * `cli/src/__tests__/dashboard-layers-source.test.ts` asserting the file
 * CONTAINS the literals `positions: {}` and `rememberPositions` — a scan that
 * cannot tell a working cache from a broken one, and that `resetGraphCache()`
 * (exported for tests and imported by nothing) was built to make unnecessary.
 *
 * The property at stake is AC-load-bearing for FR-239, not for FR-240: backing
 * out of a drill must restore the SETTLED layout rather than pay a second
 * entrance animation, and after the hoist the store that holds those positions
 * lives here. G-BR-4c re-runs the FR-239 *render-loop* checkpoint, which is a
 * different property — a stillness reading passes whether or not the positions
 * survived the round trip.
 *
 * WHAT THIS FILE PROVES
 *   1. ONE FETCH, TWO CALLERS — the entire reason for the hoist (D6). Two
 *      callers in the same tick share one `api.graph` call and one payload
 *      object, so a record detail and the graph page cannot be looking at two
 *      generations of the same scope.
 *   2. A FRESH FETCH RESETS `positions`; a CACHED read PRESERVES them. The
 *      negative control is the load-bearing half: an implementation that reset
 *      on every read would silently reintroduce the second entrance, and an
 *      implementation that never reset would seed a new node set from a stale
 *      layout (`putScope`'s header: nodes stacked at the origin).
 *   3. `rememberPositions` LANDS ON ONE SCOPE and does not bleed into a
 *      sibling. This is the property no existing test can see at any layer.
 *   4. `force: true` BYPASSES the cache but still JOINS an in-flight request,
 *      so double-clicking REFRESH is one fetch.
 *   5. A REJECTED fetch clears the in-flight slot, so a transient failure does
 *      not poison the scope forever.
 *
 * WHAT THIS FILE DOES **NOT** PROVE
 *   That `pages/Graph.tsx` and `layers/useNeighbours.ts` actually route through
 *   this module, nor that the seed reaches the canvas. Those are source and
 *   browser claims respectively.
 *   **Siblings:** `cli/src/__tests__/dashboard-layers-source.test.ts` (the
 *   graphCache-hoist source scan) and `cli/scripts/browser-gate.mjs` **G-BR-7**
 *   (drill in, back out: zero refetch and a layout that is restored rather than
 *   re-entranced, with a REFRESH as the paired control).
 *
 * HOW `api.graph` IS STUBBED, AND WHY NOT `vi.mock`
 * ------------------------------------------------
 * `lib/api.ts` exports `api` as a plain object literal, so the method is a
 * writable property and the stub is an assignment restored in `afterEach`. A
 * `vi.mock` factory would have to reproduce the whole `api` surface (fifteen
 * methods) to satisfy the module's type, and the thing under test is the CACHE,
 * not the client. The stub COUNTS its calls, and every count assertion below is
 * paired with an observation of the counter MOVING (learning 1094) — a "called
 * once" assertion over a stub that can only ever be called once is vacuous.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, type GraphPayload } from "../api.js";
import type { PositionCache } from "../../graph/instance.js";
import {
  cachedScope,
  fetchScope,
  putScope,
  rememberPositions,
  resetGraphCache,
  scopeKey,
} from "../graphCache.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A minimal but COMPLETE `GraphPayload`. Complete on purpose: a partial cast
 * would let a field rename in `api.ts` pass here and fail in the browser.
 */
function payload(project: string | null, nodeCount = 1): GraphPayload {
  return {
    project,
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      key: `brief|${project ?? ""}|BR-${i}`,
      type: "brief",
      id: `BR-${i}`,
      project,
      label: `BR-${i}`,
      attrs: {},
      degree: 0,
    })),
    edges: [],
    stats: {
      node_count: nodeCount,
      edge_count: 0,
      by_node_type: { brief: nodeCount },
      by_edge_type: {},
      project_count: project === null ? 2 : 1,
      boundary_node_count: 0,
    },
    truncated: false,
    truncation_reason: null,
    query: {
      surface: "/api/graph",
      query: ["SELECT …"],
      as_of: "2026-07-30T00:00:00.000Z",
      scale: project === null ? "whole brain" : `scope · ${project}`,
    },
    generated_at: "2026-07-30T00:00:00.000Z",
    degraded: null,
  };
}

const POS = (x: number): PositionCache => ({ "brief||BR-0": { x, y: x * 2 } });

/** The real `api.graph`, restored after every case. */
const realGraph = api.graph;

/** Calls the stub received, in order. Reset per test. */
let calls: (string | null)[];

/** Install a stub that resolves immediately with `made(scope)`. */
function stubResolving(made: (scope: string | null) => GraphPayload): void {
  api.graph = (project) => {
    calls.push(project);
    return Promise.resolve(made(project));
  };
}

/** Install a stub whose promise is settled by the returned controls. */
function stubDeferred(): {
  resolve: (p: GraphPayload) => void;
  reject: (e: Error) => void;
} {
  let res!: (p: GraphPayload) => void;
  let rej!: (e: Error) => void;
  api.graph = (project) => {
    calls.push(project);
    return new Promise<GraphPayload>((resolve, reject) => {
      res = resolve;
      rej = reject;
    });
  };
  return {
    resolve: (p) => res(p),
    reject: (e) => rej(e),
  };
}

beforeEach(() => {
  calls = [];
  resetGraphCache();
});

afterEach(() => {
  api.graph = realGraph;
  resetGraphCache();
});

// ---------------------------------------------------------------------------
// scopeKey — the null/"" collapse the whole store is keyed on
// ---------------------------------------------------------------------------

describe("scopeKey collapses `null` (the whole brain) to the empty string", () => {
  it("maps null and '' to the SAME key, and a project to itself", () => {
    expect(scopeKey(null)).toBe("");
    expect(scopeKey("")).toBe("");
    expect(scopeKey("demo")).toBe("demo");
  });

  it("the collapse is REAL in the store, not just in the key function", () => {
    // `Graph.tsx` writes with `null` and `useNeighbours` may read with a slug;
    // if these were two entries the two surfaces would hold two layouts for the
    // whole brain and the back-out would seed from the wrong one.
    const whole = payload(null, 3);
    putScope(null, whole);
    expect(cachedScope("")?.payload).toBe(whole);
    expect(cachedScope(null)?.payload).toBe(whole);
    // …and a genuinely different scope is a genuinely different entry.
    expect(cachedScope("demo")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (1) ONE FETCH, TWO CALLERS — the reason the hoist exists (D6)
// ---------------------------------------------------------------------------

describe("one fetch, two callers — the D6 sharing contract", () => {
  it("two callers in the SAME TICK share one request and one payload object", async () => {
    stubResolving((s) => payload(s, 5));

    const a = fetchScope("demo");
    const b = fetchScope("demo");
    const [pa, pb] = await Promise.all([a, b]);

    expect(calls, "the graph endpoint was hit twice for one scope").toEqual([
      "demo",
    ]);
    // Object IDENTITY, not deep equality. Two structurally-equal payloads would
    // still mean two ~1 MB fetches and two generations of the graph — which is
    // the failure D6 exists to remove.
    expect(pa).toBe(pb);
    expect(cachedScope("demo")?.payload).toBe(pa);
  });

  it("a SECOND caller after the first resolved is served from the cache", async () => {
    stubResolving((s) => payload(s, 5));
    const first = await fetchScope("demo");
    const second = await fetchScope("demo");
    expect(calls).toEqual(["demo"]);
    expect(second).toBe(first);
  });

  it("SELF-NEGATIVE-CONTROL — the call counter CAN move, and resetGraphCache clears the store", async () => {
    // Without this, "called once" above is indistinguishable from a stub that
    // is never called at all, or from a counter that cannot increment.
    stubResolving((s) => payload(s, 5));
    await fetchScope("demo");
    expect(calls).toEqual(["demo"]);

    // A DIFFERENT scope is a different fetch — the key is load-bearing.
    await fetchScope("other");
    expect(calls).toEqual(["demo", "other"]);

    // And the seam this suite depends on really empties the store: after a
    // reset the same scope fetches AGAIN.
    expect(cachedScope("demo")).toBeDefined();
    resetGraphCache();
    expect(cachedScope("demo")).toBeUndefined();
    await fetchScope("demo");
    expect(calls).toEqual(["demo", "other", "demo"]);
  });
});

// ---------------------------------------------------------------------------
// (2) A FRESH FETCH RESETS `positions`; A CACHED READ PRESERVES THEM
// ---------------------------------------------------------------------------

describe("positions survive a cached read and are dropped by a fresh fetch", () => {
  it("putScope stores a fresh entry with positions reset to {}", () => {
    const p = payload("demo");
    const entry = putScope("demo", p);
    expect(entry.payload).toBe(p);
    expect(entry.positions).toEqual({});
    expect(cachedScope("demo")).toBe(entry);
  });

  it("putScope over an EXISTING entry drops the positions that entry held", () => {
    // The load-bearing direction. Positions belong to a node set; seeding a new
    // payload from the old layout is how nodes end up stacked at the origin
    // (`putScope`'s header).
    putScope("demo", payload("demo", 3));
    rememberPositions("demo", POS(10));
    expect(cachedScope("demo")?.positions).toEqual(POS(10));

    putScope("demo", payload("demo", 7));
    expect(cachedScope("demo")?.positions).toEqual({});
  });

  it("a CACHED read PRESERVES them — the negative control for the reset", async () => {
    // Without this pairing, "positions are {} after a fetch" is also what you
    // observe from an implementation that resets on EVERY read, which would
    // make the back-out pay a second entrance every time.
    stubResolving((s) => payload(s, 3));
    const first = await fetchScope("demo");
    rememberPositions("demo", POS(4));

    const second = await fetchScope("demo");

    expect(second).toBe(first);
    expect(calls).toEqual(["demo"]);
    expect(cachedScope("demo")?.positions).toEqual(POS(4));
  });

  it("a FORCED refetch resets them (the explicit REFRESH path)", async () => {
    stubResolving((s) => payload(s, 3));
    await fetchScope("demo");
    rememberPositions("demo", POS(4));
    expect(cachedScope("demo")?.positions).toEqual(POS(4));

    await fetchScope("demo", { force: true });

    expect(calls).toEqual(["demo", "demo"]);
    expect(cachedScope("demo")?.positions).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// (3) `rememberPositions` LANDS ON ONE SCOPE — the property nothing else sees
// ---------------------------------------------------------------------------

describe("rememberPositions writes to exactly one scope's entry", () => {
  it("seeding two scopes and remembering on one leaves the sibling untouched", () => {
    const whole = putScope(null, payload(null, 9));
    const demo = putScope("demo", payload("demo", 3));

    rememberPositions("demo", POS(42));

    expect(cachedScope("demo")?.positions).toEqual(POS(42));
    // The sibling. A `Map` written by the wrong key, or a shared positions
    // object, both show up here — and nowhere else in the tree.
    expect(cachedScope(null)?.positions).toEqual({});
    // The entry objects themselves were not swapped out.
    expect(cachedScope("demo")).toBe(demo);
    expect(cachedScope(null)).toBe(whole);
  });

  it("the whole brain is addressable as null OR '' and they are one entry", () => {
    putScope(null, payload(null, 9));
    putScope("demo", payload("demo", 3));

    rememberPositions("", POS(7));

    expect(cachedScope(null)?.positions).toEqual(POS(7));
    expect(cachedScope("demo")?.positions).toEqual({});
  });

  it("remembering for an UNKNOWN scope is a no-op, never a half-built entry", () => {
    // A positions-only entry with no `payload` would satisfy
    // `cachedScope(scope) !== undefined` in `Graph.tsx`'s cache-hit branch and
    // then hand `undefined.nodes` to the canvas.
    rememberPositions("never-fetched", POS(1));
    expect(cachedScope("never-fetched")).toBeUndefined();
  });

  it("a later remember REPLACES the earlier one for that scope", () => {
    putScope("demo", payload("demo", 3));
    rememberPositions("demo", POS(1));
    rememberPositions("demo", POS(2));
    expect(cachedScope("demo")?.positions).toEqual(POS(2));
  });
});

// ---------------------------------------------------------------------------
// (4) `force: true` bypasses the cache but joins an in-flight request
// ---------------------------------------------------------------------------

describe("force bypasses the cache and still shares one request", () => {
  it("two forced calls in the same tick are ONE fetch, and both see the new payload", async () => {
    stubResolving((s) => payload(s, 3));
    const stale = await fetchScope("demo");
    expect(calls).toEqual(["demo"]);

    const gate = stubDeferred();
    const f1 = fetchScope("demo", { force: true });
    const f2 = fetchScope("demo", { force: true });
    // ONE new call, even though a cache entry existed and both asked to bypass
    // it: double-clicking REFRESH must not be two ~1 MB builder runs.
    expect(calls).toEqual(["demo", "demo"]);

    const fresh = payload("demo", 11);
    gate.resolve(fresh);
    const [p1, p2] = await Promise.all([f1, f2]);

    expect(p1).toBe(fresh);
    expect(p2).toBe(fresh);
    expect(p1).not.toBe(stale);
    expect(cachedScope("demo")?.payload).toBe(fresh);
  });

  it("a NON-forced call during a forced refetch is served the STALE cache", async () => {
    // Stated because it is surprising, and because it is the behaviour
    // `Graph.tsx` relies on: the cache short-circuit is checked BEFORE the
    // in-flight join, so an unforced reader never blocks on someone else's
    // REFRESH. It is also why REFRESH exists as an explicit control.
    stubResolving((s) => payload(s, 3));
    const stale = await fetchScope("demo");

    const gate = stubDeferred();
    const forced = fetchScope("demo", { force: true });
    const unforced = await fetchScope("demo");
    expect(unforced).toBe(stale);
    expect(calls).toEqual(["demo", "demo"]);

    const fresh = payload("demo", 11);
    gate.resolve(fresh);
    expect(await forced).toBe(fresh);
  });

  it("forcing one scope does not refetch another", async () => {
    stubResolving((s) => payload(s, 3));
    await fetchScope(null);
    await fetchScope("demo");
    expect(calls).toEqual([null, "demo"]);

    await fetchScope("demo", { force: true });

    expect(calls).toEqual([null, "demo", "demo"]);
    // The whole brain kept its entry — a REFRESH inside a drill must not throw
    // away the layout the back-out is going to seed from.
    expect(cachedScope(null)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (5) A failed fetch must not poison the scope
// ---------------------------------------------------------------------------

describe("a rejected fetch clears the in-flight slot", () => {
  it("both joined callers reject, and a later call retries", async () => {
    const gate = stubDeferred();
    const f1 = fetchScope("demo");
    const f2 = fetchScope("demo");
    expect(calls).toEqual(["demo"]);

    gate.reject(new Error("server unreachable"));
    await expect(f1).rejects.toThrow("server unreachable");
    await expect(f2).rejects.toThrow("server unreachable");

    // Nothing was cached — a failure is not an empty graph.
    expect(cachedScope("demo")).toBeUndefined();

    // …and the scope is not stuck on the dead promise.
    stubResolving((s) => payload(s, 2));
    const ok = await fetchScope("demo");
    expect(calls).toEqual(["demo", "demo"]);
    expect(ok.nodes).toHaveLength(2);
  });
});
