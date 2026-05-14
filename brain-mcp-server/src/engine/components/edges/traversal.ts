/**
 * Brain Engine v7.0 — Edges Component Graph Traversal (FR-113)
 *
 * Three read-only graph tools layered on top of entity_edges:
 *   - igris_graph_neighbors  — BFS within N hops (direction-aware)
 *   - igris_graph_path       — directed shortest path (cycle-safe)
 *   - igris_graph_subgraph   — connected subgraph for visualization (cached)
 *
 * Implementation notes:
 *   - Iterative BFS in TypeScript with per-frontier parameterized SQL queries
 *     against entity_edges. Visited-set lives in a JS Set keyed by
 *     `${type}|${id}`. Recursive CTE was prototyped first but `UNION` could
 *     not dedupe across distinct path-string visited-sets, causing row
 *     enumeration to explode ~deg^depth. The iterative form visits each node
 *     at most once: O(V + E) within depth bound.
 *   - Soft-delete filter (metadata.deleted=true) is applied by default,
 *     matching the FR-105 igris_edge_list pattern.
 *   - Hard caps: depth in [1, 10], max_nodes in [1, 100], result rows in
 *     [1, 100]. Caps are clamped silently rather than rejected so the
 *     LLM-callable surface stays forgiving.
 *   - Labels are resolved post-traversal in TypeScript via per-type
 *     batched queries; missing tables (e.g. goals before FR-110) fall
 *     back to id-as-label with a one-time warning per process.
 *   - Subgraph results are cached for 5 minutes in a closure-scoped Map
 *     (LRU-bounded at 64 entries) and invalidated by edge.created /
 *     edge.removed bus events.
 *
 * @module engine/components/edges/traversal
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult } from '../../helpers.js';
import { VALID_EDGE_TYPES, VALID_ENTITY_TYPES } from './handlers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EntityType = (typeof VALID_ENTITY_TYPES)[number];

/** A node enriched with a human-readable label. */
export interface NodeRow {
  type: string;
  id: string;
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
  label: string;
  edge_id?: number;
  edge_type?: string;
}

/** Subgraph response shape. */
interface SubgraphResult {
  seed: { type: string; id: string };
  nodes: Array<NodeRow & { is_seed?: boolean }>;
  edges: EdgeProjection[];
  truncated: boolean;
  cached: boolean;
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

/** Build a stable cache key for the subgraph tool. */
function subgraphCacheKey(args: {
  seed_node_type: string;
  seed_node_id: string;
  max_nodes: number;
  edge_types: string[] | undefined;
  include_deleted: boolean;
}): string {
  return JSON.stringify({
    s: `${args.seed_node_type}|${args.seed_node_id}`,
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
}

const LABEL_SCHEMA: Record<EntityType, LabelSchema | null> = {
  // brief_status carries title and is keyed by (project, brief_id). We ignore
  // the project axis here and pick the first match — labels are presentation
  // only, and brief_ids are project-scoped in practice.
  brief: { table: 'brief_status', idCol: 'brief_id', labelExpr: 'title', numericId: false },
  learning: { table: 'learnings', idCol: 'id', labelExpr: 'substr(content, 1, 80)', numericId: true },
  error: { table: 'errors', idCol: 'id', labelExpr: 'message', numericId: true },
  session: { table: 'sessions', idCol: 'id', labelExpr: 'summary', numericId: true },
  // goals table ships with FR-110; until then we silently fall back to id.
  goal: { table: 'goals', idCol: 'id', labelExpr: 'title', numericId: false },
};

/**
 * Resolve human-readable labels for a list of (type, id) pairs.
 *
 * Runs one query per distinct entity type; gracefully degrades to id-as-label
 * when the underlying table is absent (e.g. goals before FR-110 lands).
 */
export function resolveLabels(
  rows: Array<{ type: string; id: string }>,
  db: Database.Database,
  warn: (msg: string) => void = () => {},
): Map<string, string> {
  const labels = new Map<string, string>();
  if (rows.length === 0) return labels;

  // Group ids by type
  const byType = new Map<string, Set<string>>();
  for (const { type, id } of rows) {
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type)!.add(id);
  }

  for (const [type, idSet] of byType) {
    const schema = LABEL_SCHEMA[type as EntityType];
    if (!schema) {
      // Type without a label table (or unknown). Use id as label.
      for (const id of idSet) labels.set(`${type}|${id}`, id);
      continue;
    }

    const ids = [...idSet];
    const placeholders = ids.map(() => '?').join(', ');
    const sql = `SELECT ${schema.idCol} AS id, ${schema.labelExpr} AS label
                 FROM ${schema.table}
                 WHERE ${schema.idCol} IN (${placeholders})`;

    try {
      // For numeric-id tables, ids in entity_edges are stored as text but
      // SQLite's loose typing means equality across TEXT/INTEGER works.
      const dbRows = db.prepare(sql).all(...ids) as Array<{ id: string | number; label: string | null }>;
      const found = new Map<string, string>();
      for (const r of dbRows) {
        const idKey = String(r.id);
        if (r.label !== null && r.label !== undefined) {
          found.set(idKey, String(r.label));
        }
      }
      for (const id of ids) {
        labels.set(`${type}|${id}`, found.get(id) ?? id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no such table')) {
        if (!warnedMissingTables.has(type)) {
          warnedMissingTables.add(type);
          warn(`Label table "${schema.table}" missing for entity type "${type}" — using id as label`);
        }
        for (const id of ids) labels.set(`${type}|${id}`, id);
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
    SELECT e.from_type, e.from_id, e.to_type, e.to_id
    FROM entity_edges e
    WHERE ${direction === 'in' ? inPred : direction === 'out' ? outPred : bothPred}
      ${edgeBundle.fragment}
      ${softDelete}
  `;
  const incidentStmt = db.prepare(incidentSql);

  const seedKey = `${nodeType}|${nodeId}`;
  const visited = new Map<string, number>([[seedKey, 0]]); // key -> depth at which discovered
  // BFS frontier: array of (type, id, depth) processed in order.
  let frontier: Array<{ type: string; id: string; depth: number }> = [
    { type: nodeType, id: nodeId, depth: 0 },
  ];
  const rawRows: Array<{ node_type: string; node_id: string; depth: number }> = [];

  while (frontier.length > 0) {
    const next: Array<{ type: string; id: string; depth: number }> = [];
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
      ) as Array<{ from_type: string; from_id: string; to_type: string; to_id: string }>;

      for (const r of rows) {
        const isOutbound = r.from_type === cur.type && r.from_id === cur.id;
        const otherType = isOutbound ? r.to_type : r.from_type;
        const otherId = isOutbound ? r.to_id : r.from_id;
        const key = `${otherType}|${otherId}`;
        if (visited.has(key)) continue;
        const newDepth = cur.depth + 1;
        visited.set(key, newDepth);
        rawRows.push({ node_type: otherType, node_id: otherId, depth: newDepth });
        if (rawRows.length >= maxNodes) break;
        next.push({ type: otherType, id: otherId, depth: newDepth });
      }
      if (rawRows.length >= maxNodes) break;
    }
    if (rawRows.length >= maxNodes) break;
    frontier = next;
  }

  // Sort by depth asc, type asc, id asc — matches the original CTE contract.
  rawRows.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.node_type !== b.node_type) return a.node_type < b.node_type ? -1 : 1;
    return a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0;
  });

  const labels = resolveLabels(
    rawRows.map((r) => ({ type: r.node_type, id: r.node_id })),
    db,
  );

  const neighbors: NeighborRow[] = rawRows.map((r) => ({
    type: r.node_type,
    id: r.node_id,
    label: labels.get(`${r.node_type}|${r.node_id}`) ?? r.node_id,
    depth: r.depth,
  }));

  return successResult(
    JSON.stringify(
      {
        seed: { type: nodeType, id: nodeId },
        depth,
        direction,
        neighbors,
        count: neighbors.length,
        truncated: neighbors.length >= maxNodes,
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

  const edgeBundle = edgeTypesFragment(edgeTypes);
  const softDelete = softDeleteFragment(includeDeleted);

  // Iterative BFS shortest path. We avoid the recursive CTE here because
  // SQLite explores all simple paths (UNION ALL with path-string visited-set)
  // which blows up exponentially in dense graphs. Standard BFS via JS visits
  // each node at most once, giving O(V + E) within max_depth.
  const outgoingSql = `
    SELECT e.id AS edge_id, e.to_type, e.to_id, e.edge_type
    FROM entity_edges e
    WHERE e.from_type = ? AND e.from_id = ?
      ${edgeBundle.fragment}
      ${softDelete}
  `;
  const outgoingStmt = db.prepare(outgoingSql);

  const startKey = `${fromType}|${fromId}`;
  const targetKey = `${toType}|${toId}`;

  // parents: child_key -> { parent_key, edge_id, edge_type }
  const parents = new Map<string, { parent: string; edgeId: number; edgeType: string }>();
  const visited = new Set<string>([startKey]);
  let frontier: Array<{ type: string; id: string; depth: number }> = [
    { type: fromType, id: fromId, depth: 0 },
  ];
  let foundDepth: number | null = null;

  outer: while (frontier.length > 0) {
    const next: Array<{ type: string; id: string; depth: number }> = [];
    for (const cur of frontier) {
      if (cur.depth >= maxDepth) continue;
      const rows = outgoingStmt.all(cur.type, cur.id, ...edgeBundle.params) as Array<{
        edge_id: number;
        to_type: string;
        to_id: string;
        edge_type: string;
      }>;
      for (const r of rows) {
        const childKey = `${r.to_type}|${r.to_id}`;
        if (visited.has(childKey)) continue;
        visited.add(childKey);
        parents.set(childKey, {
          parent: `${cur.type}|${cur.id}`,
          edgeId: r.edge_id,
          edgeType: r.edge_type,
        });
        if (childKey === targetKey) {
          foundDepth = cur.depth + 1;
          break outer;
        }
        next.push({ type: r.to_type, id: r.to_id, depth: cur.depth + 1 });
      }
    }
    frontier = next;
  }

  if (foundDepth === null) {
    return successResult(
      JSON.stringify(
        {
          from: { type: fromType, id: fromId },
          to: { type: toType, id: toId },
          found: false,
          length: null,
          path: [],
        },
        null,
        2,
      ),
    );
  }

  // Reconstruct path from parents map.
  const reverseSteps: Array<{ type: string; id: string; edge_id?: number; edge_type?: string }> = [];
  let cursor = targetKey;
  // First add the target with its incoming edge meta.
  const targetParent = parents.get(targetKey);
  if (!targetParent) {
    // Should not happen given foundDepth check, but defensive.
    return errorResult('Internal: path reconstruction failed');
  }
  reverseSteps.push({ type: toType, id: toId, edge_id: targetParent.edgeId, edge_type: targetParent.edgeType });
  cursor = targetParent.parent;
  while (cursor !== startKey) {
    const meta = parents.get(cursor);
    const [t, ...rest] = cursor.split('|');
    const id = rest.join('|');
    if (meta) {
      reverseSteps.push({ type: t, id, edge_id: meta.edgeId, edge_type: meta.edgeType });
      cursor = meta.parent;
    } else {
      // Defensive: cycle in parents map (shouldn't occur with visited-set).
      reverseSteps.push({ type: t, id });
      break;
    }
  }
  // Add the start node (no incoming edge metadata).
  reverseSteps.push({ type: fromType, id: fromId });

  const rawSteps = reverseSteps.reverse();
  // Force the depth recorded onto length for response shape compatibility
  // with the previous SQL-version output (which used `depth` from the CTE).
  const length = foundDepth;

  const labels = resolveLabels(
    rawSteps.map((s) => ({ type: s.type, id: s.id })),
    db,
  );

  const path: PathStep[] = rawSteps.map((s) => ({
    type: s.type,
    id: s.id,
    label: labels.get(`${s.type}|${s.id}`) ?? s.id,
    ...(s.edge_id !== undefined ? { edge_id: s.edge_id } : {}),
    ...(s.edge_type !== undefined ? { edge_type: s.edge_type } : {}),
  }));

  return successResult(
    JSON.stringify(
      {
        from: { type: fromType, id: fromId },
        to: { type: toType, id: toId },
        found: true,
        length,
        path,
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

  // ---- cache lookup ----
  const cacheKey = subgraphCacheKey({
    seed_node_type: seedType,
    seed_node_id: seedId,
    max_nodes: maxNodes,
    edge_types: edgeTypes,
    include_deleted: includeDeleted,
  });
  const cached = cacheGet(cacheKey);
  if (cached) {
    return successResult(JSON.stringify({ ...cached, cached: true }, null, 2));
  }

  const db = getDb();
  const edgeBundle = edgeTypesFragment(edgeTypes);
  const softDelete = softDeleteFragment(includeDeleted);

  // BFS over both directions using an iterative TS-driven frontier instead of
  // a recursive CTE. SQLite's recursive CTE with path-string visited-set
  // explores all simple paths from the seed, which explodes exponentially in
  // dense graphs (5^10 ≈ 10M rows on a 200-node/500-edge graph). Here we keep
  // a global visited set in JS and run one parameterized neighbor-fetch per
  // frontier node — O(n × avg-degree) total work, capped at maxNodes.
  const neighborSql = `
    SELECT e.id, e.from_type, e.from_id, e.to_type, e.to_id, e.edge_type, e.confidence, e.provenance, e.metadata
    FROM entity_edges e
    WHERE ((e.from_type = ? AND e.from_id = ?) OR (e.to_type = ? AND e.to_id = ?))
      ${edgeBundle.fragment}
      ${softDelete}
  `;
  const neighborStmt = db.prepare(neighborSql);

  const visited = new Set<string>([`${seedType}|${seedId}`]);
  const nodeRows: Array<{ node_type: string; node_id: string }> = [
    { node_type: seedType, node_id: seedId },
  ];
  const queue: Array<{ type: string; id: string }> = [{ type: seedType, id: seedId }];

  while (queue.length > 0 && nodeRows.length < maxNodes) {
    const cur = queue.shift()!;
    const rows = neighborStmt.all(
      cur.type,
      cur.id,
      cur.type,
      cur.id,
      ...edgeBundle.params,
    ) as EdgeProjection[];

    for (const r of rows) {
      // Determine the "other side" of the edge relative to cur.
      const isOutbound = r.from_type === cur.type && r.from_id === cur.id;
      const otherType = isOutbound ? r.to_type : r.from_type;
      const otherId = isOutbound ? r.to_id : r.from_id;
      const key = `${otherType}|${otherId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      nodeRows.push({ node_type: otherType, node_id: otherId });
      queue.push({ type: otherType, id: otherId });
      if (nodeRows.length >= maxNodes) break;
    }
  }

  // Stable ordering for deterministic output (matches prior CTE ordering).
  nodeRows.sort((a, b) => {
    if (a.node_type !== b.node_type) return a.node_type < b.node_type ? -1 : 1;
    return a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0;
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
    const insert = db.prepare('INSERT INTO _subgraph_nodes (node_type, node_id) VALUES (?, ?)');
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
    nodeRows.map((r) => ({ type: r.node_type, id: r.node_id })),
    db,
  );

  const nodes = nodeRows.map((r) => ({
    type: r.node_type,
    id: r.node_id,
    label: labels.get(`${r.node_type}|${r.node_id}`) ?? r.node_id,
    is_seed: r.node_type === seedType && r.node_id === seedId,
  }));

  const result: SubgraphResult = {
    seed: { type: seedType, id: seedId },
    nodes,
    edges: edgeRows,
    truncated: nodes.length >= maxNodes,
    cached: false,
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
