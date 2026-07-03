/**
 * TD-223 (RE-SCOPED — corrected root cause) — skills-pollution.ts unit tests.
 *
 * Covers the surface-root migration machinery against a sandbox HOME (NEVER the
 * operator's real ~). The manifest declares the canonical `claude/symlink`
 * skills target (`~/.igris/core/skills` → `~/.claude/skills`); the agents root
 * (`~/.claude/agents` ← `~/.igris/core/agents`) is synthesized. IGRIS_BRAIN_DIR
 * + HOME both point into the same sandbox tmp dir.
 *
 * Scenario coverage (plan §5):
 *   T1  skills whole-dir symlink → migrated (real dir of per-item symlinks)
 *   T2  agents whole-dir symlink → migrated (parity; manifest.yaml preserved)
 *   T3  no skill lost (before/after ⊇), incl. personal overlay skill
 *   T4  stray source symlink cleaned (projection)
 *   T5  stray NOT a projection → report-only (never removed)
 *   T6  idempotent re-run (no 2nd .bak)
 *   T7  root symlink → UNEXPECTED target → refuse + report (untouched)
 *   T8  symlink-escape / containment refused (#515)
 *   T9  already real dir → not flagged
 *   T10 recurrence guard — re-detected after a re-created whole-dir symlink
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyMigration,
  classifySurfaceRoot,
  declaredSurfaceRoots,
  enumerateCanonicalSkills,
  enumerateCoreAgents,
  enumeratePersonalSkills,
  enumeratePersonalAgents,
  findStraySourceSymlinks,
  migrateSurfaceRoot,
  removeStraySourceSymlink,
  type SurfaceRoot,
} from "../lib/skills-pollution.js";

let tmpRoot: string;
let homeOverride: string;
let homeBackup: string | undefined;
let brainBackup: string | undefined;

function skillsSource(): string {
  return join(homeOverride, ".igris", "core", "skills");
}
function agentsSource(): string {
  return join(homeOverride, ".igris", "core", "agents");
}
function claudeSkillsRoot(): string {
  return join(homeOverride, ".claude", "skills");
}
function claudeAgentsRoot(): string {
  return join(homeOverride, ".claude", "agents");
}
function loadoutDir(): string {
  return join(homeOverride, ".igris", "loadout");
}
function overlayPath(): string {
  return join(loadoutDir(), "harness-manifest.personal.json");
}

/** Create a canonical core skill `<name>` with a SKILL.md + nested aux file. */
function stageCoreSkill(name: string): string {
  const dir = join(skillsSource(), name);
  mkdirSync(join(dir, "templates"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "core ${name}"\n---\n\nBody of ${name}.\n`,
  );
  writeFileSync(join(dir, "templates", "tpl.md"), `template for ${name}\n`);
  return dir;
}

/** Create a canonical core agent `<name>.md`. */
function stageCoreAgent(name: string): string {
  mkdirSync(agentsSource(), { recursive: true });
  const p = join(agentsSource(), `${name}.md`);
  writeFileSync(p, `# Agent ${name}\n`);
  return p;
}

/** Create the agents-dir aux manifest.yaml. */
function stageAgentsManifest(): string {
  mkdirSync(agentsSource(), { recursive: true });
  const p = join(agentsSource(), "manifest.yaml");
  writeFileSync(p, "agents: []\n");
  return p;
}

/**
 * Stage a personal SKILL block in the overlay (L-517 nested layout:
 * loadout/skills/<name>/<name>/SKILL.md). Returns the nested SKILL dir.
 */
function stagePersonalSkill(name: string): string {
  const nested = join(loadoutDir(), "skills", name, name);
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    join(nested, "SKILL.md"),
    `---\nname: ${name}\ndescription: "personal ${name}"\n---\n\nPersonal.\n`,
  );
  // Write/extend the overlay surfaces.skills[] block.
  const overlay = readOverlay();
  overlay.surfaces = overlay.surfaces ?? {};
  overlay.surfaces.skills = overlay.surfaces.skills ?? [];
  overlay.surfaces.skills.push({
    source: join(loadoutDir(), "skills", name),
    layer: "personal",
    targets: [{ type: "claude", method: "symlink", path: "~/.claude/skills" }],
  });
  writeOverlay(overlay);
  return nested;
}

/**
 * Stage a personal AGENT block in the overlay
 * (loadout/agents/<name>/harness.claude.md). Returns the harness path.
 */
function stagePersonalAgent(name: string): string {
  const dir = join(loadoutDir(), "agents", name);
  mkdirSync(dir, { recursive: true });
  const harness = join(dir, "harness.claude.md");
  writeFileSync(harness, `---\nname: ${name}\n---\n\nPersonal agent ${name}.\n`);
  const overlay = readOverlay();
  overlay.agents = overlay.agents ?? [];
  overlay.agents.push({
    name,
    layer: "personal",
    canonical: { dir },
    targets: [{ type: "claude", path: `~/.claude/agents/${name}.md` }],
  });
  writeOverlay(overlay);
  return harness;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readOverlay(): any {
  try {
    return JSON.parse(readFileSync(overlayPath(), "utf-8"));
  } catch {
    return { version: 1, agents: [], surfaces: {} };
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeOverlay(o: any): void {
  mkdirSync(loadoutDir(), { recursive: true });
  writeFileSync(overlayPath(), JSON.stringify(o, null, 2) + "\n");
}

/** Make `~/.claude/skills` a legacy whole-dir symlink → the core source. */
function legacySkillsSymlink(): void {
  mkdirSync(join(homeOverride, ".claude"), { recursive: true });
  symlinkSync(skillsSource(), claudeSkillsRoot());
}
/** Make `~/.claude/agents` a legacy whole-dir symlink → the core source. */
function legacyAgentsSymlink(): void {
  mkdirSync(join(homeOverride, ".claude"), { recursive: true });
  symlinkSync(agentsSource(), claudeAgentsRoot());
}

function skillsSurface(): SurfaceRoot {
  return { kind: "skills", root: claudeSkillsRoot(), source: skillsSource() };
}
function agentsSurface(): SurfaceRoot {
  return { kind: "agents", root: claudeAgentsRoot(), source: agentsSource() };
}

beforeEach(() => {
  tmpRoot = mkdtempSyncCompat();
  brainBackup = process.env.IGRIS_BRAIN_DIR;
  homeBackup = process.env.HOME;
  homeOverride = join(tmpRoot, "home");
  mkdirSync(homeOverride, { recursive: true });
  // Sandbox BOTH the brain (manifest reader) AND HOME (source/target/loadout).
  process.env.IGRIS_BRAIN_DIR = join(homeOverride, ".igris");
  process.env.HOME = homeOverride;
  mkdirSync(skillsSource(), { recursive: true });
  mkdirSync(agentsSource(), { recursive: true });
  // Stage the manifest under the (HOME-rooted) brain dir.
  stageManifestUnderBrain();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (brainBackup === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = brainBackup;
  process.env.HOME = homeBackup;
});

// The manifest reader resolves surfacesManifestPath() under brainDir() =
// IGRIS_BRAIN_DIR = ~/.igris. Stage it there.
function stageManifestUnderBrain(): void {
  const adapterDir = join(
    homeOverride,
    ".igris",
    "core",
    "scripts",
    "cli-adapters",
  );
  mkdirSync(adapterDir, { recursive: true });
  writeFileSync(
    join(adapterDir, "surfaces-manifest.json"),
    JSON.stringify(
      {
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
    ) + "\n",
  );
}

function mkdtempSyncCompat(): string {
  return mkdtempSync(join(tmpdir(), "igris-skills-migration-"));
}

describe("declaredSurfaceRoots", () => {
  it("resolves the manifest's skills root + synthesizes the agents root", () => {
    const roots = declaredSurfaceRoots();
    const skills = roots.find((r) => r.kind === "skills");
    const agents = roots.find((r) => r.kind === "agents");
    expect(skills).toBeDefined();
    expect(skills!.root).toBe(claudeSkillsRoot());
    expect(skills!.source).toBe(skillsSource());
    expect(agents).toBeDefined();
    expect(agents!.root).toBe(claudeAgentsRoot());
    expect(agents!.source).toBe(agentsSource());
  });

  it("falls back to ~/.claude/skills when the manifest is absent", () => {
    rmSync(
      join(
        homeOverride,
        ".igris",
        "core",
        "scripts",
        "cli-adapters",
        "surfaces-manifest.json",
      ),
    );
    const roots = declaredSurfaceRoots();
    const skills = roots.find((r) => r.kind === "skills");
    expect(skills!.root).toBe(claudeSkillsRoot());
  });
});

describe("classifySurfaceRoot — verdict on the ROOT (brain #629)", () => {
  it("migrate: root is a symlink → the canonical source", () => {
    stageCoreSkill("foo");
    legacySkillsSymlink();
    expect(classifySurfaceRoot(claudeSkillsRoot(), skillsSource())).toBe(
      "migrate",
    );
  });

  it("unexpected-symlink: root is a symlink to a NON-canonical target", () => {
    stageCoreSkill("foo");
    const other = join(tmpRoot, "elsewhere");
    mkdirSync(other, { recursive: true });
    mkdirSync(join(homeOverride, ".claude"), { recursive: true });
    symlinkSync(other, claudeSkillsRoot());
    expect(classifySurfaceRoot(claudeSkillsRoot(), skillsSource())).toBe(
      "unexpected-symlink",
    );
  });

  it("real-dir: root is already a real dir (per-surface model)", () => {
    mkdirSync(claudeSkillsRoot(), { recursive: true });
    expect(classifySurfaceRoot(claudeSkillsRoot(), skillsSource())).toBe(
      "real-dir",
    );
  });

  it("missing: root does not exist", () => {
    expect(classifySurfaceRoot(claudeSkillsRoot(), skillsSource())).toBe(
      "missing",
    );
  });
});

describe("enumeration — canonical source + personal overlay", () => {
  it("enumerateCanonicalSkills lists SKILL.md dirs, excludes stray symlinks", () => {
    stageCoreSkill("alpha");
    stageCoreSkill("beta");
    // A leaked projection symlink must be EXCLUDED (not a real core skill).
    symlinkSync(
      join(loadoutDir(), "skills", "x"),
      join(skillsSource(), "stray"),
    );
    expect(enumerateCanonicalSkills(skillsSource())).toEqual(["alpha", "beta"]);
  });

  it("enumerateCoreAgents lists .md files, excludes manifest.yaml + symlinks", () => {
    stageCoreAgent("architect");
    stageCoreAgent("forger");
    stageAgentsManifest();
    symlinkSync(
      join(loadoutDir(), "agents", "y", "harness.claude.md"),
      join(agentsSource(), "content-deck.md"),
    );
    expect(enumerateCoreAgents(agentsSource())).toEqual([
      "architect.md",
      "forger.md",
    ]);
  });

  it("enumeratePersonalSkills targets the L-517 nested SKILL dir", () => {
    stagePersonalSkill("content-pipeline");
    const items = enumeratePersonalSkills(claudeSkillsRoot(), overlayPath());
    expect(items.length).toBe(1);
    expect(items[0].linkName).toBe("content-pipeline");
    expect(items[0].target).toBe(
      join(loadoutDir(), "skills", "content-pipeline", "content-pipeline"),
    );
  });

  it("enumeratePersonalAgents targets harness.claude.md", () => {
    stagePersonalAgent("content-deck");
    const items = enumeratePersonalAgents(claudeAgentsRoot(), overlayPath());
    expect(items.length).toBe(1);
    expect(items[0].linkName).toBe("content-deck.md");
    expect(items[0].target).toBe(
      join(loadoutDir(), "agents", "content-deck", "harness.claude.md"),
    );
  });
});

describe("migrateSurfaceRoot — T1 skills migration", () => {
  it("T1: whole-dir symlink → REAL dir of per-skill symlinks; old symlink backed up", () => {
    stageCoreSkill("alpha");
    stageCoreSkill("beta");
    stageCoreSkill("gamma");
    legacySkillsSymlink();
    expect(lstatSync(claudeSkillsRoot()).isSymbolicLink()).toBe(true);

    const result = migrateSurfaceRoot(skillsSurface(), overlayPath());
    expect(result.outcome).toBe("migrated");
    expect(result.backupPath).toBeDefined();

    // Root is now a REAL dir.
    expect(lstatSync(claudeSkillsRoot()).isSymbolicLink()).toBe(false);
    expect(lstatSync(claudeSkillsRoot()).isDirectory()).toBe(true);

    // 3 per-skill symlinks → core source.
    for (const n of ["alpha", "beta", "gamma"]) {
      const link = join(claudeSkillsRoot(), n);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(skillsSource(), n)));
    }

    // Old root symlink backed up (records the old target).
    expect(lstatSync(result.backupPath!).isSymbolicLink()).toBe(true);
    expect(realpathSync(result.backupPath!)).toBe(realpathSync(skillsSource()));
  });
});

describe("migrateSurfaceRoot — T2 agents migration (parity)", () => {
  it("T2: whole-dir symlink → REAL dir of per-agent symlinks + manifest.yaml preserved", () => {
    stageCoreAgent("architect");
    stageCoreAgent("forger");
    stageAgentsManifest();
    legacyAgentsSymlink();

    const result = migrateSurfaceRoot(agentsSurface(), overlayPath());
    expect(result.outcome).toBe("migrated");

    expect(lstatSync(claudeAgentsRoot()).isSymbolicLink()).toBe(false);
    for (const n of ["architect.md", "forger.md"]) {
      const link = join(claudeAgentsRoot(), n);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(agentsSource(), n)));
    }
    // manifest.yaml is preserved as a symlink (aux file, not an agent).
    const manifest = join(claudeAgentsRoot(), "manifest.yaml");
    expect(lstatSync(manifest).isSymbolicLink()).toBe(true);
    expect(realpathSync(manifest)).toBe(
      realpathSync(join(agentsSource(), "manifest.yaml")),
    );
  });
});

describe("migrateSurfaceRoot — T3 no skill lost (before/after ⊇)", () => {
  it("T3: AFTER resolvable names ⊇ BEFORE, incl. personal overlay sibling skills", () => {
    stageCoreSkill("alpha");
    stageCoreSkill("beta");
    stagePersonalSkill("content-pipeline");
    stagePersonalSkill("oss-readme");
    legacySkillsSymlink();

    const result = migrateSurfaceRoot(skillsSurface(), overlayPath());
    expect(result.outcome).toBe("migrated");

    const beforeNames = new Set(result.before.map((b) => b.name));
    const afterNames = new Set(result.after.map((a) => a.name));
    // Core skills were visible BEFORE; all must survive.
    for (const n of beforeNames) expect(afterNames.has(n)).toBe(true);
    // The personal overlay skills are added (not in the core source BEFORE),
    // even though they share the same target root.
    expect(afterNames.has("content-pipeline")).toBe(true);
    expect(afterNames.has("oss-readme")).toBe(true);
    // Each AFTER entry resolves to a SKILL.md.
    for (const a of result.after) {
      const link = join(claudeSkillsRoot(), a.name);
      const direct = join(link, "SKILL.md");
      const nested = join(link, a.name, "SKILL.md");
      expect(existsSync(direct) || existsSync(nested)).toBe(true);
    }
  });
});

describe("stray source symlink — T4 cleaned / T5 report-only", () => {
  it("T4: a loadout-projection stray is unlinked after migration", () => {
    stageCoreSkill("alpha");
    stagePersonalSkill("content-pipeline");
    // Plant the leaked projection stray INSIDE the canonical source, pointing
    // into the loadout (the nested L-517 layout).
    symlinkSync(
      join(loadoutDir(), "skills", "content-pipeline", "content-pipeline"),
      join(skillsSource(), "content-pipeline"),
    );
    legacySkillsSymlink();

    // Migrate first so the per-item home exists.
    migrateSurfaceRoot(skillsSurface(), overlayPath());
    const stray = join(skillsSource(), "content-pipeline");
    expect(lstatSync(stray).isSymbolicLink()).toBe(true);

    const outcome = removeStraySourceSymlink(stray, claudeSkillsRoot());
    expect(outcome).toBe("removed");
    expect(existsSync(stray)).toBe(false);
    // The migrated per-item symlink in the real surface dir survives.
    expect(
      lstatSync(join(claudeSkillsRoot(), "content-pipeline")).isSymbolicLink(),
    ).toBe(true);
  });

  it("T5: a stray pointing OUTSIDE the loadout is NEVER removed (report-only)", () => {
    stageCoreSkill("alpha");
    const outside = join(tmpRoot, "outside-target");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(skillsSource(), "weird"));

    const strays = findStraySourceSymlinks(skillsSource());
    const weird = strays.find((s) => s.path.endsWith("weird"));
    expect(weird).toBeDefined();
    expect(weird!.isLoadoutProjection).toBe(false);

    const outcome = removeStraySourceSymlink(
      join(skillsSource(), "weird"),
      claudeSkillsRoot(),
    );
    expect(outcome).toBe("skipped-not-projection");
    expect(existsSync(join(skillsSource(), "weird"))).toBe(true);
  });

  it("removeStraySourceSymlink refuses until the migrated home exists", () => {
    stageCoreSkill("alpha");
    stagePersonalSkill("content-pipeline");
    symlinkSync(
      join(loadoutDir(), "skills", "content-pipeline", "content-pipeline"),
      join(skillsSource(), "content-pipeline"),
    );
    // NO migration yet → the migrated per-item home does not exist.
    const outcome = removeStraySourceSymlink(
      join(skillsSource(), "content-pipeline"),
      claudeSkillsRoot(),
    );
    expect(outcome).toBe("skipped-no-migrated-target");
    expect(existsSync(join(skillsSource(), "content-pipeline"))).toBe(true);
  });
});

describe("migrateSurfaceRoot — T6 idempotent", () => {
  it("T6: a 2nd migrate on a real dir is a no-op (no 2nd .bak)", () => {
    stageCoreSkill("alpha");
    legacySkillsSymlink();

    const first = migrateSurfaceRoot(skillsSurface(), overlayPath());
    expect(first.outcome).toBe("migrated");
    const baksAfterFirst = readdirSync(join(homeOverride, ".claude")).filter(
      (n) => n.includes("skills.bak-"),
    );
    expect(baksAfterFirst.length).toBe(1);

    // 2nd run: root is now a real dir → skipped, no new backup.
    const second = migrateSurfaceRoot(skillsSurface(), overlayPath());
    expect(second.outcome).toBe("skipped-not-migratable");
    const baksAfterSecond = readdirSync(join(homeOverride, ".claude")).filter(
      (n) => n.includes("skills.bak-"),
    );
    expect(baksAfterSecond.length).toBe(1);
  });
});

describe("migrateSurfaceRoot — T7 unexpected target refused", () => {
  it("T7: root symlink → non-canonical target → refuse + report, untouched", () => {
    stageCoreSkill("alpha");
    const other = join(tmpRoot, "not-the-source");
    mkdirSync(other, { recursive: true });
    mkdirSync(join(homeOverride, ".claude"), { recursive: true });
    symlinkSync(other, claudeSkillsRoot());

    const result = migrateSurfaceRoot(skillsSurface(), overlayPath());
    expect(result.outcome).toBe("refused-unexpected-target");
    // Root untouched: still a symlink → the unexpected target.
    expect(lstatSync(claudeSkillsRoot()).isSymbolicLink()).toBe(true);
    expect(realpathSync(claudeSkillsRoot())).toBe(realpathSync(other));
    // No backup created.
    const baks = readdirSync(join(homeOverride, ".claude")).filter((n) =>
      n.includes(".bak-"),
    );
    expect(baks).toEqual([]);
  });
});

describe("migrateSurfaceRoot — T8 containment (#515)", () => {
  it("T8: a PRE-EXISTING staging path symlinked OUTSIDE the parent → refuse, no write", () => {
    stageCoreSkill("alpha");
    legacySkillsSymlink();

    // Use a fixed timestamp so we can predict the staging dir name and plant an
    // escaping symlink there BEFORE the migrate call (the #515 pre-existing
    // escape guard). The staging path is `<root>.migrate-<stamp>`.
    const now = new Date("2026-06-08T12:00:00.000Z");
    const stamp = "20260608T120000Z";
    const stagingPath = join(homeOverride, ".claude", `skills.migrate-${stamp}`);
    const escapeTarget = join(tmpRoot, "escape-target");
    mkdirSync(escapeTarget, { recursive: true });
    // Plant a symlink at the staging path that resolves OUTSIDE ~/.claude.
    symlinkSync(escapeTarget, stagingPath);

    const result = migrateSurfaceRoot(skillsSurface(), overlayPath(), now);
    expect(result.outcome).toBe("refused-containment");
    // Root untouched (still the legacy symlink), no backup created, and nothing
    // was written into the escape target.
    expect(lstatSync(claudeSkillsRoot()).isSymbolicLink()).toBe(true);
    const baks = readdirSync(join(homeOverride, ".claude")).filter((n) =>
      n.includes("skills.bak-"),
    );
    expect(baks).toEqual([]);
    expect(readdirSync(escapeTarget)).toEqual([]);
  });

  it("T8b: per-item linkName containment is enforced within the staging dir", () => {
    // buildSurfaceInventory derives a skill linkName from basename(sourceDir),
    // which can never contain a separator — so the per-item guard is defensive.
    // Prove it holds by confirming a normal migration writes every per-item
    // symlink INSIDE the staging→root dir (never a sibling of the root).
    stageCoreSkill("alpha");
    stageCoreSkill("beta");
    legacySkillsSymlink();
    const result = migrateSurfaceRoot(skillsSurface(), overlayPath());
    expect(result.outcome).toBe("migrated");
    for (const a of result.after) {
      // Every materialized link lives directly under the surface root.
      expect(existsSync(join(claudeSkillsRoot(), a.name))).toBe(true);
    }
    // No per-item symlink leaked into ~/.claude (the root's parent).
    const claudeEntries = readdirSync(join(homeOverride, ".claude"));
    expect(claudeEntries).not.toContain("alpha");
    expect(claudeEntries).not.toContain("beta");
  });
});

describe("classifyMigration — T9 already real dir / T10 recurrence", () => {
  it("T9: already-real-dir surface roots produce NO migration entries", () => {
    stageCoreSkill("alpha");
    stageCoreAgent("architect");
    // Both roots are REAL dirs (per-surface model already in place).
    mkdirSync(claudeSkillsRoot(), { recursive: true });
    mkdirSync(claudeAgentsRoot(), { recursive: true });

    const report = classifyMigration();
    expect(report.toMigrate.length).toBe(0);
    expect(report.unexpected.length).toBe(0);
    expect(report.strays.length).toBe(0);
  });

  it("T10: a re-created whole-dir symlink is re-detected by classifyMigration", () => {
    stageCoreSkill("alpha");
    legacySkillsSymlink();

    // Detected before fix.
    expect(classifyMigration().toMigrate.some((s) => s.kind === "skills")).toBe(
      true,
    );

    // Migrate → real dir → no longer detected.
    migrateSurfaceRoot(skillsSurface(), overlayPath());
    expect(classifyMigration().toMigrate.some((s) => s.kind === "skills")).toBe(
      false,
    );

    // Simulate a recurrence: remove the real dir + re-create the legacy symlink.
    rmSync(claudeSkillsRoot(), { recursive: true, force: true });
    symlinkSync(skillsSource(), claudeSkillsRoot());
    expect(classifyMigration().toMigrate.some((s) => s.kind === "skills")).toBe(
      true,
    );
  });

  it("classifyMigration aggregates both surfaces + strays", () => {
    stageCoreSkill("alpha");
    stageCoreAgent("architect");
    stageAgentsManifest();
    stagePersonalSkill("content-pipeline");
    symlinkSync(
      join(loadoutDir(), "skills", "content-pipeline", "content-pipeline"),
      join(skillsSource(), "content-pipeline"),
    );
    legacySkillsSymlink();
    legacyAgentsSymlink();

    const report = classifyMigration();
    expect(report.toMigrate.map((s) => s.kind).sort()).toEqual([
      "agents",
      "skills",
    ]);
    const projectionStray = report.strays.find((s) => s.isLoadoutProjection);
    expect(projectionStray).toBeDefined();
    expect(projectionStray!.path).toBe(join(skillsSource(), "content-pipeline"));
  });

  it("win32 → empty report (no-op)", () => {
    stageCoreSkill("alpha");
    legacySkillsSymlink();
    const report = classifyMigration("win32");
    expect(report.surfaces).toEqual([]);
    expect(report.toMigrate).toEqual([]);
  });
});
