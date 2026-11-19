/**
 * FR-274 — `igris project watermark`: the knowledge watermark writer.
 *
 * Real seeded brain DB under a fenced HOME (`fenceHome` — the verb reaches
 * `expandTilde`, a Tier-H builder, so IGRIS_BRAIN_DIR alone is not a fence)
 * and real git repositories — never a mock. The `projects` DDL is the brain's
 * core CREATE plus the projects:1 / projects:2 ALTERs VERBATIM; the bats
 * parity test (`cli/tests/integration/project-watermark.bats`) boots the
 * VENDORED engine instead, so a column-name drift reds there.
 *
 * Every assertion reads the ROW back (test_standards rule 1) — the digest is
 * checked against the row, never trusted alone.
 *
 *   - V1 (AC1) `normal` records the SHA, `feature/wm` and a DB-clock time,
 *     and leaves `last_session_at` untouched (D8);
 *   - V2 (AC3) `detached` records the SHA with a NULL branch;
 *   - V3 (M2) branch → detach → record: the branch becomes NULL (no COALESCE);
 *   - V4–V9 (AC2, M1, M3) missing / non-git / nested / unborn / broken / no-git:
 *     a pre-seeded watermark is byte-unchanged, exit 0, the reason in skipped[];
 *   - V10 (M9) an inherited GIT_DIR / GIT_WORK_TREE does not redirect the read;
 *   - V11 an unregistered slug creates no row;
 *   - V12 a brain without projects:2 degrades with the cause named;
 *   - V13 an unknown action exits 2;
 *   - V14 a `~/`-relative row path resolves under HOME;
 *   - M5 the CLI `upsertProject` never touches the triple.
 *
 * Red-first: run before `verbs/project.ts`, `lib/git-head.ts` and the
 * brain-db.ts writer existed (module resolution red, `evidence/E3-red.txt`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fenceHome, type HomeFence } from "./home-fence.js";

/** The brain's core `projects` CREATE (brain-mcp-server/src/db.ts), verbatim. */
const PROJECTS_DDL = `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    tech_stack TEXT DEFAULT '',
    igris_version TEXT DEFAULT '4.0.0',
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'inactive')),
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_session_at TEXT,
    metadata TEXT DEFAULT '{}',
    archetype TEXT DEFAULT 'unclassified'
  );
`;

/** projects:1 (repo_url) and projects:2 (the watermark), verbatim ALTERs. */
const V1_ALTER = "ALTER TABLE projects ADD COLUMN repo_url TEXT;";
const V2_ALTERS = `
  ALTER TABLE projects ADD COLUMN knowledge_sha TEXT;
  ALTER TABLE projects ADD COLUMN knowledge_branch TEXT;
  ALTER TABLE projects ADD COLUMN knowledge_recorded_at TEXT;
`;

const SEEDED = {
  knowledge_sha: "e".repeat(40),
  knowledge_branch: "seeded-branch",
  knowledge_recorded_at: "2026-01-01 00:00:00",
};

interface Triple {
  knowledge_sha: string | null;
  knowledge_branch: string | null;
  knowledge_recorded_at: string | null;
}

interface Digest {
  degraded: boolean;
  project: string;
  path: string | null;
  recorded: boolean;
  watermark: { sha: string; branch: string | null; recorded_at: string } | null;
  previous: { sha: string; branch: string | null; recorded_at: string | null } | null;
  skipped: string[];
}

let fence: HomeFence;
let work: string;

function dbFile(): string {
  return join(fence.brainDir, "memory", "knowledge.db");
}

function withDb<T>(fn: (db: Database.Database) => T): T {
  mkdirSync(join(fence.brainDir, "memory"), { recursive: true });
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function seedSchema(withWatermark = true): void {
  withDb((db) => db.exec(PROJECTS_DDL + V1_ALTER + (withWatermark ? V2_ALTERS : "")));
}

function register(slug: string, path: string, wm: Partial<Triple> | null = SEEDED): void {
  withDb((db) => {
    db.prepare("INSERT INTO projects (slug, name, path, last_session_at) VALUES (?, ?, ?, '2026-01-01 00:00:00')").run(slug, slug, path);
    if (wm !== null) {
      db.prepare("UPDATE projects SET knowledge_sha = ?, knowledge_branch = ?, knowledge_recorded_at = ? WHERE slug = ?")
        .run(wm.knowledge_sha ?? null, wm.knowledge_branch ?? null, wm.knowledge_recorded_at ?? null, slug);
    }
  });
}

function triple(slug: string): Triple | undefined {
  return withDb((db) => db
    .prepare("SELECT knowledge_sha, knowledge_branch, knowledge_recorded_at FROM projects WHERE slug = ?")
    .get(slug) as Triple | undefined);
}

function rowCount(): number {
  return withDb((db) => (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n);
}

// --- git fixtures (the fixture side strips inherited GIT_* too) --------------

function fixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"]) delete env[k];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return String(execFileSync("git", args, { cwd, env: fixtureEnv(), stdio: ["ignore", "pipe", "pipe"] })).trim();
}

function mkdir(name: string): string {
  const d = join(work, name);
  mkdirSync(d, { recursive: true });
  return d;
}

function commit(repo: string, msg: string): string {
  writeFileSync(join(repo, `${msg}.txt`), msg);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

/** `normal`: two commits, on the non-default branch `feature/wm`. */
function normalRepo(name: string): { path: string; sha: string } {
  const path = mkdir(name);
  git(path, "init", "-q");
  commit(path, "one");
  git(path, "checkout", "-q", "-b", "feature/wm");
  return { path, sha: commit(path, "two") };
}

async function run(opts: Record<string, unknown>): Promise<{ code: number; digest: Digest | null; stderr: string }> {
  const { runProject } = await import("../verbs/project.js");
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
    code = runProject(opts as never);
  } finally {
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
  const text = out.join("").trim();
  return { code, digest: text ? (JSON.parse(text) as Digest) : null, stderr: err.join("") };
}

beforeEach(() => {
  fence = fenceHome("igris-fr274-verb-");
  work = mkdtempSync(join(fence.home, "work-"));
});

afterEach(async () => {
  (await import("../lib/brain-db.js")).closeDb();
  (await import("../lib/registry.js")).closeDb();
  fence.release();
  vi.restoreAllMocks();
});

describe("igris project watermark — records HEAD of the row path (FR-274)", () => {
  it("V1 (AC1): a normal repo records the SHA, feature/wm and a DB-clock time; the digest echoes the row", async () => {
    fence.assertArmed();
    seedSchema();
    const { path, sha } = normalRepo("v1");
    register("v1", path);
    const { code, digest } = await run({ action: "watermark", project: "v1" });
    expect(code).toBe(0);
    const row = triple("v1")!;
    expect(row.knowledge_sha).toBe(sha);
    expect(row.knowledge_branch).toBe("feature/wm");
    expect(row.knowledge_recorded_at).not.toBeNull();
    expect(row.knowledge_recorded_at).not.toBe(SEEDED.knowledge_recorded_at);
    // D8: the writer never touches last_session_at (FR-271 owns that clock).
    expect(withDb((db) => (db.prepare("SELECT last_session_at FROM projects WHERE slug = 'v1'").get() as { last_session_at: string }).last_session_at))
      .toBe("2026-01-01 00:00:00");
    // The DB clock: within ±5 s of the same file's datetime('now').
    const now = withDb((db) => (db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t);
    expect(Math.abs(Date.parse(`${row.knowledge_recorded_at}Z`) - Date.parse(`${now}Z`))).toBeLessThanOrEqual(5_000);
    expect(digest).toEqual({
      degraded: false,
      project: "v1",
      path,
      recorded: true,
      watermark: { sha, branch: "feature/wm", recorded_at: row.knowledge_recorded_at },
      previous: { sha: SEEDED.knowledge_sha, branch: SEEDED.knowledge_branch, recorded_at: SEEDED.knowledge_recorded_at },
      skipped: [],
    });
  });

  it("V2 (AC3): a detached HEAD records the SHA with branch NULL", async () => {
    seedSchema();
    const { path } = normalRepo("v2");
    git(path, "checkout", "-q", "--detach", "HEAD~1");
    const sha = git(path, "rev-parse", "HEAD");
    register("v2", path, null);
    const { code, digest } = await run({ action: "watermark", project: "v2" });
    expect(code).toBe(0);
    expect(triple("v2")).toMatchObject({ knowledge_sha: sha, knowledge_branch: null });
    expect(triple("v2")!.knowledge_recorded_at).not.toBeNull();
    expect(digest!.watermark).toMatchObject({ sha, branch: null });
    expect(digest!.previous).toBeNull();
  });

  it("V3 (M2): record on a branch, detach, record again — the branch becomes NULL, never the stale one", async () => {
    seedSchema();
    const { path, sha } = normalRepo("v3");
    register("v3", path, null);
    await run({ action: "watermark", project: "v3" });
    expect(triple("v3")).toMatchObject({ knowledge_sha: sha, knowledge_branch: "feature/wm" });
    git(path, "checkout", "-q", "--detach", "HEAD~1");
    const detached = git(path, "rev-parse", "HEAD");
    await run({ action: "watermark", project: "v3" });
    expect(triple("v3")).toMatchObject({ knowledge_sha: detached, knowledge_branch: null });
  });

  describe("V4–V9 (AC2): every failure path leaves a known watermark byte-unchanged", () => {
    async function expectUnchanged(slug: string, reason: RegExp): Promise<void> {
      const before = triple(slug);
      expect(before).toEqual(SEEDED);
      const { code, digest, stderr } = await run({ action: "watermark", project: slug });
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(triple(slug)).toEqual(before);
      expect(digest!.recorded).toBe(false);
      expect(digest!.watermark).toBeNull();
      expect(digest!.skipped).toHaveLength(1);
      expect(digest!.skipped[0]).toMatch(reason);
    }

    it("V4 missing path", async () => {
      seedSchema();
      register("v4", join(work, "gone"));
      await expectUnchanged("v4", /path absent/);
    });

    it("V5 non-git directory", async () => {
      seedSchema();
      register("v5", mkdir("plain"));
      await expectUnchanged("v5", /not a git working copy/);
    });

    it("V6 (M3) a directory NESTED inside a repo — never the parent repo's HEAD", async () => {
      seedSchema();
      const { path } = normalRepo("v6");
      const nested = join(path, "packages", "sub");
      mkdirSync(nested, { recursive: true });
      register("v6", nested);
      await expectUnchanged("v6", /not a repo top level/);
    });

    it("V7 unborn HEAD (git init, no commit)", async () => {
      seedSchema();
      const path = mkdir("unborn");
      git(path, "init", "-q");
      register("v7", path);
      await expectUnchanged("v7", /no commit at HEAD/);
    });

    it("V8 broken HEAD (.git/HEAD overwritten)", async () => {
      seedSchema();
      const { path } = normalRepo("v8");
      writeFileSync(join(path, ".git", "HEAD"), "garbage\n");
      register("v8", path);
      await expectUnchanged("v8", /not a git working copy|no commit at HEAD/);
    });

    it("V9 git not on PATH", async () => {
      seedSchema();
      const { path } = normalRepo("v9");
      register("v9", path);
      const savedPath = process.env.PATH;
      process.env.PATH = mkdir("empty-bin");
      try {
        await expectUnchanged("v9", /git not available/);
      } finally {
        process.env.PATH = savedPath;
      }
    });
  });

  it("V10 (M9): an inherited GIT_DIR / GIT_WORK_TREE does not redirect the read", async () => {
    seedSchema();
    const { path, sha } = normalRepo("v10");
    const other = normalRepo("v10-other");
    commit(other.path, "three");
    const otherSha = git(other.path, "rev-parse", "HEAD");
    expect(otherSha).not.toBe(sha);
    register("v10", path);
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(other.path, ".git");
    process.env.GIT_WORK_TREE = other.path;
    try {
      await run({ action: "watermark", project: "v10" });
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.tree;
    }
    expect(triple("v10")!.knowledge_sha).toBe(sha);
  });

  it("V11: an unregistered slug is skipped and no row is created", async () => {
    seedSchema();
    const { code, digest } = await run({ action: "watermark", project: "nobody" });
    expect(code).toBe(0);
    expect(digest!.skipped).toEqual(["project not registered"]);
    expect(digest!.recorded).toBe(false);
    expect(rowCount()).toBe(0);
  });

  it("V12: a brain without projects:2 degrades with the cause named, exit 0, row unchanged", async () => {
    seedSchema(false);
    const { path } = normalRepo("v12");
    register("v12", path, null);
    const before = withDb((db) => db.prepare("SELECT * FROM projects WHERE slug = 'v12'").get());
    const { code, digest } = await run({ action: "watermark", project: "v12" });
    expect(code).toBe(0);
    expect(digest!.degraded).toBe(true);
    expect(digest!.recorded).toBe(false);
    expect(digest!.skipped[0]).toMatch(/projects:2 not applied/);
    expect(withDb((db) => db.prepare("SELECT * FROM projects WHERE slug = 'v12'").get())).toEqual(before);
  });

  it("V12b: no brain DB at all degrades, exit 0", async () => {
    const { code, digest } = await run({ action: "watermark", project: "x" });
    expect(code).toBe(0);
    expect(digest).toMatchObject({ degraded: true, recorded: false, skipped: ["brain db absent"] });
  });

  it("V13: an unknown action exits 2 with no digest", async () => {
    // FR-273 made `relations` (this test's original unknown action) a real one.
    const { code, digest, stderr } = await run({ action: "bogus", project: "x" });
    expect(code).toBe(2);
    expect(digest).toBeNull();
    expect(stderr).toMatch(/unknown project action 'bogus'/);
  });

  it("V14: a ~/-relative row path resolves under HOME", async () => {
    fence.assertArmed();
    seedSchema();
    const repo = join(fence.home, "tilde-repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    const sha = commit(repo, "tilde");
    register("v14", "~/tilde-repo", null);
    const { digest } = await run({ action: "watermark", project: "v14" });
    expect(triple("v14")!.knowledge_sha).toBe(sha);
    expect(digest!.path).toBe("~/tilde-repo"); // the row's path, as stored
  });

  it("M5: the CLI upsertProject (igris register-project's writer) leaves the triple unchanged", async () => {
    seedSchema();
    const { path } = normalRepo("m5");
    register("m5", path);
    const { upsertProject } = await import("../lib/registry.js");
    upsertProject({ slug: "m5", name: "m5", path, tech_stack: "ts", igris_version: "7.3.2" });
    expect(triple("m5")).toEqual(SEEDED);
    // The upsert DID apply — the pin is not vacuous.
    expect(withDb((db) => (db.prepare("SELECT igris_version FROM projects WHERE slug = 'm5'").get() as { igris_version: string }).igris_version)).toBe("7.3.2");
  });
});
