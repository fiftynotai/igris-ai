/**
 * FR-212a: unit tests for the SKILLS DELEGATE module (cli/src/lib/skills-delegate.ts).
 *
 * Posture (constraint #2 + the brief's GATE): these are UNIT tests — the spawn
 * is ALWAYS spied (a `vi.fn()` injected via the `spawn` dep), NEVER the real
 * `skills` CLI. The binary resolver is likewise injected with a fake ABSOLUTE
 * path so the argv assertions don't depend on the installed package layout. The
 * ONE test that exercises the REAL `resolveSkillsBinary` only asserts the
 * resolved path is absolute + on-disk + not `npx` (the supply-chain invariant),
 * never spawns it.
 *
 * Coverage:
 *   1. resolveSkillsEngine defaults to "custom"; only "delegate" opts in.
 *   2. The REAL binary resolves to a LOCAL absolute on-disk path, never `npx`.
 *   3. assertLocalSkillsBinary rejects `npx` / bare / non-existent.
 *   4. buildSkillsAddArgv: `add <abs> -g -a <agents…> -y`, the Igris harness
 *      ids (gemini-cli not gemini), --copy mode, abs-path guard.
 *   5. buildSkillsRemoveArgv: `remove <name> -g --all -y`, empty-name guard.
 *   6. projectSkillsViaTool / unprojectSkillsViaTool: spy the spawn, assert the
 *      argv[0] is the LOCAL binary (no bare npx), the verdict parser keys on the
 *      exit code, and NO inline secret pattern appears in any logged argv.
 */

import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  assertLocalSkillsBinary,
  buildSkillsAddArgv,
  buildSkillsRemoveArgv,
  projectSkillsViaTool,
  resolveSkillsBinary,
  resolveSkillsEngine,
  unprojectSkillsViaTool,
} from "../lib/skills-delegate.js";
// FR-217: the default skills target set is now descriptor-derived; assert against
// the accessor the SUT reads (skillAgentIds()), not the deleted hardcoded const.
import { skillAgentIds } from "../lib/harness-descriptor.js";

/** A fake absolute binary path for the injected resolver (never spawned). */
const FAKE_BIN = "/abs/node_modules/skills/bin/cli.mjs";

/** Build a fake spawnSync return for a given exit status + streams. */
function fakeSpawn(opts: {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}) {
  // NB: use `in` (not `??`) for status so an explicit `null` (a killed/never-
  // spawned process) survives — `null ?? 0` would coerce it to 0 and mask the
  // spawn-failure verdict path under test.
  const status = "status" in opts ? opts.status : 0;
  return vi.fn(() => ({
    status,
    stdout: opts.stdout ?? "",
    stderr: opts.stderr ?? "",
    signal: null,
    output: [],
    pid: 1234,
    error: opts.error,
  })) as unknown as typeof import("node:child_process").spawnSync;
}

describe("skills-delegate — engine (FR-212d: delegate is the only engine)", () => {
  it("resolves 'delegate' unconditionally (the custom engine was retired)", () => {
    // FR-212d Phase 2 flipped the default to delegate AND deleted the custom
    // inline symlink loop + the IGRIS_SKILLS_ENGINE env read. The resolver is now
    // a constant — there is no escape hatch back to custom.
    expect(resolveSkillsEngine({})).toBe("delegate");
  });

  it("ignores any IGRIS_SKILLS_ENGINE value — always 'delegate'", () => {
    expect(resolveSkillsEngine({ IGRIS_SKILLS_ENGINE: "" })).toBe("delegate");
    expect(resolveSkillsEngine({ IGRIS_SKILLS_ENGINE: "custom" })).toBe(
      "delegate",
    );
    expect(resolveSkillsEngine({ IGRIS_SKILLS_ENGINE: "delegate" })).toBe(
      "delegate",
    );
  });
});

describe("skills-delegate — local binary resolution (supply-chain invariant)", () => {
  it("resolves the REAL skills binary to a LOCAL absolute on-disk path, never npx", () => {
    // Exercises the REAL resolver against the pinned installed package — but
    // NEVER spawns it. The invariant: the path is absolute, exists, and is not
    // the literal `npx` (a bare npx would be an unpinned network fetch).
    const bin = resolveSkillsBinary();
    expect(isAbsolute(bin)).toBe(true);
    expect(existsSync(bin)).toBe(true);
    expect(bin).not.toBe("npx");
    expect(bin.endsWith("/npx")).toBe(false);
    // Sanity: it resolves into the installed `skills` package.
    expect(bin).toContain("skills");
  });

  it("assertLocalSkillsBinary rejects the literal 'npx'", () => {
    expect(() => assertLocalSkillsBinary("npx")).toThrow(/non-local/);
    expect(() => assertLocalSkillsBinary("npx.cmd")).toThrow(/non-local/);
  });

  it("assertLocalSkillsBinary rejects a bare (non-absolute) command name", () => {
    expect(() => assertLocalSkillsBinary("skills")).toThrow(/non-local/);
  });

  it("assertLocalSkillsBinary ACCEPTS any absolute non-npx path (the cheap fs-free invariant)", () => {
    // Existence is enforced only in resolveSkillsBinary; the spawn-time guard is
    // the cheap npx/absolute check so injected test resolvers don't need a real
    // on-disk file to prove the invariant.
    expect(assertLocalSkillsBinary("/abs/does/not/exist/cli.mjs")).toBe(
      "/abs/does/not/exist/cli.mjs",
    );
  });
});

describe("skills-delegate — add argv builder", () => {
  it("builds `add <abs> -g -a <6 igris harnesses> -y` by default", () => {
    const argv = buildSkillsAddArgv({ source: "/abs/.igris/core/skills" });
    expect(argv).toEqual([
      "add",
      "/abs/.igris/core/skills",
      "-g",
      "-a",
      "claude-code",
      "codex",
      "gemini-cli",
      "opencode",
      "antigravity",
      "cursor",
      "-y",
    ]);
  });

  it("targets the 6 Igris harness ids — gemini-cli, NOT gemini; cursor included", () => {
    expect(skillAgentIds()).toContain("gemini-cli");
    expect(skillAgentIds()).not.toContain("gemini");
    expect(skillAgentIds()).toContain("cursor");
    expect([...skillAgentIds()].sort()).toEqual(
      ["antigravity", "claude-code", "codex", "cursor", "gemini-cli", "opencode"].sort(),
    );
  });

  it("honors explicit harnesses (space-separated after one -a)", () => {
    const argv = buildSkillsAddArgv({
      source: "/abs/skills",
      harnesses: ["claude-code"],
    });
    expect(argv).toEqual(["add", "/abs/skills", "-g", "-a", "claude-code", "-y"]);
  });

  it("adds --copy when mode is 'copy'", () => {
    const argv = buildSkillsAddArgv({
      source: "/abs/skills",
      harnesses: ["claude-code"],
      mode: "copy",
    });
    expect(argv).toContain("--copy");
  });

  it("drops -g when global is false (project scope)", () => {
    const argv = buildSkillsAddArgv({
      source: "/abs/skills",
      harnesses: ["claude-code"],
      global: false,
    });
    expect(argv).not.toContain("-g");
  });

  it("REFUSES a non-absolute source (the cwd-relative hazard)", () => {
    expect(() => buildSkillsAddArgv({ source: "relative/skills" })).toThrow(
      /absolute path/,
    );
    expect(() => buildSkillsAddArgv({ source: "./skills" })).toThrow(
      /absolute path/,
    );
  });
});

describe("skills-delegate — remove argv builder", () => {
  it("builds `remove <name> -g --all -y`", () => {
    expect(buildSkillsRemoveArgv({ name: "my-skill" })).toEqual([
      "remove",
      "my-skill",
      "-g",
      "--all",
      "-y",
    ]);
  });

  it("drops -g when global is false", () => {
    expect(
      buildSkillsRemoveArgv({ name: "my-skill", global: false }),
    ).toEqual(["remove", "my-skill", "--all", "-y"]);
  });

  it("REFUSES an empty skill name", () => {
    expect(() => buildSkillsRemoveArgv({ name: "" })).toThrow(/non-empty/);
    expect(() => buildSkillsRemoveArgv({ name: "   " })).toThrow(/non-empty/);
  });
});

describe("skills-delegate — projectSkillsViaTool (spawn spied, never real)", () => {
  it("invokes the LOCAL binary (argv[0]) — NEVER a bare 'npx'", () => {
    const spawn = fakeSpawn({ status: 0, stdout: "Installed 1 skill" });
    const result = projectSkillsViaTool(
      { source: "/abs/.igris/core/skills" },
      { resolveBinary: () => FAKE_BIN, spawn },
    );
    // The spy was called with the resolved LOCAL binary + the verified argv.
    expect(spawn).toHaveBeenCalledTimes(1);
    const callArgs = (spawn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(callArgs[0]).toBe(FAKE_BIN);
    expect(callArgs[0]).not.toBe("npx");
    expect(callArgs[1][0]).toBe("add");
    // The verdict echoes the FULL argv (binary + args) for diagnostics.
    expect(result.argv[0]).toBe(FAKE_BIN);
    expect(result.argv).not.toContain("npx");
  });

  it("parses a clean exit (status 0) as ok:true", () => {
    const spawn = fakeSpawn({ status: 0, stdout: "ok" });
    const result = projectSkillsViaTool(
      { source: "/abs/skills", harnesses: ["claude-code"] },
      { resolveBinary: () => FAKE_BIN, spawn },
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("parses a non-zero exit as ok:false with the exit code", () => {
    const spawn = fakeSpawn({ status: 3, stderr: "boom" });
    const result = projectSkillsViaTool(
      { source: "/abs/skills", harnesses: ["claude-code"] },
      { resolveBinary: () => FAKE_BIN, spawn },
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("boom");
  });

  it("maps a spawn failure (status null + error) to a non-zero verdict, never throws", () => {
    const spawn = fakeSpawn({
      status: null,
      error: new Error("ENOENT"),
    });
    const result = projectSkillsViaTool(
      { source: "/abs/skills", harnesses: ["claude-code"] },
      { resolveBinary: () => FAKE_BIN, spawn },
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
  });

  it("NO inline secret pattern appears in the logged argv (skills carry no secrets)", () => {
    const spawn = fakeSpawn({ status: 0 });
    const result = projectSkillsViaTool(
      { source: "/abs/.igris/core/skills" },
      { resolveBinary: () => FAKE_BIN, spawn },
    );
    const joined = result.argv.join(" ");
    // The argv must NOT carry any KEY=secret-literal, token-ish blob, or env
    // assignment — the skills delegate only ever passes a public path + flags.
    expect(joined).not.toMatch(/--env/);
    expect(joined).not.toMatch(/[A-Za-z0-9]{32,}/); // no long token-like blob
    expect(joined).not.toMatch(/=.*(?:secret|token|key|password)/i);
  });
});

describe("skills-delegate — unprojectSkillsViaTool (spawn spied, never real)", () => {
  it("invokes the LOCAL binary with `remove <name> -g --all -y`", () => {
    const spawn = fakeSpawn({ status: 0, stdout: "Successfully removed 1" });
    const result = unprojectSkillsViaTool("my-skill", {
      resolveBinary: () => FAKE_BIN,
      spawn,
    });
    const callArgs = (spawn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(callArgs[0]).toBe(FAKE_BIN);
    expect(callArgs[0]).not.toBe("npx");
    expect(callArgs[1]).toEqual(["remove", "my-skill", "-g", "--all", "-y"]);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false on a non-zero remove exit (never throws)", () => {
    const spawn = fakeSpawn({ status: 1, stderr: "not found" });
    const result = unprojectSkillsViaTool("ghost", {
      resolveBinary: () => FAKE_BIN,
      spawn,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
