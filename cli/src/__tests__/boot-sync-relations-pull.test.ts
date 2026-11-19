/**
 * FR-273 D8.5 — `boot-sync` pulls the two project-relation tables (plan §4.2
 * P-series). Drives the REAL `mergePulledTables` over the REAL
 * `BOOT_SYNC_PULL_TABLES` config against a REAL tmp brain DB whose relation
 * DDL is the brain's projects:3 CREATE, verbatim.
 *
 *   - P1 rows merge (an edge and a new kind land, read back from the ROW);
 *   - P2 a tombstone applies (a newer row with `removed_at` set);
 *   - P3 an absent local table: a per-table failure is recorded and that
 *     table's `sync_state` cursor is NOT written (create-never);
 *   - plus: the two entries are verbatim copies of the brain's SYNC_TABLES
 *     entries (checked against the generated egress manifest's column lists),
 *     appended at the array end, kinds first.
 *
 * BR-106: fenced (HOME moves first, ARMED).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fenceHome, type HomeFence } from "./home-fence.js";

let fence: HomeFence;
const REMOTE = "https://remote.invalid";

/** brain-mcp-server/src/engine/components/projects/relations/schema.ts — RELATION_TABLES_SQL, verbatim. */
const RELATIONS_DDL = `
CREATE TABLE IF NOT EXISTS project_relation_kinds (
  name TEXT PRIMARY KEY,
  meaning TEXT NOT NULL,
  direction TEXT NOT NULL,
  forward_label TEXT NOT NULL,
  inverse_label TEXT NOT NULL,
  example TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  merged_into TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  to_slug TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  provenance TEXT NOT NULL DEFAULT 'declared',
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (from_slug, kind, to_slug)
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
  return join(fence.brainDir, "memory", "knowledge.db");
}

function withDb<T>(fn: (db: Database.Database) => T): T {
  mkdirSync(join(fence.brainDir, "memory"), { recursive: true });
  const db = new Database(dbFile());
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function seedSchema(withRelations: boolean): void {
  withDb((db) => {
    db.pragma("journal_mode = WAL");
    db.exec(SYNC_STATE_DDL + (withRelations ? RELATIONS_DDL : ""));
  });
}

const EDGE = {
  from_slug: "moca-agent-web",
  kind: "uses_package",
  to_slug: "moca-agent-flutter-client",
  detail: '{"ref":"v2.0.0"}',
  provenance: "declared",
  removed_at: null,
  created_at: "2026-09-29 10:00:00",
  updated_at: "2026-09-29 10:00:00",
};

const KIND = {
  name: "deploys_to",
  meaning: "A is deployed onto B's hosting infrastructure",
  direction: "A → B",
  forward_label: "deploys to",
  inverse_label: "hosts",
  example: "x deploys_to y",
  aliases: "hosted_on",
  status: "active",
  merged_into: null,
  created_at: "2026-09-29 10:00:00",
  updated_at: "2026-09-29 10:00:00",
};

async function merge(tables: Record<string, Record<string, unknown>[]>) {
  const { mergePulledTables } = await import("../lib/brain-db.js");
  return mergePulledTables(REMOTE, tables);
}

beforeEach(() => {
  fence = fenceHome("igris-fr273-pull-");
  fence.assertArmed();
});

afterEach(async () => {
  (await import("../lib/brain-db.js")).closeDb();
  fence.release();
});

describe("boot-sync pulls the project-relation tables (FR-273)", () => {
  it("P1: an edge and a kind merge, read back from the rows", async () => {
    seedSchema(true);
    const r = await merge({ project_relations: [EDGE], project_relation_kinds: [KIND] });
    expect(r.perTable.project_relations).toMatchObject({ inserted: 1, failed: 0 });
    expect(r.perTable.project_relation_kinds).toMatchObject({ inserted: 1, failed: 0 });
    withDb((db) => {
      expect(db.prepare("SELECT from_slug, kind, to_slug, detail, removed_at FROM project_relations").all()).toEqual([
        { from_slug: "moca-agent-web", kind: "uses_package", to_slug: "moca-agent-flutter-client", detail: '{"ref":"v2.0.0"}', removed_at: null },
      ]);
      expect(db.prepare("SELECT name, aliases FROM project_relation_kinds").all()).toEqual([{ name: "deploys_to", aliases: "hosted_on" }]);
      const cursors = db.prepare("SELECT table_name FROM sync_state WHERE last_pull_at IS NOT NULL ORDER BY table_name").all();
      expect(cursors).toEqual([{ table_name: "project_relation_kinds" }, { table_name: "project_relations" }]);
    });
  });

  it("P2: a newer tombstone applies; a newer alias set unions (merge_tags)", async () => {
    seedSchema(true);
    await merge({ project_relations: [EDGE], project_relation_kinds: [KIND] });
    await merge({
      project_relations: [{ ...EDGE, removed_at: "2026-09-29 11:00:00", updated_at: "2026-09-29 11:00:00" }],
      project_relation_kinds: [{ ...KIND, aliases: "runs_on", updated_at: "2026-09-29 11:00:00" }],
    });
    withDb((db) => {
      expect(db.prepare("SELECT removed_at FROM project_relations").get()).toEqual({ removed_at: "2026-09-29 11:00:00" });
      expect(db.prepare("SELECT aliases FROM project_relation_kinds").get()).toEqual({ aliases: "hosted_on,runs_on" });
    });
  });

  it("P3: an absent local table records a failure and writes NO cursor for it (create-never)", async () => {
    seedSchema(false);
    const r = await merge({ project_relations: [EDGE] });
    expect(r.perTable.project_relations.failed).toBe(1);
    expect(r.perTable.project_relations.failures?.[0].error).toMatch(/absent — skipped \(create-never\)/);
    withDb((db) => {
      expect(db.prepare("SELECT COUNT(*) AS n FROM sync_state").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'project_relation%'").all()).toEqual([]);
    });
  });

  it("the two pull entries mirror SYNC_TABLES verbatim and sit at the array end, kinds first", async () => {
    const { BOOT_SYNC_PULL_TABLES } = await import("../lib/brain-db.js");
    // The brain's SYNC_TABLES is read as SOURCE (zero cross-package imports):
    // each entry's `columns` / `syncKey` literal must equal the CLI mirror's.
    const syncTs = readFileSync(join(__dirname, "..", "..", "..", "brain-mcp-server", "src", "tools", "sync.ts"), "utf-8");
    const brainEntry = (table: string, field: "columns" | "syncKey"): string[] => {
      const at = syncTs.indexOf(`table: '${table}',`);
      expect(at, table).toBeGreaterThan(-1);
      const block = syncTs.slice(at, syncTs.indexOf("\n  },", at));
      const m = new RegExp(`${field}: \\[([^\\]]*)\\]`).exec(block);
      expect(m, `${table}.${field}`).not.toBeNull();
      return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    const tail = BOOT_SYNC_PULL_TABLES.slice(-2);
    expect(tail.map((t) => t.table)).toEqual(["project_relation_kinds", "project_relations"]);
    for (const t of tail) {
      expect(t.columns, t.table).toEqual(brainEntry(t.table, "columns"));
      expect(t.syncKey, t.table).toEqual(brainEntry(t.table, "syncKey"));
      expect(t.strategy).toBe("lww");
      expect(t.timestampCol).toBe("updated_at");
    }
    expect(tail[0].syncKey).toEqual(["name"]);
    expect(tail[0].mergeFields).toEqual({ aliases: "merge_tags" });
    expect(tail[1].syncKey).toEqual(["from_slug", "kind", "to_slug"]);
    expect(tail[1].columns).toContain("removed_at");
  });
});
