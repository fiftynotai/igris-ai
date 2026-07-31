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
| Write endpoints | **Exactly one, since FR-241: `POST /api/triage`.** Every mutation it performs is a `gateway.dispatch` of a tool named by a frozen five-row map — there is no code path in this tier that writes any other way. See *The write path* below. |
| Static serving | Path-traversal guarded (normalise, then resolved-prefix check — a LEXICAL check; see `static.ts` for why `realpath` is not needed while the bundle is a build artifact). Unknown extensions serve as `application/octet-stream`. |
| Response headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy: no-referrer` — on **every** response, from `dashboard/headers.ts`. The framing pair landed in FR-238 as defence in depth on a then-read-only surface with nothing to actuate and no cookies, in anticipation of a write endpoint. **FR-241 added that endpoint**, so the pair is now load-bearing rather than anticipatory: a framed dashboard with a working bulk-reject button is a real clickjacking target. |
| Caching | `Cache-Control: no-store` on all of `/api/*`; `no-cache` on `index.html`; long immutable max-age only on content-hashed `assets/`. |
| Auth | None — and none is planned. It is loopback-only, and the write endpoint is fenced by the four rows above rather than by a credential. What that does **not** defend against, stated rather than implied: a malicious browser extension, or another process running as the operator on this same machine. A loopback personal tool cannot, and this document does not pretend otherwise. |

---

## API surface

**Fifteen GET paths and one POST path.** All same-origin. Every response carries
a `degraded` field with the same shape. Every GET is a read; the single POST is
the write path FR-241 added, and it is the only endpoint on this surface that
changes a row.

| Method | Path | Response | Backed by |
|---|---|---|---|
| `GET` | `/api/health` | `{ok, cli_version, brain:{present,path}, bridge:{available,reason}, generated_at, degraded}` | `paths.ts#brainDbPath` + `brain-bridge.ts#probe` |
| `GET` | `/api/projects` | `{projects:[{slug,name,path,status,last_session_at}], default_project, generated_at, degraded}` | `registry.ts#listProjects` + `dashboard/default-project.ts` |
| `GET` | `/api/summary[?project=<slug>]` | `{project, briefs:{total,by_status,by_priority}, instances:{active}, generated_at, degraded}` | `brain-db.ts#briefStatusSummary` + `#listInstances` |
| `GET` | `/api/graph/stats?project=<slug>` | `{project, stats, edge_resolution, truncated, truncation_reason, generated_at, degraded}` | `brain-bridge.ts` → FR-237 `buildBrainGraph` |
| `GET` | `/api/graph?project=<slug>` | `{project, nodes, edges, stats, truncated, truncation_reason, query, generated_at, degraded}` | `brain-bridge.ts` → FR-237 `buildBrainGraph` + `dashboard/graph-query.ts` |
| `GET` | `/api/briefs` | `{items, count, total, limit, offset, params, generated_at, degraded}` | `brain-bridge.ts#loadLayerReaders` → `briefs-read.ts#listBriefs` |
| `GET` | `/api/brief?project=<slug>&id=<brief_id>` | `{brief, generated_at, degraded}` | `briefs-read.ts#getBrief` |
| `GET` | `/api/learnings` | `{items, count, total, limit, offset, review_status, params, generated_at, degraded}` | `memory-read.ts#listLearnings` |
| `GET` | `/api/learnings/search?q=<query>` | `{query, items, count, retrieval, params, generated_at, degraded}` | `memory-read.ts#hybridSearchLearnings` |
| `GET` | `/api/learning?id=<n>` | `{learning, generated_at, degraded}` | `memory-read.ts#getLearning` |
| `GET` | `/api/context-docs?project=<slug>` | `{project, archetype, tech_stack, inventory_degraded, docs, missing_applicable, remediation, generated_at, degraded}` | `verbs/context-docs.ts#buildContextDocsInventoryDigest` — **no brain read** |
| `GET` | `/api/context-doc?project=<slug>&type=<doc type>` | `{project, type, target, content, bytes, truncated, generated_at, degraded}` | `dashboard/context-docs-read.ts` — a guarded disk read |
| `GET` | `/api/goals` | `{items, count, total, limit, offset, params, generated_at, degraded}` | `goals/read.ts#listGoals` |
| `GET` | `/api/goal?id=<GL-XXX>` | `{goal, serving_briefs, serving_learnings_count, generated_at, degraded}` | `goals/read.ts#getGoal` |
| `GET` | `/api/suggestions?project=<slug>&status=&priority=&source_module=` | `{items, count, total, limit, offset, facets, params, generated_at, degraded}` | `suggestions-read.ts#listSuggestions` |
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
| `briefs.*` | every `brief_status` row | **yes** — `project` is `NOT NULL` with a declared FK to `projects(slug)`, and better-sqlite3 enables `foreign_keys` by default on **every** handle (measured), so deleting a project that still has briefs is BLOCKED rather than orphaning them. Measured against the real schema: `DELETE FROM projects WHERE slug='igris-ai'` (654 briefs) → `FOREIGN KEY constraint failed`. Note this makes `doctor --remove-orphans` throw on such a project — see the CLI-connection note in `brain-db.ts`. |
| `instances.active` | every active instance | **no** — `project_slug` is nullable with no FK, so a session belonging to no project is in this count and in no project's count |

`dashboard-server.test.ts` seeds exactly such a project-less session and asserts
the difference is 1, so the distinction is a gate rather than a paragraph. It is
TD-326's `everything` scope, **not** its `brain-level` one (`project IS NULL`),
which this endpoint does not offer. Nothing here counts `suggestions`, the table
where the two sets diverge by 377 rows.

### Layer views (FR-240) — the browse/detail surface

Nine endpoints across four layers: briefs, learnings, context docs, goals. They
are **read-only throughout**, and that is a structural property rather than a
promise — see "Two doors" below, which states which endpoint uses which handle.
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
properties rather than a filter: the slug is validated against `listProjects()`,
and the doc's filename is taken from the digest ROW — there is no code path that
joins a caller-supplied filename, so a traversal `type` is refused as an unknown
type. A `realpath` check backs both, because `~/.igris/projects/**` is a
directory the operator writes (unlike the static bundle, where a lexical check
suffices).

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

### Two doors, and read-only is a property of the connection

**Since FR-241 this tier is not read-only as a whole, and it is not read-write as
a whole either.** It has two doors plus one inherited residual, and which one an
endpoint uses is the only honest way to state the posture — an undisclosed
exception to a structural claim is how the claim stops meaning anything.

| Door | Endpoints | Connection |
|---|---|---|
| **Read** | the seven FR-240 layer endpoints (`/api/briefs`, `/api/brief`, `/api/learnings`, `/api/learnings/search`, `/api/learning`, `/api/goals`, `/api/goal`), FR-241's `/api/suggestions`, and both graph endpoints | `brain-bridge.ts#openBrainReadonly()` / `#openBrainReadonlyWithVec()` — `{readonly: true}` **and** `query_only = ON`, opened per request and closed after |
| **Write (FR-241)** | `POST /api/triage`, and nothing else | a **separately booted in-process brain engine** holding its own read-write connection, opened lazily and never by a browsing session |
| *Residual (FR-238-era)* | `/api/projects`, `/api/summary`, `/api/context-docs`, `/api/context-doc` | a plain `new Database(path)` with **no** `readonly` flag that sets `journal_mode = WAL` — disclosed below, deferred, not FR-241's to fix |
| *No brain handle at all* | `/api/health` and the static paths | an `existsSync` and a module-resolution probe; nothing is opened |

**Every GET on this surface changes no row.** The layer readers enforce that
structurally; the two inherited accessors do not; and the write door is a
different module returning a different connection, which is exactly why FR-240's
read-only pins stay green rather than being re-argued.

**The layer readers (FR-240) — structurally read-only:**

- Every handle behind `/api/briefs`, `/api/brief`, `/api/learnings`,
  `/api/learnings/search`, `/api/learning`, `/api/goals` and `/api/goal` comes
  from `brain-bridge.ts#openBrainReadonly()` or `#openBrainReadonlyWithVec()`,
  and **both** set `db.pragma('query_only = ON')` on **both** of
  `openBrainReadonly`'s branches — including the R4 fallback that re-opens
  read-**write** when a WAL brain has no `-shm`. An accidental write anywhere
  downstream throws `SQLITE_READONLY` instead of landing.
- The tier **never calls an MCP handler**. Every brain read handler runs
  `getDb()`, which opens the brain read-write and runs `migrateSchema`; and
  `handleMemoryGet` / `handleMemoryRecall` both
  `UPDATE learnings SET access_count = access_count + 1`. That bump is *correct*
  for a recall (TD-092 — it feeds the composite-ranking boost and the recall
  telemetry) and *wrong* for a page view, so it stays wrapper-side and the
  dashboard uses the non-bumping `memory-read.ts#getLearning`.

**The FR-238-era accessors — read-write handles, a residual:**

- `/api/projects` (and, since FR-240, **both** `/api/context-docs` and
  `/api/context-doc`, each via `context-docs-read.ts#readInventory`, which calls
  `isKnownProject`) reaches `registry.ts#listProjects`, and
  `/api/summary` reaches `brain-db.ts#briefStatusSummary` / `#listInstances`.
  Both modules open with `new Database(path)` — **no `readonly`** — and both run
  `pragma('journal_mode = WAL')` (`registry.ts:41-47`, `brain-db.ts:86-88`).
  `registry.ts` additionally runs `CREATE TABLE IF NOT EXISTS projects`.
- Concretely: on a brain in `journal_mode = delete` a GET **rewrites the `.db`
  header**, and on a brain with no `projects` table a GET **runs DDL**. Neither
  changes a row of brain content, and on an operator brain that is already `wal`
  and has a `projects` table the observable effect is nil — which is why FR-240
  did not touch it. It is nonetheless a write, and it is **deferred, not fixed**:
  the read-only `listProjects` path is its own brief.
- `/api/context-docs` opens no brain of its own, and its
  `existsSync(brainDbPath())` preflight is load-bearing rather than defensive:
  `registry.ts` **creates** the brain database when absent, so reaching
  `listProjects()` unguarded would materialise one on a machine that had none.

`cli/src/__tests__/dashboard-readonly.test.ts` crawls every endpoint twice
against a seeded snapshot and compares a full logical dump plus the file digest,
with a deliberate-writer negative control proving the comparison can actually
report a mutation. **What that crawl cannot see:** its fixture seeds
`journal_mode = WAL`, so the digest comparison can never exercise the flip
described above. **G-RO-5** in the same file closes that gap explicitly — it
converts the fixture to `delete` mode, asserts the layer endpoints leave it
alone, and pins the three accessor paths that flip it plus the `CREATE TABLE`.
Those pins fail if the residual is ever fixed, which is what will bring an editor
back to this section.

**What the write door adds to that residual, stated rather than folded in:**
booting the write engine ALSO puts the brain in WAL, because
`createSqliteAdapter` sets `journal_mode = WAL` on the connection it opens. That
is the same file-level flip the three FR-238-era accessors already cause and the
same territory TD-319 already owns — it is additional coverage of a disclosed
residual, not a new one. It is also why the write engine must stay **lazy**:
G-RO-5's fixture is a `journal_mode = delete` brain, and a write engine booted on
a browsing session would flip it.

### The write path (FR-241)

`POST /api/triage` is the only endpoint on this surface that changes a row, and
it is deliberately **one** endpoint with an `action` discriminator rather than
five verb endpoints. That shape is what makes the whole delegation rule a single
table a reviewer reads in one glance.

**The delegation rule:** *a dashboard mutation may only ever be added by adding a
row to the frozen `TRIAGE_ACTIONS` map in `cli/src/lib/brain-write-bridge.ts`,
and a mutation that does not resolve to a registered brain tool is forbidden.*

| `action` | brain tool | bulk | id key | allowed extras |
|---|---|---|---|---|
| `dismiss` | `igris_suggestion_dismiss` | yes | `id` | `reason` |
| `acted` | `igris_suggestion_acted` | yes | `id` | `brief_id` |
| `apply` | `igris_suggestion_apply_action` | **no** | `id` | — |
| `approve` | `igris_perception_approve` | yes | `learning_id` | — |
| `reject` | `igris_perception_reject` | yes | `learning_id` | `reason` |

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
no row created. Its single side effect is the `journal_mode` flip described
above.

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

The `source_module` filter vocabulary is enumerated **from data** — the
`/api/suggestions` payload carries a `facets.source_module` count map the reader
computes — because that vocabulary is open-ended (`gap`, `missing_followup`,
`janitor`, `edge_inference`, plus whatever the LLM names next) and a hand-list
would go stale silently.

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
       └─ routes.ts   the sixteen endpoints (15 GET + 1 POST) — CONTAINS ZERO SQL
            ├─ params.ts             pure clamp + filter allowlist + parseTriageBody
            ├─ registry.ts#listProjects
            ├─ brain-db.ts#briefStatusSummary / #listInstances
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
| `cli/src/__tests__/dashboard-server.test.ts` | bind, static, traversal, Host allowlist, CORS absence, security headers on every response class, the method guard, the four endpoints, four degraded brains, the zero-SQL scope assertion (extended to `brain-write-bridge.ts` by FR-241), and FR-241's write fences — `GET /api/triage` → 405, a POST to any other path → 405, a foreign `Origin` → 403 with the absent and exact-match cases as its controls, `text/plain` → 415, a 1 MB body → 413 |
| `cli/src/__tests__/dashboard-lock.test.ts` | lock write/read/atomicity, **0600 mode (including the stale-tmp rewrite path)**, liveness classification, pid reuse, stale reclaim, ownership-checked release |
| `cli/src/__tests__/brain-bridge.test.ts` | module resolution in a built tree, memoisation, read-only handle, every degradation path |
| `cli/src/__tests__/dashboard-artifact.test.ts` | bundle present, bundle current (stale guard), AC #4 no-network |
| `cli/src/__tests__/open-url.test.ts` | every rung of the ported open ladder |
| `cli/src/__tests__/tarball.test.ts` | `npm pack` manifest + packed-size ceiling — **+400 KB** over baseline, the single asserted number, and it did **not** move for FR-241. Measured last in each brief: **+331.8 KB** cumulative at the end of FR-240's warden pass (FR-240's own share +48.4 KB), and **+370.6 KB** cumulative at the end of FR-241's phase 7 (1_681_309 packed / 6_572_495 unpacked / 792 entries; FR-241's own share **+38.8 KB**, leaving ~29.4 KB of headroom). The budget is cumulative across the family, not per-brief. Also asserts the vendored read modules and their wrappers — and, since FR-241, `tools/suggestions-read.js` and `engine/index.js` — are actually in the tarball. |
| `cli/src/__tests__/dashboard-graph-endpoint.test.ts` | `/api/graph` payload shape field-for-field, project drill-down + `boundary` nodes, four degraded brains, inherited security posture |
| `cli/src/__tests__/dashboard-graph-query.test.ts` | the exemption-04 twin: whole-brain, scoped, truncated, degraded; the cap constants checked against the real engine |
| `cli/src/__tests__/dashboard-graph-source.test.ts` | zero colour literals in the graph source, the F2 camera scan, library-API confinement, zero rAF/`setInterval`, token-only timings |
| `cli/src/__tests__/dashboard-layers-endpoint.test.ts` | FR-240 — the nine layer endpoints: envelope shape, filters over DISAGREEING fixture partitions, pagination, the BR-078 `(project, id)` refusal, four degraded brains |
| `cli/src/__tests__/dashboard-learnings-search.test.ts` | FR-240 AC #2 — recall semantics (hybrid / `bm25_only` / `vector_only` / `none`), the `retrieval` block field by field, and the hermetic-by-construction guard that asserts **itself** armed |
| `cli/src/__tests__/dashboard-context-docs.test.ts` | FR-240 D8 — the inventory is forwarded not recomputed; traversal slug, traversal `type`, unregistered slug and a planted symlink are all refused; the lens does not CREATE the brain |
| `cli/src/__tests__/dashboard-readonly.test.ts` | FR-240 AC #7 — a full crawl of every endpoint against a snapshot, compared by logical dump **and** file digest, with a deliberate-writer negative control proving the comparison can report a mutation. FR-241 added **G-RO-6**: after the same request sequence `writeEngineState()` must still read `"not-booted"` and the digest must be unchanged, with a self-negative-control in the same test where one `POST /api/triage` flips it to `"booted"` and *does* change the digest. Stillness is not liveness |
| `cli/src/__tests__/dashboard-triage-endpoint.test.ts` | FR-241 — the sandbox fence first (the real brain's digest is unchanged at suite end, and a poison `IGRIS_DB_PATH` does not move the writes); each of the five actions end to end with its pre-state asserted; bulk-dismiss 12 of a seeded 17 with the surviving 5 named; partial failure and the `MAX_BULK` clamp; the degraded write surface **with its negative control**; delegation proven behaviourally as well as by scan; and gateway validation reported in the **gateway's own** message text |
| `cli/src/__tests__/dashboard-triage-parity.test.ts` | FR-241 — the twin-brain differ. Two brains in two **processes** (`setAdapter` is a module global, measured to cross-contaminate two engines in one process), identical fixtures, identical boot config: one dispatches through the engine directly, the other over HTTP. Diffs the `event_log` delta **and** the mutated domain tables, with the excluded-column list itself asserted so it cannot quietly grow to cover a real difference. Its empty case declares that it EXPECTED empty and cites why; its positive control is a recurring reject, then mutated to prove the differ can fail |
| `cli/dashboard/src/triage/__tests__/model.test.ts` + `components/triage/__tests__/BulkBar.test.tsx` | FR-241 — the tiering logic and the confirm copy, table-driven: a mixed selection of 3 recurring + 2 first-time rejects names **2** as permanently deleted, not 5 and not 0; the empty selection and the all-tier-3 case; the typed-count requirement |
| `cli/src/__tests__/dashboard-params.test.ts` | FR-240 — the pure clamp/allowlist: hostile `limit`/`offset`, unknown filters named rather than ignored |
| `cli/src/__tests__/dashboard-layers-source.test.ts` | FR-240 — whole-tree client scans: no string-to-markup path, the composite key not mirrored browser-side, zero colour literals **and zero custom properties** in the `.record-*` block, no absolute URL, no non-GET request. Every scan carries a self-negative-control |
| `cli/dashboard/src/graph/__tests__/` | the stillness instrument (**T6, the anti-fake layer**), the pause/resume state machine, tiers + the ladder, label occlusion, D9 shape/edge mappings, palette resolution, motion tokens, the volume bench, and (FR-240) `neighboursOf` extraction-equivalence |
| `cli/dashboard/src/{markdown,layers,components/record}/__tests__/` | FR-240 — the markdown parser incl. HTML-injection cases, the layer model (filters, the deep-link codec with the BR-078 duplicate-id case, the four empty states), and the record components rendered through `react-dom/server` |
| `brain-mcp-server/src/tools/__tests__/` + `engine/components/goals/__tests__/read.test.ts` | FR-240 — the three pure readers, `pure-read-purity.test.ts` (**with a fixture the scan MUST flag, so the scan has a self-negative-control**), and `wrapper-wire-parity.test.ts` golden strings proving the MCP wire output did not move |
| `cli/tests/integration/dashboard.bats` | lifecycle, double invocation, stale locks, `--port` hard-fail, degraded brain, pack-extract smoke, `/api/graph` on a seeded and a missing brain, **the nine layer endpoints on a seeded and a missing brain (T23)**, and an exact-set assertion over the `--smoke` probe list — which since FR-241 carries `/api/suggestions` **and** the entry `POST /api/triage`, whose probe sends a deliberately invalid action and expects a **400**, so `--smoke` proves the write pipeline is routed while mutating nothing |
| `cli/scripts/browser-gate.mjs` | FR-240 — the real-browser gates, extended by FR-241 with a triage world and a triage scenario (select rows, open the confirm, **cancel** and assert no request was issued, then confirm and assert the rows leave the list). The witness for "cancel issued no request" is an in-page `__gate.triagePost` counter, because a server log cannot tell a triage POST from any other request. Extended again by BR-082 with G-BR-9 (the Overview scope clear, held across two measured live beats) and two more in-page counters, `__gate.healthFetch` / `__gate.summaryFetch` — which witness LIVENESS rather than stillness, since a scope that "survived" a paused beat proves nothing. **Not** part of `npm test`; see below |

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
node cli/scripts/browser-gate.mjs  # 46 checks; exits non-zero on any FAIL
```

No new dependency: Node 24 has global `fetch` and `WebSocket`, so CDP is driven
directly. Chrome is located at the macOS default and overridable with
`CHROME_BIN`. It starts **four** dashboard servers over four `mkdtemp` sandboxes
(`IGRIS_BRAIN_DIR`, never the operator's brain) seeded from the same fixture the
vitest suites use — `seeded`, `vec` (a `learnings_vec` index, so the VECTOR arm
is available; whether recall actually runs hybrid additionally needs the
embedding model — see below), `empty` (schema, no rows) and `missing` (no
database). Three of the gates are about the **disagreement** between those
worlds; a single-world run cannot tell "the empty state renders" from "the empty
state always renders".

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
| **G-BR-1** | AC #3 both ways with real clicks: list row → detail, LOCATE IN GRAPH → the node selected on the canvas, OPEN RECORD → back to the same address. Plus `BR-001` in two projects resolving to two different records | anything about node types with no detail view — 1e asserts that STATE explicitly (`// NO DETAIL VIEW FOR ERROR`) rather than a blank panel |
| **G-BR-2** | the chips and both search boxes are WIRED: each rendered row count matches the endpoint's own `count` for the same filter, over fixture partitions that disagree | ranking, or that the SQL binds — `dashboard-layers-endpoint.test.ts` owns that |
| **G-BR-3** | all four `EmptyKind`s observed in pixels (`degraded` / `empty` / `filtered` / `no-project`); that the hermetic guard is ARMED; and that the reported `retrieval.mode` matches the reported capability, with the banner LOUD (`BM25 ONLY`) whenever an arm did not run and QUIET (`HYBRID RECALL`) when both did | that the copy is right — operator review. The `vec` world's vectors are deterministic, not real embeddings, so it proves the MODE plumbing and never recall quality. On a tree with no warm model cache the QUIET-hybrid DOM rendering is SKIPPED and **no sibling covers it** — the endpoint's field separation is proven offline by `dashboard-learnings-search.test.ts` and the recall semantics by `memory-read.test.ts`, but neither renders |
| **G-BR-4** | zero `requestAnimationFrame` callbacks and zero canvas clears across a 3-second rest on each of the four views, measured by instruments installed BEFORE the bundle and opened only once the surface has REACHED rest (a surface that never does fails with its observed rate, which is why the precondition cannot mask a loop); the four palettes resolving to four distinct `.record-*` colours; and the whole FR-239 stillness checkpoint re-run after the `graphCache` hoist, pointer liveness and node-click included | that DOM mutations are zero — they are not, by design (the 5-second `live.tick`), so the mutation count is MEASURED and printed rather than asserted |
| **G-BR-5** | ACCESS, not bytes: a brief's body, a learning's content and a context doc's text are READABLE in the live DOM, and two different records render two different bodies | markdown fidelity or XSS safety — `markdown/__tests__/` own both |
| **G-BR-6** | `prefers-reduced-motion` really collapses animation in the page, with the un-emulated reading as the paired control | that each animation is gated in JS — `motion.test.ts` T17 and `Cursor.tsx` own that |
| **G-BR-7** | the hoisted scope cache is real in the browser: a drill issues exactly one new `/api/graph`, backing out issues **zero** and restores the whole-brain readout, and a REFRESH on the same surface issues one — so the zero is a measured zero. Plus, in pixels, that the back-out OPENS at its settled layout extent while a cold REFRESH opens as a clump at the origin and expands out of it | that the restored coordinates equal the pre-drill ones. Nothing in the page exposes coordinates, and a settled-frame comparison cannot discriminate: d3-force's cold layout for a fixed node array is deterministic, so a restored layout and a cold one converge to the same picture. The seed is applied but NOT pinned (`instance.ts` sets `x`/`y`, not `fx`/`fy`), so a back-out is a short re-relaxation rather than a freeze-frame — measured at ~85% of settled extent versus ~61% cold. The cache MECHANICS are the sibling: `cli/dashboard/src/lib/__tests__/graphCache.test.ts` |
| **G-BR-8** (FR-241) | the triage write path end to end in a browser: the scoped queue agrees with the endpoint, the row badges distinguish a permanent reject from a recurring one, CANCEL issues **zero** POSTs (an independent in-page counter), a mixed selection's confirm dialog names the tier-3 subset rather than the selection size, a tier-3 bulk demands the count typed, and a world with the write surface down renders the affordances *disabled* rather than broken | that the brain applied the right mutation — `dashboard-triage-endpoint.test.ts` and `dashboard-triage-parity.test.ts` own that. The gate reads rows leaving a list, not rows changing in a table |
| **G-BR-9** (BR-082) | the Overview opens scoped to `default_project`, re-clicking the checked chip **clears** the scope, every card widens to the value its UNSCOPED endpoint reports, and that widened state is still on screen after the page has issued ≥2 further `/api/health` polls **and** ≥2 further `/api/summary` reads across ≥10 s — so the clear survived the beat that used to undo it | that the hook's `undefined`-vs-`null` distinction is the MECHANISM. This reads a page, not a state machine, and would pass for any implementation that keeps the clear. The mechanism's siblings are `dashboard-layers-source.test.ts` (exactly one scope implementation, and Overview consumes it) and `useProjectScope.ts`'s docblock. Nor that the NUMBERS are right — it asserts DOM-vs-endpoint agreement, and `dashboard-server.test.ts` owns what the endpoint should say |

**Every gate has a demonstrated failing counterpart, and the script enforces
it.** `--mutate=<name>` injects a specific defect and INVERTS the verdict: the
run succeeds only if the named gate actually fails, and a mutation run in which
everything still passes is reported as `VACUOUS` and exits non-zero.
`--list-mutations` prints the current set and is the only reliable count — a
guard whose only observed output is "pass" is indistinguishable from a broken
one. Confirmation dates by family: FR-240's eight on 2026-07-30, FR-241's four
(`br8-*`) with that brief, BR-082's two (`br9-*`) on 2026-07-31.

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

## Out of scope

Auth, remote hosting, per-user identity · a `/dashboard` skill (the verb is the
product) · any mutation that is not one of the five actions in the delegation
map — including editing a brief, storing a learning, or running an extractor.

*Layer views left this list when FR-240 shipped, and cognition triage plus the
write path left it when FR-241 did* — each time the same one-line edit to
`PENDING_ROUTES` in `router.tsx`. What did **not** leave with FR-241: writes
still reach the brain only through `gateway.dispatch`, so "all write actions" was
replaced by a bounded five-row map rather than by an open door.

`NodeInspector` renders payload fields only and still issues **no second fetch**.
FR-240 arrived and the resolution was a LINK, not an endpoint: `OPEN RECORD`
navigates to `#/layers/<layer>/<project>/<id>` and the record view does its own
read. The distinction is the whole scope fence — a per-node detail fetch there
would turn a 2,400-node graph into 2,400 potential body reads hanging off a
hover, which is the superlinear term FR-237's "returns NO body content" rule
exists to remove.
