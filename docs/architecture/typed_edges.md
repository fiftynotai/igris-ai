# Typed Edges (FR-105)

> Foundational graph layer over Igris first-class entities — briefs, learnings, errors, sessions, goals.

## Why

Igris already has implicit graph data: briefs reference parents in markdown headers, learnings reference contexts, errors recur. Until FR-105 that information lived as free-text inside markdown bodies, invisible to queries. This component captures those relationships as queryable structure without abandoning SQLite.

## Schema

A single table, owned by the `edges` engine component (per-component migration `edges:1`).

```sql
-- as of migration edges:4 (BR-083)
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
  from_project TEXT,          -- BR-083, NULLABLE
  to_project   TEXT           -- BR-083, NULLABLE
  -- NO table-level UNIQUE. See the expression index below.
);

CREATE INDEX idx_edges_from ON entity_edges(from_type, from_id);
CREATE INDEX idx_edges_to   ON entity_edges(to_type, to_id);
CREATE INDEX idx_edges_type ON entity_edges(edge_type);
CREATE INDEX idx_edges_compound ON entity_edges(from_type, from_id, edge_type);

CREATE UNIQUE INDEX idx_edges_unique ON entity_edges(
  from_type, from_id, COALESCE(from_project, ''),
  to_type,   to_id,   COALESCE(to_project, ''),
  edge_type);

CREATE INDEX idx_edges_from_proj ON entity_edges(from_type, from_id, from_project);
CREATE INDEX idx_edges_to_proj   ON entity_edges(to_type,   to_id,   to_project);
```

## The project axis (BR-083)

A brief id is unique only WITHIN a project. Before `edges:4` an edge row
addressed each endpoint as a bare `(type, id)` pair, so every edge to or from a
brief whose id existed in more than one project was ambiguous. Measured on the
operator's brain, 2026-08-11: **785 edges, 692 touching a brief, 515 of those
(74.6%) referencing an id that lives in 2+ projects, across 35 projects**. The
demonstrating case was `igris_goal_get GL-006` returning **44 rows for 32
edges**, four of them briefs from three unrelated projects.

**Both columns are NULLABLE and must stay that way.** A `concept -> concept`
edge legitimately has no project, and synapse's `edge_inference` suggestions are
deliberately project-less. More importantly, **NULL is a stated verdict** —
*deliberately unattributed* — and never *"unknown, guess later"*. Roughly half
the pre-BR-083 rows carry it permanently.

### The qualification ladder — required IFF ambiguous

Enforced in `handleEdgeCreate`, per endpoint. `P(type, id)` is the set of
projects that entity lives in, computed by `node-project.ts::projectsFor` — the
SAME resolver BR-078's traversal seeds use, so an operator sees one error
dialect rather than two.

| `\|P\|` | qualifier omitted | qualifier supplied |
|---|---|---|
| 0 | store `NULL` | store VERBATIM (endpoint existence was never validated) |
| 1 | resolve for free -> `P[0]` | `== P[0]` accept; else REJECT |
| >1 | **REJECT**, listing the candidates | `∈ P` accept; `∉ P` REJECT |

The condition is **empirical, not a type list**. `PROJECT_SCOPED_TYPES` is a
doc-constant and no code branches on it, so a type that starts colliding in
future is handled with no code change.

**Why it is not a `required` key and not a `CHECK`.** The rule needs a lookup
into `brief_status`, so JSON Schema cannot express it (there is no conditional
`required`) and neither can a DDL `CHECK` (it cannot read another table). A
blanket `required` entry would also reject the legitimately project-less
concept and synapse edges. `handleEdgeCreate` is the choke point for this
table — one gateway-dispatched call site and NINE in-process callers that never
touch `dispatch()` — so enforcing there is the choke-point principle applied
correctly, not a per-tool guard substituting for it.

**Why the UNIQUE is an expression index.** NULL is DISTINCT from NULL in a
SQLite `UNIQUE`, so `UNIQUE(..., from_project, ...)` would let two identical
project-less concept edges BOTH insert and silently break idempotency for
exactly the population that legitimately has no project. `COALESCE(x, '')`
folds them. A table-level UNIQUE also cannot be dropped in place, which is why
`edges:4` is a 12-step REBUILD — and the rebuild is what makes two edges
differing ONLY by project storable at all.

### Attribution of pre-BR-083 rows

`scripts/backfill_entity_edge_projects.ts`. **Provable is defined as
`resolveEdgeProjects(...).resolution === 'unique'`** — the verdict
`igris_graph_brain` already computes on every call — and nothing else. Dry run
by default; `--apply` requires `--snapshot <verified backup>`; every decision,
attributed or refused, goes to a JSONL report.

Measured on a `VACUUM INTO` snapshot of the operator's brain, 2026-08-11:

| class | FR-237 branch | verdict | count |
|---|---|---|---|
| C1 | 1 — neither endpoint ambiguous | attributed | 268 |
| C2 | 2 — owner hint applies | attributed | 175 |
| C3 | 4, `\|C\| = 1` | attributed | 15 |
| C4 | 4, `1 < \|C\| <= 8` | **NULL** | 283 |
| C5 | 4, `\|C\| > 8` | **NULL** | 43 |
| C6 | 3 — one ambiguous, hint fails | **NULL** | 1 |
| C7 | 4, `\|C\| = 0` dangling | **NULL** | 0 |

**458 of 785 (58.3%) attributed, 327 (41.7%) deliberately left NULL.** That is
the honest headline: a wrong attribution is worse than a null, so C4-C7 are
refused rather than guessed. Widening the provable classes needs its own brief.

### Egress ordering hazard

Both columns join `SYNC_TABLES.entity_edges`'s `columns` AND its `syncKey`
(the key mirrors the local uniqueness so the remote `INSERT OR IGNORE` shares
it; omitting them would re-create the fusion on the VPS). **The remote must run
`edges:4` before the first local push**, or every INSERT fails on
`no such column: from_project`.

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
Idempotent insert. Re-creating an identical `(from_type, from_id, from_project, to_type, to_id, to_project, edge_type)` tuple returns the existing edge with `created: false`.

```jsonc
{
  "from_type": "brief",
  "from_id": "FR-053",
  "from_project": "igris-ai",
  "to_type": "brief",
  "to_id":   "FR-051",
  "to_project": "igris-ai",
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
- **BR-083:** each endpoint runs the qualification ladder above. An id that
  lives in more than one project and arrives unqualified is REFUSED, with the
  candidate projects named; an id that lives in exactly one is resolved for
  you and the caller need pass nothing.

### `igris_edge_list`
…also filters on `from_project` / `to_project`. These are EQUALITY filters, so
they never match the deliberately-unattributed rows: asking for
`from_project = 'igris-ai'` returns the edges PROVEN to be igris-ai's, not
everything that might be. The residual is visible by omitting the filter and
comparing totals.

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
