/**
 * `igris install <path>` — FR-212d (register-only).
 *
 * In the FR-212 global-projection model, ALL surfaces (skills/MCP/agents/hooks)
 * project GLOBALLY at `igris init`. `igris install <project>` therefore reduces
 * to BRAIN REGISTRATION: it tells the brain "this path is an Igris project" so
 * the globally-projected hooks de-no-op for it (the `_gate.sh` registration
 * gate keys on the `projects.path` row this writes). FR-212d Phase 2 DELETED the
 * legacy per-project layer (symlinks + `.igris_version` + per-project
 * `settings.json` hooks merge) and the `--legacy-per-project` flag — there is no
 * longer a per-project materialization path.
 *
 * Pipeline (register-only):
 *   7.  Registry: upsert the explicit slug (NOT basename) — the de-no-op gate.
 *   7b. Git-level gates (FR-243): symlink `<path>/.git/hooks/{pre-commit,
 *       commit-msg}` -> `$(brainDir())/core/git-hooks/<name>` (backup-not-
 *       clobber; refuses under core.hooksPath / a worktree / a missing mirror).
 *       A refusal WARNs and never fails the install — registration succeeded.
 *       Opt out with `--no-git-hooks`. `igris doctor --fix` repairs a project
 *       registered without them (`git-hooks-missing`).
 *   8.  installed_features.json: content hashes (schema v2: brain_channel/ref).
 *   9.  cognition.{perception,subconscious}.enabled=false defaults (only if absent).
 *   10. Remote-brain push (best-effort; failure does not fail install).
 *   11. Register igris-brain MCP in ~/.claude.json ONLY when absent or dangling
 *       (TD-455); an existing entry at a different, existing bundle is kept —
 *       registration is global and owned by `igris init` (`--upgrade`, `--dev`).
 *
 * Flag semantics:
 *   D-4: better-sqlite3 direct DB access (not via MCP).
 */

import { existsSync } from "node:fs";
import { basename, join, resolve as pathResolve } from "node:path";
import { upsertProject } from "../lib/registry.js";
import {
  computeFeatureHashes,
  writeInstalledFeatures,
  readInstalledFeatures,
} from "../lib/installed-features.js";
import {
  brainDir,
  bundledMcpEntryPath,
  claudeJsonPath,
  installedFeaturesPath,
} from "../lib/paths.js";
import {
  inspectMcpRegistration,
  planClaudeMcpRegistration,
  registerMcpInClaudeJson,
} from "../lib/mcp-register.js";
import { validateSlug } from "../lib/slug.js";
import { applyJanitorDefault, applyPerceptionDefault, applySubconsciousDefault, applySynapseDefault } from "../lib/init-config.js";
import { pushProjectToRemote } from "../lib/remote-push.js";
import { readInstallSource } from "../lib/install-source.js";
import {
  GIT_HOOK_NAMES,
  canonicalGitHookSource,
  hooksPathBypasses,
  installGitHooks,
  readCoreHooksPath,
  resolveGitHooksDir,
} from "../lib/git-hooks.js";
import { DryRunCollector } from "../lib/dry-run.js";
import { info, warn, error as logError, debug } from "../lib/log.js";

export interface InstallOptions {
  path: string;
  slug?: string;
  /**
   * FR-212d: vestigial — the per-project hooks merge it gated was deleted (hooks
   * project globally at `igris init`). Retained so existing callers/tests still
   * type-check; no pipeline step reads it. `--no-hooks` is accepted as a no-op.
   */
  installHooks: boolean;
  /**
   * FR-243: install the GIT hooks (step 7b). Default true; `--no-git-hooks`
   * sets false. Unrelated to `installHooks` (the retired harness-hooks flag).
   */
  installGitHooks?: boolean;
  /** Internal: CLI version string, defaults to package.json's version. */
  cliVersion?: string;
  /**
   * Internal: vestigial since FR-191 retired the CLAUDE.md render that
   * consumed it. Retained so existing callers/tests still type-check; no
   * pipeline step reads it.
   */
  installDate?: string;
  /**
   * When true, preview the would-be writes (registry upsert,
   * installed_features.json, MCP register) without performing any. The verb
   * returns 0 after printing the plan; `runUpdate --dry-run` does NOT delegate
   * here — it has its own enumeration path.
   */
  dryRun?: boolean;
}

// Slug grammar lives in lib/slug.ts (TD-118 — single source of truth).
//
// FR-212d Phase 2: `backupSettings` + `atomicWrite` (the per-project
// settings.json backup + atomic write helpers) were DELETED with the legacy
// step-6 hooks merge — install no longer writes a per-project settings.json.

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

  const cliVersion = opts.cliVersion ?? "7.3.0";
  const root = brainDir();

  // M3 — dry-run short-circuit. Enumerate would-be writes via DryRunCollector
  // and exit 0 without touching disk or the registry. The collector enumerates
  // the planned operations from the same input as the real run (slug +
  // install-source). FR-212d: register-only — no per-project layer to enumerate.
  if (opts.dryRun === true) {
    const dry = new DryRunCollector();
    enumerateInstallPlan(absPath, slug, dry, opts.installGitHooks !== false);
    dry.print();
    return 0;
  }

  // 3-6. FR-212d Phase 2: the legacy per-project layer (symlink layer,
  // `.igris_version` marker, per-project `settings.json` hooks merge) + the
  // CLAUDE.md render (FR-191) were DELETED. `igris install` is register-only:
  // every surface projects GLOBALLY at `igris init` (the canonical-hooks merge
  // target moved to `~/.claude/settings.json`); install just registers the
  // project with the brain (step 7) so the global hooks de-no-op for it.
  debug(
    "register-only install: surfaces project globally at `igris init` " +
      "(no per-project layer; --no-hooks is a no-op).",
  );

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

  // 7b. Git-level gates (FR-243). Best-effort: a refusal is a WARN with the
  // reason (the exit code stays 0 — the project IS registered), and doctor's
  // `git-hooks-missing` row keeps it visible until it is resolved.
  if (opts.installGitHooks !== false) {
    const gh = installGitHooks(absPath);
    if (gh.outcome === "refused") {
      warn(`git hooks not installed: ${gh.reason}`);
    } else {
      for (const h of gh.hooks) {
        if (h.outcome === "refused" || h.outcome === "failed") {
          warn(`git hook ${h.name}: ${h.outcome} — ${h.reason ?? ""}`);
        } else if (h.outcome === "already-installed") {
          debug(`git hook ${h.name}: already-installed -> ${h.source}`);
        } else {
          info(`git hook ${h.name}: ${h.outcome} -> ${h.hookPath} -> ${h.source}`);
          if (h.backup !== undefined) {
            info(`  previous ${h.name} preserved at ${h.backup}`);
          }
        }
      }
    }
  } else {
    debug("git hooks skipped (--no-git-hooks)");
  }

  // 8. installed_features.json — content hashes for upgrade detection (schema v2).
  const hashes = computeFeatureHashes({ includeHooks: opts.installHooks });

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
    hooks_version: hashes.hooks_version,
    agents_version: hashes.agents_version,
    skills_version: hashes.skills_version,
    rules_version: hashes.rules_version,
    installed_at: existingFeatures?.installed_at ?? now,
    updated_at: now,
  });

  // 9. Cognition defaults (FR-191; A3, TD-102) — both instances default OFF
  // under the `cognition.*` namespace, only-set-if-absent so an operator who
  // re-enabled a flag is never silently reverted.
  const subOutcome = applySubconsciousDefault();
  if (subOutcome === "default_set") {
    info("cognition.subconscious.enabled defaulted to false (TD-102; FR-191 zero-config door)");
  } else if (subOutcome === "preserved") {
    debug("cognition.subconscious.enabled preserved (operator override)");
  }

  const percOutcome = applyPerceptionDefault();
  if (percOutcome === "default_set") {
    info("cognition.perception.enabled defaulted to false (FR-191 zero-config door)");
  } else if (percOutcome === "preserved") {
    debug("cognition.perception.enabled preserved (operator override)");
  }

  const synOutcome = applySynapseDefault();
  if (synOutcome === "default_set") {
    info("cognition.synapse.enabled defaulted to false (FR-211 edge-inference instance)");
  } else if (synOutcome === "preserved") {
    debug("cognition.synapse.enabled preserved (operator override)");
  }

  const janOutcome = applyJanitorDefault();
  if (janOutcome === "default_set") {
    info("cognition.janitor.enabled defaulted to false (FR-119 memory-hygiene instance)");
  } else if (janOutcome === "preserved") {
    debug("cognition.janitor.enabled preserved (operator override)");
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

  // 11. Register igris-brain MCP in ~/.claude.json (TD-168) ONLY when absent
  // or dangling (TD-455). The registration is GLOBAL and owned by `igris init`
  // / `igris doctor --fix`; a per-project install run from another CLI build
  // (a scratch emit, `npx tsx`, a second global install) must never re-point
  // it to ITS bundle — FR-243 Phase 3 did exactly that to the live config.
  // Non-fatal: a registration failure WARNs and the install completes.
  const running = bundledMcpEntryPath();
  const plan = planClaudeMcpRegistration(inspectMcpRegistration(), running);
  if (plan.action === "keep-foreign") {
    info(
      `igris-brain MCP kept -> ${plan.existing} (differs from the running bundle ${running}; ` +
        "a per-project install never re-points a global registration — run 'igris init --upgrade' to re-point)",
    );
  } else {
    const mcpRes = registerMcpInClaudeJson();
    if (mcpRes.outcome === "failed") {
      warn(`MCP registration skipped: ${mcpRes.error}`);
      warn(
        `  Manual fix: add an "igris-brain" entry to mcpServers in ${mcpRes.claudeJsonPath}`,
      );
      warn(`  pointing at: ${mcpRes.mcpEntryPath}`);
    } else if (mcpRes.outcome === "unchanged") {
      debug(`igris-brain MCP already registered at ${mcpRes.mcpEntryPath}`);
    } else if (plan.action === "repair") {
      info(
        `re-pointed igris-brain MCP: ${plan.existing ?? "(no path)"} (missing) -> ${mcpRes.mcpEntryPath}; ` +
          `backup ${mcpRes.claudeJsonPath}.igris.bak`,
      );
      info("  Restart Claude Code to pick up the new MCP server.");
    } else {
      info(`Registered igris-brain MCP (${mcpRes.outcome}) -> ${mcpRes.mcpEntryPath}`);
      info("  Restart Claude Code to pick up the new MCP server.");
    }
  }

  info("");
  info("Install summary:");
  info(`  slug:           ${slug}`);
  info(`  path:           ${absPath}`);
  info(`  mode:           register-only`);
  info(`  features:       ${root}/projects/${slug}/installed_features.json`);
  info(`  git hooks:      ${opts.installGitHooks === false ? "skipped (--no-git-hooks)" : `${absPath}/.git/hooks/{pre-commit,commit-msg} -> ${root}/core/git-hooks/`}`);

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

// FR-212d Phase 2: `applySymlinkLayer` (the per-project `.claude/{agents,skills}`
// symlink materializer) was DELETED — `igris install` is register-only and no
// longer symlinks. Skills/agents project GLOBALLY at `igris init` (skills via the
// `skills` CLI delegate; agents via the global agent compiler). The TS symlink
// primitives (`lib/symlinks.ts`) and the install discovery walk
// (`lib/install-discovery.ts`) were deleted with it.

/**
 * Enumerate the planned register-only install operations into the DryRunCollector
 * without performing any. FR-212d: there is no per-project layer to plan — only
 * the registry upsert, installed_features.json, and the global igris-brain MCP
 * registration.
 */
function enumerateInstallPlan(
  projectPath: string,
  slug: string,
  dry: DryRunCollector,
  installGitHooksPlanned: boolean,
): void {
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

  // igris-brain MCP registration in ~/.claude.json (TD-168) — the same
  // decision the real step takes (TD-455), so the plan says "keep" where the
  // run would keep.
  const plan = planClaudeMcpRegistration(inspectMcpRegistration(), bundledMcpEntryPath());
  switch (plan.action) {
    case "keep-foreign":
      dry.wouldInvokeCommand(
        "(keep)",
        ["igris-brain MCP"],
        `keep (differs from the running bundle): ${plan.existing}`,
      );
      break;
    case "noop":
      dry.wouldInvokeCommand("(skip)", ["igris-brain MCP"], "already registered (no write)");
      break;
    case "repair":
      dry.wouldWriteFile(
        claudeJsonPath(),
        `register igris-brain MCP server (repair: ${plan.existing ?? "(no path)"} missing)`,
      );
      break;
    case "register":
      dry.wouldWriteFile(claudeJsonPath(), "register igris-brain MCP server (absent)");
      break;
  }

  // Git-level gates (FR-243, step 7b) — enumerated with the same refusals the
  // real step applies, so the plan says "refused" where the run would.
  if (installGitHooksPlanned) {
    const dir = resolveGitHooksDir(projectPath);
    const hp = dir.kind === "dir" ? readCoreHooksPath(dir.gitDir) : null;
    if (dir.kind === "dir" && (hp === null || !hooksPathBypasses(dir.gitDir, hp))) {
      for (const name of GIT_HOOK_NAMES) {
        dry.wouldWriteFile(
          join(dir.hooksDir, name),
          `symlink -> ${canonicalGitHookSource(name, { projectPath })} (git hook; a non-symlink hook is backed up first)`,
        );
      }
    } else if (dir.kind === "dir") {
      dry.wouldInvokeCommand(
        "(skip)",
        ["git hooks"],
        `refused: core.hooksPath=${hp} bypasses .git/hooks`,
      );
    } else if (dir.kind === "file") {
      dry.wouldInvokeCommand("(skip)", ["git hooks"], "refused: .git is a file (worktree/submodule)");
    } else {
      dry.wouldInvokeCommand("(skip)", ["git hooks"], "refused: not a git repository");
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
