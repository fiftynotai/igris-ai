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
import { runAdd } from "./verbs/add.js";
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
    .option("--surface <kind>", "restrict to one projection surface: agents | skills | mcp | identity | all (compile only)")
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
      "Register Layer-2 personal customizations into the overlay (FR-141/FR-142/FR-143/FR-148/FR-162/FR-180). " +
        "Actions: add (copy-vendors the canonical files), add-skill (references a skills source dir into surfaces.skills), add-mcp (registers a global MCP server into surfaces.mcp_servers), add-identity (registers a project-scoped os_identity block into surfaces.os_identity), add-hook (registers an event-hook block into surfaces.hooks + writes the registry hook script), list, remove, update (re-vendors from origin). " +
        "--from accepts a local path OR github:owner/repo@<ref>[#subdir]. " +
        "For add-skill, the positional <source-dir> (or --from) is the live skills root and --target is type:method:path. " +
        "For add-mcp, --command + --target type:merge[:enabled] register a global MCP; --env values must be ${VAR} indirection refs (inline secrets rejected). " +
        "For add-identity, --target type:file:filename registers a region-merge identity block (--source / --version-source override the canonical template / version source). " +
        "For add-hook, --event <Event> registers a config-merge hook block (--matcher / --timeout optional); the command lives under the registry prefix so 'igris update' preserves it. " +
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
      "--source <path>",
      "identity canonical-template path (add-identity; default <brain>/core/templates/identity.tmpl)",
    )
    .option(
      "--version-source <path>",
      "identity {{IGRIS_VERSION}} source path (add-identity; default <brain>/config.json)",
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
      "INTERNAL (project-mcp/project-hook): which harness to project ONE entry into: claude | codex | gemini | opencode",
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
          info("registry: --canonical is deprecated; use --from <path> instead.");
        }
        // FR-180: `registry add-skill` survives as the low-level write-only
        // primitive (it does NOT project/verify), but `igris add skill` is now
        // the one-step front door. Steer the operator toward it. The deprecation
        // fires only at the CLI boundary — `runRegistry` stays clean for the
        // verb-level test suites (R7).
        if (action === "add-skill") {
          info(
            "registry add-skill is write-only (it vendors/registers but does NOT " +
              "project or verify) — it is the low-level primitive. For the one-step " +
              "(vendor + project + verify) flow use 'igris add skill <name> --from <dir> --target …'.",
          );
        }
        // FR-180 (Phase 2): same write-only deprecation for the agent write
        // primitive `registry add` — `igris add agent` is the one-step front door.
        if (action === "add") {
          info(
            "registry add is write-only (it vendors/registers an agent but does NOT " +
              "project or verify) — it is the low-level primitive. For the one-step " +
              "(vendor + project + verify) flow use 'igris add agent <name> --from <dir> --target …'.",
          );
        }
        // FR-180 (Phase 3): same write-only deprecation for the MCP write
        // primitive `registry add-mcp` — `igris add mcp` is the one-step front door.
        if (action === "add-mcp") {
          info(
            "registry add-mcp is write-only (it registers the MCP block but does NOT " +
              "project or verify) — it is the low-level primitive. For the one-step " +
              "(register + project + verify) flow use 'igris add mcp <name> --command <bin> --target type:merge'.",
          );
        }
        // FR-180 (Phase 4): same write-only deprecation for the identity write
        // primitive `registry add-identity` — `igris add identity` is the one-step
        // front door.
        if (action === "add-identity") {
          info(
            "registry add-identity is write-only (it registers the os_identity block but " +
              "does NOT project or verify) — it is the low-level primitive. For the one-step " +
              "(register + project + verify) flow use 'igris add identity <name> --target type:file:filename'.",
          );
        }
        // FR-180 (Phase 5): same write-only deprecation for the hook write
        // primitive `registry add-hook` — `igris add hook` is the one-step front
        // door.
        if (action === "add-hook") {
          info(
            "registry add-hook is write-only (it registers the hooks block + writes the " +
              "registry hook script but does NOT project or verify) — it is the low-level " +
              "primitive. For the one-step (register + project + verify) flow use " +
              "'igris add hook <name> --event <Event>'.",
          );
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
        // FR-180 (Phase 4): add-identity uses the positional/`--name` as a LABEL
        // (the os_identity block has no name field). Accept either form, like add-mcp.
        const isAddIdentity = action === "add-identity";
        // FR-180 (Phase 5): add-hook + project-hook key on the block NAME.
        const isAddHook = action === "add-hook";
        // FR-164 project-mcp also keys on `--name` (the bash driver passes it
        // explicitly). Accept `--name <slug>` OR the positional, like add-mcp.
        const isProjectMcp = action === "project-mcp";
        const isProjectHook = action === "project-hook";
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
        // FR-180 (Phase 5): --timeout is a STRING from Commander (add-hook).
        // Validate the numeric parse at the CLI boundary so RegistryOptions
        // .timeout stays typed `number`. An invalid value is a usage error.
        let timeoutArg: number | undefined;
        if (opts.timeout !== undefined) {
          const n = Number(opts.timeout);
          if (!Number.isInteger(n)) {
            process.stderr.write(
              `registry: --timeout value '${opts.timeout}' must be an integer\n`,
            );
            process.exitCode = 2;
            return;
          }
          timeoutArg = n;
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
          name:
            isAddSkill ||
            isAddMcp ||
            isAddIdentity ||
            isAddHook ||
            isProjectMcp ||
            isProjectHook
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
          // FR-180 (Phase 4): add-identity template / version-source overrides.
          identitySource: opts.source,
          identityVersionSource: opts.versionSource,
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
        });
        process.exitCode = code;
      },
    );

  program
    .command("add <surface> [name]")
    .description(
      "FR-180: one-step add of a surface (skill | agent | mcp | hook | identity) — " +
        "materializes (vendor/register for personal, write core/ for core), projects " +
        "to all four harnesses (claude/gemini/codex/opencode), AND verifies drift-clean. " +
        "Never silently no-ops (TD-235). Core-vs-personal is auto-detected (igris-ai " +
        "checkout = core) and overridable with --core / --no-core; the resolved mode is " +
        "always printed. ALL FIVE surfaces (skill, agent, mcp, identity, hook) ship " +
        "end-to-end. For mcp use --command + --target type:merge[:enabled] (--env values " +
        "must be ${VAR} indirection refs — inline secrets are rejected). For identity use " +
        "--target type:file:filename (a region-merge into the harness's auto-read identity " +
        "file). For hook use --event <Event> (the command merges into .claude/settings.json " +
        "and survives 'igris update'/'doctor --fix'). The low-level 'igris registry add-* + " +
        "igris harness compile' two-step survives as the repair primitive.",
    )
    .option("--from <path-or-github>", "source dir / github ref (skill/agent/mcp)")
    .option(
      "--target <type:...>",
      "output target (skill: type:method:path; agent: type:path; mcp: type:merge[:enabled]; identity: type:file:filename; repeatable)",
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
      "restrict projection to one harness: claude | codex | gemini | opencode",
    )
    // FR-180 Phase 3: MCP launch options (the `mcp` arm — same surface as
    // `registry add-mcp`). --env values MUST be ${VAR} indirection refs.
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
    // FR-180 Phase 4: identity options (the `identity` arm). Targets reuse the
    // shared --target flag with the type:file:filename grammar.
    .option(
      "--source <path>",
      "identity canonical-template path (add identity; default <brain>/core/templates/identity.tmpl)",
    )
    .option(
      "--version-source <path>",
      "identity {{IGRIS_VERSION}} source path (add identity; default <brain>/config.json)",
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
        // `registry add-mcp` check) so AddOptions.startupTimeoutSec stays typed.
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
          // FR-180 Phase 4: identity options.
          identitySource: opts.source,
          identityVersionSource: opts.versionSource,
          // FR-180 Phase 5: hook options.
          event: opts.event,
          matcher: opts.matcher,
          timeout,
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
