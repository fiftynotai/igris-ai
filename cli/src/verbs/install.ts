/**
 * `igris install <path>` — Phase 1.
 *
 * Owns the materialized layer:
 *   1. Symlink layer: delegates to `scripts/igris_install.sh` via execFile.
 *   2. Hooks (default ON, --no-hooks opts out): merge canonical hooks into
 *      <path>/.claude/settings.json using `mergeCanonicalHooks`. Backs up
 *      original to .bak.<timestamp> per Risks #2 mitigation (D-2 default).
 *   3. Registry: upsert the explicit slug (NOT basename) — D-3/D-4 default.
 *   4. installed_features.json: write content hashes for hooks/agents/skills/rules.
 *
 * Flag semantics (D-1..D-4 architect defaults):
 *   D-1: Igris-hooks-first inside event arrays (matches existing shell).
 *   D-2: .bak.<timestamp> kept unless IGRIS_KEEP_BAK=0.
 *   D-3: symlink layer wraps scripts/igris_install.sh; no TS reimplementation.
 *   D-4: better-sqlite3 direct DB access (not via MCP).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve as pathResolve } from "node:path";
import { execFile } from "../lib/exec.js";
import { loadCanonicalHooks } from "../lib/canonical-hooks.js";
import { mergeCanonicalHooks, MalformedSettingsError } from "../lib/json-merge.js";
import { upsertProject } from "../lib/registry.js";
import {
  computeFeatureHashes,
  writeInstalledFeatures,
  readInstalledFeatures,
} from "../lib/installed-features.js";
import {
  brainDir,
  projectSettingsPath,
} from "../lib/paths.js";
import { info, warn, error as logError, debug } from "../lib/log.js";

export interface InstallOptions {
  path: string;
  slug?: string;
  installHooks: boolean;
  /** Internal: skip the shell-script symlink layer. Used by tests + update verb. */
  skipSymlinkLayer?: boolean;
  /** Internal: override repo root for invoking igris_install.sh (resolved from script path normally). */
  repoRoot?: string;
  /** Internal: CLI version string, defaults to package.json's version. */
  cliVersion?: string;
}

// Slug grammar tolerates uppercase (`lifeOS` exists in the real registry today).
// First char is alphanumeric; subsequent chars allow underscore, hyphen, dot.
// Length cap at 64 chars (more than the conservative 50 — matches real-world slugs
// like `igris-v6-test-project` and `fifty-content-pipeline`).
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid slug '${slug}': must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/ (alphanumeric start, then alphanumeric/underscore/hyphen/dot, max 64 chars).`,
    );
  }
}

function backupSettings(filePath: string): string | null {
  if (process.env.IGRIS_KEEP_BAK === "0") {
    return null;
  }
  if (!existsSync(filePath)) {
    return null;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${filePath}.bak.${ts}`;
  // copy via read+write (renameSync would lose the original)
  writeFileSync(bak, readFileSync(filePath, "utf-8"));
  return bak;
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

/**
 * Run `igris install`. Returns process exit code.
 */
export async function runInstall(opts: InstallOptions): Promise<number> {
  // 1. Resolve absolute path; reject if missing.
  const absPath = pathResolve(opts.path);
  if (!existsSync(absPath)) {
    logError(`path does not exist: ${absPath}`);
    return 1;
  }

  // 2. Resolve slug: explicit --slug wins, else basename.
  const slug = (opts.slug ?? basename(absPath)).trim();
  if (slug.length === 0) {
    logError("could not derive a slug; pass --slug explicitly");
    return 1;
  }
  validateSlug(slug);

  // 3. Symlink layer — wrap igris_install.sh unless test override.
  if (!opts.skipSymlinkLayer) {
    const repoRoot = opts.repoRoot ?? findRepoRoot();
    if (repoRoot === null) {
      logError(
        "could not locate scripts/igris_install.sh; pass repoRoot or run from the source repo.",
      );
      return 1;
    }
    const installScript = `${repoRoot}/scripts/igris_install.sh`;
    if (!existsSync(installScript)) {
      logError(`expected install script at ${installScript}`);
      return 1;
    }
    info(`Running symlink layer: ${installScript} ${absPath}`);
    try {
      execFile("bash", [installScript, absPath], { inheritStdio: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`symlink-layer install failed: ${msg}`);
      return 1;
    }
  }

  // 4. Materialized layer — hooks (default ON).
  const settingsPath = projectSettingsPath(absPath);
  let hooksHash: string | null = null;

  if (opts.installHooks) {
    let canonical;
    try {
      canonical = loadCanonicalHooks();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(msg);
      return 1;
    }

    let existing: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        existing = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
          string,
          unknown
        >;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(
          `refusing to clobber unreadable ${settingsPath}: ${msg}`,
        );
        return 1;
      }
    }

    let merged: Record<string, unknown>;
    try {
      merged = mergeCanonicalHooks(existing, canonical);
    } catch (err) {
      if (err instanceof MalformedSettingsError) {
        logError(
          `settings.json merge failed (refusing to clobber): ${err.message}`,
        );
        return 1;
      }
      throw err;
    }

    const bakPath = backupSettings(settingsPath);
    if (bakPath !== null) {
      debug(`backed up existing settings.json to ${bakPath}`);
    }
    atomicWrite(settingsPath, JSON.stringify(merged, null, 2) + "\n");
    info(`Wrote ${settingsPath} with merged hooks block`);
  } else {
    info("--no-hooks: skipping settings.json hooks merge");
  }

  // 5. Registry — upsert with explicit slug.
  try {
    upsertProject({
      slug,
      name: slug,
      path: absPath,
      tech_stack: detectTechStack(absPath),
      igris_version: opts.cliVersion ?? "7.0.0",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`registry upsert failed: ${msg}`);
    return 1;
  }
  info(`Registered project: ${slug} -> ${absPath}`);

  // 6. installed_features.json — content hashes for upgrade detection.
  const hashes = computeFeatureHashes({ includeHooks: opts.installHooks });
  hooksHash = hashes.hooks_version;

  const existingFeatures = readInstalledFeatures(slug);
  const now = new Date().toISOString();
  writeInstalledFeatures(slug, {
    schema_version: 1,
    cli_version: opts.cliVersion ?? "7.0.0",
    hooks_version: hooksHash,
    agents_version: hashes.agents_version,
    skills_version: hashes.skills_version,
    rules_version: hashes.rules_version,
    installed_at: existingFeatures?.installed_at ?? now,
    updated_at: now,
  });

  info("");
  info("Install summary:");
  info(`  slug:           ${slug}`);
  info(`  path:           ${absPath}`);
  info(`  hooks:          ${opts.installHooks ? "yes" : "no"}`);
  info(`  features:       ${brainDir()}/projects/${slug}/installed_features.json`);
  return 0;
}

/**
 * Walk up from cwd to find a directory containing `scripts/igris_install.sh`.
 * Returns null if not found.
 */
function findRepoRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(`${dir}/scripts/igris_install.sh`)) {
      return dir;
    }
    const parent = pathResolve(dir, "..");
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/**
 * Cheap heuristic — mirrors the indicator list from `igris_install.sh:419-438`.
 */
function detectTechStack(projectPath: string): string {
  const indicators: Array<[string, string]> = [
    ["pubspec.yaml", "flutter"],
    ["package.json", "typescript/javascript"],
    ["Cargo.toml", "rust"],
    ["go.mod", "go"],
    ["requirements.txt", "python"],
    ["pyproject.toml", "python"],
  ];
  const stacks: string[] = [];
  for (const [filename, stack] of indicators) {
    if (existsSync(`${projectPath}/${filename}`) && !stacks.includes(stack)) {
      stacks.push(stack);
    }
  }
  return stacks.join(",");
}

// Suppress unused-import warning when functions used in tests differ.
void warn;
