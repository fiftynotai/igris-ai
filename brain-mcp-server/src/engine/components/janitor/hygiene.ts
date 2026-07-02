/**
 * Brain Engine v7.1 — Janitor deterministic hygiene duties (FR-119).
 *
 * The three memory-hygiene duties that need NO LLM (Decision E). The janitor
 * RUNNER calls these around `runExtractor`; they are pure DB functions:
 *
 *   1. `applyConfidenceBumps(db, cfg, since)` — TD-086 coordination. Tallies
 *      `perception.rediscovery` events per rediscovered learning; a learning
 *      re-discovered ≥ `cfg.rediscovery_bump_n` times gets `confidence += 0.05`,
 *      CLAMPED to the CHECK 0–1 bound via `MIN(confidence + 0.05, 1.0)` (db.ts:164
 *      — a bump past 1.0 must clamp, not violate the constraint). Only APPROVED
 *      learnings are bumped. `since` (the previous run's finish time) windows the
 *      tally so a re-run does NOT double-bump (idempotency).
 *
 *   2. `rejectStalePending(db, cfg)` — flip `review_status='pending_review'`
 *      learnings older than `cfg.stale_days` to `'rejected'` (soft — no CHECK on
 *      review_status, so the new value is legal without a table rebuild; the
 *      rejected row drops out of every approved-filter reader).
 *
 *   3. `surfaceReEvalRejections(db, cfg, since)` — DORMANT (Decision D). Tallies
 *      `perception.rejected_pattern_recurring` events; ≥ `cfg.reject_recur_n`
 *      surfaces ONE `re_evaluate_rejection` suggestion (`source_module='janitor'`)
 *      for operator reconsideration. The source event never fires in production
 *      today (reject is a hard DELETE), so this returns 0 — but the path is wired
 *      and activates automatically when FR-116 flips the emit.
 *
 * Every function is fail-soft: a query error returns 0 (the deterministic sweep
 * never aborts a janitor run). None throws.
 *
 * @module engine/components/janitor/hygiene
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { DEFAULT_JANITOR_CONFIG, type JanitorConfig } from './types.js';

/** Pending-suggestion TTL (days) — mirrors the extractor persist default. */
const PENDING_TTL_DAYS = 30;

/**
 * TD-086 confidence bump. Tally `perception.rediscovery` events (written to
 * `event_log` under `component='perception'`, payload carries
 * `existing_learning_id`) per rediscovered learning; bump `confidence` +0.05
 * (clamped to 1.0) for each APPROVED learning re-discovered ≥ N times since
 * `since`. Returns the number of learnings bumped. Fail-soft → 0.
 *
 * @param since ISO timestamp — count only rediscovery events AFTER this (the
 *              previous run's finish). `null` = all-time (first run). This is
 *              what makes a re-run idempotent (no double-bump).
 */
export function applyConfidenceBumps(
  db: Database.Database,
  config: JanitorConfig = DEFAULT_JANITOR_CONFIG,
  since: string | null = null,
): number {
  let bumped = 0;
  try {
    const sql = since
      ? `SELECT payload FROM event_log
          WHERE component = 'perception' AND event_name = 'perception.rediscovery'
            AND created_at > ?`
      : `SELECT payload FROM event_log
          WHERE component = 'perception' AND event_name = 'perception.rediscovery'`;
    const rows = (since
      ? db.prepare(sql).all(since)
      : db.prepare(sql).all()) as Array<{ payload: string | null }>;

    const tally = new Map<number, number>();
    for (const r of rows) {
      if (!r.payload) continue;
      try {
        const p = JSON.parse(r.payload) as { existing_learning_id?: unknown; deduped_ids?: unknown };
        // Primary: the per-row perception.rediscovery payload carries a single
        // existing_learning_id (perception.ts:223). Defensive: some roll-up
        // emits carry a deduped_ids array — tally each.
        const single = Number(p.existing_learning_id);
        if (Number.isInteger(single) && single > 0) {
          tally.set(single, (tally.get(single) ?? 0) + 1);
        } else if (Array.isArray(p.deduped_ids)) {
          for (const raw of p.deduped_ids) {
            const id = Number(raw);
            if (Number.isInteger(id) && id > 0) tally.set(id, (tally.get(id) ?? 0) + 1);
          }
        }
      } catch {
        /* malformed payload — skip */
      }
    }

    const bump = db.prepare(
      `UPDATE learnings
         SET confidence = MIN(confidence + 0.05, 1.0), updated_at = datetime('now')
       WHERE id = ? AND COALESCE(review_status, 'approved') = 'approved'`,
    );
    for (const [id, count] of tally) {
      if (count < config.rediscovery_bump_n) continue;
      const res = bump.run(id);
      if (res.changes > 0) bumped += 1;
    }
  } catch {
    return bumped;
  }
  return bumped;
}

/**
 * Stale-pending cleanup. Flip `pending_review` learnings older than
 * `cfg.stale_days` to `'rejected'`. Returns the number of rows flipped.
 * Fail-soft → 0.
 */
export function rejectStalePending(
  db: Database.Database,
  config: JanitorConfig = DEFAULT_JANITOR_CONFIG,
): number {
  try {
    const res = db
      .prepare(
        `UPDATE learnings
           SET review_status = 'rejected', updated_at = datetime('now')
         WHERE review_status = 'pending_review'
           AND created_at < datetime('now', ?)`,
      )
      .run(`-${config.stale_days} days`);
    return res.changes;
  } catch {
    return 0;
  }
}

/**
 * DORMANT re-eval-of-rejection surfacing (Decision D). Tally
 * `perception.rejected_pattern_recurring` events since `since`; if the total
 * meets `cfg.reject_recur_n`, INSERT ONE `re_evaluate_rejection` suggestion
 * (`source_module='janitor'`) — unless one is already pending. Returns the
 * number of suggestions surfaced (0 in production — the source event is dead).
 * Fail-soft → 0.
 */
export function surfaceReEvalRejections(
  db: Database.Database,
  config: JanitorConfig = DEFAULT_JANITOR_CONFIG,
  since: string | null = null,
): number {
  try {
    const sql = since
      ? `SELECT COUNT(*) AS n FROM event_log
          WHERE component = 'perception'
            AND event_name = 'perception.rejected_pattern_recurring'
            AND created_at > ?`
      : `SELECT COUNT(*) AS n FROM event_log
          WHERE component = 'perception'
            AND event_name = 'perception.rejected_pattern_recurring'`;
    const row = (since
      ? db.prepare(sql).get(since)
      : db.prepare(sql).get()) as { n: number } | undefined;
    const count = row?.n ?? 0;
    if (count < config.reject_recur_n) return 0;

    // Do not double-queue: skip if a janitor re_evaluate_rejection is already pending.
    const existing = db
      .prepare(
        `SELECT id FROM suggestions
          WHERE status = 'pending' AND source_module = 'janitor'
            AND suggested_action LIKE '%"kind":"re_evaluate_rejection"%'
          LIMIT 1`,
      )
      .get() as { id: number } | undefined;
    if (existing) return 0;

    const suggestedAction = { kind: 're_evaluate_rejection', concern: 'rejected patterns recurred' };
    db.prepare(
      `INSERT INTO suggestions
         (source_module, project_slug, title, evidence, priority, status,
          created_at, expires_at, confidence, suggested_action, type_inferred)
       VALUES ('janitor', NULL, ?, ?, 'low', 'pending', datetime('now'),
               datetime('now', ?), NULL, ?, 1)`,
    ).run(
      `Re-evaluate ${count} recurring rejected pattern(s)`,
      JSON.stringify({ recurrence_count: count }),
      `+${PENDING_TTL_DAYS} days`,
      JSON.stringify(suggestedAction),
    );
    return 1;
  } catch {
    return 0;
  }
}
