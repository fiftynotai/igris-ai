/**
 * FR-195 (M1) — session gather classification matrix (HIGHEST-VALUE test).
 *
 * The 8 scenarios from the FR-195 plan's "test scenarios" — the faithful
 * SKILL.md §2 G2 truth table reproduced as code. Each scenario seeds a real
 * brain DB (IGRIS_BRAIN_DIR, never a mock — #159), runs `runSession({action:
 * 'gather'})`, captures the JSON digest off stdout, and asserts the
 * classification. Scenario 3 + 8 additionally assert the ABANDONED-LIVE file
 * is NOT mutated on disk or in the DB (Lock-1/Lock-2: never consume, never
 * auto-archive, never clear ownership).
 *
 * Seed DDL is the brain's authoritative schema (sessions component schema
 * v1+v2 ALTERs + instances v4); only the tables M1 touches are seeded (#287),
 * no *_vec tables.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { GatherDigest } from "../types.js";

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

/** Open the seed DB (creating the schema dir). Caller closes. */
function openSeed(withTables = true): Database.Database {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  if (withTables) {
    db.exec(SESSION_FILES_DDL);
    db.exec(INSTANCES_DDL);
  }
  return db;
}

function insertSessionFile(
  db: Database.Database,
  row: {
    id: string;
    filename: string;
    content?: string;
    instance_id?: string | null;
    state?: string;
    updated_at?: string;
    project?: string;
  },
): void {
  db.prepare(
    `INSERT INTO session_files (id, project, filename, content, content_hash, updated_at, instance_id, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.project ?? "demo",
    row.filename,
    row.content ?? "body",
    "hash-" + row.id,
    row.updated_at ?? "2026-06-01 00:00:00",
    row.instance_id ?? null,
    row.state ?? "live",
  );
}

/** Insert an ACTIVE instance row with current activity metadata. */
function insertActiveInstance(
  db: Database.Database,
  id: string,
  currentBrief: string | null = null,
  opts: {
    machine_hostname?: string;
    owner_pid?: number | null;
    owner_started_at?: string | null;
    harness?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO instances (
       id, machine_hostname, project_slug, current_brief, status,
       last_heartbeat_at, harness, owner_pid, owner_started_at
     )
     VALUES (?, ?, 'demo', ?, 'active', datetime('now'), ?, ?, ?)`,
  ).run(
    id,
    opts.machine_hostname ?? "host-" + id,
    currentBrief,
    opts.harness ?? null,
    opts.owner_pid ?? null,
    opts.owner_started_at ?? null,
  );
}

async function getSession(): Promise<typeof import("../verbs/session.js")> {
  return await import("../verbs/session.js");
}

async function closeBrainDb(): Promise<void> {
  (await import("../lib/brain-db.js")).closeDb();
}

/** Run gather, capturing the single JSON line it writes to stdout. */
async function runGather(project = "demo"): Promise<GatherDigest> {
  const { runSession } = await getSession();
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

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-gather-"));
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  // Force degraded-no-db OFF by default isn't possible without a DB; each test
  // that wants the local channel seeds the DB file. Clear harness markers.
  for (const k of ["CLAUDECODE", "GEMINI_CLI", "CODEX_SESSION", "OPENCODE"]) {
    delete process.env[k];
  }
});

afterEach(async () => {
  await closeBrainDb();
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = savedEnv;
});

describe("session gather — classification matrix (SKILL.md §2 G2)", () => {
  it("1. one rested file, owner absent → GENUINE HANDOFF, picked, content fetched", async () => {
    const seed = openSeed();
    insertSessionFile(seed, {
      id: "h",
      filename: "instances/i-gone.md",
      instance_id: "i-gone", // no matching active instance
      state: "rested",
      content: "**Mode:** REST MODE\n**Resume Point:** finish the parser\n**Next Steps:** run tests",
      updated_at: "2026-06-05 10:00:00",
    });
    seed.close();

    const d = await runGather();
    expect(d.fresh_start).toBe(false);
    expect(d.degraded).toBe(false);
    expect(d.handoff).not.toBeNull();
    expect(d.handoff?.filename).toBe("instances/i-gone.md");
    expect(d.handoff?.mode).toBe("REST MODE");
    expect(d.handoff?.resume_point).toBe("finish the parser");
    expect(d.handoff?.next_steps).toBe("run tests");
    expect(d.handoff?.is_legacy).toBe(false);
    expect(d.siblings).toEqual([]);
    expect(d.crashed).toEqual([]);
  });

  it("2. one live file, owner active, not-self → LIVE SIBLING, not a handoff", async () => {
    const seed = openSeed();
    insertActiveInstance(seed, "i-live", "BR-42");
    insertSessionFile(seed, {
      id: "s",
      filename: "instances/i-live.md",
      instance_id: "i-live",
      state: "live",
    });
    seed.close();

    const d = await runGather();
    expect(d.fresh_start).toBe(true);
    expect(d.handoff).toBeNull();
    expect(d.siblings.length).toBe(1);
    expect(d.siblings[0].instance_id).toBe("i-live");
    expect(d.siblings[0].current_brief).toBe("BR-42");
    expect(d.crashed).toEqual([]);
  });

  it("2b. multiple same-machine live owners → multiple LIVE SIBLINGS", async () => {
    const { getProcessStartTime } = await import("../lib/process-liveness.js");
    const startedAt = getProcessStartTime(process.pid);
    expect(startedAt).not.toBeNull();

    const seed = openSeed();
    insertActiveInstance(seed, "i-live-a", "FR-100", {
      machine_hostname: hostname(),
      owner_pid: process.pid,
      owner_started_at: startedAt,
      harness: "codex",
    });
    insertActiveInstance(seed, "i-live-b", "FR-101", {
      machine_hostname: hostname(),
      owner_pid: process.pid,
      owner_started_at: startedAt,
      harness: "claude",
    });
    insertSessionFile(seed, {
      id: "a",
      filename: "instances/i-live-a.md",
      instance_id: "i-live-a",
      state: "live",
    });
    insertSessionFile(seed, {
      id: "b",
      filename: "instances/i-live-b.md",
      instance_id: "i-live-b",
      state: "live",
    });
    seed.close();

    const d = await runGather();
    expect(d.siblings.map((s) => s.instance_id).sort()).toEqual([
      "i-live-a",
      "i-live-b",
    ]);
    expect(d.siblings.every((s) => s.liveness_status === "alive")).toBe(true);
    expect(d.crashed).toEqual([]);
  });

  it("2c. same-machine missing owner PID → ABANDONED LIVE immediately", async () => {
    const seed = openSeed();
    insertActiveInstance(seed, "i-dead", "FR-102", {
      machine_hostname: hostname(),
      owner_pid: 999_999_999,
      owner_started_at: "definitely not alive",
      harness: "antigravity",
    });
    insertSessionFile(seed, {
      id: "dead",
      filename: "instances/i-dead.md",
      instance_id: "i-dead",
      state: "live",
    });
    seed.close();

    const d = await runGather();
    expect(d.siblings).toEqual([]);
    expect(d.crashed.length).toBe(1);
    expect(d.crashed[0].instance_id).toBe("i-dead");
    expect(d.crashed[0].liveness_status).toBe("dead");
  });

  it("2d. same-machine PID reuse mismatch → ABANDONED LIVE", async () => {
    const seed = openSeed();
    insertActiveInstance(seed, "i-reused", "FR-103", {
      machine_hostname: hostname(),
      owner_pid: process.pid,
      owner_started_at: "Mon Jan  1 00:00:00 1970",
      harness: "gemini",
    });
    insertSessionFile(seed, {
      id: "reused",
      filename: "instances/i-reused.md",
      instance_id: "i-reused",
      state: "live",
    });
    seed.close();

    const d = await runGather();
    expect(d.siblings).toEqual([]);
    expect(d.crashed.length).toBe(1);
    expect(d.crashed[0].instance_id).toBe("i-reused");
    expect(d.crashed[0].liveness_status).toBe("dead_pid_reused");
  });

  it("3. one live file, owner absent/stale → ABANDONED LIVE, NOT consumed, file untouched", async () => {
    const seed = openSeed();
    // Owner row absent from instances entirely → abandoned.
    insertSessionFile(seed, {
      id: "ab",
      filename: "instances/i-crash.md",
      instance_id: "i-crash",
      state: "live",
      content: "scratch",
      updated_at: "2026-06-02 08:00:00",
    });
    seed.close();

    const d = await runGather();
    expect(d.handoff).toBeNull();
    expect(d.fresh_start).toBe(true);
    expect(d.siblings).toEqual([]);
    expect(d.crashed.length).toBe(1);
    expect(d.crashed[0].instance_id).toBe("i-crash");
    expect(d.crashed[0].scratchpad).toBe("session/instances/i-crash.md");

    // Lock-1/Lock-2: the abandoned-live row must NOT be mutated in the DB.
    await closeBrainDb();
    const check = new Database(dbFile());
    const row = check
      .prepare(
        "SELECT state, instance_id, content, content_hash FROM session_files WHERE id = 'ab'",
      )
      .get() as {
      state: string;
      instance_id: string;
      content: string;
      content_hash: string;
    };
    check.close();
    expect(row.state).toBe("live"); // never auto-archived
    expect(row.instance_id).toBe("i-crash"); // ownership never cleared
    expect(row.content).toBe("scratch"); // never consumed/rewritten
    expect(row.content_hash).toBe("hash-ab");
  });

  it("4. legacy CURRENT_SESSION.md + instance_id NULL → GENUINE HANDOFF, is_legacy:true", async () => {
    const seed = openSeed();
    insertSessionFile(seed, {
      id: "leg",
      filename: "CURRENT_SESSION.md",
      instance_id: null,
      // Legacy rows survived migration as state='live' — must still classify
      // as GENUINE HANDOFF via the fall-through, not ABANDONED LIVE.
      state: "live",
      content: "**Mode:** REST MODE\n**Resume Point:** legacy resume",
      updated_at: "2026-05-01 00:00:00",
    });
    seed.close();

    const d = await runGather();
    expect(d.handoff).not.toBeNull();
    expect(d.handoff?.filename).toBe("CURRENT_SESSION.md");
    expect(d.handoff?.is_legacy).toBe(true);
    expect(d.handoff?.instance_id).toBeNull();
    expect(d.handoff?.resume_point).toBe("legacy resume");
    // It must NOT show up as a crashed/abandoned row.
    expect(d.crashed).toEqual([]);
    expect(d.fresh_start).toBe(false);
  });

  it("5. two rested from different instances → newer updated_at wins", async () => {
    const seed = openSeed();
    insertSessionFile(seed, {
      id: "older",
      filename: "instances/i-a.md",
      instance_id: "i-a",
      state: "rested",
      content: "**Resume Point:** older",
      updated_at: "2026-06-01 00:00:00",
    });
    insertSessionFile(seed, {
      id: "newer",
      filename: "instances/i-b.md",
      instance_id: "i-b",
      state: "rested",
      content: "**Resume Point:** newer",
      updated_at: "2026-06-09 00:00:00",
    });
    seed.close();

    const d = await runGather();
    expect(d.handoff?.filename).toBe("instances/i-b.md");
    expect(d.handoff?.resume_point).toBe("newer");
  });

  it("6. zero session files → fresh_start, empty siblings/crashed", async () => {
    const seed = openSeed(); // tables exist, no rows
    seed.close();
    const d = await runGather();
    expect(d.fresh_start).toBe(true);
    expect(d.handoff).toBeNull();
    expect(d.siblings).toEqual([]);
    expect(d.crashed).toEqual([]);
    expect(d.degraded).toBe(false);
  });

  it("7. brain DB absent → degraded:true, fresh_start:true, exit 0 (never block)", async () => {
    // No DB file created at all.
    const { runSession } = await getSession();
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((c: string | Uint8Array): boolean => {
      captured += typeof c === "string" ? c : c.toString();
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = runSession({ action: "gather", project: "demo" });
    } finally {
      process.stdout.write = origWrite as typeof process.stdout.write;
    }
    expect(code).toBe(0);
    const d = JSON.parse(captured.trim()) as GatherDigest;
    expect(d.degraded).toBe(true);
    expect(d.fresh_start).toBe(true);
    expect(d.handoff).toBeNull();
  });

  it("8. mixed: 1 sibling + 1 abandoned + 1 handoff → all three lists, only handoff fetched", async () => {
    const seed = openSeed();
    // sibling: live + active owner
    insertActiveInstance(seed, "i-sib", "BR-100");
    insertSessionFile(seed, {
      id: "sib",
      filename: "instances/i-sib.md",
      instance_id: "i-sib",
      state: "live",
      content: "SIBLING CONTENT should NOT be fetched",
    });
    // abandoned: live + owner absent
    insertSessionFile(seed, {
      id: "aban",
      filename: "instances/i-dead.md",
      instance_id: "i-dead",
      state: "live",
      content: "ABANDONED CONTENT should NOT be fetched",
      updated_at: "2026-06-02 00:00:00",
    });
    // handoff: rested + owner absent
    insertSessionFile(seed, {
      id: "hand",
      filename: "instances/i-rest.md",
      instance_id: "i-rest",
      state: "rested",
      content: "**Resume Point:** the one true handoff",
      updated_at: "2026-06-07 00:00:00",
    });
    seed.close();

    const d = await runGather();
    // sibling list
    expect(d.siblings.length).toBe(1);
    expect(d.siblings[0].instance_id).toBe("i-sib");
    expect(d.siblings[0].current_brief).toBe("BR-100");
    // crashed list
    expect(d.crashed.length).toBe(1);
    expect(d.crashed[0].instance_id).toBe("i-dead");
    // handoff = the rested one, with content fetched
    expect(d.handoff?.filename).toBe("instances/i-rest.md");
    expect(d.handoff?.resume_point).toBe("the one true handoff");
    expect(d.fresh_start).toBe(false);

    // Lock-2: neither sibling nor abandoned file mutated.
    await closeBrainDb();
    const check = new Database(dbFile());
    const sib = check
      .prepare("SELECT state FROM session_files WHERE id = 'sib'")
      .get() as { state: string };
    const aban = check
      .prepare(
        "SELECT state, instance_id FROM session_files WHERE id = 'aban'",
      )
      .get() as { state: string; instance_id: string };
    check.close();
    expect(sib.state).toBe("live");
    expect(aban.state).toBe("live");
    expect(aban.instance_id).toBe("i-dead");
  });
});

describe("session — unknown action", () => {
  it("returns exit 2 for an unknown action", async () => {
    const { runSession } = await getSession();
    const code = runSession({ action: "bogus" as never, project: "demo" });
    expect(code).toBe(2);
  });

  it("register is now implemented (M2): exit 0 even with no brain DB (degraded)", async () => {
    // M1 stubbed register → exit 2; M2 ships it. With no seeded DB in this
    // describe block's tmpRoot, register degrades (exit 0) and emits a digest.
    // (The full register matrix lives in session-register.test.ts.)
    const { runSession } = await getSession();
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let code: number;
    try {
      code = runSession({ action: "register", project: "demo" });
    } finally {
      process.stdout.write = origWrite as typeof process.stdout.write;
    }
    expect(code).toBe(0);
  });
});
