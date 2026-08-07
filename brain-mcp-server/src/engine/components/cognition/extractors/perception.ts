/**
 * Brain Engine v7.1 — Cognition instance: PERCEPTION (FR-118 M1).
 *
 * The proving instance. Perception is the **co-equal first instance** of the
 * agnostic cognition host, NOT a migration afterthought: it declares the
 * `CognitionInstance` contract over the SAME pure helpers the perception
 * pipeline has always used, so the engine (`runExtractor`) reproduces today's
 * perception behavior byte-for-byte. Perception's existing behavioral /
 * integration tests are the ORACLE — if this wiring diverged, they would fail.
 *
 * The three differing slots (FR-118):
 *   - INPUT  (`buildContext`):  parse the transcript → `TranscriptEvent[]`
 *   - PROMPT (`promptBuilder`): perception's `buildSystemPrompt`/`buildUserPrompt`
 *   - OUTPUT (`persistCandidate`): INSERT a `learnings` row + embedding (+ dedup)
 *
 * R-OVER-ABSTRACT guard (FR-118): perception's quirks — the cost-bytes gate,
 * the LLM confidence cap, the embedding-dedup pre-filter — live HERE, in the
 * instance slots + the instance config, NOT in the agnostic engine. The engine
 * still knows nothing about perception.
 *
 * Back-compat: perception's default harness stays `claude` (no behavior change).
 * The `parseResponse` reuses perception's `extractJsonArrayReply` + `validateAndCoerce`
 * so the same JSON shapes (raw array / fenced / `{result}` envelope) are accepted.
 *
 * @module engine/components/cognition/extractors/perception
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
  buildSystemPrompt,
  buildUserPrompt,
  extractJsonArrayReply,
  isPerceptionReplyWellFormed,
  validateAndCoerce,
  type LlmExtractorContext,
} from '../../perception/extractors/llm_via_claude_code.js';
import { parseTranscript } from '../../perception/handlers.js';
import {
  DEFAULT_PERCEPTION_CONFIG,
  type PerceptionCandidate,
  type PerceptionExtractorConfig,
  type TranscriptEvent,
} from '../../perception/types.js';
import {
  generateEmbedding,
  embeddingToBuffer,
  EMBEDDING_MODEL,
} from '../../../../utils/embeddings.js';
import {
  isVectorSearchAvailable,
  insertEmbedding,
} from '../../../../utils/vector-search.js';
import {
  normalizeForDedup,
  dedupeByTitle,
  findNearestMatch,
  recordRediscovery,
} from '../../perception/dedup.js';
import { writePerceptionEvent } from '../../perception/events.js';

// ---------------------------------------------------------------------------
// The instance's private context shape (slot 1 output)
// ---------------------------------------------------------------------------

/**
 * Perception's private context — the parsed transcript plus the framing the
 * prompt + persist slots need. Opaque to the engine; only `inputBytes(ctx)`
 * exposes a size for the engine's cost-bytes gate.
 */
export interface PerceptionContext {
  /** The parsed transcript events the LLM reasons over. */
  events: TranscriptEvent[];
  /** Project slug — used by the prompt + the persist INSERT. */
  project: string;
  /** Optional brief id threaded into the prompt + persisted into source_brief. */
  brief_id?: string;
  /** The resolved perception config (cap/auto-approve/etc.) for persistence. */
  config: PerceptionExtractorConfig;
  /** Transcript size in UTF-8 bytes (the cost-gate input). */
  transcript_bytes: number;
  /**
   * The extraction trigger label ('detached' | 'mcp_submit' | …). Threaded into
   * the `perception.rediscovery` event the persist-time cosine dedup emits, so
   * the rediscovery payload carries the same trigger dimension the lifecycle
   * events do. Defaults to 'unknown' when the caller omits it.
   */
  trigger: string;
}

// ---------------------------------------------------------------------------
// Per-candidate persist outcome (FR-118 M4a — the instance owns dedup now)
// ---------------------------------------------------------------------------

/**
 * The disposition of one `persistCandidate` call. The cognition perception
 * instance is now the SINGLE owner of persistence + the cosine dedup pre-filter
 * (FR-118 M4a — the runner's duplicate `persistCandidate` was deleted). The
 * engine only counts non-throwing `persistCandidate` calls, but `runPerception`
 * (the oracle) needs to distinguish inserted-vs-deduped to shape its
 * `RunPerceptionResult`. The instance records one outcome per candidate into a
 * per-run accumulator (`takeOutcomes()`) that `runPerception` drains.
 */
export type PerceptionPersistOutcome =
  | { kind: 'inserted'; id: number; source_extractor: PerceptionCandidate['source_extractor'] }
  | { kind: 'deduped'; matched_id: number };

/**
 * The cognition perception instance + its per-run outcome accumulator. The
 * factory returns this composite so `runPerception` can read what the instance
 * persisted (inserted ids / deduped ids) without widening the agnostic
 * `CognitionInstance` contract (R-OVER-ABSTRACT — the engine still reads only
 * the contract; the outcome surface is perception-private).
 */
export interface PerceptionInstanceBundle {
  instance: CognitionInstance<PerceptionContext, PerceptionCandidate>;
  /**
   * Drain + clear the outcomes recorded since the last drain. `runPerception`
   * calls this once after the engine's persist loop to shape its result. The
   * `parseResponse` title-dedup count is reported separately via
   * `takeSuppressed()`.
   */
  takeOutcomes(): PerceptionPersistOutcome[];
  /** Drain + clear the intra-run title-dedup suppressed count from the last parse. */
  takeSuppressed(): number;
  /**
   * Set the per-run context + reset the accumulators WITHOUT re-parsing a
   * transcript. Used by `runPerception` (the oracle wrapper, FR-118 M4a A2): it
   * already holds the parsed `events`, so it builds the `PerceptionContext`
   * directly and hands it here, then drives `persistCandidate` per kept
   * candidate. The engine path uses `buildContext` instead (which parses from
   * `args.transcript_text` and calls the same internal setter). One owner of
   * persistence; two entry points for setting up the run context.
   */
  beginRun(ctx: PerceptionContext): void;
}

// ---------------------------------------------------------------------------
// Config resolution helper (default harness = claude — back-compat)
// ---------------------------------------------------------------------------

/**
 * Map perception's existing config knobs onto the engine's per-instance
 * `CognitionInstanceConfig` envelope. Perception's default harness stays
 * `claude` (back-compat — the global `llm_extractor.harness` / env can still
 * override via `resolveHarness`, but the instance's own `harness` is left
 * `null` so it inherits the global default rather than pinning claude).
 *
 * The cost-bytes gate maps to `min_input_bytes`; the LLM timeout maps to
 * `timeout_ms`. `daily_budget` defaults high (perception runs are hook-driven,
 * not a heavy cron — the budget envelope is a safety wall, not a tight quota).
 */
export function perceptionInstanceConfig(
  config: PerceptionExtractorConfig = DEFAULT_PERCEPTION_CONFIG,
): CognitionInstanceConfig {
  return {
    timeout_ms: config.llm_timeout_ms,
    // Perception is hook-driven (session_end / pre_compact); the daily budget
    // is a runaway-cost wall, not a tight quota. 1000 is effectively unbounded
    // for the hook cadence while still bounding a pathological loop.
    daily_budget: 1000,
    min_input_bytes: config.llm_min_transcript_bytes,
    enabled: config.extractor_llm_enabled,
    // null = inherit the global llm_extractor.harness default (which is
    // 'claude'). Perception does NOT pin claude here — back-compat is preserved
    // by the global default, and a non-claude install can still re-point it.
    harness: null,
  };
}

// ---------------------------------------------------------------------------
// Persist helper (slot 2 — OUTPUT TABLE: learnings INSERT + embedding)
// ---------------------------------------------------------------------------

/**
 * Persist one perception candidate — the SINGLE owner of the perception
 * persist-time pipeline (FR-118 M4a, absorbing the runner's deleted copy):
 *
 *   1. COSINE DEDUP PRE-FILTER (gated on `config.dedup_enabled`): before INSERT,
 *      run `findNearestMatch`; on a hit ≥ `dedup_cosine_threshold`,
 *      `recordRediscovery` (bump `seen_again_count` + stamp `last_seen_at`),
 *      write the `perception.rediscovery` event via the shared lifecycle writer,
 *      and RETURN `{kind:'deduped'}` WITHOUT inserting.
 *   2. INSERT a `learnings` row:
 *        - title/content truncated to schema-safe bounds
 *        - `provenance='inferred'` (permanent forensic marker)
 *        - `review_status` = 'approved' iff `config.auto_approve_enabled`, else 'pending_review'
 *        - best-effort embedding using the TD-087-normalised fingerprint
 *
 * The cosine pre-filter lives HERE (not in the agnostic engine) — the engine
 * never learns about perception's cosine dedup (R-OVER-ABSTRACT honored). The
 * embedding step is best-effort: a failure logs and does not block the INSERT.
 *
 * Returns the per-candidate outcome so the instance's accumulator (and through
 * it `runPerception`) can shape `inserted`/`deduped` counts.
 */
export async function persistPerceptionCandidate(
  db: Database.Database,
  candidate: PerceptionCandidate,
  ctx: PerceptionContext,
): Promise<PerceptionPersistOutcome> {
  const config = ctx.config;

  // 1. Cosine dedup pre-filter (TD-086 + TD-087). Gated on config.dedup_enabled.
  //    On a near-duplicate hit we skip the INSERT, bump the matched row's
  //    seen_again_count, and emit a single `perception.rediscovery` event whose
  //    payload carries the matched status + similarity. The flag is the operator
  //    kill switch — flip off via env/config.json if the threshold misbehaves.
  if (config.dedup_enabled) {
    const match = await findNearestMatch(db, candidate, config.dedup_cosine_threshold);
    if (match) {
      recordRediscovery(db, match.matched_id);
      // The shared perception lifecycle writer keeps the LEGACY component +
      // event name (`component='perception'`, `perception.rediscovery`) so the
      // oracle + /scan + /awaken read surfaces stay byte-identical (FR-118 P-1).
      writePerceptionEvent(db, 'perception.rediscovery', {
        project: ctx.project,
        existing_learning_id: match.matched_id,
        existing_status: match.status,
        similarity_score: match.similarity,
        transcript_window_ts: new Date().toISOString(),
        trigger: ctx.trigger,
      });
      return { kind: 'deduped', matched_id: match.matched_id };
    }
  }

  // 2. INSERT.
  const safeTitle = candidate.title.slice(0, 500);
  const safeContent = candidate.content.slice(0, 1_000_000);
  const tags = candidate.tags.join(',');
  const sourceBrief = ctx.brief_id ? ctx.brief_id : '';
  const reviewStatus = config.auto_approve_enabled ? 'approved' : 'pending_review';

  const stmt = db.prepare(`
    INSERT INTO learnings
      (project, category, title, content, tags, tech_stack, source_brief,
       scope, confidence, provenance, review_status, source_extractor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    ctx.project,
    candidate.category,
    safeTitle,
    safeContent,
    tags,
    candidate.tech_stack ?? '',
    sourceBrief,
    'local',
    candidate.confidence,
    'inferred',
    reviewStatus,
    candidate.source_extractor,
  );
  const id = result.lastInsertRowid as number;

  // Best-effort embedding — TD-087 fingerprint keeps dedup geometry consistent.
  try {
    if (isVectorSearchAvailable(db)) {
      const fingerprint = `${normalizeForDedup(safeTitle)} ${normalizeForDedup(safeContent)}`.trim();
      const embedding = await generateEmbedding(fingerprint);
      db.prepare('UPDATE learnings SET embedding = ?, embedding_model = ? WHERE id = ?').run(
        embeddingToBuffer(embedding),
        EMBEDDING_MODEL,
        id,
      );
      insertEmbedding(db, id, embedding);
    }
  } catch (err) {
    console.error(
      '[cognition.perception] auto-embed failed for row',
      id,
      err instanceof Error ? err.message : String(err),
    );
  }
  return { kind: 'inserted', id, source_extractor: candidate.source_extractor };
}

// ---------------------------------------------------------------------------
// The instance factory
// ---------------------------------------------------------------------------

/**
 * Build the BEHAVIOR-COMPLETE perception cognition instance for a resolved
 * perception config, plus its per-run outcome accumulator (FR-118 M4a).
 *
 * The slots delegate to perception's pure helpers so the agnostic engine
 * reproduces today's behavior byte-for-byte (the 6 oracle tests):
 *   - `buildContext`  — `parseTranscript` (the same parse the submit handler uses)
 *   - `promptBuilder` — `buildSystemPrompt` + `buildUserPrompt`
 *   - `parseResponse` — `extractJsonArrayReply` + `validateAndCoerce` + the
 *                       INTRA-RUN TITLE DEDUP (`dedupeByTitle`) so the candidate
 *                       set the engine persists is already title-deduped (M4a A1).
 *   - `persistCandidate` — the SINGLE owner of the cosine dedup pre-filter +
 *                       `recordRediscovery` + the `perception.rediscovery` event
 *                       + the `learnings` INSERT + embedding (M4a A1).
 *   - `inputBytes`    — the transcript byte size (perception's cost gate input)
 *
 * The `CognitionInstance.persistCandidate(db, candidate)` slot receives no
 * per-run context (the engine counts persisted rows; it does not own the
 * instance's private project/brief). The engine drives ONE run sequentially —
 * `buildContext` then per-candidate `persistCandidate` — so the instance stashes
 * the context built this run in a closure cell that `persistCandidate` reads.
 * That keeps project/brief flowing to the INSERT without widening the agnostic
 * contract (R-OVER-ABSTRACT: the engine stays context-free).
 *
 * CONCURRENCY INVARIANT (M4a A2): a FRESH instance bundle is built per
 * component-run path (`createPerceptionInstance` is called per run, config
 * resolved at run time — never a singleton). The `currentCtx` + outcome
 * accumulator cells are therefore run-private; the engine runs one instance
 * sequentially so they never race.
 */
export function createPerceptionInstance(
  config: PerceptionExtractorConfig = DEFAULT_PERCEPTION_CONFIG,
): PerceptionInstanceBundle {
  // The context built this run — set by buildContext, read by persistCandidate.
  // The engine runs one instance sequentially (build → parse → persist loop),
  // so a single cell is safe; a fresh instance is built per component-run path.
  let currentCtx: PerceptionContext | null = null;
  // Per-run accumulators (M4a): parse-time title-dedup suppressed count +
  // per-candidate persist outcomes. Reset by buildContext/beginRun; drained by
  // `takeSuppressed()` / `takeOutcomes()` after the persist loop.
  let suppressed = 0;
  let outcomes: PerceptionPersistOutcome[] = [];

  /** Set the run context + reset the per-run accumulators. One owner. */
  function startRun(ctx: PerceptionContext): void {
    currentCtx = ctx;
    suppressed = 0;
    outcomes = [];
  }

  const instance: CognitionInstance<PerceptionContext, PerceptionCandidate> = {
    id: 'perception',

    // TD-327 — the REQUIRED observability declaration. PERCEPTION IS THE
    // EXCEPTION THAT MAKES THIS FIELD NECESSARY: `registry.ts:42` says an id
    // "becomes its `event_log.component` namespace `cognition.<id>`", and
    // perception does not obey it. Its production path is
    // `perception/runner.ts`, which calls `writePerceptionEvent(db,
    // 'perception.run_started', …)` — so BOTH the component and the event-name
    // prefix are the LEGACY bare `perception`, and `cognition.perception` has
    // never had a single row. MAINTAINING's L-857 row states the rule these two
    // literals encode: assert the literal, do not derive it. A health surface
    // that iterates `cognition.*` silently omits the healthiest instance.
    health: {
      component: 'perception',
      event_prefix: 'perception',
      gate_keys: ['cognition.perception.enabled'],
      // The one instance whose RESOLVER default is ON for an absent key — NOT
      // its shipped posture (install writes it false, FR-191; see types.ts
      // #gate_default and MAINTAINING row 73). DEFAULT_PERCEPTION_CONFIG sets
      // `extractor_llm_enabled: true`, so an absent key means ENABLED here
      // and DISABLED for every other instance. Declared, never assumed.
      gate_default: true,
      // Spawned out of band at session end / pre-compact by
      // `perception_extract_and_persist.sh`, not by a `schedules` row. It also
      // has manual MCP entry points, but the hook is the routine driver.
      driver: 'session_hook',
      driver_ref: 'session_end',
      output: "learnings[review_status='pending_review']",
    },

    async buildContext(
      _db: Database.Database,
      args: ExtractorArgs,
    ): Promise<PerceptionContext> {
      const project = typeof args.project === 'string' ? args.project : '';
      const transcriptText =
        typeof args.transcript_text === 'string' ? args.transcript_text : '';
      const events = parseTranscript(transcriptText);
      const transcript_bytes = events.reduce(
        (n, e) => n + (e.content?.length ?? 0),
        0,
      );
      const ctx: PerceptionContext = {
        events,
        project,
        config,
        transcript_bytes,
        trigger: typeof args.trigger === 'string' ? args.trigger : 'unknown',
      };
      if (typeof args.brief_id === 'string') ctx.brief_id = args.brief_id;
      startRun(ctx);
      return ctx;
    },

    promptBuilder(ctx: PerceptionContext): ExtractorPrompt {
      const llmCtx: LlmExtractorContext = { project: ctx.project };
      if (ctx.brief_id) llmCtx.brief_id = ctx.brief_id;
      return {
        system: buildSystemPrompt(),
        user: buildUserPrompt(ctx.events, llmCtx),
      };
    },

    parseResponse(raw: string): PerceptionCandidate[] {
      const arr = extractJsonArrayReply(raw);
      const validated = arr
        .map(validateAndCoerce)
        .filter((c): c is PerceptionCandidate => c !== null)
        .slice(0, config.llm_max_candidates);
      // M4a A1: intra-run title dedup, BEFORE returning — the engine persists
      // the already-deduped set. Records the suppressed count for `runPerception`.
      const { kept, suppressed: sup } = dedupeByTitle(validated);
      suppressed = sup;
      return kept;
    },

    // TD-295 — a well-formed (possibly empty) array is a VALID EMPTY judgment
    // ("nothing worth learning from this session"), not a parse_error. Consulted
    // by the engine only when parseResponse yields zero candidates. Reuses
    // perception's OWN parse leniency (fences + `{result}` envelope) so the
    // verdict matches exactly what parseResponse accepts.
    isMalformedResponse: (raw) => !isPerceptionReplyWellFormed(raw),

    async persistCandidate(
      db: Database.Database,
      candidate: PerceptionCandidate,
    ): Promise<void> {
      // Read the context built this run (set by buildContext). If somehow
      // absent (no run context), fall back to a minimal context so the INSERT
      // still records provenance/review_status — but project/brief would be
      // empty, which only happens if persistCandidate is called out of band.
      const ctx: PerceptionContext = currentCtx ?? {
        events: [],
        project: '',
        config,
        transcript_bytes: 0,
        trigger: 'unknown',
      };
      const outcome = await persistPerceptionCandidate(db, candidate, ctx);
      outcomes.push(outcome);
    },

    config: perceptionInstanceConfig(config),

    inputBytes(ctx: PerceptionContext): number {
      return ctx.transcript_bytes;
    },
  };

  return {
    instance,
    takeOutcomes(): PerceptionPersistOutcome[] {
      const drained = outcomes;
      outcomes = [];
      return drained;
    },
    takeSuppressed(): number {
      const s = suppressed;
      suppressed = 0;
      return s;
    },
    beginRun(ctx: PerceptionContext): void {
      startRun(ctx);
    },
  };
}

/**
 * The default-config perception instance registered by the barrel. Production
 * resolves the live config at component init / per run; the barrel export gives
 * the OPEN registry a discoverable instance (the FR-202 zero-host-change
 * property) and the engine a runnable default. The barrel only needs the
 * `CognitionInstance` (not the outcome accumulator), so it unwraps `.instance`.
 */
export const perceptionInstance: CognitionInstance<
  PerceptionContext,
  PerceptionCandidate
> = createPerceptionInstance().instance;
