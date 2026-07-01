---
layer: capability
tier: boot
scope: orchestrator
summary: The Memory capability — the surfaces you can store into and recall from, and when to reach for each. The obligations live in conduct.
---

# Memory

Memory is your working experience across sessions. It is a store of structured-record kinds — learnings, the knowledge graph, briefs, errors, the project registry, goals, metrics, and subconscious candidates — each with its own tools and its own "when to use it." The **obligations** (what you *must* recall, store, dup-check, look up) live in `conduct`; this is the capability.

Every read surface below has a "when to call" trigger, and you are responsible for reaching for it at the right moment. **A read that is never triggered is invisible:** a correctly-stored memory that is never recalled does not change behavior.

Reach Memory only through the tools named here.

## Staleness — when to pull, when to push

Recall and storage normally just work against your local store. Two behavioral moments matter:

- **A recall comes back stale or empty for something you know exists?** Another instance wrote it and it hasn't synced to you yet. Pull the latest (`/sync data`) or wait for the next automatic sync from the machine that wrote it.
- **About to `/rest` after work another instance needs right away?** Push first (`/sync data`) so it lands immediately, rather than waiting on the automatic end-of-session sync.

That is the whole of the sync contract you need at the keyboard: pull when a recall looks behind, push before `/rest` when someone's waiting. The routing underneath is not your concern.

## 1. Learnings (`igris_memory_*`)

**Tools:** `igris_memory_store`, `igris_memory_recall`, `igris_memory_search`, `igris_memory_get`, `igris_memory_update`, `igris_memory_delete`, `igris_memory_dashboard`.

**What's there:** project-local and global lessons — patterns, decisions, discoveries, mistakes, optimizations. Hybrid keyword + semantic search with project and tech-stack/archetype affinity boosts. Pending-review rows are gated.

### When to Store

Memory holds **experiential lessons** — the non-obvious rationale, mistakes, patterns, and decisions you accumulate by working. Store one when you discover something that:

- Won't be obvious to a future actor reading the code cold (a non-trivial rationale, a counter-intuitive constraint, a surprising failure mode).
- Will plausibly apply again — later in this project or across projects.
- Is the *lesson* extracted from a fix, not the fix itself.

Good triggers:
- Architectural decision with a load-bearing rationale ("we picked X over Y because Z").
- A bug whose root cause was non-obvious — capture the misleading symptom and the actual cause.
- A reusable pattern that worked well and would be reached for again.
- A performance win whose mechanism is worth remembering.
- A user correction that overrides a default behavior or assumption.

**After you store, link it.** If the new lesson supersedes, derives from, or relates to existing memory, draw the edge with `igris_edge_create` — see *Knowledge Graph → When to Create an Edge*. The graph only grows when you link.

### Memory holds experience — route other kinds elsewhere

Memory is for the *lesson*, not for the other kinds of knowledge. A fact lives in exactly one store, the one matching its kind: a curated **standard** belongs in a project-context doc (don't store it here — **promote** it via `/promote`), a **code fact** in the code, **history** in git. Routing across stores — what belongs in memory vs a doc vs code vs git — lives in `knowledge-map`.

When in doubt, ask: *"Will a future actor reading the code learn this on their own?"* If yes, skip the store. (In-flight work — conversation state, current task progress — goes to plans and tasks, never memory.)

### When to Recall

`/boot` already pulls relevant memories at session start, so the orchestrator's baseline context is covered. Use `igris_memory_recall` and `igris_memory_search` *in addition to* that automatic recall, on-demand:

- When the user asks about a topic you don't recognize from the loaded context.
- When you switch domains mid-session (e.g., from frontend work into a database migration).
- Before making a decision with likely historical precedent ("have we made a call on this before?").
- Before recommending a function/file/flag that a memory references — verify it still exists in the current code.

Avoid redundant recalls within the same session over the same topic — once you have the relevant memories in context, work from them.

**Category filter.** `igris_memory_recall` accepts an optional `category` param (`pattern`, `decision`, `discovery`, `mistake`, `optimization`) that **hard-filters** results to that single category across every fetch path — a higher-ranked row of another category is excluded, not just reordered. Pass it when you want only one kind of lesson (e.g., `category: "mistake"` to surface only prior bugs/regressions). When `category` is omitted, all categories are searched and ranking is unchanged. As a complementary technique when you pass no `category`, you can still lean recall toward a kind of lesson by including category-evocative keywords in the `context` query (e.g., `"... mistake regression bug"`) — that biases the match but does not filter.

### When to Update

Use `igris_memory_update` when an existing learning needs a title or content correction post-extraction (typo, wrong tag, sharper rationale). Pass the learning ID and at least one updatable field: title, content, tags, category, scope, confidence. The handler bumps the row's update timestamp and returns the list of fields actually changed.

Do NOT update to flip provenance, review status, or source extractor — provenance is permanent (the audit trail), review status is owned by the perception lifecycle (`igris_perception_approve` / `_reject`), and source extractor records who originally produced the row. If any of those is genuinely wrong, `igris_memory_delete` + `igris_memory_store` afresh — the audit-history loss is the price of the rewrite.

### When to Delete

Use `igris_memory_delete` when a stored learning is provably wrong (the rule it states is false) or duplicates a higher-quality entry. Prefer `igris_memory_update` for fixable entries — deletion is irreversible. Pass an optional `reason` arg to make the audit trail readable.

### When to Inspect (Dashboard)

Use `igris_memory_dashboard` with `summary_only: true` during `/scan` and `/boot` to size the project's memory footprint without dumping content. Cross-reference `by_review_status.pending_review` against `igris_perception_dashboard` to confirm the subconscious is healthy — large pending counts that aren't draining mean the approve loop is stalled. Pass a smaller window when triaging "what landed today" and a larger one for quarterly health checks. The dashboard is unfiltered by review_status by design — you are sizing the full footprint, not just the conscious channel.

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

**Provenance defaults.** If you don't specify `provenance`, it defaults to `observed`. Use `human_asserted` only when the user explicitly told you the rule; `inferred` when you derived it from code without confirmation; `synthesized` when you combined multiple sources; `ambiguous` only when you genuinely can't tell.

**Scope guidance.** Default `scope=local`. Promote to `global` only when the same lesson applies across project archetypes (bash quoting, secret handling, generic algorithmic patterns). Cross-project promotion happens later when the same memory is observed in 2+ projects — don't pre-promote out of optimism.

**A decision that hardens promotes.** A `category=decision` entry is the experiential record. When it settles into a standing architectural choice the project should treat as authoritative, **promote** it to the project's decision doc — don't keep two copies. The doc owns the standard; memory keeps the lineage.

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
  context: "memory capability contract stewardship",
  limit: 5
})

// Recall ONLY prior mistakes on a topic (hard category filter)
igris_memory_recall({
  project: "igris-ai",
  context: "recall category filter",
  category: "mistake",
  limit: 5
})

// Store a non-obvious lesson
igris_memory_store({
  project: "igris-ai",
  category: "mistake",
  title: "Contract named its implementation — staleness on swap",
  content: "A boot module hardcoded the storage mechanism (DB internals + a tool count). When the mechanism was swapped, the prose went stale and the model read wrong wiring. Lesson: a contract names only the surfaces and tools, never the implementation — so the mechanism can be swapped without touching what the model reads.",
  scope: "global",
  provenance: "observed"
})
```

## 2. Knowledge Graph (`igris_graph_*`)

**Tools:** `igris_graph_node_create`, `igris_graph_node_get`, `igris_edge_create`, `igris_graph_neighbors`, `igris_graph_path`, `igris_graph_subgraph`, `igris_graph_search`, `igris_graph_dashboard`.

**What's there:** typed nodes and edges (relates-to, supersedes, blocks, derived-from). The graph captures relationships a flat learnings table cannot: chains of supersession, dependency trees between briefs, lineage of decisions. Most nodes are **references** to rows in other stores — a brief, learning, goal, error, or session, addressed by `(type, id)`. The only nodes stored IN the graph table are free-standing **`concept`** nodes (an abstract idea with no home elsewhere).

Brief / learning / error / session / goal nodes live in their own surfaces and are referenced by their `(type, id)` directly — never duplicated into the graph. Only a genuinely free-standing **`concept`** node (no backing row anywhere) is registered via `igris_graph_node_create` before linking. **A decision is NOT a free-standing node — it is a `category=decision` learning** (its home is the learnings table); reference it as `(type=learning, id)` and draw its lineage edges (`supersedes`, `derived_from`) between those learning refs. Registering a separate `decision` node would split one fact across two homes.

### When to call

- Before proposing a refactor: `igris_graph_neighbors` from the affected module/concept node (depth: 2, direction: 'in') to surface dependents and prior decisions. Use `igris_graph_path` for shortest-path between two known nodes and `igris_graph_subgraph` for the connected component.
- When the user asks "why did we change X to Y?" — `igris_graph_search` the concept node and walk `supersedes` edges.
- When stitching together a broader context for an architect prompt — the graph gives structured ancestry that recall does not.

### When to Register a Node

Use `igris_graph_node_create` to register a free-standing **`concept`** node before linking it via `igris_edge_create`. Briefs / learnings / errors / sessions / goals (including `category=decision` learnings) are addressable by their existing IDs without registration — only `concept` nodes need this call. The handler is idempotent: re-creating an identical `(node_type, node_external_id)` pair returns the existing row with `created: false`. The original label is preserved on conflict; rename via delete-then-recreate. Use `properties.project` to scope a node so `igris_graph_dashboard` project filtering can find it.

### When to Create an Edge

The knowledge graph is **yours to grow.** Briefs auto-link to each other (the briefs component infers `parent_of` / `blocks` / `depends_on` from brief metadata), but **learnings, decisions, and concepts only enter the graph when you link them.** After storing an experiential memory, ask whether it relates to existing memory — and if so, draw the edge with `igris_edge_create`:

- A decision that **supersedes** an earlier one → `supersedes` between the two `(type=learning, id)` refs.
- A lesson **derived from** a brief or another learning → `derived_from`.
- A lesson that **relates to** another (same subsystem / same failure mode) → `related_to`.

An unlinked learning is invisible to `igris_graph_neighbors` — don't leave the semantic graph to briefs alone. (Honor-system today; a forcing mechanism is tracked in FR-210, edge inference in FR-211.)

### When to Inspect a Single Node

Use `igris_graph_node_get` to inspect one node's metadata plus its in/out edge degrees before traversal. Cheaper than `igris_graph_neighbors` when you only need to confirm the node exists and gauge its connectedness; reach for `_neighbors` once you want the actual neighbour rows.

### When to Search

Use `igris_graph_search` to find `concept` nodes by partial name when you only know a fragment of the label or external id. Substring match against `label` and `node_external_id`; pass plain text. Optional `node_type` filter narrows by type. Use the returned score to disambiguate when multiple candidates come back.

### When to Inspect (Dashboard)

Use `igris_graph_dashboard` with `summary_only: true` for a topology snapshot during `/scan` and `/boot` — counts only, fast on large graphs. The full call surfaces the top nodes by total degree — reach for it before refactoring to spot god-nodes whose extraction would touch many edges.

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
igris_graph_search({ query: "memory capability rename", limit: 5 })
igris_graph_neighbors({ node_type: "concept", node_id: "concept:142", edge_types: ["supersedes", "derived_from"], depth: 2 })
```

## 3. Briefs (`igris_brief_*`)

**Tools:** `igris_brief_create`, `igris_brief_get`, `igris_brief_list`, `igris_brief_update`, `igris_brief_similar`, `igris_brief_sync`, `igris_brief_dashboard`, `igris_brief_velocity`, `igris_brief_claim`, `igris_brief_release`.

Archival is a status transition: call `igris_brief_update` with `status: 'Archived'` rather than reaching for a separate archive tool. Hybrid search lives on `igris_brief_similar` — there is no separate `_search` tool.

**What's there:** every BR/FR/TD/MG/PR/RE/IN brief — current state, history, phase, agent log, similarity vectors. The source of truth (filesystem fallback at `~/.igris/projects/{project}/briefs/`).

### When to call

- **Before any new brief:** `igris_brief_similar` with the proposed title + problem statement, threshold 0.85. If a near-duplicate exists, surface it before creating noise.
- **Before architect planning:** `igris_brief_similar` to pull prior briefs in the same domain, so the plan inherits known constraints.
- **For dashboards / standup:** `igris_brief_dashboard` with `summary_only: true` (NEVER `limit: 0` — that dumps ~13k tokens).
- **Before a release cut:** `igris_brief_velocity` for cadence sanity.
- **Claiming a brief for a hunt is automatic via `/hunt`;** `igris_brief_claim` / `igris_brief_release` are the atomic claim/release gate that stops two instances hunting the same brief — not called by hand. `/hunt` claims before INIT (a second instance's claim affects 0 rows and hard-stops); `/rest` and brief-completion release.

### Example invocation

```jsonc
igris_brief_similar({
  query: "reshape brain stewardship into the Memory capability",
  project: "igris-ai",
  threshold: 0.85,
  limit: 5
})
igris_brief_dashboard({ project: "igris-ai", summary_only: true })
```

## 4. Errors (`igris_error_*`)

**Tools:** `igris_error_lookup`, `igris_error_dashboard`.

**What's there:** error fingerprints (file-path/line-number-agnostic) mapped to known root causes and solutions. Built up over time from mender's diagnoses.

### When to call

- **mender's first action** when receiving any error report: lookup before parsing. A fingerprint match short-circuits the entire diagnosis loop.
- When the same stack trace surfaces twice in a session: stop guessing, look it up.
- After a hard-won fix: call `igris_error_lookup` with the canonical message AND a `solution` arg — the same handler upserts when `solution` is present, so the next agent doesn't relearn it.
- During `/scan` or after a long debug session: `igris_error_dashboard` to spot recurring errors that warrant a `/hunt`. The top-N recurring rows without a recorded solution are the next mender targets — pair `summary_only: true` with a `project` filter for a focused triage view.

### Example invocation

```jsonc
igris_error_lookup({
  message: "TypeError: Cannot read properties of undefined (reading 'rowid')",
  project: "igris-ai"
})
igris_error_dashboard({ project: "igris-ai", summary_only: true })
```

## 5. Project registry (`igris_project_*`)

> **Naming note:** the **project** registry (registered Igris projects). Not the **reusable-assets catalog** in §5b (`igris_catalog_*`) — a different store.

**Tools:** `igris_project_register`, `igris_project_list`, `igris_project_status`, `igris_project_update`, `igris_project_dashboard`.

**What's there:** all registered Igris projects — slug, path, tech stack, archetype, status, last session. Drives the affinity boosts in recall.

### When to call

- Before a cross-project recommendation: `igris_project_status` the target to verify tech stack and archetype match before suggesting reuse. (For new code prefer `igris_project_dashboard({ slug })` — same detail PLUS a `recent` block.)
- When onboarding a new project: `igris_project_register` so its briefs and learnings can participate in cross-project recall and promotion.
- After registration, to flip `status` (e.g., archive a project) or correct `tech_stack` / `archetype`: `igris_project_update` (partial UPDATE — only the fields you pass are written). For brand-new projects use `igris_project_register`, not `_update`.
- For a unified per-project / cross-project view: `igris_project_dashboard`. Set `slug` for one project's detail; omit `slug` and pass `status` / `archetype` / `tech_stack` filters for narrowed cross-project listings. `summary_only: true` for counts-only during `/scan`.
- During the `/ops` skill flow.

### Example invocation

```jsonc
igris_project_status({ slug: "fifty-flutter-kit" })
igris_project_update({ slug: "old-prototype", status: "archived" })
igris_project_dashboard({ archetype: "ai-agent-system", summary_only: true })
```

## 5b. Reusable-assets catalog (`igris_catalog_*`)

> **Distinct from §5.** The reusable-assets catalog (the "lego" store) — cataloged templates/modules, NOT the project registry. Tool prefix `igris_catalog_*`, not `igris_project_*`.

**Tools:** `igris_catalog_search`, `igris_catalog_get`, `igris_catalog_list` (read); `igris_catalog_add`, `igris_catalog_update`, `igris_catalog_remove` (write — driven by `/harvest`).

**What's there:** reference rows for reusable assets (templates, modules, pub.dev/npm packages) — what it is, where it lives, when to reach for it, how to integrate. **Reuse before rewrite** (`conduct`): search it before building something new and reach for a block via `/reuse`; `/harvest` seeds it. Mechanics: `core/docs/catalog-recipe.md`.

## 6. Cognition — inferred memory (`igris_perception_*`, `igris_suggestion_*`)

**The cognition pointer (FR-118):** Some memory is *inferred* — the **cognition** subsystem reads brain state and proposes candidates for review. Its instances are LLM extractors: **perception** observes session transcripts → pending `learnings`; **subconscious** observes the brain digest → `suggestions`. You review what they queue (approve/reject perception candidates; act-on/dismiss/apply suggestions). The instances are named by ROLE here; the engine + harness backend are the swappable impl, and new instances are added by dropping a self-describing extractor file (the registry is OPEN). The subconscious's run lifecycle is observable via `igris_event_log component='cognition.subconscious'`.

**Tools:** `igris_perception_review_pending`, `igris_perception_get`, `igris_perception_approve`, `igris_perception_reject`, `igris_perception_dashboard` (perception channel); `igris_suggestion_list`, `igris_suggestion_dismiss`, `igris_suggestion_acted`, `igris_suggestion_apply_action`, `igris_subconscious_run` (subconscious channel — gated behind `subconscious.enabled`).

**What's there:** background-extracted perception records — pending-review learnings the perception extractor surfaced from session events, not yet promoted to the conscious learnings channel — plus open-typed `suggestions` the subconscious extractor queues from the brain digest.

### When to call

- During `/scan` or `/boot`: surface pending perception items to the user for triage.
- Before storing a similar new learning manually: check if the subconscious already has a draft of it (avoid double-entry).
- After a long session: `igris_perception_approve` / `igris_perception_reject` to migrate candidates to the conscious channel.
- Before approve/reject when `igris_perception_review_pending` shows truncated content: `igris_perception_get` with the candidate's `learning_id` to inspect the full row.
- During `/scan` to spot extractor health: `igris_perception_dashboard` reports inbox size (`pending`), recent approve/reject volume, run outcomes, and dedup rediscoveries. A failed-run spike or a dedup-rate drop is the early-warning signal. Pair with `igris_memory_dashboard` for the post-promotion view.

### Example invocation

```jsonc
igris_perception_review_pending({ project: "igris-ai", limit: 10 })
igris_perception_get({ learning_id: 4321 })
igris_perception_dashboard({ project: "igris-ai", summary_only: true })
```

## 7. Goals (`igris_goal_*`)

**Tools:** `igris_goal_create`, `igris_goal_list`, `igris_goal_update`, `igris_goal_dashboard`.

**What's there:** medium-horizon project goals — what the project is trying to become over weeks/months, distinct from per-brief tactical work.

### When to call

- During `/scan` for a project context: `igris_goal_list` to ground the current work in the broader trajectory.
- When the user proposes a new direction: check existing goals for alignment or contradiction before scoping a brief.
- Before writing a release announcement: `igris_goal_dashboard` to frame shipped work against stated direction. It returns status counts, upcoming deadlines (with serving-brief and completed-brief counts), and stalled goals (active, untouched 30+ days — the candidates for revisit / abandon / re-scope). Pass `summary_only: true` during `/scan` for headline counts only.

### Example invocation

```jsonc
igris_goal_list({ project: "igris-ai", status: "active" })
igris_goal_dashboard({ project: "igris-ai" })
```

## 8. Metrics (`igris_metrics_*`)

**Tools:** `igris_metrics_record`, `igris_metrics_query`, `igris_metrics_dashboard`, `igris_metrics_velocity`.

**What's there:** time-series of agent invocations, token spend, brief throughput, error rates. The source for agent activity dashboards.

### When to call

- During `/scan` or `/ops`: pull recent metric snapshots.
- When the user asks "is this getting faster/slower?": query velocity over the relevant window.
- Before refactoring a hot path: check the current cost so you can measure the win.
- For a one-shot agent-utilization view: `igris_metrics_dashboard` returns per-agent invocations / success-rate / avg-duration / retries, per-action and per-result breakdowns, recent invocations with a week-over-week delta, and the longest-running invocations. Pair with `igris_brief_velocity` for completion-rate context. Optional `agent` filter scopes everything to one agent; `summary_only: true` drops the samples block.

### Example invocation

```jsonc
igris_metrics_velocity({ project: "igris-ai", days: 30 })
igris_metrics_dashboard({ project: "igris-ai", agent: "forger" })
```
