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
  DEFAULT_DETECTOR_CONFIG,
  DEFAULT_SUBCONSCIOUS_CONFIG,
  type DetectorConfig,
  type SubconsciousConfig,
  type SuggestionCandidate,
  type SuggestionPriority,
} from '../../subconscious/types.js';
import { isSuppressedByDismissal } from '../../subconscious/runner.js';
import {
  candidateFromRow,
  claimOf,
  claimSimilarity,
  claimsMatch,
  entityKey,
  findingKey,
  type Claim,
} from '../../subconscious/finding-key.js';

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
  /**
   * Already-pending suggestions, grouped by their TD-440 entity anchor — the
   * blocking index the persist slot matches a candidate against. A flat key set
   * cannot express the paraphrase stage, which has to compare CLAIMS inside one
   * entity block rather than look a key up.
   */
  existingPending: PendingBlocks;
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
// Dedupe — the TD-440 finding key over the pending queue
// ---------------------------------------------------------------------------

/** The producer id stamped on every row this instance writes (TD-440 AC-5). */
export const SUBCONSCIOUS_INSTANCE_ID = 'subconscious';

/** How many absorbed titles a bumped row keeps, newest last. */
const RECURRENCE_TITLE_CAP = 3;

/** What {@link persistSubconsciousCandidate} did with a candidate. */
export type PersistOutcome = 'inserted' | 'bumped' | 'suppressed';

/** One already-pending row, indexed for the two-stage match. */
export interface PendingEntry {
  id: number;
  dedupeKey: string;
  claim: Claim;
  title: string;
  seenCount: number;
  priority: SuggestionPriority;
  recurrenceTitles: string[];
}

/** Pending rows grouped by their {@link entityKey} anchor — the blocking index. */
export type PendingBlocks = Map<string, PendingEntry[]>;

function parseTitleArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Snapshot every currently-pending suggestion into the blocking index the
 * persist slot matches against. Rows whose v5 keys are still NULL are keyed on
 * the fly, so a queue that has not been backfilled yet still dedups correctly.
 *
 * Fail-soft twice over: a pre-v5 schema falls back to a narrow SELECT, and a
 * missing `suggestions` table yields an empty index rather than throwing.
 */
export function snapshotExistingPending(db: Database.Database): PendingBlocks {
  const blocks: PendingBlocks = new Map();
  const WIDE = `SELECT id, project_slug, title, evidence, suggested_action, priority,
                       dedupe_key, entity_key, seen_count, recurrence_titles
                  FROM suggestions WHERE status = 'pending'`;
  const NARROW = `SELECT id, project_slug, title, evidence, suggested_action, priority
                    FROM suggestions WHERE status = 'pending'`;

  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(WIDE).all() as Array<Record<string, unknown>>;
  } catch {
    try {
      rows = db.prepare(NARROW).all() as Array<Record<string, unknown>>;
    } catch {
      return blocks; /* suggestions table absent — empty index */
    }
  }

  for (const row of rows) {
    const shape = {
      project_slug: (row.project_slug as string | null) ?? null,
      title: (row.title as string) ?? '',
      evidence: (row.evidence as string | null) ?? null,
      suggested_action: (row.suggested_action as string | null) ?? null,
    };
    const candidate = candidateFromRow(shape);
    const anchor =
      typeof row.entity_key === 'string' && row.entity_key.length > 0
        ? row.entity_key
        : entityKey(candidate);
    const key =
      typeof row.dedupe_key === 'string' && row.dedupe_key.length > 0
        ? row.dedupe_key
        : findingKey(candidate);
    const entry: PendingEntry = {
      id: Number(row.id),
      dedupeKey: key,
      claim: claimOf(shape.title),
      title: shape.title,
      seenCount: typeof row.seen_count === 'number' ? row.seen_count : 1,
      priority: ((row.priority as SuggestionPriority) ?? 'medium'),
      recurrenceTitles: parseTitleArray(row.recurrence_titles),
    };
    const block = blocks.get(anchor);
    if (block) block.push(entry);
    else blocks.set(anchor, [entry]);
  }
  return blocks;
}

/** Promote one priority step every `escalateN`th sighting; `high` is the ceiling. */
export function escalatePriority(
  priority: SuggestionPriority,
  seenCount: number,
  escalateN: number,
): SuggestionPriority {
  if (escalateN <= 0 || seenCount % escalateN !== 0) return priority;
  if (priority === 'low') return 'medium';
  if (priority === 'medium') return 'high';
  return 'high';
}

/**
 * The absorbed-title record. Keeps the last {@link RECURRENCE_TITLE_CAP}
 * DISTINCT titles this row swallowed — the `dismissed_patterns.reasons` cap
 * pattern. A title identical to the row's own carries no information and is not
 * recorded.
 *
 * This column is the over-merge falsifier that needs no second table and no log
 * archaeology: a merge that should not have happened is visible by reading the
 * row it happened on.
 */
export function absorbTitle(entry: PendingEntry, title: string): string[] {
  if (title === entry.title || entry.recurrenceTitles.includes(title)) {
    return entry.recurrenceTitles;
  }
  const next = [...entry.recurrenceTitles, title];
  return next.length > RECURRENCE_TITLE_CAP
    ? next.slice(next.length - RECURRENCE_TITLE_CAP)
    : next;
}

// ---------------------------------------------------------------------------
// Persist helper (slot 2 — OUTPUT TABLE: suggestions INSERT)
// ---------------------------------------------------------------------------

/** Pending-suggestion TTL (days) — mirrors the legacy runner's default. */
const PENDING_TTL_DAYS = 30;

/**
 * Persist one subconscious candidate, as one of three outcomes (TD-440):
 *
 *   **BUMP** — the finding is already pending, exactly (same `dedupe_key`) or
 *   as a paraphrase (same entity anchor, {@link claimsMatch} on the claim).
 *   The matched row's `seen_count` increments, `last_seen_at` and `expires_at`
 *   advance so a still-recurring finding cannot lapse, the absorbed title is
 *   recorded, and every `recurrence_escalate_n`th sighting promotes the
 *   priority. **`created_at` is deliberately NOT touched** — it is the LWW
 *   timestamp `SYNC_TABLES` compares on, so a recurrence does not re-push the
 *   row.
 *
 *   **SUPPRESS** — the operator has dismissed this finding and the
 *   `dismissed_patterns` policy still holds (permanently past
 *   `dismiss_suppress_count`, otherwise for `dismiss_cooldown_days`).
 *
 *   **INSERT** — a genuinely new finding. Writes the OPEN `source_module` (the
 *   model's kind), `confidence`, the serialized `suggested_action`,
 *   `type_inferred=1`, the v5 key columns and `source_instance`.
 *
 * NEITHER A BUMP NOR A SUPPRESS MAY THROW, and the caller must not turn one
 * into a failure. The engine counts non-throwing `persistCandidate` calls and
 * fails the whole run with `db_error` when that count is zero — so a fully
 * deduplicated run, which is exactly the steady state this brief exists to
 * reach, would otherwise be reported as `run_failed` and classified `failing`
 * by `igris cognition health`. The outcome is returned for tests and callers
 * that want it; the instance slot deliberately discards it.
 */
export function persistSubconsciousCandidate(
  db: Database.Database,
  candidate: SuggestionCandidate,
  ctx: SubconsciousContext,
  config: SubconsciousConfig = DEFAULT_SUBCONSCIOUS_CONFIG,
  detectorConfig: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
): PersistOutcome {
  const anchor = entityKey(candidate);
  const key = findingKey(candidate);
  const claim = claimOf(candidate.title);
  const block = ctx.existingPending.get(anchor) ?? [];

  // A — exact key hit.
  let match = block.find((e) => e.dedupeKey === key) ?? null;

  // B — paraphrase: the best-scoring claim in this entity block that matches.
  if (!match) {
    let bestScore = -1;
    for (const entry of block) {
      if (
        !claimsMatch(
          claim,
          entry.claim,
          config.dedupe_claim_overlap,
          config.dedupe_min_claim_tokens,
        )
      ) {
        continue;
      }
      const score = claimSimilarity(claim.tokens, entry.claim.tokens);
      if (score > bestScore) {
        bestScore = score;
        match = entry;
      }
    }
  }

  if (match) {
    const nextSeen = match.seenCount + 1;
    const nextTitles = absorbTitle(match, candidate.title);
    const nextPriority = escalatePriority(
      match.priority,
      nextSeen,
      config.recurrence_escalate_n,
    );
    db.prepare(
      `UPDATE suggestions
          SET seen_count = ?,
              last_seen_at = datetime('now'),
              expires_at = datetime('now', ?),
              recurrence_titles = ?,
              priority = ?
        WHERE id = ?`,
    ).run(
      nextSeen,
      `+${PENDING_TTL_DAYS} days`,
      JSON.stringify(nextTitles),
      nextPriority,
      match.id,
    );
    // Keep the in-run index current so a third sighting bumps the same row.
    match.seenCount = nextSeen;
    match.priority = nextPriority;
    match.recurrenceTitles = nextTitles;
    return 'bumped';
  }

  const projectSlug = candidate.project_slug ?? (ctx.project === 'all' ? null : ctx.project);

  // C — the operator already said no to this finding.
  if (
    isSuppressedByDismissal(
      db,
      SUBCONSCIOUS_INSTANCE_ID,
      projectSlug,
      key,
      detectorConfig,
    )
  ) {
    return 'suppressed';
  }

  // D — a new finding.
  const suggestedAction = candidate.suggested_action
    ? JSON.stringify(candidate.suggested_action)
    : null;
  const confidence = typeof candidate.confidence === 'number' ? candidate.confidence : null;

  const result = db
    .prepare(
      `INSERT INTO suggestions
         (source_module, project_slug, title, evidence, priority, status,
          created_at, expires_at, confidence, suggested_action, type_inferred,
          dedupe_key, entity_key, seen_count, recurrence_titles, source_instance)
       VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'),
               datetime('now', ?), ?, ?, 1, ?, ?, 1, '[]', ?)`,
    )
    .run(
      candidate.source_module,
      projectSlug,
      candidate.title,
      JSON.stringify(candidate.evidence),
      candidate.priority,
      `+${PENDING_TTL_DAYS} days`,
      confidence,
      suggestedAction,
      key,
      anchor,
      SUBCONSCIOUS_INSTANCE_ID,
    );

  // Track in-run so two candidates for one finding don't both insert.
  const entry: PendingEntry = {
    id: Number(result.lastInsertRowid),
    dedupeKey: key,
    claim,
    title: candidate.title,
    seenCount: 1,
    priority: candidate.priority,
    recurrenceTitles: [],
  };
  const existing = ctx.existingPending.get(anchor);
  if (existing) existing.push(entry);
  else ctx.existingPending.set(anchor, [entry]);
  return 'inserted';
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
          existingPending: new Map(),
          digest_bytes: 0,
        };
      // TD-440 — the outcome is DELIBERATELY discarded. `runExtractor` counts
      // non-throwing calls and fails the run with `db_error` at zero, so
      // signalling a dedup by throwing (or by returning early from the slot's
      // caller) would report a fully-deduplicated run — this brief's success
      // state — as `run_failed`. Pinned by `__tests__/recurrence.test.ts`.
      persistSubconsciousCandidate(db, candidate, ctx, config, DEFAULT_DETECTOR_CONFIG);
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
