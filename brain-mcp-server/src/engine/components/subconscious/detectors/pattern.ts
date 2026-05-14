/**
 * Brain Engine v7.0 — Pattern Detector (FR-106 Phase 2)
 *
 * Two heuristic sub-detectors that surface "interesting deviations" from
 * a baseline. Patterns are observations, not actions, and always emit at
 * `medium` priority — high would imply urgency the detector cannot judge
 * (FR-106 plan, Concern 7).
 *
 * Sub-detectors:
 *   1. `dow` — Day-of-week brief activity skew per project. Reads
 *      `brief_status.updated_at`; we use updated_at as a creation proxy
 *      because that's the timestamp every row carries (the actual
 *      creation timestamp lives on `brief_files.created_at` and would
 *      require an outer join — accepted trade-off, see plan §"Pattern A
 *      timestamp source").
 *   2. `agent_retry` — Cross-project agent retry rate vs. the rolling
 *      cross-agent baseline over the last 30 days. One-sided gate (only
 *      emit when an agent retries MORE than baseline — surfacing
 *      reliability problems, not reliability wins).
 *
 * Pattern C (type velocity) is DEFERRED to Phase 3. The "uniform across
 * types" baseline doesn't hold (BRs are naturally fewer than FRs in
 * healthy projects), and a per-project rolling baseline doubles the test
 * surface. Captured in `docs/architecture/subconscious_engine.md`
 * Open Questions.
 *
 * Smoothing (FR-106 plan, Concern 6 + plan §"Pattern smoothing schema"):
 *   This detector emits CANDIDATES; the runner's `smoothPatterns` helper
 *   gates them on `pattern_observations` having at least
 *   `pattern_smoothing_runs` distinct `run_id` values for the same
 *   `pattern_key` within `pattern_smoothing_window_days`. The detector
 *   itself never reads or writes `pattern_observations` — it stays a
 *   pure `(ReadOnlyDb, DetectorConfig) => SuggestionCandidate[]`.
 *
 * Pure function: read-only, fail-soft on missing `brief_status` or
 * `agent_metrics`, never throws. Always caps emission at `medium`.
 *
 * @module engine/components/subconscious/detectors/pattern
 * @author fifty.dev
 */

import type {
  DetectorConfig,
  ReadOnlyDb,
  SuggestionCandidate,
} from '../types.js';

/** Day-of-week names indexed by the value SQLite's `strftime('%w', ...)` returns. */
const DAY_NAMES: Record<string, string> = {
  '0': 'Sunday',
  '1': 'Monday',
  '2': 'Tuesday',
  '3': 'Wednesday',
  '4': 'Thursday',
  '5': 'Friday',
  '6': 'Saturday',
};

/**
 * Run both sub-detectors and merge their output. The two halves are
 * independent — a missing `agent_metrics` table doesn't prevent the
 * day-of-week half from running, and vice versa.
 */
export function detectPattern(
  db: ReadOnlyDb,
  config: DetectorConfig,
): SuggestionCandidate[] {
  return [
    ...detectDowPattern(db, config),
    ...detectAgentRetryPattern(db, config),
  ];
}

// ---------------------------------------------------------------------------
// Sub-detector A — Day-of-week brief activity skew
// ---------------------------------------------------------------------------

interface DowRow {
  dow: string;
  n: number;
}

/**
 * Per-project day-of-week aggregation over the last 365 days. Emits one
 * suggestion per project iff the most-extreme day deviates from the
 * uniform baseline (N/7) by at least `pattern_min_effect`. The window of
 * 365d gives every weekday at least one full year of observations to
 * stabilise.
 */
function detectDowPattern(
  db: ReadOnlyDb,
  config: DetectorConfig,
): SuggestionCandidate[] {
  let projects: { project: string }[];
  try {
    projects = db
      .prepare(
        `SELECT DISTINCT project FROM brief_status
         WHERE project IS NOT NULL AND project != ''
         ORDER BY project ASC`,
      )
      .all() as { project: string }[];
  } catch {
    // brief_status table absent — fail-soft.
    return [];
  }

  const out: SuggestionCandidate[] = [];
  for (const { project } of projects) {
    const candidate = detectDowForProject(db, project, config);
    if (candidate) out.push(candidate);
  }
  return out;
}

function detectDowForProject(
  db: ReadOnlyDb,
  project: string,
  config: DetectorConfig,
): SuggestionCandidate | null {
  let rows: DowRow[];
  try {
    // Uses updated_at as a creation-day proxy (brief_status doesn't track
    // created_at separately). See docs/architecture/subconscious_engine.md
    // §13 Open Questions for the trade-off; switch to brief_files.created_at
    // via outer join only if drift is observed empirically.
    rows = db
      .prepare(
        `SELECT
           strftime('%w', updated_at) AS dow,
           COUNT(*) AS n
         FROM brief_status
         WHERE project = ?
           AND julianday('now') - julianday(updated_at) <= 365
         GROUP BY dow
         HAVING n > 0`,
      )
      .all(project) as DowRow[];
  } catch {
    return null;
  }

  // Total samples across all days. Gate on minimum-N before any further
  // analysis — patterns from <30 observations are noise even if they
  // look strong.
  let total = 0;
  for (const r of rows) total += r.n;
  if (total < config.pattern_min_samples) return null;

  // Per-day effect = (observed - baseline) / total. Baseline is total/7
  // (uniform over the seven weekdays). Find the day with the largest
  // |effect| and gate on `pattern_min_effect`.
  const baseline = total / 7;
  let maxAbsEffect = 0;
  let extremeDow = '';
  let extremeCount = 0;
  for (const r of rows) {
    const effect = (r.n - baseline) / total;
    if (Math.abs(effect) > maxAbsEffect) {
      maxAbsEffect = Math.abs(effect);
      extremeDow = r.dow;
      extremeCount = r.n;
    }
  }
  if (maxAbsEffect < config.pattern_min_effect) return null;

  const dayName = DAY_NAMES[extremeDow] ?? `day-${extremeDow}`;
  const pct = Math.round((extremeCount / total) * 100);
  const effectSigned = (extremeCount - baseline) / total;

  return {
    source_module: 'pattern',
    project_slug: project || null,
    title: `Pattern: brief activity skews toward ${dayName} in ${project} (${pct}% of last ${total})`,
    evidence: {
      pattern_key: `dow:${extremeDow}:${project}`,
      kind: 'dow',
      project_slug: project,
      day: extremeDow,
      day_name: dayName,
      observed: extremeCount,
      pct: round4(extremeCount / total),
      baseline_pct: round4(1 / 7),
      effect: round4(effectSigned),
      sample_size: total,
    },
    priority: 'medium',
  };
}

// ---------------------------------------------------------------------------
// Sub-detector B — Agent retry rate vs. cross-agent baseline
// ---------------------------------------------------------------------------

interface AgentRetryRow {
  agent: string;
  total: number;
  retries: number;
}

/**
 * Rolling 30-day per-agent retry rate vs. the cross-agent mean. Emits one
 * suggestion per agent that retries above-baseline by at least
 * `pattern_min_effect`. One-sided — agents that retry below-baseline are
 * not surfaced (a low-flake agent is a non-issue).
 */
function detectAgentRetryPattern(
  db: ReadOnlyDb,
  config: DetectorConfig,
): SuggestionCandidate[] {
  let rows: AgentRetryRow[];
  try {
    rows = db
      .prepare(
        `SELECT
           agent,
           COUNT(*) AS total,
           SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) AS retries
         FROM agent_metrics
         WHERE julianday('now') - julianday(recorded_at) <= 30
         GROUP BY agent
         HAVING total > 0`,
      )
      .all() as AgentRetryRow[];
  } catch {
    // agent_metrics table absent — fail-soft.
    return [];
  }
  if (rows.length === 0) return [];

  // Baseline is the cross-agent mean retry rate over the same window.
  // SUM(retries)/SUM(total) gives a sample-weighted baseline so an agent
  // with 1 run + 1 retry doesn't dominate.
  let totalRuns = 0;
  let totalRetries = 0;
  for (const r of rows) {
    totalRuns += r.total;
    totalRetries += r.retries;
  }
  if (totalRuns < config.pattern_min_samples) return [];
  const baseline = totalRetries / totalRuns;

  const out: SuggestionCandidate[] = [];
  for (const r of rows) {
    if (r.total < config.pattern_min_samples) continue;
    const rate = r.retries / r.total;
    const effect = rate - baseline;
    if (effect < config.pattern_min_effect) continue;

    const pct = Math.round(rate * 100);
    const baselinePct = Math.round(baseline * 100);
    out.push({
      source_module: 'pattern',
      project_slug: null,
      title: `Pattern: ${r.agent} retry rate ${pct}% over last ${r.total} runs (baseline ${baselinePct}%)`,
      evidence: {
        pattern_key: `agent_retry:${r.agent}`,
        kind: 'agent_retry',
        agent: r.agent,
        total: r.total,
        retries: r.retries,
        rate: round4(rate),
        baseline: round4(baseline),
        effect: round4(effect),
        sample_size: r.total,
      },
      priority: 'medium',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
