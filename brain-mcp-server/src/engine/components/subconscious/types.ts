/**
 * Brain Engine v5.0 — Subconscious Component Types
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
 * @author Fifty.ai
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
};
