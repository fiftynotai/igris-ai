/**
 * global-hooks.test.ts — FR-212c.
 *
 * `mergeGlobalCanonicalHooks` merges the canonical Igris hooks block into
 * ~/.claude/settings.json (the GLOBAL target). Engine + canonical source are
 * the same as the old install step 6; only the target path moved. We test
 * against a real tmp filesystem + a staged canonical-settings.json (no mocks of
 * the module under test).
 *
 * BR-106 triage: FENCED (Tier H + B) — mergeGlobalCanonicalHooks ->
 *   claudeUserSettingsPath -> homedir(); the verb WRITES the operator's
 *   real ~/.claude/settings.json when unfenced.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fenceHome, type HomeFence } from "./home-fence.js";

/** BR-106 — the tier-H HOME fence for this file. */
let br106Fence: HomeFence;

let tmpRoot: string;
let settingsPath: string;

const CANONICAL_HOOKS = {
  hooks: {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: "$HOME/.igris/core/hooks/shared/session_start.sh",
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: "Write|Edit",
        hooks: [
          {
            type: "command",
            command: "$HOME/.igris/core/hooks/shared/pre_tool_use.sh",
          },
        ],
      },
    ],
  },
};

function stageCanonical(): void {
  const hooksDir = join(tmpRoot, "core", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    join(hooksDir, "canonical-settings.json"),
    JSON.stringify(CANONICAL_HOOKS, null, 2) + "\n",
  );
}

beforeEach(async () => {
  br106Fence = fenceHome("igris-global-hooks-home-"); // BR-106: HOME moves FIRST, and ARMED
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-global-hooks-brain-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  stageCanonical();
  // The settings file lives in a SEPARATE sandbox dir (the global ~/.claude).
  const home = mkdtempSync(join(tmpdir(), "igris-global-hooks-home-"));
  settingsPath = join(home, "settings.json");
  const ch = await import("../lib/canonical-hooks.js");
  ch.clearCache();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
  delete process.env.IGRIS_KEEP_BAK;
  br106Fence.release(); // BR-106: restores HOME / IGRIS_BRAIN_DIR by key
});

describe("mergeGlobalCanonicalHooks", () => {
  it("writes the canonical hooks block to a fresh global settings.json", async () => {
    const { mergeGlobalCanonicalHooks } = await import("../lib/global-hooks.js");
    const res = mergeGlobalCanonicalHooks({ settingsPath });
    expect(res.outcome).toBe("merged");

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: Record<string, unknown[]>;
    };
    const ss = settings.hooks.SessionStart as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(ss[0].hooks[0].command).toBe(
      "$HOME/.igris/core/hooks/shared/session_start.sh",
    );
  });

  it("is idempotent — a second run is `unchanged` (no rewrite, no .bak)", async () => {
    const { mergeGlobalCanonicalHooks } = await import("../lib/global-hooks.js");
    process.env.IGRIS_KEEP_BAK = "0";
    const first = mergeGlobalCanonicalHooks({ settingsPath });
    expect(first.outcome).toBe("merged");
    const second = mergeGlobalCanonicalHooks({ settingsPath });
    expect(second.outcome).toBe("unchanged");
  });

  it("preserves a pre-existing user key (no-clobber merge)", async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ includeGitInstructions: false }) + "\n",
    );
    const { mergeGlobalCanonicalHooks } = await import("../lib/global-hooks.js");
    const res = mergeGlobalCanonicalHooks({ settingsPath });
    expect(res.outcome).toBe("merged");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(settings.includeGitInstructions).toBe(false);
    expect(settings.hooks).toBeDefined();
  });

  it("backs up a pre-existing settings.json before merging (unless IGRIS_KEEP_BAK=0)", async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Bash(echo:*)"] } }) + "\n",
    );
    const { mergeGlobalCanonicalHooks } = await import("../lib/global-hooks.js");
    const res = mergeGlobalCanonicalHooks({ settingsPath });
    expect(res.outcome).toBe("merged");
    const dir = settingsPath.slice(0, settingsPath.lastIndexOf("/"));
    const baks = readdirSync(dir).filter((e) =>
      e.startsWith("settings.json.bak."),
    );
    expect(baks.length).toBe(1);
  });

  it("REFUSES to clobber a malformed existing settings.json (returns `failed`)", async () => {
    writeFileSync(settingsPath, "{ this is not valid json");
    const before = readFileSync(settingsPath, "utf-8");
    const { mergeGlobalCanonicalHooks } = await import("../lib/global-hooks.js");
    const res = mergeGlobalCanonicalHooks({ settingsPath });
    expect(res.outcome).toBe("failed");
    // The malformed file is left untouched (no clobber).
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("returns `failed` (never throws) when the canonical hooks file is absent (TD-470: no attribution written either)", async () => {
    rmSync(join(tmpRoot, "core", "hooks", "canonical-settings.json"));
    const ch = await import("../lib/canonical-hooks.js");
    ch.clearCache();
    const { mergeGlobalCanonicalHooks } = await import("../lib/global-hooks.js");
    const res = mergeGlobalCanonicalHooks({ settingsPath });
    expect(res.outcome).toBe("failed");
    // No settings file was written.
    expect(existsSync(settingsPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TD-470 — the writer also applies Claude Code's `attribution` default (object
// form, only-if-absent). A SURVIVING CONTROL runs beside the positive case:
// "every fixture gained the block" would not be a measurement.
// ---------------------------------------------------------------------------
describe("mergeGlobalCanonicalHooks — TD-470 attribution (surviving control)", () => {
  const OFF = { commit: "", pr: "", sessionUrl: false };
  const USER_ATTRIBUTION = {
    commit: "Co-authored-by: Pair <pair@example.com>",
    pr: "",
    sessionUrl: true,
  };

  function sibling(name: string): string {
    return join(settingsPath.slice(0, settingsPath.lastIndexOf("/")), name);
  }

  it("T5: A (no attribution) gains exactly the object; B (user-chosen) keeps its subtree byte-identical", async () => {
    const { mergeGlobalCanonicalHooks } = await import("../lib/global-hooks.js");
    const fixtureA = {
      permissions: { allow: ["Bash(echo:*)"] },
      includeGitInstructions: false,
    };
    const fixtureB = { model: "x", attribution: USER_ATTRIBUTION };
    const pathA = settingsPath;
    const pathB = sibling("settings-b.json");
    writeFileSync(pathA, JSON.stringify(fixtureA, null, 2) + "\n");
    writeFileSync(pathB, JSON.stringify(fixtureB, null, 2) + "\n");

    const resA = mergeGlobalCanonicalHooks({ settingsPath: pathA });
    const resB = mergeGlobalCanonicalHooks({ settingsPath: pathB });

    // Assertion order is deliberate: the FILE-level control and positive case
    // come first, so HEAD (no attribution rule) reds on the file, not on a
    // result field it never had.

    // T5-B — the surviving control: the hooks merge still ran, the user's
    // attribution subtree did not move by a byte. Green at HEAD by design.
    expect(resB.outcome).toBe("merged");
    const b = JSON.parse(readFileSync(pathB, "utf-8")) as Record<string, unknown>;
    expect(b.hooks).toBeDefined();
    expect(JSON.stringify(b.attribution)).toBe(JSON.stringify(USER_ATTRIBUTION));

    // T5-A — the positive case (RED at HEAD).
    expect(resA.outcome).toBe("merged");
    const a = JSON.parse(readFileSync(pathA, "utf-8")) as Record<string, unknown>;
    expect(a.attribution).toStrictEqual(OFF);
    expect(a.permissions).toStrictEqual(fixtureA.permissions);
    expect(a.includeGitInstructions).toBe(false);
    expect(Object.keys(a)).toStrictEqual([
      "permissions",
      "includeGitInstructions",
      "hooks",
      "attribution",
    ]);

    expect(resA.attribution).toBe("added");
    expect(resB.attribution).toBe("kept-user");
  });

  it("T5c: the deprecated includeCoAuthoredBy is user-owned -> no attribution key written", async () => {
    const { mergeGlobalCanonicalHooks } = await import("../lib/global-hooks.js");
    writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }) + "\n");
    const res = mergeGlobalCanonicalHooks({ settingsPath });
    expect(res.attribution).toBe("kept-user");
    const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(s, "attribution")).toBe(false);
    expect(s.includeCoAuthoredBy).toBe(true);
  });

  it("T6: a second run on the file the writer produced is `unchanged` (present) with no second .bak", async () => {
    const { mergeGlobalCanonicalHooks } = await import("../lib/global-hooks.js");
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [] } }) + "\n");
    const first = mergeGlobalCanonicalHooks({ settingsPath });
    expect(first.outcome).toBe("merged");
    expect(first.attribution).toBe("added");
    const bytes = readFileSync(settingsPath, "utf-8");

    const second = mergeGlobalCanonicalHooks({ settingsPath });
    expect(second.outcome).toBe("unchanged");
    expect(second.attribution).toBe("present");
    expect(readFileSync(settingsPath, "utf-8")).toBe(bytes);
    const dir = settingsPath.slice(0, settingsPath.lastIndexOf("/"));
    const baks = readdirSync(dir).filter((e) => e.startsWith("settings.json.bak."));
    expect(baks.length).toBe(1);
  });

  it("T8: a malformed file is refused before either rule runs — bytes untouched, no attribution outcome", async () => {
    const { mergeGlobalCanonicalHooks } = await import("../lib/global-hooks.js");
    writeFileSync(settingsPath, "{ not json");
    const res = mergeGlobalCanonicalHooks({ settingsPath });
    expect(res.outcome).toBe("failed");
    expect(res.attribution).toBeUndefined();
    expect(readFileSync(settingsPath, "utf-8")).toBe("{ not json");
  });
});
