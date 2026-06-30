/**
 * FR-217: the ONE typed reader for the canonical harness descriptor.
 *
 * The descriptor lives in `harness-manifest.json` `harnesses.<id>` (the repo-root
 * project manifest; the canonical SOURCE OF TRUTH). FR-217 extended each harness
 * block from `delegation_model`-only into the full descriptor: `agent_id`,
 * `agents`{target_type,projection}, `mcp`{config_path,format,map_key,entry_shape},
 * `grant`{kind,path?,token?}, `hooks`{supported,config_path?,method?}, and
 * `harness_specific_file?`. This module is the single place TS consumers read
 * those facts from; no consumer re-reads the JSON or re-derives a harness list.
 *
 * RESOLUTION (downstream of the DECIDED home — this is implementation, not a
 * re-open): the brain-wiring consumers (mcp-register/mcp-grant/paths) run at
 * `igris init|install|doctor` and write GLOBAL configs; the intrinsic facts are
 * project-independent. So the canonical `harnesses` block MUST ship with the
 * compiled CLI: `copy-templates.sh` stages the repo-root `harness-manifest.json`
 * into `cli/dist/lib/harness-manifest.json` (package-relative, same idiom as
 * `bundledMcpEntryPath()`). `loadHarnessDescriptor` prefers an explicit
 * `manifestPath` (compile/drift pass the project manifest), then the bundled copy
 * next to this module, then the dev repo-root copy (so vitest against `src/` and
 * a built `dist/` both resolve without an explicit path). Tilde-expansion for the
 * `*config_path`/`grant.path` strings stays in `paths.ts` (`expandTilde`).
 *
 * SCOPE NOTE (do NOT fold these into the harness set later): the harness-bearing
 * derivations below (agent/mcp/hook target enums, agent-id lists, grant harnesses)
 * are descriptor-derived. The NON-harness enums are explicitly NOT derived from
 * the harness set and stay hand-kept in their consumers: `VALID_SKILL_TARGET_TYPES`
 * (`{claude, agents, opencode}` — `agents` is the shared-dir pseudo-target, not a
 * harness id), `valid_skill_types`, every `VALID_*_METHODS` (projection methods),
 * `VALID_HOOK_EVENTS` (portable event names), and `valid_delegation_models`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expandTilde } from "./paths.js";

/**
 * The five Igris harness SHAPE ids — the `harnesses.<id>` keys, the agent/mcp/
 * hook target `type` values, and the buildHarnessMcpEntry switch keys. This is
 * the re-homed `McpHarness` union (mcp-env-normalize.ts + mcp-shape.ts re-export
 * it for back-compat). DISTINCT from the npx AGENT id (`agentId()`), which differs
 * for claude→`claude-code` and gemini→`gemini-cli`.
 */
export type HarnessId =
  | "claude"
  | "gemini"
  | "codex"
  | "opencode"
  | "antigravity"
  | "cursor";

export type McpFormat = "json" | "toml";
/** buildHarnessMcpEntry emitter shapes. antigravity rides `gemini` (no own value). */
export type EntryShape = "claude" | "gemini" | "codex" | "opencode";
export type AgentProjection = "symlink" | "target-row";
export type GrantKind = "json-array" | "toml-folder" | "json-folder" | "covered";
export type HookMethod = "settings-merge" | "plugin" | "config-merge";
export type DelegationModel = "native-static" | "dynamic-define" | "inline";

/** Resolved (tilde-expanded) MCP wiring facts for one harness. */
export interface McpFacts {
  /** Absolute config FILE the `igris-brain` server entry is merged into. */
  configPath: string;
  format: McpFormat;
  mapKey: string;
  entryShape: EntryShape;
  /**
   * TD-281: the "surface-projected vs carve-out" flag. `true` = this harness's
   * targets SHOULD appear in every `surfaces.mcp_servers[]` block (the drift
   * parity-guard's expected set); `false`/absent = a deliberate carve-out NOT
   * projected via the mcp surface (antigravity → FR-179: custom-written to
   * ~/.gemini/config/). Block PRESENCE (capability) is orthogonal to this
   * (projection EXPECTATION). Drives mcpProjectedHarnesses().
   */
  projected?: boolean;
}

/** Resolved no-prompt grant grammar for one harness. */
export interface GrantFacts {
  kind: GrantKind;
  /** Absolute grant config FILE — absent for `covered`. */
  path?: string;
  /** json-array only: the wildcard token to append. */
  token?: string;
}

/** Resolved hook-surface facts for one harness. */
export interface HookFacts {
  supported: boolean;
  /** Absolute hook config FILE — absent when the merge has no single file (opencode plugin). */
  configPath?: string;
  method?: HookMethod;
  /**
   * TD-281: the "surface-projected vs carve-out" flag for the hook surface (see
   * McpFacts.projected). Set on the 3 supported-hook harnesses (claude/opencode/
   * antigravity — no hook carve-out today). Drives hookProjectedHarnesses().
   */
  projected?: boolean;
}

interface AgentsFacts {
  targetType: HarnessId;
  projection: AgentProjection;
}

/**
 * A parsed descriptor entry for one harness. Path fields (`mcp.configPath`,
 * `grant.path`, `hooks.configPath`) are stored RAW (un-expanded); the accessors
 * (`mcpFacts`/`grantGrammar`/`hookFacts`) `~`-expand them at CALL time so a
 * runtime HOME override resolves correctly.
 */
export interface HarnessEntry {
  id: HarnessId;
  delegationModel: DelegationModel;
  agentId?: string;
  agents?: AgentsFacts;
  mcp?: McpFacts;
  grant?: GrantFacts;
  hooks: HookFacts;
  harnessSpecificFile?: string;
}

export interface HarnessDescriptor {
  /** Harness entries keyed by shape id. */
  byId: Map<HarnessId, HarnessEntry>;
  /** Shape ids in manifest declaration order. */
  order: HarnessId[];
  /** The absolute manifest path this descriptor was parsed from. */
  sourcePath: string;
}

export interface LoadHarnessDescriptorOptions {
  /** Explicit manifest path (compile/drift pass the project manifest). */
  manifestPath?: string;
}

const VALID_HARNESS_IDS: readonly HarnessId[] = [
  "claude",
  "gemini",
  "codex",
  "opencode",
  "antigravity",
  "cursor",
];

class HarnessDescriptorError extends Error {
  constructor(message: string) {
    super(`harness descriptor: ${message}`);
    this.name = "HarnessDescriptorError";
  }
}

// --- Resolution ------------------------------------------------------------

/** Candidate manifest paths in priority order (first existing wins). */
function candidateManifestPaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url)); // cli/src/lib or cli/dist/lib
  return [
    // Bundled copy staged next to this module (published package + built dist).
    join(here, "harness-manifest.json"),
    // Dev repo-root copy — works from both cli/src/lib and cli/dist/lib (each is
    // 3 levels under the repo root). Lets vitest against src/ resolve without a build.
    join(here, "..", "..", "..", "harness-manifest.json"),
  ];
}

function resolveManifestPath(opts?: LoadHarnessDescriptorOptions): string {
  if (opts?.manifestPath) {
    if (!existsSync(opts.manifestPath)) {
      throw new HarnessDescriptorError(
        `manifest not found at provided path: ${opts.manifestPath}`,
      );
    }
    return opts.manifestPath;
  }
  for (const candidate of candidateManifestPaths()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new HarnessDescriptorError(
    `could not resolve a harness manifest (looked for: ${candidateManifestPaths().join(", ")}). ` +
      "On a global op the bundled copy should be staged by copy-templates.sh.",
  );
}

// --- Parse + validate (light — schema / _common.sh are authoritative) ------

function asObject(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new HarnessDescriptorError(`${where} must be an object`);
  }
  return v as Record<string, unknown>;
}

function asString(v: unknown, where: string): string {
  if (typeof v !== "string") {
    throw new HarnessDescriptorError(`${where} must be a string`);
  }
  return v;
}

function buildEntry(id: HarnessId, raw: Record<string, unknown>): HarnessEntry {
  // FR-192: `inline` joins {native-static, dynamic-define}. An unknown/absent
  // value still defaults to native-static (the "absent → native-static" contract
  // the _common.sh structural fallback documents).
  const dm = raw.delegation_model;
  const delegationModel: DelegationModel =
    dm === "dynamic-define" || dm === "inline" ? dm : "native-static";

  const entry: HarnessEntry = {
    id,
    delegationModel,
    hooks: { supported: false },
  };

  if (raw.agent_id !== undefined) {
    entry.agentId = asString(raw.agent_id, `harnesses.${id}.agent_id`);
  }

  if (raw.agents !== undefined) {
    const a = asObject(raw.agents, `harnesses.${id}.agents`);
    entry.agents = {
      targetType: asString(
        a.target_type,
        `harnesses.${id}.agents.target_type`,
      ) as HarnessId,
      projection: asString(
        a.projection,
        `harnesses.${id}.agents.projection`,
      ) as AgentProjection,
    };
  }

  if (raw.mcp !== undefined) {
    const m = asObject(raw.mcp, `harnesses.${id}.mcp`);
    entry.mcp = {
      // RAW path (un-expanded). mcpFacts() expands `~` at CALL time — see the
      // accessor note (honors a runtime HOME override; matches the old
      // claudeJsonPath()/etc. helpers that re-expanded on every call).
      configPath: asString(m.config_path, `harnesses.${id}.mcp.config_path`),
      format: asString(m.format, `harnesses.${id}.mcp.format`) as McpFormat,
      mapKey: asString(m.map_key, `harnesses.${id}.mcp.map_key`),
      entryShape: asString(
        m.entry_shape,
        `harnesses.${id}.mcp.entry_shape`,
      ) as EntryShape,
    };
    // TD-281: optional surface-projected flag (boolean). Absent ⇒ not-projected.
    if (typeof m.projected === "boolean") {
      entry.mcp.projected = m.projected;
    }
  }

  if (raw.grant !== undefined) {
    const g = asObject(raw.grant, `harnesses.${id}.grant`);
    const grant: GrantFacts = {
      kind: asString(g.kind, `harnesses.${id}.grant.kind`) as GrantKind,
    };
    if (g.path !== undefined) {
      // RAW path; grantGrammar() expands `~` at call time.
      grant.path = asString(g.path, `harnesses.${id}.grant.path`);
    }
    if (g.token !== undefined) {
      grant.token = asString(g.token, `harnesses.${id}.grant.token`);
    }
    entry.grant = grant;
  }

  if (raw.hooks !== undefined) {
    const h = asObject(raw.hooks, `harnesses.${id}.hooks`);
    if (typeof h.supported !== "boolean") {
      throw new HarnessDescriptorError(
        `harnesses.${id}.hooks.supported must be a boolean`,
      );
    }
    const hooks: HookFacts = { supported: h.supported };
    if (h.config_path !== undefined) {
      // RAW path; hookFacts() expands `~` at call time.
      hooks.configPath = asString(
        h.config_path,
        `harnesses.${id}.hooks.config_path`,
      );
    }
    if (h.method !== undefined) {
      hooks.method = asString(
        h.method,
        `harnesses.${id}.hooks.method`,
      ) as HookMethod;
    }
    // TD-281: optional surface-projected flag (boolean). Absent ⇒ not-projected.
    if (typeof h.projected === "boolean") {
      hooks.projected = h.projected;
    }
    entry.hooks = hooks;
  }

  if (raw.harness_specific_file !== undefined) {
    entry.harnessSpecificFile = asString(
      raw.harness_specific_file,
      `harnesses.${id}.harness_specific_file`,
    );
  }

  return entry;
}

function parseDescriptor(sourcePath: string): HarnessDescriptor {
  let text: string;
  try {
    text = readFileSync(sourcePath, "utf-8");
  } catch (err) {
    throw new HarnessDescriptorError(
      `could not read ${sourcePath}: ${(err as Error).message}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new HarnessDescriptorError(
      `${sourcePath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const root = asObject(json, "manifest");
  const harnesses = asObject(root.harnesses, "manifest.harnesses");

  const byId = new Map<HarnessId, HarnessEntry>();
  const order: HarnessId[] = [];
  for (const key of Object.keys(harnesses)) {
    if (!VALID_HARNESS_IDS.includes(key as HarnessId)) {
      throw new HarnessDescriptorError(
        `unknown harness id '${key}' (must be one of ${VALID_HARNESS_IDS.join(", ")})`,
      );
    }
    const id = key as HarnessId;
    byId.set(id, buildEntry(id, asObject(harnesses[key], `harnesses.${key}`)));
    order.push(id);
  }
  if (order.length === 0) {
    throw new HarnessDescriptorError("manifest.harnesses is empty");
  }
  return { byId, order, sourcePath };
}

// --- Cache -----------------------------------------------------------------

const cache = new Map<string, HarnessDescriptor>();

/**
 * Resolve, parse, validate, and CACHE the harness descriptor. Cached by resolved
 * manifest path, so repeated calls (the accessors below) parse once. Pass
 * `manifestPath` to read a specific manifest (e.g. a project manifest in a test).
 */
export function loadHarnessDescriptor(
  opts?: LoadHarnessDescriptorOptions,
): HarnessDescriptor {
  const sourcePath = resolveManifestPath(opts);
  const cached = cache.get(sourcePath);
  if (cached) {
    return cached;
  }
  const parsed = parseDescriptor(sourcePath);
  cache.set(sourcePath, parsed);
  return parsed;
}

/** Test-only: clear the parse cache so a test can load a different fixture. */
export function __resetHarnessDescriptorCacheForTests(): void {
  cache.clear();
}

function entry(id: HarnessId): HarnessEntry {
  const e = loadHarnessDescriptor().byId.get(id);
  if (!e) {
    throw new HarnessDescriptorError(`no such harness '${id}' in the descriptor`);
  }
  return e;
}

// --- Accessors -------------------------------------------------------------

/** All declared shape ids, in manifest declaration order. */
export function harnessIds(): HarnessId[] {
  return [...loadHarnessDescriptor().order];
}

/** The npx AGENT id for a harness (claude→claude-code, gemini→gemini-cli, else identity). */
export function agentId(id: HarnessId): string {
  const e = entry(id);
  if (e.agentId === undefined) {
    throw new HarnessDescriptorError(`harnesses.${id} has no agent_id`);
  }
  return e.agentId;
}

/**
 * Agent ids of every harness with an `agent_id` (all 5 participate in skills).
 * Replaces `IGRIS_SKILLS_HARNESSES`.
 */
export function skillAgentIds(): string[] {
  return harnessIds()
    .map((id) => entry(id).agentId)
    .filter((a): a is string => a !== undefined);
}

/**
 * Agent ids of every harness with an `agent_id` (all 5 participate in MCP
 * registration). Replaces `IGRIS_MCP_HARNESSES` / `ADD_MCP_AGENT_ID`.
 */
export function mcpAgentIds(): string[] {
  return skillAgentIds();
}

/**
 * MCP wiring facts. Replaces `HARNESS_CONFIG` / `mcpConfigPathFor` / `mcpMapKeyFor`.
 * `configPath` is `~`-expanded at CALL time (not parse time) so a runtime HOME
 * override resolves correctly — the old `claudeJsonPath()`/etc. helpers
 * re-expanded on every call, and the sandboxed-HOME init/install/doctor tests
 * depend on that. The cached descriptor stores the RAW path.
 */
export function mcpFacts(id: HarnessId): McpFacts {
  const e = entry(id);
  if (!e.mcp) {
    throw new HarnessDescriptorError(`harnesses.${id} has no mcp block`);
  }
  return { ...e.mcp, configPath: expandTilde(e.mcp.configPath) };
}

/**
 * No-prompt grant grammar. Replaces `GRANT_GRAMMAR`. `path` is `~`-expanded at
 * CALL time (see `mcpFacts`); absent for `covered`.
 */
export function grantGrammar(id: HarnessId): GrantFacts {
  const e = entry(id);
  if (!e.grant) {
    throw new HarnessDescriptorError(`harnesses.${id} has no grant block`);
  }
  const g = e.grant;
  return g.path !== undefined ? { ...g, path: expandTilde(g.path) } : g;
}

/**
 * Hook-surface facts. Absent hooks block ⇒ `{ supported: false }`. `configPath`
 * is `~`-expanded at CALL time (see `mcpFacts`).
 */
export function hookFacts(id: HarnessId): HookFacts {
  const h = entry(id).hooks;
  return h.configPath !== undefined
    ? { ...h, configPath: expandTilde(h.configPath) }
    : h;
}

/** Repo-relative harness-specific OS context file, if any (gemini/antigravity). */
export function harnessSpecificFile(id: HarnessId): string | undefined {
  return entry(id).harnessSpecificFile;
}

/**
 * Harnesses that participate in the AGENTS surface (have an `agents` block), in
 * declaration order. Replaces `VALID_TARGET_TYPES`. antigravity is `dynamic-define`
 * → no `agents` block → not a member (OPEN DECISION #1).
 */
export function agentTargetTypes(): HarnessId[] {
  return harnessIds().filter((id) => entry(id).agents !== undefined);
}

/**
 * Harnesses that participate in the MCP surface (have an `mcp` block), in
 * declaration order. Replaces `VALID_MCP_TARGET_TYPES`.
 */
export function mcpTargetTypes(): HarnessId[] {
  return harnessIds().filter((id) => entry(id).mcp !== undefined);
}

/**
 * Harnesses that participate in the HOOK surface (`hooks.supported === true`), in
 * declaration order. Replaces `VALID_HOOK_TARGET_TYPES`.
 */
export function hookTargetTypes(): HarnessId[] {
  return harnessIds().filter((id) => entry(id).hooks.supported);
}

/**
 * Harnesses whose agents MUST appear as a per-agent target row
 * (`agents.projection === "target-row"`) = {codex, gemini, opencode}. The
 * parity-guard's "must appear in targets[]" set (FR-217 M4); claude is
 * `symlink` (exempt) and antigravity has no `agents` block (exempt).
 */
export function agentTargetRowHarnesses(): HarnessId[] {
  return harnessIds().filter(
    (id) => entry(id).agents?.projection === "target-row",
  );
}

/**
 * Harnesses that are surface-PROJECTED for MCP (`mcp.projected === true`), in
 * declaration order = {claude, codex, gemini, opencode}. The drift parity-guard's
 * expected mcp set (TD-281). DISTINCT from `mcpTargetTypes()` (block presence /
 * capability): all 5 have an `mcp` block, but antigravity is `mcp.projected:false`
 * (the FR-179 carve-out — its entry is custom-written to ~/.gemini/config/, not
 * add-mcp-projected) so it is excluded. This is the "surface-projected vs carve-
 * out" signal that lets parity expect only the harnesses whose targets SHOULD
 * appear, keeping the brain MCP block's antigravity omission legitimate.
 */
export function mcpProjectedHarnesses(): HarnessId[] {
  return harnessIds().filter((id) => entry(id).mcp?.projected === true);
}

/**
 * Harnesses that are surface-PROJECTED for hooks (`hooks.projected === true`), in
 * declaration order = {claude, opencode, antigravity}. The drift parity-guard's
 * expected hook set (TD-281) = the 3 supported-hook harnesses (no hook carve-out
 * today, so projected mirrors `hooks.supported`). codex/gemini are
 * `hooks.supported:false` ⇒ no `projected` ⇒ excluded.
 */
export function hookProjectedHarnesses(): HarnessId[] {
  return harnessIds().filter((id) => entry(id).hooks.projected === true);
}
