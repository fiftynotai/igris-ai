/**
 * Atomic core swap.
 *
 * Sequence (per Plan §3 M1.4 + brief Architecture):
 *
 *   1. extract  — caller hands us a path to a freshly extracted dir
 *                 (typically `~/.igris/core.new.<pid>/core/`).
 *   2. backup   — if `~/.igris/core/` exists, rename it to
 *                 `~/.igris/core.bak.<ISO-ts>/`. (Only on --upgrade;
 *                 fresh init has no `core/` to back up — caller
 *                 controls via `existingCorePath` being absent.)
 *   3. swap     — rename the new dir to `~/.igris/core/`.
 *   4. cleanup  — keep ONE bak ring: delete previous `core.bak.*`
 *                 directories. (We keep the most-recent one for
 *                 emergency recovery.)
 *
 * Rollback: if step 3 fails, step 2's bak is renamed back to `core/`.
 * If step 2 fails, the new dir at `core.new.<pid>/` is left for the
 * caller to inspect; no swap happens.
 *
 * Concurrency: each pid writes to `core.new.<pid>/`, so two parallel
 * `igris init` invocations don't fight over the staging dir. The
 * final `core/` swap is a single rename (atomic on the same
 * filesystem). Cross-filesystem renames fall back to copy+remove,
 * which `node:fs.renameSync` handles via EXDEV; we surface that
 * error with an actionable message because the brain dir SHOULD
 * always be on a single fs.
 */

import {
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export class AtomicExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomicExtractError";
  }
}

export interface AtomicSwapOptions {
  /** Absolute path to the freshly-extracted dir (becomes the new `core/`). */
  newCorePath: string;
  /** Absolute path where `core/` should ultimately live. */
  existingCorePath: string;
  /**
   * If true and `existingCorePath` exists, rename it to `core.bak.<ts>/`
   * before swap. If false (fresh init) and `existingCorePath` exists,
   * an error is raised — caller should pass `--upgrade` (or delete the
   * existing dir). Default: false.
   */
  upgrade: boolean;
  /**
   * If false (default), keep ONE prior `core.bak.*` for recovery; older
   * baks are deleted. If true, keep all baks. Tests use this to assert
   * the cleanup behavior.
   */
  keepAllBaks?: boolean;
}

export interface AtomicSwapResult {
  /** The bak path created during swap (null on fresh init, or no-op upgrade). */
  bakPath: string | null;
  /** ISO-8601 timestamp of the swap (also embedded in bakPath). */
  swappedAt: string;
}

/**
 * Atomically swap `newCorePath` → `existingCorePath`. Rolls back on
 * failure. Returns the path of the backup created (if any).
 */
export function atomicSwap(opts: AtomicSwapOptions): AtomicSwapResult {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const swappedAt = new Date().toISOString();

  if (!existsSync(opts.newCorePath)) {
    throw new AtomicExtractError(
      `new core dir does not exist: ${opts.newCorePath}`,
    );
  }
  if (!statSync(opts.newCorePath).isDirectory()) {
    throw new AtomicExtractError(
      `new core path is not a directory: ${opts.newCorePath}`,
    );
  }

  // Step 1: handle existing core/.
  let bakPath: string | null = null;
  if (existsSync(opts.existingCorePath)) {
    if (!opts.upgrade) {
      throw new AtomicExtractError(
        `existing brain core present at ${opts.existingCorePath}; pass upgrade=true to back it up before swap`,
      );
    }
    bakPath = `${opts.existingCorePath}.bak.${ts}`;
    try {
      renameSync(opts.existingCorePath, bakPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AtomicExtractError(
        `failed to back up existing core to ${bakPath}: ${msg}`,
      );
    }
  }

  // Step 2: swap new → existing.
  try {
    renameSync(opts.newCorePath, opts.existingCorePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Rollback: restore bak → existing if we created one.
    if (bakPath !== null && existsSync(bakPath)) {
      try {
        renameSync(bakPath, opts.existingCorePath);
      } catch (rbErr) {
        const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
        throw new AtomicExtractError(
          `swap failed (${msg}) AND rollback failed (${rbMsg}); manual recovery: bak still at ${bakPath}`,
        );
      }
    }
    throw new AtomicExtractError(`swap failed and rolled back: ${msg}`);
  }

  // Step 3: cleanup older baks unless keepAllBaks.
  if (!opts.keepAllBaks && bakPath !== null) {
    cleanupOldBaks(opts.existingCorePath, bakPath);
  }

  return { bakPath, swappedAt };
}

/**
 * Delete previous `core.bak.*` siblings, keeping only the just-created
 * bak. Called inside `atomicSwap` after a successful swap. Also
 * exported for tests.
 */
export function cleanupOldBaks(
  existingCorePath: string,
  keepBakPath: string,
): void {
  const parentDir = parentOf(existingCorePath);
  const corePrefix = `${baseName(existingCorePath)}.bak.`;
  let entries: string[];
  try {
    entries = readdirSync(parentDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(corePrefix)) continue;
    const full = join(parentDir, entry);
    if (full === keepBakPath) continue;
    try {
      rmSync(full, { recursive: true, force: true });
    } catch {
      // Non-fatal; bak cleanup failure shouldn't block the swap.
    }
  }
}

function parentOf(path: string): string {
  const lastSep = path.lastIndexOf("/");
  if (lastSep === -1) return ".";
  if (lastSep === 0) return "/";
  return path.slice(0, lastSep);
}

function baseName(path: string): string {
  const lastSep = path.lastIndexOf("/");
  return lastSep === -1 ? path : path.slice(lastSep + 1);
}

/**
 * Construct the canonical staging path for the running pid. Used by
 * the verb layer to materialize an extraction target before calling
 * `atomicSwap`. Made deterministic so test cleanup can target it.
 */
export function stagingDirFor(brainDir: string, pid: number = process.pid): string {
  return join(brainDir, `core.new.${pid}`);
}
