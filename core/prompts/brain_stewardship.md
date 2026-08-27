# Brain Stewardship

You own the entire brain, not just the learnings table. The brain is your
working memory across sessions — every read surface below has a "when to call"
trigger, and you are responsible for reaching for it at the right moment.

A brain READ that is not triggered is invisible to the next session: a
correctly-stored memory that is never recalled does not change behavior.

> **Status (post-FR-187):** this file is NO LONGER loaded at boot — `core/os/memory.md` is the boot-tier Memory contract. `brain_stewardship.md` is retained as (1) the input to `scripts/validate_brain_stewardship_enums.sh` (a pre-commit gate) and (2) an enumeration surface tracked in MAINTAINING.md. Don't delete it expecting `memory.md` to cover it — they serve different roles.

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
`igris_memory_hybrid_search`, `igris_memory_get`, `igris_memory_update`,
`igris_memory_delete`, `igris_memory_dashboard`.

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

`/boot` already pulls relevant memories at session start, so the orchestrator's baseline context is covered. Use `igris_memory_recall` and `igris_memory_search` *in addition to* that automatic recall, on-demand:

- When the user asks about a topic you don't recognize from the loaded context.
- When you switch domains mid-session (e.g., from frontend work into a database migration).
- Before making a decision with likely historical precedent ("have we made a call on this before?").
- Before recommending a function/file/flag that a memory references — verify it still exists in the current code.

Avoid redundant recalls within the same session over the same topic — once you have the relevant memories in context, work from them.

**Category filter limitation (TD-093 follow-up):** `igris_memory_recall` does NOT currently accept a `category` parameter. To bias recall toward a specific category (e.g., `mistake`), include category-evocative keywords in the `context` query (e.g., `"... mistake regression bug"`). FTS5 ranking biases the match but does not strictly filter. If you need a hard filter, see TD-093.

### When to Hybrid-Search (`igris_memory_hybrid_search`)

Use `igris_memory_hybrid_search` for the highest-quality single-query recall:
it fuses BM25 (FTS5) and vector-KNN results via RRF, so a query matches on both
lexical keywords and semantic similarity. It excludes `pending_review` rows
(conscious channel only) and falls back to BM25-only when sqlite-vec / embedding
is unavailable — no caller handling needed. Input: `{ query, project?, limit? }`
(defaults: `limit` 10, `bm25_weight`/`vector_weight` 0.5/0.5, `rrf_k` 60); pass
`project` to scope, omit it to search everything. Prefer this over
`igris_memory_search` (BM25-only) when you want the best ranked recall and don't
need to tune weights.

The **`/search` skill is the interactive entrypoint** for this tool — it parses
`--project` / `--global` / `--limit`, renders the ranked `ID | Title | Snippet |
Score` table, and pulls a chosen learning into context via `igris_memory_get`
(`/search --pull <id>`). Reach for the raw tool in free-form reasoning; point the
operator at `/search` when they want to browse recall interactively.

### When to Update

Use `igris_memory_update` when an existing learning needs a title or content correction post-extraction (typo, wrong tag, sharper rationale). Pass the learning ID and at least one of the updatable fields: title, content, tags, category, scope, confidence. The handler bumps the row's update timestamp automatically and returns the list of fields actually changed.

Do NOT update to flip provenance, review status, or source extractor — provenance is permanent (FR-107 audit trail), review status is owned by the perception lifecycle (`igris_perception_approve` / `_reject`), and source extractor records who originally produced the row. If any of those is genuinely wrong, `igris_memory_delete` + `igris_memory_store` afresh — the audit history loss is the price of the rewrite.

### When to Delete

Use `igris_memory_delete` when a stored learning is provably wrong (the rule it states is false) or duplicates a higher-quality entry. Prefer `igris_memory_update` for fixable entries — deletion is hard and irreversible (no soft-delete column on `learnings` today; FR-116 may add one). The delete emits a `memory.deleted` bus event so future audit-log subscribers can record the action; pass an optional `reason` arg to make that audit trail readable.

### When to Inspect (Dashboard)

Use `igris_memory_dashboard` with `summary_only: true` during `/scan` and `/boot` to size the project's memory footprint without dumping content. Cross-reference `by_review_status.pending_review` against `igris_perception_dashboard` (TD-171 M3) to confirm the subconscious is healthy — large pending counts that aren't draining mean the approve loop is stalled. Default `days=30`; pass a smaller window when triaging "what landed today" and a larger one for quarterly health checks. The dashboard is unfiltered by review_status by design — you are sizing the full memory footprint, not just the conscious channel.

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

**Scope guidance.** Default `scope=local`. Promote to `global` only when the same lesson applies across project archetypes (bash quoting, secret handling, generic algorithmic patterns). Cross-project promotion happens later when the same memory is observed in 2+ projects — don't pre-promote out of optimism.

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

## 2. Knowledge Graph (`igris_graph_*`)

**Tools:** `igris_graph_node_create`, `igris_graph_node_get`,
`igris_edge_create`, `igris_graph_neighbors`, `igris_graph_path`,
`igris_graph_subgraph`, `igris_graph_search`, `igris_graph_dashboard`,
`igris_graph_brain`.

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
- **Seeding on a brief? Qualify the project.** A brief id is unique only
  WITHIN a project — `BR-001` names a different brief in each of 25 projects.
  Pass `node_project` / `from_project` + `to_project` / `seed_node_project`
  alongside the id. They qualify the SEED only and do NOT filter the result,
  so the traversal still legitimately reaches other projects through
  cross-project edges. Omit them when the id is unique brain-wide — the tool
  resolves it for you. An **ambiguous seed with no project is an ERROR** that
  names the id, the count and the candidate slugs: the tool refusing to fuse
  unrelated projects, not a failure to answer. Pass one of the listed slugs
  and re-run. Every response also carries `unresolved_hops` — non-zero means
  `entity_edges` (which has no project column) could not say which project
  some edges belonged to, so they were dropped rather than guessed; see
  `igris_graph_brain`'s `edge_resolution` for the same loss measured
  brain-wide.
- When the user asks "why did we change X to Y?" — `igris_graph_search` the
  concept node and walk `supersedes` edges.
- When stitching together a broader context for an architect prompt — the
  graph gives structured ancestry that recall does not.

### When to Register a Node

Use `igris_graph_node_create` to register a free-standing concept or decision node before linking it via `igris_edge_create`. Briefs / learnings / errors / sessions / goals are addressable by their existing IDs without explicit registration — only concept and decision nodes need this call. The handler is idempotent: re-creating an identical `(node_type, node_external_id)` pair returns the existing row's id with `created: false`. The original label is preserved on conflict; rename via delete-then-recreate (a node-update tool is a planned follow-up but is not yet registered — the validator drift gate enforces that intended-future tool names are not backticked as if they exist). Use the `properties.project` key to scope a node so `igris_graph_dashboard` project filtering can find it.

### When to Inspect a Single Node

Use `igris_graph_node_get` to inspect one node's metadata plus its in/out edge degrees before traversal. Cheaper than `igris_graph_neighbors` when you only need to confirm the node exists and gauge its connectedness; reach for `_neighbors` once you want the actual neighbour rows. Soft-deleted edges are excluded from the degree counts (parity with `igris_edge_list`). Errors with `Node not found` when the `(node_type, node_external_id)` pair does not match a registered row.

### When to Search

Use `igris_graph_search` to find concept or decision nodes by partial name when you only know a fragment of the label or external id. Substring (LIKE) match against `label` and `node_external_id`; SQL wildcards in user input are escaped, so pass plain text. Optional `node_type` filter narrows by type. Default limit 20, max 100. Score = fraction of the matched field the query covers (1.0 = exact match) — a deliberate v1 placeholder; FTS5 ranking is a follow-up. Use the score to disambiguate when multiple candidates are returned.

### When to Inspect (Dashboard)

Use `igris_graph_dashboard` with `summary_only: true` for a topology snapshot during `/scan` and `/boot` — counts only, no samples block, fast on large graphs. The full call surfaces `samples.top_god_nodes` (top 10 nodes by total in+out degree) which is the same data `igris_brief_graph_render` visualizes, in textual form. Reach for it before refactoring to spot god-nodes whose extraction would touch many edges. Project filter narrows `graph_nodes` via `properties.project`; edge totals stay unfiltered (edges have no project column — flagged for follow-up). Default `days=30` window for the `recent.*` block; totals always count the full table.

### When to view the whole brain

Use `igris_graph_brain` when the question spans **more than one project** — "what
does the whole brain look like?", "which projects are actually connected?",
"where does this knowledge cluster?" — or when you need one typed graph over
briefs, learnings, goals, errors and concept nodes in a single call. Every other
graph tool starts from a seed node or a single project; this one starts from
everything. Pass `project` to drill into that subgraph plus its one-hop boundary
nodes — same call, same response shape, no second query.

Two things to know before you read the output. First, nodes are keyed on the
triple (type, project, id), so two same-id briefs in different projects are two
separate nodes — `BR-001` exists in 25 projects and they are never fused.
Second, `entity_edges` has no project column, so an edge whose endpoints are
ambiguous is projected intra-project with declared multiplicity: read the
`edge_resolution` block for the counts, and filter to `resolution` values of
"unique" when you need a strict view. No body text is returned — reach for
`igris_graph_node_get` or `igris_brief_get` for one node's detail. A degraded
brain returns an empty graph, never an error.

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
  to_type: "brief", to_id: "FR-076", to_project: "igris-ai",
  edge_type: "related_to"
})
// BR-083: a brief id is unique only WITHIN a project. Qualify any endpoint
// whose id exists in more than one project with `from_project` / `to_project`
// — the call is REFUSED with the candidate list rather than storing an edge
// that resolves to whichever project matched first. An id that exists in
// exactly one project is resolved for you; a concept has no project and
// stores NULL.

// Topology snapshot before a refactor.
igris_graph_dashboard({ project: "igris-ai", summary_only: true })

// The whole brain in one call, then drill into one project.
igris_graph_brain({})
igris_graph_brain({ project: "igris-ai" })

// Find a node by partial label.
igris_graph_search({ query: "memory_agency rename", limit: 5 })
igris_graph_neighbors({ node_type: "concept", node_id: "concept:142", edge_types: ["supersedes", "derived_from"], depth: 2 })
```

## 3. Briefs (`igris_brief_*`)

**Tools:** `igris_brief_create`, `igris_brief_get`, `igris_brief_list`,
`igris_brief_update`, `igris_brief_similar`, `igris_brief_sync`,
`igris_brief_dashboard`, `igris_brief_velocity`, `igris_brief_claim`,
`igris_brief_release`.

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
- **Claiming a brief for a hunt is automatic via `/hunt`;** `igris_brief_claim`
  / `igris_brief_release` are the FR-127 atomic claim/release gate that stops
  two instances hunting the same brief — not called by hand. `/hunt` claims
  before INIT (a second instance's claim affects 0 rows and hard-stops);
  `/rest` and brief-completion release.

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
- During `/scan` or after a long debug session: `igris_error_dashboard` to
  spot recurring errors that warrant a `/hunt`. The top-N recurring rows
  without a recorded solution are the next mender targets — pair the
  `summary_only: true` mode with `project` filter for a focused triage view.

### Example invocation

```jsonc
igris_error_lookup({
  message: "TypeError: Cannot read properties of undefined (reading 'rowid')",
  project: "igris-ai"
})
igris_error_dashboard({ project: "igris-ai", summary_only: true })
```

## 5. Project registry (`igris_project_*`)

> **Naming note:** this is the **project** registry (registered Igris
> projects). Do not confuse it with the **reusable-assets catalog** in §5b
> (`igris_catalog_*`), which is a different store (cataloged templates/modules,
> the "lego" store).

**Primary tools:** `igris_project_register`, `igris_project_list`,
`igris_project_update`, `igris_project_dashboard`.

**What's there:** all registered Igris projects — slug, path, tech stack,
archetype, status, last session. Drives the affinity boosts in recall.

### When to call

- Before a cross-project recommendation: `igris_project_dashboard({slug})` the
  target to verify tech stack, archetype, and recent project context before
  suggesting reuse (replaces the older `igris_project_status` pattern).
- When onboarding a new project: `igris_project_register` so its briefs and
  learnings can participate in cross-project recall and promotion.
- After registration, to flip `status` (e.g., archive a project) or correct
  `tech_stack` / `archetype`: `igris_project_update`. Partial UPDATE — only
  the fields you pass are written. For brand-new projects use
  `igris_project_register`, not `_update`.
- For a unified per-project / cross-project view: `igris_project_dashboard`.
  Set `slug` for one project's detail (replaces the older `_status` pattern);
  omit `slug` and pass `status` / `archetype` / `tech_stack` filters for
  narrowed cross-project listings (replaces the older `_list` pattern).
  `summary_only: true` for counts-only during `/scan`.
- During the `/ops` skill flow.

### Example invocation

```jsonc
igris_project_dashboard({ slug: "fifty_eco_system" })
igris_project_update({ slug: "old-prototype", status: "archived" })
igris_project_dashboard({ archetype: "ai-agent-system", summary_only: true })
```

## 5b. Reusable-assets catalog (`igris_catalog_*`)

> **Distinct from §5.** This is the **reusable-assets catalog** (the "lego"
> store) — cataloged templates and modules, NOT the project registry. The tool
> prefix is `igris_catalog_*`, not `igris_project_*`.

**Tools:** `igris_catalog_search`, `igris_catalog_get`, `igris_catalog_list`
(read), `igris_catalog_add`, `igris_catalog_update`, `igris_catalog_remove`
(write — driven by `/harvest`, not free-form reasoning).

**What's there:** reference rows for reusable assets — templates (full project
scaffolds) and modules (standalone components, incl. pub.dev/npm packages and
SDKs). Each row records *what it is* (name/type/description), *where it lives*
(`github_repo`/`github_path` or `source`/`source_ref`), *when to reach for it*
(`when_to_use`/`tags`), and *how to integrate* (`install_command`,
`rebrand_checklist`). The shared mechanics are in
`~/.igris/core/docs/catalog-recipe.md`.

### When to call

- **Reuse before rewrite — before building something new**, search the catalog:
  `igris_catalog_search({ query: "<what you're about to build>" })`. If a lego
  block fits, reach for it (the `/reuse` skill drives scaffold-from-template and
  add-a-package). This is the live obligation behind the conduct "Reuse before
  rewrite" rule.
- Before cataloging a module during `/harvest` Phase 3: `igris_catalog_search`
  to dedup against the existing catalog (offer skip/update on a strong match).
- To inspect a chosen asset's full detail (incl. `rebrand_checklist`):
  `igris_catalog_get({ id })`. To browse the shelf: `igris_catalog_list`.

### Example invocation

```jsonc
igris_catalog_search({ query: "flutter branded buttons", type: "module" })
igris_catalog_list({ type: "template", archetype: "enterprise-mvvm-mobile" })
igris_catalog_get({ id: "tmpl-enterprise-mobile" })
```

## 6. Subconscious (`igris_perception_*`)

**Tools:** `igris_perception_review_pending`, `igris_perception_get`,
`igris_perception_approve`, `igris_perception_reject`,
`igris_perception_dashboard`.

**What's there:** background-extracted perception records — pending-review
learnings the subconscious extractor surfaced from session events. Not yet
promoted to the conscious learnings channel.

### When to call

- During `/scan` or `/boot`: surface pending perception items to the user
  for triage.
- Before storing a similar new learning manually: check if the subconscious
  already has a draft of it (avoid double-entry).
- After a long session: `igris_perception_approve` / `igris_perception_reject`
  to migrate candidates to the conscious channel.
- Before approve/reject when `igris_perception_review_pending` shows
  truncated content: `igris_perception_get` with the candidate's
  `learning_id` to inspect the full row (title, content, tags, confidence,
  source_extractor, dedup metadata). Errors on approved/non-existent rows
  by design — perception scope ends at promotion.
- During `/scan` to spot extractor health issues: `igris_perception_dashboard`
  reports inbox size (`pending`), recent approve/reject volume, run outcomes
  (`succeeded`/`failed`/`skipped` from `event_log`) and dedup rediscoveries.
  A failed-run spike or a dedup-rate drop is the early-warning signal.
  Pair with `igris_memory_dashboard` for the post-promotion view.

### Example invocation

```jsonc
igris_perception_review_pending({ project: "igris-ai", limit: 10 })
igris_perception_get({ learning_id: 4321 })
igris_perception_dashboard({ project: "igris-ai", summary_only: true })
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

### When to Inspect (Dashboard)

Use `igris_goal_dashboard` before a release announcement or quarterly
review to frame shipped briefs against stated goals. The canonical
`_dashboard` shape returns `totals.by_status` (active / achieved /
abandoned / deferred), `recent.upcoming_deadlines` (active goals with
deadlines in the next 30 days, with serving-brief and completed-brief
counts so you can see "how close is this one to shipping?"), and
`samples.stalled_goals` — active goals untouched for 30+ days. Stalled
goals are the candidates for revisit / abandon / re-scope. Pair with
`igris_goal_progress` for completion math on a specific goal. Pass
`summary_only: true` during `/scan` to drop the samples block when you
just need the headline counts.

### Example invocation

```jsonc
igris_goal_list({ project: "igris-ai", status: "active" })
igris_goal_dashboard({ project: "igris-ai" })
```

## 8. Hunt cost record (`igris_agent_event`, `hunt_runs`)

**Tools:** `igris_agent_event` (write). Read with `igris kpi` (the seven OS
KPIs, computed on read; `--sql` prints the queries) or the `hunt_runs` view
with `sqlite3`; the ceremony record is `ceremony_events` / `ceremony_runs`,
written by `igris ceremony start|stop` from the four ceremony skills
(FR-268). The former metrics tools (record / query / velocity / dashboard)
are retired; this record replaced them (FR-267).

**What's there:** one row per agent invocation — `project`, `brief_id`,
`agent`, `phase`, `round`, `model_requested` / `model_resolved`,
`event_type` (`start` / `stop` / `error` / `retry`), `duration_ms`,
tokens. The brain stamps every timestamp, computes `duration_ms` from
its own clock when a `stop`/`error` pairs with the open `start`, and
assigns `round` — a resumed, re-prompted or re-run agent is a NEW
invocation with its own row. You never pass duration or round (the
schema rejects them). Tokens are recorded when the harness reports them
and are NULL — never 0 — when it does not. Durable: no purge, no TTL;
the table syncs to the remote brain.

### When to call

- Before and after every agent you delegate to during `/hunt`:
  `igris_agent_event` with `instance_id`, `agent`, `event_type` and
  `model_requested` (the model you chose, or `inherit:<your own model
  id>`) — all four are required; add `model_resolved` and token counts
  on `stop` only when the harness reports them. A role named in a
  brief's Agent Log with no recorded event is refused at the closing
  commit (`IGRIS_BYPASS_EVENT_GATE=1`, one-shot, is the only way past
  it).
- When the user asks "how long did brief X take, and where did it go?",
  "is this model slower?", or "where is the pain point?": query
  `hunt_runs`. Per-invocation grain; per-agent, per-phase and per-hunt
  totals are GROUP BYs, never stored.
- During `/ops`: the per-agent / per-model view (the `/ops` skill
  carries the query).

### Example invocation

```jsonc
igris_agent_event({ instance_id: "<id>", agent: "forger", event_type: "start", brief_id: "FR-267", phase: "BUILDING", model_requested: "inherit:claude-fable-5" })
```

```sql
-- one brief, per agent and per model (sqlite3 ~/.igris/memory/knowledge.db)
SELECT brief_id, size, agent, model_requested, COUNT(*) AS rounds,
       ROUND(SUM(duration_ms)/60000.0,1) AS minutes
FROM hunt_runs WHERE project='igris-ai' AND brief_id='FR-267'
GROUP BY brief_id, size, agent, model_requested ORDER BY MIN(ended_at);
```

<!-- /SECTION: brain_stewardship -->
