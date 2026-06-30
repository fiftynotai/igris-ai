/**
 * FR-217: tests for the canonical harness descriptor reader
 * (cli/src/lib/harness-descriptor.ts).
 *
 * Three jobs:
 *   1. Exercise every accessor against the REAL descriptor (the repo-root
 *      harness-manifest.json the reader resolves by default), plus resolution,
 *      cache behavior, and the claude→claude-code / gemini→gemini-cli agent-id
 *      split.
 *   2. DESCRIPTOR VALUE SNAPSHOTS: pin the concrete values the now-deleted
 *      hardcoded consts used to hold. M1 originally asserted accessor==const to
 *      prove the descriptor reproduced the scatter before migration; FR-217 M5
 *      deleted those consts (IGRIS_SKILLS_HARNESSES, IGRIS_MCP_HARNESSES,
 *      HARNESS_CONFIG, ADD_MCP_AGENT_ID, ALL_HARNESSES, GRANT_GRAMMAR,
 *      VALID_TARGET_TYPES, VALID_MCP_TARGET_TYPES, VALID_HOOK_TARGET_TYPES +
 *      loadout's mcpMapKeyFor/mcpConfigPathFor/LOADOUT_ADD_MCP_AGENT_ID), so the
 *      equality assertions were re-expressed as direct value pins — coverage
 *      preserved without importing deleted symbols.
 *   3. The §4 schema↔descriptor cross-check.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetHarnessDescriptorCacheForTests,
  agentId,
  agentTargetRowHarnesses,
  agentTargetTypes,
  grantGrammar,
  type HarnessId,
  harnessIds,
  harnessSpecificFile,
  hookFacts,
  hookProjectedHarnesses,
  loadHarnessDescriptor,
  mcpAgentIds,
  mcpFacts,
  mcpProjectedHarnesses,
  mcpTargetTypes,
  hookTargetTypes,
  skillAgentIds,
} from "../lib/harness-descriptor.js";

// --- live path helpers used to pin the expected descriptor values ----------
import {
  antigravityHooksConfigPath,
  claudeJsonPath,
  claudeUserSettingsPath,
} from "../lib/paths.js";

/** All 5 shape ids — a fixed list so per-id iteration does not depend on the SUT. */
const ALL_IDS: HarnessId[] = [
  "claude",
  "gemini",
  "codex",
  "opencode",
  "antigravity",
];

/** Repo-root canonical manifest (3 levels up from cli/src/lib === cli/src/__tests__). */
const repoRootManifest = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "harness-manifest.json",
);

beforeEach(() => {
  __resetHarnessDescriptorCacheForTests();
});

describe("resolution + cache", () => {
  it("resolves the repo-root manifest by default (dev, no build)", () => {
    const d = loadHarnessDescriptor();
    expect(d.sourcePath.endsWith("harness-manifest.json")).toBe(true);
    expect(existsSync(d.sourcePath)).toBe(true);
    expect(d.order.length).toBe(5);
  });

  it("caches the parse (same object reference) until reset", () => {
    const a = loadHarnessDescriptor();
    const b = loadHarnessDescriptor();
    expect(a).toBe(b);
    __resetHarnessDescriptorCacheForTests();
    const c = loadHarnessDescriptor();
    expect(c).not.toBe(a);
    expect(c.order).toEqual(a.order); // same content, fresh object
  });

  it("honors an explicit manifestPath", () => {
    const d = loadHarnessDescriptor({ manifestPath: repoRootManifest });
    expect(d.sourcePath).toBe(repoRootManifest);
    expect(d.byId.size).toBe(5);
  });

  it("throws on a missing explicit manifestPath", () => {
    expect(() =>
      loadHarnessDescriptor({ manifestPath: "/nonexistent/harness-manifest.json" }),
    ).toThrow(/manifest not found/);
  });
});

describe("accessors against the real descriptor", () => {
  it("harnessIds() returns the 5 shape ids in declaration order", () => {
    expect(harnessIds()).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "antigravity",
    ]);
  });

  it("agentId() encodes the claude→claude-code / gemini→gemini-cli split", () => {
    expect(agentId("claude")).toBe("claude-code");
    expect(agentId("gemini")).toBe("gemini-cli");
    expect(agentId("codex")).toBe("codex");
    expect(agentId("opencode")).toBe("opencode");
    expect(agentId("antigravity")).toBe("antigravity");
  });

  it("mcpFacts() returns the per-harness config facts (expanded path)", () => {
    expect(mcpFacts("claude")).toEqual({
      configPath: claudeJsonPath(),
      format: "json",
      mapKey: "mcpServers",
      entryShape: "claude",
      projected: true,
    });
    expect(mcpFacts("codex").format).toBe("toml");
    expect(mcpFacts("codex").mapKey).toBe("mcp_servers");
    expect(mcpFacts("opencode").mapKey).toBe("mcp");
    // antigravity rides the gemini ENTRY shape but a DISTINCT config path (FR-179 R1).
    expect(mcpFacts("antigravity").entryShape).toBe("gemini");
    expect(mcpFacts("antigravity").configPath).toContain(
      ".gemini/config/mcp_config.json",
    );
    expect(mcpFacts("gemini").configPath).not.toBe(
      mcpFacts("antigravity").configPath,
    );
  });

  it("grantGrammar() returns the per-harness grant grammar", () => {
    expect(grantGrammar("claude")).toEqual({
      kind: "json-array",
      path: claudeUserSettingsPath(),
      token: "mcp__igris-brain__*",
    });
    expect(grantGrammar("antigravity").token).toBe("mcp(igris-brain/*)");
    expect(grantGrammar("codex").kind).toBe("toml-folder");
    expect(grantGrammar("gemini").kind).toBe("json-folder");
    // opencode grant rides agent frontmatter — `covered`, no file, no token.
    expect(grantGrammar("opencode")).toEqual({ kind: "covered" });
  });

  it("hookFacts() reflects per-harness hook participation", () => {
    expect(hookFacts("claude")).toEqual({
      supported: true,
      configPath: claudeUserSettingsPath(),
      method: "settings-merge",
      projected: true,
    });
    expect(hookFacts("antigravity")).toEqual({
      supported: true,
      configPath: antigravityHooksConfigPath(),
      method: "config-merge",
      projected: true,
    });
    expect(hookFacts("opencode")).toEqual({
      supported: true,
      method: "plugin",
      projected: true,
    });
    expect(hookFacts("codex")).toEqual({ supported: false });
    expect(hookFacts("gemini")).toEqual({ supported: false });
  });

  it("harnessSpecificFile() is present only for the dynamic-define harnesses", () => {
    expect(harnessSpecificFile("gemini")).toBe(
      "core/os/harness-specific/gemini.md",
    );
    expect(harnessSpecificFile("antigravity")).toBe(
      "core/os/harness-specific/antigravity.md",
    );
    expect(harnessSpecificFile("claude")).toBeUndefined();
    expect(harnessSpecificFile("codex")).toBeUndefined();
    expect(harnessSpecificFile("opencode")).toBeUndefined();
  });

  it("derives the per-surface participation enums from block presence", () => {
    // OPEN DECISION #1: antigravity is dynamic-define (no agents block) → excluded.
    expect(agentTargetTypes()).toEqual(["claude", "codex", "gemini", "opencode"]);
    expect(agentTargetTypes()).not.toContain("antigravity");
    expect(mcpTargetTypes()).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "antigravity",
    ]);
    expect(hookTargetTypes()).toEqual(["claude", "opencode", "antigravity"]);
  });

  it("agentTargetRowHarnesses() = the projection:target-row set (parity-guard input)", () => {
    // claude is projection:symlink (exempt); antigravity has no agents block.
    expect(agentTargetRowHarnesses()).toEqual(["codex", "gemini", "opencode"]);
  });

  it("mcpProjectedHarnesses() = the mcp.projected set (parity input; antigravity carve-out excluded)", () => {
    // TD-281: all 5 have an mcp block (mcpTargetTypes), but antigravity is
    // mcp.projected:false (FR-179 carve-out) → the projected set is the other 4.
    expect(mcpProjectedHarnesses()).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
    ]);
    expect(mcpProjectedHarnesses()).not.toContain("antigravity");
    // The flag rides McpFacts: capability (block presence) ≠ projection.
    expect(mcpFacts("claude").projected).toBe(true);
    expect(mcpFacts("antigravity").projected).toBe(false);
    // It is a STRICT subset of the capability set (the carve-out is the gap).
    expect(mcpProjectedHarnesses().length).toBeLessThan(mcpTargetTypes().length);
  });

  it("hookProjectedHarnesses() = the hooks.projected set (parity input)", () => {
    // TD-281: the 3 supported-hook harnesses are all projected (no carve-out
    // today) → projected mirrors supported (hookTargetTypes).
    expect(hookProjectedHarnesses()).toEqual([
      "claude",
      "opencode",
      "antigravity",
    ]);
    expect(hookProjectedHarnesses()).toEqual(hookTargetTypes());
    expect(hookFacts("claude").projected).toBe(true);
    expect(hookFacts("antigravity").projected).toBe(true);
    expect(hookFacts("opencode").projected).toBe(true);
    // codex/gemini are hooks.supported:false → no projected flag.
    expect(hookFacts("codex").projected).toBeUndefined();
    expect(hookFacts("gemini").projected).toBeUndefined();
  });
});

describe("descriptor value snapshots (the concrete values the deleted consts held)", () => {
  // FR-217 M5 deleted the hardcoded consts these assertions used to compare
  // against (IGRIS_SKILLS_HARNESSES, IGRIS_MCP_HARNESSES, ADD_MCP_AGENT_ID,
  // ALL_HARNESSES, HARNESS_CONFIG, GRANT_GRAMMAR, VALID_TARGET_TYPES,
  // VALID_MCP_TARGET_TYPES, VALID_HOOK_TARGET_TYPES + loadout's
  // mcpMapKeyFor/mcpConfigPathFor/LOADOUT_ADD_MCP_AGENT_ID). The equality proof is
  // re-expressed here as direct pins of the exact values those consts held (now
  // sourced from the descriptor) — coverage preserved, no deleted-symbol imports.

  it("skillAgentIds() pins the 5 npx agent ids (gemini-cli/claude-code, not bare)", () => {
    expect(skillAgentIds()).toEqual([
      "claude-code",
      "codex",
      "gemini-cli",
      "opencode",
      "antigravity",
    ]);
  });

  it("mcpAgentIds() pins the 5 npx agent ids (== skillAgentIds())", () => {
    expect(mcpAgentIds()).toEqual([
      "claude-code",
      "codex",
      "gemini-cli",
      "opencode",
      "antigravity",
    ]);
  });

  it("agentId(id) pins the per-harness npx agent id", () => {
    expect(agentId("claude")).toBe("claude-code");
    expect(agentId("gemini")).toBe("gemini-cli");
    expect(agentId("codex")).toBe("codex");
    expect(agentId("opencode")).toBe("opencode");
    expect(agentId("antigravity")).toBe("antigravity");
  });

  it("harnessIds() pins the 5 shape ids", () => {
    expect([...harnessIds()].sort()).toEqual(
      ["antigravity", "claude", "codex", "gemini", "opencode"].sort(),
    );
  });

  it("mcpFacts(id) pins per-harness config facts (path/mapKey/format) for all 5", () => {
    // claude is pinned exactly via the live path helper; the rest assert the
    // known config-FILE suffix (their path helpers were deleted from the import
    // set) + the exact mapKey/format the deleted HARNESS_CONFIG table held.
    expect(mcpFacts("claude")).toEqual({
      configPath: claudeJsonPath(),
      format: "json",
      mapKey: "mcpServers",
      entryShape: "claude",
      projected: true,
    });
    expect(mcpFacts("gemini").mapKey).toBe("mcpServers");
    expect(mcpFacts("gemini").format).toBe("json");
    expect(mcpFacts("gemini").configPath).toContain(".gemini/settings.json");
    expect(mcpFacts("opencode").mapKey).toBe("mcp");
    expect(mcpFacts("opencode").format).toBe("json");
    expect(mcpFacts("opencode").configPath).toContain(
      ".config/opencode/opencode.json",
    );
    expect(mcpFacts("codex").mapKey).toBe("mcp_servers");
    expect(mcpFacts("codex").format).toBe("toml");
    expect(mcpFacts("codex").configPath).toContain(".codex/config.toml");
    expect(mcpFacts("antigravity").mapKey).toBe("mcpServers");
    expect(mcpFacts("antigravity").format).toBe("json");
    expect(mcpFacts("antigravity").configPath).toContain(
      ".gemini/config/mcp_config.json",
    );
  });

  it("entry_shape matches the buildHarnessMcpEntry emitter selection", () => {
    // No standalone const holds entry_shape — the buildHarnessMcpEntry switch IS
    // the emitter (KEPT). claude/gemini/codex/opencode select their own shape;
    // antigravity rides `gemini` (byte-identical entry, mcp-shape.ts).
    const expected: Record<HarnessId, string> = {
      claude: "claude",
      gemini: "gemini",
      codex: "codex",
      opencode: "opencode",
      antigravity: "gemini",
    };
    for (const id of ALL_IDS) {
      expect(mcpFacts(id).entryShape).toBe(expected[id]);
    }
  });

  it("grantGrammar(id) pins the per-harness grant grammar (kind/path/token)", () => {
    expect(grantGrammar("claude")).toEqual({
      kind: "json-array",
      path: claudeUserSettingsPath(),
      token: "mcp__igris-brain__*",
    });
    expect(grantGrammar("antigravity").kind).toBe("json-array");
    expect(grantGrammar("antigravity").token).toBe("mcp(igris-brain/*)");
    expect(grantGrammar("antigravity").path).toContain(
      ".gemini/antigravity-cli/settings.json",
    );
    expect(grantGrammar("codex").kind).toBe("toml-folder");
    expect(grantGrammar("codex").path).toContain(".codex/config.toml");
    expect(grantGrammar("gemini").kind).toBe("json-folder");
    expect(grantGrammar("gemini").path).toContain(".gemini/trustedFolders.json");
    // opencode grant rides agent frontmatter — covered, no file, no token.
    expect(grantGrammar("opencode")).toEqual({ kind: "covered" });
  });

  it("agentTargetTypes() pins the agents-surface set (no antigravity)", () => {
    expect(agentTargetTypes()).toEqual(["claude", "codex", "gemini", "opencode"]);
  });

  it("mcpTargetTypes() pins the mcp-surface set (all 5)", () => {
    expect(mcpTargetTypes()).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "antigravity",
    ]);
  });

  it("hookTargetTypes() pins the hook-surface set", () => {
    expect(hookTargetTypes()).toEqual(["claude", "opencode", "antigravity"]);
  });

  it("mcpProjectedHarnesses() pins the mcp-projected set (TD-281 carve-out)", () => {
    // The byte-identical-clean expected set: the brain MCP block targets exactly
    // these 4; antigravity is the FR-179 carve-out (mcp.projected:false).
    expect(mcpProjectedHarnesses()).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
    ]);
  });

  it("hookProjectedHarnesses() pins the hook-projected set (TD-281)", () => {
    expect(hookProjectedHarnesses()).toEqual([
      "claude",
      "opencode",
      "antigravity",
    ]);
  });
});

// ---------------------------------------------------------------------------
// FR-217 §4: schema <-> descriptor cross-check (the TS twin of the
// `validate_manifest` cross-check). The schema's harness-bearing enums are
// VALIDATED DERIVATIVES of the descriptor; a divergence is a hard fail at both
// the bash gate AND here. Mirrors test/harness_descriptor.test.bash.
// ---------------------------------------------------------------------------
describe("FR-217 §4 — schema harness enums == descriptor-derived sets", () => {
  function schemaEnum(doc: unknown, path: string[]): Set<string> {
    let cur: unknown = doc;
    for (const k of path) {
      expect(typeof cur === "object" && cur !== null).toBe(true);
      cur = (cur as Record<string, unknown>)[k];
    }
    expect(Array.isArray(cur)).toBe(true);
    return new Set(cur as string[]);
  }

  // Resolve the repo schema relative to this test file (cli/src/__tests__).
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(
    here,
    "..",
    "..",
    "..",
    "core",
    "scripts",
    "cli-adapters",
    "manifest.schema.json",
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as unknown;

  it("harnesses propertyNames enum == harnessIds()", () => {
    const e = schemaEnum(schema, [
      "properties",
      "harnesses",
      "propertyNames",
      "enum",
    ]);
    expect(e).toEqual(new Set(harnessIds()));
  });

  it("agent target enum == agentTargetTypes()", () => {
    const e = schemaEnum(schema, [
      "$defs",
      "agent",
      "properties",
      "targets",
      "items",
      "properties",
      "type",
      "enum",
    ]);
    expect(e).toEqual(new Set(agentTargetTypes()));
  });

  it("mcp target enum == mcpTargetTypes()", () => {
    const e = schemaEnum(schema, [
      "$defs",
      "mcp_surface",
      "properties",
      "targets",
      "items",
      "properties",
      "type",
      "enum",
    ]);
    expect(e).toEqual(new Set(mcpTargetTypes()));
  });

  it("hook target enum == hookTargetTypes()", () => {
    const e = schemaEnum(schema, [
      "$defs",
      "hook_surface",
      "properties",
      "targets",
      "items",
      "properties",
      "type",
      "enum",
    ]);
    expect(e).toEqual(new Set(hookTargetTypes()));
  });
});
