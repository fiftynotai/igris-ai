/**
 * TD-220: secret-file permission hardening — the SINGLE source of truth for
 * what "loose perms" means and how Igris tightens a secret-bearing file.
 *
 * Both `igris init` (proactive, Igris-owned files) and `igris doctor`
 * (detect + warn + --fix) import this module so they can never disagree on
 * the mask, the win32 skip, or the git-tracked probe.
 *
 * Files in scope: `~/.igris/config.json`, `~/.igris/secrets.env` (Igris-owned,
 * proactively tightened) and the secret-bearing harness configs `~/.claude.json`,
 * `~/.gemini/settings.json`, `~/.codex/config.toml`,
 * `~/.config/opencode/opencode.json` (harness-owned, warn/`--fix`-only).
 *
 * TD-283: antigravity (`~/.gemini/config/mcp_config.json`) and cursor
 * (`~/.cursor/mcp.json`) are INTENTIONALLY out of scope — Igris writes only the
 * env-free brain MCP entry to those (no secret, L-588; that shape stores `${VAR}`
 * verbatim, never a resolved literal like codex), so there is nothing to chmod.
 *
 * CONTRACT: nothing in this module ever throws. An absent file, a Windows
 * host, a missing `git` binary, a non-repo directory, or a race that makes a
 * just-stat'd file vanish must all degrade to a safe default ("ok" / false /
 * no-op) — doctor and init must never crash on perms work.
 *
 * Security (§14): this module touches file METADATA only. It never reads,
 * logs, or echoes a secret file's CONTENTS.
 */

import { chmodSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { debug } from "./log.js";

/**
 * The loose-bit mask. ANY group/other bit (read 0o040/0o004, write
 * 0o020/0o002, or execute 0o010/0o001) trips the flag. `0o077` is the
 * conservative superset that catches 640/644/660/664/755 alike. Exported so
 * tests assert against the SAME constant the implementation uses.
 */
export const SECRET_PERMS_MASK = 0o077;

/** The target mode for a hardened secret file: owner read+write only. */
export const SECRET_FILE_MODE = 0o600;

/**
 * Per-file verdict from {@link checkSecretFilePerms}.
 *
 * - `ok`               — 600, or absent, or win32 (nothing to flag).
 * - `loose`            — `(mode & 0o077) !== 0` (group/other can access it).
 * - `git-tracked`      — tracked in a detected git repo (independent of mode).
 * - `loose+git-tracked`— both of the above.
 */
export type SecretPermsVerdict =
  | "ok"
  | "loose"
  | "git-tracked"
  | "loose+git-tracked";

/**
 * True when POSIX mode bits are meaningful on this host — i.e. NOT win32.
 *
 * On native Windows `fs.chmodSync` is a near-no-op and `statSync().mode` has
 * no POSIX permission bits, so a mode check would false-flag every file.
 * Callers gate BOTH the check and the chmod on this (Decision 1 / Risk R3).
 * WSL reports `linux`, so it is covered.
 *
 * @param platform Test seam — defaults to `process.platform`. Passed
 *   explicitly so the win32-skip test never mutates the real
 *   `process.platform` (Risk R3 test seam).
 */
export function permsCheckSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}

/**
 * True when `path` is tracked in a git repo. Uses
 * `git -C <dir> ls-files --error-unmatch <path>` with `stdio:"ignore"` (so
 * git's stderr never leaks into doctor output). ANY non-zero exit / spawn
 * failure / missing-git binary / non-repo dir → `false`. NEVER throws.
 *
 * The realistic case is "never tracked" (`~/.igris` and `~/` are not repos),
 * so the common path is a single fast non-zero exit swallowed here.
 */
export function isGitTracked(path: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", dirname(path), "ls-files", "--error-unmatch", path],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect a secret file's perms + git-tracked status. NEVER throws.
 *
 * - Absent file or win32 → `"ok"` (nothing to harden).
 * - Otherwise maps the 2×2 of (loose-bits, git-tracked) to the verdict union.
 *
 * The `statSync` is wrapped in try/catch so a race (file vanished between the
 * `existsSync` and the `statSync`) or an unreadable-metadata error degrades to
 * `"ok"` rather than throwing.
 *
 * @param platform Test seam — defaults to `process.platform` (forwarded to
 *   {@link permsCheckSupported} for the win32-skip test).
 */
export function checkSecretFilePerms(
  path: string,
  platform: NodeJS.Platform = process.platform,
): SecretPermsVerdict {
  if (!permsCheckSupported(platform) || !existsSync(path)) {
    return "ok";
  }

  let loose = false;
  try {
    loose = (statSync(path).mode & SECRET_PERMS_MASK) !== 0;
  } catch {
    // Race / unreadable metadata — treat as nothing to flag.
    return "ok";
  }

  const tracked = isGitTracked(path);

  if (loose && tracked) return "loose+git-tracked";
  if (loose) return "loose";
  if (tracked) return "git-tracked";
  return "ok";
}

/**
 * chmod a file to 600, best-effort. NEVER throws (logs at debug on failure).
 * No-op (returns `false`) when the file is absent or on win32. Returns `true`
 * only when a chmod was attempted AND succeeded.
 *
 * @param platform Test seam — defaults to `process.platform`.
 */
export function chmodSecretFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!permsCheckSupported(platform) || !existsSync(path)) {
    return false;
  }
  try {
    chmodSync(path, SECRET_FILE_MODE);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug(`chmod 600 ${path} failed (non-fatal): ${msg}`);
    return false;
  }
}
