/**
 * JSON-merge primitive tests — Phase 3.
 *
 * Highest-risk file in MG-013 because corrupting a project's settings.json is
 * the worst silent-failure mode this CLI can introduce. Every fixture in
 * `__tests__/fixtures/settings/` is exercised here; merge throws or returns
 * are checked exactly.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MalformedSettingsError,
  mergeCanonicalHooks,
} from "../lib/json-merge.js";
import type { CanonicalHooks } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, "fixtures", "settings");

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

const CANONICAL = readFixture("canonical.json") as CanonicalHooks;

describe("mergeCanonicalHooks — fixtures", () => {
  it("vanilla {} → returns canonical hooks block, no other keys", () => {
    const out = mergeCanonicalHooks(readFixture("vanilla.json") as Record<string, unknown>, CANONICAL);
    expect(out).toEqual({ hooks: CANONICAL.hooks });
  });

  it("with-permissions → permissions key untouched, hooks merged", () => {
    const input = readFixture("with-permissions.json") as Record<string, unknown>;
    const out = mergeCanonicalHooks(input, CANONICAL);
    expect(out.permissions).toEqual({
      allow: ["Bash(git diff:*)", "Bash(git log:*)"],
    });
    expect(out.hooks).toEqual(CANONICAL.hooks);
  });

  it("with-include-git-instructions → BR-058 key preserved byte-for-byte", () => {
    const input = readFixture("with-include-git-instructions.json") as Record<
      string,
      unknown
    >;
    const out = mergeCanonicalHooks(input, CANONICAL);
    expect(out.includeGitInstructions).toBe(false);
    expect(out.hooks).toEqual(CANONICAL.hooks);
  });

  it("with-stale-igris-hooks → legacy portable filenames stripped", () => {
    const input = readFixture("with-stale-igris-hooks.json") as Record<string, unknown>;
    const out = mergeCanonicalHooks(input, CANONICAL);
    // The stale .claude/hooks/session_end.sh should be dropped entirely.
    // The output's SessionEnd should equal canonical's SessionEnd (no user entries left).
    expect(out.hooks).toBeDefined();
    const hooks = out.hooks as Record<string, unknown[]>;
    expect(hooks.SessionEnd).toEqual((CANONICAL.hooks as Record<string, unknown>)["SessionEnd"]);
  });

  it("with-user-hooks → SubagentStop (non-portable event) preserved verbatim", () => {
    const input = readFixture("with-user-hooks.json") as Record<string, unknown>;
    const before = JSON.parse(JSON.stringify(input));
    const out = mergeCanonicalHooks(input, CANONICAL);
    const beforeHooks = (before as { hooks: Record<string, unknown[]> }).hooks;
    const outHooks = out.hooks as Record<string, unknown[]>;
    expect(outHooks.SubagentStop).toEqual(beforeHooks.SubagentStop);
    // And canonical events present:
    expect(outHooks.SessionEnd).toEqual(
      (CANONICAL.hooks as Record<string, unknown>).SessionEnd,
    );
  });

  it("with-mixed → user PostToolUse entry preserved, Igris one replaced", () => {
    const input = readFixture("with-mixed.json") as Record<string, unknown>;
    const out = mergeCanonicalHooks(input, CANONICAL);
    const outHooks = out.hooks as Record<string, unknown[]>;
    const post = outHooks.PostToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    // Should have exactly 2 entries: canonical Igris (first per D-1) + user (matcher: Read)
    expect(post.length).toBe(2);
    // Igris entry first (matches D-1 default; install_claude_hooks.sh:217 puts Igris first).
    expect(post[0].matcher).toBe("Write|Edit");
    expect(post[0].hooks[0].command).toBe(
      "$HOME/.igris/core/hooks/shared/post_tool_use.sh",
    );
    // User entry preserved.
    expect(post[1].matcher).toBe("Read");
    expect(post[1].hooks[0].command).toBe(
      "$CLAUDE_PROJECT_DIR/.claude/hooks/teammate_idle_assign.sh",
    );
  });

  it("malformed.json → JSON.parse throws (verb layer catches; we don't even reach merge)", () => {
    const raw = readFileSync(join(FIXTURE_DIR, "malformed.json"), "utf-8");
    expect(() => JSON.parse(raw)).toThrow();
  });

  it("non-hooks-keys-preserved → every non-hooks key byte-for-byte equal", () => {
    const input = readFixture("non-hooks-keys-preserved.json") as Record<string, unknown>;
    const before = JSON.parse(JSON.stringify(input));
    const out = mergeCanonicalHooks(input, CANONICAL);
    // Every key from `before` (other than `hooks`) must equal exactly.
    for (const k of Object.keys(before)) {
      if (k === "hooks") continue;
      expect(out[k]).toEqual((before as Record<string, unknown>)[k]);
    }
    // hooks added (was not present originally).
    expect(out.hooks).toEqual(CANONICAL.hooks);
  });
});

describe("mergeCanonicalHooks — invariants", () => {
  it("does not mutate the caller's input object", () => {
    const input: Record<string, unknown> = {
      permissions: { allow: ["Bash(git diff:*)"] },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    mergeCanonicalHooks(input, CANONICAL);
    expect(input).toEqual(snapshot);
  });

  it("throws MalformedSettingsError on non-object root", () => {
    expect(() =>
      mergeCanonicalHooks(
        ["array", "root"] as unknown as Record<string, unknown>,
        CANONICAL,
      ),
    ).toThrow(MalformedSettingsError);
  });

  it("throws MalformedSettingsError on non-object hooks key", () => {
    expect(() =>
      mergeCanonicalHooks(
        { hooks: "not-an-object" } as unknown as Record<string, unknown>,
        CANONICAL,
      ),
    ).toThrow(MalformedSettingsError);
  });

  it("idempotent: merge twice = merge once", () => {
    const input: Record<string, unknown> = {
      permissions: { allow: ["Bash(git diff:*)"] },
    };
    const once = mergeCanonicalHooks(input, CANONICAL);
    const twice = mergeCanonicalHooks(once, CANONICAL);
    expect(twice).toEqual(once);
  });

  it("null/undefined treated as empty object", () => {
    const fromNull = mergeCanonicalHooks(null, CANONICAL);
    const fromUndef = mergeCanonicalHooks(undefined, CANONICAL);
    expect(fromNull).toEqual({ hooks: CANONICAL.hooks });
    expect(fromUndef).toEqual({ hooks: CANONICAL.hooks });
  });
});
