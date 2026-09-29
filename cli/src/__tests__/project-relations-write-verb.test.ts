/**
 * FR-273 round B (D11) — the CLI WRITE verbs `igris project relate|unrelate`
 * and `igris project kinds add|alias|merge` (plan §4.2 X-series).
 *
 * The real brain DB is fenced (fenceHome); its relation schema comes from the
 * brain's OWN compiled `relations/schema.js` (resolved through the bridge).
 * Where a case needs to observe the call the verb makes (X1, X2, X8), the
 * bridge loaders are mocked; everywhere else the compiled action layer runs.
 * The end-to-end MCP-vs-CLI parity lives in `project-relations-write.bats`.
 *
 *   - X1 `relate a k b --detail package=p --detail ref=v2` maps to the exact
 *     `relateAction` args (both pairs kept);
 *   - X2 a malformed `--detail nokey` exits 2 and the action is never called;
 *   - X3 a missing positional exits 2 (relate, unrelate, kinds alias/merge/add);
 *   - X4 `ok:true` exits 0; a refusal exits 1 and prints `result.refused`;
 *   - X5 no brain DB exits 3 and NO DB file is created;
 *   - X6 tables absent exits 3 and `sqlite_master` is unchanged (create-never);
 *   - X7 the module unavailable exits 3 with the reason;
 *   - X8 the embeddings dispose runs BEFORE the write door closes the handle —
 *     also when the action throws;
 *   - X9 `kinds list` opens the READ-only door, never the write door;
 *   - X10 stdout is exactly one JSON line, with `replication: "next brain push"`;
 *   - X11 (F4) `withBrainWriteDoor` ITSELF refuses a brain without the tables and
 *     an absent brain before `fn` runs — no table and no file created — so its
 *     create-never guarantee holds for a caller that is not the action layer;
 *   - X12 (F6) `replication` is "next brain push" only when a row changed; it is
 *     null on a degraded digest, a refusal and an idempotent no-op.
 *
 * The helper is `runVerb`, never `run` (see vitest-home-fence's closure: a
 * `run` that reaches brainDir makes `\brun\s*\(` match every `stmt.run(`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fenceHome, type HomeFence } from "./home-fence.js";

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
  ALTER TABLE projects ADD COLUMN repo_url TEXT;
`;

let fence: HomeFence;

function dbFile(): string {
  return join(fence.brainDir, "memory", "knowledge.db");
}

async function relationsSql(): Promise<string> {
  const { resolveBundleModule } = await import("../lib/brain-bridge.js");
  const p = resolveBundleModule(join("engine", "components", "projects", "relations", "schema.js"));
  if (p === null) throw new Error("relations/schema.js is not built — run `npm run build` in cli/");
  return ((await import(pathToFileURL(p).href)) as { relationsMigrationV3: { sql: string } }).relationsMigrationV3.sql;
}

async function seedBrain(opts: { relations: boolean }): Promise<void> {
  mkdirSync(join(fence.brainDir, "memory"), { recursive: true });
  const sql = opts.relations ? await relationsSql() : "";
  const db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  db.exec(PROJECTS_DDL + sql);
  const reg = db.prepare("INSERT INTO projects (slug, name, path) VALUES (?, ?, ?)");
  for (const s of ["app-a", "pkg-b"]) {
    mkdirSync(join(fence.home, "repos", s), { recursive: true });
    reg.run(s, s, join(fence.home, "repos", s));
  }
  db.close();
}

function rows(sql: string): unknown[] {
  const db = new Database(dbFile(), { readonly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

interface VerbRun {
  code: number;
  lines: string[];
  digest: Record<string, unknown> | null;
  stderr: string;
}

async function runVerb(action: string, args: string[], opts: Record<string, unknown> = {}): Promise<VerbRun> {
  const { runProjectCommand } = await import("../verbs/project.js");
  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { out.push(String(c)); return true; });
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { err.push(String(c)); return true; });
  let code: number;
  try {
    code = await runProjectCommand({ action, args, ...opts });
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
  const lines = out.join("").split("\n").filter((l) => l !== "");
  return { code, lines, digest: lines.length === 1 ? (JSON.parse(lines[0]) as Record<string, unknown>) : null, stderr: err.join("") };
}

/** Mock the bridge's two loaders; returns the spies. */
function mockBridge(module: Record<string, unknown> | null, dispose?: () => Promise<void>): void {
  vi.doMock("../lib/brain-bridge.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/brain-bridge.js")>();
    return {
      ...actual,
      loadRelationsActions: async () => module,
      lastRelationsActionsFailure: () => "brain relations module not found: engine/components/projects/relations/actions.js",
      loadVendoredEmbeddings: async () => (dispose ? { disposeEmbeddingPipeline: dispose } : null),
    };
  });
}

beforeEach(() => {
  vi.resetModules();
  fence = fenceHome("igris-fr273-write-");
  fence.assertArmed();
  process.env.IGRIS_RELATIONS_SEMANTIC = "off";
});

afterEach(async () => {
  (await import("../lib/brain-db.js")).closeDb();
  (await import("../lib/brain-bridge.js")).resetRelationsActions();
  delete process.env.IGRIS_RELATIONS_SEMANTIC;
  fence.release();
  vi.restoreAllMocks();
  vi.doUnmock("../lib/brain-bridge.js");
  vi.resetModules();
});

describe("igris project relate / unrelate / kinds — the write verbs (FR-273 D11)", () => {
  it("X1: relate maps positionals and every --detail pair onto relateAction", async () => {
    await seedBrain({ relations: true });
    const relateAction = vi.fn(async () => ({ ok: true, action: "relate.declare", data: { changed: true } }));
    mockBridge({ relateAction, kindsAction: vi.fn(), lookupAction: vi.fn(), relationsBootDigest: vi.fn() }, async () => {});
    const r = await runVerb("relate", ["a", "k", "b"], { detail: ["package=p", "ref=v2"] });
    expect(r.code).toBe(0);
    expect(relateAction).toHaveBeenCalledTimes(1);
    expect((relateAction.mock.calls[0] as unknown[])[1]).toEqual({ action: "declare", from: "a", kind: "k", to: "b", detail: { package: "p", ref: "v2" } });
  });

  it("X2: a malformed --detail exits 2 and the action is never called", async () => {
    await seedBrain({ relations: true });
    const relateAction = vi.fn();
    mockBridge({ relateAction, kindsAction: vi.fn(), lookupAction: vi.fn(), relationsBootDigest: vi.fn() }, async () => {});
    for (const detail of [["nokey"], ["=v"], ["k="]]) {
      const r = await runVerb("relate", ["a", "k", "b"], { detail });
      expect(r.code, JSON.stringify(detail)).toBe(2);
      expect(r.lines).toEqual([]);
      expect(r.stderr).toMatch(/--detail/); // the usage error names the flag, not "unknown action"
    }
    expect(relateAction).not.toHaveBeenCalled();
  });

  it("X3: a missing positional exits 2 for every write verb", async () => {
    await seedBrain({ relations: true });
    for (const [action, args] of [
      ["relate", ["a", "k"]], ["unrelate", ["a"]], ["relate", ["a", "k", "b", "extra"]],
      ["kinds", ["add"]], ["kinds", ["alias", "x"]], ["kinds", ["merge", "x"]], ["kinds", ["rename", "x", "y"]],
    ] as const) {
      const r = await runVerb(action, [...args]);
      expect(r.code, `${action} ${args.join(" ")}`).toBe(2);
      expect(r.lines).toEqual([]);
      expect(r.stderr).not.toMatch(/unknown project action/);
    }
  });

  it("X4: ok exits 0 and writes the row; a refusal exits 1 and prints result.refused", async () => {
    await seedBrain({ relations: true });
    const ok = await runVerb("relate", ["app-a", "uses", "pkg-b"], { detail: ["ref=v1"] });
    expect(ok.code).toBe(0);
    expect(ok.digest).toMatchObject({ degraded: false, reason: null, action: "relate", ok: true, result: { ok: true, action: "relate.declare" } });
    expect(rows("SELECT from_slug, kind, to_slug, detail FROM project_relations")).toEqual([
      { from_slug: "app-a", kind: "uses_package", to_slug: "pkg-b", detail: '{"ref":"v1"}' },
    ]);
    const bad = await runVerb("relate", ["app-a", "uses_packages", "pkg-b"]);
    expect(bad.code).toBe(1);
    expect(bad.digest).toMatchObject({ ok: false, result: { ok: false, refused: { code: "unknown_kind" } } });
    const un = await runVerb("unrelate", ["app-a", "uses_package", "pkg-b"]);
    expect(un.code).toBe(0);
    expect(rows("SELECT removed_at IS NOT NULL AS gone FROM project_relations")).toEqual([{ gone: 1 }]);
    const add = await runVerb("kinds", ["add", "deploys_to"], {
      meaning: "A is deployed onto B's hosting infrastructure", kindDirection: "A → B",
      forwardLabel: "deploys to", inverseLabel: "hosts", example: "x deploys_to y", alias: ["hosted_on"],
    });
    expect(add.code).toBe(0);
    expect(add.digest!.result).toMatchObject({ ok: true, action: "kinds.add", semantic_check: "unavailable: disabled (IGRIS_RELATIONS_SEMANTIC=off)" });
    expect(rows("SELECT aliases FROM project_relation_kinds WHERE name = 'deploys_to'")).toEqual([{ aliases: "hosted_on" }]);
    expect((await runVerb("kinds", ["alias", "deploys_to", "runs_on"])).code).toBe(0);
    expect((await runVerb("kinds", ["alias", "deploys_to", "calls"])).code).toBe(1);
    expect((await runVerb("kinds", ["merge", "deploys_to", "calls_service"])).code).toBe(0);
    expect(rows("SELECT status, merged_into FROM project_relation_kinds WHERE name = 'deploys_to'")).toEqual([{ status: "merged", merged_into: "calls_service" }]);
    const missingFlag = await runVerb("kinds", ["add", "x_kind"]);
    expect(missingFlag.code).toBe(1); // in-band: the action layer names the missing argument
    expect(JSON.stringify(missingFlag.digest)).toMatch(/missing_argument/);
  });

  it("X5: no brain DB exits 3 and no DB file is created", async () => {
    const r = await runVerb("relate", ["a", "uses_package", "b"]);
    expect(r.code).toBe(3);
    expect(r.digest).toMatchObject({ degraded: true, reason: "brain db absent", ok: false, result: null, replication: null });
    expect(existsSync(dbFile())).toBe(false);
  });

  it("X6: tables absent exits 3 and sqlite_master is unchanged (create-never)", async () => {
    await seedBrain({ relations: false });
    const before = JSON.stringify(rows("SELECT type, name, sql FROM sqlite_master ORDER BY name"));
    for (const [action, args] of [["relate", ["app-a", "uses_package", "pkg-b"]], ["kinds", ["alias", "uses_package", "x_y"]]] as const) {
      const r = await runVerb(action, [...args]);
      expect(r.code).toBe(3);
      expect(r.digest).toMatchObject({ degraded: true });
      expect(String(r.digest!.reason)).toMatch(/project_relation/);
    }
    expect(JSON.stringify(rows("SELECT type, name, sql FROM sqlite_master ORDER BY name"))).toBe(before);
  });

  it("X7: the module unavailable exits 3 with the reason", async () => {
    await seedBrain({ relations: true });
    mockBridge(null, async () => {});
    const r = await runVerb("relate", ["app-a", "uses_package", "pkg-b"]);
    expect(r.code).toBe(3);
    expect(String(r.digest!.reason)).toMatch(/relations module unavailable: .*actions\.js/);
  });

  it("X8: dispose runs BEFORE the handle closes — also when the action throws", async () => {
    await seedBrain({ relations: true });
    for (const throws of [false, true]) {
      vi.resetModules();
      let captured: Database.Database | null = null;
      const openAtDispose: boolean[] = [];
      const dispose = vi.fn(async () => { openAtDispose.push(captured?.open === true); });
      const relateAction = vi.fn(async (db: Database.Database) => {
        captured = db;
        if (throws) throw new Error("boom");
        return { ok: true, action: "relate.declare", data: { changed: true } };
      });
      mockBridge({ relateAction, kindsAction: vi.fn(), lookupAction: vi.fn(), relationsBootDigest: vi.fn() }, dispose);
      const r = await runVerb("relate", ["app-a", "uses_package", "pkg-b"]);
      expect(dispose, `throws=${throws}`).toHaveBeenCalledTimes(1);
      expect(openAtDispose).toEqual([true]);
      expect((captured as Database.Database | null)?.open).toBe(false);
      expect(r.code).toBe(throws ? 3 : 0);
      vi.doUnmock("../lib/brain-bridge.js");
    }
  });

  it("X9: kinds list opens the read-only door, never the write door", async () => {
    await seedBrain({ relations: true });
    const kindsAction = vi.fn(async (db: Database.Database) => {
      expect(() => db.prepare("UPDATE project_relation_kinds SET example = example").run()).toThrow(/readonly|query_only|attempt to write/i);
      return { ok: true, action: "kinds.list", data: { kinds: [] } };
    });
    mockBridge({ relateAction: vi.fn(), kindsAction, lookupAction: vi.fn(), relationsBootDigest: vi.fn() }, async () => {});
    const r = await runVerb("kinds", ["list"]);
    expect(r.code).toBe(0);
    expect(kindsAction).toHaveBeenCalledTimes(1);
  });

  it("X10: stdout is exactly one JSON line, replication 'next brain push' on writes", async () => {
    await seedBrain({ relations: true });
    const r = await runVerb("relate", ["app-a", "supersedes", "pkg-b"]);
    expect(r.lines).toHaveLength(1);
    expect(r.digest).toMatchObject({ replication: "next brain push" });
    expect(Object.keys(r.digest!).sort()).toEqual(["action", "degraded", "ok", "reason", "replication", "result"]);
  });

  it("X11 (F4): the write door itself refuses a brain without the tables, and an absent brain, before fn runs", async () => {
    const { withBrainWriteDoor, BrainDbAbsentError, BrainTableMissingError } = await import("../lib/brain-db.js");
    const fn = vi.fn(() => "ran");
    await expect(withBrainWriteDoor(["project_relation_kinds", "project_relations"], fn)).rejects.toBeInstanceOf(BrainDbAbsentError);
    expect(existsSync(dbFile())).toBe(false);
    await seedBrain({ relations: false });
    const before = JSON.stringify(rows("SELECT type, name, sql FROM sqlite_master ORDER BY name"));
    const close = vi.fn();
    await expect(withBrainWriteDoor(["project_relation_kinds", "project_relations"], fn, { beforeClose: close })).rejects.toBeInstanceOf(BrainTableMissingError);
    expect(fn).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rows("SELECT type, name, sql FROM sqlite_master ORDER BY name"))).toBe(before);
  });

  it("X12 (F6): replication is 'next brain push' only when a row changed — null when degraded, refused or a no-op", async () => {
    const absent = await runVerb("relate", ["app-a", "supersedes", "pkg-b"]);
    expect(absent.code).toBe(3);
    expect(absent.digest!.replication).toBeNull();
    await seedBrain({ relations: true });
    const written = await runVerb("relate", ["app-a", "supersedes", "pkg-b"]);
    expect(written.digest).toMatchObject({ ok: true, replication: "next brain push" });
    const noop = await runVerb("relate", ["app-a", "supersedes", "pkg-b"]);
    expect(noop.digest).toMatchObject({ ok: true, replication: null });
    const refused = await runVerb("relate", ["app-a", "supersedes", "ghost"]);
    expect(refused.digest).toMatchObject({ ok: false, replication: null });
    expect(refused.code).toBe(1);
  });
});
