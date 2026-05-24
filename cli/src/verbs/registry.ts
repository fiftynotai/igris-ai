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
  registryAgentDirPath,
  registryDirPath,
  registryOriginsPath,
  registryOverlayPath,
  registrySkillDirPath,
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

export type RegistryAction =
  | "add"
  | "add-skill"
  | "list"
  | "remove"
  | "update";

/** Allowed harness target types (mirrors manifest.schema.json target enum). */
const VALID_TARGET_TYPES = ["claude", "codex", "gemini"] as const;
type TargetType = (typeof VALID_TARGET_TYPES)[number];

/**
 * FR-143/FR-149: allowed SKILL target types. Mirrors
 * `$defs.skills_surface.targets.type` (codex / gemini / claude). The per-type
 * method allowlist is enforced by VALID_SKILL_TYPE_METHOD_PAIRS below.
 */
const VALID_SKILL_TARGET_TYPES = ["codex", "gemini", "claude"] as const;
type SkillTargetType = (typeof VALID_SKILL_TARGET_TYPES)[number];

/**
 * FR-143/FR-149: allowed SKILL target methods. `compiler` = the codex
 * AGENTS.md compiler; `converter` = the gemini per-skill TOML converter;
 * `symlink` = the claude registry-anchored per-skill symlink. Mirrors
 * `$defs.skills_surface.targets.method`.
 */
const VALID_SKILL_METHODS = ["compiler", "converter", "symlink"] as const;
type SkillMethod = (typeof VALID_SKILL_METHODS)[number];

/**
 * FR-149/FR-151/FR-153: allowed (type, method) pairs for skill targets.
 * Mirrors the `oneOf` constraint in `manifest.schema.json` and the
 * `valid_pairs` check in `_common.sh validate_manifest`. The legacy
 * codex/compiler + gemini/converter pairs were retired by FR-153.
 * See L-519, FR-153.
 */
const VALID_SKILL_TYPE_METHOD_PAIRS = new Set<string>([
  "claude/symlink",
  "codex/symlink",
  "gemini/symlink",
]);

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

/**
 * FR-143: one skill target — a `type:method:path` triple. `type` ∈
 * {codex,gemini}, `method` ∈ {compiler,converter}. `path` is the projection
 * output path (codex: an AGENTS.md file; gemini: an output dir).
 */
interface SkillTargetSpec {
  type: string;
  method: string;
  path: string;
}

/**
 * TD-191: ONE skills projection block. Multiple coexist as elements of
 * `surfaces.skills[]` (multi-source: a personal block compiles ALONGSIDE
 * the core block). `source` points at the VENDORED tree under the registry
 * (L-516 universal copy-vendor — `registrySkillDirPath(<name>)` for personal
 * blocks, the canonical skills dir for the core block). Mirrors
 * `$defs.skills_surface` in `manifest.schema.json`.
 */
interface SkillsSurface {
  source?: string;
  layer?: string;
  targets: SkillTargetSpec[];
}

/** The overlay file shape. TD-191: `surfaces.skills` is now an array of blocks. */
interface Overlay {
  $schema?: string;
  _comment?: string;
  _schema?: Record<string, unknown>;
  version: number;
  agents: AgentEntry[];
  surfaces?: { skills?: SkillsSurface[]; os_context?: Record<string, unknown> } & Record<
    string,
    unknown
  >;
}

/**
 * TD-191 helper: normalize `surfaces.skills` to a list of blocks.
 * Legacy single-object input → `[object]`; array input → as-is; absent → `[]`.
 * Mirrors the bash adapters' loader-side normalization so the TS writer
 * reads stale overlays the same way the compiler does (back-compat without
 * a version bump). See L-516 / TD-191 supersedes-section.
 */
function normalizeSkillsBlocks(value: unknown): SkillsSurface[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value as SkillsSurface[];
  }
  if (typeof value === "object") {
    return [value as SkillsSurface];
  }
  return [];
}

/**
 * TD-191 origin-key namespace helper. Returns `"agent:<name>"` /
 * `"skill:<name>"` so the `origins.json` keyspace cannot collide between an
 * agent and a skill of the same name. Per the brief's zero-migration
 * justification, `origins.json` did not exist on disk before TD-191; the
 * first write under this brief establishes the keyspace shape.
 */
function originKey(type: "agent" | "skill", name: string): string {
  return `${type}:${name}`;
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
  /** Test seam: agent vendor-dir base override (defaults to registryAgentDirPath()). */
  vendorDir?: (name: string) => string;
  /**
   * TD-191 test seam: skill vendor-dir base override (defaults to
   * `registrySkillDirPath()`). Parallels `vendorDir` for the L-516 skill
   * copy-vendor path so tests can sandbox the skill registry tree.
   */
  skillVendorDir?: (name: string) => string;
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

/**
 * FR-143: validate a `surfaces.skills` block field-for-field against
 * `manifest.schema.json` `$defs.skills_surface`. `additionalProperties:false`
 * → only `source`/`layer`/`targets` allowed; `targets` is a REQUIRED non-empty
 * array of `{type,method,path}` objects with the narrower skill enums. Returns
 * an error message, or null if valid.
 */
export function validateSkillsSurface(skills: unknown): string | null {
  if (typeof skills !== "object" || skills === null || Array.isArray(skills)) {
    return "surfaces.skills must be an object";
  }
  const s = skills as Record<string, unknown>;
  const allowedKeys = new Set(["source", "layer", "targets"]);
  for (const key of Object.keys(s)) {
    if (!allowedKeys.has(key)) {
      return `surfaces.skills: unknown key '${key}' (additionalProperties:false)`;
    }
  }
  if (!("targets" in s)) {
    return "surfaces.skills missing required key 'targets'";
  }
  if (s.source !== undefined && typeof s.source !== "string") {
    return "surfaces.skills.source must be a string";
  }
  if (s.layer !== undefined && typeof s.layer !== "string") {
    return "surfaces.skills.layer must be a string";
  }
  const targets = s.targets;
  if (!Array.isArray(targets) || targets.length < 1) {
    return "surfaces.skills.targets must be a non-empty array";
  }
  const allowedTargetKeys = new Set(["type", "method", "path"]);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      return `surfaces.skills.targets[${i}] must be an object`;
    }
    const tRec = t as Record<string, unknown>;
    for (const key of Object.keys(tRec)) {
      if (!allowedTargetKeys.has(key)) {
        return `surfaces.skills.targets[${i}]: unknown key '${key}' (additionalProperties:false)`;
      }
    }
    for (const req of ["type", "method", "path"]) {
      if (!(req in tRec)) {
        return `surfaces.skills.targets[${i}] missing required key '${req}'`;
      }
    }
    if (
      typeof tRec.type !== "string" ||
      typeof tRec.method !== "string" ||
      typeof tRec.path !== "string"
    ) {
      return `surfaces.skills.targets[${i}] type/method/path must be strings`;
    }
    if (!(VALID_SKILL_TARGET_TYPES as readonly string[]).includes(tRec.type)) {
      return `surfaces.skills.targets[${i}].type '${tRec.type}' is not one of ${JSON.stringify(VALID_SKILL_TARGET_TYPES)}`;
    }
    if (!(VALID_SKILL_METHODS as readonly string[]).includes(tRec.method)) {
      return `surfaces.skills.targets[${i}].method '${tRec.method}' is not one of ${JSON.stringify(VALID_SKILL_METHODS)}`;
    }
    // FR-153: per-type method allowlist mirrors schema `oneOf` + _common.sh.
    const pair = `${tRec.type}/${tRec.method}`;
    if (!VALID_SKILL_TYPE_METHOD_PAIRS.has(pair)) {
      return (
        `surfaces.skills.targets[${i}]: type/method pair '${pair}' is not allowed; ` +
        "valid pairs: claude/symlink, codex/symlink, gemini/symlink"
      );
    }
  }
  return null;
}

/**
 * TD-191: validate `surfaces.skills` as an ARRAY of `skills_surface` blocks
 * (the post-TD-191 schema shape). Rejects non-array input and empty array;
 * delegates per-block validation to `validateSkillsSurface` (unchanged
 * signature, so every pre-TD-191 test against a single block keeps passing).
 * Error messages get a `surfaces.skills[i]:` prefix so the offender block is
 * named. Used by `validateOverlayShape`'s skills branch — keeping the array
 * expectation overt at the call site rather than implicit via type coercion.
 */
export function validateSkillsSurfaceArray(skills: unknown): string | null {
  if (!Array.isArray(skills)) {
    return "surfaces.skills must be a non-empty array";
  }
  if (skills.length < 1) {
    return "surfaces.skills must be a non-empty array";
  }
  for (let i = 0; i < skills.length; i++) {
    const err = validateSkillsSurface(skills[i]);
    if (err !== null) {
      return `surfaces.skills[${i}]: ${err}`;
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
  // TD-191: `surfaces.skills` is an ARRAY of blocks. Calling the array
  // validator explicitly (not `validateSkillsSurface` directly) makes the
  // shape expectation overt at the boundary. `surfaces.os_context` stays
  // RESERVED/permissive (FR-140). Mirrors the schema's
  // `properties.surfaces.additionalProperties:false`.
  if (o.surfaces !== undefined) {
    if (
      typeof o.surfaces !== "object" ||
      o.surfaces === null ||
      Array.isArray(o.surfaces)
    ) {
      return "overlay 'surfaces' must be an object";
    }
    const surfaces = o.surfaces as Record<string, unknown>;
    const allowedSurfaceKeys = new Set(["skills", "os_context"]);
    for (const key of Object.keys(surfaces)) {
      if (!allowedSurfaceKeys.has(key)) {
        return `surfaces: unknown key '${key}' (additionalProperties:false)`;
      }
    }
    if (surfaces.skills !== undefined) {
      const skillsErr = validateSkillsSurfaceArray(surfaces.skills);
      if (skillsErr !== null) {
        return skillsErr;
      }
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

/**
 * TD-191: read the base manifest's CORE skill-target paths across ALL blocks
 * (post-TD-191 multi-source array model). Parallels `readBaseAgentNames`, but
 * unions `surfaces.skills[*].targets[].path`. The runtime merge guard in
 * `_common.sh merge_overlay_manifest` rejects any cross-block path collision;
 * this mirrors that check at write-time so the overlay never reaches a state
 * the merge would reject. Legacy single-object `surfaces.skills` is normalized
 * to `[object]` before iteration (back-compat). Absent/malformed base → empty
 * set.
 */
function readBaseSkillTargetPaths(projectRoot: string): Set<string> {
  const basePath = join(projectRoot, "harness-manifest.json");
  if (!existsSync(basePath)) {
    return new Set();
  }
  try {
    const base = JSON.parse(readFileSync(basePath, "utf-8")) as {
      surfaces?: { skills?: unknown };
    };
    const blocks = normalizeSkillsBlocks(base.surfaces?.skills);
    const paths = new Set<string>();
    for (const block of blocks) {
      for (const t of block?.targets ?? []) {
        if (typeof t?.path === "string") {
          paths.add(t.path);
        }
      }
    }
    return paths;
  } catch {
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
    // FR-151: include the harness-agnostic frontmatter.md sidecar if co-located.
    if (
      existsSync(join(srcDir, "frontmatter.md")) &&
      !entries.includes("frontmatter.md")
    ) {
      entries.push("frontmatter.md");
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
  // FR-151: include the harness-agnostic frontmatter.md sidecar if co-located.
  const files = [file];
  if (existsSync(join(srcDir, "frontmatter.md")) && file !== "frontmatter.md") {
    files.push("frontmatter.md");
  }
  return { srcDir, files };
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

/**
 * FR-152 + FR-144: resolve a personal-layer body-exception sidecar to its
 * absolute path under the runtime registry (`<brain>/registry/body-exceptions/
 * <name>.json`). Personal agents (the only layer the registry writer touches)
 * key their sidecars off the brain dir, mirroring
 * `compile_harnesses.sh:381-385`. Returns the resolved path when the sidecar
 * exists; returns undefined when no body-exception is configured. Throws when
 * declared but missing on disk — same posture as the bash adapter. See FR-144.
 */
function resolvePersonalBodyExceptionPath(
  bodyException: string | undefined,
): string | undefined {
  if (bodyException === undefined || bodyException.length === 0) {
    return undefined;
  }
  const sidecar = join(
    registryDirPath(),
    "body-exceptions",
    `${bodyException}.json`,
  );
  if (!existsSync(sidecar)) {
    throw new Error(
      `body-exception sidecar missing: ${sidecar}`,
    );
  }
  return sidecar;
}

/**
 * FR-152 α-assembly: derive `<vendoredDir>/harness.md` = `---\n<frontmatter>\n---\n\n<body>`.
 * Claude + gemini compile-time symlinks resolve to this ONE file. No-op when no
 * `frontmatter.md` sidecar exists (vendor-side assembly is opt-in via FR-151
 * sidecar presence; compile-side fallback handles core agents). See L-519.
 *
 * Picks the latest `system-prompt-v*.md` for versioned shape via `sort -V`
 * semantics (split on dots, numeric-compare components — ports
 * `_common.sh:latest_canonical`). For unversioned, uses the single non-sidecar
 * file. Atomic temp-then-rename. Body-exception applied when `bodyExceptionPath`
 * is non-empty (FR-144 + TD-193 regression guard).
 */
export function assembleAgentHarness(
  vendoredDir: string,
  files: string[],
  bodyExceptionPath?: string,
): void {
  const fmPath = join(vendoredDir, "frontmatter.md");
  if (!existsSync(fmPath)) {
    return; // assembly is opt-in via the FR-151 sidecar's presence
  }
  // Pick body file: prefer the latest versioned `system-prompt-v*.md`; else
  // the single non-sidecar file in the vendored set.
  const versioned = files.filter((f) => /^system-prompt-v[0-9]/.test(f));
  let bodyFile: string | undefined;
  if (versioned.length > 0) {
    bodyFile = pickLatestVersionedFile(versioned);
  } else {
    const nonSidecar = files.filter((f) => f !== "frontmatter.md");
    if (nonSidecar.length !== 1) {
      // No deterministic body: skip rather than guess (the operator can re-add
      // with a sharper glob).
      return;
    }
    bodyFile = nonSidecar[0];
  }
  if (bodyFile === undefined) {
    return;
  }
  // FR-151's frontmatter.md sidecar carries the SAME `---\n<fields>\n---\n`
  // shape as a canonical's inline frontmatter (verified by the FR-151 tests
  // at lines 326-329, 384-385). Strip the delimiters here so the α-assembled
  // `harness.md` doesn't double-wrap.
  const fmRaw = stripLeadingFrontmatterBlockToFields(
    readFileSync(fmPath, "utf-8"),
  ).trim();
  let body = readFileSync(join(vendoredDir, bodyFile), "utf-8");
  // Strip a leading `---\n...\n---\n` block from the body (some canonicals
  // carry inline frontmatter even when a sidecar is present; the sidecar
  // wins).
  body = stripLeadingFrontmatter(body);
  // FR-144 / TD-193: apply the body-exception appendix when provided. The
  // sidecar JSON shape (`{anchor, insert}`) matches what the runtime
  // body-exceptions/<name>.json files carry — see
  // ~/.igris/registry/body-exceptions/ + repo core/scripts/cli-adapters/
  // body-exceptions/ (FR-144 layer-keyed resolution; this helper is layer-
  // agnostic — callers pass the resolved path).
  if (bodyExceptionPath !== undefined && bodyExceptionPath.length > 0) {
    body = applyBodyException(body, bodyExceptionPath);
  }
  let text = `---\n${fmRaw}\n---\n\n${body}`;
  if (!text.endsWith("\n")) {
    text += "\n";
  }
  const out = join(vendoredDir, "harness.md");
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, out);
}

/**
 * FR-152: natural-sort versioned filename pick. Ports `sort -V` semantics by
 * splitting filename digits on dots and comparing components numerically.
 * Mirrors `_common.sh:latest_canonical` so the JS vendor path picks the same
 * file as the bash compile path. See L-519.
 */
function pickLatestVersionedFile(versioned: string[]): string | undefined {
  if (versioned.length === 0) return undefined;
  const tokenize = (name: string): number[] => {
    const m = name.match(/^system-prompt-v([0-9.]+)/);
    if (m === null) return [0];
    return m[1].split(".").map((p) => parseInt(p, 10) || 0);
  };
  const sorted = [...versioned].sort((a, b) => {
    const ta = tokenize(a);
    const tb = tokenize(b);
    const len = Math.max(ta.length, tb.length);
    for (let i = 0; i < len; i++) {
      const va = ta[i] ?? 0;
      const vb = tb[i] ?? 0;
      if (va !== vb) return va - vb;
    }
    return a.localeCompare(b);
  });
  return sorted[sorted.length - 1];
}

/**
 * FR-152: extract the FIELDS BLOCK out of an FR-151 frontmatter.md sidecar.
 * The sidecar's on-disk shape is `---\n<fields>\n---\n` (matches inline-
 * frontmatter convention). This helper returns only `<fields>` (without the
 * surrounding `---` delimiters) so `assembleAgentHarness` can re-wrap with its
 * own delimiters. When the input has no delimiters (e.g., a malformed sidecar
 * or a TD-195 inline-extracted tempfile that's already pre-stripped), returns
 * the input verbatim. Mirrors `_common.sh:parse_frontmatter` byte semantics.
 */
function stripLeadingFrontmatterBlockToFields(text: string): string {
  if (!text.startsWith("---")) return text;
  const lines = text.split("\n");
  if (lines[0] !== "---") return text;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return text;
  return lines.slice(1, endIdx).join("\n");
}

/**
 * FR-152: strip a leading `---\n...\n---\n` block from a markdown body. Mirrors
 * `_common.sh:strip_frontmatter` behavior so the JS assembly path produces the
 * same bytes as the bash compile-side path. Returns the body verbatim when no
 * frontmatter block is present.
 */
function stripLeadingFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const lines = text.split("\n");
  if (lines[0] !== "---") return text;
  let bodyStart = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      bodyStart = i + 1;
      break;
    }
  }
  if (bodyStart < 0) return text;
  // Trim leading blank lines from the body (matches the bash helper).
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") {
    bodyStart++;
  }
  return lines.slice(bodyStart).join("\n");
}

/**
 * FR-144 / TD-193: insert appendix lines after a unique `anchor` line in
 * `body`. Byte-for-byte semantics match the bash compile-side path's
 * `apply_body_exception` (in `assemble_agent_harness_into_registry`) so the JS
 * vendor path produces the same bytes. Throws on non-unique anchor (zero or
 * multiple matches).
 */
function applyBodyException(body: string, exceptionPath: string): string {
  const exc = JSON.parse(readFileSync(exceptionPath, "utf-8")) as {
    anchor: string;
    insert: string[];
  };
  const anchor = exc.anchor.trim();
  const insertLines = exc.insert;
  const bodyLines = body.split("\n");
  const matches: number[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i].trim() === anchor) matches.push(i);
  }
  if (matches.length !== 1) {
    throw new Error(
      `body-exception anchor matched ${matches.length} lines (expected exactly 1) in canonical body`,
    );
  }
  const idx = matches[0];
  const out = [
    ...bodyLines.slice(0, idx + 1),
    ...insertLines,
    ...bodyLines.slice(idx + 1),
  ];
  let result = out.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  return result;
}

/**
 * TD-191: enumerate `<name>/SKILL.md` entries under a skills source root.
 * Returns the list of skill subdir names that carry a `SKILL.md` (the same
 * shape the gemini converter's `find -mindepth 2 -maxdepth 2 -type f -name
 * 'SKILL.md'` walk discovers, mirrored in JS — see compile_harnesses.sh
 * lines 448-449 + check_harness_drift.sh 536-537).
 */
function enumerateSkillsAtRoot(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (existsSync(join(root, name, "SKILL.md"))) {
      out.push(name);
    }
  }
  return out;
}

/**
 * TD-191: atomically vendor a skill tree into `destDir`, preserving the
 * `<name>/SKILL.md` nesting load-bearing under L-519 (the per-harness gemini
 * converter + codex compiler both walk `find -mindepth 2 -maxdepth 2 -name
 * SKILL.md`; a flattened layout breaks them — verified at
 * compile_harnesses.sh:448-449 + check_harness_drift.sh:536-537).
 *
 * Accepts either shape for `srcDir`:
 *   - The `<root>/<name>/SKILL.md` SINGLE-skill source: when `srcDir`
 *     directly contains `SKILL.md`, the skill name is `basename(srcDir)`
 *     and the vendor copy lands at `<destDir>/<basename(srcDir)>/SKILL.md`.
 *   - A multi-skill root containing one or more `<name>/SKILL.md` entries:
 *     each `<name>/` subtree is copied verbatim under `<destDir>/<name>/`.
 *
 * Atomic: copy into a sibling temp dir on the SAME filesystem, then
 * `renameSync` over `destDir` (replacing any prior copy). No partial-vendor
 * window. Future remote-skill sources (L-515 sandbox containment) MUST clamp
 * resolved paths inside the fetch sandbox before calling this primitive.
 */
function vendorSkillTreeAtomic(srcDir: string, destDir: string): void {
  mkdirSync(dirname(destDir), { recursive: true });
  const tmp = `${destDir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    // Single-skill shape: srcDir/SKILL.md → tmp/<basename(srcDir)>/SKILL.md
    if (existsSync(join(srcDir, "SKILL.md"))) {
      const skillName = basename(srcDir);
      mkdirSync(join(tmp, skillName), { recursive: true });
      copySkillTreeRecursive(srcDir, join(tmp, skillName));
    } else {
      // Multi-skill root: copy every <name>/ that contains a SKILL.md.
      const names = enumerateSkillsAtRoot(srcDir);
      if (names.length === 0) {
        rmSync(tmp, { recursive: true, force: true });
        throw new Error(
          `no SKILL.md found under ${srcDir} (expected either ` +
            `<srcDir>/SKILL.md or <srcDir>/<name>/SKILL.md)`,
        );
      }
      for (const name of names) {
        mkdirSync(join(tmp, name), { recursive: true });
        copySkillTreeRecursive(join(srcDir, name), join(tmp, name));
      }
    }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  // Replace any prior vendored copy atomically.
  rmSync(destDir, { recursive: true, force: true });
  renameSync(tmp, destDir);
}

/**
 * Recursively copy a single skill's directory tree (files + nested
 * subdirs). Bash adapters copy SKILL.md only — but a skill MAY ship
 * supporting assets (scripts, fixtures), so we mirror the whole tree to
 * stay forward-compatible.
 */
function copySkillTreeRecursive(srcDir: string, destDir: string): void {
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const e of entries) {
    const s = join(srcDir, e.name);
    const d = join(destDir, e.name);
    if (e.isDirectory()) {
      mkdirSync(d, { recursive: true });
      copySkillTreeRecursive(s, d);
    } else if (e.isFile()) {
      copyFileSync(s, d);
    }
    // Symlinks intentionally skipped — vendor is bytes, not refs.
  }
}

/**
 * TD-191: stable content hash over a vendored skill tree. Folds every file's
 * relpath (sorted) + bytes into one sha256. Same idiom as `hashSurface` but
 * walks the full tree (skills can carry nested dirs). Used to detect source
 * mutation in `igris registry update` for skill blocks.
 */
function hashSkillTree(treeDir: string): string {
  const h = createHash("sha256");
  const rels: string[] = [];
  function walk(rel: string): void {
    const abs = rel === "" ? treeDir : join(treeDir, rel);
    const entries = readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        walk(childRel);
      } else if (e.isFile()) {
        rels.push(childRel);
      }
    }
  }
  if (existsSync(treeDir)) {
    walk("");
  }
  for (const rel of rels.sort()) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(treeDir, rel)));
  }
  return h.digest("hex");
}

/**
 * TD-191 path re-vendor for SKILLS. Mirrors `reVendorPath` semantics
 * (hash-compare against recorded origin) but uses `vendorSkillTreeAtomic` +
 * `hashSkillTree`. The vendored `destDir` is passed in (defaults to
 * `registrySkillDirPath(name)` at the call site) so tests can sandbox it.
 * Symmetric topology with agent updates per L-519 §18.1.
 */
function reVendorSkillPath(
  name: string,
  origin: Origin,
  destDir: string,
): ReVendorResult {
  void name; // reserved for future per-skill logging hooks
  if (origin.type !== "path") {
    return { status: "skipped", note: `non-path skill origin '${origin.type}'` };
  }
  try {
    vendorSkillTreeAtomic(origin.dir, destDir);
  } catch (err) {
    return `error: failed to re-vendor skill: ${(err as Error).message}`;
  }
  const newHash = hashSkillTree(destDir);
  return newHash === origin.hash
    ? { status: "unchanged", origin: { ...origin, hash: newHash } }
    : { status: "changed", origin: { ...origin, hash: newHash } };
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

/**
 * FR-143/FR-149: parse a SKILL `--target type:method:path` triple. Splits
 * the `type` off the first `:`, then the `method` off the next `:`;
 * everything remaining is the `path` (which MAY itself contain `:` —
 * preserved verbatim). Validates `type` ∈ {codex,gemini,claude}, `method` ∈
 * {compiler,converter,symlink}, and the per-type method allowlist via
 * VALID_SKILL_TYPE_METHOD_PAIRS (rejects e.g. claude/compiler). Returns
 * the target or an error message.
 */
function parseSkillTarget(spec: string): SkillTargetSpec | string {
  const firstIdx = spec.indexOf(":");
  if (firstIdx < 0) {
    return `--target '${spec}' must be of the form type:method:path`;
  }
  const type = spec.slice(0, firstIdx);
  const rest = spec.slice(firstIdx + 1);
  const secondIdx = rest.indexOf(":");
  if (secondIdx < 0) {
    return `--target '${spec}' must be of the form type:method:path`;
  }
  const method = rest.slice(0, secondIdx);
  const path = rest.slice(secondIdx + 1);
  if (!(VALID_SKILL_TARGET_TYPES as readonly string[]).includes(type)) {
    return `--target type '${type}' is not one of ${JSON.stringify(VALID_SKILL_TARGET_TYPES)}`;
  }
  if (!(VALID_SKILL_METHODS as readonly string[]).includes(method)) {
    return `--target method '${method}' is not one of ${JSON.stringify(VALID_SKILL_METHODS)}`;
  }
  if (path.length === 0) {
    return `--target '${spec}' has an empty path`;
  }
  // FR-153: per-type method allowlist (mirrors schema `oneOf` + _common.sh).
  const pair = `${type}/${method}`;
  if (!VALID_SKILL_TYPE_METHOD_PAIRS.has(pair)) {
    return (
      `--target '${spec}': type/method pair '${pair}' is not allowed; ` +
      "valid pairs: claude/symlink, codex/symlink, gemini/symlink"
    );
  }
  return { type: type as SkillTargetType, method: method as SkillMethod, path };
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
  const vendorDirFor = opts.vendorDir ?? registryAgentDirPath;
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
  // IGRIS_BRAIN_DIR test sandbox (which is where registryAgentDirPath lands).
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
    // FR-152 α-assembly: emit `<vendoredDir>/harness.md` alongside frontmatter +
    // body so claude/gemini compile-time symlinks resolve to ONE registry file.
    // No-op when no FR-151 sidecar exists. Hash is computed BEFORE assembly so
    // the derived file is excluded from origin freshness (downstream-derived).
    const bxPath = resolvePersonalBodyExceptionPath(entry.body_exception);
    assembleAgentHarness(vendoredDir, resolved.files, bxPath);
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

  // Record the typed origin (option (b): outside the manifest). TD-191:
  // keyspace is namespaced via `originKey("agent", name)` so a same-named
  // skill cannot collide. Zero-migration: origins.json did not exist on
  // disk before TD-191, so the first write under this brief establishes
  // the keyspace shape.
  const originsPath = opts.originsPath ?? registryOriginsPath();
  try {
    const origins = readOrigins(originsPath);
    origins[originKey("agent", opts.name)] = {
      type: "path",
      dir: resolved.srcDir,
      hash,
    };
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

  const vendorDirFor = opts.vendorDir ?? registryAgentDirPath;
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
      // FR-152 α-assembly (github path): mirrors the path-origin call above.
      // Personal layer body-exception sidecar resolution (FR-144). Hash already
      // computed before assembly to keep harness.md out of origin freshness.
      const bxPath = resolvePersonalBodyExceptionPath(entry.body_exception);
      assembleAgentHarness(vendoredDir, selected.files, bxPath);
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
      // TD-191: namespaced key (`agent:<name>`).
      origins[originKey("agent", name)] = origin;
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

/**
 * `add-skill` — register a personal SKILL projection in the overlay.
 *
 * Vendors the source tree into `~/.igris/registry/skills/<name>/`, persists
 * one block in `overlay.surfaces.skills[]` whose `source` points at the
 * vendored tree, and records a path origin keyed `skill:<name>`. A second
 * call with a DIFFERENT name appends a new block (multi-source); a second
 * call with the SAME name re-vendors atomically and updates the existing
 * block in place (hash-advance only; targets union; `--from` optional).
 *
 * Guard chain (overlay unchanged on any reject):
 *   1. parse each `type:method:path` triple (usage error → exit 2);
 *   2. validate the resulting `surfaces.skills` block shape;
 *   3. reject a target `path` colliding with a CORE skill-target path
 *      (mirrors the `_common.sh merge_overlay_manifest` cross-block guard
 *      at write-time);
 *   4. reject a target `path` already present in another overlay block
 *      (intra-overlay cross-block dedupe);
 *   5. atomic vendor → atomic overlay write → origin write (rollback the
 *      just-vendored tree on any post-vendor failure).
 *
 * See L-516 (universal copy-vendor), L-517 (typed-subfolder layout),
 * L-519 (Igris-owned topology — vendor preserves the standard format).
 * See L-515 — future remote-skill sources MUST clamp resolved paths inside
 * the fetch sandbox.
 */
function runAddSkill(opts: RegistryOptions, overlayPath: string): number {
  if (opts.name === undefined || opts.name.length === 0) {
    // `--name` is now REQUIRED (per L-516 + drift #7: block identity by name).
    // A `--from`-only run (legacy) cannot key origins or re-vendor the same
    // block in place. `--from` becomes optional on re-runs (see below) but the
    // name is always required.
    logError("registry add-skill: <name> is required");
    return 2;
  }
  if (!NAME_PATTERN.test(opts.name)) {
    logError(
      `registry add-skill: name '${opts.name}' must match /^[a-z0-9][a-z0-9-]*$/`,
    );
    return 2;
  }
  if (opts.targets === undefined || opts.targets.length === 0) {
    logError(
      "registry add-skill: at least one --target <type:method:path> is required",
    );
    return 2;
  }

  // Parse the skill targets (type:method:path triples).
  const newTargets: SkillTargetSpec[] = [];
  for (const spec of opts.targets) {
    const parsed = parseSkillTarget(spec);
    if (typeof parsed === "string") {
      logError(`registry add-skill: ${parsed}`);
      return 2;
    }
    newTargets.push(parsed);
  }

  const projectRoot = opts.projectRoot ?? process.cwd();
  const name = opts.name;
  const originsPath = opts.originsPath ?? registryOriginsPath();

  // FR-149: claude:symlink:<path> must NOT resolve INSIDE ~/.igris/registry/.
  // The symlink target IS the registry-vendored copy; aiming a claude target
  // there would create a self-referential symlink the compiler can't safely
  // follow. See L-515 (containment) + L-519.
  const registryRoot = registryDirPath();
  for (const t of newTargets) {
    if (t.type === "claude" && t.method === "symlink") {
      const resolved = resolveSourcePath(t.path, projectRoot);
      if (resolved === registryRoot || resolved.startsWith(`${registryRoot}/`)) {
        logError(
          `registry add-skill: claude:symlink target '${t.path}' resolves under ` +
            `the registry root (${registryRoot}); the symlink target IS the ` +
            "registry — pointing a target inside the registry creates a cycle. " +
            "Use a path under ~/.claude/skills/ or another consumer location.",
        );
        return 1;
      }
    }
  }

  // Read existing origins early so a same-name re-run can fall back to the
  // recorded origin's `dir` when `--from` is omitted (per drift #7).
  let origins: OriginsMap;
  try {
    origins = readOrigins(originsPath);
  } catch (err) {
    logError((err as Error).message);
    return 1;
  }
  const skillOriginKey = originKey("skill", name);
  const recordedOrigin: Origin | undefined = origins[skillOriginKey];

  // Resolve the consumer's source dir. `--from` wins; otherwise fall back to
  // the recorded origin's `dir` (drift #7 fallback). Either way the result
  // is an absolute path the L-515 sandbox guard owns (no traversal here).
  let consumerSourceDir: string;
  if (opts.from !== undefined && opts.from.length > 0) {
    consumerSourceDir = resolveSourcePath(opts.from, projectRoot);
  } else if (recordedOrigin !== undefined && recordedOrigin.type === "path") {
    consumerSourceDir = recordedOrigin.dir;
  } else {
    logError(
      `registry add-skill: --from <source-dir> is required (no recorded origin for '${name}')`,
    );
    return 2;
  }
  if (!existsSync(consumerSourceDir)) {
    logError(
      `registry add-skill: skills source dir does not exist: ${consumerSourceDir}`,
    );
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

  // Normalize legacy single-object `surfaces.skills` to array shape (back-compat).
  const existingBlocks = normalizeSkillsBlocks(overlay.surfaces?.skills);
  const existingBlockIndex = findSkillBlockIndex(overlay, name);

  // (intra-overlay cross-block dedupe) Reject a target `path` already present
  // in ANY OTHER overlay block (a same-name re-add is allowed to KEEP its own
  // targets — they're unioned in place, not duplicated).
  const otherBlockPaths = new Set<string>();
  for (let i = 0; i < existingBlocks.length; i++) {
    if (i === existingBlockIndex) {
      continue;
    }
    for (const t of existingBlocks[i]?.targets ?? []) {
      if (typeof t?.path === "string") {
        otherBlockPaths.add(t.path);
      }
    }
  }
  for (const t of newTargets) {
    if (otherBlockPaths.has(t.path)) {
      logError(
        `registry add-skill: skill-target path '${t.path}' already exists in ` +
          `another overlay block; remove it first or choose another path. ` +
          `Overlay unchanged: ${overlayPath}`,
      );
      return 1;
    }
  }

  // (core-collision reject) Mirror the _common.sh merge guard at write-time.
  const baseSkillPaths = readBaseSkillTargetPaths(projectRoot);
  for (const t of newTargets) {
    if (baseSkillPaths.has(t.path)) {
      logError(
        `registry add-skill: skill-target path '${t.path}' collides with a base ` +
          "(core) skill-target; a personal skill must not shadow a core skill. " +
          "Overlay unchanged.",
      );
      return 1;
    }
  }

  // Existing block's targets (when re-adding the same name) — union below.
  const existingOwnTargets: SkillTargetSpec[] =
    existingBlockIndex >= 0
      ? (existingBlocks[existingBlockIndex]?.targets ?? [])
      : [];
  const existingOwnPaths = new Set(existingOwnTargets.map((t) => t.path));
  // Append-only union (skip exact dup paths in the same block — idempotent).
  const unionedTargets: SkillTargetSpec[] = [...existingOwnTargets];
  for (const t of newTargets) {
    if (!existingOwnPaths.has(t.path)) {
      unionedTargets.push(t);
      existingOwnPaths.add(t.path);
    }
  }

  // Build the block. `source` points at the VENDORED tree per L-516.
  const skillVendorDirFor = opts.skillVendorDir ?? registrySkillDirPath;
  const vendoredDir = skillVendorDirFor(name);
  const newBlock: SkillsSurface = {
    source: vendoredDir,
    layer: "personal",
    targets: unionedTargets,
  };

  // Per-block validation. (validateSkillsSurfaceArray is the array gate that
  // runs as part of validateOverlayShape later — this is a quick local check
  // so the block-level error names the offender clearly.)
  const blockErr = validateSkillsSurface(newBlock);
  if (blockErr !== null) {
    logError(`registry add-skill: invalid skills block: ${blockErr}`);
    return 1;
  }

  // Splice the block into the overlay's blocks array (in place at the existing
  // index if same-name; appended otherwise).
  const mergedBlocks =
    existingBlockIndex >= 0
      ? existingBlocks.map((b, i) => (i === existingBlockIndex ? newBlock : b))
      : [...existingBlocks, newBlock];

  const surfaces = { ...(overlay.surfaces ?? {}) };
  surfaces.skills = mergedBlocks;
  overlay.surfaces = surfaces;

  // Validate the WHOLE overlay (defense-in-depth) before any side effect.
  const overlayErr = validateOverlayShape(overlay);
  if (overlayErr !== null) {
    logError(`registry add-skill: resulting overlay invalid: ${overlayErr}`);
    return 1;
  }

  // All guards passed → atomic vendor → atomic overlay write → origin write.
  // Rollback the just-vendored tree on any post-vendor failure (mirror
  // runAddAgent's cleanup at lines 962/970/1129/1139).
  let newHash: string;
  try {
    vendorSkillTreeAtomic(consumerSourceDir, vendoredDir);
    newHash = hashSkillTree(vendoredDir);
  } catch (err) {
    rmSync(vendoredDir, { recursive: true, force: true });
    logError(
      `registry add-skill: failed to vendor skill tree: ${(err as Error).message}`,
    );
    return 1;
  }

  try {
    writeOverlayAtomic(overlayPath, overlay);
  } catch (err) {
    rmSync(vendoredDir, { recursive: true, force: true });
    logError(
      `registry add-skill: failed to write overlay: ${(err as Error).message}`,
    );
    return 1;
  }

  // Record/advance the origin (path origin; key = `skill:<name>`).
  try {
    origins[skillOriginKey] = {
      type: "path",
      dir: consumerSourceDir,
      hash: newHash,
    };
    writeOriginsAtomic(originsPath, origins);
  } catch (err) {
    logError(`registry add-skill: failed to record origin: ${(err as Error).message}`);
    return 1;
  }

  const verb = existingBlockIndex >= 0 ? "Re-vendored" : "Registered";
  info(
    `${verb} personal skill '${name}' (vendored tree at ${vendoredDir}, ` +
      `${unionedTargets.length} target(s)) in ${overlayPath}`,
  );
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

  // FR-142: drop the typed origin + the vendored copy (no orphan copies).
  // TD-191: namespaced origin key (`agent:<name>`).
  const originsPath = opts.originsPath ?? registryOriginsPath();
  const agentOriginKey = originKey("agent", opts.name);
  try {
    const origins = readOrigins(originsPath);
    if (agentOriginKey in origins) {
      delete origins[agentOriginKey];
      writeOriginsAtomic(originsPath, origins);
    }
  } catch {
    // A malformed origins sidecar should not block overlay removal; the
    // overlay (the compile-time truth) is already cleaned. Leave a note.
    info(`registry remove: could not update origins sidecar at ${originsPath}`);
  }
  const vendorDirFor = opts.vendorDir ?? registryAgentDirPath;
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
    // FR-152 α-assembly on re-vendor: regenerate harness.md from the freshly
    // re-vendored frontmatter + body. Idempotent — same inputs → same bytes.
    const bxPath = resolvePersonalBodyExceptionPath(entry.body_exception);
    assembleAgentHarness(vendoredDir, resolved.files, bxPath);
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
      // FR-152 α-assembly on github re-vendor: same idempotent regeneration.
      const bxPath = resolvePersonalBodyExceptionPath(entry.body_exception);
      assembleAgentHarness(vendoredDir, selected.files, bxPath);
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

/**
 * TD-191: locate the skill block matching `name` in `overlay.surfaces.skills`.
 * A personal block's `source` is `registrySkillDirPath(<name>)` (L-516 +
 * L-517) so its basename is the skill name. Returns the block index, or -1
 * if no block matches.
 */
function findSkillBlockIndex(overlay: Overlay, name: string): number {
  const blocks = overlay.surfaces?.skills;
  if (!Array.isArray(blocks)) {
    return -1;
  }
  for (let i = 0; i < blocks.length; i++) {
    const src = blocks[i]?.source;
    if (typeof src === "string" && basename(src) === name) {
      return i;
    }
  }
  return -1;
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
  const agentVendorDirFor = opts.vendorDir ?? registryAgentDirPath;
  const skillVendorDirFor = opts.skillVendorDir ?? registrySkillDirPath;
  const fetchRepo = opts.fetchRepo ?? fetchRepoDefault;
  const listReleases = opts.listReleases ?? listReleasesDefault;

  /**
   * Per-entry work item — TD-191 supports BOTH agents and skills under one
   * update protocol. `kind` distinguishes the dispatch arm; `name` is the
   * (namespaced) origin-key lookup; `entry`/`blockIndex` carry the live
   * overlay reference for the re-vendor step.
   */
  type WorkItem =
    | { kind: "agent"; name: string; entry: AgentEntry }
    | { kind: "skill"; name: string; blockIndex: number };

  // Build the work set: one named entry, or every namespaced-origin entry
  // under --all (selected by the `agent:`/`skill:` originKey prefix).
  const work: WorkItem[] = [];
  if (hasName) {
    const name = opts.name!;
    const agentEntry = overlay.agents.find((a) => a.name === name);
    const skillIdx = findSkillBlockIndex(overlay, name);
    const agentKey = originKey("agent", name);
    const skillKey = originKey("skill", name);
    const hasAgent = agentEntry !== undefined && agentKey in origins;
    const hasSkill = skillIdx >= 0 && skillKey in origins;
    if (!hasAgent && !hasSkill) {
      if (agentEntry === undefined && skillIdx < 0) {
        logError(`registry update: no personal agent or skill named '${name}'.`);
      } else {
        logError(
          `registry update: '${name}' has no recorded origin (cannot re-vendor).`,
        );
      }
      return 1;
    }
    if (hasAgent) {
      work.push({ kind: "agent", name, entry: agentEntry });
    }
    if (hasSkill) {
      work.push({ kind: "skill", name, blockIndex: skillIdx });
    }
  } else {
    // --all: iterate origins keyspace, prefix-matched. Agents + skills share
    // one protocol (L-519 §18.1: symmetric topology — future MCPs follow).
    for (const key of Object.keys(origins)) {
      if (key.startsWith("agent:")) {
        const name = key.slice("agent:".length);
        const entry = overlay.agents.find((a) => a.name === name);
        if (entry !== undefined) {
          work.push({ kind: "agent", name, entry });
        }
      } else if (key.startsWith("skill:")) {
        const name = key.slice("skill:".length);
        const idx = findSkillBlockIndex(overlay, name);
        if (idx >= 0) {
          work.push({ kind: "skill", name, blockIndex: idx });
        }
      }
    }
    if (work.length === 0) {
      info("No origin-backed entries to update.");
      return 0;
    }
  }

  let originsChanged = false;
  let hadError = false;
  for (const item of work) {
    if (item.kind === "agent") {
      const key = originKey("agent", item.name);
      const origin = origins[key];
      const result = await reVendorEntry(
        item.entry,
        origin,
        agentVendorDirFor(item.name),
        fetchRepo,
        listReleases,
      );
      if (typeof result === "string") {
        logError(`registry update: ${item.name}: ${result.replace(/^error: /, "")}`);
        hadError = true;
        continue;
      }
      const noteSuffix = result.note !== undefined ? ` (${result.note})` : "";
      if (result.status === "skipped") {
        info(
          `  ${item.name}: skipped${noteSuffix || ` (origin '${origin.type}')`}`,
        );
        continue;
      }
      if (result.status === "changed") {
        if (result.origin !== undefined) {
          origins[key] = result.origin;
        }
        originsChanged = true;
        info(`  ${item.name}: changed${noteSuffix}`);
      } else {
        info(`  ${item.name}: unchanged${noteSuffix}`);
      }
    } else {
      // kind === "skill"
      const key = originKey("skill", item.name);
      const origin = origins[key];
      const result = reVendorSkillPath(
        item.name,
        origin,
        skillVendorDirFor(item.name),
      );
      if (typeof result === "string") {
        logError(`registry update: ${item.name}: ${result.replace(/^error: /, "")}`);
        hadError = true;
        continue;
      }
      const noteSuffix = result.note !== undefined ? ` (${result.note})` : "";
      if (result.status === "skipped") {
        info(
          `  ${item.name}: skipped${noteSuffix || ` (origin '${origin.type}')`}`,
        );
        continue;
      }
      if (result.status === "changed") {
        if (result.origin !== undefined) {
          origins[key] = result.origin;
        }
        originsChanged = true;
        info(`  ${item.name}: changed${noteSuffix}`);
      } else {
        info(`  ${item.name}: unchanged${noteSuffix}`);
      }
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
    case "add-skill":
      return runAddSkill(opts, overlayPath);
    case "list":
      return runList(overlayPath);
    case "remove":
      return runRemove(opts, overlayPath);
    case "update":
      return runUpdate(opts, overlayPath);
    default:
      logError(
        `unknown registry action '${String(opts.action)}'. Valid: add, add-skill, list, remove, update.`,
      );
      return 2;
  }
}
