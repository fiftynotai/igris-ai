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

import type { HarnessId } from "./harness-descriptor.js";
import { extractVarName, resolveRef, type SecretsMap } from "./secrets.js";

/**
 * The MCP harnesses. FR-217: re-homed into `harness-descriptor.ts` as the single
 * `HarnessId` union (the descriptor's `harnesses.<id>` keys). This alias stays
 * for back-compat so existing `McpHarness` importers — including `mcp-shape.ts`,
 * which re-exports it onward — are unchanged. (The MCP-surface participants are
 * derived via `mcpTargetTypes()` from the descriptor.)
 */
export type McpHarness = HarnessId;

/**
 * Canonical→per-harness env-VALUE emit rule.
 * INPUT: a canonical `${VAR}` ref (or, defensively, an already-literal value).
 * OUTPUT per harness:
 *   claude      → `${VAR}` verbatim (harness resolves + inherits exported env)
 *   gemini      → `${VAR}` verbatim (harness resolves + inherits exported env)
 *   antigravity → `${VAR}` verbatim (gemini lineage — resolves its own refs)
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
    case "gemini":
    case "antigravity":
    case "cursor": {
      // Emit the canonical ref verbatim — the harness resolves it itself.
      // antigravity is gemini lineage: it resolves its own ${VAR} refs.
      // FR-192: cursor is claude lineage (mcpServers + type:stdio) — it likewise
      // resolves its own ${VAR} refs, so the ref passes through verbatim.
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
