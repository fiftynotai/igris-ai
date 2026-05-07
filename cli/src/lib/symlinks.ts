/**
 * Symlink primitives for `igris install` Phase 2 (M2).
 *
 * Replaces the shell-out to `scripts/igris_install.sh` for the `.claude/`
 * symlink layer. Two functions:
 *
 *   - `linkDir(target, link)` — create a symlink to a directory.
 *   - `linkFile(target, link)` — create a symlink to a regular file.
 *
 * Both are idempotent: if `link` already exists AND points to the same
 * `target`, they no-op. If `link` exists but points elsewhere or is a
 * non-symlink (real file/dir), they throw `SymlinkConflictError` with an
 * actionable message — never silently clobber.
 *
 * Cross-platform note: POSIX-first per V7 out-of-scope. Windows users on
 * native PowerShell are unsupported (WSL works because it presents a
 * POSIX-compatible filesystem). `node:fs.symlinkSync` does support
 * Windows symlinks but requires elevated privileges; we don't surface
 * that as a separate code path.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { dirname } from "node:path";

export class SymlinkConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymlinkConflictError";
  }
}

/**
 * Create a symlink at `link` pointing to the directory `target`.
 *
 * Idempotent: if `link` is already a symlink to `target` (same string,
 * not realpath-resolved), this is a no-op. If `link` is a symlink to a
 * different target OR a regular file/directory, throws.
 *
 * `target` must exist; the function validates it before making the link
 * so a broken symlink is never created from this function. (A subsequent
 * deletion of `target` does produce a broken symlink — that's a separate
 * health check, not this function's concern.)
 *
 * Parent dir of `link` is created if absent (mkdir -p).
 */
export function linkDir(target: string, link: string): void {
  if (!existsSync(target)) {
    throw new SymlinkConflictError(
      `linkDir: target does not exist: ${target}`,
    );
  }
  ensureParent(link);
  applySymlink(target, link, "dir");
}

/**
 * Create a symlink at `link` pointing to the regular file `target`.
 *
 * Idempotent: see `linkDir`. Same conflict semantics.
 *
 * `target` must exist; if it's a directory, throws (use linkDir instead).
 */
export function linkFile(target: string, link: string): void {
  if (!existsSync(target)) {
    throw new SymlinkConflictError(
      `linkFile: target does not exist: ${target}`,
    );
  }
  ensureParent(link);
  applySymlink(target, link, "file");
}

function applySymlink(
  target: string,
  link: string,
  kind: "dir" | "file",
): void {
  // Use lstatSync — we want to inspect the LINK itself, not what it points
  // to. existsSync would follow it.
  let lst;
  try {
    lst = lstatSync(link);
  } catch {
    // Doesn't exist at all; create the link.
    symlinkSync(target, link);
    return;
  }

  if (lst.isSymbolicLink()) {
    // Existing symlink — check if it already points to our target.
    let current: string;
    try {
      current = readlinkSync(link);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SymlinkConflictError(
        `${link} is a symlink but readlink failed: ${msg}`,
      );
    }
    if (current === target) {
      // Idempotent: identical link already in place.
      return;
    }
    throw new SymlinkConflictError(
      `${link} is a symlink to '${current}', expected '${target}'. Remove it manually or run with --fix to repair.`,
    );
  }

  // Existing path is NOT a symlink — refuse to clobber a real file/dir.
  const what = lst.isDirectory() ? "directory" : "file";
  throw new SymlinkConflictError(
    `${link} exists as a real ${what} (not a symlink). Refusing to overwrite. Remove it manually before re-running ${kind === "dir" ? "linkDir" : "linkFile"}.`,
  );
}

function ensureParent(link: string): void {
  const parent = dirname(link);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}
