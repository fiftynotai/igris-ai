/**
 * FR-212c: GLOBAL canonical-hooks merge into `~/.claude/settings.json`.
 *
 * In the FR-212 global-projection model the Igris hooks fire for EVERY project
 * on the machine via ONE user-level settings block (the per-project `_gate.sh`
 * de-no-ops them only inside a registered Igris project). The merge ENGINE
 * (`mergeCanonicalHooks`) and the canonical SOURCE
 * (`~/.igris/core/hooks/canonical-settings.json`) are UNCHANGED from the old
 * install-step-6 — only the TARGET moves from `<proj>/.claude/settings.json`
 * (`projectSettingsPath`) to `~/.claude/settings.json` (`claudeUserSettingsPath`).
 *
 * Posture (mirrors install.ts step 6): idempotent, no-clobber (a malformed
 * existing file is REFUSED, not overwritten), atomic write via `.tmp.<pid>.<ts>`
 * + rename, single `.bak.<timestamp>` of any prior file (unless IGRIS_KEEP_BAK=0).
 * NEVER throws on a write/merge error — returns a `failed` outcome the caller
 * warn-and-continues on (init must reach exit 0 even if the global hooks can't
 * be written).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { loadCanonicalHooks } from "./canonical-hooks.js";
import { mergeCanonicalHooks, MalformedSettingsError } from "./json-merge.js";
import { claudeUserSettingsPath } from "./paths.js";

export type GlobalHooksOutcome =
  | "merged" // canonical block written / refreshed
  | "unchanged" // already byte-identical (idempotent no-op write avoided)
  | "failed"; // malformed existing file or write error (non-fatal to caller)

export interface GlobalHooksResult {
  outcome: GlobalHooksOutcome;
  /** The settings file targeted (or the would-be target on dry-run). */
  path: string;
  /** Populated when `outcome === "failed"`. */
  error?: string;
}

function backupSettings(filePath: string): void {
  if (process.env.IGRIS_KEEP_BAK === "0") return;
  if (!existsSync(filePath)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(`${filePath}.bak.${ts}`, readFileSync(filePath, "utf-8"));
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

/**
 * Merge the canonical Igris hooks block into `~/.claude/settings.json`.
 * `opts.settingsPath` overrides the target (tests sandbox HOME and pass it).
 * NEVER throws.
 */
export function mergeGlobalCanonicalHooks(opts?: {
  settingsPath?: string;
}): GlobalHooksResult {
  const targetPath = opts?.settingsPath ?? claudeUserSettingsPath();

  let canonical;
  try {
    canonical = loadCanonicalHooks();
  } catch (err) {
    return {
      outcome: "failed",
      path: targetPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let existing: Record<string, unknown> = {};
  let existingText: string | null = null;
  if (existsSync(targetPath)) {
    try {
      existingText = readFileSync(targetPath, "utf-8");
      existing = JSON.parse(existingText) as Record<string, unknown>;
    } catch (err) {
      // No-clobber: an unreadable/malformed user settings file is REFUSED.
      return {
        outcome: "failed",
        path: targetPath,
        error: `refusing to clobber unreadable ${targetPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  let merged: Record<string, unknown>;
  try {
    merged = mergeCanonicalHooks(existing, canonical);
  } catch (err) {
    if (err instanceof MalformedSettingsError) {
      return {
        outcome: "failed",
        path: targetPath,
        error: `settings.json merge failed (refusing to clobber): ${err.message}`,
      };
    }
    return {
      outcome: "failed",
      path: targetPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const serialized = JSON.stringify(merged, null, 2) + "\n";
  // Idempotency: skip the write (and the backup) when nothing changed.
  if (existingText !== null && existingText === serialized) {
    return { outcome: "unchanged", path: targetPath };
  }

  try {
    // Benign-create the parent dir (`~/.claude/`). At `igris init` the dir
    // already exists, but `igris update`/`igris doctor --fix` can call this on a
    // machine where `~/.claude/` was never created — without this the atomic
    // tmp-write ENOENTs (FR-212d). Idempotent; recursive.
    mkdirSync(dirname(targetPath), { recursive: true });
    backupSettings(targetPath);
    atomicWrite(targetPath, serialized);
  } catch (err) {
    return {
      outcome: "failed",
      path: targetPath,
      error: `could not write ${targetPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return { outcome: "merged", path: targetPath };
}
