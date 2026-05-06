/**
 * doctor tests — Phase 6.
 *
 * Drift classification: 8 fixture registries, one per drift class. Each
 * asserts the expected `DriftRow.driftClass` value. --fix and --remove-orphans
 * exercised via runDoctor returning the right exit code.
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

let tmpRoot: string;
const projectDirs: string[] = [];

const CANONICAL_HOOKS = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: "$HOME/.igris/core/hooks/shared/session_start.sh" }] },
    ],
    SessionEnd: [
      { hooks: [{ type: "command", command: "$HOME/.igris/core/hooks/shared/session_end.sh" }] },
    ],
    PreCompact: [
      { hooks: [{ type: "command", command: "$HOME/.igris/core/hooks/shared/pre_compact.sh" }] },
    ],
    PostCompact: [
      { hooks: [{ type: "command", command: "$HOME/.igris/core/hooks/shared/post_compact.sh" }] },
    ],
    PreToolUse: [
      {
        matcher: "Write|Edit",
        hooks: [{ type: "command", command: "$HOME/.igris/core/hooks/shared/pre_tool_use.sh" }],
      },
    ],
    PostToolUse: [
      {
        matcher: "Write|Edit",
        hooks: [
          { type: "command", command: "$HOME/.igris/core/hooks/shared/post_tool_use.sh", timeout: 20 },
        ],
      },
    ],
  },
};

function stageBrain(): void {
  const hooksDir = join(tmpRoot, "core", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    join(hooksDir, "canonical-settings.json"),
    JSON.stringify(CANONICAL_HOOKS, null, 2) + "\n",
  );
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
}

function stageProject(name = "proj"): string {
  const dir = mkdtempSync(join(tmpdir(), `igris-cli-doctor-${name}-`));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  projectDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-doctor-brain-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  stageBrain();
  const ch = await import("../lib/canonical-hooks.js");
  ch.clearCache();
  const reg = await import("../lib/registry.js");
  reg.closeDb();
});

afterEach(async () => {
  const reg = await import("../lib/registry.js");
  reg.closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
  for (const d of projectDirs) rmSync(d, { recursive: true, force: true });
  projectDirs.length = 0;
  delete process.env.IGRIS_BRAIN_DIR;
});

describe("doctor — drift classification (read-only)", () => {
  it("clean: vanilla install → driftClass=clean", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");

    const proj = stageProject("clean");
    const slug = require("node:path").basename(proj);
    await runInstall({ path: proj, slug, installHooks: true, skipSymlinkLayer: true });
    const drift = classifyDrift(reg.listProjects());
    expect(drift.length).toBe(1);
    expect(drift[0].driftClass).toBe("clean");
  });

  it("path-missing: registry row -> deleted dir", async () => {
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    reg.upsertProject({
      slug: "ghost",
      name: "ghost",
      path: "/path/does/not/exist/12345",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift.length).toBe(1);
    expect(drift[0].driftClass).toBe("path-missing");
  });

  it("not-installed: path exists but .claude/ missing", async () => {
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const dir = mkdtempSync(join(tmpdir(), "igris-cli-doctor-bare-"));
    projectDirs.push(dir);
    reg.upsertProject({
      slug: "bare",
      name: "bare",
      path: dir,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift[0].driftClass).toBe("not-installed");
  });

  it("hooks-missing: settings.json present but no Igris SessionEnd", async () => {
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const proj = stageProject("hooksmissing");
    writeFileSync(
      join(proj, ".claude", "settings.json"),
      JSON.stringify({ includeGitInstructions: false }) + "\n",
    );
    reg.upsertProject({
      slug: require("node:path").basename(proj),
      name: "x",
      path: proj,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift[0].driftClass).toBe("hooks-missing");
  });

  it("hooks-stale: settings.json has Igris hooks at a different command path", async () => {
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const proj = stageProject("hooksstale");
    writeFileSync(
      join(proj, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: "$HOME/.igris/core/hooks/old/session_end.sh",
                },
              ],
            },
          ],
        },
      }) + "\n",
    );
    reg.upsertProject({
      slug: require("node:path").basename(proj),
      name: "x",
      path: proj,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift[0].driftClass).toBe("hooks-stale");
  });

  it("slug-basename-mismatch: row.slug != basename(row.path)", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const proj = stageProject("real");
    await runInstall({
      path: proj,
      slug: "totally-different-slug",
      installHooks: true,
      skipSymlinkLayer: true,
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift[0].driftClass).toBe("slug-basename-mismatch");
  });

  it("duplicate-path: multiple slugs share realpath", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const proj = stageProject("dup");
    await runInstall({ path: proj, slug: "slug-one", installHooks: true, skipSymlinkLayer: true });
    await runInstall({ path: proj, slug: "slug-two", installHooks: true, skipSymlinkLayer: true });
    await runInstall({
      path: proj,
      slug: "slug-three",
      installHooks: true,
      skipSymlinkLayer: true,
    });
    const drift = classifyDrift(reg.listProjects());
    // All three should be flagged as duplicate-path (precedence above slug-mismatch).
    const dupCount = drift.filter((r) => r.driftClass === "duplicate-path").length;
    expect(dupCount).toBe(3);
  });

  it("symlink-target: row.path is a symlink", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const real = stageProject("realtarget");
    const linkBase = mkdtempSync(join(tmpdir(), "igris-cli-doctor-linkbase-"));
    projectDirs.push(linkBase);
    const link = join(linkBase, "linked-proj");
    symlinkSync(real, link);
    // Install registers `real` as canonical, then we add a separate row for the symlink path.
    await runInstall({ path: real, slug: "real-target", installHooks: true, skipSymlinkLayer: true });
    // Simulate someone registering the symlinked path under a different slug.
    reg.upsertProject({
      slug: "via-symlink",
      name: "via-symlink",
      path: link,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    // The symlink path resolves to `real`, so this row counts as duplicate-path
    // (precedence: duplicate-path > symlink-target). That's expected behavior:
    // in practice symlink-target only fires when the symlinked path does NOT
    // also have another row pointing at the same realpath. Test the standalone
    // symlink case below.
    const symlinkRow = drift.find((d) => d.slug === "via-symlink");
    expect(symlinkRow).toBeDefined();
    expect(symlinkRow!.driftClass).toBe("duplicate-path");
  });

  it("symlink-target standalone: lone symlink row → driftClass=symlink-target", async () => {
    const { classifyDrift } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const real = mkdtempSync(join(tmpdir(), "igris-cli-doctor-realonly-"));
    mkdirSync(join(real, ".claude"), { recursive: true });
    writeFileSync(
      join(real, ".claude", "settings.json"),
      JSON.stringify(CANONICAL_HOOKS) + "\n",
    );
    projectDirs.push(real);
    const linkBase = mkdtempSync(join(tmpdir(), "igris-cli-doctor-linkbase2-"));
    projectDirs.push(linkBase);
    const link = join(linkBase, "lone-link");
    symlinkSync(real, link);
    const slug = require("node:path").basename(link);
    reg.upsertProject({
      slug,
      name: slug,
      path: link,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const drift = classifyDrift(reg.listProjects());
    expect(drift.length).toBe(1);
    expect(drift[0].driftClass).toBe("symlink-target");
  });
});

describe("doctor — runDoctor exit codes", () => {
  it("exits 0 on clean registry", async () => {
    const { runInstall } = await import("../verbs/install.js");
    const { runDoctor } = await import("../verbs/doctor.js");
    const proj = stageProject("clean2");
    await runInstall({
      path: proj,
      slug: require("node:path").basename(proj),
      installHooks: true,
      skipSymlinkLayer: true,
    });
    const code = await runDoctor({ fix: false, removeOrphans: false, yes: false });
    expect(code).toBe(0);
  });

  it("exits 1 with drift when settings.json missing hooks block (TD-100 silent-failure)", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const proj = stageProject("td100");
    writeFileSync(
      join(proj, ".claude", "settings.json"),
      JSON.stringify({ includeGitInstructions: false }) + "\n",
    );
    reg.upsertProject({
      slug: "td100-victim",
      name: "td100-victim",
      path: proj,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const code = await runDoctor({ fix: false, removeOrphans: false, yes: false });
    expect(code).toBe(1);
  });

  it("--fix repairs hooks-missing", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    const ifs = await import("../lib/installed-features.js");
    const proj = stageProject("fixme");
    writeFileSync(
      join(proj, ".claude", "settings.json"),
      JSON.stringify({ includeGitInstructions: false }) + "\n",
    );
    reg.upsertProject({
      slug: "fixme",
      name: "fixme",
      path: proj,
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const code = await runDoctor({ fix: true, removeOrphans: false, yes: false });
    expect(code).toBe(0);
    // After --fix, settings.json should have the canonical SessionEnd command.
    const settings = JSON.parse(
      require("node:fs").readFileSync(
        join(proj, ".claude", "settings.json"),
        "utf-8",
      ),
    ) as { hooks: Record<string, unknown[]> };
    const sessionEnd = settings.hooks.SessionEnd as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(sessionEnd[0].hooks[0].command).toBe(
      "$HOME/.igris/core/hooks/shared/session_end.sh",
    );
    expect(ifs.readInstalledFeatures("fixme")).not.toBeNull();
  });

  it("--remove-orphans --yes deletes path-missing rows", async () => {
    const { runDoctor } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    reg.upsertProject({
      slug: "ghost1",
      name: "ghost1",
      path: "/no/such/dir/abc",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    reg.upsertProject({
      slug: "ghost2",
      name: "ghost2",
      path: "/no/such/dir/def",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const code = await runDoctor({ fix: false, removeOrphans: true, yes: true });
    expect(code).toBe(0);
    expect(reg.listProjects().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TD-111: --remove-orphans interactive prompt (`[y/N/a/all]`).
//
// The prompt label was previously `[y/N/a/Y/A]`, but the input handler
// always lowercased the answer — `Y`/`A` were never reachable as distinct
// shortcuts. These tests pin the relabeled prompt and exercise the four
// real branches (y/n/a/all) using a synthetic Readable stream injected
// into `confirmAndRemoveOrphans`. No `process.stdin` monkey-patching, no
// vi.mock — real registry, real DB, real readline.
// ---------------------------------------------------------------------------
describe("doctor — --remove-orphans interactive prompt (TD-111)", () => {
  // Helper: build a queue-backed prompt function. Each call dequeues the
  // next answer; running out throws (test-bug indicator). This bypasses
  // readline entirely — the seam in confirmAndRemoveOrphans accepts a
  // PromptFn directly so we never have to fight Node's per-line listener
  // race or the readline 'close' event.
  function makePrompt(
    answers: string[],
  ): (question: string) => Promise<string> {
    const queue = [...answers];
    return async (_question: string): Promise<string> => {
      if (queue.length === 0) {
        throw new Error(
          "test bug: prompt called more times than answers were queued",
        );
      }
      return queue.shift() as string;
    };
  }

  async function seedOrphans(slugs: string[]): Promise<void> {
    // Each orphan is a registry row whose path doesn't exist on disk —
    // the path-missing classifier picks them up as orphans. We don't need
    // classifyDrift here; confirmAndRemoveOrphans takes a DriftRow[]
    // directly so the test seeds the rows AND constructs the matching
    // DriftRow shape inline. Uses dynamic ESM import (project is type:
    // module — CommonJS require() is unavailable).
    const reg = await import("../lib/registry.js");
    for (const slug of slugs) {
      reg.upsertProject({
        slug,
        name: slug,
        path: `/no/such/dir/${slug}`,
        tech_stack: "",
        igris_version: "7.0.0",
      });
    }
  }

  function buildOrphanRows(slugs: string[]): Array<{
    slug: string;
    path: string;
    driftClass: "path-missing";
    recommendedFix: string;
  }> {
    return slugs.map((slug) => ({
      slug,
      path: `/no/such/dir/${slug}`,
      driftClass: "path-missing" as const,
      recommendedFix: "delete row",
    }));
  }

  it("answer 'y' deletes one orphan and re-prompts for the next", async () => {
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedOrphans(["orphan-1", "orphan-2"]);
    expect(reg.listProjects().length).toBe(2);

    // 'y' for first, 'n' for second — net delete = 1.
    const removed = await confirmAndRemoveOrphans(
      buildOrphanRows(["orphan-1", "orphan-2"]),
      false,
      makePrompt(["y", "n"]),
    );
    expect(removed).toBe(1);
    const remaining = reg.listProjects().map((r) => r.slug);
    expect(remaining).toEqual(["orphan-2"]);
  });

  it("answer 'n' keeps the row and re-prompts for the next orphan", async () => {
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedOrphans(["orphan-keep"]);
    const removed = await confirmAndRemoveOrphans(
      buildOrphanRows(["orphan-keep"]),
      false,
      makePrompt(["n"]),
    );
    expect(removed).toBe(0);
    expect(reg.listProjects().length).toBe(1);
  });

  it("answer 'a' aborts the flow without deleting any further rows", async () => {
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedOrphans(["orphan-x", "orphan-y", "orphan-z"]);
    // 'a' on the first prompt — handler must break BEFORE touching y/z.
    // We seed exactly one answer; the queue would throw if the loop
    // didn't break (defensive: catches a regression that walks past the
    // 'a' branch).
    const removed = await confirmAndRemoveOrphans(
      buildOrphanRows(["orphan-x", "orphan-y", "orphan-z"]),
      false,
      makePrompt(["a"]),
    );
    expect(removed).toBe(0);
    expect(reg.listProjects().length).toBe(3);
  });

  it("answer 'all' deletes every remaining orphan in one pass without re-prompting", async () => {
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedOrphans(["bulk-1", "bulk-2", "bulk-3"]);
    // Single 'all' answer — yesAll latches and the remaining orphans are
    // deleted in the body of the loop without further reads. Queue has
    // exactly one entry; if yesAll didn't latch, the second loop iter
    // would throw "more times than answers queued".
    const removed = await confirmAndRemoveOrphans(
      buildOrphanRows(["bulk-1", "bulk-2", "bulk-3"]),
      false,
      makePrompt(["all"]),
    );
    expect(removed).toBe(3);
    expect(reg.listProjects().length).toBe(0);
  });

  it("answer 'Y' (uppercase) lowercases to 'y' — single delete, then re-prompt (regression anchor)", async () => {
    // Pre-TD-111 the prompt advertised 'Y' as a shortcut; the handler
    // already accepted it (via toLowerCase) but treated it identically to
    // 'y'. This test pins that behavior so the relabel doesn't accidentally
    // change semantics for users who memorized the old shortcut.
    const { confirmAndRemoveOrphans } = await import("../verbs/doctor.js");
    const reg = await import("../lib/registry.js");
    await seedOrphans(["upper-1", "upper-2"]);
    const removed = await confirmAndRemoveOrphans(
      buildOrphanRows(["upper-1", "upper-2"]),
      false,
      makePrompt(["Y", "n"]),
    );
    expect(removed).toBe(1);
    const remaining = reg.listProjects().map((r) => r.slug);
    expect(remaining).toEqual(["upper-2"]);
  });
});
