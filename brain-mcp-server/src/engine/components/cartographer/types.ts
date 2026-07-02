/**
 * Brain Engine v7.1 — Cartographer component types (FR-116 M4).
 *
 * The SEVENTH self-describing cognition instance ("cartographer") SUMMARIZES
 * CLUSTERS of related learnings into meta-learnings. Where the janitor MERGES
 * near-duplicates (FR-119), the arbiter RESOLVES contradictions (FR-116 M2), and
 * the curator PRUNES outdated knowledge (FR-116 M3), the cartographer MAPS the
 * memory graph: it runs the DETERMINISTIC community-detection primitive
 * (`edges/community.ts`) over the learning subgraph, assembles a digest of each
 * cluster's members, and asks one brain-isolated LLM call to synthesize ONE
 * meta-learning per cluster. Each proposed meta is QUEUED for operator review via
 * the existing `suggestions` channel (`source_module='cartographer'`,
 * `suggested_action.kind='cluster_meta'`). Approval flows through the shipped
 * `igris_suggestion_apply_action` → `applyClusterMeta` path, which creates the
 * meta-learning AND writes `cluster_member_of` edges member → meta.
 *
 * It differs from the other instances in EVERY differing slot:
 *   - CANDIDATE SIGNAL: DETERMINISTIC graph community detection (Louvain over
 *     `entity_edges`), NOT near-duplication / opposition / staleness. Read-only.
 *   - PROMPT: "summarize this cluster into ONE meta-learning".
 *   - OUTPUT VERB: `cluster_meta` (create a synthesized meta-learning + wire
 *     `cluster_member_of` edges), NOT merge / resolve / prune.
 *
 * CO-SCHEDULE (Decision #4A) with a TWIST (Decision from §5-E — Leiden is
 * EXPENSIVE): the cartographer is CO-SCHEDULED under the janitor runner (no new
 * component / cron), but its `enabled` gate is `cognition.janitor.enabled` AND an
 * additional `cognition.janitor.cluster.enabled` sub-toggle (DEFAULT OFF), plus a
 * `cadence_days` throttle so the expensive community pass does not run every day.
 * Its tuning lives in the additive `cognition.janitor.cluster.*` sub-block.
 *
 * @module engine/components/cartographer/types
 * @author fifty.dev
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The default learning subgraph edge types the community primitive clusters over.
 * These connect DISTINCT learnings semantically. `cluster_member_of` is
 * deliberately EXCLUDED (it would feed the cartographer's own output back in),
 * and `recurs_with` is excluded (it is a self-relation, not a between-learnings
 * signal). Configurable via `cognition.janitor.cluster.cluster_edge_types`.
 */
export const DEFAULT_CLUSTER_EDGE_TYPES: readonly string[] = [
  'related_to',
  'derived_from',
  'duplicates',
];

/**
 * The cartographer cognition-instance config (FR-116 M4). The first five keys map
 * onto the engine's agnostic `CognitionInstanceConfig` (timeout/budget/min-bytes/
 * enabled/harness); the rest are cartographer-specific clustering + persistence
 * knobs kept HERE (not in the engine) per the R-OVER-ABSTRACT discipline.
 *
 * `enabled` is DERIVED from `cognition.janitor.enabled` AND the
 * `cognition.janitor.cluster.enabled` sub-toggle (Decision #4A + the Leiden-is-
 * expensive gate — BOTH must be true; the sub-toggle DEFAULTS OFF).
 */
export interface CartographerConfig {
  /** Master switch — `cognition.janitor.enabled` AND the `cluster.enabled` sub-toggle (default OFF). */
  enabled: boolean;
  /** Hard wall-clock budget for the LLM subprocess (ms). */
  llm_timeout_ms: number;
  /** Max cartographer `run_started` rows allowed per UTC day (its own per-instance budget). */
  llm_daily_budget: number;
  /** Minimum candidate-digest size (UTF-8 bytes) below which the run is skipped (cost gate). */
  min_input_bytes: number;
  /** Per-instance harness override. `null` = inherit the global `llm_extractor.harness`. */
  harness: string | null;
  /** Minimum members a cluster must have to be summarized (Leiden singleton/small-cluster floor). Default 3. */
  min_cluster_size: number;
  /** Louvain modularity resolution γ (>1 = more, smaller communities). Default 1.0. */
  resolution: number;
  /**
   * CADENCE throttle (days) — the EXPENSIVE community pass is skipped if the last
   * SUCCESSFUL cartographer run was within this many days. 0 disables the throttle
   * (run every janitor invocation). Default 7.
   */
  cadence_days: number;
  /** Hard cap on clusters summarized per run (bounds LLM cost). Default 20. */
  max_clusters: number;
  /** The learning-subgraph edge types the community primitive clusters over. */
  cluster_edge_types: readonly string[];
  /**
   * When true, `persistCandidate` SKIPS the review suggestion and applies the
   * `cluster_meta` DIRECTLY via `applyClusterMeta` (creating the meta-learning +
   * wiring the `cluster_member_of` edges). Default false = always review-gated
   * (creating a meta-learning + edges is a structural change).
   */
  auto_fork: boolean;
}

/**
 * Cartographer instance defaults (FR-116 M4). `enabled: false` mirrors the other
 * cognition instances. The envelope defaults match the janitor/arbiter/curator
 * (shared cron/discipline). `min_cluster_size: 3` + `resolution: 1.0` are the
 * operator-confirmed clustering defaults; `cadence_days: 7` throttles the
 * expensive Leiden pass; `auto_fork: false` keeps meta creation review-gated.
 */
export const DEFAULT_CARTOGRAPHER_CONFIG: CartographerConfig = {
  enabled: false,
  llm_timeout_ms: 300_000,
  llm_daily_budget: 8,
  min_input_bytes: 100,
  harness: null,
  min_cluster_size: 3,
  resolution: 1.0,
  cadence_days: 7,
  max_clusters: 20,
  cluster_edge_types: DEFAULT_CLUSTER_EDGE_TYPES,
  auto_fork: false,
};

// ---------------------------------------------------------------------------
// Candidate + proposal shapes
// ---------------------------------------------------------------------------

/** One member of a detected cluster, with the digest the LLM reads. */
export interface ClusterMember {
  id: number;
  title: string;
  snippet: string;
}

/**
 * One detected learning cluster, produced by the DETERMINISTIC community primitive
 * (`edges/community.ts:detectCommunities`) then filtered to APPROVED, recallable
 * members. `cluster_index` is the stable position in the run's cluster list (the
 * LLM cites it); `member_ids` are sorted ascending.
 */
export interface LearningCluster {
  /** Stable index into the run's cluster list — the LLM's cite key. */
  cluster_index: number;
  /** The cluster's member learning ids (sorted ascending). */
  member_ids: number[];
  /** The member digests the LLM summarizes. */
  members: ClusterMember[];
}

/**
 * One validated cluster-meta proposal parsed from the LLM response. `cite-checked`
 * against the run's clusters (a proposal citing an out-of-range cluster_index is
 * dropped). `synthesized_summary` is the one-meta-learning body; `title` is a
 * short label; `confidence` is clamped to [0, 0.85].
 */
export interface ClusterMetaProposal {
  /** The member ids the meta-learning summarizes (resolved from the cited cluster). */
  cluster_member_ids: number[];
  /** The synthesized meta-learning title. */
  title: string;
  /** The synthesized meta-learning body. */
  synthesized_summary: string;
  /** Calibrated confidence in [0, 0.85]. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Config resolution (nested-only, gated by cognition.janitor.enabled + sub-toggle)
// ---------------------------------------------------------------------------

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Resolve the cartographer instance config (FR-116 M4). Reads the additive
 * `cognition.janitor.cluster` sub-block NESTED-ONLY. UNLIKE the arbiter/curator
 * (whose `enabled` derives from `cognition.janitor.enabled` alone), the
 * cartographer's `enabled` is `janitor.enabled` AND the `cluster.enabled`
 * sub-toggle (DEFAULT OFF) — the extra gate because the Leiden community pass is
 * expensive (Decision from §5-E). Absent keys fall back to
 * `DEFAULT_CARTOGRAPHER_CONFIG`.
 *
 * @param config the parsed `~/.igris/config.json` object
 */
export function resolveCartographerConfig(
  config: Record<string, unknown> = {},
): CartographerConfig {
  const cognition = asObject(config.cognition);
  const janitor = (cognition && asObject(cognition.janitor)) ?? {};
  const cluster = asObject(janitor.cluster) ?? {};
  // Two gates: the janitor master flag AND the cluster sub-toggle (default OFF).
  const janitorEnabled =
    janitor.enabled !== undefined ? (janitor.enabled as boolean) : false;
  const clusterEnabled =
    cluster.enabled !== undefined
      ? (cluster.enabled as boolean)
      : DEFAULT_CARTOGRAPHER_CONFIG.enabled;
  const pick = <T>(key: string, fallback: T): T => {
    if (cluster[key] !== undefined) return cluster[key] as T;
    return fallback;
  };
  return {
    enabled: janitorEnabled && clusterEnabled,
    llm_timeout_ms: pick('llm_timeout_ms', DEFAULT_CARTOGRAPHER_CONFIG.llm_timeout_ms),
    llm_daily_budget: pick('llm_daily_budget', DEFAULT_CARTOGRAPHER_CONFIG.llm_daily_budget),
    min_input_bytes: pick('min_input_bytes', DEFAULT_CARTOGRAPHER_CONFIG.min_input_bytes),
    harness: pick('harness', DEFAULT_CARTOGRAPHER_CONFIG.harness),
    min_cluster_size: pick('min_cluster_size', DEFAULT_CARTOGRAPHER_CONFIG.min_cluster_size),
    resolution: pick('resolution', DEFAULT_CARTOGRAPHER_CONFIG.resolution),
    cadence_days: pick('cadence_days', DEFAULT_CARTOGRAPHER_CONFIG.cadence_days),
    max_clusters: pick('max_clusters', DEFAULT_CARTOGRAPHER_CONFIG.max_clusters),
    cluster_edge_types: pick('cluster_edge_types', DEFAULT_CARTOGRAPHER_CONFIG.cluster_edge_types),
    auto_fork: pick('auto_fork', DEFAULT_CARTOGRAPHER_CONFIG.auto_fork),
  };
}
