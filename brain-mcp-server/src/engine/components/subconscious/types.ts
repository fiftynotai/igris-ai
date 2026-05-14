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

/** Source modules that can produce suggestions. Phase 1: stalled, gap. */
export type SuggestionSourceModule = 'stalled' | 'conflict' | 'gap' | 'pattern';

/** Lifecycle states for a suggestion row. */
export type SuggestionStatus = 'pending' | 'dismissed' | 'acted';

/** Priority bucket — assigned per-module per the rules in plan Concern 7. */
export type SuggestionPriority = 'high' | 'medium' | 'low';

/**
 * Pre-persistence shape returned by detectors. The runner adds `id`,
 * `created_at`, `expires_at`, default status, etc. when inserting.
 */
export interface SuggestionCandidate {
  source_module: SuggestionSourceModule;
  project_slug: string | null;
  title: string;
  evidence: Record<string, unknown>;
  priority: SuggestionPriority;
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
