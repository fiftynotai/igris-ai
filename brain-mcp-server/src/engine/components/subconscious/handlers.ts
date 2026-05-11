/**
 * Brain Engine v5.0 — Subconscious Component Handlers
 *
 * Pure handlers for the four FR-106 MCP tools:
 *   - igris_suggestion_list      — filtered query
 *   - igris_suggestion_dismiss   — mark dismissed + record into the
 *                                  dismiss-reason learning loop
 *   - igris_suggestion_acted     — mark acted (with optional brief link)
 *   - igris_subconscious_run     — manual / scheduled detector pipeline
 *
 * Handlers receive a context (set by the component's init()) so the
 * runner can route events and reuse the engine's bus when invoked
 * synchronously. They never throw; every error path returns an
 * `errorResult`.
 *
 * @module engine/components/subconscious/handlers
 * @author Fifty.ai
 */

import { getDb } from '../../../db.js';
import type { EventBus, ToolResult } from '../../types.js';
import { errMsg, errorResult, successResult, WhereBuilder } from '../../helpers.js';
import {
  computeEvidenceSignature,
  recordDismissPattern,
  runAllDetectors,
} from './runner.js';
import {
  DEFAULT_DETECTOR_CONFIG,
  type DetectorConfig,
  type Suggestion,
  type SuggestionPriority,
  type SuggestionSourceModule,
  type SuggestionStatus,
} from './types.js';
import { type ConflictVerifier, noopVerifier } from './verifier.js';
import { handleEdgeCreate } from '../edges/handlers.js';

// ---------------------------------------------------------------------------
// Validation catalogs
// ---------------------------------------------------------------------------

export const VALID_SOURCE_MODULES: SuggestionSourceModule[] = [
  'stalled',
  'conflict',
  'gap',
  'pattern',
];
export const VALID_STATUSES: SuggestionStatus[] = ['pending', 'dismissed', 'acted'];
export const VALID_PRIORITIES: SuggestionPriority[] = ['high', 'medium', 'low'];

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

interface HandlerContext {
  bus: EventBus;
  config: DetectorConfig;
  /** Optional LLM verifier (FR-108). Defaults to `noopVerifier` if unset. */
  verifier?: ConflictVerifier;
}

let _handlerCtx: HandlerContext | null = null;

/**
 * Set the handler context. Called once by the component's init() — it
 * exposes the bus (so `igris_subconscious_run` can emit events through
 * the engine's shared bus) and the active detector config (so the same
 * thresholds the daemon uses also apply to manual invocations). The
 * optional `verifier` is wired here too — production resolves it via
 * `isClaudeCliAvailable()`, tests inject a stub.
 */
export function setHandlerContext(ctx: HandlerContext): void {
  _handlerCtx = ctx;
}

function getActiveConfig(): DetectorConfig {
  return _handlerCtx?.config ?? DEFAULT_DETECTOR_CONFIG;
}

function getActiveVerifier(): ConflictVerifier {
  return _handlerCtx?.verifier ?? noopVerifier;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/** Parse the `evidence` JSON string back into a Record on the way out. */
function rowToSuggestion(row: Suggestion): Omit<Suggestion, 'evidence'> & {
  evidence: Record<string, unknown>;
} {
  let evidence: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.evidence);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      evidence = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed evidence shouldn't crash the listing — surface empty.
  }
  return { ...row, evidence };
}

// ---------------------------------------------------------------------------
// igris_suggestion_list
// ---------------------------------------------------------------------------

/**
 * List suggestions with optional filters.
 *
 * Supports: status, project_slug, source_module, priority, limit, offset.
 * Default sort: priority (high>medium>low) then created_at DESC so the
 * /awaken surface picks up the most actionable items first.
 */
export function handleSuggestionList(args: Record<string, unknown>): ToolResult {
  if (
    args.status !== undefined &&
    !(VALID_STATUSES as string[]).includes(args.status as string)
  ) {
    return errorResult(
      `Invalid status: ${args.status as string}. Must be one of: ${VALID_STATUSES.join(', ')}`,
    );
  }
  if (
    args.source_module !== undefined &&
    !(VALID_SOURCE_MODULES as string[]).includes(args.source_module as string)
  ) {
    return errorResult(
      `Invalid source_module: ${args.source_module as string}. Must be one of: ${VALID_SOURCE_MODULES.join(', ')}`,
    );
  }
  if (
    args.priority !== undefined &&
    !(VALID_PRIORITIES as string[]).includes(args.priority as string)
  ) {
    return errorResult(
      `Invalid priority: ${args.priority as string}. Must be one of: ${VALID_PRIORITIES.join(', ')}`,
    );
  }

  const where = new WhereBuilder()
    .add('status = ?', args.status)
    .add('project_slug = ?', args.project_slug)
    .add('source_module = ?', args.source_module)
    .add('priority = ?', args.priority);

  const rawLimit = args.limit !== undefined ? Number(args.limit) : 25;
  if (!Number.isFinite(rawLimit) || rawLimit < 1) {
    return errorResult('limit must be a positive integer');
  }
  const limit = Math.min(rawLimit, 1000);
  const rawOffset = args.offset !== undefined ? Number(args.offset) : 0;
  if (!Number.isFinite(rawOffset) || rawOffset < 0) {
    return errorResult('offset must be a non-negative integer');
  }
  const offset = rawOffset;

  const db = getDb();

  const rows = db
    .prepare(
      `SELECT * FROM suggestions
       ${where.toSQL()}
       ORDER BY
         CASE priority
           WHEN 'high' THEN 0
           WHEN 'medium' THEN 1
           ELSE 2
         END ASC,
         created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...where.values(), limit, offset) as Suggestion[];

  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM suggestions ${where.toSQL()}`)
    .get(...where.values()) as { total: number };

  return successResult(
    JSON.stringify(
      {
        suggestions: rows.map(rowToSuggestion),
        count: rows.length,
        total: countRow.total,
        limit,
        offset,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// igris_suggestion_dismiss
// ---------------------------------------------------------------------------

/**
 * Mark a pending suggestion as dismissed and feed the signature into the
 * dismiss-reason learning loop. Idempotent on already-dismissed rows
 * (returns the existing row rather than erroring) so a retry from the
 * UI never produces an inconsistent state.
 */
export function handleSuggestionDismiss(args: Record<string, unknown>): ToolResult {
  const idRaw = args.id;
  if (idRaw === undefined || idRaw === null) {
    return errorResult('Missing required field: id');
  }
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return errorResult('id must be a positive integer');
  }
  const reason = typeof args.reason === 'string' ? args.reason : null;

  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM suggestions WHERE id = ?')
    .get(id) as Suggestion | undefined;

  if (!existing) {
    return errorResult(`Suggestion not found: ${id}`);
  }
  if (existing.status === 'dismissed') {
    // Idempotent: do not double-record the dismiss in dismissed_patterns.
    return successResult(
      JSON.stringify({ updated: false, suggestion: rowToSuggestion(existing) }, null, 2),
    );
  }
  if (existing.status === 'acted') {
    return errorResult(`Suggestion ${id} already acted; cannot dismiss`);
  }

  // Update the row + record the dismiss-pattern in a single transaction
  // so an interrupted call doesn't leave the loop out of sync.
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE suggestions
         SET status = 'dismissed',
             dismissed_at = datetime('now'),
             dismissed_reason = ?
       WHERE id = ?`,
    ).run(reason, id);

    let evidence: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(existing.evidence);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        evidence = parsed as Record<string, unknown>;
      }
    } catch {
      // empty evidence is fine — falls through to the fallback signature
    }
    const signature = computeEvidenceSignature(existing.source_module, evidence);
    recordDismissPattern(
      db,
      existing.source_module,
      existing.project_slug,
      signature,
      reason,
      getActiveConfig(),
    );
  });

  try {
    txn();
  } catch (err) {
    return errorResult(`Failed to dismiss suggestion: ${errMsg(err)}`);
  }

  const updated = db
    .prepare('SELECT * FROM suggestions WHERE id = ?')
    .get(id) as Suggestion;
  return successResult(
    JSON.stringify({ updated: true, suggestion: rowToSuggestion(updated) }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// igris_suggestion_acted
// ---------------------------------------------------------------------------

/** Valid `action` values for `handleSuggestionActed` (FR-108 conflict resolution). */
const VALID_ACTED_ACTIONS = ['superseded', 'kept_both'] as const;

/**
 * Mark a pending suggestion as acted on. Optional `brief_id` records
 * which brief the user opened in response — useful for downstream
 * analytics (e.g., "% of stalled suggestions converted to brief
 * updates"). Acted is a positive signal and intentionally does NOT feed
 * into the dismiss-loop suppression.
 *
 * FR-108 extension: for conflict-class suggestions, callers may pass
 * `action='superseded'` (with `winner_id` + `loser_id`) to materialise a
 * typed `supersedes` edge between the two learnings, or
 * `action='kept_both'` to materialise a `related_to` edge marking the
 * pair as reviewed-and-non-conflicting. The status update + edge
 * insert run inside a single `db.transaction()` so an interrupted call
 * leaves both writes pending or both applied.
 *
 * Edge direction (per plan §"Acted-Action Design Answers"):
 *   - `supersedes`: from=winner, to=loser ("winner supersedes loser",
 *     matching the directional convention used by `parent_of`).
 *   - `related_to`: from=min(winner,loser), to=max(...) — sorted-pair
 *     idempotency mirrors TD-054's conflict signature convention.
 */
export function handleSuggestionActed(args: Record<string, unknown>): ToolResult {
  const idRaw = args.id;
  if (idRaw === undefined || idRaw === null) {
    return errorResult('Missing required field: id');
  }
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return errorResult('id must be a positive integer');
  }
  const briefId = typeof args.brief_id === 'string' ? args.brief_id : null;

  // FR-108: optional action + winner/loser ids for conflict-class resolutions.
  const action = args.action;
  let winnerId: number | undefined;
  let loserId: number | undefined;

  if (action !== undefined) {
    if (typeof action !== 'string' || !(VALID_ACTED_ACTIONS as readonly string[]).includes(action)) {
      return errorResult(
        `Invalid action: ${String(action)}. Must be one of: ${VALID_ACTED_ACTIONS.join(', ')}`,
      );
    }
    if (args.winner_id === undefined || args.winner_id === null) {
      return errorResult(`winner_id is required when action='${action}'`);
    }
    if (args.loser_id === undefined || args.loser_id === null) {
      return errorResult(`loser_id is required when action='${action}'`);
    }
    const w = Number(args.winner_id);
    const l = Number(args.loser_id);
    if (!Number.isInteger(w) || w <= 0) {
      return errorResult('winner_id must be a positive integer');
    }
    if (!Number.isInteger(l) || l <= 0) {
      return errorResult('loser_id must be a positive integer');
    }
    if (w === l) {
      return errorResult('winner_id and loser_id must differ');
    }
    winnerId = w;
    loserId = l;
  }

  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM suggestions WHERE id = ?')
    .get(id) as Suggestion | undefined;

  if (!existing) {
    return errorResult(`Suggestion not found: ${id}`);
  }
  if (existing.status === 'dismissed') {
    return errorResult(`Suggestion ${id} already dismissed; cannot mark acted`);
  }
  if (existing.status === 'acted') {
    return successResult(
      JSON.stringify({ updated: false, suggestion: rowToSuggestion(existing) }, null, 2),
    );
  }

  // Atomic UPDATE + (optional) edge create. If edge creation fails we
  // throw out of the transaction so the suggestion stays pending and the
  // caller gets an errorResult — preferable to leaving a half-resolved
  // state where the suggestion looks acted but no edge exists.
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE suggestions
         SET status = 'acted',
             acted_at = datetime('now'),
             acted_brief_id = ?
       WHERE id = ?`,
    ).run(briefId, id);

    if (action === 'superseded' && winnerId !== undefined && loserId !== undefined) {
      // Direction: from=winner, to=loser → reads "winner supersedes loser",
      // matching `parent_of`'s convention (from is the parent, to is the child).
      const result = handleEdgeCreate({
        from_type: 'learning',
        from_id: String(winnerId),
        to_type: 'learning',
        to_id: String(loserId),
        edge_type: 'supersedes',
        provenance: 'user',
        confidence: 1.0,
        metadata: {
          source: 'igris_suggestion_acted',
          suggestion_id: id,
        },
      });
      if (result.isError) {
        throw new Error(`Edge creation failed: ${result.content[0]?.text ?? 'unknown'}`);
      }
    } else if (action === 'kept_both' && winnerId !== undefined && loserId !== undefined) {
      // related_to is symmetric — sort the pair so re-runs land on the
      // same row regardless of which arg the caller put first.
      const [smaller, larger] = winnerId < loserId ? [winnerId, loserId] : [loserId, winnerId];
      const result = handleEdgeCreate({
        from_type: 'learning',
        from_id: String(smaller),
        to_type: 'learning',
        to_id: String(larger),
        edge_type: 'related_to',
        provenance: 'user',
        confidence: 1.0,
        metadata: {
          source: 'igris_suggestion_acted',
          reason: 'non-conflict-on-review',
          suggestion_id: id,
        },
      });
      if (result.isError) {
        throw new Error(`Edge creation failed: ${result.content[0]?.text ?? 'unknown'}`);
      }
    }
  });

  try {
    txn();
  } catch (err) {
    return errorResult(`Failed to mark suggestion acted: ${errMsg(err)}`);
  }

  const updated = db
    .prepare('SELECT * FROM suggestions WHERE id = ?')
    .get(id) as Suggestion;
  return successResult(
    JSON.stringify({ updated: true, suggestion: rowToSuggestion(updated) }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// igris_subconscious_run
// ---------------------------------------------------------------------------

/**
 * Fire the detector pipeline once. Called by the cron-driven schedule
 * `subconscious_engine` and exposed for manual invocation
 * (igris_schedule_fire_now passes through to here too).
 *
 * Async since FR-108: the runner now awaits the LLM verifier sequentially
 * over conflict-class candidates. The MCP gateway's `dispatch` already
 * awaits handler returns (see `gateway.ts:80`).
 *
 * Emits run lifecycle events around the runner invocation; per-candidate
 * events are returned by the runner and re-emitted here so every literal
 * subconscious bus.emit call lives in this file (the event-bus integrity
 * scanner only inspects index/handlers/daemon).
 */
export async function handleSubconsciousRun(_args: Record<string, unknown>): Promise<ToolResult> {
  const db = getDb();
  const bus = _handlerCtx?.bus ?? null;
  if (bus) bus.emit('subconscious.run_start', {});
  try {
    const summary = await runAllDetectors(db, {
      config: getActiveConfig(),
      verifier: getActiveVerifier(),
    });
    if (bus) {
      for (const evt of summary.events) {
        if (evt.kind === 'suggestion_emitted') {
          bus.emit('subconscious.suggestion_emitted', {
            source_module: evt.source_module,
            project_slug: evt.project_slug,
            title: evt.title,
            priority: evt.priority,
          });
        } else if (evt.kind === 'suggestion_suppressed') {
          bus.emit('subconscious.suggestion_suppressed', {
            source_module: evt.source_module,
            project_slug: evt.project_slug,
            evidence_signature: evt.evidence_signature,
          });
        } else if (evt.kind === 'suggestion_verified') {
          bus.emit('subconscious.suggestion_verified', {
            source_module: evt.source_module,
            project_slug: evt.project_slug,
            title: evt.title,
            verifier_status: evt.verifier_status,
          });
        } else if (evt.kind === 'suggestion_rejected_by_verifier') {
          bus.emit('subconscious.suggestion_rejected_by_verifier', {
            source_module: evt.source_module,
            project_slug: evt.project_slug,
            title: evt.title,
            verifier_reason: evt.verifier_reason,
          });
        }
      }
      bus.emit('subconscious.run_complete', {
        emitted: summary.emitted,
        suppressed: summary.suppressed,
      });
    }
    return successResult(
      JSON.stringify(
        {
          emitted: summary.emitted,
          suppressed: summary.suppressed,
          by_module: summary.by_module,
          expired_pending: summary.expired_pending,
          expired_dismissed: summary.expired_dismissed,
          expired_observations: summary.expired_observations,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    return errorResult(`Subconscious run failed: ${errMsg(err)}`);
  }
}
