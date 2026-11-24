/**
 * TD-496 part 2 (AC4) — no core agent, and not the agent template, carries a
 * `memory:` key in its frontmatter.
 *
 * `memory: project` gave each core agent a per-role memory directory and, with
 * it, Read, Write and Edit on that directory, whatever its `tools:` line said.
 * TD-496 moved those lessons into the brain (role-tagged learnings that `/hunt`
 * pastes into each delegation through `igris lessons digest`) and removed the
 * key. Claude reads `core/agents/<name>.md` through the runtime mirror, and
 * OpenCode copies the key through to its compiled target, so the source line
 * is the one place to keep it out.
 *
 * Vacuity guard: the agent set is pinned at exactly nine, by name, and each
 * file must open with a frontmatter block that names itself. A wrong directory,
 * an empty glob or a missing fence would otherwise read as "no memory key".
 *
 * BR-106 triage: NO-SUT, out of scope. This file imports nothing from
 * `cli/src/lib` or `cli/src/verbs`; it only reads tracked repo files.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The real igris-ai checkout, resolved from THIS FILE — never from cwd. */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const AGENTS_DIR = join(REPO_ROOT, "core", "agents");
const TEMPLATE = join(REPO_ROOT, "core", "templates", "agent.md");

const CORE_AGENTS = [
  "aegis",
  "architect",
  "forger",
  "mender",
  "sage",
  "scribe",
  "seeker",
  "sentinel",
  "warden",
];

/** The text between the opening `---` line and the next `---` line, or null. */
function frontmatter(text: string): string | null {
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  return end === -1 ? null : lines.slice(1, end).join("\n");
}

describe("TD-496 part 2 — core agent frontmatter carries no memory key", () => {
  it("vacuity: core/agents holds exactly the nine core agents", () => {
    const found = readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
    expect(found).toEqual(CORE_AGENTS);
  });

  it.each(CORE_AGENTS)("%s.md has frontmatter that names itself and no ^memory: line", (name) => {
    const fm = frontmatter(readFileSync(join(AGENTS_DIR, `${name}.md`), "utf-8"));
    expect(fm).not.toBeNull();
    expect(fm!).toMatch(new RegExp(`^name: ${name}$`, "m"));
    expect(fm!).not.toMatch(/^memory\s*:/m);
  });

  it("core/templates/agent.md has frontmatter and no ^memory: line", () => {
    const fm = frontmatter(readFileSync(TEMPLATE, "utf-8"));
    expect(fm).not.toBeNull();
    expect(fm!).toMatch(/^name: \{name\}$/m);
    expect(fm!).not.toMatch(/^memory\s*:/m);
  });

  it("negative control: the parser does see a memory key when one is present", () => {
    const fm = frontmatter("---\nname: probe\nmemory: project\n---\n\n# body\n");
    expect(fm).not.toBeNull();
    expect(fm!).toMatch(/^memory\s*:/m);
    // A memory line in the body is outside the frontmatter and does not count.
    expect(frontmatter("---\nname: probe\n---\n\nmemory: project\n")!).not.toMatch(/^memory\s*:/m);
  });
});

/**
 * FR-277 (AC7) — the model line is map-generated, and no prompt body names a
 * model. `compile_harnesses.sh` stamps each role's `model:` and `effort:` from
 * the claude column of `harness-manifest.json` `model_tiers`; this pins the
 * committed canonicals to the map (AF2) and keeps model literals out of the
 * bodies (AF1). The case-insensitive literal set is AC7's grep.
 */
const MANIFEST = join(REPO_ROOT, "harness-manifest.json");
const MODEL_LITERAL = /\b(opus|sonnet|haiku|fable|gpt-[0-9])/i;

/** The text after the closing `---` line. */
function body(text: string): string {
  const lines = text.split("\n");
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  return lines.slice(end + 1).join("\n");
}

interface TierColumn {
  provider: string;
  model: string;
  effort: string;
}
interface ModelTiers {
  tiers: Record<string, { claude: TierColumn; codex: TierColumn }>;
  roles: Record<string, { tier: string; effort?: string }>;
}

/** The manifest's tier map; read per test so a missing map fails the test, not collection. */
function modelTiers(): ModelTiers {
  const mt = (JSON.parse(readFileSync(MANIFEST, "utf-8")) as { model_tiers?: ModelTiers }).model_tiers;
  expect(mt).toBeDefined();
  return mt!;
}

describe("FR-277 — core agent model lines come from the tier map", () => {
  it("AF2 vacuity: every core agent has a role, and every role is a core agent", () => {
    expect(Object.keys(modelTiers().roles).sort()).toEqual(CORE_AGENTS);
  });

  it.each(CORE_AGENTS)("AF2: %s.md frontmatter model:/effort: equal the map's claude column", (name) => {
    const mt = modelTiers();
    const fm = frontmatter(readFileSync(join(AGENTS_DIR, `${name}.md`), "utf-8"))!;
    const role = mt.roles[name];
    const col = mt.tiers[role.tier].claude;
    const lines = fm.split("\n").filter((l) => /^(model|effort):/.test(l));
    expect(lines).toEqual([`model: ${col.model}`, `effort: ${role.effort ?? col.effort}`]);
  });

  it.each(CORE_AGENTS)("AF1: %s.md body carries no model literal", (name) => {
    expect(body(readFileSync(join(AGENTS_DIR, `${name}.md`), "utf-8"))).not.toMatch(MODEL_LITERAL);
  });

  it("AF1 negative control: a planted body line is caught; the frontmatter line is not body", () => {
    expect(body("---\nname: probe\nmodel: opus\n---\n\n# Probe\nRun on Sonnet.\n")).toMatch(MODEL_LITERAL);
    expect(body("---\nname: probe\nmodel: opus\n---\n\n# Probe\n")).not.toMatch(MODEL_LITERAL);
  });
});
