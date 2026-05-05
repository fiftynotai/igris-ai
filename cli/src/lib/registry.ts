/**
 * Wraps direct `better-sqlite3` access to the brain's `projects` table.
 *
 * D-4 architect default: direct DB access, NOT through MCP. Mirrors the
 * inline-python pattern in `igris_install.sh:441-459`.
 *
 * The DB is opened lazily and the same handle is reused per-process (tests
 * call `closeDb()` between test cases to swap in a different IGRIS_BRAIN_DIR).
 *
 * `IGRIS_BRAIN_DIR` env override is honored via `paths.brainDbPath()`.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { brainDbPath } from "./paths.js";
import type { RegistryRow } from "../types.js";

let db: Database.Database | null = null;
let dbPath: string | null = null;

/**
 * Open (or return cached) DB handle. Creates the projects table if missing
 * — important for in-memory test DBs and brand-new sandboxed brain dirs.
 */
function getDb(): Database.Database {
  const path = brainDbPath();
  if (db !== null && dbPath === path) return db;
  if (db !== null) {
    // Path changed (test sandbox swap). Close old handle.
    db.close();
    db = null;
  }

  // Make sure the parent dir exists for new sandboxes.
  const parent = dirname(path);
  if (path !== ":memory:" && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }

  db = new Database(path);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");

  // Idempotent create. Schema mirrors the columns used by igris_install.sh.
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      tech_stack TEXT,
      igris_version TEXT,
      status TEXT DEFAULT 'active',
      registered_at TEXT,
      last_session_at TEXT,
      metadata TEXT
    );
  `);

  dbPath = path;
  return db;
}

/** Close the cached DB handle. Used by tests + main CLI cleanup. */
export function closeDb(): void {
  if (db !== null) {
    db.close();
    db = null;
    dbPath = null;
  }
}

/** List every row in the `projects` table, in slug order. */
export function listProjects(): RegistryRow[] {
  const handle = getDb();
  const rows = handle
    .prepare(
      "SELECT slug, name, path, COALESCE(tech_stack, '') AS tech_stack, COALESCE(igris_version, '') AS igris_version, COALESCE(status, 'active') AS status, COALESCE(registered_at, '') AS registered_at, COALESCE(last_session_at, '') AS last_session_at FROM projects ORDER BY slug",
    )
    .all();
  return rows as RegistryRow[];
}

/** Insert or update a row. Mirrors the SQL in igris_install.sh:441-459. */
export function upsertProject(input: {
  slug: string;
  name: string;
  path: string;
  tech_stack: string;
  igris_version: string;
}): void {
  const handle = getDb();
  const now = new Date().toISOString();
  handle
    .prepare(
      `INSERT INTO projects (slug, name, path, tech_stack, igris_version, status, registered_at, last_session_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name,
         path = excluded.path,
         tech_stack = excluded.tech_stack,
         igris_version = excluded.igris_version,
         last_session_at = excluded.last_session_at`,
    )
    .run(
      input.slug,
      input.name,
      input.path,
      input.tech_stack,
      input.igris_version,
      now,
      now,
    );
}

/** Delete a row by slug. Used by `doctor --remove-orphans`. */
export function deleteProjectRow(slug: string): void {
  const handle = getDb();
  handle.prepare("DELETE FROM projects WHERE slug = ?").run(slug);
}
