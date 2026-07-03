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
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import * as TOML from "@iarna/toml"; // FR-163: PARSE-ONLY (idempotency + malformed gate); never re-emit.
import { bundledMcpEntryPath, claudeJsonPath } from "./paths.js";
// FR-169: reuse the FR-164 pure per-harness shaper + canonical type. mcp-shape.ts
// imports TomlMcpEntry FROM this module, but McpShapeCanonical/McpHarness/
// buildHarnessMcpEntry live there — importing them back is a type-only + value
// import with no runtime cycle (the value `buildHarnessMcpEntry` does not call
// back into mcp-register at module-load time).
import {
  buildHarnessMcpEntry,
  type McpHarness,
  type McpShapeCanonical,
} from "./mcp-shape.js";
// FR-212b: the MCP-registration DELEGATE (add-mcp shell-out) + the Igris-owned
// no-prompt GRANT. Both are flag-gated behind `IGRIS_MCP_ENGINE=delegate`
// (default `custom` → the FR-162/163/164 mergers below, UNCHANGED). The
// delegate writes the per-harness SERVER ENTRY; the grant writes the no-prompt
// trust. Igris keeps canonical ownership: `brainCanonical` (command/args/env)
// is built HERE and handed to the delegate as a spec — add-mcp only serializes.
import {
  resolveMcpEngine,
  registerMcpViaTool,
  unregisterMcpViaTool,
  type McpEngine,
  type McpToolResult,
} from "./mcp-delegate.js";
import {
  writeBrainGrant,
  removeBrainGrant,
  type GrantResult,
} from "./mcp-grant.js";
// TD-221: these four harness configs are secret-bearing — `renameSync(tmp,
// target)` below adopts the tmp file's umask-default mode (typically 644),
// re-loosening a previously-600 config on every MCP (re-)registration. Re-harden
// to 600 right after the rename, reusing TD-220's win32-gated, never-throwing
// `chmodSecretFile` (do NOT re-implement the chmod/win32 logic — §18.1). No
// import cycle: secret-perms.ts imports nothing from this module.
import { chmodSecretFile } from "./secret-perms.js";
// FR-217: the canonical harness descriptor reader. mcp-register READS the
// per-harness MCP facts / agent id / harness list from the descriptor; the local
// hardcoded consts were deleted in M5 (one source of truth: the descriptor). The
// MCP emitter SHAPE is selected via the descriptor's entry_shape.
import { harnessIds, agentId, mcpFacts } from "./harness-descriptor.js";

export type { McpHarness } from "./mcp-shape.js";

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
 * FR-163 parse-verify guard helper (Warden review): true when `original` and
 * `candidate` are structurally identical EXCEPT for the target table
 * `<tablePrefix>.<entryKey>` (which the splice is allowed to add/replace). We
 * shallow-clone both parsed roots, delete the target entry from each `tablePrefix`
 * map (dropping the `tablePrefix` map entirely when it becomes empty so an
 * original with no `mcp_servers` and a candidate with only the new entry compare
 * equal), then deep-equal the remainders. Any collateral change to a sibling
 * table, a top-level key, or a comment-bearing structural element trips this.
 */
function othersUnchanged(
  original: Record<string, unknown>,
  candidate: Record<string, unknown>,
  tablePrefix: string,
  entryKey: string,
): boolean {
  const strip = (root: Record<string, unknown>): Record<string, unknown> => {
    const clone: Record<string, unknown> = { ...root };
    const prefixMap = clone[tablePrefix];
    if (isPlainObject(prefixMap)) {
      const mapClone: Record<string, unknown> = { ...prefixMap };
      delete mapClone[entryKey];
      if (Object.keys(mapClone).length === 0) {
        delete clone[tablePrefix];
      } else {
        clone[tablePrefix] = mapClone;
      }
    }
    return clone;
  };
  return entryDeepEquals(strip(original), strip(candidate));
}

/**
 * Detect whether CRLF (`\r\n`) is the DOMINANT line ending of `text` (m1 fix).
 * Returns true only when CRLF endings strictly outnumber bare-LF endings, so a
 * pure-LF file (the common case) and an empty file both stay on `\n`. Used to
 * keep the splice from introducing mixed endings on a Windows-authored file.
 */
function dominantLineEndingIsCrlf(text: string): boolean {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return false;
  const totalLf = (text.match(/\n/g) ?? []).length;
  const bareLf = totalLf - crlf; // LF not preceded by CR
  return crlf > bareLf;
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
    // TD-221: re-harden to 600 — `renameSync` adopted the tmp file's
    // umask-default mode (644), re-loosening a previously-600 config. Placed on
    // the line AFTER the rename, inside this write block, so it is structurally
    // unreachable on the `unchanged`/`failed` early-return paths (runs ONLY on
    // a successful registered/updated write). chmodSecretFile is win32-gated +
    // never-throws (TD-220) — purely additive after a successful rename.
    chmodSecretFile(targetPath);
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

/** The desired shape of a Codex `[mcp_servers.<name>]` entry. */
export interface TomlMcpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  startup_timeout_sec?: number;
}

/** A located table span, as a half-open `[start, end)` LINE index range. */
interface TomlTableSpan {
  /** Line index of the `[mcp_servers.<name>]` header (inclusive). */
  start: number;
  /** Line index ONE PAST the table's last line (exclusive). */
  end: number;
}

/**
 * Escape a TOML bare-string regex segment. Server names are
 * `^[a-z0-9][a-z0-9-]*$` per the FR-160a schema (bare is the normal case)
 * but we escape defensively in case a future caller passes a dotted/quoted key.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Advance the multiline-string tracking state for ONE source line (M2 fix).
 *
 * TOML basic/literal multiline strings are delimited by `"""` and `'''`. A
 * line may OPEN a region (an odd number of unmatched delimiters appears) or
 * CLOSE one, and a `"""..."""` that opens AND closes on the same line is a
 * net no-op. We count delimiter occurrences per line and toggle: while
 * `inMultiline` is set we are between an opening delimiter and its match, so
 * any `[`-at-column-0 line in that window is string CONTENT, never a header.
 *
 * This is a deliberately small scanner — it does not attempt full TOML
 * tokenization (escapes, inline comments, quoted keys with embedded triple
 * quotes). That over-approximation is SAFE here because the parse-verify
 * post-condition guard (the load-bearing net) catches any residual
 * mislocation and converts it to a `failed` rather than a corrupting write.
 *
 * @param line          The current source line (a trailing `\r` is stripped
 *                       internally so CRLF and LF files behave identically).
 * @param inMultiline   The currently-open delimiter, or null when outside.
 * @returns The delimiter still open AFTER this line, or null.
 */
function updateMultilineState(
  line: string,
  inMultiline: '"""' | "'''" | null,
): '"""' | "'''" | null {
  // Strip a trailing CR so CRLF files behave identically to LF files.
  const l = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (inMultiline !== null) {
    // Inside a region: count CLOSING delimiters; each pair (close+reopen) is
    // a no-op, an odd count closes the region.
    const closes = countOccurrences(l, inMultiline);
    if (closes % 2 === 1) return null;
    return inMultiline;
  }
  // Outside: count both delimiter kinds. An odd count of either OPENS a region
  // of that kind. (A line opening BOTH is malformed TOML and would have been
  // rejected by the parse gate; we treat the first odd one as the opener.)
  const dq = countOccurrences(l, '"""');
  const sq = countOccurrences(l, "'''");
  if (dq % 2 === 1) return '"""';
  if (sq % 2 === 1) return "'''";
  return null;
}

/** Count non-overlapping occurrences of `needle` in `s`. */
function countOccurrences(s: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = s.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = s.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Locate the byte span (as a half-open line range) of the
 * `[<tablePrefix>.<entryKey>]` table inside `lines`, INCLUDING any
 * descendant headers (`[<tablePrefix>.<entryKey>.env]`, etc.). Returns
 * `null` when the table is absent (caller appends a fresh block at EOF).
 *
 * Relies on the TOML column-0-header invariant (FR-163 §1): a table header
 * is always the first non-whitespace token on its line, while multi-line
 * array VALUES are indented continuation lines whose close is `]`, never a
 * `[` at column 0 — so a `^\s*\[` scan cannot mistake an array-close for a
 * header. The malformed-safe parse gate runs FIRST so genuinely broken files
 * never reach here.
 */
function locateTomlTableSpan(
  lines: string[],
  tablePrefix: string,
  entryKey: string,
): TomlTableSpan | null {
  const prefix = `${tablePrefix}.${entryKey}`;
  // Header line for the exact target table: `[mcp_servers.<name>]`,
  // tolerating the optional surrounding whitespace TOML allows AND an optional
  // trailing `#` comment (M1 fix — Warden FR-163 review: a header carrying a
  // legal trailing comment like `[mcp_servers.igris-brain] # pinned` was
  // previously rejected by the `$`-anchored regex, falling through to the
  // EOF-append path and writing a DUPLICATE table). `anyHeaderRe` /
  // `isDescendantHeader` already tolerate trailing content — only the target
  // header match was asymmetric. The dotted key segment may be bare OR quoted.
  // (m2: bare keys only in scope — names are `^[a-z0-9][a-z0-9-]*$` per the
  // FR-161 schema — but we keep the quoted alternation defensively.)
  const keyForm = `(?:${escapeRegex(prefix)}|["']${escapeRegex(prefix)}["'])`;
  const headerRe = new RegExp(`^\\s*\\[\\s*${keyForm}\\s*\\](?:\\s*#.*)?\\s*$`);
  // Any column-0 table header (`[table]` or `[[array]]`).
  const anyHeaderRe = /^\s*\[/;

  // M2 fix (Warden FR-163 review): track multiline-string regions while
  // scanning so a `[`-at-column-0 line INSIDE a basic/literal multiline string
  // (`"""..."""` / `'''...'''`) is NOT mistaken for a table header. Such a line
  // is VALID TOML — the malformed-parse gate passes it — but it would mislocate
  // the splice span and corrupt the user's real bytes. `inMultiline` holds the
  // open delimiter (`"""` or `'''`) while inside a region, else null.
  let start = -1;
  let inMultiline: '"""' | "'''" | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inMultiline === null) {
      // Only count a header match when NOT inside a multiline string.
      if (headerRe.test(line)) {
        start = i;
        break;
      }
    }
    inMultiline = updateMultilineState(line, inMultiline);
  }
  if (start === -1) return null;

  // Extend the span across consecutive headers whose dotted path is a
  // DESCENDANT of `<tablePrefix>.<entryKey>.` (the detached `.env` sub-table
  // case); STOP at the first header that is NOT a descendant. The same
  // multiline-string tracking applies — a fake `[...]` inside a string value of
  // the target table (or a following sibling) must NOT be treated as a boundary.
  let end = lines.length;
  inMultiline = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (inMultiline === null) {
      if (anyHeaderRe.test(line) && !isDescendantHeader(line, prefix)) {
        end = i;
        break;
      }
    }
    inMultiline = updateMultilineState(line, inMultiline);
  }
  return { start, end };
}

/**
 * True when `line` is a column-0 table header whose dotted path starts with
 * `<prefix>.` (a descendant sub-table such as `[mcp_servers.<name>.env]`).
 * A non-descendant sibling/unrelated header (`[mcp_servers.other]`,
 * `[marketplaces.x]`, `[[array]]`, quoted-key tables) returns false.
 */
function isDescendantHeader(line: string, prefix: string): boolean {
  const descRe = new RegExp(
    `^\\s*\\[\\s*(?:${escapeRegex(prefix)}\\.|["']${escapeRegex(prefix)}\\.)`,
  );
  return descRe.test(line);
}

/**
 * Render the canonical text for a single `[<tablePrefix>.<entryKey>]` table
 * (+ a detached `[<tablePrefix>.<entryKey>.env]` sub-table when env is
 * present). This is the ONLY text the splice ever produces — a tiny, fully
 * controlled emitter, NOT a whole-file `TOML.stringify`. String values are
 * escaped via `JSON.stringify` (TOML basic-string escaping is JSON-compatible
 * for the ASCII paths/`${VAR}` refs in scope here).
 */
function renderMcpTomlTable(
  tablePrefix: string,
  entryKey: string,
  entry: TomlMcpEntry,
): string {
  const head = `${tablePrefix}.${entryKey}`;
  const lines: string[] = [`[${head}]`];
  lines.push(`command = ${JSON.stringify(entry.command)}`);
  const args = entry.args ?? [];
  lines.push(`args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`);
  if (entry.startup_timeout_sec !== undefined) {
    lines.push(`startup_timeout_sec = ${entry.startup_timeout_sec}`);
  }
  const env = entry.env;
  if (env && Object.keys(env).length > 0) {
    lines.push("");
    lines.push(`[${head}.env]`);
    for (const k of Object.keys(env)) {
      lines.push(`${k} = ${JSON.stringify(env[k])}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * FR-163 (FR-160 epic): the TOML sibling of `mergeJsonConfig`. Upserts a
 * single `[<tablePrefix>.<entryKey>]` table (+ a
 * `[<tablePrefix>.<entryKey>.env]` sub-table when `entry.env` is present) in a
 * TOML config FILE, via a TABLE-SCOPED STRING SPLICE that leaves every other
 * byte of the file — comments, sibling tables, top-level keys, key ordering —
 * physically untouched. `@iarna/toml` is used PARSE-ONLY (for the malformed-
 * safe gate + the structural idempotency compare); the file is NEVER re-emitted
 * wholesale.
 *
 * Reuses the `McpRegisterResult` outcome union VERBATIM (no new union). For
 * this generic TOML call the `claudeJsonPath` result field carries
 * `targetPath` and `mcpEntryPath` is `""`.
 *
 * Contract (identical 6 steps to `mergeJsonConfig`):
 *   1. malformed TOML → 'failed', never write/backup/leave-tmp;
 *   2. all other tables/keys preserved byte-for-byte (splice, not re-emit);
 *   3. structural deep-equal existing → 'unchanged' (NOT byte-equal — key
 *      order and formatting may differ);
 *   4. single rolling `<path>.igris.bak` + atomic `.tmp.<pid>.<ts>` +
 *      `renameSync`;
 *   5. non-table `<tablePrefix>` OR non-table `<tablePrefix>[entryKey]` →
 *      'failed';
 *   6. never throws.
 *
 * @param opts.targetPath   The TOML config FILE to upsert into (`~/.codex/config.toml`).
 * @param opts.tablePrefix  The table family (`"mcp_servers"`).
 * @param opts.entryKey     The server name to upsert (e.g. `"igris-brain"`).
 * @param opts.entry        The Codex entry SHAPE (command/args/env/timeout).
 * @param opts.backup       Single rolling `<path>.igris.bak`. Defaults to true.
 * @param opts.__renderOverride  TEST-ONLY seam (FR-163 guard tests). When set,
 *   supplies the rendered replacement text instead of `renderMcpTomlTable`,
 *   letting a test inject a deliberately mislocated/divergent splice candidate
 *   to PROVE the parse-verify post-condition guard returns `failed` (not a
 *   corrupting write). Never set in production call sites.
 */
export function mergeTomlConfig(opts: {
  targetPath: string;
  tablePrefix: string;
  entryKey: string;
  entry: TomlMcpEntry;
  backup?: boolean;
  __renderOverride?: (
    tablePrefix: string,
    entryKey: string,
    entry: TomlMcpEntry,
  ) => string;
}): McpRegisterResult {
  const { targetPath, tablePrefix, entryKey, entry } = opts;
  const backup = opts.backup ?? true;
  const render = opts.__renderOverride ?? renderMcpTomlTable;

  const fail = (error: string): McpRegisterResult => ({
    outcome: "failed",
    claudeJsonPath: targetPath,
    mcpEntryPath: "",
    error,
  });

  // --- 1. Read ---------------------------------------------------------
  const fileExisted = existsSync(targetPath);
  let rawBytes: Buffer | null = null;
  if (fileExisted) {
    try {
      rawBytes = readFileSync(targetPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`could not read ${targetPath}: ${msg}`);
    }
  }
  const existingText = rawBytes === null ? "" : rawBytes.toString("utf-8");

  // --- 2. Parse for the malformed-safe gate (do NOT clobber) -----------
  // PARSE-ONLY: used for malformed-detection + the idempotency compare. The
  // file is NEVER re-emitted from this parsed root.
  let parsed: TOML.JsonMap;
  if (rawBytes === null) {
    parsed = {};
  } else {
    try {
      parsed = TOML.parse(existingText);
    } catch {
      return fail(
        `malformed ${targetPath} — refusing to write; fix or remove the file manually`,
      );
    }
  }

  // --- 3. Refuse-to-write on a non-table conflict ----------------------
  const existingPrefix = parsed[tablePrefix];
  if (existingPrefix !== undefined && !isPlainObject(existingPrefix)) {
    return fail(
      `${targetPath} has a non-table '${tablePrefix}' — refusing to write; fix or remove the file manually`,
    );
  }
  const existingTable = isPlainObject(existingPrefix)
    ? existingPrefix[entryKey]
    : undefined;
  const keyExisted = existingTable !== undefined;
  if (keyExisted && !isPlainObject(existingTable)) {
    return fail(
      `${targetPath} has a non-table '${tablePrefix}.${entryKey}' — refusing to write; fix or remove the file manually`,
    );
  }

  // --- 4. Idempotency — structural deep-equal (NOT byte-equal) ---------
  // Compare the existing parsed table against a parse of the would-be-new
  // entry text, so key-order/formatting differences never force a rewrite.
  const replacement = render(tablePrefix, entryKey, entry);
  let desiredTable: unknown;
  try {
    const desiredParsed = TOML.parse(replacement);
    const desiredPrefix = desiredParsed[tablePrefix];
    desiredTable = isPlainObject(desiredPrefix)
      ? desiredPrefix[entryKey]
      : undefined;
  } catch {
    // Our own emitter produced unparseable TOML — should never happen; treat
    // defensively as a write failure rather than a silent no-op.
    return fail(`internal error: rendered TOML for '${entryKey}' did not parse`);
  }
  if (keyExisted && entryDeepEquals(existingTable, desiredTable)) {
    return {
      outcome: "unchanged",
      claudeJsonPath: targetPath,
      mcpEntryPath: "",
    };
  }

  // --- 5. Splice the target table's text span (never re-emit) ----------
  // m1 fix (Warden FR-163 review): preserve the file's DOMINANT line ending.
  // `split("\n")`/`join("\n")` would normalize only the replaced region and
  // leave a CRLF file with mixed endings. We detect whether CRLF dominates and
  // splice on that delimiter so untouched lines keep their original bytes and
  // the rendered region matches. (@iarna parses mixed endings either way — this
  // is correctness/cleanliness, not a parse fix.)
  const useCrlf = dominantLineEndingIsCrlf(existingText);
  const eol = useCrlf ? "\r\n" : "\n";
  let serialized: string;
  if (rawBytes === null || existingText.length === 0) {
    // Fresh / empty file — the rendered table(s) are the whole content.
    serialized = replacement;
  } else {
    // Split on the detected EOL so each element is a clean line (no trailing
    // `\r` when CRLF). The rendered `replacement` uses `\n`; re-join everything
    // with the detected `eol` so the spliced output is uniform.
    const lines = existingText.split(eol);
    const span = locateTomlTableSpan(lines, tablePrefix, entryKey);
    if (span === null) {
      // Table absent — append a fresh block at EOF, separated by a blank
      // line, leaving the entire existing file untouched above it. Re-join on
      // the detected EOL to preserve CRLF on a Windows file.
      const trimmedEnd = existingText.replace(/(\r?\n)+$/, "");
      const replacementLines = replacement.replace(/\n$/, "").split("\n");
      serialized = [...trimmedEnd.split(eol), "", ...replacementLines].join(eol);
    } else {
      // Replace ONLY the located span; before/after are untouched lines.
      const before = lines.slice(0, span.start);
      const after = lines.slice(span.end);
      // `replacement` ends in a trailing "\n"; split it so the join keeps
      // surrounding lines aligned without doubling the newline.
      const replacementLines = replacement.replace(/\n$/, "").split("\n");
      serialized = [...before, ...replacementLines, ...after].join(eol);
    }
  }

  // --- 5b. PARSE-VERIFY POST-CONDITION GUARD (the load-bearing safety net) --
  // Warden FR-163 review (M1/M2): the splice can mislocate the target span on
  // shapes the malformed-parse gate cannot catch (well-formed TOML with a fake
  // `[...]` header inside a multiline string, a commented target header, or any
  // future unanticipated shape). The M1/M2 targeted fixes above make the COMMON
  // shapes WORK; this guard makes the no-clobber promise actually TRUE for the
  // rest — it converts EVERY residual span-mislocation into a safe `failed`
  // instead of writing corrupt bytes over the user's hot config.
  //
  // We re-parse the candidate string (still PARSE-ONLY — no TOML.stringify) and
  // assert: (a) it parses; (b) the target entry deep-equals what we intended;
  // (c) every OTHER top-level key/table is structurally unchanged vs the
  // ORIGINAL parsed file. On ANY mismatch → `fail(...)`, NO write.
  let candidateParsed: TOML.JsonMap;
  try {
    candidateParsed = TOML.parse(serialized);
  } catch {
    return fail(
      `splice verification failed (candidate did not parse) — refusing to write to avoid corrupting ${targetPath}`,
    );
  }
  // (b) the target entry must deep-equal the intended table.
  const candidatePrefix = candidateParsed[tablePrefix];
  const candidateTable = isPlainObject(candidatePrefix)
    ? candidatePrefix[entryKey]
    : undefined;
  if (!entryDeepEquals(candidateTable, desiredTable)) {
    return fail(
      `splice verification failed (target table mismatch) — refusing to write to avoid corrupting ${targetPath}`,
    );
  }
  // (c) every OTHER top-level key/table unchanged vs the original parse.
  // Compare the two parsed objects with the target entry removed from BOTH.
  if (!othersUnchanged(parsed, candidateParsed, tablePrefix, entryKey)) {
    return fail(
      `splice verification failed (collateral change to other tables) — refusing to write to avoid corrupting ${targetPath}`,
    );
  }

  // --- 6. Backup-then-atomic-write -------------------------------------
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    if (backup && fileExisted && rawBytes !== null) {
      // Single rolling backup — overwrite any prior `.igris.bak`.
      writeFileSync(`${targetPath}${BACKUP_SUFFIX}`, rawBytes);
    }
    writeFileSync(tmpPath, serialized);
    renameSync(tmpPath, targetPath);
    // TD-221: re-harden to 600 — `renameSync` adopted the tmp file's
    // umask-default mode (644), re-loosening a previously-600 config. Placed on
    // the line AFTER the rename, inside this write block, so it is structurally
    // unreachable on the `unchanged`/`failed` early-return paths (runs ONLY on
    // a successful registered/updated write). chmodSecretFile is win32-gated +
    // never-throws (TD-220) — purely additive after a successful rename.
    chmodSecretFile(targetPath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore — cleanup is best-effort */
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`could not write ${targetPath}: ${msg}`);
  }

  return {
    outcome: keyExisted ? "updated" : "registered",
    claudeJsonPath: targetPath,
    mcpEntryPath: "",
  };
}

// ---------------------------------------------------------------------------
// FR-203: the INVERSES of mergeJsonConfig / mergeTomlConfig — un-merge a single
// named entry from a harness config, preserving every OTHER entry + top-level
// key byte-for-byte (the no-clobber posture of the mergers, run in reverse).
// `igris remove mcp` calls these to un-project an MCP block; the same 6-step
// contract (malformed-never-clobber, idempotent, atomic temp+rename, single
// rolling backup, never-throws) applies. An ABSENT entry is `unchanged` (a
// no-op un-merge is success — removing a thing that is already gone is idempotent,
// the symmetric flip of the merger's "already present + equal" idempotency).
// ---------------------------------------------------------------------------

/**
 * FR-203: delete one named `entryKey` from a `mapKey` map in a JSON config FILE.
 * The exact inverse of {@link mergeJsonConfig} — preserves every OTHER entry +
 * top-level key, refuses to clobber a malformed/non-object file, idempotent
 * (absent entry → `unchanged`, NO write), atomic temp+rename + single rolling
 * backup, never throws. Reuses the `McpRegisterResult` union verbatim:
 * `updated` = the key was present and removed; `unchanged` = the key (or the
 * whole map) was already absent.
 *
 * @param opts.targetPath  The JSON config FILE to un-merge from.
 * @param opts.mapKey      The top-level map key (`"mcpServers"` | `"mcp"`).
 * @param opts.entryKey    The server name to delete under `mapKey`.
 * @param opts.backup      Single rolling `<path>.igris.bak`. Defaults to true.
 */
export function unmergeJsonConfig(opts: {
  targetPath: string;
  mapKey: string;
  entryKey: string;
  backup?: boolean;
}): McpRegisterResult {
  const { targetPath, mapKey, entryKey } = opts;
  const backup = opts.backup ?? true;

  const fail = (error: string): McpRegisterResult => ({
    outcome: "failed",
    claudeJsonPath: targetPath,
    mcpEntryPath: "",
    error,
  });

  // --- 1. Read — an absent file is an idempotent no-op (nothing to remove). --
  if (!existsSync(targetPath)) {
    return { outcome: "unchanged", claudeJsonPath: targetPath, mcpEntryPath: "" };
  }
  let rawBytes: Buffer;
  try {
    rawBytes = readFileSync(targetPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`could not read ${targetPath}: ${msg}`);
  }

  // --- 2. Parse — fail loud on malformed JSON (do NOT clobber) --------------
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBytes.toString("utf-8"));
  } catch {
    return fail(
      `malformed ${targetPath} — refusing to write; fix or remove the file manually`,
    );
  }
  if (!isPlainObject(parsed)) {
    return fail(
      `${targetPath} is not a JSON object — refusing to write; fix or remove the file manually`,
    );
  }
  const root = parsed;

  // --- 3. Locate the mapKey map. An absent/empty map → nothing to remove. ---
  const existingMap = root[mapKey];
  if (existingMap === undefined) {
    return { outcome: "unchanged", claudeJsonPath: targetPath, mcpEntryPath: "" };
  }
  if (!isPlainObject(existingMap)) {
    return fail(
      `${targetPath} has a non-object '${mapKey}' — refusing to write; fix or remove the file manually`,
    );
  }
  if (!(entryKey in existingMap)) {
    // The entry is already gone — an idempotent no-op (the symmetric flip of the
    // merger's "already present + equal → unchanged").
    return { outcome: "unchanged", claudeJsonPath: targetPath, mcpEntryPath: "" };
  }

  // --- 4. Delete the entry; drop the map entirely when it becomes empty so a
  // round-trip add→remove byte-restores a file that had no `mapKey` before. ---
  const serverMap = { ...existingMap };
  delete serverMap[entryKey];
  if (Object.keys(serverMap).length === 0) {
    delete root[mapKey];
  } else {
    root[mapKey] = serverMap;
  }

  // --- 5. Backup-then-atomic-write. -----------------------------------------
  const serialized = JSON.stringify(root, null, 2) + "\n";
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    if (backup) {
      writeFileSync(`${targetPath}${BACKUP_SUFFIX}`, rawBytes);
    }
    writeFileSync(tmpPath, serialized);
    renameSync(tmpPath, targetPath);
    chmodSecretFile(targetPath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore — cleanup is best-effort */
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`could not write ${targetPath}: ${msg}`);
  }

  return { outcome: "updated", claudeJsonPath: targetPath, mcpEntryPath: "" };
}

/**
 * FR-203: the TOML sibling of {@link unmergeJsonConfig} — delete a single
 * `[<tablePrefix>.<entryKey>]` table (+ any `[<tablePrefix>.<entryKey>.env]`
 * descendant) from a TOML config FILE via the SAME table-scoped STRING SPLICE
 * the merger uses (reusing `locateTomlTableSpan`), so every other byte —
 * comments, sibling tables, top-level keys — stays physically untouched.
 * `@iarna/toml` is PARSE-ONLY (malformed gate + the post-condition guard). The
 * exact inverse of {@link mergeTomlConfig}: idempotent (absent table →
 * `unchanged`), atomic, single rolling backup, never throws.
 *
 * @param opts.targetPath   The TOML config FILE (`~/.codex/config.toml`).
 * @param opts.tablePrefix  The table family (`"mcp_servers"`).
 * @param opts.entryKey     The server name to delete.
 * @param opts.backup       Single rolling `<path>.igris.bak`. Defaults to true.
 */
export function unmergeTomlConfig(opts: {
  targetPath: string;
  tablePrefix: string;
  entryKey: string;
  backup?: boolean;
}): McpRegisterResult {
  const { targetPath, tablePrefix, entryKey } = opts;
  const backup = opts.backup ?? true;

  const fail = (error: string): McpRegisterResult => ({
    outcome: "failed",
    claudeJsonPath: targetPath,
    mcpEntryPath: "",
    error,
  });

  // --- 1. Read — absent file is an idempotent no-op. ------------------------
  if (!existsSync(targetPath)) {
    return { outcome: "unchanged", claudeJsonPath: targetPath, mcpEntryPath: "" };
  }
  let rawBytes: Buffer;
  try {
    rawBytes = readFileSync(targetPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`could not read ${targetPath}: ${msg}`);
  }
  const existingText = rawBytes.toString("utf-8");

  // --- 2. Parse for the malformed-safe gate (do NOT clobber). ---------------
  let parsed: TOML.JsonMap;
  try {
    parsed = TOML.parse(existingText);
  } catch {
    return fail(
      `malformed ${targetPath} — refusing to write; fix or remove the file manually`,
    );
  }

  // --- 3. Refuse-to-write on a non-table conflict + detect absence. ---------
  const existingPrefix = parsed[tablePrefix];
  if (existingPrefix !== undefined && !isPlainObject(existingPrefix)) {
    return fail(
      `${targetPath} has a non-table '${tablePrefix}' — refusing to write; fix or remove the file manually`,
    );
  }
  const existingTable = isPlainObject(existingPrefix)
    ? existingPrefix[entryKey]
    : undefined;
  if (existingTable === undefined) {
    // Already absent — idempotent no-op.
    return { outcome: "unchanged", claudeJsonPath: targetPath, mcpEntryPath: "" };
  }

  // --- 4. Splice the located span OUT (never re-emit). ----------------------
  const useCrlf = dominantLineEndingIsCrlf(existingText);
  const eol = useCrlf ? "\r\n" : "\n";
  const lines = existingText.split(eol);
  const span = locateTomlTableSpan(lines, tablePrefix, entryKey);
  if (span === null) {
    // The parse found the table but the textual locator did not — refuse rather
    // than guess (the merger's same belt-and-suspenders posture).
    return fail(
      `could not locate the '[${tablePrefix}.${entryKey}]' table text in ${targetPath} — refusing to write`,
    );
  }
  // Drop the span. Also drop a single trailing blank line the table left behind
  // (so a round-trip add→remove does not accumulate blank lines), then re-trim a
  // doubled blank at the seam.
  const before = lines.slice(0, span.start);
  const after = lines.slice(span.end);
  // Collapse a blank line immediately before the removed span that now abuts the
  // following content (keeps the seam clean without touching unrelated blanks).
  while (before.length > 0 && before[before.length - 1].trim() === "" &&
         after.length > 0 && after[0].trim() === "") {
    before.pop();
  }
  let serialized = [...before, ...after].join(eol);
  // Normalize trailing whitespace to a single terminating newline when there is
  // content; an entirely-emptied file becomes empty.
  serialized = serialized.replace(/(\r?\n)+$/, "");
  if (serialized.length > 0) {
    serialized += eol;
  }

  // --- 4b. PARSE-VERIFY POST-CONDITION GUARD (the load-bearing safety net). --
  // Re-parse the candidate (PARSE-ONLY) and assert: (a) it parses; (b) the
  // target table is GONE; (c) every OTHER top-level key/table is unchanged.
  let candidateParsed: TOML.JsonMap;
  try {
    candidateParsed = TOML.parse(serialized);
  } catch {
    return fail(
      `splice verification failed (candidate did not parse) — refusing to write to avoid corrupting ${targetPath}`,
    );
  }
  const candidatePrefix = candidateParsed[tablePrefix];
  const candidateTable = isPlainObject(candidatePrefix)
    ? candidatePrefix[entryKey]
    : undefined;
  if (candidateTable !== undefined) {
    return fail(
      `splice verification failed (target table still present) — refusing to write to avoid corrupting ${targetPath}`,
    );
  }
  if (!othersUnchanged(parsed, candidateParsed, tablePrefix, entryKey)) {
    return fail(
      `splice verification failed (collateral change to other tables) — refusing to write to avoid corrupting ${targetPath}`,
    );
  }

  // --- 5. Backup-then-atomic-write. -----------------------------------------
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    if (backup) {
      writeFileSync(`${targetPath}${BACKUP_SUFFIX}`, rawBytes);
    }
    writeFileSync(tmpPath, serialized);
    renameSync(tmpPath, targetPath);
    chmodSecretFile(targetPath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore — cleanup is best-effort */
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`could not write ${targetPath}: ${msg}`);
  }

  return { outcome: "updated", claudeJsonPath: targetPath, mcpEntryPath: "" };
}

// ---------------------------------------------------------------------------
// FR-169: register the bundled igris-brain MCP into all Igris harnesses at init.
//
// igris-brain is a CORE OS default (L-504) — every install gets it in every
// supported harness, not a personal add. This is Option A (direct in-process
// projection): build an in-memory canonical, shape it per-harness via the
// FR-164 pure `buildHarnessMcpEntry`, and dispatch to the proven FR-162/163
// mergers. NO overlay write, NO manifest read, NO subprocess. The path is
// `bundledMcpEntryPath()` (per-machine, gitignored configs only — never a
// committed file). See FR-169 plan §"THE DESIGN FORK — RESOLVED: Option A".
// ---------------------------------------------------------------------------

/** The env-free canonical launch spec for igris-brain (L-588: no secrets). */
function brainCanonical(mcpEntryPath: string): McpShapeCanonical {
  return { command: "node", args: [mcpEntryPath], env: {} };
}

// FR-217: the per-harness MCP config table, the harness ordering, and the
// shape→agent-id map were consolidated into the canonical descriptor in M5 —
// read via mcpFacts() / harnessIds() / agentId() (harness-descriptor.ts). One
// source of truth; no consumer re-derives a harness list here.

/** Per-harness registration outcome for the multi-harness wire-up. */
export interface BrainHarnessResult {
  harness: McpHarness; // "claude" | "gemini" | "codex" | "opencode" | "antigravity" | "cursor"
  result: McpRegisterResult; // reuses the existing union verbatim
  /** Reserved: true when a harness was not targeted / skipped by choice. */
  skipped?: boolean;
  /**
   * FR-212b: which engine produced this harness's registration —
   * `"custom"` (the FR-162/163/164 mergers, default) or `"delegate"` (the
   * add-mcp shell-out). Absent on the custom path keeps the existing 30-case
   * suite assertions (which never read this field) byte-stable.
   */
  engine?: McpEngine;
  /** FR-212b (delegate only): the Igris-owned no-prompt grant outcome. */
  grant?: GrantResult;
}

/**
 * FR-212b: injectable seams for the DELEGATE path (tests SPY these; never spawn
 * the real add-mcp or touch a real config). All optional — absent = the real
 * resolvers/writers. The `engine` override bypasses the `IGRIS_MCP_ENGINE` read
 * (so a test can force `delegate` without mutating process.env).
 */
export interface BrainRegisterDeps {
  /** Force the engine (default: `resolveMcpEngine()` reading IGRIS_MCP_ENGINE). */
  engine?: McpEngine;
  /** Override the add-mcp registration fn (delegate path). */
  registerViaToolFn?: typeof registerMcpViaTool;
  /** Override the grant writer (delegate path). */
  writeGrantFn?: typeof writeBrainGrant;
}

/**
 * Register the bundled igris-brain MCP into ALL (or a subset of) the Igris
 * harness configs, reusing `buildHarnessMcpEntry` + `mergeJsonConfig`/`mergeTomlConfig`.
 * NEVER throws. The path is `bundledMcpEntryPath()` unless overridden
 * (`--dev`/tests). igris-brain is env-free (L-588) so secrets are never needed
 * (codex env = {}).
 *
 * Each harness's parent dir is benign-created (`mkdirSync … {recursive:true}`)
 * before dispatch so a registered-but-not-yet-initialized harness still gets a
 * config (FR-169 plan risk row "Absent harness config dir"). A failure on one
 * harness folds into `outcome:"failed"` for THAT harness's result only — the
 * other harnesses still wire (the function returns an array; init/doctor
 * warn-and-continue per harness).
 *
 * @param opts.mcpEntryPath  Override the bundled path (`--dev` clone / tests).
 *                           Defaults to `bundledMcpEntryPath()`.
 * @param opts.harnesses     Subset to target. Defaults to all 5.
 * @param opts.configPaths   Per-harness config-path overrides (test sandbox seam).
 * @param opts.folder        FR-212c: the FOLDER to trust for the folder-scoped
 *                           grants (codex `[projects."<folder>"]` + gemini-cli
 *                           `trustedFolders.json`). In the global model a project
 *                           registration must trust the REGISTERED project root,
 *                           NOT the installer's `process.cwd()`. Threaded down to
 *                           `writeBrainGrant`'s `folder`. Absent = `process.cwd()`
 *                           (the grant default — init-time behaviour unchanged).
 * @param deps               FR-212b: delegate-path seams (engine override +
 *                           spied add-mcp/grant fns). Absent = the custom engine
 *                           default + real resolvers.
 */
export function registerBrainAcrossHarnesses(
  opts?: {
    mcpEntryPath?: string;
    harnesses?: McpHarness[];
    configPaths?: Partial<Record<McpHarness, string>>;
    folder?: string;
  },
  deps?: BrainRegisterDeps,
): BrainHarnessResult[] {
  const mcpEntryPath = opts?.mcpEntryPath ?? bundledMcpEntryPath();
  const harnesses = opts?.harnesses ?? harnessIds();
  const canonical = brainCanonical(mcpEntryPath);
  // FR-212b: resolve the engine ONCE. Default `custom` (prod-unchanged); only
  // IGRIS_MCP_ENGINE=delegate (or an explicit deps.engine override) opts in.
  const engine = deps?.engine ?? resolveMcpEngine();

  const results: BrainHarnessResult[] = [];
  for (const harness of harnesses) {
    // FR-217: per-harness MCP facts READ from the canonical descriptor via
    // mcpFacts(); the { path():.. } cfg shape is preserved so the helper
    // signatures below are unchanged.
    const facts = mcpFacts(harness);
    const cfg = {
      path: () => facts.configPath,
      mapKey: facts.mapKey,
      isToml: facts.format === "toml",
    };
    const targetPath = opts?.configPaths?.[harness] ?? cfg.path();

    // FR-212b: DELEGATE ENGINE. add-mcp writes the per-harness SERVER ENTRY;
    // then Igris writes the no-prompt GRANT (mcp-grant.ts). NO custom-merger
    // fallback inside this branch (constraint #2): a tool FAIL is an observable
    // `failed` result, never a silent fall-through to the mergers below.
    //
    // FR-212d ANTIGRAVITY CARVE-OUT (the second smoke-gate blocker): add-mcp
    // writes antigravity's entry to `~/.gemini/antigravity/mcp_config.json`, but
    // antigravity reads MCP EXCLUSIVELY from `~/.gemini/config/mcp_config.json`
    // (FR-179 R1 — live-verified 2026-06-26: the operator's real machine has its
    // antigravity MCP config at the `config/` path, and the `antigravity/` path
    // does not exist). add-mcp's path is genuinely wrong FOR OUR antigravity, so
    // routing antigravity through add-mcp would place the brain where antigravity
    // never looks. This is a tool-fundamental mismatch (no add-mcp flag retargets
    // the per-agent config path), so antigravity's ENTRY stays CUSTOM (the proven
    // FR-179 merger writes the correct `config/` path) even under the delegate
    // engine; the other 4 harnesses delegate to add-mcp. The Igris-owned grant
    // (a separate concern — antigravity's wildcard in `antigravity-cli/
    // settings.json`) is written identically below for parity with the delegate
    // path. NOT a fallback-on-failure (constraint #2): it is a deterministic,
    // per-harness routing decision made BEFORE any tool call.
    if (engine === "delegate" && harness !== "antigravity") {
      results.push(
        registerOneViaDelegate(harness, canonical, mcpEntryPath, opts, deps),
      );
      continue;
    }

    // --- CUSTOM ENGINE (default) — UNCHANGED from FR-169 ------------------
    // Also the antigravity ENTRY path under the delegate engine (carve-out above).
    const customResult = registerOneViaCustomMerger(
      harness,
      cfg,
      targetPath,
      canonical,
      mcpEntryPath,
    );
    // FR-212d: on the delegate engine the antigravity carve-out must still write
    // the Igris-owned no-prompt grant (the other 4 delegate harnesses get it via
    // registerOneViaDelegate) so the multi-harness grant surface is uniform.
    if (engine === "delegate") {
      const grantFn = deps?.writeGrantFn ?? writeBrainGrant;
      const grant = grantFn(harness, {
        configPaths: opts?.configPaths,
        folder: opts?.folder,
      });
      results.push({ ...customResult, engine: "delegate", grant });
    } else {
      results.push(customResult);
    }
  }
  return results;
}

/**
 * FR-169 custom-engine per-harness registration, extracted (FR-212d) so the
 * antigravity carve-out under the delegate engine can reuse the EXACT proven
 * merger path. Benign-creates the parent dir, shapes the canonical via
 * `buildHarnessMcpEntry`, and dispatches to `mergeTomlConfig` (codex) or
 * `mergeJsonConfig` (the rest). NEVER throws (folds every failure into a
 * per-harness `failed` result). Byte-identical to the FR-169 inline body — the
 * 30-case suite asserting the custom path is unaffected.
 */
function registerOneViaCustomMerger(
  harness: McpHarness,
  cfg: { path: () => string; mapKey: string; isToml: boolean },
  targetPath: string,
  canonical: McpShapeCanonical,
  mcpEntryPath: string,
): BrainHarnessResult {
  // Benign-create the parent dir so a missing ~/.gemini, ~/.codex,
  // ~/.config/opencode etc. does not turn a clean install into a write
  // failure. mkdirSync failure folds into the harness's `failed` result.
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      harness,
      result: {
        outcome: "failed",
        claudeJsonPath: targetPath,
        mcpEntryPath,
        error: `could not create parent dir for ${targetPath}: ${msg}`,
      },
    };
  }

  // igris-brain is env-free → no secrets needed for any harness (incl. codex).
  // FR-217 M2: the emitter SHAPE is selected via the descriptor's entry_shape
  // (antigravity → gemini; others identity). The buildHarnessMcpEntry switch is
  // KEPT intact (intrinsic emitter); only the selection reads the descriptor.
  const { entry } = buildHarnessMcpEntry(
    canonical,
    mcpFacts(harness).entryShape,
    undefined,
    undefined,
  );

  const result = cfg.isToml
    ? mergeTomlConfig({
        targetPath,
        tablePrefix: cfg.mapKey,
        entryKey: MCP_KEY,
        entry: entry as TomlMcpEntry,
        backup: true,
      })
    : mergeJsonConfig({
        targetPath,
        mapKey: cfg.mapKey,
        entryKey: MCP_KEY,
        entry: entry as Record<string, unknown>,
        backup: true,
      });

  // Re-stamp `mcpEntryPath` so each per-harness result carries the resolved
  // bundled path (the generic mergers set `mcpEntryPath:""`). `claudeJsonPath`
  // already carries the per-harness targetPath from the merger.
  return { harness, result: { ...result, mcpEntryPath } };
}

/**
 * FR-212b: register ONE harness via the add-mcp delegate, then write its
 * no-prompt grant. Igris keeps canonical ownership — the launch spec
 * (command/args/env) is built HERE from `canonical` and handed to add-mcp as a
 * spec; add-mcp only serializes it into the harness's native config. The grant
 * is the Igris-owned FR-184 step (NOT a residual after add-mcp). NEVER throws.
 */
function registerOneViaDelegate(
  harness: McpHarness,
  canonical: McpShapeCanonical,
  mcpEntryPath: string,
  opts:
    | {
        configPaths?: Partial<Record<McpHarness, string>>;
        folder?: string;
      }
    | undefined,
  deps: BrainRegisterDeps | undefined,
): BrainHarnessResult {
  const targetPath = opts?.configPaths?.[harness] ?? mcpFacts(harness).configPath;
  const registerFn = deps?.registerViaToolFn ?? registerMcpViaTool;
  const grantFn = deps?.writeGrantFn ?? writeBrainGrant;

  // 1) SERVER ENTRY via add-mcp. The spec is Igris-owned (canonical command/
  // args/env — env is {} for the env-free brain). `harnesses` is the SINGLE
  // mapped add-mcp agent id for this harness (one tool call per harness, so a
  // per-harness failure stays isolated — parity with the custom loop).
  let toolResult: McpToolResult;
  try {
    toolResult = registerFn({
      name: MCP_KEY,
      command: canonical.command,
      args: canonical.args ?? [],
      env: canonical.env ?? {},
      harnesses: [agentId(harness)],
      global: true,
    });
  } catch (err) {
    // A resolution failure (no local binary) is a hard, observable error —
    // never a silent network fetch (constraint #2).
    return {
      harness,
      engine: "delegate",
      result: {
        outcome: "failed",
        claudeJsonPath: targetPath,
        mcpEntryPath,
        error: `add-mcp registration error: ${(err as Error).message}`,
      },
    };
  }
  if (!toolResult.ok) {
    return {
      harness,
      engine: "delegate",
      result: {
        outcome: "failed",
        claudeJsonPath: targetPath,
        mcpEntryPath,
        error:
          `add-mcp registration exited ${toolResult.exitCode}` +
          (toolResult.stderr ? `: ${toolResult.stderr}` : ""),
      },
    };
  }

  // 2) NO-PROMPT GRANT (Igris-owned, FR-184). Written for EVERY harness per the
  // probed grammar; opencode is `covered` (grant lives in agent frontmatter).
  // A grant failure does NOT fail the registration (the server is registered) —
  // it is surfaced in the `grant` field for the caller to warn on, mirroring the
  // per-harness warn-and-continue posture.
  //
  // FR-212c: thread `opts.folder` so the FOLDER-SCOPED grants (codex project-
  // trust + gemini-cli trustedFolders) trust the REGISTERED project root, not
  // the installer's `process.cwd()`. Absent -> writeBrainGrant defaults to
  // process.cwd() (init-time behaviour unchanged). For the JSON-array harnesses
  // (claude/antigravity) `folder` is ignored — their grant is a global wildcard.
  const grant = grantFn(harness, {
    configPaths: opts?.configPaths,
    folder: opts?.folder,
  });

  return {
    harness,
    engine: "delegate",
    result: {
      // The delegate registers/updates idempotently; add-mcp does not report a
      // fine-grained registered/updated/unchanged split, so a clean exit maps to
      // `registered` (the observable "the entry is present" outcome).
      outcome: "registered",
      claudeJsonPath: targetPath,
      mcpEntryPath,
    },
    grant,
  };
}

/** Per-harness un-registration outcome for the multi-harness un-wire. */
export interface BrainUnregisterResult {
  harness: McpHarness;
  /** The entry-removal verdict (reuses the merger `McpRegisterResult` union). */
  result: McpRegisterResult;
  /** The Igris-owned grant-revoke outcome (absent only on a pre-revoke fail). */
  grant?: GrantResult;
}

/** Injectable seams for the DELEGATE un-registration path (tests SPY these). */
export interface BrainUnregisterDeps {
  /** Force the engine (default: `resolveMcpEngine()` reading IGRIS_MCP_ENGINE). */
  engine?: McpEngine;
  /** Override the add-mcp un-registration fn (delegate path). */
  unregisterViaToolFn?: typeof unregisterMcpViaTool;
  /** Override the grant-revoke fn (delegate path). */
  removeGrantFn?: typeof removeBrainGrant;
}

/**
 * FR-212d: the SYMMETRIC INVERSE of `registerBrainAcrossHarnesses` under the
 * DELEGATE engine — un-register the igris-brain MCP entry + REVOKE the no-prompt
 * grant across the targeted harnesses. NEVER throws.
 *
 * THE ANTIGRAVITY CARVE-OUT MUST BE SYMMETRIC (the second smoke-gate blocker's
 * removal half): because antigravity's ENTRY is written by the CUSTOM merger to
 * `~/.gemini/config/mcp_config.json` (add-mcp's `~/.gemini/antigravity/` path is
 * wrong for our antigravity — FR-179 R1), its REMOVAL must ALSO use the custom
 * un-merger `unmergeJsonConfig` at that same correct path. Routing antigravity
 * removal through `add-mcp remove` (which targets the `antigravity/` path) would
 * leave the custom-written entry ORPHANED in `config/`. The other 4 harnesses
 * un-register via `add-mcp remove` (the delegate inverse), exactly as they were
 * registered. This is a deterministic per-harness routing decision (NOT a
 * fallback) — the mirror image of the registration carve-out.
 *
 * On the CUSTOM engine this is a thin wrapper that un-merges every harness via
 * the custom un-mergers (so a `custom`-registered brain un-registers correctly
 * too) — keeping ONE place that knows the brain's per-harness removal shape.
 *
 * @param opts.harnesses    Subset to target. Defaults to all 5.
 * @param opts.configPaths  Per-harness config-path overrides (test sandbox seam).
 * @param opts.folder       Folder for the folder-scoped grant revokes (codex/
 *                          gemini-cli). Absent = `process.cwd()`.
 * @param deps              Delegate-path seams (engine override + spied fns).
 */
export function unregisterBrainAcrossHarnesses(
  opts?: {
    harnesses?: McpHarness[];
    configPaths?: Partial<Record<McpHarness, string>>;
    folder?: string;
  },
  deps?: BrainUnregisterDeps,
): BrainUnregisterResult[] {
  const harnesses = opts?.harnesses ?? harnessIds();
  const engine = deps?.engine ?? resolveMcpEngine();
  const unregisterFn = deps?.unregisterViaToolFn ?? unregisterMcpViaTool;
  const revokeFn = deps?.removeGrantFn ?? removeBrainGrant;

  // The 4 harnesses that un-register via `add-mcp remove` under the delegate
  // engine (antigravity is carved out to the custom un-merger). Computed once so
  // a single `add-mcp remove` call covers them (one tool invocation, filtered).
  const delegateHarnesses = harnesses.filter(
    (h) => engine === "delegate" && h !== "antigravity",
  );
  const customHarnesses = harnesses.filter(
    (h) => engine !== "delegate" || h === "antigravity",
  );

  const results: BrainUnregisterResult[] = [];

  // 1) DELEGATE un-registration (add-mcp remove) for the non-antigravity 4.
  //    ONE tool call filtered to the mapped agent ids; a tool FAIL marks every
  //    delegated harness `failed` (LOUD — constraint #2, no custom fallback).
  let toolFailedError: string | undefined;
  if (delegateHarnesses.length > 0) {
    const agentIds = delegateHarnesses.map((h) => agentId(h));
    let toolResult: McpToolResult;
    try {
      toolResult = unregisterFn(MCP_KEY, { harnesses: agentIds, global: true });
      if (!toolResult.ok) {
        toolFailedError =
          `add-mcp remove exited ${toolResult.exitCode}` +
          (toolResult.stderr ? `: ${toolResult.stderr}` : "");
      }
    } catch (err) {
      toolFailedError = `add-mcp remove error: ${(err as Error).message}`;
    }
  }

  // 2) Per-harness assembly (preserve the caller's harness order).
  for (const harness of harnesses) {
    // FR-217: per-harness MCP facts READ from the canonical descriptor via
    // mcpFacts(); the { path():.. } cfg shape is preserved so the helper
    // signatures below are unchanged.
    const facts = mcpFacts(harness);
    const cfg = {
      path: () => facts.configPath,
      mapKey: facts.mapKey,
      isToml: facts.format === "toml",
    };
    const targetPath = opts?.configPaths?.[harness] ?? cfg.path();

    let entryResult: McpRegisterResult;
    if (customHarnesses.includes(harness)) {
      // CUSTOM un-merger (antigravity under delegate, OR every harness under the
      // custom engine) — removes the entry from the CORRECT read-path.
      entryResult = cfg.isToml
        ? unmergeTomlConfig({
            targetPath,
            tablePrefix: cfg.mapKey,
            entryKey: MCP_KEY,
          })
        : unmergeJsonConfig({
            targetPath,
            mapKey: cfg.mapKey,
            entryKey: MCP_KEY,
          });
    } else {
      // DELEGATE harness — its verdict is the shared `add-mcp remove` outcome.
      entryResult = toolFailedError
        ? {
            outcome: "failed",
            claudeJsonPath: targetPath,
            mcpEntryPath: "",
            error: toolFailedError,
          }
        : { outcome: "updated", claudeJsonPath: targetPath, mcpEntryPath: "" };
    }

    // 3) REVOKE the Igris-owned no-prompt grant for this harness. A revoke is
    //    attempted regardless of the entry outcome (the grant is a separate
    //    surface). opencode is `covered` (grant lives in agent frontmatter).
    const grant = revokeFn(harness, {
      configPaths: opts?.configPaths,
      folder: opts?.folder,
    });

    results.push({ harness, result: entryResult, grant });
  }
  return results;
}

/**
 * Upsert the `igris-brain` entry in `~/.claude.json`, pointing at the
 * bundled MCP. Idempotent. NEVER throws — returns `outcome: 'failed'` with
 * an `error` string so callers can warn-and-continue.
 *
 * FR-169: this is now a THIN BACK-COMPAT SHIM over
 * `registerBrainAcrossHarnesses({ harnesses:["claude"] })`. It preserves the
 * exact `McpRegisterResult` shape (`claudeJsonPath`/`mcpEntryPath`) the
 * existing 30-case suite + the `install.ts`/`doctor.ts` call sites assert — so
 * behavior is byte-identical. (FR-162 made it a wrapper over `mergeJsonConfig`;
 * FR-169 routes it through the new multi-harness function with a Claude-only
 * subset, keeping ONE place that knows the brain's canonical shape.)
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
  // FR-212d: this is the install-time `~/.claude.json` belt-and-suspenders shim
  // (install step 11 / doctor mcp-unregistered fix), NOT the harness-compile MCP
  // projection the delegate owns. It keeps the hardened DIRECT-WRITE contract
  // (idempotency, malformed-never-corrupted, single rolling backup — the 30-case
  // suite) by forcing the CUSTOM merger regardless of the (now delegate-default)
  // engine. Same posture as antigravity: a deterministic Igris-owned write for a
  // specific config the delegate path does not cleanly serve here. The harness
  // `compile`/`registerBrainAcrossHarnesses` path delegates the non-antigravity
  // harnesses; this narrow shim does not.
  const [{ result }] = registerBrainAcrossHarnesses(
    {
      mcpEntryPath: opts?.mcpEntryPath,
      harnesses: ["claude"],
      configPaths: opts?.claudeJsonPath
        ? { claude: opts.claudeJsonPath }
        : undefined,
    },
    { engine: "custom" },
  );
  // Re-stamp the Claude-specific result fields the existing suite asserts.
  return {
    ...result,
    claudeJsonPath: targetPath,
    mcpEntryPath: opts?.mcpEntryPath ?? bundledMcpEntryPath(),
  };
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

/** Internal constants + helpers exposed for the unit-test suite. */
export const __testing__ = {
  MCP_KEY,
  BACKUP_SUFFIX,
  // FR-163: span-boundary edge cases (the splice's central risk) tested in isolation.
  locateTomlTableSpan,
  renderMcpTomlTable,
};
