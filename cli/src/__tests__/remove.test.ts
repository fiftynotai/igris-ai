/**
 * FR-203: `igris remove` dispatcher + round-trip tests.
 *
 * Covers: the 4-arm routing + unknown-surface usage error, the D1 mode resolver
 * (flags + the printed mode, shared with `add`), the INVERTED no-phantom-success
 * loud-fail (nothing to remove → non-zero + actionable), the destructive `--yes`
 * confirm, the builtin-agent guard, the MCP/hook neighbor-preservation un-merge,
 * and — the headline acceptance — a REAL-filesystem round-trip per personal
 * surface (`add` then `remove` → drift-clean ABSENT + on-disk state restored).
 *
 * Personal-mode round-trips use real overlay/config files in a sandbox brain
 * root; the ABSENT-verify uses the `captureAdapter` seam (no shell spawn). The
 * mode/routing/guard tests use injected `removeCore*Fn`/`removeBlockFn` seams.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRemove } from "../verbs/remove.js";
import { runLoadout } from "../verbs/loadout.js";
import type { AdapterCaptureFn } from "../verbs/harness.js";
import type { RemoveMaterializeResult } from "../verbs/loadout.js";
import type { RemoveCoreResult } from "../verbs/remove-core.js";

const BRAIN = "/tmp/igris-test-brain-remove";

// --- stdout/stderr capture -------------------------------------------------
function captureStreams(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out.push(typeof c === "string" ? c : Buffer.from(c).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err.push(typeof c === "string" ? c : Buffer.from(c).toString("utf-8"));
    return true;
  }) as typeof process.stderr.write;
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = origOut as typeof process.stdout.write;
      process.stderr.write = origErr as typeof process.stderr.write;
    },
  };
}

let cap: ReturnType<typeof captureStreams>;
// TD-282 (vitest analog; FR-192 incident): some round-trip / dispatcher arms below
// invoke the REAL `skills` / `add-mcp` delegate, which resolves the GLOBAL skill +
// MCP store via $HOME (NOT IGRIS_BRAIN_DIR — that only isolates the brain). Without
// redirecting HOME those ops hit the developer's REAL ~/.claude/skills +
// ~/.agents/skills and can WIPE them (this file was the sole wiper found bisecting
// the suite). Sandbox HOME for EVERY test → the spawned delegate (which inherits
// process.env.HOME) lands in a throwaway tmp dir, never the operator's real store.
let savedHome: string | undefined;
let homeSandbox: string | undefined;
beforeEach(() => {
  cap = captureStreams();
  savedHome = process.env.HOME;
  homeSandbox = mkdtempSync(join(tmpdir(), "igris-remove-home-"));
  process.env.HOME = homeSandbox;
});
afterEach(() => {
  cap.restore();
  if (savedHome !== undefined) {
    process.env.HOME = savedHome;
  } else {
    delete process.env.HOME;
  }
  if (homeSandbox !== undefined) {
    rmSync(homeSandbox, { recursive: true, force: true });
    homeSandbox = undefined;
  }
});

// The ABSENT-verify check fake: drift-clean (the surface is GONE → success).
function absentCheckAdapter(): AdapterCaptureFn {
  return (scriptPath) => {
    if (scriptPath.includes("check_harness_drift.sh")) {
      // After removal the store no longer declares the surface → nothing matches.
      return {
        code: 0,
        output: "No skills/agents/mcp/hook targets matched (filter='x').\n",
      };
    }
    return { code: 0, output: "" };
  };
}

// An ABSENT-verify that reports the surface STILL PRESENT (un-projection missed).
function stillPresentCheckAdapter(): AdapterCaptureFn {
  return (scriptPath) => {
    if (scriptPath.includes("check_harness_drift.sh")) {
      return {
        code: 1,
        output: "FAIL  skills/claude — still present (drifted)\n",
      };
    }
    return { code: 0, output: "" };
  };
}

const removedBlock = (): RemoveMaterializeResult => ({
  ok: true,
  code: 0,
  removed: true,
  overlayWritten: "/overlay.json",
});

const absentBlock = (): RemoveMaterializeResult => ({
  ok: true,
  code: 0,
  removed: false,
  overlayWritten: "/overlay.json",
});

const removedCore = (): RemoveCoreResult => ({
  ok: true,
  code: 0,
  reason: "",
  removed: true,
  verifyOutput: "SUMMARY: 1 pairs — 1 MATCH, 0 MISMATCH",
});

describe("runRemove — dispatcher routing", () => {
  it("unknown surface → exit 2 + actionable message", async () => {
    const code = await runRemove({ surface: "bogus", name: "x", yes: true });
    expect(code).toBe(2);
    expect(cap.err.join("")).toContain("unknown surface 'bogus'");
  });

  it("missing name → exit 2", async () => {
    const code = await runRemove({ surface: "skill", yes: true });
    expect(code).toBe(2);
    expect(cap.err.join("")).toContain("<name> is required");
  });

  it("identity is NOT a valid surface (retired by M4)", async () => {
    const code = await runRemove({ surface: "identity", name: "x", yes: true });
    expect(code).toBe(2);
    expect(cap.err.join("")).toContain("unknown surface 'identity'");
  });
});

// ---------------------------------------------------------------------------
// C1 (§14 SECURITY): path-traversal in <name> before a destructive delete.
// ---------------------------------------------------------------------------
describe("runRemove — C1: name traversal guard (CRITICAL security)", () => {
  for (const surface of ["skill", "agent", "mcp", "hook"]) {
    it(`rejects a traversal <name> for ${surface} → exit 2, NO dispatch`, async () => {
      // A traversal name must be rejected at the boundary (before mode-resolve /
      // any fs-path derivation). --yes is set so the destructive path would run
      // if the guard were absent — the guard must fire FIRST.
      let dispatched = false;
      const code = await runRemove({
        surface,
        name: "../../../evil",
        yes: true,
        brainRoot: BRAIN,
        // Any dispatch into an arm would call one of these seams / the adapter.
        removeSkillBlockFn: () => {
          dispatched = true;
          return removedBlock();
        },
        removeMcpBlockFn: () => {
          dispatched = true;
          return removedBlock();
        },
        removeHookBlockFn: () => {
          dispatched = true;
          return removedBlock();
        },
        captureAdapter: () => {
          dispatched = true;
          return { code: 0, output: "" };
        },
      });
      expect(code).toBe(2);
      expect(dispatched).toBe(false);
      expect(cap.err.join("")).toContain("must match /^[a-z0-9][a-z0-9-]*$/");
    });
  }

  it("rejects an absolute-path <name> too", async () => {
    const code = await runRemove({ surface: "skill", name: "/etc/passwd", yes: true });
    expect(code).toBe(2);
    expect(cap.err.join("")).toContain("must match");
  });

  it("rejects a bare '..' <name>", async () => {
    const code = await runRemove({ surface: "hook", name: "..", yes: true, event: "PreToolUse" });
    expect(code).toBe(2);
  });

  // Defense-in-depth: the recursive-delete helpers themselves must NOT touch a
  // traversal path even if called directly (e.g. from another code path).
  it("removeSkillBlock does NOT recursively delete a traversal-named dir", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "igris-c1-skill-"));
    try {
      // A real dir OUTSIDE the loadout that a `../../../victim` would reach.
      const victim = join(tmp, "victim");
      mkdirSync(victim, { recursive: true });
      writeFileSync(join(victim, "important.txt"), "do not delete");
      const overlayPath = join(tmp, "overlay.json");
      writeFileSync(overlayPath, '{"version":1,"agents":[]}\n');

      const code = await runLoadout({
        action: "remove-skill",
        name: `../../../${join(tmp, "victim").slice(1)}`, // traversal toward victim
        overlayPath,
        // Point the skill vendor base AT the tmp root so a NAIVE join could land
        // on the victim — the guard must reject before that join is even built.
        skillVendorDir: (n: string) => join(tmp, "loadout", "skills", n),
      });
      expect(code).toBe(2);
      // The victim dir + its file are UNTOUCHED.
      expect(existsSync(victim)).toBe(true);
      expect(existsSync(join(victim, "important.txt"))).toBe(true);
      expect(cap.err.join("")).toContain("must match /^[a-z0-9][a-z0-9-]*$/");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removeHookBlock does NOT recursively delete a traversal-named script dir", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "igris-c1-hook-"));
    try {
      const victim = join(tmp, "victim");
      mkdirSync(victim, { recursive: true });
      writeFileSync(join(victim, "keep.sh"), "echo keep");
      const overlayPath = join(tmp, "overlay.json");
      writeFileSync(overlayPath, '{"version":1,"agents":[]}\n');

      const code = await runLoadout({
        action: "remove-hook",
        name: "../../../evil",
        overlayPath,
        hookScriptRoot: join(tmp, "loadout", "hooks"),
      });
      expect(code).toBe(2);
      expect(existsSync(victim)).toBe(true);
      expect(existsSync(join(victim, "keep.sh"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Happy-path regression: a VALID name still removes cleanly through the guard.
  it("a valid name (my-skill) passes the guard and removes cleanly", async () => {
    const code = await runRemove({
      surface: "skill",
      name: "my-skill",
      noCore: true,
      yes: true,
      brainRoot: BRAIN,
      removeSkillBlockFn: removedBlock,
      captureAdapter: absentCheckAdapter(),
    });
    expect(code).toBe(0);
    expect(cap.out.join("")).toContain("drift-clean (ABSENT)");
  });
});

describe("runRemove — resolved mode is PRINTED (symmetric with add, D1)", () => {
  it("prints PERSONAL mode + --core/--no-core honored", async () => {
    await runRemove({
      surface: "skill",
      name: "foo",
      noCore: true,
      yes: true,
      brainRoot: BRAIN,
      removeSkillBlockFn: removedBlock,
      captureAdapter: absentCheckAdapter(),
    });
    expect(cap.out.join("")).toContain("operating in PERSONAL mode");
  });

  it("prints CORE mode when routed to core", async () => {
    await runRemove({
      surface: "skill",
      name: "foo",
      core: true,
      projectRoot: "/repo",
      yes: true,
      brainRoot: BRAIN,
      removeCoreSkillFn: removedCore,
      captureAdapter: absentCheckAdapter(),
    });
    expect(cap.out.join("")).toContain("operating in CORE mode");
  });

  it("--core + --no-core together is a usage error", async () => {
    const code = await runRemove({
      surface: "skill",
      name: "foo",
      core: true,
      noCore: true,
      yes: true,
    });
    expect(code).toBe(2);
    expect(cap.err.join("")).toContain("mutually exclusive");
  });
});

describe("runRemove — INVERTED no-phantom-success (CRITICAL)", () => {
  it("nothing projected + nothing in the store → LOUD FAIL, never a phantom success", async () => {
    const code = await runRemove({
      surface: "skill",
      name: "ghost",
      noCore: true,
      yes: true,
      brainRoot: BRAIN,
      // The block was already absent (removed:false) and there are no symlinks.
      removeSkillBlockFn: absentBlock,
      captureAdapter: absentCheckAdapter(),
    });
    expect(code).not.toBe(0);
    expect(cap.err.join("")).toContain("nothing was de-projected");
    expect(cap.err.join("")).toContain("already absent");
  });

  it("a post-removal empty check is SUCCESS (the empty-match inversion)", async () => {
    // The store block WAS removed (removed:true); the check matches nothing for
    // the name → for REMOVE that is the ABSENT verdict = success (NOT the bug).
    const code = await runRemove({
      surface: "skill",
      name: "foo",
      noCore: true,
      yes: true,
      brainRoot: BRAIN,
      removeSkillBlockFn: removedBlock,
      captureAdapter: absentCheckAdapter(),
    });
    expect(code).toBe(0);
    expect(cap.out.join("")).toContain("drift-clean (ABSENT)");
  });

  it("a still-PRESENT check row is a LOUD FAIL (un-projection missed a target)", async () => {
    const code = await runRemove({
      surface: "skill",
      name: "foo",
      noCore: true,
      yes: true,
      brainRoot: BRAIN,
      removeSkillBlockFn: removedBlock,
      captureAdapter: stillPresentCheckAdapter(),
    });
    expect(code).not.toBe(0);
    expect(cap.err.join("")).toContain("still present");
  });
});

describe("runRemove — destructive confirm (the one asymmetry vs add)", () => {
  it("aborts (exit 0, no removal) when confirm returns false and --yes is absent", async () => {
    let removeCalled = false;
    const code = await runRemove({
      surface: "skill",
      name: "foo",
      noCore: true,
      brainRoot: BRAIN,
      confirm: async () => false,
      removeSkillBlockFn: () => {
        removeCalled = true;
        return removedBlock();
      },
      captureAdapter: absentCheckAdapter(),
    });
    expect(code).toBe(0);
    expect(removeCalled).toBe(false);
    expect(cap.out.join("")).toContain("aborted (not confirmed)");
  });

  it("the confirm message names the resolved targets + the destructive warning", async () => {
    let seen = "";
    await runRemove({
      surface: "skill",
      name: "foo",
      noCore: true,
      brainRoot: BRAIN,
      confirm: async (msg) => {
        seen = msg;
        return false;
      },
      removeSkillBlockFn: removedBlock,
      captureAdapter: absentCheckAdapter(),
    });
    expect(seen).toContain("will de-project");
    expect(seen).toContain("destructive");
  });
});

describe("runRemove agent — builtin-agent guard", () => {
  it("refuses to remove a builtin agent without --force", async () => {
    const code = await runRemove({
      surface: "agent",
      name: "architect",
      noCore: true,
      yes: true,
      brainRoot: BRAIN,
      captureAdapter: absentCheckAdapter(),
    });
    expect(code).not.toBe(0);
    expect(cap.err.join("")).toContain("BUILTIN agent");
  });
});

// ---------------------------------------------------------------------------
// REAL-filesystem round-trips: add → remove → assert ABSENT + byte-restored.
// ---------------------------------------------------------------------------

describe("round-trip: personal skill (add → remove → restored)", () => {
  let tmpRoot: string;
  let overlayPath: string;
  let originsPath: string;
  let projectRoot: string;
  let vendorBase: string;
  let skillSrc: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "igris-rt-skill-"));
    overlayPath = join(tmpRoot, "overlay.json");
    originsPath = join(tmpRoot, "origins.json");
    vendorBase = join(tmpRoot, "loadout");
    projectRoot = join(tmpRoot, "proj");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "harness-manifest.json"), '{"version":1,"agents":[]}\n');
    skillSrc = join(tmpRoot, "src", "rttool");
    mkdirSync(skillSrc, { recursive: true });
    writeFileSync(
      join(skillSrc, "SKILL.md"),
      '---\nname: rttool\ndescription: "x - usage: /rttool"\n---\nbody\n',
    );
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("add writes the overlay block + vendored tree; remove restores both", async () => {
    const linkParent = join(tmpRoot, "projected");
    mkdirSync(linkParent, { recursive: true });

    // ADD (write-only loadout primitive — the projection symlink is created by
    // the harness compiler, which we don't run here; the round-trip asserts the
    // STORE side restores byte-for-byte).
    const addCode = await runLoadout({
      action: "add-skill",
      name: "rttool",
      from: skillSrc,
      targets: [`claude:symlink:${linkParent}`],
      projectRoot,
      overlayPath,
      originsPath,
      skillVendorDir: (n: string) => join(vendorBase, "skills", n),
    });
    expect(addCode).toBe(0);
    expect(readFileSync(overlayPath, "utf-8")).toContain("rttool");
    expect(existsSync(join(vendorBase, "skills", "rttool"))).toBe(true);

    // The pre-add overlay state: no surfaces.skills block.
    // REMOVE (personal de-materialize: splice block + drop origin + delete vendor).
    const remCode = await runLoadout({
      action: "remove-skill",
      name: "rttool",
      projectRoot,
      overlayPath,
      originsPath,
      skillVendorDir: (n: string) => join(vendorBase, "skills", n),
    });
    expect(remCode).toBe(0);

    // The overlay no longer declares the skill block (byte-restored — the
    // surfaces.skills key is dropped when empty).
    const overlay = JSON.parse(readFileSync(overlayPath, "utf-8"));
    expect(overlay.surfaces?.skills).toBeUndefined();
    // The vendored tree is gone (no orphan copies).
    expect(existsSync(join(vendorBase, "skills", "rttool"))).toBe(false);
    // The origin sidecar entry is gone.
    if (existsSync(originsPath)) {
      const origins = JSON.parse(readFileSync(originsPath, "utf-8"));
      expect(origins["skill:rttool"]).toBeUndefined();
    }
  });
});

describe("round-trip: personal agent (loadout remove restores overlay)", () => {
  let tmpRoot: string;
  let overlayPath: string;
  let originsPath: string;
  let projectRoot: string;
  let vendorBase: string;
  let agentSrc: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "igris-rt-agent-"));
    overlayPath = join(tmpRoot, "overlay.json");
    originsPath = join(tmpRoot, "origins.json");
    vendorBase = join(tmpRoot, "loadout");
    projectRoot = join(tmpRoot, "proj");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "harness-manifest.json"), '{"version":1,"agents":[]}\n');
    agentSrc = join(tmpRoot, "src", "rtbot");
    mkdirSync(agentSrc, { recursive: true });
    writeFileSync(
      join(agentSrc, "rtbot.md"),
      '---\nname: rtbot\ndescription: "x"\n---\nbody\n',
    );
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("add then remove restores the overlay agents array + drops the vendor dir", async () => {
    const addCode = await runLoadout({
      action: "add",
      name: "rtbot",
      from: agentSrc,
      targets: ["codex:.codex/agents/rtbot.toml"],
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir: (n: string) => join(vendorBase, "agents", n),
    });
    expect(addCode).toBe(0);
    expect(readFileSync(overlayPath, "utf-8")).toContain("rtbot");

    const remCode = await runLoadout({
      action: "remove",
      name: "rtbot",
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir: (n: string) => join(vendorBase, "agents", n),
    });
    expect(remCode).toBe(0);
    const overlay = JSON.parse(readFileSync(overlayPath, "utf-8"));
    expect(overlay.agents).toEqual([]);
    expect(existsSync(join(vendorBase, "agents", "rtbot"))).toBe(false);
  });
});

describe("round-trip: personal mcp un-merge preserves neighbors", () => {
  let tmpRoot: string;
  let configPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "igris-rt-mcp-"));
    configPath = join(tmpRoot, "claude.json");
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("project two servers then unproject ONE → the other survives byte-for-byte", async () => {
    // Seed a config with TWO mcp servers via project-mcp-style merge (use the
    // JSON merger through a manual write to keep the test focused on un-merge).
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            keepme: { command: "node", args: ["keep.js"] },
            removeme: { command: "node", args: ["rm.js"] },
          },
          otherTopLevel: { preserved: true },
        },
        null,
        2,
      ) + "\n",
    );

    const code = await runLoadout({
      action: "unproject-mcp",
      name: "removeme",
      harness: "claude",
      configPath,
    });
    expect(code).toBe(0);

    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    // The removed server is gone.
    expect(parsed.mcpServers.removeme).toBeUndefined();
    // The neighbor survives byte-for-byte.
    expect(parsed.mcpServers.keepme).toEqual({ command: "node", args: ["keep.js"] });
    // Other top-level keys are preserved.
    expect(parsed.otherTopLevel).toEqual({ preserved: true });
  });

  it("un-merging an absent server is an idempotent no-op (unchanged)", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { keepme: { command: "node" } } }, null, 2) + "\n",
    );
    const before = readFileSync(configPath, "utf-8");
    const code = await runLoadout({
      action: "unproject-mcp",
      name: "ghost",
      harness: "claude",
      configPath,
    });
    expect(code).toBe(0);
    // Idempotent — the file is unchanged.
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("un-merging the LAST server drops the mcpServers map (byte-restores)", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { only: { command: "node" } }, keep: 1 }, null, 2) + "\n",
    );
    const code = await runLoadout({
      action: "unproject-mcp",
      name: "only",
      harness: "claude",
      configPath,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.keep).toBe(1);
  });
});

describe("round-trip: personal hook un-merge preserves neighbors", () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "igris-rt-hook-"));
    settingsPath = join(tmpRoot, "settings.json");
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("unproject-hook splices the named group + preserves a user group + drops empty hooks", async () => {
    // The personal command path for (my-guard, PreToolUse).
    const cmd = "$HOME/.igris/loadout/hooks/my-guard/PreToolUse.sh";
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: "Write", hooks: [{ type: "command", command: cmd }] },
              {
                matcher: "Read",
                hooks: [{ type: "command", command: "/user/own/hook.sh" }],
              },
            ],
          },
          model: "opus",
        },
        null,
        2,
      ) + "\n",
    );

    const code = await runLoadout({
      action: "unproject-hook",
      name: "my-guard",
      harness: "claude",
      event: "PreToolUse",
      hookSettingsPath: settingsPath,
    });
    expect(code).toBe(0);

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // The igris group is gone; the user's own group survives.
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("Read");
    // Other top-level keys preserved.
    expect(parsed.model).toBe("opus");
  });

  it("un-merging the only group drops hooks entirely (byte-restores)", async () => {
    const cmd = "$HOME/.igris/loadout/hooks/solo/SessionStart.sh";
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: cmd }] }] },
          keep: true,
        },
        null,
        2,
      ) + "\n",
    );
    const code = await runLoadout({
      action: "unproject-hook",
      name: "solo",
      harness: "claude",
      event: "SessionStart",
      hookSettingsPath: settingsPath,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.keep).toBe(true);
  });

  it("opencode hook un-project is a covered no-op (the shared plugin is never removed)", async () => {
    const code = await runLoadout({
      action: "unproject-hook",
      name: "anything",
      harness: "opencode",
      event: "PreToolUse",
    });
    expect(code).toBe(0);
    expect(cap.out.join("")).toContain("covered by the FR-104 plugin");
  });
});

// ---------------------------------------------------------------------------
// FR-212b: runRemove mcp under the DELEGATE engine (Warden Major — the
// grant-REVOCATION arm `removeMcpViaDelegate` was untested; a silently-skipped
// revoke leaves a stale no-prompt grant for a just-removed server). Mirrors the
// SYMMETRIC register suite (mcp-register.test.ts "registerBrainAcrossHarnesses —
// DELEGATE engine"), asserting the INVERSE: revoke via add-mcp remove +
// removeBrainGrant, the loud revoke-failure, and the custom default unchanged.
//
// The arm is driven through the full `runRemove` (personal mode) with a seeded
// overlay so `mcpStoreWasPresent` is true (the arm proceeds past
// loudNothingToRemove). The add-mcp remove + grant revoke are SPIED via the
// `unregisterMcpFn`/`removeGrantFn` seams; the store de-materialize is the
// `removeMcpBlockFn` seam; the ABSENT-verify is the `captureAdapter` seam (no
// shell spawn). The engine is forced via `mcpEngine:"delegate"`.
// ---------------------------------------------------------------------------
describe("runRemove mcp — DELEGATE engine grant revocation (FR-212b)", () => {
  let tmpRoot: string;
  let overlayPath: string;
  const PROJECT_ROOT = "/abs/proj/root";

  /** A fake add-mcp `remove` verdict (ok by default). */
  function okUnregister() {
    return { ok: true, exitCode: 0, stdout: "Removed igris-brain", stderr: "", argv: [] };
  }
  /** A fake grant-revoke result (revoked by default). */
  function revokedGrant(harness: string) {
    return { harness: harness as never, outcome: "revoked" as const, path: `/fake/${harness}` };
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "igris-rm-mcp-delegate-"));
    overlayPath = join(tmpRoot, "overlay.json");
    // Seed the overlay with the mcp block so mcpStoreWasPresent() is true and the
    // arm proceeds (the no-phantom-success snapshot reads the REAL overlay).
    writeFileSync(
      overlayPath,
      JSON.stringify(
        { surfaces: { mcp_servers: [{ name: "brain-test" }] } },
        null,
        2,
      ) + "\n",
    );
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("revokes the grant for the targeted harnesses + routes un-register via add-mcp (NOT unmerge*)", async () => {
    const unregisterSpy = vi.fn(okUnregister);
    const revokeSpy = vi.fn(revokedGrant);
    const code = await runRemove({
      surface: "mcp",
      name: "brain-test",
      noCore: true,
      yes: true,
      overlayPath,
      brainRoot: BRAIN,
      projectRoot: PROJECT_ROOT,
      unregisterMcpFn: unregisterSpy,
      removeGrantFn: revokeSpy,
      // The store de-materialize is faked so the test is hermetic.
      removeMcpBlockFn: removedBlock,
      captureAdapter: absentCheckAdapter(),
    });
    expect(code).toBe(0);

    // 1) add-mcp remove was called ONCE with the agent-id-mapped harness set
    // (claude→claude-code, gemini→gemini-cli, the rest pass through) — the
    // delegate un-register, NOT the custom unproject-mcp/unmerge* loop.
    // FR-212d: antigravity is CARVED OUT of the tool call (its entry was written
    // by the custom merger to the config/ path; `add-mcp remove` targets the
    // wrong antigravity/ path and would orphan it). It is un-merged via the custom
    // un-merger instead, so it is ABSENT from the add-mcp remove agent set.
    expect(unregisterSpy).toHaveBeenCalledTimes(1);
    const [unregName, unregOpts] = unregisterSpy.mock.calls[0];
    expect(unregName).toBe("brain-test");
    // TD-283: the default un-project set is now descriptor-derived
    // (`mcpTargetTypes()` = every mcp harness), so cursor→cursor joins the
    // add-mcp remove agent set (antigravity stays carved out to the custom
    // un-merger). Was a hardcoded pre-cursor 5-list.
    expect(unregOpts?.harnesses).toEqual([
      "claude-code",
      "codex",
      "gemini-cli",
      "opencode",
      "cursor",
    ]);
    expect(unregOpts?.harnesses).toContain("cursor");
    expect(unregOpts?.harnesses).not.toContain("antigravity");
    expect(unregOpts?.global).toBe(true);

    // 2) the grant was REVOKED for every targeted harness (the security arm),
    // keyed off the loadout id, with the project-root folder for the
    // folder-scoped harnesses. TD-283: cursor is in the set (its grant is
    // `covered`, so the REAL removeBrainGrant is a covered no-op for it — here
    // the fake revoke just proves cursor is looped, like opencode).
    expect(revokeSpy).toHaveBeenCalledTimes(6);
    const revokedHarnesses = revokeSpy.mock.calls.map((c) => c[0]);
    expect([...revokedHarnesses].sort()).toEqual(
      ["antigravity", "claude", "codex", "cursor", "gemini", "opencode"].sort(),
    );
    expect(revokedHarnesses).toContain("cursor");
    expect(revokeSpy.mock.calls[0][1]?.folder).toBe(PROJECT_ROOT);
  });

  it("restricts the revoke to a SINGLE --target harness when given", async () => {
    const unregisterSpy = vi.fn(okUnregister);
    const revokeSpy = vi.fn(revokedGrant);
    const code = await runRemove({
      surface: "mcp",
      name: "brain-test",
      noCore: true,
      yes: true,
      target: "claude",
      overlayPath,
      brainRoot: BRAIN,
      projectRoot: PROJECT_ROOT,
      unregisterMcpFn: unregisterSpy,
      removeGrantFn: revokeSpy,
      removeMcpBlockFn: removedBlock,
      captureAdapter: absentCheckAdapter(),
    });
    expect(code).toBe(0);
    // Only claude → claude-code is unregistered + revoked.
    expect(unregisterSpy.mock.calls[0][1]?.harnesses).toEqual(["claude-code"]);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy.mock.calls[0][0]).toBe("claude");
  });

  it("a grant-revoke FAILURE produces EXIT 1 — the loud security arm (inverse of register's non-fatal grant)", async () => {
    const unregisterSpy = vi.fn(okUnregister);
    // The add-mcp remove succeeds, but the grant revoke fails on the 2nd harness.
    const revokeSpy = vi.fn((harness: string) => {
      if (harness === "codex") {
        return {
          harness: harness as never,
          outcome: "failed" as const,
          path: "/fake/codex/config.toml",
          error: "could not write codex config",
        };
      }
      return revokedGrant(harness);
    });
    const code = await runRemove({
      surface: "mcp",
      name: "brain-test",
      noCore: true,
      yes: true,
      overlayPath,
      brainRoot: BRAIN,
      projectRoot: PROJECT_ROOT,
      unregisterMcpFn: unregisterSpy,
      removeGrantFn: revokeSpy,
      removeMcpBlockFn: removedBlock,
      captureAdapter: absentCheckAdapter(),
    });
    // A silently-skipped revoke would leave a stale no-prompt grant — so a revoke
    // FAILURE must be LOUD (exit 1), never swallowed.
    expect(code).toBe(1);
    expect(cap.err.join("")).toContain("grant revoke for codex failed");
  });

  it("an add-mcp remove FAILURE produces EXIT 1 (the grant revoke is not reached)", async () => {
    const unregisterSpy = vi.fn(() => ({
      ok: false,
      exitCode: 4,
      stdout: "",
      stderr: "add-mcp remove boom",
      argv: [],
    }));
    const revokeSpy = vi.fn(revokedGrant);
    const code = await runRemove({
      surface: "mcp",
      name: "brain-test",
      noCore: true,
      yes: true,
      overlayPath,
      brainRoot: BRAIN,
      projectRoot: PROJECT_ROOT,
      unregisterMcpFn: unregisterSpy,
      removeGrantFn: revokeSpy,
      removeMcpBlockFn: removedBlock,
      captureAdapter: absentCheckAdapter(),
    });
    expect(code).toBe(1);
    expect(cap.err.join("")).toContain("'add-mcp remove' exited 4");
    // The grant revoke is NOT attempted when the server un-register failed.
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it("a binary-resolution throw in add-mcp remove is caught → EXIT 1 (never a network fetch)", async () => {
    const unregisterSpy = vi.fn(() => {
      throw new Error("refusing to invoke a non-local add-mcp binary");
    });
    const revokeSpy = vi.fn(revokedGrant);
    const code = await runRemove({
      surface: "mcp",
      name: "brain-test",
      noCore: true,
      yes: true,
      overlayPath,
      brainRoot: BRAIN,
      projectRoot: PROJECT_ROOT,
      unregisterMcpFn: unregisterSpy,
      removeGrantFn: revokeSpy,
      removeMcpBlockFn: removedBlock,
      captureAdapter: absentCheckAdapter(),
    });
    expect(code).toBe(1);
    expect(cap.err.join("")).toContain("non-local add-mcp binary");
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  // FR-212d Phase 2: the "CUSTOM default (flag unset) runs the unmerge* path"
  // test was DELETED — there is no longer a custom MCP-remove engine. With the
  // flag retired, `igris remove mcp` ALWAYS routes through the delegate
  // (`add-mcp remove` + grant revoke), with antigravity carved out to the custom
  // un-merger at its correct read-path INSIDE `removeMcpViaDelegate`. The
  // delegate is now the DEFAULT engine — the test below proves the flip took
  // effect (no engine override → the add-mcp/grant spies fire).
  it("FR-212d: flag-unset remove mcp routes through the delegate by DEFAULT", async () => {
    const unregisterSpy = vi.fn(okUnregister);
    const revokeSpy = vi.fn(revokedGrant);
    const code = await runRemove({
      surface: "mcp",
      name: "brain-test",
      noCore: true,
      yes: true,
      overlayPath,
      brainRoot: BRAIN,
      projectRoot: PROJECT_ROOT,
      // No engine override → delegate (the only engine now).
      unregisterMcpFn: unregisterSpy,
      removeGrantFn: revokeSpy,
      removeMcpBlockFn: removedBlock,
      captureAdapter: absentCheckAdapter(),
    });
    expect(code).toBe(0);
    // The delegate path WAS taken — the add-mcp remove + grant revoke spies fired.
    expect(unregisterSpy).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalled();
  });
});
