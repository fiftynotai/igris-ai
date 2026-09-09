/**
 * hook-settings-containment.test.ts — TD-408.
 *
 * The second and third instances of the TD-406 shape. Both hook projection
 * verbs resolve `.claude/settings.json` from an `opts.projectRoot ??
 * process.cwd()` default and then tmp-and-rename onto it, and that file is
 * TRACKED in this checkout — so a test runner standing in the real repo could
 * rewrite it exactly the way `applyPersona` rewrote `core/SOUL.md`.
 *
 * Assertions are on the REAL file's sha256, not on a return value: the defect is
 * a write, so only the file can refute it. Every refusal arm is paired with a
 * positive arm that writes a SANDBOX settings file, because a refusal test
 * passes just as well when the verb bailed out three checks earlier for an
 * unrelated reason.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The real igris-ai checkout, resolved from THIS FILE — never from cwd. */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const REAL_SETTINGS = join(REPO_ROOT, ".claude", "settings.json");

const ENV_KEYS = ["IGRIS_BRAIN_DIR", "IGRIS_REPO_DIR", "VITEST", "NODE_ENV"];

let workDir: string;
let brainRoot: string;
let sandboxRoot: string;
let startCwd: string;
const envBackup: Record<string, string | undefined> = {};

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A settings file carrying ONE personal hook group, so un-merge has work. */
function settingsWithPersonalGroup(name: string, event: string): string {
  return `${JSON.stringify(
    {
      hooks: {
        [event]: [
          {
            hooks: [
              {
                type: "command",
                command: `$HOME/.igris/loadout/hooks/${name}/${event}.sh`,
              },
            ],
          },
        ],
      },
      keep: true,
    },
    null,
    2,
  )}\n`;
}

beforeEach(() => {
  for (const k of ENV_KEYS) envBackup[k] = process.env[k];
  startCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "td408-"));
  brainRoot = join(workDir, "brain");
  sandboxRoot = join(workDir, "checkout");
  mkdirSync(join(sandboxRoot, ".claude"), { recursive: true });
  mkdirSync(brainRoot, { recursive: true });
  process.env.IGRIS_BRAIN_DIR = brainRoot;
  delete process.env.IGRIS_REPO_DIR;
});

afterEach(() => {
  // Restored unconditionally: one arm chdir's into the real checkout, and a
  // leaked cwd is the failure mode this whole brief is about.
  process.chdir(startCwd);
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe("TD-408 — arming facts, measured rather than quoted", () => {
  it("the real checkout carries a .claude/settings.json (else every arm is vacuous)", () => {
    expect(existsSync(REAL_SETTINGS)).toBe(true);
  });

  it("that file is TRACKED — the claim the whole brief rests on", () => {
    // `--error-unmatch` exits non-zero for an untracked path, so reaching the
    // next line at all is the assertion.
    execFileSync("git", ["ls-files", "--error-unmatch", ".claude/settings.json"], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    expect(true).toBe(true);
  });
});

describe("TD-408 — unproject-hook cannot write the real .claude/settings.json", () => {
  it("refuses with cwd = the real checkout and NO projectRoot, and the FILE is unchanged", async () => {
    const { runLoadout } = await import("../verbs/loadout.js");
    const before = sha256(REAL_SETTINGS);
    process.chdir(REPO_ROOT);

    const code = await runLoadout({
      action: "unproject-hook",
      name: "my-guard",
      harness: "claude",
      event: "PreToolUse",
    });

    // FILE first: the defect is a write, so the sha is the assertion that must
    // red at HEAD. Leading with the exit code would short-circuit and report a
    // number instead of the mutation.
    expect(sha256(REAL_SETTINGS)).toBe(before);
    expect(code).toBe(1);
  });

  it("refuses an EXPLICIT projectRoot pointing at the real checkout too", async () => {
    const { runLoadout } = await import("../verbs/loadout.js");
    const before = sha256(REAL_SETTINGS);

    const code = await runLoadout({
      action: "unproject-hook",
      name: "my-guard",
      harness: "claude",
      event: "PreToolUse",
      projectRoot: REPO_ROOT,
    });

    // FILE first: the defect is a write, so the sha is the assertion that must
    // red at HEAD. Leading with the exit code would short-circuit and report a
    // number instead of the mutation.
    expect(sha256(REAL_SETTINGS)).toBe(before);
    expect(code).toBe(1);
  });

  it("STILL writes inside a declared IGRIS_REPO_DIR — the refusals above are not an early bail", async () => {
    const target = join(sandboxRoot, ".claude", "settings.json");
    writeFileSync(target, settingsWithPersonalGroup("my-guard", "PreToolUse"));
    process.env.IGRIS_REPO_DIR = sandboxRoot;

    const { runLoadout } = await import("../verbs/loadout.js");
    const before = sha256(REAL_SETTINGS);

    const code = await runLoadout({
      action: "unproject-hook",
      name: "my-guard",
      harness: "claude",
      event: "PreToolUse",
      projectRoot: sandboxRoot,
    });

    expect(code).toBe(0);
    // The write stage was reached: the group is gone and the rest survives.
    const parsed = JSON.parse(readFileSync(target, "utf-8")) as {
      hooks?: unknown;
      keep?: boolean;
    };
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.keep).toBe(true);
    expect(sha256(REAL_SETTINGS)).toBe(before);
  });

  it("an explicit hookSettingsPath is unaffected by the seam (the pre-existing contract)", async () => {
    // remove.ts drives the verb this way; the seam guards the cwd-derived path
    // only, so this arm must keep working with IGRIS_REPO_DIR unset.
    const target = join(workDir, "elsewhere.json");
    writeFileSync(target, settingsWithPersonalGroup("solo", "SessionStart"));

    const { runLoadout } = await import("../verbs/loadout.js");
    const code = await runLoadout({
      action: "unproject-hook",
      name: "solo",
      harness: "claude",
      event: "SessionStart",
      hookSettingsPath: target,
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(target, "utf-8")) as {
      hooks?: unknown;
    };
    expect(parsed.hooks).toBeUndefined();
  });
});

describe("TD-408 — project-hook is the instance the sweep called read-only", () => {
  /**
   * `runProjectHook` holds no write verb in its own body; `mergeHookGroupIntoFile`
   * does. Classifying enclosing bodies — the very method that found
   * `runUnprojectHook` — therefore still cleared this one, which is why it needs
   * its own arm rather than a shared assertion.
   */
  const BLOCK = {
    name: "td408-probe",
    event: "SessionStart",
    canonical: { command: "$HOME/.igris/loadout/hooks/td408-probe/SessionStart.sh" },
    targets: [{ type: "claude" }],
  };

  function writeOverlay(): string {
    const overlayPath = join(workDir, "overlay.json");
    writeFileSync(
      overlayPath,
      `${JSON.stringify({ version: 1, agents: [], surfaces: { hooks: [BLOCK] } }, null, 2)}\n`,
    );
    return overlayPath;
  }

  it("refuses with cwd = the real checkout and NO projectRoot, and the FILE is unchanged", async () => {
    const { runLoadout } = await import("../verbs/loadout.js");
    const before = sha256(REAL_SETTINGS);
    const overlayPath = writeOverlay();
    process.chdir(REPO_ROOT);

    const code = await runLoadout({
      action: "project-hook",
      name: BLOCK.name,
      harness: "claude",
      overlayPath,
    });

    // FILE first: the defect is a write, so the sha is the assertion that must
    // red at HEAD. Leading with the exit code would short-circuit and report a
    // number instead of the mutation.
    expect(sha256(REAL_SETTINGS)).toBe(before);
    expect(code).toBe(1);
  });

  it("STILL writes inside a declared IGRIS_REPO_DIR — so the refusal is the seam, not the block lookup", async () => {
    const overlayPath = writeOverlay();
    const target = join(sandboxRoot, ".claude", "settings.json");
    process.env.IGRIS_REPO_DIR = sandboxRoot;

    const { runLoadout } = await import("../verbs/loadout.js");
    const before = sha256(REAL_SETTINGS);

    await runLoadout({
      action: "project-hook",
      name: BLOCK.name,
      harness: "claude",
      overlayPath,
      projectRoot: sandboxRoot,
    });

    // The merge writes BEFORE it verifies the command script exists, so the exit
    // code here is 1 for the missing script while the FILE proves the write
    // stage was reached. Asserting the file rather than the code is the point.
    expect(existsSync(target)).toBe(true);
    const parsed = JSON.parse(readFileSync(target, "utf-8")) as {
      hooks?: Record<string, unknown[]>;
    };
    expect(parsed.hooks?.SessionStart).toHaveLength(1);
    expect(sha256(REAL_SETTINGS)).toBe(before);
  });
});

describe("TD-408 — production is unchanged", () => {
  it("outside a test context, an undeclared cwd root resolves to the plain path", async () => {
    delete process.env.IGRIS_REPO_DIR;
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";

    const { projectSettingsPath } = await import("../lib/paths.js");
    const decided = projectSettingsPath(REPO_ROOT);

    expect(decided).toEqual({
      allowed: true,
      path: join(REPO_ROOT, ".claude", "settings.json"),
    });
  });

  it("in a test context an undeclared root is refused, with the reason named", async () => {
    const { projectSettingsPath } = await import("../lib/paths.js");
    expect(projectSettingsPath(REPO_ROOT)).toEqual({
      allowed: false,
      refusal: "test_context_undeclared",
      declaredRoot: null,
    });
  });

  it("a declared root that does not contain the target names the OTHER reason", async () => {
    process.env.IGRIS_REPO_DIR = sandboxRoot;
    const { projectSettingsPath } = await import("../lib/paths.js");
    expect(projectSettingsPath(REPO_ROOT)).toEqual({
      allowed: false,
      refusal: "outside_declared_root",
      declaredRoot: sandboxRoot,
    });
  });
});
