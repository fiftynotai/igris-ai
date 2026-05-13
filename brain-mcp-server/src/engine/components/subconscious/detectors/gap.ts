/**
 * Brain Engine v7.0 — Gap Detector
 *
 * Two-shaped detector:
 *   1. **Project quiet** — a registered project with no learning insert
 *      and no brief_status update for N days. Flags abandoned or
 *      neglected work surfaces.
 *   2. **Done with unchecked AC** — a brief in terminal state (Done /
 *      Archived) whose markdown body still contains an unchecked
 *      acceptance-criterion checkbox `- [ ]`. Caught with `LIKE '%- [ ]%'`
 *      against `brief_files.content` — cheap, no regex extension needed.
 *
 * Pure function: ReadOnlyDb + DetectorConfig in, SuggestionCandidate[]
 * out. Tolerates missing tables (returns [] for the missing slice).
 *
 * Priority assignment (FR-106 plan, Concern 7):
 *   project_quiet_days > gap_quiet_high_days   -> high
 *   project_quiet_days >= gap_quiet_medium_days -> medium
 *   Done with unchecked AC                      -> high (always — leaks
 *                                                 into release notes if missed)
 *
 * @module engine/components/subconscious/detectors/gap
 * @author Fifty.ai
 */

import type {
  DetectorConfig,
  ReadOnlyDb,
  SuggestionCandidate,
  SuggestionPriority,
} from '../types.js';

/** Row shape from the project-quiet query. */
interface ProjectQuietRow {
  slug: string;
  name: string;
  days_quiet: number;
}

/** Row shape from the unchecked-AC query. */
interface UncheckedAcRow {
  project: string;
  brief_id: string;
  title: string;
}

/**
 * Run both gap-detection sub-queries and merge results into a single
 * SuggestionCandidate[]. The two halves are independent — a missing
 * `brief_files` table doesn't prevent the project-quiet half from
 * running, and vice versa.
 */
export function detectGap(
  db: ReadOnlyDb,
  config: DetectorConfig,
): SuggestionCandidate[] {
  return [...detectQuietProjects(db, config), ...detectDoneWithUnchecked(db)];
}

// ---------------------------------------------------------------------------
// Project-quiet half
// ---------------------------------------------------------------------------

/**
 * Find active projects whose latest learning OR brief activity is older
 * than `gap_quiet_medium_days`. The CTE picks MAX(activity) per project
 * across both tables; archived/inactive projects are filtered out so we
 * don't nag the user about deliberately-frozen work.
 */
function detectQuietProjects(
  db: ReadOnlyDb,
  config: DetectorConfig,
): SuggestionCandidate[] {
  let rows: ProjectQuietRow[];
  try {
    rows = db
      .prepare(
        `WITH activity AS (
           SELECT
             p.slug,
             p.name,
             COALESCE(
               MAX(MAX(l.created_at), MAX(b.updated_at)),
               MAX(l.created_at),
               MAX(b.updated_at),
               p.registered_at
             ) AS last_activity_at
           FROM projects p
           LEFT JOIN learnings l ON l.project = p.slug
           LEFT JOIN brief_status b ON b.project = p.slug
           WHERE p.status = 'active'
           GROUP BY p.slug, p.name, p.registered_at
         )
         SELECT
           slug,
           name,
           CAST(julianday('now') - julianday(last_activity_at) AS INTEGER) AS days_quiet
         FROM activity
         WHERE julianday('now') - julianday(last_activity_at) >= ?
         ORDER BY days_quiet DESC`,
      )
      .all(config.gap_quiet_medium_days) as ProjectQuietRow[];
  } catch {
    return [];
  }

  const out: SuggestionCandidate[] = [];
  for (const row of rows) {
    const priority: SuggestionPriority =
      row.days_quiet > config.gap_quiet_high_days ? 'high' : 'medium';
    out.push({
      source_module: 'gap',
      project_slug: row.slug,
      title: `Project "${row.name}" has been quiet for ${row.days_quiet} days`,
      evidence: {
        project_slug: row.slug,
        days_quiet: row.days_quiet,
        gap_kind: 'project_quiet',
      },
      priority,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Done-with-unchecked-AC half
// ---------------------------------------------------------------------------

/**
 * Find briefs in terminal status whose body still has unchecked
 * acceptance-criterion boxes. Joined on `(project, brief_id)` to fetch
 * the brief title for the suggestion summary. Always emits at high
 * priority — a "Done" brief with unchecked ACs almost certainly went
 * out unfinished.
 */
function detectDoneWithUnchecked(db: ReadOnlyDb): SuggestionCandidate[] {
  let rows: UncheckedAcRow[];
  try {
    rows = db
      .prepare(
        `SELECT bs.project, bs.brief_id, bs.title
         FROM brief_status bs
         JOIN brief_files bf
           ON bf.project = bs.project AND bf.brief_id = bs.brief_id
         WHERE bs.status IN ('Done', 'Archived')
           AND bf.content LIKE '%- [ ]%'`,
      )
      .all() as UncheckedAcRow[];
  } catch {
    return [];
  }

  const out: SuggestionCandidate[] = [];
  for (const row of rows) {
    out.push({
      source_module: 'gap',
      project_slug: row.project || null,
      title: `${row.brief_id} marked Done but has unchecked acceptance criteria`,
      evidence: {
        brief_id: row.brief_id,
        project: row.project,
        gap_kind: 'done_with_unchecked',
      },
      priority: 'high',
    });
  }
  return out;
}
