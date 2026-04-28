/**
 * Brain Engine v5.0 — Edges Component Handlers
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
 * @author Fifty.ai
 */

import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult, WhereBuilder } from '../../helpers.js';

// ---------------------------------------------------------------------------
// Validation catalogs (runtime defense, complementary to JSON Schema enums)
// ---------------------------------------------------------------------------

/** Accepted entity types in from_type / to_type columns. */
export const VALID_ENTITY_TYPES = [
  'brief',
  'learning',
  'error',
  'session',
  'goal',
] as const;

/** Accepted edge type vocabulary. Stored as plain strings — extensible later. */
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
}

// ---------------------------------------------------------------------------
// handleEdgeCreate
// ---------------------------------------------------------------------------

/**
 * Create a typed edge between two entities.
 *
 * Required: from_type, from_id, to_type, to_id, edge_type
 * Optional: confidence (default 1.0), provenance (default 'observed'),
 *           metadata (default {})
 *
 * Idempotent: re-creating an identical edge returns the existing row's id
 * with `created: false`. The handler relies on the UNIQUE constraint over
 * (from_type, from_id, to_type, to_id, edge_type) for atomicity.
 *
 * Self-loops are rejected unless edge_type === 'recurs_with'.
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

  // Atomic upsert: INSERT OR IGNORE on UNIQUE then SELECT to find the row.
  const insert = db
    .prepare(
      `INSERT OR IGNORE INTO entity_edges
         (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(fromType, fromId, toType, toId, edgeType, confidence, provenance, metadata);

  const created = insert.changes === 1;

  const row = db
    .prepare(
      `SELECT * FROM entity_edges
       WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND edge_type = ?`,
    )
    .get(fromType, fromId, toType, toId, edgeType) as EdgeRow | undefined;

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
    .add('provenance = ?', args.provenance);

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
