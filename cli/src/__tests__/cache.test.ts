/**
 * cache.ts tests — M1.5.
 *
 * Real fs against tmp; IGRIS_BRAIN_DIR override drives `cacheDir()`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let brainRoot: string;

beforeEach(() => {
  brainRoot = mkdtempSync(join(tmpdir(), "igris-cache-test-"));
  process.env.IGRIS_BRAIN_DIR = brainRoot;
});

afterEach(() => {
  rmSync(brainRoot, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
});

const FAKE_SHA = "a".repeat(64);

function stageSource(work: string): {
  tarballPath: string;
  extractedDir: string;
} {
  const tarballPath = join(work, "src.tar.gz");
  writeFileSync(tarballPath, "FAKE_GZIP_BYTES");
  const extractedDir = join(work, "src-extracted");
  mkdirSync(join(extractedDir, "core"), { recursive: true });
  writeFileSync(join(extractedDir, "core", "SOUL.md"), "soul\n");
  return { tarballPath, extractedDir };
}

describe("cache — write-then-hit", () => {
  it("cacheStore creates entry; findCached returns it inside TTL window", async () => {
    const m = await import("../lib/cache.js");
    const { tarballPath, extractedDir } = stageSource(brainRoot);

    m.cacheStore(FAKE_SHA, {
      tarballSourcePath: tarballPath,
      extractedSourcePath: extractedDir,
      channel: "release",
      ref: "v7.0.0",
    });

    const hit = m.findCached(FAKE_SHA);
    expect(hit).not.toBeNull();
    expect(hit!.meta.channel).toBe("release");
    expect(hit!.meta.ref).toBe("v7.0.0");
    expect(existsSync(hit!.tarballPath)).toBe(true);
    expect(
      existsSync(join(hit!.extractedPath, "core", "SOUL.md")),
    ).toBe(true);
  });

  it("findCached returns null for unknown sha", async () => {
    const m = await import("../lib/cache.js");
    const hit = m.findCached(FAKE_SHA);
    expect(hit).toBe(null);
  });

  it("cacheStore is idempotent (overwriting prior entry of same sha)", async () => {
    const m = await import("../lib/cache.js");
    const { tarballPath, extractedDir } = stageSource(brainRoot);

    m.cacheStore(FAKE_SHA, {
      tarballSourcePath: tarballPath,
      extractedSourcePath: extractedDir,
      channel: "release",
      ref: "v7.0.0",
    });

    // Modify source and re-store.
    writeFileSync(join(extractedDir, "core", "SOUL.md"), "soul-v2\n");
    m.cacheStore(FAKE_SHA, {
      tarballSourcePath: tarballPath,
      extractedSourcePath: extractedDir,
      channel: "release",
      ref: "v7.0.1",
    });

    const hit = m.findCached(FAKE_SHA);
    expect(hit!.meta.ref).toBe("v7.0.1");
    expect(
      readFileSync(join(hit!.extractedPath, "core", "SOUL.md"), "utf-8"),
    ).toBe("soul-v2\n");
  });
});

describe("cache — TTL expiry", () => {
  it("main channel entry expires after TTL_MAIN_MS", async () => {
    const m = await import("../lib/cache.js");
    const { tarballPath, extractedDir } = stageSource(brainRoot);

    m.cacheStore(FAKE_SHA, {
      tarballSourcePath: tarballPath,
      extractedSourcePath: extractedDir,
      channel: "main",
      ref: "main",
    });

    // 23h — still fresh.
    const fetchedMs = Date.parse(
      (
        JSON.parse(
          readFileSync(m.cacheMetaPath(FAKE_SHA), "utf-8"),
        ) as { fetched_at: string }
      ).fetched_at,
    );
    expect(m.findCached(FAKE_SHA, fetchedMs + 23 * 60 * 60 * 1000)).not.toBeNull();
    // 25h — expired.
    expect(m.findCached(FAKE_SHA, fetchedMs + 25 * 60 * 60 * 1000)).toBe(null);
  });

  it("release channel entry never expires (TTL infinite)", async () => {
    const m = await import("../lib/cache.js");
    const { tarballPath, extractedDir } = stageSource(brainRoot);

    m.cacheStore(FAKE_SHA, {
      tarballSourcePath: tarballPath,
      extractedSourcePath: extractedDir,
      channel: "release",
      ref: "v7.0.0",
    });

    // Decade in the future — still fresh.
    expect(
      m.findCached(FAKE_SHA, Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
    ).not.toBeNull();
  });

  it("explicit ttlMs override is honored", async () => {
    const m = await import("../lib/cache.js");
    const { tarballPath, extractedDir } = stageSource(brainRoot);

    m.cacheStore(FAKE_SHA, {
      tarballSourcePath: tarballPath,
      extractedSourcePath: extractedDir,
      channel: "release",
      ref: "v7.0.0",
      ttlMs: 1000, // 1 second
    });

    const fetchedMs = Date.parse(
      (
        JSON.parse(
          readFileSync(m.cacheMetaPath(FAKE_SHA), "utf-8"),
        ) as { fetched_at: string }
      ).fetched_at,
    );
    expect(m.findCached(FAKE_SHA, fetchedMs + 500)).not.toBeNull();
    expect(m.findCached(FAKE_SHA, fetchedMs + 2000)).toBe(null);
  });
});

describe("cache — corruption + eviction", () => {
  it("findCached returns null when meta.json is corrupt", async () => {
    const m = await import("../lib/cache.js");
    const { tarballPath, extractedDir } = stageSource(brainRoot);

    m.cacheStore(FAKE_SHA, {
      tarballSourcePath: tarballPath,
      extractedSourcePath: extractedDir,
      channel: "release",
      ref: "v7.0.0",
    });
    writeFileSync(m.cacheMetaPath(FAKE_SHA), "{ malformed");
    expect(m.findCached(FAKE_SHA)).toBe(null);
  });

  it("cacheEvict removes a single entry; cacheEvictAll wipes the cache root", async () => {
    const m = await import("../lib/cache.js");
    const { tarballPath, extractedDir } = stageSource(brainRoot);

    m.cacheStore(FAKE_SHA, {
      tarballSourcePath: tarballPath,
      extractedSourcePath: extractedDir,
      channel: "release",
      ref: "v7.0.0",
    });
    expect(m.findCached(FAKE_SHA)).not.toBeNull();
    m.cacheEvict(FAKE_SHA);
    expect(m.findCached(FAKE_SHA)).toBe(null);

    m.cacheStore(FAKE_SHA, {
      tarballSourcePath: tarballPath,
      extractedSourcePath: extractedDir,
      channel: "release",
      ref: "v7.0.0",
    });
    m.cacheEvictAll();
    expect(m.findCached(FAKE_SHA)).toBe(null);
  });

  it("cacheListShas returns only valid sha-named entries", async () => {
    const m = await import("../lib/cache.js");
    const dir = m.cacheEntryDir(FAKE_SHA);
    mkdirSync(dir, { recursive: true });
    // Add a bogus sibling to confirm filtering.
    mkdirSync(join(brainRoot, ".cache", "not-a-sha"), { recursive: true });
    const shas = m.cacheListShas();
    expect(shas).toContain(FAKE_SHA);
    expect(shas).not.toContain("not-a-sha");
  });
});
