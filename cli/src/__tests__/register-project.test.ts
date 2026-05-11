/**
 * register-project tests — Phase 3 (M3).
 *
 * Same pattern as registry.test.ts: real better-sqlite3 against a sandboxed
 * brain (IGRIS_BRAIN_DIR=tmp). No mocks of the module under test.
 *
 * AC coverage:
 *   - existing path: registers row, exit 0
 *   - missing path with --allow-missing-path: registers row, exit 0
 *   - missing path without flag: errors, exit 1, no row
 *   - --slug grammar: invalid slug throws
 *   - idempotent re-run: same slug+path twice → single row
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

let tmpRoot: string;
const projectDirs: string[] = [];

function stageProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "igris-cli-regproj-proj-"));
  projectDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-regproj-brain-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  const reg = await import("../lib/registry.js");
  reg.closeDb();
});

afterEach(async () => {
  const reg = await import("../lib/registry.js");
  reg.closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
  for (const d of projectDirs) rmSync(d, { recursive: true, force: true });
  projectDirs.length = 0;
  delete process.env.IGRIS_BRAIN_DIR;
});

describe("register-project verb", () => {
  it("registers an existing path: writes registry row, exit 0", async () => {
    const { runRegisterProject } = await import("../verbs/register-project.js");
    const reg = await import("../lib/registry.js");

    const proj = stageProject();
    const code = await runRegisterProject({ path: proj });
    expect(code).toBe(0);

    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe(basename(proj));
    expect(rows[0].path).toBe(proj);
  });

  it("--allow-missing-path: registers a non-existent path, exit 0", async () => {
    const { runRegisterProject } = await import("../verbs/register-project.js");
    const reg = await import("../lib/registry.js");

    const ghostPath = "/this/path/does/not/exist/for/sure/12345";
    const code = await runRegisterProject({
      path: ghostPath,
      slug: "ghost-project",
      allowMissingPath: true,
    });
    expect(code).toBe(0);

    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe("ghost-project");
    expect(rows[0].path).toBe(ghostPath);
  });

  it("missing path without --allow-missing-path: exit 1, no row written", async () => {
    const { runRegisterProject } = await import("../verbs/register-project.js");
    const reg = await import("../lib/registry.js");

    const ghostPath = "/this/path/does/not/exist/for/sure/67890";
    const code = await runRegisterProject({
      path: ghostPath,
      slug: "would-be-ghost",
    });
    expect(code).toBe(1);

    const rows = reg.listProjects();
    expect(rows.length).toBe(0);
  });

  it("--slug grammar: rejects invalid slug with throw", async () => {
    const { runRegisterProject } = await import("../verbs/register-project.js");

    const proj = stageProject();
    await expect(
      runRegisterProject({
        path: proj,
        slug: "Invalid Slug With Spaces!",
      }),
    ).rejects.toThrow(/Invalid slug/);
  });

  it("idempotent re-run: same slug+path twice yields a single row", async () => {
    const { runRegisterProject } = await import("../verbs/register-project.js");
    const reg = await import("../lib/registry.js");

    const proj = stageProject();
    const code1 = await runRegisterProject({ path: proj, slug: "alpha" });
    expect(code1).toBe(0);
    const code2 = await runRegisterProject({ path: proj, slug: "alpha" });
    expect(code2).toBe(0);

    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe("alpha");
    expect(rows[0].path).toBe(proj);
  });
});
