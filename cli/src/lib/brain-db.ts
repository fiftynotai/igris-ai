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
 * table as "empty" rather than creating schema the brain owns. The one allowed
 * upgrade is the TD-277 rename of an existing instances table from the retired
 * activity column to `last_activity_at`, so a cold local boot can use the clean
 * state/activity model before the brain server runs.
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
 *
 * TWO DOORS SINCE TD-319. `getDb()` below still opens read-WRITE and sets
 * `journal_mode = WAL`, because the writers in this module (the instance-state
 * upsert, the session-file upsert, boot-sync's pull merge) need it. The PURE
 * readers behind the dashboard tier go through a second door instead —
 * {@link readProjectProfile} (converted IN PLACE — it is a pure read with no
 * write caller, so it got no twin), {@link briefStatusSummaryReadonly},
 * {@link listInstancesReadonly} — which open via
 * `brain-bridge.ts#openBrainReadonly` (`{readonly: true}` + `query_only = ON`)
 * and therefore never flip an operator's journal mode. Each read-only variant
 * shares the SELECT with its read-write twin, so there is still exactly one
 * definition of every query.
 */

import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, sep } from "node:path";
import { openBrainReadonly } from "./brain-bridge.js";
import { brainDbPath } from "./paths.js";
// TD-338: the GENERATED mirror of the brain's write-boundary normalizers. Never
// hand-edited — `npm run gen:brief-normalize-mirror` in brain-mcp-server/ writes
// it, and a brain-side parity test byte-locks it. See coding_guidelines §13.
import { normalizeSyncRow } from "./brief-normalize.generated.js";
// FR-268: the PURE KPI reader (db-param, SELECT-only). This module is its
// wrapper — the only place that opens a door for it.
import { absentKpiDigest, buildKpiDigest, type KpiReadOptions } from "./kpi-read.js";
import type {
  SessionFileRow,
  InstanceRow,
  AssessBriefs,
  AssessGoal,
  ProjectProfile,
  ProjectProfileResult,
  ImportClassification,
  ImportRowPlan,
  ImportStorePlan,
  ImportPlan,
  ImportConflictResolution,
  ImportAncestorUpdate,
  ImportStoreResult,
  ImportResult,
  KpiDigest,
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

/**
 * Upgrade an existing instances table to the TD-277 activity timestamp shape.
 *
 * This never creates the table. It only rewrites the retired local column name
 * when an already-migrated brain DB has not yet been touched by the brain
 * server's schema migration on this machine.
 */
function ensureInstancesActivityColumn(handle: Database.Database): Set<string> {
  let columns = tableColumns(handle, "instances");
  if (columns.has("last_activity_at")) {
    return columns;
  }
  if (columns.has("last_heartbeat_at")) {
    handle.exec("ALTER TABLE instances RENAME COLUMN last_heartbeat_at TO last_activity_at");
    columns = tableColumns(handle, "instances");
  }
  return columns;
}

function optionalProjection(
  columns: ReadonlySet<string>,
  name: string,
  fallback = "NULL",
): string {
  return columns.has(name) ? name : `${fallback} AS ${name}`;
}

/**
 * How to project and order by the instances activity timestamp, given the
 * columns THIS brain actually has.
 *
 * TD-319 needed this because {@link ensureInstancesActivityColumn} is DDL — an
 * `ALTER TABLE … RENAME COLUMN` — and the read-only door cannot run it (nor
 * should a GET). So the read path RESOLVES the column instead of renaming it:
 * an un-upgraded brain still sorts and reports correctly, it just keeps its
 * retired column name on disk until a writer comes along.
 *
 * The read-WRITE path calls `ensureInstancesActivityColumn` first, so it always
 * lands on the first branch and emits the SAME SQL it emitted before TD-319 —
 * the bare column name, not an alias. That is deliberate: the SQL is a verbatim
 * mirror of `handleInstanceList` and a gratuitous alias would make the mirror
 * harder to diff against its source.
 */
function activityProjection(columns: ReadonlySet<string>): {
  select: string;
  order: string;
} {
  if (columns.has("last_activity_at")) {
    return {
      select: "last_activity_at",
      order: "ORDER BY last_activity_at DESC",
    };
  }
  if (columns.has("last_heartbeat_at")) {
    return {
      select: "last_heartbeat_at AS last_activity_at",
      order: "ORDER BY last_heartbeat_at DESC",
    };
  }
  // Neither column exists (a shape no migration produces, but a SELECT naming a
  // missing column would throw where the rest of this module degrades).
  return { select: "NULL AS last_activity_at", order: "" };
}

/**
 * Open the READ-ONLY door and run `fn`, closing the handle afterwards.
 *
 * TD-319. The single place this module reaches
 * `brain-bridge.ts#openBrainReadonly` — `{readonly: true, fileMustExist: true}`
 * with `query_only = ON` armed on both of its branches. `absent` is the value
 * returned when there is no readable brain file at all, which is deliberately
 * the SAME shape each caller returns for "the table is missing": a read-only
 * lens has no business distinguishing an unmigrated brain from an absent one by
 * creating something.
 *
 * Per-call open/close rather than a cached handle, matching the dashboard's
 * layer readers: a `/hunt` writing to the brain is visible on the next read.
 */
function withReadonlyBrain<T>(
  absent: T,
  fn: (handle: Database.Database) => T,
): T {
  const handle = openBrainReadonly();
  if (handle === null) return absent;
  try {
    return fn(handle);
  } finally {
    try {
      handle.close();
    } catch {
      /* already closed — nothing to do */
    }
  }
}

/** The `projects`-profile projection, shared by both doors. */
function selectProjectProfile(
  handle: Database.Database,
  slug: string,
): ProjectProfileResult {
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
 * Read the local project profile row used by `context-docs inventory`.
 *
 * Read-only and create-never: an absent DB, absent `projects` table, absent
 * row, or older schema with missing columns all degrade into a partial/null
 * profile rather than throwing or running DDL.
 *
 * TD-319 MADE THAT STRUCTURAL. The docstring above already claimed "read-only",
 * but the handle came from `getDb()` — read-WRITE, and `journal_mode = WAL` on
 * open. So a `GET /api/context-docs` (which reaches here through
 * `verbs/context-docs.ts#buildContextDocsInventoryDigest`) rewrote the `.db`
 * header of a `delete`-mode brain, as did the plain
 * `igris context-docs inventory` verb. This now opens through the READ-ONLY
 * door instead. Both callers are pure reads and neither depended on the WAL
 * flip or on the file being materialised; the OLD `existsSync(brainDbPath())`
 * preflight is gone because `openBrainReadonly`'s `fileMustExist: true` is the
 * same guarantee enforced by the connection rather than by a check upstream of
 * it.
 */
export function readProjectProfile(slug: string): ProjectProfileResult {
  return withReadonlyBrain<ProjectProfileResult>(
    { degraded: true, profile: null },
    (handle) => selectProjectProfile(handle, slug),
  );
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
    .get(slug, filename) as { content: unknown } | undefined;

  // TD-279: session_files.content can be a SQLite BLOB (better-sqlite3 returns
  // a Buffer), which has no `.match` and crashes the gather parse helpers.
  // Coerce at the read boundary so every caller sees the declared string|null.
  if (!row) return null;
  const c = row.content;
  return Buffer.isBuffer(c) ? c.toString("utf8") : c == null ? null : String(c);
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
 * List instances without treating activity age as liveness.
 *
 * FR-190 deliberately removes the old list-time side effects that purged rows
 * older than 240 minutes and marked rows stale after 45 minutes. Activity time
 * is visibility metadata, not liveness; normal reads must not delete the evidence
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
  // The read-WRITE door still performs the TD-277 rename before reading, so the
  // retired column name is repaired the first time a writer's process lists.
  return selectInstances(handle, ensureInstancesActivityColumn(handle), args);
}

/**
 * {@link listInstances} through the READ-ONLY door (TD-319).
 *
 * Same rows, same filters, same order. The differences are exactly the two
 * things a GET had no business doing: it does not set `journal_mode = WAL`, and
 * it does not run the TD-277 `ALTER TABLE … RENAME COLUMN` — an un-upgraded
 * brain is READ through {@link activityProjection} instead of being migrated by
 * a page view. `/api/summary` is the caller.
 */
export function listInstancesReadonly(
  args: ListInstancesArgs = {},
): InstanceRow[] {
  return withReadonlyBrain<InstanceRow[]>([], (handle) => {
    if (!tableExists(handle, "instances")) return [];
    return selectInstances(handle, tableColumns(handle, "instances"), args);
  });
}

/** The `instances` query, defined ONCE and run by both doors. */
function selectInstances(
  handle: Database.Database,
  columns: ReadonlySet<string>,
  args: ListInstancesArgs,
): InstanceRow[] {
  const activity = activityProjection(columns);

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
             current_phase, current_task, status, ${activity.select},
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
      ${activity.order}
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

/** Input for {@link registerOrUpdateInstanceState} — mirrors the instance-state tool subset the boot path passes. */
export interface InstanceStateRegistrationInput {
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

/** Result of a {@link registerOrUpdateInstanceState} upsert. */
export interface InstanceStateRegistrationResult {
  instance_id: string;
  /** True when a fresh UUID was minted (no prior id supplied); false on recover/refresh. */
  minted: boolean;
}

/**
 * Mint-or-recover an instance via the state/activity upsert.
 *
 * This writes instance lifecycle/state metadata. It does not prove liveness;
 * liveness comes from PID/start-time checks on same-machine rows and lease/claim
 * state for cross-machine coordination.
 *
 * The `agent_capabilities` upsert side-table the brain handler does
 * (instances.ts:87-102) is OMITTED: capabilities are not part of the awaken
 * register contract and `agent_capabilities` is not a table M2 seeds (#287).
 *
 * `minted` follows the handler's own action discrimination
 * (instances.ts:84): a fresh UUID (no `instance_id` supplied) is a mint; a
 * supplied id is a recover/refresh.
 */
export function registerOrUpdateInstanceState(
  input: InstanceStateRegistrationInput,
): InstanceStateRegistrationResult {
  const handle = getDb();

  // create-never: a present brain DB has migrated `instances`; a writer must
  // not CREATE it. If somehow absent, surface a typed error (the verb degrades).
  if (!tableExists(handle, "instances")) {
    throw new BrainTableMissingError("instances");
  }
  const columns = ensureInstancesActivityColumn(handle);

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
    "last_activity_at",
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
    "last_activity_at = excluded.last_activity_at",
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
  const columns = ensureInstancesActivityColumn(handle);
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
  if (columns.has("last_activity_at")) {
    sets.push("last_activity_at = ?");
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

  // TD-279: coerce content to a UTF-8 string before hashing/binding so a
  // Buffer input never lands as a BLOB in session_files.content.
  const contentStr = Buffer.isBuffer(input.content)
    ? input.content.toString("utf8")
    : String(input.content);

  // Verbatim from handleSessionFileUpdate:245-261.
  const contentHash = createHash("sha256").update(contentStr).digest("hex");
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
      contentStr,
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
 *
 * `slug === null` DROPS the project predicate — it does not invent a new query.
 * The handler this mirrors already builds its `summaryWhere` conditionally
 * (`briefs.ts:203-210`: `if (args.project)` … else the clause is the empty
 * string), so an omitted project is the handler's own unfiltered branch rather
 * than a CLI-side deviation from it. BR-082 needed it for the unscoped
 * dashboard Overview; `verbs/assess.ts` always passes a slug and is unchanged.
 *
 * What the unfiltered branch counts is EVERY `brief_status` row. For THIS
 * table that equals "the sum over the registered projects", and the mechanism
 * is worth stating precisely because a WRONG statement of it survived a review
 * and then caused a REJECT of correct code.
 *
 * The mechanism: `project` is `NOT NULL` with a declared FK to `projects(slug)`
 * (db.ts:283-295), AND better-sqlite3 enables `foreign_keys` BY DEFAULT on
 * every handle it opens. The brain's explicit `pragma('foreign_keys = ON')`
 * (db.ts:1315) is belt-and-braces; it is not what makes this hold, and calling
 * the FK "engine-enforced" implies a distinction between connections that does
 * not exist.
 *
 * MEASURED against the real schema on this connection's exact shape
 * (`busy_timeout` only, no FK pragma), 2026-07-31:
 *
 *     foreign_keys on this handle = 1
 *     DELETE FROM projects WHERE slug='igris-ai'  (654 briefs)
 *       -> BLOCKED: FOREIGN KEY constraint failed
 *
 * So an orphan cannot be created through this path at all — the coincidence is
 * enforced rather than merely observed. Corroborating census: 1,803 rows,
 * 0 NULL, 35 distinct projects, 0 absent from `projects`.
 *
 * CONSEQUENCE worth knowing: `registry.ts#deleteProjectRow` issues a bare
 * DELETE with no cascade, and its caller is `igris doctor --remove-orphans`.
 * On a project that still has briefs — or sessions, since `sessions.project`
 * carries the same FK (db.ts:290) — that DELETE is REFUSED rather than
 * orphaning the dependents, which is the safe direction.
 *
 * Until BR-084 the refusal was an UNGUARDED throw at all four call sites, and
 * the cost was NOT "the verb cannot remove that one project": the exception
 * escaped `confirmAndRemoveOrphans` and ABORTED THE WHOLE SWEEP, so every other
 * orphan that would have deleted cleanly survived too, and the interactive path
 * leaked its readline interface on the way out. One reachable input took down a
 * bulk-cleanup verb wholesale.
 *
 * Since BR-084 the refusal is a per-project RESULT, which is FR-241 D6's
 * posture applied here: `deleteProjectRow` returns `{slug, ok, error}` and does
 * not throw, the sweep CONTINUES, and the blocked project is reported with the
 * dependent count that blocked it. Its registry row is KEPT — no cascade, since
 * destroying brief history is not an action a `doctor` verb should take — and
 * because that row is still drifted it keeps `igris doctor` at exit 1.
 *
 * Do NOT generalise that to the other tables a caller may widen alongside this
 * one. `instances.project_slug` is nullable with no FK, so an unfiltered
 * instance count is strictly the larger set; `suggestions` diverges by 377 rows
 * (TD-326). Which set a NUMBER means is the caller's statement to make — see
 * `dashboard/routes.ts#summary` and `pages/Overview.tsx`.
 */
export function briefStatusSummary(slug: string | null): AssessBriefs {
  return selectBriefStatusSummary(getDb(), slug);
}

/**
 * {@link briefStatusSummary} through the READ-ONLY door (TD-319).
 *
 * Identical counts from an identical query on a `query_only = ON` connection,
 * so `GET /api/summary` no longer sets `journal_mode = WAL` on the operator's
 * brain. An absent brain file reads as the same empty summary the missing-table
 * preflight already produced.
 */
export function briefStatusSummaryReadonly(slug: string | null): AssessBriefs {
  return withReadonlyBrain<AssessBriefs>(
    { total: 0, by_status: {}, by_priority: {} },
    (handle) => selectBriefStatusSummary(handle, slug),
  );
}

/** The two GROUP-BY counts, defined ONCE and run by both doors. */
function selectBriefStatusSummary(
  handle: Database.Database,
  slug: string | null,
): AssessBriefs {
  if (!tableExists(handle, "brief_status")) {
    return { total: 0, by_status: {}, by_priority: {} };
  }

  // `WHERE project = ?` when scoped, no WHERE at all when not — the shape of
  // handleBriefDashboard's `summaryWhere` (briefs.ts:203-210), built once and
  // used by both counts exactly as the handler does.
  const where = slug === null ? "" : "WHERE project = ?";
  const params = slug === null ? [] : [slug];

  // SQL verbatim from handleBriefDashboard:205-211 (status counts) — project
  // filter only, ORDER BY count DESC.
  const statusRows = handle
    .prepare(
      `
      SELECT status, COUNT(*) as count
      FROM brief_status
      ${where}
      GROUP BY status
      ORDER BY count DESC
    `,
    )
    .all(...params) as { status: string; count: number }[];

  // SQL verbatim from handleBriefDashboard:226-232 (priority counts).
  const priorityRows = handle
    .prepare(
      `
      SELECT priority, COUNT(*) as count
      FROM brief_status
      ${where}
      GROUP BY priority
      ORDER BY count DESC
    `,
    )
    .all(...params) as { priority: string | null; count: number }[];

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
    timestampCol: "last_activity_at",
    strategy: "lww",
    columns: [
      "id", "machine_hostname", "machine_os", "project_slug", "project_path",
      "current_brief", "current_phase", "current_task", "status",
      "started_at", "last_activity_at", "metadata",
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

/** Per-row merge failure — verbatim from `MergeRowFailure` (sync.ts). */
export interface MergeRowFailure {
  key: string;
  error: string;
}

/**
 * TD-338 — one field folded on ingress. Verbatim from `MergeRowNormalization`
 * (sync.ts).
 */
export interface MergeRowNormalization {
  key: string;
  field: string;
  from: string;
  to: string | null;
}

/**
 * TD-338 — one non-canonical value stored verbatim. Verbatim from
 * `MergeRowNonCanonical` (sync.ts).
 */
export interface MergeRowNonCanonical {
  key: string;
  field: string;
  value: string;
}

/** Merge counts for one table — verbatim from `MergeRowsResult` (sync.ts). */
export interface MergeRowsResult {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  failures?: MergeRowFailure[];
  /** TD-338: count of ROWS whose stored value differed from the inbound value. */
  normalized: number;
  normalizations?: MergeRowNormalization[];
  nonCanonical?: MergeRowNonCanonical[];
}

/**
 * Render a row's syncKey values as the `|`-joined diagnostic key.
 * Verbatim from `formatSyncKey` (sync.ts).
 */
function formatSyncKey(keyValues: unknown[]): string {
  return keyValues
    .map((v) => {
      if (v === null || v === undefined) return "";
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        return String(v);
      }
      try {
        return JSON.stringify(v);
      } catch {
        return "<unserializable>";
      }
    })
    .join("|");
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
 * TD-404 — resolve a path for identity comparison. Mirrors `resolveForCompare`
 * (`brain-mcp-server/src/tools/projects.ts`, TD-402) so the pull-side refusal
 * and the register/update-side refusal answer the same question.
 *
 * `realpathSync` THROWS for a directory absent from this disk, and a pulled row
 * routinely names another machine's path. The raw string is therefore the
 * fallback, which keeps such a row in the comparison instead of dropping it out.
 */
function resolveForCompare(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * TD-404 — the slug already holding `path`, or `undefined` when the directory is
 * free. The pull-side twin of TD-402's `findPathHolder`.
 *
 * `stmt` selects every `projects` row; no `slug != ?` exclusion is needed because
 * the only caller is `mergeRows`' INSERT branch, which runs only when the syncKey
 * lookup found NO row for the incoming slug — so every row this sees already has
 * a different slug. (An exclusion would also be a trap: `slug != NULL` matches
 * nothing, silently disabling the guard.)
 */
function findPathHolderOnInsert(
  stmt: Database.Statement,
  path: string,
): { slug: string; path: string } | undefined {
  const incoming = resolveForCompare(path);
  const rows = stmt.all() as { slug: string; path: unknown }[];
  return rows
    .filter((r): r is { slug: string; path: string } => typeof r.path === "string" && r.path !== "")
    .find((r) => resolveForCompare(r.path) === incoming);
}

/**
 * Merge incoming rows into the local DB for one table config — the last-write-
 * wins upsert. Verbatim port of `mergeRows` (sync.ts):
 *   - manual `SELECT * WHERE syncKey = ?` lookup (NOT ON CONFLICT — syncKey
 *     columns are not UNIQUE; see the section header);
 *   - absent row → INSERT only the columns the row defines;
 *   - existing + strategy 'append' → skip;
 *   - existing + 'lww' → UPDATE non-syncKey columns ONLY when remoteTs >
 *     localTs (compared on timestampCol), applying merge_tags / max merge
 *     fields; equal-or-older → skip;
 *   - row-level try/catch: one bad row records a failure + continues (never
 *     poisons sibling rows). Caller wraps the whole table set in a transaction.
 *
 * TD-338 — THIS IS A NORMALIZATION BOUNDARY, and it is THE LIVE ONE ON A
 * WORKSTATION. Awaken / `igris boot-sync` pulls VPS→local through THIS copy,
 * not through the brain's `handleBrainPull`, so a brain-only fix would have
 * closed the door nobody walks through. Every inbound row for a table in
 * `SYNC_NORMALIZED_FIELDS` passes through the same write-boundary normalizers
 * (`normalizeSyncRow`, from the GENERATED mirror — never a hand copy).
 *
 * TD-404 — THE INSERT BRANCH IS ALSO A `projects.path` WRITER. `syncKey` is
 * `["slug"]`, so a locally-DELETED slug is indistinguishable from a never-seen
 * one and a cursor reset replays the remote row into a directory a local slug
 * already holds. A `projects` INSERT therefore asks {@link findPathHolderOnInsert}
 * first and throws when the directory is taken, landing in the per-row
 * `try`/`catch` below: `failed++`, the key + reason recorded, loop continues.
 * `syncKey` is deliberately NOT widened — BR-090 is why.
 *
 * `updated_at` is deliberately absent from that map, so the fold cannot bump
 * the LWW comparison column: a folded row produces no delta with a newer
 * timestamp, our next push carries EQUAL timestamps and the remote skips, and
 * the fixed point is reached on the first arrival of each row version. Folds
 * are recorded ONLY from a branch that actually wrote the row, so a row that
 * loses LWW is never folded nor reported.
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
  let normalized = 0;
  const failures: MergeRowFailure[] = [];
  const normalizations: MergeRowNormalization[] = [];
  const nonCanonical: MergeRowNonCanonical[] = [];

  const lookupSql = `SELECT * FROM ${config.table} WHERE ${config.syncKey
    .map((k) => `${k} = ?`)
    .join(" AND ")}`;
  if (config.table === "instances") {
    ensureInstancesActivityColumn(handle);
  }
  const lookupStmt = handle.prepare(lookupSql);
  const existingColumns = tableColumns(handle, config.table);
  // TD-404: prepared once, and only for the table + columns the guard reads. A
  // local `projects` without a `path` column cannot be given one by the INSERT
  // (the `cols` filter drops it), so there is nothing to guard.
  //
  // `config.table === "projects"` is REDUNDANT with the column check today:
  // `projects` is the only BOOT_SYNC_PULL_TABLES member declaring both `slug`
  // and `path` (`instances` carries `project_slug` / `project_path`, which this
  // check does not match), so no real config reaches the column check with the
  // term false. NO TEST ARMS IT — deleting it leaves boot-sync-project-path-guard.test.ts green, and arming
  // it would take a fabricated config. Kept as defence in depth: the statement
  // below names `projects` LITERALLY, so a future member that gained both columns
  // would otherwise have its incoming path compared against PROJECTS rows. What
  // is pinned instead is the PREMISE — the "only pull table declaring both" test
  // in `cli/src/__tests__/boot-sync-project-path-guard.test.ts` reds the day it
  // stops holding and the term becomes load-bearing.
  const pathHolderStmt =
    config.table === "projects" &&
    existingColumns.has("path") &&
    existingColumns.has("slug")
      ? handle.prepare("SELECT slug, path FROM projects")
      : undefined;

  for (const row of rows) {
    const keyValues = config.syncKey.map((k) => row[k]);
    // TD-338: fold BEFORE the row can reach either writer. Returns the SAME
    // object for an unmapped table or an already-canonical row (one map lookup
    // on the hot full-re-pull path). syncKey columns are never in the map, so
    // the lookup key above is unaffected.
    const {
      row: normRow,
      folds,
      nonCanonical: rowNonCanonical,
    } = normalizeSyncRow(config.table, row);
    const recordNormalization = (): void => {
      if (folds.length === 0 && rowNonCanonical.length === 0) return;
      const key = formatSyncKey(keyValues);
      if (folds.length > 0) {
        normalized++;
        for (const f of folds) normalizations.push({ key, ...f });
      }
      for (const nc of rowNonCanonical) nonCanonical.push({ key, ...nc });
    };
    try {
      const existing = lookupStmt.get(...keyValues) as
        | Record<string, unknown>
        | undefined;

      if (!existing) {
        // TD-404: one directory keeps one project row. See the docblock.
        const incomingPath = normRow.path;
        if (pathHolderStmt && typeof incomingPath === "string") {
          const holder = findPathHolderOnInsert(pathHolderStmt, incomingPath);
          if (holder) {
            throw new Error(
              `refused: path ${JSON.stringify(incomingPath)} is already held by slug ` +
                `${JSON.stringify(holder.slug)} (${holder.path}) — one directory keeps one project row`,
            );
          }
        }
        const cols = config.columns.filter(
          (c) => normRow[c] !== undefined && existingColumns.has(c),
        );
        const placeholders = cols.map(() => "?").join(", ");
        handle
          .prepare(
            `INSERT INTO ${config.table} (${cols.join(", ")}) VALUES (${placeholders})`,
          )
          .run(...cols.map((c) => normRow[c] ?? null));
        inserted++;
        recordNormalization();
      } else if (config.strategy === "append") {
        skipped++;
      } else {
        // LWW strategy: compare timestamps. `timestampCol` is deliberately
        // absent from SYNC_NORMALIZED_FIELDS, so normRow[timestampCol] ===
        // row[timestampCol] by construction — the fold cannot move LWW.
        const localTs = (existing[config.timestampCol] as string) ?? "";
        const remoteTs = (normRow[config.timestampCol] as string) ?? "";

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
                  (normRow[col] as string) || "",
                ),
              );
            } else if (config.mergeFields?.[col] === "max") {
              setClauses.push(`${col} = ?`);
              setValues.push(
                Math.max(
                  (existing[col] as number) || 0,
                  (normRow[col] as number) || 0,
                ),
              );
            } else {
              setClauses.push(`${col} = ?`);
              setValues.push(normRow[col] ?? null);
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
            recordNormalization();
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
      }
    } catch (rowErr) {
      failed++;
      const keyStr = formatSyncKey(keyValues);
      const error = rowErr instanceof Error ? rowErr.message : String(rowErr);
      failures.push({ key: keyStr, error });
    }
  }

  const result: MergeRowsResult = {
    inserted,
    updated,
    skipped,
    failed,
    normalized,
  };
  if (failed > 0) result.failures = failures;
  if (normalizations.length > 0) result.normalizations = normalizations;
  if (nonCanonical.length > 0) result.nonCanonical = nonCanonical;
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
  /**
   * TD-338: total rows folded on ingress across all tables. 0 on a clean pull —
   * the boot-sync digest stays silent at zero so a clean sync gains no noise.
   */
  totalNormalized: number;
  /** Every fold, named. Empty when nothing folded. */
  normalizations: MergeRowNormalization[];
  /** Every non-canonical value stored verbatim — the "arrived via sync" observer. */
  nonCanonical: MergeRowNonCanonical[];
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
  let totalNormalized = 0;
  const normalizations: MergeRowNormalization[] = [];
  const nonCanonical: MergeRowNonCanonical[] = [];

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
          normalized: 0,
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
      // TD-338: aggregate the ingress-normalization report across tables so
      // boot-sync can surface it in one place.
      totalNormalized += result.normalized;
      if (result.normalizations) normalizations.push(...result.normalizations);
      if (result.nonCanonical) nonCanonical.push(...result.nonCanonical);
      upsertState.run(remoteUrl, config.table, pulledAt);
    }
  })();

  return { totalMerged, perTable, totalNormalized, normalizations, nonCanonical };
}

// ===========================================================================
// FR-229 — `igris export` LOCAL-side project-slice readers + egress redaction
// ===========================================================================
//
// The exporter (`verbs/export.ts`) serializes ONE project's brain slice into a
// portable `.igris-pack.tar.gz`. It SELECTs only whitelisted columns per table,
// scoped to the project, with the correct syncKey/strategy/timestampCol so the
// bundle is self-describing for the FR-230 importer.
//
// `cli/` and `brain-mcp-server/` are separate npm packages with ZERO
// cross-imports (the same boundary that drives BOOT_SYNC_PULL_TABLES above), so
// the exporter cannot import `SYNC_TABLES`. `EXPORT_TABLES` reproduces the
// export-scoped subset VERBATIM from the cited `sync.ts` line blocks — the same
// "#213 trap" discipline (#849/#860): the authoritative column source is the
// cited `sync.ts` block copied verbatim + pinned by the MAINTAINING row #100
// egress contract, NOT a hand-invented list. A brain-side column change sweeps
// this copy via that row.
//
// This is the SECOND CLI-side mirror of the SYNC_TABLES egress schema (after
// BOOT_SYNC_PULL_TABLES) and the NEW egress choke point row #100's change
// procedure names: `redactTablesForEgress` (below) MUST run over every row
// BEFORE the exporter writes anything to disk.

/**
 * Config for one exportable table — extends {@link PullTableConfig} with the
 * optional `redactCols` mirror of `SyncTableConfig.redactCols` (sync.ts:82) so
 * redaction config travels with the column list from one source. None of the
 * currently-exported tables carry `redactCols` (only `projects.path` /
 * `instances.project_path` do, and neither is exported), so redaction is a
 * defensive no-op today — kept wired for future tiers (the row-100 contract).
 */
export interface ExportTableConfig extends PullTableConfig {
  redactCols?: string[];
}

/**
 * The export-scoped subset of `SYNC_TABLES` (sync.ts:94-364). Each config is
 * copied VERBATIM (syncKey / timestampCol / strategy / columns) from the cited
 * `SYNC_TABLES` entry. Distinct from `BOOT_SYNC_PULL_TABLES` (pull-scoped:
 * carries instances/session_files/definition_files, lacks brief_files/goals/
 * entity_edges/graph_nodes/errors) — a separate export-scoped array keeps intent
 * legible (plan §"Key architectural decision").
 */
export const EXPORT_TABLES: ExportTableConfig[] = [
  // sync.ts:155-164 — whitelist already OMITS claimed_by/claimed_at (the
  // claim-state strip is free; do NOT re-add them).
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
  // sync.ts:192-198 — carries content + content_hash inline.
  {
    table: "brief_files",
    syncKey: ["project", "brief_id"],
    timestampCol: "updated_at",
    strategy: "lww",
    columns: ["project", "brief_id", "filename", "content", "content_hash", "updated_at"],
  },
  // sync.ts:271-285 — brief↔brief subset filtered in readBriefBriefEdges; the
  // concept-graph reuses this config for its concept-touching edges.
  {
    // BR-083 — VERIFIED as a verbatim mirror of `SYNC_TABLES`, not assumed:
    // both qualifiers join `columns` AND `syncKey`, exactly as sync.ts does,
    // so a pack cannot re-fuse two projects' same-id edges on import.
    // An OLDER pack that lacks the columns still imports: `readExportRows`
    // intersects `columns` with the columns that actually exist, and the
    // import writer binds a missing key as NULL rather than failing.
    table: "entity_edges",
    syncKey: [
      "from_type", "from_id", "from_project",
      "to_type", "to_id", "to_project",
      "edge_type",
    ],
    timestampCol: "created_at",
    strategy: "append",
    columns: [
      "from_type", "from_id", "to_type", "to_id", "edge_type",
      "confidence", "provenance", "created_at", "metadata",
      "from_project", "to_project",
    ],
  },
  // sync.ts:301-317 — project_slug-scoped.
  {
    table: "goals",
    syncKey: ["goal_id"],
    timestampCol: "updated_at",
    strategy: "lww",
    columns: [
      "goal_id", "project_slug", "title", "description", "outcome",
      "deadline", "status", "priority", "created_at", "updated_at",
      "achieved_at", "metadata",
    ],
  },
  // sync.ts:96-118 — full tier only; readApprovedLearnings adds
  // review_status='approved'.
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
      "promoted_to_doc",
    ],
  },
  // sync.ts:120-131 — full tier only; project-scoped. Embeddings are NOT a
  // column here (they live in a separate vec0 table) so they are never exported.
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
  // sync.ts:286-300 — full tier only; the project concept-graph nodes
  // (node_type='concept'), scoped in readConceptNodes.
  {
    table: "graph_nodes",
    syncKey: ["node_type", "node_external_id"],
    timestampCol: "created_at",
    strategy: "append",
    columns: [
      "node_type", "node_external_id", "label", "properties", "created_at",
    ],
  },
];

/** Look up an {@link ExportTableConfig} by table name. Throws if unknown (a coding error). */
export function exportTableConfig(table: string): ExportTableConfig {
  const cfg = EXPORT_TABLES.find((t) => t.table === table);
  if (cfg === undefined) {
    throw new Error(`export: no EXPORT_TABLES config for table '${table}'`);
  }
  return cfg;
}

/**
 * Generic whitelisted, create-never reader used by every export reader below.
 *
 * L-133 preflight: an absent table → `[]` (never a throw, never a CREATE).
 * SELECTs ONLY the config's whitelisted columns that actually exist on this DB
 * (an older DB missing a column degrades that column away rather than throwing),
 * scoped by the caller's WHERE, honoring an optional `since` cutoff on the
 * config's `timestampCol`. The `since` predicate + bind is appended AFTER the
 * caller's, so the caller's placeholders bind first.
 */
function readExportRows(
  config: ExportTableConfig,
  where: string[],
  params: unknown[],
  since?: string,
): Record<string, unknown>[] {
  const handle = getDb();
  if (!tableExists(handle, config.table)) return [];

  const existing = tableColumns(handle, config.table);
  const cols = config.columns.filter((c) => existing.has(c));
  if (cols.length === 0) return [];

  const conditions = [...where];
  const bind = [...params];
  if (since !== undefined && since.length > 0 && existing.has(config.timestampCol)) {
    conditions.push(`${config.timestampCol} >= ?`);
    bind.push(since);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return handle
    .prepare(`SELECT ${cols.join(", ")} FROM ${config.table} ${whereClause}`)
    .all(...bind) as Record<string, unknown>[];
}

/** Whitelisted brief_status rows for a project (claimed_* never present). */
export function readBriefStatusRows(
  slug: string,
  since?: string,
): Record<string, unknown>[] {
  return readExportRows(
    exportTableConfig("brief_status"),
    ["project = ?"],
    [slug],
    since,
  );
}

/** Whitelisted brief_files rows for a project (content + content_hash inline). */
export function readBriefFilesRows(
  slug: string,
  since?: string,
): Record<string, unknown>[] {
  return readExportRows(
    exportTableConfig("brief_files"),
    ["project = ?"],
    [slug],
    since,
  );
}

/**
 * Brief↔brief `entity_edges` where BOTH endpoints are briefs of THIS project.
 *
 * Edges are only portable when both endpoints are this project's briefs (an
 * edge to a foreign brief would dangle after import). The project's brief-id set
 * is computed first from `brief_status`; an absent `entity_edges`/`brief_status`
 * table or an empty brief set → `[]` (create-never).
 */
export function readBriefBriefEdges(
  slug: string,
  since?: string,
): Record<string, unknown>[] {
  const handle = getDb();
  if (!tableExists(handle, "entity_edges")) return [];
  if (!tableExists(handle, "brief_status")) return [];

  const briefIds = (
    handle
      .prepare("SELECT brief_id FROM brief_status WHERE project = ?")
      .all(slug) as { brief_id: string }[]
  ).map((r) => r.brief_id);
  if (briefIds.length === 0) return [];

  const ph = briefIds.map(() => "?").join(", ");
  return readExportRows(
    exportTableConfig("entity_edges"),
    [
      "from_type = 'brief'",
      "to_type = 'brief'",
      `from_id IN (${ph})`,
      `to_id IN (${ph})`,
    ],
    [...briefIds, ...briefIds],
    since,
  );
}

/** Whitelisted goals rows for a project (project_slug-scoped, all statuses). */
export function readProjectGoals(
  slug: string,
  since?: string,
): Record<string, unknown>[] {
  return readExportRows(
    exportTableConfig("goals"),
    ["project_slug = ?"],
    [slug],
    since,
  );
}

/** Whitelisted APPROVED learnings for a project (full tier). Pending/rejected excluded. */
export function readApprovedLearnings(
  slug: string,
  since?: string,
): Record<string, unknown>[] {
  return readExportRows(
    exportTableConfig("learnings"),
    ["project = ?", "review_status = 'approved'"],
    [slug],
    since,
  );
}

/** Whitelisted error fingerprints for a project (full tier; embeddings excluded). */
export function readProjectErrors(
  slug: string,
  since?: string,
): Record<string, unknown>[] {
  return readExportRows(
    exportTableConfig("errors"),
    ["project = ?"],
    [slug],
    since,
  );
}

/**
 * Return this project's concept-node external ids.
 *
 * Scoping choice (conservative, noted per plan): `graph_nodes` has NO project
 * column, so a concept node is attributed to a project via
 * `json_extract(properties, '$.project')`. A concept node that carries no such
 * property is NOT exported — this may under-include, but never bleeds a foreign
 * project's concepts into the bundle (the safe failure direction). An absent
 * `graph_nodes` table → `[]`.
 */
function conceptNodeIds(slug: string): string[] {
  const handle = getDb();
  if (!tableExists(handle, "graph_nodes")) return [];
  const cols = tableColumns(handle, "graph_nodes");
  if (!cols.has("node_type") || !cols.has("node_external_id") || !cols.has("properties")) {
    return [];
  }
  return (
    handle
      .prepare(
        "SELECT node_external_id FROM graph_nodes WHERE node_type = 'concept' AND json_extract(properties, '$.project') = ?",
      )
      .all(slug) as { node_external_id: string }[]
  ).map((r) => r.node_external_id);
}

/** Whitelisted project concept nodes (node_type='concept', properties.project=slug). */
export function readConceptNodes(
  slug: string,
  since?: string,
): Record<string, unknown>[] {
  return readExportRows(
    exportTableConfig("graph_nodes"),
    ["node_type = 'concept'", "json_extract(properties, '$.project') = ?"],
    [slug],
    since,
  );
}

/**
 * `entity_edges` touching THIS project's concept nodes (either endpoint is an
 * in-scope concept node). Reuses the entity_edges config. Empty concept set or
 * absent table → `[]`.
 */
export function readConceptEdges(
  slug: string,
  since?: string,
): Record<string, unknown>[] {
  const handle = getDb();
  if (!tableExists(handle, "entity_edges")) return [];

  const ids = conceptNodeIds(slug);
  if (ids.length === 0) return [];

  const ph = ids.map(() => "?").join(", ");
  return readExportRows(
    exportTableConfig("entity_edges"),
    [
      `((from_type = 'concept' AND from_id IN (${ph})) OR (to_type = 'concept' AND to_id IN (${ph})))`,
    ],
    [...ids, ...ids],
    since,
  );
}

/**
 * Relativize an absolute LOCAL filesystem path so an exported bundle never
 * carries the source machine's directory layout. VERBATIM CLI mirror of
 * `relativizeEgressPath` (sync.ts:382-389). Idempotent.
 */
export function relativizeEgressPath(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return value;
  const home = homedir();
  if (value === home) return "~";
  if (value.startsWith(home + sep)) return "~" + value.slice(home.length);
  if (isAbsolute(value)) return basename(value);
  return value;
}

/**
 * Redact the `redactCols` of every table IN PLACE (via
 * {@link relativizeEgressPath}). VERBATIM CLI mirror of `redactTablesForEgress`
 * (sync.ts:401-414), keyed off {@link EXPORT_TABLES} instead of `SYNC_TABLES`.
 *
 * The exporter MUST call this at its egress choke point BEFORE writing any row
 * to disk (row #100's "new egress choke point" clause). Mutating in place means
 * the same row objects the exporter later serializes are already redacted.
 * Idempotent. A no-op today (no exported table carries redactCols) — wired for
 * future tiers.
 */
export function redactTablesForEgress(
  tables: Record<string, Record<string, unknown>[]>,
): Record<string, Record<string, unknown>[]> {
  for (const [tableName, rows] of Object.entries(tables)) {
    const cfg = EXPORT_TABLES.find((t) => t.table === tableName);
    if (!cfg?.redactCols || cfg.redactCols.length === 0) continue;
    for (const row of rows) {
      for (const col of cfg.redactCols) {
        if (col in row) row[col] = relativizeEgressPath(row[col]);
      }
    }
  }
  return tables;
}

// ===========================================================================
// FR-230 — `igris import` classify + apply ENGINE (the FR-229 ingress twin)
// ===========================================================================
//
// This is the INGRESS half of `EXPORT_TABLES` (MAINTAINING row #100): the same
// verbatim `SYNC_TABLES` column mirror that governs egress now governs the
// import WRITE allowlist (D3). The engine REUSES `mergeRows`' mechanics
// (natural-key lookup, column-filtered INSERT, tag-union / max-counter UPDATE,
// per-row try/catch) but NEVER its silent `remoteTs > localTs` LWW branch — the
// engine decides each row's action BEFORE writing (ancestor-based classify +
// explicit `--on-conflict` policy), and the writer only executes the decided
// insert / update / skip. Nothing here calls `mergeRows`/`mergePulledTables`.
//
// Identity is 100% natural-keyed (autoincrement ids are excluded from the wire),
// so there is no id-remapping — only classification + policy + provenance.

/**
 * name → target table for the importable ROW stores. `concept_edges` reuses the
 * `entity_edges` table (its own manifest name so brief↔brief edges and
 * concept-graph edges never collide). This fixed map is the security boundary
 * (D3 / AC9): a manifest store NAME outside this map (skills/agents/hooks/…) has
 * no import path, and the resolved table's column set is the write allowlist —
 * a hand-crafted `columns` list in the manifest is never trusted.
 */
const IMPORTABLE_STORE_TABLES: Record<string, string> = {
  brief_status: "brief_status",
  brief_files: "brief_files",
  entity_edges: "entity_edges",
  goals: "goals",
  learnings: "learnings",
  errors: "errors",
  graph_nodes: "graph_nodes",
  concept_edges: "entity_edges",
};

/**
 * Every manifest store NAME the importer accepts: the 8 row stores +
 * `context_docs` (a disk-backed pseudo-store handled by `import.ts`, not a DB
 * table). Any other store name in a bundle manifest → reject BEFORE any DB write
 * (AC9 executable-surface reject). The producer never emits these (they ride
 * `EXCLUDED_STORES`), so this only fires on a hand-crafted bundle.
 */
export const IMPORTABLE_STORES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(IMPORTABLE_STORE_TABLES),
  "context_docs",
]);

/** Raised when a bundle declares a store the importer refuses to write (AC9). */
export class ImportUnsupportedStoreError extends Error {
  constructor(store: string) {
    super(
      `import: store '${store}' is not importable — unknown or executable-surface ` +
        `(importable row stores: ${Object.keys(IMPORTABLE_STORE_TABLES).join(", ")}, or context_docs)`,
    );
    this.name = "ImportUnsupportedStoreError";
  }
}

/**
 * Resolve a manifest store NAME to its LOCAL {@link ExportTableConfig} — the
 * write allowlist (D3). Throws {@link ImportUnsupportedStoreError} for a
 * non-importable name. The importer writes ONLY `config.columns ∩ local
 * tableColumns`, so `claimed_by`/`claimed_at` (absent from `EXPORT_TABLES`) are
 * structurally unwriteable (AC7) and the manifest's declared columns are never
 * trusted.
 */
export function importStoreConfig(store: string): ExportTableConfig {
  const table = IMPORTABLE_STORE_TABLES[store];
  if (table === undefined) {
    throw new ImportUnsupportedStoreError(store);
  }
  return exportTableConfig(table);
}

/** Semantic-hash volatile columns dropped alongside syncKey + timestampCol. */
const IMPORT_VOLATILE_COLUMNS = new Set<string>([
  "access_count",
  "last_accessed_at",
  "occurrence_count",
]);

/**
 * sha256 over the store's SEMANTIC columns — `config.columns` minus syncKey,
 * minus `timestampCol`, minus volatile (`access_count`/`last_accessed_at`/
 * `occurrence_count`). Sorted-key JSON so the hash is stable across producers.
 * This is the 3-way-compare fingerprint; excluding syncKey (identity, not
 * content) + volatile counters means a bumped `access_count` never reads as a
 * content change, and a re-export of an unchanged row re-hashes identically.
 */
export function rowContentHash(
  config: ExportTableConfig,
  row: Record<string, unknown>,
): string {
  const semantic: Record<string, unknown> = {};
  const cols: string[] = [];
  for (const col of config.columns) {
    if (config.syncKey.includes(col)) continue;
    if (col === config.timestampCol) continue;
    if (IMPORT_VOLATILE_COLUMNS.has(col)) continue;
    semantic[col] = row[col] ?? null;
    cols.push(col);
  }
  cols.sort();
  // `cols` as the JSON replacer array both filters and orders keys.
  return createHash("sha256").update(JSON.stringify(semantic, cols)).digest("hex");
}

/**
 * Content hash for the LOCAL side of the 3-way compare. `brief_files` hashes its
 * `content` column directly (bundle-authoritative via `descriptor.content_hashes`,
 * plan Phase 2.1); every other store uses {@link rowContentHash}.
 */
function localRowContentHash(
  store: string,
  config: ExportTableConfig,
  row: Record<string, unknown>,
): string {
  if (store === "brief_files") {
    const content = typeof row.content === "string" ? row.content : "";
    return createHash("sha256").update(content).digest("hex");
  }
  return rowContentHash(config, row);
}

/**
 * Content hash for the BUNDLE side. `brief_files` is authoritative from the
 * manifest's recomputed `content_hashes[brief_id]` (falls back to
 * `sha256(content)`, which is equal by construction); every other store uses
 * {@link rowContentHash}.
 */
function bundleRowContentHash(
  store: string,
  config: ExportTableConfig,
  row: Record<string, unknown>,
  contentHashes: Record<string, string> | undefined,
): string {
  if (store === "brief_files") {
    const briefId = String(row.brief_id ?? "");
    const declared = contentHashes?.[briefId];
    if (declared !== undefined) return declared;
    const content = typeof row.content === "string" ? row.content : "";
    return createHash("sha256").update(content).digest("hex");
  }
  return rowContentHash(config, row);
}

/**
 * The single composite-key separator for the import engine: a NUL byte, so it
 * can never collide with a syncKey value (a learnings `title` may contain
 * spaces). ONE constant joins syncKey values into a row key AND builds the
 * CONFLICT decision-map key, so the classify side and the apply side agree.
 */
const IMPORT_KEY_SEP = "\u0000";

/** The CONFLICT decision-map key for (store, rowKey) — single source for set + get. */
export function importDecisionKey(store: string, rowKey: string): string {
  return `${store}${IMPORT_KEY_SEP}${rowKey}`;
}

/** The syncKey values joined — the ledger + report key for a row. */
function importRowKey(
  config: ExportTableConfig,
  row: Record<string, unknown>,
): string {
  return config.syncKey.map((k) => String(row[k] ?? "")).join(IMPORT_KEY_SEP);
}


/**
 * Natural-key lookup of the LOCAL row for a store (verbatim `mergeRows`
 * mechanic: `SELECT * … WHERE syncKey = ?`). Absent table → undefined
 * (create-never). Scoped implicitly by the TARGET slug because the caller has
 * already rewritten the row's scope column (`--as`, Phase 4).
 */
export function lookupLocalRow(
  config: ExportTableConfig,
  keyValues: unknown[],
): Record<string, unknown> | undefined {
  const handle = getDb();
  if (!tableExists(handle, config.table)) return undefined;
  // BR-083 — `IS`, NOT `=`. `entity_edges.from_project` / `to_project` are the
  // first NULLABLE syncKey columns, and `col = NULL` is NULL rather than true:
  // with `=` an unattributed edge would never be found locally, every import
  // would classify it NEW, and the append strategy would duplicate it. `IS`
  // behaves identically to `=` for every non-NULL key, so no other store moves.
  //
  // BR-083 — the key is also INTERSECTED with the columns that actually exist,
  // matching `readExportRows`. On a brain that predates `edges@4` the two
  // qualifiers are not merely NULL, they are ABSENT, and naming them would
  // throw `no such column` on a path whose whole job is to tolerate an older
  // artifact. Degrading to the pre-BR-083 key there loses NOTHING: that
  // database holds no qualifier to distinguish rows by.
  const existing = tableColumns(handle, config.table);
  const keyCols = config.syncKey.filter((k) => existing.has(k));
  const keyVals = config.syncKey
    .map((k, i) => [k, keyValues[i]] as const)
    .filter(([k]) => existing.has(k))
    .map(([, v]) => v);
  if (keyCols.length === 0) return undefined;
  const sql = `SELECT * FROM ${config.table} WHERE ${keyCols
    .map((k) => `${k} IS ?`)
    .join(" AND ")}`;
  return handle.prepare(sql).get(...keyVals) as
    | Record<string, unknown>
    | undefined;
}

/** One bundle store's rows + (brief_files only) its authoritative content hashes. */
export interface ImportStoreInput {
  /** Manifest store NAME (e.g. `concept_edges`). */
  store: string;
  /** The slug-rewritten (`--as`) rows from the bundle data file. */
  rows: Record<string, unknown>[];
  /** brief_files only: `descriptor.content_hashes` (brief_id → sha256(content)). */
  contentHashes?: Record<string, string>;
}

/** Classification context — the CLI-local ledger ancestor lookup (D1). */
export interface ImportClassifyCtx {
  /** Ledger ancestor hash for (store, key); undefined = first-ever import. */
  ancestor: (store: string, key: string) => string | undefined;
}

function emptyClassCounts(): Record<ImportClassification, number> {
  return { NEW: 0, UNCHANGED: 0, INCOMING: 0, LOCAL_ONLY: 0, CONFLICT: 0 };
}

/**
 * Classify every bundle row NEW/UNCHANGED/INCOMING/LOCAL_ONLY/CONFLICT via the
 * ancestor-based 3-way compare (plan §Phase 2 truth table). NO writes. The
 * discriminator is the ledger ancestor hash — NOT `updated_at` — so a newer
 * timestamp on the LOCAL_ONLY side never flips it to an update (AC3). Append
 * stores (`entity_edges`/`graph_nodes`) can only be NEW or UNCHANGED: the key IS
 * the content, so conflict is structurally impossible (mirrors `mergeRows`'
 * append branch).
 */
export function classifyImport(
  stores: ImportStoreInput[],
  ctx: ImportClassifyCtx,
): ImportPlan {
  const outStores: ImportStorePlan[] = [];
  const totals = emptyClassCounts();

  for (const input of stores) {
    const config = importStoreConfig(input.store);
    const counts = emptyClassCounts();
    const rowPlans: ImportRowPlan[] = [];

    for (const row of input.rows) {
      const keyValues = config.syncKey.map((k) => row[k]);
      const key = importRowKey(config, row);
      const local = lookupLocalRow(config, keyValues);
      const H_b = bundleRowContentHash(input.store, config, row, input.contentHashes);
      const A = ctx.ancestor(input.store, key);

      let classification: ImportClassification;
      let H_l: string | undefined;
      if (local === undefined) {
        classification = "NEW";
      } else {
        H_l = localRowContentHash(input.store, config, local);
        if (H_l === H_b) {
          classification = "UNCHANGED";
        } else if (config.strategy === "append") {
          // Key IS the content for append stores → present means no-op.
          classification = "UNCHANGED";
        } else if (A !== undefined && H_l === A && H_b !== A) {
          classification = "INCOMING";
        } else if (A !== undefined && H_b === A && H_l !== A) {
          classification = "LOCAL_ONLY";
        } else {
          // Both diverged from A, OR no A recorded → conservative CONFLICT
          // (never silent-clobber; the whole point of the brief).
          classification = "CONFLICT";
        }
      }

      counts[classification]++;
      totals[classification]++;
      rowPlans.push({
        key,
        classification,
        bundleHash: H_b,
        localHash: H_l,
        ancestorHash: A,
        row,
      });
    }

    outStores.push({
      store: input.store,
      table: config.table,
      strategy: config.strategy ?? "lww",
      rows: rowPlans,
      counts,
    });
  }

  return { stores: outStores, totals };
}

/** Apply context — the per-CONFLICT decisions resolved BEFORE the txn opens. */
export interface ImportApplyCtx {
  /** `importDecisionKey(store, key)` → the resolved side for a CONFLICT row. */
  conflictDecisions: Map<string, "theirs" | "mine">;
  /** The TARGET slug (the `--as` slug, else the manifest slug) to auto-register (C2). */
  targetSlug: string;
  /** Absolute project path recorded on a freshly auto-registered `projects` row (C2). */
  projectPath: string;
}

/**
 * Auto-register a minimal `projects` row for the target slug INSIDE the apply
 * transaction, BEFORE the row inserts, so the `brief_status`/`sessions` FK to
 * `projects(slug)` is satisfied atomically on a fresh-machine import (C2). ROW
 * write, not DDL (create-never): `tableExists`-preflighted, `ON CONFLICT(slug)
 * DO NOTHING` so a colleague who already owns the project keeps their real
 * path/name. Returns true when a NEW row was inserted.
 */
function autoRegisterProject(
  handle: Database.Database,
  slug: string,
  projectPath: string,
): boolean {
  if (!tableExists(handle, "projects")) return false;
  const cols = tableColumns(handle, "projects");
  if (!cols.has("slug") || !cols.has("name") || !cols.has("path")) return false;
  const result = handle
    .prepare(
      `INSERT INTO projects (slug, name, path, status, registered_at)
       VALUES (?, ?, ?, 'active', ?)
       ON CONFLICT(slug) DO NOTHING`,
    )
    .run(
      slug,
      slug,
      projectPath,
      new Date().toISOString().replace("T", " ").substring(0, 19),
    );
  return result.changes > 0;
}

/**
 * Rehydrate a JSON-decoded Buffer into a real `Buffer` before binding it.
 *
 * A legacy BLOB column (e.g. some `brief_files.content` rows — FR-111/TD-179/
 * TD-277/TD-278) is a `Buffer` on the export side; FR-229's `JSON.stringify`
 * serializes it as `{ "type": "Buffer", "data": [...] }`. Bound as a plain
 * object, better-sqlite3 treats it as a NAMED-parameters map and throws "Too few
 * parameter values were provided", so the row lands in `failed`. Detect that
 * EXACT shape (`type === "Buffer"` + `Array.isArray(data)`) and rebuild the
 * Buffer so the BLOB round-trips. Guarded tightly so a real JSON object value is
 * never misread — but note `metadata`/`properties` are JSON *strings* in the
 * schema, not objects, so they never reach this branch. Every other value passes
 * through unchanged. Applied to ANY column value, so any BLOB column round-trips.
 */
function rehydrateBindValue(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !Buffer.isBuffer(value) &&
    (value as { type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return Buffer.from((value as { data: number[] }).data);
  }
  return value;
}

/** INSERT one row through the `EXPORT_TABLES` write allowlist (mergeRows insert mechanic). */
function importInsertRow(
  handle: Database.Database,
  config: ExportTableConfig,
  existingColumns: ReadonlySet<string>,
  row: Record<string, unknown>,
): void {
  const cols = config.columns.filter(
    (c) => row[c] !== undefined && existingColumns.has(c),
  );
  if (cols.length === 0) return;
  const placeholders = cols.map(() => "?").join(", ");
  handle
    .prepare(
      `INSERT INTO ${config.table} (${cols.join(", ")}) VALUES (${placeholders})`,
    )
    .run(...cols.map((c) => rehydrateBindValue(row[c] ?? null)));
}

/**
 * UPDATE one row to the bundle's values — the `mergeRows` lww branch WITHOUT the
 * `remoteTs > localTs` gate (policy already decided). Reuses the merge mechanics:
 * `tags` merge_tags for learnings, `occurrence_count` max for errors; every other
 * non-syncKey whitelisted column takes theirs.
 */
function importUpdateRow(
  handle: Database.Database,
  config: ExportTableConfig,
  existingColumns: ReadonlySet<string>,
  row: Record<string, unknown>,
): void {
  const keyValues = config.syncKey.map((k) => row[k]);
  const existing = handle
    .prepare(
      `SELECT * FROM ${config.table} WHERE ${config.syncKey
        .map((k) => `${k} = ?`)
        .join(" AND ")}`,
    )
    .get(...keyValues) as Record<string, unknown> | undefined;

  const setClauses: string[] = [];
  const setValues: unknown[] = [];
  for (const col of config.columns) {
    if (config.syncKey.includes(col)) continue;
    if (!existingColumns.has(col)) continue;
    if (config.mergeFields?.[col] === "merge_tags") {
      setClauses.push(`${col} = ?`);
      setValues.push(
        mergeTags((existing?.[col] as string) || "", (row[col] as string) || ""),
      );
    } else if (config.mergeFields?.[col] === "max") {
      setClauses.push(`${col} = ?`);
      setValues.push(
        Math.max((existing?.[col] as number) || 0, (row[col] as number) || 0),
      );
    } else {
      setClauses.push(`${col} = ?`);
      setValues.push(rehydrateBindValue(row[col] ?? null));
    }
  }
  if (setClauses.length === 0) return;
  const whereClause = config.syncKey.map((k) => `${k} = ?`).join(" AND ");
  handle
    .prepare(`UPDATE ${config.table} SET ${setClauses.join(", ")} WHERE ${whereClause}`)
    .run(...setValues, ...keyValues);
}

/**
 * Apply the classified plan under the resolved policy in ONE `db.transaction()`
 * across ALL stores (a hard mid-apply error rolls back → zero writes). Per-row
 * try/catch records a bad row without poisoning its siblings (mergeRows
 * mechanic). Deterministic action per class: NEW→insert, INCOMING→update,
 * UNCHANGED/LOCAL_ONLY→skip, CONFLICT→the pre-resolved decision (default keep
 * mine). After commit it recomputes each applied/unchanged row's resulting hash
 * → the ancestor to seed for the NEXT import (merge_tags means the result differs
 * from both sides, so it must be re-read, not assumed to be the bundle hash).
 */
export function applyImport(
  plan: ImportPlan,
  apply: ImportApplyCtx,
): ImportResult {
  const handle = getDb();
  const perStore: Record<string, ImportStoreResult> = {};
  const conflicts: ImportConflictResolution[] = [];
  const seedRows: { store: string; rowPlan: ImportRowPlan }[] = [];
  let projectRegistered = false;

  // Enforce the same referential integrity the brain does so the
  // `brief_status`→`projects(slug)` FK is honored and the in-txn auto-register
  // (C2) is load-bearing. Set BEFORE the transaction: SQLite ignores a
  // `foreign_keys` PRAGMA issued inside an open transaction.
  //
  // CORRECTION (BR-082): this block previously read "the CLI connection default
  // is OFF; restore it after". That was FALSE — better-sqlite3 enables
  // `foreign_keys` by DEFAULT on every handle, measured. The save/restore below
  // is therefore a no-op in practice and is kept only because it is correct
  // under any default. The false comment was read by a reviewer as evidence
  // that the CLI could orphan `brief_status` rows, and it cost a REJECT round
  // on correct code. A comment asserting a runtime default is a claim; measure
  // it before writing it.
  const prevForeignKeys = handle.pragma("foreign_keys", { simple: true });
  handle.pragma("foreign_keys = ON");
  try {
    handle.transaction(() => {
      // C2: register the target project FIRST so the FK is satisfied atomically
      // with the brief inserts (a fresh-machine handoff carries no projects row).
      projectRegistered = autoRegisterProject(
        handle,
        apply.targetSlug,
        apply.projectPath,
      );
      for (const sp of plan.stores) {
      const config = importStoreConfig(sp.store);
      const res: ImportStoreResult = {
        inserted: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
      };
      const failures: { key: string; error: string }[] = [];

      // create-never: an absent target table means the store isn't importable
      // on this DB — record every row as failed, NEVER run DDL.
      if (!tableExists(handle, config.table)) {
        res.failed = sp.rows.length;
        for (const rp of sp.rows) {
          failures.push({
            key: rp.key,
            error: `local table '${config.table}' absent — skipped (create-never)`,
          });
        }
        res.failures = failures;
        perStore[sp.store] = res;
        continue;
      }

      const existingColumns = tableColumns(handle, config.table);
      for (const rp of sp.rows) {
        let action: "insert" | "update" | "skip";
        switch (rp.classification) {
          case "NEW":
            action = "insert";
            break;
          case "INCOMING":
            action = "update";
            break;
          case "UNCHANGED":
          case "LOCAL_ONLY":
            action = "skip";
            break;
          case "CONFLICT": {
            const decision =
              apply.conflictDecisions.get(importDecisionKey(sp.store, rp.key)) ?? "mine";
            conflicts.push({
              store: sp.store,
              key: rp.key,
              classification: "CONFLICT",
              chosen: decision,
            });
            action = decision === "theirs" ? "update" : "skip";
            break;
          }
          default:
            action = "skip";
        }

        try {
          if (action === "insert") {
            importInsertRow(handle, config, existingColumns, rp.row);
            res.inserted++;
            seedRows.push({ store: sp.store, rowPlan: rp });
          } else if (action === "update") {
            importUpdateRow(handle, config, existingColumns, rp.row);
            res.updated++;
            seedRows.push({ store: sp.store, rowPlan: rp });
          } else {
            res.skipped++;
            // UNCHANGED seeds the ancestor too (local == bundle already), so a
            // later hand-back with a lost ledger still classifies cleanly.
            if (rp.classification === "UNCHANGED") {
              seedRows.push({ store: sp.store, rowPlan: rp });
            }
          }
        } catch (rowErr) {
          res.failed++;
          failures.push({
            key: rp.key,
            error: rowErr instanceof Error ? rowErr.message : String(rowErr),
          });
        }
      }

      if (failures.length > 0) res.failures = failures;
      perStore[sp.store] = res;
      }
    })();
  } finally {
    handle.pragma(`foreign_keys = ${prevForeignKeys ? "ON" : "OFF"}`);
  }

  // Post-commit: recompute the resulting local hash for every seeded row → the
  // ancestor for the NEXT import (D1 lineage). Read pass only, outside the txn.
  const ancestorUpdates: ImportAncestorUpdate[] = [];
  for (const seed of seedRows) {
    const config = importStoreConfig(seed.store);
    const keyValues = config.syncKey.map((k) => seed.rowPlan.row[k]);
    const local = lookupLocalRow(config, keyValues);
    if (local !== undefined) {
      ancestorUpdates.push({
        store: seed.store,
        key: seed.rowPlan.key,
        hash: localRowContentHash(seed.store, config, local),
      });
    }
  }

  return { perStore, conflicts, ancestorUpdates, projectRegistered };
}

// ---------------------------------------------------------------------------
// TD-327 — cognition instance health readers (READ-ONLY door only)
// ---------------------------------------------------------------------------

/**
 * TD-327 — one projected roster row, read back from `cognition_instances`.
 *
 * THE ROSTER IS THE REGISTRY'S PROJECTION, NEVER A CLI-SIDE LIST. That is the
 * whole point: `cli/` and `brain-mcp-server/` are separate npm packages with no
 * cross-imports, so the only honest way to enumerate an OPEN registry from here
 * is to read what the registry itself wrote. A literal list in this file would
 * be the exact regression TD-327 closes — it could not report on the instance
 * nobody remembered to add to it.
 *
 * Column contract mirrored from
 * `brain-mcp-server/src/engine/components/cognition/schema.ts` v1; MAINTAINING
 * pins the pair.
 */
export interface CognitionRosterRow {
  /** `cognition_instances.id`. */
  id: string;
  /** `cognition_instances.component` — the `event_log.component` LITERAL. */
  component: string;
  /** `cognition_instances.event_prefix` — the `event_name` prefix LITERAL. */
  event_prefix: string;
  /** `cognition_instances.gate_keys`, JSON-parsed. Empty when unparseable. */
  gate_keys: string[];
  /**
   * `cognition_instances.gate_default` — what an ABSENT gate key resolves to.
   * Declared per instance because the "absent means off" convention has one
   * exception: perception's RESOLVER default is ON for a truly absent key, so
   * hard-coding "absent means off" would misreport a config where the key was
   * never written. That is NOT the shipped posture — `igris install` writes
   * `enabled: false` (FR-191), so a stock fresh install has perception OFF.
   */
  gate_default: boolean;
  /** `cognition_instances.driver`. */
  driver: string;
  /** `cognition_instances.driver_ref`. */
  driver_ref: string | null;
  /** `cognition_instances.output`. */
  output: string;
}

/** TD-327 — outcome of {@link readCognitionRoster}. */
export interface CognitionRosterResult {
  /** True when there is no readable brain DB or no `cognition_instances` table. */
  degraded: boolean;
  /** Why; null when not degraded. */
  reason: string | null;
  /** The projected rows, in insertion (registry) order. */
  rows: CognitionRosterRow[];
}

/**
 * Read the projected instance roster.
 *
 * `rowid` ordering preserves the order the projector wrote, which is
 * `registry.all()` insertion order — i.e. the extractors-barrel order. A brain
 * that has never booted this build has no table, which is a DEGRADED read (the
 * health surface has nothing to report on), never a created table: the brain
 * owns this schema and `brain-db.ts` is create-never.
 */
export function readCognitionRoster(): CognitionRosterResult {
  return withReadonlyBrain<CognitionRosterResult>(
    { degraded: true, reason: "brain DB not readable", rows: [] },
    (handle) => {
      if (!tableExists(handle, "cognition_instances")) {
        return {
          degraded: true,
          reason:
            "cognition_instances not present — this brain has not booted a build that projects the roster",
          rows: [],
        };
      }
      // A roster projected by an OLDER brain build can be missing a column this
      // CLI knows about. SELECTing it would throw and take the whole digest
      // with it, so the shape is checked first and the absent column degrades
      // to its documented default — the same create-never / tolerant-read
      // posture the rest of this module uses.
      const columns = tableColumns(handle, "cognition_instances");
      const hasGateDefault = columns.has("gate_default");
      const gateDefaultSelect = hasGateDefault
        ? "gate_default"
        : "0 AS gate_default";
      const raw = handle
        .prepare(
          `SELECT id, component, event_prefix, gate_keys, ${gateDefaultSelect},
                  driver, driver_ref, output
             FROM cognition_instances ORDER BY rowid`,
        )
        .all() as Array<{
        id: string;
        component: string;
        event_prefix: string;
        gate_keys: string;
        gate_default: number;
        driver: string;
        driver_ref: string | null;
        output: string;
      }>;

      const rows: CognitionRosterRow[] = raw.map((r) => ({
        id: r.id,
        component: r.component,
        event_prefix: r.event_prefix,
        gate_keys: parseGateKeys(r.gate_keys),
        gate_default: r.gate_default === 1,
        driver: r.driver,
        driver_ref: r.driver_ref,
        output: r.output,
      }));
      return {
        degraded: false,
        reason: hasGateDefault
          ? null
          : "cognition_instances predates the gate_default column — every instance is read as absent-key-means-off, which is wrong for perception",
        rows,
      };
    },
  );
}

/**
 * Parse the stored `gate_keys` JSON array.
 *
 * Tolerant on purpose: a roster row written by a NEWER brain build with a shape
 * this CLI does not understand degrades to "no declared gate", which the
 * classifier reports as such — it does not throw and take the whole digest with
 * it. Only string members survive.
 */
function parseGateKeys(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === "string");
  } catch {
    return [];
  }
}

/**
 * TD-327 — the `event_log` signals for ONE instance, split by host.
 *
 * The host split is not cosmetic. `event_log` is a SYNC table carrying a
 * `machine_hostname` column, so a run that succeeded on the VPS replicates
 * here; an unscoped "latest terminal event" read would render a locally-wedged
 * instance green. `this_host` is what the verdict is computed from; `any_host`
 * is reported alongside so the operator can see that the instance is alive
 * SOMEWHERE.
 */
export interface CognitionRunSignals {
  /** Latest terminal event on this host: its ISO timestamp. */
  last_terminal_at: string | null;
  /** Latest terminal event on this host: its `event_name`. */
  last_terminal_name: string | null;
  /** Latest terminal event on ANY host. */
  last_terminal_any_host_at: string | null;
  /** `run_started` rows on this host today (UTC). */
  runs_today: number;
}

/**
 * Read one instance's run signals.
 *
 * `component` and `event_prefix` are passed in as LITERALS read out of the
 * roster — never derived as `cognition.${id}` here. Perception writes under the
 * bare `perception` component with `perception.run_*` event names, so a derived
 * namespace would report the single healthiest instance as never having run.
 * MAINTAINING's L-857 row states the rule.
 *
 * ORDERING NOTE: `event_log.created_at` holds BOTH `YYYY-MM-DD HH:MM:SS` and
 * ISO-8601 `…THH:MM:SS.sssZ` forms (measured on a live brain). Plain string
 * ordering puts every space-form row before every ISO-form row WITHIN a shared
 * date, because `' ' < 'T'`. `datetime()` normalises both, so the ORDER BY goes
 * through it; the raw value is still what is RETURNED, so no timestamp is
 * silently reformatted for the operator.
 */
export function readInstanceRunSignals(
  component: string,
  eventPrefix: string,
  hostname: string,
): CognitionRunSignals {
  const empty: CognitionRunSignals = {
    last_terminal_at: null,
    last_terminal_name: null,
    last_terminal_any_host_at: null,
    runs_today: 0,
  };
  return withReadonlyBrain<CognitionRunSignals>(empty, (handle) => {
    if (!tableExists(handle, "event_log")) return empty;

    const terminals = [
      `${eventPrefix}.run_succeeded`,
      `${eventPrefix}.run_failed`,
      `${eventPrefix}.run_skipped`,
    ];

    const thisHost = handle
      .prepare(
        `SELECT event_name, created_at FROM event_log
          WHERE component = ? AND event_name IN (?, ?, ?)
            AND machine_hostname = ?
          ORDER BY datetime(created_at) DESC LIMIT 1`,
      )
      .get(component, ...terminals, hostname) as
      | { event_name: string; created_at: string }
      | undefined;

    const anyHost = handle
      .prepare(
        `SELECT created_at FROM event_log
          WHERE component = ? AND event_name IN (?, ?, ?)
          ORDER BY datetime(created_at) DESC LIMIT 1`,
      )
      .get(component, ...terminals) as { created_at: string } | undefined;

    const today = handle
      .prepare(
        `SELECT COUNT(*) AS n FROM event_log
          WHERE component = ? AND event_name = ?
            AND machine_hostname = ?
            AND date(datetime(created_at)) = date('now')`,
      )
      .get(component, `${eventPrefix}.run_started`, hostname) as { n: number };

    return {
      last_terminal_at: thisHost?.created_at ?? null,
      last_terminal_name: thisHost?.event_name ?? null,
      last_terminal_any_host_at: anyHost?.created_at ?? null,
      runs_today: today.n,
    };
  });
}

/** TD-327 — the retention floor of the local `event_log`. */
export function readEventLogFloor(): string | null {
  return withReadonlyBrain<string | null>(null, (handle) => {
    if (!tableExists(handle, "event_log")) return null;
    const row = handle
      .prepare(`SELECT MIN(datetime(created_at)) AS oldest FROM event_log`)
      .get() as { oldest: string | null };
    return row.oldest ?? null;
  });
}

/**
 * TD-327 — the `schedules` + `schedule_runs` cross-check for one schedule NAME.
 *
 * Neither table is purged, which is what makes this the antidote to the 30-day
 * `event_log` window: an instance with no events at all is still distinguishable
 * from one that never existed if its schedule row is present and overdue.
 *
 * `schedules` is queried by NAME and the result is a COUNT, not a single row.
 * The bootstrap's idempotency check is `WHERE name = ?` while the table syncs on
 * a per-machine random `id`, so two brains each keep their own row under the
 * same name — a duplicate pair was measured on this brain. Reporting the count
 * makes a recurrence visible immediately.
 */
export interface CognitionScheduleRead {
  /** How many `schedules` rows carry this name. 0 means the schedule is absent. */
  rows: number;
  /** True when ANY matching row is enabled. */
  enabled: boolean;
  /** The earliest `next_run_at` across matching rows. */
  next_run_at: string | null;
  /** An OPEN `status='running'` run's id, if any. */
  open_run_id: string | null;
  /** That run's `started_at`. */
  open_run_started_at: string | null;
}

export function readScheduleSignals(name: string): CognitionScheduleRead {
  const empty: CognitionScheduleRead = {
    rows: 0,
    enabled: false,
    next_run_at: null,
    open_run_id: null,
    open_run_started_at: null,
  };
  return withReadonlyBrain<CognitionScheduleRead>(empty, (handle) => {
    if (!tableExists(handle, "schedules")) return empty;

    const scheduleRows = handle
      .prepare(
        `SELECT id, enabled, next_run_at FROM schedules WHERE name = ?`,
      )
      .all(name) as Array<{
      id: string;
      enabled: number;
      next_run_at: string | null;
    }>;

    if (scheduleRows.length === 0) return empty;

    const nextRuns = scheduleRows
      .map((r) => r.next_run_at)
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .sort();

    let openId: string | null = null;
    let openStarted: string | null = null;
    if (tableExists(handle, "schedule_runs")) {
      const placeholders = scheduleRows.map(() => "?").join(", ");
      const open = handle
        .prepare(
          `SELECT id, started_at FROM schedule_runs
            WHERE schedule_id IN (${placeholders}) AND status = 'running'
            ORDER BY datetime(started_at) ASC LIMIT 1`,
        )
        .get(...scheduleRows.map((r) => r.id)) as
        | { id: string; started_at: string }
        | undefined;
      openId = open?.id ?? null;
      openStarted = open?.started_at ?? null;
    }

    return {
      rows: scheduleRows.length,
      enabled: scheduleRows.some((r) => r.enabled === 1),
      next_run_at: nextRuns[0] ?? null,
      open_run_id: openId,
      open_run_started_at: openStarted,
    };
  });
}

/**
 * TD-327 — count the rows an instance's DECLARED output predicate selects.
 *
 * The declaration is prose-shaped by design (`suggestions[source_module='arbiter']`
 * reads as documentation in the extractor file and in `docs/COGNITION.md`), so
 * this parses the countable subset of that shape and returns `null` for the
 * rest. `subconscious` names an OPEN `source_module` — the LLM chooses it — and
 * therefore has no fixed predicate; `null` is the honest answer there rather
 * than a number that means something other than what its label says.
 *
 * The table is checked against an ALLOWLIST and the column against a strict
 * identifier pattern before either is interpolated; the VALUE is always bound.
 * Both are read out of a table the brain writes, but "the input came from our
 * own DB" is not a reason to interpolate it unchecked.
 */
const OUTPUT_TABLE_ALLOWLIST = new Set(["suggestions", "learnings", "entity_edges"]);

export function readOutputCounts(outputExpr: string): number | null {
  const m = /^([a-z_]+)\[([a-z_]+)='([^']*)'\]$/.exec(outputExpr.trim());
  if (m === null) return null;
  const [, table, column, value] = m;
  if (!OUTPUT_TABLE_ALLOWLIST.has(table)) return null;

  return withReadonlyBrain<number | null>(null, (handle) => {
    if (!tableExists(handle, table)) return null;
    if (!tableColumns(handle, table).has(column)) return null;
    const row = handle
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
      .get(value) as { n: number };
    return row.n;
  });
}

// ---------------------------------------------------------------------------
// FR-268 — the ceremony record: WRITE door (`igris ceremony`) and the KPI READ
// door (`igris kpi`). Two doors, not a flipped one (TD-319).
// ---------------------------------------------------------------------------

/** Input for {@link ceremonyEventWrite}. No timestamp: `created_at` is the DB clock. */
export interface CeremonyEventWriteInput {
  project: string;
  ceremony: string;
  event_type: "start" | "stop";
  machine_hostname: string;
  instance_id?: string | null;
  brief_id?: string | null;
}

/** What {@link ceremonyEventWrite} returns — every field READ BACK from the row. */
export interface CeremonyEventWriteResult {
  id: number;
  created_at: string;
  /** stop: whether an open start was found; start: null. */
  paired: boolean | null;
  paired_start_id: number | null;
  /** SQL-computed on a paired stop; NULL otherwise — never 0. */
  duration_ms: number | null;
}

/**
 * Duration computed IN SQL from the brain's own clock — a verbatim mirror of
 * `brain-mcp-server/src/tools/agent_events.ts:269-270` (`DURATION_FROM_START_SQL`)
 * with the table renamed. One clock for both ends of the bracket; binds the
 * start id.
 */
const CEREMONY_DURATION_FROM_START_SQL =
  "CAST((julianday('now') - julianday((SELECT created_at FROM ceremony_events WHERE id = ?))) * 86400000 AS INTEGER)";

/**
 * The latest open `start` for `(project, ceremony, machine_hostname)` — the
 * start no later `stop` of the same key has closed. Mirror of
 * `brain-mcp-server/src/tools/agent_events.ts:172-189` (`findOpenStart`), keyed
 * by host rather than instance because `boot`'s start predates the instance
 * mint. Any later stop closes EVERY earlier start of the key, so an orphaned
 * start is never paired with a much later stop.
 *
 * Known limitation (the FR-267 class): two concurrent same-ceremony runs for
 * one project on one host may mis-pair — counts stay right, durations may swap.
 */
function findOpenCeremonyStart(
  handle: Database.Database,
  project: string,
  ceremony: string,
  machineHostname: string,
): { id: number; created_at: string } | undefined {
  return handle
    .prepare(
      `SELECT s.id, s.created_at FROM ceremony_events s
        WHERE s.event_type = 'start' AND s.project = ? AND s.ceremony = ? AND s.machine_hostname = ?
          AND NOT EXISTS (SELECT 1 FROM ceremony_events e
                           WHERE e.event_type = 'stop' AND e.project = s.project AND e.ceremony = s.ceremony
                             AND e.machine_hostname = s.machine_hostname AND e.id > s.id)
        ORDER BY s.id DESC LIMIT 1`,
    )
    .get(project, ceremony, machineHostname) as { id: number; created_at: string } | undefined;
}

/**
 * Write one ceremony stamp (FR-268). The WRITE door: `getDb()`, create-never —
 * a brain without `ceremony_events` (older than instances v4) throws
 * {@link BrainTableMissingError} and the verb degrades; it never CREATEs.
 *
 * `created_at` is the row default (`datetime('now')`, the DB clock, UTC);
 * `duration_ms` on a stop is computed IN SQL from the paired open start's
 * `created_at` and NULL when no start is open (never 0 — §18.12). The caller
 * supplies only what it alone knows: the names, the host, an instance id and
 * a brief id when it has them.
 */
export function ceremonyEventWrite(input: CeremonyEventWriteInput): CeremonyEventWriteResult {
  const handle = getDb();
  if (!tableExists(handle, "ceremony_events")) {
    throw new BrainTableMissingError("ceremony_events");
  }
  const instanceId = input.instance_id ?? null;
  const briefId = input.brief_id ?? null;

  let id: number;
  let paired: boolean | null = null;
  let pairedStartId: number | null = null;
  if (input.event_type === "start") {
    const info = handle
      .prepare(
        `INSERT INTO ceremony_events (project, ceremony, event_type, machine_hostname, instance_id, brief_id)
         VALUES (?, ?, 'start', ?, ?, ?)`,
      )
      .run(input.project, input.ceremony, input.machine_hostname, instanceId, briefId);
    id = Number(info.lastInsertRowid);
  } else {
    const open = findOpenCeremonyStart(handle, input.project, input.ceremony, input.machine_hostname);
    paired = open !== undefined;
    pairedStartId = open?.id ?? null;
    const info = open
      ? handle
          .prepare(
            `INSERT INTO ceremony_events (project, ceremony, event_type, machine_hostname, instance_id, brief_id, duration_ms)
             VALUES (?, ?, 'stop', ?, ?, ?, ${CEREMONY_DURATION_FROM_START_SQL})`,
          )
          .run(input.project, input.ceremony, input.machine_hostname, instanceId, briefId, open.id)
      : handle
          .prepare(
            `INSERT INTO ceremony_events (project, ceremony, event_type, machine_hostname, instance_id, brief_id, duration_ms)
             VALUES (?, ?, 'stop', ?, ?, ?, NULL)`,
          )
          .run(input.project, input.ceremony, input.machine_hostname, instanceId, briefId);
    id = Number(info.lastInsertRowid);
  }

  // Read back (L-1248): the digest echoes the ROW, not what we meant to write.
  const row = handle
    .prepare("SELECT id, created_at, duration_ms FROM ceremony_events WHERE id = ?")
    .get(id) as { id: number; created_at: string; duration_ms: number | null };
  return {
    id: row.id,
    created_at: row.created_at,
    paired,
    paired_start_id: pairedStartId,
    duration_ms: row.duration_ms,
  };
}

/**
 * The KPI digest through the READ-ONLY door (`openBrainReadonly`,
 * `query_only = ON`). An absent brain file yields the absent digest; a brain
 * missing `hunt_runs` / `ceremony_events` degrades inside `buildKpiDigest`
 * with the missing object named. Never writes — `kpi-read.test.ts` pins the
 * file's sha256 / mtime / size across a full read.
 */
export function readKpiDigest(opts: KpiReadOptions): KpiDigest {
  return withReadonlyBrain<KpiDigest>(absentKpiDigest(opts), (handle) => buildKpiDigest(handle, opts));
}
