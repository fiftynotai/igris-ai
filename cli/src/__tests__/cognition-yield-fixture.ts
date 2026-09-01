/**
 * TD-423 — the two KNOWN-ANSWER worlds `igris cognition yield` is checked
 * against.
 *
 * WHY A FIXTURE AND NOT THE LIVE BRAIN. TD-423's AC-6 asks that the brief's
 * 2026-08-26 numbers be reproduced by the verb. They cannot be reproduced
 * against today's DB: TD-437 drained both cognition queues on 2026-09-01 —
 * pending suggestions went 1,554 → 0 and rows carrying a verdict went 56 (3.5%)
 * → 1,687 (~100%). The data legitimately changed.
 *
 * A fixture is also the STRONGER proof, not a consolation. A live-only check can
 * show only that the verb agrees with itself: the DB is simultaneously the input
 * and the oracle. Here the expected values are written as LITERALS computed by
 * hand from the brief's own table, so the arithmetic has an independent answer
 * to be wrong about. If the verb and this file disagree, the VERB is wrong — do
 * not edit an expectation to make a case pass (test_standards: "never hand-edit
 * a reality fixture to make a case pass; add a second fixture").
 *
 * TWO WORLDS, one definition shared by every case:
 *
 *   `seedWorld_2026_08_26` — the shape TD-423 measured. 1,610 suggestions,
 *     1,554 pending, 56 carrying a verdict; the 40 expiry-rejected learnings
 *     with `deleted_at IS NULL` alongside the 29 genuinely reviewed with
 *     `deleted_at IS NOT NULL`. This is the world where the AC-4 compensation
 *     has something to compensate FOR.
 *
 *   `seedWorld_2026_09_01` — the shape TD-437 left behind. Both queues at zero,
 *     so every `pending_share_of_queue` is 0/0 and must read `null`. Composition
 *     transcribed from a read-only census of the live brain taken 2026-09-01.
 *
 * ONE MODELLING CHOICE, STATED. In the 08-26 world all six rejections are
 * modelled as the RECURRING (soft-delete) branch, so all 29 reviewed rows
 * survive and `judged` is 29 exactly as the brief's table says. In reality five
 * of them took the common HARD-DELETE branch and left no row at all. That bound
 * is real and is covered by its OWN cases (`produced_is_surviving_count`, and
 * the digest warning that fires when a rejection event outnumbers the surviving
 * rejected rows) rather than being folded in here, where it would confound the
 * arithmetic check with a second effect.
 *
 * @module __tests__/cognition-yield-fixture
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Schema — mirrored from the brain, never invented
// ---------------------------------------------------------------------------

/** Mirrors `cognition/schema.ts` v1 + v2 (`produced` is v2, TD-423). */
export const COGNITION_INSTANCES_DDL = `
  CREATE TABLE IF NOT EXISTS cognition_instances (
    id TEXT PRIMARY KEY, component TEXT NOT NULL, event_prefix TEXT NOT NULL,
    gate_keys TEXT NOT NULL, gate_default INTEGER NOT NULL DEFAULT 0,
    driver TEXT NOT NULL, driver_ref TEXT,
    output TEXT NOT NULL, produced TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/**
 * Mirrors `subconscious/schema.ts`'s `suggestions`, CHECK constraints included.
 *
 * The CHECK is not decoration here: it is what makes the judgment model's
 * `pending`/`dismissed`/`acted` vocabulary a CLOSED set, which is what lets the
 * bucket-reconciliation assertion mean something.
 */
export const SUGGESTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_module TEXT NOT NULL,
    project_slug TEXT,
    title TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium'
      CHECK (priority IN ('high', 'medium', 'low')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'dismissed', 'acted')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    dismissed_at TEXT,
    acted_at TEXT,
    type_inferred INTEGER NOT NULL DEFAULT 0
  );
`;

/** Mirrors the `learnings` columns the judgment model discriminates on. */
export const LEARNINGS_DDL = `
  CREATE TABLE IF NOT EXISTS learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL DEFAULT 'p',
    title TEXT NOT NULL,
    source_extractor TEXT NOT NULL DEFAULT 'manual',
    review_status TEXT NOT NULL DEFAULT 'approved',
    last_reviewed_at TEXT,
    deleted_at TEXT,
    seen_again_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/** Mirrors the brain's `event_log` (monitoring). */
export const EVENT_LOG_DDL = `
  CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT NOT NULL,
    component TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
    machine_hostname TEXT, project_slug TEXT, instance_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// ---------------------------------------------------------------------------
// The roster — transcribed from the seven extractor declarations
// ---------------------------------------------------------------------------

/** One roster row as the brain's `projectRoster` would write it. */
export interface RosterSeed {
  id: string;
  component: string;
  event_prefix: string;
  gate_keys: string[];
  gate_default: boolean;
  driver: string;
  driver_ref: string | null;
  output: string;
  produced: string;
}

/**
 * The PRODUCTION roster, transcribed verbatim from the extractor `health`
 * blocks.
 *
 * This is a hand copy of a brain-side declaration and the copy is the point:
 * `cli/` and `brain-mcp-server/` are separate npm packages with zero
 * cross-imports, so the CLI can only ever see the roster the brain PROJECTED.
 *
 * NOTHING TIES THIS COPY TO THE BRAIN, and no claim here should suggest
 * otherwise. It is a SEED, not a gate: as of 2026-09-01 every reference to it
 * either defines it, seeds a fixture DB from it, or asserts a property of its
 * own contents (that each transcribed `produced` string parses). None compares
 * it to the brain's projected roster, so an assertion written against it —
 * `expect(d.instances).toHaveLength(PRODUCTION_ROSTER.length + 1)` — is
 * self-referential and stays green whatever the brain declares.
 *
 * The brain-side `roster.test.ts` does not close the gap either, and it is not
 * trying to: it proves the projection is DERIVED from the registry (a throwaway
 * 8th instance appears there with no other edit) and that each registered
 * instance declares a usable `health` block. That catches a MISSING or
 * malformed declaration in the brain. It cannot catch a DRIFTED TRANSCRIPTION
 * over here, because it never reads this file.
 *
 * So an 8th brain-side instance, or a changed `produced` predicate, moves
 * neither side and nothing goes red — and the per-instance label census in
 * `cli/src/types.ts` rots with it, since that census is pinned only against the
 * world this fixture seeds. Closing it needs a generated parity guard, the
 * repo's convention for a hand-copied cross-package constant
 * (`cli/src/lib/brief-normalize.generated.ts`, TD-238's PHASE enum, TD-281).
 * That is its own brief, not a line of this fixture.
 */
export const PRODUCTION_ROSTER: RosterSeed[] = [
  {
    id: "perception",
    component: "perception",
    event_prefix: "perception",
    gate_keys: ["cognition.perception.enabled"],
    gate_default: true,
    driver: "session_hook",
    driver_ref: "session_end",
    output: "learnings[review_status='pending_review']",
    produced: "learnings[source_extractor='llm']",
  },
  {
    id: "subconscious",
    component: "cognition.subconscious",
    event_prefix: "cognition.subconscious",
    gate_keys: ["cognition.subconscious.enabled"],
    gate_default: false,
    driver: "schedule",
    driver_ref: "subconscious_engine",
    output: "suggestions[source_module=LLM-named, type_inferred=1]",
    produced: "suggestions[type_inferred=1, source_module=OTHER]",
  },
  {
    id: "synapse",
    component: "cognition.synapse",
    event_prefix: "cognition.synapse",
    gate_keys: ["cognition.synapse.enabled"],
    gate_default: false,
    driver: "schedule",
    driver_ref: "synapse_engine",
    output: "suggestions[source_module='edge_inference']",
    produced: "suggestions[source_module='edge_inference']",
  },
  {
    id: "janitor",
    component: "cognition.janitor",
    event_prefix: "cognition.janitor",
    gate_keys: ["cognition.janitor.enabled"],
    gate_default: false,
    driver: "schedule",
    driver_ref: "janitor_engine",
    output: "suggestions[source_module='janitor']",
    produced: "suggestions[source_module='janitor']",
  },
  {
    id: "arbiter",
    component: "cognition.arbiter",
    event_prefix: "cognition.arbiter",
    gate_keys: ["cognition.janitor.enabled"],
    gate_default: false,
    driver: "co_driven",
    driver_ref: "janitor",
    output: "suggestions[source_module='arbiter']",
    produced: "suggestions[source_module='arbiter']",
  },
  {
    id: "curator",
    component: "cognition.curator",
    event_prefix: "cognition.curator",
    gate_keys: ["cognition.janitor.enabled"],
    gate_default: false,
    driver: "co_driven",
    driver_ref: "janitor",
    output: "suggestions[source_module='curator']",
    produced: "suggestions[source_module='curator']",
  },
  {
    id: "cartographer",
    component: "cognition.cartographer",
    event_prefix: "cognition.cartographer",
    gate_keys: ["cognition.janitor.enabled", "cognition.janitor.cluster.enabled"],
    gate_default: false,
    driver: "co_driven",
    driver_ref: "janitor",
    output: "suggestions[source_module='cartographer']",
    produced: "suggestions[source_module='cartographer']",
  },
];

// ---------------------------------------------------------------------------
// Seeding primitives
// ---------------------------------------------------------------------------

export function dbFileIn(root: string): string {
  return join(root, "memory", "knowledge.db");
}

function open(file: string): Database.Database {
  mkdirSync(dirname(file), { recursive: true });
  return new Database(file);
}

/** Create every table the yield reader touches. Idempotent. */
export function seedYieldSchema(file: string): void {
  const db = open(file);
  db.exec(COGNITION_INSTANCES_DDL);
  db.exec(SUGGESTIONS_DDL);
  db.exec(LEARNINGS_DDL);
  db.exec(EVENT_LOG_DDL);
  db.close();
}

/** Project a roster into `cognition_instances`, in the order given. */
export function seedRoster(file: string, rows: RosterSeed[]): void {
  const db = open(file);
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO cognition_instances
       (id, component, event_prefix, gate_keys, gate_default, driver, driver_ref, output, produced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.id,
      r.component,
      r.event_prefix,
      JSON.stringify(r.gate_keys),
      r.gate_default ? 1 : 0,
      r.driver,
      r.driver_ref,
      r.output,
      r.produced,
    );
  }
  db.close();
}

/** How many suggestion rows to mint, and in what disposition. */
export interface SuggestionSpec {
  source_module: string;
  type_inferred: 0 | 1;
  status: "pending" | "dismissed" | "acted";
  count: number;
  /** Past-dated to make a pending row `pending_expired`; omit for `pending_live`. */
  expires_at?: string;
  created_at?: string;
}

export function seedSuggestions(file: string, specs: SuggestionSpec[]): void {
  const db = open(file);
  const stmt = db.prepare(
    `INSERT INTO suggestions
       (source_module, project_slug, title, status, created_at, expires_at, dismissed_at, acted_at, type_inferred)
     VALUES (?, 'p', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insert = db.transaction((batch: SuggestionSpec[]) => {
    for (const s of batch) {
      for (let i = 0; i < s.count; i += 1) {
        stmt.run(
          s.source_module,
          `${s.source_module} #${i}`,
          s.status,
          s.created_at ?? "2026-08-01 00:00:00",
          s.expires_at ?? null,
          s.status === "dismissed" ? "2026-08-26 00:00:00" : null,
          s.status === "acted" ? "2026-08-26 00:00:00" : null,
          s.type_inferred,
        );
      }
    }
  });
  insert(specs);
  db.close();
}

/** How many learning rows to mint, and in what disposition. */
export interface LearningSpec {
  source_extractor: string;
  review_status: string;
  /** `null` = the row survives un-deleted; a timestamp = soft-deleted. */
  deleted_at: string | null;
  count: number;
  created_at?: string;
}

export function seedLearnings(file: string, specs: LearningSpec[]): void {
  const db = open(file);
  const stmt = db.prepare(
    `INSERT INTO learnings
       (project, title, source_extractor, review_status, deleted_at, created_at, updated_at)
     VALUES ('p', ?, ?, ?, ?, ?, ?)`,
  );
  const insert = db.transaction((batch: LearningSpec[]) => {
    for (const s of batch) {
      for (let i = 0; i < s.count; i += 1) {
        const at = s.created_at ?? "2026-08-01 00:00:00";
        stmt.run(
          `${s.source_extractor}/${s.review_status} #${i}`,
          s.source_extractor,
          s.review_status,
          s.deleted_at,
          at,
          at,
        );
      }
    }
  });
  insert(specs);
  db.close();
}

export function seedEvents(
  file: string,
  rows: Array<{ event_name: string; component: string; count: number; created_at?: string }>,
): void {
  const db = open(file);
  const stmt = db.prepare(
    `INSERT INTO event_log (event_name, component, machine_hostname, created_at)
     VALUES (?, ?, 'test-host', ?)`,
  );
  for (const r of rows) {
    for (let i = 0; i < r.count; i += 1) {
      stmt.run(r.event_name, r.component, r.created_at ?? "2026-08-26 11:50:00");
    }
  }
  db.close();
}

/**
 * `n` DISTINCT LLM-minted `source_module` labels spread over `total` rows.
 *
 * This is the AC-5 mechanism under test, not decoration. The subconscious names
 * its own kinds, so a reading that GROUPED by `source_module` would report it as
 * N tiny detectors instead of one instance — the brief's Defect 3. The verb must
 * return exactly ONE digest entry for all of these.
 */
export function spreadLabels(
  prefix: string,
  distinct: number,
  status: "pending" | "dismissed" | "acted",
  total: number,
): SuggestionSpec[] {
  const specs: SuggestionSpec[] = [];
  const base = Math.floor(total / distinct);
  let remaining = total;
  for (let i = 0; i < distinct; i += 1) {
    const count = i === distinct - 1 ? remaining : Math.min(base, remaining);
    if (count <= 0) break;
    specs.push({ source_module: `${prefix}_${i}`, type_inferred: 1, status, count });
    remaining -= count;
  }
  return specs;
}

// ---------------------------------------------------------------------------
// WORLD 1 — 2026-08-26, the shape TD-423 measured
// ---------------------------------------------------------------------------

/**
 * The expected digest values for {@link seedWorld_2026_08_26}, computed BY HAND
 * from TD-423's own table and NOT from a run of the verb.
 *
 * TD-423's per-instance table, verbatim:
 *
 *   | instance     | produced | judged | kept | keep rate | pending |
 *   | perception   |       29 |     29 |   23 |       79% |       0 |
 *   | cartographer |       21 |      8 |    8 |      100% |      13 |
 *   | subconscious |      293 |      2 |    1 |       50% |     291 |
 *   | synapse      |      441 |      0 |    0 |         — |     441 |
 *   | arbiter      |        8 |      0 |    0 |         — |       8 |
 *   | curator      |        3 |      0 |    0 |         — |       3 |
 *   | janitor      |        0 |      — |    — |         — |       — |
 *   | legacy rules |      844 |     46 |    2 |      4.3% |     798 |
 *
 * Cross-checks against the brief's OTHER stated figures, which is what makes
 * this a construction rather than a transcription:
 *   suggestions total  21 + 293 + 441 + 8 + 3 + 844 = 1610  ("1,610 rows")
 *   pending total      13 + 291 + 441 + 8 + 3 + 798 = 1554  ("1,554 rows")
 *   judged total        8 +   2 +   0 + 0 + 0 +  46 =   56  ("56 (3.5%)")
 *   3.5% check          56 / 1610 = 0.0348
 *   legacy keep rate     2 / 46   = 0.0435                  ("4.3%")
 *
 * PERCEPTION'S `produced` IS 69, NOT 29, AND THAT IS THE POINT. The brief's 29
 * is the SESSION that was reviewed; the instance had also written the 40 rows a
 * bulk expiry flipped to `rejected`. A naive reader counts all 46 non-approved
 * rows as rejections and scores perception 23/69 = 33%. The verb must count the
 * 40 as `expired_not_judged`, leaving `keep_rate_of_judged = 23/29 = 79%` —
 * which is the brief's number and the whole of AC-4.
 *
 * EVERY KEY BELOW IS CONSUMED, AT BOTH TIERS, BY CONSTRUCTION.
 * `cognition-yield.test.ts` drives this object from its OWN keys through
 * `expectTopLevel` (the world's keys: channel totals, instance blocks, the
 * event pair) and each instance block through `expectDeclared` (the keys inside
 * it). Both maps THROW on a key they do not know, so a value added here without
 * an assertion is RED, not invisible — at either tier. Round 1 declared
 * `judged_share: 29 / 69` and asserted it nowhere, which let the rate's
 * denominator be mutated with the whole suite green; round 2 guarded the inner
 * tier only, which left the four channel totals in each world reachable without
 * a guard.
 */
export const EXPECTED_2026_08_26 = {
  suggestions_total: 1610,
  suggestions_pending: 1554,
  learnings_total: 69,
  learnings_pending: 0,
  perception: {
    produced: 69,
    kept: 23,
    rejected_judged: 6,
    judged: 29,
    pending_live: 0,
    expired_not_judged: 40,
    keep_rate: 23 / 29,
    judged_share: 29 / 69,
    expiry_share: 40 / 69,
    // `learnings` declares NO label column, so this reading is `null` — never
    // 0. See {@link EXPECTED_2026_09_01} for the whole census.
    distinct_labels: null,
  },
  cartographer: { produced: 21, kept: 8, judged: 8, pending_live: 13, keep_rate: 1 },
  subconscious: {
    produced: 293,
    kept: 1,
    rejected_judged: 1,
    judged: 2,
    pending_live: 291,
    keep_rate: 0.5,
    distinct_labels: 168,
  },
  synapse: { produced: 441, judged: 0, kept: 0, pending_live: 441 },
  arbiter: { produced: 8, judged: 0, kept: 0, pending_live: 8 },
  curator: { produced: 3, judged: 0, kept: 0, pending_live: 3 },
  // A MEASURED zero on every field, including the label census: the janitor
  // wrote no suggestions, so there is nothing to count distinct labels over.
  // `0` here is not interchangeable with the `null` perception reads above.
  janitor: { produced: 0, judged: 0, kept: 0, pending_live: 0, distinct_labels: 0 },
  unclaimed_suggestions: {
    produced: 844,
    kept: 2,
    rejected_judged: 44,
    judged: 46,
    pending_live: 798,
    keep_rate: 2 / 46,
    distinct_labels: 4,
  },
} as const;

/** Seed the 2026-08-26 world. Schema + roster + rows. */
export function seedWorld_2026_08_26(file: string): void {
  seedYieldSchema(file);
  seedRoster(file, PRODUCTION_ROSTER);

  seedSuggestions(file, [
    // cartographer — 21 produced, 8 acted, 13 still pending.
    { source_module: "cartographer", type_inferred: 1, status: "acted", count: 8 },
    { source_module: "cartographer", type_inferred: 1, status: "pending", count: 13 },
    // synapse — 441 produced, none ever judged (TD-326: its output was never
    // reviewable, which is why it has zero verdicts and not zero value).
    { source_module: "edge_inference", type_inferred: 1, status: "pending", count: 441 },
    { source_module: "arbiter", type_inferred: 1, status: "pending", count: 8 },
    { source_module: "curator", type_inferred: 1, status: "pending", count: 3 },
    // The legacy rule detectors FR-118 deleted. `type_inferred = 0` — the v2
    // migration backfilled every pre-existing row with 0, which is what makes
    // them mechanically separable from the subconscious without naming them.
    { source_module: "gap", type_inferred: 0, status: "pending", count: 700 },
    { source_module: "gap", type_inferred: 0, status: "dismissed", count: 38 },
    { source_module: "gap", type_inferred: 0, status: "acted", count: 2 },
    { source_module: "stalled", type_inferred: 0, status: "pending", count: 80 },
    { source_module: "stalled", type_inferred: 0, status: "dismissed", count: 5 },
    { source_module: "pattern", type_inferred: 0, status: "pending", count: 17 },
    { source_module: "pattern", type_inferred: 0, status: "dismissed", count: 1 },
    { source_module: "conflict", type_inferred: 0, status: "pending", count: 1 },
    { source_module: "conflict", type_inferred: 0, status: "acted", count: 0 },
    // 1 acted + 1 dismissed + 291 pending across 168 DISTINCT LLM labels.
    { source_module: "suggestion_flood", type_inferred: 1, status: "acted", count: 1 },
    { source_module: "suggestion_flooding", type_inferred: 1, status: "dismissed", count: 1 },
    ...spreadLabels("subconscious_kind", 166, "pending", 291),
  ]);

  seedLearnings(file, [
    // The one complete review the brain had ever seen: 23 approved, 6 rejected.
    { source_extractor: "llm", review_status: "approved", deleted_at: null, count: 23 },
    {
      source_extractor: "llm",
      review_status: "rejected",
      deleted_at: "2026-08-26 11:50:17",
      count: 6,
    },
    // The two BULK EXPIRY batches — `rejectStalePending` writes the status and
    // never touches `deleted_at`. A reader that counts these as rejections is
    // reading a cron job as a human opinion. This is Defect 1, seeded.
    {
      source_extractor: "llm",
      review_status: "rejected",
      deleted_at: null,
      count: 16,
      created_at: "2026-08-04 00:00:00",
    },
    {
      source_extractor: "llm",
      review_status: "rejected",
      deleted_at: null,
      count: 24,
      created_at: "2026-08-10 00:00:00",
    },
  ]);

  // The 2026-08-26 triage's own event trail: 23 approvals, 6 rejections, under
  // the LEGACY bare `perception` component (L-857 — NOT `cognition.perception`).
  seedEvents(file, [
    { event_name: "perception.candidate_approved", component: "perception", count: 23 },
    { event_name: "perception.candidate_rejected", component: "perception", count: 6 },
  ]);
}

// ---------------------------------------------------------------------------
// WORLD 2 — 2026-09-01, the shape TD-437 left behind
// ---------------------------------------------------------------------------

/**
 * The expected digest values for {@link seedWorld_2026_09_01}.
 *
 * Transcribed from a READ-ONLY census of the live brain taken 2026-09-01 during
 * TD-423's Phase 0 (`sqlite3 -readonly`, five GROUP BY queries), cross-checked
 * against TD-437's own result table:
 *
 *   suggestions   type_inferred=1: 352 acted / 491 dismissed = 843
 *                 type_inferred=0:   2 acted / 842 dismissed = 844
 *                 total 1687   ("Judged this pass: 1,687 rows")
 *   learnings     llm    221 approved, 1 rejected+deleted, 345 rejected+NULL,
 *                        2 superseded+deleted = 569
 *                 manual 706 approved, 4 superseded+deleted = 710
 *                 total 1279
 *
 * `pending` is ZERO on both channels, which is why this world is the one that
 * proves AC-7 rather than merely asserting it: EVERY `pending_share_of_queue` is
 * 0/0 and must read `null`, not `0`.
 *
 * IT IS ALSO THE LABEL CENSUS `cli/src/types.ts#distinct_label_values` cites,
 * which is why every instance below declares `distinct_labels` — including the
 * two that read NOTHING. The comment used to say "1 for every literal instance
 * and 196 for the subconscious", and that was false for the janitor (a measured
 * 0, because it wrote no rows) and for the two learnings-channel entries
 * (`null`, because `learnings` has no label column at all). A census stated as
 * a rule is a claim about every member of the set.
 */
export const EXPECTED_2026_09_01 = {
  suggestions_total: 1687,
  suggestions_pending: 0,
  learnings_total: 1279,
  learnings_pending: 0,
  perception: {
    produced: 569,
    // 221 approved + 2 superseded. BROADER than `='approved'` on purpose: a row
    // approved at review time and later superseded by the janitor was still
    // KEPT when it was judged. Counting only `approved` under-reports by 2.
    kept: 223,
    rejected_judged: 1,
    judged: 224,
    expired_not_judged: 345,
    pending_live: 0,
    distinct_labels: null,
  },
  subconscious: { produced: 360, kept: 186, rejected_judged: 174, distinct_labels: 196 },
  // One literal `source_module` each — the predicate forces exactly that, so
  // these four are the "1 for every literal instance" the census is named for.
  synapse: { produced: 450, kept: 133, rejected_judged: 317, distinct_labels: 1 },
  cartographer: { produced: 21, kept: 21, rejected_judged: 0, distinct_labels: 1 },
  arbiter: { produced: 8, kept: 8, rejected_judged: 0, distinct_labels: 1 },
  curator: { produced: 4, kept: 4, rejected_judged: 0, distinct_labels: 1 },
  // ...and the fifth literal instance on this channel reads 0, not 1: it wrote
  // no rows, so there are no labels to be distinct.
  janitor: { produced: 0, judged: 0, kept: 0, pending_live: 0, distinct_labels: 0 },
  unclaimed_suggestions: { produced: 844, kept: 2, rejected_judged: 842, distinct_labels: 4 },
  // The `manual` learnings — direct `memory_store` and `/distill` rows. No
  // cognition instance produced them, so they belong to no instance; they have
  // no counterpart in TD-423's or TD-437's tables and their presence here is the
  // point of D8's complement derivation.
  unclaimed_learnings: { produced: 710, kept: 710, distinct_labels: null },
  events: { approved: 78, rejected: 7 },
} as const;

/** Seed the 2026-09-01 world. */
export function seedWorld_2026_09_01(file: string): void {
  seedYieldSchema(file);
  seedRoster(file, PRODUCTION_ROSTER);

  seedSuggestions(file, [
    { source_module: "edge_inference", type_inferred: 1, status: "acted", count: 133 },
    { source_module: "edge_inference", type_inferred: 1, status: "dismissed", count: 317 },
    { source_module: "cartographer", type_inferred: 1, status: "acted", count: 21 },
    { source_module: "arbiter", type_inferred: 1, status: "acted", count: 8 },
    { source_module: "curator", type_inferred: 1, status: "acted", count: 4 },
    // 196 distinct LLM labels over 360 rows — 186 acted, 174 dismissed.
    ...spreadLabels("subconscious_kind", 98, "acted", 186),
    ...spreadLabels("subconscious_dismissed", 98, "dismissed", 174),
    // The legacy detectors, class-dismissed by TD-437: 842 dismissed, 2 acted.
    { source_module: "gap", type_inferred: 0, status: "dismissed", count: 735 },
    { source_module: "gap", type_inferred: 0, status: "acted", count: 2 },
    { source_module: "stalled", type_inferred: 0, status: "dismissed", count: 85 },
    { source_module: "pattern", type_inferred: 0, status: "dismissed", count: 18 },
    { source_module: "conflict", type_inferred: 0, status: "dismissed", count: 4 },
  ]);

  seedLearnings(file, [
    { source_extractor: "llm", review_status: "approved", deleted_at: null, count: 221 },
    {
      source_extractor: "llm",
      review_status: "rejected",
      deleted_at: "2026-08-26 11:50:17",
      count: 1,
    },
    { source_extractor: "llm", review_status: "rejected", deleted_at: null, count: 345 },
    {
      source_extractor: "llm",
      review_status: "superseded",
      deleted_at: "2026-08-20 00:00:00",
      count: 2,
    },
    { source_extractor: "manual", review_status: "approved", deleted_at: null, count: 706 },
    {
      source_extractor: "manual",
      review_status: "superseded",
      deleted_at: "2026-08-20 00:00:00",
      count: 4,
    },
  ]);

  seedEvents(file, [
    { event_name: "perception.candidate_approved", component: "perception", count: 78 },
    { event_name: "perception.candidate_rejected", component: "perception", count: 7 },
  ]);
}
