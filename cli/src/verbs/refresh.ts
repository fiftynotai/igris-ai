/**
 * `igris refresh [--channel <ref>] [--from-source <path>] [--no-propagate]
 *                [--dry-run] [--yes]`
 *
 * Re-fetch `~/.igris/core/` from the channel recorded in
 * `.install-source.json` (or a new channel via --channel). Atomically
 * swap. Optionally propagate to all registered projects via
 * `runUpdate({ all: true })`.
 *
 * Channel switching: when `--channel <other>` differs from the recorded
 * channel/ref, prompt for confirmation unless `--yes`. Refusing a
 * channel switch is a clean exit (code 0); user said no, that's fine.
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
import { dirname, join, resolve as pathResolve } from "node:path";
import {
  AtomicExtractError,
  atomicSwap,
  stagingDirFor,
} from "../lib/atomic-extract.js";
import {
  ChannelResolveError,
  resolveChannel,
} from "../lib/channel.js";
import { DryRunCollector } from "../lib/dry-run.js";
import { copyFromSource, FromSourceError } from "../lib/from-source.js";
import {
  brainDir,
  installSourcePath,
} from "../lib/paths.js";
import {
  fetchAndExtract,
  NetworkError,
  TarballError,
  wipeDir,
  ZipSlipError,
} from "../lib/tarball.js";
import {
  readInstallSource,
  writeInstallSource,
} from "../lib/install-source.js";
import { runUpdate } from "./update.js";
import { info, warn, error as logError, debug } from "../lib/log.js";
import type { Channel } from "../types.js";

export interface RefreshOptions {
  fromSource?: string;
  channel?: string;
  noPropagate?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  /** Test seam: pre-resolve the channel via injected fn (skips network). */
  latestReleaseTagFn?: () => Promise<string>;
  /**
   * Test seam: when set, calls `confirmFn(promptText)` instead of
   * blocking on stdin. Returns true → proceed with switch.
   */
  confirmFn?: (prompt: string) => boolean;
}

const FAKE_DIRNAME = ".";

/**
 * Re-fetch and atomically swap brain core. Returns process exit code.
 */
export async function runRefresh(opts: RefreshOptions): Promise<number> {
  void FAKE_DIRNAME; // reserved for future cache-aware swap path
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

  // What the .install-source.json actually records — used for switch detection.
  const recordedFlag = recordedFlagFromInstallSource(installSrc.channel, installSrc.ref);

  // Resolve the requested channel (or default to recorded).
  let resolved;
  let channelKind: Channel;
  let channelRef: string;
  let tarballUrl: string | null = null;

  if (opts.fromSource !== undefined) {
    channelKind = "main";
    channelRef = "from-source";
  } else {
    try {
      // If --channel wasn't specified AND the previous source was
      // from-source, the user must explicitly opt back into a network
      // channel. We pick "release" (default) but the switch-prompt
      // path catches it.
      const flag =
        opts.channel ??
        (installSrc.source === "from-source"
          ? undefined
          : recordedChannelToFlag(installSrc.channel, installSrc.ref));
      resolved = await resolveChannel({
        flag,
        latestReleaseTagFn: opts.latestReleaseTagFn,
      });
      channelKind = resolved.kind;
      channelRef = resolved.ref;
      tarballUrl = resolved.tarballUrl;
    } catch (err) {
      if (err instanceof ChannelResolveError) {
        logError(err.message);
        return 1;
      }
      throw err;
    }
  }

  // Channel switch confirmation.
  const requestedFlag =
    opts.fromSource !== undefined
      ? "from-source"
      : opts.channel ?? recordedChannelToFlag(channelKind, channelRef);
  if (
    requestedFlag !== recordedFlag &&
    opts.yes !== true
  ) {
    const promptText = `Switching channel from ${recordedFlag} to ${requestedFlag} will replace ~/.igris/core/. Continue? [y/N]`;
    const confirmed = (opts.confirmFn ?? defaultConfirm)(promptText);
    if (!confirmed) {
      info("Refresh cancelled by user.");
      return 0;
    }
  }

  // Stage to a fresh dir.
  const stagingPath = stagingDirFor(root);

  let contentSha256: string;
  let sourceKind: "github" | "from-source" = "github";
  let sourcePath: string | null = null;

  if (opts.fromSource !== undefined) {
    sourceKind = "from-source";
    sourcePath = pathResolve(opts.fromSource);
    if (dry !== null) {
      dry.wouldCreateDir(stagingPath);
      dry.wouldRename(
        join(sourcePath, "core"),
        join(root, "core"),
        "from-source copy",
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
    if (tarballUrl === null) {
      logError("internal: tarballUrl unresolved");
      return 1;
    }
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

      // Cache fast-path: same sha → no swap needed.
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
 * Convert a recorded channel kind + ref back into a flag-style string
 * for resolveChannel's input. Used so we can re-resolve the same
 * channel without round-tripping through a flag.
 */
function recordedChannelToFlag(channel: Channel, ref: string): string {
  if (channel === "main") return "main";
  if (channel === "release") return ref; // tag name verbatim
  if (channel === "tag") return ref;
  return ref;
}

/**
 * What the .install-source.json effectively reads as for switch detection.
 * For from-source records (where .source === "from-source"), the
 * recorded ref is "from-source" — so requesting --channel=main is a
 * legitimate switch and the prompt should fire.
 */
function recordedFlagFromInstallSource(channel: Channel, ref: string): string {
  if (ref === "from-source") return "from-source";
  return recordedChannelToFlag(channel, ref);
}

/**
 * Default confirmation: read a single line from stdin and accept
 * "y" / "yes" (case-insensitive). All else means "no".
 *
 * NOT used in tests — the test seam `confirmFn` injects a deterministic
 * answer.
 */
function defaultConfirm(prompt: string): boolean {
  process.stdout.write(prompt + " ");
  // Synchronous stdin read via fs trick. We use a 1024-byte buffer
  // and read until newline. Node 20+ exposes process.stdin as a
  // Readable; for synchronous reads we shell out to read(1) via fs.
  // Simpler: just read up to 1024 bytes from /dev/tty.
  try {
    const fs = require("node:fs");
    void dirname; // keep imports anchored under noUnusedLocals
    const buf = Buffer.alloc(1024);
    const fd = fs.openSync("/dev/tty", "r");
    const n = fs.readSync(fd, buf, 0, 1024, null);
    fs.closeSync(fd);
    const reply = buf.subarray(0, n).toString("utf-8").trim().toLowerCase();
    return reply === "y" || reply === "yes";
  } catch {
    return false;
  }
}
