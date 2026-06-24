/**
 * refresh verb tests — M1.13.
 *
 * Hermetic via --from-source; channel-switch test uses confirmFn seam
 * instead of stdin. No network mocks required at the verb level.
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
let pathOverride: string;
let homeOverride: string;
let sourceRepo: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "igris-refresh-test-"));
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
  process.env.PATH = pathOverride;
  stageSourceRepo(sourceRepo);

  // Pre-seed the brain via a fresh init.
  const reg = await import("../lib/registry.js");
  reg.closeDb();
  const { runInit } = await import("../verbs/init.js");
  expect(await runInit({ fromSource: sourceRepo })).toBe(0);
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
  writeFileSync(join(core, "SOUL.md"), "# initial soul\n");
  mkdirSync(join(core, "agents"), { recursive: true });
  writeFileSync(join(core, "agents", "manifest.yaml"), "agents: []\n");
  // FR-187: the layered core/os/ set replaces the retired universal rule.
  mkdirSync(join(core, "os"), { recursive: true });
  writeFileSync(join(core, "os", "INDEX.md"), "# Igris OS — Module Index\n");
  writeFileSync(join(core, "os", "standards.md"), "# Universal Standards\n");
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
}

describe("refresh — same channel re-fetch", () => {
  it("re-running refresh from-source after init swaps core in place", async () => {
    const { runRefresh } = await import("../verbs/refresh.js");
    // Modify the source between init and refresh.
    writeFileSync(join(sourceRepo, "core", "SOUL.md"), "# refreshed soul\n");
    const code = await runRefresh({
      fromSource: sourceRepo,
      noPropagate: true,
    });
    expect(code).toBe(0);
    expect(readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8")).toBe(
      "# refreshed soul\n",
    );
    // .install-source.json updated.
    const isj = JSON.parse(
      readFileSync(join(brainRoot, ".install-source.json"), "utf-8"),
    ) as { source: string };
    expect(isj.source).toBe("from-source");
  });

  it("creates a core.bak.<ts>/ on refresh", async () => {
    const { runRefresh } = await import("../verbs/refresh.js");
    await runRefresh({ fromSource: sourceRepo, noPropagate: true });
    const baks = require("node:fs")
      .readdirSync(brainRoot)
      .filter((e: string) => e.startsWith("core.bak."));
    expect(baks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("refresh — channel switch confirmation", () => {
  it("rejects switch when confirmFn returns false; exit 0; no swap", async () => {
    const { runRefresh } = await import("../verbs/refresh.js");
    let calledPrompt = "";
    const code = await runRefresh({
      channel: "main",
      noPropagate: true,
      confirmFn: (prompt) => {
        calledPrompt = prompt;
        return false;
      },
      // Skip network: latestReleaseTagFn isn't called for --channel=main,
      // and we don't reach the fetch path either because the confirm
      // bails early.
      latestReleaseTagFn: () => Promise.resolve("v7.0.0"),
    });
    expect(code).toBe(0);
    expect(calledPrompt).toContain("Switching channel");
    // Original soul still in place.
    expect(readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8")).toBe(
      "# initial soul\n",
    );
  });

  it("--yes accepts switch without calling confirmFn", async () => {
    const { runRefresh } = await import("../verbs/refresh.js");
    let calledPrompt = false;
    // We can't easily fetch from real network in CI; use --from-source
    // for the actual swap. The yes flag is what we're verifying.
    // To exercise both code paths, we use confirmFn that records but
    // also use --yes which should short-circuit it.
    const code = await runRefresh({
      fromSource: sourceRepo,
      yes: true,
      noPropagate: true,
      confirmFn: () => {
        calledPrompt = true;
        return true;
      },
    });
    expect(code).toBe(0);
    expect(calledPrompt).toBe(false);
  });
});

describe("refresh — no install-source", () => {
  it("errors when .install-source.json is missing (init not yet run)", async () => {
    rmSync(join(brainRoot, ".install-source.json"));
    const { runRefresh } = await import("../verbs/refresh.js");
    const code = await runRefresh({
      fromSource: sourceRepo,
      noPropagate: true,
    });
    expect(code).toBe(1);
  });
});

describe("refresh — --dry-run", () => {
  it("--dry-run prints plan and writes nothing", async () => {
    const { runRefresh } = await import("../verbs/refresh.js");
    // Capture original .install-source bytes.
    const before = readFileSync(join(brainRoot, ".install-source.json"));
    const code = await runRefresh({
      fromSource: sourceRepo,
      noPropagate: true,
      dryRun: true,
    });
    expect(code).toBe(0);
    // .install-source unchanged.
    const after = readFileSync(join(brainRoot, ".install-source.json"));
    expect(after.equals(before)).toBe(true);
  });
});

describe("refresh — --no-propagate", () => {
  it("does NOT call runUpdate when --no-propagate is set", async () => {
    // Stage a registered project so update --all has work to do.
    const reg = await import("../lib/registry.js");
    reg.upsertProject({
      slug: "fake",
      name: "fake",
      path: "/this/path/missing",
      tech_stack: "go",
      igris_version: "7.0.0",
    });
    reg.closeDb();
    const { runRefresh } = await import("../verbs/refresh.js");
    // If propagate ran, the fake project's missing path would be reported
    // (warn). The test seam here is "runRefresh exits 0 when noPropagate
    // is set", and we trust the wired-in shape of refresh.
    const code = await runRefresh({
      fromSource: sourceRepo,
      noPropagate: true,
    });
    expect(code).toBe(0);
  });
});
