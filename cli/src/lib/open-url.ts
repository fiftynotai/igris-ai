/**
 * FR-238 (D5) — cross-platform "open this in the user's browser" ladder.
 *
 * PORTED FROM BASH. The only implementation of this ladder in the codebase was
 * the `open_in_browser()` shell function inside
 * `~/.igris/core/skills/visualize/SKILL.md` (§3, "Open the HTML in the Default
 * Browser"). This module reproduces it in TypeScript, verbatim in behaviour and
 * in rung order, so a long-lived verb can use it without shelling out to a
 * skill. The bash original is DELIBERATELY left in place — re-pointing
 * `/visualize` at this module is TD-308's territory and touches a mirrored
 * `core/` file, which FR-238 does not.
 *
 * Accepts a URL **or** a filesystem path so FR-239 and TD-308 can adopt it
 * unchanged.
 *
 * Contract:
 *   - NEVER throws. Every failure mode maps to a discriminated result.
 *   - NEVER `eval`s or builds a shell string. The target is always passed as a
 *     separate argv element (the bash original's "Pass the path as an
 *     argument; never `eval`" rule, enforced structurally here by `execFile`).
 *   - Only `http:`, `https:` and `file:` URLs (or plain paths) are opened.
 *     Anything else is rejected without spawning — an opener handed a
 *     `javascript:` or `vbscript:` target is a code-execution primitive.
 */

import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** What the ladder actually did. */
export type OpenUrlKind =
  /** A platform opener was spawned successfully. */
  | "opened"
  /** No display was available; the caller should print the target itself. */
  | "headless"
  /** No opener on this platform / every rung failed. Not an error. */
  | "failed"
  /** The target was rejected before any spawn (unsupported scheme). */
  | "rejected";

export interface OpenUrlResult {
  kind: OpenUrlKind;
  /** The target as passed in, echoed for the caller's message. */
  url: string;
  /** The opener that ran (`open`, `wslview`, `cmd.exe`, `xdg-open`), if any. */
  opener?: string;
  /** Why, for the `rejected` / `failed` / `headless` cases. */
  reason?: string;
}

export interface OpenUrlOptions {
  /** Injected for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injected for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Injected for tests. Runs an opener; returns true on success. The default
   * implementation spawns detached-and-unref'd so a long-lived server process
   * is never held open by a browser child.
   */
  spawnFn?: (cmd: string, args: string[]) => boolean;
  /** Injected for tests. Returns true when `cmd` is on PATH. */
  hasCommandFn?: (cmd: string) => boolean;
  /** Injected for tests. Returns true when running under WSL. */
  isWslFn?: () => boolean;
}

/** Schemes the ladder will hand to a platform opener. */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "file:"]);

function defaultHasCommand(cmd: string): boolean {
  try {
    execFileSync("command", ["-v", cmd], {
      shell: "/bin/sh",
      stdio: "ignore",
      timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * WSL detection, verbatim from the bash rung 2 predicate
 * (`grep -qi microsoft /proc/version`). A missing `/proc/version` (macOS) is
 * simply "not WSL".
 */
function defaultIsWsl(): boolean {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf-8"));
  } catch {
    return false;
  }
}

function defaultSpawn(cmd: string, args: string[]): boolean {
  try {
    const child = execFile(cmd, args, { timeout: 5_000 });
    // The bash original backgrounds + disowns the Linux rung. Detaching and
    // unref-ing is the Node equivalent, and it matters MORE here: `igris
    // dashboard` is the CLI's first long-lived foreground process (R5), and a
    // ref'd browser child would keep its event loop alive after SIGINT.
    child.unref();
    // A spawn error surfaces asynchronously; swallow it so a failed opener
    // never crashes the server. The `failed` rung is best-effort by design.
    child.on("error", () => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reject anything that is not a plain path or an http/https/file URL.
 *
 * A bare path (`/tmp/graph.html`, `./out.html`) has no scheme and is allowed —
 * that is the `/visualize` call shape. A Windows drive letter (`C:\...`) parses
 * as scheme `c:` and is likewise allowed through the single-letter carve-out.
 */
function isAcceptableTarget(target: string): boolean {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target);
  if (!match) return true; // no scheme — a filesystem path
  const scheme = `${match[1].toLowerCase()}:`;
  if (scheme.length === 2) return true; // `c:` — a Windows drive letter
  return ALLOWED_SCHEMES.has(scheme);
}

/**
 * Open `target` in the OS default browser.
 *
 * Rung order is the bash original's, unchanged:
 *   0. headless guard — no DISPLAY, no WAYLAND_DISPLAY, not darwin -> `headless`
 *   1. macOS      -> `open`
 *   2. WSL        -> `wslview`, else `cmd.exe /c start "" <target>`
 *   3. Linux      -> `xdg-open`
 *   4. fallback   -> `failed` (the caller prints the target; never an error)
 */
export function openUrl(
  target: string,
  options: OpenUrlOptions = {},
): OpenUrlResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const hasCommand = options.hasCommandFn ?? defaultHasCommand;
  const isWsl = options.isWslFn ?? defaultIsWsl;

  if (!isAcceptableTarget(target)) {
    return {
      kind: "rejected",
      url: target,
      reason: "unsupported URL scheme (only http, https, file and plain paths)",
    };
  }

  const isDarwin = platform === "darwin";

  // Rung 0 — headless guard (bash: `[ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]
  // && [[ "$OSTYPE" != darwin* ]]`).
  if (!isDarwin && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return {
      kind: "headless",
      url: target,
      reason: "no DISPLAY and no WAYLAND_DISPLAY",
    };
  }

  // Rung 1 — macOS.
  if (isDarwin) {
    if (spawnFn("open", [target])) {
      return { kind: "opened", url: target, opener: "open" };
    }
    return { kind: "failed", url: target, reason: "`open` failed" };
  }

  // Rung 2 — WSL.
  if (isWsl()) {
    if (hasCommand("wslview") && spawnFn("wslview", [target])) {
      return { kind: "opened", url: target, opener: "wslview" };
    }
    // bash: `cmd.exe /c start "" "$path"` — the empty "" is start's title
    // argument, required so a quoted target is not consumed as the title.
    if (spawnFn("cmd.exe", ["/c", "start", "", target])) {
      return { kind: "opened", url: target, opener: "cmd.exe" };
    }
    return { kind: "failed", url: target, reason: "no WSL opener succeeded" };
  }

  // Rung 3 — Linux.
  if (platform === "linux" && hasCommand("xdg-open")) {
    if (spawnFn("xdg-open", [target])) {
      return { kind: "opened", url: target, opener: "xdg-open" };
    }
  }

  // Rung 4 — fallback. Not an error: the caller prints the target.
  return {
    kind: "failed",
    url: target,
    reason: "no supported opener on this platform",
  };
}

/**
 * The user-facing line for a result, matching the bash original's two printed
 * messages. Returns `null` when the open succeeded and nothing should print.
 */
export function describeOpenResult(result: OpenUrlResult): string | null {
  switch (result.kind) {
    case "opened":
      return null;
    case "headless":
      return `(headless — open manually: ${result.url})`;
    case "rejected":
      return `(refused to open: ${result.reason})`;
    case "failed":
      return `(could not auto-open — open manually: ${result.url})`;
  }
}
