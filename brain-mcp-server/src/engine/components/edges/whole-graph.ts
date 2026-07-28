/**
 * Brain Engine v7.0 — Whole-brain graph data layer (FR-237)
 *
 * ONE pure builder that assembles a typed, composite-keyed graph over EVERY
 * project in the brain — briefs, learnings, goals, errors, concept/decision
 * nodes — plus the typed, direction-preserving edges between them. An optional
 * `project` filter is applied to the SAME assembled graph, never via a second
 * query: drill-down is a depth-1 edge-induced closure over the whole-brain
 * result, so there is exactly one code path.
 *
 * WHY THIS MODULE MUST NOT IMPORT `db.js`
 * ---------------------------------------
 * `buildBrainGraph` takes a `db` handle as a parameter. This copies the
 * `visualization.ts` (pure, takes `db`) / `visualization-tool.ts` (calls
 * `getDb()`) precedent so the FR-238 dashboard server can import this builder
 * with its OWN read-only handle and zero singleton side-effects. The MCP
 * wrapper lives in `whole-graph-tool.ts`; it is the only file here that calls
 * `getDb()`.
 *
 * (The `handlers.js` import below is the edge/entity VOCABULARY only —
 * `VALID_EDGE_TYPES` / `VALID_ENTITY_TYPES`, imported BY REFERENCE per the
 * MAINTAINING row-#104 lockstep rule, never hand-copied. `handlers.js`
 * transitively references `db.js` but `db.ts` has NO import-time side effect:
 * it opens no connection until `getDb()` is called, which this module never
 * does.)
 *
 * THE SCALE STRATEGY IS A STRUCTURAL CHOICE, NOT A MECHANISM
 * ----------------------------------------------------------
 * This layer returns NO body content — no `learnings.content`, no
 * `brief_files.content`, no `goals.description`. Labels and display attrs only.
 * The FR-111 ancestor embeds up to 8 KB of brief content per node, which at
 * whole-brain scale is ~13 MB — 17x the entire rest of the payload and the only
 * term that grows with CONTENT rather than COUNT. Removing it at the source is
 * why no pruning / level-of-detail / paging is needed here. A per-node detail
 * fetch is a separate existing tool's job (`igris_graph_node_get`,
 * `igris_brief_get`).
 *
 * See `docs/architecture/whole_brain_graph.md` for the key form, the
 * ambiguous-edge resolution rule, and the stated pruning threshold.
 *
 * @module engine/components/edges/whole-graph
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { VALID_EDGE_TYPES } from './handlers.js';
import { encodeNodeKey } from './graph-keys.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Entity types materialised as nodes unconditionally.
 *
 * `session` is deliberately absent — it is ADJACENCY-ONLY (see
 * `ADJACENCY_ONLY_TYPES`). Sessions are unbounded and carry no knowledge-graph
 * value in bulk, but must never be DROPPED from an edge.
 */
export const DEFAULT_NODE_TYPES = [
  'brief',
  'learning',
  'goal',
  'error',
  'concept',
  'decision',
] as const;

/**
 * Types that materialise as a node ONLY when they are an endpoint of a
 * surviving edge. Their rows are still read (targeted by referenced id) so the
 * project index — and therefore edge resolution — stays correct.
 */
export const ADJACENCY_ONLY_TYPES = ['session'] as const;

/** Default cap on how many intra-project instances one ambiguous edge may spawn. */
export const DEFAULT_MAX_EDGE_REPLICAS = 8;

/**
 * Scale tripwire: node ceiling before deterministic truncation.
 *
 * ALIGNED to the pruning threshold stated in
 * `docs/architecture/whole_brain_graph.md` §5 — the point at which the payload
 * crosses ~5 MB and browser force-layout stops holding an interactive frame
 * rate. A cap ABOVE the threshold would fire only after the payload had
 * already become unrenderable, which defeats the tripwire's whole purpose
 * (FR-238 must never receive a payload it cannot draw). Today's brain is ~16 %
 * of this.
 */
export const DEFAULT_MAX_NODES = 15_000;

/** Scale tripwire: edge ceiling before deterministic truncation. Same rationale. */
export const DEFAULT_MAX_EDGES = 20_000;

/** Cap on how many over-replicated source-edge ids are echoed in the report. */
const MAX_REPORTED_OVER_REPLICATED_IDS = 50;

/** SQLite parameter limit for IN-clauses (variable-number ceiling on most builds). */
const SQLITE_PARAM_LIMIT = 999;

/** Max characters of a free-text column used as a display label. */
const LABEL_CHARS = 120;

/**
 * Max characters of a serialised `graph_nodes.properties` bag carried in
 * `attrs`. The bag is free-form operator-supplied JSON and is otherwise the
 * ONE unbounded term left in the payload, which would contradict the module
 * header's scale argument. Over the cap we emit a placeholder instead.
 */
const MAX_PROPERTIES_CHARS = 2 * 1024;

// ---------------------------------------------------------------------------
// Public types — the contract FR-238 consumes
// ---------------------------------------------------------------------------

/** A node in the whole-brain graph. */
export interface BrainGraphNode {
  /** Serialised composite key — `encodeNodeKey({ type, project, id })`. */
  key: string;
  /** Entity type. */
  type: string;
  /** Stable external id, verbatim from the source table. */
  id: string;
  /** Owning project slug; `null` ONLY when the entity genuinely has no owner. */
  project: string | null;
  /** Human-readable display label. */
  label: string;
  /** Per-type display attributes. Never carries body content. */
  attrs: Record<string, unknown>;
  /** In + out degree over the RETURNED edge array (self-loops count 2). */
  degree: number;
  /** Present when pulled in by adjacency during a project-filtered call. */
  boundary?: true;
  /** Present when this endpoint has no backing row anywhere. */
  phantom?: true;
}

/** How one source edge row was resolved onto the project axis. */
export type EdgeResolution = 'unique' | 'replicated';

/** An edge in the whole-brain graph. `from`/`to` are composite node keys. */
export interface BrainGraphEdge {
  /** `"417"`, or `"417#igris-ai"` for one instance of a replicated edge. */
  id: string;
  /** `entity_edges.id` — always present, always the ORIGINAL row. */
  source_edge_id: number;
  /** Composite key of the source endpoint (`entity_edges.from_*`). */
  from: string;
  /** Composite key of the target endpoint (`entity_edges.to_*`). */
  to: string;
  /** `edge_type`, verbatim from the catalog. */
  type: string;
  /** Original confidence, divided by the replica count when `replicated`. */
  confidence: number;
  /** `entity_edges.provenance`, verbatim. */
  provenance: string;
  /** `'unique'` when the projection was unambiguous; `'replicated'` otherwise. */
  resolution: EdgeResolution;
}

/** The AC #4 report block — emitted unconditionally on every response. */
export interface EdgeResolutionReport {
  rule: 'intra_project_projection';
  max_edge_replicas: number;
  /** Non-soft-deleted `entity_edges` rows read. */
  source_edges: number;
  /** Source rows that projected onto exactly one instance. */
  unique: number;
  /** Ambiguous source rows that were replicated. */
  replicated_sources: number;
  /** Instances those replicated sources produced. */
  replicas_emitted: number;
  /** Source rows with an empty candidate intersection (emitted nothing). */
  dangling: number;
  /**
   * Source rows with exactly one ambiguous endpoint whose fixed side names a
   * project the ambiguous side does not live in (emitted nothing). DISTINCT
   * from `dangling`: no common project was ever required here — the fixed side
   * simply gives no honest way to choose an instance, and any choice would be
   * a fabricated cross-project bridge.
   */
  ambiguous_unresolved: number;
  /** Source rows over the replica cap (emitted nothing). */
  over_replicated: number;
  /** `entity_edges.id` of over-replicated rows, capped at 50. */
  over_replicated_edge_ids: number[];
  /** `|C|` -> source-row count. Sums to `source_edges`. */
  candidate_count_histogram: Record<string, number>;
  /** `"<from_type>-><to_type>"` -> SOURCE-row count. */
  by_endpoint_pair: Record<string, number>;
}

/** Aggregate counters over the RETURNED nodes/edges (post-filter, post-truncation). */
export interface BrainGraphStats {
  node_count: number;
  edge_count: number;
  /** Seeded from the ACTIVE node-type set so a supported-but-empty type shows an explicit 0. */
  by_node_type: Record<string, number>;
  /** Seeded from `VALID_EDGE_TYPES` so all ten catalog types appear, zeros included. */
  by_edge_type: Record<string, number>;
  /** Distinct non-null `node.project` values present. */
  project_count: number;
  /** Nodes carrying `boundary: true`. */
  boundary_node_count: number;
}

/** Degradation signals — a missing table contributes zero rows, never a throw. */
export interface BrainGraphDegraded {
  /** Tables absent from `sqlite_master` at build time. */
  missing_tables: string[];
  /** Edge endpoints synthesised because no backing row exists. */
  phantom_nodes: number;
  /** Set by the MCP wrapper when the build itself could not run. */
  reason: string | null;
}

/** The whole-brain graph payload. */
export interface BrainGraph {
  generated_at: string;
  /** Echoed when a project filter was applied; `null` for the whole brain. */
  project: string | null;
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
  stats: BrainGraphStats;
  edge_resolution: EdgeResolutionReport;
  truncated: boolean;
  truncation_reason: string | null;
  degraded: BrainGraphDegraded;
}

/** Options for `buildBrainGraph`. */
export interface BuildOpts {
  /** Drill into one project's subgraph (plus its depth-1 boundary nodes). */
  project?: string;
  /** Restrict the emitted node types. Intersected with the active type set. */
  node_types?: string[];
  /** `|C| >` this drops the edge and reports it. Default 8. */
  maxEdgeReplicas?: number;
  /** Scale tripwire node ceiling. Defaults to `DEFAULT_MAX_NODES`. */
  maxNodes?: number;
  /** Scale tripwire edge ceiling. Defaults to `DEFAULT_MAX_EDGES`. */
  maxEdges?: number;
  /** Injectable timestamp (determinism in tests). */
  generatedAt?: string;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

/** A raw `entity_edges` row, projected. */
interface RawEdgeRow {
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

/** A loaded node row, normalised across source tables. */
interface LoadedNode {
  type: string;
  id: string;
  project: string | null;
  label: string;
  attrs: Record<string, unknown>;
}

/** Per-source-edge resolution outcome. */
interface EdgeInstance {
  fromProject: string | null;
  toProject: string | null;
  /** Project slug used in the replica id suffix (null for a single instance). */
  replicaKey: string | null;
}

interface ResolvedEdge {
  instances: EdgeInstance[];
  resolution: 'unique' | 'replicated' | 'dangling' | 'over_replicated' | 'ambiguous_unresolved';
  candidateCount: number;
}

// ---------------------------------------------------------------------------
// Schema probes
// ---------------------------------------------------------------------------

/**
 * True when the table exists. Copied from `visualization.ts:148` — EVERY table
 * read in this module is guarded by it, which is the AC #8 mechanism: a missing
 * table contributes zero rows and appends its name to `degraded.missing_tables`.
 */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

/**
 * True when `table.column` exists. Used only for `learnings.review_status`,
 * which is a late ALTER (db.ts v15) — an older brain would throw on the
 * approved-only filter rather than degrade.
 */
function columnExists(db: Database.Database, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Node loaders
// ---------------------------------------------------------------------------

/** Coerce a possibly-null DB value into a non-empty display label. */
function labelOr(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

/** Parse a `graph_nodes.properties` JSON blob defensively. */
function parseProperties(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed property bag — treat as empty rather than failing the build.
  }
  return {};
}

/**
 * Bound the property bag carried into `attrs`.
 *
 * `graph_nodes.properties` is free-form operator input with no size limit, so
 * carrying it verbatim would re-introduce a payload term that grows with
 * CONTENT rather than COUNT — exactly what the module header says this layer
 * does not do. Bags at or under the cap pass through unchanged (today every
 * one is a few dozen bytes); an oversized bag is replaced by a marker that
 * preserves the keys and the `project` scope a consumer actually needs, and
 * points at the per-node tool for the rest.
 */
function capProperties(props: Record<string, unknown>): Record<string, unknown> {
  let serialised: string;
  try {
    serialised = JSON.stringify(props);
  } catch {
    // Circular or otherwise unserialisable — never let it reach the payload.
    return { _truncated: true, _reason: 'properties not serialisable' };
  }
  if (serialised.length <= MAX_PROPERTIES_CHARS) return props;
  return {
    _truncated: true,
    _reason: `properties ${serialised.length} chars exceeded cap ${MAX_PROPERTIES_CHARS}; fetch via igris_graph_node_get`,
    _keys: Object.keys(props),
    // Keep the one key this layer's own filtering semantics depend on.
    project: typeof props.project === 'string' ? props.project : null,
  };
}

/**
 * Bound a free-text column used as a display label.
 *
 * Applied to EVERY label source. `brief_status.title`, `learnings.title`,
 * `goals.title`, `graph_nodes.label` and `sessions.summary` are all free text
 * with no DB length constraint (a 217-char title was measured on the live
 * brain), so leaving any of them uncapped would leave a payload term that
 * grows with CONTENT rather than COUNT. `errors.message` is capped in SQL via
 * `substr(…, 1, LABEL_CHARS)` — same bound, applied earlier. A label longer
 * than this is not renderable in a force layout anyway.
 */
function capLabel(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.length > LABEL_CHARS ? value.slice(0, LABEL_CHARS) : value;
}

/**
 * Load every node row for the unconditional types.
 *
 * NOTE: no loader selects a body column. `learnings.content`,
 * `goals.description` and `brief_files.content` are deliberately absent — see
 * the module header's scale note. Adding one here re-introduces the only
 * superlinear term in the payload.
 */
function loadNodes(db: Database.Database, missingTables: string[]): LoadedNode[] {
  const out: LoadedNode[] = [];

  // ---- brief (brief_status) ----
  if (tableExists(db, 'brief_status')) {
    const rows = db
      .prepare(
        `SELECT project, brief_id, brief_type, title, status, priority, effort, phase, updated_at
         FROM brief_status
         ORDER BY project ASC, brief_id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      out.push({
        type: 'brief',
        id: String(r.brief_id),
        project: typeof r.project === 'string' && r.project !== '' ? r.project : null,
        label: labelOr(capLabel(r.title), String(r.brief_id)),
        attrs: {
          brief_type: r.brief_type ?? null,
          status: r.status ?? null,
          priority: r.priority ?? null,
          effort: r.effort ?? null,
          phase: r.phase ?? null,
          updated_at: r.updated_at ?? null,
        },
      });
    }
  } else {
    missingTables.push('brief_status');
  }

  // ---- learning (learnings) ----
  if (tableExists(db, 'learnings')) {
    // FR-116 soft-delete parity: `review_status='approved'` is the same gate
    // every recall/search/sync reader uses. Resurrecting merged / superseded /
    // pruned learnings into the operator's view would regress the whole
    // hygiene family. Guarded because the column is a late ALTER (db.ts v15).
    const hasReviewStatus = columnExists(db, 'learnings', 'review_status');
    const where = hasReviewStatus ? `WHERE review_status = 'approved'` : '';
    const rows = db
      .prepare(
        `SELECT id, project, title, category, scope, confidence, source_brief, updated_at
         FROM learnings
         ${where}
         ORDER BY id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      out.push({
        type: 'learning',
        id: String(r.id),
        // A scope='global' learning STILL has a real owning project (its
        // origin). We key it with that project and expose scope as a display
        // attr — nulling it would collapse every global learning into a
        // single unaddressable bucket. `project: null` is reserved for
        // entities whose COLUMN is null. Rationale + the measured population:
        // docs/architecture/whole_brain_graph.md §1 (counts drift hourly, so
        // no literal here).
        project: typeof r.project === 'string' && r.project !== '' ? r.project : null,
        label: labelOr(capLabel(r.title), `learning:${String(r.id)}`),
        attrs: {
          category: r.category ?? null,
          scope: r.scope ?? null,
          confidence: r.confidence ?? null,
          source_brief: r.source_brief ?? null,
          updated_at: r.updated_at ?? null,
        },
      });
    }
  } else {
    missingTables.push('learnings');
  }

  // ---- goal (goals) — project_slug is NULLABLE ----
  if (tableExists(db, 'goals')) {
    const rows = db
      .prepare(
        `SELECT goal_id, project_slug, title, status, priority, deadline, achieved_at
         FROM goals
         ORDER BY goal_id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      out.push({
        type: 'goal',
        id: String(r.goal_id),
        project:
          typeof r.project_slug === 'string' && r.project_slug !== '' ? r.project_slug : null,
        label: labelOr(capLabel(r.title), String(r.goal_id)),
        attrs: {
          status: r.status ?? null,
          priority: r.priority ?? null,
          deadline: r.deadline ?? null,
          achieved_at: r.achieved_at ?? null,
        },
      });
    }
  } else {
    missingTables.push('goals');
  }

  // ---- error (errors) ----
  if (tableExists(db, 'errors')) {
    const rows = db
      .prepare(
        `SELECT id, project, substr(message, 1, ${LABEL_CHARS}) AS label,
                occurrence_count, scope, resolved_at
         FROM errors
         ORDER BY id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      out.push({
        type: 'error',
        id: String(r.id),
        project: typeof r.project === 'string' && r.project !== '' ? r.project : null,
        label: labelOr(r.label, `error:${String(r.id)}`),
        attrs: {
          occurrence_count: r.occurrence_count ?? null,
          scope: r.scope ?? null,
          resolved_at: r.resolved_at ?? null,
        },
      });
    }
  } else {
    missingTables.push('errors');
  }

  // ---- concept / decision (graph_nodes) ----
  // Live population is 0 today. The TYPE is supported; no rows are fabricated.
  if (tableExists(db, 'graph_nodes')) {
    const rows = db
      .prepare(
        `SELECT node_type, node_external_id, label, properties
         FROM graph_nodes
         WHERE node_type IN ('concept', 'decision')
         ORDER BY node_type ASC, node_external_id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const props = parseProperties(r.properties);
      const proj = props.project;
      out.push({
        type: String(r.node_type),
        id: String(r.node_external_id),
        project: typeof proj === 'string' && proj !== '' ? proj : null,
        label: labelOr(capLabel(r.label), String(r.node_external_id)),
        attrs: { properties: capProperties(props) },
      });
    }
  } else {
    missingTables.push('graph_nodes');
  }

  return out;
}

/**
 * Load rows for ADJACENCY-ONLY types, restricted to ids actually referenced by
 * an edge. Keeps `sessions` out of the bulk payload while guaranteeing a
 * session endpoint is never mis-classified as a phantom (AC #6).
 */
function loadAdjacencyOnlyNodes(
  db: Database.Database,
  edges: RawEdgeRow[],
  missingTables: string[],
): LoadedNode[] {
  const referenced = new Set<string>();
  for (const e of edges) {
    if (e.from_type === 'session') referenced.add(e.from_id);
    if (e.to_type === 'session') referenced.add(e.to_id);
  }
  if (referenced.size === 0) return [];

  if (!tableExists(db, 'sessions')) {
    missingTables.push('sessions');
    return [];
  }

  const ids = [...referenced].sort();
  const out: LoadedNode[] = [];
  for (let i = 0; i < ids.length; i += SQLITE_PARAM_LIMIT) {
    const chunk = ids.slice(i, i + SQLITE_PARAM_LIMIT);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, project, summary, brief_id, phase, started_at, ended_at
         FROM sessions
         WHERE CAST(id AS TEXT) IN (${placeholders})
         ORDER BY id ASC`,
      )
      .all(...chunk) as Array<Record<string, unknown>>;
    for (const r of rows) {
      out.push({
        type: 'session',
        id: String(r.id),
        project: typeof r.project === 'string' && r.project !== '' ? r.project : null,
        label: labelOr(capLabel(r.summary), `session:${String(r.id)}`),
        attrs: {
          brief_id: r.brief_id ?? null,
          phase: r.phase ?? null,
          started_at: r.started_at ?? null,
          ended_at: r.ended_at ?? null,
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edge loading
// ---------------------------------------------------------------------------

/**
 * Load every non-soft-deleted edge row.
 *
 * The `COALESCE(json_extract(metadata,'$.deleted'), 0) = 0` clause is copied
 * verbatim from `handlers.ts` / `visualization.ts:243` — parity with
 * `igris_edge_list` semantics is a standing invariant across every edge reader.
 */
function loadEdges(db: Database.Database, missingTables: string[]): RawEdgeRow[] {
  if (!tableExists(db, 'entity_edges')) {
    missingTables.push('entity_edges');
    return [];
  }
  return db
    .prepare(
      `SELECT id, from_type, from_id, to_type, to_id, edge_type,
              confidence, provenance, metadata
       FROM entity_edges
       WHERE COALESCE(json_extract(metadata, '$.deleted'), 0) = 0
       ORDER BY id ASC`,
    )
    .all() as RawEdgeRow[];
}

// ---------------------------------------------------------------------------
// The project index + the resolution rule
// ---------------------------------------------------------------------------

/** `"<type>:<id>"` -> the projects in which that entity exists. */
export type ProjectIndex = Map<string, Array<string | null>>;

/** Index key. Entity types never contain `:`, so this is unambiguous. */
function indexKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * Build the project index from the ALREADY-LOADED node rows — no extra query.
 *
 * For every integer-PK or UNIQUE-id type the array has length <= 1 by
 * construction (`learnings.id`, `errors.id`, `sessions.id`, `goals.goal_id`
 * UNIQUE, `graph_nodes` UNIQUE(node_type, node_external_id)). Only `brief` can
 * exceed 1 — `brief_status` is UNIQUE on `(project, brief_id)`, so a brief id
 * is project-scoped and 341 ids live in more than one project.
 */
export function buildProjectIndex(nodes: LoadedNode[]): ProjectIndex {
  const index: ProjectIndex = new Map();
  for (const n of nodes) {
    const k = indexKey(n.type, n.id);
    const existing = index.get(k);
    if (existing) {
      if (!existing.includes(n.project)) existing.push(n.project);
    } else {
      index.set(k, [n.project]);
    }
  }
  // Deterministic replica ordering across runs: ascending by slug, nulls first.
  for (const arr of index.values()) {
    arr.sort((a, b) => {
      if (a === b) return 0;
      if (a === null) return -1;
      if (b === null) return 1;
      return a < b ? -1 : 1;
    });
  }
  return index;
}

/**
 * Resolve one edge row onto the project axis — the *intra-project projection
 * with declared multiplicity* rule.
 *
 * `entity_edges` has no project column and its `metadata` carries only
 * `{"source":"backfill","label":"**Parent Brief:**"}` — the project context is
 * genuinely lost at row level. With `P(x)` = the projects containing endpoint
 * `x`:
 *
 *  1. Both endpoints NON-ambiguous (`|P| <= 1`) -> ONE instance with each
 *     endpoint's own project. Cross-project instances are LEGITIMATE here (a
 *     learning in one project linked to another project's brief) and are never
 *     forced intra-project.
 *  2. Exactly one endpoint ambiguous, and the fixed endpoint's (non-null)
 *     project is a MEMBER of the ambiguous endpoint's set -> adopt it, ONE
 *     instance, `unique`. This owner-hint branch resolves the learning->brief
 *     and most brief->goal edges for free, because the fixed side carries a
 *     REAL column.
 *  3. Exactly one endpoint ambiguous and the hint does NOT apply -> emit
 *     NOTHING, `ambiguous_unresolved` (counted). See the guarantee below for
 *     why this branch cannot replicate.
 *  4. Both ambiguous -> `C = P(from) ∩ P(to)`; every instance is strictly
 *     intra-project. `|C| = 0` -> dangling (emit nothing). `|C| = 1` -> unique.
 *     `1 < |C| <= max` -> one instance per project in `C`. `|C| > max` ->
 *     over-replicated (emit nothing, report the id).
 *
 * THE GUARANTEE: replication NEVER invents a cross-project bridge.
 * ---------------------------------------------------------------
 * This holds UNCONDITIONALLY, by construction, and FR-238 / FR-239 may design
 * against it. Only branch 4 replicates, and it replicates over an
 * INTERSECTION, so every emitted instance has `fromProject === toProject`. The
 * worst error a replica can commit is asserting a relationship inside a
 * project where it does not hold — never a false bridge between two unrelated
 * projects, which is the error class that is visually dominant and
 * semantically catastrophic in a force layout.
 *
 * Branch 3 is EXCLUDED from replication precisely BECAUSE it cannot satisfy
 * that guarantee. It is reached only when `fixedProject ∉ ambiguousSet` (if it
 * were a member, branch 2 would have fired), so every instance it could emit
 * is `fixedProject <-> candidate` with `candidate !== fixedProject` — i.e.
 * EVERY replica would be a cross-project bridge, and at most one of them could
 * be real. An earlier revision of this module did replicate here and claimed
 * the guarantee anyway; that claim was false. The fixed endpoint's real column
 * says which project IT lives in — it asserts nothing about which project the
 * ambiguous endpoint's instance lives in, so there is no honest projection to
 * make. Emitting nothing and reporting the count is the only correct posture.
 *
 * Exclusion where we DO apply it (branches 3/5/6/7) is a real loss, and for
 * branch 4's intersectable mass it would be the larger and more BIASED one —
 * it falls hardest on the oldest, most-collided projects, so exactly the
 * history the operator built this to see would render nearly edgeless. That is
 * why branch 4 replicates and branch 3 does not: branch 4 can project
 * honestly, branch 3 cannot. Every replica carries `source_edge_id`, so a
 * strict consumer recovers a fully-exclusive policy with
 * `edges.filter(e => e.resolution === 'unique')`.
 */
export function resolveEdgeProjects(
  edge: Pick<RawEdgeRow, 'from_type' | 'from_id' | 'to_type' | 'to_id'>,
  index: ProjectIndex,
  maxEdgeReplicas: number,
): ResolvedEdge {
  const fromSet = index.get(indexKey(edge.from_type, edge.from_id)) ?? [];
  const toSet = index.get(indexKey(edge.to_type, edge.to_id)) ?? [];

  // A phantom endpoint (no backing row) has an empty set — treat it as fixed
  // to `null` so the edge is never dropped for it.
  const fromAmbiguous = fromSet.length > 1;
  const toAmbiguous = toSet.length > 1;
  const fromFixed = fromSet.length === 1 ? fromSet[0] : null;
  const toFixed = toSet.length === 1 ? toSet[0] : null;

  // --- Branch 1: neither endpoint is ambiguous. -----------------------------
  if (!fromAmbiguous && !toAmbiguous) {
    return {
      instances: [{ fromProject: fromFixed, toProject: toFixed, replicaKey: null }],
      resolution: 'unique',
      candidateCount: 1,
    };
  }

  // --- Branch 2/3: exactly one endpoint is ambiguous. -----------------------
  if (fromAmbiguous !== toAmbiguous) {
    const ambiguousSet = fromAmbiguous ? fromSet : toSet;
    const fixedProject = fromAmbiguous ? toFixed : fromFixed;

    // Branch 2 — owner hint: the fixed side names a project the ambiguous side
    // actually lives in. Adopt it on both sides.
    if (fixedProject !== null && ambiguousSet.includes(fixedProject)) {
      return {
        instances: [
          { fromProject: fixedProject, toProject: fixedProject, replicaKey: null },
        ],
        resolution: 'unique',
        candidateCount: 1,
      };
    }

    // Branch 3 — hint does not apply. Emit NOTHING.
    //
    // Reached only when `fixedProject ∉ ambiguousSet`, so every instance we
    // could emit would pair `fixedProject` with a DIFFERENT project — a
    // fabricated cross-project bridge, at most one of which could be real.
    // Replicating here would break the guarantee documented above, so this
    // branch is reported rather than projected. `ambiguous_unresolved` is a
    // DISTINCT bucket from `dangling`: dangling means "no common project
    // exists", this means "a common project was never required and the fixed
    // side gives us no way to choose".
    return {
      instances: [],
      resolution: 'ambiguous_unresolved',
      candidateCount: ambiguousSet.length,
    };
  }

  // --- Branch 4: both ambiguous — intersect. --------------------------------
  // The ONLY replicating branch. It replicates over an INTERSECTION, which is
  // what makes every emitted instance strictly intra-project and the
  // no-fabricated-bridge guarantee unconditional.
  const toLookup = new Set(toSet);
  const intersection = fromSet.filter((p) => toLookup.has(p));
  return finaliseIntraProjectCandidates(intersection, maxEdgeReplicas);
}

/**
 * Apply the |C| = 0 / 1 / <=max / >max ladder to an INTERSECTION of candidate
 * projects, emitting one strictly intra-project instance per candidate.
 *
 * Every instance sets `fromProject === toProject === candidate`. This function
 * is structurally incapable of producing a cross-project edge — that is the
 * mechanism behind the guarantee in `resolveEdgeProjects`, so keep the
 * `fromProject`/`toProject` pair identical if this is ever extended.
 */
function finaliseIntraProjectCandidates(
  candidates: Array<string | null>,
  maxEdgeReplicas: number,
): ResolvedEdge {
  const n = candidates.length;
  if (n === 0) {
    return { instances: [], resolution: 'dangling', candidateCount: 0 };
  }
  if (n === 1) {
    return {
      instances: [
        { fromProject: candidates[0], toProject: candidates[0], replicaKey: null },
      ],
      resolution: 'unique',
      candidateCount: 1,
    };
  }
  if (n > maxEdgeReplicas) {
    return { instances: [], resolution: 'over_replicated', candidateCount: n };
  }
  return {
    instances: candidates.map((c) => ({
      fromProject: c,
      toProject: c,
      replicaKey: c,
    })),
    resolution: 'replicated',
    candidateCount: n,
  };
}

// ---------------------------------------------------------------------------
// Assembly helpers
// ---------------------------------------------------------------------------

/** Recompute `degree` for every node from the CURRENT edge array (O(V+E)). */
function computeDegrees(nodes: BrainGraphNode[], edges: BrainGraphEdge[]): void {
  const byKey = new Map<string, BrainGraphNode>();
  for (const n of nodes) {
    n.degree = 0;
    byKey.set(n.key, n);
  }
  for (const e of edges) {
    // Self-loops (`recurs_with`) legitimately contribute 2, matching
    // `assembleGraphPayload`.
    const from = byKey.get(e.from);
    if (from) from.degree += 1;
    const to = byKey.get(e.to);
    if (to) to.degree += 1;
  }
}

/**
 * The node types a call emits: the active set, intersected with `node_types`
 * when supplied. SHARED by `buildBrainGraph` and `emptyBrainGraph` so the
 * `stats.by_node_type` key set cannot drift between the populated and the
 * degraded response (they are the same contract).
 */
export function emittedNodeTypes(requested?: string[]): string[] {
  const active: string[] = [...DEFAULT_NODE_TYPES, ...ADJACENCY_ONLY_TYPES];
  if (!requested || requested.length === 0) return active;
  const want = new Set(requested);
  return active.filter((t) => want.has(t));
}

/** Empty per-type counter seeded so supported-but-empty types show `0`. */
function seededCounter(keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = 0;
  return out;
}

// ---------------------------------------------------------------------------
// buildBrainGraph — the ONE implementation
// ---------------------------------------------------------------------------

/**
 * Assemble the whole-brain graph, optionally drilled into one project.
 *
 * The project filter is applied to the ASSEMBLED graph, not to the SQL — this
 * is the literal reading of "same call, same shape, no divergent code path",
 * and at ~2 600 nodes it is free. At the ~15 000-node threshold documented in
 * `docs/architecture/whole_brain_graph.md` this is the FIRST thing that must
 * change (push the filter into the WHERE clauses).
 *
 * Never throws for a degraded brain: a missing table contributes zero rows and
 * is listed in `degraded.missing_tables`.
 *
 * @param db - Any better-sqlite3-shaped handle. This module opens none.
 * @param opts - Filters and caps; see `BuildOpts`.
 */
export function buildBrainGraph(db: Database.Database, opts: BuildOpts = {}): BrainGraph {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const maxEdgeReplicas = opts.maxEdgeReplicas ?? DEFAULT_MAX_EDGE_REPLICAS;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const maxEdges = opts.maxEdges ?? DEFAULT_MAX_EDGES;
  const projectFilter = opts.project ?? null;

  const missingTables: string[] = [];

  // ---- 1. Read. Node rows first, then the edges they will be joined against.
  const loaded = loadNodes(db, missingTables);
  const rawEdges = loadEdges(db, missingTables);
  loaded.push(...loadAdjacencyOnlyNodes(db, rawEdges, missingTables));

  // ---- 2. Project index (no extra query — built from the rows above).
  const index = buildProjectIndex(loaded);

  // ---- 3. Materialise the unconditional node set.
  const nodeMap = new Map<string, BrainGraphNode>();
  const adjacencyOnly = new Set<string>(ADJACENCY_ONLY_TYPES);
  const adjacencyCandidates = new Map<string, BrainGraphNode>();

  for (const n of loaded) {
    const key = encodeNodeKey({ type: n.type, project: n.project, id: n.id });
    const node: BrainGraphNode = {
      key,
      type: n.type,
      id: n.id,
      project: n.project,
      label: n.label,
      attrs: n.attrs,
      degree: 0,
    };
    if (adjacencyOnly.has(n.type)) {
      adjacencyCandidates.set(key, node);
    } else if (!nodeMap.has(key)) {
      nodeMap.set(key, node);
    }
  }

  // ---- 4. Resolve every edge, emitting one instance per surviving projection.
  const report: EdgeResolutionReport = {
    rule: 'intra_project_projection',
    max_edge_replicas: maxEdgeReplicas,
    source_edges: rawEdges.length,
    unique: 0,
    replicated_sources: 0,
    replicas_emitted: 0,
    dangling: 0,
    ambiguous_unresolved: 0,
    over_replicated: 0,
    over_replicated_edge_ids: [],
    candidate_count_histogram: {},
    by_endpoint_pair: {},
  };

  let phantomCount = 0;
  const graphEdges: BrainGraphEdge[] = [];

  /** Fetch or synthesise the node for one resolved endpoint. */
  const materialise = (
    type: string,
    id: string,
    project: string | null,
  ): BrainGraphNode => {
    const key = encodeNodeKey({ type, project, id });
    const existing = nodeMap.get(key);
    if (existing) return existing;

    const adjacency = adjacencyCandidates.get(key);
    if (adjacency) {
      nodeMap.set(key, adjacency);
      return adjacency;
    }

    // Phantom: an edge endpoint with no backing row anywhere (a post-TD-310
    // orphan). The registry join is NEVER assumed to succeed.
    const phantom: BrainGraphNode = {
      key,
      type,
      id,
      project,
      label: id,
      attrs: {},
      degree: 0,
      phantom: true,
    };
    nodeMap.set(key, phantom);
    phantomCount += 1;
    return phantom;
  };

  for (const e of rawEdges) {
    const pair = `${e.from_type}->${e.to_type}`;
    report.by_endpoint_pair[pair] = (report.by_endpoint_pair[pair] ?? 0) + 1;

    const resolved = resolveEdgeProjects(e, index, maxEdgeReplicas);
    const bucket = String(resolved.candidateCount);
    report.candidate_count_histogram[bucket] =
      (report.candidate_count_histogram[bucket] ?? 0) + 1;

    if (resolved.resolution === 'dangling') {
      report.dangling += 1;
      continue;
    }
    if (resolved.resolution === 'ambiguous_unresolved') {
      report.ambiguous_unresolved += 1;
      continue;
    }
    if (resolved.resolution === 'over_replicated') {
      report.over_replicated += 1;
      if (report.over_replicated_edge_ids.length < MAX_REPORTED_OVER_REPLICATED_IDS) {
        report.over_replicated_edge_ids.push(e.id);
      }
      continue;
    }
    if (resolved.resolution === 'replicated') {
      report.replicated_sources += 1;
      report.replicas_emitted += resolved.instances.length;
    } else {
      report.unique += 1;
    }

    const divisor = resolved.resolution === 'replicated' ? resolved.instances.length : 1;
    for (const inst of resolved.instances) {
      const fromNode = materialise(e.from_type, e.from_id, inst.fromProject);
      const toNode = materialise(e.to_type, e.to_id, inst.toProject);
      graphEdges.push({
        id: inst.replicaKey === null ? String(e.id) : `${e.id}#${inst.replicaKey}`,
        source_edge_id: e.id,
        // from/to preserve entity_edges.from_*/to_* IN THAT ORDER — never
        // normalised or coalesced. A bidirectional relationship is two rows
        // and stays two edges (AC #5).
        from: fromNode.key,
        to: toNode.key,
        type: e.edge_type,
        confidence: e.confidence / divisor,
        provenance: e.provenance,
        resolution: resolved.resolution,
      });
    }
  }

  // ---- 5. Node-type filter (post-assembly so the project index — and thus
  //         edge resolution — is always built from the COMPLETE row set).
  let nodes = [...nodeMap.values()];
  let edges = graphEdges;

  const emittedTypes = emittedNodeTypes(opts.node_types);
  if (opts.node_types && opts.node_types.length > 0) {
    const allowed = new Set(emittedTypes);
    const keptKeys = new Set<string>();
    nodes = nodes.filter((n) => {
      if (!allowed.has(n.type)) return false;
      keptKeys.add(n.key);
      return true;
    });
    edges = edges.filter((e) => keptKeys.has(e.from) && keptKeys.has(e.to));
  }

  // ---- 6. Project filter — depth-1 edge-induced closure over the SAME graph.
  if (projectFilter !== null) {
    const owned = new Set<string>();
    const kept = new Set<string>();
    for (const n of nodes) {
      if (n.project === projectFilter) {
        owned.add(n.key);
        kept.add(n.key);
      } else if (n.project === null) {
        // Global anchor (e.g. a project-less goal) — kept unconditionally so a
        // global entity is never dropped, but it does NOT pull in neighbours.
        kept.add(n.key);
      }
    }
    const boundary = new Set<string>();
    for (const e of edges) {
      if (owned.has(e.from) && !kept.has(e.to)) {
        kept.add(e.to);
        boundary.add(e.to);
      }
      if (owned.has(e.to) && !kept.has(e.from)) {
        kept.add(e.from);
        boundary.add(e.from);
      }
    }
    nodes = nodes.filter((n) => kept.has(n.key));
    for (const n of nodes) {
      if (boundary.has(n.key)) n.boundary = true;
    }
    edges = edges.filter((e) => kept.has(e.from) && kept.has(e.to));
  }

  // ---- 7. Scale tripwire. Deterministic, ~20 lines, silent on today's brain.
  computeDegrees(nodes, edges);
  let truncated = false;
  let truncationReason: string | null = null;

  if (nodes.length > maxNodes) {
    const before = nodes.length;
    nodes = [...nodes]
      .sort((a, b) => (b.degree - a.degree) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, maxNodes);
    const survivors = new Set(nodes.map((n) => n.key));
    edges = edges.filter((e) => survivors.has(e.from) && survivors.has(e.to));
    truncated = true;
    truncationReason = `node_count ${before} exceeded max_nodes ${maxNodes}`;
  }
  if (edges.length > maxEdges) {
    const before = edges.length;
    edges = edges.slice(0, maxEdges);
    truncated = true;
    truncationReason = truncationReason
      ? `${truncationReason}; edge_count ${before} exceeded max_edges ${maxEdges}`
      : `edge_count ${before} exceeded max_edges ${maxEdges}`;
  }
  if (truncated) computeDegrees(nodes, edges);

  // ---- 8. Stats.
  const byNodeType = seededCounter(emittedTypes);
  const projects = new Set<string>();
  let boundaryCount = 0;
  for (const n of nodes) {
    byNodeType[n.type] = (byNodeType[n.type] ?? 0) + 1;
    if (n.project !== null) projects.add(n.project);
    if (n.boundary) boundaryCount += 1;
  }
  // Seeded from VALID_EDGE_TYPES BY REFERENCE so all ten catalog types appear
  // with an explicit 0 — `duplicates` and `recurs_with` have zero live rows
  // today and must not vanish from the contract (AC #5).
  const byEdgeType = seededCounter(VALID_EDGE_TYPES);
  for (const e of edges) {
    byEdgeType[e.type] = (byEdgeType[e.type] ?? 0) + 1;
  }

  return {
    generated_at: generatedAt,
    project: projectFilter,
    nodes,
    edges,
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      by_node_type: byNodeType,
      by_edge_type: byEdgeType,
      project_count: projects.size,
      boundary_node_count: boundaryCount,
    },
    edge_resolution: report,
    truncated,
    truncation_reason: truncationReason,
    degraded: {
      missing_tables: missingTables,
      phantom_nodes: phantomCount,
      reason: null,
    },
  };
}

/** An empty graph with the identical top-level shape — the AC #8 fallback. */
export function emptyBrainGraph(
  reason: string | null = null,
  opts: BuildOpts = {},
): BrainGraph {
  return {
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    project: opts.project ?? null,
    nodes: [],
    edges: [],
    stats: {
      node_count: 0,
      edge_count: 0,
      by_node_type: seededCounter(emittedNodeTypes(opts.node_types)),
      by_edge_type: seededCounter(VALID_EDGE_TYPES),
      project_count: 0,
      boundary_node_count: 0,
    },
    edge_resolution: {
      rule: 'intra_project_projection',
      max_edge_replicas: opts.maxEdgeReplicas ?? DEFAULT_MAX_EDGE_REPLICAS,
      source_edges: 0,
      unique: 0,
      replicated_sources: 0,
      replicas_emitted: 0,
      dangling: 0,
      ambiguous_unresolved: 0,
      over_replicated: 0,
      over_replicated_edge_ids: [],
      candidate_count_histogram: {},
      by_endpoint_pair: {},
    },
    truncated: false,
    truncation_reason: null,
    degraded: { missing_tables: [], phantom_nodes: 0, reason },
  };
}
