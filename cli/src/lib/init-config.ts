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
import {
  classifySyncTransport,
  isInsecureSyncAllowed,
} from "./sync-transport.js";
import { warn } from "./log.js";

export type CognitionDefaultOutcome =
  | "config_missing"   // config.json doesn't exist — no-op
  | "default_set"      // key was absent, we wrote it as false
  | "preserved"        // key was present, we left it alone
  | "config_malformed"; // config.json was unreadable — no-op (graceful)

/** Back-compat alias — callers/tests refer to the subconscious outcome type. */
export type SubconsciousDefaultOutcome = CognitionDefaultOutcome;

/**
 * Atomically write the next config.json + re-tighten perms (TD-220).
 *
 * Extract-method factored out of {@link applyCognitionDefault} (FR-122) so the
 * default writer, the explicit cognition toggle, and the remote_brain set/clear
 * all share ONE atomic-write body: tmp file → rename → chmod 600.
 *
 * renameSync adopts the tmp file's umask-default mode (often 644), NOT the
 * prior 600, so the chmod re-tighten is mandatory on every write of an
 * Igris-owned secret-bearing file (config.json carries the api_key). Same
 * rationale as the pre-FR-122 inline tail; no behavior change.
 */
function writeConfigAtomic(next: Record<string, unknown>): void {
  const cfgPath = configJsonPath();
  const tmp = `${cfgPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, cfgPath);
  chmodSecretFile(cfgPath);
}

/**
 * Read + parse config.json, returning `null` when it is absent or unreadable.
 * Callers map `null` to the graceful `config_missing` / `config_malformed`
 * outcomes — nothing throws.
 */
function readConfig(): Record<string, unknown> | null {
  const cfgPath = configJsonPath();
  if (!existsSync(cfgPath)) return null;
  try {
    return JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Apply `cognition.<instance>.enabled=false` only-set-if-absent to the runtime
 * brain config.json. Atomic tmp+rename + TD-220 perm re-tightening. Returns the
 * outcome so callers can log or surface in dry-run plans.
 */
function applyCognitionDefault(
  instance: "perception" | "subconscious" | "synapse" | "janitor",
): CognitionDefaultOutcome {
  const cfg = readConfig();
  if (cfg === null) {
    // Distinguish absent (config_missing) from unreadable (config_malformed):
    // a present-but-unparseable file still exists on disk.
    return existsSync(configJsonPath()) ? "config_malformed" : "config_missing";
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

  // TD-220 (R2): atomic tmp+rename + re-tighten to 600 (renameSync adopts the
  // tmp file's umask-default mode, not config.json's prior 600). Shared body —
  // see writeConfigAtomic.
  writeConfigAtomic(next);
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

/**
 * Apply the `cognition.synapse.enabled=false` default (FR-211). Mirrors the
 * subconscious/perception guardrail; see {@link applyCognitionDefault} for the
 * contract. Synapse is the edge-inference cognition instance — default OFF.
 */
export function applySynapseDefault(): CognitionDefaultOutcome {
  return applyCognitionDefault("synapse");
}

/**
 * Apply the `cognition.janitor.enabled=false` default (FR-119). Mirrors the
 * synapse/perception/subconscious guardrail; see {@link applyCognitionDefault}
 * for the contract. Janitor is the memory-hygiene cognition instance (near-dupe
 * merge + TD-086 coordination) — default OFF.
 */
export function applyJanitorDefault(): CognitionDefaultOutcome {
  return applyCognitionDefault("janitor");
}

// --------------------------------------------------------------------
// FR-122: explicit operator toggles (igris configure)
// --------------------------------------------------------------------

/**
 * Outcome of an explicit config write (the FR-122 toggle/set writers). Distinct
 * from {@link CognitionDefaultOutcome} — there is no "preserved"/"default_set"
 * here because the operator is deliberately writing a chosen value.
 */
export type SetConfigOutcome =
  | "config_missing"   // config.json doesn't exist — no-op
  | "config_malformed" // config.json was unreadable — no-op (graceful)
  | "written";          // the value was written

/**
 * Explicitly set `cognition.<instance>.enabled` to a chosen boolean (FR-122).
 *
 * Unlike {@link applyCognitionDefault} (set-if-absent-to-false), this is the
 * operator's deliberate flip — it ALWAYS writes the chosen value. Writes the
 * NESTED key only (never a top-level `perception`/`subconscious` block — FR-191
 * door contract) and preserves sibling keys at both the cognition and the
 * instance level (e.g. subconscious.llm_timeout_ms). Atomic + chmod 600.
 */
export function setCognitionEnabled(
  instance: "perception" | "subconscious",
  value: boolean,
): SetConfigOutcome {
  const cfg = readConfig();
  if (cfg === null) {
    return existsSync(configJsonPath()) ? "config_malformed" : "config_missing";
  }

  const cognition = (cfg.cognition ?? null) as Record<string, unknown> | null;
  const section =
    cognition !== null
      ? ((cognition[instance] ?? null) as Record<string, unknown> | null)
      : null;

  const next: Record<string, unknown> = {
    ...cfg,
    cognition: {
      ...(cognition ?? {}),
      [instance]: {
        ...(section ?? {}),
        enabled: value,
      },
    },
  };

  writeConfigAtomic(next);
  return "written";
}

/** Outcome of {@link setRemoteBrain} — adds the TD-252 cleartext refusal. */
export type SetRemoteBrainOutcome =
  | "config_missing"
  | "config_malformed"
  | "written"          // remote_brain set to {url, api_key}
  | "cleared"          // remote_brain key deleted (VPS disabled by blank address)
  | "refused-insecure"; // non-local http:// without override — left unchanged

/**
 * Set or clear `remote_brain` by address presence (FR-122 VPS-by-address).
 *
 * - `value` non-null → write `remote_brain = {url, api_key}` (api_key may be
 *   null when the operator left it blank). Reuses the TD-252
 *   `classifySyncTransport` guard FIRST — a non-local `http://` URL is REFUSED
 *   before it is persisted (parity with prompts.ts), so the api_key can never
 *   be configured to later travel in cleartext.
 * - `value` null → DELETE the `remote_brain` key (VPS disabled by blank
 *   address). Preserves every other config key.
 *
 * Atomic + chmod 600 (TD-220 — api_key is a secret). Never throws.
 */
export function setRemoteBrain(
  value: { url: string; apiKey: string | null } | null,
): SetRemoteBrainOutcome {
  const cfg = readConfig();
  if (cfg === null) {
    return existsSync(configJsonPath()) ? "config_malformed" : "config_missing";
  }

  if (value === null) {
    // VPS-disable by blank address: delete the key, preserve everything else.
    const next = { ...cfg };
    delete next.remote_brain;
    writeConfigAtomic(next);
    return "cleared";
  }

  // TD-252: refuse a non-local http:// URL before persisting the api_key.
  if (
    classifySyncTransport(value.url) === "insecure-http" &&
    !isInsecureSyncAllowed()
  ) {
    warn(
      `refusing to save remote brain URL '${value.url}' — http:// to a ` +
        `non-local host sends your api_key in cleartext. Use an https:// ` +
        `URL, or set IGRIS_ALLOW_INSECURE_SYNC=1 to override (NOT ` +
        `recommended). Remote brain left unchanged.`,
    );
    return "refused-insecure";
  }

  // Preserve a pre-existing remote_brain.allow_insecure flag (the optional
  // persistent override the operator may have set) by spreading the old block.
  const prior = (cfg.remote_brain ?? null) as Record<string, unknown> | null;
  const next: Record<string, unknown> = {
    ...cfg,
    remote_brain: {
      ...(prior ?? {}),
      url: value.url,
      api_key: value.apiKey,
    },
  };
  writeConfigAtomic(next);
  return "written";
}
