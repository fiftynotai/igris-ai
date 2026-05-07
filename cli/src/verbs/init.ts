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
  copyFileSync,
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
import {
  cacheStore,
  findCached,
  TTL_INFINITE,
  TTL_MAIN_MS,
} from "../lib/cache.js";
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
  brainDir,
  cacheDir,
  configJsonPath,
  installSourcePath,
  userMdPath,
} from "../lib/paths.js";
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
import type { CLITarget } from "../types.js";

export interface InitOptions {
  /** Local repo root for contributor mode. Skips network. */
  fromSource?: string;
  /** Channel flag: undefined = latest release, "main" = main, else tag. */
  channel?: string;
  /** Allow upgrading an existing install. */
  upgrade?: boolean;
  /** Skip the VPS prompt (no remote_brain config). */
  skipRemote?: boolean;
  /** Override auto-detected bridges. "none" or "claude,codex,..." */
  cliBridge?: string;
  /** Print plan only, no writes. */
  dryRun?: boolean;
  /** Skip confirmation prompts (e.g. channel switch). */
  yes?: boolean;
  /** Internal/test: override package version baked into config.json. */
  cliVersion?: string;
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
  let channelKind: "release" | "main" | "tag";
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
      dry.wouldRename(
        join(sourcePath, "core"),
        join(root, "core"),
        "from-source copy",
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
      try {
        const fetched = await fetchAndExtract({
          url: tarballUrl,
          destDir: stagingDir,
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
      // Cache the fetched archive for refresh-without-redownload.
      try {
        // Re-hash the tarball file is not needed because fetchAndExtract
        // streamed the bytes; we already have contentSha256. We don't
        // currently retain the raw bytes (they're consumed by gunzip);
        // skipping cache write for fresh init — refresh is responsible
        // for cache writes when it RE-DOWNLOADS the archive. Init
        // streams once.
        debug(`Fetched ${tarballUrl}; sha256=${contentSha256}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`cache-write skipped: ${msg}`);
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
  } else {
    if (!existsSync(userMd)) {
      writeFileSync(userMd, renderUserTemplate());
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
          skipRemote: opts.skipRemote === true,
        }),
      );
      info(`Wrote ${configJson}`);
    } else {
      debug(`config.json exists at ${configJson}, preserved`);
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

  // --- 11. Cache the freshly-extracted core (refresh fast-path) --------
  // Skipped for from-source (nothing to cache) and for dry-run.
  if (dry === null && sourceKind === "github" && tarballUrl !== null) {
    // We don't currently retain the raw bytes after fetchAndExtract — for
    // M1 we accept that init doesn't seed the cache; refresh always
    // re-fetches and CAN seed the cache by saving its raw bytes.
    void TTL_MAIN_MS;
    void TTL_INFINITE;
    void cacheStore;
    void findCached;
    void cacheDir;
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

function renderUserTemplate(): string {
  const path = join(templateRoot(), "USER.md.tmpl");
  if (!existsSync(path)) {
    throw new Error(`USER.md template missing at ${path}`);
  }
  let raw = readFileSync(path, "utf-8");
  raw = raw.replace(/{{USER_NAME}}/g, process.env.USER ?? "you");
  raw = raw.replace(/{{USER_EMAIL}}/g, process.env.IGRIS_USER_EMAIL ?? "");
  return raw;
}

function renderConfigTemplate(args: {
  cliVersion: string;
  installDate: string;
  cliTargets: CLITarget[];
  skipRemote: boolean;
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
  raw = raw.replace(
    /{{REMOTE_BRAIN_JSON}}/g,
    args.skipRemote ? "null" : '{"url": null, "api_key": null}',
  );
  // Validate by parsing — fail fast if our template substitution broke JSON.
  try {
    JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`config.json template render produced invalid JSON: ${msg}`);
  }
  return raw;
}

// Suppress unused-import warnings for things wired in but not yet
// consumed at the M1 boundary (cache pre-seed etc.). M2/M5 wire these.
void rmSync;
void copyFileSync;
