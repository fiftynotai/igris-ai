/**
 * Brain Engine v7.1 — Curator staleness candidate generation (FR-116 M3).
 *
 * The curator's INPUT slot (`buildContext`) source. Unlike the janitor/arbiter
 * (which run a vec0 KNN pre-filter), the curator's candidate signal is PURELY
 * DETERMINISTIC (Decision #5): the outdated-knowledge staleness detector
 * (`janitor/hygiene.ts:detectOutdatedLearnings`). This module wraps that detector
 * and layers the SAME don't-double-queue exclusion the janitor/arbiter use — a
 * learning already pending as a `curator` `prune_learning` suggestion is dropped
 * so re-runs do not re-surface it.
 *
 * The detection query lives in `hygiene.ts` (it is a deterministic hygiene duty,
 * co-located with `rejectStalePending` / `applyConfidenceBumps`); the curator's
 * `buildContext` reads it via `buildStaleCandidates` here.
 *
 * Every read is fail-soft: a query error yields `[]`. Never throws.
 *
 * @module engine/components/curator/candidates
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { detectOutdatedLearnings } from '../janitor/hygiene.js';
import { DEFAULT_CURATOR_CONFIG, type CuratorConfig, type StaleCandidate } from './types.js';

/**
 * The set of learning ids already pending as a `curator` `prune_learning`
 * suggestion. Parsed from each pending suggestion's `suggested_action`
 * (`learning_id`). Fail-soft: absent table / malformed action → skipped. Excluded
 * so the curator does not double-queue the same proposed prune across runs.
 */
export function loadPendingPruneIds(db: Database.Database): Set<number> {
  const set = new Set<number>();
  try {
    const rows = db
      .prepare(
        `SELECT suggested_action FROM suggestions
          WHERE status = 'pending' AND source_module = 'curator'`,
      )
      .all() as Array<{ suggested_action: string | null }>;
    for (const r of rows) {
      if (!r.suggested_action) continue;
      try {
        const action = JSON.parse(r.suggested_action) as { learning_id?: unknown };
        const id = Number(action?.learning_id);
        if (Number.isInteger(id) && id > 0) set.add(id);
      } catch {
        /* malformed action — skip */
      }
    }
  } catch {
    /* suggestions absent — empty exclusion set */
  }
  return set;
}

/**
 * Build the capped, deduped staleness candidate set for one curator run: the
 * deterministic detector's output MINUS any learning already pending a curator
 * prune suggestion. Never throws — every read is fail-soft.
 *
 * @param db     the brain DB
 * @param config the resolved curator config (window / access threshold / tags / cap)
 */
export function buildStaleCandidates(
  db: Database.Database,
  config: CuratorConfig = DEFAULT_CURATOR_CONFIG,
): StaleCandidate[] {
  const pending = loadPendingPruneIds(db);
  const candidates = detectOutdatedLearnings(db, {
    stale_months: config.stale_months,
    max_access_count: config.max_access_count,
    deprecated_tags: config.deprecated_tags,
    max_candidates: config.max_candidates,
  });
  return candidates.filter((c) => !pending.has(c.id));
}
