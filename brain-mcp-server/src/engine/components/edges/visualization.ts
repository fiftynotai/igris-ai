/**
 * Brain Engine v5.0 — Edges Component Graph Visualization (FR-111)
 *
 * Pure data-layer functions for assembling a project's brief graph payload
 * plus the HTML embedding helpers (template substitution + XSS-safe JSON).
 *
 * Used by:
 *   - scripts/render_brief_graph.ts (CLI for `tsx scripts/render_brief_graph.ts`)
 *   - igris_brief_graph_render MCP tool (visualization-tool.ts)
 *
 * Responsibilities:
 *   1. Fetch all briefs in a project (from brief_status).
 *   2. Fetch all entity_edges where BOTH endpoints are briefs in that project,
 *      OR a brief endpoint links to a goal via serves_goal.
 *   3. Apply the soft-delete WHERE clause matching `igris_edge_list` semantics
 *      (see handlers.ts for source of truth).
 *   4. Compute degree-centrality god-nodes (top-K by total degree).
 *   5. Cap embedded brief content to 8 KB to bound output HTML size.
 *   6. Inject the payload into the HTML template with XSS-safe JSON embedding.
 *
 * Why a separate module:
 *   - Data layer is unit-testable against :memory: SQLite without the HTML layer.
 *   - Future tools (community detection FR-112, etc.) can reuse the
 *     project-scoped graph fetch.
 *   - Lives inside `src/` so the compiled MCP handler can import it without
 *     reaching outside the dist tree (scripts/ is not built).
 *
 * @module engine/components/edges/visualization
 * @author Fifty.ai
 */

import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes of brief_files.content embedded per brief (prevents 50MB HTML on 1000-brief projects). */
export const MAX_CONTENT_BYTES = 8 * 1024;

/** Truncation suffix appended when content is capped. */
export const TRUNCATION_SUFFIX = '\n\n... (truncated — open the brief file for full content)';

/** Default number of god-nodes (top-K by degree) to surface. */
export const DEFAULT_GOD_NODES_K = 3;

/** SQLite parameter limit for IN-clauses (variable-number ceiling on most builds). */
const SQLITE_PARAM_LIMIT = 999;

// ---------------------------------------------------------------------------
// Row & payload shapes
// ---------------------------------------------------------------------------

/** Row from `brief_status` we care about for visualization. */
export interface BriefRow {
  brief_id: string;
  brief_type: string | null;
  title: string;
  status: string;
  priority: string | null;
  effort: string | null;
  phase: string | null;
  updated_at: string;
}

/** Row from `entity_edges` projected for visualization (no `id` needed downstream). */
export interface EdgeRow {
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

/** Row from `goals` projected for visualization. */
export interface GoalRow {
  goal_id: string;
  title: string;
  status: string;
  priority: string;
}

/** Output: row bundle returned by fetchProjectGraphRows. */
export interface ProjectGraphRows {
  briefs: BriefRow[];
  edges: EdgeRow[];
  goals: GoalRow[];
  briefContents: Map<string, string>;
}

/**
 * A node in the rendered graph payload.
 *
 * `id` is `${entity_type}|${entity_id}` to avoid collisions between
 * brief ids (FR-XXX) and goal ids (GL-XXX).
 */
export interface GraphNode {
  id: string;
  type: 'brief' | 'goal';
  brief_id: string;
  label: string;
  group: string;
  status: string;
  priority: string | null;
  effort: string | null;
  phase: string | null;
  updated_at: string | null;
  brief_type: string | null;
  degree: number;
  content: string | null;
}

/** An edge in the rendered graph payload (lighter than the DB row). */
export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  confidence: number;
  provenance: string;
}

/** The full rendered graph payload — JSON-serialized into the HTML. */
export interface GraphPayload {
  project: string;
  generated_at: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  god_nodes: string[];
  stats: {
    brief_count: number;
    edge_count: number;
    goal_count: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the underlying table exists. Used to gracefully skip the
 * goals query when FR-110 hasn't shipped on a particular brain instance.
 */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

/**
 * Truncate brief content to MAX_CONTENT_BYTES so a large project (1000s of
 * briefs) does not produce a 50MB HTML file. Operates on UTF-8 byte length
 * approximated via Buffer.byteLength.
 */
function capContent(content: string | null | undefined): string | null {
  if (typeof content !== 'string') return null;
  if (Buffer.byteLength(content, 'utf8') <= MAX_CONTENT_BYTES) return content;
  // Truncate at character boundary just under the byte cap, then append suffix.
  // Approximate: most repo content is ASCII so 1 byte = 1 char.
  let cut = MAX_CONTENT_BYTES;
  while (cut > 0 && Buffer.byteLength(content.slice(0, cut), 'utf8') > MAX_CONTENT_BYTES) {
    cut -= 64;
  }
  return content.slice(0, Math.max(0, cut)) + TRUNCATION_SUFFIX;
}

/**
 * Derive a node "group" key for color-mapping. Briefs use their id prefix
 * (the part before the first `-`), e.g. "FR-111" -> "FR". Goals are always
 * grouped as "goal" regardless of their id prefix.
 */
function deriveGroup(briefId: string, type: 'brief' | 'goal'): string {
  if (type === 'goal') return 'goal';
  const dash = briefId.indexOf('-');
  return dash > 0 ? briefId.slice(0, dash) : 'BR';
}

// ---------------------------------------------------------------------------
// fetchProjectGraphRows — talk to SQLite
// ---------------------------------------------------------------------------

/**
 * Fetch all rows needed to build the graph payload for `project`.
 *
 * - Reads `brief_status` (filtered by project).
 * - Builds a Set<brief_id>, then queries `entity_edges` for rows where
 *   BOTH endpoints are briefs in the set OR `serves_goal` edges from a
 *   project brief to any goal.
 * - Reads `goals` rows for the goal endpoints we found (best-effort —
 *   silently returns [] if the goals table is absent).
 * - Reads `brief_files.content` (capped at MAX_CONTENT_BYTES per brief)
 *   into a `Map<brief_id, content>` for click-detail rendering.
 *
 * Soft-deleted edges are filtered out via the same WHERE clause used by
 * `handleEdgeList` in handlers.ts.
 *
 * @param db - Database connection.
 * @param project - Project slug (matches brief_status.project).
 * @returns Bundle of briefs, edges, goals, and per-brief content map.
 */
export function fetchProjectGraphRows(
  db: Database.Database,
  project: string,
): ProjectGraphRows {
  // ---- briefs ----
  const briefs = db
    .prepare(
      `SELECT brief_id, brief_type, title, status, priority, effort, phase, updated_at
       FROM brief_status
       WHERE project = ?
       ORDER BY brief_id ASC`,
    )
    .all(project) as BriefRow[];

  if (briefs.length === 0) {
    return { briefs: [], edges: [], goals: [], briefContents: new Map() };
  }

  const briefIds = briefs.map((b) => b.brief_id);
  const briefSet = new Set(briefIds);

  // ---- edges ----
  // Soft-delete WHERE clause MUST match handlers.ts handleEdgeList semantics.
  // See COALESCE(json_extract(metadata,'$.deleted'), 0) = 0 in handlers.ts.
  let edgeRows: EdgeRow[];
  if (briefIds.length <= SQLITE_PARAM_LIMIT) {
    // Single SQL pass with IN-clause.
    const placeholders = briefIds.map(() => '?').join(',');
    edgeRows = db
      .prepare(
        `SELECT id, from_type, from_id, to_type, to_id, edge_type,
                confidence, provenance, metadata
         FROM entity_edges
         WHERE from_type = 'brief'
           AND to_type = 'brief'
           AND from_id IN (${placeholders})
           AND to_id IN (${placeholders})
           AND COALESCE(json_extract(metadata, '$.deleted'), 0) = 0
         ORDER BY id ASC`,
      )
      .all(...briefIds, ...briefIds) as EdgeRow[];
  } else {
    // Project has more briefs than the SQLite parameter limit. Fetch all
    // brief-brief edges and filter in TS — simpler than chunking the IN-clause
    // and the all-briefs payload caps at ~100KB regardless of project size.
    const allBriefEdges = db
      .prepare(
        `SELECT id, from_type, from_id, to_type, to_id, edge_type,
                confidence, provenance, metadata
         FROM entity_edges
         WHERE from_type = 'brief'
           AND to_type = 'brief'
           AND COALESCE(json_extract(metadata, '$.deleted'), 0) = 0
         ORDER BY id ASC`,
      )
      .all() as EdgeRow[];
    edgeRows = allBriefEdges.filter(
      (e) => briefSet.has(e.from_id) && briefSet.has(e.to_id),
    );
  }

  // ---- goal-serving edges ----
  // serves_goal edges: from_type='brief' (in project) -> to_type='goal'.
  let goalEdges: EdgeRow[] = [];
  if (briefIds.length <= SQLITE_PARAM_LIMIT) {
    const placeholders = briefIds.map(() => '?').join(',');
    goalEdges = db
      .prepare(
        `SELECT id, from_type, from_id, to_type, to_id, edge_type,
                confidence, provenance, metadata
         FROM entity_edges
         WHERE edge_type = 'serves_goal'
           AND from_type = 'brief'
           AND to_type = 'goal'
           AND from_id IN (${placeholders})
           AND COALESCE(json_extract(metadata, '$.deleted'), 0) = 0
         ORDER BY id ASC`,
      )
      .all(...briefIds) as EdgeRow[];
  } else {
    const all = db
      .prepare(
        `SELECT id, from_type, from_id, to_type, to_id, edge_type,
                confidence, provenance, metadata
         FROM entity_edges
         WHERE edge_type = 'serves_goal'
           AND from_type = 'brief'
           AND to_type = 'goal'
           AND COALESCE(json_extract(metadata, '$.deleted'), 0) = 0
         ORDER BY id ASC`,
      )
      .all() as EdgeRow[];
    goalEdges = all.filter((e) => briefSet.has(e.from_id));
  }

  const allEdges = [...edgeRows, ...goalEdges];

  // ---- goals ----
  // Best-effort: skip silently if FR-110 hasn't shipped (no goals table).
  let goals: GoalRow[] = [];
  if (goalEdges.length > 0 && tableExists(db, 'goals')) {
    const goalIds = [...new Set(goalEdges.map((e) => e.to_id))];
    // Single IN-clause, no chunked-fallback: SQLITE_PARAM_LIMIT is 999, and a
    // single project's brief graph carrying >999 distinct goals is implausible
    // (projects typically hold O(10s) of goals). If the cap is breached we
    // silently render zero goals — acceptable trade-off vs. the chunked-IN
    // pattern used for the brief table above. Mirror that pattern here if a
    // real project ever exceeds the limit.
    if (goalIds.length > 0 && goalIds.length <= SQLITE_PARAM_LIMIT) {
      const placeholders = goalIds.map(() => '?').join(',');
      goals = db
        .prepare(
          `SELECT goal_id, title, status, priority
           FROM goals
           WHERE goal_id IN (${placeholders})
           ORDER BY goal_id ASC`,
        )
        .all(...goalIds) as GoalRow[];
    }
  }

  // ---- brief content (for click-detail panel) ----
  // brief_files lives in legacy db.ts v6 schema. Filter by project for safety.
  const briefContents = new Map<string, string>();
  if (tableExists(db, 'brief_files')) {
    const rows = db
      .prepare(
        `SELECT brief_id, content
         FROM brief_files
         WHERE project = ?`,
      )
      .all(project) as Array<{ brief_id: string; content: string }>;
    for (const r of rows) {
      const capped = capContent(r.content);
      if (capped !== null) briefContents.set(r.brief_id, capped);
    }
  }

  return { briefs, edges: allEdges, goals, briefContents };
}

// ---------------------------------------------------------------------------
// assembleGraphPayload — compose the renderer-ready payload
// ---------------------------------------------------------------------------

/**
 * Compose a `GraphPayload` from raw rows.
 *
 * - Builds nodes for every brief plus every goal targeted by a serves_goal edge.
 * - Encodes node ids as `${type}|${id}` to avoid GL/FR id-prefix collisions.
 * - Computes per-node degree (in + out) in O(E).
 * - Selects top-K god nodes by degree (ties broken by id for stability).
 *
 * @param rows - Output of fetchProjectGraphRows.
 * @param project - Project slug embedded in the payload (and the HTML title).
 * @param generatedAt - ISO 8601 timestamp embedded in the payload.
 * @returns A self-contained GraphPayload ready for HTML embedding.
 */
export function assembleGraphPayload(
  rows: ProjectGraphRows,
  project: string,
  generatedAt: string,
): GraphPayload {
  const { briefs, edges, goals, briefContents } = rows;

  // Build brief nodes.
  const nodes: GraphNode[] = [];
  for (const b of briefs) {
    nodes.push({
      id: `brief|${b.brief_id}`,
      type: 'brief',
      brief_id: b.brief_id,
      label: b.title,
      group: deriveGroup(b.brief_id, 'brief'),
      status: b.status,
      priority: b.priority,
      effort: b.effort,
      phase: b.phase,
      updated_at: b.updated_at,
      brief_type: b.brief_type,
      degree: 0,
      content: briefContents.get(b.brief_id) ?? null,
    });
  }

  // Build goal nodes.
  for (const g of goals) {
    nodes.push({
      id: `goal|${g.goal_id}`,
      type: 'goal',
      brief_id: g.goal_id,
      label: g.title,
      group: 'goal',
      status: g.status,
      priority: g.priority,
      effort: null,
      phase: null,
      updated_at: null,
      brief_type: null,
      degree: 0,
      content: null,
    });
  }

  // Build edges + count per-endpoint degree.
  const nodeIndex = new Map<string, GraphNode>();
  for (const n of nodes) nodeIndex.set(n.id, n);

  const graphEdges: GraphEdge[] = [];
  for (const e of edges) {
    const fromKey = `${e.from_type}|${e.from_id}`;
    const toKey = `${e.to_type}|${e.to_id}`;
    // Skip edges referencing a node we didn't surface (defensive — should not
    // happen given the SQL filter, but keeps render output internally consistent).
    if (!nodeIndex.has(fromKey) || !nodeIndex.has(toKey)) continue;

    graphEdges.push({
      from: fromKey,
      to: toKey,
      type: e.edge_type,
      confidence: e.confidence,
      provenance: e.provenance,
    });

    // Degree: count both endpoints (self-loops contribute 2).
    const fromNode = nodeIndex.get(fromKey)!;
    const toNode = nodeIndex.get(toKey)!;
    fromNode.degree += 1;
    toNode.degree += 1;
  }

  // God-node detection.
  const godNodes = detectGodNodes({ nodes });

  return {
    project,
    generated_at: generatedAt,
    nodes,
    edges: graphEdges,
    god_nodes: godNodes,
    stats: {
      brief_count: briefs.length,
      edge_count: graphEdges.length,
      goal_count: goals.length,
    },
  };
}

// ---------------------------------------------------------------------------
// detectGodNodes — degree-centrality top-K
// ---------------------------------------------------------------------------

/**
 * Select the K nodes with the highest degree (in + out).
 *
 * Ties are broken by node id ascending so output is stable across renders.
 * Returns an empty array when the graph has fewer than 2 nodes (a single
 * node with degree 0 is not a "god node").
 *
 * @param payload - Graph payload (only `nodes` is read).
 * @param k - Number of top nodes to return (default DEFAULT_GOD_NODES_K).
 * @returns Array of node ids in descending degree order.
 */
export function detectGodNodes(
  payload: Pick<GraphPayload, 'nodes'>,
  k: number = DEFAULT_GOD_NODES_K,
): string[] {
  if (payload.nodes.length < 2) return [];
  const sorted = [...payload.nodes].sort((a, b) => {
    if (a.degree !== b.degree) return b.degree - a.degree;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  // Filter out degree-0 nodes — they're not "central" by any meaningful metric.
  const candidates = sorted.filter((n) => n.degree > 0);
  return candidates.slice(0, k).map((n) => n.id);
}

// ---------------------------------------------------------------------------
// HTML embedding (template substitution + XSS-safe JSON)
// ---------------------------------------------------------------------------

/** Marker tokens swapped at render time (literal strings, not regex). */
export const PAYLOAD_MARKER = '__PAYLOAD__';
export const GENERATED_AT_MARKER = '__GENERATED_AT__';
export const PROJECT_MARKER = '__PROJECT__';

/**
 * Stringify the payload and escape characters that would otherwise terminate
 * the embedding `<script>` tag or break legacy JS parsers.
 *
 * - `<` and `>` -> `<` / `>` so a brief title containing the literal
 *   substring `</script>` cannot escape the embedding tag.
 * - U+2028 and U+2029 -> ` ` / ` ` so pre-ES2019 parsers that treat
 *   them as line terminators do not reject the literal.
 *
 * `JSON.stringify` already escapes backslashes and quotes — those are untouched.
 */
export function safeEmbedJson(payload: GraphPayload): string {
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/[\u2028]/g, '\\u2028')
    .replace(/[\u2029]/g, '\\u2029');
}

/** HTML-attribute-escape a string (single-encode &, <, >, "). */
function htmlAttrEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inject a graph payload into the HTML template via literal marker swap.
 *
 * Uses `String#split + Array#join` (not regex) so accidental matches inside
 * the payload JSON or CSS cannot disrupt the swap.
 *
 * @param template - Raw HTML template containing __PAYLOAD__, __GENERATED_AT__, __PROJECT__ markers.
 * @param payload - Graph payload to embed.
 * @returns Self-contained HTML string ready to write to disk.
 */
export function renderHtml(template: string, payload: GraphPayload): string {
  const json = safeEmbedJson(payload);
  const safeProject = htmlAttrEscape(String(payload.project));
  const safeTimestamp = htmlAttrEscape(String(payload.generated_at));
  return template
    .split(PAYLOAD_MARKER)
    .join(json)
    .split(GENERATED_AT_MARKER)
    .join(safeTimestamp)
    .split(PROJECT_MARKER)
    .join(safeProject);
}
