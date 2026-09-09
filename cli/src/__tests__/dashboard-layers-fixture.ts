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
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * `briefs_fts` — db.ts v23 (FR-246). CONTENTLESS, mirroring production.
 *
 * **This fixture creates the index ITSELF, on purpose.** `dashboard-readonly`'s
 * G-RO-1 asserts the fixture DB is byte-for-byte unchanged after the whole
 * endpoint crawl; if `briefs_fts` only appeared because a migration ran during
 * a read, that check would go red — which is the gate working, not a fixture
 * bug. The triggers are NOT mirrored: nothing writes to these tables during a
 * read-only crawl, and a trigger here would be maintenance with no test.
 */
const DDL_BRIEFS_FTS = `
  CREATE VIRTUAL TABLE briefs_fts USING fts5(
    brief_id, title, content, content='', contentless_delete=1
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

/**
 * `entity_edges` — engine/components/edges/schema.ts **v4** (BR-083).
 *
 * THIS FIXTURE MUST MIRROR THE SHIPPED SCHEMA, and it silently did not.
 * It sat at v1 while `goals/read.ts` began selecting `e.from_project`, so the
 * whole query failed and `/api/goal` returned `goal: undefined` — a fixture-only
 * failure that looks exactly like a broken reader. Caught by two endpoint tests
 * whose assertions were about serving briefs, not about schema drift.
 *
 * The UNIQUE is an EXPRESSION INDEX over `COALESCE(project, '')`, not a
 * table-level UNIQUE, and that is load-bearing rather than stylistic: NULL is
 * DISTINCT from NULL in a SQLite UNIQUE, so `UNIQUE(..., from_project, ...)`
 * would let two identical project-LESS edges (a `concept -> concept`, a synapse
 * inference) both insert and quietly break idempotency. Copy the shape from
 * `schema.ts` v4 when it changes; do not re-derive it here.
 */
const DDL_EDGES = `
  CREATE TABLE entity_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_type TEXT NOT NULL, from_id TEXT NOT NULL,
    to_type TEXT NOT NULL, to_id TEXT NOT NULL, edge_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    provenance TEXT NOT NULL DEFAULT 'observed',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT NOT NULL DEFAULT '{}',
    from_project TEXT,
    to_project   TEXT
  );
  CREATE UNIQUE INDEX idx_entity_edges_identity ON entity_edges(
    from_type, from_id, to_type, to_id, edge_type,
    COALESCE(from_project, ''), COALESCE(to_project, '')
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
    type_inferred INTEGER NOT NULL DEFAULT 0,
    -- TD-440 (subconscious v5). Mirrored here rather than left off, because a
    -- fixture missing the column would exercise the reader's PRE-v5
    -- degradation path while claiming to test the producer facet.
    dedupe_key TEXT, entity_key TEXT,
    seen_count INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT,
    recurrence_titles TEXT NOT NULL DEFAULT '[]',
    source_instance TEXT
  );
`;

/**
 * FR-248 — schema objects `seedLayerBrain` can be told NOT to create.
 *
 * A UNION, not `string`, so a typo is a compile error rather than a silently
 * complete world in which the "the layer is unavailable" gate passes because
 * the layer was never disabled.
 */
export type OmittableObject = "briefs_fts";

/** FR-248 — {@link seedLayerBrain}'s options. Every field is opt-in. */
export interface SeedLayerBrainOptions {
  /**
   * Schema objects to leave out.
   *
   * `briefs_fts` is the one that matters: `db.ts` creates it at **v23**, so a
   * brain that has not booted that migration really does have no lexical arm
   * for briefs. Omitting it here reproduces that production state exactly —
   * no mock, no monkey-patch — and it is what makes the AC-4 "this layer is
   * unavailable" assertion reachable.
   */
  omit?: readonly OmittableObject[];
  /**
   * FR-248 — add the CROSS-LAYER corpus the fused-search gates need.
   *
   * OPT-IN, and that is not timidity. `dashboard-layers-fixture.ts` is shared
   * by four suites plus the browser gate, and several of their assertions are
   * exact arrays and exact counts over the seeded population
   * (`FIXTURE.suggestions.*`, the `GL-001/GL-002/GL-003` ordering list, the
   * brief-key lists). Adding rows to the DEFAULT world would silently re-scope
   * every one of them — the TD-326 failure, where a widened fixture left two
   * gates green while measuring a different population. Behind a flag, the
   * default world stays byte-identical and the new rows exist only for the
   * suite that asked for them.
   *
   * The corpus shares ONE token, `telemetry`, which appears in no default row,
   * across FOUR layers with TWO rows each. That is what makes the fused list
   * interleave observable: with one row per layer any ordering looks like a
   * round-robin.
   */
  fusion?: boolean;
}

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
    /** EVERY pending row, project-bearing and project-less alike. */
    pendingCount: 6,
    dismissedCount: 1,
    /** `demo` has 2 pending, `other` has 1 — an ASYMMETRIC scope split. */
    demoPendingCount: 2,
    /**
     * TD-326 — pending rows with `project_slug IS NULL`. NON-EMPTY on purpose:
     * a gate for "the hidden population is surfaced" that ran against zero
     * project-less rows is this brief's named vacuous gate.
     */
    brainLevelPendingCount: 3,
    /** ...of which two are `edge_inference` and one is `janitor`. */
    brainLevelEdgeInferenceCount: 2,
    /** Counted from the data, never enumerated in code (L-967). */
    sourceModules: ["gap", "janitor", "missing_followup", "edge_inference"],
  },
  /** FR-248 — the `fusion: true` corpus. See {@link SeedLayerBrainOptions.fusion}. */
  fusion: {
    /** The one token the cross-layer corpus shares. Absent from every default row. */
    token: "telemetry",
    /** Layers the corpus seeds, with two matching rows each. */
    layers: ["briefs", "learnings", "goals", "suggestions"],
    rowsPerLayer: 2,
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
 * the state of any brain no WAL-setting writer has opened — that flip is a real
 * write, and until TD-319 four GET paths performed it (`registry.ts` and
 * `brain-db.ts` both `pragma("journal_mode = WAL")` on their read-WRITE `getDb()`
 * handles, and `registry.ts` also runs `CREATE TABLE IF NOT EXISTS projects`).
 * Those doors still exist for the CLI writers; they are simply no longer
 * reachable from an endpoint. The gap is covered by **G-RO-5 in
 * `dashboard-readonly.test.ts`**, which converts this fixture to `delete` mode
 * and asserts the whole tier leaves it alone. Do not change the mode here to
 * close it — the WAL crawl and the `delete`-mode gates cover different things
 * and the suite needs both.
 *
 * FR-248 — `opts` IS ADDITIVE AND THE DEFAULT WORLD IS BYTE-IDENTICAL TO THE
 * ONE FR-241 SHIPPED. `seedLayerBrain(path)` with no second argument executes
 * the same DDL string and the same inserts in the same order; every branch
 * below is guarded by an option that defaults to off. That property is not
 * decorative — `dashboard-readonly.test.ts` hashes this file's bytes, and four
 * suites assert exact row sets over it.
 */
export function seedLayerBrain(
  dbPath: string,
  opts: SeedLayerBrainOptions = {},
): void {
  const omit = new Set<OmittableObject>(opts.omit ?? []);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(
    DDL_PROJECTS +
      DDL_BRIEF_STATUS +
      DDL_BRIEF_FILES +
      (omit.has("briefs_fts") ? "" : DDL_BRIEFS_FTS) +
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

  // FR-248 — the cross-layer corpus, seeded BEFORE the FTS backfill so the two
  // new briefs are indexed by the same statement v23 uses rather than by a
  // second one. Guarded by `opts.fusion`; see the option's docstring for why it
  // is not in the default world.
  if (opts.fusion === true) {
    insBrief.run("demo", "FR-248", "feature", "Telemetry sweep across layers", "Pending", "P1-High", "L", null, "2026-08-03 09:00:00");
    insBrief.run("demo", "TD-370", "tech-debt", "Telemetry counters drift", "Pending", "P2-Medium", "M", null, "2026-08-02 09:00:00");
  }

  // FR-246 — the BM25 arm's index, backfilled exactly the way v23 backfills it.
  // Note what this makes searchable that nothing else does: `bf-1`'s BODY. The
  // word "shell" appears in no brief TITLE.
  //
  // FR-248 — SKIPPED ENTIRELY when `briefs_fts` was omitted. The table is the
  // only thing this statement writes, so leaving it in would turn the omitted
  // world into a hard throw during seeding instead of the pre-v23 brain it is
  // supposed to be.
  if (!omit.has("briefs_fts")) {
    db.exec(`
      INSERT INTO briefs_fts(rowid, brief_id, title, content)
      SELECT bs.id, bs.brief_id, bs.title, COALESCE(bf.content, '')
        FROM brief_status bs
        LEFT JOIN brief_files bf
               ON bf.project = bs.project AND bf.brief_id = bs.brief_id;
    `);
  }

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

  // FR-248 — ids 5 and 6, seeded AFTER the four the other suites address by id
  // so `zeroOverlapLearningId: 3` and `pendingLearningId: 4` keep meaning what
  // they meant. Both `approved`, because the fused surface recalls the
  // conscious channel and a `pending_review` row here would contribute nothing
  // while looking like it should.
  if (opts.fusion === true) {
    insLearning.run("demo", "pattern", "Telemetry counters", "Telemetry counters are emitted per project, never per session.", "brain", "typescript", "local", "FR-248", 0.8, "2026-07-05 10:00:00", "2026-07-05 10:00:00", 0, "observed", "approved", "manual", null);
    insLearning.run("demo", "decision", "Telemetry scope", "Telemetry stays out of the read path.", "brain", "typescript", "local", "FR-248", 0.8, "2026-07-06 10:00:00", "2026-07-06 10:00:00", 0, "observed", "approved", "manual", null);
  }

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

  // FR-248. BOTH carry a deadline, and they differ: `listGoals` orders
  // deadline ASC nulls last, so GL-004 is rank 1 and GL-005 is rank 2 by
  // construction rather than by whichever the planner happened to emit first.
  // A fused-order assertion over rows whose within-layer rank is arbitrary
  // would be asserting the planner, not the fusion.
  if (opts.fusion === true) {
    insGoal.run("GL-004", "demo", "Telemetry rollout", "Ship telemetry counters", "Counters live", "2026-09-01", "active", "P1-High", "2026-06-04 10:00:00", "2026-06-04 10:00:00", null, "{}");
    insGoal.run("GL-005", "demo", "Telemetry retention", "Decide how long telemetry is kept", "Policy written", "2026-10-01", "active", "P2-Medium", "2026-06-05 10:00:00", "2026-06-05 10:00:00", null, "{}");
  }

  const insEdge = db.prepare(
    `INSERT INTO entity_edges
       (from_type, from_id, to_type, to_id, edge_type, confidence, provenance, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insEdge.run("brief", "FR-240", "goal", "GL-001", "serves_goal", 1.0, "observed", "{}");
  // Soft-deleted — must be invisible to the count AND to the detail list.
  insEdge.run("brief", "TD-312", "goal", "GL-001", "serves_goal", 1.0, "observed", '{"deleted":1}');
  insEdge.run("learning", "1", "goal", "GL-001", "serves_goal", 1.0, "observed", "{}");

  // --- instances ---------------------------------------------------------
  //  id  | project | status   what it makes observable
  //  i-1 | demo    | active   the SCOPED count
  //  i-2 | other   | active   the widening (BR-082: 1 -> 3 when scope clears)
  //  i-3 | NULL    | active   "everything" is STRICTLY more than "all projects"
  //  i-4 | demo    | idle     `status = 'active'` is still doing work
  //
  // `project_slug` is nullable with no FK (db.ts:328-340), so i-3 is a real
  // state rather than a contrived one — it is the TD-326 shape (a row that
  // belongs to no project) on the one table this dashboard page counts.
  const insInstance = db.prepare(
    `INSERT INTO instances (id, machine_hostname, project_slug, status)
     VALUES (?, 'host', ?, ?)`,
  );
  insInstance.run("i-1", "demo", "active");
  insInstance.run("i-2", "other", "active");
  insInstance.run("i-3", null, "active");
  insInstance.run("i-4", "demo", "idle");

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
  const insSuggestionStmt = db.prepare(
    `INSERT INTO suggestions
       (source_module, project_slug, title, evidence, priority, status, created_at,
        source_instance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  /**
   * TD-440 — which PRODUCER wrote each row. Derived from the module rather than
   * passed at every call site, so adding a row cannot silently leave it
   * unattributed. Deliberately many-to-one: `gap` and `missing_followup` are two
   * of the subconscious's 195 free-text labels (TD-437's audit, 2026-09-01),
   * and collapsing them to one producer is the whole point of the axis.
   */
  const producerOf = (module: string): string =>
    module === "edge_inference" ? "synapse" : module === "janitor" ? "janitor" : "subconscious";
  const insSuggestion = {
    run: (
      module: string,
      project: string | null,
      title: string,
      evidence: string,
      priority: string,
      status: string,
      created: string,
    ) =>
      insSuggestionStmt.run(
        module,
        project,
        title,
        evidence,
        priority,
        status,
        created,
        producerOf(module),
      ),
  };
  insSuggestion.run("gap", "demo", "Untracked AC in FR-240", '{"kind":"gap"}', "high", "pending", "2026-07-01 09:00:00");
  insSuggestion.run("janitor", "demo", "Two near-duplicate learnings", '{"kind":"dupe"}', "low", "pending", "2026-07-30 09:00:00");
  insSuggestion.run("gap", "other", "Brief with no goal edge", '{"kind":"gap"}', "medium", "pending", "2026-07-15 09:00:00");
  insSuggestion.run("missing_followup", "demo", "Already handled", '{"kind":"followup"}', "high", "dismissed", "2026-07-10 09:00:00");

  // --- TD-326: the project-less population -------------------------------
  //  project | module          | priority | status  | created
  //  NULL    | edge_inference  | medium   | pending | 07-25
  //  NULL    | edge_inference  | low      | pending | 07-26
  //  NULL    | janitor         | high     | pending | 07-27
  //
  // `project_slug` is NULLABLE on this table with no FK, and on the operator
  // brain 377 of 1,210 pending rows carry NULL — synapse's edge inferences,
  // which belong to the knowledge graph rather than to a project. A
  // project-scoped read can neither list them nor count them, which is the
  // whole of TD-326.
  //
  // THREE rows, spread over TWO modules on purpose: `facets.brain_level` keeps
  // the `source_module` clause and only drops the PROJECT one, so a count that
  // ignored `source_module` would read 3 where the right answer is 2, and a
  // count that also applied the caller's project would read 0.
  insSuggestion.run("edge_inference", null, "Edge: FR-240 -> GL-001 (inferred)", '{"kind":"edge"}', "medium", "pending", "2026-07-25 09:00:00");
  insSuggestion.run("edge_inference", null, "Edge: BR-001 -> learning 2 (inferred)", '{"kind":"edge"}', "low", "pending", "2026-07-26 09:00:00");
  insSuggestion.run("janitor", null, "Orphan graph node with no owner", '{"kind":"orphan"}', "high", "pending", "2026-07-27 09:00:00");

  // FR-248. `listSuggestions` orders by the `CASE priority` collation then
  // created_at, so `high` before `medium` fixes the within-layer rank the same
  // way the goals pair does. Both are `demo`-scoped: the fused surface's
  // `?project=` arm has to narrow them, and a project-less row would make that
  // narrowing untestable here (TD-326's population already covers the other
  // half).
  if (opts.fusion === true) {
    insSuggestion.run("gap", "demo", "Telemetry counter has no owner", '{"kind":"gap"}', "high", "pending", "2026-08-01 09:00:00");
    insSuggestion.run("janitor", "demo", "Telemetry rows never expire", '{"kind":"dupe"}', "medium", "pending", "2026-08-02 09:00:00");
  }

  db.close();
}

// ---------------------------------------------------------------------------
// FR-266 — the COGNITION world: a reproduction of the 2026-08-24 failure state
// ---------------------------------------------------------------------------

/**
 * The four cognition tables, mirrored VERBATIM from `cognition-health.test.ts`.
 *
 * Two fixtures for the same tables that drifted into different shapes would be
 * worse than one, so these strings are copied from that file rather than
 * re-invented. `IF NOT EXISTS` throughout because `seedCognitionBrain` is called
 * on a DB `seedLayerBrain` has already populated (the browser gate) as well as
 * on a bare one (the endpoint suite).
 *
 * `suggestions` and `learnings` — the OUTPUT tables `readOutputCounts` reads —
 * are deliberately NOT created here. `seedLayerBrain` already owns them, and
 * `readOutputCounts` returns `null` for a table that is absent, so the endpoint
 * suite gets a well-defined `output_rows: null` instead of a second, differently
 * shaped `learnings`.
 */
const DDL_COGNITION = `
  CREATE TABLE IF NOT EXISTS cognition_instances (
    id TEXT PRIMARY KEY, component TEXT NOT NULL, event_prefix TEXT NOT NULL,
    gate_keys TEXT NOT NULL, gate_default INTEGER NOT NULL DEFAULT 0,
    driver TEXT NOT NULL, driver_ref TEXT,
    output TEXT NOT NULL, produced TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT NOT NULL,
    component TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
    machine_hostname TEXT, project_slug TEXT, instance_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
    cron_expr TEXT NOT NULL, handler_type TEXT NOT NULL DEFAULT 'noop',
    handler_config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
    project_slug TEXT, tags TEXT DEFAULT '[]', max_retries INTEGER NOT NULL DEFAULT 0,
    timeout_ms INTEGER NOT NULL DEFAULT 30000, next_run_at TEXT, last_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS schedule_runs (
    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, status TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT,
    duration_ms INTEGER, result TEXT, error TEXT, attempt INTEGER NOT NULL DEFAULT 1
  );
`;

/**
 * The host this fixture seeds `event_log` under, and WHY IT IS THE REAL ONE.
 *
 * `event_log` is a SYNC table carrying `machine_hostname`, and the digest's run
 * signals are host-scoped on purpose: a VPS-born `run_succeeded` replicates
 * here, so an unscoped read would render a locally-wedged instance green.
 *
 * `GET /api/cognition` calls `buildCognitionHealthDigest()` with NO options,
 * because a health question is intrinsically about THIS machine and a hostname
 * override on a production endpoint would be a test seam in shipped code. So a
 * fixture whose events are to be VISIBLE to the endpoint must seed them under
 * `os.hostname()`. Seeded under any other host, every instance reads
 * `no_signal` and the whole failure reproduction collapses into one
 * undifferentiated verdict — which is not a fixture bug but the host scoping
 * working, and `dashboard-cognition-endpoint.test.ts` asserts exactly that with
 * {@link COGNITION_FOREIGN_HOST}.
 */
export const COGNITION_HOST = hostname();

/**
 * A host that is NOT this machine — the negative control for the scoping above.
 *
 * Seeding under this makes every terminal event invisible to the digest, which
 * is what proves {@link COGNITION_HOST} is load-bearing rather than incidental.
 */
export const COGNITION_FOREIGN_HOST = "vps-host-that-is-not-this-machine";

/**
 * FR-266 — what `seedCognitionBrain` builds, and what each row is FOR.
 *
 * Named so an assertion reads as a claim rather than as a magic string, and
 * exported so the endpoint suite, the panel render test and the browser gate all
 * assert against ONE table instead of three hand-copied ones.
 */
export const COGNITION_FIXTURE = {
  host: COGNITION_HOST,
  foreignHost: COGNITION_FOREIGN_HOST,
  /**
   * The EXPECTED verdict per instance, in projection order.
   *
   * This is the 2026-08-24 reading in the shape the CLASSIFIER actually
   * produces: one `failing`, one `wedged`, and the two instances the wedged one
   * drives reported as `blocked_upstream` rather than as silent. That is what
   * "3 cognition instances failing" looks like once the driver relationship is
   * resolved — and pointing an operator at `arbiter` instead of at `janitor` is
   * the exact mistake `classify()` exists to prevent.
   *
   * `cartographer` is DELIBERATELY `disabled` so AC-4's both sides — a failure
   * and an operator choice — live in ONE fixture and are compared in ONE render.
   */
  expected: [
    { id: "perception", status: "ok" },
    { id: "subconscious", status: "ok" },
    { id: "synapse", status: "failing" },
    { id: "janitor", status: "wedged" },
    { id: "arbiter", status: "blocked_upstream" },
    { id: "curator", status: "blocked_upstream" },
    { id: "cartographer", status: "disabled" },
    { id: "roadmap_drift", status: "ok" },
  ],
  /**
   * The EIGHTH instance, and the reason it is in the DEFAULT world rather than
   * behind a flag.
   *
   * `roadmap_drift` is an id no SHIPPED file in `cli/` or `cli/dashboard/`
   * mentions — it exists only in fixtures (`cognition-health.test.ts` and
   * `awaken-verbs.bats` already use it for the same purpose). A panel that
   * renders it is a panel deriving its roster from the payload; a hardcoded
   * roster of the seven real instances cannot render it, which is what makes
   * AC-3 falsifiable rather than merely plausible.
   */
  derivedInstanceId: "roadmap_drift",
  /** The gate that switches `cartographer` off — rendered VERBATIM by the panel. */
  disabledGate: "cognition.janitor.cluster.enabled",
  /** The schedule `janitor` is wedged on, and the id of the run wedging it. */
  wedgedSchedule: "janitor_engine",
  wedgedRunId: "run-open-janitor",
} as const;

/** ISO timestamp `n` days before now. */
function cognitionDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/**
 * Seed the FR-266 cognition world at `dbPath`.
 *
 * EVERY ROW LANDS ON A DIFFERENT CLASSIFIER BRANCH. That is the property that
 * makes this fixture worth having: a seeder that produced the same verdict for
 * any input would satisfy "no row is red" and every tone assertion built on it.
 * The `un-wedge` control in the endpoint suite is the paired proof — flip
 * `schedule_runs.status` off `'running'` and `janitor` must LEAVE `wedged` and
 * the two co-driven rows must LEAVE `blocked_upstream`.
 *
 * ⚠ Callers MUST also write `config.json` — see {@link writeCognitionConfig}.
 * The gates are resolved from that file, not from this DB, so a seeded roster
 * with no config renders every instance `disabled` and nothing else.
 */
export function seedCognitionBrain(
  dbPath: string,
  host: string = COGNITION_HOST,
): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(DDL_COGNITION);

  const instance = db.prepare(
    `INSERT OR REPLACE INTO cognition_instances
       (id, component, event_prefix, gate_keys, gate_default, driver, driver_ref, output)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const event = db.prepare(
    `INSERT INTO event_log (event_name, component, machine_hostname, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  const schedule = db.prepare(
    `INSERT INTO schedules (id, name, cron_expr, enabled, next_run_at)
     VALUES (?, ?, '0 4 * * *', 1, ?)`,
  );
  const run = db.prepare(
    `INSERT INTO schedule_runs (id, schedule_id, status, started_at) VALUES (?, ?, ?, ?)`,
  );

  // --- perception -> ok.
  //
  // Its `component` and `event_prefix` are the BARE literal `perception`, NOT
  // `cognition.perception`, and `gate_default` is 1 — the one instance whose
  // ABSENT key means ON. A digest that derived `cognition.${id}` would report
  // the single healthiest instance as never having run (MAINTAINING's L-857
  // rule), so the fixture carries the legacy shape rather than a tidy one.
  instance.run(
    "perception", "perception", "perception",
    JSON.stringify(["cognition.perception.enabled"]), 1,
    "session_hook", "session_end", "learnings[review_status='pending_review']",
  );
  event.run("perception.run_succeeded", "perception", host, cognitionDaysAgo(1));

  // --- subconscious -> ok. Schedule-driven, fired, no open run.
  instance.run(
    "subconscious", "cognition.subconscious", "cognition.subconscious",
    JSON.stringify(["cognition.subconscious.enabled"]), 0,
    "schedule", "subconscious_engine", "suggestions[source_module='subconscious']",
  );
  schedule.run("sched-sub", "subconscious_engine", cognitionDaysAgo(-1));
  event.run(
    "cognition.subconscious.run_succeeded", "cognition.subconscious",
    host, cognitionDaysAgo(1),
  );

  // --- synapse -> failing. A `run_failed` with NO LATER SUCCESS.
  //
  // The earlier success is seeded on purpose: "failing" must mean "the latest
  // terminal is a failure", not "a failure exists anywhere in the window". With
  // only the failure row, a classifier that answered on ANY failure would pass.
  instance.run(
    "synapse", "cognition.synapse", "cognition.synapse",
    JSON.stringify(["cognition.synapse.enabled"]), 0,
    "schedule", "synapse_engine", "suggestions[source_module='edge_inference']",
  );
  schedule.run("sched-syn", "synapse_engine", cognitionDaysAgo(-1));
  event.run(
    "cognition.synapse.run_succeeded", "cognition.synapse",
    host, cognitionDaysAgo(5),
  );
  event.run(
    "cognition.synapse.run_failed", "cognition.synapse",
    host, cognitionDaysAgo(2),
  );

  // --- janitor -> wedged. An OPEN run plus an OVERDUE next_run_at.
  //
  // The daemon's overlap guard refuses to fire while any run is `'running'`, so
  // this schedule cannot fire again until a human clears the row. `next_run_at`
  // is in the PAST as well, so the reason sentence carries both halves.
  instance.run(
    "janitor", "cognition.janitor", "cognition.janitor",
    JSON.stringify(["cognition.janitor.enabled"]), 0,
    "schedule", COGNITION_FIXTURE.wedgedSchedule, "suggestions[source_module='janitor']",
  );
  schedule.run("sched-jan", COGNITION_FIXTURE.wedgedSchedule, cognitionDaysAgo(1));
  run.run(COGNITION_FIXTURE.wedgedRunId, "sched-jan", "running", cognitionDaysAgo(14));

  // --- arbiter + curator -> blocked_upstream, DERIVED from `driver_ref`.
  //
  // Neither declares a switch or a schedule of its own: they run only inside a
  // janitor run. The classifier resolves the verdict by LOOKING UP `driver_ref`
  // in the roster — there is no `if (id === 'arbiter')` anywhere — which is why
  // both rows carry a healthy recent success and are STILL not `ok`. Painting
  // them red would send the operator to the healthy instance.
  for (const id of ["arbiter", "curator"]) {
    instance.run(
      id, `cognition.${id}`, `cognition.${id}`,
      JSON.stringify(["cognition.janitor.enabled"]), 0,
      "co_driven", "janitor", `suggestions[source_module='${id}']`,
    );
    event.run(`cognition.${id}.run_succeeded`, `cognition.${id}`, host, cognitionDaysAgo(1));
  }

  // --- cartographer -> disabled. A gate CONJUNCTION whose SECOND key is false.
  //
  // `disabled_by` therefore names `cognition.janitor.cluster.enabled` and not
  // the first key, which is the whole point of reporting the first key that
  // FAILED rather than the first key declared: the two gates mean two very
  // different remedies. The panel renders that string verbatim beside the
  // DISABLED chip (FR-266 D4).
  instance.run(
    "cartographer", "cognition.cartographer", "cognition.cartographer",
    JSON.stringify(["cognition.janitor.enabled", COGNITION_FIXTURE.disabledGate]), 0,
    "co_driven", "janitor", "suggestions[source_module='cartographer']",
  );
  event.run(
    "cognition.cartographer.run_succeeded", "cognition.cartographer",
    host, cognitionDaysAgo(1),
  );

  // --- roadmap_drift -> ok. THE DERIVATION PROOF (AC-3).
  //
  // An instance id that appears in NO shipped file. It is LAST so it also pins
  // the ordering claim: the digest preserves the projection's `rowid` order,
  // which is `registry.all()` insertion order, and is never sorted.
  instance.run(
    COGNITION_FIXTURE.derivedInstanceId,
    `cognition.${COGNITION_FIXTURE.derivedInstanceId}`,
    `cognition.${COGNITION_FIXTURE.derivedInstanceId}`,
    JSON.stringify([`cognition.${COGNITION_FIXTURE.derivedInstanceId}.enabled`]), 0,
    "manual", null,
    `suggestions[source_module='${COGNITION_FIXTURE.derivedInstanceId}']`,
  );
  event.run(
    `cognition.${COGNITION_FIXTURE.derivedInstanceId}.run_succeeded`,
    `cognition.${COGNITION_FIXTURE.derivedInstanceId}`,
    host, cognitionDaysAgo(1),
  );

  db.close();
}

/**
 * Write the `config.json` the fixture's gates resolve against.
 *
 * `brainDir` — NOT the DB path. `verbs/cognition.ts#readConfig` reads
 * `configJsonPath()`, which is `brainDir()/config.json`, so this lands beside
 * `memory/knowledge.db` rather than inside it.
 *
 * Every gate is `true` EXCEPT `cognition.janitor.cluster.enabled`, which is
 * explicitly `false` — the one deliberate operator choice in the world, and the
 * `disabled` half of AC-4.
 */
export function writeCognitionConfig(brainDir: string): void {
  mkdirSync(brainDir, { recursive: true });
  writeFileSync(
    join(brainDir, "config.json"),
    JSON.stringify({
      version: "7.0.0",
      cognition: {
        perception: { enabled: true },
        subconscious: { enabled: true },
        synapse: { enabled: true },
        janitor: { enabled: true, cluster: { enabled: false } },
        roadmap_drift: { enabled: true },
      },
    }),
    "utf-8",
  );
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
  // FR-246 — the ONE path this brief adds, plus the `q` variant of each
  // surface that gained the parameter. The `q` variants matter to the crawl
  // specifically BECAUSE they take a new code path: a substring predicate is
  // still a query, and G-RO-1 must prove it cannot write.
  "/api/briefs/search?q=dashboard",
  "/api/briefs/search?q=shell&project=demo",
  "/api/learnings?q=wrapper",
  "/api/context-docs?project=demo&q=guideline",
  "/api/goals?q=lens",
  "/api/suggestions?q=gap",
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
  // TD-326 — the project-less scope. It reaches the SAME read door, so the
  // read-only crawl covers it too rather than leaving the newest query shape
  // (`project_slug IS NULL`) as the one path no digest gate ever exercised.
  "/api/suggestions?project_scope=brain-level&status=pending",
  // FR-248 — the fused surface. It is the FIRST path to serve five readers off
  // ONE `openBrainReadonlyWithVec` handle, so it is the path with most to prove
  // to the read-only crawl: a handle shared across five readers is exactly
  // where a `query_only` regression would first become invisible. Both the
  // unscoped and the project-scoped forms, because the second one takes a
  // different branch in every arm.
  "/api/search?q=wrapper",
  "/api/search?q=wrapper&project=demo",
];
