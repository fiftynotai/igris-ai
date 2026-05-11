/**
 * Contributor mode: copy a local sibling repo's `core/` tree into
 * `~/.igris/core/`. NO network. Used by `igris init --from-source <path>`
 * during local development AND by tests for hermetic runs.
 *
 * Semantics (per Plan §3 M1.6):
 *
 *   1. Verify `<sourcePath>/core/` exists and is a directory.
 *   2. Recursively copy `<sourcePath>/core/<rel>` → `<destPath>/<rel>`,
 *      preserving directory structure and file modes.
 *   3. After every file is copied, run a `verify_mirror.sh`-style
 *      byte-equality check: read the source bytes, compute sha256,
 *      compare against sha256 of the destination. Fail fast on any
 *      mismatch (this catches partial-write corruption).
 *
 * The destination is the ABSOLUTE caller-controlled path. Typically
 * the verb layer creates `~/.igris/core.new.<pid>/` first and passes
 * that as `destPath`, then hands off to `atomic-extract.ts` for the
 * swap. This module does NOT touch `~/.igris/core/` directly; it
 * stages.
 *
 * Empty `core/` is rejected — a contributor with an empty source dir
 * doesn't mean to wipe their brain. We surface that as an error
 * rather than silently producing an empty staging dir.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";

// `statSync` is used for the entry-point validation below (`<source>/core`
// must follow symlinks if the contributor symlinked their core dir).
// `lstatSync` is used for the recursive walk so we don't follow internal
// symlinks (which would risk infinite loops).
import { join, relative } from "node:path";

export class FromSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FromSourceError";
  }
}

export interface FromSourceOptions {
  /** Absolute path to the contributor's repo root (must contain `core/`). */
  sourcePath: string;
  /** Absolute path to the staging dir where `core/` should land. */
  destPath: string;
}

export interface FromSourceResult {
  /** Number of regular files copied. */
  fileCount: number;
}

/**
 * Copy `<sourcePath>/core/` → `<destPath>/core/` with byte-equality
 * verification on every file.
 */
export function copyFromSource(opts: FromSourceOptions): FromSourceResult {
  const sourceCore = join(opts.sourcePath, "core");
  if (!existsSync(sourceCore)) {
    throw new FromSourceError(
      `from-source: '<source>/core' directory not found at ${sourceCore}`,
    );
  }
  if (!statSync(sourceCore).isDirectory()) {
    throw new FromSourceError(
      `from-source: '<source>/core' is not a directory: ${sourceCore}`,
    );
  }

  const destCore = join(opts.destPath, "core");
  mkdirSync(destCore, { recursive: true });

  let fileCount = 0;
  walkAndCopy(sourceCore, destCore, sourceCore, () => {
    fileCount += 1;
  });

  if (fileCount === 0) {
    throw new FromSourceError(
      `from-source: '<source>/core' contains no files at ${sourceCore} — refusing to stage an empty brain`,
    );
  }

  return { fileCount };
}

/**
 * Recursively walk `srcDir`, copying every regular file to the same
 * relative path under `destDir`. Verifies byte-equality on each copy
 * (sha256 of source == sha256 of dest). Symlinks and special files
 * are skipped with a warning surface — but we don't have a logger
 * dependency here, so we just skip silently.
 */
function walkAndCopy(
  srcDir: string,
  destDir: string,
  srcRoot: string,
  onFile: () => void,
): void {
  const entries = readdirSync(srcDir);
  for (const e of entries) {
    const srcAbs = join(srcDir, e);
    const destAbs = join(destDir, e);
    let st;
    try {
      st = lstatSync(srcAbs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new FromSourceError(
        `from-source: lstat failed for ${srcAbs}: ${msg}`,
      );
    }
    if (st.isSymbolicLink()) {
      // Skip symlinks — we don't carry them across the from-source boundary.
      continue;
    }
    if (st.isDirectory()) {
      mkdirSync(destAbs, { recursive: true });
      walkAndCopy(srcAbs, destAbs, srcRoot, onFile);
      continue;
    }
    if (!st.isFile()) {
      continue;
    }
    // Copy + verify. We use copyFileSync (preserves mtime poorly but
    // that's fine — Igris does not depend on mtime semantics).
    copyFileSync(srcAbs, destAbs);
    const srcSha = sha256File(srcAbs);
    const dstSha = sha256File(destAbs);
    if (srcSha !== dstSha) {
      const rel = relative(srcRoot, srcAbs);
      throw new FromSourceError(
        `from-source: byte mismatch after copy for '${rel}' (sha256 src=${srcSha} dst=${dstSha})`,
      );
    }
    onFile();
  }
}

function sha256File(path: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}
