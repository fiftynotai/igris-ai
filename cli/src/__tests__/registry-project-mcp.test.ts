/**
 * registry-project-mcp.test.ts — FR-164 (FR-160 epic).
 *
 * Exercises `runLoadout({ action: "project-mcp", ... })` — the internal
 * compile-time MCP projector — against REAL `node:fs` sandboxes (no mocks of
 * the SUT; L-159). Covers, per harness: writes the native shape, idempotency,
 * malformed-safe (no clobber, no .tmp litter), no-clobber of sibling entries +
 * other top-level keys, and the codex missing-secret FAIL with NO secret leak.
 *
 * SECRET HYGIENE: the codex tests grep the captured stdout+stderr for a sentinel
 * secret string and assert ABSENCE on the failure path (and that the on-disk
 * codex literal IS the secret on the success path — codex resolves nothing).
 *
 * FR-212d Phase 2: these are the per-harness MERGER-SHAPE oracle tests. The
 * custom `buildHarnessMcpEntry` shaper + `mergeJsonConfig`/`mergeTomlConfig`
 * mergers are KEPT (antigravity's ENTRY uses them under the delegate engine), so
 * each call forces `mcpEngine: "custom"` to pin that shaper's byte-shape. The
 * DELEGATE-default routing (every harness EXCEPT antigravity → add-mcp,
 * antigravity → custom) is covered by the registry-project-mcp DELEGATE tests +
 * the fr212-smoke gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { runLoadout } from "../verbs/loadout.js";

let work: string;
let projectRoot: string;
let overlayPath: string;
let secretsPath: string;
const SENTINEL = "sentinel-secret-DO-NOT-LEAK";

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "igris-project-mcp-"));
  projectRoot = join(work, "proj");
  mkdirSync(projectRoot, { recursive: true });
  overlayPath = join(work, "overlay.json");
  secretsPath = join(work, "secrets.env");
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Write a base manifest declaring one mcp block with the 4 harness targets. */
function writeManifest(canonicalEnv: Record<string, string> = { API: "${API_TOKEN}" }): void {
  const manifest = {
    version: 1,
    agents: [],
    surfaces: {
      mcp_servers: [
        {
          name: "demo-mcp",
          canonical: {
            command: "node",
            args: ["/x/y.js"],
            env: canonicalEnv,
            startup_timeout_sec: 30,
          },
          targets: [
            { type: "claude", method: "merge" },
            { type: "gemini", method: "merge" },
            { type: "opencode", method: "merge", enabled: true },
            { type: "codex", method: "merge" },
          ],
        },
      ],
    },
  };
  writeFileSync(join(projectRoot, "harness-manifest.json"), JSON.stringify(manifest, null, 2));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/** Capture stdout+stderr while running `fn`. Returns the combined output. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = "";
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  try {
    const code = await fn();
    return { code, out };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe("runProjectMcp — claude/gemini JSON shapes (refs, no secrets)", () => {
  it("claude writes {type:stdio,...} with the ${VAR} ref", async () => {
    writeManifest();
    const cfg = join(work, "claude.json");
    const code = await runLoadout({
      action: "project-mcp",
      mcpEngine: "custom",
      name: "demo-mcp",
      harness: "claude",
      projectRoot,
      overlayPath,
      configPath: cfg,
    });
    expect(code).toBe(0);
    const servers = readJson(cfg).mcpServers as Record<string, unknown>;
    expect(servers["demo-mcp"]).toEqual({
      type: "stdio",
      command: "node",
      args: ["/x/y.js"],
      env: { API: "${API_TOKEN}" },
    });
  });

  it("gemini writes the no-type shape with the ${VAR} ref", async () => {
    writeManifest();
    const cfg = join(work, "gemini.json");
    const code = await runLoadout({
      action: "project-mcp",
      mcpEngine: "custom",
      name: "demo-mcp",
      harness: "gemini",
      projectRoot,
      overlayPath,
      configPath: cfg,
    });
    expect(code).toBe(0);
    const servers = readJson(cfg).mcpServers as Record<string, Record<string, unknown>>;
    expect(servers["demo-mcp"].type).toBeUndefined();
    expect(servers["demo-mcp"].env).toEqual({ API: "${API_TOKEN}" });
  });

  it("opencode fuses command+args under `mcp`, uses environment + {env:VAR}", async () => {
    writeManifest();
    const cfg = join(work, "opencode.json");
    const code = await runLoadout({
      action: "project-mcp",
      mcpEngine: "custom",
      name: "demo-mcp",
      harness: "opencode",
      projectRoot,
      overlayPath,
      configPath: cfg,
    });
    expect(code).toBe(0);
    const mcp = readJson(cfg).mcp as Record<string, unknown>;
    expect(mcp["demo-mcp"]).toEqual({
      type: "local",
      command: ["node", "/x/y.js"],
      enabled: true,
      environment: { API: "{env:API_TOKEN}" },
    });
  });

  it("is idempotent — second run is `unchanged` and does not churn mtime", async () => {
    writeManifest();
    const cfg = join(work, "claude.json");
    await runLoadout({ action: "project-mcp", mcpEngine: "custom", name: "demo-mcp", harness: "claude", projectRoot, overlayPath, configPath: cfg });
    const m1 = statSync(cfg).mtimeMs;
    const { out } = await capture(() =>
      runLoadout({ action: "project-mcp", mcpEngine: "custom", name: "demo-mcp", harness: "claude", projectRoot, overlayPath, configPath: cfg }),
    );
    expect(out).toContain("unchanged");
    expect(statSync(cfg).mtimeMs).toBe(m1);
  });
});

describe("runProjectMcp — codex TOML (resolved literal) + secret hygiene", () => {
  it("codex writes the RESOLVED LITERAL from secrets.env", async () => {
    writeManifest();
    writeFileSync(secretsPath, `API_TOKEN=${SENTINEL}\n`);
    const cfg = join(work, "config.toml");
    const code = await runLoadout({
      action: "project-mcp",
      mcpEngine: "custom",
      name: "demo-mcp",
      harness: "codex",
      projectRoot,
      overlayPath,
      configPath: cfg,
      secretsPath,
    });
    expect(code).toBe(0);
    const parsed = TOML.parse(readFileSync(cfg, "utf-8")) as Record<string, unknown>;
    const table = (parsed.mcp_servers as Record<string, Record<string, unknown>>)["demo-mcp"];
    expect(table.command).toBe("node");
    expect(table.startup_timeout_sec).toBe(30);
    expect(table.env).toEqual({ API: SENTINEL });
  });

  it("codex with a MISSING secret FAILs (exit 1), names the VAR, and NEVER leaks", async () => {
    writeManifest();
    // secrets.env absent / empty → API_TOKEN missing.
    writeFileSync(secretsPath, "# no API_TOKEN here\n");
    const cfg = join(work, "config.toml");
    const { code, out } = await capture(() =>
      runLoadout({
        action: "project-mcp",
        mcpEngine: "custom",
        name: "demo-mcp",
        harness: "codex",
        projectRoot,
        overlayPath,
        configPath: cfg,
        secretsPath,
      }),
    );
    expect(code).toBe(1);
    // The VAR name is surfaced...
    expect(out).toContain("API_TOKEN");
    // ...but never any (would-be) secret value, and the config is NOT written.
    expect(out).not.toContain(SENTINEL);
    expect(existsSync(cfg)).toBe(false);
  });
});

describe("runProjectMcp — no-clobber + malformed safety", () => {
  it("preserves a pre-existing sibling MCP and other top-level keys", async () => {
    writeManifest();
    const cfg = join(work, "claude.json");
    // Seed a hand-registered sibling + an unrelated top-level key.
    writeFileSync(
      cfg,
      JSON.stringify(
        {
          numStartups: 7,
          mcpServers: { pencil: { type: "stdio", command: "pencil", args: [], env: {} } },
        },
        null,
        2,
      ),
    );
    const code = await runLoadout({
      action: "project-mcp",
      mcpEngine: "custom",
      name: "demo-mcp",
      harness: "claude",
      projectRoot,
      overlayPath,
      configPath: cfg,
    });
    expect(code).toBe(0);
    const data = readJson(cfg);
    expect(data.numStartups).toBe(7);
    const servers = data.mcpServers as Record<string, unknown>;
    expect(servers.pencil).toEqual({ type: "stdio", command: "pencil", args: [], env: {} });
    expect(servers["demo-mcp"]).toBeDefined();
  });

  it("malformed target config → exit 1, file byte-unchanged, no .tmp litter", async () => {
    writeManifest();
    const cfg = join(work, "claude.json");
    const broken = "{ this is not json";
    writeFileSync(cfg, broken);
    const code = await runLoadout({
      action: "project-mcp",
      mcpEngine: "custom",
      name: "demo-mcp",
      harness: "claude",
      projectRoot,
      overlayPath,
      configPath: cfg,
    });
    expect(code).toBe(1);
    expect(readFileSync(cfg, "utf-8")).toBe(broken);
    // No `.tmp.*` litter beside the config.
    const litter = readdirSync(work).filter((f) => f.includes(".tmp."));
    expect(litter).toEqual([]);
  });

  it("block-not-found → exit 1 with an actionable message", async () => {
    writeManifest();
    const cfg = join(work, "claude.json");
    const { code, out } = await capture(() =>
      runLoadout({
        action: "project-mcp",
        mcpEngine: "custom",
        name: "no-such-mcp",
        harness: "claude",
        projectRoot,
        overlayPath,
        configPath: cfg,
      }),
    );
    expect(code).toBe(1);
    expect(out).toContain("no mcp_servers block named 'no-such-mcp'");
    expect(existsSync(cfg)).toBe(false);
  });
});

describe("runProjectMcp — overlay merge (finding #2)", () => {
  it("sees a PERSONAL mcp block written to the overlay (not the base manifest)", async () => {
    // Base manifest with NO mcp_servers; the block lives only in the overlay.
    writeFileSync(
      join(projectRoot, "harness-manifest.json"),
      JSON.stringify({ version: 1, agents: [] }, null, 2),
    );
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          version: 1,
          agents: [],
          surfaces: {
            mcp_servers: [
              {
                name: "personal-mcp",
                layer: "personal",
                canonical: { command: "node", args: ["/p.js"], env: {} },
                targets: [{ type: "claude", method: "merge" }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const cfg = join(work, "claude.json");
    const code = await runLoadout({
      action: "project-mcp",
      mcpEngine: "custom",
      name: "personal-mcp",
      harness: "claude",
      projectRoot,
      overlayPath,
      configPath: cfg,
    });
    expect(code).toBe(0);
    const servers = readJson(cfg).mcpServers as Record<string, unknown>;
    expect(servers["personal-mcp"]).toBeDefined();
  });

  it("overlay block colliding with a base block name → exit 1 (no shadow)", async () => {
    writeManifest(); // base has demo-mcp
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          version: 1,
          agents: [],
          surfaces: {
            mcp_servers: [
              {
                name: "demo-mcp",
                layer: "personal",
                canonical: { command: "evil", args: [], env: {} },
                targets: [{ type: "claude", method: "merge" }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const cfg = join(work, "claude.json");
    const { code, out } = await capture(() =>
      runLoadout({
        action: "project-mcp",
        mcpEngine: "custom",
        name: "demo-mcp",
        harness: "claude",
        projectRoot,
        overlayPath,
        configPath: cfg,
      }),
    );
    expect(code).toBe(1);
    expect(out).toContain("collides with a base");
    expect(existsSync(cfg)).toBe(false);
  });
});

describe("runProjectMcp — usage guards", () => {
  it("missing --name → exit 2", async () => {
    const code = await runLoadout({ action: "project-mcp", harness: "claude", projectRoot, overlayPath });
    expect(code).toBe(2);
  });

  it("missing --harness → exit 2", async () => {
    const code = await runLoadout({ action: "project-mcp", name: "demo-mcp", projectRoot, overlayPath });
    expect(code).toBe(2);
  });
});

/**
 * FR-180 cross-phase: a CORE MCP server lives ONLY in the core surfaces manifest
 * (`<brain>/core/scripts/cli-adapters/surfaces-manifest.json`, written by
 * `igris add --core mcp`), NOT in the project's `harness-manifest.json`. The
 * projector must union the core surfaces manifest WHEN the project root OWNS it
 * (its realpath under --project-root) — so `add --core mcp`'s projection (run
 * against the brain root) finds the block. An unrelated project must NOT pull
 * the core MCP server in.
 */
describe("runProjectMcp — FR-180 core surfaces union (ownership-gated)", () => {
  let savedBrain: string | undefined;
  let brainRoot: string;

  beforeEach(() => {
    savedBrain = process.env.IGRIS_BRAIN_DIR;
    // A sandbox brain that OWNS the core surfaces manifest. The projector reads
    // it via coreSurfacesManifestPath() = <brain>/core/scripts/cli-adapters/.
    brainRoot = join(work, "brain");
    const adaptersDir = join(brainRoot, "core", "scripts", "cli-adapters");
    mkdirSync(adaptersDir, { recursive: true });
    process.env.IGRIS_BRAIN_DIR = brainRoot;
    const surfaces = {
      version: 1,
      surfaces: {
        mcp_servers: [
          {
            name: "core-mcp",
            canonical: { command: "echo", args: ["hi"] },
            targets: [{ type: "claude", method: "merge" }],
          },
        ],
      },
    };
    writeFileSync(
      join(adaptersDir, "surfaces-manifest.json"),
      JSON.stringify(surfaces, null, 2),
    );
  });

  afterEach(() => {
    if (savedBrain === undefined) {
      delete process.env.IGRIS_BRAIN_DIR;
    } else {
      process.env.IGRIS_BRAIN_DIR = savedBrain;
    }
  });

  it("projects a core-only MCP block when the project root OWNS the surfaces manifest", async () => {
    // project-root == the brain root → ownership gate passes → core unioned.
    // (No harness-manifest.json at brainRoot → base contributes []; the block
    // comes purely from the core surfaces manifest.)
    const cfg = join(work, "claude-core.json");
    const code = await runLoadout({
      action: "project-mcp",
      mcpEngine: "custom",
      name: "core-mcp",
      harness: "claude",
      projectRoot: brainRoot,
      overlayPath,
      configPath: cfg,
    });
    expect(code).toBe(0);
    const servers = readJson(cfg).mcpServers as Record<string, unknown>;
    expect(servers["core-mcp"]).toEqual({
      type: "stdio",
      command: "echo",
      args: ["hi"],
      env: {},
    });
  });

  it("does NOT find a core block when the project root does NOT own the surfaces manifest", async () => {
    // project-root is an UNRELATED dir (not an ancestor of the brain) → the
    // ownership gate refuses → the core block is invisible → block-not-found.
    const unrelated = join(work, "unrelated");
    mkdirSync(unrelated, { recursive: true });
    const cfg = join(work, "claude-unrelated.json");
    const { code, out } = await capture(() =>
      runLoadout({
        action: "project-mcp",
        mcpEngine: "custom",
        name: "core-mcp",
        harness: "claude",
        projectRoot: unrelated,
        overlayPath,
        configPath: cfg,
      }),
    );
    expect(code).toBe(1);
    expect(out).toContain("no mcp_servers block named 'core-mcp'");
    expect(existsSync(cfg)).toBe(false);
  });
});
