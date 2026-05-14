/**
 * Brain Engine v7.0 — Stalled Brief Detector
 *
 * Surfaces briefs in the "In Progress" or "Ready" states that have not
 * been updated within configurable thresholds. Pure function: takes a
 * `ReadOnlyDb` and a `DetectorConfig`, returns `SuggestionCandidate[]`.
 * Never writes, never throws on missing tables — returns `[]` if the
 * `brief_status` table is absent.
 *
 * Priority assignment (FR-106 plan, Concern 7):
 *   In Progress > stalled_in_progress_high_days  -> high
 *   In Progress > stalled_in_progress_medium_days -> medium
 *   Ready > stalled_ready_high_days              -> high
 *   Ready > stalled_ready_medium_days            -> medium
 * Briefs below the medium thresholds are silently ignored ("low" is
 * never emitted by this detector — short stalls are noise).
 *
 * @module engine/components/subconscious/detectors/stalled
 * @author fifty.dev
 */

import type {
  DetectorConfig,
  ReadOnlyDb,
  SuggestionCandidate,
  SuggestionPriority,
} from '../types.js';

/** Row shape returned by the stalled-brief query. */
interface StalledBriefRow {
  project: string;
  brief_id: string;
  title: string;
  status: string;
  days_stalled: number;
}

/**
 * Scan `brief_status` for briefs that have been quiet too long.
 *
 * The single SQL query pulls In Progress AND Ready candidates with a
 * `julianday('now') - julianday(updated_at)` delta — converted to floor
 * integer days client-side so the priority bands are explicit. Briefs
 * already in terminal states (Done, Archived) are excluded by the WHERE.
 */
export function detectStalled(
  db: ReadOnlyDb,
  config: DetectorConfig,
): SuggestionCandidate[] {
  let rows: StalledBriefRow[];
  try {
    rows = db
      .prepare(
        `SELECT
           project,
           brief_id,
           title,
           status,
           CAST(julianday('now') - julianday(updated_at) AS INTEGER) AS days_stalled
         FROM brief_status
         WHERE status IN ('In Progress', 'Ready')
         ORDER BY days_stalled DESC`,
      )
      .all() as StalledBriefRow[];
  } catch {
    // brief_status table absent (e.g., fresh test fixture without it). The
    // detector is read-only, fail-soft, never noisy.
    return [];
  }

  const out: SuggestionCandidate[] = [];

  for (const row of rows) {
    const priority = priorityForStalled(row.status, row.days_stalled, config);
    if (priority === null) continue;

    out.push({
      source_module: 'stalled',
      project_slug: row.project || null,
      title: `${row.brief_id} stalled in ${row.status} for ${row.days_stalled} days`,
      evidence: {
        brief_id: row.brief_id,
        project: row.project,
        status: row.status,
        days_stalled: row.days_stalled,
      },
      priority,
    });
  }

  return out;
}

/**
 * Map (status, days_stalled) -> priority bucket, or null if the brief is
 * still inside the "fresh" window for its status. The thresholds come
 * from `DetectorConfig` so tests can dial them independently.
 */
function priorityForStalled(
  status: string,
  days: number,
  config: DetectorConfig,
): SuggestionPriority | null {
  if (status === 'In Progress') {
    if (days > config.stalled_in_progress_high_days) return 'high';
    if (days >= config.stalled_in_progress_medium_days) return 'medium';
    return null;
  }
  if (status === 'Ready') {
    if (days > config.stalled_ready_high_days) return 'high';
    if (days >= config.stalled_ready_medium_days) return 'medium';
    return null;
  }
  return null;
}
