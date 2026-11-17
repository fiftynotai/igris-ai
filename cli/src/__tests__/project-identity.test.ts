/**
 * TD-359 — `resolveProjectIdentity`, the TypeScript twin of the one project
 * resolver (PLAN §1.1 / §1.4), plus `defaultProjectSlug` and the read-only
 * registry reader `listProjectPathsReadonly` it walks.
 *
 * THE DEFECT. Every CLI surface derived the slug from `basename(cwd)`, so a git
 * worktree of a registered project (`…/agents/mbrgea-ai-gl010`) became a
 * phantom project with zero briefs. The resolver replaces that with ONE chain:
 *
 *   0. normalise  dir_real = realpath(dir) as `cd && pwd -P` gives it (a `..`
 *                 dropped textually, the letter case kept), or dir unchanged
 *   1. git probe  top = realpath(--show-toplevel); prefix = --show-prefix (same
 *                 call); common = --git-common-dir (absolute; the plain form
 *                 resolved from top/prefix on git < 2.31);
 *                 main = dirname(common) when basename(common) == ".git", else top.
 *                 GIT_DIR & co. are STRIPPED first; any failure → top = main = null.
 *                 here = top + prefix in git (git's spelling), else dir_real.
 *   2. marker     `.igris-project`, first line trimmed, slug.ts SLUG_RE.
 *                 In git: here … top (inclusive), plus main/ when main != top.
 *                 Outside git: here and ancestors, stopping BEFORE $HOME and /.
 *   3. registry   lookup_path = main + prefix in git, else here.
 *                 Deepest registered ancestor of lookup_path wins (`/` excluded),
 *                 the lowest rowid breaks a duplicate path; raw string compare.
 *   4. git-main   basename(main)
 *   5. basename   basename(dir_real) — the documented last resort.
 *
 * Every fixture is a REAL git repository under a realpath'd `mkdtemp`, and the
 * registry is a REAL SQLite file at `brainDbPath()` (`IGRIS_BRAIN_DIR`), so the
 * production readers run unmocked. The one injected seam is the git RUNNER
 * (PLAN §1.4: `deps` injects the git runner so the unit tests need no PATH
 * tricks); its contract is `git-head.ts#git`'s — `(cwd, args)` runs
 * `git -C cwd ...args` and returns `{ status, stdout, missing }`, with
 * `missing: true` for ENOENT.
 *
 * RED ON HEAD (5247c5a): `cli/src/lib/project-identity.ts` does not exist, so
 * every resolver case reds at its dynamic import; `listProjectPathsReadonly` is
 * not exported by `registry.ts`, so the reader cases red with "is not a
 * function". Each case imports dynamically so each one reds on its own.
 *
 * FENCE: HOME and IGRIS_BRAIN_DIR are one fresh path per test (HOME/.igris),
 * restored BY KEY. The fixtures live in a SEPARATE realpath'd mkdtemp, outside
 * HOME, so the outside-git marker walk is not stopped by HOME unless a case
 * puts its fixture under HOME on purpose (M8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The location variables a git hook exports (`git-head.ts` GIT_ENV_STRIP). */
const GIT_ENV_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
] as const;

/** The PLAN §1.4 output shape. */
interface Identity {
  slug: string;
  source: "marker" | "registry" | "git-main" | "basename";
  dir: string;
  worktree_root: string | null;
  main_root: string | null;
  lookup_path: string;
}

/** The injected runner's result — `git-head.ts#GitRun`. */
interface GitRun {
  status: number | null;
  stdout: string;
  missing: boolean;
}
type GitRunner = (cwd: string, args: readonly string[]) => GitRun;

type IdentityModule = {
  resolveProjectIdentity: (dir?: string, deps?: { git?: GitRunner }) => Identity;
  defaultProjectSlug: () => string;
};

async function loadResolver(): Promise<IdentityModule> {
  return (await import("../lib/project-identity.js")) as unknown as IdentityModule;
}

let home: string;
let sandbox: string;
let savedHome: string | undefined;
let savedBrainDir: string | undefined;
const savedGitEnv: Record<string, string | undefined> = {};
let branchSeq = 0;

function restoreKey(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "igris-pid-home-")));
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\n\tname = igris-vitest\n\temail = vitest@igris.invalid\n",
  );
  savedHome = process.env.HOME;
  savedBrainDir = process.env.IGRIS_BRAIN_DIR;
  process.env.HOME = home;
  process.env.IGRIS_BRAIN_DIR = join(home, ".igris");
  mkdirSync(join(home, ".igris"), { recursive: true });
  // An ambient GIT_DIR (a suite launched from inside a git hook) must not
  // reach either the fixtures or the resolver unless a case sets it.
  for (const k of GIT_ENV_STRIP) {
    savedGitEnv[k] = process.env[k];
    delete process.env[k];
  }
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "igris-pid-fx-")));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of GIT_ENV_STRIP) restoreKey(k, savedGitEnv[k]);
  restoreKey("HOME", savedHome);
  restoreKey("IGRIS_BRAIN_DIR", savedBrainDir);
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers — real git, real SQLite
// ---------------------------------------------------------------------------

/** Run fixture git with the location variables stripped; throw on failure. */
function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
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
  return (r.stdout ?? "").trim();
}

/** A real repo with one commit (a worktree needs a commit to branch from). */
function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "--no-verify", "-m", "init");
  return dir;
}

/** `git worktree add` at `wt` (parents created), on a fresh branch. */
function addWorktree(main: string, wt: string): string {
  mkdirSync(dirname(wt), { recursive: true });
  branchSeq += 1;
  git(main, "worktree", "add", "-q", "-b", `td359-${branchSeq}`, wt);
  return wt;
}

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMarker(dir: string, content: string): void {
  writeFileSync(join(dir, ".igris-project"), content);
}

/** `brainDbPath()` under the fence. */
function brainDb(): string {
  return join(process.env.IGRIS_BRAIN_DIR as string, "memory", "knowledge.db");
}

/** `registry.ts#getDb`'s DDL (no `id`; rowid = insertion order). */
const CLI_PROJECTS_DDL = `
  CREATE TABLE IF NOT EXISTS projects (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    tech_stack TEXT,
    igris_version TEXT,
    status TEXT DEFAULT 'active',
    registered_at TEXT,
    last_session_at TEXT,
    metadata TEXT
  );
`;

/** The brain's DDL (`brain-mcp-server/src/db.ts`): rowid IS `id`. */
const BRAIN_PROJECTS_DDL = `
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
    metadata TEXT DEFAULT '{}'
  );
`;

/** Append registry rows (creating the table on first use). */
function register(
  rows: Array<{ slug: string; path: string; id?: number }>,
  ddl: "cli" | "brain" = "cli",
): void {
  mkdirSync(dirname(brainDb()), { recursive: true });
  const db = new Database(brainDb());
  try {
    db.exec(ddl === "brain" ? BRAIN_PROJECTS_DDL : CLI_PROJECTS_DDL);
    for (const r of rows) {
      if (r.id !== undefined) {
        db.prepare("INSERT INTO projects (id, slug, name, path) VALUES (?, ?, ?, ?)").run(r.id, r.slug, r.slug, r.path);
      } else {
        db.prepare("INSERT INTO projects (slug, name, path) VALUES (?, ?, ?)").run(r.slug, r.slug, r.path);
      }
    }
  } finally {
    db.close();
  }
}

/** The real runner, `git-head.ts#git`'s shape, for wrapping in a stub. */
const realGit: GitRunner = (cwd, args) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const k of GIT_ENV_STRIP) delete env[k];
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
    env,
  });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return { status: r.error ? null : r.status, stdout: (r.stdout ?? "").trim(), missing };
};

/**
 * True on a case-INSENSITIVE volume (default APFS): a file created as
 * `CaseProbe` is found as `caseprobe`. Probed once, in the same tmpdir the
 * sandboxes live in. The letter-case cases skip on a case-sensitive volume,
 * where a mis-cased path simply does not exist.
 */
function caseInsensitiveTmp(): boolean {
  const d = mkdtempSync(join(tmpdir(), "igris-pid-case-"));
  try {
    writeFileSync(join(d, "CaseProbe"), "");
    return existsSync(join(d, "caseprobe"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const CASE_INSENSITIVE = caseInsensitiveTmp();

// ===========================================================================
// Rung 0 — normalisation
// ===========================================================================

describe("TD-359 resolver — rung 0: the input directory is realpath'd", () => {
  it("(N1) a symlinked checkout resolves through its realpath to the registered row (§1.5 row 12)", async () => {
    const main = makeRepo(join(sandbox, "real", "checkout"));
    register([{ slug: "proj-real", path: main }]);
    const link = join(mkdirp(join(sandbox, "links")), "proj-link");
    symlinkSync(main, link);

    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(link)).toMatchObject({
      slug: "proj-real",
      source: "registry",
      dir: main,
      worktree_root: main,
      main_root: main,
      lookup_path: main,
    });
  });

  it("(N2) a symlink to a non-git, unregistered directory takes the REAL directory's basename", async () => {
    const real = mkdirp(join(sandbox, "plain", "actual-dir"));
    const link = join(mkdirp(join(sandbox, "aliases")), "alias-dir");
    symlinkSync(real, link);

    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(link)).toMatchObject({
      slug: "actual-dir",
      source: "basename",
      dir: real,
      worktree_root: null,
      main_root: null,
      lookup_path: real,
    });
  });

  it("(N3) a nonexistent directory resolves to its own basename without throwing; dir stays raw", async () => {
    const gone = join(sandbox, "gone", "leaf-x");
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(gone)).toMatchObject({
      slug: "leaf-x",
      source: "basename",
      dir: gone,
      worktree_root: null,
      main_root: null,
    });
  });

  // The shell twin normalises with `cd -- dir && pwd -P`: bash's `cd` drops a
  // `..` TEXTUALLY (logical), then `pwd -P` resolves the symlinks left. The
  // twin must land where `cd` lands; realpath(3) would resolve the symlink
  // first and climb out of its TARGET (measured 2026-11-18).
  it("(N4) a `..` after a symlink is dropped textually, as the shell twin's `cd` does", async () => {
    const target = mkdirp(join(sandbox, "far", "target"));
    mkdirp(join(sandbox, "far", "beside"));
    const links = mkdirp(join(sandbox, "near"));
    const beside = mkdirp(join(links, "beside"));
    symlinkSync(target, join(links, "hop"));

    const { resolveProjectIdentity } = await loadResolver();
    // A raw string: path.join would drop the `..` before the resolver saw it.
    expect(resolveProjectIdentity(`${links}/hop/../beside`)).toMatchObject({
      slug: "beside",
      source: "basename",
      dir: beside,
      lookup_path: beside,
    });
  });

  // bash 3.2's `pwd -P` keeps the letter case it was given on a
  // case-insensitive volume; realpath(3) canonicalises it. Outside git there
  // is no git-reported spelling to fall back on, so the twins agree only if
  // neither canonicalises: the basename rung names the directory as given.
  it.skipIf(!CASE_INSENSITIVE)(
    "(N5) outside git a MIS-CASED input keeps its letter case, as the shell twin's `pwd -P` does",
    async () => {
      mkdirp(join(sandbox, "plain", "Leaf-Case"));
      const given = join(sandbox, "PLAIN", "leaf-case");
      const { resolveProjectIdentity } = await loadResolver();
      expect(resolveProjectIdentity(given)).toMatchObject({
        slug: "leaf-case",
        source: "basename",
        dir: given,
        worktree_root: null,
        main_root: null,
        lookup_path: given,
      });
    },
  );
});

// ===========================================================================
// Rung 1 — the git probe (and rung 4, git-main)
// ===========================================================================

describe("TD-359 resolver — rung 1: the git probe finds the main checkout", () => {
  it("(G1) an unregistered main checkout resolves to basename(main), source git-main (§1.5 row 7)", async () => {
    const main = makeRepo(join(sandbox, "repos", "gproj"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(main)).toMatchObject({
      slug: "gproj",
      source: "git-main",
      dir: main,
      worktree_root: main,
      main_root: main,
      lookup_path: main,
    });
  });

  it("(G2) a subdirectory of an unregistered repo resolves to the repo's name, not its own (§1.5 row 7)", async () => {
    const main = makeRepo(join(sandbox, "repos", "gproj"));
    const sub = mkdirp(join(main, "content", "deep"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(sub)).toMatchObject({
      slug: "gproj",
      source: "git-main",
      dir: sub,
      worktree_root: main,
      main_root: main,
      lookup_path: sub,
    });
  });

  it("(G3) a linked worktree outside the tree, named wt-x, resolves to basename(main)", async () => {
    const main = makeRepo(join(sandbox, "repos", "gproj"));
    const wt = addWorktree(main, join(sandbox, "elsewhere", "wt-x"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(wt)).toMatchObject({
      slug: "gproj",
      source: "git-main",
      dir: wt,
      worktree_root: wt,
      main_root: main,
      lookup_path: main,
    });
  });

  it("(G4) a worktree subdirectory translates onto the SAME subdirectory of the main checkout", async () => {
    const main = makeRepo(join(sandbox, "repos", "gproj"));
    const wt = addWorktree(main, join(sandbox, "elsewhere", "wt-sub"));
    const sub = mkdirp(join(wt, "packages", "app"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(sub)).toMatchObject({
      slug: "gproj",
      source: "git-main",
      dir: sub,
      worktree_root: wt,
      main_root: main,
      lookup_path: join(main, "packages", "app"),
    });
  });

  it("(G5) a separate git-dir (common dir not named .git) takes main = top, never dirname(common)", async () => {
    mkdirp(join(sandbox, "store"));
    const top = join(sandbox, "repos", "sepproj");
    mkdirp(dirname(top));
    git(sandbox, "init", "-q", `--separate-git-dir=${join(sandbox, "store", "sep.git")}`, top);
    writeFileSync(join(top, "README.md"), "fixture\n");
    git(top, "add", "README.md");
    git(top, "commit", "-q", "--no-verify", "-m", "init");
    const sub = mkdirp(join(top, "sub"));

    const { resolveProjectIdentity } = await loadResolver();
    // dirname(common) would be `<sandbox>/store` → slug "store".
    expect(resolveProjectIdentity(sub)).toMatchObject({
      slug: "sepproj",
      source: "git-main",
      worktree_root: top,
      main_root: top,
    });
  });

  it("(G6) GIT_DIR / GIT_WORK_TREE exported at ANOTHER repo are stripped (the git-head M9 shape)", async () => {
    const alpha = makeRepo(join(sandbox, "repos", "alpha"));
    const bravo = makeRepo(join(sandbox, "repos", "bravo"));
    process.env.GIT_DIR = join(bravo, ".git");
    process.env.GIT_WORK_TREE = bravo;
    process.env.GIT_INDEX_FILE = join(bravo, ".git", "index");

    // Arm: the exported variables really do poison an unstripped probe.
    const poisoned = spawnSync("git", ["-C", alpha, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 3000,
      env: { ...process.env },
    });
    expect(realpathSync(poisoned.stdout.trim())).toBe(bravo);

    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(alpha)).toMatchObject({
      slug: "alpha",
      source: "git-main",
      worktree_root: alpha,
      main_root: alpha,
    });
  });

  it("(G7) a worktree whose gitdir was deleted falls through to basename(dir) without throwing (§1.5 row 11)", async () => {
    const main = makeRepo(join(sandbox, "repos", "gproj"));
    const wt = addWorktree(main, join(sandbox, "elsewhere", "wt-broken"));
    rmSync(join(main, ".git", "worktrees", "wt-broken"), { recursive: true, force: true });
    // Arm: git itself now refuses the directory.
    expect(realGit(wt, ["rev-parse", "--show-toplevel"]).status).not.toBe(0);

    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(wt)).toMatchObject({
      slug: "wt-broken",
      source: "basename",
      dir: wt,
      worktree_root: null,
      main_root: null,
      lookup_path: wt,
    });
  });

  it("(G8) git MISSING (an injected runner reporting ENOENT) falls through to basename, never throws", async () => {
    const main = makeRepo(join(sandbox, "repos", "gproj"));
    const wt = addWorktree(main, join(sandbox, "elsewhere", "wt-nogit"));
    const calls: string[][] = [];
    const missingGit: GitRunner = (cwd, args) => {
      calls.push([cwd, ...args]);
      return { status: null, stdout: "", missing: true };
    };

    const { resolveProjectIdentity } = await loadResolver();
    // A real git would answer git-main "gproj"; the seam must be the one used.
    expect(resolveProjectIdentity(wt, { git: missingGit })).toMatchObject({
      slug: "wt-nogit",
      source: "basename",
      dir: wt,
      worktree_root: null,
      main_root: null,
      lookup_path: wt,
    });
    expect(calls.length).toBeGreaterThan(0);
  });

  it("(G8b) with git missing the registry walk still runs on the directory itself", async () => {
    const main = makeRepo(join(sandbox, "repos", "checkout"));
    register([{ slug: "proj-reg", path: main }]);
    const sub = mkdirp(join(main, "src"));
    const missingGit: GitRunner = () => ({ status: null, stdout: "", missing: true });

    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(sub, { git: missingGit })).toMatchObject({
      slug: "proj-reg",
      source: "registry",
      worktree_root: null,
      main_root: null,
      lookup_path: sub,
    });
  });

  it.each([
    ["a non-zero exit (broken binary)", { status: 128, stdout: "", missing: false }],
    ["a timeout (status null, not ENOENT)", { status: null, stdout: "", missing: false }],
  ])("(G9) a BROKEN git — %s — falls through the same way", async (_label, run) => {
    const main = makeRepo(join(sandbox, "repos", "gproj"));
    const wt = addWorktree(main, join(sandbox, "elsewhere", "wt-broken-git"));
    const brokenGit: GitRunner = () => ({ ...run });

    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(wt, { git: brokenGit })).toMatchObject({
      slug: "wt-broken-git",
      source: "basename",
      worktree_root: null,
      main_root: null,
    });
  });

  it("(G10) git < 2.31 refuses --path-format: the plain --git-common-dir is resolved from dir (relative and absolute forms)", async () => {
    const main = makeRepo(join(sandbox, "repos", "gproj"));
    const deep = mkdirp(join(main, "sub", "deep"));
    const wt = addWorktree(main, join(sandbox, "elsewhere", "wt-oldgit"));
    const refused: string[][] = [];
    const oldGit: GitRunner = (cwd, args) => {
      if (args.some((a) => a.startsWith("--path-format"))) {
        refused.push([...args]);
        return { status: 129, stdout: "", missing: false };
      }
      return realGit(cwd, args);
    };
    // Arm: from a subdirectory the plain form IS relative ("../../.git").
    expect(realGit(deep, ["rev-parse", "--git-common-dir"]).stdout).toBe("../../.git");

    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(deep, { git: oldGit })).toMatchObject({
      slug: "gproj",
      source: "git-main",
      worktree_root: main,
      main_root: main,
      lookup_path: deep,
    });
    expect(resolveProjectIdentity(wt, { git: oldGit })).toMatchObject({
      slug: "gproj",
      source: "git-main",
      worktree_root: wt,
      main_root: main,
      lookup_path: main,
    });
    // The refusal path was exercised, not skipped.
    expect(refused.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Rung 2 — the `.igris-project` marker
// ===========================================================================

describe("TD-359 resolver — rung 2: the .igris-project marker", () => {
  it("(M1) a marker in the directory overrides both the registry and git (§1.5 row 9)", async () => {
    const main = makeRepo(join(sandbox, "repos", "checkout"));
    register([{ slug: "proj-reg", path: main }]);
    writeMarker(main, "marked-slug\n");

    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(main)).toMatchObject({
      slug: "marked-slug",
      source: "marker",
      dir: main,
      worktree_root: main,
      main_root: main,
    });
  });

  it("(M2) inside git, an ancestor's marker up to and including the toplevel is found", async () => {
    const main = makeRepo(join(sandbox, "repos", "checkout"));
    writeMarker(main, "marked-slug\n");
    const deep = mkdirp(join(main, "a", "b", "c"));

    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(deep)).toMatchObject({ slug: "marked-slug", source: "marker" });
  });

  it("(M3) inside git, a marker ABOVE the toplevel is ignored", async () => {
    const main = makeRepo(join(sandbox, "repos", "gproj"));
    writeMarker(join(sandbox, "repos"), "outer-slug\n");

    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(main)).toMatchObject({ slug: "gproj", source: "git-main" });
  });

  it("(M4) a linked worktree also reads the MAIN checkout's marker (untracked, so absent from the worktree)", async () => {
    const main = makeRepo(join(sandbox, "repos", "checkout"));
    writeMarker(main, "main-marker\n");
    const wt = addWorktree(main, join(sandbox, "elsewhere", "wt-mark"));
    // Arm: the worktree has no marker of its own.
    expect(existsSync(join(wt, ".igris-project"))).toBe(false);

    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(wt)).toMatchObject({
      slug: "main-marker",
      source: "marker",
      worktree_root: wt,
      main_root: main,
    });
  });

  it.each([
    ["a dotted slug", "animated-fifty.dev\n", "animated-fifty.dev"],
    ["a mixed-case slug", "CustomerPulse-Android", "CustomerPulse-Android"],
    ["the first line, trimmed; later lines ignored", "  lifeOS  \nsecond-line\n", "lifeOS"],
    // The SLUG_RE ceiling (slug.ts): 64 characters is the longest valid slug.
    ["64 characters, the SLUG_RE maximum", `a${"b".repeat(63)}\n`, `a${"b".repeat(63)}`],
    // The shell twin's `read` keeps only the bytes before a NUL (parity T5).
    ["the bytes before a NUL", "nulslug\0/../..\n", "nulslug"],
    ["CRLF, tab and form feed trimmed (ASCII whitespace)", "\t lifeOS\f\r\n", "lifeOS"],
  ])("(M5) a valid marker — %s — is read as the slug", async (_label, content, want) => {
    const main = makeRepo(join(sandbox, "repos", "checkout"));
    writeMarker(main, content);
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(main)).toMatchObject({ slug: want, source: "marker" });
  });

  it.each([
    ["a space inside", "bad slug\n"],
    ["a path escape", "../escape\n"],
    ["a slash", "slug/with/slash\n"],
    ["an empty first line", "\nproj-second-line\n"],
    ["an empty file", ""],
    ["a non-ASCII letter", "naïve\n"],
    // TD-359 integration open issue 1: the CLI builds ~/.igris/projects/<slug>/
    // from the slug, so a marker that is a path component of its own (`..`,
    // `.`) or a hidden / option-shaped name escapes or misleads. The marker
    // takes exactly slug.ts SLUG_RE: an alphanumeric first character, 64 max.
    ["`..` (the parent directory)", "..\n"],
    ["`.` (the directory itself)", ".\n"],
    ["a leading dot (`.hidden`)", ".hidden\n"],
    ["a leading hyphen (`-x`)", "-x\n"],
    ["65 characters, one past the SLUG_RE maximum", `a${"b".repeat(64)}\n`],
    // The trim is ASCII-only, as in the shell twin (parity T3/T4): a BOM or a
    // no-break space is kept, and then fails SLUG_RE.
    ["a UTF-8 BOM before the slug", "\uFEFFproj\n"],
    ["a no-break space before the slug", "\u00A0proj\n"],
    ["an ideographic space after the slug", "proj\u3000\n"],
  ])("(M6) an INVALID marker — %s — is ignored and resolution falls through (§1.5 row 10)", async (_label, content) => {
    const main = makeRepo(join(sandbox, "repos", "checkout"));
    register([{ slug: "proj-reg", path: main }]);
    writeMarker(main, content);
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(main)).toMatchObject({ slug: "proj-reg", source: "registry" });
  });

  it("(M7) outside git, the marker walk covers the directory's ancestors", async () => {
    const root = mkdirp(join(sandbox, "plain"));
    writeMarker(root, "plain-marker\n");
    const deep = mkdirp(join(root, "a", "b"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(deep)).toMatchObject({
      slug: "plain-marker",
      source: "marker",
      worktree_root: null,
      main_root: null,
    });
  });

  it("(M8) outside git, the walk stops BEFORE $HOME: a marker at $HOME is never read, one below it is", async () => {
    const proj = mkdirp(join(home, "work", "proj"));
    writeMarker(home, "home-marker\n");
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(proj)).toMatchObject({ slug: "proj", source: "basename" });

    writeMarker(join(home, "work"), "work-marker\n");
    expect(resolveProjectIdentity(proj)).toMatchObject({ slug: "work-marker", source: "marker" });
  });
});

// ===========================================================================
// Rung 3 — the registry walk on the translated path
// ===========================================================================

describe("TD-359 resolver — rung 3: the registry walk on the translated path", () => {
  it("(R1) a registered main checkout resolves to its registry slug, not its directory name (§1.5 row 1)", async () => {
    const main = makeRepo(join(sandbox, "repos", "checkout"));
    register([{ slug: "proj-reg", path: main }]);
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(main)).toMatchObject({
      slug: "proj-reg",
      source: "registry",
      dir: main,
      worktree_root: main,
      main_root: main,
      lookup_path: main,
    });
  });

  it("(R2) a subdirectory named `content` resolves to its repo even when another project's slug is `content` (§1.5 row 2)", async () => {
    const main = makeRepo(join(sandbox, "repos", "checkout"));
    const other = mkdirp(join(sandbox, "automation", "content"));
    register([
      { slug: "content", path: other },
      { slug: "proj-reg", path: main },
    ]);
    const sub = mkdirp(join(main, "content"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(sub)).toMatchObject({
      slug: "proj-reg",
      source: "registry",
      lookup_path: sub,
    });
  });

  it("(R3) a linked worktree outside the tree, named wt-x, resolves to the main checkout's row (§1.5 row 3)", async () => {
    const main = makeRepo(join(sandbox, "repos", "checkout"));
    register([{ slug: "proj-reg", path: main }]);
    const wt = addWorktree(main, join(sandbox, "elsewhere", "wt-x"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(wt)).toMatchObject({
      slug: "proj-reg",
      source: "registry",
      dir: wt,
      worktree_root: wt,
      main_root: main,
      lookup_path: main,
    });
  });

  it("(R4) a worktree inside .claude/worktrees/agent-x resolves to the main checkout's row (§1.5 row 4)", async () => {
    const main = makeRepo(join(sandbox, "repos", "checkout"));
    register([{ slug: "proj-reg", path: main }]);
    const wt = addWorktree(main, join(main, ".claude", "worktrees", "agent-x"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(wt)).toMatchObject({
      slug: "proj-reg",
      source: "registry",
      worktree_root: wt,
      main_root: main,
      lookup_path: main,
    });
  });

  it("(R5) a worktree subdirectory hits a DEEPER registered row through the translation", async () => {
    const main = makeRepo(join(sandbox, "repos", "mono"));
    mkdirp(join(main, "packages", "app"));
    register([
      { slug: "mono-reg", path: main },
      { slug: "app-reg", path: join(main, "packages", "app") },
    ]);
    const wt = addWorktree(main, join(sandbox, "elsewhere", "wt-mono"));
    const sub = mkdirp(join(wt, "packages", "app", "src"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(sub)).toMatchObject({
      slug: "app-reg",
      source: "registry",
      worktree_root: wt,
      main_root: main,
      lookup_path: join(main, "packages", "app", "src"),
    });
  });

  it.each([
    ["the CLI DDL (no id; rowid = insertion order)", "cli" as const, [
      { slug: "zz-legacy", path: "" },
      { slug: "aa-newer", path: "" },
    ]],
    ["the brain DDL (rowid IS id; inserted out of id order)", "brain" as const, [
      { slug: "aa-newer", path: "", id: 7 },
      { slug: "zz-legacy", path: "", id: 3 },
    ]],
  ])("(R6) duplicate-path rows on %s: the LOWEST rowid wins, not the alphabetical slug (§1.5 row 5)", async (_label, ddl, rows) => {
    const main = makeRepo(join(sandbox, "repos", "fifty_dev"));
    register(rows.map((r) => ({ ...r, path: main })), ddl);
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(main)).toMatchObject({ slug: "zz-legacy", source: "registry" });
  });

  it("(R7) the DEEPEST registered ancestor wins over a shallower one with a lower rowid", async () => {
    const outer = mkdirp(join(sandbox, "mono"));
    const inner = mkdirp(join(outer, "pkg"));
    register([
      { slug: "outer-reg", path: outer },
      { slug: "inner-reg", path: inner },
    ]);
    const deep = mkdirp(join(inner, "src", "lib"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(deep)).toMatchObject({
      slug: "inner-reg",
      source: "registry",
      worktree_root: null,
      main_root: null,
      lookup_path: deep,
    });
  });

  it("(R8) a nested git repo inside a registered NON-git directory resolves to the registered ancestor (§1.5 row 6)", async () => {
    const host = mkdirp(join(sandbox, "host"));
    register([{ slug: "host-reg", path: host }]);
    const nested = makeRepo(join(host, "nested"));
    const sub = mkdirp(join(nested, "sub"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(sub)).toMatchObject({
      slug: "host-reg",
      source: "registry",
      worktree_root: nested,
      main_root: nested,
      lookup_path: sub,
    });
  });

  it("(R9) stored paths compare as RAW strings: a tilde-form row does not match (twin parity, no expansion)", async () => {
    const proj = mkdirp(join(home, "code", "tproj"));
    register([{ slug: "tilde-reg", path: "~/code/tproj" }]);
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(proj)).toMatchObject({ slug: "tproj", source: "basename" });
  });

  it("(R10) a row whose path is `/` never matches (the walk excludes /)", async () => {
    const plain = mkdirp(join(sandbox, "plain", "leaf-y"));
    register([{ slug: "root-reg", path: "/" }]);
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(plain)).toMatchObject({ slug: "leaf-y", source: "basename" });
  });

  it("(R11) the registry is read at brainDbPath(), which honours IGRIS_BRAIN_DIR over $HOME/.igris", async () => {
    const main = makeRepo(join(sandbox, "repos", "checkout"));
    process.env.IGRIS_BRAIN_DIR = mkdirp(join(sandbox, "alt-brain"));
    register([{ slug: "proj-alt", path: main }]);
    // Arm: nothing was written under $HOME/.igris.
    expect(existsSync(join(home, ".igris", "memory", "knowledge.db"))).toBe(false);
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(main)).toMatchObject({ slug: "proj-alt", source: "registry" });
  });

  // TD-359 integration open issue 4. On a case-insensitive volume a mis-cased
  // path opens fine, but its spelling is not git's: `--show-toplevel` and
  // `--show-prefix` report the ON-DISK case. Both twins therefore build the
  // walk and the lookup from git's spelling (top + prefix, main + prefix) and
  // never subtract a toplevel from the input's spelling.
  it.skipIf(!CASE_INSENSITIVE)(
    "(R12) a MIS-CASED path of a linked worktree subdirectory resolves to the main checkout's row",
    async () => {
      const main = makeRepo(join(sandbox, "repos", "checkout"));
      register([{ slug: "proj-reg", path: main }]);
      const wt = addWorktree(main, join(sandbox, "elsewhere", "Wt-Case"));
      mkdirp(join(wt, "Sub", "Deep"));
      const given = join(sandbox, "ELSEWHERE", "wt-case", "sub", "deep");
      const { resolveProjectIdentity } = await loadResolver();
      expect(resolveProjectIdentity(given)).toMatchObject({
        slug: "proj-reg",
        source: "registry",
        worktree_root: wt,
        main_root: main,
        lookup_path: join(main, "Sub", "Deep"),
      });
    },
  );

  it.skipIf(!CASE_INSENSITIVE)(
    "(R13) a MIS-CASED path of a registered main checkout resolves to its row, not git-main",
    async () => {
      const main = makeRepo(join(sandbox, "repos", "Checkout-Case"));
      register([{ slug: "proj-reg", path: main }]);
      const given = join(sandbox, "REPOS", "checkout-case");
      const { resolveProjectIdentity } = await loadResolver();
      expect(resolveProjectIdentity(given)).toMatchObject({
        slug: "proj-reg",
        source: "registry",
        worktree_root: main,
        main_root: main,
        lookup_path: main,
      });
    },
  );
});

// ===========================================================================
// Rung 5 and the degraded registry
// ===========================================================================

describe("TD-359 resolver — rung 5 and a degraded registry", () => {
  it("(B1) a non-git, unregistered, unmarked directory stays basename(dir) — no regression (§1.5 row 8)", async () => {
    const plain = mkdirp(join(sandbox, "plain", "leaf-z"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(plain)).toMatchObject({
      slug: "leaf-z",
      source: "basename",
      dir: plain,
      worktree_root: null,
      main_root: null,
      lookup_path: plain,
    });
  });

  it("(D1) an ABSENT brain DB skips the registry rung and creates no DB file", async () => {
    const main = makeRepo(join(sandbox, "repos", "gproj"));
    const wt = addWorktree(main, join(sandbox, "elsewhere", "wt-nodb"));
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(wt)).toMatchObject({ slug: "gproj", source: "git-main" });
    expect(existsSync(brainDb())).toBe(false);
  });

  it("(D2) a CORRUPT brain DB skips the registry rung, never throws, and is left byte-identical", async () => {
    const main = makeRepo(join(sandbox, "repos", "gproj"));
    mkdirSync(dirname(brainDb()), { recursive: true });
    const garbage = "this is not a sqlite database\n".repeat(200);
    writeFileSync(brainDb(), garbage);
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(main)).toMatchObject({ slug: "gproj", source: "git-main" });
    expect(readFileSync(brainDb(), "utf-8")).toBe(garbage);
  });

  it("(D3) a brain DB with no projects table skips the rung and does not create the table", async () => {
    const main = makeRepo(join(sandbox, "repos", "gproj"));
    mkdirSync(dirname(brainDb()), { recursive: true });
    const seed = new Database(brainDb());
    seed.exec("CREATE TABLE unrelated (x TEXT)");
    seed.close();
    const { resolveProjectIdentity } = await loadResolver();
    expect(resolveProjectIdentity(main)).toMatchObject({ slug: "gproj", source: "git-main" });
    const check = new Database(brainDb(), { readonly: true });
    const t = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();
    check.close();
    expect(t).toBeUndefined();
  });
});

// ===========================================================================
// defaultProjectSlug — replaces the deleted cwd-basename helper (lib/sync/util.ts)
// ===========================================================================

describe("TD-359 defaultProjectSlug — resolveProjectIdentity(process.cwd()).slug", () => {
  it("(S1) from a worktree of a registered project it returns the registry slug, not the worktree's name", async () => {
    const main = makeRepo(join(sandbox, "repos", "checkout"));
    register([{ slug: "proj-reg", path: main }]);
    const wt = addWorktree(main, join(sandbox, "elsewhere", "mbrgea-ai-gl010"));
    vi.spyOn(process, "cwd").mockReturnValue(wt);
    const { defaultProjectSlug } = await loadResolver();
    expect(defaultProjectSlug()).toBe("proj-reg");
  });

  it("(S2) from a non-git, unregistered directory it returns basename(cwd)", async () => {
    const plain = mkdirp(join(sandbox, "plain", "leaf-cwd"));
    vi.spyOn(process, "cwd").mockReturnValue(plain);
    const { defaultProjectSlug } = await loadResolver();
    expect(defaultProjectSlug()).toBe("leaf-cwd");
  });
});

// ===========================================================================
// listProjectPathsReadonly — the registry reader (registry.ts)
// ===========================================================================

type RegistryModule = { listProjectPathsReadonly: () => Array<{ slug: string; path: string }> };

async function loadRegistry(): Promise<RegistryModule> {
  return (await import("../lib/registry.js")) as unknown as RegistryModule;
}

describe("TD-359 listProjectPathsReadonly — rowid order, read-only door", () => {
  it("(L1) returns exactly {slug, path} rows in ROWID order on the CLI DDL (not slug order)", async () => {
    register([
      { slug: "zz-first", path: "/p/one" },
      { slug: "aa-second", path: "/p/two" },
    ]);
    const { listProjectPathsReadonly } = await loadRegistry();
    expect(listProjectPathsReadonly()).toEqual([
      { slug: "zz-first", path: "/p/one" },
      { slug: "aa-second", path: "/p/two" },
    ]);
  });

  it("(L2) on the brain DDL rowid is `id`, so an out-of-order insert reads back in id order", async () => {
    register(
      [
        { slug: "aa-high", path: "/p/high", id: 9 },
        { slug: "zz-low", path: "/p/low", id: 2 },
      ],
      "brain",
    );
    const { listProjectPathsReadonly } = await loadRegistry();
    expect(listProjectPathsReadonly()).toEqual([
      { slug: "zz-low", path: "/p/low" },
      { slug: "aa-high", path: "/p/high" },
    ]);
  });

  it("(L3) an absent brain DB reads as [] and no file is materialised", async () => {
    const { listProjectPathsReadonly } = await loadRegistry();
    expect(listProjectPathsReadonly()).toEqual([]);
    expect(existsSync(brainDb())).toBe(false);
  });

  it("(L4) a corrupt brain DB reads as [] (never throws)", async () => {
    mkdirSync(dirname(brainDb()), { recursive: true });
    writeFileSync(brainDb(), "garbage, not sqlite\n".repeat(100));
    const { listProjectPathsReadonly } = await loadRegistry();
    expect(listProjectPathsReadonly()).toEqual([]);
  });

  it("(L5) a DB without a projects table reads as [] and the table is not created", async () => {
    mkdirSync(dirname(brainDb()), { recursive: true });
    const seed = new Database(brainDb());
    seed.exec("CREATE TABLE unrelated (x TEXT)");
    seed.close();
    const { listProjectPathsReadonly } = await loadRegistry();
    expect(listProjectPathsReadonly()).toEqual([]);
    const check = new Database(brainDb(), { readonly: true });
    const t = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();
    check.close();
    expect(t).toBeUndefined();
  });

  it("(L6) reading leaves a delete-mode brain in delete mode (no journal_mode flip, no -wal file)", async () => {
    register([{ slug: "p", path: "/p" }]);
    const before = new Database(brainDb(), { readonly: true });
    expect(before.pragma("journal_mode", { simple: true })).toBe("delete");
    before.close();
    const { listProjectPathsReadonly } = await loadRegistry();
    expect(listProjectPathsReadonly()).toEqual([{ slug: "p", path: "/p" }]);
    const after = new Database(brainDb(), { readonly: true });
    expect(after.pragma("journal_mode", { simple: true })).toBe("delete");
    after.close();
    expect(existsSync(`${brainDb()}-wal`)).toBe(false);
  });
});
