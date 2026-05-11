/**
 * Brain config defaults — `igris install` Phase 2 (M2, Risk A3).
 *
 * Ports the subconscious-engine default-disable behavior from
 * `scripts/igris_install.sh:166-188` (TD-102: rule-based engine had a 2%
 * true-positive rate; redesign tracked under FR-118).
 *
 * Contract (preserved verbatim from shell):
 *
 *   - If `~/.igris/config.json` does not exist, do nothing (a separate
 *     bootstrap path owns config.json creation; install does not).
 *   - If `subconscious.enabled` is ABSENT in config.json, set it to `false`.
 *   - If `subconscious.enabled` is PRESENT (any value), do NOT touch it —
 *     preserve operator overrides verbatim.
 *
 * The "only set if absent" semantics is the critical bit (TD-102 explicit):
 * once the engine is re-enabled by an operator after FR-118 ships, the
 * install verb must not silently revert it.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { configJsonPath } from "./paths.js";

export type SubconsciousDefaultOutcome =
  | "config_missing"   // config.json doesn't exist — no-op
  | "default_set"      // key was absent, we wrote it as false
  | "preserved"        // key was present, we left it alone
  | "config_malformed"; // config.json was unreadable — no-op (graceful)

/**
 * Apply the subconscious.enabled=false default to the runtime brain
 * config.json. See module docstring for the contract.
 *
 * Returns the outcome so callers can log or surface in dry-run plans.
 */
export function applySubconsciousDefault(): SubconsciousDefaultOutcome {
  const cfgPath = configJsonPath();
  if (!existsSync(cfgPath)) {
    return "config_missing";
  }

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return "config_malformed";
  }

  const subconscious = (cfg.subconscious ?? null) as Record<string, unknown> | null;

  // If the section exists AND has the `enabled` key, never touch it.
  if (subconscious !== null && Object.prototype.hasOwnProperty.call(subconscious, "enabled")) {
    return "preserved";
  }

  // Either subconscious is absent OR it's present without `enabled`.
  // Set the default; preserve any other keys in the section.
  const next: Record<string, unknown> = {
    ...cfg,
    subconscious: {
      ...(subconscious ?? {}),
      enabled: false,
    },
  };

  const tmp = `${cfgPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, cfgPath);
  return "default_set";
}
