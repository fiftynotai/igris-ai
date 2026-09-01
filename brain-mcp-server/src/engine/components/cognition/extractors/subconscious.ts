/**
 * Brain Engine v7.1 — Cognition instance: SUBCONSCIOUS (FR-118 M2).
 *
 * The headline LLM extractor. The subconscious is the SECOND self-describing
 * instance of the agnostic cognition host — built on the SAME engine the
 * perception instance proved (M1). It reads a deterministic brain digest and
 * emits OPEN-typed suggestions with optional machine-applicable actions,
 * REPLACING the FR-106 rule detectors (which stay uncalled until M4).
 *
 * The three differing slots (FR-118):
 *   - INPUT  (`buildContext`):  `buildDigest(db, project)` → a bounded, pure digest
 *   - PROMPT (`promptBuilder`): the subconscious system + user (digest-wrapped) prompts
 *   - OUTPUT (`persistCandidate`): INSERT into `suggestions` (open source_module,
 *     confidence, suggested_action, type_inferred=1) with dedup vs open_suggestions
 *
 * The `parseResponse` slot is the validator: it cross-checks every cited
 * brief_id/learning_id against the digest (the hallucination guard), caps
 * confidence at [0, 0.85], and rejects malformed responses cleanly.
 *
 * R-OVER-ABSTRACT guard: the subconscious's quirks — the digest size gate, the
 * dedup vs already-pending suggestions, the confidence cap — live HERE, in the
 * instance slots + config, NOT in the agnostic engine. The engine still knows
 * nothing about the subconscious.
 *
 * @module engine/components/cognition/extractors/subconscious
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import type {
  CognitionInstance,
  CognitionInstanceConfig,
  ExtractorArgs,
  ExtractorPrompt,
} from '../types.js';
import {
  buildDigest,
  type BrainDigest,
  type BuildDigestDeps,
} from '../../subconscious/digest.js';
import {
  buildSubconsciousSystemPrompt,
  buildSubconsciousUserPrompt,
} from '../../subconscious/prompts.js';
import {
  validateSubconsciousResponse,
  isSubconsciousResponseWellFormed,
} from '../../subconscious/validator.js';
import {
  DEFAULT_SUBCONSCIOUS_CONFIG,
  type SubconsciousConfig,
  type SuggestionCandidate,
} from '../../subconscious/types.js';
import { computeEvidenceSignature } from '../../subconscious/runner.js';

// ---------------------------------------------------------------------------
// The instance's private context shape (slot 1 output)
// ---------------------------------------------------------------------------

/**
 * The subconscious's private context — the brain digest plus the framing the
 * persist slot needs (the project scope + a snapshot of already-pending
 * suggestion dedupe keys so persistence does not re-queue an open suggestion).
 * Opaque to the engine; only `inputBytes(ctx)` exposes a size for the cost gate.
 */
export interface SubconsciousContext {
  /** The deterministic digest the LLM reasons over. */
  digest: BrainDigest;
  /** The project scope ('all' = whole brain) — tagged onto persisted rows' project_slug fallback. */
  project: string;
  /** Dedupe keys of suggestions already pending (so persistCandidate skips them). */
  existingPending: Set<string>;
  /** The digest size in UTF-8 bytes (the engine's cost-gate input). */
  digest_bytes: number;
}

// ---------------------------------------------------------------------------
// Config mapping (subconscious knobs → the engine's agnostic envelope)
// ---------------------------------------------------------------------------

/**
 * Map the subconscious config knobs onto the engine's per-instance
 * `CognitionInstanceConfig`. `min_digest_bytes` → the bytes cost gate;
 * `llm_timeout_ms` → the timeout; `llm_daily_budget` → the daily envelope;
 * `harness: null` inherits the global `llm_extractor.harness` default.
 */
export function subconsciousInstanceConfig(
  config: SubconsciousConfig = DEFAULT_SUBCONSCIOUS_CONFIG,
): CognitionInstanceConfig {
  return {
    timeout_ms: config.llm_timeout_ms,
    daily_budget: config.llm_daily_budget,
    min_input_bytes: config.min_digest_bytes,
    enabled: config.enabled,
    harness: config.harness as CognitionInstanceConfig['harness'],
  };
}

// ---------------------------------------------------------------------------
// Dedupe key — mirror the runner's existing-pending signature shape
// ---------------------------------------------------------------------------

/**
 * Build the dedupe key for a candidate: `<source_module>|<project>|<signature>`,
 * matching the shape the legacy runner uses for the `existingPending` snapshot.
 * Reuses `computeEvidenceSignature` so an LLM suggestion that maps onto the same
 * evidence signature as a queued one is recognised as a duplicate.
 */
export function candidateDedupeKey(candidate: SuggestionCandidate): string {
  const signature = computeEvidenceSignature(candidate.source_module, candidate.evidence);
  return `${candidate.source_module}|${candidate.project_slug ?? ''}|${signature}`;
}

/**
 * Snapshot the dedupe keys of all currently-pending suggestions. Fail-soft on a
 * missing `suggestions` table (returns an empty set) so the instance never
 * throws building context against a partial schema.
 */
export function snapshotExistingPending(db: Database.Database): Set<string> {
  const set = new Set<string>();
  try {
    const rows = db
      .prepare(
        `SELECT source_module, project_slug, evidence FROM suggestions WHERE status = 'pending'`,
      )
      .all() as Array<{
      source_module: string;
      project_slug: string | null;
      evidence: string | null;
    }>;
    for (const row of rows) {
      let evidence: Record<string, unknown> = {};
      if (row.evidence) {
        try {
          const parsed: unknown = JSON.parse(row.evidence);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            evidence = parsed as Record<string, unknown>;
          }
        } catch {
          /* malformed evidence — stable empty signature */
        }
      }
      const signature = computeEvidenceSignature(row.source_module, evidence);
      set.add(`${row.source_module}|${row.project_slug ?? ''}|${signature}`);
    }
  } catch {
    /* suggestions table absent — empty snapshot */
  }
  return set;
}

// ---------------------------------------------------------------------------
// Persist helper (slot 2 — OUTPUT TABLE: suggestions INSERT)
// ---------------------------------------------------------------------------

/** Pending-suggestion TTL (days) — mirrors the legacy runner's default. */
const PENDING_TTL_DAYS = 30;

/**
 * Persist one subconscious candidate as a `suggestions` row. Writes the OPEN
 * `source_module` (the model's kind), `confidence`, the serialized
 * `suggested_action` (NULL when advisory-only), and `type_inferred=1` (the
 * LLM-extractor marker). The row is `status='pending'` with a 30-day TTL,
 * matching the legacy runner's INSERT shape for the columns they share.
 *
 * Returns true when a row was inserted, false when the candidate was deduped
 * against an already-pending suggestion (so the engine's persisted count
 * reflects only NEW rows).
 */
export function persistSubconsciousCandidate(
  db: Database.Database,
  candidate: SuggestionCandidate,
  ctx: SubconsciousContext,
): boolean {
  const dedupeKey = candidateDedupeKey(candidate);
  if (ctx.existingPending.has(dedupeKey)) return false;

  const projectSlug = candidate.project_slug ?? (ctx.project === 'all' ? null : ctx.project);
  const suggestedAction = candidate.suggested_action
    ? JSON.stringify(candidate.suggested_action)
    : null;
  const confidence = typeof candidate.confidence === 'number' ? candidate.confidence : null;

  db.prepare(
    `INSERT INTO suggestions
       (source_module, project_slug, title, evidence, priority, status,
        created_at, expires_at, confidence, suggested_action, type_inferred)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'),
             datetime('now', ?), ?, ?, 1)`,
  ).run(
    candidate.source_module,
    projectSlug,
    candidate.title,
    JSON.stringify(candidate.evidence),
    candidate.priority,
    `+${PENDING_TTL_DAYS} days`,
    confidence,
    suggestedAction,
  );

  // Track in-run so two candidates with the same signature don't both insert.
  ctx.existingPending.add(dedupeKey);
  return true;
}

// ---------------------------------------------------------------------------
// The instance factory
// ---------------------------------------------------------------------------

/** Injectable seams for the instance's `buildContext` (digest deps) — tests pin git/now. */
export interface SubconsciousInstanceDeps {
  digestDeps?: BuildDigestDeps;
}

/**
 * Build the subconscious cognition instance for a resolved subconscious config.
 *
 * The slots:
 *   - `buildContext`  — `buildDigest` + a snapshot of already-pending dedupe keys
 *   - `promptBuilder` — the subconscious system + digest-wrapped user prompts
 *   - `parseResponse` — the validator (citation cross-check + confidence cap)
 *   - `persistCandidate` — the `suggestions` INSERT (open source_module + new cols)
 *   - `inputBytes`    — the digest byte size (the cost gate input)
 *
 * Like perception, `persistCandidate(db, candidate)` receives no per-run
 * context, so the instance stashes the context built this run in a closure cell
 * (`currentCtx`) that `persistCandidate` reads. Safe because the engine runs
 * ONE instance sequentially (build → parse → persist loop); a fresh instance is
 * built per component-run path.
 */
export function createSubconsciousInstance(
  config: SubconsciousConfig = DEFAULT_SUBCONSCIOUS_CONFIG,
  deps: SubconsciousInstanceDeps = {},
): CognitionInstance<SubconsciousContext, SuggestionCandidate> {
  let currentCtx: SubconsciousContext | null = null;

  return {
    id: 'subconscious',

    // TD-327 — the REQUIRED observability declaration. Own switch, own cron.
    // `source_module` is OPEN post-FR-118: the LLM names the kind, so the
    // output expression names the table and the provenance rather than a fixed
    // module string.
    health: {
      component: 'cognition.subconscious',
      event_prefix: 'cognition.subconscious',
      gate_keys: ['cognition.subconscious.enabled'],
      gate_default: false, // DEFAULT_SUBCONSCIOUS_CONFIG.enabled === false
      driver: 'schedule',
      driver_ref: 'subconscious_engine',
      output: 'suggestions[source_module=LLM-named, type_inferred=1]',
      // TD-423. `type_inferred=1` alone is NOT unique to this instance — all
      // six suggestions-writers set it — so the complement is what isolates it.
      // See types.ts#produced for the OTHER semantics.
      produced: 'suggestions[type_inferred=1, source_module=OTHER]',
    },

    async buildContext(
      db: Database.Database,
      args: ExtractorArgs,
    ): Promise<SubconsciousContext> {
      const project =
        typeof args.project === 'string' && args.project.length > 0 ? args.project : 'all';
      const digest = buildDigest(db, project, deps.digestDeps);
      const digest_bytes = digest.size_hint.bytes;
      const existingPending = snapshotExistingPending(db);
      const ctx: SubconsciousContext = {
        digest,
        project,
        existingPending,
        digest_bytes,
      };
      currentCtx = ctx;
      return ctx;
    },

    promptBuilder(ctx: SubconsciousContext): ExtractorPrompt {
      return {
        system: buildSubconsciousSystemPrompt(),
        user: buildSubconsciousUserPrompt(ctx.digest),
      };
    },

    parseResponse(raw: string, ctx: SubconsciousContext): SuggestionCandidate[] {
      // ctx is threaded by the engine; fall back to the closure cell defensively.
      const digest = ctx?.digest ?? currentCtx?.digest;
      if (!digest) return [];
      return validateSubconsciousResponse(raw, digest);
    },

    // TD-294 — a well-formed (possibly empty) array is a VALID EMPTY judgment
    // ("nothing worth suggesting"), not a parse_error. Consulted only on zero parse.
    isMalformedResponse: (raw) => !isSubconsciousResponseWellFormed(raw),

    async persistCandidate(
      db: Database.Database,
      candidate: SuggestionCandidate,
    ): Promise<void> {
      const ctx: SubconsciousContext =
        currentCtx ?? {
          digest: {
            scope: 'all',
            generated_at: '',
            open_briefs: [],
            recent_learnings: [],
            open_suggestions: [],
            projects: [],
            recent_commits: [],
            size_hint: { bytes: 0, truncated: false },
          },
          project: 'all',
          existingPending: new Set<string>(),
          digest_bytes: 0,
        };
      persistSubconsciousCandidate(db, candidate, ctx);
    },

    config: subconsciousInstanceConfig(config),

    inputBytes(ctx: SubconsciousContext): number {
      return ctx.digest_bytes;
    },
  };
}

/**
 * The default-config subconscious instance registered by the barrel. Production
 * resolves the live config at component init and rebinds; the barrel export
 * gives the OPEN registry a discoverable instance (the FR-202 zero-host-change
 * property) and the engine a runnable default.
 */
export const subconsciousInstance: CognitionInstance<
  SubconsciousContext,
  SuggestionCandidate
> = createSubconsciousInstance();
