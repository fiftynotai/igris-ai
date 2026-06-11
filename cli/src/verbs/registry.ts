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
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import {
  registryAgentDirPath,
  registryDirPath,
  registryOriginsPath,
  registryOverlayPath,
  registrySkillDirPath,
  coreSurfacesManifestPath,
  claudeJsonPath,
  geminiSettingsPath,
  antigravityMcpConfigPath,
  codexConfigTomlPath,
  opencodeConfigPath,
  brainDir,
  projectSettingsPath,
} from "../lib/paths.js";
import { info, error as logError } from "../lib/log.js";
import { buildHarnessMcpEntry, type McpHarness } from "../lib/mcp-shape.js";
import { buildClaudeHookGroup } from "../lib/hook-shape.js";
import {
  mergeHookIntoSettings,
  HookMergeShapeError,
  resolveHookCommandPath,
} from "../lib/hook-merge.js";
import { parseSecretsEnv } from "../lib/secrets.js";
import {
  mergeJsonConfig,
  mergeTomlConfig,
  type TomlMcpEntry,
} from "../lib/mcp-register.js";
import {
  isGithubSpec,
  parseGithubSpec,
  readRepoManifest,
  selectSurface,
  pickNewerReleaseTag,
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
  | "add-mcp"
  | "add-identity"
  | "add-hook"
  | "project-mcp"
  | "project-hook"
  | "list"
  | "remove"
  | "update";

/** Allowed harness target types (mirrors manifest.schema.json target enum).
 * FR-171: `opencode` added as a first-class agent target (OpenCode's agent
 * loader follows symlinks — projects a registry-anchored symlink to
 * harness.opencode.md, same primitive as claude). */
const VALID_TARGET_TYPES = ["claude", "codex", "gemini", "opencode"] as const;
type TargetType = (typeof VALID_TARGET_TYPES)[number];

/**
 * FR-143/FR-149/FR-157/FR-171: allowed SKILL target types. Mirrors
 * `$defs.skills_surface.targets.type` (codex / gemini / claude / agents /
 * opencode). The per-type method allowlist is enforced by
 * VALID_SKILL_TYPE_METHOD_PAIRS below. `agents` is the FR-157 cross-CLI shared
 * `~/.agents/skills/` target; `opencode` (FR-171) is the OpenCode command
 * surface (thin `@file` wrappers, NOT symlinks).
 */
const VALID_SKILL_TARGET_TYPES = ["codex", "gemini", "claude", "agents", "opencode"] as const;
type SkillTargetType = (typeof VALID_SKILL_TARGET_TYPES)[number];

/**
 * FR-143/FR-149/FR-171: allowed SKILL target methods. `compiler` = the codex
 * AGENTS.md compiler (retired); `converter` = the gemini per-skill TOML
 * converter (retired); `symlink` = the registry-anchored per-skill symlink;
 * `command` = the FR-171 OpenCode thin command wrapper. Mirrors
 * `$defs.skills_surface.targets.method`.
 */
const VALID_SKILL_METHODS = ["compiler", "converter", "symlink", "command"] as const;
type SkillMethod = (typeof VALID_SKILL_METHODS)[number];

/**
 * FR-149/FR-151/FR-153/FR-157/FR-171: allowed (type, method) pairs for skill
 * targets. Mirrors the `oneOf` constraint in `manifest.schema.json` and the
 * `valid_pairs` check in `_common.sh validate_manifest`. The legacy
 * codex/compiler + gemini/converter pairs were retired by FR-153.
 * `agents/symlink` (FR-157) is the cross-CLI shared `~/.agents/skills/`
 * target that codex+gemini both read natively. `opencode/command` (FR-171) is
 * the OpenCode command-wrapper pair. See L-519, FR-153, FR-157, FR-171.
 */
const VALID_SKILL_TYPE_METHOD_PAIRS = new Set<string>([
  "claude/symlink",
  "codex/symlink",
  "gemini/symlink",
  "agents/symlink",
  "opencode/command",
]);

/**
 * FR-161 (FR-160 epic): allowed MCP target types. SEPARATE from the agent
 * (`VALID_TARGET_TYPES`) and skill (`VALID_SKILL_TARGET_TYPES`) enums — MCP
 * adds a 4th harness, `opencode`, and MUST NOT widen those surfaces. Mirrors
 * `$defs.mcp_surface.targets.type` in manifest.schema.json.
 */
const VALID_MCP_TARGET_TYPES = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "antigravity",
] as const;
type McpTargetType = (typeof VALID_MCP_TARGET_TYPES)[number];

/**
 * FR-161: MCP projection is always config-MERGE (not symlink/compiler).
 * Mirrors `$defs.mcp_surface.targets.method` (`const "merge"`).
 */
const VALID_MCP_METHODS = ["merge"] as const;
type McpMethod = (typeof VALID_MCP_METHODS)[number];

/**
 * FR-180 (D6): allowed os_identity target types. SEPARATE enum (parity with the
 * MCP one) — the identity surface carries the 4-harness enum. Mirrors
 * `$defs.identity_surface.targets.type` in manifest.schema.json.
 */
const VALID_IDENTITY_TARGET_TYPES = ["claude", "codex", "gemini", "opencode"] as const;
type IdentityTargetType = (typeof VALID_IDENTITY_TARGET_TYPES)[number];

/**
 * FR-180 (D6): identity projection is always a region-merge `file` write (the
 * Igris-managed delimited region in the harness's natively auto-read identity
 * file). Mirrors `$defs.identity_surface.targets.method` (`const "file"`).
 */
const VALID_IDENTITY_METHODS = ["file"] as const;
type IdentityMethod = (typeof VALID_IDENTITY_METHODS)[number];

/**
 * FR-180 (D7): allowed hook target types. SEPARATE enum — the hook surface
 * carries only the TWO harnesses with a native hook MERGE surface (claude →
 * settings.json hooks array; opencode → the FR-104 plugin). codex (session_end
 * only) + gemini (no hook API) are documented, not projection targets. Mirrors
 * `$defs.hook_surface.targets.type`.
 */
const VALID_HOOK_TARGET_TYPES = ["claude", "opencode"] as const;
type HookTargetType = (typeof VALID_HOOK_TARGET_TYPES)[number];

/** FR-180 (D7): hook projection is always a config-merge. Mirrors the schema const. */
const VALID_HOOK_METHODS = ["merge"] as const;
type HookMethod = (typeof VALID_HOOK_METHODS)[number];

/**
 * FR-180 (D7): the six PORTABLE_EVENTS a hook can fire on — byte-identical to
 * PORTABLE_EVENTS in cli/src/lib/json-merge.ts and the
 * canonical-settings.json block. Mirrors `$defs.hook_surface.event`.
 */
const VALID_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
] as const;
type HookEvent = (typeof VALID_HOOK_EVENTS)[number];

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

/**
 * FR-155: scope-aware overlay. Absent → global (default, back-compat with
 * pre-FR-155 overlays). `{type:"global"}` is also accepted; the compiler/drift
 * treat both as 'emit unconditionally'. `{type:"project", paths:[...realpath'd
 * project roots...]}` emits ONLY when --project-root realpath equals the
 * realpath of at least one entry in paths[]. CLI realpath's `--project` at
 * WRITE time so paths[] is canonical absolute (handles macOS /tmp ↔
 * /private/tmp); compile/drift realpath both --project-root and each entry at
 * READ time so the two sides agree regardless of which TMPDIR shape the
 * operator hands in. Mirrors `$defs.scope` in manifest.schema.json.
 */
export type Scope =
  | { type: "global" }
  | { type: "project"; paths: string[] };

interface AgentEntry {
  name: string;
  layer?: string;
  canonical: CanonicalSpec;
  body_exception?: string;
  scope?: Scope;
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
  /** FR-155: see {@link Scope}. Absent → global (default, back-compat). */
  scope?: Scope;
  targets: SkillTargetSpec[];
}

/**
 * FR-161 (FR-160 epic): one MCP target — a `type` + `method` (+ optional
 * `enabled`). `type` ∈ {claude,codex,gemini,opencode}, `method` is always
 * "merge". Mirrors one item of `$defs.mcp_surface.targets`. The `McpTargetType`
 * / `McpMethod` aliases (derived from the SEPARATE enums) keep the field types
 * tied to the same allowlist the validator enforces — the FR-162 write-path
 * reuses these casts at its parse boundary.
 */
interface McpTarget {
  type: McpTargetType;
  method: McpMethod;
  enabled?: boolean;
}

/**
 * FR-161: the canonical MCP launch spec, declared ONCE. `command` is required;
 * `args`/`env` default to []/{}. `env` values are ${VAR} references (the
 * FR-162 write-path verb enforces that — FR-161 only shape-checks types).
 * `startup_timeout_sec` is a Codex-only passthrough. Mirrors
 * `$defs.mcp_surface.canonical`.
 */
interface McpCanonical {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  startup_timeout_sec?: number;
}

/**
 * FR-161 (FR-160 epic): ONE MCP-server projection block. Multiple coexist as
 * elements of `surfaces.mcp_servers[]` (multi-source, like `skills`). v1 is
 * GLOBAL-ONLY — `scope` is accepted for forward-compat but consumers treat
 * every block as global. Mirrors `$defs.mcp_surface` in manifest.schema.json.
 */
interface McpServersSurface {
  name: string;
  layer?: string;
  /** FR-155-style scope. Absent → global. v1 consumers treat ALL as global. */
  scope?: Scope;
  canonical: McpCanonical;
  targets: McpTarget[];
}

/**
 * FR-180 (D6): one os_identity target — a `type` + `method:"file"` +
 * `filename` (the harness's natively auto-read identity file the Igris-managed
 * region merges into, e.g. GEMINI.md / AGENTS.md). Mirrors one item of
 * `$defs.identity_surface.targets`.
 */
interface IdentityTarget {
  type: IdentityTargetType;
  method: IdentityMethod;
  filename: string;
}

/**
 * FR-180 (D6): ONE os_identity projection block. Multiple coexist as elements
 * of `surfaces.os_identity[]` (multi-block, like `skills`/`mcp_servers`). An
 * identity block has NO `name` (it is keyed by its (type, filename) target
 * pairs). `source` is the canonical identity template; `version_source`
 * resolves {{IGRIS_VERSION}}; both default per the schema when absent. v1
 * projects every block (scope-filtered); the FR-180 personal write path emits
 * a project-scoped block. Mirrors `$defs.identity_surface`.
 */
interface IdentitySurface {
  source?: string;
  version_source?: string;
  layer?: string;
  scope?: Scope;
  targets: IdentityTarget[];
}

/**
 * FR-180 (D7): one hook target — a `type` + `method:"merge"` + optional
 * `enabled`. Mirrors one item of `$defs.hook_surface.targets`.
 */
interface HookTarget {
  type: HookTargetType;
  method: HookMethod;
  enabled?: boolean;
}

/** FR-180 (D7): the canonical hook launch spec. Mirrors `$defs.hook_surface.canonical`. */
interface HookCanonical {
  command: string;
  matcher?: string;
  timeout?: number;
}

/**
 * FR-180 (D7): ONE event-hook projection block. Multiple coexist as elements of
 * `surfaces.hooks[]` (multi-block, like `mcp_servers`). A hook block IS keyed on
 * its `name`; `event` is one of the six PORTABLE_EVENTS; `canonical.command` is
 * the shared hook script the harness runs (a personal block's command lives
 * under ~/.igris/registry/hooks/<name>/ — the distinct provenance the canonical
 * re-merge preserves, fixing R2). Mirrors `$defs.hook_surface`.
 */
interface HookSurface {
  name: string;
  event: HookEvent;
  layer?: string;
  scope?: Scope;
  canonical: HookCanonical;
  targets: HookTarget[];
}

/** The overlay file shape. TD-191: `surfaces.skills` is now an array of blocks. */
interface Overlay {
  $schema?: string;
  _comment?: string;
  _schema?: Record<string, unknown>;
  version: number;
  agents: AgentEntry[];
  surfaces?: {
    skills?: SkillsSurface[];
    mcp_servers?: McpServersSurface[];
    /** FR-180 (D6): personal os_identity blocks (the v1 not-merged gate is lifted). */
    os_identity?: IdentitySurface[];
    /** FR-180 (D7): personal hook blocks (first-class surfaces.hooks[]). */
    hooks?: HookSurface[];
    os_context?: Record<string, unknown>;
  } & Record<string, unknown>;
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
function originKey(type: "agent" | "skill" | "mcp", name: string): string {
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
 * FR-162 (FR-160 epic) inline origin: provenance for an MCP server registered
 * by inline command-ref (`add-mcp --command ... --arg ...`), NOT vendored from
 * a source dir or git release. `command`/`args` mirror the canonical launch
 * spec at registration time; `hash` is a content hash over (command, args) for
 * future drift detection. `update --all` SKIPS this (no source to re-vendor) —
 * the `mcp:` key is not in its `agent:`/`skill:` keyspace, so an InlineOrigin
 * is inert to `update` by construction. FR-167 (`--from` bundle vendoring) will
 * record GithubOrigin/PathOrigin for vendored MCPs instead.
 */
export interface InlineOrigin {
  type: "inline";
  command: string;
  args: string[];
  hash: string;
}

/**
 * The typed origin recorded per surface, stored OUTSIDE the harness manifest
 * (option (b)) in `origins.json`. A discriminated union over `type`; the
 * compiler never reads this file (only `igris registry update` does).
 */
export type Origin = PathOrigin | GithubOrigin | InlineOrigin;

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
  /**
   * FR-155 `--project <path>`: opts into PROJECT scope for `add` / `add-skill`.
   * On a NEW entry, scope becomes `{type:"project", paths:[realpath(--project)]}`.
   * On a same-name re-add against an existing PROJECT entry, the realpath is
   * APPENDED to `paths[]` (idempotent — duplicate is silently dropped). On a
   * same-name re-add against an existing GLOBAL entry, the run ERRORs with an
   * actionable `--scope project` hint (the conversion path is explicit).
   * Absent → global default (the on-disk overlay omits the `scope` field for
   * minimal diff churn).
   */
  project?: string;
  /**
   * FR-155 `--scope <kind>`: explicit scope kind for `add` / `add-skill`. One
   * of "global" or "project". Used to CONVERT an existing entry between
   * scopes: `--scope project --project <path>` converts a global entry to
   * project scope (paths=[realpath]); `--scope global` converts a project
   * entry to global (paths dropped). Absent → no conversion; default-global
   * for a new entry.
   */
  scope?: "global" | "project";
  /**
   * FR-162 add-mcp: MCP launch command. Required for a NEW block; optional on a
   * same-name re-add (inherits the existing block's canonical command).
   */
  command?: string;
  /** FR-162 add-mcp: MCP launch args (repeatable --arg → args[]). */
  args?: string[];
  /**
   * FR-162 add-mcp: MCP env indirection refs as "KEY=${VAR}" strings
   * (repeatable --env). Each VALUE must be a single ${VAR} reference — inline
   * secrets are rejected at the verb boundary (FR-160 decision #1).
   */
  env?: string[];
  /**
   * FR-162 add-mcp: Codex-only startup-timeout passthrough (seconds). Parsed to
   * a number at the CLI boundary so the verb can trust the type.
   */
  startupTimeoutSec?: number;
  /**
   * FR-180 (D6) add-identity: canonical identity template path override
   * (`--source`). Absent → the schema default (<brain>/core/templates/
   * identity.tmpl) — the on-disk block omits the field for minimal diff.
   */
  identitySource?: string;
  /**
   * FR-180 (D6) add-identity: `{{IGRIS_VERSION}}` source path override
   * (`--version-source`). Absent → the schema default (<brain>/config.json).
   */
  identityVersionSource?: string;
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
  /**
   * FR-164 project-mcp: which harness to project ONE MCP block into. The bash
   * compile/drift driver loops the per-(mcp,target) rows and calls this verb
   * once per target, so a single invocation is a pure 1-config-write unit.
   */
  harness?: McpHarness;
  /**
   * FR-164 project-mcp test seam: override the harness config FILE path. When
   * absent the verb resolves it from `harness` (claudeJsonPath /
   * geminiSettingsPath / codexConfigTomlPath / opencodeConfigPath). Tests
   * sandbox the hot config via this seam.
   */
  configPath?: string;
  /**
   * FR-164 project-mcp test seam: override `~/.igris/secrets.env` (codex only).
   * Defaults to `secretsEnvPath()` (honored by `parseSecretsEnv`). Tests inject
   * a fixture secrets file. Never read for claude/gemini/opencode.
   */
  secretsPath?: string;
  /**
   * FR-180 (D7) add-hook / project-hook: the event the hook fires on (one of the
   * six PORTABLE_EVENTS). Required for `add-hook`; carried per-row by the bash
   * driver for `project-hook`.
   */
  event?: string;
  /** FR-180 (D7) add-hook: tool-name glob for Pre/PostToolUse (optional). */
  matcher?: string;
  /** FR-180 (D7) add-hook: per-hook timeout in seconds (optional). */
  timeout?: number;
  /**
   * FR-180 (D7) project-hook test seam: the project's `.claude/settings.json`
   * path. When absent the verb resolves it from `projectRoot`
   * (`<projectRoot>/.claude/settings.json`). Tests sandbox the file via this seam.
   */
  hookSettingsPath?: string;
  /**
   * FR-180 (D7) project-hook test seam: the registry hooks-script root the
   * personal `command` resolves against for the existence check. Defaults to
   * `<brain>/registry/hooks`. Tests point it at a fixture dir.
   */
  hookScriptRoot?: string;
}

// ---------------------------------------------------------------------------
// Schema-shape validators (port of manifest.schema.json + _common.sh fallback)
// ---------------------------------------------------------------------------

/**
 * FR-155: validate the optional `scope` field. Mirrors `$defs.scope` in
 * `manifest.schema.json` and `validate_scope_shape` in `_common.sh` —
 * `{type:"global"}` OR `{type:"project", paths:[non-empty array of strings]}`,
 * `additionalProperties:false`. `where` is the breadcrumb prefix used in the
 * error message (e.g. "agent 'forger'", "surfaces.skills[0]"). Returns an
 * error message, or null when valid.
 */
export function validateScope(scope: unknown, where: string): string | null {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    return `${where}.scope must be an object`;
  }
  const s = scope as Record<string, unknown>;
  if (s.type === "global") {
    for (const key of Object.keys(s)) {
      if (key !== "type") {
        return (
          `${where}.scope: unknown key '${key}' ` +
          `(additionalProperties:false; scope.type=global allows only 'type')`
        );
      }
    }
    return null;
  }
  if (s.type === "project") {
    for (const key of Object.keys(s)) {
      if (key !== "type" && key !== "paths") {
        return (
          `${where}.scope: unknown key '${key}' ` +
          `(additionalProperties:false; scope.type=project allows only 'type'+'paths')`
        );
      }
    }
    if (!("paths" in s)) {
      return `${where}.scope: type=project requires 'paths'`;
    }
    if (!Array.isArray(s.paths) || s.paths.length < 1) {
      return `${where}.scope.paths must be a non-empty array`;
    }
    for (let i = 0; i < s.paths.length; i++) {
      if (typeof s.paths[i] !== "string") {
        return `${where}.scope.paths[${i}] must be a string`;
      }
    }
    return null;
  }
  return `${where}.scope.type '${String(s.type)}' is not one of ['global', 'project']`;
}

/**
 * FR-155: canonicalize a `--project <path>` value at WRITE time so paths[]
 * entries are stable across the macOS `/tmp` ↔ `/private/tmp` divergence (and
 * any other symlink-resolved TMPDIR prefix). Falls back to `path.resolve` when
 * the path does not yet exist on disk (a not-yet-created project root is the
 * only realistic case where realpathSync throws). Either way the result is
 * an absolute string — compile/drift realpath their --project-root at READ
 * time too, so the two sides agree either way.
 */
export function realpathStrict(p: string): string {
  const absolute = isAbsolute(p) ? p : resolve(p);
  try {
    return realpathSync(absolute);
  } catch {
    return resolve(absolute);
  }
}

/** Validate one agent entry. Returns an error message, or null if valid. */
export function validateAgentEntry(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return "agent entry must be an object";
  }
  const agent = entry as Record<string, unknown>;
  // FR-155: `scope` is an optional agent key (absent → global).
  const allowedAgentKeys = new Set([
    "name",
    "layer",
    "canonical",
    "body_exception",
    "scope",
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

  // FR-155: optional scope (absent → global).
  if (agent.scope !== undefined) {
    const nm = typeof agent.name === "string" ? agent.name : "?";
    const scopeErr = validateScope(agent.scope, `agent '${nm}'`);
    if (scopeErr !== null) {
      return scopeErr;
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
  // FR-155: `scope` is an optional skills_surface key (absent → global).
  const allowedKeys = new Set(["source", "layer", "scope", "targets"]);
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
        "valid pairs: claude/symlink, codex/symlink, gemini/symlink, agents/symlink, opencode/command"
      );
    }
  }
  // FR-155: optional scope (absent → global). `surfaces.skills` is the
  // breadcrumb prefix — the array-level wrapper adds the `[i]` index.
  if (s.scope !== undefined) {
    const scopeErr = validateScope(s.scope, "surfaces.skills");
    if (scopeErr !== null) {
      return scopeErr;
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

/**
 * FR-161 (FR-160 epic): validate one `surfaces.mcp_servers` block field-for-
 * field against `$defs.mcp_surface`. `additionalProperties:false` →
 * name/layer/scope/canonical/targets only; `name`+`canonical`+`targets`
 * required; `canonical.command` required; targets use the SEPARATE 4-harness
 * enum + the `merge` method const. Returns an error message, or null if valid.
 */
export function validateMcpServersSurface(mcp: unknown): string | null {
  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
    return "surfaces.mcp_servers must be an object";
  }
  const m = mcp as Record<string, unknown>;
  const allowedKeys = new Set(["name", "layer", "scope", "canonical", "targets"]);
  for (const key of Object.keys(m)) {
    if (!allowedKeys.has(key)) {
      return `surfaces.mcp_servers: unknown key '${key}' (additionalProperties:false)`;
    }
  }
  for (const req of ["name", "canonical", "targets"]) {
    if (!(req in m)) {
      return `surfaces.mcp_servers missing required key '${req}'`;
    }
  }
  if (typeof m.name !== "string" || !NAME_PATTERN.test(m.name)) {
    return `surfaces.mcp_servers.name '${String(m.name)}' must match /^[a-z0-9][a-z0-9-]*$/`;
  }
  if (m.layer !== undefined && typeof m.layer !== "string") {
    return "surfaces.mcp_servers.layer must be a string";
  }

  // canonical
  const canon = m.canonical;
  if (typeof canon !== "object" || canon === null || Array.isArray(canon)) {
    return "surfaces.mcp_servers.canonical must be an object";
  }
  const c = canon as Record<string, unknown>;
  const allowedCanonKeys = new Set(["command", "args", "env", "startup_timeout_sec"]);
  for (const key of Object.keys(c)) {
    if (!allowedCanonKeys.has(key)) {
      return `surfaces.mcp_servers.canonical: unknown key '${key}' (additionalProperties:false)`;
    }
  }
  if (typeof c.command !== "string") {
    return "surfaces.mcp_servers.canonical.command must be a string";
  }
  if (c.args !== undefined) {
    if (!Array.isArray(c.args)) {
      return "surfaces.mcp_servers.canonical.args must be an array";
    }
    for (let i = 0; i < c.args.length; i++) {
      if (typeof c.args[i] !== "string") {
        return `surfaces.mcp_servers.canonical.args[${i}] must be a string`;
      }
    }
  }
  if (c.env !== undefined) {
    if (typeof c.env !== "object" || c.env === null || Array.isArray(c.env)) {
      return "surfaces.mcp_servers.canonical.env must be an object";
    }
    for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
      if (typeof v !== "string") {
        return `surfaces.mcp_servers.canonical.env['${k}'] must be a string`;
      }
    }
  }
  if (
    c.startup_timeout_sec !== undefined &&
    (typeof c.startup_timeout_sec !== "number" ||
      !Number.isInteger(c.startup_timeout_sec))
  ) {
    return "surfaces.mcp_servers.canonical.startup_timeout_sec must be an integer";
  }

  // targets
  const targets = m.targets;
  if (!Array.isArray(targets) || targets.length < 1) {
    return "surfaces.mcp_servers.targets must be a non-empty array";
  }
  const allowedTargetKeys = new Set(["type", "method", "enabled"]);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      return `surfaces.mcp_servers.targets[${i}] must be an object`;
    }
    const tRec = t as Record<string, unknown>;
    for (const key of Object.keys(tRec)) {
      if (!allowedTargetKeys.has(key)) {
        return `surfaces.mcp_servers.targets[${i}]: unknown key '${key}' (additionalProperties:false)`;
      }
    }
    for (const req of ["type", "method"]) {
      if (!(req in tRec)) {
        return `surfaces.mcp_servers.targets[${i}] missing required key '${req}'`;
      }
    }
    if (typeof tRec.type !== "string" || typeof tRec.method !== "string") {
      return `surfaces.mcp_servers.targets[${i}] type/method must be strings`;
    }
    if (!(VALID_MCP_TARGET_TYPES as readonly string[]).includes(tRec.type)) {
      return `surfaces.mcp_servers.targets[${i}].type '${tRec.type}' is not one of ${JSON.stringify(VALID_MCP_TARGET_TYPES)}`;
    }
    if (!(VALID_MCP_METHODS as readonly string[]).includes(tRec.method)) {
      return `surfaces.mcp_servers.targets[${i}].method '${tRec.method}' is not one of ${JSON.stringify(VALID_MCP_METHODS)}`;
    }
    if (tRec.enabled !== undefined && typeof tRec.enabled !== "boolean") {
      return `surfaces.mcp_servers.targets[${i}].enabled must be a boolean`;
    }
  }

  // FR-155-style optional scope (absent → global; v1 treats all as global).
  if (m.scope !== undefined) {
    const nm = typeof m.name === "string" ? m.name : "?";
    const scopeErr = validateScope(m.scope, `surfaces.mcp_servers '${nm}'`);
    if (scopeErr !== null) {
      return scopeErr;
    }
  }
  return null;
}

/**
 * FR-161: validate `surfaces.mcp_servers` as an ARRAY of `mcp_surface` blocks
 * (mirrors `validateSkillsSurfaceArray`). Rejects non-array + empty array;
 * delegates per-block validation. Error messages get a
 * `surfaces.mcp_servers[i]:` prefix so the offending block is named.
 */
export function validateMcpServersSurfaceArray(mcp: unknown): string | null {
  if (!Array.isArray(mcp)) {
    return "surfaces.mcp_servers must be a non-empty array";
  }
  if (mcp.length < 1) {
    return "surfaces.mcp_servers must be a non-empty array";
  }
  for (let i = 0; i < mcp.length; i++) {
    const err = validateMcpServersSurface(mcp[i]);
    if (err !== null) {
      return `surfaces.mcp_servers[${i}]: ${err}`;
    }
  }
  return null;
}

/**
 * FR-180 (D6): validate ONE `surfaces.os_identity` block. Port of
 * `$defs.identity_surface` in manifest.schema.json + the `validate_manifest`
 * structural fallback (`_common.sh:802-849`). An identity block has NO `name`
 * (it is keyed by its (type, filename) targets); `targets` is required and each
 * target is `{type ∈ 4-harness enum, method:"file", filename:non-empty}`.
 * `source`/`version_source`/`layer` are optional strings; `scope` is the shared
 * FR-155 shape. Keep in lockstep with the schema + the bash fallback —
 * integration test #11 reds the build on drift. Returns an error message, or
 * null when valid.
 */
export function validateIdentitySurface(identity: unknown): string | null {
  if (typeof identity !== "object" || identity === null || Array.isArray(identity)) {
    return "surfaces.os_identity must be an object";
  }
  const i = identity as Record<string, unknown>;
  const allowedKeys = new Set([
    "source",
    "version_source",
    "layer",
    "scope",
    "targets",
  ]);
  for (const key of Object.keys(i)) {
    if (!allowedKeys.has(key)) {
      return `surfaces.os_identity: unknown key '${key}' (additionalProperties:false)`;
    }
  }
  if (!("targets" in i)) {
    return "surfaces.os_identity missing required key 'targets'";
  }
  for (const k of ["source", "version_source", "layer"] as const) {
    if (i[k] !== undefined && typeof i[k] !== "string") {
      return `surfaces.os_identity.${k} must be a string`;
    }
  }

  const targets = i.targets;
  if (!Array.isArray(targets) || targets.length < 1) {
    return "surfaces.os_identity.targets must be a non-empty array";
  }
  const allowedTargetKeys = new Set(["type", "method", "filename"]);
  for (let idx = 0; idx < targets.length; idx++) {
    const t = targets[idx];
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      return `surfaces.os_identity.targets[${idx}] must be an object`;
    }
    const tRec = t as Record<string, unknown>;
    for (const key of Object.keys(tRec)) {
      if (!allowedTargetKeys.has(key)) {
        return `surfaces.os_identity.targets[${idx}]: unknown key '${key}' (additionalProperties:false)`;
      }
    }
    for (const req of ["type", "method", "filename"]) {
      if (!(req in tRec)) {
        return `surfaces.os_identity.targets[${idx}] missing required key '${req}'`;
      }
    }
    if (!(VALID_IDENTITY_TARGET_TYPES as readonly string[]).includes(tRec.type as string)) {
      return `surfaces.os_identity.targets[${idx}].type '${String(tRec.type)}' is not one of ${JSON.stringify(VALID_IDENTITY_TARGET_TYPES)}`;
    }
    if (!(VALID_IDENTITY_METHODS as readonly string[]).includes(tRec.method as string)) {
      return `surfaces.os_identity.targets[${idx}].method '${String(tRec.method)}' must be 'file'`;
    }
    if (typeof tRec.filename !== "string" || tRec.filename.length === 0) {
      return `surfaces.os_identity.targets[${idx}].filename must be a non-empty string`;
    }
  }

  if (i.scope !== undefined) {
    const scopeErr = validateScope(i.scope, "surfaces.os_identity");
    if (scopeErr !== null) {
      return scopeErr;
    }
  }
  return null;
}

/**
 * FR-180 (D6): validate `surfaces.os_identity` as an ARRAY of identity blocks
 * (mirrors `validateMcpServersSurfaceArray`). Rejects non-array + empty array;
 * delegates per-block validation. Error messages get a
 * `surfaces.os_identity[i]:` prefix so the offending block is named.
 */
export function validateIdentitySurfaceArray(identity: unknown): string | null {
  if (!Array.isArray(identity)) {
    return "surfaces.os_identity must be a non-empty array";
  }
  if (identity.length < 1) {
    return "surfaces.os_identity must be a non-empty array";
  }
  for (let i = 0; i < identity.length; i++) {
    const err = validateIdentitySurface(identity[i]);
    if (err !== null) {
      return `surfaces.os_identity[${i}]: ${err}`;
    }
  }
  return null;
}

/**
 * FR-180 (D7): validate ONE `surfaces.hooks` block. Port of `$defs.hook_surface`
 * in manifest.schema.json + the `validate_manifest` structural fallback in
 * `_common.sh`. A hook block requires `name` (lower-kebab), `event` (one of the
 * six PORTABLE_EVENTS), `canonical.command` (non-empty string), and a non-empty
 * `targets` array where each target is `{type ∈ {claude,opencode}, method:
 * "merge", enabled?:bool}`. `layer` is optional; `canonical.matcher`/`timeout`
 * optional; `scope` is the shared FR-155 shape. Keep in lockstep with the schema
 * + bash fallback (integration test #11 reds the build on drift). Returns an
 * error message, or null when valid.
 */
export function validateHookSurface(hook: unknown): string | null {
  if (typeof hook !== "object" || hook === null || Array.isArray(hook)) {
    return "surfaces.hooks must be an object";
  }
  const h = hook as Record<string, unknown>;
  const allowedKeys = new Set([
    "name",
    "event",
    "layer",
    "scope",
    "canonical",
    "targets",
  ]);
  for (const key of Object.keys(h)) {
    if (!allowedKeys.has(key)) {
      return `surfaces.hooks: unknown key '${key}' (additionalProperties:false)`;
    }
  }
  for (const req of ["name", "event", "canonical", "targets"]) {
    if (!(req in h)) {
      return `surfaces.hooks missing required key '${req}'`;
    }
  }
  if (typeof h.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(h.name)) {
    return `surfaces.hooks.name '${String(h.name)}' must match /^[a-z0-9][a-z0-9-]*$/`;
  }
  if (!(VALID_HOOK_EVENTS as readonly string[]).includes(h.event as string)) {
    return `surfaces.hooks.event '${String(h.event)}' is not one of ${JSON.stringify(VALID_HOOK_EVENTS)}`;
  }
  if (h.layer !== undefined && typeof h.layer !== "string") {
    return "surfaces.hooks.layer must be a string";
  }

  const canon = h.canonical;
  if (typeof canon !== "object" || canon === null || Array.isArray(canon)) {
    return "surfaces.hooks.canonical must be an object";
  }
  const cRec = canon as Record<string, unknown>;
  const allowedCanonKeys = new Set(["command", "matcher", "timeout"]);
  for (const key of Object.keys(cRec)) {
    if (!allowedCanonKeys.has(key)) {
      return `surfaces.hooks.canonical: unknown key '${key}' (additionalProperties:false)`;
    }
  }
  if (typeof cRec.command !== "string" || cRec.command.length === 0) {
    return "surfaces.hooks.canonical.command must be a non-empty string";
  }
  if (cRec.matcher !== undefined && typeof cRec.matcher !== "string") {
    return "surfaces.hooks.canonical.matcher must be a string";
  }
  if (cRec.timeout !== undefined && !Number.isInteger(cRec.timeout)) {
    return "surfaces.hooks.canonical.timeout must be an integer";
  }

  const targets = h.targets;
  if (!Array.isArray(targets) || targets.length < 1) {
    return "surfaces.hooks.targets must be a non-empty array";
  }
  const allowedTargetKeys = new Set(["type", "method", "enabled"]);
  for (let idx = 0; idx < targets.length; idx++) {
    const t = targets[idx];
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      return `surfaces.hooks.targets[${idx}] must be an object`;
    }
    const tRec = t as Record<string, unknown>;
    for (const key of Object.keys(tRec)) {
      if (!allowedTargetKeys.has(key)) {
        return `surfaces.hooks.targets[${idx}]: unknown key '${key}' (additionalProperties:false)`;
      }
    }
    for (const req of ["type", "method"]) {
      if (!(req in tRec)) {
        return `surfaces.hooks.targets[${idx}] missing required key '${req}'`;
      }
    }
    if (!(VALID_HOOK_TARGET_TYPES as readonly string[]).includes(tRec.type as string)) {
      return `surfaces.hooks.targets[${idx}].type '${String(tRec.type)}' is not one of ${JSON.stringify(VALID_HOOK_TARGET_TYPES)}`;
    }
    if (!(VALID_HOOK_METHODS as readonly string[]).includes(tRec.method as string)) {
      return `surfaces.hooks.targets[${idx}].method '${String(tRec.method)}' must be 'merge'`;
    }
    if (tRec.enabled !== undefined && typeof tRec.enabled !== "boolean") {
      return `surfaces.hooks.targets[${idx}].enabled must be a boolean`;
    }
  }

  if (h.scope !== undefined) {
    const scopeErr = validateScope(h.scope, "surfaces.hooks");
    if (scopeErr !== null) {
      return scopeErr;
    }
  }
  return null;
}

/**
 * FR-180 (D7): validate `surfaces.hooks` as an ARRAY of hook blocks (mirrors
 * `validateMcpServersSurfaceArray`). Rejects non-array + empty array; delegates
 * per-block validation with a `surfaces.hooks[i]:` prefix.
 */
export function validateHookSurfaceArray(hooks: unknown): string | null {
  if (!Array.isArray(hooks)) {
    return "surfaces.hooks must be a non-empty array";
  }
  if (hooks.length < 1) {
    return "surfaces.hooks must be a non-empty array";
  }
  for (let i = 0; i < hooks.length; i++) {
    const err = validateHookSurface(hooks[i]);
    if (err !== null) {
      return `surfaces.hooks[${i}]: ${err}`;
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
    const allowedSurfaceKeys = new Set([
      "skills",
      "mcp_servers",
      "os_identity",
      "hooks",
      "os_context",
    ]);
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
    if (surfaces.mcp_servers !== undefined) {
      const mcpErr = validateMcpServersSurfaceArray(surfaces.mcp_servers);
      if (mcpErr !== null) {
        return mcpErr;
      }
    }
    // FR-180 (D6): personal os_identity blocks are now first-class in the
    // overlay (the v1 not-merged gate is lifted in merge_overlay_manifest).
    if (surfaces.os_identity !== undefined) {
      const identityErr = validateIdentitySurfaceArray(surfaces.os_identity);
      if (identityErr !== null) {
        return identityErr;
      }
    }
    // FR-180 (D7): personal hook blocks are first-class in the overlay
    // (merged base++overlay in merge_overlay_manifest).
    if (surfaces.hooks !== undefined) {
      const hooksErr = validateHookSurfaceArray(surfaces.hooks);
      if (hooksErr !== null) {
        return hooksErr;
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

/**
 * FR-162 (FR-160 epic): read the base manifest's CORE mcp_servers block NAMES.
 * Parallels `readBaseAgentNames`, but unions `surfaces.mcp_servers[].name`. MCP
 * identity is the block NAME (one server per name), so the core-collision guard
 * rejects a personal MCP whose name shadows a core one. Absent/malformed base →
 * empty set (the runtime merge guard only fires when both exist).
 */
function readBaseMcpNames(projectRoot: string): Set<string> {
  const basePath = join(projectRoot, "harness-manifest.json");
  if (!existsSync(basePath)) {
    return new Set();
  }
  try {
    const base = JSON.parse(readFileSync(basePath, "utf-8")) as {
      surfaces?: { mcp_servers?: { name?: unknown }[] };
    };
    const names = new Set<string>();
    for (const m of base.surfaces?.mcp_servers ?? []) {
      if (typeof m?.name === "string") {
        names.add(m.name);
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * FR-180 (D6): read the (type, filename) identity-target PAIRS declared by the
 * base (core) manifest. Identity blocks have no `name`, so the collision unit is
 * the (type, filename) pair — a personal `add identity` target that collides
 * with a core one is rejected at write-time (mirrors `readBaseMcpNames` for MCP
 * + the bash `merge_overlay_manifest` (type, filename) guard). Each pair is
 * encoded `"<type> <filename>"`. Absent/malformed base → empty set.
 */
function readBaseIdentityTargets(projectRoot: string): Set<string> {
  const basePath = join(projectRoot, "harness-manifest.json");
  if (!existsSync(basePath)) {
    return new Set();
  }
  try {
    const base = JSON.parse(readFileSync(basePath, "utf-8")) as {
      surfaces?: {
        os_identity?: { targets?: { type?: unknown; filename?: unknown }[] }[];
      };
    };
    const pairs = new Set<string>();
    for (const block of base.surfaces?.os_identity ?? []) {
      for (const t of block?.targets ?? []) {
        if (typeof t?.type === "string" && typeof t?.filename === "string") {
          pairs.add(`${t.type} ${t.filename}`);
        }
      }
    }
    return pairs;
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
 * FR-156 retired `hashSurface` (file-set hash) — agent vendor is now tree-
 * shaped; see `hashAgentTree`/`hashSkillTree`. Single-file-set semantics
 * remain available via `hashFileSet` in github-source.ts if a future
 * non-tree surface needs them.
 */

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
    // FR-151 / FR-158: include the per-harness frontmatter sidecars if
    // co-located. `frontmatter.claude.md` feeds `assembleClaudeHarness` and
    // (when no `frontmatter.gemini.md` exists) `assembleGeminiHarness` via
    // auto-translate. `frontmatter.gemini.md` is the operator-authored
    // Gemini override.
    for (const fmName of ["frontmatter.claude.md", "frontmatter.gemini.md", "frontmatter.opencode.md"]) {
      if (
        existsSync(join(srcDir, fmName)) &&
        !entries.includes(fmName)
      ) {
        entries.push(fmName);
      }
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
  // FR-151 / FR-158: include the per-harness frontmatter sidecars if
  // co-located.
  const files = [file];
  for (const fmName of ["frontmatter.claude.md", "frontmatter.gemini.md", "frontmatter.opencode.md"]) {
    if (existsSync(join(srcDir, fmName)) && file !== fmName) {
      files.push(fmName);
    }
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
 * FR-156 retired `vendorSurfaceAtomic` (file-set vendor) — agent vendor is
 * now tree-shaped; see `vendorAgentTreeAtomic`/`vendorSkillTreeAtomic`. A
 * future non-tree surface that needs single-file vendor can resurrect from
 * git history; the file-set primitive had a single internal caller (the
 * agent runAdd/reVendor) which now uses the tree primitive uniformly.
 */

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
 * FR-152 / FR-158 α-assembly (Claude branch): derive
 * `<vendoredDir>/harness.claude.md` = `---\n<frontmatter>\n---\n\n<body>`.
 * Claude compile-time symlinks resolve to this file. No-op when no
 * `frontmatter.claude.md` sidecar exists (vendor-side assembly is opt-in via
 * the FR-151/FR-158 sidecar presence; compile-side fallback handles core
 * agents). See L-519.
 *
 * Picks the latest `system-prompt-v*.md` for versioned shape via `sort -V`
 * semantics (split on dots, numeric-compare components — ports
 * `_common.sh:latest_canonical`). For unversioned, uses the single non-sidecar
 * file. Atomic temp-then-rename. Body-exception applied when `bodyExceptionPath`
 * is non-empty (FR-144 + TD-193 regression guard).
 *
 * FR-158 rename: was `assembleAgentHarness` reading `frontmatter.md` /
 * writing `harness.md`; the per-harness pair (`assembleClaudeHarness` +
 * `assembleGeminiHarness`) makes the sidecar/output names symmetric so Gemini
 * gets first-class auto-translate. Callers invoke BOTH in sequence at every
 * agent vendor site (runAdd, runAddGithub, reVendorPath, reVendorGithub).
 */
export function assembleClaudeHarness(
  vendoredDir: string,
  files: string[],
  bodyExceptionPath?: string,
): void {
  const fmPath = join(vendoredDir, "frontmatter.claude.md");
  if (!existsSync(fmPath)) {
    return; // assembly is opt-in via the FR-151/FR-158 sidecar's presence
  }
  // Pick body file: prefer the latest versioned `system-prompt-v*.md`; else
  // the single non-sidecar file in the vendored set.
  const versioned = files.filter((f) => /^system-prompt-v[0-9]/.test(f));
  let bodyFile: string | undefined;
  if (versioned.length > 0) {
    bodyFile = pickLatestVersionedFile(versioned);
  } else {
    const nonSidecar = files.filter(
      (f) =>
        f !== "frontmatter.claude.md" &&
        f !== "frontmatter.gemini.md" &&
        f !== "frontmatter.opencode.md",
    );
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
  // FR-151's frontmatter.claude.md sidecar carries the SAME `---\n<fields>\n---\n`
  // shape as a canonical's inline frontmatter. Strip the delimiters here so
  // the α-assembled `harness.claude.md` doesn't double-wrap.
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
  const out = join(vendoredDir, "harness.claude.md");
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, out);
}

/**
 * FR-158: Claude → Gemini tool-name translation map. Closes the auto-translate
 * gap that prevented `frontmatter.claude.md` from being honored by Gemini's
 * `invoke_agent` (Gemini rejects Claude's PascalCase tool names + missing
 * `kind: local`). The 9 mappings cover Claude's current tool surface;
 * unknown tool names pass through verbatim so Gemini surfaces an explicit
 * "unknown tool" error (the operator override path — author
 * `frontmatter.gemini.md` — is the escape hatch).
 *
 * `Glob → list_directory` is the IMPERFECT mapping (Claude's Glob is a
 * recursive filesystem-pattern matcher; Gemini's `list_directory` is a
 * single-dir listing). None of the current personal agents declare Glob,
 * but operators with Glob-using agents should author a
 * `frontmatter.gemini.md` sidecar — see `docs/multi-cli.md` §"Per-harness
 * frontmatter sidecars".
 */
const CLAUDE_TO_GEMINI_TOOLS: Record<string, string> = {
  Read: "read_file",
  Write: "write_file",
  // TD-229: Gemini's edit tool is `replace` (EDIT_TOOL_NAME), NOT `edit_file`.
  // `edit_file` is not in ALL_BUILTIN_TOOL_NAMES → the agent fails to load with
  // "tools.N: Invalid tool name". Verified against the gemini-cli bundle's
  // localAgentSchema → isValidToolName → ALL_BUILTIN_TOOL_NAMES.
  Edit: "replace",
  Bash: "run_shell_command",
  Grep: "grep_search",
  Glob: "list_directory", // imperfect — operator override is the escape hatch
  Task: "task",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
};

/**
 * FR-158: parse a YAML-frontmatter fields block (the unwrapped form returned
 * by `stripLeadingFrontmatterBlockToFields` — no `---` delimiters) into an
 * ordered list of (key, raw-value) pairs. Supports the narrow subset of YAML
 * the agent frontmatter actually uses (`key: value` lines, possibly
 * continued; nothing more). Avoids adding a `js-yaml` dependency — agent
 * frontmatter shapes are constrained by the FR-151 contract.
 *
 * Returns an array of `{key, value}` to preserve operator-authored ordering
 * when re-serializing. Values are the raw post-colon trim'd string (caller
 * decides how to interpret string vs list vs CSV for `tools:`).
 */
function parseSimpleFrontmatterFields(
  fields: string,
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const rawLine of fields.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    out.push({ key: m[1], value: m[2] });
  }
  return out;
}

/**
 * FR-158: translate Claude-shape frontmatter fields into Gemini-shape.
 * Behavior per Decision 2 of FR-158 plan:
 *   - `name:` / `description:` pass through unchanged.
 *   - `tools:` is translated via `CLAUDE_TO_GEMINI_TOOLS`. Handles BOTH
 *     string (`tools: Read`), CSV (`tools: Read, Grep`), and YAML-flow-list
 *     (`tools: [Read, Grep]`) input shapes. Output is emitted as YAML
 *     flow-list (`tools: [read_file, grep_search]`) for shape stability.
 *   - `kind: local` is ALWAYS added (the root-cause field for Gemini's
 *     "Subagent not found" rejection).
 *   - `model:` / `temperature:` / `max_turns:` are NOT added; operators
 *     override via `frontmatter.gemini.md`.
 *   - All other fields pass through verbatim (e.g., a project-specific
 *     `tags:` line stays as-is).
 *
 * Returns the serialized fields block (no `---` delimiters; caller wraps).
 */
function translateClaudeToGeminiFrontmatter(claudeFields: string): string {
  const parsed = parseSimpleFrontmatterFields(claudeFields);
  const out: string[] = [];
  let kindEmitted = false;
  let toolsEmitted = false;
  for (const { key, value } of parsed) {
    if (key === "tools") {
      const tokens = parseToolsField(value);
      const translated = tokens
        // TD-229: drop Claude MCP-tool tokens (`mcp__<server>__<tool>`). Gemini's
        // agent schema rejects the double-underscore Claude shape ("Invalid tool
        // name" — the `mcp__` prefix fails parseMcpToolName's `mcp_<server>_<tool>`
        // grammar). MCP tools reach Gemini agents via the `mcp_servers` field and
        // the harness-level MCP registration, NOT the `tools` array.
        .filter((t) => !t.startsWith("mcp__"))
        .map(
          (t) => CLAUDE_TO_GEMINI_TOOLS[t] ?? t, // unknown → pass through verbatim
        );
      out.push(`tools: [${translated.join(", ")}]`);
      toolsEmitted = true;
      continue;
    }
    if (key === "kind") {
      // Operator-authored `kind:` (e.g., `kind: local` already present in
      // the Claude sidecar) — pass through; mark as emitted so we don't
      // double-add below.
      out.push(`${key}: ${value}`);
      kindEmitted = true;
      continue;
    }
    if (
      key === "model" ||
      key === "temperature" ||
      key === "max_turns" ||
      key === "memory"
    ) {
      // Drop per Decision 2 — Gemini uses defaults; operators override via
      // `frontmatter.gemini.md`. `memory` (TD-229) is a Claude-only key:
      // Gemini's strict subagent schema rejects it with "Unrecognized
      // key(s) in object: 'memory'" → the agent fails to load entirely.
      continue;
    }
    out.push(`${key}: ${value}`);
  }
  if (!kindEmitted) {
    out.push("kind: local");
  }
  // If the source Claude frontmatter had no `tools:` field, we still don't
  // emit one — agents without explicit tools accept the loader's default set.
  void toolsEmitted;
  return out.join("\n");
}

/**
 * FR-158: parse a `tools:` field value (raw post-colon trim'd string) into a
 * list of tool-name tokens. Accepts:
 *   - empty string → `[]`
 *   - string token (`Read`) → `["Read"]`
 *   - CSV (`Read, Grep`) → `["Read", "Grep"]`
 *   - YAML flow list (`[Read, Grep]`) → `["Read", "Grep"]`
 *   - YAML flow list with quotes (`["Read", "Grep"]`) → `["Read", "Grep"]`
 */
function parseToolsField(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "") return [];
  let inner = trimmed;
  if (inner.startsWith("[") && inner.endsWith("]")) {
    inner = inner.slice(1, -1);
  }
  return inner
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter((t) => t.length > 0);
}

/**
 * FR-158 α-assembly (Gemini branch): derive
 * `<vendoredDir>/harness.gemini.md` so Gemini's `invoke_agent` resolves to a
 * Gemini-shaped harness rather than the Claude-shape one.
 *
 * Frontmatter source preference:
 *   1. `<vendoredDir>/frontmatter.gemini.md` (operator-authored override
 *      — honored verbatim; no field-by-field merge with Claude sidecar).
 *   2. `<vendoredDir>/frontmatter.claude.md` (auto-translated via
 *      `translateClaudeToGeminiFrontmatter` — adds `kind: local`,
 *      translates `tools:` per `CLAUDE_TO_GEMINI_TOOLS`).
 *   3. Neither present → early-return (parity with `assembleClaudeHarness`).
 *
 * Body picking, body-exception application, atomic temp+rename match
 * `assembleClaudeHarness` exactly (same body file, same sidecar JSON).
 */
export function assembleGeminiHarness(
  vendoredDir: string,
  files: string[],
  bodyExceptionPath?: string,
): void {
  const geminiFmPath = join(vendoredDir, "frontmatter.gemini.md");
  const claudeFmPath = join(vendoredDir, "frontmatter.claude.md");
  let fmRaw: string;
  if (existsSync(geminiFmPath)) {
    // Operator-authored override — honor verbatim.
    fmRaw = stripLeadingFrontmatterBlockToFields(
      readFileSync(geminiFmPath, "utf-8"),
    ).trim();
  } else if (existsSync(claudeFmPath)) {
    // Auto-translate the Claude sidecar.
    const claudeFields = stripLeadingFrontmatterBlockToFields(
      readFileSync(claudeFmPath, "utf-8"),
    ).trim();
    fmRaw = translateClaudeToGeminiFrontmatter(claudeFields).trim();
  } else {
    return; // assembly is opt-in via FR-151/FR-158 sidecar presence
  }
  const versioned = files.filter((f) => /^system-prompt-v[0-9]/.test(f));
  let bodyFile: string | undefined;
  if (versioned.length > 0) {
    bodyFile = pickLatestVersionedFile(versioned);
  } else {
    const nonSidecar = files.filter(
      (f) =>
        f !== "frontmatter.claude.md" &&
        f !== "frontmatter.gemini.md" &&
        f !== "frontmatter.opencode.md",
    );
    if (nonSidecar.length !== 1) {
      return;
    }
    bodyFile = nonSidecar[0];
  }
  if (bodyFile === undefined) {
    return;
  }
  let body = readFileSync(join(vendoredDir, bodyFile), "utf-8");
  body = stripLeadingFrontmatter(body);
  // FR-158 Decision 3: body-exception sidecar is body-relative (anchor lines
  // are in the SAME body both harnesses consume), so apply identically to
  // both outputs. A broken anchor throws from both assemblers — honest
  // paired blast radius, not new risk.
  if (bodyExceptionPath !== undefined && bodyExceptionPath.length > 0) {
    body = applyBodyException(body, bodyExceptionPath);
  }
  let text = `---\n${fmRaw}\n---\n\n${body}`;
  if (!text.endsWith("\n")) {
    text += "\n";
  }
  const out = join(vendoredDir, "harness.gemini.md");
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, out);
}

/**
 * FR-171: Claude → OpenCode tool-name translation map. OpenCode's 9 native
 * tools are `bash, read, write, edit, glob, grep, webfetch, task, todowrite`
 * (confirmed live via `opencode agent create --help`, opencode 1.14.22). The
 * agent frontmatter `tools:` field is a BOOLEAN MAP (not a flow-list, unlike
 * Gemini). 8 of Claude's tools map directly; OpenCode has a native `glob`
 * (cleaner than Gemini's imperfect `list_directory`). `WebSearch` has NO
 * native equivalent and is OMITTED from the map (do NOT invent a `websearch`
 * key — the operator override path via a `frontmatter.opencode.md` sidecar is
 * the escape hatch). `todowrite` is native-only (not mapped FROM any Claude
 * tool). Unknown tool names pass through verbatim so OpenCode surfaces an
 * explicit error. See FR-171 §5.
 *
 * MIRRORED byte-for-byte in compile_harnesses.sh's inline python3
 * `CLAUDE_TO_OPENCODE_TOOLS` (§18.1 dual-impl — golden-fixture parity test
 * pins them; L-554).
 */
const CLAUDE_TO_OPENCODE_TOOLS: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "glob",
  Task: "task",
  WebFetch: "webfetch",
  // WebSearch: intentionally omitted — no native OpenCode equivalent.
};

/**
 * FR-171: the MCP-server permission grant emitted into every OpenCode agent
 * harness's `permission:` block. OpenCode reaches MCP tools via the
 * `permission` map (NOT the `tools` boolean enum). The key shape
 * `mcp__<server>__*` was confirmed live (opencode 1.14.22): it survives
 * frontmatter parse and normalizes to `{permission:"mcp__igris-brain__*",
 * action:"allow", pattern:"*"}`. This grants ARCHITECT/SEEKER/etc. access to
 * the igris-brain MCP server already merged into opencode.json (FR-166).
 *
 * MIRRORED byte-for-byte in compile_harnesses.sh's inline python3
 * OPENCODE_MCP_PERMISSIONS (§18.1 dual-impl; L-554).
 */
const OPENCODE_MCP_PERMISSIONS: ReadonlyArray<string> = ["mcp__igris-brain__*"];

/**
 * FR-171: translate Claude-shape frontmatter fields into OpenCode-shape.
 * Emission order is FIXED (deterministic-write mandate, byte-parity with the
 * bash inline-python3 mirror):
 *   1. `mode: subagent` (always first, unless an operator `mode:` is present —
 *      then that value is honored and emitted in passthrough position).
 *   2. passthrough fields in source order (`name`, `description`, any custom),
 *      EXCEPT `tools`, `model`, `temperature`, `max_turns`, `mode`, `kind`.
 *      `model`/`temperature`/`max_turns` are DROPPED (OpenCode uses defaults;
 *      operator override via `frontmatter.opencode.md`). `kind` is Gemini-only
 *      and dropped.
 *   3. `tools:` as a BOOLEAN MAP (allow-list mirroring the agent's declared
 *      toolset): each mapped native → `true`, on its own indented line. Omitted
 *      entirely when the source declares no `tools:` (agent accepts OpenCode's
 *      default tool set).
 *   4. `permission:` map granting the igris-brain MCP server (always emitted —
 *      the brain grant is what lets agents reach brain tools on OpenCode).
 *
 * Returns the serialized fields block (no `---` delimiters; caller wraps).
 * MIRRORED byte-for-byte by the compile_harnesses.sh inline python3 block.
 */
function translateClaudeToOpencodeFrontmatter(claudeFields: string): string {
  const parsed = parseSimpleFrontmatterFields(claudeFields);
  const out: string[] = [];
  let modeEmitted = false;
  let toolsValue: string | undefined;
  // First pass: detect an operator-authored `mode:` so we don't double-emit.
  for (const { key } of parsed) {
    if (key === "mode") {
      modeEmitted = true;
    }
  }
  // Always lead with `mode: subagent` unless the source carries its own mode.
  if (!modeEmitted) {
    out.push("mode: subagent");
  }
  for (const { key, value } of parsed) {
    if (key === "tools") {
      toolsValue = value; // deferred — emitted as a boolean map below
      continue;
    }
    if (key === "model" || key === "temperature" || key === "max_turns") {
      continue; // dropped — OpenCode defaults; operator override via sidecar
    }
    if (key === "kind") {
      continue; // Gemini-only field — not meaningful to OpenCode
    }
    out.push(`${key}: ${value}`);
  }
  // tools: boolean map (allow-list of the declared toolset's mapped natives).
  if (toolsValue !== undefined) {
    const tokens = parseToolsField(toolsValue);
    const natives: string[] = [];
    for (const t of tokens) {
      const mapped = CLAUDE_TO_OPENCODE_TOOLS[t];
      if (mapped === undefined) continue; // WebSearch / unknown → skip (no native)
      if (!natives.includes(mapped)) natives.push(mapped);
    }
    if (natives.length > 0) {
      out.push("tools:");
      for (const n of natives) {
        out.push(`  ${n}: true`);
      }
    }
  }
  // permission: MCP grant (always — the brain MCP reachability contract).
  out.push("permission:");
  for (const p of OPENCODE_MCP_PERMISSIONS) {
    out.push(`  "${p}": allow`);
  }
  return out.join("\n");
}

/**
 * FR-171 α-assembly (OpenCode branch): derive
 * `<vendoredDir>/harness.opencode.md` so OpenCode's agent loader resolves to
 * an OpenCode-shaped harness (boolean tools map + `mode: subagent` +
 * `permission:` MCP grant) rather than the Claude-shape one.
 *
 * Frontmatter source preference (parity with `assembleGeminiHarness`):
 *   1. `<vendoredDir>/frontmatter.opencode.md` (operator-authored override
 *      — honored verbatim; no field-by-field merge).
 *   2. `<vendoredDir>/frontmatter.claude.md` (auto-translated via
 *      `translateClaudeToOpencodeFrontmatter`).
 *   3. Neither present → early-return (parity with `assembleClaudeHarness`).
 *
 * Body picking, body-exception application, atomic temp+rename match
 * `assembleClaudeHarness`/`assembleGeminiHarness` exactly. See L-519, FR-171.
 */
export function assembleOpencodeHarness(
  vendoredDir: string,
  files: string[],
  bodyExceptionPath?: string,
): void {
  const opencodeFmPath = join(vendoredDir, "frontmatter.opencode.md");
  const claudeFmPath = join(vendoredDir, "frontmatter.claude.md");
  let fmRaw: string;
  if (existsSync(opencodeFmPath)) {
    fmRaw = stripLeadingFrontmatterBlockToFields(
      readFileSync(opencodeFmPath, "utf-8"),
    ).trim();
  } else if (existsSync(claudeFmPath)) {
    const claudeFields = stripLeadingFrontmatterBlockToFields(
      readFileSync(claudeFmPath, "utf-8"),
    ).trim();
    fmRaw = translateClaudeToOpencodeFrontmatter(claudeFields).trim();
  } else {
    return; // assembly is opt-in via FR-151/FR-158/FR-171 sidecar presence
  }
  const versioned = files.filter((f) => /^system-prompt-v[0-9]/.test(f));
  let bodyFile: string | undefined;
  if (versioned.length > 0) {
    bodyFile = pickLatestVersionedFile(versioned);
  } else {
    const nonSidecar = files.filter(
      (f) =>
        f !== "frontmatter.claude.md" &&
        f !== "frontmatter.gemini.md" &&
        f !== "frontmatter.opencode.md",
    );
    if (nonSidecar.length !== 1) {
      return;
    }
    bodyFile = nonSidecar[0];
  }
  if (bodyFile === undefined) {
    return;
  }
  let body = readFileSync(join(vendoredDir, bodyFile), "utf-8");
  body = stripLeadingFrontmatter(body);
  if (bodyExceptionPath !== undefined && bodyExceptionPath.length > 0) {
    body = applyBodyException(body, bodyExceptionPath);
  }
  let text = `---\n${fmRaw}\n---\n\n${body}`;
  if (!text.endsWith("\n")) {
    text += "\n";
  }
  const out = join(vendoredDir, "harness.opencode.md");
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, out);
}

/**
 * FR-159: Escape a string for use inside a TOML basic string (single-line,
 * double-quoted). Ports `_common.sh:toml_escape_description` byte-for-byte so
 * the TS α-assembly path produces the same bytes as the retired bash
 * `sync_codex_agents.sh`. See L-519 (cross-implementation parity).
 *
 * Rules:
 *   1. Collapse all whitespace (newlines, tabs, runs of spaces) to single
 *      spaces — description is one line.
 *   2. Escape `\` → `\\` FIRST (order matters; do not re-escape our own
 *      output).
 *   3. Escape `"` → `\"`.
 */
function escapeTomlBasicString(raw: string): string {
  // " ".join(raw.split()) in python collapses any run of whitespace to a
  // single space; reproduce via /\s+/g.
  const collapsed = raw.split(/\s+/).filter((p) => p.length > 0).join(" ");
  return collapsed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * FR-159: Escape a body for use inside a TOML multiline basic string
 * (triple-quote delimited). Ports `_common.sh:toml_escape` byte-for-byte.
 *
 * Rules per TOML 1.0:
 *   1. Backslashes are doubled (escape FIRST so we don't re-escape our own
 *      output).
 *   2. Any run of 3+ double-quotes is broken so the parser never sees `"""`
 *      prematurely closing the block. Strategy mirrors the bash python
 *      counterpart: every 3 quotes become `""\"` (literal three-character
 *      sequence: `"`, `"`, `\`, `"` — that's 3 of the 3, with the 3rd
 *      backslash-escaped). Remainder (`len % 3`) of bare `"` characters is
 *      appended unchanged (TOML allows up to 2 consecutive `"` inside `"""`).
 */
function escapeTomlMultilineBody(raw: string): string {
  // Order matters: escape backslashes FIRST so we don't re-escape our own.
  const backslashEscaped = raw.replace(/\\/g, "\\\\");
  // Break any run of 3+ double-quotes into chunks of `""\"`.
  return backslashEscaped.replace(/"{3,}/g, (run) => {
    const triples = Math.floor(run.length / 3);
    const remainder = run.length % 3;
    return '""\\"'.repeat(triples) + '"'.repeat(remainder);
  });
}

/**
 * FR-159 α-assembly (Codex branch): derive
 * `<vendoredDir>/harness.codex.toml` so codex's subagent loader resolves
 * the project's `~/.codex/agents/<name>.toml` symlink to a registry-anchored
 * 3-key TOML document (`description`, `developer_instructions`, `name`).
 *
 * Replaces the bash `sync_codex_agents.sh` which was deleted by FR-159 (see
 * FR-153 precedent for outright-delete of retired adapter scripts). The TS
 * port is byte-equivalent to the bash output modulo the leading marker line
 * (now `# Generated by igris assembleCodexHarness (FR-159)` so operators can
 * tell which path emitted the file). The byte-parity guard is in the vitest
 * suite (`harness-registry.test.ts` — golden fixture under `__tests__/fixtures/`).
 *
 * Frontmatter source: `frontmatter.claude.md` only. Codex shares the same
 * 3-key TOML schema across all operator setups (description + name read
 * from the Claude-shape sidecar; `tools:` / `model:` / etc. are NOT read).
 * No codex-specific operator override sidecar — Decision 6 of the FR-159
 * plan documents the rationale (3-key fixed schema = nothing to override).
 *
 * Body picking matches `assembleClaudeHarness` exactly: prefer the latest
 * versioned `system-prompt-v*.md` else the single non-sidecar file.
 *
 * **Body-exception NOT applied.** The bash `sync_codex_agents.sh` did NOT
 * apply body-exception sidecars (verified at compile_harnesses.sh:931-942
 * pre-FR-159 + check_harness_drift.sh:759-762: "codex emitters write the
 * plain canonical body … body-exception is claude-only at the SYMBOLIC
 * level — TD-193 gate"). The TS port preserves this for byte-parity: the
 * drift verdict that pairs with this emit relies on `expected_body ==
 * strip_frontmatter(canon_abs)` (post-FR-159 the drift verdict moves to a
 * symlink-realpath verdict instead, but the emitted body still must be the
 * plain canonical — otherwise operators with a body-exception declared
 * would silently see codex output change). `bodyExceptionPath` is accepted
 * in the signature for symmetry with `assembleClaudeHarness` /
 * `assembleGeminiHarness` (callers pass the resolved path uniformly) but
 * deliberately ignored. See FR-159 plan §Decision 3 / Anchor 1.
 *
 * Output: `<vendoredDir>/harness.codex.toml`. Atomic temp+rename. Idempotent
 * (same inputs → same bytes).
 */
export function assembleCodexHarness(
  vendoredDir: string,
  files: string[],
  bodyExceptionPath?: string,
): void {
  // FR-159 Decision 3 + TD-193 + Anchor 1: explicit no-op for body-exception
  // (signature symmetry with .md siblings; parity with retired bash
  // `sync_codex_agents.sh` which never applied it).
  void bodyExceptionPath;

  const fmPath = join(vendoredDir, "frontmatter.claude.md");
  if (!existsSync(fmPath)) {
    return; // assembly is opt-in via the FR-151/FR-158 sidecar's presence
  }

  // Body picking — mirror `assembleClaudeHarness` exactly.
  const versioned = files.filter((f) => /^system-prompt-v[0-9]/.test(f));
  let bodyFile: string | undefined;
  if (versioned.length > 0) {
    bodyFile = pickLatestVersionedFile(versioned);
  } else {
    const nonSidecar = files.filter(
      (f) =>
        f !== "frontmatter.claude.md" &&
        f !== "frontmatter.gemini.md" &&
        f !== "frontmatter.opencode.md",
    );
    if (nonSidecar.length !== 1) {
      return;
    }
    bodyFile = nonSidecar[0];
  }
  if (bodyFile === undefined) {
    return;
  }

  // Parse description + name out of the Claude-shape sidecar. The 3-key
  // TOML schema reads ONLY these two fields (`tools:`, `model:`,
  // `temperature:`, `max_turns:`, `kind:` are not consumed by codex's
  // subagent loader — see FR-159 plan §Decision 6).
  const fmFields = stripLeadingFrontmatterBlockToFields(
    readFileSync(fmPath, "utf-8"),
  ).trim();
  const parsed = parseSimpleFrontmatterFields(fmFields);
  let descriptionRaw = "";
  let nameRaw = "";
  for (const { key, value } of parsed) {
    if (key === "description") descriptionRaw = value;
    if (key === "name") nameRaw = value;
  }
  // Name fallback: `<basename(vendoredDir)>` (registry vendor dir = agent
  // name). Matches `sync_codex_agents.sh`'s `basename(OUTPUT_PATH) - .toml`
  // fallback when the sidecar omits a name.
  if (nameRaw === "") {
    nameRaw = basename(vendoredDir);
  }

  let body = readFileSync(join(vendoredDir, bodyFile), "utf-8");
  body = stripLeadingFrontmatter(body);

  const escapedDesc = escapeTomlBasicString(descriptionRaw);
  const escapedBody = escapeTomlMultilineBody(body);
  const escapedName = escapeTomlBasicString(nameRaw);

  // TOML key order is load-bearing per TD-021 finding #2: description,
  // developer_instructions, name. Matches the observed codex-import output.
  const marker = "# Generated by igris assembleCodexHarness (FR-159)";
  let text = marker + "\n";
  text += `description = "${escapedDesc}"\n`;
  text += 'developer_instructions = """\n';
  text += escapedBody;
  if (!text.endsWith("\n")) {
    text += "\n";
  }
  text += '"""\n';
  text += `name = "${escapedName}"\n`;

  const out = join(vendoredDir, "harness.codex.toml");
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, out);
}

/**
 * TD-202 — emit a `REGISTRY-NOTICE.md` sidecar inside a vendored tree naming
 * the SOURCE the editor must mutate. The notice is best-effort UX (in-band
 * "edit source, not registry" guidance) — its emission MUST NOT fail the
 * containing add/update verb (the overlay write is the contract). Callers
 * invoke this AFTER `hashAgentTree`/`hashSkillTree` so the notice's bytes
 * never enter the hash basis even if the skip-list mirror lags (defense-in-
 * depth; `isAgentTreeSkipped` IS the load-bearing rule).
 *
 * For `kind === "skill"` the L-517 nested layout is
 * `<vendoredDir>/<name>/SKILL.md` (single-skill) or
 * `<vendoredDir>/<sub>/SKILL.md` (multi-skill root). The notice is dropped
 * NEXT TO every `SKILL.md` it can locate so an editor opening any skill
 * variant sees it.
 *
 * `sourceRef` is the editor-actionable string: a filesystem path for
 * path-origins, a `github:owner/repo@ref` URI for github-origins (the
 * fetched temp dir is gone by the time the editor reads the notice, so
 * passing it would be misleading — TD-202 plan §1.4).
 *
 * See TD-202, coding_guidelines.md §18.5, brain memory `td202-sidecar`.
 */
function writeRegistryNotice(
  vendoredDir: string,
  sourceRef: string,
  name: string,
  kind: "agent" | "skill",
): void {
  try {
    const body =
      `<!--\n` +
      `  TD-202: this directory is a registry-vendored copy. DO NOT edit files here.\n` +
      `  Source: ${sourceRef}\n` +
      `  To change: edit the source, then run \`igris registry update ${name}\`.\n` +
      `  Direct edits to this directory will be OVERWRITTEN on the next \`update\`\n` +
      `  or \`add\` cycle, and the drift-verify check will flag them as DRIFTED.\n` +
      `-->\n\n` +
      `# Registry-vendored copy — do not edit here\n\n` +
      `This is a copy of \`${sourceRef}\` maintained by \`igris registry\`. Edit the\n` +
      `source, then run:\n\n` +
      `\`\`\`bash\n` +
      `igris registry update ${name}\n` +
      `\`\`\`\n\n` +
      `Why this file exists: see TD-202 (the 2026-06-01 Codex incident — direct\n` +
      `registry edits to content-pipeline/SKILL.md got silently overwritten on the\n` +
      `next update cycle). The drift checker (\`igris harness check\`) reports\n` +
      `DRIFTED if this copy diverges from source. See coding_guidelines.md §18.5.\n`;

    const writeAtomic = (dir: string): void => {
      if (!existsSync(dir)) return; // skip silently if the dir vanished
      const out = join(dir, "REGISTRY-NOTICE.md");
      const tmp = `${out}.tmp-${process.pid}`;
      writeFileSync(tmp, body, "utf-8");
      renameSync(tmp, out);
    };

    if (kind === "agent") {
      writeAtomic(vendoredDir);
      return;
    }
    // Skill case — L-517 nested. Try single-skill shape first
    // (<vendoredDir>/<name>/SKILL.md); else iterate every subdir with a SKILL.md.
    const singleSkillDir = join(vendoredDir, name);
    if (existsSync(join(singleSkillDir, "SKILL.md"))) {
      writeAtomic(singleSkillDir);
      return;
    }
    if (existsSync(vendoredDir)) {
      const entries = readdirSync(vendoredDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const sub = join(vendoredDir, e.name);
        if (existsSync(join(sub, "SKILL.md"))) {
          writeAtomic(sub);
        }
      }
    }
  } catch (err) {
    // TD-202: in-band notice is UX, not contract. Log + continue; the overlay
    // write is the load-bearing artifact.
    info(
      `registry: could not write REGISTRY-NOTICE.md in ${vendoredDir}: ${(err as Error).message}`,
    );
  }
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
 * FR-152 / FR-158: extract the FIELDS BLOCK out of a per-harness frontmatter
 * sidecar (`frontmatter.claude.md` or `frontmatter.gemini.md`). The on-disk
 * shape is `---\n<fields>\n---\n` (matches inline-frontmatter convention).
 * This helper returns only `<fields>` (without the surrounding `---`
 * delimiters) so `assembleClaudeHarness` / `assembleGeminiHarness` can re-wrap
 * with their own delimiters. When the input has no delimiters (e.g., a
 * malformed sidecar or a TD-195 inline-extracted tempfile that's already
 * pre-stripped), returns the input verbatim. Mirrors
 * `_common.sh:parse_frontmatter` byte semantics.
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
 *
 * TD-201: applies `isAgentTreeSkipped` (same skip-list as `hashAgentTree`).
 * Cross-implementation hash parity with bash `hash_agent_tree` (reused for
 * skills under L-519 / TD-201 Option B) requires identical skip-lists on
 * both sides — otherwise `.DS_Store` / `__pycache__` etc. landing in either
 * tree silently flips the hash and produces false-DRIFTED verdicts. The
 * `harness.{claude,gemini}.md` top-level exclusion is moot for skills (they
 * don't carry α-assembly output) but kept for parity with the shared
 * algorithm.
 */
function hashSkillTree(treeDir: string): string {
  const h = createHash("sha256");
  const rels: string[] = [];
  function walk(rel: string): void {
    const abs = rel === "" ? treeDir : join(treeDir, rel);
    const entries = readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      if (isAgentTreeSkipped(e.name)) continue;
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        walk(childRel);
      } else if (e.isFile()) {
        // TD-201 / FR-158 / FR-159: parity with hashAgentTree — exclude
        // top-level per-harness α-assembly outputs from the basis. Moot for
        // skills today (none produce these) but harmless and keeps the two
        // helpers algorithmically aligned across the FR-158 rename
        // (`harness.md` → `harness.{claude,gemini}.md`) and the FR-159
        // codex TS port (`harness.codex.toml`).
        if (
          rel === "" &&
          (e.name === "harness.claude.md" ||
            e.name === "harness.gemini.md" ||
            e.name === "harness.codex.toml" ||
            e.name === "harness.opencode.md")
        ) {
          continue;
        }
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
  if (origin.type !== "path") {
    return { status: "skipped", note: `non-path skill origin '${origin.type}'` };
  }
  try {
    vendorSkillTreeAtomic(origin.dir, destDir);
  } catch (err) {
    return `error: failed to re-vendor skill: ${(err as Error).message}`;
  }
  const newHash = hashSkillTree(destDir);
  // TD-202 in-band notice — emitted post-hash so the notice's bytes never
  // enter the basis. Re-emit on every re-vendor so the sidecar reflects the
  // CURRENT origin (operator may have moved the source between vendor cycles).
  writeRegistryNotice(destDir, origin.dir, name, "skill");
  return newHash === origin.hash
    ? { status: "unchanged", origin: { ...origin, hash: newHash } }
    : { status: "changed", origin: { ...origin, hash: newHash } };
}

/**
 * FR-156 / FR-158: derive the {frontmatter sidecars, body_filename} list that
 * `assembleClaudeHarness` + `assembleGeminiHarness` need, POST-VENDOR. Tree
 * vendoring brings the entire source dir minus the skip-list; the assemblers
 * only consume the frontmatter sidecar(s) + ONE body file (latest
 * `system-prompt-vN.md` when versioned, the named unversioned file otherwise).
 *
 * FR-158: includes BOTH `frontmatter.claude.md` and `frontmatter.gemini.md`
 * when present, so the Gemini assembler can find its operator-authored
 * override (path 1) before falling back to auto-translate from the Claude
 * sidecar (path 2). Operates over top-level vendored files (does NOT descend
 * into nested sibling dirs like `routing/` or `archetypes/`).
 */
function pickAssemblyFiles(
  vendoredDir: string,
  versioned: boolean,
  glob: string | undefined,
  unversionedFile: string | undefined,
): string[] {
  const top = readdirSync(vendoredDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);
  const out: string[] = [];
  // FR-158: order matters only for human-readability — assemblers locate
  // each sidecar by `existsSync(join(vendoredDir, ...))` directly, not by
  // index into this list.
  if (top.includes("frontmatter.claude.md")) {
    out.push("frontmatter.claude.md");
  }
  if (top.includes("frontmatter.gemini.md")) {
    out.push("frontmatter.gemini.md");
  }
  if (versioned) {
    const re = globToRegExp(glob ?? "");
    for (const n of top) {
      if (n === "frontmatter.claude.md" || n === "frontmatter.gemini.md") {
        continue;
      }
      if (re.test(n)) out.push(n);
    }
  } else if (unversionedFile !== undefined && top.includes(unversionedFile)) {
    out.push(unversionedFile);
  }
  return out;
}

// ---------------------------------------------------------------------------
// FR-156: AGENT-TREE vendor primitives. Promote the agent vendor path from
// "file-set" (vendorSurfaceAtomic over frontmatter.claude.md +
// system-prompt-vN.md)
// to "tree vendor" (whole source directory minus a fixed skip-list) so agents
// with sibling content (DECK's routing/+registry/, DESIGNER's archetypes/)
// vendor self-sufficiently — closes the L-516 violation where supporting
// files lived in the operator's source dir only. Symmetric topology with the
// TD-191 SKILL-TREE primitives above (L-519 §18.1).
// ---------------------------------------------------------------------------

/**
 * FR-156 vendor + hash skip-list (basename-keyed). MUST stay byte-for-byte
 * in sync with THREE sites total: TS `isAgentTreeSkipped` (this function),
 * bash `hash_agent_tree` in `core/scripts/cli-adapters/_common.sh`, and the
 * two inline Python `EXACT` sets in `check_harness_drift.sh` (one for the
 * agent tree-diff at ~line 556, one for the skill tree-diff at ~line 912).
 * Skips operator-author noise (`MAINTAINING.md`), filesystem cruft
 * (`.DS_Store`), VCS metadata (`.git*` glob — intentional
 * `.git`/`.gitignore`/`.gitkeep`/`.github` sweep), language caches
 * (`__pycache__/`, `*.pyc`), node deps (`node_modules/`), venvs (`.venv/`),
 * and the TD-202 `REGISTRY-NOTICE.md` vendored sidecar (emitted post-vendor
 * + post-hash so it is never in the basis, but skip-listed as defense-in-
 * depth — if a future caller writes the notice BEFORE hashing, the skip-list
 * keeps the hash basis invariant). Returns true when the basename should be
 * SKIPPED.
 */
function isAgentTreeSkipped(name: string): boolean {
  // Exact basenames.
  if (name === "MAINTAINING.md") return true;
  if (name === ".DS_Store") return true;
  if (name === "node_modules") return true;
  if (name === ".venv") return true;
  if (name === "__pycache__") return true;
  if (name === "REGISTRY-NOTICE.md") return true; // TD-202 vendored-copy notice
  // Globs.
  if (name.startsWith(".git")) return true; // .git, .gitignore, .gitkeep, .github
  if (name.endsWith(".pyc")) return true;
  return false;
}

/**
 * FR-156 atomically vendor an agent's source tree into `destDir`. Mirrors
 * `vendorSkillTreeAtomic`'s atomicity posture (sibling temp dir on the same
 * filesystem, then `renameSync`) but WITHOUT the SKILL.md root-discriminator
 * (agents have no equivalent gate). Empty-after-skip throws so callers can
 * roll back. Containment (L-515): symlinks are intentionally NOT followed in
 * `copyAgentTreeRecursive` — `readdirSync(.., withFileTypes:true)` reports
 * symlinks via `e.isSymbolicLink()`, and our copy branches only on
 * `e.isDirectory()` / `e.isFile()`, so symlink entries fall through and are
 * dropped (vendor is bytes, not refs). Future remote-agent sources MUST
 * clamp resolved paths inside the fetch sandbox before calling this
 * primitive.
 */
function vendorAgentTreeAtomic(srcDir: string, destDir: string): void {
  mkdirSync(dirname(destDir), { recursive: true });
  const tmp = `${destDir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  let copied = 0;
  try {
    copied = copyAgentTreeRecursive(srcDir, tmp);
    if (copied === 0) {
      throw new Error(
        `no files in ${srcDir} after applying the agent-tree skip-list`,
      );
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
 * Recursively copy an agent's directory tree (files + nested subdirs)
 * applying `isAgentTreeSkipped` at EACH level. Symlinks are intentionally
 * skipped (containment + "vendor is bytes, not refs" — same posture as
 * `copySkillTreeRecursive`). Returns the number of FILES copied so the
 * caller can enforce the "empty after skip" guard.
 */
function copyAgentTreeRecursive(srcDir: string, destDir: string): number {
  const entries = readdirSync(srcDir, { withFileTypes: true });
  let count = 0;
  for (const e of entries) {
    if (isAgentTreeSkipped(e.name)) continue;
    const s = join(srcDir, e.name);
    const d = join(destDir, e.name);
    if (e.isDirectory()) {
      mkdirSync(d, { recursive: true });
      count += copyAgentTreeRecursive(s, d);
    } else if (e.isFile()) {
      copyFileSync(s, d);
      count += 1;
    }
    // Symlinks intentionally skipped — L-515 containment (don't follow
    // symlinks out of the source tree) + vendor-as-bytes invariant.
  }
  return count;
}

/**
 * FR-156 / FR-158 stable content hash over a vendored agent tree. Same idiom
 * as `hashSkillTree` (sorted relpath + `\0` + bytes folded into one sha256)
 * but applies `isAgentTreeSkipped` AND explicitly excludes the per-harness
 * α-assembly outputs (`harness.claude.md`, `harness.gemini.md`). The
 * exclusion is load-bearing: those files are FR-152/FR-158 DERIVED OUTPUT
 * (from `frontmatter.{claude,gemini}.md` + chosen system-prompt-vN.md +
 * body-exception), and including them in the hash basis would make every
 * assembly re-write read as drift — same "hash before assembly" principle
 * `hashSurface` uses by computing the hash BEFORE the two assemble* calls
 * at every vendor call site.
 *
 * Skip-list MUST match `isAgentTreeSkipped` byte-for-byte AND the bash
 * `hash_agent_tree` helper in `_common.sh` — three sites, one rule. The
 * harness-output exclusion lives in the same 5 sites (TS hashAgentTree +
 * hashSkillTree, bash hash_agent_tree, drift inline Python agent + skill).
 */
function hashAgentTree(treeDir: string): string {
  const h = createHash("sha256");
  const rels: string[] = [];
  function walk(rel: string): void {
    const abs = rel === "" ? treeDir : join(treeDir, rel);
    const entries = readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      if (isAgentTreeSkipped(e.name)) continue;
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        walk(childRel);
      } else if (e.isFile()) {
        // FR-156 / FR-158 / FR-159: per-harness outputs
        // (`harness.claude.md`, `harness.gemini.md`, `harness.codex.toml`)
        // are derived OUTPUT from α-assembly — excluding them from the
        // hash basis keeps assembly re-runs from registering as drift.
        // Mirrors `hashSurface`'s "hash before assembly" timing.
        if (
          rel === "" &&
          (e.name === "harness.claude.md" ||
            e.name === "harness.gemini.md" ||
            e.name === "harness.codex.toml" ||
            e.name === "harness.opencode.md")
        ) {
          continue;
        }
        rels.push(childRel);
      }
      // Symlinks skipped — see copyAgentTreeRecursive for rationale.
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
      "valid pairs: claude/symlink, codex/symlink, gemini/symlink, agents/symlink, opencode/command"
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

  // FR-155: parse the scope flags FIRST (usage errors exit 2 before any
  // disk side effect). The `desiredScope` computed here is what a NEW entry
  // receives (when `--scope global` or no scope flags → undefined / global
  // default; `--project P` → project scope with paths=[realpath(P)]). For an
  // existing same-name entry the branching below uses the raw opts to decide
  // append/convert/error.
  if (opts.scope === "global" && opts.project !== undefined) {
    logError(
      "registry add: --scope global is incompatible with --project (global " +
        "entries have no paths[]). Omit --project to convert to global.",
    );
    return 2;
  }
  if (opts.scope === "project" && opts.project === undefined) {
    logError(
      "registry add: --scope project requires --project <path> (paths[] must " +
        "be non-empty for project scope).",
    );
    return 2;
  }
  // --project alone (no --scope) implies project scope for a NEW entry; on a
  // same-name existing entry, the branching below decides append vs. error.
  const projectArg: string | undefined =
    opts.project !== undefined && opts.project.length > 0
      ? realpathStrict(opts.project)
      : undefined;

  const entry: AgentEntry = {
    name: opts.name,
    layer: "personal",
    canonical,
    targets,
  };
  if (opts.bodyException !== undefined && opts.bodyException.length > 0) {
    entry.body_exception = opts.bodyException;
  }
  // FR-155: write `scope` ONLY when project-scoped. Global is the default
  // and the on-disk overlay OMITS the field (schema treats absent as global)
  // to minimize diff churn for pre-FR-155 overlays. A scope=global entry
  // therefore looks IDENTICAL on disk to a pre-FR-155 entry.
  if (projectArg !== undefined) {
    entry.scope = { type: "project", paths: [projectArg] };
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

  // FR-155: same-name re-add branching. ORDER MATTERS — this runs BEFORE the
  // existing intra-overlay reject so the scope-aware paths (append, convert,
  // explicit error) get to handle the collision. Cases:
  //   - existing.scope=project + --project P (no --scope): APPEND realpath(P)
  //     to existing.scope.paths (idempotent — silent dedupe). Targets and
  //     canonical NOT re-vendored (use `update` for that).
  //   - existing.scope=global + --project P (no --scope): ERROR with the
  //     `--scope project` hint (the explicit conversion path).
  //   - existing.* + --scope project + --project P: CONVERT to project (or
  //     reset paths to [realpath(P)] if already project).
  //   - existing.* + --scope global: CONVERT to global (paths dropped).
  //   - existing + no scope flags: fall through to the existing reject.
  const existingIndex = overlay.agents.findIndex((a) => a.name === opts.name);
  if (existingIndex >= 0) {
    const existing = overlay.agents[existingIndex];
    const existingScopeType = existing.scope?.type ?? "global";

    // --scope global: CONVERT existing to global, drop paths.
    if (opts.scope === "global") {
      const mutated: AgentEntry = { ...existing };
      delete mutated.scope;
      overlay.agents[existingIndex] = mutated;
      const overlayErr = validateOverlayShape(overlay);
      if (overlayErr !== null) {
        logError(`registry add: resulting overlay invalid: ${overlayErr}`);
        return 1;
      }
      try {
        writeOverlayAtomic(overlayPath, overlay);
      } catch (err) {
        logError(
          `registry add: failed to write overlay: ${(err as Error).message}`,
        );
        return 1;
      }
      info(
        `Converted agent '${opts.name}' to scope=global (paths dropped). ` +
          `Overlay: ${overlayPath}`,
      );
      return 0;
    }

    // --scope project: CONVERT (or reset) to project scope. --project is
    // required (gate above already enforces this when --scope project is set).
    if (opts.scope === "project") {
      const mutated: AgentEntry = {
        ...existing,
        scope: { type: "project", paths: [projectArg!] },
      };
      overlay.agents[existingIndex] = mutated;
      const overlayErr = validateOverlayShape(overlay);
      if (overlayErr !== null) {
        logError(`registry add: resulting overlay invalid: ${overlayErr}`);
        return 1;
      }
      try {
        writeOverlayAtomic(overlayPath, overlay);
      } catch (err) {
        logError(
          `registry add: failed to write overlay: ${(err as Error).message}`,
        );
        return 1;
      }
      info(
        `Converted agent '${opts.name}' to scope=project paths=[${projectArg!}]. ` +
          `Overlay: ${overlayPath}`,
      );
      return 0;
    }

    // No --scope; just --project. Append (project→project additive) OR error
    // (global→project narrowing — explicit conversion required).
    if (projectArg !== undefined) {
      if (existingScopeType === "project") {
        const existingPaths = existing.scope?.type === "project"
          ? existing.scope.paths
          : [];
        if (existingPaths.includes(projectArg)) {
          // Idempotent — no overlay write, no error.
          info(
            `Agent '${opts.name}' already includes project path ${projectArg}; ` +
              `overlay unchanged.`,
          );
          return 0;
        }
        const mutated: AgentEntry = {
          ...existing,
          scope: { type: "project", paths: [...existingPaths, projectArg] },
        };
        overlay.agents[existingIndex] = mutated;
        const overlayErr = validateOverlayShape(overlay);
        if (overlayErr !== null) {
          logError(`registry add: resulting overlay invalid: ${overlayErr}`);
          return 1;
        }
        try {
          writeOverlayAtomic(overlayPath, overlay);
        } catch (err) {
          logError(
            `registry add: failed to write overlay: ${(err as Error).message}`,
          );
          return 1;
        }
        info(
          `Appended project path ${projectArg} to agent '${opts.name}' ` +
            `(scope.paths now has ${mutated.scope!.type === "project" ? mutated.scope!.paths.length : 0} entries). Overlay: ${overlayPath}`,
        );
        return 0;
      }
      // existing scope=global; --project narrows availability → require
      // explicit --scope project per the FR-155 decision (no silent convert).
      logError(
        `registry add: entry '${opts.name}' is currently scope=global; ` +
          `re-run with --scope project to convert (this narrows availability — ` +
          `claude/codex/gemini outside the listed --project paths will stop ` +
          `seeing '${opts.name}'). Overlay unchanged: ${overlayPath}`,
      );
      return 1;
    }
    // No scope flags at all — fall through to the existing reject below.
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

  // All guards passed → VENDOR the agent TREE (atomic), then persist the
  // overlay, then record the origin. FR-156 promotes the vendor from
  // "file-set" to "tree" so sibling files (DECK's routing/+registry/,
  // DESIGNER's archetypes/) land in the registry alongside the body. If
  // overlay persist fails after vendoring, clean up the just-vendored tree
  // so a rejected add leaves no orphan copy.
  //
  // `assembleClaudeHarness` / `assembleGeminiHarness` still need the EXACT
  // input set (frontmatter + chosen system-prompt-vN.md) — we recompute it
  // POST-VENDOR by filtering top-level vendored files against the canonical
  // glob/file. This keeps FR-152 assembly semantics unchanged.
  let hash: string;
  try {
    vendorAgentTreeAtomic(resolved.srcDir, vendoredDir);
    hash = hashAgentTree(vendoredDir);
    // FR-152 / FR-158 α-assembly: emit BOTH per-harness derived outputs
    // (`harness.claude.md` and `harness.gemini.md`) alongside frontmatter +
    // body so claude/gemini compile-time symlinks resolve to their
    // respective registry file. No-op when no FR-151/FR-158 sidecar exists
    // (the Gemini assembler will also no-op when neither sidecar is present).
    // Hash is computed BEFORE assembly so derived files are excluded from
    // origin freshness (downstream-derived; `hashAgentTree` also excludes
    // both renamed outputs from the basis as belt-and-suspenders).
    const bxPath = resolvePersonalBodyExceptionPath(entry.body_exception);
    const assemblyFiles = pickAssemblyFiles(
      vendoredDir,
      opts.versioned === true,
      opts.glob,
      unversionedFile,
    );
    assembleClaudeHarness(vendoredDir, assemblyFiles, bxPath);
    assembleGeminiHarness(vendoredDir, assemblyFiles, bxPath);
    assembleCodexHarness(vendoredDir, assemblyFiles, bxPath);
    assembleOpencodeHarness(vendoredDir, assemblyFiles, bxPath);
  } catch (err) {
    rmSync(vendoredDir, { recursive: true, force: true });
    logError(`registry add: failed to vendor canonical files: ${(err as Error).message}`);
    return 1;
  }
  // TD-202 in-band notice — emitted post-hash (line 1986), post-assemble,
  // OUTSIDE the vendor try/catch so a sidecar-write failure can NEVER
  // trigger the rollback. Helper has its own internal try/catch (best-effort
  // UX; the overlay write below is the contract).
  writeRegistryNotice(vendoredDir, resolved.srcDir, opts.name, "agent");

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
    // FR-156: tree vendor (mirrors the path-origin branch). `selected.srcDir`
    // is already the sandbox-clamped subdir under the fetched repo, so the
    // tree walk stays inside the sandbox (L-515).
    let hash: string;
    try {
      vendorAgentTreeAtomic(selected.srcDir, vendoredDir);
      hash = hashAgentTree(vendoredDir);
      // FR-152 / FR-158 α-assembly (github path): mirrors the path-origin
      // call above. Personal layer body-exception sidecar resolution (FR-144).
      // Hash already computed before assembly to keep derived outputs out of
      // origin freshness.
      const bxPath = resolvePersonalBodyExceptionPath(entry.body_exception);
      const assemblyFiles = pickAssemblyFiles(
        vendoredDir,
        selected.entry.canonical.versioned === true,
        selected.entry.canonical.glob,
        selected.entry.canonical.file,
      );
      assembleClaudeHarness(vendoredDir, assemblyFiles, bxPath);
      assembleGeminiHarness(vendoredDir, assemblyFiles, bxPath);
      assembleCodexHarness(vendoredDir, assemblyFiles, bxPath);
      assembleOpencodeHarness(vendoredDir, assemblyFiles, bxPath);
    } catch (err) {
      rmSync(vendoredDir, { recursive: true, force: true });
      logError(
        `registry add: failed to vendor canonical files: ${(err as Error).message}`,
      );
      return 1;
    }
    // TD-202 in-band notice — for github origins, the editor cannot `cd` to
    // the fetched temp dir (cleaned up below in finally). Pass the canonical
    // github URI so the notice points the editor at the upstream repo.
    // Emitted OUTSIDE the vendor try/catch so a sidecar-write failure can
    // NEVER trigger rollback (helper has its own internal try/catch).
    const githubRef = `github:${spec.owner}/${spec.repo}@${spec.ref}`;
    writeRegistryNotice(vendoredDir, githubRef, name, "agent");

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

  // FR-155: parse scope flags BEFORE any disk side effect (overlay reads do
  // happen below but no writes/vendors until all guards pass). Same usage
  // contract as `runAdd`: `--scope global` is incompatible with `--project`;
  // `--scope project` requires `--project`. Mirrors L-519.
  if (opts.scope === "global" && opts.project !== undefined) {
    logError(
      "registry add-skill: --scope global is incompatible with --project " +
        "(global blocks have no paths[]). Omit --project to convert to global.",
    );
    return 2;
  }
  if (opts.scope === "project" && opts.project === undefined) {
    logError(
      "registry add-skill: --scope project requires --project <path> " +
        "(paths[] must be non-empty for project scope).",
    );
    return 2;
  }
  const projectArg: string | undefined =
    opts.project !== undefined && opts.project.length > 0
      ? realpathStrict(opts.project)
      : undefined;

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

  // FR-149/FR-157: any <type>:symlink:<path> must NOT resolve INSIDE
  // ~/.igris/registry/. The symlink target IS the registry-vendored copy;
  // aiming any symlink target there would create a self-referential link
  // the compiler can't safely follow. FR-157 widens the original claude-
  // only guard to all symlink methods (codex/gemini/agents) — the cycle
  // hazard was always type-agnostic; claude-only was a code-paint accident.
  // See L-515 (containment) + L-519.
  const registryRoot = registryDirPath();
  for (const t of newTargets) {
    if (t.method === "symlink") {
      const resolved = resolveSourcePath(t.path, projectRoot);
      if (resolved === registryRoot || resolved.startsWith(`${registryRoot}/`)) {
        logError(
          `registry add-skill: ${t.type}:symlink target '${t.path}' resolves under ` +
            `the registry root (${registryRoot}); the symlink target IS the ` +
            "registry — pointing a target inside the registry creates a cycle. " +
            "Use a path under ~/.claude/skills/, ~/.agents/skills/, or another consumer location.",
        );
        return 1;
      }
    }
  }

  // TD-218 (Option A): reject a per-skill symlink target whose basename equals
  // the skill name. The compile loop appends `/<skill_name>` to the target
  // `path` (the contract is that `path` is the PARENT skills dir — e.g.
  // `~/.agents/skills`). A target that ALREADY ends in `/<name>` (e.g.
  // `~/.agents/skills/content-pipeline`) double-appends → a depth-2 nest
  // (`~/.agents/skills/content-pipeline/content-pipeline/SKILL.md`) that
  // native loaders (which scan depth-1) never discover. Reject at write-time
  // so malformed per-skill paths never enter the overlay; the deployed-data
  // repair + the compiler de-dup (Option C) handle already-malformed
  // manifests. This is a pure basename-equality check — NO path resolution,
  // so it does not touch the L-515 containment guard above. See TD-218, L-519.
  for (const t of newTargets) {
    if (t.method === "symlink" && basename(t.path) === name) {
      logError(
        `registry add-skill: ${t.type}:symlink target '${t.path}' ends in the ` +
          `skill name '${name}'. Use the PARENT skills dir (e.g. ` +
          `'${dirname(t.path)}'), NOT '${t.path}' — the compiler appends ` +
          `'/${name}' for you, so a per-skill path double-nests to ` +
          `'${t.path}/${name}/SKILL.md', which native loaders (depth-1 scan) ` +
          "cannot discover. Overlay unchanged.",
      );
      return 1;
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

  // FR-155: resolve the resulting block scope from (existing scope) × (opts).
  // Skill blocks re-vendor on same-name re-add (the normal flow), so unlike
  // `runAdd` the scope mutation is folded INTO the re-vendor — there's no
  // separate "additive-only" early-return path. Same conflict semantics:
  //   - new block (no existing): scope from opts (project iff --project,
  //     else global → field omitted on disk).
  //   - existing + --scope global: drop scope (convert to global).
  //   - existing + --scope project + --project P: set scope=project paths=[P].
  //   - existing.scope=project + --project P (no --scope): append P (idempotent).
  //   - existing.scope=global + --project P (no --scope): ERROR (per FR-155 decision).
  //   - existing + no scope flags: preserve existing scope verbatim.
  const existingBlock: SkillsSurface | undefined =
    existingBlockIndex >= 0 ? existingBlocks[existingBlockIndex] : undefined;
  const existingScope: Scope | undefined = existingBlock?.scope;
  const existingScopeType: "global" | "project" = existingScope?.type ?? "global";
  let resolvedScope: Scope | undefined;
  if (existingBlockIndex < 0) {
    // New block — scope from opts only.
    resolvedScope =
      projectArg !== undefined
        ? { type: "project", paths: [projectArg] }
        : undefined;
  } else if (opts.scope === "global") {
    // Convert existing to global; field omitted.
    resolvedScope = undefined;
  } else if (opts.scope === "project") {
    // Explicit conversion to project — projectArg is required (gated above).
    resolvedScope = { type: "project", paths: [projectArg!] };
  } else if (projectArg !== undefined) {
    // No --scope, just --project: append OR error.
    if (existingScopeType === "project") {
      const existingPaths =
        existingScope?.type === "project" ? existingScope.paths : [];
      if (existingPaths.includes(projectArg)) {
        resolvedScope = { type: "project", paths: [...existingPaths] };
      } else {
        resolvedScope = {
          type: "project",
          paths: [...existingPaths, projectArg],
        };
      }
    } else {
      logError(
        `registry add-skill: block '${name}' is currently scope=global; ` +
          `re-run with --scope project to convert (this narrows availability — ` +
          `claude/codex/gemini outside the listed --project paths will stop ` +
          `seeing skill block '${name}'). Overlay unchanged: ${overlayPath}`,
      );
      return 1;
    }
  } else {
    // No scope flags — preserve existing scope verbatim.
    resolvedScope =
      existingScope !== undefined ? { ...existingScope } : undefined;
  }

  // Build the block. `source` points at the VENDORED tree per L-516.
  const skillVendorDirFor = opts.skillVendorDir ?? registrySkillDirPath;
  const vendoredDir = skillVendorDirFor(name);
  const newBlock: SkillsSurface = {
    source: vendoredDir,
    layer: "personal",
    targets: unionedTargets,
  };
  // FR-155: write `scope` ONLY when project-scoped (back-compat: a global
  // block on disk looks identical to a pre-FR-155 block).
  if (resolvedScope !== undefined) {
    newBlock.scope = resolvedScope;
  }

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
  // TD-202 in-band notice — emitted post-hash (above), OUTSIDE the vendor
  // try/catch. L-517 nested layout: helper drops the notice next to every
  // SKILL.md it locates under vendoredDir. Best-effort UX; no rollback on
  // failure (helper has its own internal try/catch).
  writeRegistryNotice(vendoredDir, consumerSourceDir, name, "skill");

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

/**
 * FR-180: structured result of the personal-skill materialize half. `add.ts`
 * uses this to chain project+verify after a successful write; the exit-code
 * entry point (`runAddSkill`) is untouched (R7 guard — no logic moved out of
 * the heavily-tested write path).
 */
export interface SkillMaterializeResult {
  /** True iff the write path returned 0 (vendor + overlay + origin all landed). */
  ok: boolean;
  /** The exit code `runAddSkill` produced (0 on success, 1/2 on reject). */
  code: number;
  /** The registry vendored-tree dir (`~/.igris/registry/skills/<name>/`). */
  vendoredDir: string;
  /** The overlay manifest path the block was written to. */
  overlayWritten: string;
}

/**
 * FR-180: thin structured-return wrapper over `runAddSkill`. Calls the existing
 * exit-code writer verbatim (so every FR-142/148/155/162 guard + the atomic
 * vendor/overlay/origin path runs unchanged) and re-shapes the success/failure
 * into a `SkillMaterializeResult` so `verbs/add.ts` can decide whether to
 * proceed to `projectAndVerify`. `vendoredDir` is derived deterministically
 * from the same seam `runAddSkill` vendors into (`skillVendorDir` override or
 * `registrySkillDirPath`), so it is valid whether or not the write succeeded
 * (the caller only consumes it when `ok` is true).
 *
 * See R7 (registry write-path regression guard) + D9 (materialize/project
 * boundary) in FR-180-plan.
 */
export function materializeSkill(
  opts: RegistryOptions,
  overlayPath: string,
): SkillMaterializeResult {
  const code = runAddSkill(opts, overlayPath);
  const skillVendorDirFor = opts.skillVendorDir ?? registrySkillDirPath;
  const vendoredDir =
    opts.name !== undefined && opts.name.length > 0
      ? skillVendorDirFor(opts.name)
      : "";
  return {
    ok: code === 0,
    code,
    vendoredDir,
    overlayWritten: overlayPath,
  };
}

/**
 * FR-180 (Phase 2): structured result of the personal-AGENT materialize half.
 * Mirrors {@link SkillMaterializeResult} so `add.ts`'s agent arm can chain
 * project+verify off a structured outcome. `runAdd` (agent) is async (it may
 * fetch a `github:` source), so {@link materializeAgent} is async too — the only
 * shape difference from the skill wrapper.
 */
export interface AgentMaterializeResult {
  /** True iff the write path returned 0 (vendor tree + overlay + origin landed). */
  ok: boolean;
  /** The exit code `runAdd` (agent) produced (0 on success, 1/2 on reject). */
  code: number;
  /** The registry vendored-tree dir (`~/.igris/registry/agents/<name>/`). */
  vendoredDir: string;
  /** The overlay manifest path the block was written to. */
  overlayWritten: string;
}

/**
 * FR-180 (Phase 2): thin structured-return wrapper over the EXISTING agent
 * writer `runAdd` (the exit-code entry point at the top of this file). Calls it
 * verbatim — every FR-142/148/155/156/158 guard + the atomic vendor-tree /
 * α-assembly / overlay / origin path runs unchanged (R7: no logic moved out of
 * the heavily-tested write path) — and re-shapes the result into an
 * {@link AgentMaterializeResult} so `verbs/add.ts` can decide whether to proceed
 * to `projectAndVerify("agents", …)`. `vendoredDir` is derived from the same
 * `vendorDir` seam `runAdd` vendors into (`registryAgentDirPath` default), so it
 * is valid regardless of write outcome (the caller only consumes it on success).
 *
 * See R7 (registry write-path regression guard) + D9 (materialize/project
 * boundary) in FR-180-plan.
 */
export async function materializeAgent(
  opts: RegistryOptions,
  overlayPath: string,
): Promise<AgentMaterializeResult> {
  const code = await runAdd(opts, overlayPath);
  const vendorDirFor = opts.vendorDir ?? registryAgentDirPath;
  const vendoredDir =
    opts.name !== undefined && opts.name.length > 0
      ? vendorDirFor(opts.name)
      : "";
  return {
    ok: code === 0,
    code,
    vendoredDir,
    overlayWritten: overlayPath,
  };
}

/**
 * FR-180 (Phase 3): structured result of the personal-MCP materialize half.
 * Mirrors {@link SkillMaterializeResult}/{@link AgentMaterializeResult} so
 * `add.ts`'s mcp arm can chain project+verify off a structured outcome. An MCP
 * block has NO vendor tree (it carries an inline `${VAR}`-indirected command
 * ref, not a copied source dir — see `runAddMcp`), so there is no `vendoredDir`
 * field; the only on-disk write is the overlay block + the inline origin.
 */
export interface McpMaterializeResult {
  /** True iff the write path returned 0 (overlay block + origin landed). */
  ok: boolean;
  /** The exit code `runAddMcp` produced (0 on success, 1/2 on reject). */
  code: number;
  /** The overlay manifest path the block was written to. */
  overlayWritten: string;
}

/**
 * FR-180 (Phase 3): thin structured-return wrapper over the EXISTING MCP writer
 * `runAddMcp`. Calls it VERBATIM — every FR-162 guard (name/pattern, ≥1 target,
 * global-only scope reject, the §14 `--env` `${VAR}`-indirection WRITE GUARD
 * that REJECTS inline secrets, the `--command`-required / re-add-inherit logic,
 * the core-collision reject, the atomic overlay+origin write) runs unchanged
 * (R7: no logic moved out of the heavily-tested write path) — and re-shapes the
 * result into an {@link McpMaterializeResult} so `verbs/add.ts` can decide
 * whether to proceed to `projectAndVerify("mcp", …)`.
 *
 * `runAddMcp` is synchronous (an inline MCP ref has no `github:` fetch), so this
 * wrapper is synchronous too — the shape difference from the (async) agent
 * wrapper. See R7 (registry write-path regression guard) + D9 (materialize/
 * project boundary) in FR-180-plan.
 */
export function materializeMcp(
  opts: RegistryOptions,
  overlayPath: string,
): McpMaterializeResult {
  const code = runAddMcp(opts, overlayPath);
  return {
    ok: code === 0,
    code,
    overlayWritten: overlayPath,
  };
}

/**
 * FR-180 (D6): structured-return shape for the identity materialize wrapper.
 * Mirrors {@link McpMaterializeResult} — a personal identity block is an overlay
 * write ONLY (no vendor tree, no inline origin), so the only field beyond
 * ok/code is the overlay it was written to.
 */
export interface IdentityMaterializeResult {
  /** True iff the write path returned 0 (overlay os_identity block landed). */
  ok: boolean;
  /** The exit code `runAddIdentity` produced (0 on success, 1/2 on reject). */
  code: number;
  /** The overlay manifest path the block was written to. */
  overlayWritten: string;
}

/**
 * FR-180 (D6): thin structured-return wrapper over the identity overlay writer
 * `runAddIdentity` so `verbs/add.ts`'s identity arm can chain
 * `projectAndVerify("identity", …)` off a structured outcome (R7: no logic in
 * the wrapper — every guard runs in `runAddIdentity`). Synchronous (an identity
 * block is an inline overlay write, no `github:` fetch — same shape as the MCP
 * wrapper).
 */
export function materializeIdentity(
  opts: RegistryOptions,
  overlayPath: string,
): IdentityMaterializeResult {
  const code = runAddIdentity(opts, overlayPath);
  return {
    ok: code === 0,
    code,
    overlayWritten: overlayPath,
  };
}

/**
 * FR-180 (D7): structured-return result for the personal hook materialize.
 * Mirrors {@link IdentityMaterializeResult} — a personal hook write produces an
 * overlay block + the registry hook SCRIPT, so beyond ok/code it surfaces the
 * overlay it was written to.
 */
export interface HookMaterializeResult {
  /** True iff the write path returned 0 (overlay hook block + script landed). */
  ok: boolean;
  /** The exit code `runAddHook` produced (0 on success, 1/2 on reject). */
  code: number;
  /** The overlay manifest path the block was written to. */
  overlayWritten: string;
}

/**
 * FR-180 (D7): thin structured-return wrapper over the hook overlay writer
 * `runAddHook` so `verbs/add.ts`'s hook arm can chain `projectAndVerify` off a
 * structured outcome (R7: no logic in the wrapper — every guard runs in
 * `runAddHook`). Synchronous (a hook block is an inline overlay write + a local
 * script scaffold, no `github:` fetch — same shape as the MCP/identity wrappers).
 */
export function materializeHook(
  opts: RegistryOptions,
  overlayPath: string,
): HookMaterializeResult {
  const code = runAddHook(opts, overlayPath);
  return {
    ok: code === 0,
    code,
    overlayWritten: overlayPath,
  };
}

// ---------------------------------------------------------------------------
// FR-162 (FR-160 epic): add-mcp helpers + verb
// ---------------------------------------------------------------------------

/**
 * FR-162: parse one MCP `--target` spec. Grammar is `type:merge` or
 * `type:merge:enabled` (enabled = "true"/"false"). DIFFERENT grammar from the
 * agent `type:path` and skill `type:method:path` forms — the shared `--target`
 * Commander flag is routed through this parser only when `action === add-mcp`
 * (same overload pattern `add-skill` uses with `parseSkillTarget`). Returns the
 * `McpTarget` or an error string for the verb to log + reject.
 */
function parseMcpTarget(spec: string): McpTarget | string {
  const parts = spec.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return `--target '${spec}' must be of the form type:merge[:enabled]`;
  }
  const [type, method, enabledRaw] = parts;
  if (!(VALID_MCP_TARGET_TYPES as readonly string[]).includes(type)) {
    return `--target type '${type}' is not one of ${JSON.stringify(VALID_MCP_TARGET_TYPES)}`;
  }
  if (!(VALID_MCP_METHODS as readonly string[]).includes(method)) {
    return `--target method '${method}' is not one of ${JSON.stringify(VALID_MCP_METHODS)}`;
  }
  const t: McpTarget = { type: type as McpTargetType, method: method as McpMethod };
  if (enabledRaw !== undefined) {
    if (enabledRaw !== "true" && enabledRaw !== "false") {
      return `--target '${spec}' enabled flag must be 'true' or 'false'`;
    }
    t.enabled = enabledRaw === "true";
  }
  return t;
}

/**
 * FR-162: the env-var-indirection WRITE GUARD (FR-160 decision #1). Parses
 * `KEY=VALUE` and REJECTS any VALUE that is not a single `${VAR}` reference —
 * inline secrets never enter the registry or any config. The real secret is
 * resolved from the environment by the harness at launch time; the overlay only
 * stores the indirection ref.
 */
const ENV_VAR_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
function parseEnvPair(spec: string): { key: string; value: string } | string {
  const eq = spec.indexOf("=");
  if (eq <= 0) {
    return `--env '${spec}' must be of the form KEY=\${VAR}`;
  }
  const key = spec.slice(0, eq);
  const value = spec.slice(eq + 1);
  if (!ENV_VAR_REF.test(value)) {
    return (
      `--env '${spec}': value '${value}' must be a single \${VAR} reference ` +
      "(e.g. ${MY_TOKEN}), NOT an inline secret. MCP env values are stored as " +
      "indirection refs; the real secret never enters the registry or any config."
    );
  }
  return { key, value };
}

/**
 * FR-162: locate the `mcp_servers` block matching `name`. Mirrors
 * `findSkillBlockIndex`, but keys on `block.name` (the `McpServersSurface.name`
 * field) NOT `basename(source)` — an inline MCP block has no `source`/vendor
 * dir in this child. Returns the block index, or -1 if none matches.
 */
function findMcpBlockIndex(overlay: Overlay, name: string): number {
  const blocks = overlay.surfaces?.mcp_servers;
  if (!Array.isArray(blocks)) {
    return -1;
  }
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]?.name === name) {
      return i;
    }
  }
  return -1;
}

/**
 * FR-162: content hash over an inline MCP launch spec, for the `InlineOrigin`'s
 * `hash` field (future drift detection). Mirrors how `hashSkillTree` produces an
 * origin hash. `createHash` is already imported at the top of the module.
 */
function hashInlineCommand(command: string, args: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ command, args }))
    .digest("hex");
}

/**
 * FR-162 (FR-160 epic): `igris registry add-mcp` — register a GLOBAL MCP server
 * into `surfaces.mcp_servers[]` of the personal overlay, recording an
 * `InlineOrigin`. Modeled on `runAddSkill`'s guard chain; MCP identity is the
 * block NAME (one server per name). v1 is GLOBAL-ONLY (project scope rejected).
 *
 * This verb writes ONLY the overlay (via `writeOverlayAtomic`) + the origin —
 * it does NOT call `mergeJsonConfig` and NEVER touches a live harness config
 * (that compile-time projection is FR-164). Every guard returns BEFORE the
 * first disk write, so the overlay stays UNCHANGED on any reject.
 *
 * Returns an exit code: 0 = success, 1 = enforcement reject, 2 = usage error.
 */
function runAddMcp(opts: RegistryOptions, overlayPath: string): number {
  // Guard 1 — name required + pattern.
  if (opts.name === undefined || opts.name.length === 0) {
    logError("registry add-mcp: <name> is required");
    return 2;
  }
  if (!NAME_PATTERN.test(opts.name)) {
    logError(
      `registry add-mcp: name '${opts.name}' must match /^[a-z0-9][a-z0-9-]*$/`,
    );
    return 2;
  }
  const name = opts.name;

  // Guard 2 — at least one target.
  if (opts.targets === undefined || opts.targets.length === 0) {
    logError(
      "registry add-mcp: at least one --target <type:merge[:enabled]> is required",
    );
    return 2;
  }

  // Guard 4 — v1 GLOBAL-ONLY scope reject (defers FR-160 decision #2). Runs
  // BEFORE any disk read/write. `--scope global` is harmless (no-op); only
  // `--scope project` / `--project` are rejected.
  if (opts.scope === "project" || opts.project !== undefined) {
    logError(
      "registry add-mcp: MCP servers are global-only in v1; --scope project / " +
        "--project are not supported. Omit them to register globally.",
    );
    return 2;
  }

  // Guard parse — targets (MCP grammar via parseMcpTarget).
  const newTargets: McpTarget[] = [];
  for (const spec of opts.targets) {
    const parsed = parseMcpTarget(spec);
    if (typeof parsed === "string") {
      logError(`registry add-mcp: ${parsed}`);
      return 2;
    }
    newTargets.push(parsed);
  }

  // Guard 5 — env-var-indirection WRITE GUARD (FR-160 decision #1), before any
  // disk write. Each --env VALUE must be a single ${VAR} reference.
  const envMap: Record<string, string> = {};
  for (const spec of opts.env ?? []) {
    const parsed = parseEnvPair(spec);
    if (typeof parsed === "string") {
      logError(`registry add-mcp: ${parsed}`);
      return 2;
    }
    envMap[parsed.key] = parsed.value;
  }

  const projectRoot = opts.projectRoot ?? process.cwd();
  const originsPath = opts.originsPath ?? registryOriginsPath();

  // Read existing origins early so a same-name re-add can fall back to the
  // recorded inline command/args when --command is omitted (defense-in-depth).
  let origins: OriginsMap;
  try {
    origins = readOrigins(originsPath);
  } catch (err) {
    logError((err as Error).message);
    return 1;
  }
  const mcpKey = originKey("mcp", name);
  const recordedOrigin: Origin | undefined = origins[mcpKey];

  // Read current overlay (unchanged on any reject below).
  let overlay: Overlay;
  try {
    overlay = readOverlay(overlayPath);
  } catch (err) {
    logError((err as Error).message);
    return 1;
  }
  const existingBlocks = overlay.surfaces?.mcp_servers ?? [];
  const existingBlockIndex = findMcpBlockIndex(overlay, name);
  const existingBlock: McpServersSurface | undefined =
    existingBlockIndex >= 0 ? existingBlocks[existingBlockIndex] : undefined;

  // Guard 3 — --command required for a NEW block; optional on a same-name
  // re-add (inherit the existing canonical command). On re-add, prefer the
  // recorded InlineOrigin's command/args as defense-in-depth, falling back to
  // the existing block's canonical.
  let command: string;
  let args: string[];
  if (opts.command !== undefined && opts.command.length > 0) {
    command = opts.command;
    args = opts.args ?? [];
  } else if (existingBlock !== undefined) {
    if (recordedOrigin !== undefined && recordedOrigin.type === "inline") {
      command = recordedOrigin.command;
      args = recordedOrigin.args;
    } else {
      command = existingBlock.canonical.command;
      args = existingBlock.canonical.args ?? [];
    }
  } else {
    logError(
      `registry add-mcp: --command is required for a new MCP server '${name}' ` +
        "(no existing block to inherit from)",
    );
    return 2;
  }

  // Core-collision reject — a personal MCP must not shadow a core one (the MCP
  // analogue of the skill core-collision guard; MCP identity is the NAME). A
  // same-name re-add of a PERSONAL block is fine (findMcpBlockIndex routes it
  // to an in-place UPDATE) — only a base/core name collision is rejected.
  const baseMcpNames = readBaseMcpNames(projectRoot);
  if (baseMcpNames.has(name)) {
    logError(
      `registry add-mcp: MCP name '${name}' collides with a base (core) ` +
        "mcp_servers block; a personal MCP must not shadow a core one. " +
        "Overlay unchanged.",
    );
    return 1;
  }

  // Append-only union of targets keyed on `type`. A re-add with an existing
  // `type` OVERWRITES that target (so `--target claude:merge:false` can flip
  // `enabled` — strict skip-if-present would make `enabled` un-editable without
  // a remove). New types are appended in order.
  const existingOwnTargets: McpTarget[] = existingBlock?.targets ?? [];
  const unionedTargets: McpTarget[] = existingOwnTargets.map((t) => ({ ...t }));
  for (const t of newTargets) {
    const idx = unionedTargets.findIndex((u) => u.type === t.type);
    if (idx >= 0) {
      unionedTargets[idx] = t;
    } else {
      unionedTargets.push(t);
    }
  }

  // Build the block. No `scope` field — v1 is global-only and Guard 4 already
  // rejected project scope; omitting `scope` makes the on-disk block match a
  // global block.
  const canonical: McpCanonical = { command, args };
  if (Object.keys(envMap).length > 0) {
    canonical.env = envMap;
  }
  if (opts.startupTimeoutSec !== undefined) {
    canonical.startup_timeout_sec = opts.startupTimeoutSec;
  }
  const newBlock: McpServersSurface = {
    name,
    layer: "personal",
    canonical,
    targets: unionedTargets,
  };

  // Per-block validation (the array gate runs in validateOverlayShape below;
  // this names the offender clearly).
  const blockErr = validateMcpServersSurface(newBlock);
  if (blockErr !== null) {
    logError(`registry add-mcp: invalid mcp block: ${blockErr}`);
    return 1;
  }

  // Splice the block into the overlay (in place at the existing index if
  // same-name; appended otherwise).
  const mergedBlocks =
    existingBlockIndex >= 0
      ? existingBlocks.map((b, i) => (i === existingBlockIndex ? newBlock : b))
      : [...existingBlocks, newBlock];

  const surfaces = { ...(overlay.surfaces ?? {}) };
  surfaces.mcp_servers = mergedBlocks;
  overlay.surfaces = surfaces;

  // Validate the WHOLE overlay (defense-in-depth) before any side effect.
  const overlayErr = validateOverlayShape(overlay);
  if (overlayErr !== null) {
    logError(`registry add-mcp: resulting overlay invalid: ${overlayErr}`);
    return 1;
  }

  // All guards passed → atomic overlay write (the FIRST disk write — no vendor
  // step; an inline command-ref has no source tree).
  try {
    writeOverlayAtomic(overlayPath, overlay);
  } catch (err) {
    logError(
      `registry add-mcp: failed to write overlay: ${(err as Error).message}`,
    );
    return 1;
  }

  // Record/advance the inline origin (key = `mcp:<name>`).
  try {
    origins[mcpKey] = {
      type: "inline",
      command,
      args,
      hash: hashInlineCommand(command, args),
    };
    writeOriginsAtomic(originsPath, origins);
  } catch (err) {
    logError(
      `registry add-mcp: failed to record origin: ${(err as Error).message}`,
    );
    return 1;
  }

  const verb = existingBlockIndex >= 0 ? "Re-registered" : "Registered";
  info(
    `${verb} personal MCP '${name}' (${unionedTargets.length} target(s)) in ${overlayPath}`,
  );
  return 0;
}

/**
 * FR-164: per-harness map key for the MCP entry. claude/gemini both nest under
 * `mcpServers` (JSON); opencode nests under `mcp` (JSON); codex nests under the
 * `[mcp_servers.<name>]` TOML table family. Mirrors `_common.sh`'s
 * `mcp_map_key`.
 */
function mcpMapKeyFor(harness: McpHarness): string {
  switch (harness) {
    case "claude":
    case "gemini":
    case "antigravity":
      return "mcpServers";
    case "opencode":
      return "mcp";
    case "codex":
      return "mcp_servers";
  }
}

/**
 * FR-164: resolve the live harness CONFIG FILE path for a harness. Tests
 * override via `opts.configPath` (the sandbox seam the bash driver passes
 * through). Mirrors `_common.sh`'s `mcp_config_path` resolution.
 */
function mcpConfigPathFor(harness: McpHarness): string {
  switch (harness) {
    case "claude":
      return claudeJsonPath();
    case "gemini":
      return geminiSettingsPath();
    case "antigravity":
      // FR-179 (R1): DISTINCT file from gemini's settings.json.
      return antigravityMcpConfigPath();
    case "opencode":
      return opencodeConfigPath();
    case "codex":
      return codexConfigTomlPath();
  }
}

/**
 * FR-180 cross-phase: does <project-root> OWN the core surfaces manifest? Mirrors
 * the bash `core_surfaces_owned` / `flatten_mcp_rows` ownership gate
 * (`commonpath(realpath(core-surfaces), realpath(project-root)) ==
 * realpath(project-root)`). True iff the core surfaces file resolves to a path
 * UNDER the project root — i.e. the project being compiled is (or contains) the
 * brain that ships the manifest. Safe default `false` on any realpath failure
 * (an unrelated project must not pull in core surfaces). Pure path logic via
 * `relative()` (`..`-free and non-absolute ⇒ contained).
 */
function coreSurfacesOwned(
  coreSurfacesPath: string,
  projectRoot: string,
): boolean {
  let csReal: string;
  let prReal: string;
  try {
    csReal = realpathSync(coreSurfacesPath);
    prReal = realpathSync(projectRoot);
  } catch {
    return false;
  }
  if (csReal === prReal) {
    return true;
  }
  const rel = relative(prReal, csReal);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * FR-164 / FR-180: read the core surfaces manifest (when owned) + the base agent
 * manifest + the auto-discovered/explicit personal overlay and return the
 * CONCATENATED `surfaces.mcp_servers[]` blocks. This is the TS analogue of the
 * bash `flatten_mcp_rows` union: the GLOBAL core `surfaces-manifest.json` is
 * unioned FIRST (core declares the canonical blocks) but ONLY when the project
 * being compiled OWNS it (its realpath is under `--project-root`) — identical
 * ownership posture to the bash flatten, so a core MCP added via
 * `igris add --core mcp` (which lands in `surfaces.mcp_servers[]`) is visible to
 * the projector when the compile runs against the brain root, and an unrelated
 * personal project never pulls core MCP servers in. The base agent manifest +
 * personal overlay (`merge_overlay_manifest`'s mcp_servers concat, finding #2)
 * follow.
 *
 * A name-collision between the core/base blocks and the overlay is a HARD error
 * (matches the bash guard) — returned as a string for the caller to log. Absent
 * source → contributes []. Malformed → throw (caller maps to exit 1). Order:
 * core-first, base-second, overlay-last (mirrors bash `sources.insert(0, …)`).
 */
function loadMergedMcpBlocks(
  manifestPath: string,
  overlayPath: string | undefined,
  coreSurfacesPath?: string,
  projectRoot?: string,
): McpServersSurface[] | string {
  const readMcp = (path: string): McpServersSurface[] => {
    if (!existsSync(path)) {
      return [];
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      surfaces?: { mcp_servers?: McpServersSurface[] };
    };
    const blocks = parsed.surfaces?.mcp_servers;
    return Array.isArray(blocks) ? blocks : [];
  };

  // Core surfaces — unioned ONLY when owned (mirrors flatten_mcp_rows). The
  // ownership decision is made here so the projector finds a core-added MCP
  // server when (and only when) compiling against a root that owns the manifest.
  const coreBlocks =
    coreSurfacesPath !== undefined &&
    coreSurfacesPath.length > 0 &&
    projectRoot !== undefined &&
    coreSurfacesOwned(coreSurfacesPath, projectRoot)
      ? readMcp(coreSurfacesPath)
      : [];

  const baseBlocks = readMcp(manifestPath);
  const overlayBlocks =
    overlayPath !== undefined && overlayPath.length > 0
      ? readMcp(overlayPath)
      : [];

  // Name-collision hard error (mirrors merge_overlay_manifest): a personal MCP
  // must not shadow a core one (core OR base).
  const baseNames = new Set(
    [...coreBlocks, ...baseBlocks].map((b) => b?.name),
  );
  for (const ob of overlayBlocks) {
    if (baseNames.has(ob?.name)) {
      return (
        `overlay mcp_servers block '${String(ob?.name)}' collides with a base ` +
        "(core) block name; a personal customization must not shadow a core one"
      );
    }
  }
  return [...coreBlocks, ...baseBlocks, ...overlayBlocks];
}

/**
 * FR-164 (FR-160 epic): `igris registry project-mcp` — the INTERNAL compile-time
 * MCP projector. Reads the merged manifest (base ++ personal overlay), finds the
 * `mcp_servers` block whose `name === --name`, builds the native per-harness
 * entry via `buildHarnessMcpEntry` (which calls FR-165's `normalizeEnvForHarness`
 * per env key), and dispatches the write to the proven `mergeJsonConfig`
 * (claude/gemini/opencode) or `mergeTomlConfig` (codex). ONE harness per
 * invocation — the bash compile/drift driver loops the per-(mcp,target) rows.
 *
 * SECURITY: the ONLY harness that resolves a secret literal is codex (the others
 * emit `${VAR}` / `{env:VAR}` refs). When a codex `${VAR}` secret is absent,
 * the verb FAILS with the VAR NAME on stderr and NEVER writes a partial value —
 * and NEVER prints any resolved literal.
 *
 * Exit codes: 0 = registered/updated/unchanged; 1 = block-not-found /
 * missing-secret / merge failure (error on stderr); 2 = usage error.
 *
 * NOT a user-facing verb — invoked only by the bash harness compile pass.
 */
function runProjectMcp(opts: RegistryOptions): number {
  // Guard — name + harness required.
  if (opts.name === undefined || opts.name.length === 0) {
    logError("registry project-mcp: --name is required");
    return 2;
  }
  const name = opts.name;
  if (opts.harness === undefined) {
    logError(
      "registry project-mcp: --harness <claude|codex|gemini|opencode> is required",
    );
    return 2;
  }
  if (!(VALID_MCP_TARGET_TYPES as readonly string[]).includes(opts.harness)) {
    logError(
      `registry project-mcp: --harness '${opts.harness}' is not one of ${JSON.stringify(VALID_MCP_TARGET_TYPES)}`,
    );
    return 2;
  }
  const harness = opts.harness;

  // Resolve the merged manifest blocks (core ++ base ++ overlay; collision =
  // hard error). The core surfaces manifest is unioned ONLY when the project
  // root OWNS it (mirrors the bash flatten) — so a core MCP server added via
  // `igris add --core mcp` is found when compiling against the brain root.
  const projectRoot = opts.projectRoot ?? process.cwd();
  const manifestPath = join(projectRoot, "harness-manifest.json");
  const overlayPath = opts.overlayPath ?? registryOverlayPath();
  const coreSurfacesPath = coreSurfacesManifestPath();

  let blocks: McpServersSurface[];
  try {
    const merged = loadMergedMcpBlocks(
      manifestPath,
      overlayPath,
      coreSurfacesPath,
      projectRoot,
    );
    if (typeof merged === "string") {
      logError(`registry project-mcp: ${merged}`);
      return 1;
    }
    blocks = merged;
  } catch (err) {
    logError(
      `registry project-mcp: cannot read manifest/overlay: ${(err as Error).message}`,
    );
    return 1;
  }

  const block = blocks.find((b) => b?.name === name);
  if (block === undefined) {
    logError(
      `registry project-mcp: no mcp_servers block named '${name}' in the merged manifest`,
    );
    return 1;
  }

  // The per-target enabled flag for THIS harness (opencode passthrough). Absent
  // target → still project (the bash driver only emits rows for declared
  // targets, but defend here against a direct call for an undeclared harness).
  const target = block.targets.find((t) => t.type === harness);
  const enabled = target?.enabled;

  // Build the native entry. secrets are loaded ONLY for codex (the only harness
  // that resolves a literal). parseSecretsEnv honors secretsPath (test seam).
  const secrets =
    harness === "codex" ? parseSecretsEnv(opts.secretsPath) : undefined;
  const { entry, missing } = buildHarnessMcpEntry(
    block.canonical,
    harness,
    enabled,
    secrets,
  );
  if (missing !== undefined) {
    // Codex-only: a ${VAR} whose secret is absent. Name ONLY the VAR — NEVER a
    // value. The overlay/manifest stays unchanged (no write attempted).
    logError(
      `registry project-mcp: cannot project '${name}' to codex — secret for ` +
        `\${${missing}} is not set in secrets.env; add it or remove the env ref`,
    );
    return 1;
  }

  // Resolve the config path + map key, then dispatch to the proven merger.
  const targetPath = opts.configPath ?? mcpConfigPathFor(harness);
  const mapKey = mcpMapKeyFor(harness);

  // Benign-create the target's parent dir so a harness whose config lives in a
  // not-yet-existing NESTED dir does not turn a clean compile into a write
  // failure. FR-179: antigravity's ~/.gemini/config/ is such a dir (the other
  // harness configs sit in dirs that already exist or are pre-created by
  // registerBrainAcrossHarnesses at install). Harness-agnostic + idempotent;
  // mirrors mcp-register.ts's mkdirSync(dirname(targetPath), {recursive:true}).
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(
      `registry project-mcp: could not create parent dir for ${targetPath}: ${msg}`,
    );
    return 1;
  }

  const result =
    harness === "codex"
      ? mergeTomlConfig({
          targetPath,
          tablePrefix: mapKey,
          entryKey: name,
          entry: entry as TomlMcpEntry,
        })
      : mergeJsonConfig({
          targetPath,
          mapKey,
          entryKey: name,
          entry: entry as Record<string, unknown>,
        });

  if (result.outcome === "failed") {
    // Map the merger's failure to exit 1 with its actionable error on stderr.
    // The error text NEVER contains a secret value (the mergers only ever see
    // the already-shaped entry; codex literals are inside the entry object the
    // merger writes atomically, never echoed). NEVER a silent empty success.
    logError(
      `registry project-mcp: failed to project '${name}' to ${harness} ` +
        `(${targetPath}): ${result.error ?? "unknown merge error"}`,
    );
    return 1;
  }

  // registered | updated | unchanged → success. Print only the outcome + name +
  // harness (no env values).
  info(`project-mcp: ${name} → ${harness} (${result.outcome})`);
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

/**
 * FR-142 path re-vendor: hash-compare against the recorded origin.
 * FR-156: tree-shaped — re-vendors the WHOLE origin dir (minus skip-list)
 * and re-hashes the resulting tree. A change anywhere in the source tree
 * (content, added file, removed file) flips the hash → status=changed.
 */
function reVendorPath(
  entry: AgentEntry,
  origin: PathOrigin,
  vendoredDir: string,
): ReVendorResult {
  // FR-156: the origin dir IS the agent's source tree root. No more file-set
  // resolution at the vendor site — `vendorAgentTreeAtomic` walks the dir
  // and applies the skip-list. The entry's canonical.versioned/glob/file
  // metadata is still needed for the assemble*Harness body-picker.
  if (!existsSync(origin.dir)) {
    return `error: canonical source dir does not exist: ${origin.dir}`;
  }
  try {
    vendorAgentTreeAtomic(origin.dir, vendoredDir);
    // FR-152 / FR-158 α-assembly on re-vendor: regenerate BOTH per-harness
    // derived outputs from the freshly re-vendored frontmatter + body.
    // Idempotent — same inputs → same bytes.
    const bxPath = resolvePersonalBodyExceptionPath(entry.body_exception);
    const assemblyFiles = pickAssemblyFiles(
      vendoredDir,
      entry.canonical.versioned === true,
      entry.canonical.glob,
      entry.canonical.file,
    );
    assembleClaudeHarness(vendoredDir, assemblyFiles, bxPath);
    assembleGeminiHarness(vendoredDir, assemblyFiles, bxPath);
    assembleCodexHarness(vendoredDir, assemblyFiles, bxPath);
    assembleOpencodeHarness(vendoredDir, assemblyFiles, bxPath);
  } catch (err) {
    return `error: failed to re-vendor: ${(err as Error).message}`;
  }
  const newHash = hashAgentTree(vendoredDir);
  // TD-202 in-band notice — emitted AFTER hashAgentTree so the notice's bytes
  // never enter the basis even if the skip-list lags (belt-and-suspenders).
  // Re-emit on every re-vendor so the sidecar reflects the CURRENT origin.
  writeRegistryNotice(vendoredDir, origin.dir, entry.name, "agent");
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
      // FR-156: tree vendor (mirrors reVendorPath). `selected.srcDir` is the
      // sandbox-clamped repo subdir, so the walk stays inside the fetched
      // tarball's sandbox (L-515).
      vendorAgentTreeAtomic(selected.srcDir, vendoredDir);
      // FR-152 / FR-158 α-assembly on github re-vendor: same idempotent
      // regeneration of BOTH per-harness derived outputs.
      const bxPath = resolvePersonalBodyExceptionPath(entry.body_exception);
      const assemblyFiles = pickAssemblyFiles(
        vendoredDir,
        selected.entry.canonical.versioned === true,
        selected.entry.canonical.glob,
        selected.entry.canonical.file,
      );
      assembleClaudeHarness(vendoredDir, assemblyFiles, bxPath);
      assembleGeminiHarness(vendoredDir, assemblyFiles, bxPath);
      assembleCodexHarness(vendoredDir, assemblyFiles, bxPath);
      assembleOpencodeHarness(vendoredDir, assemblyFiles, bxPath);
    } catch (err) {
      return `error: failed to re-vendor: ${(err as Error).message}`;
    }
    const newHash = hashAgentTree(vendoredDir);
    // TD-202 in-band notice — github re-vendor lands a newer release tag,
    // so the URI reference advances too. Emitted AFTER hashAgentTree so the
    // notice bytes never enter basis (belt-and-suspenders).
    const githubRef = `github:${owner}/${repo}@${newer.tag}`;
    writeRegistryNotice(vendoredDir, githubRef, entry.name, "agent");
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
  // TD-202: subtle but visible nudge — remind the operator that future edits
  // belong at the source, not under ~/.igris/registry/. Fires once per
  // invocation when any work item was processed (not per-entry to keep the
  // signal-to-noise ratio reasonable).
  if (work.length > 0) {
    info("");
    info("Reminder: edits to vendored surfaces must happen at the SOURCE path,");
    info("not under ~/.igris/registry/. Re-run `igris registry update <name>`");
    info("after editing the source. See TD-202 / coding_guidelines.md §18.5.");
  }
  return hadError ? 1 : 0;
}

// ---------------------------------------------------------------------------
// FR-180 (D6): add-identity helpers + verb
// ---------------------------------------------------------------------------

/**
 * FR-180 (D6): parse one identity `--target` spec. Grammar is
 * `type:file:filename` — DIFFERENT from the agent (`type:path`), skill
 * (`type:method:path`) and MCP (`type:merge[:enabled]`) forms. `type` ∈ the
 * 4-harness enum; `method` is the const `file`; `filename` is the harness's
 * natively auto-read identity file (split-limited so a filename containing `:`
 * survives). Returns the `IdentityTarget` or an error string for the verb to log
 * + reject.
 */
function parseIdentityTarget(spec: string): IdentityTarget | string {
  const first = spec.indexOf(":");
  if (first <= 0) {
    return `--target '${spec}' must be of the form type:file:filename`;
  }
  const type = spec.slice(0, first);
  const second = spec.indexOf(":", first + 1);
  if (second < 0) {
    return `--target '${spec}' must be of the form type:file:filename`;
  }
  const method = spec.slice(first + 1, second);
  const filename = spec.slice(second + 1);
  if (!(VALID_IDENTITY_TARGET_TYPES as readonly string[]).includes(type)) {
    return `--target type '${type}' is not one of ${JSON.stringify(VALID_IDENTITY_TARGET_TYPES)}`;
  }
  if (method !== "file") {
    return `--target method '${method}' must be 'file'`;
  }
  if (filename.length === 0) {
    return `--target '${spec}': filename must be non-empty`;
  }
  return { type: type as IdentityTargetType, method: "file", filename };
}

/**
 * FR-180 (D6): `igris registry add-identity` — append a personal os_identity
 * projection block to `surfaces.os_identity[]` of the personal overlay. This is
 * the write half of `igris add identity` (personal); the projection (the
 * region-merge into GEMINI.md / AGENTS.md / …) is done by `harness compile`
 * after the D6 merge-gate lift, the SAME way core identity projects.
 *
 * An identity block has NO `name` (the schema keys it only on its targets); the
 * positional `<name>` is a LABEL for logging only. Identity is the (type,
 * filename) PAIR, so:
 *   - a target whose (type, filename) collides with a CORE block's is a HARD
 *     reject (a personal identity must not shadow a core one — readBaseIdentity-
 *     Targets), and
 *   - the block is written PROJECT-SCOPED (`scope:{type:"project",
 *     paths:[realpath(projectRoot)]}`) so it only projects into THIS project's
 *     identity files, never leaking the personal identity into other projects.
 *
 * Writes ONLY the overlay (via `writeOverlayAtomic`) — it does NOT touch a live
 * identity file (that is `harness compile`). Every guard returns BEFORE the
 * first disk write, so the overlay stays UNCHANGED on any reject.
 *
 * Returns an exit code: 0 = success, 1 = enforcement reject, 2 = usage error.
 */
function runAddIdentity(opts: RegistryOptions, overlayPath: string): number {
  // Guard 1 — name (label) required + pattern (parity with the other verbs;
  // keeps the overlay/log identity stable even though the block has no `name`).
  if (opts.name === undefined || opts.name.length === 0) {
    logError("registry add-identity: <name> is required");
    return 2;
  }
  if (!NAME_PATTERN.test(opts.name)) {
    logError(
      `registry add-identity: name '${opts.name}' must match /^[a-z0-9][a-z0-9-]*$/`,
    );
    return 2;
  }
  const name = opts.name;

  // Guard 2 — at least one target, parsed via the identity grammar.
  if (opts.targets === undefined || opts.targets.length === 0) {
    logError(
      "registry add-identity: at least one --target <type:file:filename> is required",
    );
    return 2;
  }
  const newTargets: IdentityTarget[] = [];
  const seenPairs = new Set<string>();
  for (const spec of opts.targets) {
    const parsed = parseIdentityTarget(spec);
    if (typeof parsed === "string") {
      logError(`registry add-identity: ${parsed}`);
      return 2;
    }
    const pair = `${parsed.type} ${parsed.filename}`;
    if (seenPairs.has(pair)) {
      logError(
        `registry add-identity: duplicate --target (${parsed.type}, ${parsed.filename})`,
      );
      return 2;
    }
    seenPairs.add(pair);
    newTargets.push(parsed);
  }

  const projectRoot = opts.projectRoot ?? process.cwd();

  // Core-collision reject — a personal identity target must not shadow a core
  // one (the identity analogue of the MCP name-collision / skill path-collision
  // guards; the unit is the (type, filename) pair). Runs BEFORE any disk write.
  const baseIdentityTargets = readBaseIdentityTargets(projectRoot);
  for (const t of newTargets) {
    const pair = `${t.type} ${t.filename}`;
    if (baseIdentityTargets.has(pair)) {
      logError(
        `registry add-identity: identity target (${t.type}, ${t.filename}) ` +
          "collides with a base (core) os_identity target; a personal identity " +
          "must not shadow a core one. Overlay unchanged.",
      );
      return 1;
    }
  }

  // Read current overlay (unchanged on any reject below).
  let overlay: Overlay;
  try {
    overlay = readOverlay(overlayPath);
  } catch (err) {
    logError((err as Error).message);
    return 1;
  }

  // Project-scope the block so the personal identity only projects into THIS
  // project's identity files. realpath the project root at write time so the
  // paths[] entry is canonical (macOS /tmp ↔ /private/tmp), matching the
  // compile/drift READ-time realpath.
  let scopedPath = projectRoot;
  try {
    scopedPath = realpathSync(projectRoot);
  } catch {
    // Non-existent root → store as-given; compile will realpath both sides.
  }

  const block: IdentitySurface = {
    layer: "personal",
    scope: { type: "project", paths: [scopedPath] },
    targets: newTargets,
  };
  if (opts.identitySource !== undefined && opts.identitySource.length > 0) {
    block.source = opts.identitySource;
  }
  if (
    opts.identityVersionSource !== undefined &&
    opts.identityVersionSource.length > 0
  ) {
    block.version_source = opts.identityVersionSource;
  }

  // Per-block validation (names the offender; the array gate runs in
  // validateOverlayShape below).
  const blockErr = validateIdentitySurface(block);
  if (blockErr !== null) {
    logError(`registry add-identity: invalid identity block: ${blockErr}`);
    return 1;
  }

  // Append the block (identity has no name → no in-place dedupe; a same-label
  // re-add appends a NEW block, but the (type, filename) cross-block guard in
  // merge_overlay_manifest + validateOverlayShape rejects a colliding target,
  // so a true duplicate target can never silently double-write a region).
  const existingBlocks = overlay.surfaces?.os_identity ?? [];

  // Intra-overlay collision reject (the bash merge guards this too, but a
  // write-time reject names the offender clearly before any side effect).
  const existingPairs = new Set<string>();
  for (const b of existingBlocks) {
    for (const t of b.targets ?? []) {
      existingPairs.add(`${t.type} ${t.filename}`);
    }
  }
  for (const t of newTargets) {
    const pair = `${t.type} ${t.filename}`;
    if (existingPairs.has(pair)) {
      logError(
        `registry add-identity: identity target (${t.type}, ${t.filename}) ` +
          "already declared in the personal overlay; edit it or remove the " +
          "existing block first. Overlay unchanged.",
      );
      return 1;
    }
  }

  const surfaces = { ...(overlay.surfaces ?? {}) };
  surfaces.os_identity = [...existingBlocks, block];
  overlay.surfaces = surfaces;

  // Validate the WHOLE overlay (defense-in-depth) before any side effect.
  const overlayErr = validateOverlayShape(overlay);
  if (overlayErr !== null) {
    logError(`registry add-identity: resulting overlay invalid: ${overlayErr}`);
    return 1;
  }

  // All guards passed → atomic overlay write (the only disk write; identity has
  // no vendor tree and no origin sidecar).
  try {
    writeOverlayAtomic(overlayPath, overlay);
  } catch (err) {
    logError(
      `registry add-identity: failed to write overlay: ${(err as Error).message}`,
    );
    return 1;
  }

  info(
    `Registered personal identity '${name}' (${newTargets.length} target(s)) in ${overlayPath}`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// FR-180 (D7): add-hook + project-hook
// ---------------------------------------------------------------------------

/** Parse one hook `--target` spec: `type:merge[:enabled]` (mirrors parseMcpTarget). */
function parseHookTarget(spec: string): HookTarget | string {
  const parts = spec.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return `--target '${spec}' must be of the form type:merge[:enabled]`;
  }
  const [type, method, enabledRaw] = parts;
  if (!(VALID_HOOK_TARGET_TYPES as readonly string[]).includes(type)) {
    return `--target type '${type}' is not one of ${JSON.stringify(VALID_HOOK_TARGET_TYPES)}`;
  }
  if (method !== "merge") {
    return `--target method '${method}' must be 'merge'`;
  }
  const t: HookTarget = { type: type as HookTargetType, method: "merge" };
  if (enabledRaw !== undefined) {
    if (enabledRaw !== "true" && enabledRaw !== "false") {
      return `--target '${spec}' enabled flag must be 'true' or 'false'`;
    }
    t.enabled = enabledRaw === "true";
  }
  return t;
}

/**
 * Read the BASE (core) hook block names from the project's base manifest +
 * the core surfaces manifest (when owned) so the personal collision guard can
 * reject a personal hook that would shadow a core one (the analogue of
 * `readBaseMcpNames`). Returns a Set of (event, target-type) CELLS too, so a
 * personal block can't quietly claim a core block's event slot in a harness.
 */
function readBaseHookCells(projectRoot: string): {
  names: Set<string>;
  cells: Set<string>;
} {
  const names = new Set<string>();
  const cells = new Set<string>();
  const readBlocks = (path: string): HookSurface[] => {
    try {
      if (!existsSync(path)) return [];
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        surfaces?: { hooks?: HookSurface[] };
      };
      const blocks = parsed.surfaces?.hooks;
      return Array.isArray(blocks) ? blocks : [];
    } catch {
      return [];
    }
  };
  const sources = [join(projectRoot, "harness-manifest.json")];
  const coreSurfaces = coreSurfacesManifestPath();
  if (coreSurfaces.length > 0 && coreSurfacesOwned(coreSurfaces, projectRoot)) {
    sources.unshift(coreSurfaces);
  }
  for (const src of sources) {
    for (const b of readBlocks(src)) {
      if (typeof b?.name === "string") names.add(b.name);
      const ev = b?.event;
      for (const t of b?.targets ?? []) {
        if (typeof ev === "string" && typeof t?.type === "string") {
          cells.add(`${ev} ${t.type}`);
        }
      }
    }
  }
  return { names, cells };
}

/**
 * FR-180 (D7): `igris registry add-hook` — the WRITE-ONLY personal hook
 * registrar (the low-level primitive `igris add hook` wraps). Writes the hook
 * SCRIPT scaffold to `~/.igris/registry/hooks/<name>/<event>.sh` (the distinct
 * provenance prefix the canonical re-merge preserves — R2) AND a personal
 * `surfaces.hooks[]` block to the overlay. Does NOT project (that is `igris add
 * hook` / `project-hook`).
 *
 * Identity is the block NAME (+ the (event, target-type) cells). Guards (all
 * pre-write): name + pattern, valid `event`, ≥1 target, core-name + core-cell
 * collision, intra-overlay collision. Exit codes: 0 ok; 1 reject; 2 usage.
 */
function runAddHook(opts: RegistryOptions, overlayPath: string): number {
  // Guard 1 — name + pattern.
  if (opts.name === undefined || opts.name.length === 0) {
    logError("registry add-hook: <name> is required");
    return 2;
  }
  if (!NAME_PATTERN.test(opts.name)) {
    logError(
      `registry add-hook: name '${opts.name}' must match /^[a-z0-9][a-z0-9-]*$/`,
    );
    return 2;
  }
  const name = opts.name;

  // Guard 2 — event required + valid.
  if (opts.event === undefined || opts.event.length === 0) {
    logError(
      `registry add-hook: --event <${VALID_HOOK_EVENTS.join("|")}> is required`,
    );
    return 2;
  }
  if (!(VALID_HOOK_EVENTS as readonly string[]).includes(opts.event)) {
    logError(
      `registry add-hook: --event '${opts.event}' is not one of ${JSON.stringify(VALID_HOOK_EVENTS)}`,
    );
    return 2;
  }
  const event = opts.event as HookEvent;

  // Guard 3 — at least one target (default to claude:merge when none given so
  // the common case is one flag less; an explicit --target overrides).
  const targetSpecs =
    opts.targets !== undefined && opts.targets.length > 0
      ? opts.targets
      : ["claude:merge"];
  const newTargets: HookTarget[] = [];
  const seenTypes = new Set<string>();
  for (const spec of targetSpecs) {
    const parsed = parseHookTarget(spec);
    if (typeof parsed === "string") {
      logError(`registry add-hook: ${parsed}`);
      return 2;
    }
    if (seenTypes.has(parsed.type)) {
      logError(`registry add-hook: duplicate --target type '${parsed.type}'`);
      return 2;
    }
    seenTypes.add(parsed.type);
    newTargets.push(parsed);
  }

  const projectRoot = opts.projectRoot ?? process.cwd();

  // Guard 4 — core-name + core-cell collision (a personal hook must not shadow a
  // core one). Runs BEFORE any disk write.
  const base = readBaseHookCells(projectRoot);
  if (base.names.has(name)) {
    logError(
      `registry add-hook: hook name '${name}' collides with a base (core) hook; ` +
        "a personal customization must not shadow a core hook. Overlay unchanged.",
    );
    return 1;
  }
  for (const t of newTargets) {
    const cell = `${event} ${t.type}`;
    if (base.cells.has(cell)) {
      logError(
        `registry add-hook: hook cell (${event}, ${t.type}) collides with a base ` +
          "(core) hook; two hooks must not both own the same event in the same " +
          "harness. Overlay unchanged.",
      );
      return 1;
    }
  }

  // Read the overlay (unchanged on any reject below).
  let overlay: Overlay;
  try {
    overlay = readOverlay(overlayPath);
  } catch (err) {
    logError((err as Error).message);
    return 1;
  }

  const existingBlocks = overlay.surfaces?.hooks ?? [];
  // Intra-overlay collisions (name + cell).
  const existingNames = new Set(existingBlocks.map((b) => b.name));
  if (existingNames.has(name)) {
    logError(
      `registry add-hook: hook '${name}' already declared in the personal overlay; ` +
        "edit it or remove the existing block first. Overlay unchanged.",
    );
    return 1;
  }
  const existingCells = new Set<string>();
  for (const b of existingBlocks) {
    for (const t of b.targets ?? []) {
      existingCells.add(`${b.event} ${t.type}`);
    }
  }
  for (const t of newTargets) {
    const cell = `${event} ${t.type}`;
    if (existingCells.has(cell)) {
      logError(
        `registry add-hook: hook cell (${event}, ${t.type}) already declared in ` +
          "the personal overlay; edit or remove the existing block first. " +
          "Overlay unchanged.",
      );
      return 1;
    }
  }

  // Build the block. The personal command lives under the REGISTRY prefix so the
  // canonical re-merge preserves it (R2). The literal `$HOME` form matches the
  // canonical-settings.json convention (Claude expands $HOME at runtime).
  const command = `$HOME/.igris/registry/hooks/${name}/${event}.sh`;
  const canonical: HookCanonical = { command };
  if (opts.matcher !== undefined && opts.matcher.length > 0) {
    canonical.matcher = opts.matcher;
  }
  if (opts.timeout !== undefined) {
    canonical.timeout = opts.timeout;
  }
  const block: HookSurface = {
    name,
    event,
    layer: "personal",
    canonical,
    targets: newTargets,
  };

  const blockErr = validateHookSurface(block);
  if (blockErr !== null) {
    logError(`registry add-hook: invalid hook block: ${blockErr}`);
    return 1;
  }

  // --- Write the hook SCRIPT scaffold (the materialize half). ----------------
  const scriptRoot =
    opts.hookScriptRoot ?? join(brainDir(), "registry", "hooks");
  const scriptDir = join(scriptRoot, name);
  const scriptPath = join(scriptDir, `${event}.sh`);
  if (!existsSync(scriptPath)) {
    try {
      mkdirSync(scriptDir, { recursive: true });
      writeFileSync(scriptPath, hookScriptScaffold(name, event), {
        encoding: "utf-8",
        mode: 0o755,
      });
    } catch (err) {
      logError(
        `registry add-hook: failed to write hook script ${scriptPath}: ${(err as Error).message}`,
      );
      return 1;
    }
  }

  const surfaces = { ...(overlay.surfaces ?? {}) };
  surfaces.hooks = [...existingBlocks, block];
  overlay.surfaces = surfaces;

  const overlayErr = validateOverlayShape(overlay);
  if (overlayErr !== null) {
    logError(`registry add-hook: resulting overlay invalid: ${overlayErr}`);
    return 1;
  }

  try {
    writeOverlayAtomic(overlayPath, overlay);
  } catch (err) {
    logError(
      `registry add-hook: failed to write overlay: ${(err as Error).message}`,
    );
    return 1;
  }

  info(
    `Registered personal hook '${name}' on ${event} (${newTargets.length} target(s)) ` +
      `in ${overlayPath}; script: ${scriptPath}`,
  );
  return 0;
}

/** Scaffold body for a personal hook script. Executable; a no-op pass-through. */
function hookScriptScaffold(name: string, event: string): string {
  return `#!/usr/bin/env bash
# Personal Igris hook '${name}' for the ${event} event.
# Generated by \`igris add hook ${name} --event ${event}\`. Replace the body
# below with the hook's real behavior. This script is preserved across
# \`igris update\` / \`igris doctor --fix\` (registry-provenance — see FR-180 R2).
set -euo pipefail

# TODO: implement the ${event} hook for '${name}'.
exit 0
`;
}

/**
 * FR-180 (D7): merge the core ++ base ++ overlay hook blocks (collision = hard
 * error), mirroring `loadMergedMcpBlocks`. The core surfaces manifest is
 * unioned ONLY when the project root OWNS it. Returns the merged block list or
 * an error string.
 */
function loadMergedHookBlocks(
  manifestPath: string,
  overlayPath: string | undefined,
  coreSurfacesPath?: string,
  projectRoot?: string,
): HookSurface[] | string {
  const readHooks = (path: string): HookSurface[] => {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      surfaces?: { hooks?: HookSurface[] };
    };
    const blocks = parsed.surfaces?.hooks;
    return Array.isArray(blocks) ? blocks : [];
  };

  const coreBlocks =
    coreSurfacesPath !== undefined &&
    coreSurfacesPath.length > 0 &&
    projectRoot !== undefined &&
    coreSurfacesOwned(coreSurfacesPath, projectRoot)
      ? readHooks(coreSurfacesPath)
      : [];
  const baseBlocks = readHooks(manifestPath);
  const overlayBlocks =
    overlayPath !== undefined && overlayPath.length > 0
      ? readHooks(overlayPath)
      : [];

  const baseNames = new Set([...coreBlocks, ...baseBlocks].map((b) => b?.name));
  for (const ob of overlayBlocks) {
    if (baseNames.has(ob?.name)) {
      return (
        `overlay hooks block '${String(ob?.name)}' collides with a base (core) ` +
        "block name; a personal customization must not shadow a core one"
      );
    }
  }
  return [...coreBlocks, ...baseBlocks, ...overlayBlocks];
}

/**
 * FR-180 (D7): resolve a hook command's literal `$HOME/.igris/...` convention to
 * the ACTUAL on-disk path. The command stores `$HOME/.igris/...` (the
 * canonical-settings.json convention Claude expands at runtime), but the real
 * brain dir may be relocated via IGRIS_BRAIN_DIR (sandbox/tests). Map the
 * `$HOME/.igris/` prefix to `brainDir()`; otherwise fall back to the literal
 * `$HOME` expansion (resolveHookCommandPath). In production brainDir() ===
 * $HOME/.igris so the two coincide.
 */
function resolveHookScriptPath(command: string): string {
  const literal = "$HOME/.igris/";
  if (command.startsWith(literal)) {
    return join(brainDir(), command.slice(literal.length));
  }
  return resolveHookCommandPath(command, homedir());
}

/**
 * FR-180 (D7): `igris registry project-hook` — the INTERNAL compile-time hook
 * projector. Reads the merged manifest (core ++ base ++ overlay), finds the
 * `hooks` block whose `name === --name`, and projects ONE harness:
 *
 *   claude   → merge the hook GROUP into `<projectRoot>/.claude/settings.json`
 *              `hooks.<Event>[]` (idempotent; preserves user groups + other
 *              top-level keys). The R2-safe registry-prefix command is what the
 *              canonical re-merge later preserves.
 *   opencode → the FR-104 plugin already routes the six events to the shared
 *              scripts. A personal opencode hook is COVERED by the plugin, not a
 *              config write — the projector verifies the plugin exists and emits
 *              a covered/OK outcome (no config mutation). A MISSING plugin is a
 *              loud failure (the user must `igris install` to deposit it).
 *
 * NOT a user-facing verb — invoked only by the bash harness compile pass.
 * Exit codes: 0 = projected/covered/unchanged; 1 = block-not-found / shape /
 * write failure; 2 = usage.
 */
function runProjectHook(opts: RegistryOptions): number {
  if (opts.name === undefined || opts.name.length === 0) {
    logError("registry project-hook: --name is required");
    return 2;
  }
  const name = opts.name;
  if (opts.harness === undefined) {
    logError("registry project-hook: --harness <claude|opencode> is required");
    return 2;
  }
  if (!(VALID_HOOK_TARGET_TYPES as readonly string[]).includes(opts.harness)) {
    logError(
      `registry project-hook: --harness '${opts.harness}' is not one of ${JSON.stringify(VALID_HOOK_TARGET_TYPES)}`,
    );
    return 2;
  }
  const harness = opts.harness as HookTargetType;

  const projectRoot = opts.projectRoot ?? process.cwd();
  const manifestPath = join(projectRoot, "harness-manifest.json");
  const overlayPath = opts.overlayPath ?? registryOverlayPath();
  const coreSurfacesPath = coreSurfacesManifestPath();

  let blocks: HookSurface[];
  try {
    const merged = loadMergedHookBlocks(
      manifestPath,
      overlayPath,
      coreSurfacesPath,
      projectRoot,
    );
    if (typeof merged === "string") {
      logError(`registry project-hook: ${merged}`);
      return 1;
    }
    blocks = merged;
  } catch (err) {
    logError(
      `registry project-hook: cannot read manifest/overlay: ${(err as Error).message}`,
    );
    return 1;
  }

  const block = blocks.find((b) => b?.name === name);
  if (block === undefined) {
    logError(
      `registry project-hook: no hooks block named '${name}' in the merged manifest`,
    );
    return 1;
  }
  if (!block.targets.some((t) => t.type === harness)) {
    // The bash driver only emits rows for declared targets; defend a direct call.
    logError(
      `registry project-hook: hook '${name}' has no '${harness}' target`,
    );
    return 1;
  }

  // --- opencode: covered by the FR-104 plugin. -----------------------------
  if (harness === "opencode") {
    const pluginPath = join(
      homedir(),
      ".config",
      "opencode",
      "plugins",
      "igris-bridge.ts",
    );
    if (!existsSync(pluginPath)) {
      logError(
        `registry project-hook: opencode hook '${name}' requires the FR-104 plugin ` +
          `at ${pluginPath}; run 'igris install' to deposit it`,
      );
      return 1;
    }
    info(
      `project-hook: ${name} → opencode (covered by the FR-104 plugin; ${block.event})`,
    );
    return 0;
  }

  // --- claude: config-merge into .claude/settings.json. --------------------
  const settingsPath =
    opts.hookSettingsPath ?? projectSettingsPath(projectRoot);
  const group = buildClaudeHookGroup(block.event, block.canonical);

  let existing: Record<string, unknown> | undefined;
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch (err) {
      logError(
        `registry project-hook: refusing to clobber unreadable ${settingsPath}: ${(err as Error).message}`,
      );
      return 1;
    }
  }

  let merged: Record<string, unknown>;
  try {
    merged = mergeHookIntoSettings(existing, block.event, group);
  } catch (err) {
    if (err instanceof HookMergeShapeError) {
      logError(
        `registry project-hook: settings.json merge failed (refusing to clobber): ${err.message}`,
      );
      return 1;
    }
    throw err;
  }

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
    renameSync(tmp, settingsPath);
  } catch (err) {
    logError(
      `registry project-hook: failed to write ${settingsPath}: ${(err as Error).message}`,
    );
    return 1;
  }

  // Belt-and-suspenders: a personal hook's script must exist (it is a path the
  // harness will run). Resolve + check; a missing script is a loud failure
  // (never a phantom-OK projection). Core scripts live under core/hooks/shared,
  // personal under registry/hooks. The command stores the literal `$HOME/.igris`
  // convention; resolve it against the ACTUAL brain dir (`brainDir()`, honoring
  // IGRIS_BRAIN_DIR) — NOT `$HOME` — so a sandboxed/relocated brain resolves to
  // the real script location (in production brainDir() === $HOME/.igris).
  const resolved = resolveHookScriptPath(block.canonical.command);
  if (!existsSync(resolved)) {
    logError(
      `registry project-hook: hook '${name}' command script not found at ${resolved}`,
    );
    return 1;
  }

  info(`project-hook: ${name} → claude (${block.event})`);
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
    case "add-skill":
      return runAddSkill(opts, overlayPath);
    case "add-mcp":
      return runAddMcp(opts, overlayPath);
    case "add-identity":
      return runAddIdentity(opts, overlayPath);
    case "add-hook":
      return runAddHook(opts, overlayPath);
    case "project-mcp":
      return runProjectMcp(opts);
    case "project-hook":
      return runProjectHook(opts);
    case "list":
      return runList(overlayPath);
    case "remove":
      return runRemove(opts, overlayPath);
    case "update":
      return runUpdate(opts, overlayPath);
    default:
      logError(
        `unknown registry action '${String(opts.action)}'. Valid: add, add-skill, add-mcp, add-identity, add-hook, project-mcp, project-hook, list, remove, update.`,
      );
      return 2;
  }
}
