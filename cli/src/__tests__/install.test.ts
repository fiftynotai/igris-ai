/**
 * install verb tests — Phase 2 (M2).
 *
 * Per architect's prior-mistake guidance: do NOT vi.mock the module under test.
 * We test against a real tmp filesystem + real :memory:-style sandboxed DB
 * (IGRIS_BRAIN_DIR) + skipSymlinkLayer flag for hermetic tests that don't need
 * to exercise the symlink/.igris_version pipeline. A separate set of
 * "with symlink layer" tests stages a brain core in tmp and asserts that the
 * native TS calls (symlinks.ts, igris-version.ts) produce the correct
 * artifacts. FR-191 retired the CLAUDE.md render — install writes no
 * identity file.
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

  // FR-191: no CLAUDE.md template is staged — the render machinery + its
  // template were retired; install writes no identity file.
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

// FR-212d Phase 2: `igris install` is register-only — the per-project
// settings.json hooks merge + the symlink layer + .igris_version were DELETED
// (hooks/skills/agents project GLOBALLY at `igris init`). The former
// "materialized layer" tests that asserted a per-project settings.json (vanilla
// hooks, .bak backup, includeGitInstructions preservation, fails-fast on a
// missing canonical-settings.json) were REMOVED — there is no per-project
// settings.json to assert. The register-only behavior (registry row + features
// file + slug handling + no per-project artifacts) is covered here + in the
// "register-only (FR-212d)" describe below.
describe("install verb — register-only registry + features", () => {
  it("install never writes a per-project settings.json (hooks are global now)", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({ path: projectDir, installHooks: true });
    expect(code).toBe(0);
    // No per-project settings.json under the register-only model.
    expect(existsSync(join(projectDir, ".claude", "settings.json"))).toBe(false);
  });

  it("--no-hooks is a no-op but still creates registry row + features file", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const reg = await import("../lib/registry.js");
    const ifs = await import("../lib/installed-features.js");

    const code = await runInstall({ path: projectDir, installHooks: false });
    expect(code).toBe(0);

    const settingsPath = join(projectDir, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(false);

    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    const slug = rows[0].slug;

    const feats = ifs.readInstalledFeatures(slug);
    expect(feats).not.toBeNull();
    // --no-hooks → the features file's hooks_version is null (no hooks hashed).
    expect(feats!.hooks_version).toBe(null);
  });

  it("slug defaults to basename when --slug omitted", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const reg = await import("../lib/registry.js");
    const code = await runInstall({ path: projectDir, installHooks: true });
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
    });
    expect(code).toBe(0);
    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe("fifty-dev");
    expect(rows[0].path).toBe(projectDir);
  });

  it("re-install is idempotent (no duplicate rows)", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const reg = await import("../lib/registry.js");
    const code1 = await runInstall({
      path: projectDir,
      slug: "alpha",
      installHooks: true,
    });
    expect(code1).toBe(0);

    const code2 = await runInstall({
      path: projectDir,
      slug: "alpha",
      installHooks: true,
    });
    expect(code2).toBe(0);
    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
  });

  it("re-install with new --slug for same path leaves both registry rows (orphan-resolution belongs to doctor)", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const reg = await import("../lib/registry.js");
    await runInstall({ path: projectDir, slug: "old-slug", installHooks: true });
    await runInstall({ path: projectDir, slug: "new-slug", installHooks: true });
    const slugs = reg.listProjects().map((r) => r.slug).sort();
    expect(slugs).toEqual(["new-slug", "old-slug"]);
  });

  it("install on missing path returns exit 1", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({
      path: "/this/path/should/not/exist/12345",
      installHooks: true,
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
      }),
    ).rejects.toThrow(/Invalid slug/);
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

// FR-212d Phase 2: the "native symlink layer (M2.6)" describe was DELETED — the
// per-project `.claude/{agents,skills}` symlink layer + `.igris_version` writer
// were removed (skills/agents project globally at `igris init`). The FR-191
// "no project CLAUDE.md" + FR-187 "no .claude/rules/" absence assertions are
// subsumed by the register-only "creates NO .claude/ symlinks" test below — with
// no per-project materialization at all, those artifacts can never appear.

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

// ---------------------------------------------------------------------
// FR-212c — REGISTER-ONLY default install.
//
// The default `igris install` reduces to BRAIN REGISTRATION: NO per-project
// .claude/ symlinks, NO per-project settings.json, NO .igris_version. The
// registry row IS upserted (that row de-no-ops the globally-projected hooks).
// The legacy per-project layer is reachable ONLY via legacyPerProject:true.
// ---------------------------------------------------------------------

describe("install verb — register-only (FR-212d)", () => {
  beforeEach(() => {
    // Stage a full brain core so a (former) symlink layer WOULD have sources to
    // link (proving register-only does NOT link, not that it has nothing to).
    stageBrainWithCore();
  });

  it("default install creates NO .claude/ symlinks, NO settings.json, NO .igris_version", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const code = await runInstall({
      path: projectDir,
      installHooks: true, // even with hooks ON, register-only writes no settings.json
      // legacyPerProject NOT set -> register-only default.
    });
    expect(code).toBe(0);

    // No per-project symlink layer.
    expect(existsSync(join(projectDir, ".claude", "agents"))).toBe(false);
    expect(existsSync(join(projectDir, ".claude", "skills"))).toBe(false);
    // No per-project settings.json hooks merge.
    expect(existsSync(join(projectDir, ".claude", "settings.json"))).toBe(false);
    // No per-project version marker.
    expect(existsSync(join(projectDir, ".igris_version"))).toBe(false);
  });

  it("default install DOES upsert the registry row + writes installed_features.json", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const reg = await import("../lib/registry.js");
    const ifs = await import("../lib/installed-features.js");

    const code = await runInstall({
      path: projectDir,
      slug: "reg-only",
      installHooks: true,
    });
    expect(code).toBe(0);

    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe("reg-only");
    expect(rows[0].path).toBe(projectDir);

    // installed_features.json is still written (upgrade-detection survives).
    const feats = ifs.readInstalledFeatures("reg-only");
    expect(feats).not.toBeNull();
    expect(feats!.schema_version).toBe(2);
  });

  // FR-212d Phase 2: the "legacy flag re-enables the per-project layer" test was
  // DELETED — `--legacy-per-project` and the entire per-project materialization
  // path (symlinks + settings.json + .igris_version) were removed. Install is
  // register-only with no opt-back-in.

  it("default --dry-run plans NO symlinks / settings.json / .igris_version", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const logMod = await import("../lib/log.js");
    const lines: string[] = [];
    const spy = vi
      .spyOn(logMod, "info")
      .mockImplementation((msg?: unknown) => {
        if (typeof msg === "string") lines.push(msg);
      });
    try {
      const code = await runInstall({
        path: projectDir,
        installHooks: true,
        dryRun: true,
      });
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const plan = lines.join("\n");
    // The register-only plan mentions the registry upsert but NOT the legacy
    // per-project artifacts.
    expect(plan).not.toMatch(/\.igris_version/);
    expect(plan).not.toMatch(/symlink to/);
    expect(plan).not.toMatch(/merge canonical hooks block/);
  });
});
