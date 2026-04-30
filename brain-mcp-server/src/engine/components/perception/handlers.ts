/**
 * Brain Engine v5.0 — Perception Component Handlers (FR-109)
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
 * @author Fifty.ai
 */

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
}

interface SubmitOutput {
  llm_extracted: number;
  suppressed: number;
  inserted: number;
  inserted_ids: number[];
  llm_status: LlmStatus;
  watermark_advanced: boolean;
  by_source: Record<string, number>;
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
    };
  }

  const result = await runPerception(
    getDb(),
    {
      events,
      project: input.project,
      brief_id: input.brief_id,
      source: input.source,
      force_llm: input.force_llm ?? false,
    },
    getActiveConfig(),
    getActiveLlmExtractor(),
  );

  const advance = input.advance_watermark ?? false;
  if (advance) {
    const ts = input.window_end_ts ?? new Date().toISOString();
    setWatermark(input.project, ts);
  }

  // Bus events for observability.
  const bus = getBus();
  if (bus) {
    bus.emit('perception.run_complete', {
      project: input.project,
      llm_extracted: result.llm_extracted,
      suppressed: result.suppressed,
      inserted: result.inserted,
      llm_status: result.llm_status,
      source: input.source,
    });
  }

  return {
    llm_extracted: result.llm_extracted,
    suppressed: result.suppressed,
    inserted: result.inserted,
    inserted_ids: result.inserted_ids,
    llm_status: result.llm_status,
    watermark_advanced: advance,
    by_source: result.by_source,
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
    .prepare('SELECT id, review_status, title FROM learnings WHERE id = ?')
    .get(id) as { id: number; review_status: string; title: string } | undefined;
  if (!existing) return errorResult(`Learning ${id} not found`);
  if (existing.review_status === 'approved') {
    return errorResult(`Learning ${id} is already approved; cannot reject.`);
  }

  // Best-effort: also drop the vec row so the embedding table doesn't
  // accumulate orphans. The drop is wrapped in try/catch because the
  // virtual table may not exist in :memory: schemas used by tests.
  try {
    db.prepare('DELETE FROM learnings_vec WHERE rowid = ?').run(BigInt(id));
  } catch {
    // ignore — table absent or row not present
  }
  try {
    db.prepare('DELETE FROM learnings WHERE id = ?').run(id);
  } catch (err) {
    return errorResult(`Reject failed: ${errMsg(err)}`);
  }

  const bus = getBus();
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
  let sql = `
    DELETE FROM learnings
    WHERE review_status = 'pending_review'
      AND julianday('now') - julianday(created_at) > ?
  `;
  const params: unknown[] = [ttlRaw];
  if (project) {
    sql += ' AND project = ?';
    params.push(project);
  }
  const result = db.prepare(sql).run(...params);
  return successResult(
    JSON.stringify(
      {
        expired: result.changes,
        ttl_days: ttlRaw,
        project: project ?? '(all)',
      },
      null,
      2,
    ),
  );
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
