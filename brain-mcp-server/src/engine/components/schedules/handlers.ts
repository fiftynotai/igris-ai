/**
 * Brain Engine v5.0 — Schedules Component Handlers
 *
 * Handler functions for the 7 schedule management MCP tools.
 * Each handler takes Record<string, unknown> args, validates
 * at runtime, and returns a ToolResult.
 *
 * Schedule IDs use the format: sch-{first 8 chars of randomUUID()}
 * Run IDs use the format: run-{first 8 chars of randomUUID()}
 *
 * @module engine/components/schedules/handlers
 * @author Fifty.ai
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from '../../../db.js';
import type { ToolResult, EventBus } from '../../types.js';
import { errorResult, successResult, errMsg, WhereBuilder } from '../../helpers.js';
import { parseCron, nextRunAfter } from './cron.js';
import { now, generateScheduleId, generateRunId, executeWithRetries } from './utils.js';

const execFileAsync = promisify(execFile);

/** Default timeout for schedule handler execution (30 seconds) */
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Context — set by component init()
// ---------------------------------------------------------------------------

interface HandlerContext {
  bus: EventBus;
  getDispatch: () => ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null;
}

let _handlerCtx: HandlerContext | null = null;

/**
 * Set the handler context. Called by the component's init() function
 * to provide access to the event bus and dispatchTool.
 */
export function setHandlerContext(ctx: HandlerContext): void {
  _handlerCtx = ctx;
}

// ---------------------------------------------------------------------------
// Handler Execution
// ---------------------------------------------------------------------------

/**
 * Execute a schedule's handler and return the result.
 *
 * @param schedule - The schedule row from the database
 * @param dispatchTool - Optional function to dispatch MCP tool calls
 * @returns Status and result or error
 */
export async function executeHandler(
  schedule: Record<string, unknown>,
  dispatchTool?: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null,
): Promise<{ status: string; result?: string; error?: string }> {
  const handlerType = schedule.handler_type as string;
  const config = JSON.parse((schedule.handler_config as string) || '{}') as Record<string, unknown>;
  const timeoutMs = (schedule.timeout_ms as number) || DEFAULT_TIMEOUT_MS;

  if (handlerType === 'noop') {
    return { status: 'success', result: 'noop' };
  }

  if (handlerType === 'mcp-tool') {
    const toolName = config.tool as string | undefined;
    const toolArgs = (config.args as Record<string, unknown>) || {};

    if (!toolName) {
      return { status: 'failed', error: 'handler_config.tool is required for mcp-tool handler' };
    }

    if (!dispatchTool) {
      return { status: 'failed', error: 'dispatchTool not available — cannot execute mcp-tool handler' };
    }

    try {
      const toolResult = await dispatchTool(toolName, toolArgs);
      return { status: 'success', result: JSON.stringify(toolResult) };
    } catch (err) {
      return { status: 'failed', error: errMsg(err) };
    }
  }

  /**
   * WARNING: 'shell' handler executes arbitrary commands via /bin/sh.
   * Only use in trusted environments. The brain server is a local process,
   * not a public-facing API. Commands are provided by the schedule creator.
   */
  if (handlerType === 'shell') {
    const command = config.command as string | undefined;
    if (!command) {
      return { status: 'failed', error: 'handler_config.command is required for shell handler' };
    }

    console.warn(
      `[schedules] Shell handler enabled for schedule "${schedule.name}" — runs arbitrary commands`,
    );

    try {
      const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
        timeout: timeoutMs,
      });
      return { status: 'success', result: (stdout || stderr || '').trim() };
    } catch (err) {
      const message = errMsg(err);
      // Check for timeout
      if (message.includes('ETIMEDOUT') || message.includes('killed')) {
        return { status: 'timeout', error: `Command timed out after ${timeoutMs}ms` };
      }
      return { status: 'failed', error: message };
    }
  }

  return { status: 'failed', error: `Unknown handler_type: ${handlerType}` };
}

// ---------------------------------------------------------------------------
// handleScheduleCreate
// ---------------------------------------------------------------------------

/**
 * Create a new schedule.
 *
 * Required: name, cron_expr, handler_type
 * Optional: description, handler_config, enabled, project_slug, tags,
 *           max_retries, timeout_ms
 */
export function handleScheduleCreate(args: Record<string, unknown>): ToolResult {
  const name = args.name as string | undefined;
  const cronExpr = args.cron_expr as string | undefined;
  const handlerType = args.handler_type as string | undefined;

  if (!name || !cronExpr || !handlerType) {
    return errorResult('Missing required fields: name, cron_expr, handler_type');
  }

  const validHandlerTypes = ['mcp-tool', 'shell', 'noop'];
  if (!validHandlerTypes.includes(handlerType)) {
    return errorResult(
      `Invalid handler_type: ${handlerType}. Must be one of: ${validHandlerTypes.join(', ')}`
    );
  }

  // Validate cron expression
  try {
    parseCron(cronExpr);
  } catch (err) {
    return errorResult(`Invalid cron_expr: ${errMsg(err)}`);
  }

  // Compute next_run_at
  let nextRunAt: string | null = null;
  const enabled = args.enabled !== undefined ? (args.enabled ? 1 : 0) : 1;
  if (enabled) {
    try {
      nextRunAt = nextRunAfter(cronExpr);
    } catch {
      // If next run can't be computed, leave null
    }
  }

  const db = getDb();
  const id = generateScheduleId();
  const timestamp = now();
  const handlerConfig = args.handler_config !== undefined
    ? JSON.stringify(args.handler_config)
    : '{}';
  const tags = args.tags !== undefined ? JSON.stringify(args.tags) : '[]';
  const maxRetries = args.max_retries !== undefined ? Number(args.max_retries) : 0;
  const timeoutMs = args.timeout_ms !== undefined ? Number(args.timeout_ms) : DEFAULT_TIMEOUT_MS;

  db.prepare(`
    INSERT INTO schedules (id, name, description, cron_expr, handler_type, handler_config,
                           enabled, project_slug, tags, max_retries, timeout_ms,
                           next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    (args.description as string | undefined) ?? null,
    cronExpr,
    handlerType,
    handlerConfig,
    enabled,
    (args.project_slug as string | undefined) ?? null,
    tags,
    maxRetries,
    timeoutMs,
    nextRunAt,
    timestamp,
    timestamp,
  );

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Record<string, unknown>;

  if (_handlerCtx) {
    _handlerCtx.bus.emit('schedule.created', { schedule_id: id, name, cron_expr: cronExpr });
  }

  return successResult(JSON.stringify({ schedule }, null, 2));
}

// ---------------------------------------------------------------------------
// handleScheduleList
// ---------------------------------------------------------------------------

/**
 * List schedules with optional filters.
 *
 * All optional: enabled, project_slug, tag, limit, offset
 * Includes run stats (run_count, last_status) via subquery.
 */
export function handleScheduleList(args: Record<string, unknown>): ToolResult {
  const db = getDb();

  const where = new WhereBuilder()
    .add('s.enabled = ?', args.enabled !== undefined ? (args.enabled ? 1 : 0) : undefined)
    .add('s.project_slug = ?', args.project_slug);

  if (args.tag !== undefined) {
    // Exact tag match using json_each to avoid substring false positives
    where.addAlways('EXISTS (SELECT 1 FROM json_each(s.tags) WHERE json_each.value = ?)', args.tag);
  }

  const limit = args.limit !== undefined ? Number(args.limit) : 25;
  const offset = args.offset !== undefined ? Number(args.offset) : 0;

  const rows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM schedule_runs r WHERE r.schedule_id = s.id) as run_count,
      (SELECT r2.status FROM schedule_runs r2 WHERE r2.schedule_id = s.id ORDER BY r2.started_at DESC LIMIT 1) as last_status
    FROM schedules s
    ${where.toSQL()}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...where.values(), limit, offset) as Record<string, unknown>[];

  const countRow = db.prepare(
    `SELECT COUNT(*) as total FROM schedules s ${where.toSQL()}`
  ).get(...where.values()) as { total: number };

  return successResult(JSON.stringify({
    schedules: rows,
    count: rows.length,
    total: countRow.total,
    limit,
    offset,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleScheduleGet
// ---------------------------------------------------------------------------

/**
 * Get a single schedule with its recent runs.
 *
 * Required: schedule_id
 */
export function handleScheduleGet(args: Record<string, unknown>): ToolResult {
  const scheduleId = args.schedule_id as string | undefined;
  if (!scheduleId) {
    return errorResult('Missing required field: schedule_id');
  }

  const db = getDb();

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId) as Record<string, unknown> | undefined;
  if (!schedule) {
    return errorResult(`Schedule not found: ${scheduleId}`);
  }

  const runs = db.prepare(`
    SELECT * FROM schedule_runs
    WHERE schedule_id = ?
    ORDER BY started_at DESC
    LIMIT 10
  `).all(scheduleId) as Record<string, unknown>[];

  return successResult(JSON.stringify({ schedule, recent_runs: runs }, null, 2));
}

// ---------------------------------------------------------------------------
// handleScheduleEnable
// ---------------------------------------------------------------------------

/**
 * Enable a schedule. Recomputes next_run_at based on the cron expression.
 *
 * Required: schedule_id
 */
export function handleScheduleEnable(args: Record<string, unknown>): ToolResult {
  const scheduleId = args.schedule_id as string | undefined;
  if (!scheduleId) {
    return errorResult('Missing required field: schedule_id');
  }

  const db = getDb();

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId) as Record<string, unknown> | undefined;
  if (!schedule) {
    return errorResult(`Schedule not found: ${scheduleId}`);
  }

  const timestamp = now();
  let nextRunAt: string | null = null;
  try {
    nextRunAt = nextRunAfter(schedule.cron_expr as string);
  } catch {
    // Leave null if cron can't compute
  }

  db.prepare(`
    UPDATE schedules SET enabled = 1, next_run_at = ?, updated_at = ? WHERE id = ?
  `).run(nextRunAt, timestamp, scheduleId);

  const updated = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId) as Record<string, unknown>;

  if (_handlerCtx) {
    _handlerCtx.bus.emit('schedule.enabled', { schedule_id: scheduleId });
  }

  return successResult(JSON.stringify({ schedule: updated }, null, 2));
}

// ---------------------------------------------------------------------------
// handleScheduleDisable
// ---------------------------------------------------------------------------

/**
 * Disable a schedule. Clears next_run_at.
 *
 * Required: schedule_id
 */
export function handleScheduleDisable(args: Record<string, unknown>): ToolResult {
  const scheduleId = args.schedule_id as string | undefined;
  if (!scheduleId) {
    return errorResult('Missing required field: schedule_id');
  }

  const db = getDb();

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId) as Record<string, unknown> | undefined;
  if (!schedule) {
    return errorResult(`Schedule not found: ${scheduleId}`);
  }

  const timestamp = now();

  db.prepare(`
    UPDATE schedules SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?
  `).run(timestamp, scheduleId);

  const updated = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId) as Record<string, unknown>;

  if (_handlerCtx) {
    _handlerCtx.bus.emit('schedule.disabled', { schedule_id: scheduleId });
  }

  return successResult(JSON.stringify({ schedule: updated }, null, 2));
}

// ---------------------------------------------------------------------------
// handleScheduleFireNow
// ---------------------------------------------------------------------------

/**
 * Immediately fire a schedule's handler, creating a run record.
 *
 * Required: schedule_id
 */
export async function handleScheduleFireNow(args: Record<string, unknown>): Promise<ToolResult> {
  const scheduleId = args.schedule_id as string | undefined;
  if (!scheduleId) {
    return errorResult('Missing required field: schedule_id');
  }

  const db = getDb();

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId) as Record<string, unknown> | undefined;
  if (!schedule) {
    return errorResult(`Schedule not found: ${scheduleId}`);
  }

  const runId = generateRunId();
  const startedAt = now();
  const dispatchTool = _handlerCtx?.getDispatch() ?? null;

  // Create run record with 'running' status
  db.prepare(`
    INSERT INTO schedule_runs (id, schedule_id, status, started_at, attempt)
    VALUES (?, ?, 'running', ?, 1)
  `).run(runId, scheduleId, startedAt);

  if (_handlerCtx) {
    _handlerCtx.bus.emit('schedule.fire_now', { schedule_id: scheduleId, run_id: runId });
  }

  // Execute the handler with retry support
  const startTime = Date.now();
  const { outcome, attempt } = await executeWithRetries(schedule, dispatchTool);
  const durationMs = Date.now() - startTime;
  const finishedAt = now();

  // Update run record with result and actual attempt count
  db.prepare(`
    UPDATE schedule_runs
    SET status = ?, finished_at = ?, duration_ms = ?, result = ?, error = ?, attempt = ?
    WHERE id = ?
  `).run(
    outcome.status,
    finishedAt,
    durationMs,
    outcome.result ?? null,
    outcome.error ?? null,
    attempt,
    runId,
  );

  // Update schedule last_run_at
  db.prepare(`
    UPDATE schedules SET last_run_at = ?, updated_at = ? WHERE id = ?
  `).run(finishedAt, finishedAt, scheduleId);

  const run = db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(runId) as Record<string, unknown>;

  if (_handlerCtx) {
    _handlerCtx.bus.emit('schedule.run_complete', {
      schedule_id: scheduleId,
      run_id: runId,
      status: outcome.status,
    });
  }

  return successResult(JSON.stringify({ run }, null, 2));
}

// ---------------------------------------------------------------------------
// handleScheduleDelete
// ---------------------------------------------------------------------------

/**
 * Delete a schedule and all its runs (CASCADE).
 *
 * Required: schedule_id
 */
export function handleScheduleDelete(args: Record<string, unknown>): ToolResult {
  const scheduleId = args.schedule_id as string | undefined;
  if (!scheduleId) {
    return errorResult('Missing required field: schedule_id');
  }

  const db = getDb();

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId) as Record<string, unknown> | undefined;
  if (!schedule) {
    return errorResult(`Schedule not found: ${scheduleId}`);
  }

  db.prepare('DELETE FROM schedules WHERE id = ?').run(scheduleId);

  if (_handlerCtx) {
    _handlerCtx.bus.emit('schedule.deleted', {
      schedule_id: scheduleId,
      name: schedule.name,
    });
  }

  return successResult(JSON.stringify({
    deleted: true,
    schedule_id: scheduleId,
    name: schedule.name,
  }, null, 2));
}
