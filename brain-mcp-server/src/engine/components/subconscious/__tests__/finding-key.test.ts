/**
 * TD-440 — the finding key, and the LABELLED BOUNDARY CORPUS that guards it
 * (AC-3, AC-4).
 *
 * PROVENANCE OF THE CORPUS. Every title below was copied byte-for-byte out of
 * the operator brain's `suggestions` table (read-only, from a scratch copy).
 * Nothing here is invented, and nothing was edited to make a case pass — a
 * hand-tuned fixture would only prove the fixture. The SAME/DIFFERENT labels
 * are the hand-authored part, and where a real row genuinely blends two
 * findings it was EXCLUDED rather than forced into a group.
 *
 * WHAT THIS FILE IS FOR. The threshold and the metric were chosen by sweeping
 * a larger corpus than the excerpt below (113 hand-labelled rows across two
 * projects), and this file is the gate that reds if either is moved. Two
 * different numbers, so they are not confused:
 *   - over the FULL sweep corpus the highest-scoring pair of genuinely
 *     DIFFERENT findings sharing an entity scored **0.226**, and **0.25**
 *     produced zero false merges on that corpus AND on a held-out corpus from
 *     a second project. That is where the shipped default comes from — but it
 *     is a value TUNED inside a clean band, not a step above a gap: over the
 *     full 410-row population the cluster count is a smooth slope (140 at
 *     0.226, 153 at 0.25, 198 at 0.30, measured 2026-09-03) with no plateau.
 *     `docs/architecture/subconscious_engine.md` carries the slope and the two
 *     near-line merges it admits. This file is the gate that reds if the value
 *     moves; it is NOT evidence that the value is the only clean one.
 *   - over the EXCERPT in this file the DIFFERENT arm tops out at **0.192**,
 *     asserted below. It is lower simply because the excerpt is smaller.
 *
 * THE TWO ARMS OVERLAP PAIRWISE and that is recorded rather than hidden: the
 * lowest SAME pair here is 0.176, BELOW the highest DIFFERENT pair. No
 * threshold separates every pair, which is why precision is asserted per PAIR
 * (it must never bend) and recall per GROUP (the matcher takes the best match
 * in a block, so a re-emission that misses one anchor lands on another).
 *
 * @module engine/components/subconscious/__tests__/finding-key.test
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  GLOBAL_ENTITY_KEY,
  backfillFindingKeys,
  claimOf,
  claimSimilarity,
  claimTokens,
  claimsMatch,
  entityKey,
  findingKey,
  subjectIds,
} from '../finding-key.js';
import { subconsciousMigrations } from '../schema.js';
import { DEFAULT_SUBCONSCIOUS_CONFIG, type SuggestionCandidate } from '../types.js';

const THRESHOLD = DEFAULT_SUBCONSCIOUS_CONFIG.dedupe_claim_overlap;
const MIN_TOKENS = DEFAULT_SUBCONSCIOUS_CONFIG.dedupe_min_claim_tokens;

function candidate(over: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return {
    source_module: 'abandoned_project',
    project_slug: null,
    title: 'a title',
    evidence: {},
    priority: 'medium',
    ...over,
  };
}

const match = (a: string, b: string): boolean =>
  claimsMatch(claimOf(a), claimOf(b), THRESHOLD, MIN_TOKENS);

// ---------------------------------------------------------------------------
// entityKey — the blocking anchor
// ---------------------------------------------------------------------------

describe('entityKey', () => {
  it('prefers the project over any cited id', () => {
    expect(
      entityKey(
        candidate({ project_slug: 'fifty_eco_system', evidence: { brief_id: 'BR-037' } }),
      ),
    ).toBe('project:fifty_eco_system');
  });

  it('is INSENSITIVE to which example brief the model attached', () => {
    // The measured instability: one finding's 38 real rows cite AC-001, BR-037,
    // BR-029, BR-040, BR-074 and null. A key built from the identifier SET
    // splits that finding across six blocks and can never match it.
    const ids = ['AC-001', 'BR-037', 'BR-029', 'BR-040', 'BR-074', undefined];
    const keys = new Set(
      ids.map((id) =>
        entityKey(
          candidate({
            project_slug: 'fifty_eco_system',
            evidence: id === undefined ? {} : { brief_id: id },
          }),
        ),
      ),
    );
    expect([...keys]).toEqual(['project:fifty_eco_system']);
  });

  it('falls back through brief, learning, suggestion, then global', () => {
    expect(entityKey(candidate({ evidence: { brief_id: 'BR-1' } }))).toBe('brief:br-1');
    expect(entityKey(candidate({ evidence: { learning_id: 42 } }))).toBe('learning:42');
    expect(entityKey(candidate({ evidence: { suggestion_id: 9 } }))).toBe('suggestion:9');
    expect(entityKey(candidate())).toBe(GLOBAL_ENTITY_KEY);
  });

  it('reads id-shaped params off suggested_action', () => {
    expect(
      entityKey(candidate({ suggested_action: { kind: 'flag_for_review', brief_id: 'TD-9' } })),
    ).toBe('brief:td-9');
    expect(
      entityKey(candidate({ suggested_action: { kind: 'merge', survivor_id: 7 } })),
    ).toBe('learning:7');
  });

  it('reads evidence.project_slug when the candidate has no project of its own', () => {
    expect(entityKey(candidate({ evidence: { project_slug: 'lifeOS' } }))).toBe(
      'project:lifeos',
    );
  });
});

// ---------------------------------------------------------------------------
// AC-3 / AC-4 — the key ignores everything the model re-authors
// ---------------------------------------------------------------------------

describe('findingKey is independent of the model free choices (AC-3, AC-4)', () => {
  const EIGHT_LABELS = [
    'abandoned_project',
    'project_abandonment',
    'abandoned_project_backlog',
    'abandoned_project_cluster',
    'portfolio_abandonment',
    'stalled_project_wholesale',
    'dormant_project_backlog',
    'stale_project_scope',
  ];

  it('is byte-identical across all 8 observed abandoned_project label variants', () => {
    const keys = new Set(
      EIGHT_LABELS.map((source_module) =>
        findingKey(candidate({ source_module, project_slug: 'fifty_eco_system' })),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it('is byte-identical when only evidence.note changes (the G3 mechanic)', () => {
    const a = findingKey(
      candidate({ project_slug: 'x', evidence: { brief_id: 'BR-1', note: 'first wording' } }),
    );
    const b = findingKey(
      candidate({ project_slug: 'x', evidence: { brief_id: 'BR-1', note: 'entirely other' } }),
    );
    expect(a).toBe(b);
  });

  it('survives 50 random source_module strings as exactly ONE key (AC-4 fuzz)', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 50; i++) {
      keys.add(
        findingKey(
          candidate({
            source_module: `kind_${Math.random().toString(36).slice(2)}`,
            project_slug: 'p',
            evidence: { brief_id: 'BR-1', note: `note ${i}` },
          }),
        ),
      );
    }
    expect(keys.size).toBe(1);
  });

  it('DOES change when the title names a different brief', () => {
    // Guards the hash, not just the matcher: `claimTokens` cannot see `BR-128`
    // (normalisation makes it `br 128`, both dropped), so without the subject
    // ids in the hashed material these two would share an exact key and stage A
    // would merge them behind the subject gate's back.
    const a = findingKey(candidate({ project_slug: 'p', title: 'BR-128 is stalled 105 days' }));
    const b = findingKey(candidate({ project_slug: 'p', title: 'BR-023 is stalled 105 days' }));
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// The tokeniser and the subject gate
// ---------------------------------------------------------------------------

describe('claimTokens / subjectIds', () => {
  it('drops short and pure-numeric tokens', () => {
    expect([...claimTokens('BR-1 is In Progress 189 days')].sort()).toEqual([
      'days',
      'progress',
    ]);
  });

  it('extracts the identifiers normalisation destroys', () => {
    expect([...subjectIds('BR-128 and TD-005 and AC-001')].sort()).toEqual([
      'ac-001',
      'br-128',
      'td-005',
    ]);
    expect([...subjectIds('no identifiers here')]).toEqual([]);
  });

  it('refuses a merge when both titles name identifiers and they are disjoint', () => {
    const a = 'BR-128 is the only P0-Critical brief in the brain and has sat In Progress 105 days';
    const b = 'BR-023 is the only P0-Critical brief in the brain and has sat In Progress 105 days';
    // The prose is otherwise identical, so the similarity score alone says merge.
    expect(claimSimilarity(claimTokens(a), claimTokens(b))).toBe(1);
    expect(match(a, b)).toBe(false);
  });

  it('one empty subject set is NOT disjoint — a project finding absorbs an example', () => {
    const project = 'fifty_eco_system holds 34 open briefs but has had zero activity for 171 days';
    const withId =
      'fifty_eco_system holds 34 open briefs but has had zero activity for 171 days (BR-037)';
    expect(match(project, withId)).toBe(true);
  });

  it('below dedupe_min_claim_tokens it demands token-set EQUALITY, not similarity', () => {
    // A short claim fully contained in a long one must not merge.
    expect(match('queue flooded', 'the review queue is flooded by mechanical rows')).toBe(false);
    expect(match('queue flooded', 'flooded queue')).toBe(true);
  });

  it('an empty claim never matches anything', () => {
    expect(claimSimilarity(new Set(), new Set(['a']))).toBe(0);
    expect(match('', 'anything at all here')).toBe(false);
  });

  it('threshold above 1.0 is the kill switch', () => {
    const a = 'fifty_eco_system holds 34 open briefs with zero activity for 171 days';
    expect(claimsMatch(claimOf(a), claimOf(a), 1.01, MIN_TOKENS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE LABELLED BOUNDARY CORPUS
// ---------------------------------------------------------------------------

/**
 * Real titles, grouped by the finding they express. Pairs WITHIN a group are
 * SAME; pairs ACROSS two groups in the same block are DIFFERENT — and every
 * cross pair here shares an entity, which is what makes them adversarial
 * rather than easy.
 */
const CORPUS: Record<string, Record<string, string[]>> = {
  'project:fifty_eco_system': {
    abandoned: [
      'fifty_eco_system holds 34 open briefs but has had zero activity for 171 days — decide whether to archive the project or schedule a deliberate restart',
      'fifty_eco_system has 34 open briefs but zero activity for 173 days — decide whether to archive the project or schedule a dedicated triage session',
      'fifty_eco_system holds 34 open briefs but has seen zero activity for 173 days — decide whether to archive the project or re-commit to it, rather than triaging 30 stalled briefs one at a time',
      'fifty_eco_system has 34 open briefs but zero activity for 180 days — decide whether to archive the project or schedule a revival sprint',
    ],
    duplicate_slug: [
      "Two near-identical project slugs exist — 'fifty_eco_system' (34 open briefs, 0 learnings) and 'fifty-eco-system' (0 briefs, 7 learnings); knowledge and work are split across a spelling variant",
      'Two project slugs differ only by separator — fifty_eco_system (34 open briefs) vs fifty-eco-system (7 learnings, 0 briefs) — so briefs and learnings for one codebase are split across two brain projects',
      "Two project slugs for the same codebase — 'fifty_eco_system' (34 open briefs, 0 learnings) and 'fifty-eco-system' (0 briefs, 7 learnings) — the brief and learning layers are split across a naming variant",
    ],
    unchecked_ac: [
      "27 'Done but unchecked acceptance criteria' suggestions all land on fifty_eco_system — treat as one process defect (bulk AC audit), not 27 individual reviews",
      '27 fifty_eco_system briefs are marked Done with unchecked acceptance criteria — this is a closing-discipline failure, not 27 separate defects, and igris-ai already shipped a gate for it',
      '27 fifty_eco_system briefs were marked Done with unchecked acceptance criteria — treat this as one process defect in the close ritual, not 27 individual cleanups',
    ],
    queue_flood: [
      '60 of 68 open suggestions are mechanical stalled/gap rows for one dormant project — the review queue is unusable until they are batch-resolved',
      "58 of 61 open suggestions are mechanical 'stalled'/'gap' rows for one project — the review queue is saturated and will bury any genuinely novel finding",
    ],
  },
  'project:lifeOS': {
    p0_unattended: [
      'lifeOS BR-023 is the only P0-Critical brief in the brain and has sat In Progress for 105 days with no project activity recorded',
      'BR-023 is the only P0-Critical brief in the brain, has sat In Progress for 105 days, and no stalled suggestion covers it',
      'BR-023 is the only P0-Critical brief in the brain and has sat In Progress for 108 days with no activity',
      'lifeOS BR-023 is the only P0-Critical brief in the system, In Progress and untouched for 111 days',
    ],
    batch_sweep: [
      'lifeOS filed 13 bug briefs in one sweep (BR-024…BR-036) and none moved off Ready in 109 days — a whole QA pass was captured and abandoned',
      'Thirteen lifeOS briefs (BR-024..BR-036) were all filed together 110 days ago and none has moved — the whole QA sweep is stalled',
      '13 lifeOS briefs (BR-024…BR-036) were all filed the same day 118 days ago and none has moved — likely a one-off audit dump',
    ],
    harvest_gap: [
      'lifeOS has 14 open briefs including a P0 accessibility regression but zero learnings recorded — a full bug sweep produced no captured knowledge',
      'lifeOS has 14 open briefs including a P0 accessibility regression but zero recorded learnings and no activity timestamp at all',
    ],
  },
};

function withinPairs(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const [block, groups] of Object.entries(CORPUS))
    for (const [name, titles] of Object.entries(groups))
      for (let i = 0; i < titles.length; i++)
        for (let j = i + 1; j < titles.length; j++)
          out.push([`${block}/${name}`, titles[i]!, titles[j]!]);
  return out;
}

function acrossPairs(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const [block, groups] of Object.entries(CORPUS)) {
    const names = Object.keys(groups);
    for (let a = 0; a < names.length; a++)
      for (let b = a + 1; b < names.length; b++)
        for (const x of groups[names[a]!]!)
          for (const y of groups[names[b]!]!)
            out.push([`${block} ${names[a]}|${names[b]}`, x, y]);
  }
  return out;
}

describe('the labelled boundary corpus (the over-merge falsifier)', () => {
  const same = withinPairs();
  const diff = acrossPairs();

  it('has enough adversarial material to be worth trusting', () => {
    // A corpus this gate can pass vacuously is not a gate. Both arms are
    // asserted so a future edit that deletes rows reds here first.
    expect(same.length).toBeGreaterThanOrEqual(20);
    expect(diff.length).toBeGreaterThanOrEqual(40);
  });

  /**
   * PRECISION IS ASSERTED PAIRWISE, and this is the arm that must never bend.
   * A false merge destroys a true finding; a missed merge only leaves the row
   * count where it already was. Lower `dedupe_claim_overlap` and these red.
   */
  it.each(diff)('DIFFERENT — %s', (_label, a, b) => {
    expect(match(a, b)).toBe(false);
  });

  /**
   * RECALL IS ASSERTED PER GROUP, NOT PER PAIR — and the distinction is a
   * measured fact about the corpus, not a convenience.
   *
   * The two arms OVERLAP pairwise: the lowest-scoring SAME pair here is 0.176
   * and the highest-scoring DIFFERENT pair is 0.192, so NO threshold separates
   * every pair. That is reported rather than engineered away, because the
   * matcher does not need pairwise separation: a candidate is compared against
   * every pending row in its block and takes the BEST match, so a re-emission
   * that misses the first anchor still lands on a later one. The property the
   * queue actually depends on is that a group COLLAPSES, and that is what is
   * asserted here — by replaying the real accept/merge loop.
   */
  function collapse(titles: string[]): number {
    const anchors: Array<ReturnType<typeof claimOf>> = [];
    for (const title of titles) {
      const c = claimOf(title);
      const hit = anchors.some((anchor) => claimsMatch(c, anchor, THRESHOLD, MIN_TOKENS));
      if (!hit) anchors.push(c);
    }
    return anchors.length;
  }

  const groups = Object.entries(CORPUS).flatMap(([block, gs]) =>
    Object.entries(gs).map(([name, titles]) => [`${block}/${name}`, titles] as const),
  );

  /**
   * The MEASURED collapse per group, pinned exactly. Not every group reaches a
   * single row and saying so is the point: `unchecked_ac`'s first title is
   * phrased far enough from the other two to stay its own finding at this
   * threshold. Pinning the number rather than asserting "collapses" makes BOTH
   * directions visible — lower the threshold and these drop toward 1 while the
   * DIFFERENT arm above starts failing; raise it and they climb toward the
   * input size.
   */
  const EXPECTED_COLLAPSE: Record<string, [number, number]> = {
    'project:fifty_eco_system/abandoned': [4, 1],
    'project:fifty_eco_system/duplicate_slug': [3, 1],
    'project:fifty_eco_system/unchecked_ac': [3, 2],
    'project:fifty_eco_system/queue_flood': [2, 1],
    'project:lifeOS/p0_unattended': [4, 1],
    'project:lifeOS/batch_sweep': [3, 1],
    'project:lifeOS/harvest_gap': [2, 1],
  };

  it.each(groups)('SAME group collapse is the measured one — %s', (label, titles) => {
    const expected = EXPECTED_COLLAPSE[label];
    expect(expected, `no pinned collapse for ${label}`).toBeDefined();
    expect(titles.length).toBe(expected![0]);
    expect(collapse(titles)).toBe(expected![1]);
  });

  it('every group collapses at least somewhat, and none is left untouched', () => {
    // The guard against a threshold so high that the whole mechanism is inert —
    // which would leave every assertion above passing vacuously.
    const collapsed = groups.filter(([, titles]) => collapse(titles) < titles.length);
    expect(collapsed.length).toBe(groups.length);
  });

  it('records the measured margin, and reds if either arm moves across it', () => {
    const sameScores = same.map(([, a, b]) => claimSimilarity(claimTokens(a), claimTokens(b)));
    const diffScores = diff.map(([, a, b]) => claimSimilarity(claimTokens(a), claimTokens(b)));
    const diffMax = Math.max(...diffScores);
    const sameMax = Math.max(...sameScores);

    // The numbers this corpus was swept to produce. The threshold sits ABOVE
    // every DIFFERENT pair — that is the guarantee — and below the top of the
    // SAME arm, which is what makes collapse possible at all.
    expect(diffMax).toBeCloseTo(0.192, 3);
    expect(THRESHOLD).toBeGreaterThan(diffMax);
    expect(sameMax).toBeGreaterThan(THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// backfillFindingKeys
// ---------------------------------------------------------------------------

describe('backfillFindingKeys', () => {
  function migrated(): Database.Database {
    const db = new Database(':memory:');
    for (const m of subconsciousMigrations) db.exec(m.sql);
    return db;
  }

  it('keys pre-v5 rows and is idempotent', () => {
    const db = migrated();
    try {
      db.prepare(
        `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status)
         VALUES ('abandoned_project', 'fifty_eco_system', 'a stale project backlog', '{}', 'low', 'pending')`,
      ).run();
      db.prepare(`UPDATE suggestions SET dedupe_key = NULL, entity_key = NULL`).run();

      expect(backfillFindingKeys(db)).toBe(1);
      const row = db.prepare(`SELECT * FROM suggestions`).get() as {
        dedupe_key: string;
        entity_key: string;
      };
      expect(row.entity_key).toBe('project:fifty_eco_system');
      expect(row.dedupe_key).toMatch(/^[0-9a-f]{40}$/);

      // A keyed row is never revisited.
      expect(backfillFindingKeys(db)).toBe(0);
      const after = db.prepare(`SELECT dedupe_key FROM suggestions`).get() as {
        dedupe_key: string;
      };
      expect(after.dedupe_key).toBe(row.dedupe_key);
    } finally {
      db.close();
    }
  });

  it('degrades to 0 on a schema without the v5 columns rather than throwing', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE suggestions (id INTEGER PRIMARY KEY, title TEXT)`);
      expect(backfillFindingKeys(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('keys a row whose evidence JSON is malformed instead of throwing', () => {
    const db = migrated();
    try {
      db.prepare(
        `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status, dedupe_key)
         VALUES ('k', 'p', 'a title with several words', 'not json{', 'low', 'pending', NULL)`,
      ).run();
      expect(backfillFindingKeys(db)).toBe(1);
    } finally {
      db.close();
    }
  });
});
