/**
 * TD-359 — the ONE project resolver, TypeScript twin.
 *
 * THE DEFECT IT REPLACES. Every CLI surface (`igris detect` and the 15 call
 * sites that defaulted `--project` through the retired `sync/util.ts` helper)
 * derived the project slug from `basename(cwd)`. A git worktree of a registered project
 * (`…/agents/mbrgea-ai-gl010`) therefore became a phantom project with zero
 * briefs, and the hooks — a separate, differently-shaped resolver — disagreed
 * with the verbs about which project a directory belongs to.
 *
 * THE TWINS. This file and `igris_resolve_project` in
 * `core/hooks/shared/_gate.sh` implement the SAME chain step for step. They are
 * two implementations because a bash hook cannot import TypeScript; they are
 * held together by `test/project_slug_parity.test.bash`, which runs both (plus
 * `igris detect`, the git-hook path and the brief-gate path) on one fixture
 * matrix. CHANGE BOTH TWINS AND THE PARITY MATRIX IN ONE COMMIT (MAINTAINING
 * "project identity resolution").
 *
 * THE CHAIN (PLAN §1.1). Input `dir`; first rung that answers wins.
 *
 *   0. normalise  dir_real = realpath(dir), or `dir` unchanged when that fails.
 *                 The JS `realpathSync`, matching the shell twin's
 *                 `cd -- dir && pwd -P`: a `..` is dropped textually and the
 *                 letter case is kept as given (see realpathOrNull).
 *   1. git probe  (GIT_* location variables stripped first)
 *                 top    = realpath(`rev-parse --show-toplevel`)
 *                 prefix = `rev-parse --show-prefix` (same call), trailing
 *                          slash stripped; empty at the toplevel
 *                 common = `rev-parse --path-format=absolute --git-common-dir`,
 *                          or — when git < 2.31 refuses the flag — the plain
 *                          `--git-common-dir` resolved from top/prefix
 *                 main   = dirname(common) when basename(common) == ".git",
 *                          else top (a bare repo or a separate git-dir)
 *                 Any failure → top = main = null, and resolution falls through.
 *                 here   = top + prefix in git — git's on-disk spelling, which
 *                          a mis-cased dir_real on a case-insensitive volume
 *                          does not share — else dir_real.
 *   2. marker     `.igris-project`: first line (ended by a NUL or newline
 *                 within MARKER_LINE_MAX bytes, else refused), trimmed,
 *                 matching slug.ts SLUG_RE (alphanumeric first character, then
 *                 letters, digits, `._-`, 64 at most: never `.`, `..`,
 *                 `.hidden` or `-x`).
 *                 In git: here and each ancestor up to AND including top,
 *                 then main/.igris-project when main != top (the marker is
 *                 untracked, so a linked worktree has none of its own).
 *                 Outside git: here and its ancestors, stopping BEFORE
 *                 $HOME and before `/`. An invalid marker is ignored.
 *   3. registry   lookup_path = main + prefix in git, else here — a worktree
 *                 subdirectory maps onto the same subdirectory of the main
 *                 checkout; in a main checkout this is the identity, so the
 *                 rung is exactly the hooks' old `find_project_slug` walk.
 *                 The DEEPEST registered ancestor of lookup_path wins (`/`
 *                 excluded), the LOWEST rowid breaks a duplicate path, and
 *                 stored paths compare as RAW strings (no tilde expansion — the
 *                 shell twin cannot expand them either, so neither twin does).
 *   4. git-main   basename(main).
 *   5. basename   basename(here) — the documented last resort, kept so an
 *                 un-bootstrapped machine (no git, no marker, no registry row)
 *                 resolves exactly as it always did.
 *
 * WHY THE REGISTRY BEATS git-main (D2). Five live repos have a registry slug
 * that differs from their directory name (`fifty_dev` → `fifty-dev`, …). The
 * registry slug is the one that owns the briefs, so every surface converges on
 * it rather than on the directory name.
 *
 * DEGRADED-SAFE BY CONSTRUCTION. Nothing here throws, writes, or touches the
 * network: a missing or broken `git` (ENOENT, non-zero exit, the 3 s cap) is a
 * null probe; an absent, corrupt or table-less brain is an empty registry
 * (`listProjectPathsReadonly`, the read-only door, which creates nothing). So
 * `igris detect` keeps its "never block session start" contract.
 *
 * DB LOCATION. The registry is read at `brainDbPath()`, which honours
 * `IGRIS_BRAIN_DIR`; the shell twin reads `$HOME/.igris/memory/knowledge.db`
 * like every hook (MAINTAINING row 134). Tests set `IGRIS_BRAIN_DIR=$HOME/.igris`
 * so both twins read one file.
 *
 * MINT SITES ARE NOT RESOLVERS. `igris install <path>` and
 * `igris register-project <path>` NAME a new registry row from an explicit path;
 * they must not route through this resolver (an `ON CONFLICT(slug)` upsert would
 * re-point a registered row's `path` at a worktree). See the notes at those sites.
 */

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { listProjectPathsReadonly } from "./registry.js";
import { SLUG_RE } from "./slug.js";
import type { ProjectIdentitySource } from "../types.js";

/** Which rung of the chain produced the slug. */
export type { ProjectIdentitySource } from "../types.js";

/** The resolver's answer for one directory. */
export interface ProjectIdentity {
  /** The resolved project slug. */
  slug: string;
  /** The rung that produced {@link slug}. */
  source: ProjectIdentitySource;
  /** The input directory, realpath'd — or exactly as given when realpath failed. */
  dir: string;
  /** The realpath of the git toplevel (a linked worktree's OWN root); null outside git. */
  worktree_root: string | null;
  /** The main checkout's root (equals {@link worktree_root} outside a linked worktree); null outside git. */
  main_root: string | null;
  /** The path the registry walk ran on: the worktree-translated directory. */
  lookup_path: string;
}

/**
 * One git invocation's result — the `git-head.ts#git` contract.
 *
 * `status` is null when git could not be spawned or hit the time cap;
 * `missing` is true only when the binary itself was not found (ENOENT).
 */
export interface GitRun {
  status: number | null;
  stdout: string;
  missing: boolean;
}

/** Runs `git -C cwd ...args`. Injected by tests (PLAN §1.4) so they need no PATH tricks. */
export type GitRunner = (cwd: string, args: readonly string[]) => GitRun;

/** A registry row as the walk reads it, in rowid order. */
export interface ProjectPathRow {
  slug: string;
  path: string;
}

/** The resolver's seams. Omitted members use the production implementations. */
export interface ProjectIdentityDeps {
  git?: GitRunner;
  /** Rows in ROWID order (the duplicate-path tie-break depends on it). */
  listProjectPaths?: () => ProjectPathRow[];
}

/**
 * The location variables a git hook (or a harness) exports. Inherited, they
 * would point `git -C <dir>` at a DIFFERENT repository — the `git-head.ts` M9
 * shape — so the probe strips them, exactly like `git-head.ts`.
 */
const GIT_ENV_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
] as const;

/** The marker file's name. */
export const PROJECT_MARKER_FILE = ".igris-project";

/** BR-120: the marker read's bound in BYTES; the shell twin's `read -n` mirrors it. */
export const MARKER_LINE_MAX = 4096;

/** The production git runner: no shell, a 3 s cap, no prompt, location vars stripped. */
const defaultGit: GitRunner = (cwd, args) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const k of GIT_ENV_STRIP) delete env[k];
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
    env,
  });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  // Trailing newlines only, as the shell twin's `$(...)` strips them. Never
  // `.trim()`: a worktree directory may legitimately end in a space, and the
  // trim would cut it off the toplevel line (parity T6).
  return { status: r.error ? null : r.status, stdout: (r.stdout ?? "").replace(/\n+$/, ""), missing };
};

/**
 * The JS `realpathSync`, NOT `realpathSync.native` (realpath(3)): it is the
 * one that normalises like the shell twin's `cd -- dir && pwd -P`. Measured on
 * darwin 2026-11-18 (bash 3.2.57, APFS case-insensitive):
 *   - letter case: `pwd -P` and the JS form keep a mis-cased spelling
 *     (`.../plain-dir`); native canonicalises it (`.../Plain-Dir`);
 *   - `link/../x`: bash's `cd` and the JS form drop the `..` textually
 *     (`<link's parent>/x`); native resolves the symlink first and climbs out
 *     of its TARGET (`<target's parent>/x`).
 * Outside git that spelling is the answer's input, so the twins agree only if
 * they normalise alike. In git nothing depends on it: the walks and the
 * lookup are built from git's own spelling (top + prefix, main + prefix).
 * Null when the path does not resolve.
 */
function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** `root` + `/` + `rel` (a git prefix), or `root` itself when `rel` is empty. */
function underRoot(root: string, rel: string): string {
  return rel === "" ? root : join(root, rel);
}

/** `p` followed by each ancestor, ending at the filesystem root. */
function selfAndAncestors(p: string): string[] {
  const out: string[] = [];
  let cur = p;
  for (;;) {
    out.push(cur);
    const up = dirname(cur);
    if (up === cur) return out;
    cur = up;
  }
}

/** A single-line absolute path, or null — rejects an echoed unknown flag on old git. */
function absoluteLine(out: string): string | null {
  if (out === "" || out.includes("\n") || !isAbsolute(out)) return null;
  return out;
}

/**
 * The git probe of rung 1. Never throws; any failure is all-null.
 *
 * `prefix` is git's `--show-prefix` (the directory below the toplevel,
 * `Sub/Deep`, empty at the top), read in the SAME call as the toplevel — the
 * shell twin's single rev-parse prints both too. Measured on darwin
 * 2026-11-18: given a mis-cased path on a case-insensitive volume, git reports
 * the toplevel AND the prefix in the on-disk case, so top + prefix is the
 * directory in git's spelling whatever spelling the caller passed.
 */
function probeGit(
  dirReal: string,
  git: GitRunner,
): { top: string | null; main: string | null; prefix: string } {
  const none = { top: null, main: null, prefix: "" };

  const t = git(dirReal, ["rev-parse", "--show-toplevel", "--show-prefix"]);
  if (t.missing || t.status !== 0) return none;
  // Two lines: the toplevel, then the prefix (an empty line at the toplevel,
  // which the runner's trailing-newline strip drops).
  const [topLine = "", prefixLine = "", ...extra] = t.stdout.split("\n");
  if (extra.some((l) => l !== "")) return none;
  const topRaw = absoluteLine(topLine);
  const top = topRaw === null ? null : realpathOrNull(topRaw);
  if (top === null) return none;
  const prefix = prefixLine.replace(/\/+$/, "");
  const here = underRoot(top, prefix);

  // `--path-format` is git 2.31+. An older git either refuses it (non-zero) or
  // echoes it back as an unknown argument (rev-parse passes unknown options
  // through), so only a single absolute line is accepted; anything else takes
  // the plain form, which is relative to the directory git ran in — resolved
  // from `here`, git's spelling of that directory, as the shell twin does.
  let common: string | null = null;
  const abs = git(dirReal, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const absLine = abs.status === 0 ? absoluteLine(abs.stdout) : null;
  if (absLine !== null) {
    common = realpathOrNull(absLine);
  } else {
    const plain = git(dirReal, ["rev-parse", "--git-common-dir"]);
    if (plain.status === 0 && plain.stdout !== "" && !plain.stdout.includes("\n")) {
      common = realpathOrNull(resolve(here, plain.stdout));
    }
  }
  if (common === null) return none;

  // A `.git` common dir sits inside its main checkout. Any other name is a bare
  // repo or a `--separate-git-dir` store, whose dirname is NOT a checkout
  // (it would name the store's parent, e.g. `store`), so the toplevel stands in.
  const main = basename(common) === ".git" ? dirname(common) : top;
  return { top, main, prefix };
}

/**
 * Read one `.igris-project` marker. Null when absent, unreadable, not a regular
 * file (a FIFO would block the read), a first line of MARKER_LINE_MAX bytes or
 * more, or not a valid slug.
 *
 * Valid is exactly slug.ts `SLUG_RE`, the grammar `igris install` and
 * `igris register-project` mint slugs with. Live slugs include
 * `animated-fifty.dev`, `CustomerPulse-Android` and `lifeOS`, so dots and
 * mixed case pass; the alphanumeric FIRST character refuses `.`, `..`,
 * `.hidden` and `-x` — the CLI builds `~/.igris/projects/<slug>/` from the
 * slug, so a cloned repo's marker must never name a path out of it. Anything
 * else (spaces, slashes, non-ASCII, over 64 characters) is IGNORED rather than
 * half-honoured. The shell twin spells the same grammar out in bash.
 */
function readMarker(dir: string): string | null {
  const file = join(dir, PROJECT_MARKER_FILE);
  let fd: number | null = null;
  try {
    if (!statSync(file).isFile()) return null;
    // The bytes before the first NUL or newline, read at most MARKER_LINE_MAX
    // bytes in; a line not ended within that is refused, as the shell twin
    // does. Trimmed of ASCII whitespace only — `.trim()` would also strip a
    // BOM or a no-break space, which the shell twin keeps (parity T3-T7c).
    fd = openSync(file, "r");
    const buf = Buffer.alloc(MARKER_LINE_MAX);
    let n = 0;
    while (n < MARKER_LINE_MAX) {
      const got = readSync(fd, buf, n, MARKER_LINE_MAX - n, n);
      if (got === 0) break;
      n += got;
    }
    const head = buf.subarray(0, n);
    const nul = head.indexOf(0);
    const lf = head.indexOf(0x0a);
    const end = Math.min(nul < 0 ? n : nul, lf < 0 ? n : lf);
    if (end >= MARKER_LINE_MAX) return null;
    const first = head.subarray(0, end).toString("utf-8").replace(/^[ \t\r\v\f]+|[ \t\r\v\f]+$/g, "");
    return SLUG_RE.test(first) ? first : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* a failed close leaves the answer unchanged */
      }
    }
  }
}

/**
 * Rung 2. In git the walk runs from `here` (top + prefix) up to top — it
 * reaches top exactly, so it never climbs above it — and then reads main;
 * outside git it is bounded by $HOME and `/`.
 */
function findMarker(here: string, top: string | null, main: string | null): string | null {
  if (top !== null) {
    for (const d of selfAndAncestors(here)) {
      const hit = readMarker(d);
      if (hit !== null) return hit;
      if (d === top) break;
    }
    if (main !== null && main !== top) return readMarker(main);
    return null;
  }

  // Outside git. `$HOME` is read from the environment, as the shell twin reads
  // `$HOME`: it is a STOP bound for the walk, never a path that is read or
  // written. Both spellings stop it (a symlinked HOME realpaths elsewhere).
  const home = process.env.HOME;
  const stops = new Set<string>(["/"]);
  if (home !== undefined && home !== "") {
    stops.add(home);
    const homeReal = realpathOrNull(home);
    if (homeReal !== null) stops.add(homeReal);
  }
  for (const d of selfAndAncestors(here)) {
    if (stops.has(d)) break;
    const hit = readMarker(d);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Rung 3: the deepest registered ancestor of `lookupPath` (`/` excluded); the
 * first row read — the lowest rowid — wins a tie between rows sharing a path.
 */
function findRegistered(lookupPath: string, rows: readonly ProjectPathRow[]): string | null {
  const ancestors = new Set(selfAndAncestors(lookupPath).filter((a) => a !== "/"));
  let best: ProjectPathRow | null = null;
  for (const row of rows) {
    if (!ancestors.has(row.path)) continue;
    // Strictly longer only: an equal-length (same-path) later row never
    // displaces an earlier one, so rowid order is the tie-break.
    if (best === null || row.path.length > best.path.length) best = row;
  }
  return best === null ? null : best.slug;
}

/**
 * Resolve the project a directory belongs to (PLAN §1.1).
 *
 * @param dir - The directory to resolve; defaults to the process cwd.
 * @param deps - Seams for tests: the git runner and the registry reader.
 * @returns The slug, the rung that produced it, and the paths the rungs used.
 *   Never throws.
 */
export function resolveProjectIdentity(
  dir: string = process.cwd(),
  deps: ProjectIdentityDeps = {},
): ProjectIdentity {
  const git = deps.git ?? defaultGit;
  const dirReal = realpathOrNull(dir) ?? dir;
  // The walks need an absolute path even when realpath failed on a RELATIVE
  // input: a bare `foo` would otherwise walk `foo`, then `.` — the cwd.
  const walkDir = isAbsolute(dirReal) ? dirReal : resolve(dirReal);

  const { top, main, prefix } = probeGit(walkDir, git);

  // In git every path the rungs use is git's spelling (the shell twin's
  // `here`); outside git it is the realpath'd input.
  const here = top === null ? walkDir : underRoot(top, prefix);
  const lookupPath = top !== null && main !== null ? underRoot(main, prefix) : here;

  const base = { dir: dirReal, worktree_root: top, main_root: main, lookup_path: lookupPath };

  const marker = findMarker(here, top, main);
  if (marker !== null) return { slug: marker, source: "marker", ...base };

  const rows = (deps.listProjectPaths ?? listProjectPathsReadonly)();
  const registered = findRegistered(lookupPath, rows);
  if (registered !== null) return { slug: registered, source: "registry", ...base };

  // A main checkout at `/` has no name to give; it falls to the last resort,
  // as in the shell twin.
  if (main !== null && basename(main) !== "") {
    return { slug: basename(main), source: "git-main", ...base };
  }

  // TD-359 last-resort: no git, no marker, no registry row.
  return { slug: basename(here), source: "basename", ...base };
}

/**
 * The default project slug for a verb run without `--project`: the project the
 * process cwd resolves to. Replaces the retired `sync/util.ts` cwd-basename
 * helper at every CLI default site.
 */
export function defaultProjectSlug(): string {
  return resolveProjectIdentity().slug;
}
