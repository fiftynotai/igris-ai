/**
 * Tarball cache.
 *
 * Layout:
 *   ~/.igris/.cache/
 *     <sha256>/
 *       tarball.tar.gz       — the raw fetched bytes
 *       extracted/           — extracted core/ tree (re-usable on cache hit)
 *       meta.json            — { fetched_at, channel, ref, ttl_ms }
 *
 * Keying: SHA-256 of the gzipped tarball bytes. The cache only
 * acts on a re-fetch when the bytes match exactly, so a `main`
 * tarball that has been recompressed silently doesn't collide with
 * a fresh fetch.
 *
 * TTL: 24h for `main` channel (the bytes change daily-ish), infinite
 * for tagged releases (immutable). The TTL is checked at READ time
 * by inspecting `meta.json#fetched_at`. Caller can override via
 * `cacheTtlMs` (used for tests).
 *
 * The cache is read-only on the hot path: writes happen exactly once
 * after a successful network fetch. The verb layer calls
 * `findCached(sha256)` first, then proceeds with `tarball.fetchAndExtract`
 * if it returns null. After extraction the verb writes via
 * `cacheStore(sha256, ...)`.
 *
 * Test seam: all paths derive from `cacheDir()` in `paths.ts`, which
 * honors `IGRIS_BRAIN_DIR`. Tests pass through tmp dirs without any
 * other override.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./paths.js";
import type { Channel } from "../types.js";

/** TTL constants. */
export const TTL_MAIN_MS = 24 * 60 * 60 * 1000; // 24h for `main` channel
/**
 * Sentinel: any negative `ttl_ms` means "never expires". We use -1 in
 * meta.json for tagged releases because `JSON.stringify(Infinity)` is
 * `null`, which would round-trip to a falsy that downstream arithmetic
 * misreads as 0.
 */
export const TTL_INFINITE = -1;

export interface CacheMeta {
  schema_version: number;
  fetched_at: string;
  channel: Channel;
  ref: string;
  ttl_ms: number;
}

const CURRENT_SCHEMA = 1;

/** Build the cache entry root for a given content sha. */
export function cacheEntryDir(sha256: string): string {
  return join(cacheDir(), sha256);
}

/** Path to the raw archive bytes inside a cache entry. */
export function cacheTarballPath(sha256: string): string {
  return join(cacheEntryDir(sha256), "tarball.tar.gz");
}

/** Path to the extracted dir inside a cache entry. */
export function cacheExtractedPath(sha256: string): string {
  return join(cacheEntryDir(sha256), "extracted");
}

/** Path to the cache entry's meta.json. */
export function cacheMetaPath(sha256: string): string {
  return join(cacheEntryDir(sha256), "meta.json");
}

/**
 * Look up a cached entry by sha. Returns null on miss OR on TTL expiry.
 * The TTL is read from meta.json. If `now` is provided, that's the
 * reference time (test seam); else `Date.now()`.
 */
export function findCached(
  sha256: string,
  now?: number,
): { meta: CacheMeta; tarballPath: string; extractedPath: string } | null {
  const dir = cacheEntryDir(sha256);
  if (!existsSync(dir)) return null;
  const metaPath = cacheMetaPath(sha256);
  if (!existsSync(metaPath)) return null;

  let meta: CacheMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8")) as CacheMeta;
  } catch {
    // Corrupt meta — treat as miss; caller may decide to evict.
    return null;
  }

  const fetchedMs = Date.parse(meta.fetched_at);
  const refNow = now ?? Date.now();
  // Negative ttl is the "never expires" sentinel (see TTL_INFINITE).
  const ttl = meta.ttl_ms;
  const expired =
    !isNaN(fetchedMs) &&
    typeof ttl === "number" &&
    ttl >= 0 &&
    refNow - fetchedMs > ttl;
  if (expired) {
    return null;
  }
  return {
    meta,
    tarballPath: cacheTarballPath(sha256),
    extractedPath: cacheExtractedPath(sha256),
  };
}

export interface CacheStoreOptions {
  /** Path to the freshly-fetched tarball (will be COPIED into the cache). */
  tarballSourcePath: string;
  /** Path to the freshly-extracted dir (will be COPIED into the cache). */
  extractedSourcePath: string;
  channel: Channel;
  ref: string;
  /** Override TTL; default picks 24h for main, infinite for tag/release. */
  ttlMs?: number;
}

/**
 * Persist a tarball + extracted dir into the cache, keyed by sha.
 * Idempotent: if the entry already exists, the contents are
 * overwritten — this matches the "re-fetch on TTL expiry" lifecycle.
 */
export function cacheStore(sha256: string, opts: CacheStoreOptions): void {
  const dir = cacheEntryDir(sha256);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });

  // Copy tarball.
  if (!existsSync(opts.tarballSourcePath)) {
    throw new Error(
      `cacheStore: tarball source missing: ${opts.tarballSourcePath}`,
    );
  }
  copyFileSync(opts.tarballSourcePath, cacheTarballPath(sha256));

  // Copy extracted tree.
  if (!existsSync(opts.extractedSourcePath)) {
    throw new Error(
      `cacheStore: extracted source missing: ${opts.extractedSourcePath}`,
    );
  }
  if (!statSync(opts.extractedSourcePath).isDirectory()) {
    throw new Error(
      `cacheStore: extracted source is not a directory: ${opts.extractedSourcePath}`,
    );
  }
  cpSync(opts.extractedSourcePath, cacheExtractedPath(sha256), {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });

  // Write meta.
  const ttl =
    opts.ttlMs ?? (opts.channel === "main" ? TTL_MAIN_MS : TTL_INFINITE);
  const meta: CacheMeta = {
    schema_version: CURRENT_SCHEMA,
    fetched_at: new Date().toISOString(),
    channel: opts.channel,
    ref: opts.ref,
    ttl_ms: ttl,
  };
  writeFileSync(cacheMetaPath(sha256), JSON.stringify(meta, null, 2) + "\n");
}

/**
 * Evict a single cache entry by sha. Used by `igris doctor --fix` if
 * the entry is corrupt; tests use it to clear state between cases.
 */
export function cacheEvict(sha256: string): void {
  const dir = cacheEntryDir(sha256);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Evict the entire cache. Used by `igris doctor --fix` when the
 * cache schema bumps.
 */
export function cacheEvictAll(): void {
  const dir = cacheDir();
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** List currently-cached SHA-256 keys (used by `igris doctor`). */
export function cacheListShas(): string[] {
  const dir = cacheDir();
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => /^[0-9a-f]{64}$/.test(e));
}
