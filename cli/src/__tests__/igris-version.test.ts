/**
 * igris-version.test.ts — Phase 2 (M2.5).
 *
 * Real fs against tmp dirs. No mocks (per L-159). Three cases:
 *
 *   1. Fresh write creates .igris_version with all expected fields.
 *   2. Re-write preserves installed_at, bumps last_updated.
 *   3. Missing parent dir handled (mkdir -p semantics).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpBrain: string;
let tmpProject: string;

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-version-brain-"));
  tmpProject = mkdtempSync(join(tmpdir(), "igris-cli-version-proj-"));
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
  rmSync(tmpProject, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
});

describe("igris-version — write/round-trip", () => {
  it("fresh write creates .igris_version with expected fields", async () => {
    const m = await import("../lib/igris-version.js");
    const target = m.writeIgrisVersion(tmpProject, "7.0.0");
    expect(target).toBe(join(tmpProject, ".igris_version"));
    expect(existsSync(target)).toBe(true);

    const data = JSON.parse(readFileSync(target, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(data.igris_ai_version).toBe("7.0.0");
    expect(data.install_mode).toBe("global");
    expect(data.brain_path).toBe(tmpBrain);
    expect(typeof data.installed_at).toBe("string");
    expect(typeof data.last_updated).toBe("string");
    // Trailing newline for clean diff/grep.
    expect(readFileSync(target, "utf-8").endsWith("\n")).toBe(true);
  });

  it("re-write preserves installed_at, bumps last_updated", async () => {
    const m = await import("../lib/igris-version.js");
    const target = m.writeIgrisVersion(tmpProject, "7.0.0");
    const initial = JSON.parse(readFileSync(target, "utf-8")) as {
      installed_at: string;
      last_updated: string;
    };

    // Wait a millisecond so the clock advances at least 1ms.
    await new Promise((res) => setTimeout(res, 5));

    m.writeIgrisVersion(tmpProject, "7.0.1");
    const updated = JSON.parse(readFileSync(target, "utf-8")) as {
      igris_ai_version: string;
      installed_at: string;
      last_updated: string;
    };

    expect(updated.installed_at).toBe(initial.installed_at);
    expect(updated.last_updated).not.toBe(initial.last_updated);
    expect(updated.igris_ai_version).toBe("7.0.1");
  });

  it("missing parent dir is created automatically", async () => {
    const m = await import("../lib/igris-version.js");
    const deep = join(tmpProject, "deeply", "nested");
    expect(existsSync(deep)).toBe(false);

    const target = m.writeIgrisVersion(deep, "7.0.0");
    expect(existsSync(target)).toBe(true);
    const data = JSON.parse(readFileSync(target, "utf-8")) as {
      igris_ai_version: string;
    };
    expect(data.igris_ai_version).toBe("7.0.0");
  });
});
