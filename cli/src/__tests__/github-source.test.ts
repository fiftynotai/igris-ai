/**
 * FR-148 github-source unit tests — the pure-logic boundary.
 *
 * Covers the spec parser grammar, the semver/release-tag freshness comparator,
 * the repo-manifest read+validate, and surface selection. NO network, NO SUT
 * (`runLoadout`) — these exercise the exported pure functions directly
 * (L-159/L-173: stub the fetch boundary, never mock the module under test;
 * here there is no fetch at all — the functions are deterministic).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGithubSpec,
  parseSemver,
  compareSemver,
  pickNewerReleaseTag,
  readRepoManifest,
  selectSurface,
  isGithubSpec,
  type RepoManifest,
} from "../lib/github-source.js";

// ---------------------------------------------------------------------------
// parseGithubSpec — grammar
// ---------------------------------------------------------------------------

describe("parseGithubSpec", () => {
  it("parses the happy path without subdir", () => {
    const spec = parseGithubSpec("github:fiftynotai/igris-ai@v7.0.0");
    expect(spec).toEqual({ owner: "fiftynotai", repo: "igris-ai", ref: "v7.0.0" });
  });

  it("parses with a #subdir", () => {
    const spec = parseGithubSpec("github:owner/repo@main#packs/agents");
    expect(spec).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      subdir: "packs/agents",
    });
  });

  it("accepts a full SHA ref", () => {
    const spec = parseGithubSpec(
      "github:owner/repo@0123456789abcdef0123456789abcdef01234567",
    );
    expect(typeof spec).not.toBe("string");
    if (typeof spec !== "string") {
      expect(spec.ref).toBe("0123456789abcdef0123456789abcdef01234567");
    }
  });

  it("trims surrounding whitespace", () => {
    const spec = parseGithubSpec("  github:owner/repo@v1.0.0  ");
    expect(spec).toEqual({ owner: "owner", repo: "repo", ref: "v1.0.0" });
  });

  it("rejects a missing @ref", () => {
    const err = parseGithubSpec("github:owner/repo");
    expect(typeof err).toBe("string");
    expect(err).toMatch(/must pin a ref/);
  });

  it("rejects an empty ref", () => {
    const err = parseGithubSpec("github:owner/repo@");
    expect(err).toMatch(/ref cannot be empty/);
  });

  it("rejects a missing repo (no slash)", () => {
    const err = parseGithubSpec("github:owner@v1.0.0");
    expect(err).toMatch(/must be github:owner\/repo/);
  });

  it("rejects an empty owner", () => {
    const err = parseGithubSpec("github:/repo@v1.0.0");
    expect(err).toMatch(/owner\/repo cannot be empty/);
  });

  it("rejects an empty repo", () => {
    const err = parseGithubSpec("github:owner/@v1.0.0");
    expect(err).toMatch(/owner\/repo cannot be empty/);
  });

  it("rejects a subdir with a leading slash", () => {
    const err = parseGithubSpec("github:owner/repo@main#/abs");
    expect(err).toMatch(/relative path without '\.\.'/);
  });

  it("rejects a subdir containing ..", () => {
    const err = parseGithubSpec("github:owner/repo@main#a/../b");
    expect(err).toMatch(/relative path without '\.\.'/);
  });

  it("rejects a non-github scheme", () => {
    const err = parseGithubSpec("/local/path");
    expect(err).toMatch(/must start with 'github:'/);
  });

  it("rejects internal whitespace in the ref", () => {
    const err = parseGithubSpec("github:owner/repo@v1 .0.0");
    expect(err).toMatch(/whitespace/);
  });
});

describe("isGithubSpec", () => {
  it("recognizes a github spec", () => {
    expect(isGithubSpec("github:owner/repo@main")).toBe(true);
  });
  it("treats a plain path as not-github", () => {
    expect(isGithubSpec("/abs/path")).toBe(false);
    expect(isGithubSpec("./rel")).toBe(false);
    expect(isGithubSpec("~/home")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseSemver / compareSemver
// ---------------------------------------------------------------------------

describe("parseSemver", () => {
  it("parses with a leading v", () => {
    expect(parseSemver("v7.0.0")).toEqual({
      major: 7,
      minor: 0,
      patch: 0,
      pre: [],
    });
  });
  it("parses without a leading v", () => {
    expect(parseSemver("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      pre: [],
    });
  });
  it("parses a prerelease", () => {
    expect(parseSemver("1.2.3-rc.1")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      pre: ["rc", 1],
    });
  });
  it("returns null for a branch name", () => {
    expect(parseSemver("main")).toBeNull();
  });
  it("returns null for a raw sha", () => {
    expect(parseSemver("abc123")).toBeNull();
  });
  it("ignores build metadata", () => {
    expect(parseSemver("1.2.3+build.5")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      pre: [],
    });
  });
});

describe("compareSemver", () => {
  const sv = (s: string) => parseSemver(s)!;
  it("orders by major", () => {
    expect(compareSemver(sv("2.0.0"), sv("1.9.9"))).toBeGreaterThan(0);
  });
  it("orders by minor", () => {
    expect(compareSemver(sv("1.2.0"), sv("1.1.9"))).toBeGreaterThan(0);
  });
  it("orders by patch", () => {
    expect(compareSemver(sv("1.0.2"), sv("1.0.1"))).toBeGreaterThan(0);
  });
  it("treats equal as 0", () => {
    expect(compareSemver(sv("1.0.0"), sv("1.0.0"))).toBe(0);
  });
  it("ranks a prerelease below its release", () => {
    expect(compareSemver(sv("1.0.0-rc.1"), sv("1.0.0"))).toBeLessThan(0);
  });
  it("orders prerelease identifiers", () => {
    expect(compareSemver(sv("1.0.0-rc.2"), sv("1.0.0-rc.1"))).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// pickNewerReleaseTag
// ---------------------------------------------------------------------------

describe("pickNewerReleaseTag", () => {
  it("picks the highest tag strictly newer than a semver pin", () => {
    const r = pickNewerReleaseTag("v1.0.0", ["v1.0.0", "v1.1.0", "v0.9.0"]);
    expect(r).toEqual({ tag: "v1.1.0", mode: "semver" });
  });

  it("returns null when the pin is already the newest", () => {
    expect(pickNewerReleaseTag("v2.0.0", ["v1.0.0", "v2.0.0"])).toBeNull();
  });

  it("returns null when no tag is newer", () => {
    expect(pickNewerReleaseTag("v2.0.0", ["v1.0.0"])).toBeNull();
  });

  it("returns null for an empty tag list", () => {
    expect(pickNewerReleaseTag("v1.0.0", [])).toBeNull();
  });

  it("uses non-semver-pin mode when the pin is a branch", () => {
    const r = pickNewerReleaseTag("main", ["v1.0.0", "v1.1.0"]);
    expect(r).toEqual({ tag: "v1.1.0", mode: "non-semver-pin" });
  });

  it("returns null when a non-semver pin equals the only semver tag", () => {
    // pin is non-semver, best semver tag is v1.0.0 (!= 'main') → update.
    const r = pickNewerReleaseTag("main", ["v1.0.0"]);
    expect(r).toEqual({ tag: "v1.0.0", mode: "non-semver-pin" });
  });

  it("returns null when no candidate tag is parseable as semver", () => {
    expect(pickNewerReleaseTag("main", ["nightly", "latest"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readRepoManifest + selectSurface (over staged fixture repo dirs)
// ---------------------------------------------------------------------------

describe("readRepoManifest + selectSurface", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "igris-gh-src-"));
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  function writeManifest(manifest: unknown): void {
    writeFileSync(join(repoDir, "igris.json"), JSON.stringify(manifest));
  }

  const singleAgentManifest: RepoManifest = {
    version: 1,
    agents: [
      {
        name: "mypack",
        canonical: { dir: "agents", versioned: false, file: "mypack.md" },
        targets: [{ type: "claude", path: ".claude/agents/mypack.md" }],
      },
    ],
  };

  it("reads igris.json and validates it", () => {
    writeManifest(singleAgentManifest);
    const m = readRepoManifest(repoDir);
    expect(typeof m).not.toBe("string");
  });

  it("falls back to .igris/manifest.json", () => {
    mkdirSync(join(repoDir, ".igris"), { recursive: true });
    writeFileSync(
      join(repoDir, ".igris", "manifest.json"),
      JSON.stringify(singleAgentManifest),
    );
    const m = readRepoManifest(repoDir);
    expect(typeof m).not.toBe("string");
  });

  it("errors when no manifest is present", () => {
    const m = readRepoManifest(repoDir);
    expect(typeof m).toBe("string");
    expect(m).toMatch(/no manifest/);
  });

  it("rejects a bad repo manifest (invalid shape)", () => {
    writeManifest({ version: 2, agents: [] }); // version must be 1
    const m = readRepoManifest(repoDir);
    expect(typeof m).toBe("string");
    expect(m).toMatch(/is invalid/);
  });

  it("rejects non-JSON", () => {
    writeFileSync(join(repoDir, "igris.json"), "{not json");
    const m = readRepoManifest(repoDir);
    expect(typeof m).toBe("string");
    expect(m).toMatch(/not valid JSON/);
  });

  it("selectSurface auto-selects the single entry", () => {
    mkdirSync(join(repoDir, "agents"), { recursive: true });
    writeFileSync(join(repoDir, "agents", "mypack.md"), "# body\n");
    const selected = selectSurface(
      singleAgentManifest,
      "anything",
      repoDir,
      undefined,
    );
    expect(typeof selected).not.toBe("string");
    if (typeof selected !== "string") {
      expect(selected.entry.name).toBe("mypack");
      expect(selected.files).toEqual(["mypack.md"]);
    }
  });

  it("selectSurface name-matches in a multi-entry manifest", () => {
    const multi: RepoManifest = {
      version: 1,
      agents: [
        {
          name: "alpha",
          canonical: { dir: "a", versioned: false, file: "alpha.md" },
          targets: [{ type: "claude", path: ".claude/agents/alpha.md" }],
        },
        {
          name: "beta",
          canonical: { dir: "b", versioned: false, file: "beta.md" },
          targets: [{ type: "claude", path: ".claude/agents/beta.md" }],
        },
      ],
    };
    mkdirSync(join(repoDir, "b"), { recursive: true });
    writeFileSync(join(repoDir, "b", "beta.md"), "# beta\n");
    const selected = selectSurface(multi, "beta", repoDir, undefined);
    expect(typeof selected).not.toBe("string");
    if (typeof selected !== "string") {
      expect(selected.entry.name).toBe("beta");
    }
  });

  it("selectSurface errors when name matches none in a multi-entry manifest", () => {
    const multi: RepoManifest = {
      version: 1,
      agents: [
        {
          name: "alpha",
          canonical: { dir: "a", versioned: false, file: "alpha.md" },
          targets: [{ type: "claude", path: ".claude/agents/alpha.md" }],
        },
        {
          name: "beta",
          canonical: { dir: "b", versioned: false, file: "beta.md" },
          targets: [{ type: "claude", path: ".claude/agents/beta.md" }],
        },
      ],
    };
    const selected = selectSurface(multi, "gamma", repoDir, undefined);
    expect(typeof selected).toBe("string");
    expect(selected).toMatch(/no agent named 'gamma'/);
    expect(selected).toMatch(/alpha, beta/);
  });

  it("selectSurface resolves the canonical dir under a #subdir", () => {
    mkdirSync(join(repoDir, "packs", "agents"), { recursive: true });
    writeFileSync(join(repoDir, "packs", "agents", "mypack.md"), "# body\n");
    const selected = selectSurface(
      singleAgentManifest,
      "mypack",
      repoDir,
      "packs",
    );
    expect(typeof selected).not.toBe("string");
    if (typeof selected !== "string") {
      expect(selected.srcDir).toBe(join(repoDir, "packs", "agents"));
      expect(existsSync(join(selected.srcDir, "mypack.md"))).toBe(true);
    }
  });

  it("selectSurface rejects a canonical.dir that escapes the repo root", () => {
    const malicious: RepoManifest = {
      version: 1,
      agents: [
        {
          name: "evil",
          canonical: { dir: "../../../etc", versioned: false, file: "passwd" },
          targets: [{ type: "claude", path: ".claude/agents/evil.md" }],
        },
      ],
    };
    const selected = selectSurface(malicious, "evil", repoDir, undefined);
    expect(typeof selected).toBe("string");
    expect(selected).toMatch(/escapes the repo root/);
  });

  it("selectSurface rejects a canonical.file that escapes the surface dir", () => {
    mkdirSync(join(repoDir, "agents"), { recursive: true });
    const malicious: RepoManifest = {
      version: 1,
      agents: [
        {
          name: "evil",
          canonical: { dir: "agents", versioned: false, file: "../../passwd" },
          targets: [{ type: "claude", path: ".claude/agents/evil.md" }],
        },
      ],
    };
    const selected = selectSurface(malicious, "evil", repoDir, undefined);
    expect(typeof selected).toBe("string");
    expect(selected).toMatch(/escapes the surface dir/);
  });

  it("selectSurface rejects an absolute canonical.dir", () => {
    const malicious: RepoManifest = {
      version: 1,
      agents: [
        {
          name: "evil",
          canonical: { dir: "/etc", versioned: false, file: "passwd" },
          targets: [{ type: "claude", path: ".claude/agents/evil.md" }],
        },
      ],
    };
    const selected = selectSurface(malicious, "evil", repoDir, undefined);
    expect(typeof selected).toBe("string");
    expect(selected).toMatch(/escapes the repo root/);
  });

  it("selectSurface rejects a symlinked canonical.dir pointing outside the repo", () => {
    // Materialize a symlink `agents -> <outside>` inside the repo dir (this is
    // what the gh/git clone tiers would do for a repo that checks in such a
    // link). Lexical containment passes (the link's own path is under repo);
    // the realpath guard must catch the dereferenced target.
    const outside = mkdtempSync(join(tmpdir(), "igris-gh-outside-"));
    writeFileSync(join(outside, "secret.md"), "host secret\n");
    try {
      symlinkSync(outside, join(repoDir, "agents"));
    } catch {
      // Some sandboxes disallow symlink creation — skip if so.
      return;
    }
    const manifest: RepoManifest = {
      version: 1,
      agents: [
        {
          name: "evil",
          canonical: { dir: "agents", versioned: false, file: "secret.md" },
          targets: [{ type: "claude", path: ".claude/agents/evil.md" }],
        },
      ],
    };
    const selected = selectSurface(manifest, "evil", repoDir, undefined);
    rmSync(outside, { recursive: true, force: true });
    expect(typeof selected).toBe("string");
    expect(selected).toMatch(/symlink escape/);
  });

  it("selectSurface rejects a symlinked canonical.file pointing outside the repo", () => {
    const outside = mkdtempSync(join(tmpdir(), "igris-gh-outside-"));
    writeFileSync(join(outside, "passwd"), "root:x:0:0\n");
    mkdirSync(join(repoDir, "agents"), { recursive: true });
    try {
      symlinkSync(join(outside, "passwd"), join(repoDir, "agents", "leak.md"));
    } catch {
      return;
    }
    const manifest: RepoManifest = {
      version: 1,
      agents: [
        {
          name: "evil",
          canonical: { dir: "agents", versioned: false, file: "leak.md" },
          targets: [{ type: "claude", path: ".claude/agents/evil.md" }],
        },
      ],
    };
    const selected = selectSurface(manifest, "evil", repoDir, undefined);
    rmSync(outside, { recursive: true, force: true });
    expect(typeof selected).toBe("string");
    expect(selected).toMatch(/symlink escape/);
  });

  it("selectSurface resolves a versioned glob set", () => {
    const versioned: RepoManifest = {
      version: 1,
      agents: [
        {
          name: "vpack",
          canonical: { dir: "v", versioned: true, glob: "v*.md" },
          targets: [{ type: "codex", path: ".codex/agents/vpack.toml" }],
        },
      ],
    };
    mkdirSync(join(repoDir, "v"), { recursive: true });
    writeFileSync(join(repoDir, "v", "v1.md"), "one\n");
    writeFileSync(join(repoDir, "v", "v2.md"), "two\n");
    writeFileSync(join(repoDir, "v", "skip.txt"), "no\n");
    const selected = selectSurface(versioned, "vpack", repoDir, undefined);
    expect(typeof selected).not.toBe("string");
    if (typeof selected !== "string") {
      expect(selected.files.sort()).toEqual(["v1.md", "v2.md"]);
    }
  });
});
