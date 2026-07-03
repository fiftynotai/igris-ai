/**
 * installed-features tests — Phase 4.
 *
 * Schema migration unit tests + hash determinism + round-trip.
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

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-features-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
});

describe("installed-features — read/write/migrate", () => {
  it("read returns null on missing file", async () => {
    const m = await import("../lib/installed-features.js");
    expect(m.readInstalledFeatures("not-a-real-slug")).toBe(null);
  });

  it("write+read round-trip preserves all fields (v2 schema)", async () => {
    const m = await import("../lib/installed-features.js");
    const features = {
      schema_version: 2,
      cli_version: "7.0.0",
      brain_channel: "release" as const,
      brain_ref: "v7.0.0",
      hooks_version: "abc",
      agents_version: "def",
      skills_version: "ghi",
      rules_version: "jkl",
      installed_at: "2026-05-06T00:00:00Z",
      updated_at: "2026-05-06T00:00:00Z",
    };
    m.writeInstalledFeatures("demo", features);
    const read = m.readInstalledFeatures("demo");
    expect(read).toEqual(features);
  });

  it("migrate from schema_version 0 (no field) to 2 — adds defaults + null fields", async () => {
    const m = await import("../lib/installed-features.js");
    const slug = "legacy-demo";
    const target = join(tmpRoot, "projects", slug, "installed_features.json");
    mkdirSync(join(tmpRoot, "projects", slug), { recursive: true });
    // Write a v0-shape file (no schema_version field, partial keys).
    writeFileSync(
      target,
      JSON.stringify({
        installed_at: "2026-04-01T00:00:00Z",
      }) + "\n",
    );
    const out = m.readInstalledFeatures(slug);
    expect(out).not.toBeNull();
    expect(out!.schema_version).toBe(2);
    expect(out!.cli_version).toBe("7.0.0");
    expect(out!.brain_channel).toBe(null);
    expect(out!.brain_ref).toBe(null);
    expect(out!.hooks_version).toBe(null);
    expect(out!.agents_version).toBe(null);
    expect(out!.skills_version).toBe(null);
    expect(out!.rules_version).toBe(null);
    expect(out!.installed_at).toBe("2026-04-01T00:00:00Z");
    expect(typeof out!.updated_at).toBe("string");
  });

  it("migrate from schema_version 1 to 2 — adds brain_channel/brain_ref as null, preserves other fields", async () => {
    const m = await import("../lib/installed-features.js");
    const slug = "v1-demo";
    const target = join(tmpRoot, "projects", slug, "installed_features.json");
    mkdirSync(join(tmpRoot, "projects", slug), { recursive: true });
    // Write a v1-shape file (no brain_channel/brain_ref).
    writeFileSync(
      target,
      JSON.stringify({
        schema_version: 1,
        cli_version: "7.0.0-alpha",
        hooks_version: "deadbeef",
        agents_version: "feedface",
        skills_version: null,
        rules_version: "cafebabe",
        installed_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-15T00:00:00Z",
      }) + "\n",
    );
    const out = m.readInstalledFeatures(slug);
    expect(out).not.toBeNull();
    // Schema bumped.
    expect(out!.schema_version).toBe(2);
    // New fields default to null.
    expect(out!.brain_channel).toBe(null);
    expect(out!.brain_ref).toBe(null);
    // Existing fields preserved verbatim.
    expect(out!.cli_version).toBe("7.0.0-alpha");
    expect(out!.hooks_version).toBe("deadbeef");
    expect(out!.agents_version).toBe("feedface");
    expect(out!.skills_version).toBe(null);
    expect(out!.rules_version).toBe("cafebabe");
    expect(out!.installed_at).toBe("2026-04-01T00:00:00Z");
    expect(out!.updated_at).toBe("2026-04-15T00:00:00Z");
  });

  it("hash is stable across same canonical input (deterministic)", async () => {
    const m = await import("../lib/installed-features.js");
    // Stage a fake brain runtime: canonical hooks file + agents manifest + skills.
    const hooksDir = join(tmpRoot, "core", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, "canonical-settings.json"),
      JSON.stringify({ hooks: { SessionEnd: [] } }) + "\n",
    );
    const agentsDir = join(tmpRoot, "core", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "manifest.yaml"), "agents: []\n");
    const skillsDir = join(tmpRoot, "core", "skills", "demo");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), "skill\n");

    // Re-import to bust the canonical-hooks cache.
    delete (globalThis as Record<string, unknown>)._igris_canonical_cache;
    const ch = await import("../lib/canonical-hooks.js");
    ch.clearCache();

    const a = m.computeFeatureHashes({ includeHooks: true });
    const b = m.computeFeatureHashes({ includeHooks: true });
    expect(a).toEqual(b);
    expect(typeof a.hooks_version).toBe("string");
    expect(typeof a.agents_version).toBe("string");
    expect(typeof a.skills_version).toBe("string");
    // FR-187: the universal rule retired; rules_version is always null now.
    expect(a.rules_version).toBe(null);
  });

  it("hash is null for each missing input", async () => {
    const m = await import("../lib/installed-features.js");
    const a = m.computeFeatureHashes({ includeHooks: true });
    expect(a.hooks_version).toBe(null);
    expect(a.agents_version).toBe(null);
    // FR-187: rules_version is a deprecated always-null vestige.
    expect(a.rules_version).toBe(null);
    expect(a.skills_version).toBe(null);
  });

  it("file is created with parent dirs (mkdir -p)", async () => {
    const m = await import("../lib/installed-features.js");
    const slug = "deep-slug";
    const target = join(tmpRoot, "projects", slug, "installed_features.json");
    expect(existsSync(target)).toBe(false);
    m.writeInstalledFeatures(slug, {
      schema_version: 2,
      cli_version: "7.0.0",
      brain_channel: null,
      brain_ref: null,
      hooks_version: null,
      agents_version: null,
      skills_version: null,
      rules_version: null,
      installed_at: "2026-05-06T00:00:00Z",
      updated_at: "2026-05-06T00:00:00Z",
    });
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });
});
