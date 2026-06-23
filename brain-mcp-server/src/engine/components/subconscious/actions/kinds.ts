/**
 * Brain Engine v7.1 — Subconscious auto-action KINDS (FR-118 M3).
 *
 * The five initial action kinds the subconscious can attach to a suggestion as
 * its `suggested_action`. Each kind is a pure validator-then-executor: it reads
 * the action params, VALIDATES that every target it touches actually resolves
 * (no action on a hallucinated brief_id / suggestion_id / graph node), and only
 * then performs its effect. A malformed or unresolvable action returns an
 * `{ ok: false, error }` RESULT — it NEVER throws. The dispatcher (`index.ts`)
 * relies on that: a failed action leaves the suggestion `pending`, a successful
 * one marks it `acted`.
 *
 * HUMAN-IN-THE-LOOP (load-bearing). None of these kinds auto-fire. They run ONLY
 * when the operator invokes `igris_suggestion_apply_action` against a suggestion
 * they have reviewed (a one-click apply). Creating a suggestion NEVER executes
 * its action. And within the kinds, the most consequential effect is deliberately
 * NON-executing: `create_brief` DRAFTS a brief for operator approval — it does
 * NOT insert anything. The operator creates the real brief via /register.
 *
 * The five kinds:
 *   - tick_ac          — mark an AC checkbox checked, validating the brief
 *                        resolves AND the ac_text matches a real AC line.
 *   - dismiss_existing — suppress an open suggestion (validate it exists + open).
 *   - create_brief     — DRAFT a brief for approval (no auto-insert).
 *   - flag_for_review  — surface "needs your eyes" (the safe fallback).
 *   - add_edge         — create a typed edge, validating both nodes EXIST first
 *                        (delegates to edges/handlers.ts:handleEdgeCreate).
 *
 * @module engine/components/subconscious/actions/kinds
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { errMsg } from '../../../helpers.js';
import { handleEdgeCreate } from '../../edges/handlers.js';

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * The outcome of applying one action kind. Deliberately NOT a `ToolResult` —
 * the dispatcher decides the lifecycle transition (mark `acted` vs leave
 * `pending`) from `ok`, then builds the MCP `ToolResult`. `ok: false` means the
 * action did NOT take effect (validation failed or the target didn't resolve);
 * the suggestion must stay `pending`.
 *
 * `acted_brief_id` is the optional brief link to stamp onto the suggestion row
 * (`tick_ac` sets it to the brief it ticked). `data` carries kind-specific
 * payload for the caller (e.g. the `create_brief` DRAFT the operator approves).
 */
export interface ActionResult {
  ok: boolean;
  kind: string;
  /** Human-readable message — the error on failure, a confirmation on success. */
  message: string;
  /** On failure only — the validation error (mirrors `message` for `ok:false`). */
  error?: string;
  /** Optional brief link to stamp onto `suggestions.acted_brief_id`. */
  acted_brief_id?: string;
  /** Kind-specific success payload (e.g. the brief DRAFT, the created edge). */
  data?: Record<string, unknown>;
}

function fail(kind: string, error: string): ActionResult {
  return { ok: false, kind, message: error, error };
}

function ok(kind: string, message: string, extra: Partial<ActionResult> = {}): ActionResult {
  return { ok: true, kind, message, ...extra };
}

// ---------------------------------------------------------------------------
// Param helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// tick_ac — mark an AC checkbox checked (validating brief + AC line resolve)
// ---------------------------------------------------------------------------

/**
 * A checkbox line in a brief body. Markdown ACs are `- [ ] text` (unchecked) or
 * `- [x] text` (checked). We match on the trimmed checkbox TEXT, case-folded.
 */
const CHECKBOX_RE = /^(\s*[-*]\s*\[)([ xX])(\]\s*)(.*)$/;

/** Normalise an AC line's text for comparison (collapse whitespace, case-fold). */
function normaliseAcText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * `tick_ac` `{ brief_id, ac_text, justification }` — mark an AC item checked.
 *
 * Validation (no ticking a hallucinated AC):
 *   1. `brief_id` must resolve to a `brief_files` row (the body lives there).
 *      A brief is keyed by `(project, brief_id)`; the action carries only
 *      `brief_id`, so we resolve the row by `brief_id` and (when the suggestion
 *      carries a `project_slug`) prefer that project. Ambiguous / absent → fail.
 *   2. `ac_text` must match an actual checkbox LINE in the body (after
 *      whitespace-collapse + case-fold). No match → fail (don't invent an AC).
 *
 * On success the matched line is flipped to `- [x] …` and the body rewritten;
 * the brief is the `acted_brief_id` stamped onto the suggestion.
 */
export function applyTickAc(
  db: Database.Database,
  params: Record<string, unknown>,
  projectSlug: string | null,
): ActionResult {
  const briefId = asString(params.brief_id);
  const acText = asString(params.ac_text);
  if (!briefId) return fail('tick_ac', 'tick_ac requires a non-empty brief_id');
  if (!acText) return fail('tick_ac', 'tick_ac requires a non-empty ac_text');

  // Resolve the brief body. Prefer the suggestion's project when set; otherwise
  // resolve by brief_id alone (and reject if it's ambiguous across projects).
  let row: { project: string; content: string } | undefined;
  if (projectSlug) {
    row = db
      .prepare('SELECT project, content FROM brief_files WHERE project = ? AND brief_id = ?')
      .get(projectSlug, briefId) as { project: string; content: string } | undefined;
  }
  if (!row) {
    const matches = db
      .prepare('SELECT project, content FROM brief_files WHERE brief_id = ?')
      .all(briefId) as Array<{ project: string; content: string }>;
    if (matches.length === 0) {
      return fail('tick_ac', `brief_id "${briefId}" does not resolve to any brief`);
    }
    if (matches.length > 1) {
      return fail(
        'tick_ac',
        `brief_id "${briefId}" is ambiguous across ${matches.length} projects; cannot tick`,
      );
    }
    row = matches[0];
  }

  // Find the checkbox line whose text matches ac_text (don't tick a hallucinated AC).
  const target = normaliseAcText(acText);
  const lines = row.content.split('\n');
  let matchedIdx = -1;
  let alreadyChecked = false;
  for (let i = 0; i < lines.length; i++) {
    const m = CHECKBOX_RE.exec(lines[i]);
    if (!m) continue;
    if (normaliseAcText(m[4]) === target) {
      matchedIdx = i;
      alreadyChecked = m[2].toLowerCase() === 'x';
      break;
    }
  }
  if (matchedIdx === -1) {
    return fail(
      'tick_ac',
      `ac_text did not match any acceptance-criteria line in brief "${briefId}"`,
    );
  }

  if (alreadyChecked) {
    // Idempotent: already ticked — succeed without rewriting.
    return ok('tick_ac', `AC already checked in brief "${briefId}"`, {
      acted_brief_id: briefId,
      data: { brief_id: briefId, project: row.project, already_checked: true },
    });
  }

  // Flip the checkbox to [x] and rewrite the body.
  const m = CHECKBOX_RE.exec(lines[matchedIdx])!;
  lines[matchedIdx] = `${m[1]}x${m[3]}${m[4]}`;
  const newContent = lines.join('\n');
  try {
    db.prepare(
      `UPDATE brief_files
         SET content = ?, content_hash = ?, updated_at = datetime('now')
       WHERE project = ? AND brief_id = ?`,
    ).run(newContent, hashContent(newContent), row.project, briefId);
  } catch (err) {
    return fail('tick_ac', `failed to update brief body: ${errMsg(err)}`);
  }

  return ok('tick_ac', `Checked AC in brief "${briefId}"`, {
    acted_brief_id: briefId,
    data: { brief_id: briefId, project: row.project, ac_text: acText },
  });
}

/** Cheap, dependency-free content hash matching the brief_files convention. */
function hashContent(content: string): string {
  // djb2 — deterministic, sufficient for the content_hash freshness marker.
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) >>> 0;
  }
  return `djb2:${h.toString(16)}`;
}

// ---------------------------------------------------------------------------
// dismiss_existing — suppress an open suggestion (validate it exists + open)
// ---------------------------------------------------------------------------

/**
 * `dismiss_existing` `{ suggestion_id }` — suppress an OPEN suggestion.
 *
 * Validation: the target must exist AND be `pending`. A non-existent id, or a
 * suggestion already `dismissed`/`acted`, fails (we never silently re-dismiss
 * or touch a resolved row). On success the target is marked `dismissed` with a
 * reason noting the subconscious applied the dismissal.
 *
 * Note: this is the dismissal of ANOTHER suggestion (e.g. "this older
 * suggestion is now superseded"), not the suggestion that carries the action —
 * the dispatcher marks THAT one `acted` separately.
 */
export function applyDismissExisting(
  db: Database.Database,
  params: Record<string, unknown>,
): ActionResult {
  const idRaw = params.suggestion_id;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return fail('dismiss_existing', 'dismiss_existing requires a positive integer suggestion_id');
  }

  const existing = db
    .prepare('SELECT id, status FROM suggestions WHERE id = ?')
    .get(id) as { id: number; status: string } | undefined;
  if (!existing) {
    return fail('dismiss_existing', `suggestion_id ${id} does not exist`);
  }
  if (existing.status !== 'pending') {
    return fail(
      'dismiss_existing',
      `suggestion_id ${id} is "${existing.status}", not open; cannot dismiss`,
    );
  }

  try {
    db.prepare(
      `UPDATE suggestions
         SET status = 'dismissed',
             dismissed_at = datetime('now'),
             dismissed_reason = ?
       WHERE id = ?`,
    ).run('superseded by subconscious apply_action', id);
  } catch (err) {
    return fail('dismiss_existing', `failed to dismiss suggestion ${id}: ${errMsg(err)}`);
  }

  return ok('dismiss_existing', `Dismissed suggestion ${id}`, {
    data: { dismissed_suggestion_id: id },
  });
}

// ---------------------------------------------------------------------------
// create_brief — DRAFT a brief for operator approval (NO auto-insert)
// ---------------------------------------------------------------------------

/** Brief-type / priority hints — open strings, validated only for non-emptiness. */
const BRIEF_PROPOSAL_REQUIRED = ['title', 'type', 'priority', 'body'] as const;

/**
 * `create_brief` `{ proposed: { title, type, priority, body } }` — DRAFT a brief
 * for operator approval. CRITICAL: this does NOT create or insert a brief. It
 * validates the proposal is well-formed and RETURNS the draft as `data.draft`;
 * the operator reviews it and creates the real brief via /register. Auto-creating
 * a brief from an LLM suggestion would bypass the human gate — by design we
 * never do that.
 *
 * Validation: `proposed` must be an object carrying non-empty `title`, `type`,
 * `priority`, and `body` strings. Anything missing → fail (don't draft a
 * half-formed brief).
 */
export function applyCreateBrief(params: Record<string, unknown>): ActionResult {
  const proposed = asObject(params.proposed);
  if (!proposed) {
    return fail('create_brief', 'create_brief requires a "proposed" object');
  }
  for (const key of BRIEF_PROPOSAL_REQUIRED) {
    if (!asString(proposed[key])) {
      return fail('create_brief', `create_brief proposed.${key} must be a non-empty string`);
    }
  }

  const draft = {
    title: proposed.title as string,
    type: proposed.type as string,
    priority: proposed.priority as string,
    body: proposed.body as string,
  };

  return ok(
    'create_brief',
    'Brief DRAFTED for operator approval — NOT created. Create it via /register.',
    { data: { draft, requires_operator_approval: true } },
  );
}

// ---------------------------------------------------------------------------
// flag_for_review — surface "needs your eyes" (the safe fallback)
// ---------------------------------------------------------------------------

/**
 * `flag_for_review` `{ target_kind, target_id, concern }` — the safe fallback.
 * Surfaces a "needs your eyes" marker. This kind takes NO destructive action —
 * it just records the concern as the applied outcome, so it's also the
 * graceful sink for unknown kinds (see `index.ts`). The params are advisory; an
 * empty `concern` is tolerated (we default it) because flagging must never fail
 * the operator's review click.
 */
export function applyFlagForReview(params: Record<string, unknown>): ActionResult {
  const targetKind = asString(params.target_kind) ?? 'unspecified';
  const targetId = asString(params.target_id) ?? 'unspecified';
  const concern = asString(params.concern) ?? 'flagged for operator review';
  return ok('flag_for_review', `Flagged ${targetKind}:${targetId} for review`, {
    data: { target_kind: targetKind, target_id: targetId, concern },
  });
}

// ---------------------------------------------------------------------------
// add_edge — create a typed edge (validate BOTH nodes exist first)
// ---------------------------------------------------------------------------

/**
 * Node-type → backing-table mapping for existence checks. Mirrors
 * `edges/traversal.ts:LABEL_SCHEMA` (the canonical source of which table backs
 * each entity type). We only need the (table, idCol) pair to prove a node
 * RESOLVES before we let an edge reference it — don't invent edges to
 * hallucinated nodes.
 *
 * `brief` is keyed by `brief_id` (we ignore the project axis — the same axis
 * `LABEL_SCHEMA` ignores). `goal` ships with FR-110; if the table is absent the
 * existence check fails closed (we can't prove the node, so we reject the edge).
 */
const NODE_BACKING: Record<string, { table: string; idCol: string } | undefined> = {
  brief: { table: 'brief_status', idCol: 'brief_id' },
  learning: { table: 'learnings', idCol: 'id' },
  error: { table: 'errors', idCol: 'id' },
  session: { table: 'sessions', idCol: 'id' },
  goal: { table: 'goals', idCol: 'id' },
  concept: { table: 'graph_nodes', idCol: 'node_external_id' },
  decision: { table: 'graph_nodes', idCol: 'node_external_id' },
};

/**
 * Verify a (type, id) node exists in its backing table. Returns `true` only on
 * a confirmed row. A missing table (e.g. `goals` pre-FR-110) → `false`
 * (fail-closed: we cannot prove the node, so the edge is rejected rather than
 * inventing a reference). An unknown type → `false`.
 */
function nodeExists(db: Database.Database, type: string, id: string): boolean {
  const backing = NODE_BACKING[type];
  if (!backing) return false;
  try {
    const row = db
      .prepare(`SELECT 1 AS hit FROM ${backing.table} WHERE ${backing.idCol} = ? LIMIT 1`)
      .get(id) as { hit: number } | undefined;
    return row !== undefined;
  } catch {
    // Missing table or query error → cannot prove existence → fail closed.
    return false;
  }
}

/**
 * `add_edge` `{ from, to, edge_type, justification }` — create a typed edge.
 *
 * `from` and `to` are `{ type, id }` objects. We VALIDATE both nodes exist in
 * their backing tables BEFORE delegating to `handleEdgeCreate` — the edges
 * handler validates the type vocabulary + the edge_type + self-loops, but it
 * does NOT check the referenced rows actually exist (`INSERT OR IGNORE` would
 * happily store an edge to a non-existent id). So node-existence is OUR gate:
 * don't invent edges to hallucinated nodes.
 *
 * On success the edge is stored with `provenance: 'inferred'` (it came from the
 * subconscious, not a human observation) and a metadata note citing the action.
 */
export function applyAddEdge(
  db: Database.Database,
  params: Record<string, unknown>,
): ActionResult {
  const from = asObject(params.from);
  const to = asObject(params.to);
  const edgeType = asString(params.edge_type);
  if (!from || !asString(from.type) || !asString(from.id)) {
    return fail('add_edge', 'add_edge requires from: { type, id }');
  }
  if (!to || !asString(to.type) || !asString(to.id)) {
    return fail('add_edge', 'add_edge requires to: { type, id }');
  }
  if (!edgeType) {
    return fail('add_edge', 'add_edge requires a non-empty edge_type');
  }

  const fromType = from.type as string;
  const fromId = from.id as string;
  const toType = to.type as string;
  const toId = to.id as string;

  // Node-existence gate — both endpoints must resolve to a real row.
  if (!nodeExists(db, fromType, fromId)) {
    return fail('add_edge', `from node ${fromType}:${fromId} does not exist`);
  }
  if (!nodeExists(db, toType, toId)) {
    return fail('add_edge', `to node ${toType}:${toId} does not exist`);
  }

  // Delegate to the canonical edge creator (validates vocabulary + self-loops).
  const justification = asString(params.justification);
  const result = handleEdgeCreate({
    from_type: fromType,
    from_id: fromId,
    to_type: toType,
    to_id: toId,
    edge_type: edgeType,
    provenance: 'inferred',
    confidence: 0.85,
    metadata: {
      source: 'igris_suggestion_apply_action',
      ...(justification ? { justification } : {}),
    },
  });

  if (result.isError) {
    return fail('add_edge', `edge creation failed: ${result.content[0]?.text ?? 'unknown'}`);
  }

  let edge: unknown = undefined;
  try {
    edge = JSON.parse(result.content[0]?.text ?? '{}');
  } catch {
    /* leave edge undefined — the edge was still created */
  }
  return ok('add_edge', `Created ${edgeType} edge ${fromType}:${fromId} → ${toType}:${toId}`, {
    data: { edge: edge as Record<string, unknown> },
  });
}
