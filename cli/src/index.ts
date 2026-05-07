#!/usr/bin/env node
/**
 * Igris CLI — entry point.
 *
 * Verbs (Phase 1):
 *   - install <path> [--slug <slug>] [--no-hooks]
 *   - update --all
 *   - doctor [--fix] [--remove-orphans] [--yes]
 *
 * The CLI owns the *materialized* layer of an Igris install (settings.json
 * hooks block, brain `projects` registry rows, `installed_features.json`).
 * The symlink layer (`.claude/agents`, `.claude/rules`, `.claude/skills`,
 * CLAUDE.md regen, `.igris_version`) is delegated to `scripts/igris_install.sh`
 * via `child_process.execFileSync` for Phase 1; Phase 2 will reimplement
 * those primitives in TS.
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
      "skip remote_brain prompts (config.json will have remote_brain: null)",
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
    .option("-y, --yes", "skip confirmation prompts", false)
    .action(
      async (opts: {
        fromSource?: string;
        channel?: string;
        upgrade?: boolean;
        skipRemote?: boolean;
        cliBridge?: string;
        dryRun?: boolean;
        yes?: boolean;
      }): Promise<void> => {
        const code = await runInit({
          fromSource: opts.fromSource,
          channel: opts.channel,
          upgrade: opts.upgrade === true,
          skipRemote: opts.skipRemote === true,
          cliBridge: opts.cliBridge,
          dryRun: opts.dryRun === true,
          yes: opts.yes === true,
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
    .action(
      async (
        path: string,
        opts: { slug?: string; hooks?: boolean },
      ): Promise<void> => {
        const code = await runInstall({
          path,
          slug: opts.slug,
          // commander turns --no-hooks into opts.hooks=false. Default is true.
          installHooks: opts.hooks !== false,
        });
        process.exitCode = code;
      },
    );

  program
    .command("update")
    .description("Update materialized layer for one or more projects")
    .option("--all", "update every registered project", false)
    .option("--slug <slug>", "update only the given slug")
    .action(
      async (opts: { all?: boolean; slug?: string }): Promise<void> => {
        const code = await runUpdate({
          all: opts.all === true,
          slug: opts.slug,
        });
        process.exitCode = code;
      },
    );

  program
    .command("doctor")
    .description("Diagnose drift in the registry and project install state")
    .option("--fix", "auto-fix hooks-missing / hooks-stale / not-installed", false)
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
