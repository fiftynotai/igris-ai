/**
 * FR-164 (FR-160 epic): the PURE canonical→per-harness MCP entry shaper.
 *
 * This is the ONE place the TypeScript native per-harness MCP entry shape is
 * defined. It is consumed by `loadout.ts:runProjectMcp` (the compile-time
 * projector) AND pinned by the golden-fixture parity test
 * (`mcp-shape.test.ts`). The bash side (`_common.sh normalize_mcp_shape`)
 * mirrors these exact 4 shapes byte-for-byte; a bats parity test asserts the
 * two cannot silently diverge (L-554 hash-stable-parity).
 *
 * It is PURE: it builds an object and returns it. It does NOT write any config
 * file and does NOT call `mergeJsonConfig` / `mergeTomlConfig` — that dispatch
 * is `runProjectMcp`'s job. It calls `normalizeEnvForHarness` once per canonical
 * `env` entry to translate the value per harness.
 *
 * SECURITY: never logs a value (resolved or otherwise). For a missing Codex
 * secret it returns `{ missing }` (NEVER a partial/empty literal) and the
 * caller must FAIL before any write — naming only the VAR, never a value.
 */

import { normalizeEnvForHarness, type McpHarness } from "./mcp-env-normalize.js";
import type { SecretsMap } from "./secrets.js";
import type { TomlMcpEntry } from "./mcp-register.js";

export type { McpHarness } from "./mcp-env-normalize.js";

/**
 * The canonical MCP launch spec (the loadout `surfaces.mcp_servers[].canonical`
 * shape). Declared here so the shaper has no import dependency on the verb
 * module. Byte-compatible with `McpCanonical` in loadout.ts (env values are
 * `${VAR}` indirection refs; `args`/`env` default to []/{} when absent).
 */
export interface McpShapeCanonical {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  startup_timeout_sec?: number;
}

/**
 * Result of `buildHarnessMcpEntry`. `entry` is the native per-harness object
 * (a JSON object for claude/gemini/opencode, a `TomlMcpEntry` for codex). When
 * `missing` is set (codex only — a `${VAR}` whose secret is absent), the caller
 * MUST fail BEFORE writing: `entry` is a PARTIAL with the missing key OMITTED,
 * never carrying an empty/placeholder literal that could leak a value shape.
 */
export interface HarnessMcpEntryResult {
  entry: Record<string, unknown> | TomlMcpEntry;
  /** Codex-only: the first env VAR whose secret was absent from `secrets`. */
  missing?: string;
}

/**
 * Build the native per-harness MCP entry from the canonical launch spec.
 *
 * Per-harness shapes (finding #8 — pinned byte-for-byte against the bash
 * `normalize_mcp_shape` + the golden fixture):
 *   - claude   → { type:"stdio", command, args, env }            (carries `type`)
 *   - gemini   → { command, args, env }                          (NO `type`)
 *   - antigravity → { command, args, env }                       (NO `type`;
 *                  gemini-identical bytes — only the config PATH differs)
 *   - opencode → { type:"local", command:[cmd, ...args],
 *                  enabled, environment }                        (cmd+args FUSED;
 *                  env KEY is `environment`; values are `{env:VAR}`)
 *   - codex    → TomlMcpEntry { command, args, env(resolved-literal),
 *                  startup_timeout_sec? }                        (codex resolves
 *                  nothing → env values are RESOLVED LITERALS)
 *
 * Env VALUE translation is delegated to `normalizeEnvForHarness` (FR-165):
 * claude/gemini emit `${VAR}` verbatim, opencode emits `{env:VAR}`, codex emits
 * the resolved literal from `secrets` (or `{ missing }` when absent).
 *
 * `secrets` is required ONLY for codex (the other three pass refs through). The
 * key-iteration order of `env` is preserved verbatim from the canonical input.
 *
 * @param canonical  The loadout canonical launch spec.
 * @param harness    Which harness shape to build.
 * @param enabled    Per-target `enabled` flag (opencode only; defaults true).
 * @param secrets    Codex secret map (from `parseSecretsEnv`). Unused for the
 *                   other three harnesses.
 */
export function buildHarnessMcpEntry(
  canonical: McpShapeCanonical,
  harness: McpHarness,
  enabled: boolean | undefined,
  secrets?: SecretsMap,
): HarnessMcpEntryResult {
  const command = canonical.command;
  const args = canonical.args ?? [];
  const canonicalEnv = canonical.env ?? {};

  // Translate each env value per harness. On the FIRST codex miss, record it and
  // OMIT that key (never a partial literal). claude/gemini/opencode never miss.
  const normalizedEnv: Record<string, string> = {};
  let missing: string | undefined;
  for (const key of Object.keys(canonicalEnv)) {
    const { value, missing: m } = normalizeEnvForHarness(
      canonicalEnv[key],
      harness,
      secrets,
    );
    if (m !== undefined) {
      // Record the first missing VAR and keep scanning is unnecessary — the
      // caller fails on `missing` regardless. Stop at the first to keep the
      // error message focused (and never emit a partial value for this key).
      if (missing === undefined) {
        missing = m;
      }
      continue;
    }
    // `value` is non-null for claude/gemini/opencode and for a resolved codex
    // ref. The `m === undefined` branch guarantees non-null.
    normalizedEnv[key] = value as string;
  }

  switch (harness) {
    case "claude": {
      const entry: Record<string, unknown> = {
        type: "stdio",
        command,
        args,
        env: normalizedEnv,
      };
      return { entry };
    }
    case "gemini": {
      const entry: Record<string, unknown> = {
        command,
        args,
        env: normalizedEnv,
      };
      return { entry };
    }
    case "antigravity": {
      // FR-179: gemini-identical shape (NO `type` key — gemini lineage). The
      // entry is byte-for-byte the same as the gemini branch; only the config
      // PATH differs (~/.gemini/config/mcp_config.json — antigravityMcpConfigPath).
      // Pinned against bash `normalize_mcp_shape` + the golden fixture (§18.1).
      const entry: Record<string, unknown> = {
        command,
        args,
        env: normalizedEnv,
      };
      return { entry };
    }
    case "opencode": {
      const entry: Record<string, unknown> = {
        type: "local",
        // command + args FUSED into one array (opencode's local-server shape).
        command: [command, ...args],
        enabled: enabled ?? true,
        // opencode MCP local-server env KEY is `environment` (NOT `env`),
        // confirmed against the live `~/.config/opencode/opencode.json` shape +
        // the opencode MCP schema. Pinned in bash + the golden fixture.
        environment: normalizedEnv,
      };
      return { entry };
    }
    case "codex": {
      // codex resolves nothing — env values are RESOLVED LITERALS. A missing
      // VAR yields `missing` (caller fails before write). The TomlMcpEntry
      // carries `startup_timeout_sec` only when present in the canonical.
      const entry: TomlMcpEntry = {
        command,
        args,
        env: normalizedEnv,
      };
      if (canonical.startup_timeout_sec !== undefined) {
        entry.startup_timeout_sec = canonical.startup_timeout_sec;
      }
      return missing !== undefined ? { entry, missing } : { entry };
    }
  }
}
