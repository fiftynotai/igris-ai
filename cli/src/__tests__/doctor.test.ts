/**
 * doctor tests — Phase 6 (+ FR-212d register-only / global-surfaces update).
 *
 * Drift classification: one fixture per drift class, each asserting the expected
 * `DriftRow.driftClass`. --fix and --remove-orphans exercised via runDoctor
 * returning the right exit code. FR-212d: install is register-only (no
 * per-project `.claude/`), and hooks are a brain-level GLOBAL check — the suite
 * sandboxes HOME with a clean baseline (valid global hooks + claude.json +
 * opt-out config) so the brain-level rows don't fire spuriously.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
/** Sandboxed HOME so claudeJsonPath() (used by the mcp-unregistered
 *  drift check, TD-168) resolves into a tmp dir, not the real ~. */
let homeOverride: string;
let homeBackup: string | undefined;
const projectDirs: string[] = [];

const CANONICAL_HOOKS = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: "$HOME/.igris/core/hooks/shared/session_start.sh" }] },
    ],
    SessionEnd: [
      { hooks: [{ type: "command", command: "$HOME/.igris/core/hooks/shared/session_end.sh" }] },
    ],
    PreCompact: [
      { hooks: [{ type: "command", command: "$HOME/.igris/core/hooks/shared/pre_compact.sh" }] },
    ],
    PostCompact: [
      { hooks: [{ type: "command", command: "$HOME/.igris/core/hooks/shared/post_compact.sh" }] },
    ],
    PreToolUse: [
      {
        matcher: "Write|Edit",
        hooks: [{ type: "command", command: "$HOME/.igris/core/hooks/shared/pre_tool_use.sh" }],
      },
    ],
    PostToolUse: [
      {
        matcher: "Write|Edit",
        hooks: [
          { type: "command", command: "$HOME/.igris/core/hooks/shared/post_tool_use.sh", timeout: 20 },
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

/**
 * Write a valid `~/.claude.json` (in the sandboxed HOME) with the
 * igris-brain MCP registered pointing at a real on-disk file. Keeps
 * the existing exit-code tests free of the TD-168 mcp-unregistered
 * drift row. The mcp-unregistered tests explicitly skip this.
 *
 * TD-220: chmod 600 so the new `secret-perms` drift class does NOT flag
 * this staged harness config — writeFileSync produces 644 under the default
 * umask, which would trip the read-pass exit-code tests below. A real post-
 * TD-220 install keeps ~/.claude.json at 600, so 600 is the correct baseline.
 */
function stageValidClaudeJson(): void {
  const mcpFile = join(tmpRoot, "fake-bundled-mcp.js");
  writeFileSync(mcpFile, "// fake bundled mcp\n");
  const claudeJson = join(homeOverride, ".claude.json");
  writeFileSync(
    claudeJson,
    JSON.stringify(
      {
        mcpServers: {
          "igris-brain": {
            type: "stdio",
            command: "node",
            args: [mcpFile],
            env: {},
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  chmodSync(claudeJson, 0o600);
}

/**
 * FR-212d (register-only): `igris install` no longer writes a per-project
 * `.claude/` layer — a registered project whose path exists is CLEAN. Stage a
 * bare project dir (no `.claude/`) to exercise the real register-only path. The
 * `.claude/` arg exists only for the few tests that still stage per-project
 * scaffolding for unrelated reasons (none currently need it).
 */
function stageProject(name = "proj"): string {
  const dir = mkdtempSync(join(tmpdir(), `igris-cli-doctor-${name}-`));
  projectDirs.push(dir);
  return dir;
}

/**
 * FR-212d: write a valid GLOBAL `~/.claude/settings.json` (in the sandboxed
 * HOME) carrying the canonical Igris hooks. Under the global-projection model
 * the Igris hooks live in ONE user-level settings block, so the new brain-level
 * `hooks-missing`/`hooks-stale` drift check (detectGlobalHooksDrift) reads this
 * file. The sandboxed HOME starts WITHOUT it, which would make every test trip a
 * brain-level `hooks-missing` row — so the baseline stages it. Tests that
 * exercise hooks-missing/hooks-stale mutate or remove it in their own setup.
 */
function stageValidGlobalHooks(): void {
  const settingsDir = join(homeOverride, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    JSON.stringify(CANONICAL_HOOKS, null, 2) + "\n",
  );
}

/**
 * FR-212d: write an explicit-opt-out `~/.igris/config.json` (`cli_targets: {}`)
 * under the sandbox brain dir so the bridge-missing detector never fires from
 * the staged `~/.claude/` config dir (created by stageValidGlobalHooks) when a
 * real `claude` binary is on the dev machine's PATH. `detectBridgeMissing`
 * treats an explicitly-empty `cli_targets` as user opt-out → no rows, PATH-
 * independent (hermetic). Set at 600 so it doesn't also trip secret-perms.
 */
function stageOptOutConfig(): void {
  const cfg = join(tmpRoot, "config.json");
  writeFileSync(cfg, JSON.stringify({ version: "7.0.0", cli_targets: {} }) + "\n");
  chmodSync(cfg, 0o600);
}

/**
 * TD-220: `runInstall` registers the igris-brain MCP across all Igris harnesses,
 * which the FR-162/163 mergers write via tmp+renameSync at the umask-default
 * mode (644) — Risk R1. A no-`--fix` doctor read pass would then flag those
 * harness configs as `secret-perms` (harness-owned, loose). Tests that install
 * a project and assert a CLEAN read-pass exit must harden the harness configs
 * to 600 first — representing a machine where `igris doctor --fix` (or a
 * future R1 follow-up) has already tightened them. This is the L-331 self-heal
 * for the pre-TD-220 "clean = exit 0" assertion.
 */
function hardenStagedHarnessConfigs(): void {
  for (const p of [
    join(homeOverride, ".claude.json"),
    join(homeOverride, ".gemini", "settings.json"),
    join(homeOverride, ".codex", "config.toml"),
    join(homeOverride, ".config", "opencode", "opencode.json"),
  ]) {
    try {
      chmodSync(p, 0o600);
    } catch {
      // Absent harness config — nothing to harden.
    }
  }
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-doctor-brain-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  // Sandbox HOME so the TD-168 mcp-unregistered check (claudeJsonPath()
  // -> ~/.claude.json) resolves into tmp. Without this, the check would
  // read the developer's real ~/.claude.json and tests would be
  // non-hermetic. By default the sandboxed home has no .claude.json, so
  // mcp-unregistered DOES fire; tests that need it absent register a
  // valid entry in their own setup.
  homeOverride = join(tmpRoot, "home");
  mkdirSync(homeOverride, { recursive: true });
  homeBackup = process.env.HOME;
  process.env.HOME = homeOverride;
  stageBrain();
  stageValidClaudeJson();
  // FR-212d: stage a valid GLOBAL ~/.claude/settings.json so the new
  // brain-level hooks-missing/hooks-stale check has a clean baseline. Tests
  // that exercise those classes mutate/remove it.
  stageValidGlobalHooks();
  // FR-212d: staging ~/.claude/ above (the global-hooks parent) makes
  // detectInstalledCLIs treat claude as "detected" whenever a real `claude` is
  // on the dev machine's PATH (config-dir + PATH = detected) — which would make
  // the bridge-missing detector fire spuriously (config.json lacks claude). Seed
  // an EXPLICIT-opt-out config.json (`cli_targets: {}`) so bridge-missing never
  // fires from the staged config dir, hermetically (independent of PATH). Tests
  // that need a different config.json overwrite it (preserving the opt-out).
  stageOptOutConfig();
  const ch = await import("../lib/canonical-hooks.js");
  ch.clearCache();
  const reg = await import("../lib/registry.js");
  reg.closeDb();
});

afterEach(async () => {
  const reg = await import("../lib/registry.js");
  reg.closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
  for (const d of projectDirs) rmSync(d, { recursive: true, force: true });
  projectDirs.length = 0;
  delete process.env.IGRIS_BRAIN_DIR;
  process.env.HOME = homeBackup;
});

describe("doctor — drift classification (read-only)", () => {
  it("clean: register-only install → driftClass=clean (FR-212d real path)", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");

    // FR-212d: stageProject is now a BARE dir (no pre-staged `.claude/`), so this
    // exercises the ACTUAL register-only `runInstall` — which writes NO
    // per-project `.claude/` layer. A registered project whose path exists must
    // classify `clean` even though `<project>/.claude` is absent. (Pre-fix this
    // test only passed because the fixture pre-created `.claude` — the masking
    // the warden flagged.)
    const proj = stageProject("clean");
    const slug = require("node:path").basename(proj);
    await runInstall({ path: proj, slug, installHooks: true });
    expect(existsSync(join(proj, ".claude"))).toBe(false); // register-only: no layer
    const drift = classifyDrift(reg.listProjects());
    expect(drift.length).toBe(1);
    expect(drift[0].driftClass).toBe("clean");
  });

  it("path-missing: registry row -> deleted dir", async () => {
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    reg.upsertProject({
      slug: "ghost",
      name: "ghost",
      path: "/path/does/not/exist/12345",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift.length).toBe(1);
    expect(drift[0].driftClass).toBe("path-missing");
  });

  it("FR-212d: a bare registered dir (no .claude/) is clean, NOT not-installed", async () => {
    // FR-212d retired the `not-installed` class — register-only install writes no
    // per-project `.claude/` layer, so its absence no longer means "not
    // installed". A registered row whose path exists is clean.
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const dir = mkdtempSync(join(tmpdir(), "igris-cli-doctor-bare-"));
    projectDirs.push(dir);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    // Slug = basename so slug-basename-mismatch (informational) doesn't mask the
    // clean verdict we're asserting.
    const slug = require("node:path").basename(dir);
    reg.upsertProject({
      slug,
      name: slug,
      path: dir,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift[0].driftClass).toBe("clean");
    // The retired class must never resurface.
    expect(drift.some((r) => r.driftClass === "not-installed")).toBe(false);
  });

  it("hooks-missing (brain-level): GLOBAL ~/.claude/settings.json lacks Igris SessionEnd", async () => {
    // FR-212d: hooks are global now — a SINGLE (brain) row, read from
    // ~/.claude/settings.json (NOT per-project). Overwrite the staged-valid
    // global settings with one lacking the Igris hooks.
    const { classifyDriftAll } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    writeFileSync(
      join(homeOverride, ".claude", "settings.json"),
      JSON.stringify({ includeGitInstructions: false }) + "\n",
    );
    const drift = await classifyDriftAll(reg.listProjects());
    const row = drift.find((r) => r.driftClass === "hooks-missing");
    expect(row).toBeDefined();
    expect(row!.slug).toBe("(brain)");
  });

  it("hooks-stale (brain-level): GLOBAL settings carry Igris hooks at a non-canonical path", async () => {
    const { classifyDriftAll } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    writeFileSync(
      join(homeOverride, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: "$HOME/.igris/core/hooks/old/session_end.sh",
                },
              ],
            },
          ],
        },
      }) + "\n",
    );
    const drift = await classifyDriftAll(reg.listProjects());
    const row = drift.find((r) => r.driftClass === "hooks-stale");
    expect(row).toBeDefined();
    expect(row!.slug).toBe("(brain)");
  });

  it("slug-basename-mismatch: row.slug != basename(row.path)", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const proj = stageProject("real");
    await runInstall({
      path: proj,
      slug: "totally-different-slug",
      installHooks: true,
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift[0].driftClass).toBe("slug-basename-mismatch");
  });

  it("duplicate-path: multiple slugs share realpath", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const proj = stageProject("dup");
    await runInstall({ path: proj, slug: "slug-one", installHooks: true });
    await runInstall({ path: proj, slug: "slug-two", installHooks: true });
    await runInstall({
      path: proj,
      slug: "slug-three",
      installHooks: true,
    });
    const drift = classifyDrift(reg.listProjects());
    // All three should be flagged as duplicate-path (precedence above slug-mismatch).
    const dupCount = drift.filter((r) => r.driftClass === "duplicate-path").length;
    expect(dupCount).toBe(3);
  });

  it("symlink-target: row.path is a symlink", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const real = stageProject("realtarget");
    const linkBase = mkdtempSync(join(tmpdir(), "igris-cli-doctor-linkbase-"));
    projectDirs.push(linkBase);
    const link = join(linkBase, "linked-proj");
    symlinkSync(real, link);
    // Install registers `real` as canonical, then we add a separate row for the symlink path.
    await runInstall({ path: real, slug: "real-target", installHooks: true });
    // Simulate someone registering the symlinked path under a different slug.
    reg.upsertProject({
      slug: "via-symlink",
      name: "via-symlink",
      path: link,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    // The symlink path resolves to `real`, so this row counts as duplicate-path
    // (precedence: duplicate-path > symlink-target). That's expected behavior:
    // in practice symlink-target only fires when the symlinked path does NOT
    // also have another row pointing at the same realpath. Test the standalone
    // symlink case below.
    const symlinkRow = drift.find((d) => d.slug === "via-symlink");
    expect(symlinkRow).toBeDefined();
    expect(symlinkRow!.driftClass).toBe("duplicate-path");
  });

  it("symlink-target standalone: lone symlink row → driftClass=symlink-target", async () => {
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const real = mkdtempSync(join(tmpdir(), "igris-cli-doctor-realonly-"));
    mkdirSync(join(real, ".claude"), { recursive: true });
    writeFileSync(
      join(real, ".claude", "settings.json"),
      JSON.stringify(CANONICAL_HOOKS) + "\n",
    );
    projectDirs.push(real);
    const linkBase = mkdtempSync(join(tmpdir(), "igris-cli-doctor-linkbase2-"));
    projectDirs.push(linkBase);
    const link = join(linkBase, "lone-link");
    symlinkSync(real, link);
    const slug = require("node:path").basename(link);
    reg.upsertProject({
      slug,
      name: slug,
      path: link,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift.length).toBe(1);
    expect(drift[0].driftClass).toBe("symlink-target");
  });
});

// ---------------------------------------------------------------------------
// TD-168: mcp-unregistered drift class. classifyDriftAll synthesizes a
// `(brain)`-slug row when ~/.claude.json lacks the igris-brain MCP entry
// (or it points at a missing file). The sandboxed HOME starts WITH a valid
// entry (stageValidClaudeJson in beforeEach), so these tests mutate it.
// ---------------------------------------------------------------------------
describe("doctor — mcp-unregistered drift class (TD-168)", () => {
  it("no mcp-unregistered row when ~/.claude.json has a valid igris-brain entry", async () => {
    const { classifyDriftAll } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    // beforeEach already staged a valid ~/.claude.json.
    const drift = await classifyDriftAll(reg.listProjects());
    expect(drift.some((r) => r.driftClass === "mcp-unregistered")).toBe(false);
  });

  it("yields a mcp-unregistered row when ~/.claude.json is absent", async () => {
    const { classifyDriftAll } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    // Remove the staged ~/.claude.json so the MCP is unregistered.
    rmSync(join(homeOverride, ".claude.json"), { force: true });
    const drift = await classifyDriftAll(reg.listProjects());
    const row = drift.find((r) => r.driftClass === "mcp-unregistered");
    expect(row).toBeDefined();
    expect(row!.slug).toBe("(brain)");
  });

  it("yields a mcp-unregistered row when the entry points at a missing file", async () => {
    const { classifyDriftAll } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    // Repoint the entry at a path that doesn't exist.
    writeFileSync(
      join(homeOverride, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "igris-brain": {
            type: "stdio",
            command: "node",
            args: ["/no/such/mcp/index.js"],
            env: {},
          },
        },
      }) + "\n",
    );
    const drift = await classifyDriftAll(reg.listProjects());
    expect(drift.some((r) => r.driftClass === "mcp-unregistered")).toBe(true);
  });

  it("--fix registers the igris-brain MCP into all Igris harnesses (FR-169)", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    const fs = require("node:fs");
    // Drop ~/.claude.json so mcp-unregistered fires. runInstall (via no
    // project) is not involved — the fix arm calls
    // registerBrainAcrossHarnesses() directly, which writes into the sandboxed
    // HOME pointing at the real bundled path (built in Phase 1 —
    // cli/dist/brain-mcp-server/...). FR-169: backfills all Igris harnesses.
    rmSync(join(homeOverride, ".claude.json"), { force: true });
    const code = await runDoctor({ fix: true, removeOrphans: false, yes: false });
    expect(code).toBe(0);

    // Claude — ~/.claude.json now has the igris-brain entry.
    const claude = JSON.parse(
      fs.readFileSync(join(homeOverride, ".claude.json"), "utf-8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(claude.mcpServers["igris-brain"]).toBeDefined();

    // Gemini — ~/.gemini/settings.json.
    const gemini = JSON.parse(
      fs.readFileSync(join(homeOverride, ".gemini", "settings.json"), "utf-8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(gemini.mcpServers["igris-brain"]).toBeDefined();

    // OpenCode — ~/.config/opencode/opencode.json.
    const opencode = JSON.parse(
      fs.readFileSync(
        join(homeOverride, ".config", "opencode", "opencode.json"),
        "utf-8",
      ),
    ) as { mcp: Record<string, unknown> };
    expect(opencode.mcp["igris-brain"]).toBeDefined();

    // Codex — ~/.codex/config.toml.
    const codexText = fs.readFileSync(
      join(homeOverride, ".codex", "config.toml"),
      "utf-8",
    ) as string;
    expect(codexText).toContain("[mcp_servers.igris-brain]");
  });
});

describe("doctor — runDoctor exit codes", () => {
  it("exits 0 on clean registry", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { runDoctor } = await import("../verbs/doctor.js");
    const proj = stageProject("clean2");
    await runInstall({
      path: proj,
      slug: require("node:path").basename(proj),
      installHooks: true,
    });
    // TD-220: install re-loosened the harness configs (R1); a genuinely
    // "clean" machine has them at 600. Harden so the read-pass stays clean.
    hardenStagedHarnessConfigs();
    const code = await runDoctor({ fix: false, removeOrphans: false, yes: false });
    expect(code).toBe(0);
  });

  it("exits 1 when the GLOBAL settings.json is missing the Igris hooks block (TD-100 silent-failure, FR-212d)", async () => {
    // FR-212d: the TD-100 silent-failure class is now GLOBAL — the Igris hooks
    // live in ONE `~/.claude/settings.json` block. Overwrite the staged-valid
    // global hooks with a settings file lacking the Igris SessionEnd hook so the
    // brain-level hooks-missing row fires → exit 1.
    const { runDoctor } = await import("../verbs/doctor.js");
    writeFileSync(
      join(homeOverride, ".claude", "settings.json"),
      JSON.stringify({ includeGitInstructions: false }) + "\n",
    );
    const code = await runDoctor({ fix: false, removeOrphans: false, yes: false });
    expect(code).toBe(1);
  });

  it("FR-165: warns (read-only) when an MCP ${VAR} resolves nowhere", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    const path = await import("node:path");
    // Unique VAR name guaranteed absent from process.env + the (absent)
    // sandboxed secrets.env (tmpRoot has none).
    const VAR = "IGRIS_FR165_MISSING_TOK_TEST";
    delete process.env[VAR];
    // Personal overlay with an MCP block carrying an unresolved env ref.
    const overlayPath = path.join(
      tmpRoot,
      "loadout",
      "harness-manifest.personal.json",
    );
    mkdirSync(path.dirname(overlayPath), { recursive: true });
    writeFileSync(
      overlayPath,
      JSON.stringify({
        version: 1,
        agents: [],
        surfaces: {
          mcp_servers: [
            {
              name: "needs-secret",
              canonical: {
                command: "node",
                args: [],
                env: { API_KEY: `\${${VAR}}` },
              },
              targets: [],
            },
          ],
        },
      }) + "\n",
    );

    const stderrChunks: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });
    try {
      // No projects registered; the only output of interest is the warning.
      await runDoctor({ fix: false, removeOrphans: false, yes: false });
    } finally {
      spy.mockRestore();
    }

    const out = stderrChunks.join("");
    // Names the VAR + server, never a value (there is none to leak).
    expect(out).toContain(VAR);
    expect(out).toContain("needs-secret");
    expect(out).toContain("warn:");
    // Read-only: the overlay we wrote must be byte-unchanged (no doctor write).
    const after = require("node:fs").readFileSync(overlayPath, "utf-8");
    expect(after).toContain(`\${${VAR}}`);
  });

  it("--fix repairs hooks-missing by refreshing the GLOBAL hooks (FR-212d)", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const { claudeUserSettingsPath } = await import("../lib/paths.js");
    const proj = stageProject("fixme");
    // Slug = basename so the project itself is clean (no informational
    // slug-basename-mismatch) — the only non-clean row must be hooks-missing.
    const slug = require("node:path").basename(proj);
    reg.upsertProject({
      slug,
      name: slug,
      path: proj,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    // FR-212d: hooks-missing is a brain-level row read from the GLOBAL
    // ~/.claude/settings.json. Overwrite the staged-valid global hooks with a
    // settings file that LACKS the Igris hooks so the row fires.
    writeFileSync(
      join(homeOverride, ".claude", "settings.json"),
      JSON.stringify({ includeGitInstructions: false }) + "\n",
    );
    const code = await runDoctor({ fix: true, removeOrphans: false, yes: false });
    expect(code).toBe(0);
    // FR-212d: the fix re-merges the canonical Igris hooks into the GLOBAL
    // `~/.claude/settings.json` (the live hooks surface now). HOME is sandboxed
    // in this suite so `claudeUserSettingsPath()` resolves into tmp.
    const settings = JSON.parse(
      require("node:fs").readFileSync(claudeUserSettingsPath(), "utf-8"),
    ) as { hooks: Record<string, unknown[]> };
    const sessionEnd = settings.hooks.SessionEnd as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(sessionEnd[0].hooks[0].command).toBe(
      "$HOME/.igris/core/hooks/shared/session_end.sh",
    );
  });

  it("--remove-orphans --yes deletes path-missing rows", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    reg.upsertProject({
      slug: "ghost1",
      name: "ghost1",
      path: "/no/such/dir/abc",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    reg.upsertProject({
      slug: "ghost2",
      name: "ghost2",
      path: "/no/such/dir/def",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const code = await runDoctor({ fix: false, removeOrphans: true, yes: true });
    expect(code).toBe(0);
    expect(reg.listProjects().length).toBe(0);
  });

  // -------------------------------------------------------------------
  // TD-122: --fix loop must visit drift rows that come AFTER a
  // bridge-missing row. Pre-TD-122, the bridge-missing arm called
  // `break`, which (a) skipped multiple bridge-missing rows that should
  // have been deduped via a flag, and (b) skipped later drift rows
  // entirely. Post-TD-122 the arm sets `bridgeFixApplied = true` and
  // continues, so a single `--fix` invocation handles BOTH classes.
  //
  // FR-212d: the `not-installed` class was retired (register-only). The
  // "second class after bridge-missing" is now the brain-level
  // hooks-missing row (global ~/.claude/settings.json lacking the Igris
  // hooks), whose fix is `mergeGlobalCanonicalHooks`. Test approach (per
  // L-159): spy on the DEPENDENCY modules `init.js` + `global-hooks.js`
  // (NOT the SUT `doctor.js`). After --fix:
  //   - runInit was invoked exactly once (bridge fix)
  //   - mergeGlobalCanonicalHooks was invoked (hooks-missing fix)
  // Both calls in one runDoctor invocation = `break` was replaced with
  // continue.
  // -------------------------------------------------------------------
  it("--fix: bridge-missing AND hooks-missing in one invocation (TD-122)", async () => {
    const initMod = await import("../verbs/init.js");
    const ghMod = await import("../lib/global-hooks.js");
    const bridgeMod = await import("../lib/drift/bridge-missing.js");
    const { runDoctor } = await import("../verbs/doctor.js");

    // Make the GLOBAL hooks row fire: overwrite the staged-valid global
    // settings with one lacking the Igris hooks.
    writeFileSync(
      join(homeOverride, ".claude", "settings.json"),
      JSON.stringify({ includeGitInstructions: false }) + "\n",
    );

    // Inject a synthetic bridge-missing drift row. The detector itself
    // is a pure function; spying on it cleanly isolates the doctor
    // loop's behavior from the brittle PATH/configDir detection logic.
    const bridgeSpy = vi
      .spyOn(bridgeMod, "detectBridgeMissing")
      .mockReturnValue([
        {
          slug: "(brain)",
          path: "claude",
          driftClass: "bridge-missing",
          recommendedFix: "synthetic — TD-122 test",
        },
      ]);

    // Stub runInit so we don't actually re-init the test brain. Returning
    // 0 signals "bridge fix succeeded".
    const initSpy = vi.spyOn(initMod, "runInit").mockResolvedValue(0);
    // Spy on the global-hooks merge (the hooks-missing fix). Let it run for
    // real — it writes into the sandboxed HOME and clears the row.
    const ghSpy = vi.spyOn(ghMod, "mergeGlobalCanonicalHooks");

    try {
      // --fix should visit BOTH classes. The assertion is that both fix
      // paths fired in one invocation (the loop did NOT break after
      // bridge-missing).
      await runDoctor({ fix: true, removeOrphans: false, yes: false });

      // Bridge fix invoked exactly once.
      expect(initSpy).toHaveBeenCalledTimes(1);
      expect(initSpy).toHaveBeenCalledWith({ upgrade: true, yes: true });

      // hooks-missing fix invoked at least once — evidence the loop did
      // NOT break after bridge-missing.
      expect(ghSpy).toHaveBeenCalled();
    } finally {
      bridgeSpy.mockRestore();
      initSpy.mockRestore();
      ghSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// TD-111: --remove-orphans interactive prompt (`[y/N/a/all]`).
//
// The prompt label was previously `[y/N/a/Y/A]`, but the input handler
// always lowercased the answer — `Y`/`A` were never reachable as distinct
// shortcuts. These tests pin the relabeled prompt and exercise the four
// real branches (y/n/a/all) using a synthetic Readable stream injected
// into `confirmAndRemoveOrphans`. No `process.stdin` monkey-patching, no
// vi.mock — real registry, real DB, real readline.
// ---------------------------------------------------------------------------
describe("doctor — --remove-orphans interactive prompt (TD-111)", () => {
  // Helper: build a queue-backed prompt function. Each call dequeues the
  // next answer; running out throws (test-bug indicator). This bypasses
  // readline entirely — the seam in confirmAndRemoveOrphans accepts a
  // PromptFn directly so we never have to fight Node's per-line listener
  // race or the readline 'close' event.
  function makePrompt(
    answers: string[],
  ): (question: string) => Promise<string> {
    const queue = [...answers];
    return async (_question: string): Promise<string> => {
      if (queue.length === 0) {
        throw new Error(
          "test bug: prompt called more times than answers were queued",
        );
      }
      return queue.shift() as string;
    };
  }

  async function seedOrphans(slugs: string[]): Promise<void> {
    // Each orphan is a registry row whose path doesn't exist on disk —
    // the path-missing classifier picks them up as orphans. We don't need
    // classifyDrift here; confirmAndRemoveOrphans takes a DriftRow[]
    // directly so the test seeds the rows AND constructs the matching
    // DriftRow shape inline. Uses dynamic ESM import (project is type:
    // module — CommonJS require() is unavailable).
    const reg = await import("../lib/registry.js");
    for (const slug of slugs) {
      reg.upsertProject({
        slug,
        name: slug,
        path: `/no/such/dir/${slug}`,
        tech_stack: "",
        igris_version: "7.0.0",
      });
    }
  }

  function buildOrphanRows(slugs: string[]): Array<{
    slug: string;
    path: string;
    driftClass: "path-missing";
    recommendedFix: string;
  }> {
    return slugs.map((slug) => ({
      slug,
      path: `/no/such/dir/${slug}`,
      driftClass: "path-missing" as const,
      recommendedFix: "delete row",
    }));
  }

  it("answer 'y' deletes one orphan and re-prompts for the next", async () => {
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedOrphans(["orphan-1", "orphan-2"]);
    expect(reg.listProjects().length).toBe(2);

    // 'y' for first, 'n' for second — net delete = 1.
    const sweep = await confirmAndRemoveOrphans(
      buildOrphanRows(["orphan-1", "orphan-2"]),
      false,
      makePrompt(["y", "n"]),
    );
    expect(sweep.removed).toBe(1);
    expect(sweep.skipped).toBe(0);
    const remaining = reg.listProjects().map((r) => r.slug);
    expect(remaining).toEqual(["orphan-2"]);
  });

  it("answer 'n' keeps the row and re-prompts for the next orphan", async () => {
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedOrphans(["orphan-keep"]);
    const sweep = await confirmAndRemoveOrphans(
      buildOrphanRows(["orphan-keep"]),
      false,
      makePrompt(["n"]),
    );
    expect(sweep.removed).toBe(0);
    // A declined row is not an ATTEMPT — it must not show up as a skip.
    expect(sweep.results).toEqual([]);
    expect(reg.listProjects().length).toBe(1);
  });

  it("answer 'a' aborts the flow without deleting any further rows", async () => {
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedOrphans(["orphan-x", "orphan-y", "orphan-z"]);
    // 'a' on the first prompt — handler must break BEFORE touching y/z.
    // We seed exactly one answer; the queue would throw if the loop
    // didn't break (defensive: catches a regression that walks past the
    // 'a' branch).
    const sweep = await confirmAndRemoveOrphans(
      buildOrphanRows(["orphan-x", "orphan-y", "orphan-z"]),
      false,
      makePrompt(["a"]),
    );
    expect(sweep.removed).toBe(0);
    expect(sweep.results).toEqual([]);
    expect(reg.listProjects().length).toBe(3);
  });

  it("answer 'all' deletes every remaining orphan in one pass without re-prompting", async () => {
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedOrphans(["bulk-1", "bulk-2", "bulk-3"]);
    // Single 'all' answer — yesAll latches and the remaining orphans are
    // deleted in the body of the loop without further reads. Queue has
    // exactly one entry; if yesAll didn't latch, the second loop iter
    // would throw "more times than answers queued".
    const sweep = await confirmAndRemoveOrphans(
      buildOrphanRows(["bulk-1", "bulk-2", "bulk-3"]),
      false,
      makePrompt(["all"]),
    );
    expect(sweep.removed).toBe(3);
    expect(sweep.skipped).toBe(0);
    expect(reg.listProjects().length).toBe(0);
  });

  it("answer 'Y' (uppercase) lowercases to 'y' — single delete, then re-prompt (regression anchor)", async () => {
    // Pre-TD-111 the prompt advertised 'Y' as a shortcut; the handler
    // already accepted it (via toLowerCase) but treated it identically to
    // 'y'. This test pins that behavior so the relabel doesn't accidentally
    // change semantics for users who memorized the old shortcut.
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedOrphans(["upper-1", "upper-2"]);
    const sweep = await confirmAndRemoveOrphans(
      buildOrphanRows(["upper-1", "upper-2"]),
      false,
      makePrompt(["Y", "n"]),
    );
    expect(sweep.removed).toBe(1);
    const remaining = reg.listProjects().map((r) => r.slug);
    expect(remaining).toEqual(["upper-2"]);
  });
});

// ---------------------------------------------------------------------------
// BR-084: a project that still has briefs must not abort the WHOLE sweep.
//
// `brief_status.project` carries a live FK to `projects(slug)` and
// better-sqlite3's bundled SQLite is compiled with SQLITE_DEFAULT_FOREIGN_KEYS=1,
// so the DELETE is BLOCKED for such a project — the safe direction. Pre-BR-084
// the throw was unguarded at all four call sites, so it escaped
// confirmAndRemoveOrphans and every OTHER orphan in the same run survived too.
//
// THE FIXTURE HAS TWO ORPHANS AND THE BRIEFED ONE IS SWEPT FIRST. That is the
// whole point: with ONE orphan, "aborted after the throw" and "completed with a
// skip" are indistinguishable — the same single row survives either way. The
// discriminator is the SECOND, clean orphan: it survives an abort and is removed
// by a completed sweep.
// ---------------------------------------------------------------------------
describe("doctor — --remove-orphans partial failure (BR-084)", () => {
  const BRIEFED = "orphan-with-briefs";
  const CLEAN = "orphan-clean";

  function rowsFor(slugs: string[]): Array<{
    slug: string;
    path: string;
    driftClass: "path-missing";
    recommendedFix: string;
  }> {
    return slugs.map((slug) => ({
      slug,
      path: `/no/such/dir/${slug}`,
      driftClass: "path-missing" as const,
      recommendedFix: "delete row",
    }));
  }

  /**
   * Two registry rows, both path-missing; ONE of them owns a `brief_status` row.
   *
   * The brief is written through a SEPARATE, short-lived handle opened only
   * after `closeDb()` has released the registry's own — never two live RW
   * connections to the same file at once.
   *
   * The fixture ARMS itself before returning: it asserts `foreign_keys` is
   * actually ON for this handle shape and that the DELETE really is refused.
   * Without that, a sandbox where the FK happened not to bite would make every
   * assertion below pass for the wrong reason.
   */
  async function seedTwoOrphansOneBriefed(): Promise<void> {
    const reg = await import("../lib/registry.js");
    for (const slug of [BRIEFED, CLEAN]) {
      reg.upsertProject({
        slug,
        name: slug,
        path: `/no/such/dir/${slug}`,
        tech_stack: "",
        igris_version: "7.0.0",
      });
    }
    reg.closeDb();

    const { brainDbPath } = await import("../lib/paths.js");
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(brainDbPath());
    // Mirrors brain-mcp-server/src/db.ts:296-308 — the FK is the load-bearing
    // part; the column list is trimmed to the NOT NULL ones.
    db.exec(
      `CREATE TABLE IF NOT EXISTS brief_status (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         project TEXT NOT NULL,
         brief_id TEXT NOT NULL,
         title TEXT NOT NULL,
         status TEXT NOT NULL,
         FOREIGN KEY (project) REFERENCES projects(slug)
       );`,
    );
    db.prepare(
      "INSERT INTO brief_status (project, brief_id, title, status) VALUES (?, ?, ?, ?)",
    ).run(BRIEFED, "BR-084", "fixture brief", "Open");

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    let refused = false;
    try {
      db.prepare("DELETE FROM projects WHERE slug = ?").run(BRIEFED);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    db.close();
  }

  it("--yes: the briefed project is skipped WITH ITS REASON and the other orphan is still removed", async () => {
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedTwoOrphansOneBriefed();
    expect(reg.listProjects().map((r) => r.slug)).toEqual([CLEAN, BRIEFED]);

    // BRIEFED first — the throw used to happen here, before CLEAN was reached.
    const sweep = await confirmAndRemoveOrphans(rowsFor([BRIEFED, CLEAN]), true);

    expect(sweep.removed).toBe(1);
    expect(sweep.skipped).toBe(1);
    // The sweep CONTINUED: the clean orphan is gone, the briefed one is kept.
    expect(reg.listProjects().map((r) => r.slug)).toEqual([BRIEFED]);

    const failed = sweep.results.find((r) => !r.ok);
    expect(failed?.slug).toBe(BRIEFED);
    // Reported with the REASON, not a bare "failed": the count and the table
    // that blocked it are what tell an operator what to do next.
    expect(failed?.error).toContain("1 brief_status row(s)");
    expect(failed?.error).toContain("registry row kept");
    const succeeded = sweep.results.find((r) => r.ok);
    expect(succeeded?.slug).toBe(CLEAN);
    expect(succeeded?.error).toBeNull();
  });

  it("interactive 'y','y': the refusal on the first orphan does not stop the second", async () => {
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedTwoOrphansOneBriefed();

    const answers = ["y", "y"];
    const sweep = await confirmAndRemoveOrphans(
      rowsFor([BRIEFED, CLEAN]),
      false,
      async () => {
        const next = answers.shift();
        if (next === undefined) {
          throw new Error("test bug: prompt called more times than answers queued");
        }
        return next;
      },
    );

    // BOTH prompts were consumed — the loop reached the second orphan.
    expect(answers.length).toBe(0);
    expect(sweep.removed).toBe(1);
    expect(sweep.skipped).toBe(1);
    expect(reg.listProjects().map((r) => r.slug)).toEqual([BRIEFED]);
  });

  it("runDoctor --remove-orphans --yes: completes, and exits 1 because the skipped row is STILL drifted", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedTwoOrphansOneBriefed();

    // Pre-BR-084 this call REJECTED (the throw escaped runDoctor entirely).
    const code = await runDoctor({ fix: false, removeOrphans: true, yes: true });

    // The sibling test "--remove-orphans --yes deletes path-missing rows" pins
    // exit 0 for two REMOVABLE orphans in this same baseline, so the 1 here is
    // attributable to the skipped row and nothing else in the sandbox.
    expect(code).toBe(1);
    expect(reg.listProjects().map((r) => r.slug)).toEqual([BRIEFED]);
  });

  it("rl.close() runs on the throwing path (the interactive path no longer leaks readline)", async () => {
    // The readline interface is only built on the PRODUCTION path (no injected
    // prompt), so this is the one test that must reach it. `node:readline` is
    // mocked for a freshly-reset module graph and restored in `finally`.
    const reg0 = await import("../lib/registry.js");
    reg0.closeDb();
    vi.resetModules();

    let created = 0;
    let closed = 0;
    vi.doMock("node:readline", () => {
      const createInterface = (): unknown => {
        created++;
        return {
          question: (): never => {
            throw new Error("synthetic stdin failure");
          },
          close: (): void => {
            closed++;
          },
        };
      };
      const emitKeypressEvents = (): void => {};
      return { createInterface, emitKeypressEvents, default: { createInterface, emitKeypressEvents } };
    });

    try {
      const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
      await expect(
        confirmAndRemoveOrphans(rowsFor(["never-reached"]), false),
      ).rejects.toThrow("synthetic stdin failure");
      // Arm: the production readline branch really was taken. Without this, a
      // `closed === 0` regression could hide behind "rl was never created".
      expect(created).toBe(1);
      // Pre-BR-084 `rl.close()` sat AFTER the loop, so a throw skipped it: 0.
      expect(closed).toBe(1);
    } finally {
      vi.doUnmock("node:readline");
      vi.resetModules();
      const reg = await import("../lib/registry.js");
      reg.closeDb();
    }
  });
});

// ---------------------------------------------------------------------------
// TD-220: secret-perms drift class. classifyDriftAll synthesizes a
// `(brain)`-slug `secret-perms` row for any Igris-written secret file
// (config.json, secrets.env) OR harness config that is group/world-readable
// or git-tracked. Igris-owned + harness-owned both chmod'd to 600 under --fix
// (the read pass WARNs harness-owned). The sandboxed brain (tmpRoot) has no
// config.json/secrets.env by default, and stageValidClaudeJson() stages
// ~/.claude.json at 600 — so the baseline has NO secret-perms rows.
// ---------------------------------------------------------------------------
describe("doctor — secret-perms drift class (TD-220)", () => {
  it("T10: a 644 config.json yields a secret-perms row; runDoctor (no --fix) exits 1", async () => {
    const { classifyDriftAll, runDoctor } = await import("../verbs/doctor.js");
    const { configJsonPath } = await import("../lib/paths.js");
    const reg = await import("../lib/registry.js");

    const cfg = configJsonPath(); // resolves under tmpRoot (IGRIS_BRAIN_DIR)
    // cli_targets:{} keeps bridge-missing opted-out (see stageOptOutConfig) so
    // the only non-clean row is the 644-perms one under test.
    writeFileSync(cfg, JSON.stringify({ version: "7.0.0", cli_targets: {} }) + "\n");
    chmodSync(cfg, 0o644);

    const drift = await classifyDriftAll(reg.listProjects());
    const row = drift.find(
      (r) => r.driftClass === "secret-perms" && r.path === cfg,
    );
    expect(row).toBeDefined();
    expect(row!.slug).toBe("(brain)");

    const code = await runDoctor({ fix: false, removeOrphans: false, yes: false });
    expect(code).toBe(1);
  });

  it("T11: runDoctor({fix:true}) on the 644 config.json chmods it to 600 and exits 0", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    const { configJsonPath } = await import("../lib/paths.js");

    const cfg = configJsonPath();
    // cli_targets:{} keeps bridge-missing opted-out so --fix's only action is
    // the chmod (a spurious bridge-missing would fail the fix's runInit).
    writeFileSync(cfg, JSON.stringify({ version: "7.0.0", cli_targets: {} }) + "\n");
    chmodSync(cfg, 0o644);
    expect(statSync(cfg).mode & 0o777).toBe(0o644);

    const code = await runDoctor({ fix: true, removeOrphans: false, yes: false });
    expect(code).toBe(0);
    expect(statSync(cfg).mode & 0o777).toBe(0o600);
  });

  it("T12: a 644 harness config (gemini) WARNs in the read pass + is chmod'd 600 under --fix", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    const { geminiSettingsPath } = await import("../lib/paths.js");

    const gem = geminiSettingsPath(); // ~/.gemini/settings.json under sandboxed HOME
    mkdirSync(join(homeOverride, ".gemini"), { recursive: true });
    writeFileSync(gem, JSON.stringify({ mcpServers: {} }) + "\n");
    chmodSync(gem, 0o644);

    // Read pass: WARNs (harness-owned) and exits 1.
    const stderrChunks: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });
    let readCode: number;
    try {
      readCode = await runDoctor({ fix: false, removeOrphans: false, yes: false });
    } finally {
      spy.mockRestore();
    }
    expect(readCode).toBe(1);
    const out = stderrChunks.join("");
    expect(out).toContain("harness config");
    expect(out).toContain(gem);
    // gemini is still 644 — the read pass never chmods a harness config.
    expect(statSync(gem).mode & 0o777).toBe(0o644);

    // --fix chmods it to 600 and exits 0.
    const fixCode = await runDoctor({ fix: true, removeOrphans: false, yes: false });
    expect(fixCode).toBe(0);
    expect(statSync(gem).mode & 0o777).toBe(0o600);
  });

  it("T13: clean — all secret files at 600 (or absent) → no secret-perms rows", async () => {
    const { classifyDriftAll } = await import("../verbs/doctor.js");
    const { configJsonPath, secretsEnvPath } = await import("../lib/paths.js");
    const reg = await import("../lib/registry.js");

    // config.json + secrets.env staged at 600; harness claude.json already 600.
    // cli_targets:{} keeps bridge-missing opted-out (baseline parity).
    const cfg = configJsonPath();
    writeFileSync(cfg, JSON.stringify({ version: "7.0.0", cli_targets: {} }) + "\n");
    chmodSync(cfg, 0o600);
    const sec = secretsEnvPath();
    writeFileSync(sec, "export FOO=bar\n");
    chmodSync(sec, 0o600);

    const drift = await classifyDriftAll(reg.listProjects());
    expect(drift.some((r) => r.driftClass === "secret-perms")).toBe(false);
  });
});

describe("doctor — skills-pollution drift class (TD-223 RE-SCOPED)", () => {
  /**
   * Stage the core surfaces-manifest under the sandbox brain dir declaring the
   * canonical claude/symlink skills target (~/.igris/core/skills →
   * ~/.claude/skills). Both resolve under the sandboxed HOME.
   */
  function stageSkillsSurface(): void {
    const adapterDir = join(tmpRoot, "core", "scripts", "cli-adapters");
    mkdirSync(adapterDir, { recursive: true });
    writeFileSync(
      join(adapterDir, "surfaces-manifest.json"),
      JSON.stringify({
        version: 1,
        agents: [],
        surfaces: {
          skills: [
            {
              source: "~/.igris/core/skills",
              layer: "core",
              targets: [
                { type: "claude", method: "symlink", path: "~/.claude/skills" },
              ],
            },
          ],
        },
      }) + "\n",
    );
  }

  function coreSkillsRoot(): string {
    return join(homeOverride, ".igris", "core", "skills");
  }
  function coreAgentsRoot(): string {
    return join(homeOverride, ".igris", "core", "agents");
  }
  function claudeSkillsRoot(): string {
    return join(homeOverride, ".claude", "skills");
  }
  function claudeAgentsRoot(): string {
    return join(homeOverride, ".claude", "agents");
  }

  function stageCanonicalSkill(name: string): void {
    const dir = join(coreSkillsRoot(), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: "${name}"\n---\n\nBody.\n`,
    );
  }

  function stageCoreAgent(name: string): void {
    mkdirSync(coreAgentsRoot(), { recursive: true });
    writeFileSync(join(coreAgentsRoot(), `${name}.md`), `# ${name}\n`);
  }

  /** Make ~/.claude/skills a legacy whole-dir symlink → the core source. */
  function legacySkillsSymlink(): void {
    mkdirSync(join(homeOverride, ".claude"), { recursive: true });
    symlinkSync(coreSkillsRoot(), claudeSkillsRoot());
  }
  function legacyAgentsSymlink(): void {
    mkdirSync(join(homeOverride, ".claude"), { recursive: true });
    symlinkSync(coreAgentsRoot(), claudeAgentsRoot());
  }

  function claudeBaks(prefix: string): string[] {
    return require("node:fs")
      .readdirSync(join(homeOverride, ".claude"))
      .filter((n: string) => n.includes(`${prefix}.bak-`));
  }

  it("T1: a legacy whole-dir skills symlink yields a skills-pollution row; read pass exits 1", async () => {
    const { classifyDriftAll, runDoctor } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    stageSkillsSurface();
    stageCanonicalSkill("foo");
    legacySkillsSymlink();

    const drift = await classifyDriftAll(reg.listProjects());
    const row = drift.find((r) => r.driftClass === "skills-pollution");
    expect(row).toBeDefined();
    expect(row!.slug).toBe("(brain)");
    expect(row!.recommendedFix).toContain("migrate");

    const code = await runDoctor({ fix: false, removeOrphans: false, yes: false });
    expect(code).toBe(1);
  });

  it("T1/fix: runDoctor({fix:true}) migrates the skills root to a real dir of per-item symlinks, exits 0", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    stageSkillsSurface();
    stageCanonicalSkill("foo");
    stageCanonicalSkill("bar");
    legacySkillsSymlink();
    expect(lstatSync(claudeSkillsRoot()).isSymbolicLink()).toBe(true);

    const code = await runDoctor({ fix: true, removeOrphans: false, yes: false });
    expect(code).toBe(0);

    // Root is now a REAL dir of per-skill symlinks → the core source.
    expect(lstatSync(claudeSkillsRoot()).isSymbolicLink()).toBe(false);
    for (const n of ["foo", "bar"]) {
      const link = join(claudeSkillsRoot(), n);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(coreSkillsRoot(), n)));
    }
    // The old root symlink is backed up.
    expect(claudeBaks("skills").length).toBe(1);
  });

  it("T2: agents whole-dir symlink also migrated (parity)", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    stageSkillsSurface();
    stageCanonicalSkill("foo");
    legacySkillsSymlink();
    stageCoreAgent("architect");
    writeFileSync(join(coreAgentsRoot(), "manifest.yaml"), "agents: []\n");
    legacyAgentsSymlink();

    const code = await runDoctor({ fix: true, removeOrphans: false, yes: false });
    expect(code).toBe(0);

    expect(lstatSync(claudeAgentsRoot()).isSymbolicLink()).toBe(false);
    const agentLink = join(claudeAgentsRoot(), "architect.md");
    expect(lstatSync(agentLink).isSymbolicLink()).toBe(true);
    expect(realpathSync(agentLink)).toBe(
      realpathSync(join(coreAgentsRoot(), "architect.md")),
    );
    // manifest.yaml preserved as a symlink (aux file, not an agent).
    const manifest = join(claudeAgentsRoot(), "manifest.yaml");
    expect(lstatSync(manifest).isSymbolicLink()).toBe(true);
    expect(claudeBaks("agents").length).toBe(1);
  });

  it("T4: a loadout-projection stray in the source is cleaned under --fix", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    stageSkillsSurface();
    stageCanonicalSkill("foo");
    // The loadout store lives under brainDir() (IGRIS_BRAIN_DIR=tmpRoot) — that is
    // where loadoutOverlayPath() + loadoutDirPath() resolve. Stage the
    // personal content-pipeline skill there (L-517 nested layout).
    const loadoutSkillDir = join(tmpRoot, "loadout", "skills", "content-pipeline");
    const nested = join(loadoutSkillDir, "content-pipeline");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, "SKILL.md"),
      `---\nname: content-pipeline\ndescription: "cp"\n---\n\nBody.\n`,
    );
    writeFileSync(
      join(tmpRoot, "loadout", "harness-manifest.personal.json"),
      JSON.stringify({
        version: 1,
        agents: [],
        surfaces: {
          skills: [
            {
              source: loadoutSkillDir,
              layer: "personal",
              targets: [
                { type: "claude", method: "symlink", path: "~/.claude/skills" },
              ],
            },
          ],
        },
      }) + "\n",
    );
    // The leaked projection stray inside the canonical source (→ the loadout).
    symlinkSync(nested, join(coreSkillsRoot(), "content-pipeline"));
    legacySkillsSymlink();

    const code = await runDoctor({ fix: true, removeOrphans: false, yes: false });
    expect(code).toBe(0);

    // Stray removed from the source; the migrated per-item home exists.
    expect(require("node:fs").existsSync(join(coreSkillsRoot(), "content-pipeline"))).toBe(
      false,
    );
    expect(
      lstatSync(join(claudeSkillsRoot(), "content-pipeline")).isSymbolicLink(),
    ).toBe(true);
  });

  it("T5: a stray NOT a loadout projection is reported but never removed (exits 1)", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    stageSkillsSurface();
    stageCanonicalSkill("foo");
    // A stray symlink pointing OUTSIDE the loadout.
    const outside = mkdtempSync(join(tmpdir(), "igris-doctor-stray-outside-"));
    projectDirs.push(outside);
    symlinkSync(outside, join(coreSkillsRoot(), "weird"));
    legacySkillsSymlink();

    const stderrChunks: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });
    let code: number;
    try {
      code = await runDoctor({ fix: true, removeOrphans: false, yes: false });
    } finally {
      spy.mockRestore();
    }
    // The non-projection stray keeps the row non-clean → exit 1.
    expect(code).toBe(1);
    // Stray left in place.
    expect(require("node:fs").existsSync(join(coreSkillsRoot(), "weird"))).toBe(true);
    const out = stderrChunks.join("");
    expect(out).toContain("weird");
  });

  it("T3 (T9): a per-surface-model real dir produces NO skills-pollution row", async () => {
    const { classifyDriftAll } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    stageSkillsSurface();
    stageCanonicalSkill("foo");
    // ~/.claude/skills is a REAL dir of per-skill symlinks already.
    mkdirSync(claudeSkillsRoot(), { recursive: true });
    symlinkSync(join(coreSkillsRoot(), "foo"), join(claudeSkillsRoot(), "foo"));
    // ~/.claude/agents is also a real dir.
    mkdirSync(claudeAgentsRoot(), { recursive: true });

    const drift = await classifyDriftAll(reg.listProjects());
    expect(drift.some((r) => r.driftClass === "skills-pollution")).toBe(false);
  });

  it("T6: idempotent — a 2nd --fix on a migrated root is a no-op (no 2nd backup, exits 0)", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    stageSkillsSurface();
    stageCanonicalSkill("foo");
    legacySkillsSymlink();
    // ~/.claude/agents absent → real-dir/missing → no agent migration.

    expect(
      await runDoctor({ fix: true, removeOrphans: false, yes: false }),
    ).toBe(0);
    expect(claudeBaks("skills").length).toBe(1);

    // 2nd --fix: root is now a real dir → no row, no new backup.
    expect(
      await runDoctor({ fix: true, removeOrphans: false, yes: false }),
    ).toBe(0);
    expect(claudeBaks("skills").length).toBe(1);
  });

  it("T7: a root symlinked to an UNEXPECTED target is reported, never rewritten (exits 1)", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    stageSkillsSurface();
    stageCanonicalSkill("foo");
    const other = mkdtempSync(join(tmpdir(), "igris-doctor-unexpected-"));
    projectDirs.push(other);
    mkdirSync(join(homeOverride, ".claude"), { recursive: true });
    symlinkSync(other, claudeSkillsRoot());

    const code = await runDoctor({ fix: true, removeOrphans: false, yes: false });
    expect(code).toBe(1);
    // Root untouched: still a symlink → the unexpected target, no backup.
    expect(lstatSync(claudeSkillsRoot()).isSymbolicLink()).toBe(true);
    expect(realpathSync(claudeSkillsRoot())).toBe(realpathSync(other));
    expect(claudeBaks("skills")).toEqual([]);
  });

  it("T3/no-loss: --fix prints the before/after enumeration to stdout (no skill lost)", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    stageSkillsSurface();
    stageCanonicalSkill("alpha");
    stageCanonicalSkill("beta");
    legacySkillsSymlink();

    // The before/after enumeration is emitted via info() → stdout.
    const stdoutChunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    try {
      await runDoctor({ fix: true, removeOrphans: false, yes: false });
    } finally {
      spy.mockRestore();
    }
    const out = stdoutChunks.join("");
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });
});

// ---------------------------------------------------------------------------
// FR-179 Phase C: antigravity-skills-link drift class. The detector is pure +
// CLI-detection-driven (mirrors bridge-missing): it fires when `agy` is detected
// but ~/.gemini/antigravity-cli/skills does NOT resolve to ~/.agents/skills.
// We test the detector directly via its detectFn + path seams (fully hermetic —
// the real machine's link is never touched), and test the runDoctor --fix path
// by spying on the detector (synthetic row) + linkAntigravitySkills (the repair).
// ---------------------------------------------------------------------------
describe("doctor — antigravity-skills-link drift class (FR-179)", () => {
  it("no row when antigravity is NOT detected", async () => {
    const { detectAntigravitySkillsLink } = await import(
      "../lib/drift/antigravity-skills-link.js"
    );
    const row = detectAntigravitySkillsLink({
      detectFn: () => ({ detected: new Set() }),
    });
    expect(row).toBeNull();
  });

  it("no row when detected AND the link already resolves to the target", async () => {
    const { detectAntigravitySkillsLink } = await import(
      "../lib/drift/antigravity-skills-link.js"
    );
    const w = mkdtempSync(join(tmpdir(), "igris-ag-doctor-ok-"));
    projectDirs.push(w);
    const target = join(w, "agents", "skills");
    const linkPath = join(w, "gemini", "antigravity-cli", "skills");
    mkdirSync(target, { recursive: true });
    mkdirSync(join(w, "gemini", "antigravity-cli"), { recursive: true });
    symlinkSync(target, linkPath);

    const row = detectAntigravitySkillsLink({
      detectFn: () => ({ detected: new Set(["antigravity" as const]) }),
      linkPath,
      target,
    });
    expect(row).toBeNull();
  });

  it("yields a row when detected but the link is MISSING", async () => {
    const { detectAntigravitySkillsLink } = await import(
      "../lib/drift/antigravity-skills-link.js"
    );
    const w = mkdtempSync(join(tmpdir(), "igris-ag-doctor-miss-"));
    projectDirs.push(w);
    const target = join(w, "agents", "skills");
    const linkPath = join(w, "gemini", "antigravity-cli", "skills");

    const row = detectAntigravitySkillsLink({
      detectFn: () => ({ detected: new Set(["antigravity" as const]) }),
      linkPath,
      target,
    });
    expect(row).not.toBeNull();
    expect(row!.driftClass).toBe("antigravity-skills-link");
    expect(row!.path).toBe(linkPath);
  });

  it("yields a row when the link points at the WRONG target", async () => {
    const { detectAntigravitySkillsLink } = await import(
      "../lib/drift/antigravity-skills-link.js"
    );
    const w = mkdtempSync(join(tmpdir(), "igris-ag-doctor-wrong-"));
    projectDirs.push(w);
    const target = join(w, "agents", "skills");
    const elsewhere = join(w, "elsewhere");
    const linkPath = join(w, "gemini", "antigravity-cli", "skills");
    mkdirSync(target, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(w, "gemini", "antigravity-cli"), { recursive: true });
    symlinkSync(elsewhere, linkPath);

    const row = detectAntigravitySkillsLink({
      detectFn: () => ({ detected: new Set(["antigravity" as const]) }),
      linkPath,
      target,
    });
    expect(row).not.toBeNull();
    expect(row!.driftClass).toBe("antigravity-skills-link");
  });

  it("--fix invokes linkAntigravitySkills to repair the link", async () => {
    const driftMod = await import(
      "../lib/drift/antigravity-skills-link.js"
    );
    const agMod = await import("../lib/antigravity-skills.js");
    const { runDoctor } = await import("../verbs/doctor.js");

    // Inject a synthetic antigravity-skills-link drift row (pure detector;
    // spying isolates the doctor loop from the brittle PATH/configDir probe).
    const detectSpy = vi
      .spyOn(driftMod, "detectAntigravitySkillsLink")
      .mockReturnValue({
        slug: "(brain)",
        path: "/fake/.gemini/antigravity-cli/skills",
        driftClass: "antigravity-skills-link",
        recommendedFix: "synthetic — FR-179 test",
      });
    // Stub the repair so we don't mutate the real machine; report success.
    const linkSpy = vi
      .spyOn(agMod, "linkAntigravitySkills")
      .mockReturnValue({
        outcome: "created",
        linkPath: "/fake/.gemini/antigravity-cli/skills",
        target: "/fake/.agents/skills",
      });

    try {
      await runDoctor({ fix: true, removeOrphans: false, yes: false });
      expect(linkSpy).toHaveBeenCalledTimes(1);
    } finally {
      detectSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });
});
