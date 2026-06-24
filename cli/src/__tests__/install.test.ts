/**
 * install verb tests — Phase 2 (M2).
 *
 * Per architect's prior-mistake guidance: do NOT vi.mock the module under test.
 * We test against a real tmp filesystem + real :memory:-style sandboxed DB
 * (IGRIS_BRAIN_DIR) + skipSymlinkLayer flag for hermetic tests that don't need
 * to exercise the symlink/CLAUDE.md/.igris_version pipeline. A separate set of
 * "with symlink layer" tests stages a brain core in tmp and asserts that the
 * native TS calls (symlinks.ts, claude-md.ts, igris-version.ts) produce the
 * correct artifacts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
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

const TEMPLATE = `# Igris AI - Project Instructions

Igris v{{IGRIS_VERSION}}
Installed: {{INSTALL_DATE}}
`;

function stageBrain(): void {
  const hooksDir = join(tmpRoot, "core", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    join(hooksDir, "canonical-settings.json"),
    JSON.stringify(CANONICAL_HOOKS, null, 2) + "\n",
  );
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
}

function stageBrainWithCore(): void {
  stageBrain();
  // Agents
  const agentsDir = join(tmpRoot, "core", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "architect.md"), "# architect\n");
  writeFileSync(join(agentsDir, "forger.md"), "# forger\n");
  writeFileSync(join(agentsDir, "manifest.yaml"), "agents: []\n");

  // OS (FR-187: the layered core/os/ set replaces the retired universal rule).
  const osDir = join(tmpRoot, "core", "os");
  mkdirSync(osDir, { recursive: true });
  writeFileSync(join(osDir, "INDEX.md"), "# Igris OS — Module Index\n");
  writeFileSync(join(osDir, "standards.md"), "# Universal Standards\n");

  // Skills (each is a directory)
  const huntDir = join(tmpRoot, "core", "skills", "hunt");
  mkdirSync(huntDir, { recursive: true });
  writeFileSync(join(huntDir, "SKILL.md"), "# hunt\n");
  const scanDir = join(tmpRoot, "core", "skills", "scan");
  mkdirSync(scanDir, { recursive: true });
  writeFileSync(join(scanDir, "SKILL.md"), "# scan\n");

  // CLAUDE.md template
  const tmplDir = join(tmpRoot, "core", "templates");
  mkdirSync(tmplDir, { recursive: true });
  writeFileSync(join(tmplDir, "CLAUDE.md.tmpl"), TEMPLATE);
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

describe("install verb — materialized layer (skipSymlinkLayer)", () => {
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
    const path = await import("node:path");
    expect(rows[0].slug).toBe(path.basename(projectDir));
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
    process.env.IGRIS_KEEP_BAK = "0";
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
    const bakContent = JSON.parse(
      readFileSync(join(claudeDir, baks[0]), "utf-8"),
    ) as Record<string, unknown>;
    expect(bakContent.permissions).toBeDefined();
    expect(bakContent.hooks).toBeUndefined();

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

// ---------------------------------------------------------------------
// TD-112: --slug ≠ basename(path) hint (M2 reworded — "no action required").
// ---------------------------------------------------------------------

describe("install verb — TD-112 slug-mismatch hint (M2 reworded)", () => {
  function captureStderr(): { read: () => string; restore: () => void } {
    const buf: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((chunk: any) => {
        buf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    return {
      read: () => buf.join(""),
      restore: () => spy.mockRestore(),
    };
  }

  it("--slug differs from basename → stderr contains 'differs from directory name' note", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const cap = captureStderr();
    try {
      const code = await runInstall({
        path: projectDir,
        slug: "explicit-slug-foo",
        installHooks: true,
        skipSymlinkLayer: true,
      });
      expect(code).toBe(0);
      const stderr = cap.read();
      const path = await import("node:path");
      const expectedBasename = path.basename(projectDir);
      expect(stderr).toContain(
        `slug 'explicit-slug-foo' differs from directory name '${expectedBasename}'`,
      );
      expect(stderr).toContain("no action required");
      expect(stderr).toContain("authoritative");
    } finally {
      cap.restore();
    }
  });

  it("--slug equals basename → stderr does NOT contain the note", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const cap = captureStderr();
    try {
      const path = await import("node:path");
      const matchingSlug = path.basename(projectDir);
      const code = await runInstall({
        path: projectDir,
        slug: matchingSlug,
        installHooks: true,
        skipSymlinkLayer: true,
      });
      expect(code).toBe(0);
      const stderr = cap.read();
      expect(stderr).not.toContain("differs from directory name");
    } finally {
      cap.restore();
    }
  });

  it("no --slug (basename-defaulted) → stderr does NOT contain the note", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const cap = captureStderr();
    try {
      const code = await runInstall({
        path: projectDir,
        installHooks: true,
        skipSymlinkLayer: true,
      });
      expect(code).toBe(0);
      const stderr = cap.read();
      expect(stderr).not.toContain("differs from directory name");
    } finally {
      cap.restore();
    }
  });

  it("--slug differs from basename under --quiet → note is suppressed", async () => {
    const log = await import("../lib/log.js");
    const original = log.getVerbosity();
    log.setVerbosity("quiet");
    const cap = captureStderr();
    try {
      const { runInstall } = await import("../verbs/install.js");
      const code = await runInstall({
        path: projectDir,
        slug: "quiet-explicit-slug",
        installHooks: true,
        skipSymlinkLayer: true,
      });
      expect(code).toBe(0);
      const stderr = cap.read();
      expect(stderr).not.toContain("differs from directory name");
    } finally {
      cap.restore();
      log.setVerbosity(original);
    }
  });
});

// ---------------------------------------------------------------------
// M2.6 / M2.10: native symlink layer + CLAUDE.md regen + .igris_version.
// These tests stage a full brain core in tmp and assert the install verb
// produces the correct artifacts WITHOUT shelling out.
// ---------------------------------------------------------------------

describe("install verb — native symlink layer (M2.6)", () => {
  beforeEach(() => {
    stageBrainWithCore();
  });

  it("creates .claude/agents/<file>.md symlinks pointing at brain agents", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({
      path: projectDir,
      installHooks: true,
      // skipSymlinkLayer NOT set — exercise the native symlink layer.
    });
    expect(code).toBe(0);

    const architectLink = join(projectDir, ".claude", "agents", "architect.md");
    expect(lstatSync(architectLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(architectLink)).toBe(
      join(tmpRoot, "core", "agents", "architect.md"),
    );

    const forgerLink = join(projectDir, ".claude", "agents", "forger.md");
    expect(lstatSync(forgerLink).isSymbolicLink()).toBe(true);

    const manifestLink = join(projectDir, ".claude", "agents", "manifest.yaml");
    expect(lstatSync(manifestLink).isSymbolicLink()).toBe(true);
  });

  it("does NOT create a .claude/rules/ symlink layer (FR-187: universal rule retired)", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({
      path: projectDir,
      installHooks: true,
    });
    expect(code).toBe(0);

    // The universal rule (and its symlink layer) was retired under FR-187;
    // its baseline moved into core/os/standards.md. Install no longer
    // materializes a .claude/rules/ directory.
    expect(existsSync(join(projectDir, ".claude", "rules"))).toBe(false);
  });

  it("creates .claude/skills/<skill>/ symlinks for each skill dir", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({
      path: projectDir,
      installHooks: true,
    });
    expect(code).toBe(0);

    for (const slug of ["hunt", "scan"]) {
      const link = join(projectDir, ".claude", "skills", slug);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(
        join(tmpRoot, "core", "skills", slug),
      );
      // Through the symlink, can read SKILL.md.
      expect(existsSync(join(link, "SKILL.md"))).toBe(true);
    }
  });

  it("regenerates CLAUDE.md with version + date substituted", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({
      path: projectDir,
      installHooks: true,
      cliVersion: "7.0.0",
      installDate: "2026-05-07",
    });
    expect(code).toBe(0);

    const claudeMd = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("Igris v7.0.0");
    expect(claudeMd).toContain("Installed: 2026-05-07");
    expect(claudeMd).not.toContain("{{IGRIS_VERSION}}");
  });

  it("writes .igris_version with brain_path = IGRIS_BRAIN_DIR", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({
      path: projectDir,
      installHooks: true,
      cliVersion: "7.0.0",
    });
    expect(code).toBe(0);

    const versionFile = JSON.parse(
      readFileSync(join(projectDir, ".igris_version"), "utf-8"),
    ) as { brain_path: string; igris_ai_version: string };
    expect(versionFile.brain_path).toBe(tmpRoot);
    expect(versionFile.igris_ai_version).toBe("7.0.0");
  });

  it("re-install is idempotent: symlinks unchanged, CLAUDE.md regenerated stably", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const code1 = await runInstall({
      path: projectDir,
      installHooks: true,
      cliVersion: "7.0.0",
      installDate: "2026-05-07",
    });
    expect(code1).toBe(0);

    const claudeMd1 = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8");
    const ino1 = lstatSync(join(projectDir, ".claude", "agents", "architect.md")).ino;

    process.env.IGRIS_KEEP_BAK = "0";
    const code2 = await runInstall({
      path: projectDir,
      installHooks: true,
      cliVersion: "7.0.0",
      installDate: "2026-05-07",
    });
    expect(code2).toBe(0);

    const claudeMd2 = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd2).toBe(claudeMd1);

    // Symlink inode must match — no replacement occurred.
    const ino2 = lstatSync(join(projectDir, ".claude", "agents", "architect.md")).ino;
    expect(ino2).toBe(ino1);
  });
});

// ---------------------------------------------------------------------
// M2 — installed_features.json schema v2.
// ---------------------------------------------------------------------

describe("install verb — schema v2 (brain_channel + brain_ref)", () => {
  it("writes schema_version=2 with brain_channel/brain_ref defaulting to null when no install-source", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const ifs = await import("../lib/installed-features.js");

    const code = await runInstall({
      path: projectDir,
      installHooks: true,
      skipSymlinkLayer: true,
      cliVersion: "7.0.0",
    });
    expect(code).toBe(0);

    const path = await import("node:path");
    const slug = path.basename(projectDir);
    const feats = ifs.readInstalledFeatures(slug);
    expect(feats).not.toBeNull();
    expect(feats!.schema_version).toBe(2);
    // No .install-source.json staged → both null.
    expect(feats!.brain_channel).toBe(null);
    expect(feats!.brain_ref).toBe(null);
  });

  it("propagates brain_channel/brain_ref from .install-source.json when present", async () => {
    // Stage .install-source.json
    const installSource = {
      schema_version: 1,
      channel: "release",
      ref: "v7.0.0",
      fetched_at: "2026-05-06T00:00:00Z",
      content_sha256: "abc123",
      source: "github",
      source_path: null,
    };
    writeFileSync(
      join(tmpRoot, ".install-source.json"),
      JSON.stringify(installSource, null, 2) + "\n",
    );

    const { runInstall } = await import("../verbs/install.js");
    const ifs = await import("../lib/installed-features.js");

    const code = await runInstall({
      path: projectDir,
      installHooks: true,
      skipSymlinkLayer: true,
      cliVersion: "7.0.0",
    });
    expect(code).toBe(0);

    const path = await import("node:path");
    const slug = path.basename(projectDir);
    const feats = ifs.readInstalledFeatures(slug);
    expect(feats!.brain_channel).toBe("release");
    expect(feats!.brain_ref).toBe("v7.0.0");
  });
});
