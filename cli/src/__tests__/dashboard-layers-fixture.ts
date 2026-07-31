/**
 * FR-240 — the shared brain fixture for the layer-endpoint suites.
 *
 * NOT a test file. It exists so `dashboard-layers-endpoint.test.ts`,
 * `dashboard-learnings-search.test.ts` and `dashboard-readonly.test.ts` seed the
 * SAME brain: three suites with three hand-rolled fixtures would drift, and the
 * read-only gate has to crawl exactly the rows the endpoint gate asserts.
 *
 * THE DDL IS REPRODUCED, NOT IMPORTED. `cli/` and `brain-mcp-server/` are
 * separate npm packages with ZERO cross-imports — the constraint stated in
 * `brain-db.ts`'s header and in `architecture_map.md`. Every statement below is
 * copied from its owning migration and cited. A schema change brain-side must
 * sweep this file; the tests fail loudly (a missing column is a throw, not a
 * silent empty), which is the intended coupling.
 *
 * FIXTURE DESIGN — DISAGREEING PARTITIONS (G-EP-1). No two filter values select
 * the same row set, so no assertion here can pass with a WHERE clause deleted.
 * The learnings corpus additionally contains a ZERO-LEXICAL-OVERLAP row for the
 * AC #2 recall gates.
 *
 * ⚠ THIS FILE MUST STAY IMPORT-FREE apart from `better-sqlite3` and node
 * builtins. `cli/scripts/browser-gate.mjs` TRANSPILES it with `ts.transpileModule`
 * and evaluates the result through `node --input-type=module -e`, so it seeds the
 * same rows the vitest suites assert on. `-e` code has no file path, so ANY
 * relative import here resolves against the wrong directory and kills the whole
 * browser gate with `ERR_MODULE_NOT_FOUND`. Measured during the FR-240 warden
 * pass, by adding one — the shared hermetic-embeddings guard, which now lives in
 * its own `hermetic-embeddings.ts` for exactly this reason.
 *
 * @module __tests__/dashboard-layers-fixture
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** `projects` — db.ts:v1. */
const DDL_PROJECTS = `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
    tech_stack TEXT DEFAULT '', archetype TEXT DEFAULT 'unclassified',
    igris_version TEXT DEFAULT '7.0.0',
    status TEXT DEFAULT 'active' CHECK (status IN ('active','archived','inactive')),
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_session_at TEXT, metadata TEXT DEFAULT '{}'
  );
`;

/** `brief_status` — db.ts:283 (v2) + the v-later brief_type/effort/phase columns. */
const DDL_BRIEF_STATUS = `
  CREATE TABLE brief_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL, brief_id TEXT NOT NULL, brief_type TEXT,
    title TEXT NOT NULL, status TEXT NOT NULL, priority TEXT,
    effort TEXT, phase TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_brief_status_unique ON brief_status(project, brief_id);
`;

/** `brief_files` — db.ts:380 (v6). */
const DDL_BRIEF_FILES = `
  CREATE TABLE brief_files (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, brief_id TEXT NOT NULL,
    filename TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project, brief_id)
  );
`;

/** `learnings` + FTS5 — db.ts:v1 through v16. */
const DDL_LEARNINGS = `
  CREATE TABLE learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('pattern','decision','discovery','mistake','optimization')),
    title TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT DEFAULT '', tech_stack TEXT DEFAULT '',
    scope TEXT DEFAULT 'local' CHECK (scope IN ('local','global')),
    source_brief TEXT DEFAULT '',
    confidence REAL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER DEFAULT 0, last_accessed_at TEXT,
    provenance TEXT NOT NULL DEFAULT 'observed'
      CHECK(provenance IN ('observed','inferred','synthesized','ambiguous','human_asserted')),
    review_status TEXT NOT NULL DEFAULT 'approved',
    source_extractor TEXT NOT NULL DEFAULT 'manual',
    -- FR-241: perception/schema.ts:106 (TD-086 dedup tracking) and
    -- janitor/schema.ts:109 (FR-116 M3 soft-delete). Mirrored here because
    -- listLearnings now projects both, and they are what let the triage
    -- surface tell a SOFT reject from a HARD one before it fires.
    seen_again_count INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    promoted_to_doc TEXT,
    deleted_at TEXT
  );
  CREATE VIRTUAL TABLE learnings_fts USING fts5(
    title, content, tags, tech_stack, content=learnings, content_rowid=id
  );
  CREATE TRIGGER learnings_ai AFTER INSERT ON learnings BEGIN
    INSERT INTO learnings_fts(rowid, title, content, tags, tech_stack)
    VALUES (new.id, new.title, new.content, new.tags, new.tech_stack);
  END;
`;

/** `goals` — engine/components/goals/schema.ts v1. */
const DDL_GOALS = `
  CREATE TABLE goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id TEXT NOT NULL UNIQUE, project_slug TEXT,
    title TEXT NOT NULL, description TEXT, outcome TEXT NOT NULL,
    deadline TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active','achieved','abandoned','deferred')),
    priority TEXT NOT NULL DEFAULT 'P2-Medium',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    achieved_at TEXT, metadata TEXT NOT NULL DEFAULT '{}'
  );
`;

/** `entity_edges` — engine/components/edges/schema.ts v1. */
const DDL_EDGES = `
  CREATE TABLE entity_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_type TEXT NOT NULL, from_id TEXT NOT NULL,
    to_type TEXT NOT NULL, to_id TEXT NOT NULL, edge_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    provenance TEXT NOT NULL DEFAULT 'observed',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT NOT NULL DEFAULT '{}',
    UNIQUE(from_type, from_id, to_type, to_id, edge_type)
  );
`;

/** `instances` — db.ts:328. Needed by `/api/summary`, which the crawl hits. */
const DDL_INSTANCES = `
  CREATE TABLE instances (
    id TEXT PRIMARY KEY, machine_hostname TEXT NOT NULL, machine_os TEXT,
    project_slug TEXT, project_path TEXT, current_brief TEXT,
    current_phase TEXT, current_task TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active','idle','stale')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT DEFAULT '{}'
  );
`;

/**
 * `suggestions` — engine/components/subconscious/schema.ts (FR-106) plus the
 * FR-118 M2 columns. Added by FR-241 so the read-only crawl covers
 * `/api/suggestions` with REAL ROWS: a hash-stability gate over an endpoint
 * that degraded to empty would pass for the wrong reason.
 */
const DDL_SUGGESTIONS = `
  CREATE TABLE suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_module TEXT NOT NULL,
    project_slug TEXT,
    title TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '{}',
    priority TEXT NOT NULL DEFAULT 'medium'
      CHECK (priority IN ('high','medium','low')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','dismissed','acted')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT, dismissed_at TEXT, dismissed_reason TEXT,
    acted_at TEXT, acted_brief_id TEXT,
    confidence REAL, suggested_action TEXT,
    type_inferred INTEGER NOT NULL DEFAULT 0
  );
`;

/** Ids the suites assert on, named so an assertion reads as a claim. */
export const FIXTURE = {
  projects: ["demo", "other"],
  /** `BR-001` exists in BOTH projects with different titles — the BR-078 case. */
  duplicatedBriefId: "BR-001",
  /**
   * Learning 3 shares NO token with the query "wrapper". It is the row that can
   * only arrive through the vector arm.
   */
  zeroOverlapLearningId: 3,
  pendingLearningId: 4,
  /** FR-241 — the seeded suggestion queue, by status. */
  suggestions: {
    pendingCount: 3,
    dismissedCount: 1,
    /** `demo` has 2 pending, `other` has 1 — an ASYMMETRIC scope split. */
    demoPendingCount: 2,
    /** Counted from the data, never enumerated in code (L-967). */
    sourceModules: ["gap", "janitor", "missing_followup"],
  },
} as const;

/**
 * Seed a complete layer-view brain at `dbPath`.
 *
 * WAL is deliberately enabled: the read-only gate has to crawl a WAL brain,
 * because the `-wal`/`-shm` sidecars are exactly where an accidental write
 * would land without touching the `.db` file's own bytes.
 *
 * THE CONSEQUENCE, STATED (learning 1095). Seeding WAL means the read-only
 * crawl's `after.db_sha === before.db_sha` assertion can NEVER exercise a
 * journal-mode FLIP: the brain is already in the mode every writer that touches
 * it would set it to. On a `journal_mode = delete` brain — SQLite's default, and
 * the state of any brain no WAL-setting writer has opened — `registry.ts` and
 * `brain-db.ts` both `pragma("journal_mode = WAL")` on open, which rewrites the
 * `.db` header, and `registry.ts` also runs `CREATE TABLE IF NOT EXISTS
 * projects`. That gap is covered by **G-RO-5 in `dashboard-readonly.test.ts`**,
 * which converts this fixture to `delete` mode and pins both behaviours. Do not
 * change the mode here to close it — the WAL crawl and the `delete`-mode pins
 * cover different things and the suite needs both.
 */
export function seedLayerBrain(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(
    DDL_PROJECTS +
      DDL_BRIEF_STATUS +
      DDL_BRIEF_FILES +
      DDL_LEARNINGS +
      DDL_GOALS +
      DDL_EDGES +
      DDL_INSTANCES +
      DDL_SUGGESTIONS,
  );

  // --- projects ----------------------------------------------------------
  const insProject = db.prepare(
    `INSERT INTO projects (slug, name, path, status, last_session_at)
     VALUES (?, ?, ?, 'active', ?)`,
  );
  insProject.run("demo", "Demo", "/tmp/demo", "2026-07-28 09:00:00");
  insProject.run("other", "Other", "/tmp/other", "2026-07-20 09:00:00");

  // --- briefs ------------------------------------------------------------
  //  id     | project | type      | status      | priority  | effort | updated
  //  FR-240 | demo    | feature   | In Progress | P1-High   | XL     | 07-30
  //  TD-312 | demo    | tech-debt | Pending     | P2-Medium | S      | 07-29
  //  BR-001 | demo    | bug       | Done        | P1-High   | M      | 07-28
  //  BR-001 | other   | bug       | Pending     | P3-Low    | S      | 07-27
  const insBrief = db.prepare(
    `INSERT INTO brief_status
       (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insBrief.run("demo", "FR-240", "feature", "Dashboard layer views", "In Progress", "P1-High", "XL", "BUILDING", "2026-07-30 09:00:00");
  insBrief.run("demo", "TD-312", "tech-debt", "CI does not run brain vitest", "Pending", "P2-Medium", "S", null, "2026-07-29 09:00:00");
  insBrief.run("demo", "BR-001", "bug", "Demo-project bug", "Done", "P1-High", "M", null, "2026-07-28 09:00:00");
  insBrief.run("other", "BR-001", "bug", "Other-project bug", "Pending", "P3-Low", "S", null, "2026-07-27 09:00:00");

  db.prepare(
    `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "bf-1",
    "demo",
    "FR-240",
    "FR-240.md",
    "# FR-240\n\nMount four read-only browse views in the dashboard shell.",
    "hash-fr240",
    "2026-07-30 08:00:00",
  );

  // --- learnings ---------------------------------------------------------
  //  id | project | category  | scope  | provenance | review_status
  //   1 | demo    | pattern   | global | observed   | approved       "wrapper"
  //   2 | demo    | mistake   | local  | inferred   | approved       "wrapper"
  //   3 | other   | decision  | local  | observed   | approved       NO overlap
  //   4 | demo    | discovery | local  | inferred   | pending_review "wrapper"
  const insLearning = db.prepare(
    `INSERT INTO learnings
       (project, category, title, content, tags, tech_stack, scope, source_brief,
        confidence, created_at, updated_at, access_count, provenance,
        review_status, source_extractor, promoted_to_doc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insLearning.run("demo", "pattern", "Wrapper split", "The MCP handler becomes a thin wrapper over the pure reader.", "brain", "typescript", "global", "FR-237", 0.9, "2026-07-01 10:00:00", "2026-07-01 10:00:00", 5, "observed", "approved", "manual", null);
  insLearning.run("demo", "mistake", "Wrapper drift", "A wrapper that reimplements its reader drifts silently.", "brain", "typescript", "local", "FR-240", 0.8, "2026-07-02 10:00:00", "2026-07-02 10:00:00", 0, "inferred", "approved", "manual", null);
  insLearning.run("other", "decision", "Ceramic kiln schedule", "Bisque firing peaks at cone 04 overnight.", "pottery", "", "local", "", 0.7, "2026-07-03 10:00:00", "2026-07-03 10:00:00", 2, "observed", "approved", "manual", "doc.md#1");
  insLearning.run("demo", "discovery", "Pending wrapper note", "A pending wrapper candidate awaiting review.", "perception", "", "local", "", 0.4, "2026-07-04 10:00:00", "2026-07-04 10:00:00", 0, "inferred", "pending_review", "llm", null);

  // --- goals -------------------------------------------------------------
  const insGoal = db.prepare(
    `INSERT INTO goals
       (goal_id, project_slug, title, description, outcome, deadline, status,
        priority, created_at, updated_at, achieved_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insGoal.run("GL-001", "demo", "Ship the lens", null, "Browsable brain", "2026-08-31", "active", "P1-High", "2026-06-01 10:00:00", "2026-06-01 10:00:00", null, "{}");
  insGoal.run("GL-002", "demo", "Undated goal", null, "Sorts last", null, "active", "P2-Medium", "2026-06-02 10:00:00", "2026-06-02 10:00:00", null, "{}");
  insGoal.run("GL-003", "other", "Achieved goal", null, "Done", "2026-05-01", "achieved", "P3-Low", "2026-06-03 10:00:00", "2026-06-03 10:00:00", "2026-05-01 12:00:00", "{}");

  const insEdge = db.prepare(
    `INSERT INTO entity_edges
       (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insEdge.run("brief", "FR-240", "goal", "GL-001", "serves_goal", 1.0, "observed", "{}");
  // Soft-deleted — must be invisible to the count AND to the detail list.
  insEdge.run("brief", "TD-312", "goal", "GL-001", "serves_goal", 1.0, "observed", '{"deleted":1}');
  insEdge.run("learning", "1", "goal", "GL-001", "serves_goal", 1.0, "observed", "{}");

  db.prepare(
    `INSERT INTO instances (id, machine_hostname, project_slug, status)
     VALUES ('i-1', 'host', 'demo', 'active')`,
  ).run();

  // --- suggestions (FR-241) ----------------------------------------------
  //  project | module           | priority | status    | created
  //  demo    | gap              | high     | pending   | 07-01   <- oldest high
  //  demo    | janitor          | low      | pending   | 07-30   <- newest low
  //  other   | gap              | medium   | pending   | 07-15
  //  demo    | missing_followup | high     | dismissed | 07-10
  //
  // Deliberately ASYMMETRIC on every dimension: two projects with different
  // counts, three modules with different counts, and a priority band whose
  // ordering DISAGREES with created_at ordering — so the `CASE priority`
  // collation is observable rather than coincidental, and a facet map computed
  // over the wrong WHERE clause produces visibly wrong numbers.
  const insSuggestion = db.prepare(
    `INSERT INTO suggestions
       (source_module, project_slug, title, evidence, priority, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insSuggestion.run("gap", "demo", "Untracked AC in FR-240", '{"kind":"gap"}', "high", "pending", "2026-07-01 09:00:00");
  insSuggestion.run("janitor", "demo", "Two near-duplicate learnings", '{"kind":"dupe"}', "low", "pending", "2026-07-30 09:00:00");
  insSuggestion.run("gap", "other", "Brief with no goal edge", '{"kind":"gap"}', "medium", "pending", "2026-07-15 09:00:00");
  insSuggestion.run("missing_followup", "demo", "Already handled", '{"kind":"followup"}', "high", "dismissed", "2026-07-10 09:00:00");

  db.close();
}

/**
 * Every FR-240 endpoint path, with a query string that returns real data on the
 * fixture above.
 *
 * Shared because the read-only crawl must hit EXACTLY the surface the endpoint
 * suite asserts — a hash-stability gate over a subset of the endpoints proves
 * nothing about the ones it skipped.
 */
export const LAYER_PATHS: readonly string[] = [
  "/api/briefs",
  "/api/briefs?project=demo&status=Pending",
  "/api/brief?project=demo&id=FR-240",
  "/api/brief?project=other&id=BR-001",
  "/api/learnings",
  "/api/learnings?project=demo&category=mistake",
  "/api/learnings?review_status=pending_review",
  "/api/learnings/search?q=wrapper",
  "/api/learning?id=1",
  "/api/context-docs?project=demo",
  "/api/goals",
  "/api/goals?project=demo&status=active",
  "/api/goal?id=GL-001",
  // FR-241 — the triage READ half. It goes through the SAME `openReadContext()`
  // door as the nine above, so adding it makes the read-only crawl STRICTER
  // rather than routing around it: the brief that introduces a write path is
  // the brief that most owes the digest gate a wider surface.
  "/api/suggestions",
  "/api/suggestions?project=demo&status=pending",
  "/api/suggestions?source_module=gap",
];
