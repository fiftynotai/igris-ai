/**
 * `igris init [--from-source <path>] [--channel <ref>] [--upgrade]
 *             [--skip-remote] [--cli-bridge <list|none>] [--dry-run]
 *             [--yes]`
 *
 * Bootstrap a fresh `~/.igris/` (or upgrade an existing v6 install).
 *
 * Sequence (per Plan §3 M1.10 + brief Architecture):
 *
 *   1. Pre-flight: Node version, network reachability, install shape.
 *   2. Directory tree: create ~/.igris/{memory,projects,logs,.cache}/.
 *   3. Brain core fetch (or --from-source copy).
 *   4. Atomic swap: stage at core.new.<pid>/, swap, optional bak.
 *   5. DB init: ensure ~/.igris/memory/knowledge.db opens.
 *   6. Templates: write USER.md and config.json (preserve on upgrade).
 *   7. CLI bridges: detect + apply --cli-bridge override + materialize.
 *   8. .install-source.json: persist channel, ref, content_sha256.
 *
 * --upgrade preservation contract (Risk #5 critical):
 *   - knowledge.db                           — preserved byte-for-byte
 *   - USER.md (if it exists pre-upgrade)     — preserved byte-for-byte
 *   - config.json (if it exists pre-upgrade) — preserved byte-for-byte
 *
 * --dry-run: every would-be side effect routes through DryRunCollector;
 * zero filesystem writes; zero network calls beyond the channel HEAD.
 *
 * Returns process exit code (0 = success, non-zero = failure).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AtomicExtractError,
  atomicSwap,
  stagingDirFor,
} from "../lib/atomic-extract.js";
import { cacheStore, TTL_INFINITE, TTL_MAIN_MS } from "../lib/cache.js";
import {
  ChannelResolveError,
  resolveChannel,
} from "../lib/channel.js";
import {
  applyBridgeOverride,
  detectInstalledCLIs,
} from "../lib/cli-detect.js";
import {
  BridgeError,
  materializeBridges,
} from "../lib/bridges.js";
import { DryRunCollector } from "../lib/dry-run.js";
import { copyFromSource, FromSourceError } from "../lib/from-source.js";
import {
  antigravityMcpConfigPath,
  brainDir,
  claudeJsonPath,
  claudeUserSettingsPath,
  codexConfigTomlPath,
  configJsonPath,
  geminiSettingsPath,
  installSourcePath,
  opencodeConfigPath,
  secretsEnvPath,
  userMdPath,
} from "../lib/paths.js";
import { registerBrainAcrossHarnesses } from "../lib/mcp-register.js";
import { applyPersona } from "../lib/persona.js";
import { linkAntigravitySkills } from "../lib/antigravity-skills.js";
import { installAntigravityHooks } from "../lib/antigravity-hooks.js";
import { mergeGlobalCanonicalHooks } from "../lib/global-hooks.js";
import {
  antigravitySkillsLinkPath,
  antigravityHooksConfigPath,
} from "../lib/paths.js";
import { chmodSecretFile } from "../lib/secret-perms.js";
import {
  checkNetwork,
  checkNodeVersion,
  detectInstallShape,
  PreflightError,
} from "../lib/preflight.js";
import {
  fetchAndExtract,
  NetworkError,
  TarballError,
  wipeDir,
  ZipSlipError,
} from "../lib/tarball.js";
import { writeInstallSource } from "../lib/install-source.js";
import { closeDb } from "../lib/registry.js";
import { info, warn, error as logError, debug } from "../lib/log.js";
import {
  gatherInitInputs,
  type InitInputs,
  type PromptFn,
} from "../lib/init/prompts.js";
import type { Channel, CLITarget } from "../types.js";

export interface InitOptions {
  /** Local repo root for contributor mode. Skips network. */
  fromSource?: string;
  /** Channel flag: undefined = latest release, "main" = main, else a tag or branch (TD-154). */
  channel?: string;
  /** Allow upgrading an existing install. */
  upgrade?: boolean;
  /** Skip the VPS prompt (no remote_brain config). */
  skipRemote?: boolean;
  /**
   * FR-122: apply a persona preset after the core swap (`--persona <name>`).
   * When omitted the shipped `core/SOUL.md` is left as-is (the default
   * character persona). An unknown name is a non-fatal WARN — init still
   * completes (the install is otherwise valid).
   */
  persona?: string;
  /** Override auto-detected bridges. "none" or "claude,codex,..." */
  cliBridge?: string;
  /** Print plan only, no writes. */
  dryRun?: boolean;
  /** Skip confirmation prompts (e.g. channel switch). */
  yes?: boolean;
  /**
   * Contributor dev-loop flag (TD-168 §5). When set, the igris-brain MCP
   * is registered pointing at the CLONE's brain-mcp-server
   * (`<fromSource>/brain-mcp-server/dist/index.js`) instead of the bundled
   * copy — so the operator's edit-rebuild-test loop is not broken by an
   * `igris init` repointing the entry at a stale bundle. Requires
   * `--from-source` (the path the clone is derived from).
   */
  dev?: boolean;
  /** Internal/test: override package version baked into config.json. */
  cliVersion?: string;
  /**
   * Test seam: inject a fake prompt function so vitest can drive the
   * interactive prompts deterministically. Production callers omit this.
   */
  prompt?: PromptFn;
  /**
   * Test seam: override TTY detection. When undefined the prompt module
   * falls back to `process.stdin.isTTY === true`. Production callers omit
   * this; tests pass `false` to force the non-TTY auto-skip path.
   */
  isTTY?: boolean;
}

const DEFAULT_DIRS = ["memory", "projects", "logs", ".cache"];

export async function runInit(opts: InitOptions): Promise<number> {
  const dryRun = opts.dryRun === true;
  const dry = dryRun ? new DryRunCollector() : null;

  // --- 1. Pre-flight ----------------------------------------------------

  try {
    checkNodeVersion();
  } catch (err) {
    if (err instanceof PreflightError) {
      logError(err.message);
      return 1;
    }
    throw err;
  }

  const shape = detectInstallShape();
  if (shape.kind === "interrupted") {
    logError(
      `Detected interrupted state at ${brainDir()}: orphan dirs ${shape.orphans
        .map((o) => `'${o}'`)
        .join(", ")}. Remove them and re-run, or pass --upgrade to recover.`,
    );
    if (opts.upgrade !== true) return 1;
    // With --upgrade, we tolerate orphans (they'll be wiped during swap).
  }
  if (shape.kind === "v7" && opts.upgrade !== true) {
    logError(
      `Existing v7 install detected at ${brainDir()}. Pass --upgrade to refresh, or omit init for a no-op.`,
    );
    return 1;
  }
  if (shape.kind === "v6" && opts.upgrade !== true) {
    logError(
      `Existing v6 install detected at ${brainDir()}. Pass --upgrade to migrate to v7.`,
    );
    return 1;
  }
  if (shape.kind === "absent" && opts.upgrade === true) {
    logError(
      `--upgrade was passed but no existing install found at ${brainDir()}. Drop --upgrade for a fresh init.`,
    );
    return 1;
  }

  // --- --dev validation + path resolution (TD-168 §5) ------------------
  // --dev (contributor dev-loop): register the igris-brain MCP from the
  // --from-source clone instead of the bundled copy, so the operator's
  // edit-rebuild-test loop is not broken by a repoint to a stale bundle.
  // Validated EARLY (before the core fetch) so a misuse fails fast rather
  // than after a multi-second download.
  let devMcpPath: string | undefined;
  if (opts.dev === true) {
    if (opts.fromSource === undefined) {
      logError(
        "--dev requires --from-source <path> (the clone to register the MCP from).",
      );
      return 1;
    }
    devMcpPath = join(
      pathResolve(opts.fromSource),
      "brain-mcp-server",
      "dist",
      "index.js",
    );
  }

  // --- Interactive prompts (TD-144) ------------------------------------
  // Collect identity + remote_brain inputs BEFORE the network check so the
  // user isn't asked their name AFTER a 5-second GitHub hang. The prompt
  // module short-circuits to defaults for --yes / --upgrade / --dry-run
  // and for non-TTY shells (curl|bash installers, CI).
  const inputs: InitInputs = await gatherInitInputs({
    yes: opts.yes === true,
    skipRemote: opts.skipRemote === true,
    upgrade: opts.upgrade === true,
    dryRun: dryRun,
    prompt: opts.prompt,
    isTTY: opts.isTTY,
  });

  // --- Network check ---------------------------------------------------
  const skipNetwork =
    opts.fromSource !== undefined || opts.skipRemote === true;
  if (!skipNetwork && !dryRun) {
    try {
      await checkNetwork({ skip: false });
    } catch (err) {
      if (err instanceof PreflightError) {
        logError(err.message);
        return 1;
      }
      throw err;
    }
  }

  // --- 2. Directory tree -----------------------------------------------
  const root = brainDir();
  if (dry !== null) {
    if (!existsSync(root)) dry.wouldCreateDir(root);
    for (const sub of DEFAULT_DIRS) {
      const p = join(root, sub);
      if (!existsSync(p)) dry.wouldCreateDir(p);
    }
  } else {
    mkdirSync(root, { recursive: true });
    for (const sub of DEFAULT_DIRS) {
      mkdirSync(join(root, sub), { recursive: true });
    }
  }

  // --- 3. Resolve channel + fetch (or from-source copy) -----------------
  let channelRef: string;
  let channelKind: Channel;
  let tarballUrl: string | null = null;
  let contentSha256: string;
  let stagingPath: string;
  let sourceKind: "github" | "from-source" | "cache";
  let sourcePath: string | null = null;

  // Always create a unique staging path (used in both fetch and from-source).
  const stagingDir = stagingDirFor(root);

  if (opts.fromSource !== undefined) {
    // Contributor mode.
    channelKind = "main";
    channelRef = "from-source";
    sourceKind = "from-source";
    sourcePath = pathResolve(opts.fromSource);
    stagingPath = stagingDir;
    if (dry !== null) {
      dry.wouldCreateDir(stagingPath);
      // TD-142: the non-dry path uses copyFromSource(...) — a recursive
      // copy that preserves the source tree. Render as "copy:" not
      // "rename:" so the dry-run plan matches the executed verb.
      dry.wouldCopy(
        join(sourcePath, "core"),
        join(root, "core"),
        "from-source copy (recursive)",
      );
    } else {
      // Wipe stale staging (could exist from a prior interrupted run).
      wipeDir(stagingPath);
      try {
        copyFromSource({
          sourcePath,
          destPath: stagingPath,
        });
      } catch (err) {
        if (err instanceof FromSourceError) {
          logError(err.message);
          wipeDir(stagingPath);
          return 1;
        }
        throw err;
      }
      // Hash the on-disk staged core for .install-source.json bookkeeping.
      // Note: from-source has no archive to hash, so we use a synthetic
      // marker with a timestamp prefix. This is enough for cache invalidation
      // and doctor's "stale" detection on contributor runs.
      contentSha256 = `from-source-${Date.now()}`;
    }
  } else {
    // Network or cache path.
    let resolved;
    try {
      resolved = await resolveChannel({ flag: opts.channel });
    } catch (err) {
      if (err instanceof ChannelResolveError) {
        logError(err.message);
        return 1;
      }
      throw err;
    }
    channelKind = resolved.kind;
    channelRef = resolved.ref;
    tarballUrl = resolved.tarballUrl;

    if (dry !== null) {
      dry.wouldFetchUrl(tarballUrl);
      dry.wouldCreateDir(stagingDir);
      dry.wouldRename(
        stagingDir,
        join(root, "core"),
        "atomic swap after extraction",
      );
      contentSha256 = "(dry-run)";
      sourceKind = "github";
    } else {
      wipeDir(stagingDir);
      mkdirSync(stagingDir, { recursive: true });
      // TD-113 cache-seed TEE: fetchAndExtract writes the RAW gzip bytes to
      // this sink path WHILE streaming them through gunzip→extract (one fetch,
      // two consumers). After a successful extract we promote the sink + the
      // extracted tree into the cache via cacheStore, so a later `igris refresh`
      // at the same SHA can extract from the cache instead of re-downloading.
      // The sink lives OUTSIDE stagingDir (a sibling) so (a) it isn't swept
      // into the atomic swap of stagingDir/core, and (b) cacheStore can copy
      // the WHOLE stagingDir as the extracted tree without dragging the archive
      // into <sha>/extracted/.
      const tarballSink = `${stagingDir}.tarball.tar.gz`;
      try {
        const fetched = await fetchAndExtract({
          url: tarballUrl,
          destDir: stagingDir,
          cacheSinkPath: tarballSink,
        });
        contentSha256 = fetched.contentSha256;
      } catch (err) {
        wipeDir(stagingDir);
        if (err instanceof ZipSlipError) {
          logError(
            `Refused to extract: tarball contains an unsafe entry (${err.entryPath}). Aborting.`,
          );
          return 1;
        }
        if (err instanceof NetworkError) {
          logError(
            `Network fetch failed (HTTP ${err.status}): ${err.message}.`,
          );
          return 1;
        }
        if (err instanceof TarballError) {
          logError(`Tarball extraction failed: ${err.message}`);
          return 1;
        }
        throw err;
      }
      sourceKind = "github";
      stagingPath = stagingDir;
      // Seed the cache from the freshly-fetched archive + extracted tree. Done
      // HERE (before the step-5 atomic swap wipes stagingDir) while both the
      // sink file and stagingDir/core exist. The extracted SOURCE is
      // stagingDir/core (cacheStore copies it under <sha>/extracted/core/).
      // Non-fatal: a cache-write failure WARNs and lets init finish — the core
      // swap does not depend on the cache.
      try {
        cacheStore(contentSha256, {
          // extractedSourcePath is stagingDir (which CONTAINS core/), matching
          // the cacheStore contract: the cache's extracted/ mirrors the tree
          // that contains core/, so findCached().extractedPath/core/ resolves.
          tarballSourcePath: tarballSink,
          extractedSourcePath: stagingDir,
          channel: channelKind,
          ref: channelRef,
          ttlMs:
            channelKind === "main" ? TTL_MAIN_MS : TTL_INFINITE,
        });
        debug(
          `Seeded cache <${contentSha256.slice(0, 12)}…> from ${tarballUrl}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`cache-seed skipped: ${msg}`);
      } finally {
        // The sink served its purpose (copied into the cache). Remove the
        // sibling archive so it doesn't linger next to the staging dir.
        try {
          if (existsSync(tarballSink)) rmSync(tarballSink, { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
    stagingPath = stagingDir;
  }

  // --- 4. Preservation snapshot (--upgrade only) ------------------------
  // Capture user state files BEFORE the atomic swap. They stay outside
  // core/ but knowledge.db is in memory/, USER.md and config.json are at
  // brain root. In practice the swap doesn't touch those — we still
  // assert byte-for-byte preservation by hashing pre/post.
  const preservation = capturePreservation(opts.upgrade === true);

  // --- 5. Atomic swap ---------------------------------------------------
  let bakPath: string | null = null;
  if (dry === null) {
    try {
      // The fetcher staged everything under stagingPath/core/. Atomic
      // swap promotes stagingPath/core/ → ~/.igris/core/.
      const newCorePath = join(stagingPath, "core");
      if (!existsSync(newCorePath)) {
        logError(
          `staging dir missing 'core/' after fetch: ${stagingPath}. Aborting.`,
        );
        wipeDir(stagingPath);
        return 1;
      }
      const corePath = join(root, "core");
      const swapResult = atomicSwap({
        newCorePath,
        existingCorePath: corePath,
        upgrade: opts.upgrade === true,
      });
      bakPath = swapResult.bakPath;
      // Wipe the staging dir's residue.
      wipeDir(stagingPath);
    } catch (err) {
      if (err instanceof AtomicExtractError) {
        logError(`atomic swap failed: ${err.message}`);
        wipeDir(stagingPath);
        return 1;
      }
      throw err;
    }
  } else {
    if (opts.upgrade === true) {
      const corePath = join(root, "core");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const futureBak = `${corePath}.bak.${ts}`;
      dry.wouldRename(corePath, futureBak, "back up existing core/ pre-upgrade");
    }
  }

  // --- 6. Verify preservation -------------------------------------------
  if (dry === null && opts.upgrade === true) {
    verifyPreservation(preservation);
  }

  // --- 7. DB init -------------------------------------------------------
  // ensureDbOpen is intentionally a touch-then-close — registry.ts opens
  // lazily and creates the projects table when needed. We just trigger
  // the path so the file exists for downstream verbs.
  if (dry !== null) {
    const dbPath = join(root, "memory", "knowledge.db");
    if (!existsSync(dbPath)) {
      dry.wouldWriteFile(dbPath, "create knowledge.db");
    }
  } else {
    try {
      await ensureDbOpen();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`DB init failed: ${msg}`);
      return 1;
    }
  }

  // --- 8. CLI bridges ---------------------------------------------------
  let bridgeTargets: ReadonlySet<CLITarget>;
  try {
    const det = detectInstalledCLIs();
    bridgeTargets = applyBridgeOverride(det.detected, opts.cliBridge);
    debug(
      `cli-detect: detected=${[...det.detected].join(",") || "(none)"}; ` +
        `effective targets=${[...bridgeTargets].join(",") || "(none)"}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`bridge resolution failed: ${msg}`);
    return 1;
  }

  if (bridgeTargets.size > 0 && dry === null) {
    try {
      // Bridges run AFTER core/ swap because adapters live under
      // ~/.igris/core/scripts/cli-adapters/.
      materializeBridges({
        targets: bridgeTargets,
        projectPath: root,
      });
    } catch (err) {
      if (err instanceof BridgeError) {
        logError(`bridge materialization failed: ${err.message}`);
        return 1;
      }
      throw err;
    }
  } else if (bridgeTargets.size > 0 && dry !== null) {
    for (const t of bridgeTargets) {
      dry.wouldInvokeCommand(
        "bash",
        [join(root, "core", "scripts", "cli-adapters", `${t}.sh`), root],
        `materialize bridge for ${t}`,
      );
    }
  }

  // --- 9. Templates: USER.md and config.json (preserved if existing) ----
  const userMd = userMdPath();
  const configJson = configJsonPath();
  const cliVersion = opts.cliVersion ?? "7.0.0";
  const installDate = new Date().toISOString();

  if (dry !== null) {
    if (!existsSync(userMd)) {
      dry.wouldWriteFile(userMd, "initial USER.md template");
    }
    if (!existsSync(configJson)) {
      dry.wouldWriteFile(configJson, "initial config.json");
    }
    // TD-220: config.json always exists post-run (we write it if absent,
    // preserve it otherwise), so it is always a chmod-600 candidate.
    dry.wouldInvokeCommand(
      "chmod",
      ["600", configJson],
      "harden secret-file perms (config.json)",
    );
    // secrets.env is tightened ONLY if it already exists — init never
    // fabricates it (Decision 3). Mirror that condition in the dry plan.
    if (existsSync(secretsEnvPath())) {
      dry.wouldInvokeCommand(
        "chmod",
        ["600", secretsEnvPath()],
        "harden secret-file perms (secrets.env)",
      );
    }
  } else {
    if (!existsSync(userMd)) {
      writeFileSync(
        userMd,
        renderUserTemplate({
          userName: inputs.userName,
          userEmail: inputs.userEmail,
        }),
      );
      info(`Wrote ${userMd}`);
    } else {
      debug(`USER.md exists at ${userMd}, preserved`);
    }
    if (!existsSync(configJson)) {
      writeFileSync(
        configJson,
        renderConfigTemplate({
          cliVersion,
          installDate,
          cliTargets: [...bridgeTargets],
          remoteBrain: inputs.remoteBrain,
        }),
      );
      info(`Wrote ${configJson}`);
    } else {
      debug(`config.json exists at ${configJson}, preserved`);
    }

    // TD-220: harden the Igris-owned secret-bearing files to mode 600.
    // config.json is Igris-authored, so we tighten it unconditionally —
    // this covers BOTH the freshly-written case AND a pre-existing file
    // that was sitting at a loose mode (e.g. 644 from an older install).
    // chmodSecretFile is a no-op on win32 / absent and never throws; it
    // changes metadata only, so it does NOT disturb the --upgrade byte-
    // for-byte preservation gate (verifyPreservation hashes content).
    chmodSecretFile(configJson);
    // secrets.env is USER-authored (FR-165): tighten it ONLY if present —
    // never fabricate an empty secrets.env (Decision 3).
    if (existsSync(secretsEnvPath())) {
      chmodSecretFile(secretsEnvPath());
    }
  }

  // --- 9b. (FR-191) global ~/.claude/CLAUDE.md render retired -----------
  // The TD-176 global re-template step was removed: `igris init` writes NO
  // global identity file. The harness discovers Igris via the slash menu +
  // the install/init success message.

  // --- 9c. (FR-122) optional persona apply -----------------------------
  // Runs AFTER the core swap (step 5) so the runtime SOUL templates exist.
  // When --persona is set, copy the chosen SOUL.<name>.md over the runtime
  // SOUL.md (+ canonical when in a checkout). Non-fatal: an unknown/invalid
  // persona WARNs and lets init complete (the install is otherwise valid).
  if (opts.persona !== undefined) {
    if (dry !== null) {
      dry.wouldWriteFile(
        join(root, "core", "SOUL.md"),
        `apply persona '${opts.persona}'`,
      );
    } else {
      const personaResult = applyPersona(
        opts.persona,
        opts.fromSource !== undefined
          ? pathResolve(opts.fromSource)
          : process.cwd(),
      );
      if (personaResult.outcome === "template_missing") {
        warn(
          `persona '${opts.persona}' not found — leaving the shipped SOUL.md ` +
            `(run \`igris configure\` to pick a persona later).`,
        );
      } else if (personaResult.outcome === "invalid_template") {
        warn(
          `persona '${opts.persona}' is missing required frontmatter — ` +
            `leaving the shipped SOUL.md.`,
        );
      } else {
        info(`Applied persona '${opts.persona}' (${personaResult.outcome}).`);
      }
    }
  }

  // --- 10. Write .install-source.json ----------------------------------
  if (dry !== null) {
    dry.wouldWriteFile(installSourcePath(), "record install source");
  } else {
    writeInstallSource({
      schema_version: 1,
      channel: channelKind,
      ref: channelRef,
      fetched_at: installDate,
      content_sha256: contentSha256!,
      source: sourceKind,
      source_path: sourcePath,
    });
    info(`Wrote ${installSourcePath()}`);
  }

  // --- 11. Cache seeding happened inline at step 3 (TD-113) ------------
  // The github fetch path now seeds the cache via cacheStore() right after a
  // successful fetchAndExtract (using the cache-sink TEE), so a later
  // `igris refresh` at the same SHA extracts from the cache instead of
  // re-downloading. No separate post-swap step is needed (and the staging dir
  // is gone by here anyway).

  // --- 13. Register igris-brain MCP in all 4 harness configs (FR-169) ----
  // `npm install -g igris-ai` ships a bundled brain-mcp-server; a harness
  // only serves its tools once the `igris-brain` entry exists in that
  // harness's config. igris-brain is a CORE OS default (L-504), so init wires
  // it into ALL supported harnesses (Claude, Gemini, Codex, OpenCode) via the
  // proven FR-162/163 mergers. Non-fatal (mirrors step 9b): a per-harness
  // failure WARNs and lets init complete with exit 0 — NEVER returns non-zero.
  //
  // --dev resolution happened early (right after pre-flight) — devMcpPath
  // is the clone's MCP path when --dev was passed, else undefined.
  if (dry !== null) {
    // FR-212c: the GLOBAL canonical-hooks merge into ~/.claude/settings.json
    // (the per-project install step 6 moved here — surfaces project globally
    // at init; install is registration-only).
    dry.wouldWriteFile(
      claudeUserSettingsPath(),
      "merge canonical Igris hooks block (global)",
    );
    dry.wouldWriteFile(claudeJsonPath(), "register igris-brain MCP (Claude)");
    dry.wouldWriteFile(geminiSettingsPath(), "register igris-brain MCP (Gemini)");
    dry.wouldWriteFile(codexConfigTomlPath(), "register igris-brain MCP (Codex)");
    dry.wouldWriteFile(opencodeConfigPath(), "register igris-brain MCP (OpenCode)");
    dry.wouldWriteFile(
      antigravityMcpConfigPath(),
      "register igris-brain MCP (Antigravity)",
    );
    // FR-179 Phase C: the antigravity skills parent symlink (R2). Only when
    // antigravity is an effective bridge target (matches the live gate below).
    if (bridgeTargets.has("antigravity")) {
      dry.wouldWriteFile(
        antigravitySkillsLinkPath(),
        "link antigravity skills -> ~/.agents/skills",
      );
      // FR-181: the antigravity brief-first hooks (PreToolUse + PostToolUse).
      dry.wouldWriteFile(
        antigravityHooksConfigPath(),
        "register Igris hooks (Antigravity)",
      );
    }
  } else {
    // --- 13a. GLOBAL canonical-hooks merge (FR-212c) ---------------------
    // The Igris hooks project GLOBALLY via ONE ~/.claude/settings.json block
    // (the per-project install step 6 moved here). The per-project `_gate.sh`
    // de-no-ops them outside a registered Igris project. Engine + canonical
    // source unchanged — only the target path moved. Non-fatal: a failure
    // WARNs and init continues to exit 0.
    const gh = mergeGlobalCanonicalHooks();
    if (gh.outcome === "failed") {
      warn(`global hooks merge skipped: ${gh.error}`);
      warn(`  Manual fix: merge the canonical hooks block into ${gh.path}`);
    } else if (gh.outcome === "unchanged") {
      debug(`global Igris hooks already present -> ${gh.path}`);
    } else {
      info(`Merged global Igris hooks block -> ${gh.path}`);
    }

    const results = registerBrainAcrossHarnesses(
      devMcpPath !== undefined ? { mcpEntryPath: devMcpPath } : undefined,
    );
    let anyWired = false;
    for (const { harness, result } of results) {
      if (result.outcome === "failed") {
        warn(`MCP registration skipped for ${harness}: ${result.error}`);
        warn(
          `  Manual fix: add an "igris-brain" entry to ${result.claudeJsonPath}`,
        );
        warn(`  pointing at: ${result.mcpEntryPath}`);
      } else if (result.outcome === "unchanged") {
        debug(`igris-brain MCP already registered for ${harness} -> ${result.mcpEntryPath}`);
      } else {
        anyWired = true;
        info(`Registered igris-brain MCP for ${harness} (${result.outcome})`);
      }
    }
    if (anyWired) {
      info("  Restart your harness(es) to pick up the new MCP server.");
    }

    // --- 13b. Antigravity skills parent symlink (FR-179 Phase C, R2) -----
    // Antigravity loads skills from ~/.gemini/antigravity-cli/skills but does
    // NOT self-create the symlink to the shared ~/.agents/skills (R2). Create
    // it when antigravity is an effective bridge target so its native loader
    // resolves through the link to the populated shared dir. Non-fatal +
    // idempotent-repair (never throws); a refuse/failed outcome WARNs.
    if (bridgeTargets.has("antigravity")) {
      const link = linkAntigravitySkills();
      if (link.outcome === "refused" || link.outcome === "failed") {
        warn(`antigravity skills link skipped: ${link.error}`);
      } else if (link.outcome === "unchanged") {
        debug(`antigravity skills link already in place -> ${link.target}`);
      } else {
        info(
          `Linked antigravity skills (${link.outcome}): ${link.linkPath} -> ${link.target}`,
        );
      }

      // --- 13c. Antigravity brief-first hooks (FR-181) ------------------
      // Config-merge the PreToolUse + PostToolUse groups into
      // ~/.gemini/config/hooks.json (the gemini-cli trigger path) → the
      // bridge scripts. Preserves any pre-existing hooks; never throws.
      const hooks = installAntigravityHooks();
      if (hooks.outcome === "failed") {
        warn(`antigravity hooks registration skipped: ${hooks.error}`);
      } else if (hooks.outcome === "unchanged") {
        debug(`antigravity hooks already registered -> ${hooks.path}`);
      } else {
        info(`Registered Igris hooks for antigravity (${hooks.outcome}): ${hooks.path}`);
      }
    }
  }

  // --- 12. Final report -------------------------------------------------
  if (dry !== null) {
    dry.print();
    return 0;
  }

  // Close any DB handles we touched so the process can exit cleanly
  // (L-130 native-extension teardown discipline).
  closeDb();

  info("");
  info("Igris init complete.");
  info(`  brain root:       ${root}`);
  info(`  channel:          ${channelKind}`);
  info(`  ref:              ${channelRef}`);
  info(`  source:           ${sourceKind}${sourcePath ? ` (${sourcePath})` : ""}`);
  info(`  bridges:          ${[...bridgeTargets].join(",") || "(none)"}`);
  if (bakPath !== null) {
    info(`  prior core baked: ${bakPath}`);
  }

  return 0;
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

interface PreservationSnapshot {
  enabled: boolean;
  knowledgeDb: { path: string; bytes: Buffer | null };
  userMd: { path: string; bytes: Buffer | null };
  configJson: { path: string; bytes: Buffer | null };
}

function capturePreservation(enabled: boolean): PreservationSnapshot {
  const root = brainDir();
  const dbPath = join(root, "memory", "knowledge.db");
  const userPath = userMdPath();
  const cfgPath = configJsonPath();
  return {
    enabled,
    knowledgeDb: {
      path: dbPath,
      bytes: enabled && existsSync(dbPath) ? readFileSync(dbPath) : null,
    },
    userMd: {
      path: userPath,
      bytes: enabled && existsSync(userPath) ? readFileSync(userPath) : null,
    },
    configJson: {
      path: cfgPath,
      bytes: enabled && existsSync(cfgPath) ? readFileSync(cfgPath) : null,
    },
  };
}

function verifyPreservation(snap: PreservationSnapshot): void {
  if (!snap.enabled) return;
  for (const f of [snap.knowledgeDb, snap.userMd, snap.configJson]) {
    if (f.bytes === null) continue; // not present pre-init; nothing to verify.
    if (!existsSync(f.path)) {
      throw new Error(
        `preservation FAILED: ${f.path} disappeared during init`,
      );
    }
    const post = readFileSync(f.path);
    if (!post.equals(f.bytes)) {
      throw new Error(
        `preservation FAILED: ${f.path} bytes diverged across init (pre=${f.bytes.length}B, post=${post.length}B)`,
      );
    }
  }
}

/** Trigger the registry DB to open (creates schema if absent). */
async function ensureDbOpen(): Promise<void> {
  // Dynamic import keeps better-sqlite3 native init out of dry-run paths.
  // listProjects opens the handle and populates the schema; we don't
  // need the rows — the side effect is what matters.
  const reg = await import("../lib/registry.js");
  reg.listProjects();
  reg.closeDb();
}

function templateRoot(): string {
  // dist/verbs/init.js -> ../lib/templates relative to compiled output.
  // src/verbs/init.ts -> ../lib/templates relative to source.
  // In both cases, the resolution is the same: parent dir then lib/templates.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "lib", "templates");
}

/**
 * Render the USER.md template with the given identity. Exported so the FR-122
 * `configure` verb writes USER.md through the SAME template path as init (one
 * source of truth for the USER.md shape).
 */
export function renderUserTemplate(args: {
  userName: string;
  userEmail: string;
}): string {
  const path = join(templateRoot(), "USER.md.tmpl");
  if (!existsSync(path)) {
    throw new Error(`USER.md template missing at ${path}`);
  }
  let raw = readFileSync(path, "utf-8");
  raw = raw.replace(/{{USER_NAME}}/g, args.userName);
  raw = raw.replace(/{{USER_EMAIL}}/g, args.userEmail);
  return raw;
}

function renderConfigTemplate(args: {
  cliVersion: string;
  installDate: string;
  cliTargets: CLITarget[];
  /**
   * Structured remote_brain config. Null → `remote_brain: null` in
   * config.json (matches `--skip-remote` legacy behavior). Non-null →
   * `{url, api_key}` literal (api_key may be null if the user provided a
   * URL but left the key blank, signaling "set it later via config.json").
   */
  remoteBrain: { url: string; apiKey: string | null } | null;
}): string {
  const path = join(templateRoot(), "config.json.tmpl");
  if (!existsSync(path)) {
    throw new Error(`config.json template missing at ${path}`);
  }
  let raw = readFileSync(path, "utf-8");
  raw = raw.replace(/{{IGRIS_VERSION}}/g, args.cliVersion);
  raw = raw.replace(/{{INSTALL_DATE}}/g, args.installDate);
  const cliTargetsObj: Record<string, true> = {};
  for (const t of args.cliTargets) cliTargetsObj[t] = true;
  raw = raw.replace(/{{CLI_TARGETS_JSON}}/g, JSON.stringify(cliTargetsObj));

  // remoteBrain === null reproduces the legacy `--skip-remote` shape;
  // when non-null, JSON.stringify escapes any user-supplied characters
  // (backslashes, quotes, unicode) so the template substitution can't
  // accidentally produce invalid JSON. The post-render JSON.parse below
  // is the final guard.
  const rbJson =
    args.remoteBrain === null
      ? "null"
      : JSON.stringify({
          url: args.remoteBrain.url,
          api_key: args.remoteBrain.apiKey,
        });
  raw = raw.replace(/{{REMOTE_BRAIN_JSON}}/g, rbJson);

  // Validate by parsing — fail fast if our template substitution broke JSON.
  try {
    JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`config.json template render produced invalid JSON: ${msg}`);
  }
  return raw;
}
