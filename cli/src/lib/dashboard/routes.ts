/**
 * FR-238 — the four read-only JSON endpoints. FR-239 adds a fifth
 * (`/api/graph`), which reaches the brain through the SAME `bridge.buildGraph`
 * door as `graphStats` and therefore inherits the zero-SQL scan below for free.
 * FR-240 adds NINE more (briefs / brief / learnings / learnings-search /
 * learning / context-docs / context-doc / goals / goal).
 *
 * THIS FILE CONTAINS ZERO SQL. That is a hard scope requirement of the brief,
 * and it is mechanically asserted by `dashboard-server.test.ts`.
 *
 * Every read goes through one of exactly three doors:
 *   - the FR-237 PURE builder, via `brain-bridge.ts` (MAINTAINING row 105);
 *   - the FR-240 PURE READ LAYER, via `brain-bridge.ts#loadLayerReaders` — the
 *     b2 option `routes.ts` reserved for FR-240 (see the note below);
 *   - the EXISTING MAINTAINING-pinned CLI accessors `registry.ts#listProjects`,
 *     `brain-db.ts#briefStatusSummary`, `brain-db.ts#listInstances` (D3-b1) and
 *     `verbs/context-docs.ts#buildContextDocsInventoryDigest` (FR-240 D8).
 *
 * D3-b1 was a deliberate, operator-assented reading of scope item 2 as "no new
 * raw SQL in the server layer" rather than "only brain handlers": those
 * accessors are verbatim mirrors already pinned by MAINTAINING rows, so no new
 * drift surface is created. FR-240 exercised the reserved b2 option — pure
 * `db`-param modules brain-side, with the MCP handlers as their wrappers — so
 * the layer views reach the SAME queries the MCP tools run, with a read-only
 * handle, and there stays exactly ONE definition per query.
 *
 * READ-ONLY IS STRUCTURAL, NOT PROMISED (AC #7 / D2). Every brain handle in
 * this file comes from `bridge.openBrainReadonly()` or
 * `bridge.openBrainReadonlyWithVec()`, both of which set `query_only = ON`.
 * A write anywhere downstream throws `SQLITE_READONLY` instead of mutating the
 * operator's brain. Nothing here calls an MCP handler — those run `getDb()`,
 * which opens read-WRITE and migrates, and two of them bump `access_count`.
 *
 * DEGRADED CONTRACT — every endpoint returns HTTP **200** with a
 * `degraded: {reason}` field and empty data. Never a 500, never a stack trace.
 * A degraded brain is an ordinary state of a personal lens, not an error.
 */

import { existsSync } from "node:fs";
import { briefStatusSummary, listInstances } from "../brain-db.js";
import { listProjects } from "../registry.js";
import { brainDbPath } from "../paths.js";
import * as bridge from "../brain-bridge.js";
import { resolveDefaultProject } from "./default-project.js";
import { composeQueryTwin } from "./graph-query.js";
import { readDoc, readInventory } from "./context-docs-read.js";
import * as write from "../brain-write-bridge.js";
import {
  BRIEF_FILTERS,
  GOAL_FILTERS,
  LEARNING_FILTERS,
  SUGGESTION_FILTERS,
  parseFilters,
  parsePageParams,
  parseQuery,
  parseTriageBody,
} from "./params.js";
import type {
  BrainGraphPayload,
  BrainGraphStatsPayload,
  BriefDetailPayload,
  BriefListRowPayload,
  BriefsPayload,
  ContextDocPayload,
  ContextDocsPayload,
  DashboardProject,
  GoalDetailPayload,
  GoalListRowPayload,
  GoalRowPayload,
  GoalsPayload,
  HealthPayload,
  LearningDetailPayload,
  LearningListRowPayload,
  LearningSearchRowPayload,
  LearningsPayload,
  LearningsSearchPayload,
  ProjectsPayload,
  SuggestionRowPayload,
  SuggestionsPayload,
  SummaryPayload,
  TriageResultPayload,
} from "../../types.js";

function now(): string {
  return new Date().toISOString();
}

function brainPresent(): boolean {
  return existsSync(brainDbPath());
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `GET /api/health` — also the liveness beat the shell's `// LOOP` polls. */
export async function health(cliVersion: string): Promise<HealthPayload> {
  const present = brainPresent();
  const probe = await bridge.probe();
  // FR-241 — SYNCHRONOUS and NON-BOOTING by construction (see `writeProbe`'s
  // header). `/api/health` is the shell's 5-second beat and is part of the
  // FR-240 read-only request sequence; a health check that opened the write
  // door would make G-RO-6 unassertable and would put the operator's brain in
  // WAL just for browsing.
  const writeState = write.writeProbe();
  return {
    ok: true,
    cli_version: cliVersion,
    brain: { present, path: brainDbPath() },
    bridge: { available: probe.available, reason: probe.reason },
    write: {
      available: writeState.available,
      reason: writeState.reason,
      state: writeState.state,
      actions: writeState.actions,
    },
    generated_at: now(),
    degraded: present
      ? null
      : { reason: `brain database not found at ${brainDbPath()}` },
  };
}

/**
 * `GET /api/projects` — via `registry.ts#listProjects()`.
 *
 * `default_project` is resolved SERVER-side because the top rung of the ladder
 * is the directory the CLI was invoked from, which the browser cannot know.
 * The ladder itself is a pure function over these same rows (no second query,
 * and no SQL in this file — D3b).
 *
 * @param cwd injectable for tests; defaults to the server's working directory,
 *            which never changes (nothing in the verb chdirs).
 */
export function projects(cwd: string = process.cwd()): ProjectsPayload {
  if (!brainPresent()) {
    return {
      projects: [],
      default_project: null,
      generated_at: now(),
      degraded: { reason: `brain database not found at ${brainDbPath()}` },
    };
  }
  try {
    const rows: DashboardProject[] = listProjects().map((r) => ({
      slug: r.slug,
      name: r.name,
      path: r.path,
      status: r.status ?? "active",
      last_session_at: r.last_session_at ?? "",
    }));
    return {
      projects: rows,
      default_project: resolveDefaultProject(rows, cwd).slug,
      generated_at: now(),
      degraded: null,
    };
  } catch (err) {
    return {
      projects: [],
      default_project: null,
      generated_at: now(),
      degraded: { reason: `registry read failed: ${messageOf(err)}` },
    };
  }
}

/**
 * `GET /api/summary[?project=<slug>]` — brief counts + the active-instance count.
 *
 * `briefStatusSummary` and `listInstances` both carry their own L-133 table
 * preflight, so a brain missing the migration yields empty counts rather than a
 * throw. The try/catch below is the belt for anything below that (a corrupt
 * file, a locked DB).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * OMITTING `project` IS A REQUEST, NOT A MISTAKE (BR-082)
 * ─────────────────────────────────────────────────────────────────────────
 * FR-238 answered a project-less request with `degraded: "no project selected"`
 * and empty counts. That was right while the ONLY caller was an Overview page
 * that could not clear its scope; BR-082 gives the page a cleared state, and a
 * page whose deliberate "every project" reads as a DEGRADATION would be a
 * dashboard reporting its own feature as a fault.
 *
 * So `project === null` now drops the predicate on both reads. It is NOT a new
 * query in this file — both accessors already build their WHERE conditionally
 * (`briefStatusSummary`'s `summaryWhere` mirror; `listInstances`'s
 * `if (args.project)`), and the null simply takes the branch that was already
 * there. `degraded` stays reserved for a brain that could not be read.
 *
 * WHICH SET THIS IS — and it is not the same answer for both counts.
 * Unfiltered means every row of each table: the "everything" set, not the "sum
 * over the registered projects" set.
 *
 * - `briefs` — the two sets COINCIDE. `brief_status.project` is `NOT NULL`
 *   with a declared FK to `projects(slug)`, and better-sqlite3 enables
 *   `foreign_keys` by DEFAULT on every handle, so an orphan cannot be created
 *   in the first place — deleting a project that still has briefs is BLOCKED.
 *   Measured, not inferred: `brain-db.ts`'s note records the probe.
 * - `instances` — they do NOT. `project_slug` is nullable with no FK, so an
 *   ACTIVE session belonging to no project is counted by the unfiltered read
 *   and by no scoped one. `dashboard-server.test.ts` seeds exactly that row and
 *   asserts the difference is 1, rather than leaving the claim to prose.
 *
 * Measured on the operator brain 2026-07-31 both are 0 (`brief_status` 0 of
 * 1,803; active `instances` 0 of 17) — but 0 today is a reading, not a
 * guarantee. The table that diverges loudly is `suggestions`, at 377 rows
 * (TD-326), and NO field of this payload counts suggestions. `pages/Overview.tsx`
 * states the same thing at the surface the operator actually reads.
 */
export function summary(project: string | null): SummaryPayload {
  const empty = { total: 0, by_status: {}, by_priority: {} };
  if (!brainPresent()) {
    return {
      project,
      briefs: empty,
      instances: { active: 0 },
      generated_at: now(),
      degraded: { reason: `brain database not found at ${brainDbPath()}` },
    };
  }
  try {
    const briefs = briefStatusSummary(project);
    const instances = listInstances(
      project === null ? { status: "active" } : { project, status: "active" },
    );
    return {
      project,
      briefs,
      instances: { active: instances.length },
      generated_at: now(),
      degraded: null,
    };
  } catch (err) {
    return {
      project,
      briefs: empty,
      instances: { active: 0 },
      generated_at: now(),
      degraded: { reason: `brain read failed: ${messageOf(err)}` },
    };
  }
}

/**
 * `GET /api/graph/stats?project=<slug>` — the FR-237 integration proof.
 *
 * `nodes` and `edges` are STRIPPED here, at the route layer. That is R8's
 * structural fence: the shell physically cannot render a graph from this
 * response, so FR-239's scope cannot leak backwards into FR-238. It also keeps
 * the payload a few KB regardless of brain size.
 */
export async function graphStats(
  project: string | null,
): Promise<BrainGraphStatsPayload> {
  const base = {
    project,
    stats: null,
    edge_resolution: null,
    truncated: false,
    truncation_reason: null,
    generated_at: now(),
  };

  if (!brainPresent()) {
    return {
      ...base,
      degraded: { reason: `brain database not found at ${brainDbPath()}` },
    };
  }

  const result = await bridge.buildGraph(project === null ? {} : { project });
  if (!result.ok) {
    // Report the DISCRIMINATED cause verbatim. "engine unavailable" and
    // "the builder threw on a schema mismatch" send an operator to completely
    // different places; collapsing them would make the readout's failure
    // silent in the way that matters (R2).
    return { ...base, degraded: { reason: result.reason } };
  }
  const graph = result.graph;

  return {
    project: graph.project,
    stats: graph.stats as unknown as Record<string, unknown>,
    edge_resolution: graph.edge_resolution as unknown as Record<string, unknown>,
    truncated: graph.truncated,
    truncation_reason: graph.truncation_reason,
    generated_at: graph.generated_at,
    // The builder's own degradation block is surfaced verbatim when it reports
    // anything — a missing table there is a real, reportable degradation.
    degraded:
      graph.degraded.reason !== null
        ? { reason: graph.degraded.reason }
        : graph.degraded.missing_tables.length > 0
          ? {
              reason: `brain tables absent: ${graph.degraded.missing_tables.join(", ")}`,
            }
          : null,
  };
}

/**
 * `GET /api/graph?project=<slug>` — FR-239. The node/edge arrays themselves.
 *
 * SAME DOOR AS `graphStats`. This handler holds no query logic of its own: it
 * calls `bridge.buildGraph()` and forwards the result. That is what keeps the
 * zero-SQL rule true by construction rather than by discipline, and it is why
 * whole-brain and project drill-down are the same code path (row 105 —
 * "the filter is applied to the assembled graph").
 *
 * NO SECOND CAP (D3). FR-237's `maxNodes`/`maxEdges` are the only ceilings; a
 * render-side cap here could silently disagree with `whole_brain_graph.md` §5,
 * and density is the degradation ladder's job, not the transport's.
 *
 * The response is ~1 MB over loopback and is fetched ONCE per scope (D8) — the
 * shell's 5-second `live.tick` deliberately does NOT drive it.
 */
export async function graph(project: string | null): Promise<BrainGraphPayload> {
  const degradedPayload = (reason: string): BrainGraphPayload => {
    const at = now();
    return {
      project,
      nodes: [],
      edges: [],
      stats: null,
      truncated: false,
      truncation_reason: null,
      // The twin is composed even when the read failed. A canvas with no twin
      // is unreproducible (exemption 04), and "why is it empty" is exactly the
      // question a reader has in this state — so the twin answers it.
      query: composeQueryTwin({
        project,
        nodeCount: 0,
        edgeCount: 0,
        truncated: false,
        truncationReason: null,
        degradedReason: reason,
        generatedAt: at,
      }),
      generated_at: at,
      degraded: { reason },
    };
  };

  if (!brainPresent()) {
    return degradedPayload(`brain database not found at ${brainDbPath()}`);
  }

  const result = await bridge.buildGraph(project === null ? {} : { project });
  if (!result.ok) {
    // Discriminated cause, verbatim — same reasoning as `graphStats`.
    return degradedPayload(result.reason);
  }
  const g = result.graph;

  const builderDegraded =
    g.degraded.reason !== null
      ? g.degraded.reason
      : g.degraded.missing_tables.length > 0
        ? `brain tables absent: ${g.degraded.missing_tables.join(", ")}`
        : null;

  return {
    project: g.project,
    // Forwarded VERBATIM. Any reshaping here would be a second definition of
    // the node/edge contract living outside `whole-graph.ts` (row 105).
    nodes: g.nodes,
    edges: g.edges,
    stats: g.stats as unknown as Record<string, unknown>,
    truncated: g.truncated,
    truncation_reason: g.truncation_reason,
    query: composeQueryTwin({
      project: g.project,
      nodeCount: g.nodes.length,
      edgeCount: g.edges.length,
      truncated: g.truncated,
      truncationReason: g.truncation_reason,
      // A partial degradation (a missing table) still produced a real node
      // set, so the twin reports the SCALE, not the degradation — the payload's
      // own `degraded` field carries that.
      degradedReason: null,
      generatedAt: g.generated_at,
    }),
    generated_at: g.generated_at,
    degraded: builderDegraded !== null ? { reason: builderDegraded } : null,
  };
}

// ---------------------------------------------------------------------------
// FR-240 — the four layer views.
//
// SHAPE SHARED BY ALL NINE HANDLERS
// ---------------------------------
// Each one is: (1) brain-present check, (2) load the pure readers, (3) open a
// read-only handle, (4) call ONE reader, (5) map to the wire shape, (6) close
// the handle in a `finally`. No branching on query logic, because there is
// none here — the queries live brain-side. That is what keeps the zero-SQL
// scan true BY CONSTRUCTION rather than by review.
//
// The handle is opened and closed PER REQUEST, which is what makes "the data is
// live" true with no regeneration step: a `/hunt` writing to the brain is
// visible on the next reload because no connection is cached across requests.
// ---------------------------------------------------------------------------

/** Reason string for a brain that is not on disk. Used by all nine. */
function brainMissingReason(): string {
  return `brain database not found at ${brainDbPath()}`;
}

/**
 * Everything the nine handlers need before they can read: the reader module set
 * and an armed read-only handle.
 *
 * Returns a DISCRIMINATED failure for the same reason `buildGraph` does — the
 * two ways this fails send an operator to completely different places. A
 * `readers_unavailable` is a PACKAGING problem (a moved artifact, a missing
 * vendored `node_modules` before postinstall); a `brain_unavailable` is a DATA
 * problem. Collapsing them into one "unavailable" string is the silent-degrade
 * failure R2 warns about.
 */
type ReadContext =
  | { ok: true; readers: bridge.LayerReaders; db: ReturnType<typeof bridge.openBrainReadonly> & object }
  | { ok: false; reason: string };

async function openReadContext(): Promise<ReadContext> {
  const readers = await bridge.loadLayerReaders();
  if (readers === null) {
    return {
      ok: false,
      reason:
        bridge.lastLayerReadersFailure() ??
        "brain read layer could not be loaded from the vendored bundle",
    };
  }
  const db = bridge.openBrainReadonly();
  if (db === null) {
    return {
      ok: false,
      reason: `brain database at ${brainDbPath()} could not be opened read-only`,
    };
  }
  return { ok: true, readers, db };
}

/** Close a handle without letting a double-close mask the real result. */
function closeQuietly(db: { close: () => void }): void {
  try {
    db.close();
  } catch {
    /* already closed / never opened cleanly — nothing to do */
  }
}

// --- briefs ----------------------------------------------------------------

/**
 * `GET /api/briefs` — the brief list.
 *
 * Reaches `briefs-read.ts#listBriefs`, the SAME function `igris_brief_list`
 * calls. `include_content` is deliberately NOT exposed: D7 makes body content
 * detail-only, and 615 briefs × a multi-KB body is the superlinear payload term
 * the FR-237 "returns NO body content" rule exists to remove.
 */
export async function briefs(search: URLSearchParams): Promise<BriefsPayload> {
  const page = parsePageParams(search);
  const filters = parseFilters(search, BRIEF_FILTERS, ["limit", "offset"]);
  const notes = [...page.rejected, ...filters.rejected];
  const base = {
    items: [] as BriefListRowPayload[],
    count: 0,
    total: 0,
    limit: page.limit,
    offset: page.offset,
    params: notes,
    generated_at: now(),
  };

  if (!brainPresent()) {
    return { ...base, degraded: { reason: brainMissingReason() } };
  }
  const ctx = await openReadContext();
  if (!ctx.ok) return { ...base, degraded: { reason: ctx.reason } };

  try {
    const r = ctx.readers.listBriefs(ctx.db, {
      project: filters.values.project,
      status: filters.values.status,
      priority: filters.values.priority,
      effort: filters.values.effort,
      brief_type: filters.values.brief_type,
      limit: page.limit,
      offset: page.offset,
    });
    return {
      ...base,
      items: r.briefs as unknown as BriefListRowPayload[],
      count: r.count,
      total: r.total,
      limit: r.limit,
      offset: r.offset,
      degraded: null,
    };
  } catch (err) {
    return { ...base, degraded: { reason: `brief list failed: ${messageOf(err)}` } };
  } finally {
    closeQuietly(ctx.db);
  }
}

/**
 * `GET /api/brief?project=<slug>&id=<brief_id>` — one brief, body included.
 *
 * BOTH params REQUIRED. BR-078: `BR-001` names a different brief in 25
 * projects, so falling back to an id-only lookup would silently return whichever
 * project happened to sort first — the exact defect that made the composite key
 * necessary. A missing `project` therefore REFUSES (with a stated reason and an
 * explicit `brief: null`) rather than guessing.
 */
export async function brief(search: URLSearchParams): Promise<BriefDetailPayload> {
  const project = search.get("project");
  const id = search.get("id");
  const base = { brief: null, generated_at: now() };

  if (project === null || project.length === 0 || id === null || id.length === 0) {
    return {
      ...base,
      degraded: {
        reason:
          "both 'project' and 'id' are required — a brief id alone is ambiguous across projects (BR-078)",
      },
    };
  }
  if (!brainPresent()) {
    return { ...base, degraded: { reason: brainMissingReason() } };
  }
  const ctx = await openReadContext();
  if (!ctx.ok) return { ...base, degraded: { reason: ctx.reason } };

  try {
    const record = ctx.readers.getBrief(ctx.db, project, id);
    if (record === null) {
      return {
        ...base,
        degraded: { reason: `brief not found: ${id} in project ${project}` },
      };
    }
    return {
      brief: record as unknown as NonNullable<BriefDetailPayload["brief"]>,
      generated_at: now(),
      degraded: null,
    };
  } catch (err) {
    return { ...base, degraded: { reason: `brief read failed: ${messageOf(err)}` } };
  } finally {
    closeQuietly(ctx.db);
  }
}

// --- learnings -------------------------------------------------------------

/** D9 — the lens defaults to approved rows; pending ones must be asked for. */
const DEFAULT_REVIEW_STATUS = "approved";

/**
 * `GET /api/learnings` — the learning list.
 *
 * Reaches `memory-read.ts#listLearnings`, the query FR-240 ADDED: no MCP
 * handler offered a query-less, filter-based browse (`igris_memory_search` is
 * FTS-only, `igris_memory_hybrid_search` requires a query,
 * `igris_memory_dashboard` returns counts).
 *
 * D9 — `review_status` defaults to `approved`. It is echoed in the payload so
 * the UI can banner a non-default value without re-parsing the URL, and this
 * lens is READ-ONLY: FR-241 owns triage, so there is no approve/reject path.
 */
export async function learnings(search: URLSearchParams): Promise<LearningsPayload> {
  const page = parsePageParams(search);
  const filters = parseFilters(search, LEARNING_FILTERS, ["limit", "offset"]);
  const reviewStatus = filters.values.review_status ?? DEFAULT_REVIEW_STATUS;
  const notes = [...page.rejected, ...filters.rejected];
  const base = {
    items: [] as LearningListRowPayload[],
    count: 0,
    total: 0,
    limit: page.limit,
    offset: page.offset,
    review_status: reviewStatus,
    params: notes,
    generated_at: now(),
  };

  if (!brainPresent()) {
    return { ...base, degraded: { reason: brainMissingReason() } };
  }
  const ctx = await openReadContext();
  if (!ctx.ok) return { ...base, degraded: { reason: ctx.reason } };

  try {
    const r = ctx.readers.listLearnings(ctx.db, {
      project: filters.values.project,
      category: filters.values.category,
      scope: filters.values.scope,
      provenance: filters.values.provenance,
      review_status: reviewStatus,
      limit: page.limit,
      offset: page.offset,
    });
    return {
      ...base,
      items: r.learnings as unknown as LearningListRowPayload[],
      count: r.count,
      total: r.total,
      limit: r.limit,
      offset: r.offset,
      // The reader's own L-133 preflight result is a real degradation and is
      // surfaced verbatim rather than rendered as an empty list.
      degraded: r.degraded !== null ? { reason: r.degraded } : null,
    };
  } catch (err) {
    return { ...base, degraded: { reason: `learning list failed: ${messageOf(err)}` } };
  } finally {
    closeQuietly(ctx.db);
  }
}

/** Preview length for a search hit. Matches `formatHybridResult`'s 300 chars. */
const SEARCH_PREVIEW_CHARS = 300;

/**
 * `GET /api/learnings/search?q=<query>` — hybrid BM25 + vector recall (AC #2).
 *
 * THIS IS THE ONE ENDPOINT THAT NEEDS `openBrainReadonlyWithVec`.
 * `isVectorSearchAvailable(db)` is a `SELECT vec_version()` probe on THAT
 * connection, so a plain read-only handle would make the reader take its
 * BM25-only arm SILENTLY — returning plausible results while AC #2 was false.
 * Step-10 probe (a) confirmed `sqlite-vec.load()` succeeds on a
 * `{readonly:true}` handle and coexists with `query_only = ON`.
 *
 * The `retrieval` block is forwarded VERBATIM. It is what makes the degradation
 * loud instead of invisible, and what makes AC #2 assertable at all: a
 * `mode: "bm25_only"` response is a legitimate state (no extension, or a
 * cold/absent HF model cache) and the UI banners it rather than shrugging.
 */
export async function learningsSearch(
  search: URLSearchParams,
): Promise<LearningsSearchPayload> {
  const page = parsePageParams(search, { limit: 20 });
  const filters = parseFilters(search, LEARNING_FILTERS, ["limit", "offset", "q"]);
  const parsed = parseQuery(search);
  const notes = [...page.rejected, ...filters.rejected];

  const emptyRetrieval = {
    mode: "none" as const,
    vector_available: false,
    embedding_available: false,
    bm25_hits: 0,
    vector_hits: 0,
    rrf_k: 60,
    weights: { bm25: 0.5, vector: 0.5 },
    reason: null,
  };
  const base = {
    query: parsed.ok ? parsed.query : "",
    items: [] as LearningSearchRowPayload[],
    count: 0,
    retrieval: emptyRetrieval,
    params: notes,
    generated_at: now(),
  };

  if (!parsed.ok) return { ...base, degraded: { reason: parsed.reason } };
  if (!brainPresent()) {
    return { ...base, degraded: { reason: brainMissingReason() } };
  }

  const readers = await bridge.loadLayerReaders();
  if (readers === null) {
    return {
      ...base,
      degraded: {
        reason:
          bridge.lastLayerReadersFailure() ??
          "brain read layer could not be loaded from the vendored bundle",
      },
    };
  }

  const handle = await bridge.openBrainReadonlyWithVec();
  if (handle === null) {
    return {
      ...base,
      degraded: {
        reason: `brain database at ${brainDbPath()} could not be opened read-only`,
      },
    };
  }

  try {
    const r = await readers.hybridSearchLearnings(handle.db, {
      query: parsed.query,
      project: filters.values.project,
      limit: page.limit,
    });

    // A hydration miss (`row === null`) is dropped from the wire rather than
    // shipped as a placeholder: the MCP wrapper renders "(record not found)"
    // because its output is a transcript a human reads, but a UI row with no
    // fields is just a broken row.
    const items: LearningSearchRowPayload[] = r.rows
      .filter((e) => e.row !== null)
      .map((e) => {
        const row = e.row as NonNullable<typeof e.row>;
        return {
          id: row.id,
          project: row.project,
          category: row.category,
          title: row.title,
          preview:
            row.content.length > SEARCH_PREVIEW_CHARS
              ? `${row.content.slice(0, SEARCH_PREVIEW_CHARS)}...`
              : row.content,
          tags: row.tags,
          scope: row.scope,
          confidence: row.confidence,
          provenance: row.provenance,
          created_at: row.created_at,
          promoted_to_doc: row.promoted_to_doc ?? null,
          rrf_score: e.rrf_score,
          bm25_rank: e.bm25_rank,
          vector_rank: e.vector_rank,
        };
      });

    return {
      ...base,
      items,
      count: items.length,
      retrieval: {
        ...r.retrieval,
        // `vector_available` is forwarded VERBATIM: the reader's
        // `SELECT vec_version()` probe on the actual handle is the authoritative
        // answer to "can this connection run vector search", and it is a
        // strictly different fact from "the vector arm contributed" (which
        // `mode` and `vector_hits` carry). AND-ing it with anything here would
        // collapse the two, which is the diagnosis-destroying conflation D3
        // exists to prevent.
        //
        // Only the REASON is enriched, and only when the bridge has a better
        // one: the reader can say `sqlite-vec not loaded on this connection`,
        // but only the bridge knows WHY — a moved artifact, an absent vendored
        // `node_modules`, a `load()` throw.
        reason: handle.vector_reason ?? r.retrieval.reason,
      },
      degraded: null,
    };
  } catch (err) {
    return {
      ...base,
      degraded: { reason: `learning search failed: ${messageOf(err)}` },
    };
  } finally {
    closeQuietly(handle.db);
  }
}

/**
 * `GET /api/learning?id=<n>` — one learning, body included.
 *
 * Reaches `memory-read.ts#getLearning`, which does NOT bump `access_count`.
 * That is deliberate and load-bearing: TD-092 records the bump as correct for
 * `igris_memory_get`/`igris_memory_recall` because it feeds the composite
 * ranking boost and the recall telemetry — but the operator BROWSING their own
 * lens is not a recall event, and letting a page view inflate the ranking
 * signal would corrupt the very telemetry the bump exists to produce. The bump
 * stays in the MCP wrapper (`memory.ts`); this path is read-only (AC #7).
 */
export async function learning(search: URLSearchParams): Promise<LearningDetailPayload> {
  const raw = search.get("id");
  const base = { learning: null, generated_at: now() };

  const id = raw === null ? Number.NaN : Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    return {
      ...base,
      degraded: { reason: "'id' is required and must be a positive integer" },
    };
  }
  if (!brainPresent()) {
    return { ...base, degraded: { reason: brainMissingReason() } };
  }
  const ctx = await openReadContext();
  if (!ctx.ok) return { ...base, degraded: { reason: ctx.reason } };

  try {
    const row = ctx.readers.getLearning(ctx.db, id);
    if (row === null) {
      return { ...base, degraded: { reason: `learning not found: ${id}` } };
    }
    return {
      learning: row as unknown as NonNullable<LearningDetailPayload["learning"]>,
      generated_at: now(),
      degraded: null,
    };
  } catch (err) {
    return { ...base, degraded: { reason: `learning read failed: ${messageOf(err)}` } };
  } finally {
    closeQuietly(ctx.db);
  }
}

// --- context docs ----------------------------------------------------------

/**
 * `GET /api/context-docs?project=<slug>` — the inventory digest.
 *
 * D8: NO brain work at all. This forwards
 * `verbs/context-docs.ts#buildContextDocsInventoryDigest`, which already
 * computes exists / applies / missing_applicable / remediation. `applies_when`
 * is NOT re-derived here — a second evaluator would diverge from the catalog's
 * the first time either changed.
 *
 * Note this endpoint never opens the brain, so it works on a machine with no
 * brain database at all. The `degraded` field still exists, because an
 * unregistered slug and an unreadable catalog are both real failures.
 */
export function contextDocs(search: URLSearchParams): ContextDocsPayload {
  const project = search.get("project");
  const base = {
    project,
    archetype: null,
    tech_stack: null,
    inventory_degraded: false,
    docs: [],
    missing_applicable: [],
    remediation: [],
    generated_at: now(),
  };

  if (project === null || project.length === 0) {
    return { ...base, degraded: { reason: "'project' is required" } };
  }

  const result = readInventory(project);
  if (!result.ok) return { ...base, degraded: { reason: result.reason } };

  const d = result.digest;
  return {
    project: d.project,
    archetype: d.archetype,
    tech_stack: d.tech_stack,
    inventory_degraded: d.degraded,
    docs: d.docs,
    missing_applicable: d.missing_applicable,
    // The digest's OWN remediation array. Never a hand-written `/ground` list —
    // that would be a second source of truth for the verb names.
    remediation: d.remediation,
    generated_at: now(),
    degraded: d.degraded
      ? { reason: "inventory incomplete: project profile or catalog data missing" }
      : null,
  };
}

/**
 * `GET /api/context-doc?project=<slug>&type=<doc type>` — one doc's content.
 *
 * Addressed by catalog TYPE. The FILENAME comes from the digest row, so there is
 * no code path that joins a caller-supplied filename — which is what makes path
 * traversal unreachable here rather than merely filtered. See
 * `context-docs-read.ts` for the three fences.
 */
export function contextDoc(search: URLSearchParams): ContextDocPayload {
  const project = search.get("project");
  const type = search.get("type");
  const base = {
    project,
    type,
    target: null,
    content: null,
    bytes: 0,
    truncated: false,
    generated_at: now(),
  };

  if (project === null || project.length === 0 || type === null || type.length === 0) {
    return { ...base, degraded: { reason: "both 'project' and 'type' are required" } };
  }

  const result = readDoc(project, type);
  if (!result.ok) return { ...base, degraded: { reason: result.reason } };

  return {
    project: result.project,
    type: result.type,
    target: result.target,
    content: result.content,
    bytes: result.bytes,
    truncated: result.truncated,
    generated_at: now(),
    degraded: result.truncated
      ? { reason: `doc truncated at the read cap (${result.bytes} bytes on disk)` }
      : null,
  };
}

// --- goals -----------------------------------------------------------------

/**
 * `GET /api/goals` — the goal list.
 *
 * Reaches `goals/read.ts#listGoals`, the SAME function `igris_goal_list` calls,
 * including the `serving_briefs_count` correlated subquery and the
 * deadline-ASC-nulls-last ordering.
 */
export async function goals(search: URLSearchParams): Promise<GoalsPayload> {
  const page = parsePageParams(search);
  const filters = parseFilters(search, GOAL_FILTERS, [
    "limit",
    "offset",
    "upcoming_days",
  ]);
  const notes = [...page.rejected, ...filters.rejected];

  // `upcoming_days` is parsed here rather than in `params.ts` because it is the
  // one numeric FILTER (not a page control) and its validation contract is the
  // brain wrapper's: non-negative, floored.
  let upcomingDays: number | undefined;
  const rawUpcoming = search.get("upcoming_days");
  if (rawUpcoming !== null && rawUpcoming.length > 0) {
    const n = Number(rawUpcoming);
    if (!Number.isFinite(n) || n < 0) {
      notes.push(`upcoming_days: must be a non-negative number (got ${rawUpcoming})`);
    } else {
      upcomingDays = Math.floor(n);
    }
  }

  const base = {
    items: [] as GoalListRowPayload[],
    count: 0,
    total: 0,
    limit: page.limit,
    offset: page.offset,
    params: notes,
    generated_at: now(),
  };

  if (!brainPresent()) {
    return { ...base, degraded: { reason: brainMissingReason() } };
  }
  const ctx = await openReadContext();
  if (!ctx.ok) return { ...base, degraded: { reason: ctx.reason } };

  try {
    const r = ctx.readers.listGoals(ctx.db, {
      project: filters.values.project,
      status: filters.values.status,
      upcoming_days: upcomingDays,
      limit: page.limit,
      offset: page.offset,
    });
    return {
      ...base,
      items: r.goals as unknown as GoalListRowPayload[],
      count: r.count,
      total: r.total,
      limit: r.limit,
      offset: r.offset,
      degraded: null,
    };
  } catch (err) {
    return { ...base, degraded: { reason: `goal list failed: ${messageOf(err)}` } };
  } finally {
    closeQuietly(ctx.db);
  }
}

/**
 * `GET /api/goal?id=<GL-XXX>` — one goal plus its serving briefs.
 *
 * `goal_id` is globally unique (a `GL-XXX` sequence allocated brain-side), so
 * unlike `/api/brief` this one takes no `project`. That asymmetry is the BR-078
 * distinction, not an oversight: brief ids are per-project, goal ids are not.
 */
export async function goal(search: URLSearchParams): Promise<GoalDetailPayload> {
  const id = search.get("id");
  const base = {
    goal: null as GoalRowPayload | null,
    serving_briefs: [] as GoalDetailPayload["serving_briefs"],
    serving_learnings_count: 0,
    generated_at: now(),
  };

  if (id === null || id.length === 0) {
    return { ...base, degraded: { reason: "'id' is required" } };
  }
  if (!brainPresent()) {
    return { ...base, degraded: { reason: brainMissingReason() } };
  }
  const ctx = await openReadContext();
  if (!ctx.ok) return { ...base, degraded: { reason: ctx.reason } };

  try {
    const detail = ctx.readers.getGoal(ctx.db, id);
    if (detail === null) {
      return { ...base, degraded: { reason: `goal not found: ${id}` } };
    }
    return {
      goal: detail.goal as unknown as GoalRowPayload,
      serving_briefs: detail.serving_briefs,
      serving_learnings_count: detail.serving_learnings_count,
      generated_at: now(),
      degraded: null,
    };
  } catch (err) {
    return { ...base, degraded: { reason: `goal read failed: ${messageOf(err)}` } };
  } finally {
    closeQuietly(ctx.db);
  }
}

// --- FR-241: suggestions (read) --------------------------------------------

/**
 * `GET /api/suggestions` — the pending-suggestion queue.
 *
 * The TENTH handler on the FR-240 shape, and it uses the SAME `openReadContext()`
 * helper as the other nine: same `query_only = ON` handle, same six steps, same
 * per-request open/close. That is not a stylistic choice — it is what lets this
 * path be ADDED to `dashboard-readonly.test.ts`'s `LAYER_PATHS` crawl, so the
 * G-RO-1 digest gate gets STRICTER rather than being routed around by the brief
 * that introduces writes.
 *
 * Reaches `suggestions-read.ts#listSuggestions`, the same function
 * `igris_suggestion_list` calls. The `facets` block is the one thing the MCP
 * wrapper does not emit — see that module's header for why.
 */
export async function suggestions(
  search: URLSearchParams,
): Promise<SuggestionsPayload> {
  const page = parsePageParams(search);
  const filters = parseFilters(search, SUGGESTION_FILTERS, ["limit", "offset"]);
  const notes = [...page.rejected, ...filters.rejected];
  const base = {
    items: [] as SuggestionRowPayload[],
    count: 0,
    total: 0,
    limit: page.limit,
    offset: page.offset,
    facets: { source_module: {} as Record<string, number> },
    params: notes,
    generated_at: now(),
  };

  if (!brainPresent()) {
    return { ...base, degraded: { reason: brainMissingReason() } };
  }
  const ctx = await openReadContext();
  if (!ctx.ok) return { ...base, degraded: { reason: ctx.reason } };

  try {
    const r = ctx.readers.listSuggestions(ctx.db, {
      // `project` on the wire, `project_slug` in the table. The dashboard's
      // shared project selector emits `project` on every page.
      project_slug: filters.values.project,
      status: filters.values.status,
      priority: filters.values.priority,
      source_module: filters.values.source_module,
      limit: page.limit,
      offset: page.offset,
    });
    return {
      ...base,
      items: r.suggestions as unknown as SuggestionRowPayload[],
      count: r.count,
      total: r.total,
      limit: r.limit,
      offset: r.offset,
      facets: r.facets,
      // The reader's own L-133 preflight result is a real degradation and is
      // surfaced verbatim rather than rendered as an empty queue — "you have no
      // suggestions" and "this brain never ran the migration" must not look the
      // same on a backlog-clearing surface.
      degraded: r.degraded !== null ? { reason: r.degraded } : null,
    };
  } catch (err) {
    return {
      ...base,
      degraded: { reason: `suggestion list failed: ${messageOf(err)}` },
    };
  } finally {
    closeQuietly(ctx.db);
  }
}

// --- FR-241: triage (the ONE write) ----------------------------------------

/**
 * `POST /api/triage` — the only mutating handler in this file, and the only one
 * in the tier.
 *
 * IT CONTAINS NO QUERY LOGIC AT ALL. Validate -> look the action up in the
 * frozen map -> dispatch -> shape. It does not know what a suggestion is, it
 * cannot name a table, and there is no branch here that could write without
 * going through `gateway.dispatch`. That is what makes the AC "no raw SQL
 * anywhere in the server layer" true by CONSTRUCTION rather than by scan — the
 * scan is the backstop, not the argument.
 *
 * THREE OUTCOMES, DELIBERATELY DISTINGUISHABLE:
 *   - **400** — a malformed body. A client bug is not a degraded brain, and
 *     collapsing them makes both undiagnosable. This is the ONE place the
 *     dashboard refuses rather than degrades, because the degrade-shaped
 *     alternative would apply a mutation to a set the caller did not ask for.
 *   - **200 + `degraded`, `applied: 0`** — the write surface is down (no
 *     bundle, no brain, boot failed). *Disabled, not broken*: never a 500,
 *     never a stack trace, never a partial mutation.
 *   - **200 + per-id results** — dispatched. `failed > 0` is a NORMAL outcome
 *     (D6): each id is its own transaction and each failure carries the brain's
 *     verbatim message.
 *
 * The caller (`server.ts`) turns `ok:false` into the 400; everything else is a
 * 200 payload.
 */
export async function triage(
  body: unknown,
): Promise<{ status: number; payload: TriageResultPayload | { error: string } }> {
  const parsed = parseTriageBody(body, (a) => write.triageAction(a) !== null, {
    bulkAllowed: (a) => write.triageAction(a)?.bulk === true,
  });
  if (!parsed.ok) {
    return { status: 400, payload: { error: parsed.reason } };
  }

  const base = {
    action: parsed.action,
    requested: parsed.ids.length,
    applied: 0,
    failed: 0,
    results: [] as TriageResultPayload["results"],
    params: parsed.params,
    generated_at: now(),
  };

  // Belt-and-braces over `bootWriteEngine`'s own brain check: this keeps the
  // reason string identical to every other endpoint's on a machine with no
  // brain, so a missing brain reads the same everywhere.
  if (!brainPresent()) {
    return {
      status: 200,
      payload: { ...base, degraded: { reason: brainMissingReason() } },
    };
  }

  const dispatched = await write.dispatchTriage(
    parsed.action,
    parsed.ids,
    {
      ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
      ...(parsed.brief_id !== undefined ? { brief_id: parsed.brief_id } : {}),
    },
  );

  if (!dispatched.ok) {
    // The DISCRIMINATED cause, verbatim — `engine_unavailable` (packaging) and
    // `boot_failed` (a real brain that would not open) send an operator to
    // completely different places, and zero mutations happened either way.
    return { status: 200, payload: { ...base, degraded: { reason: dispatched.reason } } };
  }

  const applied = dispatched.results.filter((r) => r.ok).length;
  return {
    status: 200,
    payload: {
      ...base,
      applied,
      failed: dispatched.results.length - applied,
      results: dispatched.results,
      degraded: null,
    },
  };
}
