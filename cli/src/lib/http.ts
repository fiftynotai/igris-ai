/**
 * Shared HTTPS GET helper for GitHub API calls. Consumed by:
 *   - cli/src/lib/channel.ts (release-tag fetcher)
 *   - cli/src/lib/drift/brain-core-stale.ts (commits-API head-SHA fetcher)
 *
 * Origin: extracted in TD-132 from channel.ts (TD-127 seam) so brain-core-
 * stale.ts can stop maintaining a divergent helper. Both call sites now
 * share the TD-124-hardened error classification (404 / 5xx / network /
 * timeout each surface a distinct ChannelResolveError message).
 *
 * Test seam: `_httpsGetJsonForTest(url, requestFn)` lets tests substitute
 * `node:http` against a loopback server (no TLS plumbing). Production
 * callers should always use `httpsGetJson`. (TD-127 origin.)
 *
 * Note on `ChannelResolveError` location: the error class lives in
 * `channel.ts` (its semantic origin). This file imports it from there;
 * channel.ts imports `httpsGetJson` from here. The cycle is one-way at
 * load time (http.ts only reads the *type* from channel.ts at definition
 * time, and the *value* at throw time — by then both modules are loaded)
 * and is benign in ES modules. See TD-132 plan §2 Option A.
 */

import { request as httpsRequest } from "node:https";
import { ChannelResolveError, repoOwner, repoName } from "./channel.js";

/** Test seam: same shape as `node:https`'s `request`. Tests can pass a
 *  `node:http`-flavored function pointing at a loopback server. */
export type HttpsRequestFn = typeof httpsRequest;

/**
 * Production HTTPS GET. Honors GITHUB_TOKEN for rate-limit headroom (Risk
 * #1). Buffers response as UTF-8 string. Follows one level of redirect.
 */
export function httpsGetJson(url: string): Promise<string> {
  return _httpsGetJsonForTest(url, httpsRequest);
}

/**
 * Test seam — same as `httpsGetJson` but with the request factory injected,
 * letting tests substitute `node:http` against a loopback server (no TLS
 * plumbing). The `_` prefix marks this as not-public-API; callers outside
 * tests should always use `httpsGetJson`. (TD-127 origin; lifted to
 * `http.ts` in TD-132.)
 */
export function _httpsGetJsonForTest(
  url: string,
  requestFn: HttpsRequestFn,
): Promise<string> {
  return new Promise<string>((resolveP, rejectP) => {
    const headers: Record<string, string> = {
      "User-Agent": "igris-ai-cli",
      Accept: "application/vnd.github+json",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token !== undefined && token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }
    const req = requestFn(
      url,
      { method: "GET", headers },
      (res) => {
        const status = res.statusCode ?? 0;
        // Follow one level of redirect (api.github.com sometimes 301s).
        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location !== undefined
        ) {
          res.resume();
          _httpsGetJsonForTest(
            new URL(res.headers.location, url).toString(),
            requestFn,
          ).then(resolveP, rejectP);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          // TD-124: distinguish three failure modes so the user sees an
          // actionable message rather than a raw status line.
          if (status === 404) {
            rejectP(
              new ChannelResolveError(
                `No release published yet for ${repoOwner()}/${repoName()}. ` +
                  `Try --channel main for the leading edge, or wait for a tagged release.`,
              ),
            );
            return;
          }
          if (status >= 500 && status < 600) {
            rejectP(
              new ChannelResolveError(
                `GitHub API returned HTTP ${status} ${res.statusMessage ?? ""} (transient — retry in a moment).`,
              ),
            );
            return;
          }
          rejectP(
            new ChannelResolveError(
              `GET ${url} -> HTTP ${status} ${res.statusMessage ?? ""}`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolveP(Buffer.concat(chunks).toString("utf-8"));
        });
        res.on("error", (err) => {
          rejectP(new ChannelResolveError(`response error: ${err.message}`));
        });
      },
    );
    req.on("error", (err) => {
      // TD-124: surface the network-level failure as "unreachable" so the
      // user knows it's a connectivity issue, not a remote-side rejection.
      rejectP(
        new ChannelResolveError(
          `GitHub API unreachable (${err.message}). Check network connectivity or use --channel main with a local --from-source if offline.`,
        ),
      );
    });
    req.setTimeout(15_000, () => {
      req.destroy(
        new ChannelResolveError(`GET ${url}: timeout after 15000ms`),
      );
    });
    req.end();
  });
}

/**
 * Existence probe against the GitHub git-ref API (TD-154).
 *
 * `httpsGetJson` collapses a 404 into a thrown release-flavored
 * `ChannelResolveError` — that's correct for the releases-latest fetch (a 404
 * there genuinely means "no release"), but WRONG for ref classification, where
 * a 404 is the expected "this ref doesn't exist, try the next ref-kind" signal.
 * So this probe returns a boolean instead of throwing on 404, while still
 * surfacing genuine network / 5xx failures as `ChannelResolveError` (the same
 * TD-124 classification) so a mid-classification GitHub outage isn't silently
 * swallowed into a false "ref absent".
 *
 * `refPath` is the ref-API suffix WITHOUT the leading slash, e.g.
 * `tags/v7.0.0` or `heads/develop`. Returns `true` on HTTP 200, `false` on
 * HTTP 404, and rejects on anything else.
 */
export function githubRefExists(refPath: string): Promise<boolean> {
  const url = `https://api.github.com/repos/${repoOwner()}/${repoName()}/git/ref/${refPath}`;
  return _githubRefExistsForTest(url, httpsRequest);
}

/**
 * Test seam for {@link githubRefExists}. Same request plumbing as
 * `_httpsGetJsonForTest` (User-Agent, GITHUB_TOKEN, one redirect hop, 15s
 * timeout, network-error classification) but maps the status code to a
 * boolean rather than buffering a body. The `_` prefix marks this not-public;
 * production callers use `githubRefExists`.
 */
export function _githubRefExistsForTest(
  url: string,
  requestFn: HttpsRequestFn,
): Promise<boolean> {
  return new Promise<boolean>((resolveP, rejectP) => {
    const headers: Record<string, string> = {
      "User-Agent": "igris-ai-cli",
      Accept: "application/vnd.github+json",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token !== undefined && token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }
    const req = requestFn(
      url,
      { method: "GET", headers },
      (res) => {
        const status = res.statusCode ?? 0;
        // Follow one level of redirect (api.github.com sometimes 301s).
        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location !== undefined
        ) {
          res.resume();
          _githubRefExistsForTest(
            new URL(res.headers.location, url).toString(),
            requestFn,
          ).then(resolveP, rejectP);
          return;
        }
        res.resume();
        if (status === 200) {
          resolveP(true);
          return;
        }
        if (status === 404) {
          // Expected "ref absent" — a boolean answer, NOT an error.
          resolveP(false);
          return;
        }
        // TD-124: genuine remote failure — distinguish 5xx (transient) from
        // any other unexpected status so the user sees an actionable message.
        if (status >= 500 && status < 600) {
          rejectP(
            new ChannelResolveError(
              `GitHub API returned HTTP ${status} ${res.statusMessage ?? ""} (transient — retry in a moment).`,
            ),
          );
          return;
        }
        rejectP(
          new ChannelResolveError(
            `GET ${url} -> HTTP ${status} ${res.statusMessage ?? ""}`,
          ),
        );
      },
    );
    req.on("error", (err) => {
      // TD-124: surface the network-level failure as "unreachable".
      rejectP(
        new ChannelResolveError(
          `GitHub API unreachable (${err.message}). Check network connectivity or use --channel main with a local --from-source if offline.`,
        ),
      );
    });
    req.setTimeout(15_000, () => {
      req.destroy(
        new ChannelResolveError(`GET ${url}: timeout after 15000ms`),
      );
    });
    req.end();
  });
}
