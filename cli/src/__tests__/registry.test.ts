/**
 * Registry tests — Phase 4.
 *
 * Real `better-sqlite3` against a sandboxed brain DB (IGRIS_BRAIN_DIR set to
 * a tmp dir). No mocks of the module under test; only `paths` is sandboxed
 * via env override (the supported boundary for tests).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-cli-registry-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  // Force module reload to pick up the new env var on each test.
  await reloadModules();
});

afterEach(() => {
  // Close any open DB before nuking the tmpdir.
  void getRegistryModule().then((m) => m.closeDb());
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
});

async function reloadModules(): Promise<void> {
  // Dynamic import w/ cache-bust: vitest re-evaluates the module.
  // A simpler approach: the registry module reads paths via brainDbPath() per
  // call, but caches the open DB handle keyed by path. Since each test gets a
  // fresh tmpRoot, the handle naturally rotates. We just need to call closeDb
  // between tests (done in afterEach).
  await Promise.resolve();
}

async function getRegistryModule(): Promise<typeof import("../lib/registry.js")> {
  return await import("../lib/registry.js");
}

describe("registry — better-sqlite3 direct (D-4)", () => {
  it("listProjects returns [] on empty DB", async () => {
    const reg = await getRegistryModule();
    expect(reg.listProjects()).toEqual([]);
  });

  it("upsertProject inserts a new row", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "demo",
      name: "demo",
      path: "/tmp/demo",
      tech_stack: "typescript/javascript",
      igris_version: "7.0.0",
    });
    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe("demo");
    expect(rows[0].path).toBe("/tmp/demo");
    expect(rows[0].tech_stack).toBe("typescript/javascript");
    expect(rows[0].igris_version).toBe("7.0.0");
  });

  it("upsertProject updates path on conflict (idempotence)", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "demo",
      name: "demo",
      path: "/tmp/demo-old",
      tech_stack: "go",
      igris_version: "7.0.0",
    });
    reg.upsertProject({
      slug: "demo",
      name: "demo",
      path: "/tmp/demo-new",
      tech_stack: "go",
      igris_version: "7.0.1",
    });
    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].path).toBe("/tmp/demo-new");
    expect(rows[0].igris_version).toBe("7.0.1");
  });

  it("explicit slug differs from basename — both become rows", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "fifty-dev",
      name: "fifty-dev",
      path: "/tmp/igris-test-fifty_dev",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    reg.upsertProject({
      slug: "fifty_dev",
      name: "fifty_dev",
      path: "/tmp/igris-test-fifty_dev",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const rows = reg.listProjects();
    expect(rows.length).toBe(2);
    const slugs = rows.map((r) => r.slug).sort();
    expect(slugs).toEqual(["fifty-dev", "fifty_dev"]);
    // Both point at the same path — this is the duplicate-path drift class.
    expect(rows[0].path).toBe("/tmp/igris-test-fifty_dev");
    expect(rows[1].path).toBe("/tmp/igris-test-fifty_dev");
  });

  it("deleteProjectRow removes only the named row", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "alpha",
      name: "alpha",
      path: "/tmp/a",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    reg.upsertProject({
      slug: "beta",
      name: "beta",
      path: "/tmp/b",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const outcome = reg.deleteProjectRow("alpha");
    expect(outcome).toEqual({ slug: "alpha", ok: true, error: null });
    const rows = reg.listProjects();
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe("beta");
  });

  // -------------------------------------------------------------------
  // BR-084: deleteProjectRow REPORTS a blocked delete, it does not throw.
  //
  // Two tables FK `projects(slug)` — `sessions` (db.ts:290) and `brief_status`
  // (db.ts:307), in that line order — so the reason is derived from the
  // live schema rather than assuming briefs are the only dependent.
  // -------------------------------------------------------------------
  async function attachDependent(
    table: "brief_status" | "sessions",
    slug: string,
  ): Promise<void> {
    const reg = await getRegistryModule();
    reg.closeDb(); // release the cached handle before opening a second one
    const { brainDbPath } = await import("../lib/paths.js");
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(brainDbPath());
    if (table === "brief_status") {
      db.exec(
        `CREATE TABLE IF NOT EXISTS brief_status (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           project TEXT NOT NULL,
           brief_id TEXT NOT NULL,
           title TEXT NOT NULL,
           status TEXT NOT NULL,
           FOREIGN KEY (project) REFERENCES projects(slug)
         );`,
      );
      db.prepare(
        "INSERT INTO brief_status (project, brief_id, title, status) VALUES (?, ?, ?, ?)",
      ).run(slug, "BR-084", "fixture brief", "Open");
    } else {
      db.exec(
        `CREATE TABLE IF NOT EXISTS sessions (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           project TEXT NOT NULL,
           started_at TEXT,
           FOREIGN KEY (project) REFERENCES projects(slug)
         );`,
      );
      db.prepare("INSERT INTO sessions (project, started_at) VALUES (?, ?)").run(
        slug,
        "2026-08-03T00:00:00Z",
      );
    }
    // Arm: the FK must actually bite on this handle shape.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  }

  it("deleteProjectRow reports a brief-blocked delete instead of throwing (BR-084)", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "briefed",
      name: "briefed",
      path: "/tmp/briefed",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    await attachDependent("brief_status", "briefed");

    const outcome = reg.deleteProjectRow("briefed");
    expect(outcome.ok).toBe(false);
    expect(outcome.slug).toBe("briefed");
    expect(outcome.error).toContain("1 brief_status row(s)");
    // The row is still there — refusing is the safe direction.
    expect(reg.listProjects().map((r) => r.slug)).toEqual(["briefed"]);
  });

  it("deleteProjectRow names the ACTUAL blocking table, not 'briefs' by assumption (BR-084)", async () => {
    // 0 briefs, 1 session. A hand-written "still referenced by N brief(s)"
    // message would report `0` here — a false statement of a true failure.
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "sessioned",
      name: "sessioned",
      path: "/tmp/sessioned",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    await attachDependent("sessions", "sessioned");

    const outcome = reg.deleteProjectRow("sessioned");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("1 sessions row(s)");
    expect(outcome.error).not.toContain("brief_status");
    expect(outcome.error).not.toContain("0 ");
  });

  it("listProjects returns rows in slug order", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "zebra",
      name: "zebra",
      path: "/tmp/z",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    reg.upsertProject({
      slug: "alpha",
      name: "alpha",
      path: "/tmp/a",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    reg.upsertProject({
      slug: "mike",
      name: "mike",
      path: "/tmp/m",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    const rows = reg.listProjects();
    expect(rows.map((r) => r.slug)).toEqual(["alpha", "mike", "zebra"]);
  });
});

// ---------------------------------------------------------------------------
// TD-319 — TWO DOORS, and each still does its own job
//
// The brief's third acceptance criterion is "CLI write paths are unaffected —
// verified, not assumed", and the temptation it names is real: the cheapest way
// to stop `/api/projects` writing would have been to flip `getDb()` to
// `{readonly:true}`, which passes every read test in this file and breaks
// `igris register` and `igris init` silently — `ensureDbOpen` calls
// `listProjects()` PURELY for the `CREATE TABLE` side effect and discards the
// rows, so a reader that stopped creating would produce no error there at all.
//
// So both doors are pinned, in the same reading, on the same brain: the write
// door still creates the table and sets WAL; the read door does NEITHER and
// still returns the SAME rows. Either half alone is satisfiable by a mistake.
// ---------------------------------------------------------------------------

describe("TD-319: listProjects (write door) vs listProjectsReadonly (read door)", () => {
  const dbPath = (): string => join(tmpRoot, "memory", "knowledge.db");

  // Return type INFERRED on purpose: `better-sqlite3` is an `export =` module,
  // so a hand-written annotation for its default binding is the thing that
  // breaks under `esModuleInterop` rather than the code it describes.
  const sqlite = async () => (await import("better-sqlite3")).default;

  /** Read `journal_mode` without becoming a writer ourselves. */
  async function journalMode(): Promise<string> {
    const Database = await sqlite();
    const db = new Database(dbPath(), { readonly: true });
    try {
      return String(db.pragma("journal_mode", { simple: true }));
    } finally {
      db.close();
    }
  }

  async function tables(): Promise<string[]> {
    const Database = await sqlite();
    const db = new Database(dbPath(), { readonly: true });
    try {
      return (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((t) => t.name);
    } finally {
      db.close();
    }
  }

  it("the READ door creates nothing — not the file, not the table", async () => {
    const reg = await getRegistryModule();
    // A brand-new sandbox: there is no brain database at all.
    expect(existsSync(dbPath())).toBe(false);

    expect(reg.listProjectsReadonly()).toEqual([]);
    expect(
      existsSync(dbPath()),
      "a read materialised a brain database",
    ).toBe(false);

    // Now a brain that exists but predates the `projects` table, in SQLite's
    // default journal mode.
    const Database = await sqlite();
    mkdirSync(join(tmpRoot, "memory"), { recursive: true });
    const seed = new Database(dbPath());
    seed.pragma("journal_mode = delete");
    seed.exec("CREATE TABLE unrelated (a INT)");
    seed.close();

    expect(reg.listProjectsReadonly()).toEqual([]);
    expect(await tables(), "a read ran DDL").toEqual(["unrelated"]);
    expect(await journalMode(), "a read flipped the journal mode").toBe("delete");
    expect(existsSync(`${dbPath()}-wal`)).toBe(false);
  });

  it("SELF-NEGATIVE-CONTROL — the WRITE door on the SAME brain does all three", async () => {
    // Same sandbox shape, same call arguments, same empty result — the ONLY
    // variable is which door. Without this the test above is also what a
    // `listProjectsReadonly` that never ran would produce, and it is the half
    // that proves `igris register` / `igris init` still have what they need.
    const reg = await getRegistryModule();
    const Database = await sqlite();
    mkdirSync(join(tmpRoot, "memory"), { recursive: true });
    const seed = new Database(dbPath());
    seed.pragma("journal_mode = delete");
    seed.exec("CREATE TABLE unrelated (a INT)");
    seed.close();

    expect(reg.listProjects()).toEqual([]);
    reg.closeDb();

    expect(await tables(), "the write door stopped CREATEing `projects`").toEqual(
      ["projects", "unrelated"],
    );
    expect(await journalMode()).toBe("wal");
  });

  it("both doors return the SAME rows for the same brain", async () => {
    const reg = await getRegistryModule();
    for (const slug of ["zebra", "alpha", "mike"]) {
      reg.upsertProject({
        slug,
        name: slug,
        path: `/tmp/${slug}`,
        tech_stack: "typescript/javascript",
        igris_version: "7.0.0",
      });
    }
    const written = reg.listProjects();
    reg.closeDb();

    const read = reg.listProjectsReadonly();
    // Deep equality over the WHOLE row, not just the slugs: the two doors run
    // one shared statement, and a divergence in the COALESCE projection is
    // exactly what a hand-copied second SELECT would introduce.
    expect(read).toEqual(written);
    expect(read.map((r) => r.slug)).toEqual(["alpha", "mike", "zebra"]);
    expect(read[0].tech_stack).toBe("typescript/javascript");
  });

  it("`igris register`'s write survives on a brain the read door just touched", async () => {
    // The ordering that would break if the read door left a lock, a stale
    // cached handle, or a `query_only` connection behind for the writer to
    // inherit. `closeDb()` is deliberately NOT called between them.
    const reg = await getRegistryModule();
    expect(reg.listProjectsReadonly()).toEqual([]);
    reg.upsertProject({
      slug: "after-read",
      name: "after-read",
      path: "/tmp/after-read",
      tech_stack: "",
      igris_version: "7.0.0",
    });
    expect(reg.listProjectsReadonly().map((r) => r.slug)).toEqual([
      "after-read",
    ]);
    expect(reg.listProjects().map((r) => r.slug)).toEqual(["after-read"]);
  });
});

// ---------------------------------------------------------------------------
// TD-310 / FR-265 — what an orphan owns, what the re-point writer keeps, and
// the `repo_url` column the shared projection reads when (and only when) the
// brain has it.
// ---------------------------------------------------------------------------

describe("TD-310 / FR-265: ownership, the re-point writer, and the repo_url projection", () => {
  const dbPath = (): string => join(tmpRoot, "memory", "knowledge.db");
  const sqlite = async () => (await import("better-sqlite3")).default;

  /**
   * Run `sql` through a SEPARATE short-lived handle after releasing the
   * registry's own (never two live RW connections to one file).
   */
  async function withSeedHandle(sql: string): Promise<void> {
    const reg = await getRegistryModule();
    reg.listProjects(); // materialise the brain + `projects` through the write door
    reg.closeDb();
    const Database = await sqlite();
    const db = new Database(dbPath());
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  }

  it("R1a: an ABSENT knowledge table counts 0 — an absent table holds zero rows", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({ slug: "lone", name: "lone", path: "/tmp/lone", tech_stack: "", igris_version: "7.0.0" });
    expect(reg.projectOwnership("lone")).toEqual({ briefs: 0, learnings: 0, errors: 0, sessions: 0 });
    expect(reg.ownsData(reg.projectOwnership("lone"))).toBe(false);
  });

  it("R1b: counts come from brief_status / learnings / errors / sessions, per slug", async () => {
    await withSeedHandle(`
      CREATE TABLE brief_status (id INTEGER PRIMARY KEY, project TEXT NOT NULL);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY, project TEXT NOT NULL);
      CREATE TABLE errors (id INTEGER PRIMARY KEY, project TEXT NOT NULL);
      CREATE TABLE sessions (id INTEGER PRIMARY KEY, project TEXT NOT NULL);
      INSERT INTO brief_status (project) VALUES ('owner'), ('other');
      INSERT INTO learnings (project) VALUES ('owner'), ('owner'), ('other');
      INSERT INTO errors (project) VALUES ('owner');
      INSERT INTO sessions (project) VALUES ('owner'), ('owner'), ('owner');
    `);
    const reg = await getRegistryModule();
    expect(reg.projectOwnership("owner")).toEqual({ briefs: 1, learnings: 2, errors: 1, sessions: 3 });
    expect(reg.projectOwnership("nobody")).toEqual({ briefs: 0, learnings: 0, errors: 0, sessions: 0 });
    expect(reg.ownsData(reg.projectOwnership("owner"))).toBe(true);
    expect(reg.ownsData(reg.projectOwnership("nobody"))).toBe(false);
  });

  it("R1c: a table that EXISTS but cannot be counted is UNKNOWN (null) — and unknown is treated as owning", async () => {
    // `learnings` without a `project` column: the COUNT query throws.
    await withSeedHandle("CREATE TABLE learnings (id INTEGER PRIMARY KEY, title TEXT);");
    const reg = await getRegistryModule();
    const o = reg.projectOwnership("anything");
    expect(o.learnings).toBeNull();
    expect(o.briefs).toBe(0);
    // Never "nothing references it" on a count this query did not establish.
    expect(reg.ownsData(o)).toBe(true);
  });

  it("R2: the re-point writer keeps a curated name and tech_stack, still moves path/igris_version, and fills an EMPTY tech_stack", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({
      slug: "curated",
      name: "Curated Name",
      path: "/tmp/curated-old",
      tech_stack: "dart,flutter",
      igris_version: "7.0.0",
    });
    // What `igris register-project <new-path> --slug curated` passes.
    reg.upsertProject({
      slug: "curated",
      name: "curated",
      path: "/tmp/curated-new",
      tech_stack: "",
      igris_version: "7.3.2",
    });
    let row = reg.listProjects().find((r) => r.slug === "curated")!;
    expect(row.name).toBe("Curated Name");
    expect(row.tech_stack).toBe("dart,flutter");
    expect(row.path).toBe("/tmp/curated-new");
    expect(row.igris_version).toBe("7.3.2");

    reg.upsertProject({ slug: "bare", name: "bare", path: "/tmp/bare", tech_stack: "", igris_version: "7.0.0" });
    reg.upsertProject({ slug: "bare", name: "bare", path: "/tmp/bare", tech_stack: "go", igris_version: "7.0.0" });
    row = reg.listProjects().find((r) => r.slug === "bare")!;
    expect(row.tech_stack).toBe("go");
  });

  it("R3a: repo_url is projected when the column exists and NULL when it does not — identically through BOTH doors", async () => {
    const reg = await getRegistryModule();
    for (const slug of ["with-url", "no-url"]) {
      reg.upsertProject({ slug, name: slug, path: `/tmp/${slug}`, tech_stack: "", igris_version: "7.0.0" });
    }
    // Before the brain's projects:1 migration: no column, NULL for every row.
    expect(reg.listProjects().map((r) => r.repo_url)).toEqual([null, null]);
    reg.closeDb();
    expect(reg.listProjectsReadonly().map((r) => r.repo_url)).toEqual([null, null]);

    await withSeedHandle(
      "ALTER TABLE projects ADD COLUMN repo_url TEXT; UPDATE projects SET repo_url = 'https://example.invalid/o/r.git' WHERE slug = 'with-url';",
    );
    const written = reg.listProjects();
    expect(written.map((r) => [r.slug, r.repo_url])).toEqual([
      ["no-url", null],
      ["with-url", "https://example.invalid/o/r.git"],
    ]);
    reg.closeDb();
    expect(reg.listProjectsReadonly()).toEqual(written);
  });

  it("R3b: the shared projection has NO WHERE clause (FR-238 / FR-265 AC7) — with a self-negative control", async () => {
    const src = readFileSync(join(__dirname, "..", "lib", "registry.ts"), "utf-8");
    const body = (text: string): string | null => {
      const m = /function projectsSelect\([\s\S]*?\n}\n/.exec(text);
      return m === null ? null : m[0];
    };
    const projection = body(src);
    expect(projection, "projectsSelect() not found in registry.ts").not.toBeNull();
    expect(projection).toContain("FROM projects");
    expect(projection).not.toMatch(/\bWHERE\b/i);
    // Self-negative: the same extractor over a planted WHERE does see it.
    const planted = body(src.replace("FROM projects", "FROM projects WHERE status = 'active'"));
    expect(planted).toMatch(/\bWHERE\b/);
  });

  it("R3c: the read door lists a path-missing row and a repo_url row alike (FR-265 AC7)", async () => {
    const reg = await getRegistryModule();
    reg.upsertProject({ slug: "gone", name: "gone", path: "/no/such/dir/gone", tech_stack: "", igris_version: "7.0.0" });
    reg.upsertProject({ slug: "reclaimed", name: "reclaimed", path: "/no/such/dir/reclaimed", tech_stack: "", igris_version: "7.0.0" });
    await withSeedHandle(
      "ALTER TABLE projects ADD COLUMN repo_url TEXT; UPDATE projects SET repo_url = 'https://example.invalid/o/r.git' WHERE slug = 'reclaimed';",
    );
    expect(reg.listProjectsReadonly().map((r) => r.slug)).toEqual(["gone", "reclaimed"]);
  });

  it("R4: danglingKnowledge names knowledge whose project row is gone, and nothing else", async () => {
    const reg = await getRegistryModule();
    expect(reg.danglingKnowledge()).toEqual([]); // tables absent → nothing to report
    reg.upsertProject({ slug: "kept", name: "kept", path: "/tmp/kept", tech_stack: "", igris_version: "7.0.0" });
    await withSeedHandle(`
      CREATE TABLE brief_status (id INTEGER PRIMARY KEY, project TEXT NOT NULL);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY, project TEXT NOT NULL);
      INSERT INTO brief_status (project) VALUES ('kept'), ('gone-b'), ('gone-b');
      INSERT INTO learnings (project) VALUES ('kept'), ('gone-l'), ('gone-b'), ('');
    `);
    expect(reg.danglingKnowledge()).toEqual([
      { project: "gone-b", briefs: 2, learnings: 1 },
      { project: "gone-l", briefs: 0, learnings: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// BR-084 — the guard claim, MECHANISED rather than asserted
// ---------------------------------------------------------------------------

describe("BR-084: deleteProjectRow has exactly one production call site", () => {
  // WHY THIS TEST EXISTS. `confirmAndRemoveOrphans` routes its four decision
  // branches through one local `attempt()` closure, and an earlier version of
  // that comment claimed "a fifth call site cannot reintroduce the unguarded
  // path". That claim was FALSE: `attempt` is a closure, it constrains nothing
  // outside its own function, and BR-084 made `deleteProjectRow` NON-THROWING
  // — so a caller that drops the returned outcome produces zero tsc errors, no
  // lint and no must-use warning. Pre-BR-084 such a caller crashed loudly;
  // post-BR-084 it silently no-ops, AND (because the exit code is derived from
  // the sweep report rather than a re-read) it would flip the verb back to
  // exit 0.
  //
  // So the safety moved OUT of the type system, and the honest options were to
  // mechanise the claim or delete it. This is the mechanism, following the
  // FR-247 / FR-240 precedent in this repo: a claim of the form "there is only
  // one X" is pinned by a scan, not by a comment.
  const SRC_ROOT = join(__dirname, "..");

  function productionSources(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "__tests__" || e.name === "node_modules") continue;
        productionSources(p, acc);
      } else if (e.name.endsWith(".ts")) {
        acc.push(p);
      }
    }
    return acc;
  }

  const callSites = (): string[] => {
    const out: string[] = [];
    for (const f of productionSources(SRC_ROOT)) {
      const src = readFileSync(f, "utf-8");
      // The definition itself is `export function deleteProjectRow(`, so match
      // a CALL: the identifier not preceded by `function `.
      for (const m of src.matchAll(/(?<!function\s)\bdeleteProjectRow\s*\(/g)) {
        // FILE only, deliberately no line number. An earlier version of this
        // pinned `doctor.ts:1249` and went red the moment a comment was added
        // above it — which is TD-334's whole finding (a line-number citation
        // goes stale on any edit) reproduced inside the test written to stop
        // an unrelated claim going stale. What this test asserts is "how many
        // call sites and where", and a line number is not part of that.
        out.push(f.slice(SRC_ROOT.length + 1));
      }
    }
    return out;
  };

  it("exactly one production call site, and it is inside the guard", () => {
    const sites = callSites();
    expect(
      sites,
      `deleteProjectRow gained a call site. It returns {ok:false} instead of throwing, so an unguarded caller fails SILENTLY. Route it through confirmAndRemoveOrphans' attempt() — or if this is a genuinely new surface, give it its own reporting and update this test. Sites: ${sites.join(", ")}`,
    ).toEqual(["verbs/doctor.ts"]);
  });

  it("SELF-NEGATIVE-CONTROL — the scanner really scans, and really can miss", () => {
    // Both failure modes of a regex-over-source scan: one that finds nothing
    // (so the assertion above passes vacuously on an empty list) and one that
    // cannot distinguish the definition from a call.
    expect(callSites().length).toBeGreaterThan(0);
    const defOnly = productionSources(SRC_ROOT).filter((f) =>
      /export function deleteProjectRow\s*\(/.test(readFileSync(f, "utf-8")),
    );
    expect(defOnly.map((f) => f.slice(SRC_ROOT.length + 1))).toEqual([
      "lib/registry.ts",
    ]);
    // ...and the call-site matcher must NOT be counting that definition.
    expect(callSites().some((s) => s.startsWith("lib/registry.ts"))).toBe(false);
  });
});
