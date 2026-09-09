/**
 * FR-241 — the shared sandbox brain for every WRITE gate.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT DOES NOT HAND-ROLL DDL, AND THAT IS THE POINT
 * ═════════════════════════════════════════════════════════════════════════════
 * `dashboard-layers-fixture.ts` writes its own `CREATE TABLE`s because `cli/`
 * and `brain-mcp-server/` have zero cross-imports, so a read test has no other
 * way to get a schema. A WRITE test does: `bootWriteEngine()` runs the engine's
 * OWN migrations, so the schema under test is the real one and there is no DDL
 * mirror to drift.
 *
 * That is not merely tidier — the hand-rolled schema is UNUSABLE here, and this
 * was measured rather than assumed. Booting the engine against a brain seeded by
 * `seedLayerBrain()` throws:
 *
 *     BOOT THREW: duplicate column name: archetype
 *
 * because the engine's migrations re-apply an `ALTER TABLE` the fixture's DDL
 * already inlined. So a write gate reusing the layers fixture would have been a
 * gate that only ever observed `degraded: boot_failed` — green, and meaningless.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SEED **BEFORE** THE ENGINE BOOTS. THIS IS NOT STYLE — READS GO WRONG OTHERWISE
 * ═════════════════════════════════════════════════════════════════════════════
 * Discovered while writing these gates, reproduced in four standalone probes,
 * and load-bearing for every assertion in this suite:
 *
 *   With the write engine's connection LIVE, opening a second read-write
 *   `better-sqlite3` connection to the same file and CLOSING it leaves the
 *   engine writing into an unlinked `-wal`. From that moment a freshly-opened
 *   connection reads the PRE-dispatch state and keeps reading it, while the
 *   engine's own connection reports the new one. Observed directly:
 *
 *     dispatch ok:               true
 *     engine conn sees:          [{"id":1,"status":"dismissed"}]
 *     fresh readonly sees:       [{"id":1,"status":"pending"}]
 *     `knowledge.db-wal` exists: false
 *
 *   ...and after `engine.shutdown()` the fresh connection sees `dismissed`
 *   again. A gate that seeded mid-test would therefore assert "the row did not
 *   change" against a stale snapshot and PASS while the mutation had in fact
 *   landed — the exact false-green this file exists to make impossible.
 *
 * The rule this fixture enforces: **no read-write connection is ever opened
 * while an engine is live.** `seedTriageBrain()` migrates, tears the engine
 * down, seeds, and hands back a quiescent file. After that the tests open
 * READ-ONLY connections only (`readTriageBrain`), which are safe alongside the
 * live writer — the same probes confirm a read-only reader sees every dispatch
 * immediately, with no shutdown and no checkpoint.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE ENGINE PER PROCESS
 * ═════════════════════════════════════════════════════════════════════════════
 * `db.ts#setAdapter` is a module global (Phase-0 step 7: a second `bootEngine`
 * silently re-points every `getDb()` in the process, including the first
 * engine's). The migrate pass therefore goes through `bootWriteEngine()` and is
 * torn down with `resetWriteEngine()` before anything else boots, so at most one
 * engine is ever LIVE — and it is the production code path that does the
 * migrating, not a test-only copy of it.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  bootWriteEngine,
  resetWriteEngine,
  type WriteEngineFailureKind,
} from "../lib/brain-write-bridge.js";

/** Ids and counts the suites assert on, named so an assertion reads as a claim. */
export const TRIAGE_FIXTURE = {
  /**
   * 17 pending suggestions THAT BELONG TO A PROJECT. The number is deliberate:
   * G-TR-2 dismisses 12 and asserts 5 survive, and 17 is prime-ish enough that
   * an off-by-one in either direction is visible rather than plausible.
   *
   * TD-326 note: this is NOT every pending row. Ids 19-21 are pending and
   * belong to NO project — see `brainLevelPendingIds`. `countPendingWithProject`
   * is the counter that matches THIS number, and it is named for the subset it
   * counts precisely so the two populations cannot be confused.
   */
  pendingSuggestions: 17,
  /** Ids 1..17 are pending; 18 is already `acted` (a dismiss on it must FAIL). */
  actedSuggestionId: 18,
  /** `demo` owns 1..12; `other` owns 13..17. An ASYMMETRIC scope split. */
  demoPendingIds: Array.from({ length: 12 }, (_, i) => i + 1),
  otherPendingIds: [13, 14, 15, 16, 17],

  /**
   * TD-326 — pending suggestions with `project_slug IS NULL`.
   *
   * NON-EMPTY on purpose: the brief names "a test that passes because there
   * happened to be zero project-less rows" as its vacuous gate, so the write
   * gate over this population has a population to act on. Three rows across TWO
   * modules, so a filter that ignored `source_module` is visible.
   */
  brainLevelPendingIds: [19, 20, 21],
  /** ...of which ids 19 and 20 are `edge_inference` and 21 is `janitor`. */
  brainLevelEdgeInferenceIds: [19, 20],

  /**
   * Candidates. The two branches of `handlePerceptionReject`'s fork, seeded
   * explicitly so a gate can exercise BOTH rather than sampling whichever the
   * data happened to contain.
   */
  firstTimeCandidateIds: [1, 2, 3],
  recurringCandidateIds: [4, 5],
  /** `seen_again_count` on the recurring rows. */
  recurringSeenAgain: 3,
  /** An already-approved learning: `approve` on it is a no-op-ish success. */
  approvedLearningId: 6,

  // --- FR-247 ---------------------------------------------------------------
  /** The project every seeded brief belongs to. */
  briefProject: "demo",
  /**
   * 17 briefs at `P2-Medium`, ids `FR-001`…`FR-017`.
   *
   * The same 17/12/5 split G-TR-2 uses for suggestions, deliberately: the
   * discriminating half of a bulk assertion is "and the OTHER five are
   * byte-identical", and reusing a shape whose off-by-one is already visible
   * beats inventing a second one.
   */
  briefCount: 17,
  briefBasePriority: "P2-Medium",
  /**
   * A brief carrying a NON-CANONICAL priority (D2).
   *
   * `P4-Trivial` exists on the operator brain — exactly ONE row out of 1,818
   * (Phase-0 P0.2). Seeded here so the picker's "render the current value,
   * disabled" case has a subject, and so a test can assert that writing a
   * canonical value to it CANONICALISES it (a stated side effect of a correct
   * write; TD-338 owns the population, this brief does not chase it).
   */
  nonCanonicalBriefId: "TD-900",
  nonCanonicalPriority: "P4-Trivial",
  /**
   * THE D6 SUBJECT: a brief in `brief_files` with NO `brief_status` row.
   *
   * Measured on the operator brain: **1** such row exists (Phase-0 P0.3). Real,
   * rare, and catastrophic to write to unguarded — `handleBriefUpdate` takes
   * its INSERT branch and invents `status='Ready'` with `title=''`, which is a
   * write into the TD-311 build-state invariant through the handler this brief
   * was told to trust.
   */
  filesOnlyBriefId: "BR-900",
  /** Its `brief_files.content`, so the red-first proof can assert it survived. */
  filesOnlyContent: "# BR-900\n\nA brief with a file and no status row.\n",
  /** A brief id that exists in NEITHER table. */
  missingBriefId: "ZZ-999",

  /**
   * Two goals. `attach_goal` targets these, and FR-249's `create_goal` is
   * measured against them.
   *
   * THE IDS ARE LOAD-BEARING, NOT DECORATIVE. `handleGoalCreate` allocates
   * `MAX(CAST(SUBSTR(goal_id,4) AS INTEGER)) + 1` (`goals/handlers.ts#nextGoalId`),
   * so with exactly these two seeded the FIRST dashboard create is
   * DETERMINISTICALLY `GL-102` — which is what lets FR-249's create-then-attach
   * proof name an id instead of matching a shape. Seeding a third goal here
   * moves that id and reds the FR-249 gates by design.
   */
  goalIds: ["GL-100", "GL-101"],
  /** FR-249 — the id the first `create_goal` against this fixture allocates. */
  nextGoalId: "GL-102",
} as const;

/** Every brief id the fixture seeds with a `brief_status` row at P2-Medium. */
export function seededBriefIds(): string[] {
  return Array.from(
    { length: TRIAGE_FIXTURE.briefCount },
    (_, i) => `FR-${String(i + 1).padStart(3, "0")}`,
  );
}

/** Every id the fixture seeds as a pending suggestion WITH a project. */
export function pendingSuggestionIds(): number[] {
  return Array.from({ length: TRIAGE_FIXTURE.pendingSuggestions }, (_, i) => i + 1);
}

/**
 * Build a sandbox brain with the ENGINE's own schema, seeded and quiescent.
 *
 * `IGRIS_BRAIN_DIR` must already point at the sandbox — this boots through
 * `bootWriteEngine()`, which resolves `brainDbPath()`, so the caller's sandbox
 * IS the target. That is deliberate: it means the fixture cannot migrate one
 * brain while the test writes to another.
 *
 * Returns the boot failure when the bundle is unavailable, so the caller can
 * SKIP LOUDLY with a stated reason rather than silently passing over an empty
 * schema. A skip is a coverage hole and the suite must say so.
 */
export async function seedTriageBrain(
  dbPath: string,
): Promise<{ ok: true } | { ok: false; kind: WriteEngineFailureKind; reason: string }> {
  mkdirSync(dirname(dbPath), { recursive: true });
  if (!existsSync(dbPath)) {
    // `bootWriteEngine` checks existence first and REFUSES to manufacture a
    // brain (see its header). So the file has to exist before it will migrate
    // it — an empty SQLite file with zero tables is exactly right.
    new Database(dbPath).close();
  }

  const booted = await bootWriteEngine();
  if (!booted.ok) return booted;
  // Migrations have run. Tear the engine down BEFORE opening a writer — see
  // the file header for what happens if these two overlap.
  resetWriteEngine();

  const db = new Database(dbPath);
  try {
    seedRows(db);
  } finally {
    db.close();
  }
  return { ok: true };
}

function seedRows(db: Database.Database): void {
  const insSuggestion = db.prepare(
    `INSERT INTO suggestions
       (id, source_module, project_slug, title, evidence, priority, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Explicit ids: every gate names the ids it acts on, and "dismiss 12 of 17"
  // is only checkable if which twelve is a fact rather than an autoincrement.
  for (const id of TRIAGE_FIXTURE.demoPendingIds) {
    insSuggestion.run(
      id,
      id % 3 === 0 ? "janitor" : "gap",
      "demo",
      `demo suggestion ${id}`,
      JSON.stringify({ kind: "gap", n: id }),
      id % 2 === 0 ? "high" : "medium",
      "pending",
      `2026-07-${String((id % 28) + 1).padStart(2, "0")} 09:00:00`,
    );
  }
  for (const id of TRIAGE_FIXTURE.otherPendingIds) {
    insSuggestion.run(
      id,
      "missing_followup",
      "other",
      `other suggestion ${id}`,
      JSON.stringify({ kind: "followup", n: id }),
      "low",
      "pending",
      "2026-07-20 09:00:00",
    );
  }
  // Already acted. `igris_suggestion_dismiss` on this row is a HANDLER error,
  // which is what makes G-TR-3's partial-failure case a real handler message
  // rather than a fabricated one.
  db.prepare(
    `INSERT INTO suggestions
       (id, source_module, project_slug, title, evidence, priority, status, acted_at, acted_brief_id)
     VALUES (?, 'gap', 'demo', 'already acted', '{}', 'high', 'acted', datetime('now'), 'FR-000')`,
  ).run(TRIAGE_FIXTURE.actedSuggestionId);

  // TD-326 — the project-less population. `project_slug` is nullable with no
  // FK, and on the operator brain 377 of 1,210 pending rows carry NULL
  // (synapse's edge inferences, which belong to the graph rather than to a
  // project). A project-scoped read can neither list nor count them, which is
  // the whole of TD-326 — so the write gate needs a non-empty set of them.
  for (const id of TRIAGE_FIXTURE.brainLevelPendingIds) {
    insSuggestion.run(
      id,
      TRIAGE_FIXTURE.brainLevelEdgeInferenceIds.includes(
        id as (typeof TRIAGE_FIXTURE.brainLevelEdgeInferenceIds)[number],
      )
        ? "edge_inference"
        : "janitor",
      null,
      `brain-level suggestion ${id}`,
      JSON.stringify({ kind: "edge", n: id }),
      "medium",
      "pending",
      "2026-07-25 09:00:00",
    );
  }

  const insLearning = db.prepare(
    `INSERT INTO learnings
       (id, project, category, title, content, confidence, provenance, review_status,
        source_extractor, seen_again_count, tags, tech_stack, scope)
     VALUES (?, 'demo', 'pattern', ?, ?, 0.8, 'inferred', ?, 'perception', ?, '', '', 'local')`,
  );
  for (const id of TRIAGE_FIXTURE.firstTimeCandidateIds) {
    // seen_again_count = 0 -> reject HARD-deletes. Tier 3.
    insLearning.run(id, `first-time candidate ${id}`, `body ${id}`, "pending_review", 0);
  }
  for (const id of TRIAGE_FIXTURE.recurringCandidateIds) {
    // seen_again_count > 0 -> reject SOFT-deletes and writes an event_log row.
    // This branch is the ONLY positive control the event_log parity differ has.
    insLearning.run(
      id,
      `recurring candidate ${id}`,
      `body ${id}`,
      "pending_review",
      TRIAGE_FIXTURE.recurringSeenAgain,
    );
  }
  insLearning.run(
    TRIAGE_FIXTURE.approvedLearningId,
    "already approved",
    "body",
    "approved",
    0,
  );

  seedBriefRows(db);
}

/**
 * FR-247 — briefs, goals, and the `brief_files`-only brief.
 *
 * `brief_status.project` carries a FOREIGN KEY to `projects(slug)`, so the
 * project row comes first. (SQLite only enforces it with `foreign_keys = ON`,
 * which the engine sets — a fixture that skipped it would work here and fail
 * the moment the engine opened the file.)
 */
function seedBriefRows(db: Database.Database): void {
  const project = TRIAGE_FIXTURE.briefProject;
  const insProject = db.prepare(
    "INSERT OR IGNORE INTO projects (slug, name, path) VALUES (?, ?, ?)",
  );
  insProject.run(project, "Demo", "/tmp/demo");
  insProject.run("other", "Other", "/tmp/other");

  const insStatus = db.prepare(
    `INSERT INTO brief_status
       (project, brief_id, title, status, priority, effort, phase, brief_type, updated_at)
     VALUES (?, ?, ?, ?, ?, 'M', NULL, 'Feature', '2026-08-01 10:00:00')`,
  );
  for (const briefId of seededBriefIds()) {
    // A NON-EMPTY, DISTINCT title on every row. The AC-4 control asserts the
    // title is byte-identical after a priority-only write, and a fixture of
    // empty or identical titles would make that assertion pass against the very
    // blanking it exists to detect.
    insStatus.run(
      project,
      briefId,
      `Title of ${briefId}`,
      "Ready",
      TRIAGE_FIXTURE.briefBasePriority,
    );
  }
  // The non-canonical row (D2). Its status is deliberately NOT `Ready`, so a
  // write that silently re-invented one would be visible.
  insStatus.run(
    project,
    TRIAGE_FIXTURE.nonCanonicalBriefId,
    `Title of ${TRIAGE_FIXTURE.nonCanonicalBriefId}`,
    "In Progress",
    TRIAGE_FIXTURE.nonCanonicalPriority,
  );

  // THE D6 SUBJECT — `brief_files` ONLY. No `brief_status` row, on purpose.
  db.prepare(
    `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
     VALUES ('fr247-files-only', ?, ?, ?, ?, 'sha-none', '2026-08-01 10:00:00')`,
  ).run(
    project,
    TRIAGE_FIXTURE.filesOnlyBriefId,
    `${TRIAGE_FIXTURE.filesOnlyBriefId}.md`,
    TRIAGE_FIXTURE.filesOnlyContent,
  );

  const insGoal = db.prepare(
    `INSERT INTO goals (goal_id, project_slug, title, description, outcome, status, priority, created_at, updated_at, metadata)
     VALUES (?, ?, ?, NULL, 'an outcome', 'active', 'high', '2026-08-01 10:00:00', '2026-08-01 10:00:00', '{}')`,
  );
  for (const goalId of TRIAGE_FIXTURE.goalIds) {
    insGoal.run(goalId, project, `Goal ${goalId}`);
  }
}

/**
 * Open a READ-ONLY connection for assertions.
 *
 * Read-only is not a nicety: a read-WRITE connection opened and closed while the
 * engine is live poisons the WAL (see the header), and every gate in this suite
 * reads WHILE the engine holds the file. The caller must close it.
 */
export function readTriageBrain(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true });
}

/** One suggestion's mutable state, for assert-then-diff. */
export interface SuggestionState {
  id: number;
  status: string;
  dismissed_reason: string | null;
  acted_brief_id: string | null;
}

export function suggestionStates(dbPath: string): SuggestionState[] {
  const db = readTriageBrain(dbPath);
  try {
    return db
      .prepare(
        "SELECT id, status, dismissed_reason, acted_brief_id FROM suggestions ORDER BY id",
      )
      .all() as SuggestionState[];
  } finally {
    db.close();
  }
}

/**
 * Pending suggestions that BELONG TO A PROJECT.
 *
 * Named for its subset (TD-326). Before TD-326 this counted every pending row
 * and the two were the same number; the fixture now seeds project-less rows, so
 * a helper called `countPending` would silently have started counting a
 * different population than every "17 -> dismiss 12 -> 5" assertion means.
 * `countPendingBrainLevel` is its complement, and the two partition the table.
 */
export function countPendingWithProject(dbPath: string): number {
  const db = readTriageBrain(dbPath);
  try {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM suggestions WHERE status = 'pending' AND project_slug IS NOT NULL",
        )
        .get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

/** Pending suggestions with NO project — TD-326's population. */
export function countPendingBrainLevel(dbPath: string): number {
  const db = readTriageBrain(dbPath);
  try {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM suggestions WHERE status = 'pending' AND project_slug IS NULL",
        )
        .get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

/** One learning's triage-relevant state. `null` when the row is GONE. */
export interface LearningState {
  id: number;
  review_status: string;
  deleted_at: string | null;
  seen_again_count: number;
}

export function learningState(dbPath: string, id: number): LearningState | null {
  const db = readTriageBrain(dbPath);
  try {
    return (
      (db
        .prepare(
          "SELECT id, review_status, deleted_at, seen_again_count FROM learnings WHERE id = ?",
        )
        .get(id) as LearningState | undefined) ?? null
    );
  } finally {
    db.close();
  }
}

// --- FR-247 readers ---------------------------------------------------------

/**
 * A brief's WHOLE mutable row. Read as a unit rather than field by field: the
 * discriminating half of AC-3/AC-4 is "every field the caller did not name is
 * byte-identical", and that is a claim about the row, not about `priority`.
 */
export interface BriefStatusState {
  project: string;
  brief_id: string;
  title: string;
  status: string;
  priority: string | null;
  effort: string | null;
  phase: string | null;
  brief_type: string | null;
}

export function briefStatusRows(dbPath: string): BriefStatusState[] {
  const db = readTriageBrain(dbPath);
  try {
    return db
      .prepare(
        `SELECT project, brief_id, title, status, priority, effort, phase, brief_type
           FROM brief_status ORDER BY project, brief_id`,
      )
      .all() as BriefStatusState[];
  } finally {
    db.close();
  }
}

export function briefStatusRow(
  dbPath: string,
  project: string,
  briefId: string,
): BriefStatusState | null {
  return (
    briefStatusRows(dbPath).find(
      (r) => r.project === project && r.brief_id === briefId,
    ) ?? null
  );
}

/** How many `brief_status` rows exist for a `(project, brief_id)`. 0 or 1. */
export function briefStatusCount(
  dbPath: string,
  project: string,
  briefId: string,
): number {
  return briefStatusRows(dbPath).filter(
    (r) => r.project === project && r.brief_id === briefId,
  ).length;
}

/** `entity_edges` rows, for the `attach_goal` assertions. */
export interface EdgeState {
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  edge_type: string;
}

export function edgeRows(dbPath: string): EdgeState[] {
  const db = readTriageBrain(dbPath);
  try {
    return db
      .prepare(
        "SELECT from_type, from_id, to_type, to_id, edge_type FROM entity_edges ORDER BY id",
      )
      .all() as EdgeState[];
  } finally {
    db.close();
  }
}

/** FR-249 — `goals` rows, for the `create_goal` assertions. */
export interface GoalState {
  goal_id: string;
  project_slug: string | null;
  title: string;
  outcome: string;
  status: string;
  priority: string;
  deadline: string | null;
  description: string | null;
}

/**
 * Every goal, oldest first.
 *
 * `created_at`/`updated_at` are NOT selected — a create's timestamps cannot be
 * asserted against a literal, and including them would force every caller into
 * `toMatchObject`, which is the assertion shape that hides an extra column.
 */
export function goalRows(dbPath: string): GoalState[] {
  const db = readTriageBrain(dbPath);
  try {
    return db
      .prepare(
        `SELECT goal_id, project_slug, title, outcome, status, priority, deadline, description
           FROM goals ORDER BY id`,
      )
      .all() as GoalState[];
  } finally {
    db.close();
  }
}

/**
 * The `NOT NULL` on `brief_status.status`, read out of the LIVE schema.
 *
 * `brain-write-bridge.ts#hasBriefStatusRow` keys the D6 precondition on
 * `status !== null`, because `getBrief` LEFT-JOINs and therefore returns a
 * non-null record with null status columns for a `brief_files`-only brief. That
 * predicate is only sound while the column is `NOT NULL` — if a migration ever
 * relaxes it, a real brief with a null status would start being refused AND the
 * guard's meaning would quietly change. So the constraint is read from the
 * schema the engine actually built, not assumed from `db.ts`.
 */
export function briefStatusStatusIsNotNull(dbPath: string): boolean {
  const db = readTriageBrain(dbPath);
  try {
    const cols = db.prepare("PRAGMA table_info(brief_status)").all() as {
      name: string;
      notnull: number;
    }[];
    return cols.some((c) => c.name === "status" && c.notnull === 1);
  } finally {
    db.close();
  }
}

/** The comparable columns of an `event_log` row. See the parity differ. */
export interface EventRow {
  event_name: string;
  component: string;
  project_slug: string | null;
  instance_id: string | null;
  payload: string;
}

/**
 * `event_log` rows with `id > watermark`, in insertion order.
 *
 * `id`, `created_at` and `machine_hostname` are NOT selected — they cannot
 * agree across two processes on principle (an autoincrement, a clock, and a
 * hostname that is the same here but is not a claim worth making). The parity
 * differ asserts this exclusion list explicitly so it cannot quietly grow to
 * cover a real difference.
 */
export function eventsSince(dbPath: string, watermark: number): EventRow[] {
  const db = readTriageBrain(dbPath);
  try {
    return db
      .prepare(
        `SELECT event_name, component, project_slug, instance_id, payload
           FROM event_log WHERE id > ? ORDER BY id`,
      )
      .all(watermark) as EventRow[];
  } finally {
    db.close();
  }
}

export function maxEventId(dbPath: string): number {
  const db = readTriageBrain(dbPath);
  try {
    return (
      (db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM event_log").get() as { n: number })
        .n
    );
  } finally {
    db.close();
  }
}

/** The domain-table delta a parity gate must compare alongside `event_log`. */
export interface DomainSnapshot {
  suggestions: unknown[];
  dismissed_patterns: unknown[];
  learnings: unknown[];
  entity_edges: unknown[];
  /** FR-247 — the table `set_priority` writes. One line; the rest was there. */
  brief_status: unknown[];
  /**
   * FR-249 — the table `create_goal` writes.
   *
   * Without it the parity differ would compare `[] === []` for a create:
   * `goal.created` reaches NEITHER `monitoring`'s `EVENT_COMPONENT_MAP` nor its
   * `bus.on` list, so `event_log` is DECLARED-EMPTY for this action and the
   * "something happened" half of the comparison has to be carried here.
   */
  goals: unknown[];
}

/**
 * A stable, comparable dump of the four tables a triage action can touch.
 *
 * A parity gate that only read `event_log` would pass while the two paths wrote
 * completely different rows — four of the five actions write NOTHING to
 * `event_log`, so `event_log` alone is very nearly a constant.
 */
export function domainSnapshot(dbPath: string): DomainSnapshot {
  const db = readTriageBrain(dbPath);
  try {
    const dump = (sql: string): unknown[] =>
      (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => {
        // Timestamps are excluded for the same reason `created_at` is: two
        // processes cannot agree on a clock. Everything else is compared.
        const { dismissed_at, acted_at, deleted_at, updated_at, created_at, last_seen_at, ...rest } =
          r;
        void dismissed_at;
        void acted_at;
        void updated_at;
        void created_at;
        void last_seen_at;
        // `deleted_at` is kept as a PRESENCE flag — whether a soft delete
        // happened is the whole difference between tier 2 and tier 3, and
        // dropping it would make the two branches indistinguishable.
        return { ...rest, deleted: deleted_at === null || deleted_at === undefined ? 0 : 1 };
      });
    return {
      suggestions: dump("SELECT * FROM suggestions ORDER BY id"),
      dismissed_patterns: dump(
        "SELECT source_module, project_slug, evidence_signature, dismiss_count, reasons FROM dismissed_patterns ORDER BY id",
      ),
      learnings: dump(
        "SELECT id, project, title, review_status, seen_again_count, deleted_at FROM learnings ORDER BY id",
      ),
      entity_edges: dump(
        "SELECT from_type, from_id, to_type, to_id, edge_type FROM entity_edges ORDER BY id",
      ),
      // FR-247. `title` and `status` are COMPARED, not excluded: the whole
      // point of the priority parity arm is that the two paths change the same
      // one column and leave the same others alone.
      brief_status: dump(
        `SELECT project, brief_id, title, status, priority, effort, phase, brief_type
           FROM brief_status ORDER BY project, brief_id`,
      ),
      // FR-249. `goal_id` IS compared: both arms allocate from their own copy
      // of the same seeded fixture, so the allocator is deterministic across
      // them and an id divergence would be a real difference, not a clock.
      goals: dump(
        `SELECT goal_id, project_slug, title, description, outcome, deadline, status, priority, metadata
           FROM goals ORDER BY id`,
      ),
    };
  } finally {
    db.close();
  }
}
