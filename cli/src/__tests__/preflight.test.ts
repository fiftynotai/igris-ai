/**
 * preflight — `detectInstallShape` matrix (BR-103).
 *
 * The shape decides whether `init --upgrade` / `refresh` may swap core/. Before
 * BR-103 ANY `core.new.*` or `core.bak.*` sibling read as `interrupted`, which
 * made every second upgrade print a false "Detected interrupted state" error
 * (atomicSwap KEEPS one bak on purpose) — and init then ignored its own error.
 * The honest definition (plan Finding 3, decision D-2):
 *
 *   core.new.* present                    → interrupted-staging  (refuse)
 *   core.bak.* present AND core/ absent   → interrupted-swap     (refuse, restore hint)
 *   core/ present (bak or not)            → v7 / v6, with retainedBaks listed
 *   nothing                               → absent
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
let prevBrainDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "igris-preflight-"));
  prevBrainDir = process.env.IGRIS_BRAIN_DIR;
  process.env.IGRIS_BRAIN_DIR = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (prevBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = prevBrainDir;
});

function core(): void {
  mkdirSync(join(root, "core", "hooks"), { recursive: true });
  writeFileSync(join(root, "core", "hooks", "canonical-settings.json"), "{}\n");
}
function record(): void {
  writeFileSync(join(root, ".install-source.json"), "{}\n");
}
function bak(name = "core.bak.2026-01-01T00-00-00-000Z"): void {
  mkdirSync(join(root, name), { recursive: true });
}
function staging(name = "core.new.4242"): void {
  mkdirSync(join(root, name), { recursive: true });
}

describe("detectInstallShape — the {core, bak, new} × presence matrix (BR-103)", () => {
  it("no brain dir → absent", async () => {
    const { detectInstallShape } = await import("../lib/preflight.js");
    rmSync(root, { recursive: true, force: true });
    expect(detectInstallShape()).toEqual({ kind: "absent" });
  });

  it("brain dir, no core/ → absent", async () => {
    const { detectInstallShape } = await import("../lib/preflight.js");
    expect(detectInstallShape()).toEqual({ kind: "absent" });
  });

  it("core/ + record, no siblings → v7 with an empty retainedBaks", async () => {
    const { detectInstallShape } = await import("../lib/preflight.js");
    core();
    record();
    const shape = detectInstallShape();
    expect(shape.kind).toBe("v7");
    expect(shape.kind === "v7" && shape.retainedBaks).toEqual([]);
  });

  it("core/ without a record → v6", async () => {
    const { detectInstallShape } = await import("../lib/preflight.js");
    core();
    expect(detectInstallShape().kind).toBe("v6");
  });

  it("core/ + record + ONE retained core.bak.* → v7 (healthy), the bak LISTED not flagged", async () => {
    const { detectInstallShape } = await import("../lib/preflight.js");
    core();
    record();
    bak();
    const shape = detectInstallShape();
    expect(shape.kind).toBe("v7");
    expect(shape.kind === "v7" && shape.retainedBaks).toEqual([
      join(root, "core.bak.2026-01-01T00-00-00-000Z"),
    ]);
  });

  it("core.bak.* present AND core/ absent → interrupted-swap naming the bak(s)", async () => {
    const { detectInstallShape } = await import("../lib/preflight.js");
    record();
    bak();
    const shape = detectInstallShape();
    expect(shape.kind).toBe("interrupted-swap");
    expect(shape.kind === "interrupted-swap" && shape.baks).toEqual([
      join(root, "core.bak.2026-01-01T00-00-00-000Z"),
    ]);
  });

  it("core.new.* residue (with a healthy core/) → interrupted-staging naming the residue", async () => {
    const { detectInstallShape } = await import("../lib/preflight.js");
    core();
    record();
    staging();
    const shape = detectInstallShape();
    expect(shape.kind).toBe("interrupted-staging");
    expect(shape.kind === "interrupted-staging" && shape.residue).toEqual([
      join(root, "core.new.4242"),
    ]);
  });

  it("core.new.* residue wins over a retained bak (both present, core/ present) — and the bak is still listed", async () => {
    const { detectInstallShape } = await import("../lib/preflight.js");
    core();
    record();
    staging();
    bak();
    const shape = detectInstallShape();
    expect(shape.kind).toBe("interrupted-staging");
    expect(shape.kind === "interrupted-staging" && shape.retainedBaks).toEqual([
      join(root, "core.bak.2026-01-01T00-00-00-000Z"),
    ]);
  });

  it("core.new.* residue with NO core/ → interrupted-staging (the residue is the actionable fact)", async () => {
    const { detectInstallShape } = await import("../lib/preflight.js");
    staging();
    expect(detectInstallShape().kind).toBe("interrupted-staging");
  });
});

describe("resolveInterruptedShape — the one policy init --upgrade and refresh share (BR-103)", () => {
  it("interrupted-swap refuses with the restore command and touches nothing", async () => {
    const { detectInstallShape, resolveInterruptedShape } = await import("../lib/preflight.js");
    record();
    bak();
    const v = resolveInterruptedShape(detectInstallShape(), { wipeOrphans: true });
    expect(v.verdict).toBe("refuse");
    expect(v.verdict === "refuse" && v.message).toContain(
      `mv ${join(root, "core.bak.2026-01-01T00-00-00-000Z")} ${join(root, "core")}`,
    );
    expect(existsSync(join(root, "core.bak.2026-01-01T00-00-00-000Z"))).toBe(true);
  });

  it("interrupted-staging refuses without --wipe-orphans and keeps the residue", async () => {
    const { detectInstallShape, resolveInterruptedShape } = await import("../lib/preflight.js");
    core();
    record();
    staging();
    const v = resolveInterruptedShape(detectInstallShape(), { wipeOrphans: false });
    expect(v.verdict).toBe("refuse");
    expect(existsSync(join(root, "core.new.4242"))).toBe(true);
  });

  it("--wipe-orphans removes ONLY the residue beside a healthy core/ and proceeds (wiped)", async () => {
    const { detectInstallShape, resolveInterruptedShape } = await import("../lib/preflight.js");
    core();
    record();
    staging();
    bak();
    const v = resolveInterruptedShape(detectInstallShape(), { wipeOrphans: true });
    expect(v).toEqual({ verdict: "wiped", removed: [join(root, "core.new.4242")] });
    expect(existsSync(join(root, "core.new.4242"))).toBe(false);
    expect(existsSync(join(root, "core.bak.2026-01-01T00-00-00-000Z"))).toBe(true);
    expect(existsSync(join(root, "core"))).toBe(true);
  });

  // Warden round 1: residue is reported first, so it masked a swap that ALSO
  // died. Before the fix the wipe returned "wiped" and both verbs went on to
  // atomicSwap over an absent core/ with the bak left orphaned.
  it("--wipe-orphans that uncovers core/ ABSENT + core.bak.* refuses with the restore command (residue gone, bak kept)", async () => {
    const { detectInstallShape, resolveInterruptedShape } = await import("../lib/preflight.js");
    record();
    staging();
    bak();
    const v = resolveInterruptedShape(detectInstallShape(), { wipeOrphans: true });
    expect(v.verdict).toBe("refuse");
    expect(v.verdict === "refuse" && v.message).toContain("Removed staging residue");
    expect(v.verdict === "refuse" && v.message).toMatch(/Nothing else was written\.$/);
    expect(v.verdict === "refuse" && v.message).toContain(
      `mv ${join(root, "core.bak.2026-01-01T00-00-00-000Z")} ${join(root, "core")}`,
    );
    expect(existsSync(join(root, "core.new.4242"))).toBe(false);
    expect(existsSync(join(root, "core.bak.2026-01-01T00-00-00-000Z"))).toBe(true);
    expect(existsSync(join(root, "core"))).toBe(false);
  });
});
