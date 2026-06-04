/**
 * TD-191: dedicated tests for the L-517 typed-subfolder layout helpers in
 * `cli/src/lib/paths.ts`. Covers:
 *   - `registryAgentDirPath(name)` resolves under `<brainDir>/registry/agents/<name>`
 *   - `registrySkillDirPath(name)` resolves under `<brainDir>/registry/skills/<name>`
 *   - Both honor `IGRIS_BRAIN_DIR` (the env seam every other registry helper
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
  registryAgentDirPath,
  registryDirPath,
  registryOriginsPath,
  registryOverlayPath,
  registrySkillDirPath,
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
  it("registryAgentDirPath('foo') resolves under <brain>/registry/agents/foo", () => {
    const p = registryAgentDirPath("foo");
    expect(p).toBe(join(sandbox, "registry", "agents", "foo"));
  });

  it("registrySkillDirPath('bar') resolves under <brain>/registry/skills/bar", () => {
    const p = registrySkillDirPath("bar");
    expect(p).toBe(join(sandbox, "registry", "skills", "bar"));
  });

  it("both helpers honor IGRIS_BRAIN_DIR (sandbox seam)", () => {
    const other = mkdtempSync(join(tmpdir(), "igris-paths-td191-other-"));
    try {
      process.env.IGRIS_BRAIN_DIR = other;
      expect(registryAgentDirPath("foo")).toBe(
        join(other, "registry", "agents", "foo"),
      );
      expect(registrySkillDirPath("foo")).toBe(
        join(other, "registry", "skills", "foo"),
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("symmetric shape: agent + skill differ only in the type prefix", () => {
    const agentPath = registryAgentDirPath("alpha");
    const skillPath = registrySkillDirPath("alpha");
    // Both end in `/<base>/<name>`; the diff is the typed-subfolder name.
    expect(agentPath.endsWith("/agents/alpha")).toBe(true);
    expect(skillPath.endsWith("/skills/alpha")).toBe(true);
    // The parent dirs (one level up from the name) are siblings under
    // `<brain>/registry/`.
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

  it("L-517 invariant: catalog files live at the registry root, NOT in typed subfolders", () => {
    // `registryOverlayPath()` and `registryOriginsPath()` are catalog files —
    // they MUST resolve at the registry root, not under `agents/` or `skills/`.
    expect(registryOverlayPath()).toBe(
      join(sandbox, "registry", "harness-manifest.personal.json"),
    );
    expect(registryOriginsPath()).toBe(
      join(sandbox, "registry", "origins.json"),
    );
    // (Sanity: registryDirPath is just the root.)
    expect(registryDirPath()).toBe(join(sandbox, "registry"));
  });
});
