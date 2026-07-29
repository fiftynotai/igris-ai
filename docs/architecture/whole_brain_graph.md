# Whole-brain graph data layer (FR-237)

**Status:** shipped
**Owner brief:** FR-237 (FR-111 Phase 2)
**Consumers:** `igris_graph_brain` MCP tool; FR-238 dashboard server (imports the
pure builder directly); FR-239 graph view.
**Measured:** 2026-07-28, against `~/.igris/memory/knowledge.db`.

One read-only builder returns the **whole brain** — every project, every
knowledge layer — as a typed, composite-keyed graph. The same call with a
`project` argument returns that project's subgraph in the **identical shape**,
assembled by the **same code path** (no second query).

```
brain-mcp-server/src/engine/components/edges/
├── graph-keys.ts        # composite key encode/parse — imports NOTHING
├── whole-graph.ts       # buildBrainGraph(db, opts) — the ONE implementation
└── whole-graph-tool.ts  # handleGraphBrain(args) — the only file that calls getDb()
```

`whole-graph.ts` **must not import `db.js`.** It takes a `db` handle as a
parameter, copying the `visualization.ts` / `visualization-tool.ts` precedent,
so FR-238 can import `buildBrainGraph` with its own read-only connection and
zero singleton side-effects.

---

## 1. The composite node key

**The structured triple is the truth; the string is a derived join token.**

Every node carries `type`, `project` and `id` as real fields. `key` exists
because graph libraries (`vis-network`, `d3-force`) want a scalar node id.

```
key         = encodeSeg(type) + "|" + encodeSeg(project ?? "") + "|" + encodeSeg(id)
encodeSeg(s) = s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
```

| Example | Meaning |
|---|---|
| `brief\|igris-ai\|FR-237` | brief `FR-237` owned by `igris-ai` |
| `learning\|igris-ai\|1042` | learning row `id = 1042` |
| `goal\|\|GL-004` | a goal whose `project_slug` column is NULL |
| `concept\|igris-ai\|concept:vector-search` | a `graph_nodes` row |

**Three segments, not two.** The pre-existing two-part form `${type}|${id}`
(`visualization.ts`'s `GraphNode.id`; and `traversal.ts`'s visited set until
BR-078 retrofitted it) cannot express the project
axis. `brief_status` is UNIQUE on `(project, brief_id)`, so a brief id is
project-scoped: **`BR-001` exists in 25 projects** on the live brain and **1 273
of 1 698 brief rows (75 %) are collision-involved**. A two-part key fuses all 25
`BR-001`s into one node and invents edges between unrelated projects. Inserting
the project in the middle preserves the familiar `type|…|id` reading order.

**Escaped, not naive.** Project slugs are kebab and brief ids are `XX-NNN`, but
`graph_nodes.node_external_id` is free-form operator input. One `|` inside an id
would silently mis-parse into a wrong project under `split('|')`. The escape
costs six characters and makes `parseNodeKey` a **total function** — malformed
input never throws.

**Empty middle segment = global.** `projects.slug` is `UNIQUE NOT NULL` and
every slug in the store is non-empty, so a zero-length project segment can only
mean "no owner".

**Owner, not scope.** A `scope='global'` learning still has a real
`learnings.project` (its origin). We key it with that project and expose
`scope: 'global'` as a display attr — nulling it would collapse 265 learnings
into an unaddressable bucket. `project: null` is reserved for entities whose
**column** is null (`goals.project_slug`, a `graph_nodes` row without
`properties.project`). This is the honest reading of "global entities
represented correctly": *not dropped* (they are emitted), *not falsely
attributed* (we never invent an owner).

---

## 2. Node types

| type | table | project column | label | filter |
|---|---|---|---|---|
| `brief` | `brief_status` | `project` | `title` | — |
| `learning` | `learnings` | `project` | `title` | `review_status = 'approved'` |
| `goal` | `goals` | `project_slug` (**nullable**) | `title` | — |
| `error` | `errors` | `project` | `substr(message,1,120)` | — |
| `concept` / `decision` | `graph_nodes` | `json_extract(properties,'$.project')` (**nullable**) | `label` | `node_type IN ('concept','decision')` |
| `session` | `sessions` | `project` | `summary` | **adjacency-only** |

`id` is the row's stable external id: `brief_id`, `String(learnings.id)`,
`goal_id`, `String(errors.id)`, `node_external_id`, `String(sessions.id)`. The
`String(id)` form for integer-PK tables is the settled `numericId` convention
(`traversal.ts:415`, `MAINTAINING.md` row #104) — not a new one.

**`session` is adjacency-only:** it materialises as a node only when it is an
endpoint of a surviving edge. Sessions are unbounded and carry no
knowledge-graph value in bulk, but must never be *dropped* from an edge. Their
rows are still read (targeted by referenced id) so the project index stays
correct and a real session is never mis-classified as a phantom.

**`review_status='approved'` is inherited, not chosen.** It is the same gate
every recall / search / sync reader uses (`MAINTAINING.md` row #77, Decision A).
Diverging would resurrect `merged` / `superseded` / `pruned` learnings into the
operator's view, a regression across the whole FR-116 hygiene family. On the
live brain this is **663 of 893 learning rows**.

**`concept` / `decision` live population is 0.** The type is supported and
fixture-verified; `graph_nodes` genuinely holds no rows today. `by_node_type`
is seeded from the active type set so a supported-but-empty type shows an
explicit `0` rather than vanishing from the contract.

---

## 3. The ambiguous-edge resolution rule

**Rule name: *intra-project projection with declared multiplicity*.**

`entity_edges` has **no project column**, and its `metadata` carries only
`{"source":"backfill","label":"**Parent Brief:**"}` — the project context is
genuinely lost at row level. **374 of 543 edges (69 %) have at least one
ambiguous endpoint; 287 have both.**

With `P(x)` = the set of projects containing endpoint `x`:

| # | Condition | Emit | `resolution` |
|---|---|---|---|
| 1 | both endpoints non-ambiguous (`\|P\| ≤ 1`) | one edge, each endpoint's own project — **may legitimately be cross-project** | `unique` |
| 2 | exactly one ambiguous, and the fixed endpoint's non-null project ∈ the ambiguous set (**owner hint**) | one edge, adopt that project on both sides | `unique` |
| 3 | exactly one ambiguous, hint does **not** apply | **nothing** — see "Why branch 3 cannot replicate" | `ambiguous_unresolved` (counted) |
| 4 | both ambiguous, `C = P(from) ∩ P(to)`, `\|C\| = 1` | one intra-project edge | `unique` |
| 5 | both ambiguous, `1 < \|C\| ≤ max_edge_replicas` (default **8**) | one **intra-project** edge per project in `C`, `confidence /= \|C\|`, id `<edge_id>#<project>` | `replicated` |
| 6 | `\|C\| = 0` | nothing | `dangling` (counted) |
| 7 | `\|C\| > max_edge_replicas` | nothing | `over_replicated` (counted, ids listed) |

A **phantom** endpoint (no backing row anywhere) has `P = []` and is treated as
fixed to `null`, so an edge is never dropped for it. Candidate sets are sorted
ascending by slug (nulls first) so replica order is deterministic across runs.

### Which branches actually fire (measured, 2026-07-28)

Cross-tabbed by running every live `entity_edges` row through the exported
`resolveEdgeProjects` and bucketing by branch:

| Branch | Outcome | Live source rows |
|---|---|---|
| 1 — neither ambiguous | `unique` | 171 |
| 2 — owner hint | `unique` | 89 |
| **3 — one ambiguous, hint fails** | `ambiguous_unresolved` | **0** |
| 4 — both ambiguous, `\|C\| = 1` | `unique` | 6 |
| 5 — both ambiguous, `1 < \|C\| ≤ 8` | `replicated` | 244 |
| 7 — both ambiguous, `\|C\| > 8` | `over_replicated` | 37 |

Totals reconcile against the builder's own `edge_resolution` block on the same
run (`unique` 266, `replicated_sources` 244, `over_replicated` 37,
`source_edges` 547). **The brain drifts under measurement** — other instances
write to it concurrently, so `source_edges` read 544 / 546 / 547 across three
runs minutes apart. Treat the branch *distribution* as durable and the absolute
row counts as a snapshot.

**Branch 3 is currently unexercised on live data.** Every one of the 89 edges
with exactly one ambiguous endpoint resolves on the owner hint (branch 2), so
none falls through. It is reachable and unit-tested — a guard against a shape
the data does not happen to contain today. Treat its behaviour as **specified
and test-covered, not field-proven.**

(Do not derive branch-3's population by subtracting aggregates — `374 − 287 = 87`
gives the count of *one-ambiguous* edges, which is branch 2 + branch 3, not
branch 3 alone. An earlier revision of this doc made exactly that error.)

### Why branch 3 cannot replicate

Branch 3 is reached **only** when `fixedProject ∉ P(ambiguous endpoint)` — if it
were a member, branch 2 would have fired. So every instance branch 3 could emit
pairs `fixedProject` with a *different* project. **Every such replica would be a
cross-project bridge, and at most one of them could be real.** That is precisely
the error class this design calls catastrophic, so branch 3 emits nothing and is
counted instead.

The tempting justification — *"the fixed endpoint's real column already asserts
this span"* — is false. The fixed endpoint's column says which project **it**
lives in. It says nothing about which project the *ambiguous* endpoint's
instance lives in, which is the only thing in doubt. There is no honest
projection to make, so we make none.

`ambiguous_unresolved` is a **distinct bucket from `dangling`**: `dangling`
means "the two endpoints share no project", whereas here no shared project was
ever required — the fixed side simply offers no way to choose.

An earlier revision of this module **did** replicate here while claiming the
no-bridge guarantee anyway. The claim was false, and the disproof was sitting
unasserted in the test suite (a proj-c-only brief blocking a brief that lives in
proj-a and proj-b would emit two fabricated bridges). Both are now asserted; see
the `AMBIGUOUS_UNRESOLVED` and `GUARANTEE` cases in `whole-graph.test.ts`.

### This rule now has a SECOND implementer (BR-078)

`resolveEdgeProjects` is no longer the only code that decides which projects an
`entity_edges` row connects. BR-078 re-keyed `traversal.ts` on the same triple,
and `brain-mcp-server/src/engine/components/edges/node-project.ts` implements
the same rule in the strictly simpler form traversal needs: one endpoint is
always already fixed, so it evaluates the branch table above and then asks the
one extra question this builder never has to — *is the instance the rule
resolved onto the one we are standing on?* Its three outcomes are walk, skip
because the edge belongs to another instance of the same id, and skip because
the data cannot say (the only one counted as a loss, surfaced per-response as
`unresolved_hops`).

**It does not import `resolveEdgeProjects`, deliberately.** That function's
signature is edge-row-shaped, it requires a `ProjectIndex` built by loading every
node row in the brain (absurd for a depth-1 query), and it can return replica
instances traversal must never produce. The **anti-fork mechanism is a test, not
an import** — an import could not have caught a divergence anyway, since the
shapes differ:

- `graph-traversal.integration.test.ts` (BR-078 T7) asserts
  `igris_graph_neighbors` and `igris_graph_brain` agree on a fabricated
  collision fixture, and that neither invents a cross-project edge.
- `node-project.test.ts` asserts agreement at the RULE level, calling
  `resolveEdgeProjects` directly and checking the hop rule reaches the same
  verdict.

**Obligation:** any change to the branch table above, to the no-bridge
guarantee, or to `ambiguous_unresolved` / `dangling` semantics MUST re-check
both tests and `node-project.ts` in the same commit. See the BR-078 row in
`MAINTAINING.md`.

### Why replication rather than exclusion

1. **Replication cannot invent a cross-project bridge. Unconditionally, by
   construction.** Branch 4 is the *only* replicating branch and it replicates
   over an **intersection**, so every emitted instance has
   `fromProject === toProject`. The worst error a replica can commit is
   asserting a relationship inside a project where it does not hold — never a
   false bridge between two unrelated projects, which is the error class that is
   visually dominant and semantically catastrophic in a force layout. This
   guarantee holds with no qualification and no exceptions, and **FR-238 /
   FR-239 may design against it.** Branch 3 is excluded from replication
   *because* it is the one branch that could not satisfy it (see above); that
   exclusion is what makes the guarantee structural rather than incidental.
   Enforced by the `GUARANTEE` case in `whole-graph.test.ts`, which asserts
   `project(from) === project(to)` for every `replicated` edge, and verified on
   live data: **0 edges bridge two different projects while touching any
   `BR-001` node.**
2. **Exclusion is the larger and more biased loss.** Dropping the ambiguous
   mass removes ~66 % of brief→brief edges and ~52 % of all edges, and the loss
   is *not uniform* — it falls hardest on the oldest, most-collided projects, so
   exactly the history the operator built this to see would render nearly
   edgeless.
3. **Replication is auditable and reversible.** Every replica carries
   `source_edge_id`, so the follow-up `entity_edges` project-scoping migration
   can collapse them mechanically. A strict consumer recovers the exclusion
   policy for free with `edges.filter(e => e.resolution === 'unique')`. A
   dropped edge, by contrast, is invisible.
4. **The uncertainty is legible in the data.** `confidence /= |C|` is
   mass-preserving (replica confidences sum to the original), so a renderer dims
   uncertain edges with no special case and any aggregate that sums confidence
   is unchanged.
5. **The cap exists because the head is where replication stops being
   informative.** A 16-way replica is 15/16 wrong — noise, not signal.
   `max_edge_replicas = 8` drops those and **reports** them, so the operator
   sees the size of the unresolvable core instead of a fog of fabricated edges.
   It is exposed as a tool argument (1–32); `1` gives exclusion semantics.

### The runtime report (`edge_resolution`)

Emitted unconditionally on every response:

```jsonc
"edge_resolution": {
  "rule": "intra_project_projection",
  "max_edge_replicas": 8,
  "source_edges": 544,          // non-soft-deleted rows read
  "unique": 263,
  "replicated_sources": 245,    // ambiguous SOURCE rows that were replicated
  "replicas_emitted": 741,      // instances those produced
  "dangling": 0,               // no common project between the endpoints
  "ambiguous_unresolved": 0,   // one-ambiguous, hint failed -> withheld, never bridged
  "over_replicated": 36,
  "over_replicated_edge_ids": [ /* entity_edges.id, capped at 50 */ ],
  "candidate_count_histogram": { "1": 263, "2": 177, /* … */ "16": 2 },
  "by_endpoint_pair": { "brief->brief": 424, "learning->brief": 53, /* … */ }
}
```

Two invariants hold by construction and are asserted in the test suite:

- `unique + replicated_sources + dangling + ambiguous_unresolved + over_replicated === source_edges`
- `sum(candidate_count_histogram) === source_edges`

### Measured on the live brain (2026-07-28)

*One snapshot, taken in a single run. The branch cross-tab below was taken in a
later run and reads slightly higher — the brain is written concurrently by other
instances, so absolute counts move between runs. Neither table is stale; they
are different moments.*

| | |
|---|---|
| `source_edges` (non-soft-deleted) | **544** |
| `unique` | **263** |
| `replicated_sources` → `replicas_emitted` | **245 → 741** |
| `dangling` | **0** |
| `ambiguous_unresolved` | **0** |
| `over_replicated` (at cap 8) | **36** |
| resulting `edge_count` | **1 004** |
| `\|C\|` histogram tail | `9`:9 · `10`:8 · `11`:6 · `12`:1 · `13`:1 · `14`:9 · `16`:2 |

The tail is the retuning signal the cap was exposed for: the 36 dropped rows are
the unresolvable core. Lowering the cap to 8 was chosen ahead of measurement and
the realised numbers support keeping it — replicas (741) landed inside the
600–800 estimate and total edges (1 004) inside the 900–1 100 estimate.

### All ten catalog edge types

`stats.by_edge_type` is seeded from `VALID_EDGE_TYPES` **by reference**, so all
ten appear with an explicit `0`. `duplicates` and `recurs_with` have zero live
rows and must not vanish from the contract. `from`/`to` preserve
`entity_edges.from_*` / `to_*` **in that order, never normalised or coalesced** —
a bidirectional relationship is two rows and stays two edges.

---

## 4. Drill-down: build the whole graph, then filter

`project` is applied to the **assembled whole graph**, not to the SQL. This is
the literal reading of "same call, same shape, never a second query".

A node is kept when it is:

- **owned** — `node.project === project`; or
- **global** — `node.project === null` (kept unconditionally so a project-less
  goal is never dropped, but it does **not** pull in neighbours); or
- the far endpoint of a surviving edge whose near endpoint is **owned** ⇒ kept
  and flagged `boundary: true`.

Every edge with an unkept endpoint is then dropped. This is a **depth-1
edge-induced closure**: bounded (adds at most `|E|` nodes), keeps cross-project
structure visible at the rim, and needs no special case for globals. Boundary
nodes do not anchor, so the closure never expands to depth 2.

`degree` is recomputed from the **returned** edge array after every filter, so a
node's degree always reconciles with the edges in the same payload.

Measured drill-down (`project = "igris-ai"`): **964 nodes, 401 edges, 0 boundary
nodes, 390 KB**, with a top-level key set identical to the whole-brain response.

**A filtered call costs the same as an unfiltered one.** It must — filtering
happens *after* assembly, so a drill-down does all the whole-brain work and then
discards. See §5 for the measured warm medians; do not design against a
"drill-down is cheaper" assumption, because there is no such effect.

---

## 5. Scale

**Verdict: no pruning, no level-of-detail tiers, no paged expansion.** One
structural choice removes the only superlinear term, plus a ~20-line tripwire.

### The structural choice

The FR-111 ancestor embeds up to **8 KB of `brief_files.content` per node**
(`visualization.ts:39`). At whole-brain scale that alone is
1 700 × 8 KB ≈ **13 MB** — 17× the entire rest of the payload, and the only term
that grows with *content* rather than *count*.

**This layer returns no body content at all.** No `learnings.content`, no
`brief_files.content`, no `goals.description`. Labels and display attrs only.
Adding one re-introduces the superlinear term; the loaders carry a comment
saying so. A detail panel is a per-node fetch on an existing tool
(`igris_graph_node_get`, `igris_brief_get`) — FR-238's business, not this
layer's.

**Every remaining free-text term is bounded**, so "grows with count, not
content" is true of the whole payload and not just of the body columns:

| Term | Bound |
|---|---|
| every node `label` — `brief_status.title`, `learnings.title`, `goals.title`, `graph_nodes.label`, `sessions.summary` | 120 chars |
| `errors.message` | 120 chars, applied in SQL via `substr` |
| `graph_nodes.properties` carried in `attrs` | 2 048 chars serialised; over that, replaced by a marker keeping the key list and `project`, pointing at `igris_graph_node_get` |

The property bag matters most: it is free-form operator-supplied JSON with no
schema and no size limit, and it was the one uncapped term left after the body
columns were dropped. Measured on the live brain: raw `learnings.title` reaches
217 chars and `brief_status.title` 169, so the label cap is load-bearing today,
not hypothetical — emitted maximum is 120 with zero labels over, and the
largest serialised `attrs` is 279 chars.

### Measured

| | Whole brain | Drill-down (`igris-ai`) |
|---|---|---|
| nodes | 2 377 | 964 |
| edges | 1 004 | 401 |
| projects | 37 | — |
| payload | **0.93 MB** | 0.38 MB |
| build time — **warm median of 20** | **10.9 ms** | **11.1 ms** |
| build time — cold first call in a fresh process | ~140 ms | ~24 ms |

`by_node_type`: brief 1 707 · learning 663 · goal 5 · error 2 · concept 0 ·
decision 0 · session 0.

**Read the warm row, not the cold one, and do not read a whole-vs-filtered cost
difference into either.** Whole and filtered are within noise of each other
(10.9 ms vs 11.1 ms) because the project filter is applied *after* assembly — a
filtered call does all the whole-brain work and then discards. The cold column
is JIT and prepared-statement warmup, and it lands on **whichever call runs
first**, not on the whole-brain call:

```
--- whole then project ---      whole (call 1) = 141.7 ms   proj (call 2) =  13.5 ms
--- project then whole ---      proj  (call 1) =  34.4 ms   whole (call 2) =  23.1 ms
--- warm medians, n=20 ---      whole = 10.9 ms (9.3–13.9)  proj = 11.1 ms (9.7–16.4)
```

An earlier revision of this table published the two cold samples `127 ms` /
`12 ms` side by side, which read as "drill-down is ~10× cheaper". It is not, and
the architecture above says it cannot be. Absolute figures are machine- and
load-dependent (an independent run on another process measured warm medians of
31.2 ms / 31.3 ms and a ~245 ms cold first call — same shape, same equality,
different absolutes). **The durable claim is the equality, not the numbers.**

### The tripwire that ships

`max_nodes` default **15 000**, `max_edges` default **20 000** — deliberately
set **equal to** the pruning threshold below, not above it. Exceeded ⇒
deterministic truncation (nodes by `degree` desc then `key` asc; edges filtered
to survivors) plus `truncated: true` and a `truncation_reason`. Its purpose is
that **FR-238 can never receive a payload it cannot draw**, not that it will
ever activate — today's brain is ~16 % of the node cap.

An earlier revision set these to 20 000 / 30 000, i.e. ~33 % *above* the
threshold they exist to guard, so the tripwire would only have fired after the
payload had already become unrenderable. If the caps and the threshold are ever
retuned, move them together.

### The stated threshold at which pruning becomes required

> **~15 000 nodes or ~20 000 edges** (≈6× today) is the point at which the JSON
> payload crosses ~5 MB and browser force-layout stops holding an interactive
> frame rate. At that point — and not before — build **server-side
> degree/recency pruning first** (cheapest, keeps the whole-brain gestalt: drop
> degree-0 nodes older than N days), then **paged expansion from a seed set** if
> drill-down cost becomes the binding constraint. Level-of-detail tiers are
> last: they need a rendering contract to be tiered against, which does not
> exist until FR-238 ships.

The brain took its whole life to reach ~2 400 nodes. Reaching 15 000 is years
away at the current rate; because the tripwire now fires exactly at the
threshold, `truncated: true` is the signal that this estimate was wrong.
FR-238 should also watch `stats.node_count` for early warning rather than
waiting for truncation.

### One consequence, stated plainly

Drill-down builds the whole graph and then filters, so **a filtered call costs
the same as an unfiltered one** — measured at ~11 ms warm for both. At 2 400
nodes that is free, and paying whole-brain cost for a one-project view is the
right trade for having exactly one code path. **At the 15 000-node threshold
this is the first thing that must change** — push the project filter into the
SQL WHERE clauses, at which point filtered genuinely does become cheaper than
whole. This is a dated trade-off, not an oversight.

---

## 6. Degradation

Every table read is guarded by `tableExists`. A missing table contributes zero
rows and appends its name to `degraded.missing_tables[]`. `learnings.review_status`
is additionally probed with `columnExists` because it is a late ALTER (db.ts v15)
— an older brain drops the approved-only filter rather than throwing.

An edge endpoint with no backing row is synthesised as
`{ project: null, label: id, phantom: true }` and counted in
`degraded.phantom_nodes`. **The registry join is never assumed to succeed**
(measured 0 phantoms today).

A throw inside the MCP handler (e.g. `getDb()` cannot open the file) returns a
**success** result carrying an empty graph plus `degraded.reason`. An operator
dashboard must render an empty brain, not an error envelope.

---

## 7. Out of scope / follow-ups

| Item | Why it is not here |
|---|---|
| **`entity_edges` project-scoping migration** | The justification is the `edge_resolution` numbers above: 245 replicated sources + 36 over-replicated rows. A schema change to carry project on the edge row would collapse all of it. Worth its own brief now that the count is measured. |
| **`traversal.ts` shared-key retrofit** | **DONE — BR-078.** `igris_graph_neighbors` / `_path` / `_subgraph` had the identical exposure (a two-part visited-set key, plus a `LABEL_SCHEMA.brief` comment that admitted it picked the first project's title). BR-078 re-keyed every traversal site on the triple, importing `encodeNodeKey` from `graph-keys.ts` unmoved — exactly the reuse this module's dependency-free design was written for. It did change the **result set** of three shipped tools; see `docs/architecture/graph_traversal.md`. |
| **Retiring the single-project HTML renderer** | TD-308 owns `igris_brief_graph_render` / `/visualize`. |
| **New edge inference** | FR-211 (Archived). This layer reads `entity_edges`; it writes nothing and infers nothing. |
| **Rendering, layout, styling** | FR-238 (dashboard server) and FR-239 (graph view). |
| **CI coverage for `brain-mcp-server` vitest** | No GitHub workflow runs this suite — `test.yml` runs the two bats suites and `npm-publish.yml`'s vitest step is `working-directory: cli`. The FR-237 test surface is a **local gate**. Tracked separately. |

---

## Related

- `docs/architecture/graph_traversal.md` — FR-113 BFS traversal. **The
  resolution rule below now has a SECOND implementer.**
- `docs/architecture/typed_edges.md` — FR-105 `entity_edges` schema + vocabulary.
- `MAINTAINING.md` — the whole-brain graph payload contract row and row #104
  (`VALID_EDGE_TYPES` / `VALID_ENTITY_TYPES` lockstep).
