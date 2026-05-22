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

/** Absolute path to the universal rules file in the runtime brain. */
export function rulesFilePath(): string {
  return join(brainDir(), "core", "rules", "00-igris-universal.md");
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
 * Byte-identical to the adapter's auto-discovered `DEFAULT_OVERLAY`.
 */
export function registryOverlayPath(): string {
  return join(registryDirPath(), "harness-manifest.personal.json");
}

/** Absolute path to a project's .claude/settings.json. */
export function projectSettingsPath(projectPath: string): string {
  return join(projectPath, ".claude", "settings.json");
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
