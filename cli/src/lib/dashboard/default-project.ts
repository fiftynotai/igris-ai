/**
 * FR-238 — which project the dashboard opens on.
 *
 * WHY THIS EXISTS: the shell used to select `projects[0]`, i.e. first
 * alphabetically. On a real brain that opened the lens on `AGY-DENY-TEST` — a
 * throwaway `/tmp` fixture with one brief — so a personal lens greeted the
 * operator with test garbage and a graph-scale card reading `NODES 1`.
 *
 * THE LADDER, in order:
 *   1. The project the CLI was INVOKED FROM. That is the natural default for a
 *      CLI verb: you run `igris dashboard` in a repo, you expect that repo.
 *      Resolved two ways, path first:
 *        a. cwd is inside a registered project's `path` (so it works from any
 *           subdirectory, not just the repo root). Deepest match wins, so a
 *           registered project nested inside another registered project beats
 *           its parent.
 *        b. `basename(cwd)` equals a slug exactly — the fallback for a row
 *           whose `path` is empty or stale, and the same shape `assess` uses
 *           (`basenameOfCwd`).
 *      Only ever yields a slug that is actually IN the registry, because it is
 *      resolved BY scanning registry rows.
 *   2. Most recently active, by `projects.last_session_at`.
 *   3. First alphabetically — the previous behaviour, kept as the final
 *      fallback so a non-empty list is never left with nothing selected.
 *
 * DELIBERATELY NOT IN THE LADDER: "skip to a project that has data". If the
 * project you are standing in is empty, that is information — an empty lens on
 * your own repo is a true statement about the brain, and silently swapping it
 * for a busier project would make the dashboard lie about where you are.
 *
 * PURE BY CONSTRUCTION: takes rows and a cwd, touches no filesystem and no
 * database, returns a slug. That is what keeps the selection logic out of
 * `routes.ts` (which must hold no SQL) and makes the ladder directly testable
 * rung by rung.
 */

import { basename, resolve, sep } from "node:path";
import type { DashboardProject } from "../../types.js";

/** Which rung of the ladder produced the answer. Surfaced for tests + debugging. */
export type DefaultProjectSource =
  | "cwd_path"
  | "cwd_basename"
  | "last_session"
  | "alphabetical"
  | "none";

export interface DefaultProjectResult {
  slug: string | null;
  source: DefaultProjectSource;
}

/**
 * True when `cwd` is at, or underneath, `projectPath`.
 *
 * Both sides are `resolve`d first so a trailing slash or a `.` segment cannot
 * defeat the comparison. The `sep` suffix on the prefix test is what stops
 * `/repo/igris-ai-old` from matching a project rooted at `/repo/igris-ai`.
 */
function cwdIsInside(cwd: string, projectPath: string): boolean {
  if (projectPath.length === 0) return false;
  const root = resolve(projectPath);
  return cwd === root || cwd.startsWith(root + sep);
}

/**
 * Resolve the slug the dashboard should select on first load.
 *
 * Returns `{slug: null, source: "none"}` only for an empty project list.
 */
export function resolveDefaultProject(
  projects: readonly DashboardProject[],
  cwd: string,
): DefaultProjectResult {
  if (projects.length === 0) return { slug: null, source: "none" };

  const here = resolve(cwd);

  // --- Rung 1a: cwd inside a registered project path, deepest match wins ----
  let deepest: DashboardProject | null = null;
  for (const p of projects) {
    if (!cwdIsInside(here, p.path)) continue;
    if (deepest === null || resolve(p.path).length > resolve(deepest.path).length) {
      deepest = p;
    }
  }
  if (deepest !== null) return { slug: deepest.slug, source: "cwd_path" };

  // --- Rung 1b: basename(cwd) is a registered slug --------------------------
  const base = basename(here);
  const byName = projects.find((p) => p.slug === base);
  if (byName !== undefined) return { slug: byName.slug, source: "cwd_basename" };

  // --- Rung 2: most recently active ----------------------------------------
  // `last_session_at` is `YYYY-MM-DD HH:MM:SS`, so a lexicographic max is a
  // chronological max. Empty strings (never-sessioned rows) sort below every
  // real timestamp and are skipped explicitly so they can never win.
  let mostRecent: DashboardProject | null = null;
  for (const p of projects) {
    if (p.last_session_at.length === 0) continue;
    if (mostRecent === null || p.last_session_at > mostRecent.last_session_at) {
      mostRecent = p;
    }
  }
  if (mostRecent !== null) return { slug: mostRecent.slug, source: "last_session" };

  // --- Rung 3: first alphabetically ----------------------------------------
  // `listProjects()` already returns rows in slug order, but sort defensively
  // rather than depending on a caller's ordering for correctness.
  const first = [...projects].sort((a, b) => (a.slug < b.slug ? -1 : 1))[0];
  return { slug: first.slug, source: "alphabetical" };
}
