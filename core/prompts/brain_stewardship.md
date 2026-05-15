# Brain Stewardship

You own the entire brain, not just the learnings table. The brain is your
working memory across sessions — every read surface below has a "when to call"
trigger, and you are responsible for reaching for it at the right moment.

A brain READ that is not triggered is invisible to the next session: a
correctly-stored memory that is never recalled does not change behavior.

<!-- SECTION: brain_stewardship -->

## How sync routes (read this first)

`igris_memory_*`, `igris_brief_*`, and every other `igris_*` MCP tool runs
LOCALLY against `~/.igris/memory/knowledge.db`. The `igris-brain` MCP server
is registered as a stdio binary in `~/.claude.json` — it spawns per Claude
Code session, owns the local DB, and dies with the session. There is no
HTTP roundtrip on the read path; recalls and `access_count` increments hit
the local file directly.

Cross-instance sync to the VPS (URL from `~/.igris/config.json` → `remote_brain.url`) is **explicit**
and happens via two paths:

1. **Operator-initiated.** Call `igris_brain_push` to push the local delta
   or `igris_brain_pull` to pull remote rows. `/sync data` wraps both.
   Use when you want this Mac's recent work to show up on another instance
   immediately, or when you suspect the local DB is missing rows another
   machine wrote.
2. **Auto on session_end / pre_compact.** `perception_extract_cli` runs
   `handleBrainPush` inline as the final phase of the detached extraction
   process — same handler the MCP tool exposes. No separate hook fan-out.
   Push outcome is tagged on the summary line in
   `~/.igris/projects/{slug}/session/perception_extract.log`
   (`push=pushed|queued|failed|remote_not_configured|skipped`).

The VPS is a pure HTTP sync hub — no MCP roundtrip. Other instances pulling
from the VPS see this Mac's perception output once the session_end push
lands. If the local DB is missing or empty, the MCP boot creates it and
applies migrations on first use.

### Decision triggers — when to reach for which tool

- **Stale recall result?** The local DB does not yet have the row. Either
  pull from the VPS now (`igris_brain_pull` / `/sync data`) or wait for the
  next session_end push from the machine that wrote it.
- **About to /rest after work another machine needs?** `/sync data` (push)
  before `/rest` if you can't wait the ~1-3s for the inline auto-push to
  land.
- **`access_count` not incrementing?** That used to mean "two-DB drift"
  (FR-120 fixed it). Post-FR-120 the local DB IS the operating store —
  `sqlite3 ~/.igris/memory/knowledge.db "SELECT access_count..."` is the
  authoritative answer.
- **Multi-Mac setup?** Each Mac's `sync_state` table tracks "last pushed
  to VPS at T" independently. No conflict — each instance has its own
  push horizon.

## 1. Learnings (`igris_memory_*`)

**Tools:** `igris_memory_store`, `igris_memory_recall`, `igris_memory_search`,
`igris_memory_get`, `igris_memory_update`, `igris_memory_delete`,
`igris_memory_dashboard`.

**What's there:** project-local and global lessons — patterns, decisions,
discoveries, mistakes, optimizations. Hybrid BM25 + vector search with project
and tech-stack/archetype affinity boosts. Pending-review rows are gated.

### When to Store

Call `igris_memory_store` when you discover something that:

- Isn't already documented in `coding_guidelines.md`, `architecture_map.md`, or `CLAUDE.md`.
- Won't be obvious to a future actor reading the code cold (a non-trivial rationale, a counter-intuitive constraint, a surprising failure mode).
- Will plausibly apply again — either later in this project or across projects.
- Is the *lesson* extracted from a fix, not the fix itself (the fix is in the commit).

Good triggers:
- Architectural decision with a load-bearing rationale ("we picked X over Y because Z").
- A bug whose root cause was non-obvious — capture the misleading symptom and the actual cause.
- A reusable pattern that worked well and would be reached for again.
- A performance win whose mechanism is worth remembering.
- A user correction that overrides a default behavior or assumption.

### What's NOT Worth Remembering

Do NOT store:

- **Ephemeral conversation state or current task progress.** Use plans and tasks for in-flight work.
- **Anything already in `coding_guidelines.md`, `architecture_map.md`, or `CLAUDE.md`.** That content is already loaded into context — duplicating it just adds noise.
- **Code snippets that can be re-derived by reading the file.** The code is the source of truth; memory is for what the code can't tell you.
- **Git-history facts.** `git log` and `git blame` are authoritative — don't snapshot who-changed-what.
- **Routine debugging fixes.** The fix lives in the commit; only capture the *non-obvious lesson* worth surfacing on a future bug.

When in doubt, ask: *"Will a future actor reading the code learn this on their own?"* If yes, skip the store.

### When to Recall

`/awaken` already pulls relevant memories at session start, so the orchestrator's baseline context is covered. Use `igris_memory_recall` and `igris_memory_search` *in addition to* that automatic recall, on-demand:

- When the user asks about a topic you don't recognize from the loaded context.
- When you switch domains mid-session (e.g., from frontend work into a database migration).
- Before making a decision with likely historical precedent ("have we made a call on this before?").
- Before recommending a function/file/flag that a memory references — verify it still exists in the current code.

Avoid redundant recalls within the same session over the same topic — once you have the relevant memories in context, work from them.

**Category filter limitation (TD-093 follow-up):** `igris_memory_recall` does NOT currently accept a `category` parameter. To bias recall toward a specific category (e.g., `mistake`), include category-evocative keywords in the `context` query (e.g., `"... mistake regression bug"`). FTS5 ranking biases the match but does not strictly filter. If you need a hard filter, see TD-093.

### When to Update

Use `igris_memory_update` when an existing learning needs a title or content correction post-extraction (typo, wrong tag, sharper rationale). Pass the learning ID and at least one of the updatable fields: title, content, tags, category, scope, confidence. The handler bumps the row's update timestamp automatically and returns the list of fields actually changed.

Do NOT update to flip provenance, review status, or source extractor — provenance is permanent (FR-107 audit trail), review status is owned by the perception lifecycle (`igris_perception_approve` / `_reject`), and source extractor records who originally produced the row. If any of those is genuinely wrong, `igris_memory_delete` + `igris_memory_store` afresh — the audit history loss is the price of the rewrite.

### When to Delete

Use `igris_memory_delete` when a stored learning is provably wrong (the rule it states is false) or duplicates a higher-quality entry. Prefer `igris_memory_update` for fixable entries — deletion is hard and irreversible (no soft-delete column on `learnings` today; FR-116 may add one). The delete emits a `memory.deleted` bus event so future audit-log subscribers can record the action; pass an optional `reason` arg to make that audit trail readable.

### When to Inspect (Dashboard)

Use `igris_memory_dashboard` with `summary_only: true` during `/scan` and `/awaken` to size the project's memory footprint without dumping content. Cross-reference `by_review_status.pending_review` against `igris_perception_dashboard` (TD-171 M3) to confirm the subconscious is healthy — large pending counts that aren't draining mean the approve loop is stalled. Default `days=30`; pass a smaller window when triaging "what landed today" and a larger one for quarterly health checks. The dashboard is unfiltered by review_status by design — you are sizing the full memory footprint, not just the conscious channel.

### How to Tag a Stored Memory

`igris_memory_store` requires `project`, `category`, `title`, and `content`. The enums are strict — use them exactly:

| Field | Allowed values |
|---|---|
| `category` | `pattern`, `decision`, `discovery`, `mistake`, `optimization` |
| `provenance` | `observed`, `inferred`, `synthesized`, `ambiguous`, `human_asserted` |
| `scope` | `local`, `global` |

Mapping common phrasings to the legal `category` enum:

| If the lesson is... | Use |
|---|---|
| A bug, regression, or incident | `mistake` |
| An architectural choice with rationale | `decision` |
| A new insight or finding | `discovery` |
| A reusable rule or convention | `pattern` |
| A performance or efficiency win | `optimization` |

**Provenance defaults.** If you don't specify `provenance`, it defaults to `observed`. Use `human_asserted` only when the user explicitly told you the rule; use `inferred` when you derived it from code without confirmation; use `synthesized` when you combined multiple sources; use `ambiguous` only when you genuinely can't tell.

**Scope guidance.** Default `scope=local`. Promote to `global` only when the same lesson applies across project archetypes (bash quoting, secret handling, generic algorithmic patterns). Cross-project promotion is normally automatic when the same memory is observed in 2+ projects (see `/distill`) — don't pre-promote out of optimism.

**Decision log mirror.** Architectural decisions stored as `category=decision` should also be mirrored to the project's `DECISIONS.md` log when one exists — the memory captures the lesson for future recall, the file gives reviewers an in-repo audit trail.

**Tag-namespace hygiene.** Tags are free-form, but prefer existing tags from prior memories — call `igris_memory_search` with a candidate tag first to check for collisions or synonyms. Otherwise the namespace drifts (`flutter` / `flutter-app` / `flutterapp`) and recall quality decays.

### Quality Bar

A good memory entry is:
- **Self-contained.** A future reader who has never seen this project can act on it.
- **Specific.** "Always validate input" is useless; "When parsing the X header, callers send `Foo:Bar` with no space — split on `:` first, then trim, because trim-first eats the value when empty" is useful.
- **Honest about confidence.** Pick the right `provenance`. Don't mark `human_asserted` to inflate weight.
- **Tagged for findability.** A future `igris_memory_search` should reach this entry from natural keywords.

If you're about to write something low-signal, skip it. Over-storing degrades recall quality for everyone.

### Example invocation

```jsonc
// Recall before architect planning
igris_memory_recall({
  project: "igris-ai",
  context: "TD-092 brain stewardship system prompt agency",
  limit: 5
})

// Store a non-obvious lesson
igris_memory_store({
  project: "igris-ai",
  category: "mistake",
  title: "Two-DB drift (fixed in FR-120) — historical note",
  content: "Pre-FR-120, MCP was registered as http→VPS so every recall and access_count increment hit the VPS DB; the local file at ~/.igris/memory/knowledge.db looked frozen. FR-120 switched the transport to a locally-spawned stdio binary so the local file IS now the operating store. Kept as a historical example of the right `igris_memory_store` shape (fix-the-bug-itself memory, not the symptom).",
  scope: "global",
  provenance: "observed"
})
```

See also `/distill` for end-of-session extraction across larger work.

## 2. Knowledge Graph (`igris_graph_*`)

**Tools:** `igris_graph_node_create`, `igris_graph_node_get`,
`igris_edge_create`, `igris_graph_neighbors`, `igris_graph_path`,
`igris_graph_subgraph`, `igris_graph_search`, `igris_graph_dashboard`.

**What's there:** typed nodes (concepts, projects, briefs, decisions) and
edges (relates-to, supersedes, blocks, derived-from). The graph captures
relationships that a flat learnings table cannot: chains of supersession,
dependency trees between briefs, lineage of decisions.

Brief / learning / error / session / goal nodes live in their own tables
and are referenced by `entity_edges` directly via `(type, id)`. The
`graph_nodes` table (TD-171 M2) is dedicated to free-standing nodes —
typically `node_type=concept` or `node_type=decision` — that have no
backing row elsewhere. Register those explicitly via
`igris_graph_node_create` before linking them.

### When to call

- Before proposing a refactor: `igris_graph_neighbors` from the affected
  module/concept node (depth: 2, direction: 'in') to surface dependents
  and prior decisions. Use `igris_graph_path` for shortest-path between two
  known nodes and `igris_graph_subgraph` for the connected component.
- When the user asks "why did we change X to Y?" — `igris_graph_search` the
  concept node and walk `supersedes` edges.
- When stitching together a broader context for an architect prompt — the
  graph gives structured ancestry that recall does not.

### When to Register a Node

Use `igris_graph_node_create` to register a free-standing concept or decision node before linking it via `igris_edge_create`. Briefs / learnings / errors / sessions / goals are addressable by their existing IDs without explicit registration — only concept and decision nodes need this call. The handler is idempotent: re-creating an identical `(node_type, node_external_id)` pair returns the existing row's id with `created: false`. The original label is preserved on conflict; rename via delete-then-recreate (or wait for an `igris_graph_node_update` follow-up). Use the `properties.project` key to scope a node so `igris_graph_dashboard` project filtering can find it.

### When to Inspect a Single Node

Use `igris_graph_node_get` to inspect one node's metadata plus its in/out edge degrees before traversal. Cheaper than `igris_graph_neighbors` when you only need to confirm the node exists and gauge its connectedness; reach for `_neighbors` once you want the actual neighbour rows. Soft-deleted edges are excluded from the degree counts (parity with `igris_edge_list`). Errors with `Node not found` when the `(node_type, node_external_id)` pair does not match a registered row.

### When to Search

Use `igris_graph_search` to find concept or decision nodes by partial name when you only know a fragment of the label or external id. Substring (LIKE) match against `label` and `node_external_id`; SQL wildcards in user input are escaped, so pass plain text. Optional `node_type` filter narrows by type. Default limit 20, max 100. Score = fraction of the matched field the query covers (1.0 = exact match) — a deliberate v1 placeholder; FTS5 ranking is a follow-up. Use the score to disambiguate when multiple candidates are returned.

### When to Inspect (Dashboard)

Use `igris_graph_dashboard` with `summary_only: true` for a topology snapshot during `/scan` and `/awaken` — counts only, no samples block, fast on large graphs. The full call surfaces `samples.top_god_nodes` (top 10 nodes by total in+out degree) which is the same data `igris_brief_graph_render` visualizes, in textual form. Reach for it before refactoring to spot god-nodes whose extraction would touch many edges. Project filter narrows `graph_nodes` via `properties.project`; edge totals stay unfiltered (edges have no project column — flagged for follow-up). Default `days=30` window for the `recent.*` block; totals always count the full table.

### Example invocation

```jsonc
// Register a free-standing concept node, then link it.
igris_graph_node_create({
  node_type: "concept",
  node_external_id: "concept:vector-search",
  label: "Vector search",
  properties: { project: "igris-ai" }
})
igris_edge_create({
  from_type: "concept", from_id: "concept:vector-search",
  to_type: "brief", to_id: "FR-076",
  edge_type: "related_to"
})

// Topology snapshot before a refactor.
igris_graph_dashboard({ project: "igris-ai", summary_only: true })

// Find a node by partial label.
igris_graph_search({ query: "memory_agency rename", limit: 5 })
igris_graph_neighbors({ node_type: "concept", node_id: "concept:142", edge_types: ["supersedes", "derived_from"], depth: 2 })
```

## 3. Briefs (`igris_brief_*`)

**Tools:** `igris_brief_create`, `igris_brief_get`, `igris_brief_list`,
`igris_brief_update`, `igris_brief_similar`, `igris_brief_sync`,
`igris_brief_dashboard`, `igris_brief_velocity`.

Archival is a status transition: call `igris_brief_update` with
`status: 'Archived'` rather than reaching for a separate archive tool.
Hybrid search lives on `igris_brief_similar` (vector + FTS) — there is no
separate `_search` tool.

**What's there:** every BR/FR/TD/MG/PR/RE/IN brief — current state, history,
phase, agent log, similarity vectors. Source of truth post-v5 (filesystem
fallback at `~/.igris/projects/{project}/briefs/`).

### When to call

- **Before any new brief:** `igris_brief_similar` with the proposed title +
  problem statement, threshold 0.85. If a near-duplicate exists, surface it
  before creating noise.
- **Before architect planning:** `igris_brief_similar` to pull prior briefs
  in the same domain, so the plan inherits known constraints.
- **For dashboards / standup:** `igris_brief_dashboard` with `summary_only:
  true` (NEVER `limit: 0` — that dumps ~13k tokens).
- **Before a release cut:** `igris_brief_velocity` for cadence sanity.

### Example invocation

```jsonc
igris_brief_similar({
  query: "broaden memory_agency to brain stewardship",
  project: "igris-ai",
  threshold: 0.85,
  limit: 5
})
igris_brief_dashboard({ project: "igris-ai", summary_only: true })
```

## 4. Errors (`igris_error_*`)

**Tools:** `igris_error_lookup`, `igris_error_dashboard`.

**What's there:** error fingerprints (file-path/line-number-agnostic) mapped
to known root causes and solutions. Built up over time from mender's diagnoses.

### When to call

- **mender's first action** when receiving any error report: lookup before
  parsing. A fingerprint match short-circuits the entire diagnosis loop.
- When the same stack trace surfaces twice in a session: stop guessing,
  look it up.
- After a hard-won fix: call `igris_error_lookup` with the canonical message
  AND a `solution` arg — the same handler upserts when `solution` is present,
  so the next agent doesn't relearn it.

### Example invocation

```jsonc
igris_error_lookup({
  message: "TypeError: Cannot read properties of undefined (reading 'rowid')",
  project: "igris-ai"
})
```

## 5. Registry (`igris_project_*`)

**Tools:** `igris_project_register`, `igris_project_list`,
`igris_project_status`, `igris_project_update`.

**What's there:** all registered Igris projects — slug, path, tech stack,
archetype, status, last session. Drives the affinity boosts in recall.

### When to call

- Before a cross-project recommendation: `igris_project_status` the target to
  verify tech stack and archetype match before suggesting reuse.
- When onboarding a new project: `igris_project_register` so its briefs and
  learnings can participate in cross-project recall and promotion.
- During `/portfolio` or `/projects` skill flows.

### Example invocation

```jsonc
igris_project_status({ slug: "fifty-flutter-kit" })
```

## 6. Subconscious (`igris_perception_*`)

**Tools:** `igris_perception_review_pending`, `igris_perception_get`,
`igris_perception_approve`, `igris_perception_reject`,
`igris_perception_dashboard`.

**What's there:** background-extracted perception records — pending-review
learnings the subconscious extractor surfaced from session events. Not yet
promoted to the conscious learnings channel.

### When to call

- During `/scan` or `/awaken`: surface pending perception items to the user
  for triage.
- Before storing a similar new learning manually: check if the subconscious
  already has a draft of it (avoid double-entry).
- After a long session: `igris_perception_approve` / `igris_perception_reject`
  to migrate candidates to the conscious channel.

### Example invocation

```jsonc
igris_perception_review_pending({ project: "igris-ai", limit: 10 })
```

## 7. Goals (`igris_goal_*`)

**Tools:** `igris_goal_create`, `igris_goal_list`, `igris_goal_update`,
`igris_goal_dashboard`.

**What's there:** medium-horizon project goals — what the project is trying
to become over weeks/months, distinct from per-brief tactical work.

### When to call

- During `/scan` for a project context: `igris_goal_list` to ground the
  current work in the broader trajectory.
- When the user proposes a new direction: check existing goals for
  alignment or contradiction before scoping a brief.
- Before writing a release announcement: `igris_goal_dashboard` to frame
  shipped work against stated direction.

### Example invocation

```jsonc
igris_goal_list({ project: "igris-ai", status: "active" })
```

## 8. Metrics (`igris_metrics_*`)

**Tools:** `igris_metrics_record`, `igris_metrics_query`,
`igris_metrics_dashboard`, `igris_metrics_velocity`.

**What's there:** time-series of agent invocations, token spend, brief
throughput, error rates. Source for agent activity dashboards.

### When to call

- During `/scan` or `/dashboard`: pull recent metric snapshots.
- When the user asks "is this getting faster/slower?": query velocity over
  the relevant window.
- Before refactoring a hot path: check the current cost so you can measure
  the win.

### Example invocation

```jsonc
igris_metrics_velocity({ project: "igris-ai", days: 30 })
igris_metrics_query({ project: "igris-ai", metric: "agent_duration_seconds", agent: "forger", days: 7 })
```

<!-- /SECTION: brain_stewardship -->
