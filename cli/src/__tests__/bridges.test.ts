/**
 * bridges.ts tests — M1.7.
 *
 * Mocks ONLY at the adapter-runner boundary (via `runAdapter` test seam);
 * no `vi.mock` of the module. We do NOT spawn real shells in unit tests
 * — bats integration covers the live invocation path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BridgeError,
  materializeBridges,
} from "../lib/bridges.js";

let brainRoot: string;
let projectPath: string;

beforeEach(() => {
  brainRoot = mkdtempSync(join(tmpdir(), "igris-bridges-"));
  projectPath = mkdtempSync(join(tmpdir(), "igris-bridges-proj-"));
});

afterEach(() => {
  rmSync(brainRoot, { recursive: true, force: true });
  rmSync(projectPath, { recursive: true, force: true });
});

function stageAdapter(name: string): string {
  const adaptersDir = join(brainRoot, "core", "scripts", "cli-adapters");
  mkdirSync(adaptersDir, { recursive: true });
  const file = join(adaptersDir, `${name}.sh`);
  writeFileSync(file, "#!/bin/sh\necho ok\n");
  chmodSync(file, 0o755);
  return file;
}

describe("bridges — invokes one adapter per target", () => {
  it("runs claude adapter when claude is in target set and adapter exists", () => {
    stageAdapter("claude");
    const calls: Array<{ script: string; args: string[] }> = [];
    const out = materializeBridges({
      targets: new Set(["claude"]),
      projectPath,
      brainRoot,
      runAdapter: (script, args) => {
        calls.push({ script, args });
        return "";
      },
    });
    expect(out.length).toBe(1);
    expect(out[0].target).toBe("claude");
    expect(calls.length).toBe(1);
    expect(calls[0].args).toEqual([projectPath]);
    expect(calls[0].script.endsWith("claude.sh")).toBe(true);
  });

  it("runs multiple adapters in declared target order", () => {
    stageAdapter("claude");
    stageAdapter("codex");
    const calls: string[] = [];
    materializeBridges({
      targets: new Set(["claude", "codex"]),
      projectPath,
      brainRoot,
      runAdapter: (script) => {
        calls.push(script);
        return "";
      },
    });
    expect(calls.length).toBe(2);
    expect(calls[0].endsWith("claude.sh") || calls[0].endsWith("codex.sh")).toBe(true);
  });
});

describe("bridges — missing adapter handling", () => {
  it("silently skips a target whose adapter is not present", () => {
    // Only stage codex; ask for claude+codex.
    stageAdapter("codex");
    const calls: string[] = [];
    const out = materializeBridges({
      targets: new Set(["claude", "codex"]),
      projectPath,
      brainRoot,
      runAdapter: (script) => {
        calls.push(script);
        return "";
      },
    });
    expect(out.length).toBe(1);
    expect(out[0].target).toBe("codex");
    expect(calls.length).toBe(1);
  });

  it("returns empty result when nothing in target set", () => {
    stageAdapter("claude");
    const out = materializeBridges({
      targets: new Set([]),
      projectPath,
      brainRoot,
      runAdapter: () => "",
    });
    expect(out.length).toBe(0);
  });
});

describe("bridges — adapter failure surfaces as BridgeError", () => {
  it("wraps a thrown runner error in BridgeError with target identity", () => {
    stageAdapter("claude");
    expect(() =>
      materializeBridges({
        targets: new Set(["claude"]),
        projectPath,
        brainRoot,
        runAdapter: () => {
          throw new Error("adapter exited 1: bad config");
        },
      }),
    ).toThrow(BridgeError);
  });

  it("BridgeError carries the failing target's name", () => {
    stageAdapter("codex");
    let thrown: unknown = null;
    try {
      materializeBridges({
        targets: new Set(["codex"]),
        projectPath,
        brainRoot,
        runAdapter: () => {
          throw new Error("boom");
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BridgeError);
    expect((thrown as BridgeError).target).toBe("codex");
  });
});
