/**
 * http.ts tests — TD-132. Direct HTTP-branch coverage for the shared
 * httpsGetJson seam. Originally lived as TD-127 tests in channel.test.ts;
 * migrated here when TD-132 extracted the seam to its own module.
 *
 * Companion to channel.test.ts's propagation tests (TD-124) — together
 * they evidence the full failure-message contract: distinct error type
 * AND distinct messages reach the verb layer.
 *
 * The `httpRequest as never` cast is used because node:http and node:https
 * `request` signatures differ subtly at the type level; runtime call shape
 * is identical (URL string + options + callback).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _httpsGetJsonForTest } from "../lib/http.js";
import { ChannelResolveError } from "../lib/channel.js";
import { detectBrainCoreStale } from "../lib/drift/brain-core-stale.js";
import { writeInstallSource } from "../lib/install-source.js";
import { makeLoopback } from "./loopback.js";

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

// ---------------------------------------------------------------------------
// TD-132: brain-core-stale propagation tests.
//
// Evidence that detectBrainCoreStale's `catch { return null }` correctly
// swallows the new ChannelResolveError type produced by the shared http.ts
// helper — preserving the user-facing contract ("silent on network
// trouble") while gaining the richer TD-124 messages internally.
//
// We don't need a loopback here — stub the `latestRefShaFn` seam directly
// with the same error instances http.ts would produce. This is the
// propagation-test pattern documented in coding_guidelines.md §12 and
// applied at channel.test.ts:135-169 for resolveChannel.
//
// TD-301 REPAIR (2026-09-08). Until this date these three cases were
// UNFENCED: no IGRIS_BRAIN_DIR, no HOME, so they read the developer's REAL
// ~/.igris/.install-source.json. On a contributor machine that record is
// `source: "from-source"`, so brain-core-stale.ts returned before the seam was
// ever called; in CI the file is absent and it returned one line earlier. The
// `catch` they claim to evidence had NEVER executed. Measured 2026-09-08 by
// adding the `calls` counter BEFORE the fence: all three read `calls === 0`.
// The repair is (1) a real fenced brain dir carrying a MUTABLE-channel record
// with a `ref_commit_sha`, so the fetcher is genuinely reached, and (2) the
// armed-guard assertion `expect(calls).toBe(1)` — without it the immutable-
// channel exemption added by TD-301 would become a THIRD way to pass vacuously.
// ---------------------------------------------------------------------------
describe("brain-core-stale — error swallowing (TD-132)", () => {
  let brainRoot: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    brainRoot = mkdtempSync(join(tmpdir(), "igris-http-stale-"));
    mkdirSync(join(brainRoot, "core"), { recursive: true });
    envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
    envBackup.HOME = process.env.HOME;
    // A MUTABLE channel with a recorded ref commit: the only shape that
    // reaches the fetcher after TD-301.
    writeInstallSource({
      schema_version: 2,
      channel: "main",
      ref: "main",
      fetched_at: "2026-09-08T00:00:00Z",
      content_sha256:
        "d1aa7cae3f92b6045e8c17da29bf60e34c5178ab90de2f4361a7c8b5e0d93f26",
      ref_commit_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      source: "github",
      source_path: null,
    });
  });

  afterEach(() => {
    rmSync(brainRoot, { recursive: true, force: true });
    // Restore BY KEY — `process.env = saved` breaks os.homedir().
    if (envBackup.IGRIS_BRAIN_DIR === undefined)
      delete process.env.IGRIS_BRAIN_DIR;
    else process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
    if (envBackup.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = envBackup.HOME;
  });

  it("returns null when latestRefShaFn rejects with 404 ChannelResolveError", async () => {
    let calls = 0;
    const result = await detectBrainCoreStale({
      latestRefShaFn: () => {
        calls += 1;
        return Promise.reject(
          new ChannelResolveError(
            "No release published yet for fiftynotai/igris-ai. " +
              "Try --channel main for the leading edge, or wait for a tagged release.",
          ),
        );
      },
    });
    expect(result).toBeNull();
    expect(calls).toBe(1);
  });

  it("returns null when latestRefShaFn rejects with 5xx ChannelResolveError", async () => {
    let calls = 0;
    const result = await detectBrainCoreStale({
      latestRefShaFn: () => {
        calls += 1;
        return Promise.reject(
          new ChannelResolveError(
            "GitHub API returned HTTP 503 Service Unavailable (transient — retry in a moment).",
          ),
        );
      },
    });
    expect(result).toBeNull();
    expect(calls).toBe(1);
  });

  it("returns null when latestRefShaFn rejects with network ChannelResolveError", async () => {
    let calls = 0;
    const result = await detectBrainCoreStale({
      latestRefShaFn: () => {
        calls += 1;
        return Promise.reject(
          new ChannelResolveError(
            "GitHub API unreachable (ECONNREFUSED). Check network connectivity or use --channel main with a local --from-source if offline.",
          ),
        );
      },
    });
    expect(result).toBeNull();
    expect(calls).toBe(1);
  });
});
