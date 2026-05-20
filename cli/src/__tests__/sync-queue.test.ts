/**
 * sync-queue.test.ts — FR-128 atomic-drain primitive tests.
 *
 * Real fs against tmp `~/.igris/projects/<slug>/sync_queue.jsonl`. No
 * mocks of the module under test (L-159 / TD-098). These tests pin the
 * primitive contract in isolation — the integration race + recovery
 * tests in `sync-data.test.ts` cover the end-to-end CLI path.
 *
 * Tests pinned here (matches the plan's Test Scenarios table):
 *   1. acquireDrainSnapshot returns null on empty
 *   2. acquireDrainSnapshot renames-then-reads happy path
 *   3. Concurrent append during drain preserved on next drain (AC bullet)
 *   4. finalizeDrainSnapshot(false) leaves temp for recovery
 *   5. recoverStaleDrains merges stale into existing
 *   6. recoverStaleDrains is idempotent
 *   7. inspectQueueDepth counts canonical + draining
 *
 * Plus a defensive: finalize(false) with no fresh queue file restores
 * the canonical name immediately (the optimisation branch).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpBrain: string;
const envBackup: Record<string, string | undefined> = {};

function projectDir(slug: string): string {
  const dir = join(tmpBrain, "projects", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeQueue(slug: string, lines: string[]): string {
  const dir = projectDir(slug);
  const queuePath = join(dir, "sync_queue.jsonl");
  writeFileSync(queuePath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
  return queuePath;
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-sync-queue-"));
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
});

describe("queue.ts — atomic drain primitive (FR-128)", () => {
  it("acquireDrainSnapshot returns null when no queue file exists", async () => {
    const { acquireDrainSnapshot } = await import("../lib/sync/queue.js");
    // Bare project dir — no queue file seeded.
    projectDir("demo");
    const snap = acquireDrainSnapshot("demo");
    expect(snap).toBeNull();
  });

  it("acquireDrainSnapshot returns null when the project dir doesn't exist", async () => {
    const { acquireDrainSnapshot } = await import("../lib/sync/queue.js");
    const snap = acquireDrainSnapshot("no-such-project");
    expect(snap).toBeNull();
  });

  it("acquireDrainSnapshot renames-then-reads happy path", async () => {
    const { acquireDrainSnapshot } = await import("../lib/sync/queue.js");
    const queuePath = writeQueue("demo", [
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-1" }),
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-2" }),
      JSON.stringify({ operation: "brief_create", brief_id: "TD-3" }),
    ]);

    const snap = acquireDrainSnapshot("demo");
    expect(snap).not.toBeNull();
    if (snap === null) return;
    expect(snap.entries.length).toBe(3);

    // Canonical queue file is GONE (renamed to temp).
    expect(existsSync(queuePath)).toBe(false);

    // A `.draining-<pid>-<ms>` file exists in the same directory.
    const dir = join(tmpBrain, "projects", "demo");
    const names = readdirSync(dir);
    const drainingFiles = names.filter((n) => n.startsWith("sync_queue.jsonl.draining-"));
    expect(drainingFiles.length).toBe(1);
    // Temp path returned by the primitive matches the on-disk file.
    expect(snap.tempPath).toBe(join(dir, drainingFiles[0]));
    // Temp is in the same directory as the canonical queue (atomicity
    // depends on this — same filesystem).
    expect(snap.tempPath.startsWith(dir + "/")).toBe(true);
  });

  it("concurrent append during drain is preserved on next drain (AC bullet, primitive level)", async () => {
    const { acquireDrainSnapshot, finalizeDrainSnapshot } = await import(
      "../lib/sync/queue.js"
    );
    const queuePath = writeQueue("demo", [
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-A" }),
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-B" }),
    ]);

    // First drain — snapshot the 2 lines.
    const snap1 = acquireDrainSnapshot("demo");
    expect(snap1).not.toBeNull();
    if (snap1 === null) return;
    expect(snap1.entries.length).toBe(2);

    // Simulate a sibling-harness append landing AFTER the rename.
    // The canonical name no longer exists at this moment (the temp
    // holds the snapshot), so the append creates a fresh file.
    writeFileSync(
      queuePath,
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-C-from-sibling" }) +
        "\n",
    );
    expect(existsSync(queuePath)).toBe(true);

    // Caller completes the drain successfully → temp unlinked.
    finalizeDrainSnapshot(snap1, true);
    expect(existsSync(snap1.tempPath)).toBe(false);

    // Second drain — must observe ONLY the sibling-appended line.
    const snap2 = acquireDrainSnapshot("demo");
    expect(snap2).not.toBeNull();
    if (snap2 === null) return;
    expect(snap2.entries.length).toBe(1);
    expect(snap2.entries[0]).toContain("TD-C-from-sibling");

    finalizeDrainSnapshot(snap2, true);
  });

  it("finalizeDrainSnapshot(success=false) preserves data: temp file restored to canonical when no sibling appended", async () => {
    const { acquireDrainSnapshot, finalizeDrainSnapshot } = await import(
      "../lib/sync/queue.js"
    );
    const queuePath = writeQueue("demo", [
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-X" }),
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-Y" }),
    ]);

    const snap = acquireDrainSnapshot("demo");
    expect(snap).not.toBeNull();
    if (snap === null) return;
    expect(existsSync(queuePath)).toBe(false);

    // No sibling appended — finalize(false) restores the canonical
    // queue immediately via the optimisation branch.
    finalizeDrainSnapshot(snap, false);
    expect(existsSync(queuePath)).toBe(true);
    expect(existsSync(snap.tempPath)).toBe(false);
    const lines = readLines(queuePath);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("TD-X");
    expect(lines[1]).toContain("TD-Y");
  });

  it("finalizeDrainSnapshot(success=false) leaves temp file when sibling has appended; recovered on next call", async () => {
    const { acquireDrainSnapshot, finalizeDrainSnapshot, recoverStaleDrains } =
      await import("../lib/sync/queue.js");
    const queuePath = writeQueue("demo", [
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-OLD-1" }),
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-OLD-2" }),
    ]);

    const snap = acquireDrainSnapshot("demo");
    expect(snap).not.toBeNull();
    if (snap === null) return;

    // Sibling appends mid-drain.
    writeFileSync(
      queuePath,
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-NEW-1" }) + "\n",
    );

    // Drain failed → temp must remain (cannot restore atomically when
    // canonical exists).
    finalizeDrainSnapshot(snap, false);
    expect(existsSync(snap.tempPath)).toBe(true);
    expect(existsSync(queuePath)).toBe(true);
    // Live queue carries only the sibling-appended line at this moment.
    expect(readLines(queuePath).length).toBe(1);

    // Recovery prepends stale lines to live queue.
    const report = recoverStaleDrains("demo");
    expect(report.recoveredFiles.length).toBe(1);
    expect(report.mergedLines).toBe(2);
    expect(existsSync(snap.tempPath)).toBe(false);

    const merged = readLines(queuePath);
    expect(merged.length).toBe(3);
    // FIFO time-order: stale (older drain) prepended → sibling (newer) last.
    expect(merged[0]).toContain("TD-OLD-1");
    expect(merged[1]).toContain("TD-OLD-2");
    expect(merged[2]).toContain("TD-NEW-1");
  });

  it("recoverStaleDrains adopts stale file verbatim when no canonical queue exists", async () => {
    const { recoverStaleDrains } = await import("../lib/sync/queue.js");
    const dir = projectDir("demo");
    // Manually drop a `.draining-99999-1` file — simulates a crashed
    // prior drain that left its temp behind.
    const stalePath = join(dir, "sync_queue.jsonl.draining-99999-1");
    const staleLines = [
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-STALE-1" }),
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-STALE-2" }),
    ];
    writeFileSync(stalePath, staleLines.join("\n") + "\n");

    const report = recoverStaleDrains("demo");
    expect(report.recoveredFiles.length).toBe(1);
    expect(report.mergedLines).toBe(2);

    const queuePath = join(dir, "sync_queue.jsonl");
    expect(existsSync(queuePath)).toBe(true);
    expect(existsSync(stalePath)).toBe(false);
    const live = readLines(queuePath);
    expect(live.length).toBe(2);
    expect(live[0]).toContain("TD-STALE-1");
    expect(live[1]).toContain("TD-STALE-2");
  });

  it("recoverStaleDrains merges stale temp into existing queue (FIFO head-prepend)", async () => {
    const { recoverStaleDrains } = await import("../lib/sync/queue.js");
    const dir = projectDir("demo");
    // Stale from older drain: 2 lines.
    const stalePath = join(dir, "sync_queue.jsonl.draining-99999-1");
    writeFileSync(
      stalePath,
      [
        JSON.stringify({ operation: "brief_sync", brief_id: "TD-OLD-A" }),
        JSON.stringify({ operation: "brief_sync", brief_id: "TD-OLD-B" }),
      ].join("\n") + "\n",
    );
    // Live queue: 3 lines (newer entries).
    const queuePath = join(dir, "sync_queue.jsonl");
    writeFileSync(
      queuePath,
      [
        JSON.stringify({ operation: "brief_sync", brief_id: "TD-NEW-A" }),
        JSON.stringify({ operation: "brief_sync", brief_id: "TD-NEW-B" }),
        JSON.stringify({ operation: "brief_sync", brief_id: "TD-NEW-C" }),
      ].join("\n") + "\n",
    );

    const report = recoverStaleDrains("demo");
    expect(report.recoveredFiles.length).toBe(1);
    expect(report.mergedLines).toBe(2);

    expect(existsSync(stalePath)).toBe(false);
    const merged = readLines(queuePath);
    expect(merged.length).toBe(5);
    // Stale lines prepended; live lines follow.
    expect(merged[0]).toContain("TD-OLD-A");
    expect(merged[1]).toContain("TD-OLD-B");
    expect(merged[2]).toContain("TD-NEW-A");
    expect(merged[3]).toContain("TD-NEW-B");
    expect(merged[4]).toContain("TD-NEW-C");
  });

  it("recoverStaleDrains is idempotent (no-op on bare directory)", async () => {
    const { recoverStaleDrains } = await import("../lib/sync/queue.js");
    projectDir("demo");
    const first = recoverStaleDrains("demo");
    expect(first.recoveredFiles.length).toBe(0);
    expect(first.mergedLines).toBe(0);
    const second = recoverStaleDrains("demo");
    expect(second.recoveredFiles.length).toBe(0);
    expect(second.mergedLines).toBe(0);
  });

  it("inspectQueueDepth counts canonical lines AND .draining-* lines together", async () => {
    const { inspectQueueDepth } = await import("../lib/sync/queue.js");
    const dir = projectDir("demo");
    // Canonical: 2 lines.
    writeFileSync(
      join(dir, "sync_queue.jsonl"),
      [
        JSON.stringify({ operation: "brief_sync", brief_id: "L1" }),
        JSON.stringify({ operation: "brief_sync", brief_id: "L2" }),
      ].join("\n") + "\n",
    );
    // Stale draining: 3 lines.
    writeFileSync(
      join(dir, "sync_queue.jsonl.draining-12345-9"),
      [
        JSON.stringify({ operation: "brief_sync", brief_id: "D1" }),
        JSON.stringify({ operation: "brief_sync", brief_id: "D2" }),
        JSON.stringify({ operation: "brief_sync", brief_id: "D3" }),
      ].join("\n") + "\n",
    );

    const depth = inspectQueueDepth("demo");
    expect(depth.liveLines).toBe(2);
    expect(depth.drainingLines).toBe(3);
    expect(depth.drainingFiles.length).toBe(1);
    expect(depth.drainingFiles[0]).toContain(".draining-12345-9");
  });

  it("inspectQueueDepth returns zero when project dir does not exist", async () => {
    const { inspectQueueDepth } = await import("../lib/sync/queue.js");
    const depth = inspectQueueDepth("no-such-project");
    expect(depth.liveLines).toBe(0);
    expect(depth.drainingLines).toBe(0);
    expect(depth.drainingFiles.length).toBe(0);
  });

  it("acquireDrainSnapshot self-heals stale .draining-* before snapshot", async () => {
    const { acquireDrainSnapshot, finalizeDrainSnapshot } = await import(
      "../lib/sync/queue.js"
    );
    const dir = projectDir("demo");
    // Pre-seed ONLY a stale draining file — no canonical queue.
    writeFileSync(
      join(dir, "sync_queue.jsonl.draining-99999-1"),
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-RECOVERED" }) +
        "\n",
    );

    const snap = acquireDrainSnapshot("demo");
    expect(snap).not.toBeNull();
    if (snap === null) return;
    // Recovery promoted the stale → canonical → renamed to fresh temp.
    expect(snap.entries.length).toBe(1);
    expect(snap.entries[0]).toContain("TD-RECOVERED");
    finalizeDrainSnapshot(snap, true);
  });
});
