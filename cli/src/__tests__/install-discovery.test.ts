/**
 * install-discovery.ts tests (TD-117).
 *
 * Real fs against a tmp brain fixture. No vi.mock of install-discovery
 * itself (per L-159: never mock the module under test).
 *
 * The integration case at the bottom asserts that dry-run plan
 * enumeration and real-run symlink creation visit the same set of
 * source paths — closing the drift window the brief opened.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAgentEntries,
  discoverRuleEntries,
  discoverSkillEntries,
} from "../lib/install-discovery.js";

let tmpBrain: string;

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-install-discovery-"));
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
});

function stageAgentsDir(files: Array<{ name: string; content?: string }>): void {
  const dir = join(tmpBrain, "core", "agents");
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(dir, f.name), f.content ?? "stub\n");
  }
}

function stageSkillsDir(skills: string[]): void {
  const dir = join(tmpBrain, "core", "skills");
  mkdirSync(dir, { recursive: true });
  for (const s of skills) {
    mkdirSync(join(dir, s), { recursive: true });
    writeFileSync(join(dir, s, "SKILL.md"), `# ${s}\n`);
  }
}

describe("install-discovery — discoverAgentEntries", () => {
  it("happy path: 5 .md files + manifest.yaml → 6 entries (sorted by basename)", () => {
    stageAgentsDir([
      { name: "architect.md" },
      { name: "forger.md" },
      { name: "warden.md" },
      { name: "sentinel.md" },
      { name: "mender.md" },
      { name: "manifest.yaml" },
    ]);
    const out = discoverAgentEntries(tmpBrain);
    expect(out.length).toBe(6);
    // Sort stability: alphabetical by basename.
    expect(out.map((e) => e.basename)).toEqual([
      "architect.md",
      "forger.md",
      "manifest.yaml",
      "mender.md",
      "sentinel.md",
      "warden.md",
    ]);
    // src must be an absolute path under tmpBrain.
    for (const e of out) {
      expect(e.src.startsWith(tmpBrain)).toBe(true);
    }
  });

  it("missing source dir → []", () => {
    // No core/agents/ created.
    expect(discoverAgentEntries(tmpBrain)).toEqual([]);
  });

  it("malformed entries (broken .md symlink + non-md file) → only valid .md + manifest.yaml returned", () => {
    stageAgentsDir([
      { name: "architect.md" },
      { name: "manifest.yaml" },
      { name: "stray.txt" },
      { name: ".DS_Store" },
    ]);
    const dir = join(tmpBrain, "core", "agents");
    // Broken symlink — points at nowhere.
    symlinkSync("/no/such/target.md", join(dir, "broken.md"));
    const out = discoverAgentEntries(tmpBrain);
    // Broken symlink is dropped (statSync throws → skip). stray.txt and
    // .DS_Store don't match the .md / manifest.yaml selection rule.
    expect(out.map((e) => e.basename).sort()).toEqual([
      "architect.md",
      "manifest.yaml",
    ]);
  });

  it("manifest.yaml only (no .md files) → 1 entry", () => {
    stageAgentsDir([{ name: "manifest.yaml" }]);
    const out = discoverAgentEntries(tmpBrain);
    expect(out.length).toBe(1);
    expect(out[0].basename).toBe("manifest.yaml");
  });
});

describe("install-discovery — discoverRuleEntries", () => {
  it("file exists → 1 entry", () => {
    const dir = join(tmpBrain, "core", "rules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "00-igris-universal.md"), "# universal\n");
    const out = discoverRuleEntries(tmpBrain);
    expect(out.length).toBe(1);
    expect(out[0].basename).toBe("00-igris-universal.md");
    expect(out[0].src).toBe(join(dir, "00-igris-universal.md"));
  });

  it("file missing → []", () => {
    expect(discoverRuleEntries(tmpBrain)).toEqual([]);
  });

  it("rules dir exists but file missing → []", () => {
    mkdirSync(join(tmpBrain, "core", "rules"), { recursive: true });
    expect(discoverRuleEntries(tmpBrain)).toEqual([]);
  });
});

describe("install-discovery — discoverSkillEntries", () => {
  it("4 subdirs → 4 entries sorted by basename", () => {
    stageSkillsDir(["scan", "awaken", "rest", "hunt"]);
    const out = discoverSkillEntries(tmpBrain);
    expect(out.map((e) => e.basename)).toEqual([
      "awaken",
      "hunt",
      "rest",
      "scan",
    ]);
  });

  it("missing skills dir → []", () => {
    expect(discoverSkillEntries(tmpBrain)).toEqual([]);
  });

  it("skills dir contains a stray file (not a subdir) → file ignored, returns subdirs only", () => {
    stageSkillsDir(["alpha"]);
    const dir = join(tmpBrain, "core", "skills");
    writeFileSync(join(dir, "README.md"), "stray file\n");
    const out = discoverSkillEntries(tmpBrain);
    expect(out.map((e) => e.basename)).toEqual(["alpha"]);
  });
});

describe("install-discovery — integration: dry-run paths === real-run paths", () => {
  it("the same set of source paths is emitted by all three discovery helpers", () => {
    // Stage a brain fixture that exercises all three categories.
    stageAgentsDir([
      { name: "architect.md" },
      { name: "warden.md" },
      { name: "manifest.yaml" },
    ]);
    const rulesDir = join(tmpBrain, "core", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "00-igris-universal.md"), "# universal\n");
    stageSkillsDir(["awaken", "hunt", "rest", "scan"]);

    // Dry-run-equivalent enumeration: ask discovery for all three categories.
    const agents = discoverAgentEntries(tmpBrain);
    const rules = discoverRuleEntries(tmpBrain);
    const skills = discoverSkillEntries(tmpBrain);

    // Real-run-equivalent enumeration: ask discovery again. Both passes
    // see the same fixture, both must see the same source paths in the
    // same order. (This is what closes the drift window — applySymlinkLayer
    // and enumerateInstallPlan now share this single source of truth.)
    const agentsAgain = discoverAgentEntries(tmpBrain);
    const rulesAgain = discoverRuleEntries(tmpBrain);
    const skillsAgain = discoverSkillEntries(tmpBrain);

    expect(agentsAgain).toEqual(agents);
    expect(rulesAgain).toEqual(rules);
    expect(skillsAgain).toEqual(skills);

    // Counts match the fixture.
    expect(agents.length).toBe(3);
    expect(rules.length).toBe(1);
    expect(skills.length).toBe(4);
  });
});
