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
 *
 * TWO DOORS SINCE TD-319 — AND `getDb()` IS STILL THE WRITER'S
 * ---------------------------------------------------------------
 * `getDb()` opens read-WRITE, sets `journal_mode = WAL` and runs
 * `CREATE TABLE IF NOT EXISTS projects`. That is CORRECT for this module's
 * owner role: `igris register` (`upsertProject`), `igris doctor
 * --remove-orphans` (`deleteProjectRow`) and `igris init`
 * (`verbs/init.ts#ensureDbOpen`, which calls `listProjects()` PURELY for the
 * schema side effect) all depend on it. It is left exactly as it was.
 *
 * What TD-319 adds is a SECOND door for pure readers:
 * {@link listProjectsReadonly}, which opens through
 * `brain-bridge.ts#openBrainReadonly` (`{readonly: true}` + `query_only = ON`)
 * and preflights the table instead of creating it. The dashboard tier uses it
 * so a GET can no longer flip an operator's `journal_mode` or run DDL.
 *
 * PICKING THE WRONG ONE IS A REAL MISTAKE IN BOTH DIRECTIONS: a writer on the
 * read door gets `SQLITE_READONLY`; a read on the write door silently
 * re-writes the `.db` header of a `delete`-mode brain.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openBrainReadonly } from "./brain-bridge.js";
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

/**
 * The `projects` projection, defined ONCE.
 *
 * Both doors run this exact statement, so the read-only path cannot drift into
 * answering a different question from the writer's path — the failure mode a
 * hand-copied second SELECT would have.
 */
const PROJECTS_SELECT =
  "SELECT slug, name, path, COALESCE(tech_stack, '') AS tech_stack, COALESCE(igris_version, '') AS igris_version, COALESCE(status, 'active') AS status, COALESCE(registered_at, '') AS registered_at, COALESCE(last_session_at, '') AS last_session_at FROM projects ORDER BY slug";

function selectProjects(handle: Database.Database): RegistryRow[] {
  return handle.prepare(PROJECTS_SELECT).all() as RegistryRow[];
}

/**
 * True when the named table exists. Used ONLY by the read-only door, which must
 * not create what it cannot find (the L-133 preflight `brain-db.ts` already
 * uses); `getDb()` keeps its `CREATE TABLE IF NOT EXISTS`.
 */
function tableExists(handle: Database.Database, name: string): boolean {
  const row = handle
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/**
 * List every row in the `projects` table, in slug order.
 *
 * THE WRITE DOOR. Opens read-WRITE via {@link getDb} and therefore also sets
 * `journal_mode = WAL` and creates the table when absent. `verbs/init.ts`
 * depends on exactly that side effect. A pure reader wants
 * {@link listProjectsReadonly} instead.
 */
export function listProjects(): RegistryRow[] {
  return selectProjects(getDb());
}

/**
 * List every row in the `projects` table through a READ-ONLY connection.
 *
 * TD-319. Same projection, same order, same rows — a different DOOR:
 *
 *  - the handle comes from `brain-bridge.ts#openBrainReadonly`, which opens
 *    `{readonly: true, fileMustExist: true}` and arms `query_only = ON` (and
 *    arms it again on its R4 read-write fallback), so a write reaching this
 *    connection throws instead of landing;
 *  - the `projects` table is PREFLIGHTED, never created. A brain that predates
 *    the table reads as an empty registry, which is the same answer the write
 *    door produced — it just no longer runs `CREATE TABLE` to get there;
 *  - an absent brain file yields `[]` rather than a materialised 20 KB SQLite
 *    database (`openBrainReadonly` returns null; `fileMustExist` is what makes
 *    that structural rather than a check this function could forget);
 *  - the handle is opened and closed PER CALL, so nothing is cached across a
 *    `closeDb()` boundary and a concurrent `/hunt` write is visible on the next
 *    read.
 *
 * WHAT THE PRAGMA DOES AND DOES NOT BUY, MEASURED (better-sqlite3 11 / darwin):
 * on the `{readonly: true}` branch both `PRAGMA journal_mode = WAL` and a
 * `CREATE TABLE` throw `attempt to write a readonly database`. On the R4
 * read-write fallback `query_only = ON` still refuses the DDL and every row
 * write, but it does NOT refuse a journal-mode change — so "this path leaves
 * `journal_mode` alone" rests on the pragma there and on this path never
 * ISSUING that statement. Both halves are pinned by
 * `dashboard-readonly.test.ts` G-RO-5.
 */
export function listProjectsReadonly(): RegistryRow[] {
  const handle = openBrainReadonly();
  if (handle === null) return [];
  try {
    if (!tableExists(handle, "projects")) return [];
    return selectProjects(handle);
  } finally {
    try {
      handle.close();
    } catch {
      /* already closed — nothing to do */
    }
  }
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

/**
 * The outcome of ONE attempted `projects` delete. Mirrors FR-241 D6's
 * `TriageItemResult`: the unit of reporting is the item, not the batch, and a
 * failure carries the engine's own words rather than a vocabulary invented here.
 */
export interface DeleteProjectOutcome {
  slug: string;
  ok: boolean;
  /** Operator-facing reason when `ok` is false; `null` on success. */
  error: string | null;
}

/**
 * Every table whose FK points at `projects(slug)`, DERIVED from the live schema
 * rather than hand-listed — at the time of writing that is `brief_status` and
 * `sessions` (`brain-mcp-server/src/db.ts:307` and `:290` respectively — note
 * the order: `:290` is the `sessions` FK and `:307` is `brief_status`'s), and a third one added later
 * must not need an edit here to be named correctly in a skip reason.
 *
 * Returns `[]` on any failure (a bare sandbox brain whose DB carries only the
 * `projects` table getDb() creates, an old SQLite without the pragma-function
 * syntax). Callers treat an empty list as "could not attribute" and fall back to
 * the verbatim SQLite message — never as "nothing references it", which would be
 * a claim this query did not establish.
 */
function referencingTables(
  handle: Database.Database,
): Array<{ tbl: string; col: string }> {
  try {
    return handle
      .prepare(
        `SELECT m.name AS tbl, f."from" AS col
           FROM sqlite_master m
           JOIN pragma_foreign_key_list(m.name) f
          WHERE m.type = 'table' AND f."table" = 'projects'`,
      )
      .all() as Array<{ tbl: string; col: string }>;
  } catch {
    return [];
  }
}

/**
 * Name the dependents that blocked a delete, e.g. `3 brief_status row(s)`.
 *
 * The count is what makes the skip actionable — "FOREIGN KEY constraint failed"
 * does not tell an operator WHICH rows to deal with. A table that contributes
 * ZERO rows is omitted: `sessions` and `brief_status` both reference
 * `projects(slug)`, so a project with 0 briefs and 1 session is a REACHABLE
 * failure, and "still referenced by 0 brief(s)" would be a false statement of a
 * true failure.
 */
function describeDependents(
  handle: Database.Database,
  slug: string,
): string | null {
  const parts: string[] = [];
  for (const { tbl, col } of referencingTables(handle)) {
    try {
      const row = handle
        .prepare(`SELECT COUNT(*) AS n FROM "${tbl}" WHERE "${col}" = ?`)
        .get(slug) as { n?: unknown } | undefined;
      const n = row?.n;
      if (typeof n === "number" && n > 0) parts.push(`${n} ${tbl} row(s)`);
    } catch {
      // Table named by the schema but unreadable — skip it rather than let a
      // diagnostic failure become the reported cause.
    }
  }
  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * Delete a row by slug. Used by `igris doctor --remove-orphans`.
 *
 * DOES NOT THROW (BR-084). `brief_status.project` and `sessions.project` both
 * carry a live FK to `projects(slug)`, and better-sqlite3's bundled SQLite is
 * compiled with `SQLITE_DEFAULT_FOREIGN_KEYS=1`, so this DELETE is BLOCKED for
 * any project that still has briefs or sessions. Refusing is the SAFE direction
 * — an orphaned `brief_status` row would be worse — but the throw used to escape
 * `confirmAndRemoveOrphans` and abort the WHOLE sweep, so one reachable input
 * took down the cleanup of every OTHER orphan that would have deleted cleanly.
 *
 * The FR-241 D6 posture instead: the failure is a RESULT for this slug, never an
 * outcome for the batch. The caller reports removed / skipped-with-reason per
 * project and keeps going.
 *
 * Deliberately NOT cascading. Deleting the dependents would destroy brief
 * history, which is not an action a `doctor` verb should take on a registry
 * cleanup — see the decision note in `verbs/doctor.ts#confirmAndRemoveOrphans`.
 */
export function deleteProjectRow(slug: string): DeleteProjectOutcome {
  const handle = getDb();
  try {
    handle.prepare("DELETE FROM projects WHERE slug = ?").run(slug);
    return { slug, ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      const dependents = describeDependents(handle, slug);
      return {
        slug,
        ok: false,
        error:
          dependents === null
            ? `${message} — a dependent row still references this project; registry row kept`
            : `still referenced by ${dependents}; registry row kept (deleting it would orphan them)`,
      };
    }
    // Anything else (locked DB, readonly file, ...) is reported verbatim: the
    // sweep must not translate a cause it does not understand.
    return { slug, ok: false, error: message };
  }
}
