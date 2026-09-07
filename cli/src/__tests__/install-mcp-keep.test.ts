/**
 * TD-455 — `igris install` step 11 keeps a foreign-but-existing igris-brain
 * registration.
 *
 * THE DEFECT. Step 11 called `registerMcpInClaudeJson()` unconditionally, so a
 * per-project install run from ANY CLI build (a scratch `tsc` emit, `npx tsx
 * cli/src/index.ts`, a second global install) re-pointed the operator's global
 * `~/.claude.json` `mcpServers.igris-brain.args[0]` to THAT build's bundle —
 * FR-243 Phase 3 (2026-09-07) did exactly this to the live config and only the
 * harness's own mid-session re-serialisation put it back. The rolling
 * `.igris.bak` then held the already-damaged state on the next run.
 *
 * THE CONTRACT (TD-455). Registration is GLOBAL and owned by `igris init`
 * (re-points, `--dev` aware) and `igris doctor --fix`. `igris install` goes
 * through `planClaudeMcpRegistration` first and only WRITES when the entry is
 * absent (`register`) or dangling (`repair`); an existing entry at a
 * DIFFERENT, EXISTING bundle is kept and named (`keep-foreign`); the same path
 * is a no-op. The 30-case writer contract (`mcp-register.test.ts`) is
 * untouched — this brief changes the CALLER, not the writer.
 *
 * FIXTURE. HOME is fenced through `process.env.HOME` (the writer keys off
 * `os.homedir()`; `IGRIS_BRAIN_DIR` alone is not a fence — TD-456) and
 * `IGRIS_BRAIN_DIR = $HOME/.igris`; `homedir() === fence` is asserted in
 * `beforeEach` so the fence is ARMED, not assumed; both keys are restored
 * INDIVIDUALLY in `afterEach` (test_standards: `process.env = saved` swaps in a
 * plain object and later HOME writes never reach libuv's getenv).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let fenceHome: string;
let projectDir: string;
let savedHome: string | undefined;
let savedBrainDir: string | undefined;

function claudeJson(): string {
  return join(fenceHome, ".claude.json");
}

/** A real-shaped ~/.claude.json: sibling top-level keys, a sibling server, and igris-brain at `entry`. */
function seedClaudeJson(entry: string): string {
  const doc = {
    numStartups: 42,
    projects: { "/Users/x/proj": { allowedTools: [] } },
    mcpServers: {
      "igris-fixture-other": { type: "stdio", command: "node", args: ["/opt/other/index.js"], env: {} },
      "igris-brain": { type: "stdio", command: "node", args: [entry], env: {} },
    },
  };
  const text = JSON.stringify(doc, null, 2) + "\n";
  writeFileSync(claudeJson(), text, { mode: 0o600 });
  return text;
}

function readDoc(): Record<string, unknown> {
  return JSON.parse(readFileSync(claudeJson(), "utf-8")) as Record<string, unknown>;
}

function brainArg0(doc: Record<string, unknown>): string {
  const servers = doc.mcpServers as Record<string, { args: string[] }>;
  return servers["igris-brain"]!.args[0]!;
}

async function captureInfo(run: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const logMod = await import("../lib/log.js");
  const lines: string[] = [];
  const spy = vi.spyOn(logMod, "info").mockImplementation((msg?: unknown) => {
    if (typeof msg === "string") lines.push(msg);
  });
  try {
    return { code: await run(), lines };
  } finally {
    spy.mockRestore();
  }
}

async function install(dryRun = false): Promise<{ code: number; lines: string[] }> {
  const { runInstall } = await import("../verbs/install.js");
  return captureInfo(() =>
    runInstall({ path: projectDir, installHooks: false, installGitHooks: false, dryRun }),
  );
}

beforeEach(async () => {
  savedHome = process.env.HOME;
  savedBrainDir = process.env.IGRIS_BRAIN_DIR;
  tmp = mkdtempSync(join(tmpdir(), "td455-"));
  fenceHome = join(tmp, "home");
  mkdirSync(fenceHome, { recursive: true });
  process.env.HOME = fenceHome;
  expect(homedir()).toBe(fenceHome); // the fence is ARMED
  const brain = join(fenceHome, ".igris");
  process.env.IGRIS_BRAIN_DIR = brain;
  mkdirSync(join(brain, "core", "hooks"), { recursive: true });
  mkdirSync(join(brain, "memory"), { recursive: true });
  writeFileSync(join(brain, "core", "hooks", "canonical-settings.json"), '{"hooks":{}}\n');
  projectDir = join(tmp, "proj");
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const ch = await import("../lib/canonical-hooks.js");
  ch.clearCache();
  const reg = await import("../lib/registry.js");
  reg.closeDb();
});

afterEach(async () => {
  const reg = await import("../lib/registry.js");
  reg.closeDb();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = savedBrainDir;
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// U1–U5: the pure decision
// ---------------------------------------------------------------------------

describe("TD-455 planClaudeMcpRegistration — the pure decision", () => {
  it("U1: not registered -> register", async () => {
    const { planClaudeMcpRegistration } = await import("../lib/mcp-register.js");
    expect(planClaudeMcpRegistration({ registered: false, pathExists: false, entryPath: null }, "/r/index.js")).toEqual({
      action: "register",
      existing: null,
    });
  });

  it("U2: registered, path missing -> repair, naming the dangling path", async () => {
    const { planClaudeMcpRegistration } = await import("../lib/mcp-register.js");
    expect(
      planClaudeMcpRegistration({ registered: true, pathExists: false, entryPath: "/gone/index.js" }, "/r/index.js"),
    ).toEqual({ action: "repair", existing: "/gone/index.js" });
  });

  it("U3: registered, exists, SAME path through a symlink (realpath-equal) -> noop", async () => {
    const { planClaudeMcpRegistration } = await import("../lib/mcp-register.js");
    const real = join(tmp, "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "index.js"), "// bundle\n");
    symlinkSync(real, join(tmp, "link"));
    const viaLink = join(tmp, "link", "index.js");
    expect(existsSync(viaLink)).toBe(true);
    expect(planClaudeMcpRegistration({ registered: true, pathExists: true, entryPath: viaLink }, join(real, "index.js"))).toEqual(
      { action: "noop", existing: viaLink },
    );
    // And the trivially-equal spelling.
    expect(
      planClaudeMcpRegistration({ registered: true, pathExists: true, entryPath: join(real, "index.js") }, join(real, ".", "index.js")),
    ).toEqual({ action: "noop", existing: join(real, "index.js") });
  });

  it("U4: registered, exists, DIFFERENT path -> keep-foreign", async () => {
    const { planClaudeMcpRegistration } = await import("../lib/mcp-register.js");
    const foreign = join(tmp, "foreign", "index.js");
    mkdirSync(join(tmp, "foreign"), { recursive: true });
    writeFileSync(foreign, "// foreign\n");
    expect(planClaudeMcpRegistration({ registered: true, pathExists: true, entryPath: foreign }, join(tmp, "running", "index.js"))).toEqual(
      { action: "keep-foreign", existing: foreign },
    );
  });

  it("U5: registered but malformed (entryPath null) -> repair", async () => {
    const { planClaudeMcpRegistration } = await import("../lib/mcp-register.js");
    expect(planClaudeMcpRegistration({ registered: true, pathExists: false, entryPath: null }, "/r/index.js")).toEqual({
      action: "repair",
      existing: null,
    });
  });
});

// ---------------------------------------------------------------------------
// V1–V5: install under a fenced HOME
// ---------------------------------------------------------------------------

describe("TD-455 install step 11 — keep-foreign / repair / register / noop (fenced HOME)", () => {
  it("V1: a foreign-but-EXISTING bundle is kept — bytes identical, no .igris.bak, the `kept ->` line names both paths", async () => {
    const { bundledMcpEntryPath } = await import("../lib/paths.js");
    const foreign = join(tmp, "foreign", "index.js");
    mkdirSync(join(tmp, "foreign"), { recursive: true });
    writeFileSync(foreign, "// foreign bundle\n");
    const before = seedClaudeJson(foreign);

    const { code, lines } = await install();
    expect(code).toBe(0);

    expect(readFileSync(claudeJson(), "utf-8")).toBe(before);
    expect(brainArg0(readDoc())).toBe(foreign);
    expect(existsSync(`${claudeJson()}.igris.bak`)).toBe(false);
    const kept = lines.find((l) => l.startsWith("igris-brain MCP kept -> "));
    expect(kept, lines.join("\n")).toBeDefined();
    expect(kept).toContain(foreign);
    expect(kept).toContain(`differs from the running bundle ${bundledMcpEntryPath()}`);
    expect(kept).toContain("igris init --upgrade");
    expect(lines.some((l) => l.startsWith("Registered igris-brain MCP"))).toBe(false);
  });

  it("V2: a DANGLING entry is repaired — args[0] = the running bundle, .igris.bak == the original bytes, every other key intact, the old->new line printed", async () => {
    const { bundledMcpEntryPath } = await import("../lib/paths.js");
    const gone = join(tmp, "gone", "index.js");
    expect(existsSync(gone)).toBe(false);
    const before = seedClaudeJson(gone);
    const beforeDoc = JSON.parse(before) as Record<string, unknown>;

    const { code, lines } = await install();
    expect(code).toBe(0);

    const after = readDoc();
    expect(brainArg0(after)).toBe(bundledMcpEntryPath());
    expect(readFileSync(`${claudeJson()}.igris.bak`, "utf-8")).toBe(before);
    // AC-3 byte witness: nothing else moved.
    expect(after.numStartups).toEqual(beforeDoc.numStartups);
    expect(after.projects).toEqual(beforeDoc.projects);
    expect((after.mcpServers as Record<string, unknown>)["igris-fixture-other"]).toEqual(
      (beforeDoc.mcpServers as Record<string, unknown>)["igris-fixture-other"],
    );
    expect(Object.keys(after).sort()).toEqual(Object.keys(beforeDoc).sort());
    const line = lines.find((l) => l.startsWith("re-pointed igris-brain MCP: "));
    expect(line, lines.join("\n")).toBeDefined();
    expect(line).toContain(`${gone} (missing) -> ${bundledMcpEntryPath()}`);
    expect(line).toContain(`backup ${claudeJson()}.igris.bak`);
  });

  it("V3: an ABSENT ~/.claude.json is registered", async () => {
    const { bundledMcpEntryPath } = await import("../lib/paths.js");
    expect(existsSync(claudeJson())).toBe(false);
    const { code, lines } = await install();
    expect(code).toBe(0);
    expect(brainArg0(readDoc())).toBe(bundledMcpEntryPath());
    expect(lines.some((l) => l.startsWith("Registered igris-brain MCP (registered) -> "))).toBe(true);
  });

  it("V4: a MATCHING registration is a no-op — no write (bytes and mtime identical)", async () => {
    await install(); // registers the running bundle
    const bytes = readFileSync(claudeJson(), "utf-8");
    const pinned = new Date("2026-09-01T09:00:00Z");
    utimesSync(claudeJson(), pinned, pinned);
    const mtime = statSync(claudeJson()).mtimeMs;

    const { code, lines } = await install();
    expect(code).toBe(0);
    expect(readFileSync(claudeJson(), "utf-8")).toBe(bytes);
    expect(statSync(claudeJson()).mtimeMs).toBe(mtime);
    expect(lines.some((l) => l.startsWith("Registered igris-brain MCP"))).toBe(false);
    expect(lines.some((l) => l.startsWith("igris-brain MCP kept"))).toBe(false);
  });

  it("V5: --dry-run names the decision for each of V1/V2/V3 and writes nothing", async () => {
    const { bundledMcpEntryPath } = await import("../lib/paths.js");
    // V1 shape
    const foreign = join(tmp, "foreign", "index.js");
    mkdirSync(join(tmp, "foreign"), { recursive: true });
    writeFileSync(foreign, "// foreign bundle\n");
    let before = seedClaudeJson(foreign);
    let out = await install(true);
    expect(out.code).toBe(0);
    let plan = out.lines.join("\n");
    expect(plan).toContain(`(keep) igris-brain MCP (keep (differs from the running bundle): ${foreign})`);
    expect(plan).not.toContain("register igris-brain MCP server");
    expect(readFileSync(claudeJson(), "utf-8")).toBe(before);

    // V2 shape
    const gone = join(tmp, "gone", "index.js");
    before = seedClaudeJson(gone);
    out = await install(true);
    plan = out.lines.join("\n");
    expect(plan).toContain(`${claudeJson()} (register igris-brain MCP server (repair: ${gone} missing))`);
    expect(readFileSync(claudeJson(), "utf-8")).toBe(before);

    // V3 shape
    rmSync(claudeJson());
    out = await install(true);
    plan = out.lines.join("\n");
    expect(plan).toContain(`${claudeJson()} (register igris-brain MCP server (absent))`);
    expect(existsSync(claudeJson())).toBe(false);

    // V4 shape: already at the running bundle -> (skip)
    seedClaudeJson(bundledMcpEntryPath());
    out = await install(true);
    plan = out.lines.join("\n");
    expect(plan).toContain("(skip) igris-brain MCP (already registered (no write))");
  });
});
