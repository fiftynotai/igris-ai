/**
 * `igris registry <add|list|remove|update> [options]` — the FR-141/FR-142
 * Layer-2 customization-registry overlay WRITER.
 *
 * FR-142 COPY-VENDOR MODE: `add` no longer references a live external path;
 * it COPIES the surface's canonical files into `~/.igris/registry/<name>/`
 * (atomic temp-dir + rename) and points the overlay's `canonical.dir` at that
 * VENDORED copy (as an absolute `brainDir()`-derived path the patched
 * compiler resolves verbatim). A typed origin `{type:"path", dir, hash}` is
 * recorded in a sibling `~/.igris/registry/origins.json` (option (b): OUTSIDE
 * the manifest so the overlay stays schema-clean). The new `update` action
 * re-vendors from the recorded origin and reports per-surface changed/unchanged
 * via content-hash comparison.
 *
 * Writes the runtime-only personal overlay
 * `~/.igris/registry/harness-manifest.personal.json`, which the already-live
 * FR-136 merge seam (`compile_harnesses.sh` / `check_harness_drift.sh`)
 * auto-discovers and merges with the project's base `harness-manifest.json`.
 *
 * The load-bearing logic is the write-path enforcement:
 *   1. intra-overlay dedupe (the bash merge only dedupes overlay-vs-base,
 *      NOT overlay-vs-overlay — this verb closes that gap),
 *   2. core-collision reject at write-time (mirrors the merge guard in
 *      `_common.sh` `merge_overlay_manifest`, by reading the base manifest),
 *   3. TS schema-shape validation before persist (port of the load-bearing
 *      rules below), and
 *   4. atomic persist (temp file + rename) for BOTH the overlay and the
 *      vendored copy and the origins sidecar.
 *
 * SCHEMA SOURCE OF TRUTH (keep this in sync if the schema changes):
 *   core/scripts/cli-adapters/manifest.schema.json  §"$defs.agent" / top-level
 *   core/scripts/cli-adapters/_common.sh  (structural fallback, validate_manifest)
 * Integration test #11 runs the REAL `validate_manifest` against an overlay this
 * verb writes, so any drift between this TS validator and the schema reds the build.
 *
 * NAME COLLISION NOTE: this is the verb at `cli/src/verbs/registry.ts`. It is
 * UNRELATED to `cli/src/lib/registry.ts` (the project-registry SQLite module)
 * despite the shared basename. This verb does NOT import `lib/registry.ts`.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  registryOriginsPath,
  registryOverlayPath,
  registrySurfaceDirPath,
} from "../lib/paths.js";
import { info, error as logError } from "../lib/log.js";
import {
  isGithubSpec,
  parseGithubSpec,
  readRepoManifest,
  selectSurface,
  pickNewerReleaseTag,
  hashFileSet,
  fetchRepoDefault,
  listReleasesDefault,
  type GithubSpec,
  type FetchRepoFn,
  type ListReleasesFn,
  type FetchedRepo,
} from "../lib/github-source.js";

export type RegistryAction = "add" | "list" | "remove" | "update";

/** Allowed harness target types (mirrors manifest.schema.json target enum). */
const VALID_TARGET_TYPES = ["claude", "codex", "gemini"] as const;
type TargetType = (typeof VALID_TARGET_TYPES)[number];

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface CanonicalSpec {
  dir: string;
  versioned: boolean;
  glob?: string;
  file?: string;
}

interface TargetSpec {
  type: string;
  path: string;
}

interface AgentEntry {
  name: string;
  layer?: string;
  canonical: CanonicalSpec;
  body_exception?: string;
  targets: TargetSpec[];
}

/** The overlay file shape. `surfaces` is FR-143's; preserved on read-modify-write. */
interface Overlay {
  $schema?: string;
  _comment?: string;
  _schema?: Record<string, unknown>;
  version: number;
  agents: AgentEntry[];
  surfaces?: Record<string, unknown>;
}

/**
 * FR-142 path origin: provenance + update metadata for a locally-vendored
 * surface. `dir` is the absolute SOURCE dir the files were copied FROM; `hash`
 * is the content hash over the vendored copy (freshness comparison for
 * `update`). Byte-identical on disk to FR-142's shipped shape.
 */
export interface PathOrigin {
  type: "path";
  dir: string;
  hash: string;
}

/**
 * FR-148 github origin: provenance + update metadata for a surface vendored
 * from a GitHub repo at a release. `repo` is `owner/repo`; `ref` is the pinned
 * tag/branch/SHA; `sha` is the resolved immutable commit; `hash` is the content
 * hash over the vendored copy. Freshness for `update` is RELEASE-TAG comparison
 * (not hash). `subdir`/`surfaceVersion` are optional provenance.
 */
export interface GithubOrigin {
  type: "github";
  repo: string;
  ref: string;
  sha: string;
  hash: string;
  subdir?: string;
  surfaceVersion?: string;
}

/**
 * The typed origin recorded per surface, stored OUTSIDE the harness manifest
 * (option (b)) in `origins.json`. A discriminated union over `type`; the
 * compiler never reads this file (only `igris registry update` does).
 */
export type Origin = PathOrigin | GithubOrigin;

/** Map of surface name → its typed origin. The shape of `origins.json`. */
export type OriginsMap = Record<string, Origin>;

export interface RegistryOptions {
  /** Which sub-verb to run. */
  action: RegistryAction;
  /** Agent name (add/remove/update). */
  name?: string;
  /**
   * Source path to copy the canonical file set FROM (FR-142 `--from`).
   * Unversioned: dir+file derived from this. The CLI boundary coalesces the
   * deprecated `--canonical` alias into this field.
   */
  from?: string;
  /** Canonical is versioned (requires `glob`). */
  versioned?: boolean;
  /** Filename glob (versioned only). */
  glob?: string;
  /** Output targets, each `type:path` (repeatable). */
  targets?: string[];
  /** Optional body-exception sidecar basename. */
  bodyException?: string;
  /** Root for base-manifest collision check + relative `--from` resolution (default: cwd). */
  projectRoot?: string;
  /** Update every path-origin entry (`update --all`). */
  all?: boolean;
  /** Test seam: overlay path override (defaults to registryOverlayPath()). */
  overlayPath?: string;
  /** Test seam: origins.json path override (defaults to registryOriginsPath()). */
  originsPath?: string;
  /** Test seam: vendor-dir base override (defaults to registrySurfaceDirPath()). */
  vendorDir?: (name: string) => string;
  /**
   * FR-148 test seam: github fetch boundary. Defaults to `fetchRepoDefault`
   * (gh→git→tarball). Unit tests inject a fake returning a staged fixture
   * repo dir + a fake sha (NEVER vi.mock the SUT — L-159/L-173).
   */
  fetchRepo?: FetchRepoFn;
  /**
   * FR-148 test seam: github release-listing boundary. Defaults to
   * `listReleasesDefault` (gh→public API). Unit tests inject a fake tag list.
   */
  listReleases?: ListReleasesFn;
}

// ---------------------------------------------------------------------------
// Schema-shape validators (port of manifest.schema.json + _common.sh fallback)
// ---------------------------------------------------------------------------

/** Validate one agent entry. Returns an error message, or null if valid. */
export function validateAgentEntry(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return "agent entry must be an object";
  }
  const agent = entry as Record<string, unknown>;
  const allowedAgentKeys = new Set([
    "name",
    "layer",
    "canonical",
    "body_exception",
    "targets",
  ]);
  for (const key of Object.keys(agent)) {
    if (!allowedAgentKeys.has(key)) {
      return `unknown agent key '${key}' (additionalProperties:false)`;
    }
  }

  for (const req of ["name", "canonical", "targets"]) {
    if (!(req in agent)) {
      return `agent missing required key '${req}'`;
    }
  }

  if (typeof agent.name !== "string" || !NAME_PATTERN.test(agent.name)) {
    return `agent name '${String(agent.name)}' must match /^[a-z0-9][a-z0-9-]*$/`;
  }
  if (agent.layer !== undefined && typeof agent.layer !== "string") {
    return "agent 'layer' must be a string";
  }
  if (
    agent.body_exception !== undefined &&
    typeof agent.body_exception !== "string"
  ) {
    return "agent 'body_exception' must be a string";
  }

  const canon = agent.canonical;
  if (typeof canon !== "object" || canon === null || Array.isArray(canon)) {
    return "agent.canonical must be an object";
  }
  const canonRec = canon as Record<string, unknown>;
  const allowedCanonKeys = new Set(["dir", "glob", "file", "versioned"]);
  for (const key of Object.keys(canonRec)) {
    if (!allowedCanonKeys.has(key)) {
      return `agent.canonical: unknown key '${key}' (additionalProperties:false)`;
    }
  }
  for (const req of ["dir", "versioned"]) {
    if (!(req in canonRec)) {
      return `agent.canonical missing required key '${req}'`;
    }
  }
  if (typeof canonRec.dir !== "string") {
    return "agent.canonical.dir must be a string";
  }
  if (typeof canonRec.versioned !== "boolean") {
    return "agent.canonical.versioned must be a boolean";
  }
  // oneOf: versioned=true REQUIRES glob (and no file); versioned=false REQUIRES
  // file (and no glob).
  if (canonRec.versioned === true) {
    if (typeof canonRec.glob !== "string") {
      return "agent.canonical: versioned=true requires 'glob'";
    }
    if ("file" in canonRec) {
      return "agent.canonical: versioned=true must not set 'file'";
    }
  } else {
    if (typeof canonRec.file !== "string") {
      return "agent.canonical: versioned=false requires 'file'";
    }
    if ("glob" in canonRec) {
      return "agent.canonical: versioned=false must not set 'glob'";
    }
  }

  const targets = agent.targets;
  if (!Array.isArray(targets) || targets.length < 1) {
    return "agent.targets must be a non-empty array";
  }
  const allowedTargetKeys = new Set(["type", "path"]);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      return `agent.targets[${i}] must be an object`;
    }
    const tRec = t as Record<string, unknown>;
    for (const key of Object.keys(tRec)) {
      if (!allowedTargetKeys.has(key)) {
        return `agent.targets[${i}]: unknown key '${key}' (additionalProperties:false)`;
      }
    }
    for (const req of ["type", "path"]) {
      if (!(req in tRec)) {
        return `agent.targets[${i}] missing required key '${req}'`;
      }
    }
    if (typeof tRec.type !== "string" || typeof tRec.path !== "string") {
      return `agent.targets[${i}] type/path must be strings`;
    }
    if (!(VALID_TARGET_TYPES as readonly string[]).includes(tRec.type)) {
      return `agent.targets[${i}].type '${tRec.type}' is not one of ${JSON.stringify(VALID_TARGET_TYPES)}`;
    }
  }

  return null;
}

/** Validate the whole overlay shape. Returns an error message, or null. */
export function validateOverlayShape(overlay: unknown): string | null {
  if (typeof overlay !== "object" || overlay === null || Array.isArray(overlay)) {
    return "overlay top-level value must be an object";
  }
  const o = overlay as Record<string, unknown>;
  const allowedTop = new Set([
    "$schema",
    "_comment",
    "_schema",
    "version",
    "agents",
    "surfaces",
  ]);
  for (const key of Object.keys(o)) {
    if (!allowedTop.has(key)) {
      return `unknown top-level key '${key}' (additionalProperties:false)`;
    }
  }
  if (o.version !== 1) {
    return `overlay 'version' must be 1 (got ${JSON.stringify(o.version)})`;
  }
  if (!Array.isArray(o.agents)) {
    return "overlay 'agents' must be an array";
  }
  for (let i = 0; i < o.agents.length; i++) {
    const err = validateAgentEntry(o.agents[i]);
    if (err !== null) {
      return `agents[${i}]: ${err}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Overlay read / write
// ---------------------------------------------------------------------------

class OverlayReadError extends Error {}

/** Read the overlay; absent file → fresh empty overlay. Malformed → throw. */
function readOverlay(path: string): Overlay {
  if (!existsSync(path)) {
    return { version: 1, agents: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new OverlayReadError(
      `cannot read overlay at ${path}: ${(err as Error).message}`,
    );
  }
  try {
    const parsed = JSON.parse(raw) as Overlay;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not a JSON object");
    }
    if (!Array.isArray(parsed.agents)) {
      parsed.agents = [];
    }
    if (typeof parsed.version !== "number") {
      parsed.version = 1;
    }
    return parsed;
  } catch (err) {
    throw new OverlayReadError(
      `overlay at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
}

/** Atomically persist the overlay: write a sibling temp file, then rename. */
function writeOverlayAtomic(path: string, overlay: Overlay): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(overlay, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/** Read the base manifest agent names (for the core-collision guard). */
function readBaseAgentNames(projectRoot: string): Set<string> {
  // FR-136 default base-manifest location: <project-root>/harness-manifest.json.
  const basePath = join(projectRoot, "harness-manifest.json");
  if (!existsSync(basePath)) {
    // A project may have no base manifest yet; the merge guard only fires when
    // both exist, so treat absent as "no base agents" (do not hard-fail).
    return new Set();
  }
  try {
    const base = JSON.parse(readFileSync(basePath, "utf-8")) as {
      agents?: { name?: unknown }[];
    };
    const names = new Set<string>();
    for (const a of base.agents ?? []) {
      if (typeof a?.name === "string") {
        names.add(a.name);
      }
    }
    return names;
  } catch {
    // A malformed base manifest is not FR-141's problem to fix; the adapters
    // validate it. Treat as no base agents for the write-time collision check.
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// FR-142: origins sidecar (read / write)
// ---------------------------------------------------------------------------

class OriginsReadError extends Error {}

/** Read `origins.json`; absent → empty map. Malformed → throw (same idiom as readOverlay). */
function readOrigins(path: string): OriginsMap {
  if (!existsSync(path)) {
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new OriginsReadError(
      `cannot read origins at ${path}: ${(err as Error).message}`,
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed as OriginsMap;
  } catch (err) {
    throw new OriginsReadError(
      `origins at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
}

/** Atomically persist origins: write a sibling temp file, then rename. */
function writeOriginsAtomic(path: string, origins: OriginsMap): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(origins, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// FR-142: source resolution + content hash + atomic vendor copy
// ---------------------------------------------------------------------------

/** Resolve a `~`/absolute/relative source path to an absolute path. */
function resolveSourcePath(p: string, projectRoot: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  if (isAbsolute(p)) {
    return p;
  }
  return resolve(projectRoot, p);
}

/**
 * Compute a stable content hash over a vendored file set: for each file
 * (sorted by relative path) fold `relpath\0bytes` into one sha256. Stable
 * across machines (relpaths, not abspaths) and order-independent (sorted).
 */
function hashSurface(absDir: string, fileRelPaths: string[]): string {
  const h = createHash("sha256");
  for (const rel of [...fileRelPaths].sort()) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(absDir, rel)));
  }
  return h.digest("hex");
}

/**
 * The resolved source file set for a surface. `srcDir` is the absolute origin
 * dir; `files` are the relative basenames to copy out of it.
 */
interface ResolvedSource {
  srcDir: string;
  files: string[];
}

/**
 * Resolve the source dir + file list from a `--from`/origin path.
 * Unversioned: `from` is `<dir>/<file>` → srcDir=<abs dir>, files=[<file>].
 * Versioned: `from` is `<dir>` → srcDir=<abs dir>, files=[every entry matching glob].
 * Returns a ResolvedSource or an error message string.
 */
function resolveSource(
  from: string,
  versioned: boolean,
  glob: string | undefined,
  projectRoot: string,
): ResolvedSource | string {
  if (versioned) {
    const srcDir = resolveSourcePath(from, projectRoot);
    if (!existsSync(srcDir)) {
      return `canonical source dir does not exist: ${srcDir}`;
    }
    const re = globToRegExp(glob ?? "");
    let entries: string[];
    try {
      entries = readdirSync(srcDir, { withFileTypes: true })
        .filter((d) => d.isFile() && re.test(d.name))
        .map((d) => d.name);
    } catch (err) {
      return `cannot read canonical source dir ${srcDir}: ${(err as Error).message}`;
    }
    if (entries.length === 0) {
      return `no files in ${srcDir} match glob '${glob ?? ""}'`;
    }
    return { srcDir, files: entries };
  }
  // Unversioned: split dir/file off the source path.
  const abs = resolveSourcePath(from, projectRoot);
  const srcDir = dirname(abs);
  const file = basename(abs);
  const full = join(srcDir, file);
  if (!existsSync(full)) {
    return `canonical source file does not exist: ${full}`;
  }
  return { srcDir, files: [file] };
}

/** Translate a simple shell-style glob (`*`, `?`) into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (const ch of glob) {
    if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out);
}

/**
 * Atomically vendor a file set into `destDir`: copy into a sibling temp dir on
 * the SAME filesystem (under the registry dir), then `renameSync` over destDir
 * (replacing any prior copy). No partial-vendor window. Returns nothing; throws
 * on copy failure (caller cleans up).
 */
function vendorSurfaceAtomic(
  srcDir: string,
  files: string[],
  destDir: string,
): void {
  mkdirSync(dirname(destDir), { recursive: true });
  const tmp = `${destDir}.tmp-${process.pid}`;
  // Start from a clean temp dir.
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    for (const f of files) {
      copyFileSync(join(srcDir, f), join(tmp, f));
    }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  // Replace any prior vendored copy atomically.
  rmSync(destDir, { recursive: true, force: true });
  renameSync(tmp, destDir);
}

// ---------------------------------------------------------------------------
// --target parsing
// ---------------------------------------------------------------------------

/**
 * Parse a `--target type:path` string. Splits on the FIRST `:` only so paths
 * containing `:` are preserved. Returns the target or an error message.
 */
function parseTarget(spec: string): TargetSpec | string {
  const idx = spec.indexOf(":");
  if (idx < 0) {
    return `--target '${spec}' must be of the form type:path`;
  }
  const type = spec.slice(0, idx);
  const path = spec.slice(idx + 1);
  if (!(VALID_TARGET_TYPES as readonly string[]).includes(type)) {
    return `--target type '${type}' is not one of ${JSON.stringify(VALID_TARGET_TYPES)}`;
  }
  if (path.length === 0) {
    return `--target '${spec}' has an empty path`;
  }
  return { type: type as TargetType, path };
}

// ---------------------------------------------------------------------------
// Sub-verb branches
// ---------------------------------------------------------------------------

async function runAdd(
  opts: RegistryOptions,
  overlayPath: string,
): Promise<number> {
  if (opts.name === undefined || opts.name.length === 0) {
    logError("registry add: <name> is required");
    return 2;
  }
  if (opts.from === undefined || opts.from.length === 0) {
    logError("registry add: --from <dir-or-file> is required");
    return 2;
  }
  if (opts.targets === undefined || opts.targets.length === 0) {
    logError("registry add: at least one --target <type:path> is required");
    return 2;
  }

  // FR-148: a `github:` --from is a remote source — branch BEFORE the
  // filesystem-path resolution below.
  if (isGithubSpec(opts.from)) {
    return runAddGithub(opts, overlayPath);
  }

  // Parse targets.
  const targets: TargetSpec[] = [];
  for (const spec of opts.targets) {
    const parsed = parseTarget(spec);
    if (typeof parsed === "string") {
      logError(`registry add: ${parsed}`);
      return 2;
    }
    targets.push(parsed);
  }

  const projectRoot = opts.projectRoot ?? process.cwd();
  const vendorDirFor = opts.vendorDir ?? registrySurfaceDirPath;
  const vendoredDir = vendorDirFor(opts.name);

  // Resolve the canonical SOURCE file set from --from (validates flags + that
  // the source actually exists on disk — copy-mode needs real files).
  let resolved: ResolvedSource;
  let unversionedFile: string | undefined;
  if (opts.versioned === true) {
    if (opts.glob === undefined || opts.glob.length === 0) {
      logError("registry add: --versioned requires --glob <g>");
      return 2;
    }
    const r = resolveSource(opts.from, true, opts.glob, projectRoot);
    if (typeof r === "string") {
      logError(`registry add: ${r}`);
      return 1;
    }
    resolved = r;
  } else {
    if (opts.glob !== undefined) {
      logError("registry add: --glob is only valid with --versioned");
      return 2;
    }
    const idx = opts.from.lastIndexOf("/");
    const file = idx >= 0 ? opts.from.slice(idx + 1) : opts.from;
    if (file.length === 0) {
      logError(
        "registry add: --from must include a filename when not --versioned",
      );
      return 2;
    }
    const r = resolveSource(opts.from, false, undefined, projectRoot);
    if (typeof r === "string") {
      logError(`registry add: ${r}`);
      return 1;
    }
    resolved = r;
    unversionedFile = file;
  }

  // Build the canonical spec — `dir` points at the VENDORED copy (absolute,
  // brainDir()-derived). The patched compiler resolves an absolute canon.dir
  // verbatim (its `/*` case), correct under both the prod brain and the
  // IGRIS_BRAIN_DIR test sandbox (which is where registrySurfaceDirPath lands).
  let canonical: CanonicalSpec;
  if (opts.versioned === true) {
    canonical = { dir: vendoredDir, versioned: true, glob: opts.glob };
  } else {
    canonical = { dir: vendoredDir, versioned: false, file: unversionedFile };
  }

  const entry: AgentEntry = {
    name: opts.name,
    layer: "personal",
    canonical,
    targets,
  };
  if (opts.bodyException !== undefined && opts.bodyException.length > 0) {
    entry.body_exception = opts.bodyException;
  }

  // (a) Validate the new entry shape (surfaces additionalProperties/oneOf/enum
  // errors at write-time).
  const entryErr = validateAgentEntry(entry);
  if (entryErr !== null) {
    logError(`registry add: invalid agent entry: ${entryErr}`);
    return 1;
  }

  // Read current overlay (unchanged on any reject below).
  let overlay: Overlay;
  try {
    overlay = readOverlay(overlayPath);
  } catch (err) {
    logError((err as Error).message);
    return 1;
  }

  // (b) Intra-overlay dedupe — the bash merge does NOT dedupe overlay-vs-overlay.
  if (overlay.agents.some((a) => a.name === opts.name)) {
    logError(
      `registry add: an overlay agent named '${opts.name}' already exists; ` +
        `remove it first or choose another name. Overlay unchanged: ${overlayPath}`,
    );
    return 1;
  }

  // (c) Core-collision reject — mirror the merge guard (_common.sh).
  const baseNames = readBaseAgentNames(projectRoot);
  if (baseNames.has(opts.name)) {
    logError(
      `registry add: '${opts.name}' collides with a base (core) agent name; ` +
        "a personal customization must not shadow a core agent. Overlay unchanged.",
    );
    return 1;
  }

  // Append + validate the RESULT (defense-in-depth) before persist.
  overlay.agents.push(entry);
  const overlayErr = validateOverlayShape(overlay);
  if (overlayErr !== null) {
    logError(`registry add: resulting overlay invalid: ${overlayErr}`);
    return 1;
  }

  // All guards passed → VENDOR the file set (atomic), then persist the overlay,
  // then record the origin. If overlay persist fails after vendoring, clean up
  // the just-vendored dir so a rejected add leaves no orphan copy.
  let hash: string;
  try {
    vendorSurfaceAtomic(resolved.srcDir, resolved.files, vendoredDir);
    hash = hashSurface(vendoredDir, resolved.files);
  } catch (err) {
    rmSync(vendoredDir, { recursive: true, force: true });
    logError(`registry add: failed to vendor canonical files: ${(err as Error).message}`);
    return 1;
  }

  try {
    writeOverlayAtomic(overlayPath, overlay);
  } catch (err) {
    rmSync(vendoredDir, { recursive: true, force: true });
    logError(`registry add: failed to write overlay: ${(err as Error).message}`);
    return 1;
  }

  // Record the typed origin (option (b): outside the manifest).
  const originsPath = opts.originsPath ?? registryOriginsPath();
  try {
    const origins = readOrigins(originsPath);
    origins[opts.name] = { type: "path", dir: resolved.srcDir, hash };
    writeOriginsAtomic(originsPath, origins);
  } catch (err) {
    logError(`registry add: failed to record origin: ${(err as Error).message}`);
    return 1;
  }

  info(
    `Registered personal agent '${opts.name}' (vendored ${resolved.files.length} ` +
      `file(s) from ${resolved.srcDir} into ${vendoredDir}) in ${overlayPath}`,
  );
  return 0;
}

/**
 * FR-148 github-origin add. Parses the `github:owner/repo@ref[#subdir]` spec
 * (usage errors exit 2), fetches the repo via the injectable `fetchRepo` seam
 * into a temp dir, reads + validates the repo manifest, selects ONE surface by
 * `<name>`, runs the SAME guard chain as `runAdd` (validate, intra-overlay
 * dedupe, core-collision), vendors the selected files into the registry dir,
 * persists the overlay, and records a `GithubOrigin`. The temp clone is always
 * cleaned up in a finally. `<name>` is guaranteed defined by the caller.
 */
async function runAddGithub(
  opts: RegistryOptions,
  overlayPath: string,
): Promise<number> {
  const name = opts.name!;
  const from = opts.from!;

  // Parse targets (same as runAdd).
  const targets: TargetSpec[] = [];
  for (const spec of opts.targets!) {
    const parsed = parseTarget(spec);
    if (typeof parsed === "string") {
      logError(`registry add: ${parsed}`);
      return 2;
    }
    targets.push(parsed);
  }

  // Parse the github spec (usage error → exit 2). Parse PRECEDES fetch.
  const spec = parseGithubSpec(from);
  if (typeof spec === "string") {
    logError(`registry add: ${spec}`);
    return 2;
  }

  const vendorDirFor = opts.vendorDir ?? registrySurfaceDirPath;
  const vendoredDir = vendorDirFor(name);
  const fetchRepo = opts.fetchRepo ?? fetchRepoDefault;

  let fetched: FetchedRepo;
  try {
    fetched = await fetchRepo(spec);
  } catch (err) {
    logError(`registry add: ${(err as Error).message}`);
    return 1;
  }

  try {
    // Read + validate the repo manifest (reuses validateOverlayShape).
    const manifest = readRepoManifest(fetched.dir);
    if (typeof manifest === "string") {
      logError(`registry add: ${manifest}`);
      return 1;
    }

    // Select ONE surface by <name>; resolve its canonical files on disk.
    const selected = selectSurface(manifest, name, fetched.dir, spec.subdir);
    if (typeof selected === "string") {
      logError(`registry add: ${selected}`);
      return 1;
    }

    // Build the overlay entry — canonical.dir points at the VENDORED copy.
    let canonical: CanonicalSpec;
    if (selected.entry.canonical.versioned) {
      canonical = {
        dir: vendoredDir,
        versioned: true,
        glob: selected.entry.canonical.glob,
      };
    } else {
      canonical = {
        dir: vendoredDir,
        versioned: false,
        file: selected.entry.canonical.file,
      };
    }
    const entry: AgentEntry = {
      name,
      layer: "personal",
      canonical,
      targets,
    };
    if (opts.bodyException !== undefined && opts.bodyException.length > 0) {
      entry.body_exception = opts.bodyException;
    }

    // (a) Validate the new entry shape.
    const entryErr = validateAgentEntry(entry);
    if (entryErr !== null) {
      logError(`registry add: invalid agent entry: ${entryErr}`);
      return 1;
    }

    // Read current overlay.
    let overlay: Overlay;
    try {
      overlay = readOverlay(overlayPath);
    } catch (err) {
      logError((err as Error).message);
      return 1;
    }

    // (b) Intra-overlay dedupe.
    if (overlay.agents.some((a) => a.name === name)) {
      logError(
        `registry add: an overlay agent named '${name}' already exists; ` +
          `remove it first or choose another name. Overlay unchanged: ${overlayPath}`,
      );
      return 1;
    }

    // (c) Core-collision reject.
    const projectRoot = opts.projectRoot ?? process.cwd();
    const baseNames = readBaseAgentNames(projectRoot);
    if (baseNames.has(name)) {
      logError(
        `registry add: '${name}' collides with a base (core) agent name; ` +
          "a personal customization must not shadow a core agent. Overlay unchanged.",
      );
      return 1;
    }

    // Append + validate the RESULT before persist.
    overlay.agents.push(entry);
    const overlayErr = validateOverlayShape(overlay);
    if (overlayErr !== null) {
      logError(`registry add: resulting overlay invalid: ${overlayErr}`);
      return 1;
    }

    // Vendor → persist overlay → record origin (same rollback discipline).
    let hash: string;
    try {
      vendorSurfaceAtomic(selected.srcDir, selected.files, vendoredDir);
      hash = hashSurface(vendoredDir, selected.files);
    } catch (err) {
      rmSync(vendoredDir, { recursive: true, force: true });
      logError(
        `registry add: failed to vendor canonical files: ${(err as Error).message}`,
      );
      return 1;
    }

    try {
      writeOverlayAtomic(overlayPath, overlay);
    } catch (err) {
      rmSync(vendoredDir, { recursive: true, force: true });
      logError(`registry add: failed to write overlay: ${(err as Error).message}`);
      return 1;
    }

    const originsPath = opts.originsPath ?? registryOriginsPath();
    try {
      const origins = readOrigins(originsPath);
      const origin: GithubOrigin = {
        type: "github",
        repo: `${spec.owner}/${spec.repo}`,
        ref: spec.ref,
        sha: fetched.sha,
        hash,
      };
      if (spec.subdir !== undefined) {
        origin.subdir = spec.subdir;
      }
      origins[name] = origin;
      writeOriginsAtomic(originsPath, origins);
    } catch (err) {
      logError(`registry add: failed to record origin: ${(err as Error).message}`);
      return 1;
    }

    info(
      `Registered personal agent '${name}' (vendored ${selected.files.length} ` +
        `file(s) from github:${spec.owner}/${spec.repo}@${spec.ref} into ${vendoredDir}) in ${overlayPath}`,
    );
    return 0;
  } finally {
    fetched.cleanup();
  }
}

function runList(overlayPath: string): number {
  let overlay: Overlay;
  try {
    overlay = readOverlay(overlayPath);
  } catch (err) {
    logError((err as Error).message);
    return 1;
  }
  if (overlay.agents.length === 0) {
    info("No personal agents registered.");
    return 0;
  }
  info(`Personal agents (${overlayPath}):`);
  for (const a of overlay.agents) {
    const layer = a.layer ?? "core";
    const targets = a.targets
      .map((t) => `${t.type}:${t.path}`)
      .join(", ");
    info(`  - ${a.name} [layer=${layer}] canonical.dir=${a.canonical.dir} targets=[${targets}]`);
  }
  return 0;
}

function runRemove(opts: RegistryOptions, overlayPath: string): number {
  if (opts.name === undefined || opts.name.length === 0) {
    logError("registry remove: <name> is required");
    return 2;
  }
  let overlay: Overlay;
  try {
    overlay = readOverlay(overlayPath);
  } catch (err) {
    logError((err as Error).message);
    return 1;
  }
  const before = overlay.agents.length;
  overlay.agents = overlay.agents.filter((a) => a.name !== opts.name);
  if (overlay.agents.length === before) {
    logError(
      `registry remove: no personal agent named '${opts.name}'. Overlay unchanged.`,
    );
    return 1;
  }
  // Keep a valid empty overlay rather than deleting the file.
  const overlayErr = validateOverlayShape(overlay);
  if (overlayErr !== null) {
    logError(`registry remove: resulting overlay invalid: ${overlayErr}`);
    return 1;
  }
  writeOverlayAtomic(overlayPath, overlay);

  // FR-142: drop the typed origin + the vendored copy (no orphan copies).
  const originsPath = opts.originsPath ?? registryOriginsPath();
  try {
    const origins = readOrigins(originsPath);
    if (opts.name in origins) {
      delete origins[opts.name];
      writeOriginsAtomic(originsPath, origins);
    }
  } catch {
    // A malformed origins sidecar should not block overlay removal; the
    // overlay (the compile-time truth) is already cleaned. Leave a note.
    info(`registry remove: could not update origins sidecar at ${originsPath}`);
  }
  const vendorDirFor = opts.vendorDir ?? registrySurfaceDirPath;
  rmSync(vendorDirFor(opts.name), { recursive: true, force: true });

  info(`Removed personal agent '${opts.name}' from ${overlayPath}`);
  return 0;
}

/**
 * The outcome of re-vendoring one entry. `changed`/`unchanged`/`skipped`
 * mirror FR-142; `origin` (when present) is the FULL updated origin to persist
 * (github advances ref/sha/hash; path advances hash only). `note` carries a
 * human-readable delta line for the report.
 */
type ReVendorResult =
  | {
      status: "changed" | "unchanged" | "skipped";
      origin?: Origin;
      note?: string;
    }
  | string;

/**
 * Re-vendor a single overlay entry from its recorded origin. Dispatches on
 * `origin.type`:
 *   - `path`   → re-resolve from the recorded source dir, hash-compare.
 *   - `github` → release-check; re-fetch + re-vendor when a newer release tag
 *                is found, advancing ref/sha/hash.
 *   - other / malformed github → graceful skip (FR-148 forward-compat).
 */
async function reVendorEntry(
  entry: AgentEntry,
  origin: Origin,
  vendoredDir: string,
  fetchRepo: FetchRepoFn,
  listReleases: ListReleasesFn,
): Promise<ReVendorResult> {
  if (origin.type === "path") {
    return reVendorPath(entry, origin, vendoredDir);
  }
  if (origin.type === "github") {
    return reVendorGithub(entry, origin, vendoredDir, fetchRepo, listReleases);
  }
  // Unknown origin type → defensive forward-compat skip.
  return { status: "skipped" };
}

/** FR-142 path re-vendor: hash-compare against the recorded origin. */
function reVendorPath(
  entry: AgentEntry,
  origin: PathOrigin,
  vendoredDir: string,
): ReVendorResult {
  // Re-resolve the source file set from the recorded origin dir + the entry's
  // versioned/glob/file. A versioned glob may now match a DIFFERENT set; the
  // vendor replaces the whole dir, so that is handled transparently.
  let resolved: ResolvedSource;
  if (entry.canonical.versioned) {
    const r = resolveSource(origin.dir, true, entry.canonical.glob, origin.dir);
    if (typeof r === "string") {
      return `error: ${r}`;
    }
    resolved = r;
  } else {
    const file = entry.canonical.file ?? "";
    const r = resolveSource(join(origin.dir, file), false, undefined, origin.dir);
    if (typeof r === "string") {
      return `error: ${r}`;
    }
    resolved = r;
  }
  try {
    vendorSurfaceAtomic(resolved.srcDir, resolved.files, vendoredDir);
  } catch (err) {
    return `error: failed to re-vendor: ${(err as Error).message}`;
  }
  const newHash = hashSurface(vendoredDir, resolved.files);
  return newHash === origin.hash
    ? { status: "unchanged", origin: { ...origin, hash: newHash } }
    : { status: "changed", origin: { ...origin, hash: newHash } };
}

/**
 * FR-148 github re-vendor: freshness is RELEASE-TAG comparison (not hash).
 * Lists releases, picks the newest tag strictly greater than the pinned ref,
 * and (if found) re-fetches + re-vendors at that tag, advancing ref/sha/hash.
 * A malformed github origin (missing repo/ref) → graceful skip with a note
 * (keeps the FR-142 forward-compat fixture green without a rewrite).
 */
async function reVendorGithub(
  entry: AgentEntry,
  origin: GithubOrigin,
  vendoredDir: string,
  fetchRepo: FetchRepoFn,
  listReleases: ListReleasesFn,
): Promise<ReVendorResult> {
  if (
    typeof origin.repo !== "string" ||
    origin.repo.length === 0 ||
    typeof origin.ref !== "string" ||
    origin.ref.length === 0
  ) {
    return { status: "skipped", note: "malformed github origin (missing repo/ref)" };
  }
  const slashIdx = origin.repo.indexOf("/");
  if (slashIdx < 0) {
    return { status: "skipped", note: "malformed github origin (repo not owner/repo)" };
  }
  const owner = origin.repo.slice(0, slashIdx);
  const repo = origin.repo.slice(slashIdx + 1);

  let tags: string[];
  try {
    tags = await listReleases(owner, repo);
  } catch (err) {
    return `error: failed to list releases: ${(err as Error).message}`;
  }
  if (tags.length === 0) {
    return { status: "unchanged", note: "no releases found (pinned ref unchanged)" };
  }
  const newer = pickNewerReleaseTag(origin.ref, tags);
  if (newer === null) {
    return { status: "unchanged", note: `up to date (pinned ${origin.ref})` };
  }

  // A newer release exists → re-fetch at the new tag + re-vendor.
  const spec: GithubSpec = origin.subdir !== undefined
    ? { owner, repo, ref: newer.tag, subdir: origin.subdir }
    : { owner, repo, ref: newer.tag };

  let fetched: FetchedRepo;
  try {
    fetched = await fetchRepo(spec);
  } catch (err) {
    return `error: failed to re-fetch ${origin.repo}@${newer.tag}: ${(err as Error).message}`;
  }
  try {
    const manifest = readRepoManifest(fetched.dir);
    if (typeof manifest === "string") {
      return `error: ${manifest}`;
    }
    const selected = selectSurface(manifest, entry.name, fetched.dir, origin.subdir);
    if (typeof selected === "string") {
      return `error: ${selected}`;
    }
    try {
      vendorSurfaceAtomic(selected.srcDir, selected.files, vendoredDir);
    } catch (err) {
      return `error: failed to re-vendor: ${(err as Error).message}`;
    }
    const newHash = hashFileSet(vendoredDir, selected.files);
    const updated: GithubOrigin = {
      ...origin,
      ref: newer.tag,
      sha: fetched.sha,
      hash: newHash,
    };
    const modeNote = newer.mode === "non-semver-pin" ? " [non-semver pin]" : "";
    return {
      status: "changed",
      origin: updated,
      note: `${origin.ref} -> ${newer.tag}${modeNote} (sha ${fetched.sha.slice(0, 7)})`,
    };
  } finally {
    fetched.cleanup();
  }
}

async function runUpdate(
  opts: RegistryOptions,
  overlayPath: string,
): Promise<number> {
  const hasName = opts.name !== undefined && opts.name.length > 0;
  const hasAll = opts.all === true;
  if (hasName === hasAll) {
    logError("registry update: provide exactly one of <name> or --all");
    return 2;
  }

  let overlay: Overlay;
  try {
    overlay = readOverlay(overlayPath);
  } catch (err) {
    logError((err as Error).message);
    return 1;
  }
  const originsPath = opts.originsPath ?? registryOriginsPath();
  let origins: OriginsMap;
  try {
    origins = readOrigins(originsPath);
  } catch (err) {
    logError((err as Error).message);
    return 1;
  }
  const vendorDirFor = opts.vendorDir ?? registrySurfaceDirPath;
  const fetchRepo = opts.fetchRepo ?? fetchRepoDefault;
  const listReleases = opts.listReleases ?? listReleasesDefault;

  // Build the work set: one named entry, or every recorded-origin entry under --all.
  let work: AgentEntry[];
  if (hasName) {
    const found = overlay.agents.find((a) => a.name === opts.name);
    if (found === undefined) {
      logError(`registry update: no personal agent named '${opts.name}'.`);
      return 1;
    }
    if (!(opts.name! in origins)) {
      logError(
        `registry update: '${opts.name}' has no recorded origin (cannot re-vendor).`,
      );
      return 1;
    }
    work = [found];
  } else {
    work = overlay.agents.filter((a) => a.name in origins);
    if (work.length === 0) {
      info("No origin-backed entries to update.");
      return 0;
    }
  }

  let originsChanged = false;
  let hadError = false;
  for (const entry of work) {
    const origin = origins[entry.name];
    const result = await reVendorEntry(
      entry,
      origin,
      vendorDirFor(entry.name),
      fetchRepo,
      listReleases,
    );
    if (typeof result === "string") {
      logError(`registry update: ${entry.name}: ${result.replace(/^error: /, "")}`);
      hadError = true;
      continue;
    }
    const noteSuffix = result.note !== undefined ? ` (${result.note})` : "";
    if (result.status === "skipped") {
      info(`  ${entry.name}: skipped${noteSuffix || ` (origin '${origin.type}')`}`);
      continue;
    }
    if (result.status === "changed") {
      if (result.origin !== undefined) {
        origins[entry.name] = result.origin;
      }
      originsChanged = true;
      info(`  ${entry.name}: changed${noteSuffix}`);
    } else {
      info(`  ${entry.name}: unchanged${noteSuffix}`);
    }
  }

  if (originsChanged) {
    try {
      writeOriginsAtomic(originsPath, origins);
    } catch (err) {
      logError(`registry update: failed to persist origins: ${(err as Error).message}`);
      return 1;
    }
  }
  return hadError ? 1 : 0;
}

/**
 * Run the registry verb. Returns an exit code:
 *   0 = success, 1 = enforcement reject, 2 = usage error (bad action/args).
 */
export async function runRegistry(opts: RegistryOptions): Promise<number> {
  const overlayPath = opts.overlayPath ?? registryOverlayPath();
  switch (opts.action) {
    case "add":
      return runAdd(opts, overlayPath);
    case "list":
      return runList(overlayPath);
    case "remove":
      return runRemove(opts, overlayPath);
    case "update":
      return runUpdate(opts, overlayPath);
    default:
      logError(
        `unknown registry action '${String(opts.action)}'. Valid: add, list, remove, update.`,
      );
      return 2;
  }
}
