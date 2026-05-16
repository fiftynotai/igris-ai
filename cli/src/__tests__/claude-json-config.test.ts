/**
 * claude-json-config.test.ts — TD-168.
 *
 * Drives `runInit({ fromSource, ... })` against a sandboxed brain
 * (`IGRIS_BRAIN_DIR`) + sandboxed `HOME` (so `claudeJsonPath()` resolves
 * into tmp) and asserts the post-init `~/.claude.json` carries the
 * `igris-brain` MCP entry.
 *
 * Real `node:fs`, real better-sqlite3, no mocks (L-159) — models
 * `init.test.ts`. The brief named this file `init-config.test.ts`; that
 * name is taken by the subconscious-config suite, so a distinct filename.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let brainRoot: string;
let homeOverride: string;
let pathOverride: string;
let sourceRepo: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "igris-claude-json-test-"));
  brainRoot = join(workDir, "brain");
  homeOverride = join(workDir, "home");
  pathOverride = join(workDir, "bin");
  sourceRepo = join(workDir, "source-repo");
  mkdirSync(homeOverride, { recursive: true });
  mkdirSync(pathOverride, { recursive: true });
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  envBackup.HOME = process.env.HOME;
  envBackup.PATH = process.env.PATH;
  process.env.IGRIS_BRAIN_DIR = brainRoot;
  process.env.HOME = homeOverride;
  // Empty PATH so cli-detect finds no bridges to materialize.
  process.env.PATH = pathOverride;
  stageSourceRepo(sourceRepo);
  const reg = await import("../lib/registry.js");
  reg.closeDb();
});

afterEach(async () => {
  const reg = await import("../lib/registry.js");
  reg.closeDb();
  rmSync(workDir, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
  process.env.HOME = envBackup.HOME;
  process.env.PATH = envBackup.PATH;
});

function stageSourceRepo(root: string): void {
  const core = join(root, "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "SOUL.md"), "# soul (from-source)\n");
  mkdirSync(join(core, "agents"), { recursive: true });
  writeFileSync(join(core, "agents", "manifest.yaml"), "agents: []\n");
  mkdirSync(join(core, "rules"), { recursive: true });
  writeFileSync(join(core, "rules", "00-igris-universal.md"), "# universal\n");
  mkdirSync(join(core, "skills", "demo"), { recursive: true });
  writeFileSync(join(core, "skills", "demo", "SKILL.md"), "# demo\n");
  mkdirSync(join(core, "hooks"), { recursive: true });
  writeFileSync(
    join(core, "hooks", "canonical-settings.json"),
    JSON.stringify({ hooks: {} }, null, 2) + "\n",
  );
  mkdirSync(join(core, "scripts"), { recursive: true });
  writeFileSync(
    join(core, "scripts", "verify_mirror.sh"),
    "#!/bin/sh\necho noop\n",
  );
  chmodSync(join(core, "scripts", "verify_mirror.sh"), 0o755);
  mkdirSync(join(core, "templates"), { recursive: true });
  writeFileSync(join(core, "templates", "CLAUDE.md.tmpl"), "# CLAUDE template\n");
}

function claudeJson(): string {
  return join(homeOverride, ".claude.json");
}

describe("init — registers igris-brain MCP in ~/.claude.json (TD-168)", () => {
  it("creates ~/.claude.json with a stdio igris-brain entry", async () => {
    const { runInit } = await import("../verbs/init.js");
    const code = await runInit({ fromSource: sourceRepo, cliVersion: "7.0.0" });
    expect(code).toBe(0);

    expect(existsSync(claudeJson())).toBe(true);
    const data = JSON.parse(readFileSync(claudeJson(), "utf-8")) as {
      mcpServers: Record<string, { type: string; command: string; args: string[] }>;
    };
    const entry = data.mcpServers["igris-brain"];
    expect(entry).toBeDefined();
    expect(entry.type).toBe("stdio");
    expect(entry.command).toBe("node");
    expect(entry.args[0].endsWith(join("brain-mcp-server", "dist", "index.js"))).toBe(
      true,
    );
  });

  it("preserves a pre-existing foreign MCP entry across init", async () => {
    const foreign = {
      type: "stdio",
      command: "node",
      args: ["/some/foreign/server.js"],
      env: {},
    };
    writeFileSync(
      claudeJson(),
      JSON.stringify({
        numStartups: 11,
        mcpServers: { "foreign-mcp": foreign },
      }) + "\n",
    );

    const { runInit } = await import("../verbs/init.js");
    expect(await runInit({ fromSource: sourceRepo })).toBe(0);

    const data = JSON.parse(readFileSync(claudeJson(), "utf-8")) as {
      numStartups: number;
      mcpServers: Record<string, unknown>;
    };
    // Foreign entry + foreign top-level key preserved verbatim.
    expect(data.numStartups).toBe(11);
    expect(data.mcpServers["foreign-mcp"]).toEqual(foreign);
    // And igris-brain was added alongside.
    expect(data.mcpServers["igris-brain"]).toBeDefined();
  });

  it("--dev registers the clone's MCP path, not the bundled path", async () => {
    const { runInit } = await import("../verbs/init.js");
    const code = await runInit({
      fromSource: sourceRepo,
      dev: true,
      cliVersion: "7.0.0",
    });
    expect(code).toBe(0);
    const data = JSON.parse(readFileSync(claudeJson(), "utf-8")) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    // --dev points at <fromSource>/brain-mcp-server/dist/index.js.
    expect(data.mcpServers["igris-brain"].args[0]).toBe(
      join(sourceRepo, "brain-mcp-server", "dist", "index.js"),
    );
  });

  it("--dev without --from-source fails with an actionable error", async () => {
    const { runInit } = await import("../verbs/init.js");
    // --dev requires --from-source; without it init must error (and the
    // sandboxed brain is fresh so the absence-of-install gate doesn't
    // fire first — --dev is checked after the core swap).
    const code = await runInit({ dev: true, skipRemote: true });
    expect(code).toBe(1);
  });

  it("init --dry-run does NOT write ~/.claude.json", async () => {
    const { runInit } = await import("../verbs/init.js");
    expect(await runInit({ fromSource: sourceRepo, dryRun: true })).toBe(0);
    expect(existsSync(claudeJson())).toBe(false);
  });
});
