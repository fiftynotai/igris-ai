/**
 * doctor tests — Phase 6.
 *
 * Drift classification: 8 fixture registries, one per drift class. Each
 * asserts the expected `DriftRow.driftClass` value. --fix and --remove-orphans
 * exercised via runDoctor returning the right exit code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
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
 */
function stageValidClaudeJson(): void {
  const mcpFile = join(tmpRoot, "fake-bundled-mcp.js");
  writeFileSync(mcpFile, "// fake bundled mcp\n");
  writeFileSync(
    join(homeOverride, ".claude.json"),
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
}

function stageProject(name = "proj"): string {
  const dir = mkdtempSync(join(tmpdir(), `igris-cli-doctor-${name}-`));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  projectDirs.push(dir);
  return dir;
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
  it("clean: vanilla install → driftClass=clean", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");

    const proj = stageProject("clean");
    const slug = require("node:path").basename(proj);
    await runInstall({ path: proj, slug, installHooks: true, skipSymlinkLayer: true });
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

  it("not-installed: path exists but .claude/ missing", async () => {
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const dir = mkdtempSync(join(tmpdir(), "igris-cli-doctor-bare-"));
    projectDirs.push(dir);
    reg.upsertProject({
      slug: "bare",
      name: "bare",
      path: dir,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift[0].driftClass).toBe("not-installed");
  });

  it("hooks-missing: settings.json present but no Igris SessionEnd", async () => {
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const proj = stageProject("hooksmissing");
    writeFileSync(
      join(proj, ".claude", "settings.json"),
      JSON.stringify({ includeGitInstructions: false }) + "\n",
    );
    reg.upsertProject({
      slug: require("node:path").basename(proj),
      name: "x",
      path: proj,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift[0].driftClass).toBe("hooks-missing");
  });

  it("hooks-stale: settings.json has Igris hooks at a different command path", async () => {
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const proj = stageProject("hooksstale");
    writeFileSync(
      join(proj, ".claude", "settings.json"),
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
    reg.upsertProject({
      slug: require("node:path").basename(proj),
      name: "x",
      path: proj,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift[0].driftClass).toBe("hooks-stale");
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
      skipSymlinkLayer: true,
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift[0].driftClass).toBe("slug-basename-mismatch");
  });

  it("duplicate-path: multiple slugs share realpath", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const proj = stageProject("dup");
    await runInstall({ path: proj, slug: "slug-one", installHooks: true, skipSymlinkLayer: true });
    await runInstall({ path: proj, slug: "slug-two", installHooks: true, skipSymlinkLayer: true });
    await runInstall({
      path: proj,
      slug: "slug-three",
      installHooks: true,
      skipSymlinkLayer: true,
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
    await runInstall({ path: real, slug: "real-target", installHooks: true, skipSymlinkLayer: true });
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

  it("--fix registers the igris-brain MCP (mcp-unregistered resolved)", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    // Drop ~/.claude.json so mcp-unregistered fires. runInstall (via no
    // project) is not involved — the fix arm calls registerMcpInClaudeJson
    // directly, which writes to the sandboxed HOME pointing at the real
    // bundled path (built in Phase 1 — cli/dist/brain-mcp-server/...).
    rmSync(join(homeOverride, ".claude.json"), { force: true });
    const code = await runDoctor({ fix: true, removeOrphans: false, yes: false });
    expect(code).toBe(0);
    // After --fix, ~/.claude.json exists with the igris-brain entry.
    const data = JSON.parse(
      require("node:fs").readFileSync(
        join(homeOverride, ".claude.json"),
        "utf-8",
      ),
    ) as { mcpServers: Record<string, unknown> };
    expect(data.mcpServers["igris-brain"]).toBeDefined();
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
      skipSymlinkLayer: true,
    });
    const code = await runDoctor({ fix: false, removeOrphans: false, yes: false });
    expect(code).toBe(0);
  });

  it("exits 1 with drift when settings.json missing hooks block (TD-100 silent-failure)", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const proj = stageProject("td100");
    writeFileSync(
      join(proj, ".claude", "settings.json"),
      JSON.stringify({ includeGitInstructions: false }) + "\n",
    );
    reg.upsertProject({
      slug: "td100-victim",
      name: "td100-victim",
      path: proj,
      tech_stack: "",
      igris_version: "7.0.0",
    });
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
      "registry",
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

  it("--fix repairs hooks-missing", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const ifs = await import("../lib/installed-features.js");
    const proj = stageProject("fixme");
    writeFileSync(
      join(proj, ".claude", "settings.json"),
      JSON.stringify({ includeGitInstructions: false }) + "\n",
    );
    reg.upsertProject({
      slug: "fixme",
      name: "fixme",
      path: proj,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const code = await runDoctor({ fix: true, removeOrphans: false, yes: false });
    expect(code).toBe(0);
    // After --fix, settings.json should have the canonical SessionEnd command.
    const settings = JSON.parse(
      require("node:fs").readFileSync(
        join(proj, ".claude", "settings.json"),
        "utf-8",
      ),
    ) as { hooks: Record<string, unknown[]> };
    const sessionEnd = settings.hooks.SessionEnd as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(sessionEnd[0].hooks[0].command).toBe(
      "$HOME/.igris/core/hooks/shared/session_end.sh",
    );
    expect(ifs.readInstalledFeatures("fixme")).not.toBeNull();
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
  // TD-122: --fix loop must visit per-project drift rows that come AFTER
  // a bridge-missing row. Pre-TD-122, the bridge-missing arm called
  // `break`, which (a) skipped multiple bridge-missing rows that should
  // have been deduped via a flag, and (b) skipped per-project rows
  // (not-installed / hooks-* / brain-core-missing) entirely. Post-TD-122
  // the arm sets `bridgeFixApplied = true` and continues, so a single
  // `--fix` invocation handles BOTH classes.
  //
  // Architect-approved test approach (plan §4 + §8 Risk #6): spy on the
  // dependency modules `init.js` and `install.js` (NOT the SUT
  // `doctor.js` per L-159). We inject a synthetic bridge-missing row
  // ahead of the not-installed row by spying on `detectBridgeMissing`
  // (a doctor.ts dependency, not the SUT). After --fix:
  //   - runInit was invoked exactly once (bridge fix)
  //   - runInstall was invoked at least once (not-installed fix)
  // Both calls in one runDoctor invocation = `break` was replaced with
  // continue.
  // -------------------------------------------------------------------
  it("--fix: bridge-missing AND not-installed in one invocation (TD-122)", async () => {
    const initMod = await import("../verbs/init.js");
    const installMod = await import("../verbs/install.js");
    const bridgeMod = await import("../lib/drift/bridge-missing.js");
    const { runDoctor } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");

    // Stage a not-installed project (path exists, .claude/ missing).
    const proj = mkdtempSync(join(tmpdir(), "igris-cli-doctor-td122-"));
    projectDirs.push(proj);
    reg.upsertProject({
      slug: "td122-not-installed",
      name: "td122-not-installed",
      path: proj,
      tech_stack: "",
      igris_version: "7.0.0",
    });

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

    // Stub runInit so we don't actually re-init the test brain. We DO
    // want runInstall to fire its full path (it's not the SUT, but we
    // need it to do its job for the not-installed fix to mutate state).
    // Returning 0 from runInit signals "fix succeeded".
    const initSpy = vi.spyOn(initMod, "runInit").mockResolvedValue(0);
    const installSpy = vi.spyOn(installMod, "runInstall");

    try {
      // --fix should visit BOTH classes. We don't care about the exit
      // code per se — partial success is acceptable; the assertion is
      // that both fix paths fired in one invocation.
      await runDoctor({ fix: true, removeOrphans: false, yes: false });

      // Bridge fix invoked exactly once.
      expect(initSpy).toHaveBeenCalledTimes(1);
      expect(initSpy).toHaveBeenCalledWith({ upgrade: true, yes: true });

      // not-installed fix invoked at least once. (runInstall is also
      // called from the install verb chain; we only need ONE call here
      // to evidence the loop did NOT break after bridge-missing.)
      expect(installSpy).toHaveBeenCalled();
      const installCalls = installSpy.mock.calls;
      // Look for the call matching our staged not-installed slug.
      const matched = installCalls.some(
        (call) =>
          (call[0] as { slug?: string }).slug === "td122-not-installed",
      );
      expect(matched).toBe(true);
    } finally {
      bridgeSpy.mockRestore();
      initSpy.mockRestore();
      installSpy.mockRestore();
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
    const removed = await confirmAndRemoveOrphans(
      buildOrphanRows(["orphan-1", "orphan-2"]),
      false,
      makePrompt(["y", "n"]),
    );
    expect(removed).toBe(1);
    const remaining = reg.listProjects().map((r) => r.slug);
    expect(remaining).toEqual(["orphan-2"]);
  });

  it("answer 'n' keeps the row and re-prompts for the next orphan", async () => {
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedOrphans(["orphan-keep"]);
    const removed = await confirmAndRemoveOrphans(
      buildOrphanRows(["orphan-keep"]),
      false,
      makePrompt(["n"]),
    );
    expect(removed).toBe(0);
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
    const removed = await confirmAndRemoveOrphans(
      buildOrphanRows(["orphan-x", "orphan-y", "orphan-z"]),
      false,
      makePrompt(["a"]),
    );
    expect(removed).toBe(0);
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
    const removed = await confirmAndRemoveOrphans(
      buildOrphanRows(["bulk-1", "bulk-2", "bulk-3"]),
      false,
      makePrompt(["all"]),
    );
    expect(removed).toBe(3);
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
    const removed = await confirmAndRemoveOrphans(
      buildOrphanRows(["upper-1", "upper-2"]),
      false,
      makePrompt(["Y", "n"]),
    );
    expect(removed).toBe(1);
    const remaining = reg.listProjects().map((r) => r.slug);
    expect(remaining).toEqual(["upper-2"]);
  });
});
