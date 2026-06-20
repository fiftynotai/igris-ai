/**
 * FR-195 (M1) — brain-db.ts accessor tests.
 *
 * Each accessor is exercised against a REAL seeded tmp DB (IGRIS_BRAIN_DIR
 * sandboxed). We NEVER mock better-sqlite3 — that is the module under test's
 * own dependency, and mocking it would erase the bug surface (#159 / L-159 /
 * TD-098). The seed DDL is copied from the brain's authoritative schema:
 *   - session_files: sessions component schema v1 + v2 ALTERs
 *     (brain-mcp-server/src/engine/components/sessions/schema.ts:39-63)
 *   - instances:     db.ts:328-341 (migration v4)
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
    last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT DEFAULT '{}'
  );
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
    last_heartbeat_at?: string;
  },
): void {
  db.prepare(
    `INSERT INTO instances (id, machine_hostname, project_slug, current_brief, status, last_heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    "host-" + row.id,
    row.project_slug ?? "demo",
    row.current_brief ?? null,
    row.status ?? "active",
    // Default heartbeat = now so the row is non-stale unless a test overrides.
    row.last_heartbeat_at ?? new Date().toISOString().replace("T", " ").substring(0, 19),
  );
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

  it("marks an instance stale when last heartbeat is >45min old (side-effect)", async () => {
    seedBrain((db) => {
      db.exec(INSTANCES_DDL);
      // 60 minutes ago — should be auto-marked stale by listInstances.
      insertInstance(db, {
        id: "i-old",
        project_slug: "demo",
        last_heartbeat_at: "datetime-placeholder",
      });
      // overwrite with a real 60-min-ago timestamp via SQL
      db.prepare(
        "UPDATE instances SET last_heartbeat_at = datetime('now','-60 minutes') WHERE id = 'i-old'",
      ).run();
    });
    const m = await getModule();
    // status='active' filter → the now-stale row is excluded.
    const active = m.listInstances({ project: "demo", status: "active" });
    expect(active.find((r) => r.id === "i-old")).toBeUndefined();
    // include_stale → it surfaces with status='stale' (the mutation landed).
    const all = m.listInstances({
      project: "demo",
      status: "all",
      includeStale: true,
    });
    const stale = all.find((r) => r.id === "i-old");
    expect(stale).toBeDefined();
    expect(stale?.status).toBe("stale");
  });

  it("purges an instance stale for >240min (side-effect)", async () => {
    seedBrain((db) => {
      db.exec(INSTANCES_DDL);
      insertInstance(db, { id: "i-dead", project_slug: "demo" });
      db.prepare(
        "UPDATE instances SET last_heartbeat_at = datetime('now','-300 minutes') WHERE id = 'i-dead'",
      ).run();
    });
    const m = await getModule();
    // Even with include_stale it is GONE — purged from the table entirely.
    const all = m.listInstances({
      project: "demo",
      status: "all",
      includeStale: true,
    });
    expect(all.find((r) => r.id === "i-dead")).toBeUndefined();
    // And the row is physically deleted (purge, not just hidden).
    m.closeDb();
    const check = new Database(join(tmpRoot, "memory", "knowledge.db"));
    const row = check
      .prepare("SELECT id FROM instances WHERE id = 'i-dead'")
      .get();
    check.close();
    expect(row).toBeUndefined();
  });

  it("the staleness side-effect touches instances ONLY, never session_files (#220)", async () => {
    seedBrain((db) => {
      db.exec(INSTANCES_DDL);
      db.exec(SESSION_FILES_DDL);
      // An ABANDONED-LIVE-shaped row: a live session file whose owner is stale.
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
        "UPDATE instances SET last_heartbeat_at = datetime('now','-300 minutes') WHERE id = 'i-crash'",
      ).run();
    });
    const m = await getModule();
    m.listInstances({ project: "demo", status: "active" }); // triggers purge
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

describe("brain-db — heartbeat (WRITE: mint-or-recover upsert)", () => {
  it("throws BrainTableMissingError when instances is absent (create-never)", async () => {
    // DB exists with only session_files — instances absent. A WRITE must NOT
    // silently no-op (the symmetric opposite of reads), and must NOT CREATE.
    seedBrain((db) => db.exec(SESSION_FILES_DDL));
    const m = await getModule();
    expect(() =>
      m.heartbeat({ machine_hostname: "host-1", project_slug: "demo" }),
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
    const res = m.heartbeat({
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
        "UPDATE instances SET last_heartbeat_at = datetime('now','-90 minutes') WHERE id = 'i-known'",
      ).run();
    });
    const m = await getModule();
    const res = m.heartbeat({
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
