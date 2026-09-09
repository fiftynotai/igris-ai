/**
 * Brain Engine v7.1 — Cognition instance: ARBITER (FR-116 M2).
 *
 * The FIFTH self-describing instance of the agnostic cognition host — built on
 * the SAME engine perception (M1) + subconscious (M2) + synapse (FR-211) +
 * janitor (FR-119) proved. Where the janitor MERGES near-duplicates, the arbiter
 * RESOLVES CONTRADICTIONS: it reads a cheap deterministic opposition-pair digest
 * (same-topic embedding-KNN + a negation/antonym cue), runs one brain-isolated
 * LLM call to judge newer-wins / both-valid-scope / evolved-merge /
 * not-a-contradiction, and QUEUES each proposed resolution for operator review by
 * reusing the existing `suggestions` channel (`source_module='arbiter'`,
 * `suggested_action.kind='resolve_contradiction'`). Approval flows through the
 * already-shipped `igris_suggestion_apply_action` → `applyResolveContradiction`
 * path.
 *
 * The three differing slots (FR-118):
 *   - INPUT  (`buildContext`):  `buildContradictionPairs(db, cfg)` → a bounded,
 *     pure digest of opposition learning↔learning candidate pairs.
 *   - PROMPT (`promptBuilder`): the arbiter resolve-contradiction prompts.
 *   - OUTPUT (`persistCandidate`): INSERT into `suggestions`
 *     (`source_module='arbiter'`, `type_inferred=1`, `suggested_action={kind:
 *     'resolve_contradiction', resolution, ...}`) — OR, when `auto_resolve` AND
 *     cosine ≥ threshold, a direct `applyResolveContradiction(db, ...)`.
 *
 * ZERO-HOST-CHANGE (FR-202): a new instance is a new file + one barrel line. The
 * arbiter is NOT a separate component with its own flag/cron — it is CO-SCHEDULED
 * under the janitor runner (Decision #4A), riding the single
 * `cognition.janitor.enabled` flag + `janitor_engine` cron + shared audit row.
 *
 * R-OVER-ABSTRACT guard: the arbiter's quirks — the opposition pre-filter, the
 * same-topic cosine band, the auto_resolve fork — live HERE, in the instance
 * slots + config, NOT in the agnostic engine.
 *
 * @module engine/components/cognition/extractors/arbiter
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import type {
  CognitionInstance,
  CognitionInstanceConfig,
  ExtractorArgs,
  ExtractorPrompt,
} from '../types.js';
import { buildContradictionPairs } from '../../arbiter/candidates.js';
import type { Embedder } from '../../arbiter/candidates.js';
import {
  buildArbiterSystemPrompt,
  buildArbiterUserPrompt,
} from '../../arbiter/prompts.js';
import {
  validateArbiterResponse,
  isArbiterResponseWellFormed,
} from '../../arbiter/validator.js';
import {
  DEFAULT_ARBITER_CONFIG,
  type ArbiterConfig,
  type ContradictionPair,
  type ContradictionProposal,
} from '../../arbiter/types.js';
import { applyResolveContradiction, contentHash } from '../../subconscious/actions/kinds.js';

// ---------------------------------------------------------------------------
// The instance's private context shape (slot 1 output)
// ---------------------------------------------------------------------------

/**
 * The arbiter's private context — the candidate pairs the LLM judges, plus the
 * framing the persist slot needs (the auto_resolve fork + threshold, the digest
 * byte size for the cost gate, and an in-run dedup set so two proposals for the
 * same pair do not both persist). Opaque to the engine; only `inputBytes(ctx)`
 * exposes a size.
 */
export interface ArbiterContext {
  /** The opposition candidate pairs the LLM reasons over. */
  pairs: ContradictionPair[];
  /** The project scope ('all' = whole brain). */
  project: string;
  /** When true, persist applies the resolution directly (gated by cosine). */
  autoResolve: boolean;
  /** Cosine at or above which the auto_resolve fork may resolve without review. */
  autoResolveThreshold: number;
  /** The candidate-digest size in UTF-8 bytes (the engine's cost-gate input). */
  pairs_bytes: number;
  /** In-run sorted-pair keys already persisted (prevents a double-persist). */
  persistedPairs: Set<string>;
}

/**
 * Per-run counters the RUNNER reads back to aggregate the `brain_maintenance_runs`
 * audit row. `persistCandidate` increments `proposed` (review-gated suggestion)
 * or `resolved` (auto_resolve direct apply). Passed by reference into the instance
 * factory; the default-config barrel export omits it.
 */
export interface ArbiterRunStats {
  /** Contradiction resolutions QUEUED for review this run. */
  proposed: number;
  /** Contradiction resolutions applied DIRECTLY this run (auto_resolve fork). */
  resolved: number;
}

/** Injectable seams for the arbiter instance (tests inject a deterministic embedder). */
export interface ArbiterInstanceDeps {
  /** Embed the normalized fingerprint. Default: the shipped `generateEmbedding`. */
  embed?: Embedder;
  /** Per-run counter accumulator the runner reads back (optional). */
  stats?: ArbiterRunStats;
}

// ---------------------------------------------------------------------------
// Config mapping (arbiter knobs → the engine's agnostic envelope)
// ---------------------------------------------------------------------------

/**
 * Map the arbiter config knobs onto the engine's per-instance
 * `CognitionInstanceConfig`. The opposition knobs (cosine band / cues / top_k /
 * max_pairs / auto_resolve / threshold) are NOT part of the agnostic envelope —
 * they drive the instance's own slots.
 */
export function arbiterInstanceConfig(
  config: ArbiterConfig = DEFAULT_ARBITER_CONFIG,
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
// Persist helper (slot 2 — OUTPUT: suggestions INSERT, or direct resolve)
// ---------------------------------------------------------------------------

/** Pending-suggestion TTL (days) — mirrors the janitor/synapse default. */
const PENDING_TTL_DAYS = 30;

/** Unordered pair key — matches the candidate generator's `${min}:${max}`. */
function sortedKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** The two learning ids a proposal touches (winner/loser OR the both-valid pair). */
function proposalPair(proposal: ContradictionProposal): [number, number] | null {
  if (proposal.verdict === 'both_valid_scope') {
    if (proposal.learning_a_id === undefined || proposal.learning_b_id === undefined) return null;
    return [proposal.learning_a_id, proposal.learning_b_id];
  }
  if (proposal.winner_id === undefined || proposal.loser_id === undefined) return null;
  return [proposal.winner_id, proposal.loser_id];
}

/**
 * Build the `suggested_action` payload for one proposal. This is the CONTRACT the
 * consumer (`applyResolveContradiction`) reads — the two MUST stay byte-aligned
 * (the synapse↔add_edge / janitor↔merge_learnings lesson: a shape mismatch makes
 * apply silently fall back to flag_for_review). `resolution` is the discriminator.
 * The persist slot stamps `synthesized_from_hash` (TD-439).
 */
export function buildResolveContradictionAction(
  proposal: ContradictionProposal,
): Record<string, unknown> {
  const justification =
    proposal.justification.length > 0 ? { justification: proposal.justification } : {};
  if (proposal.verdict === 'both_valid_scope') {
    return {
      kind: 'resolve_contradiction',
      resolution: 'both_valid_scope',
      learning_a_id: proposal.learning_a_id,
      learning_b_id: proposal.learning_b_id,
      ...(proposal.scope_a ? { scope_a: proposal.scope_a } : {}),
      ...(proposal.scope_b ? { scope_b: proposal.scope_b } : {}),
      ...justification,
    };
  }
  if (proposal.verdict === 'evolved_merge') {
    return {
      kind: 'resolve_contradiction',
      resolution: 'evolved_merge',
      winner_id: proposal.winner_id,
      loser_id: proposal.loser_id,
      ...(proposal.synthesized_content
        ? { synthesized_content: proposal.synthesized_content }
        : {}),
      ...justification,
    };
  }
  return {
    kind: 'resolve_contradiction',
    resolution: 'newer_wins',
    winner_id: proposal.winner_id,
    loser_id: proposal.loser_id,
    ...justification,
  };
}

/**
 * Persist one contradiction resolution. Default (review-gated) path INSERTs a
 * `suggestions` row with `source_module='arbiter'`, `type_inferred=1`, and the
 * `suggested_action` built by `buildResolveContradictionAction` — the EXACT shape
 * `applyResolveContradiction` reads when the operator later applies it. The
 * `auto_resolve` path SKIPS the suggestion and applies the resolution directly,
 * but ONLY when the pair's cosine ≥ `autoResolveThreshold`.
 *
 * In-run deduped by the sorted pair key so two proposals for the same pair do
 * not both persist. Returns 'proposed' | 'resolved' | 'deduped'.
 */
export function persistArbiterProposal(
  db: Database.Database,
  proposal: ContradictionProposal,
  ctx: ArbiterContext,
): 'proposed' | 'resolved' | 'deduped' {
  const pairIds = proposalPair(proposal);
  if (!pairIds) return 'deduped';
  const key = sortedKey(pairIds[0], pairIds[1]);
  if (ctx.persistedPairs.has(key)) return 'deduped';
  ctx.persistedPairs.add(key);

  const action = buildResolveContradictionAction(proposal);
  if (proposal.verdict === 'evolved_merge') {
    const winner = db
      .prepare('SELECT content FROM learnings WHERE id = ?')
      .get(proposal.winner_id) as { content: string } | undefined;
    if (winner) action.synthesized_from_hash = contentHash(winner.content);
  }

  // AUTO-RESOLVE fork: gated by the config flag AND the cosine floor.
  // A failed resolve falls through to the INSERT (TD-439).
  if (ctx.autoResolve && proposal.cosine >= ctx.autoResolveThreshold) {
    if (applyResolveContradiction(db, action).ok) return 'resolved';
  }

  const evidence = {
    verdict: proposal.verdict,
    cosine: proposal.cosine,
    ...(proposal.winner_id !== undefined ? { winner_id: proposal.winner_id } : {}),
    ...(proposal.loser_id !== undefined ? { loser_id: proposal.loser_id } : {}),
    ...(proposal.learning_a_id !== undefined ? { learning_a_id: proposal.learning_a_id } : {}),
    ...(proposal.learning_b_id !== undefined ? { learning_b_id: proposal.learning_b_id } : {}),
    ...(proposal.justification ? { justification: proposal.justification } : {}),
  };
  const title = `Resolve contradiction (${proposal.verdict}) between learnings ${pairIds[0]} and ${pairIds[1]}`;

  db.prepare(
    `INSERT INTO suggestions
       (source_module, project_slug, title, evidence, priority, status,
        created_at, expires_at, confidence, suggested_action, type_inferred,
        source_instance)
     VALUES ('arbiter', NULL, ?, ?, 'low', 'pending', datetime('now'),
             datetime('now', ?), ?, ?, 1, 'arbiter')`,
  ).run(
    title,
    JSON.stringify(evidence),
    `+${PENDING_TTL_DAYS} days`,
    proposal.confidence,
    JSON.stringify(action),
  );
  return 'proposed';
}

// ---------------------------------------------------------------------------
// The instance factory
// ---------------------------------------------------------------------------

/**
 * Build the arbiter contradiction cognition instance for a resolved arbiter
 * config. Like perception/subconscious/synapse/janitor, `persistCandidate(db,
 * candidate)` receives no per-run context, so the instance stashes the context
 * built this run in a closure cell (`currentCtx`) that `persistCandidate` reads.
 * Safe because the engine runs ONE instance sequentially (build → parse → persist
 * loop); a fresh instance is built per component-run path (the runner).
 *
 * `deps.embed` (default: the shipped `generateEmbedding`) is threaded into the
 * candidate generator; `deps.stats` (optional) is incremented per persist so the
 * runner can aggregate the `brain_maintenance_runs` counters.
 */
export function createArbiterInstance(
  config: ArbiterConfig = DEFAULT_ARBITER_CONFIG,
  deps: ArbiterInstanceDeps = {},
): CognitionInstance<ArbiterContext, ContradictionProposal> {
  let currentCtx: ArbiterContext | null = null;

  const emptyCtx = (): ArbiterContext => ({
    pairs: [],
    project: 'all',
    autoResolve: config.auto_resolve,
    autoResolveThreshold: config.auto_resolve_threshold,
    pairs_bytes: 0,
    persistedPairs: new Set<string>(),
  });

  return {
    id: 'arbiter',

    // TD-327 — the REQUIRED observability declaration. THE ARBITER HAS NO
    // SWITCH OF ITS OWN. `resolveArbiterConfig` (`arbiter/types.ts`) DERIVES
    // `enabled` from `cognition.janitor.enabled`, and the runner co-drives it
    // inside `runJanitor`. So an absent `cognition.arbiter` key is not a gate
    // that defaulted to false — expecting a `cognition.<id>` key here is the
    // mistake. Its dormancy is always upstream, which is why the classifier
    // reports `blocked_upstream` rather than `no_signal`.
    health: {
      component: 'cognition.arbiter',
      event_prefix: 'cognition.arbiter',
      gate_keys: ['cognition.janitor.enabled'],
      gate_default: false, // derived from the janitor, which ships off
      driver: 'co_driven',
      driver_ref: 'janitor',
      output: "suggestions[source_module='arbiter']",
      // TD-423 IDENTITY predicate — see types.ts#produced.
      produced: "suggestions[source_module='arbiter']",
    },

    async buildContext(
      db: Database.Database,
      args: ExtractorArgs,
    ): Promise<ArbiterContext> {
      const project =
        typeof args.project === 'string' && args.project.length > 0 ? args.project : 'all';
      const pairs = await buildContradictionPairs(db, config, { embed: deps.embed });
      const pairs_bytes = Buffer.byteLength(JSON.stringify(pairs), 'utf8');
      const ctx: ArbiterContext = {
        pairs,
        project,
        autoResolve: config.auto_resolve,
        autoResolveThreshold: config.auto_resolve_threshold,
        pairs_bytes,
        persistedPairs: new Set<string>(),
      };
      currentCtx = ctx;
      return ctx;
    },

    promptBuilder(ctx: ArbiterContext): ExtractorPrompt {
      return {
        system: buildArbiterSystemPrompt(),
        user: buildArbiterUserPrompt(ctx.pairs),
      };
    },

    parseResponse(raw: string, ctx: ArbiterContext): ContradictionProposal[] {
      const pairs = ctx?.pairs ?? currentCtx?.pairs ?? [];
      return validateArbiterResponse(raw, pairs);
    },

    // TD-294 — a well-formed (possibly empty) array is a VALID EMPTY judgment
    // ("no real contradictions"), not a parse_error. Consulted only on zero parse.
    isMalformedResponse: (raw) => !isArbiterResponseWellFormed(raw),

    async persistCandidate(
      db: Database.Database,
      proposal: ContradictionProposal,
    ): Promise<void> {
      const ctx = currentCtx ?? emptyCtx();
      const outcome = persistArbiterProposal(db, proposal, ctx);
      if (deps.stats) {
        if (outcome === 'proposed') deps.stats.proposed += 1;
        else if (outcome === 'resolved') deps.stats.resolved += 1;
      }
    },

    config: arbiterInstanceConfig(config),

    inputBytes(ctx: ArbiterContext): number {
      return ctx.pairs_bytes;
    },

    isEmptyContext(ctx: ArbiterContext): boolean {
      return ctx.pairs.length === 0;
    },
  };
}

/**
 * The default-config arbiter instance registered by the barrel. Production
 * resolves the live config at component init and rebinds (via the runner); the
 * barrel export gives the OPEN registry a discoverable instance (the FR-202
 * zero-host-change property) and the engine a runnable default.
 */
export const arbiterInstance: CognitionInstance<ArbiterContext, ContradictionProposal> =
  createArbiterInstance();
