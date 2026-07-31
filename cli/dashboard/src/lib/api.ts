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

/** Mirrors `LearningsSearchPayload`. */
export interface LearningsSearchPayload {
  query: string;
  items: LearningSearchRow[];
  count: number;
  retrieval: RetrievalReport;
  params: DashboardParamNotes;
  generated_at: string;
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
}

/**
 * Mirrors `SuggestionsPayload`.
 *
 * `facets.source_module` IS the filter dropdown's vocabulary. It is counted
 * from the data because `source_module` has been an OPEN vocabulary since
 * FR-118 M2 — a hand-listed dropdown would hide every row whose module the LLM
 * invented after the last edit (L-967).
 */
export interface SuggestionsPayload extends ListEnvelope {
  items: SuggestionRow[];
  facets: { source_module: Record<string, number> };
}

/** Mirrors `TriageRequest`. The `action` values come from `health.write.actions`. */
export interface TriageRequest {
  action: string;
  ids: number[];
  reason?: string;
  brief_id?: string;
}

/** Mirrors `TriageItemResultPayload`. `error` is the BRAIN's own message. */
export interface TriageItemResult {
  id: number;
  ok: boolean;
  error: string | null;
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

  summary: (project: string, signal?: AbortSignal): Promise<SummaryPayload> =>
    getJson<SummaryPayload>(
      `api/summary?project=${encodeURIComponent(project)}`,
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

  learning: (id: number, signal?: AbortSignal): Promise<LearningDetailPayload> =>
    getJson<LearningDetailPayload>(
      `api/learning?id=${encodeURIComponent(String(id))}`,
      signal,
    ),

  contextDocs: (
    project: string,
    signal?: AbortSignal,
  ): Promise<ContextDocsPayload> =>
    getJson<ContextDocsPayload>(
      `api/context-docs?project=${encodeURIComponent(project)}`,
      signal,
    ),

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
