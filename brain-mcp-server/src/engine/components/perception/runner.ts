/**
 * Brain Engine — Perception Runner (FR-109 + TD-066).
 *
 * LLM-only orchestration:
 *   1. Apply cost gate (disabled / bytes / ran).
 *   2. If gate passes, invoke the LLM extractor.
 *   3. Dedupe by (normalized title) within the run.
 *   4. Persist each candidate as a `learnings` row, with `review_status`
 *      = 'approved' iff `config.auto_approve_enabled=true`, else 'pending_review'.
 *
 * Rule extractors were removed in TD-066 — heuristic regexes were brittle and
 * the LLM extractor proved more reliable. Existing `rule:*` rows in production
 * databases remain readable (TS-only enum narrowing on the insert path).
 *
 * The runner is a pure function over a `Database` handle and a config struct.
 * Handlers wire it to the gateway and the bus; the runner does not know about
 * MCP.
 *
 * @module engine/components/perception/runner
 * @author Fifty.ai
 */

import type Database from 'better-sqlite3';
import type {
  PerceptionCandidate,
  PerceptionExtractorConfig,
  TranscriptEvent,
  SourceExtractor,
} from './types.js';
import type {
  ExtractorLogger,
  LlmExtractor,
  LlmExtractorContext,
} from './extractors/llm_via_claude_code.js';
import { noopLlmExtractor } from './extractors/llm_via_claude_code.js';
import type { PerceptionEventName } from './events.js';
import { writePerceptionEvent } from './events.js';
import { generateEmbedding, embeddingToBuffer, EMBEDDING_MODEL } from '../../../utils/embeddings.js';
import { isVectorSearchAvailable, insertEmbedding } from '../../../utils/vector-search.js';
import { findNearestMatch, recordRediscovery } from './dedup.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Possible LLM-status values returned by `runPerception`. Used by
 * `igris_perception_extract_now` so operators can see which gate fired.
 *
 * Post-TD-066 ladder: `disabled` | `bytes` | `ran`. The pre-TD-066
 * `'skipped:rules_sufficient'` value was removed along with the rule
 * extractors.
 *
 * TD-079: extended with `failed:*` variants. The runner observes the
 * extractor's terminal `perception.run_failed` event via `wrappedLog.onEvent`
 * and overwrites `result.llm_status` so callers (the CLI summary line, MCP
 * tool surface, dashboards) see the actual failure reason instead of the
 * misleading `'ran'` that the gate set when the LLM was invoked.
 */
export type LlmStatus =
  | 'ran'
  | 'skipped:disabled'
  | 'skipped:cost'
  | 'skipped:cli_missing'
  | 'skipped:bytes'
  | 'failed:timeout'
  | 'failed:epipe'
  | 'failed:spawn_error'
  | 'failed:non_zero_exit'
  | 'failed:unknown';

/**
 * Map the extractor's `perception.run_failed` reason string onto the
 * `failed:*` member of `LlmStatus`. Used by both `wrappedLog.onEvent` (when
 * the extractor pre-emits a terminal failure) and the runner-level catch
 * blocks (when the extractor throws or DB infra fails) so all three
 * call sites stay consistent.
 *
 * Unknown reasons collapse to `'failed:unknown'` rather than throwing — the
 * runner never aborts a run because of an unrecognised reason string.
 */
function mapFailureReasonToLlmStatus(reason: string): LlmStatus {
  switch (reason) {
    case 'timeout':
      return 'failed:timeout';
    case 'epipe_on_llm_stdin':
      return 'failed:epipe';
    case 'spawn_error':
      return 'failed:spawn_error';
    case 'non_zero_exit':
      return 'failed:non_zero_exit';
    default:
      return 'failed:unknown';
  }
}

export interface RunPerceptionOptions {
  /** Parsed transcript events to scan. */
  events: TranscriptEvent[];
  /** Project slug. Required — used for INSERT and dedupe scoping. */
  project: string;
  /** Optional brief id for evidence and prompt context. */
  brief_id?: string;
  /** Source label written into evidence for forensics (e.g. 'session_end', 'pre_compact'). */
  source: string;
  /** When true, bypass the bytes cost gate (correctness gate is never bypassed). */
  force_llm?: boolean;
  /**
   * Trigger label written into perception lifecycle events (TD-074).
   * Conventional values: 'detached' (CLI), 'mcp_submit', 'mcp_extract_now'.
   * Defaults to 'unknown' when callers do not pass one — older call sites
   * still produce structured events, just without the trigger dimension.
   */
  trigger?: string;
}

export interface RunPerceptionResult {
  /** Candidates emitted by the LLM extractor (pre-dedupe). */
  llm_extracted: number;
  /** Candidates suppressed by intra-run dedupe. */
  suppressed: number;
  /** Candidates inserted (review_status depends on auto_approve_enabled). */
  inserted: number;
  /** New learning ids inserted by this run. */
  inserted_ids: number[];
  /** Status of the LLM gate. */
  llm_status: LlmStatus;
  /** Per-source breakdown of inserted candidates. */
  by_source: Record<SourceExtractor, number>;
  /**
   * Candidates skipped by the cheap-dedup pre-filter (TD-086) — matched an
   * existing learning above `dedup_cosine_threshold`. The matched row's
   * `seen_again_count` was incremented in lieu of inserting a duplicate.
   */
  deduped: number;
  /** `learnings.id` of every existing row whose seen_again_count was bumped. */
  deduped_ids: number[];
}

// ---------------------------------------------------------------------------
// Cost gate
// ---------------------------------------------------------------------------

interface GateDecision {
  shouldRun: boolean;
  status: LlmStatus;
}

/**
 * Decide whether to run the LLM extractor given transcript size and config.
 *
 * Gate ladder (TD-066):
 *   1. `extractor_llm_enabled=false`  → skip:disabled (correctness gate)
 *   2. transcript_bytes < threshold   → skip:bytes   (cost gate, bypassable)
 *   3. otherwise                       → ran
 *
 * `force_llm` only bypasses the cost gate (step 2). The correctness gate
 * (`extractor_llm_enabled=false`) is never bypassed — that's an operator
 * decision, not a cost decision.
 *
 * The `ruleCount` parameter is preserved for ABI compatibility but ignored
 * post-TD-066. New code passes 0.
 */
export function evaluateLlmGate(
  ruleCount: number,
  transcriptBytes: number,
  config: PerceptionExtractorConfig,
  forceLlm: boolean,
): GateDecision {
  void ruleCount;
  if (!config.extractor_llm_enabled) {
    return { shouldRun: false, status: 'skipped:disabled' };
  }
  if (!forceLlm && transcriptBytes < config.llm_min_transcript_bytes) {
    return { shouldRun: false, status: 'skipped:bytes' };
  }
  return { shouldRun: true, status: 'ran' };
}

// ---------------------------------------------------------------------------
// Dedupe (intra-run)
// ---------------------------------------------------------------------------

/** Normalize a title for dedupe equality: lowercase, collapse whitespace. */
function dedupeKey(c: PerceptionCandidate): string {
  return c.title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Within-run dedupe by normalized title. Highest-confidence wins; on a tie,
 * the first occurrence is kept (insertion order is stable). Rule-vs-LLM
 * tie-break logic was dropped in TD-066 — only LLM emits candidates now.
 */
export function dedupeByTitle(
  candidates: PerceptionCandidate[],
): { kept: PerceptionCandidate[]; suppressed: number } {
  const buckets = new Map<string, PerceptionCandidate[]>();
  for (const c of candidates) {
    const key = dedupeKey(c);
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }
  const kept: PerceptionCandidate[] = [];
  let suppressed = 0;
  for (const list of buckets.values()) {
    if (list.length === 1) {
      kept.push(list[0]);
      continue;
    }
    list.sort((a, b) => b.confidence - a.confidence);
    kept.push(list[0]);
    suppressed += list.length - 1;
  }
  return { kept, suppressed };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist a candidate row. Generates an embedding (best-effort — failure
 * does not block the INSERT) so approval is a pure status flip without a
 * re-embed.
 *
 * `review_status` is `'approved'` when `config.auto_approve_enabled=true`
 * (TD-066 — operator opt-in), otherwise `'pending_review'`. `provenance`
 * stays `'inferred'` regardless so the forensic trail survives approval.
 *
 * Tags are joined with comma to match the existing comma-separated convention
 * in `learnings.tags`.
 */
async function persistCandidate(
  db: Database.Database,
  candidate: PerceptionCandidate,
  project: string,
  briefId: string | undefined,
  source: string,
  config: PerceptionExtractorConfig,
): Promise<number> {
  // `source` is the extraction trigger (e.g. 'session_end', 'pre_compact',
  // 'extract_now') — distinct from `candidate.source_extractor`, which names
  // the extractor that produced the row (llm | manual | distill). Both are
  // part of the forensic story: source_extractor is persisted on the row
  // (column added in v15 migration), trigger source is currently bus-only.
  void source;

  // Truncate to schema-friendly bounds without risking ALTER TABLE collisions.
  const safeTitle = candidate.title.slice(0, 500);
  const safeContent = candidate.content.slice(0, 1_000_000);
  const tags = candidate.tags.join(',');

  // Store the brief id (or empty string when none) in `source_brief` — the
  // existing recall path reads this column so the link surfaces in the UI
  // without a schema change. Evidence proper lives in the candidate's
  // `evidence` field at extraction time but is NOT persisted today; if we
  // later want it on the row, add an `evidence` JSON column rather than
  // overloading source_brief. (TD-063 — corrects an earlier comment that
  // claimed evidence was JSON-tagged into this field.)
  const sourceBrief = briefId ? briefId : '';

  const reviewStatus = config.auto_approve_enabled ? 'approved' : 'pending_review';

  const stmt = db.prepare(`
    INSERT INTO learnings
      (project, category, title, content, tags, tech_stack, source_brief,
       scope, confidence, provenance, review_status, source_extractor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    project,
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

  // Best-effort embedding — same shape as memory.handleMemoryStore.
  try {
    if (isVectorSearchAvailable(db)) {
      const embedding = await generateEmbedding(`${safeTitle} ${safeContent}`);
      db.prepare('UPDATE learnings SET embedding = ?, embedding_model = ? WHERE id = ?').run(
        embeddingToBuffer(embedding),
        EMBEDDING_MODEL,
        id,
      );
      insertEmbedding(db, id, embedding);
    }
  } catch (err) {
    console.error(
      '[perception] auto-embed failed for row',
      id,
      err instanceof Error ? err.message : String(err),
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the perception pipeline: cost-gated LLM extractor + dedupe + persist.
 *
 * The runner is the single point that mutates `learnings`. The LLM extractor
 * is pure; persistence is sequenced so an embedding failure on one row does
 * not block the next.
 *
 * Lifecycle events (TD-074): the runner emits exactly one terminal event
 * (`perception.run_succeeded` | `perception.run_failed`) per `run_started`.
 * The extractor may pre-emit `run_failed` via the `onEvent` callback (e.g.
 * EPIPE) — when that happens the runner's `terminalEmitted` flag suppresses
 * the trailing `run_succeeded` so the invariant holds. Emission failures
 * are absorbed inside `writePerceptionEvent` — they never abort the run.
 */
export async function runPerception(
  db: Database.Database,
  options: RunPerceptionOptions,
  config: PerceptionExtractorConfig,
  llmExtractor: LlmExtractor = noopLlmExtractor,
  extractorLog?: ExtractorLogger,
): Promise<RunPerceptionResult> {
  const {
    events,
    project,
    brief_id: briefId,
    source,
    force_llm: forceLlm = false,
    trigger = 'unknown',
  } = options;

  const result: RunPerceptionResult = {
    llm_extracted: 0,
    suppressed: 0,
    inserted: 0,
    inserted_ids: [],
    llm_status: 'skipped:disabled',
    by_source: {
      llm: 0,
      manual: 0,
      distill: 0,
    },
    deduped: 0,
    deduped_ids: [],
  };

  // Empty-events early return is intentionally pre-instrumentation. No
  // `run_started` is emitted because there is nothing observable to do —
  // emitting one would surface as a "stuck RUNNING" false positive in
  // /scan if a terminal event never arrived.
  if (events.length === 0) return result;

  const startedAt = Date.now();
  const transcriptBytes = events.reduce((n, e) => n + (e.content?.length ?? 0), 0);

  writePerceptionEvent(db, 'perception.run_started', {
    project,
    transcript_bytes: transcriptBytes,
    source,
    trigger,
    ...(briefId ? { brief_id: briefId } : {}),
  });

  // `terminalEmitted` enforces the lifecycle invariant: exactly one of
  // `run_succeeded` / `run_failed` per `run_started`. The extractor may
  // pre-emit a failure (EPIPE / timeout / non-zero-exit) via `onEvent`;
  // we observe that here and skip the trailing success.
  let terminalEmitted = false;
  const emit = (name: PerceptionEventName, payload: Record<string, unknown>): void => {
    if (terminalEmitted && name !== 'perception.run_started') return;
    if (name === 'perception.run_succeeded' || name === 'perception.run_failed') {
      terminalEmitted = true;
    }
    writePerceptionEvent(db, name, {
      project,
      trigger,
      duration_ms: Date.now() - startedAt,
      ...payload,
    });
  };

  // Wrap the extractor's onEvent so the runner observes its emissions and
  // updates `terminalEmitted`. The closure-bound `emit` writes via the
  // shared helper and tags every event with project / trigger / duration.
  //
  // TD-079: when the extractor pre-emits `perception.run_failed`, mutate
  // `result.llm_status` from the gate-set `'ran'` to the matching `failed:*`
  // variant before the runner returns. The mutation is bounded to terminal
  // failure events; `terminalEmitted` (set by `emit`) enforces one-shot
  // semantics so repeat emissions cannot ratchet the status further.
  const wrappedLog: ExtractorLogger = {
    info: (msg) => extractorLog?.info(msg),
    warn: (msg) => extractorLog?.warn(msg),
    onEvent: (name, payload) => {
      // Forward to the caller's onEvent if any (so tests can spy on raw
      // calls), then re-emit through the runner's `emit` so the row lands
      // in event_log with the standard envelope.
      extractorLog?.onEvent?.(name, payload);
      if (name === 'perception.run_failed' && typeof payload.reason === 'string') {
        result.llm_status = mapFailureReasonToLlmStatus(payload.reason);
      }
      emit(name, payload);
    },
  };

  try {
    // 1. Cost gate + LLM extractor.
    const gate = evaluateLlmGate(0, transcriptBytes, config, forceLlm);
    result.llm_status = gate.status;
    let llmCandidates: PerceptionCandidate[] = [];
    if (gate.shouldRun) {
      const ctx: LlmExtractorContext = { project };
      if (briefId) ctx.brief_id = briefId;
      try {
        llmCandidates = await llmExtractor(events, ctx, wrappedLog);
      } catch (err) {
        // Defensive: failed LLM call does not block the pipeline. The
        // extractor signature normally settles with `[]`, so reaching
        // this catch implies an unexpected throw — surface it as a
        // structured event with reason='unknown' to disambiguate from
        // the explicit failure modes the extractor itself reports.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          '[perception] LLM extractor threw — continuing without LLM candidates:',
          msg,
        );
        // TD-079: keep the result.llm_status in sync with the emitted
        // failure event. `emit` itself does not mutate the result struct.
        result.llm_status = mapFailureReasonToLlmStatus('unknown');
        emit('perception.run_failed', {
          reason: 'unknown',
          error_message: msg.slice(0, 500),
          transcript_bytes: transcriptBytes,
        });
        llmCandidates = [];
      }
    }
    result.llm_extracted = llmCandidates.length;

    // 2. Dedupe by title.
    const { kept, suppressed } = dedupeByTitle(llmCandidates);
    result.suppressed = suppressed;

    // 3. Persist (review_status = 'approved' iff config.auto_approve_enabled).
    // TD-086: a cheap embeddings-cosine pre-filter runs BEFORE persistCandidate
    // when `config.dedup_enabled`. On a near-duplicate (cosine ≥ threshold
    // against any existing learning, status-aware), we skip the INSERT,
    // bump `seen_again_count` on the matched row, and emit a single
    // `perception.rediscovery` event whose payload carries the matched
    // status. The flag exists as an instant operator kill switch — flip
    // off via env or config.json if the threshold misbehaves in production.
    for (const c of kept) {
      try {
        if (config.dedup_enabled) {
          const match = await findNearestMatch(db, c, config.dedup_cosine_threshold);
          if (match) {
            recordRediscovery(db, match.matched_id);
            result.deduped += 1;
            result.deduped_ids.push(match.matched_id);
            // Single event per Q2 — cleaner API than two distinct event
            // names. The `existing_status` field lets downstream readers
            // distinguish pending-vs-approved rediscoveries.
            // TODO(FR-116): when reject becomes soft-delete (review_status='rejected'),
            // this branch will start surfacing `match.status === 'rejected'`,
            // and handlers.ts will activate the `perception.rejected_pattern_recurring`
            // emit. Until then, only pending_review and approved matches are
            // reachable here — the helper has no rejected rows to find because
            // reject is a hard DELETE today.
            writePerceptionEvent(db, 'perception.rediscovery', {
              project,
              existing_learning_id: match.matched_id,
              existing_status: match.status,
              similarity_score: match.similarity,
              transcript_window_ts: new Date().toISOString(),
              trigger,
            });
            continue;
          }
        }
        const id = await persistCandidate(db, c, project, briefId, source, config);
        result.inserted_ids.push(id);
        result.inserted += 1;
        result.by_source[c.source_extractor] += 1;
      } catch (err) {
        console.error(
          '[perception] persist or dedup failed for candidate, skipping:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Successful return path. If the extractor pre-emitted a `run_failed`,
    // `terminalEmitted` is already true and the success event is skipped.
    // TD-086: include `deduped` so /scan and downstream dashboards can
    // surface the cheap-dedup hit rate without a separate query.
    emit('perception.run_succeeded', {
      candidates_count: result.inserted,
      llm_extracted: result.llm_extracted,
      suppressed: result.suppressed,
      deduped: result.deduped,
      llm_status: result.llm_status,
      transcript_bytes: transcriptBytes,
    });

    return result;
  } catch (err) {
    // Catch-all: a non-extractor throw (DB / embedding infra). Only emit
    // an additional `run_failed` if no terminal event has been written
    // yet — otherwise we would violate the lifecycle invariant.
    const msg = err instanceof Error ? err.message : String(err);
    if (!terminalEmitted) {
      // TD-079: keep the result.llm_status in sync with the emitted
      // failure event for callers that read the result before the
      // exception propagates (e.g. handlers that catch and log).
      result.llm_status = mapFailureReasonToLlmStatus('unknown');
      emit('perception.run_failed', {
        reason: 'unknown',
        error_message: msg.slice(0, 500),
        transcript_bytes: transcriptBytes,
      });
    }
    throw err;
  }
}
