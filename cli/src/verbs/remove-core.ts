/**
 * `igris remove --core <surface>` writers — FR-203.
 *
 * The core-path DE-materialization: the exact inverse of `verbs/add-core.ts`.
 * Deletes the surface from the igris-ai SOURCE checkout (`core/…`), un-sweeps the
 * §13 enumeration surfaces (agent), and re-mirrors / deletes the runtime brain
 * mirror (`~/.igris/core/…`) per the TD-096 mirror rule:
 *   - a SOURCE FILE deletion (skill SKILL.md, agent prompt, shared hook script)
 *     is a DELETE-BOTH (rm source + rm mirror; nothing to verify_mirror — both
 *     are gone);
 *   - a CONTENT EDIT (igris_tree.json, CLAUDE.md.tmpl, surfaces-manifest.json) is
 *     a cp + `verify_mirror.sh` MATCH (reusing the `mirrorAndVerify` pattern from
 *     add-core).
 *
 * CUTOVER-TODAY FLAG (operator, FR-203 plan §TD-096): the runtime
 * `~/.igris/core/scripts/cli-adapters/` may be ABSENT pre-cutover. A LIVE
 * `remove --core` then fails to find the adapter exactly as a LIVE `add --core`
 * would — the SAME runtime-mirror prerequisite `add` already carries (NOT new
 * risk). Core-path tests use the capture seam; personal-mode removes do not
 * depend on the cli-adapters mirror.
 *
 * #828: `removeCoreHook` touches ONLY the hooks SURFACE (the shared script when
 * unreferenced + the surfaces.hooks block). It NEVER touches a `core/enforcement/`
 * definition — the enforcement registry is a separate axis.
 */

import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { brainDir } from "../lib/paths.js";
import { info } from "../lib/log.js";

/** Result of a core-surface de-materialize. The inverse of `AddCoreResult`. */
export interface RemoveCoreResult {
  /** True iff the source deletion(s) + §13 un-sweep + mirror handling succeeded. */
  ok: boolean;
  /** Exit code on failure (1 = write/mirror error, 2 = usage). */
  code: number;
  /** Human-readable failure reason (empty on success). */
  reason: string;
  /** True iff something actually existed and was removed (the no-phantom gate). */
  removed: boolean;
  /** Verbatim `verify_mirror.sh` output for any re-mirrored file (so the caller can quote it). */
  verifyOutput: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Common-shape options for the four core removers. */
export interface RemoveCoreOptions {
  /** Surface name (lower-kebab). */
  name?: string;
  /** Repo root (the igris-ai checkout). */
  projectRoot: string;
  /** Hook event (hook arm) — needed to locate the shared script + the block. */
  event?: string;
  /** Test seam: brain root override (defaults to brainDir()). */
  brainRoot?: string;
  /** Test seam: skip the runtime mirror handling (unit tests). Default false. */
  skipMirror?: boolean;
}

/** Result of one TD-096 re-mirror + verify (content-edit path). */
interface MirrorVerify {
  ok: boolean;
  output: string;
  reason: string;
}

/**
 * TD-096 content-edit re-mirror: `cp <source> <mirror>` then `verify_mirror.sh`
 * MATCH. Used when a core file is EDITED (not deleted) by the un-sweep — the
 * tree, the CLAUDE template, the surfaces manifest. Byte-for-byte the inverse
 * partner of add-core's `mirrorAndVerify`.
 */
function mirrorAndVerify(
  sourcePath: string,
  mirrorPath: string,
  brainRoot: string,
): MirrorVerify {
  try {
    execFileSync("cp", [sourcePath, mirrorPath], { stdio: "ignore" });
  } catch (err) {
    return {
      ok: false,
      output: "",
      reason: `failed to mirror to runtime (${mirrorPath}): ${(err as Error).message}`,
    };
  }
  const verifyScript = join(brainRoot, "core", "scripts", "verify_mirror.sh");
  try {
    const output = execFileSync("bash", [verifyScript, sourcePath, mirrorPath], {
      encoding: "utf-8",
    });
    return { ok: true, output, reason: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return {
      ok: false,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      reason: `verify_mirror.sh reported a non-MATCH for ${mirrorPath}; see output`,
    };
  }
}

/**
 * FR-203: remove a CORE skill — the inverse of `addCoreSkill`. Skills
 * auto-discover, so the only write is deleting `core/skills/<name>/` (+ the
 * runtime mirror). No manifest edit. DELETE-BOTH (source + mirror gone → nothing
 * to verify_mirror).
 */
export function removeCoreSkill(opts: RemoveCoreOptions): RemoveCoreResult {
  const fail = (code: number, reason: string): RemoveCoreResult => ({
    ok: false,
    code,
    reason,
    removed: false,
    verifyOutput: "",
  });
  if (opts.name === undefined || opts.name.length === 0) {
    return fail(2, "skill <name> is required");
  }
  if (!NAME_PATTERN.test(opts.name)) {
    return fail(2, `name '${opts.name}' must match /^[a-z0-9][a-z0-9-]*$/`);
  }
  const root = opts.brainRoot ?? brainDir();
  const sourceDir = join(opts.projectRoot, "core", "skills", opts.name);
  const mirrorDir = join(root, "core", "skills", opts.name);

  const existed = existsSync(sourceDir);
  rmSync(sourceDir, { recursive: true, force: true });
  if (opts.skipMirror !== true) {
    rmSync(mirrorDir, { recursive: true, force: true });
  }
  if (existed) {
    info(`Removed core skill source ${sourceDir} (+ runtime mirror).`);
  }
  return { ok: true, code: 0, reason: "", removed: existed, verifyOutput: "" };
}

/**
 * Inverse of `appendAgentToCsvLine`: REMOVE `name` from a comma+space-separated
 * "Available Agents" line, keeping the remaining names on the SAME single line.
 * Idempotent (no-op if already absent). Returns the new line.
 */
export function removeAgentFromCsvLine(line: string, name: string): string {
  const names = line
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== name);
  return names.join(", ");
}

/**
 * FR-203: remove a CORE agent — the precise inverse of `addCoreAgent`:
 *   1. delete `core/agents/<name>.md` + its runtime mirror (DELETE-BOTH);
 *   2. SPLICE the `agents[]` entry out of repo-root `harness-manifest.json`
 *      (repo-only, no mirror — matches add);
 *   3. un-sweep the §13 enumeration surfaces (inverse of
 *      `updateAgentEnumerationSurfaces`): drop the `agents.<name>` key from
 *      `core/igris_tree.json` (+ re-mirror), and remove `<name>` from the
 *      "Available Agents" CSV in `core/templates/CLAUDE.md.tmpl` (+ re-mirror)
 *      AND root `CLAUDE.md` (no mirror).
 *
 * The builtin-agent guard lives in `verbs/remove.ts` (it needs `--force`); this
 * writer trusts the dispatcher gated it.
 */
export function removeCoreAgent(opts: RemoveCoreOptions): RemoveCoreResult {
  const fail = (code: number, reason: string, verifyOutput = ""): RemoveCoreResult => ({
    ok: false,
    code,
    reason,
    removed: false,
    verifyOutput,
  });
  if (opts.name === undefined || opts.name.length === 0) {
    return fail(2, "agent <name> is required");
  }
  if (!NAME_PATTERN.test(opts.name)) {
    return fail(2, `name '${opts.name}' must match /^[a-z0-9][a-z0-9-]*$/`);
  }
  const name = opts.name;
  const root = opts.brainRoot ?? brainDir();
  const sourcePath = join(opts.projectRoot, "core", "agents", `${name}.md`);
  const mirrorPath = join(root, "core", "agents", `${name}.md`);
  const manifestPath = join(opts.projectRoot, "harness-manifest.json");

  if (!existsSync(manifestPath)) {
    return fail(
      1,
      `repo-root harness-manifest.json not found at ${manifestPath}; not an igris-ai checkout`,
    );
  }

  let removed = false;

  // --- 1. Delete the canonical prompt + mirror (DELETE-BOTH). ----------------
  if (existsSync(sourcePath)) {
    removed = true;
  }
  rmSync(sourcePath, { force: true });
  if (opts.skipMirror !== true) {
    rmSync(mirrorPath, { force: true });
  }

  // --- 2. Splice the manifest entry (repo-only, no mirror). ------------------
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      agents?: Array<{ name?: string }>;
    } & Record<string, unknown>;
    const agents = Array.isArray(manifest.agents) ? manifest.agents : [];
    const before = agents.length;
    manifest.agents = agents.filter((a) => a.name !== name);
    if (manifest.agents.length !== before) {
      removed = true;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    }
  } catch (err) {
    return fail(1, `failed to update ${manifestPath}: ${(err as Error).message}`);
  }

  // --- 3. §13 un-sweep. ------------------------------------------------------
  const enumErr = unsweepAgentEnumerationSurfaces(opts.projectRoot, name);
  if (enumErr !== null) {
    return fail(1, enumErr);
  }

  if (opts.skipMirror === true) {
    return { ok: true, code: 0, reason: "", removed, verifyOutput: "(mirror skipped)" };
  }

  // --- TD-096 re-mirror the two EDITED mirrored files (tree + tmpl). The
  // canonical prompt mirror was already deleted in step 1; harness-manifest.json
  // + root CLAUDE.md have no runtime mirror.
  const verifyParts: string[] = [];
  const mirrors: Array<{ src: string; dst: string; label: string }> = [
    {
      src: join(opts.projectRoot, "core", "igris_tree.json"),
      dst: join(root, "core", "igris_tree.json"),
      label: "core/igris_tree.json",
    },
    {
      src: join(opts.projectRoot, "core", "templates", "CLAUDE.md.tmpl"),
      dst: join(root, "core", "templates", "CLAUDE.md.tmpl"),
      label: "core/templates/CLAUDE.md.tmpl",
    },
  ];
  for (const m of mirrors) {
    if (!existsSync(m.src)) continue;
    const mv = mirrorAndVerify(m.src, m.dst, root);
    verifyParts.push(`# ${m.label}\n${mv.output}`);
    if (!mv.ok) {
      return fail(1, mv.reason, verifyParts.join("\n"));
    }
    info(`Mirror verified (${m.src} <-> ${m.dst}): MATCH`);
  }

  return { ok: true, code: 0, reason: "", removed, verifyOutput: verifyParts.join("\n") };
}

/**
 * §13 un-sweep (inverse of `updateAgentEnumerationSurfaces`): drop `name` from
 * the three agent-list surfaces. Idempotent per surface. Returns null on
 * success, or a reason string on the first failure.
 */
function unsweepAgentEnumerationSurfaces(
  projectRoot: string,
  name: string,
): string | null {
  // (a) igris_tree.json agents map.
  const treePath = join(projectRoot, "core", "igris_tree.json");
  try {
    if (existsSync(treePath)) {
      const tree = JSON.parse(readFileSync(treePath, "utf-8")) as {
        agents?: Record<string, unknown>;
      } & Record<string, unknown>;
      if (tree.agents !== undefined && name in tree.agents) {
        delete tree.agents[name];
        writeFileSync(treePath, `${JSON.stringify(tree, null, 2)}\n`, "utf-8");
      }
    }
  } catch (err) {
    return `failed to update ${treePath}: ${(err as Error).message}`;
  }

  // (b) + (c) the two "Available Agents" CSV lines.
  const csvSurfaces = [
    join(projectRoot, "core", "templates", "CLAUDE.md.tmpl"),
    join(projectRoot, "CLAUDE.md"),
  ];
  for (const file of csvSurfaces) {
    if (!existsSync(file)) {
      // Tolerate an absent enumeration surface on the remove path (the add path
      // is what guarantees it exists; a re-run after partial state must not hard-
      // fail on a file the user already cleaned).
      continue;
    }
    try {
      const lines = readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (
          i > 0 &&
          lines[i - 1].trim() === "## Available Agents" &&
          lines[i].trim().length > 0
        ) {
          lines[i] = removeAgentFromCsvLine(lines[i], name);
          break;
        }
      }
      writeFileSync(file, lines.join("\n"), "utf-8");
    } catch (err) {
      return `failed to update ${file}: ${(err as Error).message}`;
    }
  }
  return null;
}

/**
 * FR-203: remove a CORE MCP server — the inverse of `addCoreMcp`. Splices the
 * `surfaces.mcp_servers[]` block out of `core/scripts/cli-adapters/
 * surfaces-manifest.json` + TD-096 re-mirror (content edit → cp + verify MATCH).
 */
export function removeCoreMcp(opts: RemoveCoreOptions): RemoveCoreResult {
  return removeCoreSurfaceBlock(opts, "mcp_servers", "MCP");
}

/**
 * FR-203: remove a CORE hook — the inverse of `addCoreHook`. Splices the
 * `surfaces.hooks[]` block out of the core surfaces manifest (+ re-mirror), and
 * deletes the shared `core/hooks/shared/<event>.sh` script ONLY when no OTHER
 * `surfaces.hooks[]` block still references that event (reuse-don't-clobber in
 * reverse). #828: touches ONLY the hooks surface — never `core/enforcement/`.
 */
export function removeCoreHook(opts: RemoveCoreOptions): RemoveCoreResult {
  const fail = (code: number, reason: string, verifyOutput = ""): RemoveCoreResult => ({
    ok: false,
    code,
    reason,
    removed: false,
    verifyOutput,
  });
  if (opts.name === undefined || opts.name.length === 0) {
    return fail(2, "hook <name> is required");
  }
  const name = opts.name;
  const root = opts.brainRoot ?? brainDir();
  const manifestSource = join(
    opts.projectRoot,
    "core",
    "scripts",
    "cli-adapters",
    "surfaces-manifest.json",
  );
  const manifestMirror = join(
    root,
    "core",
    "scripts",
    "cli-adapters",
    "surfaces-manifest.json",
  );
  if (!existsSync(manifestSource)) {
    return fail(
      1,
      `core surfaces manifest not found at ${manifestSource}; not an igris-ai checkout`,
    );
  }

  let removed = false;
  let removedEvent: string | undefined;
  let manifest: {
    surfaces?: { hooks?: Array<{ name?: string; event?: string }> } & Record<string, unknown>;
  } & Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestSource, "utf-8"));
  } catch (err) {
    return fail(1, `failed to parse ${manifestSource}: ${(err as Error).message}`);
  }
  const surfaces = (manifest.surfaces ?? {}) as {
    hooks?: Array<{ name?: string; event?: string }>;
  } & Record<string, unknown>;
  const blocks = Array.isArray(surfaces.hooks) ? surfaces.hooks : [];
  const idx = blocks.findIndex((b) => b.name === name);
  if (idx >= 0) {
    removedEvent = blocks[idx].event;
    blocks.splice(idx, 1);
    surfaces.hooks = blocks;
    if (blocks.length === 0) delete surfaces.hooks;
    manifest.surfaces = surfaces;
    try {
      writeFileSync(manifestSource, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    } catch (err) {
      return fail(1, `failed to update ${manifestSource}: ${(err as Error).message}`);
    }
    removed = true;
  }

  // Reuse-don't-clobber in reverse: delete the shared script ONLY when no OTHER
  // block still references that event.
  const event = removedEvent ?? opts.event;
  let verifyOutput = "";
  if (removed && typeof event === "string" && event.length > 0) {
    const stillReferenced = (surfaces.hooks ?? []).some((b) => b.event === event);
    if (!stillReferenced) {
      const scriptSource = join(opts.projectRoot, "core", "hooks", "shared", `${event}.sh`);
      const scriptMirror = join(root, "core", "hooks", "shared", `${event}.sh`);
      // Only delete a script the hook-add created. The canonical scripts
      // (session_start.sh, pre_tool_use.sh, …) are NOT removed here — but a
      // core hook add reuses them, so we must NOT delete a canonical script.
      // Guard: only remove when the script is NOT one of the canonical names.
      if (!isCanonicalHookScript(event)) {
        rmSync(scriptSource, { force: true });
        if (opts.skipMirror !== true) {
          rmSync(scriptMirror, { force: true });
        }
      }
    }
  }

  if (opts.skipMirror === true) {
    return { ok: true, code: 0, reason: "", removed, verifyOutput: "(mirror skipped)" };
  }

  // TD-096 re-mirror the EDITED surfaces manifest (content edit → cp + verify).
  if (removed) {
    const mv = mirrorAndVerify(manifestSource, manifestMirror, root);
    verifyOutput = mv.output;
    if (!mv.ok) {
      return fail(1, mv.reason, mv.output);
    }
    info(`Mirror verified (${manifestSource} <-> ${manifestMirror}): MATCH`);
  }
  return { ok: true, code: 0, reason: "", removed, verifyOutput };
}

/**
 * The canonical hook event scripts that ship with the brain (NOT created by a
 * core hook add). A core hook `remove` must NEVER delete one of these — only a
 * script a core hook ADD scaffolded for a NON-canonical event.
 *
 * NOTE: the canonical scripts are keyed by event (session_start.sh, …), so EVERY
 * portable event maps to a canonical script. Therefore a core hook remove NEVER
 * deletes the shared script — it only splices the surfaces block. This guard is
 * the conservative reuse-don't-clobber rule (always-true today; kept as the
 * extension point if a future non-canonical shared script lands).
 */
function isCanonicalHookScript(_event: string): boolean {
  return true;
}

/**
 * Shared core-surface block remover for mcp_servers (and any future
 * name-keyed `surfaces.<key>[]`). Splices the block by name + re-mirrors the
 * surfaces manifest (content edit). Returns the structured result.
 */
function removeCoreSurfaceBlock(
  opts: RemoveCoreOptions,
  surfaceKey: string,
  label: string,
): RemoveCoreResult {
  const fail = (code: number, reason: string, verifyOutput = ""): RemoveCoreResult => ({
    ok: false,
    code,
    reason,
    removed: false,
    verifyOutput,
  });
  if (opts.name === undefined || opts.name.length === 0) {
    return fail(2, `${label} <name> is required`);
  }
  const name = opts.name;
  const root = opts.brainRoot ?? brainDir();
  const manifestSource = join(
    opts.projectRoot,
    "core",
    "scripts",
    "cli-adapters",
    "surfaces-manifest.json",
  );
  const manifestMirror = join(
    root,
    "core",
    "scripts",
    "cli-adapters",
    "surfaces-manifest.json",
  );
  if (!existsSync(manifestSource)) {
    return fail(
      1,
      `core surfaces manifest not found at ${manifestSource}; not an igris-ai checkout`,
    );
  }

  let manifest: {
    surfaces?: Record<string, unknown>;
  } & Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestSource, "utf-8"));
  } catch (err) {
    return fail(1, `failed to parse ${manifestSource}: ${(err as Error).message}`);
  }
  const surfaces = (manifest.surfaces ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(surfaces[surfaceKey])
    ? (surfaces[surfaceKey] as Array<{ name?: string }>)
    : [];
  const before = blocks.length;
  const kept = blocks.filter((b) => b.name !== name);
  const removed = kept.length !== before;
  if (removed) {
    if (kept.length === 0) {
      delete surfaces[surfaceKey];
    } else {
      surfaces[surfaceKey] = kept;
    }
    manifest.surfaces = surfaces;
    try {
      writeFileSync(manifestSource, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    } catch (err) {
      return fail(1, `failed to update ${manifestSource}: ${(err as Error).message}`);
    }
  }

  if (opts.skipMirror === true) {
    return { ok: true, code: 0, reason: "", removed, verifyOutput: "(mirror skipped)" };
  }
  let verifyOutput = "";
  if (removed) {
    const mv = mirrorAndVerify(manifestSource, manifestMirror, root);
    verifyOutput = mv.output;
    if (!mv.ok) {
      return fail(1, mv.reason, mv.output);
    }
    info(`Mirror verified (${manifestSource} <-> ${manifestMirror}): MATCH`);
  }
  return { ok: true, code: 0, reason: "", removed, verifyOutput };
}
