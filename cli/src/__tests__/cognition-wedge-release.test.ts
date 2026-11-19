/**
 * TD-361 AC-6 — the health surface and the repair, verified against each other.
 *
 * `igris cognition health` (TD-327) REPORTS a wedge; TD-361's owner-liveness
 * sweep RELEASES one. This suite drives both over the same sandbox brain:
 *
 *   BEFORE  the digest reads the reality fixture (the two 2026-09-24 stuck runs,
 *           harvested read-only from the pre-unwedge snapshot) as `wedged`;
 *   ARM     a CHILD process boots the VENDORED engine with `schedules` ENABLED
 *           and shuts it down at once. The sweep runs synchronously inside the
 *           schedules component's `init`, so no tick and no handler ever run —
 *           the release is the sweep's alone;
 *   AFTER   neither instance is `wedged` and both rows read `failed` with the
 *           `abandoned:` prefix.
 *
 * H2 is the positive control that the repair did not blind the surface: a run
 * owned by a LIVE process is left open, so the digest still sees it. H3 is the
 * TD-327 byte witness, scoped to the READS (the arm is a writer by design).
 *
 * WHY A CHILD PROCESS. `db.ts#setAdapter` is a module global (FR-241 Phase-0
 * step 7): a second engine in this process would dispatch against another
 * engine's DB. Each arm gets its own module registry and its own brain file.
 *
 * STALENESS. The arm boots `cli/dist/brain-mcp-server` — the BUILT bundle, not
 * `brain-mcp-server/src`. A stale bundle reads a stale schema (test_standards
 * §6, BR-102), so this suite asserts the bundle is PRESENT (never skips) and
 * must be run after `cd cli && npm run build`. Against a HEAD bundle, H1's
 * AFTER is `wedged`: that is its RED.
 *
 * FENCE. `HOME` and `IGRIS_BRAIN_DIR` via `fenceHome()` (BR-106), and both are
 * passed EXPLICITLY into every child: the children's config readers resolve
 * `homedir()`, and a sandbox with no `remote_brain` makes auto-push inert.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_MODULE_REL, resolveBundleModule } from "../lib/brain-bridge.js";
import { fenceHome, type HomeFence } from "./home-fence.js";
import type { CognitionHealthDigest, CognitionInstanceHealth } from "../types.js";

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_PATH = join(
  CLI_ROOT, "..", "brain-mcp-server", "src", "engine", "components", "schedules",
  "__tests__", "fixtures", "td361-wedge-rows.json",
);
const ENGINE_JS = resolveBundleModule(ENGINE_MODULE_REL);
const SQLITE_JS = resolveBundleModule("engine/storage/sqlite.js");
const SCHEDULES_SCHEMA_JS = resolveBundleModule("engine/components/schedules/schema.js");
const SANDBOX_MACHINE_ID = "td361-cli-sandbox";
const ARM_TIMEOUT_MS = 60_000;

interface Fixture {
  schedules: Record<string, unknown>[];
  schedule_runs: Record<string, unknown>[];
}
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;

interface RosterRow {
  id: string;
  gate_keys: string;
  driver: string;
  driver_ref: string | null;
}

let fence: HomeFence;
let dbFile: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  fence = fenceHome("td361-wedge-release-");
  mkdirSync(join(fence.brainDir, "memory"), { recursive: true });
  dbFile = join(fence.brainDir, "memory", "knowledge.db");
});

afterEach(async () => {
  (await import("../lib/brain-db.js")).closeDb();
  while (children.length) {
    const c = children.pop()!;
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }
  fence.release();
});

// ---------------------------------------------------------------------------
// Child arms
// ---------------------------------------------------------------------------

/**
 * Boot the vendored engine in a child. `migrate` = the FR-241 throwaway boot
 * with `schedules` DISABLED (schema only, no daemon) that reports the roster;
 * `release` = `schedules` ENABLED, then an immediate shutdown.
 */
function runArm(mode: "migrate" | "release"): RosterRow[] {
  fence.assertArmed();
  const src = String.raw`
import D from "better-sqlite3";
const DB = process.env.TD361_DB;
const { bootEngine } = await import(process.env.ENGINE_JS);
if (process.env.TD361_MODE === "migrate") {
  new D(DB).close();
  bootEngine({ dbPath: DB, components: { schedules: { enabled: false } } }).shutdown();
  // A DISABLED component runs no migrations, so the schedules chain is applied
  // here through the vendored adapter — the real chain, with no daemon started.
  const { createSqliteAdapter } = await import(process.env.SQLITE_JS);
  const { scheduleMigrations } = await import(process.env.SCHEDULES_SCHEMA_JS);
  const s = createSqliteAdapter(DB);
  s.runMigrations("schedules", scheduleMigrations);
  s.close();
  const c = new D(DB, { readonly: true });
  const roster = c.prepare("SELECT id, gate_keys, driver, driver_ref FROM cognition_instances").all();
  c.close();
  process.stdout.write("@@ROSTER@@" + JSON.stringify(roster) + "@@END@@");
} else {
  bootEngine({ dbPath: DB, components: {} }).shutdown();
  process.stdout.write("@@ROSTER@@[]@@END@@");
}
`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", src], {
    cwd: CLI_ROOT,
    env: {
      ...process.env,
      ENGINE_JS: `file://${ENGINE_JS}`,
      SQLITE_JS: `file://${SQLITE_JS}`,
      SCHEDULES_SCHEMA_JS: `file://${SCHEDULES_SCHEMA_JS}`,
      TD361_MODE: mode,
      TD361_DB: dbFile,
      HOME: fence.home,
      IGRIS_BRAIN_DIR: fence.brainDir,
      IGRIS_DB_PATH: dbFile,
      IGRIS_PIDS_DIR: join(fence.brainDir, "brain-mcp-server.pids"),
    },
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: ARM_TIMEOUT_MS,
  });
  const m = /@@ROSTER@@([\s\S]*?)@@END@@/.exec(out);
  if (m === null) throw new Error(`arm ${mode} produced no payload:\n${out.slice(-2000)}`);
  return JSON.parse(m[1]!) as RosterRow[];
}

/** Every roster gate `true`, plus the sandbox machine identity. */
function writeConfig(roster: RosterRow[]): void {
  const cfg: Record<string, unknown> = {
    version: "7.0.0",
    machine: { id: SANDBOX_MACHINE_ID, aliases: [hostname()] },
  };
  for (const row of roster) {
    for (const key of JSON.parse(row.gate_keys) as string[]) {
      const parts = key.split(".");
      let node = cfg;
      for (const p of parts.slice(0, -1)) {
        node[p] = (node[p] as Record<string, unknown> | undefined) ?? {};
        node = node[p] as Record<string, unknown>;
      }
      node[parts[parts.length - 1]!] = true;
    }
  }
  writeFileSync(join(fence.brainDir, "config.json"), JSON.stringify(cfg));
}

function insertRow(db: Database.Database, table: string, row: Record<string, unknown>): void {
  const have = new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name));
  const cols = Object.keys(row).filter((c) => have.has(c));
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...cols.map((c) => row[c]));
}

async function digest(): Promise<CognitionHealthDigest> {
  const { buildCognitionHealthDigest } = await import("../verbs/cognition.js");
  const d = buildCognitionHealthDigest({
    identity: { machine_id: SANDBOX_MACHINE_ID, hostname: hostname(), aliases: [hostname()] },
  });
  (await import("../lib/brain-db.js")).closeDb();
  return d;
}

function pick(d: CognitionHealthDigest, id: string): CognitionInstanceHealth {
  const row = d.instances.find((i) => i.id === id);
  if (row === undefined) throw new Error(`instance ${id} absent from digest`);
  return row;
}

/**
 * The TD-327 T11 witness: the main file's sha + size + mtime, PLUS the WAL's
 * size. A read-only open of a WAL-mode brain may CREATE an empty `-wal`
 * sidecar (measured on the first run of this file: 0 bytes), which is not a
 * write; a WAL that GROWS would be one.
 */
function stamp(): string {
  const main = `${createHash("sha256").update(readFileSync(dbFile)).digest("hex")}:${statSync(dbFile).size}:${statSync(dbFile).mtimeMs}`;
  const wal = `${dbFile}-wal`;
  return `${main}|wal:${existsSync(wal) ? statSync(wal).size : 0}`;
}

/**
 * The fixture's two schedules (verbatim) plus an INERT `janitor_engine` row, so
 * none of the three `engine.ready` bootstraps dispatches a create. A create
 * would resume AFTER the arm's immediate `shutdown()` and dereference the
 * destroyed component's null `_ctx` (a pre-existing bootstrap defect, out of
 * TD-361's scope) — killing the arm for a reason unrelated to the sweep.
 */
function seedSchedules(db: Database.Database, names: string[]): void {
  for (const s of FIXTURE.schedules) {
    if (names.includes(s.name as string)) insertRow(db, "schedules", s);
  }
  insertRow(db, "schedules", {
    id: "sch-td361-janitor", name: "janitor_engine", cron_expr: "0 4 * * *",
    handler_type: "noop", enabled: 0,
  });
}

/** The instance whose schedule is `name`, derived from the roster (never hand-listed). */
function instanceFor(roster: RosterRow[], name: string): string {
  const row = roster.find((r) => r.driver === "schedule" && r.driver_ref === name);
  if (row === undefined) throw new Error(`no schedule-driven roster row for ${name}`);
  return row.id;
}

// ---------------------------------------------------------------------------

describe("TD-361 — the health surface and the repair verified against each other (AC-6)", () => {
  it("the vendored engine bundle is present (a stale or absent bundle is RED, never skipped)", () => {
    expect(ENGINE_JS).not.toBeNull();
    expect(SQLITE_JS).not.toBeNull();
    expect(SCHEDULES_SCHEMA_JS).not.toBeNull();
  });

  it("H1 + H3: BEFORE reads both fixture wedges; the release arm frees both; the reads never write", async () => {
    const roster = runArm("migrate");
    writeConfig(roster);
    const db = new Database(dbFile);
    seedSchedules(db, ["synapse_engine", "subconscious_engine"]);
    for (const r of FIXTURE.schedule_runs) insertRow(db, "schedule_runs", r);
    db.close();
    const synapse = instanceFor(roster, "synapse_engine");
    const subconscious = instanceFor(roster, "subconscious_engine");

    const s0 = stamp();
    const before = await digest();
    expect(stamp()).toBe(s0); // H3: the read is read-only
    expect(pick(before, synapse).status).toBe("wedged");
    expect(pick(before, subconscious).status).toBe("wedged");
    expect(pick(before, synapse).schedule?.open_run_id).toBe("run-d581ce72");
    expect(pick(before, subconscious).schedule?.open_run_id).toBe("run-f5f17e9c");

    runArm("release");

    const s1 = stamp();
    const after = await digest();
    expect(stamp()).toBe(s1); // H3 again, around the second read only
    for (const id of [synapse, subconscious]) {
      expect(pick(after, id).status).not.toBe("wedged");
      expect(pick(after, id).schedule?.open_run_id).toBeNull();
    }

    const check = new Database(dbFile, { readonly: true });
    const rows = check.prepare(
      "SELECT id, status, error FROM schedule_runs WHERE id IN ('run-d581ce72','run-f5f17e9c') ORDER BY id",
    ).all() as { id: string; status: string; error: string | null }[];
    check.close();
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    for (const r of rows) expect(r.error).toMatch(/^abandoned:.*legacy_predates_live_processes/);
  }, ARM_TIMEOUT_MS * 3);

  it("H2 (positive control): a run owned by a LIVE process is NOT released — the surface still sees it", async () => {
    const roster = runArm("migrate");
    writeConfig(roster);
    const owner = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
    children.push(owner);
    const ownerStart = execFileSync("ps", ["-p", String(owner.pid), "-o", "lstart="], { encoding: "utf-8" }).trim();
    const db = new Database(dbFile);
    seedSchedules(db, ["synapse_engine", "subconscious_engine"]);
    insertRow(db, "schedule_runs", {
      id: "run-td361-live",
      schedule_id: "sch-90302d0b",
      status: "running",
      started_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      attempt: 1,
      machine_id: SANDBOX_MACHINE_ID,
      machine_hostname: hostname(),
      owner_pid: owner.pid,
      owner_started_at: ownerStart,
    });
    db.close();
    const synapse = instanceFor(roster, "synapse_engine");

    expect(pick(await digest(), synapse).status).toBe("wedged");
    runArm("release");
    const after = pick(await digest(), synapse);
    expect(after.status).toBe("wedged");
    expect(after.schedule?.open_run_id).toBe("run-td361-live");
  }, ARM_TIMEOUT_MS * 3);
});
