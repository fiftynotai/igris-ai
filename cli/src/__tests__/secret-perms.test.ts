/**
 * secret-perms.test.ts — TD-220.
 *
 * Unit tests for cli/src/lib/secret-perms.ts. Real fs + real chmod against a
 * tmp sandbox (per §12 — no vi.mock of the SUT). The win32 skip is exercised
 * via the injectable `platform` seam (Risk R3) so we never mutate the real
 * process.platform.
 *
 * Security (§14): the helper touches file METADATA only — these tests assert
 * on `statSync(...).mode`, never on file contents (and the helper never reads
 * contents).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSecretFilePerms,
  chmodSecretFile,
  isGitTracked,
  permsCheckSupported,
  SECRET_FILE_MODE,
  SECRET_PERMS_MASK,
} from "../lib/secret-perms.js";

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-secret-perms-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Write a file at `name` with `mode` (chmod applied AFTER write so umask
 *  doesn't interfere). Returns the absolute path. */
function stageFile(name: string, mode: number): string {
  const p = join(sandbox, name);
  writeFileSync(p, "x\n");
  chmodSync(p, mode);
  return p;
}

describe("secret-perms — constants", () => {
  it("exports the documented mask + target mode", () => {
    expect(SECRET_PERMS_MASK).toBe(0o077);
    expect(SECRET_FILE_MODE).toBe(0o600);
  });
});

describe("secret-perms — checkSecretFilePerms mask (T1)", () => {
  it("flags 644 as loose", () => {
    const p = stageFile("a.json", 0o644);
    expect(checkSecretFilePerms(p)).toBe("loose");
  });

  it("flags 640 as loose", () => {
    const p = stageFile("b.json", 0o640);
    expect(checkSecretFilePerms(p)).toBe("loose");
  });

  it("treats 600 as ok", () => {
    const p = stageFile("c.json", 0o600);
    expect(checkSecretFilePerms(p)).toBe("ok");
  });

  it("flags any single group/other bit (0o010 execute) as loose", () => {
    const p = stageFile("d.json", 0o610);
    expect(checkSecretFilePerms(p)).toBe("loose");
  });
});

describe("secret-perms — absent file (T2)", () => {
  it("returns ok without throwing for a missing file", () => {
    const p = join(sandbox, "does-not-exist.json");
    expect(() => checkSecretFilePerms(p)).not.toThrow();
    expect(checkSecretFilePerms(p)).toBe("ok");
  });
});

describe("secret-perms — chmodSecretFile (T3)", () => {
  it("chmods a 644 file to 600 and returns true", () => {
    const p = stageFile("e.json", 0o644);
    expect(chmodSecretFile(p)).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    // Post-chmod the verdict is ok (file is in a non-git tmp dir).
    expect(checkSecretFilePerms(p)).toBe("ok");
  });

  it("returns false (no-op) for an absent file", () => {
    const p = join(sandbox, "absent.json");
    expect(chmodSecretFile(p)).toBe(false);
  });
});

describe("secret-perms — isGitTracked (T4)", () => {
  it("returns false (no throw) for a file in a non-git tmp dir", () => {
    const p = stageFile("f.json", 0o600);
    expect(() => isGitTracked(p)).not.toThrow();
    expect(isGitTracked(p)).toBe(false);
  });

  it("returns false (no throw) for an absent path", () => {
    const p = join(sandbox, "nope.json");
    expect(() => isGitTracked(p)).not.toThrow();
    expect(isGitTracked(p)).toBe(false);
  });
});

describe("secret-perms — win32 skip via injectable seam (T5)", () => {
  it("permsCheckSupported(win32) is false", () => {
    expect(permsCheckSupported("win32")).toBe(false);
    expect(permsCheckSupported("linux")).toBe(true);
    expect(permsCheckSupported("darwin")).toBe(true);
  });

  it("checkSecretFilePerms returns ok on win32 even for a 644 file", () => {
    const p = stageFile("g.json", 0o644);
    // Without the seam this would be "loose"; the win32 seam short-circuits.
    expect(checkSecretFilePerms(p, "win32")).toBe("ok");
    // Sanity: same file, non-win32 platform, is loose.
    expect(checkSecretFilePerms(p, "linux")).toBe("loose");
  });

  it("chmodSecretFile is a no-op on win32 (returns false, mode unchanged)", () => {
    const p = stageFile("h.json", 0o644);
    expect(chmodSecretFile(p, "win32")).toBe(false);
    expect(statSync(p).mode & 0o777).toBe(0o644);
  });
});
