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
| `GET` | `/`, `/assets/*`, `/fonts/*` | the static bundle; unknown non-asset paths fall back to `index.html` | `dashboard/static.ts` |

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
positions and an adjudicated allowlist of non-fetch URL literals.

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
| `cli/src/__tests__/tarball.test.ts` | `npm pack` manifest + packed-size ceiling |
| `cli/tests/integration/dashboard.bats` | lifecycle, double invocation, stale locks, `--port` hard-fail, degraded brain, pack-extract smoke |

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

---

## Out of scope

The graph canvas (FR-239) · layer views (FR-240) · cognition triage (FR-241) ·
**all write actions** (FR-241 owns the write path) · auth, remote hosting,
per-user identity · a `/dashboard` skill (the verb is the product).
