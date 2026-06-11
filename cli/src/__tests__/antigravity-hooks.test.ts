/**
 * antigravity-hooks.ts tests — FR-181.
 *
 * `installAntigravityHooks()` config-merges the PreToolUse + PostToolUse Igris
 * hook groups into antigravity's `~/.gemini/config/hooks.json`. These tests
 * exercise the merge against real `node:fs` tmp files via the `{ configPath }`
 * seam — fully hermetic, so the dev machine's real hooks.json is NEVER touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installAntigravityHooks } from "../lib/antigravity-hooks.js";

let workDir: string;
let configPath: string; // ~/.gemini/config/hooks.json stand-in

const PRE_CMD = "$HOME/.igris/core/hooks/bridges/antigravity/pre_tool_use.sh";
const POST_CMD = "$HOME/.igris/core/hooks/bridges/antigravity/post_tool_use.sh";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "igris-ag-hooks-"));
  // The config dir does NOT exist yet — the lib must benign-create it.
  configPath = join(workDir, "gemini", "config", "hooks.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/** Does hooks.<Event> contain a group whose first command === cmd? */
function hasCommand(j: Record<string, unknown>, event: string, cmd: string): boolean {
  const hooks = j.hooks as Record<string, unknown> | undefined;
  const arr = hooks?.[event];
  if (!Array.isArray(arr)) return false;
  return arr.some((g) => {
    const inner = (g as { hooks?: unknown }).hooks;
    return (
      Array.isArray(inner) &&
      inner.some((h) => (h as { command?: string }).command === cmd)
    );
  });
}

describe("installAntigravityHooks — absent config (the fresh install)", () => {
  it("benign-creates the dir and writes BOTH groups (matcher '*')", () => {
    const r = installAntigravityHooks({ configPath });
    expect(r.outcome).toBe("registered");
    expect(r.error).toBeUndefined();

    const j = readJson(configPath);
    expect(hasCommand(j, "PreToolUse", PRE_CMD)).toBe(true);
    expect(hasCommand(j, "PostToolUse", POST_CMD)).toBe(true);

    // matcher is "*" on both (the bridge + shared gate do the gating).
    const pre = (j.hooks as Record<string, unknown>).PreToolUse as Array<{
      matcher?: string;
    }>;
    expect(pre[0].matcher).toBe("*");
  });
});

describe("installAntigravityHooks — idempotency", () => {
  it("a re-run with both groups present is 'unchanged' (no write churn)", () => {
    installAntigravityHooks({ configPath });
    const first = readFileSync(configPath, "utf-8");

    const r = installAntigravityHooks({ configPath });
    expect(r.outcome).toBe("unchanged");
    // File bytes are identical — no churn.
    expect(readFileSync(configPath, "utf-8")).toBe(first);
  });
});

describe("installAntigravityHooks — preserve pre-existing hooks", () => {
  it("keeps an unrelated PreToolUse group and APPENDS ours (the pencil precedent)", () => {
    // mkdir the dir then drop a pre-existing unrelated hook.
    mkdirSync(join(workDir, "gemini", "config"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "*",
                hooks: [{ type: "command", command: "/usr/local/pencil.sh" }],
              },
            ],
          },
          someOtherKey: "preserved",
        },
        null,
        2,
      ),
    );

    const r = installAntigravityHooks({ configPath });
    expect(r.outcome).toBe("registered");

    const j = readJson(configPath);
    // Pre-existing group preserved.
    expect(hasCommand(j, "PreToolUse", "/usr/local/pencil.sh")).toBe(true);
    // Ours appended (so PreToolUse now has 2 groups).
    expect(hasCommand(j, "PreToolUse", PRE_CMD)).toBe(true);
    expect(
      ((j.hooks as Record<string, unknown>).PreToolUse as unknown[]).length,
    ).toBe(2);
    // PostToolUse added.
    expect(hasCommand(j, "PostToolUse", POST_CMD)).toBe(true);
    // Other top-level keys untouched.
    expect(j.someOtherKey).toBe("preserved");
  });
});

describe("installAntigravityHooks — malformed never-clobber", () => {
  it("returns 'failed' and leaves a malformed file byte-untouched", () => {
    mkdirSync(join(workDir, "gemini", "config"), { recursive: true });
    const malformed = "{ this is not json";
    writeFileSync(configPath, malformed);

    const r = installAntigravityHooks({ configPath });
    expect(r.outcome).toBe("failed");
    expect(r.error).toBeTruthy();
    // The malformed file is NEVER clobbered.
    expect(readFileSync(configPath, "utf-8")).toBe(malformed);
  });

  it("never throws on a malformed file (folds to a result object)", () => {
    mkdirSync(join(workDir, "gemini", "config"), { recursive: true });
    writeFileSync(configPath, "{ bad");
    expect(() => installAntigravityHooks({ configPath })).not.toThrow();
  });
});

describe("installAntigravityHooks — shape rejection", () => {
  it("refuses to clobber a hooks.PreToolUse that is not an array", () => {
    mkdirSync(join(workDir, "gemini", "config"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ hooks: { PreToolUse: "not-an-array" } }),
    );
    const r = installAntigravityHooks({ configPath });
    expect(r.outcome).toBe("failed");
    expect(r.error).toContain("clobber");
  });
});
