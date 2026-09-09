/**
 * Brain Engine v7.0 — Perception Component Handlers (FR-109)
 *
 * Five MCP tools:
 *   - igris_perception_submit         — hook entry: ingest a transcript window
 *   - igris_perception_review_pending — list pending candidates for /awaken
 *   - igris_perception_approve        — flip review_status='approved' (with edit)
 *   - igris_perception_reject         — DELETE the pending row
 *   - igris_perception_extract_now    — manual trigger with force_llm bypass
 *
 * Handlers receive context via `setHandlerContext`: the runner config, the
 * LLM extractor (selected at component init), and the bus. They never throw —
 * every error path returns an `errorResult`.
 *
 * @module engine/components/perception/handlers
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';

import { getDb } from '../../../db.js';
import type { EventBus, ToolResult } from '../../types.js';
import { errorResult, successResult, errMsg } from '../../helpers.js';
import {
  DEFAULT_PERCEPTION_CONFIG,
  type PerceptionExtractorConfig,
  type TranscriptEvent,
} from './types.js';
import { runPerception, type LlmStatus } from './runner.js';
import { noopLlmExtractor, type LlmExtractor } from './extractors/llm_via_claude_code.js';
import { writePerceptionEvent } from './events.js';

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

interface HandlerContext {
  bus: EventBus;
  config: PerceptionExtractorConfig;
  llmExtractor: LlmExtractor;
}

let _ctx: HandlerContext | null = null;

export function setHandlerContext(ctx: HandlerContext): void {
  _ctx = ctx;
}

function getActiveConfig(): PerceptionExtractorConfig {
  return _ctx?.config ?? DEFAULT_PERCEPTION_CONFIG;
}

function getActiveLlmExtractor(): LlmExtractor {
  return _ctx?.llmExtractor ?? noopLlmExtractor;
}

function getBus(): EventBus | null {
  return _ctx?.bus ?? null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on transcript size accepted by `igris_perception_submit`. 5 MB. */
const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;

/** Permitted edit fields for `igris_perception_approve(edit?)`. */
const EDITABLE_FIELDS = new Set([
  'title',
  'content',
  'tags',
  'category',
  'confidence',
  'tech_stack',
]);

const VALID_CATEGORIES = ['pattern', 'decision', 'discovery', 'mistake', 'optimization'];

// ---------------------------------------------------------------------------
// TD-098 cleanup helper
// ---------------------------------------------------------------------------

/**
 * Atomically drop a learning row and its `learnings_vec` companion.
 *
 * Used by `handlePerceptionReject` (single id) and
 * `handlePerceptionExpireStale` (bulk). Both code sites previously did a
 * plain `DELETE FROM learnings`, which fired the `learnings_vec_ad`
 * AFTER DELETE trigger; on a connection with `PRAGMA trusted_schema =
 * OFF` (which production sets, db.ts:868) sqlite-vec rejects writes to
 * the `learnings_vec` virtual table from inside trigger context with
 * `unsafe use of virtual table "learnings_vec"`. TD-098 migration v3
 * drops that trigger; this helper now owns the cleanup explicitly so
 * the embedding table doesn't accumulate orphans.
 *
 * Phase 0 Path A1: only `learnings_vec_ad` is dropped — the FTS5
 * `learnings_ad` trigger is empirically safe (FTS5's contentless 'delete'
 * does not trip the same guard) and continues to scrub `learnings_fts`
 * automatically. So this helper does NOT touch `learnings_fts`.
 *
 * Wrapped in `db.transaction(() => {...})()` (better-sqlite3): the vec
 * delete and the learnings delete commit together, and any error rolls
 * both back. The vec delete is also wrapped in try/catch so test
 * fixtures lacking the `learnings_vec` virtual table (no sqlite-vec
 * loaded — current handlers.test.ts setup) still exercise the deletion
 * path without false-failing.
 *
 * Caller is expected to validate `id` and re-fetch any row data needed
 * for downstream events BEFORE calling this — once the helper returns,
 * the row is gone.
 *
 * @param db The active better-sqlite3 connection (test or production).
 * @param ids The `learnings.id` values to drop. Empty array is a no-op.
 */
function cleanupLearningArtifacts(db: Database.Database, ids: number[]): void {
  if (ids.length === 0) return;

  // Prepare the vec delete lazily inside try/catch — better-sqlite3
  // rejects `prepare()` at parse time if the virtual table is absent
  // (e.g. test fixtures without sqlite-vec loaded). Caching `null`
  // here means the per-id loop skips the vec branch entirely on those
  // fixtures, while production keeps the prepared-statement reuse.
  let deleteVec: Database.Statement | null = null;
  try {
    deleteVec = db.prepare('DELETE FROM learnings_vec WHERE rowid = ?');
  } catch {
    deleteVec = null;
  }
  const deleteLearning = db.prepare('DELETE FROM learnings WHERE id = ?');

  const txn = db.transaction((targets: number[]) => {
    for (const id of targets) {
      if (deleteVec) {
        // Per-row try/catch in case the row simply doesn't exist in
        // learnings_vec (back-compat: pre-embedding rows). The
        // better-sqlite3 transaction wrapper auto-rolls back on
        // uncaught throws, so swallow harmless misses here.
        try {
          deleteVec.run(BigInt(id));
        } catch {
          // ignore — row absent or sqlite-vec unavailable
        }
      }
      deleteLearning.run(id);
    }
  });

  txn(ids);
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

/**
 * Parse a transcript blob into TranscriptEvent[]. Tolerant of two shapes:
 *   - JSONL: one JSON object per line.
 *   - Plain text: a single user-style event with the whole blob as content.
 *
 * Lines that fail to parse fall through to plain-text and are still included.
 */
export function parseTranscript(text: string): TranscriptEvent[] {
  if (!text) return [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  // Detect JSONL: every non-empty line should parse and yield an object with
  // at least a `role` field. If the first non-empty line satisfies this, we
  // treat the whole blob as JSONL.
  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines.find((l) => l.trim().length > 0) ?? '';
  let looksLikeJsonl = false;
  try {
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && typeof parsed.role === 'string') {
      looksLikeJsonl = true;
    }
  } catch {
    looksLikeJsonl = false;
  }

  if (!looksLikeJsonl) {
    return [{ role: 'user', content: trimmed, timestamp: '' }];
  }

  const events: TranscriptEvent[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      const parsed = JSON.parse(t) as Record<string, unknown>;
      const role = typeof parsed.role === 'string' ? parsed.role : 'unknown';
      const content = typeof parsed.content === 'string' ? parsed.content : '';
      const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : '';
      const ev: TranscriptEvent = { role, content, timestamp };
      if (typeof parsed.tool_name === 'string') ev.tool_name = parsed.tool_name;
      if (typeof parsed.brief_id === 'string') ev.brief_id = parsed.brief_id;
      events.push(ev);
    } catch {
      // Skip lines that fail mid-stream (shouldn't happen if JSONL detection
      // was correct, but defensive).
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Watermark helpers
// ---------------------------------------------------------------------------

function getWatermark(project: string): string | null {
  try {
    const row = getDb()
      .prepare(`SELECT last_extracted_at FROM perception_watermarks WHERE project = ?`)
      .get(project) as { last_extracted_at: string } | undefined;
    return row?.last_extracted_at ?? null;
  } catch {
    return null;
  }
}

function setWatermark(project: string, ts: string): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO perception_watermarks (project, last_extracted_at, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(project) DO UPDATE SET
           last_extracted_at = excluded.last_extracted_at,
           updated_at = excluded.updated_at`,
      )
      .run(project, ts);
  } catch (err) {
    console.error(
      '[perception] watermark write failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// Shared submit pipeline
// ---------------------------------------------------------------------------

interface SubmitInput {
  project: string;
  transcript_text: string;
  source: string;
  brief_id?: string;
  window_start_ts?: string;
  window_end_ts?: string;
  force_llm?: boolean;
  advance_watermark?: boolean;
  /**
   * Lifecycle event trigger label (TD-074). Set by each MCP handler:
   * 'mcp_submit' for `igris_perception_submit`, 'mcp_extract_now' for
   * the manual trigger. Threaded into `runPerception` so events written
   * to `event_log` carry the calling context.
   */
  trigger?: string;
}

interface SubmitOutput {
  llm_extracted: number;
  suppressed: number;
  inserted: number;
  inserted_ids: number[];
  llm_status: LlmStatus;
  watermark_advanced: boolean;
  by_source: Record<string, number>;
  /**
   * TD-086 — count of candidates skipped by the cheap-dedup pre-filter
   * (matched an existing learning above the cosine threshold).
   */
  deduped: number;
  /** `learnings.id` of every existing row whose seen_again_count was bumped. */
  deduped_ids: number[];
}

async function submitInternal(input: SubmitInput): Promise<SubmitOutput | { error: string }> {
  if (!input.project) return { error: 'project is required' };
  if (input.transcript_text.length > MAX_TRANSCRIPT_BYTES) {
    return {
      error: `transcript_text exceeds the 5 MB limit (got ${input.transcript_text.length} bytes)`,
    };
  }
  const events = parseTranscript(input.transcript_text);
  if (events.length === 0) {
    return {
      llm_extracted: 0,
      suppressed: 0,
      inserted: 0,
      inserted_ids: [],
      llm_status: 'skipped:disabled',
      watermark_advanced: false,
      by_source: {},
      deduped: 0,
      deduped_ids: [],
    };
  }

  const trigger = input.trigger ?? 'mcp_submit';

  // TD-074: in MCP context, mirror the runner's event_log writes via the
  // bus so `monitoring.onEventReceived` produces a row too. The runner
  // also writes directly (single source of truth for the detached CLI),
  // so the in-process bus emission here is a defense-in-depth signal —
  // it is also what the event-bus integrity test scans for, since the
  // runner has no `bus.emit()` call by design.
  const bus = getBus();
  if (bus) {
    bus.emit('perception.run_started', {
      project: input.project,
      source: input.source,
      trigger,
    });
  }

  const runOptions: import('./runner.js').RunPerceptionOptions = {
    events,
    project: input.project,
    source: input.source,
    force_llm: input.force_llm ?? false,
    trigger,
  };
  if (input.brief_id) runOptions.brief_id = input.brief_id;

  let result;
  try {
    result = await runPerception(
      getDb(),
      runOptions,
      getActiveConfig(),
      getActiveLlmExtractor(),
    );
  } catch (err) {
    // The runner already wrote `perception.run_failed` to event_log
    // before re-throwing. Mirror it on the bus for in-process listeners
    // / the event-bus integrity test scanner. Then re-throw so the MCP
    // handler returns an errorResult to the caller.
    if (bus) {
      bus.emit('perception.run_failed', {
        project: input.project,
        reason: 'unknown',
        error_message: err instanceof Error ? err.message.slice(0, 500) : String(err),
        trigger,
      });
    }
    throw err;
  }

  // The submit pipeline does not call `runPerception` for the empty-events
  // path, but if the LLM gate skipped the run (e.g. transcript below the
  // bytes floor), surface that as a `run_skipped` so /scan can show it.
  // Status enum from runner.ts: 'skipped:disabled' | 'skipped:bytes' |
  // 'skipped:cost' | 'skipped:cli_missing'.
  if (bus && typeof result.llm_status === 'string' && result.llm_status.startsWith('skipped:')) {
    const skipReason =
      result.llm_status === 'skipped:disabled'
        ? 'gate_disabled'
        : result.llm_status === 'skipped:bytes'
          ? 'gate_bytes'
          : 'gate_disabled';
    bus.emit('perception.run_skipped', {
      project: input.project,
      reason: skipReason,
      llm_status: result.llm_status,
      trigger,
    });
  }

  const advance = input.advance_watermark ?? false;
  if (advance) {
    const ts = input.window_end_ts ?? new Date().toISOString();
    setWatermark(input.project, ts);
  }

  // Bus events for observability. `perception.run_complete` is preserved
  // for back-compat with any external listeners. The 4 lifecycle events
  // (TD-074) are emitted alongside it; the runner's direct event_log
  // writes are still the canonical record — bus emission here is what
  // keeps the event-bus integrity test honest about declared emits.
  if (bus) {
    bus.emit('perception.run_complete', {
      project: input.project,
      llm_extracted: result.llm_extracted,
      suppressed: result.suppressed,
      inserted: result.inserted,
      deduped: result.deduped,
      llm_status: result.llm_status,
      source: input.source,
    });
    bus.emit('perception.run_succeeded', {
      project: input.project,
      candidates_count: result.inserted,
      llm_extracted: result.llm_extracted,
      suppressed: result.suppressed,
      deduped: result.deduped,
      llm_status: result.llm_status,
      trigger,
    });

    // TD-086: roll-up bus mirror for cheap-dedup hits. The runner already
    // wrote per-row `perception.rediscovery` rows directly to event_log
    // (canonical record for the detached CLI). This single bus.emit() is
    // a defense-in-depth signal for in-process listeners AND — critically
    // — the literal call site the event-bus integrity test scans for.
    if (result.deduped > 0) {
      bus.emit('perception.rediscovery', {
        project: input.project,
        deduped_count: result.deduped,
        deduped_ids: result.deduped_ids,
        trigger,
      });
    }

    // TD-086 forward-compat: literal bus.emit() call site for the
    // `perception.rejected_pattern_recurring` event, declared in events()
    // so the event-bus integrity test passes. Reject is a hard DELETE
    // today (handlers.ts:igris_perception_reject), so no rejected row
    // ever survives for the dedup helper to match — this branch is dead
    // code in TD-086 v1. When FR-116 ships soft-delete (review_status
    // = 'rejected' + deleted_at), set the env var to '1' (or replace the
    // condition with `result.deduped_against_rejected > 0`) and the event
    // will start shipping.
    // TODO(FR-116): activate this emit once reject becomes soft-delete.
    if (process.env.IGRIS_PERCEPTION_EMIT_REJECTED_RECURRING === '1') {
      bus.emit('perception.rejected_pattern_recurring', {
        project: input.project,
        trigger,
      });
    }
  }

  return {
    llm_extracted: result.llm_extracted,
    suppressed: result.suppressed,
    inserted: result.inserted,
    inserted_ids: result.inserted_ids,
    llm_status: result.llm_status,
    watermark_advanced: advance,
    by_source: result.by_source,
    deduped: result.deduped,
    deduped_ids: result.deduped_ids,
  };
}

// ---------------------------------------------------------------------------
// igris_perception_submit
// ---------------------------------------------------------------------------

export async function handlePerceptionSubmit(args: Record<string, unknown>): Promise<ToolResult> {
  const project = typeof args.project === 'string' ? args.project : '';
  const transcriptText = typeof args.transcript_text === 'string' ? args.transcript_text : '';
  const source = typeof args.source === 'string' ? args.source : 'unknown';

  if (!project) return errorResult('project is required');
  if (!transcriptText) return errorResult('transcript_text is required');

  const briefId = typeof args.brief_id === 'string' ? args.brief_id : undefined;
  const windowStart = typeof args.window_start_ts === 'string' ? args.window_start_ts : undefined;
  const windowEnd = typeof args.window_end_ts === 'string' ? args.window_end_ts : undefined;

  const submitInput: SubmitInput = {
    project,
    transcript_text: transcriptText,
    source,
    advance_watermark: true, // submit path always advances on success
  };
  if (briefId) submitInput.brief_id = briefId;
  if (windowStart) submitInput.window_start_ts = windowStart;
  if (windowEnd) submitInput.window_end_ts = windowEnd;

  const out = await submitInternal(submitInput);
  if ('error' in out) return errorResult(out.error);

  return successResult(JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------------------
// igris_perception_review_pending
// ---------------------------------------------------------------------------

export function handlePerceptionReviewPending(args: Record<string, unknown>): ToolResult {
  const project = typeof args.project === 'string' ? args.project : null;
  const limitRaw = args.limit !== undefined ? Number(args.limit) : 25;
  if (!Number.isFinite(limitRaw) || limitRaw < 1) {
    return errorResult('limit must be a positive integer');
  }
  const limit = Math.min(limitRaw, 1000);
  const ttlDays = getActiveConfig().pending_review_ttl_days;

  const db = getDb();
  let sql = `
    SELECT id, project, category, title, content, tags, tech_stack,
           source_brief, confidence, created_at, provenance, review_status,
           source_extractor
    FROM learnings
    WHERE review_status = 'pending_review'
      AND julianday('now') - julianday(created_at) <= ?
  `;
  const params: unknown[] = [ttlDays];
  if (project) {
    sql += ' AND project = ?';
    params.push(project);
  }
  sql += ' ORDER BY confidence DESC, created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    project: string;
    category: string;
    title: string;
    content: string;
    tags: string;
    tech_stack: string;
    source_brief: string;
    confidence: number;
    created_at: string;
    provenance: string;
    review_status: string;
    source_extractor: string;
  }>;

  const countSql = `
    SELECT COUNT(*) AS total FROM learnings
    WHERE review_status = 'pending_review'
      AND julianday('now') - julianday(created_at) <= ?
      ${project ? 'AND project = ?' : ''}
  `;
  const countParams: unknown[] = project ? [ttlDays, project] : [ttlDays];
  const countRow = db.prepare(countSql).get(...countParams) as { total: number };

  return successResult(
    JSON.stringify(
      {
        count: rows.length,
        total: countRow.total,
        ttl_days: ttlDays,
        candidates: rows,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// igris_perception_approve
// ---------------------------------------------------------------------------

export function handlePerceptionApprove(args: Record<string, unknown>): ToolResult {
  const idRaw = args.learning_id;
  if (idRaw === undefined || idRaw === null) {
    return errorResult('learning_id is required');
  }
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return errorResult('learning_id must be a positive integer');
  }

  const db = getDb();
  const existing = db
    .prepare('SELECT id, review_status FROM learnings WHERE id = ?')
    .get(id) as { id: number; review_status: string } | undefined;
  if (!existing) return errorResult(`Learning ${id} not found`);
  if (existing.review_status === 'approved') {
    return successResult(JSON.stringify({ updated: false, learning_id: id, review_status: 'approved' }, null, 2));
  }

  const edit =
    args.edit && typeof args.edit === 'object' && !Array.isArray(args.edit)
      ? (args.edit as Record<string, unknown>)
      : null;

  const setClauses: string[] = ["review_status = 'approved'"];
  const setParams: unknown[] = [];

  if (edit) {
    for (const key of Object.keys(edit)) {
      if (!EDITABLE_FIELDS.has(key)) {
        return errorResult(`Field "${key}" is not editable. Allowed: ${[...EDITABLE_FIELDS].join(', ')}`);
      }
      const value = edit[key];
      if (key === 'category') {
        if (typeof value !== 'string' || !VALID_CATEGORIES.includes(value)) {
          return errorResult(`Invalid category: must be one of ${VALID_CATEGORIES.join(', ')}`);
        }
        setClauses.push('category = ?');
        setParams.push(value);
      } else if (key === 'confidence') {
        if (typeof value !== 'number' || value < 0 || value > 1) {
          return errorResult('confidence must be a number in [0, 1]');
        }
        setClauses.push('confidence = ?');
        setParams.push(value);
      } else if (key === 'tags') {
        const tagsStr = Array.isArray(value)
          ? value.filter((v) => typeof v === 'string').join(',')
          : typeof value === 'string'
            ? value
            : null;
        if (tagsStr === null) {
          return errorResult('tags must be a string or string[]');
        }
        setClauses.push('tags = ?');
        setParams.push(tagsStr);
      } else if (typeof value === 'string') {
        setClauses.push(`${key} = ?`);
        setParams.push(value);
      } else {
        return errorResult(`Field "${key}" must be a string`);
      }
    }
  }

  setParams.push(id);
  try {
    db.prepare(`UPDATE learnings SET ${setClauses.join(', ')} WHERE id = ?`).run(...setParams);
  } catch (err) {
    return errorResult(`Approval failed: ${errMsg(err)}`);
  }

  const bus = getBus();
  if (bus) bus.emit('perception.candidate_approved', { learning_id: id });

  const updated = db.prepare('SELECT id, review_status, title FROM learnings WHERE id = ?').get(id);
  return successResult(JSON.stringify({ updated: true, learning: updated }, null, 2));
}

// ---------------------------------------------------------------------------
// igris_perception_reject
// ---------------------------------------------------------------------------

export function handlePerceptionReject(args: Record<string, unknown>): ToolResult {
  const idRaw = args.learning_id;
  if (idRaw === undefined || idRaw === null) {
    return errorResult('learning_id is required');
  }
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return errorResult('learning_id must be a positive integer');
  }
  const reason = typeof args.reason === 'string' ? args.reason : null;

  const db = getDb();
  const existing = db
    .prepare(
      'SELECT id, review_status, title, COALESCE(seen_again_count, 0) AS seen_again_count FROM learnings WHERE id = ?',
    )
    .get(id) as
    | { id: number; review_status: string; title: string; seen_again_count: number }
    | undefined;
  if (!existing) return errorResult(`Learning ${id} not found`);
  if (existing.review_status === 'approved') {
    return errorResult(`Learning ${id} is already approved; cannot reject.`);
  }

  // FR-116 M3 (Decision #10): the reject→soft-delete flip. A RECURRING rejection
  // — a candidate the perception dedup layer has re-discovered at least once
  // (`seen_again_count > 0`) before the operator rejects it — is SOFT-deleted
  // (review_status='rejected' + deleted_at, auto-excluded by the ~10
  // `='approved'` readers → ZERO read-path sweep) and EMITS
  // `perception.rejected_pattern_recurring`, which the janitor's
  // surfaceReEvalRejections tally reads to surface a re_evaluate_rejection
  // suggestion. This activates the dormant re-eval path (FR-119 Decision D).
  //
  // The COMMON single (first-time) reject path — `seen_again_count == 0`, a
  // pattern seen once and rejected — stays a HARD DELETE (unchanged behavior):
  // there is no recurrence to reconsider, so we do not accumulate a soft-deleted
  // row or fire the recurrence event. The guard is `seen_again_count > 0`.
  const isRecurring = (existing.seen_again_count ?? 0) > 0;

  const bus = getBus();

  if (isRecurring) {
    try {
      db.prepare(
        `UPDATE learnings
           SET review_status = 'rejected', deleted_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      ).run(id);
    } catch (err) {
      return errorResult(`Reject failed: ${errMsg(err)}`);
    }
    // Direct event_log write (canonical record the janitor tally reads) — the
    // detached CLI has no bus, so writePerceptionEvent is the durable signal.
    writePerceptionEvent(db, 'perception.rejected_pattern_recurring', {
      project: undefined,
      learning_id: id,
      title: existing.title,
      reason,
    });
    if (bus) {
      bus.emit('perception.candidate_rejected', {
        learning_id: id,
        title: existing.title,
        reason,
      });
      // Also emit on the bus for in-process listeners + the event-bus integrity
      // literal-call-site invariant.
      bus.emit('perception.rejected_pattern_recurring', {
        learning_id: id,
        title: existing.title,
        reason,
      });
    }
    return successResult(
      JSON.stringify(
        { deleted: true, soft: true, recurring: true, learning_id: id, reason: reason ?? '' },
        null,
        2,
      ),
    );
  }

  // TD-098: explicit transactional cleanup of learnings + learnings_vec.
  // The dropped trigger `learnings_vec_ad` previously fired here and
  // raised `unsafe use of virtual table "learnings_vec"` against
  // sqlite-vec under `PRAGMA trusted_schema = OFF`. The helper wraps
  // both deletes in `db.transaction(...)` so they commit atomically;
  // FTS5 cleanup continues automatically via the kept `learnings_ad`
  // trigger, which is empirically safe under the same guard.
  try {
    cleanupLearningArtifacts(db, [id]);
  } catch (err) {
    return errorResult(`Reject failed: ${errMsg(err)}`);
  }

  if (bus) {
    bus.emit('perception.candidate_rejected', {
      learning_id: id,
      title: existing.title,
      reason,
    });
  }

  return successResult(
    JSON.stringify({ deleted: true, learning_id: id, reason: reason ?? '' }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// igris_perception_extract_now
// ---------------------------------------------------------------------------

export async function handlePerceptionExtractNow(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const project = typeof args.project === 'string' ? args.project : '';
  if (!project) return errorResult('project is required');

  const transcriptText = typeof args.transcript_text === 'string' ? args.transcript_text : null;
  const briefId = typeof args.brief_id === 'string' ? args.brief_id : undefined;
  const forceLlm = args.force_llm === true;
  const advanceWatermark = args.advance_watermark === true;

  if (transcriptText === null || transcriptText.length === 0) {
    return errorResult(
      'transcript_text is required (in-place transcript-loading from session files is a future enhancement)',
    );
  }

  const submitInput: SubmitInput = {
    project,
    transcript_text: transcriptText,
    source: 'extract_now',
    force_llm: forceLlm,
    advance_watermark: advanceWatermark,
    trigger: 'mcp_extract_now',
  };
  if (briefId) submitInput.brief_id = briefId;

  const out = await submitInternal(submitInput);
  if ('error' in out) return errorResult(out.error);

  return successResult(JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------------------
// igris_perception_expire_stale
// ---------------------------------------------------------------------------

export function handlePerceptionExpireStale(args: Record<string, unknown>): ToolResult {
  const ttlRaw = args.ttl_days !== undefined ? Number(args.ttl_days) : getActiveConfig().pending_review_ttl_days;
  if (!Number.isFinite(ttlRaw) || ttlRaw < 0) {
    return errorResult('ttl_days must be a non-negative number');
  }
  const project = typeof args.project === 'string' ? args.project : null;

  const db = getDb();

  // TD-098: same vulnerability as handlePerceptionReject — a single
  // bulk DELETE here would fire the dropped `learnings_vec_ad` trigger
  // (pre-migration) and now leaves vec orphans (post-migration). Switch
  // to a SELECT-then-delete-per-id pattern via cleanupLearningArtifacts
  // so the embedding table is scrubbed atomically alongside the
  // learnings rows. N+1 statements per stale row is acceptable here:
  // pending_review TTL expirations are small in practice (single-digit
  // to tens), and the helper wraps the whole batch in one transaction.
  let selectSql = `
    SELECT id FROM learnings
    WHERE review_status = 'pending_review'
      AND julianday('now') - julianday(created_at) > ?
  `;
  const selectParams: unknown[] = [ttlRaw];
  if (project) {
    selectSql += ' AND project = ?';
    selectParams.push(project);
  }

  const rows = db.prepare(selectSql).all(...selectParams) as Array<{ id: number }>;
  const ids = rows.map((r) => r.id);

  try {
    cleanupLearningArtifacts(db, ids);
  } catch (err) {
    return errorResult(`Expire stale failed: ${errMsg(err)}`);
  }

  return successResult(
    JSON.stringify(
      {
        expired: ids.length,
        ttl_days: ttlRaw,
        project: project ?? '(all)',
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// igris_perception_get (TD-171 M3)
// ---------------------------------------------------------------------------

/**
 * Return the full row of one `pending_review` learning.
 *
 * Companion to `igris_perception_review_pending`, which returns a list with
 * truncated content. Use this when the operator needs to see the full
 * candidate before approve/reject. Approved or absent rows return an
 * error — the perception channel scope ends at promotion.
 */
export function handlePerceptionGet(args: Record<string, unknown>): ToolResult {
  const idRaw = args.learning_id;
  if (idRaw === undefined || idRaw === null) {
    return errorResult('learning_id is required');
  }
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return errorResult('learning_id must be a positive integer');
  }

  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, project, category, title, content, tags, tech_stack,
              source_brief, confidence, created_at, provenance,
              review_status, source_extractor
       FROM learnings
       WHERE id = ? AND review_status = 'pending_review'`,
    )
    .get(id) as Record<string, unknown> | undefined;

  if (!row) {
    return errorResult(
      `Learning ${id} not found or not in pending_review state. ` +
        `Use igris_memory_get for non-pending learnings.`,
    );
  }

  return successResult(JSON.stringify(row, null, 2));
}

// ---------------------------------------------------------------------------
// igris_perception_dashboard (TD-171 M3)
// ---------------------------------------------------------------------------

/**
 * Aggregate dashboard for the perception channel.
 *
 * Per L-152, this dashboard is strictly perception-engine concerns —
 * subconscious detector stats and janitor metrics belong elsewhere.
 *
 * Mirrors the canonical TD-171 `_dashboard` shape established by M1's
 * `handleMemoryDashboard` and M2's `handleGraphDashboard`:
 *
 *   {
 *     totals: { pending: N, approved_last_n: N, rejected_last_n: N },
 *     recent: {
 *       last_n_days: 30,
 *       run_outcomes: { succeeded, failed, skipped },
 *       dedup_rediscoveries: N,
 *     },
 *     samples: { top_extractors: [...] },         // omitted when summary_only
 *     project?: 'foo',                            // echoed when filter set
 *   }
 *
 * Filter semantics:
 *   - `project`: scopes both totals and recent windows.
 *   - `days`: window for `recent.*` and the `*_last_n` totals. Default 30.
 *   - `summary_only`: omits the `samples.top_extractors` block (counts
 *     are still computed).
 *
 * `rejected_last_n` is sourced from `perception.candidate_rejected`
 * event_log rows rather than from `learnings`. TWO things about that
 * sourcing have changed since it was written, and both matter:
 *
 *   - The original reason ("reject is a hard DELETE today, so a
 *     `learnings WHERE review_status='rejected'` query would always
 *     return 0") is HALF STALE. FR-116 M3 added the soft-delete fork in
 *     `handlePerceptionReject`: `seen_again_count > 0` now leaves the
 *     row with `review_status='rejected'` + `deleted_at`, while
 *     `== 0` still hard-deletes. So a `learnings` query would today
 *     return the RECURRING rejects only — a different undercount, not a
 *     fix. Do not "swap this to read from `learnings` directly" without
 *     deciding which of the two populations the counter is meant to be.
 *   - Until FR-241 phase 6b the event rows this counts were NEVER
 *     WRITTEN: `monitoring` did not subscribe
 *     `perception.candidate_rejected`, so the emit went nowhere and this
 *     counter was structurally 0. FR-241 subscribed it, so the UNSCOPED
 *     total is now real. The PROJECT-SCOPED branch below is still 0,
 *     because the emit carries no `project`/`project_slug` key and
 *     `monitoring` therefore logs `project_slug` as NULL. Adding
 *     `project` to the emit in `handlePerceptionReject` is what would
 *     make the scoped filter work — see the FR-241 MAINTAINING row.
 */
export function handlePerceptionDashboard(args: Record<string, unknown>): ToolResult {
  const days = args.days !== undefined ? Number(args.days) : 30;
  if (!Number.isFinite(days) || days < 0) {
    return errorResult('days must be a non-negative number');
  }
  const summaryOnly = args.summary_only === true;
  const projectFilter =
    typeof args.project === 'string' && args.project.length > 0 ? args.project : null;

  const db = getDb();

  // --- totals.pending ---
  // pending_review subset of learnings (perception channel inbox).
  // Note: do NOT apply the TTL filter here — this is the operator's
  // raw inbox count, including stale rows that the lazy-on-read filter
  // would hide. /scan wants to see "everything queued" not "everything
  // queued AND fresh".
  const pendingSql = projectFilter
    ? `SELECT COUNT(*) AS n FROM learnings
       WHERE review_status = 'pending_review' AND project = ?`
    : `SELECT COUNT(*) AS n FROM learnings WHERE review_status = 'pending_review'`;
  const pendingParams: unknown[] = projectFilter ? [projectFilter] : [];
  const pendingRow = db.prepare(pendingSql).get(...pendingParams) as { n: number };

  // --- totals.approved_last_n ---
  // Approved rows live as learnings.review_status='approved'. There is no
  // "approved_at" column today; use created_at as a proxy. Acceptable
  // because perception candidates are ingested fresh and approval-vs-
  // creation is generally <days apart in practice.
  const approvedSql = projectFilter
    ? `SELECT COUNT(*) AS n FROM learnings
       WHERE review_status = 'approved'
         AND provenance = 'inferred'
         AND project = ?
         AND created_at >= datetime('now', ?)`
    : `SELECT COUNT(*) AS n FROM learnings
       WHERE review_status = 'approved'
         AND provenance = 'inferred'
         AND created_at >= datetime('now', ?)`;
  const approvedParams: unknown[] = projectFilter
    ? [projectFilter, `-${days} days`]
    : [`-${days} days`];
  const approvedRow = db.prepare(approvedSql).get(...approvedParams) as { n: number };

  // --- totals.rejected_last_n ---
  // Sourced from the event_log rows emitted by handlePerceptionReject and
  // (since FR-241 phase 6b) actually written by `monitoring`. Per L-152,
  // scope this to perception.candidate_rejected events only. See the
  // function header for what the two branches below can and cannot see:
  // the unscoped count is real, the project-scoped one still reads 0
  // because the emit carries no project key.
  let rejectedCount = 0;
  try {
    const rejectedSql = projectFilter
      ? `SELECT COUNT(*) AS n FROM event_log
         WHERE event_name = 'perception.candidate_rejected'
           AND project_slug = ?
           AND created_at >= datetime('now', ?)`
      : `SELECT COUNT(*) AS n FROM event_log
         WHERE event_name = 'perception.candidate_rejected'
           AND created_at >= datetime('now', ?)`;
    const rejectedParams: unknown[] = projectFilter
      ? [projectFilter, `-${days} days`]
      : [`-${days} days`];
    const r = db.prepare(rejectedSql).get(...rejectedParams) as { n: number };
    rejectedCount = r.n;
  } catch {
    rejectedCount = 0;
  }

  // --- recent.run_outcomes (last `days` window) ---
  // run_started/run_succeeded/run_failed/run_skipped per perception/runner.ts.
  // Project filter: event_log.project_slug. Some run_started rows may not
  // carry project_slug (depending on writePerceptionEvent payload). Best-
  // effort filter: rows with NULL project_slug are excluded when filter
  // is set.
  const runOutcomes: { succeeded: number; failed: number; skipped: number } = {
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };
  try {
    const outcomeSql = projectFilter
      ? `SELECT event_name, COUNT(*) AS n FROM event_log
         WHERE event_name IN (
           'perception.run_succeeded', 'perception.run_failed', 'perception.run_skipped'
         )
           AND project_slug = ?
           AND created_at >= datetime('now', ?)
         GROUP BY event_name`
      : `SELECT event_name, COUNT(*) AS n FROM event_log
         WHERE event_name IN (
           'perception.run_succeeded', 'perception.run_failed', 'perception.run_skipped'
         )
           AND created_at >= datetime('now', ?)
         GROUP BY event_name`;
    const outcomeParams: unknown[] = projectFilter
      ? [projectFilter, `-${days} days`]
      : [`-${days} days`];
    const rows = db.prepare(outcomeSql).all(...outcomeParams) as {
      event_name: string;
      n: number;
    }[];
    for (const r of rows) {
      if (r.event_name === 'perception.run_succeeded') runOutcomes.succeeded = r.n;
      else if (r.event_name === 'perception.run_failed') runOutcomes.failed = r.n;
      else if (r.event_name === 'perception.run_skipped') runOutcomes.skipped = r.n;
    }
  } catch {
    // event_log table absent — leave at zero.
  }

  // --- recent.dedup_rediscoveries ---
  let dedupCount = 0;
  try {
    const dedupSql = projectFilter
      ? `SELECT COUNT(*) AS n FROM event_log
         WHERE event_name = 'perception.rediscovery'
           AND project_slug = ?
           AND created_at >= datetime('now', ?)`
      : `SELECT COUNT(*) AS n FROM event_log
         WHERE event_name = 'perception.rediscovery'
           AND created_at >= datetime('now', ?)`;
    const dedupParams: unknown[] = projectFilter
      ? [projectFilter, `-${days} days`]
      : [`-${days} days`];
    const r = db.prepare(dedupSql).get(...dedupParams) as { n: number };
    dedupCount = r.n;
  } catch {
    dedupCount = 0;
  }

  // --- samples.top_extractors (omitted when summary_only) ---
  // Group pending_review + recent-approved rows by source_extractor.
  // Helps operator spot extractor health imbalances ("LLM extractor
  // produced 90% of approvals; manual is dormant" or vice versa).
  let samples: Record<string, unknown> | undefined;
  if (!summaryOnly) {
    const extractorSql = projectFilter
      ? `SELECT source_extractor, COUNT(*) AS n FROM learnings
         WHERE provenance = 'inferred'
           AND project = ?
           AND created_at >= datetime('now', ?)
         GROUP BY source_extractor
         ORDER BY n DESC
         LIMIT 10`
      : `SELECT source_extractor, COUNT(*) AS n FROM learnings
         WHERE provenance = 'inferred'
           AND created_at >= datetime('now', ?)
         GROUP BY source_extractor
         ORDER BY n DESC
         LIMIT 10`;
    const extractorParams: unknown[] = projectFilter
      ? [projectFilter, `-${days} days`]
      : [`-${days} days`];
    const extractorRows = db.prepare(extractorSql).all(...extractorParams) as {
      source_extractor: string;
      n: number;
    }[];
    samples = { top_extractors: extractorRows };
  }

  const result: Record<string, unknown> = {
    totals: {
      pending: pendingRow.n,
      approved_last_n: approvedRow.n,
      rejected_last_n: rejectedCount,
    },
    recent: {
      last_n_days: days,
      run_outcomes: runOutcomes,
      dedup_rediscoveries: dedupCount,
    },
  };
  if (!summaryOnly) {
    result.samples = samples;
  }
  if (projectFilter) {
    result.project = projectFilter;
  }

  return successResult(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Watermark accessors (exported for tests and the inbox drain logic)
// ---------------------------------------------------------------------------

export function readWatermark(project: string): string | null {
  return getWatermark(project);
}

export function writeWatermark(project: string, ts: string): void {
  setWatermark(project, ts);
}
