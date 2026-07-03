/**
 * Brain Engine v7.1 — Synapse component types (FR-211).
 *
 * The THIRD self-describing cognition instance ("synapse") forms typed edges
 * between memory nodes. It reads a cheap deterministic candidate-pair digest
 * (embedding-cosine neighbours + shared-brief siblings, minus pairs already
 * edged/pending), runs one brain-isolated LLM call to judge the relationship
 * type + confidence, and QUEUES each proposed edge for operator review by
 * reusing the existing `suggestions` channel (`source_module='edge_inference'`,
 * `suggested_action.kind='add_edge'`). Approval flows through the already-shipped
 * `igris_suggestion_apply_action` → `applyAddEdge` → `handleEdgeCreate(
 * provenance:'inferred')` path — no new review/apply tools, no schema change.
 *
 * These are the synapse INSTANCE's private types (opaque to the agnostic engine).
 * `SynapseConfig` maps onto the engine's `CognitionInstanceConfig` via the
 * instance factory; the extra synapse-specific knobs (`cosine_floor`, `top_k`,
 * `max_pairs`, `auto_approve`) drive the candidate generator + persist slot.
 *
 * @module engine/components/synapse/types
 * @author fifty.dev
 */

/**
 * The edge-type vocabulary synapse may PROPOSE. A strict subset of the edges
 * component's `VALID_EDGE_TYPES` (edges/handlers.ts) — the four inference-
 * relevant relations between memory nodes. `related_to`/`duplicates` are
 * symmetric; `supersedes`/`derived_from` are directional (the LLM's stated
 * from→to order is preserved; the validator only cite-checks the unordered pair).
 */
export const SYNAPSE_EDGE_TYPES = [
  'supersedes',
  'derived_from',
  'related_to',
  'duplicates',
] as const;

export type SynapseEdgeType = (typeof SYNAPSE_EDGE_TYPES)[number];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The synapse cognition-instance config (FR-211). The first five keys map onto
 * the engine's agnostic `CognitionInstanceConfig` (timeout/budget/min-bytes/
 * enabled/harness); the remaining four are synapse-specific candidate-generation
 * + persistence knobs kept HERE (not in the engine) per the R-OVER-ABSTRACT
 * discipline — the engine still knows nothing about edge inference.
 */
export interface SynapseConfig {
  /** Master switch — when false the engine emits `run_skipped reason=disabled`. */
  enabled: boolean;
  /** Hard wall-clock budget for the LLM subprocess (ms). */
  llm_timeout_ms: number;
  /** Max `cognition.synapse.run_started` rows allowed per UTC day. */
  llm_daily_budget: number;
  /** Minimum candidate-digest size (UTF-8 bytes) below which the run is skipped (cost gate). */
  min_input_bytes: number;
  /** Per-instance harness override. `null` = inherit the global `llm_extractor.harness`. */
  harness: string | null;
  /** Cosine floor for the embedding-KNN primary signal (L2→cosine via l2ToCosine). */
  cosine_floor: number;
  /** Top-K neighbours probed per learning in the vec0 KNN. */
  top_k: number;
  /** Hard cap on candidate pairs per run (the learning #153 cheap pre-filter bound). */
  max_pairs: number;
  /**
   * When true, `persistCandidate` SKIPS the suggestion and writes the edge
   * directly via `handleEdgeCreate(provenance:'inferred')`. Default false =
   * always review-gated (D5).
   */
  auto_approve: boolean;
}

/**
 * Synapse instance defaults (FR-211). `enabled: false` mirrors the other two
 * cognition instances (the OPERATIONS step flips it true after the engine is
 * verified live). Daily 03:00 cron, budget-of-8, 300s timeout. The candidate
 * knobs — cosine ≥ 0.80 (below the 0.85 conflict precedent to favour recall),
 * top-k=5, ≤200 pairs/run — are the D3 operator-confirmed defaults. `harness:
 * null` inherits the global default. `auto_approve: false` per D5.
 */
export const DEFAULT_SYNAPSE_CONFIG: SynapseConfig = {
  enabled: false,
  llm_timeout_ms: 300_000,
  llm_daily_budget: 8,
  min_input_bytes: 100,
  harness: null,
  cosine_floor: 0.8,
  top_k: 5,
  max_pairs: 200,
  auto_approve: false,
};

// ---------------------------------------------------------------------------
// Candidate + proposal shapes
// ---------------------------------------------------------------------------

/** Which cheap pre-filter signal surfaced a candidate pair. */
export type CandidateSignal = 'cosine' | 'shared_brief';

/**
 * One candidate pair for the LLM to judge. `from_id < to_id` (sorted-id dedup);
 * the LLM decides direction for the directional edge types. Carries each side's
 * title + a content snippet so the model can reason without another DB read.
 */
export interface CandidatePair {
  /** The lower learning id (sorted). */
  from_id: number;
  /** The higher learning id (sorted). */
  to_id: number;
  from_title: string;
  from_snippet: string;
  to_title: string;
  to_snippet: string;
  /** Which signal surfaced this pair. */
  signal: CandidateSignal;
  /** Cosine similarity (cosine signal only) — for observability. */
  cosine?: number;
  /** The shared source_brief (shared_brief signal only). */
  shared_brief?: string;
}

/**
 * One validated edge proposal parsed from the LLM response. `from_id`/`to_id`
 * carry the LLM's chosen direction (for `supersedes`/`derived_from`); the
 * validator has confirmed the UNORDERED pair was a candidate. `edge_type` is in
 * `SYNAPSE_EDGE_TYPES`; `confidence` is clamped to [0, 0.85].
 */
export interface EdgeProposal {
  from_id: number;
  to_id: number;
  edge_type: SynapseEdgeType;
  confidence: number;
  justification: string;
}
