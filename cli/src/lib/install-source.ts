/**
 * Read/write `~/.igris/.install-source.json`.
 *
 * Schema (v1):
 *   {
 *     "schema_version": 1,
 *     "channel":  "release" | "main" | "<tag>",
 *     "ref":      "<resolved-ref>" — e.g. "v7.0.0" or "main"
 *     "fetched_at":     "<ISO-8601>",
 *     "content_sha256": "<sha256 of fetched tarball gzip bytes>",
 *     "source": "github" | "from-source" | "cache",
 *     "source_path": null | "<absolute-path-to-source-repo or cached tarball>"
 *   }
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
import type { InstallSource } from "../types.js";

const CURRENT_SCHEMA_VERSION = 1;

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
  // Future migrations: if (v < 2) { ... }

  return cur as InstallSource;
}

export const __testing__ = { CURRENT_SCHEMA_VERSION };
