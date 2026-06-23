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
import { normalizeForDedup } from '../../perception/dedup.js';

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
 * Persist one perception candidate as a `learnings` row, mirroring the
 * perception runner's `persistCandidate` exactly:
 *   - title/content truncated to schema-safe bounds
 *   - `provenance='inferred'` (permanent forensic marker)
 *   - `review_status` = 'approved' iff `config.auto_approve_enabled`, else 'pending_review'
 *   - best-effort embedding using the TD-087-normalised fingerprint
 *
 * The embedding step is best-effort: a failure logs and does not block the
 * INSERT (approval stays a pure status flip without a re-embed).
 */
export async function persistPerceptionCandidate(
  db: Database.Database,
  candidate: PerceptionCandidate,
  ctx: PerceptionContext,
): Promise<number> {
  const config = ctx.config;
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
  return id;
}

// ---------------------------------------------------------------------------
// The instance factory
// ---------------------------------------------------------------------------

/**
 * Build the perception cognition instance for a resolved perception config.
 *
 * The slots delegate to perception's existing pure helpers so the agnostic
 * engine reproduces today's behavior:
 *   - `buildContext`  — `parseTranscript` (the same parse the submit handler uses)
 *   - `promptBuilder` — `buildSystemPrompt` + `buildUserPrompt`
 *   - `parseResponse` — `extractJsonArrayReply` + `validateAndCoerce`
 *   - `persistCandidate` — the `learnings` INSERT + embedding above
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
 * Note: the embedding-cosine dedup pre-filter remains perception's own concern
 * in the FULL pipeline (`runPerception`), which is the unit-tested ORACLE path.
 * This instance carries the cap-+validate parse and the learnings persistence;
 * the dedup pre-filter is layered in as the instance's pipeline matures (M2+).
 */
export function createPerceptionInstance(
  config: PerceptionExtractorConfig = DEFAULT_PERCEPTION_CONFIG,
): CognitionInstance<PerceptionContext, PerceptionCandidate> {
  // The context built this run — set by buildContext, read by persistCandidate.
  // The engine runs one instance sequentially (build → parse → persist loop),
  // so a single cell is safe; a fresh instance is built per component-run path.
  let currentCtx: PerceptionContext | null = null;

  return {
    id: 'perception',

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
      };
      if (typeof args.brief_id === 'string') ctx.brief_id = args.brief_id;
      currentCtx = ctx;
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
      return arr
        .map(validateAndCoerce)
        .filter((c): c is PerceptionCandidate => c !== null)
        .slice(0, config.llm_max_candidates);
    },

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
      };
      await persistPerceptionCandidate(db, candidate, ctx);
    },

    config: perceptionInstanceConfig(config),

    inputBytes(ctx: PerceptionContext): number {
      return ctx.transcript_bytes;
    },
  };
}

/**
 * The default-config perception instance registered by the barrel. Production
 * resolves the live config at component init and rebinds; the barrel export
 * gives the OPEN registry a discoverable instance (the FR-202 zero-host-change
 * property) and the engine a runnable default.
 */
export const perceptionInstance: CognitionInstance<
  PerceptionContext,
  PerceptionCandidate
> = createPerceptionInstance();
