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
  renameSync,
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
  claudeJsonPath,
  projectSettingsPath,
  installedFeaturesPath,
} from "../lib/paths.js";
import { registerMcpInClaudeJson } from "../lib/mcp-register.js";
import { linkDir, linkFile, SymlinkConflictError } from "../lib/symlinks.js";
import {
  discoverAgentEntries,
  discoverSkillEntries,
} from "../lib/install-discovery.js";
import { validateSlug } from "../lib/slug.js";
import { regenerateClaudeMd, ClaudeMdTemplateError } from "../lib/claude-md.js";
import { writeIgrisVersion } from "../lib/igris-version.js";
import { applySubconsciousDefault } from "../lib/init-config.js";
import { pushProjectToRemote } from "../lib/remote-push.js";
import { readInstallSource } from "../lib/install-source.js";
import { DryRunCollector } from "../lib/dry-run.js";
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
  /**
   * When true, preview the would-be writes (symlinks, CLAUDE.md, hooks merge,
   * registry upsert, installed_features.json) without performing any. The
   * verb returns 0 after printing the plan; `runUpdate --dry-run` does NOT
   * delegate here — it has its own enumeration path.
   */
  dryRun?: boolean;
}

// Slug grammar lives in lib/slug.ts (TD-118 — single source of truth).

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

  // M3 — dry-run short-circuit. Enumerate would-be writes via DryRunCollector
  // and exit 0 without touching disk or the registry. We intentionally do NOT
  // run the symlink/CLAUDE.md/hooks-merge code paths in preview mode — the
  // collector enumerates the planned operations from the same input as the
  // real run (project path + slug + install-source).
  if (opts.dryRun === true) {
    const dry = new DryRunCollector();
    enumerateInstallPlan(absPath, root, slug, opts.installHooks, dry);
    dry.print();
    return 0;
  }

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

  // 11. Register igris-brain MCP in ~/.claude.json (TD-168). Belt-and-
  // suspenders so a user who runs `igris install` without `igris init`
  // (the from-source contributor flow) still gets the MCP registered.
  // Non-fatal: a registration failure WARNs and the install completes.
  const mcpRes = registerMcpInClaudeJson();
  if (mcpRes.outcome === "failed") {
    warn(`MCP registration skipped: ${mcpRes.error}`);
    warn(
      `  Manual fix: add an "igris-brain" entry to mcpServers in ${mcpRes.claudeJsonPath}`,
    );
    warn(`  pointing at: ${mcpRes.mcpEntryPath}`);
  } else if (mcpRes.outcome === "unchanged") {
    debug(`igris-brain MCP already registered at ${mcpRes.mcpEntryPath}`);
  } else {
    info(`Registered igris-brain MCP (${mcpRes.outcome}) -> ${mcpRes.mcpEntryPath}`);
    info("  Restart Claude Code to pick up the new MCP server.");
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
 *   - Skills: each subdirectory under brain skills/ is linked as a dir.
 *
 * FR-187: the Rules symlink layer was removed when the universal rule retired
 * (baseline → core/os/standards.md). No `.claude/rules/` symlink is created.
 *
 * Throws SymlinkConflictError if any pre-existing path collides with a
 * non-matching symlink target. The early throw is intentional — install
 * never silently clobbers.
 */
function applySymlinkLayer(projectPath: string, brainRoot: string): void {
  const claudeDir = join(projectPath, ".claude");

  // ---- Agents ---------------------------------------------------------
  // TD-117: discovery is centralized in lib/install-discovery.ts so this
  // verb and the dry-run enumerator share one source of truth.
  const agentEntries = discoverAgentEntries(brainRoot);
  if (agentEntries.length > 0) {
    const agentsDest = join(claudeDir, "agents");
    for (const entry of agentEntries) {
      linkFile(entry.src, join(agentsDest, entry.basename));
    }
  }

  // ---- Skills ---------------------------------------------------------
  const skillEntries = discoverSkillEntries(brainRoot);
  if (skillEntries.length > 0) {
    const skillsDest = join(claudeDir, "skills");
    for (const entry of skillEntries) {
      linkDir(entry.src, join(skillsDest, entry.basename));
    }
  }
}

/**
 * Enumerate the planned install operations into the DryRunCollector without
 * performing any of them. Mirrors the order of side-effects in runInstall:
 * symlinks → CLAUDE.md → .igris_version → settings.json hooks merge →
 * registry upsert → installed_features.json.
 *
 * Discovery is read-only: we walk the brain core directory to enumerate the
 * symlinks that WOULD be created and report them as `would_create_dir` /
 * `would_write_file` records. The collector's printer renders them as a plan.
 */
function enumerateInstallPlan(
  projectPath: string,
  brainRoot: string,
  slug: string,
  installHooks: boolean,
  dry: DryRunCollector,
): void {
  const claudeDir = join(projectPath, ".claude");

  // Symlinks: agents (TD-117 — same discovery source as applySymlinkLayer)
  const agentEntries = discoverAgentEntries(brainRoot);
  if (agentEntries.length > 0) {
    const agentsDest = join(claudeDir, "agents");
    dry.wouldCreateDir(agentsDest);
    for (const entry of agentEntries) {
      dry.wouldWriteFile(
        join(agentsDest, entry.basename),
        `symlink to ${entry.src}`,
      );
    }
  }

  // Symlinks: skills
  const skillEntries = discoverSkillEntries(brainRoot);
  if (skillEntries.length > 0) {
    const skillsDest = join(claudeDir, "skills");
    dry.wouldCreateDir(skillsDest);
    for (const entry of skillEntries) {
      dry.wouldWriteFile(
        join(skillsDest, entry.basename),
        `symlink to ${entry.src}`,
      );
    }
  }

  // CLAUDE.md (if template exists)
  const tmplPath = join(brainRoot, "core", "templates", "CLAUDE.md.tmpl");
  if (existsSync(tmplPath)) {
    dry.wouldWriteFile(
      join(projectPath, "CLAUDE.md"),
      `regenerated from ${tmplPath}`,
    );
  }

  // .igris_version
  dry.wouldWriteFile(
    join(projectPath, ".igris_version"),
    "version marker",
  );

  // Hooks merge
  if (installHooks) {
    dry.wouldWriteFile(
      projectSettingsPath(projectPath),
      "merge canonical hooks block",
    );
  }

  // Registry upsert (no file path, but we record it as an invoked command).
  dry.wouldInvokeCommand(
    "sqlite",
    ["upsert projects WHERE slug=?", slug],
    `register project '${slug}' -> ${projectPath}`,
  );

  // installed_features.json
  dry.wouldWriteFile(
    installedFeaturesPath(slug),
    "content hashes for upgrade detection",
  );

  // igris-brain MCP registration in ~/.claude.json (TD-168)
  dry.wouldWriteFile(
    claudeJsonPath(),
    "register igris-brain MCP server",
  );
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
