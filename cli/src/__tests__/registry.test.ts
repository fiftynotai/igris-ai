/**
 * Registry tests — Phase 4.
 *
 * Real `better-sqlite3` against a sandboxed brain DB (IGRIS_BRAIN_DIR set to
 * a tmp dir). No mocks of the module under test; only `paths` is sandboxed
 * via env override (the supported boundary for tests).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-registry-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  // Force module reload to pick up the new env var on each test.
  await reloadModules();
});

afterEach(() => {
  // Close any open DB before nuking the tmpdir.
  void getRegistryModule().then((m) => m.closeDb());
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
});

async function reloadModules(): Promise<void> {
  // Dynamic import w/ cache-bust: vitest re-evaluates the module.
  // A simpler approach: the registry module reads paths via brainDbPath() per
  // call, but caches the open DB handle keyed by path. Since each test gets a
  // fresh tmpRoot, the handle naturally rotates. We just need to call closeDb
  // between tests (done in afterEach).
  await Promise.resolve();
}

async function getRegistryModule(): Promise<typeof import("../lib/registry.js")> {
  return await import("../lib/registry.js");
}

describe("registry — better-sqlite3 direct (D-4)", () => {
  it("listProjects returns [] on empty DB", async () => {
    const reg = await getRegistryModule();
    expect(reg.listProjects()).toEqual([]);
  });

  it("upsertProject inserts a new row", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "demo",
      name: "demo",
      path: "/tmp/demo",
      tech_stack: "typescript/javascript",
      igris_version: "7.0.0",
    });
    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe("demo");
    expect(rows[0].path).toBe("/tmp/demo");
    expect(rows[0].tech_stack).toBe("typescript/javascript");
    expect(rows[0].igris_version).toBe("7.0.0");
  });

  it("upsertProject updates path on conflict (idempotence)", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "demo",
      name: "demo",
      path: "/tmp/demo-old",
      tech_stack: "go",
      igris_version: "7.0.0",
    });
    reg.upsertProject({
      slug: "demo",
      name: "demo",
      path: "/tmp/demo-new",
      tech_stack: "go",
      igris_version: "7.0.1",
    });
    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].path).toBe("/tmp/demo-new");
    expect(rows[0].igris_version).toBe("7.0.1");
  });

  it("explicit slug differs from basename — both become rows", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "fifty-dev",
      name: "fifty-dev",
      path: "/tmp/igris-test-fifty_dev",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    reg.upsertProject({
      slug: "fifty_dev",
      name: "fifty_dev",
      path: "/tmp/igris-test-fifty_dev",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const rows = reg.listProjects();
    expect(rows.length).toBe(2);
    const slugs = rows.map((r) => r.slug).sort();
    expect(slugs).toEqual(["fifty-dev", "fifty_dev"]);
    // Both point at the same path — this is the duplicate-path drift class.
    expect(rows[0].path).toBe("/tmp/igris-test-fifty_dev");
    expect(rows[1].path).toBe("/tmp/igris-test-fifty_dev");
  });

  it("deleteProjectRow removes only the named row", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "alpha",
      name: "alpha",
      path: "/tmp/a",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    reg.upsertProject({
      slug: "beta",
      name: "beta",
      path: "/tmp/b",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    reg.deleteProjectRow("alpha");
    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe("beta");
  });

  it("listProjects returns rows in slug order", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "zebra",
      name: "zebra",
      path: "/tmp/z",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    reg.upsertProject({
      slug: "alpha",
      name: "alpha",
      path: "/tmp/a",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    reg.upsertProject({
      slug: "mike",
      name: "mike",
      path: "/tmp/m",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const rows = reg.listProjects();
    expect(rows.map((r) => r.slug)).toEqual(["alpha", "mike", "zebra"]);
  });
});
