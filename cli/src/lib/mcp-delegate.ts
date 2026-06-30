/**
 * FR-212b: MCP SERVER REGISTRATION delegated to the pinned external `add-mcp`
 * CLI (npm package `add-mcp`), STANDING UP ALONGSIDE the custom
 * `mergeJsonConfig`/`mergeTomlConfig` projection behind the `IGRIS_MCP_ENGINE`
 * flag. Mirrors the FR-212a `skills-delegate.ts` shape byte-for-byte (local-
 * binary assert, DI seams, verdict parser, `resolveMcpEngine` default
 * `"custom"`).
 *
 * RE-SCOPE 2026-06-26 (Option C — operator-decided): shipped `add-mcp@1.11.0`
 * (npm latest, pinned in cli/package.json by FR-212a) has NO `--auto-approve`
 * (live-verified: 0 occurrences in `dist/`; the flag is in the tool's GitHub
 * `main` but UNPUBLISHED). So this module does SERVER REGISTRATION ONLY — it
 * writes the per-harness MCP server ENTRY (the `node <repo>/brain-mcp-server/
 * dist/index.js` stdio launch spec). The no-prompt TRUST GRANT is Igris-owned,
 * deterministic, and lives in the sibling `mcp-grant.ts` (the FR-184 work) —
 * NEVER a residual after add-mcp.
 *
 * IGRIS OWNS *WHAT* THE BRAIN IS (constraint #1): the canonical command/args/env
 * come from `mcp-shape.ts:buildHarnessMcpEntry` (the ONE place the brain's
 * launch spec lives). This delegate owns only the per-harness SERIALIZATION —
 * it hands add-mcp the target/name/args/env and lets the tool write the native
 * config shape. The `${VAR}` secret-indirection rules are preserved: an env
 * value is passed as the literal `KEY=${VAR}` token (add-mcp's documented
 * placeholder grammar), NEVER a resolved secret literal in any logged argv.
 *
 * WHY A FLAG, NOT A SWAP: the custom FR-162/163/164 projection is proven + has a
 * 30+-case suite + a §18.1 bash shape-twin. This module ships defaulting to
 * `"custom"` so prod behavior is UNCHANGED; a later child flips the default
 * ONLY after a multi-harness smoke gate is green. There is NO custom-engine
 * fallback INSIDE the delegate path: when the flag is `delegate`, the delegate
 * is authoritative (a tool failure is an observable FAIL, never a silent
 * fall-through to the merger loop — L-232).
 *
 * SUPPLY-CHAIN POSTURE (constraint #2, mirrored from FR-212a): the `add-mcp`
 * binary is resolved from the LOCAL installed package
 * (`require.resolve('add-mcp/package.json')` → the `bin` field), NEVER a bare
 * runtime `npx` fetch. `assertLocalMcpBinary` enforces this — a resolution that
 * ever produces the literal `npx` (or fails to resolve a real on-disk file) is a
 * hard error, not a network fetch.
 *
 * VERIFIED CLI INTERFACE (live probe of add-mcp@1.11.0, 2026-06-26 — NOT the
 * README):
 *   - `add-mcp "<command> <arg…>" -g -a <agent...> -n <name> --env KEY=${VAR}`
 *     registers a LOCAL stdio server. `<target>` is the FULL launch command as
 *     ONE positional (for the brain: `"node <abs-entry>"`) — NOT a bare command
 *     with the args on `--args`. A BARE-WORD target (`node`) is treated as an
 *     npm PACKAGE NAME and npx-wrapped (`{command:"npx",args:["-y","node",…]}`);
 *     the joined positional makes add-mcp write the LITERAL `{command,args}`
 *     shape (FR-212d fix — `--args` is NO LONGER used). `-a` is REPEATABLE (one
 *     flag per agent), `-g` = user-level, `-n` = server name, `-y` skips prompts.
 *   - the 6 Igris harness agent ids are EXACTLY `claude-code codex gemini-cli
 *     opencode antigravity cursor` (live `list-agents` — same ids as the skills CLI;
 *     `gemini-cli`, NOT `gemini`).
 *   - `add-mcp remove <query> -g -a <agent...> -y` is the un-registration
 *     inverse (probed: `remove [options] <query>`, `-g`/`-a`/`-y`).
 *   - `--env`/`--args` placeholders `${VAR}` prompt interactively WITHOUT `-y`;
 *     with `-y` they pass through verbatim (the secret-indirection contract).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// FR-217: the canonical-descriptor reader. The default MCP target set READS the
// npx agent ids from the descriptor (mcpAgentIds()); the former hardcoded
// per-harness agent-id list (live-probed `add-mcp list-agents`) was deleted in
// M5 — the descriptor is the one source of truth (NOTE: gemini→gemini-cli).
import { mcpAgentIds } from "./harness-descriptor.js";

export type McpEngine = "delegate" | "custom";

/**
 * The active MCP placement engine. FR-212d Phase 2 (the smoke gate is green)
 * flipped the default to `"delegate"` AND deleted the custom merger placement
 * for the 4 DELEGATED harnesses (claude/codex/gemini/opencode), so `add-mcp` +
 * the Igris-owned grant is the engine for them. There is NO escape hatch: the
 * `IGRIS_MCP_ENGINE` env read is gone (operator decision — the `"custom"` branch
 * for the delegated paths is retired).
 *
 * ANTIGRAVITY IS THE EXCEPTION (kept, NOT deleted): its config path differs
 * (`~/.gemini/config/mcp_config.json`, FR-179 R1) so add-mcp would write where
 * antigravity never reads. Antigravity's ENTRY (register + remove) stays CUSTOM
 * (the proven `mergeJsonConfig`/`unmergeJsonConfig`) REGARDLESS of this resolver
 * — that carve-out lives in `mcp-register.ts:registerBrainAcrossHarnesses` /
 * `runProjectMcp`, not here. So "delegate" engine ≠ "100% add-mcp": antigravity's
 * entry + every harness's grant stay Igris-owned.
 *
 * @param _env unused — retained so the signature stays call-compatible; ignored.
 */
export function resolveMcpEngine(
  _env: NodeJS.ProcessEnv = process.env,
): McpEngine {
  return "delegate";
}

/**
 * Resolve the absolute path to the LOCAL `add-mcp` binary from the installed
 * package — `require.resolve('add-mcp/package.json')` → the package dir → the
 * `bin['add-mcp']` (or `bin` string) field. NEVER returns a bare `npx`. Anchored
 * on THIS module's directory (`import.meta.url`) so resolution works identically
 * under vitest (`cli/src/lib`) and the published package (`cli/dist/lib`), and
 * resolves the hoisted workspace `node_modules` at the repo root.
 *
 * Throws if the package can't be resolved or the bin file is absent on disk — a
 * hard error is correct (constraint #2: no silent network fetch fallback).
 */
export function resolveMcpBinary(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const req = createRequire(join(here, "_mcp-delegate-resolver.cjs"));
  let pkgJsonPath: string;
  try {
    pkgJsonPath = req.resolve("add-mcp/package.json");
  } catch (err) {
    throw new Error(
      `mcp-delegate: cannot resolve the local 'add-mcp' package — it must be a ` +
        `pinned dependency in cli/package.json and installed in node_modules ` +
        `(NEVER fetched via a bare 'npx'). Original: ${(err as Error).message}`,
    );
  }
  const pkgDir = dirname(pkgJsonPath);
  // The `bin` field is either a string (single bin) or a map. The `add-mcp`
  // package declares `{ "add-mcp": "dist/index.js" }`.
  const pkg = req("add-mcp/package.json") as {
    bin?: string | Record<string, string>;
  };
  let binRel: string | undefined;
  if (typeof pkg.bin === "string") {
    binRel = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === "object") {
    binRel = pkg.bin["add-mcp"] ?? Object.values(pkg.bin)[0];
  }
  if (!binRel) {
    throw new Error(
      "mcp-delegate: the 'add-mcp' package declares no usable 'bin' entry.",
    );
  }
  const binAbs = isAbsolute(binRel) ? binRel : join(pkgDir, binRel);
  // The REAL resolution must also exist on disk (a missing file means a broken
  // install, NOT a reason to fall back to a network fetch). The cheap
  // npx/absolute invariant is enforced by `assertLocalMcpBinary` (also run on
  // every spawn, including injected test resolvers).
  assertLocalMcpBinary(binAbs);
  if (!existsSync(binAbs)) {
    throw new Error(
      `mcp-delegate: resolved add-mcp binary does not exist on disk: ${binAbs}`,
    );
  }
  return binAbs;
}

/**
 * Guard: the resolved add-mcp invocation MUST be a LOCAL absolute path, never
 * the literal `npx` (or any bare command name). This is the supply-chain
 * chokepoint (constraint #2) — a bare `npx add-mcp` would fetch from the network
 * at runtime, defeating the exact-version pin. Returns the path unchanged when
 * valid; throws otherwise.
 *
 * This is the CHEAP, fs-free half of the guard (run on EVERY spawn, including
 * injected test resolvers). The on-disk-existence half lives in
 * `resolveMcpBinary` only — a test that injects a fake absolute resolver
 * shouldn't have to point at a real file to prove the npx/absolute invariant.
 */
export function assertLocalMcpBinary(bin: string): string {
  if (bin === "npx" || bin === "npx.cmd" || !isAbsolute(bin)) {
    throw new Error(
      `mcp-delegate: refusing to invoke a non-local add-mcp binary ('${bin}'). ` +
        `The pinned 'add-mcp' package must be resolved to an absolute path in ` +
        `node_modules — a bare 'npx' would be an unpinned network fetch.`,
    );
  }
  return bin;
}

/** A structured verdict from one `add-mcp` CLI invocation. */
export interface McpToolResult {
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
export interface McpSpawnDeps {
  /** Override the binary resolver (tests inject a fake absolute path). */
  resolveBinary?: () => string;
  /** Override the spawn (tests SPY this — NEVER spawn the real CLI in a unit test). */
  spawn?: typeof spawnSync;
}

/** The canonical launch spec the delegate hands add-mcp (Igris owns this). */
export interface McpRegisterSpec {
  /** Server name (the `igris-brain` key). */
  name: string;
  /** The stdio target = the command to launch (for the brain: `node`). */
  command: string;
  /** Launch args (for the brain: the abs path to the bundled entrypoint). */
  args?: string[];
  /**
   * Env entries as canonical `${VAR}` indirection refs (NEVER resolved
   * literals) — passed to add-mcp as `KEY=${VAR}` `--env` tokens. The brain is
   * env-free (L-588) so this is `{}` in practice, but the passthrough is here so
   * the delegate is correct for any future secret-bearing MCP server.
   */
  env?: Record<string, string>;
  /** add-mcp agent ids to target (default: all Igris harnesses from the descriptor). */
  harnesses?: readonly string[];
  /** When true (default), `-g` (user-level). Igris registers MCP globally. */
  global?: boolean;
}

/**
 * Build the argv for `add-mcp "<command> <arg…>" -g -a <agent...> -n <name>
 * --env KEY=${VAR} -y`.
 *
 * FR-212d FIX (the smoke-gate blocker): the FULL launch command is passed as ONE
 * positional `<target>` — `"node <abs-entry>"` — NOT `<command>` with the args
 * riding `--args`. add-mcp's `<target>` data model is "URL (remote) OR npm
 * PACKAGE NAME (local stdio)": a BARE-WORD target (`node`) is treated as a
 * package name and serialized as `{command:"npx",args:["-y","node",<entry>]}` —
 * a runtime `npx`-fetch of a bogus "node" package (broken brain + violates the
 * no-runtime-npx pin, constraint #2). Live-verified on add-mcp@1.11.0
 * (2026-06-26):
 *   - `add-mcp node ... --args <e>`        → `{"command":"npx","args":["-y","node",<e>]}` ❌
 *   - `add-mcp "node <e>" ...`             → `{"command":"node","args":[<e>]}`           ✅
 * add-mcp flips to a LITERAL command (no npx-wrap) when the target's FIRST token
 * looks like a path OR is followed by space-separated launch args in the same
 * positional. The joined `"<command> <arg…>"` positional is the operator-verified
 * correct form. `--args` is NO LONGER used (it only feeds the npx-wrapped path).
 *
 * SPACE HAZARD (constraint: never silently corrupt): add-mcp tokenizes the
 * positional on WHITESPACE and has NO intra-positional quoting grammar — a
 * space-bearing command or arg WOULD split into multiple args (live-verified:
 * `"node /p with space/x.js"` → `args:["/p","with","space/x.js"]`). The brain's
 * entry path is space-free (L-588 / bundledMcpEntryPath), but rather than emit a
 * silently-corrupting argv we THROW a clear error if any token contains
 * whitespace. (A future space-bearing server must use the custom engine until
 * add-mcp grows a quoting grammar.)
 *
 * SECRET HYGIENE (constraint #1): each env VALUE is emitted VERBATIM as the
 * canonical `${VAR}` indirection ref inside a `KEY=${VAR}` token — never a
 * resolved literal. With `-y`, add-mcp passes the placeholder through to the
 * written config (live-verified: `--env API_TOKEN=${MY_SECRET}` → the literal
 * `${MY_SECRET}` in the config). A literal secret never enters the argv, so the
 * full argv is safe to surface in a verdict/log.
 *
 * @param spec the canonical launch spec (Igris-owned command/args/env).
 */
export function buildMcpAddArgv(spec: McpRegisterSpec): string[] {
  const { name, command } = spec;
  if (!name || name.trim() === "") {
    throw new Error("mcp-delegate: add requires a non-empty server name.");
  }
  if (!command || command.trim() === "") {
    throw new Error("mcp-delegate: add requires a non-empty command/target.");
  }
  const harnesses =
    spec.harnesses && spec.harnesses.length > 0
      ? spec.harnesses
      : mcpAgentIds();
  const args = spec.args ?? [];
  // SPACE HAZARD guard (see header): add-mcp splits the positional on whitespace
  // with no quoting grammar, so any token with internal whitespace would be torn
  // into multiple args. Refuse to emit a corrupting argv (the brain is space-free
  // so this never trips in prod — it is a hard guard against a future caller).
  for (const token of [command, ...args]) {
    if (/\s/.test(token)) {
      throw new Error(
        `mcp-delegate: add-mcp cannot represent a whitespace-bearing command/arg ` +
          `via its single positional target (it tokenizes on whitespace with no ` +
          `quoting grammar) — got '${token}'. Use the custom MCP engine for this ` +
          `server until add-mcp supports quoted args.`,
      );
    }
  }
  // FR-212d: the FULL launch command is ONE positional `<target>` — `"node
  // <abs-entry>"` — so add-mcp writes the LITERAL `{command, args}` shape, NOT
  // the npx-wrapped `{command:"npx",args:["-y",<command>,…]}` it produces for a
  // bare package-name target. `--args` is intentionally NOT used.
  const target = [command, ...args].join(" ");
  const argv = [target];
  if (spec.global !== false) {
    argv.push("-g");
  }
  // `-a` is REPEATABLE (one flag per agent — live-probed default `[]`).
  for (const h of harnesses) {
    argv.push("-a", h);
  }
  argv.push("-n", name);
  // `--env KEY=${VAR}` — the value is the ${VAR} ref VERBATIM (no resolution).
  const env = spec.env ?? {};
  for (const key of Object.keys(env)) {
    argv.push("--env", `${key}=${env[key]}`);
  }
  // `-y` skips the interactive prompts (required for non-interactive register +
  // the ${VAR} placeholder passthrough).
  argv.push("-y");
  return argv;
}

/**
 * Build the argv for `add-mcp remove <name> -g -a <agent...> -y` — the
 * un-registration inverse. `-a` filters to the targeted agents; `-y` removes
 * all matches without prompting.
 */
export function buildMcpRemoveArgv(args: {
  name: string;
  harnesses?: readonly string[];
  global?: boolean;
}): string[] {
  const { name } = args;
  if (!name || name.trim() === "") {
    throw new Error("mcp-delegate: remove requires a non-empty server name.");
  }
  const harnesses =
    args.harnesses && args.harnesses.length > 0
      ? args.harnesses
      : mcpAgentIds();
  const argv = ["remove", name];
  if (args.global !== false) {
    argv.push("-g");
  }
  for (const h of harnesses) {
    argv.push("-a", h);
  }
  argv.push("-y");
  return argv;
}

/**
 * Parse an `add-mcp` invocation into a structured verdict. The verdict is keyed
 * PRIMARILY on the exit code (the tool's authoritative signal); stdout/stderr
 * are captured for diagnostics. NEVER throws — a spawn failure (e.g. ENOENT) is
 * reported as `ok:false` with a non-zero exit so the caller's accounting stays
 * observable (L-232: never a silent empty success).
 */
function toResult(
  argv: string[],
  spawnResult: ReturnType<typeof spawnSync>,
): McpToolResult {
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
 * Register an MCP server via the LOCAL `add-mcp` CLI: spawn `add-mcp "<command>
 * <arg…>" -g -a <agents…> -n <name> --env … -y`. Returns a structured verdict.
 *
 * No custom-engine fallback (constraint #2): the caller decides the engine
 * (`resolveMcpEngine`); once here, the tool is authoritative. The argv carries
 * only `${VAR}` indirection refs (never a resolved secret), so the full argv is
 * safe to surface; we still keep `argv` in the result for the caller to decide
 * what to log.
 */
export function registerMcpViaTool(
  spec: McpRegisterSpec,
  deps: McpSpawnDeps = {},
): McpToolResult {
  const bin = (deps.resolveBinary ?? resolveMcpBinary)();
  assertLocalMcpBinary(bin);
  const argv = buildMcpAddArgv(spec);
  const spawn = deps.spawn ?? spawnSync;
  const result = spawn(bin, argv, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return toResult([bin, ...argv], result);
}

/**
 * Un-register an MCP server via the LOCAL `add-mcp` CLI: spawn `add-mcp remove
 * <name> -g -a <agents…> -y`. Returns a structured verdict. This is the delegate
 * inverse of the custom `unmergeJsonConfig`/`unmergeTomlConfig` un-projection —
 * routing through the tool's own `remove` is REQUIRED because the tool wrote the
 * native config entries (under each harness's config file), so the merger-
 * derived inverse may not match the exact shape the tool placed.
 */
export function unregisterMcpViaTool(
  name: string,
  deps: McpSpawnDeps & { harnesses?: readonly string[]; global?: boolean } = {},
): McpToolResult {
  const bin = (deps.resolveBinary ?? resolveMcpBinary)();
  assertLocalMcpBinary(bin);
  const argv = buildMcpRemoveArgv({
    name,
    harnesses: deps.harnesses,
    global: deps.global,
  });
  const spawn = deps.spawn ?? spawnSync;
  const result = spawn(bin, argv, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return toResult([bin, ...argv], result);
}
