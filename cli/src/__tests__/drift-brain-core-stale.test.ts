/**
 * brain-core-stale drift detector tests — M5.
 *
 * Hermetic. Mocks the GitHub API call via the `latestRefShaFn` test seam
 * so no network is hit. Real install-source.json on tmp fs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBrainCoreStale } from "../lib/drift/brain-core-stale.js";
import { writeInstallSource } from "../lib/install-source.js";

let brainRoot: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  brainRoot = mkdtempSync(join(tmpdir(), "igris-stale-"));
  mkdirSync(join(brainRoot, "core"), { recursive: true });
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  process.env.IGRIS_BRAIN_DIR = brainRoot;
});

afterEach(() => {
  rmSync(brainRoot, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
});

describe("brain-core-stale", () => {
  it("returns null when .install-source.json is absent", async () => {
    const r = await detectBrainCoreStale({
      latestRefShaFn: async () => "deadbeef",
    });
    expect(r).toBeNull();
  });

  it("returns null when recorded sha matches head sha", async () => {
    writeInstallSource({
      schema_version: 1,
      channel: "release",
      ref: "v7.0.0",
      fetched_at: new Date().toISOString(),
      content_sha256: "matching-sha-1234",
      source: "github",
      source_path: null,
    });
    const r = await detectBrainCoreStale({
      latestRefShaFn: async () => "matching-sha-1234",
    });
    expect(r).toBeNull();
  });

  it("returns a DriftRow when recorded sha differs from head sha", async () => {
    writeInstallSource({
      schema_version: 1,
      channel: "release",
      ref: "v7.0.0",
      fetched_at: new Date().toISOString(),
      content_sha256: "old-sha-aaaa",
      source: "github",
      source_path: null,
    });
    const r = await detectBrainCoreStale({
      latestRefShaFn: async () => "new-sha-bbbb",
    });
    expect(r).not.toBeNull();
    expect(r!.driftClass).toBe("brain-core-stale");
    expect(r!.slug).toBe("(brain)");
    expect(r!.recommendedFix).toContain("igris refresh");
    expect(r!.recommendedFix).toContain("v7.0.0");
  });

  it("returns null for from-source installs (channel check doesn't apply)", async () => {
    writeInstallSource({
      schema_version: 1,
      channel: "main",
      ref: "from-source",
      fetched_at: new Date().toISOString(),
      content_sha256: "from-source-12345",
      source: "from-source",
      source_path: "/contributor/repo",
    });
    // Even if the fetcher would say "different", from-source short-circuits.
    const r = await detectBrainCoreStale({
      latestRefShaFn: async () => "would-be-stale",
    });
    expect(r).toBeNull();
  });
});
