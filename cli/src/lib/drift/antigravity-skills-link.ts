/**
 * antigravity-skills-link drift detector — FR-179 Phase C (R2).
 *
 * Detects when Antigravity is installed (per `cli-detect.ts`: the `agy` binary
 * on PATH AND `~/.gemini` present) but its native skills-loader path
 * `~/.gemini/antigravity-cli/skills` does NOT resolve to the shared
 * `~/.agents/skills` (the link is absent, points elsewhere, or has been shadowed
 * by a real dir from an `agy` refresh). In that state antigravity loads ZERO
 * Igris skills — a silent gap, exactly the R2 failure mode.
 *
 * The detector is PURE (read-only). `--fix` reuses `linkAntigravitySkills()`
 * (the same idempotent-repair `igris install` runs) to create/repoint the link;
 * a real NON-EMPTY dir is refused (never clobbered) and stays flagged for manual
 * resolution.
 *
 * Mirrors `bridge-missing.ts`: CLI-detection-driven, brain-level synthetic row,
 * fires only when the harness is actually installed.
 */

import { antigravitySkillsLinkOk } from "../antigravity-skills.js";
import {
  antigravitySkillsLinkPath,
  agentsSkillsDirPath,
} from "../paths.js";
import { detectInstalledCLIs } from "../cli-detect.js";
import type { CLITarget, DriftRow } from "../../types.js";

export interface AntigravitySkillsLinkOptions {
  /** Test seam — inject a detection result rather than reading the env. */
  detectFn?: () => { detected: Set<CLITarget> };
  /** Test seam — override the link / target paths (sandbox HOME). */
  linkPath?: string;
  target?: string;
}

/**
 * Detect antigravity-skills-link drift. Returns a single DriftRow when `agy` is
 * detected but the skills parent symlink does not resolve to the shared dir.
 * Returns null when antigravity is not installed OR the link is already correct.
 */
export function detectAntigravitySkillsLink(
  opts: AntigravitySkillsLinkOptions = {},
): DriftRow | null {
  const det = (opts.detectFn ?? detectInstalledCLIs)();
  if (!det.detected.has("antigravity")) return null;

  const linkPath = opts.linkPath ?? antigravitySkillsLinkPath();
  const target = opts.target ?? agentsSkillsDirPath();

  if (antigravitySkillsLinkOk({ linkPath, target })) return null;

  return {
    slug: "(brain)",
    path: linkPath,
    driftClass: "antigravity-skills-link",
    recommendedFix: `antigravity detected but ${linkPath} does not link to ${target}; run 'igris doctor --fix' (or 'igris init --upgrade') to repair`,
  };
}
