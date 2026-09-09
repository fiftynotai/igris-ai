/**
 * Brain Engine v7.0 — Edges Component Graph Traversal (FR-113)
 *
 * Three read-only graph tools layered on top of entity_edges:
 *   - igris_graph_neighbors  — BFS within N hops (direction-aware)
 *   - igris_graph_path       — directed shortest path (cycle-safe)
 *   - igris_graph_subgraph   — connected subgraph for visualization (cached)
 *
 * THE NODE KEY IS THE TRIPLE `(type, project, id)` — BR-078
 * ---------------------------------------------------------
 * Every visited-set entry, cache key, label-map key and parent pointer in this
 * module is `encodeNodeKey({ type, project, id })` from `graph-keys.ts` (FR-237,
 * imported unmoved — there is exactly ONE key serialiser in the brain).
 *
 * The pre-BR-078 two-part key `${type}|${id}` could not express the project
 * axis. `brief_id` is UNIQUE only per `(project, brief_id)`, so any traversal
 * seeded on a colliding brief silently FUSED unrelated projects' graphs —
 * measured on the live brain: 343 colliding ids across 1,297 of 1,726 rows,
 * `BR-001` alone in 25 projects with 16 edges returned as though they belonged
 * to one brief. Never parse a key with `split('|')`: segments are
 * backslash-escaped, and a naive split is wrong in a way that passes every
 * happy-path test (see `graph-keys.ts`'s header). Read the structured fields
 * that travel alongside the key, or `parseNodeKey`.
 *
 * SEED QUALIFICATION — resolved when unique, HARD ERROR when ambiguous
 * --------------------------------------------------------------------
 * `node_project` / `from_project` + `to_project` / `seed_node_project` are
 * OPTIONAL and QUALIFY THE SEED ONLY — they never filter the result, because a
 * traversal seeded in project A legitimately reaches project B through a
 * cross-project edge. With `P(seed)` = the projects the seed id lives in:
 *
 *   | `|P|`      | behaviour                                                  |
 *   |------------|------------------------------------------------------------|
 *   | 0          | phantom seed — proceed with `project: null` (pre-BR-078     |
 *   |            | behaviour, preserved; `entity_edges` carries endpoints with |
 *   |            | no backing row anywhere, so "required" is incoherent here)  |
 *   | 1          | adopt it — the caller need not know anything                |
 *   | >1         | ERROR naming the id, the count and the candidate slugs      |
 *   | supplied   | validated against `P(seed)` when `P` is non-empty           |
 *
 * The tool therefore NEVER fuses: it resolves uniquely or it refuses.
 *
 * HOP RESOLUTION AND ITS RESIDUAL
 * -------------------------------
 * Walking an edge to `brief|BR-002` must decide WHICH project's BR-002.
 * Since BR-083 the row itself usually says: when `entity_edges.from_project`
 * and `to_project` are BOTH stored, `resolveHopProject` reads them and only
 * asks whether the near one is the instance we are standing on. When they are
 * not, it falls back to reaching FR-237's `resolveEdgeProjects` verdict by
 * inference. Three outcomes either way: walk it, skip it because it
 * demonstrably belongs to another instance of the same id (NOT a loss), or
 * skip it because the data cannot say (a real loss).
 *
 * `unresolved_hops` — NARROWED MEANING, NOT RETIRED (BR-083).
 * It now counts hops over rows that PREDATE `edges@4` and could not be
 * attributed by the backfill, plus the endpoints that legitimately have no
 * project. It cannot be incremented by a row minted after edges@4, because an
 * ambiguous endpoint is refused at `handleEdgeCreate`. Expect it to trend
 * toward zero and never to rise; do NOT expect zero — roughly half the
 * pre-BR-083 rows are unprovable and a wrong attribution is worse than a null.
 * The counter is mandatory: an unreported loss would reproduce the original
 * `LABEL_SCHEMA` sin — an acknowledged omission with no signal. Removing it
 * would also be a payload break across ten consumers to delete a number that
 * is still non-zero.
 *
 * Traversal NEVER replicates: it walks at most one candidate per hop, so the
 * visited set cannot explode. See `igris_graph_brain`'s `edge_resolution`
 * block — the same residual measured brain-wide — and
 * `docs/architecture/graph_traversal.md`. This layer was SOUND but not
 * COMPLETE without a schema change; BR-083 supplied the schema change and
 * completeness now grows with attribution rather than being unreachable.
 *
 * Implementation notes:
 *   - Iterative BFS in TypeScript with per-frontier parameterized SQL queries
 *     against entity_edges. Recursive CTE was prototyped first but `UNION`
 *     could not dedupe across distinct path-string visited-sets, causing row
 *     enumeration to explode ~deg^depth. The iterative form visits each node
 *     at most once: O(V + E) within depth bound.
 *   - Soft-delete filter (metadata.deleted=true) is applied by default,
 *     matching the FR-105 igris_edge_list pattern.
 *   - Hard caps: depth in [1, 10], max_nodes in [1, 100], result rows in
 *     [1, 100]. Caps are clamped silently rather than rejected so the
 *     LLM-callable surface stays forgiving.
 *   - Labels are resolved post-traversal in TypeScript via per-type
 *     batched queries, keyed on the triple; missing tables (e.g. goals before
 *     FR-110) fall back to id-as-label with a one-time warning per process.
 *   - Subgraph results are cached for 5 minutes in a closure-scoped Map
 *     (LRU-bounded at 64 entries) and invalidated by edge.created /
 *     edge.removed bus events. The cache key carries the RESOLVED seed project
 *     — without it, project A's cached subgraph would be served to a project B
 *     query for five minutes, silently.
 *   - MEASURED cost of the project axis (live brain, read-only, 2026-07-29):
 *     `depth=10, max_nodes=100, direction=both` seeded on the busiest colliding
 *     brief (`FR-116@fifty-dev`, returning the full 100 nodes) — ONE warm-up
 *     call discarded, then 9 samples: median 2.57 ms, max 3.83 ms. Lookups are
 *     memoised per call and bounded by `max_nodes` distinct ids. The stated
 *     follow-up trigger for a `brief_status(brief_id)` index is ~50 ms, so no
 *     index is warranted; adding one would also mean an `edges`-component
 *     migration mutating the `briefs` component's table.
 *   - MEASURED residual (same run): scanning every colliding brief id that has
 *     an edge, seeded from every project it lives in — depth=2, both — the live
 *     brain yields **0 seed-resolution errors, 0 cross-project brief leaks
 *     across 9,676 neighbour rows, and `unresolved_hops = 0` in every
 *     traversal**. The seed COUNT (862 on 2026-07-29) drifts as briefs are
 *     added and is not the load-bearing figure; the three zeros are. The branch
 *     that drops a hop is real and unit-tested, but today's data always supplies
 *     an owner hint. Report the counter anyway — a residual that is zero *today*
 *     is not a residual that is zero.
 *
 * WHAT THIS CHANGED — DO NOT "FIX" A CORRECTION BACK INTO A BUG
 * -------------------------------------------------------------
 * Measured by running the pre-BR-078 implementation and this one over the same
 * live brain (81 global-id seeds with an edge, depths 1 and 2 = 162 traversals):
 * **28 differ substantively** — 6 node sets, 22 labels — and every one is the
 * defect being removed.
 *
 * The tempting summary "global-id (learning/error/session) traversals are
 * unchanged" is FALSE, and false in the dangerous direction. A `learning` id is
 * globally unique, but a learning two hops from a colliding brief INHERITED that
 * brief's fusion. `learning:1005` (`fya-hadir-app`) has exactly one edge — to
 * `BR-001` — and at depth 2 went from 11 neighbours to 1; among the ten dropped
 * was `MG-006`, which exists ONLY in `fifty-dev`.
 *
 * The precise, verified statement:
 *   - global-id SEEDS are unchanged — depth-1 node sets identical in 81 of 81,
 *     and ZERO seeds that previously resolved now hard-error;
 *   - global-id traversals that PASS THROUGH a colliding brief change, by design;
 *   - `error` / `session` are unchanged VACUOUSLY — zero edges on the live brain.
 *
 * The regression to guard is a seed that stops resolving, or a depth-1 set that
 * moves. A depth-2 set that SHRINKS is this brief working. See
 * `docs/architecture/graph_traversal.md` for the table and both worked examples.
 *
 * @module engine/components/edges/traversal
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult } from '../../helpers.js';
import { VALID_EDGE_TYPES, VALID_ENTITY_TYPES } from './handlers.js';
import { encodeNodeKey, type NodeKeyParts } from './graph-keys.js';
import {
  createProjectResolver,
  qualifyNodeProject,
  resolveHopProject,
  type ProjectResolver,
  type StoredHopProjects,
} from './node-project.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EntityType = (typeof VALID_ENTITY_TYPES)[number];

/** A node enriched with a human-readable label. */
export interface NodeRow {
  type: string;
  id: string;
  /**
   * Owning project slug, or `null` for a genuinely ownerless / phantom node.
   * BR-078: this is a REAL field, not decoration — `(type, id)` alone does not
   * identify a brief.
   */
  project: string | null;
  label: string;
}

/** A neighbor entry — node + the depth at which it was discovered. */
export interface NeighborRow extends NodeRow {
  depth: number;
}

/** An edge as projected to traversal callers (lighter than the full DB row). */
export interface EdgeProjection {
  id: number;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  edge_type: string;
  confidence: number;
  provenance: string;
  metadata: string;
}

/** A single hop in a path response. */
interface PathStep {
  type: string;
  id: string;
  project: string | null;
  label: string;
  edge_id?: number;
  edge_type?: string;
}

/** Subgraph response shape. */
interface SubgraphResult {
  seed: { type: string; id: string; project: string | null };
  nodes: Array<NodeRow & { is_seed?: boolean }>;
  edges: EdgeProjection[];
  truncated: boolean;
  cached: boolean;
  /**
   * BR-078 + BR-083: hops dropped because the row could not be attributed —
   * the NULL residual only. See the module header.
   */
  unresolved_hops: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DEPTH = 10;
const MAX_RESULT_ROWS = 100;
const MAX_SUBGRAPH_NODES = 100;

const SUBGRAPH_TTL_MS = 5 * 60 * 1000;
const SUBGRAPH_CACHE_LIMIT = 64;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: SubgraphResult;
  expiresAt: number;
}

/** Closure-scoped subgraph cache. */
const subgraphCache = new Map<string, CacheEntry>();

/** Track which entity types have already produced a "missing label table" warning. */
const warnedMissingTables = new Set<string>();

/** Clear all cached subgraph results. */
export function invalidateSubgraphCache(): void {
  subgraphCache.clear();
}

/**
 * Build a stable cache key for the subgraph tool.
 *
 * BR-078 CORRECTNESS-CRITICAL: the `s:` segment carries the RESOLVED seed
 * project. The moment `seed_node_project` exists, a two-part seed key would
 * serve project A's cached subgraph to a project B query — for five minutes,
 * silently. `seedProject` is the value AFTER the resolution ladder, not the raw
 * argument, so `{ seed_node_id: 'BR-002' }` and
 * `{ seed_node_id: 'BR-002', seed_node_project: 'proj-a' }` correctly share one
 * entry when `BR-002` lives only in `proj-a`.
 */
function subgraphCacheKey(args: {
  seed_node_type: string;
  seed_node_id: string;
  seed_project: string | null;
  max_nodes: number;
  edge_types: string[] | undefined;
  include_deleted: boolean;
}): string {
  return JSON.stringify({
    s: encodeNodeKey({
      type: args.seed_node_type,
      project: args.seed_project,
      id: args.seed_node_id,
    }),
    m: args.max_nodes,
    e: args.edge_types ? [...args.edge_types].sort() : null,
    d: args.include_deleted,
  });
}

/** LRU-bounded cache write. Evicts oldest insertion-order entry when full. */
function cacheSet(key: string, value: SubgraphResult): void {
  if (subgraphCache.size >= SUBGRAPH_CACHE_LIMIT && !subgraphCache.has(key)) {
    const firstKey = subgraphCache.keys().next().value;
    if (firstKey !== undefined) subgraphCache.delete(firstKey);
  }
  subgraphCache.set(key, {
    value,
    expiresAt: Date.now() + SUBGRAPH_TTL_MS,
  });
}

/** Cache read with TTL check. Returns undefined on miss or expiry. */
function cacheGet(key: string): SubgraphResult | undefined {
  const entry = subgraphCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    subgraphCache.delete(key);
    return undefined;
  }
  return entry.value;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function validateEntityType(label: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value) return `Missing required field: ${label}`;
  if (!(VALID_ENTITY_TYPES as readonly string[]).includes(value)) {
    return `Invalid ${label}: ${value}. Must be one of: ${VALID_ENTITY_TYPES.join(', ')}`;
  }
  return null;
}

function validateEdgeTypesFilter(raw: unknown): { types: string[] | undefined; error: string | null } {
  if (raw === undefined || raw === null) return { types: undefined, error: null };
  if (!Array.isArray(raw)) return { types: undefined, error: 'edge_types must be an array' };
  const types: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') {
      return { types: undefined, error: 'edge_types entries must be strings' };
    }
    if (!(VALID_EDGE_TYPES as readonly string[]).includes(t)) {
      return {
        types: undefined,
        error: `Invalid edge_type "${t}". Must be one of: ${VALID_EDGE_TYPES.join(', ')}`,
      };
    }
    types.push(t);
  }
  return { types: types.length > 0 ? types : undefined, error: null };
}

// ---------------------------------------------------------------------------
// Seed qualification (BR-078)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// BR-083 — reading the row's own qualifiers on the hop path
// ---------------------------------------------------------------------------

/**
 * `, e.from_project, e.to_project` — or literal NULLs on a pre-`edges@4` brain.
 *
 * PROBED, never assumed. Several traversal fixtures hand-roll `entity_edges`,
 * and an exported or mid-deploy brain can legitimately predate the columns; on
 * any of those, `no such column` would turn a degradation into an outage. A
 * NULL column reads as *"the row does not say"*, which routes straight to the
 * inference ladder — the pre-BR-083 behaviour, exactly.
 */
function edgeProjectColumns(db: Database.Database): string {
  try {
    const cols = db.prepare('PRAGMA table_info(entity_edges)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (names.has('from_project') && names.has('to_project')) {
      return ', e.from_project, e.to_project';
    }
  } catch {
    // Fall through — a brain that cannot answer the question has no columns.
  }
  return ', NULL AS from_project, NULL AS to_project';
}

/**
 * Orient a row's stored qualifiers to the hop: near = the side we stand on.
 *
 * The swap happens HERE, once, rather than at three call sites — an inbound
 * hop reads `to_project` as its near side, and getting that backwards would
 * traverse the wrong instance while looking entirely correct.
 */
function storedHop(
  row: { from_project?: string | null; to_project?: string | null },
  isOutbound: boolean,
): StoredHopProjects {
  return isOutbound
    ? { near: row.from_project, far: row.to_project }
    : { near: row.to_project, far: row.from_project };
}

/** Discriminated so `if (!seed.ok) return errorResult(seed.error)` narrows. */
type SeedResolution =
  | { ok: true; project: string | null }
  | { ok: false; error: string };

/**
 * Resolve the project of ONE seed endpoint — the decision-C ladder.
 *
 * BR-083 MOVED THE LADDER, NOT THE BEHAVIOUR. The four cases now live in
 * `node-project.ts::qualifyNodeProject`, because `handleEdgeCreate` needs the
 * identical ladder over the identical `projectsFor` resolver and a second copy
 * would have become a second dialect the first time either moved. Both
 * BR-078 deviations travelled with it and are documented at the new site:
 *   - `|P| = 0` + a supplied slug is ACCEPTED (unverifiable, not false), which
 *     is what lets a first hop satisfy branch 2 where `resolveEdgeProjects`
 *     would take branch 3;
 *   - `|P| > 1` is a REFUSAL, never a fused multi-project answer.
 *
 * The strings this surface emits are byte-identical to their pre-BR-083 form:
 * the traversal-only scope caveat is passed as the `trailer`, and the noun
 * stays `seed` here while `handleEdgeCreate` passes `endpoint`.
 *
 * @param paramName - The tool's project param (`node_project`, `from_project`,
 *                    `to_project`, `seed_node_project`) — named in the error so
 *                    the caller knows exactly what to pass.
 * @param idParam - The tool's id param name, for a precise error message.
 */
function resolveSeedProject(
  paramName: string,
  idParam: string,
  type: string,
  id: string,
  supplied: unknown,
  resolver: ProjectResolver,
): SeedResolution {
  return qualifyNodeProject(type, id, supplied, resolver, {
    paramName,
    idParam,
    noun: 'seed',
    trailer: `${paramName} qualifies the seed only — it does not filter the result to that project.`,
  });
}

// ---------------------------------------------------------------------------
// SQL clause builders
// ---------------------------------------------------------------------------

interface ClauseBundle {
  /** SQL fragment to append (e.g. " AND e.edge_type IN (?, ?)"). */
  fragment: string;
  /** Parameter values, in order, to bind for the fragment. */
  params: unknown[];
}

function softDeleteFragment(includeDeleted: boolean): string {
  return includeDeleted ? '' : " AND COALESCE(json_extract(e.metadata, '$.deleted'), 0) = 0";
}

function edgeTypesFragment(types: string[] | undefined): ClauseBundle {
  if (!types || types.length === 0) return { fragment: '', params: [] };
  const placeholders = types.map(() => '?').join(', ');
  return {
    fragment: ` AND e.edge_type IN (${placeholders})`,
    params: types,
  };
}

// ---------------------------------------------------------------------------
// Label resolution
// ---------------------------------------------------------------------------

interface LabelSchema {
  table: string;
  idCol: string;
  labelExpr: string;
  /** True when ids in entity_edges are stored as the textual representation
   *  of an integer column (learnings.id, errors.id, sessions.id). */
  numericId: boolean;
  /**
   * Column carrying the owning project, when the id is unique only WITHIN a
   * project. Present for `brief` alone today — see `PROJECT_SCOPED_TYPES` in
   * `node-project.ts`. When set, a row matches only if its project equals the
   * requested node's project, so two same-id briefs get their OWN titles.
   */
  projectCol?: string;
}

const LABEL_SCHEMA: Record<EntityType, LabelSchema | null> = {
  // brief_status carries title and is keyed by (project, brief_id), so a bare
  // brief_id selects one row PER PROJECT. BR-078: labels are now resolved on
  // the full (project, brief_id) pair — the project axis is no longer ignored
  // anywhere in this module, and the "pick the first match" behaviour this
  // comment used to describe (which returned a foreign project's title for 343
  // colliding ids) is gone.
  brief: {
    table: 'brief_status',
    idCol: 'brief_id',
    labelExpr: 'title',
    numericId: false,
    projectCol: 'project',
  },
  learning: { table: 'learnings', idCol: 'id', labelExpr: 'substr(content, 1, 80)', numericId: true },
  error: { table: 'errors', idCol: 'id', labelExpr: 'message', numericId: true },
  session: { table: 'sessions', idCol: 'id', labelExpr: 'summary', numericId: true },
  // goals table ships with FR-110; until then we silently fall back to id.
  goal: { table: 'goals', idCol: 'id', labelExpr: 'title', numericId: false },
  // TD-171 M2: free-standing nodes registered in graph_nodes.
  // Both concept and decision resolve via graph_nodes.label, scoped by node_type.
  // The `WHERE node_type = ?` constraint can't be expressed in this generic
  // schema (idCol is the only WHERE column), so we instead pick the table
  // name by entity_type — graph_nodes_concept / graph_nodes_decision is one
  // option, but since label collisions across types are tolerated for v1
  // (the (node_type, node_external_id) pair is unique), we accept that two
  // concept and decision nodes sharing a node_external_id would each return
  // both labels. In practice node_external_id strings carry their type
  // prefix ("concept:foo", "decision:bar") so collisions are vanishingly
  // rare. A node_type-aware resolveLabels is a follow-up if needed.
  concept: { table: 'graph_nodes', idCol: 'node_external_id', labelExpr: 'label', numericId: false },
  decision: { table: 'graph_nodes', idCol: 'node_external_id', labelExpr: 'label', numericId: false },
};

/** One label request — the full node identity, not just `(type, id)`. */
export interface LabelRequest {
  type: string;
  id: string;
  /** Owning project; `null` for a phantom / ownerless node. */
  project: string | null;
}

/**
 * Resolve human-readable labels for a list of `(type, project, id)` triples.
 *
 * BR-078: the returned Map is keyed by `encodeNodeKey(...)`, so two same-id
 * briefs in different projects each receive their OWN project's title. Callers
 * must look up with the same triple they passed in.
 *
 * Runs one query per distinct entity type; gracefully degrades to id-as-label
 * when the underlying table is absent (e.g. goals before FR-110 lands).
 */
export function resolveLabels(
  rows: LabelRequest[],
  db: Database.Database,
  warn: (msg: string) => void = () => {},
): Map<string, string> {
  const labels = new Map<string, string>();
  if (rows.length === 0) return labels;

  // Group requests by type, deduped on the full triple.
  const byType = new Map<string, Map<string, LabelRequest>>();
  for (const row of rows) {
    let bucket = byType.get(row.type);
    if (!bucket) {
      bucket = new Map();
      byType.set(row.type, bucket);
    }
    bucket.set(encodeNodeKey(row), row);
  }

  for (const [type, bucket] of byType) {
    const requests = [...bucket.values()];
    const schema = LABEL_SCHEMA[type as EntityType];
    if (!schema) {
      // Type without a label table (or unknown). Use id as label.
      for (const req of requests) labels.set(encodeNodeKey(req), req.id);
      continue;
    }

    const ids = [...new Set(requests.map((r) => r.id))];
    const placeholders = ids.map(() => '?').join(', ');
    // The project column is SELECTed (never used in the WHERE clause) so the
    // pairing is decided in TypeScript. A SQL row-value `(project, id) IN
    // (VALUES ...)` cannot express the `'' -> null` normalisation, and would
    // silently fail to match a project-less brief; post-filtering keeps that
    // correct and keeps the ids-only IN-clause short.
    const projectSelect = schema.projectCol ? `, ${schema.projectCol} AS project` : '';
    const sql = `SELECT ${schema.idCol} AS id${projectSelect}, ${schema.labelExpr} AS label
                 FROM ${schema.table}
                 WHERE ${schema.idCol} IN (${placeholders})`;

    try {
      // For numeric-id tables, ids in entity_edges are stored as text but
      // SQLite's loose typing means equality across TEXT/INTEGER works.
      const dbRows = db.prepare(sql).all(...ids) as Array<{
        id: string | number;
        project?: unknown;
        label: string | null;
      }>;
      // Keyed by the full triple when the schema is project-scoped, by id alone
      // otherwise (those ids are globally unique by construction).
      const found = new Map<string, string>();
      for (const r of dbRows) {
        if (r.label === null || r.label === undefined) continue;
        const idKey = String(r.id);
        if (schema.projectCol) {
          const project =
            typeof r.project === 'string' && r.project !== '' ? r.project : null;
          found.set(encodeNodeKey({ type, project, id: idKey }), String(r.label));
        } else {
          found.set(idKey, String(r.label));
        }
      }
      for (const req of requests) {
        const key = encodeNodeKey(req);
        const lookup = schema.projectCol ? key : req.id;
        labels.set(key, found.get(lookup) ?? req.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no such table')) {
        if (!warnedMissingTables.has(type)) {
          warnedMissingTables.add(type);
          warn(`Label table "${schema.table}" missing for entity type "${type}" — using id as label`);
        }
        for (const req of requests) labels.set(encodeNodeKey(req), req.id);
      } else {
        // Some other error — re-throw so it surfaces in tests/logs.
        throw err;
      }
    }
  }

  return labels;
}

// ---------------------------------------------------------------------------
// igris_graph_neighbors
// ---------------------------------------------------------------------------

/**
 * BFS within N hops of a seed node.
 *
 * Direction-aware: 'out' follows from→to, 'in' follows to→from, 'both' is
 * undirected. Returns nodes only (caller can re-query edges if needed).
 */
export function handleGraphNeighbors(args: Record<string, unknown>): ToolResult {
  // ---- validate ----
  const fromTypeErr = validateEntityType('node_type', args.node_type);
  if (fromTypeErr) return errorResult(fromTypeErr);
  const nodeId = args.node_id;
  if (typeof nodeId !== 'string' || !nodeId) return errorResult('Missing required field: node_id');

  const requestedDepth = args.depth;
  if (requestedDepth !== undefined && (Number(requestedDepth) < 1 || Number(requestedDepth) > MAX_DEPTH)) {
    return errorResult(`depth must be in [1, ${MAX_DEPTH}]`);
  }
  const depth = clampInt(requestedDepth, 1, MAX_DEPTH, 1);

  const requestedMaxNodes = args.max_nodes;
  if (requestedMaxNodes !== undefined && (Number(requestedMaxNodes) < 1 || Number(requestedMaxNodes) > MAX_RESULT_ROWS)) {
    return errorResult(`max_nodes must be in [1, ${MAX_RESULT_ROWS}]`);
  }
  const maxNodes = clampInt(requestedMaxNodes, 1, MAX_RESULT_ROWS, MAX_RESULT_ROWS);

  const direction = (args.direction as string | undefined) ?? 'both';
  if (!['in', 'out', 'both'].includes(direction)) {
    return errorResult(`direction must be one of: in, out, both`);
  }

  const { types: edgeTypes, error: edgeTypesErr } = validateEdgeTypesFilter(args.edge_types);
  if (edgeTypesErr) return errorResult(edgeTypesErr);

  const includeDeleted = args.include_deleted === true;

  const nodeType = args.node_type as string;
  const db = getDb();

  // ---- BR-078: qualify the seed on the project axis before any traversal ----
  const resolver = createProjectResolver(db);
  const seed = resolveSeedProject('node_project', 'node_id', nodeType, nodeId, args.node_project, resolver);
  if (!seed.ok) return errorResult(seed.error);
  const seedProject = seed.project;

  const edgeBundle = edgeTypesFragment(edgeTypes);
  const softDelete = softDeleteFragment(includeDeleted);

  // Iterative BFS in TS — avoids the recursive-CTE simple-path explosion. We
  // run one parameterized "edges incident to this node" query per frontier
  // node and dedupe via a JS Set. Total work: O(visited × avg-degree),
  // bounded by maxNodes and depth.
  const inPred = '(e.to_type = ? AND e.to_id = ?)';
  const outPred = '(e.from_type = ? AND e.from_id = ?)';
  const bothPred = `(${outPred} OR ${inPred})`;
  const incidentSql = `
    SELECT e.from_type, e.from_id, e.to_type, e.to_id${edgeProjectColumns(db)}
    FROM entity_edges e
    WHERE ${direction === 'in' ? inPred : direction === 'out' ? outPred : bothPred}
      ${edgeBundle.fragment}
      ${softDelete}
  `;
  const incidentStmt = db.prepare(incidentSql);

  const seedKey = encodeNodeKey({ type: nodeType, project: seedProject, id: nodeId });
  const visited = new Map<string, number>([[seedKey, 0]]); // key -> depth at which discovered
  // BFS frontier: array of (type, project, id, depth) processed in order.
  let frontier: Array<NodeKeyParts & { depth: number }> = [
    { type: nodeType, project: seedProject, id: nodeId, depth: 0 },
  ];
  const rawRows: Array<{
    node_type: string;
    node_id: string;
    node_project: string | null;
    depth: number;
  }> = [];
  /** Hops dropped over UNATTRIBUTED rows (BR-083 residual) — never hidden. */
  let unresolvedHops = 0;

  while (frontier.length > 0) {
    const next: Array<NodeKeyParts & { depth: number }> = [];
    for (const cur of frontier) {
      if (cur.depth >= depth) continue;
      // Bind params per direction.
      const params: unknown[] =
        direction === 'in'
          ? [cur.type, cur.id]
          : direction === 'out'
            ? [cur.type, cur.id]
            : [cur.type, cur.id, cur.type, cur.id];
      const rows = incidentStmt.all(
        ...params,
        ...edgeBundle.params,
      ) as Array<{
        from_type: string;
        from_id: string;
        to_type: string;
        to_id: string;
        from_project: string | null;
        to_project: string | null;
      }>;

      for (const r of rows) {
        const isOutbound = r.from_type === cur.type && r.from_id === cur.id;
        const otherType = isOutbound ? r.to_type : r.from_type;
        const otherId = isOutbound ? r.to_id : r.from_id;
        const hop = resolveHopProject(
          cur.project,
          resolver.projectsFor(cur.type, cur.id),
          resolver.projectsFor(otherType, otherId),
          storedHop(r, isOutbound),
        );
        if (hop.verdict !== 'traverse') {
          // Only a genuine loss is counted — `other_instance` means FR-237
          // resolved this edge onto a different instance of the same id, which
          // is correct behaviour, not a residual.
          if (hop.verdict === 'unresolved') unresolvedHops += 1;
          continue;
        }
        const key = encodeNodeKey({ type: otherType, project: hop.project, id: otherId });
        if (visited.has(key)) continue;
        const newDepth = cur.depth + 1;
        visited.set(key, newDepth);
        rawRows.push({
          node_type: otherType,
          node_id: otherId,
          node_project: hop.project,
          depth: newDepth,
        });
        if (rawRows.length >= maxNodes) break;
        next.push({ type: otherType, project: hop.project, id: otherId, depth: newDepth });
      }
      if (rawRows.length >= maxNodes) break;
    }
    if (rawRows.length >= maxNodes) break;
    frontier = next;
  }

  // Sort by depth asc, type asc, id asc — matches the original CTE contract.
  // Project is a FINAL tiebreaker only: pre-BR-078 two rows could never share
  // (depth, type, id), so adding it cannot reorder any existing result. It
  // matters solely for the new fan-out case (one id genuinely reached in two
  // project contexts), where it keeps the output deterministic.
  rawRows.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.node_type !== b.node_type) return a.node_type < b.node_type ? -1 : 1;
    if (a.node_id !== b.node_id) return a.node_id < b.node_id ? -1 : 1;
    const ap = a.node_project ?? '';
    const bp = b.node_project ?? '';
    return ap < bp ? -1 : ap > bp ? 1 : 0;
  });

  const labels = resolveLabels(
    rawRows.map((r) => ({ type: r.node_type, id: r.node_id, project: r.node_project })),
    db,
  );

  const neighbors: NeighborRow[] = rawRows.map((r) => ({
    type: r.node_type,
    id: r.node_id,
    project: r.node_project,
    label:
      labels.get(
        encodeNodeKey({ type: r.node_type, project: r.node_project, id: r.node_id }),
      ) ?? r.node_id,
    depth: r.depth,
  }));

  return successResult(
    JSON.stringify(
      {
        seed: { type: nodeType, id: nodeId, project: seedProject },
        depth,
        direction,
        neighbors,
        count: neighbors.length,
        truncated: neighbors.length >= maxNodes,
        // BR-078: edges skipped because entity_edges carries no project column
        // and the near end gave no honest way to choose an instance. Counted
        // per HOP ATTEMPT, so one edge examined from both ends can contribute
        // twice. See igris_graph_brain's edge_resolution for the brain-wide
        // measurement of the same loss.
        unresolved_hops: unresolvedHops,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// igris_graph_path
// ---------------------------------------------------------------------------

/**
 * Directed shortest path from `from_*` to `to_*`.
 *
 * Per FR-113 user-approved decisions, v1 is directed-only — paths follow
 * outgoing edges. Cycle-safe via path-string visited-set; max_depth defaults
 * to 5, capped at 10.
 */
export function handleGraphPath(args: Record<string, unknown>): ToolResult {
  // ---- validate ----
  const fromTypeErr = validateEntityType('from_type', args.from_type);
  if (fromTypeErr) return errorResult(fromTypeErr);
  const toTypeErr = validateEntityType('to_type', args.to_type);
  if (toTypeErr) return errorResult(toTypeErr);

  const fromId = args.from_id;
  if (typeof fromId !== 'string' || !fromId) return errorResult('Missing required field: from_id');
  const toId = args.to_id;
  if (typeof toId !== 'string' || !toId) return errorResult('Missing required field: to_id');

  const requestedMaxDepth = args.max_depth;
  if (requestedMaxDepth !== undefined && (Number(requestedMaxDepth) < 1 || Number(requestedMaxDepth) > MAX_DEPTH)) {
    return errorResult(`max_depth must be in [1, ${MAX_DEPTH}]`);
  }
  const maxDepth = clampInt(requestedMaxDepth, 1, MAX_DEPTH, 5);

  const { types: edgeTypes, error: edgeTypesErr } = validateEdgeTypesFilter(args.edge_types);
  if (edgeTypesErr) return errorResult(edgeTypesErr);

  const includeDeleted = args.include_deleted === true;

  const fromType = args.from_type as string;
  const toType = args.to_type as string;
  const db = getDb();

  // ---- BR-078: BOTH endpoints are seeds and BOTH go through the ladder. ----
  // Qualifying the TARGET is what makes "no path between two projects' same-id
  // briefs" true: without it, `to_id: 'BR-001'` matches whichever BR-001 the
  // walk happens to reach first.
  const resolver = createProjectResolver(db);
  const fromSeed = resolveSeedProject('from_project', 'from_id', fromType, fromId, args.from_project, resolver);
  if (!fromSeed.ok) return errorResult(fromSeed.error);
  const toSeed = resolveSeedProject('to_project', 'to_id', toType, toId, args.to_project, resolver);
  if (!toSeed.ok) return errorResult(toSeed.error);
  const fromProject = fromSeed.project;
  const toProject = toSeed.project;

  const edgeBundle = edgeTypesFragment(edgeTypes);
  const softDelete = softDeleteFragment(includeDeleted);

  // Iterative BFS shortest path. We avoid the recursive CTE here because
  // SQLite explores all simple paths (UNION ALL with path-string visited-set)
  // which blows up exponentially in dense graphs. Standard BFS via JS visits
  // each node at most once, giving O(V + E) within max_depth.
  const outgoingSql = `
    SELECT e.id AS edge_id, e.to_type, e.to_id, e.edge_type${edgeProjectColumns(db)}
    FROM entity_edges e
    WHERE e.from_type = ? AND e.from_id = ?
      ${edgeBundle.fragment}
      ${softDelete}
  `;
  const outgoingStmt = db.prepare(outgoingSql);

  const startParts: NodeKeyParts = { type: fromType, project: fromProject, id: fromId };
  const targetParts: NodeKeyParts = { type: toType, project: toProject, id: toId };
  const startKey = encodeNodeKey(startParts);
  const targetKey = encodeNodeKey(targetParts);

  /**
   * child_key -> its parent, STRUCTURED.
   *
   * BR-078: `parentParts` carries the triple so reconstruction never has to
   * parse a key back out. The pre-BR-078 code re-derived the parent with
   * `cursor.split('|')`, which is wrong on an escaped key and — worse — wrong
   * in a way that passes every happy-path test. There is now no decode site in
   * this module at all.
   */
  interface ParentPointer {
    parentKey: string;
    parentParts: NodeKeyParts;
    edgeId: number;
    edgeType: string;
  }
  const parents = new Map<string, ParentPointer>();
  const visited = new Set<string>([startKey]);
  let frontier: Array<NodeKeyParts & { key: string; depth: number }> = [
    { ...startParts, key: startKey, depth: 0 },
  ];
  let foundDepth: number | null = null;
  /** Hops dropped over UNATTRIBUTED rows (BR-083 residual) — never hidden. */
  let unresolvedHops = 0;

  outer: while (frontier.length > 0) {
    const next: Array<NodeKeyParts & { key: string; depth: number }> = [];
    for (const cur of frontier) {
      if (cur.depth >= maxDepth) continue;
      const rows = outgoingStmt.all(cur.type, cur.id, ...edgeBundle.params) as Array<{
        edge_id: number;
        to_type: string;
        to_id: string;
        edge_type: string;
        from_project: string | null;
        to_project: string | null;
      }>;
      for (const r of rows) {
        // `igris_graph_path` walks OUTBOUND only, so the near side is always
        // the row's `from_project`.
        const hop = resolveHopProject(
          cur.project,
          resolver.projectsFor(cur.type, cur.id),
          resolver.projectsFor(r.to_type, r.to_id),
          storedHop(r, true),
        );
        if (hop.verdict !== 'traverse') {
          if (hop.verdict === 'unresolved') unresolvedHops += 1;
          continue;
        }
        const childParts: NodeKeyParts = {
          type: r.to_type,
          project: hop.project,
          id: r.to_id,
        };
        const childKey = encodeNodeKey(childParts);
        if (visited.has(childKey)) continue;
        visited.add(childKey);
        parents.set(childKey, {
          parentKey: cur.key,
          parentParts: { type: cur.type, project: cur.project, id: cur.id },
          edgeId: r.edge_id,
          edgeType: r.edge_type,
        });
        if (childKey === targetKey) {
          foundDepth = cur.depth + 1;
          break outer;
        }
        next.push({ ...childParts, key: childKey, depth: cur.depth + 1 });
      }
    }
    frontier = next;
  }

  if (foundDepth === null) {
    return successResult(
      JSON.stringify(
        {
          from: { type: fromType, id: fromId, project: fromProject },
          to: { type: toType, id: toId, project: toProject },
          found: false,
          length: null,
          path: [],
          unresolved_hops: unresolvedHops,
        },
        null,
        2,
      ),
    );
  }

  // Reconstruct path from the parents map. Every step is read from the STORED
  // triple — no key is ever parsed back apart.
  const reverseSteps: Array<NodeKeyParts & { edge_id?: number; edge_type?: string }> = [];
  // First add the target with its incoming edge meta.
  const targetParent = parents.get(targetKey);
  if (!targetParent) {
    // Should not happen given foundDepth check, but defensive.
    return errorResult('Internal: path reconstruction failed');
  }
  reverseSteps.push({ ...targetParts, edge_id: targetParent.edgeId, edge_type: targetParent.edgeType });
  let cursorKey = targetParent.parentKey;
  let cursorParts = targetParent.parentParts;
  while (cursorKey !== startKey) {
    const meta = parents.get(cursorKey);
    if (meta) {
      reverseSteps.push({ ...cursorParts, edge_id: meta.edgeId, edge_type: meta.edgeType });
      cursorKey = meta.parentKey;
      cursorParts = meta.parentParts;
    } else {
      // Defensive: cycle in parents map (shouldn't occur with visited-set).
      reverseSteps.push({ ...cursorParts });
      break;
    }
  }
  // Add the start node (no incoming edge metadata).
  reverseSteps.push({ ...startParts });

  const rawSteps = reverseSteps.reverse();
  // Force the depth recorded onto length for response shape compatibility
  // with the previous SQL-version output (which used `depth` from the CTE).
  const length = foundDepth;

  const labels = resolveLabels(
    rawSteps.map((s) => ({ type: s.type, id: s.id, project: s.project })),
    db,
  );

  const path: PathStep[] = rawSteps.map((s) => ({
    type: s.type,
    id: s.id,
    project: s.project,
    label: labels.get(encodeNodeKey({ type: s.type, project: s.project, id: s.id })) ?? s.id,
    ...(s.edge_id !== undefined ? { edge_id: s.edge_id } : {}),
    ...(s.edge_type !== undefined ? { edge_type: s.edge_type } : {}),
  }));

  return successResult(
    JSON.stringify(
      {
        from: { type: fromType, id: fromId, project: fromProject },
        to: { type: toType, id: toId, project: toProject },
        found: true,
        length,
        path,
        unresolved_hops: unresolvedHops,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// igris_graph_subgraph
// ---------------------------------------------------------------------------

/**
 * Connected subgraph (nodes + edges) reachable from a seed node, bounded
 * by max_nodes. Uses both-direction BFS. Cached for 5 minutes.
 */
export function handleGraphSubgraph(args: Record<string, unknown>): ToolResult {
  // ---- validate ----
  const seedTypeErr = validateEntityType('seed_node_type', args.seed_node_type);
  if (seedTypeErr) return errorResult(seedTypeErr);
  const seedId = args.seed_node_id;
  if (typeof seedId !== 'string' || !seedId) return errorResult('Missing required field: seed_node_id');

  const requestedMaxNodes = args.max_nodes;
  if (requestedMaxNodes !== undefined && (Number(requestedMaxNodes) < 1 || Number(requestedMaxNodes) > MAX_SUBGRAPH_NODES)) {
    return errorResult(`max_nodes must be in [1, ${MAX_SUBGRAPH_NODES}]`);
  }
  const maxNodes = clampInt(requestedMaxNodes, 1, MAX_SUBGRAPH_NODES, 20);

  const { types: edgeTypes, error: edgeTypesErr } = validateEdgeTypesFilter(args.edge_types);
  if (edgeTypesErr) return errorResult(edgeTypesErr);

  const includeDeleted = args.include_deleted === true;
  const seedType = args.seed_node_type as string;

  // BR-078: the db handle is now needed BEFORE the cache lookup, because the
  // cache key carries the RESOLVED seed project and resolving it is a query.
  const db = getDb();
  const resolver = createProjectResolver(db);
  const seed = resolveSeedProject(
    'seed_node_project',
    'seed_node_id',
    seedType,
    seedId,
    args.seed_node_project,
    resolver,
  );
  if (!seed.ok) return errorResult(seed.error);
  const seedProject = seed.project;

  // ---- cache lookup ----
  const cacheKey = subgraphCacheKey({
    seed_node_type: seedType,
    seed_node_id: seedId,
    seed_project: seedProject,
    max_nodes: maxNodes,
    edge_types: edgeTypes,
    include_deleted: includeDeleted,
  });
  const cached = cacheGet(cacheKey);
  if (cached) {
    return successResult(JSON.stringify({ ...cached, cached: true }, null, 2));
  }

  const edgeBundle = edgeTypesFragment(edgeTypes);
  const softDelete = softDeleteFragment(includeDeleted);

  // BFS over both directions using an iterative TS-driven frontier instead of
  // a recursive CTE. SQLite's recursive CTE with path-string visited-set
  // explores all simple paths from the seed, which explodes exponentially in
  // dense graphs (5^10 ≈ 10M rows on a 200-node/500-edge graph). Here we keep
  // a global visited set in JS and run one parameterized neighbor-fetch per
  // frontier node — O(n × avg-degree) total work, capped at maxNodes.
  // BR-083: the qualifiers are read for the HOP DECISION only. They are NOT
  // added to the `edgeSql` below, so `igris_graph_subgraph`'s emitted
  // `edges[]` field set is byte-identical to its pre-BR-083 shape.
  const neighborSql = `
    SELECT e.id, e.from_type, e.from_id, e.to_type, e.to_id, e.edge_type, e.confidence, e.provenance, e.metadata${edgeProjectColumns(db)}
    FROM entity_edges e
    WHERE ((e.from_type = ? AND e.from_id = ?) OR (e.to_type = ? AND e.to_id = ?))
      ${edgeBundle.fragment}
      ${softDelete}
  `;
  const neighborStmt = db.prepare(neighborSql);

  const visited = new Set<string>([
    encodeNodeKey({ type: seedType, project: seedProject, id: seedId }),
  ]);
  const nodeRows: Array<{ node_type: string; node_id: string; node_project: string | null }> = [
    { node_type: seedType, node_id: seedId, node_project: seedProject },
  ];
  const queue: NodeKeyParts[] = [{ type: seedType, project: seedProject, id: seedId }];
  /** Hops dropped over UNATTRIBUTED rows (BR-083 residual) — never hidden. */
  let unresolvedHops = 0;

  while (queue.length > 0 && nodeRows.length < maxNodes) {
    const cur = queue.shift()!;
    const rows = neighborStmt.all(
      cur.type,
      cur.id,
      cur.type,
      cur.id,
      ...edgeBundle.params,
    ) as Array<
      EdgeProjection & { from_project: string | null; to_project: string | null }
    >;

    for (const r of rows) {
      // Determine the "other side" of the edge relative to cur.
      const isOutbound = r.from_type === cur.type && r.from_id === cur.id;
      const otherType = isOutbound ? r.to_type : r.from_type;
      const otherId = isOutbound ? r.to_id : r.from_id;
      const hop = resolveHopProject(
        cur.project,
        resolver.projectsFor(cur.type, cur.id),
        resolver.projectsFor(otherType, otherId),
        storedHop(r, isOutbound),
      );
      if (hop.verdict !== 'traverse') {
        if (hop.verdict === 'unresolved') unresolvedHops += 1;
        continue;
      }
      const key = encodeNodeKey({ type: otherType, project: hop.project, id: otherId });
      if (visited.has(key)) continue;
      visited.add(key);
      nodeRows.push({ node_type: otherType, node_id: otherId, node_project: hop.project });
      queue.push({ type: otherType, project: hop.project, id: otherId });
      if (nodeRows.length >= maxNodes) break;
    }
  }

  // Stable ordering for deterministic output (matches prior CTE ordering).
  // Project is a FINAL tiebreaker — see the equivalent note in
  // handleGraphNeighbors for why it cannot reorder a pre-BR-078 result.
  nodeRows.sort((a, b) => {
    if (a.node_type !== b.node_type) return a.node_type < b.node_type ? -1 : 1;
    if (a.node_id !== b.node_id) return a.node_id < b.node_id ? -1 : 1;
    const ap = a.node_project ?? '';
    const bp = b.node_project ?? '';
    return ap < bp ? -1 : ap > bp ? 1 : 0;
  });

  // Collect edges among the discovered nodes. We use a temp table inside a
  // single transaction so the subsequent EXISTS queries can use it.
  const txn = db.transaction(() => {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS _subgraph_nodes (
       node_type TEXT NOT NULL,
       node_id   TEXT NOT NULL,
       PRIMARY KEY (node_type, node_id)
     )`);
    db.exec('DELETE FROM _subgraph_nodes');
    // OR IGNORE, matched on `(type, id)` only. When fan-out legitimately places
    // two instances of ONE id in the node set (reached in two project
    // contexts), they collapse to a single row here, so `edges[]` is
    // attributable to the id but not to a specific instance. The `nodes[]`
    // array is unaffected and remains project-correct.
    //
    // BR-083 UPDATE — the premise changed, the residual did not close, AND
    // THAT IS A DECISION RATHER THAN AN OVERSIGHT. `entity_edges` now HAS
    // `from_project` / `to_project`, so the match COULD carry a project
    // predicate. It is deliberately not added here: putting `project` in this
    // temp table's PRIMARY KEY would let two instances of one id both insert,
    // and the two EXISTS clauses would then emit the SAME `entity_edges` row
    // twice — a duplicate in `edges[]`, which is a wire-shape regression in
    // exchange for a precision gain on the qualified subset only (about half
    // the rows still carry NULL and would need the `IS NULL` arm anyway).
    // Closing it means deciding how `edges[]` de-duplicates, which is
    // `igris_graph_subgraph`'s payload contract and belongs to its own brief
    // (TD-308 territory).
    const insert = db.prepare(
      'INSERT OR IGNORE INTO _subgraph_nodes (node_type, node_id) VALUES (?, ?)',
    );
    for (const r of nodeRows) insert.run(r.node_type, r.node_id);

    const edgeSql = `
      SELECT e.id, e.from_type, e.from_id, e.to_type, e.to_id, e.edge_type, e.confidence, e.provenance, e.metadata
      FROM entity_edges e
      WHERE EXISTS (
        SELECT 1 FROM _subgraph_nodes n WHERE n.node_type = e.from_type AND n.node_id = e.from_id
      )
      AND EXISTS (
        SELECT 1 FROM _subgraph_nodes n WHERE n.node_type = e.to_type AND n.node_id = e.to_id
      )
      ${softDelete}
      ${edgeBundle.fragment}
      ORDER BY e.id ASC
    `;

    return db.prepare(edgeSql).all(...edgeBundle.params) as EdgeProjection[];
  });

  const edgeRows = txn();

  // ---- enrich with labels ----
  const labels = resolveLabels(
    nodeRows.map((r) => ({ type: r.node_type, id: r.node_id, project: r.node_project })),
    db,
  );

  const nodes = nodeRows.map((r) => ({
    type: r.node_type,
    id: r.node_id,
    project: r.node_project,
    label:
      labels.get(
        encodeNodeKey({ type: r.node_type, project: r.node_project, id: r.node_id }),
      ) ?? r.node_id,
    // BR-078: project is part of the comparison. Without it, a fan-out instance
    // of the same id reached in ANOTHER project would be flagged as the seed.
    is_seed:
      r.node_type === seedType && r.node_id === seedId && r.node_project === seedProject,
  }));

  const result: SubgraphResult = {
    seed: { type: seedType, id: seedId, project: seedProject },
    nodes,
    edges: edgeRows,
    truncated: nodes.length >= maxNodes,
    cached: false,
    unresolved_hops: unresolvedHops,
  };

  cacheSet(cacheKey, result);

  return successResult(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Test hooks (exported only for unit tests; not part of the public API)
// ---------------------------------------------------------------------------

/** Reset internal state (cache + warning log). Test-only. */
export function _resetTraversalState(): void {
  subgraphCache.clear();
  warnedMissingTables.clear();
}

/** Inspect cache size. Test-only. */
export function _getSubgraphCacheSize(): number {
  return subgraphCache.size;
}
