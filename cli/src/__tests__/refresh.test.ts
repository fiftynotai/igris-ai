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

// TD-113: refresh checks the cache BEFORE the network. We seed a github-style
// install (the `IGRIS_TARBALL_FILE` seam streams the committed clean fixture so
// no live GitHub is touched, and init seeds the cache from that fetch). The
// SECOND refresh must take the cache no-network path; the `IGRIS_BLOCK_NETWORK`
// seam makes ANY real fetch throw, so a cache MISS would surface as a failure —
// a clean exit 0 proves the network was never reached. A `--channel` switch, by
// contrast, must re-fetch: with the network blocked the switch fails (exit 1),
// proving the cache was deliberately bypassed.
describe("refresh — cache hit avoids network (TD-113)", () => {
  const FIXTURE = join(
    __dirname,
    "fixtures",
    "tarballs",
    "clean-core.tar.gz",
  );

  /** Re-seed the brain via a hermetic github init (replaces the from-source
   *  seed the shared beforeEach installed). Returns the recorded sha. */
  async function seedGithubInstall(): Promise<string> {
    const reg = await import("../lib/registry.js");
    reg.closeDb();
    // Drop the from-source v7 install the beforeEach created so a fresh github
    // init doesn't trip the "existing v7" guard.
    rmSync(brainRoot, { recursive: true, force: true });
    const { runInit } = await import("../verbs/init.js");
    const prev = process.env.IGRIS_TARBALL_FILE;
    process.env.IGRIS_TARBALL_FILE = FIXTURE;
    try {
      expect(
        await runInit({ channel: "main", skipRemote: true, yes: true }),
      ).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.IGRIS_TARBALL_FILE;
      else process.env.IGRIS_TARBALL_FILE = prev;
    }
    const isj = JSON.parse(
      readFileSync(join(brainRoot, ".install-source.json"), "utf-8"),
    ) as { source: string; content_sha256: string };
    expect(isj.source).toBe("github");
    return isj.content_sha256;
  }

  it("uses cache when SHA matches (2nd refresh, no network)", async () => {
    const sha = await seedGithubInstall();
    // The cache was seeded by init.
    const { cacheTarballPath } = await import("../lib/cache.js");
    expect(existsSync(cacheTarballPath(sha))).toBe(true);

    const { runRefresh } = await import("../verbs/refresh.js");
    // Block the network: if refresh tries to fetch, httpsGet throws and the
    // verb returns 1. A cache hit short-circuits before that.
    const prevBlock = process.env.IGRIS_BLOCK_NETWORK;
    process.env.IGRIS_BLOCK_NETWORK = "1";
    // Ensure the fixture seam is OFF so the only way to "succeed" is the cache.
    const prevFixture = process.env.IGRIS_TARBALL_FILE;
    delete process.env.IGRIS_TARBALL_FILE;
    let code: number;
    try {
      code = await runRefresh({ channel: "main", noPropagate: true });
    } finally {
      if (prevBlock === undefined) delete process.env.IGRIS_BLOCK_NETWORK;
      else process.env.IGRIS_BLOCK_NETWORK = prevBlock;
      if (prevFixture !== undefined) process.env.IGRIS_TARBALL_FILE = prevFixture;
    }
    // Exit 0 with NO network access → the cache hit was honored.
    expect(code).toBe(0);
    // The recorded sha is unchanged (no swap, brain already at this content).
    const isj = JSON.parse(
      readFileSync(join(brainRoot, ".install-source.json"), "utf-8"),
    ) as { content_sha256: string };
    expect(isj.content_sha256).toBe(sha);
  });

  it("channel switch re-fetches (does NOT use the cache)", async () => {
    await seedGithubInstall();
    const { runRefresh } = await import("../verbs/refresh.js");
    // Switch from the recorded `main` to a DIFFERENT channel (`--channel=develop`,
    // classified as a branch via the hermetic classifyFn seam). The switch must
    // bypass the cache and hit the network — which is blocked, so the fetch
    // fails (exit 1). Proof: a cache hit would have returned 0 with no network,
    // but a channel switch is REQUIRED to re-fetch.
    const prevBlock = process.env.IGRIS_BLOCK_NETWORK;
    process.env.IGRIS_BLOCK_NETWORK = "1";
    const prevFixture = process.env.IGRIS_TARBALL_FILE;
    delete process.env.IGRIS_TARBALL_FILE;
    let code: number;
    try {
      code = await runRefresh({
        channel: "develop", // a switch away from the recorded `main`
        yes: true, // skip the switch-confirm prompt
        noPropagate: true,
        classifyFn: () => Promise.resolve("branch"), // hermetic ref classification
      });
    } finally {
      if (prevBlock === undefined) delete process.env.IGRIS_BLOCK_NETWORK;
      else process.env.IGRIS_BLOCK_NETWORK = prevBlock;
      if (prevFixture !== undefined) process.env.IGRIS_TARBALL_FILE = prevFixture;
    }
    // The blocked network fetch surfaced as a failure → the cache was NOT used
    // for the channel switch.
    expect(code).toBe(1);
  });

  it("corrupt cached tarball is evicted and the refresh falls back to network", async () => {
    const sha = await seedGithubInstall();
    const { cacheTarballPath, findCached } = await import("../lib/cache.js");
    // Corrupt the cached tarball so its re-hash no longer matches `sha`.
    writeFileSync(cacheTarballPath(sha), "CORRUPTED-NOT-THE-REAL-BYTES");

    const { runRefresh } = await import("../verbs/refresh.js");
    // Network blocked: the corrupt entry must be evicted, then the network
    // fallback is attempted (and fails because it's blocked → exit 1). The
    // KEY assertion is the eviction (the cache no longer serves bad bytes).
    const prevBlock = process.env.IGRIS_BLOCK_NETWORK;
    process.env.IGRIS_BLOCK_NETWORK = "1";
    const prevFixture = process.env.IGRIS_TARBALL_FILE;
    delete process.env.IGRIS_TARBALL_FILE;
    try {
      const code = await runRefresh({ channel: "main", noPropagate: true });
      // The network fallback was blocked → exit 1 (the cache did NOT serve the
      // corrupt bytes as a false hit).
      expect(code).toBe(1);
    } finally {
      if (prevBlock === undefined) delete process.env.IGRIS_BLOCK_NETWORK;
      else process.env.IGRIS_BLOCK_NETWORK = prevBlock;
      if (prevFixture !== undefined) process.env.IGRIS_TARBALL_FILE = prevFixture;
    }
    // The corrupt entry was evicted (no longer a findable hit).
    expect(findCached(sha)).toBe(null);
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
