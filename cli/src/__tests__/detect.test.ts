/**
 * FR-195 (M1) — detect.ts capability-detection tests.
 *
 * Each `mode` is produced from a sandboxed brain dir (IGRIS_BRAIN_DIR) by
 * toggling the four real signals: the brain DB file's existence, config.json's
 * remote_brain block, sqlite3 on PATH, and the harness env markers. No mocks —
 * we manipulate the actual filesystem + env the detector reads.
 *
 * TD-359: project_slug / project_source come from the project resolver, so the
 * identity cases build a REAL temp git repo + linked worktree and point the
 * detector at it with a `process.cwd` spy (vitest workers cannot chdir). Git is
 * exposed through a PATH holding only a `git` symlink, so the sqlite3 signal is
 * unaffected; an empty PATH is the "git missing" case.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HARNESS_ENV_MARKERS } from "../lib/detect.js";
import { restoreEnv } from "./home-fence.js";

let tmpRoot: string;
let homeRoot: string;
let fxRoot: string;
let savedEnv: NodeJS.ProcessEnv;

/**
 * TD-359 — the PATH the suite was launched with, captured at module load
 * (before `beforeEach` empties PATH). The git fixtures run under it, and
 * {@link gitOnlyPath} exposes ONLY `git` from it to the detector, so the
 * sqlite3 signal stays absent unless a case adds it.
 */
const LAUNCH_PATH = process.env.PATH ?? "";
const REAL_GIT = spawnSync("/bin/sh", ["-c", "command -v git"], {
  encoding: "utf-8",
  timeout: 5000,
  env: { PATH: LAUNCH_PATH },
}).stdout.trim();

const GIT_ENV_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
] as const;

/** Fixture git (location variables stripped, launch PATH); throws on failure. */
function fixtureGit(cwd: string, ...args: string[]): void {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: LAUNCH_PATH, GIT_TERMINAL_PROMPT: "0" };
  for (const k of GIT_ENV_STRIP) delete env[k];
  const r = spawnSync(
    "git",
    [
      "-c", "user.name=igris-vitest",
      "-c", "user.email=vitest@igris.invalid",
      "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf-8", env, timeout: 10_000 },
  );
  if (r.status !== 0) {
    throw new Error(`fixture git ${args.join(" ")} failed (${String(r.status)}): ${r.stderr ?? ""}`);
  }
}

/**
 * A real repo `<fx>/repos/<mainName>` with one commit, and a linked worktree
 * `<fx>/elsewhere/wt-td359` whose leaf is NOT the repo's name — the TD-359
 * failure shape (`…/agents/mbrgea-ai-gl010`).
 */
function makeWorktreeFixture(mainName = "gproj"): { main: string; wt: string } {
  const main = join(fxRoot, "repos", mainName);
  mkdirSync(main, { recursive: true });
  fixtureGit(main, "init", "-q");
  writeFileSync(join(main, "README.md"), "fixture\n");
  fixtureGit(main, "add", "README.md");
  fixtureGit(main, "commit", "-q", "--no-verify", "-m", "init");
  const wt = join(fxRoot, "elsewhere", "wt-td359");
  mkdirSync(dirname(wt), { recursive: true });
  fixtureGit(main, "worktree", "add", "-q", "-b", "td359-detect", wt);
  return { main, wt };
}

/** A PATH holding only a `git` symlink to the real binary. */
function gitOnlyPath(): string {
  const bin = join(fxRoot, "git-bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(REAL_GIT, join(bin, "git"));
  return bin;
}

/** Register `slug` at `path` in the sandboxed brain's `projects` table. */
function registerProject(slug: string, path: string): void {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  const db = new Database(join(tmpRoot, "memory", "knowledge.db"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active', registered_at TEXT, last_session_at TEXT, metadata TEXT)",
  );
  db.prepare("INSERT INTO projects (slug, name, path) VALUES (?, ?, ?)").run(slug, slug, path);
  db.close();
}

/** Write a knowledge.db file so existsSync(brainDbPath()) is true. */
function makeBrainDb(): void {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  writeFileSync(join(tmpRoot, "memory", "knowledge.db"), "");
}

/** Write config.json with a configured remote_brain block. */
function makeRemoteConfig(): void {
  writeFileSync(
    join(tmpRoot, "config.json"),
    JSON.stringify({ remote_brain: { url: "http://h:1", api_key: "k" } }),
  );
}

/** Put a fake `sqlite3` binary on PATH (a tmp bin dir prepended). */
function makeSqlite3OnPath(): string {
  const binDir = join(tmpRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "sqlite3"), "#!/bin/sh\n");
  return binDir;
}

async function getModule(): Promise<typeof import("../lib/detect.js")> {
  return await import("../lib/detect.js");
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-detect-"));
  homeRoot = mkdtempSync(join(tmpdir(), "igris-cli-detect-home-"));
  fxRoot = realpathSync(mkdtempSync(join(tmpdir(), "igris-cli-detect-fx-")));
  // Snapshot env so per-test mutations (PATH, harness markers) are reverted.
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  // TD-359: detect now walks for a `.igris-project` marker that stops at
  // $HOME, so the file fences HOME too (restored BY KEY in afterEach).
  process.env.HOME = homeRoot;
  for (const k of GIT_ENV_STRIP) delete process.env[k];
  // Neutralize harness markers + PATH so a test starts from a known floor.
  // Use the shared marker list so a live harness's ambient marker (incl. the
  // Cursor markers this list previously omitted) cannot leak in (TD-299).
  for (const k of HARNESS_ENV_MARKERS) {
    delete process.env[k];
  }
  // Empty PATH so sqlite3 is absent unless a test adds it.
  process.env.PATH = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(homeRoot, { recursive: true, force: true });
  rmSync(fxRoot, { recursive: true, force: true });
  restoreEnv(savedEnv);
});

describe("detect — mode", () => {
  it("full: brain DB present + remote_brain configured (identity read from a temp git worktree, TD-359)", async () => {
    // TD-359 rewrite. This case used to pin `project_slug === basename(cwd)`
    // with vitest's own cwd (`cli/`), which is exactly the defect: under the
    // resolver that cwd resolves to its repo's project, not "cli". The
    // identity now comes from a fixture whose answer is fixed by the test: a
    // subdirectory of a linked worktree `wt-td359` of the unregistered repo
    // `gproj`. project_path stays the process cwd (MAINTAINING row 83).
    makeBrainDb();
    makeRemoteConfig();
    const { wt } = makeWorktreeFixture("gproj");
    const cwd = join(wt, "sub");
    mkdirSync(cwd, { recursive: true });
    process.env.PATH = gitOnlyPath();
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.brain_root).toBe(tmpRoot);
    expect(r.project_path).toBe(cwd);
    expect(r.project_slug).toBe("gproj");
    expect((r as { project_source?: string }).project_source).toBe("git-main");
    expect(r.brain_db).toBe(true);
    expect(r.remote_brain).toBe(true);
    expect(r.mode).toBe("full");
  });

  it("degraded-no-db: brain DB absent (dominates even if remote configured)", async () => {
    // remote config present, but no DB file → no-db dominates.
    makeRemoteConfig();
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.brain_db).toBe(false);
    expect(r.mode).toBe("degraded-no-db");
  });

  it("degraded-no-remote: brain DB present but remote_brain unconfigured", async () => {
    makeBrainDb();
    // no config.json at all → readRemoteBrainConfig() === null
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.brain_db).toBe(true);
    expect(r.remote_brain).toBe(false);
    expect(r.mode).toBe("degraded-no-remote");
  });

  it("sqlite3 flag reflects PATH presence, independent of mode", async () => {
    makeBrainDb();
    makeRemoteConfig();
    const binDir = makeSqlite3OnPath();
    process.env.PATH = binDir;
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.sqlite3).toBe(true);
    expect(r.mode).toBe("full");
  });

  it("sqlite3 false when absent from PATH", async () => {
    makeBrainDb();
    makeRemoteConfig();
    // PATH already "" from beforeEach
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.sqlite3).toBe(false);
  });
});

describe("detect — harness inference", () => {
  it("claude from CLAUDECODE", async () => {
    process.env.CLAUDECODE = "1";
    const m = await getModule();
    expect(m.detectCapabilities().harness).toBe("claude");
  });

  it("antigravity marker wins over gemini-family", async () => {
    process.env.ANTIGRAVITY = "1";
    process.env.GEMINI_CLI = "1";
    const m = await getModule();
    expect(m.detectCapabilities().harness).toBe("antigravity");
  });

  it("gemini from GEMINI_CLI", async () => {
    process.env.GEMINI_CLI = "1";
    const m = await getModule();
    expect(m.detectCapabilities().harness).toBe("gemini");
  });

  it("codex from CODEX_SESSION", async () => {
    process.env.CODEX_SESSION = "1";
    const m = await getModule();
    expect(m.detectCapabilities().harness).toBe("codex");
  });

  it("opencode from OPENCODE", async () => {
    process.env.OPENCODE = "1";
    const m = await getModule();
    expect(m.detectCapabilities().harness).toBe("opencode");
  });

  it("unknown when no marker is present", async () => {
    const m = await getModule();
    expect(m.detectCapabilities().harness).toBe("unknown");
  });
});

describe("detect — project identity (TD-359)", () => {
  it("a worktree of a REGISTERED project reports the registry slug (project_source 'registry'), not the worktree's name", async () => {
    const { main, wt } = makeWorktreeFixture("checkout");
    registerProject("igris-ai", main);
    process.env.PATH = gitOnlyPath();
    vi.spyOn(process, "cwd").mockReturnValue(wt);
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.project_slug).toBe("igris-ai");
    expect((r as { project_source?: string }).project_source).toBe("registry");
    expect(r.project_path).toBe(wt);
  });

  it("degraded-safe: with git absent from PATH and no brain DB it returns basename(cwd), project_source 'basename', and every key", async () => {
    const { wt } = makeWorktreeFixture("gproj");
    // PATH is "" from beforeEach: no git, no sqlite3. No knowledge.db.
    vi.spyOn(process, "cwd").mockReturnValue(wt);
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.project_slug).toBe("wt-td359");
    expect((r as { project_source?: string }).project_source).toBe("basename");
    expect(r.project_path).toBe(wt);
    expect(r.mode).toBe("degraded-no-db");
    expect(Object.keys(r)).toEqual(
      expect.arrayContaining([
        "harness",
        "project_slug",
        "project_path",
        "brain_root",
        "brain_db",
        "sqlite3",
        "remote_brain",
        "mode",
        "project_source",
      ]),
    );
  });

  it("a non-git, unregistered cwd keeps basename(cwd) with git present (no regression)", async () => {
    const plain = join(fxRoot, "plain", "leaf-dir");
    mkdirSync(plain, { recursive: true });
    process.env.PATH = gitOnlyPath();
    vi.spyOn(process, "cwd").mockReturnValue(plain);
    const m = await getModule();
    const r = m.detectCapabilities();
    expect(r.project_slug).toBe("leaf-dir");
    expect((r as { project_source?: string }).project_source).toBe("basename");
    expect(r.project_path).toBe(plain);
  });
});
