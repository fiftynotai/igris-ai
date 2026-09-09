/**
 * Where a core swap reads `core/` FROM — the ONE resolver `igris init
 * --upgrade` and `igris refresh` share (BR-103).
 *
 * Precedence:
 *   1. explicit `--from-source <path>`      → that checkout
 *   2. explicit `--channel <ref>`           → that GitHub ref
 *   3. the RECORD (`~/.igris/.install-source.json`):
 *        from-source with a checkout that still has core/ → that checkout
 *        from-source whose checkout is gone                → CoreSourceError
 *        a GitHub record                                   → the SAME ref
 *   4. no record                              → the latest release tag
 *
 * A change of source against the record is a SWITCH and is confirmed
 * (`--yes` accepts). Before BR-103, `init --upgrade` had no precedence at
 * all: with no flags it went to step 4 — and on a from-source machine that
 * replaced a core newer than the checkout with the last release tag, silently
 * (the 2026-09-07 incident, defect b). `refresh` had the record logic and the
 * prompt but rendered a from-source record as "default to release" too.
 */

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import {
  resolveChannel,
  type LatestReleaseTagFn,
  type RefClassifyFn,
} from "./channel.js";
import type { Channel, InstallSource } from "../types.js";

export class CoreSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreSourceError";
  }
}

export type CoreSource =
  | { kind: "from-source"; path: string }
  | { kind: "channel"; channelKind: Channel; ref: string; tarballUrl: string };

export interface ResolveCoreSourceOptions {
  fromSource?: string;
  channel?: string;
  /** The record, or null when there is none (fresh init / v6). */
  installSrc: InstallSource | null;
  /** `--yes`: accept a channel switch without the prompt. */
  yes: boolean;
  /** Test seam: replaces the /dev/tty confirmation. */
  confirmFn?: (prompt: string) => boolean;
  latestReleaseTagFn?: LatestReleaseTagFn;
  classifyFn?: RefClassifyFn;
}

export type ResolveCoreSourceResult =
  | {
      outcome: "resolved";
      source: CoreSource;
      /** flag-style rendering of what was requested (switch detection). */
      requestedFlag: string;
      /** flag-style rendering of the record, null without a record. */
      recordedFlag: string | null;
      switched: boolean;
    }
  | { outcome: "declined"; requestedFlag: string; recordedFlag: string };

/** True when the record says the core came from a local checkout. */
export function recordIsFromSource(rec: InstallSource | null): boolean {
  return rec !== null && (rec.source === "from-source" || rec.ref === "from-source");
}

export async function resolveCoreSource(
  opts: ResolveCoreSourceOptions,
): Promise<ResolveCoreSourceResult> {
  const rec = opts.installSrc;
  const recordedFlag =
    rec === null ? null : recordedFlagFromInstallSource(rec.channel, rec.ref);

  let source: CoreSource;
  let requestedFlag: string;
  if (opts.fromSource !== undefined) {
    source = { kind: "from-source", path: pathResolve(opts.fromSource) };
    requestedFlag = "from-source";
  } else if (opts.channel !== undefined) {
    const r = await resolveChannel({
      flag: opts.channel,
      latestReleaseTagFn: opts.latestReleaseTagFn,
      classifyFn: opts.classifyFn,
    });
    source = { kind: "channel", channelKind: r.kind, ref: r.ref, tarballUrl: r.tarballUrl };
    requestedFlag = opts.channel;
  } else if (rec !== null && recordIsFromSource(rec)) {
    const path = rec.source_path;
    if (path === null || !existsSync(join(path, "core"))) {
      throw new CoreSourceError(
        `.install-source.json records a from-source install from '${path ?? "(null)"}', ` +
          `which no longer has a core/ directory. Pass --from-source <path> to name the ` +
          `checkout, or --channel <ref> to switch to a GitHub channel.`,
      );
    }
    source = { kind: "from-source", path };
    requestedFlag = "from-source";
  } else {
    const flag = rec === null ? undefined : recordedChannelToFlag(rec.channel, rec.ref);
    const r = await resolveChannel({
      flag,
      latestReleaseTagFn: opts.latestReleaseTagFn,
      classifyFn: opts.classifyFn,
    });
    source = { kind: "channel", channelKind: r.kind, ref: r.ref, tarballUrl: r.tarballUrl };
    requestedFlag = flag ?? recordedChannelToFlag(r.kind, r.ref);
  }

  const switched = recordedFlag !== null && requestedFlag !== recordedFlag;
  if (switched && opts.yes !== true) {
    const promptText = `Switching channel from ${recordedFlag} to ${requestedFlag} will replace ~/.igris/core/. Continue? [y/N]`;
    const confirmed = (opts.confirmFn ?? defaultConfirm)(promptText);
    if (!confirmed) {
      return { outcome: "declined", requestedFlag, recordedFlag: recordedFlag as string };
    }
  }
  return { outcome: "resolved", source, requestedFlag, recordedFlag, switched };
}

/**
 * Convert a recorded channel kind + ref back into a flag-style string for
 * resolveChannel's input, so the SAME channel re-resolves without a flag.
 */
export function recordedChannelToFlag(channel: Channel, ref: string): string {
  if (channel === "main") return "main";
  return ref; // release / tag / branch: the ref verbatim
}

/**
 * What the record effectively reads as for switch detection. A from-source
 * record renders as "from-source", so `--channel main` against it is a
 * legitimate switch and the prompt fires.
 */
export function recordedFlagFromInstallSource(channel: Channel, ref: string): string {
  if (ref === "from-source") return "from-source";
  return recordedChannelToFlag(channel, ref);
}

/**
 * Default confirmation: one line from /dev/tty, "y"/"yes" accepts. Anything
 * else — including no terminal at all — is "no". Tests inject `confirmFn`.
 */
function defaultConfirm(prompt: string): boolean {
  process.stdout.write(prompt + " ");
  try {
    const buf = Buffer.alloc(1024);
    const fd = openSync("/dev/tty", "r");
    const n = readSync(fd, buf, 0, 1024, null);
    closeSync(fd);
    const reply = buf.subarray(0, n).toString("utf-8").trim().toLowerCase();
    return reply === "y" || reply === "yes";
  } catch {
    return false;
  }
}
