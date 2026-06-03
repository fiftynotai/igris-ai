/**
 * Upsert the `igris-brain` MCP entry in `~/.claude.json` — TD-168.
 *
 * `npm install -g igris-ai` ships a bundled brain-mcp-server under
 * `cli/dist/brain-mcp-server/`. For Claude Code to actually serve those
 * tools, the bundled MCP must be registered in the user's `~/.claude.json`
 * `mcpServers` map. `igris init` / `igris install` call
 * `registerMcpInClaudeJson()` to do that; `igris doctor` calls
 * `inspectMcpRegistration()` to verify it.
 *
 * Correctness contract (the #1 AC — `~/.claude.json` is hot machine state
 * written constantly by Claude Code):
 *
 *   1. MALFORMED FILE IS NEVER CORRUPTED. On `JSON.parse` failure we do
 *      NOT write, do NOT back up, do NOT leave a `.tmp` file — we return
 *      `outcome: 'failed'` with an actionable error. The user keeps their
 *      broken file intact to fix themselves.
 *   2. PRE-EXISTING ENTRIES PRESERVED VERBATIM. Other `mcpServers[...]`
 *      keys AND other top-level keys (`numStartups`, `projects`, ...) are
 *      untouched. We upsert ONLY `mcpServers["igris-brain"]` by direct key
 *      assignment — never object replacement.
 *   3. IDEMPOTENT. If the entry already deep-equals the desired entry we
 *      return `outcome: 'unchanged'` WITHOUT writing — no mtime churn.
 *   4. ATOMIC WRITE + SINGLE ROLLING BACKUP. A pre-existing file is copied
 *      to `~/.claude.json.igris.bak` (single rolling — NOT timestamped;
 *      `~/.claude.json` churns too fast to spam the home dir with dated
 *      backups, unlike install.ts's `backupSettings()` for the much
 *      quieter project settings.json). The write goes to a
 *      `.tmp.<pid>.<ts>` sibling then `renameSync` over the target.
 *   5. NEVER THROWS. All failure modes fold into `outcome: 'failed'` so
 *      verb callers (init/install) can warn-and-continue.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { bundledMcpEntryPath, claudeJsonPath } from "./paths.js";

/** The fixed key under `mcpServers` that Igris owns. */
const MCP_KEY = "igris-brain";

/** Single rolling backup suffix appended to the claude.json path. */
const BACKUP_SUFFIX = ".igris.bak";

/** Outcome of a registration attempt — drives caller logging. */
export type McpRegisterOutcome =
  | "registered" // entry created (file was missing or key absent)
  | "updated" // key existed, args repointed
  | "unchanged" // entry already correct — idempotent no-op
  | "failed"; // malformed file or write error (non-fatal to caller)

export interface McpRegisterResult {
  outcome: McpRegisterOutcome;
  claudeJsonPath: string;
  mcpEntryPath: string;
  /** Populated when `outcome === 'failed'`. */
  error?: string;
}

/** The desired shape of the `mcpServers["igris-brain"]` entry. */
interface McpEntry {
  type: "stdio";
  command: "node";
  args: string[];
  env: Record<string, string>;
}

function buildDesiredEntry(mcpEntryPath: string): McpEntry {
  return {
    type: "stdio",
    command: "node",
    args: [mcpEntryPath],
    env: {},
  };
}

/** True when `v` is a plain (non-array, non-null) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Structural deep-equality for the entry comparison. The entry is plain
 * JSON data (strings, arrays, objects) so a JSON round-trip compare is
 * exact and dependency-free. Key ORDER is intentionally ignored — a
 * pre-existing entry with the same content in a different key order is
 * still "unchanged" (no rewrite, no mtime churn).
 */
function entryDeepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => entryDeepEquals(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    if (!ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => entryDeepEquals(a[k], b[k]));
  }
  return false;
}

/**
 * FR-162: the generalized, harness-agnostic JSON-merge core extracted from
 * `registerMcpInClaudeJson`. Upserts a single named `entry` under a `mapKey`
 * map in a JSON config FILE, preserving the proven 6-step contract verbatim
 * (see the file header): malformed-never-clobber, preserve all other keys +
 * entries, idempotent deep-equal no-op, single rolling backup + .tmp +
 * `renameSync`, non-object `mapKey` → failed, and NEVER throws.
 *
 * Used by `registerMcpInClaudeJson` (Claude's `mcpServers`) today and staged
 * for FR-164's compile-time projection into Gemini's `mcpServers`, OpenCode's
 * `mcp`, etc. The generic call site supplies its own `mapKey` (e.g. `"mcp"` for
 * OpenCode) + `entryKey` (the server name) + the already-built `entry` shape.
 *
 * The `McpRegisterResult` outcome union is reused verbatim (DO NOT add a new
 * union — the wrapper + its 30-case suite depend on the exact field names). For
 * a generic call the `claudeJsonPath` result field carries `targetPath` and
 * `mcpEntryPath` is set to `""` (it is meaningful only to the Claude wrapper,
 * which re-stamps both fields).
 *
 * @param opts.targetPath  The JSON config FILE to upsert into.
 * @param opts.mapKey      The top-level map key (`"mcpServers"` | `"mcp"`).
 * @param opts.entryKey    The server name to upsert under `mapKey`.
 * @param opts.entry       The per-harness entry SHAPE (built by the caller).
 * @param opts.backup      Single rolling `<path>.igris.bak`. Defaults to true.
 */
export function mergeJsonConfig(opts: {
  targetPath: string;
  mapKey: string;
  entryKey: string;
  entry: Record<string, unknown>;
  backup?: boolean;
}): McpRegisterResult {
  const { targetPath, mapKey, entryKey, entry } = opts;
  const backup = opts.backup ?? true;

  // --- 1. Read ---------------------------------------------------------
  const fileExisted = existsSync(targetPath);
  let rawBytes: Buffer | null = null;
  if (fileExisted) {
    try {
      rawBytes = readFileSync(targetPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        outcome: "failed",
        claudeJsonPath: targetPath,
        mcpEntryPath: "",
        error: `could not read ${targetPath}: ${msg}`,
      };
    }
  }

  // --- 2. Parse — fail loud on malformed JSON (do NOT clobber) ----------
  let root: Record<string, unknown>;
  if (rawBytes === null) {
    // File absent — start from a fresh object.
    root = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBytes.toString("utf-8"));
    } catch {
      return {
        outcome: "failed",
        claudeJsonPath: targetPath,
        mcpEntryPath: "",
        error: `malformed ${targetPath} — refusing to write; fix or remove the file manually`,
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        outcome: "failed",
        claudeJsonPath: targetPath,
        mcpEntryPath: "",
        error: `${targetPath} is not a JSON object — refusing to write; fix or remove the file manually`,
      };
    }
    root = parsed;
  }

  // --- 3. Locate the mapKey map (preserve all other top-level keys) -----
  let serverMap: Record<string, unknown>;
  const existingMap = root[mapKey];
  if (existingMap === undefined) {
    serverMap = {};
  } else if (isPlainObject(existingMap)) {
    serverMap = existingMap;
  } else {
    // `mapKey` exists but isn't an object — treat as malformed shape.
    return {
      outcome: "failed",
      claudeJsonPath: targetPath,
      mcpEntryPath: "",
      error: `${targetPath} has a non-object '${mapKey}' — refusing to write; fix or remove the file manually`,
    };
  }

  // --- 4. Idempotency check — return without writing if already correct -
  const current = serverMap[entryKey];
  const keyExisted = current !== undefined;
  if (keyExisted && entryDeepEquals(current, entry)) {
    return {
      outcome: "unchanged",
      claudeJsonPath: targetPath,
      mcpEntryPath: "",
    };
  }

  // --- 5. Upsert — direct key assignment, never object replacement -----
  serverMap[entryKey] = entry;
  root[mapKey] = serverMap;

  // --- 6. Backup-then-atomic-write -------------------------------------
  const serialized = JSON.stringify(root, null, 2) + "\n";
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    if (backup && fileExisted && rawBytes !== null) {
      // Single rolling backup — overwrite any prior `.igris.bak`.
      writeFileSync(`${targetPath}${BACKUP_SUFFIX}`, rawBytes);
    }
    writeFileSync(tmpPath, serialized);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the tmp file so a write error never leaves
    // litter next to the hot config file.
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore — cleanup is best-effort */
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: "failed",
      claudeJsonPath: targetPath,
      mcpEntryPath: "",
      error: `could not write ${targetPath}: ${msg}`,
    };
  }

  return {
    outcome: keyExisted ? "updated" : "registered",
    claudeJsonPath: targetPath,
    mcpEntryPath: "",
  };
}

/**
 * Upsert the `igris-brain` entry in `~/.claude.json`, pointing at the
 * bundled MCP. Idempotent. NEVER throws — returns `outcome: 'failed'` with
 * an `error` string so callers can warn-and-continue.
 *
 * FR-162: this is now a THIN WRAPPER over the generalized `mergeJsonConfig`.
 * It passes the SAME hard-coded values the old monolithic body used
 * (`mapKey:"mcpServers"`, `entryKey:"igris-brain"`, `backup:true`) and
 * re-stamps the Claude-specific result fields (`claudeJsonPath`/`mcpEntryPath`)
 * the existing 30-case test suite asserts — so the behavior is byte-identical.
 *
 * @param opts.mcpEntryPath  Override the bundled MCP path. The `--dev`
 *                           flag (registers a clone path) and tests use
 *                           this. Defaults to `bundledMcpEntryPath()`.
 * @param opts.claudeJsonPath  Override `~/.claude.json` location. Tests
 *                             sandbox HOME and use this. Defaults to
 *                             `claudeJsonPath()`.
 */
export function registerMcpInClaudeJson(opts?: {
  mcpEntryPath?: string;
  claudeJsonPath?: string;
}): McpRegisterResult {
  const targetPath = opts?.claudeJsonPath ?? claudeJsonPath();
  const mcpEntryPath = opts?.mcpEntryPath ?? bundledMcpEntryPath();
  const result = mergeJsonConfig({
    targetPath,
    mapKey: "mcpServers",
    entryKey: MCP_KEY,
    entry: buildDesiredEntry(mcpEntryPath) as unknown as Record<string, unknown>,
    backup: true,
  });
  // Re-stamp the Claude-specific result fields the existing suite asserts.
  return { ...result, claudeJsonPath: targetPath, mcpEntryPath };
}

export interface McpInspectResult {
  /** True when `mcpServers["igris-brain"]` is present and well-formed. */
  registered: boolean;
  /** True when the registered entry's args[0] path exists on disk. */
  pathExists: boolean;
  /** The registered entry's resolved path, or null when not registered. */
  entryPath: string | null;
}

/**
 * Read `~/.claude.json` and report whether `igris-brain` is registered AND
 * points at an existing file. Used by `igris doctor` to surface the
 * `mcp-unregistered` drift class. Never throws — a missing or malformed
 * file is reported as `{ registered: false, pathExists: false }`.
 */
export function inspectMcpRegistration(opts?: {
  claudeJsonPath?: string;
}): McpInspectResult {
  const targetPath = opts?.claudeJsonPath ?? claudeJsonPath();
  const notRegistered: McpInspectResult = {
    registered: false,
    pathExists: false,
    entryPath: null,
  };

  if (!existsSync(targetPath)) return notRegistered;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(targetPath, "utf-8"));
  } catch {
    return notRegistered;
  }
  if (!isPlainObject(parsed)) return notRegistered;

  const servers = parsed.mcpServers;
  if (!isPlainObject(servers)) return notRegistered;

  const entry = servers[MCP_KEY];
  if (!isPlainObject(entry)) return notRegistered;

  const args = entry.args;
  const entryPath =
    Array.isArray(args) && typeof args[0] === "string" ? args[0] : null;
  if (entryPath === null) {
    // Registered but malformed (no resolvable path) — treat as registered
    // with a missing path so doctor flags it.
    return { registered: true, pathExists: false, entryPath: null };
  }

  return {
    registered: true,
    pathExists: existsSync(entryPath),
    entryPath,
  };
}

/** Internal constants exposed for the unit-test suite. */
export const __testing__ = { MCP_KEY, BACKUP_SUFFIX };
