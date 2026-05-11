/**
 * bridge-missing drift detector — M5.
 *
 * Detects when an installed CLI (per `cli-detect.ts`: PATH binary AND
 * config dir both present) lacks a configured bridge in
 * `~/.igris/config.json#cli_targets`. The user installed Codex AFTER
 * running `igris init`, and now Codex has no bridge wiring — silent gap.
 *
 * `--fix` runs partial-mode `runInit()` to add the missing bridges
 * (preserving everything else). The detector itself is pure.
 *
 * Opt-out semantics: if the user explicitly set `--cli-bridge=none` at
 * `igris init` time, `cli_targets` will be `{}` AND the user's intent
 * was to skip bridges. We treat an explicitly-empty `cli_targets` as
 * "user opted out" and do NOT flag any detected CLI. This matches the
 * `applyBridgeOverride("none")` contract.
 *
 * The doctor's `--fix` for this class reads the auto-detected set and
 * runs `runInit({ upgrade: true })` (bridges-only — config preserved,
 * core/ untouched).
 */

import { existsSync, readFileSync } from "node:fs";
import { configJsonPath } from "../paths.js";
import { detectInstalledCLIs } from "../cli-detect.js";
import type { CLITarget, DriftRow } from "../../types.js";

interface ConfigShape {
  cli_targets?: Record<string, unknown> | null;
}

export interface BridgeMissingOptions {
  /** Test seam — inject a detection result rather than reading the env. */
  detectFn?: () => { detected: Set<CLITarget> };
}

/**
 * Detect bridge-missing drift. Returns one DriftRow per detected CLI
 * that lacks a bridge entry. Empty array when all detected CLIs have
 * bridges (or when no CLIs are detected, or when the user opted out).
 */
export function detectBridgeMissing(
  opts: BridgeMissingOptions = {},
): DriftRow[] {
  const cfg = readConfig();
  if (cfg === null) return [];

  // The "explicit opt-out" signal: cli_targets is present and an object
  // (possibly empty), AND the install ran with --cli-bridge=none. We can't
  // perfectly distinguish "user opted out" from "user installed before
  // any CLI was on PATH" — the install record isn't stored separately.
  // Heuristic: when `cli_targets === {}` (explicitly empty), respect the
  // implicit opt-out. The user can re-run `igris init --upgrade
  // --cli-bridge=auto` to opt back in. Conservative — false-negatives on
  // bridge-missing in this case are acceptable; false-positives are not
  // (the user explicitly said "no bridges").
  const targets = (cfg.cli_targets ?? {}) as Record<string, unknown>;
  if (Object.keys(targets).length === 0 && cfg.cli_targets !== null && cfg.cli_targets !== undefined) {
    return [];
  }

  const det = (opts.detectFn ?? detectInstalledCLIs)();
  const out: DriftRow[] = [];
  for (const cli of det.detected) {
    const has = Object.prototype.hasOwnProperty.call(targets, cli);
    if (!has) {
      out.push({
        slug: "(brain)",
        path: cli,
        driftClass: "bridge-missing",
        recommendedFix: `${cli} detected on PATH but no bridge configured; run 'igris doctor --fix' to wire it`,
      });
    }
  }
  return out;
}

function readConfig(): ConfigShape | null {
  const path = configJsonPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ConfigShape;
  } catch {
    return null;
  }
}
