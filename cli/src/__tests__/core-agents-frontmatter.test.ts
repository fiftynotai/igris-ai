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
