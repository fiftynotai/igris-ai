/**
 * `igris assess` — the MINIMAL system-assessment digest (FR-195 M2, decision D-A).
 *
 * Faithfully reproduces SKILL.md §4's local reads, scoped to the D-A MINIMAL
 * surface set:
 *   - briefs    ← `handleBriefDashboard` summary-only counts (briefs.ts:205-234),
 *                 via `briefStatusSummary` — NOT the full brief table.
 *   - blockers  ← `session/BLOCKERS.md` (the active-blockers list).
 *   - git       ← `git status` (branch / dirty / ahead) via the exec helper.
 *   - active_instances ← the live-instance count (`listInstances`).
 *   - goals_upcoming   ← active goals with a deadline within 14 days
 *                        (`handleGoalList` upcoming_days; goals/index.ts:160).
 *
 * DELIBERATELY OMITS (D-A): the task queue (autonomous off, stale auto-tasks),
 * perception pending (subconscious disabled → noise), and cross-project recall
 * (the "welcome back"). Those re-introduce the ceremony noise the teardown
 * flagged; opt them back in only on an explicit operator decision.
 *
 * Channel: LOCAL — better-sqlite3 reads + a `session/BLOCKERS.md` file read +
 * `git status` shell-outs. No network. Degrades (empty briefs/goals) when the
 * brain DB is absent; exit 0 (never blocks session start).
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { detectCapabilities } from "../lib/detect.js";
import { briefStatusSummary, listInstances, upcomingGoals } from "../lib/brain-db.js";
import { classifyInstanceLiveness } from "../lib/process-liveness.js";
import { projectBlockersPath } from "../lib/paths.js";
import { basenameOfCwd } from "../lib/sync/util.js";
import type {
  AssessDigest,
  AssessBriefs,
  AssessGit,
  AssessGoal,
} from "../types.js";

/** The /awaken goals horizon (goals/index.ts:160 — "Use 14 in /awaken"). */
const GOALS_UPCOMING_DAYS = 14;

export interface AssessOptions {
  /** Project slug override; default basename(cwd) per the sync convention. */
  project?: string;
  /** Working dir for the git probes; default process.cwd(). */
  cwd?: string;
  /** Emit JSON to stdout (default ON for the awaken path). */
  json?: boolean;
}

/**
 * Run a git command and return trimmed stdout, or null on any failure.
 *
 * NEVER throws — git absence / detached HEAD / no-upstream are all expected and
 * map to a null/0 field, not an error (assess must not block awaken). Uses
 * `execFileSync` directly (not lib/exec's `execFile`, which throws on non-zero)
 * with stderr suppressed so a missing upstream stays quiet.
 */
function git(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    return typeof out === "string" ? out.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Read the git working-tree snapshot: branch, dirty flag, commits-ahead.
 *   - branch: `git rev-parse --abbrev-ref HEAD` (null on detached HEAD / no git).
 *   - dirty:  `git status --porcelain` having ANY output.
 *   - ahead:  `git rev-list --count @{u}..HEAD` (0 when no upstream / unavailable).
 */
function readGit(cwd: string): AssessGit {
  const branchRaw = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  // "HEAD" means detached — report null branch.
  const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;

  const porcelain = git(cwd, ["status", "--porcelain"]);
  const dirty = porcelain !== null && porcelain.length > 0;

  const aheadRaw = git(cwd, ["rev-list", "--count", "@{u}..HEAD"]);
  const ahead = aheadRaw !== null ? Number.parseInt(aheadRaw, 10) || 0 : 0;

  return { branch, dirty, ahead };
}

/**
 * Read active blockers from `session/BLOCKERS.md`.
 *
 * The blockers file is a markdown bullet list (the awaken skill §4 reads it for
 * the active-blockers line). We surface each non-empty bullet (`- `, `* `) as a
 * blocker string; a missing file → an empty list (no blockers). Heading lines
 * and blank lines are skipped. This is a display field, not a parser contract —
 * a tolerant read is correct.
 */
function readBlockers(slug: string): string[] {
  const p = projectBlockersPath(slug);
  if (!existsSync(p)) return [];
  const text = readFileSync(p, "utf-8");
  const blockers: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const m = line.match(/^[-*]\s+(.+)$/);
    if (m && m[1].trim().length > 0) {
      blockers.push(m[1].trim());
    }
  }
  return blockers;
}

/**
 * Build the assess digest. `degraded` short-circuits the DB reads (empty briefs
 * + goals + zero instances) but STILL reads BLOCKERS.md + git, which do not
 * depend on the brain DB.
 */
export function buildAssessDigest(slug: string, cwd: string): AssessDigest {
  const caps = detectCapabilities();

  const blockers = readBlockers(slug);
  const gitSnapshot = readGit(cwd);

  if (!caps.brain_db) {
    return {
      degraded: true,
      briefs: { total: 0, by_status: {}, by_priority: {} },
      blockers,
      git: gitSnapshot,
      active_instances: 0,
      goals_upcoming: [],
    };
  }

  const briefs: AssessBriefs = briefStatusSummary(slug);
  const activeInstances = listInstances({
    project: slug,
    status: "all",
    includeStale: true,
  }).filter((row) => {
    const liveness = classifyInstanceLiveness(row);
    return liveness.status !== "dead" && liveness.status !== "dead_pid_reused";
  }).length;
  const goalsUpcoming: AssessGoal[] = upcomingGoals(slug, GOALS_UPCOMING_DAYS);

  return {
    degraded: false,
    briefs,
    blockers,
    git: gitSnapshot,
    active_instances: activeInstances,
    goals_upcoming: goalsUpcoming,
  };
}

/**
 * Run the assess verb. Always exit 0 (an assessment never blocks session
 * start); the digest's `degraded` flag tells the skill whether the DB-backed
 * surfaces are present.
 */
export function runAssess(opts: AssessOptions): number {
  const slug = opts.project ?? basenameOfCwd();
  const cwd = opts.cwd ?? process.cwd();
  const json = opts.json !== false;

  const digest = buildAssessDigest(slug, cwd);
  if (json) process.stdout.write(JSON.stringify(digest) + "\n");
  return 0;
}
