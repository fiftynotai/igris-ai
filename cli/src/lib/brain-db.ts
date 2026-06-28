/**
 * FR-195 (M1) — read-mostly local-DB accessor for the brain's session/instance
 * tables.
 *
 * The symmetric counterpart to `registry.ts` (which owns + creates its
 * `projects` table). Here the **brain owns the schema** — the sessions
 * component (`brain-mcp-server/src/engine/components/sessions/schema.ts`) and
 * the instances migration (`brain-mcp-server/src/db.ts:328`) create these
 * tables. So this module is **create-never**: it preflights table existence
 * (the L-133 pattern already in `handleSessionFileList`) and treats a missing
 * table as "empty" rather than migrating schema the brain owns. A CLI run at
 * a cold boot must never mutate the brain's schema.
 *
 * Channel discipline (L-246): this is the **LOCAL** channel — it opens
 * `brainDbPath()` directly with `better-sqlite3`, never a VPS round-trip. The
 * VPS reads/writes go through the remote channel (`mcp-client.ts`), used by
 * `boot-sync` (M3). The whole point of this module is that a local read at
 * awaken needs no MCP session and no network.
 *
 * Why reproduce the handler SQL rather than import the brain handlers: `cli/`
 * and `brain-mcp-server/` are separate npm packages with zero cross-imports;
 * the handlers return MCP envelopes and drag the brain's own `getDb()` +
 * migration machinery. The codebase already made the "reproduce the SQL"
 * choice for the `projects` table (`registry.ts`). The FR-186 MAINTAINING.md
 * rows pin the column contracts so a future brain-side schema change sweeps
 * this copy too. SQL is copied verbatim from the cited handler line numbers.
 *
 * Lazy-handle shape, WAL, busy_timeout, and the IGRIS_BRAIN_DIR sandbox seam
 * all mirror `registry.ts` (#11) — tests call `closeDb()` between cases to
 * swap in a different sandboxed DB.
 */

import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { brainDbPath } from "./paths.js";
import type {
  SessionFileRow,
  InstanceRow,
  AssessBriefs,
  AssessGoal,
  ProjectProfile,
  ProjectProfileResult,
} from "../types.js";

let db: Database.Database | null = null;
let dbPath: string | null = null;

/**
 * Open (or return the cached) brain-DB handle.
 *
 * UNLIKE `registry.ts#getDb`, this performs NO `CREATE TABLE` — the brain owns
 * the session/instance schema (create-never; see module header). The handle is
 * cached per `brainDbPath()`; a path change (test sandbox swap) closes the old
 * handle first. WAL + `busy_timeout=5000` match `registry.ts` (#11).
 */
function getDb(): Database.Database {
  const path = brainDbPath();
  if (db !== null && dbPath === path) return db;
  if (db !== null) {
    // Path changed (test sandbox swap). Close old handle.
    db.close();
    db = null;
  }

  // Make sure the parent dir exists for new sandboxes (the brain DB file
  // itself is created empty by better-sqlite3 if absent — but we never run
  // DDL, so an empty file just yields empty reads via the table preflight).
  const parent = dirname(path);
  if (path !== ":memory:" && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }

  db = new Database(path);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");

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
 * Return true when the named table exists in the brain DB.
 *
 * The L-133 preflight (verbatim shape from `handleSessionFileList`
 * `brain-mcp-server/src/tools/sessions.ts:316-318`): on a brain DB where the
 * relevant migration never ran, callers return an empty result rather than
 * throwing — and crucially never run DDL to create the missing table.
 */
function tableExists(handle: Database.Database, name: string): boolean {
  const row = handle
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function tableColumns(handle: Database.Database, name: string): Set<string> {
  const rows = handle.prepare(`PRAGMA table_info(${name})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

function optionalProjection(
  columns: ReadonlySet<string>,
  name: string,
  fallback = "NULL",
): string {
  return columns.has(name) ? name : `${fallback} AS ${name}`;
}

/**
 * Read the local project profile row used by `context-docs inventory`.
 *
 * Read-only and create-never: an absent DB, absent `projects` table, absent
 * row, or older schema with missing columns all degrade into a partial/null
 * profile rather than throwing or running DDL. Unlike most accessors in this
 * module, this checks the DB file before opening it so a fresh sandbox does
 * not get a newly-created empty DB just because inventory ran.
 */
export function readProjectProfile(slug: string): ProjectProfileResult {
  if (!existsSync(brainDbPath())) {
    return { degraded: true, profile: null };
  }

  const handle = getDb();
  if (!tableExists(handle, "projects")) {
    return { degraded: true, profile: null };
  }

  const columns = tableColumns(handle, "projects");
  if (!columns.has("slug")) {
    return { degraded: true, profile: null };
  }

  const projections = ["slug"];
  if (columns.has("path")) projections.push("path");
  if (columns.has("archetype")) projections.push("archetype");
  if (columns.has("tech_stack")) projections.push("tech_stack");

  const row = handle
    .prepare(`SELECT ${projections.join(", ")} FROM projects WHERE slug = ?`)
    .get(slug) as
    | {
        slug: string;
        path?: string | null;
        archetype?: string | null;
        tech_stack?: string | null;
      }
    | undefined;

  if (row === undefined) {
    return { degraded: true, profile: null };
  }

  const profile: ProjectProfile = {
    slug: row.slug,
    path: row.path ?? null,
    archetype: row.archetype ?? null,
    tech_stack: row.tech_stack ?? null,
  };
  return {
    degraded:
      !columns.has("path") ||
      !columns.has("archetype") ||
      !columns.has("tech_stack"),
    profile,
  };
}

/**
 * List session files for a project, ordered newest-first.
 *
 * Reproduces `handleSessionFileList`
 * (`brain-mcp-server/src/tools/sessions.ts:302-361`): the L-133 table-existence
 * preflight returns `[]` (not a throw) when `session_files` is absent, and the
 * SELECT projects metadata only (no `content`) ordered by `updated_at DESC`.
 * No `state` filter is applied here — gather wants every state and classifies
 * each row itself (SKILL.md §2 G1). Read-only: never writes, never migrates.
 */
export function listSessionFiles(slug: string): SessionFileRow[] {
  const handle = getDb();

  // L-133 preflight — empty list, not a throw, on a DB missing the table.
  if (!tableExists(handle, "session_files")) {
    return [];
  }

  // SQL verbatim from handleSessionFileList:329-341 (sans the state filter —
  // gather enumerates all states; the `ORDER BY updated_at DESC` is preserved
  // so G3's "most-recent genuine handoff" selection is consistent).
  const rows = handle
    .prepare(
      `
      SELECT filename, instance_id, state, content_hash, updated_at
      FROM session_files
      WHERE project = ?
      ORDER BY updated_at DESC
    `,
    )
    .all(slug) as SessionFileRow[];

  return rows;
}

/**
 * Fetch a single session file's content by project + filename.
 *
 * Reproduces `handleSessionFileGet`
 * (`brain-mcp-server/src/tools/sessions.ts:176-223`): the SELECT projects
 * `content` (+ metadata) for THE chosen handoff only — the "fetch content
 * only for the chosen one" optimization (SKILL.md §2 G3). Returns null when
 * the row (or the table) is absent. Read-only.
 */
export function getSessionFileContent(
  slug: string,
  filename: string,
): string | null {
  const handle = getDb();

  if (!tableExists(handle, "session_files")) {
    return null;
  }

  // SQL verbatim from handleSessionFileGet:188-198 (content projection).
  const row = handle
    .prepare(
      `
      SELECT content, content_hash, updated_at, instance_id, state
      FROM session_files
      WHERE project = ? AND filename = ?
    `,
    )
    .get(slug, filename) as { content: string } | undefined;

  return row ? row.content : null;
}

/** Filter args for {@link listInstances}. */
export interface ListInstancesArgs {
  /** Project-slug filter (`instances.project_slug = ?`). */
  project?: string;
  /**
   * Status filter. `'all'` (or omitted) returns every non-stale row; a
   * concrete value (e.g. `'active'`) adds `status = ?`. Matches the
   * `handleInstanceList` semantics.
   */
  status?: string;
  /** When true, stale rows are NOT excluded (default excludes them). */
  includeStale?: boolean;
}

/**
 * List instances without treating heartbeat age as liveness.
 *
 * FR-190 deliberately removes the old list-time side effects that purged rows
 * older than 240 minutes and marked rows stale after 45 minutes. A heartbeat is
 * only last activity, not liveness; normal reads must not delete the evidence
 * needed to explain or reclaim a crashed instance. Cleanup belongs in an
 * explicit housekeeping path, not this ordinary read.
 */
export function listInstances(args: ListInstancesArgs = {}): InstanceRow[] {
  const handle = getDb();

  // L-133-style preflight — a brain DB without the instances migration (v4)
  // yields an empty registry, never a throw, never a CREATE.
  if (!tableExists(handle, "instances")) {
    return [];
  }
  const columns = tableColumns(handle, "instances");

  // Dynamic WHERE — verbatim shape from handleInstanceList:140-157.
  const conditions: string[] = [];
  const params: string[] = [];

  // By default, exclude stale instances unless explicitly requested.
  if (!args.includeStale) {
    conditions.push("status != 'stale'");
  }
  if (args.status && args.status !== "all") {
    conditions.push("status = ?");
    params.push(args.status);
  }
  if (args.project) {
    conditions.push("project_slug = ?");
    params.push(args.project);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = handle
    .prepare(
      `
      SELECT id, machine_hostname, machine_os, project_slug, current_brief,
             current_phase, current_task, status, last_heartbeat_at,
             ${optionalProjection(columns, "harness")},
             ${optionalProjection(columns, "harness_session_id")},
             ${optionalProjection(columns, "owner_pid")},
             ${optionalProjection(columns, "owner_started_at")},
             ${optionalProjection(columns, "liveness_method")},
             ${optionalProjection(columns, "liveness_status")},
             ${optionalProjection(columns, "liveness_checked_at")},
             ${optionalProjection(columns, "lease_expires_at")},
             ${optionalProjection(columns, "state_updated_at")}
      FROM instances
      ${whereClause}
      ORDER BY last_heartbeat_at DESC
    `,
    )
    .all(...params) as InstanceRow[];

  return rows;
}

/**
 * Raised by a WRITE accessor when the brain DB is present but the target table
 * was never migrated. The verbs (`session register`) gate on `caps.brain_db`,
 * so a present brain DB has run its migrations and this should not fire in
 * practice — but a write must NEVER silently no-op (the symmetric opposite of
 * the read accessors' "missing table → empty"): a writer that found no table
 * is a real degradation the caller surfaces, NOT a CREATE-TABLE (create-never).
 */
export class BrainTableMissingError extends Error {
  constructor(table: string) {
    super(
      `brain-db: table '${table}' is absent — refusing to write (create-never; the brain owns this schema)`,
    );
    this.name = "BrainTableMissingError";
  }
}

/** Input for {@link heartbeat} — mirrors `InstanceHeartbeatInput` (the subset the awaken path passes). */
export interface HeartbeatInput {
  /** Recovered prior id (gather G4) → refresh; omit → mint a fresh UUID. */
  instance_id?: string;
  machine_hostname: string;
  machine_os?: string | null;
  project_slug?: string | null;
  project_path?: string | null;
  current_brief?: string | null;
  current_phase?: string | null;
  current_task?: string | null;
  harness?: string | null;
  harness_session_id?: string | null;
  owner_pid?: number | null;
  owner_started_at?: string | null;
  liveness_method?: string | null;
  liveness_status?: string | null;
  liveness_checked_at?: string | null;
  lease_expires_at?: string | null;
}

/** Result of a {@link heartbeat} upsert. */
export interface HeartbeatResult {
  instance_id: string;
  /** True when a fresh UUID was minted (no prior id supplied); false on recover/refresh. */
  minted: boolean;
}

/**
 * Mint-or-recover an instance via the upsert.
 *
 * The old name remains for call-site stability, but FR-190 narrows the
 * semantics: this writes instance lifecycle/state metadata. It does not prove
 * liveness; liveness comes from PID/start-time checks on same-machine rows and
 * lease/claim state for cross-machine coordination.
 *
 * The `agent_capabilities` upsert side-table the brain handler does
 * (instances.ts:87-102) is OMITTED: capabilities are not part of the awaken
 * register contract and `agent_capabilities` is not a table M2 seeds (#287).
 *
 * `minted` follows the handler's own action discrimination
 * (instances.ts:84): a fresh UUID (no `instance_id` supplied) is a mint; a
 * supplied id is a recover/refresh.
 */
export function heartbeat(input: HeartbeatInput): HeartbeatResult {
  const handle = getDb();

  // create-never: a present brain DB has migrated `instances`; a writer must
  // not CREATE it. If somehow absent, surface a typed error (the verb degrades).
  if (!tableExists(handle, "instances")) {
    throw new BrainTableMissingError("instances");
  }
  const columns = tableColumns(handle, "instances");

  // randomUUID when no id supplied (instances.ts:58). The mint flag keys on
  // whether the CALLER supplied an id, not on result.changes (a recovered id
  // for a row purged by listInstances would also "insert", but it is still a
  // recover from the awaken contract's point of view).
  const minted = input.instance_id === undefined;
  const instanceId = input.instance_id ?? randomUUID();

  const insertColumns = [
    "id",
    "machine_hostname",
    "machine_os",
    "project_slug",
    "project_path",
    "current_brief",
    "current_phase",
    "current_task",
    "status",
    "last_heartbeat_at",
  ];
  const values: unknown[] = [
    instanceId,
    input.machine_hostname,
    input.machine_os ?? null,
    input.project_slug ?? null,
    input.project_path ?? null,
    input.current_brief ?? null,
    input.current_phase ?? null,
    input.current_task ?? null,
    "active",
    new Date().toISOString().replace("T", " ").substring(0, 19),
  ];
  const updates = [
    "machine_hostname = excluded.machine_hostname",
    "machine_os = excluded.machine_os",
    "project_slug = excluded.project_slug",
    "project_path = excluded.project_path",
    "current_brief = excluded.current_brief",
    "current_phase = excluded.current_phase",
    "current_task = excluded.current_task",
    "status = 'active'",
    "last_heartbeat_at = excluded.last_heartbeat_at",
  ];

  const optionalInputs: Array<[string, unknown]> = [
    ["harness", input.harness ?? null],
    ["harness_session_id", input.harness_session_id ?? null],
    ["owner_pid", input.owner_pid ?? null],
    ["owner_started_at", input.owner_started_at ?? null],
    ["liveness_method", input.liveness_method ?? null],
    ["liveness_status", input.liveness_status ?? null],
    ["liveness_checked_at", input.liveness_checked_at ?? null],
    ["lease_expires_at", input.lease_expires_at ?? null],
    [
      "state_updated_at",
      new Date().toISOString().replace("T", " ").substring(0, 19),
    ],
  ];
  for (const [name, value] of optionalInputs) {
    if (!columns.has(name)) continue;
    insertColumns.push(name);
    values.push(value);
    updates.push(`${name} = excluded.${name}`);
  }

  handle
    .prepare(
      `
      INSERT INTO instances (${insertColumns.join(", ")})
      VALUES (${insertColumns.map(() => "?").join(", ")})
      ON CONFLICT(id) DO UPDATE SET
        ${updates.join(",\n        ")}
    `,
    )
    .run(...values);

  return { instance_id: instanceId, minted };
}

export interface InstanceStateUpdateInput {
  instance_id: string;
  project_slug?: string | null;
  current_brief?: string | null;
  current_phase?: string | null;
  current_task?: string | null;
  lease_expires_at?: string | null;
  status?: "active" | "idle" | "stale";
}

export function instanceStateUpdate(input: InstanceStateUpdateInput): boolean {
  const handle = getDb();
  if (!tableExists(handle, "instances")) {
    throw new BrainTableMissingError("instances");
  }
  const columns = tableColumns(handle, "instances");
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const [name, value] of [
    ["project_slug", input.project_slug],
    ["current_brief", input.current_brief],
    ["current_phase", input.current_phase],
    ["current_task", input.current_task],
    ["status", input.status],
    ["lease_expires_at", input.lease_expires_at],
  ] as Array<[string, unknown]>) {
    if (value === undefined || !columns.has(name)) continue;
    sets.push(`${name} = ?`);
    values.push(value);
  }

  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  if (columns.has("state_updated_at")) {
    sets.push("state_updated_at = ?");
    values.push(now);
  }
  if (columns.has("last_heartbeat_at")) {
    sets.push("last_heartbeat_at = ?");
    values.push(now);
  }
  if (sets.length === 0) return false;
  values.push(input.instance_id);
  const result = handle
    .prepare(`UPDATE instances SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
  return result.changes > 0;
}

export function instanceRemove(instanceId: string): boolean {
  const handle = getDb();
  if (!tableExists(handle, "instances")) {
    throw new BrainTableMissingError("instances");
  }
  const result = handle.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
  return result.changes > 0;
}

/** Input for {@link sessionFileUpsert} — mirrors `SessionFileUpdateInput`. */
export interface SessionFileUpsertInput {
  project: string;
  filename: string;
  content: string;
  /** Owning instance UUID (omit → COALESCE leaves an existing row's id untouched). */
  instance_id?: string | null;
  /** Lifecycle state (omit → COALESCE leaves an existing row's state untouched; 'live' on a fresh row). */
  state?: "live" | "rested" | "archived" | null;
}

/**
 * Upsert a session file with the brain's COALESCE semantics.
 *
 * Reproduces `handleSessionFileUpdate`
 * (`brain-mcp-server/src/tools/sessions.ts:234-272`) — INCLUDING the #230 /
 * FR-130 non-destructive contract that is the entire reason this is CODE and
 * not a recipe:
 *   - a fresh row's `state` falls back to 'live' via `COALESCE(?, 'live')`
 *     (sessions.ts:265) so a content-only write still lands a valid state;
 *   - on conflict, `instance_id = COALESCE(excluded.instance_id,
 *     session_files.instance_id)` (sessions.ts:270) and `state = COALESCE(?,
 *     session_files.state)` (sessions.ts:271) — an OMITTED instance_id/state
 *     must NEVER null/downgrade an existing row. The `state` arg is bound
 *     TWICE for exactly this reason (sessions.ts:272 + its comment 255-259):
 *     once for the INSERT value (NULL→'live') and once raw in the conflict
 *     clause (NULL→leave existing). The two bind sites need the NULL-vs-'live'
 *     distinction, so they cannot share a value.
 * content_hash = sha256(content) (sessions.ts:245); the id is a fresh UUID for
 * the INSERT branch (ignored on conflict; sessions.ts:246). `updated_at` uses
 * the handler's `new Date().toISOString()...substring(0,19)` shape
 * (sessions.ts:247) so the column format matches the brain's own writes.
 */
export function sessionFileUpsert(input: SessionFileUpsertInput): void {
  const handle = getDb();

  if (!tableExists(handle, "session_files")) {
    throw new BrainTableMissingError("session_files");
  }

  // Verbatim from handleSessionFileUpdate:245-261.
  const contentHash = createHash("sha256").update(input.content).digest("hex");
  const id = randomUUID();
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  const instanceId = input.instance_id ?? null;
  const stateArg = input.state ?? null;

  // SQL verbatim from handleSessionFileUpdate:263-272 — the COALESCE clauses
  // are the non-destructive contract; stateArg is bound twice (INSERT value +
  // conflict clause).
  handle
    .prepare(
      `
      INSERT INTO session_files (id, project, filename, content, content_hash, updated_at, instance_id, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'live'))
      ON CONFLICT(project, filename) DO UPDATE SET
        content = excluded.content,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at,
        instance_id = COALESCE(excluded.instance_id, session_files.instance_id),
        state = COALESCE(?, session_files.state)
    `,
    )
    .run(
      id,
      input.project,
      input.filename,
      input.content,
      contentHash,
      now,
      instanceId,
      stateArg,
      stateArg,
    );
}

/**
 * Summarise brief_status for a project — the summary-only projection.
 *
 * Reproduces the `summary_only` branch of `handleBriefDashboard`
 * (`brain-mcp-server/src/tools/briefs.ts:205-234`): the two GROUP-BY counts
 * (by status, then by priority) filtered by PROJECT ONLY (the handler applies
 * the project filter to the summary, never the status filter; briefs.ts:196-203),
 * plus the total derived by summing the status counts (briefs.ts:237). This is
 * NOT the full brief table (briefs.ts:266-281) — D-A / SKILL.md §4 want only the
 * aggregate counts. L-133 preflight: a brain DB without `brief_status` yields
 * an empty summary (total 0), never a throw, never a CREATE.
 */
export function briefStatusSummary(slug: string): AssessBriefs {
  const handle = getDb();

  if (!tableExists(handle, "brief_status")) {
    return { total: 0, by_status: {}, by_priority: {} };
  }

  // SQL verbatim from handleBriefDashboard:205-211 (status counts) — project
  // filter only, ORDER BY count DESC.
  const statusRows = handle
    .prepare(
      `
      SELECT status, COUNT(*) as count
      FROM brief_status
      WHERE project = ?
      GROUP BY status
      ORDER BY count DESC
    `,
    )
    .all(slug) as { status: string; count: number }[];

  // SQL verbatim from handleBriefDashboard:226-232 (priority counts).
  const priorityRows = handle
    .prepare(
      `
      SELECT priority, COUNT(*) as count
      FROM brief_status
      WHERE project = ?
      GROUP BY priority
      ORDER BY count DESC
    `,
    )
    .all(slug) as { priority: string | null; count: number }[];

  const byStatus: Record<string, number> = {};
  for (const r of statusRows) {
    byStatus[r.status] = r.count;
  }
  const byPriority: Record<string, number> = {};
  for (const r of priorityRows) {
    // Mirror the handler's "Unset" label for a null priority (briefs.ts:234).
    byPriority[r.priority ?? "Unset"] = r.count;
  }

  // Total = sum of the status counts (handleBriefDashboard:237).
  const total = statusRows.reduce((sum, r) => sum + r.count, 0);

  return { total, by_status: byStatus, by_priority: byPriority };
}

/**
 * List upcoming active goals (deadline within N days) for the assess digest.
 *
 * Reproduces the `upcoming_days` filter of `handleGoalList`
 * (`brain-mcp-server/src/engine/components/goals/handlers.ts:399-406`): the
 * narrow `deadline IS NOT NULL AND status = 'active'` +
 * `date(deadline) <= date('now', '+N days')` predicate, with the project
 * filter (handlers.ts:395) and the deadline-ASC ordering (handlers.ts:437).
 * `days` is the /awaken convention 14 (goals/index.ts:160). We project only
 * the four display fields the digest needs — NOT the full enriched row with
 * the `serving_briefs_count` entity_edges subquery (handlers.ts:426-434),
 * which is heavier than the assess summary warrants. L-133 preflight: a brain
 * DB without `goals` yields an empty list, never a throw, never a CREATE.
 */
export function upcomingGoals(slug: string, days: number): AssessGoal[] {
  const handle = getDb();

  if (!tableExists(handle, "goals")) {
    return [];
  }

  // SQL reproduces handleGoalList's upcoming_days predicate (handlers.ts:404-405)
  // + project filter (handlers.ts:395) + deadline-ASC sort (handlers.ts:437).
  // Math.floor mirrors the handler's `Math.floor(days)` (handlers.ts:405).
  const rows = handle
    .prepare(
      `
      SELECT goal_id, title, deadline, priority
      FROM goals
      WHERE project_slug = ?
        AND deadline IS NOT NULL AND status = 'active'
        AND date(deadline) <= date('now', ?)
      ORDER BY (deadline IS NULL) ASC, deadline ASC, created_at DESC
    `,
    )
    .all(slug, `+${Math.floor(days)} days`) as AssessGoal[];

  return rows;
}

// ===========================================================================
// FR-195 (M3) — boot-sync's LOCAL-side pull upsert (the #169 directionality fix)
// ===========================================================================
//
// `boot-sync` (the REMOTE channel) GETs remote rows from the VPS's
// `GET /sync/pull` endpoint and upserts them into the LOCAL brain DB here.
// This is the CLIENT-SIDE reproduction of `handleBrainPull`
// (brain-mcp-server/src/tools/sync.ts:913) — NOT a `mcpCall(remote,
// "igris_brain_pull")`, which would run the brain's pull handler on the VPS
// against the VPS's OWN db (VPS→VPS, circular; the whole reason D-B exists,
// learning #169). A CLI process has no stdio MCP server, so it reproduces the
// pull's local half: GET rows over HTTP (boot-sync.ts), merge-LWW into the
// local db (here).
//
// `mergeRows` + `mergeTags` + the table configs are ported VERBATIM from the
// brain (cited line numbers). They are duplicated across the two npm packages
// for the same reason the session/instance read SQL is — zero cross-package
// imports; the FR-186 MAINTAINING.md rows pin the column contracts so a brain-
// side change sweeps this copy. mergeRows does a manual SELECT-then-INSERT/
// UPDATE by syncKey (NOT an `ON CONFLICT` upsert) because the LWW tables'
// syncKey columns are not UNIQUE (e.g. learnings(project,category,title),
// errors(project,fingerprint) have no UNIQUE constraint) — an ON CONFLICT
// would never fire, so the manual lookup is the only correct path.

/** Config for one syncable table — verbatim from `SyncTableConfig` (sync.ts:64-71). */
export interface PullTableConfig {
  table: string;
  syncKey: string[];
  timestampCol: string;
  strategy: "lww" | "append";
  mergeFields?: Record<string, "max" | "merge_tags">;
  columns: string[];
}

/**
 * The subset of `SYNC_TABLES` (sync.ts:77-179) that `boot-sync` pulls VPS→local
 * at awaken. These are the awaken-relevant replication tables: the brain memory
 * (learnings/errors), the cross-device session files + agent/skill/rule
 * definitions, the instance registry, brief status, and project metadata.
 *
 * Each config is copied verbatim (syncKey / timestampCol / strategy /
 * mergeFields / columns) from the corresponding `SYNC_TABLES` entry. The full
 * `SYNC_TABLES` list also carries task/schedule/perception tables; those are
 * NOT awaken pull targets (they belong to the autonomous/worker subsystem,
 * disabled in v7) so boot-sync omits them — a smaller, awaken-scoped pull.
 */
export const BOOT_SYNC_PULL_TABLES: PullTableConfig[] = [
  // sync.ts:78-95
  {
    table: "learnings",
    syncKey: ["project", "category", "title"],
    timestampCol: "created_at",
    strategy: "lww",
    mergeFields: { tags: "merge_tags" },
    columns: [
      "project", "category", "title", "content", "tags", "tech_stack",
      "scope", "source_brief", "confidence", "created_at", "updated_at",
      "access_count", "last_accessed_at",
      "review_status", "provenance", "source_extractor",
    ],
  },
  // sync.ts:96-107
  {
    table: "errors",
    syncKey: ["project", "fingerprint"],
    timestampCol: "last_seen_at",
    strategy: "lww",
    mergeFields: { occurrence_count: "max" },
    columns: [
      "project", "fingerprint", "message", "solution", "context",
      "tech_stack", "scope", "occurrence_count", "first_seen_at",
      "last_seen_at", "resolved_at",
    ],
  },
  // sync.ts:108-117
  {
    table: "projects",
    syncKey: ["slug"],
    timestampCol: "last_session_at",
    strategy: "lww",
    columns: [
      "slug", "name", "path", "tech_stack", "archetype", "igris_version", "status",
      "registered_at", "last_session_at", "metadata",
    ],
  },
  // sync.ts:128-137
  {
    table: "brief_status",
    syncKey: ["project", "brief_id"],
    timestampCol: "updated_at",
    strategy: "lww",
    columns: [
      "project", "brief_id", "brief_type", "title", "status",
      "priority", "effort", "phase", "updated_at",
    ],
  },
  // sync.ts:138-148
  {
    table: "instances",
    syncKey: ["id"],
    timestampCol: "last_heartbeat_at",
    strategy: "lww",
    columns: [
      "id", "machine_hostname", "machine_os", "project_slug", "project_path",
      "current_brief", "current_phase", "current_task", "status",
      "started_at", "last_heartbeat_at", "metadata",
      "harness", "harness_session_id", "owner_pid", "owner_started_at",
      "liveness_method", "liveness_status", "liveness_checked_at",
      "lease_expires_at", "state_updated_at",
    ],
  },
  // sync.ts:166-172
  {
    table: "session_files",
    syncKey: ["project", "filename"],
    timestampCol: "updated_at",
    strategy: "lww",
    columns: ["project", "filename", "content", "content_hash", "updated_at", "instance_id", "state"],
  },
  // sync.ts:173-179
  {
    table: "definition_files",
    syncKey: ["type", "name"],
    timestampCol: "updated_at",
    strategy: "lww",
    columns: ["type", "name", "filename", "content", "content_hash", "version", "updated_at"],
  },
];

/** Per-row merge failure — verbatim from `MergeRowFailure` (sync.ts:537-540). */
export interface MergeRowFailure {
  key: string;
  error: string;
}

/** Merge counts for one table — verbatim from `MergeRowsResult` (sync.ts:543-550). */
export interface MergeRowsResult {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  failures?: MergeRowFailure[];
}

/**
 * Merge two comma-separated tag strings into a sorted union.
 * Verbatim from `mergeTags` (sync.ts:409-414).
 */
function mergeTags(localTags: string, remoteTags: string): string {
  const localSet = new Set(localTags.split(",").map((t) => t.trim()).filter(Boolean));
  const remoteSet = new Set(remoteTags.split(",").map((t) => t.trim()).filter(Boolean));
  const merged = new Set([...localSet, ...remoteSet]);
  return Array.from(merged).sort().join(",");
}

/**
 * Merge incoming rows into the local DB for one table config — the last-write-
 * wins upsert. Verbatim port of `mergeRows` (sync.ts:574-667):
 *   - manual `SELECT * WHERE syncKey = ?` lookup (NOT ON CONFLICT — syncKey
 *     columns are not UNIQUE; see the section header);
 *   - absent row → INSERT only the columns the row defines;
 *   - existing + strategy 'append' → skip;
 *   - existing + 'lww' → UPDATE non-syncKey columns ONLY when remoteTs >
 *     localTs (compared on timestampCol), applying merge_tags / max merge
 *     fields; equal-or-older → skip;
 *   - row-level try/catch: one bad row records a failure + continues (never
 *     poisons sibling rows). Caller wraps the whole table set in a transaction.
 */
function mergeRows(
  handle: Database.Database,
  config: PullTableConfig,
  rows: Record<string, unknown>[],
): MergeRowsResult {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const failures: MergeRowFailure[] = [];

  const lookupSql = `SELECT * FROM ${config.table} WHERE ${config.syncKey
    .map((k) => `${k} = ?`)
    .join(" AND ")}`;
  const lookupStmt = handle.prepare(lookupSql);
  const existingColumns = tableColumns(handle, config.table);

  for (const row of rows) {
    const keyValues = config.syncKey.map((k) => row[k]);
    try {
      const existing = lookupStmt.get(...keyValues) as
        | Record<string, unknown>
        | undefined;

      if (!existing) {
        const cols = config.columns.filter(
          (c) => row[c] !== undefined && existingColumns.has(c),
        );
        const placeholders = cols.map(() => "?").join(", ");
        handle
          .prepare(
            `INSERT INTO ${config.table} (${cols.join(", ")}) VALUES (${placeholders})`,
          )
          .run(...cols.map((c) => row[c] ?? null));
        inserted++;
      } else if (config.strategy === "append") {
        skipped++;
      } else {
        // LWW strategy: compare timestamps.
        const localTs = (existing[config.timestampCol] as string) ?? "";
        const remoteTs = (row[config.timestampCol] as string) ?? "";

        if (remoteTs > localTs) {
          const setClauses: string[] = [];
          const setValues: unknown[] = [];

          for (const col of config.columns) {
            if (config.syncKey.includes(col)) continue;
            if (!existingColumns.has(col)) continue;

            if (config.mergeFields?.[col] === "merge_tags") {
              setClauses.push(`${col} = ?`);
              setValues.push(
                mergeTags(
                  (existing[col] as string) || "",
                  (row[col] as string) || "",
                ),
              );
            } else if (config.mergeFields?.[col] === "max") {
              setClauses.push(`${col} = ?`);
              setValues.push(
                Math.max(
                  (existing[col] as number) || 0,
                  (row[col] as number) || 0,
                ),
              );
            } else {
              setClauses.push(`${col} = ?`);
              setValues.push(row[col] ?? null);
            }
          }

          if (setClauses.length > 0) {
            const whereClause = config.syncKey.map((k) => `${k} = ?`).join(" AND ");
            handle
              .prepare(
                `UPDATE ${config.table} SET ${setClauses.join(", ")} WHERE ${whereClause}`,
              )
              .run(...setValues, ...keyValues);
            updated++;
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
      }
    } catch (rowErr) {
      failed++;
      const keyStr = keyValues
        .map((v) => {
          if (v === null || v === undefined) return "";
          if (
            typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean"
          )
            return String(v);
          try {
            return JSON.stringify(v);
          } catch {
            return "<unserializable>";
          }
        })
        .join("|");
      const error = rowErr instanceof Error ? rowErr.message : String(rowErr);
      failures.push({ key: keyStr, error });
    }
  }

  const result: MergeRowsResult = { inserted, updated, skipped, failed };
  if (failed > 0) result.failures = failures;
  return result;
}

/**
 * Read the local `sync_state.last_pull_at` for `(remoteUrl, table)`, defaulting
 * to the epoch when absent. This is the `since_<table>` cursor `boot-sync` sends
 * to `GET /sync/pull` — verbatim from `handleBrainPull`'s per-table timestamp
 * loop (sync.ts:922-928). A brain DB without `sync_state` → epoch (full pull),
 * never a throw, never a CREATE (create-never).
 */
export function readPullSince(remoteUrl: string, table: string): string {
  const handle = getDb();
  if (!tableExists(handle, "sync_state")) {
    return "1970-01-01T00:00:00";
  }
  const row = handle
    .prepare(
      "SELECT last_pull_at FROM sync_state WHERE remote_url = ? AND table_name = ?",
    )
    .get(remoteUrl, table) as { last_pull_at: string | null } | undefined;
  return row?.last_pull_at ?? "1970-01-01T00:00:00";
}

/** Per-table merge summary returned by {@link mergePulledTables}. */
export interface PullMergeSummary {
  /** Total rows inserted + updated across all tables (the brain's "totalMerged"). */
  totalMerged: number;
  /** Per-table merge counts, keyed by table name (only tables with received rows). */
  perTable: Record<string, MergeRowsResult>;
}

/**
 * Merge a `{ tables: { <table>: rows[] } }` payload (the body of `GET
 * /sync/pull`) into the LOCAL brain DB, last-write-wins, then advance the local
 * `sync_state.last_pull_at` cursor for each merged table.
 *
 * VERBATIM reproduction of `handleBrainPull`'s merge half (sync.ts:954-988):
 *   - one transaction around all tables (the brain's `db.transaction`);
 *   - iterate BOOT_SYNC_PULL_TABLES in order, `mergeRows` each table that has
 *     received rows, accumulate `inserted + updated` into totalMerged;
 *   - upsert `sync_state.last_pull_at = pulledAt` per merged table (the same
 *     INSERT … ON CONFLICT(remote_url, table_name) the brain uses, sync.ts:958).
 *
 * `pulledAt` uses the brain's timestamp shape (sync.ts:918:
 * `new Date().toISOString().replace('T',' ').substring(0,19)`) so the cursor
 * column format matches the brain's own writes — the next pull's `since_*`
 * comparison stays string-monotonic.
 *
 * Create-never: `sync_state` is created by the brain's core schema (db.ts).
 * A writer that finds it absent surfaces a typed error rather than CREATE-ing it
 * (symmetric with the other M2 writers). Tables whose CONFIG table is missing
 * are skipped inside the row loop (mergeRows' prepare would throw → caught here
 * as a per-table error and recorded), never created.
 */
export function mergePulledTables(
  remoteUrl: string,
  tables: Record<string, Record<string, unknown>[]>,
): PullMergeSummary {
  const handle = getDb();

  // sync_state is the cursor store boot-sync advances; a writer must not CREATE
  // it (create-never). If absent, the brain DB predates the sync schema — surface.
  if (!tableExists(handle, "sync_state")) {
    throw new BrainTableMissingError("sync_state");
  }

  const pulledAt = new Date()
    .toISOString()
    .replace("T", " ")
    .substring(0, 19);

  const upsertState = handle.prepare(`
    INSERT INTO sync_state (remote_url, table_name, last_pull_at)
    VALUES (?, ?, ?)
    ON CONFLICT(remote_url, table_name)
    DO UPDATE SET last_pull_at = excluded.last_pull_at
  `);

  const perTable: Record<string, MergeRowsResult> = {};
  let totalMerged = 0;

  // One transaction around the whole merge (matches handleBrainPull:965).
  handle.transaction(() => {
    for (const config of BOOT_SYNC_PULL_TABLES) {
      const rows = tables[config.table];
      if (!rows || rows.length === 0) continue;

      // A table whose target table is absent in the local DB would throw on the
      // first prepare inside mergeRows — preflight it the same way the reads do,
      // recording a per-table failure instead of aborting the whole pull (and
      // NEVER creating it). This keeps boot-sync's "skip-on-fail" contract.
      if (!tableExists(handle, config.table)) {
        perTable[config.table] = {
          inserted: 0,
          updated: 0,
          skipped: 0,
          failed: rows.length,
          failures: [
            {
              key: "*",
              error: `local table '${config.table}' absent — skipped (create-never)`,
            },
          ],
        };
        continue;
      }

      const result = mergeRows(handle, config, rows);
      perTable[config.table] = result;
      totalMerged += result.inserted + result.updated;
      upsertState.run(remoteUrl, config.table, pulledAt);
    }
  })();

  return { totalMerged, perTable };
}
