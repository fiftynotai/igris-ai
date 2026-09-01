/**
 * TD-327 — `igris cognition health` classifier + no-write tests.
 *
 * Real seeded brain DB under `mkdtemp` + `IGRIS_BRAIN_DIR` (never a mock,
 * #159). Every case below names the failure it pins; several reproduce, on a
 * fixture, the exact mistakes the brief was filed about:
 *
 *   - deriving perception's namespace as `cognition.perception` instead of
 *     reading the declared LITERAL, which reports the single HEALTHIEST
 *     instance as never having run (MAINTAINING's L-857 rule);
 *   - reporting a co-driven instance as `no_signal` when its DRIVER is wedged,
 *     which points the operator at the wrong subsystem;
 *   - letting a foreign host's `run_succeeded` render a locally-wedged instance
 *     green (`event_log` is a SYNC table with a `machine_hostname` column);
 *   - collapsing `no_signal` into `ok`/`disabled`, which erases the 30-day
 *     `event_log` purge and turns "silent" into "never existed".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CognitionHealthDigest, CognitionInstanceHealth } from "../types.js";

let tmpRoot: string;
let savedEnv: NodeJS.ProcessEnv;

const HOST = "test-host";
const FOREIGN = "vps-host";

/**
 * Mirrors `brain-mcp-server/.../cognition/schema.ts` v1 + v2.
 *
 * `produced` is v2 (TD-423). Carried here even though NOTHING in this file
 * reads it: `readCognitionRoster` reports a roster missing the column as a
 * fidelity WARNING, so a fixture stuck at v1 would add a warning to every
 * health digest below and make this suite assert a shape no real brain has.
 */
const COGNITION_INSTANCES_DDL = `
  CREATE TABLE IF NOT EXISTS cognition_instances (
    id TEXT PRIMARY KEY, component TEXT NOT NULL, event_prefix TEXT NOT NULL,
    gate_keys TEXT NOT NULL, gate_default INTEGER NOT NULL DEFAULT 0,
    driver TEXT NOT NULL, driver_ref TEXT,
    output TEXT NOT NULL, produced TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/** Mirrors the brain's `event_log` (monitoring/db.ts). */
const EVENT_LOG_DDL = `
  CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT NOT NULL,
    component TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
    machine_hostname TEXT, project_slug TEXT, instance_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/** Mirrors the brain's `schedules` + `schedule_runs`. */
const SCHEDULES_DDL = `
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
    cron_expr TEXT NOT NULL, handler_type TEXT NOT NULL DEFAULT 'noop',
    handler_config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
    project_slug TEXT, tags TEXT DEFAULT '[]', max_retries INTEGER NOT NULL DEFAULT 0,
    timeout_ms INTEGER NOT NULL DEFAULT 30000, next_run_at TEXT, last_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS schedule_runs (
    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, status TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT,
    duration_ms INTEGER, result TEXT, error TEXT, attempt INTEGER NOT NULL DEFAULT 1
  );
`;

const OUTPUT_DDL = `
  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_module TEXT NOT NULL,
    project_slug TEXT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE TABLE IF NOT EXISTS learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'approved'
  );
`;

function dbFile(): string {
  return join(tmpRoot, "memory", "knowledge.db");
}

function seedSchema(): void {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  const db = new Database(dbFile());
  db.exec(COGNITION_INSTANCES_DDL);
  db.exec(EVENT_LOG_DDL);
  db.exec(SCHEDULES_DDL);
  db.exec(OUTPUT_DDL);
  db.close();
}

function withDb(fn: (db: Database.Database) => void): void {
  const db = new Database(dbFile());
  fn(db);
  db.close();
}

interface RosterSeed {
  id: string;
  component?: string;
  event_prefix?: string;
  gate_keys?: string[];
  gate_default?: boolean;
  driver?: string;
  driver_ref?: string | null;
  output?: string;
  /** TD-423 — the IDENTITY predicate. Defaults to the `output` shape. */
  produced?: string;
}

/** Insert one roster row, defaulting to the `cognition.<id>` convention. */
function seedInstance(s: RosterSeed): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO cognition_instances
         (id, component, event_prefix, gate_keys, gate_default, driver, driver_ref, output, produced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.id,
      s.component ?? `cognition.${s.id}`,
      s.event_prefix ?? `cognition.${s.id}`,
      JSON.stringify(s.gate_keys ?? [`cognition.${s.id}.enabled`]),
      s.gate_default === true ? 1 : 0,
      s.driver ?? "manual",
      s.driver_ref ?? null,
      s.output ?? `suggestions[source_module='${s.id}']`,
      s.produced ?? `suggestions[source_module='${s.id}']`,
    );
  });
}

function seedEvent(
  component: string,
  eventName: string,
  createdAt: string,
  host: string = HOST,
): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO event_log (event_name, component, machine_hostname, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(eventName, component, host, createdAt);
  });
}

function seedSchedule(
  id: string,
  name: string,
  opts: { enabled?: number; next_run_at?: string | null } = {},
): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO schedules (id, name, cron_expr, enabled, next_run_at)
       VALUES (?, ?, '0 4 * * *', ?, ?)`,
    ).run(id, name, opts.enabled ?? 1, opts.next_run_at ?? null);
  });
}

function seedRun(id: string, scheduleId: string, status: string, startedAt: string): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO schedule_runs (id, schedule_id, status, started_at) VALUES (?, ?, ?, ?)`,
    ).run(id, scheduleId, status, startedAt);
  });
}

function writeConfig(cognition: Record<string, unknown>): void {
  writeFileSync(
    join(tmpRoot, "config.json"),
    JSON.stringify({ version: "7.0.0", cognition }),
    "utf-8",
  );
}

/** ISO timestamp N days before now. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

async function digest(): Promise<CognitionHealthDigest> {
  const { buildCognitionHealthDigest } = await import("../verbs/cognition.js");
  return buildCognitionHealthDigest({ hostname: HOST });
}

function pick(d: CognitionHealthDigest, id: string): CognitionInstanceHealth {
  const row = d.instances.find((i) => i.id === id);
  if (row === undefined) throw new Error(`instance ${id} absent from digest`);
  return row;
}

async function closeBrainDb(): Promise<void> {
  (await import("../lib/brain-db.js")).closeDb();
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-cognition-"));
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
});

afterEach(async () => {
  await closeBrainDb();
  process.env = savedEnv;
});

// ---------------------------------------------------------------------------
// Degradation + derivation
// ---------------------------------------------------------------------------

describe("degradation — a health question never blocks (T13)", () => {
  it("absent brain DB → degraded, empty roster, no throw", async () => {
    const d = await digest();
    expect(d.degraded).toBe(true);
    expect(d.degraded_reason).toMatch(/not readable/);
    expect(d.instances).toEqual([]);
  });

  it("a brain with no cognition_instances table → degraded with a NAMED reason", async () => {
    mkdirSync(join(tmpRoot, "memory"), { recursive: true });
    const db = new Database(dbFile());
    db.exec(EVENT_LOG_DDL);
    db.close();

    const d = await digest();
    expect(d.degraded).toBe(true);
    // Distinguishable from "no DB at all": one means an old brain build, the
    // other means no brain. Collapsing them hides which remedy applies.
    expect(d.degraded_reason).toMatch(/cognition_instances not present/);
  });

  it("the verb exits 0 on an absent DB", async () => {
    const { runCognition } = await import("../verbs/cognition.js");
    expect(runCognition({ action: "health", json: false })).toBe(0);
  });

  it("an unknown action exits 2", async () => {
    const { runCognition } = await import("../verbs/cognition.js");
    expect(runCognition({ action: "bogus", json: false })).toBe(2);
  });
});

describe("the roster is DERIVED from the projection, never hand-listed (AC #4)", () => {
  it("an instance the CLI has never heard of appears in the digest", async () => {
    seedSchema();
    writeConfig({ roadmap_drift: { enabled: true } });
    // A brand-new extractor id. Nothing in cli/ mentions it.
    seedInstance({ id: "roadmap_drift" });

    const d = await digest();
    expect(d.instances.map((i) => i.id)).toEqual(["roadmap_drift"]);
    const row = pick(d, "roadmap_drift");
    expect(row.component).toBe("cognition.roadmap_drift");
    expect(row.enabled).toBe(true);
    expect(row.output).toBe("suggestions[source_module='roadmap_drift']");
  });

  it("preserves the projection's order (the extractors-barrel order)", async () => {
    seedSchema();
    writeConfig({});
    for (const id of ["zulu", "alpha", "mike"]) seedInstance({ id });
    const d = await digest();
    expect(d.instances.map((i) => i.id)).toEqual(["zulu", "alpha", "mike"]);
  });
});

// ---------------------------------------------------------------------------
// T4 — the legacy namespace literal
// ---------------------------------------------------------------------------

describe("perception's LEGACY namespace is read as a LITERAL (T4, L-857)", () => {
  it("rows under the bare `perception` component are FOUND", async () => {
    seedSchema();
    writeConfig({ perception: { enabled: true } });
    seedInstance({
      id: "perception",
      component: "perception",
      event_prefix: "perception",
      gate_keys: ["cognition.perception.enabled"],
      driver: "session_hook",
      driver_ref: "session_end",
      output: "learnings[review_status='pending_review']",
    });
    seedEvent("perception", "perception.run_started", daysAgo(1));
    seedEvent("perception", "perception.run_succeeded", daysAgo(1));

    const row = pick(await digest(), "perception");
    // A reader deriving `cognition.${id}` finds ZERO rows here and reports
    // `no_signal` for the single healthiest instance — the brief's exact
    // silent-omission failure, in a new form.
    expect(row.last_run_at).not.toBeNull();
    expect(row.last_outcome).toBe("perception.run_succeeded");
    expect(row.status).toBe("ok");
  });

  it("NEGATIVE control: rows under `cognition.perception` are NOT what it reads", async () => {
    seedSchema();
    writeConfig({ perception: { enabled: true } });
    seedInstance({
      id: "perception",
      component: "perception",
      event_prefix: "perception",
      gate_keys: ["cognition.perception.enabled"],
    });
    // Seed ONLY the derived namespace. The declared literal has no rows.
    seedEvent("cognition.perception", "cognition.perception.run_succeeded", daysAgo(1));

    const row = pick(await digest(), "perception");
    expect(row.last_run_at).toBeNull();
    expect(row.status).toBe("no_signal");
  });
});

// ---------------------------------------------------------------------------
// T5/T6 — wedge and upstream blockage
// ---------------------------------------------------------------------------

describe("wedge detection (T5)", () => {
  function seedWedgedJanitor(): void {
    seedSchema();
    writeConfig({ janitor: { enabled: true } });
    seedInstance({
      id: "janitor",
      gate_keys: ["cognition.janitor.enabled"],
      driver: "schedule",
      driver_ref: "janitor_engine",
      output: "suggestions[source_module='janitor']",
    });
    seedSchedule("sch-1", "janitor_engine", { next_run_at: daysAgo(14) });
    seedRun("run-stuck", "sch-1", "running", daysAgo(14.5));
  }

  it("an enabled schedule with an OPEN running run classifies `wedged` with its age", async () => {
    seedWedgedJanitor();
    const row = pick(await digest(), "janitor");
    expect(row.status).toBe("wedged");
    expect(row.schedule?.open_run_id).toBe("run-stuck");
    expect(row.schedule?.open_run_age_days).toBeGreaterThan(14);
    expect(row.schedule?.overdue).toBe(true);
    expect(row.reason).toMatch(/overlap guard/);
  });

  it("clearing the open run drops it out of `wedged` (the positive control)", async () => {
    seedWedgedJanitor();
    withDb((db) => {
      db.prepare(`UPDATE schedule_runs SET status='failed' WHERE id='run-stuck'`).run();
    });
    const row = pick(await digest(), "janitor");
    expect(row.status).not.toBe("wedged");
    expect(row.schedule?.open_run_id).toBeNull();
  });

  it("an absent schedules row is `no_signal` with the bootstrap named, not `wedged`", async () => {
    seedSchema();
    writeConfig({ synapse: { enabled: true } });
    seedInstance({
      id: "synapse",
      gate_keys: ["cognition.synapse.enabled"],
      driver: "schedule",
      driver_ref: "synapse_engine",
    });
    const row = pick(await digest(), "synapse");
    expect(row.status).toBe("no_signal");
    expect(row.reason).toMatch(/no schedules row named synapse_engine/);
  });
});

describe("upstream blockage — the co-driven diagnosis (T6)", () => {
  function seedFamily(janitorRunStatus: string): void {
    seedSchema();
    writeConfig({ janitor: { enabled: true, cluster: { enabled: true } } });
    seedInstance({
      id: "janitor",
      gate_keys: ["cognition.janitor.enabled"],
      driver: "schedule",
      driver_ref: "janitor_engine",
    });
    seedInstance({
      id: "arbiter",
      gate_keys: ["cognition.janitor.enabled"],
      driver: "co_driven",
      driver_ref: "janitor",
    });
    seedSchedule("sch-1", "janitor_engine", { next_run_at: daysAgo(14) });
    seedRun("run-stuck", "sch-1", janitorRunStatus, daysAgo(14.5));
  }

  it("a co_driven instance whose driver is wedged is `blocked_upstream`, NOT `no_signal`", async () => {
    seedFamily("running");
    const d = await digest();
    expect(pick(d, "janitor").status).toBe("wedged");

    const arbiter = pick(d, "arbiter");
    // `no_signal` here would be the brief's own original mistake — it sends the
    // operator to investigate the arbiter when the arbiter is fine and the
    // janitor's schedule is the only thing broken.
    expect(arbiter.status).toBe("blocked_upstream");
    expect(arbiter.reason).toMatch(/runs only inside a janitor run/);
    expect(arbiter.reason).toMatch(/no switch or schedule of its own/);
  });

  it("un-wedging the driver releases the co-driven instance to `no_signal`", async () => {
    seedFamily("failed");
    const d = await digest();
    expect(pick(d, "janitor").status).not.toBe("wedged");
    // Still silent, but now for its OWN reason rather than the driver's — which
    // is a different remedy and must read differently.
    expect(pick(d, "arbiter").status).toBe("no_signal");
  });

  it("a co_driven instance whose driver is HEALTHY is judged on its own signal", async () => {
    seedFamily("success");
    seedEvent("cognition.janitor", "cognition.janitor.run_succeeded", daysAgo(1));
    seedEvent("cognition.arbiter", "cognition.arbiter.run_succeeded", daysAgo(1));
    const d = await digest();
    expect(pick(d, "janitor").status).toBe("ok");
    expect(pick(d, "arbiter").status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// T7 — host scoping
// ---------------------------------------------------------------------------

describe("host scoping — a foreign success does not render a local wedge green (T7)", () => {
  it("a FOREIGN-host run_succeeded surfaces only as last_run_any_host", async () => {
    seedSchema();
    writeConfig({ janitor: { enabled: true } });
    seedInstance({
      id: "janitor",
      gate_keys: ["cognition.janitor.enabled"],
      driver: "schedule",
      driver_ref: "janitor_engine",
    });
    seedSchedule("sch-1", "janitor_engine", { next_run_at: daysAgo(3) });
    seedRun("run-stuck", "sch-1", "running", daysAgo(3.2));
    // `event_log` is a SYNC table — a VPS run replicates into this DB.
    seedEvent("cognition.janitor", "cognition.janitor.run_succeeded", daysAgo(1), FOREIGN);

    const row = pick(await digest(), "janitor");
    expect(row.status).toBe("wedged");
    expect(row.last_run_at).toBeNull();
    expect(row.last_run_any_host).not.toBeNull();
  });

  it("today's run count is scoped to this host too", async () => {
    seedSchema();
    writeConfig({ synapse: { enabled: true } });
    seedInstance({ id: "synapse", gate_keys: ["cognition.synapse.enabled"] });
    const now = new Date().toISOString();
    seedEvent("cognition.synapse", "cognition.synapse.run_started", now, HOST);
    seedEvent("cognition.synapse", "cognition.synapse.run_started", now, FOREIGN);
    seedEvent("cognition.synapse", "cognition.synapse.run_started", now, FOREIGN);

    expect(pick(await digest(), "synapse").runs_today).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T8 — no_signal is first-class
// ---------------------------------------------------------------------------

describe("`no_signal` is distinct from `disabled` and from `ok` (T8)", () => {
  beforeEach(() => {
    seedSchema();
  });

  it("enabled with zero events → no_signal, naming the retention window", async () => {
    writeConfig({ curator: { enabled: true } });
    seedInstance({ id: "curator", gate_keys: ["cognition.curator.enabled"] });
    const row = pick(await digest(), "curator");
    expect(row.status).toBe("no_signal");
    expect(row.enabled).toBe(true);
    // The reason must say WHY absence is not proof — the 30-day purge means
    // "stopped" and "never existed" are indistinguishable from event_log alone.
    expect(row.reason).toMatch(/NOT 'never ran'/);
    expect(row.reason).toMatch(/30 days/);
  });

  it("gate absent → disabled, with the offending key named", async () => {
    writeConfig({});
    seedInstance({ id: "curator", gate_keys: ["cognition.curator.enabled"] });
    const row = pick(await digest(), "curator");
    expect(row.status).toBe("disabled");
    expect(row.enabled).toBe(false);
    expect(row.disabled_by).toBe("cognition.curator.enabled");
  });

  it("a terminal success → ok", async () => {
    writeConfig({ curator: { enabled: true } });
    seedInstance({ id: "curator", gate_keys: ["cognition.curator.enabled"] });
    seedEvent("cognition.curator", "cognition.curator.run_succeeded", daysAgo(1));
    expect(pick(await digest(), "curator").status).toBe("ok");
  });

  it("a terminal SKIP is `ok` — skipping is a normal outcome, not a fault", async () => {
    writeConfig({ curator: { enabled: true } });
    seedInstance({ id: "curator", gate_keys: ["cognition.curator.enabled"] });
    seedEvent("cognition.curator", "cognition.curator.run_skipped", daysAgo(1));
    expect(pick(await digest(), "curator").status).toBe("ok");
  });

  it("a terminal failure with no later success → failing", async () => {
    writeConfig({ synapse: { enabled: true } });
    seedInstance({ id: "synapse", gate_keys: ["cognition.synapse.enabled"] });
    seedEvent("cognition.synapse", "cognition.synapse.run_failed", daysAgo(2));
    const row = pick(await digest(), "synapse");
    expect(row.status).toBe("failing");
    expect(row.last_outcome).toBe("cognition.synapse.run_failed");
  });

  it("a LATER success clears `failing` — the latest terminal wins", async () => {
    writeConfig({ synapse: { enabled: true } });
    seedInstance({ id: "synapse", gate_keys: ["cognition.synapse.enabled"] });
    seedEvent("cognition.synapse", "cognition.synapse.run_failed", daysAgo(2));
    seedEvent("cognition.synapse", "cognition.synapse.run_succeeded", daysAgo(1));
    expect(pick(await digest(), "synapse").status).toBe("ok");
  });

  it("orders MIXED timestamp formats correctly (space-form vs ISO-form)", async () => {
    // Measured on a live brain: `event_log.created_at` carries BOTH
    // 'YYYY-MM-DD HH:MM:SS' and ISO '…THH:MM:SS.sssZ'. Plain string ordering
    // sorts every space-form row before every ISO-form row within a shared
    // date (' ' < 'T'), which would report the OLDER failure as the latest.
    writeConfig({ synapse: { enabled: true } });
    seedInstance({ id: "synapse", gate_keys: ["cognition.synapse.enabled"] });
    seedEvent("cognition.synapse", "cognition.synapse.run_failed", "2026-08-07T01:00:00.000Z");
    seedEvent("cognition.synapse", "cognition.synapse.run_succeeded", "2026-08-07 05:00:00");
    expect(pick(await digest(), "synapse").last_outcome).toBe(
      "cognition.synapse.run_succeeded",
    );
  });
});

// ---------------------------------------------------------------------------
// Gates: the cartographer's declared conjunction
// ---------------------------------------------------------------------------

describe("the gate CONJUNCTION is declared, not branched on", () => {
  beforeEach(() => {
    seedSchema();
    seedInstance({
      id: "cartographer",
      gate_keys: ["cognition.janitor.enabled", "cognition.janitor.cluster.enabled"],
      driver: "co_driven",
      driver_ref: "janitor",
      output: "suggestions[source_module='cartographer']",
    });
  });

  it("janitor ON + cluster OFF → disabled, naming the CLUSTER key", async () => {
    writeConfig({ janitor: { enabled: true, cluster: { enabled: false } } });
    const row = pick(await digest(), "cartographer");
    expect(row.status).toBe("disabled");
    // Naming WHICH gate is what makes the verdict actionable: the two gates
    // have completely different remedies.
    expect(row.disabled_by).toBe("cognition.janitor.cluster.enabled");
  });

  it("janitor OFF → disabled, naming the JANITOR key (first failing gate wins)", async () => {
    writeConfig({ janitor: { enabled: false, cluster: { enabled: true } } });
    expect(pick(await digest(), "cartographer").disabled_by).toBe(
      "cognition.janitor.enabled",
    );
  });

  it("both ON → enabled", async () => {
    writeConfig({ janitor: { enabled: true, cluster: { enabled: true } } });
    const row = pick(await digest(), "cartographer");
    expect(row.enabled).toBe(true);
    expect(row.disabled_by).toBeNull();
  });

  it("a non-boolean truthy value does NOT satisfy a gate", async () => {
    writeConfig({ janitor: { enabled: "yes", cluster: { enabled: true } } });
    expect(pick(await digest(), "cartographer").enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T9 — duplicate schedules
// ---------------------------------------------------------------------------

describe("duplicate schedule rows are surfaced (T9)", () => {
  beforeEach(() => {
    seedSchema();
    writeConfig({ subconscious: { enabled: true } });
    seedInstance({
      id: "subconscious",
      gate_keys: ["cognition.subconscious.enabled"],
      driver: "schedule",
      driver_ref: "subconscious_engine",
    });
  });

  it("ONE row raises no warning (the negative control)", async () => {
    seedSchedule("sch-a", "subconscious_engine");
    const d = await digest();
    expect(d.warnings).toEqual([]);
    expect(pick(d, "subconscious").schedule?.rows).toBe(1);
  });

  it("TWO rows sharing a name raise a warning naming the count", async () => {
    seedSchedule("sch-a", "subconscious_engine");
    seedSchedule("sch-b", "subconscious_engine", { enabled: 0 });
    const d = await digest();
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toMatch(/duplicate schedule rows named subconscious_engine \(2\)/);
    expect(pick(d, "subconscious").schedule?.rows).toBe(2);
    // ANY enabled row means the schedule is live, so a disabled duplicate must
    // not mask an enabled one.
    expect(pick(d, "subconscious").schedule?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Output counts
// ---------------------------------------------------------------------------

describe("output destination counts", () => {
  beforeEach(() => {
    seedSchema();
    writeConfig({ janitor: { enabled: true }, perception: { enabled: true } });
  });

  it("counts rows matching a declared `table[column='value']` predicate", async () => {
    seedInstance({
      id: "arbiter",
      gate_keys: ["cognition.janitor.enabled"],
      output: "suggestions[source_module='arbiter']",
    });
    withDb((db) => {
      const ins = db.prepare(
        `INSERT INTO suggestions (source_module, title) VALUES (?, ?)`,
      );
      ins.run("arbiter", "a");
      ins.run("arbiter", "b");
      ins.run("curator", "c"); // must NOT be counted
    });
    expect(pick(await digest(), "arbiter").output_rows).toBe(2);
  });

  it("counts perception's learnings predicate", async () => {
    seedInstance({
      id: "perception",
      component: "perception",
      event_prefix: "perception",
      gate_keys: ["cognition.perception.enabled"],
      output: "learnings[review_status='pending_review']",
    });
    withDb((db) => {
      const ins = db.prepare(`INSERT INTO learnings (title, review_status) VALUES (?, ?)`);
      ins.run("a", "pending_review");
      ins.run("b", "approved");
    });
    expect(pick(await digest(), "perception").output_rows).toBe(1);
  });

  it("an UNCOUNTABLE declaration reports null rather than a misleading number", async () => {
    seedInstance({
      id: "subconscious",
      gate_keys: ["cognition.subconscious.enabled"],
      output: "suggestions[source_module=LLM-named, type_inferred=1]",
    });
    const row = pick(await digest(), "subconscious");
    expect(row.output_rows).toBeNull();
    // The declaration itself is still surfaced verbatim — the operator can act
    // on prose even where the count cannot be derived.
    expect(row.output).toMatch(/LLM-named/);
  });

  it("refuses a table outside the allowlist", async () => {
    seedInstance({ id: "sneaky", output: "sqlite_master[name='learnings']" });
    expect(pick(await digest(), "sneaky").output_rows).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T11 — the verb performs ZERO writes
// ---------------------------------------------------------------------------

describe("the digest performs ZERO writes (T11)", () => {
  it("leaves the DB file byte-identical, and the read is non-vacuous", async () => {
    seedSchema();
    writeConfig({ janitor: { enabled: true }, perception: { enabled: true } });
    seedInstance({
      id: "janitor",
      gate_keys: ["cognition.janitor.enabled"],
      driver: "schedule",
      driver_ref: "janitor_engine",
    });
    seedInstance({
      id: "perception",
      component: "perception",
      event_prefix: "perception",
      gate_keys: ["cognition.perception.enabled"],
      output: "learnings[review_status='pending_review']",
    });
    seedSchedule("sch-1", "janitor_engine", { next_run_at: daysAgo(1) });
    seedEvent("perception", "perception.run_succeeded", daysAgo(1));
    withDb((db) => {
      db.prepare(`INSERT INTO learnings (title, review_status) VALUES ('x','pending_review')`).run();
    });

    const before = {
      sha: createHash("sha256").update(readFileSync(dbFile())).digest("hex"),
      mtimeMs: statSync(dbFile()).mtimeMs,
      size: statSync(dbFile()).size,
    };

    const d = await digest();

    const after = {
      sha: createHash("sha256").update(readFileSync(dbFile())).digest("hex"),
      mtimeMs: statSync(dbFile()).mtimeMs,
      size: statSync(dbFile()).size,
    };

    expect(after.sha).toBe(before.sha);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);

    // POSITIVE CONTROL (the FR-245 lesson). "No writes" is trivially true of a
    // run that read nothing. The same run must have produced real signal, or
    // the assertions above are vacuous.
    expect(d.degraded).toBe(false);
    expect(d.instances.length).toBeGreaterThan(0);
    expect(d.instances.some((i) => i.last_run_at !== null)).toBe(true);
    expect(d.instances.some((i) => i.output_rows !== null && i.output_rows > 0)).toBe(true);
    expect(d.instances.some((i) => i.schedule !== null)).toBe(true);
    expect(d.event_log_oldest_at).not.toBeNull();
  });

  it("does not create a -wal sidecar on a delete-mode brain", async () => {
    seedSchema();
    writeConfig({ janitor: { enabled: true } });
    seedInstance({ id: "janitor", gate_keys: ["cognition.janitor.enabled"] });

    await digest();

    // `journal_mode` stays whatever the operator had. A read-only door that
    // flipped it to WAL would leave sidecar files behind — TD-319's finding.
    const db = new Database(dbFile(), { readonly: true });
    expect(String(db.pragma("journal_mode", { simple: true }))).toBe("delete");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// gate_default — the ONE exception to "an absent key means off"
// ---------------------------------------------------------------------------

describe("an absent gate key resolves to the instance's DECLARED default", () => {
  beforeEach(() => {
    seedSchema();
    // A config with a `cognition` block that says nothing about either instance.
    // NOTE this is NOT the fresh-install shape — `igris install` WRITES
    // `perception.enabled: false` (FR-191). This is the pre-FR-191 /
    // hand-edited / no-config.json shape, which is precisely the population
    // `gate_default` exists for.
    writeConfig({});
  });

  it("gate_default=true → an absent key means ENABLED (perception's shape)", async () => {
    seedInstance({
      id: "perception",
      component: "perception",
      event_prefix: "perception",
      gate_keys: ["cognition.perception.enabled"],
      gate_default: true,
    });
    seedEvent("perception", "perception.run_succeeded", daysAgo(1));

    const row = pick(await digest(), "perception");
    // A reader that hard-codes the documented "absent means false" convention
    // reports a config the installer never touched as `disabled` while it is
    // extracting — a second instance of the same silent-omission class as
    // deriving its namespace. (Not the shipped posture: install writes it off.)
    expect(row.enabled).toBe(true);
    expect(row.disabled_by).toBeNull();
    expect(row.status).toBe("ok");
  });

  it("gate_default=false → an absent key means DISABLED (everyone else's shape)", async () => {
    seedInstance({
      id: "janitor",
      gate_keys: ["cognition.janitor.enabled"],
      gate_default: false,
    });
    const row = pick(await digest(), "janitor");
    expect(row.enabled).toBe(false);
    expect(row.disabled_by).toBe("cognition.janitor.enabled");
  });

  it("an EXPLICIT false overrides a true default — the operator's word wins", async () => {
    seedInstance({
      id: "perception",
      component: "perception",
      event_prefix: "perception",
      gate_keys: ["cognition.perception.enabled"],
      gate_default: true,
    });
    writeConfig({ perception: { enabled: false } });
    const row = pick(await digest(), "perception");
    expect(row.enabled).toBe(false);
    expect(row.status).toBe("disabled");
  });

  it("the default is SURFACED in the digest, not just applied", async () => {
    seedInstance({ id: "perception", gate_default: true });
    seedInstance({ id: "janitor", gate_default: false });
    const d = await digest();
    expect(pick(d, "perception").gate_default).toBe(true);
    expect(pick(d, "janitor").gate_default).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Older roster shapes degrade, they do not throw
// ---------------------------------------------------------------------------

describe("a roster projected by an OLDER brain build degrades, it never throws", () => {
  it("a cognition_instances table with no gate_default column still renders", async () => {
    // A brain that projected its roster before `gate_default` existed is a real
    // state, not a hypothetical: the CLI and the brain ship as one package but
    // are not upgraded atomically on a running machine. SELECTing the absent
    // column would throw and take the whole digest with it.
    mkdirSync(join(tmpRoot, "memory"), { recursive: true });
    const db = new Database(dbFile());
    db.exec(`
      CREATE TABLE cognition_instances (
        id TEXT PRIMARY KEY, component TEXT NOT NULL, event_prefix TEXT NOT NULL,
        gate_keys TEXT NOT NULL, driver TEXT NOT NULL, driver_ref TEXT,
        output TEXT NOT NULL, registered_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO cognition_instances (id, component, event_prefix, gate_keys, driver, driver_ref, output)
      VALUES ('janitor', 'cognition.janitor', 'cognition.janitor',
              '["cognition.janitor.enabled"]', 'manual', NULL, 'nothing');
    `);
    db.close();
    writeConfig({ janitor: { enabled: true } });

    const d = await digest();
    expect(d.instances.map((i) => i.id)).toEqual(["janitor"]);
    expect(pick(d, "janitor").enabled).toBe(true);
    // Degraded is FALSE — the roster is readable and every verdict below is
    // sound. What is reported instead is the specific loss, so a perception row
    // read from such a table is not silently mis-gated.
    expect(d.degraded).toBe(false);
    // The loss is a WARNING, not a degradation: every verdict is still computed
    // and the operator is told which input was reduced. Folding it into
    // `degraded` would blank the whole surface over a partial loss.
    expect(d.degraded_reason).toBeNull();
    expect(d.warnings.some((w) => /predates the gate_default column/.test(w))).toBe(true);
    expect(pick(d, "janitor").gate_default).toBe(false);
  });
});
