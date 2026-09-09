/**
 * brain-core-stale drift detector tests — M5, rewritten for TD-301 (2026-09-08).
 *
 * Hermetic. Mocks the GitHub API call via the `latestRefShaFn` test seam
 * so no network is hit. Real install-source.json on tmp fs. Both HOME and
 * IGRIS_BRAIN_DIR are fenced so the suite can never read or write the
 * operator's real `~/.igris/.install-source.json`.
 *
 * TD-301 shape rule (L-1569): the detector compares two values, so every
 * fixture pins the SHAPE of BOTH sides — a git commit SHA is 40 lowercase
 * hex, a tarball `content_sha256` is 64 lowercase hex, and no case puts the
 * SAME literal on both sides of the comparison. The pre-TD-301 case
 * "returns null when recorded sha matches head sha" did exactly that with
 * `"matching-sha-1234"`, which is why a comparison that can NEVER be true
 * read as tested; it is replaced by U-1…U-9 below (dated reason,
 * test_standards convention 6).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBrainCoreStale } from "../lib/drift/brain-core-stale.js";
import { writeInstallSource } from "../lib/install-source.js";
import { ChannelResolveError } from "../lib/channel.js";

/** 40-hex git commit SHA (side A). */
const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
/** 40-hex git commit SHA (side B) — never equal to A. */
const SHA_B = "b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f80";
/** 64-hex sha256 of a gzipped tarball — the OTHER hash type entirely. */
const CONTENT_SHA =
  "d1aa7cae3f92b6045e8c17da29bf60e34c5178ab90de2f4361a7c8b5e0d93f26";

let brainRoot: string;
const envBackup: Record<string, string | undefined> = {};

/** A counting wrapper so a test can assert the seam FIRED (armed-guard rule). */
function countingFn(impl: () => Promise<string>) {
  const state = { calls: 0 };
  const fn = async () => {
    state.calls += 1;
    return impl();
  };
  return { fn, state };
}

beforeEach(() => {
  brainRoot = mkdtempSync(join(tmpdir(), "igris-stale-"));
  mkdirSync(join(brainRoot, "core"), { recursive: true });
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  envBackup.HOME = process.env.HOME;
  process.env.IGRIS_BRAIN_DIR = brainRoot;
  process.env.HOME = brainRoot;
});

afterEach(() => {
  rmSync(brainRoot, { recursive: true, force: true });
  // Restore BY KEY (never `process.env = saved`, which breaks os.homedir()).
  if (envBackup.IGRIS_BRAIN_DIR === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
  if (envBackup.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = envBackup.HOME;
});

describe("brain-core-stale", () => {
  it("fixture shapes: a commit SHA is 40-hex, content_sha256 is 64-hex, and they can never be equal", () => {
    // The pin that makes the rest of this file meaningful (TD-301 / L-1569):
    // the defect was a comparison between two different hash TYPES.
    expect(SHA_A).toMatch(/^[0-9a-f]{40}$/);
    expect(SHA_B).toMatch(/^[0-9a-f]{40}$/);
    expect(SHA_A).not.toBe(SHA_B);
    expect(CONTENT_SHA).toMatch(/^[0-9a-f]{64}$/);
    expect(CONTENT_SHA.length).not.toBe(SHA_A.length);
    expect(CONTENT_SHA).not.toBe(SHA_A);
  });

  it("returns null when .install-source.json is absent", async () => {
    const r = await detectBrainCoreStale({
      latestRefShaFn: async () => SHA_A,
    });
    expect(r).toBeNull();
  });

  // U-1 — a `release` record is never stale: the ref is immutable.
  it("U-1: returns null for a release-channel record (immutable ref)", async () => {
    writeInstallSource({
      schema_version: 2,
      channel: "release",
      ref: "v7.3.1",
      fetched_at: new Date().toISOString(),
      content_sha256: CONTENT_SHA,
      source: "github",
      source_path: null,
    });
    const { fn, state } = countingFn(async () => SHA_A);
    const r = await detectBrainCoreStale({ latestRefShaFn: fn });
    expect(r).toBeNull();
    // No network call is made for an immutable channel.
    expect(state.calls).toBe(0);
  });

  // U-2 — same for an explicitly pinned tag.
  it("U-2: returns null for a tag-channel record (immutable ref)", async () => {
    writeInstallSource({
      schema_version: 2,
      channel: "tag",
      ref: "v7.0.0",
      fetched_at: new Date().toISOString(),
      content_sha256: CONTENT_SHA,
      source: "github",
      source_path: null,
    });
    const { fn, state } = countingFn(async () => SHA_A);
    const r = await detectBrainCoreStale({ latestRefShaFn: fn });
    expect(r).toBeNull();
    expect(state.calls).toBe(0);
  });

  // U-1b / U-2b — the DISCRIMINATING pins for the exemption. U-1/U-2 use the
  // realistic shape (an immutable record never carries the field), but that
  // shape also returns null through the absent-field arm, so deleting the
  // exemption leaves them green — measured 2026-09-08, mutation m1 SURVIVED
  // against U-1/U-2 alone. These two carry a ref_commit_sha that DIFFERS from
  // the head, which only the exemption can silence. The record is synthetic:
  // our writers never put the field on an immutable channel.
  it("U-1b: a release record CARRYING a differing ref_commit_sha is still exempt", async () => {
    writeInstallSource({
      schema_version: 2,
      channel: "release",
      ref: "v7.3.1",
      fetched_at: new Date().toISOString(),
      content_sha256: CONTENT_SHA,
      ref_commit_sha: SHA_A,
      source: "github",
      source_path: null,
    });
    const { fn, state } = countingFn(async () => SHA_B);
    const r = await detectBrainCoreStale({ latestRefShaFn: fn });
    expect(r).toBeNull();
    expect(state.calls).toBe(0);
  });

  it("U-2b: a tag record CARRYING a differing ref_commit_sha is still exempt", async () => {
    writeInstallSource({
      schema_version: 2,
      channel: "tag",
      ref: "v7.0.0",
      fetched_at: new Date().toISOString(),
      content_sha256: CONTENT_SHA,
      ref_commit_sha: SHA_A,
      source: "github",
      source_path: null,
    });
    const { fn, state } = countingFn(async () => SHA_B);
    const r = await detectBrainCoreStale({ latestRefShaFn: fn });
    expect(r).toBeNull();
    expect(state.calls).toBe(0);
  });

  // U-3 — mutable channel, recorded commit MATCHES head: not stale.
  it("U-3: returns null when the recorded ref_commit_sha equals the head commit", async () => {
    writeInstallSource({
      schema_version: 2,
      channel: "main",
      ref: "main",
      fetched_at: new Date().toISOString(),
      content_sha256: CONTENT_SHA,
      ref_commit_sha: SHA_A,
      source: "github",
      source_path: null,
    });
    const r = await detectBrainCoreStale({ latestRefShaFn: async () => SHA_A });
    expect(r).toBeNull();
  });

  // U-4 — mutable channel, recorded commit DIFFERS: the one true positive.
  it("U-4: returns a DriftRow when the recorded ref_commit_sha differs from head", async () => {
    writeInstallSource({
      schema_version: 2,
      channel: "main",
      ref: "main",
      fetched_at: new Date().toISOString(),
      content_sha256: CONTENT_SHA,
      ref_commit_sha: SHA_A,
      source: "github",
      source_path: null,
    });
    const r = await detectBrainCoreStale({ latestRefShaFn: async () => SHA_B });
    expect(r).not.toBeNull();
    expect(r!.driftClass).toBe("brain-core-stale");
    expect(r!.slug).toBe("(brain)");
    expect(r!.recommendedFix).toContain("igris refresh");
    expect(r!.recommendedFix).toContain("main");
    expect(r!.recommendedFix).toContain(SHA_A.slice(0, 12));
    expect(r!.recommendedFix).toContain(SHA_B.slice(0, 12));
  });

  // U-5 — a pre-7.3.2 record has no ref_commit_sha: absence is not staleness.
  it("U-5: returns null for a main-channel record with NO ref_commit_sha (pre-7.3.2)", async () => {
    writeInstallSource({
      schema_version: 1,
      channel: "main",
      ref: "main",
      fetched_at: new Date().toISOString(),
      content_sha256: CONTENT_SHA,
      source: "github",
      source_path: null,
    });
    const r = await detectBrainCoreStale({ latestRefShaFn: async () => SHA_A });
    expect(r).toBeNull();
  });

  // U-6 — the SHAPE pin: content_sha256 is no longer read at all, even when
  // it happens to equal the head string. At HEAD this returns null (the
  // mirror-image error); after TD-301 it is a row driven by A !== head.
  it("U-6: content_sha256 is not read — a coincidental match does not silence the row", async () => {
    writeInstallSource({
      schema_version: 2,
      channel: "main",
      ref: "main",
      fetched_at: new Date().toISOString(),
      content_sha256: SHA_B, // deliberately EQUAL to the fetched head
      ref_commit_sha: SHA_A,
      source: "github",
      source_path: null,
    });
    const r = await detectBrainCoreStale({ latestRefShaFn: async () => SHA_B });
    expect(r).not.toBeNull();
    expect(r!.driftClass).toBe("brain-core-stale");
  });

  // U-7 — the `branch` channel is mutable too, and the row names the branch.
  it("U-7: returns a DriftRow naming the branch for a branch-channel record", async () => {
    writeInstallSource({
      schema_version: 2,
      channel: "branch",
      ref: "develop",
      fetched_at: new Date().toISOString(),
      content_sha256: CONTENT_SHA,
      ref_commit_sha: SHA_A,
      source: "github",
      source_path: null,
    });
    const r = await detectBrainCoreStale({ latestRefShaFn: async () => SHA_B });
    expect(r).not.toBeNull();
    expect(r!.recommendedFix).toContain("develop");
  });

  // U-8 — the pre-existing from-source case, kept verbatim in intent, with
  // an added call-count assertion (the seam must NOT fire).
  it("U-8: returns null for from-source installs, without calling the fetcher", async () => {
    writeInstallSource({
      schema_version: 1,
      channel: "main",
      ref: "from-source",
      fetched_at: new Date().toISOString(),
      content_sha256: CONTENT_SHA,
      source: "from-source",
      source_path: "/contributor/repo",
    });
    const { fn, state } = countingFn(async () => SHA_B);
    const r = await detectBrainCoreStale({ latestRefShaFn: fn });
    expect(r).toBeNull();
    expect(state.calls).toBe(0);
  });

  // U-9 — the network-error arm, with the armed-guard assertion: the seam
  // must have FIRED, or the null is vacuous.
  it("U-9: returns null when the fetcher rejects, and the seam provably fired", async () => {
    writeInstallSource({
      schema_version: 2,
      channel: "main",
      ref: "main",
      fetched_at: new Date().toISOString(),
      content_sha256: CONTENT_SHA,
      ref_commit_sha: SHA_A,
      source: "github",
      source_path: null,
    });
    const { fn, state } = countingFn(async () => {
      throw new ChannelResolveError("GitHub API unreachable (ECONNREFUSED).");
    });
    const r = await detectBrainCoreStale({ latestRefShaFn: fn });
    expect(r).toBeNull();
    expect(state.calls).toBe(1);
  });
});
