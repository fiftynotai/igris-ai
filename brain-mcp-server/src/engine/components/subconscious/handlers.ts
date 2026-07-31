/**
 * Brain Engine v7.0 — Subconscious Component Handlers
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
 * @author fifty.dev
 */

import { getDb } from '../../../db.js';
import type { EventBus, ToolResult } from '../../types.js';
import { errMsg, errorResult, successResult } from '../../helpers.js';
// FR-241 — the pure `db`-param reader this handler is now the wrapper for.
import { listSuggestions } from '../../../tools/suggestions-read.js';
import {
  computeEvidenceSignature,
  recordDismissPattern,
  runSubconscious,
} from './runner.js';
import {
  DEFAULT_DETECTOR_CONFIG,
  DEFAULT_SUBCONSCIOUS_CONFIG,
  type DetectorConfig,
  type SubconsciousConfig,
  type Suggestion,
  type SuggestionPriority,
  type SuggestionStatus,
} from './types.js';
import { handleEdgeCreate } from '../edges/handlers.js';
import { applyAction } from './actions/index.js';
import type { LlmExtractorGlobalConfig } from '../cognition/engine/index.js';

// ---------------------------------------------------------------------------
// Validation catalogs
// ---------------------------------------------------------------------------

/**
 * FR-118 M2 — `source_module` is now OPEN (the LLM extractor names the kind).
 * The list-filter no longer validates against a closed enum: any non-empty
 * string is a valid filter value. The four legacy detector names are retained
 * for the `igris_suggestion_list` schema `enum` HINT only (a non-exhaustive
 * suggestion list for the caller's UI — NOT a rejection set). Filtering on a
 * value outside the list is allowed and simply returns the matching rows.
 */
export const LEGACY_SOURCE_MODULE_HINTS: string[] = [
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
  /**
   * The legacy detector config (FR-106). Retained for the dismiss-loop's
   * `recordDismissPattern` envelope (cooldown / suppress thresholds), which is
   * still active. The live run path (`runSubconscious`) uses the subconscious
   * instance config below, NOT this.
   */
  config: DetectorConfig;
  /**
   * FR-118 M2 — the subconscious LLM-instance config (timeout/budget/min-bytes/
   * enabled/harness). Drives `handleSubconsciousRun` → `runSubconscious`.
   */
  subconsciousConfig?: SubconsciousConfig;
  /** FR-118 M2 — the global `llm_extractor` config (harness default + fallback). */
  globalConfig?: LlmExtractorGlobalConfig;
}

let _handlerCtx: HandlerContext | null = null;

/**
 * Set the handler context. Called once by the component's init() — it exposes
 * the bus, the legacy detector config (for the still-active dismiss-loop), and
 * (FR-118 M2) the subconscious instance config + the global llm_extractor
 * config that drive the live `igris_subconscious_run` → `runSubconscious` path.
 */
export function setHandlerContext(ctx: HandlerContext): void {
  _handlerCtx = ctx;
}

function getActiveConfig(): DetectorConfig {
  return _handlerCtx?.config ?? DEFAULT_DETECTOR_CONFIG;
}

function getActiveSubconsciousConfig(): SubconsciousConfig {
  return _handlerCtx?.subconsciousConfig ?? DEFAULT_SUBCONSCIOUS_CONFIG;
}

function getActiveGlobalConfig(): LlmExtractorGlobalConfig {
  return _handlerCtx?.globalConfig ?? {};
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
 *
 * FR-241 — this is now the MCP **WRAPPER** over `tools/suggestions-read.ts`
 * `#listSuggestions`, the FR-237/FR-240 pure-layer seam. Everything that stayed
 * here stayed for a stated reason: the validation MESSAGES are wire contracts,
 * `getDb()` is wrapper-only by definition, the `min(limit, 1000)` cap is this
 * tool's policy rather than the query's, and `rowToSuggestion`'s
 * evidence-parsing is presentation. The reader's `facets` block is deliberately
 * NOT emitted — it is a dashboard-only addition, and adding a key here would
 * change a wire format skills parse.
 *
 * Pinned across the lift by `__tests__/suggestion-list-wire-parity.test.ts`,
 * whose snapshots were recorded BEFORE it.
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
  // FR-118 M2 — source_module is OPEN. A non-string filter is still invalid,
  // but any non-empty string is a legitimate filter value (the LLM names the
  // kind). We do NOT reject against a closed enum.
  if (
    args.source_module !== undefined &&
    (typeof args.source_module !== 'string' || args.source_module.length === 0)
  ) {
    return errorResult('source_module must be a non-empty string');
  }
  if (
    args.priority !== undefined &&
    !(VALID_PRIORITIES as string[]).includes(args.priority as string)
  ) {
    return errorResult(
      `Invalid priority: ${args.priority as string}. Must be one of: ${VALID_PRIORITIES.join(', ')}`,
    );
  }

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

  // `undefined` means "no filter" — `WhereBuilder.add` skips it (helpers.ts:54).
  // Forwarding `args.*` unchanged is what keeps the filter semantics identical
  // across the lift; a `?? undefined` normalisation here would turn an explicit
  // `null` into a dropped clause on one side and a `= NULL` on the other.
  const result = listSuggestions(getDb(), {
    status: args.status as string | undefined,
    project_slug: args.project_slug as string | undefined,
    source_module: args.source_module as string | undefined,
    priority: args.priority as string | undefined,
    limit,
    offset,
  });

  // L-133 degradation. The reader preflights `suggestions` and returns an empty
  // result rather than throwing; this tool's pre-lift behaviour on a brain
  // without the table was an error ENVELOPE (the raw `no such table:
  // suggestions` propagating out of the handler to the gateway). The envelope
  // is preserved — with a message that names the cause instead of leaking the
  // SQLite text — so an MCP caller still sees a failure rather than a
  // convincing empty list. The DASHBOARD reads the reader directly and renders
  // `degraded` as a banner, which is the behaviour that actually wanted the
  // preflight.
  if (result.degraded !== null) {
    return errorResult(result.degraded);
  }

  return successResult(
    JSON.stringify(
      {
        suggestions: (result.suggestions as unknown as Suggestion[]).map(rowToSuggestion),
        count: result.count,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
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
 * Fire the subconscious LLM extractor once (FR-118 M2 — REPLACES the rule
 * detector pipeline as the live path). Called by the cron-driven schedule
 * `subconscious_engine` (every 6h) and exposed for manual invocation
 * (`igris_schedule_fire_now` passes through to here too).
 *
 * Delegates to `runSubconscious`, which drives the subconscious cognition
 * instance through the agnostic engine (`runExtractor`): cold-start / budget /
 * timeout gates, the brain-isolated LLM call, and the one-terminal-event-per-run
 * lifecycle. Lifecycle events are written by the ENGINE directly to `event_log`
 * under the per-instance `cognition.subconscious.*` namespace — NOT via the bus
 * — so a manual fire and a detached-process fire share ONE observable read path
 * (`igris_event_log component='cognition.subconscious'`).
 *
 * Because the engine owns the events, this handler emits NO `bus.emit` calls
 * (the event-bus integrity scanner finds none — and the component declares
 * none, see index.ts). The optional `project` arg scopes the digest; `force`
 * bypasses the cold-start + digest-size gate for a manual sweep.
 *
 * Async — the MCP gateway's `dispatch` already awaits handler returns.
 */
export async function handleSubconsciousRun(args: Record<string, unknown>): Promise<ToolResult> {
  const db = getDb();
  const project = typeof args.project === 'string' && args.project.length > 0 ? args.project : 'all';
  const force = args.force === true;
  try {
    const result = await runSubconscious(db, project, {
      config: getActiveSubconsciousConfig(),
      globalConfig: getActiveGlobalConfig(),
      force,
      trigger: 'manual',
    });
    return successResult(
      JSON.stringify(
        {
          instance_id: result.instance_id,
          outcome: result.outcome,
          persisted: result.persisted,
          ...(result.parsed !== undefined ? { parsed: result.parsed } : {}),
          ...(result.skip_reason ? { skip_reason: result.skip_reason } : {}),
          ...(result.fail_reason ? { fail_reason: result.fail_reason } : {}),
          ...(result.backend ? { harness: result.backend.harness } : {}),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    return errorResult(`Subconscious run failed: ${errMsg(err)}`);
  }
}

// ---------------------------------------------------------------------------
// igris_suggestion_apply_action (FR-118 M3)
// ---------------------------------------------------------------------------

/**
 * Apply the `suggested_action` of a reviewed suggestion (FR-118 M3).
 *
 * OPERATOR-INVOKED: the operator one-clicks to apply a suggestion they have
 * reviewed. This NEVER auto-fires — creating a suggestion does not execute its
 * action. Delegates to the apply layer (`actions/index.ts:applyAction`), which
 * validates the target resolves, dispatches the action kind (unknown kind →
 * `flag_for_review` fallback, never a throw), and marks the suggestion `acted`
 * on success / leaves it `pending` on failure.
 *
 * The most consequential kind, `create_brief`, DRAFTS only — it returns a brief
 * draft for operator approval and does NOT insert anything (the operator
 * creates the real brief via /register).
 */
export function handleSuggestionApplyAction(args: Record<string, unknown>): ToolResult {
  const idRaw = args.id;
  if (idRaw === undefined || idRaw === null) {
    return errorResult('Missing required field: id');
  }
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return errorResult('id must be a positive integer');
  }
  try {
    return applyAction(getDb(), id);
  } catch (err) {
    return errorResult(`apply_action failed: ${errMsg(err)}`);
  }
}
