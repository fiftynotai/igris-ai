/**
 * GitHub release-tarball fetcher and safe extractor.
 *
 * Three-stage pipeline (per Plan §3 M1.1, brief Architecture):
 *
 *   1. fetch  — HTTPS GET to a GitHub tarball URL, follow up to 5 redirects,
 *               surface non-2xx (e.g. 403 rate limit, 404 unknown ref) as
 *               typed errors. Honors `GITHUB_TOKEN` env var when set
 *               (Risk #1 mitigation: lifts the 60-req/h unauth limit to
 *               5000-req/h authenticated).
 *   2. gunzip — pipe the response body through `node:zlib.createGunzip`.
 *   3. extract — feed the gunzipped stream into `tar.x` with strict-mode
 *               filters: every entry path is resolved against the target
 *               extraction root; entries that resolve OUTSIDE the root
 *               (zip-slip) are rejected and the whole extraction aborts.
 *               We also reject any entry whose normalized path contains
 *               `..` segments OR begins with `/` BEFORE letting `tar`
 *               touch the filesystem.
 *
 * Allow-list: only entries inside `<top>/core/` are written. The
 * GitHub-style top-level prefix dir (e.g. `igris-ai-<sha>/`) is stripped;
 * what lands at the destination is `core/<rest>`. Entries outside `core/`
 * (e.g. `README.md`, `cli/`, `scripts/`) are silently skipped.
 *
 * Caller orchestration: `tarball.ts` extracts INTO a caller-provided dir
 * (typically `~/.igris/core.new.<pid>/`); it never touches `~/.igris/core/`
 * directly. Atomic swap is `atomic-extract.ts`'s concern.
 *
 * SHA-256 streaming: while the tarball bytes are flowing through the
 * pipeline, we accumulate the content hash so the caller can record it
 * in `.install-source.json` AND key the cache directory by it.
 *
 * Test seam: `httpsGet` is exported for tests to swap with a mock that
 * pumps fixture bytes from `cli/src/__tests__/fixtures/tarballs/*.tar.gz`.
 * The boundary is the only mock allowed (L-159: never `vi.mock` the
 * module under test).
 */

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { dirname, resolve as pathResolve, sep } from "node:path";
import {
  Readable,
  Transform,
  pipeline as streamPipeline,
} from "node:stream";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import { c as tarCreate, x as tarExtract } from "tar";
import { readdirSync } from "node:fs";
import { join as pathJoin, relative as pathRelative } from "node:path";

const pipeline = promisify(streamPipeline);

/** Maximum number of redirects to follow before giving up. */
const MAX_REDIRECTS = 5;

/** Default network timeout per request. */
const REQUEST_TIMEOUT_MS = 30_000;

export class TarballError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarballError";
  }
}

export class ZipSlipError extends TarballError {
  /** The offending entry path inside the archive. */
  readonly entryPath: string;
  constructor(entryPath: string) {
    super(
      `Refused to extract entry '${entryPath}': path escapes extraction root (zip-slip).`,
    );
    this.name = "ZipSlipError";
    this.entryPath = entryPath;
  }
}

export class NetworkError extends TarballError {
  /** HTTP status code if available; -1 for transport-level failures. */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "NetworkError";
    this.status = status;
  }
}

/**
 * The contract the verb layer programs against. Tests mock this; real
 * code calls the default `httpsGet` which thinly wraps `node:https`.
 */
export type HttpsGetFn = (url: string) => Promise<Readable>;

/**
 * Test seam (TD-113): when `IGRIS_BLOCK_NETWORK=1`, every real HTTPS fetch
 * throws immediately. Integration tests set this on the SECOND `igris refresh`
 * to PROVE the cache hit short-circuited before any network call — if the
 * cache path were skipped and a fetch were attempted, this fires and the test
 * fails loud. The `file://` fixture seam (`IGRIS_TARBALL_FILE`) is checked
 * BEFORE this guard so a hermetic fixture run is never blocked; only a genuine
 * network attempt trips it.
 */
function networkBlocked(): boolean {
  return process.env.IGRIS_BLOCK_NETWORK === "1";
}

/**
 * Default HTTPS GET. Follows redirects up to MAX_REDIRECTS. Surfaces
 * non-2xx responses as `NetworkError`. The returned readable stream
 * yields the response body bytes.
 *
 * Two test seams short-circuit the real HTTPS request, in this order:
 *   1. `IGRIS_TARBALL_FILE` — stream that local file instead of fetching.
 *      Lets a bats test drive the GitHub code path hermetically (no TLS, no
 *      live GitHub) so the cache-seed-on-init behavior is exercised end-to-end.
 *   2. `IGRIS_BLOCK_NETWORK=1` — throw a NetworkError. Proves a cache HIT
 *      avoided the network (the fixture seam wins, so a legit cached run is
 *      never tripped; only an UNEXPECTED fetch attempt is).
 */
export async function httpsGet(url: string): Promise<Readable> {
  // Seam 1: local-fixture override (hermetic GitHub-path runs).
  const fixture = process.env.IGRIS_TARBALL_FILE;
  if (fixture !== undefined && fixture.length > 0) {
    if (!existsSync(fixture)) {
      throw new TarballError(
        `IGRIS_TARBALL_FILE points at a missing file: ${fixture}`,
      );
    }
    return createReadStream(fixture);
  }
  // Seam 2: hard network block (cache-hit proof).
  if (networkBlocked()) {
    throw new NetworkError(
      `network blocked by IGRIS_BLOCK_NETWORK while fetching ${url} ` +
        `(a cache hit should have avoided this fetch)`,
      -1,
    );
  }

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await singleGet(current);
    if (result.kind === "redirect") {
      current = result.location;
      continue;
    }
    return result.body;
  }
  throw new NetworkError(
    `too many redirects (>${MAX_REDIRECTS}) starting at ${url}`,
    -1,
  );
}

interface SingleGetResult {
  kind: "body" | "redirect";
  body: Readable;
  location: string;
}

function singleGet(url: string): Promise<SingleGetResult> {
  return new Promise<SingleGetResult>((resolveP, rejectP) => {
    const headers: Record<string, string> = {
      "User-Agent": "igris-ai-cli",
      Accept: "application/vnd.github+json,application/octet-stream,*/*;q=0.1",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token !== undefined && token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }

    const opts: RequestOptions = {
      method: "GET",
      headers,
    };

    const req = httpsRequest(url, opts, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location !== undefined) {
        // Drain and discard body, then surface redirect.
        res.resume();
        resolveP({
          kind: "redirect",
          body: res,
          location: new URL(res.headers.location, url).toString(),
        });
        return;
      }
      if (status < 200 || status >= 300) {
        // Drain so the socket can be released.
        res.resume();
        rejectP(
          new NetworkError(
            `GET ${url} -> HTTP ${status} ${res.statusMessage ?? ""}`,
            status,
          ),
        );
        return;
      }
      resolveP({ kind: "body", body: res, location: url });
    });

    req.on("error", (err) => {
      rejectP(new NetworkError(`GET ${url}: ${err.message}`, -1));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`GET ${url}: timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.end();
  });
}

export interface FetchAndExtractOptions {
  /** GitHub tarball URL or local file:// for tests. */
  url: string;
  /** Destination dir; created if absent. Caller is responsible for cleanup. */
  destDir: string;
  /** Optional override for the GET function (test seam). */
  httpsGetFn?: HttpsGetFn;
  /**
   * TD-113 cache-seed TEE: when set, the RAW gzipped tarball bytes are written
   * to this path WHILE they stream through the gunzip→extract pipeline. This is
   * a single-fetch, two-consumer split — the bytes that gunzip consumes are the
   * same bytes that land at `cacheSinkPath`, so the on-disk archive is
   * byte-identical to what GitHub served (and re-hashes to `contentSha256`).
   *
   * The sink is written atomically-enough for our purpose: it is created at the
   * start and only considered valid AFTER the pipeline resolves. On ANY
   * pipeline failure (zip-slip, network, malformed tar) the partial sink is
   * removed so a corrupt half-archive is never cached. The parent dir is
   * created if absent.
   */
  cacheSinkPath?: string;
}

export interface FetchAndExtractResult {
  /** SHA-256 of the gzipped tarball bytes (used as cache key). */
  contentSha256: string;
  /** Number of files extracted into `destDir/core/`. */
  fileCount: number;
}

/**
 * Fetch a tarball over HTTPS (or via the optional fn), gunzip, and extract
 * only entries inside `core/` to `destDir/core/`. Strict-mode rejects any
 * entry whose normalized path contains `..` or begins with `/`.
 *
 * Throws ZipSlipError, NetworkError, or TarballError on failure.
 */
export async function fetchAndExtract(
  opts: FetchAndExtractOptions,
): Promise<FetchAndExtractResult> {
  ensureDestDir(opts.destDir);
  const get = opts.httpsGetFn ?? httpsGet;
  const stream = await get(opts.url);

  const hash = createHash("sha256");
  let fileCount = 0;
  let zipSlipReject: ZipSlipError | null = null;

  // TD-113 cache-seed TEE: a WriteStream that captures the RAW gzip bytes as
  // they flow through `hashTap`. `sinkError` latches the first write error so
  // we can surface it after the pipeline drains; `sinkDone` resolves when the
  // sink has fully flushed to disk (we await BOTH the pipeline and this before
  // declaring success, so `cacheStore` reads a complete file).
  let sink: ReturnType<typeof createWriteStream> | null = null;
  // Holder (not a bare `let`) so the closure assignment below is visible to
  // TS's control-flow analysis at the read site — a bare `let sinkError`
  // assigned only `null` synchronously narrows to `never` after a `!== null`.
  const sinkErr: { err: Error | null } = { err: null };
  let sinkDone: Promise<void> | null = null;
  if (opts.cacheSinkPath !== undefined) {
    const sinkDir = dirname(opts.cacheSinkPath);
    if (!existsSync(sinkDir)) mkdirSync(sinkDir, { recursive: true });
    const s = createWriteStream(opts.cacheSinkPath);
    sink = s;
    sinkDone = new Promise<void>((resolveP) => {
      s.on("error", (err: Error) => {
        if (sinkErr.err === null) sinkErr.err = err;
        resolveP();
      });
      s.on("finish", () => resolveP());
      s.on("close", () => resolveP());
    });
  }

  // Stream pipeline:
  //   stream → hashTap (Transform) → gunzip → tar.x with filter
  // The hash sees the gzipped bytes (matches what GitHub serves). The same
  // chunk is mirrored into `sink` (the cache TEE) before it is passed onward.
  const hashTap = new Transform({
    transform(chunk: Buffer, _enc, cb): void {
      hash.update(chunk);
      if (sink !== null && sinkErr.err === null) {
        // Best-effort: a backpressured write returns false but still buffers;
        // we don't pause the pipeline on it (the archive is ~100KB, the OS
        // buffer absorbs it). A genuine write error latches `sinkErr.err`.
        sink.write(chunk);
      }
      cb(null, chunk);
    },
  });

  const gunzip = createGunzip();
  const extractStream = tarExtract({
    cwd: opts.destDir,
    strict: true,
    filter: (path: string) => {
      // Once an unsafe entry has been seen, the WHOLE archive is
      // considered poisoned: no further entries land on disk. This
      // guarantees the all-or-nothing extraction semantics that the
      // zip-slip test requires (no partial extraction past the
      // rejection point).
      if (zipSlipReject !== null) return false;

      const verdict = isEntrySafe(path, opts.destDir);
      if (verdict.kind === "reject-zip-slip") {
        // Capture the rejection AND return false to refuse this entry.
        // Throwing INSIDE the filter tends to be wrapped by tar's
        // stream machinery and the typed identity is lost; we surface
        // the typed error after the pipeline drains.
        zipSlipReject = new ZipSlipError(verdict.entryPath);
        return false;
      }
      if (verdict.kind === "skip-outside-core") {
        return false;
      }
      fileCount += 1;
      return true;
    },
    // Strip the GitHub top-level prefix dir (e.g. igris-ai-<sha>/) so
    // `core/` lands directly under destDir. tar's `strip` strips
    // exactly N path segments from each entry's beginning.
    strip: 1,
  });

  try {
    await pipeline(stream, hashTap, gunzip, extractStream);
  } catch (err) {
    // The pipeline failed: the cache sink (if any) holds a partial archive —
    // tear it down and remove the file so a corrupt half-download is NEVER
    // promoted into the cache. Failures here are swallowed (the original
    // pipeline error is the one the caller must see).
    await discardSink(sink, sinkDone, opts.cacheSinkPath);
    // If we already recorded a zip-slip rejection, that takes precedence.
    if (zipSlipReject !== null) throw zipSlipReject;
    if (err instanceof ZipSlipError) throw err;
    if (err instanceof NetworkError) throw err;
    throw new TarballError(
      `extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (zipSlipReject !== null) {
    // Same teardown on the post-drain zip-slip surface (strict mode can defer
    // the typed error to here): never cache a rejected archive.
    await discardSink(sink, sinkDone, opts.cacheSinkPath);
    throw zipSlipReject;
  }

  // Success: end the sink and wait for the full flush so the on-disk archive
  // is complete BEFORE the caller hands it to cacheStore. A sink write error
  // (rare: ENOSPC, EACCES) becomes a TarballError so init's cache write is
  // skipped rather than caching a truncated file.
  await finalizeSink(sink, sinkDone);
  if (sinkErr.err !== null) {
    // The extraction itself succeeded; only the TEE failed. Remove the partial
    // sink and surface a typed error — init treats a cache-write failure as
    // non-fatal (it warns and proceeds), so the core swap still happens.
    await discardSink(null, null, opts.cacheSinkPath);
    throw new TarballError(
      `cache sink write failed: ${sinkErr.err.message}`,
    );
  }

  return {
    contentSha256: hash.digest("hex"),
    fileCount,
  };
}

/** End the cache sink and await its flush. No-op when no sink was opened. */
async function finalizeSink(
  sink: ReturnType<typeof createWriteStream> | null,
  sinkDone: Promise<void> | null,
): Promise<void> {
  if (sink === null) return;
  sink.end();
  if (sinkDone !== null) await sinkDone;
}

/**
 * Tear down a partial cache sink and remove its file. Used on the failure
 * paths so a corrupt/partial archive is never left behind for a later
 * findCached() to serve. Swallows its own errors.
 */
async function discardSink(
  sink: ReturnType<typeof createWriteStream> | null,
  sinkDone: Promise<void> | null,
  sinkPath: string | undefined,
): Promise<void> {
  try {
    if (sink !== null) {
      sink.destroy();
      if (sinkDone !== null) await sinkDone;
    }
    if (sinkPath !== undefined && existsSync(sinkPath)) {
      rmSync(sinkPath, { force: true });
    }
  } catch {
    // Best-effort cleanup; never mask the original error.
  }
}

/**
 * Local-fixture variant: read a tarball from disk instead of HTTP. Used
 * by tests AND by the cache-hit path in `cache.ts` when re-extracting
 * an already-fetched archive.
 */
export async function fetchAndExtractFromFile(
  filePath: string,
  destDir: string,
): Promise<FetchAndExtractResult> {
  if (!existsSync(filePath)) {
    throw new TarballError(`tarball not found: ${filePath}`);
  }
  if (!statSync(filePath).isFile()) {
    throw new TarballError(`tarball path is not a file: ${filePath}`);
  }
  return fetchAndExtract({
    url: `file://${filePath}`,
    destDir,
    httpsGetFn: () => Promise.resolve(createReadStream(filePath)),
  });
}

/** Internal: check if a tar entry path is safe to extract under destDir. */
type EntryVerdict =
  | { kind: "accept" }
  | { kind: "reject-zip-slip"; entryPath: string }
  | { kind: "skip-outside-core" };

/**
 * Decide what to do with a tar entry. Important: tar v7's filter is
 * invoked with the PRE-strip path (i.e. it still includes the GitHub
 * top-level prefix dir like `igris-ai-<sha>/`). The `strip` option
 * applies to the on-disk write, not the filter input. So we strip
 * one segment ourselves before applying the allow-list and zip-slip
 * checks. This matches the on-disk truth: the post-strip path is
 * what actually lands under destDir.
 */
function isEntrySafe(entryPath: string, destDir: string): EntryVerdict {
  if (entryPath === "" || entryPath === ".") {
    return { kind: "skip-outside-core" };
  }

  // BEFORE letting tar touch fs, normalize the path string and check
  // for `..` segments OR absolute leading separators. We DO NOT trust
  // tar's own zip-slip handling — defense in depth.
  const normalized = entryPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /(?:^|\/)\.\.(?:\/|$)/.test(normalized)) {
    return { kind: "reject-zip-slip", entryPath };
  }

  // Strip the leading segment (matches tar's `strip: 1`). For entries
  // that have no second segment (e.g. just the top-level prefix dir
  // itself), there's nothing to extract — skip.
  const slashIdx = normalized.indexOf("/");
  if (slashIdx === -1) {
    return { kind: "skip-outside-core" };
  }
  const stripped = normalized.slice(slashIdx + 1);
  if (stripped === "" || stripped === "/") {
    return { kind: "skip-outside-core" };
  }

  // Skip macOS AppleDouble metadata files (`._*`). These appear when
  // the archive was made on a Mac with extended-attribute capture.
  // They're not security-sensitive but they're noise.
  const lastSeg = stripped.split("/").pop()!;
  if (lastSeg.startsWith("._")) {
    return { kind: "skip-outside-core" };
  }

  // Absolute-resolve the would-be destination and verify it stays
  // under destDir. This catches tricky cases like UTF-8 lookalikes
  // for `..` that the regex above might miss.
  const wouldBeDest = pathResolve(destDir, stripped);
  const destWithSep = destDir.endsWith(sep) ? destDir : destDir + sep;
  if (
    wouldBeDest !== destDir &&
    !wouldBeDest.startsWith(destWithSep)
  ) {
    return { kind: "reject-zip-slip", entryPath };
  }

  // Allow-list: only entries inside `core/` are extracted.
  if (!stripped.startsWith("core/") && stripped !== "core" && stripped !== "core/") {
    return { kind: "skip-outside-core" };
  }

  return { kind: "accept" };
}

function ensureDestDir(dir: string): void {
  if (existsSync(dir)) {
    const st = statSync(dir);
    if (!st.isDirectory()) {
      throw new TarballError(
        `destination exists and is not a directory: ${dir}`,
      );
    }
    // Caller responsibility: the dest dir may be a fresh
    // `core.new.<pid>/` and exist already. We do not wipe it; we
    // just write into it. If the caller wants a clean slate they
    // should rm before calling.
  } else {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Convenience: hash a local tarball file (used by tests + cache.ts).
 * Reads the file once; the SHA-256 is over the gzipped bytes,
 * matching what `fetchAndExtract` records in its result.
 */
export async function hashTarballFile(filePath: string): Promise<string> {
  if (!existsSync(filePath)) {
    throw new TarballError(`tarball not found: ${filePath}`);
  }
  return new Promise<string>((resolveP, rejectP) => {
    const h = createHash("sha256");
    const rs = createReadStream(filePath);
    rs.on("data", (c) => h.update(c));
    rs.on("error", rejectP);
    rs.on("end", () => resolveP(h.digest("hex")));
  });
}

/**
 * Wipe a destination dir. Convenience for callers (atomic-extract.ts)
 * that need to start clean before re-extraction.
 */
export function wipeDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// FR-229 — deterministic gzip-tar PACK path (the `igris export` producer).
// ---------------------------------------------------------------------------

/** Recursively collect file paths under `dir`, relative to `dir`, sorted. */
function walkFilesRelative(dir: string): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = pathJoin(abs, entry.name);
      if (entry.isDirectory()) {
        visit(childAbs);
      } else if (entry.isFile()) {
        out.push(pathRelative(dir, childAbs));
      }
    }
  };
  visit(dir);
  // Sort the full file list so the archive's entry order is reproducible across
  // runs regardless of readdir's OS-dependent order (plan §Risks: tar
  // non-determinism).
  return out.sort();
}

/**
 * Gzip-create a DETERMINISTIC tar of `srcDir` at `outPath` (the `.igris-pack`
 * producer). A sorted, recursive file list + `portable`/`noMtime` strip the
 * mtime/uid/gid noise so the same staged dir always packs to the same archive.
 * Only the staged files are packed — no user-controlled paths reach the tar, so
 * there is no repack-side path-injection surface. Wraps failures in
 * {@link TarballError}. Leaves the extract-only path above untouched.
 */
export async function packDir(srcDir: string, outPath: string): Promise<void> {
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new TarballError(`pack source is not a directory: ${srcDir}`);
  }
  const outParent = dirname(outPath);
  if (!existsSync(outParent)) mkdirSync(outParent, { recursive: true });

  const entries = walkFilesRelative(srcDir);
  try {
    await tarCreate(
      {
        gzip: true,
        file: outPath,
        cwd: srcDir,
        portable: true,
        noMtime: true,
      },
      entries,
    );
  } catch (err) {
    throw new TarballError(
      `pack failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
