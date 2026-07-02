/**
 * Brain Engine v7.1 — Cognition instance: CARTOGRAPHER (FR-116 M4).
 *
 * The SEVENTH self-describing instance of the agnostic cognition host — built on
 * the SAME engine perception (M1) + subconscious (M2) + synapse (FR-211) +
 * janitor (FR-119) + arbiter (FR-116 M2) + curator (FR-116 M3) proved. Where the
 * janitor MERGES, the arbiter RESOLVES, and the curator PRUNES, the cartographer
 * MAPS: it runs the DETERMINISTIC community-detection primitive
 * (`edges/community.ts`) over the learning subgraph, assembles a digest of each
 * cluster's members, runs one brain-isolated LLM call to synthesize ONE
 * meta-learning per cluster, and QUEUES each for operator review by reusing the
 * `suggestions` channel (`source_module='cartographer'`,
 * `suggested_action.kind='cluster_meta'`). Approval flows through the shipped
 * `igris_suggestion_apply_action` → `applyClusterMeta` path (which creates the
 * meta-learning AND wires `cluster_member_of` edges member → meta).
 *
 * The three differing slots (FR-118):
 *   - INPUT  (`buildContext`):  `buildClusters(db, cfg)` → the deterministic
 *     community primitive's output, digested + filtered to approved members.
 *   - PROMPT (`promptBuilder`): the cartographer cluster-summary prompts.
 *   - OUTPUT (`persistCandidate`): INSERT into `suggestions`
 *     (`source_module='cartographer'`, `type_inferred=1`,
 *     `suggested_action={kind:'cluster_meta', cluster_member_ids, synthesized_summary,
 *     title}`) — OR, when `auto_fork`, a direct `applyClusterMeta(db, ...)`.
 *
 * ZERO-HOST-CHANGE (FR-202): a new instance is a new file + one barrel line. The
 * cartographer is NOT a separate component with its own flag/cron — it is
 * CO-SCHEDULED under the janitor runner (Decision #4A), but its `enabled` gate is
 * `cognition.janitor.enabled` AND the `cognition.janitor.cluster.enabled`
 * sub-toggle (DEFAULT OFF), with a `cadence_days` throttle in the runner because
 * the Leiden community pass is EXPENSIVE (§5-E).
 *
 * @module engine/components/cognition/extractors/cartographer
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import type {
  CognitionInstance,
  CognitionInstanceConfig,
  ExtractorArgs,
  ExtractorPrompt,
} from '../types.js';
import { buildClusters } from '../../cartographer/candidates.js';
import {
  buildCartographerSystemPrompt,
  buildCartographerUserPrompt,
} from '../../cartographer/prompts.js';
import {
  validateCartographerResponse,
  isCartographerResponseWellFormed,
} from '../../cartographer/validator.js';
import {
  DEFAULT_CARTOGRAPHER_CONFIG,
  type CartographerConfig,
  type ClusterMetaProposal,
  type LearningCluster,
} from '../../cartographer/types.js';
import { applyClusterMeta } from '../../subconscious/actions/kinds.js';

// ---------------------------------------------------------------------------
// The instance's private context shape (slot 1 output)
// ---------------------------------------------------------------------------

/**
 * The cartographer's private context — the detected clusters the LLM summarizes,
 * plus the framing the persist slot needs (the auto_fork flag, the digest byte
 * size for the cost gate, an in-run dedup set so two proposals for the same
 * cluster do not both persist, and the run id for undo-by-run). Opaque to the
 * engine; only `inputBytes(ctx)` exposes a size.
 */
export interface CartographerContext {
  /** The clusters the LLM reasons over. */
  clusters: LearningCluster[];
  /** The project scope ('all' = whole brain). */
  project: string;
  /** When true, a proposal is applied directly (create meta + wire edges). */
  autoFork: boolean;
  /** The candidate-digest size in UTF-8 bytes (the engine's cost-gate input). */
  clusters_bytes: number;
  /** In-run cluster signatures already persisted (prevents a double-persist). */
  persistedKeys: Set<string>;
  /** The maintenance run id — links auto-applied metas to `brain_maintenance_runs` for undo-by-run. */
  runId: string | null;
}

/**
 * Per-run counters the RUNNER reads back to aggregate the `brain_maintenance_runs`
 * audit row. `persistCandidate` increments `proposed` (review-gated suggestion) or
 * `meta_created` (auto_fork direct apply). `clusters_detected` is the number of
 * clusters the deterministic primitive surfaced this run (set by `buildContext`).
 */
export interface CartographerRunStats {
  /** Clusters the deterministic community primitive surfaced this run. */
  clusters_detected: number;
  /** Cluster-meta suggestions QUEUED for review this run. */
  proposed: number;
  /** Meta-learnings created DIRECTLY this run (auto_fork). */
  meta_created: number;
}

/** Injectable seams for the cartographer instance (tests inject stats). */
export interface CartographerInstanceDeps {
  /** Per-run counter accumulator the runner reads back (optional). */
  stats?: CartographerRunStats;
  /** The maintenance run id — threaded onto auto-applied undo entries (undo-by-run). */
  runId?: string | null;
}

// ---------------------------------------------------------------------------
// Config mapping (cartographer knobs → the engine's agnostic envelope)
// ---------------------------------------------------------------------------

/**
 * Map the cartographer config knobs onto the engine's per-instance
 * `CognitionInstanceConfig`. The clustering knobs (min size / resolution / cadence
 * / edge types / cap / auto_fork) are NOT part of the agnostic envelope — they
 * drive the instance's own slots.
 */
export function cartographerInstanceConfig(
  config: CartographerConfig = DEFAULT_CARTOGRAPHER_CONFIG,
): CognitionInstanceConfig {
  return {
    timeout_ms: config.llm_timeout_ms,
    daily_budget: config.llm_daily_budget,
    min_input_bytes: config.min_input_bytes,
    enabled: config.enabled,
    harness: config.harness as CognitionInstanceConfig['harness'],
  };
}

// ---------------------------------------------------------------------------
// Persist helper (slot 2 — OUTPUT: suggestions INSERT, or direct cluster_meta)
// ---------------------------------------------------------------------------

/** Pending-suggestion TTL (days) — mirrors the janitor/synapse/arbiter/curator default. */
const PENDING_TTL_DAYS = 30;

/** A stable signature for a cluster (its sorted member ids) — the in-run dedup key. */
function clusterKey(memberIds: number[]): string {
  return [...memberIds].sort((a, b) => a - b).join(',');
}

/**
 * Build the `suggested_action` payload for one proposal. This is the CONTRACT the
 * consumer (`applyClusterMeta`) reads — the two MUST stay byte-aligned (the
 * synapse↔add_edge / janitor↔merge_learnings / arbiter↔resolve_contradiction /
 * curator↔prune_learning lesson: a shape mismatch makes apply silently fall back
 * to flag_for_review).
 */
export function buildClusterMetaAction(
  proposal: ClusterMetaProposal,
): Record<string, unknown> {
  return {
    kind: 'cluster_meta',
    cluster_member_ids: proposal.cluster_member_ids,
    title: proposal.title,
    synthesized_summary: proposal.synthesized_summary,
    confidence: proposal.confidence,
  };
}

/**
 * Persist one cluster-meta proposal. Default (review-gated) path INSERTs a
 * `suggestions` row with `source_module='cartographer'`, `type_inferred=1`, and
 * the `suggested_action` built by `buildClusterMetaAction` — the EXACT shape
 * `applyClusterMeta` reads when the operator later applies it. The `auto_fork`
 * path SKIPS the suggestion and applies directly (creating the meta-learning +
 * wiring the `cluster_member_of` edges).
 *
 * In-run deduped by cluster signature. Returns 'proposed' | 'created' | 'deduped'.
 */
export function persistCartographerProposal(
  db: Database.Database,
  proposal: ClusterMetaProposal,
  ctx: CartographerContext,
  stats?: CartographerRunStats,
): 'proposed' | 'created' | 'deduped' {
  const key = clusterKey(proposal.cluster_member_ids);
  if (ctx.persistedKeys.has(key)) return 'deduped';
  ctx.persistedKeys.add(key);

  const action = buildClusterMetaAction(proposal);

  // AUTO-FORK: create the meta-learning + wire edges directly (default OFF).
  if (ctx.autoFork) {
    const result = applyClusterMeta(db, action, ctx.runId);
    if (result.ok) {
      if (stats) stats.meta_created += 1;
      return 'created';
    }
    // A failed direct apply is not fatal — fall through to review-gating.
  }

  const evidence = {
    cluster_member_ids: proposal.cluster_member_ids,
    member_count: proposal.cluster_member_ids.length,
    reason: 'graph-cluster meta-learning candidate',
  };
  const title = `Meta-learning for cluster of ${proposal.cluster_member_ids.length} learnings`;

  db.prepare(
    `INSERT INTO suggestions
       (source_module, project_slug, title, evidence, priority, status,
        created_at, expires_at, confidence, suggested_action, type_inferred)
     VALUES ('cartographer', NULL, ?, ?, 'low', 'pending', datetime('now'),
             datetime('now', ?), ?, ?, 1)`,
  ).run(
    title,
    JSON.stringify(evidence),
    `+${PENDING_TTL_DAYS} days`,
    proposal.confidence,
    JSON.stringify(action),
  );
  if (stats) stats.proposed += 1;
  return 'proposed';
}

// ---------------------------------------------------------------------------
// The instance factory
// ---------------------------------------------------------------------------

/**
 * Build the cartographer cluster-summary cognition instance for a resolved
 * cartographer config. Like the other instances, `persistCandidate(db, candidate)`
 * receives no per-run context, so the instance stashes the context built this run
 * in a closure cell (`currentCtx`) that `persistCandidate` reads. Safe because the
 * engine runs ONE instance sequentially (build → parse → persist loop); a fresh
 * instance is built per component-run path (the runner).
 *
 * `deps.stats` (optional) is threaded so the runner can aggregate the
 * `brain_maintenance_runs` counters (`clusters_detected` / `meta_learnings_created`).
 */
export function createCartographerInstance(
  config: CartographerConfig = DEFAULT_CARTOGRAPHER_CONFIG,
  deps: CartographerInstanceDeps = {},
): CognitionInstance<CartographerContext, ClusterMetaProposal> {
  let currentCtx: CartographerContext | null = null;

  const emptyCtx = (): CartographerContext => ({
    clusters: [],
    project: 'all',
    autoFork: config.auto_fork,
    clusters_bytes: 0,
    persistedKeys: new Set<string>(),
    runId: deps.runId ?? null,
  });

  return {
    id: 'cartographer',

    async buildContext(
      db: Database.Database,
      args: ExtractorArgs,
    ): Promise<CartographerContext> {
      const project =
        typeof args.project === 'string' && args.project.length > 0 ? args.project : 'all';
      const clusters = buildClusters(db, config);
      const clusters_bytes = Buffer.byteLength(JSON.stringify(clusters), 'utf8');
      if (deps.stats) deps.stats.clusters_detected = clusters.length;
      const ctx: CartographerContext = {
        clusters,
        project,
        autoFork: config.auto_fork,
        clusters_bytes,
        persistedKeys: new Set<string>(),
        runId: deps.runId ?? null,
      };
      currentCtx = ctx;
      return ctx;
    },

    promptBuilder(ctx: CartographerContext): ExtractorPrompt {
      return {
        system: buildCartographerSystemPrompt(),
        user: buildCartographerUserPrompt(ctx.clusters),
      };
    },

    parseResponse(raw: string, ctx: CartographerContext): ClusterMetaProposal[] {
      const clusters = ctx?.clusters ?? currentCtx?.clusters ?? [];
      return validateCartographerResponse(raw, clusters);
    },

    // TD-294 — a well-formed (possibly empty) array is a VALID EMPTY judgment
    // ("no clusters worth summarizing"), not a parse_error. Consulted only on zero parse.
    isMalformedResponse: (raw) => !isCartographerResponseWellFormed(raw),

    async persistCandidate(
      db: Database.Database,
      proposal: ClusterMetaProposal,
    ): Promise<void> {
      const ctx = currentCtx ?? emptyCtx();
      persistCartographerProposal(db, proposal, ctx, deps.stats);
    },

    config: cartographerInstanceConfig(config),

    inputBytes(ctx: CartographerContext): number {
      return ctx.clusters_bytes;
    },

    isEmptyContext(ctx: CartographerContext): boolean {
      return ctx.clusters.length === 0;
    },
  };
}

/**
 * The default-config cartographer instance registered by the barrel. Production
 * resolves the live config at component init and rebinds (via the runner); the
 * barrel export gives the OPEN registry a discoverable instance (the FR-202
 * zero-host-change property) and the engine a runnable default.
 */
export const cartographerInstance: CognitionInstance<
  CartographerContext,
  ClusterMetaProposal
> = createCartographerInstance();
