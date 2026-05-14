/**
 * Brain Engine v7.0 -- Monitoring Component Handlers
 *
 * Handler functions for the 2 monitoring MCP tools:
 * - igris_event_log: Query the event log with filters
 * - igris_event_log_cleanup: Purge old event log entries
 *
 * @module engine/components/monitoring/handlers
 * @author fifty.dev
 */

import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult, WhereBuilder } from '../../helpers.js';

// ---------------------------------------------------------------------------
// handleEventLogQuery
// ---------------------------------------------------------------------------

/**
 * Query the event_log table with optional filters.
 *
 * Supports filtering by event_name, component, project_slug, and time range.
 * Returns paginated results with total count.
 */
export function handleEventLogQuery(
  args: Record<string, unknown>,
): ToolResult {
  try {
    const db = getDb();

    const eventName = args.event_name as string | undefined;
    const component = args.component as string | undefined;
    const projectSlug = args.project_slug as string | undefined;
    const since = args.since as string | undefined;
    const until = args.until as string | undefined;
    const limit = Math.min(Math.max(1, Number(args.limit) || 100), 1000);
    const offset = Math.max(0, Number(args.offset) || 0);

    const wb = new WhereBuilder();
    wb.add('event_name = ?', eventName);
    wb.add('component = ?', component);
    wb.add('project_slug = ?', projectSlug);
    wb.add('created_at >= ?', since);
    wb.add('created_at <= ?', until);

    const whereSQL = wb.toSQL();
    const whereParams = wb.values();

    // Query matching events
    const events = db.prepare(
      `SELECT id, event_name, component, payload, machine_hostname, project_slug, created_at FROM event_log ${whereSQL} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...whereParams, limit, offset) as Record<string, unknown>[];

    // Count total matching rows
    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM event_log ${whereSQL}`
    ).get(...whereParams) as { total: number };

    return successResult(JSON.stringify({
      events,
      total: countRow.total,
      limit,
      offset,
    }, null, 2));
  } catch (err) {
    return errorResult(`Failed to query event log: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// handleEventLogCleanup
// ---------------------------------------------------------------------------

/**
 * Delete event_log entries older than the specified retention period.
 *
 * @param args.retention_days - Number of days to retain (default: 30, minimum: 1)
 */
export function handleEventLogCleanup(
  args: Record<string, unknown>,
): ToolResult {
  try {
    const db = getDb();

    const retentionDays = Math.max(1, Number(args.retention_days) || 30);

    const result = db.prepare(
      `DELETE FROM event_log WHERE created_at < datetime('now', '-' || ? || ' days')`
    ).run(retentionDays);

    return successResult(JSON.stringify({
      deleted: result.changes,
      retention_days: retentionDays,
    }, null, 2));
  } catch (err) {
    return errorResult(`Failed to clean up event log: ${err instanceof Error ? err.message : String(err)}`);
  }
}
