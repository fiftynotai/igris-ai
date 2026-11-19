/**
 * FR-274 D1.5 — the knowledge watermark is LOCAL-ONLY, and a pull cannot blank it.
 *
 * `projects.knowledge_sha` / `knowledge_branch` / `knowledge_recorded_at` are
 * deliberately absent from `SYNC_TABLES` and from `BOOT_SYNC_PULL_TABLES`
 * (FR-274 D1: replicating them is FR-271's single remote-first deploy, with a
 * NULL-preserving LWW rule). Both LWW UPDATE arms write `normRow[col] ?? null`
 * for every CONFIGURED column, so the moment the columns join the pull config a
 * pulled row that lacks them (every remote today) writes NULL over a recorded
 * watermark.
 *
 * This file drives the REAL `mergePulledTables` over the REAL
 * `BOOT_SYNC_PULL_TABLES` against a real tmp brain DB: a local row carrying a
 * watermark receives a pulled `projects` row with a NEWER `last_session_at` and
 * no `knowledge_*` keys. LWW applies (name and path move) and the triple is
 * unchanged.
 *
 * A CHARACTERIZATION pin — green on arrival by design. It bites under mutation
 * M6 (add the three columns to the `projects` pull config); FR-271 must flip it
 * deliberately, together with the NULL-preserving merge rule.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fenceHome, type HomeFence } from "./home-fence.js";

const REMOTE = "http://remote.invalid";

/** Brain core CREATE (brain-mcp-server/src/db.ts) + projects:1 + projects:2, verbatim. */
const SCHEMA = `
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
  ALTER TABLE projects ADD COLUMN knowledge_sha TEXT;
  ALTER TABLE projects ADD COLUMN knowledge_branch TEXT;
  ALTER TABLE projects ADD COLUMN knowledge_recorded_at TEXT;
  CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT, remote_url TEXT NOT NULL,
    table_name TEXT NOT NULL, last_push_at TEXT, last_pull_at TEXT,
    UNIQUE(remote_url, table_name)
  );
`;

let fence: HomeFence;
let dbFile: string;

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(dbFile);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  fence = fenceHome("igris-fr274-pull-");
  mkdirSync(join(fence.brainDir, "memory"), { recursive: true });
  dbFile = join(fence.brainDir, "memory", "knowledge.db");
  withDb((db) => db.exec(SCHEMA));
});

afterEach(async () => {
  (await import("../lib/brain-db.js")).closeDb();
  fence.release();
});

describe("a pulled projects row never blanks the local knowledge watermark (FR-274 D1.5, M6)", () => {
  it("the watermark columns are in NEITHER pull config column list (the mechanism)", async () => {
    const { BOOT_SYNC_PULL_TABLES, EXPORT_TABLES } = await import("../lib/brain-db.js");
    const all = [...BOOT_SYNC_PULL_TABLES, ...EXPORT_TABLES].flatMap((c) => c.columns);
    expect(all.filter((c) => c.startsWith("knowledge_"))).toEqual([]);
  });

  it("LWW applies (name, path move) and the triple is unchanged", async () => {
    fence.assertArmed();
    const localPath = mkdtempSync(join(fence.home, "local-"));
    const remotePath = mkdtempSync(join(fence.home, "remote-"));
    withDb((db) => db.prepare(
      `INSERT INTO projects (slug, name, path, last_session_at, knowledge_sha, knowledge_branch, knowledge_recorded_at)
       VALUES ('wm', 'Local Name', ?, '2026-01-01 00:00:00', ?, 'main', '2026-09-29 10:00:00')`,
    ).run(localPath, "f".repeat(40)));

    const { mergePulledTables } = await import("../lib/brain-db.js");
    const summary = mergePulledTables(REMOTE, {
      projects: [{
        slug: "wm",
        name: "Remote Name",
        path: remotePath,
        tech_stack: "",
        archetype: "unclassified",
        igris_version: "7.3.2",
        status: "active",
        registered_at: "2026-01-01 00:00:00",
        last_session_at: "2026-09-29 12:00:00", // NEWER — LWW takes the remote row
        metadata: "{}",
      }],
    });
    expect(summary.perTable.projects).toMatchObject({ updated: 1, failed: 0 });

    const row = withDb((db) => db.prepare("SELECT * FROM projects WHERE slug = 'wm'").get() as Record<string, unknown>);
    expect(row.name).toBe("Remote Name"); // the merge really applied
    expect(row.path).toBe(remotePath);
    expect({
      knowledge_sha: row.knowledge_sha,
      knowledge_branch: row.knowledge_branch,
      knowledge_recorded_at: row.knowledge_recorded_at,
    }).toEqual({ knowledge_sha: "f".repeat(40), knowledge_branch: "main", knowledge_recorded_at: "2026-09-29 10:00:00" });
  });
});
