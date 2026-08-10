/**
 * register-brain-harnesses.ts tests — FR-169.
 *
 * `registerBrainAcrossHarnesses` projects the bundled igris-brain MCP into all
 * all Igris harness configs (FR-179 added antigravity, FR-192 cursor) by reusing the FR-164 pure
 * shaper + the FR-162/163 mergers.
 * These tests exercise the function directly against real `node:fs` tmp files
 * (no SUT mocking — L-159), using the `configPaths` seam for hermetic per-
 * harness files. The hard constraint (the projected path is
 * `bundledMcpEntryPath()`-resolved and carries NO checkout literal) is asserted
 * in scenario #2.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import {
  registerBrainAcrossHarnesses as registerBrainAcrossHarnessesRaw,
  registerMcpInClaudeJson,
  type BrainHarnessResult,
  type McpHarness,
} from "../lib/mcp-register.js";
import { bundledMcpEntryPath } from "../lib/paths.js";

// FR-212d Phase 2: these are the per-harness MERGER-SHAPE oracle tests — they
// validate `buildHarnessMcpEntry`'s native shapes + the no-clobber/idempotent
// mergers. That shaper+merger is KEPT (antigravity's ENTRY uses it under the
// delegate engine), so the tests still pin its byte-shape by forcing the CUSTOM
// engine here. The DELEGATE-default routing (every harness EXCEPT antigravity →
// add-mcp, antigravity → custom) is covered by the FR-212b delegate tests + the
// fr212-smoke gate.
function registerBrainAcrossHarnesses(
  opts?: Parameters<typeof registerBrainAcrossHarnessesRaw>[0],
): BrainHarnessResult[] {
  return registerBrainAcrossHarnessesRaw(opts, { engine: "custom" });
}

let workDir: string;
/** A fixed override MCP entry path used by most tests. */
const MCP_PATH = "/fake/bundled/brain-mcp-server/dist/index.js";

/** Per-harness sandboxed config-file paths inside the tmp dir. */
function sandboxConfigPaths(): Record<McpHarness, string> {
  return {
    claude: join(workDir, ".claude.json"),
    gemini: join(workDir, "gemini", "settings.json"),
    codex: join(workDir, "codex", "config.toml"),
    opencode: join(workDir, "opencode", "opencode.json"),
    // FR-179: antigravity rides gemini's `mcpServers` shape but a DISTINCT
    // file. WITHOUT this override the harness falls through to the REAL
    // ~/.gemini/config/mcp_config.json on the dev box (the isolation leak that
    // made scenarios 4/5/7 report unchanged/updated instead of registered).
    antigravity: join(workDir, "gemini", "config", "mcp_config.json"),
    // FR-192: cursor rides claude's `mcpServers` shape into ~/.cursor/mcp.json.
    // WITHOUT this override the harness falls through to the REAL ~/.cursor/mcp.json
    // (which already carries igris-brain) → the SAME isolation leak (updated, not
    // registered) the antigravity note above describes.
    cursor: join(workDir, "cursor", "mcp.json"),
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "igris-brain-harness-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function getMap(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const m = obj[key];
  expect(typeof m).toBe("object");
  return m as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scenario 1 — all-5 wired with correct per-harness shapes
// ---------------------------------------------------------------------------
describe("registerBrainAcrossHarnesses — all 6 wired (scenario 1)", () => {
  it("writes the correct per-harness shape into each of the 6 configs", () => {
    const configPaths = sandboxConfigPaths();
    const results = registerBrainAcrossHarnesses({
      mcpEntryPath: MCP_PATH,
      configPaths,
    });

    expect(results.map((r) => r.harness).sort()).toEqual(
      ["antigravity", "claude", "codex", "cursor", "gemini", "opencode"].sort(),
    );
    for (const r of results) {
      expect(r.result.outcome).toBe("registered");
    }

    // Claude — mcpServers map, carries `type:"stdio"`.
    const claude = getMap(readJson(configPaths.claude), "mcpServers");
    expect(claude["igris-brain"]).toEqual({
      type: "stdio",
      command: "node",
      args: [MCP_PATH],
      env: {},
    });

    // Gemini — mcpServers map, NO `type`.
    const gemini = getMap(readJson(configPaths.gemini), "mcpServers");
    expect(gemini["igris-brain"]).toEqual({
      command: "node",
      args: [MCP_PATH],
      env: {},
    });

    // FR-179: Antigravity — mcpServers map, gemini-IDENTICAL shape (NO `type`),
    // but a DISTINCT config file (~/.gemini/config/mcp_config.json).
    const antigravity = getMap(
      readJson(configPaths.antigravity),
      "mcpServers",
    );
    expect(antigravity["igris-brain"]).toEqual({
      command: "node",
      args: [MCP_PATH],
      env: {},
    });
    // The bytes match gemini's entry exactly — only the path differs.
    expect(antigravity["igris-brain"]).toEqual(gemini["igris-brain"]);

    // OpenCode — `mcp` map, type:"local", FUSED command array, `environment`.
    const opencode = getMap(readJson(configPaths.opencode), "mcp");
    expect(opencode["igris-brain"]).toEqual({
      type: "local",
      command: ["node", MCP_PATH],
      enabled: true,
      environment: {},
    });

    // Codex — TOML `[mcp_servers.igris-brain]` table.
    const codex = TOML.parse(readFileSync(configPaths.codex, "utf-8"));
    const codexMap = codex.mcp_servers as Record<string, unknown>;
    expect(codexMap["igris-brain"]).toEqual({
      command: "node",
      args: [MCP_PATH],
    });

    // FR-192: Cursor — mcpServers map, claude-IDENTICAL shape (carries
    // `type:"stdio"`), but a DISTINCT config file (~/.cursor/mcp.json).
    const cursor = getMap(readJson(configPaths.cursor), "mcpServers");
    expect(cursor["igris-brain"]).toEqual({
      type: "stdio",
      command: "node",
      args: [MCP_PATH],
      env: {},
    });
    // The bytes match claude's entry exactly — only the path differs.
    expect(cursor["igris-brain"]).toEqual(claude["igris-brain"]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — path is install-relative, NOT a checkout literal (HARD AC)
// ---------------------------------------------------------------------------
describe("registerBrainAcrossHarnesses — path is bundledMcpEntryPath() (scenario 2)", () => {
  it("uses bundledMcpEntryPath() (resolved per-machine, not a hardcoded literal)", () => {
    const configPaths = sandboxConfigPaths();
    registerBrainAcrossHarnesses({ configPaths });

    const expected = bundledMcpEntryPath();
    // The path is RESOLVED from bundledMcpEntryPath() — it ends with the
    // standard bundle suffix and is NOT a hardcoded checkout literal. On a real
    // npm-global box this resolves under node_modules/igris-ai (NO checkout
    // path); on the dev box it legitimately resolves under the package root
    // (which IS the checkout) — so the load-bearing assertion is path-EQUALITY
    // with bundledMcpEntryPath(), NOT a substring scan that is environment-
    // fragile. We also prove it is NOT our test override constant (MCP_PATH).
    expect(
      expected.endsWith(join("dist", "brain-mcp-server", "dist", "index.js")),
    ).toBe(true);
    expect(expected).not.toBe(MCP_PATH);
    // Negative literal guard: the projected path is the BUNDLED layout
    // (`dist/brain-mcp-server/dist/index.js`), NOT the pre-bundle source-tree
    // layout (`brain-mcp-server/dist/index.js` WITHOUT the leading `dist/`) —
    // the FR-166 dev-path trap. The leading `dist/<bundle>` segment proves it.
    expect(expected).toContain(join("dist", "brain-mcp-server", "dist", "index.js"));

    // Claude / Gemini args[0].
    const claudeArgs = (
      getMap(readJson(configPaths.claude), "mcpServers")["igris-brain"] as {
        args: string[];
      }
    ).args;
    expect(claudeArgs[0]).toBe(expected);

    const geminiArgs = (
      getMap(readJson(configPaths.gemini), "mcpServers")["igris-brain"] as {
        args: string[];
      }
    ).args;
    expect(geminiArgs[0]).toBe(expected);

    // OpenCode fused command[1].
    const ocCmd = (
      getMap(readJson(configPaths.opencode), "mcp")["igris-brain"] as {
        command: string[];
      }
    ).command;
    expect(ocCmd[1]).toBe(expected);

    // Codex command + args.
    const codex = TOML.parse(readFileSync(configPaths.codex, "utf-8"));
    const codexEntry = (codex.mcp_servers as Record<string, unknown>)[
      "igris-brain"
    ] as { command: string; args: string[] };
    expect(codexEntry.command).toBe("node");
    expect(codexEntry.args[0]).toBe(expected);

    // The per-harness result also reports the resolved path.
    const results = registerBrainAcrossHarnesses({ configPaths });
    for (const r of results) {
      expect(r.result.mcpEntryPath).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — idempotent + mtime-stable on re-run
// ---------------------------------------------------------------------------
describe("registerBrainAcrossHarnesses — idempotent (scenario 3)", () => {
  it("second run is `unchanged` for every harness with no mtime churn", async () => {
    const configPaths = sandboxConfigPaths();
    registerBrainAcrossHarnesses({ mcpEntryPath: MCP_PATH, configPaths });

    const mtimesBefore = (Object.values(configPaths) as string[]).map(
      (p) => statSync(p).mtimeMs,
    );

    // Small delay so any rewrite would change mtime observably.
    await new Promise((r) => setTimeout(r, 20));

    const results = registerBrainAcrossHarnesses({
      mcpEntryPath: MCP_PATH,
      configPaths,
    });
    for (const r of results) {
      expect(r.result.outcome).toBe("unchanged");
    }

    const mtimesAfter = (Object.values(configPaths) as string[]).map(
      (p) => statSync(p).mtimeMs,
    );
    expect(mtimesAfter).toEqual(mtimesBefore);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — no-clobber of seeded sibling MCP + non-MCP top-level keys
// ---------------------------------------------------------------------------
describe("registerBrainAcrossHarnesses — no-clobber (scenario 4)", () => {
  it("preserves pre-existing sibling MCPs and non-MCP keys", () => {
    const configPaths = sandboxConfigPaths();

    // Create the parent dirs first so we can seed configs BEFORE the function
    // runs (the function would benign-create them, but our seed writes precede
    // that). Each is seeded with a sibling MCP + a non-MCP top-level key.
    mkdirSync(join(workDir, "gemini"), { recursive: true });
    mkdirSync(join(workDir, "opencode"), { recursive: true });
    mkdirSync(join(workDir, "codex"), { recursive: true });

    const sibling = { type: "stdio", command: "other", args: [], env: {} };
    writeFileSync(
      configPaths.claude,
      JSON.stringify(
        { numStartups: 7, mcpServers: { "other-server": sibling } },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      configPaths.gemini,
      JSON.stringify({ theme: "dark", mcpServers: { "other-server": sibling } }, null, 2) + "\n",
    );
    writeFileSync(
      configPaths.opencode,
      JSON.stringify({ logLevel: "info", mcp: { "other-server": sibling } }, null, 2) + "\n",
    );
    writeFileSync(
      configPaths.codex,
      '[other]\nfoo = "bar"\n\n[mcp_servers.other-server]\ncommand = "other"\nargs = []\n',
    );

    const results = registerBrainAcrossHarnesses({
      mcpEntryPath: MCP_PATH,
      configPaths,
    });
    for (const r of results) {
      expect(r.result.outcome).toBe("registered");
    }

    // Claude — sibling + non-MCP key preserved, igris-brain added.
    const claude = readJson(configPaths.claude);
    expect(claude.numStartups).toBe(7);
    const claudeServers = getMap(claude, "mcpServers");
    expect(claudeServers["other-server"]).toEqual(sibling);
    expect(claudeServers["igris-brain"]).toBeDefined();

    // Gemini.
    const gemini = readJson(configPaths.gemini);
    expect(gemini.theme).toBe("dark");
    expect(getMap(gemini, "mcpServers")["other-server"]).toEqual(sibling);
    expect(getMap(gemini, "mcpServers")["igris-brain"]).toBeDefined();

    // OpenCode.
    const opencode = readJson(configPaths.opencode);
    expect(opencode.logLevel).toBe("info");
    expect(getMap(opencode, "mcp")["other-server"]).toEqual(sibling);
    expect(getMap(opencode, "mcp")["igris-brain"]).toBeDefined();

    // Codex — `[other]` table + sibling MCP preserved, igris-brain added.
    const codexText = readFileSync(configPaths.codex, "utf-8");
    expect(codexText).toContain("[other]");
    expect(codexText).toContain('foo = "bar"');
    const codex = TOML.parse(codexText);
    const codexMap = codex.mcp_servers as Record<string, unknown>;
    expect(codexMap["other-server"]).toBeDefined();
    expect(codexMap["igris-brain"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — graceful when a harness config DIR is absent (benign-create)
// ---------------------------------------------------------------------------
describe("registerBrainAcrossHarnesses — absent config dir (scenario 5)", () => {
  it("benign-creates the parent dir and wires all harnesses (no throw)", () => {
    // configPaths point at parent dirs that do NOT yet exist
    // (workDir/gemini, workDir/codex, workDir/opencode are absent).
    const configPaths = sandboxConfigPaths();
    expect(existsSync(join(workDir, "opencode"))).toBe(false);

    const results = registerBrainAcrossHarnesses({
      mcpEntryPath: MCP_PATH,
      configPaths,
    });

    for (const r of results) {
      expect(r.result.outcome).toBe("registered");
    }
    // All 4 files now exist (parent dirs created on demand).
    for (const p of Object.values(configPaths)) {
      expect(existsSync(p)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — never-fails: one malformed harness, others succeed
// ---------------------------------------------------------------------------
describe("registerBrainAcrossHarnesses — one malformed, others succeed (scenario 6)", () => {
  it("returns failed for the malformed harness and registered for the rest", () => {
    const configPaths = sandboxConfigPaths();

    // Malformed Claude JSON — must NOT be clobbered, NOT leave a .tmp litter.
    writeFileSync(configPaths.claude, "{ this is not valid json ");

    const results = registerBrainAcrossHarnesses({
      mcpEntryPath: MCP_PATH,
      configPaths,
    });

    const byHarness = Object.fromEntries(
      results.map((r) => [r.harness, r.result]),
    );
    expect(byHarness.claude.outcome).toBe("failed");
    expect(byHarness.claude.error).toBeTruthy();
    expect(byHarness.gemini.outcome).toBe("registered");
    expect(byHarness.codex.outcome).toBe("registered");
    expect(byHarness.opencode.outcome).toBe("registered");

    // The malformed file is untouched (byte-for-byte) and no .tmp sibling lands.
    expect(readFileSync(configPaths.claude, "utf-8")).toBe(
      "{ this is not valid json ",
    );
    const litter = readdirSync(workDir).filter((n) => n.includes(".tmp."));
    expect(litter).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — "no repo" end-user layout: zero repo dependency
// ---------------------------------------------------------------------------
describe("registerBrainAcrossHarnesses — no-repo layout (scenario 7)", () => {
  it("resolves the bundled path with NO --from-source / repo present", () => {
    // No mcpEntryPath override and no repo on disk at the bundled path: the
    // value still comes from bundledMcpEntryPath() (the cli package's own dist
    // path), proving zero dependency on a developer checkout.
    const configPaths = sandboxConfigPaths();
    const results = registerBrainAcrossHarnesses({ configPaths });
    const expected = bundledMcpEntryPath();
    for (const r of results) {
      expect(r.result.outcome).toBe("registered");
      // Resolved from bundledMcpEntryPath() (the cli package's own dist path),
      // NOT a developer checkout literal nor a test override.
      expect(r.result.mcpEntryPath).toBe(expected);
      expect(r.result.mcpEntryPath).not.toBe(MCP_PATH);
      expect(r.result.mcpEntryPath).toContain(
        join("dist", "brain-mcp-server", "dist", "index.js"),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — back-compat shim (registerMcpInClaudeJson unchanged)
// ---------------------------------------------------------------------------
describe("registerMcpInClaudeJson — back-compat shim (scenario 8)", () => {
  it("returns a single McpRegisterResult with claudeJsonPath + mcpEntryPath", () => {
    const claudeJson = join(workDir, ".claude.json");
    const res = registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    expect(res.outcome).toBe("registered");
    expect(res.claudeJsonPath).toBe(claudeJson);
    expect(res.mcpEntryPath).toBe(MCP_PATH);

    const data = readJson(claudeJson);
    expect(getMap(data, "mcpServers")["igris-brain"]).toEqual({
      type: "stdio",
      command: "node",
      args: [MCP_PATH],
      env: {},
    });

    // Defaults: mcpEntryPath falls back to bundledMcpEntryPath().
    const claudeJson2 = join(workDir, ".claude2.json");
    const res2 = registerMcpInClaudeJson({ claudeJsonPath: claudeJson2 });
    expect(res2.mcpEntryPath).toBe(bundledMcpEntryPath());
  });
});
