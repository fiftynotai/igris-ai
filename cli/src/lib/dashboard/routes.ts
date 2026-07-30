/**
 * FR-238 — the four read-only JSON endpoints. FR-239 adds a fifth
 * (`/api/graph`), which reaches the brain through the SAME `bridge.buildGraph`
 * door as `graphStats` and therefore inherits the zero-SQL scan below for free.
 *
 * THIS FILE CONTAINS ZERO SQL. That is a hard scope requirement of the brief,
 * and it is mechanically asserted by `dashboard-server.test.ts`.
 *
 * Every read goes through one of exactly two doors:
 *   - the FR-237 PURE builder, via `brain-bridge.ts` (MAINTAINING row 105);
 *   - the EXISTING MAINTAINING-pinned CLI accessors `registry.ts#listProjects`,
 *     `brain-db.ts#briefStatusSummary` and `brain-db.ts#listInstances` (D3-b1).
 *
 * D3-b1 is a deliberate, operator-assented reading of scope item 2 as "no new
 * raw SQL in the server layer" rather than "only brain handlers": those three
 * accessors are verbatim mirrors already pinned by MAINTAINING rows, so no new
 * drift surface is created. Lifting pure `db`-param modules brain-side (b2) is
 * FR-240's call, when it needs real depth.
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
import type {
  BrainGraphPayload,
  BrainGraphStatsPayload,
  DashboardProject,
  HealthPayload,
  ProjectsPayload,
  SummaryPayload,
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
  return {
    ok: true,
    cli_version: cliVersion,
    brain: { present, path: brainDbPath() },
    bridge: { available: probe.available, reason: probe.reason },
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
 * `GET /api/summary?project=<slug>` — brief counts + the active-instance count.
 *
 * `briefStatusSummary` and `listInstances` both carry their own L-133 table
 * preflight, so a brain missing the migration yields empty counts rather than a
 * throw. The try/catch below is the belt for anything below that (a corrupt
 * file, a locked DB).
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
  if (project === null) {
    return {
      project: null,
      briefs: empty,
      instances: { active: 0 },
      generated_at: now(),
      degraded: { reason: "no project selected" },
    };
  }
  try {
    const briefs = briefStatusSummary(project);
    const instances = listInstances({ project, status: "active" });
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
