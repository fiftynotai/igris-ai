/**
 * brain-core-missing drift detector — M5.
 *
 * Detects when `~/.igris/core/` is absent or empty. This is the catastrophic
 * drift case: every project install relies on `~/.igris/core/` for symlink
 * targets, hook commands, and skill/agent definitions. If it's gone, every
 * project is silently broken.
 *
 * `--fix` invokes `runRefresh()` to re-fetch from the recorded channel
 * (or fails fast if `.install-source.json` is also missing — at that
 * point the user needs `igris init`, not refresh).
 *
 * Pure detection function — fs reads only, no network. The caller (doctor)
 * decides whether to invoke the fix path.
 */

import { existsSync, readdirSync } from "node:fs";
import { brainDir } from "../paths.js";
import { join } from "node:path";
import type { DriftRow } from "../../types.js";

/**
 * Detect brain-core-missing drift. Returns a single DriftRow when missing
 * or empty, null otherwise. Sentinel-wide check (synthetic slug "(brain)").
 */
export function detectBrainCoreMissing(): DriftRow | null {
  const corePath = join(brainDir(), "core");
  if (!existsSync(corePath)) {
    return {
      slug: "(brain)",
      path: corePath,
      driftClass: "brain-core-missing",
      recommendedFix:
        "run 'igris doctor --fix' (invokes refresh) or 'igris init' if no install-source.json",
    };
  }

  // Empty dir is also "missing" — readdir returns []. Distinguish a stale
  // staging-leftover dir from a populated core/ by checking for the
  // canonical hooks file (the most-load-bearing entry under core/).
  let entries: string[];
  try {
    entries = readdirSync(corePath);
  } catch {
    // Permission error or non-dir — treat as missing.
    return {
      slug: "(brain)",
      path: corePath,
      driftClass: "brain-core-missing",
      recommendedFix: "core/ exists but is unreadable; check permissions and re-run 'igris doctor --fix'",
    };
  }

  if (entries.length === 0) {
    return {
      slug: "(brain)",
      path: corePath,
      driftClass: "brain-core-missing",
      recommendedFix: "core/ is empty; run 'igris doctor --fix' to refresh",
    };
  }

  // Canonical hooks file is the load-bearing minimum — without it, every
  // project install fails the canonical-hooks-required gate. We treat its
  // absence as "core is effectively missing" even when other files exist.
  const canonical = join(corePath, "hooks", "canonical-settings.json");
  if (!existsSync(canonical)) {
    return {
      slug: "(brain)",
      path: corePath,
      driftClass: "brain-core-missing",
      recommendedFix: "core/hooks/canonical-settings.json missing; run 'igris doctor --fix' to refresh",
    };
  }

  return null;
}
