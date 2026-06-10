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
import { addCoreSkill, addCoreAgent } from "../verbs/add-core.js";

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

/** Seed the §13 agent enumeration surfaces a core agent add expects on disk. */
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
  mkdirSync(join(repoRoot, "core", "templates"), { recursive: true });
  writeFileSync(
    join(repoRoot, "core", "igris_tree.json"),
    `${JSON.stringify({ agents: { architect: { load: [] } } }, null, 2)}\n`,
  );
  writeFileSync(
    join(repoRoot, "core", "templates", "CLAUDE.md.tmpl"),
    "## Available Agents\narchitect, forger\n",
  );
  writeFileSync(
    join(repoRoot, "CLAUDE.md"),
    "## Available Agents\narchitect, forger\n",
  );
}

describe("addCoreAgent — happy path", () => {
  beforeEach(() => {
    seedAgentRepo(repo);
  });

  it("writes the prompt, manifest entry, §13 surfaces + mirrors MATCH", () => {
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

    // (3a) igris_tree.json agents map gained the entry (+ mirror).
    const tree = JSON.parse(
      readFileSync(join(repo, "core", "igris_tree.json"), "utf-8"),
    ) as { agents: Record<string, unknown> };
    expect(tree.agents).toHaveProperty("scribe");
    expect(readFileSync(join(brain, "core", "igris_tree.json"), "utf-8")).toBe(
      readFileSync(join(repo, "core", "igris_tree.json"), "utf-8"),
    );

    // (3b) both Available Agents lines gained `scribe`, single-line, mirrored.
    const tmpl = readFileSync(join(repo, "core", "templates", "CLAUDE.md.tmpl"), "utf-8");
    expect(tmpl).toContain("architect, forger, scribe");
    expect(readFileSync(join(brain, "core", "templates", "CLAUDE.md.tmpl"), "utf-8")).toBe(tmpl);
    const rootClaude = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(rootClaude).toContain("architect, forger, scribe");
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

describe("addCoreAgent — idempotent re-add of an enumeration name", () => {
  beforeEach(() => {
    seedAgentRepo(repo);
  });

  it("does not duplicate a name already in the Available Agents line", () => {
    // Pre-seed the CSV lines with the target name (but NOT the manifest), so the
    // enumeration step must be idempotent on the CSV while still adding the rest.
    writeFileSync(
      join(repo, "core", "templates", "CLAUDE.md.tmpl"),
      "## Available Agents\narchitect, forger, scribe\n",
    );
    const r = addCoreAgent({
      name: "scribe",
      projectRoot: repo,
      brainRoot: brain,
      skipMirror: true,
    });
    expect(r.ok).toBe(true);
    const tmpl = readFileSync(join(repo, "core", "templates", "CLAUDE.md.tmpl"), "utf-8");
    // Exactly one occurrence — no duplicate.
    expect(tmpl.match(/scribe/g)?.length).toBe(1);
  });
});
