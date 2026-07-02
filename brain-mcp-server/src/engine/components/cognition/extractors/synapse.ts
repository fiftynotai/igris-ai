/**
 * Brain Engine v7.1 — Cognition instance: SYNAPSE (FR-211).
 *
 * The THIRD self-describing instance of the agnostic cognition host — built on
 * the SAME engine perception (M1) + subconscious (M2) proved. It forms typed
 * edges between memory nodes: it reads a cheap deterministic candidate-pair
 * digest, runs one brain-isolated LLM call to judge the relationship type +
 * confidence, and QUEUES each proposed edge for operator review by reusing the
 * existing `suggestions` channel — no new review/apply tools, no schema change.
 *
 * The three differing slots (FR-118):
 *   - INPUT  (`buildContext`):  `buildCandidatePairs(db, cfg)` → a bounded, pure
 *     digest of learning↔learning candidate pairs (cosine KNN + shared-brief,
 *     minus already-edged/pending pairs).
 *   - PROMPT (`promptBuilder`): the synapse system + user (pairs-wrapped) prompts.
 *   - OUTPUT (`persistCandidate`): INSERT into `suggestions`
 *     (`source_module='edge_inference'`, `type_inferred=1`,
 *     `suggested_action={kind:'add_edge', from, to, edge_type, justification}`)
 *     — OR, when `auto_approve`, a direct `handleEdgeCreate(provenance:'inferred')`.
 *
 * The `parseResponse` slot is the validator: it cite-checks every proposal
 * against the candidate set, enforces the edge_type allow-list, and caps
 * confidence at 0.85.
 *
 * R-OVER-ABSTRACT guard: synapse's quirks — the candidate pre-filter, the
 * cosine floor / top-k / cap, the edge-dedup, the auto_approve fork — live HERE,
 * in the instance slots + config, NOT in the agnostic engine. The engine still
 * knows nothing about edge inference (AC #1).
 *
 * @module engine/components/cognition/extractors/synapse
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import type {
  CognitionInstance,
  CognitionInstanceConfig,
  ExtractorArgs,
  ExtractorPrompt,
} from '../types.js';
import { buildCandidatePairs } from '../../synapse/candidates.js';
import {
  buildSynapseSystemPrompt,
  buildSynapseUserPrompt,
} from '../../synapse/prompts.js';
import {
  validateSynapseResponse,
  isSynapseResponseWellFormed,
} from '../../synapse/validator.js';
import {
  DEFAULT_SYNAPSE_CONFIG,
  type CandidatePair,
  type EdgeProposal,
  type SynapseConfig,
} from '../../synapse/types.js';
import { handleEdgeCreate } from '../../edges/handlers.js';

// ---------------------------------------------------------------------------
// The instance's private context shape (slot 1 output)
// ---------------------------------------------------------------------------

/**
 * The synapse's private context — the candidate pairs the LLM judges, plus the
 * framing the persist slot needs (the project scope, the auto_approve fork, the
 * digest byte size for the cost gate, and an in-run dedup set so two proposals
 * for the same pair do not both persist). Opaque to the engine; only
 * `inputBytes(ctx)` exposes a size.
 */
export interface SynapseContext {
  /** The candidate learning↔learning pairs the LLM reasons over. */
  pairs: CandidatePair[];
  /** The project scope ('all' = whole brain). */
  project: string;
  /** D5 — when true, persist writes the edge directly instead of a suggestion. */
  autoApprove: boolean;
  /** The candidate-digest size in UTF-8 bytes (the engine's cost-gate input). */
  pairs_bytes: number;
  /** In-run sorted-pair keys already persisted (prevents a double-persist). */
  persistedPairs: Set<string>;
}

// ---------------------------------------------------------------------------
// Config mapping (synapse knobs → the engine's agnostic envelope)
// ---------------------------------------------------------------------------

/**
 * Map the synapse config knobs onto the engine's per-instance
 * `CognitionInstanceConfig`. `min_input_bytes` → the bytes cost gate;
 * `llm_timeout_ms` → the timeout; `llm_daily_budget` → the daily envelope;
 * `harness: null` inherits the global `llm_extractor.harness` default. The
 * candidate knobs (cosine_floor/top_k/max_pairs/auto_approve) are NOT part of
 * the agnostic envelope — they drive the instance's own slots.
 */
export function synapseInstanceConfig(
  config: SynapseConfig = DEFAULT_SYNAPSE_CONFIG,
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
// Persist helper (slot 2 — OUTPUT: suggestions INSERT, or direct edge)
// ---------------------------------------------------------------------------

/** Pending-suggestion TTL (days) — mirrors the subconscious runner's default. */
const PENDING_TTL_DAYS = 30;

/** Unordered pair key — matches the candidate generator's `${min}:${max}`. */
function sortedKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Persist one edge proposal. Default (review-gated) path INSERTs a `suggestions`
 * row with `source_module='edge_inference'`, `type_inferred=1`, and a
 * `suggested_action={kind:'add_edge', from:{type,id}, to:{type,id}, edge_type,
 * justification}` — the exact shape `applyAddEdge` reads when the operator later
 * applies it. The `auto_approve` path (D5) SKIPS the suggestion and writes the
 * edge directly via the canonical `handleEdgeCreate(provenance:'inferred')`
 * (all edge-writes go through the edges component — learning #206).
 *
 * In-run deduped by the sorted pair key so two proposals for the same pair do
 * not both persist. Returns true when something was written, false when deduped.
 */
export function persistSynapseProposal(
  db: Database.Database,
  proposal: EdgeProposal,
  ctx: SynapseContext,
): boolean {
  const key = sortedKey(proposal.from_id, proposal.to_id);
  if (ctx.persistedPairs.has(key)) return false;
  ctx.persistedPairs.add(key);

  const justification = proposal.justification.length > 0 ? proposal.justification : undefined;

  if (ctx.autoApprove) {
    // Direct edge write via the canonical creator (uses getDb() internally). In
    // production that is the same live brain the run reads; tests mock getDb.
    handleEdgeCreate({
      from_type: 'learning',
      from_id: String(proposal.from_id),
      to_type: 'learning',
      to_id: String(proposal.to_id),
      edge_type: proposal.edge_type,
      provenance: 'inferred',
      confidence: proposal.confidence,
      metadata: {
        source: 'cognition.synapse',
        ...(justification ? { justification } : {}),
      },
    });
    return true;
  }

  const suggestedAction = {
    kind: 'add_edge',
    from: { type: 'learning', id: String(proposal.from_id) },
    to: { type: 'learning', id: String(proposal.to_id) },
    edge_type: proposal.edge_type,
    ...(justification ? { justification } : {}),
  };
  const evidence = {
    from_id: proposal.from_id,
    to_id: proposal.to_id,
    edge_type: proposal.edge_type,
    ...(justification ? { justification } : {}),
  };
  const title = `Inferred ${proposal.edge_type} edge: learning ${proposal.from_id} → learning ${proposal.to_id}`;

  db.prepare(
    `INSERT INTO suggestions
       (source_module, project_slug, title, evidence, priority, status,
        created_at, expires_at, confidence, suggested_action, type_inferred)
     VALUES ('edge_inference', NULL, ?, ?, 'low', 'pending', datetime('now'),
             datetime('now', ?), ?, ?, 1)`,
  ).run(
    title,
    JSON.stringify(evidence),
    `+${PENDING_TTL_DAYS} days`,
    proposal.confidence,
    JSON.stringify(suggestedAction),
  );
  return true;
}

// ---------------------------------------------------------------------------
// The instance factory
// ---------------------------------------------------------------------------

/**
 * Build the synapse cognition instance for a resolved synapse config.
 *
 * The slots:
 *   - `buildContext`  — `buildCandidatePairs` + the framing (project/auto_approve/bytes)
 *   - `promptBuilder` — the synapse system + pairs-wrapped user prompts
 *   - `parseResponse` — the validator (cite-check + edge-type allow-list + cap)
 *   - `persistCandidate` — the `suggestions` INSERT (or direct edge on auto_approve)
 *   - `inputBytes`    — the candidate-digest byte size (the cost gate input)
 *
 * Like perception/subconscious, `persistCandidate(db, candidate)` receives no
 * per-run context, so the instance stashes the context built this run in a
 * closure cell (`currentCtx`) that `persistCandidate` reads. Safe because the
 * engine runs ONE instance sequentially (build → parse → persist loop); a fresh
 * instance is built per component-run path.
 */
export function createSynapseInstance(
  config: SynapseConfig = DEFAULT_SYNAPSE_CONFIG,
): CognitionInstance<SynapseContext, EdgeProposal> {
  let currentCtx: SynapseContext | null = null;

  const emptyCtx = (): SynapseContext => ({
    pairs: [],
    project: 'all',
    autoApprove: config.auto_approve,
    pairs_bytes: 0,
    persistedPairs: new Set<string>(),
  });

  return {
    id: 'synapse',

    async buildContext(
      db: Database.Database,
      args: ExtractorArgs,
    ): Promise<SynapseContext> {
      const project =
        typeof args.project === 'string' && args.project.length > 0 ? args.project : 'all';
      const pairs = buildCandidatePairs(db, config);
      const pairs_bytes = Buffer.byteLength(JSON.stringify(pairs), 'utf8');
      const ctx: SynapseContext = {
        pairs,
        project,
        autoApprove: config.auto_approve,
        pairs_bytes,
        persistedPairs: new Set<string>(),
      };
      currentCtx = ctx;
      return ctx;
    },

    promptBuilder(ctx: SynapseContext): ExtractorPrompt {
      return {
        system: buildSynapseSystemPrompt(),
        user: buildSynapseUserPrompt(ctx.pairs),
      };
    },

    parseResponse(raw: string, ctx: SynapseContext): EdgeProposal[] {
      // ctx is threaded by the engine; fall back to the closure cell defensively.
      const pairs = ctx?.pairs ?? currentCtx?.pairs ?? [];
      return validateSynapseResponse(raw, pairs);
    },

    // TD-294 — a well-formed (possibly empty) array is a VALID EMPTY judgment
    // ("no typed edges to add"), not a parse_error. Consulted only on zero parse.
    isMalformedResponse: (raw) => !isSynapseResponseWellFormed(raw),

    async persistCandidate(
      db: Database.Database,
      proposal: EdgeProposal,
    ): Promise<void> {
      const ctx = currentCtx ?? emptyCtx();
      persistSynapseProposal(db, proposal, ctx);
    },

    config: synapseInstanceConfig(config),

    inputBytes(ctx: SynapseContext): number {
      return ctx.pairs_bytes;
    },

    isEmptyContext(ctx: SynapseContext): boolean {
      return ctx.pairs.length === 0;
    },
  };
}

/**
 * The default-config synapse instance registered by the barrel. Production
 * resolves the live config at component init and rebinds; the barrel export
 * gives the OPEN registry a discoverable instance (the FR-202 zero-host-change
 * property) and the engine a runnable default.
 */
export const synapseInstance: CognitionInstance<SynapseContext, EdgeProposal> =
  createSynapseInstance();
