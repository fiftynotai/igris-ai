/**
 * Brain Engine v7.1 — Janitor edge-type EMERGENCE sweep (FR-116 M5, op #6).
 *
 * The FIFTH and FINAL FR-116 memory-hygiene duty — and the ONLY one that touches
 * the edge-type VOCABULARY. It is a DETERMINISTIC statistical pass (a (G) sweep,
 * NOT a cognition instance — the counting needs NO LLM), sibling to the three
 * `hygiene.ts` duties. The janitor RUNNER calls it around `runExtractor`; it is a
 * pure, READ-ONLY function over `entity_edges`:
 *
 *   `surfaceEdgeTypeProposals(db, opts)` — count RECURRING metadata *signatures*
 *   on `provenance='inferred'` edges. Inference paths stamp a semantic-relation
 *   label into an edge's metadata (`metadata.detector` / `metadata.signature` /
 *   `metadata.relation` / `metadata.rel`) while STORING the edge under a generic
 *   `edge_type` (e.g. `related_to`). When a distinct signature that does NOT
 *   already name a canonical edge type recurs ≥ `min_count` times, it is a
 *   candidate for a NEW canonical edge type — so the sweep surfaces ONE
 *   `propose_edge_type` suggestion (`source_module='janitor'`) per clearing
 *   signature.
 *
 * PROPOSAL-ONLY (Decision #3b — operator-approved). This sweep NEVER mutates
 * `VALID_EDGE_TYPES` (it is a `readonly` array; runtime mutation is out of scope)
 * and NEVER writes/edits an `entity_edges` row. It only READS + surfaces a
 * review suggestion. The vocabulary grows ONLY by a HUMAN code edit to
 * `VALID_EDGE_TYPES` in `edges/handlers.ts` (out of M5 scope). The dynamic
 * runtime edge-type registry (option b) is DEFERRED.
 *
 * DELIBERATE FIELD CHOICE (why not `metadata.source`): `metadata.source` is the
 * WRITER / provenance of an inferred edge (`'merge_learnings'`, `'cluster_meta'`,
 * `'igris_suggestion_apply_action'`, …) — NOT a relationship label. Counting it
 * would falsely propose `merge_learnings` etc. as edge types. So the signature is
 * read from a PURPOSE-BUILT relation-label field chain (`detector` → `signature`
 * → `relation` → `rel`), and `source` is explicitly EXCLUDED. A signature that
 * already matches an existing `VALID_EDGE_TYPES` literal is skipped (already
 * canonical).
 *
 * Fail-soft: any query/parse error returns 0 (the deterministic sweep never
 * aborts a janitor run). Never throws.
 *
 * @module engine/components/janitor/emergence
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { VALID_EDGE_TYPES } from '../edges/handlers.js';

/** Pending-suggestion TTL (days) — mirrors the other janitor surfacings. */
const PENDING_TTL_DAYS = 30;

/**
 * The metadata field chain the signature is read from (first non-empty wins).
 * DELIBERATELY excludes `source` (the writer/provenance, not a relation label).
 */
const SIGNATURE_FIELDS = ['detector', 'signature', 'relation', 'rel'] as const;

// ---------------------------------------------------------------------------
// Config (nested-only, gated by cognition.janitor.enabled + emergence sub-toggle)
// ---------------------------------------------------------------------------

/**
 * The edge-type emergence sweep config (FR-116 M5). Like the cartographer's
 * `cluster` sub-block, `enabled` is a DOUBLE gate: `cognition.janitor.enabled`
 * AND the `cognition.janitor.emergence.enabled` sub-toggle (DEFAULT OFF) — the
 * extra gate because this is the highest-blast op (it surfaces edge-vocabulary
 * proposals). Its tuning lives in the additive `cognition.janitor.emergence.*`
 * sub-block.
 */
export interface EmergenceConfig {
  /** Master switch — `cognition.janitor.enabled` AND the `emergence.enabled` sub-toggle (default OFF). */
  enabled: boolean;
  /**
   * `emergence_min_count` — a distinct novel signature must recur at least this
   * many times across `provenance='inferred'` edges to be proposed. Default 50
   * (the brief's threshold). Statistical floor — the counting is deterministic.
   */
  min_count: number;
  /** Hard cap on proposals surfaced per run (bounds the review queue). Default 10. */
  max_proposals: number;
  /** How many example edge ids to carry as evidence per proposal (sorted ascending). Default 10. */
  max_sample_ids: number;
}

/**
 * Emergence sweep defaults (FR-116 M5). `enabled: false` (the sub-toggle DEFAULTS
 * OFF — the vocabulary-proposal op stays dormant until the operator opts in).
 * `min_count: 50` is the brief's recurrence threshold.
 */
export const DEFAULT_EMERGENCE_CONFIG: EmergenceConfig = {
  enabled: false,
  min_count: 50,
  max_proposals: 10,
  max_sample_ids: 10,
};

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Resolve the emergence sweep config (FR-116 M5). Reads the additive
 * `cognition.janitor.emergence` sub-block NESTED-ONLY. Like the cartographer
 * (`resolveCartographerConfig`), `enabled` is `cognition.janitor.enabled` AND the
 * `emergence.enabled` sub-toggle (DEFAULT OFF). Absent keys fall back to
 * `DEFAULT_EMERGENCE_CONFIG`.
 *
 * @param config the parsed `~/.igris/config.json` object
 */
export function resolveEmergenceConfig(
  config: Record<string, unknown> = {},
): EmergenceConfig {
  const cognition = asObject(config.cognition);
  const janitor = (cognition && asObject(cognition.janitor)) ?? {};
  const emergence = asObject(janitor.emergence) ?? {};
  const janitorEnabled =
    janitor.enabled !== undefined ? (janitor.enabled as boolean) : false;
  const emergenceEnabled =
    emergence.enabled !== undefined
      ? (emergence.enabled as boolean)
      : DEFAULT_EMERGENCE_CONFIG.enabled;
  const pick = <T>(key: string, fallback: T): T => {
    if (emergence[key] !== undefined) return emergence[key] as T;
    return fallback;
  };
  return {
    enabled: janitorEnabled && emergenceEnabled,
    min_count: pick('min_count', DEFAULT_EMERGENCE_CONFIG.min_count),
    max_proposals: pick('max_proposals', DEFAULT_EMERGENCE_CONFIG.max_proposals),
    max_sample_ids: pick('max_sample_ids', DEFAULT_EMERGENCE_CONFIG.max_sample_ids),
  };
}

// ---------------------------------------------------------------------------
// Signature extraction (deterministic)
// ---------------------------------------------------------------------------

/**
 * Normalize a raw signature value into a candidate edge-type NAME (lower snake).
 * Trims, lower-cases, collapses any run of non-alphanumerics to a single `_`, and
 * strips leading/trailing `_`. Returns `''` for an unusable value. This is what
 * lets a signature be compared against the lower-snake `VALID_EDGE_TYPES` literals
 * (a signature that normalizes to an existing type is already canonical).
 */
export function normalizeSignature(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Read the first non-empty signature field from a parsed metadata object. */
function extractSignature(metadata: Record<string, unknown>): string {
  for (const field of SIGNATURE_FIELDS) {
    const norm = normalizeSignature(metadata[field]);
    if (norm.length > 0) return norm;
  }
  return '';
}

/** True when a parsed metadata object carries the edge-soft-delete flag. */
function isSoftDeleted(metadata: Record<string, unknown>): boolean {
  const d = metadata.deleted;
  return d === true || d === 1 || d === 'true';
}

/** One clearing edge-type proposal (surfaced as a `propose_edge_type` suggestion). */
export interface EdgeTypeProposal {
  /** The normalized proposed edge-type name (lower snake). */
  proposed_name: string;
  /** The recurring metadata signature (same as `proposed_name` after normalization). */
  signature: string;
  /** How many inferred edges carry this signature. */
  occurrence_count: number;
  /** Example edge ids (ascending, capped at `max_sample_ids`) as evidence. */
  sample_edge_ids: number[];
}

/**
 * The DETERMINISTIC signature-counting core (FR-116 M5, op #6a). Reads every
 * `provenance='inferred'` edge (ORDER BY id ASC — stable), extracts each edge's
 * relation-label signature, tallies occurrences, and returns the NOVEL signatures
 * (not already a `VALID_EDGE_TYPES` literal) that recur ≥ `minCount`, sorted by
 * signature ascending and capped at `maxProposals`. Pure READ — no mutation. This
 * is the testable counting half; `surfaceEdgeTypeProposals` wraps it with the
 * suggestion write. Fail-soft → `[]`.
 */
export function detectEmergentEdgeTypes(
  db: Database.Database,
  minCount: number,
  maxProposals: number,
  maxSampleIds: number,
): EdgeTypeProposal[] {
  try {
    const known = new Set<string>(VALID_EDGE_TYPES as readonly string[]);
    const rows = db
      .prepare(
        `SELECT id, metadata FROM entity_edges
          WHERE provenance = 'inferred'
          ORDER BY id ASC`,
      )
      .all() as Array<{ id: number; metadata: string | null }>;

    // Tally signature → { count, sampleIds } in id-ascending order.
    const tally = new Map<string, { count: number; sampleIds: number[] }>();
    for (const r of rows) {
      let metadata: Record<string, unknown>;
      try {
        metadata = (r.metadata ? JSON.parse(r.metadata) : {}) as Record<string, unknown>;
      } catch {
        continue; // malformed metadata — skip
      }
      if (!metadata || typeof metadata !== 'object') continue;
      if (isSoftDeleted(metadata)) continue;
      const sig = extractSignature(metadata);
      if (!sig) continue;
      if (known.has(sig)) continue; // already a canonical edge type — never propose
      const entry = tally.get(sig) ?? { count: 0, sampleIds: [] };
      entry.count += 1;
      if (entry.sampleIds.length < maxSampleIds) entry.sampleIds.push(r.id);
      tally.set(sig, entry);
    }

    // Deterministic output: signatures clearing the threshold, sorted ascending.
    const clearing = Array.from(tally.entries())
      .filter(([, v]) => v.count >= minCount)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, Math.max(0, maxProposals));

    return clearing.map(([sig, v]) => ({
      proposed_name: sig,
      signature: sig,
      occurrence_count: v.count,
      sample_edge_ids: v.sampleIds,
    }));
  } catch {
    return [];
  }
}

/**
 * Surface `propose_edge_type` suggestions for the novel recurring signatures the
 * deterministic counter (`detectEmergentEdgeTypes`) found (FR-116 M5, op #6b).
 * PROPOSAL-ONLY (Decision #3b): this ONLY inserts review suggestions — it NEVER
 * mutates `VALID_EDGE_TYPES` (the array is unchanged before/after) and NEVER
 * touches an `entity_edges` row. Skips a signature that already has a pending
 * janitor `propose_edge_type` suggestion (don't double-queue). Returns the number
 * of proposals surfaced. Fail-soft → 0.
 */
export function surfaceEdgeTypeProposals(
  db: Database.Database,
  opts: EmergenceConfig = DEFAULT_EMERGENCE_CONFIG,
): number {
  try {
    const proposals = detectEmergentEdgeTypes(
      db,
      opts.min_count,
      opts.max_proposals,
      opts.max_sample_ids,
    );
    if (proposals.length === 0) return 0;

    const existsStmt = db.prepare(
      `SELECT id FROM suggestions
        WHERE status = 'pending' AND source_module = 'janitor'
          AND suggested_action LIKE '%"kind":"propose_edge_type"%'
          AND suggested_action LIKE ?
        LIMIT 1`,
    );
    const insertStmt = db.prepare(
      `INSERT INTO suggestions
         (source_module, project_slug, title, evidence, priority, status,
          created_at, expires_at, confidence, suggested_action, type_inferred,
          source_instance)
       VALUES ('janitor', NULL, ?, ?, 'low', 'pending', datetime('now'),
               datetime('now', ?), NULL, ?, 1, 'janitor')`,
    );

    let surfaced = 0;
    for (const p of proposals) {
      // Don't double-queue: skip if a pending proposal already names this signature.
      const dup = existsStmt.get(`%"signature":"${p.signature}"%`) as { id: number } | undefined;
      if (dup) continue;

      const rationale =
        `The metadata signature "${p.signature}" recurs on ${p.occurrence_count} inferred edge(s) ` +
        `but is NOT a canonical edge type. PROPOSAL-ONLY (Decision #3b): applying this does NOT ` +
        `modify the vocabulary at runtime. To make "${p.proposed_name}" canonical, a human must add ` +
        `it to VALID_EDGE_TYPES in brain-mcp-server/src/engine/components/edges/handlers.ts (+ the ` +
        `row-100 consumer sweep). No runtime mutation occurs.`;
      const suggestedAction = {
        kind: 'propose_edge_type',
        proposed_name: p.proposed_name,
        signature: p.signature,
        occurrence_count: p.occurrence_count,
        sample_edge_ids: p.sample_edge_ids,
        rationale,
      };
      insertStmt.run(
        `Propose new edge type "${p.proposed_name}" (${p.occurrence_count} occurrences)`,
        JSON.stringify({
          signature: p.signature,
          occurrence_count: p.occurrence_count,
          sample_edge_ids: p.sample_edge_ids,
        }),
        `+${PENDING_TTL_DAYS} days`,
        JSON.stringify(suggestedAction),
      );
      surfaced += 1;
    }
    return surfaced;
  } catch {
    return 0;
  }
}
