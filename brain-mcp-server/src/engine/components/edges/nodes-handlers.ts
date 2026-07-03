/**
 * Brain Engine v7.0 — Edges Component: Graph Node Handlers (TD-171 M2)
 *
 * Handlers for the four node-surface graph tools added in TD-171 M2:
 *   - igris_graph_node_create  — idempotent INSERT into graph_nodes
 *   - igris_graph_node_get     — single-row SELECT plus edge-degree counts
 *   - igris_graph_search       — LIKE query against label + node_external_id
 *   - igris_graph_dashboard    — aggregate counts over graph_nodes + entity_edges
 *
 * The handlers live in their own file (separate from `handlers.ts` which
 * owns edge CRUD) per plan §3 M2 — keeping edge logic and node logic in
 * different modules makes diffs easier to review and the edge-CRUD file
 * doesn't grow beyond ~370 lines.
 *
 * Pure functions: take Record<string, unknown> args, validate at runtime,
 * return ToolResult. Called from both the gateway (via the component's
 * tools() registration) and directly from tests; cannot assume gateway
 * has already filtered args.
 *
 * @module engine/components/edges/nodes-handlers
 * @author fifty.dev
 */

import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult } from '../../helpers.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Shape of a graph_nodes row as returned to callers. */
export interface GraphNodeRow {
  id: number;
  node_type: string;
  node_external_id: string;
  label: string;
  properties: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Serialize a properties bag to JSON; tolerate already-stringified input. */
function normalizeProperties(raw: unknown): string {
  if (raw === undefined || raw === null) return '{}';
  if (typeof raw === 'string') {
    // Allow callers to pre-stringify (e.g. backfill scripts) without double-escaping.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return raw;
    } catch {
      // Not JSON — wrap as { value: raw }.
    }
    return JSON.stringify({ value: raw });
  }
  return JSON.stringify(raw);
}

/** Parse the properties JSON string for read-side handlers; tolerate corruption. */
function parsePropertiesSafe(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

// ---------------------------------------------------------------------------
// handleGraphNodeCreate
// ---------------------------------------------------------------------------

/**
 * Idempotent INSERT into graph_nodes.
 *
 * Required: node_type, node_external_id, label
 * Optional: properties (JSON object; default {})
 *
 * Returns: { id, node_type, node_external_id, label, created: true|false }.
 *
 * Idempotency: re-creating an identical (node_type, node_external_id) pair
 * returns the existing row's id with `created: false`. Relies on the
 * UNIQUE(node_type, node_external_id) constraint for atomicity.
 *
 * Note on `label`: when an existing node is found, we return the EXISTING
 * label, NOT the caller's. Updating label-on-conflict would silently mutate
 * persisted data — callers who want to rename a node should explicitly
 * delete + recreate, or wait for a future igris_graph_node_update tool.
 */
export function handleGraphNodeCreate(args: Record<string, unknown>): ToolResult {
  const nodeType = args.node_type as string | undefined;
  const nodeExternalId = args.node_external_id as string | undefined;
  const label = args.label as string | undefined;

  if (!nodeType || !nodeExternalId || !label) {
    return errorResult(
      'Missing required fields: node_type, node_external_id, label',
    );
  }

  if (typeof nodeType !== 'string' || nodeType.length === 0) {
    return errorResult('node_type must be a non-empty string');
  }
  if (typeof nodeExternalId !== 'string' || nodeExternalId.length === 0) {
    return errorResult('node_external_id must be a non-empty string');
  }
  if (typeof label !== 'string' || label.length === 0) {
    return errorResult('label must be a non-empty string');
  }

  const properties = normalizeProperties(args.properties);

  const db = getDb();

  const insert = db
    .prepare(
      `INSERT OR IGNORE INTO graph_nodes
         (node_type, node_external_id, label, properties)
       VALUES (?, ?, ?, ?)`,
    )
    .run(nodeType, nodeExternalId, label, properties);

  const created = insert.changes === 1;

  const row = db
    .prepare(
      `SELECT id, node_type, node_external_id, label, properties, created_at
       FROM graph_nodes
       WHERE node_type = ? AND node_external_id = ?`,
    )
    .get(nodeType, nodeExternalId) as GraphNodeRow | undefined;

  if (!row) {
    // Unreachable in practice — INSERT OR IGNORE either inserts or finds an
    // existing row. Defensive fallback so we surface a real error instead of
    // crashing on undefined.
    return errorResult('Node upsert failed: row not found after INSERT OR IGNORE');
  }

  return successResult(
    JSON.stringify(
      {
        id: row.id,
        node_type: row.node_type,
        node_external_id: row.node_external_id,
        label: row.label,
        created,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// handleGraphNodeGet
// ---------------------------------------------------------------------------

/**
 * Look up a single graph_nodes row plus its in/out edge degrees.
 *
 * Required: node_type, node_external_id
 *
 * Returns: { id, node_type, node_external_id, label, properties, created_at,
 *           edge_count_in, edge_count_out }.
 *
 * Errors when the node does not exist (returns isError=true).
 *
 * Edge degrees are computed against entity_edges using (from_type, from_id)
 * for outgoing and (to_type, to_id) for incoming. Soft-deleted edges
 * (metadata.deleted=true) are excluded — same convention as igris_edge_list.
 */
export function handleGraphNodeGet(args: Record<string, unknown>): ToolResult {
  const nodeType = args.node_type as string | undefined;
  const nodeExternalId = args.node_external_id as string | undefined;

  if (!nodeType || !nodeExternalId) {
    return errorResult('Missing required fields: node_type, node_external_id');
  }

  const db = getDb();

  const row = db
    .prepare(
      `SELECT id, node_type, node_external_id, label, properties, created_at
       FROM graph_nodes
       WHERE node_type = ? AND node_external_id = ?`,
    )
    .get(nodeType, nodeExternalId) as GraphNodeRow | undefined;

  if (!row) {
    return errorResult(
      `Node not found: ${nodeType}/${nodeExternalId}`,
    );
  }

  // Edge-degree subqueries. Soft-deleted edges excluded for parity with
  // igris_edge_list defaults; an `include_deleted` toggle could be added
  // later if a use case emerges.
  const outDegreeRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM entity_edges
       WHERE from_type = ? AND from_id = ?
         AND COALESCE(json_extract(metadata, '$.deleted'), 0) = 0`,
    )
    .get(nodeType, nodeExternalId) as { n: number };

  const inDegreeRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM entity_edges
       WHERE to_type = ? AND to_id = ?
         AND COALESCE(json_extract(metadata, '$.deleted'), 0) = 0`,
    )
    .get(nodeType, nodeExternalId) as { n: number };

  return successResult(
    JSON.stringify(
      {
        id: row.id,
        node_type: row.node_type,
        node_external_id: row.node_external_id,
        label: row.label,
        properties: parsePropertiesSafe(row.properties),
        created_at: row.created_at,
        edge_count_in: inDegreeRow.n,
        edge_count_out: outDegreeRow.n,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// handleGraphSearch
// ---------------------------------------------------------------------------

/**
 * LIKE-based search against graph_nodes.label and graph_nodes.node_external_id.
 *
 * Required: query
 * Optional: node_type (exact-match filter), limit (default 20, capped at 100).
 *
 * Returns: { results: [{id, node_type, node_external_id, label, score}, ...] }.
 *
 * Score heuristic: `query.length / max(label.length, node_external_id.length)`
 * — a simple "fraction of the matched field that the query covers". A
 * full-string match scores 1.0; a prefix match scores < 1.0. This is a
 * deliberate v1 placeholder; a follow-up may swap in FTS5 ranking when
 * the node corpus grows large enough to justify the extra index. The
 * heuristic IS deterministic and ordered, so callers can tie-break on it.
 */
export function handleGraphSearch(args: Record<string, unknown>): ToolResult {
  const query = args.query as string | undefined;

  if (typeof query !== 'string' || query.length === 0) {
    return errorResult('Missing required field: query (must be a non-empty string)');
  }

  const nodeType = typeof args.node_type === 'string' && args.node_type.length > 0
    ? args.node_type
    : null;

  const rawLimit = args.limit !== undefined ? Number(args.limit) : 20;
  if (!Number.isFinite(rawLimit) || rawLimit < 1) {
    return errorResult('limit must be a positive integer');
  }
  const limit = Math.min(Math.floor(rawLimit), 100);

  // Escape LIKE wildcards in the user input so a query containing `%` or `_`
  // doesn't accidentally widen the match. We use `\` as the escape char and
  // declare it via `ESCAPE '\'` in the SQL.
  const escapedQuery = query
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  const likePattern = `%${escapedQuery}%`;

  const db = getDb();

  const sql = nodeType
    ? `SELECT id, node_type, node_external_id, label
       FROM graph_nodes
       WHERE node_type = ?
         AND (label LIKE ? ESCAPE '\\' OR node_external_id LIKE ? ESCAPE '\\')
       ORDER BY id ASC
       LIMIT ?`
    : `SELECT id, node_type, node_external_id, label
       FROM graph_nodes
       WHERE label LIKE ? ESCAPE '\\' OR node_external_id LIKE ? ESCAPE '\\'
       ORDER BY id ASC
       LIMIT ?`;

  const params: (string | number)[] = nodeType
    ? [nodeType, likePattern, likePattern, limit]
    : [likePattern, likePattern, limit];

  const rows = db.prepare(sql).all(...params) as Pick<
    GraphNodeRow,
    'id' | 'node_type' | 'node_external_id' | 'label'
  >[];

  const queryLen = query.length;
  const results = rows.map((r) => {
    const denom = Math.max(r.label.length, r.node_external_id.length, 1);
    const score = Math.min(1, queryLen / denom);
    return {
      id: r.id,
      node_type: r.node_type,
      node_external_id: r.node_external_id,
      label: r.label,
      score,
    };
  });

  // Sort by score desc, then id asc (stable on the SQL order).
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id - b.id;
  });

  return successResult(
    JSON.stringify(
      {
        query,
        node_type: nodeType,
        limit,
        count: results.length,
        results,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// handleGraphDashboard
// ---------------------------------------------------------------------------

/**
 * Aggregate dashboard over graph_nodes + entity_edges.
 *
 * Optional: project (filter on graph_nodes.properties.project), summary_only
 *           (omit `samples` block; default false), days (window for `recent.*`;
 *           default 30, must be non-negative).
 *
 * Returns the canonical TD-171 _dashboard shape established by M1's
 * handleMemoryDashboard:
 *
 *   {
 *     totals: {
 *       total_nodes: N,
 *       by_node_type: { brief: N, learning: N, ..., concept: N, decision: N },
 *       total_edges: N,
 *       by_edge_type: { parent_of: N, depends_on: N, ... },
 *       orphan_node_count: N,
 *     },
 *     recent: {
 *       last_n_days: 30,
 *       nodes_created: N,
 *       edges_created: N,
 *     },
 *     samples: {                               // omitted when summary_only=true
 *       top_god_nodes: [
 *         { id, node_type, node_external_id, label, total_degree }, ...
 *       ],
 *     },
 *     project?: 'foo',                         // echoed only when filter set
 *   }
 *
 * Project filter semantics: matches graph_nodes whose `properties.project`
 * JSON field equals the supplied slug. Uses sqlite json_extract — same
 * pattern as igris_edge_list's metadata.deleted check. Soft-deleted edges
 * are excluded throughout (parity with igris_edge_list). The `days` window
 * filters `recent.*` only — totals always count the full table, matching
 * M1's contract.
 */
export function handleGraphDashboard(args: Record<string, unknown>): ToolResult {
  const days = args.days !== undefined ? Number(args.days) : 30;
  if (!Number.isFinite(days) || days < 0) {
    return errorResult('days must be a non-negative number');
  }

  const summaryOnly = args.summary_only === true;
  const projectFilter = typeof args.project === 'string' && args.project.length > 0
    ? args.project
    : null;

  const db = getDb();

  // Project filter applies to graph_nodes.properties.project (a JSON field).
  // Built as a parameterised fragment for splicing into each node-side query.
  const nodeWhere = projectFilter
    ? `WHERE json_extract(properties, '$.project') = ?`
    : '';
  const nodeParams: string[] = projectFilter ? [projectFilter] : [];

  // --- totals.total_nodes ---
  const totalNodesRow = db
    .prepare(`SELECT COUNT(*) AS n FROM graph_nodes ${nodeWhere}`)
    .get(...nodeParams) as { n: number };

  // --- totals.by_node_type ---
  const byNodeTypeRows = db
    .prepare(
      `SELECT node_type, COUNT(*) AS n FROM graph_nodes ${nodeWhere} GROUP BY node_type`,
    )
    .all(...nodeParams) as { node_type: string; n: number }[];
  const byNodeType: Record<string, number> = {};
  for (const r of byNodeTypeRows) byNodeType[r.node_type] = r.n;

  // --- totals.total_edges + by_edge_type ---
  // Edge totals are NOT project-filtered: edges live on entity_edges with no
  // project column. A project-aware edge slice would require joining through
  // graph_nodes (or per-source-table project columns), which is out of scope
  // for v1 — flagged for a follow-up if the dashboard becomes a pre-refactor
  // gate. Soft-deleted edges are excluded for parity with igris_edge_list.
  const edgeFilter = `WHERE COALESCE(json_extract(metadata, '$.deleted'), 0) = 0`;

  const totalEdgesRow = db
    .prepare(`SELECT COUNT(*) AS n FROM entity_edges ${edgeFilter}`)
    .get() as { n: number };

  const byEdgeTypeRows = db
    .prepare(
      `SELECT edge_type, COUNT(*) AS n FROM entity_edges ${edgeFilter} GROUP BY edge_type`,
    )
    .all() as { edge_type: string; n: number }[];
  const byEdgeType: Record<string, number> = {};
  for (const r of byEdgeTypeRows) byEdgeType[r.edge_type] = r.n;

  // --- totals.orphan_node_count ---
  // A node is orphan when zero non-deleted edges reference it on either side.
  // Implemented via NOT EXISTS subqueries; LEFT JOIN + GROUP BY HAVING would
  // also work but reads less clearly with the project filter spliced in.
  const orphanSql = projectFilter
    ? `SELECT COUNT(*) AS n FROM graph_nodes gn
       WHERE json_extract(gn.properties, '$.project') = ?
         AND NOT EXISTS (
           SELECT 1 FROM entity_edges ee
           WHERE COALESCE(json_extract(ee.metadata, '$.deleted'), 0) = 0
             AND ((ee.from_type = gn.node_type AND ee.from_id = gn.node_external_id)
               OR (ee.to_type   = gn.node_type AND ee.to_id   = gn.node_external_id))
         )`
    : `SELECT COUNT(*) AS n FROM graph_nodes gn
       WHERE NOT EXISTS (
         SELECT 1 FROM entity_edges ee
         WHERE COALESCE(json_extract(ee.metadata, '$.deleted'), 0) = 0
           AND ((ee.from_type = gn.node_type AND ee.from_id = gn.node_external_id)
             OR (ee.to_type   = gn.node_type AND ee.to_id   = gn.node_external_id))
       )`;
  const orphanRow = db
    .prepare(orphanSql)
    .get(...nodeParams) as { n: number };

  // --- recent.nodes_created (last `days` window, project-filtered) ---
  const recentNodesSql = projectFilter
    ? `SELECT COUNT(*) AS n FROM graph_nodes
       WHERE json_extract(properties, '$.project') = ?
         AND created_at >= datetime('now', ?)`
    : `SELECT COUNT(*) AS n FROM graph_nodes
       WHERE created_at >= datetime('now', ?)`;
  const recentNodesParams: (string | number)[] = projectFilter
    ? [projectFilter, `-${days} days`]
    : [`-${days} days`];
  const recentNodesRow = db
    .prepare(recentNodesSql)
    .get(...recentNodesParams) as { n: number };

  // --- recent.edges_created (last `days` window, NOT project-filtered) ---
  // See note above on edge-side project filtering being out of scope.
  const recentEdgesRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM entity_edges
       WHERE COALESCE(json_extract(metadata, '$.deleted'), 0) = 0
         AND created_at >= datetime('now', ?)`,
    )
    .get(`-${days} days`) as { n: number };

  // --- samples.top_god_nodes (omitted when summary_only) ---
  // "God-nodes" = high total degree (in + out, excluding soft-deleted edges).
  // Project filter applies via graph_nodes.properties.project; we LEFT JOIN
  // to count edges. Limit to top 10.
  let samples: Record<string, unknown> | undefined;
  if (!summaryOnly) {
    const godSql = projectFilter
      ? `SELECT gn.id, gn.node_type, gn.node_external_id, gn.label,
                (
                  SELECT COUNT(*) FROM entity_edges ee
                  WHERE COALESCE(json_extract(ee.metadata, '$.deleted'), 0) = 0
                    AND ((ee.from_type = gn.node_type AND ee.from_id = gn.node_external_id)
                      OR (ee.to_type   = gn.node_type AND ee.to_id   = gn.node_external_id))
                ) AS total_degree
         FROM graph_nodes gn
         WHERE json_extract(gn.properties, '$.project') = ?
         ORDER BY total_degree DESC, gn.id ASC
         LIMIT 10`
      : `SELECT gn.id, gn.node_type, gn.node_external_id, gn.label,
                (
                  SELECT COUNT(*) FROM entity_edges ee
                  WHERE COALESCE(json_extract(ee.metadata, '$.deleted'), 0) = 0
                    AND ((ee.from_type = gn.node_type AND ee.from_id = gn.node_external_id)
                      OR (ee.to_type   = gn.node_type AND ee.to_id   = gn.node_external_id))
                ) AS total_degree
         FROM graph_nodes gn
         ORDER BY total_degree DESC, gn.id ASC
         LIMIT 10`;
    const godRows = db.prepare(godSql).all(...nodeParams) as {
      id: number;
      node_type: string;
      node_external_id: string;
      label: string;
      total_degree: number;
    }[];
    samples = { top_god_nodes: godRows };
  }

  const result: Record<string, unknown> = {
    totals: {
      total_nodes: totalNodesRow.n,
      by_node_type: byNodeType,
      total_edges: totalEdgesRow.n,
      by_edge_type: byEdgeType,
      orphan_node_count: orphanRow.n,
    },
    recent: {
      last_n_days: days,
      nodes_created: recentNodesRow.n,
      edges_created: recentEdgesRow.n,
    },
  };
  if (!summaryOnly) {
    result.samples = samples;
  }
  if (projectFilter) {
    result.project = projectFilter;
  }

  return successResult(JSON.stringify(result, null, 2));
}
