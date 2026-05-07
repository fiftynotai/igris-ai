/**
 * `igris install <path>` — Phase 2 (M2: full CLI ownership).
 *
 * Owns the entire install pipeline. Phase 1 shelled out to
 * `scripts/igris_install.sh` for the symlink layer; Phase 2 runs that
 * layer natively via `cli/src/lib/symlinks.ts` and removes the shell-out.
 *
 * Pipeline (in order):
 *
 *   1. Symlink layer: <path>/.claude/{agents,rules,skills} → ~/.igris/core/...
 *      via linkDir/linkFile. Skipped when `skipSymlinkLayer: true`
 *      (test seam) or when ~/.igris/core/ is absent.
 *   2. CLAUDE.md: render template from ~/.igris/core/templates/CLAUDE.md.tmpl
 *      and atomic-write to <path>/CLAUDE.md.
 *   3. .igris_version: write JSON marker at <path>/.igris_version.
 *   4. Hooks (default ON, --no-hooks opts out): merge canonical hooks into
 *      <path>/.claude/settings.json using `mergeCanonicalHooks`. Backs up
 *      original to .bak.<timestamp> per Risks #2 mitigation (D-2 default).
 *   5. Registry: upsert the explicit slug (NOT basename) — D-3/D-4 default.
 *   6. installed_features.json: write content hashes for hooks/agents/skills/rules.
 *      Schema v2: brain_channel + brain_ref read from .install-source.json.
 *   7. subconscious.enabled=false default (TD-102; A3 — only if absent).
 *   8. Remote-brain push (A4 — best-effort; failure does not fail install).
 *
 * Flag semantics:
 *   D-1: Igris-hooks-first inside event arrays.
 *   D-2: .bak.<timestamp> kept unless IGRIS_KEEP_BAK=0.
 *   D-4: better-sqlite3 direct DB access (not via MCP).
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve as pathResolve } from "node:path";
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
import { linkDir, linkFile, SymlinkConflictError } from "../lib/symlinks.js";
import { regenerateClaudeMd, ClaudeMdTemplateError } from "../lib/claude-md.js";
import { writeIgrisVersion } from "../lib/igris-version.js";
import { applySubconsciousDefault } from "../lib/init-config.js";
import { pushProjectToRemote } from "../lib/remote-push.js";
import { readInstallSource } from "../lib/install-source.js";
import { info, warn, error as logError, debug } from "../lib/log.js";

export interface InstallOptions {
  path: string;
  slug?: string;
  installHooks: boolean;
  /** Internal: skip the symlink layer entirely. Used by tests + update verb. */
  skipSymlinkLayer?: boolean;
  /** Internal: CLI version string, defaults to package.json's version. */
  cliVersion?: string;
  /**
   * Internal: override the install date stamped into CLAUDE.md. Mostly for
   * tests asserting deterministic content; production calls always use today.
   */
  installDate?: string;
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

  const cliVersion = opts.cliVersion ?? "7.0.0";
  const root = brainDir();

  // 3. Symlink layer — native TS replacement for igris_install.sh:212-237.
  if (opts.skipSymlinkLayer !== true) {
    try {
      applySymlinkLayer(absPath, root);
    } catch (err) {
      if (err instanceof SymlinkConflictError) {
        logError(`symlink-layer install failed: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }

  // 4. CLAUDE.md regeneration from runtime template.
  if (opts.skipSymlinkLayer !== true) {
    try {
      regenerateClaudeMd(absPath, {
        cliVersion,
        installDate: opts.installDate,
      });
      info(`Wrote ${absPath}/CLAUDE.md`);
    } catch (err) {
      if (err instanceof ClaudeMdTemplateError) {
        // Non-fatal: a fresh from-source install may not have run init yet.
        warn(err.message);
      } else {
        throw err;
      }
    }
  }

  // 5. .igris_version write.
  if (opts.skipSymlinkLayer !== true) {
    writeIgrisVersion(absPath, cliVersion);
    debug(`Wrote ${absPath}/.igris_version`);
  }

  // 6. Materialized layer — hooks (default ON).
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

  // 7. Registry — upsert with explicit slug.
  const techStack = detectTechStack(absPath);
  try {
    upsertProject({
      slug,
      name: slug,
      path: absPath,
      tech_stack: techStack,
      igris_version: cliVersion,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`registry upsert failed: ${msg}`);
    return 1;
  }
  info(`Registered project: ${slug} -> ${absPath}`);

  // 8. installed_features.json — content hashes for upgrade detection (schema v2).
  const hashes = computeFeatureHashes({ includeHooks: opts.installHooks });
  hooksHash = hashes.hooks_version;

  // Read brain channel/ref from .install-source.json (M2 schema v2 fields).
  // When the file is absent (CLI invoked before init/refresh), both default
  // to null and a future doctor-run can backfill via channel-mismatch fixup.
  const installSource = readInstallSource();
  const brainChannel = installSource?.channel ?? null;
  const brainRef = installSource?.ref ?? null;

  const existingFeatures = readInstalledFeatures(slug);
  const now = new Date().toISOString();
  writeInstalledFeatures(slug, {
    schema_version: 2,
    cli_version: cliVersion,
    brain_channel: brainChannel,
    brain_ref: brainRef,
    hooks_version: hooksHash,
    agents_version: hashes.agents_version,
    skills_version: hashes.skills_version,
    rules_version: hashes.rules_version,
    installed_at: existingFeatures?.installed_at ?? now,
    updated_at: now,
  });

  // 9. Subconscious default (A3, TD-102).
  const subOutcome = applySubconsciousDefault();
  if (subOutcome === "default_set") {
    info("subconscious.enabled defaulted to false (TD-102; FR-118 redesign pending)");
  } else if (subOutcome === "preserved") {
    debug("subconscious.enabled preserved (operator override)");
  }

  // 10. Remote-brain push (A4) — best-effort, never fails the install.
  const pushOutcome = await pushProjectToRemote({
    slug,
    path: absPath,
    techStack,
    cliVersion,
  });
  if (pushOutcome === "pushed") {
    info("Project pushed to remote brain");
  } else if (pushOutcome !== "not_configured") {
    debug(`remote brain push outcome: ${pushOutcome}`);
  }

  info("");
  info("Install summary:");
  info(`  slug:           ${slug}`);
  info(`  path:           ${absPath}`);
  info(`  hooks:          ${opts.installHooks ? "yes" : "no"}`);
  info(`  features:       ${root}/projects/${slug}/installed_features.json`);

  // TD-112: when --slug differs from basename(path), preserve a diagnostic
  // hint pointing the user at the explicit slug. Phase 1 said the shell
  // layer wrote a duplicate row keyed by basename; the shell layer is now
  // gone, but the slug-mismatch is still informational. Plan §2 M2 line:
  // "rephrase to 'this slug differs from the directory name; no action
  // required (the explicit slug is authoritative).'"
  //
  // Routes via warn() → process.stderr; auto-suppressed under --quiet
  // (lib/log.ts:30-34) so pipe consumers and quiet runs are unaffected.
  if (opts.slug !== undefined && slug !== basename(absPath)) {
    warn(
      `slug '${slug}' differs from directory name '${basename(absPath)}' — no action required (the explicit slug is authoritative).`,
    );
  }

  return 0;
}

/**
 * Materialize the .claude/{agents,rules,skills} symlinks on the project.
 * Mirrors `scripts/igris_install.sh:212-237` exactly:
 *
 *   - Agents: each *.md file under brain agents/ is linked individually.
 *     manifest.yaml is also linked.
 *   - Rules: 00-igris-universal.md only.
 *   - Skills: each subdirectory under brain skills/ is linked as a dir.
 *
 * Throws SymlinkConflictError if any pre-existing path collides with a
 * non-matching symlink target. The early throw is intentional — install
 * never silently clobbers.
 */
function applySymlinkLayer(projectPath: string, brainRoot: string): void {
  const claudeDir = join(projectPath, ".claude");

  // ---- Agents ---------------------------------------------------------
  const agentsSrc = join(brainRoot, "core", "agents");
  if (existsSync(agentsSrc) && statSync(agentsSrc).isDirectory()) {
    const agentsDest = join(claudeDir, "agents");
    let entries: string[];
    try {
      entries = readdirSync(agentsSrc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SymlinkConflictError(
        `failed to enumerate ${agentsSrc}: ${msg}`,
      );
    }
    for (const entry of entries) {
      const full = join(agentsSrc, entry);
      if (entry.endsWith(".md") && statSync(full).isFile()) {
        linkFile(full, join(agentsDest, entry));
      } else if (entry === "manifest.yaml" && statSync(full).isFile()) {
        linkFile(full, join(agentsDest, entry));
      }
    }
  }

  // ---- Rules ----------------------------------------------------------
  const rulesSrc = join(brainRoot, "core", "rules", "00-igris-universal.md");
  if (existsSync(rulesSrc) && statSync(rulesSrc).isFile()) {
    linkFile(rulesSrc, join(claudeDir, "rules", "00-igris-universal.md"));
  }

  // ---- Skills ---------------------------------------------------------
  const skillsSrc = join(brainRoot, "core", "skills");
  if (existsSync(skillsSrc) && statSync(skillsSrc).isDirectory()) {
    const skillsDest = join(claudeDir, "skills");
    let entries: string[];
    try {
      entries = readdirSync(skillsSrc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SymlinkConflictError(
        `failed to enumerate ${skillsSrc}: ${msg}`,
      );
    }
    for (const entry of entries) {
      const full = join(skillsSrc, entry);
      if (statSync(full).isDirectory()) {
        linkDir(full, join(skillsDest, entry));
      }
    }
  }
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
