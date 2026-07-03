/**
 * FR-195 (M1) — the L0 capability-detection pass.
 *
 * A pure function the awaken skill runs first (`igris detect`), and that each
 * other verb also calls internally (it is cheap: a few `existsSync` + one
 * `command -v`). The resulting `mode` drives degradation INSIDE each verb —
 * a missing brain DB is a fresh-start, not an error (SKILL.md's "do NOT block
 * session start" invariant).
 *
 * The lifecycle identity:
 *   - harness        — inferred from the launching CLI's env markers.
 *   - project_slug   — basename(cwd), matching the Mount verbs' default.
 *   - project_path   — process cwd, the path Mount verbs register/assess.
 *   - brain_root     — resolved Igris brain root (`~/.igris` or override).
 *
 * The capability signals:
 *   - brain_db       — `existsSync(brainDbPath())`; the local channel is live.
 *   - sqlite3        — `command -v sqlite3`; only matters for the skill's own
 *                      remaining shell-outs. The verbs use in-process
 *                      better-sqlite3, so the sqlite3 BINARY is NOT required
 *                      by them — this is an improvement over SKILL.md §4.9,
 *                      which shells `sqlite3` directly.
 *   - remote_brain   — `readRemoteBrainConfig() !== null`; the VPS sync channel.
 *
 * `mode` collapses these into the single verdict each verb branches on:
 *   - no brain DB         → `degraded-no-db`   (highest precedence: no local
 *                            channel ⇒ every local verb is a fresh-start).
 *   - DB present, no remote→ `degraded-no-remote` (local verbs run; boot-sync
 *                            skips its pulls).
 *   - both present        → `full`.
 */

import { existsSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { brainDbPath, brainDir } from "./paths.js";
import { readRemoteBrainConfig } from "./mcp-client.js";
import type { DetectResult } from "../types.js";

/**
 * The harness-marker table: ordered [env-var markers, harness] pairs. FIRST
 * match wins, so the order encodes precedence:
 *   - Antigravity (agy) is a gemini-family harness but sets its OWN marker, so
 *     it is checked BEFORE gemini (the more-specific marker wins).
 *   - Cursor (FR-192): cursor-agent sets CURSOR_AGENT=1 in every tool/shell
 *     subprocess it spawns (verified `env:{CURSOR_AGENT:"1"}`); the launcher
 *     wrapper additionally exports CURSOR_INVOKED_AS.
 * SINGLE SOURCE OF TRUTH for the marker names — {@link HARNESS_ENV_MARKERS}
 * (below) is derived from this table so a test can fully sandbox harness
 * inference by clearing EVERY marker (clearing a partial set lets a live
 * harness's ambient marker, e.g. CLAUDE_CODE_ENTRYPOINT, leak in — TD-299).
 */
const HARNESS_MARKER_TABLE: ReadonlyArray<
  readonly [readonly string[], DetectResult["harness"]]
> = [
  [["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"], "claude"],
  [["ANTIGRAVITY", "AGY_SESSION"], "antigravity"],
  [["GEMINI_CLI", "GEMINI_SESSION"], "gemini"],
  [["CODEX_SESSION", "CODEX_HOME"], "codex"],
  [["OPENCODE", "OPENCODE_SESSION"], "opencode"],
  [["CURSOR_AGENT", "CURSOR_INVOKED_AS"], "cursor"],
];

/**
 * Every env var {@link inferHarness} reads as a harness marker (flattened from
 * {@link HARNESS_MARKER_TABLE}). Exported so tests fully sandbox harness
 * inference — clear ALL of these in setup so an ambient marker from the live
 * harness the suite runs inside cannot leak into a `detect` call (TD-299).
 */
export const HARNESS_ENV_MARKERS: readonly string[] =
  HARNESS_MARKER_TABLE.flatMap(([markers]) => markers);

/**
 * Infer the launching harness from environment markers.
 *
 * Best-effort and side-effect-free: each harness exports a distinctive env
 * var at session start. Unknown when no marker matches (e.g. a bare CLI run
 * outside any agent harness) — `unknown` is a valid, non-degrading value
 * (the harness identity does not gate any local read).
 */
function inferHarness(): DetectResult["harness"] {
  const env = process.env;
  for (const [markers, harness] of HARNESS_MARKER_TABLE) {
    if (markers.some((m) => env[m] !== undefined)) {
      return harness;
    }
  }
  return "unknown";
}

/**
 * Probe `process.env.PATH` for a regular-file/symlink entry named `bin`.
 * Mirrors the `cli-detect.ts#findOnPath` probe shape (existsSync per PATH
 * dir). Returns true on the first hit.
 */
function commandOnPath(bin: string): boolean {
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const d of pathDirs) {
    if (existsSync(join(d, bin))) {
      return true;
    }
  }
  return false;
}

/**
 * Run the L0 detection. Side-effect-free; safe to call once per verb.
 */
export function detectCapabilities(): DetectResult {
  const harness = inferHarness();
  const brainDb = existsSync(brainDbPath());
  const sqlite3 = commandOnPath("sqlite3");
  const remoteBrain = readRemoteBrainConfig() !== null;
  const projectPath = process.cwd();

  // Mode precedence: no local DB dominates (a fresh start with no resume),
  // then no remote (local-only run), else full.
  let mode: DetectResult["mode"];
  if (!brainDb) {
    mode = "degraded-no-db";
  } else if (!remoteBrain) {
    mode = "degraded-no-remote";
  } else {
    mode = "full";
  }

  return {
    harness,
    project_slug: basename(projectPath),
    project_path: projectPath,
    brain_root: brainDir(),
    brain_db: brainDb,
    sqlite3,
    remote_brain: remoteBrain,
    mode,
  };
}
