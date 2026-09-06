/**
 * FR-195 (M2) — session register tests.
 *
 * The §3.7 contract: instance registration upsert (mint OR recover) + write
 * the LIVE per-instance file (seeded from gather's handoff), NON-DESTRUCTIVELY (#230).
 * Each test seeds a real brain DB (IGRIS_BRAIN_DIR, never a mock — #159) and
 * reads back BOTH the DB row and the on-disk file (under
 * <IGRIS_BRAIN_DIR>/projects/<slug>/session/instances/).
 *
 * Proven invariants:
 *   - mint: no id → fresh UUID, registry row inserted, LIVE file written.
 *   - recover: id supplied → upsert refreshes the SAME row (no duplicate).
 *   - LIVE file carries the `**Active Brief:**` line shape (MAINTAINING
 *     contract — phase-guard + /hunt parse it) + `**Instance ID:**` + `**Mode:**`.
 *   - seeded-from-handoff: the chosen handoff's Next Steps carry forward.
 *   - re-run idempotent: same id → upsert (ONE row), and the on-disk file is
 *     PRESERVED (a re-run does NOT clobber the running instance's scratchpad).
 *   - COALESCE: re-registering does not downgrade the DB row's state.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatherDigest, RegisterDigest } from "../types.js";
import { HARNESS_ENV_MARKERS } from "../lib/detect.js";

let tmpRoot: string;
let savedEnv: NodeJS.ProcessEnv;

const SESSION_FILES_DDL = `
  CREATE TABLE IF NOT EXISTS session_files (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project, filename)
  );
  ALTER TABLE session_files ADD COLUMN instance_id TEXT;
  ALTER TABLE session_files ADD COLUMN state TEXT NOT NULL DEFAULT 'live'
    CHECK (state IN ('live','rested','archived'));
`;

const INSTANCES_DDL = `
  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,
    machine_hostname TEXT NOT NULL,
    machine_os TEXT,
    project_slug TEXT,
    project_path TEXT,
    current_brief TEXT,
    current_phase TEXT,
    current_task TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'stale')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT DEFAULT '{}'
  );
`;

const INSTANCE_LIVENESS_DDL = `
  ALTER TABLE instances ADD COLUMN harness TEXT;
  ALTER TABLE instances ADD COLUMN harness_session_id TEXT;
  ALTER TABLE instances ADD COLUMN owner_pid INTEGER;
  ALTER TABLE instances ADD COLUMN owner_started_at TEXT;
  ALTER TABLE instances ADD COLUMN liveness_method TEXT;
  ALTER TABLE instances ADD COLUMN liveness_status TEXT;
  ALTER TABLE instances ADD COLUMN liveness_checked_at TEXT;
  ALTER TABLE instances ADD COLUMN lease_expires_at TEXT;
  ALTER TABLE instances ADD COLUMN state_updated_at TEXT;
`;

function dbFile(): string {
  return join(tmpRoot, "memory", "knowledge.db");
}

/** Seed a brain DB with the two tables (no rows by default). */
function seedSchema(withLivenessColumns = true): void {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  db.exec(SESSION_FILES_DDL);
  db.exec(INSTANCES_DDL);
  if (withLivenessColumns) db.exec(INSTANCE_LIVENESS_DDL);
  db.close();
}

/** On-disk path of a project's per-instance LIVE file. */
function instanceFilePath(slug: string, id: string): string {
  return join(tmpRoot, "projects", slug, "session", "instances", `${id}.md`);
}

async function closeBrainDb(): Promise<void> {
  (await import("../lib/brain-db.js")).closeDb();
}

/** Run register, capturing the single JSON line on stdout. */
async function runRegister(opts: {
  project?: string;
  selfInstanceId?: string;
  seedNextSteps?: string;
  projectPath?: string;
}): Promise<RegisterDigest> {
  const { runSession } = await import("../verbs/session.js");
  const origWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    captured += typeof c === "string" ? c : c.toString();
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = runSession({ action: "register", ...opts });
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
  expect(code).toBe(0);
  return JSON.parse(captured.trim()) as RegisterDigest;
}

/** Run gather, capturing the single JSON line on stdout (TD-360 round-trip). */
async function runGather(project = "demo"): Promise<GatherDigest> {
  const { runSession } = await import("../verbs/session.js");
  const origWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    captured += typeof c === "string" ? c : c.toString();
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = runSession({ action: "gather", project });
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
  expect(code).toBe(0);
  return JSON.parse(captured.trim()) as GatherDigest;
}

/**
 * Flip the instance's session_files row to `rested` — what `/rest` does — so
 * the NEXT gather classifies it as a GENUINE HANDOFF and parses its content.
 * The brain handle is closed first so the update lands on a quiet DB.
 */
async function restTheRow(instanceId: string, project = "demo"): Promise<void> {
  await closeBrainDb();
  const db = new Database(dbFile());
  const info = db
    .prepare(
      "UPDATE session_files SET state = 'rested' WHERE project = ? AND filename = ?",
    )
    .run(project, `instances/${instanceId}.md`);
  db.close();
  // Arm: the row the gather below reads really did flip. A 0-row UPDATE would
  // leave a 'live' row, which gather classifies ABANDONED-LIVE and never parses
  // — the assertions would then fail for a reason that is not the fix.
  expect(info.changes).toBe(1);
}

/** Read an instances-table row (or undefined). */
function readInstanceRow(
  id: string,
):
  | {
      status: string;
      project_slug: string | null;
      harness?: string | null;
      owner_pid?: number | null;
      owner_started_at?: string | null;
      liveness_status?: string | null;
      liveness_method?: string | null;
    }
  | undefined {
  const db = new Database(dbFile());
  const cols = db.prepare("PRAGMA table_info(instances)").all() as {
    name: string;
  }[];
  const names = new Set(cols.map((c) => c.name));
  const projections = ["status", "project_slug"];
  for (const name of [
    "harness",
    "owner_pid",
    "owner_started_at",
    "liveness_status",
    "liveness_method",
  ]) {
    if (names.has(name)) projections.push(name);
  }
  const row = db
    .prepare(`SELECT ${projections.join(", ")} FROM instances WHERE id = ?`)
    .get(id) as
    | {
        status: string;
        project_slug: string | null;
        harness?: string | null;
        owner_pid?: number | null;
        owner_started_at?: string | null;
        liveness_status?: string | null;
        liveness_method?: string | null;
      }
    | undefined;
  db.close();
  return row;
}

/** Read a session_files row (or undefined). */
function readSessionRow(
  project: string,
  filename: string,
): { instance_id: string | null; state: string; content: string } | undefined {
  const db = new Database(dbFile());
  const row = db
    .prepare(
      "SELECT instance_id, state, content FROM session_files WHERE project = ? AND filename = ?",
    )
    .get(project, filename) as
    | { instance_id: string | null; state: string; content: string }
    | undefined;
  db.close();
  return row;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-register-"));
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  // Fully sandbox harness inference: clear EVERY marker detect() reads, not a
  // partial set — otherwise a live harness's ambient marker (e.g.
  // CLAUDE_CODE_ENTRYPOINT when the suite runs inside a Claude Code session)
  // leaks in and the default-harness assertion below flips to `claude` (TD-299).
  //
  // TD-411 adds IGRIS_INSTANCE_OWNER_PID to the same sandbox: it is tier 1 of
  // owner resolution, so an ambient value would short-circuit the walk and make
  // every owner assertion below report the environment rather than the code.
  for (const k of [...HARNESS_ENV_MARKERS, "IGRIS_INSTANCE_OWNER_PID"]) {
    delete process.env[k];
  }
});

afterEach(async () => {
  await closeBrainDb();
  process.env = savedEnv;
});

describe("session register — §3.7", () => {
  it("degrades (exit 0) with no brain DB — never blocks", async () => {
    // No seedSchema() → the DB file does not exist → degraded-no-db.
    const d = await runRegister({ project: "demo" });
    expect(d.degraded).toBe(true);
    expect(d.minted).toBe(false);
    expect(d.live_file).toBe("");
  });

  it("mints a fresh UUID, inserts the registry row, writes the LIVE file", async () => {
    seedSchema();
    const d = await runRegister({ project: "demo", projectPath: "/tmp/demo" });
    expect(d.degraded).toBe(false);
    expect(d.minted).toBe(true);
    expect(d.instance_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.live_file).toBe(`instances/${d.instance_id}.md`);

    // Registry row landed, active.
    const inst = readInstanceRow(d.instance_id);
    expect(inst?.status).toBe("active");
    expect(inst?.project_slug).toBe("demo");
    expect(inst?.harness).toBe("unknown");

    // TD-411 — this block used to assert `owner_pid > 0` and `liveness_status
    // === 'alive'`, which PINNED THE DEFECT: with harness markers sandboxed
    // there is no harness to own this session, and the pid that satisfied
    // `> 0` was `process.ppid` — the transient shell that ran the CLI, dead by
    // the time any reader checks it. The contract is now: no identifiable
    // owner ⇒ record NO owner, and stamp the status the reader will re-derive.
    expect(inst?.owner_pid).toBeNull();
    expect(inst?.owner_started_at).toBeNull();
    expect(inst?.liveness_status).toBe("unknown_no_metadata");
    expect(inst?.liveness_method).toBe("none");

    // On-disk LIVE file exists and carries the MAINTAINING line shape.
    const fp = instanceFilePath("demo", d.instance_id);
    expect(existsSync(fp)).toBe(true);
    const body = readFileSync(fp, "utf-8");
    expect(body).toContain(`**Instance ID:** ${d.instance_id}`);
    expect(body).toContain("**Mode:** Active");
    // The phase-guard + /hunt parse target — must be present.
    expect(body).toMatch(/^\*\*Active Brief:\*\*/m);

    // DB session_files row written at state='live', owned by the new instance.
    const row = readSessionRow("demo", `instances/${d.instance_id}.md`);
    expect(row?.state).toBe("live");
    expect(row?.instance_id).toBe(d.instance_id);
  });

  it("records the owner when one CAN be identified (TD-411 tier 1)", async () => {
    // The complement of the assertion above. Without this, the suite would only
    // pin the DEGRADE, and a `resolveOwnerProcess` that returned null
    // unconditionally would look perfectly healthy.
    seedSchema();
    process.env.IGRIS_INSTANCE_OWNER_PID = String(process.pid);

    const d = await runRegister({ project: "demo" });
    const inst = readInstanceRow(d.instance_id);

    expect(inst?.owner_pid).toBe(process.pid);
    expect(inst?.owner_started_at).toBeTruthy();
    // D-411-d: the stamp is derived through classifyInstanceLiveness against
    // the row being written, so a genuinely live owner stamps `alive` — but it
    // is a LAST-OBSERVED value, and every reader re-derives it.
    expect(inst?.liveness_status).toBe("alive");
    expect(inst?.liveness_method).toBe("pid_start_time");
  });

  it("recovers (refreshes) an existing instance when --self-instance-id is given", async () => {
    seedSchema();
    // Pre-seed the instance as stale so we can prove the refresh flips it active.
    const db = new Database(dbFile());
    db.prepare(
      `INSERT INTO instances (id, machine_hostname, project_slug, status, last_activity_at)
       VALUES ('i-known', 'old-host', 'demo', 'stale', datetime('now','-90 minutes'))`,
    ).run();
    db.close();

    const d = await runRegister({ project: "demo", selfInstanceId: "i-known" });
    expect(d.minted).toBe(false);
    expect(d.instance_id).toBe("i-known");

    const inst = readInstanceRow("i-known");
    expect(inst?.status).toBe("active"); // refreshed
    // Exactly one row (upsert, not duplicate).
    const cdb = new Database(dbFile());
    const count = cdb
      .prepare("SELECT COUNT(*) AS n FROM instances WHERE id = 'i-known'")
      .get() as { n: number };
    cdb.close();
    expect(count.n).toBe(1);
  });

  it("stays compatible when the brain DB has only the legacy instance columns", async () => {
    seedSchema(false);
    const d = await runRegister({ project: "demo", projectPath: "/tmp/demo" });
    expect(d.degraded).toBe(false);
    expect(d.instance_id).toMatch(/^[0-9a-f-]{36}$/);
    const inst = readInstanceRow(d.instance_id);
    expect(inst?.status).toBe("active");
    expect(inst?.project_slug).toBe("demo");
  });

  it("seeds the LIVE file's Next Steps from the handoff (resume carry-forward)", async () => {
    seedSchema();
    const d = await runRegister({
      project: "demo",
      seedNextSteps: "finish wiring the housekeeping verb",
    });
    expect(d.seeded_from_handoff).toBe(true);
    const body = readFileSync(instanceFilePath("demo", d.instance_id), "utf-8");
    expect(body).toContain("## Next Steps");
    expect(body).toContain("finish wiring the housekeeping verb");
  });

  it("does NOT seed (seeded_from_handoff false) when there is no handoff", async () => {
    seedSchema();
    const d = await runRegister({ project: "demo" });
    expect(d.seeded_from_handoff).toBe(false);
    const body = readFileSync(instanceFilePath("demo", d.instance_id), "utf-8");
    // A stable shape: the label is always present even with no seed.
    expect(body).toContain("## Next Steps");
    expect(body).toContain("None yet");
  });

  it("re-run is idempotent: same id → ONE row, on-disk file PRESERVED (#230 non-destructive)", async () => {
    seedSchema();
    // First register mints an id.
    const first = await runRegister({ project: "demo" });
    const id = first.instance_id;
    const fp = instanceFilePath("demo", id);

    // Simulate the running instance editing its own scratchpad after register.
    const edited = readFileSync(fp, "utf-8") + "\n\n## Scratch\nlive working notes\n";
    writeFileSync(fp, edited, "utf-8");

    // Re-run register with the SAME id (a recover).
    await closeBrainDb(); // simulate a fresh process opening the same DB
    const second = await runRegister({ project: "demo", selfInstanceId: id });
    expect(second.instance_id).toBe(id);
    expect(second.minted).toBe(false);

    // The on-disk file is PRESERVED — the live working notes survive (NOT
    // clobbered back to the skeleton).
    const afterBody = readFileSync(fp, "utf-8");
    expect(afterBody).toContain("live working notes");

    // Exactly ONE registry row and ONE session_files row (upsert, no dup).
    const cdb = new Database(dbFile());
    const instCount = cdb
      .prepare("SELECT COUNT(*) AS n FROM instances WHERE id = ?")
      .get(id) as { n: number };
    const sfCount = cdb
      .prepare(
        "SELECT COUNT(*) AS n FROM session_files WHERE project = 'demo' AND filename = ?",
      )
      .get(`instances/${id}.md`) as { n: number };
    cdb.close();
    expect(instCount.n).toBe(1);
    expect(sfCount.n).toBe(1);
  });

  it("re-register does NOT downgrade the DB row's state (COALESCE)", async () => {
    seedSchema();
    const first = await runRegister({ project: "demo" });
    const id = first.instance_id;
    const filename = `instances/${id}.md`;

    // Externally flip the DB row to 'rested' (simulate a /rest in between).
    const db = new Database(dbFile());
    db.prepare(
      "UPDATE session_files SET state = 'rested' WHERE project = 'demo' AND filename = ?",
    ).run(filename);
    db.close();

    // Re-register: the verb passes state='live' EXPLICITLY (it re-affirms LIVE),
    // so the row should go back to 'live' — and crucially the instance_id is
    // preserved (never nulled).
    await closeBrainDb();
    await runRegister({ project: "demo", selfInstanceId: id });
    const row = readSessionRow("demo", filename);
    expect(row?.state).toBe("live"); // explicit live re-affirm
    expect(row?.instance_id).toBe(id); // never nulled
  });
});

/**
 * TD-360 — the LIVE file's Next Steps round-trip.
 *
 * AC-2: `register --seed-next-steps "X"` followed by `gather` must return
 * `next_steps == "X"`. Before TD-360 the writer emitted only a `## Next Steps`
 * heading with the value on the line beneath, which `parseField`'s single-line
 * inline match could not see, so the seed carried "" forward.
 */
describe("TD-360 — register's Next Steps round-trips through gather", () => {
  it("AC-2: --seed-next-steps 'X' → gather returns next_steps === 'X'", async () => {
    seedSchema();
    const d = await runRegister({ project: "demo", seedNextSteps: "X" });

    // The machine line is on disk beside the prose section, not instead of it.
    // This on-disk assertion is what makes THIS test discriminate for the
    // writer. Measured 2026-08-24 by deleting the machine line from
    // `buildLiveFileContent` with the D-360-b fallback left in place. Under
    // that mutation ALONE all three tests in this describe red at the ON-DISK
    // assertion above and abort, so the gather layer is never reached — the
    // gather observations below were taken with the on-disk assertions
    // DISARMED. So measured: gather still returned "X" here (the fallback read
    // `## Next Steps`'s first line), so the gather assertion below is a
    // round-trip guard, not a writer guard; and the multi-line case in the next
    // test is the one that discriminates at the gather layer — it alone red,
    // returning only "finish the parser".
    const body = readFileSync(instanceFilePath("demo", d.instance_id), "utf-8");
    expect(body).toMatch(/^\*\*Next Steps:\*\* X$/m);
    expect(body).toContain("## Next Steps");

    await restTheRow(d.instance_id);
    const g = await runGather();
    expect(g.handoff?.filename).toBe(`instances/${d.instance_id}.md`);
    expect(g.handoff?.next_steps).toBe("X");
  });

  it("a MULTI-LINE seed collapses onto the machine line and stays verbatim in the prose", async () => {
    seedSchema();
    // The discriminating fixture. With a single-line seed the D-360-b heading
    // fallback would return the same string, so that case alone cannot tell the
    // machine line from the prose section. A multi-line seed can: the fallback
    // reads only the FIRST line, the machine line carries the whole thing.
    const seed = "finish the parser\n\nthen run the bats suite";
    const d = await runRegister({ project: "demo", seedNextSteps: seed });

    const body = readFileSync(instanceFilePath("demo", d.instance_id), "utf-8");
    expect(body).toMatch(
      /^\*\*Next Steps:\*\* finish the parser then run the bats suite$/m,
    );
    // D-360-a: the prose section survives, whole and multi-line.
    expect(body).toContain("## Next Steps");
    expect(body).toContain(seed);

    await restTheRow(d.instance_id);
    const g = await runGather();
    expect(g.handoff?.next_steps).toBe("finish the parser then run the bats suite");
    // Explicitly NOT the first line alone — that is what the heading fallback
    // would have produced, so this assertion reds if the machine line is lost.
    expect(g.handoff?.next_steps).not.toBe("finish the parser");
  });

  it("no seed → the machine line carries the same `None yet` placeholder as the section", async () => {
    seedSchema();
    const d = await runRegister({ project: "demo" });
    expect(d.seeded_from_handoff).toBe(false);

    const body = readFileSync(instanceFilePath("demo", d.instance_id), "utf-8");
    expect(body).toMatch(/^\*\*Next Steps:\*\* None yet$/m);

    await restTheRow(d.instance_id);
    const g = await runGather();
    // A stable shape: never an empty label, never an empty digest field.
    expect(g.handoff?.next_steps).toBe("None yet");
  });
});

// ---------------------------------------------------------------------------
// BR-100 — register stamps the machine identity
// ---------------------------------------------------------------------------

describe("BR-100 — session register stamps machine_id beside machine_hostname", () => {
  it("with instances.machine_id present: the row carries the minted config.json machine.id; the live hostname stays the label", async () => {
    seedSchema();
    const { hostname } = await import("node:os");
    const db = new Database(dbFile());
    db.exec("ALTER TABLE instances ADD COLUMN machine_id TEXT");
    db.close();
    writeFileSync(join(tmpRoot, "config.json"), "{}\n");

    const d = await runRegister({ project: "demo", projectPath: "/tmp/demo" });
    expect(d.degraded).toBe(false);

    const cfg = JSON.parse(readFileSync(join(tmpRoot, "config.json"), "utf-8")) as { machine: { id: string; aliases: string[] } };
    expect(cfg.machine.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(cfg.machine.aliases).toEqual([hostname()]);

    const h = new Database(dbFile(), { readonly: true });
    const row = h.prepare("SELECT machine_hostname, machine_id FROM instances WHERE id = ?").get(d.instance_id) as Record<string, unknown>;
    h.close();
    expect(row).toEqual({ machine_hostname: hostname(), machine_id: cfg.machine.id });
  });

  it("without the column (an un-migrated brain): the write still lands; the identity is minted regardless", async () => {
    seedSchema();
    writeFileSync(join(tmpRoot, "config.json"), "{}\n");
    const d = await runRegister({ project: "demo", projectPath: "/tmp/demo" });
    expect(d.degraded).toBe(false);
    expect(readInstanceRow(d.instance_id)?.status).toBe("active");
    const cfg = JSON.parse(readFileSync(join(tmpRoot, "config.json"), "utf-8")) as { machine?: { id?: string } };
    expect(cfg.machine?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("an ABSENT config.json: register still succeeds and creates no config (init owns creation)", async () => {
    seedSchema();
    const d = await runRegister({ project: "demo", projectPath: "/tmp/demo" });
    expect(d.degraded).toBe(false);
    expect(existsSync(join(tmpRoot, "config.json"))).toBe(false);
  });
});
