/**
 * TD-440 — recurrence instead of re-emission (AC-1, AC-2, AC-3).
 *
 * Drives `runSubconscious` through the real cognition engine with a STATEFUL
 * mocked backend, so consecutive runs return DIFFERENT text the way the live
 * model does.
 *
 * WHY THE STUB PARAPHRASES. A byte-identical stub is FALSE-GREEN against any
 * dedup: the pre-TD-440 code already skipped a candidate whose
 * `(source_module, project, evidence-signature)` triple matched a pending row,
 * so "run the extractor twice against an unchanged digest" — the brief's literal
 * wording — passes before the fix. The RED fixture therefore varies the three
 * things the model actually varies run to run: the `kind` label, the title
 * wording, and the free-text `evidence.note`. Both the label AND the note must
 * move, because the old key hashed the whole evidence blob and a reworded note
 * alone mints a new key.
 *
 * @module engine/components/subconscious/__tests__/recurrence.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runSubconscious } from '../runner.js';
import { subconsciousMigrations } from '../schema.js';
import { claimOf, claimSimilarity, claimTokens, claimsMatch } from '../finding-key.js';
import {
  DEFAULT_SUBCONSCIOUS_CONFIG,
  type SubconsciousConfig,
  type Suggestion,
} from '../types.js';
import type { ResolvedBackend } from '../../cognition/types.js';
import type { BackendRunResult } from '../../cognition/backend/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBrain(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL, component TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', machine_hostname TEXT,
      project_slug TEXT, instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, path TEXT NOT NULL, status TEXT DEFAULT 'active',
      registered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      priority TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'pattern', title TEXT NOT NULL,
      content TEXT NOT NULL, confidence REAL DEFAULT 0.8,
      review_status TEXT DEFAULT 'approved',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status, priority, updated_at)
     VALUES ('alpha','BR-1','Open one','In Progress','P1','2026-05-01 00:00:00')`,
  ).run();
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status, priority, updated_at)
     VALUES ('alpha','BR-2','Open two','In Progress','P1','2026-05-01 00:00:00')`,
  ).run();
  db.prepare(`INSERT INTO projects (slug, name, path) VALUES ('alpha','Alpha','/tmp/a')`).run();
  db.prepare(
    `INSERT INTO projects (slug, name, path) VALUES ('fifty_eco_system','FES','/tmp/f')`,
  ).run();
  return db;
}

const RUNNABLE_CONFIG: SubconsciousConfig = {
  ...DEFAULT_SUBCONSCIOUS_CONFIG,
  enabled: true,
  min_digest_bytes: 0,
  llm_daily_budget: 50,
};

/** A backend that answers with a DIFFERENT canned response on each call. */
function statefulDeps(responses: string[]) {
  const backend: ResolvedBackend = { harness: 'claude', fallback_order: ['claude'] };
  let call = 0;
  return {
    resolveBackend: () => backend,
    runBackend: async (): Promise<BackendRunResult> => {
      const text = responses[Math.min(call, responses.length - 1)] ?? '[]';
      call += 1;
      return { ok: true, text };
    },
    isColdStart: () => false,
  };
}

function one(candidate: Record<string, unknown>): string {
  return JSON.stringify([candidate]);
}

function rows(db: Database.Database): Suggestion[] {
  return db.prepare(`SELECT * FROM suggestions ORDER BY id`).all() as Suggestion[];
}

function count(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM suggestions`).get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// AC-1 — the paraphrased re-emission
// ---------------------------------------------------------------------------

/**
 * The RED fixture. Same finding about BR-1, twice, with a fresh label, fresh
 * wording and a fresh note — which is what the live rows do (measured: 31
 * distinct labels over 33 rows in the clean-room window, 77% of them novel).
 */
const RUN_1 = one({
  kind: 'stalled_brief',
  project_slug: 'alpha',
  title: 'BR-1 has been In Progress 189 days with no recorded activity',
  priority: 'low',
  confidence: 0.7,
  evidence: { brief_id: 'BR-1', note: 'no update since May' },
});
const RUN_2 = one({
  kind: 'dormant_work_item',
  project_slug: 'alpha',
  title: 'BR-1 is stalled — In Progress 190 days and no activity recorded',
  priority: 'low',
  confidence: 0.7,
  evidence: { brief_id: 'BR-1', note: 'still no movement' },
});
const RUN_3 = one({
  kind: 'unattended_brief',
  project_slug: 'alpha',
  title: 'BR-1 has been sitting In Progress for 191 days with activity recorded nowhere',
  priority: 'low',
  confidence: 0.7,
  evidence: { brief_id: 'BR-1', note: 'a third wording entirely' },
});
const RUN_4 = one({
  kind: 'frozen_brief',
  project_slug: 'alpha',
  title: 'BR-1 has been In Progress 192 days with no activity recorded against it',
  priority: 'low',
  confidence: 0.7,
  evidence: { brief_id: 'BR-1', note: 'and a fourth' },
});

describe('TD-440 AC-1 — a pending finding is not re-filed', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
  });
  afterEach(() => {
    db.close();
  });

  it('collapses a PARAPHRASED re-emission onto the pending row', async () => {
    const deps = statefulDeps([RUN_1, RUN_2]);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });
    expect(count(db)).toBe(1);

    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });

    // The assertion that matters is the STORED ROW, not the call's return value:
    // a bump-not-insert path is exactly where "it worked" and "it silently did
    // nothing" look identical from an outcome (L-1409).
    expect(count(db)).toBe(1);
    const row = rows(db)[0];
    expect(row.seen_count).toBe(2);
    // The row keeps its FIRST title and label; the second run's wording is
    // recorded as absorbed rather than overwriting the queue entry.
    expect(row.source_module).toBe('stalled_brief');
    expect(JSON.parse(row.recurrence_titles)).toEqual([
      'BR-1 is stalled — In Progress 190 days and no activity recorded',
    ]);
  });

  it('stays at one row across four runs, each a fresh paraphrase', async () => {
    const deps = statefulDeps([RUN_1, RUN_2, RUN_3, RUN_4]);
    for (let i = 0; i < 4; i++) {
      await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });
    }
    expect(count(db)).toBe(1);
    const row = rows(db)[0];
    expect(row.seen_count).toBe(4);
    // The cap holds at 3 absorbed titles, newest last.
    expect(JSON.parse(row.recurrence_titles)).toHaveLength(3);
  });

  it('an ALL-DEDUPED run is `succeeded`, not `db_error` (the R2 contract)', async () => {
    const deps = statefulDeps([RUN_1, RUN_2]);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });

    const result = await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });

    // `cognition/engine/index.ts` fails a run with `db_error` when the count of
    // non-throwing `persistCandidate` calls is zero. A bump that signalled
    // itself by throwing would make the healthiest possible run — every
    // candidate already known — report as `run_failed`, which
    // `igris cognition health` classifies as `failing`. So a bump must return
    // normally and be COUNTED.
    expect(result.outcome).toBe('succeeded');
    expect(result.persisted).toBe(1);
    expect(result.parsed).toBe(1);
    expect(count(db)).toBe(1);

    const names = (
      db.prepare(`SELECT event_name FROM event_log ORDER BY id`).all() as {
        event_name: string;
      }[]
    ).map((r) => r.event_name);
    expect(names).toContain('cognition.subconscious.run_succeeded');
    expect(names).not.toContain('cognition.subconscious.run_failed');
  });
});

// ---------------------------------------------------------------------------
// AC-2 — what a bump records
// ---------------------------------------------------------------------------

describe('TD-440 AC-2 — recurrence is recorded on the existing row', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
  });
  afterEach(() => {
    db.close();
  });

  it('advances last_seen_at and expires_at but LEAVES created_at alone', async () => {
    const deps = statefulDeps([RUN_1, RUN_2]);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });

    // Age the row so the bump has something to move.
    db.prepare(
      `UPDATE suggestions
          SET created_at = '2026-01-01 00:00:00', expires_at = '2026-01-31 00:00:00'`,
    ).run();

    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });
    const row = rows(db)[0];

    expect(row.seen_count).toBe(2);
    expect(row.last_seen_at).not.toBeNull();
    // A still-recurring finding must not lapse out of the queue.
    expect(row.expires_at! > '2026-01-31 00:00:00').toBe(true);
    // `created_at` is the LWW timestamp `SYNC_TABLES` compares on. Touching it
    // would re-push the row on every recurrence.
    expect(row.created_at).toBe('2026-01-01 00:00:00');
  });

  it('escalates one priority step every recurrence_escalate_n sightings', async () => {
    const config: SubconsciousConfig = { ...RUNNABLE_CONFIG, recurrence_escalate_n: 3 };
    const deps = statefulDeps([RUN_1, RUN_2, RUN_3, RUN_4, RUN_2, RUN_3]);

    const seen: Array<[number, string]> = [];
    for (let i = 0; i < 6; i++) {
      await runSubconscious(db, 'all', { config, deps });
      const row = rows(db)[0];
      seen.push([row.seen_count, row.priority]);
    }

    expect(count(db)).toBe(1);
    // low -> medium at the 3rd sighting, medium -> high at the 6th, and `high`
    // is the ceiling.
    expect(seen).toEqual([
      [1, 'low'],
      [2, 'low'],
      [3, 'medium'],
      [4, 'medium'],
      [5, 'medium'],
      [6, 'high'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-3 — the label family, and the NEGATIVE CONTROL
// ---------------------------------------------------------------------------

/**
 * Eight candidates modelled on the `fifty_eco_system`-is-abandoned family. The
 * titles are REAL — copied out of the operator brain's `suggestions` table,
 * where this one finding occupies 38 rows under 9 distinct labels.
 */
const ABANDONED_FAMILY: Array<[string, string]> = [
  [
    'abandoned_project',
    'fifty_eco_system holds 34 open briefs but has had zero activity for 171 days — decide whether to archive the project or schedule a deliberate restart',
  ],
  [
    'portfolio_abandonment',
    'fifty_eco_system holds 34 open briefs but has had zero activity for 171 days — decide whether to archive the project or schedule a real revival sprint',
  ],
  [
    'abandoned_project_backlog',
    'fifty_eco_system holds 34 open briefs but has had zero activity for 172 days — decide whether to archive the project or re-commit to it, rather than triaging 30+ stalled-brief suggestions one by one',
  ],
  [
    'project_abandonment',
    'fifty_eco_system has 34 open briefs but zero activity for 173 days — decide whether to archive the project or schedule a dedicated triage session',
  ],
  [
    'abandoned_project_cluster',
    'fifty_eco_system holds 34 open briefs but has seen zero activity for 173 days — decide whether to archive the project or re-commit to it, rather than triaging 30 stalled briefs one at a time',
  ],
  [
    'stale_brief_backlog',
    'fifty_eco_system has 34 open briefs but zero activity for 174 days — decide whether to archive the project or re-scope it, rather than triaging 30 stalled briefs one by one',
  ],
  [
    'unrecorded_project_freeze',
    'fifty_eco_system holds 34 open briefs but has had zero activity for 179 days — decide whether to archive the project or re-commit to it, rather than triaging its briefs one at a time',
  ],
  [
    'stalled_project_abandonment',
    'fifty_eco_system has 34 open briefs but zero activity for 180 days — decide whether to archive the project or schedule a revival sprint',
  ],
];

describe('TD-440 AC-3 — the key survives the label family', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
  });
  afterEach(() => {
    db.close();
  });

  it('collapses 8 real abandoned-project emissions to ONE row across 4 runs', async () => {
    // Two candidates per run, four runs — the live cadence.
    const responses: string[] = [];
    for (let i = 0; i < ABANDONED_FAMILY.length; i += 2) {
      responses.push(
        JSON.stringify(
          ABANDONED_FAMILY.slice(i, i + 2).map(([kind, title]) => ({
            kind,
            project_slug: 'fifty_eco_system',
            title,
            priority: 'medium',
            confidence: 0.7,
            evidence: { note: `run ${i}` },
          })),
        ),
      );
    }
    const deps = statefulDeps(responses);
    for (let i = 0; i < responses.length; i++) {
      await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });
    }

    expect(count(db)).toBe(1);
    const row = rows(db)[0];
    expect(row.seen_count).toBe(ABANDONED_FAMILY.length);
    expect(row.entity_key).toBe('project:fifty_eco_system');
  });

  /**
   * THE NEGATIVE CONTROL — the over-merge falsifier, asserted in BOTH insertion
   * orders because a key that merged only one way would pass a single-order
   * test. `BR-1 carries a malformed status string` and `BR-1 has been In
   * Progress 189 days` are both TRUE, both about the same brief, and are two
   * findings. TD-437 measured ~23 of ~25 distinct findings as actionable, so a
   * false merge destroys a real signal — strictly worse than the repetition
   * this brief exists to fix.
   */
  const DISJOINT_A = one({
    kind: 'malformed_status',
    project_slug: 'alpha',
    title: 'BR-1 carries a malformed status string',
    priority: 'medium',
    confidence: 0.7,
    evidence: { brief_id: 'BR-1', note: 'status parsing' },
  });
  const DISJOINT_B = one({
    kind: 'stalled_brief',
    project_slug: 'alpha',
    title: 'BR-1 has been In Progress 189 days',
    priority: 'medium',
    confidence: 0.7,
    evidence: { brief_id: 'BR-1', note: 'no update since May' },
  });

  it.each([
    ['A then B', [DISJOINT_A, DISJOINT_B]],
    ['B then A', [DISJOINT_B, DISJOINT_A]],
  ])('NEGATIVE CONTROL: same entity, disjoint claims stay 2 rows (%s)', async (_o, order) => {
    const deps = statefulDeps(order);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });

    expect(count(db)).toBe(2);
    const all = rows(db);
    expect(all[0]!.dedupe_key).not.toBe(all[1]!.dedupe_key);
    expect(all.every((r) => r.seen_count === 1)).toBe(true);
  });

  it('the kill switch (dedupe_claim_overlap > 1) leaves only exact-key dedup', async () => {
    const config: SubconsciousConfig = { ...RUNNABLE_CONFIG, dedupe_claim_overlap: 1.01 };
    const deps = statefulDeps([RUN_1, RUN_2]);
    await runSubconscious(db, 'all', { config, deps });
    await runSubconscious(db, 'all', { config, deps });
    // Paraphrase matching is off, so the second wording files its own row —
    // the pre-TD-440 behaviour, reachable by config without a code change.
    expect(count(db)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC-5 — the producer stamp
// ---------------------------------------------------------------------------

describe('TD-440 AC-5 — rows carry their producer', () => {
  it('stamps source_instance=subconscious on an inserted row', async () => {
    const db = makeBrain();
    try {
      await runSubconscious(db, 'all', {
        config: RUNNABLE_CONFIG,
        deps: statefulDeps([RUN_1]),
      });
      const row = rows(db)[0];
      expect(row.source_instance).toBe('subconscious');
      expect(row.dedupe_key).toMatch(/^[0-9a-f]{40}$/);
      // The PROJECT is the anchor when the candidate carries one — the brief
      // it cites is illustrative and the model varies it (measured: 5 distinct
      // brief ids plus null across one finding's 38 real rows).
      expect(row.entity_key).toBe('project:alpha');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// TD-452 — the two anchor splits, pinned AS SPLITS (measured, not moved)
// ---------------------------------------------------------------------------

/**
 * PROVENANCE. Six real rows from TD-445's production window, read on
 * 2026-09-07 from a `sqlite3 -readonly … .backup` copy of the operator brain —
 * every column below is the stored value byte-for-byte, `entity_key` as the
 * deployed writer stamped it. Nothing was edited to make a case pass. The
 * digest whitelist is seeded with the three brief ids the model cited in
 * `evidence` (the validator rejects a citation the digest does not carry),
 * which reproduces the live condition rather than editing the rows.
 *
 * THE TWO ANCHOR-LEVEL MISSES. (1) A cross-project finding has no
 * `project_slug`, so `entityKey` falls to the ILLUSTRATIVE
 * `evidence.brief_id`, which the model varies per run: 1822 / 1883 / 1885 sit
 * in `brief:br-074` / `brief:ts-003` / `brief:br-001` — one finding, three
 * blocks. (2) The same finding was filed under `global` (1801) and under
 * `project:igris-ai` (1888) and the two blocks are never compared, at a
 * pairwise 0.414 well above the line.
 *
 * WHY THEY ARE PINNED AS MISSES AND NOT FIXED. TD-452 measured both candidate
 * anchor changes against the pre-registered rule (every pair the change
 * makes newly comparable, labelled, DIFFERENT must be 0 at 0.25 —
 * `scripts/td452_anchor_sweep.ts`, tags in `scripts/td445_row_findings.csv` +
 * `scripts/td452_row_findings.csv`). Demoting the evidence brief admits 9
 * DIFFERENT pairs (4 on TD-445's own tags — `stalled_detector_gap` ×
 * `zero_learnings_projects`, 1434/1486 @ 0.303 the highest); comparing
 * `global` with `project:*` admits 33 (1291/1698 @ 0.387), and its asymmetric
 * narrowings 13 and 20. So the anchor stayed and these cases red if a future
 * anchor change lands WITHOUT re-reading that labelled set —
 * `docs/architecture/subconscious_engine.md` §"TD-452 anchor re-design".
 * Family 1 would not have collapsed either way: its pairwise scores
 * (0.238 / 0.200 / 0.238) are below the line (D-0 at planning).
 */
interface Row {
  id: number;
  source_module: string;
  project_slug: string | null;
  entity_key: string;
  priority: 'low' | 'medium' | 'high';
  confidence: number;
  title: string;
  evidence: string;
  suggested_action: string | null;
}

const ROW_1801: Row = {
  id: 1801,
  source_module: "suggestion_channel_flooded",
  project_slug: null,
  entity_key: "global",
  priority: "high",
  confidence: 0.8,
  title:
    "44 of the 60 open suggestions are low-value edge_inference rows — the operator's review queue is 73% noise, which will bury the 16 substantive findings",
  evidence:
    "{\"note\":\"open_suggestions ids 1712–1755 are all source_module='edge_inference', each proposing a single learning→learning edge (e.g. 'Inferred related_to edge: learning 224 → learning 227'). These are mechanical graph links, not operator decisions. They should be auto-applied below a confidence threshold, batched into one review item, or routed to a separate queue — not interleaved with findings like 1697 (the only P0 brief stalled 130 days).\"}",
  suggested_action:
    "{\"kind\":\"reroute_suggestion_module\",\"source_module\":\"edge_inference\",\"note\":\"Auto-apply or batch edge_inference proposals; keep the review queue for judgement calls.\"}",
};

const ROW_1888: Row = {
  id: 1888,
  source_module: "self_referential_finding_risk",
  project_slug: "igris-ai",
  entity_key: "project:igris-ai",
  priority: "medium",
  confidence: 0.65,
  title:
    "44 of 60 open suggestions are low-value edge_inference rows — they crowd out substantive findings in the review queue and should be batched or auto-applied rather than queued individually",
  evidence:
    "{\"note\":\"open_suggestions ids 1712–1755 are all source_module=edge_inference, each proposing a single learning→learning edge. They occupy 73% of the operator's queue while carrying no decision content. Commit 6d077a1 ('fix(subconscious): dedup findings on a key stable under LLM paraphrase') shows queue quality is already a known concern; edge inference is the remaining volume source.\"}",
  suggested_action:
    "{\"kind\":\"change_suggestion_routing\",\"source_module\":\"edge_inference\",\"from\":\"individual_queued_suggestion\",\"to\":\"batched_review_or_auto_apply_above_threshold\"}",
};

const ROW_1822: Row = {
  id: 1822,
  source_module: "in_progress_status_is_meaningless",
  project_slug: null,
  entity_key: "brief:br-074",
  priority: "high",
  confidence: 0.8,
  title:
    "Eleven briefs across five projects are marked 'In Progress' with 132–191 days since update — 'In Progress' is being used as a filing state, not a work state, so no dashboard can tell what is actually being worked on",
  evidence:
    "{\"brief_id\":\"BR-074\",\"note\":\"In Progress + stale: BR-074/BR-076/TD-004/TD-006/TD-007/TS-003 (fifty_eco_system, 170-191d), BR-001 hadir-system (175d), BR-002/BR-003/BR-004 attendance_app (170d), BR-027/BR-028 hadir (147-149d), BR-023 lifeOS (132d). Meanwhile igris-ai/mbrgea-ai/moca-ai-agent show days_since_activity 0 with work shipping. Suggestion 1697 covers BR-023 alone; this is the systemic version — a staleness rule that auto-demotes In Progress back to Ready.\"}",
  suggested_action:
    "{\"kind\":\"add_brain_gate\",\"gate\":\"stale_in_progress_demotion\",\"rule\":\"A brief in status 'In Progress' with no update for N days (suggest 30) is auto-demoted to 'Ready' and flagged, so 'In Progress' always means someone is on it\"}",
};

const ROW_1883: Row = {
  id: 1883,
  source_module: "in_progress_status_unreliable",
  project_slug: null,
  entity_key: "brief:ts-003",
  priority: "medium",
  confidence: 0.7,
  title:
    "Ten briefs are 'In Progress' with 133–191 days since update across five projects with zero recorded activity — 'In Progress' has decayed into a synonym for 'abandoned mid-flight' and no longer signals anything to the operator",
  evidence:
    "{\"brief_id\":\"TS-003\",\"note\":\"In Progress + stale: BR-074, BR-076, TD-004, TD-006, TD-007 (191d), BR-002/003/004 attendance_app and TS-003 (171d), BR-001 hadir-system (175d), BR-027/BR-028 hadir (147-149d), BR-023 lifeOS (133d). attendance_app and lifeOS both report days_since_activity null, so nothing was ever in progress. Suggestion 1697 covers only BR-023; this is the class.\"}",
  suggested_action:
    "{\"kind\":\"bulk_status_reset\",\"rule\":\"In Progress with no project activity for >90 days reverts to Ready or Deferred with a note\",\"affected_count\":12}",
};

const ROW_1885: Row = {
  id: 1885,
  source_module: "stale_in_progress_across_system",
  project_slug: null,
  entity_key: "brief:br-001",
  priority: "high",
  confidence: 0.72,
  title:
    "Fourteen briefs across six projects sit at 'In Progress' with 133–191 days since update — no project has more than one genuinely active workstream, so the In Progress set is almost entirely false",
  evidence:
    "{\"brief_id\":\"BR-001\",\"note\":\"In Progress briefs with null or ancient activity: attendance_app BR-002/BR-003/BR-004 (171d, activity null), hadir-system BR-001 (175d, activity null), hadir BR-027/BR-028 (147-149d, activity 126d), lifeOS BR-023 (133d, activity null), fifty_eco_system BR-074/BR-076/TD-004/TD-006/TD-007/TS-003 (191d, activity 188d). A system-wide status hygiene pass is needed, not per-project fixes.\"}",
  suggested_action:
    "{\"kind\":\"propose_status_hygiene_rule\",\"rule\":\"auto-flag any brief in 'In Progress' whose project has no activity for N days, and require a resume-or-reset decision\",\"threshold_days\":60}",
};

const ROW_1880: Row = {
  id: 1880,
  source_module: "self_diagnosis_from_own_commits",
  project_slug: "igris-ai",
  entity_key: "project:igris-ai",
  priority: "high",
  confidence: 0.7,
  title:
    "The digest's own edge_inference module emitted 44 of 60 open suggestions as one-line 'inferred edge' rows over learnings 6–1447, drowning the 17 substantive findings — the subconscious queue needs the same dedup/batching treatment commit 6d077a1 applied to findings",
  evidence:
    "{\"note\":\"open_suggestions ids 1712–1755 are all source_module=edge_inference, each proposing a single graph edge, many over learnings from the 6–425 range (i.e. long-settled history). Commit 6d077a1 'fix(subconscious): dedup findings on a key stable under LLM paraphrase' shows the noise problem is already recognized for findings but not for edge proposals. An operator review queue where 73% of rows are mechanical edge assertions is one an operator stops reading.\"}",
  suggested_action:
    "{\"kind\":\"batch_or_autoapply_suggestion_module\",\"source_module\":\"edge_inference\",\"proposal\":\"auto-apply high-confidence edges without operator review, or collapse into a single batched 'N inferred edges' row\"}",
};

/** The model's response for one stored row — the columns, re-inflated. */
function emit(...rs: Row[]): string {
  return JSON.stringify(
    rs.map((r) => ({
      kind: r.source_module,
      project_slug: r.project_slug,
      title: r.title,
      priority: r.priority,
      confidence: r.confidence,
      evidence: JSON.parse(r.evidence) as Record<string, unknown>,
      ...(r.suggested_action
        ? { suggested_action: JSON.parse(r.suggested_action) as Record<string, unknown> }
        : {}),
    })),
  );
}

/** The ids family 1 cites in `evidence` must be in the digest to pass the validator. */
function seedCitedBriefs(db: Database.Database): void {
  const ins = db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status, priority, updated_at)
     VALUES (?, ?, ?, 'In Progress', 'P2', '2026-03-01 00:00:00')`,
  );
  ins.run('fifty_eco_system', 'BR-074', 'stale one');
  ins.run('fifty_eco_system', 'TS-003', 'stale two');
  ins.run('hadir-system', 'BR-001', 'stale three');
}

function anchorsById(db: Database.Database): Array<[number, string]> {
  return rows(db).map((r) => [r.id, r.entity_key as string]);
}

const score = (a: Row, b: Row): number =>
  claimSimilarity(claimTokens(a.title), claimTokens(b.title));
const matches = (a: Row, b: Row): boolean =>
  claimsMatch(
    claimOf(a.title),
    claimOf(b.title),
    RUNNABLE_CONFIG.dedupe_claim_overlap,
    RUNNABLE_CONFIG.dedupe_min_claim_tokens,
  );

describe('TD-452 — the two anchor splits, pinned as measured (the anchor did not move)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
    seedCitedBriefs(db);
  });
  afterEach(() => {
    db.close();
  });

  it('family 2: the same finding under `global` and `project:igris-ai` files TWO rows (1801 then 1888) — the pair would merge on claim alone', async () => {
    const deps = statefulDeps([emit(ROW_1801), emit(ROW_1888)]);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });
    expect(count(db)).toBe(1);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });

    // The claim gate says SAME at 0.414; the blocks are what keep them apart.
    expect(score(ROW_1801, ROW_1888)).toBeCloseTo(0.414, 3);
    expect(matches(ROW_1801, ROW_1888)).toBe(true);
    expect(anchorsById(db)).toEqual([
      [1, 'global'],
      [2, 'project:igris-ai'],
    ]);
    expect(rows(db).every((r) => r.seen_count === 1)).toBe(true);
    // Comparing the two blocks would admit 33 pairs hand-labelled DIFFERENT at
    // the same threshold (measured 2026-09-07) — so this stays a miss.
  });

  it('family 1: three phrasings of one cross-project finding land in THREE blocks (1822, then 1883 + 1885) — and would not merge in one', async () => {
    const deps = statefulDeps([emit(ROW_1822), emit(ROW_1883, ROW_1885)]);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });
    expect(count(db)).toBe(1);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });

    // THE SPLIT: the anchor is the illustrative brief each run cited.
    expect(anchorsById(db)).toEqual([
      [1, 'brief:br-074'],
      [2, 'brief:ts-003'],
      [3, 'brief:br-001'],
    ]);
    // AND THE BELOW-LINE MISS (D-0): put in one block they are compared, not
    // merged — every pair scores under 0.25, TD-445's threshold question.
    expect(score(ROW_1822, ROW_1883)).toBeCloseTo(0.238, 3);
    expect(score(ROW_1822, ROW_1885)).toBeCloseTo(0.2, 3);
    expect(score(ROW_1883, ROW_1885)).toBeCloseTo(0.238, 3);
    expect(matches(ROW_1822, ROW_1883)).toBe(false);
    expect(matches(ROW_1822, ROW_1885)).toBe(false);
    expect(matches(ROW_1883, ROW_1885)).toBe(false);
    expect(rows(db).every((r) => r.seen_count === 1)).toBe(true);
  });

  it('the live three-row shape: 1888 opens its own row beside 1801 (global) and 1880 (its same-block 0.209 miss)', async () => {
    const deps = statefulDeps([emit(ROW_1801, ROW_1880), emit(ROW_1888)]);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });
    expect(count(db)).toBe(2);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });

    expect(score(ROW_1880, ROW_1888)).toBeCloseTo(0.209, 3);
    expect(anchorsById(db)).toEqual([
      [1, 'global'],
      [2, 'project:igris-ai'],
      [3, 'project:igris-ai'],
    ]);
    expect(rows(db).every((r) => r.seen_count === 1)).toBe(true);
  });

  it('NEGATIVE CONTROL: a `brief:`-anchored portfolio row and a `project:` row with different claims stay two rows', async () => {
    const deps = statefulDeps([emit(ROW_1822), emit(ROW_1880)]);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });

    expect(matches(ROW_1822, ROW_1880)).toBe(false);
    expect(count(db)).toBe(2);
    expect(rows(db).every((r) => r.seen_count === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TD-454 — the PROJECT-SET GATE on the live path
// ---------------------------------------------------------------------------

/**
 * PROVENANCE. Four real rows, read 2026-09-07 from a `sqlite3 -readonly …
 * .backup` copy of the operator brain (1,914 rows), every column the stored
 * value byte-for-byte. `1495` / `1660` share the block `project:lifeos`, score
 * 0.314 on the tokeniser and are hand-labelled DIFFERENT (`lifeos_dark` vs
 * `zero_learnings_projects`): at HEAD the second BUMPED the first — a false
 * merge inside one block that no anchor change could see. They are one of the
 * six same-block DIFFERENT pairs the gate separates on the whole corpus
 * (`scripts/td454_pairs_separated.csv` is the cross-block record; the
 * same-block set is in the sweep's `td454_recall_cost.csv`). `1486` / `1698`
 * are the equal-list SAME control (both name the same four projects) — the
 * gate must leave that bump alone, or "two rows" above would be a dead
 * discriminator rather than a working one.
 *
 * THE VOCABULARY IS THE `projects` TABLE, loaded by the extractor per run;
 * seeding the four slugs here is what arms the gate (M4 in the TD-454 battery
 * drops the vocabulary from the extractor and this case reds).
 */
const ROW_1495: Row = {
  id: 1495,
  source_module: "unlearning_project",
  project_slug: "lifeOS",
  entity_key: "project:lifeos",
  priority: "medium",
  confidence: 0.6,
  title:
    "lifeOS has 14 open briefs including a P0 accessibility regression but zero learnings and no recorded activity — the brain is capturing nothing from this project",
  evidence:
    "{\"brief_id\":\"BR-023\",\"note\":\"Project row shows learnings=0 and days_since_activity=null while 14 briefs (BR-023 P0-Critical, plus BR-024..BR-036) sit Ready/In Progress at 118-119 days. Same shape for attendance_app, hadir-system, moca-hr-agent — likely briefs imported without a working session attached.\"}",
  suggested_action: null,
};

const ROW_1660: Row = {
  id: 1660,
  source_module: "unharvested_project",
  project_slug: "lifeOS",
  entity_key: "project:lifeos",
  priority: "low",
  confidence: 0.65,
  title:
    "Four active projects carry 19 open briefs between them and zero learnings — nothing from lifeOS, attendance_app, hadir-system or moca-hr-agent has ever been harvested into the brain",
  evidence:
    "{\"note\":\"projects rows: lifeOS (14 open briefs, 0 learnings, days_since_activity null), attendance_app (4, 0, null), hadir-system (1, 0, null), moca-hr-agent (1, 0, null). Contrast with igris-ai (593), mbrgea-ai (188), moca-ai-agent (186). days_since_activity null alongside open briefs suggests these projects are tracked in the brain but worked outside it, so their defect patterns never reach the shared memory.\"}",
  suggested_action:
    "{\"kind\":\"harvest\",\"project_slug\":\"lifeOS\"}",
};

const ROW_1486: Row = {
  id: 1486,
  source_module: "learning_capture_gap",
  project_slug: null,
  entity_key: "global",
  priority: "medium",
  confidence: 0.6,
  title:
    "Four active projects with open briefs (lifeOS 14, attendance_app 4, hadir-system 1, moca-hr-agent 1) have zero learnings and null activity — work there is not reaching the brain",
  evidence:
    "{\"note\":\"projects rows: lifeOS (14 open briefs, 0 learnings, null activity), attendance_app (4/0/null), hadir-system (1/0/null), moca-hr-agent (1/0/null). Meanwhile briefs in lifeOS and attendance_app carry recent-ish update timestamps (118-156 days), so briefs are being written for these projects but no session activity or learning is being captured — the instrumentation, not the work, is likely missing.\"}",
  suggested_action:
    "{\"kind\":\"investigate_instrumentation\",\"project_slugs\":[\"lifeOS\",\"attendance_app\",\"hadir-system\",\"moca-hr-agent\"]}",
};

const ROW_1698: Row = {
  id: 1698,
  source_module: "knowledge_capture_gap",
  project_slug: null,
  entity_key: "global",
  priority: "medium",
  confidence: 0.7,
  title:
    "Four projects with open briefs (lifeOS 14, attendance_app 4, hadir-system 1, moca-hr-agent 1) have zero learnings and null activity — work is being briefed but never executed or never harvested",
  evidence:
    "{\"note\":\"Project rows: lifeOS (14 open_briefs, 0 learnings, days_since_activity null), attendance_app (4, 0, null), hadir-system (1, 0, null), moca-hr-agent (1, 0, null). 20 open briefs total behind projects the brain has never observed activity on. Contrast with igris-ai/mbrgea-ai/moca-ai-agent, all at days_since_activity 0. Either these projects are worked outside the brain's view (an instrumentation gap) or the briefs are dead inventory.\"}",
  suggested_action: null,
};

describe('TD-454 — the project-set gate on the live path (real rows, real projects table)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
    const ins = db.prepare(`INSERT INTO projects (slug, name, path) VALUES (?, ?, ?)`);
    for (const slug of ['lifeOS', 'attendance_app', 'hadir-system', 'moca-hr-agent']) ins.run(slug, slug, `/tmp/${slug}`);
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, title, status, priority, updated_at)
       VALUES ('lifeOS', 'BR-023', 'a11y regression', 'In Progress', 'P0', '2026-03-01 00:00:00')`,
    ).run();
  });
  afterEach(() => {
    db.close();
  });

  it('a same-block DIFFERENT pair (1495 then 1660, project:lifeos @ 0.314) files TWO rows — the gate refuses the bump the tokeniser would take', async () => {
    // The arming half: on the tokeniser alone they MATCH — this was a false merge at HEAD.
    expect(score(ROW_1495, ROW_1660)).toBeCloseTo(0.314, 3);
    expect(matches(ROW_1495, ROW_1660)).toBe(true);

    const deps = statefulDeps([emit(ROW_1495), emit(ROW_1660)]);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });
    expect(count(db)).toBe(1);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });

    expect(count(db)).toBe(2);
    expect(anchorsById(db)).toEqual([
      [1, 'project:lifeos'],
      [2, 'project:lifeos'],
    ]);
    expect(rows(db).every((r) => r.seen_count === 1)).toBe(true);
  });

  it('POSITIVE CONTROL: an equal-list SAME pair (1486 then 1698, global) still BUMPS — the gate refuses unequal sets only', async () => {
    const deps = statefulDeps([emit(ROW_1486), emit(ROW_1698)]);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps });

    expect(count(db)).toBe(1);
    expect(rows(db)[0]!.seen_count).toBe(2);
  });
});
