/**
 * FR-195 (M2) — session register tests.
 *
 * The §3.7 contract: heartbeat upsert (mint OR recover) + write the LIVE
 * per-instance file (seeded from gather's handoff), NON-DESTRUCTIVELY (#230).
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
import type { RegisterDigest } from "../types.js";

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
    last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT DEFAULT '{}'
  );
`;

function dbFile(): string {
  return join(tmpRoot, "memory", "knowledge.db");
}

/** Seed a brain DB with the two tables (no rows by default). */
function seedSchema(): void {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  db.exec(SESSION_FILES_DDL);
  db.exec(INSTANCES_DDL);
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

/** Read an instances-table row (or undefined). */
function readInstanceRow(
  id: string,
): { status: string; project_slug: string | null } | undefined {
  const db = new Database(dbFile());
  const row = db
    .prepare("SELECT status, project_slug FROM instances WHERE id = ?")
    .get(id) as { status: string; project_slug: string | null } | undefined;
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
  for (const k of ["CLAUDECODE", "GEMINI_CLI", "CODEX_SESSION", "OPENCODE"]) {
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

  it("recovers (refreshes) an existing instance when --self-instance-id is given", async () => {
    seedSchema();
    // Pre-seed the instance as stale so we can prove the refresh flips it active.
    const db = new Database(dbFile());
    db.prepare(
      `INSERT INTO instances (id, machine_hostname, project_slug, status, last_heartbeat_at)
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
