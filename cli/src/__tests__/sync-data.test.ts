/**
 * sync-data.test.ts — M4.2 (MG-014).
 *
 * Real fs against tmp `sync_queue.jsonl` + a real loopback HTTP server
 * for the MCP boundary. No mocks of the module under test (per L-159 /
 * TD-098). Mirrors the real-fixture-over-mock pattern from L-135.
 *
 * The HTTP server here speaks the same shape as the brain's /mcp
 * endpoint: accepts JSON-RPC 2.0
 *
 *   { "jsonrpc": "2.0", "method": "tools/call",
 *     "params": { "name": "<tool>", "arguments": {...} }, "id": 1 }
 *
 * (See `brain-mcp-server/src/index.ts:1490` for the direct-dispatch
 * fallback that the CLI talks to.)
 *
 * Per-entry replay contract (legacy /sync skill, sentinel's M4 reject):
 *   - sync_queue.jsonl entries are replayed one-by-one, each as its own
 *     MCP tools/call against igris_brief_sync / igris_brief_create.
 *   - Only after every entry replays successfully is igris_sync_queue_drain
 *     invoked (with NO local_entries arg — that arg does not exist in
 *     the brain's schema).
 *   - On per-entry failure the queue file is preserved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLoopback, mcpOkEnvelope } from "./loopback.js";

let tmpBrain: string;
const envBackup: Record<string, string | undefined> = {};

function writeConfig(content: Record<string, unknown>): void {
  writeFileSync(
    join(tmpBrain, "config.json"),
    JSON.stringify(content, null, 2) + "\n",
  );
}

function writeQueue(slug: string, lines: string[]): string {
  const dir = join(tmpBrain, "projects", slug);
  mkdirSync(dir, { recursive: true });
  const queuePath = join(dir, "sync_queue.jsonl");
  writeFileSync(queuePath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
  return queuePath;
}

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-sync-data-"));
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  envBackup.IGRIS_ALLOW_INSECURE_SYNC = process.env.IGRIS_ALLOW_INSECURE_SYNC;
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
  // TD-252: start each test from the refuse-default (override UNSET).
  delete process.env.IGRIS_ALLOW_INSECURE_SYNC;
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
  if (envBackup.IGRIS_ALLOW_INSECURE_SYNC === undefined) {
    delete process.env.IGRIS_ALLOW_INSECURE_SYNC;
  } else {
    process.env.IGRIS_ALLOW_INSECURE_SYNC = envBackup.IGRIS_ALLOW_INSECURE_SYNC;
  }
  vi.restoreAllMocks();
});

describe("sync data — runSyncData", () => {
  it("remote_brain not configured → exit 1", async () => {
    const { runSyncData } = await import("../lib/sync/data.js");
    const code = await runSyncData();
    expect(code).toBe(1);
  });

  it("empty local queue: still calls remote drain, with drain-only args (exit 0 via the INDETERMINATE tier)", async () => {
    // TD-321 title correction. The subject here is the drain CALL SHAPE on an
    // empty queue — one call, JSON-RPC envelope, no `local_entries`. The
    // `{drained: 0}` body is deliberately NOT a success envelope: since BR-080
    // it classifies INDETERMINATE, which `callRemoteDrain` also exits 0 on
    // (the brain-side table is idempotent and re-drained next run). The old
    // title's "returns 0 on HTTP 200" stayed literally true but implied this
    // exercised the success tier, which it stopped doing. Success is covered
    // deliberately by "case 2" in the classifier block below; this fixture is
    // one of the ~8 legacy non-envelope bodies "case 3" exists to protect.
    const lb = makeLoopback(() => ({
      status: 200,
      body: JSON.stringify({ drained: 0 }),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "no-queue" });
      expect(code).toBe(0);
      expect(lb.calls.length).toBe(1);

      // JSON-RPC 2.0 envelope assertions.
      const drainCall = lb.calls[0];
      expect(drainCall.jsonrpc).toBe("2.0");
      expect(drainCall.method).toBe("tools/call");
      expect(drainCall.toolName).toBe("igris_sync_queue_drain");

      // No local entries → no per-entry replay; ONLY drain is called.
      // Drain args MUST NOT include local_entries (brain schema rejects it).
      expect(drainCall.args?.local_entries).toBeUndefined();
      expect(drainCall.args?.remote_url).toBe(`http://127.0.0.1:${lb.port()}`);
      expect(drainCall.args?.api_key).toBe("k");
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("replays brief_sync entries before draining (per-entry dispatch contract)", async () => {
    // All calls succeed.
    const lb = makeLoopback(() => ({
      status: 200,
      body: mcpOkEnvelope(),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    const queuePath = writeQueue("demo", [
      JSON.stringify({
        operation: "brief_sync",
        project: "demo",
        brief_id: "TD-100",
        title: "test",
        status: "ACTIVE",
      }),
    ]);
    expect(existsSync(queuePath)).toBe(true);

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      expect(code).toBe(0);

      // Two HTTP calls: first the per-entry replay, then the drain.
      expect(lb.calls.length).toBe(2);

      const replay = lb.calls[0];
      expect(replay.jsonrpc).toBe("2.0");
      expect(replay.method).toBe("tools/call");
      expect(replay.toolName).toBe("igris_brief_sync");
      // `operation` discriminator is stripped before forwarding.
      expect(replay.args?.operation).toBeUndefined();
      expect(replay.args?.brief_id).toBe("TD-100");
      expect(replay.args?.project).toBe("demo");
      expect(replay.args?.title).toBe("test");
      expect(replay.args?.status).toBe("ACTIVE");

      const drain = lb.calls[1];
      expect(drain.toolName).toBe("igris_sync_queue_drain");
      // Drain MUST NOT receive local_entries (would be silent data-loss).
      expect(drain.args?.local_entries).toBeUndefined();

      // Queue file removed only after both phases succeed.
      expect(existsSync(queuePath)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("queue with mixed entries: dispatches each then drains, clears local queue file", async () => {
    const lb = makeLoopback(() => ({
      status: 200,
      body: mcpOkEnvelope(),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    const queuePath = writeQueue("demo", [
      JSON.stringify({
        operation: "brief_sync",
        project: "demo",
        brief_id: "TD-100",
        title: "first",
        status: "ACTIVE",
      }),
      JSON.stringify({
        operation: "brief_create",
        project: "demo",
        brief_id: "TD-101",
        title: "second",
        content: "# inline content",
      }),
    ]);

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      expect(code).toBe(0);

      // 2 per-entry replays + 1 brain-side drain.
      expect(lb.calls.length).toBe(3);
      expect(lb.calls[0].toolName).toBe("igris_brief_sync");
      expect(lb.calls[0].args?.brief_id).toBe("TD-100");
      expect(lb.calls[1].toolName).toBe("igris_brief_create");
      expect(lb.calls[1].args?.brief_id).toBe("TD-101");
      expect(lb.calls[1].args?.content).toBe("# inline content");
      expect(lb.calls[2].toolName).toBe("igris_sync_queue_drain");
      expect(lb.calls[2].args?.local_entries).toBeUndefined();

      expect(existsSync(queuePath)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("preserves queue when per-entry replay fails (HTTP 500); does NOT call drain", async () => {
    // First call (per-entry replay) returns 500. Drain must NOT be reached.
    const lb = makeLoopback((_call, idx) => {
      if (idx === 0) {
        return { status: 500, body: "brain server error" };
      }
      return { status: 200, body: mcpOkEnvelope() };
    });
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    const queuePath = writeQueue("demo", [
      JSON.stringify({
        operation: "brief_sync",
        project: "demo",
        brief_id: "TD-200",
        title: "fails",
        status: "ACTIVE",
      }),
    ]);

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      expect(code).toBe(1);

      // Exactly ONE call — the per-entry replay. Drain MUST NOT be made.
      expect(lb.calls.length).toBe(1);
      expect(lb.calls[0].toolName).toBe("igris_brief_sync");

      // On failure, queue MUST remain so the next attempt replays.
      expect(existsSync(queuePath)).toBe(true);
      const remaining = readFileSync(queuePath, "utf-8");
      expect(remaining).toContain("TD-200");
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("MCP HTTP failure on drain (after replay) → exit 1; queue file preserved", async () => {
    // All per-entry replays succeed; drain returns 500.
    const lb = makeLoopback((call) => {
      if (call.toolName === "igris_sync_queue_drain") {
        return { status: 500, body: "drain failed" };
      }
      return { status: 200, body: mcpOkEnvelope() };
    });
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    const queuePath = writeQueue("demo", [
      JSON.stringify({
        operation: "brief_sync",
        project: "demo",
        brief_id: "TD-201",
        title: "ok",
        status: "ACTIVE",
      }),
    ]);

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      expect(code).toBe(1);

      // Per-entry replay happened (call 0), drain failed (call 1).
      expect(lb.calls.length).toBe(2);
      expect(lb.calls[0].toolName).toBe("igris_brief_sync");
      expect(lb.calls[1].toolName).toBe("igris_sync_queue_drain");

      // Queue must remain — the drain failure means we can't trust the
      // brain-side state was fully consistent. Re-running will redrive
      // (brain dedupes via ON CONFLICT).
      expect(existsSync(queuePath)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("--dry-run: no network call; queue file untouched", async () => {
    writeConfig({
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    const queuePath = writeQueue("demo", [
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-1" }),
    ]);
    const stdoutBuf: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ dryRun: true, projectSlug: "demo" });
      expect(code).toBe(0);
      // Queue still present.
      expect(existsSync(queuePath)).toBe(true);
      const out = stdoutBuf.join("");
      expect(out).toContain("Dry-run plan:");
      expect(out).toContain("igris_sync_queue_drain");
      expect(out).toContain("No filesystem writes were performed.");
    } finally {
      spy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------
  // TD-119: cache_path resolution branch coverage.
  //
  // dispatchEntry (data.ts:240-254) handles brief_create + cache_path by
  // reading the file from disk and inlining its contents as `content`,
  // then stripping `cache_path` before forwarding. The two cases below
  // pin both the success and the missing-file branches.
  // ---------------------------------------------------------------------
  it("brief_create with cache_path: reads file and inlines as content; cache_path stripped (TD-119)", async () => {
    const lb = makeLoopback(() => ({
      status: 200,
      body: mcpOkEnvelope(),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    // Write a fixture cache file.
    const cacheDir = join(tmpBrain, "cache");
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, "TD-300.md");
    const cacheContents = "# TD-300: cache-path-resolution test\n\nbody.";
    writeFileSync(cachePath, cacheContents);

    // Queue a brief_create entry pointing at the cache file.
    writeQueue("demo", [
      JSON.stringify({
        operation: "brief_create",
        project: "demo",
        brief_id: "TD-300",
        title: "cache-test",
        cache_path: cachePath,
      }),
    ]);

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      expect(code).toBe(0);

      // 1 per-entry replay + 1 drain.
      expect(lb.calls.length).toBe(2);
      const replay = lb.calls[0];
      expect(replay.toolName).toBe("igris_brief_create");
      // Content was inlined byte-for-byte from the file.
      expect(replay.args?.content).toBe(cacheContents);
      // cache_path was stripped before forwarding.
      expect(replay.args?.cache_path).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  // ---------------------------------------------------------------------
  // TD-128 M3: caller-side strict allow-list for queue replay.
  //
  // The previous `Object.entries(entry)` spread forwarded EVERY queue-entry
  // field — including legacy/unknown keys — to the MCP tool. The brain
  // gateway's strict-input contract (TD-128) now warns (M1) and will
  // reject (M4) on extras. The two cases below pin the new behavior:
  // unknown keys are stripped before mcpCall, while cache_path → content
  // substitution still works under the allow-list discipline.
  // ---------------------------------------------------------------------
  it("dispatchEntry strips queue-entry fields not in the tool's allow-list before mcpCall (TD-128 M3)", async () => {
    const lb = makeLoopback(() => ({
      status: 200,
      body: mcpOkEnvelope(),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    // Queue a brief_sync entry that ALSO carries legacy/unknown fields.
    // Under the strict allow-list these MUST NOT be forwarded.
    writeQueue("demo", [
      JSON.stringify({
        operation: "brief_sync",
        project: "demo",
        brief_id: "TD-400",
        title: "strict-test",
        status: "ACTIVE",
        // Legacy/unknown fields — must be stripped before forwarding.
        __legacy_extra: "legacy-value",
        deprecated_field: 42,
        random_garbage: { nested: true },
      }),
    ]);

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      expect(code).toBe(0);

      // 1 per-entry replay + 1 drain.
      expect(lb.calls.length).toBe(2);
      const replay = lb.calls[0];
      expect(replay.toolName).toBe("igris_brief_sync");

      // Allow-list keys ARE forwarded.
      expect(replay.args?.project).toBe("demo");
      expect(replay.args?.brief_id).toBe("TD-400");
      expect(replay.args?.title).toBe("strict-test");
      expect(replay.args?.status).toBe("ACTIVE");

      // Unknown keys MUST NOT appear — caller-side allow-list strips them
      // before the MCP boundary.
      expect(replay.args?.__legacy_extra).toBeUndefined();
      expect(replay.args?.deprecated_field).toBeUndefined();
      expect(replay.args?.random_garbage).toBeUndefined();

      // `operation` discriminator is also stripped (existing contract).
      expect(replay.args?.operation).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("dispatchEntry preserves cache_path→content substitution under strict allow-list (TD-128 M3)", async () => {
    const lb = makeLoopback(() => ({
      status: 200,
      body: mcpOkEnvelope(),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    // Fixture cache file.
    const cacheDir = join(tmpBrain, "cache");
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, "TD-401.md");
    const cacheContents = "# TD-401: strict-allow-list cache-path test\n\nbody.";
    writeFileSync(cachePath, cacheContents);

    // brief_create entry with cache_path AND a stray unknown field.
    writeQueue("demo", [
      JSON.stringify({
        operation: "brief_create",
        project: "demo",
        brief_id: "TD-401",
        title: "cache-strict-test",
        cache_path: cachePath,
        // Allow-list: forwarded.
        priority: "P3-Low",
        // Not in allow-list: must be stripped.
        __legacy_extra: "should-be-dropped",
      }),
    ]);

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      expect(code).toBe(0);

      expect(lb.calls.length).toBe(2);
      const replay = lb.calls[0];
      expect(replay.toolName).toBe("igris_brief_create");

      // cache_path → content substitution still works.
      expect(replay.args?.content).toBe(cacheContents);
      // cache_path NOT in allow-list — must be absent post-resolution.
      expect(replay.args?.cache_path).toBeUndefined();

      // Other allow-list keys forwarded.
      expect(replay.args?.project).toBe("demo");
      expect(replay.args?.brief_id).toBe("TD-401");
      expect(replay.args?.title).toBe("cache-strict-test");
      expect(replay.args?.priority).toBe("P3-Low");

      // Unknown key stripped.
      expect(replay.args?.__legacy_extra).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  // ---------------------------------------------------------------------
  // FR-128: atomic-drain integration tests.
  //
  // Test #8 (the AC bullet at the CLI integration layer): a sibling
  // harness's append landing while runSyncData is mid-replay must
  // survive — the appended line is processed by a SECOND runSyncData
  // call, never lost.
  //
  // Test #9: a stale `.draining-*` file left by a crashed prior drain
  // is recovered on the next runSyncData (the self-heal path).
  // ---------------------------------------------------------------------
  it("concurrent append during runSyncData is preserved on next runSyncData (FR-128 AC)", async () => {
    // Deterministic barrier: the loopback's first response (the
    // per-entry replay) only resolves AFTER the test has appended the
    // sibling line. This pins the race that motivates FR-128 without
    // depending on setTimeout/sleep.
    let resolveBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });

    const lb = makeLoopback(async (_call, idx) => {
      if (idx === 0) {
        // First call = per-entry replay. Hold response until the test
        // simulates the sibling-harness append.
        await barrier;
      }
      return { status: 200, body: mcpOkEnvelope() };
    });
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    const queuePath = writeQueue("demo", [
      JSON.stringify({
        operation: "brief_sync",
        project: "demo",
        brief_id: "TD-FR128-ORIG",
        title: "original",
        status: "ACTIVE",
      }),
    ]);

    try {
      const { runSyncData } = await import("../lib/sync/data.js");

      // Start the first drain (resolves once barrier releases).
      const firstDrainPromise = runSyncData({ projectSlug: "demo" });

      // Wait until the per-entry replay has actually hit the loopback
      // (so we know the rename has already occurred — the canonical
      // file is the renamed temp at this point). Spin-poll on lb.calls
      // until the first call is observed.
      for (let i = 0; i < 100; i++) {
        if (lb.calls.length >= 1) break;
        await new Promise<void>((r) => setImmediate(r));
      }
      expect(lb.calls.length).toBeGreaterThanOrEqual(1);

      // Simulate the sibling-harness append landing AFTER the rename.
      // The canonical name is free (the renamed temp holds the
      // snapshot), so this creates a fresh `sync_queue.jsonl`.
      writeFileSync(
        queuePath,
        JSON.stringify({
          operation: "brief_sync",
          project: "demo",
          brief_id: "TD-FR128-SIBLING",
          title: "sibling",
          status: "ACTIVE",
        }) + "\n",
      );
      expect(existsSync(queuePath)).toBe(true);

      // Release the loopback → first drain completes.
      resolveBarrier();
      const code1 = await firstDrainPromise;
      expect(code1).toBe(0);
      // First drain made 2 calls: 1 per-entry + 1 brain-side drain.
      expect(lb.calls.length).toBe(2);
      expect(lb.calls[0].args?.brief_id).toBe("TD-FR128-ORIG");

      // The sibling line is now the sole content of the canonical
      // queue — drain it via a SECOND runSyncData.
      const code2 = await runSyncData({ projectSlug: "demo" });
      expect(code2).toBe(0);

      // 2 more calls: the sibling replay + a second brain-side drain.
      expect(lb.calls.length).toBe(4);
      expect(lb.calls[2].toolName).toBe("igris_brief_sync");
      expect(lb.calls[2].args?.brief_id).toBe("TD-FR128-SIBLING");

      // Queue is now empty AND no `.draining-*` files remain.
      expect(existsSync(queuePath)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("runSyncData recovers a stale .draining-* from a prior crashed drain (FR-128)", async () => {
    const lb = makeLoopback(() => ({
      status: 200,
      body: mcpOkEnvelope(),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    // Pre-seed ONLY a stale draining file (no canonical queue) —
    // simulates the prior run crashing between rename and finalize.
    const dir = join(tmpBrain, "projects", "demo");
    mkdirSync(dir, { recursive: true });
    const stalePath = join(dir, "sync_queue.jsonl.draining-99999-1");
    writeFileSync(
      stalePath,
      [
        JSON.stringify({
          operation: "brief_sync",
          project: "demo",
          brief_id: "TD-CRASHED-1",
          title: "crashed-a",
          status: "ACTIVE",
        }),
        JSON.stringify({
          operation: "brief_sync",
          project: "demo",
          brief_id: "TD-CRASHED-2",
          title: "crashed-b",
          status: "ACTIVE",
        }),
      ].join("\n") + "\n",
    );
    expect(existsSync(join(dir, "sync_queue.jsonl"))).toBe(false);

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      expect(code).toBe(0);

      // 2 per-entry replays + 1 brain-side drain = 3 calls.
      expect(lb.calls.length).toBe(3);
      expect(lb.calls[0].args?.brief_id).toBe("TD-CRASHED-1");
      expect(lb.calls[1].args?.brief_id).toBe("TD-CRASHED-2");
      expect(lb.calls[2].toolName).toBe("igris_sync_queue_drain");

      // Stale file is reclaimed and queue is fully drained.
      expect(existsSync(stalePath)).toBe(false);
      expect(existsSync(join(dir, "sync_queue.jsonl"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("brief_create with missing cache_path file: exit 1, queue preserved, drain NOT called (TD-119)", async () => {
    const lb = makeLoopback(() => ({
      status: 200,
      body: mcpOkEnvelope(),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    const queuePath = writeQueue("demo", [
      JSON.stringify({
        operation: "brief_create",
        project: "demo",
        brief_id: "TD-301",
        title: "missing-cache",
        cache_path: "/no/such/file/td-301.md",
      }),
    ]);

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      expect(code).toBe(1);
      // No HTTP call should have been made — readFileSync threw before
      // mcpCall was reached (data.ts:243-252 catch returns 1 directly).
      expect(lb.calls.length).toBe(0);
      // Queue file MUST remain (preserve-on-failure contract).
      expect(existsSync(queuePath)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });
});

describe("sync data — TD-252 transport guard (the 4-case matrix)", () => {
  // #356: assert the REAL refusal/allow outcome, not "200 OK".

  it("case 1: https URL is NOT refused by the guard (gate passes through)", async () => {
    // Points at https://127.0.0.1:<closed-port> — the guard allows https, so
    // the request is attempted and fails to CONNECT (network error), NOT
    // short-circuited with the cleartext-key refusal. Proves https passes.
    writeConfig({
      remote_brain: { url: "https://127.0.0.1:1", api_key: "k" },
    });
    const { runSyncData } = await import("../lib/sync/data.js");
    // Empty queue → drain-only path → callRemoteDrain → mcpCall. The TLS
    // connection to a closed port fails (exit 1) but the guard did NOT block
    // it. (If the guard wrongly refused https, exit would still be 1, so this
    // test's value is the companion classifier unit test — kept for the
    // wiring smoke.)
    const code = await runSyncData({ projectSlug: "no-queue" });
    expect(code).toBe(1);
  });

  it("case 2: localhost http proceeds (existing loopback fixtures still pass)", async () => {
    const lb = makeLoopback(() => ({
      status: 200,
      body: JSON.stringify({ drained: 0 }),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });
    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "no-queue" });
      // Loopback http is allowed → drain call reaches the server → exit 0.
      expect(code).toBe(0);
      expect(lb.calls.length).toBe(1);
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("case 3: remote http, override UNSET → REFUSED, ZERO requests on the wire", async () => {
    // A loopback server is started but the config points at a REMOTE host —
    // if the guard leaked, a request would hit some endpoint; instead the
    // guard short-circuits and the server records ZERO calls. The
    // Authorization: Bearer header is NEVER built/sent (#356).
    const lb = makeLoopback(() => ({
      status: 200,
      body: JSON.stringify({ drained: 0 }),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    // Remote hostname (NOT loopback) — guard classifies insecure-http.
    writeConfig({
      remote_brain: { url: "http://vps.example.invalid:3001", api_key: "k" },
    });

    const stderrBuf: string[] = [];
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "no-queue" });
      // Refused → drain fails → exit 1.
      expect(code).toBe(1);
      // The decisive #356 assertion: NO request ever left the process.
      expect(lb.calls.length).toBe(0);
      // The refusal reason (with the cleartext-key risk + the fix) surfaces.
      const out = stderrBuf.join("");
      expect(out).toContain("cleartext");
    } finally {
      errSpy.mockRestore();
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("case 4: remote http + override=1 → request IS attempted (guard let it through) + warns", async () => {
    process.env.IGRIS_ALLOW_INSECURE_SYNC = "1";
    // Point at a REMOTE-looking host on the loopback closed port: the guard
    // allows it (override active), so mcpCall ATTEMPTS the connection. We
    // assert the guard did NOT short-circuit by checking the failure body is
    // a NETWORK error, not the cleartext refusal, AND that the loud warning
    // fired.
    writeConfig({
      remote_brain: { url: "http://vps.example.invalid:3001", api_key: "k" },
    });

    const stderrBuf: string[] = [];
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "no-queue" });
      // The connection to an invalid host fails → exit 1, but the guard
      // ALLOWED the attempt (the request was built and dispatched).
      expect(code).toBe(1);
      const out = stderrBuf.join("");
      // The loud per-sync override warning fired.
      expect(out).toContain("WARNING");
      expect(out).toContain("override active");
      // The failure is a network/DNS error, NOT the cleartext refusal — proves
      // the guard let the request through rather than short-circuiting.
      expect(out).not.toContain("refusing to sync over http");
    } finally {
      errSpy.mockRestore();
    }
  });
});

// -------------------------------------------------------------------------
// BR-080 — callRemoteDrain result classification (F5).
//
// THE DEFECT: `callRemoteDrain` declared success on `statusCode === 200`
// ALONE. The brain returns HTTP 200 for a THROWN tool error too — the stdio
// and HTTP dispatch sites in `brain-mcp-server/src/index.ts` wrap the thrown
// error as `{content:[...], isError:true}` and `res.json({jsonrpc, result, id})`
// it back at 200. So every drain failure, including the very TypeError BR-080
// is about, printed `sync data: remote drain OK (HTTP 200)` and exited 0.
//
// WHAT THIS BLOCK PROVES: the CLI's verdict now TRACKS the brain's verdict for
// all three body shapes it can receive — error envelope, success envelope, and
// a body that is not a JSON-RPC envelope at all.
//
// WHAT IT DOES NOT PROVE: that a real brain error is shaped this way when the
// response is routed through `StreamableHTTPServerTransport` (the HTTP
// fallback-A path may emit SSE, not plain JSON). That shape lands in the
// third — "indeterminate" — tier, which case 3 below pins directly.
//
// The loopback is the same fake the rest of this file uses; it validates
// nothing, so these cases are about the CLI's READING of a response, not about
// the brain's behaviour. The brain-side half is
// `brain-mcp-server/src/tools/__tests__/sync-queue-drain-contract.test.ts`.
// -------------------------------------------------------------------------
describe("sync data — remote drain result classification (BR-080)", () => {
  /** Boot a loopback, point config at it, run drain-only, capture stdout+stderr. */
  async function runDrainAgainst(
    body: string,
    status = 200,
  ): Promise<{ code: number; stdout: string; stderr: string; callCount: number }> {
    const lb = makeLoopback(() => ({ status, body }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "no-queue" });
      return {
        code,
        stdout: stdoutBuf.join(""),
        stderr: stderrBuf.join(""),
        callCount: lb.calls.length,
      };
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  }

  it("case 1 (R2): HTTP 200 carrying isError:true → exit 1 and NO 'drain OK' claim", async () => {
    const { code, stdout, stderr, callCount } = await runDrainAgainst(
      JSON.stringify({
        jsonrpc: "2.0",
        result: {
          content: [
            {
              type: "text",
              text: "Error executing igris_sync_queue_drain: Cannot read properties of undefined (reading 'replace')",
            },
          ],
          isError: true,
        },
        id: 1,
      }),
    );

    // The request DID reach the brain — this is a classification failure, not
    // a transport failure. Without this the exit-1 could come from anywhere.
    expect(callCount).toBe(1);
    expect(code).toBe(1);
    // The overclaim must be gone from BOTH streams.
    expect(stdout).not.toContain("remote drain OK");
    expect(stderr).not.toContain("remote drain OK");
    // The brain's own first content line is surfaced verbatim to the operator.
    expect(stderr).toContain("Error executing igris_sync_queue_drain");
  });

  it("case 2: HTTP 200 success envelope → exit 0, names the brain-side queue and echoes the summary", async () => {
    const { code, stdout, callCount } = await runDrainAgainst(
      JSON.stringify({
        jsonrpc: "2.0",
        result: {
          content: [
            {
              type: "text",
              text: "Sync queue drain completed successfully.\nItems sent: 7",
            },
          ],
        },
        id: 1,
      }),
    );

    expect(callCount).toBe(1);
    expect(code).toBe(0);
    // Names WHICH queue was drained (the brain's own sync_queue table, not the
    // local jsonl file) — the ambiguity that made "the count did not move"
    // hard to diagnose.
    expect(stdout).toContain("brain-side sync_queue drain");
    // Echoes the brain's own summary rather than asserting a bare "OK".
    expect(stdout).toContain("Sync queue drain completed successfully.");
    expect(stdout).toContain("Items sent: 7");
  });

  it("case 3: HTTP 200 with a non-envelope body → exit 0 but reported as INDETERMINATE, never OK", async () => {
    // This is the shape ~8 pre-existing loopbacks in this file return, and the
    // shape the SSE/StreamableHTTP fallback can produce. It must neither fail
    // (that would break the legacy fixtures) nor claim success (that would
    // re-create the overclaim). Third tier, per L-1017: a valid-but-unreadable
    // response and a genuine error are DIFFERENT states.
    const { code, stdout, stderr, callCount } = await runDrainAgainst(
      JSON.stringify({ drained: 0 }),
    );

    expect(callCount).toBe(1);
    expect(code).toBe(0);
    expect(stdout).not.toContain("remote drain OK");
    expect(stderr).not.toContain("remote drain OK");
    expect(stdout).toContain("could not be read");
  });

  it("case 3b: HTTP 200 with a body that is not JSON at all → indeterminate, exit 0", async () => {
    // Any 200 whose body `JSON.parse` cannot read: an nginx/gateway error page,
    // a truncated response, or an SSE frame. `mcpCall` sends NO `Accept` header
    // (`cli/src/lib/mcp-client.ts` builds the request headers), so the brain's
    // `StreamableHTTPServerTransport` answers 406 rather than an SSE 200 —
    // this case is NOT a pin on that transport, it is the generic
    // unparseable-200 shape. The body below is merely one concrete instance.
    const { code, stdout, callCount } = await runDrainAgainst(
      'event: message\ndata: {"jsonrpc":"2.0","result":{}}\n\n',
    );

    expect(callCount).toBe(1);
    expect(code).toBe(0);
    expect(stdout).not.toContain("remote drain OK");
    expect(stdout).toContain("could not be read");
  });

  it("case 5 (D5): HTTP 200 carrying a JSON-RPC error envelope → exit 1, classified error not indeterminate", async () => {
    // A JSON-RPC `error` envelope has no `result` key, so without an explicit
    // branch it falls into the indeterminate tier — "unreadable" is provably
    // wrong for the one shape that states failure outright.
    const { code, stdout, stderr, callCount } = await runDrainAgainst(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32602, message: "Invalid params: remote_url" },
        id: 1,
      }),
    );

    expect(callCount).toBe(1);
    expect(code).toBe(1);
    expect(stdout).not.toContain("remote drain OK");
    // The distinguishing assertion: it must NOT be reported as unreadable.
    expect(stdout).not.toContain("could not be read");
    expect(stderr).not.toContain("could not be read");
    expect(stderr).toContain("Invalid params: remote_url");
  });
});

// -------------------------------------------------------------------------
// BR-080 (sentinel round 2) — the SAME HTTP-200-misread in `dispatchEntry`.
//
// THE DEFECT: `dispatchEntry` declared a queue entry "replayed" on
// `statusCode === 200` alone, exactly as `callRemoteDrain` did. The brain
// returns HTTP 200 for a THROWN tool error, so an entry the brain REJECTED was
// logged as replayed, the loop continued to phase 2, and
// `finalizeDrainSnapshot(snapshot, true)` UNLINKED the queue — the entry was
// silently destroyed with no error anywhere.
//
// Why BR-080 enlarged it: `buildToolArgs` already filters unknown keys, so the
// TD-128 unknown-arg rejection could never reach this path. Missing-REQUIRED
// rejections are a new class of HTTP-200 tool error that now can, and every one
// of them deleted a queue line (a `/hunt` `brief_sync` line lacking `title` is
// the live instance).
//
// WHAT THIS BLOCK PROVES: for all three body tiers, an entry is destroyed ONLY
// on a readable success envelope. Each case asserts the PRE-state (the entry is
// on disk before the run) and the POST-state, so a case cannot pass because the
// queue was never written or never read.
//
// WHAT IT DOES NOT PROVE: that the brain actually rejects these args — the
// loopback validates nothing. The brain-side half is
// `brain-mcp-server/src/engine/__tests__/gateway-strict-input.test.ts`.
// -------------------------------------------------------------------------
describe("sync data — per-entry replay result classification (BR-080)", () => {
  /** A `brief_sync` line missing `title` — the shape `/hunt` can queue. */
  const REJECTED_ENTRY = JSON.stringify({
    operation: "brief_sync",
    project: "demo",
    brief_id: "BR-080-E",
    status: "ACTIVE",
  });

  /** The brain's real shape for a gateway guard throw: HTTP 200 + isError. */
  const GUARD_THROW_BODY = JSON.stringify({
    jsonrpc: "2.0",
    result: {
      content: [
        {
          type: "text",
          text: "Error executing igris_brief_sync: igris_brief_sync: missing required argument 'title'. Required: project, brief_id, title, status. (strict-input contract; BR-080)",
        },
      ],
      isError: true,
    },
    id: 1,
  });

  /**
   * Seed a one-entry queue and run the drain against a loopback that returns
   * `body` for the ENTRY replay and an unambiguous success envelope for the
   * brain-side drain. Isolating the two responses is load-bearing: if the drain
   * echoed the same error body, `callRemoteDrain` would fail the run and
   * `finalizeDrainSnapshot(false)` would restore the queue — the entry would
   * survive for the wrong reason and the guard below would pass on the broken
   * build. Sentinel's reproduction used exactly this split and observed
   * `{exitCode: 0, queueStillExists: false}`.
   *
   * Reports both the pre-state and the post-state so a pass cannot come from a
   * queue that was never written or never read.
   */
  async function replayAgainst(body: string): Promise<{
    code: number;
    tools: (string | undefined)[];
    queueExistedBefore: boolean;
    queueContentBefore: string;
    queueExistsAfter: boolean;
    queueContentAfter: string;
    stdout: string;
    stderr: string;
  }> {
    const lb = makeLoopback((call) => ({
      status: 200,
      body:
        call.toolName === "igris_sync_queue_drain"
          ? mcpOkEnvelope("Sync queue drain completed successfully.")
          : body,
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });
    const queuePath = writeQueue("demo", [REJECTED_ENTRY]);
    const queueExistedBefore = existsSync(queuePath);
    const queueContentBefore = queueExistedBefore
      ? readFileSync(queuePath, "utf-8")
      : "";

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      const queueExistsAfter = existsSync(queuePath);
      return {
        code,
        tools: lb.calls.map((c) => c.toolName),
        queueExistedBefore,
        queueContentBefore,
        queueExistsAfter,
        queueContentAfter: queueExistsAfter
          ? readFileSync(queuePath, "utf-8")
          : "",
        stdout: stdoutBuf.join(""),
        stderr: stderrBuf.join(""),
      };
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  }

  it("error tier: an entry the brain REJECTED at HTTP 200 is preserved, not replayed, and does not reach the drain", async () => {
    const r = await replayAgainst(GUARD_THROW_BODY);

    // PRE-state — without this the post-state assertion could pass because the
    // queue was never written in the first place.
    expect(r.queueExistedBefore).toBe(true);
    expect(r.queueContentBefore).toContain("BR-080-E");

    // POST-state — the entry survives. This is the assertion the defect fails.
    expect(r.queueExistsAfter).toBe(true);
    expect(r.queueContentAfter).toContain("BR-080-E");

    expect(r.code).toBe(1);
    // Phase 2 must NOT run: only the replay call went out.
    expect(r.tools).toEqual(["igris_brief_sync"]);
    // The false claim is gone from both streams.
    expect(r.stdout).not.toContain("replayed via");
    expect(r.stderr).not.toContain("replayed via");
    // The brain's own reason reaches the operator.
    expect(r.stderr).toContain("missing required argument 'title'");
  });

  it("indeterminate tier: an entry whose 200 body cannot be read is preserved, never dropped", async () => {
    // `{ok:true}` is not a JSON-RPC envelope — the CLI cannot tell whether the
    // brain accepted the entry. Dropping it on that evidence is the same class
    // of bug as dropping it on a rejection.
    const r = await replayAgainst(JSON.stringify({ ok: true }));

    expect(r.queueExistedBefore).toBe(true);
    expect(r.queueContentBefore).toContain("BR-080-E");

    expect(r.queueExistsAfter).toBe(true);
    expect(r.queueContentAfter).toContain("BR-080-E");

    expect(r.code).toBe(1);
    expect(r.tools).toEqual(["igris_brief_sync"]);
    expect(r.stdout).not.toContain("replayed via");
    expect(r.stderr).toContain("replay UNCONFIRMED");
  });

  it("control: a readable SUCCESS envelope still replays, drains, and clears the queue", async () => {
    // SELF-NEGATIVE-CONTROL — same wake-up path, same fixture, same helper;
    // only the response tier differs. Without this, the two guards above would
    // also pass if `dispatchEntry` had simply been made to always fail.
    const r = await replayAgainst(mcpOkEnvelope("Brief BR-080-E synced."));

    expect(r.queueExistedBefore).toBe(true);
    expect(r.queueExistsAfter).toBe(false);
    expect(r.code).toBe(0);
    expect(r.tools).toEqual(["igris_brief_sync", "igris_sync_queue_drain"]);
    expect(r.stdout).toContain("replayed via igris_brief_sync");
  });
});
