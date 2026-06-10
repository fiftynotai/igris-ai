/**
 * FR-180 (D7) hook-shape tests — the hook PROJECTOR's shape helper.
 *
 * Pins the claude hook GROUP shape + its canonical serialization with a TS-ONLY
 * golden so a projector-side regression reds the build. There is NO bash twin
 * and NO cross-impl parity test: unlike identity/agents, hook drift is
 * PRESENCE-BASED (the command path's presence in the merged settings.json, via
 * `_common.sh::verify_hook_entry_present`), not a byte-shape comparison — so this
 * golden locks the projector's OWN output, it does not assert bash==TS parity.
 */

import { describe, expect, it } from "vitest";
import {
  buildClaudeHookGroup,
  serializeClaudeHookGroup,
} from "../lib/hook-shape.js";

describe("buildClaudeHookGroup — per-event shape", () => {
  it("PreToolUse: emits the matcher + timeout", () => {
    const g = buildClaudeHookGroup("PreToolUse", {
      command: "$HOME/.igris/core/hooks/shared/PreToolUse.sh",
      matcher: "Write|Edit",
      timeout: 10,
    });
    expect(g).toEqual({
      matcher: "Write|Edit",
      hooks: [
        {
          type: "command",
          command: "$HOME/.igris/core/hooks/shared/PreToolUse.sh",
          timeout: 10,
        },
      ],
    });
  });

  it("SessionStart (non-tool event): DROPS the matcher even when supplied", () => {
    const g = buildClaudeHookGroup("SessionStart", {
      command: "$HOME/x.sh",
      matcher: "Write|Edit",
    });
    expect(g).toEqual({ hooks: [{ type: "command", command: "$HOME/x.sh" }] });
    expect("matcher" in g).toBe(false);
  });

  it("PostToolUse without matcher: a bare tool-event group", () => {
    const g = buildClaudeHookGroup("PostToolUse", { command: "$HOME/y.sh" });
    expect(g).toEqual({ hooks: [{ type: "command", command: "$HOME/y.sh" }] });
  });

  it("omits the timeout key when absent", () => {
    const g = buildClaudeHookGroup("SessionEnd", { command: "$HOME/z.sh" });
    expect("timeout" in g.hooks[0]).toBe(false);
  });
});

describe("serializeClaudeHookGroup — TS-only golden (the projector's own bytes)", () => {
  // These golden bytes pin the projector's serialized output (sort_keys compact
  // JSON). This is NOT a cross-impl parity test — hooks have no bash shaper twin
  // (drift is presence-based, not byte-shape). The golden just reds the build on
  // a TS-side regression to the shape the projector merges into settings.json.
  const GOLDEN: Array<[string, Parameters<typeof buildClaudeHookGroup>[1], string]> = [
    [
      "PreToolUse",
      {
        command: "$HOME/.igris/core/hooks/shared/PreToolUse.sh",
        matcher: "Write|Edit",
        timeout: 10,
      },
      '{"hooks":[{"command":"$HOME/.igris/core/hooks/shared/PreToolUse.sh","timeout":10,"type":"command"}],"matcher":"Write|Edit"}',
    ],
    [
      "SessionStart",
      { command: "$HOME/x.sh", matcher: "Write|Edit" },
      '{"hooks":[{"command":"$HOME/x.sh","type":"command"}]}',
    ],
    [
      "PostToolUse",
      { command: "$HOME/y.sh" },
      '{"hooks":[{"command":"$HOME/y.sh","type":"command"}]}',
    ],
    [
      "SessionEnd",
      { command: "$HOME/z.sh", timeout: 5 },
      '{"hooks":[{"command":"$HOME/z.sh","timeout":5,"type":"command"}]}',
    ],
  ];

  it.each(GOLDEN)("%s serializes to the pinned golden bytes", (event, canonical, golden) => {
    expect(serializeClaudeHookGroup(buildClaudeHookGroup(event, canonical))).toBe(golden);
  });

  it("serialization is key-order independent (sorted)", () => {
    const a = serializeClaudeHookGroup({
      matcher: "Write",
      hooks: [{ type: "command", command: "x" }],
    });
    const b = serializeClaudeHookGroup({
      hooks: [{ command: "x", type: "command" }],
      matcher: "Write",
    });
    expect(a).toBe(b);
  });
});
