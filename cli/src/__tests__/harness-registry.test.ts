/**
 * FR-141 registry-verb tests — `igris registry add|list|remove`.
 *
 * NOTE on the filename: this is `harness-registry.test.ts`, NOT
 * `registry.test.ts`. The latter is taken by the UNRELATED project-registry
 * SQLite module (`lib/registry.ts`). This file tests the harness-overlay verb
 * at `verbs/registry.ts`.
 *
 * Boundary-mocking discipline (L-159 / L-173): we NEVER `vi.mock` the module
 * under test. Unit tests use the explicit `opts.overlayPath` seam over a real
 * tmp dir; the integration test uses the `IGRIS_BRAIN_DIR` env sandbox (the
 * seam the REAL bash adapter reads) and runs the actual `compile_harnesses.sh`
 * / `validate_manifest` — no mocked merge.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

const HERE = dirname(fileURLToPath(import.meta.url));
// cli/src/__tests__ -> repo root -> core/scripts/cli-adapters
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const ADAPTER_DIR = join(REPO_ROOT, "core", "scripts", "cli-adapters");
const COMPILE_SH = join(ADAPTER_DIR, "compile_harnesses.sh");
const COMMON_SH = join(ADAPTER_DIR, "_common.sh");
const SCHEMA = join(ADAPTER_DIR, "manifest.schema.json");

let tmpRoot: string;
let overlayPath: string;
let projectRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-harness-registry-"));
  overlayPath = join(tmpRoot, "overlay.json");
  projectRoot = join(tmpRoot, "proj");
  mkdirSync(projectRoot, { recursive: true });
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

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe("registry add", () => {
  it("creates a valid overlay on an absent file, layer=personal", async () => {
    const code = await runRegistry({
      action: "add",
      name: "mycustom",
      canonical: "canon/x.md",
      targets: ["claude:.claude/agents/mycustom.md"],
      projectRoot,
      overlayPath,
    });
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
    expect(overlay.agents[0].canonical).toEqual({
      dir: "canon",
      versioned: false,
      file: "x.md",
    });
    expect(validateOverlayShape(overlay)).toBeNull();
  });

  it("--versioned --glob produces a versioned canonical (no file)", async () => {
    const code = await runRegistry({
      action: "add",
      name: "vagent",
      canonical: "canon",
      versioned: true,
      glob: "v*.md",
      targets: ["codex:.codex/agents/vagent.toml"],
      projectRoot,
      overlayPath,
    });
    expect(code).toBe(0);
    const overlay = readOverlayFile() as {
      agents: { canonical: Record<string, unknown> }[];
    };
    expect(overlay.agents[0].canonical).toEqual({
      dir: "canon",
      versioned: true,
      glob: "v*.md",
    });
    expect("file" in overlay.agents[0].canonical).toBe(false);
  });

  it("--versioned without --glob is a usage error (exit 2)", async () => {
    const code = await runRegistry({
      action: "add",
      name: "vagent",
      canonical: "canon",
      versioned: true,
      targets: ["codex:.codex/agents/vagent.toml"],
      projectRoot,
      overlayPath,
    });
    expect(code).toBe(2);
    expect(existsSync(overlayPath)).toBe(false);
  });

  it("--glob without --versioned is a usage error (exit 2)", async () => {
    const code = await runRegistry({
      action: "add",
      name: "agent",
      canonical: "canon/x.md",
      glob: "v*.md",
      targets: ["claude:.claude/agents/agent.md"],
      projectRoot,
      overlayPath,
    });
    expect(code).toBe(2);
  });

  it("rejects a second add with an existing overlay name (intra-overlay dedupe)", async () => {
    await runRegistry({
      action: "add",
      name: "dup",
      canonical: "canon/x.md",
      targets: ["claude:.claude/agents/dup.md"],
      projectRoot,
      overlayPath,
    });
    const before = readFileSync(overlayPath, "utf-8");
    const code = await runRegistry({
      action: "add",
      name: "dup",
      canonical: "canon/y.md",
      targets: ["claude:.claude/agents/dup2.md"],
      projectRoot,
      overlayPath,
    });
    expect(code).toBe(1);
    // Overlay byte-unchanged.
    expect(readFileSync(overlayPath, "utf-8")).toBe(before);
  });

  it("rejects a name colliding with a base (core) agent", async () => {
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
    const code = await runRegistry({
      action: "add",
      name: "forger",
      canonical: "canon/forger.md",
      targets: ["claude:.claude/agents/forger.md"],
      projectRoot,
      overlayPath,
    });
    expect(code).toBe(1);
    expect(existsSync(overlayPath)).toBe(false);
  });

  it("treats an absent base manifest as no base agents (no hard-fail)", async () => {
    const code = await runRegistry({
      action: "add",
      name: "nobase",
      canonical: "canon/x.md",
      targets: ["claude:.claude/agents/nobase.md"],
      projectRoot, // no harness-manifest.json written
      overlayPath,
    });
    expect(code).toBe(0);
  });

  it("requires <name>, --canonical, and --target (usage errors)", async () => {
    expect(
      await runRegistry({ action: "add", canonical: "c/x.md", targets: ["claude:p"], overlayPath }),
    ).toBe(2);
    expect(
      await runRegistry({ action: "add", name: "x", targets: ["claude:p"], overlayPath }),
    ).toBe(2);
    expect(
      await runRegistry({ action: "add", name: "x", canonical: "c/x.md", overlayPath }),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// --target parsing
// ---------------------------------------------------------------------------

describe("registry add — --target parsing", () => {
  it("parses type:path and supports multiple --target", async () => {
    await runRegistry({
      action: "add",
      name: "multi",
      canonical: "canon/x.md",
      targets: [
        "codex:.codex/agents/multi.toml",
        "gemini:.gemini/agents/multi.toml",
      ],
      projectRoot,
      overlayPath,
    });
    const overlay = readOverlayFile() as {
      agents: { targets: { type: string; path: string }[] }[];
    };
    expect(overlay.agents[0].targets).toEqual([
      { type: "codex", path: ".codex/agents/multi.toml" },
      { type: "gemini", path: ".gemini/agents/multi.toml" },
    ]);
  });

  it("preserves a path containing ':' (splits on first colon only)", async () => {
    await runRegistry({
      action: "add",
      name: "colon",
      canonical: "canon/x.md",
      targets: ["claude:dir/with:colon/agent.md"],
      projectRoot,
      overlayPath,
    });
    const overlay = readOverlayFile() as {
      agents: { targets: { type: string; path: string }[] }[];
    };
    expect(overlay.agents[0].targets[0]).toEqual({
      type: "claude",
      path: "dir/with:colon/agent.md",
    });
  });

  it("rejects an unknown target type (exit 2)", async () => {
    const code = await runRegistry({
      action: "add",
      name: "bad",
      canonical: "canon/x.md",
      targets: ["opencode:.opencode/bad.md"],
      projectRoot,
      overlayPath,
    });
    expect(code).toBe(2);
    expect(existsSync(overlayPath)).toBe(false);
  });

  it("rejects a target with no colon (exit 2)", async () => {
    const code = await runRegistry({
      action: "add",
      name: "bad",
      canonical: "canon/x.md",
      targets: ["claude-no-colon"],
      projectRoot,
      overlayPath,
    });
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// validators (direct)
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

  it("rejects a stray agent key", () => {
    expect(validateAgentEntry({ ...valid, extra: 1 })).toMatch(
      /additionalProperties/,
    );
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
  it("removes an entry; removing the last leaves a valid empty overlay", async () => {
    await runRegistry({
      action: "add",
      name: "only",
      canonical: "canon/x.md",
      targets: ["claude:.claude/agents/only.md"],
      projectRoot,
      overlayPath,
    });
    const code = await runRegistry({
      action: "remove",
      name: "only",
      overlayPath,
    });
    expect(code).toBe(0);
    expect(existsSync(overlayPath)).toBe(true);
    const overlay = readOverlayFile() as { version: number; agents: unknown[] };
    expect(overlay.version).toBe(1);
    expect(overlay.agents).toEqual([]);
  });

  it("rejects removing a nonexistent name (exit 1), overlay unchanged", async () => {
    await runRegistry({
      action: "add",
      name: "keep",
      canonical: "canon/x.md",
      targets: ["claude:.claude/agents/keep.md"],
      projectRoot,
      overlayPath,
    });
    const before = readFileSync(overlayPath, "utf-8");
    const code = await runRegistry({
      action: "remove",
      name: "ghost",
      overlayPath,
    });
    expect(code).toBe(1);
    expect(readFileSync(overlayPath, "utf-8")).toBe(before);
  });

  it("preserves a forward-compat surfaces block across add+remove", async () => {
    writeFileSync(
      overlayPath,
      JSON.stringify({ version: 1, agents: [], surfaces: { skills: {} } }),
    );
    await runRegistry({
      action: "add",
      name: "tmp",
      canonical: "canon/x.md",
      targets: ["claude:.claude/agents/tmp.md"],
      projectRoot,
      overlayPath,
    });
    await runRegistry({ action: "remove", name: "tmp", overlayPath });
    const overlay = readOverlayFile() as { surfaces?: unknown };
    expect(overlay.surfaces).toEqual({ skills: {} });
  });
});

describe("registry list", () => {
  it("reports empty then populated", async () => {
    expect(await runRegistry({ action: "list", overlayPath })).toBe(0);
    await runRegistry({
      action: "add",
      name: "shown",
      canonical: "canon/x.md",
      targets: ["claude:.claude/agents/shown.md"],
      projectRoot,
      overlayPath,
    });
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

  it("TS-written overlay is auto-discovered + produces the target, and passes validate_manifest", async () => {
    if (!toolingAvailable()) {
      // Graceful skip on a minimal box (no bash/python3 or no adapters).
      return;
    }

    // Write the overlay via the REAL verb into the sandboxed brain registry,
    // using the same path the adapter auto-discovers (no --overlay flag).
    process.env.IGRIS_BRAIN_DIR = brainDir;
    const writtenOverlay = join(
      brainDir,
      "registry",
      "harness-manifest.personal.json",
    );
    const addCode = await runRegistry({
      action: "add",
      name: "mycustom",
      canonical: "canon/mycustom.md",
      targets: ["codex:.codex/agents/mycustom.toml"],
      projectRoot: fixtureRoot,
      // No overlayPath seam: exercise registryOverlayPath() via IGRIS_BRAIN_DIR.
    });
    expect(addCode).toBe(0);
    expect(existsSync(writtenOverlay)).toBe(true);

    // (AC4) The overlay passes the REAL validate_manifest — closes the
    // TS-validator-vs-schema parity loop end-to-end.
    const validate = execFileSync(
      "bash",
      [
        "-c",
        `source "${COMMON_SH}" && validate_manifest "${writtenOverlay}" "${SCHEMA}"`,
      ],
      { encoding: "utf-8", env: { ...process.env, IGRIS_BRAIN_DIR: brainDir } },
    );
    // validate_manifest exits 0 on success (execFileSync throws otherwise).
    expect(typeof validate).toBe("string");

    // (AC5) Run the REAL compiler with NO --overlay flag → it must
    // auto-discover the personal overlay under $IGRIS_BRAIN_DIR/registry/ and
    // produce the personal agent's declared target file.
    execFileSync(
      "bash",
      [COMPILE_SH, "--project-root", fixtureRoot, "--filter", "mycustom"],
      { encoding: "utf-8", env: { ...process.env, IGRIS_BRAIN_DIR: brainDir } },
    );
    expect(
      existsSync(join(fixtureRoot, ".codex", "agents", "mycustom.toml")),
    ).toBe(true);
  });
});
