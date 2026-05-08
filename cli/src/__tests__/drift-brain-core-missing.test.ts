/**
 * brain-core-missing drift detector tests — M5.
 *
 * Real tmp fs — no mocks. Asserts detection when core/ is missing,
 * empty, or lacks the canonical hooks file.
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
import { detectBrainCoreMissing } from "../lib/drift/brain-core-missing.js";

let brainRoot: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  brainRoot = mkdtempSync(join(tmpdir(), "igris-missing-"));
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  process.env.IGRIS_BRAIN_DIR = brainRoot;
});

afterEach(() => {
  rmSync(brainRoot, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
});

describe("brain-core-missing", () => {
  it("flags when ~/.igris/core/ does not exist", () => {
    // brainRoot exists but core/ doesn't.
    const r = detectBrainCoreMissing();
    expect(r).not.toBeNull();
    expect(r!.driftClass).toBe("brain-core-missing");
    expect(r!.slug).toBe("(brain)");
    expect(r!.path).toContain("/core");
  });

  it("flags when ~/.igris/core/ exists but is empty", () => {
    mkdirSync(join(brainRoot, "core"), { recursive: true });
    const r = detectBrainCoreMissing();
    expect(r).not.toBeNull();
    expect(r!.driftClass).toBe("brain-core-missing");
    expect(r!.recommendedFix).toContain("empty");
  });

  it("returns null when core/ has canonical hooks file (healthy)", () => {
    mkdirSync(join(brainRoot, "core", "hooks"), { recursive: true });
    writeFileSync(
      join(brainRoot, "core", "hooks", "canonical-settings.json"),
      JSON.stringify({ hooks: {} }),
    );
    const r = detectBrainCoreMissing();
    expect(r).toBeNull();
  });
});
