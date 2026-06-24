/**
 * Brain config defaults — `igris install` cognition guardrails (FR-191).
 *
 * Both cognition instances (perception + subconscious) default OFF under the
 * `cognition.*` namespace. The install/init guardrail writes the NESTED key
 * only-set-if-absent so it never silently reverts an operator who later flips
 * a flag back ON (FR-122 re-enable path; the TD-102 never-revert contract).
 *
 * Contract (per instance, preserved verbatim from the prior shell + TD-102):
 *
 *   - If `~/.igris/config.json` does not exist, do nothing (a separate
 *     bootstrap path owns config.json creation; install does not).
 *   - If `cognition.<instance>.enabled` is ABSENT, set it to `false`.
 *   - If `cognition.<instance>.enabled` is PRESENT (any value), do NOT touch
 *     it — preserve operator overrides verbatim.
 *
 * The "only set if absent" semantics is the critical bit (TD-102 explicit):
 * once an engine is re-enabled by an operator, the install verb must not
 * silently revert it.
 *
 * FR-191 dropped the legacy top-level `subconscious` block (no installs to
 * migrate — the feature never shipped to consumers) and the migration shim;
 * the resolver reads `cognition.subconscious` nested-only.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { configJsonPath } from "./paths.js";
import { chmodSecretFile } from "./secret-perms.js";

export type CognitionDefaultOutcome =
  | "config_missing"   // config.json doesn't exist — no-op
  | "default_set"      // key was absent, we wrote it as false
  | "preserved"        // key was present, we left it alone
  | "config_malformed"; // config.json was unreadable — no-op (graceful)

/** Back-compat alias — callers/tests refer to the subconscious outcome type. */
export type SubconsciousDefaultOutcome = CognitionDefaultOutcome;

/**
 * Apply `cognition.<instance>.enabled=false` only-set-if-absent to the runtime
 * brain config.json. Atomic tmp+rename + TD-220 perm re-tightening. Returns the
 * outcome so callers can log or surface in dry-run plans.
 */
function applyCognitionDefault(
  instance: "perception" | "subconscious",
): CognitionDefaultOutcome {
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

  const cognition = (cfg.cognition ?? null) as Record<string, unknown> | null;
  const section =
    cognition !== null
      ? ((cognition[instance] ?? null) as Record<string, unknown> | null)
      : null;

  // If the instance section exists AND has the `enabled` key, never touch it.
  if (
    section !== null &&
    Object.prototype.hasOwnProperty.call(section, "enabled")
  ) {
    return "preserved";
  }

  // Either cognition / the instance section is absent OR it's present without
  // `enabled`. Set the default; preserve any other keys at both levels.
  const next: Record<string, unknown> = {
    ...cfg,
    cognition: {
      ...(cognition ?? {}),
      [instance]: {
        ...(section ?? {}),
        enabled: false,
      },
    },
  };

  const tmp = `${cfgPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, cfgPath);
  // TD-220 (R2): renameSync adopts the tmp file's umask-default mode (often
  // 644), NOT config.json's prior 600. Re-tighten so an `igris install`
  // (which calls this) cannot silently re-loosen what `igris init` hardened.
  // This is an Igris-OWNED file, so TD-220 must close the gap here.
  chmodSecretFile(cfgPath);
  return "default_set";
}

/**
 * Apply the `cognition.subconscious.enabled=false` default. See
 * {@link applyCognitionDefault} for the contract.
 */
export function applySubconsciousDefault(): CognitionDefaultOutcome {
  return applyCognitionDefault("subconscious");
}

/**
 * Apply the `cognition.perception.enabled=false` default (FR-191). Mirrors the
 * subconscious guardrail; see {@link applyCognitionDefault} for the contract.
 */
export function applyPerceptionDefault(): CognitionDefaultOutcome {
  return applyCognitionDefault("perception");
}
