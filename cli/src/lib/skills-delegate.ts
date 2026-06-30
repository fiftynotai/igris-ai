/**
 * FR-212a: SKILLS projection delegated to the pinned external `skills` CLI
 * (vercel-labs/agent-skills, npm package `skills`), STANDING UP ALONGSIDE the
 * custom `project_skills` engine behind the `IGRIS_SKILLS_ENGINE` flag.
 *
 * WHY A FLAG, NOT A SWAP (#832): FR-202 M1 already tried skills→npx, found the
 * tool didn't cover the harnesses, and reverted. The README now claims coverage,
 * but the plan does NOT trust the README — this module ships defaulting to
 * `"custom"` so prod behavior is unchanged. A later child flips the default
 * ONLY after the 5-harness smoke gate is green. There is NO custom-engine
 * fallback INSIDE the delegate path: when the flag is `delegate`, the delegate
 * is authoritative (a tool failure is an observable FAIL, never a silent
 * fall-through to the custom loop).
 *
 * SUPPLY-CHAIN POSTURE (constraint #2): the `skills` binary is resolved from the
 * LOCAL installed package (`require.resolve('skills/package.json')` → the `bin`
 * field), NEVER a bare runtime `npx` fetch. `assertLocalSkillsBinary` enforces
 * this — a resolution that ever produces the literal `npx` (or fails to resolve
 * a real on-disk file) is a hard error, not a network fetch.
 *
 * VERIFIED CLI INTERFACE (live probe of skills@1.5.13, 2026-06-26 — NOT the
 * README): the brief's assumed `skills add <abs-path> -g` + `skills remove
 * <name>` are CONFIRMED with these adjustments —
 *   - `skills add <ABS_LOCAL_DIR> -g -a <agent...> -y` — a LOCAL absolute path is
 *     accepted ("Local path validated"); `-a` takes SPACE-SEPARATED agent ids;
 *     `-y` skips the scope prompt. The 5 Igris harness agent ids are
 *     `claude-code codex gemini-cli opencode antigravity` (NOTE: `gemini-cli`,
 *     NOT `gemini` — `gemini` is rejected as an invalid agent).
 *   - default placement is symlink/universal: claude-code → `~/.claude/skills`,
 *     the other 4 read the shared universal store `~/.agents/skills`. `--copy`
 *     forces a copy instead of a symlink.
 *   - `skills remove <name> -g --all -y` — removes across all agents, leaving
 *     zero dangling links (verified). This is the un-projection inverse.
 *   - the drift re-check (FR-212a check_harness_drift `verify_skills` delegate
 *     arm) re-runs the idempotent `project-skills` projection and treats a clean
 *     exit 0 as MATCH (not a `skills list` diff).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// FR-217: the canonical-descriptor reader. The default skills target set READS
// the npx agent ids from the descriptor (skillAgentIds()); the former hardcoded
// per-harness agent-id list was deleted in M5 — the descriptor is the one source
// of truth (gemini→gemini-cli, claude→claude-code; the rest pass through).
import { skillAgentIds } from "./harness-descriptor.js";

export type SkillsEngine = "delegate" | "custom";

/**
 * The active skills placement engine. FR-212d Phase 2 (the #832 chokepoint
 * cleared — the 5-harness smoke gate is green) flipped the default to
 * `"delegate"` AND deleted the custom inline symlink/wrapper loop, so the
 * `skills` CLI is now the ONLY skills-projection engine. There is NO escape
 * hatch: the `IGRIS_SKILLS_ENGINE` env read is gone (operator decision — the
 * `"custom"` branch for the delegated path is retired). The `SkillsEngine` type
 * is retained for the result-shape `engine` field, but the resolver is now a
 * constant.
 *
 * @param _env unused — retained so the signature stays call-compatible with the
 *   FR-212a probes/tests that passed an env map; ignored.
 */
export function resolveSkillsEngine(
  _env: NodeJS.ProcessEnv = process.env,
): SkillsEngine {
  return "delegate";
}

/**
 * Resolve the absolute path to the LOCAL `skills` binary from the installed
 * package — `require.resolve('skills/package.json')` → the package dir → the
 * `bin.skills` (or `bin` string) field. NEVER returns a bare `npx`. Anchored on
 * THIS module's directory (`import.meta.url`) so resolution works identically
 * under vitest (`cli/src/lib`) and the published package (`cli/dist/lib`), and
 * resolves the hoisted workspace `node_modules` at the repo root.
 *
 * Throws if the package can't be resolved or the bin file is absent on disk —
 * a hard error is correct (constraint #2: no silent network fetch fallback).
 */
export function resolveSkillsBinary(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const req = createRequire(join(here, "_skills-delegate-resolver.cjs"));
  let pkgJsonPath: string;
  try {
    pkgJsonPath = req.resolve("skills/package.json");
  } catch (err) {
    throw new Error(
      `skills-delegate: cannot resolve the local 'skills' package — it must be ` +
        `a pinned dependency in cli/package.json and installed in node_modules ` +
        `(NEVER fetched via a bare 'npx'). Original: ${(err as Error).message}`,
    );
  }
  const pkgDir = dirname(pkgJsonPath);
  // The `bin` field is either a string (single bin) or a map. The `skills`
  // package declares `{ "skills": "./bin/cli.mjs", "add-skill": "./bin/cli.mjs" }`.
  const pkg = req("skills/package.json") as {
    bin?: string | Record<string, string>;
  };
  let binRel: string | undefined;
  if (typeof pkg.bin === "string") {
    binRel = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === "object") {
    binRel = pkg.bin.skills ?? Object.values(pkg.bin)[0];
  }
  if (!binRel) {
    throw new Error(
      "skills-delegate: the 'skills' package declares no usable 'bin' entry.",
    );
  }
  const binAbs = isAbsolute(binRel) ? binRel : join(pkgDir, binRel);
  // The REAL resolution must also exist on disk (a missing file means a broken
  // install, NOT a reason to fall back to a network fetch). The cheap
  // npx/absolute invariant is enforced by `assertLocalSkillsBinary` (also run on
  // every spawn, including injected test resolvers).
  assertLocalSkillsBinary(binAbs);
  if (!existsSync(binAbs)) {
    throw new Error(
      `skills-delegate: resolved skills binary does not exist on disk: ${binAbs}`,
    );
  }
  return binAbs;
}

/**
 * Guard: the resolved skills invocation MUST be a LOCAL absolute path, never the
 * literal `npx` (or any bare command name). This is the supply-chain chokepoint
 * (constraint #2) — a bare `npx skills` would fetch from the network at runtime,
 * defeating the exact-version pin. Returns the path unchanged when valid; throws
 * otherwise.
 *
 * This is the CHEAP, fs-free half of the guard (run on EVERY spawn, including
 * injected test resolvers). The on-disk-existence half lives in
 * `resolveSkillsBinary` only — a test that injects a fake absolute resolver
 * shouldn't have to point at a real file to prove the npx/absolute invariant.
 */
export function assertLocalSkillsBinary(bin: string): string {
  if (bin === "npx" || bin === "npx.cmd" || !isAbsolute(bin)) {
    throw new Error(
      `skills-delegate: refusing to invoke a non-local skills binary ('${bin}'). ` +
        `The pinned 'skills' package must be resolved to an absolute path in ` +
        `node_modules — a bare 'npx' would be an unpinned network fetch.`,
    );
  }
  return bin;
}

/** A structured verdict from one `skills` CLI invocation. */
export interface SkillsToolResult {
  /** True iff the tool exited 0. */
  ok: boolean;
  /** The process exit code (or a non-zero sentinel if the spawn itself failed). */
  exitCode: number;
  /** Captured stdout (trimmed). */
  stdout: string;
  /** Captured stderr (trimmed). */
  stderr: string;
  /** The argv the tool was invoked with (binary + args) — for diagnostics. */
  argv: string[];
}

/** Options for the spawn — injectable seams keep unit tests off the real CLI. */
export interface SkillsSpawnDeps {
  /** Override the binary resolver (tests inject a fake absolute path). */
  resolveBinary?: () => string;
  /** Override the spawn (tests SPY this — NEVER spawn the real CLI in a unit test). */
  spawn?: typeof spawnSync;
}

/**
 * Build the argv for `skills add <abs-source> -g -a <agent...> -y`.
 *
 * @param source ABSOLUTE path to the skills source dir (the dir CONTAINING the
 *   `<name>/SKILL.md` subfolders, e.g. `~/.igris/core/skills`). MUST be
 *   absolute — the tool validates a local path, and an absolute path avoids the
 *   cwd-relative ambiguity that bit codex symlinks (FR-157).
 * @param harnesses the `skills` agent ids to target (default: the 5 Igris
 *   harnesses). Passed space-separated after a single `-a`.
 * @param global when true, `-g` (user-level). Igris projects skills globally.
 * @param mode `"symlink"` (default tool behavior) or `"copy"` (`--copy`).
 */
export function buildSkillsAddArgv(args: {
  source: string;
  harnesses?: readonly string[];
  global?: boolean;
  mode?: "symlink" | "copy";
}): string[] {
  const { source } = args;
  if (!isAbsolute(source)) {
    throw new Error(
      `skills-delegate: add source must be an absolute path (got '${source}').`,
    );
  }
  const harnesses =
    args.harnesses && args.harnesses.length > 0
      ? args.harnesses
      : skillAgentIds();
  const argv = ["add", source];
  if (args.global !== false) {
    argv.push("-g");
  }
  // `-a` takes space-separated agent ids (verified: `--agent claude-code cursor`).
  argv.push("-a", ...harnesses);
  if (args.mode === "copy") {
    argv.push("--copy");
  }
  // `-y` skips the interactive scope prompt — required for non-interactive
  // compile-time projection.
  argv.push("-y");
  return argv;
}

/**
 * Build the argv for `skills remove <name> -g --all -y` — the un-projection
 * inverse. `--all` removes the skill from every agent it was projected to;
 * `-y` skips the confirm. Verified to leave zero dangling links.
 */
export function buildSkillsRemoveArgv(args: {
  name: string;
  global?: boolean;
}): string[] {
  const { name } = args;
  if (!name || name.trim() === "") {
    throw new Error("skills-delegate: remove requires a non-empty skill name.");
  }
  const argv = ["remove", name];
  if (args.global !== false) {
    argv.push("-g");
  }
  argv.push("--all", "-y");
  return argv;
}

/**
 * Parse a `skills` invocation into a structured verdict. The verdict is keyed
 * PRIMARILY on the exit code (the tool's authoritative signal); stdout/stderr
 * are captured for diagnostics + the drift re-check. NEVER throws — a spawn
 * failure (e.g. ENOENT) is reported as `ok:false` with a non-zero exit so the
 * caller's accounting stays observable (L-232: never a silent empty success).
 */
function toResult(
  argv: string[],
  spawnResult: ReturnType<typeof spawnSync>,
): SkillsToolResult {
  // `status` is null when the process was killed by a signal or never spawned;
  // map that to a non-zero sentinel so `ok` is never true on a non-clean exit.
  const exitCode =
    spawnResult.status === null || spawnResult.status === undefined
      ? spawnResult.error
        ? 127 // spawn failed (ENOENT etc.)
        : 1
      : spawnResult.status;
  return {
    ok: exitCode === 0,
    exitCode,
    stdout: (spawnResult.stdout ?? "").toString().trim(),
    stderr: (spawnResult.stderr ?? "").toString().trim(),
    argv,
  };
}

/**
 * Project skills via the LOCAL `skills` CLI: spawn
 * `skills add <abs-source> -g -a <agents…> -y`. Returns a structured verdict.
 *
 * No custom-engine fallback (constraint #2): the caller decides the engine
 * (`resolveSkillsEngine`); once here, the tool is authoritative. The argv is
 * SKILL-PATH only — it carries NO secret (skills are public content), so the
 * full argv is safe to log; we still keep `argv` in the result for the caller
 * to decide what to surface.
 */
export function projectSkillsViaTool(
  args: {
    source: string;
    harnesses?: readonly string[];
    global?: boolean;
    mode?: "symlink" | "copy";
  },
  deps: SkillsSpawnDeps = {},
): SkillsToolResult {
  const bin = (deps.resolveBinary ?? resolveSkillsBinary)();
  assertLocalSkillsBinary(bin);
  const args2 = buildSkillsAddArgv(args);
  const spawn = deps.spawn ?? spawnSync;
  const result = spawn(bin, args2, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return toResult([bin, ...args2], result);
}

/**
 * Un-project a skill via the LOCAL `skills` CLI: spawn
 * `skills remove <name> -g --all -y`. Returns a structured verdict. This is the
 * delegate inverse of the custom `deleteLink`-on-manifest-paths un-projection —
 * routing through the tool's own `remove` is REQUIRED because the tool created
 * the symlinks (under `~/.agents/skills` + `~/.claude/skills`), so the
 * manifest-derived paths `deleteLink` knows are NOT the ones to delete.
 */
export function unprojectSkillsViaTool(
  name: string,
  deps: SkillsSpawnDeps & { global?: boolean } = {},
): SkillsToolResult {
  const bin = (deps.resolveBinary ?? resolveSkillsBinary)();
  assertLocalSkillsBinary(bin);
  const argv = buildSkillsRemoveArgv({ name, global: deps.global });
  const spawn = deps.spawn ?? spawnSync;
  const result = spawn(bin, argv, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return toResult([bin, ...argv], result);
}
