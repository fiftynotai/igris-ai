/**
 * FR-240 AC #7 — nothing in this brief mutates the brain.
 *
 * The highest-value gate in the brief, because the thing it guards against is
 * INVISIBLE: every MCP read handler calls `getDb()`, which opens the brain
 * READ-WRITE and runs `migrateSchema`, and two of the learning readers
 * `UPDATE access_count`. A dashboard that reached the brain through those
 * handlers would mutate the operator's knowledge base on every page view and
 * nothing in the UI would say so.
 *
 * THE FOUR GATES AND HOW THEY PAIR (FR-239 learnings 1092-1096)
 * ------------------------------------------------------------
 *  G-RO-1  Crawl EVERY layer endpoint against a snapshot, then compare a full
 *          LOGICAL dump plus the `.db` file digest.
 *          Proves: no endpoint changed a single row or byte on this data.
 *          Does NOT prove: that a reader COULD not write — only that on this
 *          data it did not. Sibling: G-RO-3.
 *
 *  G-RO-2  NEGATIVE CONTROL. The same harness, plus a deliberate writer. The
 *          dump and the digest MUST change.
 *          Proves: G-RO-1's comparison can actually report a mutation — it is
 *          not a stillness assertion over a probe that cannot move.
 *          Does NOT prove: that every read path was exercised. Sibling: the
 *          `LAYER_PATHS` enumeration, shared with the endpoint suite so the
 *          crawl covers exactly the surface that suite asserts.
 *
 *  G-RO-3  STRUCTURAL. `query_only` reads back as 1 on the bridge handle, an
 *          `UPDATE` on it throws, AND — the part without which the throw proves
 *          nothing — the SAME `UPDATE` SUCCEEDS on a handle opened without the
 *          pragma.
 *          Proves: read-only is a property of the CONNECTION, so a writer added
 *          to a reader tomorrow fails loudly instead of silently.
 *          Does NOT prove: that the CLI holds no other handle. Sibling: G-RO-4.
 *
 *  G-RO-4  Lives brain-side, not here:
 *          `brain-mcp-server/src/tools/__tests__/pure-read-purity.test.ts`.
 *          Named so this file's coverage claim is honest about its boundary.
 *
 *  G-RO-5  THE `delete`-MODE BRAIN. Every endpoint on the tier — the layer
 *          readers AND the FR-238-era accessors — driven against a brain in
 *          SQLite's default rollback-journal mode.
 *          Proves: no GET flips `journal_mode`, creates a `-wal` sidecar,
 *          rewrites the `.db` header, or runs DDL.
 *          Does NOT prove: that the read-write doors in `registry.ts` /
 *          `brain-db.ts` are gone — they are not, and `igris register` needs
 *          them. See the block comment above that describe().
 *
 * WHAT G-RO-1 CANNOT SEE, AND WHY (learning 1095)
 * ----------------------------------------------
 * `dashboard-layers-fixture.ts` seeds the brain with `journal_mode = WAL`. That
 * is correct for what the fixture is for — the `-wal`/`-shm` sidecars are where
 * an accidental write would land without touching the `.db` file's own bytes —
 * but it has a consequence the fixture's comment did not state: **G-RO-1's
 * `after.db_sha === before.db_sha` can never exercise a journal-mode FLIP**,
 * because the brain is already in the mode every writer here would set it to.
 *
 * On a brain in `journal_mode = delete` — the SQLite default, and the state of
 * any brain that has never been opened by a WAL-setting writer — that flip is
 * a real, observable write, and until TD-319 four endpoints performed it (plus,
 * in `registry.ts`, a `CREATE TABLE IF NOT EXISTS projects`). G-RO-5 below
 * converts the fixture to `delete` mode and drives the whole tier against it,
 * so the read-only claim is a measured, mechanically-enforced statement rather
 * than a paragraph in a doc.
 *
 * @module __tests__/dashboard-readonly.test
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { get as httpGet, request as httpRequest } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb as closeBrainDb } from "../lib/brain-db.js";
import { closeDb as closeRegistryDb } from "../lib/registry.js";
import {
  openBrainReadonly,
  openBrainReadonlyWithVec,
  resetBrainBridge,
  resetLayerReaders,
} from "../lib/brain-bridge.js";
import { brainDbPath } from "../lib/paths.js";
import { startServer, type DashboardServer } from "../lib/dashboard/server.js";
import { resetWriteEngine, writeEngineState } from "../lib/brain-write-bridge.js";
import { LAYER_PATHS, seedLayerBrain } from "./dashboard-layers-fixture.js";
import {
  TRIAGE_FIXTURE,
  countPendingWithProject,
  seedTriageBrain,
} from "./dashboard-triage-fixture.js";
import {
  armHermeticEmbeddings,
  bundleStaged,
  type HermeticState,
} from "./hermetic-embeddings.js";

/**
 * HERMETIC — this crawl includes `/api/learnings/search`, so without the guard
 * it downloads ~90 MB from the HF Hub on any tree built since the last time the
 * cache was warmed (every tree: `copy-templates.sh` wipes it). Found during the
 * FR-240 warden pass by watching the cache directory reappear during `npm test`.
 * See `hermetic-embeddings.ts#armHermeticEmbeddings`.
 */
let hermetic: HermeticState = { armed: false, reason: "not attempted" };
beforeAll(async () => {
  if (!bundleStaged()) {
    hermetic = { armed: false, reason: "vendored bundle not staged" };
    return;
  }
  hermetic = await armHermeticEmbeddings();
});

let sandbox: string;
let srv: DashboardServer | null = null;
const prevBrain = process.env.IGRIS_BRAIN_DIR;

const dbPath = (): string => join(sandbox, "memory", "knowledge.db");

function req(path: string): Promise<{ status: number; body: string }> {
  const server = srv;
  if (server === null) throw new Error("server not started");
  return new Promise((resolve, reject) => {
    const r = httpGet(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        agent: false,
        headers: { host: `127.0.0.1:${server.port}` },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    r.on("error", reject);
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * A LOGICAL dump of every table: name, row count, and a digest over every row.
 *
 * Load-bearing choice. A file digest alone is not enough — SQLite can rewrite
 * page bytes (freelist churn, a checkpoint) without changing a single row, and
 * it can also stage a change in the `-wal` sidecar without touching the `.db`
 * file at all. The logical dump sees THROUGH both: it is what the next reader
 * would observe. The file digest is kept as the complementary check for
 * "nothing rewrote the file" (a `migrateSchema` run, for instance, changes bytes
 * before it changes rows).
 */
function logicalDump(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);

    const lines: string[] = [];
    for (const t of tables) {
      // FTS5 shadow tables are not independently dumpable in a stable order;
      // their CONTENT is the `learnings` table, which IS dumped, so skipping
      // them loses no coverage.
      if (/_fts(_|$)|_vec(_|$)/.test(t)) {
        lines.push(`${t}\t<fts/vec shadow — content covered by its base table>`);
        continue;
      }
      const rows = db.prepare(`SELECT * FROM "${t}"`).all() as Record<
        string,
        unknown
      >[];
      const sorted = rows
        .map((r) => JSON.stringify(r))
        .sort((a, b) => a.localeCompare(b));
      lines.push(`${t}\t${rows.length}\t${createHash("sha256").update(sorted.join("\n")).digest("hex")}`);
    }
    // The schema itself, so a `migrateSchema` run (an ALTER, a new index) shows
    // up even when it adds no rows.
    const schema = (
      db
        .prepare("SELECT sql FROM sqlite_master ORDER BY type, name")
        .all() as { sql: string | null }[]
    )
      .map((r) => r.sql ?? "")
      .join("\n");
    lines.push(`__schema__\t${createHash("sha256").update(schema).digest("hex")}`);
    return lines.join("\n");
  } finally {
    db.close();
  }
}

interface Snapshot {
  dump: string;
  db_sha: string;
  db_mtime_ms: number;
  db_size: number;
  wal_sha: string | null;
}

function snapshot(path: string): Snapshot {
  const st = statSync(path);
  return {
    dump: logicalDump(path),
    db_sha: sha256(path),
    db_mtime_ms: st.mtimeMs,
    db_size: st.size,
    wal_sha: existsSync(`${path}-wal`) ? sha256(`${path}-wal`) : null,
  };
}

async function start(): Promise<void> {
  srv = await startServer({ port: 0, cliVersion: "test" });
}

/** Drive every layer endpoint, plus the FR-238/239 ones the shell also polls. */
async function crawl(): Promise<void> {
  const paths = [
    "/api/health",
    "/api/projects",
    "/api/summary?project=demo",
    // BR-082 — the UNSCOPED read is a second reachable state of the same
    // endpoint (the predicate is dropped rather than a project supplied), so it
    // is crawled as its own path. A read-only claim about `/api/summary` that
    // only ever exercised the scoped branch would not cover the branch the
    // Overview now sits on by default when the operator clears scope.
    "/api/summary",
    "/api/graph/stats?project=demo",
    "/api/graph?project=demo",
    ...LAYER_PATHS,
  ];
  for (const p of paths) {
    const r = await req(p);
    expect(r.status, `${p} -> ${r.status}`).toBe(200);
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-fr240-ro-"));
  process.env.IGRIS_BRAIN_DIR = sandbox;
  closeBrainDb();
  closeRegistryDb();
  resetBrainBridge();
  resetLayerReaders();
  seedLayerBrain(dbPath());
});

afterEach(async () => {
  if (srv !== null) {
    await srv.close();
    srv = null;
  }
  closeBrainDb();
  closeRegistryDb();
  resetBrainBridge();
  resetLayerReaders();
  rmSync(sandbox, { recursive: true, force: true });
  if (prevBrain === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = prevBrain;
});

// ---------------------------------------------------------------------------
// G-RO-1 / G-RO-2 — the paired crawl gates
// ---------------------------------------------------------------------------

describe("G-RO-1 — a full crawl of every endpoint changes nothing", () => {
  /**
   * The generous timeout is not padding. The crawl includes
   * `/api/learnings/search`, which asks the reader for a query embedding, and
   * the FIRST such call in a process either loads a ~90 MB MiniLM ONNX model or
   * spends its time discovering it cannot. Both are legitimate production
   * states (`EmbeddingsUnavailableError` latches, so only the first call is
   * slow) and both must be inside the crawl: excluding the search path from the
   * read-only gate would leave the most complex reader unexamined.
   */
  it("the logical dump and the .db digest are identical afterwards", { timeout: 180_000 }, async () => {
    const before = snapshot(dbPath());
    await start();
    await crawl();
    // Crawl TWICE. A first-touch mutation (a lazy migration, an `access_count`
    // bump) would show up on either pass; a second pass also catches a
    // mutation that is idempotent per-request but cumulative.
    await crawl();
    const after = snapshot(dbPath());

    expect(after.dump).toBe(before.dump);
    expect(after.db_sha).toBe(before.db_sha);
    expect(after.db_size).toBe(before.db_size);
    expect(after.db_mtime_ms).toBe(before.db_mtime_ms);
  });

  it("BOTH hybrid searches and three detail views specifically change nothing", { timeout: 180_000 }, async () => {
    // Called out separately because these are the paths that WOULD write if the
    // dashboard reached the MCP handlers: `handleMemoryGet` and
    // `handleMemoryRecall` both bump `access_count` (TD-092), and `getDb()`
    // migrates on open.
    //
    // FR-246 adds `/api/briefs/search` HERE as well as to `LAYER_PATHS`. The
    // broad `crawl()` already covers it, so this is not new coverage — it is
    // the NAMED case matching its own name again. It also has a reason of its
    // own beyond symmetry: `/api/briefs/search` is the second path to open
    // `openBrainReadonlyWithVec()`, and loading an extension onto a handle is
    // the most plausible way a "read" acquires a write.
    const before = snapshot(dbPath());
    await start();
    for (const p of [
      "/api/learnings/search?q=wrapper",
      "/api/briefs/search?q=wrapper",
      "/api/brief?project=demo&id=FR-240",
      "/api/learning?id=1",
      "/api/goal?id=GL-001",
    ]) {
      expect((await req(p)).status).toBe(200);
    }
    const after = snapshot(dbPath());
    expect(after.dump).toBe(before.dump);
    expect(after.db_sha).toBe(before.db_sha);
  });

  it("access_count is not bumped by a detail view (the TD-092 carve-out)", { timeout: 180_000 }, async () => {
    await start();
    const read = (): number => {
      const db = new Database(dbPath(), { readonly: true });
      try {
        return (
          db.prepare("SELECT access_count FROM learnings WHERE id = 1").get() as {
            access_count: number;
          }
        ).access_count;
      } finally {
        db.close();
      }
    };
    expect(read()).toBe(5);
    await req("/api/learning?id=1");
    await req("/api/learning?id=1");
    await req("/api/learnings/search?q=wrapper");
    // The bump is CORRECT for `igris_memory_get` (it feeds the composite-ranking
    // boost and the recall telemetry) and WRONG for a page view — letting the
    // lens inflate the signal would corrupt the very telemetry the bump exists
    // to produce.
    expect(read()).toBe(5);
  });

  it("no schema migration runs — the brain's own version is untouched", { timeout: 180_000 }, async () => {
    // `getDb()` calls `migrateSchema`, which would ADD tables to this fixture
    // (it has no `schema_version`, no `errors`, no `sessions`). Their absence
    // afterwards is the evidence that no MCP handler was reached.
    await start();
    await crawl();
    const db = new Database(dbPath(), { readonly: true });
    try {
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((t) => t.name);
      expect(tables).not.toContain("schema_version");
      expect(tables).not.toContain("errors");
      expect(tables).not.toContain("engine_migrations");
    } finally {
      db.close();
    }
  });
});

describe("G-RO-2 — negative control: the comparison CAN report a mutation", () => {
  it("a deliberate write to the same sandbox changes the dump AND the digest", { timeout: 180_000 }, async () => {
    const before = snapshot(dbPath());
    await start();
    await crawl();
    const afterCrawl = snapshot(dbPath());
    // ASSERT-THEN-DIFF (learning 1093). First assert the crawl was still — if
    // this line fails the control below is moot — then MUTATE and assert the
    // difference. A control that never actually mutated would be a vacuous gate
    // one level up.
    expect(afterCrawl.dump).toBe(before.dump);

    const writer = new Database(dbPath());
    try {
      writer
        .prepare("UPDATE brief_status SET status = 'Done' WHERE brief_id = 'FR-240'")
        .run();
      writer.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      writer.close();
    }

    const afterWrite = snapshot(dbPath());
    expect(afterWrite.dump).not.toBe(before.dump);
    expect(afterWrite.db_sha).not.toBe(before.db_sha);
  });

  it("the LOGICAL dump catches a write the file digest could hide", async () => {
    // A change staged in the `-wal` sidecar leaves the `.db` file's bytes
    // untouched, which is precisely why G-RO-1 cannot rely on the file digest
    // alone. Demonstrated here so the choice is evidenced, not asserted.
    const before = snapshot(dbPath());
    const writer = new Database(dbPath());
    try {
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      writer.prepare("UPDATE goals SET priority = 'P3-Low' WHERE goal_id = 'GL-001'").run();
      // Deliberately NO checkpoint: the change lives in `-wal`.
      const fileUnchanged = sha256(dbPath()) === before.db_sha;
      const dumpChanged = logicalDump(dbPath()) !== before.dump;
      expect(
        dumpChanged,
        "the logical dump must see a WAL-staged write",
      ).toBe(true);
      // Whether the `.db` file itself moved is platform/checkpoint dependent,
      // so it is REPORTED rather than asserted — the load-bearing claim is that
      // the dump saw the write either way.
      void fileUnchanged;
    } finally {
      writer.close();
    }
  });
});

// ---------------------------------------------------------------------------
// G-RO-3 — structural: read-only is a property of the CONNECTION
// ---------------------------------------------------------------------------

describe("G-RO-3 — query_only is armed on the bridge handle", () => {
  it("reads back as 1 and refuses an UPDATE", () => {
    const db = openBrainReadonly();
    expect(db).not.toBeNull();
    if (db === null) return;
    try {
      expect(db.pragma("query_only", { simple: true })).toBe(1);
      expect(() =>
        db.prepare("UPDATE brief_status SET status = 'x' WHERE brief_id = 'FR-240'").run(),
      ).toThrow(/SQLITE_READONLY|readonly/i);
      expect(() =>
        db.prepare("DELETE FROM learnings WHERE id = 1").run(),
      ).toThrow(/SQLITE_READONLY|readonly/i);
      expect(() => db.exec("CREATE TABLE injected (a INT)")).toThrow();
    } finally {
      db.close();
    }
  });

  it("SELF-NEGATIVE-CONTROL — the SAME UPDATE SUCCEEDS on an unarmed handle", () => {
    // Without this test the assertions above prove nothing about `query_only`:
    // "the write threw" is also what you observe when the table is missing, the
    // SQL is malformed, or the file is corrupt. Running the identical statement
    // to SUCCESS on a plain handle is what attributes the refusal to the pragma.
    const db = new Database(dbPath());
    try {
      expect(db.pragma("query_only", { simple: true })).toBe(0);
      const info = db
        .prepare("UPDATE brief_status SET status = 'Done' WHERE brief_id = 'FR-240'")
        .run();
      expect(info.changes).toBe(1);
    } finally {
      db.close();
    }
  });

  it("and it is armed on the WITH-VEC handle too", async () => {
    const handle = await openBrainReadonlyWithVec();
    expect(handle).not.toBeNull();
    if (handle === null) return;
    try {
      expect(handle.db.pragma("query_only", { simple: true })).toBe(1);
      expect(() =>
        handle.db.prepare("UPDATE learnings SET access_count = 99 WHERE id = 1").run(),
      ).toThrow(/SQLITE_READONLY|readonly/i);
      // Loading an extension must not have relaxed the posture — step-10 probe
      // (a) confirmed the two coexist, and this is the standing assertion of it.
      expect(handle.vector_available || handle.vector_reason !== null).toBe(true);
    } finally {
      handle.db.close();
    }
  });

  it("returns null (never a live handle) when the brain file is absent", () => {
    rmSync(join(sandbox, "memory"), { recursive: true, force: true });
    expect(openBrainReadonly()).toBeNull();
  });

  /**
   * THE R4 FALLBACK BRANCH — what is and is not covered here.
   *
   * `openBrainReadonly()` has a second branch: when `{readonly:true}` throws (a
   * WAL brain with no `-shm` that this machine has never written), it re-opens
   * READ-WRITE and arms `query_only` there instead. That branch is the one where
   * the pragma is genuinely load-bearing, because the connection itself is
   * writable.
   *
   * It is NOT environmentally forceable on darwin with better-sqlite3 11 /
   * SQLite 3.4x: measured during FR-240, a readonly open of a WAL database with
   * a populated `-wal` and NO `-shm` SUCCEEDS (SQLite materialises the `-shm`),
   * and it still succeeds with the containing directory at mode 0500. Faking the
   * branch by stubbing the `Database` constructor would test the stub.
   *
   * So the branch's LOAD-BEARING PROPERTY is tested directly instead: that
   * `query_only = ON` on a read-WRITE handle refuses writes on this exact
   * better-sqlite3 build. That is the only thing the fallback relies on. What
   * remains uncovered is the wiring — that the fallback branch actually calls
   * the pragma — which is asserted structurally below.
   */
  it("the fallback's load-bearing property: query_only stops a read-WRITE handle", () => {
    const db = new Database(dbPath(), { fileMustExist: true });
    try {
      // Before: writable.
      expect(
        db.prepare("UPDATE goals SET priority = 'P1-High' WHERE goal_id = 'GL-002'").run()
          .changes,
      ).toBe(1);
      // After arming: refused. Same handle, same statement — the pragma is the
      // only variable.
      db.pragma("query_only = ON");
      expect(db.pragma("query_only", { simple: true })).toBe(1);
      expect(() =>
        db.prepare("UPDATE goals SET priority = 'P3-Low' WHERE goal_id = 'GL-002'").run(),
      ).toThrow(/SQLITE_READONLY|readonly/i);
    } finally {
      db.close();
    }
  });

  it("BOTH branches of openBrainReadonly arm the pragma (structural)", () => {
    // A source assertion, and stated as such: it covers the WIRING the runtime
    // test above cannot reach. Two `query_only = ON` sites, one per branch —
    // the D2 requirement that the R4 fallback is not left unguarded.
    const src = readFileSync(
      new URL("../lib/brain-bridge.ts", import.meta.url),
      "utf-8",
    );
    const fn = src.slice(
      src.indexOf("export function openBrainReadonly("),
      src.indexOf("export interface VecHandle"),
    );
    expect(fn.length).toBeGreaterThan(0);
    const armings = fn.match(/pragma\(\s*"query_only = ON"\s*\)/g) ?? [];
    expect(
      armings.length,
      "each of the two open branches must arm query_only",
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// G-RO-5 — EVERY endpoint on this tier leaves a `delete`-mode brain alone
//
// SCOPE, AND WHAT TD-319 CHANGED. `routes.ts` reaches the brain through two
// doors, and BOTH are now read-only:
//
//   the LAYER readers    `brain-bridge.ts#openBrainReadonly` /
//                        `#openBrainReadonlyWithVec` — `{readonly:true}` plus
//                        `query_only = ON` on both branches. Structurally
//                        read-only since FR-240, asserted by G-RO-3.
//
//   the FR-238 accessors `registry.ts#listProjectsReadonly` (behind
//                        `/api/projects` and, via `isKnownProject`,
//                        `/api/context-docs`), `brain-db.ts`'s
//                        `#briefStatusSummaryReadonly` / `#listInstancesReadonly`
//                        (behind `/api/summary`) and `#readProjectProfile`
//                        (behind `/api/context-docs`, via the inventory digest).
//                        Until TD-319 each of these opened `new Database(path)`
//                        with no `readonly`, set `journal_mode = WAL`, and — in
//                        `registry.ts` — ran `CREATE TABLE IF NOT EXISTS
//                        projects`. Each now has a SECOND door that opens
//                        through `openBrainReadonly` and preflights the table
//                        instead of creating it.
//
// So "every brain handle in this tier is read-only" was FALSE as written from
// FR-238 through FR-246, and MAINTAINING row 108 + `docs/dashboard.md` carried
// the qualified version. TD-319 makes the UNQUALIFIED claim true and these
// tests are what keeps it honest.
//
// THE PINS BELOW ARE THE INVERSE OF THE ONES THEY REPLACE. FR-240 pinned the
// defect (`journal_mode` flips to `wal`; a GET runs DDL) so the residual could
// not silently drift back into an unqualified doc claim; those four
// characterisation pins carried their own delete-me instruction and TD-319
// executed it. What stands here now asserts the fix — same three endpoints,
// same `delete`-mode fixture, opposite expectation.
//
// WHAT THE WRITE DOORS STILL DO, and why that is not a gap: `listProjects`,
// `briefStatusSummary` and `listInstances` are UNCHANGED and still open
// read-write. `igris register`, `igris doctor --remove-orphans` and
// `igris init` need exactly that. The claim this block makes is about what an
// HTTP GET can reach, not about the module.
// ---------------------------------------------------------------------------

describe("G-RO-5 — no endpoint on this tier writes to a `delete`-mode brain", () => {
  /** Read `journal_mode` without becoming a writer ourselves. */
  const journalMode = (path: string): string =>
    String(
      (() => {
        const db = new Database(path, { readonly: true });
        try {
          return db.pragma("journal_mode", { simple: true });
        } finally {
          db.close();
        }
      })(),
    );

  /** Put the seeded fixture back into SQLite's default rollback-journal mode. */
  function toDeleteMode(): void {
    const db = new Database(dbPath());
    try {
      db.pragma("journal_mode = delete");
    } finally {
      db.close();
    }
    rmSync(`${dbPath()}-wal`, { force: true });
    rmSync(`${dbPath()}-shm`, { force: true });
  }

  /*
   * TD-320 #2 — THE TITLE SAYS "SERVED PURELY BY THE READ-ONLY BRIDGE", NOT
   * "THE LAYER ENDPOINTS".
   *
   * It used to say the latter, and that claim exceeded what the test asserts:
   * `LAYER_PATHS` covers 23 URLs across 10 endpoints INCLUDING
   * `/api/context-docs`, while this list is the subset served purely by the
   * read-only bridge. There is no coverage gap — `/api/context-docs` is driven
   * by the very next test, from the opposite direction — but a title that names
   * a superset is the failure class this backlog exists to close: a guard whose
   * stated claim is wider than its assertion.
   */
  it("the layer endpoints served purely by the read-only bridge leave a `delete`-mode brain untouched", async () => {
    // The half that IS structurally read-only. Asserted FIRST so the pin below
    // reads as a statement about the OTHER door rather than about the server.
    toDeleteMode();
    expect(journalMode(dbPath())).toBe("delete");
    const before = snapshot(dbPath());

    await start();
    for (const p of [
      "/api/briefs",
      "/api/brief?project=demo&id=FR-240",
      "/api/learnings",
      "/api/learning?id=1",
      "/api/goals",
      "/api/goal?id=GL-001",
      // The two search endpoints. They reach the brain through
      // openBrainReadonlyWithVec rather than openBrainReadonly, so they are the
      // TWO paths in this tier whose handles are armed by a DIFFERENT opener —
      // which is exactly why they belong in a crawl that claims to cover "the
      // LAYER endpoints". FR-246 added the second; this list carried only the
      // first for one review round, so the title over-claimed its own coverage.
      // Offline here (hermetic-embeddings), so both degrade to bm25_only; the
      // mode is 3f's business, not this gate's.
      "/api/learnings/search?q=read-only",
      "/api/briefs/search?q=read-only",
    ]) {
      expect((await req(p)).status, p).toBe(200);
    }

    expect(journalMode(dbPath()), "a layer reader changed the journal mode").toBe(
      "delete",
    );
    expect(sha256(dbPath())).toBe(before.db_sha);
    expect(existsSync(`${dbPath()}-wal`)).toBe(false);
  });

  /**
   * TD-319 — the three endpoints that used to flip it, all in one reading.
   *
   * ONE test rather than three because the load-bearing claim is about the SET:
   * "no GET on this tier writes" is falsified by any single member, and a
   * per-endpoint split invites a future endpoint to be added to `routes.ts` and
   * to nothing here. The per-endpoint attribution is preserved in the assertion
   * messages, so a failure still names which path moved.
   *
   * `/api/summary` is driven in BOTH of its reachable states (scoped and
   * unscoped): they take different branches inside `briefStatusSummaryReadonly`
   * and `listInstancesReadonly`, and the unscoped one is where the Overview
   * sits by default when the operator clears scope.
   */
  it("the FR-238-era endpoints leave a `delete`-mode brain byte-identical", async () => {
    toDeleteMode();
    // ASSERT-THEN-DIFF (learning 1093): establish the precondition before the
    // claim that depends on it. Without this line a `toDeleteMode` that silently
    // did nothing would make every assertion below vacuously green — which is
    // precisely what the self-negative-control at the bottom guards a second time.
    expect(journalMode(dbPath())).toBe("delete");
    const before = snapshot(dbPath());

    await start();
    for (const p of [
      "/api/projects",
      "/api/summary?project=demo",
      "/api/summary",
      "/api/context-docs?project=demo",
      // TD-319: the singular path is named in MAINTAINING and docs/dashboard.md
      // as one of the closed paths, and it shares `readProjectProfile` with the
      // plural — so leaving it out of this loop meant the claim was asserted in
      // prose and enforced nowhere. One string is the difference.
      "/api/context-doc?project=demo&type=coding_guidelines",
    ]) {
      expect((await req(p)).status, p).toBe(200);
      expect(journalMode(dbPath()), `${p} flipped the journal mode`).toBe(
        "delete",
      );
      expect(existsSync(`${dbPath()}-wal`), `${p} created a -wal sidecar`).toBe(
        false,
      );
      expect(sha256(dbPath()), `${p} rewrote the .db file`).toBe(before.db_sha);
    }

    // The logical dump too: a `-wal`-staged row change would not move the file
    // digest, and this file's own G-RO-2 demonstrates that blind spot.
    expect(snapshot(dbPath()).dump).toBe(before.dump);
  });

  it("the payloads are REAL — the read-only door still answers with rows", async () => {
    // Without this, the stillness above is also what a reader returning `[]`
    // for everything would produce, and TD-319 swapped the DOOR all three
    // endpoints read through. A gate that cannot tell "did not write" from
    // "did not read" is the vacuous shape this backlog is about.
    //
    // The catalog is seeded because this suite's sandbox has none, and an
    // absent catalog degrades the inventory to zero rows regardless of the
    // brain — which would make the context-docs half of this test unable to
    // fail for the reason it is here to check. Two entries, so "every row" and
    // "one row" are distinguishable.
    const catalogDir = join(sandbox, "core", "context-doc-types");
    mkdirSync(catalogDir, { recursive: true });
    for (const type of ["coding_guidelines", "architecture_map"]) {
      writeFileSync(
        join(catalogDir, `${type}.md`),
        [
          "---",
          `type: ${type}`,
          `target: ${type}.md`,
          "applies_when: always",
          "optional: false",
          `summary: seeded for the TD-319 read-only gate (${type})`,
          "---",
          "",
          "Body.",
        ].join("\n"),
      );
    }

    toDeleteMode();
    await start();

    const projects = JSON.parse((await req("/api/projects")).body) as {
      projects: { slug: string }[];
      degraded: unknown;
    };
    expect(projects.degraded).toBeNull();
    expect(projects.projects.map((p) => p.slug)).toContain("demo");

    const scoped = JSON.parse((await req("/api/summary?project=demo")).body) as {
      briefs: { total: number };
      instances: { active: number };
      degraded: unknown;
    };
    expect(scoped.degraded).toBeNull();
    expect(scoped.briefs.total).toBeGreaterThan(0);
    // `listInstancesReadonly` is the accessor with the most to go wrong: it is
    // the one whose read-write twin runs an `ALTER TABLE` this door skips.
    expect(scoped.instances.active).toBeGreaterThan(0);

    const docs = JSON.parse((await req("/api/context-docs?project=demo")).body) as {
      archetype: string | null;
      inventory_degraded: boolean;
      docs: unknown[];
      degraded: { reason: string } | null;
    };
    // `unknown project: demo` is exactly what an empty `listProjectsReadonly()`
    // would produce here, and it is the specific failure this excludes.
    expect(docs.degraded).toBeNull();
    expect(docs.inventory_degraded).toBe(false);
    expect(docs.docs.length).toBe(2);
    // From `brain-db.ts#readProjectProfile` — the SECOND read-only accessor on
    // this path, and the one a fix limited to `isKnownProject` would have left
    // opening read-WRITE.
    expect(docs.archetype).toBe("unclassified");

    // Still `delete` after all of that — the reads were real AND still-handed.
    expect(journalMode(dbPath())).toBe("delete");
    expect(existsSync(`${dbPath()}-wal`)).toBe(false);
  });

  it("no endpoint runs DDL on a brain with no `projects` table", async () => {
    // The half with real consequences: before TD-319 a brain that predates the
    // `projects` table got one CREATEd by a GET. All three endpoints are driven,
    // because `registry.ts` was not the only accessor reaching for that table —
    // `brain-db.ts#readProjectProfile` (behind `/api/context-docs`) preflights it
    // too, and a preflight that ran on a read-WRITE handle was one edit away
    // from becoming a create.
    const bare = join(sandbox, "memory", "knowledge.db");
    rmSync(bare, { force: true });
    rmSync(`${bare}-wal`, { force: true });
    rmSync(`${bare}-shm`, { force: true });
    const seed = new Database(bare);
    try {
      seed.pragma("journal_mode = delete");
      seed.exec("CREATE TABLE brief_status (id INTEGER PRIMARY KEY, project TEXT);");
    } finally {
      seed.close();
    }
    const tables = (): string[] => {
      const db = new Database(bare, { readonly: true });
      try {
        return (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all() as { name: string }[]
        ).map((t) => t.name);
      } finally {
        db.close();
      }
    };
    expect(tables()).toEqual(["brief_status"]);
    const before = sha256(bare);

    await start();
    for (const p of [
      "/api/projects",
      "/api/summary?project=demo",
      "/api/summary",
      "/api/context-docs?project=demo",
      // TD-319: the singular path is named in MAINTAINING and docs/dashboard.md
      // as one of the closed paths, and it shares `readProjectProfile` with the
      // plural — so leaving it out of this loop meant the claim was asserted in
      // prose and enforced nowhere. One string is the difference.
      "/api/context-doc?project=demo&type=coding_guidelines",
    ]) {
      expect((await req(p)).status, p).toBe(200);
    }

    expect(tables(), "a GET created a table").toEqual(["brief_status"]);
    expect(journalMode(bare)).toBe("delete");
    expect(sha256(bare)).toBe(before);
  });

  it("SELF-NEGATIVE-CONTROL — `toDeleteMode` really produces a `delete`-mode brain", () => {
    // Without this, every "flipped to wal" assertion above is also what you
    // observe from a helper that silently did nothing to a brain that was
    // already WAL. The fixture seeds WAL, so the transition is the evidence.
    expect(journalMode(dbPath())).toBe("wal");
    toDeleteMode();
    expect(journalMode(dbPath())).toBe("delete");
  });

  /**
   * TD-320 #6 — SELF-NEGATIVE-CONTROL FOR THE FILE-LEVEL HALF OF `readonly`.
   *
   * WHY THIS IS NOT COVERED BY THE `query_only` TESTS ABOVE, and why FR-240's
   * review flagged its absence. `openBrainReadonly` arms TWO carriers:
   * `{readonly: true}` on the connection and `query_only = ON` as a pragma. They
   * do not carry the same properties:
   *
   *   both       refuse INSERT / UPDATE / DELETE / DDL
   *   `readonly` ALSO: no `-wal`/`-shm` sidecar creation, no `journal_mode`
   *              change, and no database CREATION on a missing path
   *
   * So flipping `readonly: true -> false` alone is CORRECTLY uncaught by a write
   * test — `query_only` still carries that half, and the R4 fallback branch
   * deliberately opens read-write for exactly that reason. What has no named
   * guard is the SECOND column: the file-level effects, which G-RO-5's tests
   * above cover only INCIDENTALLY (they assert the effects are absent, but a
   * reader cannot tell whether that is because the carriers work or because
   * nothing on the path would have produced them anyway).
   *
   * THIS CONTROL ESTABLISHES LESS THAN AN EARLIER DRAFT CLAIMED, and the
   * difference matters enough to state.
   *
   * It opens the RAW driver (`new Database(...)`) — it does not call
   * `openBrainReadonly` with its carriers stripped. So what it proves is that
   * the MEDIUM can exhibit these effects: a `delete`-mode fixture really will
   * flip its journal mode, really will grow a `-wal`, and really will be
   * created on a missing path, so G-RO-5's assertions are not vacuous against
   * an inert fixture.
   *
   * What it does NOT prove is that the product's DOOR is what suppresses them.
   * The draft closed with: *"If they do not, G-RO-5's silence above means
   * nothing — it would be the silence of a path that never writes, not the
   * silence of a door that is shut."* That inference does not follow from this
   * body: G-RO-5's silence could still be the silence of a path that never
   * issues `journal_mode = wal`, and this control cannot discriminate the two.
   *
   * The door-level probe FR-240's residual actually asked for — strip
   * `readonly` and `fileMustExist` from `openBrainReadonly` itself and re-run
   * the layer crawl — is NOT built here. TD-320 item #6 is therefore
   * RELABELLED, not closed, and **TD-349 owns closing it.** Do not read this
   * test as covering it.
   *
   * TD-349 also carries the sharper half: dropping `readonly: true` ALONE is
   * currently caught by nothing. `query_only` does not refuse a journal-mode
   * pragma (TD-319 measured that asymmetry on the R4 fallback branch), so a
   * refactor that lost that one carrier would leave every test here green.
   *
   * KEEP THIS TEST when TD-349 lands. It covers the inert-fixture case — that
   * the medium can move at all — which a door-level probe does not.
   */
  it("SELF-NEGATIVE-CONTROL — a connection opened WITHOUT the carriers shows the file-level effects are reachable", () => {
    toDeleteMode();
    expect(journalMode(dbPath()), "precondition").toBe("delete");
    expect(existsSync(`${dbPath()}-wal`), "precondition").toBe(false);
    const before = sha256(dbPath());

    // (1) THE JOURNAL-MODE FLIP AND THE `-wal` SIDECAR. `readonly: true` would
    //     refuse this pragma; `query_only = ON` would NOT (it gates statements,
    //     not connection-level file management). One open with neither carrier
    //     is what produces both effects.
    const rw = new Database(dbPath(), { fileMustExist: true });
    try {
      rw.pragma("journal_mode = wal");
      rw.prepare("SELECT count(*) AS n FROM goals").get();
    } finally {
      rw.close();
    }
    expect(journalMode(dbPath()), "a read-write open did NOT flip the journal mode").toBe(
      "wal",
    );
    expect(sha256(dbPath()), "a journal-mode flip did NOT rewrite the .db header").not.toBe(
      before,
    );

    // (2) DATABASE CREATION ON A MISSING PATH. `fileMustExist` is the carrier
    //     `openBrainReadonly` pairs with `readonly`; without it a bare open
    //     CREATES the file. This is the property `openBrainReadonly()` returning
    //     `null` for an absent brain exists to preserve, and G-RO-4's
    //     "returns null (never a live handle) when the brain file is absent" is
    //     the arm this is the control for.
    const ghost = join(sandbox, "memory", "not-a-brain.db");
    expect(existsSync(ghost), "precondition").toBe(false);
    const created = new Database(ghost);
    created.close();
    expect(existsSync(ghost), "a bare open did NOT create the database").toBe(true);

    // Leave the fixture as this describe's other tests expect to find it.
    rmSync(ghost, { force: true });
    rmSync(`${ghost}-wal`, { force: true });
    rmSync(`${ghost}-shm`, { force: true });
  });
});

// ---------------------------------------------------------------------------
// G-RO-6 — FR-241: the WRITE door stays shut on a read-only session
// ---------------------------------------------------------------------------

/**
 * FR-241 adds a read-WRITE door into the same brain bundle. G-RO-5 above shows
 * the read tier leaves a `delete`-mode brain byte-identical; that stays true
 * ONLY because the write engine is LAZY — nothing boots it but a
 * `POST /api/triage`.
 *
 * "Lazy" is a claim about a thing NOT happening, which is precisely the shape
 * learning 1092 warns about: stillness is not liveness, and a `writeEngineState()`
 * that returned `"not-booted"` unconditionally would satisfy the first half of
 * this gate forever. So the SELF-NEGATIVE-CONTROL is in the same test: one real
 * POST must flip the state AND change the digest.
 *
 * A REAL FINDING THAT SHAPED THIS GATE. The write engine CANNOT boot against
 * this file's fixture:
 *
 *     bootEngine(seedLayerBrain(...)) -> "duplicate column name: archetype"
 *
 * `dashboard-layers-fixture.ts` hand-rolls DDL (it must — `cli/` and
 * `brain-mcp-server/` have zero cross-imports), and the engine's own migrations
 * then re-apply an `ALTER TABLE` that DDL already inlined. So the negative
 * control below builds its own brain through the ENGINE's migrations
 * (`dashboard-triage-fixture.ts`), which is the same reason the whole FR-241
 * write suite does. Asserting the flip against this fixture would have observed
 * `unavailable:boot_failed` — a state change, but the wrong one, and a gate
 * that passed for a reason it never stated.
 *
 * WHAT THIS PROVES: a pure-read session never opens the write connection, so
 * the read tier's read-only property is unaffected by the existence of a write
 * path.
 * WHAT IT DOES NOT PROVE: that the READ handles are still read-only — that is
 * G-RO-3, unmodified and still running above.
 */
describe("G-RO-6 — the write engine is LAZY, and a POST really does wake it", () => {
  it("after the full G-RO-5 read sequence the write engine is NOT booted", async () => {
    resetWriteEngine();
    expect(writeEngineState()).toBe("not-booted");

    const before = snapshot(dbPath());
    await start();
    // The exact sequence G-RO-5 drives, plus FR-241's own READ half. Neither
    // may open the write door.
    for (const p of [
      "/api/health",
      "/api/briefs",
      "/api/brief?project=demo&id=FR-240",
      "/api/learnings",
      "/api/learning?id=1",
      "/api/goals",
      "/api/goal?id=GL-001",
      "/api/suggestions",
      "/api/suggestions?project=demo&status=pending",
      // TD-326 — the `project_slug IS NULL` scope is still a READ.
      "/api/suggestions?project_scope=brain-level&status=pending",
    ]) {
      expect((await req(p)).status, p).toBe(200);
    }

    // `/api/health` REPORTS the write surface on every 5-second beat. It must
    // report it without opening it — a probe that booted the thing it probed
    // would make this whole gate unassertable.
    const health = JSON.parse((await req("/api/health")).body) as {
      write: { available: boolean; state: string; actions: string[] };
    };
    expect(health.write.state).toBe("not-booted");
    // FR-247 grew this from five to SEVEN. It is spelled out rather than
    // derived from `TRIAGE_ACTION_NAMES`, deliberately: this is the vocabulary
    // the endpoint SERVES to a client, and reading it from the same constant
    // the endpoint reads would make the assertion a tautology. A new mutation
    // has to be added here, on purpose, in the same commit as its map row.
    expect(health.write.actions.sort()).toEqual([
      "acted",
      "apply",
      "approve",
      "attach_goal",
      "dismiss",
      "reject",
      "set_priority",
    ]);

    expect(writeEngineState(), "a READ opened the write door").toBe("not-booted");
    expect(snapshot(dbPath()).dump).toBe(before.dump);
  });

  it("SELF-NEGATIVE-CONTROL — one POST flips the state and DOES change the brain", async () => {
    // A second sandbox, migrated by the engine itself (see the describe header
    // for why this fixture cannot be the one above).
    const writeSandbox = mkdtempSync(join(tmpdir(), "igris-fr241-ro6-"));
    const writeDb = join(writeSandbox, "memory", "knowledge.db");
    const prevDir = process.env.IGRIS_BRAIN_DIR;
    process.env.IGRIS_BRAIN_DIR = writeSandbox;
    closeBrainDb();
    closeRegistryDb();
    resetBrainBridge();
    resetLayerReaders();
    resetWriteEngine();

    let server: DashboardServer | null = null;
    try {
      const seeded = await seedTriageBrain(writeDb);
      expect(seeded.ok, seeded.ok ? "" : `fixture failed: ${seeded.reason}`).toBe(true);
      // The fixture's own migrate pass tears its engine down, so the state is
      // back to "not-booted" and the flip below is attributable to the POST.
      resetWriteEngine();
      expect(writeEngineState()).toBe("not-booted");

      /*
       * The LOGICAL dump, not the `.db` digest — and this was measured, not
       * assumed. A first draft asserted `sha256(writeDb)` changed and FAILED:
       * the dispatch landed entirely in the `-wal` sidecar and the main file
       * was byte-identical afterwards. That is the exact blind spot this
       * file's own `logicalDump` header describes ("SQLite can stage a change
       * in the `-wal` sidecar without touching the `.db` file at all"), so the
       * negative control uses the instrument that sees through it. The `-wal`
       * transition is asserted separately, because "the write went somewhere"
       * and "the write is visible" are two different claims.
       */
      const before = logicalDump(writeDb);
      const beforeWal = existsSync(`${writeDb}-wal`) ? sha256(`${writeDb}-wal`) : null;
      const beforePending = countPendingWithProject(writeDb);
      expect(beforePending).toBe(TRIAGE_FIXTURE.pendingSuggestions);

      server = await startServer({ port: 0, cliVersion: "test" });
      const body = JSON.stringify({ action: "dismiss", ids: [1], reason: "G-RO-6" });
      const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const r = httpRequest(
          {
            host: "127.0.0.1",
            port: server!.port,
            path: "/api/triage",
            method: "POST",
            agent: false,
            headers: {
              host: `127.0.0.1:${server!.port}`,
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(body)),
            },
          },
          (r2) => {
            let text = "";
            r2.setEncoding("utf-8");
            r2.on("data", (c: string) => (text += c));
            r2.on("end", () => resolve({ status: r2.statusCode ?? 0, text }));
          },
        );
        r.on("error", reject);
        r.write(body);
        r.end();
      });

      // ASSERT-THEN-DIFF. The applied count first, because a digest change on
      // its own is also what a failed boot writing a WAL header looks like.
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toMatchObject({ applied: 1, failed: 0, degraded: null });
      expect(writeEngineState(), "a real POST did NOT boot the write engine").toBe(
        "booted",
      );
      expect(countPendingWithProject(writeDb)).toBe(beforePending - 1);
      expect(
        logicalDump(writeDb),
        "the mutation left the brain logically identical",
      ).not.toBe(before);
      const afterWal = existsSync(`${writeDb}-wal`) ? sha256(`${writeDb}-wal`) : null;
      expect(afterWal, "no -wal after a write: the engine wrote somewhere else").not.toBeNull();
      expect(afterWal).not.toBe(beforeWal);
    } finally {
      if (server !== null) await server.close();
      resetWriteEngine();
      closeBrainDb();
      closeRegistryDb();
      resetBrainBridge();
      resetLayerReaders();
      rmSync(writeSandbox, { recursive: true, force: true });
      if (prevDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
      else process.env.IGRIS_BRAIN_DIR = prevDir;
    }
  });
});

// ---------------------------------------------------------------------------
// Sandbox hygiene — the seam this whole suite depends on
// ---------------------------------------------------------------------------

describe("the tests are pointed at the SANDBOX, never the operator's brain", () => {
  it("the crawl is HERMETIC — no endpoint here can reach the HuggingFace Hub", () => {
    // Self-negative-control for this file's own setup, and a real gate: the
    // crawl hits `/api/learnings/search`, whose reader embeds the query before
    // it can reach the vector arm. If this is red, the suite is silently
    // downloading a ~90 MB model into a build artifact that two parallel workers
    // can corrupt — the exact failure the CDP gate was rejected for.
    expect(bundleStaged(), "run `npm run build` in cli/ before this suite").toBe(
      true,
    );
    expect(
      hermetic.armed,
      `remote model fetch is NOT blocked: ${hermetic.reason ?? "unknown"}`,
    ).toBe(true);
  });

  it("brainDbPath() resolves inside the sandbox", () => {
    // G3 in the plan: `getDb()` honours `IGRIS_DB_PATH` while the CLI honours
    // `IGRIS_BRAIN_DIR`, which is exactly why a handler-based test would escape
    // its sandbox and read the real brain. Asserted, not assumed.
    expect(brainDbPath()).toBe(dbPath());
    expect(brainDbPath().startsWith(sandbox)).toBe(true);
    expect(brainDbPath()).not.toContain("/.igris/memory");
  });

  it("no /api/ path accepts a write method", async () => {
    await start();
    // Belt on top of `server.ts`'s method guard: a layer endpoint added without
    // going through the router's GET/HEAD gate is the shape this catches.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const r = httpGet(
          {
            host: "127.0.0.1",
            port: srv?.port,
            path: "/api/briefs",
            method,
            agent: false,
            headers: { host: `127.0.0.1:${srv?.port ?? 0}` },
          },
          (res) => resolve(res.statusCode ?? 0),
        );
        r.on("error", reject);
        r.end();
      });
      expect(status, `${method} /api/briefs`).toBe(405);
    }
  });
});
