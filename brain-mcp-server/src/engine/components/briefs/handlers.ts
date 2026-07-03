/**
 * Brain Engine v7.0 — Briefs Component Handlers
 *
 * Handler functions for the FR-127 atomic brief-claim gate:
 *   - handleBriefClaim   — atomically claim a brief for an instance.
 *   - handleBriefRelease — release a brief claim held by an instance.
 *
 * Each handler takes Record<string, unknown> args, validates at runtime,
 * and returns a ToolResult. The claim is a single-statement conditional
 * UPDATE whose 0-rows-affected return is the hard gate (a second instance
 * claiming the same brief affects 0 rows). SQLite serializes writers, so
 * no explicit transaction wrapper is needed for the single UPDATE.
 *
 * @module engine/components/briefs/handlers
 * @author fifty.dev
 */

import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult, now } from '../../helpers.js';

/** Shape of the diagnostic read against brief_status. */
interface ClaimRow {
  claimed_by: string | null;
  claimed_at: string | null;
}

// ---------------------------------------------------------------------------
// handleBriefClaim
// ---------------------------------------------------------------------------

/**
 * Atomically claim a brief for a given instance.
 *
 * Required: project, brief_id, instance_id
 *
 * The claim is a single conditional UPDATE; its WHERE precondition is the
 * gate:
 *   WHERE project = ? AND brief_id = ?
 *     AND (claimed_by IS NULL OR claimed_by = ?)
 *
 * - claimed_by IS NULL  -> unclaimed       -> 1 row -> claimed.
 * - claimed_by = self   -> already mine    -> 1 row -> claimed_at refreshed
 *                                                     (re-entrant no-op).
 * - claimed_by = other  -> held by another -> 0 rows -> hard gate.
 *
 * `claimed: false` is a SUCCESSFUL tool result (data, not isError) — the
 * gate outcome is data that /hunt branches on.
 */
export function handleBriefClaim(args: Record<string, unknown>): ToolResult {
  const project = args.project as string | undefined;
  const briefId = args.brief_id as string | undefined;
  const instanceId = args.instance_id as string | undefined;

  if (!project || !briefId || !instanceId) {
    return errorResult('Missing required fields: project, brief_id, instance_id');
  }

  const db = getDb();

  // 1. Read the current row for diagnostics + existence check.
  const row = db.prepare(
    'SELECT claimed_by, claimed_at FROM brief_status WHERE project = ? AND brief_id = ?'
  ).get(project, briefId) as ClaimRow | undefined;

  if (!row) {
    return errorResult(`Brief not found: ${briefId} in ${project}`);
  }

  const reentrant = row.claimed_by === instanceId;

  // 2. Atomic conditional claim. The WHERE precondition is the gate.
  //    A single UPDATE statement is already atomic under SQLite's writer
  //    serialization — no db.transaction() wrapper needed. The read above
  //    is diagnostic only; the UPDATE's own WHERE is the authority.
  const ts = now();
  const res = db.prepare(`
    UPDATE brief_status
    SET claimed_by = ?, claimed_at = ?
    WHERE project = ? AND brief_id = ?
      AND (claimed_by IS NULL OR claimed_by = ?)
  `).run(instanceId, ts, project, briefId, instanceId);

  // 3. res.changes === 1  -> claimed (or re-claimed self)
  //    res.changes === 0  -> held by another instance
  if (res.changes === 1) {
    return successResult(JSON.stringify({
      claimed: true,
      reentrant,
      brief_id: briefId,
      project,
      claimed_by: instanceId,
      claimed_at: ts,
    }, null, 2));
  }

  return successResult(JSON.stringify({
    claimed: false,
    reentrant: false,
    brief_id: briefId,
    project,
    held_by: row.claimed_by,
    held_since: row.claimed_at,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleBriefRelease
// ---------------------------------------------------------------------------

/**
 * Release a brief claim held by a given instance.
 *
 * Required: project, brief_id, instance_id
 *
 * The release is an ownership-scoped conditional UPDATE: the
 * `claimed_by = ?` clause means an instance can only release ITS OWN
 * claim — a rested instance cannot accidentally free a brief a sibling
 * later re-claimed.
 *
 * `released: false` (0 rows: claim was already gone, or held by another)
 * is a SUCCESS — release is idempotent. /rest calling release on a brief
 * it no longer holds is a clean no-op.
 */
export function handleBriefRelease(args: Record<string, unknown>): ToolResult {
  const project = args.project as string | undefined;
  const briefId = args.brief_id as string | undefined;
  const instanceId = args.instance_id as string | undefined;

  if (!project || !briefId || !instanceId) {
    return errorResult('Missing required fields: project, brief_id, instance_id');
  }

  const db = getDb();

  // Existence check — releasing a non-existent brief is an error, mirroring
  // handleBriefClaim's contract (the skill should never call release on a
  // brief that has no brief_status row).
  const row = db.prepare(
    'SELECT claimed_by FROM brief_status WHERE project = ? AND brief_id = ?'
  ).get(project, briefId) as { claimed_by: string | null } | undefined;

  if (!row) {
    return errorResult(`Brief not found: ${briefId} in ${project}`);
  }

  const res = db.prepare(`
    UPDATE brief_status
    SET claimed_by = NULL, claimed_at = NULL
    WHERE project = ? AND brief_id = ?
      AND claimed_by = ?
  `).run(project, briefId, instanceId);

  return successResult(JSON.stringify({
    released: res.changes === 1,   // false = wasn't ours / already free — still success
    brief_id: briefId,
    project,
  }, null, 2));
}
