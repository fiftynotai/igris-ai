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
| Methods | `GET` and `HEAD` everywhere. **`POST` on exactly one path, `/api/triage`** (FR-241). Every other method on every path, and a `POST` on any other path, → **405**. |
| `Origin` header (POST only) | Absent (a `curl`, the `--smoke` probe) or **exactly** the served origin → allowed; anything else, including the literal string `null`, → **403**. Compared as a whole string against both loopback spellings, never by `startsWith`: `http://127.0.0.1:7317` is a prefix of `http://127.0.0.1:7317.evil.test`. |
| `Content-Type` (POST only) | `application/json` required → otherwise **415**. This is the fence that actually blocks the classic no-JS CSRF: an HTML `<form>` can POST cross-origin without a preflight, but only as `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`. Requiring JSON forces a preflight, which the `Origin` fence then answers. |
| Request body cap (POST only) | 64 KB, enforced **while reading** rather than after → otherwise **413**, so an unbounded upload is never buffered first and rejected second. |
| Write endpoints | **Exactly one, since FR-241: `POST /api/triage`.** Every mutation it performs is a `gateway.dispatch` of a tool named by a frozen map (five rows at FR-241, seven since FR-247, EIGHT since FR-249) — there is no code path in this tier that writes any other way. See *The write path* below. |
| Static serving | Path-traversal guarded (normalise, then resolved-prefix check — a LEXICAL check; see `static.ts` for why `realpath` is not needed while the bundle is a build artifact). Unknown extensions serve as `application/octet-stream`. |
| Response headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy: no-referrer` — on **every** response, from `dashboard/headers.ts`. The framing pair landed in FR-238 as defence in depth on a then-read-only surface with nothing to actuate and no cookies, in anticipation of a write endpoint. **FR-241 added that endpoint**, so the pair is now load-bearing rather than anticipatory: a framed dashboard with a working bulk-reject button is a real clickjacking target. |
| Caching | `Cache-Control: no-store` on all of `/api/*`; `no-cache` on `index.html`; long immutable max-age only on content-hashed `assets/`. |
| Auth | None — and none is planned. It is loopback-only, and the write endpoint is fenced by the four rows above rather than by a credential. What that does **not** defend against, stated rather than implied: a malicious browser extension, or another process running as the operator on this same machine. A loopback personal tool cannot, and this document does not pretend otherwise. |

---

## API surface

**Read paths and exactly one write path.** The table below is the enumeration —
do not restate its size here; `server.ts`'s route arms are the source of truth
and `cli/src/__tests__/dashboard-count-derivation.test.ts` pins the three
instruments that mirror them. All same-origin. Every response carries
a `degraded` field with the same shape. Every GET is a read; the single POST is
the write path FR-241 added, and it is the only endpoint on this surface that
changes a row.

| Method | Path | Response | Backed by |
|---|---|---|---|
| `GET` | `/api/health` | `{ok, cli_version, brain:{present,path}, bridge:{available,reason}, generated_at, degraded}` | `paths.ts#brainDbPath` + `brain-bridge.ts#probe` |
| `GET` | `/api/projects` | `{projects:[{slug,name,path,status,last_session_at}], default_project, generated_at, degraded}` | `registry.ts#listProjectsReadonly` + `dashboard/default-project.ts` |
| `GET` | `/api/summary[?project=<slug>]` | `{project, briefs:{total,by_status,by_priority}, instances:{active}, generated_at, degraded}` | `brain-db.ts#briefStatusSummaryReadonly` + `#listInstancesReadonly` |
| `GET` | `/api/graph/stats?project=<slug>` | `{project, stats, edge_resolution, truncated, truncation_reason, generated_at, degraded}` | `brain-bridge.ts` → FR-237 `buildBrainGraph` |
| `GET` | `/api/graph?project=<slug>` | `{project, nodes, edges, stats, truncated, truncation_reason, query, generated_at, degraded}` | `brain-bridge.ts` → FR-237 `buildBrainGraph` + `dashboard/graph-query.ts` |
| `GET` | `/api/briefs` | `{items, count, total, limit, offset, params, generated_at, degraded}` | `brain-bridge.ts#loadLayerReaders` → `briefs-read.ts#listBriefs` |
| `GET` | `/api/briefs/search?q=<query>[&project=<slug>]` | `{query, items, count, retrieval, params, generated_at, degraded}` | `briefs-read.ts#hybridSearchBriefs` — **FR-246, the one path it adds** |
| `GET` | `/api/search?q=<query>[&project=<slug>][&limit=<n>][&layers=<csv>]` | `{query, items, count, layers, fusion, params, generated_at, degraded}` | `search-fuse.ts#fuseLayers` + `routes.ts#fusedSearch` — **FR-248, the one path it adds.** `layers[]` ALWAYS has all five entries so an unavailable layer is REPORTED, never absent; every row carries `layer` and `rank_basis`; `fusion` holds the INTER-layer `rrf_k` and is distinct from each layer's own `retrieval.rrf_k` |
| `GET` | `/api/brief?project=<slug>&id=<brief_id>` | `{brief, generated_at, degraded}` | `briefs-read.ts#getBrief` |
| `GET` | `/api/learnings[&q=<text>]` | `{items, count, total, limit, offset, review_status, search, params, generated_at, degraded}` | `memory-read.ts#listLearnings` |
| `GET` | `/api/learnings/search?q=<query>[&project=<slug>][&review_status=<scope>]` | `{query, items, count, retrieval, review_status, params, generated_at, degraded}` | `memory-read.ts#hybridSearchLearnings` — **BR-085**: `review_status` is FORWARDED (both RRF arms plus hydration bind it, default `approved`), and the payload's `review_status` is the scope the reader APPLIED, not the one requested |
| `GET` | `/api/learning?id=<n>` | `{learning, generated_at, degraded}` | `memory-read.ts#getLearning` |
| `GET` | `/api/context-docs?project=<slug>[&q=<text>]` | `{project, archetype, tech_stack, inventory_degraded, docs, missing_applicable, remediation, search, generated_at, degraded}` | `verbs/context-docs.ts#buildContextDocsInventoryDigest` — **no brain read**; `q` is a bounded body GREP through `context-docs-read.ts#grepDocs` |
| `GET` | `/api/context-doc?project=<slug>&type=<doc type>` | `{project, type, target, content, bytes, truncated, generated_at, degraded}` | `dashboard/context-docs-read.ts` — a guarded disk read |
| `GET` | `/api/goals[&q=<text>]` | `{items, count, total, limit, offset, search, params, generated_at, degraded}` | `goals/read.ts#listGoals` |
| `GET` | `/api/goal?id=<GL-XXX>` | `{goal, serving_briefs, serving_learnings_count, generated_at, degraded}` | `goals/read.ts#getGoal` |
| `GET` | `/api/suggestions?project=<slug>` \| `project_scope=brain-level`, `&status=&priority=&source_module=&q=` | `{items, count, total, limit, offset, facets, search, params, generated_at, degraded}` | `suggestions-read.ts#listSuggestions` |
| `GET` | `/api/cognition` | `{cognition, generated_at, degraded}` — `cognition` is the `igris cognition health` digest FORWARDED VERBATIM (`degraded`, `degraded_reason`, `hostname`, `event_log_retention_days`, `event_log_oldest_at`, `instances[]`, `warnings[]`) | `dashboard/cognition-read.ts` -> `verbs/cognition.ts#buildCognitionHealthDigest` — **FR-266, the one path it adds.** NO PARAMETERS: the digest is per-MACHINE and per-REGISTRY, so there is no project axis to scope it to. TWO `degraded` FIELDS AT DIFFERENT DEPTHS AND THEY ARE NOT SYNONYMS: the envelope's means there is no brain, `cognition.degraded` means the brain is readable but carries no `cognition_instances` table (an old build). Different remedies |
| **`POST`** | **`/api/triage`** | body `{action, ids, reason?, brief_id?}` → `{action, requested, applied, failed, results, params, generated_at, degraded}` | `brain-write-bridge.ts#dispatchTriage` → the brain's own `gateway.dispatch` |
| `GET` | `/`, `/assets/*`, `/fonts/*` | the static bundle; unknown non-asset paths fall back to `index.html` | `dashboard/static.ts` |

#### `/api/summary` — omitting `project` is a request, not a mistake (BR-082)

`project` is **optional**. Omitted, the predicate is dropped and the response
carries `project: null` with counts over every row — and that is a normal
answer, not a `degraded` one. Until BR-082 it returned empty counts and
`degraded: "no project selected"`, which was right only while the sole caller
was an Overview page that could not clear its scope.

**The unscoped read is `everything`, which is not the same set as "all
projects", and the difference is per-table:**

| Field | Unscoped meaning | Same as the sum over projects? |
|---|---|---|
| `briefs.*` | every `brief_status` row | **yes** — `project` is `NOT NULL` with a declared FK to `projects(slug)`, and better-sqlite3 enables `foreign_keys` by default on **every** handle (measured), so deleting a project that still has briefs is BLOCKED rather than orphaning them. Measured against the real schema: `DELETE FROM projects WHERE slug='igris-ai'` (654 briefs) → `FOREIGN KEY constraint failed`. Since BR-084 `doctor --remove-orphans` treats that refusal as a per-project result: it reports the project as skipped with the count of rows that blocked it, keeps its registry row, and sweeps the remaining orphans in the same run (it used to let the throw abort the whole sweep) — see the CLI-connection note in `brain-db.ts`. |
| `instances.active` | every active instance | **no** — `project_slug` is nullable with no FK, so a session belonging to no project is in this count and in no project's count |

`dashboard-server.test.ts` seeds exactly such a project-less session and asserts
the difference is 1, so the distinction is a gate rather than a paragraph. It is
TD-326's `everything` scope, **not** its `brain-level` one (`project IS NULL`),
which this endpoint does not offer. Nothing here counts `suggestions`, the table
where the two sets diverge by 377 rows.

#### `/api/suggestions` — the project axis has THREE states (TD-326)

`suggestions.project_slug` is **nullable with no FK**, and on the operator brain
**377 of 1,210 pending rows carry NULL** — synapse's `edge_inference` output
(FR-211), which belongs to the knowledge graph rather than to any project. A
project-scoped read can neither list those rows nor count them, which is the
whole of TD-326: two correct behaviours (a nullable column and a correct filter)
intersecting to hide a third of the queue.

| Request | Predicate | Set |
|---|---|---|
| `?project=<slug>` | `project_slug = ?` | one project |
| `?project_scope=brain-level` | `project_slug IS NULL` | the rows that belong to **no** project |
| neither | *(none)* | `everything` — every row, project-bearing or not |

These are **three different sets**, and `brain-level` is not a synonym for the
unscoped read. `everything` = `<each project>` ∪ `brain-level`; the browser gate
asserts that arithmetic on the fixture (6 + 2 + 4 = 12) rather than describing it.

**Why a separate param rather than a reserved `project` value.** `project`'s
spec is `allowed: null` — any non-empty string is accepted verbatim, because the
value space is the registry rather than a fixed vocabulary. A magic slug there
would be bound literally by every other project-bearing endpoint that does **not** implement this
scope and would silently match nothing. An **undeclared** param is reported
(`unknown filter: project_scope` in `params`) by the endpoints that route
through `parseFilters` — `/api/briefs`, `/api/briefs/search`, `/api/search`,
`/api/learnings`, `/api/learnings/search`, `/api/goals` — and merely IGNORED
by the rest, which hand-parse it or take `project` as an argument. The
enumeration is the derivation; its size is not written down anywhere on this
surface. Partial reporting, total safety: the posture that
matters is that no endpoint BINDS it. `project_scope`'s own vocabulary is CLOSED
(`PROJECT_SCOPES`), so a near miss like `?project_scope=everything` — the other
scope name in this product — is dropped and **named** rather than guessed at.

Supplying both is a contradiction whose intersection is empty, so `project` is
dropped and named in `params`; `project_scope` wins.

**`facets.brain_level`** is the count of `project_slug IS NULL` rows over the
active filters **minus the project axis** — the same minus-its-own-clause rule
`facets.source_module` follows, one axis over. That is what lets a
project-scoped payload state the size of the population its own scope excludes;
a count that also applied the caller's `project_slug` would read 0 for every
scoped request. Under `project_scope=brain-level` it equals `total`.

The browser client's UI token for this scope is `(brain-level)`, deliberately
**not** the wire value: parentheses are illegal in `SLUG_RE`, so the chip can
never collide with a registered project.
`dashboard-layers-source.test.ts` asserts the client's wire literal is one the
server's allowlist accepts, because the two ends compile separately and share no
import.

### Layer views (FR-240) — the browse/detail surface

Nine endpoints across four layers: briefs, learnings, context docs, goals. They
are **read-only throughout (with one disclosed exception)**, and that is a
structural property rather than a promise — see "Two doors" below, which states
which endpoint uses which handle, and which is where the exception
(`/api/context-docs`, whose reader reaches the brain through a different door)
is qualified. The summary line must not stand alone: TD-320 found it being read
as a claim about all nine when it is precise about the layer readers only.
FR-241 added a write endpoint to this surface but changed none of these nine.

**Shared list envelope.** Every list endpoint returns
`{items, count, total, limit, offset, params}`. `total` is the row count under
the same filters **before** pagination, which is what a pager needs. `limit`
clamps to `1..200` (default 50) — note this differs deliberately from the brain's
own `igris_brief_list`, where `limit: 0` means "no `LIMIT` clause": a
browser-reachable endpoint that can be asked for the whole table is a
denial-of-service on the operator's own loopback.

**No body content in a list.** `brief_files.content` and `learnings.content` are
detail-only. Shipping them in a list re-introduces the superlinear payload term
FR-237's "returns NO body content" rule exists to remove. Learning list rows
carry `content_length` instead, so a row can show a size without the body.

**`params` is not `degraded`.** `params` names inputs the endpoint **clamped or
dropped** (`limit: clamped down to 200`, `category: "poem" is not one of …`,
`unknown filter: catgory`); `degraded` reports **incomplete data**. Conflating
them would make a mistyped filter look like a broken brain. A filter value
outside its allowlist is dropped and named — never bound — and an unrecognised
query parameter is reported rather than ignored, so `?catgory=pattern` surfaces
instead of silently returning everything.

**Addressing: `/api/brief` needs BOTH `project` and `id`.** `BR-001` names a
different brief in 25 projects (BR-078), so an id-only lookup would silently
return whichever project sorted first. Omitting `project` is a stated refusal.
`/api/goal` takes `id` alone, because `GL-XXX` is a brain-allocated **global**
sequence — the asymmetry is the point, not an oversight.

**`review_status` (D9).** `/api/learnings` defaults to `approved` and echoes the
resolved value in the payload. `pending_review` rows are reachable only when
explicitly asked for, and the UI banners them. The learnings list itself still ships **no**
approve/reject control; FR-241 put those on their own surface (`#/triage`), for
the reason the write-path section below gives.

**Context docs need no brain data.** `/api/context-docs` forwards the
`igris context-docs inventory` digest; `applies_when` is evaluated by that verb
and is deliberately **not** re-derived server-side. Path safety comes from two
properties rather than a filter: the slug is validated against
`listProjectsReadonly()`,
and the doc's filename is taken from the digest ROW — there is no code path that
joins a caller-supplied filename, so a traversal `type` is refused as an unknown
type. A `realpath` check backs both, because `~/.igris/projects/**` is a
directory the operator writes (unlike the static bundle, where a lexical check
suffices).

#### The briefs board (FR-245) — a second arrangement, and NO new endpoint

`#/layers/briefs` ships two arrangements of the same rows: the **list** (the
default) and a **board** partitioned by `brief_status.status`. The toggle sits
beside the heading and persists in `sessionStorage` under
`igris.dashboard.layers.view` — not in the URL, because a filter is not an
address (the same call `Layers.tsx` records for project scope), and not in
component state, because `router.tsx` unmounts the page on a route change. A
reload keeps it; a **new tab** opens on the list, which is what makes the choice
session-scoped rather than permanent.

**FR-245 ITSELF ADDED NO ENDPOINT** — the count stayed sixteen <!-- count:record FR-245 --> through it, moved to seventeen at FR-246 (`/api/briefs/search`), to eighteen at FR-248 (`/api/search`) and to nineteen at FR-266 (`/api/cognition`). The board composes two endpoints that
already exist:

| What | Where it comes from | Why not somewhere else |
|---|---|---|
| the column **SET** | `/api/summary`'s `briefs.by_status` — a complete `GROUP BY status` over the same project scope | its key set is a SUPERSET of any filtered subset in that scope, so no status can be missed |
| each column's **cards and count** | `/api/briefs?status=<raw>&…`, one request per column, `limit=12` | `total` is the count under the same filters BEFORE pagination — exactly the number the header prints |

**One number, one source.** A column's count is the `total` from *that column's
own* response. `/api/summary` supplies the SET and never a number: a summary
count is blind to the priority/effort/type filters and would disagree with the
cards under it. The strip's own readout sums the columns and compares that sum
with `briefs.total` — `G-BR-12b` asserts the equality, which is what makes "no
brief is hidden" mechanical rather than asserted.

A `/api/briefs/board` endpoint was costed and rejected: it would have been
endpoint #17 <!-- count:record FR-245 -->, sweeping two MAINTAINING rows, `SMOKE_PROBE_PATHS`, the
`dashboard.bats` exact-set assertion, `cli/src/types.ts`, `lib/api.ts` and this
file, and vendoring a new reader into the packed brain bundle — all for an
arrangement of rows the client can already ask for.

**THAT REJECTION STILL STANDS, AND FR-248 IS NOT A REVERSAL OF IT.** FR-248 did
add a new GET (`/api/search`, the seventeenth), paying exactly the sweep priced
above — so read the two decisions together rather than as a precedent. What
separates them is not size but whether the SERVER does work the client cannot.
`/api/briefs/board` would have returned rows `/api/briefs` already returns, in a
different arrangement; arranging rows is the client's job.

**Be careful with the tempting version of this argument.** A draft of this
paragraph said `/api/search` produces a ranked list no client could assemble,
"because RRF is not distributive over separate requests". **That is false, and
this brief's own code says so:** every fused row belongs to exactly one layer, so
its score is `w/(k + layer_rank)` with **no cross-list summation term**, and
`dashboard-search-fused.test.ts` pins the output as a deterministic round-robin
interleave with a documented tie-break. A browser holding five responses could
reproduce `items[]` exactly. The argument was reached backwards from a decision
that happens to be right — which is the more dangerous kind, because it is the
argument that gets inherited.

The three things that actually distinguish it are all server-side and all real:

1. **One handle, one latch.** The five arms share a single
   `openBrainReadonlyWithVec()` and one embedding warm-up. Five client fetches
   are five handles and five cold starts.
2. **Three failure shapes become one.** The layers report unavailability three
   different ways — a `degraded` field, an `ok:false`, and a throw. Normalising
   them into one `LayerReport` (`available`, `requested`, a verbatim `reason`)
   is work a client would have to re-implement, and getting it wrong is exactly
   the silent-drop failure `G-BR-17` exists to prevent.
3. **The cap must fall on the FUSED order.** A client can only approximate that
   by over-fetching every arm and hoping its `limit` was generous.

So the test the next brief should apply is not *can the client render this?* but
***can the client get this answer without re-implementing server work or
over-fetching?*** If it can, the endpoint is an arrangement and the sweep is not
worth it.

**Columns are DATA ∪ VOCABULARY, never a hand-list.** The union is the statuses
present in scope plus the documented lifecycle
(`docs/architecture/brief-state-source-of-truth.md`: `Draft` / `Ready` /
`In Progress` / `Blocked` / `Done` / `Archived`). Neither alone works: the data
alone loses `In Progress` on a project with nothing in flight, and the
vocabulary alone hides `Superseded`, `Deferred` and `Cancelled`, which exist in
the brain and are **not** in the documented set. `brief_status.status` has no
CHECK constraint — the same reason `params.ts` leaves the brief filters
`allowed: null`.

> **THE DUPLICATE COLUMNS ARE THE DATA BEING HONEST, NOT AN FR-245 DEFECT.**
> This brain holds `Done` (1195), `Completed` (24) **and** `Complete` (1), plus
> `In Progress` (26) and `InProgress` (4), one status with a commit hash welded
> into it, and two that are whole sentences. The board renders **every one of
> them as its own column with its own count** and merges nothing: merging is
> arithmetic over values the system does not know are the same, and it would
> hide a data defect behind a tidy column. **TD-333 owns the status
> vocabulary.** `board.test.ts` B6 pins three separate columns, so a future
> "helpful" merge fails a test.
>
> The one concession is ORDER: spellings that normalise equal (lowercase, strip
> non-alphanumerics) sort into the same lifecycle slot, so `InProgress` sits
> beside `In Progress`. **Synonyms do not**: `Completed`, `Complete` and
> `Done(Resolvedbydec8d1f)` normalise to nothing the vocabulary knows, so they
> land in the tail ordered by count — `Completed` (24) near the head of it and
> `Complete` (1) further along. Making those adjacent would need a synonym
> table, and a synonym table is one keystroke from the fold. The board renders a
> note naming TD-333 instead.

**`Done` is 75% of the corpus, and the answer is a uniform cap, not a collapse.**
Every column shows at most **12** cards with `12 OF 493` in its header and an
`OPEN IN LIST →` control that switches to the list pre-filtered to that status.
Collapsing `Done` by default would special-case one *value* of an open
vocabulary — the same class of error as a hand-listed column set, one layer
down: the day `Archived` reaches 500 nothing would tell you. A uniform cap is a
rule about columns. Every status in scope has a column and every column links to
the list filtered to it, so **every brief is reachable in at most two clicks** —
measured by `G-BR-12g`, which clicks the control and checks the list comes up
filtered to that column with its row count, not argued from the attribute being
present. The board does not claim to render every brief as a card.

**The status filter narrows the COLUMN SET.** The board's axis *is* status, so
`status=Done` renders exactly one column rather than being passed into each
column's query (which `URLSearchParams.set` would resolve silently, last write
wins). The other four filters — `project`, `priority`, `effort`, `brief_type` —
pass through into every column's request unchanged.

**The board does NOT follow the 5-second `live.tick`.** It reads once per
`(project, filters)` tuple, stamps `AS OF <generated_at>` and offers an explicit
`REFRESH`; a board on the beat would be 1 + N requests every five seconds
forever, each opening a brain handle. Same call, same reasons, as `RecordDetail`
and `#/graph`. The honest trade is stated in the UI: the board is less live than
the list.

**The board is READ-ONLY, and there is no drag-to-change-status — ever.**
`brief_status.status` is the canonical build-state source (MAINTAINING row 95)
and TD-311 forbids resolving a state contradiction by editing brief data, so a
drag affordance would be a write path into the column the whole build state is
read from, arriving as a convenience. Because "this page issues no writes" is
trivially true of a page with no write code, the claim is guarded twice with a
positive control on each side: a drag-vocabulary scan over the board files with
a planted affordance it must find
(`dashboard-layers-source.test.ts`), and `G-BR-12f`, which drags a card with
real CDP mouse events and reads an in-page non-GET counter that also reports
`GET > 0` — with one mutation per half.

### `/api/learnings/search` — the `retrieval` contract

Learning search is **hybrid BM25 + vector recall fused by RRF**, not substring
matching. It runs the same `hybridSearchLearnings` the `igris_memory_hybrid_search`
MCP tool runs — one implementation, two presentations.

Every response carries a `retrieval` block:

```json
{
  "mode": "hybrid",
  "vector_available": true,
  "embedding_available": true,
  "bm25_hits": 12,
  "vector_hits": 14,
  "rrf_k": 60,
  "weights": { "bm25": 0.5, "vector": 0.5 },
  "reason": null
}
```

`mode` is one of:

| `mode` | Meaning |
|---|---|
| `hybrid` | both arms contributed and were RRF-fused |
| `vector_only` | the vector arm ran; BM25 matched nothing |
| `bm25_only` | the vector arm was unavailable or returned nothing |
| `none` | no rows at all |

**Why this block exists, and why it is not optional.**
`isVectorSearchAvailable(db)` is a `SELECT vec_version()` probe on *that
connection*. A read handle that never loaded `sqlite-vec` makes the reader fall
through to its BM25-only arm **silently** — returning plausible results while
hybrid recall is simply not happening. The block converts that invisible
degradation into a reported one, and `reason` carries the cause verbatim.

`bm25_only` is a **legitimate** state, not a bug: `sqlite-vec` and the
embeddings backend are production dependencies of `brain-mcp-server` and live in
`cli/dist/brain-mcp-server/node_modules/`, the one directory the published
tarball excludes and `scripts/postinstall.mjs` restores. A first embedding call
also downloads ~25 MB of MiniLM weights into `~/.cache/huggingface`, and an
offline host raises `EmbeddingsUnavailableError`. All three degrade to
`bm25_only` with a reason; none may fail the request. The UI renders a visible
banner rather than a shrug.

**Runtime facts, measured 2026-07-30** (darwin/arm64, Node 24, better-sqlite3 11,
sqlite-vec 0.1.7, against a `VACUUM INTO` snapshot of a ~53 MB brain):

- `sqlite-vec.load()` **succeeds** on a `{readonly: true}` better-sqlite3 handle,
  and `query_only = ON` coexists with it in **either** order. `vec_version()`
  answers `v0.1.7` afterwards and `learnings_vec` is genuinely readable.
- `generateEmbedding` resolves from the vendored `node_modules` in a CLI process
  and returned a 384-dim vector in ~306 ms against a warm HF cache.

These were probed before the endpoint was written; the documented fallback (a
normal open plus `query_only = ON`) turned out not to be needed, and remains only
as the R4 branch that exists for a different reason.

### `/api/briefs/search` — the same contract, plus a missing-arm case (FR-246)

Brief search is **hybrid BM25 + vector recall fused by RRF**, exactly like
`/api/learnings/search`, mirroring `hybridSearchLearnings` field for field. It
carries the same `retrieval` block with the same four `mode` values, and it is
the SECOND endpoint that needs `openBrainReadonlyWithVec()` — for the same
reason.

Two things differ, and both are forced by the domain.

**1. The BM25 arm can be ABSENT, so the block carries `bm25_reason`.**
`learnings_fts` has existed since schema v1, so learning search may assume its
lexical arm. `briefs_fts` arrives at **schema v23**, so a brain that has not
booted the migration — or one where v23 aborted on an unverifiable backup
snapshot — has a live vector arm and no lexical one:

```json
{
  "mode": "vector_only",
  "vector_available": true,
  "embedding_available": true,
  "bm25_hits": 0,
  "vector_hits": 4,
  "rrf_k": 60,
  "weights": { "bm25": 0.5, "vector": 0.5 },
  "reason": null,
  "bm25_reason": "brain table absent: briefs_fts (schema v23 not applied)"
}
```

That state is REPORTED rather than rendered as a thinner result set, for the
same reason `vector_available` exists: a search that silently answers with half
its recall looks exactly like a search that legitimately found little.

**2. Rows carry `content_length`, not a `preview`.** Brief bodies average
~3.9 KB (measured: 6,211,271 bytes over 1,597 rows on the operator brain), so a
ranked list carrying them is the payload term the read layer exists to remove.
The body is `/api/brief`'s job.

**Why briefs got a BM25 arm built for them at all.** Before FR-246 the only
retrieval over briefs was `briefs_vec`, and that index is much thinner than it
looks: `extractBriefProblem` embeds the title plus the `## Problem` section only
(falling back to the first 500 characters), it is called at CREATE and by the
backfill tool and **nowhere else**, and the only trigger on it is a DELETE. So a
brief's BODY was not searchable at all, and an edited brief carries a stale
vector. `briefs_fts` is therefore not merely the offline fallback for the vector
arm — **it is the only arm that reaches `brief_files.content`**, and the only one
that is current after an edit. (Whether to re-embed on update is a separate
brief and is deliberately not fixed here.)

`igris_brief_similar` did **not** become hybrid. It is `/register`'s duplicate
check and it filters on *cosine similarity ≥ threshold*; a BM25 hit has no
cosine similarity to threshold against, so making it hybrid would silently
change what counts as a duplicate. It keeps its own pure-vector reader
(`briefs-read.ts#searchBriefsByVector`), and the two share one `briefs_vec` call
site.

### `q` — the four surfaces that filter, and say so (FR-246)

`/api/goals`, `/api/suggestions`, `/api/learnings` and `/api/context-docs` take
an optional `q`. **It is a substring filter, not retrieval**, and every one of
them says so in the payload rather than in a sentence in the UI:

```json
{ "search": { "mode": "substring", "fields": ["title", "evidence"] } }
```

`null` when no `q` was supplied — which is different from an absent key, and
different again from an empty result.

| Path | `q` matches | Why substring is proportionate |
|---|---|---|
| `/api/goals` | `title`, `description` | goals are hand-created, one per objective; `SELECT COUNT(*) FROM goals` measured **6** on the operator brain, and there is no `goals_fts` and no `goals_vec` |
| `/api/suggestions` | `title`, `evidence` | the queue is DRAINED, not recalled over — a suggestion is triaged once |
| `/api/learnings` | `title`, `content` | this is what the CANDIDATES tab filters on, and it is a DECISION — but no longer the one first written here. It was "`hybridSearchLearnings` structurally cannot return a `pending_review` row"; **BR-085 made that gate a parameter**, so recall can. The surviving reason is the shape of the answer: a queue must be shown exhaustively, in a stable order, with an honest `total` and continuous pages, while ranked recall returns ONE fused page with no stable offset semantics |
| `/api/context-docs` | the doc BODIES on disk | five registered types of prose is not a retrieval problem, it is `grep` — and the payload says `body` rather than a column name, because there is no table |

**Why a payload field and not a line of UI copy.** A hard-coded sentence is the
claim that goes stale the day someone swaps the implementation underneath it,
and no gate can catch a stale sentence. A payload field can be asserted:
`G-BR-13b` fails any surface whose payload says `substring` while its DOM shows
a recall readout, and the client renders both through the same
`SearchReadout` component so the two cannot drift apart.

**Wildcards are neutralised.** Every `q` predicate is a bound parameter with an
explicit `ESCAPE`, so `?q=%` matches rows containing a literal per-cent sign
rather than matching everything — a filter that silently matches every row is
worse than one that errors, because the operator reads the full list as a
result.

**The context-doc grep is bounded on three axes**: existing docs only, a
per-doc cap (`MAX_DOC_BYTES`) and a total-bytes cap for the request
(`MAX_GREP_TOTAL_BYTES`), with capped snippets. Every byte is read through
`readDoc`, so its three existing fences — the registry-validated slug, the
target taken from the digest row rather than from user input, and the
realpath+commonpath guard — apply unchanged.

### Two doors, and read-only is a property of the connection

**Since FR-241 this tier is not read-only as a whole, and it is not read-write as
a whole either.** It has two doors, and which one an endpoint uses is the only
honest way to state the posture — an undisclosed exception to a structural claim
is how the claim stops meaning anything.

**Since TD-319 the read door has no exception.** *Every* GET on this surface
reads through a `{readonly: true}` connection with `query_only = ON`. From FR-238
to FR-246 four paths did not, and this section carried the disclosure; the
paragraph that used to sit here is now history rather than a caveat, kept at the
bottom because knowing what the fix was for is what stops it being undone.

| Door | Endpoints | Connection |
|---|---|---|
| **Read** | **every GET**: the FR-240 layer endpoints (`/api/briefs`, `/api/brief`, `/api/learnings`, `/api/learnings/search`, `/api/learning`, `/api/context-docs`, `/api/context-doc`, `/api/goals`, `/api/goal`), FR-241's `/api/suggestions`, FR-246's `/api/briefs/search`, FR-248's `/api/search` (the first path to serve FIVE readers off ONE handle), FR-266's `/api/cognition` (the only path that reaches its data through a CLI VERB rather than through `brain-bridge.ts` — see the note below), both graph endpoints, and `/api/projects` plus `/api/summary`. **The word is ACCESSOR, not path.** TD-319's exception set was the paths that reach the door through a SECOND door on an FR-238-era accessor MODULE (`registry.ts`, `brain-db.ts`) — `/api/projects`, `/api/summary`, `/api/context-docs`, `/api/context-doc`. The last two are FR-240 D8 PATHS (`context-docs-read.ts`'s own header says so, and commit `fc738b8` adds both that module and the `server.ts` arms in one go); it is their ACCESSOR that is FR-238-era, which is why they are listed in the FR-240 group above. "The FR-238-era accessors (TD-319)" below is the module-by-module map | `brain-bridge.ts#openBrainReadonly()` / `#openBrainReadonlyWithVec()` — `{readonly: true}` **and** `query_only = ON`, opened per request and closed after |
| **Write (FR-241)** | `POST /api/triage`, and nothing else | a **separately booted in-process brain engine** holding its own read-write connection, opened lazily and never by a browsing session |
| *No brain handle at all* | `/api/health` and the static paths | an `existsSync` and a module-resolution probe; nothing is opened |

**Every GET on this surface changes no row, and no byte.** The read door enforces
that structurally; the write door is a different module returning a different
connection, which is exactly why FR-240's read-only pins stay green rather than
being re-argued.

**`/api/cognition` reaches the read door through a VERB, and that is the one
shape difference worth naming (FR-266).** Every other GET calls
`brain-bridge.ts` directly. This one calls
`verbs/cognition.ts#buildCognitionHealthDigest` in-process — the same function
`igris cognition health --json` prints — and *that* reaches the brain only
through `brain-db.ts#withReadonlyBrain` -> `brain-bridge.ts#openBrainReadonly`.
So it is the SAME door, one call further down.

Three consequences, stated rather than implied:

- **It inherits the structural guarantee rather than promising one.** The
  endpoint opens no handle of its own, so `dashboard-readonly.test.ts`'s G-RO-3
  claim about the in-process handle covers it by construction. `/api/cognition`
  is in that suite's crawl.
- **A subprocess would have broken that.** `spawn("igris", …)` was considered and
  rejected: a child opens a handle the read-only suite cannot inspect, would read
  the operator's REAL brain unless `IGRIS_BRAIN_DIR` were threaded in by hand at
  every call site, and needs `igris` on the `PATH` of the serving process — which
  neither the packed-tarball smoke test nor the browser gate can assume.
- **It is the handle-churn heavyweight.** The digest opens and closes once per
  reader per instance — ~20+ cycles per request for a seven-instance roster —
  which is deliberate (`brain-db.ts`: *"so a `/hunt` writing to the brain is
  visible on the next read"*). Measured on a real brain: p50 13.0 ms, p95
  14.6 ms, so the panel follows the 5-second beat rather than needing a REFRESH
  button. Re-measure if the roster grows an order of magnitude.

**The layer readers (FR-240) — structurally read-only:**

- Every handle behind `/api/briefs`, `/api/brief`, `/api/briefs/search`,
  `/api/learnings`, `/api/learnings/search`, `/api/learning`, `/api/goals` and
  `/api/goal` comes
  from `brain-bridge.ts#openBrainReadonly()` or `#openBrainReadonlyWithVec()`,
  and **both** set `db.pragma('query_only = ON')` on **both** of
  `openBrainReadonly`'s branches — including the R4 fallback that re-opens
  read-**write** when a WAL brain has no `-shm`. An accidental row write or DDL
  anywhere downstream throws instead of landing. **One measured exception:** on
  that R4 fallback `query_only = ON` does NOT refuse a `PRAGMA journal_mode`
  change, so "a GET cannot flip the journal mode" rests on the pragma *and* on
  no read path ever issuing that statement — the only two are inside the two
  `getDb()`s, which the dashboard tier no longer reaches. Stated rather than
  rounded up, because nothing machine-enforces the second half.
- The tier **never calls an MCP handler**. Every brain read handler runs
  `getDb()`, which opens the brain read-write and runs `migrateSchema`; and
  `handleMemoryGet` / `handleMemoryRecall` both
  `UPDATE learnings SET access_count = access_count + 1`. That bump is *correct*
  for a recall (TD-092 — it feeds the composite-ranking boost and the recall
  telemetry) and *wrong* for a page view, so it stays wrapper-side and the
  dashboard uses the non-bumping `memory-read.ts#getLearning`.

**The FR-238-era accessors (TD-319) — a second door on the same modules:**

- `/api/projects` (and **both** `/api/context-docs` and `/api/context-doc`, each
  via `context-docs-read.ts#isKnownProject`) reaches
  `registry.ts#listProjectsReadonly`; `/api/summary` reaches
  `brain-db.ts#briefStatusSummaryReadonly` / `#listInstancesReadonly`; and the
  two context-doc paths ALSO reach `brain-db.ts#readProjectProfile` through
  `verbs/context-docs.ts#buildContextDocsInventoryDigest`. That last one is worth
  naming: it is a **second** brain door on the same request, and a fix confined
  to the slug allowlist would have left it opening read-write.
- Each of those opens through `openBrainReadonly()` — the same handle the layer
  readers use, opened and closed per call — and **preflights** its table instead
  of creating it. `listInstancesReadonly` additionally skips the TD-277
  activity-column `ALTER TABLE … RENAME COLUMN` its read-write twin performs: an
  un-upgraded brain is *projected*, not migrated, because a GET must not run DDL.
- **The read-write doors still exist, and are still correct.**
  `registry.ts#listProjects` / `#upsertProject` / `#deleteProjectRow` and
  `brain-db.ts#briefStatusSummary` / `#listInstances` go through their modules'
  `getDb()`, which sets `journal_mode = WAL` and, in `registry.ts`, runs
  `CREATE TABLE IF NOT EXISTS projects`. `igris register`,
  `igris doctor --remove-orphans` and `igris init` need exactly that — indeed
  `verbs/init.ts#ensureDbOpen` calls `listProjects()` *purely* for the create
  side effect and discards the rows, so flipping the shared handle read-only
  instead of adding a door would have broken registration **silently**. What
  changed is reachability: no HTTP GET can get to them.
- `/api/context-docs`'s `existsSync(brainDbPath())` preflight survives as belt
  rather than braces. It used to be the only thing stopping `registry.ts` from
  **creating** a brain database on a machine that had none; `openBrainReadonly`'s
  `fileMustExist: true` now enforces that at the connection.

`cli/src/__tests__/dashboard-readonly.test.ts` crawls every endpoint twice
against a seeded snapshot and compares a full logical dump plus the file digest,
with a deliberate-writer negative control proving the comparison can actually
report a mutation. **What that crawl cannot see:** its fixture seeds
`journal_mode = WAL`, so the digest comparison can never exercise a journal-mode
flip. **G-RO-5** in the same file closes that gap explicitly — it converts the
fixture to `delete` mode and drives the **whole** tier against it, asserting no
flip, no `-wal` sidecar, no `.db` rewrite and no DDL, with a
payloads-are-real companion so the stillness cannot be satisfied by a reader
that returned nothing, and a self-negative-control proving the `delete`-mode
conversion really happened. `cli/src/__tests__/registry.test.ts` pins the other
direction: the write door still creates the table and still sets WAL.

**What TD-319 actually fixed, and what it did not.** On a brain in
`journal_mode = delete` those four GETs **rewrote the `.db` header**, and on a
brain with no `projects` table a GET **ran DDL**. Neither ever changed a row of
brain content, and on an operator brain already `wal` with that table the
observable effect was nil — which is why FR-240 deferred it rather than
hot-fixing it. "Nil today" is not "correct", and it was the disclosed exception
that made the tier's read-only claim unquotable.

**What the write door still does, stated rather than folded in:** booting the
write engine puts the brain in WAL, because `createSqliteAdapter` sets
`journal_mode = WAL` on the connection it opens. That flip is now the **only**
one this surface can cause, and it is why the write engine must stay **lazy**:
G-RO-5's fixture is a `journal_mode = delete` brain, and a write engine booted on
a browsing session would flip it.

### The write path (FR-241, extended by FR-247 and FR-249)

`POST /api/triage` is the only endpoint on this surface that changes a row, and
it is deliberately **one** endpoint with an `action` discriminator rather than
five verb endpoints. That shape is what makes the whole delegation rule a single
table a reviewer reads in one glance.

**FR-247 added two mutations and NO endpoint.** The path set was still sixteen GET <!-- count:record FR-247 -->
and one POST **as of FR-247**, and that was a measurement rather than a claim:
`dashboard.bats`'s exact-set string and `SMOKE_PROBE_PATHS` were byte-identical
to their pre-FR-247 values. (**Past tense since FR-248**, which added
`/api/search` and therefore edited both of those instruments. The claim was true
when written; the paragraph is kept as FR-247's record, not as the live count,
which is not written down here at all — read it off `server.ts`'s arms.) What
widened is the request BODY.

**The name is now wrong, and it stays.** `triage` no longer describes what this
path carries. Renaming it would sweep MAINTAINING rows 109 and 110,
`SMOKE_PROBE_PATHS`, `dashboard.bats`'s exact-set string *and* its
`N read paths all 200, M write path 400` summary line (named by SHAPE — the
figure lives in the assertion, which `dashboard-count-derivation.test.ts`
re-derives from `SMOKE_PROBE_PATHS`), `types.ts`, `api.ts`, this
document, the parity harness and the browser gate — for a noun. Read the path as
**a stable identifier for the write door**; the MAP, not the path, is the
vocabulary.

**The delegation rule:** *a dashboard mutation may only ever be added by adding a
row to the frozen `TRIAGE_ACTIONS` map in `cli/src/lib/brain-write-bridge.ts`,
and a mutation that does not resolve to a registered brain tool is forbidden.*

| `action` | brain tool | bulk | target | addressed by | allowed extras |
|---|---|---|---|---|---|
| `dismiss` | `igris_suggestion_dismiss` | yes | `id` | `id` | `reason` |
| `acted` | `igris_suggestion_acted` | yes | `id` | `id` | `brief_id` |
| `apply` | `igris_suggestion_apply_action` | **no** | `id` | `id` | — |
| `approve` | `igris_perception_approve` | yes | `id` | `learning_id` | — |
| `reject` | `igris_perception_reject` | yes | `id` | `learning_id` | `reason` |
| `set_priority` (FR-247) | `igris_brief_update` | yes | `brief-ref` | `project` + `brief_id` | `priority` |
| `attach_goal` (FR-247) | `igris_edge_create` | yes | `brief-ref` | `project` + `brief_id` (BR-083) | `goal_id` |
| `create_goal` (FR-249) | `igris_goal_create` | **no** | **`none`** | — (no subject) | `goal_title`, `goal_outcome`, `goal_project` |

#### Why a brief needed a second target kind

The five FR-241 rows address a row by **integer id**. A brief is not addressable
that way: `igris_brief_update` declares `required: ['project', 'brief_id']`, and
although `brief_status.id` exists and is even on the wire, **no brain tool
accepts it** — translating id → `(project, brief_id)` in this tier would mean a
SQL lookup, which the zero-SQL scan forbids by construction. So the body gained
`refs: [{project, brief_id}]` beside `ids`, and `target` says which one a row
takes. The two are **mutually exclusive** and the wrong one is refused by name.

`attach_goal` forwards **both halves of the ref** — `project` reaches the tool
as `from_project`. It used to forward `brief_id` alone, because
`entity_edges.from_id` was a bare brief id with no project column and `BR-001`
names a different brief in 25 projects, so a `serves_goal` edge was
project-ambiguous by construction (BR-078). **BR-083 closed it**: the column
exists, `handleEdgeCreate` REFUSES an ambiguous endpoint outright, and
`getGoal`'s serving-briefs join carries the project predicate. The forward is
now load-bearing rather than cosmetic — without it, attaching a brief whose id
lives in two projects would be a hard refusal from the brain instead of a
silently-wrong edge. The browser already sent `{project, brief_id}` refs, so
this was a server-side map edit with zero browser bytes.

`attach_goal`'s `from_type`, `to_type` and `edge_type` come from a **`fixed`**
block on the map row, never from the caller. A caller-supplied `edge_type` would
silently turn that one row into ~20 different mutations.

#### Goal CREATION — what FR-249 shipped, and the two options it rejected

The request was "attach to a new goal or an old one". FR-247 shipped the
old-one half and deferred the rest to FR-249, on a mechanical reason rather than
appetite: `dispatchTriage` **discards the tool's success payload**, so
create-then-attach would need one map row to fire two tools and thread the new
goal's id between them — the first exception to *one row is one dispatch*, which
is the property that makes this map a review artifact at all.

**FR-249 shipped the recommendation this paragraph made, and rule 3 survives
verbatim.** `create_goal` fires `igris_goal_create` **alone**; the operator
attaches with a second click on the row that already existed. Two clicks, not
two workflows: the map row declares `returns: "goal.goal_id"`, the dispatcher
walks that one path, and the client **preselects the goal it just made** in the
picker beside the CREATE control. Eight rows, eight tools, eight dispatches.

The two rejected options are recorded because they were live:

- **A typed result channel on every row.** Its NARROW form was adopted — a
  single map-declared `returns` path, `null` on the seven rows that declare
  none. Its general form was not: if every row *may* return a value, a reader
  can no longer tell from a row whether it feeds another mutation, and every row
  becomes potentially compositional.
- **A composite `steps: [...]` row.** Rejected on three grounds, and not on
  appetite: it deletes rule 3, it sweeps six assertions over the most-asserted
  frozen object in the tier, and it buys an acceptance criterion that **cannot
  be tested without a mock** — `igris_edge_create` never verifies the goal
  exists (`INSERT OR IGNORE` on any `to_id`), so an attach cannot fail on a goal
  that was just created. If one click is ever wanted, it is a brief that argues
  rule 3 on its own terms.

**The third target kind: `none`.** `create_goal` is the first row that addresses
nothing — the thing being written does not exist yet. Both `ids` and `refs` are
refused **by name**, the requested count is 1 (without that, a successful create
would report `requested: 0, applied: 1`), and the anti-vacuity gate that refuses
an empty `ids` does not apply and cannot: a subjectless create is never vacuous.

**Partial failure is PREVENTED, not compensated — and compensation is not on the
menu.** The brain registers six goal tools and **none of them deletes**, so a
composite that created a goal and failed to attach could not roll back. Under
two requests there is no window to roll back from: a create that fails leaves no
row, and a create that succeeds followed by an attach that fails leaves **a goal
with zero serving briefs** — a state the brain already models
(`handleGoalProgress` returns `completion_pct: null` at total 0) and the picker
shows immediately. It is loud rather than silent: the failure banner names the
refused brief and the brain's verbatim reason, the new goal is preselected, and
`igris_edge_create` is idempotent, so the retry is one click and cannot
double-write.

**What the create form does NOT offer, and why the absence is the design.**
`status` and `priority` are defaulted by `handleGoalCreate` to `active` and
`P2-Medium`; the form **says so** rather than letting the operator believe they
chose them. Offering `status` from a create form is editing by another name, and
editing goals is out of scope. `deadline` is out this round — it is a validated
ISO date with its own error surface, and adding it later is one `extra` key.
The goal's **project is the shell's scope**, and the all-projects scope is the
ABSENCE of one: the brain stores that as `project_slug NULL`, which the goals
layer already renders as "Cross-project".

**The wire keys are PREFIXED, and that is a second layer rather than a
duplicate.** `igris_goal_create` declares `required: ['title','outcome']`, but
`parseTriageBody`'s unknown-key set is GLOBAL — so adding a bare `title` to it
would stop `title` being refused *by absence* for `set_priority` too. The wire
therefore says `goal_title` / `goal_outcome` / `goal_project` and the map row's
`rename` turns them into the tool's argument names at the boundary. A body
posting a bare `title` at `create_goal` is still a 400, and a gate asserts it.

**The AC-3(a) guard gained an ENTITY dimension to allow this, deliberately and
by operator ratification.** Until FR-249 the guard banned
`status`/`phase`/`content`/`title`/`filename` from every row's argument surface,
globally — and it was entity-blind, so it could not tell `goals.title` from
`brief_status.title` and refused this row in all three options. TD-311's
invariant is a claim about BRIEFS; a goal is a different table with no `/hunt`
state machine over it. The guard now resolves each row's tool to the entity it
writes and applies the ban per entity, with three clauses that keep it a real
instrument and each asserted: the classification table is **total** over the map
(an unclassified tool reds), it **fails closed** (an unclassified tool is
checked against the brief ban anyway), and a **planted `brief_status.title`
write must still be refused**. Adding a row therefore means classifying its
tool, not merely naming it.

#### What the priority picker offers — and what it refuses to offer

The picker offers exactly **`P0-Critical`, `P1-High`, `P2-Medium`, `P3-Low`**
(mirrored from `brief-normalize.ts#CANONICAL_PRIORITIES`) plus **CLEAR**, which
sends the empty string and lands as SQL NULL.

This is deliberately **not** the data-derived rule FR-245 applied to the board's
columns and the filter chips. That rule was written for a READ surface, where
enumerating faithfully is exactly right because the UI is *reporting* what the
brain holds. **A picker prescribes a vocabulary; it does not report one.**
Enumerating from data here would offer `P4-Trivial` and a bare `P2` as things an
operator can *assign* — the UI would manufacture new instances of the drift
TD-338 exists to explain.

The non-canonical values do not vanish. Measured read-only on the operator brain
(2026-08-03): 5 bare `P2`, 2 bare `P1`, 1 `P4-Trivial`, out of 1,818 rows. They
stay visible in three places, all shipped and all untouched by FR-247:

1. the list-row badge renders `row.priority` **verbatim**;
2. the **filter** control's options are still derived from the rows, so
   `P4-Trivial` remains filterable;
3. the picker renders a non-canonical **current** value as a *disabled,
   `not offerable`* entry — so a brief holding one never silently looks unset.

Stated consequence, not pursued: `normalizePriority` folds at the handler, so
writing any value to a bare-`P2` brief also canonicalises it. **TD-338 owns those
8 rows and the SYNC path that minted them** (an LWW column copy with no
normaliser); folding them here without closing that door would just re-run.

#### A priority write reads before it writes

`igris_brief_update` is a genuine partial update — but it **forks**. For a brief
that exists in `brief_files` with **no `brief_status` row**, the same call takes
a row-CREATING branch and writes `title = ''` and `status = 'Ready'`. A
priority-only click would therefore blank a title and invent a status: two writes
into the build-state invariant, from a request that named neither field.

So `dispatchBriefWrite` reads every ref through the **FR-240 read door**
(`loadLayerReaders().getBrief` on an `openBrainReadonly()` handle, one connection
per POST, `query_only = ON`) and **refuses** any ref with no `brief_status` row,
with the reason stated per item. The refusal covers `attach_goal` too, for an
independent reason: `getGoal`'s serving-briefs join is an INNER join on
`brief_status`, so an edge to such a brief would be invisible in the goal detail.

The predicate is `status !== null`, **not** `record !== null`. `getBrief`
LEFT-JOINs `brief_files → brief_status`, so for exactly the population this guard
exists to catch it returns a non-null record with null status columns; a
`record !== null` test would have passed every ref it was written to refuse. It
holds because `brief_status.status` is `NOT NULL` in the schema, and the endpoint
suite reads that constraint out of the live DDL so a migration relaxing it fails
loudly rather than silently un-arming the guard.

#### A brief write can EGRESS — and the tests are fenced accordingly

`igris_brief_update` emits `brief.synced`. The `sync` component subscribes that
event **unconditionally** and, when `auto_push` is true in
`~/.igris/config.json`, fire-and-forgets `pushTables({brief_status, brief_files})`
at `remote_brain.url`. `sync` is deliberately **enabled** in the dashboard's write
engine (the only disabled component is `schedules`), so this is **parity, not a
leak**: an MCP `igris_brief_update` does exactly the same thing. It is documented
here rather than suppressed, because an operator who did not know it would be
surprised by rows appearing on their VPS after a dashboard click.

The consequence for tests is not optional. A fixture write on a machine with
`auto_push` enabled would land in the real remote brain, which is worse than
touching the local one because it is not undoable from that machine. Every
mutating suite arms `cli/src/__tests__/auto-push-fence.ts` (which points `HOME`
at the sandbox **and** replaces `globalThis.fetch` with a recording thrower, and
reads both back), and the parity harness sets `HOME` in each arm's child env.
G-TR-13 proves the fence bites rather than asserting it: one arm configures
`auto_push: true` against a fictional remote and requires the blocked POST to be
**observed**, which is what makes the zero in every other test mean something.

The `id` / `learning_id` asymmetry is not an inconsistency to tidy: the three
suggestion tools declare `required: ['id']` and the two perception tools declare
`required: ['learning_id']`, so a wrong key is a **gateway refusal**
(`missing required argument 'learning_id'`, BR-080) rather than a silent
mis-write. `extra` is an allow-list rather than documentation — `buildTriageArgs`
copies only the keys its row names, so a body posting `winner_id` at `dismiss`
cannot reach the handler with it.

`apply` is single-item by design (D4): it dispatches arbitrary action *kinds*
(`tick_ac`, a `create_brief` draft, `add_edge`, `flag_for_review`), and
bulk-firing heterogeneous side effects behind one confirm is not a triage flow.
Bulk requests clamp at **`MAX_BULK = 200`** ids, and the clamp is reported
through `params` rather than silently applied.

#### The write path IS the MCP path, minus the JSON-RPC framing

`brain-write-bridge.ts` boots the **vendored brain engine** in-process
(`bootEngine({dbPath: brainDbPath(), components: {schedules: {enabled: false}}})`)
and dispatches through that engine's own gateway. The brain's stdio
`CallToolRequestSchema` handler is a one-line wrapper around the same
`gateway.dispatch(name, args)` call. So three properties are **consequences of
the shape** rather than features re-implemented here:

- **input validation** — the BR-080 `required` walk and the TD-128
  `additionalProperties: false` extras walk both live in `gateway.dispatch`, not
  in the handlers. Importing a handler directly would have dropped both, which is
  the difference between "the dashboard is a client of the brain" and "the
  dashboard has a private, unvalidated back door";
- **the event bus** — `handlePerceptionApprove` and `handlePerceptionReject`
  emit on it, and `monitoring` is subscribed on this engine exactly as on the MCP
  server's;
- **audit** — the resulting `event_log` rows are written by the same
  `monitoring` writer, so a dashboard mutation and an MCP mutation are compared
  column-for-column by `dashboard-triage-parity.test.ts`, in two **processes**.

**`schedules` is the one disabled component, and the reason is load-bearing.**
`bootEngine` otherwise starts the schedules cron daemon, which would turn
`igris dashboard` into a second brain daemon firing `igris_subconscious_run`, the
perception / synapse / janitor extractors and their LLM calls on cron. That is a
categorically different program from the one the operator started.

**`sync` deliberately stays enabled.** `suggestions` and `learnings` are both
`SYNC_TABLES`, so disabling it would make dashboard writes fail to propagate to
the VPS while MCP writes succeeded — a parity break in the other direction. The
consequence to expect: **a dismissal or approval made in the dashboard
auto-pushes to `brain.fifty.dev` exactly as the same action through MCP does.**

**The boot is lazy, and it happens at most once per process.** Nothing boots the
engine until a `POST /api/triage` — `/api/health` deliberately does not, because
a health probe that touched the write door would make the "a browsing session
never opens it" assertion unwritable. `writeEngineState()` reports
`"not-booted"` / `"booted"` / `"unavailable:<kind>"` and `/api/health` carries it
under `write`. One engine per process is a **correctness** property, not an
optimisation: `db.ts#setAdapter` is a module global, and a second `bootEngine`
in the same process silently re-points every `getDb()` — including the first
engine's — at the second database. That was measured, not assumed, which is why
the parity gate runs in two processes.

**A boot creates zero rows.** Measured against a `VACUUM INTO` snapshot of the
real brain by diffing all 66 plain tables: no schema objects added or removed and
no row created. Its single side effect is the `journal_mode` flip described in
"Two doors" above — which, since TD-319 closed the last GET paths reaching a
second door on an FR-238-era ACCESSOR, is
the **only** way this surface can still cause one.

#### Reject is a three-tier outcome, and the confirmation says which

`igris_perception_reject` forks on `seen_again_count` (FR-116 M3), so a blanket
"irreversible" banner would be a **lie** for the recurring rows — and training an
operator to click through a warning is how the one that mattered gets clicked
through too.

| Tier | Applies to | Row afterwards | What the dialog says |
|---|---|---|---|
| 1 — status flip | `dismiss`, `acted`, `approve` | survives, status changed | *N items will change status … there is no un-dismiss tool — reversing this means hand-editing the brain.* |
| 2 — soft delete | `reject` where `seen_again_count > 0` | survives with `deleted_at` | *N items will be SOFT-deleted (recurring patterns) … recoverable.* |
| 3 — **hard delete** | `reject` where `seen_again_count == 0` | **gone**, with its `learnings_vec` row | *N items will be PERMANENTLY DELETED. This cannot be undone.* |

A mixed selection reports **each** count, and the tier-3 count is always its own
sentence and always last. A row whose `seen_again_count` could not be determined
is counted as tier 3 and the dialog says so. A tier-3 bulk requires **typing the
count** to confirm. This is why `listLearnings` projects `seen_again_count` at
all: a dialog cannot state which of the two it is about to do without it.

#### Partial failure is reported, never rolled back

Each id is its own handler call and its own transaction (D6). A batch of five
where two fail returns **200** with `applied: 3`, `failed: 2`, and each failure
carrying the **brain's verbatim message** — the three that worked landed and stay
landed. There is no cross-id transaction, because wrapping N dispatches would
mean this tier running `BEGIN` on the brain, which is the raw SQL it exists to
forbid, and because one bad id must not discard 199 good ones. Dispatch is
sequential rather than parallel: every dispatch shares one `better-sqlite3`
connection and several handlers open a `db.transaction()`.

#### Two divergences the UI banners rather than hides

- **No TTL window.** `igris_perception_review_pending` applies a
  `pending_review_ttl_days` filter; the dashboard's candidate list does not, so
  it shows **more** than the MCP tool, including TTL-expired candidates
  `igris_perception_expire_stale` has not reaped. For a backlog-clearing surface
  that is correct — hiding rows you must triage is the bug — so it is stated in
  the view, not discovered.
- **Project-scoped by default.** There are ~1,188 pending suggestions across 19
  projects. A surface whose default selection is 1,188 rows is one mis-click from
  a catastrophe with no undo tool, so the view inherits the shell's project
  selector and renders the count *before* the rows when scope is widened.
- **The project-less population, since TD-326.** While scoped to a project the
  page banners `facets.brain_level` — the count of pending rows that belong to
  no project and that this scope structurally cannot list — and names the
  `(brain-level)` chip that reaches them. The banner is not the fix; the chip
  is. Selecting it lists exactly those rows, so they are **bulk-triageable as
  their own population**, and D5 holds *more* strongly there than anywhere else:
  the set contains no row owned by any project, so a bulk under it reaches
  strictly fewer rows than clearing the scope would.

The `source_module` filter vocabulary is enumerated **from data** — the
`/api/suggestions` payload carries a `facets.source_module` count map the reader
computes — because that vocabulary is open-ended (`gap`, `missing_followup`,
`janitor`, `edge_inference`, plus whatever the LLM names next) and a hand-list
would go stale silently.

#### The Candidates tab has no brain-level population, by construction

`learnings.project` is **`NOT NULL`** (`brain-mcp-server/src/db.ts:156`; verified
with `PRAGMA table_info` against the operator brain — `notnull: 1`, and 0 of 13
pending candidates carry a NULL or empty project). So the perception queue cannot
have TD-326's asymmetry — this is a schema guarantee of the same class as
`brief_status.project`, **not** a reading of today's rows. Selecting
`(brain-level)` on that tab therefore renders a stated empty category and issues
**no request**; sending `project_scope` to `/api/learnings`, which does not
implement it, would have been reported as an unknown filter and rendered the
UNSCOPED list under a `brain-level` label — the exact `everything`/`brain-level`
blur this brief exists to prevent.

The scope chip is **opt-in per page** for that reason: `ProjectScope` takes an
`extra` prop, and only the triage surface passes it. `Layers` and `Overview`
read layers whose project columns are `NOT NULL`, so a `brain-level` chip there
would offer a scope that is empty by construction.

#### The audit trail, and what it does and does not now record

Before FR-241, four of the five actions wrote **nothing** to `event_log`:
`monitoring`'s listen list carried `perception.run_*` only, so
`perception.candidate_approved` and `perception.candidate_rejected` were emitted
into a void. FR-241 phase 6b subscribed both (mapped to the literal legacy
component `'perception'`), which means a dashboard **or MCP** approve/reject now
leaves an audit row for the first time. Two residuals, stated in the same breath:

- neither emit carries a `project`, so the logged `project_slug` is **NULL** and
  the *project-scoped* `perception_dashboard.rejected_last_n` still reads 0 —
  only the unscoped total moved;
- `approved_last_n` is sourced from `learnings WHERE review_status = 'approved'`,
  so the approve event is a pure audit row and changes no counter at all.

`perception.rejected_pattern_recurring` is deliberately **not** subscribed: the
recurring-reject branch writes that row directly *and* re-emits it, so a listener
would log it twice.

`igris_suggestion_dismiss` and `igris_suggestion_acted` still write no
`event_log` row on either path. The parity gate asserts that emptiness
**explicitly**, citing the traced reason, rather than passing on a silent
`[] === []`.

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

FR-244 moved where it is RENDERED — from a full-width block under the canvas
into the side column beneath the inspector — and rendered it in BOTH branches of
the page, so the no-nodes scope still carries one. The exemption asks for
adjacency, not for a particular edge; as a second full-width row it was the
thing capping the canvas's height, which is why it moved.

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
`listProjectsReadonly` already returned — no second query, and no selection
logic in `routes.ts`.

**`/api/graph/stats` strips `nodes` and `edges` at the route layer.** That is a
structural fence, not a convention: the shell physically cannot render a graph
from this response, so FR-239's scope cannot leak backwards into the shell. It
also keeps the payload a few KB regardless of brain size.

### The degraded contract

**No endpoint ever returns 4xx or 5xx for a degraded brain.** A missing,
empty, unmigrated or corrupt brain database yields **HTTP 200** with empty data
and `degraded: {reason}`. A degraded brain is an ordinary state of a personal
lens, not an error. The only non-200 responses are `400` (a malformed request — including a
malformed triage body, which is a client bug rather than a degraded brain and
must stay distinguishable from one), `403` (a rejected `Host`, a rejected POST
`Origin`, or a traversal), `404` (unknown endpoint or missing asset), `405` (a
method a path does not accept), `413` (a POST body over 64 KB) and `415` (a POST
that is not `application/json`).

**`degraded` is also how an unavailable WRITE surface reports itself.** A
`POST /api/triage` that cannot reach the brain answers 200 with
`degraded: {reason}` and `applied: 0` — *disabled, not broken*. It never returns
a 500, never a stack trace, and never a partial mutation.

---

## Architecture

```
igris dashboard (verb)
  ├─ lock.ts        single-instance guard over process-liveness.ts
  ├─ open-url.ts    cross-platform browser ladder
  └─ server.ts      node:http, 127.0.0.1, Host guard, traversal guard
       ├─ static.ts   dist/dashboard/** + SPA fallback
       └─ routes.ts   every endpoint handler — CONTAINS ZERO SQL
            ├─ params.ts             pure clamp + filter allowlist + parseTriageBody
            ├─ registry.ts#listProjectsReadonly       (TD-319 read door)
            ├─ brain-db.ts#briefStatusSummaryReadonly / #listInstancesReadonly
            ├─ context-docs-read.ts  digest + guarded disk read (no brain)
            ├─ brain-bridge.ts ──runtime import()──▶ vendored pure READ modules
            │                                        ├─ FR-237 buildBrainGraph
            │                                        ├─ briefs-read.ts
            │                                        ├─ memory-read.ts
            │                                        ├─ goals/read.ts
            │                                        └─ suggestions-read.ts
            └─ brain-write-bridge.ts ─import()─▶ engine/index.js#bootEngine
                                        (LAZY · schedules disabled · one per
                                         process) ──▶ gateway.dispatch(tool,args)
```

**The server layer holds no SQL of its own — reads or writes.** Reads go through
exactly three doors: the FR-237 pure builder, the pure `db`-param read layer
(FR-240, extended by FR-241), or the existing MAINTAINING-pinned CLI accessors.
**Writes go through exactly one**: `gateway.dispatch(<a tool named by the frozen
map>, args)`. This is asserted mechanically by `dashboard-server.test.ts`, whose
scan covers `routes.ts`, `graph-query.ts`, `server.ts`, `static.ts`, `params.ts`,
`context-docs-read.ts` and — since FR-241 — `brain-write-bridge.ts`; and which
carries its own self-negative-control, because a scan whose only observed
outcome is "did not match" is indistinguishable from a scan whose patterns are
broken. A grep-only guard on a new module is what got FR-240 rejected, so the
write half is pinned **behaviourally** too: `dashboard-triage-endpoint.test.ts`
asserts the HTTP request invokes the real `handleSuggestionDismiss` in the loaded
bundle, and that with the gateway refusing the tool name the row is unchanged —
i.e. there is no fallback path that writes without the handler.

### The pure `db`-param read layer (FR-240)

FR-238 reused CLI accessors rather than authoring brain-side modules
(decision D3-b1), and reserved the deeper option — option **b2** — for FR-240.
FR-240 exercised it: the SQL behind `igris_brief_list`, `igris_brief_get`,
`igris_memory_hybrid_search`, `igris_memory_get`, `igris_goal_list` and
`igris_goal_get` moved **down one file** into three pure modules that take a
`db` parameter, and the MCP handlers became thin wrappers over them.

| Pure module | Wrapper | Functions |
|---|---|---|
| `brain-mcp-server/src/tools/briefs-read.ts` | `tools/briefs.ts` | `listBriefs`, `getBrief` |
| `brain-mcp-server/src/tools/memory-read.ts` | `tools/memory.ts` | `listLearnings`, `getLearning`, `hybridSearchLearnings` |
| `brain-mcp-server/src/engine/components/goals/read.ts` | `goals/handlers.ts` | `listGoals`, `getGoal` |
| `brain-mcp-server/src/tools/suggestions-read.ts` (FR-241) | `subconscious/handlers.ts` | `listSuggestions` |

FR-241 added the fourth pair the same way: `handleSuggestionList`'s query body
moved down verbatim into `listSuggestions(db, opts)` and the handler became its
wrapper, keeping the validation and the `rowToSuggestion` evidence-parsing. Its
one addition is `facets.source_module`, a `GROUP BY` count map computed over the
same `WHERE` minus its own clause, which is what lets the triage filter dropdown
be enumerated from data rather than hand-listed. It also carries a `tableExists`
preflight that reports `degraded: "brain table absent: suggestions"` instead of
throwing. FR-241 additionally widened `listLearnings`'s projection with
`COALESCE(seen_again_count, 0)` and `deleted_at` — additive, and load-bearing:
`seen_again_count` is what lets a reject confirmation say whether it is about to
soft-delete or permanently delete.

This was the third instance of the FR-237 pure-layer/wrapper convention
(`whole-graph.ts` / `whole-graph-tool.ts`, itself following
`visualization.ts` / `visualization-tool.ts`), which is what makes it a
convention rather than a one-off. Three properties make it work:

- **There stays exactly ONE definition per query.** The dashboard and the MCP
  tool run the same function, so AC #2's "demonstrably uses hybrid recall" is a
  claim about the brain's recall rather than about a copy of it.
- **The readers import no `db.js` and issue no writes** — mechanically asserted
  by `brain-mcp-server/src/tools/__tests__/pure-read-purity.test.ts`, which also
  carries a deliberately impure fixture the scan must flag.
- **Side effects stay in the wrapper.** The `access_count` bump is the worked
  example; `handleMemoryRecall` is deliberately left un-extracted.

`listLearnings` is the one genuinely NEW query: no MCP tool offered a
query-less, filter-based learning browse (`igris_memory_search` is FTS-only,
`igris_memory_hybrid_search` requires a query, `igris_memory_dashboard` returns
counts).

**The wrappers' wire output is byte-pinned.** Skills PARSE the text those six
handlers emit — `igris_brief_get` is called by `/hunt`, `/archive` and `/team`,
`igris_brief_list` by `/register`, `/audit` and `/team`, `igris_memory_get` by
`/harvest`, `/promote` and `/search`, `igris_memory_hybrid_search` by
`/search`, and `igris_goal_list` by `/scan` (established by grep at FR-240;
re-derive with `grep -rl <tool> ~/.igris/core/skills/` rather than trusting a
committed list). So
`brain-mcp-server/src/tools/__tests__/wrapper-wire-parity.test.ts` snapshots all
six over fixtures captured **before** the extraction. Re-recording those
snapshots to make a change pass is the one move that defeats the file's purpose.
**No CI workflow runs `brain-mcp-server` vitest** (TD-312 is open), so
`cd brain-mcp-server && npm test` by hand is the only gate on them.

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

**FR-240 moved the resolver's anchor up one level, to the bundle ROOT**
(`cli/dist/brain-mcp-server/dist/`, via `paths.ts#bundledBrainDistRoot`), with
per-module relative paths. The reason is concrete: `bundledBrainEngineDir()`
returns `…/dist/engine`, and two of the three new readers live under
`dist/tools/` — **outside** it. An `engine/`-anchored resolver would have needed
`../tools/…` escape paths, which is how a path literal starts rotting.
`bundledBrainEngineDir()` is retained as a named sub-path of the root, never a
second walk-up. `brain-bridge.ts#loadLayerReaders()` requires **all four**
read modules to resolve (FR-241 added `tools/suggestions-read.js`): a partial
load would give a working briefs view and a mysteriously empty learnings view,
which is far harder to diagnose than "the read layer is unavailable".

**FR-241 added a sixth entry to the same `MODULE_RELS` table, and it is different
in kind: `engine/index.js`.** Every other entry is a READ artifact whose loss
degrades a readout; this one exports `bootEngine` and is imported for the WRITE
door, so a moved or unpacked `engine/index.js` takes the *mutation* surface down
and the signal that goes false is `/api/health`'s `write.available`, not
`bridge.available`. `brain-write-bridge.ts` does not carry its own path literal —
it reads `ENGINE_MODULE_REL` from `brain-bridge.ts`, so there stays exactly one
table of bundle-relative paths to re-point. `tarball.test.ts` asserts both new
artifacts are actually in the published package, because a module that resolves
in the repo but is excluded from the pack fails only on a consumer machine.

`sqlite-vec` and the embeddings backend are reached separately, at
`paths.ts#bundledBrainNodeModulesDir()`. That is the ONE directory
`cli/package.json` `files` excludes, so between tarball extraction and
`postinstall` they are genuinely absent — which is why the vector arm degrades to
a reported `bm25_only` rather than throwing.

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

**The client tiers, and what each new page is allowed to cost.** FR-240 built
the record tier — one `RecordList`, one `RecordDetail`, one `FilterBar` — under
the rule that *a view needing a variation grows the row descriptor rather than
forking the file*. FR-241 is the first test of that rule from outside the four
layer views, and it held: `#/triage` reuses all three, and the multi-select
checkbox arrived as an optional `select` field on `RecordListRow` (rendered as a
**sibling** of the row anchor, never nested inside it — a checkbox inside an
`<a>` is a control whose click both toggles and navigates).

**FR-245 is the second test of that rule, and the first from INSIDE a layer
view.** The briefs board needed a card, and a card is a row: so `RecordList`'s
private `Row` was EXPORTED as `RecordRow` and `RecordBoard.tsx` composes it,
rather than a `layout="board"` prop on a component whose header says it renders
one list. The board renders no row markup of its own, and
`record.test.tsx` asserts that the same descriptor emits byte-identical row
markup through both. The props grew by one optional `actions` slot (the view
toggle, beside the heading) — the same move `RecordListRow` made for `select`,
for the same reason. Everything a reviewer could get wrong about the partition —
which columns exist, in what order, what each asks the endpoint for, how a
66-character status becomes a header — is in the pure, node-tested
`layers/board.ts`, not in a component.

The same reasoning one level up produced a **shared client state layer**: the
project-scope state machine that used to live inside `pages/Layers.tsx` is now
`lib/useProjectScope.ts` plus `components/chrome/ProjectScope.tsx`, consumed by
`Layers`, `Triage` and — since BR-082 — `Overview`. Two copies of a scope
selector is the same drift the record components exist to prevent, one level
above where the FR-240 AC was looking. Everything a reviewer could get wrong on
the triage page — the selection algebra, the destructiveness tiers, the confirm
copy, the chunking and the result merge — lives in the pure, node-tested
`triage/model.ts`, not in a component.

**BR-082 is what that layer was for, and it shows why a fourth consumer is
cheaper than a fourth copy.** `Overview` was the one page FR-241 did not
migrate; it kept its own `useState` plus its own copy of the `default_project`
ladder, and its chip strip had **no clear affordance at all** — so a page called
OVERVIEW could only ever show one project. The fix deleted that copy rather than
adding a third state to it, because the third state (`null` = explicitly every
project, distinct from `undefined` = not resolved yet) is precisely the thing
the FR-240 browser gate caught being got wrong: with only two states the ladder
re-applies on every `live.tick` and the clear is silently undone within five
seconds. `dashboard-layers-source.test.ts` now asserts mechanically that exactly
one shipped file renders the scope control and exactly one re-derives the
ladder.

**TD-326 added a scope VALUE, not a fourth state, and the distinction is the
whole design.** `brain-level` needed to be selectable on one page, and the
obvious shape — a `brainLevel` flag beside `project`, or a widened union —
would have changed the contract of all three consumers to make one page's
population reachable. Instead `useProjectScope` exports a reserved member of
the `project` string space, `(brain-level)`: the hook's public type is still
`string | null`, `undefined` still means "never chosen", and the ladder gained
exactly one line — the same `if (cur === …) return cur` exemption `null`
already had. Without that line the ladder's membership test would reject a
value that is not in `/api/projects` and re-select the default project on the
next poll: the FR-240 defect, in its third incarnation. `ProjectScope` renders
it through an opt-in `extra` prop, so `Layers` and `Overview` are unchanged and
`(brain-level)` cannot leak onto a page that does not implement it — the hook's
state is per-mount, and `router.tsx` unmounts the page on a route change.
G-BR-10c is the behavioural half, and it closes its window on `/api/projects`
counts: the ladder's own request, so the witness is direct rather than the
inference G-BR-9 had to make from `/api/health`.

**What the unscoped Overview shows: the same four cards, each read with its
project predicate dropped.** Per-project rows were rejected (that is a list
view, and the list views are `#/layers/*`); a reduced card set was rejected (the
card whose brain-wide meaning is least doubtful is GRAPH SCALE, which was
already whole-brain — `/api/graph/stats` needed no change at all, only the
page's own `selected === null` branch had been blanking it). The BRIEFS footer
reads `everything` rather than "all projects" because dropping a predicate
counts rows that belong to no project — see the `/api/summary` section above for
which cards that actually changes.

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

### The node size law, and what FR-244 measured (2026-08-02)

**What FR-244 was originally asked for, and why it did not ship that.** The
brief's first acceptance criterion was *"nodes render as circles, in every
state"* — round nodes were the operator's proposed remedy for a canvas that read
as ugly and dense. It was withdrawn at sign-off once the cost was measured: at
Tier C the chrome is `silhouette`, which draws no border, no dash and no glyph,
and colour is spent on interaction STATE (rest / active / filtered) rather than
on role — so **shape is 100% of the role signal in exactly the view the
complaint came from**, and rounding everything would have erased role there with
no fallback carrier. The stated GOAL was legibility; circles were a means; the
means was dropped and the goal was pursued through density instead. `tracePath`
is untouched. If the canvas still reads wrong after this, that is a new brief
with the role-encoding cost already priced — see the rung-6 section below for
the half a size law provably cannot reach.

Node size is drawn at a **constant SCREEN size**: the context `force-graph`
hands a paint accessor is already in graph coordinates, so `shapes.ts` divides
by the zoom factor `k`. That is what kept a Tier C silhouette 8 CSS px across
at every zoom — and it is also why the whole-brain canvas turned into an
unreadable blob when zoomed out. The arithmetic is unforgiving: with a constant
screen size `p` and a world nearest-neighbour distance `d`, the on-screen gap is
`d·k − p`, so **for any fixed pixel size there is a zoom below which nodes must
merge.**

Measured by `G-BR-11` in a real browser, Tier C, 710 nodes / 352 edges:

| `k / k_fit` | components BEFORE | components AFTER |
|---|---|---|
| 1 (`zoomToFit`) | 358 | 358 |
| 1/1.5 | 349 | 354 |
| **1/2** | **57** | **353** |
| 1/3 | 1 | 350 |
| 1/4 | 1 | 333 |
| 1/8 | 1 | 258 |

It is a **percolation** transition, not a fade: the field went from 97.5% of its
structure to 0.3% across a factor of two in `k`.

The fix is a **clamped divisor** — `shapes.ts#nodeWorldSize`, one law that every
node geometry on this canvas goes through. Above `K_FLOOR` nothing changes and
the 8 px floor is honoured exactly as before; below it the node is frozen in
WORLD units, so the field and the nodes in it scale down together as one
photograph and every gap survives. `K_FLOOR = 0.11` is the measured value — the
last zoom at which the picture still held its structure (0.10533), rounded up.

**What it does NOT fix — and a claim TD-337 falsified.** This paragraph used to
read: *"Separability at FIT: 358 components for 710 nodes, and the deficit is
exactly the 352 seeded edges… no uniform force change can reach it, because at
FIT the picture depends only on the layout's SHAPE: anything that spreads the
layout is undone by `zoomToFit()` zooming out to match."*

**Both halves are false as of FR-250.** Doubling the canvas moved the FIT
reading **358 -> 710 of 710** on a byte-identical bundle and an identical
payload. So the FIT picture is a function of the canvas BOX, not only of the
layout's shape — the invariance the old argument asserted is exactly what
FR-250 refuted, and the 352-pair fusion it described does not manifest at FIT on
the shipped box.

That is why TD-337 re-anchored `11a` away from FIT entirely: a denominator that
moves when the layout does cannot calibrate anything. The lever that would work is
the RATIO of link distance to layout extent, which is a layout-tuning change
that moves `G-BR-7`'s `7d` ink-spread reading. FR-244 measured it and left it;
it belongs with rung 6 below.

**Labels deliberately do not follow the law.** `LABEL_LINE_PX` and
`LABEL_GAP_PX` stay constant on screen: they are type metrics with their own
legibility floor, and a label that shrank with the nodes would be unreadable at
exactly the zoom the operator needs it. Measured as a non-cause of the density
defect anyway — at Tier C `labels` is `active-only`, so a resting canvas with no
selection draws none at all.

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

**FR-244 narrowed what rung 6 is still for, without implementing it.** The
zoom-out half of "past the legible floor" is now handled by the size law above:
zooming out no longer collapses the field, so the operator can pull back and
still see structure. What remains for rung 6 is the half a size law provably
cannot reach — nodes that overlap *at fit*, because they are genuinely that
close in the layout. That WAS the 352-pair fusion measured above — see the correction there: it does not manifest at FIT on the post-FR-250 box, so rung 6 is aimed at a reading that has since moved. Rung 6, or a
collision force, or a link-distance change: all three are layout work, all three
move `G-BR-7`'s `7d` reading, and all three want their own brief.

The banner also **moved out of the page flow** in FR-244 and is now an overlay
inside `.graph-surface`. It is the only banner on the page whose visibility is
computed from the canvas's own measured box (`graph.aggregating` is set by the
ResizeObserver), so with a full-column canvas it was the only one that could
form a feedback loop with the canvas's height — mount, shrink the canvas, refire
the observer, unmount, grow. Out of flow, the loop cannot start.

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

Since **TD-347** the script also prints the two figures the byte gate asserts,
so the safe build states them directly:

```
build-dashboard: INITIAL SET 286070 bytes over 2 file(s) -- assets/index-C3rlMPd-.js, assets/api-iTPwGhDY.js
build-dashboard: TOTAL JS    580979 bytes over 12 chunk(s), 10 deferred (294909 bytes off the critical path)
```

**INITIAL SET is a LOAD, not a file** — the entry `<script type="module">` plus
every `<link rel="modulepreload">` in `index.html`, i.e. everything the browser
downloads before it can paint. FIVE of the six route pages are `React.lazy`, so
`Graph` (which exclusively owns the vendored `force-graph`), `Layers`, `Triage`,
`Search` and `Diagnostics` arrive on navigation; `Overview` stays eager because
it is the router's fallback for `#/` and every unknown hash.

**AND SINCE FR-266 THAT DISTINCTION IS LOAD-BEARING RATHER THAN PEDANTIC.** The
reading above is over TWO files, not one. Adding a fifth lazy route made
`lib/api.ts` shared across enough boundaries that Rollup hoisted it out of the
entry and Vite emitted a `modulepreload` link for it, so:

```
BEFORE FR-266   INITIAL SET 285_689 B over ONE file  (index only)
AFTER  FR-266   INITIAL SET 286_070 B over TWO files (index + api)
```

The entry FILE shrank by 10_501 B while the initial LOAD grew by 381 B. A gate
measuring the entry file would have recorded a 3.7% improvement for a brief that
cost bytes. The figures are re-derived by the script on every run; do not quote
them from here without re-running it.

**The two ceilings are UNCHANGED and were not re-based.** They live in
`cli/src/__tests__/dashboard-chunks.test.ts` as `measured + HEADROOM`, where
`measured` is the TD-347 BASELINE and `HEADROOM` (24_000 B) is what briefs spend
against it. Re-basing `measured` upward raises both ceilings by exactly the
amount already spent, which is a ceiling raise wearing the words "re-measured".
FR-266 fit — TOTAL 580_979 B against a 586_923 B ceiling — so it did not move
them, and it left **5_944 B of slack** — 45 B MORE than FR-247's 5_899 B, the
largest single-brief chunk spend the ledger records. So an FR-247-shaped brief
would just fit, which is a coincidence rather than a margin; and that ledger only
begins measuring chunk deltas at FR-246, while FR-240 spent ~+47_700 B in one
brief (~8x FR-247's). The largest spend on record is therefore the largest in a
sample that excludes the only brief big enough to bust this ceiling outright. The
next brief adding a route should size its chunk spend BEFORE the work and take it
to the operator with the estimate on the record.

**ON THIS MACHINE `npm run build` IN `cli/` IS A LIVE DEPLOY** — the operator's
MCP runs the brain server out of `cli/dist`, so a build ships to a running
brain. Use `bash cli/scripts/build-dashboard.sh` for any dashboard measurement:
it writes only the gitignored `cli/dist/dashboard`. This is also why the PACKED
figure cannot be re-measured mid-brief, and why a `+0 B` packed delta means
*not rebuilt*, never *free*.

`cli/package.json` `files` already lists `"dist"`, so `dist/dashboard/**` ships
with no manifest change. `tarball.test.ts` asserts that it actually does, and
that the packed size stays under the packed-size ceiling (introduced by FR-238, raised to +550 KB by TD-329, then RE-BASED and set to +150 KB by TD-374 on 2026-08-10 — a larger absolute cap, measured from a clean origin rather than an FR-238-era one).

All build dependencies (vite, react, react-dom, tailwind, gsap) are
**devDependencies**. `npm i -g igris-ai` installs **zero** new runtime deps —
the server is `node:http`.

---

## Testing

| Suite | Covers |
|---|---|
| `cli/src/__tests__/dashboard-server.test.ts` | bind, static, traversal, Host allowlist, CORS absence, security headers on every response class, the method guard, the four endpoints, four degraded brains, the zero-SQL scope assertion (extended to `brain-write-bridge.ts` by FR-241), and FR-241's write fences — `GET /api/triage` → 405, a POST to any other path → 405, a foreign `Origin` → 403 with the absent and exact-match cases as its controls, `text/plain` → 415, a 1 MB body → 413 |
| `cli/src/__tests__/dashboard-lock.test.ts` | lock write/read/atomicity, **0600 mode (including the stale-tmp rewrite path)**, liveness classification, pid reuse, stale reclaim, ownership-checked release |
| `cli/src/__tests__/brain-bridge.test.ts` | module resolution in a built tree, memoisation, read-only handle, every degradation path |
| `cli/src/__tests__/dashboard-artifact.test.ts` | bundle present, bundle current (stale guard), AC #4 no-network |
| `cli/src/__tests__/dashboard-chunks.test.ts` | **TD-347 — the bundle's two byte ceilings.** `INITIAL_JS_CEILING` over the initial LOAD (the entry `<script>` plus its `<link rel="modulepreload">` closure, NOT the entry file), `TOTAL_JS_CEILING` over every `assets/*.js`, and an assertion that at least one chunk is non-initial so the app cannot quietly un-split. Both are `measured + 24_000 B`; **neither is ever raised to make room.** Demonstrated red three ways — eager bulk (both red), lazy-only bulk (initial green, total red — the reason the total half exists), and a vendor `manualChunks` split (entry file −189,996 B, initial set −343 B, green and correct). |
| `cli/src/__tests__/open-url.test.ts` | every rung of the ported open ladder |
| `cli/src/__tests__/tarball.test.ts` | `npm pack` manifest + packed-size ceiling — **+150 KB** over baseline since TD-374 (2026-08-10), which RE-BASED `PACK_BASELINE_PACKED` to a clean measurement (1_863_420) and re-derived the grant; the delta now means growth-since-clean, not growth-since-FR-238, and the absolute cap ROSE (1_865_051 → 2_017_020). It was +550 KB from TD-329 (2026-08-02) and +400 KB before that. Both moves were recorded operator decisions taken *before* the work that needed them, on a measurement. The single asserted number. Measured LAST in every brief, because the figure is stale the moment another round edits a comment in `cli/src/lib/**` (`tsc` carries those into `dist/` verbatim) or touches `cli/CHANGELOG.md`, which is in `package.json` `files` and SHIPS. Cumulative by brief: **+331.8 KB** (FR-240) → **+370.6 KB** (FR-241) → **+373.6 KB** (BR-082) → **+376.4 KB** (TD-326) → **+400.7 KB** (TD-328) → **+402.8 KB** (FR-244) → **+406.4 KB** (FR-245) → **+432.8 KB** (FR-246) → **+445.1 KB** (FR-247) → **+445.1 KB** (FR-250, +1_471 B — CSS lands in the stylesheet asset, so the app CHUNK is byte-identical and its 616 B of slack is untouched), leaving **104.9 KB** under TD-329's +550 KB ceiling. (Every figure in that chain is against the OLD baseline and was measured on a tree carrying the orphan artifacts TD-373 deleted; TD-374 re-based, so convert with `new = old − 561_569` and read them as narrative rather than as comparable to anything measured after 2026-08-10. The live headroom is NOT restated here — `tarball.test.ts`'s head directive is the one authoritative copy, and every stale figure this file has carried came from a second one — `tarball.test.ts` is the one authoritative copy.) FR-245 spent **+3_698 B** against a +6-12 KB estimate, for the same structural reason FR-244's was small: a whole board view, a browser gate, eight mutations and three suites' worth of assertions, of which the only packed surface is `cli/dashboard/src/**` — which Vite minifies — plus its changelog entry. (Watch the OTHER limit — it was effectively SPENT from FR-247 (616 B) through BR-085 (484 B), and **TD-347 RETIRED THE PREMISE**: there is no single app chunk any more. The dashboard now ships an eager INITIAL SET of **285,390 B** plus six deferred chunks holding **277,533 B** off the critical path, and the binding budget is two EXECUTABLE ceilings in `cli/src/__tests__/dashboard-chunks.test.ts` (`INITIAL_JS_CEILING` 309,390 B and `TOTAL_JS_CEILING` 586,923 B), not a Vite warning. `chunkSizeWarningLimit` is re-aimed just above the largest chunk and demoted to a build-time surprise detector. A brief adding UI now plans against the INITIAL ceiling and reads the composition table in `tarball.test.ts` to see which chunk it is charged to. FR-247 spent **+11,132 B** here against a 17-32 KB estimate and **+5,899 B** of chunk against a 2.5-4.6 KB one — two errors in opposite directions across two briefs, which is why both surfaces must be estimated AND measured. Note the units differ: Vite reports kB as 1000 bytes, this ceiling is in KiB. It is a build-time warning about one chunk, not this ceiling.) FR-244 spent **+2_088 B**, and where it went is the instructive part: everything BULKY it added lives outside `package.json` `files` — a new browser gate and its separability instrument in `cli/scripts/`, four suites' worth of assertions under `src/__tests__` (excluded from `dist` by `tsconfig`), and `docs/`. Its client-side changes are minified by Vite to almost nothing. Essentially the whole figure is its `cli/CHANGELOG.md` entry, which ships. TD-328 is the first non-dashboard, non-`cli/` brief in this ledger and it spent 24.3 KB anyway: the `cli` package BUNDLES the compiled brain server at `dist/brain-mcp-server/dist/**`, so a `brain-mcp-server/`-only change still costs packed bytes (learning 1132). It is also the first entry-count change since FR-241 (792 → 793), from the new packed `dist/brain-mcp-server/scripts/normalize_brief_types.ts`. |
| `cli/src/__tests__/dashboard-graph-endpoint.test.ts` | `/api/graph` payload shape field-for-field, project drill-down + `boundary` nodes, four degraded brains, inherited security posture |
| `cli/src/__tests__/dashboard-graph-query.test.ts` | the exemption-04 twin: whole-brain, scoped, truncated, degraded; the cap constants checked against the real engine |
| `cli/src/__tests__/dashboard-graph-source.test.ts` | zero colour literals in the graph source, the F2 camera scan, library-API confinement, zero rAF/`setInterval`, token-only timings |
| `cli/src/__tests__/dashboard-layers-endpoint.test.ts` | FR-240 — the nine layer endpoints: envelope shape, filters over DISAGREEING fixture partitions, pagination, the BR-078 `(project, id)` refusal, four degraded brains. **G-EP-4 (TD-326)** adds the suggestion scope axis: a NON-EMPTY project-less population asserted first, `facets.brain_level` non-zero from inside a project scope, `project_scope=brain-level` listing exactly the `IS NULL` rows, both scopes at once dropping `project` and NAMING it, a near-miss value dropped and named, and the three other endpoints REPORTING `project_scope` as unknown |
| `cli/src/__tests__/dashboard-learnings-search.test.ts` | FR-240 AC #2 — recall semantics (hybrid / `bm25_only` / `vector_only` / `none`), the `retrieval` block field by field, and the hermetic-by-construction guard that asserts **itself** armed |
| `cli/src/__tests__/dashboard-learnings-search-params.test.ts` | BR-085 — what the handler FORWARDS, asserted at the seam with a recording reader: the whole key set of the options object, the derived rule that every allow-listed filter is forwarded OR named, and the version-skew case where an older vendored reader has no review axis and the payload must refuse to claim the scope. The endpoint suites cannot see this class: a dropped filter returns a plausible list |
| `cli/src/__tests__/dashboard-context-docs.test.ts` | FR-240 D8 — the inventory is forwarded not recomputed; traversal slug, traversal `type`, unregistered slug and a planted symlink are all refused; the lens does not CREATE the brain |
| `cli/src/__tests__/dashboard-readonly.test.ts` | FR-240 AC #7 — a full crawl of every endpoint against a snapshot, compared by logical dump **and** file digest, with a deliberate-writer negative control proving the comparison can report a mutation. FR-241 added **G-RO-6**: after the same request sequence `writeEngineState()` must still read `"not-booted"` and the digest must be unchanged, with a self-negative-control in the same test where one `POST /api/triage` flips it to `"booted"` and *does* change the digest. Stillness is not liveness. **TD-319 rewrote G-RO-5**: it converts the fixture to `journal_mode = delete` and drives the WHOLE tier — layer readers and the four paths on an FR-238-era accessor alike — asserting no journal flip, no `-wal` sidecar, no `.db` rewrite and no DDL. Its four predecessor pins recorded the OPPOSITE (they characterised the residual so it could not drift into an unqualified doc claim) and carried their own delete-me instruction; landing the fix executed it. The payloads-are-real companion is what stops the stillness being satisfied by a reader that returned nothing |
| `cli/src/__tests__/dashboard-triage-endpoint.test.ts` | FR-241 — the sandbox fence first (the real brain's digest is unchanged at suite end, and a poison `IGRIS_DB_PATH` does not move the writes); each of the five actions end to end with its pre-state asserted; bulk-dismiss 12 of a seeded 17 with the surviving 5 named; partial failure and the `MAX_BULK` clamp; the degraded write surface **with its negative control**; delegation proven behaviourally as well as by scan; and gateway validation reported in the **gateway's own** message text. **G-TR-7 (TD-326)** bulk-dismisses the project-less cohort and asserts BOTH directions of non-interference — the projects are unmoved by a brain-level bulk, and the brain-level rows are unmoved by a project bulk **FR-247 adds G-TR-8..G-TR-14**: the forbidden build-state fields refused at the door and the `ids` versus `refs` exclusivity refused by name (G-TR-8); the built argument key SET with the parser BYPASSED, including `attach_goal` forwarding both halves of the ref since BR-083 (G-TR-9); the args the resolved `handleBriefUpdate` actually RECEIVED, by call trace, plus the row read back field by field (G-TR-10); **AC-4 RED-FIRST against the SHIPPED handler** — the `brief_files`-only brief is dispatched unguarded and the invented `status='Ready'` and blanked `title` are OBSERVED, then the same write through the endpoint is refused and the damage is absent, with the `igris_brief_sync` contrast and the live NOT NULL constraint the guard's predicate depends on (G-TR-11); a bulk over 12 of 17 briefs with the other 5 asserted byte-identical and an empty `refs` refused with a 400 (G-TR-12); **the auto-push egress fence PROVEN in both arms** — zero blocked requests with no config, and an observed blocked POST to a fictional remote when auto-push is on (G-TR-13); and the degraded surface with its negative control (G-TR-14) |
| `cli/src/__tests__/auto-push-fence.ts` | FR-247 — the R4 egress fence every mutating suite arms. TWO independent layers, both read back before a single write: `HOME` is pointed at the sandbox so `loadAutoPushConfig` reads a config the test owns, and `globalThis.fetch` is replaced by a RECORDING THROWER so even a config that said `auto_push: true` cannot reach the network. It is PROVEN rather than asserted by G-TR-13's second arm — a fence over a machine where auto-push is already off proves nothing, since zero requests is equally what a broken fence and an unwired listener produce |
| `cli/src/__tests__/dashboard-triage-parity.test.ts` (FR-247) | **G-EP-4 is this family's first genuinely NON-EMPTY parity control.** FR-241's differ compared `[]` with `[]` for four of five actions; `brief.synced` is in `EVENT_COMPONENT_MAP` and monitoring subscribes it, so a priority write through MCP and through the dashboard each produce exactly one identical `event_log` row — asserted as literals (`brief.synced` / `briefs` / the project slug / the payload), not assumed. **G-EP-5** is the declared-EMPTY complement: `edge.created` is in neither the map nor the listen list, so an attach is event-silent BY CONSTRUCTION and `entity_edges` carries the something-happened half. **G-EP-6** flips four ways against G-EP-4's non-empty rows, including a `brief_status`-ONLY difference with `event_log` still matching — the failure an event-only differ cannot see, and the reason `brief_status` joined the domain set |
| `cli/src/__tests__/dashboard-triage-parity.test.ts` | FR-241 — the twin-brain differ. Two brains in two **processes** (`setAdapter` is a module global, measured to cross-contaminate two engines in one process), identical fixtures, identical boot config: one dispatches through the engine directly, the other over HTTP. Diffs the `event_log` delta **and** the mutated domain tables, with the excluded-column list itself asserted so it cannot quietly grow to cover a real difference. Its empty case declares that it EXPECTED empty and cites why; its positive control is a recurring reject, then mutated to prove the differ can fail |
| `cli/dashboard/src/triage/__tests__/model.test.ts` + `components/triage/__tests__/BulkBar.test.tsx` | FR-241 — the tiering logic and the confirm copy, table-driven: a mixed selection of 3 recurring + 2 first-time rejects names **2** as permanently deleted, not 5 and not 0; the empty selection and the all-tier-3 case; the typed-count requirement |
| `cli/src/__tests__/dashboard-params.test.ts` | FR-240 — the pure clamp/allowlist: hostile `limit`/`offset`, unknown filters named rather than ignored. TD-326 adds `project_scope`: a CLOSED vocabulary, a near-miss dropped and named, no OTHER filter set declaring it, and an executable statement of the REJECTED design (a magic `project` value is accepted verbatim by every set) |
| `cli/src/__tests__/dashboard-layers-source.test.ts` | FR-240 — whole-tree client scans: no string-to-markup path, the composite key not mirrored browser-side, zero colour literals **and zero custom properties** in the `.record-*` block, no absolute URL, no non-GET request. TD-326 adds the client/server seam scan: the wire literal the client sends is in the server's `PROJECT_SCOPES`, the UI sentinel fails `SLUG_RE` so it cannot collide with a project, and exactly one shipped file emits the param. **FR-245 adds the AC-6 read-only scan** over the five board files: the drag CONCEPT in every spelling (attribute, handler props, event names, `dataTransfer`), the write path by name, no `method:` and no `fetch(` — with a planted affordance the same matcher MUST find, and a comment-only mention it must not. Plus: exactly one shipped file persists the view, in `sessionStorage` and never `localStorage`. Every scan carries a self-negative-control |
| `cli/dashboard/src/graph/__tests__/` | the stillness instrument (**T6, the anti-fake layer**), the pause/resume state machine, tiers + the ladder, label occlusion, D9 shape/edge mappings, palette resolution, motion tokens, the volume bench, and (FR-240) `neighboursOf` extraction-equivalence |
| `cli/dashboard/src/{markdown,layers,components/record}/__tests__/` | FR-240 — the markdown parser incl. HTML-injection cases, the layer model (filters, the deep-link codec with the BR-078 duplicate-id case, the four empty states), and the record components rendered through `react-dom/server`. **FR-245 adds `layers/__tests__/board.test.ts`** — the column derivation against the operator's real 15-value status distribution (read READ-ONLY, reproduced as a literal): every value gets exactly one column, `In Progress`/`InProgress` are TWO adjacent columns with unsummed counts, `Done`/`Completed`/`Complete` are THREE, an invented status still gets one, the per-column query carries the column's own status once and never the user's, and the order is deterministic — including a test that STATES the residual (the three finished synonyms are not adjacent, and why making them so would be the fold). The board's render half is in `record.test.tsx`: the same descriptor emits identical row markup through the list and the board |
| `brain-mcp-server/src/tools/__tests__/` + `engine/components/goals/__tests__/read.test.ts` | FR-240 — the three pure readers, `pure-read-purity.test.ts` (**with a fixture the scan MUST flag, so the scan has a self-negative-control**), and `wrapper-wire-parity.test.ts` golden strings proving the MCP wire output did not move |
| `cli/tests/integration/dashboard.bats` | lifecycle, double invocation, stale locks, `--port` hard-fail, degraded brain, pack-extract smoke, `/api/graph` on a seeded and a missing brain, **the nine layer endpoints on a seeded and a missing brain (T23)**, and an exact-set assertion over the `--smoke` probe list — which since FR-241 carries `/api/suggestions` **and** the entry `POST /api/triage`, whose probe sends a deliberately invalid action and expects a **400**, so `--smoke` proves the write pipeline is routed while mutating nothing |
| `cli/scripts/browser-gate.mjs` | FR-240 — the real-browser gates, extended by FR-241 with a triage world and a triage scenario (select rows, open the confirm, **cancel** and assert no request was issued, then confirm and assert the rows leave the list). The witness for "cancel issued no request" is an in-page `__gate.triagePost` counter, because a server log cannot tell a triage POST from any other request. Extended again by BR-082 with G-BR-9 (the Overview scope clear, held across two measured live beats) and two more in-page counters, `__gate.healthFetch` / `__gate.summaryFetch` — which witness LIVENESS rather than stillness, since a scope that "survived" a paused beat proves nothing. FR-244 adds the `dense` (Tier C) world, G-BR-11, and an in-page separability instrument — a 4-connected component count over a thresholded ink map of the canvas, calibrated ONCE at fit and held absolute so a sweep across zooms is a paired reading rather than a re-normalised one. FR-245 adds **G-BR-12** (the briefs board) on its own tabs over the `seeded` world plus one gate-local brief carrying a 66-character status — seeded HERE rather than in the shared fixture, which the vitest endpoint suites assert exact counts on — and two more in-page witnesses, `__gate.nonGet` (broader than `triagePost` on purpose: the claim is that the board issues no write of ANY kind) and `__gate.briefsFetch`. **Not** part of `npm test`; see below |

Browser-side tests live under `cli/dashboard/src/**/__tests__/` and are collected
by the **`cli` vitest run** (verified empirically with `npx vitest list` before
any of them were written — a test that does not run is worse than no test). They
run in the node environment, so every module they reach must be DOM-free; that is
why `graph/instance.ts` receives its `force-graph` constructor as a parameter
rather than importing it.

**Components ARE unit-testable there, which the FR-240 plan assumed they were
not.** `react-dom/server`'s `renderToStaticMarkup` needs no DOM, `react-dom` is
already a devDependency, and vitest resolves `cli/dashboard/tsconfig.json` for
JSX. So `Markdown`, the record family, `NodeInspector` and the retrieval banner
are all gated at unit level — including the XSS tag-allowlist — and the browser
budget below is spent only on what a real browser can prove.

**`brain-mcp-server` vitest is NOT run by any CI workflow** (TD-312, open). The
FR-240 pure-reader suites and the wrapper wire-parity goldens therefore have
**exactly one gate: a local `cd brain-mcp-server && npm test`.** Run it before
claiming the extraction is safe.

The `cli` vitest run and bats run in CI on push and PR via
`.github/workflows/test.yml`'s `cli-bats` job, alongside
`npm run typecheck:dashboard`.

### The FR-240 browser gate — `cli/scripts/browser-gate.mjs`

FR-239 shipped two bugs that 1,612 green tests could not see, and both fell out
in minutes under headless Chrome. That run was ad-hoc, so nothing re-runnable
survived it. FR-240's is a script:

```bash
cd cli && npm run build            # the gate drives the BUILT bundle
node cli/scripts/browser-gate.mjs  # exits non-zero on any FAIL
```

> **This gate currently exits NON-ZERO on a clean tree, and that is expected.**
> Exactly one check — **`G-BR-7/7d`** — ships RED as of FR-244 (2026-08-02) by
> operator decision, and **TD-332 owns it**. `7d` is a pixel proxy whose metric
> measured distance in grid-CELL units (square only when the canvas is), so
> FR-244's full-height reflow moved the reading without any behaviour changing.
> The metric was repaired to be aspect-invariant and still misses its
> thresholds, which were deliberately NOT widened. **The behaviour `7d` proxies
> for is independently green:** `7b` (a back-out issues zero new `/api/graph`)
> and `7c` (its measured control) both pass, and `--mutate=br7-refetch-backout`
> still fails `7b` on purpose. Read the `note(...)` blocks beside the `7d` check
> in `browser-gate.mjs` before diagnosing — and note that `7d` turning GREEN
> without someone fixing it is the SURPRISING result, not the reassuring one.
> The gate is manual-only: no pre-commit hook and no CI workflow invokes it.

The check COUNT is deliberately not written down here. It was "46" for three
briefs after it had become 72, because a number in prose has nothing executing
beside it to catch it going stale (the same trap the packed-size ledger records
as learning 1131). The run prints its own `n/m checks passed`; read that.

No new dependency: Node 24 has global `fetch` and `WebSocket`, so CDP is driven
directly. Chrome is located at the macOS default and overridable with
`CHROME_BIN`. It starts a dashboard server over a `mkdtemp` sandbox
(`IGRIS_BRAIN_DIR`, never the operator's brain) for each of **six** worlds,
seeded from the same fixture the vitest suites use — `seeded`, `vec` (a
`learnings_vec` index, so the VECTOR arm is available; whether recall actually
runs hybrid additionally needs the embedding model — see below), `empty`
(schema, no rows), `missing` (no database), `triage` (FR-241, built by the
engine's own migrations because that is the only schema the write door boots
against) and `dense` (FR-244 — the fixture plus 700 `learning` rows, which is
what puts a payload in **Tier C**, the only tier where the density defect
exists). Three of the gates are about the **disagreement** between those worlds;
a single-world run cannot tell "the empty state renders" from "the empty state
always renders".

`--gates=11` runs a named subset. It is a development aid for iterating on one
gate without paying for the rest of the ladder (the count is deliberately not
written down here — the run prints its own), and it is fenced: a filtered run stamps
`FILTERED` and the list of gates that did not run into its own verdict line, so
a filtered transcript cannot be quoted as evidence of a green ladder. **Evidence
reported for a brief is always an unfiltered run.** `G-BR-0` is the one gate
`--gates=` cannot switch off (TD-332): it audits the ledger the other gates
wrote, so under a filter it RUNS and **skips its checks with the filtered gates
named** rather than vanishing — see the `KNOWN_RED` section below.

**Neither the gate nor `npm test` reaches the network.** Every server the gate
starts runs with a `--import` preload that sets `env.allowRemoteModels = false`
on the vendored `@huggingface/transformers` and writes a receipt the run asserts
(`3-hermetic`); the vitest suites arm the same flag in-process through
`dashboard-layers-fixture.ts#armHermeticEmbeddings` and each asserts it.
Without it the gate silently downloaded ~90 MB from the HF Hub on any tree where
the model cache was absent — which is *every* freshly built tree, because
transformers.js v3 caches package-locally inside `cli/dist/` and
`scripts/copy-templates.sh` wipes that directory on each build. So on a normal
build `retrieval.mode` is `bm25_only` even in the `vec` world, and the gate
asserts the mode is **consistent with the reported capability** in either
direction rather than assuming one. Exactly one of `3f-hybrid` (the quiet HYBRID
readout) and `3f-loud` (the loud degradation banner with `vector_available`
still true) runs; the other is reported as **SKIP with its reason**, counted
separately from PASS and named again in the verdict line. There is no silent-skip
path. To exercise the hybrid arm deliberately, warm the cache once and re-run —
the gate prints the exact command.

| Gate | Proves | Does NOT prove |
|---|---|---|
| **G-BR-0** (TD-332) | the LEDGER, not the browser: every `KNOWN_RED` row names a check that actually ran (`ledger-orphans`), and no check id was emitted twice, since `KNOWN_RED` keys are gate-**unqualified** (`ledger-ids`). Numbered 0 and run **LAST** — `notRun` is only fully populated once every gate has been reached, and `notRun` is what it self-fences on | that a known-red row is still the RIGHT disposition — that is a judgement a brief owns; this only says the row still has a subject. Nor anything at all on a filtered run: under `--gates=` it SKIPS both checks, loudly, because every row owned by a gate that did not run would otherwise read as an orphan |
| **G-BR-1** | AC #3 both ways with real clicks: list row → detail, LOCATE IN GRAPH → the node selected on the canvas, OPEN RECORD → back to the same address. Plus `BR-001` in two projects resolving to two different records | anything about node types with no detail view — 1e asserts that STATE explicitly (`// NO DETAIL VIEW FOR ERROR`) rather than a blank panel |
| **G-BR-2** | the chips and both search boxes are WIRED: each rendered row count matches the endpoint's own `count` for the same filter, over fixture partitions that disagree | ranking, or that the SQL binds — `dashboard-layers-endpoint.test.ts` owns that |
| **G-BR-3** | all four `EmptyKind`s observed in pixels (`degraded` / `empty` / `filtered` / `no-project`); that the hermetic guard is ARMED; and that the reported `retrieval.mode` matches the reported capability, with the banner LOUD (`BM25 ONLY`) whenever an arm did not run and QUIET (`HYBRID RECALL`) when both did | that the copy is right — operator review. The `vec` world's vectors are deterministic, not real embeddings, so it proves the MODE plumbing and never recall quality. On a tree with no warm model cache the QUIET-hybrid DOM rendering is SKIPPED and **no sibling covers it** — the endpoint's field separation is proven offline by `dashboard-learnings-search.test.ts` and the recall semantics by `memory-read.test.ts`, but neither renders |
| **G-BR-4** | zero `requestAnimationFrame` callbacks and zero canvas clears across a 3-second rest on each of the four views, measured by instruments installed BEFORE the bundle and opened only once the surface has REACHED rest (a surface that never does fails with its observed rate, which is why the precondition cannot mask a loop); the four palettes resolving to four distinct `.record-*` colours; and the whole FR-239 stillness checkpoint re-run after the `graphCache` hoist, pointer liveness and node-click included | that DOM mutations are zero — they are not, by design (the 5-second `live.tick`), so the mutation count is MEASURED and printed rather than asserted |
| **G-BR-5** | ACCESS, not bytes: a brief's body, a learning's content and a context doc's text are READABLE in the live DOM, and two different records render two different bodies | markdown fidelity or XSS safety — `markdown/__tests__/` own both |
| **G-BR-6** | `prefers-reduced-motion` really collapses animation in the page, with the un-emulated reading as the paired control | that each animation is gated in JS — `motion.test.ts` T17 and `Cursor.tsx` own that |
| **G-BR-7** | the hoisted scope cache is real in the browser: a drill issues exactly one new `/api/graph`, backing out issues **zero** and restores the whole-brain readout, and a REFRESH on the same surface issues one — so the zero is a measured zero. Plus, in pixels, that the back-out OPENS at its settled layout extent while a cold REFRESH opens as a clump at the origin and expands out of it | that the restored coordinates equal the pre-drill ones. Nothing in the page exposes coordinates, and a settled-frame comparison cannot discriminate: d3-force's cold layout for a fixed node array is deterministic, so a restored layout and a cold one converge to the same picture. The seed is applied but NOT pinned (`instance.ts` sets `x`/`y`, not `fx`/`fy`), so a back-out is a short re-relaxation rather than a freeze-frame — measured at 72.0-74.1% of settled extent versus 56.2-59.5% cold (TD-332, 7 runs, 2026-08-05, at the now-explicit 1440×900 viewport; the older ~85%/~61% figures were taken on the pre-FR-244 canvas). **`7d` SHIPS RED and TD-332 owns it** — see the KNOWN_RED ledger below. The cache MECHANICS are the sibling: `cli/dashboard/src/lib/__tests__/graphCache.test.ts` |
| **G-BR-8** (FR-241) | the triage write path end to end in a browser: the scoped queue agrees with the endpoint, the row badges distinguish a permanent reject from a recurring one, CANCEL issues **zero** POSTs (an independent in-page counter), a mixed selection's confirm dialog names the tier-3 subset rather than the selection size, a tier-3 bulk demands the count typed, and a world with the write surface down renders the affordances *disabled* rather than broken | that the brain applied the right mutation — `dashboard-triage-endpoint.test.ts` and `dashboard-triage-parity.test.ts` own that. The gate reads rows leaving a list, not rows changing in a table |
| **G-BR-9** (BR-082) | the Overview opens scoped to `default_project`, re-clicking the checked chip **clears** the scope, every card widens to the value its UNSCOPED endpoint reports, and that widened state is still on screen after the page has issued ≥2 further `/api/health` polls **and** ≥2 further `/api/summary` reads across ≥10 s — so the clear survived the beat that used to undo it | that the hook's `undefined`-vs-`null` distinction is the MECHANISM. This reads a page, not a state machine, and would pass for any implementation that keeps the clear. The mechanism's siblings are `dashboard-layers-source.test.ts` (exactly one scope implementation, and Overview consumes it) and `useProjectScope.ts`'s docblock. Nor that the NUMBERS are right — it asserts DOM-vs-endpoint agreement, and `dashboard-server.test.ts` owns what the endpoint should say |
| **G-BR-10** (TD-326) | the three populations are DISTINCT and none is empty (6 scoped + 4 brain-level + 2 other = 12 everything, asserted as arithmetic); a project-scoped page banners the brain-level count and not the all-projects total; the `(brain-level)` chip sits in the ONE `Project scope` radiogroup and selecting it lists exactly the project-less rows; that selection survives ≥2 further `/api/projects` polls across ≥10 s — the ladder's OWN request, so the witness is direct rather than inferred; SELECT PAGE + DISMISS empties the brain-level queue and leaves the project's queue at 6; and the Candidates tab under that scope states its schema reason instead of fetching | that the endpoint's answers are correct — `dashboard-layers-endpoint.test.ts` G-EP-4 (the reads, the param handling, the drop-and-report) and `dashboard-triage-endpoint.test.ts` G-TR-7 (the mutation, and the symmetric "a project bulk leaves brain-level alone") own that. Nor that no OTHER affordance exists; it asserts the DOM agrees with the endpoint for the scope it selected |

| **G-BR-11** (FR-244, re-anchored by TD-337) | in the `dense` (Tier C) world, with every separability check anchored to **`K_FLOOR`** (the source constant `NODE_SIZE_ZOOM_FLOOR = 0.11`) and to nothing else: the canvas is driven with REAL wheel events down a sweep of ABSOLUTE zooms, and **below the clamp the picture freezes** — the component count at `K_FLOOR/2` holds ≥ 95% of the count AT `K_FLOOR`, with no component owning more than a fraction of the ink (`11a`); the same metric REPORTS the merge that is genuinely present at that anchor — 710 nodes render as 354 components, a deficit of 356 against the 352 seeded edges, which is the very reading `11a` divides by (`11b`); `k_fit` sits above every anchor so each is reachable by zooming OUT from FIT (`11-range`); the ACHIEVED zoom is within 5% of the REQUESTED one at every anchor (`11-anchor`); the anchored reading is **INVARIANT to the canvas box**, measured by setting `--graph-column-scale` in the page and moving `k_fit` 2.58× while the reading moves ≤ 0.56pp (`11e`); and at 1440×900 the canvas owns the vertical column with the document/viewport ratio tracking `--graph-column-scale` and the query twin inside the layout row (`11c`), while a 1600px-tall viewport puts 2658px of canvas on screen, above the retired 900px clamp (`11c-tall`) | that the picture is BEAUTIFUL, or that a node is nameable at that zoom. Component count is a legibility FLOOR, not a ceiling. It makes no claim about the shape vocabulary — FR-244's sign-off left `tracePath` untouched. **Nor does it prove anything ABOVE `K_FLOOR`**: the size law makes no claim there, so the gate asserts nothing there either. The size law's ARITHMETIC at every `k` (the two regimes, the continuity at `K_FLOOR`, and the agreement of all four geometry consumers) is `graph/__tests__/shapes.test.ts`; the ban on a fifth open-coded site is `dashboard-graph-source.test.ts`; the `K_FLOOR` mirror is pinned by `dashboard-graph-source.test.ts` and mapped in `MAINTAINING.md`. Do not weaken any of the three on the assumption another has it covered |

| **G-BR-12** (FR-245) | the briefs BOARD on the `seeded` world, on its own tab: the rendered column set equals the union of `/api/summary`'s `briefs.by_status` keys with the six documented lifecycle statuses — computed in the gate from the DOC, not from the client's constant (`12a`); `Σ column.total` equals `/api/summary`'s `briefs.total`, each side fetched independently, so a column set can only pass by being COMPLETE (`12b`); a 66-character status is truncated in the header while `title` and `data-status` carry it whole and the label does not overflow its column, MEASURED as `scrollWidth ≤ clientWidth` (`12c`); the toggle survives a route change and a reload but a NEW browsing context opens on the list (`12d`); `priority=P1-High` reaches every column's query, checked column by column against the endpoint's own total for that `(status, priority)` pair at the same project scope (`12e`); `OPEN IN LIST` on a non-empty column flips to the list with THAT status filtered and the row count equal to the column's own total, against a fixture whose filtered and unfiltered counts disagree (`12g`); and across a full session — toggle, filter, hover, a REAL mouse drag across columns, refresh — the page issues **zero** non-GET requests with `GET > 0` in the same reading, no element carries a drag affordance, and no card moved (`12f`) | that the endpoint's answers are right (`dashboard-layers-endpoint.test.ts`), nor WHICH columns a given brain should have — it asserts the union, not the vocabulary. The FOLD case (`Done`/`Completed`/`Complete` as three columns) is **not** observable on this fixture, which holds no synonym pair; `dashboard/src/layers/__tests__/board.test.ts` B6 pins it offline against the real 15-value distribution |

**Every gate has a demonstrated failing counterpart, and the script enforces
it.** `--mutate=<name>` injects a specific defect and INVERTS the verdict: the
run succeeds only if the named gate actually fails, and a mutation run in which
everything still passes is reported as `VACUOUS` and exits non-zero.
`--list-mutations` prints the current set and is the only reliable count — a
guard whose only observed output is "pass" is indistinguishable from a broken
one. Confirmation dates by family: FR-240's eight on 2026-07-30, FR-241's four
(`br8-*`) with that brief, BR-082's two (`br9-*`) on 2026-07-31, TD-326's three
(`br10-*`) on 2026-07-31 — each confirmed caught by its predicted check
(`10a`, `10c`, `10d`), FR-244's three (`br11-*`) on 2026-08-02, and FR-245's
**eight** (`br12-*`) on 2026-08-02 — each confirmed caught by its predicted
check (`12a`, `12c`, `12d-nav`, `12d-session`, `12e`, `12g`, and `12f` twice).

**The BATCH-A batch (TD-332 · TD-337 · TD-320) added five**, all confirmed
2026-08-05 against their predicted checks: `br3-hermetic-one-world-unarmed`
(`3-hermetic`, naming the unarmed world), `br11-measure-above-the-clamp` (`11a`),
`br11-range-on-a-short-canvas` (`11-range`), `br11-anchor-not-reached`
(`11-anchor`), `br11-anchor-to-k-fit` (`11e`), plus `br7-crumb-forces-refetch`
— the product-faithful `7d` defect, which reddens `7b` too because the real
defect breaks both. **Two of them did not bite on their first design and both
failures are recorded in the mutation's own `how` string rather than quietly
fixed**, because "the mutation went red for a different reason" and "the mutation
did not go red at all" are findings about the check, not paperwork:
`br11-measure-above-the-clamp` read 98.9% at a 2× → 1× `K_FLOOR` pair (the
unprotected regime has not begun fusing there at this density) and was
re-derived at 2.5× → 1.25×; `br11-range-on-a-short-canvas` aborted the whole gate
on an off-screen FIT button as a 400×700 viewport, then stalled at
`k_fit = 0.131` when driven by `--graph-column-scale` alone, because
`.graph-layout` carries a 420px `min-height` the scale cannot reach past.

**TD-332's second pass added two more (`br0-*`), both confirmed 2026-08-06
against their predicted checks.** `br0-plant-known-red-orphan` plants a bogus
`KNOWN_RED` row **on the map itself** rather than inside the gate, so the run
shows the hole rather than a proxy for it: every other consumer of the ledger
reads the planted row and not one of them can say a word. It is the *planted
orphan* the brief asked for, made **re-runnable** — a hand-plant satisfies
"planted, shown red, removed" once and then leaves nothing behind, which is the
same reason this file prefers a mutation everywhere else.
`br0-duplicate-check-id` re-emits an id that already appeared in the run, and
its donor is **derived from `results`** (the last non-`threw`, non-known-red id
the ladder produced) rather than hard-coded: a hard-coded donor would emit a
*unique* id the day that check is renamed, and the harness would report
`VACUOUS` for what looks like a rename. Note the `gate` field of both entries
carries the CHECK id rather than a `G-BR-0…` id, because the verdict inversion
prefix-matches `MUTATIONS[m].gate` against `failed[].id`, and these two checks
are named for what they assert rather than numbered under their gate.

**Two of FR-245's eight exist because a check had no failing counterpart of its
own, which is a distinct gap from a check that is wrong.** `12d-session`
(a new browsing context opens on the list) stayed GREEN under
`br12-view-in-component-state`, which only reddens `12d-nav` — so the thing it
exists to detect, a regression to `localStorage`, was guarded only by a
string scan for `localStorage` in the hook, which an alias or a helper would
walk past. `br12-view-in-localstorage` closes it by persisting the toggle in
`localStorage` through a document-start bridge (the defect is in how the page
PERSISTS, so it cannot be injected after load), and the fresh tab then opens on
BOARD. `12g` closes the other one: `OPEN IN LIST` had a pure function with a
table test and an attribute in a render test, and nothing ever CLICKED it —
so D2's two-clicks reachability claim, which is the load-bearing half of how a
12-card cap handles 493 rows, was argued rather than measured.

**`G-BR-12f` needed two mutations AND a corrected reading window, and the second
half is the part worth copying.** Both 12f mutations were VACUOUS on their first
run — reported as such by the harness, which is the whole reason it inverts its
verdict. Neither defect was in the assertion: the injected `POST` fired *before*
the counter's baseline snapshot, so its count was already in the `before`
reading; and the injected `draggable` attribute was wiped by the `REFRESH` that
came after it, because a re-render unmounts and remounts the rows. The order is
now snapshot → refresh (the positive control's traffic) → inject → drag → read,
so every injected defect lands strictly INSIDE the measured interval. **An
instrument that is not watching when the defect happens reports the same zero as
a correct page** — which is the vacuity this file exists to catch, arriving from
a direction no amount of care about the assertion would have covered.

FR-244 also gave **`7d` its own mutation**, `br7-backout-re-entrances`, closing
a real gap: `br7-refetch-backout` breaks `7b` (the FETCH COUNT) and said nothing
about the pixel reading, so `7d` was the one check on this surface with no
demonstrated failing counterpart. The injected defect takes the back-out arm's
ink from the cold REFRESH transition — a real, measured re-entrance on the same
canvas in the same run, which is exactly the shape a back-out that lost its
position seed would have. It proves `7d`'s ABSOLUTE bound bites (the arm reads
its true cold value against the 0.75 floor); it does **not** prove the
separation bound non-trivially, since with both arms from one sample set the
separation is identically zero.

That mutation exists because of the ORDER FR-244 had to work in, which is worth
copying. `inkSpread` turned out to be silently coupled to the canvas aspect (it
accumulated moments in grid-cell *index* units, so cells were square only when
the canvas was), and FR-244 changed the canvas box. Repairing a metric in the
same breath as discovering it went red is indistinguishable from tuning it — so
the mutation was built and proven RED against the **old, uncorrected** metric at
the **old** layout first, and only then was the metric weighted by cell pixel
size. The mutation still bites afterwards. **A metric repair justified only by
the failure it removes is not a repair.**

FR-244's non-vacuity evidence is doubled, and the stronger half is the first:
**`G-BR-11` was written and run against the UNFIXED tree, and recorded RED**
(`11a` at 15.9% of the FIT component count, against its 60% floor). A gate with
a recorded pre-fix failure has demonstrated it can catch the defect, which no
mutation can do as directly. The mutations then cover the parts a pre-fix run
does not: measuring at the wrong zoom, controlling at the wrong zoom, and
asserting the full-column claim below the breakpoint where it does not hold.

One of those runs also **refuted a control**, which is worth recording because
the failure mode is the dangerous direction. `11b` was first written to assert
that an extreme zoom-out reads as ONE blob — reasoning that the layout's own
on-screen extent shrinks to a few pixels there whatever the size law does. The
first post-fix run measured 162 components in a 32px field: the control was
wrong, and it would have gone red for the RIGHT behaviour. It was replaced with
a control whose expected value comes from OUTSIDE the instrument — the seeded
edge count.

**Two things the gate is deliberately careful about**, both of which would
otherwise fake a pass:

1. **The measured tab must be FOREGROUND.** Chrome throttles `requestAnimationFrame`
   to zero in a background tab, so a rAF counter read on a backgrounded tab
   reports `+0` for a page animating flat out. Four tabs are open, so every
   navigation claims focus first, G-BR-4a prints the observed `visibilityState`,
   and G-BR-4b is the live proof that rAF can still fire in the tab measured.
   G-BR-9 depends on the same property for a different reason: `useLive` stops
   polling on `document.hidden`, so a "the scope was still cleared after two
   beats" reading taken on a backgrounded tab would be a reading of a frozen
   page. It therefore closes its window on OBSERVED `/api/health` and
   `/api/summary` request counts rather than on a sleep, asserts
   `visibilityState`, and fails with the counts it did see if the beats never
   arrive.
2. **A filter click waits for the list to STOP MOVING before measuring
   coordinates.** The filter vocabularies are derived from the loaded rows, so
   the strip re-flows when a new payload lands and a click dispatched at
   pre-re-flow coordinates hits the wrong chip. Observed exactly once while
   writing the file, as `priority=P3-Low -> 0 rows` for a filter that has one.

**What the gate found.** Clearing the project scope on `#/layers` did not stick:
`Layers.tsx` re-ran the `default_project` ladder whenever the scope was `null`,
and that effect fires on every `live.tick` — so the clear-by-reclick affordance
the file's own header documents was silently undone within five seconds
(measured 3 rows → 4 rows on the click, back to 3 rows at t+2 s, with the chip
re-checking itself). Invisible to the unit suite, which renders the view with a
`project` prop and never runs the beat. The fix distinguishes "never chosen"
(`undefined`) from "chose every project" (`null`).

**`vite build` does not typecheck.** esbuild strips types without checking
them, and `cli/dashboard/tsconfig.json` is isolated from `cli/tsconfig.json` (the
app must not enter `rootDir: ./src`), so the `tsc` in `npm run build` never sees
the app either. `npm run typecheck:dashboard` (`tsc --noEmit -p dashboard`) is
the only thing that does, which is why it is a CI step and not just a
convenience script.

#### `KNOWN_RED` — checks that ship failing, by decision (TD-332 / TD-337)

**Read every check BY NAME. Never read the overall verdict.** A check can ship
RED because an operator decided it should: the calibration is wrong, the
disposition is argued and owned by a brief, and hiding it would be worse than
carrying it. Before TD-332 that decision lived in a prose `note()` hundreds of
lines into a transcript, ending in a sentence nobody could execute — *"if this
goes green and you did not fix it, that is the surprising result."*

It is machinery now. `browser-gate.mjs` carries a `KNOWN_RED` map from check id
to owning brief, and the verdict block:

- **names** every known-red failure with its brief, so the summary reads
  `VERDICT: FAIL — 1 known-red (TD-332)` rather than showing an anonymous red
  line the next reader learns to scroll past;
- prints **`SURPRISE <id> is GREEN but is listed KNOWN_RED under <brief>`** when
  one comes back green, and **on an unmutated run exits non-zero for it** —
  because that is the alarming outcome, not the reassuring one. Either the brief
  landed and its row was not removed, or nobody fixed it and something moved the
  world back under it. **The exit is deliberately qualified under `--mutate`**,
  where an injected defect can legitimately move a check: measured,
  `--mutate=br7-refetch-backout` flips `7d` green and prints the SURPRISE line
  while exiting 0. An earlier draft of this paragraph promised the non-zero exit
  unconditionally, which the gate's own inline caveat already contradicted;
- prints an **`UNINFORMATIVE VERDICT`** line on any `--mutate` run whose
  predicted victim is known-red. Mutation mode inverts by asking whether the
  predicted id appears in `failed`; when that id fails *without* the mutation,
  the run prints `PASS (mutation caught)` for a reason unrelated to the injected
  defect. Judge such a run by its NUMBERS.

**A row must be deleted in the same commit that makes its check green.** That is
the forcing function: the SURPRISE line makes a half-done sweep loud, so the
disposition note beside the check cannot be left claiming a red that no longer
exists. TD-337's rows for `11a` and `11b` were removed exactly that way.

| Check | Owner | Why it is red |
|---|---|---|
| `7d` | **TD-332** | The back-out-versus-cold-entrance ink reading does not separate with margin on an **11-node** canvas. Conditions are fixed and documented; the metric is the residual. The `dense` world was evaluated as the replacement surface and **REJECTED** (`k_fit = 0.34271` — the settled reference saturates against the canvas); the residual is an **honest denominator** — a right-sized world OR an anchored camera, owned by **TD-366**, which must weigh both. See the baseline and the null result below. |

##### The orphan is the dual of the surprise, and `G-BR-0` is what sees it (TD-332)

The ledger keys on a check id **appearing in `results`**, and so does every
consumer of it — `knownRedFailures` reaches a row only through a FAILED id,
`knownRedSurprises` only through a PASSED one. So an **orphaned row** — the
check renamed or deleted, the ledger row left behind — produced **no failure, no
`SURPRISE`, and no output at all.**

That is the exact dual of the problem the ledger exists to solve. Its premise is
*"an unowned red check is indistinguishable from an accepted one"*; an orphan row
is *"a ledger entry for a check that no longer exists, silently"* — a decision
about the world that the world no longer contains, and nothing could say so.
It is also the failure the `KNOWN_RED` map's own preamble names one level up: a
warning that asks a human to notice an **absence** is not a warning, and an
orphan asks them to notice the absence of a check they had already stopped
seeing.

`G-BR-0` closes it with two checks:

- **`ledger-orphans`** — every `KNOWN_RED` key appeared in `results` **∪
  `skipped`**. The union matters: a `skip()` does not push to `results`, and
  exactly one of `3f-hybrid` / `3f-loud` is skipped on every run, so a check that
  exists and was loudly declined must not read as an orphan.
- **`ledger-ids`** — every check id in the run is unique. `KNOWN_RED` keys are
  gate-**unqualified**, so two checks sharing an id leave a row ambiguous about
  which one it owns, and the mutation-inversion prefix match parses the same
  unqualified ids. TD-332 chose to **detect** the collision rather than re-key
  the map: qualifying the keys touches every key and every mutation `gate` field,
  which is real blast radius for a defect that does not exist yet. Measured: the
  ladder emitted 109 rows / 109 distinct ids *before* this gate existed and
  110/110 with it, so the stricter property was already true of the whole corpus
  rather than newly imposed on it.

**It is numbered 0 and it runs LAST**, and both halves are load-bearing rather
than tidy: `notRun` is only fully populated once every `runGate` has been
reached, and `notRun` is what the gate self-fences on. **Under `--gates=` it
SKIPS both checks** with the filtered gates named, because a filtered run
legitimately never reaches most gates and every row they own would read as an
orphan — the guard would report a hole that is not there, on exactly the runs a
developer iterates with. It is exempt from `--gates=` for the same reason: a
guard that silently disappears under a flag is the failure class it exists to
close, and `skip()` is this file's only non-silent omission path.

#### `7d`'s baseline, its spread, and the rule that was applied (TD-332)

Conditions, which are the quantity this calibration is COUPLED to: viewport
**1440×900** set explicitly with `Emulation.setDeviceMetricsOverride` at gate
entry (not inherited from `--window-size`, inside which headless Chrome counts
its own browser chrome, leaving a ~1058×813 content box), canvas **1058×1258**,
`--graph-column-scale: 2`. Measured 2026-08-05.

| population | back-out collapse | cold collapse | separation |
|---|---|---|---|
| **healthy**, n=7 | 72.0–74.1% (spread **2.1pp**) | 56.2–59.5% (spread 3.3pp) | 13.8–17.9pp (spread **4.1pp**) |
| `br7-backout-re-entrances` | 56.2% | 56.2% | 0.0pp |
| `br7-crumb-forces-refetch` | 55.0% | 58.6% | −3.6pp, **and +1 `/api/graph`** |

**Two further healthy readings, 2026-08-06, recorded and NOT folded in:**
74.1 / 56.2 / 17.9pp and **74.4** / 59.5 / 14.9pp. The second sits **0.3pp above
the recorded back-out maximum** and its separation lands 0.1pp under the 15pp
floor — so the observed spread is if anything slightly wider than the table
says, both runs are still red, and neither is a sign that the world moved. They
are appended rather than folded because two ad-hoc runs cannot re-measure an
n=7 population, and folding them would make a documented spread a moving target
that accommodates whatever the last run said. **No threshold moved.**

Bounds are `BACKOUT_COLLAPSE_FLOOR = 0.75` and
`BACKOUT_COLD_SEPARATION_FLOOR = 0.15` — **named by TD-332, values UNCHANGED.**
A decision rule was written *before* the measurement so the measurement could not
be read to suit it, and it lands on **replace the surface**, not re-derive the
numbers:

- the **absolute** arm would re-derive cleanly — healthy min 72.0% against a
  defect max of 56.2% is a 15.8pp gap, 7.5× the 2.1pp healthy spread;
- the **separation** arm would not. Healthy min 13.8pp against a defect of 0.0pp
  is a 13.8pp gap, but the healthy spread is 4.1pp, so any floor between the two
  populations sits ~1.66 spreads from the healthy line. That is a marginal green,
  and the rule forbids shipping one;
- so the surface is what is wrong. `d3-force` initialises unplaced nodes on a
  phyllotaxis spiral of radius `10·√i`; for **eleven** nodes that opening clump is
  already fairly spread relative to the settled extent, which is why the cold arm
  reads ~57% rather than ~10% and why the separation is both small and noisy. At a
  larger node count the opening clump is proportionally far tighter, so the SIGNAL
  grows rather than the noise merely averaging out. **That mechanism is right, and
  it is why "a bigger world" is the obvious move — see the null result below for
  why the obvious move was measured and rejected.**

What TD-332 DID close, independently of any verdict: the gate now measures at the
viewport it documents, cleared in a `finally` so it cannot leak into `G-BR-9` or
`G-BR-13`, with the box printed at every stage. That alone tightened the cold arm
from ~63% to ~57% and moved the worst-case separation from 9.6pp to 13.8pp.

#### The `dense` world is NOT the replacement surface — a measured NULL RESULT (TD-332, 2026-08-06)

**Read this before relocating `7d`.** Both this document and `browser-gate.mjs`
used to prescribe exactly that relocation, and the prescription was wrong.

**The reason that decides it: the denominator saturates.** `inkSpread` samples
the **canvas only** — a 24×24 grid over the backing store, so ink outside the
canvas is not sampled and cannot be. And **every `7d` arm measures at camera
`k = 1`**: each arm is a fresh graph instance (`useGraph.ts` rebuilds on payload
identity — *"a new scope is a new instance"*), and `zoomToFit` is reachable only
through the FIT button, which `gBr7` never clicks and *cannot*, since the opening
frames it measures precede any possible click on the new instance. `k_fit` is
`zoomToFit()`'s scale, so **at `k = 1` the visible linear fraction of the layout
IS `k_fit`.**

Measured on the `dense` world, from `G-BR-11`'s own `11-instrument` line on an
unfiltered run:

| `--graph-column-scale` | `k_fit` | what the canvas shows at k=1 |
|---|---|---|
| 2 (shipped, and `gBr7`'s box) | **0.34271** | ~34% of the layout's width, ~12% of its area |
| 1 | **0.13275** | ~13% of its width |

- the cold arm's **numerator stays honest** — d3 puts unplaced node *i* at radius
  `10·√i`, so the opening RMS is `7.07·√N` ≈ **189 units** at N = 710, well
  inside the canvas;
- but **both arms' denominator saturates.** A settled field ~3× the canvas fills
  the grid, and `settledSpread` then reports the same number for *any* layout
  ≥ ~3× the canvas.

Separation would widen from ~14pp to roughly **50pp**, and every point of that
improvement would be **bought from clipping rather than from layout physics**.
This file refuses that twice already in writing — FR-250's *"an instrument that
stops measuring reports the reassuring answer"*, and `BACKOUT_COLLAPSE_FLOOR`'s
own refusal of a `7d` that reads its own instrument. Relocating a marginal
canvas-**coupled** metric onto a world where the canvas IS the denominator makes
the coupling total. The numbers improve; the subject degrades.

**The brief's own gate would have reached NO-GO for the wrong reason, and that is
the more instructive half.** It asked whether the `dense` world's `demo` scope
differs enough from whole-brain to make the drill non-degenerate. Derived from
the fixture: the delta is **3 of 710 nodes and 0 of 352 edges** — degenerate, as
the brief suspected. But that variable does not drive `7d` at all. The back-out
arm seeds from `cachedScope(null).positions` and the cold arm from the `{}` that
`putScope` writes on a forced refetch, so **both arms are the whole-brain node
set with only the position seed differing**, and neither touches the drilled
payload. The drill is a cache-*leaving* manoeuvre; the drilled scope's size is
incidental.

**The rule, derived from the mechanism and fixed before the reading** — recorded
so the next brief inherits the criterion instead of re-deriving it:

| `k_fit` on the candidate world | meaning | action |
|---|---|---|
| **≥ 0.9** | the layout essentially fits the canvas at k=1; the denominator is honest | a candidate — take N ≥ 7 readings per population before adopting it |
| **0.6 – 0.9** | up to ~1.7× the canvas, partially clipped | **operator call**, not an author's |
| **< 0.6** | ≥ 40% of the layout's width outside the canvas; the denominator IS the canvas | **NO-GO** |

`dense` reads 0.34271, deep in the third band, and the margin survives the box
difference between the two gates — `gBr7` sets 1058×1258 while `G-BR-11`'s
reading is taken at 1058×1084, and even a 50% more favourable canvas would only
reach ~0.51. **The measurement is free: `11-instrument` prints `k_fit` on every
unfiltered run.**

**The residual is an HONEST DENOMINATOR — and it is not necessarily a world at
all.** The denominator saturates because the layout overflows the canvas *at
k=1*, which has two sides:

- **change the population** — a seventh world whose settled layout still fits the
  canvas at k=1 (`k_fit ≈ 1`), a node count between 11 and 710 chosen **by
  measuring `k_fit`** rather than guessed; or
- **change the observer** — anchor both arms at a `k` where the layout fits, on
  the world we already have. `G-BR-11` drives absolute zooms with real wheel
  events and verifies achieved-vs-requested within 5%, so the machinery exists.

**TD-366** owns both and must weigh them before building either.

**The criterion that decides it, and it is the most transferable thing here:
whichever design is chosen MUST NOT PUT A CANVAS-DEPENDENT QUANTITY BACK INTO
THE READING.** That is precisely the defect TD-337 removed from `11a`/`11b`,
which had been anchored to `k_fit` — a quantity that moves with the canvas box —
and were re-anchored onto the absolute `K_FLOOR`. An anchored camera that
anchors to `k_fit` reintroduces it in a new place; a world *sized by* `k_fit`
does not, because there `k_fit` is a selection input rather than a term in the
reading. That asymmetry is the whole comparison, and it is not obvious which way
it falls.

Two hazards carry forward either way: `gBr7` allows 60 s to settle while
`G-BR-11` needs 90 s for the dense world, so a larger world needs its own timeout
re-derived; and `7a`'s readout must differ by more than a rounding accident (on
`dense` it would clear by exactly three nodes).

#### `G-BR-11`'s anchors are ABSOLUTE now, and `11e` is why you can believe it (TD-337)

`11a`'s floor used to be calibrated against `k_fit` — `zoomToFit()`'s scale,
i.e. the layout extent fitted into the **canvas box**. The box is a layout
property, so it moves, and FR-250 moved it as a controlled experiment nobody
designed as one: `--graph-column-scale: 1 → 2` took `k_fit` from 0.13275 to
0.34271 on a byte-identical bundle and an identical 710-node/352-edge payload.
`11a`'s sample point was `k_fit/2`, which crossed `K_FLOOR` on the way — out of
the protected regime whose property it was asserting — and read 50.4% against a
60% floor. **The gate did not break; its subject moved out from under it.**

**The obvious re-anchor is wrong, and it is worth saying out loud.**
`nodeWorldSize(px, k) = px / max(k, K_FLOOR)`, so a node's screen size is
`px · min(1, k/K_FLOOR)`. At `k = K_FLOOR` the clamp sits exactly on its own
boundary — `max(k, K_FLOOR)` is `k` either way — so **the pre-FR-244 defect
passes a reading taken at `K_FLOOR`.** A gate anchored there is a gate the bug
walks through. The property lives strictly *below*, which is why the sample is at
`K_FLOOR/2` and the **denominator** is the reading at `K_FLOOR` (the old
denominator, blobs-at-FIT, moved 358 → 710 across FR-250 and was a second,
easily-missed coupling).

`FROZEN_PRESERVATION_FLOOR = 0.95`, measured 2026-08-05:

| population | reading | mechanism |
|---|---|---|
| **healthy**, 5 runs × 2 column scales | 98.6–99.7% (spread **1.1pp**) | the picture freezes; the residual loss is pixel quantisation |
| `br11-measure-above-the-clamp`, 3 runs | **86.9%, 92.3%, 92.3%** | the same 2× zoom-out one octave higher (2.5× → 1.25× `K_FLOOR`), entirely in the regime where node size is pinned and gaps shrink — the pre-FR-244 behaviour. Noisier than the healthy population because its denominator sits high on the sweep, where the component count is still climbing steeply with `k` — which is precisely why the healthy pair is taken *below* the clamp, where it is not |
| `br11-measure-at-blob-zoom` | **81.1%** | numerator dragged to the extreme end, where the field is 86px and quantisation, not fusion, removes components |

The two populations meet at **92.3%** (worst defect) and **98.6%** (worst
healthy) — a 6.3pp corridor with its midpoint at 95.45%. The floor is the round
number just *below* that midpoint, which deliberately gives the larger share
(3.6pp, or 3.3× the healthy spread) to the healthy side and 2.7pp to the defect
side: the healthy spread is the one that causes flakes. **What it would mean if
it fired:** more than one component in twenty lost over a single octave *below*
the clamp — i.e. the picture is no longer freezing. Tighter (0.98) would put half
the healthy population within one spread of the line; looser (0.90) would let
92.3% of the above-the-clamp population pass, and that is the population that
matters.

**A first draft of `br11-measure-above-the-clamp` used a 2× → 1× pair and read
98.9% — it did not bite**, because at this density the unprotected regime has not
begun fusing by 2·`K_FLOOR`. It was re-derived at 2.5× → 1.25× rather than
accepted. A mutation that cannot bite is a decoration.

**What no mutation can reach, stated as a limit rather than left as a gap:**
restoring the pre-FR-244 *size law*. `useGraph.ts` exposes
`__igrisGraphStillness` as a read-only diagnostic on purpose, and the defect
state is not reachable by choosing a zoom either — under the fixed law the
node-size-to-field ratio is CONSTANT for every `k ≤ K_FLOOR`, so the old law's
picture at `K_FLOOR/2` is twice as dense as anything the fixed law can produce at
any zoom. That is not a hole in the harness; it is what the fix MEANS.
`graph/__tests__/shapes.test.ts` pins the arithmetic; this gate pins the picture.

**`11e` — the check that would have caught TD-337 before it shipped.** The
re-anchoring rests on an argument: *a reading at a fixed ABSOLUTE `k` does not
depend on the canvas box.* An argument is not a check. `11e` makes it one by
setting `--graph-column-scale` on `document.documentElement.style` **in the
page** — no source edit, no rebuild, dies with the tab — and re-running the whole
anchored pass. Measured: `k_fit` moves **2.58×** and the canvas goes 1058×1084 →
1058×423 while the anchored reading moves **0.28–0.56pp** (tolerance 2pp), and
the ink threshold derived at the anchor comes out **identical (119.17) on both
boxes**. `--mutate=br11-anchor-to-k-fit` puts both endpoints back on
`k_fit`-relative points and **reproduces TD-337 on demand** — one run printing
**50.4%** at scale 2 beside **98.6%** at scale 1.

The 50.4% is TD-337's recorded figure exactly. The scale-1 reading is **98.6%,
not FR-244's 98.3%** — one blob's difference, and an earlier draft of this
sentence claimed the pair were "exactly the two historical figures", which is
one component out and was a coincidence of a single run rather than a
reproducible property. The reproducible claim is the one worth making: the
mutation puts both endpoints back on `k_fit` and the two boxes disagree by
**48.18pp** against a 2pp tolerance, which is TD-337, on demand, from one run.

**FR-244's recorded 98.3% is annotated, not restated** (TD-337 AC-3). It was
taken at `k_fit = 0.13275`, so its sample point `k_fit/2 = 0.066` sat BELOW
`K_FLOOR = 0.11` — *inside* the protected regime. The figure was not wrong; it
was under-specified. It measured the fix working, in the regime the fix acts in,
at a `k_fit` nobody knew was transient.

**Two new checks come with absolute anchoring**, because it introduces two new
ways to measure nothing:

- **`11-range`** — `k_fit` must sit above every anchor, since each is reached by
  zooming OUT from FIT. Without it a short canvas silently reports the FIT
  picture at every level. Armed by `br11-range-on-a-short-canvas`, which shrinks
  the canvas in the page to `k_fit ≈ 0.059`; on that run `11-range` and
  `11-anchor` go red **and `11a` goes GREEN at 101.4%**, because both of its
  endpoints collapse onto the same unreachable reading. That is the argument for
  the check in one line: *an instrument that stopped measuring reports the
  reassuring answer.* Two earlier drafts of this mutation did not bite, and both
  are recorded in its `how` string — a 400×700 viewport aborted the gate on an
  off-screen FIT button before the check ran, and `--graph-column-scale` alone
  stopped at `k_fit = 0.131` because `.graph-layout` carries a 420px
  `min-height` the scale cannot reach past.
- **`11-anchor`** — the ACHIEVED `k` must be within 5% of the REQUESTED one
  (worst observed miss 1.56%). With a `k_fit`-relative divisor a miss was a
  proportional error in a ratio; with an absolute anchor a big enough miss puts
  the sample on the wrong side of the clamp. Armed by `br11-anchor-not-reached`
  (tick budget capped at 1), which inverts the FR-250 failure mode directly.

Every anchor in the standing sweep is at or below `K_FLOOR`, and that is a
measurement rather than a preference: `11e` re-runs the sweep at
`--graph-column-scale: 1`, where `k_fit` is only **1.21 · K_FLOOR**. An anchor at
`1.25 · K_FLOOR` was tried and is not reachable there.

#### `3-hermetic` covers every world, and the harness refuses to start otherwise (TD-320)

`3-hermetic` asserted the `vec` world's receipt alone while printing all six. The
preload body is world-invariant so the practical risk was low, but "low" is not
the property a hermetic claim needs — every measurement in this file is only
trustworthy if no server could have paid for an embedding with a ~90 MB network
fetch. It now asserts every world and **names the unarmed ones and their
reasons**, because a red that gives no diagnosis is half a check.

A **harness-level fail-fast** backs it up immediately after the banner, and that
is the half that matters for calibration work: a `--gates=7,11` run never reaches
`G-BR-3`, so the runs whose numbers become thresholds are exactly the runs the
ledger check cannot protect. Under `--mutate` it warns instead of exiting, so
`br3-hermetic-one-world-unarmed` — which points the `empty` world's preload at an
entry that does not exist — can still reach the check it exists to redden.

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
  arrives already settled with no entrance journey;
- **the zoom-out, judged by eye** (FR-244). Press FIT, then scroll out two or
  three notches. The field should shrink as one photograph — nodes and gaps
  together — rather than fusing into a slab. `G-BR-11` measures the component
  count for this, which is a legibility FLOOR and not a judgement: it can say
  "these are still separate things" and cannot say "this is readable". The
  judgement is yours. If it still reads as ugly or dense at fit, that is the
  at-rest fusion the size law provably cannot reach (see the size-law section
  above) and it wants its own brief — with the role-encoding cost of any shape
  change already priced.

And on `#/layers`, the two things the automated gate cannot judge:

- **the copy** in each of the four empty states. `browser-gate.mjs` proves the
  right STATE renders; whether "the brain did not answer." is the sentence an
  operator wants at that moment is a judgement call, and the four are
  deliberately different sentences with different next actions;
- **the retrieval banner on YOUR brain.** The gate reaches `bm25_only` and
  `hybrid` against fixtures. On a real machine the interesting case is the first
  search after a fresh install, where the ~90 MB MiniLM model is not cached: the
  request must still answer, and it must say so. If it silently returns plausible
  rows with no banner, that is the exact AC-#2 failure D3 exists to prevent.

---

### G-BR-15 — TD-347: every route reaches its data from cold (and only the routes that need them fetch their chunks)

Added by **TD-347** when three of the four route pages became `React.lazy`, and extended by FR-248 and FR-266 as the lazy set grew (`Overview` stays eager — it is the router's fallback for `#/` and every unknown hash). It runs
**FIRST** in `main()`, immediately after the tabs open — every later gate visits
`#/graph` and warms that chunk's immutable HTTP cache, so first position is the
only place `15d` and `15e` get a genuinely cold origin.

| Check | Asserts |
|---|---|
| `15-mirror` | **the harness's own route table agrees with the shell's.** `browser-gate.mjs#APP_ROUTES` is a HAND-WRITTEN mirror of `router.tsx#ROUTES`, and `parse` falls back to `overview` for an unknown segment rather than refusing — so a route added to the app and forgotten in the mirror predicts the WRONG route and every navigation to it hangs 45 s on `routeReady`, with nothing red. FR-248 shipped in exactly that state. This compares the prediction against the `data-route` the shell COMMITTED to, per route. |
| `15a` | all route addresses reach a **data-bearing** selector from a cold document — not `#main`, the data |
| `15b` | the same set through in-session navigation, which is the path that actually exercises Suspense |
| `15c` | zero `window.onerror` / `unhandledrejection` across every navigation — *"Failed to fetch dynamically imported module"* is the signature failure of a botched split and it does not fail a build |
| `15d` | **the deferral is real** — a cold `#/overview` fetches only the initial set; a cold `#/graph` fetches exactly `Graph`, `Button`, `neighbours`; a cold `#/search` exactly `Search`, `SearchReadout`; a cold `#/diagnostics` exactly `Diagnostics`, `Badge` — and none of them fetches `useQFilter`. Enumerated, not hand-waved. |
| `15e` | the cold cost is **recorded, not thresholded** — 20 readings with the cache disabled, min/median/max printed. A wall-clock threshold in this harness is a flake factory. |

**The route count is NOT written down here.** It moves per brief and the run
prints it (`N/N routes …` on `15-mirror`, `15a` and `15b`). A number in this
table beside a number the run derives is the drift this file has already carried
twice.

**FR-266's target is about DISTINCTION, not presence**, and that is unusual
enough to state. `#/diagnostics` asserts the fixture's own instance ids reached
the document (including `roadmap_drift`, an id no shipped file mentions), that at
least THREE distinct `data-tone` values are present, that `synapse` is `alarm`
while `cartographer` is `off` and `arbiter` is `attention`, and that the disabled
row carries its gate key verbatim. "Some rows appeared" would pass on a renderer
that painted every row one colour — which is precisely the panel's whole claim
falsified. Verified by mutation: a monochrome tone map reddens `15a` and `15b`
with `tones=["ok"]` against five distinct statuses.

Its mutations: `td347-read-before-ready` (skip the readiness wait),
`td347-chunk-404` (block a route's chunk), `td347-preload-the-lazy-chunk` (the
well-meaning "make navigation instant" change that silently re-charges the
initial load), `td347-warm-cold-reading` (take the cold reading on a warm
document). All four invert. `td347-chunk-404` is caught by the gate **throwing**
rather than by the predicted `15a` assertion — recorded as-is rather than tidied,
because the honest statement is *it is caught*, not *it is caught the way we
guessed*.

**THE SYNCHRONISATION CONTRACT, and why it is product-visible.** Before the
split, `Tab.hash()` and `Tab.goto()` waited for `#main` and then slept 400 ms.
After it, `#main` exists **while a Suspense fallback is mounted and the chunk is
still in flight**, so all fourteen existing gates would have been racing a fetch.
The fix is deterministic, not a longer sleep: `App.tsx` emits
`#main[data-route="<route>"]` and the fallback emits `[data-route-loading]`, and
`Tab.routeReady()` waits on both before the settle. **Renaming either attribute
silently returns all fifteen gates to sleep-based synchronisation** — which is
why it is a mapped contract in `MAINTAINING.md` rather than a private detail.

**`15a` WAS THE QUIET ONE, and it is the lesson worth keeping.** The first draft
took its "cold" loads with `Page.navigate` to a URL differing only in the
fragment — which is a *same-document* navigation: the document, its module
registry, its `performance` timeline and the gate's own recorder all survive. So
`15a` **passed**, while testing exactly the in-session path `15b` tests. It was
caught only because three sibling checks disagreed with it: `15d` reported a cold
`#/overview` fetching all six deferred chunks (residue from a document that never
went away), `15e` reported min == median == max to one decimal on all four routes
(one document, not five loads), and `15e`'s own armed-check reported
`transferSize === 0` on every pass. Going via `about:blank` forces a real
teardown. *A cold-load check that is silently a hash change is precisely the
vacuity this harness exists to prevent, and the check that passed was the broken
one.*

---

## Out of scope

Auth, remote hosting, per-user identity · a `/dashboard` skill (the verb is the
product) · any mutation that is not one of the EIGHT actions in the delegation
map — including editing a brief, storing a learning, or running an extractor.

*Layer views left this list when FR-240 shipped, and cognition triage plus the
write path left it when FR-241 did* — each time the same one-line edit to
`PENDING_ROUTES` in `router.tsx`. What did **not** leave with FR-241: writes
still reach the brain only through `gateway.dispatch`, so "all write actions" was
replaced by a bounded map — five rows at FR-241, seven since FR-247, EIGHT since FR-249 — rather than by an open door.

`NodeInspector` renders payload fields only and still issues **no second fetch**.
FR-240 arrived and the resolution was a LINK, not an endpoint: `OPEN RECORD`
navigates to `#/layers/<layer>/<project>/<id>` and the record view does its own
read. The distinction is the whole scope fence — a per-node detail fetch there
would turn a 2,400-node graph into 2,400 potential body reads hanging off a
hover, which is the superlinear term FR-237's "returns NO body content" rule
exists to remove.

---

### G-BR-17 — FR-248: a dead layer is REPORTED, in the browser, not merely absent

`/api/search` fuses five layers. The failure this gate exists to make impossible
is the one that is **invisible by construction**: a fused list quietly missing a
whole layer looks exactly like a fused list with fewer matches. Nothing about
the rendered page distinguishes "briefs had nothing to say" from "briefs was
never asked."

So the contract is not *report the error* — it is **`layers[]` always carries all
five entries**, which makes a silent drop unrepresentable rather than merely
untested, and the page must render every one of them.

**The 7th world, `nofts`.** `seedLayerBrain(db, { omit: ["briefs_fts"] })` — a
brain where the v23 lexical index was never created, so the briefs layer has
neither a lexical nor a vector arm. This is a **real production state** (a brain
that never ran the migration), not a mock, and it is seeded that way rather than
`DROP TABLE`d afterwards, which would strand v23's six triggers in a state no
production brain is ever in.

| check | asserts |
|---|---|
| `17-control` | in the SEEDED world the same query leaves briefs `available`, contributing, with no fault banner — the positive control, so the rest cannot pass vacuously on a build where the layer never worked |
| `17-wire` | the endpoint's own reading, out of process: `layers[]` names all five and briefs carries `available:false` with a non-empty `reason` |
| `17a` | the DOM strip matches the endpoint's layer list exactly — `MISSING FROM THE PAGE: []` |
| `17b` | the dead layer renders as `unavailable` with the server's `reason` **verbatim** |
| `17c` | it is LOUD — a `.shell-banner` names `BRIEFS` and says `INCOMPLETE` |
| `17d` | the list still serves: the live layers keep contributing rows |

**The query was chosen by measurement, not taste.** Eight candidates were probed
against both worlds; `q="read"` is the only one where the seeded world gives
briefs `contributed > 0` **and** another layer contributes, so `nofts` shows
briefs dark while the list keeps working. Same query, same corpus, one variable.

**`17c` cannot use a naive substring.** The retrieval banner on the `nofts` page
already contains the literal `briefs_fts`, so "a loud element mentions briefs"
would pass **under the silent-drop mutation**. The check matches `/\bBRIEFS\b/i`
— which does not match `briefs_fts`, because `_` is a word character — plus
`/INCOMPLETE/i`. Both mutations confirm it reports zero matches when the fault
banner is gone despite `briefs_fts` being on screen.

**Mutations**, each shown to redden this gate and to name it:

- `br17-silent-layer-drop` — the handler filters unavailable layers out of
  `layers[]`. Reds `17a`, `17b`, `17c`.
- `br17-layer-lies-available` — a dead layer reports `available: true` with a
  null reason. Reds `17b`, `17c`; `17a` correctly still passes, because the
  entry is present — it is lying, not missing.

Both are scoped to the `nofts` tab, so `17-control` and `17-wire` stay green
under them: a mutated run still demonstrates the page CAN render a live layer.

**The server-side twin (R5), run and reverted, not shipped:** replacing
`layers: reports` with `layers: reports.filter(l => l.available)` in `routes.ts`
reds 9 of 42 in `dashboard-search-fused.test.ts`, including *INVARIANT 1 —
layers[] has all five, in the FULL world*. Note `routes.ts` has **two**
`layers:` assembly points — the degraded early-return and the main path — and
invariant 1 needs both; mutating only the main one leaves the degraded-path
assertion green.

**The world count is now derived.** `WORLDS` is the single declaration and the
banner prints `Object.keys(WORLDS).length`. The file header states no number and
no list, because it had drifted twice — stale at FOUR, then reading "SIX" beside
a list of four.
