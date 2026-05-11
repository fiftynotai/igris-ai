/**
 * Centralizes path resolution for the Igris CLI.
 *
 * The brain root defaults to `~/.igris/` but honors `IGRIS_BRAIN_DIR` env
 * override (matches the existing shell convention from `igris_hooks_sync.sh`
 * and `verify_mirror.sh`). Tests sandbox the brain by setting that env var.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
