/**
 * `igris registry <add|list|remove> [options]` — the FR-141 Layer-2
 * customization-registry overlay WRITER.
 *
 * Writes the runtime-only personal overlay
 * `~/.igris/registry/harness-manifest.personal.json`, which the already-live
 * FR-136 merge seam (`compile_harnesses.sh` / `check_harness_drift.sh`)
 * auto-discovers and merges with the project's base `harness-manifest.json`.
 * FR-141 only WRITES the overlay — no schema or adapter change.
 *
 * The load-bearing logic is the write-path enforcement:
 *   1. intra-overlay dedupe (the bash merge only dedupes overlay-vs-base,
 *      NOT overlay-vs-overlay — this verb closes that gap),
 *   2. core-collision reject at write-time (mirrors the merge guard in
 *      `_common.sh` `merge_overlay_manifest`, by reading the base manifest),
 *   3. TS schema-shape validation before persist (port of the load-bearing
 *      rules below), and
 *   4. atomic persist (temp file + rename).
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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registryOverlayPath } from "../lib/paths.js";
import { info, error as logError } from "../lib/log.js";

export type RegistryAction = "add" | "list" | "remove";

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

export interface RegistryOptions {
  /** Which sub-verb to run. */
  action: RegistryAction;
  /** Agent name (add/remove). */
  name?: string;
  /** Canonical prompt dir-or-file. Unversioned: dir+file derived from this. */
  canonical?: string;
  /** Canonical is versioned (requires `glob`). */
  versioned?: boolean;
  /** Filename glob (versioned only). */
  glob?: string;
  /** Output targets, each `type:path` (repeatable). */
  targets?: string[];
  /** Optional body-exception sidecar basename. */
  bodyException?: string;
  /** Root for base-manifest collision check (default: cwd). */
  projectRoot?: string;
  /** Test seam: overlay path override (defaults to registryOverlayPath()). */
  overlayPath?: string;
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

function runAdd(opts: RegistryOptions, overlayPath: string): number {
  if (opts.name === undefined || opts.name.length === 0) {
    logError("registry add: <name> is required");
    return 2;
  }
  if (opts.canonical === undefined || opts.canonical.length === 0) {
    logError("registry add: --canonical <dir-or-file> is required");
    return 2;
  }
  if (opts.targets === undefined || opts.targets.length === 0) {
    logError("registry add: at least one --target <type:path> is required");
    return 2;
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

  // Build the canonical spec.
  let canonical: CanonicalSpec;
  if (opts.versioned === true) {
    if (opts.glob === undefined || opts.glob.length === 0) {
      logError("registry add: --versioned requires --glob <g>");
      return 2;
    }
    // For a versioned canonical, --canonical is the dir.
    canonical = { dir: opts.canonical, versioned: true, glob: opts.glob };
  } else {
    if (opts.glob !== undefined) {
      logError("registry add: --glob is only valid with --versioned");
      return 2;
    }
    // Unversioned: --canonical is a dir/file; derive dir + file.
    const idx = opts.canonical.lastIndexOf("/");
    const dir = idx >= 0 ? opts.canonical.slice(0, idx) : ".";
    const file = idx >= 0 ? opts.canonical.slice(idx + 1) : opts.canonical;
    if (file.length === 0) {
      logError(
        "registry add: --canonical must include a filename when not --versioned",
      );
      return 2;
    }
    canonical = { dir, versioned: false, file };
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
  const projectRoot = opts.projectRoot ?? process.cwd();
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

  writeOverlayAtomic(overlayPath, overlay);
  info(`Registered personal agent '${opts.name}' in ${overlayPath}`);
  return 0;
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
  info(`Removed personal agent '${opts.name}' from ${overlayPath}`);
  return 0;
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
    default:
      logError(
        `unknown registry action '${String(opts.action)}'. Valid: add, list, remove.`,
      );
      return 2;
  }
}
