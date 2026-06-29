/**
 * TD-191: dedicated tests for the L-517 typed-subfolder layout helpers in
 * `cli/src/lib/paths.ts`. Covers:
 *   - `loadoutAgentDirPath(name)` resolves under `<brainDir>/loadout/agents/<name>`
 *   - `loadoutSkillDirPath(name)` resolves under `<brainDir>/loadout/skills/<name>`
 *   - Both honor `IGRIS_BRAIN_DIR` (the env seam every other loadout helper
 *     uses; tests sandbox the brain by setting that env var).
 *   - Symmetric shape: both produce `<base>/<name>` differing only in the
 *     type prefix.
 *
 * L-159 / L-173: NO `vi.mock` here — we exercise the real helpers under a
 * tmp `IGRIS_BRAIN_DIR`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadoutAgentDirPath,
  loadoutDirPath,
  loadoutOriginsPath,
  loadoutOverlayPath,
  loadoutSkillDirPath,
  secretsEnvPath,
} from "../lib/paths.js";

let sandbox: string;
const prevBrain = process.env.IGRIS_BRAIN_DIR;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-paths-td191-"));
  process.env.IGRIS_BRAIN_DIR = sandbox;
});

afterEach(() => {
  if (prevBrain === undefined) {
    delete process.env.IGRIS_BRAIN_DIR;
  } else {
    process.env.IGRIS_BRAIN_DIR = prevBrain;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe("TD-191 L-517 path helpers", () => {
  it("loadoutAgentDirPath('foo') resolves under <brain>/loadout/agents/foo", () => {
    const p = loadoutAgentDirPath("foo");
    expect(p).toBe(join(sandbox, "loadout", "agents", "foo"));
  });

  it("loadoutSkillDirPath('bar') resolves under <brain>/loadout/skills/bar", () => {
    const p = loadoutSkillDirPath("bar");
    expect(p).toBe(join(sandbox, "loadout", "skills", "bar"));
  });

  it("both helpers honor IGRIS_BRAIN_DIR (sandbox seam)", () => {
    const other = mkdtempSync(join(tmpdir(), "igris-paths-td191-other-"));
    try {
      process.env.IGRIS_BRAIN_DIR = other;
      expect(loadoutAgentDirPath("foo")).toBe(
        join(other, "loadout", "agents", "foo"),
      );
      expect(loadoutSkillDirPath("foo")).toBe(
        join(other, "loadout", "skills", "foo"),
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("symmetric shape: agent + skill differ only in the type prefix", () => {
    const agentPath = loadoutAgentDirPath("alpha");
    const skillPath = loadoutSkillDirPath("alpha");
    // Both end in `/<base>/<name>`; the diff is the typed-subfolder name.
    expect(agentPath.endsWith("/agents/alpha")).toBe(true);
    expect(skillPath.endsWith("/skills/alpha")).toBe(true);
    // The parent dirs (one level up from the name) are siblings under
    // `<brain>/loadout/`.
    expect(agentPath.replace("/agents/alpha", "")).toBe(
      skillPath.replace("/skills/alpha", ""),
    );
  });

  it("FR-165: secretsEnvPath() resolves under <brain>/secrets.env (IGRIS_BRAIN_DIR honored)", () => {
    expect(secretsEnvPath()).toBe(join(sandbox, "secrets.env"));
    const other = mkdtempSync(join(tmpdir(), "igris-paths-secrets-other-"));
    try {
      process.env.IGRIS_BRAIN_DIR = other;
      expect(secretsEnvPath()).toBe(join(other, "secrets.env"));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("L-517 invariant: catalog files live at the loadout root, NOT in typed subfolders", () => {
    // `loadoutOverlayPath()` and `loadoutOriginsPath()` are catalog files —
    // they MUST resolve at the loadout root, not under `agents/` or `skills/`.
    expect(loadoutOverlayPath()).toBe(
      join(sandbox, "loadout", "harness-manifest.personal.json"),
    );
    expect(loadoutOriginsPath()).toBe(
      join(sandbox, "loadout", "origins.json"),
    );
    // (Sanity: loadoutDirPath is just the root.)
    expect(loadoutDirPath()).toBe(join(sandbox, "loadout"));
  });
});
