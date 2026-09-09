/**
 * Brain Engine v7.0 — Subconscious Component Types
 *
 * Type definitions for the passive observer (FR-106). Detectors are pure
 * functions `(roDb, config) => SuggestionCandidate[]` — they never write,
 * never observe global state, and never throw. The runner persists their
 * output and emits events.
 *
 * Phase 1 ships two detectors (stalled, gap). Phase 2 adds conflict and
 * pattern, plus a `pattern_observations` table for multi-run smoothing.
 *
 * @module engine/components/subconscious/types
 * @author fifty.dev
 */

// ---------------------------------------------------------------------------
// Read-only DB
// ---------------------------------------------------------------------------

/**
 * Read-only view of the database surfaced to detectors.
 *
 * The wrapper rejects any non-SELECT/WITH SQL at `prepare()` time. This is
 * a defense-in-depth complement to the `data_version` integrity test in
 * `__tests__/integrity.test.ts`. Detectors never receive the raw `Database`
 * instance — only the runner does, and only the runner writes.
 */
export interface ReadOnlyDb {
  prepare(sql: string): {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
  };
}

// ---------------------------------------------------------------------------
// Suggestion lifecycle
// ---------------------------------------------------------------------------

/**
 * Source modules that can produce suggestions.
 *
 * FR-118 M2 OPENED this type from the closed `'stalled' | 'conflict' | 'gap' |
 * 'pattern'` enum to a free-form `string`. The subconscious is now an LLM
 * extractor that emits OPEN-typed suggestions (`type_inferred=1`) — the model
 * names the kind, not a fixed detector set. FR-118 M4b DELETED the rule
 * detectors; the four legacy values remain valid strings (the schema CHECK that
 * pinned them was dropped in the v3 table-rebuild), so historical rows that
 * carry them still list/dismiss normally. Readers (`/scan`, `/awaken`) render
 * the string verbatim, so an open value is non-breaking.
 *
 * The four legacy names are kept as `LEGACY_SOURCE_MODULES` — used as the
 * `igris_suggestion_list` schema `enum` HINT and to recognise pre-FR-118 rows.
 */
export type SuggestionSourceModule = string;

/** The four legacy rule-detector source modules (the rule engine was deleted in M4b; these label pre-FR-118 rows). */
export const LEGACY_SOURCE_MODULES = [
  'stalled',
  'conflict',
  'gap',
  'pattern',
] as const;

/** The legacy rule-detector union (labels historical rows; the detectors that emitted them are gone). */
export type LegacySourceModule = (typeof LEGACY_SOURCE_MODULES)[number];

/** Lifecycle states for a suggestion row. */
export type SuggestionStatus = 'pending' | 'dismissed' | 'acted';

/** Priority bucket — assigned per-module per the rules in plan Concern 7. */
export type SuggestionPriority = 'high' | 'medium' | 'low';

/**
 * Pre-persistence shape returned by the subconscious extractor (or, until M4,
 * the legacy detectors). The persist slot adds `id`, `created_at`,
 * `expires_at`, default status, etc. when inserting.
 *
 * FR-118 M2 added three columns the LLM extractor writes:
 *   - `confidence`       — the model's [0, 0.85]-capped confidence in the suggestion.
 *   - `suggested_action` — an OPTIONAL machine-applicable action (the M3 apply
 *     layer EXECUTES this; M2 only WRITES it as data). A JSON object with a
 *     `kind` discriminator + kind-specific params, serialized to a string in DB.
 *   - `type_inferred`    — 1 when the row came from the LLM extractor (open
 *     `source_module`), 0 for the legacy rule detectors. Stamped by the persist
 *     slot, not the candidate.
 */
export interface SuggestionCandidate {
  source_module: SuggestionSourceModule;
  project_slug: string | null;
  title: string;
  evidence: Record<string, unknown>;
  priority: SuggestionPriority;
  /** FR-118 M2 — the LLM's [0, 0.85]-capped confidence. Optional (legacy rows omit it). */
  confidence?: number;
  /**
   * FR-118 M2 — an optional machine-applicable action the M3 apply layer will
   * execute. A structured object (`{ kind, ...params }`); the persist slot
   * serializes it to a JSON string. Omitted when the suggestion is advisory-only.
   */
  suggested_action?: Record<string, unknown>;
}

/** Full suggestion row as stored in the `suggestions` table. */
export interface Suggestion {
  id: number;
  source_module: SuggestionSourceModule;
  project_slug: string | null;
  title: string;
  evidence: string; // JSON string in DB
  priority: SuggestionPriority;
  status: SuggestionStatus;
  created_at: string;
  expires_at: string | null;
  dismissed_at: string | null;
  dismissed_reason: string | null;
  acted_at: string | null;
  acted_brief_id: string | null;
  /** FR-118 M2 — [0, 0.85]-capped confidence; NULL for legacy rule rows. */
  confidence: number | null;
  /** FR-118 M2 — serialized action JSON; NULL when advisory-only or legacy. */
  suggested_action: string | null;
  /** FR-118 M2 — 1 for LLM-extractor rows, 0 for legacy rule rows. */
  type_inferred: number;
  /** TD-440 (v5) — the stable finding key; NULL until backfilled. */
  dedupe_key: string | null;
  /** TD-440 (v5) — the blocking anchor the key was built on; NULL until backfilled. */
  entity_key: string | null;
  /** TD-440 (v5) — how many times this finding has been emitted. Starts at 1. */
  seen_count: number;
  /** TD-440 (v5) — when the finding was last re-emitted; NULL until the first bump. */
  last_seen_at: string | null;
  /** TD-440 (v5) — JSON array of up to 3 distinct titles this row ABSORBED, so a wrong merge is readable off the row. */
  recurrence_titles: string;
  /** TD-440 (v5) — the producing instance ('subconscious', 'synapse', …). NULL on pre-v5 rows; NOT backfilled (see suggestions-read). */
  source_instance: string | null;
}

// ---------------------------------------------------------------------------
// Detector configuration
// ---------------------------------------------------------------------------

/**
 * Configuration thresholds for detectors. Every magic number lives here so
 * tests can override individual gates without rewiring the runner.
 */
export interface DetectorConfig {
  /** Days In Progress before a brief is "stalled" at medium priority. */
  stalled_in_progress_medium_days: number;
  /** Days In Progress before a brief is "stalled" at high priority. */
  stalled_in_progress_high_days: number;
  /** Days Ready before a brief is "stalled" at medium priority. */
  stalled_ready_medium_days: number;
  /** Days Ready before a brief is "stalled" at high priority. */
  stalled_ready_high_days: number;

  /** Days a project can be quiet before "gap" emits at medium priority. */
  gap_quiet_medium_days: number;
  /** Days a project can be quiet before "gap" emits at high priority. */
  gap_quiet_high_days: number;

  /** TTL for pending suggestions before auto-deletion (days). */
  pending_ttl_days: number;
  /** TTL for dismissed suggestions before auto-deletion (days). */
  dismissed_ttl_days: number;

  /** Threshold for permanent suppression in dismiss-loop (>= this many dismisses). */
  dismiss_suppress_count: number;
  /** Cooldown days for a single-dismiss signature (re-emit allowed after). */
  dismiss_cooldown_days: number;
  /** Max number of dismiss reasons to retain per signature. */
  dismiss_reasons_cap: number;

  // Pattern detector (Phase 2)
  /** Minimum observations required before a pattern can emit. */
  pattern_min_samples: number;
  /** Minimum |effect-size| (deviation from baseline) for emission. */
  pattern_min_effect: number;
  /** Number of distinct runs a pattern_key must appear in to surface. */
  pattern_smoothing_runs: number;
  /** Recency window (days) for the smoothing distinct-runs count. */
  pattern_smoothing_window_days: number;
  /** TTL for pattern_observations rows (days). */
  pattern_observation_ttl_days: number;

  // Conflict detector (Phase 2)
  /** Minimum cosine similarity (after L2-normalisation) to consider a pair. */
  conflict_cosine_threshold: number;
  /** Maximum Jaccard similarity to flag a high-cosine pair as conflict. */
  conflict_jaccard_threshold: number;
  /** Top-N most-recent learnings per project considered for the O(N^2) sweep. */
  conflict_max_pairs_per_project: number;
  /** Maximum conflict candidates emitted per project per run. */
  conflict_max_pairs_emitted: number;
}

/** Defaults aligned with priority tables in the FR-106 plan, Concern 7. */
export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  stalled_in_progress_medium_days: 14,
  stalled_in_progress_high_days: 30,
  stalled_ready_medium_days: 30,
  stalled_ready_high_days: 60,
  gap_quiet_medium_days: 90,
  gap_quiet_high_days: 180,
  pending_ttl_days: 30,
  dismissed_ttl_days: 90,
  dismiss_suppress_count: 2,
  dismiss_cooldown_days: 7,
  dismiss_reasons_cap: 5,
  pattern_min_samples: 30,
  pattern_min_effect: 0.15,
  pattern_smoothing_runs: 3,
  pattern_smoothing_window_days: 14,
  pattern_observation_ttl_days: 30,
  conflict_cosine_threshold: 0.85,
  conflict_jaccard_threshold: 0.5,
  conflict_max_pairs_per_project: 100,
  conflict_max_pairs_emitted: 5,
};

// ---------------------------------------------------------------------------
// Subconscious instance configuration (FR-118 M2 — the LLM extractor knobs)
// ---------------------------------------------------------------------------

/**
 * The subconscious cognition-instance config (FR-118 M2). Distinct from the
 * legacy `DetectorConfig` (the rule-detector thresholds, retained until M4):
 * this is the LLM extractor's envelope — timeout, daily budget, the minimum
 * digest size below which a run is skipped (the cost gate), the master enable
 * switch (`config.json` `subconscious.enabled`, MAINTAINING.md:67), and the
 * per-instance harness override (`null` = inherit the global
 * `llm_extractor.harness` default, which resolves to `claude`).
 *
 * These map onto the engine's agnostic `CognitionInstanceConfig`
 * (`cognition/types.ts`) via the subconscious instance factory.
 */
export interface SubconsciousConfig {
  /** Master switch — when false the engine emits `run_skipped reason=disabled`. */
  enabled: boolean;
  /** Hard wall-clock budget for the LLM subprocess (ms). */
  llm_timeout_ms: number;
  /** Max `cognition.subconscious.run_started` rows allowed per UTC day. */
  llm_daily_budget: number;
  /** Minimum digest size (UTF-8 bytes) below which the run is skipped (cost gate). */
  min_digest_bytes: number;
  /**
   * Per-instance harness override. `null` = inherit the global
   * `llm_extractor.harness` default (resolved to `claude`). Resolved by the
   * shared `backend/env.ts:resolveHarness` 4-layer chain.
   */
  harness: string | null;
  /**
   * TD-440 — the Jaccard floor at which a re-emitted claim is treated as the
   * SAME finding and bumps the pending row instead of inserting a new one.
   * Above 1.0 disables the paraphrase stage entirely (the kill switch), leaving
   * only exact-key dedup. The default is the knee of a measured sweep over 113
   * hand-labelled rows across two projects; see `finding-key.ts` and
   * `docs/architecture/subconscious_engine.md` §Finding key.
   */
  dedupe_claim_overlap: number;
  /**
   * TD-440 — below this many claim tokens the similarity score is not used at
   * all and the two token sets must be EQUAL. A three-word claim has no room to
   * be similar-but-different.
   */
  dedupe_min_claim_tokens: number;
  /**
   * TD-440 — every Nth recurrence promotes the row one priority step
   * (low→medium→high, high stays high). This is the property that would have
   * escalated lifeOS BR-023 after 30 consecutive runs instead of filing 30 rows.
   * Zero or negative disables escalation.
   */
  recurrence_escalate_n: number;
}

/**
 * Subconscious instance defaults (FR-118 M2 plan §B config shape).
 *
 * `enabled: false` mirrors the existing v7 flag (MAINTAINING.md:67) — the
 * OPERATIONS step flips it true AFTER the engine is verified live. The
 * 300s timeout + budget-of-8 + 10KiB min-digest are the plan's documented
 * knobs. `harness: null` inherits the global default.
 */
export const DEFAULT_SUBCONSCIOUS_CONFIG: SubconsciousConfig = {
  enabled: false,
  llm_timeout_ms: 300_000,
  llm_daily_budget: 8,
  min_digest_bytes: 10_240,
  harness: null,
  // MEASURED, then TUNED — and the second word matters. Over 113 hand-labelled
  // real rows in two projects the highest-scoring pair of GENUINELY DIFFERENT
  // findings sharing an entity scored 0.226, and 0.25 produced zero false
  // merges there and on a held-out second-project corpus. But over the full
  // 410-row population the cluster count is a SMOOTH SLOPE with no plateau
  // (140 at 0.226, 153 at 0.25, 198 at 0.30 — 2026-09-03), so this is a knob
  // set inside a clean band, NOT a gap the data shows. Two merges it admits
  // are arguably distinct findings; both are named in
  // `docs/architecture/subconscious_engine.md`, and `recurrence_titles` makes
  // each visible on the row it happened on.
  dedupe_claim_overlap: 0.25,
  dedupe_min_claim_tokens: 3,
  recurrence_escalate_n: 5,
};

/**
 * Row shape for the `pattern_observations` working table (Phase 2,
 * migration v2). One row per (pattern_key, run_id). The smoothing gate
 * counts `DISTINCT run_id` for a key within
 * `pattern_smoothing_window_days` and only emits the candidate when the
 * count reaches `pattern_smoothing_runs`.
 */
export interface PatternObservationRow {
  id: number;
  pattern_key: string;
  run_id: string;
  observed_at: string;
  effect_size: number;
  sample_size: number;
  /** JSON-serialized metadata; opaque to the gate, useful for forensics. */
  metadata: string;
}
