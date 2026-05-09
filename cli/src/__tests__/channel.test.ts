/**
 * channel.ts tests — M1.3.
 *
 * Mocks ONLY at the GitHub API boundary via the `latestReleaseTagFn`
 * test seam. No `vi.mock` of channel.ts. Real env-var manipulation
 * for owner/repo overrides.
 */

import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import {
  _httpsGetJsonForTest,
  ChannelResolveError,
  DEFAULT_OWNER,
  DEFAULT_REPO,
  mainTarballUrl,
  repoName,
  repoOwner,
  resolveChannel,
  tagTarballUrl,
} from "../lib/channel.js";
import { makeLoopback } from "./loopback.js";

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

// ---------------------------------------------------------------------------
// TD-124: distinct error messages for 404 / 5xx / network failures.
//
// Trade-off (per plan §4 TD-124, architect-approved): we test the error
// messages by injecting a fake `latestReleaseTagFn` that throws the same
// `ChannelResolveError` instances `httpsGetJson` produces. This evidences
// that the new error messages propagate cleanly through `resolveChannel`
// to the verb layer (which is what the user actually sees). It does NOT
// exercise the HTTPS code path itself — that would require either
// exporting `httpsGetJson` + an injectable request factory, or spinning
// up a self-signed-cert HTTPS loopback. Both add infrastructure for
// marginal coverage gain over the propagation guarantee tested below.
// ---------------------------------------------------------------------------
describe("channel — distinct error messages on failure (TD-124)", () => {
  it("404 from latest-release fetch surfaces 'No release published yet' message", async () => {
    const err = new ChannelResolveError(
      `No release published yet for ${DEFAULT_OWNER}/${DEFAULT_REPO}. ` +
        `Try --channel main for the leading edge, or wait for a tagged release.`,
    );
    await expect(
      resolveChannel({
        latestReleaseTagFn: () => Promise.reject(err),
      }),
    ).rejects.toThrow(/No release published yet/);
  });

  it("5xx from latest-release fetch surfaces 'transient — retry' message", async () => {
    const err = new ChannelResolveError(
      `GitHub API returned HTTP 503 Service Unavailable (transient — retry in a moment).`,
    );
    await expect(
      resolveChannel({
        latestReleaseTagFn: () => Promise.reject(err),
      }),
    ).rejects.toThrow(/transient — retry/);
  });

  it("network error from latest-release fetch surfaces 'unreachable' message", async () => {
    const err = new ChannelResolveError(
      `GitHub API unreachable (ECONNREFUSED). Check network connectivity or use --channel main with a local --from-source if offline.`,
    );
    await expect(
      resolveChannel({
        latestReleaseTagFn: () => Promise.reject(err),
      }),
    ).rejects.toThrow(/unreachable/);
  });
});

// ---------------------------------------------------------------------------
// TD-127: direct HTTP-branch coverage via injectable requestFn seam.
//
// Companion to TD-124's propagation tests above. Those evidence that
// distinct error messages reach the verb layer; these evidence that the
// 404 / 5xx / network-closed code paths inside _httpsGetJsonForTest itself
// produce the right ChannelResolveError. Together: full coverage of the
// failure-message contract.
//
// The `httpRequest as never` cast is used because node:http and node:https
// `request` signatures differ subtly at the type level; runtime call shape
// is identical (URL string + options + callback).
// ---------------------------------------------------------------------------
describe("_httpsGetJsonForTest — direct HTTP error branches (TD-127)", () => {
  it("404 response → 'No release published yet' ChannelResolveError", async () => {
    const lb = makeLoopback(() => ({ status: 404, body: "Not Found" }));
    lb.server.listen(0);
    try {
      await new Promise<void>((r) => lb.server.once("listening", () => r()));
      const url = `http://127.0.0.1:${lb.port()}/repos/x/y/releases/latest`;
      await expect(
        _httpsGetJsonForTest(url, httpRequest as never),
      ).rejects.toThrow(/No release published yet/);
      expect(lb.calls).toHaveLength(1);
    } finally {
      lb.server.close();
    }
  });

  it("503 response → 'transient — retry' ChannelResolveError", async () => {
    const lb = makeLoopback(() => ({ status: 503, body: "Service Unavailable" }));
    lb.server.listen(0);
    try {
      await new Promise<void>((r) => lb.server.once("listening", () => r()));
      const url = `http://127.0.0.1:${lb.port()}/repos/x/y/releases/latest`;
      await expect(
        _httpsGetJsonForTest(url, httpRequest as never),
      ).rejects.toThrow(/transient — retry/);
    } finally {
      lb.server.close();
    }
  });

  it("connection refused (server not listening) → 'unreachable' ChannelResolveError", async () => {
    // Pick a port, immediately close the server so connect() is refused.
    const lb = makeLoopback(() => ({ status: 200, body: "{}" }));
    lb.server.listen(0);
    await new Promise<void>((r) => lb.server.once("listening", () => r()));
    const port = lb.port();
    lb.server.close();
    await new Promise<void>((r) => lb.server.once("close", () => r()));
    const url = `http://127.0.0.1:${port}/repos/x/y/releases/latest`;
    await expect(
      _httpsGetJsonForTest(url, httpRequest as never),
    ).rejects.toThrow(/unreachable/);
  });
});
