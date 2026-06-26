/**
 * global-hooks.test.ts — FR-212c.
 *
 * `mergeGlobalCanonicalHooks` merges the canonical Igris hooks block into
 * ~/.claude/settings.json (the GLOBAL target). Engine + canonical source are
 * the same as the old install step 6; only the target path moved. We test
 * against a real tmp filesystem + a staged canonical-settings.json (no mocks of
 * the module under test).
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

  it("returns `failed` (never throws) when the canonical hooks file is absent", async () => {
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
