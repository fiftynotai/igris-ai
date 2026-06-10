/**
 * `igris add <skill|agent|mcp|hook|identity> <name> [--from …]` — FR-180.
 *
 * The unified, one-step, self-verifying surface-add verb. Collapses the old
 * `registry add-* → harness compile` two-step into ONE atomic command that
 * materializes (vendor/register for personal, write `core/` for core) AND
 * projects to all four harnesses AND verifies (drift-clean), with a LOUD
 * failure on any no-op (TD-235).
 *
 * Layering (D9 — `add` orchestrates, it does NOT re-implement the write path):
 *   - personal materialize  → `verbs/registry.ts` (`materializeSkill`, …) —
 *     the heavily-tested write path, reused verbatim (R7 guard).
 *   - core materialize       → `verbs/add-core.ts` (`addCoreSkill`, …).
 *   - project + verify       → `lib/add-orchestrate.ts` (`projectAndVerify`) —
 *     the shared TD-235 chokepoint that runs compile then check for one
 *     surface and converts a 0-projected outcome into a loud failure.
 *
 * Do NOT confuse with `verbs/install.ts:runInstall` (project bootstrap) or
 * `verbs/registry.ts:runRegistry` (the low-level write verb this wraps).
 *
 * Phase 0 + Phase 1 of FR-180 ship the dispatcher + the `skill` arm; Phase 2
 * adds the `agent` arm end-to-end (personal + core); Phase 3 adds the `mcp` arm
 * (personal via the structured `materializeMcp` wrapper over the existing MCP
 * writer; core via `addCoreMcp`). The remaining 2 arms (hook/identity) are wired
 * with `notImplementedYet` stubs.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { registryOverlayPath } from "../lib/paths.js";
import { info, error as logError } from "../lib/log.js";
import {
  materializeSkill,
  materializeAgent,
  materializeMcp,
  realpathStrict,
  type RegistryOptions,
} from "./registry.js";
import { projectAndVerify } from "../lib/add-orchestrate.js";
import { addCoreSkill, addCoreAgent, addCoreMcp } from "./add-core.js";

/** The five surfaces `igris add` dispatches over. */
export type AddSurface = "skill" | "agent" | "mcp" | "hook" | "identity";

const ADD_SURFACES: readonly AddSurface[] = [
  "skill",
  "agent",
  "mcp",
  "hook",
  "identity",
] as const;

/** Resolved core-vs-personal mode (D1). */
export type AddMode = "core" | "personal";

/** Options for `igris add`. */
export interface AddOptions {
  /** Which surface to add (skill/agent/mcp/hook/identity). */
  surface: string;
  /** The surface name (skill/agent/mcp/identity) — positional or --name. */
  name?: string;
  /** Source dir / github ref (skill/agent/mcp --from). */
  from?: string;
  /** Output targets, each `type:method:path` (skill) / `type:path` (agent). */
  targets?: string[];
  /** Force CORE mode (edit the igris-ai checkout). Wins over auto-detect. */
  core?: boolean;
  /** Force PERSONAL mode. Wins over auto-detect. */
  noCore?: boolean;
  /**
   * MCP launch command (mcp arm). Required for a NEW MCP server; optional on a
   * same-name personal re-add (inherits the existing block's canonical command).
   */
  command?: string;
  /** MCP launch args (mcp arm; repeatable --arg → args[]). */
  args?: string[];
  /**
   * MCP env indirection refs as "KEY=${VAR}" strings (mcp arm; repeatable
   * --env). §14 SECURITY: each VALUE must be a single ${VAR} reference — inline
   * secrets are REJECTED at the writer boundary (FR-160 decision #1).
   */
  env?: string[];
  /** MCP Codex-only startup-timeout passthrough in seconds (mcp arm). */
  startupTimeoutSec?: number;
  /**
   * Root the auto-detect + project+verify resolve against. Defaults to cwd.
   * In core mode this is also the `--project-root` passed to compile/check.
   */
  projectRoot?: string;
  /** Restrict projection to one harness (claude|codex|gemini|opencode). */
  target?: string;
  /** Test seam: overlay-path override (personal). */
  overlayPath?: string;
  /** Test seam: brain root override (defaults to brainDir()). */
  brainRoot?: string;
  /**
   * Test seam: capturing adapter runner forwarded to projectAndVerify so the
   * project+verify chain can be exercised without spawning a shell.
   */
  captureAdapter?: import("./harness.js").AdapterCaptureFn;
  /**
   * Test seam: core-repo detector override. Defaults to {@link detectCoreRepo}.
   * Lets unit tests assert mode resolution without a real igris-ai checkout.
   */
  detectCore?: (projectRoot: string) => boolean;
  /**
   * Test seam: core materialize override (defaults to addCoreSkill). Lets the
   * dispatcher routing be tested without writing real `core/` files.
   */
  addCoreSkillFn?: typeof addCoreSkill;
  /** Test seam: personal materialize override (defaults to materializeSkill). */
  materializeSkillFn?: typeof materializeSkill;
  /**
   * Test seam: core AGENT materialize override (defaults to addCoreAgent). Lets
   * the agent arm be tested without writing real `core/` files / manifest.
   */
  addCoreAgentFn?: typeof addCoreAgent;
  /** Test seam: personal AGENT materialize override (defaults to materializeAgent). */
  materializeAgentFn?: typeof materializeAgent;
  /**
   * Test seam: core MCP materialize override (defaults to addCoreMcp). Lets the
   * mcp arm be tested without writing the real `core/` surfaces manifest.
   */
  addCoreMcpFn?: typeof addCoreMcp;
  /** Test seam: personal MCP materialize override (defaults to materializeMcp). */
  materializeMcpFn?: typeof materializeMcp;
}

/**
 * D1: detect whether `projectRoot` is the igris-ai source checkout. The signal
 * is the same one the compile ownership gate keys on (commonpath): a real
 * `core/scripts/cli-adapters/surfaces-manifest.json` AND a repo-root
 * `harness-manifest.json`. Resolved via realpath so a symlinked checkout path
 * is normalized. Returns false on any resolution failure (safe default →
 * personal).
 */
export function detectCoreRepo(projectRoot: string): boolean {
  let root: string;
  try {
    root = realpathStrict(projectRoot);
  } catch {
    return false;
  }
  const surfacesManifest = join(
    root,
    "core",
    "scripts",
    "cli-adapters",
    "surfaces-manifest.json",
  );
  const repoManifest = join(root, "harness-manifest.json");
  return existsSync(surfacesManifest) && existsSync(repoManifest);
}

/** Discriminated result of {@link resolveAddMode}: a mode OR a usage error. */
export type ResolveModeResult =
  | { ok: true; mode: AddMode }
  | { ok: false; error: string };

/**
 * Resolve core-vs-personal mode (D1). Explicit flags win over auto-detect;
 * `--core` and `--no-core` together is a usage error. Returns a discriminated
 * result so a valid mode (`"core"`/`"personal"` — both strings) is never
 * confused with the usage-error message.
 */
export function resolveAddMode(
  opts: Pick<AddOptions, "core" | "noCore" | "projectRoot" | "detectCore">,
): ResolveModeResult {
  if (opts.core === true && opts.noCore === true) {
    return { ok: false, error: "add: --core and --no-core are mutually exclusive" };
  }
  if (opts.core === true) {
    return { ok: true, mode: "core" };
  }
  if (opts.noCore === true) {
    return { ok: true, mode: "personal" };
  }
  const projectRoot = opts.projectRoot ?? process.cwd();
  const detect = opts.detectCore ?? detectCoreRepo;
  return { ok: true, mode: detect(projectRoot) ? "core" : "personal" };
}

/**
 * Stub for the surfaces not yet implemented (hook/identity). Prints an
 * actionable not-yet message and returns exit 2.
 */
function notImplementedYet(surface: AddSurface, mode: AddMode): number {
  logError(
    `add ${surface}: not implemented yet (FR-180 ships 'skill', 'agent' + 'mcp' ` +
      `end-to-end; hook/identity land in later phases). Resolved mode would be: ${mode}. ` +
      `For now use the low-level path: 'igris registry add-* …' then 'igris harness compile'.`,
  );
  return 2;
}

/**
 * The `skill` arm — Phase 1 vertical slice. Personal: materialize via the
 * registry writer, then projectAndVerify("skills"). Core: write the SKILL.md
 * scaffold + TD-096 mirror via add-core, then projectAndVerify from the
 * (auto-detected) repo root with --expect-core.
 */
async function runAddSkillArm(opts: AddOptions, mode: AddMode): Promise<number> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  if (mode === "core") {
    const addCore = opts.addCoreSkillFn ?? addCoreSkill;
    const coreResult = addCore({
      name: opts.name,
      projectRoot,
      brainRoot: opts.brainRoot,
    });
    if (!coreResult.ok) {
      logError(`add skill (core): ${coreResult.reason}`);
      return coreResult.code;
    }
    // Project + verify from the repo root; --expect-core makes an ownership-
    // gate skip a LOUD failure (D5) rather than a silent no-op.
    const verify = await projectAndVerify({
      surface: "skills",
      projectRoot,
      expectCore: true,
      target: opts.target,
      // S1: scope the verify (check) pass to the just-added skill name so
      // pre-existing unrelated drift doesn't false-fail this add.
      filter: opts.name,
      brainRoot: opts.brainRoot,
      captureAdapter: opts.captureAdapter,
    });
    if (!verify.ok) {
      logError(`add skill (core): projection/verify failed — ${verify.reason}`);
      return 1;
    }
    for (const line of verify.coreSkipped) {
      info(line);
    }
    info(
      `Added core skill '${opts.name}': wrote core/skills/${opts.name}/SKILL.md, ` +
        `mirrored to runtime, projected ${verify.projected.length} target(s), drift-clean.`,
    );
    return 0;
  }

  // ----- Personal mode. -----
  const overlayPath = opts.overlayPath ?? registryOverlayPath();
  const materialize = opts.materializeSkillFn ?? materializeSkill;
  const regOpts: RegistryOptions = {
    action: "add-skill",
    name: opts.name,
    from: opts.from,
    targets: opts.targets,
    projectRoot,
    overlayPath,
  };
  const mat = materialize(regOpts, overlayPath);
  if (!mat.ok) {
    // runAddSkill already logged the specific reject; surface the code.
    return mat.code;
  }
  const verify = await projectAndVerify({
    surface: "skills",
    projectRoot,
    expectCore: false,
    target: opts.target,
    // S1: scope the verify (check) pass to the just-added skill name so
    // pre-existing unrelated drift doesn't false-fail this add.
    filter: opts.name,
    overlay: overlayPath,
    brainRoot: opts.brainRoot,
    captureAdapter: opts.captureAdapter,
  });
  if (!verify.ok) {
    logError(`add skill: projection/verify failed — ${verify.reason}`);
    return 1;
  }
  for (const line of verify.coreSkipped) {
    info(line);
  }
  info(
    `Added personal skill '${opts.name}': vendored + projected ` +
      `${verify.projected.length} target(s), drift-clean.`,
  );
  return 0;
}

/**
 * The `agent` arm — Phase 2. Mirrors the skill arm's shape (the proven pattern):
 * resolve mode → materialize (personal via the structured-return `materializeAgent`
 * wrapper over the existing agent writer; core via `addCoreAgent`) →
 * `projectAndVerify("agents", …)`. The verify is NAME-SCOPED via `--filter`
 * (S1), which is already wired for the AGENTS surface (fnmatch on agent name) in
 * both compile + check — so agent verify scoping works natively (unlike skills,
 * which the Phase-1 slice had to wire).
 */
async function runAddAgentArm(opts: AddOptions, mode: AddMode): Promise<number> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  if (mode === "core") {
    const addCore = opts.addCoreAgentFn ?? addCoreAgent;
    const coreResult = addCore({
      name: opts.name,
      projectRoot,
      brainRoot: opts.brainRoot,
    });
    if (!coreResult.ok) {
      logError(`add agent (core): ${coreResult.reason}`);
      return coreResult.code;
    }
    // Project + verify from the repo root; --expect-core makes an ownership-
    // gate skip a LOUD failure (D5) rather than a silent no-op.
    const verify = await projectAndVerify({
      surface: "agents",
      projectRoot,
      expectCore: true,
      target: opts.target,
      // S1: scope the verify (check) pass to the just-added agent name so
      // pre-existing unrelated drift doesn't false-fail this add.
      filter: opts.name,
      brainRoot: opts.brainRoot,
      captureAdapter: opts.captureAdapter,
    });
    if (!verify.ok) {
      logError(`add agent (core): projection/verify failed — ${verify.reason}`);
      return 1;
    }
    for (const line of verify.coreSkipped) {
      info(line);
    }
    info(
      `Added core agent '${opts.name}': wrote core/agents/${opts.name}.md, ` +
        `appended the harness-manifest.json entry, updated the §13 agent surfaces, ` +
        `mirrored to runtime, projected ${verify.projected.length} target(s), drift-clean.`,
    );
    return 0;
  }

  // ----- Personal mode. -----
  const overlayPath = opts.overlayPath ?? registryOverlayPath();
  const materialize = opts.materializeAgentFn ?? materializeAgent;
  const regOpts: RegistryOptions = {
    action: "add",
    name: opts.name,
    from: opts.from,
    targets: opts.targets,
    projectRoot,
    overlayPath,
  };
  const mat = await materialize(regOpts, overlayPath);
  if (!mat.ok) {
    // runAdd already logged the specific reject; surface the code.
    return mat.code;
  }
  const verify = await projectAndVerify({
    surface: "agents",
    projectRoot,
    expectCore: false,
    target: opts.target,
    // S1: scope the verify (check) pass to the just-added agent name so
    // pre-existing unrelated drift doesn't false-fail this add.
    filter: opts.name,
    overlay: overlayPath,
    brainRoot: opts.brainRoot,
    captureAdapter: opts.captureAdapter,
  });
  if (!verify.ok) {
    logError(`add agent: projection/verify failed — ${verify.reason}`);
    return 1;
  }
  for (const line of verify.coreSkipped) {
    info(line);
  }
  info(
    `Added personal agent '${opts.name}': vendored + projected ` +
      `${verify.projected.length} target(s), drift-clean.`,
  );
  return 0;
}

/**
 * The `mcp` arm — Phase 3. Mirrors the skill/agent arms' shape (the proven
 * pattern): resolve mode → materialize → `projectAndVerify("mcp", …)`. Personal
 * uses the structured-return `materializeMcp` wrapper over the EXISTING MCP
 * writer (R7 — no logic moved; the §14 `--env` `${VAR}`-indirection WRITE GUARD
 * that rejects inline secrets is inherited verbatim from `runAddMcp`); core uses
 * `addCoreMcp` (append a `surfaces.mcp_servers[]` block to the core surfaces
 * manifest + TD-096 mirror).
 *
 * S1 (the flagged MCP-scoping discovery — see the FLAG in the completion
 * summary): unlike skills/agents, the MCP compile + drift passes did NOT honor
 * `--filter` by name (the MCP drift pass checks ALL mcp blocks across all 4
 * harness configs). Phase 3 WIRES `--filter` into the MCP passes (byte-identical
 * across compile + check, §18.1) reusing the generic name-glob matcher; the arm
 * passes `filter: opts.name` so the verify (drift check, which has no `--surface`
 * flag) is scoped to the just-added MCP server — preventing a pre-existing
 * UNRELATED MCP drift from false-failing a clean add (parity with skills S1).
 */
async function runAddMcpArm(opts: AddOptions, mode: AddMode): Promise<number> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  if (mode === "core") {
    const addCore = opts.addCoreMcpFn ?? addCoreMcp;
    const coreResult = addCore({
      name: opts.name,
      projectRoot,
      command: opts.command,
      args: opts.args,
      env: opts.env,
      targets: opts.targets,
      startupTimeoutSec: opts.startupTimeoutSec,
      brainRoot: opts.brainRoot,
    });
    if (!coreResult.ok) {
      logError(`add mcp (core): ${coreResult.reason}`);
      return coreResult.code;
    }
    // Project + verify from the repo root; --expect-core makes an ownership-
    // gate skip a LOUD failure (D5) rather than a silent no-op.
    const verify = await projectAndVerify({
      surface: "mcp",
      projectRoot,
      expectCore: true,
      target: opts.target,
      // S1: scope the verify (check) pass to the just-added MCP name so
      // pre-existing unrelated MCP drift doesn't false-fail this add.
      filter: opts.name,
      brainRoot: opts.brainRoot,
      captureAdapter: opts.captureAdapter,
    });
    if (!verify.ok) {
      logError(`add mcp (core): projection/verify failed — ${verify.reason}`);
      return 1;
    }
    for (const line of verify.coreSkipped) {
      info(line);
    }
    info(
      `Added core MCP '${opts.name}': appended the surfaces.mcp_servers block, ` +
        `mirrored to runtime, projected ${verify.projected.length} target(s), drift-clean.`,
    );
    return 0;
  }

  // ----- Personal mode. -----
  const overlayPath = opts.overlayPath ?? registryOverlayPath();
  const materialize = opts.materializeMcpFn ?? materializeMcp;
  const regOpts: RegistryOptions = {
    action: "add-mcp",
    name: opts.name,
    command: opts.command,
    args: opts.args,
    env: opts.env,
    targets: opts.targets,
    startupTimeoutSec: opts.startupTimeoutSec,
    projectRoot,
    overlayPath,
  };
  const mat = materialize(regOpts, overlayPath);
  if (!mat.ok) {
    // runAddMcp already logged the specific reject (incl. the §14 inline-secret
    // rejection); surface the code.
    return mat.code;
  }
  const verify = await projectAndVerify({
    surface: "mcp",
    projectRoot,
    expectCore: false,
    target: opts.target,
    // S1: scope the verify (check) pass to the just-added MCP name so
    // pre-existing unrelated MCP drift doesn't false-fail this add.
    filter: opts.name,
    overlay: overlayPath,
    brainRoot: opts.brainRoot,
    captureAdapter: opts.captureAdapter,
  });
  if (!verify.ok) {
    logError(`add mcp: projection/verify failed — ${verify.reason}`);
    return 1;
  }
  for (const line of verify.coreSkipped) {
    info(line);
  }
  info(
    `Added personal MCP '${opts.name}': registered + projected ` +
      `${verify.projected.length} target(s), drift-clean.`,
  );
  return 0;
}

/**
 * Dispatch `igris add <surface> <name>`. Returns the exit code. A bad surface
 * is a usage error (exit 2). Mode resolution (D1) runs once up front and is
 * PRINTED so it is never silent.
 */
export async function runAdd(opts: AddOptions): Promise<number> {
  const surface = opts.surface as AddSurface;
  if (!ADD_SURFACES.includes(surface)) {
    logError(
      `add: unknown surface '${opts.surface}'. ` +
        `Valid: ${ADD_SURFACES.join(", ")}.`,
    );
    return 2;
  }

  const resolved = resolveAddMode(opts);
  if (!resolved.ok) {
    logError(resolved.error);
    return 2;
  }
  const mode = resolved.mode;

  // D1: never silent — announce the resolved mode.
  if (mode === "core") {
    info(
      `add ${surface}: operating in CORE mode — editing the igris-ai checkout ` +
        `at ${opts.projectRoot ?? process.cwd()}.`,
    );
  } else {
    info(`add ${surface}: operating in PERSONAL mode (registry overlay).`);
  }

  switch (surface) {
    case "skill":
      return runAddSkillArm(opts, mode);
    case "agent":
      return runAddAgentArm(opts, mode);
    case "mcp":
      return runAddMcpArm(opts, mode);
    case "hook":
    case "identity":
      return notImplementedYet(surface, mode);
    default:
      // Exhaustiveness — unreachable given the ADD_SURFACES guard above.
      logError(`add: unhandled surface '${String(surface)}'`);
      return 2;
  }
}
