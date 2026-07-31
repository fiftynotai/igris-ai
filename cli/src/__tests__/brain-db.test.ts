/**
 * FR-195 (M1) — brain-db.ts accessor tests.
 *
 * Each accessor is exercised against a REAL seeded tmp DB (IGRIS_BRAIN_DIR
 * sandboxed). We NEVER mock better-sqlite3 — that is the module under test's
 * own dependency, and mocking it would erase the bug surface (#159 / L-159 /
 * TD-098). The seed DDL is copied from the brain's authoritative schema:
 *   - session_files: sessions component schema v1 + v2 ALTERs
 *     (brain-mcp-server/src/engine/components/sessions/schema.ts:39-63)
 *   - instances:     db.ts v4 + TD-277 terminal activity timestamp shape
 * We seed ONLY the tables M1 touches (#287) — NO *_vec virtual tables / vec0
 * triggers (irrelevant here + macOS sqlite chokes on them).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

/** DDL for session_files — schema v1 base + v2 (instance_id + state) ALTERs. */
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

/** DDL for instances — db.ts migration v4 (verbatim). */
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

/** Pre-TD-277 instances DDL, used only to prove local migration from old DBs. */
const LEGACY_INSTANCES_DDL = INSTANCES_DDL.replace(
  "last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))",
  "last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))",
);

/** FR-190 instances component migration v2 columns. */
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

/** DDL for brief_status — db.ts migration v2 (verbatim, sans FK on projects). */
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
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_status_unique ON brief_status(project, brief_id);
`;

/** DDL for goals — goals component schema v1 (verbatim). */
const GOALS_DDL = `
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id TEXT NOT NULL UNIQUE,
    project_slug TEXT,
    title TEXT NOT NULL,
    description TEXT,
    outcome TEXT NOT NULL,
    deadline TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'achieved', 'abandoned', 'deferred')),
    priority TEXT NOT NULL DEFAULT 'P2-Medium',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    achieved_at TEXT,
    metadata TEXT NOT NULL DEFAULT '{}'
  );
`;

/**
 * Open the sandboxed brain DB directly and run a seed callback. Closes the
 * seed connection so the module-under-test opens its own (WAL — concurrent
 * readers on the same file are fine).
 */
function seedBrain(fn: (db: Database.Database) => void): void {
  const dbDir = join(tmpRoot, "memory");
  mkdirSync(dbDir, { recursive: true });
  const seed = new Database(join(dbDir, "knowledge.db"));
  seed.pragma("journal_mode = WAL");
  fn(seed);
  seed.close();
}

/** Insert a session_files row with sensible defaults. */
function insertSessionFile(
  db: Database.Database,
  row: {
    id: string;
    project: string;
    filename: string;
    content?: string;
    instance_id?: string | null;
    state?: string;
    updated_at?: string;
  },
): void {
  db.prepare(
    `INSERT INTO session_files (id, project, filename, content, content_hash, updated_at, instance_id, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.project,
    row.filename,
    row.content ?? "body",
    "hash-" + row.id,
    row.updated_at ?? "2026-06-01 00:00:00",
    row.instance_id ?? null,
    row.state ?? "live",
  );
}

/** Insert an instances row with sensible defaults. */
function insertInstance(
  db: Database.Database,
  row: {
    id: string;
    project_slug?: string;
    status?: string;
    current_brief?: string | null;
    last_activity_at?: string;
    machine_hostname?: string;
    harness?: string | null;
    owner_pid?: number | null;
    owner_started_at?: string | null;
    liveness_status?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO instances (id, machine_hostname, project_slug, current_brief, status, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.machine_hostname ?? "host-" + row.id,
    row.project_slug ?? "demo",
    row.current_brief ?? null,
    row.status ?? "active",
    // Default activity timestamp; tests may override it to prove age is inert.
    row.last_activity_at ?? new Date().toISOString().replace("T", " ").substring(0, 19),
  );
  const updates: string[] = [];
  const values: unknown[] = [];
  for (const [name, value] of [
    ["harness", row.harness],
    ["owner_pid", row.owner_pid],
    ["owner_started_at", row.owner_started_at],
    ["liveness_status", row.liveness_status],
  ] as Array<[string, unknown]>) {
    if (value === undefined) continue;
    updates.push(`${name} = ?`);
    values.push(value);
  }
  if (updates.length > 0) {
    values.push(row.id);
    db.prepare(`UPDATE instances SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  }
}

async function getModule(): Promise<typeof import("../lib/brain-db.js")> {
  return await import("../lib/brain-db.js");
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-braindb-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
});

afterEach(async () => {
  (await getModule()).closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
});

describe("brain-db — listSessionFiles", () => {
  it("returns [] (not throw) when session_files table is absent", async () => {
    // No seed at all: the DB file does not even exist yet. The accessor must
    // preflight (L-133) and return empty without creating the table.
    const m = await getModule();
    expect(m.listSessionFiles("demo")).toEqual([]);
  });

  it("returns [] when the DB exists but the table was never migrated", async () => {
    // Create the DB file with only `instances` — session_files absent.
    seedBrain((db) => {
      db.exec(INSTANCES_DDL);
    });
    const m = await getModule();
    expect(m.listSessionFiles("demo")).toEqual([]);
  });

  it("projects metadata only, ordered by updated_at DESC, filtered by project", async () => {
    seedBrain((db) => {
      db.exec(SESSION_FILES_DDL);
      insertSessionFile(db, {
        id: "a",
        project: "demo",
        filename: "instances/old.md",
        updated_at: "2026-06-01 00:00:00",
        state: "rested",
      });
      insertSessionFile(db, {
        id: "b",
        project: "demo",
        filename: "instances/new.md",
        updated_at: "2026-06-05 00:00:00",
        state: "live",
        instance_id: "i-1",
      });
      // Different project — must be excluded.
      insertSessionFile(db, {
        id: "c",
        project: "other",
        filename: "instances/x.md",
      });
    });
    const m = await getModule();
    const rows = m.listSessionFiles("demo");
    expect(rows.length).toBe(2);
    // newest-first ordering
    expect(rows[0].filename).toBe("instances/new.md");
    expect(rows[1].filename).toBe("instances/old.md");
    // metadata-only projection: no `content` field present
    expect(Object.keys(rows[0]).sort()).toEqual([
      "content_hash",
      "filename",
      "instance_id",
      "state",
      "updated_at",
    ]);
    expect(rows[0].instance_id).toBe("i-1");
    expect(rows[0].state).toBe("live");
  });

  it("does NOT create the table as a side-effect of a read (create-never)", async () => {
    // DB exists with only instances; reading session_files must not add it.
    seedBrain((db) => {
      db.exec(INSTANCES_DDL);
    });
    const m = await getModule();
    m.listSessionFiles("demo");
    m.closeDb();
    // Re-open independently and assert session_files is STILL absent.
    const check = new Database(join(tmpRoot, "memory", "knowledge.db"));
    const exists = check
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_files'",
      )
      .get();
    check.close();
    expect(exists).toBeUndefined();
  });
});

describe("brain-db — getSessionFileContent", () => {
  it("returns null when the table is absent", async () => {
    const m = await getModule();
    expect(m.getSessionFileContent("demo", "instances/x.md")).toBeNull();
  });

  it("returns null when the row is absent", async () => {
    seedBrain((db) => db.exec(SESSION_FILES_DDL));
    const m = await getModule();
    expect(m.getSessionFileContent("demo", "instances/missing.md")).toBeNull();
  });

  it("returns the content for the chosen file only", async () => {
    seedBrain((db) => {
      db.exec(SESSION_FILES_DDL);
      insertSessionFile(db, {
        id: "a",
        project: "demo",
        filename: "instances/handoff.md",
        content: "RESUME HERE",
      });
    });
    const m = await getModule();
    expect(m.getSessionFileContent("demo", "instances/handoff.md")).toBe(
      "RESUME HERE",
    );
  });

  it("TD-279: returns a string (never a Buffer) for a BLOB-content row", async () => {
    seedBrain((db) => {
      db.exec(SESSION_FILES_DDL);
      // Bind a Buffer so better-sqlite3 stores content as a BLOB — the bad-row
      // shape the read-boundary coercion must absorb.
      db.prepare(
        `INSERT INTO session_files (id, project, filename, content, content_hash, updated_at, instance_id, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "blob",
        "demo",
        "instances/blob.md",
        Buffer.from("RESUME FROM BLOB", "utf8"),
        "hash-blob",
        "2026-06-05 00:00:00",
        null,
        "rested",
      );
    });
    const m = await getModule();
    const out = m.getSessionFileContent("demo", "instances/blob.md");
    expect(typeof out).toBe("string");
    expect(Buffer.isBuffer(out)).toBe(false);
    expect(out).toBe("RESUME FROM BLOB");
  });
});

describe("brain-db — listInstances", () => {
  it("returns [] (not throw) when instances table is absent", async () => {
    const m = await getModule();
    expect(m.listInstances({ project: "demo", status: "active" })).toEqual([]);
  });

  it("projects the instance columns, filtered by project + status", async () => {
    seedBrain((db) => {
      db.exec(INSTANCES_DDL);
      insertInstance(db, { id: "i-1", project_slug: "demo", current_brief: "BR-7" });
      insertInstance(db, { id: "i-2", project_slug: "other" });
    });
    const m = await getModule();
    const rows = m.listInstances({ project: "demo", status: "active" });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("i-1");
    expect(rows[0].current_brief).toBe("BR-7");
    expect(rows[0].status).toBe("active");
  });

  it("does not mark an instance stale just because last activity is old", async () => {
    seedBrain((db) => {
      db.exec(INSTANCES_DDL);
      insertInstance(db, {
        id: "i-old",
        project_slug: "demo",
        last_activity_at: "datetime-placeholder",
      });
      db.prepare(
        "UPDATE instances SET last_activity_at = datetime('now','-60 minutes') WHERE id = 'i-old'",
      ).run();
    });
    const m = await getModule();
    const active = m.listInstances({ project: "demo", status: "active" });
    const row = active.find((r) => r.id === "i-old");
    expect(row).toBeDefined();
    expect(row?.status).toBe("active");
  });

  it("does not purge old instance rows during ordinary reads", async () => {
    seedBrain((db) => {
      db.exec(INSTANCES_DDL);
      insertInstance(db, { id: "i-dead", project_slug: "demo" });
      db.prepare(
        "UPDATE instances SET last_activity_at = datetime('now','-300 minutes') WHERE id = 'i-dead'",
      ).run();
    });
    const m = await getModule();
    const all = m.listInstances({
      project: "demo",
      status: "all",
      includeStale: true,
    });
    expect(all.find((r) => r.id === "i-dead")).toBeDefined();
    m.closeDb();
    const check = new Database(join(tmpRoot, "memory", "knowledge.db"));
    const row = check
      .prepare("SELECT id FROM instances WHERE id = 'i-dead'")
      .get();
    check.close();
    expect(row).toBeDefined();
  });

  it("ordinary instance reads never mutate session_files (#220)", async () => {
    seedBrain((db) => {
      db.exec(INSTANCES_DDL);
      db.exec(SESSION_FILES_DDL);
      // An ABANDONED-LIVE-shaped row: a live session file whose owner has old activity.
      insertSessionFile(db, {
        id: "sf",
        project: "demo",
        filename: "instances/i-crash.md",
        instance_id: "i-crash",
        state: "live",
        updated_at: "2026-06-01 00:00:00",
      });
      insertInstance(db, { id: "i-crash", project_slug: "demo" });
      db.prepare(
        "UPDATE instances SET last_activity_at = datetime('now','-300 minutes') WHERE id = 'i-crash'",
      ).run();
    });
    const m = await getModule();
    m.listInstances({ project: "demo", status: "active" });
    m.closeDb();
    // The session_files row is UNTOUCHED — state still 'live', not archived.
    const check = new Database(join(tmpRoot, "memory", "knowledge.db"));
    const sf = check
      .prepare(
        "SELECT state, content_hash, updated_at FROM session_files WHERE id = 'sf'",
      )
      .get() as { state: string; content_hash: string; updated_at: string };
    check.close();
    expect(sf.state).toBe("live");
    expect(sf.content_hash).toBe("hash-sf");
    expect(sf.updated_at).toBe("2026-06-01 00:00:00");
  });
});

/** Read a session_files row directly (for COALESCE assertions). */
function readSessionRow(
  project: string,
  filename: string,
): { instance_id: string | null; state: string; content: string } | undefined {
  const check = new Database(join(tmpRoot, "memory", "knowledge.db"));
  const row = check
    .prepare(
      "SELECT instance_id, state, content FROM session_files WHERE project = ? AND filename = ?",
    )
    .get(project, filename) as
    | { instance_id: string | null; state: string; content: string }
    | undefined;
  check.close();
  return row;
}

describe("brain-db — instance state registration (WRITE: mint-or-recover upsert)", () => {
  it("throws BrainTableMissingError when instances is absent (create-never)", async () => {
    // DB exists with only session_files — instances absent. A WRITE must NOT
    // silently no-op (the symmetric opposite of reads), and must NOT CREATE.
    seedBrain((db) => db.exec(SESSION_FILES_DDL));
    const m = await getModule();
    expect(() =>
      m.registerOrUpdateInstanceState({ machine_hostname: "host-1", project_slug: "demo" }),
    ).toThrow(m.BrainTableMissingError);
    m.closeDb();
    // instances STILL absent (no CREATE side-effect).
    const check = new Database(join(tmpRoot, "memory", "knowledge.db"));
    const exists = check
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='instances'",
      )
      .get();
    check.close();
    expect(exists).toBeUndefined();
  });

  it("mints a fresh UUID and inserts a row when no instance_id is supplied", async () => {
    seedBrain((db) => db.exec(INSTANCES_DDL));
    const m = await getModule();
    const res = m.registerOrUpdateInstanceState({
      machine_hostname: "host-mint",
      project_slug: "demo",
      project_path: "/tmp/demo",
    });
    expect(res.minted).toBe(true);
    expect(res.instance_id).toMatch(/^[0-9a-f-]{36}$/);
    m.closeDb();
    const check = new Database(join(tmpRoot, "memory", "knowledge.db"));
    const row = check
      .prepare(
        "SELECT machine_hostname, project_slug, project_path, status FROM instances WHERE id = ?",
      )
      .get(res.instance_id) as {
      machine_hostname: string;
      project_slug: string;
      project_path: string;
      status: string;
    };
    check.close();
    expect(row.machine_hostname).toBe("host-mint");
    expect(row.project_slug).toBe("demo");
    expect(row.project_path).toBe("/tmp/demo");
    expect(row.status).toBe("active");
  });

  it("renames a legacy activity column before writing state", async () => {
    seedBrain((db) => db.exec(LEGACY_INSTANCES_DDL));
    const m = await getModule();
    const res = m.registerOrUpdateInstanceState({
      machine_hostname: "host-legacy",
      project_slug: "demo",
    });
    m.closeDb();

    const check = new Database(join(tmpRoot, "memory", "knowledge.db"));
    const columns = check.prepare("PRAGMA table_info(instances)").all() as { name: string }[];
    const names = columns.map((c) => c.name);
    const row = check
      .prepare("SELECT last_activity_at FROM instances WHERE id = ?")
      .get(res.instance_id) as { last_activity_at: string };
    check.close();

    expect(names).toContain("last_activity_at");
    expect(names).not.toContain("last_heartbeat_at");
    expect(row.last_activity_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("recovers (refreshes) an existing row when its instance_id is supplied", async () => {
    seedBrain((db) => {
      db.exec(INSTANCES_DDL);
      insertInstance(db, {
        id: "i-known",
        project_slug: "demo",
        status: "stale", // make it stale so we can prove status flips back active
        current_brief: "OLD",
      });
      db.prepare(
        "UPDATE instances SET last_activity_at = datetime('now','-90 minutes') WHERE id = 'i-known'",
      ).run();
    });
    const m = await getModule();
    const res = m.registerOrUpdateInstanceState({
      instance_id: "i-known",
      machine_hostname: "host-recover",
      project_slug: "demo",
      current_brief: "BR-NEW",
    });
    expect(res.minted).toBe(false);
    expect(res.instance_id).toBe("i-known");
    m.closeDb();
    const check = new Database(join(tmpRoot, "memory", "knowledge.db"));
    const row = check
      .prepare(
        "SELECT status, current_brief, machine_hostname FROM instances WHERE id = 'i-known'",
      )
      .get() as { status: string; current_brief: string; machine_hostname: string };
    // Exactly ONE row (upsert, not a duplicate insert).
    const count = check
      .prepare("SELECT COUNT(*) AS n FROM instances WHERE id = 'i-known'")
      .get() as { n: number };
    check.close();
    expect(count.n).toBe(1);
    expect(row.status).toBe("active"); // refreshed back to active
    expect(row.current_brief).toBe("BR-NEW");
    expect(row.machine_hostname).toBe("host-recover");
  });

  it("stores liveness metadata when the migrated columns exist", async () => {
    seedBrain((db) => db.exec(INSTANCES_DDL + INSTANCE_LIVENESS_DDL));
    const m = await getModule();
    const res = m.registerOrUpdateInstanceState({
      machine_hostname: "host-1",
      project_slug: "demo",
      harness: "codex",
      owner_pid: 123,
      owner_started_at: "Mon Jun 29 00:00:00 2026",
      liveness_method: "pid_start_time",
      liveness_status: "alive",
      liveness_checked_at: "2026-06-29 00:00:00",
    });
    m.closeDb();
    const check = new Database(join(tmpRoot, "memory", "knowledge.db"));
    const row = check
      .prepare(
        "SELECT harness, owner_pid, owner_started_at, liveness_method, liveness_status FROM instances WHERE id = ?",
      )
      .get(res.instance_id) as {
      harness: string;
      owner_pid: number;
      owner_started_at: string;
      liveness_method: string;
      liveness_status: string;
    };
    check.close();
    expect(row).toEqual({
      harness: "codex",
      owner_pid: 123,
      owner_started_at: "Mon Jun 29 00:00:00 2026",
      liveness_method: "pid_start_time",
      liveness_status: "alive",
    });
  });

  it("instanceStateUpdate writes display state and a lease expiry", async () => {
    seedBrain((db) => {
      db.exec(INSTANCES_DDL + INSTANCE_LIVENESS_DDL);
      insertInstance(db, { id: "i-lease", project_slug: "demo" });
    });
    const m = await getModule();
    const updated = m.instanceStateUpdate({
      instance_id: "i-lease",
      current_brief: "FR-190",
      current_phase: "BUILDING",
      current_task: "implementing liveness",
      lease_expires_at: "2026-06-29 01:00:00",
    });
    expect(updated).toBe(true);
    m.closeDb();
    const check = new Database(join(tmpRoot, "memory", "knowledge.db"));
    const row = check
      .prepare(
        "SELECT current_brief, current_phase, current_task, lease_expires_at, state_updated_at FROM instances WHERE id = 'i-lease'",
      )
      .get() as {
      current_brief: string;
      current_phase: string;
      current_task: string;
      lease_expires_at: string;
      state_updated_at: string;
    };
    check.close();
    expect(row.current_brief).toBe("FR-190");
    expect(row.current_phase).toBe("BUILDING");
    expect(row.current_task).toBe("implementing liveness");
    expect(row.lease_expires_at).toBe("2026-06-29 01:00:00");
    expect(row.state_updated_at).toBeTruthy();
  });
});

describe("brain-db — sessionFileUpsert (WRITE: COALESCE non-destructive)", () => {
  it("throws BrainTableMissingError when session_files is absent (create-never)", async () => {
    seedBrain((db) => db.exec(INSTANCES_DDL));
    const m = await getModule();
    expect(() =>
      m.sessionFileUpsert({
        project: "demo",
        filename: "instances/x.md",
        content: "body",
      }),
    ).toThrow(m.BrainTableMissingError);
  });

  it("inserts a fresh row with state defaulting to 'live' on a content-only write", async () => {
    seedBrain((db) => db.exec(SESSION_FILES_DDL));
    const m = await getModule();
    m.sessionFileUpsert({
      project: "demo",
      filename: "instances/fresh.md",
      content: "hello",
    });
    m.closeDb();
    const row = readSessionRow("demo", "instances/fresh.md");
    expect(row?.state).toBe("live"); // COALESCE(?, 'live') on the INSERT branch
    expect(row?.instance_id).toBeNull();
    expect(row?.content).toBe("hello");
  });

  it("TD-279: a Buffer content is coerced and stored as TEXT, not a BLOB", async () => {
    seedBrain((db) => db.exec(SESSION_FILES_DDL));
    const m = await getModule();
    m.sessionFileUpsert({
      project: "demo",
      filename: "instances/buf.md",
      // A caller handing a Buffer must never land a BLOB in content.
      content: Buffer.from("body from buffer", "utf8") as unknown as string,
    });
    m.closeDb();
    const check = new Database(join(tmpRoot, "memory", "knowledge.db"));
    const row = check
      .prepare(
        "SELECT typeof(content) AS t, content FROM session_files WHERE project = ? AND filename = ?",
      )
      .get("demo", "instances/buf.md") as { t: string; content: string };
    check.close();
    expect(row.t).toBe("text");
    expect(row.content).toBe("body from buffer");
  });

  it("an OMITTED instance_id does NOT null an existing row's instance_id (#230 COALESCE)", async () => {
    seedBrain((db) => {
      db.exec(SESSION_FILES_DDL);
      insertSessionFile(db, {
        id: "r1",
        project: "demo",
        filename: "instances/keep.md",
        instance_id: "i-owner",
        state: "live",
        content: "v1",
      });
    });
    const m = await getModule();
    // A legacy content-only update (no instance_id, no state).
    m.sessionFileUpsert({
      project: "demo",
      filename: "instances/keep.md",
      content: "v2",
    });
    m.closeDb();
    const row = readSessionRow("demo", "instances/keep.md");
    expect(row?.instance_id).toBe("i-owner"); // preserved, NOT nulled
    expect(row?.state).toBe("live"); // preserved, NOT downgraded
    expect(row?.content).toBe("v2"); // content DID update
  });

  it("an OMITTED state does NOT downgrade an existing rested row to 'live'", async () => {
    seedBrain((db) => {
      db.exec(SESSION_FILES_DDL);
      insertSessionFile(db, {
        id: "r2",
        project: "demo",
        filename: "instances/rested.md",
        instance_id: "i-rest",
        state: "rested",
        content: "v1",
      });
    });
    const m = await getModule();
    m.sessionFileUpsert({
      project: "demo",
      filename: "instances/rested.md",
      content: "v2",
      instance_id: "i-rest",
      // state omitted
    });
    m.closeDb();
    const row = readSessionRow("demo", "instances/rested.md");
    expect(row?.state).toBe("rested"); // COALESCE(NULL, existing) → stays rested
  });

  it("an EXPLICIT state DOES update (e.g. flip to archived)", async () => {
    seedBrain((db) => {
      db.exec(SESSION_FILES_DDL);
      insertSessionFile(db, {
        id: "r3",
        project: "demo",
        filename: "instances/flip.md",
        instance_id: "i-x",
        state: "rested",
        content: "v1",
      });
    });
    const m = await getModule();
    m.sessionFileUpsert({
      project: "demo",
      filename: "instances/flip.md",
      content: "v1",
      state: "archived",
    });
    m.closeDb();
    const row = readSessionRow("demo", "instances/flip.md");
    expect(row?.state).toBe("archived");
    expect(row?.instance_id).toBe("i-x"); // instance_id omitted → preserved
  });
});

describe("brain-db — briefStatusSummary (summary-only counts)", () => {
  it("returns an empty summary (total 0) when brief_status is absent", async () => {
    const m = await getModule();
    expect(m.briefStatusSummary("demo")).toEqual({
      total: 0,
      by_status: {},
      by_priority: {},
    });
  });

  it("counts by status and priority, filtered by project, total = sum of status", async () => {
    seedBrain((db) => {
      db.exec(BRIEF_STATUS_DDL);
      const ins = db.prepare(
        "INSERT INTO brief_status (project, brief_id, title, status, priority) VALUES (?, ?, ?, ?, ?)",
      );
      ins.run("demo", "FR-1", "t1", "Ready", "P0");
      ins.run("demo", "FR-2", "t2", "Ready", "P1");
      ins.run("demo", "FR-3", "t3", "In Progress", "P0");
      ins.run("demo", "FR-4", "t4", "Done", null); // null priority → "Unset"
      // Other project — must be excluded.
      ins.run("other", "FR-9", "t9", "Ready", "P0");
    });
    const m = await getModule();
    const s = m.briefStatusSummary("demo");
    expect(s.total).toBe(4);
    expect(s.by_status).toEqual({ Ready: 2, "In Progress": 1, Done: 1 });
    expect(s.by_priority).toEqual({ P0: 2, P1: 1, Unset: 1 });
  });

  it("BR-082 — a null slug DROPS the predicate, counting every row", async () => {
    seedBrain((db) => {
      db.exec(BRIEF_STATUS_DDL);
      const ins = db.prepare(
        "INSERT INTO brief_status (project, brief_id, title, status, priority) VALUES (?, ?, ?, ?, ?)",
      );
      ins.run("demo", "FR-1", "t1", "Ready", "P0");
      ins.run("demo", "FR-2", "t2", "In Progress", "P1");
      ins.run("other", "FR-9", "t9", "Done", "P2");
      // NOTE for a future editor: there is deliberately no project-less row
      // here, and it is not an oversight. `brief_status.project` is `NOT NULL`
      // with a declared FK to `projects(slug)`, and better-sqlite3 enables
      // `foreign_keys` by DEFAULT on every handle — so neither a NULL nor an
      // orphan is reachable, and for THIS table "everything" and "all
      // projects" are the same set. (Do NOT restate this as "engine-enforced":
      // that phrasing implies the brain's connection differs from the CLI's,
      // it does not, and the wrong version cost a review round.) The
      // table where they genuinely diverge is `instances` (nullable
      // `project_slug`, no FK), and that divergence is exercised end-to-end in
      // `dashboard-server.test.ts`.
    });
    const m = await getModule();

    const demo = m.briefStatusSummary("demo");
    const other = m.briefStatusSummary("other");
    const all = m.briefStatusSummary(null);

    expect(all.total).toBe(3);
    expect(all.by_status).toEqual({ Ready: 1, "In Progress": 1, Done: 1 });
    expect(all.by_priority).toEqual({ P0: 1, P1: 1, P2: 1 });

    // Assert-then-diff. The widened read must equal the SUM of the scoped
    // reads and exceed either one, or "null widens" is unobservable.
    expect(all.total).toBe(demo.total + other.total);
    expect(all.total).toBeGreaterThan(demo.total);

    // Self-negative-control: the predicate still bites for a real slug, so
    // "null widens" cannot be confused with "the WHERE clause was deleted".
    expect(demo.total).toBe(2);
    expect(demo.by_status).toEqual({ Ready: 1, "In Progress": 1 });
    expect(other.by_status).toEqual({ Done: 1 });
  });
});

describe("brain-db — upcomingGoals (active goals within N days)", () => {
  it("returns [] when goals is absent", async () => {
    const m = await getModule();
    expect(m.upcomingGoals("demo", 14)).toEqual([]);
  });

  it("returns only active goals with a deadline within N days, project-filtered", async () => {
    seedBrain((db) => {
      db.exec(GOALS_DDL);
      const ins = db.prepare(
        "INSERT INTO goals (goal_id, project_slug, title, outcome, deadline, status, priority) VALUES (?, ?, ?, ?, date('now', ?), ?, ?)",
      );
      // within 14d, active → included
      ins.run("GL-1", "demo", "soon", "o", "+5 days", "active", "P0");
      // beyond 14d → excluded
      ins.run("GL-2", "demo", "later", "o", "+40 days", "active", "P1");
      // within 14d but achieved → excluded
      ins.run("GL-3", "demo", "done", "o", "+3 days", "achieved", "P2");
      // within 14d, active, but other project → excluded
      ins.run("GL-9", "other", "elsewhere", "o", "+2 days", "active", "P0");
      // active, NULL deadline → excluded (upcoming_days requires a deadline)
      db.prepare(
        "INSERT INTO goals (goal_id, project_slug, title, outcome, deadline, status, priority) VALUES ('GL-4','demo','nodate','o',NULL,'active','P3')",
      ).run();
    });
    const m = await getModule();
    const goals = m.upcomingGoals("demo", 14);
    expect(goals.map((g) => g.goal_id)).toEqual(["GL-1"]);
    expect(goals[0].title).toBe("soon");
    expect(goals[0].priority).toBe("P0");
  });
});
