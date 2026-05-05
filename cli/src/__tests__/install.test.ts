/**
 * install verb tests — Phase 4.
 *
 * Per architect's prior-mistake guidance: do NOT vi.mock the module under test.
 * We test against a real tmp filesystem + real :memory:-style sandboxed DB
 * (IGRIS_BRAIN_DIR) + skipSymlinkLayer flag to bypass the shell-script invoke
 * (the supported boundary; integration tests in bats exercise the wrapper).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
let projectDir: string;

const CANONICAL_HOOKS = {
  hooks: {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: "$HOME/.igris/core/hooks/shared/session_start.sh",
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: "command",
            command: "$HOME/.igris/core/hooks/shared/session_end.sh",
          },
        ],
      },
    ],
    PreCompact: [
      {
        hooks: [
          {
            type: "command",
            command: "$HOME/.igris/core/hooks/shared/pre_compact.sh",
          },
        ],
      },
    ],
    PostCompact: [
      {
        hooks: [
          {
            type: "command",
            command: "$HOME/.igris/core/hooks/shared/post_compact.sh",
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: "Write|Edit",
        hooks: [
          {
            type: "command",
            command: "$HOME/.igris/core/hooks/shared/pre_tool_use.sh",
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "Write|Edit",
        hooks: [
          {
            type: "command",
            command: "$HOME/.igris/core/hooks/shared/post_tool_use.sh",
            timeout: 20,
          },
        ],
      },
    ],
  },
};

function stageBrain(): void {
  const hooksDir = join(tmpRoot, "core", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    join(hooksDir, "canonical-settings.json"),
    JSON.stringify(CANONICAL_HOOKS, null, 2) + "\n",
  );
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
}

function stageProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "igris-cli-install-proj-"));
  // Pre-create .claude/ so install can drop settings.json into it.
  mkdirSync(join(dir, ".claude"), { recursive: true });
  return dir;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-install-brain-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  stageBrain();
  projectDir = stageProject();
  // Ensure caches are fresh per test.
  const ch = await import("../lib/canonical-hooks.js");
  ch.clearCache();
  const reg = await import("../lib/registry.js");
  reg.closeDb();
});

afterEach(async () => {
  const reg = await import("../lib/registry.js");
  reg.closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
  delete process.env.IGRIS_KEEP_BAK;
});

describe("install verb", () => {
  it("vanilla install installs hooks (regression for v6 silent-failure)", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({
      path: projectDir,
      installHooks: true,
      skipSymlinkLayer: true,
    });
    expect(code).toBe(0);

    const settings = JSON.parse(
      readFileSync(join(projectDir, ".claude", "settings.json"), "utf-8"),
    ) as { hooks: Record<string, unknown[]> };
    expect(settings.hooks).toBeDefined();
    const sessionEnd = settings.hooks.SessionEnd as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(sessionEnd[0].hooks[0].command).toBe(
      "$HOME/.igris/core/hooks/shared/session_end.sh",
    );
  });

  it("--no-hooks omits hooks block but still creates registry row + features file", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const reg = await import("../lib/registry.js");
    const ifs = await import("../lib/installed-features.js");

    const code = await runInstall({
      path: projectDir,
      installHooks: false,
      skipSymlinkLayer: true,
    });
    expect(code).toBe(0);

    const settingsPath = join(projectDir, ".claude", "settings.json");
    // No settings.json means we did NOT touch hooks. (Some flows pre-create it
    // via the symlink layer; here we skipped that, so the file should not exist.)
    expect(existsSync(settingsPath)).toBe(false);

    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    const slug = rows[0].slug;

    const feats = ifs.readInstalledFeatures(slug);
    expect(feats).not.toBeNull();
    expect(feats!.hooks_version).toBe(null);
  });

  it("slug defaults to basename when --slug omitted", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const reg = await import("../lib/registry.js");
    const code = await runInstall({
      path: projectDir,
      installHooks: true,
      skipSymlinkLayer: true,
    });
    expect(code).toBe(0);
    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe(require("node:path").basename(projectDir));
  });

  it("explicit --slug differs from basename — registry row keyed by slug, path is absolute", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const reg = await import("../lib/registry.js");
    const code = await runInstall({
      path: projectDir,
      slug: "fifty-dev",
      installHooks: true,
      skipSymlinkLayer: true,
    });
    expect(code).toBe(0);
    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe("fifty-dev");
    expect(rows[0].path).toBe(projectDir);
  });

  it("re-install is idempotent (no duplicate rows; settings.json stable)", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const reg = await import("../lib/registry.js");
    process.env.IGRIS_KEEP_BAK = "0"; // disable .bak files for clean comparison
    const code1 = await runInstall({
      path: projectDir,
      slug: "alpha",
      installHooks: true,
      skipSymlinkLayer: true,
    });
    expect(code1).toBe(0);
    const settings1 = readFileSync(
      join(projectDir, ".claude", "settings.json"),
      "utf-8",
    );

    const code2 = await runInstall({
      path: projectDir,
      slug: "alpha",
      installHooks: true,
      skipSymlinkLayer: true,
    });
    expect(code2).toBe(0);
    const settings2 = readFileSync(
      join(projectDir, ".claude", "settings.json"),
      "utf-8",
    );
    expect(settings2).toBe(settings1);
    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
  });

  it("re-install with new --slug for same path leaves both registry rows (orphan-resolution belongs to doctor)", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const reg = await import("../lib/registry.js");
    await runInstall({
      path: projectDir,
      slug: "old-slug",
      installHooks: true,
      skipSymlinkLayer: true,
    });
    await runInstall({
      path: projectDir,
      slug: "new-slug",
      installHooks: true,
      skipSymlinkLayer: true,
    });
    const slugs = reg.listProjects().map((r) => r.slug).sort();
    expect(slugs).toEqual(["new-slug", "old-slug"]);
  });

  it("install fails fast on missing canonical-settings.json with actionable error", async () => {
    // Remove canonical to trigger the missing-file error.
    rmSync(join(tmpRoot, "core", "hooks", "canonical-settings.json"));
    const ch = await import("../lib/canonical-hooks.js");
    ch.clearCache();

    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({
      path: projectDir,
      installHooks: true,
      skipSymlinkLayer: true,
    });
    expect(code).toBe(1);
  });

  it("install backs up settings.json to .bak.<timestamp> before merging", async () => {
    // Pre-stage a settings.json with non-hooks keys.
    const settingsPath = join(projectDir, ".claude", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Bash(echo:*)"] } }) + "\n",
    );

    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({
      path: projectDir,
      installHooks: true,
      skipSymlinkLayer: true,
    });
    expect(code).toBe(0);

    const claudeDir = join(projectDir, ".claude");
    const entries = readdirSync(claudeDir);
    const baks = entries.filter((e) => e.startsWith("settings.json.bak."));
    expect(baks.length).toBe(1);
    // .bak is the original (with permissions key, no hooks).
    const bakContent = JSON.parse(
      readFileSync(join(claudeDir, baks[0]), "utf-8"),
    ) as Record<string, unknown>;
    expect(bakContent.permissions).toBeDefined();
    expect(bakContent.hooks).toBeUndefined();

    // The merged settings.json has both.
    const merged = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(merged.permissions).toBeDefined();
    expect(merged.hooks).toBeDefined();
  });

  it("IGRIS_KEEP_BAK=0 disables .bak creation", async () => {
    process.env.IGRIS_KEEP_BAK = "0";
    const settingsPath = join(projectDir, ".claude", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Bash(echo:*)"] } }) + "\n",
    );
    const { runInstall } = await import("../verbs/install.js");
    await runInstall({
      path: projectDir,
      installHooks: true,
      skipSymlinkLayer: true,
    });
    const baks = readdirSync(join(projectDir, ".claude")).filter((e) =>
      e.startsWith("settings.json.bak."),
    );
    expect(baks.length).toBe(0);
  });

  it("install on missing path returns exit 1", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({
      path: "/this/path/should/not/exist/12345",
      installHooks: true,
      skipSymlinkLayer: true,
    });
    expect(code).toBe(1);
  });

  it("install rejects invalid slug", async () => {
    const { runInstall } = await import("../verbs/install.js");
    await expect(
      runInstall({
        path: projectDir,
        slug: "Invalid Slug!",
        installHooks: true,
        skipSymlinkLayer: true,
      }),
    ).rejects.toThrow(/Invalid slug/);
  });

  it("install with includeGitInstructions:false in pre-existing settings.json preserves that key", async () => {
    const settingsPath = join(projectDir, ".claude", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ includeGitInstructions: false }) + "\n",
    );
    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({
      path: projectDir,
      installHooks: true,
      skipSymlinkLayer: true,
    });
    expect(code).toBe(0);
    const merged = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(merged.includeGitInstructions).toBe(false);
    expect(merged.hooks).toBeDefined();
  });
});
