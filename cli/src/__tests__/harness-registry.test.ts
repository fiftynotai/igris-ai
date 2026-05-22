/**
 * FR-141/FR-142 registry-verb tests — `igris registry add|list|remove|update`.
 *
 * NOTE on the filename: this is `harness-registry.test.ts`, NOT
 * `registry.test.ts`. The latter is taken by the UNRELATED project-registry
 * SQLite module (`lib/registry.ts`). This file tests the harness-overlay verb
 * at `verbs/registry.ts`.
 *
 * FR-142 COPY-VENDOR MODE: `add` no longer references a live external path; it
 * COPIES the canonical files into a vendored dir and points `canonical.dir` at
 * that copy, recording a typed origin in `origins.json`. `update` re-vendors.
 * The tests therefore stage a REAL source file on disk for every add, assert the
 * vendored copy + the origins entry, and exercise the new `update` action.
 *
 * Boundary-mocking discipline (L-159 / L-173): we NEVER `vi.mock` the module
 * under test. Unit tests use the explicit `opts.overlayPath` / `opts.originsPath`
 * / `opts.vendorDir` seams over a real tmp dir; the integration test uses the
 * `IGRIS_BRAIN_DIR` env sandbox (the seam the REAL bash adapter reads) and runs
 * the actual `compile_harnesses.sh` / `validate_manifest` — no mocked merge.
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
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runRegistry,
  validateAgentEntry,
  validateOverlayShape,
} from "../verbs/registry.js";
import type {
  GithubSpec,
  FetchedRepo,
  FetchRepoFn,
  ListReleasesFn,
} from "../lib/github-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// cli/src/__tests__ -> repo root -> core/scripts/cli-adapters
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const ADAPTER_DIR = join(REPO_ROOT, "core", "scripts", "cli-adapters");
const COMPILE_SH = join(ADAPTER_DIR, "compile_harnesses.sh");
const COMMON_SH = join(ADAPTER_DIR, "_common.sh");
const SCHEMA = join(ADAPTER_DIR, "manifest.schema.json");

let tmpRoot: string;
let overlayPath: string;
let originsPath: string;
let projectRoot: string;
let vendorBase: string;

/** Test-seam vendor-dir resolver: `<vendorBase>/<name>`. */
function vendorDir(name: string): string {
  return join(vendorBase, name);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-harness-registry-"));
  overlayPath = join(tmpRoot, "overlay.json");
  originsPath = join(tmpRoot, "origins.json");
  vendorBase = join(tmpRoot, "registry");
  projectRoot = join(tmpRoot, "proj");
  mkdirSync(projectRoot, { recursive: true });
  // Most add tests need a real unversioned source file at canon/x.md.
  mkdirSync(join(projectRoot, "canon"), { recursive: true });
  writeFileSync(join(projectRoot, "canon", "x.md"), "# x\nbody\n");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function readOverlayFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(overlayPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

function readOriginsFile(): Record<string, { type: string; dir: string; hash: string }> {
  return JSON.parse(readFileSync(originsPath, "utf-8")) as Record<
    string,
    { type: string; dir: string; hash: string }
  >;
}

/** A complete copy-mode add with the common test seams wired. */
function addOpts(extra: Record<string, unknown>): Parameters<typeof runRegistry>[0] {
  return {
    action: "add",
    projectRoot,
    overlayPath,
    originsPath,
    vendorDir,
    ...extra,
  } as Parameters<typeof runRegistry>[0];
}

// ---------------------------------------------------------------------------
// add (copy-vendor)
// ---------------------------------------------------------------------------

describe("registry add", () => {
  it("copies the canonical into the vendored dir + records origin (layer=personal)", async () => {
    const code = await runRegistry(
      addOpts({
        name: "mycustom",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/mycustom.md"],
      }),
    );
    expect(code).toBe(0);
    expect(existsSync(overlayPath)).toBe(true);
    const overlay = readOverlayFile() as {
      version: number;
      agents: { name: string; layer: string; canonical: Record<string, unknown> }[];
    };
    expect(overlay.version).toBe(1);
    expect(overlay.agents).toHaveLength(1);
    expect(overlay.agents[0].name).toBe("mycustom");
    expect(overlay.agents[0].layer).toBe("personal");
    // canonical.dir points at the VENDORED copy (absolute), file preserved.
    expect(overlay.agents[0].canonical.dir).toBe(vendorDir("mycustom"));
    expect(overlay.agents[0].canonical.versioned).toBe(false);
    expect(overlay.agents[0].canonical.file).toBe("x.md");
    expect(validateOverlayShape(overlay)).toBeNull();

    // The vendored copy exists + is byte-equal to the source.
    const vendored = join(vendorDir("mycustom"), "x.md");
    expect(existsSync(vendored)).toBe(true);
    expect(readFileSync(vendored, "utf-8")).toBe(
      readFileSync(join(projectRoot, "canon", "x.md"), "utf-8"),
    );

    // origins.json records a typed path origin pointing at the SOURCE dir.
    const origins = readOriginsFile();
    expect(origins.mycustom.type).toBe("path");
    expect(origins.mycustom.dir).toBe(join(projectRoot, "canon"));
    expect(origins.mycustom.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("--versioned --glob vendors the matching file set (no file in canonical)", async () => {
    mkdirSync(join(projectRoot, "vcanon"), { recursive: true });
    writeFileSync(join(projectRoot, "vcanon", "v1.md"), "one\n");
    writeFileSync(join(projectRoot, "vcanon", "v2.md"), "two\n");
    writeFileSync(join(projectRoot, "vcanon", "skip.txt"), "nope\n");
    const code = await runRegistry(
      addOpts({
        name: "vagent",
        from: "vcanon",
        versioned: true,
        glob: "v*.md",
        targets: ["codex:.codex/agents/vagent.toml"],
      }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      agents: { canonical: Record<string, unknown> }[];
    };
    expect(overlay.agents[0].canonical.dir).toBe(vendorDir("vagent"));
    expect(overlay.agents[0].canonical.versioned).toBe(true);
    expect(overlay.agents[0].canonical.glob).toBe("v*.md");
    expect("file" in overlay.agents[0].canonical).toBe(false);
    // Only the glob-matching files vendored.
    expect(existsSync(join(vendorDir("vagent"), "v1.md"))).toBe(true);
    expect(existsSync(join(vendorDir("vagent"), "v2.md"))).toBe(true);
    expect(existsSync(join(vendorDir("vagent"), "skip.txt"))).toBe(false);
  });

  it("--versioned without --glob is a usage error (exit 2), no vendor dir", async () => {
    const code = await runRegistry(
      addOpts({
        name: "vagent",
        from: "vcanon",
        versioned: true,
        targets: ["codex:.codex/agents/vagent.toml"],
      }),
    );
    expect(code).toBe(2);
    expect(existsSync(overlayPath)).toBe(false);
    expect(existsSync(vendorDir("vagent"))).toBe(false);
  });

  it("--glob without --versioned is a usage error (exit 2), no vendor dir", async () => {
    const code = await runRegistry(
      addOpts({
        name: "agent",
        from: "canon/x.md",
        glob: "v*.md",
        targets: ["claude:.claude/agents/agent.md"],
      }),
    );
    expect(code).toBe(2);
    expect(existsSync(vendorDir("agent"))).toBe(false);
  });

  it("rejects a second add with an existing overlay name (intra-overlay dedupe)", async () => {
    await runRegistry(
      addOpts({
        name: "dup",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/dup.md"],
      }),
    );
    const before = readFileSync(overlayPath, "utf-8");
    const originsBefore = readFileSync(originsPath, "utf-8");
    writeFileSync(join(projectRoot, "canon", "y.md"), "# y\nother\n");
    const code = await runRegistry(
      addOpts({
        name: "dup",
        from: "canon/y.md",
        targets: ["claude:.claude/agents/dup2.md"],
      }),
    );
    expect(code).toBe(1);
    // Overlay + origins byte-unchanged; the first vendor not corrupted.
    expect(readFileSync(overlayPath, "utf-8")).toBe(before);
    expect(readFileSync(originsPath, "utf-8")).toBe(originsBefore);
    // The first vendored copy is intact (still x.md, not overwritten by y.md).
    expect(existsSync(join(vendorDir("dup"), "x.md"))).toBe(true);
    expect(existsSync(join(vendorDir("dup"), "y.md"))).toBe(false);
  });

  it("rejects a name colliding with a base (core) agent, no vendor/origin", async () => {
    writeFileSync(
      join(projectRoot, "harness-manifest.json"),
      JSON.stringify({
        version: 1,
        agents: [
          {
            name: "forger",
            canonical: { dir: "core/agents", versioned: false, file: "forger.md" },
            targets: [{ type: "claude", path: ".claude/agents/forger.md" }],
          },
        ],
      }),
    );
    const code = await runRegistry(
      addOpts({
        name: "forger",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/forger.md"],
      }),
    );
    expect(code).toBe(1);
    expect(existsSync(overlayPath)).toBe(false);
    // Collision is rejected BEFORE vendoring → no orphan copy, no origins entry.
    expect(existsSync(vendorDir("forger"))).toBe(false);
    expect(existsSync(originsPath)).toBe(false);
  });

  it("treats an absent base manifest as no base agents (no hard-fail)", async () => {
    const code = await runRegistry(
      addOpts({
        name: "nobase",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/nobase.md"],
        // no harness-manifest.json written
      }),
    );
    expect(code).toBe(0);
  });

  it("fails (exit 1) when the source file does not exist (nothing to copy)", async () => {
    const code = await runRegistry(
      addOpts({
        name: "ghostsrc",
        from: "canon/missing.md",
        targets: ["claude:.claude/agents/ghostsrc.md"],
      }),
    );
    expect(code).toBe(1);
    expect(existsSync(overlayPath)).toBe(false);
    expect(existsSync(vendorDir("ghostsrc"))).toBe(false);
  });

  it("requires <name>, --from, and --target (usage errors)", async () => {
    expect(
      await runRegistry(
        addOpts({ from: "canon/x.md", targets: ["claude:p"] }),
      ),
    ).toBe(2);
    expect(
      await runRegistry(addOpts({ name: "x", targets: ["claude:p"] })),
    ).toBe(2);
    expect(
      await runRegistry(addOpts({ name: "x", from: "canon/x.md" })),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// --target parsing (still pure parse — must fail fast BEFORE copy on bad input)
// ---------------------------------------------------------------------------

describe("registry add — --target parsing", () => {
  it("parses type:path and supports multiple --target", async () => {
    await runRegistry(
      addOpts({
        name: "multi",
        from: "canon/x.md",
        targets: [
          "codex:.codex/agents/multi.toml",
          "gemini:.gemini/agents/multi.toml",
        ],
      }),
    );
    const overlay = readOverlayFile() as {
      agents: { targets: { type: string; path: string }[] }[];
    };
    expect(overlay.agents[0].targets).toEqual([
      { type: "codex", path: ".codex/agents/multi.toml" },
      { type: "gemini", path: ".gemini/agents/multi.toml" },
    ]);
  });

  it("preserves a path containing ':' (splits on first colon only)", async () => {
    await runRegistry(
      addOpts({
        name: "colon",
        from: "canon/x.md",
        targets: ["claude:dir/with:colon/agent.md"],
      }),
    );
    const overlay = readOverlayFile() as {
      agents: { targets: { type: string; path: string }[] }[];
    };
    expect(overlay.agents[0].targets[0]).toEqual({
      type: "claude",
      path: "dir/with:colon/agent.md",
    });
  });

  it("rejects an unknown target type (exit 2), no vendor dir", async () => {
    const code = await runRegistry(
      addOpts({
        name: "bad",
        from: "canon/x.md",
        targets: ["opencode:.opencode/bad.md"],
      }),
    );
    expect(code).toBe(2);
    expect(existsSync(overlayPath)).toBe(false);
    expect(existsSync(vendorDir("bad"))).toBe(false);
  });

  it("rejects a target with no colon (exit 2), no vendor dir", async () => {
    const code = await runRegistry(
      addOpts({
        name: "bad",
        from: "canon/x.md",
        targets: ["claude-no-colon"],
      }),
    );
    expect(code).toBe(2);
    expect(existsSync(vendorDir("bad"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --canonical deprecated alias
// ---------------------------------------------------------------------------

describe("registry add — --canonical deprecated alias", () => {
  it("the verb still accepts the value via the from field (alias coalesced at CLI)", async () => {
    // The CLI boundary coalesces --canonical into opts.from; the verb itself
    // takes a single `from` field. Assert from works (the alias path is wired
    // in index.ts; this asserts the field the alias maps to).
    const code = await runRegistry(
      addOpts({
        name: "aliased",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/aliased.md"],
      }),
    );
    expect(code).toBe(0);
    expect(existsSync(join(vendorDir("aliased"), "x.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validators (direct) — UNCHANGED under option (b): origin is NOT on the entry
// ---------------------------------------------------------------------------

describe("validateAgentEntry / validateOverlayShape", () => {
  const valid = {
    name: "ok",
    layer: "personal",
    canonical: { dir: "canon", versioned: false, file: "x.md" },
    targets: [{ type: "claude", path: ".claude/agents/ok.md" }],
  };

  it("accepts a well-formed entry", () => {
    expect(validateAgentEntry(valid)).toBeNull();
  });

  it("rejects a bad name pattern", () => {
    expect(validateAgentEntry({ ...valid, name: "Bad_Name" })).toMatch(/name/);
  });

  it("rejects a bad target type", () => {
    expect(
      validateAgentEntry({
        ...valid,
        targets: [{ type: "opencode", path: "x" }],
      }),
    ).toMatch(/not one of/);
  });

  it("rejects versioned-without-glob", () => {
    expect(
      validateAgentEntry({
        ...valid,
        canonical: { dir: "canon", versioned: true },
      }),
    ).toMatch(/requires 'glob'/);
  });

  it("rejects unversioned-without-file", () => {
    expect(
      validateAgentEntry({
        ...valid,
        canonical: { dir: "canon", versioned: false },
      }),
    ).toMatch(/requires 'file'/);
  });

  it("rejects versioned AND file (oneOf)", () => {
    expect(
      validateAgentEntry({
        ...valid,
        canonical: { dir: "canon", versioned: true, glob: "v*.md", file: "x.md" },
      }),
    ).toMatch(/must not set 'file'/);
  });

  it("rejects a stray agent key (origin must NOT live on the entry)", () => {
    expect(validateAgentEntry({ ...valid, extra: 1 })).toMatch(
      /additionalProperties/,
    );
    // option (b): a stray `origin` key on the entry is also rejected.
    expect(
      validateAgentEntry({ ...valid, origin: { type: "path" } }),
    ).toMatch(/additionalProperties/);
  });

  it("rejects empty targets", () => {
    expect(validateAgentEntry({ ...valid, targets: [] })).toMatch(
      /non-empty array/,
    );
  });

  it("overlay: rejects version != 1 and stray top key", () => {
    expect(validateOverlayShape({ version: 2, agents: [] })).toMatch(
      /version/,
    );
    expect(
      validateOverlayShape({ version: 1, agents: [], bogus: 1 }),
    ).toMatch(/additionalProperties/);
  });

  it("overlay: accepts a surfaces block (FR-143 forward-compat)", () => {
    expect(
      validateOverlayShape({ version: 1, agents: [], surfaces: { skills: {} } }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// remove + list
// ---------------------------------------------------------------------------

describe("registry remove", () => {
  it("removes entry + vendored copy + origin; last leaves a valid empty overlay", async () => {
    await runRegistry(
      addOpts({
        name: "only",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/only.md"],
      }),
    );
    expect(existsSync(vendorDir("only"))).toBe(true);
    expect("only" in readOriginsFile()).toBe(true);

    const code = await runRegistry({
      action: "remove",
      name: "only",
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code).toBe(0);
    expect(existsSync(overlayPath)).toBe(true);
    const overlay = readOverlayFile() as { version: number; agents: unknown[] };
    expect(overlay.version).toBe(1);
    expect(overlay.agents).toEqual([]);
    // Cleanup: vendored copy gone, origins entry gone.
    expect(existsSync(vendorDir("only"))).toBe(false);
    expect("only" in readOriginsFile()).toBe(false);
  });

  it("rejects removing a nonexistent name (exit 1), overlay unchanged", async () => {
    await runRegistry(
      addOpts({
        name: "keep",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/keep.md"],
      }),
    );
    const before = readFileSync(overlayPath, "utf-8");
    const code = await runRegistry({
      action: "remove",
      name: "ghost",
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code).toBe(1);
    expect(readFileSync(overlayPath, "utf-8")).toBe(before);
  });

  it("preserves a forward-compat surfaces block across add+remove", async () => {
    writeFileSync(
      overlayPath,
      JSON.stringify({ version: 1, agents: [], surfaces: { skills: {} } }),
    );
    await runRegistry(
      addOpts({
        name: "tmp",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/tmp.md"],
      }),
    );
    await runRegistry({
      action: "remove",
      name: "tmp",
      overlayPath,
      originsPath,
      vendorDir,
    });
    const overlay = readOverlayFile() as { surfaces?: unknown };
    expect(overlay.surfaces).toEqual({ skills: {} });
  });
});

describe("registry list", () => {
  it("reports empty then populated", async () => {
    expect(await runRegistry({ action: "list", overlayPath })).toBe(0);
    await runRegistry(
      addOpts({
        name: "shown",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/shown.md"],
      }),
    );
    expect(await runRegistry({ action: "list", overlayPath })).toBe(0);
  });
});

describe("registry unknown action", () => {
  it("returns 2 and writes nothing", async () => {
    const code = await runRegistry({
      action: "bogus" as never,
      overlayPath,
    });
    expect(code).toBe(2);
    expect(existsSync(overlayPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// update (re-vendor from recorded origin)
// ---------------------------------------------------------------------------

describe("registry update", () => {
  async function seedAdd(name: string, file = "canon/x.md"): Promise<void> {
    const code = await runRegistry(
      addOpts({
        name,
        from: file,
        targets: [`claude:.claude/agents/${name}.md`],
      }),
    );
    expect(code).toBe(0);
  }

  it("reports unchanged when the source is identical (hash stable)", async () => {
    await seedAdd("u1");
    const hashBefore = readOriginsFile().u1.hash;
    const code = await runRegistry({
      action: "update",
      name: "u1",
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code).toBe(0);
    expect(readOriginsFile().u1.hash).toBe(hashBefore);
  });

  it("reports changed after the source mutates; re-vendors + updates hash, overlay unchanged", async () => {
    await seedAdd("u2");
    const overlayBefore = readFileSync(overlayPath, "utf-8");
    const hashBefore = readOriginsFile().u2.hash;
    // Mutate the SOURCE file.
    writeFileSync(join(projectRoot, "canon", "x.md"), "# x\nMUTATED\n");
    const code = await runRegistry({
      action: "update",
      name: "u2",
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code).toBe(0);
    // Vendored copy reflects the new bytes.
    expect(readFileSync(join(vendorDir("u2"), "x.md"), "utf-8")).toBe(
      "# x\nMUTATED\n",
    );
    // Hash updated, overlay canonical.dir unchanged.
    expect(readOriginsFile().u2.hash).not.toBe(hashBefore);
    expect(readFileSync(overlayPath, "utf-8")).toBe(overlayBefore);
  });

  it("--all updates every path-origin entry (mixed changed/unchanged)", async () => {
    // Two separate sources so we can mutate one and leave the other.
    writeFileSync(join(projectRoot, "canon", "a.md"), "alpha\n");
    writeFileSync(join(projectRoot, "canon", "b.md"), "beta\n");
    await seedAdd("ua", "canon/a.md");
    await seedAdd("ub", "canon/b.md");
    const hashA = readOriginsFile().ua.hash;
    const hashB = readOriginsFile().ub.hash;
    // Mutate only a.md.
    writeFileSync(join(projectRoot, "canon", "a.md"), "alpha-CHANGED\n");
    const code = await runRegistry({
      action: "update",
      all: true,
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code).toBe(0);
    expect(readOriginsFile().ua.hash).not.toBe(hashA);
    expect(readOriginsFile().ub.hash).toBe(hashB);
  });

  it("exit 1 for an absent agent", async () => {
    const code = await runRegistry({
      action: "update",
      name: "nope",
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code).toBe(1);
  });

  it("exit 1 for an agent with no recorded origin", async () => {
    // Seed an overlay entry directly with no origins entry.
    writeFileSync(
      overlayPath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            name: "noorigin",
            layer: "personal",
            canonical: { dir: vendorDir("noorigin"), versioned: false, file: "x.md" },
            targets: [{ type: "claude", path: ".claude/agents/noorigin.md" }],
          },
        ],
      }),
    );
    writeFileSync(originsPath, JSON.stringify({}));
    const code = await runRegistry({
      action: "update",
      name: "noorigin",
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code).toBe(1);
  });

  it("exactly one of <name> or --all is required (exit 2)", async () => {
    expect(
      await runRegistry({ action: "update", overlayPath, originsPath, vendorDir }),
    ).toBe(2);
    expect(
      await runRegistry({
        action: "update",
        name: "x",
        all: true,
        overlayPath,
        originsPath,
        vendorDir,
      }),
    ).toBe(2);
  });

  it("--all skips a non-path origin gracefully (forward-compat for FR-148)", async () => {
    await seedAdd("pathone");
    // Seed a fake github-origin entry whose agent also exists in the overlay.
    const overlay = readOverlayFile() as {
      version: number;
      agents: Record<string, unknown>[];
    };
    overlay.agents.push({
      name: "ghorigin",
      layer: "personal",
      canonical: { dir: vendorDir("ghorigin"), versioned: false, file: "x.md" },
      targets: [{ type: "claude", path: ".claude/agents/ghorigin.md" }],
    });
    writeFileSync(overlayPath, JSON.stringify(overlay));
    const origins = readOriginsFile();
    origins.ghorigin = { type: "github", dir: "owner/repo@main", hash: "deadbeef" };
    writeFileSync(originsPath, JSON.stringify(origins));

    const code = await runRegistry({
      action: "update",
      all: true,
      overlayPath,
      originsPath,
      vendorDir,
    });
    // Non-path origin is skipped (reported), not errored.
    expect(code).toBe(0);
    // The github origin is untouched.
    expect(readOriginsFile().ghorigin.hash).toBe("deadbeef");
  });

  it("re-vendors a versioned surface whose glob now matches a DIFFERENT file set", async () => {
    mkdirSync(join(projectRoot, "vsrc"), { recursive: true });
    writeFileSync(join(projectRoot, "vsrc", "v1.md"), "one\n");
    await runRegistry(
      addOpts({
        name: "vupd",
        from: "vsrc",
        versioned: true,
        glob: "v*.md",
        targets: ["codex:.codex/agents/vupd.toml"],
      }),
    );
    const hashBefore = readOriginsFile().vupd.hash;
    expect(existsSync(join(vendorDir("vupd"), "v1.md"))).toBe(true);
    expect(existsSync(join(vendorDir("vupd"), "v2.md"))).toBe(false);

    // Add a second matching file at the source.
    writeFileSync(join(projectRoot, "vsrc", "v2.md"), "two\n");
    const code = await runRegistry({
      action: "update",
      name: "vupd",
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code).toBe(0);
    // The vendored dir is fully replaced — now carries both files.
    expect(existsSync(join(vendorDir("vupd"), "v1.md"))).toBe(true);
    expect(existsSync(join(vendorDir("vupd"), "v2.md"))).toBe(true);
    expect(readOriginsFile().vupd.hash).not.toBe(hashBefore);
  });
});

// ---------------------------------------------------------------------------
// FR-148: github origin (add + update) — fetch boundary STUBBED via the
// injectable fetchRepo / listReleases seams (L-159/L-173: never vi.mock the
// SUT; stub the network boundary instead).
// ---------------------------------------------------------------------------

/**
 * Stage a fixture repo on disk and return a FetchRepoFn that resolves to it.
 * The returned repo dir carries an `igris.json` + the canonical files. Each
 * call records the spec it was invoked with (so `update` re-fetch can be
 * asserted). `cleanup` is a no-op here — the staged dir is owned by the test.
 */
function makeStubFetch(opts: {
  repoDir: string;
  sha?: string;
  calls?: GithubSpec[];
}): FetchRepoFn {
  return async (spec: GithubSpec): Promise<FetchedRepo> => {
    opts.calls?.push(spec);
    return {
      dir: opts.repoDir,
      sha: opts.sha ?? "0123456789abcdef0123456789abcdef01234567",
      cleanup: () => {
        /* test owns the dir */
      },
    };
  };
}

function makeStubReleases(tags: string[]): ListReleasesFn {
  return async () => tags;
}

describe("registry add — github origin (stubbed fetch)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = join(tmpRoot, "ghrepo");
    mkdirSync(join(repoDir, "agents"), { recursive: true });
    writeFileSync(join(repoDir, "agents", "mypack.md"), "# mypack\nbody\n");
    writeFileSync(
      join(repoDir, "igris.json"),
      JSON.stringify({
        version: 1,
        agents: [
          {
            name: "mypack",
            canonical: { dir: "agents", versioned: false, file: "mypack.md" },
            targets: [{ type: "claude", path: ".claude/agents/mypack.md" }],
          },
        ],
      }),
    );
  });

  it("parses + vendors + records a github origin (single-entry manifest)", async () => {
    const code = await runRegistry({
      action: "add",
      name: "mypack",
      from: "github:owner/repo@v1.0.0",
      targets: ["claude:.claude/agents/mypack.md"],
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      fetchRepo: makeStubFetch({ repoDir }),
    });
    expect(code).toBe(0);

    // Vendored copy is byte-equal to the fixture.
    const vendored = join(vendorDir("mypack"), "mypack.md");
    expect(existsSync(vendored)).toBe(true);
    expect(readFileSync(vendored, "utf-8")).toBe(
      readFileSync(join(repoDir, "agents", "mypack.md"), "utf-8"),
    );

    // Overlay entry points canonical.dir at the vendored copy.
    const overlay = readOverlayFile() as {
      agents: { name: string; layer: string; canonical: Record<string, unknown> }[];
    };
    expect(overlay.agents[0].name).toBe("mypack");
    expect(overlay.agents[0].canonical.dir).toBe(vendorDir("mypack"));

    // origins.json carries a github origin.
    const origins = readOriginsFile() as Record<string, Record<string, unknown>>;
    expect(origins.mypack.type).toBe("github");
    expect(origins.mypack.repo).toBe("owner/repo");
    expect(origins.mypack.ref).toBe("v1.0.0");
    expect(origins.mypack.sha).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(origins.mypack.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("selects the named surface from a multi-entry repo manifest", async () => {
    mkdirSync(join(repoDir, "b"), { recursive: true });
    writeFileSync(join(repoDir, "b", "beta.md"), "# beta\n");
    writeFileSync(
      join(repoDir, "igris.json"),
      JSON.stringify({
        version: 1,
        agents: [
          {
            name: "mypack",
            canonical: { dir: "agents", versioned: false, file: "mypack.md" },
            targets: [{ type: "claude", path: ".claude/agents/mypack.md" }],
          },
          {
            name: "beta",
            canonical: { dir: "b", versioned: false, file: "beta.md" },
            targets: [{ type: "claude", path: ".claude/agents/beta.md" }],
          },
        ],
      }),
    );
    const code = await runRegistry({
      action: "add",
      name: "beta",
      from: "github:owner/repo@v1.0.0",
      targets: ["claude:.claude/agents/beta.md"],
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      fetchRepo: makeStubFetch({ repoDir }),
    });
    expect(code).toBe(0);
    expect(existsSync(join(vendorDir("beta"), "beta.md"))).toBe(true);
  });

  it("errors (exit 1) when <name> matches no surface in a multi-entry manifest", async () => {
    writeFileSync(
      join(repoDir, "igris.json"),
      JSON.stringify({
        version: 1,
        agents: [
          {
            name: "alpha",
            canonical: { dir: "agents", versioned: false, file: "mypack.md" },
            targets: [{ type: "claude", path: ".claude/agents/alpha.md" }],
          },
          {
            name: "beta",
            canonical: { dir: "agents", versioned: false, file: "mypack.md" },
            targets: [{ type: "claude", path: ".claude/agents/beta.md" }],
          },
        ],
      }),
    );
    const code = await runRegistry({
      action: "add",
      name: "gamma",
      from: "github:owner/repo@v1.0.0",
      targets: ["claude:.claude/agents/gamma.md"],
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      fetchRepo: makeStubFetch({ repoDir }),
    });
    expect(code).toBe(1);
    expect(existsSync(vendorDir("gamma"))).toBe(false);
    expect(existsSync(originsPath)).toBe(false);
  });

  it("scopes the canonical dir under a #subdir", async () => {
    // Move the fixture under packs/.
    mkdirSync(join(repoDir, "packs", "agents"), { recursive: true });
    writeFileSync(join(repoDir, "packs", "agents", "mypack.md"), "# scoped\n");
    const code = await runRegistry({
      action: "add",
      name: "mypack",
      from: "github:owner/repo@v1.0.0#packs",
      targets: ["claude:.claude/agents/mypack.md"],
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      fetchRepo: makeStubFetch({ repoDir }),
    });
    expect(code).toBe(0);
    expect(readFileSync(join(vendorDir("mypack"), "mypack.md"), "utf-8")).toBe(
      "# scoped\n",
    );
    const origins = readOriginsFile() as Record<string, Record<string, unknown>>;
    expect(origins.mypack.subdir).toBe("packs");
  });

  it("rejects a bad repo manifest (exit 1, no vendor)", async () => {
    writeFileSync(join(repoDir, "igris.json"), JSON.stringify({ version: 2 }));
    const code = await runRegistry({
      action: "add",
      name: "mypack",
      from: "github:owner/repo@v1.0.0",
      targets: ["claude:.claude/agents/mypack.md"],
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      fetchRepo: makeStubFetch({ repoDir }),
    });
    expect(code).toBe(1);
    expect(existsSync(vendorDir("mypack"))).toBe(false);
  });

  it("rejects a bad spec (exit 2) WITHOUT attempting a fetch", async () => {
    const calls: GithubSpec[] = [];
    const code = await runRegistry({
      action: "add",
      name: "mypack",
      from: "github:owner/repo", // no @ref
      targets: ["claude:.claude/agents/mypack.md"],
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      fetchRepo: makeStubFetch({ repoDir, calls }),
    });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0); // parse precedes fetch
  });

  it("surfaces a fetch failure as exit 1 (actionable error)", async () => {
    const code = await runRegistry({
      action: "add",
      name: "mypack",
      from: "github:owner/private@v1.0.0",
      targets: ["claude:.claude/agents/mypack.md"],
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      fetchRepo: async () => {
        throw new Error(
          "cannot fetch owner/private@v1.0.0: 404. If this is a private repo, run 'gh auth login'.",
        );
      },
    });
    expect(code).toBe(1);
    expect(existsSync(vendorDir("mypack"))).toBe(false);
  });

  it("rejects a path-traversal manifest (canonical.dir escapes repo) — no vendor", async () => {
    // A malicious repo manifest whose canonical.dir tries to escape the fetched
    // repo root. The fetch SEAM is stubbed (no network); the staged repo dir
    // carries the hostile manifest. selectSurface's containment guard must
    // reject BEFORE vendoring anything.
    writeFileSync(
      join(repoDir, "igris.json"),
      JSON.stringify({
        version: 1,
        agents: [
          {
            name: "mypack",
            canonical: {
              dir: "../../../../../../etc",
              versioned: false,
              file: "passwd",
            },
            targets: [{ type: "claude", path: ".claude/agents/mypack.md" }],
          },
        ],
      }),
    );
    const code = await runRegistry({
      action: "add",
      name: "mypack",
      from: "github:owner/repo@v1.0.0",
      targets: ["claude:.claude/agents/mypack.md"],
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      fetchRepo: makeStubFetch({ repoDir }),
    });
    expect(code).toBe(1);
    // Nothing vendored, no origin recorded, no overlay written.
    expect(existsSync(vendorDir("mypack"))).toBe(false);
    expect(existsSync(originsPath)).toBe(false);
    expect(existsSync(overlayPath)).toBe(false);
  });

  it("rejects a symlinked canonical.dir escaping the repo (clone-tier vuln) — no vendor", async () => {
    // Simulate what the gh/git clone tiers materialize for a repo that checks
    // in `canonical.dir` as a symlink pointing OUTSIDE the fetched repo root.
    // Lexical `..` containment passes (the link's own path is under repo); the
    // realpath guard must reject the dereferenced out-of-repo target before any
    // copyFileSync vendors host files into ~/.igris/registry/.
    const outside = mkdtempSync(join(tmpdir(), "igris-host-secret-"));
    writeFileSync(join(outside, "passwd"), "root:x:0:0\n");
    // Replace the fixture's real `agents/` dir with a symlink to `outside`.
    rmSync(join(repoDir, "agents"), { recursive: true, force: true });
    try {
      symlinkSync(outside, join(repoDir, "agents"));
    } catch {
      // Sandbox without symlink perms — skip.
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    writeFileSync(
      join(repoDir, "igris.json"),
      JSON.stringify({
        version: 1,
        agents: [
          {
            name: "mypack",
            canonical: { dir: "agents", versioned: false, file: "passwd" },
            targets: [{ type: "claude", path: ".claude/agents/mypack.md" }],
          },
        ],
      }),
    );
    const code = await runRegistry({
      action: "add",
      name: "mypack",
      from: "github:owner/repo@v1.0.0",
      targets: ["claude:.claude/agents/mypack.md"],
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      fetchRepo: makeStubFetch({ repoDir }),
    });
    rmSync(outside, { recursive: true, force: true });
    expect(code).toBe(1);
    // The host file was NOT vendored; no origin, no overlay.
    expect(existsSync(vendorDir("mypack"))).toBe(false);
    expect(existsSync(originsPath)).toBe(false);
    expect(existsSync(overlayPath)).toBe(false);
  });
});

describe("registry update — github origin (stubbed fetch + releases)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = join(tmpRoot, "ghrepo-upd");
    mkdirSync(join(repoDir, "agents"), { recursive: true });
    writeFileSync(join(repoDir, "agents", "mypack.md"), "# v1\n");
    writeFileSync(
      join(repoDir, "igris.json"),
      JSON.stringify({
        version: 1,
        agents: [
          {
            name: "mypack",
            canonical: { dir: "agents", versioned: false, file: "mypack.md" },
            targets: [{ type: "claude", path: ".claude/agents/mypack.md" }],
          },
        ],
      }),
    );
    // Seed an add at v1.0.0.
    await runRegistry({
      action: "add",
      name: "mypack",
      from: "github:owner/repo@v1.0.0",
      targets: ["claude:.claude/agents/mypack.md"],
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      fetchRepo: makeStubFetch({ repoDir, sha: "aaaaaaaaaaaaaaaa" }),
    });
  });

  it("reports unchanged when the pinned tag is the latest", async () => {
    const code = await runRegistry({
      action: "update",
      name: "mypack",
      overlayPath,
      originsPath,
      vendorDir,
      listReleases: makeStubReleases(["v1.0.0", "v0.9.0"]),
      fetchRepo: makeStubFetch({ repoDir }),
    });
    expect(code).toBe(0);
    const origins = readOriginsFile() as Record<string, Record<string, unknown>>;
    expect(origins.mypack.ref).toBe("v1.0.0");
    expect(origins.mypack.sha).toBe("aaaaaaaaaaaaaaaa");
  });

  it("reports no releases found (unchanged) when releases is empty", async () => {
    const code = await runRegistry({
      action: "update",
      name: "mypack",
      overlayPath,
      originsPath,
      vendorDir,
      listReleases: makeStubReleases([]),
      fetchRepo: makeStubFetch({ repoDir }),
    });
    expect(code).toBe(0);
    expect(
      (readOriginsFile() as Record<string, Record<string, unknown>>).mypack.ref,
    ).toBe("v1.0.0");
  });

  it("detects a newer release, re-vendors, and advances ref/sha", async () => {
    // Mutate the fixture so the re-vendored bytes differ.
    writeFileSync(join(repoDir, "agents", "mypack.md"), "# v2 fresh\n");
    const calls: GithubSpec[] = [];
    const code = await runRegistry({
      action: "update",
      name: "mypack",
      overlayPath,
      originsPath,
      vendorDir,
      listReleases: makeStubReleases(["v1.0.0", "v1.1.0"]),
      fetchRepo: makeStubFetch({
        repoDir,
        sha: "bbbbbbbbbbbbbbbb",
        calls,
      }),
    });
    expect(code).toBe(0);
    // fetchRepo was re-invoked at the NEW tag.
    expect(calls).toHaveLength(1);
    expect(calls[0].ref).toBe("v1.1.0");
    // origin advanced.
    const origins = readOriginsFile() as Record<string, Record<string, unknown>>;
    expect(origins.mypack.ref).toBe("v1.1.0");
    expect(origins.mypack.sha).toBe("bbbbbbbbbbbbbbbb");
    // re-vendored bytes reflect the mutation.
    expect(readFileSync(join(vendorDir("mypack"), "mypack.md"), "utf-8")).toBe(
      "# v2 fresh\n",
    );
  });

  it("--all processes a github origin alongside a path origin", async () => {
    // Add a sibling path origin.
    await runRegistry(
      addOpts({
        name: "localpack",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/localpack.md"],
      }),
    );
    const code = await runRegistry({
      action: "update",
      all: true,
      overlayPath,
      originsPath,
      vendorDir,
      listReleases: makeStubReleases(["v1.0.0"]),
      fetchRepo: makeStubFetch({ repoDir }),
    });
    expect(code).toBe(0);
    // Both origins are intact; github stayed at v1.0.0.
    const origins = readOriginsFile() as Record<string, Record<string, unknown>>;
    expect(origins.mypack.type).toBe("github");
    expect(origins.localpack.type).toBe("path");
  });
});

// ---------------------------------------------------------------------------
// Integration (real adapter + real validator) — the parity closer.
// ---------------------------------------------------------------------------

function toolingAvailable(): boolean {
  try {
    execFileSync("bash", ["-c", "command -v python3"], { stdio: "ignore" });
    return existsSync(COMPILE_SH) && existsSync(COMMON_SH) && existsSync(SCHEMA);
  } catch {
    return false;
  }
}

describe("registry integration (real compile_harnesses.sh + validate_manifest)", () => {
  let brainDir: string;
  let fixtureRoot: string;
  const prevBrainEnv = process.env.IGRIS_BRAIN_DIR;

  beforeEach(() => {
    brainDir = join(tmpRoot, "brain");
    mkdirSync(join(brainDir, "registry"), { recursive: true });
    fixtureRoot = join(tmpRoot, "fixture");
    // Canonical prompt (unversioned) at canon/mycustom.md.
    mkdirSync(join(fixtureRoot, "canon"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "canon", "mycustom.md"),
      "# mycustom\n\nPersonal agent body.\n",
    );
    // Target dir for the produced codex harness. (We use a codex target, not
    // claude: sync_claude_agents.sh SYNCS frontmatter into a pre-existing
    // harness file, whereas sync_codex_agents.sh GENERATES the .toml fresh —
    // proving auto-discovery produced output without a pre-seeded target.)
    mkdirSync(join(fixtureRoot, ".codex", "agents"), { recursive: true });
    // Base manifest with ONE base agent of a DIFFERENT name (so no collision).
    writeFileSync(
      join(fixtureRoot, "harness-manifest.json"),
      JSON.stringify({
        version: 1,
        agents: [
          {
            name: "baseonly",
            canonical: { dir: "canon", versioned: false, file: "mycustom.md" },
            targets: [{ type: "claude", path: ".claude/agents/baseonly.md" }],
          },
        ],
      }),
    );
  });

  afterEach(() => {
    if (prevBrainEnv === undefined) {
      delete process.env.IGRIS_BRAIN_DIR;
    } else {
      process.env.IGRIS_BRAIN_DIR = prevBrainEnv;
    }
  });

  it("copy-mode overlay is auto-discovered + the REAL compiler resolves the vendored canonical, and validate_manifest passes", async () => {
    if (!toolingAvailable()) {
      // Graceful skip on a minimal box (no bash/python3 or no adapters).
      return;
    }

    // Write the overlay via the REAL verb into the sandboxed brain registry,
    // using the same paths the adapter auto-discovers (no test seams here:
    // exercise registryOverlayPath()/registrySurfaceDirPath()/registryOriginsPath()
    // via IGRIS_BRAIN_DIR so the verb + adapter agree automatically).
    process.env.IGRIS_BRAIN_DIR = brainDir;
    const writtenOverlay = join(
      brainDir,
      "registry",
      "harness-manifest.personal.json",
    );
    const addCode = await runRegistry({
      action: "add",
      name: "mycustom",
      from: "canon/mycustom.md",
      targets: ["codex:.codex/agents/mycustom.toml"],
      projectRoot: fixtureRoot,
    });
    expect(addCode).toBe(0);
    expect(existsSync(writtenOverlay)).toBe(true);
    // The vendored copy landed under the sandboxed brain registry dir.
    const vendored = join(brainDir, "registry", "mycustom", "mycustom.md");
    expect(existsSync(vendored)).toBe(true);

    // (AC4) The overlay passes the REAL validate_manifest — closes the
    // TS-validator-vs-schema parity loop end-to-end (schema-clean under option b).
    const validate = execFileSync(
      "bash",
      [
        "-c",
        `source "${COMMON_SH}" && validate_manifest "${writtenOverlay}" "${SCHEMA}"`,
      ],
      { encoding: "utf-8", env: { ...process.env, IGRIS_BRAIN_DIR: brainDir } },
    );
    expect(typeof validate).toBe("string");

    // (AC5) Run the REAL compiler with NO --overlay flag → it must
    // auto-discover the personal overlay AND resolve the ABSOLUTE vendored
    // canonical.dir verbatim (the patched 3-case resolution) → produce the
    // declared target. This proves the core/ compiler edit works end-to-end.
    execFileSync(
      "bash",
      [COMPILE_SH, "--project-root", fixtureRoot, "--filter", "mycustom"],
      { encoding: "utf-8", env: { ...process.env, IGRIS_BRAIN_DIR: brainDir } },
    );
    expect(
      existsSync(join(fixtureRoot, ".codex", "agents", "mycustom.toml")),
    ).toBe(true);
  });

  it("after update re-vendors mutated source, the REAL compiler reflects the UPDATED bytes", async () => {
    if (!toolingAvailable()) {
      return;
    }
    process.env.IGRIS_BRAIN_DIR = brainDir;
    const addCode = await runRegistry({
      action: "add",
      name: "mycustom",
      from: "canon/mycustom.md",
      targets: ["codex:.codex/agents/mycustom.toml"],
      projectRoot: fixtureRoot,
    });
    expect(addCode).toBe(0);

    // Mutate the SOURCE, then update (re-vendor).
    writeFileSync(
      join(fixtureRoot, "canon", "mycustom.md"),
      "# mycustom\n\nUPDATED personal agent body marker XYZZY.\n",
    );
    const updCode = await runRegistry({
      action: "update",
      name: "mycustom",
      projectRoot: fixtureRoot,
    });
    expect(updCode).toBe(0);

    // Compile reads the VENDORED copy (now updated), not the origin.
    execFileSync(
      "bash",
      [COMPILE_SH, "--project-root", fixtureRoot, "--filter", "mycustom"],
      { encoding: "utf-8", env: { ...process.env, IGRIS_BRAIN_DIR: brainDir } },
    );
    const produced = readFileSync(
      join(fixtureRoot, ".codex", "agents", "mycustom.toml"),
      "utf-8",
    );
    expect(produced).toContain("XYZZY");
  });
});
