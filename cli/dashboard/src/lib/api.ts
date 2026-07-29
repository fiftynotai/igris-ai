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
};
