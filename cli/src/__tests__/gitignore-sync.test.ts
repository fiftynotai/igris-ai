/**
 * gitignore-sync.test.ts — TD-140.
 *
 * Guards the contract that every workstation-side `.gitignore` pattern
 * has a corresponding `RSYNC_EXCLUDES` entry in cli/src/lib/sync/code.ts.
 *
 * Direction: .gitignore → RSYNC_EXCLUDES (this file).
 * Reverse direction (RSYNC_EXCLUDES → audit list) is in sync-code.test.ts
 * (the "TD-135: rsync exclusion list mirrors .gitignore essentials" case).
 *
 * Both tests together pin the bidirectional drift contract.
 *
 * Normalization rules applied to .gitignore patterns:
 *   - Skip blank lines and comments (lines starting with #).
 *   - Skip allow-list lines (starting with !) — these UN-ignore and
 *     have no rsync equivalent direction.
 *   - Expand character-class globs: `*.py[cod]` → [*.pyc, *.pyo, *.pyd].
 *   - Skip patterns known to be Python virtual-env artifacts that don't
 *     exist in this repo (allow-list: `*$py.class`, `.Python`).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Patterns intentionally NOT mirrored in RSYNC_EXCLUDES.
 *
 * Reason for each:
 *   - "*$py.class" — Jython class-file marker; not present in this repo.
 *   - ".Python"    — pyvenv directory marker; not present in this repo.
 *
 * If you encounter these on the workstation, add them to RSYNC_EXCLUDES
 * and remove from this allow-list.
 */
const GITIGNORE_SKIP_PATTERNS = new Set<string>(["*$py.class", ".Python"]);

/** Expand a single .gitignore pattern into the rsync patterns it implies. */
function expandPattern(pattern: string): string[] {
  // Character class: `*.py[cod]` → [`*.pyc`, `*.pyo`, `*.pyd`].
  const classMatch = pattern.match(/^(.+?)\[([^\]]+)\](.*)$/);
  if (classMatch !== null) {
    const [, prefix, chars, suffix] = classMatch;
    return [...chars].map((ch) => `${prefix}${ch}${suffix}`);
  }
  return [pattern];
}

function loadGitignorePatterns(): string[] {
  // resolve(__dirname, "../../../.gitignore") would be repo root, but
  // __dirname here resolves to <repo>/cli/src/__tests__. Walk up 3 dirs.
  const path = resolve(__dirname, "../../../.gitignore");
  const text = readFileSync(path, "utf-8");
  const patterns: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue; // blank
    if (line.startsWith("#")) continue; // comment
    if (line.startsWith("!")) continue; // allow-list (un-ignore)
    if (GITIGNORE_SKIP_PATTERNS.has(line)) continue;
    for (const expanded of expandPattern(line)) {
      patterns.push(expanded);
    }
  }
  return patterns;
}

async function loadRsyncExcludes(): Promise<readonly string[]> {
  const mod = await import("../lib/sync/code.js");
  return mod.RSYNC_EXCLUDES;
}

describe("TD-140: .gitignore patterns must be mirrored in RSYNC_EXCLUDES", () => {
  it("every (non-skipped, expanded) .gitignore pattern appears in RSYNC_EXCLUDES", async () => {
    const gitignorePatterns = loadGitignorePatterns();
    const rsyncExcludes = await loadRsyncExcludes();
    expect(gitignorePatterns.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const pattern of gitignorePatterns) {
      if (!rsyncExcludes.includes(pattern)) {
        missing.push(pattern);
      }
    }
    expect(missing).toEqual([]);
  });
});
