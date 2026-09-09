/**
 * Brain Engine v7.1 — Subconscious auto-action APPLY layer (FR-118 M3).
 *
 * `applyAction(db, suggestionId)` is the executor behind the OPERATOR-INVOKED
 * `igris_suggestion_apply_action` tool. It:
 *   1. loads the suggestion (must exist + be `pending`);
 *   2. parses its serialized `suggested_action` (`{ kind, ...params }`);
 *   3. dispatches to the matching kind (`actions/kinds.ts`);
 *   4. on success marks the suggestion `acted` (stamping `acted_at` and, where a
 *      kind provides one, `acted_brief_id`); on failure LEAVES it `pending`
 *      (a refusal is recorded, TD-439).
 *
 * HUMAN-IN-THE-LOOP (load-bearing invariant). This runs ONLY when the operator
 * applies a reviewed suggestion — it is NEVER called when a suggestion is
 * created. No suggestion auto-executes its action. The most consequential kind,
 * `create_brief`, DRAFTS only (no insert). Every kind validates its target
 * resolves before acting (no action on a hallucinated brief_id / node).
 *
 * GRACEFUL UNKNOWN KIND. An action whose `kind` isn't one of the five known
 * kinds does NOT throw and does NOT silently no-op — it falls back to
 * `flag_for_review` (the safe sink), so the suggestion still surfaces for the
 * operator's eyes and is marked `acted`. A missing / malformed `suggested_action`
 * is treated the same way (flag it for review rather than crash the apply).
 *
 * @module engine/components/subconscious/actions
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import type { ToolResult } from '../../../types.js';
import { errMsg, errorResult, successResult } from '../../../helpers.js';
import type { Suggestion } from '../types.js';
import {
  applyAddEdge,
  applyClusterMeta,
  applyCreateBrief,
  applyDismissExisting,
  applyFlagForReview,
  applyMergeLearnings,
  applyProposeEdgeType,
  applyPruneLearning,
  applyReEvaluateRejection,
  applyResolveContradiction,
  applyTickAc,
  type ActionResult,
} from './kinds.js';

/** The known action kinds. Anything else routes to `flag_for_review`. */
export const KNOWN_ACTION_KINDS = [
  'tick_ac',
  'dismiss_existing',
  'create_brief',
  'flag_for_review',
  'add_edge',
  // FR-119 janitor kinds:
  'merge_learnings',
  're_evaluate_rejection',
  // FR-116 M2 arbiter kind:
  'resolve_contradiction',
  // FR-116 M3 curator kind:
  'prune_learning',
  // FR-116 M4 cartographer kind:
  'cluster_meta',
  // FR-116 M5 emergence kind (INFORMATIONAL — proposal-only, no vocab mutation):
  'propose_edge_type',
] as const;

export type KnownActionKind = (typeof KNOWN_ACTION_KINDS)[number];

/** Parse the serialized `suggested_action` JSON into `{ kind, params }`. */
function parseSuggestedAction(
  raw: string | null,
): { kind: string; params: Record<string, unknown> } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const kind = typeof obj.kind === 'string' ? obj.kind : '';
  if (!kind) return null;
  // The params are every key except `kind`.
  const { kind: _omit, ...params } = obj;
  return { kind, params };
}

/**
 * Dispatch one action by kind. Unknown kind → `flag_for_review` (graceful, not
 * a throw). Each kind returns an `ActionResult`; this function never throws —
 * any error inside a kind is caught and surfaced as `ok: false`.
 */
function dispatchKind(
  db: Database.Database,
  kind: string,
  params: Record<string, unknown>,
  projectSlug: string | null,
): ActionResult {
  try {
    switch (kind) {
      case 'tick_ac':
        return applyTickAc(db, params, projectSlug);
      case 'dismiss_existing':
        return applyDismissExisting(db, params);
      case 'create_brief':
        return applyCreateBrief(params);
      case 'flag_for_review':
        return applyFlagForReview(params);
      case 'add_edge':
        return applyAddEdge(db, params);
      case 'merge_learnings':
        return applyMergeLearnings(db, params);
      case 're_evaluate_rejection':
        return applyReEvaluateRejection(params);
      case 'resolve_contradiction':
        return applyResolveContradiction(db, params);
      case 'prune_learning':
        // Operator-apply path: no run linkage (undoable by entry_id). The
        // auto_prune fork links the run id directly via applyPruneLearning.
        return applyPruneLearning(db, params);
      case 'cluster_meta':
        // Operator-apply path: no run linkage (undoable by entry_id). The
        // auto_fork fork links the run id directly via applyClusterMeta.
        return applyClusterMeta(db, params);
      case 'propose_edge_type':
        // FR-116 M5: INFORMATIONAL only — records the operator's acknowledgement
        // of an emergent edge-type proposal. Does NOT mutate VALID_EDGE_TYPES
        // (proposal-only, Decision #3b); no db effect → no undo entry.
        return applyProposeEdgeType(params);
      default:
        // GRACEFUL FALLBACK: an unknown kind is flagged for review (the safe
        // sink), not thrown. The operator still sees the suggestion; we record
        // the unknown kind as the concern so it's diagnosable.
        return applyFlagForReview({
          target_kind: 'suggestion',
          concern: `unknown action kind "${kind}" — flagged for review`,
          ...params,
        });
    }
  } catch (err) {
    // Defence-in-depth: a kind should never throw, but if one does we surface
    // it as a failed action (suggestion stays pending) rather than crashing the
    // apply call.
    return { ok: false, kind, message: errMsg(err), error: errMsg(err) };
  }
}

/** Persist a guard refusal (TD-439). */
function persistRefusal(db: Database.Database, s: Suggestion, reason: string): void {
  try {
    let evidence: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(s.evidence);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        evidence = parsed as Record<string, unknown>;
      }
    } catch {
      /* start from {} */
    }
    evidence.apply_refused = { at: new Date().toISOString(), reason };
    db.prepare('UPDATE suggestions SET evidence = ? WHERE id = ?').run(JSON.stringify(evidence), s.id);
  } catch {
    /* text carries it */
  }
}

/**
 * Apply the `suggested_action` of a reviewed suggestion. OPERATOR-INVOKED only.
 *
 * Loads the suggestion (must exist + be `pending`), dispatches its action kind,
 * and — only on success — marks it `acted` (with `acted_at` and any
 * `acted_brief_id` the kind supplies). A failed or unresolvable action leaves
 * the suggestion `pending` and returns an error result, so the operator can
 * see what went wrong and retry / dismiss instead.
 *
 * The status update + the kind's effect are NOT wrapped in one transaction
 * deliberately: `dismiss_existing` / `add_edge` make their own writes, and the
 * status flip is a single idempotent UPDATE. If the kind succeeded but the
 * status UPDATE somehow fails, we surface that error (the kind's effect already
 * landed — re-applying is safe because the kinds are idempotent/validating).
 */
export function applyAction(db: Database.Database, suggestionId: number): ToolResult {
  if (!Number.isInteger(suggestionId) || suggestionId <= 0) {
    return errorResult('id must be a positive integer');
  }

  const suggestion = db
    .prepare('SELECT * FROM suggestions WHERE id = ?')
    .get(suggestionId) as Suggestion | undefined;
  if (!suggestion) {
    return errorResult(`Suggestion not found: ${suggestionId}`);
  }
  if (suggestion.status === 'dismissed') {
    return errorResult(`Suggestion ${suggestionId} already dismissed; cannot apply`);
  }
  if (suggestion.status === 'acted') {
    return errorResult(`Suggestion ${suggestionId} already acted; cannot re-apply`);
  }

  const parsed = parseSuggestedAction(suggestion.suggested_action);
  // A missing / malformed action is handled gracefully — flag for review rather
  // than fail. The operator clicked "apply" on a reviewed suggestion; a
  // structurally-broken action shouldn't error their click into a dead end.
  const kind = parsed?.kind ?? 'flag_for_review';
  const params = parsed?.params ?? {
    target_kind: 'suggestion',
    target_id: String(suggestionId),
    concern: suggestion.suggested_action
      ? 'suggested_action was malformed — flagged for review'
      : 'no suggested_action — flagged for review',
  };

  const result = dispatchKind(db, kind, params, suggestion.project_slug);

  if (!result.ok) {
    // Action failed/unresolvable → leave the suggestion pending.
    if (result.refused) persistRefusal(db, suggestion, result.refused);
    return errorResult(
      `apply_action (${result.kind}) ${result.refused ? 'refused' : 'failed'}: ${result.error ?? result.message}`,
    );
  }

  // Success → mark the suggestion acted (stamp acted_at + any brief link).
  try {
    db.prepare(
      `UPDATE suggestions
         SET status = 'acted',
             acted_at = datetime('now'),
             acted_brief_id = COALESCE(?, acted_brief_id)
       WHERE id = ?`,
    ).run(result.acted_brief_id ?? null, suggestionId);
  } catch (err) {
    return errorResult(
      `Action ${result.kind} applied but failed to mark suggestion acted: ${errMsg(err)}`,
    );
  }

  const updated = db
    .prepare('SELECT * FROM suggestions WHERE id = ?')
    .get(suggestionId) as Suggestion;

  return successResult(
    JSON.stringify(
      {
        applied: true,
        suggestion_id: suggestionId,
        action_kind: result.kind,
        message: result.message,
        ...(result.data ? { result: result.data } : {}),
        suggestion: {
          id: updated.id,
          status: updated.status,
          acted_at: updated.acted_at,
          acted_brief_id: updated.acted_brief_id,
        },
      },
      null,
      2,
    ),
  );
}
