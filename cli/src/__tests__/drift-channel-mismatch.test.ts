/**
 * channel-mismatch drift detector tests — M5.
 *
 * Real tmp brain. Crafts installed_features.json with cli_version=99.0.0
 * and asserts detection.
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
import {
  compareSemver,
  detectChannelMismatch,
} from "../lib/drift/channel-mismatch.js";

let brainRoot: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(async () => {
  brainRoot = mkdtempSync(join(tmpdir(), "igris-channelmm-"));
  mkdirSync(join(brainRoot, "memory"), { recursive: true });
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  process.env.IGRIS_BRAIN_DIR = brainRoot;
  const reg = await import("../lib/registry.js");
  reg.closeDb();
});

afterEach(async () => {
  const reg = await import("../lib/registry.js");
  reg.closeDb();
  rmSync(brainRoot, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
});

function writeFeatures(slug: string, cliVersion: string): void {
  const dir = join(brainRoot, "projects", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "installed_features.json"),
    JSON.stringify({
      schema_version: 2,
      cli_version: cliVersion,
      brain_channel: "release",
      brain_ref: "v7.0.0",
      hooks_version: null,
      agents_version: null,
      skills_version: null,
      rules_version: null,
      installed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  );
}

describe("channel-mismatch", () => {
  it("flags a project whose cli_version is newer than current CLI", async () => {
    const reg = await import("../lib/registry.js");
    reg.upsertProject({
      slug: "ahead-proj",
      name: "ahead-proj",
      path: "/tmp/some-proj",
      tech_stack: "",
      igris_version: "99.0.0",
    });
    writeFeatures("ahead-proj", "99.0.0");

    const drift = detectChannelMismatch({ currentCliVersionFn: () => "7.0.0" });
    expect(drift.length).toBe(1);
    expect(drift[0].slug).toBe("ahead-proj");
    expect(drift[0].driftClass).toBe("channel-mismatch");
    expect(drift[0].recommendedFix).toContain("99.0.0");
    expect(drift[0].recommendedFix).toContain("7.0.0");
  });

  it("does NOT flag a project whose cli_version equals current CLI", async () => {
    const reg = await import("../lib/registry.js");
    reg.upsertProject({
      slug: "even-proj",
      name: "even-proj",
      path: "/tmp/even-proj",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    writeFeatures("even-proj", "7.0.0");

    const drift = detectChannelMismatch({ currentCliVersionFn: () => "7.0.0" });
    expect(drift.length).toBe(0);
  });

  it("does NOT flag projects whose cli_version is older (those are upgrade candidates, not mismatches)", async () => {
    const reg = await import("../lib/registry.js");
    reg.upsertProject({
      slug: "old-proj",
      name: "old-proj",
      path: "/tmp/old-proj",
      tech_stack: "",
      igris_version: "6.0.0",
    });
    writeFeatures("old-proj", "6.0.0");

    const drift = detectChannelMismatch({ currentCliVersionFn: () => "7.0.0" });
    expect(drift.length).toBe(0);
  });
});

describe("compareSemver helper", () => {
  it("orders 7.0.0 < 99.0.0", () => {
    expect(compareSemver("7.0.0", "99.0.0")).toBe(-1);
  });
  it("orders 7.1.0 > 7.0.99", () => {
    expect(compareSemver("7.1.0", "7.0.99")).toBe(1);
  });
  it("treats 7.0.0 == v7.0.0", () => {
    expect(compareSemver("7.0.0", "v7.0.0")).toBe(0);
  });
});
