/**
 * FR-268 — `lib/kpi-read.ts`: the seven OS KPI derivations, row by row.
 *
 * The fixture DB carries the EXACT DDL the reader queries: `brief_status`
 * (db.ts v2), `agent_events` at the v3 shape + the `hunt_runs` view (instances
 * migration v3, verbatim), and `ceremony_events` + `ceremony_runs` (v4,
 * verbatim). Rows are seeded across three UTC weeks including a Sunday
 * 23:59:59 and a Monday 00:00:00 row, so the week boundary is measured, not
 * assumed. `nowOverride` pins the clock at 2026-08-27 10:00:00 UTC
 * (Thursday): weeks 2026-08-10, 2026-08-17 and 2026-08-24 (partial).
 *
 * Also here: the alarm's threshold at +29 / +30 / +31 %, `n/a` on a NULL
 * side, and the guarantee that it never reads the partial week; the degraded
 * shapes for a brain missing `hunt_runs` or `ceremony_events`; the NO-WRITE
 * gate over the read door (sha256 + mtime + size of the DB file identical
 * before and after — the `cognition-health.test.ts` idiom, with a positive
 * control); and the purity static scan with a self-negative fixture.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildKpiDigest,
  DONE_FOLD_SQL,
  EFFORT_FOLD_SQL,
  KPI_QUERIES,
  kpiSqlListing,
  MEDIAN_RANK_SQL,
  P75_RANK_SQL,
  throughputSql,
  weekStartSql,
} from "../lib/kpi-read.js";

// ---------------------------------------------------------------------------
// DDL — verbatim from the brain
// ---------------------------------------------------------------------------

const PROJECTS_DDL = `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL
  );`;

/** db.ts v2 */
const BRIEF_STATUS_DDL = `
  CREATE TABLE IF NOT EXISTS brief_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    brief_id TEXT NOT NULL,
    brief_type TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT,
    effort TEXT,
    phase TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project) REFERENCES projects(slug)
  );`;

/** instances v1 CREATE + v3 ALTERs + hunt_runs view */
const AGENT_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('start', 'stop', 'error', 'retry')),
    phase TEXT,
    brief_id TEXT,
    duration_ms INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read INTEGER DEFAULT 0,
    cache_create INTEGER DEFAULT 0,
    result TEXT,
    error_message TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ALTER TABLE agent_events ADD COLUMN model_requested TEXT;
  ALTER TABLE agent_events ADD COLUMN model_resolved TEXT;
  ALTER TABLE agent_events ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE agent_events ADD COLUMN project TEXT;
  CREATE VIEW IF NOT EXISTS hunt_runs AS
    SELECT e.project, e.brief_id, bs.effort AS size, e.agent, e.round, e.phase,
           e.model_requested, e.model_resolved, e.event_type AS ended_with, e.result,
           e.duration_ms, ROUND(e.duration_ms / 60000.0, 1) AS minutes,
           CASE WHEN e.duration_ms IS NULL THEN NULL
                ELSE datetime(e.created_at, '-' || (e.duration_ms / 1000) || ' seconds') END AS started_at,
           e.created_at AS ended_at,
           e.input_tokens, e.output_tokens, e.cache_read, e.cache_create,
           e.instance_id, e.id AS event_id
    FROM agent_events e
    LEFT JOIN brief_status bs ON bs.project = e.project AND bs.brief_id = e.brief_id
    WHERE e.event_type IN ('stop', 'error');`;

/** instances v4 */
const CEREMONY_DDL = `
  CREATE TABLE IF NOT EXISTS ceremony_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    ceremony TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('start','stop')),
    machine_hostname TEXT NOT NULL,
    instance_id TEXT,
    brief_id TEXT,
    duration_ms INTEGER,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ceremony_events_key
    ON ceremony_events(project, ceremony, event_type, created_at);
  CREATE VIEW IF NOT EXISTS ceremony_runs AS
    SELECT e.project, e.ceremony, e.machine_hostname, e.instance_id, e.brief_id,
           e.duration_ms, ROUND(e.duration_ms / 60000.0, 1) AS minutes,
           CASE WHEN e.duration_ms IS NULL THEN NULL
                ELSE datetime(e.created_at, '-' || (e.duration_ms / 1000) || ' seconds') END AS started_at,
           e.created_at AS ended_at, e.id AS event_id
    FROM ceremony_events e WHERE e.event_type = 'stop';`;

const NOW = "2026-08-27 10:00:00"; // Thursday; current UTC week = 2026-08-24
const MIN = 60_000;

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function schema(db: Database.Database, opts: { huntRuns?: boolean; ceremony?: boolean } = {}): void {
  db.exec(PROJECTS_DDL + BRIEF_STATUS_DDL);
  if (opts.huntRuns !== false) db.exec(AGENT_EVENTS_DDL);
  if (opts.ceremony !== false) db.exec(CEREMONY_DDL);
  db.prepare("INSERT INTO projects (slug, name, path) VALUES ('igris-ai', 'Igris', '/x'), ('moca', 'Moca', '/y')").run();
}

function done(db: Database.Database, project: string, id: string, status: string, effort: string | null, at: string): void {
  db.prepare("INSERT INTO brief_status (project, brief_id, title, status, effort, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(project, id, id, status, effort, at);
}

function ev(
  db: Database.Database,
  project: string,
  brief: string | null,
  agent: string,
  type: "start" | "stop" | "error",
  durationMin: number | null,
  at: string,
  extra: { model?: string; round?: number; metadata?: string } = {},
): void {
  db.prepare(
    `INSERT INTO agent_events (instance_id, agent, event_type, brief_id, duration_ms, model_requested, round, project, metadata, created_at)
     VALUES ('i1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(agent, type, brief, durationMin === null ? null : durationMin * MIN, extra.model ?? "m1", extra.round ?? 1, project, extra.metadata ?? "{}", at);
}

function cer(db: Database.Database, project: string, ceremony: string, type: "start" | "stop", durationMin: number | null, at: string): void {
  db.prepare(
    "INSERT INTO ceremony_events (project, ceremony, event_type, machine_hostname, duration_ms, created_at) VALUES (?, ?, ?, 'h1', ?, ?)",
  ).run(project, ceremony, type, durationMin === null ? null : durationMin * MIN, at);
}

/** The reference fixture every row-by-row assertion below reads. */
function seedReference(db: Database.Database): void {
  // brief_status — Done rows across the three weeks, the fold, a non-Done row, a pre-window row.
  done(db, "igris-ai", "FR-1", "Done", "S-Small (< 4h)", "2026-08-12 10:00:00");   // week 08-10
  done(db, "igris-ai", "FR-2", "Done", "L-Large", "2026-08-16 23:59:59");           // Sunday 23:59:59 -> week 08-10
  done(db, "igris-ai", "FR-3", "Done", "XS-Trivial", "2026-08-17 00:00:00");        // Monday 00:00:00 -> week 08-17
  done(db, "igris-ai", "FR-4", "DONE ", null, "2026-08-19 12:00:00");               // the TD-340 fold; effort NULL -> (none)
  done(db, "igris-ai", "FR-5", "Done", "M-Medium (1-2d)", "2026-08-25 09:00:00");   // partial week 08-24
  done(db, "igris-ai", "FR-6", "Ready", "S", "2026-08-18 12:00:00");                // not Done
  done(db, "igris-ai", "FR-0", "Done", "S", "2026-08-05 12:00:00");                 // before :since
  done(db, "moca", "MC-1", "Done", "S", "2026-08-20 10:00:00");                      // week 08-17

  // agent_events — week 08-10: archaeology (NULL durations) on two days.
  ev(db, "igris-ai", "FR-1", "forger", "start", null, "2026-08-10 10:00:00", { model: undefined }); // Monday: the record floor
  ev(db, "igris-ai", "FR-1", "forger", "stop", null, "2026-08-13 10:00:00");
  // week 08-17 — hunt FR-A: 10 + 30 + 10 (+ unpaired warden error) + 10 (forger round 2) = 60 min
  ev(db, "igris-ai", "FR-A", "architect", "start", null, "2026-08-18 09:50:00");
  ev(db, "igris-ai", "FR-A", "architect", "stop", 10, "2026-08-18 10:00:00");
  ev(db, "igris-ai", "FR-A", "forger", "stop", 30, "2026-08-18 11:00:00", { metadata: '{"tool_calls": 40}' });
  ev(db, "igris-ai", "FR-A", "sentinel", "stop", 10, "2026-08-19 09:00:00");
  ev(db, "igris-ai", "FR-A", "warden", "error", null, "2026-08-19 10:00:00");
  ev(db, "igris-ai", "FR-A", "forger", "stop", 10, "2026-08-19 11:00:00", { round: 2, metadata: '{"tool_calls": 60}' });
  // hunt FR-B: 50 + 20 = 70 min
  ev(db, "igris-ai", "FR-B", "forger", "stop", 50, "2026-08-21 10:00:00");
  ev(db, "igris-ai", "FR-B", "sentinel", "stop", 20, "2026-08-21 11:00:00");
  // hunt FR-C: 20 min, Sunday 23:59:59 -> week 08-17
  ev(db, "igris-ai", "FR-C", "forger", "stop", 20, "2026-08-23 23:59:59");
  // hunt FR-D: 30 min, Monday 00:00:00 -> week 08-24 (partial)
  ev(db, "igris-ai", "FR-D", "forger", "stop", 30, "2026-08-24 00:00:00");
  // moca — four one-invocation hunts on model m2 (n = 4 for the rank arithmetic)
  ev(db, "moca", "MC-1", "forger", "stop", 10, "2026-08-18 10:00:00", { model: "m2" });
  ev(db, "moca", "MC-2", "forger", "stop", 20, "2026-08-19 10:00:00", { model: "m2" });
  ev(db, "moca", "MC-3", "forger", "stop", 30, "2026-08-20 10:00:00", { model: "m2" });
  ev(db, "moca", "MC-4", "forger", "stop", 40, "2026-08-21 10:00:00", { model: "m2" });

  // ceremony_events — igris-ai, week 08-17: boot 3.0 + 5.0 min, rest 2.0 min, one unpaired boot start.
  cer(db, "igris-ai", "boot", "start", null, "2026-08-18 08:00:00");
  cer(db, "igris-ai", "boot", "stop", 3, "2026-08-18 08:03:00");
  cer(db, "igris-ai", "boot", "start", null, "2026-08-20 08:00:00");
  cer(db, "igris-ai", "boot", "stop", 5, "2026-08-20 08:05:00");
  cer(db, "igris-ai", "rest", "start", null, "2026-08-20 17:00:00");
  cer(db, "igris-ai", "rest", "stop", 2, "2026-08-20 17:02:00");
  cer(db, "igris-ai", "boot", "start", null, "2026-08-22 08:00:00"); // never stopped
  // partial week: an unpaired rest stop
  cer(db, "igris-ai", "rest", "stop", null, "2026-08-25 18:00:00");
}

function memDb(opts?: { huntRuns?: boolean; ceremony?: boolean }): Database.Database {
  const db = new Database(":memory:");
  schema(db, opts);
  return db;
}

const open: Database.Database[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
});

function digest(db: Database.Database, extra: Partial<Parameters<typeof buildKpiDigest>[1]> = {}) {
  open.push(db);
  return buildKpiDigest(db, { project: null, weeks: 3, alarm: false, nowOverride: NOW, ...extra });
}

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

describe("conventions — UTC Monday weeks, the folds, nearest-rank", () => {
  it("weekStartSql: Sunday 23:59:59 stays in its week, Monday 00:00:00 opens the next; Sunday itself maps back six days", () => {
    const db = memDb();
    open.push(db);
    const wk = (x: string) => (db.prepare(`SELECT ${weekStartSql("?")} AS w`).get(x, x) as { w: string }).w;
    expect(wk("2026-08-23 23:59:59")).toBe("2026-08-17");
    expect(wk("2026-08-24 00:00:00")).toBe("2026-08-24");
    expect(wk("2026-08-30 12:00:00")).toBe("2026-08-24"); // Sunday
    expect(wk("2026-08-17 00:00:00")).toBe("2026-08-17"); // Monday is its own start
    expect(wk("2026-08-16 23:59:59")).toBe("2026-08-10");
  });

  it("the Done fold matches Done / DONE / done  / Done_ and not Done(Resolved…) or Ready", () => {
    const db = memDb();
    open.push(db);
    const q = db.prepare(`SELECT status FROM (SELECT ? AS status) WHERE ${DONE_FOLD_SQL}`);
    for (const s of ["Done", "DONE", "done ", "Done_", "do-ne"]) expect(q.get(s), s).toBeDefined();
    for (const s of ["Done(Resolvedbydec8d1f)", "Ready", "Archived"]) expect(q.get(s), s).toBeUndefined();
  });

  it("the effort fold keeps the leading size token and names the rest", () => {
    const db = memDb();
    open.push(db);
    const f = (e: string | null) => (db.prepare(`SELECT ${EFFORT_FOLD_SQL} AS t FROM (SELECT ? AS effort)`).get(e) as { t: string }).t;
    expect(f("S-Small (< 4h)")).toBe("S");
    expect(f("XS-Trivial")).toBe("XS");
    expect(f("XL-Extra Large (>1w)")).toBe("XL");
    expect(f("M (Medium)")).toBe("M");
    expect(f("L")).toBe("L");
    expect(f("TBD")).toBe("(other)");
    expect(f(null)).toBe("(none)");
  });

  it("nearest-rank in integer arithmetic equals max(1, ceil(n·p)) for n = 1..8", () => {
    const db = memDb();
    open.push(db);
    for (let n = 1; n <= 8; n++) {
      // `n` is `COUNT(*) OVER (...)` in every real query — an INTEGER, so the
      // division truncates. A JS number binds as REAL (1.0), which would turn
      // the ceiling into 1.5: the CAST reproduces the production type.
      const r = db.prepare(`SELECT ${MEDIAN_RANK_SQL} AS m, ${P75_RANK_SQL} AS p FROM (SELECT CAST(? AS INTEGER) AS n)`).get(n) as { m: number; p: number };
      expect(r.m, `median n=${n}`).toBe(Math.max(1, Math.ceil(n * 0.5)));
      expect(r.p, `p75 n=${n}`).toBe(Math.max(1, Math.ceil(n * 0.75)));
    }
  });

  it("on a v4 brain the verb runs KPI_QUERIES.throughput byte-for-byte; an older brain runs a narrowed activity CTE", () => {
    // `throughputSql` re-derives the constant through two regex replacements;
    // this pins that the full-brain path is the PUBLISHED query (the doc says
    // "the verb runs exactly these"), and that the narrowing really narrows.
    expect(throughputSql(true, true)).toBe(KPI_QUERIES.throughput);
    expect(throughputSql(true, false)).not.toContain("FROM ceremony_events");
    expect(throughputSql(true, false)).toContain("FROM agent_events");
    expect(throughputSql(false, true)).not.toContain("FROM agent_events");
    expect(throughputSql(false, false)).toContain("SELECT NULL AS project, NULL AS day WHERE 0");
  });

  it("the --sql listing carries every query, the bindings note and the SQLite floor; every query prepares", () => {
    const listing = kpiSqlListing();
    for (const name of Object.keys(KPI_QUERIES)) expect(listing).toContain(`-- ${name}\n`);
    expect(listing).toContain(".parameter set :since");
    expect(listing).toContain("SQLite >= 3.25");
    const db = memDb();
    open.push(db);
    for (const sql of Object.values(KPI_QUERIES)) expect(() => db.prepare(sql)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The seven outputs, row by row
// ---------------------------------------------------------------------------

describe("the seven KPIs over the reference fixture (now = 2026-08-27 10:00 UTC, 3 weeks)", () => {
  it("header: tz UTC, since = Monday of the oldest week, three weeks with the current one partial", () => {
    const db = memDb();
    seedReference(db);
    const d = digest(db);
    expect(d.degraded).toBe(false);
    expect(d.tz).toBe("UTC");
    expect(d.generated_at).toBe(NOW);
    expect(d.since).toBe("2026-08-10");
    expect(d.activity_floor).toBe("2026-08-10");
    expect(d.weeks).toEqual([
      { week_start: "2026-08-10", week_end: "2026-08-16", partial: false },
      { week_start: "2026-08-17", week_end: "2026-08-23", partial: false },
      { week_start: "2026-08-24", week_end: "2026-08-30", partial: true },
    ]);
    expect(d.skipped).toEqual([]);
  });

  it("1. capacity — brain-bracket minutes per project per week, NULL durations excluded", () => {
    const db = memDb();
    seedReference(db);
    expect(digest(db).capacity).toEqual([
      { project: "igris-ai", week_start: "2026-08-17", agent_minutes: 150, invocations: 7, briefs: 3 },
      { project: "moca", week_start: "2026-08-17", agent_minutes: 100, invocations: 4, briefs: 4 },
      { project: "igris-ai", week_start: "2026-08-24", agent_minutes: 30, invocations: 1, briefs: 1 },
    ]);
  });

  it("2. throughput — Done per week and per active day (agent_events ∪ ceremony_events days)", () => {
    const db = memDb();
    seedReference(db);
    expect(digest(db).throughput).toEqual([
      { project: "igris-ai", week_start: "2026-08-10", done: 2, active_days: 2, done_per_active_day: 1 },
      { project: "igris-ai", week_start: "2026-08-17", done: 2, active_days: 6, done_per_active_day: 0.33 },
      { project: "moca", week_start: "2026-08-17", done: 1, active_days: 4, done_per_active_day: 0.25 },
      { project: "igris-ai", week_start: "2026-08-24", done: 1, active_days: 2, done_per_active_day: 0.5 },
    ]);
  });

  it("2c. throughput — a week that starts BEFORE the record's first activity day reads NULL per active day (coverage, not zero)", () => {
    const db = memDb();
    done(db, "igris-ai", "FR-1", "Done", "S", "2026-08-11 10:00:00"); // week 08-10
    done(db, "igris-ai", "FR-2", "Done", "S", "2026-08-18 10:00:00"); // week 08-17
    ev(db, "igris-ai", "FR-1", "forger", "stop", 10, "2026-08-12 10:00:00"); // the record starts Wednesday 08-12
    ev(db, "igris-ai", "FR-2", "forger", "stop", 10, "2026-08-18 10:00:00");
    const d = digest(db);
    expect(d.activity_floor).toBe("2026-08-12");
    expect(d.throughput).toEqual([
      // one active day is COUNTED, but the week is not covered, so the ratio is NULL — not 1.0
      { project: "igris-ai", week_start: "2026-08-10", done: 1, active_days: 1, done_per_active_day: null },
      { project: "igris-ai", week_start: "2026-08-17", done: 1, active_days: 1, done_per_active_day: 1 },
    ]);
    // ...and the alarm reads n/a on that side rather than flagging a coverage artifact.
    const a = digest(db, { project: "igris-ai", alarm: true }).alarm!;
    expect(a.done_per_active_day).toEqual({ w0: null, w1: 1, delta_pct: null, flag: false });
    expect(a.line).toContain("Done/active-day n/a → 1.0 (n/a)");
  });

  it("2b. throughput — a week with Done but no activity reads NULL per active day, never 0 or infinity", () => {
    const db = memDb();
    done(db, "igris-ai", "FR-9", "Done", "S", "2026-08-12 10:00:00");
    expect(digest(db).throughput).toEqual([
      { project: "igris-ai", week_start: "2026-08-10", done: 1, active_days: 0, done_per_active_day: null },
    ]);
  });

  it("3. effort mix — leading-token classes with the XS+S share per (project, week)", () => {
    const db = memDb();
    seedReference(db);
    expect(digest(db).effort_mix).toEqual([
      { project: "igris-ai", week_start: "2026-08-10", effort: "L", done: 1, xs_s_share: 0.5 },
      { project: "igris-ai", week_start: "2026-08-10", effort: "S", done: 1, xs_s_share: 0.5 },
      { project: "igris-ai", week_start: "2026-08-17", effort: "(none)", done: 1, xs_s_share: 0.5 },
      { project: "igris-ai", week_start: "2026-08-17", effort: "XS", done: 1, xs_s_share: 0.5 },
      { project: "moca", week_start: "2026-08-17", effort: "S", done: 1, xs_s_share: 1 },
      { project: "igris-ai", week_start: "2026-08-24", effort: "M", done: 1, xs_s_share: 0 },
    ]);
  });

  it("4. minutes per hunt — nearest-rank median / p75 on n = 3, 4, 1 and the phase shares", () => {
    const db = memDb();
    seedReference(db);
    expect(digest(db).hunt_minutes).toEqual([
      // igris-ai: hunts A=60, B=70, C=20 -> sorted [20, 60, 70]; median rank 2, p75 rank 3
      {
        project: "igris-ai", week_start: "2026-08-17", hunts: 3, median_min: 60, p75_min: 70,
        architect_share: 0.07, forger_share: 0.73, sentinel_share: 0.2, warden_share: 0, mender_share: 0, document_share: 0,
      },
      // moca: [10, 20, 30, 40]; median rank 2 -> 20, p75 rank 3 -> 30
      {
        project: "moca", week_start: "2026-08-17", hunts: 4, median_min: 20, p75_min: 30,
        architect_share: 0, forger_share: 1, sentinel_share: 0, warden_share: 0, mender_share: 0, document_share: 0,
      },
      // n = 1: both ranks are 1
      {
        project: "igris-ai", week_start: "2026-08-24", hunts: 1, median_min: 30, p75_min: 30,
        architect_share: 0, forger_share: 1, sentinel_share: 0, warden_share: 0, mender_share: 0, document_share: 0,
      },
    ]);
  });

  it("4b. minutes per hunt — n = 2 takes the lower value as median and the upper as p75", () => {
    const db = memDb();
    ev(db, "igris-ai", "FR-X", "forger", "stop", 10, "2026-08-18 10:00:00");
    ev(db, "igris-ai", "FR-Y", "forger", "stop", 40, "2026-08-19 10:00:00");
    expect(digest(db).hunt_minutes[0]).toMatchObject({ hunts: 2, median_min: 10, p75_min: 40 });
  });

  it("5. rounds per hunt — a round-2 row marks the hunt resumed", () => {
    const db = memDb();
    seedReference(db);
    expect(digest(db).hunt_rounds).toEqual([
      { project: "igris-ai", week_start: "2026-08-17", hunts: 3, hunts_resumed: 1, resumed_share: 0.33, avg_extra_rounds: 0.33 },
      { project: "moca", week_start: "2026-08-17", hunts: 4, hunts_resumed: 0, resumed_share: 0, avg_extra_rounds: 0 },
      { project: "igris-ai", week_start: "2026-08-24", hunts: 1, hunts_resumed: 0, resumed_share: 0, avg_extra_rounds: 0 },
    ]);
  });

  it("6. model per role — per-invocation medians over the window; tool calls only where metadata carries them", () => {
    const db = memDb();
    seedReference(db);
    expect(digest(db).model_per_role).toEqual([
      { agent: "architect", model_requested: "m1", n: 1, median_min: 10, p75_min: 10, tool_calls_median: null, tool_calls_n: 0 },
      // forger m1: [30, 10, 50, 20, 30] -> sorted [10, 20, 30, 30, 50]; rank 3 -> 30, rank 4 -> 30; tool_calls [40, 60] -> rank 1 -> 40
      { agent: "forger", model_requested: "m1", n: 5, median_min: 30, p75_min: 30, tool_calls_median: 40, tool_calls_n: 2 },
      { agent: "forger", model_requested: "m2", n: 4, median_min: 20, p75_min: 30, tool_calls_median: null, tool_calls_n: 0 },
      { agent: "sentinel", model_requested: "m1", n: 2, median_min: 10, p75_min: 20, tool_calls_median: null, tool_calls_n: 0 },
    ]);
  });

  it("7. ceremony cost + coverage — runs, medians, and the unpaired counts that go red", () => {
    const db = memDb();
    seedReference(db);
    const d = digest(db);
    expect(d.ceremony_cost).toEqual([
      { project: "igris-ai", ceremony: "boot", week_start: "2026-08-17", runs: 2, median_min: 3, p75_min: 5 },
      { project: "igris-ai", ceremony: "rest", week_start: "2026-08-17", runs: 1, median_min: 2, p75_min: 2 },
    ]);
    expect(d.ceremony_coverage).toEqual([
      { project: "igris-ai", ceremony: "boot", week_start: "2026-08-17", starts: 3, stops: 2, unpaired: 1, unpaired_stops: 0 },
      { project: "igris-ai", ceremony: "rest", week_start: "2026-08-17", starts: 1, stops: 1, unpaired: 0, unpaired_stops: 0 },
      { project: "igris-ai", ceremony: "rest", week_start: "2026-08-24", starts: 0, stops: 1, unpaired: -1, unpaired_stops: 1 },
    ]);
  });

  it("--project scopes every table to one slug", () => {
    const db = memDb();
    seedReference(db);
    const d = digest(db, { project: "moca" });
    expect(d.project).toBe("moca");
    expect(d.capacity.map((r) => r.project)).toEqual(["moca"]);
    expect(d.throughput.map((r) => r.project)).toEqual(["moca"]);
    expect(d.effort_mix.map((r) => r.project)).toEqual(["moca"]);
    expect(d.hunt_minutes.map((r) => r.project)).toEqual(["moca"]);
    expect(d.hunt_rounds.map((r) => r.project)).toEqual(["moca"]);
    expect(d.model_per_role).toEqual([
      { agent: "forger", model_requested: "m2", n: 4, median_min: 20, p75_min: 30, tool_calls_median: null, tool_calls_n: 0 },
    ]);
    expect(d.ceremony_cost).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The alarm
// ---------------------------------------------------------------------------

describe("the alarm — last complete week vs the one before, |Δ| > 30 % flags", () => {
  it("reference fixture: Done/active-day 1.0 -> 0.33 flags; hunt median n/a on a NULL W0; ceremonies and unpaired from W1", () => {
    const db = memDb();
    seedReference(db);
    const a = digest(db, { project: "igris-ai", alarm: true }).alarm!;
    expect(a).toMatchObject({
      project: "igris-ai",
      w0_week_start: "2026-08-10",
      w1_week_start: "2026-08-17",
      done_per_active_day: { w0: 1, w1: 0.33, delta_pct: -67, flag: true },
      hunt_median_min: { w0: null, w1: 60, delta_pct: null, flag: false },
      ceremonies: [
        { ceremony: "boot", runs: 2, median_min: 3 },
        { ceremony: "rest", runs: 1, median_min: 2 },
      ],
      unpaired: 1,
    });
    expect(a.line).toBe(
      "KPI (UTC weeks 2026-08-10 → 2026-08-17): Done/active-day 1.0 → 0.3 (-67% !) · hunt median n/a → 60 min (n/a) · boot 2 (3.0 min) · rest 1 (2.0 min) · unpaired 1",
    );
  });

  /** One hunt per week, so the week's median IS that hunt's minutes. */
  function seedMedians(db: Database.Database, w0Min: number, w1Min: number): void {
    ev(db, "igris-ai", "W0", "forger", "stop", w0Min, "2026-08-12 10:00:00");
    ev(db, "igris-ai", "W1", "forger", "stop", w1Min, "2026-08-19 10:00:00");
  }

  it("fires at +31 %, not at +29 %, and not at exactly +30 % (strictly greater)", () => {
    for (const [w1, flag, text] of [[131, true, "(+31% !)"], [129, false, "(+29%)"], [130, false, "(+30%)"]] as const) {
      const db = memDb();
      seedMedians(db, 100, w1);
      const a = digest(db, { project: "igris-ai", alarm: true }).alarm!;
      expect(a.hunt_median_min, String(w1)).toEqual({ w0: 100, w1, delta_pct: w1 - 100, flag });
      expect(a.line).toContain(`hunt median 100 → ${w1} min ${text}`);
    }
  });

  it("flags a fall past −30 % too", () => {
    const db = memDb();
    seedMedians(db, 100, 60);
    expect(digest(db, { project: "igris-ai", alarm: true }).alarm!.hunt_median_min).toEqual({ w0: 100, w1: 60, delta_pct: -40, flag: true });
  });

  it("never reads the partial week: a 10-hour hunt in the current week changes nothing", () => {
    const db = memDb();
    seedMedians(db, 100, 110);
    ev(db, "igris-ai", "NOW", "forger", "stop", 600, "2026-08-26 10:00:00");
    const a = digest(db, { project: "igris-ai", alarm: true }).alarm!;
    expect(a.hunt_median_min).toEqual({ w0: 100, w1: 110, delta_pct: 10, flag: false });
    expect(a.line).toContain("no ceremonies");
    expect(a.line).toContain("unpaired 0");
  });

  it("without --project the alarm is not computed and the digest says why", () => {
    const db = memDb();
    seedReference(db);
    const d = digest(db, { alarm: true });
    expect(d.alarm).toBeNull();
    expect(d.degraded).toBe(true);
    expect(d.skipped).toContain("alarm needs --project");
  });
});

// ---------------------------------------------------------------------------
// Degraded shapes
// ---------------------------------------------------------------------------

describe("degraded shapes — an older brain still answers what it can", () => {
  it("no hunt_runs (brain < v3): KPIs 1/4/5/6 skipped by name; throughput still computes from ceremony days", () => {
    const db = memDb({ huntRuns: false });
    done(db, "igris-ai", "FR-1", "Done", "S", "2026-08-18 10:00:00");
    cer(db, "igris-ai", "boot", "start", null, "2026-08-17 08:00:00"); // Monday: the record floor
    const d = digest(db);
    expect(d.degraded).toBe(true);
    expect(d.skipped).toEqual(["hunt_runs absent — brain older than FR-267 (instances v3); KPIs 1, 4, 5, 6 not computed"]);
    expect(d.capacity).toEqual([]);
    expect(d.hunt_minutes).toEqual([]);
    expect(d.throughput).toEqual([{ project: "igris-ai", week_start: "2026-08-17", done: 1, active_days: 1, done_per_active_day: 1 }]);
    expect(d.activity_floor).toBe("2026-08-17");
  });

  it("no ceremony_events (brain < v4): KPI 7 skipped by name; active days come from agent_events alone", () => {
    const db = memDb({ ceremony: false });
    done(db, "igris-ai", "FR-1", "Done", "S", "2026-08-18 10:00:00");
    ev(db, "igris-ai", "FR-1", "forger", "stop", 10, "2026-08-17 10:00:00"); // Monday: the record floor
    ev(db, "igris-ai", "FR-1", "forger", "stop", 10, "2026-08-19 10:00:00");
    const d = digest(db);
    expect(d.activity_floor).toBe("2026-08-17");
    expect(d.skipped).toEqual(["ceremony_events absent — brain older than FR-268 (instances v4); KPI 7 not computed"]);
    expect(d.ceremony_cost).toEqual([]);
    expect(d.throughput).toEqual([{ project: "igris-ai", week_start: "2026-08-17", done: 1, active_days: 2, done_per_active_day: 0.5 }]);
    expect(d.capacity[0].agent_minutes).toBe(20);
  });

  it("neither event table: throughput reads NULL per active day", () => {
    const db = memDb({ huntRuns: false, ceremony: false });
    done(db, "igris-ai", "FR-1", "Done", "S", "2026-08-18 10:00:00");
    const d = digest(db);
    expect(d.skipped).toHaveLength(2);
    expect(d.throughput).toEqual([{ project: "igris-ai", week_start: "2026-08-17", done: 1, active_days: 0, done_per_active_day: null }]);
    expect(d.activity_floor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The read door never writes
// ---------------------------------------------------------------------------

describe("readKpiDigest — the read-only door leaves the brain file byte-identical", () => {
  let tmpRoot: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-kpi-"));
    savedEnv = { ...process.env };
    process.env.IGRIS_BRAIN_DIR = tmpRoot;
  });
  afterEach(async () => {
    (await import("../lib/brain-db.js")).closeDb();
    process.env = savedEnv;
  });

  it("sha256, mtime and size are unchanged, and the same run produced real signal", async () => {
    const file = join(tmpRoot, "memory", "knowledge.db");
    mkdirSync(join(tmpRoot, "memory"), { recursive: true });
    const seed = new Database(file);
    schema(seed);
    seedReference(seed);
    seed.close();

    const stamp = () => ({
      sha: createHash("sha256").update(readFileSync(file)).digest("hex"),
      mtimeMs: statSync(file).mtimeMs,
      size: statSync(file).size,
    });
    const before = stamp();
    const { readKpiDigest } = await import("../lib/brain-db.js");
    const d = readKpiDigest({ project: "igris-ai", weeks: 3, alarm: true, nowOverride: NOW });
    const after = stamp();

    expect(after).toEqual(before);
    // POSITIVE CONTROL — "no writes" is trivially true of a run that read nothing.
    expect(d.degraded).toBe(false);
    expect(d.capacity.length).toBeGreaterThan(0);
    expect(d.throughput.length).toBeGreaterThan(0);
    expect(d.ceremony_cost.length).toBeGreaterThan(0);
    expect(d.alarm?.unpaired).toBe(1);
  });

  it("no brain file -> the absent digest, degraded, exit-0 shaped", async () => {
    const { readKpiDigest } = await import("../lib/brain-db.js");
    const d = readKpiDigest({ project: null, weeks: 4, alarm: false });
    expect(d.degraded).toBe(true);
    expect(d.skipped).toEqual(["brain db absent — nothing to read"]);
    expect(d.weeks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Purity — verified with a grep, not by intent (coding_guidelines §7)
// ---------------------------------------------------------------------------

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const PURITY_RULES: { name: string; pattern: RegExp }[] = [
  { name: "imports brain-db", pattern: /from\s+["'][^"']*brain-db(\.js)?["']/ },
  { name: "imports db.js", pattern: /from\s+["'](?:\.\.\/)*db\.js["']/ },
  { name: "calls getDb(", pattern: /\bgetDb\s*\(/ },
  { name: "UPDATE statement", pattern: /\bUPDATE\b/ },
  { name: "INSERT statement", pattern: /\bINSERT\b/ },
  { name: "DELETE statement", pattern: /\bDELETE\b/ },
  { name: "CREATE statement", pattern: /\bCREATE\b/ },
  { name: ".run( on a statement", pattern: /\.run\s*\(/ },
  { name: "db.transaction(", pattern: /\.transaction\s*\(/ },
  { name: "db.pragma(", pattern: /\.pragma\s*\(/ },
];

function scanForViolations(src: string): string[] {
  const code = stripComments(src);
  return PURITY_RULES.filter((r) => r.pattern.test(code)).map((r) => r.name);
}

describe("kpi-read.ts is pure", () => {
  it("imports no door and issues no write", () => {
    const src = readFileSync(fileURLToPath(new URL("../lib/kpi-read.ts", import.meta.url)), "utf-8");
    expect(scanForViolations(src)).toEqual([]);
    expect(src).toMatch(/import type Database from "better-sqlite3"/);
  });

  it("SELF-NEGATIVE CONTROL: a module carrying every forbidden construct is flagged on every rule", () => {
    const planted = [
      'import { getDb } from "./brain-db.js";',
      'import { x } from "../db.js";',
      "const db = getDb();",
      'db.prepare("UPDATE t SET a = 1").run();',
      'db.prepare("INSERT INTO t VALUES (1)").run();',
      'db.prepare("DELETE FROM t").run();',
      'db.exec("CREATE TABLE t (a)");',
      "db.transaction(() => {})();",
      'db.pragma("journal_mode = WAL");',
      "// a comment naming UPDATE that must NOT count on its own",
    ].join("\n");
    expect(scanForViolations(planted).sort()).toEqual(PURITY_RULES.map((r) => r.name).sort());
    // And the comment alone is not a violation.
    expect(scanForViolations("// UPDATE INSERT DELETE getDb( .run(\nexport const x = 1;")).toEqual([]);
  });
});
