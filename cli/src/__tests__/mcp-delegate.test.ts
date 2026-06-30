/**
 * FR-212b: unit tests for the MCP DELEGATE module (cli/src/lib/mcp-delegate.ts).
 *
 * Posture (constraint #2 + the brief's GATE): these are UNIT tests — the spawn
 * is ALWAYS spied (a `vi.fn()` injected via the `spawn` dep), NEVER the real
 * `add-mcp` CLI. The binary resolver is likewise injected with a fake ABSOLUTE
 * path so the argv assertions don't depend on the installed package layout. The
 * ONE test that exercises the REAL `resolveMcpBinary` only asserts the resolved
 * path is absolute + on-disk + not `npx` (the supply-chain invariant), never
 * spawns it.
 *
 * Coverage:
 *   1. resolveMcpEngine defaults to "custom"; only "delegate" opts in.
 *   2. The REAL binary resolves to a LOCAL absolute on-disk path, never `npx`.
 *   3. assertLocalMcpBinary rejects `npx` / bare / non-existent.
 *   4. buildMcpAddArgv: `"<command> <arg…>" -g -a <agent...> -n <name> --env
 *      KEY=${VAR} -y` — the FULL launch command as ONE positional (FR-212d fix;
 *      a bare-word target is npx-wrapped), the Igris harness ids (gemini-cli
 *      not gemini), the ${VAR}-passthrough never a literal secret, and the
 *      whitespace-bearing-token guard (add-mcp has no intra-positional quoting).
 *   5. buildMcpRemoveArgv: `remove <name> -g -a <agents…> -y`, empty-name guard.
 *   6. registerMcpViaTool / unregisterMcpViaTool: spy the spawn, assert argv[0]
 *      is the LOCAL binary (no bare npx), the verdict keys on the exit code, and
 *      NO inline secret-literal appears in any logged argv (the ${VAR} ref is
 *      passed VERBATIM — never the resolved value).
 */

import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  assertLocalMcpBinary,
  buildMcpAddArgv,
  buildMcpRemoveArgv,
  registerMcpViaTool,
  resolveMcpBinary,
  resolveMcpEngine,
  unregisterMcpViaTool,
} from "../lib/mcp-delegate.js";
// FR-217: the default MCP target set is now descriptor-derived; assert against
// the accessor the SUT reads (mcpAgentIds()), not the deleted hardcoded const.
import { mcpAgentIds } from "../lib/harness-descriptor.js";

/** A fake absolute binary path for the injected resolver (never spawned). */
const FAKE_BIN = "/abs/node_modules/add-mcp/dist/index.js";

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

describe("mcp-delegate — engine (FR-212d: delegate is the default engine)", () => {
  it("resolves 'delegate' unconditionally (the custom merger for the 4 delegated harnesses was retired)", () => {
    // FR-212d Phase 2 flipped the default to delegate AND deleted the custom
    // merger placement for claude/codex/gemini/opencode + the IGRIS_MCP_ENGINE
    // env read. The resolver is a constant — antigravity's ENTRY still uses the
    // custom merger, but that carve-out lives in mcp-register.ts/runProjectMcp,
    // NOT in this resolver. There is no escape hatch back to custom.
    expect(resolveMcpEngine({})).toBe("delegate");
  });

  it("ignores any IGRIS_MCP_ENGINE value — always 'delegate'", () => {
    expect(resolveMcpEngine({ IGRIS_MCP_ENGINE: "" })).toBe("delegate");
    expect(resolveMcpEngine({ IGRIS_MCP_ENGINE: "custom" })).toBe("delegate");
    expect(resolveMcpEngine({ IGRIS_MCP_ENGINE: "delegate" })).toBe("delegate");
  });

  it("the mcp + skills resolvers are uniform (both constant 'delegate')", () => {
    expect(resolveMcpEngine({})).toBe("delegate");
    expect(resolveMcpEngine({ IGRIS_MCP_ENGINE: undefined })).toBe("delegate");
  });
});

describe("mcp-delegate — local binary resolution (supply-chain invariant)", () => {
  it("resolves the REAL add-mcp binary to a LOCAL absolute on-disk path, never npx", () => {
    // Exercises the REAL resolver against the pinned installed package — but
    // NEVER spawns it. The invariant: the path is absolute, exists, and is not
    // the literal `npx` (a bare npx would be an unpinned network fetch).
    const bin = resolveMcpBinary();
    expect(isAbsolute(bin)).toBe(true);
    expect(existsSync(bin)).toBe(true);
    expect(bin).not.toBe("npx");
    expect(bin.endsWith("/npx")).toBe(false);
    // Sanity: it resolves into the installed `add-mcp` package.
    expect(bin).toContain("add-mcp");
  });

  it("assertLocalMcpBinary rejects the literal 'npx'", () => {
    expect(() => assertLocalMcpBinary("npx")).toThrow(/non-local/);
    expect(() => assertLocalMcpBinary("npx.cmd")).toThrow(/non-local/);
  });

  it("assertLocalMcpBinary rejects a bare (non-absolute) command name", () => {
    expect(() => assertLocalMcpBinary("add-mcp")).toThrow(/non-local/);
  });

  it("assertLocalMcpBinary ACCEPTS any absolute non-npx path (the cheap fs-free invariant)", () => {
    expect(assertLocalMcpBinary("/abs/does/not/exist/index.js")).toBe(
      "/abs/does/not/exist/index.js",
    );
  });
});

describe("mcp-delegate — add argv builder", () => {
  it("builds `\"<command> <arg>\" -g -a <6 igris harnesses> -n <name> -y` by default (FR-212d: joined positional, no --args)", () => {
    const argv = buildMcpAddArgv({
      name: "igris-brain",
      command: "node",
      args: ["/abs/brain-mcp-server/dist/index.js"],
    });
    expect(argv).toEqual([
      // FR-212d: the FULL launch command is ONE positional. A bare-word target
      // (`node`) would be npx-wrapped by add-mcp; the joined `"node <entry>"`
      // makes it write the literal `{command:"node",args:[<entry>]}` shape.
      "node /abs/brain-mcp-server/dist/index.js",
      "-g",
      "-a",
      "claude-code",
      "-a",
      "codex",
      "-a",
      "gemini-cli",
      "-a",
      "opencode",
      "-a",
      "antigravity",
      "-a",
      "cursor",
      "-n",
      "igris-brain",
      "-y",
    ]);
    // The npx-wrap regression guard: the positional must NOT be the bare command
    // word, and `--args` must NOT appear (it is what fed the npx-wrapped path).
    expect(argv[0]).toBe("node /abs/brain-mcp-server/dist/index.js");
    expect(argv).not.toContain("--args");
    expect(argv).not.toContain("npx");
  });

  it("targets the 6 Igris harness ids — gemini-cli, NOT gemini; cursor included", () => {
    expect(mcpAgentIds()).toContain("gemini-cli");
    expect(mcpAgentIds()).not.toContain("gemini");
    expect(mcpAgentIds()).toContain("cursor");
    expect([...mcpAgentIds()].sort()).toEqual(
      ["antigravity", "claude-code", "codex", "cursor", "gemini-cli", "opencode"].sort(),
    );
  });

  it("honors explicit harnesses (one -a per agent)", () => {
    const argv = buildMcpAddArgv({
      name: "igris-brain",
      command: "node",
      args: ["/abs/x.js"],
      harnesses: ["claude-code"],
    });
    expect(argv).toEqual([
      "node /abs/x.js",
      "-g",
      "-a",
      "claude-code",
      "-n",
      "igris-brain",
      "-y",
    ]);
  });

  it("joins multiple args into the single positional in order (FR-212d)", () => {
    const argv = buildMcpAddArgv({
      name: "srv",
      command: "node",
      args: ["--enable-source-maps", "/abs/entry.js", "--flag"],
      harnesses: ["claude-code"],
    });
    // command + every arg fused into ONE whitespace-joined positional target.
    expect(argv[0]).toBe("node --enable-source-maps /abs/entry.js --flag");
    expect(argv).not.toContain("--args");
  });

  it("builds a bare-command positional when there are NO args", () => {
    // A command with no args is still passed as a single positional (here a
    // single token); add-mcp would npx-wrap a bare package name, but the brain
    // ALWAYS carries an entrypoint arg, so this is the degenerate guard case.
    const argv = buildMcpAddArgv({
      name: "srv",
      command: "/abs/server",
      harnesses: ["claude-code"],
    });
    expect(argv[0]).toBe("/abs/server");
    expect(argv).not.toContain("--args");
  });

  it("drops -g when global is false (project scope)", () => {
    const argv = buildMcpAddArgv({
      name: "igris-brain",
      command: "node",
      harnesses: ["claude-code"],
      global: false,
    });
    expect(argv).not.toContain("-g");
  });

  it("passes each env entry as `--env KEY=${VAR}` VERBATIM — never a resolved literal", () => {
    // CRITICAL secret-hygiene: the env VALUE is the ${VAR} indirection ref. With
    // `-y`, add-mcp passes the placeholder through; a literal secret never enters
    // the argv. (igris-brain is env-free, but the passthrough must be correct for
    // any future secret-bearing server.)
    const argv = buildMcpAddArgv({
      name: "secretful",
      command: "node",
      args: ["/abs/x.js"],
      harnesses: ["claude-code"],
      env: { API_TOKEN: "${MY_SECRET}" },
    });
    expect(argv).toContain("--env");
    expect(argv).toContain("API_TOKEN=${MY_SECRET}");
    // The placeholder is the LITERAL ${VAR} text — NOT a resolved value.
    const joined = argv.join(" ");
    expect(joined).toContain("${MY_SECRET}");
    expect(joined).not.toMatch(/API_TOKEN=[A-Za-z0-9]{16,}/); // no resolved blob
  });

  it("REFUSES an empty server name", () => {
    expect(() => buildMcpAddArgv({ name: "", command: "node" })).toThrow(
      /non-empty server name/,
    );
    expect(() => buildMcpAddArgv({ name: "   ", command: "node" })).toThrow(
      /non-empty server name/,
    );
  });

  it("REFUSES an empty command/target", () => {
    expect(() => buildMcpAddArgv({ name: "x", command: "" })).toThrow(
      /non-empty command/,
    );
  });

  it("REFUSES a whitespace-bearing arg (add-mcp would space-split the positional) — FR-212d", () => {
    // add-mcp tokenizes the single positional on whitespace with NO quoting
    // grammar, so a space-bearing path would be torn into multiple args
    // (`"node /p with space/x.js"` → args:["/p","with","space/x.js"]). The
    // builder must refuse to emit a corrupting argv rather than silently break.
    expect(() =>
      buildMcpAddArgv({
        name: "srv",
        command: "node",
        args: ["/path with space/index.js"],
        harnesses: ["claude-code"],
      }),
    ).toThrow(/whitespace-bearing/);
  });

  it("REFUSES a whitespace-bearing COMMAND too (FR-212d)", () => {
    expect(() =>
      buildMcpAddArgv({
        name: "srv",
        command: "my command",
        args: ["/abs/x.js"],
        harnesses: ["claude-code"],
      }),
    ).toThrow(/whitespace-bearing/);
  });
});

describe("mcp-delegate — remove argv builder", () => {
  it("builds `remove <name> -g -a <6 harnesses> -y` by default", () => {
    expect(buildMcpRemoveArgv({ name: "igris-brain" })).toEqual([
      "remove",
      "igris-brain",
      "-g",
      "-a",
      "claude-code",
      "-a",
      "codex",
      "-a",
      "gemini-cli",
      "-a",
      "opencode",
      "-a",
      "antigravity",
      "-a",
      "cursor",
      "-y",
    ]);
  });

  it("honors explicit harnesses + drops -g when global is false", () => {
    expect(
      buildMcpRemoveArgv({
        name: "igris-brain",
        harnesses: ["claude-code"],
        global: false,
      }),
    ).toEqual(["remove", "igris-brain", "-a", "claude-code", "-y"]);
  });

  it("REFUSES an empty server name", () => {
    expect(() => buildMcpRemoveArgv({ name: "" })).toThrow(/non-empty/);
    expect(() => buildMcpRemoveArgv({ name: "   " })).toThrow(/non-empty/);
  });
});

describe("mcp-delegate — registerMcpViaTool (spawn spied, never real)", () => {
  it("invokes the LOCAL binary (argv[0]) — NEVER a bare 'npx'", () => {
    const spawn = fakeSpawn({ status: 0, stdout: "Installed igris-brain" });
    const result = registerMcpViaTool(
      {
        name: "igris-brain",
        command: "node",
        args: ["/abs/x.js"],
        harnesses: ["claude-code"],
      },
      { resolveBinary: () => FAKE_BIN, spawn },
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    const callArgs = (spawn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(callArgs[0]).toBe(FAKE_BIN);
    expect(callArgs[0]).not.toBe("npx");
    // FR-212d: the joined `"node <entry>"` positional is argv[0] of the spawn
    // args — NOT the bare command word (which add-mcp would npx-wrap).
    expect(callArgs[1][0]).toBe("node /abs/x.js");
    expect(callArgs[1]).not.toContain("--args");
    expect(result.argv[0]).toBe(FAKE_BIN);
    expect(result.argv).not.toContain("npx");
  });

  it("parses a clean exit (status 0) as ok:true", () => {
    const spawn = fakeSpawn({ status: 0, stdout: "ok" });
    const result = registerMcpViaTool(
      { name: "igris-brain", command: "node", harnesses: ["claude-code"] },
      { resolveBinary: () => FAKE_BIN, spawn },
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("parses a non-zero exit as ok:false with the exit code", () => {
    const spawn = fakeSpawn({ status: 3, stderr: "boom" });
    const result = registerMcpViaTool(
      { name: "igris-brain", command: "node", harnesses: ["claude-code"] },
      { resolveBinary: () => FAKE_BIN, spawn },
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("boom");
  });

  it("maps a spawn failure (status null + error) to a non-zero verdict, never throws", () => {
    const spawn = fakeSpawn({ status: null, error: new Error("ENOENT") });
    const result = registerMcpViaTool(
      { name: "igris-brain", command: "node", harnesses: ["claude-code"] },
      { resolveBinary: () => FAKE_BIN, spawn },
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
  });

  it("NO resolved-secret literal appears in the logged argv (only the ${VAR} ref)", () => {
    const spawn = fakeSpawn({ status: 0 });
    const result = registerMcpViaTool(
      {
        name: "secretful",
        command: "node",
        args: ["/abs/x.js"],
        harnesses: ["claude-code"],
        env: { API_TOKEN: "${MY_SECRET}" },
      },
      { resolveBinary: () => FAKE_BIN, spawn },
    );
    const joined = result.argv.join(" ");
    // The ${VAR} placeholder is present (correct passthrough); but no resolved
    // long-token blob and no literal `secret/token/key/password` VALUE leaks.
    expect(joined).toContain("${MY_SECRET}");
    expect(joined).not.toMatch(/=[A-Za-z0-9]{32,}/); // no long token-like blob
    expect(joined).not.toMatch(/=.*(?:s3cr3t-value|actual-token-)/i);
  });
});

describe("mcp-delegate — unregisterMcpViaTool (spawn spied, never real)", () => {
  it("invokes the LOCAL binary with `remove <name> -g -a <agents…> -y`", () => {
    const spawn = fakeSpawn({ status: 0, stdout: "Removed igris-brain" });
    const result = unregisterMcpViaTool("igris-brain", {
      resolveBinary: () => FAKE_BIN,
      spawn,
      harnesses: ["claude-code"],
    });
    const callArgs = (spawn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(callArgs[0]).toBe(FAKE_BIN);
    expect(callArgs[0]).not.toBe("npx");
    expect(callArgs[1]).toEqual([
      "remove",
      "igris-brain",
      "-g",
      "-a",
      "claude-code",
      "-y",
    ]);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false on a non-zero remove exit (never throws)", () => {
    const spawn = fakeSpawn({ status: 1, stderr: "not found" });
    const result = unregisterMcpViaTool("ghost", {
      resolveBinary: () => FAKE_BIN,
      spawn,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
