/**
 * symlinks.test.ts — Phase 2 (M2.3).
 *
 * Real fs against tmp dirs. No mocks (per L-159). Six cases:
 *
 *   1. linkDir creates a new symlink to a directory.
 *   2. linkDir is idempotent against an existing matching symlink.
 *   3. linkDir reports broken-symlink-style: cannot replace an existing
 *      symlink that points elsewhere.
 *   4. Conflict: a real file at the link path raises SymlinkConflictError.
 *   5. Conflict: an existing symlink to a different target raises.
 *   6. Missing parent dir is auto-created (mkdir -p semantics).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-symlinks-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("symlinks — linkDir / linkFile", () => {
  it("creates a new directory symlink to an existing target", async () => {
    const m = await import("../lib/symlinks.js");
    const target = join(tmpRoot, "real-dir");
    mkdirSync(target);
    writeFileSync(join(target, "marker.txt"), "ok");
    const link = join(tmpRoot, "linked");

    m.linkDir(target, link);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    // Through the symlink, can read the marker.
    expect(readFileSync(join(link, "marker.txt"), "utf-8")).toBe("ok");
  });

  it("re-link to the same target is idempotent (no-op)", async () => {
    const m = await import("../lib/symlinks.js");
    const target = join(tmpRoot, "real-dir");
    mkdirSync(target);
    const link = join(tmpRoot, "linked");

    m.linkDir(target, link);
    const firstStat = lstatSync(link);

    // Second call should not throw and should not replace the link.
    m.linkDir(target, link);
    const secondStat = lstatSync(link);

    expect(secondStat.ino).toBe(firstStat.ino);
    expect(readlinkSync(link)).toBe(target);
  });

  it("conflict: existing symlink to a DIFFERENT target raises", async () => {
    const m = await import("../lib/symlinks.js");
    const desired = join(tmpRoot, "desired");
    const other = join(tmpRoot, "other");
    mkdirSync(desired);
    mkdirSync(other);
    const link = join(tmpRoot, "linked");

    // Pre-create a symlink pointing at `other`, not `desired`.
    symlinkSync(other, link);

    const { SymlinkConflictError } = await import("../lib/symlinks.js");
    expect(() => m.linkDir(desired, link)).toThrow(SymlinkConflictError);
    // Existing symlink is preserved (not silently clobbered).
    expect(readlinkSync(link)).toBe(other);
  });

  it("conflict: real directory at link path raises (refuse to clobber)", async () => {
    const m = await import("../lib/symlinks.js");
    const target = join(tmpRoot, "target-dir");
    mkdirSync(target);
    const link = join(tmpRoot, "real-dir-as-link");
    mkdirSync(link);
    writeFileSync(join(link, "preserved.txt"), "do-not-clobber");

    const { SymlinkConflictError } = await import("../lib/symlinks.js");
    expect(() => m.linkDir(target, link)).toThrow(SymlinkConflictError);
    // Real dir intact.
    expect(existsSync(join(link, "preserved.txt"))).toBe(true);
  });

  it("conflict: real file at link path raises", async () => {
    const m = await import("../lib/symlinks.js");
    const target = join(tmpRoot, "target.md");
    writeFileSync(target, "content");
    const link = join(tmpRoot, "real-file-as-link");
    writeFileSync(link, "preserved");

    const { SymlinkConflictError } = await import("../lib/symlinks.js");
    expect(() => m.linkFile(target, link)).toThrow(SymlinkConflictError);
    expect(readFileSync(link, "utf-8")).toBe("preserved");
  });

  it("missing parent dir is auto-created (mkdir -p)", async () => {
    const m = await import("../lib/symlinks.js");
    const target = join(tmpRoot, "real.md");
    writeFileSync(target, "content");
    const link = join(tmpRoot, "deeply", "nested", "linked.md");

    m.linkFile(target, link);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(link, "utf-8")).toBe("content");
  });

  it("missing target raises with actionable error", async () => {
    const m = await import("../lib/symlinks.js");
    const link = join(tmpRoot, "would-be-broken");

    const { SymlinkConflictError } = await import("../lib/symlinks.js");
    expect(() =>
      m.linkDir(join(tmpRoot, "does-not-exist"), link),
    ).toThrow(SymlinkConflictError);
    // The link MUST NOT exist after the failure (no broken-link surface).
    expect(existsSync(link)).toBe(false);
    // lstat-style check: not even a stale symlink.
    expect(() => lstatSync(link)).toThrow();
  });
});
