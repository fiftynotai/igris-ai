/**
 * `igris remove <skill|agent|mcp|hook> <name>` — FR-203.
 *
 * The symmetric INVERSE of `igris add` (`verbs/add.ts`). One atomic,
 * self-verifying, mode-announced command that:
 *   1. UN-PROJECTS the surface from every harness (delete the registry-anchored
 *      symlink/hardlink; un-merge the named native-config block), then
 *   2. de-materializes it from the registry/overlay (personal) OR deletes the
 *      `core/` source + un-sweeps the §13 enumeration surfaces (core), then
 *   3. VERIFIES the surface is ABSENT (drift-clean = correctly removed).
 *
 * Layering mirrors `add` exactly (D9 — `remove` orchestrates, it does NOT
 * re-implement the write path):
 *   - personal de-materialize → `verbs/registry.ts` (`removeSkillBlock`,
 *     `removeMcpBlock`, `removeHookBlock`; the agent arm reuses the EXISTING
 *     `registry.ts:runRemove`).
 *   - core de-materialize       → `verbs/remove-core.ts`.
 *   - un-project + verify-ABSENT → `lib/remove-orchestrate.ts`
 *     (`unprojectAndVerify`) — the TD-235 chokepoint, INVERTED.
 *
 * `RemoveSurface = AddSurface` (imported from `add.ts`) so the four-surface set
 * is STRUCTURALLY identical — a future 5th `add` surface auto-fails the `remove`
 * typecheck until its remove arm lands. FR-202 M4 retired the `identity` surface,
 * so there are FOUR surfaces and NO `remove identity` arm.
 *
 * THE INVERTED NO-PHANTOM-SUCCESS GATE (TD-235, flipped): a removal that
 * de-projected ZERO targets AND found nothing in the registry/`core/` to delete
 * is a LOUD FAIL ("already absent? check the name") — the inverse of `add`'s
 * 0-projected loud-fail. A post-removal `harness check` that legitimately matches
 * NOTHING for that name is SUCCESS (the empty-match inversion documented in
 * `remove-orchestrate.ts`).
 *
 * THE ONE INTENTIONAL ASYMMETRY vs `add`: a destructive `--yes` confirm. Because
 * `remove` deletes config + files, it prints exactly what WILL be de-projected
 * and requires confirmation unless `--yes` is passed (scripted / round-trip use).
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import {
  registryOverlayPath,
  coreSurfacesManifestPath,
  claudeJsonPath,
  geminiSettingsPath,
  antigravityMcpConfigPath,
  antigravityHooksConfigPath,
  codexConfigTomlPath,
  opencodeConfigPath,
} from "../lib/paths.js";
import { info, error as logError } from "../lib/log.js";
import {
  personalHookCommandPath,
  hookCommandPresent,
} from "../lib/hook-merge.js";
import {
  runRegistry,
  removeSkillBlock,
  removeMcpBlock,
  removeHookBlock,
  NAME_PATTERN,
  type RegistryOptions,
} from "./registry.js";
import {
  unprojectAndVerify,
  type UnprojectTarget,
} from "../lib/remove-orchestrate.js";
import {
  resolveAddMode,
  coreProjectionParams,
  type AddSurface,
  type AddMode,
} from "./add.js";
import {
  removeCoreSkill,
  removeCoreAgent,
  removeCoreMcp,
  removeCoreHook,
} from "./remove-core.js";

/**
 * The four surfaces `igris remove` dispatches over. STRUCTURALLY identical to
 * {@link AddSurface} (imported, not re-declared) so symmetry is enforced by the
 * typechecker.
 */
export type RemoveSurface = AddSurface;

const REMOVE_SURFACES: readonly RemoveSurface[] = [
  "skill",
  "agent",
  "mcp",
  "hook",
] as const;

/** The builtin agents that are load-bearing in os/ INDEX-roster delegation. */
const BUILTIN_AGENTS = new Set([
  "architect",
  "forger",
  "sentinel",
  "warden",
  "mender",
  "seeker",
  "sage",
  "aegis",
  "scribe",
]);

/** Options for `igris remove`. */
export interface RemoveOptions {
  /** Which surface to remove (skill/agent/mcp/hook). */
  surface: string;
  /** The surface name — positional or --name. */
  name?: string;
  /** Force CORE mode (edit the igris-ai checkout). Wins over auto-detect. */
  core?: boolean;
  /** Force PERSONAL mode. Wins over auto-detect. */
  noCore?: boolean;
  /** Hook event (hook arm; `--event`) — needed to re-derive the command path. */
  event?: string;
  /** Root the auto-detect + un-project + verify resolve against. Defaults to cwd. */
  projectRoot?: string;
  /** Restrict un-projection to one harness (claude|codex|gemini|opencode|antigravity). */
  target?: string;
  /** Skip the destructive confirmation prompt (scripted / round-trip use). */
  yes?: boolean;
  /** Force-remove a builtin agent / override a guard (agent arm). */
  force?: boolean;
  /** Test seam: overlay-path override (personal). */
  overlayPath?: string;
  /** Test seam: brain root override (defaults to brainDir()). */
  brainRoot?: string;
  /** Test seam: capturing adapter runner forwarded to the ABSENT-verify. */
  captureAdapter?: import("./harness.js").AdapterCaptureFn;
  /** Test seam: core-repo detector override (mode resolution). */
  detectCore?: (projectRoot: string) => boolean;
  /** Test seam: confirm-prompt override (returns true to proceed). */
  confirm?: (message: string) => Promise<boolean>;
  /** Test seam: personal skill de-materialize override. */
  removeSkillBlockFn?: typeof removeSkillBlock;
  /** Test seam: personal mcp de-materialize override. */
  removeMcpBlockFn?: typeof removeMcpBlock;
  /** Test seam: personal hook de-materialize override. */
  removeHookBlockFn?: typeof removeHookBlock;
  /** Test seam: core skill remove override. */
  removeCoreSkillFn?: typeof removeCoreSkill;
  /** Test seam: core agent remove override. */
  removeCoreAgentFn?: typeof removeCoreAgent;
  /** Test seam: core mcp remove override. */
  removeCoreMcpFn?: typeof removeCoreMcp;
  /** Test seam: core hook remove override. */
  removeCoreHookFn?: typeof removeCoreHook;
}

/**
 * FR-154 3-case target.path resolver (TS port of the bash resolver):
 *   `~/...`  → $HOME/...; `/...` → absolute as-is; else → <projectRoot>/...
 * Mirrors `compile_harnesses.sh`'s skill `s_path` + agent `target_path`
 * resolution so un-projection deletes EXACTLY the path the compiler created.
 */
function resolveTargetPath(path: string, projectRoot: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (isAbsolute(path)) {
    return path;
  }
  return join(projectRoot, path);
}

/**
 * Inverse of `resolve_skill_link_path`: the symlink lives at `<out>/<name>`
 * UNLESS `<out>` already terminates in `<name>` (a legacy/hand-edited manifest
 * carrying the per-skill path), in which case `<out>` IS the link. See TD-218.
 */
function resolveSkillLinkPath(outAbs: string, name: string): string {
  return basename(outAbs) === name ? outAbs : join(outAbs, name);
}

/** Default confirm prompt — asks on stdin, returns true on y/yes. */
async function defaultConfirm(message: string): Promise<boolean> {
  process.stdout.write(`${message}\nProceed? [y/N] `);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

/** Read a `surfaces.<key>` block array from a JSON manifest (absent → []). */
function readSurfaceBlocks<T>(path: string, key: string): T[] {
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      surfaces?: Record<string, unknown>;
    };
    const blocks = parsed.surfaces?.[key];
    return Array.isArray(blocks) ? (blocks as T[]) : [];
  } catch {
    return [];
  }
}

/** Read the `agents[]` array from a JSON manifest/overlay (absent → []). */
function readAgentEntries(path: string): Array<{
  name?: string;
  targets?: Array<{ type?: string; path?: string }>;
}> {
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      agents?: Array<{ name?: string; targets?: Array<{ type?: string; path?: string }> }>;
    };
    return Array.isArray(parsed.agents) ? parsed.agents : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-surface un-project target resolution.
// ---------------------------------------------------------------------------

/**
 * Resolve the skill un-project targets — the per-harness symlinks the skill
 * projected. Reads the block's `targets[].path` from the overlay (personal) or
 * the core surfaces manifest (core), resolves each via the FR-154 3-case +
 * resolve_skill_link_path, and emits an `UnprojectTarget` that deletes the
 * symlink (idempotent — an absent symlink returns false).
 */
function skillUnprojectTargets(
  name: string,
  projectRoot: string,
  overlayPath: string,
  mode: AddMode,
): UnprojectTarget[] {
  const source = mode === "core" ? coreSurfacesManifestPath() : overlayPath;
  const key = "skills";
  const blocks = readSurfaceBlocks<{
    source?: string;
    targets?: Array<{ type?: string; path?: string }>;
  }>(source, key);
  const block = blocks.find(
    (b) => typeof b.source === "string" && basename(b.source) === name,
  );
  const targets: UnprojectTarget[] = [];
  for (const t of block?.targets ?? []) {
    if (typeof t.path !== "string" || typeof t.type !== "string") continue;
    // Only symlink targets land a deletable file; command targets (opencode)
    // write a wrapper — handled by the compile/check drift, not a symlink here.
    const outAbs = resolveTargetPath(t.path, projectRoot);
    const linkPath = resolveSkillLinkPath(outAbs, name);
    targets.push({
      harness: t.type,
      label: `${t.type}:${linkPath}`,
      run: () => deleteLink(linkPath),
    });
  }
  return targets;
}

/**
 * Resolve the agent un-project targets — the per-harness compiled agent files
 * (codex .toml symlink, gemini hardlink, opencode .md). Reads the agent entry's
 * `targets[].path` from the base manifest (core) or the overlay (personal),
 * resolves each via the FR-154 3-case, and emits a delete-file UnprojectTarget.
 */
function agentUnprojectTargets(
  name: string,
  projectRoot: string,
  overlayPath: string,
  mode: AddMode,
): UnprojectTarget[] {
  // Personal agents live in the overlay; core agents in the repo manifest.
  const source =
    mode === "core"
      ? join(projectRoot, "harness-manifest.json")
      : overlayPath;
  const entry = readAgentEntries(source).find((a) => a.name === name);
  const targets: UnprojectTarget[] = [];
  for (const t of entry?.targets ?? []) {
    if (typeof t.path !== "string" || typeof t.type !== "string") continue;
    const fileAbs = resolveTargetPath(t.path, projectRoot);
    targets.push({
      harness: t.type,
      label: `${t.type}:${fileAbs}`,
      run: () => deleteLink(fileAbs),
    });
  }
  return targets;
}

/**
 * Delete a projected symlink/hardlink/file. Returns true iff it existed.
 *
 * Uses `lstatSync` (NOT `existsSync`, which follows symlinks and misses a
 * DANGLING link) to probe the link itself, then `unlinkSync` (NOT `rmSync`) to
 * remove it. CRITICAL: `rmSync(path, {force:true})` SILENTLY FAILS to remove a
 * dangling symlink — its target stat throws ENOENT and `force` swallows it,
 * leaving the orphan link in place. Since `removeSkillBlock`/`removeCore*` delete
 * the vendored tree first, the symlink IS dangling by the time we get here, so
 * `unlinkSync` (which operates on the link, never its target) is required.
 */
function deleteLink(path: string): boolean {
  try {
    lstatSync(path); // throws ENOENT only when the link itself is absent
  } catch {
    return false;
  }
  unlinkSync(path);
  return true;
}

// ---------------------------------------------------------------------------
// Confirmation.
// ---------------------------------------------------------------------------

/**
 * Run the destructive confirm (unless `--yes`). Prints exactly what WILL be
 * de-projected (the resolved targets) and the store source, then asks. Returns
 * true to proceed, false to abort.
 */
async function confirmDestruction(
  opts: RemoveOptions,
  surface: RemoveSurface,
  name: string,
  targetLabels: string[],
): Promise<boolean> {
  if (opts.yes === true) {
    return true;
  }
  const lines = [
    `remove ${surface} '${name}' will de-project the following target(s):`,
    ...targetLabels.map((l) => `  - ${l}`),
    "and remove the surface from the registry/core store. This is destructive.",
  ];
  const confirm = opts.confirm ?? defaultConfirm;
  return confirm(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// The four arms.
// ---------------------------------------------------------------------------

/** The skill arm — inverse of `runAddSkillArm`. */
async function runRemoveSkillArm(
  opts: RemoveOptions,
  mode: AddMode,
): Promise<number> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const overlayPath = opts.overlayPath ?? registryOverlayPath();
  const name = opts.name!;

  const unprojectTargets = skillUnprojectTargets(name, projectRoot, overlayPath, mode);

  if (!(await confirmDestruction(opts, "skill", name, unprojectTargets.map((t) => t.label)))) {
    info(`remove skill '${name}': aborted (not confirmed).`);
    return 0;
  }

  // De-materialize FIRST (store side), so the ABSENT-verify sees the surface
  // gone from the manifest. Then un-project the orphan symlinks + verify.
  let storeRemoved = false;
  if (mode === "core") {
    const removeCore = opts.removeCoreSkillFn ?? removeCoreSkill;
    const r = removeCore({ name, projectRoot, brainRoot: opts.brainRoot });
    if (!r.ok) {
      logError(`remove skill (core): ${r.reason}`);
      return r.code;
    }
    storeRemoved = r.removed;
    for (const line of r.verifyOutput.length > 0 ? [r.verifyOutput] : []) {
      info(line);
    }
  } else {
    const remove = opts.removeSkillBlockFn ?? removeSkillBlock;
    const r = remove(regOptsFor("remove-skill", name, opts), overlayPath);
    if (!r.ok) {
      return r.code;
    }
    storeRemoved = r.removed;
  }

  return finishRemove({
    opts,
    mode,
    surface: "skills",
    name,
    projectRoot,
    overlayPath,
    unprojectTargets,
    storeRemoved,
    arm: "skill",
  });
}

/** The agent arm — inverse of `runAddAgentArm` (the §13-heavy one). */
async function runRemoveAgentArm(
  opts: RemoveOptions,
  mode: AddMode,
): Promise<number> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const overlayPath = opts.overlayPath ?? registryOverlayPath();
  const name = opts.name!;

  // Builtin-agent guard (load-bearing core agents in the os/ INDEX roster).
  if (BUILTIN_AGENTS.has(name) && opts.force !== true) {
    logError(
      `remove agent '${name}': '${name}' is a BUILTIN agent (a load-bearing ` +
        `core role in the os/ INDEX delegation roster). Removing it silently ` +
        `breaks delegation. Re-run with --force if you are certain.`,
    );
    return 1;
  }

  const unprojectTargets = agentUnprojectTargets(name, projectRoot, overlayPath, mode);

  if (!(await confirmDestruction(opts, "agent", name, unprojectTargets.map((t) => t.label)))) {
    info(`remove agent '${name}': aborted (not confirmed).`);
    return 0;
  }

  let storeRemoved = false;
  if (mode === "core") {
    const removeCore = opts.removeCoreAgentFn ?? removeCoreAgent;
    const r = removeCore({ name, projectRoot, brainRoot: opts.brainRoot });
    if (!r.ok) {
      logError(`remove agent (core): ${r.reason}`);
      return r.code;
    }
    storeRemoved = r.removed;
    if (r.verifyOutput.length > 0) info(r.verifyOutput);
  } else {
    // Personal agent — reuse the EXISTING registry `remove` (overlay + origin +
    // vendor dir). It returns 1 when the agent is absent; treat absence as
    // storeRemoved=false (the loud-fail gate decides, after un-projection).
    const code = await runRegistry(regOptsFor("remove", name, opts));
    storeRemoved = code === 0;
  }

  return finishRemove({
    opts,
    mode,
    surface: "agents",
    name,
    projectRoot,
    overlayPath,
    unprojectTargets,
    storeRemoved,
    arm: "agent",
  });
}

/** The mcp arm — inverse of `runAddMcpArm`. */
async function runRemoveMcpArm(
  opts: RemoveOptions,
  mode: AddMode,
): Promise<number> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const overlayPath = opts.overlayPath ?? registryOverlayPath();
  const name = opts.name!;

  const harnesses =
    opts.target !== undefined && opts.target.length > 0
      ? [opts.target]
      : ["claude", "codex", "gemini", "opencode", "antigravity"];
  const targetLabels = harnesses.map((h) => `${h}:${name}`);

  // INVERTED no-phantom-success snapshot: capture whether the block existed
  // anywhere (store OR any native config) BEFORE we touch anything, so a
  // remove-that-removed-nothing is caught regardless of where it should have
  // been. (deprojected count alone can't drive the gate — un-merge "visits"
  // every harness even when the block was already absent.)
  const storeWasPresent = mcpStoreWasPresent(name, overlayPath, mode);
  const configWasPresent = harnesses.some((h) =>
    mcpConfigPresentIn(name, h, projectRoot),
  );

  if (!(await confirmDestruction(opts, "mcp", name, targetLabels))) {
    info(`remove mcp '${name}': aborted (not confirmed).`);
    return 0;
  }

  if (!storeWasPresent && !configWasPresent) {
    return loudNothingToRemove("mcp", name);
  }

  // Un-project (un-merge native config) per harness, then de-materialize.
  const deprojected: string[] = [];
  for (const h of harnesses) {
    const regOpts: RegistryOptions = {
      action: "unproject-mcp",
      name,
      harness: h as RegistryOptions["harness"],
      projectRoot,
      overlayPath,
    };
    const code = await runRegistry(regOpts);
    if (code !== 0) {
      logError(`remove mcp '${name}': un-projection from ${h} failed (exit ${code}).`);
      return 1;
    }
    deprojected.push(`${h}:${name}`);
  }

  let storeRemoved = false;
  if (mode === "core") {
    const removeCore = opts.removeCoreMcpFn ?? removeCoreMcp;
    const r = removeCore({ name, projectRoot, brainRoot: opts.brainRoot });
    if (!r.ok) {
      logError(`remove mcp (core): ${r.reason}`);
      return r.code;
    }
    storeRemoved = r.removed;
    if (r.verifyOutput.length > 0) info(r.verifyOutput);
  } else {
    const remove = opts.removeMcpBlockFn ?? removeMcpBlock;
    const r = remove(regOptsFor("remove-mcp", name, opts), overlayPath);
    if (!r.ok) return r.code;
    storeRemoved = r.removed;
  }

  // ABSENT-verify (drift-clean = removed). MCP un-projection already done above;
  // pass empty targets (the verify confirms the store no longer declares it).
  return verifyAbsentOnly({
    opts,
    mode,
    surface: "mcp",
    name,
    projectRoot,
    overlayPath,
    deprojected,
    storeRemoved,
  });
}

/** The hook arm — inverse of `runAddHookArm` (#828: hooks-surface ONLY). */
async function runRemoveHookArm(
  opts: RemoveOptions,
  mode: AddMode,
): Promise<number> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const overlayPath = opts.overlayPath ?? registryOverlayPath();
  const name = opts.name!;

  // The hook un-merge re-derives the command path from (name, event), so --event
  // is required for the personal un-project (it keys the group).
  if ((opts.event === undefined || opts.event.length === 0)) {
    // Try to recover the event from the stored block so --event is optional when
    // the block still exists.
    const recovered = recoverHookEvent(name, overlayPath, mode);
    if (recovered === undefined) {
      logError(
        `remove hook '${name}': --event <Event> is required to locate the hook ` +
          `group to un-merge (could not recover it from the store).`,
      );
      return 2;
    }
    opts = { ...opts, event: recovered };
  }

  const harnesses =
    opts.target !== undefined && opts.target.length > 0
      ? [opts.target]
      : ["claude", "opencode", "antigravity"];
  const targetLabels = harnesses.map((h) => `${h}:${name}`);

  // INVERTED no-phantom-success snapshot (see the mcp arm).
  const storeWasPresent = hookStoreWasPresent(name, overlayPath, mode);
  const configWasPresent = harnesses.some((h) =>
    hookConfigPresentIn(name, opts.event!, h, projectRoot),
  );

  if (!(await confirmDestruction(opts, "hook", name, targetLabels))) {
    info(`remove hook '${name}': aborted (not confirmed).`);
    return 0;
  }

  if (!storeWasPresent && !configWasPresent) {
    return loudNothingToRemove("hook", name);
  }

  const deprojected: string[] = [];
  for (const h of harnesses) {
    const regOpts: RegistryOptions = {
      action: "unproject-hook",
      name,
      harness: h as RegistryOptions["harness"],
      event: opts.event,
      projectRoot,
      overlayPath,
    };
    const code = await runRegistry(regOpts);
    if (code !== 0) {
      logError(`remove hook '${name}': un-projection from ${h} failed (exit ${code}).`);
      return 1;
    }
    deprojected.push(`${h}:${name}`);
  }

  let storeRemoved = false;
  if (mode === "core") {
    const removeCore = opts.removeCoreHookFn ?? removeCoreHook;
    const r = removeCore({ name, projectRoot, event: opts.event, brainRoot: opts.brainRoot });
    if (!r.ok) {
      logError(`remove hook (core): ${r.reason}`);
      return r.code;
    }
    storeRemoved = r.removed;
    if (r.verifyOutput.length > 0) info(r.verifyOutput);
  } else {
    const remove = opts.removeHookBlockFn ?? removeHookBlock;
    const r = remove(regOptsFor("remove-hook", name, opts), overlayPath);
    if (!r.ok) return r.code;
    storeRemoved = r.removed;
  }

  return verifyAbsentOnly({
    opts,
    mode,
    surface: "hook",
    name,
    projectRoot,
    overlayPath,
    deprojected,
    storeRemoved,
  });
}

// ---------------------------------------------------------------------------
// Shared finish paths.
// ---------------------------------------------------------------------------

/** Build a RegistryOptions for a personal de-materialize / agent remove. */
function regOptsFor(
  action: RegistryOptions["action"],
  name: string,
  opts: RemoveOptions,
): RegistryOptions {
  return {
    action,
    name,
    event: opts.event,
    projectRoot: opts.projectRoot ?? process.cwd(),
    overlayPath: opts.overlayPath ?? registryOverlayPath(),
  };
}

/** Did the MCP STORE block exist (overlay personal / core surfaces) pre-removal? */
function mcpStoreWasPresent(
  name: string,
  overlayPath: string,
  mode: AddMode,
): boolean {
  const source = mode === "core" ? coreSurfacesManifestPath() : overlayPath;
  return readSurfaceBlocks<{ name?: string }>(source, "mcp_servers").some(
    (b) => b.name === name,
  );
}

/** Did the HOOK STORE block exist (overlay personal / core surfaces) pre-removal? */
function hookStoreWasPresent(
  name: string,
  overlayPath: string,
  mode: AddMode,
): boolean {
  const source = mode === "core" ? coreSurfacesManifestPath() : overlayPath;
  return readSurfaceBlocks<{ name?: string }>(source, "hooks").some(
    (b) => b.name === name,
  );
}

/** Map an MCP harness → its native config file path + map key. */
function mcpConfigFor(harness: string): { path: string; mapKey: string } | undefined {
  switch (harness) {
    case "claude":
      return { path: claudeJsonPath(), mapKey: "mcpServers" };
    case "gemini":
      return { path: geminiSettingsPath(), mapKey: "mcpServers" };
    case "antigravity":
      return { path: antigravityMcpConfigPath(), mapKey: "mcpServers" };
    case "opencode":
      return { path: opencodeConfigPath(), mapKey: "mcp" };
    case "codex":
      return { path: codexConfigTomlPath(), mapKey: "mcp_servers" };
    default:
      return undefined;
  }
}

/** Is the named MCP block present in `harness`'s native config (pre-removal probe)? */
function mcpConfigPresentIn(name: string, harness: string, _projectRoot: string): boolean {
  const cfg = mcpConfigFor(harness);
  if (cfg === undefined || !existsSync(cfg.path)) {
    return false;
  }
  try {
    if (harness === "codex") {
      // A `[mcp_servers.<name>]` header anywhere in the TOML.
      const text = readFileSync(cfg.path, "utf-8");
      return new RegExp(`\\[\\s*${cfg.mapKey}\\.${name}\\b`).test(text);
    }
    const parsed = JSON.parse(readFileSync(cfg.path, "utf-8")) as Record<string, unknown>;
    const map = parsed[cfg.mapKey];
    return typeof map === "object" && map !== null && name in (map as Record<string, unknown>);
  } catch {
    return false;
  }
}

/** Is the named hook GROUP present in `harness`'s native hook config (pre-removal probe)? */
function hookConfigPresentIn(
  name: string,
  event: string,
  harness: string,
  projectRoot: string,
): boolean {
  if (harness === "opencode") {
    // opencode hooks ride the shared plugin — no per-name config to probe.
    return false;
  }
  const settingsPath =
    harness === "antigravity"
      ? antigravityHooksConfigPath()
      : join(projectRoot, ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const command = personalHookCommandPath(name, event);
    return hookCommandPresent(parsed, event, command);
  } catch {
    return false;
  }
}

/** Recover a hook's event from the store block (so --event is optional). */
function recoverHookEvent(
  name: string,
  overlayPath: string,
  mode: AddMode,
): string | undefined {
  const source = mode === "core" ? coreSurfacesManifestPath() : overlayPath;
  const blocks = readSurfaceBlocks<{ name?: string; event?: string }>(source, "hooks");
  const b = blocks.find((x) => x.name === name);
  return typeof b?.event === "string" ? b.event : undefined;
}

/**
 * The shared finish for the SKILL + AGENT arms: run the symlink/file
 * un-projection via the orchestrator (which deletes the orphans + ABSENT-verify)
 * and apply the inverted no-phantom-success gate.
 */
async function finishRemove(args: {
  opts: RemoveOptions;
  mode: AddMode;
  surface: "skills" | "agents";
  name: string;
  projectRoot: string;
  overlayPath: string;
  unprojectTargets: UnprojectTarget[];
  storeRemoved: boolean;
  arm: string;
}): Promise<number> {
  const { opts, mode, surface, name, projectRoot, overlayPath, unprojectTargets, storeRemoved, arm } = args;

  const proj =
    mode === "core"
      ? coreProjectionParams(projectRoot, opts.brainRoot)
      : { projectRoot, manifest: undefined as string | undefined };

  const verify = await unprojectAndVerify({
    surface,
    name,
    targets: unprojectTargets,
    projectRoot: proj.projectRoot,
    expectCore: mode === "core",
    target: opts.target,
    overlay: mode === "core" ? undefined : overlayPath,
    manifest: proj.manifest,
    brainRoot: opts.brainRoot,
    captureAdapter: opts.captureAdapter,
  });

  // INVERTED no-phantom-success gate: nothing un-projected AND nothing removed
  // from the store → already absent → LOUD FAIL.
  if (verify.deprojected.length === 0 && !storeRemoved) {
    return loudNothingToRemove(arm, name);
  }

  if (!verify.ok) {
    logError(`remove ${arm}: ${verify.reason}`);
    return 1;
  }

  info(
    `Removed ${mode} ${arm} '${name}': de-projected ${verify.deprojected.length} ` +
      `target(s), removed from the store, drift-clean (ABSENT).`,
  );
  return 0;
}

/**
 * The ABSENT-verify-only finish for the MCP + HOOK arms (un-projection already
 * ran inline). Runs `harness check` to confirm the surface is GONE.
 */
async function verifyAbsentOnly(args: {
  opts: RemoveOptions;
  mode: AddMode;
  surface: "mcp" | "hook";
  name: string;
  projectRoot: string;
  overlayPath: string;
  deprojected: string[];
  storeRemoved: boolean;
}): Promise<number> {
  const { opts, mode, surface, name, projectRoot, overlayPath, deprojected, storeRemoved } = args;

  const proj =
    mode === "core"
      ? coreProjectionParams(projectRoot, opts.brainRoot)
      : { projectRoot, manifest: undefined as string | undefined };

  const verify = await unprojectAndVerify({
    surface,
    name,
    targets: [], // un-projection already done inline
    projectRoot: proj.projectRoot,
    expectCore: mode === "core",
    target: opts.target,
    overlay: mode === "core" ? undefined : overlayPath,
    manifest: proj.manifest,
    brainRoot: opts.brainRoot,
    captureAdapter: opts.captureAdapter,
  });

  if (!verify.ok) {
    logError(`remove ${surface}: ${verify.reason}`);
    return 1;
  }

  info(
    `Removed ${mode} ${surface} '${name}': un-merged ${deprojected.length} ` +
      `harness config block(s)${storeRemoved ? ", removed from the store" : ""}, ` +
      `drift-clean (ABSENT).`,
  );
  return 0;
}

/** The inverted TD-235 loud-fail: nothing was de-projected / already absent. */
function loudNothingToRemove(arm: string, name: string): number {
  logError(
    `remove ${arm} '${name}': nothing was de-projected and no registry/core entry ` +
      `exists — already absent? Check the name (it must match an added ${arm}).`,
  );
  return 1;
}

/**
 * Dispatch `igris remove <surface> <name>`. Returns the exit code. A bad surface
 * is a usage error (exit 2). Mode resolution (D1) runs once up front and is
 * PRINTED so it is never silent — symmetric with `add`.
 */
export async function runRemove(opts: RemoveOptions): Promise<number> {
  const surface = opts.surface as RemoveSurface;
  if (!REMOVE_SURFACES.includes(surface)) {
    logError(
      `remove: unknown surface '${opts.surface}'. ` +
        `Valid: ${REMOVE_SURFACES.join(", ")}.`,
    );
    return 2;
  }
  if (opts.name === undefined || opts.name.length === 0) {
    logError(`remove ${surface}: <name> is required.`);
    return 2;
  }
  // FR-203 C1 (PRIMARY guard — §14 SECURITY): validate <name> against the
  // canonical NAME_PATTERN BEFORE mode-resolve / dispatch / any fs-path
  // derivation. `remove` is DESTRUCTIVE (recursive `rmSync` on a name-derived
  // path in the skill/hook personal de-materialize) and `--yes` skips the
  // confirm preview, so a traversal name (`../../../x`) must be rejected at the
  // boundary. Reuses the SAME pattern + message shape every `add` writer uses
  // (symmetry: `registry.ts` add-skill/add-mcp/add-hook), exit 2 (usage error).
  if (!NAME_PATTERN.test(opts.name)) {
    logError(
      `remove ${surface}: name '${opts.name}' must match /^[a-z0-9][a-z0-9-]*$/`,
    );
    return 2;
  }

  const resolved = resolveAddMode(opts);
  if (!resolved.ok) {
    // Re-word the add-flavored message for remove.
    logError(resolved.error.replace(/^add:/, "remove:"));
    return 2;
  }
  const mode = resolved.mode;

  // D1: never silent — announce the resolved mode (symmetric with `add`).
  if (mode === "core") {
    info(
      `remove ${surface}: operating in CORE mode — editing the igris-ai checkout ` +
        `at ${opts.projectRoot ?? process.cwd()}.`,
    );
  } else {
    info(`remove ${surface}: operating in PERSONAL mode (registry overlay).`);
  }

  switch (surface) {
    case "skill":
      return runRemoveSkillArm(opts, mode);
    case "agent":
      return runRemoveAgentArm(opts, mode);
    case "mcp":
      return runRemoveMcpArm(opts, mode);
    case "hook":
      return runRemoveHookArm(opts, mode);
    default:
      logError(`remove: unhandled surface '${String(surface)}'`);
      return 2;
  }
}
