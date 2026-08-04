/**
 * Registry tests — Phase 4.
 *
 * Real `better-sqlite3` against a sandboxed brain DB (IGRIS_BRAIN_DIR set to
 * a tmp dir). No mocks of the module under test; only `paths` is sandboxed
 * via env override (the supported boundary for tests).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
