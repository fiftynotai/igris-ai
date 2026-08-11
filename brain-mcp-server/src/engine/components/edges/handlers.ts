/**
 * Brain Engine v7.0 — Edges Component Handlers
 *
 * Handlers for the three typed-edge MCP tools:
 *   - igris_edge_create  — idempotent insert via UNIQUE constraint
 *   - igris_edge_list    — filtered query with pagination
 *   - igris_edge_remove  — soft delete via metadata.deleted flag
 *
 * Handlers are pure functions: they take Record<string, unknown> args,
 * validate at runtime, and return a ToolResult. They are also called
 * directly from the brief.created hook (see ./index.ts) so they cannot
 * assume the args came from the MCP gateway.
 *
 * @module engine/components/edges/handlers
 * @author fifty.dev
 */

import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult, WhereBuilder } from '../../helpers.js';
import { createProjectResolver, qualifyNodeProject } from './node-project.js';

// ---------------------------------------------------------------------------
// Validation catalogs (runtime defense, complementary to JSON Schema enums)
// ---------------------------------------------------------------------------

/**
 * Accepted entity types in from_type / to_type columns.
 *
 * TD-171 M2 (operator-locked Decision 2): extended with `concept` and
 * `decision` to support free-standing nodes registered via
 * igris_graph_node_create. The cascade affects every tool that lists
 * VALID_ENTITY_TYPES in its inputSchema.enum (igris_edge_create / list,
 * igris_graph_neighbors / path / subgraph) — all now accept the extended
 * types automatically because they reference this constant directly.
 * No standalone validator besides handleEdgeCreate / handleEdgeList
 * references this list, so no other validator update was required.
 */
export const VALID_ENTITY_TYPES = [
  'brief',
  'learning',
  'error',
  'session',
  'goal',
  'concept',
  'decision',
] as const;

/**
 * Accepted edge type vocabulary. Stored as plain strings — extensible later.
 *
 * ROW-100 LOCKSTEP (MAINTAINING.md): the `igris_memory_store` `edges[]` enum
 * (`memory/index.ts`) imports this constant directly, as do the traversal filters
 * (`traversal.ts`) and every edge tool's inputSchema (`edges/index.ts`). Adding a
 * literal here therefore flows into the store enum + traversal + tools with no
 * further edit — they stay in lockstep by reference, never a hand-copied list.
 *
 * FR-116 M4 (Decision #3a): `cluster_member_of` — a member node → its cluster
 * representative (the synthesized meta-learning). Written by the `cluster_meta`
 * apply-action via `handleEdgeCreate` when the cartographer's cluster summary is
 * applied; the community-detection primitive (`community.ts`) is a pure READ and
 * writes NO edges itself.
 */
export const VALID_EDGE_TYPES = [
  'parent_of',
  'depends_on',
  'blocks',
  'supersedes',
  'related_to',
  'serves_goal',
  'duplicates',
  'derived_from',
  'recurs_with',
  'cluster_member_of',
] as const;

/** Accepted provenance values. */
export const VALID_PROVENANCE = ['observed', 'backfill', 'inferred', 'user'] as const;

/** Edge types that may be self-referential (recurrence is a self-relation). */
const SELF_LOOP_ALLOWED = new Set<string>(['recurs_with']);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Clamp a numeric confidence value into [0, 1]. */
function clampConfidence(raw: unknown, fallback = 1.0): number {
  if (raw === undefined || raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/** Serialize a metadata object to JSON; tolerate already-stringified input. */
function normalizeMetadata(raw: unknown): string {
  if (raw === undefined || raw === null) return '{}';
  if (typeof raw === 'string') {
    // Allow callers to pre-stringify (e.g. backfill scripts) without double-escaping.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return raw;
    } catch {
      // Not JSON — fall through and wrap.
    }
    return JSON.stringify({ value: raw });
  }
  return JSON.stringify(raw);
}

/** Shape of a row in entity_edges as returned to callers. */
export interface EdgeRow {
  id: number;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  edge_type: string;
  confidence: number;
  provenance: string;
  created_at: string;
  metadata: string;
  /**
   * BR-083 — the project the SOURCE endpoint is read as. `null` is a real
   * value with a stated meaning: *deliberately unattributed*, never "unknown,
   * guess later". A row that predates BR-083 and could not be PROVEN keeps
   * `null` forever unless a brief widens the provable classes.
   */
  from_project: string | null;
  /** BR-083 — the project the TARGET endpoint is read as. See `from_project`. */
  to_project: string | null;
}

// ---------------------------------------------------------------------------
// handleEdgeCreate
// ---------------------------------------------------------------------------

/**
 * Create a typed edge between two entities.
 *
 * Required: from_type, from_id, to_type, to_id, edge_type
 * Optional: confidence (default 1.0), provenance (default 'observed'),
 *           metadata (default {}), from_project / to_project (BR-083)
 *
 * Idempotent: re-creating an identical edge returns the existing row's id
 * with `created: false`. The handler relies on the UNIQUE INDEX over
 * (from_type, from_id, COALESCE(from_project,''), to_type, to_id,
 * COALESCE(to_project,''), edge_type) for atomicity.
 *
 * Self-loops are rejected unless edge_type === 'recurs_with'.
 *
 * ===========================================================================
 * BR-083 — PROJECT QUALIFICATION IS ENFORCED HERE, AND THAT IS THE CHOKE
 * POINT, NOT AN EXCEPTION TO IT.
 * ===========================================================================
 *
 * `architecture_map` §Forbidden patterns bans *per-tool guards as a substitute
 * for the gateway*. This is the opposite of that pattern, on two independent
 * grounds, and it is written HERE so the next reader of that rule finds the
 * argument at the code rather than in a brief:
 *
 *  1. **The gateway cannot express the rule.** `gateway.ts` walks a STATIC
 *     `required` array with a presence test. BR-083's rule is *"a qualifier is
 *     required iff `|P(type, id)| > 1`"* — a LOOKUP into `brief_status`, whose
 *     answer depends on the VALUE of another argument and on the state of the
 *     database. JSON Schema has no conditional-required, and a blanket
 *     `required` entry would reject the legitimately project-less
 *     `concept -> concept` edge and every synapse `edge_inference` suggestion.
 *     A DDL `CHECK` cannot read another table either. There is no declarative
 *     door.
 *
 *  2. **The gateway sees a MINORITY of the callers.** `handleEdgeCreate` is
 *     the shared write path for `entity_edges` — measured, not assumed:
 *     `grep -rn 'handleEdgeCreate' src scripts | grep -v __tests__` finds ONE
 *     gateway-dispatched call site (`edges/index.ts`'s `igris_edge_create`
 *     registration) and NINE in-process callers that never touch
 *     `dispatch()` — `edges/index.ts` `onBriefCreated` + `onMemoryStored`,
 *     `subconscious/actions/kinds.ts` x4, `subconscious/handlers.ts` x2, and
 *     `cognition/extractors/synapse.ts`'s auto-approve path. (The BR-083 plan
 *     said EIGHT; it missed the synapse one.) `scripts/backfill_brief_edges.ts`
 *     is a tenth, out of process. A gateway-only rule would leave every one of
 *     them minting ambiguous edges silently — BR-080's silent-drop class, one
 *     layer down. Enforcing at the shared handler is the choke-point principle
 *     applied CORRECTLY: this function is the narrowest point every writer
 *     passes through.
 *
 * The gateway change is therefore additive only: the two keys join
 * `properties` so TD-128's extras walk stops rejecting them, and `required`
 * is NOT touched (MAINTAINING row 113 unchanged).
 *
 * The ladder itself is `node-project.ts::qualifyNodeProject` — the SAME
 * function BR-078's traversal seeds use, so an operator sees one dialect.
 */
export function handleEdgeCreate(args: Record<string, unknown>): ToolResult {
  const fromType = args.from_type as string | undefined;
  const fromId = args.from_id as string | undefined;
  const toType = args.to_type as string | undefined;
  const toId = args.to_id as string | undefined;
  const edgeType = args.edge_type as string | undefined;

  if (!fromType || !fromId || !toType || !toId || !edgeType) {
    return errorResult(
      'Missing required fields: from_type, from_id, to_type, to_id, edge_type',
    );
  }

  if (!(VALID_ENTITY_TYPES as readonly string[]).includes(fromType)) {
    return errorResult(
      `Invalid from_type: ${fromType}. Must be one of: ${VALID_ENTITY_TYPES.join(', ')}`,
    );
  }
  if (!(VALID_ENTITY_TYPES as readonly string[]).includes(toType)) {
    return errorResult(
      `Invalid to_type: ${toType}. Must be one of: ${VALID_ENTITY_TYPES.join(', ')}`,
    );
  }
  if (!(VALID_EDGE_TYPES as readonly string[]).includes(edgeType)) {
    return errorResult(
      `Invalid edge_type: ${edgeType}. Must be one of: ${VALID_EDGE_TYPES.join(', ')}`,
    );
  }

  // Reject self-loops except for recurrence relationships.
  if (fromType === toType && fromId === toId && !SELF_LOOP_ALLOWED.has(edgeType)) {
    return errorResult(
      `Self-loops are not allowed for edge_type "${edgeType}". Only recurs_with may be self-referential.`,
    );
  }

  const provenance = (args.provenance as string | undefined) ?? 'observed';
  if (!(VALID_PROVENANCE as readonly string[]).includes(provenance)) {
    return errorResult(
      `Invalid provenance: ${provenance}. Must be one of: ${VALID_PROVENANCE.join(', ')}`,
    );
  }

  const confidence = clampConfidence(args.confidence, 1.0);
  const metadata = normalizeMetadata(args.metadata);

  const db = getDb();

  // --- BR-083: the qualification ladder, per endpoint. ----------------------
  // Runs BEFORE the INSERT so an ambiguous endpoint is refused at the moment
  // of minting rather than becoming another row the backfill cannot attribute.
  const resolver = createProjectResolver(db);
  const fromQ = qualifyNodeProject(fromType, fromId, args.from_project, resolver, {
    paramName: 'from_project',
    idParam: 'from_id',
    noun: 'endpoint',
  });
  if (!fromQ.ok) return errorResult(fromQ.error);
  const toQ = qualifyNodeProject(toType, toId, args.to_project, resolver, {
    paramName: 'to_project',
    idParam: 'to_id',
    noun: 'endpoint',
  });
  if (!toQ.ok) return errorResult(toQ.error);
  const fromProject = fromQ.project;
  const toProject = toQ.project;

  // Atomic upsert: INSERT OR IGNORE on the UNIQUE INDEX then SELECT to find
  // the row. Both projects are part of the uniqueness tuple, so the follow-up
  // SELECT MUST match on them too — without that, two edges differing only by
  // project would read back each other's row and report the wrong id.
  // `IS` rather than `=` because the columns are nullable and `NULL = NULL` is
  // NULL, which would make the read-back miss every project-less edge.
  const insert = db
    .prepare(
      `INSERT OR IGNORE INTO entity_edges
         (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata,
          from_project, to_project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fromType, fromId, toType, toId, edgeType, confidence, provenance, metadata,
      fromProject, toProject,
    );

  const created = insert.changes === 1;

  const row = db
    .prepare(
      `SELECT * FROM entity_edges
       WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND edge_type = ?
         AND from_project IS ? AND to_project IS ?`,
    )
    .get(fromType, fromId, toType, toId, edgeType, fromProject, toProject) as
      | EdgeRow
      | undefined;

  if (!row) {
    // Should be unreachable — INSERT OR IGNORE either inserts or finds an
    // existing row. Defensive fallback to surface a real error rather than
    // crashing on undefined.
    return errorResult('Edge upsert failed: row not found after INSERT OR IGNORE');
  }

  return successResult(
    JSON.stringify(
      {
        id: row.id,
        created,
        edge: row,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// handleEdgeList
// ---------------------------------------------------------------------------

/**
 * List edges with optional filters.
 *
 * All filters optional and ANDed: from_type, from_id, to_type, to_id,
 * edge_type, provenance, min_confidence, include_deleted (default false).
 *
 * Default LIMIT is 200, max 1000. Soft-deleted edges (metadata.deleted=true)
 * are filtered out unless include_deleted is true.
 */
export function handleEdgeList(args: Record<string, unknown>): ToolResult {
  const db = getDb();

  // Validate enum filters defensively so list never silently returns nothing
  // due to a typo we could have caught here.
  if (args.from_type !== undefined && !(VALID_ENTITY_TYPES as readonly string[]).includes(args.from_type as string)) {
    return errorResult(
      `Invalid from_type filter: ${args.from_type as string}. Must be one of: ${VALID_ENTITY_TYPES.join(', ')}`,
    );
  }
  if (args.to_type !== undefined && !(VALID_ENTITY_TYPES as readonly string[]).includes(args.to_type as string)) {
    return errorResult(
      `Invalid to_type filter: ${args.to_type as string}. Must be one of: ${VALID_ENTITY_TYPES.join(', ')}`,
    );
  }
  if (args.edge_type !== undefined && !(VALID_EDGE_TYPES as readonly string[]).includes(args.edge_type as string)) {
    return errorResult(
      `Invalid edge_type filter: ${args.edge_type as string}. Must be one of: ${VALID_EDGE_TYPES.join(', ')}`,
    );
  }
  if (args.provenance !== undefined && !(VALID_PROVENANCE as readonly string[]).includes(args.provenance as string)) {
    return errorResult(
      `Invalid provenance filter: ${args.provenance as string}. Must be one of: ${VALID_PROVENANCE.join(', ')}`,
    );
  }

  const where = new WhereBuilder()
    .add('from_type = ?', args.from_type)
    .add('from_id = ?', args.from_id)
    .add('to_type = ?', args.to_type)
    .add('to_id = ?', args.to_id)
    .add('edge_type = ?', args.edge_type)
    .add('provenance = ?', args.provenance)
    // BR-083. These are EQUALITY filters, so they never match the deliberately
    // unattributed rows — asking for `from_project = 'igris-ai'` returns the
    // rows PROVEN to be igris-ai's, not "everything that might be". The NULL
    // residual is visible by omitting the filter and comparing totals.
    .add('from_project = ?', args.from_project)
    .add('to_project = ?', args.to_project);

  const minConfidence = args.min_confidence !== undefined ? Number(args.min_confidence) : undefined;
  if (minConfidence !== undefined) {
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      return errorResult('min_confidence must be a number in [0, 1]');
    }
    where.addAlways('confidence >= ?', minConfidence);
  }

  const includeDeleted = args.include_deleted === true;
  if (!includeDeleted) {
    // Filter out soft-deleted edges. We use json_extract for portability;
    // the metadata column is plain TEXT, not a JSON column-type, but
    // json_extract works on JSON-shaped strings.
    where.addAlways("COALESCE(json_extract(metadata, '$.deleted'), 0) = 0");
  }

  const rawLimit = args.limit !== undefined ? Number(args.limit) : 200;
  if (!Number.isFinite(rawLimit) || rawLimit < 1) {
    return errorResult('limit must be a positive integer');
  }
  const limit = Math.min(rawLimit, 1000);
  const rawOffset = args.offset !== undefined ? Number(args.offset) : 0;
  if (!Number.isFinite(rawOffset) || rawOffset < 0) {
    return errorResult('offset must be a non-negative integer');
  }
  const offset = rawOffset;

  const rows = db
    .prepare(
      `SELECT * FROM entity_edges ${where.toSQL()}
       ORDER BY id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...where.values(), limit, offset) as EdgeRow[];

  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM entity_edges ${where.toSQL()}`)
    .get(...where.values()) as { total: number };

  return successResult(
    JSON.stringify(
      {
        edges: rows,
        count: rows.length,
        total: countRow.total,
        limit,
        offset,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// handleEdgeRemove
// ---------------------------------------------------------------------------

/**
 * Soft-delete an edge by id.
 *
 * Required: id (integer)
 * Optional: hard (boolean, default false) — when true, performs a real
 *           DELETE so the row vanishes from the table. By default the
 *           edge is marked with metadata.deleted = true and excluded
 *           from list queries unless include_deleted is set.
 *
 * Returns: { id, removed: true, soft: boolean }. Returns removed=false
 * with isError=true when the edge does not exist.
 */
export function handleEdgeRemove(args: Record<string, unknown>): ToolResult {
  const idRaw = args.id;
  if (idRaw === undefined || idRaw === null) {
    return errorResult('Missing required field: id');
  }

  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 1) {
    return errorResult('id must be a positive integer');
  }

  const hard = args.hard === true;
  const db = getDb();

  const existing = db
    .prepare('SELECT * FROM entity_edges WHERE id = ?')
    .get(id) as EdgeRow | undefined;

  if (!existing) {
    return errorResult(`Edge not found: ${id}`);
  }

  if (hard) {
    db.prepare('DELETE FROM entity_edges WHERE id = ?').run(id);
    return successResult(
      JSON.stringify({ id, removed: true, soft: false, edge: existing }, null, 2),
    );
  }

  // Soft delete: merge { deleted: true, deleted_at } into metadata.
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(existing.metadata || '{}');
    if (parsed && typeof parsed === 'object') {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = {};
  }
  metadata.deleted = true;
  metadata.deleted_at = new Date().toISOString();

  db.prepare('UPDATE entity_edges SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(metadata), id);

  const updated = db
    .prepare('SELECT * FROM entity_edges WHERE id = ?')
    .get(id) as EdgeRow;

  return successResult(
    JSON.stringify({ id, removed: true, soft: true, edge: updated }, null, 2),
  );
}
