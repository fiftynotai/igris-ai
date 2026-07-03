/**
 * update verb tests — Phase 5 + M3.
 *
 * Diff logic: stale projects re-install (skipSymlinkLayer=true), up-to-date
 * skip, missing-path projects warn but don't abort the loop.
 *
 * M3 additions: --self short-circuit (mocked at child_process), --dry-run
 * enumeration without writes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
const projectDirs: string[] = [];

// --self tests mock child_process at the boundary. Other tests in this
// file don't invoke npm; the mock is harmless to them because runUpdate's
// non-self path never reaches execFile.
type SelfUpdateBehavior =
  | { kind: "idle" }
  | { kind: "success" }
  | { kind: "exit"; code: number };
let selfUpdateBehavior: SelfUpdateBehavior = { kind: "idle" };
const selfUpdateCalls: Array<{ bin: string; args: string[] }> = [];

vi.mock("node:child_process", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execFile: (bin: string, args: string[], _opts: any, cb: any) => {
    selfUpdateCalls.push({ bin, args });
    setImmediate(() => {
      const b = selfUpdateBehavior;
      if (b.kind === "success") {
        cb(null);
        return;
      }
      if (b.kind === "exit") {
        const err = new Error("npm exit") as Error & {
          code?: number | string;
        };
        err.code = b.code;
        cb(err);
        return;
      }
      // idle — should not happen if --self path is exercised.
      cb(new Error("unexpected execFile call"));
    });
    return { mocked: true };
  },
}));

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

function stageProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "igris-cli-update-proj-"));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  projectDirs.push(dir);
  return dir;
}

// FR-212d: sandbox HOME so the register-only install's `~/.claude.json` MCP
// write AND `igris update`'s global-hooks refresh (`~/.claude/settings.json`)
// land in tmp, never the developer's real home. `os.homedir()` honors $HOME on
// this platform (verified), so this redirects both writes.
let homeBackup: string | undefined;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-update-brain-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  homeBackup = process.env.HOME;
  const homeOverride = join(tmpRoot, "home");
  mkdirSync(homeOverride, { recursive: true });
  process.env.HOME = homeOverride;
  stageBrain();
  const ch = await import("../lib/canonical-hooks.js");
  ch.clearCache();
  const reg = await import("../lib/registry.js");
  reg.closeDb();
  selfUpdateCalls.length = 0;
  selfUpdateBehavior = { kind: "idle" };
});

afterEach(async () => {
  const reg = await import("../lib/registry.js");
  reg.closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
  for (const d of projectDirs) rmSync(d, { recursive: true, force: true });
  projectDirs.length = 0;
  delete process.env.IGRIS_BRAIN_DIR;
  delete process.env.IGRIS_KEEP_BAK;
  process.env.HOME = homeBackup;
});

describe("update verb", () => {
  it("update --slug skips a project that is up to date", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { runUpdate } = await import("../verbs/update.js");
    const ifs = await import("../lib/installed-features.js");

    const proj = stageProject();
    await runInstall({
      path: proj,
      slug: "alpha",
      installHooks: true,
    });

    // FR-212d: register-only install writes no per-project settings.json — the
    // up-to-date signal is the features-file hash, not a settings.json. A fresh
    // install left the features file matching canonical, so update SKIPS it
    // (the features file is byte-stable across the no-op update).
    const before = JSON.stringify(ifs.readInstalledFeatures("alpha"));
    const code = await runUpdate({ all: false, slug: "alpha" });
    expect(code).toBe(0);
    const after = JSON.stringify(ifs.readInstalledFeatures("alpha"));
    expect(after).toBe(before);
  });

  it("update --slug re-installs a project with no features file", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { runUpdate } = await import("../verbs/update.js");
    const reg = await import("../lib/registry.js");

    const proj = stageProject();
    // Insert registry row directly without writing features file.
    reg.upsertProject({
      slug: "needs-update",
      name: "needs-update",
      path: proj,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    void runInstall; // not used here, but show import works

    const code = await runUpdate({ all: false, slug: "needs-update" });
    expect(code).toBe(0);
    // After update, features file should exist.
    const ifs = await import("../lib/installed-features.js");
    expect(ifs.readInstalledFeatures("needs-update")).not.toBeNull();
  });

  it("update --all loops over every registered project", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { runUpdate } = await import("../verbs/update.js");

    const a = stageProject();
    const b = stageProject();
    await runInstall({ path: a, slug: "a", installHooks: true });
    await runInstall({ path: b, slug: "b", installHooks: true });

    const code = await runUpdate({ all: true });
    expect(code).toBe(0);
  });

  it("update warns on missing-path rows but does not abort the loop", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { runUpdate } = await import("../verbs/update.js");
    const reg = await import("../lib/registry.js");

    const a = stageProject();
    await runInstall({ path: a, slug: "alive", installHooks: true });
    reg.upsertProject({
      slug: "ghost",
      name: "ghost",
      path: "/this/path/does/not/exist/12345",
      tech_stack: "",
      igris_version: "7.0.0",
    });

    const code = await runUpdate({ all: true });
    // Loop completes; missing-path doesn't count as errored, so exit 0.
    expect(code).toBe(0);
  });

  it("update with neither --all nor --slug returns exit 2", async () => {
    const { runUpdate } = await import("../verbs/update.js");
    const code = await runUpdate({ all: false });
    expect(code).toBe(2);
  });

  it("update --slug for an unknown slug returns exit 1", async () => {
    const { runUpdate } = await import("../verbs/update.js");
    const code = await runUpdate({ all: false, slug: "no-such-slug" });
    expect(code).toBe(1);
  });

  it("update --all with empty registry returns exit 0", async () => {
    const { runUpdate } = await import("../verbs/update.js");
    const code = await runUpdate({ all: true });
    expect(code).toBe(0);
  });

  // ---- M3 additions ---------------------------------------------------

  it("update --self: invokes 'npm install -g igris-ai@latest' and returns 0 on success", async () => {
    const { runUpdate } = await import("../verbs/update.js");
    selfUpdateBehavior = { kind: "success" };
    const code = await runUpdate({ all: false, self: true });
    expect(code).toBe(0);
    expect(selfUpdateCalls.length).toBe(1);
    expect(selfUpdateCalls[0].bin).toBe("npm");
    expect(selfUpdateCalls[0].args).toEqual([
      "install",
      "-g",
      "igris-ai@latest",
    ]);
  });

  it("update --self: surfaces npm's non-zero exit code", async () => {
    const { runUpdate } = await import("../verbs/update.js");
    selfUpdateBehavior = { kind: "exit", code: 1 };
    const code = await runUpdate({ all: false, self: true });
    expect(code).toBe(1);
    expect(selfUpdateCalls.length).toBe(1);
  });

  it("update --all --dry-run: enumerates would-update without invoking install", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { runUpdate } = await import("../verbs/update.js");
    const reg = await import("../lib/registry.js");

    // First, stage one project that needs update (no features file) and
    // another that's up-to-date (full install completed).
    const stale = stageProject();
    reg.upsertProject({
      slug: "stale-proj",
      name: "stale-proj",
      path: stale,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const fresh = stageProject();
    await runInstall({
      path: fresh,
      slug: "fresh-proj",
      installHooks: true,
    });
    // FR-212d: register-only install writes no per-project settings.json. The
    // fresh project's features file is the dry-run no-mutation witness.
    const ifs = await import("../lib/installed-features.js");
    const freshFeaturesBefore = JSON.stringify(
      ifs.readInstalledFeatures("fresh-proj"),
    );

    const code = await runUpdate({ all: true, dryRun: true });
    expect(code).toBe(0);

    // The stale project should NOT have a features file written by dry-run.
    expect(ifs.readInstalledFeatures("stale-proj")).toBeNull();

    // The fresh project's features file must be byte-identical (no rewrite).
    const freshFeaturesAfter = JSON.stringify(
      ifs.readInstalledFeatures("fresh-proj"),
    );
    expect(freshFeaturesAfter).toBe(freshFeaturesBefore);

    // No npm/execFile calls — --self was not requested.
    expect(selfUpdateCalls.length).toBe(0);
  });
});
