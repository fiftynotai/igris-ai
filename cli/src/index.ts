#!/usr/bin/env node
/**
 * Igris CLI — entry point.
 *
 * Verbs (Phase 2 — M1+M2+M3+M4):
 *   - init [--from-source <path>] [--channel <ref>] [--upgrade] [--dry-run]
 *   - refresh [--from-source <path>] [--channel <ref>] [--no-propagate] [--dry-run]
 *   - install <path> [--slug <slug>] [--no-hooks] [--dry-run]
 *   - update [--all] [--slug <slug>] [--self] [--dry-run]
 *   - register-project [path] [--slug <slug>] [--allow-missing-path]
 *   - sync <code|data|all|status> [--dry-run] [--if-changed]
 *   - doctor [--fix] [--remove-orphans] [--yes]
 *
 * The CLI now owns the entire install pipeline natively in TS — both the
 * materialized layer (settings.json hooks block, brain `projects` registry
 * rows, `installed_features.json`) AND the symlink layer (`.claude/agents`,
 * `.claude/rules`, `.claude/skills`, CLAUDE.md regen, `.igris_version`)
 * via `cli/src/lib/{symlinks,claude-md,igris-version}.ts`.
 *
 * Lifecycle pattern: top-level `main()` sets `process.exitCode` rather than
 * calling `process.exit(code)` so any pending async cleanup can flush.
 * better-sqlite3 itself is sync and explicitly closed in registry.ts.
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInstall } from "./verbs/install.js";
import { runUpdate } from "./verbs/update.js";
import { runDoctor } from "./verbs/doctor.js";
import { runInit } from "./verbs/init.js";
import { runRefresh } from "./verbs/refresh.js";
import { runRegisterProject } from "./verbs/register-project.js";
import { runSync, type SyncSubVerb } from "./verbs/sync.js";
import { runHarness, type HarnessAction } from "./verbs/harness.js";
import { setVerbosity, error as logError } from "./lib/log.js";

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/index.js -> dist -> package root
  const pkgPath = join(here, "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("igris")
    .description("Igris AI unified CLI")
    .version(readPackageVersion(), "-v, --version", "print version and exit")
    .option("--quiet", "suppress informational output", false)
    .option("--verbose", "enable debug-level logging", false)
    .hook("preAction", (thisCommand) => {
      const opts = thisCommand.opts() as { quiet?: boolean; verbose?: boolean };
      if (opts.quiet) {
        setVerbosity("quiet");
      } else if (opts.verbose) {
        setVerbosity("verbose");
      }
    });

  program
    .command("init")
    .description(
      "Bootstrap ~/.igris/ from scratch (or upgrade an existing v6/v7 install)",
    )
    .option(
      "--from-source <path>",
      "use a local Igris source repo instead of GitHub (contributor mode)",
    )
    .option(
      "--channel <ref>",
      "channel to fetch from: 'main', 'v7.0.0', or any tag",
    )
    .option("--upgrade", "upgrade an existing install (preserves user state)", false)
    .option(
      "--skip-remote",
      "skip remote_brain prompts; config.json will have remote_brain: null",
      false,
    )
    .option(
      "--cli-bridge <list>",
      "override auto-detected bridges: 'none' or 'claude,codex,gemini,opencode'",
    )
    .option(
      "--dry-run",
      "print the plan without performing any writes or network calls",
      false,
    )
    .option(
      "-y, --yes",
      "accept all defaults; skip prompts (identity + remote_brain + channel switch)",
      false,
    )
    .option(
      "--dev",
      "contributor dev-loop: register the igris-brain MCP from the --from-source clone, not the bundled copy (requires --from-source)",
      false,
    )
    .action(
      async (opts: {
        fromSource?: string;
        channel?: string;
        upgrade?: boolean;
        skipRemote?: boolean;
        cliBridge?: string;
        dryRun?: boolean;
        yes?: boolean;
        dev?: boolean;
      }): Promise<void> => {
        const code = await runInit({
          fromSource: opts.fromSource,
          channel: opts.channel,
          upgrade: opts.upgrade === true,
          skipRemote: opts.skipRemote === true,
          cliBridge: opts.cliBridge,
          dryRun: opts.dryRun === true,
          yes: opts.yes === true,
          dev: opts.dev === true,
        });
        process.exitCode = code;
      },
    );

  program
    .command("refresh")
    .description(
      "Re-fetch ~/.igris/core/ from the configured channel (or switch channels)",
    )
    .option(
      "--from-source <path>",
      "refresh from a local Igris source repo (contributor mode)",
    )
    .option(
      "--channel <ref>",
      "switch to a different channel: 'main', 'v7.0.0', or any tag",
    )
    .option(
      "--no-propagate",
      "skip the post-refresh 'igris update --all' propagation",
    )
    .option(
      "--dry-run",
      "print the plan without performing any writes or network calls",
      false,
    )
    .option("-y, --yes", "skip channel-switch confirmation prompts", false)
    .action(
      async (opts: {
        fromSource?: string;
        channel?: string;
        propagate?: boolean;
        dryRun?: boolean;
        yes?: boolean;
      }): Promise<void> => {
        const code = await runRefresh({
          fromSource: opts.fromSource,
          channel: opts.channel,
          // commander turns --no-propagate into opts.propagate=false. Default is true.
          noPropagate: opts.propagate === false,
          dryRun: opts.dryRun === true,
          yes: opts.yes === true,
        });
        process.exitCode = code;
      },
    );

  program
    .command("install <path>")
    .description("Install Igris in a project (default: includes hooks)")
    .option(
      "--slug <slug>",
      "registry slug (default: basename of path)",
    )
    .option("--no-hooks", "skip materializing hooks into .claude/settings.json")
    .option(
      "--dry-run",
      "preview symlinks, CLAUDE.md, and hooks-merge without performing any writes",
      false,
    )
    .action(
      async (
        path: string,
        opts: { slug?: string; hooks?: boolean; dryRun?: boolean },
      ): Promise<void> => {
        const code = await runInstall({
          path,
          slug: opts.slug,
          // commander turns --no-hooks into opts.hooks=false. Default is true.
          installHooks: opts.hooks !== false,
          dryRun: opts.dryRun === true,
        });
        process.exitCode = code;
      },
    );

  program
    .command("update")
    .description("Update materialized layer for one or more projects (or self-upgrade the CLI)")
    .option("--all", "update every registered project", false)
    .option("--slug <slug>", "update only the given slug")
    .option(
      "--self",
      "self-upgrade the CLI via 'npm install -g igris-ai@latest'",
      false,
    )
    .option(
      "--dry-run",
      "enumerate would-update projects without invoking install",
      false,
    )
    .action(
      async (opts: {
        all?: boolean;
        slug?: string;
        self?: boolean;
        dryRun?: boolean;
      }): Promise<void> => {
        const code = await runUpdate({
          all: opts.all === true,
          slug: opts.slug,
          self: opts.self === true,
          dryRun: opts.dryRun === true,
        });
        process.exitCode = code;
      },
    );

  program
    .command("register-project [path]")
    .description(
      "Write the brain registry row for <path> only (no .claude/, no hooks, no CLAUDE.md)",
    )
    .option(
      "--slug <slug>",
      "registry slug (default: basename of path)",
    )
    .option(
      "--allow-missing-path",
      "register even if <path> does not exist on disk",
      false,
    )
    .action(
      async (
        path: string | undefined,
        opts: { slug?: string; allowMissingPath?: boolean },
      ): Promise<void> => {
        const code = await runRegisterProject({
          path,
          slug: opts.slug,
          allowMissingPath: opts.allowMissingPath === true,
        });
        process.exitCode = code;
      },
    );

  program
    .command("sync <sub-verb>")
    .description(
      "Push code/data to the VPS brain. Sub-verbs: code, data, all, status.",
    )
    .option(
      "--dry-run",
      "preview the would-be rsync/ssh/MCP calls without performing them",
      false,
    )
    .option(
      "--if-changed",
      "skip the entire push when local HEAD matches origin/<branch> (cron-parity with retired igris_vps_update.sh --if-changed; only meaningful for 'code' and 'all')",
      false,
    )
    .action(
      async (
        subVerb: string,
        opts: { dryRun?: boolean; ifChanged?: boolean },
      ): Promise<void> => {
        const code = await runSync({
          subVerb: subVerb as SyncSubVerb,
          dryRun: opts.dryRun === true,
          ifChanged: opts.ifChanged === true,
        });
        process.exitCode = code;
      },
    );

  program
    .command("harness <action>")
    .description(
      "Regenerate or drift-check agent-prompt harnesses (FR-136). Actions: compile, check.",
    )
    .option(
      "--project-root <dir>",
      "root that canonical/target paths resolve against (default: cwd)",
    )
    .option("--manifest <path>", "base manifest override (default: <project-root>/harness-manifest.json)")
    .option("--overlay <path>", "personal-overlay manifest override (default: auto-discover)")
    .option("--target <kind>", "restrict to one target type: claude | codex | all (compile only)")
    .option("--filter <glob>", "only process agents whose name matches the glob")
    .action(
      async (
        action: string,
        opts: {
          projectRoot?: string;
          manifest?: string;
          overlay?: string;
          target?: string;
          filter?: string;
        },
      ): Promise<void> => {
        const code = await runHarness({
          action: action as HarnessAction,
          projectRoot: opts.projectRoot,
          manifest: opts.manifest,
          overlay: opts.overlay,
          target: opts.target,
          filter: opts.filter,
        });
        process.exitCode = code;
      },
    );

  program
    .command("doctor")
    .description("Diagnose drift in the registry and project install state")
    .option("--fix", "auto-fix all fixable drift classes (see `igris doctor` output)", false)
    .option(
      "--remove-orphans",
      "interactively delete registry rows whose path is missing",
      false,
    )
    .option("-y, --yes", "skip per-row confirmation when --remove-orphans", false)
    .action(
      async (opts: {
        fix?: boolean;
        removeOrphans?: boolean;
        yes?: boolean;
      }): Promise<void> => {
        const code = await runDoctor({
          fix: opts.fix === true,
          removeOrphans: opts.removeOrphans === true,
          yes: opts.yes === true,
        });
        process.exitCode = code;
      },
    );

  await program.parseAsync(argv);
}

main(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  logError(msg);
  process.exitCode = 1;
});
