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
  readdirSync,
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
  validateSkillsSurface,
  validateSkillsSurfaceArray,
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

/** Test-seam agent vendor-dir resolver: `<vendorBase>/<name>`. */
function vendorDir(name: string): string {
  return join(vendorBase, name);
}

/**
 * TD-191 test-seam skill vendor-dir resolver: `<vendorBase>/skills/<name>`.
 * Mirrors the L-517 layout (typed subfolder) so tests assert paths under
 * `<base>/skills/<name>/` without touching `~/.igris/registry/`.
 */
function skillVendorDir(name: string): string {
  return join(vendorBase, "skills", name);
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
    // TD-191: keyspace is namespaced — agent entries land under `agent:<name>`.
    const origins = readOriginsFile();
    expect(origins["agent:mycustom"].type).toBe("path");
    expect(origins["agent:mycustom"].dir).toBe(join(projectRoot, "canon"));
    expect(origins["agent:mycustom"].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("--versioned --glob persists the overlay shape; FR-156 vendors the WHOLE source tree (closes L-516)", async () => {
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
    // FR-156: tree vendor brings the WHOLE source dir minus the skip-list.
    // The overlay still records `glob: 'v*.md'` (consumed by
    // `assembleAgentHarness`'s body-picker), but unrelated sibling files
    // are no longer dropped — that was the L-516 violation (registry copy
    // was not self-sufficient when authors shipped sibling supporting
    // files like routing/ or archetypes/).
    expect(existsSync(join(vendorDir("vagent"), "v1.md"))).toBe(true);
    expect(existsSync(join(vendorDir("vagent"), "v2.md"))).toBe(true);
    expect(existsSync(join(vendorDir("vagent"), "skip.txt"))).toBe(true);
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

  // -------------------------------------------------------------------------
  // FR-151: harness-agnostic frontmatter.md sidecar vendor pickup
  // The vendor primitive picks up a co-located `frontmatter.md` next to the
  // canonical(s) and folds it into the content hash. See L-519, FR-151.
  // -------------------------------------------------------------------------

  it("FR-151: --versioned with a frontmatter.md sibling vendors BOTH", async () => {
    mkdirSync(join(projectRoot, "vcanon"), { recursive: true });
    writeFileSync(
      join(projectRoot, "vcanon", "system-prompt-v1.md"),
      "v1 body\n",
    );
    writeFileSync(
      join(projectRoot, "vcanon", "frontmatter.md"),
      "---\nname: vfront\n---\n",
    );
    const code = await runRegistry(
      addOpts({
        name: "vfront",
        from: "vcanon",
        versioned: true,
        glob: "system-prompt-v*.md",
        targets: ["claude:.claude/agents/vfront.md"],
      }),
    );
    expect(code).toBe(0);
    // BOTH files vendored.
    expect(existsSync(join(vendorDir("vfront"), "system-prompt-v1.md"))).toBe(
      true,
    );
    expect(existsSync(join(vendorDir("vfront"), "frontmatter.md"))).toBe(true);
    // Glob is unchanged (frontmatter.md does NOT mutate the glob).
    const overlay = readOverlayFile() as {
      agents: { canonical: Record<string, unknown> }[];
    };
    expect(overlay.agents[0].canonical.glob).toBe("system-prompt-v*.md");
    // Hash includes the sidecar.
    const origins = readOriginsFile();
    expect(origins["agent:vfront"].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("FR-151: --versioned WITHOUT frontmatter.md still works (backward-compat)", async () => {
    mkdirSync(join(projectRoot, "vcanon"), { recursive: true });
    writeFileSync(
      join(projectRoot, "vcanon", "system-prompt-v1.md"),
      "v1 body\n",
    );
    const code = await runRegistry(
      addOpts({
        name: "vplain",
        from: "vcanon",
        versioned: true,
        glob: "system-prompt-v*.md",
        targets: ["claude:.claude/agents/vplain.md"],
      }),
    );
    expect(code).toBe(0);
    // Only the canonical was vendored; no spurious frontmatter.md.
    expect(existsSync(join(vendorDir("vplain"), "system-prompt-v1.md"))).toBe(
      true,
    );
    expect(existsSync(join(vendorDir("vplain"), "frontmatter.md"))).toBe(false);
  });

  it("FR-151: unversioned with a frontmatter.md sibling vendors BOTH", async () => {
    // Reuse the default canon/ dir (carries x.md from beforeEach).
    writeFileSync(
      join(projectRoot, "canon", "frontmatter.md"),
      "---\nname: ufront\n---\n",
    );
    const code = await runRegistry(
      addOpts({
        name: "ufront",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/ufront.md"],
      }),
    );
    expect(code).toBe(0);
    expect(existsSync(join(vendorDir("ufront"), "x.md"))).toBe(true);
    expect(existsSync(join(vendorDir("ufront"), "frontmatter.md"))).toBe(true);
  });

  it("FR-151: --versioned glob double-match for frontmatter.md vendors exactly once", async () => {
    // Glob `*.md` matches BOTH system-prompt-v1.md AND frontmatter.md; the
    // sidecar-pickup must not double-push. Final files[] has each name once.
    mkdirSync(join(projectRoot, "vcanon"), { recursive: true });
    writeFileSync(
      join(projectRoot, "vcanon", "system-prompt-v1.md"),
      "v1\n",
    );
    writeFileSync(
      join(projectRoot, "vcanon", "frontmatter.md"),
      "fm body\n",
    );
    const code = await runRegistry(
      addOpts({
        name: "vdouble",
        from: "vcanon",
        versioned: true,
        glob: "*.md",
        targets: ["claude:.claude/agents/vdouble.md"],
      }),
    );
    expect(code).toBe(0);
    // BOTH present; frontmatter.md appears exactly once (vendor-dir read).
    const vendored = readdirSync(vendorDir("vdouble"));
    const fmCount = vendored.filter((n) => n === "frontmatter.md").length;
    expect(fmCount).toBe(1);
    expect(vendored).toContain("system-prompt-v1.md");
  });

  // -------------------------------------------------------------------------
  // FR-152: vendor-side α-assembly — produce `<vendoredDir>/harness.md` from
  // the FR-151 frontmatter.md sidecar + the canonical body. Claude + gemini
  // compile-time symlinks resolve to this ONE file. See L-519, FR-152.
  // -------------------------------------------------------------------------

  it("FR-152: runAdd assembles harness.md from frontmatter.md + body", async () => {
    mkdirSync(join(projectRoot, "vcanon"), { recursive: true });
    writeFileSync(
      join(projectRoot, "vcanon", "system-prompt-v1.md"),
      "# DEMO\n\nbody line one\nbody line two\n",
    );
    writeFileSync(
      join(projectRoot, "vcanon", "frontmatter.md"),
      "---\nname: demo\ndescription: FR-152 α-assembly\n---\n",
    );
    const code = await runRegistry(
      addOpts({
        name: "demo",
        from: "vcanon",
        versioned: true,
        glob: "system-prompt-v*.md",
        targets: ["claude:.claude/agents/demo.md"],
      }),
    );
    expect(code).toBe(0);
    // harness.md exists in the vendored dir and starts with `---\n<fm>\n---\n`
    // followed by the body.
    const harnessPath = join(vendorDir("demo"), "harness.md");
    expect(existsSync(harnessPath)).toBe(true);
    const harness = readFileSync(harnessPath, "utf-8");
    expect(harness.startsWith("---\nname: demo\ndescription: FR-152 α-assembly\n---\n")).toBe(
      true,
    );
    expect(harness).toContain("body line one");
    expect(harness).toContain("body line two");
  });

  it("FR-152: assembly idempotency — re-add reproduces identical harness.md bytes", async () => {
    mkdirSync(join(projectRoot, "vcanon"), { recursive: true });
    writeFileSync(
      join(projectRoot, "vcanon", "system-prompt-v1.md"),
      "body\n",
    );
    writeFileSync(
      join(projectRoot, "vcanon", "frontmatter.md"),
      "---\nname: idem\n---\n",
    );
    await runRegistry(
      addOpts({
        name: "idem",
        from: "vcanon",
        versioned: true,
        glob: "system-prompt-v*.md",
        targets: ["claude:.claude/agents/idem.md"],
      }),
    );
    const harnessPath = join(vendorDir("idem"), "harness.md");
    const first = readFileSync(harnessPath, "utf-8");
    // Remove the existing entry and re-add → same bytes.
    await runRegistry({
      action: "remove",
      name: "idem",
      overlayPath,
      originsPath,
      vendorDir,
    });
    await runRegistry(
      addOpts({
        name: "idem",
        from: "vcanon",
        versioned: true,
        glob: "system-prompt-v*.md",
        targets: ["claude:.claude/agents/idem.md"],
      }),
    );
    const second = readFileSync(harnessPath, "utf-8");
    expect(first).toBe(second);
  });

  it("FR-152: versioned assembly picks LATEST system-prompt-vN (sort -V semantics)", async () => {
    // v1.0 vs v1.10 vs v1.2 — `sort -V` orders v1.10 last. Assembly must pick
    // v1.10's content.
    mkdirSync(join(projectRoot, "vcanon"), { recursive: true });
    writeFileSync(join(projectRoot, "vcanon", "system-prompt-v1.0.md"), "v1.0\n");
    writeFileSync(join(projectRoot, "vcanon", "system-prompt-v1.2.md"), "v1.2\n");
    writeFileSync(join(projectRoot, "vcanon", "system-prompt-v1.10.md"), "v1.10 latest body\n");
    writeFileSync(
      join(projectRoot, "vcanon", "frontmatter.md"),
      "---\nname: ver\n---\n",
    );
    await runRegistry(
      addOpts({
        name: "ver",
        from: "vcanon",
        versioned: true,
        glob: "system-prompt-v*.md",
        targets: ["claude:.claude/agents/ver.md"],
      }),
    );
    const harness = readFileSync(join(vendorDir("ver"), "harness.md"), "utf-8");
    expect(harness).toContain("v1.10 latest body");
    expect(harness).not.toContain("v1.0\n");
    expect(harness).not.toContain("v1.2\n");
  });

  it("FR-152: assembly is a no-op when frontmatter.md is absent (back-compat)", async () => {
    // Personal agents added pre-FR-151 don't have a sidecar; the vendor must
    // not emit a half-assembled harness.md. The compile-side fallback in
    // compile_harnesses.sh handles those cases at compile time.
    mkdirSync(join(projectRoot, "vcanon"), { recursive: true });
    writeFileSync(
      join(projectRoot, "vcanon", "system-prompt-v1.md"),
      "body without sidecar\n",
    );
    await runRegistry(
      addOpts({
        name: "nofm",
        from: "vcanon",
        versioned: true,
        glob: "system-prompt-v*.md",
        targets: ["claude:.claude/agents/nofm.md"],
      }),
    );
    expect(existsSync(join(vendorDir("nofm"), "harness.md"))).toBe(false);
  });

  it("FR-152: harness.md is NOT folded into the origin hash (excluded from freshness)", async () => {
    // The hash is computed BEFORE assembly so re-running `update` with no
    // source change produces an unchanged hash. If harness.md were in the
    // hash, re-derivation would tickle a phantom freshness delta.
    mkdirSync(join(projectRoot, "vcanon"), { recursive: true });
    writeFileSync(join(projectRoot, "vcanon", "system-prompt-v1.md"), "body\n");
    writeFileSync(
      join(projectRoot, "vcanon", "frontmatter.md"),
      "---\nname: hashed\n---\n",
    );
    await runRegistry(
      addOpts({
        name: "hashed",
        from: "vcanon",
        versioned: true,
        glob: "system-prompt-v*.md",
        targets: ["claude:.claude/agents/hashed.md"],
      }),
    );
    const beforeHash = readOriginsFile()["agent:hashed"].hash;
    // `update` re-vendors + re-assembles; the hash MUST stay constant when
    // source bytes are unchanged.
    const upd = await runRegistry({
      action: "update",
      name: "hashed",
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(upd).toBe(0);
    const afterHash = readOriginsFile()["agent:hashed"].hash;
    expect(afterHash).toBe(beforeHash);
  });

  it("FR-152: gemini agent target is accepted via parseTarget (no schema regression)", async () => {
    // A direct add with a gemini target succeeds and produces a valid overlay
    // entry. FR-151 already extended the type enum to include gemini for agent
    // targets; this exercises the path end-to-end.
    const code = await runRegistry(
      addOpts({
        name: "gem",
        from: "canon/x.md",
        targets: ["gemini:.gemini/agents/gem.md"],
      }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      agents: { name: string; targets: { type: string; path: string }[] }[];
    };
    expect(overlay.agents[0].targets[0]).toEqual({
      type: "gemini",
      path: ".gemini/agents/gem.md",
    });
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

  it("overlay: accepts a VALID surfaces.skills array (TD-191)", () => {
    // TD-191: `surfaces.skills` is an ARRAY of blocks (multi-source). Each
    // block must satisfy $defs.skills_surface (targets required). Validate
    // the array path explicitly.
    expect(
      validateOverlayShape({
        version: 1,
        agents: [],
        surfaces: {
          skills: [
            {
              source: "/abs/skills",
              layer: "personal",
              targets: [{ type: "codex", method: "symlink", path: ".codex/skills" }],
            },
          ],
        },
      }),
    ).toBeNull();
    // Empty array is rejected (minItems:1).
    expect(
      validateOverlayShape({ version: 1, agents: [], surfaces: { skills: [] } }),
    ).toMatch(/non-empty array/);
    // Non-array is rejected (TD-191's explicit array gate; validateOverlayShape
    // calls validateSkillsSurfaceArray which requires an array).
    expect(
      validateOverlayShape({ version: 1, agents: [], surfaces: { skills: {} } }),
    ).toMatch(/non-empty array/);
  });
});

// ---------------------------------------------------------------------------
// FR-155: scope-aware overlay (default global + optional --project + --scope)
// ---------------------------------------------------------------------------

/**
 * FR-155 scope vitest matrix — pins the runAdd + runAddSkill scope handling
 * documented in `cli/src/verbs/registry.ts`.
 *
 *   - default add (no --scope / no --project) → on-disk overlay OMITS the
 *     `scope` field (schema treats absent as global) so the diff for an
 *     unrelated overlay is minimal.
 *   - `--project P` → entry.scope === {type:"project", paths:[realpath(P)]}.
 *     CLI realpath's at WRITE time so the matrix below uses /tmp paths and
 *     asserts /private/tmp realpath'd shape (macOS).
 *   - re-add `--project Q` against an existing project entry → APPEND Q's
 *     realpath to scope.paths (idempotent on duplicate).
 *   - re-add `--project Q` against an existing GLOBAL entry → exit 1 with
 *     the `--scope project` hint.
 *   - `--scope project --project Q` against an existing GLOBAL entry →
 *     CONVERT to scope.type=project with paths=[realpath(Q)].
 *   - `--scope global` against an existing project entry → CONVERT to
 *     global (the `scope` field is DROPPED from the overlay).
 *   - same matrix for `runAddSkill`.
 *
 * macOS-only realpath case (/tmp ↔ /private/tmp): we don't skip; instead we
 * derive `EXPECTED_TMP_REAL` once from `realpathSync(tmpdir())` so the test
 * works on Linux too (where the realpath is just the literal path).
 */
describe("registry add — FR-155 scope", () => {
  // Derive the canonical realpath of the OS tmp dir so the test works on
  // BOTH macOS (where /tmp -> /private/tmp) and Linux (where they coincide).
  // The matrix below stages `--project <path>` values under tmpdir() and
  // asserts that `entry.scope.paths` contains the realpath'd shape.
  const realpathOf = (p: string): string => {
    const fs = require("node:fs") as typeof import("node:fs");
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };

  it("default add (no --scope, no --project) → overlay entry has no `scope` field", async () => {
    const code = await runRegistry(
      addOpts({
        name: "globdefault",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/globdefault.md"],
      }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      agents: { name: string; scope?: unknown }[];
    };
    const entry = overlay.agents.find((a) => a.name === "globdefault");
    expect(entry).toBeDefined();
    expect("scope" in (entry as Record<string, unknown>)).toBe(false);
  });

  it("--project P → entry.scope === {type:'project', paths:[realpath(P)]}", async () => {
    const projP = join(projectRoot, "consumerA");
    mkdirSync(projP, { recursive: true });
    const code = await runRegistry(
      addOpts({
        name: "scoped",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/scoped.md"],
        project: projP,
      } as Parameters<typeof runRegistry>[0]),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      agents: { name: string; scope?: { type: string; paths: string[] } }[];
    };
    const entry = overlay.agents.find((a) => a.name === "scoped");
    expect(entry).toBeDefined();
    expect(entry!.scope).toEqual({
      type: "project",
      paths: [realpathOf(projP)],
    });
  });

  it("re-add --project Q against an existing project entry → paths grows additively", async () => {
    const projP = join(projectRoot, "consumerA");
    const projQ = join(projectRoot, "consumerB");
    mkdirSync(projP, { recursive: true });
    mkdirSync(projQ, { recursive: true });
    let code = await runRegistry(
      addOpts({
        name: "multi",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/multi.md"],
        project: projP,
      } as Parameters<typeof runRegistry>[0]),
    );
    expect(code).toBe(0);
    code = await runRegistry(
      addOpts({
        name: "multi",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/multi.md"],
        project: projQ,
      } as Parameters<typeof runRegistry>[0]),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      agents: { name: string; scope?: { type: string; paths: string[] } }[];
    };
    const entry = overlay.agents.find((a) => a.name === "multi");
    expect(entry!.scope).toEqual({
      type: "project",
      paths: [realpathOf(projP), realpathOf(projQ)],
    });
  });

  it("re-add --project P (same) on existing project entry is IDEMPOTENT (no duplicate, exit 0)", async () => {
    const projP = join(projectRoot, "consumerA");
    mkdirSync(projP, { recursive: true });
    let code = await runRegistry(
      addOpts({
        name: "idem",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/idem.md"],
        project: projP,
      } as Parameters<typeof runRegistry>[0]),
    );
    expect(code).toBe(0);
    code = await runRegistry(
      addOpts({
        name: "idem",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/idem.md"],
        project: projP,
      } as Parameters<typeof runRegistry>[0]),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      agents: { name: string; scope?: { type: string; paths: string[] } }[];
    };
    const entry = overlay.agents.find((a) => a.name === "idem");
    expect(entry!.scope).toEqual({
      type: "project",
      paths: [realpathOf(projP)],
    });
  });

  it("re-add --project Q against an existing GLOBAL entry → exit 1 with --scope project hint", async () => {
    let code = await runRegistry(
      addOpts({
        name: "globthenproj",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/globthenproj.md"],
      }),
    );
    expect(code).toBe(0);
    const projQ = join(projectRoot, "consumerB");
    mkdirSync(projQ, { recursive: true });
    const overlayBefore = readFileSync(overlayPath, "utf-8");
    code = await runRegistry(
      addOpts({
        name: "globthenproj",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/globthenproj.md"],
        project: projQ,
      } as Parameters<typeof runRegistry>[0]),
    );
    expect(code).toBe(1);
    // Overlay byte-unchanged — reject is non-destructive.
    expect(readFileSync(overlayPath, "utf-8")).toBe(overlayBefore);
  });

  it("--scope project --project Q on existing GLOBAL entry → CONVERT to project (paths=[realpath(Q)])", async () => {
    let code = await runRegistry(
      addOpts({
        name: "convert",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/convert.md"],
      }),
    );
    expect(code).toBe(0);
    const projQ = join(projectRoot, "consumerC");
    mkdirSync(projQ, { recursive: true });
    code = await runRegistry(
      addOpts({
        name: "convert",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/convert.md"],
        scope: "project",
        project: projQ,
      } as Parameters<typeof runRegistry>[0]),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      agents: { name: string; scope?: { type: string; paths: string[] } }[];
    };
    const entry = overlay.agents.find((a) => a.name === "convert");
    expect(entry!.scope).toEqual({
      type: "project",
      paths: [realpathOf(projQ)],
    });
  });

  it("--scope global on existing project entry → CONVERT to global (scope field DROPPED)", async () => {
    const projP = join(projectRoot, "consumerD");
    mkdirSync(projP, { recursive: true });
    let code = await runRegistry(
      addOpts({
        name: "globback",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/globback.md"],
        project: projP,
      } as Parameters<typeof runRegistry>[0]),
    );
    expect(code).toBe(0);
    code = await runRegistry(
      addOpts({
        name: "globback",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/globback.md"],
        scope: "global",
      } as Parameters<typeof runRegistry>[0]),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      agents: { name: string; scope?: unknown }[];
    };
    const entry = overlay.agents.find((a) => a.name === "globback");
    expect(entry).toBeDefined();
    expect("scope" in (entry as Record<string, unknown>)).toBe(false);
  });

  it("--scope global + --project is a USAGE error (exit 2)", async () => {
    const code = await runRegistry(
      addOpts({
        name: "badcombo",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/badcombo.md"],
        scope: "global",
        project: "/tmp/foo",
      } as Parameters<typeof runRegistry>[0]),
    );
    expect(code).toBe(2);
  });

  it("--scope project without --project is a USAGE error (exit 2)", async () => {
    const code = await runRegistry(
      addOpts({
        name: "badscope",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/badscope.md"],
        scope: "project",
      } as Parameters<typeof runRegistry>[0]),
    );
    expect(code).toBe(2);
  });
});

describe("registry add-skill — FR-155 scope", () => {
  const realpathOf = (p: string): string => {
    const fs = require("node:fs") as typeof import("node:fs");
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };

  /** Stage a real skills source tree under <projectRoot>/skills-mine/<name>/SKILL.md. */
  function stageSkillsSource(): string {
    const src = join(projectRoot, "skills-mine");
    mkdirSync(join(src, "widget"), { recursive: true });
    writeFileSync(
      join(src, "widget", "SKILL.md"),
      "---\nname: widget\ndescription: a widget\n---\n# widget\n\nbody\n",
    );
    return src;
  }

  function skillOpts(extra: Record<string, unknown>): Parameters<typeof runRegistry>[0] {
    return {
      action: "add-skill",
      projectRoot,
      overlayPath,
      originsPath,
      skillVendorDir,
      ...extra,
    } as Parameters<typeof runRegistry>[0];
  }

  it("default add-skill (no --scope, no --project) → block has no `scope` field", async () => {
    const src = stageSkillsSource();
    const code = await runRegistry(
      skillOpts({
        name: "myskills",
        from: src,
        targets: ["claude:symlink:.claude/skills"],
      }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: { scope?: unknown }[] };
    };
    const block = overlay.surfaces?.skills?.[0];
    expect(block).toBeDefined();
    expect("scope" in (block as Record<string, unknown>)).toBe(false);
  });

  it("--project P → block.scope === {type:'project', paths:[realpath(P)]}", async () => {
    const src = stageSkillsSource();
    const projP = join(projectRoot, "consumerSkillA");
    mkdirSync(projP, { recursive: true });
    const code = await runRegistry(
      skillOpts({
        name: "myskills",
        from: src,
        targets: ["claude:symlink:.claude/skills"],
        project: projP,
      }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: { scope?: { type: string; paths: string[] } }[] };
    };
    const block = overlay.surfaces?.skills?.[0];
    expect(block!.scope).toEqual({
      type: "project",
      paths: [realpathOf(projP)],
    });
  });

  it("re-add --project Q against existing project block → paths grows additively", async () => {
    const src = stageSkillsSource();
    const projP = join(projectRoot, "consumerSkillA");
    const projQ = join(projectRoot, "consumerSkillB");
    mkdirSync(projP, { recursive: true });
    mkdirSync(projQ, { recursive: true });
    let code = await runRegistry(
      skillOpts({
        name: "myskills",
        from: src,
        targets: ["claude:symlink:.claude/skills"],
        project: projP,
      }),
    );
    expect(code).toBe(0);
    code = await runRegistry(
      skillOpts({
        name: "myskills",
        from: src,
        targets: ["claude:symlink:.claude/skills"],
        project: projQ,
      }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: { scope?: { type: string; paths: string[] } }[] };
    };
    const block = overlay.surfaces?.skills?.[0];
    expect(block!.scope).toEqual({
      type: "project",
      paths: [realpathOf(projP), realpathOf(projQ)],
    });
  });

  it("re-add --project Q against existing GLOBAL block → exit 1 with --scope project hint", async () => {
    const src = stageSkillsSource();
    let code = await runRegistry(
      skillOpts({
        name: "myskills",
        from: src,
        targets: ["claude:symlink:.claude/skills"],
      }),
    );
    expect(code).toBe(0);
    const projQ = join(projectRoot, "consumerSkillC");
    mkdirSync(projQ, { recursive: true });
    const overlayBefore = readFileSync(overlayPath, "utf-8");
    code = await runRegistry(
      skillOpts({
        name: "myskills",
        from: src,
        targets: ["claude:symlink:.claude/skills"],
        project: projQ,
      }),
    );
    expect(code).toBe(1);
    expect(readFileSync(overlayPath, "utf-8")).toBe(overlayBefore);
  });

  it("--scope project --project Q on existing GLOBAL block → CONVERT to project", async () => {
    const src = stageSkillsSource();
    let code = await runRegistry(
      skillOpts({
        name: "myskills",
        from: src,
        targets: ["claude:symlink:.claude/skills"],
      }),
    );
    expect(code).toBe(0);
    const projQ = join(projectRoot, "consumerSkillD");
    mkdirSync(projQ, { recursive: true });
    code = await runRegistry(
      skillOpts({
        name: "myskills",
        from: src,
        targets: ["claude:symlink:.claude/skills"],
        scope: "project",
        project: projQ,
      }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: { scope?: { type: string; paths: string[] } }[] };
    };
    const block = overlay.surfaces?.skills?.[0];
    expect(block!.scope).toEqual({
      type: "project",
      paths: [realpathOf(projQ)],
    });
  });

  it("--scope global on existing project block → CONVERT to global (scope field DROPPED)", async () => {
    const src = stageSkillsSource();
    const projP = join(projectRoot, "consumerSkillE");
    mkdirSync(projP, { recursive: true });
    let code = await runRegistry(
      skillOpts({
        name: "myskills",
        from: src,
        targets: ["claude:symlink:.claude/skills"],
        project: projP,
      }),
    );
    expect(code).toBe(0);
    code = await runRegistry(
      skillOpts({
        name: "myskills",
        from: src,
        targets: ["claude:symlink:.claude/skills"],
        scope: "global",
      }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: { scope?: unknown }[] };
    };
    const block = overlay.surfaces?.skills?.[0];
    expect("scope" in (block as Record<string, unknown>)).toBe(false);
  });

  it("--scope global + --project is a USAGE error (exit 2)", async () => {
    const src = stageSkillsSource();
    const code = await runRegistry(
      skillOpts({
        name: "myskills",
        from: src,
        targets: ["claude:symlink:.claude/skills"],
        scope: "global",
        project: "/tmp/foo",
      }),
    );
    expect(code).toBe(2);
  });

  it("--scope project without --project is a USAGE error (exit 2)", async () => {
    const src = stageSkillsSource();
    const code = await runRegistry(
      skillOpts({
        name: "myskills",
        from: src,
        targets: ["claude:symlink:.claude/skills"],
        scope: "project",
      }),
    );
    expect(code).toBe(2);
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
    // TD-191: agent origin keyed `agent:<name>`.
    expect("agent:only" in readOriginsFile()).toBe(true);

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
    expect("agent:only" in readOriginsFile()).toBe(false);
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

  it("preserves a surfaces.skills array across add+remove", async () => {
    // TD-191: `surfaces.skills` is an array of blocks. Each block must satisfy
    // $defs.skills_surface. The agent add/remove round-trip must leave the
    // skills array untouched.
    const skillsBlock = {
      source: "/abs/skills",
      layer: "personal",
      targets: [{ type: "codex", method: "symlink", path: ".codex/skills" }],
    };
    writeFileSync(
      overlayPath,
      JSON.stringify({
        version: 1,
        agents: [],
        surfaces: { skills: [skillsBlock] },
      }),
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
    expect(overlay.surfaces).toEqual({ skills: [skillsBlock] });
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
// FR-143 / TD-191: add-skill (surfaces.skills array — copy-vendor + origin per L-516/L-519)
// ---------------------------------------------------------------------------

/**
 * Build add-skill opts; `name` + `from` default to a real single-skill dir
 * under projectRoot. TD-191: `add-skill` is now copy-vendor (L-516) so the
 * source must contain a SKILL.md (single-skill source: `from = <skill>/`).
 */
function skillOpts(
  extra: Record<string, unknown>,
): Parameters<typeof runRegistry>[0] {
  return {
    action: "add-skill",
    projectRoot,
    overlayPath,
    originsPath,
    vendorDir,
    skillVendorDir,
    name: "demo",
    from: "skills/demo",
    ...extra,
  } as Parameters<typeof runRegistry>[0];
}

describe("registry add-skill", () => {
  beforeEach(() => {
    // A live skills source: `skills/demo/SKILL.md` (TD-191 single-skill shape;
    // the vendor primitive copies it as `<vendoredDir>/demo/SKILL.md`).
    mkdirSync(join(projectRoot, "skills", "demo"), { recursive: true });
    writeFileSync(
      join(projectRoot, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: d\n---\nbody\n",
    );
  });

  it("vendors the skill tree, writes a schema-valid block array, records skill origin", async () => {
    const code = await runRegistry(
      skillOpts({
        targets: [
          "codex:symlink:.codex/skills",
          "gemini:symlink:.gemini/skills",
        ],
      }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: unknown[] };
    };
    const skillsArr = overlay.surfaces?.skills;
    // TD-191: `surfaces.skills` is an ARRAY of blocks.
    expect(Array.isArray(skillsArr)).toBe(true);
    expect(skillsArr).toHaveLength(1);
    const block = (skillsArr as Record<string, unknown>[])[0];
    expect(block.layer).toBe("personal");
    // L-516: source is the VENDORED tree path (NOT the consumer's external dir).
    expect(block.source).toBe(join(vendorBase, "skills", "demo"));
    expect(block.targets).toEqual([
      { type: "codex", method: "symlink", path: ".codex/skills" },
      { type: "gemini", method: "symlink", path: ".gemini/skills" },
    ]);
    // The written block validates against the schema port.
    expect(validateSkillsSurface(block)).toBeNull();
    // L-517: vendored tree exists at registrySkillDirPath("demo")/demo/SKILL.md
    // (the test-seam vendorDir resolves to vendorBase/skills/<name>).
    const vendored = join(vendorBase, "skills", "demo", "demo", "SKILL.md");
    expect(existsSync(vendored)).toBe(true);
    expect(readFileSync(vendored, "utf-8")).toBe(
      readFileSync(join(projectRoot, "skills", "demo", "SKILL.md"), "utf-8"),
    );
    // Origin recorded under namespaced key `skill:demo`.
    const origins = readOriginsFile() as Record<string, Record<string, unknown>>;
    expect(origins["skill:demo"].type).toBe("path");
    expect(origins["skill:demo"].dir).toBe(join(projectRoot, "skills", "demo"));
    expect(origins["skill:demo"].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("multi-source: a second add-skill with a NEW name appends another block", async () => {
    // Set up a second skill source.
    mkdirSync(join(projectRoot, "skills", "other"), { recursive: true });
    writeFileSync(
      join(projectRoot, "skills", "other", "SKILL.md"),
      "---\nname: other\ndescription: o\n---\nother body\n",
    );
    await runRegistry(skillOpts({ targets: ["codex:symlink:.codex/skills-demo"] }));
    const code = await runRegistry(
      skillOpts({
        name: "other",
        from: "skills/other",
        targets: ["codex:symlink:.codex/skills-other"],
      }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: Record<string, unknown>[] };
    };
    expect(overlay.surfaces?.skills).toHaveLength(2);
    expect(overlay.surfaces?.skills?.[0].source).toBe(
      join(vendorBase, "skills", "demo"),
    );
    expect(overlay.surfaces?.skills?.[1].source).toBe(
      join(vendorBase, "skills", "other"),
    );
    // Both origins are recorded under namespaced keys.
    const origins = readOriginsFile();
    expect("skill:demo" in origins).toBe(true);
    expect("skill:other" in origins).toBe(true);
  });

  it("same-name re-add updates the existing block IN PLACE (re-vendor, hash advance)", async () => {
    await runRegistry(skillOpts({ targets: ["codex:symlink:.codex/skills"] }));
    const hashBefore = (
      readOriginsFile() as Record<string, Record<string, unknown>>
    )["skill:demo"].hash as string;

    // Mutate the source.
    writeFileSync(
      join(projectRoot, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: d\n---\nMUTATED body\n",
    );
    const code = await runRegistry(
      skillOpts({ targets: ["codex:symlink:.codex/skills"] }),
    );
    expect(code).toBe(0);
    // Overlay still has ONE block (in-place update, not append).
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: unknown[] };
    };
    expect(overlay.surfaces?.skills).toHaveLength(1);
    // Vendored tree reflects new bytes.
    expect(
      readFileSync(
        join(vendorBase, "skills", "demo", "demo", "SKILL.md"),
        "utf-8",
      ),
    ).toBe(
      "---\nname: demo\ndescription: d\n---\nMUTATED body\n",
    );
    // Hash advanced.
    const hashAfter = (
      readOriginsFile() as Record<string, Record<string, unknown>>
    )["skill:demo"].hash as string;
    expect(hashAfter).not.toBe(hashBefore);
  });

  it("same-name re-add unions targets (idempotent for an exact dup)", async () => {
    await runRegistry(skillOpts({ targets: ["codex:symlink:.codex/skills-demo"] }));
    // Adding a NEW target path for the SAME skill — appended to the same block.
    const code = await runRegistry(
      skillOpts({
        targets: ["gemini:symlink:.gemini/skills"],
      }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: { targets: unknown[] }[] };
    };
    expect(overlay.surfaces?.skills).toHaveLength(1);
    expect(overlay.surfaces?.skills?.[0].targets).toEqual([
      { type: "codex", method: "symlink", path: ".codex/skills-demo" },
      { type: "gemini", method: "symlink", path: ".gemini/skills" },
    ]);
    // An exact re-run is idempotent (same paths union to same set).
    const before = readFileSync(overlayPath, "utf-8");
    const code2 = await runRegistry(
      skillOpts({ targets: ["codex:symlink:.codex/skills-demo"] }),
    );
    expect(code2).toBe(0);
    const overlay2 = readOverlayFile() as {
      surfaces?: { skills?: { targets: unknown[] }[] };
    };
    expect(overlay2.surfaces?.skills?.[0].targets).toEqual([
      { type: "codex", method: "symlink", path: ".codex/skills-demo" },
      { type: "gemini", method: "symlink", path: ".gemini/skills" },
    ]);
    // (overlay can re-write but the bytes after JSON normalization match)
    void before;
  });

  it("same-name re-add WITHOUT --from re-vendors from the recorded origin dir", async () => {
    await runRegistry(skillOpts({ targets: ["codex:symlink:.codex/skills"] }));
    // Mutate the source (consumer side).
    writeFileSync(
      join(projectRoot, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: d\n---\nSECOND PASS\n",
    );
    // No --from: writer should fall back to the recorded origin's dir.
    const code = await runRegistry({
      action: "add-skill",
      name: "demo",
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      skillVendorDir,
      targets: ["codex:symlink:.codex/skills"],
    });
    expect(code).toBe(0);
    // Vendored tree picks up the mutation.
    expect(
      readFileSync(
        join(vendorBase, "skills", "demo", "demo", "SKILL.md"),
        "utf-8",
      ),
    ).toBe("---\nname: demo\ndescription: d\n---\nSECOND PASS\n");
  });

  it("first-time --from is REQUIRED (exit 2 with no recorded origin)", async () => {
    const code = await runRegistry({
      action: "add-skill",
      name: "newname",
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      targets: ["codex:symlink:.codex/skills"],
    });
    expect(code).toBe(2);
  });

  it("rejects a target path duplicated in another (sibling) overlay block (exit 1, unchanged)", async () => {
    // First block claims AGENTS.md.
    await runRegistry(skillOpts({ targets: ["codex:symlink:.codex/skills"] }));
    // Second skill, different name, but the SAME target path → reject.
    mkdirSync(join(projectRoot, "skills", "other"), { recursive: true });
    writeFileSync(
      join(projectRoot, "skills", "other", "SKILL.md"),
      "---\nname: other\ndescription: o\n---\nbody\n",
    );
    const before = readFileSync(overlayPath, "utf-8");
    const code = await runRegistry(
      skillOpts({
        name: "other",
        from: "skills/other",
        targets: ["codex:symlink:.codex/skills"],
      }),
    );
    expect(code).toBe(1);
    expect(readFileSync(overlayPath, "utf-8")).toBe(before);
  });

  it("rejects a path colliding with a CORE skill-target at write-time (exit 1, unchanged)", async () => {
    // Seed a base manifest carrying a core skill-target path. TD-191: schema
    // requires `surfaces.skills` to be an ARRAY of blocks; loaders normalize
    // legacy single-object too, but here we use the modern array shape so
    // the readBaseSkillTargetPaths multi-block iteration is exercised.
    writeFileSync(
      join(projectRoot, "harness-manifest.json"),
      JSON.stringify({
        version: 1,
        agents: [],
        surfaces: {
          skills: [
            {
              source: "core/skills",
              targets: [
                { type: "codex", method: "symlink", path: ".codex/skills" },
              ],
            },
          ],
        },
      }),
    );
    const code = await runRegistry(
      skillOpts({ targets: ["codex:symlink:.codex/skills"] }),
    );
    expect(code).toBe(1);
    // Overlay never written (collision rejected before persist).
    expect(existsSync(overlayPath)).toBe(false);
    // Vendor never touched (collision rejected BEFORE the vendor step).
    expect(existsSync(join(vendorBase, "skills", "demo"))).toBe(false);
  });

  it("requires name + at least one target (usage error exit 2)", async () => {
    expect(
      await runRegistry({
        action: "add-skill",
        overlayPath,
        from: "skills/demo",
        targets: ["codex:symlink:.codex/skills"],
      }),
    ).toBe(2);
    expect(
      await runRegistry({
        action: "add-skill",
        overlayPath,
        projectRoot,
        name: "demo",
        from: "skills/demo",
        targets: [],
      }),
    ).toBe(2);
  });

  it("rejects a nonexistent source dir (exit 1)", async () => {
    const code = await runRegistry(
      skillOpts({ from: "does-not-exist", targets: ["codex:symlink:.codex/skills"] }),
    );
    expect(code).toBe(1);
  });

  it("L-517: vendored tree lands under registry/skills/<name>/<name>/SKILL.md (nesting preserved)", async () => {
    // The L-519 standard format requires `<name>/SKILL.md` nesting (the
    // per-harness `find -mindepth 2 -maxdepth 2` walks in compile_harnesses.sh
    // would break on a flattened layout). Asserts the vendor primitive
    // preserves the tree shape.
    await runRegistry(skillOpts({ targets: ["codex:symlink:.codex/skills"] }));
    // Nested: <vendoredDir>/<name>/SKILL.md, NOT <vendoredDir>/SKILL.md.
    expect(
      existsSync(join(vendorBase, "skills", "demo", "demo", "SKILL.md")),
    ).toBe(true);
    expect(existsSync(join(vendorBase, "skills", "demo", "SKILL.md"))).toBe(
      false,
    );
  });

  it("origin namespace: agent:<name> and skill:<name> coexist for the same name (no collision)", async () => {
    // Add an agent named 'demo' AND a skill named 'demo'.
    await runRegistry(
      addOpts({
        name: "demo",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/demo.md"],
      }),
    );
    await runRegistry(skillOpts({ targets: ["codex:symlink:.codex/skills"] }));
    const origins = readOriginsFile();
    expect("agent:demo" in origins).toBe(true);
    expect("skill:demo" in origins).toBe(true);
    // The unprefixed key MUST NOT exist (the brief calls this collision out).
    expect("demo" in origins).toBe(false);
  });
});

describe("registry add-skill — type:method:path parsing", () => {
  beforeEach(() => {
    mkdirSync(join(projectRoot, "skills", "demo"), { recursive: true });
    writeFileSync(
      join(projectRoot, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: d\n---\nbody\n",
    );
  });

  it("parses a valid triple", async () => {
    const code = await runRegistry(
      skillOpts({ targets: ["gemini:symlink:.gemini/skills"] }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: { targets: unknown[] }[] };
    };
    expect(overlay.surfaces?.skills?.[0].targets).toEqual([
      { type: "gemini", method: "symlink", path: ".gemini/skills" },
    ]);
  });

  it("preserves a path containing a colon", async () => {
    const code = await runRegistry(
      skillOpts({ targets: ["codex:symlink:dir:with:colons/.codex/skills"] }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: { targets: { path: string }[] }[] };
    };
    expect(overlay.surfaces?.skills?.[0].targets[0].path).toBe(
      "dir:with:colons/.codex/skills",
    );
  });

  it("FR-151: accepts codex:symlink:<path> (widened pair allowlist)", async () => {
    // FR-149 originally rejected `codex/symlink`; FR-151 widens the allowlist
    // to admit codex/symlink + gemini/symlink for the unified harness work
    // (FR-152/FR-153). See L-519.
    const code = await runRegistry(
      skillOpts({ targets: ["codex:symlink:.codex/skills"] }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: { targets: unknown[] }[] };
    };
    expect(overlay.surfaces?.skills?.[0].targets).toEqual([
      { type: "codex", method: "symlink", path: ".codex/skills" },
    ]);
  });

  it("FR-151: accepts gemini:symlink:<path> (widened pair allowlist)", async () => {
    // FR-149's gemini target was only valid with `converter`; FR-151 admits
    // gemini/symlink as a first-class projection pair.
    const code = await runRegistry(
      skillOpts({ targets: ["gemini:symlink:.gemini/skills"] }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: { targets: unknown[] }[] };
    };
    expect(overlay.surfaces?.skills?.[0].targets).toEqual([
      { type: "gemini", method: "symlink", path: ".gemini/skills" },
    ]);
  });

  it("rejects a bad method (exit 2)", async () => {
    const code = await runRegistry(
      skillOpts({ targets: ["codex:bogus:AGENTS.md"] }),
    );
    expect(code).toBe(2);
  });

  it("rejects a missing third part (exit 2)", async () => {
    const code = await runRegistry(
      skillOpts({ targets: ["codex:compiler"] }),
    );
    expect(code).toBe(2);
  });

  // FR-149: claude is now a first-class skills target via the symlink method.
  // The parser accepts claude/symlink, rejects claude/compiler and gemini/compiler,
  // and runAddSkill refuses a claude:symlink:<path> that lands inside the registry.

  it("FR-149: accepts claude:symlink:<path>", async () => {
    const code = await runRegistry(
      skillOpts({ targets: ["claude:symlink:.claude/skills"] }),
    );
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      surfaces?: { skills?: { targets: unknown[] }[] };
    };
    expect(overlay.surfaces?.skills?.[0].targets).toEqual([
      { type: "claude", method: "symlink", path: ".claude/skills" },
    ]);
  });

  it("FR-149: rejects claude:compiler:<path> with pair allowlist message", async () => {
    const code = await runRegistry(
      skillOpts({ targets: ["claude:compiler:AGENTS.md"] }),
    );
    expect(code).toBe(2);
  });

  it("FR-149: rejects gemini:compiler:<path> with pair allowlist message", async () => {
    const code = await runRegistry(
      skillOpts({ targets: ["gemini:compiler:AGENTS.md"] }),
    );
    expect(code).toBe(2);
  });

  it("FR-149: runAddSkill rejects claude:symlink:<path> pointing inside the registry (cycle)", async () => {
    // The target path resolves to ~/.igris/registry/skills (or similar) — pointing
    // a symlink target INSIDE the registry would create a self-loop. The writer
    // must reject pre-vendor so neither the overlay nor the vendor tree change.
    const overlayBefore = existsSync(overlayPath)
      ? readFileSync(overlayPath, "utf-8")
      : null;
    // Sandbox the registry under tmpRoot via IGRIS_BRAIN_DIR for this test only.
    const prevBrainDir = process.env.IGRIS_BRAIN_DIR;
    process.env.IGRIS_BRAIN_DIR = join(tmpRoot, ".igris");
    try {
      const code = await runRegistry(
        skillOpts({
          // resolves under the sandboxed registry root via IGRIS_BRAIN_DIR.
          targets: [`claude:symlink:${join(tmpRoot, ".igris", "registry", "skills")}`],
        }),
      );
      expect(code).toBe(1);
    } finally {
      if (prevBrainDir === undefined) {
        delete process.env.IGRIS_BRAIN_DIR;
      } else {
        process.env.IGRIS_BRAIN_DIR = prevBrainDir;
      }
    }
    // Overlay file is UNCHANGED on this reject.
    if (overlayBefore === null) {
      expect(existsSync(overlayPath)).toBe(false);
    } else {
      expect(readFileSync(overlayPath, "utf-8")).toBe(overlayBefore);
    }
    // The vendored copy was NOT written (containment guard fires pre-vendor).
    expect(existsSync(join(vendorBase, "skills", "demo"))).toBe(false);
  });
});

describe("validateSkillsSurface (schema port)", () => {
  const valid = {
    source: "/abs/skills",
    layer: "personal",
    targets: [{ type: "codex", method: "symlink", path: ".codex/skills" }],
  };

  it("accepts a valid block", () => {
    expect(validateSkillsSurface(valid)).toBeNull();
  });

  it("rejects a stray key (additionalProperties:false)", () => {
    expect(validateSkillsSurface({ ...valid, bogus: 1 })).toMatch(
      /additionalProperties/,
    );
  });

  it("rejects missing targets", () => {
    expect(validateSkillsSurface({ source: "/abs/skills" })).toMatch(/targets/);
  });

  it("rejects empty targets", () => {
    expect(validateSkillsSurface({ ...valid, targets: [] })).toMatch(
      /non-empty array/,
    );
  });

  it("rejects a bad target type", () => {
    expect(
      validateSkillsSurface({
        ...valid,
        targets: [{ type: "claude", method: "compiler", path: "p" }],
      }),
    ).toMatch(/type/);
  });

  it("rejects a bad target method", () => {
    expect(
      validateSkillsSurface({
        ...valid,
        targets: [{ type: "codex", method: "bogus", path: "p" }],
      }),
    ).toMatch(/method/);
  });

  it("rejects a stray target key", () => {
    expect(
      validateSkillsSurface({
        ...valid,
        targets: [
          { type: "codex", method: "symlink", path: "p", extra: 1 },
        ],
      }),
    ).toMatch(/additionalProperties/);
  });
});

describe("validateSkillsSurfaceArray (TD-191 array gate)", () => {
  const validBlock = {
    source: "/abs/skills",
    layer: "personal",
    targets: [{ type: "codex", method: "symlink", path: ".codex/skills" }],
  };

  it("accepts a 1-block valid array", () => {
    expect(validateSkillsSurfaceArray([validBlock])).toBeNull();
  });

  it("accepts a 2-block valid array (multi-source)", () => {
    expect(
      validateSkillsSurfaceArray([
        validBlock,
        {
          source: "/abs/skills-other",
          layer: "personal",
          targets: [
            { type: "gemini", method: "symlink", path: ".gemini/skills" },
          ],
        },
      ]),
    ).toBeNull();
  });

  it("rejects non-array input", () => {
    expect(validateSkillsSurfaceArray({})).toMatch(/non-empty array/);
    expect(validateSkillsSurfaceArray("not-an-array")).toMatch(
      /non-empty array/,
    );
    expect(validateSkillsSurfaceArray(null)).toMatch(/non-empty array/);
  });

  it("rejects empty array", () => {
    expect(validateSkillsSurfaceArray([])).toMatch(/non-empty array/);
  });

  it("rejects a one-bad-block array, prefixed with surfaces.skills[i]:", () => {
    expect(
      validateSkillsSurfaceArray([
        validBlock,
        { source: "/abs", layer: "personal", targets: [] }, // empty targets
      ]),
    ).toMatch(/^surfaces\.skills\[1\]:/);
    expect(
      validateSkillsSurfaceArray([
        { source: "/abs", layer: "personal", targets: [] },
      ]),
    ).toMatch(/^surfaces\.skills\[0\]:.*non-empty array/);
  });

  it("rejects a bad target enum inside an otherwise-valid block", () => {
    expect(
      validateSkillsSurfaceArray([
        {
          source: "/abs",
          layer: "personal",
          targets: [{ type: "claude", method: "compiler", path: "AGENTS.md" }],
        },
      ]),
    ).toMatch(/surfaces\.skills\[0\].*claude/);
  });
});

describe("TD-191 back-compat: legacy single-object surfaces.skills", () => {
  it("readBaseSkillTargetPaths normalizes a legacy single-object base manifest", async () => {
    // The writer's core-collision guard MUST see the path from a legacy
    // single-object base manifest (back-compat read normalize). Verified
    // indirectly: an add-skill that collides with a legacy base path is
    // rejected.
    mkdirSync(join(projectRoot, "skills", "demo"), { recursive: true });
    writeFileSync(
      join(projectRoot, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: d\n---\nbody\n",
    );
    // LEGACY base manifest shape: surfaces.skills is a SINGLE object (pre-TD-191).
    writeFileSync(
      join(projectRoot, "harness-manifest.json"),
      JSON.stringify({
        version: 1,
        agents: [],
        surfaces: {
          skills: {
            source: "core/skills",
            targets: [
              { type: "codex", method: "symlink", path: ".codex/skills" },
            ],
          },
        },
      }),
    );
    const code = await runRegistry({
      action: "add-skill",
      name: "demo",
      from: "skills/demo",
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      skillVendorDir,
      targets: ["codex:symlink:.codex/skills"],
    });
    // Legacy single-object's path was seen by the guard → collision → exit 1.
    expect(code).toBe(1);
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
    // TD-191: agent origins keyed `agent:<name>`.
    const hashBefore = readOriginsFile()["agent:u1"].hash;
    const code = await runRegistry({
      action: "update",
      name: "u1",
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code).toBe(0);
    expect(readOriginsFile()["agent:u1"].hash).toBe(hashBefore);
  });

  it("reports changed after the source mutates; re-vendors + updates hash, overlay unchanged", async () => {
    await seedAdd("u2");
    const overlayBefore = readFileSync(overlayPath, "utf-8");
    const hashBefore = readOriginsFile()["agent:u2"].hash;
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
    expect(readOriginsFile()["agent:u2"].hash).not.toBe(hashBefore);
    expect(readFileSync(overlayPath, "utf-8")).toBe(overlayBefore);
  });

  it("--all updates every path-origin entry (mixed changed/unchanged)", async () => {
    // FR-156: tree-vendor takes the WHOLE source dir, so two agents that
    // share one canon/ dir would drift in lockstep — give each its own
    // source subdir to keep the mixed-state test meaningful.
    mkdirSync(join(projectRoot, "canon_a"), { recursive: true });
    mkdirSync(join(projectRoot, "canon_b"), { recursive: true });
    writeFileSync(join(projectRoot, "canon_a", "a.md"), "alpha\n");
    writeFileSync(join(projectRoot, "canon_b", "b.md"), "beta\n");
    await seedAdd("ua", "canon_a/a.md");
    await seedAdd("ub", "canon_b/b.md");
    const hashA = readOriginsFile()["agent:ua"].hash;
    const hashB = readOriginsFile()["agent:ub"].hash;
    // Mutate only canon_a/a.md.
    writeFileSync(join(projectRoot, "canon_a", "a.md"), "alpha-CHANGED\n");
    const code = await runRegistry({
      action: "update",
      all: true,
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code).toBe(0);
    expect(readOriginsFile()["agent:ua"].hash).not.toBe(hashA);
    expect(readOriginsFile()["agent:ub"].hash).toBe(hashB);
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
    // TD-191: namespaced under `agent:<name>`.
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
    origins["agent:ghorigin"] = {
      type: "github",
      dir: "owner/repo@main",
      hash: "deadbeef",
    };
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
    expect(readOriginsFile()["agent:ghorigin"].hash).toBe("deadbeef");
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
    const hashBefore = readOriginsFile()["agent:vupd"].hash;
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
    expect(readOriginsFile()["agent:vupd"].hash).not.toBe(hashBefore);
  });

  it("FR-151: hash advances when frontmatter.md mutates", async () => {
    // Seed an agent with a frontmatter.md sidecar. The hash is folded over
    // BOTH files (canonical + sidecar). Mutating only the sidecar must still
    // cause `update` to re-vendor and report a hash advance — proving the
    // sidecar bytes participate in the content hash.
    writeFileSync(
      join(projectRoot, "canon", "frontmatter.md"),
      "---\nname: fmhash\nv: 1\n---\n",
    );
    await seedAdd("fmhash");
    expect(existsSync(join(vendorDir("fmhash"), "frontmatter.md"))).toBe(true);
    const hashBefore = readOriginsFile()["agent:fmhash"].hash;

    // Mutate ONLY the sidecar — the canonical x.md is untouched.
    writeFileSync(
      join(projectRoot, "canon", "frontmatter.md"),
      "---\nname: fmhash\nv: 2\n---\n",
    );
    const code = await runRegistry({
      action: "update",
      name: "fmhash",
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code).toBe(0);
    // Re-vendored sidecar reflects the new bytes.
    expect(
      readFileSync(join(vendorDir("fmhash"), "frontmatter.md"), "utf-8"),
    ).toBe("---\nname: fmhash\nv: 2\n---\n");
    // Hash advanced (sidecar participates in the content hash).
    expect(readOriginsFile()["agent:fmhash"].hash).not.toBe(hashBefore);
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
    expect(origins["agent:mypack"].type).toBe("github");
    expect(origins["agent:mypack"].repo).toBe("owner/repo");
    expect(origins["agent:mypack"].ref).toBe("v1.0.0");
    expect(origins["agent:mypack"].sha).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(origins["agent:mypack"].hash).toMatch(/^[0-9a-f]{64}$/);
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
    expect(origins["agent:mypack"].subdir).toBe("packs");
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
    expect(origins["agent:mypack"].ref).toBe("v1.0.0");
    expect(origins["agent:mypack"].sha).toBe("aaaaaaaaaaaaaaaa");
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
      (readOriginsFile() as Record<string, Record<string, unknown>>)[
        "agent:mypack"
      ].ref,
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
    expect(origins["agent:mypack"].ref).toBe("v1.1.0");
    expect(origins["agent:mypack"].sha).toBe("bbbbbbbbbbbbbbbb");
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
    expect(origins["agent:mypack"].type).toBe("github");
    expect(origins["agent:localpack"].type).toBe("path");
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
    // Canonical prompt (unversioned) at canon/mycustom.md. FR-152: includes
    // inline frontmatter so the TD-195 fallback in resolve_or_extract_frontmatter
    // (compile_harnesses.sh) can produce a TOML for the codex target.
    mkdirSync(join(fixtureRoot, "canon"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "canon", "mycustom.md"),
      "---\nname: mycustom\ndescription: personal agent\n---\n\n# mycustom\n\nPersonal agent body.\n",
    );
    // Target dir for the produced codex harness. (We use a codex target, not
    // claude: under FR-152 claude is a registry-anchored symlink to an
    // assembled harness.md, while sync_codex_agents.sh GENERATES the .toml
    // fresh — proving auto-discovery produced output without a pre-seeded
    // target.)
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
    // exercise registryOverlayPath()/registryAgentDirPath()/registryOriginsPath()
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
    // TD-191 L-517: the vendored agent copy lives at registry/agents/<name>/.
    const vendored = join(brainDir, "registry", "agents", "mycustom", "mycustom.md");
    expect(existsSync(vendored)).toBe(true);
    // The L-517 invariant: nothing loose at the registry root (only catalog
    // files + typed subfolders).
    const registryRoot = join(brainDir, "registry");
    const rootEntries = readdirSync(registryRoot).sort();
    // Allow: harness-manifest.personal.json, origins.json, agents/, plus any
    // future typed subfolder if the test happened to seed one (here: agents/).
    for (const entry of rootEntries) {
      expect(
        entry === "harness-manifest.personal.json" ||
          entry === "origins.json" ||
          entry === "agents" ||
          entry === "skills" ||
          entry === "body-exceptions",
      ).toBe(true);
    }

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
      "---\nname: mycustom\ndescription: personal agent\n---\n\n# mycustom\n\nUPDATED personal agent body marker XYZZY.\n",
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

  it("add-skill overlay: REAL compiler --surface skills projects the personal block ALONGSIDE the core block (multi-source)", async () => {
    if (!toolingAvailable()) {
      return;
    }
    process.env.IGRIS_BRAIN_DIR = brainDir;

    // TD-191 semantics: `surfaces.skills` is an ARRAY of blocks. Each block
    // carries its OWN source/layer/targets. The personal block compiles
    // ALONGSIDE the core block — they are SIBLINGS in the array, NOT a
    // shared-source-with-unioned-targets pair (which was the pre-TD-191
    // model). The core block here uses its own skills source; the personal
    // block carries a DIFFERENT skills source (the writer vendors it under
    // ~/.igris/registry/skills/<name>/).
    const coreSkillsRoot = join(fixtureRoot, "skills-core");
    mkdirSync(join(coreSkillsRoot, "alpha"), { recursive: true });
    writeFileSync(
      join(coreSkillsRoot, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: core alpha\n---\nALPHA CORE BODY\n",
    );

    const personalSkillsRoot = join(fixtureRoot, "skills-mine");
    mkdirSync(join(personalSkillsRoot, "mine"), { recursive: true });
    writeFileSync(
      join(personalSkillsRoot, "mine", "SKILL.md"),
      "---\nname: mine\ndescription: personal mine\n---\nMINE PERSONAL BODY\n",
    );

    const coreOut = join(fixtureRoot, "gemini-core");
    const personalOut = join(fixtureRoot, "gemini-personal");
    writeFileSync(
      join(fixtureRoot, "harness-manifest.json"),
      JSON.stringify({
        version: 1,
        agents: [],
        surfaces: {
          skills: [
            {
              source: coreSkillsRoot,
              layer: "core",
              targets: [
                { type: "gemini", method: "symlink", path: coreOut },
              ],
            },
          ],
        },
      }),
    );

    // Write the personal overlay via the REAL verb (TD-191: copy-vendor mode,
    // namespaced origin, registry/skills/<name>/ vendored tree). Drive
    // through IGRIS_BRAIN_DIR.
    const writtenOverlay = join(
      brainDir,
      "registry",
      "harness-manifest.personal.json",
    );
    const addCode = await runRegistry({
      action: "add-skill",
      name: "mine",
      from: join(personalSkillsRoot, "mine"),
      targets: [`gemini:symlink:${personalOut}`],
      projectRoot: fixtureRoot,
    });
    expect(addCode).toBe(0);
    expect(existsSync(writtenOverlay)).toBe(true);
    // Vendored tree lives under registry/skills/<name>/ per L-517.
    const vendoredSkill = join(
      brainDir,
      "registry",
      "skills",
      "mine",
      "mine",
      "SKILL.md",
    );
    expect(existsSync(vendoredSkill)).toBe(true);

    // The overlay passes the REAL validate_manifest (surfaces sub-shape).
    const validate = execFileSync(
      "bash",
      [
        "-c",
        `source "${COMMON_SH}" && validate_manifest "${writtenOverlay}" "${SCHEMA}"`,
      ],
      { encoding: "utf-8", env: { ...process.env, IGRIS_BRAIN_DIR: brainDir } },
    );
    expect(typeof validate).toBe("string");

    // Run the REAL compiler restricted to the skills surface. It auto-
    // discovers the personal overlay, concatenates blocks (core + personal),
    // and projects BOTH blocks from their OWN sources.
    execFileSync(
      "bash",
      [COMPILE_SH, "--project-root", fixtureRoot, "--surface", "skills"],
      { encoding: "utf-8", env: { ...process.env, IGRIS_BRAIN_DIR: brainDir } },
    );
    // FR-153: per-skill symlinks at <out>/<name> → <source>/<name>.
    // Core block projected — alpha symlink from the core source.
    expect(existsSync(join(coreOut, "alpha"))).toBe(true);
    // Personal block projected — mine symlink from the personal vendored source.
    expect(existsSync(join(personalOut, "mine"))).toBe(true);
    // (Cross-source isolation: the core source's alpha skill MUST NOT land
    // in the personal target, and vice versa — proves the per-block source
    // selection works.)
    expect(existsSync(join(personalOut, "alpha"))).toBe(false);
    expect(existsSync(join(coreOut, "mine"))).toBe(false);
    // The personal target's body proves the vendored source was read (follow
    // the symlink to the original SKILL.md content).
    const minePersonal = readFileSync(
      join(personalOut, "mine", "SKILL.md"),
      "utf-8",
    );
    expect(minePersonal).toContain("MINE PERSONAL BODY");
  });

  it("INTEGRATION #11: REAL validate_manifest accepts the writer's array-shape overlay (jsonschema + structural-fallback agree)", async () => {
    if (!toolingAvailable()) {
      return;
    }
    // L-159/L-173: subprocess validate_manifest, no vi.mock of the bash.
    // This closes the schema/structural-fallback parity loop end-to-end.
    process.env.IGRIS_BRAIN_DIR = brainDir;

    // Stage TWO sibling personal skills so the writer produces a 2-block
    // overlay array — the post-TD-191 shape. Empty base manifest (no core
    // skills) keeps the merge guard from rejecting; we're just exercising
    // the validator against a multi-block array overlay.
    const skillsRoot = join(fixtureRoot, "skills");
    mkdirSync(join(skillsRoot, "alpha"), { recursive: true });
    writeFileSync(
      join(skillsRoot, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: a\n---\nalpha body\n",
    );
    mkdirSync(join(skillsRoot, "beta"), { recursive: true });
    writeFileSync(
      join(skillsRoot, "beta", "SKILL.md"),
      "---\nname: beta\ndescription: b\n---\nbeta body\n",
    );
    // Base manifest carries NO skills block (empty agents + no surfaces).
    writeFileSync(
      join(fixtureRoot, "harness-manifest.json"),
      JSON.stringify({ version: 1, agents: [] }),
    );

    const writtenOverlay = join(
      brainDir,
      "registry",
      "harness-manifest.personal.json",
    );
    // First add-skill: appends block 1.
    expect(
      await runRegistry({
        action: "add-skill",
        name: "alpha",
        from: join(skillsRoot, "alpha"),
        targets: ["codex:symlink:.codex/skills-alpha"],
        projectRoot: fixtureRoot,
      }),
    ).toBe(0);
    // Second add-skill (NEW name): appends block 2 (multi-source).
    expect(
      await runRegistry({
        action: "add-skill",
        name: "beta",
        from: join(skillsRoot, "beta"),
        targets: ["codex:symlink:.codex/skills-beta"],
        projectRoot: fixtureRoot,
      }),
    ).toBe(0);

    // The overlay is now a 2-block array — confirm shape before validating.
    const overlayJson = JSON.parse(readFileSync(writtenOverlay, "utf-8")) as {
      surfaces?: { skills?: unknown[] };
    };
    expect(Array.isArray(overlayJson.surfaces?.skills)).toBe(true);
    expect(overlayJson.surfaces?.skills).toHaveLength(2);

    // REAL validate_manifest — jsonschema path (when installed) AND the
    // structural fallback both run against the same overlay. The test is
    // green only if BOTH agree on the array contract (the source of truth
    // for the TS-validator-vs-schema parity loop).
    const validate = execFileSync(
      "bash",
      [
        "-c",
        `source "${COMMON_SH}" && validate_manifest "${writtenOverlay}" "${SCHEMA}"`,
      ],
      { encoding: "utf-8", env: { ...process.env, IGRIS_BRAIN_DIR: brainDir } },
    );
    expect(typeof validate).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// FR-156 — agent TREE vendor + hash + drift-aware update.
//
// Promotes agent vendor from "file-set" (frontmatter.md + system-prompt-vN.md
// only) to "tree vendor" (whole source directory minus skip-list). Closes
// the L-516 violation where supporting files (DECK's routing/+registry/,
// DESIGNER's archetypes/) lived in the operator's source dir only — making
// the registry copy non-self-sufficient. Symmetric topology with the TD-191
// skill tree primitives (L-519 §18.1).
//
// Primitives are not exported; tested end-to-end through `runRegistry` —
// the only orthodox surface. Covered axes (architect's L-29 enumeration):
//   - tree vendoring (nested dirs preserved; skip-list excludes correctly)
//   - hash determinism (deterministic + order-independent + harness.md
//     excluded from basis + skip-list excluded)
//   - update axis: content change, file addition, file removal → all flip
//     hash → status=changed; null mutation → status=unchanged
//   - L-515 containment: symlink escapes are dropped from the vendored tree
//   - atomicity: failure rollback leaves no orphan `.tmp-PID` dir
// ---------------------------------------------------------------------------

describe("FR-156: agent tree vendor + hash", () => {
  it("vendors a nested source tree — sibling dirs preserved under the registry copy", async () => {
    // Source shape mirrors DECK / DESIGNER's actual layout: frontmatter +
    // body + routing/ + registry/.
    const src = join(projectRoot, "tree_src");
    mkdirSync(src, { recursive: true });
    mkdirSync(join(src, "routing"), { recursive: true });
    mkdirSync(join(src, "registry"), { recursive: true });
    writeFileSync(
      join(src, "frontmatter.md"),
      "---\nname: t1\ndescription: tree-shaped\n---\n",
    );
    writeFileSync(join(src, "system-prompt-v1.md"), "# body v1\n");
    writeFileSync(join(src, "routing", "_routing.md"), "routing-rules\n");
    writeFileSync(join(src, "registry", "types.md"), "types-doc\n");
    const code = await runRegistry(
      addOpts({
        name: "t1",
        from: "tree_src/system-prompt-v1.md",
        targets: ["claude:.claude/agents/t1.md"],
      }),
    );
    expect(code).toBe(0);
    // All four source files vendored, nesting preserved (L-516 closed).
    const v = vendorDir("t1");
    expect(existsSync(join(v, "frontmatter.md"))).toBe(true);
    expect(existsSync(join(v, "system-prompt-v1.md"))).toBe(true);
    expect(existsSync(join(v, "routing", "_routing.md"))).toBe(true);
    expect(existsSync(join(v, "registry", "types.md"))).toBe(true);
    // FR-152 α-assembly still works against the tree-vendored sources.
    expect(existsSync(join(v, "harness.md"))).toBe(true);
    // Recorded origin hash is the tree hash (matches what the bash drift
    // pre-check will compute against the same dir).
    const recordedHash = readOriginsFile()["agent:t1"].hash;
    expect(recordedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skip-list excludes operator-author noise — MAINTAINING.md, .DS_Store, .git*, __pycache__, node_modules, *.pyc", async () => {
    const src = join(projectRoot, "noise_src");
    mkdirSync(src, { recursive: true });
    mkdirSync(join(src, "node_modules", "foo"), { recursive: true });
    mkdirSync(join(src, ".git"), { recursive: true });
    mkdirSync(join(src, "__pycache__"), { recursive: true });
    writeFileSync(
      join(src, "frontmatter.md"),
      "---\nname: t2\ndescription: skip\n---\n",
    );
    writeFileSync(join(src, "system-prompt-v1.md"), "# body\n");
    writeFileSync(join(src, "MAINTAINING.md"), "internal-author-only\n");
    writeFileSync(join(src, ".DS_Store"), "macos-cruft\n");
    writeFileSync(join(src, ".gitignore"), "*.log\n");
    writeFileSync(join(src, "node_modules", "foo", "x.js"), "module\n");
    writeFileSync(join(src, ".git", "HEAD"), "ref\n");
    writeFileSync(join(src, "__pycache__", "x.pyc"), "bytecode\n");
    writeFileSync(join(src, "stale.pyc"), "bytecode-top-level\n");
    const code = await runRegistry(
      addOpts({
        name: "t2",
        from: "noise_src/system-prompt-v1.md",
        targets: ["claude:.claude/agents/t2.md"],
      }),
    );
    expect(code).toBe(0);
    const v = vendorDir("t2");
    // KEPT.
    expect(existsSync(join(v, "frontmatter.md"))).toBe(true);
    expect(existsSync(join(v, "system-prompt-v1.md"))).toBe(true);
    // SKIPPED.
    expect(existsSync(join(v, "MAINTAINING.md"))).toBe(false);
    expect(existsSync(join(v, ".DS_Store"))).toBe(false);
    expect(existsSync(join(v, ".gitignore"))).toBe(false);
    expect(existsSync(join(v, ".git"))).toBe(false);
    expect(existsSync(join(v, "node_modules"))).toBe(false);
    expect(existsSync(join(v, "__pycache__"))).toBe(false);
    expect(existsSync(join(v, "stale.pyc"))).toBe(false);
  });

  it("L-515 containment: symlinks in the source are dropped from the vendored tree (not followed out)", async () => {
    const src = join(projectRoot, "esc_src");
    const outside = join(tmpRoot, "outside_secrets");
    mkdirSync(src, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(src, "frontmatter.md"),
      "---\nname: t3\ndescription: esc\n---\n",
    );
    writeFileSync(join(src, "system-prompt-v1.md"), "# body\n");
    writeFileSync(join(outside, "SECRET.md"), "should-not-leak\n");
    // Symlink inside the source that points OUTSIDE the source tree.
    symlinkSync(join(outside, "SECRET.md"), join(src, "escape.md"));
    const code = await runRegistry(
      addOpts({
        name: "t3",
        from: "esc_src/system-prompt-v1.md",
        targets: ["claude:.claude/agents/t3.md"],
      }),
    );
    expect(code).toBe(0);
    const v = vendorDir("t3");
    // Expected entries vendored.
    expect(existsSync(join(v, "frontmatter.md"))).toBe(true);
    expect(existsSync(join(v, "system-prompt-v1.md"))).toBe(true);
    // The symlink and its (escaped) target MUST NOT appear in the vendored
    // tree — vendor is bytes, not refs, and symlink escapes are the L-515
    // attack surface this primitive must close.
    expect(existsSync(join(v, "escape.md"))).toBe(false);
    // The contents of the secret must not have leaked under any name.
    for (const f of readdirSync(v)) {
      const p = join(v, f);
      if (existsSync(p) && f.endsWith(".md")) {
        const text = readFileSync(p, "utf-8");
        expect(text.includes("should-not-leak")).toBe(false);
      }
    }
  });

  it("hash is deterministic + order-independent + harness.md is excluded from basis", async () => {
    // Build a tree, hash twice through add+update — the update with no
    // mutation must report `unchanged` (proves the hash basis equals what
    // assembleAgentHarness produced; harness.md must be excluded from the
    // basis or the assembly would advance the hash).
    const src = join(projectRoot, "stable_src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "frontmatter.md"),
      "---\nname: t4\ndescription: stable\n---\n",
    );
    writeFileSync(join(src, "system-prompt-v1.md"), "# body\n");
    expect(
      await runRegistry(
        addOpts({
          name: "t4",
          from: "stable_src/system-prompt-v1.md",
          targets: ["claude:.claude/agents/t4.md"],
        }),
      ),
    ).toBe(0);
    const hashBefore = readOriginsFile()["agent:t4"].hash;
    // Re-vendor without touching the source.
    const code = await runRegistry({
      action: "update",
      name: "t4",
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code).toBe(0);
    expect(readOriginsFile()["agent:t4"].hash).toBe(hashBefore);
    // Dropping a `.DS_Store` into the source after the first add → still
    // `unchanged` (skip-list excludes it from the basis on both sides).
    writeFileSync(join(src, ".DS_Store"), "x\n");
    const code2 = await runRegistry({
      action: "update",
      name: "t4",
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(code2).toBe(0);
    expect(readOriginsFile()["agent:t4"].hash).toBe(hashBefore);
  });

  it("update axis — content change in a nested file flips the hash → status=changed", async () => {
    const src = join(projectRoot, "mut_src");
    mkdirSync(join(src, "routing"), { recursive: true });
    writeFileSync(
      join(src, "frontmatter.md"),
      "---\nname: t5\ndescription: mut\n---\n",
    );
    writeFileSync(join(src, "system-prompt-v1.md"), "# body\n");
    writeFileSync(join(src, "routing", "_routing.md"), "v1\n");
    expect(
      await runRegistry(
        addOpts({
          name: "t5",
          from: "mut_src/system-prompt-v1.md",
          targets: ["claude:.claude/agents/t5.md"],
        }),
      ),
    ).toBe(0);
    const hashBefore = readOriginsFile()["agent:t5"].hash;
    // Mutate the NESTED file.
    writeFileSync(join(src, "routing", "_routing.md"), "v2-CHANGED\n");
    expect(
      await runRegistry({
        action: "update",
        name: "t5",
        overlayPath,
        originsPath,
        vendorDir,
      }),
    ).toBe(0);
    expect(readOriginsFile()["agent:t5"].hash).not.toBe(hashBefore);
    // Re-vendored content reflects the new bytes.
    expect(
      readFileSync(join(vendorDir("t5"), "routing", "_routing.md"), "utf-8"),
    ).toBe("v2-CHANGED\n");
  });

  it("update axis — adding a sibling file flips the hash → status=changed (the L-430 walk-set axis)", async () => {
    const src = join(projectRoot, "add_src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "frontmatter.md"),
      "---\nname: t6\ndescription: add\n---\n",
    );
    writeFileSync(join(src, "system-prompt-v1.md"), "# body\n");
    expect(
      await runRegistry(
        addOpts({
          name: "t6",
          from: "add_src/system-prompt-v1.md",
          targets: ["claude:.claude/agents/t6.md"],
        }),
      ),
    ).toBe(0);
    const hashBefore = readOriginsFile()["agent:t6"].hash;
    // Drop a NEW sibling file into the source.
    writeFileSync(join(src, "new_sibling.md"), "added-content\n");
    expect(
      await runRegistry({
        action: "update",
        name: "t6",
        overlayPath,
        originsPath,
        vendorDir,
      }),
    ).toBe(0);
    expect(readOriginsFile()["agent:t6"].hash).not.toBe(hashBefore);
    expect(existsSync(join(vendorDir("t6"), "new_sibling.md"))).toBe(true);
  });

  it("update axis — removing a sibling file flips the hash → status=changed (the L-430 walk-set axis, removal)", async () => {
    const src = join(projectRoot, "rm_src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "frontmatter.md"),
      "---\nname: t7\ndescription: rm\n---\n",
    );
    writeFileSync(join(src, "system-prompt-v1.md"), "# body\n");
    writeFileSync(join(src, "extra.md"), "extra\n");
    expect(
      await runRegistry(
        addOpts({
          name: "t7",
          from: "rm_src/system-prompt-v1.md",
          targets: ["claude:.claude/agents/t7.md"],
        }),
      ),
    ).toBe(0);
    const hashBefore = readOriginsFile()["agent:t7"].hash;
    // Remove a sibling file from the source.
    rmSync(join(src, "extra.md"));
    expect(
      await runRegistry({
        action: "update",
        name: "t7",
        overlayPath,
        originsPath,
        vendorDir,
      }),
    ).toBe(0);
    expect(readOriginsFile()["agent:t7"].hash).not.toBe(hashBefore);
    // Registry copy no longer has the removed file (re-vendor replaces the
    // whole dir atomically).
    expect(existsSync(join(vendorDir("t7"), "extra.md"))).toBe(false);
  });

  it("atomicity: empty-after-skip source throws and leaves no orphan registry dir", async () => {
    // A source dir whose ENTIRE contents are in the skip-list — vendor must
    // throw the "no files after skip-list" error and not leave any partial
    // copy behind.
    const src = join(projectRoot, "empty_src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, ".DS_Store"), "cruft\n");
    writeFileSync(join(src, "MAINTAINING.md"), "author-only\n");
    const code = await runRegistry(
      addOpts({
        name: "tnone",
        from: "empty_src/MAINTAINING.md",
        targets: ["claude:.claude/agents/tnone.md"],
      }),
    );
    // Add fails (vendor error → exit 1).
    expect(code).toBe(1);
    // No orphan vendored copy.
    expect(existsSync(vendorDir("tnone"))).toBe(false);
    // No orphan .tmp-PID sibling either.
    const parentEntries = existsSync(vendorBase)
      ? readdirSync(vendorBase)
      : [];
    for (const e of parentEntries) {
      expect(e.startsWith("tnone.tmp-")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// TD-202: in-band REGISTRY-NOTICE.md sidecar + skip-list parity + update hint
// ---------------------------------------------------------------------------

describe("registry — TD-202 REGISTRY-NOTICE.md sidecar", () => {
  /**
   * Capture process.stdout.write so we can assert against the post-update
   * reminder. `info()` from `lib/log.ts` writes to process.stdout — no spy
   * library needed; we wrap the method on the global stream.
   */
  function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ): boolean => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      lines.push(text);
      // Forward the original call so the test runner's reporter still works.
      // Cast back through the original signature.
      return (orig as (c: string | Uint8Array, ...r: unknown[]) => boolean)(
        chunk,
        ...rest,
      );
    }) as typeof process.stdout.write;
    return {
      lines,
      restore: () => {
        process.stdout.write = orig as typeof process.stdout.write;
      },
    };
  }

  it("agent add emits REGISTRY-NOTICE.md next to harness.md naming the source", async () => {
    const code = await runRegistry(
      addOpts({
        name: "td202agent",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/td202agent.md"],
      }),
    );
    expect(code).toBe(0);
    const sidecar = join(vendorDir("td202agent"), "REGISTRY-NOTICE.md");
    expect(existsSync(sidecar)).toBe(true);
    const text = readFileSync(sidecar, "utf-8");
    // Sidecar names the SOURCE dir (path origin → filesystem path).
    expect(text).toContain(join(projectRoot, "canon"));
    // Sidecar names the agent so the editor can copy the update command.
    expect(text).toContain("igris registry update td202agent");
    // Anti-edit guidance is the headline.
    expect(text).toMatch(/DO NOT edit/);
    expect(text).toMatch(/§18\.5/);
  });

  it("skill add emits REGISTRY-NOTICE.md NEXT TO SKILL.md (L-517 nested layout)", async () => {
    mkdirSync(join(projectRoot, "skills", "td202skill"), { recursive: true });
    writeFileSync(
      join(projectRoot, "skills", "td202skill", "SKILL.md"),
      "---\nname: td202skill\ndescription: d\n---\nbody\n",
    );
    const code = await runRegistry({
      action: "add-skill",
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      skillVendorDir,
      name: "td202skill",
      from: "skills/td202skill",
      targets: ["codex:symlink:.codex/skills"],
    });
    expect(code).toBe(0);
    // L-517 nested: <vendorBase>/skills/td202skill/td202skill/SKILL.md.
    const skillDir = join(vendorBase, "skills", "td202skill", "td202skill");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    const sidecar = join(skillDir, "REGISTRY-NOTICE.md");
    expect(existsSync(sidecar)).toBe(true);
    const text = readFileSync(sidecar, "utf-8");
    expect(text).toContain(join(projectRoot, "skills", "td202skill"));
    expect(text).toContain("igris registry update td202skill");
  });

  it("sidecar bytes are NOT in the hash basis (skip-list parity — agents)", async () => {
    // Add an agent → record hash → manually drop a second REGISTRY-NOTICE.md
    // (or mutate the existing one) → re-hash and assert no change.
    // We use the public `update` path so the hash is recomputed by the same
    // helper the production code uses.
    const seedCode = await runRegistry(
      addOpts({
        name: "td202hash",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/td202hash.md"],
      }),
    );
    expect(seedCode).toBe(0);
    const hashBefore = readOriginsFile()["agent:td202hash"].hash;
    // Hand-edit the sidecar contents (NOT the agent's bytes). If
    // REGISTRY-NOTICE.md is correctly skip-listed, `update` re-hashes the
    // tree and the hash MUST be unchanged.
    const sidecar = join(vendorDir("td202hash"), "REGISTRY-NOTICE.md");
    writeFileSync(sidecar, "garbled content — must not affect hash\n");
    const upd = await runRegistry({
      action: "update",
      name: "td202hash",
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(upd).toBe(0);
    // The hash recorded post-update equals the pre-edit hash → sidecar is
    // excluded from the basis (three-site skip-list parity proved).
    expect(readOriginsFile()["agent:td202hash"].hash).toBe(hashBefore);
  });

  it("sidecar bytes are NOT in the hash basis (skip-list parity — skills)", async () => {
    mkdirSync(join(projectRoot, "skills", "td202skillhash"), { recursive: true });
    writeFileSync(
      join(projectRoot, "skills", "td202skillhash", "SKILL.md"),
      "---\nname: td202skillhash\ndescription: d\n---\nbody\n",
    );
    const seedCode = await runRegistry({
      action: "add-skill",
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      skillVendorDir,
      name: "td202skillhash",
      from: "skills/td202skillhash",
      targets: ["codex:symlink:.codex/skills"],
    });
    expect(seedCode).toBe(0);
    const hashBefore = readOriginsFile()["skill:td202skillhash"].hash;
    const skillDir = join(
      vendorBase,
      "skills",
      "td202skillhash",
      "td202skillhash",
    );
    const sidecar = join(skillDir, "REGISTRY-NOTICE.md");
    writeFileSync(sidecar, "tampered sidecar — must not affect hash\n");
    const upd = await runRegistry({
      action: "update",
      name: "td202skillhash",
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      skillVendorDir,
    });
    expect(upd).toBe(0);
    expect(readOriginsFile()["skill:td202skillhash"].hash).toBe(hashBefore);
  });

  it("update re-emits REGISTRY-NOTICE.md (sidecar restored after deletion)", async () => {
    await runRegistry(
      addOpts({
        name: "td202update",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/td202update.md"],
      }),
    );
    const sidecar = join(vendorDir("td202update"), "REGISTRY-NOTICE.md");
    expect(existsSync(sidecar)).toBe(true);
    // Operator manually deletes the sidecar — update must put it back.
    rmSync(sidecar);
    expect(existsSync(sidecar)).toBe(false);
    const upd = await runRegistry({
      action: "update",
      name: "td202update",
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
    });
    expect(upd).toBe(0);
    expect(existsSync(sidecar)).toBe(true);
  });

  it("post-update reminder line names TD-202 + §18.5", async () => {
    await runRegistry(
      addOpts({
        name: "td202hint",
        from: "canon/x.md",
        targets: ["claude:.claude/agents/td202hint.md"],
      }),
    );
    const cap = captureStdout();
    try {
      const upd = await runRegistry({
        action: "update",
        name: "td202hint",
        projectRoot,
        overlayPath,
        originsPath,
        vendorDir,
      });
      expect(upd).toBe(0);
    } finally {
      cap.restore();
    }
    const out = cap.lines.join("");
    expect(out).toMatch(/Reminder: edits to vendored surfaces/);
    expect(out).toMatch(/TD-202/);
    expect(out).toMatch(/§18\.5/);
  });

  it("github-origin sidecar shows `github:owner/repo@ref` URI, not the temp dir", async () => {
    // Stage a minimal repo manifest + canonical body in a temp dir; stub
    // fetchRepo to point at it and listReleases to return no newer tags.
    // Manifest filename is `igris.json` (per readRepoManifest's lookup order).
    const fakeRepoDir = mkdtempSync(join(tmpdir(), "td202-gh-"));
    mkdirSync(join(fakeRepoDir, "agents"), { recursive: true });
    writeFileSync(join(fakeRepoDir, "agents", "td202gh.md"), "# td202gh\nbody\n");
    writeFileSync(
      join(fakeRepoDir, "igris.json"),
      JSON.stringify({
        version: 1,
        agents: [
          {
            name: "td202gh",
            canonical: {
              dir: "agents",
              versioned: false,
              file: "td202gh.md",
            },
            targets: [{ type: "claude", path: ".claude/agents/td202gh.md" }],
          },
        ],
      }),
    );
    const fetchRepo: FetchRepoFn = async (_spec: GithubSpec): Promise<FetchedRepo> => {
      return {
        dir: fakeRepoDir,
        sha: "0123456789abcdef0123456789abcdef01234567",
        cleanup: () => {
          /* test owns the dir */
        },
      };
    };
    const listReleases: ListReleasesFn = async () => [];
    const code = await runRegistry({
      action: "add",
      projectRoot,
      overlayPath,
      originsPath,
      vendorDir,
      name: "td202gh",
      from: "github:acme/sample@v1.0.0",
      targets: ["claude:.claude/agents/td202gh.md"],
      fetchRepo,
      listReleases,
    });
    expect(code).toBe(0);
    const sidecar = join(vendorDir("td202gh"), "REGISTRY-NOTICE.md");
    expect(existsSync(sidecar)).toBe(true);
    const text = readFileSync(sidecar, "utf-8");
    // The sidecar's Source: line must be the github URI, NOT the temp dir.
    expect(text).toContain("github:acme/sample@v1.0.0");
    expect(text).not.toContain(fakeRepoDir);
    // Cleanup the fake repo dir we held alive.
    rmSync(fakeRepoDir, { recursive: true, force: true });
  });
});
