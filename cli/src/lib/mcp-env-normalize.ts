/**
 * FR-165 (FR-160 epic): the canonical→per-harness env-VALUE emit rule (the
 * FR-160e locked decision). This is the LOAD-BEARING rule FR-164's projector
 * will call once per canonical `env` entry.
 *
 * It is a PURE function: it builds strings and returns them. It does NOT write
 * any config file and does NOT call `renderMcpTomlTable` / `mergeJsonConfig`.
 * Implementing the write here would overrun the FR-165/FR-164 boundary — the
 * projector that consumes these values is FR-164.
 *
 * SECURITY: never logs a value (resolved or otherwise). For a missing Codex
 * secret it returns `{ value: null, missing }` — NEVER a partial/empty literal.
 */

import { extractVarName, resolveRef, type SecretsMap } from "./secrets.js";

/** The four MCP harnesses (mirrors VALID_MCP_TARGET_TYPES in registry.ts). */
export type McpHarness = "claude" | "gemini" | "opencode" | "codex";

/**
 * Canonical→per-harness env-VALUE emit rule.
 * INPUT: a canonical `${VAR}` ref (or, defensively, an already-literal value).
 * OUTPUT per harness:
 *   claude  → `${VAR}` verbatim   (harness resolves + inherits exported env)
 *   gemini  → `${VAR}` verbatim   (harness resolves + inherits exported env)
 *   opencode→ `{env:VAR}`         (token translation; harness resolves)
 *   codex   → the RESOLVED LITERAL from `secrets` (Codex resolves neither refs
 *             nor inherited env — sandbox `inherit="core"`; secrets MUST be
 *             passed for codex)
 *
 * For codex, when the ref's VAR is missing from `secrets`, returns
 * { value: null, missing: "<VAR>" } — NEVER a partial/empty literal, and NEVER
 * logs the (absent) value. For claude/gemini/opencode `secrets` is unused
 * (refs pass through), so it is optional.
 *
 * A non-reference (already-literal) value passes through verbatim for EVERY
 * harness — opencode does NOT wrap a non-ref, and codex returns it as-is via
 * `resolveRef`'s pass-through.
 *
 * Consumed by FR-164's projector; FR-165 ships the rule only.
 *
 * @returns { value: string | null; missing?: string }
 */
export function normalizeEnvForHarness(
  canonicalValue: string,
  harness: McpHarness,
  secrets?: SecretsMap,
): { value: string | null; missing?: string } {
  switch (harness) {
    case "claude":
    case "gemini": {
      // Emit the canonical ref verbatim — the harness resolves it itself.
      return { value: canonicalValue };
    }
    case "opencode": {
      // Translate `${VAR}` → `{env:VAR}`; a non-ref passes through verbatim.
      const varName = extractVarName(canonicalValue);
      if (varName === null) {
        return { value: canonicalValue };
      }
      return { value: `{env:${varName}}` };
    }
    case "codex": {
      // Codex resolves nothing — emit the compile-time literal. A missing VAR
      // yields { value: null, missing } so the caller can warn (no value to
      // leak). A non-ref literal passes through unchanged.
      const { resolved, missing } = resolveRef(canonicalValue, secrets ?? {});
      if (missing !== undefined) {
        return { value: null, missing };
      }
      return { value: resolved };
    }
  }
}
