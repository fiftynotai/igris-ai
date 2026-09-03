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
