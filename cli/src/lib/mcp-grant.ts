/**
 * FR-212b / FR-184: the Igris-owned NO-PROMPT TRUST GRANT for the `igris-brain`
 * MCP server, written deterministically for EVERY harness that has a grant
 * grammar.
 *
 * WHY THIS IS IGRIS-OWNED (Option C, 2026-06-26): shipped `add-mcp@1.11.0` has
 * NO `--auto-approve` (the flag is in the tool's unpublished GitHub `main`). The
 * grant is a security/trust surface — Igris owns it custom + deterministic, with
 * ZERO dependency on an unreleased external flag. `mcp-delegate.ts` does SERVER
 * REGISTRATION; THIS module writes the grant. The two are independent steps.
 *
 * THE GRANT GRAMMAR PER HARNESS (live-probed 2026-06-26 — NOT assumed; the
 * add-mcp-auto-approve assumption is DEAD, so every grammar was verified against
 * a real on-disk config):
 *
 *   claude       ~/.claude/settings.json   permissions.allow += "mcp__igris-brain__*"
 *                  (JSON array; live-verified — the wildcard form)
 *   antigravity  ~/.gemini/antigravity-cli/settings.json
 *                  permissions.allow += "mcp(igris-brain/*)"
 *                  (JSON array; live file enumerates 19 per-tool
 *                  `mcp(igris-brain/<tool>)` — the wildcard is the single grant)
 *   codex        ~/.codex/config.toml   [projects."<folder>"] trust_level = "trusted"
 *                  (TOML; FOLDER-scoped — Codex's `[mcp_servers.igris-brain]`
 *                  table carries NO trust field; trust is per-project-folder,
 *                  exactly like Gemini-CLI. Live-verified.)
 *   gemini-cli   ~/.gemini/trustedFolders.json   { "<folder>": "TRUST_FOLDER" }
 *                  (JSON; FOLDER-scoped — the FR-184 exception. Live-verified.)
 *   opencode     (no file written here) — OpenCode's brain grant is the per-agent
 *                  frontmatter `permission: { "mcp__igris-brain__*": allow }`
 *                  emitted by the EXISTING agent/skills projection (FR-166 /
 *                  loadout.ts `OPENCODE_MCP_PERMISSIONS`). `verifyBrainGrant`
 *                  reports opencode as `covered` (grant lives elsewhere), never
 *                  a drift miss.
 *
 * NO-CLOBBER POSTURE (mirrors mcp-register.ts's mergers, constraint #1): every
 * writer preserves all OTHER entries + top-level keys, refuses to clobber a
 * malformed file, is IDEMPOTENT (grant already present → `unchanged`, NO write),
 * writes atomically (`.tmp.<pid>.<ts>` + `renameSync`) with a single rolling
 * `.igris.bak` backup, and NEVER throws. These files hold PERMISSION GRANTS, not
 * secrets, so they are NOT chmod-600'd (locking a user's shared settings file
 * would be wrong) and carry no `${VAR}` — there is no secret to leak (L-588: the
 * brain is env-free).
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
import * as TOML from "@iarna/toml"; // PARSE-ONLY (idempotency + malformed gate); never re-emit.
import type { McpHarness } from "./mcp-shape.js";
// FR-217: the canonical harness descriptor reader. The grant grammar (kind/path/
// token) + the grant-harness list READ from the descriptor; the local hardcoded
// consts were deleted in M5 (one source of truth: the descriptor). The grant FILE
// paths are tilde-expanded inside grantGrammar() (paths.ts expandTilde).
import { harnessIds, grantGrammar } from "./harness-descriptor.js";

/** Single rolling backup suffix (mirrors mcp-register.ts). */
const BACKUP_SUFFIX = ".igris.bak";

/** The brain MCP server name the grant is for. */
const BRAIN_NAME = "igris-brain";

/**
 * Outcome of a grant (un)write. Mirrors the `McpRegisterOutcome` semantics:
 *   granted   = the grant was absent and was written
 *   revoked   = the grant was present and was removed
 *   unchanged = idempotent no-op (already present on write / already absent on
 *               remove, OR a harness whose grant lives elsewhere — opencode)
 *   covered   = the grant is satisfied by a DIFFERENT surface (opencode's
 *               per-agent frontmatter) — no file written here, never a miss
 *   failed    = malformed file or write error (non-fatal to the caller)
 */
export type GrantOutcome =
  | "granted"
  | "revoked"
  | "unchanged"
  | "covered"
  | "failed";

export interface GrantResult {
  harness: McpHarness;
  outcome: GrantOutcome;
  /** The config FILE touched (or the would-be file), for diagnostics. */
  path: string;
  /** Populated when `outcome === "failed"`. */
  error?: string;
}

/** True when `v` is a plain (non-array, non-null) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// FR-217: the per-harness no-prompt grant grammar (kind/path/token) was
// consolidated into the canonical descriptor in M5 — it lives in
// harness-manifest.json harnesses.<id>.grant and is read via grantGrammar()
// (harness-descriptor.ts). The `kind` dispatch — json-array (append `token` to a
// nested `permissions.allow[]`: claude, antigravity), toml-folder (upsert
// `[projects."<cwd>"] trust_level="trusted"`: codex), json-folder (set
// `{"<cwd>":"TRUST_FOLDER"}`: gemini-cli, FR-184), covered (grant rides another
// surface: opencode frontmatter, no file) — is unchanged in the writers below.

// ---------------------------------------------------------------------------
// JSON ARRAY-APPEND writer (claude, antigravity) — append a token into a
// nested `permissions.allow[]`, preserving every other key. Mirrors
// mcp-register.ts:mergeJsonConfig's 6-step contract, adapted for array-append.
// ---------------------------------------------------------------------------

interface JsonGrantOp {
  targetPath: string;
  token: string;
  /** When true, REMOVE the token instead of appending it. */
  remove?: boolean;
}

function applyJsonArrayGrant(op: JsonGrantOp): GrantResult["outcome"] | { error: string } {
  const { targetPath, token } = op;
  const remove = op.remove ?? false;

  // --- 1. Read. Absent file: a remove is a no-op; an add starts fresh. ----
  const fileExisted = existsSync(targetPath);
  let rawBytes: Buffer | null = null;
  if (fileExisted) {
    try {
      rawBytes = readFileSync(targetPath);
    } catch (err) {
      return { error: `could not read ${targetPath}: ${(err as Error).message}` };
    }
  }
  if (!fileExisted && remove) {
    return "unchanged"; // nothing to revoke
  }

  // --- 2. Parse — fail loud on malformed JSON (do NOT clobber). -----------
  let root: Record<string, unknown>;
  if (rawBytes === null) {
    root = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBytes.toString("utf-8"));
    } catch {
      return {
        error: `malformed ${targetPath} — refusing to write; fix or remove the file manually`,
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        error: `${targetPath} is not a JSON object — refusing to write; fix or remove the file manually`,
      };
    }
    root = parsed;
  }

  // --- 3. Locate permissions.allow (preserve every other key). ------------
  const permsRaw = root.permissions;
  let perms: Record<string, unknown>;
  if (permsRaw === undefined) {
    if (remove) return "unchanged"; // no permissions block → nothing to revoke
    perms = {};
  } else if (isPlainObject(permsRaw)) {
    perms = permsRaw;
  } else {
    return {
      error: `${targetPath} has a non-object 'permissions' — refusing to write; fix or remove the file manually`,
    };
  }
  const allowRaw = perms.allow;
  let allow: unknown[];
  if (allowRaw === undefined) {
    if (remove) return "unchanged";
    allow = [];
  } else if (Array.isArray(allowRaw)) {
    allow = allowRaw;
  } else {
    return {
      error: `${targetPath} has a non-array 'permissions.allow' — refusing to write; fix or remove the file manually`,
    };
  }

  // --- 4. Idempotency. -----------------------------------------------------
  const present = allow.includes(token);
  if (remove) {
    if (!present) return "unchanged";
  } else {
    if (present) return "unchanged";
  }

  // --- 5. Apply: append (add) or filter-out (remove). ----------------------
  let nextAllow: unknown[];
  if (remove) {
    nextAllow = allow.filter((x) => x !== token);
  } else {
    nextAllow = [...allow, token];
  }
  const nextPerms: Record<string, unknown> = { ...perms, allow: nextAllow };
  const nextRoot: Record<string, unknown> = { ...root, permissions: nextPerms };

  // --- 6. Backup-then-atomic-write. ---------------------------------------
  const w = atomicWriteJson(targetPath, nextRoot, fileExisted, rawBytes);
  if (w !== null) return { error: w };
  return remove ? "revoked" : "granted";
}

// ---------------------------------------------------------------------------
// JSON FOLDER-MAP writer (gemini-cli) — set `{ "<cwd>": "TRUST_FOLDER" }` at the
// top level of trustedFolders.json, preserving every other folder entry.
// ---------------------------------------------------------------------------

interface FolderGrantOp {
  targetPath: string;
  folder: string;
  remove?: boolean;
}

function applyJsonFolderGrant(op: FolderGrantOp): GrantResult["outcome"] | { error: string } {
  const { targetPath, folder } = op;
  const remove = op.remove ?? false;
  const VALUE = "TRUST_FOLDER";

  const fileExisted = existsSync(targetPath);
  let rawBytes: Buffer | null = null;
  if (fileExisted) {
    try {
      rawBytes = readFileSync(targetPath);
    } catch (err) {
      return { error: `could not read ${targetPath}: ${(err as Error).message}` };
    }
  }
  if (!fileExisted && remove) return "unchanged";

  let root: Record<string, unknown>;
  if (rawBytes === null) {
    root = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBytes.toString("utf-8"));
    } catch {
      return {
        error: `malformed ${targetPath} — refusing to write; fix or remove the file manually`,
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        error: `${targetPath} is not a JSON object — refusing to write; fix or remove the file manually`,
      };
    }
    root = parsed;
  }

  const present = root[folder] === VALUE;
  if (remove) {
    if (!(folder in root)) return "unchanged";
  } else {
    if (present) return "unchanged";
  }

  const nextRoot: Record<string, unknown> = { ...root };
  if (remove) {
    delete nextRoot[folder];
  } else {
    nextRoot[folder] = VALUE;
  }

  const w = atomicWriteJson(targetPath, nextRoot, fileExisted, rawBytes);
  if (w !== null) return { error: w };
  return remove ? "revoked" : "granted";
}

// ---------------------------------------------------------------------------
// TOML FOLDER-TRUST writer (codex) — upsert `[projects."<cwd>"] trust_level =
// "trusted"`, preserving every other byte (table-scoped string splice, same
// posture as mergeTomlConfig but with a fixed trust-table renderer). @iarna is
// PARSE-ONLY (malformed gate + idempotency compare).
// ---------------------------------------------------------------------------

interface TomlGrantOp {
  targetPath: string;
  folder: string;
  remove?: boolean;
}

/** Render `[projects."<folder>"]\ntrust_level = "trusted"\n`. */
function renderTrustTable(folder: string): string {
  // The folder path is a TOML quoted bare-key segment; JSON.stringify gives a
  // TOML-compatible basic-string escape for the ASCII paths in scope.
  return `[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n`;
}

/**
 * Locate the `[projects."<folder>"]` table span (a half-open `[start, end)` line
 * range) in `lines`, INCLUDING any descendant headers. Returns `null` when the
 * table is absent.
 *
 * A purpose-built locator (NOT mcp-register's `locateTomlTableSpan`): Codex's
 * project-trust grammar quotes ONLY the LAST dotted segment — `[projects."/a/b"]`
 * — whereas `locateTomlTableSpan` matches a BARE dotted key (`mcp_servers.name`)
 * or a fully-quoted WHOLE key. A folder path with slashes MUST be quoted, so the
 * two grammars don't overlap; this small scanner matches the `[projects.<EXACT
 * JSON-quoted folder>]` header literally (the renderer's exact output), which is
 * sufficient for the fixed Codex grammar in scope. The malformed-parse gate runs
 * FIRST, so genuinely broken files never reach here.
 */
function locateProjectsTrustSpan(
  lines: string[],
  folder: string,
): { start: number; end: number } | null {
  // The exact header the renderer emits: `[projects."<escaped-folder>"]`.
  const headerText = `[projects.${JSON.stringify(folder)}]`;
  // Any column-0 table header (`[table]` or `[[array]]`).
  const anyHeaderRe = /^\s*\[/;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    // Tolerate surrounding whitespace + an optional trailing `# comment` (TOML
    // allows both on a header line).
    const trimmed = lines[i].replace(/\s*#.*$/, "").trim();
    if (trimmed === headerText) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  // Extend across the table's body up to the NEXT column-0 header (the trust
  // table has no descendant sub-tables, so the first following header ends it).
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (anyHeaderRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function applyTomlFolderGrant(op: TomlGrantOp): GrantResult["outcome"] | { error: string } {
  const { targetPath, folder } = op;
  const remove = op.remove ?? false;

  const fileExisted = existsSync(targetPath);
  let rawBytes: Buffer | null = null;
  if (fileExisted) {
    try {
      rawBytes = readFileSync(targetPath);
    } catch (err) {
      return { error: `could not read ${targetPath}: ${(err as Error).message}` };
    }
  }
  if (!fileExisted && remove) return "unchanged";
  const existingText = rawBytes === null ? "" : rawBytes.toString("utf-8");

  // Parse for the malformed gate + idempotency (PARSE-ONLY; never re-emit).
  let parsed: TOML.JsonMap;
  if (rawBytes === null) {
    parsed = {};
  } else {
    try {
      parsed = TOML.parse(existingText);
    } catch {
      return {
        error: `malformed ${targetPath} — refusing to write; fix or remove the file manually`,
      };
    }
  }

  const projectsRaw = parsed.projects;
  if (projectsRaw !== undefined && !isPlainObject(projectsRaw)) {
    return {
      error: `${targetPath} has a non-table 'projects' — refusing to write; fix or remove the file manually`,
    };
  }
  const existingTrust = isPlainObject(projectsRaw)
    ? (projectsRaw[folder] as Record<string, unknown> | undefined)
    : undefined;
  const alreadyTrusted =
    isPlainObject(existingTrust) && existingTrust.trust_level === "trusted";

  // Idempotency.
  if (remove) {
    if (existingTrust === undefined) return "unchanged";
  } else {
    if (alreadyTrusted) return "unchanged";
  }

  // Splice the `[projects."<folder>"]` table (table-scoped string edit — same
  // no-clobber posture as mcp-register's mergeTomlConfig, but with the purpose-
  // built `locateProjectsTrustSpan` since the folder-trust grammar quotes only
  // the LAST dotted segment).
  const useCrlf = dominantLineEndingIsCrlf(existingText);
  const eol = useCrlf ? "\r\n" : "\n";
  let serialized: string;
  if (remove) {
    const lines = existingText.split(eol);
    const span = locateProjectsTrustSpan(lines, folder);
    if (span === null) {
      // Parser saw it but locator didn't — refuse rather than guess (mirror).
      return {
        error: `could not locate the '[projects."${folder}"]' table text in ${targetPath} — refusing to write`,
      };
    }
    const before = lines.slice(0, span.start);
    const after = lines.slice(span.end);
    while (
      before.length > 0 &&
      before[before.length - 1].trim() === "" &&
      after.length > 0 &&
      after[0].trim() === ""
    ) {
      before.pop();
    }
    serialized = [...before, ...after].join(eol).replace(/(\r?\n)+$/, "");
    if (serialized.length > 0) serialized += eol;
  } else {
    const replacement = renderTrustTable(folder);
    if (rawBytes === null || existingText.length === 0) {
      serialized = replacement;
    } else {
      const lines = existingText.split(eol);
      const span = locateProjectsTrustSpan(lines, folder);
      if (span === null) {
        // Append a fresh block at EOF (the table is absent), leaving the file
        // above untouched — the common case (a new folder).
        const trimmedEnd = existingText.replace(/(\r?\n)+$/, "");
        const replLines = replacement.replace(/\n$/, "").split("\n");
        serialized = [...trimmedEnd.split(eol), "", ...replLines].join(eol);
      } else {
        const before = lines.slice(0, span.start);
        const after = lines.slice(span.end);
        const replLines = replacement.replace(/\n$/, "").split("\n");
        serialized = [...before, ...replLines, ...after].join(eol);
      }
    }
  }

  // Parse-verify post-condition guard (the load-bearing net — mirror of
  // mergeTomlConfig §5b): the candidate must parse AND the target folder's
  // trust state must be what we intended. (We do not assert byte-stability of
  // OTHER tables here beyond the parse — the splice only ever touches the one
  // located span, and a parse failure converts any mislocation to a safe error.)
  let candidate: TOML.JsonMap;
  try {
    candidate = TOML.parse(serialized);
  } catch {
    return {
      error: `grant splice verification failed (candidate did not parse) — refusing to write to avoid corrupting ${targetPath}`,
    };
  }
  const candProjects = candidate.projects;
  const candTrust = isPlainObject(candProjects)
    ? (candProjects[folder] as Record<string, unknown> | undefined)
    : undefined;
  if (remove) {
    if (candTrust !== undefined) {
      return {
        error: `grant splice verification failed (folder trust still present) — refusing to write ${targetPath}`,
      };
    }
  } else {
    if (!(isPlainObject(candTrust) && candTrust.trust_level === "trusted")) {
      return {
        error: `grant splice verification failed (folder trust not applied) — refusing to write ${targetPath}`,
      };
    }
  }

  const w = atomicWriteText(targetPath, serialized, fileExisted, rawBytes);
  if (w !== null) return { error: w };
  return remove ? "revoked" : "granted";
}

// ---------------------------------------------------------------------------
// Shared atomic-write helpers (mirror mcp-register.ts step 6; NEVER throw —
// return an error string or null on success). These config files hold GRANTS,
// not secrets — no chmod-600.
// ---------------------------------------------------------------------------

function atomicWriteJson(
  targetPath: string,
  root: Record<string, unknown>,
  fileExisted: boolean,
  rawBytes: Buffer | null,
): string | null {
  const serialized = JSON.stringify(root, null, 2) + "\n";
  return atomicWriteText(targetPath, serialized, fileExisted, rawBytes);
}

function atomicWriteText(
  targetPath: string,
  serialized: string,
  fileExisted: boolean,
  rawBytes: Buffer | null,
): string | null {
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    // Benign-create the parent dir so a not-yet-initialized harness (e.g. a
    // missing ~/.claude or ~/.gemini) still gets its grant file.
    mkdirSync(dirname(targetPath), { recursive: true });
    if (fileExisted && rawBytes !== null) {
      writeFileSync(`${targetPath}${BACKUP_SUFFIX}`, rawBytes);
    }
    writeFileSync(tmpPath, serialized);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore — cleanup is best-effort */
      }
    }
    return `could not write ${targetPath}: ${(err as Error).message}`;
  }
  return null;
}

/** Detect a dominant CRLF line ending (mirror of mcp-register.ts). */
function dominantLineEndingIsCrlf(text: string): boolean {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return false;
  const totalLf = (text.match(/\n/g) ?? []).length;
  const bareLf = totalLf - crlf;
  return crlf > bareLf;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/** Options for the grant writers — `configPaths` is the test-sandbox seam. */
export interface GrantOptions {
  /** Per-harness config-path overrides (tests sandbox HOME and pass these). */
  configPaths?: Partial<Record<McpHarness, string>>;
  /**
   * The FOLDER to trust for the folder-scoped harnesses (codex/gemini-cli).
   * Defaults to `process.cwd()` (the project root the brain is reached from).
   */
  folder?: string;
}

function resolvePath(harness: McpHarness, opts?: GrantOptions): string {
  // FR-217: the grant FILE path READS from the canonical descriptor
  // (grantGrammar(id).path). `covered` harnesses (opencode) carry no grant file
  // in the descriptor (path undefined) — fall back to the opencode diagnostic
  // placeholder so the covered GrantResult.path stays byte-identical (the writers
  // never use the path for `covered`; it is a diagnostic only).
  const override = opts?.configPaths?.[harness];
  if (override !== undefined) return override;
  return (
    grantGrammar(harness).path ??
    "(opencode: per-agent frontmatter permission — no grant file)"
  );
}

/**
 * Write the FULL no-prompt wildcard grant for ONE harness, per the probed
 * grammar. Idempotent + no-clobber + never-throws. `opencode` is `covered` (its
 * grant lives in the per-agent frontmatter, not a file here).
 */
export function writeBrainGrant(
  harness: McpHarness,
  opts?: GrantOptions,
): GrantResult {
  const grammar = grantGrammar(harness);
  const path = resolvePath(harness, opts);
  const folder = opts?.folder ?? process.cwd();

  if (grammar.kind === "covered") {
    return { harness, outcome: "covered", path };
  }

  let r: GrantOutcome | { error: string };
  switch (grammar.kind) {
    case "json-array":
      r = applyJsonArrayGrant({ targetPath: path, token: grammar.token! });
      break;
    case "json-folder":
      r = applyJsonFolderGrant({ targetPath: path, folder });
      break;
    case "toml-folder":
      r = applyTomlFolderGrant({ targetPath: path, folder });
      break;
  }
  if (typeof r === "object") {
    return { harness, outcome: "failed", path, error: r.error };
  }
  return { harness, outcome: r, path };
}

/** Remove the no-prompt grant for ONE harness (the inverse of writeBrainGrant). */
export function removeBrainGrant(
  harness: McpHarness,
  opts?: GrantOptions,
): GrantResult {
  const grammar = grantGrammar(harness);
  const path = resolvePath(harness, opts);
  const folder = opts?.folder ?? process.cwd();

  if (grammar.kind === "covered") {
    return { harness, outcome: "covered", path };
  }

  let r: GrantOutcome | { error: string };
  switch (grammar.kind) {
    case "json-array":
      r = applyJsonArrayGrant({
        targetPath: path,
        token: grammar.token!,
        remove: true,
      });
      break;
    case "json-folder":
      r = applyJsonFolderGrant({ targetPath: path, folder, remove: true });
      break;
    case "toml-folder":
      r = applyTomlFolderGrant({ targetPath: path, folder, remove: true });
      break;
  }
  if (typeof r === "object") {
    return { harness, outcome: "failed", path, error: r.error };
  }
  return { harness, outcome: r, path };
}

/**
 * Write the grant for ALL (or a subset of) harnesses. NEVER throws; a failure on
 * one harness folds into that harness's `failed` result only (the others still
 * get their grant — the caller warn-and-continues per harness).
 */
export function writeBrainGrantAcrossHarnesses(opts?: {
  harnesses?: McpHarness[];
  configPaths?: Partial<Record<McpHarness, string>>;
  folder?: string;
}): GrantResult[] {
  const harnesses = opts?.harnesses ?? harnessIds();
  return harnesses.map((h) =>
    writeBrainGrant(h, {
      configPaths: opts?.configPaths,
      folder: opts?.folder,
    }),
  );
}

/** Remove the grant for ALL (or a subset of) harnesses. */
export function removeBrainGrantAcrossHarnesses(opts?: {
  harnesses?: McpHarness[];
  configPaths?: Partial<Record<McpHarness, string>>;
  folder?: string;
}): GrantResult[] {
  const harnesses = opts?.harnesses ?? harnessIds();
  return harnesses.map((h) =>
    removeBrainGrant(h, {
      configPaths: opts?.configPaths,
      folder: opts?.folder,
    }),
  );
}

/**
 * Drift predicate: is the no-prompt grant PRESENT for `harness`? Reads the live
 * (or sandboxed) config and returns true iff the wildcard token / folder-trust
 * is already written. `opencode` is always `true` (its grant lives in a
 * different surface — never a drift miss here). NEVER throws — a malformed or
 * unreadable file returns false (an unverifiable grant is treated as absent so
 * the drift invariant flags it for re-projection).
 */
export function verifyBrainGrant(
  harness: McpHarness,
  opts?: GrantOptions,
): boolean {
  const grammar = grantGrammar(harness);
  if (grammar.kind === "covered") return true;
  const path = resolvePath(harness, opts);
  const folder = opts?.folder ?? process.cwd();
  if (!existsSync(path)) return false;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return false;
  }
  try {
    if (grammar.kind === "json-array") {
      const parsed = JSON.parse(text);
      if (!isPlainObject(parsed)) return false;
      const perms = parsed.permissions;
      if (!isPlainObject(perms)) return false;
      const allow = perms.allow;
      return Array.isArray(allow) && allow.includes(grammar.token!);
    }
    if (grammar.kind === "json-folder") {
      const parsed = JSON.parse(text);
      return isPlainObject(parsed) && parsed[folder] === "TRUST_FOLDER";
    }
    // toml-folder
    const parsed = TOML.parse(text);
    const projects = parsed.projects;
    const trust = isPlainObject(projects)
      ? (projects[folder] as Record<string, unknown> | undefined)
      : undefined;
    return isPlainObject(trust) && trust.trust_level === "trusted";
  } catch {
    return false;
  }
}

/** Internal constants exposed for the unit-test suite. */
export const __testing__ = {
  BRAIN_NAME,
  BACKUP_SUFFIX,
  renderTrustTable,
};
