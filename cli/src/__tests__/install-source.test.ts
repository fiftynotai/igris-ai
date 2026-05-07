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

  it("write+read round-trip preserves all fields", async () => {
    const m = await import("../lib/install-source.js");
    const rec = {
      schema_version: 1,
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

  it("migrates v0 (missing schema_version) to v1 with sensible defaults", async () => {
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
    expect(out!.schema_version).toBe(1);
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
