/**
 * FR-165 (FR-160 epic): the env-var-indirection secrets LIBRARY.
 *
 * Pure helpers over `~/.igris/secrets.env` — the single source of real MCP
 * secrets. The registry overlay only ever stores `${VAR}` indirection refs;
 * the actual literal is resolved from this file at the Codex compile-time
 * projection (FR-164). claude/gemini/opencode resolve the ref + inherit
 * exported env at launch, so they never need this library.
 *
 * SECURITY: these helpers NEVER log a value (resolved or otherwise) and NEVER
 * throw on malformed/absent input — a hand-edited secrets.env must not brick
 * `igris doctor` / `igris init`.
 *
 * FR-165 ships the LIBRARY + the normalizer rule (mcp-env-normalize.ts) only;
 * the projector that writes resolved literals into `~/.codex/config.toml` is
 * FR-164's job.
 */

import { existsSync, readFileSync } from "node:fs";
import { secretsEnvPath } from "./paths.js";

/** Parsed secrets map: VAR name → literal value. */
export type SecretsMap = Record<string, string>;

/**
 * Canonical env-reference grammar. Byte-identical to `ENV_VAR_REF` at
 * `cli/src/verbs/registry.ts:3381` (the WRITE-guard source of truth — the
 * `add-mcp` verb rejects any env value that is not exactly this form). Kept
 * as a deliberate duplicate (NOT a shared import) so this brief does not
 * touch registry.ts and disturb the FR-162 reject-message suite. If the two
 * ever diverge, this comment is the breadcrumb. See FR-165 plan Risks
 * ("Second env grammar drift").
 */
const ENV_VAR_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * OpenCode token form: `{env:VAR}`. Accepted by `resolveRef` so a caller can
 * hand either the registry `${VAR}` value or a normalized OpenCode value and
 * get the underlying literal back.
 */
const OPENCODE_ENV_REF = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Extract the VAR name from a canonical `${VAR}` ref OR an OpenCode
 * `{env:VAR}` token. Returns `null` for anything that is not a recognized
 * reference (i.e. an already-literal value). Shared by `resolveRef` here and
 * `normalizeEnvForHarness` (mcp-env-normalize.ts) so the two agree on what a
 * "ref" is.
 */
export function extractVarName(value: string): string | null {
  const canonical = ENV_VAR_REF.exec(value);
  if (canonical !== null) {
    return canonical[1];
  }
  const opencode = OPENCODE_ENV_REF.exec(value);
  if (opencode !== null) {
    return opencode[1];
  }
  return null;
}

/**
 * Parse a shell-sourceable secrets.env (`export VAR=value` / `VAR=value`).
 * - Skips blank lines and `#` comments.
 * - Strips an optional leading `export `.
 * - Splits on the FIRST `=`.
 * - Strips ONE matching pair of surrounding single or double quotes from the
 *   value (no shell interpolation — value is taken literally).
 * - Ignores malformed lines rather than throwing (a hand-edited file should
 *   not brick the CLI); returns only the well-formed pairs.
 * Returns {} when the file is absent (NOT an error — secrets are optional).
 *
 * @param path Defaults to secretsEnvPath(). Test seam.
 */
export function parseSecretsEnv(path: string = secretsEnvPath()): SecretsMap {
  if (!existsSync(path)) {
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // Unreadable (perms, race) → behave as absent. NEVER throw, NEVER log.
    return {};
  }

  const map: SecretsMap = {};
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    // Strip an optional leading `export ` (one or more spaces).
    const body = line.replace(/^export\s+/, "");
    const eq = body.indexOf("=");
    if (eq <= 0) {
      // No `=`, or empty key (`=value`) → malformed; skip silently.
      continue;
    }
    const key = body.slice(0, eq).trim();
    if (key.length === 0) {
      continue;
    }
    let value = body.slice(eq + 1);
    value = stripOneQuotePair(value);
    map[key] = value;
  }
  return map;
}

/**
 * Strip ONE matching pair of surrounding single or double quotes. The value
 * is taken literally — no shell interpolation, no escape processing. An
 * unbalanced or unquoted value is returned verbatim.
 */
function stripOneQuotePair(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Resolve a single canonical env reference to its literal value, for the
 * Codex compile-time-literal path ONLY.
 * - Accepts the `${VAR}` canonical form (matches ENV_VAR_REF) AND the
 *   `{env:VAR}` OpenCode token form, so a caller can hand either the
 *   registry value or a normalized OpenCode value and get the literal back.
 * - A NON-reference value (already a literal) is returned verbatim.
 * - When the referenced VAR is absent from `secrets`, returns
 *   { resolved: null, missing: "<VAR>" } so the caller can warn WITHOUT ever
 *   logging a (nonexistent) literal. NEVER throws, NEVER logs.
 */
export function resolveRef(
  value: string,
  secrets: SecretsMap,
): { resolved: string | null; missing?: string } {
  const varName = extractVarName(value);
  if (varName === null) {
    // Not a reference — already a literal. Pass through verbatim.
    return { resolved: value };
  }
  if (Object.prototype.hasOwnProperty.call(secrets, varName)) {
    return { resolved: secrets[varName] };
  }
  return { resolved: null, missing: varName };
}

/** Re-export for one-import ergonomics at FR-164 call sites. */
export { secretsEnvPath } from "./paths.js";
