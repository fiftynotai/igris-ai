/**
 * antigravity-skills.ts tests — FR-179 Phase C (R2).
 *
 * `linkAntigravitySkills()` create-or-repairs the parent symlink
 * `~/.gemini/antigravity-cli/skills → ~/.agents/skills`. Idempotent-repair,
 * NEVER throws. These tests exercise the five cases (plan §C2) against real
 * `node:fs` tmp files using the `{ linkPath, target }` seam — fully hermetic, so
 * the dev machine's real symlink is NEVER touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  linkAntigravitySkills,
  antigravitySkillsLinkOk,
} from "../lib/antigravity-skills.js";

let workDir: string;
let linkPath: string; // the antigravity-cli/skills location
let target: string; // ~/.agents/skills stand-in

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "igris-agskills-"));
  // link parent exists (antigravity-cli/), the link itself is created per-case.
  linkPath = join(workDir, "gemini", "antigravity-cli", "skills");
  target = join(workDir, "agents", "skills");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function isSymlinkTo(path: string, expected: string): boolean {
  let lst;
  try {
    lst = lstatSync(path);
  } catch {
    return false;
  }
  return lst.isSymbolicLink() && readlinkSync(path) === expected;
}

describe("linkAntigravitySkills — case 2: link absent", () => {
  it("creates the symlink AND mkdir -p the target + the link parent", () => {
    // Nothing exists yet (no target, no antigravity-cli dir).
    const res = linkAntigravitySkills({ linkPath, target });
    expect(res.outcome).toBe("created");
    expect(res.error).toBeUndefined();
    // Target dir was created (case-1 behavior folded in).
    expect(existsSync(target)).toBe(true);
    // The link is in place and points at the target.
    expect(isSymlinkTo(linkPath, target)).toBe(true);
    expect(antigravitySkillsLinkOk({ linkPath, target })).toBe(true);
  });
});

describe("linkAntigravitySkills — case 3: already correct", () => {
  it("is a silent idempotent no-op", () => {
    mkdirSync(target, { recursive: true });
    mkdirSync(join(workDir, "gemini", "antigravity-cli"), { recursive: true });
    symlinkSync(target, linkPath);

    const res = linkAntigravitySkills({ linkPath, target });
    expect(res.outcome).toBe("unchanged");
    expect(isSymlinkTo(linkPath, target)).toBe(true);

    // Running twice stays unchanged (true idempotency).
    const again = linkAntigravitySkills({ linkPath, target });
    expect(again.outcome).toBe("unchanged");
  });
});

describe("linkAntigravitySkills — case 4: symlink to the wrong target", () => {
  it("atomically repoints to the correct target", () => {
    const elsewhere = join(workDir, "somewhere-else");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(target, { recursive: true });
    mkdirSync(join(workDir, "gemini", "antigravity-cli"), { recursive: true });
    symlinkSync(elsewhere, linkPath);

    const res = linkAntigravitySkills({ linkPath, target });
    expect(res.outcome).toBe("repointed");
    expect(isSymlinkTo(linkPath, target)).toBe(true);
    expect(antigravitySkillsLinkOk({ linkPath, target })).toBe(true);
  });
});

describe("linkAntigravitySkills — case 5a: real EMPTY dir", () => {
  it("removes the empty dir and replaces it with the symlink", () => {
    mkdirSync(target, { recursive: true });
    mkdirSync(linkPath, { recursive: true }); // real empty dir at the link path

    const res = linkAntigravitySkills({ linkPath, target });
    expect(res.outcome).toBe("repointed");
    expect(isSymlinkTo(linkPath, target)).toBe(true);
  });
});

describe("linkAntigravitySkills — case 5b: real NON-EMPTY dir", () => {
  it("refuses to clobber, NEVER throws, and leaves the content intact", () => {
    mkdirSync(target, { recursive: true });
    mkdirSync(linkPath, { recursive: true });
    const userFile = join(linkPath, "user-skill.md");
    writeFileSync(userFile, "do not delete me");

    let res;
    // Must not throw — the call folds the refusal into a result object.
    expect(() => {
      res = linkAntigravitySkills({ linkPath, target });
    }).not.toThrow();

    expect(res!.outcome).toBe("refused");
    expect(res!.error).toBeTruthy();
    // The real dir + its content are untouched (still a real dir, file present).
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(linkPath).isDirectory()).toBe(true);
    expect(existsSync(userFile)).toBe(true);
    expect(readdirSync(linkPath)).toContain("user-skill.md");
    // The read-only health check agrees the link is NOT ok.
    expect(antigravitySkillsLinkOk({ linkPath, target })).toBe(false);
  });
});

describe("antigravitySkillsLinkOk — read-only health check", () => {
  it("false when absent, true after a successful link", () => {
    expect(antigravitySkillsLinkOk({ linkPath, target })).toBe(false);
    linkAntigravitySkills({ linkPath, target });
    expect(antigravitySkillsLinkOk({ linkPath, target })).toBe(true);
  });
});
