/**
 * FR-274 — read the knowledge watermark (HEAD SHA + checked-out branch) of a
 * project's working copy.
 *
 * The HEAD read is of the project ROW's path (D4) and only at a repo TOP level:
 * `rev-parse --show-toplevel` must realpath-equal realpath(path), so a project
 * directory nested inside another repo (a dotfiles-tracked `~`, a monorepo
 * sub-package) never records the PARENT repo's HEAD. That predicate is a
 * REPRODUCED twin of the brain's `isRepoTopLevel`
 * (`brain-mcp-server/src/tools/projects.ts`) — `cli/` and `brain-mcp-server/`
 * are separate packages with zero cross-imports (the `brain-db.ts` header's
 * "reproduce, don't import" rule).
 *
 * Every git spawn: no shell, a 3 s cap, `GIT_TERMINAL_PROMPT=0`, and the
 * inherited GIT_* location variables STRIPPED — a `GIT_DIR` / `GIT_WORK_TREE`
 * exported by a git hook or a harness would otherwise point `-C <path>` at a
 * different repository and record its SHA (mutation M9).
 *
 * Never throws. Any failure is `{ ok: false, reason }`, and the caller writes
 * NOTHING on a failure (the never-blank rule, D8).
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { KNOWLEDGE_SHA_RE } from "./brain-db.js";
import { expandTilde } from "./paths.js";

const GIT_ENV_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
] as const;

/** A successful HEAD read, or the reason there is none. */
export type HeadWatermarkRead =
  | { ok: true; path: string; sha: string; branch: string | null }
  | { ok: false; path: string; reason: string };

interface GitRun {
  /** Exit status; null when git could not be spawned or timed out. */
  status: number | null;
  stdout: string;
  /** True when the `git` binary itself was not found. */
  missing: boolean;
}

function git(cwd: string, args: string[]): GitRun {
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
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Read HEAD of the git working copy whose TOP level is `path` (a leading `~/`
 * is expanded against HOME).
 *
 * Detached HEAD is `symbolic-ref -q --short HEAD` exiting 1 → `branch: null`;
 * any other non-zero exit is a git failure and the whole read fails.
 *
 * @param path - The project row's `path`.
 * @returns The SHA and branch, or the reason nothing should be recorded.
 */
export function readHeadWatermark(path: string): HeadWatermarkRead {
  const p = expandTilde(path);
  const fail = (reason: string): HeadWatermarkRead => ({ ok: false, path: p, reason });

  if (!existsSync(p)) return fail(`path absent: ${p}`);

  const top = git(p, ["rev-parse", "--show-toplevel"]);
  if (top.missing) return fail("git not available on PATH");
  if (top.status !== 0 || top.stdout === "") return fail(`not a git working copy: ${p}`);
  const real = realpathOrNull(p);
  if (real === null || (realpathOrNull(top.stdout) ?? top.stdout) !== real) {
    return fail(`not a repo top level: ${p} is inside ${top.stdout}`);
  }

  const head = git(p, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (head.status !== 0 || head.stdout === "") return fail("no commit at HEAD (unborn or broken HEAD)");
  if (!KNOWLEDGE_SHA_RE.test(head.stdout)) return fail(`invalid HEAD object name: ${head.stdout.slice(0, 80)}`);

  const ref = git(p, ["symbolic-ref", "-q", "--short", "HEAD"]);
  let branch: string | null;
  if (ref.status === 0 && ref.stdout !== "") branch = ref.stdout;
  else if (ref.status === 1) branch = null; // detached HEAD
  else return fail("git symbolic-ref failed");

  return { ok: true, path: p, sha: head.stdout, branch };
}
