/**
 * FR-268 — `igris ceremony start|stop`: the brain-timed ceremony stamp.
 *
 * Real seeded brain DB via IGRIS_BRAIN_DIR (the `instance-verb.test.ts` idiom
 * — never a mock); the DDL is the instances migration v4 shape VERBATIM.
 * Every assertion reads the ROW back (test_standards rule 1): `created_at`
 * is the DB clock, `duration_ms` is SQL-computed from the paired open start,
 * and the digest must echo the row, never an intermediate value.
 *
 * Red-first: this file was run before `verbs/ceremony.ts` and
 * `brain-db.ts#ceremonyEventWrite` existed (module resolution red, quoted in
 * the FR-268 report), then green.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
let savedEnv: NodeJS.ProcessEnv;

const SLUG = "demo";

/** instances migration v4 (brain-mcp-server/src/engine/components/instances/index.ts), verbatim. */
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
    FROM ceremony_events e WHERE e.event_type = 'stop';
`;

interface Row {
  id: number;
  project: string;
  ceremony: string;
  event_type: string;
  machine_hostname: string;
  instance_id: string | null;
  brief_id: string | null;
  duration_ms: number | null;
  metadata: string;
  created_at: string;
}

interface Digest {
  degraded: boolean;
  ceremony?: string;
  event_type?: string;
  project?: string;
  id?: number | null;
  created_at?: string | null;
  paired?: boolean | null;
  paired_start_id?: number | null;
  duration_ms?: number | null;
  warnings?: string[];
  skipped?: string[];
}

function dbFile(): string {
  return join(tmpRoot, "memory", "knowledge.db");
}

function withDb<T>(fn: (db: Database.Database) => T): T {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function seedSchema(): void {
  withDb((db) => db.exec(CEREMONY_DDL));
}

function rows(): Row[] {
  return withDb((db) => db.prepare("SELECT * FROM ceremony_events ORDER BY id").all() as Row[]);
}

function seedStart(project: string, ceremony: string, host: string, createdAtSql: string): number {
  return withDb((db) => {
    const info = db
      .prepare(
        `INSERT INTO ceremony_events (project, ceremony, event_type, machine_hostname, created_at)
         VALUES (?, ?, 'start', ?, ${createdAtSql})`,
      )
      .run(project, ceremony, host);
    return Number(info.lastInsertRowid);
  });
}

async function run(opts: Record<string, unknown>): Promise<{ code: number; digest: Digest | null; stderr: string }> {
  const { runCeremony } = await import("../verbs/ceremony.js");
  const out: string[] = [];
  const err: string[] = [];
  const spyOut = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  let code: number;
  try {
    code = runCeremony(opts as never);
  } finally {
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
  const text = out.join("").trim();
  return { code, digest: text ? (JSON.parse(text) as Digest) : null, stderr: err.join("") };
}

async function closeBrainDb(): Promise<void> {
  (await import("../lib/brain-db.js")).closeDb();
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-ceremony-"));
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
});

afterEach(async () => {
  await closeBrainDb();
  process.env = savedEnv;
  vi.restoreAllMocks();
});

describe("igris ceremony — the brain-timed ceremony stamp (FR-268)", () => {
  it("(a) start writes a row whose created_at is the DB clock, and the digest echoes the row", async () => {
    seedSchema();
    const { code, digest } = await run({ action: "start", name: "boot", project: SLUG, instanceId: "inst-1" });
    expect(code).toBe(0);

    const all = rows();
    expect(all).toHaveLength(1);
    const row = all[0];
    expect(row).toMatchObject({
      project: SLUG,
      ceremony: "boot",
      event_type: "start",
      machine_hostname: hostname(),
      instance_id: "inst-1",
      brief_id: null,
      duration_ms: null,
      metadata: "{}",
    });
    // The DB clock, not the caller's: within ±2 s of the SAME handle's datetime('now').
    const now = withDb((db) => (db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t);
    const skew = Math.abs(Date.parse(`${row.created_at}Z`) - Date.parse(`${now}Z`));
    expect(skew).toBeLessThanOrEqual(2_000);

    expect(digest).toEqual({
      degraded: false,
      ceremony: "boot",
      event_type: "start",
      project: SLUG,
      id: row.id,
      created_at: row.created_at,
      paired: null,
      paired_start_id: null,
      duration_ms: null,
      warnings: [],
      skipped: [],
    });
  });

  it("(b) stop pairs with the open start; duration_ms is SQL-computed and read back from the row", async () => {
    seedSchema();
    const startId = seedStart(SLUG, "boot", hostname(), "datetime('now', '-90 seconds')");
    const { code, digest } = await run({ action: "stop", name: "boot", project: SLUG, instanceId: "inst-1" });
    expect(code).toBe(0);

    const stop = rows().find((r) => r.event_type === "stop");
    expect(stop).toBeDefined();
    expect(stop!.duration_ms).not.toBeNull();
    expect(stop!.duration_ms as number).toBeGreaterThanOrEqual(88_000);
    expect(stop!.duration_ms as number).toBeLessThanOrEqual(92_000);
    expect(stop!.instance_id).toBe("inst-1");

    expect(digest).toMatchObject({
      degraded: false,
      event_type: "stop",
      id: stop!.id,
      created_at: stop!.created_at,
      paired: true,
      paired_start_id: startId,
      duration_ms: stop!.duration_ms,
      warnings: [],
    });
    // The view derives minutes / started_at from the same row.
    const view = withDb((db) => db.prepare("SELECT minutes, started_at FROM ceremony_runs").get() as { minutes: number; started_at: string });
    expect(view.minutes).toBe(1.5);
    expect(view.started_at).not.toBeNull();
  });

  it("(c) stop with no open start writes the row with duration NULL, paired:false and a warning", async () => {
    seedSchema();
    const { code, digest } = await run({ action: "stop", name: "rest", project: SLUG });
    expect(code).toBe(0);

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].event_type).toBe("stop");
    expect(all[0].duration_ms).toBeNull(); // NULL, never 0
    expect(digest).toMatchObject({ degraded: false, paired: false, paired_start_id: null, duration_ms: null });
    expect(digest!.warnings).toEqual([`unpaired stop — no open start for rest in ${SLUG} on this host`]);
  });

  it("(d) a second stop after a stop pairs with nothing", async () => {
    seedSchema();
    seedStart(SLUG, "boot", hostname(), "datetime('now', '-90 seconds')");
    const first = await run({ action: "stop", name: "boot", project: SLUG });
    expect(first.digest!.paired).toBe(true);
    const second = await run({ action: "stop", name: "boot", project: SLUG });
    expect(second.code).toBe(0);
    expect(second.digest!.paired).toBe(false);

    const stops = rows().filter((r) => r.event_type === "stop");
    expect(stops).toHaveLength(2);
    expect(stops[0].duration_ms).not.toBeNull();
    expect(stops[1].duration_ms).toBeNull();
  });

  it("(e) two projects and two hosts pair independently", async () => {
    seedSchema();
    const otherHost = seedStart(SLUG, "boot", "some-other-host", "datetime('now', '-300 seconds')");
    const otherProject = seedStart("other-proj", "boot", hostname(), "datetime('now', '-200 seconds')");
    const mine = seedStart(SLUG, "boot", hostname(), "datetime('now', '-60 seconds')");

    const { digest } = await run({ action: "stop", name: "boot", project: SLUG });
    expect(digest!.paired).toBe(true);
    expect(digest!.paired_start_id).toBe(mine);
    expect(digest!.paired_start_id).not.toBe(otherHost);
    expect(digest!.paired_start_id).not.toBe(otherProject);
    expect(digest!.duration_ms as number).toBeGreaterThanOrEqual(58_000);
    expect(digest!.duration_ms as number).toBeLessThanOrEqual(62_000);

    // The other host's and the other project's starts are still open.
    const open = withDb((db) =>
      db.prepare(
        `SELECT s.id FROM ceremony_events s WHERE s.event_type = 'start' AND NOT EXISTS (
           SELECT 1 FROM ceremony_events e WHERE e.event_type = 'stop' AND e.project = s.project
             AND e.ceremony = s.ceremony AND e.machine_hostname = s.machine_hostname AND e.id > s.id)
         ORDER BY s.id`,
      ).all() as { id: number }[],
    ).map((r) => r.id);
    expect(open).toEqual([otherHost, otherProject]);
  });

  it("(f) table absent (brain older than v4) -> degraded with the FR-268 skip reason, exit 0, no row", async () => {
    // A present brain DB WITHOUT the ceremony table: create-never means no DDL.
    withDb((db) => db.exec("CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, machine_hostname TEXT NOT NULL)"));
    const { code, digest } = await run({ action: "start", name: "boot", project: SLUG });
    expect(code).toBe(0);
    expect(digest!.degraded).toBe(true);
    expect(digest!.skipped).toEqual([
      "ceremony_events absent — brain older than FR-268 (instances v4); rebuild cli + respawn the brain",
    ]);
    expect(digest!.id).toBeNull();
    const tables = withDb((db) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    expect(tables).not.toContain("ceremony_events"); // the verb never CREATEs
  });

  it("(g) no brain DB -> degraded, exit 0", async () => {
    const { code, digest } = await run({ action: "start", name: "boot", project: SLUG });
    expect(code).toBe(0);
    expect(digest).toMatchObject({ degraded: true, id: null, created_at: null });
    expect(digest!.skipped).toEqual(["brain db absent"]);
  });

  it("(h) unknown --name -> exit 2, no row; unknown action -> exit 2; missing --name -> exit 2", async () => {
    seedSchema();
    const bad = await run({ action: "start", name: "coffee", project: SLUG });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown ceremony name 'coffee'");
    expect(bad.stderr).toContain("boot, rest, register, hunt-init");
    expect(rows()).toHaveLength(0);

    const badAction = await run({ action: "pause", name: "boot", project: SLUG });
    expect(badAction.code).toBe(2);
    expect(badAction.stderr).toContain("unknown ceremony action 'pause'");

    const noName = await run({ action: "start", project: SLUG });
    expect(noName.code).toBe(2);
    expect(rows()).toHaveLength(0);
  });

  it("(i) the slug defaults to the cwd basename, the way `igris instance` derives it", async () => {
    seedSchema();
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/some/where/demo-proj");
    try {
      const { code, digest } = await run({ action: "start", name: "hunt-init", brief: "FR-268" });
      expect(code).toBe(0);
      expect(digest!.project).toBe("demo-proj");
    } finally {
      cwdSpy.mockRestore();
    }
    const row = rows()[0];
    expect(row.project).toBe("demo-proj");
    expect(row.brief_id).toBe("FR-268");
    expect(row.ceremony).toBe("hunt-init");
  });

  it("(j) --project \"\" falls to the cwd basename — an empty slug is never stored", async () => {
    seedSchema();
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/some/where/demo-proj");
    try {
      const { code, digest } = await run({ action: "start", name: "boot", project: "" });
      expect(code).toBe(0);
      expect(digest!.project).toBe("demo-proj");
    } finally {
      cwdSpy.mockRestore();
    }
    expect(rows()[0].project).toBe("demo-proj");
  });
});

// ---------------------------------------------------------------------------
// BR-100 (Phase 4b) — pairing on the machine identity
// ---------------------------------------------------------------------------

describe("BR-100 — ceremony pairing keys on the machine identity, and the stop carries machine_id", () => {
  function addMachineIdColumn(): void {
    withDb((db) => db.exec("ALTER TABLE ceremony_events ADD COLUMN machine_id TEXT"));
  }
  function writeIdentity(machine: unknown): void {
    writeFileSync(join(tmpRoot, "config.json"), JSON.stringify({ machine }) + "\n");
  }

  it("a start under a PRIOR hostname (alias, NULL id) is closed by a stop under the live hostname → paired, duration_ms set, machine_id stamped", async () => {
    seedSchema();
    addMachineIdColumn();
    writeIdentity({ id: "X", aliases: ["MacBookAir"] });
    const startId = seedStart(SLUG, "boot", "MacBookAir", "datetime('now', '-90 seconds')");
    const { code, digest } = await run({ action: "stop", name: "boot", project: SLUG });
    expect(code).toBe(0);
    expect(digest?.paired).toBe(true);
    expect(digest?.paired_start_id).toBe(startId);
    expect(digest?.duration_ms as number).toBeGreaterThanOrEqual(88_000);
    const stop = withDb((db) => db.prepare("SELECT machine_hostname, machine_id FROM ceremony_events WHERE event_type = 'stop'").get() as Record<string, unknown>);
    expect(stop).toEqual({ machine_hostname: hostname(), machine_id: "X" });
    // The writer observed the live hostname: it is now an alias beside the historical one.
    const cfg = JSON.parse(readFileSync(join(tmpRoot, "config.json"), "utf-8")) as { machine: { aliases: string[] } };
    expect(cfg.machine.aliases).toEqual(["MacBookAir", hostname()]);
  });

  it("a start carrying a FOREIGN machine_id under MY hostname is never closed by my stop → unpaired, duration NULL", async () => {
    seedSchema();
    addMachineIdColumn();
    writeIdentity({ id: "X", aliases: [] });
    withDb((db) =>
      db.prepare(
        `INSERT INTO ceremony_events (project, ceremony, event_type, machine_hostname, machine_id, created_at)
         VALUES (?, 'boot', 'start', ?, 'Y', datetime('now', '-90 seconds'))`,
      ).run(SLUG, hostname()),
    );
    const { code, digest } = await run({ action: "stop", name: "boot", project: SLUG });
    expect(code).toBe(0);
    expect(digest?.paired).toBe(false);
    expect(digest?.duration_ms).toBeNull();
    expect(digest?.warnings?.some((w) => w.includes("unpaired stop"))).toBe(true);
  });

  it("without the column (a brain older than instances v5): hostname-only pairing, widened to the alias list", async () => {
    seedSchema();
    writeIdentity({ id: "X", aliases: ["MacBookAir"] });
    seedStart(SLUG, "boot", "MacBookAir", "datetime('now', '-90 seconds')");
    const { digest } = await run({ action: "stop", name: "boot", project: SLUG });
    expect(digest?.paired).toBe(true);
    expect(digest?.duration_ms as number).toBeGreaterThanOrEqual(88_000);
  });
});
