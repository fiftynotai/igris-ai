/**
 * init-config.test.ts — Phase 2 (M2, Risk A3).
 *
 * Real fs against tmp dirs. No mocks (per L-159).
 *
 * Cases (TD-102 contract from `igris_install.sh:166-188`):
 *   1. Missing config.json → no-op (config_missing outcome).
 *   2. Subconscious section absent → key set to false (default_set).
 *   3. Subconscious.enabled already false → preserved verbatim.
 *   4. Subconscious.enabled re-enabled by operator (true) → preserved
 *      (CRITICAL: never silently revert operator overrides).
 *   5. Subconscious section present but `enabled` absent → set to false.
 *   6. Other config keys preserved across the write.
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

let tmpBrain: string;

function writeConfig(content: Record<string, unknown>): void {
  writeFileSync(
    join(tmpBrain, "config.json"),
    JSON.stringify(content, null, 2) + "\n",
  );
}

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-init-config-"));
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
});

describe("init-config — applySubconsciousDefault", () => {
  it("config.json absent → config_missing (no-op)", async () => {
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("config_missing");
    // No file was created.
    expect(existsSync(join(tmpBrain, "config.json"))).toBe(false);
  });

  it("subconscious absent → default_set, enabled becomes false", async () => {
    writeConfig({});
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("default_set");

    const cfg = JSON.parse(
      readFileSync(join(tmpBrain, "config.json"), "utf-8"),
    ) as { subconscious?: { enabled?: boolean } };
    expect(cfg.subconscious?.enabled).toBe(false);
  });

  it("respects existing subconscious.enabled=true (operator override)", async () => {
    writeConfig({ subconscious: { enabled: true, redesign_pending: true } });
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("preserved");

    const cfg = JSON.parse(
      readFileSync(join(tmpBrain, "config.json"), "utf-8"),
    ) as { subconscious?: { enabled?: boolean; redesign_pending?: boolean } };
    expect(cfg.subconscious?.enabled).toBe(true);
    expect(cfg.subconscious?.redesign_pending).toBe(true);
  });

  it("respects existing subconscious.enabled=false (no-op write)", async () => {
    writeConfig({ subconscious: { enabled: false } });
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("preserved");
  });

  it("subconscious section present without enabled → enabled set to false", async () => {
    writeConfig({ subconscious: { other_key: "kept" } });
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("default_set");

    const cfg = JSON.parse(
      readFileSync(join(tmpBrain, "config.json"), "utf-8"),
    ) as { subconscious?: { enabled?: boolean; other_key?: string } };
    expect(cfg.subconscious?.enabled).toBe(false);
    expect(cfg.subconscious?.other_key).toBe("kept");
  });

  it("preserves other top-level config keys across the write", async () => {
    writeConfig({
      remote_brain: { url: "https://example.com", api_key: "abc" },
      features: { mcp_server: true },
    });
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("default_set");

    const cfg = JSON.parse(
      readFileSync(join(tmpBrain, "config.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(cfg.remote_brain).toEqual({
      url: "https://example.com",
      api_key: "abc",
    });
    expect(cfg.features).toEqual({ mcp_server: true });
    expect(cfg.subconscious).toEqual({ enabled: false });
  });

  it("malformed config.json → config_malformed (no-op)", async () => {
    writeFileSync(join(tmpBrain, "config.json"), "{ this is not json");
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("config_malformed");
    // File untouched.
    expect(readFileSync(join(tmpBrain, "config.json"), "utf-8")).toBe(
      "{ this is not json",
    );
  });
});
