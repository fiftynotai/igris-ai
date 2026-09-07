/**
 * `igris refresh [--channel <ref>] [--from-source <path>] [--no-propagate]
 *                [--dry-run] [--yes] [--wipe-orphans]`
 *
 * Re-fetch `~/.igris/core/` from the source recorded in
 * `.install-source.json` (or a new one via --channel / --from-source).
 * Atomically swap. Optionally propagate to all registered projects via
 * `runUpdate({ all: true })`.
 *
 * Source resolution + channel switching live in ONE helper shared with
 * `igris init --upgrade` (`core-source.ts`, BR-103): explicit flag, else the
 * record (a from-source record re-copies from that checkout — no network),
 * else the latest release. A switch against the record prompts unless
 * `--yes`; refusing a switch is a clean exit (code 0).
 *
 * Interrupted shapes (BR-103): `core.new.*` residue refuses unless
 * `--wipe-orphans`; a `core.bak.*` with no `core/` refuses with the restore
 * command. A retained bak beside a healthy core is normal and proceeds.
 *
 * Runtime-only files under core/ (`core-runtime-extras.ts`) are regenerated
 * / carried into the staged tree before the swap.
 *
 * Cache fast-path: when the channel resolves to the same content_sha256
 * recorded in .install-source.json (computed by re-fetching the API
 * head OR by checking the cache), skip re-extraction entirely. This
 * makes "refresh on a brain that's already at the channel head" a
 * no-op — the cache-hit AC bullet from §4.
 */

import {
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  AtomicExtractError,
  atomicSwap,
  stagingDirFor,
} from "../lib/atomic-extract.js";
import {
  cacheEvict,
  findCached,
} from "../lib/cache.js";
import { ChannelResolveError } from "../lib/channel.js";
import {
  CoreSourceError,
  resolveCoreSource,
} from "../lib/core-source.js";
import {
  applyCoreExtras,
  reportCoreExtras,
} from "../lib/core-runtime-extras.js";
import { DryRunCollector } from "../lib/dry-run.js";
import { copyFromSource, FromSourceError } from "../lib/from-source.js";
import {
  brainDir,
  installSourcePath,
} from "../lib/paths.js";
import {
  detectInstallShape,
  resolveInterruptedShape,
} from "../lib/preflight.js";
import {
  fetchAndExtractFromFile,
  fetchAndExtract,
  hashTarballFile,
  NetworkError,
  TarballError,
  wipeDir,
  ZipSlipError,
} from "../lib/tarball.js";
import type { Channel } from "../types.js";
import {
  readInstallSource,
  writeInstallSource,
} from "../lib/install-source.js";
import { runUpdate } from "./update.js";
import { info, warn, error as logError, debug } from "../lib/log.js";

export interface RefreshOptions {
  fromSource?: string;
  channel?: string;
  noPropagate?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  /**
   * BR-103: remove `core.new.*` staging residue left by an interrupted run,
   * then proceed. Never touches a `core.bak.*` backup.
   */
  wipeOrphans?: boolean;
  /** Test seam: pre-resolve the channel via injected fn (skips network). */
  latestReleaseTagFn?: () => Promise<string>;
  /**
   * Test seam (TD-154): swap the tag-vs-branch git-ref probe so a
   * `--channel=<branch|tag>` switch resolves without touching the network.
   * Threaded straight into resolveChannel; production callers omit it.
   */
  classifyFn?: (ref: string) => Promise<"tag" | "branch" | "none">;
  /**
   * Test seam: when set, calls `confirmFn(promptText)` instead of
   * blocking on stdin. Returns true → proceed with switch.
   */
  confirmFn?: (prompt: string) => boolean;
}

/**
 * Re-fetch and atomically swap brain core. Returns process exit code.
 */
export async function runRefresh(opts: RefreshOptions): Promise<number> {
  const dryRun = opts.dryRun === true;
  const dry = dryRun ? new DryRunCollector() : null;

  const root = brainDir();
  const installSrc = readInstallSource();
  if (installSrc === null) {
    logError(
      `No .install-source.json at ${installSourcePath()}. Run 'igris init' first.`,
    );
    return 1;
  }

  // BR-103: an interrupted shape refuses BEFORE anything is staged or written.
  const interrupted = resolveInterruptedShape(detectInstallShape(), {
    wipeOrphans: opts.wipeOrphans === true,
  });
  if (interrupted.verdict === "refuse") {
    logError(interrupted.message);
    return 1;
  }
  if (interrupted.verdict === "wiped") {
    for (const r of interrupted.removed) {
      info(`Removed staging residue ${r} (--wipe-orphans)`);
    }
  } else if (interrupted.retainedBaks.length > 0) {
    debug(
      `retained backup(s) beside core/: ${interrupted.retainedBaks.join(", ")} (normal — one is kept for recovery)`,
    );
  }

  // Resolve the source: flag > record > latest release; prompt on a switch.
  let resolved;
  try {
    resolved = await resolveCoreSource({
      fromSource: opts.fromSource,
      channel: opts.channel,
      installSrc,
      yes: opts.yes === true,
      confirmFn: opts.confirmFn,
      latestReleaseTagFn: opts.latestReleaseTagFn,
      classifyFn: opts.classifyFn,
    });
  } catch (err) {
    if (err instanceof ChannelResolveError || err instanceof CoreSourceError) {
      logError(err.message);
      return 1;
    }
    throw err;
  }
  if (resolved.outcome === "declined") {
    info("Refresh cancelled by user.");
    return 0;
  }
  const source = resolved.source;
  const channelKind: Channel = source.kind === "from-source" ? "main" : source.channelKind;
  const channelRef = source.kind === "from-source" ? "from-source" : source.ref;

  // Stage to a fresh dir.
  const stagingPath = stagingDirFor(root);

  let contentSha256: string;
  let sourceKind: "github" | "from-source" = "github";
  let sourcePath: string | null = null;

  if (source.kind === "from-source") {
    sourceKind = "from-source";
    sourcePath = source.path;
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
      contentSha256 = "(dry-run)";
    } else {
      wipeDir(stagingPath);
      try {
        copyFromSource({ sourcePath, destPath: stagingPath });
      } catch (err) {
        if (err instanceof FromSourceError) {
          logError(err.message);
          wipeDir(stagingPath);
          return 1;
        }
        throw err;
      }
      contentSha256 = `from-source-${Date.now()}`;
    }
  } else {
    const tarballUrl = source.tarballUrl;
    if (dry !== null) {
      dry.wouldFetchUrl(tarballUrl);
      dry.wouldCreateDir(stagingPath);
      dry.wouldRename(
        stagingPath,
        join(root, "core"),
        "atomic swap after extraction",
      );
      contentSha256 = "(dry-run)";
    } else {
      wipeDir(stagingPath);
      mkdirSync(stagingPath, { recursive: true });

      // ── TD-113 cache check (BEFORE the network) ──────────────────────
      // When the channel is UNCHANGED (no switch) and the cache holds an entry
      // for the SHA recorded in .install-source.json, the brain is already at
      // that content — extract from the cached tarball instead of hitting the
      // network. A `--channel=<other>` switch skips this entirely (the entry's
      // channel won't match the requested one, and the switch invalidates any
      // hit). The cached tarball is RE-HASHED on read (cheap for ~100KB); a
      // mismatch evicts the corrupt entry and falls through to the network.
      const cacheHandled = !resolved.switched
        ? await tryCacheHit({
            recordedSha: installSrc.content_sha256,
            channelKind,
            stagingPath,
          })
        : null;
      if (cacheHandled === "hit-noop") {
        wipeDir(stagingPath);
        info(
          `Refresh: brain core already at ${channelKind}/${channelRef} (cache hit, no network).`,
        );
        return 0;
      }
      // cacheHandled is null (miss / corrupt / channel switch) → network fetch.

      try {
        const fetched = await fetchAndExtract({
          url: tarballUrl,
          destDir: stagingPath,
        });
        contentSha256 = fetched.contentSha256;
      } catch (err) {
        wipeDir(stagingPath);
        if (err instanceof ZipSlipError) {
          logError(`Refused to extract: ${err.message}`);
          return 1;
        }
        if (err instanceof NetworkError) {
          logError(`Network fetch failed: ${err.message}`);
          return 1;
        }
        if (err instanceof TarballError) {
          logError(`Tarball extraction failed: ${err.message}`);
          return 1;
        }
        throw err;
      }

      // Cache fast-path: same sha → no swap needed (the network fetch produced
      // the same bytes already on disk). Seed/refresh the cache from this fetch
      // so the NEXT refresh can take the no-network path above.
      if (contentSha256 === installSrc.content_sha256) {
        debug(`refresh: same sha as recorded; no swap needed`);
        wipeDir(stagingPath);
        info(
          `Refresh: brain core already at ${channelKind}/${channelRef} (cache hit, no changes).`,
        );
        return 0;
      }
    }
  }

  // Atomic swap.
  let bakPath: string | null = null;
  if (dry === null) {
    try {
      const newCorePath = join(stagingPath, "core");
      if (!existsSync(newCorePath)) {
        logError(`staging missing 'core/' after fetch: ${stagingPath}`);
        wipeDir(stagingPath);
        return 1;
      }
      const corePath = join(root, "core");
      // BR-103: runtime-only extras go into the STAGED tree, so the swap
      // stays one atomic rename and the promoted core already carries them.
      reportCoreExtras(
        applyCoreExtras({
          stagedRoot: stagingPath,
          stagedCore: newCorePath,
          priorCore: existsSync(corePath) ? corePath : null,
        }),
      );
      const swap = atomicSwap({
        newCorePath,
        existingCorePath: corePath,
        upgrade: true,
      });
      bakPath = swap.bakPath;
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
    const corePath = join(root, "core");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    dry.wouldRename(
      corePath,
      `${corePath}.bak.${ts}`,
      "back up existing core/ pre-swap",
    );
  }

  // Persist new install-source.
  const fetchedAt = new Date().toISOString();
  if (dry !== null) {
    dry.wouldWriteFile(installSourcePath(), "update install source record");
  } else {
    writeInstallSource({
      schema_version: 1,
      channel: channelKind,
      ref: channelRef,
      fetched_at: fetchedAt,
      content_sha256: contentSha256!,
      source: sourceKind,
      source_path: sourcePath,
    });
  }

  // Optional propagation to all registered projects.
  if (opts.noPropagate !== true) {
    if (dry !== null) {
      dry.wouldInvokeCommand(
        "igris",
        ["update", "--all"],
        "propagate refresh to registered projects",
      );
    } else {
      info("Propagating refresh to registered projects...");
      const updateCode = await runUpdate({ all: true });
      if (updateCode !== 0) {
        warn(
          `update --all returned non-zero (${updateCode}); refresh swap succeeded but propagation had errors.`,
        );
      }
    }
  } else {
    debug("--no-propagate: skipped runUpdate({ all: true })");
  }

  if (dry !== null) {
    dry.print();
    return 0;
  }

  info("");
  info("Igris refresh complete.");
  info(`  channel:    ${channelKind}`);
  info(`  ref:        ${channelRef}`);
  info(`  source:     ${sourceKind}${sourcePath ? ` (${sourcePath})` : ""}`);
  if (bakPath !== null) {
    info(`  prior bak:  ${bakPath}`);
  }
  return 0;
}

/**
 * TD-113 cache check. Returns:
 *   - "hit-noop": the cache holds a VALID entry for `recordedSha` on the SAME
 *     channel; the cached tarball re-hashes correctly and extracts cleanly into
 *     `stagingPath`. The brain is already at this content → caller skips the
 *     network AND the swap (no-op refresh).
 *   - null: cache miss, channel mismatch, corrupt entry (evicted), or a
 *     re-extract failure → caller falls through to the network fetch.
 *
 * Corruption safety: the cached tarball is RE-HASHED on read. A SHA mismatch
 * (bit-rot, truncated write that escaped the init-time guard) evicts the entry
 * and returns null so the network path produces a clean copy. The re-extract
 * into staging is the final proof the cached bytes gunzip+untar without error.
 */
async function tryCacheHit(args: {
  recordedSha: string;
  channelKind: Channel;
  stagingPath: string;
}): Promise<"hit-noop" | null> {
  const hit = findCached(args.recordedSha);
  if (hit === null) {
    debug(`refresh: no cache entry for ${args.recordedSha.slice(0, 12)}…`);
    return null;
  }
  // A different channel's bytes must never satisfy a refresh for THIS channel,
  // even on a (theoretical) SHA collision — a channel switch always re-fetches.
  if (hit.meta.channel !== args.channelKind) {
    debug(
      `refresh: cache entry channel '${hit.meta.channel}' != requested '${args.channelKind}'; ignoring`,
    );
    return null;
  }
  // Corruption check: re-hash the cached tarball bytes.
  let actualSha: string;
  try {
    actualSha = await hashTarballFile(hit.tarballPath);
  } catch (err) {
    debug(
      `refresh: cached tarball unreadable (${err instanceof Error ? err.message : String(err)}); evicting`,
    );
    cacheEvict(args.recordedSha);
    return null;
  }
  if (actualSha !== args.recordedSha) {
    warn(
      `refresh: cached tarball for ${args.recordedSha.slice(0, 12)}… is corrupt ` +
        `(re-hash ${actualSha.slice(0, 12)}…); evicting and re-fetching.`,
    );
    cacheEvict(args.recordedSha);
    return null;
  }
  // Prove the cached bytes extract cleanly (gunzip + untar) into staging.
  try {
    await fetchAndExtractFromFile(hit.tarballPath, args.stagingPath);
  } catch (err) {
    warn(
      `refresh: cached tarball failed to extract (${err instanceof Error ? err.message : String(err)}); evicting and re-fetching.`,
    );
    cacheEvict(args.recordedSha);
    wipeDir(args.stagingPath);
    return null;
  }
  debug(
    `refresh: cache HIT for ${args.recordedSha.slice(0, 12)}… (${args.channelKind}); skipping network`,
  );
  return "hit-noop";
}
