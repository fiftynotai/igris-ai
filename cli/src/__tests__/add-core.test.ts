/**
 * FR-180: add-core (core-path skill writer) tests.
 *
 * Exercises `addCoreSkill` against a sandbox "repo" + brain (temp dirs) so the
 * real source-scaffold write + the TD-096 cp-mirror + verify_mirror.sh run
 * without touching the live igris-ai checkout. Asserts: the scaffold lands with
 * a DOUBLE-QUOTED colon-bearing `description:` (§13 #587), the runtime mirror is
 * byte-identical (verify_mirror MATCH), refuse-to-clobber on an existing skill,
 * and name validation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addCoreSkill } from "../verbs/add-core.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

let sandbox: string;
let repo: string;
let brain: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-add-core-"));
  repo = join(sandbox, "repo");
  brain = join(sandbox, "brain");
  mkdirSync(repo, { recursive: true });
  // The verify_mirror.sh primitive must live at <brain>/core/scripts/.
  mkdirSync(join(brain, "core", "scripts"), { recursive: true });
  cpSync(
    join(REPO_ROOT, "core", "scripts", "verify_mirror.sh"),
    join(brain, "core", "scripts", "verify_mirror.sh"),
  );
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("addCoreSkill — happy path", () => {
  it("writes the scaffold + mirrors + verifies MATCH", () => {
    const r = addCoreSkill({ name: "mytool", projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);

    // Source scaffold landed at <repo>/core/skills/mytool/SKILL.md.
    const src = join(repo, "core", "skills", "mytool", "SKILL.md");
    expect(existsSync(src)).toBe(true);
    const text = readFileSync(src, "utf-8");

    // §13 #587: the colon-bearing description scalar is DOUBLE-QUOTED.
    expect(text).toMatch(/^description: ".*usage: \/mytool"$/m);
    expect(text).toContain("name: mytool");

    // Runtime mirror is byte-identical and verify_mirror reported MATCH.
    const mirror = join(brain, "core", "skills", "mytool", "SKILL.md");
    expect(existsSync(mirror)).toBe(true);
    expect(readFileSync(mirror, "utf-8")).toBe(text);
    expect(r.verifyOutput).toContain("verdict:    MATCH");
    expect(r.verifyOutput).toContain("0 MISMATCH");
  });
});

describe("addCoreSkill — guards", () => {
  it("refuses to clobber an existing core skill (no overwrite)", () => {
    const dir = join(repo, "core", "skills", "mytool");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "PRE-EXISTING\n");
    const r = addCoreSkill({ name: "mytool", projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.reason).toContain("already exists");
    // The pre-existing file is untouched.
    expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toBe("PRE-EXISTING\n");
  });

  it("rejects a missing name (exit 2)", () => {
    const r = addCoreSkill({ name: undefined, projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
  });

  it("rejects an invalid name (exit 2)", () => {
    const r = addCoreSkill({ name: "Bad Name", projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
    expect(r.reason).toContain("must match");
  });
});

describe("addCoreSkill — skipMirror seam", () => {
  it("writes source only when skipMirror is set", () => {
    const r = addCoreSkill({
      name: "mytool",
      projectRoot: repo,
      brainRoot: brain,
      skipMirror: true,
    });
    expect(r.ok).toBe(true);
    expect(existsSync(join(repo, "core", "skills", "mytool", "SKILL.md"))).toBe(true);
    expect(existsSync(join(brain, "core", "skills", "mytool", "SKILL.md"))).toBe(false);
  });
});
