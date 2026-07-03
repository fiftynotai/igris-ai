/**
 * Channel resolution.
 *
 * Inputs:
 *   - `--channel=main`  → fetches `main` branch tarball; ref = "main".
 *   - `--channel=<x>` (any other non-empty value) → classifies `<x>` against
 *     the GitHub git-ref API: a tag → fetches that tag's tarball (kind "tag");
 *     a branch (e.g. "develop") → fetches that branch's tarball (kind
 *     "branch"); neither → a clear ChannelResolveError (TD-154). Tags are
 *     probed first, so a tag and branch of the same name resolves to the tag.
 *   - default (no flag) → calls GitHub releases-latest API to learn the
 *     current released tag, then fetches that tag's tarball.
 *
 * Tarball URLs:
 *   - main / branch: https://github.com/<owner>/<repo>/archive/refs/heads/<branch>.tar.gz
 *   - tag:           https://github.com/<owner>/<repo>/archive/refs/tags/<tag>.tar.gz
 *
 * The releases-latest API endpoint:
 *   https://api.github.com/repos/<owner>/<repo>/releases/latest
 * The git-ref existence endpoint (TD-154 classification):
 *   https://api.github.com/repos/<owner>/<repo>/git/ref/{tags|heads}/<x>
 *
 * Test seams: `latestReleaseTagFn` swaps the releases-latest API call, and
 * `classifyFn` swaps the tag-vs-branch git-ref probe — both let tests run
 * without real network. Real code reads from GitHub via `node:https`
 * (the TD-124-hardened helpers in `http.ts`).
 *
 * Repository defaults: owner=fiftynotai, repo=igris-ai. Both are env-
 * overridable for fork-based testing (IGRIS_GITHUB_OWNER, IGRIS_GITHUB_REPO).
 */

import type { Channel } from "../types.js";
import { githubRefExists, httpsGetJson } from "./http.js";

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

/**
 * Classification of a `--channel <x>` value against the channel repo (TD-154).
 *
 * - "tag":    `<x>` is a git tag → fetch via {@link tagTarballUrl}.
 * - "branch": `<x>` is a git branch → fetch via {@link headsTarballUrl}.
 * - "none":   `<x>` is neither → resolveChannel throws a clear error.
 */
export type RefClass = "tag" | "branch" | "none";

/**
 * Resolves whether `<x>` is a tag, a branch, or neither in the channel repo.
 * The default implementation ({@link classifyChannelRef}) probes the GitHub
 * git-ref API. Tests inject a fixture-returning fn (mirroring the
 * `latestReleaseTagFn` seam) so no real network is touched.
 */
export type RefClassifyFn = (ref: string) => Promise<RefClass>;

export interface ResolveChannelOptions {
  /** Raw flag value. `undefined` ≡ "default to latest release". */
  flag?: string;
  /** Test seam: swap the releases-latest API call. */
  latestReleaseTagFn?: LatestReleaseTagFn;
  /** Test seam: swap the tag-vs-branch git-ref probe (TD-154). */
  classifyFn?: RefClassifyFn;
}

/**
 * Default tag-vs-branch classifier (TD-154). Probes the GitHub git-ref API via
 * the TD-124-hardened `githubRefExists` helper: checks `tags/<x>` first, then
 * `heads/<x>` on miss. Tags win ties (probed first). A genuine network / 5xx
 * failure mid-probe rejects (with the TD-124 message) rather than masquerading
 * as "none" — only a real 404 from BOTH probes yields "none".
 */
export async function classifyChannelRef(ref: string): Promise<RefClass> {
  if (await githubRefExists(`tags/${ref}`)) {
    return "tag";
  }
  if (await githubRefExists(`heads/${ref}`)) {
    return "branch";
  }
  return "none";
}

/** Build the GitHub tarball URL for an arbitrary branch (refs/heads/<branch>). */
export function headsTarballUrl(branch: string): string {
  return `https://github.com/${repoOwner()}/${repoName()}/archive/refs/heads/${encodeURIComponent(branch)}.tar.gz`;
}

/**
 * Build the GitHub tarball URL for the `main` branch. Thin alias over
 * {@link headsTarballUrl} for the special-cased default branch — preserved as
 * its own export for the existing call sites and the URL-builder test.
 */
export function mainTarballUrl(): string {
  return headsTarballUrl("main");
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
 *   - any other non-empty string → classified via classifyFn (TD-154):
 *       a tag → "tag" channel; a branch → "branch" channel; neither → a
 *       clear ChannelResolveError naming the missing ref (NOT a raw 404).
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

  if (opts.flag.length === 0) {
    throw new ChannelResolveError("--channel value cannot be empty");
  }

  // TD-154: classify the ref as tag-or-branch via the GitHub git-ref API
  // (default) or the injected test seam. Previously every non-main value was
  // treated as a tag verbatim, so `--channel develop` 404'd on a branch.
  const flag = opts.flag;
  const classify = opts.classifyFn ?? classifyChannelRef;
  const cls = await classify(flag);
  if (cls === "tag") {
    return {
      kind: "tag",
      ref: flag,
      tarballUrl: tagTarballUrl(flag),
    };
  }
  if (cls === "branch") {
    return {
      kind: "branch",
      ref: flag,
      tarballUrl: headsTarballUrl(flag),
    };
  }
  throw new ChannelResolveError(
    `no tag or branch named '${flag}' in the channel repo (${repoOwner()}/${repoName()})`,
  );
}

// httpsGetJson + _httpsGetJsonForTest were lifted to `cli/src/lib/http.ts`
// in TD-132 so brain-core-stale.ts could share the TD-124-hardened error
// classification. `fetchLatestReleaseTag` above now imports the helper.
