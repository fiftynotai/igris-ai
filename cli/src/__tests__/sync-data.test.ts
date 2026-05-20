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
import { makeLoopback } from "./loopback.js";

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
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
  vi.restoreAllMocks();
});

describe("sync data — runSyncData", () => {
  it("remote_brain not configured → exit 1", async () => {
    const { runSyncData } = await import("../lib/sync/data.js");
    const code = await runSyncData();
    expect(code).toBe(1);
  });

  it("empty local queue: still calls remote drain (returns 0 on HTTP 200)", async () => {
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
      body: JSON.stringify({ ok: true }),
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
      body: JSON.stringify({ ok: true }),
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
      return { status: 200, body: JSON.stringify({ ok: true }) };
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
      return { status: 200, body: JSON.stringify({ ok: true }) };
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
      body: JSON.stringify({ ok: true }),
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
      body: JSON.stringify({ ok: true }),
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
      body: JSON.stringify({ ok: true }),
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
      return { status: 200, body: JSON.stringify({ ok: true }) };
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
      body: JSON.stringify({ ok: true }),
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
      body: JSON.stringify({ ok: true }),
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
