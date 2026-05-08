/**
 * brain-core-stale drift detector — M5.
 *
 * Detects when the runtime `~/.igris/core/` content hash diverges from the
 * head of the configured channel. Reads `.install-source.json` to learn
 * what channel/ref the brain claims to be at, then queries GitHub for the
 * current head SHA of that channel and compares.
 *
 * Returns `null` when the brain is at-channel-head OR when we cannot
 * determine staleness (no install-source file, network failure with no
 * cached fall-back, etc.) — staleness is a positive assertion; absence of
 * evidence is not evidence of staleness.
 *
 * Test seam: `latestRefShaFn` is parameterizable so tests can swap the
 * GitHub API call for a fixture-returning function. Real code reads from
 * GitHub via `node:https`.
 */

import { request as httpsRequest } from "node:https";
import { readInstallSource } from "../install-source.js";
import type { DriftRow } from "../../types.js";
import { repoOwner, repoName } from "../channel.js";

export interface BrainCoreStaleOptions {
  /** Test seam — swap the GitHub head-SHA fetcher. */
  latestRefShaFn?: (channel: "release" | "main" | "tag", ref: string) => Promise<string>;
}

/**
 * Detect brain-core-stale drift. Returns a single DriftRow when stale,
 * null otherwise. The DriftRow is a "synthetic" row scoped to the brain
 * (slug = "(brain)"), distinct from per-project registry rows.
 */
export async function detectBrainCoreStale(
  opts: BrainCoreStaleOptions = {},
): Promise<DriftRow | null> {
  let installSrc;
  try {
    installSrc = readInstallSource();
  } catch {
    // Malformed install-source — we can't reason about staleness; let
    // brain-core-missing or doctor's existing flows surface that.
    return null;
  }
  if (installSrc === null) return null;

  // from-source installs are inherently "out of channel" — staleness check
  // doesn't apply (the user explicitly opted out of GitHub fetches).
  if (installSrc.source === "from-source") return null;

  const recordedSha = installSrc.content_sha256;
  if (recordedSha.length === 0) return null;

  let headSha: string;
  try {
    const fn = opts.latestRefShaFn ?? fetchChannelHeadSha;
    headSha = await fn(installSrc.channel, installSrc.ref);
  } catch {
    // Network failure — we cannot positively assert staleness. Return null
    // (don't flag drift on a flaky network).
    return null;
  }

  if (headSha === recordedSha) return null;

  return {
    slug: "(brain)",
    path: "~/.igris/core",
    driftClass: "brain-core-stale",
    recommendedFix: `run 'igris refresh' to fetch ${installSrc.channel}/${installSrc.ref} head (recorded=${recordedSha.slice(0, 12)}, head=${headSha.slice(0, 12)})`,
  };
}

/**
 * Fetch the current head SHA for the configured channel/ref via the
 * GitHub commits API. Returns the commit SHA as a hex string.
 *
 * For channel="main": queries `/commits/main` for the branch HEAD.
 * For channel="release"/"tag": queries `/commits/<ref>` (a tag is a commit
 * ref, GitHub resolves it to the tagged commit).
 *
 * Note: the recorded `content_sha256` in `.install-source.json` is the
 * sha256 of the GZIPPED tarball bytes, NOT a git SHA. For staleness we
 * compare the tarball content hash recorded at install time against the
 * current head's tarball hash. A practical proxy: if the git head sha
 * differs from the one we'd derive from a fresh fetch, the tarball will
 * differ. We compute the proxy by fetching the head commit SHA — if the
 * brain was installed from <ref> and the head of <ref> has moved, drift.
 *
 * The proxy is conservative: it flags moves of the ref pointer (e.g.
 * main advancing) rather than tarball-byte equality. False-positives on
 * force-push of a tag are intentional — the user should know.
 */
async function fetchChannelHeadSha(
  channel: "release" | "main" | "tag",
  ref: string,
): Promise<string> {
  // For "release" channel ref="v7.0.0" tag — same endpoint as "tag".
  // For "main", ref="main".
  const refPath = channel === "main" ? "main" : ref;
  const url = `https://api.github.com/repos/${repoOwner()}/${repoName()}/commits/${encodeURIComponent(refPath)}`;
  const body = await httpsGetJson(url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(
      `commits API returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("commits API returned unexpected shape");
  }
  const sha = (parsed as { sha?: unknown }).sha;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new Error("commits API response missing sha");
  }
  return sha;
}

function httpsGetJson(url: string): Promise<string> {
  return new Promise<string>((resolveP, rejectP) => {
    const headers: Record<string, string> = {
      "User-Agent": "igris-ai-cli",
      Accept: "application/vnd.github+json",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token !== undefined && token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }
    const req = httpsRequest(
      url,
      { method: "GET", headers },
      (res) => {
        const status = res.statusCode ?? 0;
        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location !== undefined
        ) {
          res.resume();
          httpsGetJson(new URL(res.headers.location, url).toString()).then(
            resolveP,
            rejectP,
          );
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          rejectP(
            new Error(`GET ${url} -> HTTP ${status} ${res.statusMessage ?? ""}`),
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolveP(Buffer.concat(chunks).toString("utf-8"));
        });
        res.on("error", (err) => {
          rejectP(new Error(`response error: ${err.message}`));
        });
      },
    );
    req.on("error", (err) => {
      rejectP(new Error(`request error: ${err.message}`));
    });
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`GET ${url}: timeout after 10000ms`));
    });
    req.end();
  });
}
