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
 *   3. `surfaceReEvalRejections(db, cfg, since)` — Decision D / FR-116 M3
 *      Decision #10. Tallies `perception.rejected_pattern_recurring` events; ≥
 *      `cfg.reject_recur_n` surfaces ONE `re_evaluate_rejection` suggestion
 *      (`source_module='janitor'`) for operator reconsideration. Was DORMANT
 *      (reject was a hard DELETE); FR-116 M3 flips perception's reject path to
 *      SOFT-delete-on-recurrence + emit the source event, so this now activates.
 *
 *   4. `detectOutdatedLearnings(db, opts)` — FR-116 M3 (op #3-detect, §2 row 3 /
 *      Decision #5). The DETERMINISTIC half of outdated-pruning: find APPROVED
 *      learnings that are stale (`access_count <= max_access_count AND created_at
 *      < now - stale_months`) OR carry a deprecated-tech tag. Pure DB, no LLM —
 *      the keep/lower/prune JUDGMENT is the `curator` cognition instance's job
 *      (this is only its candidate source). `access_count` IS maintained (recall
 *      bumps it, memory.ts:670/:773), so the staleness signal is LIVE today.
 *
 * Every function is fail-soft: a query error returns 0 / `[]` (the deterministic
 * sweep never aborts a janitor run). None throws.
 *
 * @module engine/components/janitor/hygiene
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { DEFAULT_JANITOR_CONFIG, type JanitorConfig } from './types.js';
import type { StaleCandidate } from '../curator/types.js';
import { logUndoEntry } from './undo.js';

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
  undoRunId: string | null = null,
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

    // Read the prior confidence so a bump can be logged to the undo log
    // (FR-116 M3 Decision #2 — confidence changes are reversible).
    const priorStmt = db.prepare(
      `SELECT confidence FROM learnings
        WHERE id = ? AND COALESCE(review_status, 'approved') = 'approved'`,
    );
    const bump = db.prepare(
      `UPDATE learnings
         SET confidence = MIN(confidence + 0.05, 1.0), updated_at = datetime('now')
       WHERE id = ? AND COALESCE(review_status, 'approved') = 'approved'`,
    );
    for (const [id, count] of tally) {
      if (count < config.rediscovery_bump_n) continue;
      const prior = priorStmt.get(id) as { confidence: number } | undefined;
      const res = bump.run(id);
      if (res.changes > 0) {
        bumped += 1;
        // Fail-soft undo capture (never aborts the deterministic sweep).
        logUndoEntry(db, {
          run_id: undoRunId,
          action_kind: 'confidence_bump',
          learning_id: id,
          prior_review_status: 'approved',
          prior_confidence: prior?.confidence ?? null,
        });
      }
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
          created_at, expires_at, confidence, suggested_action, type_inferred,
          source_instance)
       VALUES ('janitor', NULL, ?, ?, 'low', 'pending', datetime('now'),
               datetime('now', ?), NULL, ?, 1, 'janitor')`,
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

// ---------------------------------------------------------------------------
// FR-116 M3 — outdated-knowledge staleness detector (op #3-detect, Decision #5)
// ---------------------------------------------------------------------------

/** Max chars of a learning's content carried into the candidate digest. */
const STALE_SNIPPET_MAX = 200;

/** Collapse whitespace + truncate a learning's content for the digest. */
function staleSnippet(content: string): string {
  const s = (content ?? '').trim().replace(/\s+/g, ' ');
  return s.length > STALE_SNIPPET_MAX ? `${s.slice(0, STALE_SNIPPET_MAX)}…` : s;
}

/** Options for `detectOutdatedLearnings` (mirrors the resolved curator knobs). */
export interface OutdatedDetectOptions {
  /** Age window in months — `created_at` older than `now - stale_months` is stale. */
  stale_months: number;
  /** Access threshold — `access_count <= max_access_count` is stale (0 = never recalled). */
  max_access_count: number;
  /** Deprecated-tech tags — a learning carrying ANY (case-insensitive) is a candidate regardless of age. */
  deprecated_tags: readonly string[];
  /** Hard cap on candidates returned. */
  max_candidates: number;
}

/**
 * The DETERMINISTIC staleness detector (FR-116 M3). Returns the APPROVED
 * learnings that look OUTDATED (Decision #5): either
 *
 *   - STALE: `access_count <= max_access_count AND created_at < now-stale_months`
 *     (never/barely recalled AND old); OR
 *   - DEPRECATED-TAG: the learning's `tags`/`tech_stack` free text contains any
 *     configured deprecated-tech tag (case-insensitive), regardless of age.
 *
 * Only `review_status='approved'` rows are scanned (pruned/merged/superseded/
 * pending/rejected are already excluded from recall). This is PURE candidate
 * generation — the keep/lower/prune decision is the `curator` LLM instance's. No
 * mutation happens here. Fail-soft: any query error → `[]` (never aborts a run).
 *
 * Ordered deterministically (oldest first, then id) and capped at
 * `opts.max_candidates`.
 */
export function detectOutdatedLearnings(
  db: Database.Database,
  opts: OutdatedDetectOptions,
): StaleCandidate[] {
  try {
    // Base staleness (age + access). `now - stale_months` via SQLite's
    // datetime modifier ('-N months'). access_count DEFAULTs 0.
    const rows = db
      .prepare(
        `SELECT id, title, content, created_at,
                COALESCE(access_count, 0) AS access_count,
                COALESCE(confidence, 0.5) AS confidence,
                COALESCE(tags, '')       AS tags,
                COALESCE(tech_stack, '') AS tech_stack,
                last_reviewed_at
           FROM learnings
          WHERE COALESCE(review_status, 'approved') = 'approved'
          ORDER BY created_at ASC, id ASC`,
      )
      .all() as Array<{
      id: number;
      title: string;
      content: string;
      created_at: string;
      access_count: number;
      confidence: number;
      tags: string;
      tech_stack: string;
      last_reviewed_at: string | null;
    }>;

    // The staleness cutoff, computed once by the DB so it matches SQLite's clock.
    const cutoffRow = db
      .prepare(`SELECT datetime('now', ?) AS cutoff`)
      .get(`-${opts.stale_months} months`) as { cutoff: string };
    const cutoff = cutoffRow.cutoff;

    const deprecated = opts.deprecated_tags
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);

    const out: StaleCandidate[] = [];
    for (const r of rows) {
      // A `keep` verdict stamps `last_reviewed_at`; a recently-reviewed row is not
      // re-flagged until the next stale window elapses (Decision #5 / curator keep).
      if (r.last_reviewed_at && r.last_reviewed_at >= cutoff) continue;

      const isOld = (r.created_at ?? '') < cutoff;
      const isUnused = r.access_count <= opts.max_access_count;
      const stale = isOld && isUnused;

      let deprecatedHit = false;
      if (deprecated.length > 0) {
        const hay = `${r.tags} ${r.tech_stack}`.toLowerCase();
        deprecatedHit = deprecated.some((t) => hay.includes(t));
      }

      if (!stale && !deprecatedHit) continue;
      const reason =
        stale && deprecatedHit
          ? 'stale+deprecated_tag'
          : deprecatedHit
            ? 'deprecated_tag'
            : 'stale';
      out.push({
        id: r.id,
        title: r.title,
        snippet: staleSnippet(r.content),
        created_at: r.created_at ?? '',
        access_count: r.access_count,
        confidence: r.confidence,
        reason,
      });
      if (out.length >= opts.max_candidates) break;
    }
    return out;
  } catch {
    return [];
  }
}
