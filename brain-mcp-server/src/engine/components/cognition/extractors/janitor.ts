/**
 * Brain Engine v7.1 — Cognition instance: JANITOR (FR-119).
 *
 * The FOURTH self-describing instance of the agnostic cognition host — built on
 * the SAME engine perception (M1) + subconscious (M2) + synapse (FR-211) proved.
 * It cleans WITHIN the memory layer by proposing near-duplicate MERGES: it reads
 * a cheap deterministic candidate-pair digest (embedding-KNN over the NORMALIZED
 * fingerprint, ≥ 0.95 cosine), runs one brain-isolated LLM call to judge
 * keep/merge/false-positive, and QUEUES each proposed merge for operator review
 * by reusing the existing `suggestions` channel (`source_module='janitor'`,
 * `suggested_action.kind='merge_learnings'`). Approval flows through the
 * already-shipped `igris_suggestion_apply_action` → `applyMergeLearnings` path.
 *
 * The three differing slots (FR-118):
 *   - INPUT  (`buildContext`):  `buildDuplicatePairs(db, cfg)` → a bounded, pure
 *     digest of near-dupe learning↔learning candidate pairs (normalized-embed
 *     KNN, minus pairs already pending a janitor merge suggestion).
 *   - PROMPT (`promptBuilder`): the janitor merge-judgment system + user prompts.
 *   - OUTPUT (`persistCandidate`): INSERT into `suggestions`
 *     (`source_module='janitor'`, `type_inferred=1`, `suggested_action={kind:
 *     'merge_learnings', survivor_id, duplicate_id, synthesized_content?,
 *     justification}`) — OR, when `auto_merge` AND cosine ≥ threshold, a direct
 *     `applyMergeLearnings(db, ...)`.
 *
 * The three DETERMINISTIC hygiene duties (TD-086 confidence bumps, stale-pending
 * rejection, dormant re-eval-of-rejection) are NOT here — they need no LLM and
 * live in the janitor RUNNER's sweep (`components/janitor/hygiene.ts`). This
 * instance is ONLY the near-dupe MERGE extractor (Decision E).
 *
 * R-OVER-ABSTRACT guard: the janitor's quirks — the near-dupe pre-filter, the
 * cosine floor, the auto_merge fork — live HERE, in the instance slots + config,
 * NOT in the agnostic engine. The engine still knows nothing about dedup (AC #1).
 *
 * @module engine/components/cognition/extractors/janitor
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import type {
  CognitionInstance,
  CognitionInstanceConfig,
  ExtractorArgs,
  ExtractorPrompt,
} from '../types.js';
import { buildDuplicatePairs } from '../../janitor/candidates.js';
import type { Embedder } from '../../janitor/candidates.js';
import {
  buildJanitorSystemPrompt,
  buildJanitorUserPrompt,
} from '../../janitor/prompts.js';
import {
  validateJanitorResponse,
  isJanitorResponseWellFormed,
} from '../../janitor/validator.js';
import {
  DEFAULT_JANITOR_CONFIG,
  type DuplicatePair,
  type JanitorConfig,
  type MergeProposal,
} from '../../janitor/types.js';
import { applyMergeLearnings } from '../../subconscious/actions/kinds.js';

// ---------------------------------------------------------------------------
// The instance's private context shape (slot 1 output)
// ---------------------------------------------------------------------------

/**
 * The janitor's private context — the candidate pairs the LLM judges, plus the
 * framing the persist slot needs (the auto_merge fork + threshold, the digest
 * byte size for the cost gate, and an in-run dedup set so two proposals for the
 * same pair do not both persist). Opaque to the engine; only `inputBytes(ctx)`
 * exposes a size.
 */
export interface JanitorContext {
  /** The near-dupe candidate pairs the LLM reasons over. */
  pairs: DuplicatePair[];
  /** The project scope ('all' = whole brain). */
  project: string;
  /** Decision B — when true, persist applies the merge directly (gated by cosine). */
  autoMerge: boolean;
  /** Cosine at or above which the auto_merge fork may merge without review. */
  autoMergeThreshold: number;
  /** The candidate-digest size in UTF-8 bytes (the engine's cost-gate input). */
  pairs_bytes: number;
  /** In-run sorted-pair keys already persisted (prevents a double-persist). */
  persistedPairs: Set<string>;
}

/**
 * Per-run counters the RUNNER reads back to aggregate the `brain_maintenance_runs`
 * audit row. `persistCandidate` increments `proposed` (review-gated suggestion)
 * or `applied` (auto_merge direct merge). Passed by reference into the instance
 * factory; the default-config barrel export omits it.
 */
export interface JanitorRunStats {
  /** Merge suggestions QUEUED for review this run. */
  proposed: number;
  /** Merges applied DIRECTLY this run (auto_merge fork). */
  applied: number;
}

/** Injectable seams for the janitor instance (tests inject a deterministic embedder). */
export interface JanitorInstanceDeps {
  /** Embed the normalized fingerprint. Default: the shipped `generateEmbedding`. */
  embed?: Embedder;
  /** Per-run counter accumulator the runner reads back (optional). */
  stats?: JanitorRunStats;
}

// ---------------------------------------------------------------------------
// Config mapping (janitor knobs → the engine's agnostic envelope)
// ---------------------------------------------------------------------------

/**
 * Map the janitor config knobs onto the engine's per-instance
 * `CognitionInstanceConfig`. The candidate/hygiene knobs (dupe_cosine_floor/
 * dupe_min_overlap/top_k/max_pairs/auto_merge/thresholds/N-values) are NOT part of the agnostic
 * envelope — they drive the instance's own slots + the runner's sweep.
 */
export function janitorInstanceConfig(
  config: JanitorConfig = DEFAULT_JANITOR_CONFIG,
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
// Persist helper (slot 2 — OUTPUT: suggestions INSERT, or direct merge)
// ---------------------------------------------------------------------------

/** Pending-suggestion TTL (days) — mirrors the subconscious/synapse default. */
const PENDING_TTL_DAYS = 30;

/** Unordered pair key — matches the candidate generator's `${min}:${max}`. */
function sortedKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Persist one merge proposal. Default (review-gated) path INSERTs a `suggestions`
 * row with `source_module='janitor'`, `type_inferred=1`, and a
 * `suggested_action={kind:'merge_learnings', survivor_id, duplicate_id,
 * synthesized_content?, justification}` — the EXACT shape `applyMergeLearnings`
 * reads when the operator later applies it (producer/consumer aligned, the
 * synapse↔add_edge lesson). The `auto_merge` path (Decision B) SKIPS the
 * suggestion and applies the merge directly via `applyMergeLearnings`, but ONLY
 * when the pair's cosine ≥ `autoMergeThreshold`.
 *
 * In-run deduped by the sorted pair key so two proposals for the same pair do
 * not both persist. Returns 'proposed' | 'applied' | 'deduped'.
 */
export function persistJanitorProposal(
  db: Database.Database,
  proposal: MergeProposal,
  ctx: JanitorContext,
): 'proposed' | 'applied' | 'deduped' {
  const key = sortedKey(proposal.survivor_id, proposal.duplicate_id);
  if (ctx.persistedPairs.has(key)) return 'deduped';
  ctx.persistedPairs.add(key);

  const justification = proposal.justification.length > 0 ? proposal.justification : undefined;

  // AUTO-MERGE fork (Decision B): gated by the config flag AND the cosine floor.
  if (ctx.autoMerge && proposal.cosine >= ctx.autoMergeThreshold) {
    const result = applyMergeLearnings(db, {
      survivor_id: proposal.survivor_id,
      duplicate_id: proposal.duplicate_id,
      ...(proposal.synthesized_content ? { synthesized_content: proposal.synthesized_content } : {}),
      ...(justification ? { justification } : {}),
    });
    // A failed direct merge is not fatal — it simply does not count as applied
    // (the engine's persist loop tolerates per-candidate outcomes).
    return result.ok ? 'applied' : 'deduped';
  }

  const suggestedAction = {
    kind: 'merge_learnings',
    survivor_id: proposal.survivor_id,
    duplicate_id: proposal.duplicate_id,
    ...(proposal.synthesized_content ? { synthesized_content: proposal.synthesized_content } : {}),
    ...(justification ? { justification } : {}),
  };
  const evidence = {
    survivor_id: proposal.survivor_id,
    duplicate_id: proposal.duplicate_id,
    verdict: proposal.verdict,
    cosine: proposal.cosine,
    ...(justification ? { justification } : {}),
  };
  const title = `Merge near-duplicate learning ${proposal.duplicate_id} into ${proposal.survivor_id}`;

  db.prepare(
    `INSERT INTO suggestions
       (source_module, project_slug, title, evidence, priority, status,
        created_at, expires_at, confidence, suggested_action, type_inferred)
     VALUES ('janitor', NULL, ?, ?, 'low', 'pending', datetime('now'),
             datetime('now', ?), ?, ?, 1)`,
  ).run(
    title,
    JSON.stringify(evidence),
    `+${PENDING_TTL_DAYS} days`,
    proposal.confidence,
    JSON.stringify(suggestedAction),
  );
  return 'proposed';
}

// ---------------------------------------------------------------------------
// The instance factory
// ---------------------------------------------------------------------------

/**
 * Build the janitor near-dupe cognition instance for a resolved janitor config.
 *
 * Like perception/subconscious/synapse, `persistCandidate(db, candidate)`
 * receives no per-run context, so the instance stashes the context built this
 * run in a closure cell (`currentCtx`) that `persistCandidate` reads. Safe
 * because the engine runs ONE instance sequentially (build → parse → persist
 * loop); a fresh instance is built per component-run path (the runner).
 *
 * `deps.embed` (default: the shipped `generateEmbedding`) is threaded into the
 * candidate generator; `deps.stats` (optional) is incremented per persist so the
 * runner can aggregate the `brain_maintenance_runs` counters.
 */
export function createJanitorInstance(
  config: JanitorConfig = DEFAULT_JANITOR_CONFIG,
  deps: JanitorInstanceDeps = {},
): CognitionInstance<JanitorContext, MergeProposal> {
  let currentCtx: JanitorContext | null = null;

  const emptyCtx = (): JanitorContext => ({
    pairs: [],
    project: 'all',
    autoMerge: config.auto_merge,
    autoMergeThreshold: config.auto_merge_threshold,
    pairs_bytes: 0,
    persistedPairs: new Set<string>(),
  });

  return {
    id: 'janitor',

    // TD-327 — the REQUIRED observability declaration. The janitor is the
    // DRIVER of three other instances: `janitor/runner.ts` co-drives arbiter,
    // curator and cartographer inside its own run, so a wedged `janitor_engine`
    // schedule takes FOUR instances offline, not one. Those three name this
    // instance's id in their `driver_ref`.
    health: {
      component: 'cognition.janitor',
      event_prefix: 'cognition.janitor',
      gate_keys: ['cognition.janitor.enabled'],
      gate_default: false, // DEFAULT_JANITOR_CONFIG.enabled === false
      driver: 'schedule',
      driver_ref: 'janitor_engine',
      output: "suggestions[source_module='janitor']",
      // TD-423 IDENTITY predicate — see types.ts#produced.
      produced: "suggestions[source_module='janitor']",
    },

    async buildContext(
      db: Database.Database,
      args: ExtractorArgs,
    ): Promise<JanitorContext> {
      const project =
        typeof args.project === 'string' && args.project.length > 0 ? args.project : 'all';
      const pairs = await buildDuplicatePairs(db, config, { embed: deps.embed });
      const pairs_bytes = Buffer.byteLength(JSON.stringify(pairs), 'utf8');
      const ctx: JanitorContext = {
        pairs,
        project,
        autoMerge: config.auto_merge,
        autoMergeThreshold: config.auto_merge_threshold,
        pairs_bytes,
        persistedPairs: new Set<string>(),
      };
      currentCtx = ctx;
      return ctx;
    },

    promptBuilder(ctx: JanitorContext): ExtractorPrompt {
      return {
        system: buildJanitorSystemPrompt(),
        user: buildJanitorUserPrompt(ctx.pairs),
      };
    },

    parseResponse(raw: string, ctx: JanitorContext): MergeProposal[] {
      const pairs = ctx?.pairs ?? currentCtx?.pairs ?? [];
      return validateJanitorResponse(raw, pairs);
    },

    // TD-294 — a well-formed (possibly empty) array is a VALID EMPTY judgment
    // ("no real near-dupes"), not a parse_error. Consulted only on zero parse.
    isMalformedResponse: (raw) => !isJanitorResponseWellFormed(raw),

    async persistCandidate(
      db: Database.Database,
      proposal: MergeProposal,
    ): Promise<void> {
      const ctx = currentCtx ?? emptyCtx();
      const outcome = persistJanitorProposal(db, proposal, ctx);
      if (deps.stats) {
        if (outcome === 'proposed') deps.stats.proposed += 1;
        else if (outcome === 'applied') deps.stats.applied += 1;
      }
    },

    config: janitorInstanceConfig(config),

    inputBytes(ctx: JanitorContext): number {
      return ctx.pairs_bytes;
    },

    isEmptyContext(ctx: JanitorContext): boolean {
      return ctx.pairs.length === 0;
    },
  };
}

/**
 * The default-config janitor instance registered by the barrel. Production
 * resolves the live config at component init and rebinds (via the runner); the
 * barrel export gives the OPEN registry a discoverable instance (the FR-202
 * zero-host-change property) and the engine a runnable default.
 */
export const janitorInstance: CognitionInstance<JanitorContext, MergeProposal> =
  createJanitorInstance();
