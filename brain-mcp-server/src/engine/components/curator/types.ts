/**
 * Brain Engine v7.1 — Curator component types (FR-116 M3).
 *
 * The SIXTH self-describing cognition instance ("curator") PRUNES OUTDATED
 * knowledge within the memory layer. It is the structural TWIN of the janitor
 * near-dupe merge (FR-119) and the arbiter contradiction resolution (FR-116 M2):
 * a cheap DETERMINISTIC staleness detector produces the candidate set → one
 * brain-isolated LLM judgment → a queued `suggestions` row (or a direct apply on
 * the default-OFF `auto_prune` fork). It differs from janitor/arbiter in EVERY
 * differing slot:
 *
 *   - CANDIDATE SIGNAL: DETERMINISTIC staleness (`review_status='approved' AND
 *     access_count = 0 AND created_at < now-Nmonths`, plus an optional
 *     deprecated-tech tag list — §2 row 3 / Decision #5), NOT near-duplication or
 *     semantic opposition. `access_count` IS maintained (recall bumps it,
 *     memory.ts:670/:773) — the signal is LIVE.
 *   - PROMPT: an outdated-knowledge review (keep / lower_confidence / prune),
 *     NOT a merge or contradiction judgment.
 *   - OUTPUT VERB: `prune_learning` (soft-delete via `review_status='pruned'` /
 *     lower confidence / keep-and-mark-reviewed), NOT `merge_learnings` /
 *     `resolve_contradiction`.
 *
 * Mandate-separation #152: the curator is a DISTINCT instance (distinct
 * candidate/prompt/persist), merely CO-SCHEDULED under the janitor runner
 * (Decision #4A) — it rides the SINGLE `cognition.janitor.enabled` flag +
 * `janitor_engine` cron + the shared `brain_maintenance_runs` audit row. Its
 * tuning lives in the additive `cognition.janitor.pruning.*` sub-block.
 *
 * These are the curator INSTANCE's private types (opaque to the agnostic
 * engine). `CuratorConfig` maps onto the engine's `CognitionInstanceConfig` via
 * the instance factory; the extra staleness/persist knobs
 * (`stale_months`/`max_access_count`/`deprecated_tags`/`max_candidates`/
 * `auto_prune`/`anomaly_threshold`) drive the candidate generator + the persist
 * slot — never the engine (R-OVER-ABSTRACT).
 *
 * @module engine/components/curator/types
 * @author fifty.dev
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The default deprecated-technology tag list (Decision #5, optional signal). A
 * learning carrying ANY of these tags is a staleness candidate REGARDLESS of its
 * access_count/age — deprecated tech is outdated by definition. Empty-safe: the
 * detector treats an empty list as "age+access only". Matched case-insensitively
 * against the learning's `tags` / `tech_stack` free text.
 */
export const DEFAULT_DEPRECATED_TAGS: readonly string[] = [];

/**
 * The curator cognition-instance config (FR-116 M3). The first five keys map
 * onto the engine's agnostic `CognitionInstanceConfig` (timeout/budget/min-bytes/
 * enabled/harness); the rest are curator-specific STALENESS-detection +
 * persistence knobs kept HERE (not in the engine) per the R-OVER-ABSTRACT
 * discipline. `enabled` is DERIVED from `cognition.janitor.enabled` (no new flag).
 */
export interface CuratorConfig {
  /** Master switch — DERIVED from `cognition.janitor.enabled` (Decision #4A, no new flag). */
  enabled: boolean;
  /** Hard wall-clock budget for the LLM subprocess (ms). */
  llm_timeout_ms: number;
  /** Max curator `run_started` rows allowed per UTC day (its own per-instance budget). */
  llm_daily_budget: number;
  /** Minimum candidate-digest size (UTF-8 bytes) below which the run is skipped (cost gate). */
  min_input_bytes: number;
  /** Per-instance harness override. `null` = inherit the global `llm_extractor.harness`. */
  harness: string | null;
  /**
   * Staleness WINDOW in months — a learning is a candidate when its `created_at`
   * is older than `now - stale_months` (Decision #5). Default 6.
   */
  stale_months: number;
  /**
   * Staleness ACCESS threshold — a learning is a candidate when its
   * `access_count` is at or below this (Decision #5). Default 0 = never recalled.
   * `access_count` is bumped on recall (memory.ts:670/:773), so 0 means "approved
   * but never actually used since it was learned".
   */
  max_access_count: number;
  /**
   * Optional deprecated-tech tag list. A learning carrying ANY of these tags is a
   * candidate REGARDLESS of age/access. Empty = age+access only.
   */
  deprecated_tags: readonly string[];
  /** Hard cap on staleness candidates per run (the learning #153 cheap pre-filter bound). */
  max_candidates: number;
  /**
   * When true, `persistCandidate` SKIPS the review suggestion and applies a
   * `prune` verdict DIRECTLY via `applyPruneLearning` — but the ANOMALY guard
   * (`anomaly_threshold`) REFUSES to auto-apply beyond the threshold in a single
   * run (excess prunes fall back to review). Default false = always review-gated
   * (pruning soft-deletes a learning — destructive).
   */
  auto_prune: boolean;
  /**
   * Anomaly safety valve — if a single run's prune INTENT (proposed + applied)
   * exceeds this, the run surfaces a WARNING, and the `auto_prune` fork REFUSES to
   * auto-apply beyond the threshold (excess prunes are queued for review instead).
   * Default 50.
   */
  anomaly_threshold: number;
}

/**
 * Curator instance defaults (FR-116 M3). `enabled: false` mirrors the other
 * cognition instances (resolved from `cognition.janitor.enabled` in production).
 * The envelope defaults match the janitor/arbiter (shared cron/discipline). The
 * staleness policy is the operator-confirmed Decision #5 default (6 months,
 * access_count 0). `auto_prune: false` is the operator-confirmed default (pruning
 * is destructive → review-gated), `anomaly_threshold: 50` is the safety valve.
 */
export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  enabled: false,
  llm_timeout_ms: 300_000,
  llm_daily_budget: 8,
  min_input_bytes: 100,
  harness: null,
  stale_months: 6,
  max_access_count: 0,
  deprecated_tags: DEFAULT_DEPRECATED_TAGS,
  max_candidates: 200,
  auto_prune: false,
  anomaly_threshold: 50,
};

// ---------------------------------------------------------------------------
// Candidate + proposal shapes
// ---------------------------------------------------------------------------

/**
 * One OUTDATED-KNOWLEDGE candidate for the LLM to review. Produced by the
 * DETERMINISTIC staleness detector (`janitor/hygiene.ts:detectOutdatedLearnings`).
 * Carries the title + a normalized content snippet + the age/access signals +
 * the `reason` the deterministic pre-filter flagged it on, so the model can judge
 * keep/lower/prune without another DB read.
 */
export interface StaleCandidate {
  /** The learning id. */
  id: number;
  title: string;
  snippet: string;
  /** The learning's `created_at` (age signal). */
  created_at: string;
  /** The learning's `access_count` (usage signal — 0 = never recalled). */
  access_count: number;
  /** The learning's current confidence (the LLM lowers or keeps it). */
  confidence: number;
  /** The deterministic staleness reason ('stale' | 'deprecated_tag' | 'stale+deprecated_tag'). */
  reason: string;
}

/** The LLM's verdict on one staleness candidate. */
export type PruneVerdict = 'keep' | 'lower_confidence' | 'prune';

/**
 * One validated prune proposal parsed from the LLM response. EVERY verdict yields
 * a proposal (unlike the janitor/arbiter, `keep` is ACTIONABLE here — it stamps
 * `last_reviewed_at` so the row is not immediately re-flagged). `confidence_delta`
 * is present only for `lower_confidence`. `learning_id` is cite-checked against
 * the candidate set.
 */
export interface PruneProposal {
  /** The learning the verdict applies to (cite-checked against the candidates). */
  learning_id: number;
  /** The LLM verdict (keep / lower_confidence / prune). */
  verdict: PruneVerdict;
  /** For `lower_confidence` only — how much to subtract (clamped to [0, 1]). */
  confidence_delta?: number;
  /** One concise sentence the operator reads. */
  justification: string;
  /** Calibrated confidence in [0, 0.85]. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Config resolution (nested-only, gated by cognition.janitor.enabled)
// ---------------------------------------------------------------------------

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Resolve the curator instance config (FR-116 M3). Reads the additive
 * `cognition.janitor.pruning` sub-block NESTED-ONLY. The `enabled` gate is NOT
 * read from the sub-block — it is DERIVED from `cognition.janitor.enabled`
 * (Decision #4A: one flag for the whole janitor + its co-scheduled instances, no
 * new flag, no new cron). Absent keys fall back to `DEFAULT_CURATOR_CONFIG`.
 *
 * @param config the parsed `~/.igris/config.json` object
 */
export function resolveCuratorConfig(
  config: Record<string, unknown> = {},
): CuratorConfig {
  const cognition = asObject(config.cognition);
  const janitor = (cognition && asObject(cognition.janitor)) ?? {};
  const pruning = asObject(janitor.pruning) ?? {};
  // The gate is the janitor's single enabled flag (no new flag — Decision #4A).
  const enabled =
    janitor.enabled !== undefined
      ? (janitor.enabled as boolean)
      : DEFAULT_CURATOR_CONFIG.enabled;
  const pick = <T>(key: string, fallback: T): T => {
    if (pruning[key] !== undefined) return pruning[key] as T;
    return fallback;
  };
  return {
    enabled,
    llm_timeout_ms: pick('llm_timeout_ms', DEFAULT_CURATOR_CONFIG.llm_timeout_ms),
    llm_daily_budget: pick('llm_daily_budget', DEFAULT_CURATOR_CONFIG.llm_daily_budget),
    min_input_bytes: pick('min_input_bytes', DEFAULT_CURATOR_CONFIG.min_input_bytes),
    harness: pick('harness', DEFAULT_CURATOR_CONFIG.harness),
    stale_months: pick('stale_months', DEFAULT_CURATOR_CONFIG.stale_months),
    max_access_count: pick('max_access_count', DEFAULT_CURATOR_CONFIG.max_access_count),
    deprecated_tags: pick('deprecated_tags', DEFAULT_CURATOR_CONFIG.deprecated_tags),
    max_candidates: pick('max_candidates', DEFAULT_CURATOR_CONFIG.max_candidates),
    auto_prune: pick('auto_prune', DEFAULT_CURATOR_CONFIG.auto_prune),
    anomaly_threshold: pick('anomaly_threshold', DEFAULT_CURATOR_CONFIG.anomaly_threshold),
  };
}
