/**
 * FR-238 — the typed browser-side client for the dashboard API.
 *
 * MIRROR CONTRACT: the interfaces below mirror the `FR-238` block at the end of
 * `cli/src/types.ts`. An endpoint path or payload-field rename MUST sweep
 * `routes.ts`, `types.ts`, THIS FILE, the tests, and `docs/dashboard.md` in the
 * same commit — FR-239/240/241 all extend this surface, so it drifts fast.
 * Pinned by a MAINTAINING row.
 *
 * All requests are SAME-ORIGIN and relative. There is no base URL, no
 * configurable host, and no absolute URL anywhere in this file — that is what
 * makes AC #4 ("no network fetch at runtime") mechanically greppable in the
 * built bundle.
 */

export interface DashboardDegraded {
  reason: string;
}

/** Mirrors `HealthPayload` (cli/src/types.ts). */
export interface HealthPayload {
  ok: boolean;
  cli_version: string;
  brain: { present: boolean; path: string };
  bridge: { available: boolean; reason: string | null };
  /**
   * FR-241 — the WRITE surface. Distinct from `bridge`: that one reports the
   * pure READ modules, this one reports the engine artifact plus a brain on
   * disk, and they can disagree.
   *
   * The AC is *disabled, not broken*: when `available` is false the shell hides
   * the triage affordances rather than offering buttons that will fail.
   * `state` is the LAZY-BOOT fact — `available: true` with
   * `state: "not-booted"` is the normal state of a browsing session, and it is
   * what proves the read tier never opened the write door.
   */
  write: {
    available: boolean;
    reason: string | null;
    state: string;
    actions: string[];
  };
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** Mirrors `DashboardProject`. */
export interface DashboardProject {
  slug: string;
  name: string;
  path: string;
  status: string;
  last_session_at: string;
}

/** Mirrors `ProjectsPayload`. */
export interface ProjectsPayload {
  projects: DashboardProject[];
  /** Slug to select on first load (server-resolved; see cli/src/types.ts). */
  default_project: string | null;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** Mirrors `AssessBriefs`. */
export interface BriefCounts {
  total: number;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
}

/** Mirrors `SummaryPayload`. */
export interface SummaryPayload {
  /** `null` = the project predicate was dropped: every row, not a degradation. */
  project: string | null;
  briefs: BriefCounts;
  instances: { active: number };
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** Mirrors `BrainGraphStatsPayload`. `nodes`/`edges` are stripped server-side (R8). */
export interface GraphStatsPayload {
  project: string | null;
  stats: {
    node_count: number;
    edge_count: number;
    by_node_type: Record<string, number>;
    by_edge_type: Record<string, number>;
    project_count: number;
    boundary_node_count: number;
  } | null;
  edge_resolution: Record<string, unknown> | null;
  truncated: boolean;
  truncation_reason: string | null;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

// ---------------------------------------------------------------------------
// FR-239 — `/api/graph`. The node/edge arrays `/api/graph/stats` strips.
//
// These mirror `BrainGraphNodePayload` / `BrainGraphEdgePayload` in
// `cli/src/types.ts`, which in turn mirror `BrainGraphNode` (whole-graph.ts:117)
// and `BrainGraphEdge` (whole-graph.ts:142). MAINTAINING row 105 names THIS FILE
// as a consumer: a node-field rename now sweeps four files, not three.
// ---------------------------------------------------------------------------

/** Mirrors `BrainGraphNodePayload`. */
export interface GraphNode {
  /** Composite key `type|project|id` — the identity used everywhere. */
  key: string;
  type: string;
  id: string;
  project: string | null;
  label: string;
  attrs: Record<string, unknown>;
  degree: number;
  /** Pulled in by adjacency during a project drill-down (D6). */
  boundary?: true;
  /** An edge endpoint with no backing row anywhere. */
  phantom?: true;
}

/** Mirrors `BrainGraphEdgePayload`. */
export interface GraphEdge {
  id: string;
  source_edge_id: number;
  from: string;
  to: string;
  type: string;
  confidence: number;
  provenance: string;
  resolution: "unique" | "replicated";
}

/**
 * Mirrors `GraphQueryTwin` — dataviz exemption 04.
 *
 * Rendered VERBATIM. The browser must never compose or amend these strings:
 * the whole point of the server composing them is that the twin states what
 * produced the node set rather than what the client received.
 */
export interface GraphQueryTwin {
  surface: string;
  query: string[];
  as_of: string;
  scale: string;
}

/** Mirrors `BrainGraphPayload`. */
export interface GraphPayload {
  project: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    node_count: number;
    edge_count: number;
    by_node_type: Record<string, number>;
    by_edge_type: Record<string, number>;
    project_count: number;
    boundary_node_count: number;
  } | null;
  truncated: boolean;
  truncation_reason: string | null;
  query: GraphQueryTwin;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

// ---------------------------------------------------------------------------
// FR-240 — the four layer views: nine endpoints, ten payloads.
//
// These mirror the `FR-240` block in `cli/src/types.ts`, which in turn mirrors
// the brain-side pure readers (`briefs-read.ts`, `memory-read.ts`,
// `goals/read.ts`). MAINTAINING row 108 names this file: an endpoint path or a
// payload-field rename sweeps `routes.ts` -> `cli/src/types.ts` -> THIS FILE ->
// the tests -> `docs/dashboard.md` in ONE commit.
//
// TWO INVARIANTS WORTH RESTATING HERE, because this is the file a UI author
// reads:
//   - **No list payload carries body content** (D7). `content` exists on the
//     three DETAIL payloads and nowhere else. A list of 615 briefs with their
//     bodies is the superlinear payload term FR-237's "returns NO body content"
//     rule exists to remove; do not add one for convenience.
//   - **`params` is not `degraded`.** `params` means "your REQUEST was
//     adjusted" (a clamped limit, a dropped filter); `degraded` means "the DATA
//     is incomplete". Rendering them the same way makes a typo look like a
//     broken brain.
// ---------------------------------------------------------------------------

/** Notes about inputs the endpoint clamped or dropped. Empty when clean. */
export type DashboardParamNotes = string[];

/**
 * FR-246 D3-f — mirrors `SubstringSearchPayload`.
 *
 * The four honest-substring surfaces (goals, context docs, suggestions,
 * candidates) carry this instead of a {@link RetrievalReport}. It exists as a
 * PAYLOAD field rather than a sentence in the UI so a gate can assert it:
 * `G-BR-13b` fails any surface whose payload says `substring` while its DOM
 * shows a recall readout.
 *
 * `null` means "no `q` was supplied" — different from an absent key, which
 * would mean the surface has no filter at all.
 */
export interface SubstringSearch {
  mode: "substring";
  /** The columns (or `body`, for a file grep) the literal match ran over. */
  fields: string[];
}

/** The envelope every FR-240 list payload shares. */
export interface ListEnvelope {
  count: number;
  total: number;
  limit: number;
  offset: number;
  params: DashboardParamNotes;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** Mirrors `BriefListRowPayload`. NO `content` (D7). */
export interface BriefListRow {
  project: string;
  brief_id: string;
  brief_type: string | null;
  title: string;
  status: string;
  priority: string | null;
  effort: string | null;
  phase: string | null;
  updated_at: string;
}

/** Mirrors `BriefsPayload`. */
export interface BriefsPayload extends ListEnvelope {
  items: BriefListRow[];
}

/** Mirrors `BriefDetailPayload`'s `brief`. Body included — detail only. */
export interface BriefDetail {
  project: string;
  brief_id: string;
  content: string | null;
  filename: string | null;
  content_hash: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  effort: string | null;
  phase: string | null;
  brief_type: string | null;
  updated_at: string | null;
}

/**
 * Mirrors `BriefDetailPayload`.
 *
 * BOTH `project` and `id` are required by the endpoint (BR-078) — a brief id
 * alone names a different brief in 25 projects, so the server REFUSES rather
 * than first-matching. `api.brief` therefore takes both, positionally, and
 * cannot be called with one.
 */
export interface BriefDetailPayload {
  brief: BriefDetail | null;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** Mirrors `LearningListRowPayload`. `content_length` stands in for the body. */
export interface LearningListRow {
  id: number;
  project: string;
  category: string;
  title: string;
  tags: string;
  tech_stack: string;
  scope: string;
  source_brief: string;
  confidence: number;
  created_at: string;
  access_count: number;
  provenance: string;
  review_status: string;
  source_extractor: string;
  promoted_to_doc: string | null;
  content_length: number;
  /**
   * FR-241 — the DESTRUCTIVENESS DISCRIMINATOR. `igris_perception_reject`
   * SOFT-deletes a candidate whose `seen_again_count > 0` and HARD-deletes one
   * at `0`, so a confirmation dialog partitions the selection on this field.
   * Never null — the brain `COALESCE`s it.
   */
  seen_again_count: number;
  /** FR-241 — non-null iff already soft-deleted. */
  deleted_at: string | null;
}

/** Mirrors `LearningsPayload`. `review_status` is echoed for the D9 banner. */
export interface LearningsPayload extends ListEnvelope {
  items: LearningListRow[];
  review_status: string;
  /** FR-246 — what `q` did, or null. */
  search: SubstringSearch | null;
}

/**
 * Mirrors `RetrievalPayload` — **which arms of the brain's recall actually ran.**
 *
 * D3, and the reason AC #2 is assertable rather than assumed. `bm25_only` is a
 * LEGITIMATE state (no `sqlite-vec` on the read handle, or a cold/absent HF
 * model cache) and the learnings view renders it as a VISIBLE BANNER. Without
 * that, the degradation is invisible: BM25-only still returns plausible rows,
 * so the search looks like it worked and half the recall is silently missing.
 */
export interface RetrievalReport {
  mode: "hybrid" | "bm25_only" | "vector_only" | "none";
  vector_available: boolean;
  embedding_available: boolean;
  bm25_hits: number;
  vector_hits: number;
  rrf_k: number;
  weights: { bm25: number; vector: number };
  /** Why the vector arm degraded, verbatim; null when it ran. */
  reason: string | null;
  /**
   * FR-246 — why the BM25 arm could not run. Present only on
   * `/api/briefs/search`: `learnings_fts` has existed since schema v1, but
   * `briefs_fts` arrives at v23, so briefs have a degraded state learnings do
   * not — a live vector arm and no lexical one.
   */
  bm25_reason?: string | null;
}

/** Mirrors `BriefSearchRowPayload`. NO body — `content_length` instead (D7). */
export interface BriefSearchRow {
  id: number;
  project: string;
  brief_id: string;
  brief_type: string | null;
  title: string;
  status: string;
  priority: string | null;
  effort: string | null;
  phase: string | null;
  updated_at: string;
  content_length: number;
  rrf_score: number | null;
  bm25_rank: number | null;
  vector_rank: number | null;
}

/** Mirrors `BriefsSearchPayload` — FR-246's one new endpoint. */
export interface BriefsSearchPayload {
  query: string;
  items: BriefSearchRow[];
  count: number;
  retrieval: RetrievalReport;
  params: DashboardParamNotes;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** Mirrors `LearningSearchRowPayload`. Ranks are null on the arm that missed. */
export interface LearningSearchRow {
  id: number;
  project: string;
  category: string;
  title: string;
  /** A truncated preview, not the body. */
  preview: string;
  tags: string;
  scope: string;
  confidence: number;
  provenance: string;
  created_at: string;
  promoted_to_doc: string | null;
  rrf_score: number | null;
  bm25_rank: number | null;
  vector_rank: number | null;
}

/**
 * Mirrors `LearningsSearchPayload`. `review_status` is the scope the reader
 * APPLIED (BR-085) — the view banners from it rather than from its own filter
 * state, which is the whole fix.
 */
export interface LearningsSearchPayload {
  query: string;
  items: LearningSearchRow[];
  count: number;
  retrieval: RetrievalReport;
  review_status: string;
  params: DashboardParamNotes;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

// ---- FR-248 · the fused cross-layer search --------------------------------
//
// MIRRORS the `FR-248` block at the end of `cli/src/types.ts`. Read that file
// for the reasoning; what is repeated here is the SHAPE and the two properties
// a renderer must not talk itself out of:
//
//   1. `layers` ALWAYS carries one entry per layer, on every code path. A layer
//      is never absent from the payload, only `available: false` — which is
//      what makes "silently dropped" unrepresentable rather than merely
//      untested (AC-4). A client that filters this array reintroduces the
//      defect on the render side, so nothing here or in `search/model.ts` ever
//      does.
//   2. `requested` and `available` are DIFFERENT FACTS. "You excluded this with
//      ?layers=" is not "this is broken", and a surface that renders them the
//      same way is the conflation the brief exists to remove.

/** Mirrors `SearchLayerId`. CLOSED, and closed is the point — see (1) above. */
export type SearchLayerId =
  | "briefs"
  | "learnings"
  | "goals"
  | "suggestions"
  | "context-docs";

/**
 * Mirrors `SearchRankBasis` — what a layer's within-layer ORDER actually means.
 *
 * `rrf` is relevance. `substring` is the list's OWN order (a recency ordering, a
 * deadline, a priority band, a catalog position) after a literal `LIKE '%q%'`.
 * THREE OF THE FIVE LAYERS ARE `substring`, so a fused list mixes two kinds of
 * "rank 1" — which is why this field is on the layer block AND on every row, and
 * why `search/model.ts#recencyReadout` is mandatory rather than conditional.
 */
export type SearchRankBasis = "rrf" | "substring";

/** Mirrors `FusedLayerReportPayload`. One per layer, ALWAYS. */
export interface FusedLayerReport {
  layer: SearchLayerId;
  /** Did the caller ask for this layer? `?layers=` narrows; absent means all. */
  requested: boolean;
  available: boolean;
  /** Non-null EXACTLY when `available === false`. Rendered VERBATIM. */
  reason: string | null;
  rank_basis: SearchRankBasis;
  /** What the arm returned. */
  hits: number;
  /** How many of those survived into `items` after the fused cap. */
  contributed: number;
  /** Non-null iff `rank_basis === "rrf"` — the layer's OWN intra-layer report. */
  retrieval: RetrievalReport | null;
  /** Non-null iff `rank_basis === "substring"`. */
  search: SubstringSearch | null;
  /** BR-085 — the wire params THIS arm actually bound. Per layer, not per response. */
  applied: string[];
}

/** Mirrors `FusedRowPayload`. Homogeneous on the wire, deliberately. */
export interface FusedRow {
  layer: SearchLayerId;
  /** Equal to the layer's own `rank_basis` — AC-5, per row. */
  rank_basis: SearchRankBasis;
  /** 1-based position WITHIN its own layer. The input to the fusion. */
  layer_rank: number;
  fused_score: number;
  /** `<layer>:<project>:<id>` — stable identity across the fused list. */
  key: string;
  /** The layer-native address. `project` is null for globally-addressed rows. */
  ref: { project: string | null; id: string };
  title: string;
  subtitle: string | null;
  updated_at: string | null;
  /**
   * The layer's OWN intra-layer RRF score. Null on every substring layer.
   *
   * DIAGNOSTIC ONLY — it is NOT an input to the fusion, and a renderer that
   * sorted by it would be doing the cross-type score normalisation RRF exists
   * to avoid. Shown as a number beside the row, never used to order one.
   */
  rrf_score: number | null;
}

/** Mirrors `SearchFusionPayload` — the INTER-layer parameters. */
export interface SearchFusion {
  rrf_k: number;
  weights: Record<SearchLayerId, number>;
  /**
   * The substring layers that actually CONTRIBUTED rows.
   *
   * This is the mandatory readout AS DATA rather than as a sentence in the
   * client, which is why `recencyReadout` reads it instead of hard-coding which
   * three layers are substring-only.
   */
  substring_layers: SearchLayerId[];
}

/** Mirrors `FusedSearchPayload` — FR-248's one new endpoint. */
export interface FusedSearchPayload {
  query: string;
  items: FusedRow[];
  count: number;
  /** ALWAYS one entry per layer. Never filter this array. */
  layers: FusedLayerReport[];
  fusion: SearchFusion;
  params: DashboardParamNotes;
  generated_at: string;
  /** A WHOLE-RESPONSE failure only. A single dead layer is `layers[]`'s job. */
  degraded: DashboardDegraded | null;
}

/** Mirrors `LearningDetailPayload`'s `learning`. */
export interface LearningDetail {
  id: number;
  project: string;
  category: string;
  title: string;
  content: string;
  tags: string;
  tech_stack: string;
  scope: string;
  source_brief: string;
  confidence: number;
  created_at: string;
  access_count: number;
  provenance: string;
}

/** Mirrors `LearningDetailPayload`. */
export interface LearningDetailPayload {
  learning: LearningDetail | null;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** Mirrors `ContextDocApplies` — the FR-209 applicability tri-state. */
export type ContextDocApplies = "yes" | "no" | "unknown";

/** Mirrors `ContextDocInventoryRow`. */
export interface ContextDocRow {
  type: string;
  target: string;
  applies_when: string;
  applies: ContextDocApplies;
  optional: boolean;
  summary: string;
  exists: boolean;
  missing_applicable: boolean;
  /** FR-246 — grep hits in this doc's BODY. Absent when no `q` was supplied. */
  matches?: { line: number; snippet: string }[];
  more_matches?: boolean;
}

/**
 * Mirrors `ContextDocsPayload`.
 *
 * D8: no brain involvement at all — this is the `igris context-docs inventory`
 * digest, forwarded. `remediation` is the DIGEST's own array of `/ground <type>`
 * lines and must be rendered verbatim; a hand-written list here would be a
 * second source of truth for the verb names.
 */
export interface ContextDocsPayload {
  project: string | null;
  archetype: string | null;
  tech_stack: string | null;
  inventory_degraded: boolean;
  docs: ContextDocRow[];
  missing_applicable: string[];
  remediation: string[];
  /** FR-246 — what `q` did, or null. A body GREP, and it says so. */
  search: SubstringSearch | null;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/**
 * Mirrors `ContextDocPayload`.
 *
 * Addressed by catalog TYPE, never by filename: the filename comes from the
 * digest row server-side, which is what makes path traversal unreachable rather
 * than merely filtered.
 */
export interface ContextDocPayload {
  project: string | null;
  type: string | null;
  target: string | null;
  content: string | null;
  bytes: number;
  truncated: boolean;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** Mirrors `GoalRowPayload`. */
export interface GoalRow {
  id: number;
  goal_id: string;
  project_slug: string | null;
  title: string;
  description: string | null;
  outcome: string;
  deadline: string | null;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
  achieved_at: string | null;
  metadata: string;
}

/** Mirrors `GoalListRowPayload` — the count is on LIST rows only. */
export interface GoalListRowPayload extends GoalRow {
  serving_briefs_count: number;
}

/** Mirrors `GoalsPayload`. */
export interface GoalsPayload extends ListEnvelope {
  items: GoalListRowPayload[];
  /** FR-246 — what `q` did, or null. */
  search: SubstringSearch | null;
}

/** Mirrors `GoalDetailPayload`. The detail returns the briefs themselves. */
export interface GoalDetailPayload {
  goal: GoalRow | null;
  serving_briefs: Array<{
    brief_id: string;
    title: string;
    status: string;
    priority: string;
  }>;
  serving_learnings_count: number;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

// ---- FR-241 · the triage surface ------------------------------------------

/**
 * Mirrors `SuggestionRowPayload`.
 *
 * `evidence` is the RAW JSON string, exactly as the brain stores it and exactly
 * as the server forwards it. A triage row does not render evidence; parsing it
 * would put a third copy of `rowToSuggestion`'s malformed-JSON behaviour in the
 * browser.
 */
export interface SuggestionRow {
  id: number;
  source_module: string;
  project_slug: string | null;
  title: string;
  evidence: string;
  priority: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  dismissed_at: string | null;
  dismissed_reason: string | null;
  acted_at: string | null;
  acted_brief_id: string | null;
  confidence: number | null;
  suggested_action: string | null;
  type_inferred: number;
  /** TD-440 — the stable finding key. */
  dedupe_key: string | null;
  /** TD-440 — the blocking anchor the key was built on. */
  entity_key: string | null;
  /** TD-440 — how many times this finding has been emitted. */
  seen_count: number;
  /** TD-440 — when it was last re-emitted. */
  last_seen_at: string | null;
  /** TD-440 — JSON array of up to 3 titles this row absorbed. */
  recurrence_titles: string;
  /** TD-440 — the producing instance; null on pre-v5 rows. */
  source_instance: string | null;
}

/**
 * Mirrors `SuggestionsPayload`.
 *
 * `facets.source_module` IS the filter dropdown's vocabulary. It is counted
 * from the data because `source_module` has been an OPEN vocabulary since
 * FR-118 M2 — a hand-listed dropdown would hide every row whose module the LLM
 * invented after the last edit (L-967).
 *
 * `facets.brain_level` (TD-326) is the count of rows with NO project under the
 * SAME non-project filters. It is what lets a project-scoped view state the
 * size of the population its own scope excludes — the number is computed over
 * the filters minus the project axis, so it is non-zero while scoped.
 *
 * `facets.source_instance` (TD-440) is the PRODUCER vocabulary. It exists
 * because `source_module` cannot answer "who filed this": the subconscious
 * alone reports under 195 distinct labels (TD-437's audit, 2026-09-01), so
 * grouping by module reads as 195 producers instead of one. There are SIX
 * producer values across eight writer sites, so that is the ceiling on this
 * facet's key count (plus the pre-v5 unattributed bucket).
 */
export interface SuggestionsPayload extends ListEnvelope {
  items: SuggestionRow[];
  facets: {
    source_module: Record<string, number>;
    brain_level: number;
    source_instance: Record<string, number>;
  };
  /** FR-246 — what `q` did, or null. */
  search: SubstringSearch | null;
}

/** FR-247 — a brief's address. Mirrors the server's `refs[]` entry. */
export interface BriefRef {
  project: string;
  brief_id: string;
}

/** Mirrors `TriageRequest`. The `action` values come from `health.write.actions`. */
export interface TriageRequest {
  action: string;
  /** `target: "id"` actions only. Never sent together with `refs`. */
  ids?: number[];
  /** FR-247 — `target: "brief-ref"` actions only. Never sent with `ids`. */
  refs?: BriefRef[];
  reason?: string;
  brief_id?: string;
  priority?: string;
  goal_id?: string;
  /**
   * FR-249 — `target: "none"` (`create_goal`) only. Never sent with `ids` or
   * `refs`: a create addresses nothing. PREFIXED because the server's
   * unknown-key set is global and a bare `title` in it would stop `title` being
   * refused by absence for every other action.
   */
  goal_title?: string;
  goal_outcome?: string;
  goal_project?: string;
}

/**
 * Mirrors `TriageItemResultPayload`. `error` is the BRAIN's own message.
 *
 * FR-247 made `id` nullable: at most one of `id`/`ref` identifies the item, and
 * a renderer must read whichever is non-null rather than assume an integer.
 *
 * **FR-249: "at most" is not pedantry.** A `target: "none"` row (`create_goal`)
 * has no subject, so BOTH are null — there is no pre-existing row to name. The
 * created identity arrives on `created_id`; the label is `"?"`.
 */
export interface TriageItemResult {
  id: number | null;
  ref: BriefRef | null;
  ok: boolean;
  error: string | null;
  /**
   * FR-249 — the id a `create_goal` allocated. `null` for every other row,
   * AND `null` on a `create_goal` whose declared `returns` path did not
   * resolve in the tool's payload — the row succeeded, the id could not be
   * read. A client must treat `ok && created_id === null` as "created, but
   * I cannot preselect it" rather than as a failure.
   */
  created_id: string | null;
}

/**
 * Mirrors `TriageResultPayload`.
 *
 * `failed > 0` is a NORMAL outcome, not an exception: each id is its own
 * transaction (D6), so a batch can partially apply and the UI must render both
 * columns rather than treating the response as a boolean.
 */
export interface TriageResultPayload {
  action: string;
  requested: number;
  applied: number;
  failed: number;
  results: TriageItemResult[];
  params: string[];
  generated_at: string;
  degraded: DashboardDegraded | null;
}

// ---- FR-266 · the diagnostics surface -------------------------------------
//
// MIRROR CONTRACT, and this block is the one where it bites hardest. These
// interfaces mirror `cli/src/types.ts`'s TD-327 cognition block, which
// MAINTAINING row 122 governs: adding or renaming a digest FIELD is a sweep
// that must land in one commit across the brain-side declaration, `types.ts`,
// `verbs/cognition.ts`, both SKILL.md render rules with their TD-096 runtime
// mirrors — and, since FR-266, THIS FILE. The two ends compile separately with
// zero shared import, so nothing but a scan holds them together:
// `dashboard-cognition-endpoint.test.ts` T1(c) asserts every field name below
// appears here, with a self-negative-control proving the scan can miss.
//
// THE ENDPOINT FORWARDS THE DIGEST VERBATIM, so these names are the brain's
// names. Do not "tidy" one — a rename here is a silent read of `undefined`.

/**
 * Mirrors `CognitionHealthStatus`.
 *
 * SIX MEMBERS, AND A RENDERER MUST NOT ASSUME THEY ARE THE ONLY ONES. The
 * cognition registry is OPEN and the CLI/brain pair is not upgraded atomically
 * on a running machine, so a newer brain's verdict can reach an older client.
 * `diagnostics/model.ts#toneFor` is TOTAL over `string` for that reason — see
 * its header. This union exists to make the KNOWN members legible, not to
 * promise exhaustiveness.
 */
export type CognitionStatus =
  | "disabled"
  | "wedged"
  | "blocked_upstream"
  | "failing"
  | "no_signal"
  | "ok";

/** Mirrors `CognitionScheduleSignal`. The schedule cross-check for one instance. */
export interface CognitionScheduleSignal {
  name: string;
  /** How many `schedules` rows share this NAME. `>1` is a defect, and a warning. */
  rows: number;
  enabled: boolean;
  next_run_at: string | null;
  /** True when `next_run_at` is in the past — due, and it has not fired. */
  overdue: boolean;
  /** The id of an OPEN (`status='running'`) run. A stale one WEDGES the schedule. */
  open_run_id: string | null;
  open_run_started_at: string | null;
  open_run_age_days: number | null;
}

/** Mirrors `CognitionInstanceHealth` — one row of the digest. */
export interface CognitionInstanceHealth {
  id: string;
  /** The `event_log.component` LITERAL. `perception` is NOT `cognition.perception`. */
  component: string;
  event_prefix: string;
  /** The CONJUNCTION of `config.json` keys gating it — all must be truthy. */
  gate_keys: string[];
  /** What an ABSENT gate key resolves to for THIS instance. `true` for perception. */
  gate_default: boolean;
  enabled: boolean;
  /**
   * The FIRST gate key that resolved false/absent; `null` when enabled.
   *
   * RENDERED VERBATIM beside the DISABLED chip (FR-266 D4). An ABSENT key and an
   * EXPLICIT `false` both produce this same string, so the panel CANNOT tell
   * "never enabled" from "deliberately disabled" — that distinction needs a new
   * digest field and is deferred to its own brief. Showing the key is what makes
   * the difference between a bare `DISABLED` and a remedy the operator can act
   * on.
   */
  disabled_by: string | null;
  /** `schedule` | `co_driven` | `session_hook` | `manual`. */
  driver: string;
  /** Schedule name / driving instance id / hook name / null. */
  driver_ref: string | null;
  status: CognitionStatus;
  /** One operator-readable sentence explaining the verdict. Rendered verbatim. */
  reason: string;
  /** Latest terminal event on THIS host. */
  last_run_at: string | null;
  last_outcome: string | null;
  /** Latest terminal on ANY host — `event_log` syncs, so this can disagree. */
  last_run_any_host: string | null;
  runs_today: number;
  output: string;
  output_rows: number | null;
  schedule: CognitionScheduleSignal | null;
}

/** Mirrors `CognitionHealthDigest`. */
export interface CognitionHealthDigest {
  /**
   * THE DIGEST'S OWN degraded flag, and it is NOT the envelope's.
   *
   * True when the brain is readable but carries no `cognition_instances` table
   * — an old brain build. The envelope's `degraded` means there is no brain at
   * all. The two have different remedies, so the panel renders them as
   * different sentences rather than collapsing them.
   */
  degraded: boolean;
  degraded_reason: string | null;
  /** `os.hostname()` — the host every `last_run_at` is scoped to. */
  hostname: string;
  event_log_retention_days: number;
  /** The OLDEST retained row. A `no_signal` means "silent since at least here". */
  event_log_oldest_at: string | null;
  /** One row per REGISTERED instance, in registry order. NEVER hand-listed. */
  instances: CognitionInstanceHealth[];
  warnings: string[];
}

/** Mirrors `CognitionPayload`. */
export interface CognitionPayload {
  cognition: CognitionHealthDigest | null;
  generated_at: string;
  degraded: DashboardDegraded | null;
}

/** A network/parse failure, distinct from a server-reported `degraded`. */
export class ApiError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ApiError";
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    // `cache: no-store` on the client mirrors the server's `Cache-Control:
    // no-store`. Belt and braces: "reload shows current state" is an AC, and a
    // bfcache-served stale payload would silently break it.
    res = await fetch(path, { signal, cache: "no-store" });
  } catch (err) {
    throw new ApiError(path, err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new ApiError(path, `HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(path, "malformed JSON response");
  }
}

export const api = {
  health: (signal?: AbortSignal): Promise<HealthPayload> =>
    getJson<HealthPayload>("api/health", signal),

  projects: (signal?: AbortSignal): Promise<ProjectsPayload> =>
    getJson<ProjectsPayload>("api/projects", signal),

  /**
   * BR-082 — `project: null` OMITS the query param, exactly as `graphStats`
   * below already did. The server reads an absent `project` as "every project"
   * rather than as a degradation, so the two brain-wide reads on the Overview
   * are now requested the same way.
   */
  summary: (
    project: string | null,
    signal?: AbortSignal,
  ): Promise<SummaryPayload> =>
    getJson<SummaryPayload>(
      project === null
        ? "api/summary"
        : `api/summary?project=${encodeURIComponent(project)}`,
      signal,
    ),

  graphStats: (
    project: string | null,
    signal?: AbortSignal,
  ): Promise<GraphStatsPayload> =>
    getJson<GraphStatsPayload>(
      project === null
        ? "api/graph/stats"
        : `api/graph/stats?project=${encodeURIComponent(project)}`,
      signal,
    ),

  /**
   * FR-239 — the full node/edge payload, ~1 MB over loopback.
   *
   * Called ONCE per scope (D8), never on `live.tick`. See `pages/Graph.tsx` for
   * why that is a deliberate divergence from the shell's page pattern.
   */
  graph: (project: string | null, signal?: AbortSignal): Promise<GraphPayload> =>
    getJson<GraphPayload>(
      project === null
        ? "api/graph"
        : `api/graph?project=${encodeURIComponent(project)}`,
      signal,
    ),

  // ---- FR-240 · the four layer views ------------------------------------
  //
  // The LIST methods take a prepared `URLSearchParams` rather than a bag of
  // optional strings. Two reasons: the filter set differs per layer, so a
  // per-layer signature would be five nullable parameters that no caller can
  // read at the call site; and the query is BUILT by `layers/model.ts#listQuery`,
  // which is pure and unit-tested — so "which params does this layer send" is
  // asserted without a fetch. `URLSearchParams` also encodes, which is what
  // keeps a project slug containing a slash from splitting the path.
  //
  // The DETAIL methods take positional identifiers, so the BR-078 requirement
  // is a type error rather than a runtime refusal: `api.brief(id)` does not
  // compile.

  briefs: (query: URLSearchParams, signal?: AbortSignal): Promise<BriefsPayload> =>
    getJson<BriefsPayload>(`api/briefs?${query.toString()}`, signal),

  /** FR-246 — the ONE new endpoint. Hybrid BM25 + vector recall over briefs. */
  briefsSearch: (
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<BriefsSearchPayload> =>
    getJson<BriefsSearchPayload>(`api/briefs/search?${query.toString()}`, signal),

  brief: (
    project: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<BriefDetailPayload> =>
    getJson<BriefDetailPayload>(
      `api/brief?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}`,
      signal,
    ),

  learnings: (
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<LearningsPayload> =>
    getJson<LearningsPayload>(`api/learnings?${query.toString()}`, signal),

  /** The AC #2 path. Read `retrieval.mode` before trusting the result set. */
  learningsSearch: (
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<LearningsSearchPayload> =>
    getJson<LearningsSearchPayload>(
      `api/learnings/search?${query.toString()}`,
      signal,
    ),

  /**
   * FR-248 — the fused cross-layer search. `GET api/search`.
   *
   * Named for the SERVER's handler (`routes.ts#fusedSearch`) rather than
   * `search`, because `search` is already this app's word for the nav's
   * client-side text MUTE (`App.tsx`) and an `api.search` beside it would read
   * as that box's backend. It is not: nothing in the chrome calls this.
   *
   * Takes a prepared `URLSearchParams`, like every other list/search method —
   * the query is BUILT by `search/model.ts#fusedSearchQuery`, which is pure and
   * unit-tested, so "which params does this surface send" is asserted without a
   * fetch. That matters more here than anywhere else on the client: `?layers=`
   * with no known member falls back to ALL FIVE server-side, so a client that
   * could emit an empty one would silently un-narrow a narrowed search.
   */
  fusedSearch: (
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<FusedSearchPayload> =>
    getJson<FusedSearchPayload>(`api/search?${query.toString()}`, signal),

  learning: (id: number, signal?: AbortSignal): Promise<LearningDetailPayload> =>
    getJson<LearningDetailPayload>(
      `api/learning?id=${encodeURIComponent(String(id))}`,
      signal,
    ),

  /**
   * FR-246 adds the optional `q`, a server-side GREP over the doc BODIES.
   *
   * Built with `URLSearchParams` rather than string concatenation because `q`
   * is operator prose: `&`, `#` and `+` all occur in context docs and all would
   * corrupt a hand-built query string.
   */
  contextDocs: (
    project: string,
    q?: string,
    signal?: AbortSignal,
  ): Promise<ContextDocsPayload> => {
    const params = new URLSearchParams({ project });
    if (q !== undefined && q.length > 0) params.set("q", q);
    return getJson<ContextDocsPayload>(
      `api/context-docs?${params.toString()}`,
      signal,
    );
  },

  contextDoc: (
    project: string,
    type: string,
    signal?: AbortSignal,
  ): Promise<ContextDocPayload> =>
    getJson<ContextDocPayload>(
      `api/context-doc?project=${encodeURIComponent(project)}&type=${encodeURIComponent(type)}`,
      signal,
    ),

  goals: (query: URLSearchParams, signal?: AbortSignal): Promise<GoalsPayload> =>
    getJson<GoalsPayload>(`api/goals?${query.toString()}`, signal),

  /** `id` alone — `GL-XXX` is a brain-allocated GLOBAL sequence, unlike a brief id. */
  goal: (id: string, signal?: AbortSignal): Promise<GoalDetailPayload> =>
    getJson<GoalDetailPayload>(
      `api/goal?id=${encodeURIComponent(id)}`,
      signal,
    ),

  // ---- FR-241 · the triage surface --------------------------------------
  //
  // `triage` below is THE ONLY non-GET call in the entire client, and it is the
  // named exception in `dashboard-layers-source.test.ts`'s AC #7 scan. That
  // scan was not deleted when the write path landed — it was NARROWED, so it
  // still asserts that every OTHER file (and every other function here) issues
  // reads only. A second write path would fail it.

  suggestions: (
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<SuggestionsPayload> =>
    getJson<SuggestionsPayload>(`api/suggestions?${query.toString()}`, signal),

  /**
   * FR-266 — the diagnostics spine's one read. `GET api/cognition`.
   *
   * NO PARAMETERS AT ALL, and the omission is the decision: the digest is
   * per-MACHINE and per-REGISTRY, so there is no project axis to scope it to.
   * A `?project=` here would be a filter with nothing to filter, and offering
   * one would imply cognition health differs per project. It does not.
   *
   * RELATIVE URL, like every other call — AC #4 stays mechanically greppable in
   * the built bundle.
   */
  cognition: (signal?: AbortSignal): Promise<CognitionPayload> =>
    getJson<CognitionPayload>("api/cognition", signal),

  /**
   * `POST api/triage` — the ONE mutating call in the client (FR-241 D3).
   *
   * RELATIVE URL, like every other call: AC #4 stays mechanically greppable in
   * the built bundle, and it also means the request's `Origin` is by
   * construction the served origin, which is the fence `server.ts` checks.
   *
   * `Content-Type: application/json` is REQUIRED by the server (415 otherwise),
   * and setting it here is what makes the request non-simple, so the browser
   * preflights it. That is the whole CSRF story: an HTML `<form>` cannot set
   * this header, so it cannot reach this endpoint at all.
   *
   * NO ABORT SIGNAL, deliberately. Aborting a read shows stale rows; aborting a
   * MUTATION mid-batch abandons a request the server will finish anyway, and
   * the caller would have no account of what landed. `useTriage` re-reads the
   * list instead.
   */
  triage: async (request: TriageRequest): Promise<TriageResultPayload> => {
    const path = "api/triage";
    let res: Response;
    try {
      res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        cache: "no-store",
      });
    } catch (err) {
      throw new ApiError(path, err instanceof Error ? err.message : String(err));
    }
    // A 400 carries `{error}` — a CLIENT bug (a malformed body), which is a
    // different thing from a degraded brain and must not be collapsed into it.
    // Surface the server's own sentence rather than "HTTP 400".
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string") detail = `${detail} — ${body.error}`;
      } catch {
        /* no JSON body; the status is all there is */
      }
      throw new ApiError(path, detail);
    }
    try {
      return (await res.json()) as TriageResultPayload;
    } catch {
      throw new ApiError(path, "malformed JSON response");
    }
  },
};
