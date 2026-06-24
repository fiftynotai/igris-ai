/**
 * Centralizes path resolution for the Igris CLI.
 *
 * The brain root defaults to `~/.igris/` but honors `IGRIS_BRAIN_DIR` env
 * override (matches the existing shell convention from `igris_hooks_sync.sh`
 * and `verify_mirror.sh`). Tests sandbox the brain by setting that env var.
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the brain root (default: `~/.igris/`, override via IGRIS_BRAIN_DIR). */
export function brainDir(): string {
  const env = process.env.IGRIS_BRAIN_DIR;
  if (env && env.length > 0) {
    return resolve(env);
  }
  return join(homedir(), ".igris");
}

/** Absolute path to the brain SQLite DB. */
export function brainDbPath(): string {
  return join(brainDir(), "memory", "knowledge.db");
}

/** Absolute path to the canonical hooks JSON file in the runtime brain. */
export function canonicalHooksPath(): string {
  return join(brainDir(), "core", "hooks", "canonical-settings.json");
}

/** Absolute path to a project's installed_features.json. */
export function installedFeaturesPath(slug: string): string {
  return join(brainDir(), "projects", slug, "installed_features.json");
}

/** Absolute path to the agents manifest in the runtime brain. */
export function agentsManifestPath(): string {
  return join(brainDir(), "core", "agents", "manifest.yaml");
}

/** Absolute path to the skills directory in the runtime brain. */
export function skillsDirPath(): string {
  return join(brainDir(), "core", "skills");
}

/**
 * Absolute path to the core surfaces manifest in the runtime brain
 * (`<brain>/core/scripts/cli-adapters/surfaces-manifest.json`). This is the
 * GLOBAL Layer-1 surfaces file declaring core skills + mcp_servers + hooks
 * — the same file the bash adapters resolve as `CORE_SURFACES` (next to the
 * adapter scripts). Honors IGRIS_BRAIN_DIR via brainDir().
 */
export function coreSurfacesManifestPath(): string {
  return join(
    brainDir(),
    "core",
    "scripts",
    "cli-adapters",
    "surfaces-manifest.json",
  );
}

/**
 * Absolute path to the Layer-2 customization registry dir: `~/.igris/registry/`.
 *
 * Honors IGRIS_BRAIN_DIR (so tests sandbox it via the same env seam the bash
 * adapters use). The FR-136 compile/check adapters resolve the personal
 * overlay under this exact dir (`compile_harnesses.sh` sets
 * `DEFAULT_OVERLAY="$BRAIN_DIR/registry/harness-manifest.personal.json"`), so a
 * sandboxed brain dir makes the FR-141 verb and the adapters agree automatically.
 */
export function registryDirPath(): string {
  return join(brainDir(), "registry");
}

/**
 * Absolute path to the Layer-2 personal overlay manifest written by
 * `igris registry add|remove`: `~/.igris/registry/harness-manifest.personal.json`.
 * Byte-identical to the adapter's auto-discovered `DEFAULT_OVERLAY`. Catalog
 * file at the registry root under L-517 (typed-subfolder layout).
 */
export function registryOverlayPath(): string {
  return join(registryDirPath(), "harness-manifest.personal.json");
}

/**
 * Absolute path to the vendored-copy directory for a registry AGENT:
 * `~/.igris/registry/agents/<name>/`. TD-191 introduces the L-517 typed-
 * subfolder layout (`agents/`, `skills/`, `body-exceptions/`) so the
 * registry root stays catalog-only. Renamed from the generic-named
 * `registrySurfaceDirPath` per L-519 §18.4 (a generic helper that named a
 * specific use case). See L-517 (typed layout) and L-519 (anti-pattern).
 */
export function registryAgentDirPath(name: string): string {
  return join(registryDirPath(), "agents", name);
}

/**
 * Absolute path to the vendored-tree directory for a registry SKILL:
 * `~/.igris/registry/skills/<name>/`. Mirrors `registryAgentDirPath` under
 * the L-517 typed-subfolder layout; the FR-143/TD-191 `add-skill` writer
 * vendors `<src>/<name>/SKILL.md` into here so the codex compiler + gemini
 * converter's `find -mindepth 2` walks still resolve. See L-517.
 */
export function registrySkillDirPath(name: string): string {
  return join(registryDirPath(), "skills", name);
}

/**
 * Absolute path to the FR-142 typed-origin sidecar:
 * `~/.igris/registry/origins.json`. Catalog file at the registry root under
 * L-517 (the only catalog files at root are this and `harness-manifest.
 * personal.json`; everything else is in a typed subfolder). Stored OUTSIDE
 * the harness manifest (option (b)) so the overlay stays schema-clean — the
 * compiler never reads this file; only `igris registry update` does.
 * Honors IGRIS_BRAIN_DIR.
 */
export function registryOriginsPath(): string {
  return join(registryDirPath(), "origins.json");
}

/** Absolute path to a project's .claude/settings.json. */
export function projectSettingsPath(projectPath: string): string {
  return join(projectPath, ".claude", "settings.json");
}

/**
 * FR-195 (M2): absolute path to a project's session directory
 * `~/.igris/projects/<slug>/session/`. This is the on-disk home of the
 * per-instance LIVE files (`instances/<id>.md`), the legacy
 * `CURRENT_SESSION.md`, the `archive/` rollups, and `BLOCKERS.md`. Honors
 * IGRIS_BRAIN_DIR via brainDir() — the same sandbox seam the bash awaken
 * steps use (`~/.igris/projects/{project}/session/`).
 */
export function projectSessionDir(slug: string): string {
  return join(brainDir(), "projects", slug, "session");
}

/**
 * FR-195 (M2): absolute path to a project's session/instances directory —
 * `~/.igris/projects/<slug>/session/instances/`. `session register` writes
 * the LIVE per-instance file `instances/<instance_id>.md` here (SKILL.md
 * §3.7 step 2).
 */
export function projectSessionInstancesDir(slug: string): string {
  return join(projectSessionDir(slug), "instances");
}

/**
 * FR-195 (M2): absolute path to a project's session/archive directory —
 * `~/.igris/projects/<slug>/session/archive/`. The housekeeping sweep (H0–H3)
 * moves retired/superseded files here and rolls the >30d individual files into
 * `<YYYY-MM>.md` month digests (SKILL.md §3.8).
 */
export function projectSessionArchiveDir(slug: string): string {
  return join(projectSessionDir(slug), "archive");
}

/**
 * FR-195 (M2): absolute path to a project's BLOCKERS.md —
 * `~/.igris/projects/<slug>/session/BLOCKERS.md`. The `assess` verb reads this
 * for the active-blockers line of its digest (SKILL.md §4).
 */
export function projectBlockersPath(slug: string): string {
  return join(projectSessionDir(slug), "BLOCKERS.md");
}

/** Absolute path to `~/.igris/.install-source.json`. */
export function installSourcePath(): string {
  return join(brainDir(), ".install-source.json");
}

/** Absolute path to the tarball cache root: `~/.igris/.cache/`. */
export function cacheDir(): string {
  return join(brainDir(), ".cache");
}

/** Absolute path to `~/.igris/USER.md`. */
export function userMdPath(): string {
  return join(brainDir(), "USER.md");
}

/** Absolute path to `~/.igris/config.json`. */
export function configJsonPath(): string {
  return join(brainDir(), "config.json");
}

/**
 * FR-165 (FR-160 epic): absolute path to `~/.igris/secrets.env` — the SINGLE
 * source of real MCP secrets. chmod 600, gitignored (lives OUTSIDE the repo).
 * Honors IGRIS_BRAIN_DIR (the test-sandbox seam every other helper uses).
 *
 * The registry overlay stores only `${VAR}` indirection refs; the actual
 * literal a Codex compile resolves at FR-164 projection time is read from
 * this file. claude/gemini/opencode never read it (they resolve the ref +
 * inherit exported env at launch).
 */
export function secretsEnvPath(): string {
  return join(brainDir(), "secrets.env");
}

/**
 * Absolute path to `~/.claude.json` — Claude Code's per-user config FILE.
 *
 * NOTE: this is `~/.claude.json` (a file), NOT `~/.claude/settings.json`.
 * It carries the `mcpServers` map that registers MCP servers for Claude
 * Code. TD-168 upserts the `igris-brain` entry into that map.
 */
export function claudeJsonPath(): string {
  return join(homedir(), ".claude.json");
}

/**
 * Absolute path to the bundled brain-mcp-server entrypoint shipped inside
 * the CLI npm package: `cli/dist/brain-mcp-server/dist/index.js`.
 *
 * Resolved by walking up two levels from this module's directory to the
 * `cli/` package root, then into `dist/brain-mcp-server/dist/index.js`:
 *   compiled: cli/dist/lib/paths.js → ../.. = cli/ → cli/dist/brain-mcp-server/...
 *   source:   cli/src/lib/paths.ts  → ../.. = cli/ → cli/dist/brain-mcp-server/...
 *
 * Both contexts resolve to the SAME real bundled location — the path the
 * `copy-templates.sh` bundling stage (TD-168) stages. Anchoring on `cli/`
 * rather than the module's parent makes the resolution correct under
 * vitest (which runs `src/`) as well as in the published package (`dist/`).
 * Same `dirname(fileURLToPath(import.meta.url))` idiom as
 * `init.ts#templateRoot()` and `global-claude-md.ts`.
 */
export function bundledMcpEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // cli/dist/lib or cli/src/lib
  return join(here, "..", "..", "dist", "brain-mcp-server", "dist", "index.js");
}

/**
 * FR-162 (FR-160 epic): absolute path to Gemini's settings file:
 * `~/.gemini/settings.json` (carries the `mcpServers` map). Staged here for
 * FR-164's compile-time MCP projection; `add-mcp` itself writes only the
 * overlay, never a live harness config.
 */
export function geminiSettingsPath(): string {
  return join(homedir(), ".gemini", "settings.json");
}

/**
 * FR-179: absolute path to Antigravity's MCP config:
 * `~/.gemini/config/mcp_config.json` (carries the `mcpServers` map). R1 RESOLVED
 * (2026-06-11, live `agy` marker test): antigravity reads MCP EXCLUSIVELY from
 * this file — a DISTINCT file from the `~/.gemini/settings.json` gemini writes
 * (`geminiSettingsPath`). The entry SHAPE is byte-identical to gemini's
 * (no `type`, `{command,args,env}`, map key `mcpServers`); only the path differs.
 */
export function antigravityMcpConfigPath(): string {
  return join(homedir(), ".gemini", "config", "mcp_config.json");
}

/**
 * FR-181: absolute path to Antigravity's hook config:
 * `~/.gemini/config/hooks.json` (gemini-cli hook format
 * `{hooks:{<Event>:[{matcher,hooks:[{type:"command",command}]}]}}`). This is the
 * TRIGGER path antigravity reads at launch — a DISTINCT file from the
 * `~/.gemini/config/mcp_config.json` MCP config in the same dir (both
 * benign-create the shared `~/.gemini/config/` dir). NOTE: antigravity's own UI
 * writes to `~/.gemini/antigravity-cli/hooks.json`, but triggers fire from THIS
 * config file (antigravity-cli#49) — so Igris writes here.
 */
export function antigravityHooksConfigPath(): string {
  return join(homedir(), ".gemini", "config", "hooks.json");
}

/**
 * FR-179 (R2): the native skills-loader directory Antigravity reads —
 * `~/.gemini/antigravity-cli/skills`. R2 RESOLVED (2026-06-11, live test):
 * antigravity loads skills from this exact path but does NOT self-create the
 * `skills → ~/.agents/skills` symlink (removing it + relaunch did not recreate
 * it). So `igris install` MUST create this as a PARENT-dir symlink pointing at
 * `agentsSkillsDirPath()` (FR-179 Phase C / `linkAntigravitySkills`).
 */
export function antigravitySkillsLinkPath(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "skills");
}

/**
 * FR-179 (R2): the cross-CLI shared skills directory `~/.agents/skills` — the
 * target the antigravity skills parent symlink points at. Skill ITEMS are
 * projected here by the existing `agents/symlink` surface target (rides
 * gemini/codex), so the one parent symlink covers every current + future skill
 * with zero per-item work.
 */
export function agentsSkillsDirPath(): string {
  return join(homedir(), ".agents", "skills");
}

/**
 * FR-162: absolute path to Codex's config: `~/.codex/config.toml` (carries
 * `[mcp_servers.*]` tables). Staged for FR-164; unused by `add-mcp`.
 */
export function codexConfigTomlPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

/**
 * FR-162: absolute path to OpenCode's config: `~/.config/opencode/opencode.json`
 * (carries the `mcp` map). Staged for FR-164; unused by `add-mcp`.
 */
export function opencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

/**
 * FR-162: absolute path to the vendored-bundle dir for a registry MCP server:
 * `~/.igris/registry/mcp_servers/<name>/`. Declared now for FR-167 (`--from`
 * bundle vendoring) parity with `registrySkillDirPath`; FR-162 (inline
 * command-ref) does NOT vendor, so this is unused by `runAddMcp` but reserved
 * under the L-517 typed-subfolder layout. Honors IGRIS_BRAIN_DIR via
 * `registryDirPath()` (same env-sandbox seam as `registrySkillDirPath`).
 */
export function registryMcpDirPath(name: string): string {
  return join(registryDirPath(), "mcp_servers", name);
}
