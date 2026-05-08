/**
 * bridge-missing drift detector tests — M5.
 *
 * Stubs detection via the detectFn seam (the real cli-detect.ts is
 * env-driven and tested elsewhere). Real tmp config.json.
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
import { detectBridgeMissing } from "../lib/drift/bridge-missing.js";
import type { CLITarget } from "../types.js";

let brainRoot: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  brainRoot = mkdtempSync(join(tmpdir(), "igris-bridge-"));
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  process.env.IGRIS_BRAIN_DIR = brainRoot;
});

afterEach(() => {
  rmSync(brainRoot, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
});

function writeConfig(cliTargets: Record<string, unknown> | null): void {
  writeFileSync(
    join(brainRoot, "config.json"),
    JSON.stringify({
      version: "7.0.0",
      cli_targets: cliTargets,
    }),
  );
}

describe("bridge-missing", () => {
  it("flags Codex on PATH when cli_targets lacks codex entry", () => {
    writeConfig({ claude: { hooks: {} } });
    const drift = detectBridgeMissing({
      detectFn: () => ({
        detected: new Set<CLITarget>(["claude", "codex"]),
      }),
    });
    expect(drift.length).toBe(1);
    expect(drift[0].driftClass).toBe("bridge-missing");
    expect(drift[0].path).toBe("codex");
    expect(drift[0].recommendedFix).toContain("codex");
  });

  it("flags every detected CLI when cli_targets is null but config exists", () => {
    writeConfig(null);
    const drift = detectBridgeMissing({
      detectFn: () => ({
        detected: new Set<CLITarget>(["claude", "gemini"]),
      }),
    });
    expect(drift.length).toBe(2);
    expect(drift.map((d) => d.path).sort()).toEqual(["claude", "gemini"]);
  });

  it("does NOT flag when every detected CLI has a bridge entry", () => {
    writeConfig({
      claude: { hooks: {} },
      codex: { hooks: {} },
    });
    const drift = detectBridgeMissing({
      detectFn: () => ({
        detected: new Set<CLITarget>(["claude", "codex"]),
      }),
    });
    expect(drift.length).toBe(0);
  });

  it("respects --cli-bridge=none opt-out (cli_targets={} ≠ null)", () => {
    writeConfig({});
    const drift = detectBridgeMissing({
      detectFn: () => ({
        detected: new Set<CLITarget>(["claude", "codex"]),
      }),
    });
    expect(drift.length).toBe(0);
  });

  it("returns empty array when no CLIs are detected", () => {
    writeConfig({ claude: { hooks: {} } });
    const drift = detectBridgeMissing({
      detectFn: () => ({ detected: new Set<CLITarget>() }),
    });
    expect(drift.length).toBe(0);
  });

  it("returns empty array when config.json does not exist", () => {
    // No writeConfig call.
    const drift = detectBridgeMissing({
      detectFn: () => ({
        detected: new Set<CLITarget>(["claude"]),
      }),
    });
    expect(drift.length).toBe(0);
  });
});
