/**
 * from-source.ts tests — M1.6.
 *
 * Real fs against tmp; no mocks.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyFromSource,
  FromSourceError,
} from "../lib/from-source.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "igris-from-source-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function stageRepo(contents: Record<string, string>): string {
  const repoRoot = join(workDir, "repo");
  mkdirSync(join(repoRoot, "core"), { recursive: true });
  for (const [rel, body] of Object.entries(contents)) {
    const abs = join(repoRoot, "core", rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return repoRoot;
}

describe("from-source — clean copy", () => {
  it("copies all files from source/core/ → dest/core/ with byte equality", () => {
    const source = stageRepo({
      "SOUL.md": "# soul\n",
      "agents/forger.md": "# forger\n",
      // FR-187: the layered core/os/ set replaces the retired universal rule.
      "os/standards.md": "# standards\n",
      "skills/demo/SKILL.md": "# skill\n",
    });
    const dest = join(workDir, "stage");
    const r = copyFromSource({ sourcePath: source, destPath: dest });
    expect(r.fileCount).toBe(4);
    expect(readFileSync(join(dest, "core", "SOUL.md"), "utf-8")).toBe(
      "# soul\n",
    );
    expect(readFileSync(join(dest, "core", "agents", "forger.md"), "utf-8")).toBe(
      "# forger\n",
    );
    expect(
      readFileSync(join(dest, "core", "skills", "demo", "SKILL.md"), "utf-8"),
    ).toBe("# skill\n");
  });

  it("preserves nested directory structure", () => {
    const source = stageRepo({
      "scripts/cli-adapters/_common.sh": "common\n",
      "scripts/cli-adapters/md_to_agents_md.sh": "adapter\n",
    });
    const dest = join(workDir, "stage");
    copyFromSource({ sourcePath: source, destPath: dest });
    expect(
      existsSync(
        join(dest, "core", "scripts", "cli-adapters", "_common.sh"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          dest,
          "core",
          "scripts",
          "cli-adapters",
          "md_to_agents_md.sh",
        ),
      ),
    ).toBe(true);
  });

  it("creates dest dir if missing", () => {
    const source = stageRepo({ "SOUL.md": "x\n" });
    const dest = join(workDir, "deeply", "nested", "stage");
    expect(existsSync(dest)).toBe(false);
    copyFromSource({ sourcePath: source, destPath: dest });
    expect(existsSync(join(dest, "core", "SOUL.md"))).toBe(true);
  });
});

describe("from-source — error paths", () => {
  it("errors when source/core does not exist", () => {
    const source = join(workDir, "no-core-here");
    mkdirSync(source, { recursive: true });
    const dest = join(workDir, "stage");
    expect(() => copyFromSource({ sourcePath: source, destPath: dest })).toThrow(
      FromSourceError,
    );
  });

  it("errors when source/core is a file, not a dir", () => {
    const source = join(workDir, "fake-repo");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "core"), "not a dir");
    const dest = join(workDir, "stage");
    expect(() => copyFromSource({ sourcePath: source, destPath: dest })).toThrow(
      FromSourceError,
    );
  });

  it("errors when source/core is empty (refusing to stage an empty brain)", () => {
    const source = join(workDir, "empty-repo");
    mkdirSync(join(source, "core"), { recursive: true });
    const dest = join(workDir, "stage");
    expect(() => copyFromSource({ sourcePath: source, destPath: dest })).toThrow(
      /empty brain/i,
    );
  });

  it("skips symlinks gracefully (does not crash)", () => {
    const source = stageRepo({ "SOUL.md": "x\n" });
    // Add a symlink alongside the file.
    symlinkSync("SOUL.md", join(source, "core", "SOUL.symlink"));
    const dest = join(workDir, "stage");
    const r = copyFromSource({ sourcePath: source, destPath: dest });
    // Only the regular file is counted.
    expect(r.fileCount).toBe(1);
    expect(existsSync(join(dest, "core", "SOUL.symlink"))).toBe(false);
  });
});

describe("from-source — verify_mirror semantics", () => {
  it("byte equality holds on a binary-ish file (round-trip a buffer of high bytes)", () => {
    const source = join(workDir, "binary-repo");
    mkdirSync(join(source, "core"), { recursive: true });
    const buf = Buffer.from(
      Array.from({ length: 256 }, (_, i) => i & 0xff),
    );
    writeFileSync(join(source, "core", "binary.bin"), buf);
    const dest = join(workDir, "stage");
    const r = copyFromSource({ sourcePath: source, destPath: dest });
    expect(r.fileCount).toBe(1);
    const out = readFileSync(join(dest, "core", "binary.bin"));
    expect(out.equals(buf)).toBe(true);
  });
});
