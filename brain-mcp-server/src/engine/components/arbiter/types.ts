/**
 * Brain Engine v7.1 — Arbiter component types (FR-116 M2).
 *
 * The FIFTH self-describing cognition instance ("arbiter") RESOLVES
 * CONTRADICTIONS within the memory layer. It is the structural TWIN of the
 * janitor near-dupe merge (FR-119): a cheap deterministic candidate-pair digest
 * → one brain-isolated LLM judgment → a queued `suggestions` row (or a direct
 * apply on the default-OFF auto fork). It differs from the janitor in EVERY
 * differing slot:
 *
 *   - CANDIDATE SIGNAL: semantic OPPOSITION (same-topic high-cosine pair with a
 *     deterministic negation/antonym cue), NOT near-duplication (§2 row 2).
 *   - PROMPT: a resolve-contradiction judgment (newer-wins / both-valid-scope /
 *     evolved-merge / not-a-contradiction), NOT a merge judgment.
 *   - OUTPUT VERB: `resolve_contradiction` (supersede / annotate-scope /
 *     evolved-merge), NOT `merge_learnings`.
 *
 * Mandate-separation #152: the arbiter is a DISTINCT instance (distinct
 * candidate/prompt/persist), merely CO-SCHEDULED under the janitor runner
 * (Decision #4A) — it rides the SINGLE `cognition.janitor.enabled` flag +
 * `janitor_engine` cron + the shared `brain_maintenance_runs` audit row. Its
 * tuning lives in the additive `cognition.janitor.contradiction.*` sub-block.
 *
 * These are the arbiter INSTANCE's private types (opaque to the agnostic
 * engine). `ArbiterConfig` maps onto the engine's `CognitionInstanceConfig` via
 * the instance factory; the extra opposition/persist knobs
 * (`contradiction_cosine_floor`/`_ceil`, `top_k`, `max_pairs`, `negation_cues`,
 * `auto_resolve`, `auto_resolve_threshold`) drive the candidate generator + the
 * persist slot — never the engine (R-OVER-ABSTRACT).
 *
 * @module engine/components/arbiter/types
 * @author fifty.dev
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The default deterministic negation cues (Decision #7). A pair is an opposition
 * CANDIDATE when the two sides differ in NEGATION POLARITY (one side carries a
 * cue, the other does not) — the cheap "use X" vs "X is wrong / avoid X" signal.
 * Matched against the `normalizeForDedup`-normalized text (so apostrophes /
 * punctuation are collapsed identically on both sides). Multi-word phrases are
 * supported (they normalize the same way the text does).
 */
export const DEFAULT_NEGATION_CUES: readonly string[] = [
  'not',
  "don't",
  'never',
  'no longer',
  'avoid',
  'deprecated',
  'deprecate',
  'wrong',
  'instead',
  'stop using',
  "shouldn't",
  "doesn't",
  'obsolete',
  'superseded',
  'incorrect',
  'anti-pattern',
  'antipattern',
];

/**
 * The default antonym pairs (Decision #7 secondary cue). When one side carries
 * `w1` and the other carries `w2` (in either direction) the pair is flagged as a
 * likely opposition. Kept small + deterministic; the LLM makes the final call
 * (the validator drops `not_a_contradiction`).
 */
export const DEFAULT_ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['enable', 'disable'],
  ['always', 'never'],
  ['use', 'avoid'],
  ['add', 'remove'],
  ['true', 'false'],
  ['prefer', 'avoid'],
  ['increase', 'decrease'],
  ['allow', 'forbid'],
];

/**
 * The arbiter cognition-instance config (FR-116 M2). The first five keys map
 * onto the engine's agnostic `CognitionInstanceConfig` (timeout/budget/min-bytes/
 * enabled/harness); the rest are arbiter-specific OPPOSITION-detection +
 * persistence knobs kept HERE (not in the engine) per the R-OVER-ABSTRACT
 * discipline. `enabled` is DERIVED from `cognition.janitor.enabled` (no new flag).
 */
export interface ArbiterConfig {
  /** Master switch — DERIVED from `cognition.janitor.enabled` (Decision #4A, no new flag). */
  enabled: boolean;
  /** Hard wall-clock budget for the LLM subprocess (ms). */
  llm_timeout_ms: number;
  /** Max arbiter `run_started` rows allowed per UTC day (its own per-instance budget). */
  llm_daily_budget: number;
  /** Minimum candidate-digest size (UTF-8 bytes) below which the run is skipped (cost gate). */
  min_input_bytes: number;
  /** Per-instance harness override. `null` = inherit the global `llm_extractor.harness`. */
  harness: string | null;
  /**
   * Cosine FLOOR for the opposition pre-filter — the two learnings must be on the
   * SAME topic (high cosine) to be a genuine contradiction rather than two
   * unrelated statements. Default 0.80 (below the janitor near-dupe floor, since a
   * contradiction is same-topic-but-opposing, not lexically identical).
   */
  contradiction_cosine_floor: number;
  /**
   * Cosine CEILING — pairs at or above this are near-identical restatements
   * (the janitor's dedup mandate, not the arbiter's). Excluding them keeps the two
   * instances' candidate sets disjoint. Default 0.995.
   */
  contradiction_cosine_ceil: number;
  /** Top-K neighbours probed per learning in the vec0 KNN. */
  top_k: number;
  /** Hard cap on candidate pairs per run (the learning #153 cheap pre-filter bound). */
  max_pairs: number;
  /** Deterministic negation cues driving the negation-polarity-XOR opposition signal. */
  negation_cues: readonly string[];
  /**
   * When true, `persistCandidate` SKIPS the review suggestion and applies the
   * resolution DIRECTLY via `applyResolveContradiction` — but ONLY when the pair's
   * cosine is at or above `auto_resolve_threshold`. Default false = always
   * review-gated (resolving a contradiction supersedes a learning — destructive).
   */
  auto_resolve: boolean;
  /** Cosine at or above which an auto_resolve=true run may resolve without review. */
  auto_resolve_threshold: number;
}

/**
 * Arbiter instance defaults (FR-116 M2). `enabled: false` mirrors the other
 * cognition instances (resolved from `cognition.janitor.enabled` in production).
 * The envelope defaults match the janitor's (shared cron/discipline); the
 * opposition band is 0.80–0.995 (same-topic-but-not-identical). `auto_resolve:
 * false` is the operator-confirmed default (Decision #1 — supersede is
 * destructive → review-gated), `auto_resolve_threshold: 0.95` stays HIGH.
 */
export const DEFAULT_ARBITER_CONFIG: ArbiterConfig = {
  enabled: false,
  llm_timeout_ms: 300_000,
  llm_daily_budget: 8,
  min_input_bytes: 100,
  harness: null,
  contradiction_cosine_floor: 0.8,
  contradiction_cosine_ceil: 0.995,
  top_k: 5,
  max_pairs: 200,
  negation_cues: DEFAULT_NEGATION_CUES,
  auto_resolve: false,
  auto_resolve_threshold: 0.95,
};

// ---------------------------------------------------------------------------
// Candidate + proposal shapes
// ---------------------------------------------------------------------------

/**
 * One CONTRADICTION candidate pair for the LLM to judge. `from_id < to_id`
 * (sorted-id dedup). Carries each side's title + a NORMALIZED content snippet +
 * `created_at` so the model can decide recency (newer-wins) without another DB
 * read. `cosine` is the same-topic KNN similarity (from the NORMALIZED-fingerprint
 * query embedding — #930/TD-087); `cue` is the deterministic opposition signal
 * ('negation' | 'antonym' | 'negation+antonym') the pre-filter fired on.
 */
export interface ContradictionPair {
  /** The lower learning id (sorted). */
  from_id: number;
  /** The higher learning id (sorted). */
  to_id: number;
  from_title: string;
  from_snippet: string;
  /** The `from_id` learning's created_at (recency signal for newer-wins). */
  from_created_at: string;
  to_title: string;
  to_snippet: string;
  /** The `to_id` learning's created_at (recency signal for newer-wins). */
  to_created_at: string;
  /** Cosine similarity of the normalized-fingerprint embeddings (same-topic band). */
  cosine: number;
  /** The deterministic opposition cue the pre-filter fired on (advisory for the LLM). */
  cue: string;
}

/** The LLM's verdict on one candidate pair. */
export type ContradictionVerdict =
  | 'newer_wins'
  | 'both_valid_scope'
  | 'evolved_merge'
  | 'not_a_contradiction';

/**
 * One validated contradiction resolution parsed from the LLM response. Only
 * ACTIONABLE verdicts (`newer_wins`/`both_valid_scope`/`evolved_merge`) yield a
 * proposal; `not_a_contradiction` (false positive) is dropped. `cosine` is
 * carried through from the candidate so the persist slot can gate the
 * auto_resolve fork.
 */
export interface ContradictionProposal {
  /** The LLM verdict that produced this proposal. */
  verdict: Exclude<ContradictionVerdict, 'not_a_contradiction'>;
  /** For newer_wins / evolved_merge — the learning that SURVIVES (the current/correct one). */
  winner_id?: number;
  /** For newer_wins / evolved_merge — the learning that is SUPERSEDED. */
  loser_id?: number;
  /** For both_valid_scope — the two learnings (sorted; both survive, each annotated). */
  learning_a_id?: number;
  learning_b_id?: number;
  /** For both_valid_scope — the scope annotation for learning_a / learning_b. */
  scope_a?: string;
  scope_b?: string;
  /** For evolved_merge only — the synthesized "evolved understanding" written onto the winner. */
  synthesized_content?: string;
  /** One concise sentence the operator reads. */
  justification: string;
  /** Calibrated confidence in [0, 0.85]. */
  confidence: number;
  /** The candidate pair's cosine — gates the auto_resolve fork. */
  cosine: number;
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
 * Resolve the arbiter instance config (FR-116 M2). Reads the additive
 * `cognition.janitor.contradiction` sub-block NESTED-ONLY. The `enabled` gate is
 * NOT read from the sub-block — it is DERIVED from `cognition.janitor.enabled`
 * (Decision #4A: one flag for the whole janitor + its co-scheduled instances, no
 * new flag, no new cron). Absent keys fall back to `DEFAULT_ARBITER_CONFIG`.
 *
 * @param config the parsed `~/.igris/config.json` object
 */
export function resolveArbiterConfig(
  config: Record<string, unknown> = {},
): ArbiterConfig {
  const cognition = asObject(config.cognition);
  const janitor = (cognition && asObject(cognition.janitor)) ?? {};
  const contradiction = asObject(janitor.contradiction) ?? {};
  // The gate is the janitor's single enabled flag (no new flag — Decision #4A).
  const enabled =
    janitor.enabled !== undefined
      ? (janitor.enabled as boolean)
      : DEFAULT_ARBITER_CONFIG.enabled;
  const pick = <T>(key: string, fallback: T): T => {
    if (contradiction[key] !== undefined) return contradiction[key] as T;
    return fallback;
  };
  return {
    enabled,
    llm_timeout_ms: pick('llm_timeout_ms', DEFAULT_ARBITER_CONFIG.llm_timeout_ms),
    llm_daily_budget: pick('llm_daily_budget', DEFAULT_ARBITER_CONFIG.llm_daily_budget),
    min_input_bytes: pick('min_input_bytes', DEFAULT_ARBITER_CONFIG.min_input_bytes),
    harness: pick('harness', DEFAULT_ARBITER_CONFIG.harness),
    contradiction_cosine_floor: pick(
      'contradiction_cosine_floor',
      DEFAULT_ARBITER_CONFIG.contradiction_cosine_floor,
    ),
    contradiction_cosine_ceil: pick(
      'contradiction_cosine_ceil',
      DEFAULT_ARBITER_CONFIG.contradiction_cosine_ceil,
    ),
    top_k: pick('top_k', DEFAULT_ARBITER_CONFIG.top_k),
    max_pairs: pick('max_pairs', DEFAULT_ARBITER_CONFIG.max_pairs),
    negation_cues: pick('negation_cues', DEFAULT_ARBITER_CONFIG.negation_cues),
    auto_resolve: pick('auto_resolve', DEFAULT_ARBITER_CONFIG.auto_resolve),
    auto_resolve_threshold: pick(
      'auto_resolve_threshold',
      DEFAULT_ARBITER_CONFIG.auto_resolve_threshold,
    ),
  };
}
