/**
 * Channel resolution.
 *
 * Inputs:
 *   - `--channel=main`  → fetches `main` branch tarball; ref = "main".
 *   - `--channel=v7.0.0` (or any tag) → fetches that tag's tarball; ref = "v7.0.0".
 *   - default (no flag) → calls GitHub releases-latest API to learn the
 *     current released tag, then fetches that tag's tarball.
 *
 * Tarball URLs:
 *   - main:    https://github.com/<owner>/<repo>/archive/refs/heads/main.tar.gz
 *   - tag:     https://github.com/<owner>/<repo>/archive/refs/tags/<tag>.tar.gz
 *
 * The releases-latest API endpoint:
 *   https://api.github.com/repos/<owner>/<repo>/releases/latest
 *
 * Test seam: `latestReleaseTagFn` is parameterizable so tests can swap
 * the API call with a fixture-returning function. Real code reads from
 * GitHub via `node:https`.
 *
 * Repository defaults: owner=fiftynotai, repo=igris-ai. Both are env-
 * overridable for fork-based testing (IGRIS_GITHUB_OWNER, IGRIS_GITHUB_REPO).
 */

import type { Channel } from "../types.js";
import { httpsGetJson } from "./http.js";

export const DEFAULT_OWNER = "fiftynotai";
export const DEFAULT_REPO = "igris-ai";

export class ChannelResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelResolveError";
  }
}

export function repoOwner(): string {
  const v = process.env.IGRIS_GITHUB_OWNER;
  return v !== undefined && v.length > 0 ? v : DEFAULT_OWNER;
}

export function repoName(): string {
  const v = process.env.IGRIS_GITHUB_REPO;
  return v !== undefined && v.length > 0 ? v : DEFAULT_REPO;
}

/**
 * Resolved channel target — what the verb layer actually needs to know
 * to fetch a tarball.
 */
export interface ResolvedChannel {
  /** Logical kind. */
  kind: Channel;
  /** Concrete ref to fetch (tag name or "main"). */
  ref: string;
  /** URL to GET. */
  tarballUrl: string;
}

export type LatestReleaseTagFn = () => Promise<string>;

export interface ResolveChannelOptions {
  /** Raw flag value. `undefined` ≡ "default to latest release". */
  flag?: string;
  /** Test seam. */
  latestReleaseTagFn?: LatestReleaseTagFn;
}

/** Build the GitHub tarball URL for a `main` branch fetch. */
export function mainTarballUrl(): string {
  return `https://github.com/${repoOwner()}/${repoName()}/archive/refs/heads/main.tar.gz`;
}

/** Build the GitHub tarball URL for a specific tag. */
export function tagTarballUrl(tag: string): string {
  return `https://github.com/${repoOwner()}/${repoName()}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`;
}

/** Default fetch of the `latest` release tag from GitHub. */
export async function fetchLatestReleaseTag(): Promise<string> {
  const url = `https://api.github.com/repos/${repoOwner()}/${repoName()}/releases/latest`;
  const body = await httpsGetJson(url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new ChannelResolveError(
      `latest release API returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ChannelResolveError(
      `latest release API returned unexpected shape (not an object).`,
    );
  }
  const tagName = (parsed as { tag_name?: unknown }).tag_name;
  if (typeof tagName !== "string" || tagName.length === 0) {
    throw new ChannelResolveError(
      `latest release API response missing tag_name; got: ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }
  return tagName;
}

/**
 * Resolve a channel flag to a fetchable URL + ref.
 *
 * Channel grammar:
 *   - undefined → "release" channel via latestReleaseTagFn().
 *   - "main"    → "main" channel.
 *   - any other string → "tag" channel; treated as a tag name verbatim.
 */
export async function resolveChannel(
  opts: ResolveChannelOptions = {},
): Promise<ResolvedChannel> {
  if (opts.flag === undefined) {
    const fn = opts.latestReleaseTagFn ?? fetchLatestReleaseTag;
    const tag = await fn();
    return {
      kind: "release",
      ref: tag,
      tarballUrl: tagTarballUrl(tag),
    };
  }

  if (opts.flag === "main") {
    return {
      kind: "main",
      ref: "main",
      tarballUrl: mainTarballUrl(),
    };
  }

  // Treat anything else as a tag name. We do NOT call the API to verify
  // the tag exists — fetch will fail with a 404 NetworkError if it
  // doesn't, and the message will surface that to the user.
  if (opts.flag.length === 0) {
    throw new ChannelResolveError("--channel value cannot be empty");
  }
  return {
    kind: "tag",
    ref: opts.flag,
    tarballUrl: tagTarballUrl(opts.flag),
  };
}

// httpsGetJson + _httpsGetJsonForTest were lifted to `cli/src/lib/http.ts`
// in TD-132 so brain-core-stale.ts could share the TD-124-hardened error
// classification. `fetchLatestReleaseTag` above now imports the helper.
