/**
 * Brain Engine v7.1 — Cognition instance: CURATOR (FR-116 M3).
 *
 * The SIXTH self-describing instance of the agnostic cognition host — built on
 * the SAME engine perception (M1) + subconscious (M2) + synapse (FR-211) +
 * janitor (FR-119) + arbiter (FR-116 M2) proved. Where the janitor MERGES
 * near-duplicates and the arbiter RESOLVES contradictions, the curator PRUNES
 * OUTDATED KNOWLEDGE: it reads a cheap DETERMINISTIC staleness digest (approved
 * learnings that are old + unused, or carry a deprecated-tech tag), runs one
 * brain-isolated LLM call to judge keep / lower_confidence / prune, and QUEUES
 * each proposed outcome for operator review by reusing the existing `suggestions`
 * channel (`source_module='curator'`, `suggested_action.kind='prune_learning'`).
 * Approval flows through the already-shipped `igris_suggestion_apply_action` →
 * `applyPruneLearning` path.
 *
 * The three differing slots (FR-118):
 *   - INPUT  (`buildContext`):  `buildStaleCandidates(db, cfg)` → the
 *     deterministic staleness detector's output (a bounded, pure digest).
 *   - PROMPT (`promptBuilder`): the curator keep/lower/prune prompts.
 *   - OUTPUT (`persistCandidate`): INSERT into `suggestions`
 *     (`source_module='curator'`, `type_inferred=1`, `suggested_action={kind:
 *     'prune_learning', verdict, ...}`) — OR, when `auto_prune` AND the verdict is
 *     `prune`, a direct `applyPruneLearning(db, ...)`, GUARDED by the anomaly
 *     safety valve (never auto-prune beyond `anomaly_threshold` in one run).
 *
 * ZERO-HOST-CHANGE (FR-202): a new instance is a new file + one barrel line. The
 * curator is NOT a separate component with its own flag/cron — it is
 * CO-SCHEDULED under the janitor runner (Decision #4A), riding the single
 * `cognition.janitor.enabled` flag + `janitor_engine` cron + shared audit row.
 *
 * R-OVER-ABSTRACT guard: the curator's quirks — the staleness policy, the
 * auto_prune fork, the anomaly guard — live HERE, in the instance slots + config,
 * NOT in the agnostic engine.
 *
 * @module engine/components/cognition/extractors/curator
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import type {
  CognitionInstance,
  CognitionInstanceConfig,
  ExtractorArgs,
  ExtractorPrompt,
} from '../types.js';
import { buildStaleCandidates } from '../../curator/candidates.js';
import {
  buildCuratorSystemPrompt,
  buildCuratorUserPrompt,
} from '../../curator/prompts.js';
import { validateCuratorResponse } from '../../curator/validator.js';
import {
  DEFAULT_CURATOR_CONFIG,
  type CuratorConfig,
  type PruneProposal,
  type StaleCandidate,
} from '../../curator/types.js';
import { applyPruneLearning } from '../../subconscious/actions/kinds.js';

// ---------------------------------------------------------------------------
// The instance's private context shape (slot 1 output)
// ---------------------------------------------------------------------------

/**
 * The curator's private context — the stale candidates the LLM judges, plus the
 * framing the persist slot needs (the auto_prune fork, the anomaly threshold, the
 * digest byte size for the cost gate, and an in-run dedup set so two proposals
 * for the same learning do not both persist). Opaque to the engine; only
 * `inputBytes(ctx)` exposes a size.
 */
export interface CuratorContext {
  /** The stale candidates the LLM reasons over. */
  candidates: StaleCandidate[];
  /** The project scope ('all' = whole brain). */
  project: string;
  /** When true, a `prune` verdict is applied directly (bounded by the anomaly guard). */
  autoPrune: boolean;
  /** The per-run anomaly ceiling — the auto fork refuses to prune beyond this. */
  anomalyThreshold: number;
  /** The candidate-digest size in UTF-8 bytes (the engine's cost-gate input). */
  candidates_bytes: number;
  /** In-run learning ids already persisted (prevents a double-persist). */
  persistedIds: Set<number>;
  /** The maintenance run id — links auto-pruned rows to `brain_maintenance_runs` for undo-by-run. */
  runId: string | null;
}

/**
 * Per-run counters the RUNNER reads back to aggregate the `brain_maintenance_runs`
 * audit row + surface the anomaly warning. `persistCandidate` increments
 * `proposed` (review-gated suggestion) or `pruned` (auto_prune direct apply), and
 * tallies `prune_intent` (every prune verdict, queued or applied) → sets
 * `anomaly` when it exceeds the threshold. Passed by reference into the instance
 * factory; the default-config barrel export omits it.
 */
export interface CuratorRunStats {
  /** Outcomes QUEUED for review this run (any verdict). */
  proposed: number;
  /** `prune` verdicts applied DIRECTLY this run (auto_prune fork). */
  pruned: number;
  /** Total `prune` verdicts seen this run (queued + applied) — the anomaly signal. */
  prune_intent: number;
  /** True when `prune_intent` exceeded the anomaly threshold this run. */
  anomaly: boolean;
}

/** Injectable seams for the curator instance (tests inject stats). */
export interface CuratorInstanceDeps {
  /** Per-run counter accumulator the runner reads back (optional). */
  stats?: CuratorRunStats;
  /** The maintenance run id — threaded onto auto-pruned undo entries (undo-by-run). */
  runId?: string | null;
}

// ---------------------------------------------------------------------------
// Config mapping (curator knobs → the engine's agnostic envelope)
// ---------------------------------------------------------------------------

/**
 * Map the curator config knobs onto the engine's per-instance
 * `CognitionInstanceConfig`. The staleness knobs (window / access threshold /
 * deprecated tags / cap / auto_prune / anomaly threshold) are NOT part of the
 * agnostic envelope — they drive the instance's own slots.
 */
export function curatorInstanceConfig(
  config: CuratorConfig = DEFAULT_CURATOR_CONFIG,
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
// Persist helper (slot 2 — OUTPUT: suggestions INSERT, or direct prune)
// ---------------------------------------------------------------------------

/** Pending-suggestion TTL (days) — mirrors the janitor/synapse/arbiter default. */
const PENDING_TTL_DAYS = 30;

/**
 * Build the `suggested_action` payload for one proposal. This is the CONTRACT the
 * consumer (`applyPruneLearning`) reads — the two MUST stay byte-aligned (the
 * synapse↔add_edge / janitor↔merge_learnings / arbiter↔resolve_contradiction
 * lesson: a shape mismatch makes apply silently fall back to flag_for_review).
 * `verdict` is the discriminator.
 */
export function buildPruneLearningAction(
  proposal: PruneProposal,
): Record<string, unknown> {
  const justification =
    proposal.justification.length > 0 ? { justification: proposal.justification } : {};
  if (proposal.verdict === 'lower_confidence') {
    return {
      kind: 'prune_learning',
      verdict: 'lower_confidence',
      learning_id: proposal.learning_id,
      confidence_delta: proposal.confidence_delta,
      ...justification,
    };
  }
  return {
    kind: 'prune_learning',
    verdict: proposal.verdict, // 'keep' | 'prune'
    learning_id: proposal.learning_id,
    ...justification,
  };
}

/**
 * Persist one prune proposal. Default (review-gated) path INSERTs a `suggestions`
 * row with `source_module='curator'`, `type_inferred=1`, and the
 * `suggested_action` built by `buildPruneLearningAction` — the EXACT shape
 * `applyPruneLearning` reads when the operator later applies it. The `auto_prune`
 * path SKIPS the suggestion and applies a `prune` verdict directly — but the
 * ANOMALY GUARD refuses to auto-apply beyond `anomalyThreshold` prunes in one run
 * (excess prunes fall back to review). `keep`/`lower_confidence` are always
 * review-gated (only the destructive verdict has an auto fork, mirroring
 * auto_merge/auto_resolve).
 *
 * In-run deduped by learning id. Returns 'proposed' | 'pruned' | 'deduped'.
 */
export function persistCuratorProposal(
  db: Database.Database,
  proposal: PruneProposal,
  ctx: CuratorContext,
  stats?: CuratorRunStats,
): 'proposed' | 'pruned' | 'deduped' {
  const id = proposal.learning_id;
  if (ctx.persistedIds.has(id)) return 'deduped';
  ctx.persistedIds.add(id);

  const action = buildPruneLearningAction(proposal);

  if (proposal.verdict === 'prune') {
    if (stats) {
      stats.prune_intent += 1;
      if (stats.prune_intent > ctx.anomalyThreshold) stats.anomaly = true;
    }
    // AUTO-PRUNE fork: gated by the config flag AND the anomaly safety valve —
    // never auto-apply beyond `anomalyThreshold` prunes in one run.
    const appliedSoFar = stats?.pruned ?? 0;
    if (ctx.autoPrune && appliedSoFar < ctx.anomalyThreshold) {
      const result = applyPruneLearning(db, action, ctx.runId);
      if (result.ok) {
        if (stats) stats.pruned += 1;
        return 'pruned';
      }
      // A failed direct prune is not fatal — fall through to review-gating.
    }
  }

  const evidence = {
    verdict: proposal.verdict,
    learning_id: id,
    reason: 'outdated-knowledge candidate',
    ...(proposal.confidence_delta !== undefined
      ? { confidence_delta: proposal.confidence_delta }
      : {}),
    ...(proposal.justification ? { justification: proposal.justification } : {}),
  };
  const title = `Review outdated learning ${id} (${proposal.verdict})`;

  db.prepare(
    `INSERT INTO suggestions
       (source_module, project_slug, title, evidence, priority, status,
        created_at, expires_at, confidence, suggested_action, type_inferred)
     VALUES ('curator', NULL, ?, ?, 'low', 'pending', datetime('now'),
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
 * Build the curator outdated-pruning cognition instance for a resolved curator
 * config. Like perception/subconscious/synapse/janitor/arbiter,
 * `persistCandidate(db, candidate)` receives no per-run context, so the instance
 * stashes the context built this run in a closure cell (`currentCtx`) that
 * `persistCandidate` reads. Safe because the engine runs ONE instance
 * sequentially (build → parse → persist loop); a fresh instance is built per
 * component-run path (the runner).
 *
 * `deps.stats` (optional) is threaded so the runner can aggregate the
 * `brain_maintenance_runs` counters + surface the anomaly warning.
 */
export function createCuratorInstance(
  config: CuratorConfig = DEFAULT_CURATOR_CONFIG,
  deps: CuratorInstanceDeps = {},
): CognitionInstance<CuratorContext, PruneProposal> {
  let currentCtx: CuratorContext | null = null;

  const emptyCtx = (): CuratorContext => ({
    candidates: [],
    project: 'all',
    autoPrune: config.auto_prune,
    anomalyThreshold: config.anomaly_threshold,
    candidates_bytes: 0,
    persistedIds: new Set<number>(),
    runId: deps.runId ?? null,
  });

  return {
    id: 'curator',

    async buildContext(
      db: Database.Database,
      args: ExtractorArgs,
    ): Promise<CuratorContext> {
      const project =
        typeof args.project === 'string' && args.project.length > 0 ? args.project : 'all';
      const candidates = buildStaleCandidates(db, config);
      const candidates_bytes = Buffer.byteLength(JSON.stringify(candidates), 'utf8');
      const ctx: CuratorContext = {
        candidates,
        project,
        autoPrune: config.auto_prune,
        anomalyThreshold: config.anomaly_threshold,
        candidates_bytes,
        persistedIds: new Set<number>(),
        runId: deps.runId ?? null,
      };
      currentCtx = ctx;
      return ctx;
    },

    promptBuilder(ctx: CuratorContext): ExtractorPrompt {
      return {
        system: buildCuratorSystemPrompt(),
        user: buildCuratorUserPrompt(ctx.candidates),
      };
    },

    parseResponse(raw: string, ctx: CuratorContext): PruneProposal[] {
      const candidates = ctx?.candidates ?? currentCtx?.candidates ?? [];
      return validateCuratorResponse(raw, candidates);
    },

    async persistCandidate(
      db: Database.Database,
      proposal: PruneProposal,
    ): Promise<void> {
      const ctx = currentCtx ?? emptyCtx();
      persistCuratorProposal(db, proposal, ctx, deps.stats);
    },

    config: curatorInstanceConfig(config),

    inputBytes(ctx: CuratorContext): number {
      return ctx.candidates_bytes;
    },

    isEmptyContext(ctx: CuratorContext): boolean {
      return ctx.candidates.length === 0;
    },
  };
}

/**
 * The default-config curator instance registered by the barrel. Production
 * resolves the live config at component init and rebinds (via the runner); the
 * barrel export gives the OPEN registry a discoverable instance (the FR-202
 * zero-host-change property) and the engine a runnable default.
 */
export const curatorInstance: CognitionInstance<CuratorContext, PruneProposal> =
  createCuratorInstance();
