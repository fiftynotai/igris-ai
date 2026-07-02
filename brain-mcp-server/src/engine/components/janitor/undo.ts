/**
 * Brain Engine v7.1 — Maintenance UNDO infrastructure (FR-116 M3, Decision #2).
 *
 * The critical safety net for the destructive maintenance ops. EVERY mutating
 * resolver (merge_learnings, resolve_contradiction, prune_learning, confidence
 * bump/lower) writes a PRE-STATE row to `brain_maintenance_undo` at apply time —
 * capturing the exact prior values BEFORE mutating — so the action is exactly
 * reversible. `performUndo` replays the inverse in a single transaction:
 * restores `review_status` / `confidence` / `seen_again_count` / `content`
 * (re-embedding on content restore via the FR-220 re-embed-on-NULL pattern),
 * clears the audit stamps (`deleted_at` / `merged_into` / `superseded_by`),
 * removes the edge the action created, and stamps `undone_at`.
 *
 * DESIGN — one undo entry PER MUTATED LEARNING (Decision #2's per-learning log):
 * a merge/evolved_merge mutates TWO rows (survivor/winner content + roll AND the
 * soft-deleted loser/duplicate), so it logs TWO entries; both_valid_scope
 * annotates two rows, so it logs two entries. Each entry is independently
 * reversible. The entry that "owns" the created edge carries `related_learning_id`
 * + `edge_type` so the inverse can hard-delete it.
 *
 * FAIL-SOFT LOGGING (load-bearing): `logUndoEntry` swallows ALL errors internally
 * so it NEVER aborts the surrounding resolver transaction. This is what makes the
 * M1/M2 retrofit purely additive — a brain that has not applied the v3 migration
 * (no `brain_maintenance_undo` table) simply does not record undo entries; the
 * resolvers' existing behavior + contracts are unchanged.
 *
 * @module engine/components/janitor/undo
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { deleteEmbedding } from '../../../utils/vector-search.js';

/** The action kinds that write undo entries (the reverse-replay dispatch keys). */
export type UndoActionKind =
  | 'merge_learnings'
  | 'resolve_contradiction'
  | 'prune_learning'
  | 'confidence_bump'
  | 'lower_confidence';

/**
 * One pre-state capture for a single mutated learning. Every `prior_*` field is
 * the value BEFORE the action mutated the row; the inverse restores them. Fields
 * left `undefined`/`null` are not restored (COALESCE keeps the current value for
 * confidence/seen_again_count; the audit stamps are always cleared to their prior
 * — null for a pre-mutation approved row).
 */
export interface UndoEntry {
  /** The maintenance run id (links the entry to `brain_maintenance_runs`); null for operator applies. */
  run_id?: string | null;
  /** The action kind that produced the mutation. */
  action_kind: UndoActionKind;
  /** The mutated learning id (loser / duplicate / pruned / winner / annotated / bumped). */
  learning_id: number;
  /** The OTHER row in the pair (survivor / winner) — used to find + remove the created edge. */
  related_learning_id?: number | null;
  /** The edge type created FROM `related_learning_id` TO `learning_id` (removed on undo). */
  edge_type?: string | null;
  /** review_status before the mutation (usually 'approved'). */
  prior_review_status?: string | null;
  /** confidence before the mutation (only for confidence changes). */
  prior_confidence?: number | null;
  /** content before the mutation (only when the action rewrote content). */
  prior_content?: string | null;
  /** seen_again_count before the mutation (only when the action rolled it). */
  prior_seen_again_count?: number | null;
  /** 1 when the action NULLed the embedding (documented; undo always re-NULLs on content restore). */
  prior_embedding_nulled?: boolean;
}

/**
 * Write a pre-state row to `brain_maintenance_undo`. FAIL-SOFT: swallows ALL
 * errors (e.g. the table is absent on a brain that has not applied v3) so it can
 * be called INSIDE a resolver transaction without ever aborting it. This is the
 * additive undo-logging retrofit's safety property.
 */
export function logUndoEntry(db: Database.Database, entry: UndoEntry): void {
  try {
    db.prepare(
      `INSERT INTO brain_maintenance_undo
         (run_id, action_kind, learning_id, related_learning_id, edge_type,
          prior_review_status, prior_confidence, prior_content,
          prior_seen_again_count, prior_embedding_nulled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.run_id ?? null,
      entry.action_kind,
      entry.learning_id,
      entry.related_learning_id ?? null,
      entry.edge_type ?? null,
      entry.prior_review_status ?? null,
      entry.prior_confidence ?? null,
      entry.prior_content ?? null,
      entry.prior_seen_again_count ?? null,
      entry.prior_embedding_nulled ? 1 : 0,
    );
  } catch {
    /* undo table absent / write error — logging is best-effort, never aborts the resolver */
  }
}

/** One `brain_maintenance_undo` row as read for the inverse replay. */
interface UndoRow {
  id: number;
  run_id: string | null;
  action_kind: string;
  learning_id: number;
  related_learning_id: number | null;
  edge_type: string | null;
  prior_review_status: string | null;
  prior_confidence: number | null;
  prior_content: string | null;
  prior_seen_again_count: number | null;
  prior_embedding_nulled: number;
  undone_at: string | null;
}

/** The outcome of an `performUndo` call. */
export interface UndoResult {
  ok: boolean;
  /** Number of undo entries reversed this call (already-undone entries are skipped). */
  reversed: number;
  /** Human-readable message (error on failure, confirmation on success). */
  message: string;
  /** The run_id targeted (when targeting by run). */
  run_id?: string;
  /** The entry_id targeted (when targeting a single entry). */
  entry_id?: number;
}

/**
 * Reverse a maintenance action (FR-116 M3, Decision #2). Targets EITHER a whole
 * run (`run_id` — reverses every not-yet-undone entry of that run) OR a single
 * entry (`entry_id`). In one transaction, for each targeted entry (newest first
 * so a merge's two entries unwind cleanly):
 *
 *   1. Restore the learning row: review_status / confidence / seen_again_count /
 *      content, clearing the audit stamps. When `prior_content` is present, NULL
 *      the embedding + drop the vec row so the FR-220 async NULL-scan re-embeds
 *      the RESTORED content.
 *   2. Remove the edge the action created (`related_learning_id` →
 *      `learning_id`, `edge_type`), if any.
 *   3. Stamp `undone_at`.
 *
 * IDEMPOTENT: entries already stamped `undone_at` are skipped (undo of an
 * already-undone run/entry reverses nothing and still returns ok). A target that
 * resolves to ZERO entries (nonexistent run/entry, or all already undone) returns
 * `ok:false` with a clean message — no throw. When targeting a run, the matching
 * `brain_maintenance_runs.undone` counter is bumped by the number reversed.
 */
export function performUndo(
  db: Database.Database,
  target: { run_id?: string; entry_id?: number },
): UndoResult {
  const runId = typeof target.run_id === 'string' && target.run_id.length > 0 ? target.run_id : null;
  const entryId =
    Number.isInteger(target.entry_id) && (target.entry_id as number) > 0
      ? (target.entry_id as number)
      : null;
  if (!runId && !entryId) {
    return { ok: false, reversed: 0, message: 'undo requires a run_id or entry_id' };
  }

  let rows: UndoRow[];
  try {
    rows = (
      runId
        ? db
            .prepare(
              `SELECT * FROM brain_maintenance_undo
                WHERE run_id = ? AND undone_at IS NULL
                ORDER BY id DESC`,
            )
            .all(runId)
        : db
            .prepare(
              `SELECT * FROM brain_maintenance_undo
                WHERE id = ? AND undone_at IS NULL`,
            )
            .all(entryId)
    ) as UndoRow[];
  } catch (err) {
    return {
      ok: false,
      reversed: 0,
      message: `undo failed to read the undo log: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (rows.length === 0) {
    // Distinguish "nothing to undo" (already undone / absent) cleanly.
    const label = runId ? `run "${runId}"` : `entry ${entryId}`;
    return {
      ok: false,
      reversed: 0,
      message: `no reversible undo entries found for ${label}`,
      ...(runId ? { run_id: runId } : {}),
      ...(entryId ? { entry_id: entryId } : {}),
    };
  }

  try {
    const runUndo = db.transaction(() => {
      for (const row of rows) {
        const restoreContent = row.prior_content !== null && row.prior_content !== undefined;
        // 1. Restore the learning row. deleted_at/merged_into/superseded_by are
        //    always cleared (their pre-mutation value on an approved row is null).
        if (restoreContent) {
          db.prepare(
            `UPDATE learnings
               SET review_status = COALESCE(?, review_status),
                   confidence = COALESCE(?, confidence),
                   seen_again_count = COALESCE(?, seen_again_count),
                   content = ?,
                   embedding = NULL, embedding_model = NULL,
                   deleted_at = NULL, merged_into = NULL, superseded_by = NULL,
                   updated_at = datetime('now')
             WHERE id = ?`,
          ).run(
            row.prior_review_status,
            row.prior_confidence,
            row.prior_seen_again_count,
            row.prior_content,
            row.learning_id,
          );
          try {
            deleteEmbedding(db, row.learning_id);
          } catch {
            /* vec unavailable / row absent — the NULL BLOB alone triggers re-embed */
          }
        } else {
          db.prepare(
            `UPDATE learnings
               SET review_status = COALESCE(?, review_status),
                   confidence = COALESCE(?, confidence),
                   seen_again_count = COALESCE(?, seen_again_count),
                   deleted_at = NULL, merged_into = NULL, superseded_by = NULL,
                   updated_at = datetime('now')
             WHERE id = ?`,
          ).run(
            row.prior_review_status,
            row.prior_confidence,
            row.prior_seen_again_count,
            row.learning_id,
          );
        }

        // 2. Remove the edge the action created (hard delete — it was an inferred
        //    lineage/supersede edge, reversing the action removes it entirely).
        if (row.edge_type && row.related_learning_id) {
          db.prepare(
            `DELETE FROM entity_edges
              WHERE from_type = 'learning' AND from_id = ?
                AND to_type = 'learning'   AND to_id = ?
                AND edge_type = ?`,
          ).run(String(row.related_learning_id), String(row.learning_id), row.edge_type);
        }

        // 3. Stamp undone_at (idempotency marker).
        db.prepare(
          `UPDATE brain_maintenance_undo SET undone_at = datetime('now') WHERE id = ?`,
        ).run(row.id);
      }

      // Bump the run's `undone` audit counter (best-effort — column may be absent
      // on an older audit row; the ALTER is v3 so it should exist alongside).
      if (runId) {
        try {
          db.prepare(
            `UPDATE brain_maintenance_runs SET undone = COALESCE(undone, 0) + ? WHERE run_id = ?`,
          ).run(rows.length, runId);
        } catch {
          /* undone column / row absent — the reversal itself already succeeded */
        }
      }
    });
    runUndo();
  } catch (err) {
    return {
      ok: false,
      reversed: 0,
      message: `undo transaction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    reversed: rows.length,
    message: `Reversed ${rows.length} maintenance action(s)`,
    ...(runId ? { run_id: runId } : {}),
    ...(entryId ? { entry_id: entryId } : {}),
  };
}
