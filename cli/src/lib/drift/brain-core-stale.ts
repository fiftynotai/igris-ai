/**
 * brain-core-stale drift detector — M5.
 *
 * Detects when a MUTABLE channel (`main` / `branch`) has moved past the commit
 * this brain was installed from: `.install-source.json`'s `ref_commit_sha`
 * against that ref's current head, both 40-hex commit SHAs (TD-301).
 * Immutable channels (`release` / `tag`) are exempt — the ref cannot move, so
 * no network call is made for them.
 *
 * Returns `null` when the brain is at-channel-head OR when we cannot
 * determine staleness (no install-source file, a malformed one, a
 * from-source install, an immutable channel, a record with no
 * `ref_commit_sha` — i.e. every record written before 7.3.2 — or a network
 * failure): staleness is a positive assertion; absence of evidence is not
 * evidence of staleness.
 *
 * Test seam: `latestRefShaFn` is parameterizable so tests can swap the
 * GitHub API call for a fixture-returning function. Real code reads from
 * GitHub via `node:https`.
 */

import { readInstallSource } from "../install-source.js";
import type { Channel, DriftRow } from "../../types.js";
import { fetchRefCommitSha } from "../channel.js";

export interface BrainCoreStaleOptions {
  /** Test seam — swap the GitHub head-SHA fetcher. */
  latestRefShaFn?: (channel: Channel, ref: string) => Promise<string>;
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

  // TD-301: `release`/`tag` name an IMMUTABLE ref — never stale by
  // construction, and no network call. Force-push is knowingly excluded.
  if (installSrc.channel === "release" || installSrc.channel === "tag") {
    return null;
  }

  // A record written before 7.3.2 has no recorded commit; absence joins the
  // other silent arms (no file, malformed, from-source, fetch failure) —
  // staleness is a positive assertion.
  const recordedSha = installSrc.ref_commit_sha ?? "";
  if (recordedSha.length === 0) return null;

  let headSha: string;
  try {
    const fn = opts.latestRefShaFn ?? fetchChannelHeadSha;
    headSha = await fn(installSrc.channel, installSrc.ref);
  } catch {
    // Network failure — we cannot positively assert staleness. Return null
    // (don't flag drift on a flaky network). TD-132: this catch now also
    // swallows ChannelResolveError from the shared http.ts helper, which
    // is intentional — the user-facing contract is "silent on network
    // trouble", and the richer TD-124 error messages are kept for future
    // observability surfaces.
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
 * Resolve this install's channel/ref to the ref path GitHub knows, and ask
 * what commit it points at now. Both sides of the detector's comparison are
 * 40-hex COMMIT SHAs (TD-301). Before TD-301 the recorded side was
 * `content_sha256` — 64 hex, the sha256 of the gzipped tarball — so the
 * comparison could never be true and every github install read as stale; the
 * old text called that "a practical proxy", which it was not. `content_sha256`
 * is not read here at all now (it keeps its cache-key role in `refresh.ts`).
 * Full account: the TD-301 CHANGELOG entry and MAINTAINING.md row 185.
 *
 * `release`/`tag` return null before reaching here, which is what keeps the
 * default install path free of any new network call and is why a force-pushed
 * tag is knowingly not detected. The commits call itself lives in
 * `channel.ts#fetchRefCommitSha`; this wrapper keeps the `(channel, ref)`
 * shape the `latestRefShaFn` test seam has always had.
 */
async function fetchChannelHeadSha(
  channel: Channel,
  ref: string,
): Promise<string> {
  const refPath = channel === "main" ? "main" : ref;
  return fetchRefCommitSha(refPath);
}

// TD-132 lifted httpsGetJson into `http.ts` for shared TD-124 error
// classification; TD-301 moved the fetch itself into channel.ts. The
// classification, the 15s timeout and the caller's `catch { return null }`
// are unchanged.
