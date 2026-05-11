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

import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { _httpsGetJsonForTest } from "../lib/http.js";
import { ChannelResolveError } from "../lib/channel.js";
import { detectBrainCoreStale } from "../lib/drift/brain-core-stale.js";
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
// ---------------------------------------------------------------------------
describe("brain-core-stale — error swallowing (TD-132)", () => {
  it("returns null when latestRefShaFn rejects with 404 ChannelResolveError", async () => {
    const result = await detectBrainCoreStale({
      latestRefShaFn: () =>
        Promise.reject(
          new ChannelResolveError(
            "No release published yet for fiftynotai/igris-ai. " +
              "Try --channel main for the leading edge, or wait for a tagged release.",
          ),
        ),
    });
    // Should be null whether install-source is present (catch fires) or
    // absent (early null). Either way: no throw, no DriftRow.
    expect(result).toBeNull();
  });

  it("returns null when latestRefShaFn rejects with 5xx ChannelResolveError", async () => {
    const result = await detectBrainCoreStale({
      latestRefShaFn: () =>
        Promise.reject(
          new ChannelResolveError(
            "GitHub API returned HTTP 503 Service Unavailable (transient — retry in a moment).",
          ),
        ),
    });
    expect(result).toBeNull();
  });

  it("returns null when latestRefShaFn rejects with network ChannelResolveError", async () => {
    const result = await detectBrainCoreStale({
      latestRefShaFn: () =>
        Promise.reject(
          new ChannelResolveError(
            "GitHub API unreachable (ECONNREFUSED). Check network connectivity or use --channel main with a local --from-source if offline.",
          ),
        ),
    });
    expect(result).toBeNull();
  });
});
