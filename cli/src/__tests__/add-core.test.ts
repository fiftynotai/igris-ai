/**
 * FR-180: add-core (core-path skill writer) tests.
 *
 * Exercises `addCoreSkill` against a sandbox "repo" + brain (temp dirs) so the
 * real source-scaffold write + the TD-096 cp-mirror + verify_mirror.sh run
 * without touching the live igris-ai checkout. Asserts: the scaffold lands with
 * a DOUBLE-QUOTED colon-bearing `description:` (§13 #587), the runtime mirror is
 * byte-identical (verify_mirror MATCH), refuse-to-clobber on an existing skill,
 * and name validation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addCoreSkill, addCoreAgent, addCoreMcp } from "../verbs/add-core.js";
import { removeCoreAgent } from "../verbs/remove-core.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

let sandbox: string;
let repo: string;
let brain: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-add-core-"));
  repo = join(sandbox, "repo");
  brain = join(sandbox, "brain");
  mkdirSync(repo, { recursive: true });
  // The verify_mirror.sh primitive must live at <brain>/core/scripts/.
  mkdirSync(join(brain, "core", "scripts"), { recursive: true });
  cpSync(
    join(REPO_ROOT, "core", "scripts", "verify_mirror.sh"),
    join(brain, "core", "scripts", "verify_mirror.sh"),
  );
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("addCoreSkill — happy path", () => {
  it("writes the scaffold + mirrors + verifies MATCH", () => {
    const r = addCoreSkill({ name: "mytool", projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);

    // Source scaffold landed at <repo>/core/skills/mytool/SKILL.md.
    const src = join(repo, "core", "skills", "mytool", "SKILL.md");
    expect(existsSync(src)).toBe(true);
    const text = readFileSync(src, "utf-8");

    // §13 #587: the colon-bearing description scalar is DOUBLE-QUOTED.
    expect(text).toMatch(/^description: ".*usage: \/mytool"$/m);
    expect(text).toContain("name: mytool");

    // Runtime mirror is byte-identical and verify_mirror reported MATCH.
    const mirror = join(brain, "core", "skills", "mytool", "SKILL.md");
    expect(existsSync(mirror)).toBe(true);
    expect(readFileSync(mirror, "utf-8")).toBe(text);
    expect(r.verifyOutput).toContain("verdict:    MATCH");
    expect(r.verifyOutput).toContain("0 MISMATCH");
  });
});

describe("addCoreSkill — guards", () => {
  it("refuses to clobber an existing core skill (no overwrite)", () => {
    const dir = join(repo, "core", "skills", "mytool");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "PRE-EXISTING\n");
    const r = addCoreSkill({ name: "mytool", projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.reason).toContain("already exists");
    // The pre-existing file is untouched.
    expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toBe("PRE-EXISTING\n");
  });

  it("rejects a missing name (exit 2)", () => {
    const r = addCoreSkill({ name: undefined, projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
  });

  it("rejects an invalid name (exit 2)", () => {
    const r = addCoreSkill({ name: "Bad Name", projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
    expect(r.reason).toContain("must match");
  });
});

describe("addCoreSkill — skipMirror seam", () => {
  it("writes source only when skipMirror is set", () => {
    const r = addCoreSkill({
      name: "mytool",
      projectRoot: repo,
      brainRoot: brain,
      skipMirror: true,
    });
    expect(r.ok).toBe(true);
    expect(existsSync(join(repo, "core", "skills", "mytool", "SKILL.md"))).toBe(true);
    expect(existsSync(join(brain, "core", "skills", "mytool", "SKILL.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FR-180 Phase 2: addCoreAgent.
// ---------------------------------------------------------------------------

/**
 * Seed what a core agent add (FR-187 Phase 2b) expects on disk:
 *   - the repo-root harness-manifest.json (with one pre-existing agent);
 *   - the REAL gen_os_index.sh generator + a minimal core/os/ module + SOUL.md
 *     + a pre-existing core/agents/architect.md, so running the generator
 *     produces a real frontmatter-discovered roster in core/os/INDEX.md.
 * The generator only needs core/os/*.md (with full frontmatter), core/SOUL.md,
 * core/agents/*.md, and the script itself — it resolves all paths from its own
 * location and writes core/os/INDEX.md. (Operator A1 + memory #872: the agent
 * roster is discovered from frontmatter, NOT the retired tree/CLAUDE.md surfaces.)
 */
function seedAgentRepo(repoRoot: string): void {
  // Repo-root harness-manifest.json with one pre-existing agent.
  writeFileSync(
    join(repoRoot, "harness-manifest.json"),
    `${JSON.stringify(
      {
        version: 1,
        agents: [
          {
            name: "architect",
            canonical: { dir: "core/agents", file: "architect.md", versioned: false },
            targets: [
              { type: "codex", path: ".codex/agents/architect.toml" },
              { type: "gemini", path: "~/.gemini/agents/architect.md" },
              { type: "opencode", path: "~/.config/opencode/agent/architect.md" },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  // The REAL discovery generator (FR-187 Phase 2b enumeration source of truth).
  mkdirSync(join(repoRoot, "core", "scripts"), { recursive: true });
  cpSync(
    join(REPO_ROOT, "core", "scripts", "gen_os_index.sh"),
    join(repoRoot, "core", "scripts", "gen_os_index.sh"),
  );

  // A minimal core/os/ module + SOUL.md so the generator has a module table to
  // emit (it hard-fails on incomplete frontmatter, so both carry full fields).
  mkdirSync(join(repoRoot, "core", "os"), { recursive: true });
  writeFileSync(
    join(repoRoot, "core", "os", "conduct.md"),
    "---\nlayer: conduct\ntier: boot\nscope: orchestrator\nsummary: test module\n---\nbody\n",
  );
  writeFileSync(
    join(repoRoot, "core", "SOUL.md"),
    "---\nlayer: identity\ntier: boot\nscope: orchestrator\nsummary: persona\n---\nsoul\n",
  );

  // A pre-existing core agent .md so the roster starts non-empty (mirrors the
  // architect manifest entry above).
  mkdirSync(join(repoRoot, "core", "agents"), { recursive: true });
  writeFileSync(
    join(repoRoot, "core", "agents", "architect.md"),
    '---\nname: architect\ndescription: "Strategic implementation planner."\n---\nbody\n',
  );
}

describe("addCoreAgent — happy path", () => {
  beforeEach(() => {
    seedAgentRepo(repo);
  });

  it("writes the prompt, manifest entry, regenerates the roster + mirrors MATCH", () => {
    const r = addCoreAgent({ name: "scribe", projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);

    // (1) Canonical prompt landed with a DOUBLE-QUOTED description (§13 #587).
    const src = join(repo, "core", "agents", "scribe.md");
    expect(existsSync(src)).toBe(true);
    const text = readFileSync(src, "utf-8");
    expect(text).toMatch(/^description: ".*"$/m);
    expect(text).toContain("name: scribe");
    // Runtime mirror is byte-identical + verify_mirror MATCH.
    const mirror = join(brain, "core", "agents", "scribe.md");
    expect(readFileSync(mirror, "utf-8")).toBe(text);
    expect(r.verifyOutput).toContain("MATCH");
    expect(r.verifyOutput).toContain("0 MISMATCH");

    // (2) Manifest entry appended with codex/gemini/opencode targets.
    const manifest = JSON.parse(
      readFileSync(join(repo, "harness-manifest.json"), "utf-8"),
    ) as { agents: Array<{ name: string; targets: Array<{ type: string }> }> };
    const entry = manifest.agents.find((a) => a.name === "scribe");
    expect(entry).toBeDefined();
    expect(entry!.targets.map((t) => t.type).sort()).toEqual([
      "codex",
      "gemini",
      "opencode",
    ]);

    // (3) ENUMERATION (FR-187 Phase 2b): the regenerated roster now contains the
    // new agent, discovered from its frontmatter — NOT from a tree/CLAUDE.md CSV.
    const index = readFileSync(join(repo, "core", "os", "INDEX.md"), "utf-8");
    expect(index).toContain("## Agent roster");
    expect(index).toContain("| scribe |");
    // The pre-existing agent is still present (the INDEX is regenerated wholesale).
    expect(index).toContain("| architect |");

    // (3-neg) The retired enumeration surfaces are NOT written by the add path.
    expect(existsSync(join(repo, "core", "igris_tree.json"))).toBe(false);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
  });
});

describe("addCoreAgent — guards", () => {
  beforeEach(() => {
    seedAgentRepo(repo);
  });

  it("refuses to clobber an existing canonical prompt", () => {
    const dir = join(repo, "core", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scribe.md"), "PRE-EXISTING\n");
    const r = addCoreAgent({ name: "scribe", projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.reason).toContain("already exists");
    expect(readFileSync(join(dir, "scribe.md"), "utf-8")).toBe("PRE-EXISTING\n");
  });

  it("refuses an agent name already declared in the manifest", () => {
    // Remove the seeded architect prompt so the prompt-clobber guard is skipped
    // and the manifest-collision guard (the one under test) is the one that fires.
    rmSync(join(repo, "core", "agents", "architect.md"), { force: true });
    const r = addCoreAgent({ name: "architect", projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.reason).toContain("already declared");
    // No prompt written for the rejected re-add.
    expect(existsSync(join(repo, "core", "agents", "architect.md"))).toBe(false);
  });

  it("rejects a missing name (exit 2)", () => {
    const r = addCoreAgent({ name: undefined, projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
  });

  it("rejects an invalid name (exit 2)", () => {
    const r = addCoreAgent({ name: "Bad Name", projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
    expect(r.reason).toContain("must match");
  });

  it("fails when not an igris-ai checkout (no harness-manifest.json)", () => {
    const bare = join(sandbox, "bare");
    mkdirSync(bare, { recursive: true });
    const r = addCoreAgent({ name: "scribe", projectRoot: bare, brainRoot: brain });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.reason).toContain("not an igris-ai checkout");
  });
});

describe("addCoreAgent — wholesale-regen idempotency (no duplicate roster rows)", () => {
  beforeEach(() => {
    seedAgentRepo(repo);
  });

  it("the regenerated roster lists the new agent exactly once", () => {
    // FR-187 Phase 2b: enumeration is a WHOLESALE regen of core/os/INDEX.md from
    // the on-disk agent frontmatter, so a name can never be double-listed — even
    // if the generator runs over an already-rostered agent. We assert exactly one
    // roster row for the freshly-added agent.
    const r = addCoreAgent({
      name: "scribe",
      projectRoot: repo,
      brainRoot: brain,
      skipMirror: true,
    });
    expect(r.ok).toBe(true);
    const index = readFileSync(join(repo, "core", "os", "INDEX.md"), "utf-8");
    // Exactly one roster row for scribe — the `| scribe |` cell appears once.
    expect(index.match(/\| scribe \|/g)?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FR-187 Phase 2b: removeCoreAgent — the inverse enumeration (roster regen).
// ---------------------------------------------------------------------------

describe("removeCoreAgent — happy path (roster regen drops the agent)", () => {
  beforeEach(() => {
    seedAgentRepo(repo);
  });

  it("deletes the prompt + manifest entry + regenerates the roster WITHOUT the agent", () => {
    // Add first so there is a real agent to remove (prompt + manifest + roster row).
    const added = addCoreAgent({ name: "scribe", projectRoot: repo, brainRoot: brain });
    expect(added.ok).toBe(true);
    expect(readFileSync(join(repo, "core", "os", "INDEX.md"), "utf-8")).toContain(
      "| scribe |",
    );

    const r = removeCoreAgent({ name: "scribe", projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.removed).toBe(true);

    // (1) Canonical prompt + runtime mirror are gone (DELETE-BOTH).
    expect(existsSync(join(repo, "core", "agents", "scribe.md"))).toBe(false);
    expect(existsSync(join(brain, "core", "agents", "scribe.md"))).toBe(false);

    // (2) Manifest entry spliced out; the pre-existing architect survives.
    const manifest = JSON.parse(
      readFileSync(join(repo, "harness-manifest.json"), "utf-8"),
    ) as { agents: Array<{ name: string }> };
    expect(manifest.agents.map((a) => a.name)).not.toContain("scribe");
    expect(manifest.agents.map((a) => a.name)).toContain("architect");

    // (3) ENUMERATION: the regenerated roster no longer contains the removed
    // agent, but still lists the survivor (wholesale frontmatter discovery).
    const index = readFileSync(join(repo, "core", "os", "INDEX.md"), "utf-8");
    expect(index).not.toContain("| scribe |");
    expect(index).toContain("| architect |");
  });
});

describe("removeCoreAgent — idempotent remove of an already-absent agent", () => {
  beforeEach(() => {
    seedAgentRepo(repo);
  });

  it("tolerates removing an agent that was never added (no throw, roster clean)", () => {
    // The agent 'ghost' was never added — remove must be a tolerant no-op that
    // still leaves a clean, regenerated roster (the row stays absent).
    const r = removeCoreAgent({ name: "ghost", projectRoot: repo, brainRoot: brain });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    // Nothing actually existed to remove → no-phantom: removed is false.
    expect(r.removed).toBe(false);
    const index = readFileSync(join(repo, "core", "os", "INDEX.md"), "utf-8");
    expect(index).not.toContain("| ghost |");
    // The survivor is intact.
    expect(index).toContain("| architect |");
  });
});

// ---------------------------------------------------------------------------
// FR-180 Phase 3: addCoreMcp.
// ---------------------------------------------------------------------------

/** Seed the core surfaces-manifest.json a core MCP add appends into. */
function seedSurfacesManifest(repoRoot: string): string {
  const dir = join(repoRoot, "core", "scripts", "cli-adapters");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "surfaces-manifest.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        $schema: "./manifest.schema.json",
        version: 1,
        agents: [],
        surfaces: {
          skills: [
            {
              source: "~/.igris/core/skills",
              layer: "core",
              targets: [
                { type: "claude", method: "symlink", path: "~/.claude/skills" },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

describe("addCoreMcp — happy path", () => {
  it("appends the mcp_servers block + mirrors + verifies MATCH", () => {
    const manifestPath = seedSurfacesManifest(repo);
    const r = addCoreMcp({
      name: "myserver",
      projectRoot: repo,
      command: "node",
      args: ["server.js"],
      env: ["API_KEY=${MY_TOKEN}"],
      targets: ["claude:merge", "codex:merge:false"],
      startupTimeoutSec: 30,
      brainRoot: brain,
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      surfaces: {
        mcp_servers: Array<{
          name: string;
          layer: string;
          canonical: {
            command: string;
            args?: string[];
            env?: Record<string, string>;
            startup_timeout_sec?: number;
          };
          targets: Array<{ type: string; method: string; enabled?: boolean }>;
        }>;
      };
    };
    const block = manifest.surfaces.mcp_servers.find((m) => m.name === "myserver");
    expect(block).toBeDefined();
    expect(block!.layer).toBe("core");
    expect(block!.canonical.command).toBe("node");
    expect(block!.canonical.args).toEqual(["server.js"]);
    // §14: the ${VAR} indirection ref is stored verbatim (NOT a resolved secret).
    expect(block!.canonical.env).toEqual({ API_KEY: "${MY_TOKEN}" });
    expect(block!.canonical.startup_timeout_sec).toBe(30);
    expect(block!.targets.map((t) => t.type).sort()).toEqual(["claude", "codex"]);
    const codexTarget = block!.targets.find((t) => t.type === "codex");
    expect(codexTarget!.enabled).toBe(false);

    // The skills block is preserved (we appended, not clobbered).
    expect(manifest.surfaces).toHaveProperty("skills");

    // Runtime mirror is byte-identical + verify_mirror MATCH.
    const mirror = join(brain, "core", "scripts", "cli-adapters", "surfaces-manifest.json");
    expect(readFileSync(mirror, "utf-8")).toBe(readFileSync(manifestPath, "utf-8"));
    expect(r.verifyOutput).toContain("MATCH");
    expect(r.verifyOutput).toContain("0 MISMATCH");
  });
});

describe("addCoreMcp — §14 inline-secret rejection", () => {
  it("REJECTS an --env value that is not a single ${VAR} reference", () => {
    seedSurfacesManifest(repo);
    const r = addCoreMcp({
      name: "myserver",
      projectRoot: repo,
      command: "node",
      env: ["API_KEY=sk-live-abc123"],
      targets: ["claude:merge"],
      brainRoot: brain,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
    expect(r.reason).toContain("must be a single ${VAR}");
    // Nothing was written — the reject is BEFORE the disk write.
    const manifest = JSON.parse(
      readFileSync(join(repo, "core", "scripts", "cli-adapters", "surfaces-manifest.json"), "utf-8"),
    ) as { surfaces: Record<string, unknown> };
    expect(manifest.surfaces).not.toHaveProperty("mcp_servers");
  });
});

describe("addCoreMcp — guards", () => {
  beforeEach(() => {
    seedSurfacesManifest(repo);
  });

  it("refuses to clobber a name already declared", () => {
    addCoreMcp({
      name: "dupe",
      projectRoot: repo,
      command: "node",
      targets: ["claude:merge"],
      skipMirror: true,
    });
    const r = addCoreMcp({
      name: "dupe",
      projectRoot: repo,
      command: "other",
      targets: ["gemini:merge"],
      skipMirror: true,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.reason).toContain("already declared");
  });

  it("rejects a missing name (exit 2)", () => {
    const r = addCoreMcp({
      name: undefined,
      projectRoot: repo,
      command: "node",
      targets: ["claude:merge"],
      brainRoot: brain,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
  });

  it("rejects a missing --command for a new server (exit 2)", () => {
    const r = addCoreMcp({
      name: "myserver",
      projectRoot: repo,
      targets: ["claude:merge"],
      brainRoot: brain,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
    expect(r.reason).toContain("--command");
  });

  it("rejects zero targets (exit 2)", () => {
    const r = addCoreMcp({
      name: "myserver",
      projectRoot: repo,
      command: "node",
      targets: [],
      brainRoot: brain,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
    expect(r.reason).toContain("at least one --target");
  });

  it("rejects an invalid target type (exit 2)", () => {
    const r = addCoreMcp({
      name: "myserver",
      projectRoot: repo,
      command: "node",
      targets: ["bogus:merge"],
      brainRoot: brain,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
    expect(r.reason).toContain("is not one of");
  });

  it("fails when not an igris-ai checkout (no surfaces-manifest.json)", () => {
    const bare = join(sandbox, "bare-mcp");
    mkdirSync(bare, { recursive: true });
    const r = addCoreMcp({
      name: "myserver",
      projectRoot: bare,
      command: "node",
      targets: ["claude:merge"],
      brainRoot: brain,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.reason).toContain("not an igris-ai checkout");
  });
});
