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
import { createHash } from 'node:crypto';
import { errMsg } from '../../../helpers.js';
import { handleEdgeCreate } from '../../edges/handlers.js';
import { deleteEmbedding } from '../../../../utils/vector-search.js';
import { logUndoEntry } from '../../janitor/undo.js';
import { candidateFromRow, findingKey } from '../finding-key.js';
import { recordDismissPattern } from '../runner.js';
import { LEGACY_PRODUCER_ID } from '../handlers.js';

/**
 * The `suggestions` columns `applyDismissExisting` needs to key a dismiss
 * pattern (TD-440). Read via `SELECT *`, so a pre-v5 row simply has the three
 * v5 fields undefined and falls back to a derived key.
 */
interface DismissableRow {
  id: number;
  status: string;
  project_slug: string | null;
  title: string;
  evidence: string | null;
  suggested_action: string | null;
  dedupe_key?: string | null;
  source_instance?: string | null;
}

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
  /** Guard refusal (TD-439). */
  refused?: string;
}

function fail(kind: string, error: string): ActionResult {
  return { ok: false, kind, message: error, error };
}

function refuse(kind: string, reason: string): ActionResult {
  return { ...fail(kind, reason), refused: reason };
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
    .prepare('SELECT * FROM suggestions WHERE id = ?')
    .get(id) as DismissableRow | undefined;
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
    // TD-440 — the SECOND dismiss writer now records the pattern too. It never
    // did: `handleSuggestionDismiss` recorded and this path did not, so a
    // suggestion the model itself superseded taught the loop nothing and came
    // straight back. Same key as the handler, so the two writers land on one row.
    recordDismissPattern(
      db,
      existing.source_instance ?? LEGACY_PRODUCER_ID,
      existing.project_slug,
      existing.dedupe_key ?? findingKey(candidateFromRow(existing)),
      'superseded by subconscious apply_action',
    );
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

  // Delegate to the canonical edge creator (validates vocabulary + self-loops,
  // and since BR-083 the project-qualification ladder).
  //
  // BR-083 — NO QUALIFIER IS PASSED, AND THAT IS THE CORRECT CHOICE HERE, NOT
  // AN OMISSION. A `suggested_action` carries `{type, id}` and nothing else, so
  // this call site has no project context to assert. The ladder resolves every
  // `|P| <= 1` endpoint for free — which is all of them today, since the
  // suggestion pipeline proposes `learning -> learning` edges over integer PKs
  // — and REFUSES an `|P| > 1` endpoint with the candidate list, which arrives
  // here as a structured `fail(...)` naming the projects. Inventing a project
  // from the suggestion's own `project_slug` would be exactly the guess this
  // brief forbids: the suggestion's project is where the INFERENCE ran, not
  // where the endpoint lives.
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

// ---------------------------------------------------------------------------
// merge_learnings — soft-delete a near-duplicate into a survivor (FR-119)
// ---------------------------------------------------------------------------

/** A `learnings` row the merge executor reads (identity + rollable counters + pre-state for undo). */
interface MergeLearningRow {
  id: number;
  content: string;
  seen_again_count: number | null;
  review_status: string | null;
}

/**
 * `merge_learnings` `{ survivor_id, duplicate_id, synthesized_content?,
 * justification }` — soft-delete a near-duplicate learning into a survivor.
 *
 * The most consequential kind yet (FR-119): it is the ONLY apply-action that
 * removes a learning from recall. It still fires ONLY on operator
 * `igris_suggestion_apply_action` (the human-in-the-loop invariant) OR from the
 * janitor's `auto_merge` fork (gated by cosine + LLM concurrence + a default-OFF
 * config flag).
 *
 * Validation (no merging hallucinated / self / already-merged rows):
 *   1. `survivor_id` + `duplicate_id` must be positive integers and DISTINCT.
 *   2. BOTH must resolve to real `learnings` rows (node-existence gate, the
 *      `applyAddEdge:361 nodeExists` discipline).
 *
 * Effect (single transaction — survivor data is NEVER lost):
 *   1. IDEMPOTENT: if the duplicate is already `review_status='merged'`, no-op.
 *   2. Roll `seen_again_count`: survivor += duplicate.seen_again_count + 1.
 *   3. If `synthesized_content` is present, UPDATE the survivor's content and
 *      NULL its `embedding`/`embedding_model` + drop its `learnings_vec` row so
 *      the FR-220 post-merge NULL-scan re-embeds it from the normalized
 *      fingerprint (the shipped `sync.ts` LWW-branch pattern — keeps
 *      `merge_learnings` synchronous; re-embed is async and happens off-path).
 *   4. Create a `derived_from` edge survivor→duplicate (lineage, Decision C).
 *   5. Soft-delete the duplicate: `review_status='merged'` (Decision A — the
 *      ~10 `review_status='approved'` readers auto-exclude it, ZERO read-path
 *      sweep) + stamp `deleted_at` + `merged_into=survivor_id` (audit only).
 *
 * The `derived_from` edge is written via `handleEdgeCreate` (uses `getDb()`
 * internally — the same live connection in production; tests mock `getDb`). It
 * participates in the surrounding transaction because it is the same connection.
 *
 * Never throws — a validation failure or a mid-transaction error returns
 * `{ ok:false }` so the suggestion stays `pending` (or the auto_merge fork
 * counts nothing).
 */
export function applyMergeLearnings(
  db: Database.Database,
  params: Record<string, unknown>,
): ActionResult {
  const survivorId = Number(params.survivor_id);
  const duplicateId = Number(params.duplicate_id);
  if (!Number.isInteger(survivorId) || survivorId <= 0) {
    return fail('merge_learnings', 'merge_learnings requires a positive integer survivor_id');
  }
  if (!Number.isInteger(duplicateId) || duplicateId <= 0) {
    return fail('merge_learnings', 'merge_learnings requires a positive integer duplicate_id');
  }
  if (survivorId === duplicateId) {
    return fail('merge_learnings', 'survivor_id and duplicate_id must be distinct');
  }

  const survivor = db
    .prepare('SELECT id, content, seen_again_count, review_status FROM learnings WHERE id = ?')
    .get(survivorId) as MergeLearningRow | undefined;
  if (!survivor) {
    return fail('merge_learnings', `survivor learning ${survivorId} does not exist`);
  }
  const duplicate = db
    .prepare('SELECT id, content, seen_again_count, review_status FROM learnings WHERE id = ?')
    .get(duplicateId) as MergeLearningRow | undefined;
  if (!duplicate) {
    return fail('merge_learnings', `duplicate learning ${duplicateId} does not exist`);
  }

  // IDEMPOTENT: re-applying a merge on an already-merged duplicate is a no-op.
  if ((duplicate.review_status ?? 'approved') === 'merged') {
    return ok('merge_learnings', `learning ${duplicateId} already merged; no-op`, {
      data: { survivor_id: survivorId, duplicate_id: duplicateId, already_merged: true },
    });
  }

  const synthesized = asString(params.synthesized_content);
  const justification = asString(params.justification);
  const rolledSeenAgain =
    (survivor.seen_again_count ?? 0) + (duplicate.seen_again_count ?? 0) + 1;

  try {
    const runMerge = db.transaction(() => {
      // 0. FR-116 M3 (Decision #2): capture pre-state to the undo log BEFORE
      //    mutating, so the merge is exactly reversible. Two entries (per-learning
      //    log): the DUPLICATE (soft-deleted; owns the derived_from edge
      //    survivor→duplicate for edge removal) and the SURVIVOR (content synthesis
      //    + seen_again roll). Fail-soft: logging never aborts this transaction.
      logUndoEntry(db, {
        action_kind: 'merge_learnings',
        learning_id: duplicateId,
        related_learning_id: survivorId,
        edge_type: 'derived_from',
        prior_review_status: duplicate.review_status ?? 'approved',
      });
      logUndoEntry(db, {
        action_kind: 'merge_learnings',
        learning_id: survivorId,
        prior_review_status: survivor.review_status ?? 'approved',
        prior_seen_again_count: survivor.seen_again_count ?? 0,
        ...(synthesized
          ? { prior_content: survivor.content, prior_embedding_nulled: true }
          : {}),
      });

      // 1. Roll seen_again_count into the survivor (+1 for this merge event).
      db.prepare(
        `UPDATE learnings
           SET seen_again_count = ?, last_seen_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      ).run(rolledSeenAgain, survivorId);

      // 2. Optional survivor content synthesis. NULL the embedding + drop the
      //    vec row so the async post-merge NULL-scan re-embeds from the
      //    normalized fingerprint (shipped sync.ts LWW-branch pattern) — keeps
      //    this executor synchronous.
      if (synthesized) {
        db.prepare(
          `UPDATE learnings
             SET content = ?, embedding = NULL, embedding_model = NULL,
                 updated_at = datetime('now')
           WHERE id = ?`,
        ).run(synthesized.slice(0, 1_000_000), survivorId);
        try {
          deleteEmbedding(db, survivorId);
        } catch {
          /* vec unavailable / row absent — the NULL BLOB alone drops it from recall */
        }
      }

      // 3. Lineage edge survivor→duplicate (Decision C). handleEdgeCreate uses
      //    getDb() internally; in production that is this same connection, so the
      //    write joins this transaction.
      const edgeResult = handleEdgeCreate({
        from_type: 'learning',
        from_id: String(survivorId),
        to_type: 'learning',
        to_id: String(duplicateId),
        edge_type: 'derived_from',
        provenance: 'inferred',
        confidence: 0.85,
        metadata: {
          source: 'merge_learnings',
          ...(justification ? { justification } : {}),
        },
      });
      if (edgeResult.isError) {
        // Abort the transaction so nothing partial lands.
        throw new Error(
          `derived_from edge creation failed: ${edgeResult.content[0]?.text ?? 'unknown'}`,
        );
      }

      // 4. Soft-delete the duplicate (Decision A). review_status='merged' hides
      //    it from every approved-filter reader; deleted_at + merged_into are
      //    audit-only.
      db.prepare(
        `UPDATE learnings
           SET review_status = 'merged',
               deleted_at = datetime('now'),
               merged_into = ?,
               updated_at = datetime('now')
         WHERE id = ?`,
      ).run(survivorId, duplicateId);
    });
    runMerge();
  } catch (err) {
    return fail('merge_learnings', `merge failed: ${errMsg(err)}`);
  }

  return ok(
    'merge_learnings',
    `Merged learning ${duplicateId} into ${survivorId} (seen_again_count rolled to ${rolledSeenAgain})`,
    {
      data: {
        survivor_id: survivorId,
        duplicate_id: duplicateId,
        seen_again_count: rolledSeenAgain,
        content_synthesized: Boolean(synthesized),
      },
    },
  );
}

// ---------------------------------------------------------------------------
// re_evaluate_rejection — surface a rejected pattern for reconsideration (FR-119)
// ---------------------------------------------------------------------------

/**
 * `re_evaluate_rejection` `{ target_learning_id?, evidence?, justification }` —
 * a NON-destructive "reconsider this rejection" flag (Decision D — DORMANT).
 *
 * Its source event `perception.rejected_pattern_recurring` never fires in
 * production today (reject is a hard DELETE, so no rejected row survives to
 * recur — perception/handlers.ts:427 gates the emit behind an env var). This
 * kind is BUILT so the path is ready: when FR-116 ships soft-delete-on-reject
 * and flips the emit, the janitor's tally will start surfacing these suggestions
 * and the operator can apply them here. It takes NO destructive action — it just
 * records the reconsideration marker as the applied outcome (a `flag_for_review`
 * sibling). Fail-closed on a missing justification/target is unnecessary because
 * flagging must never fail the operator's review click; advisory params default.
 */
export function applyReEvaluateRejection(
  params: Record<string, unknown>,
): ActionResult {
  const targetId = asString(params.target_learning_id) ?? 'unspecified';
  const concern =
    asString(params.justification) ??
    asString(params.concern) ??
    'a previously-rejected pattern recurred — reconsider the rejection';
  return ok(
    're_evaluate_rejection',
    `Surfaced rejected pattern (${targetId}) for re-evaluation`,
    { data: { target_learning_id: targetId, concern, requires_operator_review: true } },
  );
}

// ---------------------------------------------------------------------------
// resolve_contradiction — resolve two opposing learnings (FR-116 M2)
// ---------------------------------------------------------------------------

/** A `learnings` row the contradiction executor reads (identity + rollable counters). */
interface ContradictionLearningRow {
  id: number;
  content: string;
  seen_again_count: number | null;
  review_status: string | null;
}

const KIND_RESOLVE = 'resolve_contradiction';

/** sha256 hex of `text`. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Carry cap (chars). */
export const CARRY_CAP = 8_000;
/** Carried-section header. */
export const PRESERVED_MARKER = 'Preserved specifics from #';

const SPECIFIC_RES: readonly RegExp[] = [
  /`[^`\n]+`/g,
  /\b(?:[A-Z]{2}|L)-\d{2,4}\b/g,
  /https?:\/\/[^\s)>\]]+/g,
  /(?:[\w.-]+\/)*[\w.-]*[A-Za-z_][\w.-]*\.\w{2,5}(?::\d+(?:-\d+)?)?/g,
  /\/[a-z][\w-]*(?:\/[\w-]+)+/g,
  /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g,
  /\b\d+(?:\.\d+)?\s?(?:MB|KB|GB|MiB|KiB|ms)\b/g,
];
const FENCE_RE = /```[\s\S]*?```/g;
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** TD-439 specifics grammar. */
export function extractSpecifics(text: string): string[] {
  const out: string[] = [];
  for (const re of SPECIFIC_RES) for (const m of text.matchAll(re)) out.push(m[0]);
  return out;
}

export interface CarrySource {
  id: number;
  label: string;
  text: string;
}

/** Append what `synthesis` dropped from `sources`. */
export function carryForward(
  sources: readonly CarrySource[],
  synthesis: string,
): { text: string; carried: number; chars: number } {
  const syn = squash(synthesis);
  const has = (s: string): boolean => syn.includes(squash(s.replace(/^`|`$/g, '')));
  const seen = new Set<string>();
  const sections: string[] = [];
  let carried = 0;
  let chars = 0;
  for (const src of sources) {
    const units: Array<[string, boolean]> = [];
    const rest = src.text.replace(FENCE_RE, (b) => {
      units.push([b, true]);
      return '\n';
    });
    for (const line of rest.split('\n')) if (line.trim()) units.push([line.trim(), false]);
    const keep: string[] = [];
    for (const [u, block] of units) {
      const key = squash(u);
      if (seen.has(key) || syn.includes(key) || u.startsWith(PRESERVED_MARKER)) continue;
      if (!block && extractSpecifics(u).every(has)) continue;
      seen.add(key);
      keep.push(u);
      carried += 1;
      chars += u.length;
    }
    if (keep.length) {
      sections.push(`${PRESERVED_MARKER}${src.id} (${src.label}; TD-439):\n${keep.join('\n')}`);
    }
  }
  const text = sections.length ? `${synthesis}\n\n${sections.join('\n\n')}` : synthesis;
  return { text, carried, chars };
}

/** Load a learning row (identity + counters) or undefined. */
function loadContradictionRow(
  db: Database.Database,
  id: number,
): ContradictionLearningRow | undefined {
  return db
    .prepare('SELECT id, content, seen_again_count, review_status FROM learnings WHERE id = ?')
    .get(id) as ContradictionLearningRow | undefined;
}

/**
 * Supersede a loser learning IN THE SURROUNDING TRANSACTION: set
 * `review_status='superseded'` (Decision #1 — a NEW review_status value auto-
 * excluded by every `='approved'` reader → ZERO read-path sweep), stamp the
 * audit columns (`deleted_at` + `superseded_by` — AUDIT-ONLY, not a recall gate),
 * and write a `supersedes` edge winner→loser (`supersedes` is ALREADY in
 * VALID_EDGE_TYPES — no vocabulary change in M2). Throws on an edge failure so
 * the caller's transaction rolls back nothing partial.
 */
function supersedeLoser(
  db: Database.Database,
  winnerId: number,
  loserId: number,
  justification: string | undefined,
  source: string,
  priorReviewStatus: string | null = 'approved',
): void {
  // FR-116 M3 (Decision #2): capture pre-state to the undo log BEFORE the
  // supersede mutation, carrying the `supersedes` edge (winner→loser) so the
  // inverse can remove it. Fail-soft — never aborts the surrounding transaction.
  logUndoEntry(db, {
    action_kind: 'resolve_contradiction',
    learning_id: loserId,
    related_learning_id: winnerId,
    edge_type: 'supersedes',
    prior_review_status: priorReviewStatus ?? 'approved',
  });

  db.prepare(
    `UPDATE learnings
       SET review_status = 'superseded',
           deleted_at = datetime('now'),
           superseded_by = ?,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(winnerId, loserId);

  const edgeResult = handleEdgeCreate({
    from_type: 'learning',
    from_id: String(winnerId),
    to_type: 'learning',
    to_id: String(loserId),
    edge_type: 'supersedes',
    provenance: 'inferred',
    confidence: 0.85,
    metadata: {
      source,
      ...(justification ? { justification } : {}),
    },
  });
  if (edgeResult.isError) {
    throw new Error(
      `supersedes edge creation failed: ${edgeResult.content[0]?.text ?? 'unknown'}`,
    );
  }
}

/**
 * `resolve_contradiction` `{ resolution, ... }` — resolve two OPPOSING learnings
 * (FR-116 M2). The `resolution` discriminator selects one of three executors:
 *
 *   - newer_wins        `{ winner_id, loser_id, justification }` — the older claim
 *     is obsolete. Supersede the loser (`review_status='superseded'` + audit
 *     columns), write a `supersedes` edge winner→loser. The winner is untouched.
 *   - both_valid_scope  `{ learning_a_id, learning_b_id, scope_a?, scope_b? }` —
 *     NOT a true conflict: both hold under different scopes. NON-DESTRUCTIVE —
 *     append a `[valid-scope: …]` annotation to each learning's content (NULLing
 *     its embedding so the FR-220 NULL-scan re-embeds). Neither is deleted.
 *   - evolved_merge     `{ winner_id, loser_id, synthesized_content, justification }`
 *     — the conflict resolves into a single evolved understanding: write the
 *     synthesized content onto the winner (NULLing its embedding), roll
 *     seen_again_count, and supersede the loser (like newer_wins).
 *
 * Every path is a single transaction, idempotent (a no-op when the loser is
 * already superseded / the scope already annotated), validates every target id
 * resolves (no hallucinated ids), and NEVER throws — a validation failure or a
 * mid-transaction error returns `{ ok:false }` so the suggestion stays `pending`
 * (or the auto_resolve fork counts nothing). Reuses the `supersedes` edge type
 * (no VALID_EDGE_TYPES change in M2).
 */
export function applyResolveContradiction(
  db: Database.Database,
  params: Record<string, unknown>,
): ActionResult {
  const resolution = asString(params.resolution);
  if (!resolution) {
    return fail(KIND_RESOLVE, 'resolve_contradiction requires a "resolution"');
  }
  const justification = asString(params.justification);

  // -------------------------------------------------------------------------
  // both_valid_scope — non-destructive scope annotation (no delete).
  // -------------------------------------------------------------------------
  if (resolution === 'both_valid_scope') {
    const aId = Number(params.learning_a_id);
    const bId = Number(params.learning_b_id);
    if (!Number.isInteger(aId) || aId <= 0 || !Number.isInteger(bId) || bId <= 0) {
      return fail(
        KIND_RESOLVE,
        'both_valid_scope requires positive integer learning_a_id + learning_b_id',
      );
    }
    if (aId === bId) {
      return fail(KIND_RESOLVE, 'learning_a_id and learning_b_id must be distinct');
    }
    const a = loadContradictionRow(db, aId);
    if (!a) return fail(KIND_RESOLVE, `learning ${aId} does not exist`);
    const b = loadContradictionRow(db, bId);
    if (!b) return fail(KIND_RESOLVE, `learning ${bId} does not exist`);

    const scopeA = asString(params.scope_a);
    const scopeB = asString(params.scope_b);
    if (!scopeA && !scopeB) {
      return fail(KIND_RESOLVE, 'both_valid_scope requires at least one of scope_a / scope_b');
    }

    // Idempotent per-side: only append an annotation not already present.
    const annotate = (content: string, scope: string): string | null => {
      const marker = `[valid-scope: ${scope.slice(0, 300)}]`;
      if (content.includes(marker)) return null; // already annotated — no-op
      return `${content}\n\n${marker}`;
    };

    try {
      const runAnnotate = db.transaction(() => {
        if (scopeA) {
          const next = annotate(a.content, scopeA);
          if (next !== null) {
            // Undo: capture the pre-annotation content (Decision #2).
            logUndoEntry(db, {
              action_kind: 'resolve_contradiction',
              learning_id: aId,
              prior_review_status: a.review_status ?? 'approved',
              prior_content: a.content,
              prior_embedding_nulled: true,
            });
            db.prepare(
              `UPDATE learnings
                 SET content = ?, embedding = NULL, embedding_model = NULL,
                     updated_at = datetime('now')
               WHERE id = ?`,
            ).run(next.slice(0, 1_000_000), aId);
            try {
              deleteEmbedding(db, aId);
            } catch {
              /* vec unavailable / row absent — the NULL BLOB alone triggers re-embed */
            }
          }
        }
        if (scopeB) {
          const next = annotate(b.content, scopeB);
          if (next !== null) {
            // Undo: capture the pre-annotation content (Decision #2).
            logUndoEntry(db, {
              action_kind: 'resolve_contradiction',
              learning_id: bId,
              prior_review_status: b.review_status ?? 'approved',
              prior_content: b.content,
              prior_embedding_nulled: true,
            });
            db.prepare(
              `UPDATE learnings
                 SET content = ?, embedding = NULL, embedding_model = NULL,
                     updated_at = datetime('now')
               WHERE id = ?`,
            ).run(next.slice(0, 1_000_000), bId);
            try {
              deleteEmbedding(db, bId);
            } catch {
              /* vec unavailable / row absent */
            }
          }
        }
      });
      runAnnotate();
    } catch (err) {
      return fail(KIND_RESOLVE, `scope annotation failed: ${errMsg(err)}`);
    }

    return ok(
      KIND_RESOLVE,
      `Annotated scope for learnings ${aId} + ${bId} (both retained)`,
      {
        data: {
          resolution,
          learning_a_id: aId,
          learning_b_id: bId,
          ...(scopeA ? { scope_a: scopeA } : {}),
          ...(scopeB ? { scope_b: scopeB } : {}),
        },
      },
    );
  }

  // -------------------------------------------------------------------------
  // newer_wins / evolved_merge — supersede the loser (destructive-but-reversible).
  // -------------------------------------------------------------------------
  if (resolution !== 'newer_wins' && resolution !== 'evolved_merge') {
    return fail(KIND_RESOLVE, `unknown resolution "${resolution}"`);
  }

  const winnerId = Number(params.winner_id);
  const loserId = Number(params.loser_id);
  if (!Number.isInteger(winnerId) || winnerId <= 0) {
    return fail(KIND_RESOLVE, `${resolution} requires a positive integer winner_id`);
  }
  if (!Number.isInteger(loserId) || loserId <= 0) {
    return fail(KIND_RESOLVE, `${resolution} requires a positive integer loser_id`);
  }
  if (winnerId === loserId) {
    return fail(KIND_RESOLVE, 'winner_id and loser_id must be distinct');
  }

  const winner = loadContradictionRow(db, winnerId);
  if (!winner) return fail(KIND_RESOLVE, `winner learning ${winnerId} does not exist`);
  const loser = loadContradictionRow(db, loserId);
  if (!loser) return fail(KIND_RESOLVE, `loser learning ${loserId} does not exist`);

  // IDEMPOTENT: re-applying when the loser is already superseded is a no-op.
  if ((loser.review_status ?? 'approved') === 'superseded') {
    return ok(KIND_RESOLVE, `learning ${loserId} already superseded; no-op`, {
      data: { resolution, winner_id: winnerId, loser_id: loserId, already_superseded: true },
    });
  }

  const synthesized = asString(params.synthesized_content);
  if (resolution === 'evolved_merge' && !synthesized) {
    return fail(KIND_RESOLVE, 'evolved_merge requires a non-empty synthesized_content');
  }

  // TD-439 guard.
  let merged = { text: synthesized ?? '', carried: 0, chars: 0 };
  if (resolution === 'evolved_merge') {
    const expected = asString(params.synthesized_from_hash);
    if (!expected) {
      return refuse(
        KIND_RESOLVE,
        'no synthesis provenance (pre-TD-439 suggestion) — dismiss it; the next arbiter run regenerates the pair',
      );
    }
    if (expected !== contentHash(winner.content)) {
      return refuse(
        KIND_RESOLVE,
        `winner #${winnerId} changed since the synthesis was computed (content hash mismatch) — dismiss and regenerate`,
      );
    }
    merged = carryForward(
      [
        { id: winnerId, label: 'pre-merge', text: winner.content },
        { id: loserId, label: 'superseded', text: loser.content },
      ],
      synthesized!,
    );
    if (merged.chars > CARRY_CAP) {
      return refuse(
        KIND_RESOLVE,
        `carry-forward of ${merged.chars} chars exceeds CARRY_CAP ${CARRY_CAP} — resolve with newer_wins or dismiss`,
      );
    }
  }

  const rolledSeenAgain =
    (winner.seen_again_count ?? 0) + (loser.seen_again_count ?? 0) + 1;

  try {
    const runResolve = db.transaction(() => {
      if (resolution === 'evolved_merge') {
        // Undo: capture the winner's pre-evolution content + seen_again_count
        // (Decision #2) BEFORE overwriting them.
        logUndoEntry(db, {
          action_kind: 'resolve_contradiction',
          learning_id: winnerId,
          prior_review_status: winner.review_status ?? 'approved',
          prior_content: winner.content,
          prior_seen_again_count: winner.seen_again_count ?? 0,
          prior_embedding_nulled: true,
        });
        // Evolve the winner: write the reconciled content + roll seen_again_count,
        // NULL the embedding so the FR-220 post-change NULL-scan re-embeds it.
        db.prepare(
          `UPDATE learnings
             SET content = ?, seen_again_count = ?, last_seen_at = datetime('now'),
                 embedding = NULL, embedding_model = NULL, updated_at = datetime('now')
           WHERE id = ?`,
        ).run(merged.text.slice(0, 1_000_000), rolledSeenAgain, winnerId);
        try {
          deleteEmbedding(db, winnerId);
        } catch {
          /* vec unavailable / row absent — the NULL BLOB alone drops it from recall */
        }
      }
      // Both newer_wins + evolved_merge supersede the loser + write the edge.
      supersedeLoser(db, winnerId, loserId, justification, KIND_RESOLVE, loser.review_status ?? 'approved');
    });
    runResolve();
  } catch (err) {
    return fail(KIND_RESOLVE, `resolve failed: ${errMsg(err)}`);
  }

  const message =
    resolution === 'evolved_merge'
      ? `Evolved learning ${winnerId} + superseded ${loserId} (seen_again_count rolled to ${rolledSeenAgain})`
      : `Superseded learning ${loserId} in favour of ${winnerId}`;
  return ok(KIND_RESOLVE, message, {
    data: {
      resolution,
      winner_id: winnerId,
      loser_id: loserId,
      ...(resolution === 'evolved_merge'
        ? { seen_again_count: rolledSeenAgain, content_synthesized: true, specifics_carried: merged.carried }
        : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// prune_learning — prune / lower-confidence / keep an outdated learning (FR-116 M3)
// ---------------------------------------------------------------------------

/** A `learnings` row the prune executor reads (identity + pre-state for undo). */
interface PruneLearningRow {
  id: number;
  confidence: number | null;
  review_status: string | null;
}

const KIND_PRUNE = 'prune_learning';

/**
 * `prune_learning` `{ verdict, learning_id, confidence_delta?, justification }` —
 * act on an OUTDATED-KNOWLEDGE candidate the curator reviewed (FR-116 M3). The
 * `verdict` discriminator selects one of three executors:
 *
 *   - prune            `{ learning_id }` — soft-delete the learning:
 *     `review_status='pruned'` (Decision #1 — a NEW review_status value auto-
 *     excluded by every `='approved'` reader → ZERO read-path sweep) + stamp
 *     `deleted_at` (AUDIT-ONLY, not a recall gate). Idempotent: re-pruning an
 *     already-`'pruned'` row is a no-op.
 *   - lower_confidence `{ learning_id, confidence_delta }` — NON-DESTRUCTIVE:
 *     `confidence = max(0, confidence - delta)`, clamped to the db.ts:164 CHECK
 *     [0, 1] bound. The learning stays recallable.
 *   - keep             `{ learning_id }` — NON-DESTRUCTIVE: stamp
 *     `last_reviewed_at` so the deterministic detector does not re-flag the row
 *     until the next stale window elapses.
 *
 * Every path is a single transaction, validates the target id resolves (no
 * hallucinated ids), and NEVER throws — a validation failure or a mid-transaction
 * error returns `{ ok:false }` so the suggestion stays `pending` (or the
 * auto_prune fork counts nothing). Destructive/mutating verdicts (prune,
 * lower_confidence) capture pre-state to the undo log (Decision #2) BEFORE
 * mutating so the action is exactly reversible. `undoRunId` links the entry to a
 * maintenance run (the auto_prune fork passes it; the operator-apply path passes
 * null → the entry is undoable by entry_id).
 */
export function applyPruneLearning(
  db: Database.Database,
  params: Record<string, unknown>,
  undoRunId: string | null = null,
): ActionResult {
  const verdict = asString(params.verdict);
  if (!verdict) {
    return fail(KIND_PRUNE, 'prune_learning requires a "verdict"');
  }
  if (verdict !== 'prune' && verdict !== 'lower_confidence' && verdict !== 'keep') {
    return fail(KIND_PRUNE, `unknown verdict "${verdict}"`);
  }

  const learningId = Number(params.learning_id);
  if (!Number.isInteger(learningId) || learningId <= 0) {
    return fail(KIND_PRUNE, 'prune_learning requires a positive integer learning_id');
  }

  const row = db
    .prepare('SELECT id, confidence, review_status FROM learnings WHERE id = ?')
    .get(learningId) as PruneLearningRow | undefined;
  if (!row) return fail(KIND_PRUNE, `learning ${learningId} does not exist`);

  // -------------------------------------------------------------------------
  // prune — soft-delete via review_status='pruned' (destructive-but-reversible).
  // -------------------------------------------------------------------------
  if (verdict === 'prune') {
    // IDEMPOTENT: re-pruning an already-pruned row is a no-op.
    if ((row.review_status ?? 'approved') === 'pruned') {
      return ok(KIND_PRUNE, `learning ${learningId} already pruned; no-op`, {
        data: { verdict, learning_id: learningId, already_pruned: true },
      });
    }
    try {
      const runPrune = db.transaction(() => {
        logUndoEntry(db, {
          run_id: undoRunId,
          action_kind: 'prune_learning',
          learning_id: learningId,
          prior_review_status: row.review_status ?? 'approved',
        });
        db.prepare(
          `UPDATE learnings
             SET review_status = 'pruned',
                 deleted_at = datetime('now'),
                 updated_at = datetime('now')
           WHERE id = ?`,
        ).run(learningId);
      });
      runPrune();
    } catch (err) {
      return fail(KIND_PRUNE, `prune failed: ${errMsg(err)}`);
    }
    return ok(KIND_PRUNE, `Pruned learning ${learningId} (soft-delete, reversible)`, {
      data: { verdict, learning_id: learningId },
    });
  }

  // -------------------------------------------------------------------------
  // lower_confidence — non-destructive confidence decrement (clamped to [0, 1]).
  // -------------------------------------------------------------------------
  if (verdict === 'lower_confidence') {
    let delta = Number(params.confidence_delta);
    if (!Number.isFinite(delta) || delta <= 0) {
      return fail(KIND_PRUNE, 'lower_confidence requires a positive confidence_delta');
    }
    if (delta > 1) delta = 1;
    const current = typeof row.confidence === 'number' ? row.confidence : 0.5;
    const next = Math.max(0, Math.min(1, current - delta));
    try {
      const runLower = db.transaction(() => {
        logUndoEntry(db, {
          run_id: undoRunId,
          action_kind: 'lower_confidence',
          learning_id: learningId,
          prior_review_status: row.review_status ?? 'approved',
          prior_confidence: current,
        });
        db.prepare(
          `UPDATE learnings
             SET confidence = ?, last_reviewed_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`,
        ).run(next, learningId);
      });
      runLower();
    } catch (err) {
      return fail(KIND_PRUNE, `lower_confidence failed: ${errMsg(err)}`);
    }
    return ok(
      KIND_PRUNE,
      `Lowered confidence of learning ${learningId} from ${current} to ${next}`,
      { data: { verdict, learning_id: learningId, confidence: next, prior_confidence: current } },
    );
  }

  // -------------------------------------------------------------------------
  // keep — non-destructive: stamp last_reviewed_at (no undo needed).
  // -------------------------------------------------------------------------
  try {
    db.prepare(
      `UPDATE learnings SET last_reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(learningId);
  } catch (err) {
    return fail(KIND_PRUNE, `keep failed: ${errMsg(err)}`);
  }
  return ok(KIND_PRUNE, `Kept learning ${learningId} (marked reviewed)`, {
    data: { verdict, learning_id: learningId },
  });
}

// ---------------------------------------------------------------------------
// cluster_meta — synthesize a cluster of learnings into a meta-learning (FR-116 M4)
// ---------------------------------------------------------------------------

const KIND_CLUSTER_META = 'cluster_meta';

/** Coerce an unknown into a de-duplicated array of positive-integer learning ids. */
function asLearningIdList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<number>();
  for (const raw of v) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return Array.from(seen);
}

/**
 * `cluster_meta` `{ cluster_member_ids, title, synthesized_summary, confidence? }`
 * — create a synthesized META-LEARNING that summarizes a cluster of related
 * learnings and wire `cluster_member_of` edges from each member → the meta
 * (FR-116 M4). The cartographer proposes it; the operator applies it (or the
 * `auto_fork` fork applies it directly).
 *
 * Validation (no summarizing hallucinated / empty clusters):
 *   1. `cluster_member_ids` must be an array of at least TWO distinct positive
 *      integer learning ids.
 *   2. `synthesized_summary` + `title` must be non-empty strings.
 *   3. EVERY cited member must resolve to a real `learnings` row (node-existence
 *      gate — don't wire a meta to a hallucinated member).
 *
 * Effect (single transaction — additive, never destructive):
 *   1. INSERT a new meta-learning (project = the first member's project;
 *      category='pattern'; review_status defaults to 'approved' so it is
 *      recallable). Its content is the synthesized summary.
 *   2. For each member, create a `cluster_member_of` edge member → meta via
 *      `handleEdgeCreate` (learning #206 — never a direct edge INSERT).
 *   3. Log ONE undo entry (`action_kind='cluster_meta'`, `learning_id`=the new
 *      meta id) so `performUndo` can reverse the whole thing (delete the meta +
 *      its `cluster_member_of` edges). `undoRunId` links it to a maintenance run
 *      (the auto_fork fork passes it; the operator-apply path passes null → the
 *      entry is undoable by entry_id).
 *
 * Never throws — a validation failure or a mid-transaction error returns
 * `{ ok:false }` so the suggestion stays `pending` (or the auto_fork counts
 * nothing).
 */
export function applyClusterMeta(
  db: Database.Database,
  params: Record<string, unknown>,
  undoRunId: string | null = null,
): ActionResult {
  const memberIds = asLearningIdList(params.cluster_member_ids);
  if (memberIds.length < 2) {
    return fail(
      KIND_CLUSTER_META,
      'cluster_meta requires cluster_member_ids: an array of at least 2 distinct learning ids',
    );
  }
  const summary = asString(params.synthesized_summary);
  if (!summary) {
    return fail(KIND_CLUSTER_META, 'cluster_meta requires a non-empty synthesized_summary');
  }
  const title = asString(params.title) ?? `Cluster meta-learning (${memberIds.length} members)`;
  const confidenceRaw = Number(params.confidence);
  const confidence =
    Number.isFinite(confidenceRaw) && confidenceRaw >= 0 && confidenceRaw <= 1
      ? confidenceRaw
      : 0.7;

  // Node-existence gate — every member must resolve to a real learnings row, and
  // capture the first member's project for the meta-learning's project column.
  let project = 'global';
  let firstFound = false;
  for (const id of memberIds) {
    const row = db
      .prepare('SELECT id, project FROM learnings WHERE id = ?')
      .get(id) as { id: number; project: string } | undefined;
    if (!row) {
      return fail(KIND_CLUSTER_META, `cluster member learning ${id} does not exist`);
    }
    if (!firstFound) {
      project = typeof row.project === 'string' && row.project.length > 0 ? row.project : 'global';
      firstFound = true;
    }
  }

  let metaId = 0;
  try {
    const runClusterMeta = db.transaction(() => {
      // 1. Create the synthesized meta-learning. Only the NOT-NULL columns are set
      //    explicitly; the rest take their schema defaults (scope='local',
      //    review_status='approved', provenance='observed', source_extractor='manual')
      //    so this INSERT is robust across brain schema versions.
      const insert = db
        .prepare(
          `INSERT INTO learnings (project, category, title, content, confidence)
           VALUES (?, 'pattern', ?, ?, ?)`,
        )
        .run(project, title.slice(0, 500), summary.slice(0, 1_000_000), confidence);
      metaId = Number(insert.lastInsertRowid);

      // 2. Wire cluster_member_of edges member → meta (via handleEdgeCreate — #206).
      for (const memberId of memberIds) {
        const edgeResult = handleEdgeCreate({
          from_type: 'learning',
          from_id: String(memberId),
          to_type: 'learning',
          to_id: String(metaId),
          edge_type: 'cluster_member_of',
          provenance: 'inferred',
          confidence: 0.85,
          metadata: { source: 'cluster_meta' },
        });
        if (edgeResult.isError) {
          throw new Error(
            `cluster_member_of edge creation failed: ${edgeResult.content[0]?.text ?? 'unknown'}`,
          );
        }
      }

      // 3. Log ONE undo entry keyed on the NEW meta id (logged AFTER the INSERT —
      //    the meta had no pre-state; the inverse DELETES it + its edges). Fail-soft.
      logUndoEntry(db, {
        run_id: undoRunId,
        action_kind: 'cluster_meta',
        learning_id: metaId,
      });
    });
    runClusterMeta();
  } catch (err) {
    return fail(KIND_CLUSTER_META, `cluster_meta failed: ${errMsg(err)}`);
  }

  return ok(
    KIND_CLUSTER_META,
    `Created meta-learning ${metaId} summarizing ${memberIds.length} learnings + wired cluster_member_of edges`,
    {
      data: {
        meta_learning_id: metaId,
        cluster_member_ids: memberIds,
        member_count: memberIds.length,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// propose_edge_type — acknowledge a proposed canonical edge type (FR-116 M5)
// ---------------------------------------------------------------------------

const KIND_PROPOSE_EDGE_TYPE = 'propose_edge_type';

/**
 * The repo file + constant a human edits to actually add a canonical edge type.
 * Surfaced in the apply result so the operator knows the follow-up is a CODE
 * EDIT, not a runtime mutation.
 */
const VOCAB_TARGET_FILE = 'brain-mcp-server/src/engine/components/edges/handlers.ts';
const VOCAB_TARGET_CONST = 'VALID_EDGE_TYPES';

/**
 * `propose_edge_type` `{ proposed_name, signature, occurrence_count?, ... }` — the
 * INFORMATIONAL acknowledgement of an emergent edge-type proposal (FR-116 M5,
 * Decision #3b). The deterministic emergence sweep (`janitor/emergence.ts`)
 * surfaces this suggestion when a novel metadata signature recurs ≥ N times on
 * inferred edges.
 *
 * PROPOSAL-ONLY — this kind does NOT mutate the edge vocabulary. `VALID_EDGE_TYPES`
 * is a `readonly` array; runtime mutation is deliberately OUT OF SCOPE (the
 * dynamic registry is DEFERRED). It takes NO destructive action and writes NO
 * durable record beyond the dispatcher marking the suggestion `acted` (idempotent
 * — the apply layer refuses to re-apply an acted suggestion). It merely records
 * the operator's acknowledgement and RETURNS a message making the human follow-up
 * explicit: to make the type canonical, a human must add it to `VALID_EDGE_TYPES`
 * in `edges/handlers.ts` (+ the row-100 consumer sweep). Because it makes no
 * durable mutation, it needs NO undo entry. A `flag_for_review` sibling — advisory
 * params default so acknowledging never fails the operator's review click.
 */
export function applyProposeEdgeType(params: Record<string, unknown>): ActionResult {
  const proposedName = asString(params.proposed_name) ?? asString(params.signature) ?? 'unnamed';
  const signature = asString(params.signature) ?? proposedName;
  const occurrenceRaw = Number(params.occurrence_count);
  const occurrenceCount =
    Number.isFinite(occurrenceRaw) && occurrenceRaw > 0 ? Math.floor(occurrenceRaw) : undefined;
  return ok(
    KIND_PROPOSE_EDGE_TYPE,
    `Acknowledged edge-type proposal "${proposedName}". PROPOSAL-ONLY: the vocabulary was NOT ` +
      `modified at runtime (VALID_EDGE_TYPES is unchanged). To make it canonical, a human must add ` +
      `'${proposedName}' to ${VOCAB_TARGET_CONST} in ${VOCAB_TARGET_FILE} + sweep the row-100 consumers.`,
    {
      data: {
        proposed_name: proposedName,
        signature,
        ...(occurrenceCount !== undefined ? { occurrence_count: occurrenceCount } : {}),
        vocabulary_mutated: false,
        requires_code_edit: true,
        target_file: VOCAB_TARGET_FILE,
        target_constant: VOCAB_TARGET_CONST,
        requires_operator_review: true,
      },
    },
  );
}
