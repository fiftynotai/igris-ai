/**
 * install-source.ts tests — M1.3.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let brainRoot: string;

beforeEach(() => {
  brainRoot = mkdtempSync(join(tmpdir(), "igris-install-source-"));
  process.env.IGRIS_BRAIN_DIR = brainRoot;
});

afterEach(() => {
  rmSync(brainRoot, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
});

describe("install-source — read/write", () => {
  it("read returns null when file is absent", async () => {
    const m = await import("../lib/install-source.js");
    expect(m.readInstallSource()).toBe(null);
  });

  // TD-301 (2026-09-08): the pinned version moved 1 -> 2 because
  // migrateForwardOnly now lifts every record to the current schema on read.
  // The pin moves with this dated reason (test_standards convention 6).
  it("write+read round-trip preserves all fields", async () => {
    const m = await import("../lib/install-source.js");
    const rec = {
      schema_version: 2,
      channel: "release" as const,
      ref: "v7.0.0",
      fetched_at: "2026-05-07T00:00:00Z",
      content_sha256: "abc123",
      source: "github" as const,
      source_path: null,
    };
    m.writeInstallSource(rec);
    expect(existsSync(join(brainRoot, ".install-source.json"))).toBe(true);
    expect(m.readInstallSource()).toEqual(rec);
  });

  it("write creates parent dir if missing", async () => {
    rmSync(brainRoot, { recursive: true, force: true });
    expect(existsSync(brainRoot)).toBe(false);
    const m = await import("../lib/install-source.js");
    m.writeInstallSource({
      schema_version: 1,
      channel: "main",
      ref: "main",
      fetched_at: "2026-05-07T00:00:00Z",
      content_sha256: "deadbeef",
      source: "github",
      source_path: null,
    });
    expect(existsSync(join(brainRoot, ".install-source.json"))).toBe(true);
  });

  it("read errors on malformed JSON with actionable message", async () => {
    const path = join(brainRoot, ".install-source.json");
    writeFileSync(path, "{not json");
    const m = await import("../lib/install-source.js");
    expect(() => m.readInstallSource()).toThrow(/malformed/i);
  });

  // TD-301 (2026-09-08): terminal version moved 1 -> 2; a v0 record is lifted
  // through BOTH steps in one read (dated pin move).
  it("migrates v0 (missing schema_version) to the current schema with sensible defaults", async () => {
    const path = join(brainRoot, ".install-source.json");
    writeFileSync(
      path,
      JSON.stringify({
        channel: "main",
        // intentionally missing schema_version, fetched_at, etc.
      }) + "\n",
    );
    const m = await import("../lib/install-source.js");
    const out = m.readInstallSource();
    expect(out).not.toBeNull();
    expect(out!.schema_version).toBe(2);
    expect(out!.ref_commit_sha).toBeUndefined();
    expect(out!.channel).toBe("main");
    expect(out!.source).toBe("github");
    expect(out!.source_path).toBe(null);
    expect(typeof out!.fetched_at).toBe("string");
  });

  it("write produces newline-terminated JSON", async () => {
    const m = await import("../lib/install-source.js");
    m.writeInstallSource({
      schema_version: 1,
      channel: "tag",
      ref: "v6.0.0",
      fetched_at: "2026-05-07T00:00:00Z",
      content_sha256: "x",
      source: "github",
      source_path: null,
    });
    const content = readFileSync(
      join(brainRoot, ".install-source.json"),
      "utf-8",
    );
    expect(content.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TD-301 (2026-09-08) — schema v2 and the optional `ref_commit_sha` writer.
//
// U-10 pins that the forward-only migration to v2 invents NO value: a v1
// record has no recorded ref commit, and the detector treats ABSENCE as
// "not stale", never as "stale".
// U-11/U-12 pin `recordRefCommitSha`'s two contracts: it is not called at all
// for an immutable channel, and it swallows every fetch error (an install
// must never fail because a diagnostic field could not be fetched).
// ---------------------------------------------------------------------------
describe("install-source — TD-301 schema v2 + ref_commit_sha", () => {
  it("U-10: migrateForwardOnly lifts a v1 record to v2 without inventing ref_commit_sha", async () => {
    const m = await import("../lib/install-source.js");
    const out = m.migrateForwardOnly({
      schema_version: 1,
      channel: "main",
      ref: "main",
      fetched_at: "2026-09-08T00:00:00Z",
      content_sha256:
        "d1aa7cae3f92b6045e8c17da29bf60e34c5178ab90de2f4361a7c8b5e0d93f26",
      source: "github",
      source_path: null,
    });
    expect(out.schema_version).toBe(2);
    expect(out.ref_commit_sha).toBeUndefined();
    expect("ref_commit_sha" in out).toBe(false);
    expect(m.__testing__.CURRENT_SCHEMA_VERSION).toBe(2);
  });

  it("U-11: recordRefCommitSha returns undefined for an immutable channel, without fetching", async () => {
    const m = await import("../lib/install-source.js");
    let calls = 0;
    const out = await m.recordRefCommitSha("release", "v7.3.1", "github", {
      fetchFn: async () => {
        calls += 1;
        return "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
      },
    });
    expect(out).toBeUndefined();
    expect(calls).toBe(0);
    const outTag = await m.recordRefCommitSha("tag", "v7.0.0", "github", {
      fetchFn: async () => {
        calls += 1;
        return "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
      },
    });
    expect(outTag).toBeUndefined();
    expect(calls).toBe(0);
    // ...and never for a non-github source, whatever the channel.
    const outSrc = await m.recordRefCommitSha("main", "main", "from-source", {
      fetchFn: async () => {
        calls += 1;
        return "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
      },
    });
    expect(outSrc).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("U-12: recordRefCommitSha swallows a fetch error, and returns the sha on success", async () => {
    const m = await import("../lib/install-source.js");
    let calls = 0;
    const failed = await m.recordRefCommitSha("main", "main", "github", {
      fetchFn: async () => {
        calls += 1;
        throw new Error("GitHub API unreachable (ECONNREFUSED).");
      },
    });
    expect(failed).toBeUndefined();
    // The armed-guard assertion: the seam FIRED, so the undefined above is
    // the catch arm and not an early return.
    expect(calls).toBe(1);

    const ok = await m.recordRefCommitSha("branch", "develop", "github", {
      fetchFn: async (refPath: string) => {
        calls += 1;
        expect(refPath).toBe("develop");
        return "b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f80";
      },
    });
    expect(ok).toBe("b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f80");
    expect(calls).toBe(2);
  });
});
