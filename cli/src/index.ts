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
import { runRegistry, type RegistryAction } from "./verbs/registry.js";
import type { McpHarness } from "./lib/mcp-env-normalize.js";
import { setVerbosity, info, error as logError } from "./lib/log.js";

/** Commander reducer for a repeatable option: accumulate into an array. */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

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
    .option("--target <kind>", "restrict to one target type: claude | codex | gemini | opencode | all (compile only)")
    .option("--surface <kind>", "restrict to one projection surface: agents | skills | mcp | all (compile only)")
    .option("--filter <glob>", "only process agents whose name matches the glob")
    .action(
      async (
        action: string,
        opts: {
          projectRoot?: string;
          manifest?: string;
          overlay?: string;
          target?: string;
          surface?: string;
          filter?: string;
        },
      ): Promise<void> => {
        const code = await runHarness({
          action: action as HarnessAction,
          projectRoot: opts.projectRoot,
          manifest: opts.manifest,
          overlay: opts.overlay,
          target: opts.target,
          surface: opts.surface,
          filter: opts.filter,
        });
        process.exitCode = code;
      },
    );

  program
    .command("registry <action>")
    .description(
      "Register Layer-2 personal customizations into the overlay (FR-141/FR-142/FR-143/FR-148/FR-162). " +
        "Actions: add (copy-vendors the canonical files), add-skill (references a skills source dir into surfaces.skills), add-mcp (registers a global MCP server into surfaces.mcp_servers), list, remove, update (re-vendors from origin). " +
        "--from accepts a local path OR github:owner/repo@<ref>[#subdir]. " +
        "For add-skill, the positional <source-dir> (or --from) is the live skills root and --target is type:method:path. " +
        "For add-mcp, --command + --target type:merge[:enabled] register a global MCP; --env values must be ${VAR} indirection refs (inline secrets rejected).",
    )
    .argument("[name]", "agent name (add/remove/update) OR skills source-dir (add-skill)")
    .option(
      "--from <path-or-github>",
      "source: local dir-or-file, or github:owner/repo@<ref>[#subdir]",
    )
    .option("--canonical <dir-or-file>", "(deprecated alias for --from)")
    .option("--versioned", "canonical is versioned (requires --glob)", false)
    .option("--glob <g>", "filename glob (versioned only)")
    .option(
      "--target <type:path>",
      "output target type:path (repeatable)",
      collect,
      [],
    )
    .option("--body-exception <basename>", "body-exception sidecar basename")
    .option("--all", "update every path-origin entry (update only)", false)
    .option(
      "--project-root <dir>",
      "root for base-manifest collision check + relative --from (default: cwd)",
    )
    .option("--name <slug>", "personal skill name (add-skill); REQUIRED for add-skill")
    .option(
      "--project <path>",
      "FR-155: scope this entry to one project root (path; on re-add against an existing project entry, the path is appended additively to scope.paths[]; against an existing global entry the run errors unless --scope project is also supplied).",
    )
    .option(
      "--scope <kind>",
      "FR-155: explicit scope kind for add/add-skill: 'global' or 'project'. Used to CONVERT an existing entry. --scope global drops scope.paths; --scope project + --project P resets scope.paths to [realpath(P)].",
    )
    .option("--command <bin>", "MCP launch command (add-mcp); REQUIRED for a new MCP")
    .option("--arg <value>", "MCP launch arg (add-mcp; repeatable)", collect, [])
    .option(
      "--env <KEY=${VAR}>",
      "MCP env var as an indirection ref (add-mcp; repeatable). VALUE must be a single ${VAR} reference — inline secrets are rejected.",
      collect,
      [],
    )
    .option(
      "--startup-timeout-sec <n>",
      "MCP startup timeout in seconds (add-mcp; Codex-only passthrough)",
    )
    .option(
      "--harness <type>",
      "INTERNAL (project-mcp): which harness to project ONE MCP into: claude | codex | gemini | opencode",
    )
    .option(
      "--overlay <path>",
      "INTERNAL (project-mcp): personal-overlay manifest override (default: auto-discover under IGRIS_BRAIN_DIR)",
    )
    .option(
      "--config-path <path>",
      "INTERNAL (project-mcp): override the harness config FILE (test/compile seam)",
    )
    .option(
      "--secrets-path <path>",
      "INTERNAL (project-mcp): override ~/.igris/secrets.env (codex only; test seam)",
    )
    .action(
      async (
        action: string,
        name: string | undefined,
        opts: {
          from?: string;
          canonical?: string;
          versioned?: boolean;
          glob?: string;
          target?: string[];
          bodyException?: string;
          all?: boolean;
          projectRoot?: string;
          name?: string;
          project?: string;
          scope?: string;
          command?: string;
          arg?: string[];
          env?: string[];
          startupTimeoutSec?: string;
          harness?: string;
          overlay?: string;
          configPath?: string;
          secretsPath?: string;
        },
      ): Promise<void> => {
        // Coalesce the deprecated --canonical alias into --from; emit a one-line
        // deprecation notice if the alias is used (FR-141 shipped --canonical
        // days ago — keep it working, but steer toward --from).
        if (opts.canonical !== undefined && opts.from === undefined) {
          info("registry: --canonical is deprecated; use --from <path> instead.");
        }
        // FR-143: `add-skill` takes its skills source-dir as the positional
        // arg (`igris registry add-skill <source-dir> --target ...`); coalesce
        // it into `from` when --from was not given explicitly. The positional
        // is NOT a `name` for skills (surfaces.skills is a single object).
        const isAddSkill = action === "add-skill";
        const from =
          opts.from ??
          opts.canonical ??
          (isAddSkill ? name : undefined);
        // FR-162: `add-mcp` keys on the MCP block NAME. Accept it via either
        // `--name <slug>` (preferred, parallels add-skill) OR the positional
        // `[name]` arg, so both forms work.
        const isAddMcp = action === "add-mcp";
        // FR-164 project-mcp also keys on `--name` (the bash driver passes it
        // explicitly). Accept `--name <slug>` OR the positional, like add-mcp.
        const isProjectMcp = action === "project-mcp";
        // FR-155: --scope must be one of {"global","project"} — validate at
        // the CLI boundary so the verb layer can trust the type. Commander
        // accepts any string; we narrow here. An invalid value is a usage
        // error (exit 2) like other CLI-boundary checks (parseTarget etc.).
        let scopeArg: "global" | "project" | undefined;
        if (opts.scope !== undefined) {
          if (opts.scope === "global" || opts.scope === "project") {
            scopeArg = opts.scope;
          } else {
            // Print on stderr through the same logError channel the verb uses.
            process.stderr.write(
              `registry: --scope value '${opts.scope}' is not one of 'global' | 'project'\n`,
            );
            process.exitCode = 2;
            return;
          }
        }
        // FR-162: --startup-timeout-sec is a STRING from Commander. Validate the
        // numeric parse at the CLI boundary (mirror the --scope check above) so
        // RegistryOptions.startupTimeoutSec stays typed `number` and the verb
        // can trust it. An invalid value is a usage error (exit 2).
        let startupTimeoutSec: number | undefined;
        if (opts.startupTimeoutSec !== undefined) {
          const n = Number(opts.startupTimeoutSec);
          if (!Number.isInteger(n)) {
            process.stderr.write(
              `registry: --startup-timeout-sec value '${opts.startupTimeoutSec}' must be an integer\n`,
            );
            process.exitCode = 2;
            return;
          }
          startupTimeoutSec = n;
        }
        // FR-164 project-mcp: --harness must be one of the 4 MCP harnesses.
        // Validate at the CLI boundary (mirror --scope) so RegistryOptions
        // .harness stays typed. An invalid value is a usage error (exit 2).
        let harnessArg: McpHarness | undefined;
        if (opts.harness !== undefined) {
          if (
            opts.harness === "claude" ||
            opts.harness === "codex" ||
            opts.harness === "gemini" ||
            opts.harness === "opencode"
          ) {
            harnessArg = opts.harness;
          } else {
            process.stderr.write(
              `registry: --harness value '${opts.harness}' is not one of 'claude' | 'codex' | 'gemini' | 'opencode'\n`,
            );
            process.exitCode = 2;
            return;
          }
        }
        const code = await runRegistry({
          action: action as RegistryAction,
          name: isAddSkill || isAddMcp || isProjectMcp ? (opts.name ?? name) : name,
          from,
          versioned: opts.versioned === true,
          glob: opts.glob,
          targets: opts.target,
          bodyException: opts.bodyException,
          all: opts.all === true,
          projectRoot: opts.projectRoot,
          project: opts.project,
          scope: scopeArg,
          command: opts.command,
          args: opts.arg,
          env: opts.env,
          startupTimeoutSec,
          harness: harnessArg,
          // FR-164 project-mcp: --overlay maps to the overlayPath seam
          // (the bash compile/drift driver passes the resolved overlay).
          overlayPath: opts.overlay,
          configPath: opts.configPath,
          secretsPath: opts.secretsPath,
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
