# Graph Traversal — FR-113

Three read-only MCP tools layered on top of the FR-105 `entity_edges` table to enable structured navigation of the Igris knowledge graph: `igris_graph_neighbors`, `igris_graph_path`, and `igris_graph_subgraph`.

These tools live in the `edges` brain component (version `1.5.0`) and reuse the entity-type and edge-type catalogs from FR-105.

> **BR-078 — the result set changed.** Nodes are now addressed by the triple
> `(type, project, id)`, not `(type, id)`. A traversal seeded on a brief id that
> exists in several projects used to return all of their neighbours fused into
> one answer; it now returns one project's, or refuses to guess. This is a
> deliberate, announced change to three shipped tools — see
> [Project axis & hop resolution](#project-axis--hop-resolution).

---

## Tool Reference

### `igris_graph_neighbors`

BFS within N hops of a seed node. Direction-aware. Returns nodes only (no edges) — call `igris_edge_list` if you need the edges.

| Param | Type | Default | Cap | Notes |
|-------|------|---------|-----|-------|
| `node_type` | enum (entity types) | required | — | Seed entity type |
| `node_id` | string | required | — | Seed entity id |
| `node_project` | string | inferred | — | **Qualifies the seed only — it does NOT filter the result to that project.** Omit when `node_id` is unique brain-wide; required in practice only for an ambiguous id (see below) |
| `depth` | int | 1 | [1, 10] | Maximum hops |
| `direction` | `in` \| `out` \| `both` | `both` | — | Edge traversal direction |
| `edge_types` | array of enum | none | — | Optional edge_type filter (subset of FR-105 catalog) |
| `max_nodes` | int | 100 | [1, 100] | Hard result cap |
| `include_deleted` | bool | false | — | Include soft-deleted edges |

**Response:**
```json
{
  "seed": { "type": "brief", "id": "FR-113", "project": "igris-ai" },
  "depth": 2,
  "direction": "both",
  "neighbors": [
    { "type": "brief", "id": "FR-105", "project": "igris-ai", "label": "Typed Edges", "depth": 1 },
    { "type": "goal",  "id": "G-001",  "project": null,       "label": "Knowledge graph", "depth": 2 }
  ],
  "count": 2,
  "truncated": false,
  "unresolved_hops": 0
}
```

### `igris_graph_path`

Shortest **directed** path from one entity to another via outgoing edges. Cycle-safe via BFS visited-set.

| Param | Type | Default | Cap | Notes |
|-------|------|---------|-----|-------|
| `from_type` | enum | required | — | Source type |
| `from_id` | string | required | — | Source id |
| `from_project` | string | inferred | — | Qualifies the SOURCE seed only; does not filter |
| `to_type` | enum | required | — | Target type |
| `to_id` | string | required | — | Target id |
| `to_project` | string | inferred | — | Qualifies the TARGET seed only; does not filter. The target goes through the identical ladder, which is what makes "no path between two projects' same-id briefs" true |
| `max_depth` | int | 5 | [1, 10] | BFS depth cap |
| `edge_types` | array of enum | none | — | Optional edge_type filter |
| `include_deleted` | bool | false | — | Include soft-deleted edges |

**Per FR-113 user-approved decision:** v1 is directed-only (follows `from→to` only). No `direction` param. If undirected paths are needed later, add a follow-up brief.

**Response (path found):**
```json
{
  "from": { "type": "brief", "id": "FR-113", "project": "igris-ai" },
  "to":   { "type": "goal",  "id": "G-001",  "project": null },
  "found": true,
  "length": 2,
  "path": [
    { "type": "brief", "id": "FR-113", "project": "igris-ai", "label": "Graph Traversal" },
    { "type": "brief", "id": "FR-105", "project": "igris-ai", "label": "Typed Edges", "edge_id": 12, "edge_type": "depends_on" },
    { "type": "goal",  "id": "G-001",  "project": null,       "label": "Knowledge graph", "edge_id": 17, "edge_type": "serves_goal" }
  ],
  "unresolved_hops": 0
}
```

**Response (no path):**
```json
{
  "from": { "type": "brief", "id": "BR-001", "project": "proj-a" },
  "to":   { "type": "brief", "id": "BR-001", "project": "proj-b" },
  "found": false,
  "length": null,
  "path": [],
  "unresolved_hops": 0
}
```

### `igris_graph_subgraph`

Connected subgraph (nodes + edges) reachable from a seed, bounded by `max_nodes`. Both directions traversed. Useful for visualization.

| Param | Type | Default | Cap | Notes |
|-------|------|---------|-----|-------|
| `seed_node_type` | enum | required | — | Seed type |
| `seed_node_id` | string | required | — | Seed id |
| `seed_node_project` | string | inferred | — | Qualifies the seed only; does not filter. **Carried in the cache key** |
| `max_nodes` | int | 20 | [1, 100] | Total node cap |
| `edge_types` | array of enum | none | — | Optional edge_type filter |
| `include_deleted` | bool | false | — | Include soft-deleted edges |

**Response:**
```json
{
  "seed": { "type": "brief", "id": "FR-113", "project": "igris-ai" },
  "nodes": [
    { "type": "brief", "id": "FR-113", "project": "igris-ai", "label": "Graph Traversal", "is_seed": true },
    { "type": "brief", "id": "FR-105", "project": "igris-ai", "label": "Typed Edges", "is_seed": false }
  ],
  "edges": [
    {
      "id": 12, "from_type": "brief", "from_id": "FR-113",
      "to_type": "brief", "to_id": "FR-105",
      "edge_type": "depends_on", "confidence": 1.0,
      "provenance": "observed", "metadata": "{}"
    }
  ],
  "truncated": false,
  "cached": false,
  "unresolved_hops": 0
}
```

---

## Project axis & hop resolution

**BR-078.** `entity_edges` addresses endpoints as `(type, id)`. `brief_id` is
UNIQUE only per `(project, brief_id)`, so that address does not identify a
brief. Measured on the live brain: **1,726 `brief_status` rows, 343 colliding
ids, 1,297 rows (75 %) implicated**, with `BR-001` alone in **25 projects** and
16 edges touching it. Every pre-BR-078 traversal seeded on such an id returned
all 25 projects' neighbours as though they belonged to one brief.

### Seed qualification — resolved when unique, hard error when ambiguous

`node_project` / `from_project` + `to_project` / `seed_node_project` are
**optional**, and they **qualify the seed only — they never filter the result**.
A traversal seeded in project A legitimately reaches project B through a
cross-project edge, and that reach is preserved.

With `P(seed)` = the projects the seed id lives in:

| `\|P\|` | Behaviour |
|---|---|
| 0 | Phantom seed (an edge endpoint with no backing row anywhere — the TD-310 orphan population). Proceed with `project: null`. Pre-BR-078 behaviour, preserved. |
| 1 | Adopt it. The caller does not need to know anything. |
| >1 | **Error**, naming the id, the count and the candidate slugs (capped at 10 + "and N more"), instructing the caller to pass the project param. |
| supplied | Validated against `P(seed)`. A project the id does not live in is an **error**, not a silently empty result. When `\|P\| = 0` the claim is unverifiable rather than false, so it is accepted — refusing would make a degraded brain unusable. **Second deliberate divergence from `igris_graph_brain`:** an accepted slug becomes the seed's project, so the first hop can take the branch-2 owner-hint path, where `resolveEdgeProjects` — computing `fixedProject = null` for a phantom endpoint — would take branch 3 and emit nothing. We keep the caller's assertion because on a degraded or orphan-heavy brain it is the only project signal available, and it cannot fabricate a bridge between two *real* projects (the near side has no backing row in any project). |

The tools therefore **never fuse**: they resolve uniquely or they refuse. This
is "required, computed rather than declared" — it costs the caller nothing where
the id is already unique, and it is coherent for the phantom case, which a
strictly-required param is not.

Ambiguity is detected **empirically per endpoint, for every type** — no
hard-coded type list. Today only `brief` can exceed 1 (`brief_status` is
`UNIQUE(project, brief_id)`); `learnings.id` / `errors.id` / `sessions.id` are
integer PKs, `goals.goal_id` is UNIQUE and `graph_nodes` is
`UNIQUE(node_type, node_external_id)`. A future colliding type is handled with
no code change.

### Hop resolution

Even with a correct seed, walking an edge to `brief/BR-002` must decide *which*
project's BR-002.

**Since BR-083 the row usually says.** `entity_edges` gained `from_project` /
`to_project`, and when BOTH are stored `resolveHopProject` reads them and asks
only whether the near one is the instance the walk is standing on — no
inference at all. The condition is BOTH-stored, identical to
`resolveEdgeProjects`'s, because these two functions agreeing is the anti-fork
invariant.

The ladder below is now the rule for the **NULL residual**: rows written before
`edges:4` that BR-083's backfill could not PROVE (327 of 785 on the operator's
brain, 41.7%, deliberately left NULL — a wrong attribution is worse than a
null), plus endpoints that legitimately have no project at all.
`node-project.ts::resolveHopProject` reaches the same verdict
`whole-graph.ts::resolveEdgeProjects` (FR-237) reaches for those rows, and then
asks whether the verdict names the instance the walk is standing on. With
`A = P(near)`, `C = P(far)` and `Pc` the near node's fixed project:

| Case | FR-237 verdict | Traversal |
|---|---|---|
| **both qualifiers STORED** (BR-083) | branch 0 — one instance, exactly as stored | **walk** as the stored far project when `Pc` equals the stored near one; otherwise it is a *different instance* and is skipped **without** being counted |
| `\|A\| <= 1`, `\|C\| <= 1` | branch 1 — one instance, each endpoint keeps its own project | **walk**, far project = `C[0]` (or `null`). Cross-project edges are legitimate and are not forced intra-project |
| `\|A\| <= 1`, `\|C\| > 1`, `Pc ∈ C` | branch 2 — owner hint | **walk** as `Pc` |
| `\|A\| <= 1`, `\|C\| > 1`, `Pc ∉ C` | branch 3 — emit nothing | **drop**, count in `unresolved_hops` |
| `\|A\| > 1`, `\|C\| <= 1`, `C[0] ∈ A` | branch 2 — the far side's real column decides the edge's owner | **walk** if `Pc == C[0]`; otherwise the edge belongs to a *different instance of the same id* and is skipped **without** being counted |
| `\|A\| > 1`, `\|C\| <= 1`, otherwise | branch 3 | **drop**, counted |
| `\|A\| > 1`, `\|C\| > 1`, `0 < \|A ∩ C\| <= max_edge_replicas` | branch 4 — intersect, one intra-project instance per candidate | **walk** as `Pc` when `Pc ∈ A ∩ C`; skipped-not-counted when the intersection excludes it; **dropped** and counted when the intersection is empty |
| `\|A\| > 1`, `\|C\| > 1`, `\|A ∩ C\| > max_edge_replicas` (default 8) | branch 4 — `over_replicated`: the edge is dropped for **every** project | **walk** as `Pc` when `Pc ∈ A ∩ C` — **this DIVERGES from `igris_graph_brain`, deliberately.** See below |

The near endpoint's own ambiguity is load-bearing. Take the live shape: `BR-001`
in `proj-a` and `proj-b`, `BR-009` in `proj-b` only, one row saying
`BR-001 -> BR-009`. FR-237 resolves that row to `proj-b` on **both** sides, so
standing on **A's** BR-001 it is not our edge and BR-009 must not appear. A rule
that looked only at `|C| = 1` and adopted `C[0]` would have walked it and
returned B's brief as A's neighbour — a fabricated cross-project bridge, and a
silent fork from `igris_graph_brain`.

**Traversal never replicates.** FR-237's branch 4 is the only replicating branch;
here at most one candidate is ever walked, so the visited set cannot explode. A
`(type, id)` still appears twice in one result if and only if two project
contexts were genuinely *reached* — bounded fan-out over realised paths, not
replication over candidate projects. Those two nodes are genuinely different
entities and each carries its own `project`.

### Sound, not complete — and the loss is reported

Branch 3 drops edges that describe a real relationship, because the row does not
say which project it meant. **That information was never in the row.** The
pre-BR-078 code hid the loss by returning all candidates as though fused;
BR-078 converts a silent wrong answer into a smaller right answer plus a visible
counter. Every response therefore carries:

```json
"unresolved_hops": 0
```

Counted per **hop attempt**, so one edge examined from both ends can contribute
twice. A hop skipped because it demonstrably belongs to another instance is
**not** counted — that is correct behaviour, not a residual, and counting it
would overstate the loss.

`igris_graph_brain`'s `edge_resolution` block measures the same loss
brain-wide across `ambiguous_unresolved` + `dangling`. Its **third** loss
bucket, `over_replicated`, has **no traversal counterpart** — traversal
deliberately does not model the replica cap (see the next subsection), so an
edge whole-graph drops as over-replicated is still walked here. **The only complete remedy is a
project column on `entity_edges`** — a schema change, deliberately out of scope.

**Measured (read-only, live brain, 2026-07-29):** scanning every colliding
brief id that has an edge, seeded from every project it lives in — depth 2,
`direction: both` — yields **0 seed-resolution errors, 0 cross-project brief
leaks across 9,676 neighbour rows, and `unresolved_hops = 0` in every
traversal.** The seed count (862 on that date) drifts as briefs are added and is
not the load-bearing figure; the three zeros are. The dropping branch is real
and unit-tested, but current data always supplies an owner hint. A residual that
is zero *today* is not a residual that is zero.

### What changed on real data — measured, not assumed

BR-078 changes the answers of three shipped tools. The honest scope, measured by
running the **pre-BR-078 implementation and the shipped one in one process over
the same live brain** (81 global-id seeds that have at least one edge —
76 `learning` + 5 `goal` — at depths 1 and 2, `direction: both`; 162 traversals):

| Outcome | Count |
|---|---|
| New hard-error regressions (a seed that used to answer and now refuses) | **0** |
| Identical, modulo the additive `project` / `unresolved_hops` fields | **134** |
| Node set differs | **6** |
| Same node set, a **label** differs | **22** |
| **Substantively different** | **28 of 162** |

Read it precisely, because the intuitive summary is wrong:

- **Global-id *seeds* are unchanged.** At depth 1 the node sets are identical in
  **81 of 81** cases, and no seed that previously resolved now errors.
- **Global-id *traversals that pass through a colliding brief* change — correctly,
  and by design.** A `learning` id is globally unique, but a learning two hops
  from a colliding brief inherited that brief's fusion. All 28 differences are
  at depth 2 or are label corrections.
- `error` and `session` traversals are unchanged **vacuously** — those types have
  **zero** edges on the live brain, so there is nothing to regress.

#### Worked example — a dropped node set (`11 -> 1`)

`learning:1005` is owned by `fya-hadir-app` and has exactly **one** edge, to
`brief:BR-001`. Pre-BR-078, depth 2 returned **11** neighbours; it now returns
**1**. The ten dropped were reached by walking *through* the fused `BR-001`:
`BR-002`, `BR-003` … `BR-009`, `TD-036`, and `MG-006` — and **`MG-006` exists
only in `fifty-dev`**. A `fya-hadir-app` learning was being told that a
`fifty-dev` brief was two hops away. The hop rule now resolves `BR-001` to
`fya-hadir-app` (owner hint) and drops the rest as `other_instance`.

#### Worked example — a corrected label

`learning:950` is owned by `igris-ai`. `FR-116` exists in **both** `igris-ai`
and `fifty-dev`. Pre-BR-078 its neighbour label read
*"Relocate Tina admin + API surface to admin.fifty.dev subdomain"* —
**fifty-dev's** title, because the old `LABEL_SCHEMA.brief` lookup matched on
`brief_id` alone and took whichever row came first. It now reads
*"Brain Janitor (full vision) …"*, which is `igris-ai`'s own title for `FR-116`,
confirmed against `brief_status`. The same correction lands on `BR-075`,
`FR-119`, `FR-122`, `FR-001` and `FR-002`.

> **If you are diffing before/after and see a change, do not "fix" it back.**
> Every difference measured above is the defect being removed. The regression to
> guard is a *seed* that stops resolving (measured: 0) or a *depth-1* node set
> that moves (measured: 0 of 81) — not a depth-2 set that shrinks.

### Cost

The project lookup is memoised per call and bounded by `max_nodes` distinct ids.
Measured read-only against the live brain (2026-07-29):
`depth=10, max_nodes=100, direction=both` seeded on the busiest colliding brief
and returning the full 100 nodes — **median 2.57 ms, max 3.83 ms** (one warm-up
call discarded, then 9 samples; the same run that produced the residual figures
above, and the same run quoted in `traversal.ts` / `node-project.ts`).
`brief_status`'s PK is `(project, brief_id)`, so `WHERE brief_id = ?` scans; the
stated trigger for raising a `brief_status(brief_id)` index as a follow-up is
~50 ms, which today's numbers are far below. An index here would also mean an
`edges`-component migration mutating the `briefs` component's table.

### Decision — traversal deliberately does NOT model `max_edge_replicas`

This is the one place `igris_graph_neighbors` / `_path` / `_subgraph` knowingly
disagree with `igris_graph_brain`, and it is recorded here because it is a
**decision**, not an oversight.

`whole-graph.ts` sends branch 4 through `finaliseIntraProjectCandidates`, which
drops the edge for **every** project once `|A ∩ C| > max_edge_replicas`
(default 8, caller-tunable 1..32) and reports it as `over_replicated`. Traversal
applies no such cap: it walks the edge whenever `Pc ∈ A ∩ C`. So on an over-cap
edge, a traversal returns a neighbour for which the whole-brain graph has no
edge at all.

**Measured, not assumed** — on the live brain:

| `brief -> brief` edges | count |
|---|---|
| Total (non-soft-deleted) | **427** |
| Both endpoints ambiguous (branch 4 reachable) | **288** |
| `\|A ∩ C\| > 8` — the divergent regime | **41** |

Intersection sizes across the both-ambiguous population run
`1:7, 2:177, 3:8, 4:10, 5:14, 6:6, 7:5, 8:20, 9:11, 10:6, 11:10, 12:2, 13:1, 14:9, 16:2`.
41 live edges diverge today. This is not hypothetical.

**Why the cap is not ported:**

1. `max_edge_replicas` is a **replication-noise control**. It bounds how many
   instances one source row may spawn in a whole-brain payload — a rendering and
   payload-size concern for FR-238 / FR-239. Traversal emits **at most one**
   instance per hop by construction, so the quantity the cap governs cannot
   arise. Porting it would import a mechanism to bound a number that is always 1.
2. It would produce a perverse rule: **the more projects share an id, the fewer
   neighbours you get** — and past the cap, none. A caller who correctly
   qualified their seed would silently lose real *intra-project* edges purely
   because other projects also use that id. That is the fused-graph defect's
   mirror image, not its fix.
3. The cap is **caller-tunable on the other tool**. Honouring it would make a
   traversal's result depend on a parameter its own surface does not expose, and
   `igris_graph_brain({max_edge_replicas: 32})` would silently redefine what
   `igris_graph_neighbors` is supposed to agree with.

**The disagreement is pinned by test**, not left to convention:
`graph-traversal.integration.test.ts` carries a fixture at `|A ∩ C| = 2` proving
the two tools **agree** below the cap, and one at `|A ∩ C| = 10` asserting the
divergence **explicitly** — so neither side can later be "corrected" into the
other without a failing test and a deliberate re-decision.

### Agreement with `igris_graph_brain`

`node-project.ts` implements FR-237's rule rather than importing
`resolveEdgeProjects` — that function's signature is edge-row-shaped, it needs a
`ProjectIndex` built by loading every node row in the brain (absurd for a depth-1
query), and it returns replica instances traversal must never produce. The
anti-fork mechanism is therefore a **cross-tool consistency test**
(`graph-traversal.integration.test.ts`, BR-078 T7) asserting that
`igris_graph_neighbors` and `igris_graph_brain` agree on a fabricated collision
fixture, plus a rule-level agreement test in `node-project.test.ts`. An import
would not have caught a divergence anyway, since the shapes differ.

---

## Caching Semantics

- **Subgraph results only** are cached. Neighbors and path are re-computed on every call (cheap enough — see perf table below).
- TTL: **5 minutes** per cache entry.
- Cache key: stable hash over `(seed_node_type, RESOLVED seed project, seed_node_id, max_nodes, edge_types, include_deleted)`. The project segment is correctness-critical (BR-078): without it, project A's cached subgraph would be served to a project B query for the whole 5-minute TTL. Because the key carries the *resolved* project, `{seed_node_id: 'BR-002'}` and `{seed_node_id: 'BR-002', seed_node_project: 'proj-a'}` correctly share one entry when `BR-002` lives only in `proj-a`.
- Cache size: bounded at **64 entries**, LRU eviction on overflow (insertion-order; the oldest entry is evicted when adding a new one).
- Invalidation: `invalidateSubgraphCache()` is wired to two bus events:
  - `edge.created` — emitted by `igris_edge_create` and the `brief.created` auto-hook.
  - `edge.removed` — emitted by `igris_edge_remove` (soft or hard delete).
- The `cached: true|false` flag in the response surfaces hit/miss to the caller.

If you mutate edges via raw SQL bypassing the bus, the cache will not be invalidated; the 5-minute TTL bounds the worst-case staleness.

---

## Performance Targets and Measured Results

Measured on a synthetic graph of 200 nodes, ~500 edges (average degree ~5), in-memory SQLite. P95 over 50 runs.

| Tool | Target | Measured P95 | Status |
|------|--------|--------------|--------|
| `neighbors(depth=2)` | < 100 ms | ~16 ms | ✓ |
| `path(max_depth=5)` | < 50 ms | ~9 ms | ✓ |
| `subgraph(max_nodes=20)` cold | < 100 ms | ~64 ms | ✓ |
| `subgraph(max_nodes=20)` warm cache | < 5 ms | ~0.2 ms | ✓ |

**Implementation note:** All three tools use **iterative BFS in TypeScript** rather than SQL recursive CTEs. The recursive CTE approach with path-string visited-sets explores all simple paths from the seed (`UNION` cannot dedupe across rows that carry distinct visited strings), which blows up exponentially in dense graphs. Iterative BFS visits each node at most once — `O(V + E)` within `max_depth` — and lets us stop early once `max_nodes` is reached. Each frontier expansion is a single parameterised SQL query against the `entity_edges` table, so the SQL-side work scales linearly with the visited frontier.

---

## Schema Migration v2

FR-113 ships an additive migration (`edgeMigrations[1]`):

```sql
CREATE INDEX IF NOT EXISTS idx_edges_compound
  ON entity_edges(from_type, from_id, edge_type);
```

This compound index accelerates the per-frontier-node query (`WHERE from_type = ? AND from_id = ? AND edge_type IN (...)`). The migration is `IF NOT EXISTS` so re-runs are safe and existing databases pick up the index on next boot.

---

## Soft-Delete Filter

By default, all three tools exclude edges where `metadata.deleted = true`. This matches the FR-105 `igris_edge_list` semantics. Pass `include_deleted: true` to include them — useful for audit views and historical reconstruction.

---

## Label Resolution

Nodes returned by these tools are enriched with a human-readable `label` field via per-type batched queries:

| Entity type | Source table | Label expression |
|-------------|--------------|------------------|
| `brief` | `brief_status` | `title`, matched on the **`(project, brief_id)` pair** (BR-078 — a bare `brief_id` selects one row per project, and the pre-BR-078 code took whichever came first) |
| `learning` | `learnings` | `substr(content, 1, 80)` |
| `error` | `errors` | `message` |
| `session` | `sessions` | `summary` |
| `goal` | `goals` (FR-110) | `title` |

If the label table is missing (e.g. `goals` before FR-110 lands), the tool falls back to using the entity id as its label and logs a single warning per process. This keeps traversal usable on partial schemas.

---

## Cycle Safety

- **Neighbors** — `direction='both'` traversal of a cycle (A→B→C→A) terminates because the JS-side `visited` set rejects already-discovered nodes.
- **Path** — BFS visited-set ensures each node is enqueued at most once. A query for a path from a node to itself returns `found=false` (no self-paths via cycles).
- **Subgraph** — the JS visited-set prevents re-traversing nodes; a 3-node cycle returns 3 nodes and 3 edges.

---

## Out of Scope (deferred)

- **Undirected paths** (`igris_graph_path` follows outgoing only)
- **Weighted shortest path** (uses hop count, not `1 - confidence`)
- **Cross-process cache** (in-memory, per server instance)
- **Subgraph layout hints** (positions, communities) — FR-112
- **Diff/changed-since traversal**
- ~~**A project column on `entity_edges`**~~ — **SHIPPED, BR-083** (`edges:4`).
  It did not retire `unresolved_hops`; it NARROWED it. The counter now means
  *"hops over rows that predate `edges:4` and could not be attributed"*, it
  cannot be incremented by a row minted after the migration (an ambiguous
  endpoint is refused at `handleEdgeCreate`), and it is expected to trend toward
  zero without reaching it. Removing it would be a payload break across ten
  consumers to delete a number that is still non-zero.

---

## Source Files

- `brain-mcp-server/src/engine/components/edges/traversal.ts` — handlers, cache, label resolution, seed ladder
- `brain-mcp-server/src/engine/components/edges/node-project.ts` — BR-078 project resolver + the hop rule
- `brain-mcp-server/src/engine/components/edges/graph-keys.ts` — the ONE composite-key serialiser (FR-237), imported unmoved
- `brain-mcp-server/src/engine/components/edges/index.ts` — tool registration, event wiring
- `brain-mcp-server/src/engine/components/edges/schema.ts` — migration v2 (compound index)
- `brain-mcp-server/src/engine/components/edges/__tests__/traversal.test.ts` — unit tests
- `brain-mcp-server/src/engine/components/edges/__tests__/node-project.test.ts` — resolver + hop-rule units
- `brain-mcp-server/src/engine/__tests__/graph-traversal.integration.test.ts` — MCP roundtrip, cross-tool consistency, perf benchmarks

> No CI workflow runs `brain-mcp-server` vitest (TD-312) — these suites are a
> **local gate**. Run them and read the output; do not treat "tests written" as
> "tests passing".
