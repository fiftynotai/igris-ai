# Graph Traversal — FR-113

Three read-only MCP tools layered on top of the FR-105 `entity_edges` table to enable structured navigation of the Igris knowledge graph: `igris_graph_neighbors`, `igris_graph_path`, and `igris_graph_subgraph`.

These tools live in the `edges` brain component (version `1.1.0`) and reuse the entity-type and edge-type catalogs from FR-105.

---

## Tool Reference

### `igris_graph_neighbors`

BFS within N hops of a seed node. Direction-aware. Returns nodes only (no edges) — call `igris_edge_list` if you need the edges.

| Param | Type | Default | Cap | Notes |
|-------|------|---------|-----|-------|
| `node_type` | enum (entity types) | required | — | Seed entity type |
| `node_id` | string | required | — | Seed entity id |
| `depth` | int | 1 | [1, 10] | Maximum hops |
| `direction` | `in` \| `out` \| `both` | `both` | — | Edge traversal direction |
| `edge_types` | array of enum | none | — | Optional edge_type filter (subset of FR-105 catalog) |
| `max_nodes` | int | 100 | [1, 100] | Hard result cap |
| `include_deleted` | bool | false | — | Include soft-deleted edges |

**Response:**
```json
{
  "seed": { "type": "brief", "id": "FR-113" },
  "depth": 2,
  "direction": "both",
  "neighbors": [
    { "type": "brief", "id": "FR-105", "label": "Typed Edges", "depth": 1 },
    { "type": "goal",  "id": "G-001",  "label": "Knowledge graph", "depth": 2 }
  ],
  "count": 2,
  "truncated": false
}
```

### `igris_graph_path`

Shortest **directed** path from one entity to another via outgoing edges. Cycle-safe via BFS visited-set.

| Param | Type | Default | Cap | Notes |
|-------|------|---------|-----|-------|
| `from_type` | enum | required | — | Source type |
| `from_id` | string | required | — | Source id |
| `to_type` | enum | required | — | Target type |
| `to_id` | string | required | — | Target id |
| `max_depth` | int | 5 | [1, 10] | BFS depth cap |
| `edge_types` | array of enum | none | — | Optional edge_type filter |
| `include_deleted` | bool | false | — | Include soft-deleted edges |

**Per FR-113 user-approved decision:** v1 is directed-only (follows `from→to` only). No `direction` param. If undirected paths are needed later, add a follow-up brief.

**Response (path found):**
```json
{
  "from": { "type": "brief", "id": "FR-113" },
  "to":   { "type": "goal",  "id": "G-001"   },
  "found": true,
  "length": 2,
  "path": [
    { "type": "brief", "id": "FR-113", "label": "Graph Traversal" },
    { "type": "brief", "id": "FR-105", "label": "Typed Edges", "edge_id": 12, "edge_type": "depends_on" },
    { "type": "goal",  "id": "G-001",  "label": "Knowledge graph", "edge_id": 17, "edge_type": "serves_goal" }
  ]
}
```

**Response (no path):**
```json
{
  "from": { "type": "brief", "id": "X" },
  "to":   { "type": "brief", "id": "Y" },
  "found": false,
  "length": null,
  "path": []
}
```

### `igris_graph_subgraph`

Connected subgraph (nodes + edges) reachable from a seed, bounded by `max_nodes`. Both directions traversed. Useful for visualization.

| Param | Type | Default | Cap | Notes |
|-------|------|---------|-----|-------|
| `seed_node_type` | enum | required | — | Seed type |
| `seed_node_id` | string | required | — | Seed id |
| `max_nodes` | int | 20 | [1, 100] | Total node cap |
| `edge_types` | array of enum | none | — | Optional edge_type filter |
| `include_deleted` | bool | false | — | Include soft-deleted edges |

**Response:**
```json
{
  "seed": { "type": "brief", "id": "FR-113" },
  "nodes": [
    { "type": "brief", "id": "FR-113", "label": "Graph Traversal", "is_seed": true },
    { "type": "brief", "id": "FR-105", "label": "Typed Edges" }
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
  "cached": false
}
```

---

## Caching Semantics

- **Subgraph results only** are cached. Neighbors and path are re-computed on every call (cheap enough — see perf table below).
- TTL: **5 minutes** per cache entry.
- Cache key: stable hash over `(seed_node_type, seed_node_id, max_nodes, edge_types, include_deleted)`.
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
| `brief` | `brief_status` | `title` |
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

---

## Source Files

- `brain-mcp-server/src/engine/components/edges/traversal.ts` — handlers, cache, label resolution
- `brain-mcp-server/src/engine/components/edges/index.ts` — tool registration, event wiring
- `brain-mcp-server/src/engine/components/edges/schema.ts` — migration v2 (compound index)
- `brain-mcp-server/src/engine/components/edges/__tests__/traversal.test.ts` — unit tests (35)
- `brain-mcp-server/src/engine/__tests__/graph-traversal.integration.test.ts` — MCP roundtrip + perf benchmarks (13)
