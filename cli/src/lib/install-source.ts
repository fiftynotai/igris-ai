/**
 * Read/write `~/.igris/.install-source.json`.
 *
 * Schema (v2 — TD-301, 2026-09-08):
 *   {
 *     "schema_version": 2,
 *     "channel":  "release" | "main" | "tag" | "branch",
 *     "ref":      "<resolved-ref>" — e.g. "v7.0.0" or "main"
 *     "fetched_at":     "<ISO-8601>",
 *     "content_sha256": "<sha256 of fetched tarball gzip bytes>",
 *     "ref_commit_sha": "<40-hex commit SHA of ref at fetch time>"  OPTIONAL,
 *     "source": "github" | "from-source" | "cache",
 *     "source_path": null | "<absolute-path-to-source-repo or cached tarball>"
 *   }
 *
 * `ref_commit_sha` (v2, TD-301) is written ONLY for a github install on a
 * MUTABLE channel (`main`/`branch`) — only there can a ref move under a fixed
 * name. ABSENT (every 7.3.1-and-earlier record) reads as NOT stale.
 *
 * The schema is deliberately small. Channel resolution happens in
 * `channel.ts`; this module only persists the result. Forward-only
 * migration mirrors `installed-features.ts`.
 *
 * Atomic write: tmp + rename. The file lives at brain root, NOT under
 * `core/`, because it describes how `core/` was assembled — surviving
 * an `igris init --upgrade` swap intact.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { installSourcePath } from "./paths.js";
import { fetchRefCommitSha } from "./channel.js";
import type { Channel, InstallSource } from "../types.js";

const CURRENT_SCHEMA_VERSION = 2;

export function readInstallSource(): InstallSource | null {
  const path = installSourcePath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  let parsed: Partial<InstallSource>;
  try {
    parsed = JSON.parse(raw) as Partial<InstallSource>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `install-source file is malformed at ${path}: ${msg}. Delete it and re-run 'igris refresh' to recover.`,
    );
  }
  return migrateForwardOnly(parsed);
}

export function writeInstallSource(record: InstallSource): void {
  const path = installSourcePath();
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, path);
}

export function migrateForwardOnly(
  raw: Partial<InstallSource>,
): InstallSource {
  const v = (raw.schema_version as number | undefined) ?? 0;
  let cur: Partial<InstallSource> = { ...raw };

  if (v < 1) {
    cur = {
      schema_version: 1,
      channel: cur.channel ?? "release",
      ref: cur.ref ?? "unknown",
      fetched_at: cur.fetched_at ?? new Date().toISOString(),
      content_sha256: cur.content_sha256 ?? "",
      source: cur.source ?? "github",
      source_path: cur.source_path ?? null,
    };
  }
  if (v < 2) {
    // TD-301: invents NO value. A v1 record has no recorded ref commit and
    // nothing to derive one from; it stays ABSENT, which reads as "not
    // stale". `refresh` backfills it for a mutable channel.
    cur = { ...cur, schema_version: 2 };
  }
  // Future migrations: if (v < 3) { ... }

  return cur as InstallSource;
}

/** Channels whose ref can move under a fixed name (TD-301). */
const MUTABLE_CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  "main",
  "branch",
]);

export interface RecordRefCommitShaOptions {
  /** Test seam — swap the GitHub commits-API fetcher. */
  fetchFn?: (refPath: string) => Promise<string>;
}

/**
 * Best-effort commit lookup for the record writers (`init`, `refresh`).
 * TD-301. Returns `undefined` — with NO network call — unless this is a github
 * install on a mutable channel, and `undefined` on ANY fetch error: an install
 * must never fail because a diagnostic field could not be fetched.
 */
export async function recordRefCommitSha(
  channel: Channel,
  ref: string,
  source: InstallSource["source"],
  opts: RecordRefCommitShaOptions = {},
): Promise<string | undefined> {
  if (source !== "github") return undefined;
  if (!MUTABLE_CHANNELS.has(channel)) return undefined;
  const refPath = channel === "main" ? "main" : ref;
  try {
    const sha = await (opts.fetchFn ?? fetchRefCommitSha)(refPath);
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

export const __testing__ = { CURRENT_SCHEMA_VERSION };
