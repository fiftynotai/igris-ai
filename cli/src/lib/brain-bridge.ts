/**
 * FR-238 (D3-A) — the CLI -> brain-bundle runtime bridge.
 *
 * WHY A RUNTIME IMPORT AND NOT A COMPILE-TIME ONE
 * ------------------------------------------------
 * Two true constraints meet here, and the resolution is a runtime `import()`:
 *
 *  - `MAINTAINING.md` row 105 names this file's brief: *"FR-238 MUST import the
 *    pure builder — never re-query `entity_edges` and never re-derive the
 *    key."* `architecture_map.md` § "Brain Engine — Pure Data Layer vs MCP
 *    Wrapper (FR-237)" says the same. Reproducing the SQL CLI-side is
 *    forbidden.
 *  - `brain-db.ts`'s module header records the opposing precedent: *"`cli/` and
 *    `brain-mcp-server/` are separate npm packages with zero cross-imports."*
 *    A compile-time `import` across that boundary is forbidden too.
 *
 * A dynamic `import()` of the VENDORED BUILD ARTIFACT satisfies both: no
 * TypeScript cross-package edge exists, and the one implementation of
 * `buildBrainGraph` is the one that runs.
 *
 * WHY THE IMPORT CHAIN IS SAFE
 * -----------------------------
 * `whole-graph.js` imports only `./handlers.js` (the edge VOCABULARY) and
 * `./graph-keys.js`. `handlers.js` reaches `db.js`, whose import-time deps are
 * `better-sqlite3` plus node builtins with NO import-time connection — `db.ts`
 * opens nothing until `getDb()` is called, which this path never does. So the
 * chain is importable without booting the brain.
 *
 * THE FAILURE MODE IS DEGRADATION, NOT A THROW
 * ---------------------------------------------
 * This is a PATH-LITERAL dependency on a build artifact (R2). If
 * `copy-templates.sh`'s staging layout moves, or the vendored `node_modules`
 * is absent (an extracted tarball before `postinstall`), the import fails.
 * Every entry point here returns `null` rather than throwing, and
 * `/api/health` surfaces `bridge.available` so the shell can render a visible
 * "brain engine unavailable" state. A silent degrade becomes a loud one.
 *
 * THE TYPE FACADE
 * ---------------
 * The boundary is untyped, so the `BrainGraph*` shapes are mirrored here
 * structurally, each carrying a `// whole-graph.ts:NN` source-line comment —
 * the same discipline `brain-db.ts` uses for its SQL mirrors, and the thing the
 * MAINTAINING row pins. A change to the payload shape MUST re-point these.
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { brainDbPath, bundledBrainEngineDir } from "./paths.js";

// ---------------------------------------------------------------------------
// Structural type facade — mirrors `brain-mcp-server/src/engine/components/
// edges/whole-graph.ts`. MAINTAINING row 105 pins this mirror.
// ---------------------------------------------------------------------------

/**
 * whole-graph.ts:117 — `BrainGraphNode`.
 *
 * FR-239 widened this from `unknown[]`: `/api/graph` is the first endpoint that
 * actually SERVES nodes, so the mirror now has a consumer and MAINTAINING row
 * 105's per-field annotation discipline applies to it.
 */
export interface BrainGraphNode {
  /** whole-graph.ts:119 — `encodeNodeKey({ type, project, id })`. */
  key: string;
  /** whole-graph.ts:121 — entity type. */
  type: string;
  /** whole-graph.ts:123 — stable external id, verbatim from the source table. */
  id: string;
  /** whole-graph.ts:125 — owning project slug; null only when genuinely unowned. */
  project: string | null;
  /** whole-graph.ts:127 — human-readable display label. */
  label: string;
  /** whole-graph.ts:129 — per-type display attributes. Never body content. */
  attrs: Record<string, unknown>;
  /** whole-graph.ts:131 — in+out degree over the RETURNED edges (self-loops 2). */
  degree: number;
  /** whole-graph.ts:133 — set when pulled in by adjacency on a project call. */
  boundary?: true;
  /** whole-graph.ts:135 — set when this endpoint has no backing row anywhere. */
  phantom?: true;
}

/** whole-graph.ts:139 — `EdgeResolution`. */
export type EdgeResolution = "unique" | "replicated";

/** whole-graph.ts:142 — `BrainGraphEdge`. `from`/`to` are composite node keys. */
export interface BrainGraphEdge {
  /** whole-graph.ts:144 — `"417"`, or `"417#igris-ai"` for a replica instance. */
  id: string;
  /** whole-graph.ts:146 — `entity_edges.id`, always the ORIGINAL row. */
  source_edge_id: number;
  /** whole-graph.ts:148 — composite key of the source endpoint. */
  from: string;
  /** whole-graph.ts:150 — composite key of the target endpoint. */
  to: string;
  /** whole-graph.ts:152 — `edge_type`, verbatim from the catalog. */
  type: string;
  /** whole-graph.ts:154 — original confidence, divided by replica count. */
  confidence: number;
  /** whole-graph.ts:156 — `entity_edges.provenance`, verbatim. */
  provenance: string;
  /** whole-graph.ts:158 — `'unique'` when unambiguous, `'replicated'` otherwise. */
  resolution: EdgeResolution;
}

/** whole-graph.ts:162 — `EdgeResolutionReport`. Fields copied verbatim. */
export interface EdgeResolutionReport {
  rule: "intra_project_projection";
  max_edge_replicas: number;
  source_edges: number;
  unique: number;
  replicated_sources: number;
  replicas_emitted: number;
  dangling: number;
  ambiguous_unresolved: number;
  over_replicated: number;
  over_replicated_edge_ids: number[];
  candidate_count_histogram: Record<string, number>;
  by_endpoint_pair: Record<string, number>;
}

/** whole-graph.ts:194 — `BrainGraphStats`. */
export interface BrainGraphStats {
  node_count: number;
  edge_count: number;
  by_node_type: Record<string, number>;
  by_edge_type: Record<string, number>;
  project_count: number;
  boundary_node_count: number;
}

/** whole-graph.ts:208 — `BrainGraphDegraded`. */
export interface BrainGraphDegraded {
  missing_tables: string[];
  phantom_nodes: number;
  reason: string | null;
}

/**
 * whole-graph.ts:218 — `BrainGraph`.
 *
 * FR-238 typed `nodes`/`edges` as `unknown[]` because it never read them (R8
 * stripped both at the route layer) and an unread mirror is pure drift surface.
 * **FR-239 gives them a consumer** — `/api/graph` serves both arrays and the
 * browser renders them — so they are now mirrored properly above.
 */
export interface BrainGraph {
  generated_at: string;
  project: string | null;
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
  stats: BrainGraphStats;
  edge_resolution: EdgeResolutionReport;
  truncated: boolean;
  truncation_reason: string | null;
  degraded: BrainGraphDegraded;
}

/** whole-graph.ts:232 — `BuildOpts`, narrowed to the options the CLI passes. */
export interface BuildOpts {
  project?: string;
  node_types?: string[];
  maxEdgeReplicas?: number;
  maxNodes?: number;
  maxEdges?: number;
  generatedAt?: string;
}

type BuildBrainGraphFn = (
  db: Database.Database,
  opts?: BuildOpts,
) => BrainGraph;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Relative path of the pure builder inside a compiled `engine/` tree. */
const WHOLE_GRAPH_REL = join("components", "edges", "whole-graph.js");

/**
 * Candidate `engine/` directories, in priority order.
 *
 * 1. The VENDORED bundle (`cli/dist/brain-mcp-server/dist/engine/`) — the only
 *    one that exists in a published install.
 * 2. A repo-checkout fallback (`<repo>/brain-mcp-server/dist/engine/`) so a
 *    developer running from source before `copy-templates.sh` has staged the
 *    bundle still gets a live bridge instead of a confusing empty readout.
 */
export function brainEngineCandidates(): string[] {
  const bundled = bundledBrainEngineDir();
  const here = dirname(fileURLToPath(import.meta.url)); // cli/{dist,src}/lib
  const repoSibling = join(
    here,
    "..",
    "..",
    "..",
    "brain-mcp-server",
    "dist",
    "engine",
  );
  return [bundled, repoSibling];
}

/** The first candidate that actually contains the pure builder, or null. */
export function resolveWholeGraphModulePath(): string | null {
  for (const dir of brainEngineCandidates()) {
    const candidate = join(dir, WHOLE_GRAPH_REL);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface BridgeProbe {
  available: boolean;
  /** Resolved module path when available; null otherwise. */
  module_path: string | null;
  /** Human-readable cause when unavailable; null when available. */
  reason: string | null;
}

/** Memoised module handle — the import is expensive and the artifact is static. */
let cached: BuildBrainGraphFn | null = null;
let cachedFailure: string | null = null;

/** Reset the memoised handle. Tests use this between sandboxes. */
export function resetBrainBridge(): void {
  cached = null;
  cachedFailure = null;
}

/**
 * Load `buildBrainGraph` from the vendored bundle.
 *
 * Returns `null` on ANY failure — module absent, `node_modules` unresolved,
 * export missing, or a throw during evaluation. Never rejects.
 */
export async function loadBuildBrainGraph(): Promise<BuildBrainGraphFn | null> {
  if (cached !== null) return cached;
  if (cachedFailure !== null) return null;

  const modulePath = resolveWholeGraphModulePath();
  if (modulePath === null) {
    cachedFailure = `brain engine module not found (looked in: ${brainEngineCandidates().join(", ")})`;
    return null;
  }

  try {
    const mod: unknown = await import(pathToFileURL(modulePath).href);
    const fn = (mod as { buildBrainGraph?: unknown }).buildBrainGraph;
    if (typeof fn !== "function") {
      cachedFailure = `module at ${modulePath} does not export buildBrainGraph`;
      return null;
    }
    cached = fn as BuildBrainGraphFn;
    return cached;
  } catch (err) {
    // The dominant real-world case: the vendored bundle's node_modules is
    // absent (a raw `npm pack` extract before postinstall runs), so the
    // transitive `better-sqlite3` resolution from db.js fails.
    cachedFailure = `import failed: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
}

/** Non-throwing availability probe, for `/api/health`. */
export async function probe(): Promise<BridgeProbe> {
  const fn = await loadBuildBrainGraph();
  if (fn === null) {
    return {
      available: false,
      module_path: null,
      reason: cachedFailure ?? "unavailable",
    };
  }
  return {
    available: true,
    module_path: resolveWholeGraphModulePath(),
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Read-only brain handle
// ---------------------------------------------------------------------------

/**
 * Open the brain DB read-only, per request.
 *
 * Per-request open/close is what makes the AC "data is live" true with no
 * regeneration step: a `/hunt` writing to the brain is visible on the next
 * reload because no handle is cached across requests.
 *
 * R4 — `{readonly:true}` can fail on a WAL database with no existing `-shm`
 * (a brain this machine has never written). Catch, retry as a normal open, and
 * only then degrade.
 */
export function openBrainReadonly(): Database.Database | null {
  const path = brainDbPath();
  if (!existsSync(path)) return null;
  try {
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    try {
      return new Database(path, { fileMustExist: true });
    } catch {
      return null;
    }
  }
}

/**
 * The outcome of a graph build. A discriminated result rather than
 * `BrainGraph | null`, because the THREE ways this can fail are operationally
 * different and an operator debugging an empty readout needs to know which:
 *
 *   - `engine_unavailable` — the vendored module did not resolve or import.
 *     Look at the packaging / the staging layout (R2).
 *   - `brain_unavailable`  — no readable brain database at `brainDbPath()`.
 *   - `build_failed`       — the engine loaded and the brain opened, but the
 *     builder threw. Almost always a SCHEMA MISMATCH between the CLI's brain
 *     and the vendored engine's expectations.
 *
 * Collapsing all three into one "brain engine unavailable" string is exactly
 * the silent-degrade failure R2 warns about: it sends the reader hunting for a
 * missing module when the real cause is a stale database.
 */
export type BuildGraphResult =
  | { ok: true; graph: BrainGraph }
  | {
      ok: false;
      kind: "engine_unavailable" | "brain_unavailable" | "build_failed";
      reason: string;
    };

/**
 * Build the whole-brain graph through the pure FR-237 builder with our OWN
 * read-only handle — the exact integration MAINTAINING row 105 specifies.
 *
 * NEVER throws. The handle is always closed, including on a builder throw.
 */
export async function buildGraph(
  opts: BuildOpts = {},
): Promise<BuildGraphResult> {
  const build = await loadBuildBrainGraph();
  if (build === null) {
    return {
      ok: false,
      kind: "engine_unavailable",
      reason:
        cachedFailure ??
        "brain engine module could not be loaded from the vendored bundle",
    };
  }

  const db = openBrainReadonly();
  if (db === null) {
    return {
      ok: false,
      kind: "brain_unavailable",
      reason: `brain database at ${brainDbPath()} could not be opened read-only`,
    };
  }

  try {
    return { ok: true, graph: build(db, opts) };
  } catch (err) {
    return {
      ok: false,
      kind: "build_failed",
      // Verbatim. A `no such column: brief_type` is the whole diagnosis; a
      // generic message would throw that away.
      reason: `brain graph build failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* already closed / never opened cleanly — nothing to do */
    }
  }
}

/** The memoised failure cause, for tests and diagnostics. */
export function lastBridgeFailure(): string | null {
  return cachedFailure;
}
