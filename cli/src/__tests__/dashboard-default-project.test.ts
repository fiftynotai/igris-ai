/**
 * FR-238 — the default-project ladder.
 *
 * DISCRIMINATION IS THE POINT. Every case below is built so that the rungs
 * DISAGREE: the fixture always contains a project that a lower rung would pick,
 * so a test passing means the ladder chose correctly rather than that some
 * project happened to be selected. "A project is selected" is the vacuous shape
 * this brief has already been bitten by; asserting it here would be worthless
 * because the pre-fix code (`projects[0]`) would pass every one of these.
 *
 * The fixture is modelled on the real registry that produced the bug:
 * `AGY-DENY-TEST` sorts first alphabetically and is a throwaway /tmp fixture,
 * so it is the WRONG answer in every case except the explicit alphabetical
 * fallback — which makes it a natural canary.
 */

import { describe, expect, it } from "vitest";
import { join, sep } from "node:path";
import { resolveDefaultProject } from "../lib/dashboard/default-project.js";
import type { DashboardProject } from "../types.js";

function proj(
  slug: string,
  path: string,
  last_session_at = "",
): DashboardProject {
  return { slug, name: slug, path, status: "active", last_session_at };
}

/** Alphabetically first AND a /tmp throwaway — the row that caused the bug. */
const AGY = proj("AGY-DENY-TEST", "/tmp/agy-deny-test", "2026-01-01 00:00:00");
const IGRIS = proj(
  "igris-ai",
  "/Users/dev/StudioProjects/igris-ai",
  "2026-07-28 09:00:00",
);
const OTHER = proj("zz-other", "/Users/dev/other", "2026-07-27 09:00:00");

describe("rung 1a — the project the CLI was invoked from (by path)", () => {
  it("picks the cwd project OVER the alphabetically-first one", () => {
    const r = resolveDefaultProject([AGY, IGRIS, OTHER], IGRIS.path);
    // The discriminating assertion: alphabetical would say AGY-DENY-TEST.
    expect(r.slug).toBe("igris-ai");
    expect(r.source).toBe("cwd_path");
  });

  it("picks the cwd project OVER the most recently active one", () => {
    // Make the cwd project the STALEST, so `last_session` would pick another.
    const stale = proj("igris-ai", "/Users/dev/StudioProjects/igris-ai", "2020-01-01 00:00:00");
    const fresh = proj("zz-fresh", "/Users/dev/fresh", "2026-07-28 23:59:59");
    const r = resolveDefaultProject([AGY, stale, fresh], stale.path);
    expect(r.slug).toBe("igris-ai");
    expect(r.source).toBe("cwd_path");
  });

  it("resolves from a SUBDIRECTORY of the project, not just its root", () => {
    const deep = join(IGRIS.path, "cli", "src", "lib");
    const r = resolveDefaultProject([AGY, IGRIS, OTHER], deep);
    expect(r.slug).toBe("igris-ai");
    expect(r.source).toBe("cwd_path");
  });

  it("does NOT match a sibling whose path merely shares a prefix", () => {
    // `/Users/dev/other-old` must not match a project rooted at `/Users/dev/other`.
    //
    // Assert the SOURCE, not the slug. Rung 2 may legitimately go on to pick
    // `zz-other` anyway (it has the newest stamp), so asserting `slug !==
    // "zz-other"` would test the wrong thing — and did, on the first run.
    // The property under test is that rung 1a did not match.
    const r = resolveDefaultProject([AGY, OTHER], "/Users/dev/other-old");
    expect(r.source).not.toBe("cwd_path");
    expect(r.source).not.toBe("cwd_basename");
  });

  it("a NESTED registered project beats its registered parent (deepest wins)", () => {
    const parent = proj("monorepo", "/Users/dev/mono", "2026-07-01 00:00:00");
    const child = proj("sub-pkg", "/Users/dev/mono/packages/sub", "2026-07-01 00:00:00");
    const r = resolveDefaultProject([parent, child], join(child.path, "src"));
    expect(r.slug).toBe("sub-pkg");
    expect(r.source).toBe("cwd_path");
  });

  it("ignores rows with an empty path (a bare '' must never match at rung 1a)", () => {
    // An empty `path` resolves to the process cwd, which would make EVERY
    // directory "inside" it. Same lesson as the prefix case: assert the rung,
    // because rung 2 can still legitimately select this row on its timestamp.
    const pathless = proj("pathless", "", "2026-07-28 10:00:00");
    const r = resolveDefaultProject([pathless, IGRIS], "/somewhere/unrelated");
    expect(r.source).not.toBe("cwd_path");

    // And the sharper form: with no timestamps in play at all, a pathless row
    // must not be reachable by rung 1a from an unrelated cwd.
    const bare = proj("bare", "", "");
    const other = proj("zzz", "/tmp/zzz", "");
    const r2 = resolveDefaultProject([bare, other], "/somewhere/unrelated");
    expect(r2.source).toBe("alphabetical");
  });
});

describe("rung 1b — basename fallback when the path is stale or empty", () => {
  it("matches basename(cwd) against a slug when no path matches", () => {
    // The row's recorded path is wrong (the repo moved), but the directory
    // name still identifies it.
    const moved = proj("igris-ai", "/old/gone/igris-ai", "2020-01-01 00:00:00");
    const fresh = proj("zz-fresh", "/Users/dev/fresh", "2026-07-28 23:59:59");
    const r = resolveDefaultProject(
      [AGY, moved, fresh],
      "/Users/dev/relocated/igris-ai",
    );
    expect(r.slug).toBe("igris-ai");
    expect(r.source).toBe("cwd_basename");
    // Discriminating: both alphabetical (AGY) and last_session (zz-fresh) lose.
  });
});

describe("rung 2 — most recently active", () => {
  it("falls through to last_session_at when the cwd is unregistered", () => {
    const r = resolveDefaultProject([AGY, IGRIS, OTHER], "/completely/unrelated/dir");
    // igris-ai has the newest stamp; AGY is alphabetically first and must lose.
    expect(r.slug).toBe("igris-ai");
    expect(r.source).toBe("last_session");
  });

  it("never lets a never-sessioned row (empty stamp) win rung 2", () => {
    const never = proj("aaa-never", "/tmp/never", "");
    const seen = proj("zzz-seen", "/tmp/seen", "2026-07-28 09:00:00");
    const r = resolveDefaultProject([never, seen], "/unrelated");
    expect(r.slug).toBe("zzz-seen");
    expect(r.source).toBe("last_session");
  });
});

describe("rung 3 — alphabetical, the final fallback", () => {
  it("selects the alphabetically-first project when nothing else applies", () => {
    const a = proj("aaa", "/tmp/aaa", "");
    const b = proj("bbb", "/tmp/bbb", "");
    const r = resolveDefaultProject([b, a], "/unrelated");
    expect(r.slug).toBe("aaa");
    expect(r.source).toBe("alphabetical");
  });

  it("does not depend on the caller's ordering", () => {
    const a = proj("aaa", "/tmp/aaa", "");
    const b = proj("bbb", "/tmp/bbb", "");
    expect(resolveDefaultProject([a, b], "/x").slug).toBe("aaa");
    expect(resolveDefaultProject([b, a], "/x").slug).toBe("aaa");
  });
});

describe("edge cases", () => {
  it("an empty registry yields null, not a throw", () => {
    const r = resolveDefaultProject([], "/anywhere");
    expect(r.slug).toBeNull();
    expect(r.source).toBe("none");
  });

  it("an EMPTY cwd project is still chosen — emptiness is information", () => {
    // The operator's own repo having no briefs is a true fact about the brain.
    // Silently swapping to a busier project would make the lens lie about
    // where you are standing.
    const mine = proj("my-empty-repo", "/Users/dev/mine", "");
    const busy = proj("aaa-busy", "/tmp/busy", "2026-07-28 12:00:00");
    const r = resolveDefaultProject([busy, mine], mine.path);
    expect(r.slug).toBe("my-empty-repo");
    expect(r.source).toBe("cwd_path");
  });

  it("tolerates a trailing separator and '.' segments in cwd", () => {
    expect(
      resolveDefaultProject([AGY, IGRIS], IGRIS.path + sep).slug,
    ).toBe("igris-ai");
    expect(
      resolveDefaultProject([AGY, IGRIS], join(IGRIS.path, "cli", "..")).slug,
    ).toBe("igris-ai");
  });
});
