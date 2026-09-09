/**
 * git-hooks.test.ts — FR-243: the pure readers in lib/git-hooks.ts.
 *
 * The installer + doctor classes are exercised end-to-end in bats
 * (install-git-hooks.bats, doctor-drift-classes.bats 9/9b/9c/9d/9e/10). This
 * file pins the three readers whose verdicts those depend on, each against a
 * fixture the OLD code never reads (no seam existed at HEAD — the module is
 * new), so the assertions are about the reader, not about HEAD.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalGitHookSource,
  gitleaksOnPath,
  hooksPathBypasses,
  inspectGitHooks,
  readCoreHooksPath,
} from "../lib/git-hooks.js";

let root: string;
let savedBrainDir: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fr243-")));
  savedBrainDir = process.env.IGRIS_BRAIN_DIR;
  process.env.IGRIS_BRAIN_DIR = join(root, "brain");
  mkdirSync(join(root, "brain", "core", "git-hooks"), { recursive: true });
});

afterEach(() => {
  if (savedBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = savedBrainDir;
  rmSync(root, { recursive: true, force: true });
});

function gitDir(name: string, config: string): string {
  const g = join(root, name, ".git");
  mkdirSync(join(g, "hooks"), { recursive: true });
  writeFileSync(join(g, "config"), config);
  return g;
}

describe("readCoreHooksPath", () => {
  it("reads hooksPath from the [core] section only", () => {
    const g = gitDir("a", "[core]\n\trepositoryformatversion = 0\n\thooksPath = .husky\n[remote \"origin\"]\n\thooksPath = nope\n");
    expect(readCoreHooksPath(g)).toBe(".husky");
  });
  it("is null when unset or when the config is absent", () => {
    expect(readCoreHooksPath(gitDir("b", "[core]\n\tbare = false\n"))).toBeNull();
    expect(readCoreHooksPath(join(root, "no-such-dir"))).toBeNull();
  });
  it("is case-insensitive on the key (git normalises it)", () => {
    expect(readCoreHooksPath(gitDir("c", "[core]\n\thookspath = /x/y\n"))).toBe("/x/y");
  });
});

describe("hooksPathBypasses", () => {
  it("a hooksPath that resolves to .git/hooks itself (absolute or relative) is NOT a bypass", () => {
    const g = gitDir("d", "[core]\n");
    expect(hooksPathBypasses(g, join(g, "hooks"))).toBe(false);
    expect(hooksPathBypasses(g, ".git/hooks")).toBe(false);
    expect(hooksPathBypasses(g, ".git/../.git/hooks")).toBe(false);
  });
  it("anywhere else IS a bypass, whether or not the target exists", () => {
    const g = gitDir("e", "[core]\n");
    mkdirSync(join(root, "e", ".husky"));
    expect(hooksPathBypasses(g, ".husky")).toBe(true);
    expect(hooksPathBypasses(g, "/nonexistent/hooks")).toBe(true);
  });
});

describe("canonicalGitHookSource", () => {
  it("prefers the repo copy ONLY on the igris-ai checkout (core/git-hooks + harness-manifest.json)", () => {
    const repo = join(root, "igris");
    mkdirSync(join(repo, "core", "git-hooks"), { recursive: true });
    writeFileSync(join(repo, "core", "git-hooks", "pre-commit"), "#!/bin/bash\n");
    // no manifest yet → the mirror
    expect(canonicalGitHookSource("pre-commit", { projectPath: repo })).toBe(
      join(root, "brain", "core", "git-hooks", "pre-commit"),
    );
    writeFileSync(join(repo, "harness-manifest.json"), "{}\n");
    expect(canonicalGitHookSource("pre-commit", { projectPath: repo })).toBe(
      join(repo, "core", "git-hooks", "pre-commit"),
    );
  });
});

describe("gitleaksOnPath", () => {
  it("is PATH presence of an EXECUTABLE file — a non-executable file does not count", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    expect(gitleaksOnPath({ PATH: bin })).toBe(false);
    writeFileSync(join(bin, "gitleaks"), "#!/bin/sh\n");
    chmodSync(join(bin, "gitleaks"), 0o644);
    expect(gitleaksOnPath({ PATH: bin })).toBe(false);
    chmodSync(join(bin, "gitleaks"), 0o755);
    expect(gitleaksOnPath({ PATH: `${join(root, "empty")}:${bin}` })).toBe(true);
    expect(gitleaksOnPath({ PATH: "" })).toBe(false);
  });
});

describe("inspectGitHooks", () => {
  it("names the cause per hook: absent / foreign / not-executable / installed", () => {
    const g = gitDir("f", "[core]\n");
    const mirror = join(root, "brain", "core", "git-hooks");
    writeFileSync(join(mirror, "pre-commit"), "#!/bin/bash\n");
    writeFileSync(join(mirror, "commit-msg"), "#!/bin/bash\n");
    chmodSync(join(mirror, "pre-commit"), 0o755);
    chmodSync(join(mirror, "commit-msg"), 0o644);
    const proj = join(root, "f");
    let insp = inspectGitHooks(proj);
    expect(insp.kind).toBe("ok");
    if (insp.kind !== "ok") return;
    expect(insp.hooks.map((h) => h.state)).toEqual(["absent", "absent"]);

    writeFileSync(join(g, "hooks", "pre-commit"), "#!/bin/sh\necho mine\n");
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    symlinkSync(join(mirror, "commit-msg"), join(g, "hooks", "commit-msg"));
    insp = inspectGitHooks(proj);
    if (insp.kind !== "ok") return;
    expect(insp.hooks[0].state).toBe("foreign");
    expect(insp.hooks[1].state).toBe("not-executable");
    expect(insp.hooks[1].reason).toContain("target not executable");

    chmodSync(join(mirror, "commit-msg"), 0o755);
    insp = inspectGitHooks(proj);
    if (insp.kind !== "ok") return;
    expect(insp.hooks[1].state).toBe("installed");
  });
  it("a worktree (.git is a file) and a non-repo yield no per-hook verdict", () => {
    mkdirSync(join(root, "wt"));
    writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere\n");
    expect(inspectGitHooks(join(root, "wt")).kind).toBe("worktree");
    mkdirSync(join(root, "plain"));
    expect(inspectGitHooks(join(root, "plain")).kind).toBe("not-git");
  });
});
