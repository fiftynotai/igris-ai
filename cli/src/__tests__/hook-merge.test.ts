/**
 * FR-180 (D7) hook-merge tests — the claude settings.json hook projector + the
 * R2 provenance helpers.
 *
 * Covers: idempotent + non-destructive merge into hooks.<Event>[], refuse-to-
 * clobber on an unexpected shape, the drift-side `hookCommandPresent`, and the
 * R2 provenance constants (personalHookCommandPath / isPersonalHookCommand) that
 * the canonical re-merge keys on (the R2 preservation itself is asserted in
 * json-merge.test.ts).
 */

import { describe, expect, it } from "vitest";
import {
  mergeHookIntoSettings,
  hookCommandPresent,
  resolveHookCommandPath,
  personalHookCommandPath,
  isPersonalHookCommand,
  PERSONAL_HOOK_CMD_PREFIX,
  HookMergeShapeError,
} from "../lib/hook-merge.js";
import { buildClaudeHookGroup } from "../lib/hook-shape.js";

const GROUP = buildClaudeHookGroup("PreToolUse", {
  command: "$HOME/.igris/loadout/hooks/my-guard/PreToolUse.sh",
  matcher: "Write|Edit",
});

describe("mergeHookIntoSettings — idempotent + non-destructive", () => {
  it("appends the group into a fresh settings object", () => {
    const out = mergeHookIntoSettings({}, "PreToolUse", GROUP);
    const arr = (out.hooks as Record<string, unknown[]>).PreToolUse;
    expect(arr).toHaveLength(1);
    expect(arr[0]).toEqual(GROUP);
  });

  it("re-merging the SAME command path is a no-op (replace in place, not append)", () => {
    const once = mergeHookIntoSettings({}, "PreToolUse", GROUP);
    const twice = mergeHookIntoSettings(once, "PreToolUse", GROUP);
    expect(twice).toEqual(once);
    expect((twice.hooks as Record<string, unknown[]>).PreToolUse).toHaveLength(1);
  });

  it("preserves a pre-existing USER group in the same event", () => {
    const userGroup = {
      hooks: [{ type: "command", command: "$HOME/my/own/hook.sh" }],
    };
    const existing = { hooks: { PreToolUse: [userGroup] } };
    const out = mergeHookIntoSettings(existing, "PreToolUse", GROUP);
    const arr = (out.hooks as Record<string, unknown[]>).PreToolUse;
    expect(arr).toHaveLength(2);
    expect(arr[0]).toEqual(userGroup);
    expect(arr[1]).toEqual(GROUP);
  });

  it("preserves OTHER top-level keys + other events byte-for-byte", () => {
    const existing = {
      permissions: { allow: ["Bash(git diff:*)"] },
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "se.sh" }] }] },
    };
    const out = mergeHookIntoSettings(existing, "PreToolUse", GROUP);
    expect(out.permissions).toEqual({ allow: ["Bash(git diff:*)"] });
    expect((out.hooks as Record<string, unknown>).SessionEnd).toEqual([
      { hooks: [{ type: "command", command: "se.sh" }] },
    ]);
  });

  it("does not mutate the caller's input", () => {
    const input = { hooks: { PreToolUse: [] } };
    const snapshot = JSON.parse(JSON.stringify(input));
    mergeHookIntoSettings(input, "PreToolUse", GROUP);
    expect(input).toEqual(snapshot);
  });

  it("null/undefined existing → fresh object", () => {
    expect(mergeHookIntoSettings(null, "PreToolUse", GROUP)).toEqual({
      hooks: { PreToolUse: [GROUP] },
    });
    expect(mergeHookIntoSettings(undefined, "PreToolUse", GROUP)).toEqual({
      hooks: { PreToolUse: [GROUP] },
    });
  });

  it("throws HookMergeShapeError on a non-array event value (refuse to clobber)", () => {
    expect(() =>
      mergeHookIntoSettings(
        { hooks: { PreToolUse: "not-an-array" } },
        "PreToolUse",
        GROUP,
      ),
    ).toThrow(HookMergeShapeError);
  });

  it("throws HookMergeShapeError on a non-object hooks value", () => {
    expect(() =>
      mergeHookIntoSettings({ hooks: "nope" }, "PreToolUse", GROUP),
    ).toThrow(HookMergeShapeError);
  });
});

describe("hookCommandPresent — drift reader", () => {
  it("MATCH when the command path is present under its event", () => {
    const settings = mergeHookIntoSettings({}, "PreToolUse", GROUP);
    expect(
      hookCommandPresent(
        settings,
        "PreToolUse",
        "$HOME/.igris/loadout/hooks/my-guard/PreToolUse.sh",
      ),
    ).toBe(true);
  });

  it("absent → false (different command, wrong event, no hooks)", () => {
    const settings = mergeHookIntoSettings({}, "PreToolUse", GROUP);
    expect(hookCommandPresent(settings, "PreToolUse", "$HOME/other.sh")).toBe(false);
    expect(hookCommandPresent(settings, "SessionStart", "$HOME/.igris/loadout/hooks/my-guard/PreToolUse.sh")).toBe(false);
    expect(hookCommandPresent({}, "PreToolUse", "x")).toBe(false);
    expect(hookCommandPresent(null, "PreToolUse", "x")).toBe(false);
  });
});

describe("R2 provenance helpers", () => {
  it("personalHookCommandPath builds the loadout-prefix path", () => {
    expect(personalHookCommandPath("my-guard", "PreToolUse")).toBe(
      "$HOME/.igris/loadout/hooks/my-guard/PreToolUse.sh",
    );
  });

  it("isPersonalHookCommand classifies by prefix", () => {
    expect(isPersonalHookCommand(personalHookCommandPath("g", "SessionStart"))).toBe(true);
    expect(isPersonalHookCommand("$HOME/.igris/core/hooks/shared/SessionStart.sh")).toBe(false);
    expect(PERSONAL_HOOK_CMD_PREFIX).toBe("$HOME/.igris/loadout/hooks/");
  });

  it("resolveHookCommandPath expands the $HOME prefix against a home dir", () => {
    expect(resolveHookCommandPath("$HOME/.igris/loadout/hooks/g/PreToolUse.sh", "/Users/me")).toBe(
      "/Users/me/.igris/loadout/hooks/g/PreToolUse.sh",
    );
    expect(resolveHookCommandPath("/abs/path.sh", "/Users/me")).toBe("/abs/path.sh");
  });
});
