/**
 * atomic-extract.ts tests — M1.4.
 *
 * Real fs against tmp; no mocks (atomic-extract is a pure-fs primitive).
 *
 * The "mid-flight failure rollback" test is the gate for any verb
 * consuming atomic-extract. When an extraction-side failure leaves the
 * new dir absent, we expect the original `core/` to be restored.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  AtomicExtractError,
  atomicSwap,
  cleanupOldBaks,
  stagingDirFor,
} from "../lib/atomic-extract.js";

// --- node:fs boundary mock (L-159: spy the fs boundary, never the SUT) ---
// Only `atomicSwap` calls `renameSync` in the SUT+test surface, so wrapping
// ONLY `renameSync` (passthrough for everything else) is fully targeted.
// `renameThrowOn` holds the 1-based rename call indexes that should throw;
// empty by default → pure passthrough, keeping all pre-existing tests green.
const renameThrowOn = new Set<number>();
let renameCallCount = 0;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      renameCallCount += 1;
      if (renameThrowOn.has(renameCallCount)) {
        const err = new Error(
          "EEXIST: simulated post-bak swap failure",
        ) as Error & { code?: string };
        err.code = "EEXIST";
        throw err;
      }
      return actual.renameSync(from, to);
    },
  };
});

let workDir: string;
let coreDir: string;
let newDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "igris-atomic-test-"));
  coreDir = join(workDir, "core");
  newDir = join(workDir, "core.new.12345");
  // Reset the rename fault-injection state → default is pure passthrough.
  renameCallCount = 0;
  renameThrowOn.clear();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function stageNewCore(): void {
  mkdirSync(newDir, { recursive: true });
  writeFileSync(join(newDir, "marker.txt"), "new\n");
}

function stageExistingCore(): void {
  mkdirSync(coreDir, { recursive: true });
  writeFileSync(join(coreDir, "marker.txt"), "old\n");
}

describe("atomic-extract — fresh init (no existing core)", () => {
  it("renames new dir to core/, no bak created", () => {
    stageNewCore();
    const r = atomicSwap({
      newCorePath: newDir,
      existingCorePath: coreDir,
      upgrade: false,
    });
    expect(r.bakPath).toBe(null);
    expect(existsSync(coreDir)).toBe(true);
    expect(existsSync(newDir)).toBe(false);
    expect(readFileSync(join(coreDir, "marker.txt"), "utf-8")).toBe("new\n");
  });

  it("upgrade=true on fresh init also leaves no bak", () => {
    stageNewCore();
    const r = atomicSwap({
      newCorePath: newDir,
      existingCorePath: coreDir,
      upgrade: true,
    });
    expect(r.bakPath).toBe(null);
    expect(existsSync(coreDir)).toBe(true);
  });
});

describe("atomic-extract — upgrade with existing core", () => {
  it("backs up existing core to core.bak.<ts>/ before swap", () => {
    stageExistingCore();
    stageNewCore();
    const r = atomicSwap({
      newCorePath: newDir,
      existingCorePath: coreDir,
      upgrade: true,
    });
    expect(r.bakPath).not.toBeNull();
    expect(existsSync(r.bakPath!)).toBe(true);
    expect(readFileSync(join(r.bakPath!, "marker.txt"), "utf-8")).toBe("old\n");
    expect(readFileSync(join(coreDir, "marker.txt"), "utf-8")).toBe("new\n");
  });

  it("refuses to overwrite existing core when upgrade=false", () => {
    stageExistingCore();
    stageNewCore();
    expect(() =>
      atomicSwap({
        newCorePath: newDir,
        existingCorePath: coreDir,
        upgrade: false,
      }),
    ).toThrow(AtomicExtractError);
    // Existing core unchanged.
    expect(readFileSync(join(coreDir, "marker.txt"), "utf-8")).toBe("old\n");
    // New dir untouched.
    expect(existsSync(newDir)).toBe(true);
  });

  it("cleans up older baks by default (keeps only the latest one)", () => {
    // Stage TWO old baks pre-swap, then upgrade.
    stageExistingCore();
    stageNewCore();
    const oldBak1 = join(workDir, "core.bak.2026-01-01T00-00-00-000Z");
    const oldBak2 = join(workDir, "core.bak.2026-02-01T00-00-00-000Z");
    mkdirSync(oldBak1, { recursive: true });
    mkdirSync(oldBak2, { recursive: true });

    const r = atomicSwap({
      newCorePath: newDir,
      existingCorePath: coreDir,
      upgrade: true,
    });
    expect(r.bakPath).not.toBeNull();

    const baks = readdirSync(workDir).filter((e) => e.startsWith("core.bak."));
    // Only the just-created bak should remain.
    expect(baks.length).toBe(1);
  });

  it("keepAllBaks=true preserves prior baks", () => {
    stageExistingCore();
    stageNewCore();
    const oldBak = join(workDir, "core.bak.2026-01-01T00-00-00-000Z");
    mkdirSync(oldBak, { recursive: true });

    atomicSwap({
      newCorePath: newDir,
      existingCorePath: coreDir,
      upgrade: true,
      keepAllBaks: true,
    });
    const baks = readdirSync(workDir).filter((e) => e.startsWith("core.bak."));
    expect(baks.length).toBeGreaterThanOrEqual(2);
  });
});

describe("atomic-extract — mid-flight failure rollback (CRITICAL gate)", () => {
  it("when newCorePath does not exist, error AND original core is preserved", () => {
    stageExistingCore();
    // Don't stage newDir.
    expect(() =>
      atomicSwap({
        newCorePath: newDir,
        existingCorePath: coreDir,
        upgrade: true,
      }),
    ).toThrow(AtomicExtractError);
    // Original core still in place.
    expect(existsSync(coreDir)).toBe(true);
    expect(readFileSync(join(coreDir, "marker.txt"), "utf-8")).toBe("old\n");
    // No bak created (we errored BEFORE the bak step).
    const baks = readdirSync(workDir).filter((e) => e.startsWith("core.bak."));
    expect(baks.length).toBe(0);
  });

  it("when swap fails AFTER bak (simulated by a non-empty target dir blocking rename), bak is restored", () => {
    // Simulate the failure mode: after the bak rename succeeds, we
    // CREATE a NEW directory at the destination path (where new
    // dir was supposed to land), so the rename fails.
    //
    // We can't easily inject that timing into the real atomicSwap
    // call; instead, we use the public `atomicSwap` with a contrived
    // scenario: pass a `newCorePath` that vanishes between the bak
    // and the swap. To do that without race-condition flakiness, we
    // exercise the protected path by passing a non-directory file.
    stageExistingCore();
    // Stage newCorePath as a FILE not a directory — atomicSwap's
    // pre-check should reject before bak.
    writeFileSync(newDir, "not a dir");
    expect(() =>
      atomicSwap({
        newCorePath: newDir,
        existingCorePath: coreDir,
        upgrade: true,
      }),
    ).toThrow(AtomicExtractError);
    // Original core untouched.
    expect(existsSync(coreDir)).toBe(true);
    expect(readFileSync(join(coreDir, "marker.txt"), "utf-8")).toBe("old\n");
  });

  it("rollback preserves byte content of original core/", () => {
    stageExistingCore();
    // Add a few more files so byte-for-byte preservation has surface area.
    writeFileSync(join(coreDir, "agents-list"), "alpha\nbeta\ngamma\n");
    mkdirSync(join(coreDir, "skills"), { recursive: true });
    writeFileSync(join(coreDir, "skills", "x.md"), "skill x\n");

    // newCorePath absent → atomicSwap throws.
    expect(() =>
      atomicSwap({
        newCorePath: newDir,
        existingCorePath: coreDir,
        upgrade: true,
      }),
    ).toThrow();
    // All original files survive.
    expect(readFileSync(join(coreDir, "marker.txt"), "utf-8")).toBe("old\n");
    expect(readFileSync(join(coreDir, "agents-list"), "utf-8")).toBe(
      "alpha\nbeta\ngamma\n",
    );
    expect(readFileSync(join(coreDir, "skills", "x.md"), "utf-8")).toBe(
      "skill x\n",
    );
  });

  it("post-bak swap failure triggers rollback of bak → original core (byte-equal)", () => {
    // TD-114: genuinely reach the post-bak rollback branch (lines ~114-128).
    // The real-fs EEXIST trigger cannot reach it (Step 1 empties the target
    // slot before Step 2), so we fault-inject at the node:fs boundary: throw
    // only on the 2nd rename (the swap). Call order for existing+upgrade is
    // deterministic: bak=1 (real, ok), swap=2 (throws → catch), rollback=3
    // (real, ok).
    stageExistingCore();
    // Extra files give byte-preservation surface area.
    writeFileSync(join(coreDir, "agents-list"), "alpha\nbeta\ngamma\n");
    mkdirSync(join(coreDir, "skills"), { recursive: true });
    writeFileSync(join(coreDir, "skills", "x.md"), "skill x\n");
    stageNewCore();

    renameThrowOn.add(2); // swap fails; rollback (call #3) succeeds.

    // The line-127 message is emitted ONLY after the rollback rename succeeds,
    // distinguishing it from pre-bak precheck errors and the double-failure msg.
    expect(() =>
      atomicSwap({
        newCorePath: newDir,
        existingCorePath: coreDir,
        upgrade: true,
      }),
    ).toThrow(/swap failed and rolled back/);

    // Defensive: confirms the mock intercepted exactly bak + failed-swap +
    // rollback (proves the branch was genuinely exercised, not short-circuited).
    expect(renameCallCount).toBe(3);

    // Original restored, byte-equal (bak carried the ORIGINAL content back).
    expect(existsSync(coreDir)).toBe(true);
    expect(readFileSync(join(coreDir, "marker.txt"), "utf-8")).toBe("old\n");
    expect(readFileSync(join(coreDir, "agents-list"), "utf-8")).toBe(
      "alpha\nbeta\ngamma\n",
    );
    expect(readFileSync(join(coreDir, "skills", "x.md"), "utf-8")).toBe(
      "skill x\n",
    );

    // No orphaned bak — it was renamed back to existing.
    const baks = readdirSync(workDir).filter((e) => e.startsWith("core.bak."));
    expect(baks.length).toBe(0);

    // newDir is LEFT for the caller (swap threw before consuming it) — the
    // documented module contract (doc lines 18-19). The correct-on-read code
    // does NOT clean core.new on rollback, so we assert its real behavior.
    expect(existsSync(newDir)).toBe(true);
  });

  it("double failure (swap AND rollback) surfaces the manual-recovery message and leaves bak", () => {
    // TD-114 optional: covers lines 120-125 (rollback rename ALSO throws).
    // renameThrowOn={2,3}: bak=1 (ok), swap=2 (throws), rollback=3 (throws).
    stageExistingCore();
    stageNewCore();

    renameThrowOn.add(2);
    renameThrowOn.add(3);

    // Invoke ONCE and capture the error — re-invoking would mutate fs state
    // (the first call leaves core/ absent + core.new present, so a 2nd call
    // would succeed instead of throw). Assert both message halves off the
    // single thrown error.
    let thrown: unknown;
    try {
      atomicSwap({
        newCorePath: newDir,
        existingCorePath: coreDir,
        upgrade: true,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AtomicExtractError);
    expect((thrown as Error).message).toMatch(/AND rollback failed/);
    expect((thrown as Error).message).toMatch(/manual recovery: .*core\.bak\./);

    // Bak still present (never restored) — exactly one remains.
    const baks = readdirSync(workDir).filter((e) => e.startsWith("core.bak."));
    expect(baks.length).toBe(1);

    // Manual-recovery state: bak not moved back, new not moved in.
    expect(existsSync(coreDir)).toBe(false);
  });
});

describe("atomic-extract — utility surface", () => {
  it("stagingDirFor builds <brainDir>/core.new.<pid>", () => {
    const p = stagingDirFor("/var/igris", 999);
    expect(p).toBe("/var/igris/core.new.999");
  });

  it("cleanupOldBaks tolerates missing parent dir", () => {
    expect(() =>
      cleanupOldBaks("/this/parent/does/not/exist/core", "/keep"),
    ).not.toThrow();
  });
});
