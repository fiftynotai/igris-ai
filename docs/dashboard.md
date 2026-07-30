# `igris dashboard`

**Brief:** FR-238 · **Status:** shipped

A persistent, live personal lens over the brain. `igris dashboard` starts a
loopback-only HTTP server and opens a browser at it. Nothing is regenerated:
reload the page and you see the state on disk right now.

This is the shell. FR-239 (graph canvas), FR-240 (layer views) and FR-241
(cognition triage) mount inside it.

```bash
igris dashboard                 # bind 7317 (or an OS port), open the browser
igris dashboard --port 8080     # exact port; if taken, HARD FAIL
igris dashboard --no-open       # do not launch a browser
```

Ctrl-C stops it. The verb runs in the **foreground** — see Lifecycle.

---

## Lifecycle

`igris dashboard` is the CLI's first long-lived process. The other verbs all run
and exit, so the model is stated explicitly rather than assumed.

**Foreground.** The terminal is occupied while the lens is open, and the OS
reaps the process with the terminal. There is no daemon, no `dashboard stop`, no
log file and no orphan class. SIGINT / SIGTERM close the server, release the
lock, and exit 0.

**Single instance.** `~/.igris/dashboard.lock` records
`{pid, port, url, started_at, process_start_time}`. A second `igris dashboard`
reads it, checks liveness with `cli/src/lib/process-liveness.ts` (`isProcessAlive`
plus `ps -o lstart=`, so a **recycled pid cannot masquerade** as a live
instance), and:

- **live** → prints the running URL, re-opens the browser at it, exits 0. It
  never binds a second port and never orphans the first instance.
- **dead pid / recycled pid / malformed** → reclaims the lock and starts
  normally. A crash can therefore never permanently wedge the verb.

**Port ladder.** Without `--port`: try `7317`, fall back to an OS-assigned port
on `EADDRINUSE`. The **actual** URL is always printed. With `--port <n>`: exact
or fail — explicit intent is never silently reassigned.

The lockfile honours `IGRIS_BRAIN_DIR`, like every other path helper.

---

## Security posture

The dashboard is the first network listener this CLI has ever opened, so:

| Property | Value |
|---|---|
| Bind address | `127.0.0.1` only. Never `0.0.0.0`, and not configurable. |
| `Host` header | Allowlist — `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`. Anything else → **403**. This is what defeats DNS rebinding: a page resolving `evil.test` to 127.0.0.1 reaches the socket but fails the header check. |
| CORS | **No CORS headers at all.** Without `Access-Control-Allow-Origin`, a cross-origin page cannot read a response even if it can cause the request. |
| Methods | `GET` and `HEAD` only. Everything else → **405**. |
| Write endpoints | **Zero.** FR-241 owns the write path and will have to add one deliberately. |
| Static serving | Path-traversal guarded (normalise, then resolved-prefix check — a LEXICAL check; see `static.ts` for why `realpath` is not needed while the bundle is a build artifact). Unknown extensions serve as `application/octet-stream`. |
| Response headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy: no-referrer` — on **every** response, from `dashboard/headers.ts`. The framing pair is defence in depth today (nothing to actuate on a read-only surface with no cookies) and lands now because **FR-241 adds the first write endpoint**, at which point a framed dashboard becomes a real clickjacking target. |
| Caching | `Cache-Control: no-store` on all of `/api/*`; `no-cache` on `index.html`; long immutable max-age only on content-hashed `assets/`. |
| Auth | None — and none is planned. It is loopback-only and read-only. |

---

## API surface

All read-only. All same-origin. Every response carries a `degraded` field with
the same shape.

| Method | Path | Response | Backed by |
|---|---|---|---|
| `GET` | `/api/health` | `{ok, cli_version, brain:{present,path}, bridge:{available,reason}, generated_at, degraded}` | `paths.ts#brainDbPath` + `brain-bridge.ts#probe` |
| `GET` | `/api/projects` | `{projects:[{slug,name,path,status,last_session_at}], default_project, generated_at, degraded}` | `registry.ts#listProjects` + `dashboard/default-project.ts` |
| `GET` | `/api/summary?project=<slug>` | `{project, briefs:{total,by_status,by_priority}, instances:{active}, generated_at, degraded}` | `brain-db.ts#briefStatusSummary` + `#listInstances` |
| `GET` | `/api/graph/stats?project=<slug>` | `{project, stats, edge_resolution, truncated, truncation_reason, generated_at, degraded}` | `brain-bridge.ts` → FR-237 `buildBrainGraph` |
| `GET` | `/api/graph?project=<slug>` | `{project, nodes, edges, stats, truncated, truncation_reason, query, generated_at, degraded}` | `brain-bridge.ts` → FR-237 `buildBrainGraph` + `dashboard/graph-query.ts` |
| `GET` | `/`, `/assets/*`, `/fonts/*` | the static bundle; unknown non-asset paths fall back to `index.html` | `dashboard/static.ts` |

### `/api/graph` — the node/edge payload (FR-239)

The fifth endpoint, and the only one that is expensive. It serves the arrays
`/api/graph/stats` deliberately strips.

**Why a second endpoint rather than a flag on the first.** `/api/graph/stats` is
the cheap always-safe readout the Overview polls every five seconds; this one is
a ~1 MB body fetched **once per scope**. Merging them would either make the
Overview's poll expensive or make the payload optional — and an optional payload
is a shape the browser has to branch on forever.

**Measured on the live brain, 2026-07-29.** These figures **drift** — the brain
is written to continuously, so re-measuring will not reproduce them exactly.
Across three independent measurements taken hours apart the node count moved
2,429 → 2,433 and the edge count 1,001 → 1,008 while the payload stayed within
~1.5 KB of 984,000. Read the magnitudes, not the digits.

| | Cold | Warm (steady state) |
|---|---|---|
| `buildBrainGraph` in isolation | ~93 ms | **~12 ms** (10.9–12.6, median 12.1) |
| `GET /api/graph` end-to-end over loopback | 100–240 ms | **~22 ms** (19.5–23.5) |

Payload ≈ **984 KB** for ~2,430 nodes and ~1,000 edges.

**The cold figure is not one number, and the spread is the interesting part.**
A first-ever `/api/graph` on a freshly started server measured 240 ms; the same
call measured 118 ms when `/api/health` had run first. The difference is the
runtime `import()` of the vendored FR-237 builder, which `probe()` pays on the
first health poll — so in real use the browser has already absorbed it before
the graph route is ever opened.

**No response memo is applied.** At ~12 ms warm, a memo keyed on
`(project, brain mtime)` would be cache-invalidation machinery guarding a cost
smaller than the JSON serialisation beside it. Revisit if the builder ever
crosses ~500 ms — the durable claim here is *"fast enough that a memo is
unjustified complexity"*, not any particular millisecond count.

*Provenance note: an earlier revision of this file recorded "builder latency
143 ms". That was a single COLD sample from a throwaway script, so it conflated
module load and first-call JIT with the builder's actual cost and did not
reproduce. Timing figures in this section are now best-of-N after a warm-up,
with the cold case reported separately — the same discipline
`graph/__tests__/volume.test.ts` uses, and for the same reason.*

**No second cap.** FR-237's own tripwires (15,000 nodes / 20,000 edges) are the
only ceilings. A render-side cap here could silently disagree with
`docs/architecture/whole_brain_graph.md` §5, and density is the dataviz
degradation ladder's concern, not the transport's.

**The `query` field is the surface's twin**, composed server-side
(`dashboard/graph-query.ts`, pure). `docs/brand/dataviz.md` exemption 04 requires
every data-viz surface to expose the query that produced its node set:
*"Unreproducible canvases are forbidden."* It is composed on the SERVER because a
twin the browser assembles describes the bytes that arrived, not the question
that produced them. It ships even when the read fails, because "why is it empty"
is exactly the question a reader has in that state.

Each clause names a **real** predicate — the learnings gate is
`review_status = 'approved'`, sessions are adjacency-only, concept/decision come
from `graph_nodes`, and edges soft-delete through `metadata.$.deleted` rather
than a `deleted_at` column. A plausible-but-false predicate is worse than an
omitted one: it is a reproduction step that silently does not reproduce.

**The graph does NOT refetch on the live tick.** Every other page keys its reads
off the five-second `/api/health` beat. This one does not — see "The graph fetch
model" below.

### `default_project` — which project the lens opens on

`/api/projects` carries the slug the shell selects on **first load**. It is
resolved server-side, because the top rung of the ladder is the directory the
CLI was invoked from and the browser cannot know that.

1. **The project you ran `igris dashboard` in** — cwd inside a registered
   project's `path` (works from any subdirectory; the deepest match wins, so a
   nested registered project beats its parent), else `basename(cwd)` matching a
   slug exactly (the fallback for a row whose recorded path is stale).
2. **Most recently active** — the newest `projects.last_session_at`.
3. **First alphabetically** — the final fallback, so a non-empty list is never
   left with nothing selected.

Two deliberate non-behaviours. It is an *initial selection*, not a constraint:
the project switcher stays free. And it will **not** skip a resolved default
that happens to have no data — an empty lens on the repo you are standing in is
a true statement about the brain, and quietly swapping it for a busier project
would make the dashboard lie about where you are.

The ladder is a pure function (`dashboard/default-project.ts`) over the rows
`listProjects` already returned — no second query, and no selection logic in
`routes.ts`.

**`/api/graph/stats` strips `nodes` and `edges` at the route layer.** That is a
structural fence, not a convention: the shell physically cannot render a graph
from this response, so FR-239's scope cannot leak backwards into the shell. It
also keeps the payload a few KB regardless of brain size.

### The degraded contract

**No endpoint ever returns 4xx or 5xx for a degraded brain.** A missing,
empty, unmigrated or corrupt brain database yields **HTTP 200** with empty data
and `degraded: {reason}`. A degraded brain is an ordinary state of a personal
lens, not an error. The only non-200 responses are `400` (malformed request),
`403` (rejected `Host` / traversal), `404` (unknown endpoint or missing asset)
and `405` (a write method).

---

## Architecture

```
igris dashboard (verb)
  ├─ lock.ts        single-instance guard over process-liveness.ts
  ├─ open-url.ts    cross-platform browser ladder
  └─ server.ts      node:http, 127.0.0.1, Host guard, traversal guard
       ├─ static.ts   dist/dashboard/** + SPA fallback
       └─ routes.ts   the four endpoints — CONTAINS ZERO SQL
            ├─ registry.ts#listProjects
            ├─ brain-db.ts#briefStatusSummary / #listInstances
            └─ brain-bridge.ts ──runtime import()──▶ vendored FR-237 pure builder
```

**The server layer holds no SQL of its own.** Reads go through exactly two
doors: the FR-237 pure builder, or the existing MAINTAINING-pinned CLI
accessors. This is asserted mechanically by `dashboard-server.test.ts`.

### The brain bridge

`cli/` and `brain-mcp-server/` are separate npm packages with **zero
cross-imports**, but `MAINTAINING.md` row 105 requires FR-238 to import the pure
`buildBrainGraph` rather than re-query `entity_edges`. Both constraints are real,
and the resolution is a **runtime dynamic `import()`** of the vendored build
artifact at:

```
cli/dist/brain-mcp-server/dist/engine/components/edges/whole-graph.js
```

with a repo-checkout fallback at `<repo>/brain-mcp-server/dist/engine/` for
development. The CLI brings its own read-only `better-sqlite3` handle, opened
**per request** and closed after — which is why a `/hunt` writing to the brain
is visible on the next reload with no regeneration step.

This is a **path-literal dependency on a build artifact**. If the staging layout
moves, the import fails and the bridge degrades to `null` rather than throwing —
so `/api/health` surfaces `bridge.available` and the shell renders a visible
"BRAIN ENGINE UNAVAILABLE" banner. A silent degrade is converted into a loud
one.

---

## The UI

The shell ports the fifty.dev design language: the four palettes
(`blood`/`cyber`/`acid`/`mono`), the 3-tier type stack (Anton / Space Grotesk /
JetBrains Mono, **vendored**, no CDN), sharp corners, `.5px` hairline borders,
the SVG-turbulence grain overlay, the ring+dot cursor, glitch-on-heading, and a
`prefers-reduced-motion` block that zeroes every animation.

`cli/dashboard/PORTING.md` maps every ported file to its fifty.dev origin and
records each deliberate divergence. Read it before reconciling the two
codebases.

**No network fetch at runtime.** No CDN scripts, no CDN fonts, no remote
assets — everything is served from the local bundle. This is asserted against
the *built artifact* by `dashboard-artifact.test.ts`, which checks both fetch
positions and an adjudicated allowlist of non-fetch URL literals. The graph
library (FR-239) is a **devDependency bundled by Vite**, never a runtime fetch
and never a runtime dependency.

---

## The graph view (FR-239)

`#/graph` renders the whole brain as a `force-graph` canvas against
`docs/brand/dataviz.md`. The library owns layout, camera, drag and hit-testing;
**we own every painted pixel**, because the paint layer is the brand.

### The graph fetch model — deliberately NOT the shell's

Every other page in this shell refetches on `live.tick`, the five-second
`/api/health` beat. **The graph fetches once per scope.** The divergence is a
decision, and the reasons are worth ranking honestly, because they are not
equally strong:

- **The load-bearing reason: a new payload re-runs the force simulation.** The
  canvas would re-settle every five seconds. `dataviz.md` forbids an idling
  simulation by name — *"A graph that keeps jiggling is a `// LOOP` with extra
  steps"* — and an ambient re-layout is precisely what the stillness gate below
  exists to catch. This reason alone decides it.
- **A real but secondary reason: ~984 KB on the wire every five seconds,
  forever**, for a view that is usually idle. Wasteful rather than wrong.
- **Cost is NOT much of a reason, and it would be dishonest to lean on it.** At
  ~12 ms warm the builder is cheap; a five-second refetch would not be
  noticeably expensive to produce. An earlier revision of this file argued from
  a ~143 ms builder figure that did not reproduce. Deleting that argument does
  not weaken the conclusion, because the first reason never depended on it.

Staleness is therefore carried **visibly**, by the `AS OF` line in the query
twin, and cleared by the explicit `REFRESH` control. The twin is not decoration
here; it is the page's freshness indicator.

**Filtering and drilling are different operations.** A type filter or a search is
a client-side *mute* over the payload already in memory (`// QUICK`). A project
drill is a real scope change — a refetch returning a different node set plus its
depth-1 `boundary` nodes (`// SLOW`). Backing out restores the cached payload and
its settled node positions, so it is a page transition rather than a second
entrance.

### AC #5 — the stillness checkpoint, and how to run it honestly

> *"Nothing moves visibly at rest. After the entrance settles, no node or edge
> changes position or appearance without pointer input."*

FR-239's plan chose a graph library over a bespoke renderer. That trade is
recorded because it changed what this AC can mean: stillness was going to be
**structural** (one `requestAnimationFrame` call site, mechanically scanned) and
is now **empirical** (a pixel diff). The honest limit, stated once: *a library
that repaints identical pixels forever would pass a pixel diff.*

**That is not hypothetical — it happened during FR-239 and was caught here.**
`force-graph` fires `onEngineStop` from *inside* its own frame callback, and that
callback re-arms the next frame after the callback returns. Calling
`pauseAnimation()` inline cancelled a frame that had already fired and was
immediately undone. The canvas reported `still`, the pixel hash was stable, and a
painted-frame counter climbed from 68 to 501 over 17 seconds. The fix defers the
halt by one macrotask (`graph/instance.ts#haltLoop`); the counter now stays flat.

So the checkpoint has **four** required readings, not one:

```
# 1 · AT REST — must be identical
open #/graph, wait for the entrance to settle, give no pointer input
> await __igrisGraphStillness.probe(3000)
  expect { identical: true, samples: 1 }

# 2 · NEGATIVE CONTROL — must NOT be identical
reload, and run the probe DURING the entrance
> await __igrisGraphStillness.probe(3000)
  expect { identical: false, samples: > 1 }

# 3 · FRAME COUNT — must not advance at rest
> const a = __igrisGraphStillness.paints()
> await new Promise(r => setTimeout(r, 3000))
> __igrisGraphStillness.paints() - a
  expect 0

# 4 · LIVENESS — the canvas must still be ALIVE, not merely still
move the pointer over a node, without clicking
> the frame counter ADVANCES, the node takes the accent emphasis,
>   and its label appears
stop moving, wait out the pointer-idle window
> the counter returns to flat
then click the node
> it SELECTS (the inspector fills). It must not deselect.
```

**Reading 2 is what makes reading 1 mean anything. If the negative control also
returns `true`, the probe is broken and the at-rest result is worthless** — do
not record the pass. Reading 3 is what separates "still" from "repainting
identical pixels", which reading 1 alone cannot see.

**Reading 4 exists because readings 1–3 cannot tell STILL from DEAD, and for a
while this canvas was dead.** `pauseAnimation()` is `cancelAnimationFrame`, and
the library puts hit-testing, the `onNodeHover` dispatch and the shadow-canvas
refresh *inside* that same loop. Using `onNodeHover` as the wake-up path was
circular — a callback that lives inside the paused loop can never restart it. So
hover did nothing, pan and drag changed the transform without repainting, and
`pointerup` read a `hoverObj` frozen at `null`, which made **clicking a node
deselect it**. Every stillness reading passed, correctly: a dead canvas is
perfectly still.

The tell, in hindsight: **the only surviving wake-up paths were the palette
observer and the filter effect — both driven from outside the canvas.** That is
why a palette switch worked as a negative control when a pointer would not have.
**Run the negative control with a pointer where you can**; a control that
exercises a different wake-up path than the one under test is how this hid.

The fix moved the interaction boundary onto **DOM listeners on
`.graph-canvas-host`** (`pointerenter` / `pointermove` / `pointerdown` /
`pointerup` / `pointerleave` / `wheel`), plus `onZoom` / `onNodeDrag`, which
fire from d3 DOM handlers rather than from inside the loop. It is latched and
re-pauses after a `// STD` idle window.

### Use an independent instrument where you can

Reading 3 above uses `__igrisGraphStillness.paints()`, which is **the app's own
counter, incremented in the app's own `drawOverlay`** — precisely the class of
self-witnessing instrument this section warns about two paragraphs earlier. It
is convenient, and it is the weaker option.

The stronger form, and what a reviewer should run, installs its own witnesses
over CDP **before app code loads**:

```js
// Before the bundle evaluates:
//   1. wrap CanvasRenderingContext2D.prototype.clearRect and count calls
//   2. wrap requestAnimationFrame and count callbacks
// Then, at rest over ~17s, all three must agree:
//   appPaints +0 · clearRect +0 · rAF +0
```

Three independent witnesses agreeing is a materially stronger result than one
app-owned counter. **Negative-control the instrument itself** — a stuck counter
reads as `+0` and passes vacuously. Trigger any interaction and confirm the
independent counters move (a palette switch moved `clearRect` 111 → 122); then
confirm they return to flat.

The probe hashes the **full DPR-scaled backing store** with FNV-1a and has **no
tolerance parameter**, deliberately: a tolerance is how this gate gets quietly
faked. It samples every 250 ms across the window rather than at the endpoints, so
a canvas that drifts and returns cannot slip between two captures.

`window.__igrisGraphStillness` is a **diagnostic, not a contract.** It must never
acquire an external consumer.

**What the automated tests do and do not prove.**
`graph/__tests__/stillness.test.ts` tests the *instrument* against four surfaces
(static, mutating, mutate-and-restore, one byte of ~8 M) — a probe hard-coded to
`true` fails three of them. `graph/__tests__/instance.test.ts` and
`dashboard-graph-source.test.ts` guard **our** code against reintroducing motion:
the pause is wired to `onEngineStop` and is never called inline, `resumeAnimation`
is reachable only from an interaction entry, there is no `requestAnimationFrame`
or `setInterval` in the graph source, and the library API is touched in one file.
None of them prove the library is still. That is what the checkpoint is for.

### Brand rules this canvas is held to

- **Zero colours outside the role tokens.** Every colour on the canvas resolves
  through `graph/palette.ts`, which reads only the five `--dataviz-*` custom
  properties. Those are declared on `body`, **not** `:root` — a `var()` in a
  custom property substitutes against the element it is declared on, so a
  `:root` declaration would freeze to the default palette and every palette would
  render identically. (It did, until the end-to-end run caught it.)
- **Five node shapes, four edge types.** No sixth of either. The finer domain
  type is text, never geometry.
- **`hot` is unreachable at rest** — it exists only while a trace is running.
- **Direction is deferred at Tier C, never discarded** — resting edges drop their
  arrowheads; the active set gets them back.
- **Every timing is a `motion.md` token**, resolved from `--t-*` / `--e-*` at
  runtime. `// LOOP` has no CSS alias, so it cannot be referenced by accident.
- **The camera is never handed a duration.** `centerAt(x,y,ms)` and `zoom(k,ms)`
  apply the library's own easing, which is not one of the four; every camera move
  is a GSAP tween on a token duration whose `onUpdate` calls the instantaneous
  form. Pinned by a source scan.
- **A drill-down is a page transition, not a second entrance.** The `// CINE`
  entrance fires once per scope; a subgraph swap runs `// SLOW`, per the spec's
  rule that the entrance "never re-fires on filter or re-layout".
- **Clearing a selection eases out; it does not snap.** The whole deselect is
  driven by one scalar — the selection ring falling 1 -> 0 — with `selected` and
  the active sets HELD until it lands, so the ring shrinks and fades, the node's
  accent mixes back toward bone, and the 1-hop edges return to their resting
  role over the same curve. When the scalar reaches 0 the canvas is already at
  its resting appearance, so dropping the state afterwards is invisible.

  An earlier revision tweened the ring while `selected` had *already* been set
  to `null`, and `drawNode` guards the ring on `selected` — so the tween painted
  no ring at all (measured: zero `arc()` calls across the whole 320 ms clear,
  against 22 per frame while selected). The repaint was real and the outcome
  correct, but it was an invalidation wearing a tween's clothes, and the comment
  claimed otherwise.

### Known gap — ladder rung 6 is not implemented

`dataviz.md`'s sixth and last degradation rung says that below the `--s-1` floor
nodes collapse into **cluster nodes carrying their count**. **This canvas does
not aggregate.** The `fitsAtFloor` predicate ships and is tested against a
20,000-node fixture, and the surface raises a DENSITY banner when it trips — but
no cluster node is ever drawn.

What actually happens past the floor is that silhouettes overlap. Nothing
vanishes, so the spec's *"a node never silently disappears"* still holds, and
the banner names the real remedy (filter by type, or drill into a project)
rather than describing a feature that does not exist. It does not fire on
today's brain: ~2,430 nodes at the 8 px floor need ~155,000 px² against a
~315,000 px² allowance.

An earlier revision of the banner asserted the clusters. That was a false
statement to the operator at exactly the moment they most needed an accurate
one.

---

## Building

The bundle is built by `cli/scripts/build-dashboard.sh`, wired into
`cli/package.json`'s `build`:

```
tsc && bash scripts/copy-templates.sh && bash scripts/build-dashboard.sh
```

`prepublishOnly` is already `npm run build`, so publishing always rebuilds. The
script runs `vite build` **unconditionally** — there is deliberately no
"skip if `dist/dashboard` exists" shortcut, because that is precisely how a
stale bundle ships. It prints measured byte sizes on every run, and
`dashboard-artifact.test.ts` additionally fails if any source under
`cli/dashboard/{src,public}` is newer than the built `index.html`.

`cli/package.json` `files` already lists `"dist"`, so `dist/dashboard/**` ships
with no manifest change. `tarball.test.ts` asserts that it actually does, and
that the packed size stays under the FR-238 ceiling.

All build dependencies (vite, react, react-dom, tailwind, gsap) are
**devDependencies**. `npm i -g igris-ai` installs **zero** new runtime deps —
the server is `node:http`.

---

## Testing

| Suite | Covers |
|---|---|
| `cli/src/__tests__/dashboard-server.test.ts` | bind, static, traversal, Host allowlist, CORS absence, security headers on every response class, method guard, the four endpoints, four degraded brains, the zero-SQL scope assertion |
| `cli/src/__tests__/dashboard-lock.test.ts` | lock write/read/atomicity, **0600 mode (including the stale-tmp rewrite path)**, liveness classification, pid reuse, stale reclaim, ownership-checked release |
| `cli/src/__tests__/brain-bridge.test.ts` | module resolution in a built tree, memoisation, read-only handle, every degradation path |
| `cli/src/__tests__/dashboard-artifact.test.ts` | bundle present, bundle current (stale guard), AC #4 no-network |
| `cli/src/__tests__/open-url.test.ts` | every rung of the ported open ladder |
| `cli/src/__tests__/tarball.test.ts` | `npm pack` manifest + packed-size ceiling — **+400 KB** over baseline, the single asserted number. FR-239 measured **+283.4 KB**, leaving ~116.6 KB for FR-240/241. The budget is cumulative across the family, not per-brief. |
| `cli/src/__tests__/dashboard-graph-endpoint.test.ts` | `/api/graph` payload shape field-for-field, project drill-down + `boundary` nodes, four degraded brains, inherited security posture |
| `cli/src/__tests__/dashboard-graph-query.test.ts` | the exemption-04 twin: whole-brain, scoped, truncated, degraded; the cap constants checked against the real engine |
| `cli/src/__tests__/dashboard-graph-source.test.ts` | zero colour literals in the graph source, the F2 camera scan, library-API confinement, zero rAF/`setInterval`, token-only timings |
| `cli/dashboard/src/graph/__tests__/` | the stillness instrument (**T6, the anti-fake layer**), the pause/resume state machine, tiers + the ladder, label occlusion, D9 shape/edge mappings, palette resolution, motion tokens, and the volume bench |
| `cli/tests/integration/dashboard.bats` | lifecycle, double invocation, stale locks, `--port` hard-fail, degraded brain, pack-extract smoke, `/api/graph` on a seeded and a missing brain |

Browser-side tests live under `cli/dashboard/src/graph/__tests__/` and are
collected by the **`cli` vitest run** (verified empirically with `npx vitest list`
before any of them were written — a test that does not run is worse than no
test). They run in the node environment, so every module they reach is DOM-free;
that is why `graph/instance.ts` receives its `force-graph` constructor as a
parameter rather than importing it.

Both suites run in CI on push and PR via `.github/workflows/test.yml`'s
`cli-bats` job, alongside `npm run typecheck:dashboard`.

**`vite build` does not typecheck.** esbuild strips types without checking
them, and `cli/dashboard/tsconfig.json` is isolated from `cli/tsconfig.json` (the
app must not enter `rootDir: ./src`), so the `tsc` in `npm run build` never sees
the app either. `npm run typecheck:dashboard` (`tsc --noEmit -p dashboard`) is
the only thing that does, which is why it is a CI step and not just a
convenience script.

### Manual checkpoint (operator)

The pack-extract smoke covers the `files` glob, asset base paths and bundle-root
resolution outside a repo, but it cannot cover a genuine global install
(`npm i -g` performs a runtime-dependency install and creates a **symlinked**
bin). That last mile is a manual gate:

```bash
cd cli
npm run build
npm pack
npm i -g ./igris-ai-*.tgz
igris dashboard
```

Confirm: the browser opens · the UI is recognisably a fifty.dev surface ·
all four palettes switch across every component · data renders · Ctrl-C exits
cleanly and removes `~/.igris/dashboard.lock`.

Then, on `#/graph`:

- the **four AC #5 readings** above, with the negative control recorded
  alongside the pass — and reading 4 (LIVENESS) is not optional: readings 1-3
  cannot tell a still canvas from a DEAD one, which is the failure that shipped
  once already;
- **frame timing** — pan, hover and select at the real node count with the
  DevTools performance panel open; no dropped frames. Real frame timing is not
  reachable from vitest, and saying so beats a green test that proves less than
  a reader assumes;
- **reduced motion** — enable it at the OS level, reload, and confirm the graph
  arrives already settled with no entrance journey.

---

## Out of scope

Layer views (FR-240) · cognition triage (FR-241) · **all write actions**
(FR-241 owns the write path) · auth, remote hosting, per-user identity · a
`/dashboard` skill (the verb is the product).

`NodeInspector` renders payload fields only and issues **no second fetch** — the
moment it needs one it has become FR-240's, because FR-237's scale argument
rests on this layer returning no body content.
