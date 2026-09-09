/**
 * `igris add <skill|agent|mcp|hook> <name> [--from …]` — FR-180.
 *
 * The unified, one-step, self-verifying surface-add verb. Collapses the old
 * `loadout add-* → harness compile` two-step into ONE atomic command that
 * materializes (vendor/register for personal, write `core/` for core) AND
 * projects to every harness whose descriptor declares that surface — skills and
 * MCP to every harness with an `agent_id`, agents to every harness with an
 * `agents` block, hooks to every harness with `hooks.supported` true — AND
 * verifies (drift-clean), with a LOUD failure on any no-op (TD-235).
 *
 * Layering (D9 — `add` orchestrates, it does NOT re-implement the write path):
 *   - personal materialize  → `verbs/loadout.ts` (`materializeSkill`, …) —
 *     the heavily-tested write path, reused verbatim (R7 guard).
 *   - core materialize       → `verbs/add-core.ts` (`addCoreSkill`, …).
 *   - project + verify       → `lib/add-orchestrate.ts` (`projectAndVerify`) —
 *     the shared TD-235 chokepoint that runs compile then check for one
 *     surface and converts a 0-projected outcome into a loud failure.
 *
 * Do NOT confuse with `verbs/install.ts:runInstall` (project bootstrap) or
 * `verbs/loadout.ts:runLoadout` (the low-level write verb this wraps).
 *
 * Phase 0 + Phase 1 of FR-180 ship the dispatcher + the `skill` arm; Phase 2
 * adds the `agent` arm end-to-end (personal + core); Phase 3 adds the `mcp` arm
 * (personal via the structured `materializeMcp` wrapper over the existing MCP
 * writer; core via `addCoreMcp`). Phase 5 adds the `hook` arm — the net-new
 * first-class surface (D7, Option B): personal via the `materializeHook` wrapper
 * over `runAddHook` (which writes the loadout hook script + a `surfaces.hooks[]`
 * overlay block; the loadout-prefix command is what the canonical re-merge
 * preserves — R2); core via `addCoreHook`. (FR-202 M4 retired the `identity` arm
 * along with the os_identity surface — the delegation mechanism is now a context
 * layer, core/os/harness-specific/<harness>.md, not an `igris add` surface.)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { brainDir, loadoutOverlayPath } from "../lib/paths.js";
import { info, error as logError } from "../lib/log.js";
import {
  materializeSkill,
  materializeAgent,
  materializeMcp,
  materializeHook,
  realpathStrict,
  type LoadoutOptions,
} from "./loadout.js";
import { projectAndVerify } from "../lib/add-orchestrate.js";
import {
  addCoreSkill,
  addCoreAgent,
  addCoreMcp,
  addCoreHook,
} from "./add-core.js";

/** The four surfaces `igris add` dispatches over. */
export type AddSurface = "skill" | "agent" | "mcp" | "hook";

const ADD_SURFACES: readonly AddSurface[] = [
  "skill",
  "agent",
  "mcp",
  "hook",
] as const;

/** Resolved core-vs-personal mode (D1). */
export type AddMode = "core" | "personal";

/** Options for `igris add`. */
export interface AddOptions {
  /** Which surface to add (skill/agent/mcp/hook). */
  surface: string;
  /** The surface name (skill/agent/mcp) — positional or --name. */
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
   * Hook event (hook arm; `--event`). One of the six PORTABLE_EVENTS. Required
   * for the hook arm.
   */
  event?: string;
  /** Hook tool-name glob for Pre/PostToolUse (hook arm; `--matcher`). */
  matcher?: string;
  /** Hook per-hook timeout in seconds (hook arm; `--timeout`). */
  timeout?: number;
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
  /**
   * Test seam: core HOOK materialize override (defaults to addCoreHook). Lets
   * the hook arm be tested without writing the real core script/manifest.
   */
  addCoreHookFn?: typeof addCoreHook;
  /** Test seam: personal HOOK materialize override (defaults to materializeHook). */
  materializeHookFn?: typeof materializeHook;
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

/** The PROJECTION project-root + agent manifest a core `add` projects against. */
export interface CoreProjectionParams {
  /** The `--project-root` the compile/check passes resolve against. */
  projectRoot: string;
  /** The `--manifest` (base agent manifest) the compile/check passes read. */
  manifest: string;
}

/**
 * FR-180 cross-phase fix: compute the PROJECTION params for a core `add`.
 *
 * The materialize half writes the source (`core/skills|agents/…`, the repo
 * `harness-manifest.json` entry, the runtime `surfaces-manifest.json` block) +
 * TD-096 mirror, anchored at the igris-ai CHECKOUT (`materializeRoot`). But the
 * projection half MUST run against the RUNTIME BRAIN ROOT (`~/.igris`), NOT the
 * checkout, for two empirically-verified reasons:
 *
 *   1. OWNERSHIP GATE (mcp + hook). The compile/check ownership gate keys on
 *      `commonpath(realpath(<runtime surfaces-manifest.json>), realpath(<project-
 *      root>)) == realpath(<project-root>)`. The runtime manifest lives under
 *      `~/.igris/core/scripts/cli-adapters/`, so only a project-root that is an
 *      ANCESTOR of it (i.e. `~/.igris`, or `~/.igris/core`) is "owner". The
 *      checkout is NOT an ancestor → the gate drops the core mcp/hook blocks for
 *      a non-owner, which under `--expect-core` surfaces the LOUD 0-targets
 *      foot-guard (`FAIL core surfaces — 0 targets matched …`). `~/.igris`
 *      (= `brainDir()`) satisfies it. (FR-218: SKILLS are now EXEMPT from this
 *      gate — they are global/user-level and are always (re)projected to the
 *      global store from ANY root; reason #2 still anchors the whole add here.)
 *
 *   2. CANONICAL RESOLUTION (agents). The repo `harness-manifest.json`
 *      stores agent `canonical.dir` as the PROJECT-RELATIVE `core/agents`. That
 *      resolves as
 *      `<project-root>/core/agents/<name>.md`. Under `~/.igris` that is exactly
 *      `~/.igris/core/agents/<name>.md` — the runtime mirror the materialize step
 *      just wrote. (Under the checkout it would also resolve, but the checkout
 *      fails reason #1; under `~/.igris/core` it would DOUBLE to
 *      `~/.igris/core/core/agents` and miss. `~/.igris` is the unique root that
 *      satisfies BOTH constraints for ALL three surfaces.)
 *
 * Because `~/.igris` carries no `harness-manifest.json` of its own (the brain
 * ships the schema, not the data manifest — agents live in the CHECKOUT's
 * manifest), the agent manifest must be passed explicitly as
 * `<materializeRoot>/harness-manifest.json`.
 *
 * One helper → one fix for skill + agent + mcp + hook core adds. PERSONAL
 * projection is UNCHANGED — its
 * surfaces project from the overlay under the user's own project root, which the
 * ownership gate never skips.
 *
 * D5/TD-235 is PRESERVED: this only changes the project-root the `add` path
 * passes; the loud-FAIL still fires for a genuinely mis-routed `--expect-core`
 * compile whose project-root owns nothing.
 */
export function coreProjectionParams(
  materializeRoot: string,
  brainRoot?: string,
): CoreProjectionParams {
  return {
    projectRoot: brainRoot ?? brainDir(),
    manifest: join(materializeRoot, "harness-manifest.json"),
  };
}

/**
 * The `hook` arm — Phase 5 (D7 — Option B, the NET-NEW first-class surface).
 * Mirrors the mcp arm's shape: resolve mode → materialize → `projectAndVerify(
 * "hook", …)`. Personal uses the structured-return `materializeHook` wrapper
 * over `runAddHook` (R7 — every guard runs in the writer; the personal hook's
 * command lives under the LOADOUT prefix so the canonical re-merge preserves it
 * — R2). Core uses `addCoreHook` (write the shared script + a `surfaces.hooks[]`
 * block + TD-096 mirror).
 *
 * The projection is a config-MERGE into each harness's native hook surface
 * (claude → .claude/settings.json hooks array; opencode → covered by the FR-104
 * plugin). S1: scoped to the just-added hook NAME via `--filter`.
 */
async function runAddHookArm(opts: AddOptions, mode: AddMode): Promise<number> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  if (mode === "core") {
    const addCore = opts.addCoreHookFn ?? addCoreHook;
    const coreResult = addCore({
      name: opts.name,
      projectRoot,
      event: opts.event,
      matcher: opts.matcher,
      timeout: opts.timeout,
      targets: opts.targets,
      brainRoot: opts.brainRoot,
    });
    if (!coreResult.ok) {
      logError(`add hook (core): ${coreResult.reason}`);
      return coreResult.code;
    }
    // Project + verify against the RUNTIME BRAIN ROOT (NOT the checkout) so the
    // ownership gate PASSES and the runtime-mirrored surfaces.hooks block is the
    // one projected; --expect-core keeps a genuine mis-route a LOUD failure (D5).
    const proj = coreProjectionParams(projectRoot, opts.brainRoot);
    const verify = await projectAndVerify({
      surface: "hook",
      projectRoot: proj.projectRoot,
      manifest: proj.manifest,
      expectCore: true,
      target: opts.target,
      filter: opts.name,
      brainRoot: opts.brainRoot,
      captureAdapter: opts.captureAdapter,
    });
    if (!verify.ok) {
      logError(`add hook (core): projection/verify failed — ${verify.reason}`);
      return 1;
    }
    for (const line of verify.coreSkipped) {
      info(line);
    }
    info(
      `Added core hook '${opts.name}' on ${opts.event}: wrote the shared script + the ` +
        `surfaces.hooks block, mirrored to runtime, projected ${verify.projected.length} ` +
        `target(s), drift-clean.`,
    );
    return 0;
  }

  // ----- Personal mode. -----
  const overlayPath = opts.overlayPath ?? loadoutOverlayPath();
  const materialize = opts.materializeHookFn ?? materializeHook;
  const regOpts: LoadoutOptions = {
    action: "add-hook",
    name: opts.name,
    event: opts.event,
    matcher: opts.matcher,
    timeout: opts.timeout,
    targets: opts.targets,
    projectRoot,
    overlayPath,
  };
  const mat = materialize(regOpts, overlayPath);
  if (!mat.ok) {
    // runAddHook already logged the specific reject; surface the code.
    return mat.code;
  }
  const verify = await projectAndVerify({
    surface: "hook",
    projectRoot,
    expectCore: false,
    target: opts.target,
    filter: opts.name,
    overlay: overlayPath,
    brainRoot: opts.brainRoot,
    captureAdapter: opts.captureAdapter,
  });
  if (!verify.ok) {
    logError(`add hook: projection/verify failed — ${verify.reason}`);
    return 1;
  }
  for (const line of verify.coreSkipped) {
    info(line);
  }
  info(
    `Added personal hook '${opts.name}' on ${opts.event}: registered + projected ` +
      `${verify.projected.length} target(s), drift-clean. The hook survives ` +
      `'igris update' / 'igris doctor --fix' (loadout-provenance — R2).`,
  );
  return 0;
}

/**
 * The `skill` arm — Phase 1 vertical slice. Personal: materialize via the
 * loadout writer, then projectAndVerify("skills"). Core: write the SKILL.md
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
    // Project + verify against the RUNTIME BRAIN ROOT (NOT the checkout) so the
    // ownership gate PASSES and the runtime-mirrored core skill is the one
    // projected; --expect-core keeps a genuine mis-route a LOUD failure (D5).
    // See coreProjectionParams for the full empirically-derived rationale.
    const proj = coreProjectionParams(projectRoot, opts.brainRoot);
    const verify = await projectAndVerify({
      surface: "skills",
      projectRoot: proj.projectRoot,
      manifest: proj.manifest,
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
  const overlayPath = opts.overlayPath ?? loadoutOverlayPath();
  const materialize = opts.materializeSkillFn ?? materializeSkill;
  const regOpts: LoadoutOptions = {
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
    // Project + verify against the RUNTIME BRAIN ROOT (NOT the checkout). The
    // repo manifest's agent canonical.dir is the project-relative `core/agents`,
    // which under `~/.igris` resolves to `~/.igris/core/agents/<name>.md` (the
    // runtime mirror the materialize step wrote); --expect-core keeps a genuine
    // mis-route a LOUD failure (D5). See coreProjectionParams for the rationale.
    const proj = coreProjectionParams(projectRoot, opts.brainRoot);
    const verify = await projectAndVerify({
      surface: "agents",
      projectRoot: proj.projectRoot,
      manifest: proj.manifest,
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
        `appended the harness-manifest.json entry, regenerated the agent roster ` +
        `(core/os/INDEX.md), mirrored to runtime, projected ${verify.projected.length} ` +
        `target(s), drift-clean.`,
    );
    return 0;
  }

  // ----- Personal mode. -----
  const overlayPath = opts.overlayPath ?? loadoutOverlayPath();
  const materialize = opts.materializeAgentFn ?? materializeAgent;
  const regOpts: LoadoutOptions = {
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
 * `--filter` by name (the MCP drift pass checks ALL mcp blocks across every
 * harness config `mcpTargetTypes()` returns). Phase 3 WIRES `--filter` into the MCP passes (byte-identical
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
    // Project + verify against the RUNTIME BRAIN ROOT (NOT the checkout) so the
    // ownership gate PASSES and the runtime-mirrored surfaces.mcp_servers block
    // is the one projected; --expect-core keeps a genuine mis-route a LOUD
    // failure (D5). See coreProjectionParams for the full rationale.
    const proj = coreProjectionParams(projectRoot, opts.brainRoot);
    const verify = await projectAndVerify({
      surface: "mcp",
      projectRoot: proj.projectRoot,
      manifest: proj.manifest,
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
  const overlayPath = opts.overlayPath ?? loadoutOverlayPath();
  const materialize = opts.materializeMcpFn ?? materializeMcp;
  const regOpts: LoadoutOptions = {
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
    info(`add ${surface}: operating in PERSONAL mode (loadout overlay).`);
  }

  switch (surface) {
    case "skill":
      return runAddSkillArm(opts, mode);
    case "agent":
      return runAddAgentArm(opts, mode);
    case "mcp":
      return runAddMcpArm(opts, mode);
    case "hook":
      return runAddHookArm(opts, mode);
    default:
      // Exhaustiveness — unreachable given the ADD_SURFACES guard above.
      logError(`add: unhandled surface '${String(surface)}'`);
      return 2;
  }
}
