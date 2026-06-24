/**
 * mcp-register.ts tests — TD-168.
 *
 * Real `node:fs` against `mkdtempSync` tmp dirs — no mocks (L-159: spy at
 * dependency boundaries, but here there is no boundary to spy; the module
 * IS a thin fs wrapper, so we exercise it directly against a sandboxed
 * `~/.claude.json` path). Models `tarball.test.ts`.
 *
 * The malformed-file byte-equality test is the #1 correctness AC for
 * TD-168 — `~/.claude.json` is hot machine state and must never be
 * corrupted.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
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
  mergeJsonConfig,
  mergeTomlConfig,
  registerMcpInClaudeJson,
  inspectMcpRegistration,
  __testing__,
} from "../lib/mcp-register.js";
import { bundledMcpEntryPath } from "../lib/paths.js";

const { MCP_KEY, BACKUP_SUFFIX, locateTomlTableSpan, renderMcpTomlTable } =
  __testing__;

let workDir: string;
/** Sandboxed `~/.claude.json` path inside the tmp dir. */
let claudeJson: string;
/** A fixed MCP entry path used by most tests. */
const MCP_PATH = "/fake/bundled/brain-mcp-server/dist/index.js";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "igris-mcp-register-"));
  claudeJson = join(workDir, ".claude.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("registerMcpInClaudeJson — fresh / missing file", () => {
  it("creates the file with the igris-brain entry when ~/.claude.json is absent", () => {
    expect(existsSync(claudeJson)).toBe(false);
    const res = registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    expect(res.outcome).toBe("registered");
    expect(res.claudeJsonPath).toBe(claudeJson);
    expect(res.mcpEntryPath).toBe(MCP_PATH);
    expect(existsSync(claudeJson)).toBe(true);

    const data = readJson(claudeJson);
    const servers = data.mcpServers as Record<string, unknown>;
    const entry = servers[MCP_KEY] as Record<string, unknown>;
    expect(entry.type).toBe("stdio");
    expect(entry.command).toBe("node");
    expect(entry.args).toEqual([MCP_PATH]);
    expect(entry.env).toEqual({});
  });

  it("creates the entry when the file exists but has no mcpServers key", () => {
    writeFileSync(claudeJson, JSON.stringify({ numStartups: 7 }) + "\n");
    const res = registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    expect(res.outcome).toBe("registered");
    const data = readJson(claudeJson);
    expect(data.numStartups).toBe(7);
    expect((data.mcpServers as Record<string, unknown>)[MCP_KEY]).toBeDefined();
  });
});

describe("registerMcpInClaudeJson — preserves pre-existing state", () => {
  it("preserves OTHER mcpServers entries verbatim", () => {
    const foreign = {
      type: "stdio",
      command: "node",
      args: ["/some/other/server.js"],
      env: { FOO: "bar" },
    };
    writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { "other-mcp": foreign } }) + "\n",
    );
    const res = registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    expect(res.outcome).toBe("registered");
    const data = readJson(claudeJson);
    const servers = data.mcpServers as Record<string, unknown>;
    expect(servers["other-mcp"]).toEqual(foreign);
    expect(servers[MCP_KEY]).toBeDefined();
  });

  it("preserves OTHER top-level keys verbatim", () => {
    const before = {
      numStartups: 42,
      projects: { "/some/proj": { history: ["a", "b"] } },
      tipsHistory: { x: 1 },
    };
    writeFileSync(claudeJson, JSON.stringify(before) + "\n");
    registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    const data = readJson(claudeJson);
    expect(data.numStartups).toBe(42);
    expect(data.projects).toEqual(before.projects);
    expect(data.tipsHistory).toEqual(before.tipsHistory);
  });
});

describe("registerMcpInClaudeJson — update / idempotency", () => {
  it("repoints an existing igris-brain entry → outcome 'updated'", () => {
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          [MCP_KEY]: {
            type: "stdio",
            command: "node",
            args: ["/old/stale/path/index.js"],
            env: {},
          },
        },
      }) + "\n",
    );
    const res = registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    expect(res.outcome).toBe("updated");
    const entry = (readJson(claudeJson).mcpServers as Record<string, unknown>)[
      MCP_KEY
    ] as Record<string, unknown>;
    expect(entry.args).toEqual([MCP_PATH]);
  });

  it("is idempotent: a correct entry → outcome 'unchanged', no mtime churn", () => {
    // First call creates the entry.
    const first = registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    expect(first.outcome).toBe("registered");
    const mtimeBefore = statSync(claudeJson).mtimeMs;
    const bytesBefore = readFileSync(claudeJson);

    // Second call must NOT write — same content already present.
    const second = registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    expect(second.outcome).toBe("unchanged");
    const mtimeAfter = statSync(claudeJson).mtimeMs;
    const bytesAfter = readFileSync(claudeJson);
    expect(mtimeAfter).toBe(mtimeBefore);
    expect(bytesAfter.equals(bytesBefore)).toBe(true);
  });

  it("'unchanged' does NOT write a backup file (no-op leaves nothing behind)", () => {
    registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    // Wipe any backup the first (registered) call could have left — the
    // first call had no pre-existing file, so there should be none, but
    // be explicit.
    expect(existsSync(`${claudeJson}${BACKUP_SUFFIX}`)).toBe(false);
    registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    expect(existsSync(`${claudeJson}${BACKUP_SUFFIX}`)).toBe(false);
  });
});

describe("registerMcpInClaudeJson — malformed file is NEVER corrupted (#1 AC)", () => {
  it("malformed JSON → outcome 'failed', file bytes UNCHANGED, no tmp/bak litter", () => {
    const broken = '{ "mcpServers": { "x": ,,, BROKEN';
    writeFileSync(claudeJson, broken);
    const bytesBefore = readFileSync(claudeJson);

    const res = registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    expect(res.outcome).toBe("failed");
    expect(res.error).toBeDefined();
    expect(res.error).toContain("malformed");

    // Byte-equality pre/post — the corruption-resistance guarantee.
    const bytesAfter = readFileSync(claudeJson);
    expect(bytesAfter.equals(bytesBefore)).toBe(true);

    // No `.igris.bak`, no `.tmp.*` left behind.
    expect(existsSync(`${claudeJson}${BACKUP_SUFFIX}`)).toBe(false);
    const litter = readdirSync(workDir).filter((f) =>
      f.startsWith(".claude.json.tmp."),
    );
    expect(litter).toEqual([]);
  });

  it("non-object JSON (an array) → outcome 'failed', file untouched", () => {
    writeFileSync(claudeJson, JSON.stringify([1, 2, 3]));
    const bytesBefore = readFileSync(claudeJson);
    const res = registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    expect(res.outcome).toBe("failed");
    expect(readFileSync(claudeJson).equals(bytesBefore)).toBe(true);
  });

  it("non-object mcpServers → outcome 'failed', file untouched", () => {
    writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: "not-an-object" }),
    );
    const bytesBefore = readFileSync(claudeJson);
    const res = registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    expect(res.outcome).toBe("failed");
    expect(readFileSync(claudeJson).equals(bytesBefore)).toBe(true);
  });
});

describe("registerMcpInClaudeJson — single rolling backup", () => {
  it("backs up the pre-existing file; backup bytes equal the pre-write content", () => {
    const before = { numStartups: 3, mcpServers: {} };
    writeFileSync(claudeJson, JSON.stringify(before) + "\n");
    const bytesBefore = readFileSync(claudeJson);

    registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: MCP_PATH,
    });
    const bakPath = `${claudeJson}${BACKUP_SUFFIX}`;
    expect(existsSync(bakPath)).toBe(true);
    expect(readFileSync(bakPath).equals(bytesBefore)).toBe(true);
  });

  it("rolling backup: a second update overwrites the first backup (not timestamped)", () => {
    // v1 file.
    writeFileSync(claudeJson, JSON.stringify({ tag: "v1" }) + "\n");
    registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: "/path/one.js",
    });
    const bakPath = `${claudeJson}${BACKUP_SUFFIX}`;
    // Backup now holds the v1 (pre-write) content.
    expect(readJson(bakPath).tag).toBe("v1");

    // Second update repoints to a new path; backup should now hold the
    // post-first-write content (which has igris-brain at /path/one.js).
    registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: "/path/two.js",
    });
    // Exactly one backup file — not two timestamped ones.
    const baks = readdirSync(workDir).filter((f) =>
      f.endsWith(BACKUP_SUFFIX),
    );
    expect(baks.length).toBe(1);
    const bakEntry = (readJson(bakPath).mcpServers as Record<string, unknown>)[
      MCP_KEY
    ] as Record<string, unknown>;
    expect(bakEntry.args).toEqual(["/path/one.js"]);
  });
});

describe("bundledMcpEntryPath", () => {
  it("resolves to a path ending in brain-mcp-server/dist/index.js", () => {
    const p = bundledMcpEntryPath();
    expect(p.endsWith(join("brain-mcp-server", "dist", "index.js"))).toBe(true);
  });
});

describe("inspectMcpRegistration", () => {
  it("not registered when ~/.claude.json is absent", () => {
    const res = inspectMcpRegistration({ claudeJsonPath: claudeJson });
    expect(res).toEqual({
      registered: false,
      pathExists: false,
      entryPath: null,
    });
  });

  it("not registered when the file has no igris-brain entry", () => {
    writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { other: {} } }) + "\n",
    );
    const res = inspectMcpRegistration({ claudeJsonPath: claudeJson });
    expect(res.registered).toBe(false);
  });

  it("registered + pathExists when the entry points at a real file", () => {
    // Point at a file that genuinely exists in the tmp dir.
    const realFile = join(workDir, "fake-index.js");
    writeFileSync(realFile, "// fake mcp\n");
    registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: realFile,
    });
    const res = inspectMcpRegistration({ claudeJsonPath: claudeJson });
    expect(res.registered).toBe(true);
    expect(res.pathExists).toBe(true);
    expect(res.entryPath).toBe(realFile);
  });

  it("registered but pathExists=false when the entry path is missing", () => {
    registerMcpInClaudeJson({
      claudeJsonPath: claudeJson,
      mcpEntryPath: "/definitely/not/here/index.js",
    });
    const res = inspectMcpRegistration({ claudeJsonPath: claudeJson });
    expect(res.registered).toBe(true);
    expect(res.pathExists).toBe(false);
  });

  it("not registered when the file is malformed (never throws)", () => {
    writeFileSync(claudeJson, "{ broken json");
    const res = inspectMcpRegistration({ claudeJsonPath: claudeJson });
    expect(res.registered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FR-162: mergeJsonConfig — the generalized 6-step JSON-merge core.
//
// Exercised directly with a GENERIC mapKey ("mcp", like OpenCode) + an
// arbitrary entryKey to prove the generalization holds. The existing
// registerMcpInClaudeJson suite above (which now delegates to mergeJsonConfig
// with mapKey:"mcpServers", entryKey:"igris-brain", backup:true) proves the
// extraction is behavior-preserving for the Claude wrapper.
// ---------------------------------------------------------------------------

/** A target config FILE inside the tmp dir (generic, NOT ~/.claude.json). */
let cfgPath: string;
const ENTRY_KEY = "my-server";
const SAMPLE_ENTRY: Record<string, unknown> = {
  type: "stdio",
  command: "node",
  args: ["/x/index.js"],
};

beforeEach(() => {
  cfgPath = join(workDir, "opencode.json");
});

describe("mergeJsonConfig — fresh file", () => {
  it("creates the file with the entry under mapKey when the target is absent", () => {
    expect(existsSync(cfgPath)).toBe(false);
    const res = mergeJsonConfig({
      targetPath: cfgPath,
      mapKey: "mcp",
      entryKey: ENTRY_KEY,
      entry: SAMPLE_ENTRY,
    });
    expect(res.outcome).toBe("registered");
    expect(res.claudeJsonPath).toBe(cfgPath);
    expect(existsSync(cfgPath)).toBe(true);

    const data = readJson(cfgPath);
    const map = data.mcp as Record<string, unknown>;
    expect(map[ENTRY_KEY]).toEqual(SAMPLE_ENTRY);
  });
});

describe("mergeJsonConfig — idempotent", () => {
  it("a second identical merge returns 'unchanged' and does not rewrite", () => {
    mergeJsonConfig({
      targetPath: cfgPath,
      mapKey: "mcp",
      entryKey: ENTRY_KEY,
      entry: SAMPLE_ENTRY,
    });
    const bytesAfterFirst = readFileSync(cfgPath);
    const mtimeFirst = statSync(cfgPath).mtimeMs;

    const res = mergeJsonConfig({
      targetPath: cfgPath,
      mapKey: "mcp",
      entryKey: ENTRY_KEY,
      // Same content, different key ORDER — still deep-equal → unchanged.
      entry: { args: ["/x/index.js"], command: "node", type: "stdio" },
    });
    expect(res.outcome).toBe("unchanged");
    expect(readFileSync(cfgPath).equals(bytesAfterFirst)).toBe(true);
    expect(statSync(cfgPath).mtimeMs).toBe(mtimeFirst);
  });
});

describe("mergeJsonConfig — preserve / no-clobber", () => {
  it("upserts only the target entry; sibling entries + top-level keys byte-preserved", () => {
    const before = {
      version: 9,
      somethingElse: { a: 1 },
      mcp: {
        "other-server": { command: "python", args: ["/srv.py"] },
      },
    };
    writeFileSync(cfgPath, JSON.stringify(before, null, 2) + "\n");

    const res = mergeJsonConfig({
      targetPath: cfgPath,
      mapKey: "mcp",
      entryKey: ENTRY_KEY,
      entry: SAMPLE_ENTRY,
    });
    expect(res.outcome).toBe("registered");

    const data = readJson(cfgPath);
    expect(data.version).toBe(9);
    expect(data.somethingElse).toEqual({ a: 1 });
    const map = data.mcp as Record<string, unknown>;
    // Sibling entry untouched.
    expect(map["other-server"]).toEqual({
      command: "python",
      args: ["/srv.py"],
    });
    // New entry upserted.
    expect(map[ENTRY_KEY]).toEqual(SAMPLE_ENTRY);
  });
});

describe("mergeJsonConfig — malformed never clobbered", () => {
  it("returns 'failed' on malformed JSON; file bytes UNCHANGED, no .tmp/.bak litter", () => {
    writeFileSync(cfgPath, "{ not valid json,,,");
    const bytesBefore = readFileSync(cfgPath);

    const res = mergeJsonConfig({
      targetPath: cfgPath,
      mapKey: "mcp",
      entryKey: ENTRY_KEY,
      entry: SAMPLE_ENTRY,
    });
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/malformed/);
    // File untouched.
    expect(readFileSync(cfgPath).equals(bytesBefore)).toBe(true);
    // No litter next to the file.
    const litter = readdirSync(workDir).filter(
      (f) => f.includes(".tmp.") || f.endsWith(BACKUP_SUFFIX),
    );
    expect(litter).toEqual([]);
  });
});

describe("mergeJsonConfig — non-object mapKey", () => {
  it("returns 'failed' when the mapKey value is not an object; file untouched", () => {
    const before = { mcp: "not-an-object" };
    writeFileSync(cfgPath, JSON.stringify(before) + "\n");
    const bytesBefore = readFileSync(cfgPath);

    const res = mergeJsonConfig({
      targetPath: cfgPath,
      mapKey: "mcp",
      entryKey: ENTRY_KEY,
      entry: SAMPLE_ENTRY,
    });
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/non-object 'mcp'/);
    expect(readFileSync(cfgPath).equals(bytesBefore)).toBe(true);
  });
});

describe("mergeJsonConfig — single rolling backup + backup gate", () => {
  it("backs up the pre-existing file once; backup bytes equal the pre-write content", () => {
    const before = { mcp: {} };
    writeFileSync(cfgPath, JSON.stringify(before) + "\n");
    const bytesBefore = readFileSync(cfgPath);

    mergeJsonConfig({
      targetPath: cfgPath,
      mapKey: "mcp",
      entryKey: ENTRY_KEY,
      entry: SAMPLE_ENTRY,
    });
    const bakPath = `${cfgPath}${BACKUP_SUFFIX}`;
    expect(existsSync(bakPath)).toBe(true);
    expect(readFileSync(bakPath).equals(bytesBefore)).toBe(true);

    // Second merge of a different entry overwrites the single rolling backup.
    mergeJsonConfig({
      targetPath: cfgPath,
      mapKey: "mcp",
      entryKey: ENTRY_KEY,
      entry: { type: "stdio", command: "node", args: ["/y/index.js"] },
    });
    const baks = readdirSync(workDir).filter((f) =>
      f.endsWith(BACKUP_SUFFIX),
    );
    expect(baks.length).toBe(1);
  });

  it("backup:false writes NO .bak file", () => {
    writeFileSync(cfgPath, JSON.stringify({ mcp: {} }) + "\n");
    mergeJsonConfig({
      targetPath: cfgPath,
      mapKey: "mcp",
      entryKey: ENTRY_KEY,
      entry: SAMPLE_ENTRY,
      backup: false,
    });
    const bakPath = `${cfgPath}${BACKUP_SUFFIX}`;
    expect(existsSync(bakPath)).toBe(false);
  });
});

describe("mergeJsonConfig — update existing entry", () => {
  it("returns 'updated' when the entry exists with different content", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ mcp: { [ENTRY_KEY]: { command: "old" } } }) + "\n",
    );
    const res = mergeJsonConfig({
      targetPath: cfgPath,
      mapKey: "mcp",
      entryKey: ENTRY_KEY,
      entry: SAMPLE_ENTRY,
    });
    expect(res.outcome).toBe("updated");
    const map = readJson(cfgPath).mcp as Record<string, unknown>;
    expect(map[ENTRY_KEY]).toEqual(SAMPLE_ENTRY);
  });
});

// ---------------------------------------------------------------------------
// FR-163: mergeTomlConfig — the TOML sibling of mergeJsonConfig.
//
// Table-scoped STRING-REGION SPLICE (NOT parse-and-re-emit). @iarna/toml is
// used PARSE-ONLY (malformed gate + structural idempotency compare). The
// defining guarantee — comments + sibling tables + key ordering survive
// byte-for-byte — is asserted in the "sibling preservation" test below; a
// lib-based re-emit (fallback B) would FAIL it. Same real-fs-no-mock idiom
// as the FR-162 suite above.
// ---------------------------------------------------------------------------

/** A target config FILE inside the tmp dir (generic, NOT ~/.codex/config.toml). */
let tomlPath: string;

beforeEach(() => {
  tomlPath = join(workDir, "config.toml");
});

/**
 * Fixture mirroring the SHAPE of the real ~/.codex/config.toml (sanitized
 * values): top-level model/notify (notify carries an escaped-JSON string),
 * two [marketplaces.*], an [mcp_servers.igris-brain] with `args` BEFORE
 * `command` (non-canonical key order), an [mcp_servers.mobile-mcp] with a
 * MULTI-LINE `args` array, an [mcp_servers.node_repl] + detached
 * [mcp_servers.node_repl.env] sub-table, inline `#` comments, and a tail
 * [features] table.
 */
const CODEX_FIXTURE = `# Codex config — hand-edited, comments must survive
model = "gpt-5"
model_reasoning_effort = "high"
notify = ["[\\"\\\\/Users\\\\/me\\\\/.igris\\\\/hook\\"]"]

[marketplaces.openai-bundled]
last_updated = "2026-01-01"
source_type = "git"
source = "https://example.com/a.git"

[marketplaces.claude-plugins-official]
last_updated = "2026-02-02"
source_type = "git"
source = "https://example.com/b.git"

[mcp_servers.igris-brain]
args = ["/repo/brain-mcp-server/dist/index.js"]
command = "node"

[mcp_servers.mobile-mcp]
command = "npx"
args = [
  "-y",
  "@mobile/mcp",
  "--port",
  "9000",
]

# node_repl is the detached-.env proof fixture
[mcp_servers.node_repl]
command = "node"
args = []
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_ENV = "production"
LOG_LEVEL = "debug"

[features]
js_repl = false
`;

describe("mergeTomlConfig — fresh / missing file", () => {
  it("creates the file with ONLY the rendered table when target is absent", () => {
    expect(existsSync(tomlPath)).toBe(false);
    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/abs/index.js"] },
    });
    expect(res.outcome).toBe("registered");
    expect(res.claudeJsonPath).toBe(tomlPath);
    expect(res.mcpEntryPath).toBe("");
    expect(existsSync(tomlPath)).toBe(true);

    const parsed = TOML.parse(readFileSync(tomlPath, "utf-8"));
    const servers = parsed.mcp_servers as Record<string, unknown>;
    const entry = servers["igris-brain"] as Record<string, unknown>;
    expect(entry.command).toBe("node");
    expect(entry.args).toEqual(["/abs/index.js"]);
    // Fresh file is ONLY the rendered table — no foreign content.
    expect(Object.keys(parsed)).toEqual(["mcp_servers"]);
  });
});

describe("mergeTomlConfig — sibling + comment preservation (headline AC)", () => {
  it("preserves siblings, top-level keys, comments, and the multi-line array verbatim", () => {
    writeFileSync(tomlPath, CODEX_FIXTURE);

    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "my-server", // NEW server — does not touch the existing ones
      entry: { command: "node", args: ["/new/server.js"] },
    });
    expect(res.outcome).toBe("registered");

    const out = readFileSync(tomlPath, "utf-8");

    // 1. Comments survive BYTE-FOR-BYTE (the splice's defining guarantee — a
    //    parse-and-re-emit impl would drop these and FAIL this assertion).
    expect(out).toContain(
      "# Codex config — hand-edited, comments must survive",
    );
    expect(out).toContain("# node_repl is the detached-.env proof fixture");

    // 2. The multi-line mobile-mcp array survives verbatim (proves the
    //    ^\s*\[ header scan does not mistake the indented array-close for a
    //    header and split the file mid-array).
    expect(out).toContain(
      'args = [\n  "-y",\n  "@mobile/mcp",\n  "--port",\n  "9000",\n]',
    );

    // 3. The escaped-JSON notify string survives verbatim.
    expect(out).toContain(
      'notify = ["[\\"\\\\/Users\\\\/me\\\\/.igris\\\\/hook\\"]"]',
    );

    // 4. Structural intactness of everything else (re-parse).
    const parsed = TOML.parse(out);
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.model_reasoning_effort).toBe("high");
    const marketplaces = parsed.marketplaces as Record<string, unknown>;
    expect(marketplaces["openai-bundled"]).toBeDefined();
    expect(marketplaces["claude-plugins-official"]).toBeDefined();
    const servers = parsed.mcp_servers as Record<string, unknown>;
    // Existing siblings intact.
    expect(servers["igris-brain"]).toBeDefined();
    expect(servers["mobile-mcp"]).toBeDefined();
    expect(servers["node_repl"]).toBeDefined();
    expect(
      (servers["node_repl"] as Record<string, unknown>).env,
    ).toEqual({ NODE_ENV: "production", LOG_LEVEL: "debug" });
    // The new server upserted.
    expect((servers["my-server"] as Record<string, unknown>).args).toEqual([
      "/new/server.js",
    ]);
    // Tail table intact.
    expect((parsed.features as Record<string, unknown>).js_repl).toBe(false);
  });
});

describe("mergeTomlConfig — upsert existing table (span boundary)", () => {
  it("replaces the target table and leaves the FOLLOWING table untouched", () => {
    writeFileSync(tomlPath, CODEX_FIXTURE);

    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain", // EXISTS — repoint its args
      entry: { command: "node", args: ["/bundled/index.js"] },
    });
    expect(res.outcome).toBe("updated");

    const parsed = TOML.parse(readFileSync(tomlPath, "utf-8"));
    const servers = parsed.mcp_servers as Record<string, unknown>;
    // Target repointed.
    expect((servers["igris-brain"] as Record<string, unknown>).args).toEqual([
      "/bundled/index.js",
    ]);
    // The table that FOLLOWS igris-brain (mobile-mcp) is untouched — proves
    // the span boundary stops at the next non-descendant header.
    expect((servers["mobile-mcp"] as Record<string, unknown>).args).toEqual([
      "-y",
      "@mobile/mcp",
      "--port",
      "9000",
    ]);
    // The multi-line mobile-mcp array text still survives verbatim.
    expect(readFileSync(tomlPath, "utf-8")).toContain(
      'args = [\n  "-y",\n  "@mobile/mcp",\n  "--port",\n  "9000",\n]',
    );
  });
});

describe("mergeTomlConfig — .env sub-table emission", () => {
  it("emits a [mcp_servers.<name>.env] block when entry.env is present", () => {
    writeFileSync(tomlPath, CODEX_FIXTURE);
    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "with-env",
      entry: {
        command: "node",
        args: ["/srv.js"],
        env: { API_KEY: "${IGRIS_API_KEY}" },
      },
    });
    expect(res.outcome).toBe("registered");

    const out = readFileSync(tomlPath, "utf-8");
    expect(out).toContain("[mcp_servers.with-env.env]");
    expect(out).toContain('API_KEY = "${IGRIS_API_KEY}"');

    const parsed = TOML.parse(out);
    const servers = parsed.mcp_servers as Record<string, unknown>;
    const env = (servers["with-env"] as Record<string, unknown>).env as Record<
      string,
      unknown
    >;
    expect(env.API_KEY).toBe("${IGRIS_API_KEY}");
  });

  it("does NOT emit an .env block when env is absent or empty", () => {
    writeFileSync(tomlPath, CODEX_FIXTURE);
    mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "no-env",
      entry: { command: "node", args: ["/srv.js"], env: {} },
    });
    const out = readFileSync(tomlPath, "utf-8");
    expect(out).not.toContain("[mcp_servers.no-env.env]");
  });
});

describe("mergeTomlConfig — .env sub-table span on update", () => {
  it("replaces an existing detached .env sub-table without duplicating it", () => {
    writeFileSync(tomlPath, CODEX_FIXTURE);
    // node_repl already HAS a detached [mcp_servers.node_repl.env] block.
    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "node_repl",
      entry: {
        command: "node",
        args: ["/new.js"],
        env: { ONLY_KEY: "value" },
      },
    });
    expect(res.outcome).toBe("updated");

    const out = readFileSync(tomlPath, "utf-8");
    // The OLD env keys are gone, the new one present, and the env header is
    // NOT duplicated (proves the dotted-prefix continuation rule replaced the
    // whole [parent + .env] span).
    expect(out).not.toContain("NODE_ENV");
    expect(out).not.toContain("LOG_LEVEL");
    expect(out).toContain("ONLY_KEY");
    const envHeaderCount = (
      out.match(/\[mcp_servers\.node_repl\.env\]/g) ?? []
    ).length;
    expect(envHeaderCount).toBe(1);

    // The NEXT non-descendant table (features) is untouched.
    const parsed = TOML.parse(out);
    expect((parsed.features as Record<string, unknown>).js_repl).toBe(false);
    expect(
      (
        (parsed.mcp_servers as Record<string, unknown>)[
          "node_repl"
        ] as Record<string, unknown>
      ).env,
    ).toEqual({ ONLY_KEY: "value" });
  });
});

describe("mergeTomlConfig — idempotent (structural, not byte)", () => {
  it("a second identical merge returns 'unchanged'; bytes + mtime unchanged; no .bak", () => {
    // Seed with a known entry first.
    mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/x/index.js"] },
    });
    const bytesAfterFirst = readFileSync(tomlPath);
    const mtimeFirst = statSync(tomlPath).mtimeMs;
    // Remove any backup from the first write so we can assert the no-op
    // leaves nothing behind.
    const bakPath = `${tomlPath}${BACKUP_SUFFIX}`;
    if (existsSync(bakPath)) rmSync(bakPath);

    // Second merge — same content, but the entry object's key order differs.
    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { args: ["/x/index.js"], command: "node" },
    });
    expect(res.outcome).toBe("unchanged");
    expect(readFileSync(tomlPath).equals(bytesAfterFirst)).toBe(true);
    expect(statSync(tomlPath).mtimeMs).toBe(mtimeFirst);
    // No backup written on the no-op.
    expect(existsSync(bakPath)).toBe(false);
  });
});

describe("mergeTomlConfig — malformed never clobbered", () => {
  it("returns 'failed' on malformed TOML; bytes UNCHANGED; no .tmp/.bak litter", () => {
    const broken = "[mcp_servers.x]\nbroken = = =\n";
    writeFileSync(tomlPath, broken);
    const bytesBefore = readFileSync(tomlPath);

    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/x.js"] },
    });
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/malformed/);
    // File untouched.
    expect(readFileSync(tomlPath).equals(bytesBefore)).toBe(true);
    // No litter next to the file.
    const litter = readdirSync(workDir).filter(
      (f) => f.includes("config.toml.tmp.") || f.endsWith(BACKUP_SUFFIX),
    );
    expect(litter).toEqual([]);
  });
});

describe("mergeTomlConfig — non-table conflict", () => {
  it("returns 'failed' when mcp_servers is a non-table scalar; file untouched", () => {
    const before = 'model = "x"\nmcp_servers = 1\n';
    writeFileSync(tomlPath, before);
    const bytesBefore = readFileSync(tomlPath);

    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/x.js"] },
    });
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/non-table 'mcp_servers'/);
    expect(readFileSync(tomlPath).equals(bytesBefore)).toBe(true);
  });
});

describe("mergeTomlConfig — single rolling backup + backup gate", () => {
  it("backs up the pre-existing file once; backup bytes equal the pre-write content", () => {
    writeFileSync(tomlPath, CODEX_FIXTURE);
    const bytesBefore = readFileSync(tomlPath);

    mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "first-add",
      entry: { command: "node", args: ["/one.js"] },
    });
    const bakPath = `${tomlPath}${BACKUP_SUFFIX}`;
    expect(existsSync(bakPath)).toBe(true);
    expect(readFileSync(bakPath).equals(bytesBefore)).toBe(true);

    // A second differing merge overwrites the SINGLE rolling backup.
    mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "second-add",
      entry: { command: "node", args: ["/two.js"] },
    });
    const baks = readdirSync(workDir).filter((f) => f.endsWith(BACKUP_SUFFIX));
    expect(baks.length).toBe(1);
  });

  it("backup:false writes NO .bak file", () => {
    writeFileSync(tomlPath, CODEX_FIXTURE);
    mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "no-bak",
      entry: { command: "node", args: ["/x.js"] },
      backup: false,
    });
    expect(existsSync(`${tomlPath}${BACKUP_SUFFIX}`)).toBe(false);
  });
});

describe("mergeTomlConfig — startup_timeout_sec passthrough", () => {
  it("emits startup_timeout_sec only when present", () => {
    mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "with-timeout",
      entry: { command: "node", args: ["/x.js"], startup_timeout_sec: 120 },
    });
    const out = readFileSync(tomlPath, "utf-8");
    expect(out).toContain("startup_timeout_sec = 120");
    const parsed = TOML.parse(out);
    expect(
      (
        (parsed.mcp_servers as Record<string, unknown>)[
          "with-timeout"
        ] as Record<string, unknown>
      ).startup_timeout_sec,
    ).toBe(120);
  });
});

describe("__testing__.locateTomlTableSpan — span boundaries", () => {
  it("spans exactly the header through the line before the next sibling header", () => {
    const lines = CODEX_FIXTURE.split("\n");
    const span = locateTomlTableSpan(lines, "mcp_servers", "igris-brain");
    expect(span).not.toBeNull();
    if (!span) return;
    // Start line IS the [mcp_servers.igris-brain] header.
    expect(lines[span.start].trim()).toBe("[mcp_servers.igris-brain]");
    // End (exclusive) is the next non-descendant header — [mcp_servers.mobile-mcp].
    expect(lines[span.end].trim()).toBe("[mcp_servers.mobile-mcp]");
  });

  it("includes the detached .env sub-table and stops at the next non-descendant", () => {
    const lines = CODEX_FIXTURE.split("\n");
    const span = locateTomlTableSpan(lines, "mcp_servers", "node_repl");
    expect(span).not.toBeNull();
    if (!span) return;
    expect(lines[span.start].trim()).toBe("[mcp_servers.node_repl]");
    // The span must INCLUDE the detached [mcp_servers.node_repl.env] header.
    const spannedText = lines.slice(span.start, span.end).join("\n");
    expect(spannedText).toContain("[mcp_servers.node_repl.env]");
    expect(spannedText).toContain("NODE_ENV");
    // And STOP at the following non-descendant table ([features]).
    expect(lines[span.end].trim()).toBe("[features]");
  });

  it("returns null when the table is absent", () => {
    const lines = CODEX_FIXTURE.split("\n");
    expect(locateTomlTableSpan(lines, "mcp_servers", "does-not-exist")).toBeNull();
  });
});

describe("__testing__.renderMcpTomlTable — emitter shape", () => {
  it("renders command + args; empty args as []", () => {
    const out = renderMcpTomlTable("mcp_servers", "srv", {
      command: "node",
      args: [],
    });
    expect(out).toContain("[mcp_servers.srv]");
    expect(out).toContain('command = "node"');
    expect(out).toContain("args = []");
    expect(out).not.toContain(".env]");
  });
});

// ---------------------------------------------------------------------------
// FR-163 retry (Warden review): the two corrupting-on-legal-TOML defects + the
// load-bearing parse-verify post-condition guard.
//
//  M1 — same-line comment on the target header → was duplicate-table append.
//  M2 — `[`-at-column-0 line INSIDE a multiline string → was splice mislocation.
//  Guard — any residual mislocation must become a SAFE `failed`, not a write.
// ---------------------------------------------------------------------------

describe("mergeTomlConfig — M1: commented target header (no duplicate table)", () => {
  it("UPDATES a table whose header carries a trailing # comment, in place", () => {
    const fixture = `model = "gpt-5"

[mcp_servers.igris-brain] # pinned — do not remove
args = ["/old/index.js"]
command = "node"

[features]
js_repl = false
`;
    writeFileSync(tomlPath, fixture);

    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/new/index.js"] },
    });
    expect(res.outcome).toBe("updated");

    const out = readFileSync(tomlPath, "utf-8");
    // Exactly ONE igris-brain header — no duplicate appended at EOF.
    const headerCount = (
      out.match(/^\s*\[mcp_servers\.igris-brain\]/gm) ?? []
    ).length;
    expect(headerCount).toBe(1);

    // Result still parses (duplicate-table would make @iarna throw on re-read).
    const parsed = TOML.parse(out);
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect((servers["igris-brain"] as Record<string, unknown>).args).toEqual([
      "/new/index.js",
    ]);
    // The tail [features] table is untouched.
    expect((parsed.features as Record<string, unknown>).js_repl).toBe(false);
  });

  it("is idempotent on a commented-header table (re-run → unchanged)", () => {
    const fixture = `[mcp_servers.igris-brain] # pinned
command = "node"
args = ["/x/index.js"]
`;
    writeFileSync(tomlPath, fixture);

    const first = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/x/index.js"] },
    });
    // Already structurally equal → no rewrite at all.
    expect(first.outcome).toBe("unchanged");

    const second = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/x/index.js"] },
    });
    expect(second.outcome).toBe("unchanged");
    // Still exactly one header.
    const headerCount = (
      readFileSync(tomlPath, "utf-8").match(
        /^\s*\[mcp_servers\.igris-brain\]/gm,
      ) ?? []
    ).length;
    expect(headerCount).toBe(1);
  });
});

describe("mergeTomlConfig — M2: bracket-line inside a multiline string", () => {
  it("updates only the REAL igris-brain table; the multiline string survives byte-for-byte", () => {
    // A sibling table whose `note` value is a multiline string CONTAINING a
    // line that LOOKS like the target header. This is VALID TOML — the
    // malformed gate passes it — but a naive line scan would match the FAKE
    // header inside the string and mislocate the splice.
    const fixture = `[mcp_servers.other]
command = "python"
note = """
[mcp_servers.igris-brain]
this is just text, not a real header
"""

[mcp_servers.igris-brain]
command = "node"
args = ["/old/index.js"]

[features]
js_repl = true
`;
    writeFileSync(tomlPath, fixture);

    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/new/index.js"] },
    });
    expect(res.outcome).toBe("updated");

    const out = readFileSync(tomlPath, "utf-8");
    // The multiline string block survives verbatim.
    expect(out).toContain(
      'note = """\n[mcp_servers.igris-brain]\nthis is just text, not a real header\n"""',
    );
    // Result parses; the REAL igris-brain table was repointed; `other.note`
    // string content preserved exactly.
    const parsed = TOML.parse(out);
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect((servers["igris-brain"] as Record<string, unknown>).args).toEqual([
      "/new/index.js",
    ]);
    const other = servers["other"] as Record<string, unknown>;
    expect(other.note).toBe(
      "[mcp_servers.igris-brain]\nthis is just text, not a real header\n",
    );
    expect((parsed.features as Record<string, unknown>).js_repl).toBe(true);
  });

  it("variant: the bracket-bearing multiline string is in the TARGET table's own value", () => {
    // The fake header sits INSIDE the target table's own multiline value,
    // BEFORE the real next sibling. The end-scan must not treat it as a span
    // boundary (which would cut the table mid-string).
    const fixture = `[mcp_servers.igris-brain]
command = "node"
args = ["/old/index.js"]
note = """
some prose
[features]
more prose
"""

[features]
js_repl = false
`;
    writeFileSync(tomlPath, fixture);

    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/new/index.js"] },
    });
    expect(res.outcome).toBe("updated");

    const out = readFileSync(tomlPath, "utf-8");
    const parsed = TOML.parse(out);
    const servers = parsed.mcp_servers as Record<string, unknown>;
    // The whole igris-brain table (including its multiline note) was replaced
    // by the rendered table — the note is gone, args repointed — and crucially
    // the REAL [features] table after the string is intact (not clobbered by a
    // mid-string cut).
    expect((servers["igris-brain"] as Record<string, unknown>).args).toEqual([
      "/new/index.js",
    ]);
    expect((parsed.features as Record<string, unknown>).js_repl).toBe(false);
    // The string's fake [features] line did not survive as a real table value.
    expect(servers["igris-brain"]).not.toHaveProperty("note");
  });
});

describe("mergeTomlConfig — [[array-of-tables]] boundary", () => {
  it("treats a following [[array]] header as a span boundary (does not absorb it)", () => {
    const fixture = `[mcp_servers.igris-brain]
command = "node"
args = ["/old/index.js"]

[[servers]]
name = "alpha"

[[servers]]
name = "beta"
`;
    writeFileSync(tomlPath, fixture);

    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/new/index.js"] },
    });
    expect(res.outcome).toBe("updated");

    const out = readFileSync(tomlPath, "utf-8");
    const parsed = TOML.parse(out);
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect((servers["igris-brain"] as Record<string, unknown>).args).toEqual([
      "/new/index.js",
    ]);
    // The array-of-tables is intact — both elements survive.
    const arr = parsed.servers as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    expect(arr[0].name).toBe("alpha");
    expect(arr[1].name).toBe("beta");
  });
});

describe("mergeTomlConfig — CRLF file is not corrupted", () => {
  it("preserves CRLF line endings on a Windows-authored file and stays parseable", () => {
    const fixture =
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.igris-brain]",
        'command = "node"',
        'args = ["/old/index.js"]',
        "",
        "[features]",
        "js_repl = false",
        "",
      ].join("\r\n");
    writeFileSync(tomlPath, fixture);

    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/new/index.js"] },
    });
    expect(res.outcome).toBe("updated");

    const out = readFileSync(tomlPath, "utf-8");
    // Result parses cleanly.
    const parsed = TOML.parse(out);
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect((servers["igris-brain"] as Record<string, unknown>).args).toEqual([
      "/new/index.js",
    ]);
    expect((parsed.features as Record<string, unknown>).js_repl).toBe(false);
    // No bare-LF lines introduced: every \n is part of a \r\n pair.
    const bareLf = out.split("").filter((c, i) => c === "\n" && out[i - 1] !== "\r");
    expect(bareLf).toHaveLength(0);
  });
});

describe("mergeTomlConfig — parse-verify guard returns 'failed' on mislocation", () => {
  it("an unparseable rendered table → SAFE 'failed', file UNCHANGED (no corrupting write)", () => {
    // Belt-and-suspenders: any render that produces unparseable TOML is rejected
    // BEFORE the write — caught at the step-4 emitter parse OR the step-5b
    // post-splice guard, both of which return 'failed' and leave the file
    // byte-for-byte intact. (Span mislocations that produce VALID-but-wrong TOML
    // are exercised by the (c) cases below — that is the guard's primary job.)
    const fixture = `[mcp_servers.igris-brain]
command = "node"
args = ["/old/index.js"]

[features]
js_repl = false
`;
    writeFileSync(tomlPath, fixture);
    const bytesBefore = readFileSync(tomlPath);

    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/new/index.js"] },
      __renderOverride: () => "[mcp_servers.igris-brain\nbroken = = =\n",
    });
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/splice verification failed|did not parse/);

    // File is byte-for-byte unchanged — the corrupting write was refused.
    expect(readFileSync(tomlPath).equals(bytesBefore)).toBe(true);
    // No litter.
    const litter = readdirSync(workDir).filter((f) =>
      f.includes("config.toml.tmp."),
    );
    expect(litter).toEqual([]);
  });

  it("guard (c): a splice that mutates a sibling table becomes 'failed', file UNCHANGED", () => {
    const fixture = `[mcp_servers.igris-brain]
command = "node"
args = ["/old/index.js"]

[mcp_servers.keep-me]
command = "python"
args = ["/srv.py"]
`;
    writeFileSync(tomlPath, fixture);
    const bytesBefore = readFileSync(tomlPath);

    // The injected replacement spans correctly over igris-brain but ALSO
    // re-declares the sibling mcp_servers.keep-me with a mutated command. The
    // splice replaces only the igris-brain span, but the rendered text drags in
    // a second table — so the candidate parse shows keep-me CHANGED vs the
    // original. Guard (c) (collateral change to other tables) must fire.
    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/new/index.js"] },
      __renderOverride: () =>
        '[mcp_servers.igris-brain]\ncommand = "node"\nargs = ["/new/index.js"]\n\n[mcp_servers.keep-me]\ncommand = "MUTATED"\nargs = []\n',
    });
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/splice verification failed/);

    expect(readFileSync(tomlPath).equals(bytesBefore)).toBe(true);
  });

  it("a splice that renames the target table away becomes 'failed', file UNCHANGED", () => {
    const fixture = `model = "gpt-5"

[mcp_servers.igris-brain]
command = "node"
args = ["/old/index.js"]
`;
    writeFileSync(tomlPath, fixture);
    const bytesBefore = readFileSync(tomlPath);

    // The override emits a table under a DIFFERENT name, so the spliced
    // candidate loses mcp_servers.igris-brain and gains mcp_servers.elsewhere —
    // a structural change to "other tables" that guard (c) catches. Either way
    // the contract holds: any mislocation/emit defect → SAFE 'failed', no write.
    const res = mergeTomlConfig({
      targetPath: tomlPath,
      tablePrefix: "mcp_servers",
      entryKey: "igris-brain",
      entry: { command: "node", args: ["/new/index.js"] },
      __renderOverride: () =>
        '[mcp_servers.elsewhere]\ncommand = "node"\nargs = []\n',
    });
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/splice verification failed/);
    expect(readFileSync(tomlPath).equals(bytesBefore)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TD-221: the merger writes are perms-preserving — after a successful
// registered/updated write the target config is 600, NOT umask-default 644.
// `renameSync(tmp, target)` adopts the tmp file's mode (typically 644), which
// silently re-loosened a previously-600 harness config on every MCP
// (re-)registration; the post-rename `chmodSecretFile(target)` closes that gap
// (R1). The chmod sits AFTER the rename inside the write block, so it is
// structurally unreachable on the `unchanged`/`failed` paths.
//
// Mode bits are meaningless on win32 (`chmodSecretFile` is a no-op there and
// `statSync().mode` carries no POSIX perm bits), so the mode assertions are
// POSIX-gated — mirroring the secret-perms suite.
// ---------------------------------------------------------------------------

/** True when POSIX mode bits are meaningful on this host (NOT win32). */
const POSIX = process.platform !== "win32";
/** Extract the owner/group/other perm bits from a file's mode. */
const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe("TD-221 — mergers leave the config at 600 (perms durability)", () => {
  it.skipIf(!POSIX)(
    "mergeJsonConfig: a NEW file created by a registered write is 600",
    () => {
      expect(existsSync(cfgPath)).toBe(false);
      const res = mergeJsonConfig({
        targetPath: cfgPath,
        mapKey: "mcp",
        entryKey: ENTRY_KEY,
        entry: SAMPLE_ENTRY,
      });
      expect(res.outcome).toBe("registered");
      expect(modeOf(cfgPath)).toBe(0o600);
    },
  );

  it.skipIf(!POSIX)(
    "mergeTomlConfig: a NEW file created by a registered write is 600",
    () => {
      expect(existsSync(tomlPath)).toBe(false);
      const res = mergeTomlConfig({
        targetPath: tomlPath,
        tablePrefix: "mcp_servers",
        entryKey: "igris-brain",
        entry: { command: "node", args: ["/x/index.js"] },
      });
      expect(res.outcome).toBe("registered");
      expect(modeOf(tomlPath)).toBe(0o600);
    },
  );

  it.skipIf(!POSIX)(
    "mergeJsonConfig: a config pre-set to 600 then re-merged (updated) REMAINS 600",
    () => {
      // Register, then tighten to 600 to model a doctor --fix'd config.
      mergeJsonConfig({
        targetPath: cfgPath,
        mapKey: "mcp",
        entryKey: ENTRY_KEY,
        entry: SAMPLE_ENTRY,
      });
      chmodSync(cfgPath, 0o600);
      expect(modeOf(cfgPath)).toBe(0o600);

      // Re-merge with DIFFERENT content so the outcome is 'updated' (a real write).
      const res = mergeJsonConfig({
        targetPath: cfgPath,
        mapKey: "mcp",
        entryKey: ENTRY_KEY,
        entry: { type: "stdio", command: "node", args: ["/y/index.js"] },
      });
      expect(res.outcome).toBe("updated");
      // Durability AC: still 600, NO doctor --fix needed.
      expect(modeOf(cfgPath)).toBe(0o600);
    },
  );

  it.skipIf(!POSIX)(
    "mergeTomlConfig: a config pre-set to 600 then re-merged (updated) REMAINS 600",
    () => {
      mergeTomlConfig({
        targetPath: tomlPath,
        tablePrefix: "mcp_servers",
        entryKey: "igris-brain",
        entry: { command: "node", args: ["/x/index.js"] },
      });
      chmodSync(tomlPath, 0o600);
      expect(modeOf(tomlPath)).toBe(0o600);

      const res = mergeTomlConfig({
        targetPath: tomlPath,
        tablePrefix: "mcp_servers",
        entryKey: "igris-brain",
        entry: { command: "node", args: ["/y/index.js"] },
      });
      expect(res.outcome).toBe("updated");
      expect(modeOf(tomlPath)).toBe(0o600);
    },
  );

  it.skipIf(!POSIX)(
    "mergeJsonConfig: a config pre-loosened to 644 is RE-TIGHTENED to 600 on write",
    () => {
      mergeJsonConfig({
        targetPath: cfgPath,
        mapKey: "mcp",
        entryKey: ENTRY_KEY,
        entry: SAMPLE_ENTRY,
      });
      // Simulate the pre-TD-221 re-loosen.
      chmodSync(cfgPath, 0o644);
      expect(modeOf(cfgPath)).toBe(0o644);

      const res = mergeJsonConfig({
        targetPath: cfgPath,
        mapKey: "mcp",
        entryKey: ENTRY_KEY,
        entry: { type: "stdio", command: "node", args: ["/y/index.js"] },
      });
      expect(res.outcome).toBe("updated");
      expect(modeOf(cfgPath)).toBe(0o600);
    },
  );

  it.skipIf(!POSIX)(
    "mergeTomlConfig: a config pre-loosened to 644 is RE-TIGHTENED to 600 on write",
    () => {
      mergeTomlConfig({
        targetPath: tomlPath,
        tablePrefix: "mcp_servers",
        entryKey: "igris-brain",
        entry: { command: "node", args: ["/x/index.js"] },
      });
      chmodSync(tomlPath, 0o644);
      expect(modeOf(tomlPath)).toBe(0o644);

      const res = mergeTomlConfig({
        targetPath: tomlPath,
        tablePrefix: "mcp_servers",
        entryKey: "igris-brain",
        entry: { command: "node", args: ["/y/index.js"] },
      });
      expect(res.outcome).toBe("updated");
      expect(modeOf(tomlPath)).toBe(0o600);
    },
  );

  it.skipIf(!POSIX)(
    "mergeJsonConfig: an 'unchanged' re-merge does NOT touch the mode (chmod gated off)",
    () => {
      mergeJsonConfig({
        targetPath: cfgPath,
        mapKey: "mcp",
        entryKey: ENTRY_KEY,
        entry: SAMPLE_ENTRY,
      });
      // Leave a DISTINCTIVE non-600, non-644 mode so we can prove the chmod
      // never ran on the unchanged path (it would force 600).
      chmodSync(cfgPath, 0o640);

      const res = mergeJsonConfig({
        targetPath: cfgPath,
        mapKey: "mcp",
        entryKey: ENTRY_KEY,
        // Same content, different key ORDER → deep-equal → 'unchanged'.
        entry: { args: ["/x/index.js"], command: "node", type: "stdio" },
      });
      expect(res.outcome).toBe("unchanged");
      // Mode untouched — the early-return path never reaches the post-rename chmod.
      expect(modeOf(cfgPath)).toBe(0o640);
    },
  );

  it.skipIf(!POSIX)(
    "mergeTomlConfig: an 'unchanged' re-merge does NOT touch the mode (chmod gated off)",
    () => {
      mergeTomlConfig({
        targetPath: tomlPath,
        tablePrefix: "mcp_servers",
        entryKey: "igris-brain",
        entry: { command: "node", args: ["/x/index.js"] },
      });
      chmodSync(tomlPath, 0o640);

      const res = mergeTomlConfig({
        targetPath: tomlPath,
        tablePrefix: "mcp_servers",
        entryKey: "igris-brain",
        // Same content → structural deep-equal → 'unchanged'.
        entry: { command: "node", args: ["/x/index.js"] },
      });
      expect(res.outcome).toBe("unchanged");
      expect(modeOf(tomlPath)).toBe(0o640);
    },
  );
});
