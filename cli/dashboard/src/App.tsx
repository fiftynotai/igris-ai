/**
 * FR-238 — the application shell.
 *
 * FR-239 (graph), FR-240 (layer views) and FR-241 (cognition triage) mount
 * INSIDE this. The shell owns: chrome (grain, cursor, nav, palette, live
 * beat), routing, and the degraded/empty/loading states. It owns no domain
 * rendering beyond the Overview counters.
 */
import { lazy, Suspense, useState } from "react";
import { Grain } from "./components/chrome/Grain";
import { Cursor } from "./components/chrome/Cursor";
import { Nav } from "./components/chrome/Nav";
import { StatePage } from "./components/ui/StatePage";
import { Overview } from "./pages/Overview";
import { useLive } from "./lib/useLive";
import { usePalette } from "./lib/usePalette";
import { PENDING_ROUTES, ROUTE_LABELS, useRoute } from "./router";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TD-347 — THE ROUTE SPLIT. THREE LAZY, ONE EAGER, AND THE EAGER ONE IS ARGUED.
 * ─────────────────────────────────────────────────────────────────────────────
 * These three `lazy()` calls ARE the definition of the bundle's initial-load
 * set. `cli/src/__tests__/dashboard-chunks.test.ts` asserts that set's size and
 * `cli/scripts/browser-gate.mjs` G-BR-15 asserts its behaviour (which chunk is
 * fetched on which route). Making a route eager or lazy is therefore a
 * cross-subsystem change: re-measure both ceilings and re-run the browser gate
 * unfiltered, in the same commit. MAINTAINING.md carries the row.
 *
 * WHY THESE THREE:
 *  - `Graph` exclusively owns `graph/**` and, through
 *    `useGraph.ts -> instance-factory.ts`, the ENTIRE force-graph + d3 family.
 *    Measured at TD-347's Phase 0 against the pre-split chunk: that family was
 *    323_511 B of 1_181_077 B rendered (27.4%), 359_106 B with `src/graph`
 *    (30.4%). It is most of the win.
 *  - `Layers` exclusively owns the four layer views, the record family and the
 *    in-repo markdown renderer.
 *  - `Triage` exclusively owns `triage/**` and `components/triage/**`.
 *
 * WHY `Overview` STAYS EAGER — measured, not reflexive. It is the fallback for
 * `#/` and for every unparseable hash (`router.tsx#parse`), so it is the landing
 * view of a cold open; and its EXCLUSIVE weight is 8_005 B rendered (Phase 0's
 * per-module report), because every import it has is already in the shell or
 * shared with another route EXCEPT `components/ui/Card.tsx` (~1 KB of source),
 * which only `Overview` uses. Lazying it would trade a round trip on the
 * commonest first paint for a chunk of a few KB. The plan's own reversal
 * threshold was ~10 KB and the measurement came in under it.
 *
 * WHY `gsap` IS NOT PART OF THIS WIN, said out loud so nobody claims it:
 * `components/chrome/Cursor.tsx` is a SHELL component and imports it, so its
 * 153_264 rendered bytes are eager whatever happens to the routes. It is the
 * largest non-React eager item and the next planner's candidate. Out of scope
 * here — removing it is a behaviour change, not a delivery change.
 *
 * Rollup hoists modules shared between two ASYNC chunks (e.g.
 * `components/record/**` between Layers and Triage) into their own async chunk,
 * fetched in PARALLEL with the route chunk via Vite's `__vitePreload`. Not a
 * waterfall. Anything shared between an eager and a lazy module stays in the
 * entry, which is correct.
 *
 * The `.then(m => ({ default: m.X }))` shape is because these are NAMED exports;
 * `React.lazy` requires a module whose `default` is the component.
 */
const Graph = lazy(() => import("./pages/Graph").then((m) => ({ default: m.Graph })));
const Layers = lazy(() => import("./pages/Layers").then((m) => ({ default: m.Layers })));
const Triage = lazy(() => import("./pages/Triage").then((m) => ({ default: m.Triage })));
/*
 * FR-248 — THE FOURTH LAZY ROUTE, and it is lazy for the reason the block above
 * describes rather than by habit.
 *
 * `pages/Search.tsx` exclusively owns `search/**`. Everything else it renders —
 * `components/record/**`, `ProjectScope`, `ui/Chip` — is already in the entry or
 * in the shared async chunk that Layers and Triage fetch, so a third async
 * importer of that chunk duplicates nothing. The eager cost of this route is
 * these three lines plus a `ROUTES` member and a nav label.
 *
 * The obligation from the block above applies in full: making it eager (or
 * static-importing `pages/Search` anywhere) pulls `search/**` back onto the
 * critical path and re-bases both ceilings.
 */
const Search = lazy(() => import("./pages/Search").then((m) => ({ default: m.Search })));
/*
 * FR-266 — THE FIFTH LAZY ROUTE, and the same argument as the block above rather
 * than a habit.
 *
 * `pages/Diagnostics.tsx` exclusively owns `diagnostics/**` (the pure tone model
 * and the read hook). Everything else it renders — `ui/Badge`, `ui/StatePage`,
 * `lib/api` — is already in the entry or in a chunk another route fetches, so a
 * new async importer of those duplicates nothing. The EAGER cost of this route is
 * these three lines plus a `ROUTES` member and a nav label.
 *
 * IT IS ALSO THE ROUTE THAT WOULD BE MOST TEMPTING TO MAKE EAGER, because a
 * "something is broken" indicator in the chrome would need the payload on every
 * route. That was refused (D8): a count in the nav puts `/api/cognition` on the
 * initial critical path and creates a second source of truth for the panel.
 * Revisit when there are 2+ panels and a summary worth putting in the chrome.
 *
 * The obligation from the block above applies in full: making it eager (or
 * static-importing `pages/Diagnostics` anywhere) pulls `diagnostics/**` back onto
 * the critical path and re-bases BOTH ceilings.
 */
const Diagnostics = lazy(() =>
  import("./pages/Diagnostics").then((m) => ({ default: m.Diagnostics })),
);

export function App() {
  const [palette, setPalette] = usePalette();
  const [{ route, layer, address, focus }, navigate] = useRoute();
  const live = useLive();

  /**
   * Search text, owned HERE rather than by `Graph`.
   *
   * dataviz.md §04 requires a Tier C canvas to ship its search control in the
   * SURROUNDING CHROME, and FR-238 reserved the nav slot for exactly this. The
   * control and its consumer therefore sit on opposite sides of the shell, so
   * the state has to live at their common ancestor.
   *
   * FR-240 is the second consumer: on the layers route the same box is a
   * client-side text mute over the loaded rows. Both consumers treat it as a
   * MUTE over data in memory, never as a query — so sharing one state cannot
   * make one of them silently issue a request the other would not.
   */
  const [search, setSearch] = useState("");

  const pendingBrief = PENDING_ROUTES[route];

  return (
    <div className="shell">
      <Grain />
      <Cursor />
      <Nav
        route={route}
        onNavigate={navigate}
        palette={palette}
        onPalette={setPalette}
        live={live}
        search={search}
        onSearch={setSearch}
      />
      {/*
        `data-route` and the fallback's `data-route-loading` are the ROUTE
        READINESS CONTRACT (TD-347). They are product-visible on purpose:
        `browser-gate.mjs#Tab.routeReady` waits on them from `hash()` and
        `goto()`, which is EVERY gate in that file. Before TD-347 those two
        methods waited for `#main` to exist and then slept 400 ms — fine while
        the app was one chunk, and a race the moment a route's code arrives over
        the wire, because `#main` is mounted while the Suspense fallback is up.
        A readiness marker a test can WAIT on beats a sleep that has to be
        widened. Renaming either attribute silently returns all fifteen gates to
        sleep-based synchronisation; MAINTAINING.md carries the row.
      */}
      <main id="main" className="shell-main" data-route={route}>
        {pendingBrief ? (
          /*
           * OUTSIDE the Suspense boundary, deliberately: this branch renders
           * with no page module at all, so a reserved-but-unbuilt route must
           * never be able to suspend.
           */
          <StatePage
            inset
            variant="empty"
            headline={
              <>
                <em>not built yet.</em>
              </>
            }
            message={`${ROUTE_LABELS[route]} ships with ${pendingBrief}. The shell is ready for it.`}
            meta={`${pendingBrief} · pending`}
          />
        ) : (
          /*
           * ONE boundary for every lazy route, inside `<main>` — so the chrome,
           * the nav and the search box never unmount while a route's chunk is
           * in flight. The fallback reuses `StatePage variant="loading"`, which
           * already has the spinner and already spreads `...props` onto its
           * `<section>` (`components/ui/StatePage.tsx`), so the one new visual
           * surface this brief adds invents nothing.
           */
          <Suspense
            fallback={
              <StatePage
                inset
                variant="loading"
                data-route-loading=""
                headline={
                  <>
                    <em>{ROUTE_LABELS[route].toLowerCase()}</em> incoming.
                  </>
                }
                message="Deferred route — its code is arriving from the local server."
                meta={`${route} · chunk`}
              />
            }
          >
            {route === "graph" ? (
              <Graph search={search} focus={focus} />
            ) : route === "layers" ? (
              <Layers live={live} search={search} layer={layer} address={address} />
            ) : route === "triage" ? (
              /*
               * FR-241. The write affordances inside gate themselves on
               * `live.health.write.available` (see `pages/Triage.tsx#writeState`)
               * rather than being gated here: the READ half of this page is useful
               * on a machine whose write door is unavailable, and hiding the whole
               * tab would turn "the write surface is down" into "the queue does not
               * exist". *Disabled, not broken.*
               */
              <Triage live={live} search={search} />
            ) : route === "diagnostics" ? (
              /*
               * FR-266. It takes `live` for TWO reasons, and only one of them is
               * the usual one: `live.tick` is the beat the panel refetches on,
               * and `live.health.brain.path` is where the footer says the answer
               * came from — read from the shell's EXISTING health poll rather
               * than from a second request for the same fact.
               *
               * It takes NO `search` prop. The nav box is a MUTE over rows in
               * memory, and a roster of seven is not a list you filter.
               */
              <Diagnostics live={live} />
            ) : route === "search" ? (
              /*
               * FR-248. It takes NO `search` prop, and the omission is the
               * decision (D6): the nav box is a MUTE over data already in
               * memory, and this page's box is a QUERY that reaches five
               * readers. Handing this route the shell's state would make one of
               * the two a lie about its own cost, so `Nav.tsx` leaves the slot
               * empty here and the page brings its own control.
               */
              <Search live={live} />
            ) : (
              <Overview live={live} />
            )}
          </Suspense>
        )}
      </main>
    </div>
  );
}
