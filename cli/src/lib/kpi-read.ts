/**
 * FR-268 — the seven OS KPIs, computed on read. PURE: takes a `db` handle,
 * imports nothing from `brain-db` / `db`, issues SELECTs only (the static scan
 * in `kpi-read.test.ts` mechanises that claim). `brain-db.ts#readKpiDigest` is
 * the wrapper that opens the READ-ONLY door (`openBrainReadonly`,
 * `query_only = ON`) and hands the handle in.
 *
 * Why SQL constants and not a stored rollup: the rows ARE the record (durable,
 * append-only, synced); a rollup table would be a second copy that can drift
 * from them. Every derivation below is printable (`igris kpi --sql`) so
 * `sqlite3` reproduces it on any harness — the R2 requirement.
 *
 * Conventions (stated once here, rendered by the verb, documented in
 * `docs/reference/os-kpis.md`):
 *   - Weeks are Monday–Sunday in UTC. `WEEK(x)` is the portable expression
 *     `date(x, '-' || ((strftime('%w', x) + 6) % 7) || ' days')` — no `%G/%V`
 *     (those need SQLite >= 3.46). Window functions need >= 3.25.
 *   - Done date = `brief_status.updated_at` of a Done row (the table has no
 *     completed-at column); status is matched with the TD-340 notation fold.
 *   - Active day = a UTC date with >= 1 `agent_events` or `ceremony_events` row
 *     for the project.
 *     A week that starts BEFORE the record's first activity day (the
 *     `record_floor` CTE / `activity_floor`) reads NULL per active day: its
 *     denominator is not covered (L-1401 — a baseline drawn from a table that
 *     started mid-week produced a false finding).
 *   - Percentiles are nearest-rank: the value at sorted row `max(1, ceil(n·p))`,
 *     written in integer arithmetic as `(num·n + (den−1)) / den`.
 *   - A hunt is attributed to the week of its LAST stop/error row; capacity
 *     (KPI 1) is attributed per row. KPIs 1/4/5/6 read only rows with a
 *     non-NULL `duration_ms` (brain-timed since FR-267, 2026-08-26); earlier
 *     weeks are therefore empty for them — named, not faked.
 *   - The current partial week is included and marked; the alarm never reads it.
 */

import type Database from "better-sqlite3";
import type {
  KpiAlarm,
  KpiAlarmMetric,
  KpiCapacityRow,
  KpiCeremonyCostRow,
  KpiCeremonyCoverageRow,
  KpiDigest,
  KpiEffortMixRow,
  KpiHuntMinutesRow,
  KpiHuntRoundsRow,
  KpiModelPerRoleRow,
  KpiThroughputRow,
  KpiWeek,
} from "../types.js";

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Monday (UTC) of the week containing `expr`. */
export function weekStartSql(expr: string): string {
  return `date(${expr}, '-' || ((strftime('%w', ${expr}) + 6) % 7) || ' days')`;
}

/**
 * Nearest-rank row number for percentile `num/den` over `n` sorted rows:
 * `ceil(n·p)` floored at 1, as integer arithmetic (`n` is a COUNT, so the
 * division truncates and `+ (den − 1)` is the ceiling).
 */
export function nearestRankSql(num: number, den: number): string {
  return `(${num} * n + ${den - 1}) / ${den}`;
}

export const MEDIAN_RANK_SQL = nearestRankSql(1, 2);
export const P75_RANK_SQL = nearestRankSql(3, 4);

/** TD-340 notation fold: `Done`, `done`, `DONE`, `Done ` … all read as done. */
export const DONE_FOLD_SQL =
  "replace(replace(replace(lower(status), ' ', ''), '-', ''), '_', '') = 'done'";

/**
 * The leading size token of `brief_status.effort` (`S-Small (< 4h)` → `S`).
 * Measured 2026-08-27 08:34 UTC over 2,078 rows (1,888 non-NULL, 59 distinct
 * spellings, 190 NULL): 56 spellings start with their token; NULL → `(none)`;
 * the other 3 (`TBD`, `n/a`, `Tracking`) → `(other)`.
 */
export const EFFORT_FOLD_SQL =
  "CASE WHEN effort IS NULL THEN '(none)'" +
  " WHEN effort LIKE 'XS%' THEN 'XS' WHEN effort LIKE 'XL%' THEN 'XL'" +
  " WHEN effort LIKE 'S%' THEN 'S' WHEN effort LIKE 'M%' THEN 'M' WHEN effort LIKE 'L%' THEN 'L'" +
  " ELSE '(other)' END";

const PROJECT_FILTER = "(:project IS NULL OR project = :project)";

const HUNT_ROLES = ["architect", "forger", "sentinel", "warden", "mender", "document"] as const;

// ---------------------------------------------------------------------------
// The seven derivations (+ the coverage sub-query). Bind :since and :project.
// ---------------------------------------------------------------------------

export const KPI_QUERIES = {
  /** 1. Capacity by project per week — brain-bracket agent minutes. */
  capacity: `
SELECT project, ${weekStartSql("ended_at")} AS week_start,
       CAST(ROUND(SUM(duration_ms) / 60000.0) AS INTEGER) AS agent_minutes,
       COUNT(*) AS invocations, COUNT(DISTINCT brief_id) AS briefs
  FROM hunt_runs
 WHERE duration_ms IS NOT NULL AND ended_at >= :since AND ${PROJECT_FILTER}
 GROUP BY 1, 2 ORDER BY 2, 1`,

  /** 2. Throughput — Done per week and per active day. */
  throughput: `
WITH done AS (
  SELECT project, ${weekStartSql("updated_at")} AS week_start, COUNT(*) AS done
    FROM brief_status
   WHERE ${DONE_FOLD_SQL} AND updated_at >= :since AND ${PROJECT_FILTER}
   GROUP BY 1, 2),
activity AS (
  SELECT project, date(created_at) AS day FROM agent_events
   WHERE project IS NOT NULL AND created_at >= :since AND ${PROJECT_FILTER}
  UNION
  SELECT project, date(created_at) AS day FROM ceremony_events
   WHERE created_at >= :since AND ${PROJECT_FILTER}),
active_days AS (
  SELECT project, ${weekStartSql("day")} AS week_start, COUNT(*) AS active_days
    FROM activity GROUP BY 1, 2),
record_floor AS (
  SELECT MIN(day) AS day FROM (
    SELECT MIN(date(created_at)) AS day FROM agent_events WHERE project IS NOT NULL
    UNION ALL
    SELECT MIN(date(created_at)) AS day FROM ceremony_events)),
wk_keys AS (
  SELECT project, week_start FROM done UNION SELECT project, week_start FROM active_days)
SELECT k.project, k.week_start,
       COALESCE(d.done, 0) AS done,
       COALESCE(a.active_days, 0) AS active_days,
       CASE WHEN k.week_start < (SELECT day FROM record_floor) THEN NULL
            WHEN COALESCE(a.active_days, 0) = 0 THEN NULL
            ELSE ROUND(COALESCE(d.done, 0) * 1.0 / a.active_days, 2) END AS done_per_active_day
  FROM wk_keys k
  LEFT JOIN done d ON d.project = k.project AND d.week_start = k.week_start
  LEFT JOIN active_days a ON a.project = k.project AND a.week_start = k.week_start
 ORDER BY 2, 1`,

  /** 3. Effort mix of Done briefs per week. */
  effort_mix: `
WITH done AS (
  SELECT project, ${weekStartSql("updated_at")} AS week_start, ${EFFORT_FOLD_SQL} AS effort
    FROM brief_status
   WHERE ${DONE_FOLD_SQL} AND updated_at >= :since AND ${PROJECT_FILTER}),
mix AS (
  SELECT project, week_start, effort, COUNT(*) AS done FROM done GROUP BY 1, 2, 3)
SELECT project, week_start, effort, done,
       ROUND(SUM(CASE WHEN effort IN ('XS', 'S') THEN done ELSE 0 END) OVER (PARTITION BY project, week_start) * 1.0
             / SUM(done) OVER (PARTITION BY project, week_start), 2) AS xs_s_share
  FROM mix ORDER BY 2, 1, 3`,

  /** 4. Minutes per hunt by phase — median / p75 per week, phase shares. */
  hunt_minutes: `
WITH hunts AS (
  SELECT project, brief_id,
         SUM(duration_ms) / 60000.0 AS total_min,
${HUNT_ROLES.map((r) => `         SUM(CASE WHEN agent = '${r}' THEN duration_ms ELSE 0 END) / 60000.0 AS ${r}_min,`).join("\n")}
         MAX(ended_at) AS last_end
    FROM hunt_runs
   WHERE duration_ms IS NOT NULL AND brief_id IS NOT NULL AND ended_at >= :since AND ${PROJECT_FILTER}
   GROUP BY 1, 2),
ranked AS (
  SELECT h.*, ${weekStartSql("last_end")} AS week_start,
         ROW_NUMBER() OVER (PARTITION BY project, ${weekStartSql("last_end")} ORDER BY total_min) AS rn,
         COUNT(*) OVER (PARTITION BY project, ${weekStartSql("last_end")}) AS n
    FROM hunts h)
SELECT project, week_start, n AS hunts,
       ROUND(MAX(CASE WHEN rn = ${MEDIAN_RANK_SQL} THEN total_min END), 1) AS median_min,
       ROUND(MAX(CASE WHEN rn = ${P75_RANK_SQL} THEN total_min END), 1) AS p75_min,
${HUNT_ROLES.map((r) => `       ROUND(SUM(${r}_min) / SUM(total_min), 2) AS ${r}_share`).join(",\n")}
  FROM ranked GROUP BY 1, 2, 3 ORDER BY 2, 1`,

  /** 5. Rounds per hunt — resumed/retry rounds per week. */
  hunt_rounds: `
WITH per_agent AS (
  SELECT project, brief_id, agent, MAX(round) AS max_round, MAX(ended_at) AS last_end
    FROM hunt_runs
   WHERE duration_ms IS NOT NULL AND brief_id IS NOT NULL AND ended_at >= :since AND ${PROJECT_FILTER}
   GROUP BY 1, 2, 3),
hunts AS (
  SELECT project, brief_id, SUM(max_round - 1) AS extra_rounds, MAX(last_end) AS last_end
    FROM per_agent GROUP BY 1, 2)
SELECT project, ${weekStartSql("last_end")} AS week_start, COUNT(*) AS hunts,
       SUM(CASE WHEN extra_rounds > 0 THEN 1 ELSE 0 END) AS hunts_resumed,
       ROUND(SUM(CASE WHEN extra_rounds > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 2) AS resumed_share,
       ROUND(AVG(extra_rounds), 2) AS avg_extra_rounds
  FROM hunts GROUP BY 1, 2 ORDER BY 2, 1`,

  /** 6. Model per role — per-invocation minutes and tool calls, over the window. */
  model_per_role: `
WITH inv AS (
  SELECT h.agent, h.model_requested, h.minutes,
         CASE WHEN json_valid(e.metadata) THEN json_extract(e.metadata, '$.tool_calls') END AS tool_calls
    FROM hunt_runs h LEFT JOIN agent_events e ON e.id = h.event_id
   WHERE h.duration_ms IS NOT NULL AND h.ended_at >= :since AND (:project IS NULL OR h.project = :project)),
ranked AS (
  SELECT agent, model_requested, minutes, tool_calls,
         ROW_NUMBER() OVER (PARTITION BY agent, model_requested ORDER BY minutes) AS rn,
         COUNT(*) OVER (PARTITION BY agent, model_requested) AS n,
         ROW_NUMBER() OVER (PARTITION BY agent, model_requested ORDER BY (tool_calls IS NULL), tool_calls) AS trn,
         COUNT(tool_calls) OVER (PARTITION BY agent, model_requested) AS tn
    FROM inv)
SELECT agent, model_requested, n,
       ROUND(MAX(CASE WHEN rn = ${MEDIAN_RANK_SQL} THEN minutes END), 1) AS median_min,
       ROUND(MAX(CASE WHEN rn = ${P75_RANK_SQL} THEN minutes END), 1) AS p75_min,
       MAX(CASE WHEN tn > 0 AND trn = (1 * tn + 1) / 2 THEN tool_calls END) AS tool_calls_median,
       tn AS tool_calls_n
  FROM ranked GROUP BY agent, model_requested, n, tn ORDER BY 1, 2`,

  /** 7. Ceremony cost — runs, median / p75 minutes per ceremony per week. */
  ceremony_cost: `
WITH runs AS (
  SELECT project, ceremony, ${weekStartSql("ended_at")} AS week_start, minutes
    FROM ceremony_runs
   WHERE duration_ms IS NOT NULL AND ended_at >= :since AND ${PROJECT_FILTER}),
ranked AS (
  SELECT project, ceremony, week_start, minutes,
         ROW_NUMBER() OVER (PARTITION BY project, ceremony, week_start ORDER BY minutes) AS rn,
         COUNT(*) OVER (PARTITION BY project, ceremony, week_start) AS n
    FROM runs)
SELECT project, ceremony, week_start, n AS runs,
       ROUND(MAX(CASE WHEN rn = ${MEDIAN_RANK_SQL} THEN minutes END), 1) AS median_min,
       ROUND(MAX(CASE WHEN rn = ${P75_RANK_SQL} THEN minutes END), 1) AS p75_min
  FROM ranked GROUP BY 1, 2, 3, n ORDER BY 3, 1, 2`,

  /** 7b. Ceremony coverage — starts, stops, unpaired per ceremony per week (the runtime observer). */
  ceremony_coverage: `
SELECT project, ceremony, ${weekStartSql("created_at")} AS week_start,
       SUM(event_type = 'start') AS starts,
       SUM(event_type = 'stop') AS stops,
       SUM(event_type = 'start') - SUM(event_type = 'stop') AS unpaired,
       SUM(event_type = 'stop' AND duration_ms IS NULL) AS unpaired_stops
  FROM ceremony_events
 WHERE created_at >= :since AND ${PROJECT_FILTER}
 GROUP BY 1, 2, 3 ORDER BY 3, 1, 2`,
} as const;

export type KpiQueryName = keyof typeof KPI_QUERIES;

/** The `--sql` listing: every query verbatim, with its bindings and the floor. */
export function kpiSqlListing(): string {
  const head = [
    "-- igris kpi --sql (FR-268): the seven OS KPI derivations plus the KPI 7 coverage sub-query (8 statements), verbatim.",
    "-- Bind :since (Monday of the oldest week, UTC, 'YYYY-MM-DD') and :project (a slug, or NULL for every project):",
    "--   sqlite3 -readonly ~/.igris/memory/knowledge.db",
    "--   .parameter set :since '2026-08-17'",
    "--   .parameter set :project NULL",
    "-- Weeks are Monday–Sunday UTC: WEEK(x) = " + weekStartSql("x"),
    "-- Percentiles are nearest-rank (ceil(n·p), floored at 1): median rank " + MEDIAN_RANK_SQL + ", p75 rank " + P75_RANK_SQL + ".",
    "-- Requires SQLite >= 3.25 (window functions); better-sqlite3 bundles a newer one, macOS ships 3.43+.",
    "-- KPIs 1/4/5/6 read hunt_runs (instances migration v3); KPI 7 reads ceremony_runs / ceremony_events (v4).",
    "",
  ];
  const body = (Object.keys(KPI_QUERIES) as KpiQueryName[]).map(
    (name) => `-- ${name}\n${KPI_QUERIES[name].trim()};\n`,
  );
  return head.concat(body).join("\n");
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

export interface KpiReadOptions {
  /** Slug filter; null = every project. */
  project: string | null;
  /** How many UTC weeks back, counting the current partial one. */
  weeks: number;
  /** Compute the week-over-week alarm for `project` (requires a project). */
  alarm: boolean;
  /**
   * TESTS ONLY — pins "now" (`'YYYY-MM-DD HH:MM:SS'`, UTC) so week boundaries
   * are deterministic. The verb never sets it: the DB clock is the reading.
   */
  nowOverride?: string;
}

function objectExists(db: Database.Database, type: "table" | "view", name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
    .get(type, name) as { name: string } | undefined;
  return row !== undefined;
}

function scalar<T>(db: Database.Database, sql: string, params: unknown[] = []): T {
  const row = db.prepare(sql).get(...params) as Record<string, T>;
  return Object.values(row)[0];
}

function addDays(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function bindings(since: string, project: string | null): { since: string; project: string | null } {
  return { since, project };
}

function emptyDigest(): KpiDigest {
  return {
    degraded: false,
    tz: "UTC",
    generated_at: null,
    since: null,
    project: null,
    activity_floor: null,
    weeks: [],
    capacity: [],
    throughput: [],
    effort_mix: [],
    hunt_minutes: [],
    hunt_rounds: [],
    model_per_role: [],
    ceremony_cost: [],
    ceremony_coverage: [],
    alarm: null,
    skipped: [],
    notes: [],
  };
}

/** The digest for a brain that cannot be read at all (no file). */
export function absentKpiDigest(opts: KpiReadOptions): KpiDigest {
  const d = emptyDigest();
  d.degraded = true;
  d.project = opts.project;
  d.skipped.push("brain db absent — nothing to read");
  return d;
}

const STANDING_NOTES: readonly string[] = [
  "weeks are Monday–Sunday UTC; the operator's local clock is never used",
  "capacity is brain-bracket minutes (overshoots agent-active time by 1–6 min per invocation — FR-267 §7)",
  "Done date = brief_status.updated_at of a Done row (no completed-at column); a post-Done edit moves the brief's week",
  "a week that starts before the record's first activity day (activity_floor) reads NULL per active day — its denominator is not covered",
  "KPIs 1/4/5/6 read rows with a non-NULL duration_ms only (brain-timed since 2026-08-26); earlier weeks are empty for them, not zero",
  "the local series is per-machine: BOOT_SYNC_PULL_TABLES pulls neither event table; the VPS holds the union",
];

/**
 * Build the KPI digest over `db` (a read-only handle). Never writes.
 */
export function buildKpiDigest(db: Database.Database, opts: KpiReadOptions): KpiDigest {
  const d = emptyDigest();
  d.project = opts.project;
  d.notes.push(...STANDING_NOTES);

  const nowExpr = opts.nowOverride ? "?" : "datetime('now')";
  const nowParams = opts.nowOverride ? [opts.nowOverride] : [];
  d.generated_at = scalar<string>(db, `SELECT ${nowExpr} AS t`, nowParams);
  const currentMonday = scalar<string>(db, `SELECT ${weekStartSql(nowExpr)} AS wk`, nowParams.concat(nowParams));

  const weeks = Number.isFinite(opts.weeks) && opts.weeks >= 1 ? Math.floor(opts.weeks) : 4;
  const since = addDays(currentMonday, -7 * (weeks - 1));
  d.since = since;
  for (let i = 0; i < weeks; i++) {
    const ws = addDays(since, 7 * i);
    const w: KpiWeek = { week_start: ws, week_end: addDays(ws, 6), partial: ws === currentMonday };
    d.weeks.push(w);
  }

  const hasBriefStatus = objectExists(db, "table", "brief_status");
  const hasHuntRuns = objectExists(db, "view", "hunt_runs");
  const hasCeremony = objectExists(db, "table", "ceremony_events") && objectExists(db, "view", "ceremony_runs");
  if (!hasBriefStatus) d.skipped.push("brief_status absent — KPIs 2 and 3 not computed");
  if (!hasHuntRuns) d.skipped.push("hunt_runs absent — brain older than FR-267 (instances v3); KPIs 1, 4, 5, 6 not computed");
  if (!hasCeremony) d.skipped.push("ceremony_events absent — brain older than FR-268 (instances v4); KPI 7 not computed");
  d.degraded = d.skipped.length > 0;

  d.activity_floor = activityFloor(db, hasHuntRuns, hasCeremony);

  const b = bindings(since, opts.project);
  if (hasHuntRuns) {
    d.capacity = db.prepare(KPI_QUERIES.capacity).all(b) as KpiCapacityRow[];
    d.hunt_minutes = db.prepare(KPI_QUERIES.hunt_minutes).all(b) as KpiHuntMinutesRow[];
    d.hunt_rounds = db.prepare(KPI_QUERIES.hunt_rounds).all(b) as KpiHuntRoundsRow[];
    d.model_per_role = db.prepare(KPI_QUERIES.model_per_role).all(b) as KpiModelPerRoleRow[];
  }
  if (hasBriefStatus) {
    d.throughput = db.prepare(throughputSql(hasHuntRuns, hasCeremony)).all(b) as KpiThroughputRow[];
    d.effort_mix = db.prepare(KPI_QUERIES.effort_mix).all(b) as KpiEffortMixRow[];
  }
  if (hasCeremony) {
    d.ceremony_cost = db.prepare(KPI_QUERIES.ceremony_cost).all(b) as KpiCeremonyCostRow[];
    d.ceremony_coverage = db.prepare(KPI_QUERIES.ceremony_coverage).all(b) as KpiCeremonyCoverageRow[];
  }

  if (opts.alarm) {
    if (!opts.project) {
      d.skipped.push("alarm needs --project");
      d.degraded = true;
    } else {
      d.alarm = buildAlarm(db, opts.project, currentMonday, { hasBriefStatus, hasHuntRuns, hasCeremony });
    }
  }
  return d;
}

/**
 * The throughput query, with the `activity` sources narrowed to the tables the
 * brain actually has: KPI 2 still computes on an older brain, with fewer
 * active-day sources (named in `skipped`).
 */
export function throughputSql(hasHuntRuns: boolean, hasCeremony: boolean): string {
  const sources: string[] = [];
  const floors: string[] = [];
  if (hasHuntRuns) {
    sources.push(
      `  SELECT project, date(created_at) AS day FROM agent_events\n   WHERE project IS NOT NULL AND created_at >= :since AND ${PROJECT_FILTER}`,
    );
    floors.push("    SELECT MIN(date(created_at)) AS day FROM agent_events WHERE project IS NOT NULL");
  }
  if (hasCeremony) {
    sources.push(
      `  SELECT project, date(created_at) AS day FROM ceremony_events\n   WHERE created_at >= :since AND ${PROJECT_FILTER}`,
    );
    floors.push("    SELECT MIN(date(created_at)) AS day FROM ceremony_events");
  }
  if (sources.length === 0) {
    sources.push("  SELECT NULL AS project, NULL AS day WHERE 0");
    floors.push("    SELECT NULL AS day WHERE 0");
  }
  const activity = `activity AS (\n${sources.join("\n  UNION\n")}),`;
  const floor = `record_floor AS (\n  SELECT MIN(day) AS day FROM (\n${floors.join("\n    UNION ALL\n")})),`;
  return KPI_QUERIES.throughput
    .replace(/activity AS \([\s\S]*?\),\nactive_days AS/, `${activity}\nactive_days AS`)
    .replace(/record_floor AS \([\s\S]*?\)\),\nwk_keys AS/, `${floor}\nwk_keys AS`);
}

/** The record's first activity day (UTC) — weeks starting before it have no per-active-day reading. */
function activityFloor(db: Database.Database, hasHuntRuns: boolean, hasCeremony: boolean): string | null {
  const parts: string[] = [];
  if (hasHuntRuns) parts.push("SELECT MIN(date(created_at)) AS day FROM agent_events WHERE project IS NOT NULL");
  if (hasCeremony) parts.push("SELECT MIN(date(created_at)) AS day FROM ceremony_events");
  if (parts.length === 0) return null;
  return scalar<string | null>(db, `SELECT MIN(day) AS day FROM (${parts.join(" UNION ALL ")})`);
}

function deltaPct(w0: number | null, w1: number | null): number | null {
  if (w0 === null || w1 === null || w0 === 0) return null;
  return Math.round(((w1 - w0) / w0) * 1000) / 10;
}

function metric(w0: number | null, w1: number | null): KpiAlarmMetric {
  const delta = deltaPct(w0, w1);
  return { w0, w1, delta_pct: delta, flag: delta !== null && Math.abs(delta) > 30 };
}

function fmtDelta(m: KpiAlarmMetric): string {
  if (m.delta_pct === null) return "n/a";
  const sign = m.delta_pct > 0 ? "+" : "";
  return `${sign}${Math.round(m.delta_pct)}%${m.flag ? " !" : ""}`;
}

function fmtNum(v: number | null, digits: number): string {
  return v === null ? "n/a" : v.toFixed(digits);
}

function buildAlarm(
  db: Database.Database,
  project: string,
  currentMonday: string,
  has: { hasBriefStatus: boolean; hasHuntRuns: boolean; hasCeremony: boolean },
): KpiAlarm {
  const w1 = addDays(currentMonday, -7);
  const w0 = addDays(currentMonday, -14);
  const b = bindings(w0, project);

  const pick = <T extends { week_start: string }>(rows: T[], wk: string): T | undefined =>
    rows.find((r) => r.week_start === wk);

  let dpad0: number | null = null;
  let dpad1: number | null = null;
  if (has.hasBriefStatus) {
    const rows = db.prepare(throughputSql(has.hasHuntRuns, has.hasCeremony)).all(b) as KpiThroughputRow[];
    dpad0 = pick(rows, w0)?.done_per_active_day ?? null;
    dpad1 = pick(rows, w1)?.done_per_active_day ?? null;
  }
  let med0: number | null = null;
  let med1: number | null = null;
  if (has.hasHuntRuns) {
    const rows = db.prepare(KPI_QUERIES.hunt_minutes).all(b) as KpiHuntMinutesRow[];
    med0 = pick(rows, w0)?.median_min ?? null;
    med1 = pick(rows, w1)?.median_min ?? null;
  }
  const ceremonies: KpiAlarm["ceremonies"] = [];
  let unpaired = 0;
  if (has.hasCeremony) {
    const cost = (db.prepare(KPI_QUERIES.ceremony_cost).all(b) as KpiCeremonyCostRow[]).filter((r) => r.week_start === w1);
    for (const r of cost) ceremonies.push({ ceremony: r.ceremony, runs: r.runs, median_min: r.median_min });
    const cov = (db.prepare(KPI_QUERIES.ceremony_coverage).all(b) as KpiCeremonyCoverageRow[]).filter((r) => r.week_start === w1);
    unpaired = cov.reduce((s, r) => s + r.unpaired, 0);
  }

  const done = metric(dpad0, dpad1);
  const med = metric(med0, med1);
  const parts = [
    `KPI (UTC weeks ${w0} → ${w1}): Done/active-day ${fmtNum(done.w0, 1)} → ${fmtNum(done.w1, 1)} (${fmtDelta(done)})`,
    `hunt median ${fmtNum(med.w0, 0)} → ${fmtNum(med.w1, 0)} min (${fmtDelta(med)})`,
    ceremonies.length === 0
      ? "no ceremonies"
      : ceremonies.map((c) => `${c.ceremony} ${c.runs} (${fmtNum(c.median_min, 1)} min)`).join(" · "),
    `unpaired ${unpaired}`,
  ];
  return {
    project,
    w0_week_start: w0,
    w1_week_start: w1,
    done_per_active_day: done,
    hunt_median_min: med,
    ceremonies,
    unpaired,
    line: parts.join(" · "),
  };
}
