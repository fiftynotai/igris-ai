/**
 * Shared install-plan discovery (TD-117).
 *
 * Lifted from `cli/src/verbs/install.ts` where the same selection rules
 * were implemented twice — once in `applySymlinkLayer` (real-run symlink
 * creation) and once in `enumerateInstallPlan` (dry-run plan enumeration).
 * Two implementations of the same selection rules invite drift; one
 * implementation pre-empts that risk.
 *
 * The discovery layer is read-only: it walks `<brainRoot>/core/` and
 * returns the agent / skill entries that an install pipeline should
 * materialize into `<projectPath>/.claude/`. The materialization itself
 * (linkFile / linkDir for real run, dry.wouldWriteFile for dry run) lives
 * in the caller.
 *
 * FR-187: the rule discovery layer was removed when the universal rule
 * `core/rules/00-igris-universal.md` was retired (its baseline moved into
 * `core/os/standards.md`). Installs no longer materialize a `.claude/rules/`
 * symlink — there is no rule file to link.
 *
 * Sort stability: each helper returns entries sorted by basename so that
 * dry-run plan output and real-run iteration order are deterministic
 * across filesystems with non-stable readdirSync ordering.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AgentEntry {
  /** Absolute source path (under <brainRoot>/core/agents). */
  src: string;
  /** Basename of the source file (e.g. "architect.md"). */
  basename: string;
}

export interface SkillEntry {
  src: string;
  basename: string;
}

/**
 * Discover agent entries under `<brainRoot>/core/agents/`.
 *
 * Selection rules (mirror `applySymlinkLayer`):
 *   - any `.md` file
 *   - the literal `manifest.yaml`
 *
 * Returns `[]` if the agents directory is absent. Sorted by basename.
 */
export function discoverAgentEntries(brainRoot: string): AgentEntry[] {
  const dir = join(brainRoot, "core", "agents");
  if (!existsSync(dir)) return [];
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const out: AgentEntry[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      // Broken symlink or permission error — skip.
      continue;
    }
    if (!s.isFile()) continue;
    if (entry.endsWith(".md") || entry === "manifest.yaml") {
      out.push({ src: full, basename: entry });
    }
  }
  out.sort((a, b) => a.basename.localeCompare(b.basename));
  return out;
}

/**
 * Discover skill entries under `<brainRoot>/core/skills/`.
 *
 * Selection rules (mirror `applySymlinkLayer`):
 *   - any subdirectory (skills are directory-shaped: each contains
 *     `SKILL.md` plus optional resources)
 *
 * Returns `[]` if the skills directory is absent. Sorted by basename.
 * Files that happen to live directly under `skills/` are ignored.
 */
export function discoverSkillEntries(brainRoot: string): SkillEntry[] {
  const dir = join(brainRoot, "core", "skills");
  if (!existsSync(dir)) return [];
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const out: SkillEntry[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    out.push({ src: full, basename: entry });
  }
  out.sort((a, b) => a.basename.localeCompare(b.basename));
  return out;
}
