/**
 * FR-195 (M2) — assess digest tests (MINIMAL D-A).
 *
 * Proven: the minimal digest shape (briefs + blockers + git + active_instances
 * + goals_upcoming), the empty-DB degraded digest, BLOCKERS.md present/absent,
 * the goals(14d) projection, and — the D-A guardrail — that NO task/perception/
 * cross-project fields leak into the digest.
 *
 * Real seeded brain DB (IGRIS_BRAIN_DIR, never a mock — #159). The git snapshot
 * is exercised against a real temp git repo created in the test (no mock); the
 * non-repo path is also covered (branch null).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssessDigest } from "../types.js";

let tmpRoot: string;
let savedEnv: NodeJS.ProcessEnv;

const SESSION_FILES_DDL = `
  CREATE TABLE IF NOT EXISTS session_files (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, filename TEXT NOT NULL,
    content TEXT NOT NULL, content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project, filename)
  );
  ALTER TABLE session_files ADD COLUMN instance_id TEXT;
  ALTER TABLE session_files ADD COLUMN state TEXT NOT NULL DEFAULT 'live';
`;

const INSTANCES_DDL = `
  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY, machine_hostname TEXT NOT NULL, machine_os TEXT,
    project_slug TEXT, project_path TEXT, current_brief TEXT, current_phase TEXT,
    current_task TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active','idle','stale')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT DEFAULT '{}'
  );
`;

const BRIEF_STATUS_DDL = `
  CREATE TABLE IF NOT EXISTS brief_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, brief_id TEXT NOT NULL,
    brief_type TEXT, title TEXT NOT NULL, status TEXT NOT NULL, priority TEXT,
    effort TEXT, phase TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_status_unique ON brief_status(project, brief_id);
`;

const GOALS_DDL = `
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL UNIQUE,
    project_slug TEXT, title TEXT NOT NULL, description TEXT, outcome TEXT NOT NULL,
    deadline TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active','achieved','abandoned','deferred')),
    priority TEXT NOT NULL DEFAULT 'P2-Medium',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    achieved_at TEXT, metadata TEXT NOT NULL DEFAULT '{}'
  );
`;

const SLUG = "demo";

function dbFile(): string {
  return join(tmpRoot, "memory", "knowledge.db");
}

function seedFullSchema(): void {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  db.exec(SESSION_FILES_DDL);
  db.exec(INSTANCES_DDL);
  db.exec(BRIEF_STATUS_DDL);
  db.exec(GOALS_DDL);
  db.close();
}

function withDb(fn: (db: Database.Database) => void): void {
  const db = new Database(dbFile());
  fn(db);
  db.close();
}

/** Write session/BLOCKERS.md for the project. */
function writeBlockers(text: string): void {
  const dir = join(tmpRoot, "projects", SLUG, "session");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "BLOCKERS.md"), text, "utf-8");
}

async function closeBrainDb(): Promise<void> {
  (await import("../lib/brain-db.js")).closeDb();
}

/** Build the assess digest directly (cwd defaults to a non-git temp dir). */
async function assess(cwd?: string): Promise<AssessDigest> {
  const { buildAssessDigest } = await import("../verbs/assess.js");
  return buildAssessDigest(SLUG, cwd ?? tmpRoot);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-assess-"));
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

describe("assess — MINIMAL D-A digest", () => {
  it("empty brain DB → degraded digest, exit-0 shape (no resume blocking)", async () => {
    // No seedFullSchema() → no DB file.
    const d = await assess();
    expect(d.degraded).toBe(true);
    expect(d.briefs).toEqual({ total: 0, by_status: {}, by_priority: {} });
    expect(d.active_instances).toBe(0);
    expect(d.goals_upcoming).toEqual([]);
  });

  it("the digest has EXACTLY the D-A fields — NO task/perception/cross-project keys", async () => {
    seedFullSchema();
    const d = await assess();
    expect(Object.keys(d).sort()).toEqual([
      "active_instances",
      "blockers",
      "briefs",
      "degraded",
      "git",
      "goals_upcoming",
    ]);
    // The deliberately-OMITTED surfaces must NOT appear (D-A guardrail).
    const asRecord = d as unknown as Record<string, unknown>;
    expect(asRecord.tasks).toBeUndefined();
    expect(asRecord.task_queue).toBeUndefined();
    expect(asRecord.perception).toBeUndefined();
    expect(asRecord.perception_pending).toBeUndefined();
    expect(asRecord.recall).toBeUndefined();
    expect(asRecord.cross_project).toBeUndefined();
  });

  it("summarises briefs (counts by status + priority) and counts active instances", async () => {
    seedFullSchema();
    withDb((db) => {
      const ib = db.prepare(
        "INSERT INTO brief_status (project, brief_id, title, status, priority) VALUES (?, ?, ?, ?, ?)",
      );
      ib.run(SLUG, "FR-1", "t1", "Ready", "P0");
      ib.run(SLUG, "FR-2", "t2", "Done", "P2");
      db.prepare(
        `INSERT INTO instances (id, machine_hostname, project_slug, status, last_activity_at)
         VALUES ('i-1', 'h', ?, 'active', datetime('now'))`,
      ).run(SLUG);
    });
    const d = await assess();
    expect(d.degraded).toBe(false);
    expect(d.briefs.total).toBe(2);
    expect(d.briefs.by_status).toEqual({ Ready: 1, Done: 1 });
    expect(d.briefs.by_priority).toEqual({ P0: 1, P2: 1 });
    expect(d.active_instances).toBe(1);
  });

  it("reads BLOCKERS.md bullets (present) and returns [] (absent)", async () => {
    seedFullSchema();
    // Absent first.
    let d = await assess();
    expect(d.blockers).toEqual([]);
    // Now write a blockers file with bullets + a heading + blank line.
    writeBlockers("# Blockers\n\n- VPS down\n- waiting on review\n\nnotes line\n");
    await closeBrainDb();
    d = await assess();
    expect(d.blockers).toEqual(["VPS down", "waiting on review"]);
  });

  it("lists only active goals with a deadline within 14 days", async () => {
    seedFullSchema();
    withDb((db) => {
      const ig = db.prepare(
        "INSERT INTO goals (goal_id, project_slug, title, outcome, deadline, status, priority) VALUES (?, ?, ?, ?, date('now', ?), ?, ?)",
      );
      ig.run("GL-1", SLUG, "near", "o", "+7 days", "active", "P0");
      ig.run("GL-2", SLUG, "far", "o", "+30 days", "active", "P1");
      ig.run("GL-3", SLUG, "achieved", "o", "+2 days", "achieved", "P2");
    });
    const d = await assess();
    expect(d.goals_upcoming.map((g) => g.goal_id)).toEqual(["GL-1"]);
    expect(d.goals_upcoming[0].title).toBe("near");
  });

  it("git snapshot: non-git cwd → branch null, dirty false, ahead 0", async () => {
    seedFullSchema();
    const d = await assess(tmpRoot); // tmpRoot is not a git repo
    expect(d.git.branch).toBeNull();
    expect(d.git.dirty).toBe(false);
    expect(d.git.ahead).toBe(0);
  });

  it("git snapshot: a real repo with an uncommitted file → branch set, dirty true", async () => {
    seedFullSchema();
    // Build a tiny real git repo in a temp dir.
    const repo = mkdtempSync(join(tmpdir(), "igris-assess-repo-"));
    const gitOpts = {
      cwd: repo,
      stdio: ["ignore", "ignore", "ignore"] as const,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    };
    execFileSync("git", ["init", "-b", "work"], gitOpts);
    writeFileSync(join(repo, "a.txt"), "hello", "utf-8");
    execFileSync("git", ["add", "a.txt"], gitOpts);
    execFileSync("git", ["commit", "-m", "init"], gitOpts);
    // Now make the tree dirty.
    writeFileSync(join(repo, "a.txt"), "changed", "utf-8");

    const d = await assess(repo);
    expect(d.git.branch).toBe("work");
    expect(d.git.dirty).toBe(true);
    // No upstream configured → ahead is 0 (never throws).
    expect(d.git.ahead).toBe(0);
  });
});
