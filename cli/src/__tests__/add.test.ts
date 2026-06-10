/**
 * FR-180: `igris add` dispatcher tests.
 *
 * Covers: 5-arm routing + unknown-surface usage error, the D1 core-vs-personal
 * resolver (flags + auto-detect + the printed mode), the notImplementedYet
 * stubs for the 3 not-yet-shipped arms, and the `skill` + `agent` arms
 * end-to-end (personal + core) via the test seams (materialize/addCore/detect/
 * capture injected, so no real disk/shell). The TD-235 no-silent-no-op
 * regression is asserted at the arm level (skill + agent): a core projection
 * that the ownership gate skips → non-zero + message; an incidental personal
 * compile → visible SKIPPED line + exit-0.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import {
  runAdd,
  resolveAddMode,
  detectCoreRepo,
  coreProjectionParams,
} from "../verbs/add.js";
import { runRegistry } from "../verbs/registry.js";
import type { AdapterCaptureFn } from "../verbs/harness.js";
import type {
  SkillMaterializeResult,
  AgentMaterializeResult,
  McpMaterializeResult,
  IdentityMaterializeResult,
  HookMaterializeResult,
} from "../verbs/registry.js";
import type { AddCoreResult } from "../verbs/add-core.js";

const BRAIN = "/tmp/igris-test-brain-add";

// --- stdout/stderr capture (info → stdout, error → stderr) -----------------
function captureStreams(): {
  out: string[];
  err: string[];
  restore: () => void;
} {
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
beforeEach(() => {
  cap = captureStreams();
});
afterEach(() => {
  cap.restore();
});

// A clean compile+check capture fake (1 target projected, drift-clean).
function cleanAdapter(): AdapterCaptureFn {
  return (scriptPath) => {
    if (scriptPath.includes("compile_harnesses.sh")) {
      return {
        code: 0,
        output: "  OK    skills/claude -> x\n  1 targets — 1 ok, 0 failed\n",
      };
    }
    return { code: 0, output: "  1 targets — 1 in sync, 0 drifted/missing\n" };
  };
}

const okMaterialize = (): SkillMaterializeResult => ({
  ok: true,
  code: 0,
  vendoredDir: "/reg/skills/foo",
  overlayWritten: "/overlay.json",
});

const okAddCore = (): AddCoreResult => ({
  ok: true,
  code: 0,
  reason: "",
  sourcePath: "/repo/core/skills/foo/SKILL.md",
  mirrorPath: "/brain/core/skills/foo/SKILL.md",
  verifyOutput: "SUMMARY: 1 pairs — 1 MATCH, …",
});

const okMaterializeAgent = (): AgentMaterializeResult => ({
  ok: true,
  code: 0,
  vendoredDir: "/reg/agents/bot",
  overlayWritten: "/overlay.json",
});

const okAddCoreAgent = (): AddCoreResult => ({
  ok: true,
  code: 0,
  reason: "",
  sourcePath: "/repo/core/agents/bot.md",
  mirrorPath: "/brain/core/agents/bot.md",
  verifyOutput: "SUMMARY: 3 pairs — 3 MATCH, 0 MISMATCH",
});

const okMaterializeMcp = (): McpMaterializeResult => ({
  ok: true,
  code: 0,
  overlayWritten: "/overlay.json",
});

const okAddCoreMcp = (): AddCoreResult => ({
  ok: true,
  code: 0,
  reason: "",
  sourcePath: "/repo/core/scripts/cli-adapters/surfaces-manifest.json",
  mirrorPath: "/brain/core/scripts/cli-adapters/surfaces-manifest.json",
  verifyOutput: "SUMMARY: 1 pairs — 1 MATCH, 0 MISMATCH",
});

const okMaterializeIdentity = (): IdentityMaterializeResult => ({
  ok: true,
  code: 0,
  overlayWritten: "/overlay.json",
});

const okAddCoreIdentity = (): AddCoreResult => ({
  ok: true,
  code: 0,
  reason: "",
  sourcePath: "/repo/core/templates/identity.tmpl",
  mirrorPath: "/brain/core/templates/identity.tmpl",
  verifyOutput: "SUMMARY: 1 pairs — 1 MATCH, 0 MISMATCH",
});

const okMaterializeHook = (): HookMaterializeResult => ({
  ok: true,
  code: 0,
  overlayWritten: "/overlay.json",
});

const okAddCoreHook = (): AddCoreResult => ({
  ok: true,
  code: 0,
  reason: "",
  sourcePath: "/repo/core/scripts/cli-adapters/surfaces-manifest.json",
  mirrorPath: "/brain/core/scripts/cli-adapters/surfaces-manifest.json",
  verifyOutput: "SUMMARY: 2 pairs — 2 MATCH, 0 MISMATCH",
});

// A clean hook compile+check capture fake (1 hook target, drift-clean).
function cleanHookAdapter(): AdapterCaptureFn {
  return (scriptPath) => {
    if (scriptPath.includes("compile_harnesses.sh")) {
      return {
        code: 0,
        output: "  OK    hook/my-guard/claude\n  1 targets — 1 ok, 0 failed\n",
      };
    }
    return {
      code: 0,
      output: "  [hook/my-guard/claude] MATCH\n  1 targets — 1 in sync, 0 drifted/missing\n",
    };
  };
}

// A clean identity compile+check capture fake (1 identity target, drift-clean).
function cleanIdentityAdapter(): AdapterCaptureFn {
  return (scriptPath) => {
    if (scriptPath.includes("compile_harnesses.sh")) {
      return {
        code: 0,
        output:
          "  OK    identity/gemini -> GEMINI.md (created)\n  1 targets — 1 ok, 0 failed\n",
      };
    }
    return {
      code: 0,
      output: "  [identity/gemini] MATCH\n  1 targets — 1 in sync, 0 drifted/missing\n",
    };
  };
}

describe("runAdd — dispatcher routing", () => {
  it("unknown surface → exit 2 + actionable message", async () => {
    const code = await runAdd({ surface: "bogus", name: "x" });
    expect(code).toBe(2);
    expect(cap.err.join("")).toContain("unknown surface 'bogus'");
  });

  it("all five arms are wired (no not-implemented stub remains)", async () => {
    // FR-180 Phase 5: hook is the final arm — dispatching it must NOT hit a
    // stub. With injected seams it routes to the hook arm and reaches projection.
    const code = await runAdd({
      surface: "hook",
      name: "x",
      event: "PreToolUse",
      noCore: true,
      detectCore: () => false,
      brainRoot: BRAIN,
      materializeHookFn: okMaterializeHook,
      captureAdapter: cleanAdapter(),
    });
    expect(code).toBe(0);
    expect(cap.err.join("")).not.toContain("not implemented yet");
  });
});

describe("resolveAddMode — D1 core-vs-personal resolution", () => {
  it("--core forces core (wins over auto-detect)", () => {
    expect(
      resolveAddMode({ core: true, projectRoot: "/x", detectCore: () => false }),
    ).toEqual({ ok: true, mode: "core" });
  });

  it("--no-core forces personal (wins over auto-detect)", () => {
    expect(
      resolveAddMode({ noCore: true, projectRoot: "/x", detectCore: () => true }),
    ).toEqual({ ok: true, mode: "personal" });
  });

  it("auto-detects core when the project root is the igris-ai checkout", () => {
    expect(
      resolveAddMode({ projectRoot: "/x", detectCore: () => true }),
    ).toEqual({ ok: true, mode: "core" });
  });

  it("auto-detects personal when not the checkout", () => {
    expect(
      resolveAddMode({ projectRoot: "/x", detectCore: () => false }),
    ).toEqual({ ok: true, mode: "personal" });
  });

  it("--core + --no-core together is a usage error", () => {
    const r = resolveAddMode({ core: true, noCore: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("mutually exclusive");
    }
  });
});

describe("runAdd — resolved mode is PRINTED (never silent, D1)", () => {
  it("prints CORE mode when routed to core", async () => {
    await runAdd({
      surface: "skill",
      name: "foo",
      core: true,
      projectRoot: "/repo",
      brainRoot: BRAIN,
      addCoreSkillFn: okAddCore,
      captureAdapter: cleanAdapter(),
    });
    expect(cap.out.join("")).toContain("operating in CORE mode");
  });

  it("prints PERSONAL mode when routed to personal", async () => {
    await runAdd({
      surface: "skill",
      name: "foo",
      noCore: true,
      from: "/src",
      targets: ["claude:symlink:~/.claude/skills"],
      brainRoot: BRAIN,
      materializeSkillFn: okMaterialize,
      captureAdapter: cleanAdapter(),
    });
    expect(cap.out.join("")).toContain("operating in PERSONAL mode");
  });
});

describe("runAdd skill — personal happy path", () => {
  it("materializes then projects + verifies → exit 0", async () => {
    let materializeCalled = false;
    const code = await runAdd({
      surface: "skill",
      name: "foo",
      noCore: true,
      from: "/src",
      targets: ["claude:symlink:~/.claude/skills"],
      brainRoot: BRAIN,
      materializeSkillFn: (opts, overlay) => {
        materializeCalled = true;
        expect(opts.action).toBe("add-skill");
        expect(opts.name).toBe("foo");
        expect(overlay).toBeDefined();
        return okMaterialize();
      },
      captureAdapter: cleanAdapter(),
    });
    expect(code).toBe(0);
    expect(materializeCalled).toBe(true);
    expect(cap.out.join("")).toContain("Added personal skill 'foo'");
  });

  it("returns the materialize reject code without projecting", async () => {
    let projected = false;
    const code = await runAdd({
      surface: "skill",
      name: "foo",
      noCore: true,
      brainRoot: BRAIN,
      materializeSkillFn: () => ({
        ok: false,
        code: 2,
        vendoredDir: "",
        overlayWritten: "/o.json",
      }),
      captureAdapter: () => {
        projected = true;
        return { code: 0, output: "" };
      },
    });
    expect(code).toBe(2);
    expect(projected).toBe(false);
  });
});

describe("runAdd skill — core happy path", () => {
  it("writes core scaffold (mirrored) then projects + verifies → exit 0", async () => {
    let addCoreCalled = false;
    const code = await runAdd({
      surface: "skill",
      name: "foo",
      core: true,
      projectRoot: "/repo",
      brainRoot: BRAIN,
      addCoreSkillFn: (opts) => {
        addCoreCalled = true;
        expect(opts.name).toBe("foo");
        expect(opts.projectRoot).toBe("/repo");
        return okAddCore();
      },
      captureAdapter: cleanAdapter(),
    });
    expect(code).toBe(0);
    expect(addCoreCalled).toBe(true);
    expect(cap.out.join("")).toContain("Added core skill 'foo'");
  });

  it("returns the add-core reject code without projecting", async () => {
    let projected = false;
    const code = await runAdd({
      surface: "skill",
      name: "foo",
      core: true,
      projectRoot: "/repo",
      brainRoot: BRAIN,
      addCoreSkillFn: () => ({
        ok: false,
        code: 1,
        reason: "core skill already exists",
        sourcePath: "/repo/core/skills/foo/SKILL.md",
        mirrorPath: "/brain/core/skills/foo/SKILL.md",
        verifyOutput: "",
      }),
      captureAdapter: () => {
        projected = true;
        return { code: 0, output: "" };
      },
    });
    expect(code).toBe(1);
    expect(projected).toBe(false);
    expect(cap.err.join("")).toContain("already exists");
  });

  // FR-180 cross-phase: core projection MUST run against the runtime BRAIN ROOT
  // (so the ownership gate passes), NOT the repo checkout — and pass the repo's
  // harness-manifest.json as --manifest (the brain has none). Materialize still
  // uses the repo root.
  it("projects against the BRAIN ROOT with the repo manifest (--project-root + --manifest)", async () => {
    const seen: { script: string; args: string[] }[] = [];
    const code = await runAdd({
      surface: "skill",
      name: "foo",
      core: true,
      projectRoot: "/repo",
      brainRoot: BRAIN,
      addCoreSkillFn: (opts) => {
        // Materialize uses the REPO root (where core/ is written).
        expect(opts.projectRoot).toBe("/repo");
        return okAddCore();
      },
      captureAdapter: (scriptPath, args) => {
        seen.push({ script: scriptPath, args });
        if (scriptPath.includes("compile_harnesses.sh")) {
          return {
            code: 0,
            output: "  OK    skills/claude -> x\n  1 targets — 1 ok, 0 failed\n",
          };
        }
        return { code: 0, output: "  1 targets — 1 in sync, 0 drifted/missing\n" };
      },
    });
    expect(code).toBe(0);
    // Both the compile and the check pass run against the brain root + repo
    // manifest (NOT /repo as --project-root).
    expect(seen.length).toBe(2);
    for (const call of seen) {
      const pr = call.args[call.args.indexOf("--project-root") + 1];
      const mf = call.args[call.args.indexOf("--manifest") + 1];
      expect(pr).toBe(BRAIN);
      expect(mf).toBe("/repo/harness-manifest.json");
      // It must NOT pass the repo checkout as the projection project-root.
      expect(pr).not.toBe("/repo");
    }
  });
});

describe("coreProjectionParams — FR-180 cross-phase projection root", () => {
  it("returns the brain root as project-root and <repo>/harness-manifest.json", () => {
    const p = coreProjectionParams("/repo", "/my/brain");
    expect(p.projectRoot).toBe("/my/brain");
    expect(p.manifest).toBe("/repo/harness-manifest.json");
  });

  it("defaults the project-root to brainDir() when brainRoot omitted", () => {
    // No brainRoot → falls back to brainDir() (which honors IGRIS_BRAIN_DIR);
    // the manifest is always derived from the materialize (repo) root.
    const saved = process.env.IGRIS_BRAIN_DIR;
    process.env.IGRIS_BRAIN_DIR = "/env/brain";
    try {
      const p = coreProjectionParams("/checkout");
      expect(p.projectRoot).toBe("/env/brain");
      expect(p.manifest).toBe("/checkout/harness-manifest.json");
    } finally {
      if (saved === undefined) delete process.env.IGRIS_BRAIN_DIR;
      else process.env.IGRIS_BRAIN_DIR = saved;
    }
  });
});

describe("runAdd agent — personal happy path", () => {
  it("materializes via materializeAgent then projects + verifies → exit 0", async () => {
    let materializeCalled = false;
    const code = await runAdd({
      surface: "agent",
      name: "bot",
      noCore: true,
      from: "/src",
      targets: ["codex:.codex/agents/bot.toml"],
      brainRoot: BRAIN,
      materializeAgentFn: async (opts, overlay) => {
        materializeCalled = true;
        // The agent arm routes through the registry "add" action (R7 reuse).
        expect(opts.action).toBe("add");
        expect(opts.name).toBe("bot");
        expect(overlay).toBeDefined();
        return okMaterializeAgent();
      },
      captureAdapter: cleanAdapter(),
    });
    expect(code).toBe(0);
    expect(materializeCalled).toBe(true);
    expect(cap.out.join("")).toContain("Added personal agent 'bot'");
  });

  it("returns the materialize reject code without projecting", async () => {
    let projected = false;
    const code = await runAdd({
      surface: "agent",
      name: "bot",
      noCore: true,
      brainRoot: BRAIN,
      materializeAgentFn: async () => ({
        ok: false,
        code: 2,
        vendoredDir: "",
        overlayWritten: "/o.json",
      }),
      captureAdapter: () => {
        projected = true;
        return { code: 0, output: "" };
      },
    });
    expect(code).toBe(2);
    expect(projected).toBe(false);
  });
});

describe("runAdd agent — core happy path", () => {
  it("writes core agent (mirrored) then projects + verifies → exit 0", async () => {
    let addCoreCalled = false;
    const code = await runAdd({
      surface: "agent",
      name: "bot",
      core: true,
      projectRoot: "/repo",
      brainRoot: BRAIN,
      addCoreAgentFn: (opts) => {
        addCoreCalled = true;
        expect(opts.name).toBe("bot");
        expect(opts.projectRoot).toBe("/repo");
        return okAddCoreAgent();
      },
      captureAdapter: cleanAdapter(),
    });
    expect(code).toBe(0);
    expect(addCoreCalled).toBe(true);
    expect(cap.out.join("")).toContain("Added core agent 'bot'");
  });

  it("returns the add-core reject code without projecting", async () => {
    let projected = false;
    const code = await runAdd({
      surface: "agent",
      name: "bot",
      core: true,
      projectRoot: "/repo",
      brainRoot: BRAIN,
      addCoreAgentFn: () => ({
        ok: false,
        code: 1,
        reason: "core agent prompt already exists",
        sourcePath: "/repo/core/agents/bot.md",
        mirrorPath: "/brain/core/agents/bot.md",
        verifyOutput: "",
      }),
      captureAdapter: () => {
        projected = true;
        return { code: 0, output: "" };
      },
    });
    expect(code).toBe(1);
    expect(projected).toBe(false);
    expect(cap.err.join("")).toContain("already exists");
  });

  it("TD-235: core agent projection skipped by the gate → non-zero + message", async () => {
    const code = await runAdd({
      surface: "agent",
      name: "bot",
      core: true,
      projectRoot: "/unowned",
      brainRoot: BRAIN,
      addCoreAgentFn: okAddCoreAgent,
      captureAdapter: (scriptPath) => {
        if (scriptPath.includes("compile_harnesses.sh")) {
          return {
            code: 1,
            output:
              "FAIL  core agents — not owned by --project-root /unowned; run from the igris-ai repo or pass --core\n",
          };
        }
        return { code: 0, output: "" };
      },
    });
    expect(code).not.toBe(0);
    expect(cap.err.join("")).toContain("not owned by --project-root /unowned");
  });
});

describe("runAdd mcp — personal happy path", () => {
  it("materializes via materializeMcp then projects + verifies → exit 0", async () => {
    let materializeCalled = false;
    const code = await runAdd({
      surface: "mcp",
      name: "myserver",
      noCore: true,
      command: "node",
      args: ["server.js"],
      env: ["API_KEY=${MY_TOKEN}"],
      targets: ["claude:merge"],
      brainRoot: BRAIN,
      materializeMcpFn: (opts, overlay) => {
        materializeCalled = true;
        // The mcp arm routes through the registry "add-mcp" action (R7 reuse).
        expect(opts.action).toBe("add-mcp");
        expect(opts.name).toBe("myserver");
        expect(opts.command).toBe("node");
        expect(opts.env).toEqual(["API_KEY=${MY_TOKEN}"]);
        expect(overlay).toBeDefined();
        return okMaterializeMcp();
      },
      captureAdapter: cleanAdapter(),
    });
    expect(code).toBe(0);
    expect(materializeCalled).toBe(true);
    expect(cap.out.join("")).toContain("Added personal MCP 'myserver'");
  });

  it("passes the just-added name as the verify --filter (S1 scoping)", async () => {
    let checkFilter: string | undefined;
    await runAdd({
      surface: "mcp",
      name: "myserver",
      noCore: true,
      command: "node",
      targets: ["claude:merge"],
      brainRoot: BRAIN,
      materializeMcpFn: okMaterializeMcp,
      captureAdapter: (scriptPath, args) => {
        if (scriptPath.includes("check_harness_drift.sh")) {
          const i = args.indexOf("--filter");
          checkFilter = i >= 0 ? args[i + 1] : undefined;
          return { code: 0, output: "  1 targets — 1 in sync, 0 drifted/missing\n" };
        }
        return { code: 0, output: "  OK    mcp/myserver/claude\n  1 targets — 1 ok, 0 failed\n" };
      },
    });
    // The verify (drift check) is scoped to the just-added MCP name (S1) so a
    // pre-existing UNRELATED MCP drift can't false-fail this add.
    expect(checkFilter).toBe("myserver");
  });

  it("returns the materialize reject code without projecting (incl. §14 secret reject)", async () => {
    let projected = false;
    const code = await runAdd({
      surface: "mcp",
      name: "myserver",
      noCore: true,
      brainRoot: BRAIN,
      materializeMcpFn: () => ({ ok: false, code: 2, overlayWritten: "/o.json" }),
      captureAdapter: () => {
        projected = true;
        return { code: 0, output: "" };
      },
    });
    expect(code).toBe(2);
    expect(projected).toBe(false);
  });
});

describe("runAdd mcp — core happy path", () => {
  it("appends the surfaces block (mirrored) then projects + verifies → exit 0", async () => {
    let addCoreCalled = false;
    const code = await runAdd({
      surface: "mcp",
      name: "myserver",
      core: true,
      projectRoot: "/repo",
      command: "node",
      targets: ["claude:merge"],
      brainRoot: BRAIN,
      addCoreMcpFn: (opts) => {
        addCoreCalled = true;
        expect(opts.name).toBe("myserver");
        expect(opts.projectRoot).toBe("/repo");
        expect(opts.command).toBe("node");
        return okAddCoreMcp();
      },
      captureAdapter: cleanAdapter(),
    });
    expect(code).toBe(0);
    expect(addCoreCalled).toBe(true);
    expect(cap.out.join("")).toContain("Added core MCP 'myserver'");
  });

  it("TD-235: core mcp projection skipped by the gate → non-zero + message", async () => {
    const code = await runAdd({
      surface: "mcp",
      name: "myserver",
      core: true,
      projectRoot: "/unowned",
      command: "node",
      targets: ["claude:merge"],
      brainRoot: BRAIN,
      addCoreMcpFn: okAddCoreMcp,
      captureAdapter: (scriptPath) => {
        if (scriptPath.includes("compile_harnesses.sh")) {
          return {
            code: 1,
            output:
              "FAIL  core mcp — not owned by --project-root /unowned; run from the igris-ai repo or pass --core\n",
          };
        }
        return { code: 0, output: "" };
      },
    });
    expect(code).not.toBe(0);
    expect(cap.err.join("")).toContain("not owned by --project-root /unowned");
  });
});

describe("runAdd identity — personal happy path (D6)", () => {
  it("materializes via materializeIdentity then projects + verifies → exit 0", async () => {
    let materializeCalled = false;
    const code = await runAdd({
      surface: "identity",
      name: "myid",
      noCore: true,
      targets: ["gemini:file:GEMINI.md"],
      brainRoot: BRAIN,
      materializeIdentityFn: (opts, overlay) => {
        materializeCalled = true;
        // The identity arm routes through the registry "add-identity" action.
        expect(opts.action).toBe("add-identity");
        expect(opts.name).toBe("myid");
        expect(opts.targets).toEqual(["gemini:file:GEMINI.md"]);
        expect(overlay).toBeDefined();
        return okMaterializeIdentity();
      },
      captureAdapter: cleanIdentityAdapter(),
    });
    expect(code).toBe(0);
    expect(materializeCalled).toBe(true);
    expect(cap.out.join("")).toContain("Added personal identity 'myid'");
  });

  it("projects the identity surface (--surface identity), NOT skills", async () => {
    let compileSurface: string | undefined;
    await runAdd({
      surface: "identity",
      name: "myid",
      noCore: true,
      targets: ["gemini:file:GEMINI.md"],
      brainRoot: BRAIN,
      materializeIdentityFn: okMaterializeIdentity,
      captureAdapter: (scriptPath, args) => {
        if (scriptPath.includes("compile_harnesses.sh")) {
          const i = args.indexOf("--surface");
          compileSurface = i >= 0 ? args[i + 1] : undefined;
          return {
            code: 0,
            output: "  OK    identity/gemini -> GEMINI.md (created)\n  1 targets — 1 ok\n",
          };
        }
        return { code: 0, output: "  [identity/gemini] MATCH\n  1 targets — 1 in sync\n" };
      },
    });
    expect(compileSurface).toBe("identity");
  });

  it("returns the materialize reject code without projecting (collision reject)", async () => {
    let projected = false;
    const code = await runAdd({
      surface: "identity",
      name: "myid",
      noCore: true,
      targets: ["gemini:file:GEMINI.md"],
      brainRoot: BRAIN,
      materializeIdentityFn: () => ({ ok: false, code: 1, overlayWritten: "/o.json" }),
      captureAdapter: () => {
        projected = true;
        return { code: 0, output: "" };
      },
    });
    expect(code).toBe(1);
    expect(projected).toBe(false);
  });
});

describe("runAdd identity — core happy path (D6)", () => {
  it("appends the os_identity block then projects + verifies → exit 0", async () => {
    let addCoreCalled = false;
    const code = await runAdd({
      surface: "identity",
      name: "myid",
      core: true,
      projectRoot: "/repo",
      targets: ["gemini:file:ZZID.md"],
      brainRoot: BRAIN,
      addCoreIdentityFn: (opts) => {
        addCoreCalled = true;
        expect(opts.name).toBe("myid");
        expect(opts.projectRoot).toBe("/repo");
        expect(opts.targets).toEqual(["gemini:file:ZZID.md"]);
        return okAddCoreIdentity();
      },
      captureAdapter: cleanIdentityAdapter(),
    });
    expect(code).toBe(0);
    expect(addCoreCalled).toBe(true);
    expect(cap.out.join("")).toContain("Added core identity 'myid'");
  });

  it("projects against the BRAIN ROOT with --expect-core + --manifest (coreProjectionParams)", async () => {
    let compileProjectRoot: string | undefined;
    let sawExpectCore = false;
    let sawManifest = false;
    await runAdd({
      surface: "identity",
      name: "myid",
      core: true,
      projectRoot: "/repo",
      targets: ["gemini:file:ZZID.md"],
      brainRoot: BRAIN,
      addCoreIdentityFn: okAddCoreIdentity,
      captureAdapter: (scriptPath, args) => {
        if (scriptPath.includes("compile_harnesses.sh")) {
          const pr = args.indexOf("--project-root");
          compileProjectRoot = pr >= 0 ? args[pr + 1] : undefined;
          sawExpectCore = args.includes("--expect-core");
          sawManifest = args.includes("--manifest");
          return {
            code: 0,
            output: "  OK    identity/gemini -> ZZID.md (created)\n  1 targets — 1 ok\n",
          };
        }
        return { code: 0, output: "  [identity/gemini] MATCH\n  1 targets — 1 in sync\n" };
      },
    });
    // The CORE projection runs against the BRAIN ROOT (not the checkout) so the
    // ownership gate passes, with --expect-core (D5) + the checkout manifest.
    expect(compileProjectRoot).toBe(BRAIN);
    expect(sawExpectCore).toBe(true);
    expect(sawManifest).toBe(true);
  });

  it("TD-235: core identity projection skipped by the gate → non-zero + message", async () => {
    const code = await runAdd({
      surface: "identity",
      name: "myid",
      core: true,
      projectRoot: "/unowned",
      targets: ["gemini:file:ZZID.md"],
      brainRoot: BRAIN,
      addCoreIdentityFn: okAddCoreIdentity,
      captureAdapter: (scriptPath) => {
        if (scriptPath.includes("compile_harnesses.sh")) {
          return {
            code: 1,
            output:
              "FAIL  core identity — not owned by --project-root /unowned; run from the igris-ai repo or pass --core\n",
          };
        }
        return { code: 0, output: "" };
      },
    });
    expect(code).not.toBe(0);
    expect(cap.err.join("")).toContain("not owned by --project-root /unowned");
  });
});

describe("runAdd hook — personal happy path (D7, Phase 5)", () => {
  it("materializes via materializeHook then projects + verifies → exit 0", async () => {
    let materializeCalled = false;
    const code = await runAdd({
      surface: "hook",
      name: "my-guard",
      noCore: true,
      event: "PreToolUse",
      matcher: "Write|Edit",
      brainRoot: BRAIN,
      materializeHookFn: (opts, overlay) => {
        materializeCalled = true;
        // The hook arm routes through the registry "add-hook" action (R7 reuse).
        expect(opts.action).toBe("add-hook");
        expect(opts.name).toBe("my-guard");
        expect(opts.event).toBe("PreToolUse");
        expect(opts.matcher).toBe("Write|Edit");
        expect(overlay).toBeDefined();
        return okMaterializeHook();
      },
      captureAdapter: cleanHookAdapter(),
    });
    expect(code).toBe(0);
    expect(materializeCalled).toBe(true);
    expect(cap.out.join("")).toContain("Added personal hook 'my-guard'");
    // R2: the success message names the update/doctor preservation contract.
    expect(cap.out.join("")).toContain("survives");
  });

  it("passes the just-added name as the verify --filter (S1 scoping)", async () => {
    let checkFilter: string | undefined;
    await runAdd({
      surface: "hook",
      name: "my-guard",
      noCore: true,
      event: "SessionStart",
      brainRoot: BRAIN,
      materializeHookFn: okMaterializeHook,
      captureAdapter: (scriptPath, args) => {
        if (scriptPath.includes("check_harness_drift.sh")) {
          const i = args.indexOf("--filter");
          checkFilter = i >= 0 ? args[i + 1] : undefined;
          return { code: 0, output: "  1 targets — 1 in sync, 0 drifted/missing\n" };
        }
        return { code: 0, output: "  OK    hook/my-guard/claude\n  1 targets — 1 ok, 0 failed\n" };
      },
    });
    expect(checkFilter).toBe("my-guard");
  });

  it("returns the materialize reject code without projecting", async () => {
    let projected = false;
    const code = await runAdd({
      surface: "hook",
      name: "my-guard",
      noCore: true,
      event: "PreToolUse",
      brainRoot: BRAIN,
      materializeHookFn: () => ({ ok: false, code: 1, overlayWritten: "/o.json" }),
      captureAdapter: () => {
        projected = true;
        return { code: 0, output: "" };
      },
    });
    expect(code).toBe(1);
    expect(projected).toBe(false);
  });
});

describe("runAdd hook — core happy path (D7, Phase 5)", () => {
  it("writes the shared script + surfaces block then projects + verifies → exit 0", async () => {
    let addCoreCalled = false;
    const code = await runAdd({
      surface: "hook",
      name: "core-guard",
      core: true,
      projectRoot: "/repo",
      event: "PostToolUse",
      brainRoot: BRAIN,
      addCoreHookFn: (opts) => {
        addCoreCalled = true;
        expect(opts.name).toBe("core-guard");
        expect(opts.projectRoot).toBe("/repo");
        expect(opts.event).toBe("PostToolUse");
        return okAddCoreHook();
      },
      captureAdapter: cleanHookAdapter(),
    });
    expect(code).toBe(0);
    expect(addCoreCalled).toBe(true);
    expect(cap.out.join("")).toContain("Added core hook 'core-guard'");
  });

  it("TD-235: core hook projection skipped by the gate → non-zero + message", async () => {
    const code = await runAdd({
      surface: "hook",
      name: "core-guard",
      core: true,
      projectRoot: "/unowned",
      event: "PreToolUse",
      brainRoot: BRAIN,
      addCoreHookFn: okAddCoreHook,
      captureAdapter: (scriptPath) => {
        if (scriptPath.includes("compile_harnesses.sh")) {
          return {
            code: 1,
            output:
              "FAIL  core surfaces — 0 targets matched under --expect-core for --project-root /unowned; run from the igris-ai repo or pass --core\n",
          };
        }
        return { code: 0, output: "" };
      },
    });
    expect(code).not.toBe(0);
    // The loud-fail FAIL row is surfaced verbatim in the add-orchestrate reason.
    expect(cap.err.join("")).toContain("0 targets matched under --expect-core");
    expect(cap.err.join("")).toContain("/unowned");
  });
});

describe("runAdd skill — TD-235 no-silent-no-op regression (CRITICAL)", () => {
  it("core projection skipped by the ownership gate → non-zero + message", async () => {
    // The compile adapter (under --expect-core) returns a loud FAIL row + a
    // non-zero exit, simulating the gate skipping a declared-but-unowned core
    // skill. `add` must surface it as a failure — NOT a phantom success.
    const code = await runAdd({
      surface: "skill",
      name: "foo",
      core: true,
      projectRoot: "/unowned",
      brainRoot: BRAIN,
      addCoreSkillFn: okAddCore,
      captureAdapter: (scriptPath) => {
        if (scriptPath.includes("compile_harnesses.sh")) {
          return {
            code: 1,
            output:
              "FAIL  core skills — not owned by --project-root /unowned; run from the igris-ai repo or pass --core\n",
          };
        }
        return { code: 0, output: "" };
      },
    });
    expect(code).not.toBe(0);
    expect(cap.err.join("")).toContain("not owned by --project-root /unowned");
  });

  it("0-projected compile → loud failure, never a phantom success", async () => {
    const code = await runAdd({
      surface: "skill",
      name: "foo",
      core: true,
      projectRoot: "/repo",
      brainRoot: BRAIN,
      addCoreSkillFn: okAddCore,
      captureAdapter: (scriptPath) => {
        if (scriptPath.includes("compile_harnesses.sh")) {
          return {
            code: 0,
            output:
              "No agent/skills/mcp/identity targets matched (filter='*', target='all', surface='skills').\n",
          };
        }
        return { code: 0, output: "" };
      },
    });
    expect(code).not.toBe(0);
    expect(cap.err.join("")).toContain("projection/verify failed");
  });

  it("incidental personal compile emits the visible SKIPPED line + exit-0", async () => {
    const code = await runAdd({
      surface: "skill",
      name: "foo",
      noCore: true,
      from: "/src",
      targets: ["claude:symlink:~/.claude/skills"],
      brainRoot: BRAIN,
      materializeSkillFn: okMaterialize,
      captureAdapter: (scriptPath) => {
        if (scriptPath.includes("compile_harnesses.sh")) {
          // A real personal project where the gate skipped core surfaces but
          // the personal skill DID project (1 target).
          return {
            code: 0,
            output:
              "SKIPPED core surfaces (personal-project compile)\n" +
              "  OK    skills/claude -> x\n  1 targets — 1 ok, 0 failed\n",
          };
        }
        return { code: 0, output: "  1 targets — 1 in sync, 0 drifted/missing\n" };
      },
    });
    expect(code).toBe(0);
    // The SKIPPED line is surfaced (info → stdout) but does not fail the add.
    expect(cap.out.join("")).toContain(
      "SKIPPED core surfaces (personal-project compile)",
    );
  });
});

describe("detectCoreRepo — real filesystem signal", () => {
  it("returns false for a non-checkout dir", () => {
    expect(detectCoreRepo("/tmp")).toBe(false);
  });

  it("returns true for the actual igris-ai repo root", () => {
    // The test runs from the cli/ subdir; the repo root is two levels up.
    const repoRoot = new URL("../../..", import.meta.url).pathname;
    expect(detectCoreRepo(repoRoot)).toBe(true);
  });
});

// --- S2: back-compat — registry add-skill is the WRITE-ONLY primitive -------
describe("back-compat: registry add-skill is write-only (does NOT project)", () => {
  let tmpRoot: string;
  let overlayPath: string;
  let originsPath: string;
  let projectRoot: string;
  let vendorBase: string;
  let skillSrc: string;
  let projectionTargetDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "igris-add-backcompat-"));
    overlayPath = join(tmpRoot, "overlay.json");
    originsPath = join(tmpRoot, "origins.json");
    vendorBase = join(tmpRoot, "registry");
    projectRoot = join(tmpRoot, "proj");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "harness-manifest.json"), '{"version":1,"agents":[]}\n');
    // Source skill dir (single-skill shape).
    skillSrc = join(tmpRoot, "src", "bctool");
    mkdirSync(skillSrc, { recursive: true });
    writeFileSync(
      join(skillSrc, "SKILL.md"),
      '---\nname: bctool\ndescription: "x - usage: /bctool"\n---\nbody\n',
    );
    // The dir a projection symlink WOULD land in if anything projected.
    projectionTargetDir = join(tmpRoot, "projected");
    mkdirSync(projectionTargetDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes the overlay block but creates NO projection symlink", async () => {
    const code = await runRegistry({
      action: "add-skill",
      name: "bctool",
      from: skillSrc,
      targets: [`claude:symlink:${projectionTargetDir}`],
      projectRoot,
      overlayPath,
      originsPath,
      skillVendorDir: (n: string) => join(vendorBase, "skills", n),
    });
    expect(code).toBe(0);

    // The overlay block WAS written (the write half ran).
    expect(existsSync(overlayPath)).toBe(true);
    expect(readFileSync(overlayPath, "utf-8")).toContain("bctool");

    // But NOTHING projected — registry add-skill is write-only. The projection
    // symlink that `igris add skill` (or `harness compile`) would create does
    // NOT exist here.
    expect(existsSync(join(projectionTargetDir, "bctool"))).toBe(false);
  });
});
