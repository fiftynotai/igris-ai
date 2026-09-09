/**
 * FR-238 — static-bundle resolution and serving for the dashboard.
 *
 * The bundle root is `cli/dist/dashboard/`, resolved by the same walk-up idiom
 * `bundledMcpEntryPath()` already proves in production (R1(d)). That matters
 * for a global install: `dirname(fileURLToPath(import.meta.url))` resolves
 * THROUGH a symlinked npm bin to the real package directory.
 *
 * Everything here is read-only and same-origin. There is no upload path, no
 * directory listing, and no way to escape the bundle root via the REQUEST PATH
 * — see the SCOPE LIMIT note on the traversal guard below, which states what
 * the lexical check does and does not cover.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { dashboardBundleDir } from "../paths.js";
import { SECURITY_HEADERS } from "./headers.js";

/**
 * Content types for everything the bundle can contain.
 *
 * An allowlist, not a lookup-with-fallback-to-guessing: an unknown extension
 * gets `application/octet-stream`, which a browser will download rather than
 * execute.
 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export function contentTypeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function bundleRoot(): string {
  return dashboardBundleDir();
}

export function bundleIndexPath(): string {
  return join(bundleRoot(), "index.html");
}

/** True when a built bundle is actually present to serve. */
export function bundlePresent(): boolean {
  return existsSync(bundleIndexPath());
}

export type ResolveResult =
  | { kind: "file"; path: string }
  | { kind: "traversal" }
  | { kind: "missing" };

/**
 * Map a request pathname onto a file inside the bundle root.
 *
 * Two independent guards, both required:
 *  1. `normalize` collapses `..` segments BEFORE the join, so a crafted
 *     `/assets/../../../etc/passwd` cannot walk out.
 *  2. The resolved absolute path must still start with the resolved root plus a
 *     separator. This catches the sibling-prefix case (`/tmp/dist-evil` vs
 *     `/tmp/dist`) that a bare `startsWith(root)` would let through.
 *
 * SCOPE LIMIT, stated so nobody reads more into this than it does: the check is
 * LEXICAL. It does not call `realpath`, so a SYMLINK planted inside the bundle
 * root that points outside it would resolve and be served. That is not
 * exploitable here — `dist/dashboard/` is a build artifact this package
 * produces, and anyone able to plant a symlink in it can already edit the
 * served JS — so adding a `realpathSync` per request buys nothing today. If
 * this server ever serves a directory the user can write to, that changes and
 * the check must become physical.
 */
export function resolveStatic(pathname: string): ResolveResult {
  const root = resolve(bundleRoot());
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: "traversal" };
  }
  // A NUL byte truncates paths in some syscalls — refuse outright.
  if (decoded.includes("\0")) return { kind: "traversal" };

  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const target = resolve(join(root, rel));

  if (target !== root && !target.startsWith(root + sep)) {
    return { kind: "traversal" };
  }
  if (!existsSync(target)) return { kind: "missing" };
  if (statSync(target).isDirectory()) {
    const index = join(target, "index.html");
    return existsSync(index) ? { kind: "file", path: index } : { kind: "missing" };
  }
  return { kind: "file", path: target };
}

/**
 * Stream a file with its content type.
 *
 * Hashed assets under `assets/` are immutable by construction (Vite puts the
 * content hash in the filename), so they get a long max-age. Everything else —
 * `index.html` above all — is `no-cache`, because a stale shell against a fresh
 * API is the exact "reload shows old state" failure the AC forbids.
 */
export function serveFile(res: ServerResponse, path: string): void {
  const isHashedAsset = path.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "Content-Type": contentTypeFor(path),
    "Cache-Control": isHashedAsset
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    ...SECURITY_HEADERS,
  });
  const stream = createReadStream(path);
  stream.on("error", () => {
    res.destroy();
  });
  stream.pipe(res);
}
