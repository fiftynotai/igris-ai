/**
 * git-hooks.ts — the git-level gates as a property of a registered project
 * (FR-243).
 *
 * The canonical hooks live at `core/git-hooks/{pre-commit,commit-msg}` in the
 * igris-ai repo and ride the core channel (`igris refresh`) to
 * `$(brainDir())/core/git-hooks/` on every machine — ZERO packed bytes. A
 * consumer project's `.git/hooks/<name>` is a SYMLINK to that mirror copy, so a
 * refresh updates every registered project at once and doctor can see a broken
 * chain. Two verbs read this module:
 *
 *   `igris install <path>`   step 7b → installGitHooks()   (opt out: --no-git-hooks)
 *   `igris doctor [--fix]`   git-hooks-missing (per project) → inspectGitHooks()
 *                            secret-scan-disarmed (brain-level) → gitleaksOnPath()
 *
 * Consumer-safety rules (plan §2.5), each pinned by a bats case in
 * `cli/tests/integration/install-git-hooks.bats`:
 *   1. never clobber a non-symlink hook — copy it to `<hook>.pre-igris.bak.<epoch>`
 *      first (the TD-072 F3 behaviour of scripts/install_git_hooks.sh, ported);
 *   2. REFUSE when `.git/config` sets `core.hooksPath` — a hook written into
 *      `.git/hooks/` under husky/lefthook is a hook that never runs, i.e. the
 *      silent class this brief exists to close;
 *   3. REFUSE when `.git` is a file (worktree / submodule) — install in the
 *      main checkout;
 *   4. REFUSE when the canonical source is absent (`igris refresh` first);
 *   5. idempotent — a symlink already resolving to the canonical realpath is
 *      `already-installed`;
 *   6. `chmod +x` the SOURCE only when it lives under brainDir() — never a
 *      consumer's own file. Git silently IGNORES a non-executable hook (one
 *      `hint:` line, and the commit proceeds), and `verify_mirror.sh` is a
 *      byte-only check, so a mode dropped by an operator-side `cp` would be a
 *      disarmed gate that every byte-check calls in sync.
 *
 * Detection reads only the filesystem and the `.git/config` TEXT — it never
 * spawns `git`. It reads the LOCAL config only: a `core.hooksPath` set in the
 * operator's global gitconfig is not seen here (documented limit).
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { brainDir } from "./paths.js";

export const GIT_HOOK_NAMES = ["pre-commit", "commit-msg"] as const;
export type GitHookName = (typeof GIT_HOOK_NAMES)[number];

/** Where a project's git hooks directory is — or why there is none. */
export type GitHooksDir =
  | { kind: "dir"; gitDir: string; hooksDir: string }
  /** `.git` is a FILE: a linked worktree or a submodule (`gitdir: ...`). */
  | { kind: "file"; gitFile: string }
  | { kind: "none" };

export function resolveGitHooksDir(projectPath: string): GitHooksDir {
  const gitPath = join(resolve(projectPath), ".git");
  let st;
  try {
    st = statSync(gitPath);
  } catch {
    return { kind: "none" };
  }
  if (st.isDirectory()) {
    return { kind: "dir", gitDir: gitPath, hooksDir: join(gitPath, "hooks") };
  }
  return { kind: "file", gitFile: gitPath };
}

/**
 * `core.hooksPath` from the LOCAL `.git/config` text, or null. A minimal
 * INI read: the `[core]` section's `hooksPath = <value>` line. No `git`
 * spawn (doctor is a pure reader).
 */
export function readCoreHooksPath(gitDir: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(gitDir, "config"), "utf8");
  } catch {
    return null;
  }
  let inCore = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inCore = /^\[core\]/i.test(line);
      continue;
    }
    if (!inCore) continue;
    const m = /^hooksPath\s*=\s*(.+?)\s*$/i.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * True when `hooksPath` sends git somewhere OTHER than `<gitDir>/hooks`. A
 * `core.hooksPath` that resolves to `.git/hooks` itself (relative to the
 * worktree root, as git resolves it) is the default location spelled out —
 * the igris-ai checkout carries exactly that — and is NOT a bypass.
 */
export function hooksPathBypasses(gitDir: string, hooksPath: string): boolean {
  const worktree = dirname(gitDir);
  const candidate = realpathOrNull(resolve(worktree, hooksPath)) ?? resolve(worktree, hooksPath);
  const dflt = realpathOrNull(join(gitDir, "hooks")) ?? join(gitDir, "hooks");
  return candidate !== dflt;
}

/**
 * The canonical source for hook `name`. Repo-first on the igris-ai checkout
 * itself (`<project>/core/git-hooks/<name>` next to `harness-manifest.json`),
 * so a mid-edit hook gates the commit as edited — the rule `commit-msg` uses
 * for its parser; otherwise the runtime mirror under brainDir(), which honours
 * `IGRIS_BRAIN_DIR` (the bats sandbox seam).
 */
export function canonicalGitHookSource(
  name: GitHookName,
  opts: { projectPath: string },
): string {
  const root = resolve(opts.projectPath);
  const repoCopy = join(root, "core", "git-hooks", name);
  if (existsSync(repoCopy) && existsSync(join(root, "harness-manifest.json"))) {
    return repoCopy;
  }
  return join(brainDir(), "core", "git-hooks", name);
}

/** True when `p` resolves and carries any execute bit (always true on win32). */
export function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isUnder(child: string, parent: string): boolean {
  const c = realpathOrNull(child) ?? resolve(child);
  const p = realpathOrNull(parent) ?? resolve(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/");
}

export type GitHookState =
  | "installed"
  | "absent"
  | "foreign"
  | "dangling"
  | "not-executable"
  | "source-missing";

export interface GitHookInspection {
  name: GitHookName;
  /** `.git/hooks/<name>` */
  hookPath: string;
  /** the canonical source this hook SHOULD resolve to */
  source: string;
  state: GitHookState;
  /** doctor's reason text — short and front-loaded (the table truncates at 60) */
  reason: string;
}

export type GitHooksInspection =
  | { kind: "not-git" }
  | { kind: "worktree"; gitFile: string }
  | { kind: "hooks-path-bypass"; hooksPath: string; hooksDir: string }
  | { kind: "ok"; hooksDir: string; hooks: GitHookInspection[] };

/** Read-only. Never spawns git; never writes. */
export function inspectGitHooks(projectPath: string): GitHooksInspection {
  const dir = resolveGitHooksDir(projectPath);
  if (dir.kind === "none") return { kind: "not-git" };
  if (dir.kind === "file") return { kind: "worktree", gitFile: dir.gitFile };
  const hooksPath = readCoreHooksPath(dir.gitDir);
  if (hooksPath !== null && hooksPathBypasses(dir.gitDir, hooksPath)) {
    return { kind: "hooks-path-bypass", hooksPath, hooksDir: dir.hooksDir };
  }
  const hooks: GitHookInspection[] = [];
  for (const name of GIT_HOOK_NAMES) {
    hooks.push(inspectOne(name, dir.hooksDir, projectPath));
  }
  return { kind: "ok", hooksDir: dir.hooksDir, hooks };
}

function inspectOne(
  name: GitHookName,
  hooksDir: string,
  projectPath: string,
): GitHookInspection {
  const hookPath = join(hooksDir, name);
  const source = canonicalGitHookSource(name, { projectPath });
  const base = { name, hookPath, source };

  let lst;
  try {
    lst = lstatSync(hookPath);
  } catch {
    return { ...base, state: "absent", reason: `${name}: absent` };
  }
  if (!lst.isSymbolicLink()) {
    return {
      ...base,
      state: "foreign",
      reason: `${name}: foreign hook (not a symlink) at ${hookPath}`,
    };
  }
  const target = realpathOrNull(hookPath);
  if (target === null) {
    return {
      ...base,
      state: "dangling",
      reason: `${name}: dangling symlink (target missing — run igris refresh)`,
    };
  }
  const sourceReal = realpathOrNull(source);
  if (sourceReal === null) {
    return {
      ...base,
      state: "source-missing",
      reason: `${name}: canonical source missing at ${source} (run igris refresh)`,
    };
  }
  if (target !== sourceReal) {
    return {
      ...base,
      state: "foreign",
      reason: `${name}: foreign target ${target}`,
    };
  }
  if (!isExecutableFile(target)) {
    return {
      ...base,
      state: "not-executable",
      reason: `${name}: target not executable (${target})`,
    };
  }
  return { ...base, state: "installed", reason: "" };
}

export type GitHookInstallOutcome =
  | "installed"
  | "already-installed"
  | "backed-up + installed"
  | "refused"
  | "failed";

export interface GitHookInstallResult {
  name: GitHookName;
  hookPath: string;
  source: string;
  outcome: GitHookInstallOutcome;
  /** the `.pre-igris.bak.<epoch>` copy, when a foreign hook was preserved */
  backup?: string;
  reason?: string;
}

export type GitHooksInstallResult =
  | { outcome: "refused"; reason: string; hooks: [] }
  | { outcome: "installed"; hooksDir: string; hooks: GitHookInstallResult[] };

/**
 * Install (symlink) both hooks into `<projectPath>/.git/hooks/`. Never throws;
 * per-hook failures are reported in `hooks[]`. See the header for the six
 * consumer-safety rules.
 */
export function installGitHooks(projectPath: string): GitHooksInstallResult {
  const dir = resolveGitHooksDir(projectPath);
  if (dir.kind === "none") {
    return {
      outcome: "refused",
      reason: `${resolve(projectPath)} is not a git repository (no .git) — nothing to install`,
      hooks: [],
    };
  }
  if (dir.kind === "file") {
    return {
      outcome: "refused",
      reason:
        `.git is a file (linked worktree or submodule) — install the git hooks ` +
        `in the main checkout; the worktree shares its hooks`,
      hooks: [],
    };
  }
  const hooksPath = readCoreHooksPath(dir.gitDir);
  if (hooksPath !== null && hooksPathBypasses(dir.gitDir, hooksPath)) {
    return {
      outcome: "refused",
      reason:
        `core.hooksPath=${hooksPath} is set in .git/config, so git never reads ` +
        `.git/hooks/ — a hook installed there would silently never run. ` +
        `Add ~/.igris/core/git-hooks/{pre-commit,commit-msg} to your ` +
        `husky/lefthook pipeline instead (or unset core.hooksPath).`,
      hooks: [],
    };
  }

  const results: GitHookInstallResult[] = [];
  for (const name of GIT_HOOK_NAMES) {
    results.push(installOne(name, dir.hooksDir, projectPath));
  }
  return { outcome: "installed", hooksDir: dir.hooksDir, hooks: results };
}

function installOne(
  name: GitHookName,
  hooksDir: string,
  projectPath: string,
): GitHookInstallResult {
  const hookPath = join(hooksDir, name);
  const source = canonicalGitHookSource(name, { projectPath });
  const base = { name, hookPath, source };

  // Rule 4: the canonical source must exist (a consumer machine before its
  // first `igris refresh` has no ~/.igris/core/git-hooks/).
  const sourceReal = realpathOrNull(source);
  if (sourceReal === null || !existsSync(sourceReal)) {
    return {
      ...base,
      outcome: "refused",
      reason: `canonical hook missing at ${source} — run 'igris refresh' first`,
    };
  }

  // Rule 6: only a file under brainDir() gets its mode repaired here. The
  // repo copy on the igris-ai checkout is git-tracked 100755; a consumer's
  // own files are never touched.
  if (!isExecutableFile(sourceReal)) {
    if (isUnder(sourceReal, brainDir())) {
      try {
        chmodSync(sourceReal, 0o755);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...base, outcome: "failed", reason: `chmod +x ${sourceReal}: ${msg}` };
      }
    } else {
      return {
        ...base,
        outcome: "refused",
        reason: `${sourceReal} is not executable and is outside ${brainDir()} — chmod +x it yourself`,
      };
    }
  }

  try {
    mkdirSync(hooksDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, outcome: "failed", reason: `mkdir ${hooksDir}: ${msg}` };
  }

  let backup: string | undefined;
  let lst;
  try {
    lst = lstatSync(hookPath);
  } catch {
    lst = null;
  }
  if (lst !== null) {
    if (lst.isSymbolicLink()) {
      // Rule 5: idempotent.
      if (realpathOrNull(hookPath) === sourceReal) {
        return { ...base, outcome: "already-installed" };
      }
      // A symlink elsewhere (an older mirror path, a hand link): replace it.
      // Nothing of the consumer's is lost — the link target still exists.
    } else {
      // Rule 1: a real file predates Igris (husky-less hand-rolled hook).
      backup = `${hookPath}.pre-igris.bak.${Math.floor(Date.now() / 1000)}`;
      try {
        copyFileSync(hookPath, backup);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...base, outcome: "failed", reason: `backup ${hookPath} -> ${backup}: ${msg}` };
      }
    }
    try {
      unlinkSync(hookPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ...base, outcome: "failed", reason: `rm ${hookPath}: ${msg}`, backup };
    }
  }

  try {
    symlinkSync(sourceReal, hookPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, outcome: "failed", reason: `ln -s ${sourceReal} ${hookPath}: ${msg}`, backup };
  }
  return backup !== undefined
    ? { ...base, outcome: "backed-up + installed", backup }
    : { ...base, outcome: "installed" };
}

/**
 * True when a `gitleaks` binary is resolvable on PATH. Pure PATH split +
 * existsSync per dir — no spawn (doctor is read-only). Detection is PATH
 * PRESENCE, so a stub executable satisfies it in tests.
 */
export function gitleaksOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PATH ?? "";
  if (raw.length === 0) return false;
  const sep = process.platform === "win32" ? ";" : ":";
  const names = process.platform === "win32" ? ["gitleaks.exe", "gitleaks"] : ["gitleaks"];
  for (const dir of raw.split(sep)) {
    if (dir.length === 0) continue;
    for (const n of names) {
      const p = join(dir, n);
      if (isExecutableFile(p)) return true;
    }
  }
  return false;
}
