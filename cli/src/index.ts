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
 *   - context-docs inventory --project <slug> [--json]
 *   - doctor [--fix] [--remove-orphans] [--yes]
 *
 * The CLI owns the install pipeline natively in TS. FR-212d Phase 2 made
 * `igris install` REGISTER-ONLY: it upserts the brain `projects` row +
 * `installed_features.json` + the global igris-brain MCP registration. Every
 * surface (skills/MCP/agents/hooks) projects GLOBALLY at `igris init` — the
 * per-project symlink layer, `.igris_version` marker, and per-project
 * `settings.json` hooks merge (and the `cli/src/lib/{symlinks,igris-version}.ts`
 * modules) were deleted. FR-191 retired the CLAUDE.md render — install writes no
 * identity file.
 *
 * Lifecycle pattern: top-level `main()` sets `process.exitCode` rather than
 * calling `process.exit(code)` so any pending async cleanup can flush.
 * better-sqlite3 itself is sync and explicitly closed in registry.ts.
 *
 * ONE EXCEPTION to "run and exit" (FR-238): `dashboard` is a LONG-LIVED
 * foreground verb. Its action awaits a promise that does not resolve until
 * SIGINT/SIGTERM arrives, so the exit code is set on shutdown rather than
 * synchronously. Everything else about the pattern is unchanged — it still
 * sets `process.exitCode` and never calls `process.exit`.
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInstall } from "./verbs/install.js";
import { runUpdate } from "./verbs/update.js";
import { runDoctor } from "./verbs/doctor.js";
import { runInit } from "./verbs/init.js";
import { runConfigure } from "./verbs/configure.js";
import { runRefresh } from "./verbs/refresh.js";
import { runRegisterProject } from "./verbs/register-project.js";
import { runSync, type SyncSubVerb } from "./verbs/sync.js";
import { runHarness, type HarnessAction } from "./verbs/harness.js";
import { runLoadout, type LoadoutAction } from "./verbs/loadout.js";
import { runAdd } from "./verbs/add.js";
import { runRemove } from "./verbs/remove.js";
import { runDetect } from "./verbs/detect.js";
import { runOnboarding } from "./verbs/onboarding.js";
import { runBootSync } from "./verbs/boot-sync.js";
import { runSession, type SessionAction } from "./verbs/session.js";
import { runInstance, type InstanceAction } from "./verbs/instance.js";
import { runHousekeeping } from "./verbs/housekeeping.js";
import { runAssess } from "./verbs/assess.js";
import { runContextDocs, type ContextDocsAction } from "./verbs/context-docs.js";
import { runCognition } from "./verbs/cognition.js";
import { runCeremony } from "./verbs/ceremony.js";
import { runKpi } from "./verbs/kpi.js";
import { runDashboard } from "./verbs/dashboard.js";
import { runExport } from "./verbs/export.js";
import { runImport } from "./verbs/import.js";
import type { ExportTier, OnConflictPolicy } from "./types.js";
import type { McpHarness } from "./lib/mcp-env-normalize.js";
// TD-367 round 6: the `--cli-bridge` help text DERIVES its roster. The literal
// it replaced named four targets while `applyBridgeOverride` validates against
// this same accessor (six), so the shipped help contradicted the shipped error.
import { knownCLITargets } from "./lib/cli-detect.js";
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
      "channel to fetch from: 'main', a tag (e.g. 'v7.0.0'), or any branch (e.g. 'develop')",
    )
    .option("--upgrade", "upgrade an existing install (preserves user state)", false)
    .option(
      "--skip-remote",
      "skip remote_brain prompts; config.json will have remote_brain: null",
      false,
    )
    .option(
      "--persona <name>",
      "apply a SOUL persona preset after install (e.g. 'professional' | 'character')",
    )
    .option(
      "--cli-bridge <list>",
      `override auto-detected bridges: 'none' or a comma-separated subset of ${knownCLITargets().join(",")}`,
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
        persona?: string;
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
          persona: opts.persona,
          cliBridge: opts.cliBridge,
          dryRun: opts.dryRun === true,
          yes: opts.yes === true,
          dev: opts.dev === true,
        });
        process.exitCode = code;
      },
    );

  program
    .command("configure")
    .description(
      "FR-122: the opt-in onboarding verb — re-runnable dial of an EXISTING " +
        "install. Pick a SOUL persona, set identity, enable/disable the VPS by " +
        "address presence, and toggle perception/subconscious (nested cognition.* " +
        "keys). Seeds every prompt from live state so Enter keeps the current " +
        "value; --yes / non-TTY keeps current values (a no-op). Every config " +
        "write is atomic + chmod 600. Requires `igris init` to have run first.",
    )
    .option(
      "--persona <name>",
      "apply a SOUL persona preset (e.g. 'professional' | 'character'); skips the persona prompt",
    )
    .option(
      "--skip-remote",
      "skip the remote_brain (VPS) prompt; leave remote_brain unchanged",
      false,
    )
    .option(
      "--dry-run",
      "print the plan without performing any writes",
      false,
    )
    .option(
      "-y, --yes",
      "keep current values; skip prompts (a no-op on values)",
      false,
    )
    .action(
      async (opts: {
        persona?: string;
        skipRemote?: boolean;
        dryRun?: boolean;
        yes?: boolean;
      }): Promise<void> => {
        const code = await runConfigure({
          persona: opts.persona,
          skipRemote: opts.skipRemote === true,
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
      "switch to a different channel: 'main', a tag (e.g. 'v7.0.0'), or any branch (e.g. 'develop')",
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
    .description("Register a project with the brain (register-only; surfaces project globally at `igris init`)")
    .option(
      "--slug <slug>",
      "registry slug (default: basename of path)",
    )
    .option("--no-hooks", "accepted for back-compat; a no-op (hooks project globally at `igris init`)")
    .option(
      "--dry-run",
      "preview the planned writes without performing any",
      false,
    )
    .action(
      async (
        path: string,
        opts: {
          slug?: string;
          hooks?: boolean;
          dryRun?: boolean;
        },
      ): Promise<void> => {
        const code = await runInstall({
          path,
          slug: opts.slug,
          // commander turns --no-hooks into opts.hooks=false. Default is true.
          // FR-212d: install is register-only — installHooks is vestigial.
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
      "Write the brain registry row for <path> only (no .claude/, no hooks)",
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
    .option("--surface <kind>", "restrict to one projection surface: agents | skills | mcp | hook | all (compile only)")
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
    .command("loadout <action>", { hidden: true })
    .description(
      "Register Layer-2 personal customizations into the overlay (FR-141/FR-142/FR-143/FR-148/FR-162/FR-180). " +
        "Actions: add (copy-vendors the canonical files), add-skill (references a skills source dir into surfaces.skills), add-mcp (registers a global MCP server into surfaces.mcp_servers), add-hook (registers an event-hook block into surfaces.hooks + writes the loadout hook script), list, remove, update (re-vendors from origin). " +
        "--from accepts a local path OR github:owner/repo@<ref>[#subdir]. " +
        "For add-skill, the positional <source-dir> (or --from) is the live skills root and --target is type:method:path. " +
        "For add-mcp, --command + --target type:merge[:enabled] register a global MCP; --env values must be ${VAR} indirection refs (inline secrets rejected). " +
        "For add-hook, --event <Event> registers a config-merge hook block (--matcher / --timeout optional); the command lives under the loadout prefix so 'igris update' preserves it. " +
        "These add-* actions are WRITE-ONLY (no project/verify) — the one-step front door is 'igris add <surface>'.",
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
      "--event <event>",
      "hook event (add-hook): SessionStart | SessionEnd | PreToolUse | PostToolUse | PreCompact | PostCompact",
    )
    .option(
      "--matcher <glob>",
      "hook tool-name glob for Pre/PostToolUse (add-hook), e.g. 'Write|Edit'",
    )
    .option(
      "--timeout <n>",
      "hook timeout in seconds (add-hook; optional)",
    )
    .option(
      "--harness <type>",
      "INTERNAL (project-mcp/project-hook): which harness to project ONE entry into. Any declared harness id (`jq -r '.harnesses | keys[]' harness-manifest.json`); the run verb then narrows it to the harnesses that declare the surface — project-mcp to mcpTargetTypes(), project-hook to hookTargetTypes()",
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
    .option(
      "--source <abs-dir>",
      "INTERNAL (project-skills): absolute skills source root (the dir containing <name>/SKILL.md subfolders) — the FR-212a delegate arm shells this out to 'skills add'",
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
          source?: string;
          versionSource?: string;
          event?: string;
          matcher?: string;
          timeout?: string;
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
          info("loadout: --canonical is deprecated; use --from <path> instead.");
        }
        // FR-180: `loadout add-skill` survives as the low-level write-only
        // primitive (it does NOT project/verify), but `igris add skill` is now
        // the one-step front door. Steer the operator toward it. The deprecation
        // fires only at the CLI boundary — `runLoadout` stays clean for the
        // verb-level test suites (R7).
        if (action === "add-skill") {
          info(
            "loadout add-skill is write-only (it vendors/registers but does NOT " +
              "project or verify) — it is the low-level primitive. For the one-step " +
              "(vendor + project + verify) flow use 'igris add skill <name> --from <dir> --target …'.",
          );
        }
        // FR-180 (Phase 2): same write-only deprecation for the agent write
        // primitive `loadout add` — `igris add agent` is the one-step front door.
        if (action === "add") {
          info(
            "loadout add is write-only (it vendors/registers an agent but does NOT " +
              "project or verify) — it is the low-level primitive. For the one-step " +
              "(vendor + project + verify) flow use 'igris add agent <name> --from <dir> --target …'.",
          );
        }
        // FR-180 (Phase 3): same write-only deprecation for the MCP write
        // primitive `loadout add-mcp` — `igris add mcp` is the one-step front door.
        if (action === "add-mcp") {
          info(
            "loadout add-mcp is write-only (it registers the MCP block but does NOT " +
              "project or verify) — it is the low-level primitive. For the one-step " +
              "(register + project + verify) flow use 'igris add mcp <name> --command <bin> --target type:merge'.",
          );
        }
        // FR-180 (Phase 5): same write-only deprecation for the hook write
        // primitive `loadout add-hook` — `igris add hook` is the one-step front
        // door.
        if (action === "add-hook") {
          info(
            "loadout add-hook is write-only (it registers the hooks block + writes the " +
              "loadout hook script but does NOT project or verify) — it is the low-level " +
              "primitive. For the one-step (register + project + verify) flow use " +
              "'igris add hook <name> --event <Event>'.",
          );
        }
        // FR-143: `add-skill` takes its skills source-dir as the positional
        // arg (`igris loadout add-skill <source-dir> --target ...`); coalesce
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
        // FR-180 (Phase 5): add-hook + project-hook key on the block NAME.
        const isAddHook = action === "add-hook";
        // FR-164 project-mcp also keys on `--name` (the bash driver passes it
        // explicitly). Accept `--name <slug>` OR the positional, like add-mcp.
        const isProjectMcp = action === "project-mcp";
        const isProjectHook = action === "project-hook";
        // FR-212a: unproject-skills takes the skill name via --name (the bash
        // remove arm passes it). project-skills takes --source, not a name.
        const isUnprojectSkills = action === "unproject-skills";
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
              `loadout: --scope value '${opts.scope}' is not one of 'global' | 'project'\n`,
            );
            process.exitCode = 2;
            return;
          }
        }
        // FR-162: --startup-timeout-sec is a STRING from Commander. Validate the
        // numeric parse at the CLI boundary (mirror the --scope check above) so
        // LoadoutOptions.startupTimeoutSec stays typed `number` and the verb
        // can trust it. An invalid value is a usage error (exit 2).
        let startupTimeoutSec: number | undefined;
        if (opts.startupTimeoutSec !== undefined) {
          const n = Number(opts.startupTimeoutSec);
          if (!Number.isInteger(n)) {
            process.stderr.write(
              `loadout: --startup-timeout-sec value '${opts.startupTimeoutSec}' must be an integer\n`,
            );
            process.exitCode = 2;
            return;
          }
          startupTimeoutSec = n;
        }
        // FR-180 (Phase 5): --timeout is a STRING from Commander (add-hook).
        // Validate the numeric parse at the CLI boundary so LoadoutOptions
        // .timeout stays typed `number`. An invalid value is a usage error.
        let timeoutArg: number | undefined;
        if (opts.timeout !== undefined) {
          const n = Number(opts.timeout);
          if (!Number.isInteger(n)) {
            process.stderr.write(
              `loadout: --timeout value '${opts.timeout}' must be an integer\n`,
            );
            process.exitCode = 2;
            return;
          }
          timeoutArg = n;
        }
        // --harness must be a known harness SHAPE id. Validate at the CLI
        // boundary (mirror --scope) so LoadoutOptions.harness stays typed (the
        // explicit literal chain narrows to McpHarness — a descriptor
        // `.includes()` check would not). The PRECISE per-surface set is enforced
        // downstream by each run* verb (project-mcp/verify-mcp-grant →
        // mcpTargetTypes(); project-hook → hookTargetTypes(); FR-192: cursor is
        // an mcp + grant harness but NOT a hook harness, so project-hook rejects
        // it there). An unknown value is a usage error (exit 2).
        let harnessArg: McpHarness | undefined;
        if (opts.harness !== undefined) {
          if (
            opts.harness === "claude" ||
            opts.harness === "codex" ||
            opts.harness === "gemini" ||
            opts.harness === "opencode" ||
            opts.harness === "antigravity" ||
            opts.harness === "cursor"
          ) {
            harnessArg = opts.harness;
          } else {
            process.stderr.write(
              `loadout: --harness value '${opts.harness}' is not one of 'claude' | 'codex' | 'gemini' | 'opencode' | 'antigravity' | 'cursor'\n`,
            );
            process.exitCode = 2;
            return;
          }
        }
        const code = await runLoadout({
          action: action as LoadoutAction,
          name:
            isAddSkill ||
            isAddMcp ||
            isAddHook ||
            isProjectMcp ||
            isProjectHook ||
            isUnprojectSkills
              ? (opts.name ?? name)
              : name,
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
          // FR-180 (Phase 5): add-hook event / matcher / timeout.
          event: opts.event,
          matcher: opts.matcher,
          timeout: timeoutArg,
          harness: harnessArg,
          // FR-164 project-mcp: --overlay maps to the overlayPath seam
          // (the bash compile/drift driver passes the resolved overlay).
          overlayPath: opts.overlay,
          configPath: opts.configPath,
          secretsPath: opts.secretsPath,
          // FR-212a project-skills: the absolute skills source root the delegate
          // arm shells out to `skills add`.
          source: opts.source,
        });
        process.exitCode = code;
      },
    );

  program
    .command("add <surface> [name]")
    .description(
      "FR-180: one-step add of a surface (skill | agent | mcp | hook) — " +
        "materializes (vendor/register for personal, write core/ for core), projects " +
        "to every harness whose descriptor declares that surface (skills/mcp: every " +
        "harness with an agent_id; agents: every harness with an 'agents' block; " +
        "hooks: every harness with hooks.supported true — run " +
        "`jq -r '.harnesses | keys[]' harness-manifest.json` to re-derive the roster), " +
        "AND verifies drift-clean. " +
        "Never silently no-ops (TD-235). Core-vs-personal is auto-detected (igris-ai " +
        "checkout = core) and overridable with --core / --no-core; the resolved mode is " +
        "always printed. ALL FOUR surfaces (skill, agent, mcp, hook) ship " +
        "end-to-end. For mcp use --command + --target type:merge[:enabled] (--env values " +
        "must be ${VAR} indirection refs — inline secrets are rejected). " +
        "For hook use --event <Event> (the command merges into .claude/settings.json " +
        "and survives 'igris update'/'doctor --fix'). The low-level 'igris loadout add-* + " +
        "igris harness compile' two-step survives as the repair primitive.",
    )
    .option("--from <path-or-github>", "source dir / github ref (skill/agent/mcp)")
    .option(
      "--target <type:...>",
      "output target (skill: type:method:path; agent: type:path; mcp: type:merge[:enabled]; repeatable)",
      collect,
      [],
    )
    .option("--name <slug>", "surface name (alternative to the positional [name])")
    // Commander pairs `--core` with `--no-core`: opts.core is `undefined` (no
    // flag → auto-detect), `true` (--core), or `false` (--no-core). NO default
    // is set so the three-state distinction survives.
    .option("--core", "force CORE mode — edit the igris-ai checkout (wins over auto-detect)")
    .option("--no-core", "force PERSONAL mode (wins over auto-detect)")
    .option(
      "--project-root <dir>",
      "root for core auto-detect + project+verify (default: cwd)",
    )
    .option(
      "--harness <type>",
      "restrict projection to one harness — any declared harness id (`jq -r '.harnesses | keys[]' harness-manifest.json`); a harness that does not declare the surface projects nothing",
    )
    // FR-180 Phase 3: MCP launch options (the `mcp` arm — same surface as
    // `loadout add-mcp`). --env values MUST be ${VAR} indirection refs.
    .option("--command <bin>", "MCP launch command (add mcp); REQUIRED for a new MCP")
    .option("--arg <value>", "MCP launch arg (add mcp; repeatable)", collect, [])
    .option(
      "--env <KEY=${VAR}>",
      "MCP env var as an indirection ref (add mcp; repeatable). VALUE must be a single ${VAR} reference — inline secrets are rejected.",
      collect,
      [],
    )
    .option(
      "--startup-timeout-sec <n>",
      "MCP startup timeout in seconds (add mcp; Codex-only passthrough)",
    )
    // FR-180 Phase 5: hook options (the `hook` arm).
    .option(
      "--event <event>",
      "hook event (add hook): SessionStart | SessionEnd | PreToolUse | PostToolUse | PreCompact | PostCompact",
    )
    .option(
      "--matcher <glob>",
      "hook tool-name glob for Pre/PostToolUse (add hook), e.g. 'Write|Edit'",
    )
    .option(
      "--timeout <n>",
      "hook timeout in seconds (add hook; optional passthrough)",
    )
    .action(
      async (
        surface: string,
        name: string | undefined,
        opts: {
          from?: string;
          target?: string[];
          name?: string;
          core?: boolean;
          projectRoot?: string;
          harness?: string;
          command?: string;
          arg?: string[];
          env?: string[];
          startupTimeoutSec?: string;
          source?: string;
          versionSource?: string;
          event?: string;
          matcher?: string;
          timeout?: string;
        },
      ): Promise<void> => {
        // FR-180 Phase 3: --startup-timeout-sec is a STRING from Commander.
        // Validate the numeric parse at the CLI boundary (mirror the
        // `loadout add-mcp` check) so AddOptions.startupTimeoutSec stays typed.
        let startupTimeoutSec: number | undefined;
        if (opts.startupTimeoutSec !== undefined) {
          const n = Number(opts.startupTimeoutSec);
          if (!Number.isInteger(n)) {
            process.stderr.write(
              `add: --startup-timeout-sec value '${opts.startupTimeoutSec}' must be an integer\n`,
            );
            process.exitCode = 2;
            return;
          }
          startupTimeoutSec = n;
        }
        // FR-180 Phase 5: --timeout is a STRING from Commander; validate at the
        // CLI boundary so AddOptions.timeout stays typed.
        let timeout: number | undefined;
        if (opts.timeout !== undefined) {
          const n = Number(opts.timeout);
          if (!Number.isInteger(n)) {
            process.stderr.write(
              `add: --timeout value '${opts.timeout}' must be an integer\n`,
            );
            process.exitCode = 2;
            return;
          }
          timeout = n;
        }
        const code = await runAdd({
          surface,
          name: opts.name ?? name,
          from: opts.from,
          targets: opts.target,
          // Commander maps `--no-core` to `core: false`; `--core` to `core: true`;
          // neither flag → `core: undefined`. Distinguish the three states so
          // auto-detect runs only when the operator passed no flag.
          core: opts.core === true ? true : undefined,
          noCore: opts.core === false ? true : undefined,
          projectRoot: opts.projectRoot,
          target: opts.harness,
          // FR-180 Phase 3: MCP launch options.
          command: opts.command,
          args: opts.arg,
          env: opts.env,
          startupTimeoutSec,
          // FR-180 Phase 5: hook options.
          event: opts.event,
          matcher: opts.matcher,
          timeout,
        });
        process.exitCode = code;
      },
    );

  program
    .command("remove <surface> [name]")
    .description(
      "FR-203: the symmetric inverse of `igris add` — one-step removal of a " +
        "surface (skill | agent | mcp | hook). UN-PROJECTS from every harness " +
        "the surface actually REACHED — never the whole roster: skills/mcp from " +
        "every harness with an agent_id, agents from the entry's own targets[], " +
        "hooks from every harness with hooks.supported true (run " +
        "`jq -r '.harnesses | keys[]' harness-manifest.json` to re-derive the " +
        "roster). Deletes the loadout-anchored symlink/hardlink, un-merges the " +
        "named native-config block, de-materializes from the loadout (personal) / " +
        "deletes the core/ source + un-sweeps the §13 enumeration surfaces (core), " +
        "then VERIFIES the surface is ABSENT (drift-clean = removed). Core-vs-" +
        "personal is auto-detected and overridable with --core / --no-core; the " +
        "resolved mode is always printed. DESTRUCTIVE: prints exactly what will be " +
        "de-projected and asks for confirmation unless --yes. A removal that finds " +
        "nothing to remove is a LOUD FAIL (never a phantom success). For hook pass " +
        "--event <Event> (recovered from the store when omitted). Refuses to remove " +
        "a builtin agent without --force.",
    )
    .option("--name <slug>", "surface name (alternative to the positional [name])")
    // Commander pairs `--core` with `--no-core` (three-state: undefined/true/false).
    .option("--core", "force CORE mode — edit the igris-ai checkout (wins over auto-detect)")
    .option("--no-core", "force PERSONAL mode (wins over auto-detect)")
    .option(
      "--project-root <dir>",
      "root for core auto-detect + un-project + verify (default: cwd)",
    )
    .option(
      "--harness <type>",
      "restrict un-projection to one harness — any declared harness id (`jq -r '.harnesses | keys[]' harness-manifest.json`); a harness the surface never reached un-projects nothing",
    )
    .option(
      "--event <event>",
      "hook event (remove hook): SessionStart | SessionEnd | PreToolUse | PostToolUse | PreCompact | PostCompact (recovered from the store when omitted)",
    )
    .option("--yes", "skip the destructive confirmation prompt (scripted / round-trip use)")
    .option("--force", "force-remove a builtin agent (load-bearing in delegation)")
    .action(
      async (
        surface: string,
        name: string | undefined,
        opts: {
          name?: string;
          core?: boolean;
          projectRoot?: string;
          harness?: string;
          event?: string;
          yes?: boolean;
          force?: boolean;
        },
      ): Promise<void> => {
        const code = await runRemove({
          surface,
          name: opts.name ?? name,
          // Commander maps `--no-core`→`core:false`, `--core`→`core:true`,
          // neither→`undefined`. Distinguish the three states (mirror `add`).
          core: opts.core === true ? true : undefined,
          noCore: opts.core === false ? true : undefined,
          projectRoot: opts.projectRoot,
          target: opts.harness,
          event: opts.event,
          yes: opts.yes,
          force: opts.force,
        });
        process.exitCode = code;
      },
    );

  program
    .command("detect", { hidden: true })
    .description(
      "FR-195: L0 capability detection. Prints a JSON digest (harness, brain_db, sqlite3, remote_brain, mode) the awaken skill reads. Exit 0 even when degraded.",
    )
    .option("--json", "emit the digest as JSON to stdout (default; on for the awaken path)", true)
    .action((opts: { json?: boolean }): void => {
      const code = runDetect({ json: opts.json !== false });
      process.exitCode = code;
    });

  program
    .command("onboarding <action>", { hidden: true })
    .description(
      "FR-235: first-run onboarding state. Actions: status (print {completed, boot_welcomed, first_run} JSON — first_run = !completed), welcomed (stamp onboarding.boot_welcomed=true), complete (stamp onboarding.completed=true). Config-absent degrades to first_run:true. Exit 0 for all three actions; unknown action → exit 2. Read by the /boot Welcome + /setup skill.",
    )
    .option("--json", "emit the status digest as JSON to stdout (default; on for the boot/setup path)", true)
    .action((action: string, opts: { json?: boolean }): void => {
      const code = runOnboarding(action, { json: opts.json !== false });
      process.exitCode = code;
    });

  program
    .command("boot-sync", { hidden: true })
    .description(
      "FR-195: the REMOTE channel (SKILL.md §3.6). Drains the local sync queue (reusing the `sync data` primitive) AND pulls VPS→local rows over GET /sync/pull, merging them last-write-wins into the LOCAL brain DB (the directionally-correct reproduction of igris_brain_pull). Each part is independent + skip-on-fail. Prints a JSON digest. Exit 0 even when degraded (remote unconfigured/unreachable = local-only run, never blocks).",
    )
    .option(
      "--project <slug>",
      "project slug for the queue path (default: basename of cwd)",
    )
    .option("--json", "emit the digest as JSON to stdout (default; on for the awaken path)", true)
    .action(
      async (opts: { project?: string; json?: boolean }): Promise<void> => {
        const code = await runBootSync({
          project: opts.project,
          json: opts.json !== false,
        });
        process.exitCode = code;
      },
    );

  program
    .command("session <action>", { hidden: true })
    .description(
      "FR-195/FR-190: session-lifecycle verbs. Actions: gather (the Lock-2/3 classifier — enumerate + classify session files against per-instance liveness metadata, pick THE handoff); register (instance metadata upsert + write the LIVE per-instance file, seeded from the handoff). Prints a JSON digest to stdout. Unknown action → exit 2.",
    )
    .option(
      "--project <slug>",
      "project slug (default: basename of cwd)",
    )
    .option(
      "--self-instance-id <id>",
      "gather: this harness's recovered prior instance id (G4); register: the id to refresh (recover) — omit to mint a fresh UUID",
    )
    .option(
      "--project-path <path>",
      "register: absolute path to the project directory (instance row project_path)",
    )
    .option(
      "--seed-next-steps <text>",
      "register: the chosen handoff's resume content to seed the LIVE file's Next Steps (the resume carry-forward)",
    )
    .option("--json", "emit the digest as JSON to stdout (default; on for the awaken path)", true)
    .action(
      (
        action: string,
        opts: {
          project?: string;
          selfInstanceId?: string;
          projectPath?: string;
          seedNextSteps?: string;
          json?: boolean;
        },
      ): void => {
        const code = runSession({
          action: action as SessionAction,
          project: opts.project,
          selfInstanceId: opts.selfInstanceId,
          projectPath: opts.projectPath,
          seedNextSteps: opts.seedNextSteps,
          json: opts.json !== false,
        });
        process.exitCode = code;
      },
    );

  program
    .command("instance <action>", { hidden: true })
    .description(
      "FR-190/TD-277: explicit instance lifecycle verbs. Actions: list (classify local liveness), state (update display/lease state), deregister (remove a cleanly closed instance). Activity time is not a liveness primitive.",
    )
    .option(
      "--project <slug>",
      "project slug (default: basename of cwd)",
    )
    .option("--instance-id <id>", "instance id for state/deregister")
    .option("--current-brief <id>", "state: currently reserved/active brief id")
    .option("--current-phase <phase>", "state: current workflow phase")
    .option("--current-task <text>", "state: current task description")
    .option(
      "--lease-minutes <minutes>",
      "state: renew the cross-machine work lease for this many minutes; <=0 clears it",
    )
    .option("--json", "emit the digest as JSON to stdout (default)", true)
    .action(
      (
        action: string,
        opts: {
          project?: string;
          instanceId?: string;
          currentBrief?: string;
          currentPhase?: string;
          currentTask?: string;
          leaseMinutes?: string;
          json?: boolean;
        },
      ): void => {
        const leaseMinutes =
          opts.leaseMinutes === undefined
            ? undefined
            : Number.parseInt(opts.leaseMinutes, 10);
        const code = runInstance({
          action: action as InstanceAction,
          project: opts.project,
          instanceId: opts.instanceId,
          currentBrief: opts.currentBrief,
          currentPhase: opts.currentPhase,
          currentTask: opts.currentTask,
          leaseMinutes,
          json: opts.json !== false,
        });
        process.exitCode = code;
      },
    );

  program
    .command("housekeeping", { hidden: true })
    .description(
      "FR-195: the crash-robust, idempotent archive sweep (SKILL.md §3.8 H0–H3). Retires the legacy CURRENT_SESSION.md, archives superseded RESTED files, rolls >30d archive files into month digests, and applies the 150-file ceiling. Touches only session/archive/ + the RESTED set — never LIVE files, never the brief DB. Prints a JSON digest. Exit 0 even when degraded.",
    )
    .option(
      "--project <slug>",
      "project slug (default: basename of cwd)",
    )
    .option(
      "--roll-days <n>",
      "30-day digest-roll window override (tunable knob; default 30)",
    )
    .option(
      "--ceiling <n>",
      "individual-file ceiling before the H3 burst valve fires (default 150)",
    )
    .option("--json", "emit the digest as JSON to stdout (default; on for the awaken path)", true)
    .action(
      (opts: {
        project?: string;
        rollDays?: string;
        ceiling?: string;
        json?: boolean;
      }): void => {
        // --roll-days / --ceiling are STRINGS from Commander; parse + validate
        // at the CLI boundary (mirror the loadout numeric-arg checks).
        let rollDays: number | undefined;
        if (opts.rollDays !== undefined) {
          const n = Number(opts.rollDays);
          if (!Number.isInteger(n) || n < 0) {
            process.stderr.write(
              `housekeeping: --roll-days value '${opts.rollDays}' must be a non-negative integer\n`,
            );
            process.exitCode = 2;
            return;
          }
          rollDays = n;
        }
        let ceiling: number | undefined;
        if (opts.ceiling !== undefined) {
          const n = Number(opts.ceiling);
          if (!Number.isInteger(n) || n < 0) {
            process.stderr.write(
              `housekeeping: --ceiling value '${opts.ceiling}' must be a non-negative integer\n`,
            );
            process.exitCode = 2;
            return;
          }
          ceiling = n;
        }
        const code = runHousekeeping({
          project: opts.project,
          rollDays,
          ceiling,
          json: opts.json !== false,
        });
        process.exitCode = code;
      },
    );

  program
    .command("assess", { hidden: true })
    .description(
      "FR-195: the MINIMAL system-assessment digest (D-A). Brief-status summary counts + active blockers (session/BLOCKERS.md) + git snapshot + active-instance count + upcoming goals (14d). Deliberately omits the task queue, perception pending, and cross-project recall. Prints a JSON digest. Exit 0 even when degraded.",
    )
    .option(
      "--project <slug>",
      "project slug (default: basename of cwd)",
    )
    .option("--json", "emit the digest as JSON to stdout (default; on for the awaken path)", true)
    .action((opts: { project?: string; json?: boolean }): void => {
      const code = runAssess({
        project: opts.project,
        json: opts.json !== false,
      });
      process.exitCode = code;
    });

  program
    .command("context-docs <action>", { hidden: true })
    .description(
      "FR-209: inspect shared context-doc catalog coverage for one project. Action: inventory.",
    )
    .requiredOption("--project <slug>", "project slug to inventory")
    .option("--json", "emit a machine-readable digest instead of markdown", false)
    .action(
      (
        action: string,
        opts: { project: string; json?: boolean },
      ): void => {
        const code = runContextDocs({
          action: action as ContextDocsAction,
          project: opts.project,
          json: opts.json === true,
        });
        process.exitCode = code;
      },
    );

  program
    .command("cognition <action>", { hidden: true })
    .description(
      "TD-327 / TD-423: per-instance liveness and yield for the cognition subsystem. Actions: health, yield. BOTH derive their roster from the brain's projected extractor registry (cognition_instances), never a hand-list — a new extractor appears in each with no edit. health answers \"is it running?\"; yield answers \"is what it produces worth anything?\" from each instance's declared `produced` identity predicate: rows produced, judged, kept, and the pending-queue share. Every yield rate carries its numerator, denominator and a denominator LABEL, and reads null — never 0 — over an empty denominator; an instance with no verdicts reports unmeasured. Expiry is separated from judgment, so an expired row is never a rejection. Reads are read-only and LOCAL (igris_event_log routes to the remote and would miss local-only runs). Full account: docs/COGNITION.md. Prints a JSON digest. Exit 0 even when degraded; unknown action → exit 2.",
    )
    .option("--json", "emit the digest as JSON to stdout (default; on for the boot path)", true)
    .action((action: string, opts: { json?: boolean }): void => {
      process.exitCode = runCognition({
        action,
        json: opts.json !== false,
      });
    });

  program
    .command("ceremony <action>", { hidden: true })
    .description(
      "FR-268: brain-timed ceremony stamps. Actions: start, stop. Writes ceremony_events through the local write door (create-never); created_at is the DB clock and duration_ms is SQL-computed on stop from the paired open start — never caller-supplied. The four ceremony skills call this as their first and last executable step. Prints a JSON digest. Exit 0 even when degraded; unknown action/name → exit 2.",
    )
    .option("--name <ceremony>", "boot | rest | register | hunt-init")
    .option("--project <slug>", "project slug (default: basename of cwd)")
    .option("--instance-id <id>", "instance id when known (boot's start predates the mint — omit there)")
    .option("--brief <id>", "brief id (register / hunt-init)")
    .option("--json", "emit the digest as JSON to stdout (default)", true)
    .action(
      (
        action: string,
        opts: { name?: string; project?: string; instanceId?: string; brief?: string; json?: boolean },
      ): void => {
        process.exitCode = runCeremony({
          action,
          name: opts.name,
          project: opts.project,
          instanceId: opts.instanceId,
          brief: opts.brief,
          json: opts.json !== false,
        });
      },
    );

  // FR-268 — a REPORTING verb (markdown by default), visible: the operator
  // asks it directly; /ops renders it whole and /scan renders its --alarm line.
  program
    .command("kpi")
    .description(
      "FR-268: the seven OS KPIs (capacity, throughput, effort mix, minutes per hunt by phase, rounds per hunt, model per role, ceremony cost) computed on read from the brain's records — hunt_runs, brief_status, ceremony_runs. Weeks are Monday–Sunday UTC. Read-only. --sql prints the derivations for sqlite3; --alarm prints the one-line week-over-week reading /scan shows. Exit 0 even when degraded.",
    )
    .option("--project <slug>", "scope to one project (default: all; --alarm defaults to the cwd basename)")
    .option("--weeks <n>", "how many UTC weeks back, counting the current partial one", "4")
    .option("--json", "emit the digest as JSON", false)
    .option("--sql", "print the seven derivations verbatim and exit", false)
    .option("--alarm", "print the one-line alarm: last complete week vs the one before", false)
    .action((opts: { project?: string; weeks?: string; json?: boolean; sql?: boolean; alarm?: boolean }): void => {
      process.exitCode = runKpi({
        project: opts.project,
        weeks: opts.weeks === undefined ? undefined : Number.parseInt(opts.weeks, 10),
        json: opts.json === true,
        sql: opts.sql === true,
        alarm: opts.alarm === true,
      });
    });

  // FR-238 — the CLI's first LONG-LIVED verb. Visible (not hidden): the
  // dashboard is a product surface, not an internal boot-lifecycle step.
  // NOTE the lifecycle exception: `runDashboard` does not resolve until a
  // signal arrives, so `process.exitCode` is set after the await rather than
  // synchronously. That is the whole point of a foreground server.
  program
    .command("dashboard")
    .description(
      "FR-238/FR-241: start the local IGRIS dashboard — a loopback-only server " +
        "(127.0.0.1) " +
        "serving a live lens over the brain, and open it in the browser. " +
        "Every GET changes no row; since FR-241 one endpoint (POST /api/triage) " +
        "writes — it triages cognition suggestions and perception candidates, " +
        "and rejecting a first-time candidate DELETES it. Runs in the " +
        "foreground; Ctrl-C stops it. A second invocation re-opens the running " +
        "instance instead of binding a second port.",
    )
    .option(
      "--port <n>",
      "exact port to bind. Without this the verb tries 7317, then an OS-assigned port. An explicit port that is taken is a hard failure — explicit intent is never silently reassigned.",
    )
    .option("--no-open", "do not launch a browser")
    .option("--smoke", "hidden self-check: start, probe, print a JSON digest, exit", false)
    .action(async (opts: { port?: string; open?: boolean; smoke?: boolean }) => {
      let port: number | undefined;
      if (opts.port !== undefined) {
        port = Number.parseInt(opts.port, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          logError(`dashboard: --port must be an integer 1-65535 (got "${opts.port}")`);
          process.exitCode = 2;
          return;
        }
      }
      process.exitCode = await runDashboard({
        port,
        noOpen: opts.open === false,
        smoke: opts.smoke === true,
        cliVersion: readPackageVersion(),
      });
    });

  program
    .command("export <project>")
    .description(
      "FR-229: serialize ONE project's brain slice into a portable, self-" +
        "describing <slug>.igris-pack.tar.gz (the handoff PRODUCER; no import/merge). " +
        "Tiers: core (brief_status + brief_files), standard (DEFAULT — core + " +
        "brief↔brief edges + goals + context docs), full (standard + approved " +
        "learnings + errors + project concept-graph). --include adds named stores " +
        "on top of the tier; --since filters rows by each store's timestamp. " +
        "Egress paths are redacted and the manifest omits the project's absolute " +
        "path. A missing brain DB is a hard failure (exit 1).",
    )
    .option(
      "--out <path>",
      "output archive path (default: ./<slug>.igris-pack.tar.gz)",
    )
    .option(
      "--tier <tier>",
      "export tier: core | standard | full (default: standard)",
    )
    .option(
      "--include <stores...>",
      "extra store names to include on top of the tier (space-separated)",
    )
    .option(
      "--since <date>",
      "only export rows at/after this cutoff (per each store's timestamp column)",
    )
    .option("--json", "emit the JSON digest to stdout (default on)", true)
    .action(
      async (
        project: string,
        opts: {
          out?: string;
          tier?: string;
          include?: string[];
          since?: string;
          json?: boolean;
        },
      ): Promise<void> => {
        const code = await runExport({
          project,
          out: opts.out,
          tier: opts.tier as ExportTier | undefined,
          include: opts.include,
          since: opts.since,
          json: opts.json !== false,
        });
        process.exitCode = code;
      },
    );

  program
    .command("import <bundle>")
    .description(
      "FR-230: import ONE project's brain slice from a portable .igris-pack.tar.gz " +
        "(the handoff CONSUMER; the FR-229 producer's ingress twin). Verifies the " +
        "checksum, rejects executable-surface stores, then classifies every row " +
        "NEW/UNCHANGED/INCOMING/LOCAL_ONLY/CONFLICT via an ancestor-based 3-way " +
        "compare (NOT timestamp LWW) and applies the chosen --on-conflict policy in " +
        "ONE transaction. Always --dry-run first. --on-conflict: ask (DEFAULT, " +
        "interactive) | theirs | mine | newer. --as <slug> imports under a different " +
        "project slug. Provenance/ancestor/idempotency live in a CLI-local ledger. A " +
        "corrupt/tampered bundle or missing brain DB is a hard failure (exit 1).",
    )
    .option("--dry-run", "classify + preview only; write NOTHING to the DB", false)
    .option(
      "--on-conflict <policy>",
      "conflict policy: ask | theirs | mine | newer (default: ask)",
    )
    .option("--as <slug>", "import under this project slug (rewrites the scope key)")
    .option(
      "--project-path <path>",
      "path recorded when auto-registering a new project row (default: cwd)",
    )
    .option("--json", "emit the JSON digest to stdout (default on)", true)
    .action(
      async (
        bundle: string,
        opts: {
          dryRun?: boolean;
          onConflict?: string;
          as?: string;
          projectPath?: string;
          json?: boolean;
        },
      ): Promise<void> => {
        const code = await runImport({
          bundle,
          dryRun: opts.dryRun === true,
          onConflict: opts.onConflict as OnConflictPolicy | undefined,
          as: opts.as,
          projectPath: opts.projectPath,
          json: opts.json !== false,
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
