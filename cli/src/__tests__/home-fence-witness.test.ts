/**
 * BR-106 — the RED witness: what an UNFENCED vitest test does to real operator
 * state, proved without ever touching real operator state.
 *
 * THE INCIDENT (2026-09-08). A sentinel stripped the `HOME`/`IGRIS_BRAIN_DIR`
 * fence from `cli/src/__tests__/http.test.ts` to prove the fence was
 * load-bearing. All three cases still PASSED — and the run overwrote the
 * operator's real `~/.igris/.install-source.json`. The test succeeded BY
 * reading and writing real operator state, so the fence's absence was
 * invisible to the suite. That is the failure this file pins.
 *
 * THE MECHANISM: TWO stand-in homes, never the real one.
 *   H_real  — the stand-in PLAYING the operator's home. Seeded with a
 *             real-shaped file; its sha is the witness.
 *   H_fence — the sandbox the fence points at.
 * `HOME` is set to `H_real` in BOTH arms. The only difference between the arms
 * is whether the fence runs. The operator's real `$HOME` is never assigned to
 * `HOME` and never written — and `expect(H_real).not.toBe(IGRIS_REAL_HOME)`
 * is asserted before every arm, which is the single line that makes it
 * impossible for this witness to BECOME the incident (BUNDLE-TD456 rule 2).
 *
 * WHY TWO WITNESSES.
 *   W1 reproduces the reported incident (`.install-source.json`). It can no
 *      longer show that HEAD is exposed, because TD-301 repaired
 *      `http.test.ts` itself.
 *   W2 is the one found during BR-106 planning and is what proves HEAD is
 *      STILL exposed: `install.test.ts` drives `runInstall()` 19 times with
 *      only `IGRIS_BRAIN_DIR` set, and `install.ts:272` calls
 *      `registerMcpInClaudeJson()` with NO arguments -> `claudeJsonPath()` ->
 *      `join(homedir(), ".claude.json")`.
 *
 * EVERY ARM CARRIES A POSITIVE CONTROL. "Nothing changed" must be
 * distinguishable from "the writer is dead" (test_standards; BUNDLE-TD456
 * rule 4), so each fenced arm also asserts the write LANDED under `H_fence`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertHomeFenced, fenceHome, realHome, type HomeFence } from "./home-fence.js";
import type { InstallSource } from "../types.js";

const sha256 = (b: Buffer | string): string =>
  createHash("sha256").update(b).digest("hex");

/** Key-sorted canonical JSON, so a subtree sha is stable across key order. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonical(o[k])]));
  }
  return v;
}

/**
 * sha of the `mcpServers` SUBTREE, not of the whole file — the harness
 * rewrites `~/.claude.json` from memory mid-session, so a whole-file sha is
 * noisy (BR-099, `registry-project-mcp.test.ts:86-90`). Here the file is a
 * stand-in and nothing else writes it, but the witness uses the same
 * instrument as the belt it mirrors.
 */
function mcpSubtreeSha(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mcpServers?: unknown };
  return sha256(JSON.stringify(canonical(parsed.mcpServers ?? null)));
}

let savedHome: string | undefined;
let savedBrainDir: string | undefined;
let hReal: string;
let fence: HomeFence | null;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedBrainDir = process.env.IGRIS_BRAIN_DIR;
  fence = null;
  hReal = mkdtempSync(join(tmpdir(), "br106-standin-real-"));
});

afterEach(() => {
  fence?.release();
  // Restore BY KEY. `process.env = saved` swaps in a plain object and later
  // HOME writes stop reaching libuv's getenv (test_standards).
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = savedBrainDir;
  rmSync(hReal, { recursive: true, force: true });
});

/**
 * Point `HOME` at the stand-in that is PLAYING the operator's home, and prove
 * it is not the operator's actual home before returning.
 */
function enterStandIn(): void {
  expect(
    hReal,
    "BR-106 witness UNSAFE: the stand-in IS the operator's real home",
  ).not.toBe(realHome());
  process.env.HOME = hReal;
  expect(homedir(), "the stand-in is ARMED, not assumed").toBe(hReal);
}

// ===========================================================================
// W1 — the literal incident: ~/.igris/.install-source.json
// ===========================================================================

/** The operator's real record shape, as read from disk on 2026-09-10. */
const SEED_RECORD: InstallSource = {
  schema_version: 1,
  channel: "release",
  ref: "v7.3.2",
  fetched_at: "2026-09-07T00:00:00Z",
  content_sha256: "0".repeat(64),
  source: "from-source",
  source_path: "/Users/operator/StudioProjects/igris-ai",
};

/** What the incident's run wrote over it. */
const CLOBBER_RECORD: InstallSource = {
  schema_version: 2,
  channel: "main",
  ref: "main",
  fetched_at: "2026-09-08T00:00:00Z",
  content_sha256: "d".repeat(64),
  source: "github",
  source_path: null,
};

function seedInstallSource(home: string): { path: string; sha: string } {
  const dir = join(home, ".igris");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".install-source.json");
  writeFileSync(path, JSON.stringify(SEED_RECORD, null, 2) + "\n");
  return { path, sha: sha256(readFileSync(path)) };
}

describe("BR-106 W1 — an unfenced test overwrites ~/.igris/.install-source.json", () => {
  it("UNFENCED: writeInstallSource clobbers the stand-in operator's record", async () => {
    const { path, sha } = seedInstallSource(hReal);
    enterStandIn();
    // THE UNFENCED CONDITION — the incident's exact state: HOME points at a
    // real home and IGRIS_BRAIN_DIR is absent, so brainDir() falls back to
    // join(homedir(), ".igris").
    delete process.env.IGRIS_BRAIN_DIR;

    const { writeInstallSource } = await import("../lib/install-source.js");
    writeInstallSource(CLOBBER_RECORD);

    // Two assertions: a moved sha alone cannot tell a clobber from a touch.
    expect(sha256(readFileSync(path))).not.toBe(sha);
    const after = JSON.parse(readFileSync(path, "utf-8")) as InstallSource;
    expect(after.source).toBe("github");
    expect(after.source_path).toBeNull();
  });

  it("FENCED: the same call leaves the stand-in byte-identical and lands under the fence", async () => {
    const { path, sha } = seedInstallSource(hReal);
    enterStandIn();
    delete process.env.IGRIS_BRAIN_DIR;

    fence = fenceHome("br106-w1-fence-");
    fence.assertArmed();

    const { writeInstallSource } = await import("../lib/install-source.js");
    writeInstallSource(CLOBBER_RECORD);

    // The stand-in operator's record is untouched...
    expect(sha256(readFileSync(path))).toBe(sha);
    // ...and the writer is ALIVE — "nothing changed" must be distinguishable
    // from "the SUT never ran".
    const fenced = join(fence.brainDir, ".install-source.json");
    expect(existsSync(fenced)).toBe(true);
    expect(
      (JSON.parse(readFileSync(fenced, "utf-8")) as InstallSource).source,
    ).toBe("github");
  });
});

// ===========================================================================
// W2 — the live one: ~/.claude.json, the `repair` branch
// ===========================================================================

/**
 * A registered entry whose `args[0]` does NOT exist on disk. That is exactly
 * `planClaudeMcpRegistration`'s `repair` branch (`mcp-register.ts:1667-1669`)
 * — and `repair` is the reachable state during any `cli/dist` rebuild, which
 * is what makes `install.test.ts`'s 19 unfenced `runInstall()` calls live.
 */
function seedClaudeJson(home: string): { path: string; sha: string } {
  const path = join(home, ".claude.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        numStartups: 42,
        mcpServers: {
          "igris-brain": {
            command: "node",
            args: [join(home, "does", "not", "exist", "index.js")],
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  return { path, sha: mcpSubtreeSha(path) };
}

describe("BR-106 W2 — an unfenced test rewrites ~/.claude.json's igris-brain entry", () => {
  it("UNFENCED: install step 11's exact call re-points the stand-in's mcpServers entry", async () => {
    const { path, sha } = seedClaudeJson(hReal);
    enterStandIn();

    const { bundledMcpEntryPath } = await import("../lib/paths.js");
    const { inspectMcpRegistration, planClaudeMcpRegistration, registerMcpInClaudeJson } =
      await import("../lib/mcp-register.js");

    // NAME the branch. If policy changes so this is no longer `repair`, this
    // reds here rather than silently making the witness vacuous.
    const plan = planClaudeMcpRegistration(
      inspectMcpRegistration(),
      bundledMcpEntryPath(),
    );
    expect(plan.action).toBe("repair");

    // `install.ts:272` verbatim — no arguments, so the writer resolves
    // `claudeJsonPath()` -> `join(homedir(), ".claude.json")`.
    const res = registerMcpInClaudeJson();

    expect(res.outcome).not.toBe("failed");
    expect(res.claudeJsonPath).toBe(path);
    expect(mcpSubtreeSha(path)).not.toBe(sha);
    // The rolling backup is the second, independent trace the incident left.
    expect(existsSync(`${path}.igris.bak`)).toBe(true);
  });

  it("FENCED: the stand-in's subtree is unchanged, no backup is minted, and the write lands under the fence", async () => {
    const { path, sha } = seedClaudeJson(hReal);
    enterStandIn();

    fence = fenceHome("br106-w2-fence-");
    fence.assertArmed();

    const { registerMcpInClaudeJson } = await import("../lib/mcp-register.js");
    const res = registerMcpInClaudeJson();

    // The stand-in operator's config is untouched, by BOTH traces.
    expect(mcpSubtreeSha(path)).toBe(sha);
    expect(existsSync(`${path}.igris.bak`)).toBe(false);
    // ...and the writer is ALIVE, under the fence.
    expect(res.outcome).not.toBe("failed");
    expect(res.claudeJsonPath).toBe(join(fence.home, ".claude.json"));
    expect(existsSync(join(fence.home, ".claude.json"))).toBe(true);
  });
});

// ===========================================================================
// The fence helper's own arm-check — `fenceHome(` is a token in the guard's
// predicate, so it must have teeth or the predicate is a name with no meaning.
// ===========================================================================

describe("BR-106 — assertHomeFenced refuses each way a fence can be absent", () => {
  it("refuses an empty fence path", () => {
    expect(() => assertHomeFenced("")).toThrow(/fence path is empty/);
  });

  it("refuses when homedir() did not move to the fence", () => {
    const elsewhere = join(hReal, "not-where-home-points");
    expect(() => assertHomeFenced(elsewhere)).toThrow(/homedir\(\) is /);
  });

  it("refuses when the fence IS the operator's real home", () => {
    const saved = process.env.IGRIS_REAL_HOME;
    try {
      // Arm the condition against the STAND-IN: declare the stand-in to be the
      // real home, then point HOME at it. Never the operator's actual home.
      process.env.IGRIS_REAL_HOME = hReal;
      process.env.HOME = hReal;
      expect(homedir()).toBe(hReal);
      expect(() => assertHomeFenced(hReal)).toThrow(/IS the operator's real home/);
    } finally {
      if (saved === undefined) delete process.env.IGRIS_REAL_HOME;
      else process.env.IGRIS_REAL_HOME = saved;
    }
  });

  it("fenceHome arms a home that is neither the caller's nor the real one, and release() restores BY KEY", () => {
    enterStandIn();
    const before = process.env.HOME;
    const f = fenceHome("br106-armcheck-");
    try {
      expect(f.home).not.toBe(before);
      expect(f.home).not.toBe(realHome());
      expect(homedir()).toBe(f.home);
      expect(process.env.IGRIS_BRAIN_DIR).toBe(f.brainDir);
    } finally {
      f.release();
    }
    expect(process.env.HOME).toBe(before);
    // Restored by key, so the OS resolver still tracks it.
    expect(homedir()).toBe(before);
  });
});
