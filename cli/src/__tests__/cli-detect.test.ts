/**
 * cli-detect.ts tests — M1.7.
 *
 * Mocks ONLY at the env-var boundary (`HOME`, `PATH`); the module
 * under test reads `process.env.PATH` directly and `os.homedir()`,
 * both of which we override per-case. No `vi.mock` of the module.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyBridgeOverride,
  detectInstalledCLIs,
  knownCLITargets,
} from "../lib/cli-detect.js";

let workDir: string;
let homeOverride: string;
let pathOverride: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "igris-clidetect-"));
  homeOverride = join(workDir, "home");
  pathOverride = join(workDir, "bin");
  mkdirSync(homeOverride, { recursive: true });
  mkdirSync(pathOverride, { recursive: true });
  envBackup.HOME = process.env.HOME;
  envBackup.PATH = process.env.PATH;
  process.env.HOME = homeOverride;
  process.env.PATH = pathOverride;
});

afterEach(() => {
  process.env.HOME = envBackup.HOME;
  process.env.PATH = envBackup.PATH;
  rmSync(workDir, { recursive: true, force: true });
});

function stagePathBinary(name: string): void {
  const file = join(pathOverride, name);
  writeFileSync(file, "#!/bin/sh\necho fake\n");
  chmodSync(file, 0o755);
}

function stageConfigDir(rel: string): void {
  mkdirSync(join(homeOverride, rel), { recursive: true });
}

describe("cli-detect — both signals required", () => {
  it("detects claude when both PATH binary AND ~/.claude exist", () => {
    stagePathBinary("claude");
    stageConfigDir(".claude");
    const r = detectInstalledCLIs();
    expect(r.detected.has("claude")).toBe(true);
    expect(r.detail.claude.onPath).toBe(true);
    expect(r.detail.claude.configDir).toBe(true);
  });

  it("does NOT detect claude when only PATH binary present (no ~/.claude)", () => {
    stagePathBinary("claude");
    const r = detectInstalledCLIs();
    expect(r.detected.has("claude")).toBe(false);
    expect(r.detail.claude.onPath).toBe(true);
    expect(r.detail.claude.configDir).toBe(false);
  });

  it("does NOT detect claude when only ~/.claude present (no PATH binary)", () => {
    stageConfigDir(".claude");
    const r = detectInstalledCLIs();
    expect(r.detected.has("claude")).toBe(false);
    expect(r.detail.claude.onPath).toBe(false);
    expect(r.detail.claude.configDir).toBe(true);
  });
});

describe("cli-detect — multi-CLI detection", () => {
  it("detects multiple CLIs when each has both signals", () => {
    stagePathBinary("claude");
    stageConfigDir(".claude");
    stagePathBinary("codex");
    stageConfigDir(".codex");
    const r = detectInstalledCLIs();
    expect(r.detected.has("claude")).toBe(true);
    expect(r.detected.has("codex")).toBe(true);
    expect(r.detected.has("gemini")).toBe(false);
    expect(r.detected.has("opencode")).toBe(false);
  });

  it("opencode uses the .config/opencode/ subpath (XDG-style) rather than ~/.opencode/", () => {
    stagePathBinary("opencode");
    stageConfigDir(".config/opencode");
    const r = detectInstalledCLIs();
    expect(r.detected.has("opencode")).toBe(true);
  });

  it("opencode is NOT detected when only the legacy ~/.opencode/ exists (we require .config/opencode/)", () => {
    stagePathBinary("opencode");
    stageConfigDir(".opencode");
    const r = detectInstalledCLIs();
    expect(r.detected.has("opencode")).toBe(false);
  });

  it("returns empty detection when nothing is installed", () => {
    const r = detectInstalledCLIs();
    expect(r.detected.size).toBe(0);
  });
});

describe("cli-detect — multi-dir PATH", () => {
  it("finds binary in any PATH directory, not just the first", () => {
    const altBin = join(workDir, "altbin");
    mkdirSync(altBin, { recursive: true });
    process.env.PATH = `${pathOverride}${delimiter}${altBin}`;
    const fileAlt = join(altBin, "gemini");
    writeFileSync(fileAlt, "#!/bin/sh\nexit 0\n");
    chmodSync(fileAlt, 0o755);
    stageConfigDir(".gemini");
    const r = detectInstalledCLIs();
    expect(r.detected.has("gemini")).toBe(true);
    expect(r.detail.gemini.pathHit).toBe(fileAlt);
  });
});

describe("cli-detect — applyBridgeOverride", () => {
  it("undefined override returns the auto-detected set verbatim", () => {
    const detected = new Set(["claude" as const, "codex" as const]);
    const out = applyBridgeOverride(detected, undefined);
    expect([...out].sort()).toEqual(["claude", "codex"]);
  });

  it("'none' returns empty set regardless of detection", () => {
    const detected = new Set(["claude" as const, "codex" as const]);
    expect(applyBridgeOverride(detected, "none").size).toBe(0);
  });

  it("'claude,codex' returns exactly those two", () => {
    const detected = new Set(["gemini" as const]);
    const out = applyBridgeOverride(detected, "claude,codex");
    expect([...out].sort()).toEqual(["claude", "codex"]);
  });

  it("rejects unknown target names with actionable error", () => {
    expect(() => applyBridgeOverride(new Set(), "vim")).toThrow(
      /unknown target/i,
    );
  });

  it("trims whitespace and ignores empty entries in the list", () => {
    const out = applyBridgeOverride(new Set(), "claude, , codex ");
    expect([...out].sort()).toEqual(["claude", "codex"]);
  });
});

describe("cli-detect — utility surface", () => {
  it("knownCLITargets returns all 4 catalog entries", () => {
    const known = knownCLITargets();
    expect(known.length).toBe(4);
    expect(known).toContain("claude");
    expect(known).toContain("codex");
    expect(known).toContain("gemini");
    expect(known).toContain("opencode");
  });
});
