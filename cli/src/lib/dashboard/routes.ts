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
 *   - the EXISTING MAINTAINING-pinned CLI accessors — since TD-319 their
 *     READ-ONLY doors: `registry.ts#listProjectsReadonly`,
 *     `brain-db.ts#briefStatusSummaryReadonly`,
 *     `brain-db.ts#listInstancesReadonly` (D3-b1) and
 *     `verbs/context-docs.ts#buildContextDocsInventoryDigest` (FR-240 D8),
 *     whose `readProjectProfile` also opens read-only now.
 *
 * D3-b1 was a deliberate, operator-assented reading of scope item 2 as "no new
 * raw SQL in the server layer" rather than "only brain handlers": those
 * accessors are verbatim mirrors already pinned by MAINTAINING rows, so no new
 * drift surface is created. FR-240 exercised the reserved b2 option — pure
 * `db`-param modules brain-side, with the MCP handlers as their wrappers — so
 * the layer views reach the SAME queries the MCP tools run, with a read-only
 * handle, and there stays exactly ONE definition per query.
 *
 * READ-ONLY IS STRUCTURAL, NOT PROMISED (AC #7 / D2), AND SINCE TD-319 THAT
 * HOLDS WITH NO EXCEPTION. Every brain handle reachable from this file comes
 * from `bridge.openBrainReadonly()` or `bridge.openBrainReadonlyWithVec()`,
 * both of which set `query_only = ON`. A row write or DDL anywhere downstream
 * throws instead of mutating the operator's brain. Nothing here calls an MCP
 * handler — those run `getDb()`, which opens read-WRITE and migrates, and two
 * of them bump `access_count`.
 *
 * ONE MEASURED EXCEPTION, STATED RATHER THAN ROUNDED AWAY: on
 * `openBrainReadonly`'s R4 read-WRITE fallback (a WAL brain with no `-shm`),
 * `query_only = ON` refuses DDL and every row write but does NOT refuse a
 * `PRAGMA journal_mode` change. So "a GET cannot flip the journal mode" rests
 * on that pragma AND on no path here ever ISSUING that statement — the only
 * two `journal_mode` statements under `cli/src/lib` are inside the two
 * `getDb()`s, which are unreachable from this file. Measured on
 * better-sqlite3 11; the full matrix is in `registry.ts`'s
 * `listProjectsReadonly` docblock. Nothing machine-enforces the second half,
 * so do not add a `journal_mode` statement to a read path.
 *
 * FR-238 → FR-246 carried a disclosed EXCEPTION here: `/api/projects`,
 * `/api/summary`, `/api/context-docs` and `/api/context-doc` reached accessors
 * that opened read-WRITE, set `journal_mode = WAL` and, in `registry.ts`, ran
 * `CREATE TABLE IF NOT EXISTS projects`. TD-319 gave those accessors a second,
 * read-only door and pointed this file at it. The WRITE doors still exist and
 * are still correct for `igris register` / `igris doctor` / `igris init` — they
 * are simply no longer reachable from an HTTP GET.
 *
 * `POST /api/triage` remains the one and only write door on this surface.
 *
 * DEGRADED CONTRACT — every endpoint returns HTTP **200** with a
 * `degraded: {reason}` field and empty data. Never a 500, never a stack trace.
 * A degraded brain is an ordinary state of a personal lens, not an error.
 */

import { existsSync } from "node:fs";
import {
  briefStatusSummaryReadonly,
  listInstancesReadonly,
} from "../brain-db.js";
import { listProjectsReadonly } from "../registry.js";
import { brainDbPath } from "../paths.js";
import * as bridge from "../brain-bridge.js";
import { resolveDefaultProject } from "./default-project.js";
import { composeQueryTwin } from "./graph-query.js";
import { grepDocs, readDoc, readInventory } from "./context-docs-read.js";
import * as write from "../brain-write-bridge.js";
import {
  BRIEF_FILTERS,
  GOAL_FILTERS,
  LEARNING_FILTERS,
  SEARCH_FILTERS,
  SUGGESTION_FILTERS,
  parseFilters,
  parseLayers,
  parsePageParams,
  parseQuery,
  parseTriageBody,
} from "./params.js";
import {
  DECLARED_LAYERS,
  FUSION_RRF_K,
  appliedParams,
  fuseLayers,
  fusionWeights,
  retrievalAvailability,
  type LayerRanking,
} from "./search-fuse.js";
import type {
  BrainGraphPayload,
  BrainGraphStatsPayload,
  BriefDetailPayload,
  BriefListRowPayload,
  BriefSearchRowPayload,
  BriefRetrievalPayload,
  BriefsPayload,
  BriefsSearchPayload,
  ContextDocPayload,
  ContextDocRowPayload,
  ContextDocsPayload,
  DashboardProject,
  FusedLayerReportPayload,
  FusedSearchPayload,
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
  RetrievalPayload,
  SearchLayerId,
  SearchRankBasis,
  SuggestionRowPayload,
  SuggestionsPayload,
  SubstringSearchPayload,
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
 * `GET /api/projects` — via `registry.ts#listProjectsReadonly()`.
 *
 * The READ-ONLY door (TD-319), not `listProjects()`. Same projection, same
 * order; it just cannot flip the journal mode or CREATE the `projects` table.
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
    const rows: DashboardProject[] = listProjectsReadonly().map((r) => ({
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
 * `briefStatusSummaryReadonly` and `listInstancesReadonly` — the TD-319
 * READ-ONLY doors — both carry their own L-133 table preflight, so a brain
 * missing the migration yields empty counts rather than a throw. The try/catch
 * below is the belt for anything below that (a corrupt file, a locked DB).
 *
 * `listInstancesReadonly` also skips the TD-277 `ALTER TABLE … RENAME COLUMN`
 * its read-write twin performs; an un-upgraded brain is projected, not
 * migrated, because a GET must not run DDL.
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
    const briefs = briefStatusSummaryReadonly(project);
    const instances = listInstancesReadonly(
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
 * `GET /api/briefs/search?q=<query>` — hybrid BM25 + vector recall over briefs.
 *
 * **THE ONLY NEW PATH IN FR-246.** Goals, context docs, suggestions and
 * candidates take a `q` PARAMETER on paths that already exist, which is what
 * keeps MAINTAINING row 109's sweep to one addition instead of five.
 *
 * Like `/api/learnings/search`, this is one of only TWO endpoints that need
 * `openBrainReadonlyWithVec`: `isVectorSearchAvailable(db)` probes
 * `SELECT vec_version()` on THAT connection, so a plain read-only handle would
 * make the reader take its BM25-only arm SILENTLY.
 *
 * TWO THINGS THIS PATH REPORTS THAT THE LEARNINGS TWIN DOES NOT NEED TO:
 *
 *  - `bm25_reason`. `learnings_fts` has existed since schema v1; `briefs_fts`
 *    arrives at **v23**. A brain that has not booted the migration — or where
 *    v23 aborted on an unverifiable backup snapshot — has a live vector arm and
 *    no lexical one, and that must be stated rather than rendered as a thinner
 *    list.
 *  - `content_length` instead of a preview. There is no `preview` field here
 *    because the row carries no body at all (FR-240 D7): brief bodies average
 *    ~3.9 KB and a ranked list of them is the payload term the read layer
 *    exists to remove.
 *
 * ZERO SQL, as everywhere in this file: the query lives in
 * `briefs-read.ts#hybridSearchBriefs`, which `igris_brief_similar` does NOT
 * call — that tool keeps its own pure-vector reader (D1-b), because it
 * thresholds on cosine similarity and a BM25 hit has none.
 */
export async function briefsSearch(
  search: URLSearchParams,
): Promise<BriefsSearchPayload> {
  const page = parsePageParams(search, { limit: 20 });
  const filters = parseFilters(search, BRIEF_FILTERS, ["limit", "offset", "q"]);
  const parsed = parseQuery(search);
  const notes = [...page.rejected, ...filters.rejected];

  // `BRIEF_FILTERS` is REUSED here so `?status=Ready` is recognised rather than
  // reported as an unknown param — it IS a real brief filter, just not one this
  // path can bind. But reuse alone would then SWALLOW it: `parseFilters` would
  // accept it into `filters.values`, nothing below would forward it, and the
  // operator would be told nothing. That is strictly worse than not sharing the
  // spec list at all, because passing the list is what CONVERTS a visible
  // `unknown filter: status` note into a silent drop.
  //
  // So every filter this endpoint cannot bind is dropped AND NAMED — the same
  // drop-and-report posture `learningsSearch` uses for `category` / `scope` /
  // `provenance`. NB it no longer uses that posture for `review_status`:
  // BR-085 moved that one into BOUND_BY, so the loop `continue`s and it is
  // never named. Do not cite it as the exemplar here — that is the mistake
  // this file already records against itself ~250 lines down, and it is the
  // one a reader would repeat.
  //
  // Drop-and-report is also the shape the FR-246 sign-off requires: *a
  // parameter this brief parses must be
  // forwarded, or must not be parsed.* `hybridSearchBriefs` binds `q`, `project`
  // and `limit` and nothing else; widening it to rank a filtered subcorpus is a
  // retrieval decision, not a plumbing one.
  //
  // Enumerated from `BRIEF_FILTERS` at RUNTIME rather than hand-listed, so a
  // fifth brief filter added to `params.ts` cannot land here unreported.
  for (const spec of BRIEF_FILTERS) {
    if (spec.name === "project") continue;
    if (filters.values[spec.name] !== undefined) {
      notes.push(
        `${spec.name}: dropped — ranked recall binds only q + project; filter by ${spec.name} on /api/briefs`,
      );
    }
  }

  const emptyRetrieval = {
    mode: "none" as const,
    vector_available: false,
    embedding_available: false,
    bm25_hits: 0,
    vector_hits: 0,
    rrf_k: 60,
    weights: { bm25: 0.5, vector: 0.5 },
    reason: null,
    bm25_reason: null,
  };
  const base = {
    query: parsed.ok ? parsed.query : "",
    items: [] as BriefSearchRowPayload[],
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
    const r = await readers.hybridSearchBriefs(handle.db, {
      query: parsed.query,
      project: filters.values.project,
      limit: page.limit,
    });

    // A hydration miss is dropped rather than shipped as a placeholder row —
    // the learnings twin's reasoning, unchanged.
    const items: BriefSearchRowPayload[] = r.rows
      .filter((e) => e.row !== null)
      .map((e) => {
        const row = e.row as NonNullable<typeof e.row>;
        return {
          id: row.id,
          project: row.project,
          brief_id: row.brief_id,
          brief_type: row.brief_type ?? null,
          title: row.title,
          status: row.status,
          priority: row.priority ?? null,
          effort: row.effort ?? null,
          phase: row.phase ?? null,
          updated_at: row.updated_at,
          content_length: row.content_length,
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
        // `vector_available` forwarded VERBATIM — the probe is the
        // authoritative answer to "can this connection run vector search", a
        // strictly different fact from "the vector arm contributed" (which
        // `mode` and `vector_hits` carry). Only the REASON is enriched, and
        // only when the bridge knows a better one than the reader can.
        reason: handle.vector_reason ?? r.retrieval.reason,
      },
      degraded: null,
    };
  } catch (err) {
    return {
      ...base,
      degraded: { reason: `brief search failed: ${messageOf(err)}` },
    };
  } finally {
    closeQuietly(handle.db);
  }
}

// --- FR-248: the fused cross-layer search ----------------------------------

/**
 * Which layers rank by RELEVANCE and which by their own list order.
 *
 * MEASURED FROM FR-246'S CODE, not assumed: `hybridSearchBriefs` and
 * `hybridSearchLearnings` fuse BM25 against a vector arm; `listGoals`,
 * `listSuggestions` and `grepDocs` run `LIKE '%q%'` (or a file grep) and return
 * the list's own order — a deadline, a priority band, a catalog position. THREE
 * OF THE FIVE ARE SUBSTRING. That asymmetry is the whole of AC-5 and it is
 * carried on the layer block AND on every row, because labelling the layer
 * alone leaves a reader looking at one result unable to tell what its position
 * means.
 */
const RANK_BASIS: Record<SearchLayerId, SearchRankBasis> = {
  briefs: "rrf",
  learnings: "rrf",
  goals: "substring",
  suggestions: "substring",
  "context-docs": "substring",
};

/**
 * The `retrieval` block a RETRIEVAL layer carries when its arm never ran.
 *
 * It is emitted rather than left null so invariant 3 (`retrieval` XOR `search`)
 * holds on EVERY layer on EVERY path, including the degraded ones. A layer that
 * dropped its block when it failed would make the honesty contract hold exactly
 * when nothing was wrong.
 */
function emptyFusedRetrieval(reason: string | null): BriefRetrievalPayload {
  return {
    mode: "none",
    vector_available: false,
    embedding_available: false,
    bm25_hits: 0,
    vector_hits: 0,
    rrf_k: 60,
    weights: { bm25: 0.5, vector: 0.5 },
    reason,
    bm25_reason: null,
  };
}

/**
 * A layer that produced nothing, with the reason it produced nothing.
 *
 * `fields: []` on the substring side is deliberate and is not a placeholder: no
 * grep ran, so no fields were searched. Naming them anyway would put a SECOND
 * definition of each reader's field list in this file — the drift FR-246's
 * "forward the reader's own block" rule exists to prevent.
 */
function outLayer(
  layer: SearchLayerId,
  requested: boolean,
  reason: string,
): FusedLayerReportPayload {
  const basis = RANK_BASIS[layer];
  return {
    layer,
    requested,
    available: false,
    reason,
    rank_basis: basis,
    hits: 0,
    contributed: 0,
    retrieval: basis === "rrf" ? emptyFusedRetrieval(reason) : null,
    search: basis === "rrf" ? null : { mode: "substring", fields: [] },
    applied: [],
  };
}

/** One arm's outcome: its standing, plus its ranked rows when it has any. */
interface ArmOutcome {
  report: FusedLayerReportPayload;
  ranking: LayerRanking | null;
}

/**
 * `GET /api/search?q=<query>&project=<slug>&limit=&layers=<csv>` — FR-248.
 *
 * ONE ranked list over all five layers, fused by RANK. The eighteenth endpoint
 * path and the seventeenth GET.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE HANDLE, FIVE READERS — AND IT MUST BE THE `WithVec` ONE
 * ─────────────────────────────────────────────────────────────────────────
 * `openBrainReadonlyWithVec()` is opened ONCE and passed to all four brain
 * readers. Every other endpoint in this tier opens, calls one reader and
 * closes; this is the first to share a handle, which is why
 * `dashboard-readonly.test.ts` names it as well as crawling it.
 *
 * The `WithVec` door is not a preference. `isVectorSearchAvailable(db)` probes
 * `SELECT vec_version()` on THAT connection, so a plain `openBrainReadonly`
 * would make BOTH hybrid arms take their BM25-only path **silently** — a
 * degradation invisible in the payload, which is the exact failure AC-4 names.
 * `handle.vector_reason` is forwarded into each retrieval layer's report the
 * same way `briefsSearch` does it: the reader can say "sqlite-vec not loaded",
 * but only the bridge knows WHY.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * `Promise.allSettled`, NOT ONE `try`/`catch` — THIS IS THE AC-4 MECHANISM
 * ─────────────────────────────────────────────────────────────────────────
 * better-sqlite3 is synchronous, so this parallelises almost nothing (only the
 * two embedding calls, which latch after the first). It is chosen for FAILURE
 * ISOLATION. The five arms report unavailability in THREE different shapes —
 * `listGoals` THROWS on an absent table, `listSuggestions` returns
 * `degraded: string`, `readInventory` returns `{ok:false, reason}` — and an
 * outer catch would collapse any one of them into a whole-response degrade,
 * which is the precise opposite of "the response SAYS which layer is out".
 *
 * `layers[]` therefore carries one entry PER DECLARED LAYER on every path,
 * including the ones that return before a single arm runs. A layer is never
 * absent, only `available: false` — which is what makes a silent drop
 * unrepresentable rather than merely untested.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BR-085, IN ITS FUSED VARIANT
 * ─────────────────────────────────────────────────────────────────────────
 * This endpoint binds `q` + `project` + `limit` + `layers` AND NOTHING ELSE,
 * and each layer's `applied` is derived from THAT ARM'S OWN OPTIONS OBJECT via
 * `appliedParams`, whose map is typed `keyof typeof opts` so a false binding
 * claim fails to COMPILE. Per-layer rather than per-response, because the new
 * variant of BR-085's defect on a fused surface is a filter that binds on some
 * arms and not others: a whole-response claim would be true on average.
 *
 * `parseQuery` (not the `q`-as-filter form): an empty `q` REFUSES, matching
 * `/api/briefs/search`. A search with no query is not a search with a default.
 */
export async function fusedSearch(
  search: URLSearchParams,
): Promise<FusedSearchPayload> {
  const page = parsePageParams(search, { limit: 20 });
  const filters = parseFilters(search, SEARCH_FILTERS, ["limit", "q", "layers"]);
  const parsed = parseQuery(search);
  const picked = parseLayers(search, DECLARED_LAYERS);
  const notes = [...page.rejected, ...filters.rejected, ...picked.rejected];

  const project = filters.values.project;
  const limit = page.limit;
  const requested = new Set(picked.layers as SearchLayerId[]);

  // `offset` is parsed by `parsePageParams` and cannot be forwarded: rank
  // fusion over five arms has no stable offset semantics. Silently serving page
  // one for `?offset=20` is BR-085's shape with a page control.
  if (page.offset > 0) {
    notes.push(
      `offset: dropped — the fused list is one page; page a layer's own endpoint instead`,
    );
  }

  // TD-326 — scoping to a project HIDES a population that belongs to no
  // project. On the operator brain that is 377 of 1,210 pending suggestions.
  // "search everything" quietly meaning "everything that has a project" is
  // BR-085's shape one level up, so it is stated whenever it applies.
  if (project !== undefined && requested.has("suggestions")) {
    notes.push(
      `suggestions: project=${project} hides the brain-level queue (project_slug IS NULL) — those rows belong to no project and a scoped search cannot reach them`,
    );
  }

  /** The whole-response failure shape: five stated unavailabilities. */
  const allOut = (reason: string): FusedSearchPayload => ({
    query: parsed.ok ? parsed.query : "",
    items: [],
    count: 0,
    layers: DECLARED_LAYERS.map((l) => outLayer(l, requested.has(l), reason)),
    fusion: {
      rrf_k: FUSION_RRF_K,
      weights: fusionWeights(),
      substring_layers: [],
    },
    params: notes,
    generated_at: now(),
    degraded: { reason },
  });

  if (!parsed.ok) return allOut(parsed.reason);
  if (!brainPresent()) return allOut(brainMissingReason());

  const readers = await bridge.loadLayerReaders();
  if (readers === null) {
    return allOut(
      bridge.lastLayerReadersFailure() ??
        "brain read layer could not be loaded from the vendored bundle",
    );
  }
  const handle = await bridge.openBrainReadonlyWithVec();
  if (handle === null) {
    return allOut(
      `brain database at ${brainDbPath()} could not be opened read-only`,
    );
  }

  const query = parsed.query;
  const NOT_REQUESTED = `not requested — ?layers= narrowed this search to ${picked.layers.join(", ")}`;

  // --- the five arms -------------------------------------------------------
  //
  // Each one is its own async thunk so `Promise.allSettled` can isolate its
  // failure. Each converts the THREE shapes of unavailability its reader uses
  // into the ONE `LayerReport` shape the wire carries.

  const briefsArm = async (): Promise<ArmOutcome> => {
    const opts = { query, project, limit };
    const BOUND_BY: ReadonlyMap<string, keyof typeof opts> = new Map([
      ["q", "query"],
      ["project", "project"],
      ["limit", "limit"],
    ]);
    const r = await readers.hybridSearchBriefs(handle.db, opts);
    // `vector_available` is forwarded VERBATIM — the probe is the authoritative
    // answer to "can this connection run vector search", a strictly different
    // fact from "the vector arm contributed". Only the REASON is enriched.
    const retrieval: BriefRetrievalPayload = {
      ...r.retrieval,
      reason: handle.vector_reason ?? r.retrieval.reason,
    };
    const avail = retrievalAvailability(retrieval);
    // A hydration miss is dropped rather than shipped as a placeholder row, so
    // `hits` counts what could actually be contributed — an over-claimed `hits`
    // would make invariant 5's `contributed <= hits` pass for the wrong reason.
    const rows = r.rows
      .filter((e) => e.row !== null)
      .map((e) => {
        const row = e.row as NonNullable<typeof e.row>;
        return {
          // BR-078: a brief id alone names a different brief in 25 projects, so
          // the address is the PAIR. `key` composes both, which is what keeps
          // the fused list's keys unique when `BR-001` matches twice.
          ref: { project: row.project, id: row.brief_id },
          title: row.title,
          subtitle: `${row.brief_type ?? "brief"} · ${row.status}`,
          updated_at: row.updated_at,
          rrf_score: e.rrf_score,
        };
      });
    return {
      report: {
        layer: "briefs",
        requested: true,
        available: avail.available,
        reason: avail.reason,
        rank_basis: RANK_BASIS.briefs,
        hits: rows.length,
        contributed: 0,
        retrieval,
        search: null,
        applied: appliedParams(opts, BOUND_BY),
      },
      ranking: avail.available
        ? { layer: "briefs", rank_basis: RANK_BASIS.briefs, rows }
        : null,
    };
  };

  const learningsArm = async (): Promise<ArmOutcome> => {
    // `review_status` is NOT bound. The reader defaults it to `approved` — the
    // FR-109 conscious channel — and widening a fused "what do we know about X"
    // to unreviewed candidates is a retrieval decision this brief does not
    // make. It is not silently dropped either: it is not in `SEARCH_FILTERS`,
    // so `parseFilters` reports `unknown filter: review_status`.
    const opts = { query, project, limit };
    const BOUND_BY: ReadonlyMap<string, keyof typeof opts> = new Map([
      ["q", "query"],
      ["project", "project"],
      ["limit", "limit"],
    ]);
    const r = await readers.hybridSearchLearnings(handle.db, opts);
    const retrieval: RetrievalPayload = {
      ...r.retrieval,
      reason: handle.vector_reason ?? r.retrieval.reason,
    };
    // No `bm25_reason` key: `learnings_fts` has existed since schema v1, so
    // this layer's lexical arm cannot be structurally missing.
    const avail = retrievalAvailability(retrieval);
    const rows = r.rows
      .filter((e) => e.row !== null)
      .map((e) => {
        const row = e.row as NonNullable<typeof e.row>;
        return {
          ref: { project: row.project, id: String(row.id) },
          title: row.title,
          subtitle: row.category,
          updated_at: row.created_at,
          rrf_score: e.rrf_score,
        };
      });
    return {
      report: {
        layer: "learnings",
        requested: true,
        available: avail.available,
        reason: avail.reason,
        rank_basis: RANK_BASIS.learnings,
        hits: rows.length,
        contributed: 0,
        retrieval,
        search: null,
        applied: appliedParams(opts, BOUND_BY),
      },
      ranking: avail.available
        ? { layer: "learnings", rank_basis: RANK_BASIS.learnings, rows }
        : null,
    };
  };

  const goalsArm = async (): Promise<ArmOutcome> => {
    // `listGoals` THROWS on an absent table — no `degraded` field. That throw
    // is the whole reason this is a thunk under `allSettled`.
    const opts = { q: query, project, limit, offset: 0 };
    const BOUND_BY: ReadonlyMap<string, keyof typeof opts> = new Map([
      ["q", "q"],
      ["project", "project"],
      ["limit", "limit"],
    ]);
    const r = readers.listGoals(handle.db, opts);
    const rows = r.goals.map((g) => ({
      ref: { project: g.project_slug, id: g.goal_id },
      title: g.title,
      subtitle: g.deadline === null ? g.status : `${g.status} · ${g.deadline}`,
      updated_at: g.updated_at,
      // No relevance score exists for a `LIKE`, and inventing one here is
      // precisely the laundering scope item 5 forbids.
      rrf_score: null,
    }));
    return {
      report: {
        layer: "goals",
        requested: true,
        available: true,
        reason: null,
        rank_basis: RANK_BASIS.goals,
        hits: rows.length,
        contributed: 0,
        retrieval: null,
        // The reader's OWN block, forwarded. Never a field list written here.
        search: r.search,
        applied: appliedParams(opts, BOUND_BY),
      },
      ranking: { layer: "goals", rank_basis: RANK_BASIS.goals, rows },
    };
  };

  const suggestionsArm = async (): Promise<ArmOutcome> => {
    // `project` on the wire, `project_slug` in the table — the shared project
    // selector emits `project` on every page.
    const opts = { q: query, project_slug: project, limit, offset: 0 };
    const BOUND_BY: ReadonlyMap<string, keyof typeof opts> = new Map([
      ["q", "q"],
      ["project", "project_slug"],
      ["limit", "limit"],
    ]);
    const r = readers.listSuggestions(handle.db, opts);
    // The THIRD shape: this reader reports an absent table through its own
    // `degraded` string rather than throwing.
    if (r.degraded !== null) {
      return {
        report: {
          ...outLayer("suggestions", true, r.degraded),
          applied: appliedParams(opts, BOUND_BY),
        },
        ranking: null,
      };
    }
    const rows = r.suggestions.map((s) => ({
      ref: { project: s.project_slug, id: String(s.id) },
      title: s.title,
      subtitle: `${s.source_module} · ${s.priority}`,
      updated_at: s.created_at,
      rrf_score: null,
    }));
    return {
      report: {
        layer: "suggestions",
        requested: true,
        available: true,
        reason: null,
        rank_basis: RANK_BASIS.suggestions,
        hits: rows.length,
        contributed: 0,
        retrieval: null,
        search: r.search,
        applied: appliedParams(opts, BOUND_BY),
      },
      ranking: { layer: "suggestions", rank_basis: RANK_BASIS.suggestions, rows },
    };
  };

  const contextDocsArm = async (): Promise<ArmOutcome> => {
    const opts = { q: query, project, limit };
    const BOUND_BY: ReadonlyMap<string, keyof typeof opts> = new Map([
      ["q", "q"],
      ["project", "project"],
      ["limit", "limit"],
    ]);
    const applied = appliedParams(opts, BOUND_BY);
    if (project === undefined) {
      return {
        report: {
          ...outLayer(
            "context-docs",
            true,
            "context docs are addressed per project — supply ?project=<slug>",
          ),
          applied,
        },
        ranking: null,
      };
    }
    // The SECOND shape: `{ok:false, reason}`.
    const inventory = readInventory(project);
    if (!inventory.ok) {
      return {
        report: { ...outLayer("context-docs", true, inventory.reason), applied },
        ranking: null,
      };
    }
    if (inventory.digest.degraded) {
      // An incomplete inventory means the doc LIST could not be determined, so
      // a grep over it cannot claim to have covered the corpus. Reported as
      // unavailable with the same sentence `/api/context-docs` already uses for
      // this state, rather than as an honest-looking empty result.
      return {
        report: {
          ...outLayer(
            "context-docs",
            true,
            "inventory incomplete: project profile or catalog data missing",
          ),
          applied,
        },
        ranking: null,
      };
    }
    const hits = grepDocs(project, query, inventory.digest.docs).slice(0, limit);
    const rows = hits.map((hit) => ({
      ref: { project, id: hit.type },
      title: hit.type,
      subtitle: hit.matches[0]?.snippet ?? null,
      updated_at: null,
      rrf_score: null,
    }));
    return {
      report: {
        layer: "context-docs",
        requested: true,
        available: true,
        reason: null,
        rank_basis: RANK_BASIS["context-docs"],
        hits: rows.length,
        contributed: 0,
        retrieval: null,
        // Written here rather than forwarded because this arm has no reader to
        // forward from — it really is a file grep, and `body` says so instead
        // of naming a column that would imply an index.
        search: { mode: "substring", fields: ["body"] },
        applied: appliedParams(opts, BOUND_BY),
      },
      ranking: { layer: "context-docs", rank_basis: RANK_BASIS["context-docs"], rows },
    };
  };

  const ARMS: Record<SearchLayerId, () => Promise<ArmOutcome>> = {
    briefs: briefsArm,
    learnings: learningsArm,
    goals: goalsArm,
    suggestions: suggestionsArm,
    "context-docs": contextDocsArm,
  };

  try {
    // Derived from `DECLARED_LAYERS`, so a sixth layer cannot be added to the
    // union and forgotten here — the dispatch is the map, never a chain of
    // `else`s that would send a new id to whichever arm sits last.
    const run = DECLARED_LAYERS.map((layer) =>
      requested.has(layer)
        ? ARMS[layer]()
        : Promise.resolve<ArmOutcome>({
            report: outLayer(layer, false, NOT_REQUESTED),
            ranking: null,
          }),
    );
    const settled = await Promise.allSettled(run);

    const reports: FusedLayerReportPayload[] = [];
    const rankings: LayerRanking[] = [];
    settled.forEach((outcome, i) => {
      const layer = DECLARED_LAYERS[i] as SearchLayerId;
      if (outcome.status === "rejected") {
        // The FIRST shape: the reader threw. Normalised here, per arm, so one
        // dead layer cannot take the other four with it.
        reports.push(
          outLayer(
            layer,
            requested.has(layer),
            `${layer} search failed: ${messageOf(outcome.reason)}`,
          ),
        );
        return;
      }
      reports.push(outcome.value.report);
      if (outcome.value.ranking !== null) rankings.push(outcome.value.ranking);
    });

    const items = fuseLayers(rankings, limit);
    for (const report of reports) {
      report.contributed = items.filter((r) => r.layer === report.layer).length;
    }

    const anyAvailable = reports.some((r) => r.available);
    return {
      query,
      items,
      count: items.length,
      layers: reports,
      fusion: {
        rrf_k: FUSION_RRF_K,
        weights: fusionWeights(),
        // D1's mandatory readout, as data: the substring layers that actually
        // CONTRIBUTED. A layer that returned nothing has nothing to warn about,
        // and listing it would train the reader to ignore the warning.
        substring_layers: reports
          .filter((r) => r.rank_basis === "substring" && r.contributed > 0)
          .map((r) => r.layer),
      },
      params: notes,
      generated_at: now(),
      // A single dead layer is `layers[]`'s job, NOT a whole-response degrade —
      // four working layers is a working search. Zero working layers is not,
      // and that one IS stated here as well as per-layer.
      degraded: anyAvailable
        ? null
        : { reason: "no layer could be searched — see layers[] for each cause" },
    };
  } finally {
    closeQuietly(handle.db);
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
  // `q` is IN `LEARNING_FILTERS` now, so it is parsed, allow-listed and
  // FORWARDED below. It is not in the ignore list: a param this route parses
  // must be forwarded or must not be parsed (BR-085's shape, not repeated).
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
    search: null as SubstringSearchPayload | null,
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
      q: filters.values.q,
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
      search: r.search,
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
 * THIS IS ONE OF TWO ENDPOINTS THAT NEED `openBrainReadonlyWithVec` — the
 * other is `briefsSearch` (see its docstring above, which says so too).
 * FR-246 made it two; this line said ONE for one review round while the
 * docstring 290 lines up already said TWO, so the file argued both ways.
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
 *
 * BR-085 — `review_status` IS FORWARDED, AND THE PAYLOAD ECHOES WHAT THE READER
 * APPLIED. Until BR-085 this handler parsed the filter and did not pass it on,
 * while `Learnings.tsx` bannered "SHOWING PENDING REVIEW ROWS" over approved
 * ones. FR-246 made the drop audible; BR-085 removes it. Two properties are
 * load-bearing and are asserted in `dashboard-learnings-search-params.test.ts`
 * (NOT `dashboard-learnings-search.test.ts`, which contains no `review_status`
 * assertion at all — a citation pointing confidently at the wrong file sends
 * the next reader somewhere that looks authoritative and is not):
 *
 *   1. EVERY allow-listed filter is either FORWARDED or NAMED. The drop notes
 *      below are derived from `LEARNING_FILTERS` minus the keys this handler
 *      actually binds, so a seventh learning filter cannot land here unreported
 *      — the defect CLASS, closed, rather than this one instance.
 *   2. The banner's scope comes from `r.review_status` — the reader's own echo —
 *      never from `reviewStatus` (the request). They differ exactly when the
 *      loaded read layer is an older VENDORED bundle than this file, which is a
 *      routine state in a repo checkout mid-build. In that case the request is
 *      un-honourable and the payload says `approved` plus a note, rather than
 *      re-committing BR-085's original lie with newer code.
 */
export async function learningsSearch(
  search: URLSearchParams,
): Promise<LearningsSearchPayload> {
  const page = parsePageParams(search, { limit: 20 });
  // `q` is BOTH a `LEARNING_FILTERS` member (FR-246, for the browse path) and
  // this route's QUERY. Here the query wins: `parseQuery` refuses an empty one,
  // where the filter form would silently mean "no filter". `filters.values.q`
  // is deliberately unused below — `parsed.query` is the forwarded value.
  const filters = parseFilters(search, LEARNING_FILTERS, ["limit", "offset", "q"]);
  const parsed = parseQuery(search);
  const notes = [...page.rejected, ...filters.rejected];

  const reviewStatus = filters.values.review_status ?? DEFAULT_REVIEW_STATUS;

  // The forwarded options, built BEFORE the drop report so the report can be
  // derived from them. This ordering is the fix to BR-085's CLASS: the list of
  // "what this handler binds" is no longer a comment that can go stale beside
  // the call, it is the object being passed.
  const searchOpts = {
    query: parsed.ok ? parsed.query : "",
    project: filters.values.project,
    review_status: reviewStatus,
    limit: page.limit,
  };

  /**
   * Wire filter name → the `HybridSearchOptions` key it binds.
   *
   * `q` maps to `query` (the route's own parse, see above), so it is bound
   * despite the names differing — which is exactly why this is a MAP and not a
   * `Set` of names: a name-equality check would have called `q` unbound and
   * reported a drop for the one parameter this endpoint exists to use.
   *
   * The VALUES are unused at runtime and are not decoration: typing them
   * `keyof typeof searchOpts` makes the map fail to COMPILE if it claims a
   * binding the options object does not have. Removing a key from `searchOpts`
   * without removing it here — the way BR-085 would come back — is a type
   * error, and if it somehow were not, the loop would then report the drop.
   */
  const BOUND_BY: ReadonlyMap<string, keyof typeof searchOpts> = new Map([
    ["project", "project"],
    ["review_status", "review_status"],
    ["q", "query"],
  ]);

  // Enumerated from `LEARNING_FILTERS` at RUNTIME rather than hand-listed —
  // `briefsSearch`'s posture, applied to its twin. `category`, `scope` and
  // `provenance` are allow-listed by the shared spec list and CANNOT be bound by
  // ranked recall (filtering a fused subcorpus is a retrieval decision, barred
  // from this brief), so they are NAMED. Before BR-085 they were dropped in
  // silence — the same shape as `review_status`, in the same handler.
  for (const spec of LEARNING_FILTERS) {
    if (BOUND_BY.has(spec.name)) continue;
    if (filters.values[spec.name] !== undefined) {
      notes.push(
        `${spec.name}: dropped — ranked recall binds only q + project + review_status; filter by ${spec.name} on /api/learnings`,
      );
    }
  }

  // `offset` is PARSED by `parsePageParams` and cannot be forwarded: RRF over
  // two arms has no stable offset semantics, so there is no second page to
  // serve. Silently returning page one for `?offset=20` is BR-085's shape with
  // a page control instead of a filter, so it is named too.
  if (page.offset > 0) {
    notes.push(
      `offset: dropped — ranked recall returns one fused page; page /api/learnings instead`,
    );
  }

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
    // Every path below that returns `base` unmodified is a path on which NO
    // read happened, so no scope was applied and none may be claimed. It reads
    // `approved` — the value that renders NO scope banner — rather than the
    // request: a degraded search must show the degraded banner and nothing
    // else. Over-claiming here would be BR-085 with an empty list instead of a
    // wrong one.
    review_status: DEFAULT_REVIEW_STATUS,
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
    const r = await readers.hybridSearchLearnings(handle.db, searchOpts);

    // WHAT THE READER APPLIED, not what we asked for. A read layer built before
    // BR-085 has no `review_status` in its result — and its behaviour is known
    // exactly: every such build hard-gated `approved` on both arms, so the
    // fallback below is the truth about those rows and not a guess. The
    // mismatch is NAMED, because "your filter did nothing" is information the
    // operator can act on (rebuild) and a silently ignored filter is not.
    const applied = r.review_status ?? DEFAULT_REVIEW_STATUS;
    const appliedNotes =
      applied === searchOpts.review_status
        ? []
        : [
            // Phrased about the DISAGREEMENT, not its cause. The condition is
            // "the reader applied a scope other than the one asked for";
            // predating BR-085 is only today's reason for that, and a future
            // reader clamping for some other reason would be misdiagnosed by a
            // cause-shaped message. The rebuild stays as the likely remedy.
            `review_status: asked ${searchOpts.review_status}, applied ${applied} — the loaded brain read layer did not honour the requested scope (most likely a vendored bundle predating BR-085; rebuild it)`,
          ];

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
      review_status: applied,
      params: [...notes, ...appliedNotes],
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
 * D8: NO SQL and no query of its own. This forwards
 * `verbs/context-docs.ts#buildContextDocsInventoryDigest`, which already
 * computes exists / applies / missing_applicable / remediation. `applies_when`
 * is NOT re-derived here — a second evaluator would diverge from the catalog's
 * the first time either changed.
 *
 * THIS ENDPOINT DOES OPEN THE BRAIN, AND IT OPENS IT TWICE. An earlier version
 * of this block said "NO brain work at all" and "never opens the brain, so it
 * works on a machine with no brain database at all". Both were false when
 * written, and the second is provably false by a test in this repo:
 * `context-docs-read.ts#readInventory` returns `ok: false, "brain database not
 * found"` on exactly that machine, and `dashboard-context-docs.test.ts` pins
 * it. The two doors are `context-docs-read.ts#isKnownProject` (the slug
 * allowlist) and `brain-db.ts#readProjectProfile` (the profile row) — since
 * TD-319 both go through `openBrainReadonly`, and both are driven by G-RO-5's
 * delete-mode loop.
 *
 * That correction matters beyond accuracy: "this endpoint doesn't touch the
 * brain" is exactly the licence someone would need to undo TD-319 and put a
 * read-write handle back on this path. It is also why a fix confined to the
 * slug allowlist would have failed this brief's AC #1 — reverting only
 * `readProjectProfile` still flips a delete-mode brain's journal mode.
 *
 * The `degraded` field carries an unregistered slug, an unreadable catalog and
 * an absent brain alike.
 */
export function contextDocs(search: URLSearchParams): ContextDocsPayload {
  const project = search.get("project");
  const base = {
    project,
    archetype: null,
    tech_stack: null,
    inventory_degraded: false,
    docs: [] as ContextDocRowPayload[],
    missing_applicable: [],
    remediation: [],
    search: null as SubstringSearchPayload | null,
    generated_at: now(),
  };

  if (project === null || project.length === 0) {
    return { ...base, degraded: { reason: "'project' is required" } };
  }

  const result = readInventory(project);
  if (!result.ok) return { ...base, degraded: { reason: result.reason } };

  const d = result.digest;

  // FR-246 — the body grep. `q` FILTERS the doc list to what matched and
  // annotates each survivor with its snippets. It is not applied to
  // `missing_applicable` / `remediation`: those are statements about docs that
  // do not exist, and there is no body to match.
  const q = search.get("q");
  let docs: ContextDocRowPayload[] = d.docs;
  let searchBlock: SubstringSearchPayload | null = null;
  if (q !== null && q.trim().length > 0) {
    const hits = new Map(grepDocs(project, q, d.docs).map((h) => [h.type, h]));
    docs = d.docs
      .filter((row) => hits.has(row.type))
      .map((row) => {
        const hit = hits.get(row.type) as NonNullable<ReturnType<typeof hits.get>>;
        return { ...row, matches: hit.matches, more_matches: hit.more };
      });
    // `body` rather than a column name: this really is a file grep, and naming
    // a column here would be the first step towards implying an index.
    searchBlock = { mode: "substring", fields: ["body"] };
  }

  return {
    project: d.project,
    archetype: d.archetype,
    tech_stack: d.tech_stack,
    inventory_degraded: d.degraded,
    docs,
    search: searchBlock,
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
    search: null as SubstringSearchPayload | null,
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
      q: filters.values.q,
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
      search: r.search,
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
 *
 * TD-326: this is the ONE endpoint that accepts `project_scope=brain-level`.
 * It is not a synonym for the unscoped read — see `params.ts#PROJECT_SCOPES`.
 */
export async function suggestions(
  search: URLSearchParams,
): Promise<SuggestionsPayload> {
  const page = parsePageParams(search);
  const filters = parseFilters(search, SUGGESTION_FILTERS, ["limit", "offset"]);
  const notes = [...page.rejected, ...filters.rejected];

  // TD-326 — the project axis has THREE states and they are mutually exclusive:
  // one project, `brain-level` (`project_slug IS NULL`), or unscoped
  // (`everything`, the predicate dropped). Both given is a contradiction whose
  // answer would be the empty set, so `project` is dropped AND named rather
  // than intersected — the drop-and-report posture, applied to the one input
  // pair that can silently produce zero rows.
  const brainLevel = filters.values.project_scope === "brain-level";
  if (brainLevel && filters.values.project !== undefined) {
    notes.push(
      `project: dropped — project_scope=brain-level matches rows that belong to NO project`,
    );
  }

  const base = {
    items: [] as SuggestionRowPayload[],
    count: 0,
    total: 0,
    limit: page.limit,
    offset: page.offset,
    facets: { source_module: {} as Record<string, number>, brain_level: 0 },
    search: null as SubstringSearchPayload | null,
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
      project_slug: brainLevel ? undefined : filters.values.project,
      project_is_null: brainLevel,
      status: filters.values.status,
      priority: filters.values.priority,
      source_module: filters.values.source_module,
      q: filters.values.q,
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
      search: r.search,
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
    // FR-247 — the map decides how an action is addressed. This route never
    // hand-lists which actions take refs; it asks.
    targetOf: (a) => write.triageAction(a)?.target ?? "id",
  });
  if (!parsed.ok) {
    return { status: 400, payload: { error: parsed.reason } };
  }

  // The resolved row's `target`, read ONCE: it decides the requested count AND
  // the dispatcher, and two lookups could not disagree but two READERS could.
  const target = write.triageAction(parsed.action)?.target;

  const base = {
    action: parsed.action,
    // Exactly one of the two is non-empty (`parseTriageBody` enforces it), so
    // the sum IS the count — EXCEPT for FR-249's subjectless row, where both
    // are empty and the request is nevertheless for exactly one mutation.
    // Without the branch a successful create reports `requested: 0, applied: 1`.
    requested: target === "none" ? 1 : parsed.ids.length + parsed.refs.length,
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

  // The extras are assembled ONCE for all THREE address kinds (`id`,
  // `brief-ref`, and FR-249's subjectless `none`). Each row's `extra`
  // allow-list is what decides which of them reaches the tool, so handing all
  // seven to any of the three dispatchers is not laxity — it is the single
  // place the allow-list is allowed to be the only filter. (Four extras and two
  // of each until FR-249; the counts move together and this comment is the one
  // place that says so, which is why it is written out rather than implied.)
  const extra = {
    ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
    ...(parsed.brief_id !== undefined ? { brief_id: parsed.brief_id } : {}),
    ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
    ...(parsed.goal_id !== undefined ? { goal_id: parsed.goal_id } : {}),
    ...(parsed.goal_title !== undefined ? { goal_title: parsed.goal_title } : {}),
    ...(parsed.goal_outcome !== undefined ? { goal_outcome: parsed.goal_outcome } : {}),
    ...(parsed.goal_project !== undefined ? { goal_project: parsed.goal_project } : {}),
  };

  // FR-247/FR-249 — ONE switch, on the resolved spec's `target`. Not a new
  // handler, not a new export, and still no SQL: every arm ends at
  // `gateway.dispatch(<a name from the frozen map>, args)`.
  const dispatched =
    target === "none"
      ? await write.dispatchSubjectless(parsed.action, extra)
      : target === "brief-ref"
        ? await write.dispatchBriefWrite(parsed.action, parsed.refs, extra)
        : await write.dispatchTriage(parsed.action, parsed.ids, extra);

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
