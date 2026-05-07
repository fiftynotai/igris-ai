/**
 * channel.ts tests — M1.3.
 *
 * Mocks ONLY at the GitHub API boundary via the `latestReleaseTagFn`
 * test seam. No `vi.mock` of channel.ts. Real env-var manipulation
 * for owner/repo overrides.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ChannelResolveError,
  DEFAULT_OWNER,
  DEFAULT_REPO,
  mainTarballUrl,
  repoName,
  repoOwner,
  resolveChannel,
  tagTarballUrl,
} from "../lib/channel.js";

afterEach(() => {
  delete process.env.IGRIS_GITHUB_OWNER;
  delete process.env.IGRIS_GITHUB_REPO;
});

describe("channel — owner/repo defaults + env override", () => {
  it("defaults to fifty-ai/igris-ai", () => {
    expect(repoOwner()).toBe(DEFAULT_OWNER);
    expect(repoName()).toBe(DEFAULT_REPO);
  });

  it("respects IGRIS_GITHUB_OWNER and IGRIS_GITHUB_REPO env overrides", () => {
    process.env.IGRIS_GITHUB_OWNER = "test-owner";
    process.env.IGRIS_GITHUB_REPO = "test-repo";
    expect(repoOwner()).toBe("test-owner");
    expect(repoName()).toBe("test-repo");
  });
});

describe("channel — URL builders", () => {
  it("mainTarballUrl uses owner/repo and refs/heads/main", () => {
    expect(mainTarballUrl()).toBe(
      `https://github.com/${DEFAULT_OWNER}/${DEFAULT_REPO}/archive/refs/heads/main.tar.gz`,
    );
  });

  it("tagTarballUrl URL-encodes special characters in tags", () => {
    expect(tagTarballUrl("v7.0.0")).toBe(
      `https://github.com/${DEFAULT_OWNER}/${DEFAULT_REPO}/archive/refs/tags/v7.0.0.tar.gz`,
    );
    // A tag name with `/` (e.g. "release/2026-05") gets percent-encoded.
    expect(tagTarballUrl("release/2026-05")).toContain("%2F");
  });
});

describe("channel — resolveChannel", () => {
  it("default (no flag) calls latestReleaseTagFn and returns 'release' kind", async () => {
    const r = await resolveChannel({
      latestReleaseTagFn: () => Promise.resolve("v7.0.0"),
    });
    expect(r.kind).toBe("release");
    expect(r.ref).toBe("v7.0.0");
    expect(r.tarballUrl).toContain("/refs/tags/v7.0.0.tar.gz");
  });

  it("--channel=main returns 'main' kind", async () => {
    const r = await resolveChannel({ flag: "main" });
    expect(r.kind).toBe("main");
    expect(r.ref).toBe("main");
    expect(r.tarballUrl).toContain("/refs/heads/main.tar.gz");
  });

  it("--channel=v7.0.0 returns 'tag' kind", async () => {
    const r = await resolveChannel({ flag: "v7.0.0" });
    expect(r.kind).toBe("tag");
    expect(r.ref).toBe("v7.0.0");
    expect(r.tarballUrl).toContain("/refs/tags/v7.0.0.tar.gz");
  });

  it("rejects empty --channel value", async () => {
    await expect(resolveChannel({ flag: "" })).rejects.toThrow(
      ChannelResolveError,
    );
  });

  it("propagates errors from latestReleaseTagFn", async () => {
    await expect(
      resolveChannel({
        latestReleaseTagFn: () =>
          Promise.reject(new ChannelResolveError("API rate limit hit")),
      }),
    ).rejects.toThrow(ChannelResolveError);
  });

  it("does NOT call latestReleaseTagFn when flag is 'main'", async () => {
    let called = false;
    const r = await resolveChannel({
      flag: "main",
      latestReleaseTagFn: () => {
        called = true;
        return Promise.resolve("should-not-be-used");
      },
    });
    expect(called).toBe(false);
    expect(r.ref).toBe("main");
  });

  it("does NOT call latestReleaseTagFn when flag is a tag", async () => {
    let called = false;
    const r = await resolveChannel({
      flag: "v6.5.0",
      latestReleaseTagFn: () => {
        called = true;
        return Promise.resolve("should-not-be-used");
      },
    });
    expect(called).toBe(false);
    expect(r.ref).toBe("v6.5.0");
  });
});
