/**
 * TD-404 — the pull-side `projects.path` guard on `mergeRows`' INSERT branch.
 *
 * `mergeRows` keys `projects` on `slug` alone, so a locally-DELETED slug is
 * indistinguishable from a never-seen one: a cursor reset replays the remote's
 * row and INSERTs it back, next to the local row that already holds that
 * directory. These tests drive the REAL `mergePulledTables` over the REAL
 * `BOOT_SYNC_PULL_TABLES` config against a REAL tmp brain DB — no hand-built
 * config, no mock of the code under test (L-159 / TD-098) — plus one case
 * through `buildBootSyncDigest`, the default `/boot` path.
 *
 * The guard is the pull-side twin of TD-402's `findPathHolder`
 * (`brain-mcp-server/src/tools/projects.ts`) and resolves both sides with
 * `realpathSync`, so the symlink and non-existent-path cases below pin the
 * comparison rule rather than leaving it to prose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLoopback, mcpOkEnvelope, type CapturedCall } from "./loopback.js";
import type { BootSyncDigest } from "../types.js";
import type { PullMergeSummary } from "../lib/brain-db.js";

let tmpRoot: string;
let savedEnv: NodeJS.ProcessEnv;

const SLUG = "demo";
const REMOTE = "http://remote.invalid";

/** Verbatim from the brain's core schema (`brain-mcp-server/src/db.ts`). */
const PROJECTS_DDL = `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    tech_stack TEXT DEFAULT '',
    igris_version TEXT DEFAULT '4.0.0',
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'inactive')),
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_session_at TEXT,
    metadata TEXT DEFAULT '{}',
    archetype TEXT DEFAULT 'unclassified'
  );
`;

const SYNC_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT, remote_url TEXT NOT NULL,
    table_name TEXT NOT NULL, last_push_at TEXT, last_pull_at TEXT,
    UNIQUE(remote_url, table_name)
  );
`;

function dbFile(): string {
  return join(tmpRoot, "memory", "knowledge.db");
}

function seedSchema(): void {
  mkdirSync(join(tmpRoot, "memory"), { recursive: true });
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  db.exec(PROJECTS_DDL);
  db.exec(SYNC_STATE_DDL);
  db.close();
}

function withDb(fn: (db: Database.Database) => void): void {
  const db = new Database(dbFile());
  fn(db);
  db.close();
}

/** Insert a LOCAL projects row directly (the state the pull arrives into). */
function seedProject(
  slug: string,
  path: string,
  overrides: { name?: string; last_session_at?: string } = {},
): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO projects (slug, name, path, last_session_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      slug,
      overrides.name ?? slug,
      path,
      overrides.last_session_at ?? "2026-01-01T00:00:00.000Z",
    );
  });
}

/** An inbound `projects` row shaped like the VPS's `GET /sync/pull` body. */
function remoteProject(
  slug: string,
  path: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug,
    name: slug,
    path,
    tech_stack: "",
    archetype: "unclassified",
    igris_version: "7.0.0",
    status: "active",
    registered_at: "2026-01-01T00:00:00.000Z",
    last_session_at: "2026-08-18T00:00:00.000Z",
    metadata: "{}",
    ...overrides,
  };
}

function projectRows(): { slug: string; path: string; name: string }[] {
  let rows: { slug: string; path: string; name: string }[] = [];
  withDb((db) => {
    rows = db
      .prepare("SELECT slug, path, name FROM projects ORDER BY slug")
      .all() as { slug: string; path: string; name: string }[];
  });
  return rows;
}

/** Drive the REAL merge over the REAL BOOT_SYNC_PULL_TABLES config. */
async function merge(
  tables: Record<string, Record<string, unknown>[]>,
): Promise<PullMergeSummary> {
  const { mergePulledTables } = await import("../lib/brain-db.js");
  return mergePulledTables(REMOTE, tables);
}

/** A real directory inside the sandbox, returned realpath-resolved. */
function makeDir(name: string): string {
  const p = join(tmpRoot, name);
  mkdirSync(p, { recursive: true });
  return realpathSync(p);
}

function writeConfig(remoteUrl: string): void {
  writeFileSync(
    join(tmpRoot, "config.json"),
    JSON.stringify({ remote_brain: { url: remoteUrl, api_key: "k" } }, null, 2) + "\n",
  );
}

function makePullLoopback(
  tables: Record<string, Record<string, unknown>[]>,
): ReturnType<typeof makeLoopback> {
  return makeLoopback((call: CapturedCall) => {
    if (call.httpMethod === "GET" && (call.url ?? "").startsWith("/sync/pull")) {
      return { status: 200, body: JSON.stringify({ tables }) };
    }
    return { status: 200, body: mcpOkEnvelope() };
  });
}

async function listen(lb: ReturnType<typeof makeLoopback>): Promise<void> {
  await new Promise<void>((resolve) => lb.server.listen(0, "127.0.0.1", resolve));
}
async function close(lb: ReturnType<typeof makeLoopback>): Promise<void> {
  await new Promise<void>((resolve) => lb.server.close(() => resolve()));
}

async function bootSync(remoteUrl: string): Promise<BootSyncDigest> {
  writeConfig(remoteUrl);
  const { buildBootSyncDigest } = await import("../verbs/boot-sync.js");
  return buildBootSyncDigest(SLUG);
}

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "igris-cli-td404-")));
  savedEnv = { ...process.env };
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "GEMINI_CLI", "CODEX_SESSION", "OPENCODE", "ANTIGRAVITY"]) {
    delete process.env[k];
  }
  seedSchema();
});

afterEach(async () => {
  (await import("../lib/brain-db.js")).closeDb();
  vi.restoreAllMocks();
  vi.resetModules();
  process.env = savedEnv;
});

// ---------------------------------------------------------------------------
// AC-1 / AC-2 — the refusal, and that it does not abort the pull.
// ---------------------------------------------------------------------------

describe("TD-404 — a pulled projects row cannot take a directory another slug holds", () => {
  it("refuses the INSERT and leaves the local row sole holder of the directory", async () => {
    const dir = makeDir("eco");
    seedProject("fifty-eco-system", dir);

    const summary = await merge({
      projects: [remoteProject("fifty-flutter-kit", dir)],
    });

    // The row did NOT land: one row, still the local one.
    expect(projectRows()).toEqual([
      { slug: "fifty-eco-system", path: dir, name: "fifty-eco-system" },
    ]);

    const r = summary.perTable["projects"];
    expect(r.inserted).toBe(0);
    expect(r.failed).toBe(1);
    expect(summary.totalMerged).toBe(0);
    // The refusal is recorded per-row, keyed by the incoming syncKey, and NAMES
    // the slug that holds the directory — the operator's next question.
    expect(r.failures?.[0].key).toBe("fifty-flutter-kit");
    expect(r.failures?.[0].error).toContain("fifty-eco-system");
    expect(r.failures?.[0].error).toContain(dir);
  });

  it("still merges a GOOD row that arrives LATER in the same batch", async () => {
    const held = makeDir("eco");
    const free = makeDir("brand-new");
    seedProject("fifty-eco-system", held);

    const summary = await merge({
      projects: [
        remoteProject("fifty-flutter-kit", held), // refused
        remoteProject("brand-new", free), // must still land
      ],
    });

    // Position matters: the good row is AFTER the refused one, so a refusal
    // that aborted the loop (or the transaction) would lose it.
    expect(projectRows().map((r) => r.slug)).toEqual(["brand-new", "fifty-eco-system"]);

    const r = summary.perTable["projects"];
    expect(r.inserted).toBe(1);
    expect(r.failed).toBe(1);
    expect(summary.totalMerged).toBe(1);
  });

  it("refuses the SECOND of two incoming rows that share one FREE directory", async () => {
    // The incident shape: a cursor reset replays a whole page, so the directory
    // is claimed by a row inserted EARLIER IN THIS SAME BATCH rather than by a
    // pre-existing local row (the table starts empty here). This pins that the
    // holder query is re-run per row inside the transaction and sees the
    // in-flight INSERTs, rather than being snapshotted before the loop.
    const free = makeDir("shared");

    const summary = await merge({
      projects: [remoteProject("aaa", free), remoteProject("bbb", free)],
    });

    expect(projectRows()).toEqual([{ slug: "aaa", path: free, name: "aaa" }]);

    const r = summary.perTable["projects"];
    expect(r.inserted).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.failures?.[0].key).toBe("bbb");
    expect(r.failures?.[0].error).toContain("aaa");
  });

  it("does not poison a LATER table in the same pull transaction", async () => {
    const held = makeDir("eco");
    const free = makeDir("later");
    seedProject("fifty-eco-system", held);

    // `session_files` comes after `projects` in BOOT_SYNC_PULL_TABLES order,
    // but its local table is absent here, so use a second projects row plus the
    // cursor as the observable: a rolled-back transaction would advance neither.
    const summary = await merge({
      projects: [remoteProject("dup", held), remoteProject("fresh", free)],
    });
    expect(summary.perTable["projects"].failed).toBe(1);

    withDb((db) => {
      const cursor = db
        .prepare("SELECT last_pull_at FROM sync_state WHERE remote_url = ? AND table_name = 'projects'")
        .get(REMOTE) as { last_pull_at: string } | undefined;
      expect(cursor?.last_pull_at).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// AC-3 — the LWW update path is untouched.
// ---------------------------------------------------------------------------

describe("TD-404 — strategy 'lww' on a SAME-slug row is unchanged", () => {
  it("updates a same-slug row that keeps its own path", async () => {
    const dir = makeDir("demo");
    seedProject("demo", dir, { name: "old name", last_session_at: "2026-01-01T00:00:00.000Z" });

    const summary = await merge({
      projects: [remoteProject("demo", dir, { name: "new name" })],
    });

    const r = summary.perTable["projects"];
    expect(r.updated).toBe(1);
    expect(r.failed).toBe(0);
    expect(projectRows()).toEqual([{ slug: "demo", path: dir, name: "new name" }]);
  });

  it("skips a same-slug row that LOSES lww, without a refusal", async () => {
    const dir = makeDir("demo");
    seedProject("demo", dir, { name: "current", last_session_at: "2026-08-18T00:00:00.000Z" });

    const summary = await merge({
      projects: [
        remoteProject("demo", dir, { name: "stale", last_session_at: "2020-01-01T00:00:00.000Z" }),
      ],
    });

    const r = summary.perTable["projects"];
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(0);
    expect(projectRows()[0].name).toBe("current");
  });

  it("DISCLOSED RESIDUAL: a same-slug UPDATE may still move onto a held directory", async () => {
    // The guard is INSERT-branch-only, deliberately: TD-404 scopes it to the
    // branch that mints a NEW row for a directory that already has one. An
    // lww UPDATE that MOVES an existing slug onto a sibling's directory is not
    // refused here, and this test exists so that fact is measured, not assumed.
    // `igris doctor`'s `duplicate-path` class is what reports the resulting
    // state; the register/update writers are guarded by TD-402.
    const held = makeDir("eco");
    const own = makeDir("kit");
    seedProject("fifty-eco-system", held);
    seedProject("fifty-flutter-kit", own, { last_session_at: "2026-01-01T00:00:00.000Z" });

    const summary = await merge({
      projects: [remoteProject("fifty-flutter-kit", held)],
    });

    expect(summary.perTable["projects"].updated).toBe(1);
    expect(summary.perTable["projects"].failed).toBe(0);
    const paths = projectRows().map((r) => r.path);
    expect(paths).toEqual([held, held]);
  });
});

// ---------------------------------------------------------------------------
// AC-4 — the guard is silent on legitimate first-time projects.
// ---------------------------------------------------------------------------

describe("TD-404 — the guard does not fire without a collision", () => {
  it("inserts a first-time project into an empty table", async () => {
    const dir = makeDir("fresh");

    const summary = await merge({ projects: [remoteProject("fresh", dir)] });

    expect(summary.perTable["projects"].inserted).toBe(1);
    expect(summary.perTable["projects"].failed).toBe(0);
    expect(projectRows()).toEqual([{ slug: "fresh", path: dir, name: "fresh" }]);
  });

  it("inserts a first-time project alongside unrelated existing rows", async () => {
    seedProject("other-a", makeDir("a"));
    seedProject("other-b", makeDir("b"));
    const dir = makeDir("c");

    const summary = await merge({ projects: [remoteProject("fresh", dir)] });

    expect(summary.perTable["projects"].inserted).toBe(1);
    expect(summary.perTable["projects"].failed).toBe(0);
    expect(projectRows().map((r) => r.slug)).toEqual(["fresh", "other-a", "other-b"]);
  });

  it("reports an ABSENT local table as a per-table failure, not a path refusal", async () => {
    // `learnings` has no local table in this fixture, so the row dies at
    // `mergePulledTables`' `tableExists` preflight — before `mergeRows`, and so
    // before the guard is built at all. What this measures is therefore the
    // preflight's own verdict: an absent table is reported as absent, and the
    // pull says nothing about directories. It does NOT measure the guard's
    // table scope; the `pathHolderStmt` comment in `brain-db.ts` says why no
    // test can.
    const summary = await merge({ learnings: [{ project: "x", category: "c", title: "t" }] });
    expect(summary.perTable["learnings"].failures?.[0].error).toContain("absent");
    expect(summary.perTable["learnings"].failures?.[0].error).not.toContain("directory");
  });

  it("admits an empty-path row next to an empty-path local row", async () => {
    // An empty `path` names no directory, so two rows carrying one are not a
    // collision — the holder query filters them out. Accepted input class, and
    // pinned rather than asserted because this is what arms that filter.
    seedProject("empty-a", "");

    const summary = await merge({ projects: [remoteProject("empty-b", "")] });

    expect(summary.perTable["projects"].inserted).toBe(1);
    expect(summary.perTable["projects"].failed).toBe(0);
    expect(projectRows().map((r) => r.slug)).toEqual(["empty-a", "empty-b"]);
  });

  it("pins the premise: `projects` is the only pull table declaring both `slug` and `path`", async () => {
    // Derived from the REAL config, not quoted. This does not arm the guard's
    // `config.table === "projects"` term — deleting that term leaves this and
    // every other test here green — it arms the FACT that makes the term
    // redundant, so the day a second member declares both columns this reds and
    // the term becomes load-bearing.
    const { BOOT_SYNC_PULL_TABLES } = await import("../lib/brain-db.js");
    const both = BOOT_SYNC_PULL_TABLES.filter(
      (c) => c.columns.includes("slug") && c.columns.includes("path"),
    ).map((c) => c.table);
    expect(both).toEqual(["projects"]);
  });
});

// ---------------------------------------------------------------------------
// AC-5 — the comparison rule: realpath-resolved, raw-string fallback.
// ---------------------------------------------------------------------------

describe("TD-404 — path comparison resolves symlinks and falls back to the raw string", () => {
  it("refuses a symlink whose target the local row holds", () => {
    const dir = makeDir("eco");
    const link = join(tmpRoot, "eco-link");
    symlinkSync(dir, link);
    // Arm the fixture: the two strings differ, and only resolution equates them.
    expect(link).not.toBe(dir);
    expect(realpathSync(link)).toBe(dir);
    seedProject("fifty-eco-system", dir);

    return merge({ projects: [remoteProject("fifty-flutter-kit", link)] }).then((summary) => {
      expect(summary.perTable["projects"].failed).toBe(1);
      expect(projectRows().map((r) => r.slug)).toEqual(["fifty-eco-system"]);
    });
  });

  it("refuses the target when the LOCAL row is the one stored as a symlink", async () => {
    const dir = makeDir("eco");
    const link = join(tmpRoot, "eco-link");
    symlinkSync(dir, link);
    seedProject("fifty-eco-system", link);

    const summary = await merge({ projects: [remoteProject("fifty-flutter-kit", dir)] });

    expect(summary.perTable["projects"].failed).toBe(1);
    expect(projectRows().map((r) => r.slug)).toEqual(["fifty-eco-system"]);
  });

  it("compares by raw string when the path does not exist on THIS machine", async () => {
    // A pulled path routinely names another machine's disk, where realpathSync
    // throws. The fallback keeps such a row in the comparison rather than
    // dropping it out; arm it by proving the resolve really does throw.
    const ghost = "/Users/someone-else/StudioProjects/ghost";
    expect(() => realpathSync(ghost)).toThrow();
    seedProject("ghost-a", ghost);

    const summary = await merge({ projects: [remoteProject("ghost-b", ghost)] });

    expect(summary.perTable["projects"].failed).toBe(1);
    expect(projectRows().map((r) => r.slug)).toEqual(["ghost-a"]);
  });

  // This, not the case above, is what binds the FALLBACK: replacing
  // `catch { return p; }` with a throw leaves the collision case green (the row
  // is refused for the wrong reason) and, in this file, reds only this one.
  it("admits a different non-existent path", async () => {
    seedProject("ghost-a", "/Users/someone-else/StudioProjects/ghost");

    const summary = await merge({
      projects: [remoteProject("ghost-b", "/Users/someone-else/StudioProjects/other")],
    });

    expect(summary.perTable["projects"].inserted).toBe(1);
    expect(summary.perTable["projects"].failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The default `/boot` path, end to end.
// ---------------------------------------------------------------------------

describe("TD-404 — the refusal holds on the real `igris boot-sync` path", () => {
  it("refuses over a real GET /sync/pull and still reports a successful pull", async () => {
    const held = makeDir("eco");
    const free = makeDir("brand-new");
    seedProject("fifty-eco-system", held);

    const lb = makePullLoopback({
      projects: [remoteProject("fifty-flutter-kit", held), remoteProject("brand-new", free)],
    });
    await listen(lb);
    try {
      const d = await bootSync(`http://127.0.0.1:${lb.port()}`);

      expect(d.brain_pull.ok).toBe(true);
      expect(d.brain_pull.summary).toBe("1 projects");
      expect(projectRows().map((r) => r.slug)).toEqual(["brand-new", "fifty-eco-system"]);

      // DISCLOSED RESIDUAL: the digest carries no refusal channel. `failed` /
      // `failures` live on the merge result that `buildBootSyncDigest` consumes
      // and are not rendered — which is true of EVERY per-row merge failure
      // today, not something this guard introduced. Pinned so a future digest
      // field is a deliberate change rather than a surprise.
      expect(Object.keys(d.brain_pull).sort()).toEqual(["ok", "summary"]);
    } finally {
      await close(lb);
    }
  });
});
