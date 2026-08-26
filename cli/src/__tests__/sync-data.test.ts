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
 *     "params": { "name": "<tool>", "arguments": {...} }, "id": "<uuid>" }
 *
 * The id is a FRESH uuid per call since BR-094 round 2, so a fixture that
 * answers with an envelope has to echo `rpcRequestId(call)` rather than
 * hardcode one.
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
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  makeLoopback,
  mcpOkEnvelope,
  rpcRequestId,
  sseFrame,
  type CapturedCall,
} from "./loopback.js";

let tmpBrain: string;
const envBackup: Record<string, string | undefined> = {};
/** BR-096: tmp HOME roots minted by `useTmpHome`, removed in afterEach. */
let tmpHomes: string[] = [];

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

/**
 * BR-096: mint a fresh tmp HOME and point the process at it.
 *
 * A tilde-form `cache_path` is expanded through `expandTilde` (lib/paths.ts),
 * which calls `homedir()` — so the fixture has to move HOME, not just build a
 * string. Callers MUST assert `homedir()` back rather than the env var they
 * just set: reading back the variable you wrote proves nothing about what the
 * code under test resolves, and a worker pool that copies `process.env`
 * instead of sharing it would leave the assertion green and the seam dead.
 *
 * Deliberately a SECOND tmp root, not `tmpBrain`. The queue is located via
 * IGRIS_BRAIN_DIR while the tilde is expanded via HOME; collapsing the two
 * would let a fix that (wrongly) resolved `~` against the brain dir pass.
 *
 * Restoration is afterEach's job, not the caller's — an arm check that throws
 * before a `finally` would otherwise leak HOME into every later test in the
 * file.
 */
function useTmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), "igris-cli-sync-data-home-"));
  tmpHomes.push(home);
  process.env.HOME = home;
  return home;
}

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-sync-data-"));
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  envBackup.IGRIS_ALLOW_INSECURE_SYNC = process.env.IGRIS_ALLOW_INSECURE_SYNC;
  envBackup.HOME = process.env.HOME;
  tmpHomes = [];
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
  // TD-252: start each test from the refuse-default (override UNSET).
  delete process.env.IGRIS_ALLOW_INSECURE_SYNC;
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
  for (const home of tmpHomes) {
    rmSync(home, { recursive: true, force: true });
  }
  tmpHomes = [];
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
  if (envBackup.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = envBackup.HOME;
  }
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
    const lb = makeLoopback((call) => ({
      status: 200,
      body: mcpOkEnvelope(rpcRequestId(call)),
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
    const lb = makeLoopback((call) => ({
      status: 200,
      body: mcpOkEnvelope(rpcRequestId(call)),
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
    const lb = makeLoopback((call, idx) => {
      if (idx === 0) {
        return { status: 500, body: "brain server error" };
      }
      return { status: 200, body: mcpOkEnvelope(rpcRequestId(call)) };
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
      return { status: 200, body: mcpOkEnvelope(rpcRequestId(call)) };
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
  // `dispatchEntry`'s cache_path branch (cited by SYMBOL: the line form here
  // read `data.ts:240-254` and was ~180 lines stale before BR-096 touched the
  // block) handles brief_create + cache_path by
  // reading the file from disk and inlining its contents as `content`,
  // then stripping `cache_path` before forwarding. The two cases below
  // pin both the success and the missing-file branches.
  // ---------------------------------------------------------------------
  it("brief_create with cache_path: reads file and inlines as content; cache_path stripped (TD-119)", async () => {
    const lb = makeLoopback((call) => ({
      status: 200,
      body: mcpOkEnvelope(rpcRequestId(call)),
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
    const lb = makeLoopback((call) => ({
      status: 200,
      body: mcpOkEnvelope(rpcRequestId(call)),
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
    const lb = makeLoopback((call) => ({
      status: 200,
      body: mcpOkEnvelope(rpcRequestId(call)),
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

    const lb = makeLoopback(async (call, idx) => {
      if (idx === 0) {
        // First call = per-entry replay. Hold response until the test
        // simulates the sibling-harness append.
        await barrier;
      }
      return { status: 200, body: mcpOkEnvelope(rpcRequestId(call)) };
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
    const lb = makeLoopback((call) => ({
      status: 200,
      body: mcpOkEnvelope(rpcRequestId(call)),
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
    const lb = makeLoopback((call) => ({
      status: 200,
      body: mcpOkEnvelope(rpcRequestId(call)),
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
      // mcpCall was reached (the cache_path catch inside `dispatchEntry`
      // returns 1 directly; cited by symbol, the old `data.ts:243-252` form
      // was ~180 lines stale).
      expect(lb.calls.length).toBe(0);
      // Queue file MUST remain (preserve-on-failure contract).
      expect(existsSync(queuePath)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  // ---------------------------------------------------------------------
  // BR-096: a TILDE-form cache_path.
  //
  // `/register`'s MCP-unavailable fallback (core/skills/register/SKILL.md)
  // minted `"cache_path":"~/.igris/projects/{project}/briefs/…"`. Node's
  // `readFileSync` never expands `~` — it treats the tilde as a literal
  // directory name — so the read ENOENTs, `dispatchEntry` returns 1, and
  // the queue is preserved for a retry that fails identically forever. The
  // live `igris-ai` queue sat stuck on exactly this from 2026-08-20, and
  // every `/boot` since reported a drain failure. No test here covered the
  // tilde notation, which is precisely why it shipped.
  //
  // The three cases below are a matched set and are only meaningful read
  // together:
  //
  //   (a) the tilde form drains — the fix;
  //   (b) the SAME fixture with an absolute cache_path drains — the
  //       CONTROL. It is green before AND after the fix, so (a)'s red is
  //       attributable to the tilde NOTATION rather than to this fixture's
  //       harness, its loopback, or its tmp HOME;
  //   (c) an UNREADABLE tilde path names the path actually attempted, so
  //       the next debugger is not sent to a literal `~`.
  //
  // (a) and (b) differ in exactly one character sequence: the `cache_path`
  // string. Same file on disk, same contents, same queue shape, same HOME.
  // ---------------------------------------------------------------------
  const BR096_REL = ".igris/projects/demo/briefs/BR-096-cache.md";
  const BR096_CONTENTS = "# BR-096 cache fixture\n\nbody.";

  it("BR-096: brief_create with a TILDE-form cache_path drains (the /register fallback shape)", async () => {
    const lb = makeLoopback((call) => ({
      status: 200,
      body: mcpOkEnvelope(rpcRequestId(call)),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    const home = useTmpHome();
    const tildePath = `~/${BR096_REL}`;
    const absPath = join(home, BR096_REL);

    try {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, BR096_CONTENTS);

      // Arm checks. Without these, a green below could mean the wrong thing:
      //  1. the HOME seam is LIVE in this worker — read through homedir(),
      //     which is the call the code under test makes;
      //  2. the literal string is NOT a path that exists from the test's
      //     cwd, so nothing but expansion can reach the fixture;
      //  3. the file the expansion targets does exist.
      expect(homedir()).toBe(home);
      expect(existsSync(tildePath)).toBe(false);
      expect(existsSync(absPath)).toBe(true);

      const queuePath = writeQueue("demo", [
        JSON.stringify({
          operation: "brief_create",
          project: "demo",
          brief_id: "BR-096",
          title: "tilde-cache",
          cache_path: tildePath,
        }),
      ]);

      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      expect(code).toBe(0);

      // 1 per-entry replay + 1 drain — the entry reached the wire at all,
      // which the unfixed consumer never managed (it returned 1 before any
      // HTTP call).
      expect(lb.calls.length).toBe(2);
      const replay = lb.calls[0];
      expect(replay.toolName).toBe("igris_brief_create");
      // Read through the EXPANSION: byte-for-byte the file under tmp HOME.
      expect(replay.args?.content).toBe(BR096_CONTENTS);
      expect(replay.args?.cache_path).toBeUndefined();
      // The operator-visible symptom was a queue that never emptied.
      expect(existsSync(queuePath)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("BR-096 control: the SAME fixture with an ABSOLUTE cache_path drains (green before AND after the fix)", async () => {
    const lb = makeLoopback((call) => ({
      status: 200,
      body: mcpOkEnvelope(rpcRequestId(call)),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    const home = useTmpHome();
    const absPath = join(home, BR096_REL);

    try {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, BR096_CONTENTS);
      expect(homedir()).toBe(home);
      expect(existsSync(absPath)).toBe(true);

      const queuePath = writeQueue("demo", [
        JSON.stringify({
          operation: "brief_create",
          project: "demo",
          brief_id: "BR-096",
          title: "tilde-cache",
          // The ONE variable versus the case above.
          cache_path: absPath,
        }),
      ]);

      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      expect(code).toBe(0);
      expect(lb.calls.length).toBe(2);
      const replay = lb.calls[0];
      expect(replay.toolName).toBe("igris_brief_create");
      expect(replay.args?.content).toBe(BR096_CONTENTS);
      expect(replay.args?.cache_path).toBeUndefined();
      expect(existsSync(queuePath)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("BR-096: an unreadable TILDE cache_path reports the path actually ATTEMPTED, not just the queued literal", async () => {
    const lb = makeLoopback((call) => ({
      status: 200,
      body: mcpOkEnvelope(rpcRequestId(call)),
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${lb.port()}`, api_key: "k" },
    });

    const home = useTmpHome();
    const rel = ".igris/projects/demo/briefs/BR-096-absent.md";
    const tildePath = `~/${rel}`;
    const absPath = join(home, rel);

    const stderrBuf: string[] = [];
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      // Deliberately NOT created — this is the failure path.
      expect(homedir()).toBe(home);
      expect(existsSync(absPath)).toBe(false);

      const queuePath = writeQueue("demo", [
        JSON.stringify({
          operation: "brief_create",
          project: "demo",
          brief_id: "BR-096",
          title: "absent-cache",
          cache_path: tildePath,
        }),
      ]);

      const { runSyncData } = await import("../lib/sync/data.js");
      const code = await runSyncData({ projectSlug: "demo" });
      expect(code).toBe(1);
      expect(lb.calls.length).toBe(0);
      expect(existsSync(queuePath)).toBe(true);

      const out = stderrBuf.join("");

      // Assert on the CLI-AUTHORED head of the line only — everything before
      // ` unreadable:`. Asserting `out` as a whole is VACUOUS here, and that
      // is measured, not suspected: with the read fixed but the message left
      // in its pre-BR-096 form, Node's own ENOENT text embeds the resolved
      // path (`… open '/var/folders/…/BR-096-absent.md'`), so a whole-string
      // `toContain(absPath)` passes while the CLI still prints the literal
      // alone. That route is an accident of ONE errno's wording — a throw
      // that is not an fs error, or is not an Error at all, carries no path —
      // so the guarantee has to live in the slot the CLI controls.
      const cut = out.indexOf(" unreadable:");
      expect(cut).toBeGreaterThan(0);
      const authored = out.slice(0, cut);
      // The queued literal — what to fix in the queue file.
      expect(authored).toContain(`cache_path=${tildePath}`);
      // The path actually ATTEMPTED — what to look for on disk. Before the
      // fix the message carried only the literal, so a reader chasing this
      // ENOENT was sent to a directory named `~`.
      expect(authored).toContain(absPath);
    } finally {
      errSpy.mockRestore();
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
// WHAT IT DOES NOT PROVE: that a real brain error carries this shape when the
// response is routed through `StreamableHTTPServerTransport` (the HTTP
// fallback-A path emits SSE, not plain JSON). BR-094 corrected the previous
// claim here that an SSE response "lands in the indeterminate tier": since
// BR-094 `mcpCall` reads the `data:` frame, so an SSE 200 classifies by its
// envelope like any other. Case 3d below pins that classification (3c pins the
// outbound header and classifies nothing), and case 3b keeps the indeterminate
// tier pinned with a body nothing can parse -- NOT case 3, whose `{drained:0}`
// body parses fine and is indeterminate for a different reason (no envelope).
//
// The loopback is the same fake the rest of this file uses; it validates
// nothing, so these cases are about the CLI's READING of a response, not about
// the brain's behaviour. The brain-side half is
// `brain-mcp-server/src/tools/__tests__/sync-queue-drain-contract.test.ts`.
// -------------------------------------------------------------------------
describe("sync data — remote drain result classification (BR-080)", () => {
  /**
   * Boot a loopback, point config at it, run drain-only, capture stdout+stderr.
   *
   * `body` may be a builder taking the captured call (BR-094 round 2), because
   * `mcpCall` now mints a fresh JSON-RPC id per call and an SSE fixture has to
   * ECHO it to be this call's answer. A fixed string is still accepted for the
   * cases whose whole point is a body no reader can correlate.
   */
  async function runDrainAgainst(
    body: string | ((call: CapturedCall) => string),
    status = 200,
    contentType?: string,
  ): Promise<{
    code: number;
    stdout: string;
    stderr: string;
    callCount: number;
    /** Request headers of the FIRST captured call (BR-094). */
    reqHeaders: Record<string, string | string[] | undefined>;
  }> {
    const lb = makeLoopback((call) => ({
      status,
      body: typeof body === "string" ? body : body(call),
      contentType,
    }));
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
        reqHeaders: lb.calls[0]?.headers ?? {},
      };
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  }

  it("case 1 (R2): HTTP 200 carrying isError:true → exit 1 and NO 'drain OK' claim", async () => {
    const { code, stdout, stderr, callCount } = await runDrainAgainst((call) =>
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
        id: rpcRequestId(call),
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
    const { code, stdout, callCount } = await runDrainAgainst((call) =>
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
        id: rpcRequestId(call),
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
    // This is the shape ~8 pre-existing loopbacks in this file return.
    // BR-094 CORRECTED the second half of this sentence, which used to read
    // "and the shape the SSE/StreamableHTTP fallback can produce". Two reasons
    // THIS shape cannot arrive on the SSE arm, and the narrow one is the one
    // that would survive a reader change: `{"drained":0}` carries no `id` at
    // all, so no correlation can match it. The general claim — that an SSE 200
    // reaches `classifyToolCallBody` as a JSON-RPC response or as `null` and
    // never as some other object — is true only because `readSseJsonRpc` also
    // requires `jsonrpc: "2.0"` and a `result`/`error` key (BR-094 round 2);
    // it was FALSE for the round-1 reader, which validated the id alone and
    // would have returned `{"id":<ours>,"junk":true}` verbatim. So
    // this fixture models the legacy loopbacks only. It must neither fail
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
    // Any 200 whose body no reader can interpret: an nginx/gateway error page
    // or a truncated response. The fixture used to be an SSE frame, carried
    // beside a comment recording that `mcpCall` sent NO `Accept` header — which
    // is why the brain answered 406 and an SSE 200 could never arrive. BR-094
    // replaced that comment with the header assertion below and moved the SSE
    // frame to its own case (3c), because a frame `mcpCall` can now READ is no
    // longer an instance of this class. The body here is an nginx 502 page,
    // the shape a proxy in front of the brain actually returns.
    const { code, stdout, callCount } = await runDrainAgainst(
      "<html><head><title>502 Bad Gateway</title></head><body>\n<center><h1>502 Bad Gateway</h1></center>\n<hr><center>nginx/1.24.0 (Ubuntu)</center>\n</body></html>\n",
    );

    expect(callCount).toBe(1);
    expect(code).toBe(0);
    expect(stdout).not.toContain("remote drain OK");
    expect(stdout).toContain("could not be read");
  });

  // ---------------------------------------------------------------------
  // BR-094 — the outbound `Accept` header, and the SSE shape it unlocks.
  //
  // THE DEFECT: `mcpCall` sent Content-Type, Content-Length and Authorization
  // and no `Accept`. The MCP Streamable HTTP transport rejects that at the
  // transport layer, BEFORE dispatch, so every remote drain got
  //   HTTP 406 {"jsonrpc":"2.0","error":{"code":-32000,"message":"Not
  //   Acceptable: Client must accept both application/json and
  //   text/event-stream"},"id":null}
  // and the queue grew forever. Measured live against https://brain.fifty.dev
  // on 2026-08-24: without the header 406, with it 200.
  //
  // WHY A HEADER TEST AND NOT ONLY A BEHAVIOUR TEST: the loopback validates
  // nothing, so no response-shaped fixture in this file can go red on a missing
  // request header. This whole defect shipped past a green suite for that
  // reason. The assertion is on what the CLI SENDS.
  // ---------------------------------------------------------------------
  it("case 3c (BR-094): the outbound request carries Accept for BOTH MCP media types", async () => {
    const { reqHeaders, callCount } = await runDrainAgainst((call) =>
      mcpOkEnvelope(rpcRequestId(call)),
    );

    expect(callCount).toBe(1);
    const accept = reqHeaders.accept;
    expect(typeof accept).toBe("string");
    // Asserted as the two tokens, not as one literal string: the server-side
    // check is `includes('application/json') && includes('text/event-stream')`
    // on the raw header (@modelcontextprotocol/sdk
    // dist/esm/server/webStandardStreamableHttp.js:378), so the CONTRACT is the
    // presence of both tokens — a reordering must not red this test, a dropped
    // token must.
    expect(accept as string).toContain("application/json");
    expect(accept as string).toContain("text/event-stream");
  });

  it("case 3d (BR-094): a text/event-stream 200 is READ, not filed as unreadable", async () => {
    // The wire shape the brain returns whenever an MCP session is active — the
    // live case, not an edge case: `StreamableHTTPServerTransport` is
    // constructed without `enableJsonResponse` (default false, and the brain
    // never sets it), so the transport path ALWAYS answers a POST with SSE.
    // Frame is the SDK's own `writeSSEEvent` output: `event: message\n`, an
    // OPTIONAL `id: <eventId>\n` resumability cursor, then `data: <json>\n\n`.
    // The `id:` LINE is included deliberately — it is not the JSON-RPC id, and
    // a reader that confuses the two reads the wrong value.
    const { code, stdout, callCount } = await runDrainAgainst(
      (call) =>
        sseFrame(
          JSON.stringify({
            jsonrpc: "2.0",
            result: {
              content: [
                {
                  type: "text",
                  text: "Sync queue drain completed successfully.\nItems sent: 3",
                },
              ],
            },
            // Echoes what the CLI actually sent. A hardcoded id here would
            // pin the round-1 module constant and go red on the real fix.
            id: rpcRequestId(call),
          }),
          7,
        ),
      200,
      "text/event-stream",
    );

    expect(callCount).toBe(1);
    expect(code).toBe(0);
    // The discriminating assertion: BEFORE BR-094 this body reached
    // `JSON.parse` and threw, so the drain reported the indeterminate tier.
    expect(stdout).not.toContain("could not be read");
    expect(stdout).toContain("Sync queue drain completed successfully.");
    expect(stdout).toContain("Items sent: 3");
  });

  it("case 3e (BR-094): an SSE frame answering a DIFFERENT JSON-RPC id stays indeterminate", async () => {
    // The defined unknown: a frame that is not this call's answer is not
    // evidence of anything. `mcpCall` correlates on the id it sent and returns
    // null otherwise, rather than reading "the last frame that looked like a
    // reply" — a plausible-but-wrong verdict is what BR-080 removed.
    //
    // BR-094 round 2: the "different" id is DERIVED from the one the CLI sent
    // rather than being a literal `99`. Under the round-1 module constant, `99`
    // was different only because the constant happened to be `1`; derive it and
    // the case stays a genuine non-answer whatever the id scheme becomes.
    const { code, stdout, callCount } = await runDrainAgainst(
      (call) =>
        sseFrame(
          JSON.stringify({
            jsonrpc: "2.0",
            result: {
              content: [{ type: "text", text: "someone else's answer" }],
            },
            id: `${String(rpcRequestId(call))}-someone-else`,
          }),
        ),
      200,
      "text/event-stream",
    );

    expect(callCount).toBe(1);
    expect(code).toBe(0);
    expect(stdout).not.toContain("remote drain OK");
    expect(stdout).not.toContain("someone else's answer");
    expect(stdout).toContain("could not be read");
  });

  // -------------------------------------------------------------------------
  // 3f-i and 3f-ii (BR-094 round 2) — the reader's SHAPE checks.
  //
  // The round-1 reader validated the id ALONE, so `{"id":<ours>,"junk":true}`
  // was returned verbatim and reached `classifyToolCallBody` as a bare
  // non-envelope object — falsifying the "never a bare non-envelope object"
  // comments this file and `sync/data.ts` both carried. The reader now also
  // requires `jsonrpc: "2.0"` AND one of `result`/`error`.
  //
  // TWO measured facts shape how these are written, and neither was obvious:
  //
  //   1. The conditions are a CONJUNCTION, so a single fixture violating BOTH
  //      (warden's `{"id":1,"junk":true}`) arms NEITHER — deleting either check
  //      alone left it green, because the other still refused the frame. Each
  //      condition therefore gets a fixture violating exactly one of them, plus
  //      a same-shape control with that one key restored.
  //   2. The assertion has to be on `mcpCall`'s `json`, NOT on the drain's
  //      stdout. `classifyToolCallBody` routes an object with no `result` to the
  //      indeterminate tier anyway, so the drain prints "could not be read"
  //      either way and a stdout assertion is VACUOUS for the result/error
  //      check — measured: deleting it kept a drain-level case green. `json` is
  //      the value the prose in `sync/data.ts` actually makes a claim about.
  // -------------------------------------------------------------------------

  /** Drive exactly ONE `mcpCall` against a loopback returning `buildBody`. */
  async function mcpCallAgainst(
    buildBody: (call: CapturedCall) => string,
    contentType: string,
  ): Promise<{ statusCode: number; json: unknown; callCount: number }> {
    const lb = makeLoopback((call) => ({
      status: 200,
      body: buildBody(call),
      contentType,
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const { mcpCall } = await import("../lib/mcp-client.js");
      const r = await mcpCall(
        { url: `http://127.0.0.1:${lb.port()}`, apiKey: "k" },
        "igris_sync_queue_drain",
        {},
      );
      return {
        statusCode: r.statusCode,
        json: r.json,
        callCount: lb.calls.length,
      };
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  }

  it("case 3f-i (BR-094 round 2): a correlated frame with a result but NO jsonrpc is not read as this call's answer", async () => {
    const bait = await mcpCallAgainst(
      (call) =>
        sseFrame(
          JSON.stringify({
            // `jsonrpc` deliberately absent — everything else is a valid answer.
            result: { content: [{ type: "text", text: "shape-check bait" }] },
            id: rpcRequestId(call),
          }),
        ),
      "text/event-stream",
    );
    // CONTROL — the SAME frame with only `jsonrpc` restored. Without it, a
    // reader that refused every SSE frame would pass the assertion above.
    const control = await mcpCallAgainst(
      (call) =>
        sseFrame(
          JSON.stringify({
            jsonrpc: "2.0",
            result: { content: [{ type: "text", text: "shape-check bait" }] },
            id: rpcRequestId(call),
          }),
        ),
      "text/event-stream",
    );

    expect(bait.callCount).toBe(1);
    expect(bait.statusCode).toBe(200);
    expect(bait.json).toBeNull();

    expect(control.statusCode).toBe(200);
    expect(control.json).not.toBeNull();
    expect(JSON.stringify(control.json)).toContain("shape-check bait");
  });

  it("case 3f-ii (BR-094 round 2): a correlated frame with jsonrpc but NEITHER result NOR error is not read as this call's answer", async () => {
    // This is the shape that made the old "never a bare non-envelope object"
    // claim false: an object, correlated, carrying no answer at all.
    const bait = await mcpCallAgainst(
      (call) =>
        sseFrame(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpcRequestId(call),
            junk: true,
          }),
        ),
      "text/event-stream",
    );
    // CONTROL — same frame with a `result` added, nothing else changed.
    const control = await mcpCallAgainst(
      (call) =>
        sseFrame(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpcRequestId(call),
            junk: true,
            result: { content: [{ type: "text", text: "now an answer" }] },
          }),
        ),
      "text/event-stream",
    );

    expect(bait.callCount).toBe(1);
    expect(bait.statusCode).toBe(200);
    expect(bait.json).toBeNull();

    expect(control.statusCode).toBe(200);
    expect(control.json).not.toBeNull();
    expect(JSON.stringify(control.json)).toContain("now an answer");
  });

  it("case 3h (BR-094 round 2, M4): a response body past the byte cap is aborted, not buffered", async () => {
    // `timeout` on a node http request is a SOCKET IDLE timeout, so it never
    // fires on a peer that keeps emitting — and `text/event-stream` is a media
    // type designed to stay open, behind an nginx configured `proxy_buffering
    // off` / `proxy_read_timeout 86400`. Unbounded accumulation was pre-existing
    // for JSON and newly meaningful once SSE became reachable.
    //
    // The fixture size is DERIVED from the exported cap rather than quoted, so
    // raising the cap cannot silently make this case stop testing it.
    const { mcpCall, MCP_MAX_RESPONSE_BYTES } = await import(
      "../lib/mcp-client.js"
    );
    const oversized = "x".repeat(MCP_MAX_RESPONSE_BYTES + 1024);

    const lb = makeLoopback(() => ({
      status: 200,
      body: oversized,
      contentType: "text/event-stream",
    }));
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );

    try {
      const remote = { url: `http://127.0.0.1:${lb.port()}`, apiKey: "k" };
      const over = await mcpCall(remote, "igris_sync_queue_drain", {});

      // The request DID go out — this is an abort, not a connection failure.
      expect(lb.calls.length).toBe(1);
      // `statusCode: 0` is this module's transport-failure convention, and it
      // is the FAIL-SAFE verdict: `callRemoteDrain` exits 1 and `dispatchEntry`
      // treats a non-200 as not-replayed, so no queue is unlinked on it.
      expect(over.statusCode).toBe(0);
      expect(over.body).toContain("exceeded");
      expect(over.json).toBeNull();
      // The oversized payload was NOT retained.
      expect(over.body.length).toBeLessThan(200);
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("case 3h-control (BR-094 round 2, M4): a body just UNDER the cap is still read normally", async () => {
    // SELF-NEGATIVE-CONTROL for 3h. Without it, a cap of zero — or a reader
    // that aborted every response — would satisfy 3h perfectly.
    const { mcpCall, MCP_MAX_RESPONSE_BYTES } = await import(
      "../lib/mcp-client.js"
    );

    const lb = makeLoopback((call) => {
      const frame = sseFrame(mcpOkEnvelope(rpcRequestId(call), "under the cap"));
      // Pad with SSE comment lines (`:` prefix) so the body is large but the
      // frame is still the SDK's shape. Comments carry no `data:` line, so the
      // reader skips them exactly as it would a keep-alive.
      const padTo = MCP_MAX_RESPONSE_BYTES - 4096;
      const pad = `: ${"y".repeat(padTo - frame.length - 4)}\n\n`;
      return { status: 200, body: pad + frame, contentType: "text/event-stream" };
    });
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );

    try {
      const remote = { url: `http://127.0.0.1:${lb.port()}`, apiKey: "k" };
      const under = await mcpCall(remote, "igris_sync_queue_drain", {});

      expect(lb.calls.length).toBe(1);
      expect(under.body.length).toBeGreaterThan(MCP_MAX_RESPONSE_BYTES - 8192);
      expect(under.body.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_BYTES);
      expect(under.statusCode).toBe(200);
      expect(under.json).not.toBeNull();
      expect(JSON.stringify(under.json)).toContain("under the cap");
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("case 3g (BR-094 round 2): two concurrent calls sharing one transport cannot read each other's frames", async () => {
    // THE CRITICAL DEFECT ROUND 1 OPENED. `mcpCall` used a MODULE-scope
    // `MCP_REQUEST_ID = 1`, so the SSE correlation checked the call CLASS, not
    // the call. Two facts make that a data-loss path:
    //   - the SDK transport demultiplexes replies by JSON-RPC id per transport
    //     (`_requestToStreamMapping.set(message.id, streamId)` in the vendored
    //     `webStandardStreamableHttp.js`), so a second request carrying the SAME
    //     id overwrites the first's mapping and the first answer is written into
    //     the SECOND caller's body;
    //   - the brain funnels every session-less POST into ONE session
    //     (`activeSessions[activeSessions.length - 1]`), and SSE is only
    //     reachable when that list is non-empty — so any run that sees SSE has
    //     proved a co-tenant exists.
    // A concurrent `igris sync data` / `boot-sync` would then read the other
    // run's success envelope as its own, and `finalizeDrainSnapshot(_, true)`
    // would unlink a queue whose entries the brain never received.
    //
    // The fixture reproduces the SERVER-SIDE SWAP directly: it holds both
    // requests until both have arrived, then answers each one with the frame
    // addressed to the OTHER. Under the module constant both frames carry id 1,
    // the swap is invisible, and both calls read a success. With a per-call
    // uuid each call sees a frame addressed to someone else and returns null.
    const { mcpCall } = await import("../lib/mcp-client.js");

    const sentIds: unknown[] = [];
    let release!: () => void;
    const bothArrived = new Promise<void>((r) => {
      release = r;
    });

    const lb = makeLoopback(async (call, idx) => {
      // Read the id out of the RAW body, so this fixture's evidence does not
      // depend on the loopback's own JSON-RPC field parsing.
      sentIds[idx] = (JSON.parse(call.rawBody) as { id?: unknown }).id;
      if (idx === 1) release();
      await bothArrived;
      const otherId = sentIds[idx === 0 ? 1 : 0];
      return {
        status: 200,
        body: sseFrame(
          JSON.stringify({
            jsonrpc: "2.0",
            result: {
              content: [{ type: "text", text: `answer for ${String(otherId)}` }],
            },
            id: otherId,
          }),
        ),
        contentType: "text/event-stream",
      };
    });
    await new Promise<void>((resolve) =>
      lb.server.listen(0, "127.0.0.1", resolve),
    );

    try {
      const remote = {
        url: `http://127.0.0.1:${lb.port()}`,
        apiKey: "k",
      };
      const [a, b] = await Promise.all([
        mcpCall(remote, "igris_sync_queue_drain", {}),
        mcpCall(remote, "igris_sync_queue_drain", {}),
      ]);

      // Both requests really went out and really carried an id — without this
      // the assertions below could pass on a fixture that never ran.
      expect(lb.calls.length).toBe(2);
      expect(sentIds[0]).toBeTypeOf("string");
      expect(sentIds[1]).toBeTypeOf("string");

      // (1) The ids are per-CALL, not per-module. This is the assertion the
      // round-1 constant fails outright.
      expect(sentIds[0]).not.toBe(sentIds[1]);

      // (2) And the consequence: neither call accepts the other's answer. Both
      // reach HTTP 200 — this is a correlation verdict, not a transport
      // failure — and both read as the defined unknown.
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(a.json).toBeNull();
      expect(b.json).toBeNull();
      // Belt and braces: the swapped text must not have been read as ours.
      expect(JSON.stringify(a.json)).not.toContain("answer for");
      expect(JSON.stringify(b.json)).not.toContain("answer for");
    } finally {
      await new Promise<void>((resolve) => lb.server.close(() => resolve()));
    }
  });

  it("case 5 (D5): HTTP 200 carrying a JSON-RPC error envelope → exit 1, classified error not indeterminate", async () => {
    // A JSON-RPC `error` envelope has no `result` key, so without an explicit
    // branch it falls into the indeterminate tier — "unreadable" is provably
    // wrong for the one shape that states failure outright.
    const { code, stdout, stderr, callCount } = await runDrainAgainst((call) =>
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32602, message: "Invalid params: remote_url" },
        id: rpcRequestId(call),
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
  const guardThrowBody = (call: CapturedCall): string =>
    JSON.stringify({
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
      id: rpcRequestId(call),
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
  async function replayAgainst(
    body: string | ((call: CapturedCall) => string),
    contentType?: string,
  ): Promise<{
    code: number;
    tools: (string | undefined)[];
    queueExistedBefore: boolean;
    queueContentBefore: string;
    queueExistsAfter: boolean;
    queueContentAfter: string;
    stdout: string;
    stderr: string;
  }> {
    const isSse = contentType === "text/event-stream";
    const lb = makeLoopback((call) => {
      // BR-094: when the arm is SSE, BOTH responses are SSE — a real transport
      // session does not answer one call in JSON and the next in SSE, and a
      // mixed fixture would leave the drain half untested on this wire shape.
      // The entry body is passed already-framed by the caller, so only the
      // drain body is wrapped here.
      if (call.toolName === "igris_sync_queue_drain") {
        const drainBody = mcpOkEnvelope(
          rpcRequestId(call),
          "Sync queue drain completed successfully.",
        );
        return {
          status: 200,
          body: isSse ? sseFrame(drainBody) : drainBody,
          contentType,
        };
      }
      return {
        status: 200,
        body: typeof body === "string" ? body : body(call),
        contentType,
      };
    });
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
    const r = await replayAgainst(guardThrowBody);

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
    const r = await replayAgainst((call) =>
      mcpOkEnvelope(rpcRequestId(call), "Brief BR-080-E synced."),
    );

    expect(r.queueExistedBefore).toBe(true);
    expect(r.queueExistsAfter).toBe(false);
    expect(r.code).toBe(0);
    expect(r.tools).toEqual(["igris_brief_sync", "igris_sync_queue_drain"]);
    expect(r.stdout).toContain("replayed via igris_brief_sync");
  });

  it("BR-094: a success envelope delivered as text/event-stream also replays and clears the queue", async () => {
    // The wire shape a live brain session actually returns. The control above
    // proves the queue clears on a JSON success; this proves the SAME outcome
    // on the SSE success, which is the one every real drain gets. Before
    // BR-094 the request never got this far (406 at the transport), and with
    // only the Accept header added it got HTTP 200 and stalled here instead —
    // the body was unreadable, so the entry stayed queued forever. Both halves
    // of the fix are load-bearing and this case pins the second.
    const r = await replayAgainst(
      (call) =>
        sseFrame(
          mcpOkEnvelope(rpcRequestId(call), "Brief BR-080-E synced."),
          1,
        ),
      "text/event-stream",
    );

    expect(r.queueExistedBefore).toBe(true);
    expect(r.queueContentBefore).toContain("BR-080-E");
    expect(r.queueExistsAfter).toBe(false);
    expect(r.code).toBe(0);
    expect(r.tools).toEqual(["igris_brief_sync", "igris_sync_queue_drain"]);
    expect(r.stdout).toContain("replayed via igris_brief_sync");
  });
});
