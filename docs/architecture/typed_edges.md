# Typed Edges (FR-105)

> Foundational graph layer over Igris first-class entities — briefs, learnings, errors, sessions, goals.

## Why

Igris already has implicit graph data: briefs reference parents in markdown headers, learnings reference contexts, errors recur. Until FR-105 that information lived as free-text inside markdown bodies, invisible to queries. This component captures those relationships as queryable structure without abandoning SQLite.

## Schema

A single table, owned by the `edges` engine component (per-component migration `edges:1`).

```sql
CREATE TABLE entity_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_type TEXT NOT NULL,
  from_id   TEXT NOT NULL,
  to_type   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  provenance TEXT NOT NULL DEFAULT 'observed',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata   TEXT NOT NULL DEFAULT '{}',
  UNIQUE(from_type, from_id, to_type, to_id, edge_type)
);

CREATE INDEX idx_edges_from ON entity_edges(from_type, from_id);
CREATE INDEX idx_edges_to   ON entity_edges(to_type, to_id);
CREATE INDEX idx_edges_type ON entity_edges(edge_type);
```

### Index count discrepancy (flagged)

The FR-105 brief's acceptance criteria mentions "5 indexes". The canonical schema in the same brief lists three. The implementation plan ships **3** indexes (`from`, `to`, `edge_type`). Speculative indexes on `provenance` and `confidence` are deferred to FR-113 (graph-traversal MCP tools), where actual query patterns will tell us whether they earn their cost. If you need them sooner, raise a follow-up brief — adding indexes is non-breaking.

## Entity types

`from_type` and `to_type` are constrained at the handler layer to:

| Type | Stable id format | Examples |
|------|------------------|----------|
| `brief` | brief id (e.g. `FR-105`, `BR-031`, `TD-045`) | feature briefs, bugs, migrations |
| `learning` | `L-XXXX` | extracted patterns / heuristics |
| `error` | error fingerprint | recurring errors |
| `session` | session id | work sessions |
| `goal` | goal id (FR-110) | first-class objectives |

Edge types are stored as plain strings — extending the catalog is a code change in `handlers.ts`, not a migration.

## Edge type catalog

| Edge type | Direction | Meaning | Typical source |
|-----------|-----------|---------|----------------|
| `parent_of` | A -> B | A is the master/parent brief, B is a child sub-brief | `**Parent Brief:** FR-XXX` header |
| `depends_on` | A -> B | A cannot ship until B is done | `**Blocked By:** FR-XXX` / `Depends on:` |
| `blocks` | A -> B | A actively prevents B from progressing | `Blocks: FR-XXX` |
| `supersedes` | A -> B | A replaces B (B should be archived) | `Supersedes: FR-XXX` |
| `related_to` | A <-> B | Loose semantic association (bidirectional in spirit; stored as a single directed row) | `Related: FR-XXX` |
| `serves_goal` | A -> G | A advances goal G (FR-110) | manual / inferred |
| `duplicates` | A -> B | A is a duplicate of B (consolidation candidate) | similarity detector |
| `derived_from` | A -> B | A learning derived from B brief/error | learning extraction (FR-109) |
| `recurs_with` | A <-> B | Two errors that co-occur (cluster signal). The **only** edge type that may be self-referential. | error clustering |

## Provenance

| Value | Meaning |
|-------|---------|
| `observed` | Captured live (auto-hooks, MCP tool calls in normal use) |
| `backfill` | Reconstructed by a one-shot backfill (now retired) from existing brief markdown |
| `inferred` | Derived by a heuristic (similarity, co-occurrence) — confidence < 1.0 expected |
| `user` | Manually authored by a human via tooling |

## MCP tools

### `igris_edge_create`
Idempotent insert. Re-creating an identical `(from_type, from_id, to_type, to_id, edge_type)` tuple returns the existing edge with `created: false`.

```jsonc
{
  "from_type": "brief",
  "from_id": "FR-053",
  "to_type": "brief",
  "to_id":   "FR-051",
  "edge_type": "parent_of",
  "confidence": 1.0,
  "provenance": "observed",
  "metadata": { "source": "manual" }
}
```

Validation rules in the handler (defense in depth beyond the JSON Schema enums):
- `from_type` and `to_type` must be in the entity-type list above.
- `edge_type` must be in the catalog.
- `confidence` is clamped to `[0, 1]`; non-numeric inputs fall back to the default.
- Self-loops (same `from` and `to`) are rejected unless `edge_type === 'recurs_with'`.

### `igris_edge_list`
Filter by any subset of `from_type`, `from_id`, `to_type`, `to_id`, `edge_type`, `provenance`, `min_confidence`. Defaults to `LIMIT 200` (max 1000). Soft-deleted edges are excluded unless `include_deleted: true`.

### `igris_edge_remove`
Soft delete by default — sets `metadata.deleted = true` and a `metadata.deleted_at` timestamp so the row remains for audit and is excluded from the default `igris_edge_list` query. Pass `hard: true` to permanently delete.

## Auto-hook: brief.created -> parent_of

The `edges` component subscribes to `brief.created`. When the payload includes `parent_brief_id`, the component creates a `parent_of` edge immediately. The briefs component populates `parent_brief_id` from one of two sources, in order:

1. The explicit `parent_brief` field on `igris_brief_create` input.
2. A regex scan of the markdown content for `**Parent Brief:** FR-XXX` (also tolerant of `Parent: FR-XXX` and `## Parent: FR-XXX`).

This keeps the briefs component free of edge logic while ensuring every channel that creates a brief (MCP tool, `/register` skill, future channels) participates in the graph.

The hook is silently a no-op when:
- The payload has no `parent_brief_id`.
- The brief id equals the parent brief id (defensive — prevents degenerate self-edges).

## Backfill (retired one-shot)

The initial `entity_edges` population was reconstructed by a one-shot backfill (FR-105) that scanned `brief_files.content` for the structural marker patterns in the table above. It ran once against the live brain DB (idempotent `INSERT OR IGNORE`, so re-runs were no-ops) and has since been retired — there is no live caller.

All edges it produced are tagged `provenance='backfill'`, which makes a clean rollback trivial:

```sql
DELETE FROM entity_edges WHERE provenance = 'backfill';
```

### Realistic yield (historical)

The pre-flight dry run on 2026-04-28 against the live brain DB produced:

| Scope | parent_of | depends_on | supersedes | blocks | related_to | total |
|-------|----------:|-----------:|-----------:|-------:|-----------:|------:|
| `igris-ai` only | 9 | 9 | 0 | 0 | 0 | 18 |
| All projects | 14 | 15 | 1 | 4 | 2 | 36 |

The brief acceptance criterion of "≥ 50 edges" was written assuming an older brief style (`Parent: FR-XXX` rather than the modern markdown-bold `**Parent Brief:** FR-XXX` header). It was scoped down to "≥ 30 edges or all detectable markers covered" — 36 > 30 and every detectable structural marker was extracted, so the criterion was satisfied in spirit.

## Query recipes

```sql
-- Direct parents of FR-053
SELECT to_id FROM entity_edges
 WHERE from_type='brief' AND from_id='FR-053' AND edge_type='parent_of'
   AND COALESCE(json_extract(metadata,'$.deleted'), 0) = 0;

-- All children of FR-051 (master brief)
SELECT from_id FROM entity_edges
 WHERE to_type='brief' AND to_id='FR-051' AND edge_type='parent_of';

-- Transitive ancestor closure (recursive CTE)
WITH RECURSIVE ancestors(id) AS (
  SELECT to_id FROM entity_edges
   WHERE from_type='brief' AND from_id='FR-053' AND edge_type='parent_of'
  UNION
  SELECT e.to_id FROM entity_edges e JOIN ancestors a ON e.from_id = a.id
   WHERE e.edge_type='parent_of'
)
SELECT * FROM ancestors;

-- All briefs blocked transitively by FR-100
WITH RECURSIVE blocked(id) AS (
  SELECT from_id FROM entity_edges
   WHERE to_id='FR-100' AND edge_type IN ('depends_on','blocks')
  UNION
  SELECT e.from_id FROM entity_edges e JOIN blocked b ON e.to_id = b.id
   WHERE e.edge_type IN ('depends_on','blocks')
)
SELECT * FROM blocked;

-- High-confidence inferred edges only
SELECT * FROM entity_edges
 WHERE provenance='inferred' AND confidence >= 0.8;
```

FR-113 will package these recipes as MCP tools (`igris_graph_ancestors`, `igris_graph_descendants`, `igris_graph_blocked_by_closure`).

## Sync

`entity_edges` is registered in `SYNC_TABLES` (`brain-mcp-server/src/tools/sync.ts`) with:

- **Strategy:** `append` — new rows are pushed; the `UNIQUE` constraint is the conflict resolution.
- **syncKey:** `(from_type, from_id, to_type, to_id, edge_type)` — matches the local UNIQUE so remote `INSERT OR IGNORE` produces the same idempotency.
- **Soft deletes** propagate as ordinary metadata mutations (the row is still there, just with `metadata.deleted=true`).

## Migration / deployment

The `edges:1` migration runs automatically on the next `bootEngine()` / `pm2 restart brain` cycle:

- Local: applied by `getDb()` boot when the brain MCP server starts.
- VPS: applied by `igris sync code` (which rsyncs the repo and ssh-restarts `igris-brain` via PM2; previously `scripts/igris_vps_update.sh`, retired in MG-014 M4). Verify post-deploy with `SELECT * FROM engine_migrations WHERE component='edges'`.

The migration is fully `IF NOT EXISTS`-guarded, transaction-wrapped, and re-run safe.

## Rollback

| Failure | Recovery |
|---------|----------|
| Migration failed mid-run | Transaction rolled back. Drop partial table if needed: `DROP TABLE IF EXISTS entity_edges;` |
| Backfill produced noise | `DELETE FROM entity_edges WHERE provenance='backfill';` (clean undo — backfill rows are tagged) |
| Hook misfired and produced wrong `parent_of` edges | `DELETE FROM entity_edges WHERE provenance='observed' AND edge_type='parent_of' AND created_at > '<deploy_ts>';` |
| Pull the entire feature | `DROP TABLE entity_edges; DELETE FROM engine_migrations WHERE component='edges';` then `git revert` the component PRs. No other component currently depends on `edges`. |

## Out of scope (other briefs)

| Concern | Tracked in |
|---------|-----------|
| Visualization | FR-111 |
| Graph traversal MCP tools | FR-113 |
| Provenance enrichment / sources | FR-107 |
| Goals as first-class entities | FR-110 |
| Community detection | FR-112 |
| Conflict detector for learnings | FR-108 |
| Auto-extraction from learnings (perception channel) | FR-109 |
| Inter-project edges (multi-project graph) | deferred to v7 |
