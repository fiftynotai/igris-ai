/**
 * init-config.test.ts — FR-191 cognition guardrails (nested `cognition.*`).
 *
 * Real fs against tmp dirs. No mocks (per L-159).
 *
 * Cases (TD-102 contract, re-pointed to the `cognition.<instance>.enabled`
 * nested namespace under FR-191):
 *   1. Missing config.json → no-op (config_missing outcome).
 *   2. cognition.<instance> section absent → key set to false (default_set).
 *   3. cognition.<instance>.enabled already false → preserved verbatim.
 *   4. cognition.<instance>.enabled re-enabled by operator (true) → preserved
 *      (CRITICAL: never silently revert operator overrides).
 *   5. cognition.<instance> present but `enabled` absent → set to false.
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

function readCfg(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(tmpBrain, "config.json"), "utf-8"),
  ) as Record<string, unknown>;
}

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-init-config-"));
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
});

describe("init-config — applySubconsciousDefault (nested cognition.subconscious)", () => {
  it("config.json absent → config_missing (no-op)", async () => {
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("config_missing");
    expect(existsSync(join(tmpBrain, "config.json"))).toBe(false);
  });

  it("cognition.subconscious absent → default_set, enabled becomes false", async () => {
    writeConfig({});
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("default_set");

    const cfg = readCfg() as {
      cognition?: { subconscious?: { enabled?: boolean } };
    };
    expect(cfg.cognition?.subconscious?.enabled).toBe(false);
  });

  it("respects existing cognition.subconscious.enabled=true (operator override)", async () => {
    writeConfig({
      cognition: { subconscious: { enabled: true, redesign_pending: true } },
    });
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("preserved");

    const cfg = readCfg() as {
      cognition?: {
        subconscious?: { enabled?: boolean; redesign_pending?: boolean };
      };
    };
    expect(cfg.cognition?.subconscious?.enabled).toBe(true);
    expect(cfg.cognition?.subconscious?.redesign_pending).toBe(true);
  });

  it("respects existing cognition.subconscious.enabled=false (no-op write)", async () => {
    writeConfig({ cognition: { subconscious: { enabled: false } } });
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("preserved");
  });

  it("cognition.subconscious present without enabled → enabled set to false", async () => {
    writeConfig({ cognition: { subconscious: { other_key: "kept" } } });
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("default_set");

    const cfg = readCfg() as {
      cognition?: { subconscious?: { enabled?: boolean; other_key?: string } };
    };
    expect(cfg.cognition?.subconscious?.enabled).toBe(false);
    expect(cfg.cognition?.subconscious?.other_key).toBe("kept");
  });

  it("preserves other top-level config keys + sibling cognition instances across the write", async () => {
    writeConfig({
      remote_brain: { url: "https://example.com", api_key: "abc" },
      features: { mcp_server: true },
      cognition: { perception: { enabled: false } },
    });
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("default_set");

    const cfg = readCfg() as Record<string, unknown> & {
      cognition?: {
        perception?: { enabled?: boolean };
        subconscious?: { enabled?: boolean };
      };
    };
    expect(cfg.remote_brain).toEqual({
      url: "https://example.com",
      api_key: "abc",
    });
    expect(cfg.features).toEqual({ mcp_server: true });
    // Sibling cognition instance untouched.
    expect(cfg.cognition?.perception?.enabled).toBe(false);
    expect(cfg.cognition?.subconscious).toEqual({ enabled: false });
  });

  it("malformed config.json → config_malformed (no-op)", async () => {
    writeFileSync(join(tmpBrain, "config.json"), "{ this is not json");
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("config_malformed");
    expect(readFileSync(join(tmpBrain, "config.json"), "utf-8")).toBe(
      "{ this is not json",
    );
  });

  it("does NOT migrate a legacy top-level subconscious block (FR-191 — no shim)", async () => {
    // A config with ONLY the legacy top-level block is treated as "instance
    // absent" → the nested default is set; the legacy block is left in place
    // untouched (no shim moves it). The resolver no longer reads the legacy
    // key, so it resolves OFF anyway.
    writeConfig({ subconscious: { enabled: true } });
    const m = await import("../lib/init-config.js");
    expect(m.applySubconsciousDefault()).toBe("default_set");

    const cfg = readCfg() as {
      subconscious?: { enabled?: boolean };
      cognition?: { subconscious?: { enabled?: boolean } };
    };
    expect(cfg.cognition?.subconscious?.enabled).toBe(false);
    // Legacy block preserved verbatim (not migrated, not deleted).
    expect(cfg.subconscious?.enabled).toBe(true);
  });
});

describe("init-config — applyPerceptionDefault (nested cognition.perception)", () => {
  it("config.json absent → config_missing (no-op)", async () => {
    const m = await import("../lib/init-config.js");
    expect(m.applyPerceptionDefault()).toBe("config_missing");
    expect(existsSync(join(tmpBrain, "config.json"))).toBe(false);
  });

  it("cognition.perception absent → default_set, enabled becomes false", async () => {
    writeConfig({});
    const m = await import("../lib/init-config.js");
    expect(m.applyPerceptionDefault()).toBe("default_set");

    const cfg = readCfg() as {
      cognition?: { perception?: { enabled?: boolean } };
    };
    expect(cfg.cognition?.perception?.enabled).toBe(false);
  });

  it("respects existing cognition.perception.enabled=true (operator override)", async () => {
    writeConfig({ cognition: { perception: { enabled: true } } });
    const m = await import("../lib/init-config.js");
    expect(m.applyPerceptionDefault()).toBe("preserved");

    const cfg = readCfg() as {
      cognition?: { perception?: { enabled?: boolean } };
    };
    expect(cfg.cognition?.perception?.enabled).toBe(true);
  });

  it("respects existing cognition.perception.enabled=false (no-op write)", async () => {
    writeConfig({ cognition: { perception: { enabled: false } } });
    const m = await import("../lib/init-config.js");
    expect(m.applyPerceptionDefault()).toBe("preserved");
  });

  it("cognition.perception present without enabled → enabled set to false", async () => {
    writeConfig({ cognition: { perception: { other_key: "kept" } } });
    const m = await import("../lib/init-config.js");
    expect(m.applyPerceptionDefault()).toBe("default_set");

    const cfg = readCfg() as {
      cognition?: { perception?: { enabled?: boolean; other_key?: string } };
    };
    expect(cfg.cognition?.perception?.enabled).toBe(false);
    expect(cfg.cognition?.perception?.other_key).toBe("kept");
  });

  it("preserves sibling cognition.subconscious across the perception write", async () => {
    writeConfig({ cognition: { subconscious: { enabled: false } } });
    const m = await import("../lib/init-config.js");
    expect(m.applyPerceptionDefault()).toBe("default_set");

    const cfg = readCfg() as {
      cognition?: {
        perception?: { enabled?: boolean };
        subconscious?: { enabled?: boolean };
      };
    };
    expect(cfg.cognition?.perception?.enabled).toBe(false);
    expect(cfg.cognition?.subconscious?.enabled).toBe(false);
  });

  it("malformed config.json → config_malformed (no-op)", async () => {
    writeFileSync(join(tmpBrain, "config.json"), "{ this is not json");
    const m = await import("../lib/init-config.js");
    expect(m.applyPerceptionDefault()).toBe("config_malformed");
  });
});

describe("init-config — applySynapseDefault (nested cognition.synapse, FR-211)", () => {
  it("config.json absent → config_missing (no-op)", async () => {
    const m = await import("../lib/init-config.js");
    expect(m.applySynapseDefault()).toBe("config_missing");
    expect(existsSync(join(tmpBrain, "config.json"))).toBe(false);
  });

  it("cognition.synapse absent → default_set, enabled becomes false", async () => {
    writeConfig({});
    const m = await import("../lib/init-config.js");
    expect(m.applySynapseDefault()).toBe("default_set");

    const cfg = readCfg() as { cognition?: { synapse?: { enabled?: boolean } } };
    expect(cfg.cognition?.synapse?.enabled).toBe(false);
  });

  it("respects existing cognition.synapse.enabled=true (operator override)", async () => {
    writeConfig({ cognition: { synapse: { enabled: true } } });
    const m = await import("../lib/init-config.js");
    expect(m.applySynapseDefault()).toBe("preserved");

    const cfg = readCfg() as { cognition?: { synapse?: { enabled?: boolean } } };
    expect(cfg.cognition?.synapse?.enabled).toBe(true);
  });

  it("cognition.synapse present without enabled → enabled set to false, siblings kept", async () => {
    writeConfig({ cognition: { synapse: { cosine_floor: 0.9 } } });
    const m = await import("../lib/init-config.js");
    expect(m.applySynapseDefault()).toBe("default_set");

    const cfg = readCfg() as {
      cognition?: { synapse?: { enabled?: boolean; cosine_floor?: number } };
    };
    expect(cfg.cognition?.synapse?.enabled).toBe(false);
    expect(cfg.cognition?.synapse?.cosine_floor).toBe(0.9);
  });

  it("preserves sibling cognition.subconscious across the synapse write", async () => {
    writeConfig({ cognition: { subconscious: { enabled: false } } });
    const m = await import("../lib/init-config.js");
    expect(m.applySynapseDefault()).toBe("default_set");

    const cfg = readCfg() as {
      cognition?: {
        synapse?: { enabled?: boolean };
        subconscious?: { enabled?: boolean };
      };
    };
    expect(cfg.cognition?.synapse?.enabled).toBe(false);
    expect(cfg.cognition?.subconscious?.enabled).toBe(false);
  });

  it("malformed config.json → config_malformed (no-op)", async () => {
    writeFileSync(join(tmpBrain, "config.json"), "{ this is not json");
    const m = await import("../lib/init-config.js");
    expect(m.applySynapseDefault()).toBe("config_malformed");
  });
});
