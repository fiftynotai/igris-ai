# Goals — Outcome-Level Entities

**Brief:** FR-110 — Goals as First-Class Entities Distinct From Briefs
**Status:** Phase 1 (schema + tools) and Phase 2 (skill surface + backfill) shipped together.
**Schema:** `goals` table, see `brain-mcp-server/src/engine/components/goals/schema.ts` (component migration v1, recorded in `engine_migrations`).

---

## Why goals are not briefs

Igris started with one work-item type — the brief. People then needed a way
to express **outcomes** that span multiple briefs (e.g. "Ship v6.1 by Friday",
"Pass the compliance audit"). Without a dedicated outcome type, we ended up
with three workarounds, all bad:

1. **Master briefs** — a parent brief whose only role is to group children.
   It has a status, an effort estimate, and acceptance criteria, none of which
   make sense for an outcome. Its status drifts as children change but is
   never authoritative.
2. **Deadlines buried in markdown** — "Need this by 2026-05-01" inside a
   brief description. Invisible to any cross-cutting query.
3. **Cross-project tracking via spreadsheets** — there was no way to ask
   "what outcomes are active across all my projects?" because briefs are
   per-project.

A goal is the missing primitive: **a deadline, a status lifecycle, and an
outcome**, with optional cross-project scope. Briefs link to goals via the
existing `entity_edges.serves_goal` edge type from FR-105.

| Property        | Brief                                | Goal                          |
|-----------------|--------------------------------------|-------------------------------|
| Identity        | `BR-XXX`, `FR-XXX`, etc.             | `GL-XXX`                      |
| Scope           | One project                          | One project, or cross-project |
| Status surface  | 6 states (Ready → Done, etc.)        | 4 states (active → achieved)  |
| Has a deadline? | No (occasionally in description)     | Yes (first-class column)      |
| Effort estimate | Yes (S/M/L/XL)                       | No                            |
| What it tracks  | A unit of work                       | A desired outcome             |

When in doubt: **if it has a "done" state and someone is going to do it, it's a brief. If it has a "by when" and "what success looks like", it's a goal.**

---

## Lifecycle

```
   ┌──────────┐
   │  active  │ ← initial state on create
   └────┬─────┘
        │
   ┌────┼────┬─────────────┐
   ▼    ▼    ▼             │
 achieved  abandoned  deferred
        ▲    ▲             │
        └────┴─────────────┘  (any non-terminal can transition between)
```

- **active** — currently being pursued.
- **achieved** — the outcome was delivered. `achieved_at` is auto-set to now
  on transition. Reverting from `achieved` to any other state clears
  `achieved_at` (defensive — typos happen).
- **abandoned** — explicitly given up on. No automatic timestamp; record
  why in `metadata.reason` if it matters.
- **deferred** — paused, may resume later. Distinct from `abandoned`
  because the goal is still on the radar.

The transition `* -> achieved` emits `goal.achieved` in addition to
`goal.updated`. No other transitions emit specialized events in Phase 1.

---

## Schema

See [`brain-mcp-server/src/engine/components/goals/schema.ts`](../../brain-mcp-server/src/engine/components/goals/schema.ts).
Highlights:

- `goal_id TEXT NOT NULL UNIQUE` — `GL-XXX` format, allocated server-side
  via `MAX(numeric suffix) + 1`. The UNIQUE constraint is the safety net
  for cross-connection races; the create handler retries once on collision.
- `status` carries a `CHECK` constraint matching `VALID_GOAL_STATUSES`.
  Direct INSERTs that bypass the handler are rejected at the database layer.
- `outcome TEXT NOT NULL` — free text (e.g. `'shipped'`, `'audited'`,
  `'measured at <metric>'`). Intentionally not an enum — outcomes vary too
  much to constrain usefully.
- `project_slug TEXT` (nullable) — `NULL` denotes a cross-project goal
  surfaced in `/ops` rather than `/scan`.

### Indexes

- `idx_goals_project` — covers `/scan` (filtered by project).
- `idx_goals_status`  — covers status filters.
- `idx_goals_deadline` — **partial index** `WHERE status = 'active'`. The
  `/boot` "approaching deadline" query reads only active goals; archived
  goals would otherwise pollute the index without ever being queried.

---

## Edge contract

Goals integrate with the rest of the brain via `entity_edges`:

| `from_type` | `from_id` | `to_type` | `to_id`  | `edge_type`   | Meaning                       |
|-------------|-----------|-----------|----------|---------------|-------------------------------|
| `brief`     | `BR-XXX`  | `goal`    | `GL-XXX` | `serves_goal` | Brief contributes to the goal |
| `learning`  | `L-XXX`   | `goal`    | `GL-XXX` | `serves_goal` | Learning informs the goal     |

Both `goal` and `serves_goal` were registered in FR-105's catalogs, so no
further edge work was needed in this brief. Many-to-many is supported (a
brief can serve multiple goals; a goal can be served by many briefs).

Soft-delete is applied via `metadata.deleted = 1`. All goal queries
(`goal_get`, `goal_progress`, `goal_list.serving_briefs_count`) exclude
soft-deleted edges via `COALESCE(json_extract(metadata, '$.deleted'), 0) != 1`.

---

## Progress computation

`igris_goal_progress` returns five numbers and a percentage:

```
{
  serving_briefs_total,
  serving_briefs_done,        // Done OR Archived
  serving_briefs_in_progress, // In Progress
  serving_briefs_pending,     // everything else (Ready, Draft, Blocked, ...)
  completion_pct,             // done / total, or null when total === 0
  serving_learnings_count
}
```

### Why count-based, not effort-weighted

Effort labels (`S`/`M`/`L`/`XL`) are self-reported and inconsistent — even
this very brief carries an `S-Small` label that the architect verdict
disputes as `M-Medium`. Weighting by effort would propagate that drift
into goal progress. Counting briefs is simple, transparent, and self-
correcting as briefs are added or removed.

### Why "done" includes Archived

The `briefs/index.ts` component fires `brief.completed` for both `Done`
and `Archived` (defined in its `TERMINAL_STATUSES` constant). A brief that
is archived (rolled into another effort, deferred, etc.) has still done its
work *as far as the goal is concerned* — what matters at the goal level is
that the brief is no longer active. Archived ≠ Cancelled here.

### Why `completion_pct` is `null` (not `0`) when there are no serving briefs

`null` means "no measurement available". `0` means "0% done". A goal with
no serving briefs has not failed to make progress — there is simply nothing
to measure yet. Distinguishing the two prevents `/scan` from rendering a
misleading `[----------] 0/0` bar for goals that haven't been wired up.

### Why learnings don't count toward `completion_pct`

Learnings have no terminal status — there is no "Done" for a piece of
knowledge. A goal can be served by 100 learnings and still not be
"50% complete" in any meaningful sense. The count is surfaced as
`serving_learnings_count` so that callers know learnings exist without
distorting progress math. Full goal-by-learning navigation is deferred.

---

## Worked example: FR-091 master brief → GL-001

Before FR-110, `FR-091 — Igris v6 Master` was a "feature request" brief
with five children (`FR-092` through `FR-095`, plus a fifth). Its
`status` field drifted: even though most children were `Done`, the master
was still `In Progress` because no one marked the rolled-up state.

After the one-shot backfill (now retired):

```
GL-001 "Ship Igris v6"            (active, deadline 2026-04-30)
  ↑ serves_goal ───────────────┐
  ┌──────────┐  ┌───────────┐  │  ┌───────────┐
  │  FR-091  │  │   FR-092  │  │  │   FR-093  │  …
  │ (master, │  │  (shipped)│  │  │ (shipped) │
  │  kept    │  └───────────┘  │  └───────────┘
  │  for     │        ↑        │        ↑
  │  audit)  │        └────────┴────────┘
  └──────────┘    serves_goal edges
```

`igris_goal_progress GL-001` then returns
`{ total: 5, done: 4, completion_pct: 0.8 }` — a real measurement of how
close the goal is to its deadline.

---

## What goals are NOT (in Phase 1)

Deferred to follow-up briefs to keep the surface focused:

- **Sub-goals** — there is no `goal -> goal` parent-of edge in this brief.
  Compose multiple flat goals if you need decomposition.
- **OKRs / quantitative key results** — `outcome` is free text on purpose.
  If we add KRs later, they become rows in their own table referencing the
  parent goal; the schema does not yet anticipate that.
- **Auto-status transitions** — when every serving brief is `Done`, the
  goal does NOT auto-transition to `achieved`. Status is human-asserted
  in Phase 1. FR-106 (subconscious engine) may relax this later, but
  even then the proposal is "suggest the transition", not "perform it".

---

## /boot integration

`/boot` calls `igris_goal_list(project, status='active', upcoming_days=14, limit=3)`
and renders ≤3 lines. The token budget is bounded:

```
## Goals approaching deadline
- GL-003 "Ship v6.1" — due 2026-05-01 (3 days), 4/7 briefs done
- GL-001 "Compliance audit" — due 2026-05-12 (14 days), 1/5 briefs done
```

If zero results, the section is omitted entirely. If more than 3 active
goals exist beyond the 14-day window, `/boot` prints a single trailing
line: `(+N other active goals — run /scan for full list)`.

The `upcoming_days` filter exists for this surface specifically — outside
of `/boot` the parameter is rarely useful.

---

## Cross-project goals

A goal with `project_slug = NULL` is a **cross-project goal**. These are:

- **Not shown in `/scan`** — `/scan` is project-scoped, so it filters
  `project_slug = $project`.
- **Shown in `/ops`** — rendered in the heatmap row labeled
  "Cross-project".

This split is intentional: cross-project goals would dilute `/scan`'s
project-focused output, but they are exactly what `/ops` is for.

---

## References

- **FR-105** — Typed Edges. Source of `goal` entity type and `serves_goal` edge type.
- **FR-110** — This brief. Schema, tools, skills, backfill.
- **FR-106** — Subconscious engine (future). Will listen on `goal.created`
  and may listen on `brief.completed` to suggest goal status transitions.
- **FR-107** — Provenance on Learnings. Same pattern of per-component
  schema migration shipping in the component, not in `db.ts`.

### Related code

- Schema: `brain-mcp-server/src/engine/components/goals/schema.ts`
- Handlers: `brain-mcp-server/src/engine/components/goals/handlers.ts`
- Component: `brain-mcp-server/src/engine/components/goals/index.ts`
- Tests: `brain-mcp-server/src/engine/components/goals/__tests__/`
- Sync entry: `brain-mcp-server/src/tools/sync.ts` (`SYNC_TABLES` → `goals`)
- Backfill: one-shot (FR-110), already applied and retired
