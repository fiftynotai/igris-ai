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
 * FR-240 extends the same discipline to the pure READ layer with
 * `briefs-read.ts:NN` / `memory-read.ts:NN` / `goals/read.ts:NN` annotations.
 *
 * ---------------------------------------------------------------------------
 * FR-240 STEP-10 RUNTIME PROBE RESULTS (recorded here as the plan requires)
 * ---------------------------------------------------------------------------
 * Both unknowns were probed BEFORE the endpoints were written, against a
 * `VACUUM INTO` snapshot of a real ~53 MB brain (never the live file), on
 * darwin/arm64, Node 24.7, better-sqlite3 11.x, sqlite-vec 0.1.7.
 *
 *  (a) DOES `sqlite-vec.load()` SUCCEED ON A `{readonly:true}` HANDLE, AND DOES
 *      `query_only = ON` COEXIST WITH IT?  **YES, both, in either order.**
 *        - `load()` on `{readonly:true, fileMustExist:true}` -> ok
 *        - `SELECT vec_version()` -> `v0.1.7`
 *        - `pragma('query_only = ON')` AFTER load -> reads back `1`, and
 *          `vec_version()` still answers
 *        - `pragma('query_only = ON')` BEFORE load -> load still succeeds
 *        - `SELECT COUNT(*) FROM learnings_vec` -> 924 (the KNN table is
 *          genuinely readable, not merely the function symbol)
 *        - an `UPDATE` on that handle -> throws `SQLITE_READONLY`
 *      So the documented fallback (normal open + `query_only=ON`) is NOT
 *      needed. It is nonetheless retained in `openBrainReadonly`'s R4 branch,
 *      which exists for a different reason (a WAL brain with no `-shm`).
 *
 *  (b) DOES `generateEmbedding` RESOLVE FROM THE VENDORED `node_modules` IN A
 *      CLI PROCESS?  **YES.** `dist/brain-mcp-server/dist/utils/embeddings.js`
 *      imported cleanly, `generateEmbedding("…")` returned a 384-dim
 *      Float32Array in 306 ms against a WARM `~/.cache/huggingface`. A COLD
 *      cache downloads ~25 MB first and an offline host throws
 *      `EmbeddingsUnavailableError` — both are legitimate `bm25_only` states
 *      and must render as a banner, never as a request failure.
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  brainDbPath,
  bundledBrainDistRoot,
  bundledBrainNodeModulesDir,
} from "./paths.js";

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

/**
 * Relative paths of the modules this bridge imports, from the BUNDLE ROOT.
 *
 * FR-240 THE TRAP THIS ENCODES. FR-238 anchored resolution on the `engine/`
 * DIRECTORY, which was fine while `whole-graph.js` was the only import. Two of
 * the three FR-240 readers live under `dist/tools/` — OUTSIDE `dist/engine/` —
 * so an `engine/`-anchored resolver would have needed `"../tools/..."`
 * escape-hatch paths. The anchor moved up one level instead; every path below
 * is relative to `dist/`.
 */
const MODULE_RELS = {
  wholeGraph: join("engine", "components", "edges", "whole-graph.js"),
  briefsRead: join("tools", "briefs-read.js"),
  memoryRead: join("tools", "memory-read.js"),
  goalsRead: join("engine", "components", "goals", "read.js"),
  /** FR-241 — the pure suggestion reader behind `/api/suggestions`. */
  suggestionsRead: join("tools", "suggestions-read.js"),
  /**
   * FR-241 — `bootEngine`, the **WRITE** door.
   *
   * Every other entry in this map is a READ artifact whose disappearance
   * degrades a readout. This one is different in kind and the MAINTAINING row
   * says so: a moved `engine/index.js` degrades the dashboard's ability to
   * MUTATE the brain, so `/api/health`'s `write.available` — not just
   * `bridge.available` — is the signal that goes false.
   *
   * Resolved here rather than in `brain-write-bridge.ts` so there is exactly
   * ONE table of bundle-relative paths for the MAINTAINING sweep to re-point.
   */
  engine: join("engine", "index.js"),
} as const;

/** The bundle-relative path of the write engine, for `brain-write-bridge.ts`. */
export const ENGINE_MODULE_REL: string = MODULE_RELS.engine;

/**
 * Candidate compiled-brain ROOT directories, in priority order.
 *
 * 1. The VENDORED bundle (`cli/dist/brain-mcp-server/dist/`) — the only one
 *    that exists in a published install.
 * 2. A repo-checkout fallback (`<repo>/brain-mcp-server/dist/`) so a developer
 *    running from source before `copy-templates.sh` has staged the bundle still
 *    gets a live bridge instead of a confusing empty readout.
 */
export function brainBundleCandidates(): string[] {
  const bundled = bundledBrainDistRoot();
  const here = dirname(fileURLToPath(import.meta.url)); // cli/{dist,src}/lib
  const repoSibling = join(here, "..", "..", "..", "brain-mcp-server", "dist");
  return [bundled, repoSibling];
}

/**
 * The `engine/` directories, still exposed under the FR-238 name because
 * `brain-bridge.test.ts` and MAINTAINING row 107 both cite it.
 *
 * Derived from {@link brainBundleCandidates} rather than re-walked: two
 * independent literals for one location is the drift the row warns about.
 */
export function brainEngineCandidates(): string[] {
  return brainBundleCandidates().map((root) => join(root, "engine"));
}

/**
 * Resolve one module inside the compiled brain bundle.
 *
 * Returns the first candidate root under which `relPath` actually exists, or
 * `null`. Never throws — a missing artifact is a DEGRADATION (R2), and every
 * caller in this file converts it into a discriminated failure.
 *
 * @param relPath path relative to the bundle root, e.g. `tools/memory-read.js`
 */
export function resolveBundleModule(relPath: string): string | null {
  for (const root of brainBundleCandidates()) {
    const candidate = join(root, relPath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The first candidate that actually contains the pure builder, or null. */
export function resolveWholeGraphModulePath(): string | null {
  return resolveBundleModule(MODULE_RELS.wholeGraph);
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
 *
 * FR-240 D2 — READ-ONLY IS A PROPERTY OF THE CONNECTION, NOT OF DISCIPLINE.
 * `query_only = ON` is applied on BOTH branches. That matters most on the R4
 * fallback, which re-opens READ-WRITE: without the pragma, an accidental write
 * anywhere downstream would silently mutate the operator's brain and AC #7
 * would be a review promise rather than a structural fact. With it, the same
 * write throws `SQLITE_READONLY` on both branches, so the two paths are
 * indistinguishable from the caller's point of view.
 *
 * The pragma is applied inside the same `try` as the open: a handle we cannot
 * arm is a handle we must not hand out, so a pragma failure closes it and
 * falls through to the next branch rather than returning an unguarded
 * connection.
 */
export function openBrainReadonly(): Database.Database | null {
  const path = brainDbPath();
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      db.pragma("query_only = ON");
      return db;
    } catch {
      db.close();
      throw new Error("query_only could not be armed on the readonly handle");
    }
  } catch {
    try {
      const db = new Database(path, { fileMustExist: true });
      try {
        db.pragma("query_only = ON");
        return db;
      } catch {
        try {
          db.close();
        } catch {
          /* nothing to do */
        }
        return null;
      }
    } catch {
      return null;
    }
  }
}

/**
 * The outcome of {@link openBrainReadonlyWithVec}.
 *
 * `vector_available` is reported rather than assumed because the whole AC #2
 * failure mode is INVISIBLE otherwise: `isVectorSearchAvailable(db)` probes
 * `SELECT vec_version()` on THAT connection, so a handle that never loaded the
 * extension makes `hybridSearchLearnings` take its BM25-only arm and return
 * plausible results. The caller forwards this into the payload's `retrieval`
 * block so the degradation reaches the operator's screen.
 */
export interface VecHandle {
  db: Database.Database;
  vector_available: boolean;
  /** Why the extension did not load; null when it did. */
  vector_reason: string | null;
}

/** Memoised `sqlite-vec` module handle — the resolution is filesystem work. */
let cachedVecModule: { load: (db: Database.Database) => void } | null = null;
let cachedVecFailure: string | null = null;

/**
 * Load `sqlite-vec` from the VENDORED bundle.
 *
 * It is a PRODUCTION dependency of `brain-mcp-server`, so it lives in
 * `cli/dist/brain-mcp-server/node_modules/` — the one directory
 * `cli/package.json` `files` excludes and `scripts/postinstall.mjs` restores.
 * Between `npm pack` extraction and that postinstall it is genuinely absent,
 * which is why this returns null instead of throwing.
 */
async function loadSqliteVecModule(): Promise<
  { load: (db: Database.Database) => void } | null
> {
  if (cachedVecModule !== null) return cachedVecModule;
  if (cachedVecFailure !== null) return null;

  const candidates = [
    join(bundledBrainNodeModulesDir(), "sqlite-vec", "index.mjs"),
    // Repo-checkout twin of the bundle fallback in `brainBundleCandidates`.
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "brain-mcp-server",
      "node_modules",
      "sqlite-vec",
      "index.mjs",
    ),
  ];

  const found = candidates.find((c) => existsSync(c));
  if (found === undefined) {
    cachedVecFailure = `sqlite-vec not found (looked in: ${candidates.join(", ")})`;
    return null;
  }

  try {
    const mod: unknown = await import(pathToFileURL(found).href);
    const fn = (mod as { load?: unknown }).load;
    if (typeof fn !== "function") {
      cachedVecFailure = `module at ${found} does not export load()`;
      return null;
    }
    cachedVecModule = { load: fn as (db: Database.Database) => void };
    return cachedVecModule;
  } catch (err) {
    cachedVecFailure = `sqlite-vec import failed: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
}

/**
 * Open the brain read-only AND load `sqlite-vec` onto that connection (D3).
 *
 * ORDER: extension first, `query_only` second. Step-10 probe (a) showed both
 * orders work on better-sqlite3 11 / sqlite-vec 0.1.7, but loading an extension
 * is closer to a connection-configuration act than to a query, so it runs
 * before the connection is frozen. `openBrainReadonly()` has already armed
 * `query_only`; `load()` is called anyway because the pragma does not block
 * `sqlite3_load_extension`.
 *
 * A failure to load is NOT a failure to open: the handle is returned with
 * `vector_available:false` and a reason. BM25-only recall on a real brain beats
 * no recall at all — but it is reported, never silent.
 */
export async function openBrainReadonlyWithVec(): Promise<VecHandle | null> {
  const db = openBrainReadonly();
  if (db === null) return null;

  const vecMod = await loadSqliteVecModule();
  if (vecMod === null) {
    return {
      db,
      vector_available: false,
      vector_reason: cachedVecFailure ?? "sqlite-vec unavailable",
    };
  }

  try {
    vecMod.load(db);
  } catch (err) {
    return {
      db,
      vector_available: false,
      vector_reason: `sqlite-vec load failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Do not TRUST the load — PROBE it. `load()` can succeed while the platform
  // binary is a no-op stub, and the whole point of this handle is that the
  // vector arm actually answers.
  try {
    db.prepare("SELECT vec_version()").get();
  } catch (err) {
    return {
      db,
      vector_available: false,
      vector_reason: `vec_version() unavailable after load: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { db, vector_available: true, vector_reason: null };
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

// ---------------------------------------------------------------------------
// FR-240 — the pure `db`-param READ layer (FR-241 adds a fourth module)
//
// Structural type facade mirroring `brain-mcp-server/src/tools/briefs-read.ts`,
// `src/tools/memory-read.ts`, `src/engine/components/goals/read.ts` and
// `src/tools/suggestions-read.ts`, each field block annotated with its source
// line — the same discipline the `BrainGraph*` mirror above uses. MAINTAINING's
// "pure `db`-param READ layer" row pins these: a change to a reader's signature
// or returned row shape MUST re-point this facade in the same commit.
//
// FR-241 NOTE — `openBrainReadonly` and `openBrainReadonlyWithVec` above are
// NOT modified by the write brief. The read-write door is a DIFFERENT FUNCTION
// in a DIFFERENT MODULE (`brain-write-bridge.ts`) returning a DIFFERENT
// connection, which is what keeps FR-240's G-RO-3 pin (an `UPDATE` throws on
// this file's handles) true rather than merely still-passing.
// ---------------------------------------------------------------------------

/**
 * utils/substring-search.ts — `SubstringSearchReport` (FR-246).
 *
 * Mirrored ONCE and reused by all four `q`-bearing results below. It is a
 * PAYLOAD field, not a UI string, precisely so a gate can assert that a
 * substring surface never claims recall.
 */
export interface SubstringSearchReport {
  mode: "substring";
  fields: string[];
}

/** briefs-read.ts:47 — `ListBriefsOptions`. */
export interface ListBriefsOptions {
  project?: string;
  status?: string;
  brief_type?: string;
  priority?: string;
  /** briefs-read.ts:54 — the filter FR-240 added; the column pre-existed. */
  effort?: string;
  include_content?: boolean;
  /** briefs-read.ts:61 — `0` means "no LIMIT clause". The dashboard never passes it. */
  limit?: number;
  offset?: number;
}

/** briefs-read.ts:72 — `ListBriefsResult`. */
export interface ListBriefsResult {
  briefs: Record<string, unknown>[];
  count: number;
  total: number;
  limit: number;
  offset: number;
}

/** briefs-read.ts:87 — `BriefRecord`. Both `getBrief` branches share this key set. */
export interface BriefRecord {
  project: string;
  brief_id: string;
  content: unknown;
  filename: unknown;
  content_hash: unknown;
  title: unknown;
  status: unknown;
  priority: unknown;
  effort: unknown;
  phase: unknown;
  brief_type: unknown;
  updated_at: unknown;
}

// --- FR-246: briefs-read.ts retrieval -------------------------------------

/** briefs-read.ts — `BriefHybridSearchOptions`. */
export interface BriefHybridSearchOptions {
  query: string;
  project?: string;
  limit?: number;
  bm25_weight?: number;
  vector_weight?: number;
  rrf_k?: number;
}

/**
 * briefs-read.ts — `BriefSearchRow`.
 *
 * FR-240 D7 applies: NO `content`. Brief bodies average ~3.9 KB (measured:
 * 6,211,271 B over 1,597 rows), so a ranked list carrying them is the
 * superlinear payload term the read layer exists to remove.
 */
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
  rank?: number;
}

/**
 * briefs-read.ts — `BriefRetrievalReport`.
 *
 * `RetrievalReport` plus `bm25_reason`, the one fact briefs have that learnings
 * do not: `learnings_fts` has existed since schema v1, but `briefs_fts` arrives
 * at v23, so a brain that has not run the migration has a live vector arm and
 * NO lexical arm. That state is reported, never rendered as a thin result set.
 */
export interface BriefRetrievalReport extends RetrievalReport {
  bm25_reason: string | null;
}

/** briefs-read.ts — `BriefSearchEntry`. `row` is null on a hydration miss. */
export interface BriefSearchEntry {
  id: number;
  row: BriefSearchRow | null;
  rrf_score: number | null;
  bm25_rank: number | null;
  vector_rank: number | null;
}

/** briefs-read.ts — `BriefHybridSearchResult`. */
export interface BriefHybridSearchResult {
  rows: BriefSearchEntry[];
  retrieval: BriefRetrievalReport;
}

/** memory-read.ts:144 — `ListLearningsOptions`. */
export interface ListLearningsOptions {
  project?: string;
  category?: string;
  scope?: string;
  provenance?: string;
  review_status?: string;
  /** memory-read.ts — FR-246: substring over `title` + `content`. NOT retrieval. */
  q?: string;
  limit?: number;
  offset?: number;
}

/** memory-read.ts:163 — `LearningListRow`. NO `content` (D7); `content_length` instead. */
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
   * memory-read.ts:195 — FR-241. The destructiveness discriminator:
   * `igris_perception_reject` SOFT-deletes when `> 0` and HARD-deletes when
   * `== 0` (`perception/handlers.ts:661-717`). `COALESCE`d brain-side, so this
   * is never null even on legacy rows.
   */
  seen_again_count: number;
  /** memory-read.ts:197 — FR-241. Non-null iff already soft-deleted. */
  deleted_at: string | null;
}

/** memory-read.ts:183 — `ListLearningsResult`. */
export interface ListLearningsResult {
  learnings: LearningListRow[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  /** memory-read.ts:190 — set when the `learnings` table is absent (L-133). */
  degraded: string | null;
  /** memory-read.ts — FR-246 D3-f. `null` when no `q` was supplied. */
  search: SubstringSearchReport | null;
}

/** memory-read.ts:58 — `LearningRow`, the hydrated search/detail shape. */
export interface LearningRow {
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
  rank?: number;
  promoted_to_doc?: string | null;
}

/** memory-read.ts:79 — `HybridSearchOptions`. */
export interface HybridSearchOptions {
  query: string;
  project?: string;
  /**
   * BR-085 — the review scope to recall over; the reader defaults it to
   * `approved` when absent, so omitting it is the FR-109 conscious channel.
   *
   * DECLARING IT HERE DOES NOT MAKE THE LOADED BUNDLE HONOUR IT. This interface
   * describes the module `loadLayerReaders` imports at runtime, and that module
   * is a VENDORED build (`cli/dist/brain-mcp-server/dist/`) that can predate
   * this declaration. That is why {@link HybridSearchResult} carries the
   * reader's own echo and why `routes.ts` renders the ECHO rather than the
   * request — a type is a claim about source, not about the artifact on disk.
   */
  review_status?: string;
  limit?: number;
  bm25_weight?: number;
  vector_weight?: number;
  rrf_k?: number;
}

/**
 * memory-read.ts:98 — `RetrievalReport`.
 *
 * This is the block that makes AC #2 assertable. Forwarded to the browser
 * verbatim by `/api/learnings/search`.
 */
export interface RetrievalReport {
  mode: "hybrid" | "bm25_only" | "vector_only" | "none";
  vector_available: boolean;
  embedding_available: boolean;
  bm25_hits: number;
  vector_hits: number;
  rrf_k: number;
  weights: { bm25: number; vector: number };
  reason: string | null;
}

/** memory-read.ts:129 — `HybridSearchEntry`. `row` is null on a hydration miss. */
export interface HybridSearchEntry {
  id: number;
  row: LearningRow | null;
  rrf_score: number | null;
  bm25_rank: number | null;
  vector_rank: number | null;
}

/** memory-read.ts:138 — `HybridSearchResult`. */
export interface HybridSearchResult {
  rows: HybridSearchEntry[];
  retrieval: RetrievalReport;
  /**
   * BR-085 — the review scope the reader ACTUALLY applied.
   *
   * Typed `string | undefined` rather than `string`, and that is the whole
   * point: a vendored bundle built before BR-085 returns an object without this
   * key, and TypeScript would otherwise let `routes.ts` treat the absent value
   * as a promise kept. `undefined` here means "this reader has no review axis",
   * which the route reports instead of bannering a scope it did not get.
   */
  review_status?: string;
}

/** goals/read.ts:43 — `GoalRow` (LIFTED there from `handlers.ts:80` by FR-240). */
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

/** goals/read.ts:60 — `GoalListRow`. */
export type GoalListRow = GoalRow & { serving_briefs_count: number };

/** goals/read.ts:63 — `ListGoalsOptions`. `limit`/`offset` are REQUIRED and pre-clamped. */
export interface ListGoalsOptions {
  project?: unknown;
  status?: unknown;
  upcoming_days?: number;
  /** goals/read.ts — FR-246: substring over `title` + `description`. */
  q?: string;
  limit: number;
  offset: number;
}

/** goals/read.ts:80 — `ListGoalsResult`. */
export interface ListGoalsResult {
  goals: GoalListRow[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  /** goals/read.ts — FR-246 D3-f. `null` when no `q` was supplied. */
  search: SubstringSearchReport | null;
}

// --- FR-241: suggestions-read.ts ------------------------------------------

/** suggestions-read.ts#ListSuggestionsOptions. `limit`/`offset` are pre-clamped. */
export interface ListSuggestionsOptions {
  status?: string;
  project_slug?: string;
  /** suggestions-read.ts — TD-326: match ONLY `project_slug IS NULL`. Replaces `project_slug`. */
  project_is_null?: boolean;
  /** suggestions-read.ts#ListSuggestionsOptions.source_module — OPEN vocabulary since FR-118 M2. Never an enum. */
  source_module?: string;
  /** suggestions-read.ts — TD-440: the PRODUCER axis. NULL on pre-v5 rows. */
  source_instance?: string;
  priority?: string;
  /** suggestions-read.ts — FR-246: substring over `title` + `evidence`. */
  q?: string;
  limit?: number;
  offset?: number;
}

/**
 * suggestions-read.ts#SuggestionRow — the `suggestions` table verbatim.
 *
 * `evidence` is the RAW JSON STRING, not an object: parsing is
 * `rowToSuggestion`'s job and it lives in the MCP wrapper. The dashboard route
 * keeps it a string too — a triage row does not render evidence, and parsing it
 * server-side would put a second `rowToSuggestion` in the CLI.
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
  /** suggestions-read.ts — TD-440 (v5): the stable finding key. */
  dedupe_key: string | null;
  /** suggestions-read.ts — TD-440 (v5): the blocking anchor. */
  entity_key: string | null;
  /** suggestions-read.ts — TD-440 (v5): emission count for this finding. */
  seen_count: number;
  /** suggestions-read.ts — TD-440 (v5): last re-emission stamp. */
  last_seen_at: string | null;
  /** suggestions-read.ts — TD-440 (v5): JSON array of ≤3 absorbed titles. */
  recurrence_titles: string;
  /** suggestions-read.ts — TD-440 (v5): the producing instance. */
  source_instance: string | null;
}

/** suggestions-read.ts#SuggestionFacets. Counts from DATA, never an enum (L-967). */
export interface SuggestionFacets {
  /** suggestions-read.ts#SuggestionFacets.source_module — count DESC then name ASC; the filter vocabulary. */
  source_module: Record<string, number>;
  /** suggestions-read.ts — TD-326: rows with NO project, over the filters minus the project axis. */
  brain_level: number;
  /** suggestions-read.ts — TD-440: the PRODUCER vocabulary, minus its own axis. */
  source_instance: Record<string, number>;
}

/** suggestions-read.ts#ListSuggestionsResult. */
export interface ListSuggestionsResult {
  suggestions: SuggestionRow[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  facets: SuggestionFacets;
  /** suggestions-read.ts#ListSuggestionsResult.degraded — set when the `suggestions` table is absent (L-133). */
  degraded: string | null;
  /** suggestions-read.ts — FR-246 D3-f. `null` when no `q` was supplied. */
  search: SubstringSearchReport | null;
}

/** goals/read.ts:89 — `ServingBrief`. */
export interface ServingBrief {
  brief_id: string;
  title: string;
  status: string;
  priority: string;
}

/** goals/read.ts:97 — `GoalDetail`. */
export interface GoalDetail {
  goal: GoalRow;
  serving_briefs: ServingBrief[];
  serving_learnings_count: number;
}

/** The three modules' exported functions, as this bridge calls them. */
export interface LayerReaders {
  /** briefs-read.ts:114 */
  listBriefs: (db: Database.Database, opts?: ListBriefsOptions) => ListBriefsResult;
  /** briefs-read.ts — FR-246. The dashboard's hybrid brief recall. */
  hybridSearchBriefs: (
    db: Database.Database,
    opts: BriefHybridSearchOptions,
  ) => Promise<BriefHybridSearchResult>;
  /** briefs-read.ts:203 */
  getBrief: (
    db: Database.Database,
    project: string,
    briefId: string,
  ) => BriefRecord | null;
  /** memory-read.ts:252 */
  listLearnings: (
    db: Database.Database,
    opts?: ListLearningsOptions,
  ) => ListLearningsResult;
  /** memory-read.ts:222 */
  getLearning: (
    db: Database.Database,
    id: number,
  ) => Record<string, unknown> | null;
  /** memory-read.ts:343 */
  hybridSearchLearnings: (
    db: Database.Database,
    opts: HybridSearchOptions,
  ) => Promise<HybridSearchResult>;
  /** goals/read.ts:112 */
  listGoals: (db: Database.Database, opts: ListGoalsOptions) => ListGoalsResult;
  /** goals/read.ts:196 */
  getGoal: (db: Database.Database, goalId: string) => GoalDetail | null;
  /** suggestions-read.ts#listSuggestions — FR-241. */
  listSuggestions: (
    db: Database.Database,
    opts?: ListSuggestionsOptions,
  ) => ListSuggestionsResult;
}

/** Memoised reader handles — same rationale as `cached` above. */
let cachedReaders: LayerReaders | null = null;
let cachedReadersFailure: string | null = null;

/** The memoised reader-load failure cause, for tests and diagnostics. */
export function lastLayerReadersFailure(): string | null {
  return cachedReadersFailure;
}

/**
 * Load the three pure reader modules from the vendored bundle.
 *
 * Returns `null` on ANY failure — a module absent, an export missing, a throw
 * during evaluation. NEVER rejects. Same discriminated-degradation contract as
 * {@link loadBuildBrainGraph}, and for the same reason: this is a PATH-LITERAL
 * dependency on a build artifact (R2), so the realistic failure is a moved path
 * on a machine nobody is watching.
 *
 * All FOUR modules must resolve (FR-241 adds `suggestions-read.js`). A partial
 * load would give the dashboard a working briefs view and a mysteriously empty
 * learnings view — a state that is far harder to diagnose than "the read layer
 * is unavailable".
 */
export async function loadLayerReaders(): Promise<LayerReaders | null> {
  if (cachedReaders !== null) return cachedReaders;
  if (cachedReadersFailure !== null) return null;

  const wanted: { rel: string; exports: (keyof LayerReaders)[] }[] = [
    {
      rel: MODULE_RELS.briefsRead,
      // FR-246 adds `hybridSearchBriefs`. `searchBriefsByVector` is
      // deliberately ABSENT: it backs `igris_brief_similar`'s duplicate check
      // and has no dashboard consumer, and the all-or-nothing contract below
      // means every name here is a hard dependency — listing an export nobody
      // calls would make the whole read layer fail on a bundle that is
      // otherwise fine for this surface.
      exports: ["listBriefs", "getBrief", "hybridSearchBriefs"],
    },
    {
      rel: MODULE_RELS.memoryRead,
      exports: ["listLearnings", "getLearning", "hybridSearchLearnings"],
    },
    { rel: MODULE_RELS.goalsRead, exports: ["listGoals", "getGoal"] },
    { rel: MODULE_RELS.suggestionsRead, exports: ["listSuggestions"] },
  ];

  const collected: Partial<Record<keyof LayerReaders, unknown>> = {};

  for (const { rel, exports } of wanted) {
    const modulePath = resolveBundleModule(rel);
    if (modulePath === null) {
      cachedReadersFailure = `brain read module not found: ${rel} (looked in: ${brainBundleCandidates().join(", ")})`;
      return null;
    }
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
    } catch (err) {
      cachedReadersFailure = `import failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`;
      return null;
    }
    for (const name of exports) {
      if (typeof mod[name] !== "function") {
        cachedReadersFailure = `module at ${modulePath} does not export ${name}`;
        return null;
      }
      collected[name] = mod[name];
    }
  }

  cachedReaders = collected as unknown as LayerReaders;
  return cachedReaders;
}

/**
 * Reset the memoised reader handles AND the `sqlite-vec` module handle.
 *
 * Separate from {@link resetBrainBridge} only because that function is cited by
 * FR-238's tests; both are called by the FR-240 suites between sandboxes.
 */
export function resetLayerReaders(): void {
  cachedReaders = null;
  cachedReadersFailure = null;
  cachedVecModule = null;
  cachedVecFailure = null;
}
