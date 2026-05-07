/**
 * init verb tests — M1.13.
 *
 * Uses --from-source exclusively for hermetic runs (no network, no
 * mocks needed at the verb level). Real fs against tmp; real
 * better-sqlite3; HOME + IGRIS_BRAIN_DIR overrides isolate the brain.
 *
 * The "byte-for-byte preservation" test (M1.10 critical gate) lives
 * here. It stages a v7 install, modifies USER.md / config.json /
 * knowledge.db with deterministic bytes, runs --upgrade, and asserts
 * the bytes are identical post-swap.
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
  workDir = mkdtempSync(join(tmpdir(), "igris-init-test-"));
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
  // Empty PATH so cli-detect finds nothing (no bridges to materialize).
  process.env.PATH = pathOverride;
  // Stage a from-source repo with a minimal core/.
  stageSourceRepo(sourceRepo);
  // Reset registry handle so previous test's brainRoot doesn't leak.
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
  writeFileSync(
    join(core, "rules", "00-igris-universal.md"),
    "# universal\n",
  );
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
  writeFileSync(
    join(core, "templates", "CLAUDE.md.tmpl"),
    "# CLAUDE template\n",
  );
}

describe("init — fresh install via --from-source", () => {
  it("creates brain dir tree, core/, knowledge.db, USER.md, config.json, .install-source.json", async () => {
    const { runInit } = await import("../verbs/init.js");
    const code = await runInit({ fromSource: sourceRepo, cliVersion: "7.0.0" });
    expect(code).toBe(0);

    // Directory tree
    expect(existsSync(join(brainRoot, "memory"))).toBe(true);
    expect(existsSync(join(brainRoot, "projects"))).toBe(true);
    expect(existsSync(join(brainRoot, "logs"))).toBe(true);
    expect(existsSync(join(brainRoot, ".cache"))).toBe(true);

    // Core content arrived
    expect(existsSync(join(brainRoot, "core", "SOUL.md"))).toBe(true);
    expect(
      readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8"),
    ).toBe("# soul (from-source)\n");
    expect(
      existsSync(
        join(brainRoot, "core", "skills", "demo", "SKILL.md"),
      ),
    ).toBe(true);

    // DB created
    expect(existsSync(join(brainRoot, "memory", "knowledge.db"))).toBe(true);

    // Templates
    expect(existsSync(join(brainRoot, "USER.md"))).toBe(true);
    expect(existsSync(join(brainRoot, "config.json"))).toBe(true);

    // Install source
    expect(existsSync(join(brainRoot, ".install-source.json"))).toBe(true);
    const isj = JSON.parse(
      readFileSync(join(brainRoot, ".install-source.json"), "utf-8"),
    ) as { source: string; ref: string };
    expect(isj.source).toBe("from-source");
  });

  it("config.json substitutes IGRIS_VERSION + INSTALL_DATE; remote_brain set when --skip-remote not passed", async () => {
    const { runInit } = await import("../verbs/init.js");
    await runInit({ fromSource: sourceRepo, cliVersion: "9.9.9" });
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { version: string; subconscious: { enabled: boolean }; remote_brain: unknown };
    expect(cfg.version).toBe("9.9.9");
    expect(cfg.subconscious.enabled).toBe(false);
    expect(cfg.remote_brain).not.toBe(null);
  });

  it("--skip-remote sets config.remote_brain to null", async () => {
    const { runInit } = await import("../verbs/init.js");
    await runInit({ fromSource: sourceRepo, skipRemote: true });
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: unknown };
    expect(cfg.remote_brain).toBe(null);
  });

  it("--cli-bridge=none keeps cli_targets empty even if detection had hits", async () => {
    const { runInit } = await import("../verbs/init.js");
    await runInit({ fromSource: sourceRepo, cliBridge: "none" });
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { cli_targets: Record<string, true> };
    expect(Object.keys(cfg.cli_targets).length).toBe(0);
  });
});

describe("init — --upgrade preservation (CRITICAL gate for M1.10)", () => {
  it("preserves knowledge.db, USER.md, config.json byte-for-byte across upgrade", async () => {
    const { runInit } = await import("../verbs/init.js");
    // First, do a fresh init to set up brain.
    expect(await runInit({ fromSource: sourceRepo })).toBe(0);

    // Replace USER.md and config.json with deterministic test content.
    const userBytes = Buffer.from("user-md test content\nline 2\n");
    const cfgBytes = Buffer.from(
      JSON.stringify(
        {
          version: "7.0.0",
          installed_at: "2026-01-01T00:00:00Z",
          subconscious: { enabled: true }, // user changed default
          cli_targets: { claude: true, codex: true },
          remote_brain: { url: "https://example.com", api_key: "secret" },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(brainRoot, "USER.md"), userBytes);
    writeFileSync(join(brainRoot, "config.json"), cfgBytes);

    // Mutate the DB (insert a row to give it non-trivial bytes).
    const reg = await import("../lib/registry.js");
    reg.upsertProject({
      slug: "test-project",
      name: "test-project",
      path: "/tmp/foo",
      tech_stack: "go",
      igris_version: "7.0.0",
    });
    reg.closeDb();
    const dbBytes = readFileSync(join(brainRoot, "memory", "knowledge.db"));

    // Modify source to ensure the swap is non-trivial.
    writeFileSync(
      join(sourceRepo, "core", "SOUL.md"),
      "# soul (upgraded version)\n",
    );

    // Run --upgrade.
    const code = await runInit({
      fromSource: sourceRepo,
      upgrade: true,
    });
    expect(code).toBe(0);

    // Verify all three user-state files are byte-identical.
    expect(readFileSync(join(brainRoot, "USER.md")).equals(userBytes)).toBe(
      true,
    );
    expect(readFileSync(join(brainRoot, "config.json")).equals(cfgBytes)).toBe(
      true,
    );
    expect(readFileSync(join(brainRoot, "memory", "knowledge.db")).equals(dbBytes)).toBe(
      true,
    );

    // Core itself was upgraded.
    expect(readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8")).toBe(
      "# soul (upgraded version)\n",
    );
  });

  it("--upgrade also creates a core.bak.<ts>/ next to core/", async () => {
    const { runInit } = await import("../verbs/init.js");
    await runInit({ fromSource: sourceRepo });
    await runInit({ fromSource: sourceRepo, upgrade: true });
    const baks = require("node:fs")
      .readdirSync(brainRoot)
      .filter((e: string) => e.startsWith("core.bak."));
    expect(baks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("init — error paths", () => {
  it("errors when --upgrade is passed but no existing install", async () => {
    const { runInit } = await import("../verbs/init.js");
    const code = await runInit({ fromSource: sourceRepo, upgrade: true });
    expect(code).toBe(1);
  });

  it("errors when an existing v7 install is present without --upgrade", async () => {
    const { runInit } = await import("../verbs/init.js");
    expect(await runInit({ fromSource: sourceRepo })).toBe(0);
    expect(await runInit({ fromSource: sourceRepo })).toBe(1);
  });

  it("errors when --from-source path's core/ is missing", async () => {
    const { runInit } = await import("../verbs/init.js");
    const empty = join(workDir, "empty-repo");
    mkdirSync(empty, { recursive: true });
    const code = await runInit({ fromSource: empty });
    expect(code).toBe(1);
  });
});

describe("init — --dry-run", () => {
  it("--dry-run on fresh init prints plan and writes nothing", async () => {
    const { runInit } = await import("../verbs/init.js");
    const code = await runInit({
      fromSource: sourceRepo,
      dryRun: true,
    });
    expect(code).toBe(0);
    // Brain root should NOT be populated (dry-run wrote nothing).
    expect(existsSync(join(brainRoot, "core"))).toBe(false);
    expect(existsSync(join(brainRoot, "USER.md"))).toBe(false);
    expect(existsSync(join(brainRoot, "config.json"))).toBe(false);
    expect(existsSync(join(brainRoot, ".install-source.json"))).toBe(false);
  });
});
