/**
 * Brain Engine v7.1 — Janitor component types (FR-119).
 *
 * The FOURTH self-describing cognition instance ("janitor") cleans WITHIN the
 * memory layer. It is the structural TWIN of synapse (FR-211): the near-dupe
 * MERGE proposal is the LLM-extractor part (a cheap deterministic candidate-pair
 * digest → one brain-isolated LLM judgment → a queued `suggestions` row); the
 * three deterministic hygiene duties (TD-086 confidence bumps, stale-pending
 * rejection, dormant re-eval-of-rejection) are a pure sweep the janitor RUNNER
 * performs around `runExtractor`.
 *
 * These are the janitor INSTANCE's private types (opaque to the agnostic engine).
 * `JanitorConfig` maps onto the engine's `CognitionInstanceConfig` via the
 * instance factory; the extra janitor-specific knobs (`dupe_cosine_floor`,
 * `top_k`, `max_pairs`, `auto_merge`, `auto_merge_threshold`, and the three
 * hygiene N-thresholds) drive the candidate generator, the persist slot, and the
 * deterministic sweep.
 *
 * @module engine/components/janitor/types
 * @author fifty.dev
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The janitor cognition-instance config (FR-119). The first five keys map onto
 * the engine's agnostic `CognitionInstanceConfig` (timeout/budget/min-bytes/
 * enabled/harness); the rest are janitor-specific candidate-generation +
 * persistence + hygiene knobs kept HERE (not in the engine) per the
 * R-OVER-ABSTRACT discipline — the engine still knows nothing about dedup/merge.
 */
export interface JanitorConfig {
  /** Master switch — when false the engine emits `run_skipped reason=disabled` AND the deterministic sweep is gated too. */
  enabled: boolean;
  /** Hard wall-clock budget for the LLM subprocess (ms). */
  llm_timeout_ms: number;
  /** Max `cognition.janitor.run_started` rows allowed per UTC day. */
  llm_daily_budget: number;
  /** Minimum candidate-digest size (UTF-8 bytes) below which the run is skipped (cost gate). */
  min_input_bytes: number;
  /** Per-instance harness override. `null` = inherit the global `llm_extractor.harness`. */
  harness: string | null;
  /**
   * Cosine floor for the near-dupe KNN pre-filter (L2→cosine via l2ToCosine).
   * Lowered to 0.90 in M1 (FR-116) — the higher recall catches more LLM-rephrased
   * dupes (#163) that the old 0.95 floor missed. Paired with `dupe_min_overlap`:
   * a candidate must clear BOTH gates, so the lower cosine floor does NOT flood
   * the LLM with same-topic-but-distinct pairs. The LLM still judges
   * keep/merge/false-positive on what survives (TD-087).
   */
  dupe_cosine_floor: number;
  /**
   * M1 (FR-116) Jaccard overlap GATE in [0, 1]. A candidate pair must ALSO clear
   * this normalized-token overlap floor (not just `dupe_cosine_floor`) to be
   * surfaced to the LLM. This is what lets `dupe_cosine_floor` drop to 0.90
   * safely: high-cosine-but-lexically-distinct pairs (same topic, different
   * knowledge) fall below the overlap floor and are excluded before the LLM ever
   * sees them. Computed from the NORMALIZED fingerprint tokens (#930/TD-087).
   */
  dupe_min_overlap: number;
  /** Top-K neighbours probed per learning in the vec0 KNN. */
  top_k: number;
  /** Hard cap on candidate pairs per run (the learning #153 cheap pre-filter bound). */
  max_pairs: number;
  /**
   * When true, `persistCandidate` SKIPS the review suggestion and applies the
   * merge DIRECTLY via `applyMergeLearnings` — but ONLY when the pair's cosine is
   * at or above `auto_merge_threshold` and the LLM concurs. Default false =
   * always review-gated (Decision B — merge is destructive).
   */
  auto_merge: boolean;
  /** Cosine at or above which an auto_merge=true run may merge without review. */
  auto_merge_threshold: number;
  /** TD-086: bump `confidence` +0.05 after this many rediscoveries of an approved learning. */
  rediscovery_bump_n: number;
  /** TD-086 (dormant): surface a re_evaluate_rejection suggestion after this many rejected-pattern recurrences. */
  reject_recur_n: number;
  /** Stale-pending cleanup: reject `pending_review` learnings older than this many days. */
  stale_days: number;
}

/**
 * Janitor instance defaults (FR-119). `enabled: false` mirrors the other three
 * cognition instances (the OPERATIONS step flips it true after the engine is
 * verified live). Daily 04:00 cron (offset from synapse's 03:00), budget-of-8,
 * 300s timeout. `dupe_cosine_floor: 0.90` (M1/FR-116) is the near-dupe floor,
 * gated by `dupe_min_overlap: 0.6` (a candidate must clear BOTH); `auto_merge:
 * false` per Decision B and `auto_merge_threshold: 0.95` stays HIGH (the
 * review-free fork still demands very-close pairs). The hygiene thresholds are
 * the plan's operator-confirmed defaults (bump after 3 rediscoveries, re-eval
 * after 5 recurrences, reject pending after 14 days).
 */
export const DEFAULT_JANITOR_CONFIG: JanitorConfig = {
  enabled: false,
  llm_timeout_ms: 300_000,
  llm_daily_budget: 8,
  min_input_bytes: 100,
  harness: null,
  dupe_cosine_floor: 0.9,
  dupe_min_overlap: 0.6,
  top_k: 5,
  max_pairs: 200,
  auto_merge: false,
  auto_merge_threshold: 0.95,
  rediscovery_bump_n: 3,
  reject_recur_n: 5,
  stale_days: 14,
};

// ---------------------------------------------------------------------------
// Candidate + proposal shapes
// ---------------------------------------------------------------------------

/**
 * One near-duplicate candidate pair for the LLM to judge. `from_id < to_id`
 * (sorted-id dedup). Carries each side's title + a NORMALIZED content snippet so
 * the model can reason without another DB read. `cosine` is the KNN similarity
 * (from the NORMALIZED-fingerprint query embedding — #930/TD-087); `overlap` is
 * the normalized-token Jaccard signal — a M1 (FR-116) GATE (`>= dupe_min_overlap`)
 * as well as an advisory the LLM reads.
 */
export interface DuplicatePair {
  /** The lower learning id (sorted). */
  from_id: number;
  /** The higher learning id (sorted). */
  to_id: number;
  from_title: string;
  from_snippet: string;
  to_title: string;
  to_snippet: string;
  /** Cosine similarity of the normalized-fingerprint embeddings (>= dupe_cosine_floor). */
  cosine: number;
  /** Normalized-token Jaccard overlap in [0, 1] — M1 gate (>= dupe_min_overlap) + LLM advisory. */
  overlap: number;
}

/** The LLM's verdict on one candidate pair. */
export type MergeVerdict = 'merge' | 'keep_a' | 'keep_b' | 'keep_both';

/**
 * One validated merge proposal parsed from the LLM response. Only ACTIONABLE
 * verdicts (`merge`/`keep_a`/`keep_b`) yield a proposal; `keep_both` (false
 * positive) is dropped. `survivor_id`/`duplicate_id` are resolved from the
 * verdict + the cited pair (survivor = the kept learning). `synthesized_content`
 * is present only for `merge`. `cosine` is carried through from the candidate so
 * the persist slot can gate the auto_merge fork.
 */
export interface MergeProposal {
  /** The learning that SURVIVES the merge (kept). */
  survivor_id: number;
  /** The learning that is soft-deleted (`review_status='merged'`). */
  duplicate_id: number;
  /** The LLM verdict that produced this proposal (merge/keep_a/keep_b). */
  verdict: MergeVerdict;
  /** For `merge` only — the synthesized content to write onto the survivor. */
  synthesized_content?: string;
  /** One concise sentence the operator reads. */
  justification: string;
  /** Calibrated confidence in [0, 0.85]. */
  confidence: number;
  /** The candidate pair's cosine — gates the auto_merge fork. */
  cosine: number;
}

// ---------------------------------------------------------------------------
// Run result (the audit row shape the runner returns)
// ---------------------------------------------------------------------------

/**
 * The aggregate outcome of one `runJanitor` invocation — the shape written to
 * `brain_maintenance_runs` (minus the timestamps) and returned by
 * `igris_janitor_run_now`. `outcome` is the near-dupe LLM extractor's terminal
 * disposition; the deterministic-sweep counters are aggregated alongside.
 */
export interface JanitorRunResult {
  /** The run id stamped on the `brain_maintenance_runs` audit row. */
  run_id: string;
  /** The near-dupe LLM extractor's terminal disposition (succeeded/failed/skipped). */
  outcome: 'succeeded' | 'failed' | 'skipped';
  /** Merge suggestions QUEUED for review this run (review-gated default). */
  merges_proposed: number;
  /** Merges applied DIRECTLY this run (auto_merge fork only). */
  merges_applied: number;
  /** Approved learnings whose confidence was bumped +0.05 (TD-086). */
  confidence_bumps: number;
  /** `pending_review` learnings flipped to `rejected` (stale cleanup). */
  stale_rejected: number;
  /** re_evaluate_rejection suggestions surfaced (dormant — 0 in production). */
  re_eval_surfaced: number;
  /** FR-116 M2: contradiction resolutions QUEUED for review by the arbiter instance. */
  contradictions_proposed: number;
  /** FR-116 M2: contradiction resolutions applied DIRECTLY by the arbiter auto_resolve fork. */
  contradictions_resolved: number;
  /** The near-dupe extractor's terminal disposition of the arbiter co-run, when not succeeded. */
  arbiter_outcome?: 'succeeded' | 'failed' | 'skipped';
  /** The near-dupe extractor's skip/fail reason, when not succeeded. */
  reason?: string;
}
