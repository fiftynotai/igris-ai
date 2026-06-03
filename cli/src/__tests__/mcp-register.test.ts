/**
 * mcp-register.ts tests — TD-168.
 *
 * Real `node:fs` against `mkdtempSync` tmp dirs — no mocks (L-159: spy at
 * dependency boundaries, but here there is no boundary to spy; the module
 * IS a thin fs wrapper, so we exercise it directly against a sandboxed
 * `~/.claude.json` path). Models `tarball.test.ts` / `claude-md.test.ts`.
 *
 * The malformed-file byte-equality test is the #1 correctness AC for
 * TD-168 — `~/.claude.json` is hot machine state and must never be
 * corrupted.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
import {
  mergeJsonConfig,
  registerMcpInClaudeJson,
  inspectMcpRegistration,
  __testing__,
} from "../lib/mcp-register.js";
import { bundledMcpEntryPath } from "../lib/paths.js";

const { MCP_KEY, BACKUP_SUFFIX } = __testing__;

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
