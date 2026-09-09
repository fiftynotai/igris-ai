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
 * TD-445 (2026-09-04) RE-SWEPT THE VALUE AGAINST PRODUCTION and kept it. The
 * instrument is `scripts/td445_claim_threshold_sweep.ts` (its slope on cut C1
 * reproduces TD-440's row point for point); the marginal band below 0.25 was
 * hand-labelled per row and every candidate that catches a production miss
 * admits DIFFERENT pairs (97 at 0.22, 137 at 0.21, 207 at 0.20). The
 * `PRODUCTION_PAIRS` block at the end of this file pins those misses AS
 * misses. Note what this excerpt cannot see: at 0.22 / 0.21 / 0.20 every case
 * in this file stays green, because its DIFFERENT arm tops out at 0.192 — the
 * excerpt floors the value at 0.192, the labelled marginal set is what holds it
 * at 0.25.
 *
 * @module engine/components/subconscious/__tests__/finding-key.test
 */

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  GLOBAL_ENTITY_KEY,
  backfillFindingKeys,
  candidateFromRow,
  claimOf,
  claimSimilarity,
  claimTokens,
  claimsMatch,
  entityKey,
  findingKey,
  loadProjectVocabulary,
  MODULE_VOCABULARY,
  namedModules,
  namedProjects,
  subjectIds,
} from '../finding-key.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

  // TD-457 (2026-09-08) MOVED this pin: before, `evidence.brief_id: 'BR-1'`
  // under the helper's title `'a title'` read `brief:br-1`. The evidence brief
  // is an ILLUSTRATION unless the title names it (the a-narrow measurement:
  // 15 pairs newly comparable, 15 SAME, 0 DIFFERENT under the project-set gate).
  it('falls back through brief (when the title names it), learning, suggestion, then global', () => {
    expect(entityKey(candidate({ title: 'BR-1 is stale', evidence: { brief_id: 'BR-1' } }))).toBe('brief:br-1');
    expect(entityKey(candidate({ evidence: { brief_id: 'BR-1' } }))).toBe(GLOBAL_ENTITY_KEY);
    expect(entityKey(candidate({ evidence: { learning_id: 42 } }))).toBe('learning:42');
    expect(entityKey(candidate({ evidence: { suggestion_id: 9 } }))).toBe('suggestion:9');
    expect(entityKey(candidate())).toBe(GLOBAL_ENTITY_KEY);
  });

  it('TD-457: does not anchor on an evidence brief the title never names — the three family-1 shapes read global', () => {
    // 1822 / 1883 / 1885 verbatim: one portfolio finding, three illustrative briefs.
    const shapes: Array<[string, Record<string, unknown>]> = [
      ["Eleven briefs across five projects are marked 'In Progress' with 132–191 days since update — 'In Progress' is being used as a filing state, not a work state, so no dashboard can tell what is actually being worked on", {"brief_id":"BR-074","note":"In Progress + stale: BR-074/BR-076/TD-004/TD-006/TD-007/TS-003 (fifty_eco_system, 170-191d), BR-001 hadir-system (175d), BR-002/BR-003/BR-004 attendance_app (170d), BR-027/BR-028 hadir (147-149d), BR-023 lifeOS (132d). Meanwhile igris-ai/mbrgea-ai/moca-ai-agent show days_since_activity 0 with work shipping. Suggestion 1697 covers BR-023 alone; this is the systemic version — a staleness rule that auto-demotes In Progress back to Ready."}],
      ["Ten briefs are 'In Progress' with 133–191 days since update across five projects with zero recorded activity — 'In Progress' has decayed into a synonym for 'abandoned mid-flight' and no longer signals anything to the operator", {"brief_id":"TS-003","note":"In Progress + stale: BR-074, BR-076, TD-004, TD-006, TD-007 (191d), BR-002/003/004 attendance_app and TS-003 (171d), BR-001 hadir-system (175d), BR-027/BR-028 hadir (147-149d), BR-023 lifeOS (133d). attendance_app and lifeOS both report days_since_activity null, so nothing was ever in progress. Suggestion 1697 covers only BR-023; this is the class."}],
      ["Fourteen briefs across six projects sit at 'In Progress' with 133–191 days since update — no project has more than one genuinely active workstream, so the In Progress set is almost entirely false", {"brief_id":"BR-001","note":"In Progress briefs with null or ancient activity: attendance_app BR-002/BR-003/BR-004 (171d, activity null), hadir-system BR-001 (175d, activity null), hadir BR-027/BR-028 (147-149d, activity 126d), lifeOS BR-023 (133d, activity null), fifty_eco_system BR-074/BR-076/TD-004/TD-006/TD-007/TS-003 (191d, activity 188d). A system-wide status hygiene pass is needed, not per-project fixes."}],
    ];
    for (const [title, evidence] of shapes) {
      expect(subjectIds(title).size).toBe(0);
      expect(entityKey(candidate({ title, evidence }))).toBe(GLOBAL_ENTITY_KEY);
    }
  });

  it('TD-457: still anchors on the ACTION target brief the title does not name — a target, not an illustration', () => {
    // The instrument measured exactly this semantics (`candidateAnchor` removes
    // evidence.brief_id / brief_ids only): a suggested_action.brief_id is what
    // the handler acts ON, so two findings that act on BR-9 belong together.
    expect(entityKey(candidate({ suggested_action: { kind: 'flag_for_review', brief_id: 'TD-9' } }))).toBe('brief:td-9');
    expect(
      entityKey(candidate({ evidence: { brief_id: 'BR-1' }, suggested_action: { kind: 'flag_for_review', brief_id: 'TD-9' } })),
    ).toBe('brief:td-9');
  });

  it('TD-457: still anchors on a learning the title does not name — id-bound, the measured false-merge class', () => {
    expect(entityKey(candidate({ evidence: { learning_id: 42 } }))).toBe('learning:42');
    expect(entityKey(candidate({ evidence: { brief_id: 'BR-1', learning_id: 42 } }))).toBe('learning:42');
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
// TD-445 — THE PRODUCTION WINDOW: the misses, pinned as misses
// ---------------------------------------------------------------------------

/**
 * PROVENANCE. Four real pairs from TD-445's production measurement (T0
 * `2026-09-03 12:42:03Z`, three new-bundle runs), copied from a read-only
 * `.backup` of the operator brain taken 2026-09-04 — every field below is the
 * stored column byte-for-byte, including `entity_key` as the writer stamped it.
 * Nothing was edited to make a case pass.
 *
 * WHAT THEY ARE. Three same-anchor re-emissions that scored BELOW the shipped
 * threshold and were filed as new rows (the brief's AC-5 "underperforms"), and
 * the 0.128 control the brief called a correct non-merge. The anchor is the
 * SAME on every pair, which is what makes them this brief's and not TD-452's
 * (the anchor-split misses).
 *
 * WHY THEY ARE PINNED AS MISSES AND NOT FIXED. TD-445 re-swept the whole
 * corpus (431 rows, `scripts/td445_claim_threshold_sweep.ts`, row labels in
 * `scripts/td445_row_findings.csv`, the derived pair labels in
 * `scripts/td445_marginal_pairs_labeled.csv`) at 0.22 / 0.21 / 0.20. Every
 * candidate that catches one of these pairs also admits pairs hand-labelled
 * DIFFERENT — 97 at 0.22, 137 at 0.21, 207 at 0.20, the highest at 0.243 — so
 * the value stayed at 0.25 (`docs/architecture/subconscious_engine.md` §"TD-445
 * production re-sweep"). These cases red if a future re-tune moves the value
 * far enough to catch a pair WITHOUT re-reading that labelled set. The third
 * pair reads DIFFERENT on the labelling rule (the audit action vs the
 * traceability action), so on that reading it is a correct non-merge — and it
 * sits below the excerpt's 0.192 floor regardless.
 */
const PRODUCTION_PAIRS = [
  {
    ids: [1880, 1888] as const,
    score: 0.209,
    label: 'SAME',
    note: "'44 of 60 edge_inference' — catchable only at t ≤ 0.209, where M(0.20) carries 207 DIFFERENT pairs",
    a: {
      id: 1880,
      project_slug: "igris-ai",
      entity_key: "project:igris-ai",
      title:
        "The digest's own edge_inference module emitted 44 of 60 open suggestions as one-line 'inferred edge' rows over learnings 6–1447, drowning the 17 substantive findings — the subconscious queue needs the same dedup/batching treatment commit 6d077a1 applied to findings",
      evidence:
        "{\"note\":\"open_suggestions ids 1712–1755 are all source_module=edge_inference, each proposing a single graph edge, many over learnings from the 6–425 range (i.e. long-settled history). Commit 6d077a1 'fix(subconscious): dedup findings on a key stable under LLM paraphrase' shows the noise problem is already recognized for findings but not for edge proposals. An operator review queue where 73% of rows are mechanical edge assertions is one an operator stops reading.\"}",
      suggested_action:
        "{\"kind\":\"batch_or_autoapply_suggestion_module\",\"source_module\":\"edge_inference\",\"proposal\":\"auto-apply high-confidence edges without operator review, or collapse into a single batched 'N inferred edges' row\"}",
    },
    b: {
      id: 1888,
      project_slug: "igris-ai",
      entity_key: "project:igris-ai",
      title:
        "44 of 60 open suggestions are low-value edge_inference rows — they crowd out substantive findings in the review queue and should be batched or auto-applied rather than queued individually",
      evidence:
        "{\"note\":\"open_suggestions ids 1712–1755 are all source_module=edge_inference, each proposing a single learning→learning edge. They occupy 73% of the operator's queue while carrying no decision content. Commit 6d077a1 ('fix(subconscious): dedup findings on a key stable under LLM paraphrase') shows queue quality is already a known concern; edge inference is the remaining volume source.\"}",
      suggested_action:
        "{\"kind\":\"change_suggestion_routing\",\"source_module\":\"edge_inference\",\"from\":\"individual_queued_suggestion\",\"to\":\"batched_review_or_auto_apply_above_threshold\"}",
    },
  },
  {
    ids: [1814, 1823] as const,
    score: 0.216,
    label: 'SAME',
    note: "igris-ai backlog, two heads — catchable only at t ≤ 0.216, where M(0.21) carries 137 DIFFERENT pairs",
    a: {
      id: 1814,
      project_slug: "igris-ai",
      entity_key: "project:igris-ai",
      title:
        "igris-ai carries 165 open briefs and 602 learnings — by far the largest backlog in the system and roughly 2.5x the next project — with no evidence of any closure or archive rhythm",
      evidence:
        "{\"brief_id\":\"FR-112\",\"note\":\"igris-ai: open_briefs=165, learnings=602, days_since_activity=1 — it is the most active repo and simultaneously the largest backlog. Low-priority P3 briefs like FR-112 (Leiden clustering) and FR-114 (schema evolution) have sat Ready for 127 days. A backlog that only grows cannot be read; it needs a periodic archive gate, not another triage pass.\"}",
      suggested_action:
        "{\"kind\":\"recurring_review\",\"project_slug\":\"igris-ai\",\"cadence\":\"monthly\",\"rule\":\"Archive any P3-Low brief untouched for 90+ days unless explicitly renewed\"}",
    },
    b: {
      id: 1823,
      project_slug: "igris-ai",
      entity_key: "project:igris-ai",
      title:
        "igris-ai carries 166 open briefs while shipping daily — at the observed harvest rate the backlog is write-only, and the same containment/verification themes keep recurring as fresh learnings instead of closing briefs",
      evidence:
        "{\"learning_id\":1454,\"note\":\"166 open briefs, 603 learnings, days_since_activity 0. Commits f1d05ce, 8fce09d, 1eb88c5, 174282f, 07ea8d3 are all containment/gate work; learnings 1454 ('every guard needs a self-negative-control'), 1463, 1455 restate the same theme. Suggestion 1708 notes commits lack matching briefs; the complementary risk is 166 briefs that no commit will ever reach. Recommend a brief-age cap or a WIP limit rather than more triage passes.\"}",
      suggested_action:
        null,
    },
  },
  {
    ids: [1879, 1887] as const,
    score: 0.186,
    label: 'DIFFERENT',
    note: "'Learning 1509 ↔ e7435d0' — below the excerpt floor (0.192), and hand-labelled DIFFERENT at TD-445: the audit action vs the traceability action",
    a: {
      id: 1879,
      project_slug: "igris-ai",
      entity_key: "project:igris-ai",
      title:
        "Learning 1509 ('a Done brief can silently flip back to Ready with no brief event') plus the brief-disk-projection and status-sync-clobber commits suggest some of the 191-day 'Ready' fifty_eco_system briefs may be silently-reverted completed work, not real backlog",
      evidence:
        "{\"learning_id\":1509,\"brief_id\":\"BR-029\",\"note\":\"Learning 1509 documents a Done->Ready flip with no brief event; commit e7435d0 'guard brief disk projection against status-sync clobber' and learning 1495 ('igris_brief_sync re-materialises the brief FILE from the brain') describe the same mechanism. Before any bulk triage/archive of the 33 fifty_eco_system briefs, their status should be checked against merge-base rather than trusted — otherwise finished work gets re-opened or archived as never-done.\"}",
      suggested_action:
        "{\"kind\":\"audit_brief_status_against_git_history\",\"project_slug\":\"fifty_eco_system\",\"method\":\"merge-base check per brief_id, per learning 1509\",\"scope\":\"all 33 open briefs\"}",
    },
    b: {
      id: 1887,
      project_slug: "igris-ai",
      entity_key: "project:igris-ai",
      title:
        "Learning 1509 documents a Done brief silently flipping back to Ready, and commit e7435d0 guards exactly that — but nothing in the digest links the fix to the learning or to a brief",
      evidence:
        "{\"learning_id\":1509,\"note\":\"Learning 1509: 'A Done brief can silently flip back to Ready with no brief event'. Commit e7435d0: 'fix(brain): guard brief disk projection against status-sync clobber'. Same defect, same day-range, no brief in the open set covers it. The same pairing holds for learning 1507 and commit a3d8a4a (claude CLI error envelopes). Discovery→fix pairs are landing without a durable link, so the learning cannot later be scored as acted-upon.\"}",
      suggested_action:
        "{\"kind\":\"link_learning_to_commit\",\"pairs\":[{\"learning_id\":1509,\"commit\":\"e7435d0\"},{\"learning_id\":1507,\"commit\":\"a3d8a4a\"}]}",
    },
  },
  {
    ids: [1821, 1884] as const,
    score: 0.128,
    label: 'DIFFERENT',
    note: "fifty_eco_system — the control the brief called a correct non-merge",
    a: {
      id: 1821,
      project_slug: "fifty_eco_system",
      entity_key: "project:fifty_eco_system",
      title:
        "fifty_eco_system has 33 open briefs but only 7 learnings in 187 days — the project consumes brief-writing effort and returns almost no knowledge, which is the strongest single argument for archiving it outright",
      evidence:
        "{\"brief_id\":\"BR-095\",\"note\":\"Project row: 33 open briefs, 7 learnings, 187 days_since_activity. The template swarms (BR-095..BR-101, UI-006..UI-013) plus AC-001/AC-007 and TD-004/TD-006/TD-007 have never produced harvested knowledge. Existing suggestion 1696 asks for triage; this adds the yield argument — briefs-per-learning is the metric that decides archive vs revive.\"}",
      suggested_action:
        "{\"kind\":\"archive_project_backlog\",\"project_slug\":\"fifty_eco_system\",\"keep_open\":[\"BR-074\",\"BR-076\"],\"reason\":\"In-Progress briefs preserved; all Ready briefs archived pending explicit revival\"}",
    },
    b: {
      id: 1884,
      project_slug: "fifty_eco_system",
      entity_key: "project:fifty_eco_system",
      title:
        "Three fifty_eco_system tech-debt briefs (TD-004, TD-006, TD-007) are 'In Progress' with 191 days of no activity — 'In Progress' has stopped meaning anything and should be reset to Ready or archived",
      evidence:
        "{\"brief_id\":\"TD-004\",\"note\":\"TD-004, TD-006, TD-007 all show status 'In Progress' at days_since_update 191, and the project's days_since_activity is 188 — nothing can be in progress. Distinct from suggestion 1696 (bulk staleness) and 1697 (lifeOS P0): this is specifically the in-progress status being false across a set, which corrupts any 'what is being worked on' query.\"}",
      suggested_action:
        "{\"kind\":\"bulk_status_reset\",\"project_slug\":\"fifty_eco_system\",\"brief_ids\":[\"TD-004\",\"TD-006\",\"TD-007\",\"BR-074\",\"BR-076\",\"TS-003\"],\"from_status\":\"In Progress\",\"to_status\":\"Ready\",\"reason\":\"no project activity for 188 days; In Progress is stale\"}",
    },
  },
] as const;

const IN_BAND = PRODUCTION_PAIRS.slice(0, 3);

describe('TD-445 production window — three misses and one control, pinned as measured', () => {
  it.each(PRODUCTION_PAIRS)('$ids scores the recorded $score', (p) => {
    // Reds if the tokeniser or a stored title drifts.
    expect(claimSimilarity(claimTokens(p.a.title), claimTokens(p.b.title))).toBeCloseTo(
      p.score,
      3,
    );
  });

  it.each(IN_BAND)('$ids shares ONE anchor — this brief, not TD-452', (p) => {
    const anchorA = entityKey(candidateFromRow(p.a));
    expect(anchorA).toBe(entityKey(candidateFromRow(p.b)));
    expect(anchorA).toBe(p.a.entity_key);
  });

  it.each(PRODUCTION_PAIRS)('$ids does not merge at the shipped threshold — $note', (p) => {
    expect(match(p.a.title, p.b.title)).toBe(false);
  });

  it('the shipped threshold sits above every production pair — move it and re-read the set', () => {
    const top = Math.max(
      ...PRODUCTION_PAIRS.map((p) => claimSimilarity(claimTokens(p.a.title), claimTokens(p.b.title))),
    );
    expect(top).toBeCloseTo(0.216, 3);
    expect(THRESHOLD).toBeGreaterThan(top);
  });
});

// ---------------------------------------------------------------------------
// TD-452 — THE ANCHOR SPLITS: the pairs the anchor ALONE keeps apart
// ---------------------------------------------------------------------------

/**
 * PROVENANCE. Twelve real rows, read on 2026-09-07 from a read-only
 * `.backup` of the operator brain (1,912 rows) — every field the stored
 * column byte-for-byte, `entity_key` as the writer stamped it. Labels are
 * TD-445's row tags (`scripts/td445_row_findings.csv`), derived per pair.
 *
 * WHAT THEY ARE. Every pair below MATCHES on the claim at the shipped
 * threshold — `claimsMatch` says SAME — and is separated ONLY by
 * `entityKey`. TD-452 measured the two anchor changes that would have made
 * them comparable (`scripts/td452_anchor_sweep.ts`; the rule, pre-registered
 * in `plans/TD-452-plan.md`: every newly comparable pair labelled, DIFFERENT
 * must be 0 at 0.25):
 *   - demote the illustrative `evidence.brief_id` when the title names no id
 *     ("a-narrow") → 9 DIFFERENT of 52 (4 on TD-445's tags, all
 *     `stalled_detector_gap` × `zero_learnings_projects`);
 *   - compare `global` with `project:*` in a second pass ("cross-block") →
 *     33 DIFFERENT of 85; its asymmetric narrowings 13 and 20.
 * So the anchor did not move, and the last pair — family 2, the ONE
 * production pair the second pass would have caught — is pinned as the cost.
 * These cases red if an anchor change lands without re-reading that labelled
 * set: the DIFFERENT pairs' anchors must stay UNEQUAL, and the claim gate must
 * still say SAME (otherwise the pin is measuring the tokeniser, not the
 * anchor). `docs/architecture/subconscious_engine.md` §"TD-452 anchor
 * re-design" carries the census and the loop-faithful reading beside it.
 */
interface PinRow {
  project_slug: string | null;
  /** The stored anchor (post-TD-457 for the moved rows; see `entity_key_pre_td457`). */
  entity_key: string;
  /**
   * TD-457 (2026-09-08): the value the 2026-09-07/08 copies STORED before the
   * anchor moved — kept for provenance on the rows the re-key moves. Absent on
   * an unmoved row.
   */
  entity_key_pre_td457?: string;
  title: string;
  evidence: string;
  suggested_action: string | null;
}

const ANCHOR_HELD_ROWS: Record<number, PinRow> = {
  // TD-458 (2026-09-08): 1271, the fourth S3 pair's project side (read 2026-09-08, verbatim).
  1271: {
    project_slug: "fifty_eco_system",
    entity_key: "project:fifty_eco_system",
    title:
      "60 of 68 open suggestions are mechanical stalled/gap rows for one dormant project — the review queue is unusable until they are batch-resolved",
    evidence:
      "{\"note\":\"Open suggestions ids 4-32 and 40-42 are 'stalled' rows and 43-69 are 'gap' rows, nearly all project_slug=fifty_eco_system. Every fifty_eco_system open brief shows days_since_update 143-163, and the project reports days_since_activity=null with 0 learnings — the briefs are abandoned, not stalled individually. Learning 1125 warns a backlog everyone calls noise deserves one measurement before it is cleared.\"}",
    suggested_action:
      "{\"kind\":\"bulk_dismiss_suggestions\",\"source_modules\":[\"stalled\",\"gap\"],\"project_slug\":\"fifty_eco_system\",\"precondition\":\"record the count and per-status breakdown first, per learning 1125\"}",
  },
  // TD-457 (2026-09-08): the ten rows of the 15 (a-narrow) SAME pairs not already
  // pinned above (read 2026-09-08 from the copy, verbatim; `entity_key` is the
  // post-TD-457 anchor, `entity_key_pre_td457` what the copy stored).
  1328: {
    project_slug: null,
    entity_key: "global",
    entity_key_pre_td457: "brief:int-001",
    title:
      "Six scratch/test projects (test-v5-verify, agy-deny-test, igris-nobrief-*, igris-agy-hunt-*) sit in the active roster with open briefs, inflating every cross-project count",
    evidence:
      "{\"brief_id\":\"INT-001\",\"note\":\"test-v5-verify is status active with open briefs INT-001 ('Integration test brief') and INT-002 ('Auto-cache test brief', priority null), 160 days old. projects[] also carries agy-deny-test, igris-nobrief-72866, igris-nobrief2-74787, igris-agy-hunt-demo and igris-agy-hunt-sandbox as active. These are test fixtures, not work; leaving them active means they will eventually generate their own stalled suggestions.\"}",
    suggested_action:
      "{\"kind\":\"archive_projects\",\"project_slugs\":[\"test-v5-verify\",\"agy-deny-test\",\"igris-nobrief-72866\",\"igris-nobrief2-74787\",\"igris-agy-hunt-demo\",\"igris-agy-hunt-sandbox\"],\"reason\":\"Test fixtures polluting the active project roster and future suggestion runs\"}",
  },
  1335: {
    project_slug: null,
    entity_key: "global",
    title:
      "At least nine throwaway test/sandbox projects (test-v5-verify, agy-deny-test, igris-nobrief-*, igris-agy-hunt-*, mbrgea-test, igris-os-eval) are registered as 'active' and contribute open briefs to the real backlog",
    evidence:
      "{\"note\":\"projects[] marks test-v5-verify (2 open briefs, 160 days idle), agy-deny-test (1), igris-nobrief-72866 (1), igris-nobrief2-74787 (1), igris-agy-hunt-demo, igris-agy-hunt-sandbox, igris-os-eval, mbrgea-test as status 'active'. open_briefs INT-001 'Integration test brief' and INT-002 'Auto-cache test brief' are self-identifying fixtures, and INT-002 has a null priority. These inflate every whole-brain count the dashboard now renders (commits aa71389, 67f6d2e).\"}",
    suggested_action:
      "{\"kind\":\"archive_projects\",\"slugs\":[\"test-v5-verify\",\"agy-deny-test\",\"igris-nobrief-72866\",\"igris-nobrief2-74787\",\"igris-agy-hunt-demo\",\"igris-agy-hunt-sandbox\",\"igris-os-eval\"],\"dry_run\":true}",
  },
  1344: {
    project_slug: null,
    entity_key: "global",
    entity_key_pre_td457: "brief:int-001",
    title:
      "Seven throwaway test/sandbox projects (test-v5-verify, agy-deny-test, igris-nobrief-*, igris-agy-hunt-*, mbrgea-test, igris-os-eval) sit in the active roster, four carrying open briefs that feed the stalled detector",
    evidence:
      "{\"brief_id\":\"INT-001\",\"note\":\"INT-001 'Integration test brief' and INT-002 'Auto-cache test brief' under test-v5-verify are open at 161 days; agy-deny-test, igris-nobrief-72866, igris-nobrief2-74787 each hold 1 open brief with no activity data. These are artifacts of test runs, not work — marking them non-active stops them consuming detector and operator attention.\"}",
    suggested_action:
      "{\"kind\":\"set_project_status\",\"project_slugs\":[\"test-v5-verify\",\"agy-deny-test\",\"igris-nobrief-72866\",\"igris-nobrief2-74787\",\"igris-agy-hunt-demo\",\"igris-agy-hunt-sandbox\",\"igris-os-eval\"],\"status\":\"archived\"}",
  },
  1440: {
    project_slug: null,
    entity_key: "global",
    entity_key_pre_td457: "brief:br-027",
    title:
      "Four hadir-family slugs (hadir, hadir-system, fya-hadir-app, moca-hadir-app) hold overlapping MOCA/Hadir UI briefs — confirm they are distinct repos or merge the brains",
    evidence:
      "{\"brief_id\":\"BR-027\",\"note\":\"hadir BR-027 'MOCA UI updates' and hadir-system BR-001 'Hadir mobile app UI design system in web admin portal' describe adjacent work under different slugs, while attendance_app BR-002/BR-003 are also 'Moca' rebrand briefs. Four active slugs plus attendance_app for one product line fragments the learning pool.\"}",
    suggested_action:
      null,
  },
  1539: {
    project_slug: null,
    entity_key: "global",
    title:
      "The stalled detector never fires on lifeOS, hadir, hadir-system or igris-ai despite briefs 114-161 days idle — its project scope looks incomplete",
    evidence:
      "{\"note\":\"open_suggestions from source_module='stalled' cover only fifty_eco_system and attendance_app (id 39). Yet the digest lists lifeOS BR-023..BR-036 at 119-120 days, hadir BR-027/BR-028 at 133-135 days, hadir-system BR-001 at 161 days, and igris-ai FR-112/FR-114/FR-115 at 114 days — all idle longer than the 48-day threshold that triggered id 39. Either those projects are excluded from the sweep or the sweep silently stopped partway; learning 1248 names this exact class: 'a check that reports success without having checked'.\"}",
    suggested_action:
      null,
  },
  1570: {
    project_slug: null,
    entity_key: "global",
    entity_key_pre_td457: "brief:br-027",
    title:
      "Four overlapping hadir project slugs (hadir, hadir-system, fya-hadir-app, moca-hadir-app) each hold open briefs — likely one product split across duplicate brain entries",
    evidence:
      "{\"brief_id\":\"BR-027\",\"note\":\"Projects list shows hadir (2 open, 116d), hadir-system (1 open, no activity), fya-hadir-app (1 open, 27d), moca-hadir-app (7 open, 26d). hadir-system's BR-001 ('Implement Hadir mobile app UI design system in web admin portal') and hadir's BR-027/BR-028 (MOCA UI updates, report card redesign) read as the same product line. Similar shape on the fifty side: fifty-dev (61 open) vs fifty_eco_system (34 open) vs animated-fifty-dev vs retro_fifty. Worth confirming which slugs are live and merging or archiving the rest before brief counts are used for any prioritisation.\"}",
    suggested_action:
      null,
  },
  1578: {
    project_slug: null,
    entity_key: "global",
    title:
      "Four near-duplicate Hadir projects (hadir, hadir-system, fya-hadir-app, moca-hadir-app) each carry open briefs — likely one product split across four brain slices",
    evidence:
      "{\"note\":\"Digest projects list: hadir (2 open, 116d), hadir-system (1 open, activity null), fya-hadir-app (1 open, 27d), moca-hadir-app (7 open, 26d). hadir-system BR-001 and hadir BR-027/BR-028 both describe MOCA UI work on the same app. Learning 1328 (moca-ai-agent): a fact spelled twice drifts, and the ritual only ever updates one spelling.\"}",
    suggested_action:
      "{\"kind\":\"propose_project_merge\",\"candidates\":[\"hadir\",\"hadir-system\",\"fya-hadir-app\",\"moca-hadir-app\"]}",
  },
  1627: {
    project_slug: null,
    entity_key: "global",
    title:
      "Learnings are concentrated in three projects while eight active projects with open briefs have recorded none — the harvest habit is not running outside the top repos",
    evidence:
      "{\"note\":\"igris-ai (575), moca-ai-agent (186) and mbrgea-ai (184) hold the large majority of learnings. attendance_app (4 open briefs), lifeOS (14 open briefs), hadir-system (1) and moca-hr-agent (1) each report learnings=0 and days_since_activity=null, despite carrying open P1 and P0 work.\"}",
    suggested_action:
      null,
  },
  1677: {
    project_slug: null,
    entity_key: "global",
    entity_key_pre_td457: "brief:br-001",
    title:
      "Overlapping Hadir project slugs (hadir, hadir-system, fya-hadir-app, moca-hadir-app) each hold open briefs — likely one product tracked under four brain identities",
    evidence:
      "{\"brief_id\":\"BR-001\",\"note\":\"projects lists hadir (2 briefs, 122d), hadir-system (1 brief, activity null), fya-hadir-app (2 briefs, 0d), moca-hadir-app (7 briefs, 32d). hadir-system BR-001 'Implement Hadir mobile app UI design system in web admin portal' and hadir BR-027 'MOCA UI updates' describe adjacent work. Recent commits 23c880f and 7ef7766 show the brain has been actively folding duplicate project rows onto one directory.\"}",
    suggested_action:
      "{\"kind\":\"review_project_identity\",\"slugs\":[\"hadir\",\"hadir-system\",\"fya-hadir-app\",\"moca-hadir-app\"]}",
  },
  1692: {
    project_slug: null,
    entity_key: "global",
    entity_key_pre_td457: "brief:br-002",
    title:
      "Four active projects carry 53 open briefs between them and zero recorded learnings — attendance_app, lifeOS, hadir-system, and moca-hr-agent are producing no institutional memory",
    evidence:
      "{\"brief_id\":\"BR-002\",\"note\":\"attendance_app (4 open briefs, 0 learnings), lifeOS (14, 0), hadir-system (1, 0), moca-hr-agent (1, 0), all days_since_activity=null. Contrast igris-ai (596 learnings) and mbrgea-ai (202). Briefs like attendance_app BR-002/BR-003/BR-004 have been In Progress 168 days with nothing captured — if that work is real, its lessons are being lost.\"}",
    suggested_action:
      "{\"kind\":\"schedule_harvest\",\"project_slugs\":[\"attendance_app\",\"lifeOS\",\"hadir-system\",\"moca-hr-agent\"]}",
  },
  1291: {
    project_slug: "lifeOS",
    entity_key: "project:lifeos",
    title:
      "lifeOS has 14 open briefs including a P0-Critical a11y regression but zero learnings and no recorded activity — work is being briefed but nothing is being harvested",
    evidence:
      "{\"brief_id\":\"BR-023\",\"note\":\"lifeOS: open_briefs 14, learnings 0, days_since_activity null. BR-023 is P0-Critical, In Progress, 105 days since update. Same zero-learning profile applies to attendance_app (4 briefs) and fifty_eco_system (34 briefs).\"}",
    suggested_action:
      null,
  },
  1341: {
    project_slug: "fifty_eco_system",
    entity_key: "project:fifty_eco_system",
    title:
      "58 of 61 open suggestions are mechanical 'stalled'/'gap' rows for one project — the review queue is saturated and will bury any genuinely novel finding",
    evidence:
      "{\"note\":\"open_suggestions ids 4–32 and 40–42 are 'stalled' rows and 43–69 are 'gap' rows, nearly all project_slug=fifty_eco_system. Every one of those briefs shows days_since_update=169 or 148 — the same freeze, re-reported per brief. One rolled-up suggestion per (project, module) would carry the same information at 1/30th the review cost.\"}",
    suggested_action:
      "{\"kind\":\"collapse_suggestions\",\"source_modules\":[\"stalled\",\"gap\"],\"group_by\":[\"project_slug\",\"source_module\"]}",
  },
  1355: {
    project_slug: "fifty_eco_system",
    entity_key: "project:fifty_eco_system",
    title:
      "60 of the 60 open suggestions are mechanical stalled/gap rows on fifty_eco_system — the review queue is saturated and will hide any real finding",
    evidence:
      "{\"note\":\"open_suggestions ids 4–42 are 'stalled' rows and 43–69 are 'marked Done but has unchecked acceptance criteria' rows, nearly all project_slug fifty_eco_system. This is one decision (what to do with the dormant fifty_eco_system backlog), fragmented into 60 items. Recommend a single bulk disposition rather than per-brief triage.\"}",
    suggested_action:
      null,
  },
  1430: {
    project_slug: null,
    entity_key: "global",
    title:
      "Four active projects with open briefs have recorded zero learnings — attendance_app (4 briefs), lifeOS (14), hadir-system (1), moca-hr-agent (1) — so nothing from that work is reaching the brain",
    evidence:
      "{\"note\":\"projects[] shows learnings=0 and days_since_activity=null for attendance_app, lifeOS, hadir-system, moca-hr-agent, customerpulse and igris-os-eval. lifeOS in particular carries 14 open briefs including a P0-Critical (BR-023) — either work happens outside the harness or the activity/learning pipeline is not wired for these projects.\"}",
    suggested_action:
      "{\"kind\":\"investigate_project_wiring\",\"project_slugs\":[\"lifeOS\",\"attendance_app\",\"hadir-system\",\"moca-hr-agent\"]}",
  },
  1434: {
    project_slug: null,
    entity_key: "global", // TD-457 (2026-09-08): moved from the value below
    entity_key_pre_td457: "brief:br-001",
    title:
      "The stalled detector appears to miss projects with null days_since_activity — attendance_app, lifeOS, hadir-system and hadir briefs idle 118–159 days produce no suggestions",
    evidence:
      "{\"brief_id\":\"BR-001\",\"note\":\"hadir-system BR-001 (In Progress, 159 days), hadir BR-027/BR-028 (In Progress, 131–133 days) and lifeOS BR-024..BR-036 (118 days) are all older than the fifty_eco_system briefs that did fire at 48 days, yet none appear in open_suggestions. attendance_app BR-001 fired but its three In Progress siblings did not.\"}",
    suggested_action:
      null,
  },
  1474: {
    project_slug: null,
    entity_key: "global", // TD-457 (2026-09-08): moved from the value below
    entity_key_pre_td457: "brief:br-001",
    title:
      "The stalled-brief detector appears scoped to two projects — hadir, hadir-system, igris-ai and lifeOS all have 110+ day stale briefs with no corresponding suggestion",
    evidence:
      "{\"brief_id\":\"BR-001\",\"note\":\"hadir-system BR-001 (160 days), hadir BR-027 (134 days), igris-ai FR-112/FR-114/FR-115 (113 days) all exceed the ~48-day threshold that produced suggestions 39-42 for attendance_app/fifty_eco_system, yet none of these projects appear in open_suggestions at all.\"}",
    suggested_action:
      "{\"kind\":\"audit_module\",\"module\":\"stalled\",\"note\":\"verify project enumeration and threshold application across all active projects\"}",
  },
  1486: {
    project_slug: null,
    entity_key: "global",
    title:
      "Four active projects with open briefs (lifeOS 14, attendance_app 4, hadir-system 1, moca-hr-agent 1) have zero learnings and null activity — work there is not reaching the brain",
    evidence:
      "{\"note\":\"projects rows: lifeOS (14 open briefs, 0 learnings, null activity), attendance_app (4/0/null), hadir-system (1/0/null), moca-hr-agent (1/0/null). Meanwhile briefs in lifeOS and attendance_app carry recent-ish update timestamps (118-156 days), so briefs are being written for these projects but no session activity or learning is being captured — the instrumentation, not the work, is likely missing.\"}",
    suggested_action:
      "{\"kind\":\"investigate_instrumentation\",\"project_slugs\":[\"lifeOS\",\"attendance_app\",\"hadir-system\",\"moca-hr-agent\"]}",
  },
  1495: {
    project_slug: "lifeOS",
    entity_key: "project:lifeos",
    title:
      "lifeOS has 14 open briefs including a P0 accessibility regression but zero learnings and no recorded activity — the brain is capturing nothing from this project",
    evidence:
      "{\"brief_id\":\"BR-023\",\"note\":\"Project row shows learnings=0 and days_since_activity=null while 14 briefs (BR-023 P0-Critical, plus BR-024..BR-036) sit Ready/In Progress at 118-119 days. Same shape for attendance_app, hadir-system, moca-hr-agent — likely briefs imported without a working session attached.\"}",
    suggested_action:
      null,
  },
  1596: {
    project_slug: null,
    entity_key: "global", // TD-457 (2026-09-08): moved from the value below
    entity_key_pre_td457: "brief:br-024",
    title:
      "Four active projects with open briefs (lifeOS 14, attendance_app 4, hadir-system 1, moca-hr-agent 1) have zero learnings and null activity — work is either happening outside the brain or these are dead entries",
    evidence:
      "{\"brief_id\":\"BR-024\",\"note\":\"Project rows show learnings 0 and days_since_activity null for lifeOS, attendance_app, hadir-system, moca-hr-agent, while lifeOS carries 14 open briefs (e.g. BR-024). Learning 1366 documents a related failure mode: perception runs advancing watermarks for tables they never push.\"}",
    suggested_action:
      null,
  },
  1698: {
    project_slug: null,
    entity_key: "global",
    title:
      "Four projects with open briefs (lifeOS 14, attendance_app 4, hadir-system 1, moca-hr-agent 1) have zero learnings and null activity — work is being briefed but never executed or never harvested",
    evidence:
      "{\"note\":\"Project rows: lifeOS (14 open_briefs, 0 learnings, days_since_activity null), attendance_app (4, 0, null), hadir-system (1, 0, null), moca-hr-agent (1, 0, null). 20 open briefs total behind projects the brain has never observed activity on. Contrast with igris-ai/mbrgea-ai/moca-ai-agent, all at days_since_activity 0. Either these projects are worked outside the brain's view (an instrumentation gap) or the briefs are dead inventory.\"}",
    suggested_action:
      null,
  },
  1801: {
    project_slug: null,
    entity_key: "global",
    title:
      "44 of the 60 open suggestions are low-value edge_inference rows — the operator's review queue is 73% noise, which will bury the 16 substantive findings",
    evidence:
      "{\"note\":\"open_suggestions ids 1712–1755 are all source_module='edge_inference', each proposing a single learning→learning edge (e.g. 'Inferred related_to edge: learning 224 → learning 227'). These are mechanical graph links, not operator decisions. They should be auto-applied below a confidence threshold, batched into one review item, or routed to a separate queue — not interleaved with findings like 1697 (the only P0 brief stalled 130 days).\"}",
    suggested_action:
      "{\"kind\":\"reroute_suggestion_module\",\"source_module\":\"edge_inference\",\"note\":\"Auto-apply or batch edge_inference proposals; keep the review queue for judgement calls.\"}",
  },
  // TD-458 (2026-09-08): four more real rows from the same-block `global`
  // set the MODULE gate touches, read 2026-09-08 from a read-only `.backup`
  // copy (1,918 rows), every column verbatim. 1326/1815 and 1326/1809 are
  // same-block DIFFERENT pairs the tokeniser merged at HEAD (0.250, 0.258);
  // 1326/1384 (0.300, {gap,stalled} vs {gap}) and 1809/1815 (0.323) are the
  // SAME controls the gate must leave alone.
  1326: {
    project_slug: null,
    entity_key: "global",
    title:
      "62 of 66 open suggestions are single-project fifty_eco_system stalled/gap notices — the queue is drowning higher-value findings and should be collapsed per-project",
    evidence:
      "{\"note\":\"open_suggestions holds 66 entries: ids 4-32 and 40-42 are 'stalled' notices all for fifty_eco_system, and ids 43-69 are 27 'gap' notices all of the identical form '<brief> marked Done but has unchecked acceptance criteria' for the same project. One brief-per-suggestion fan-out on a project whose briefs share a single freeze date (167/147 days) produces near-zero marginal signal per row and buries anything from lifeOS, igris-ai, or mbrgea-ai. Recommend the stalled/gap modules emit one rolled-up suggestion per project per module.\"}",
    suggested_action:
      "{\"kind\":\"collapse_suggestions\",\"source_modules\":[\"stalled\",\"gap\"],\"project_slug\":\"fifty_eco_system\",\"reason\":\"Roll per-brief notices into one per-project summary; unblocks the review queue\"}",
  },
  1384: {
    project_slug: null,
    entity_key: "global",
    title:
      "66 of 69 queued suggestions are single-project fifty_eco_system stall/gap alerts — the review queue is saturated by one dormant project and will bury anything new",
    evidence:
      "{\"note\":\"open_suggestions ids 4–32 and 40–42 are 'stalled' alerts, ids 43–69 are 'Done but unchecked acceptance criteria' gap alerts; all but id 39 (attendance_app) target fifty_eco_system. The 27 gap alerts share one root cause — Done briefs whose criteria were never ticked — and would be better handled as one policy decision than 27 reviews.\"}",
    suggested_action:
      "{\"kind\":\"collapse_suggestions\",\"source_modules\":[\"stalled\",\"gap\"],\"project_slug\":\"fifty_eco_system\",\"proposal\":\"group_into_single_rollup_per_module\"}",
  },
  1809: {
    project_slug: null,
    entity_key: "global",
    title:
      "44 of the 60 queued suggestions are auto-generated single-edge inferences — the edge_inference module is drowning the review queue and should batch or auto-apply below a threshold",
    evidence:
      "{\"note\":\"Suggestion ids 1712-1755 are all source_module='edge_inference', each proposing one learning→learning edge (e.g. 1730 'learning 7 → learning 6', 1755 'learning 425 → learning 424'). They outnumber the 16 substantive findings (1696-1711) nearly 3:1, and most concern learnings in the low id range (6-425) that are not in the recent set — meaning the operator must page through 44 mechanical rows to reach any judgement-requiring item. This is a queue-design defect, not a knowledge finding.\"}",
    suggested_action:
      "{\"kind\":\"change_suggestion_module_policy\",\"source_module\":\"edge_inference\",\"policy\":\"batch_into_single_suggestion\",\"note\":\"Collapse per-edge rows into one reviewable batch per run, or auto-apply above a confidence threshold and surface only exceptions.\"}",
  },
  1815: {
    project_slug: null,
    entity_key: "global",
    title:
      "44 of the 60 open suggestions are auto-generated edge_inference rows (ids 1712-1755) — they drown the 16 substantive findings and should be batch-applied or routed out of the operator queue",
    evidence:
      "{\"note\":\"open_suggestions contains ids 1712 through 1755, all source_module=edge_inference, each proposing a single derived_from/related_to/supersedes link between two learnings. They are mechanical, individually low-stakes, and outnumber every other finding 3:1. Reviewing graph edges one at a time is the wrong granularity — they belong in a bulk-accept view or an auto-apply path with a confidence floor, not in the same queue as 'the only P0 brief has been stalled 130 days'.\"}",
    suggested_action:
      "{\"kind\":\"route_suggestion_class\",\"source_module\":\"edge_inference\",\"destination\":\"bulk_review_queue\",\"note\":\"Auto-apply above a confidence threshold; keep the operator queue for judgment calls\"}",
  },
  1888: {
    project_slug: "igris-ai",
    entity_key: "project:igris-ai",
    title:
      "44 of 60 open suggestions are low-value edge_inference rows — they crowd out substantive findings in the review queue and should be batched or auto-applied rather than queued individually",
    evidence:
      "{\"note\":\"open_suggestions ids 1712–1755 are all source_module=edge_inference, each proposing a single learning→learning edge. They occupy 73% of the operator's queue while carrying no decision content. Commit 6d077a1 ('fix(subconscious): dedup findings on a key stable under LLM paraphrase') shows queue quality is already a known concern; edge inference is the remaining volume source.\"}",
    suggested_action:
      "{\"kind\":\"change_suggestion_routing\",\"source_module\":\"edge_inference\",\"from\":\"individual_queued_suggestion\",\"to\":\"batched_review_or_auto_apply_above_threshold\"}",
  },
};

const ANCHOR_HELD_PAIRS = [
  {
    ids: [1434, 1486] as const,
    score: 0.303,
    label: 'DIFFERENT',
    design: 'a-narrow',
    note: "stalled_detector_gap × zero_learnings_projects — the highest DIFFERENT pair (on TD-445's tags) that demoting the evidence brief admits",
  },
  {
    ids: [1434, 1596] as const,
    score: 0.27,
    label: 'DIFFERENT',
    design: 'a-narrow',
    note: "stalled_detector_gap × zero_learnings_projects",
  },
  {
    ids: [1434, 1698] as const,
    score: 0.265,
    label: 'DIFFERENT',
    design: 'a-narrow',
    note: "stalled_detector_gap × zero_learnings_projects",
  },
  {
    ids: [1474, 1486] as const,
    score: 0.25,
    label: 'DIFFERENT',
    design: 'a-narrow',
    note: "stalled_detector_gap × zero_learnings_projects — exactly on the line",
  },
  {
    ids: [1291, 1698] as const,
    score: 0.387,
    label: 'DIFFERENT',
    design: 'cross-block',
    note: "lifeos_dark × zero_learnings_projects — the highest DIFFERENT pair that comparing global with project:* admits",
  },
  {
    ids: [1341, 1801] as const,
    score: 0.31,
    label: 'DIFFERENT',
    design: 'cross-block',
    note: "queue_flood_stalled_gap × edge_inference_flood — two different floods",
  },
  {
    ids: [1430, 1495] as const,
    score: 0.303,
    label: 'DIFFERENT',
    design: 'cross-block',
    note: "zero_learnings_projects × lifeos_dark",
  },
  {
    ids: [1355, 1801] as const,
    score: 0.296,
    label: 'DIFFERENT',
    design: 'cross-block',
    note: "queue_flood_stalled_gap × edge_inference_flood",
  },
  {
    ids: [1801, 1888] as const,
    score: 0.414,
    label: 'SAME',
    design: 'cross-block',
    note: "family 2 — the cost of the decision: the one SAME production pair the anchor also keeps apart",
  },
] as const;

describe('TD-452 anchor splits — the claim gate says SAME, the anchor says no (measured, not moved)', () => {
  const pinRow = (id: number): PinRow => {
    const row = ANCHOR_HELD_ROWS[id];
    expect(row, `no pinned row ${id}`).toBeDefined();
    return row!;
  };

  it.each(ANCHOR_HELD_PAIRS)('$ids scores the recorded $score', (p) => {
    expect(
      claimSimilarity(claimTokens(pinRow(p.ids[0]).title), claimTokens(pinRow(p.ids[1]).title)),
    ).toBeCloseTo(p.score, 3);
  });

  /**
   * TD-458 (2026-09-08) MOVED this pin for the two S3 pairs. Before: every
   * pair MATCHED on `claimsMatch`. Now `claimsMatch` carries the module-name
   * gate, so 1341/1801 and 1355/1801 ({gap,stalled} vs {edge_inference}) are
   * refused by the CLAIM as well as the anchor. The arming half is therefore
   * the TOKENISER (score ≥ threshold — the pair would merge on prose alone);
   * the other seven pairs still match on the full claim, asserted as before.
   */
  const S3_MODULE_GATED = new Set(['1341/1801', '1355/1801']);
  it.each(ANCHOR_HELD_PAIRS)('$ids MATCHES on the tokeniser at the shipped threshold — $note', (p) => {
    // The arming half: a pair the tokeniser refuses would pass the anchor
    // assertion below for the wrong reason.
    const a = pinRow(p.ids[0]).title;
    const b = pinRow(p.ids[1]).title;
    expect(claimSimilarity(claimTokens(a), claimTokens(b))).toBeGreaterThanOrEqual(THRESHOLD);
    if (S3_MODULE_GATED.has(p.ids.join('/'))) {
      // TD-458: the module gate now separates these two on the claim too.
      expect(match(a, b)).toBe(false);
    } else {
      expect(match(a, b)).toBe(true);
    }
  });

  /**
   * TD-457 (2026-09-08) MOVED the a-narrow arm of this pin. Before: every pair
   * was kept apart by the anchor alone. Now the four a-narrow pairs SHARE an
   * anchor (`global`) — and what keeps them apart is the TD-454 project-set
   * gate (all four are S1: `td454_pairs_separated.csv`). The cross-block arm
   * is unchanged: `global` × `project:` blocks are never compared.
   */
  it.each(ANCHOR_HELD_PAIRS)('$ids: the anchor ($design) — a-narrow pairs now share one, the gate separates them; cross-block pairs still split', (p) => {
    const a = pinRow(p.ids[0]);
    const b = pinRow(p.ids[1]);
    const anchorA = entityKey(candidateFromRow(a));
    const anchorB = entityKey(candidateFromRow(b));
    // The stored column IS the shipped anchor — reds if the writer drifts.
    expect(anchorA).toBe(a.entity_key);
    expect(anchorB).toBe(b.entity_key);
    if (p.design === 'a-narrow') {
      expect(anchorA).toBe(anchorB);
      expect(anchorA).toBe(GLOBAL_ENTITY_KEY);
      // The tokeniser still says SAME (the arming half, unchanged) …
      expect(claimSimilarity(claimTokens(a.title), claimTokens(b.title))).toBeGreaterThanOrEqual(THRESHOLD);
      // … and the production vocabulary's project-set gate is what refuses.
      const vocab = loadProjectVocabulary(vocabDb(PRODUCTION_SLUGS_2026_09_07));
      expect(claimsMatch(claimOf(a.title, vocab), claimOf(b.title, vocab), THRESHOLD, MIN_TOKENS)).toBe(false);
    } else {
      expect(anchorA).not.toBe(anchorB);
    }
  });

  it("TD-457: the a-narrow rows' PRE-TD-457 anchor was `brief:` with no id in the title; entityKey now reads global", () => {
    for (const p of ANCHOR_HELD_PAIRS.filter((x) => x.design === 'a-narrow')) {
      const moved = [pinRow(p.ids[0]), pinRow(p.ids[1])].find((r) => r.entity_key_pre_td457 !== undefined);
      expect(moved, `${p.ids.join('/')} has no moved side`).toBeDefined();
      expect(moved!.entity_key_pre_td457).toMatch(/^brief:/);
      expect(subjectIds(moved!.title).size).toBe(0);
      expect(entityKey(candidateFromRow(moved!))).toBe(GLOBAL_ENTITY_KEY);
    }
  });

  it('the cross-block pairs are global × project:, the shape the second pass would compare', () => {
    for (const p of ANCHOR_HELD_PAIRS.filter((x) => x.design === 'cross-block')) {
      const classes = [pinRow(p.ids[0]), pinRow(p.ids[1])]
        .map((r) => r.entity_key.split(':')[0])
        .sort();
      expect(classes).toEqual(['global', 'project']);
    }
  });

  it('both arms are present — the gate cannot pass on one label alone', () => {
    const labels = new Set(ANCHOR_HELD_PAIRS.map((p) => p.label));
    expect(labels).toEqual(new Set(['DIFFERENT', 'SAME']));
    expect(ANCHOR_HELD_PAIRS.filter((p) => p.label === 'DIFFERENT').length).toBeGreaterThanOrEqual(8);
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

  it('TD-457: re-keys every row after v6 clears them, inside ONE transaction — a thrown update leaves no partial re-key', () => {
    const db = migrated();
    try {
      const ins = db.prepare(
        `INSERT INTO suggestions (id, source_module, project_slug, title, evidence, priority, status)
         VALUES (?, 'k', ?, ?, '{}', 'low', 'pending')`,
      );
      for (let i = 1; i <= 6; i++) ins.run(i, `p${i}`, `finding number ${i} with several words in it`);
      db.prepare(`UPDATE suggestions SET dedupe_key = NULL, entity_key = NULL`).run();
      // Inject a failure on the FOURTH row the loop reaches.
      db.exec(`CREATE TRIGGER fail_on_4 BEFORE UPDATE ON suggestions WHEN NEW.id = 4
               BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
      expect(() => backfillFindingKeys(db)).toThrow(/injected/);
      const keyed = (db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE dedupe_key IS NOT NULL`).get() as { n: number }).n;
      // Without the transaction rows 1-3 would be keyed and 4-6 not: a queue
      // half re-keyed under the new anchor and half under none.
      expect(keyed).toBe(0);
      db.exec(`DROP TRIGGER fail_on_4`);
      expect(backfillFindingKeys(db)).toBe(6);
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

// ---------------------------------------------------------------------------
// TD-454 — the PROJECT-SET GATE (a discriminator, not an anchor change)
// ---------------------------------------------------------------------------

/**
 * TD-452's DIFFERENT class was recorded as "one shape: the same list of
 * project names". Re-reading `ANCHOR_HELD_PAIRS` gives THREE shapes, and the
 * gate below can touch two of them:
 *   S1 — overlapping-but-unequal project lists, different claims;
 *   S2 — a project-subset instance against its portfolio class;
 *   S3 — two different QUEUE FLOODS naming no project at all (nothing built
 *        from project names can separate these; they are the recorded residual).
 *
 * THE GATE. `claimOf(title, vocab)` names the registered projects a title
 * mentions (slug token sequences matched over the UNFILTERED normalized
 * tokens, longest-first, contiguous); `claimsMatch` refuses two claims whose
 * project sets are both non-empty and NOT EQUAL. Equality, not disjointness:
 * the labelling rule already says a project-subset instance of a portfolio
 * class is its own finding. `findingKey` hashes tokens + subject ONLY, so the
 * stored key is unchanged and no row was re-keyed.
 *
 * VOCABULARY. `PRODUCTION_SLUGS_2026_09_07` is the live `projects.slug` column,
 * read once with `sqlite3 -readonly` on 2026-09-07 (35 rows, verbatim, case
 * included) — it carries the prose-word slugs (`content`, `hadir`,
 * `award-winning`) and the case/spelling twins that make the gate's recall
 * cost real, so the corpus pins below run against the real risk, not a
 * flattering fixture.
 */
const PRODUCTION_SLUGS_2026_09_07 = [
  'CustomerPulse-Android', 'animated-fifty-dev', 'animated-fifty.dev', 'attendance_app',
  'award-winning', 'brand_os', 'coffee_brand_website', 'content', 'customerpulse',
  'customerpulse-android', 'customerpulse-flutter', 'customerpulse_flutter', 'fifty-agent-sdk',
  'fifty-content-pipeline', 'fifty-dev', 'fifty-store', 'fifty_dev', 'fifty_eco_system',
  'fya-hadir-app', 'gemini-gdc-auth-proxy', 'hadir', 'hadir-system', 'hero-lab', 'igris-ai',
  'igris-os-eval', 'lifeOS', 'luna-bakery-website', 'mbrgea-ai', 'mbrgea-test',
  'moca-agent-flutter-client', 'moca-ai-agent', 'moca-app', 'moca-hadir-app', 'moca-hr-agent',
  'retro_fifty',
];

function vocabDb(slugs: readonly string[]): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE projects (slug TEXT PRIMARY KEY, name TEXT, path TEXT)`);
  const ins = db.prepare(`INSERT INTO projects (slug, name, path) VALUES (?, ?, ?)`);
  for (const s of slugs) ins.run(s, s, `/p/${s}`);
  return db;
}

const S1_PAIRS = [[1434, 1486], [1434, 1596], [1434, 1698], [1474, 1486]] as const;
const S2_PAIRS = [[1291, 1698], [1430, 1495]] as const;
const S3_PAIRS = [[1341, 1801], [1355, 1801]] as const;
const EQUAL_LIST_SAME_PAIRS = [[1430, 1486], [1486, 1596], [1486, 1698], [1596, 1698]] as const;

describe('TD-454 project-set gate', () => {
  const db = vocabDb(PRODUCTION_SLUGS_2026_09_07);
  let vocab: ReadonlyMap<string, string[]>;
  beforeAll(() => {
    vocab = loadProjectVocabulary(db);
  });
  afterAll(() => {
    db.close();
  });
  const title = (id: number): string => {
    const row = ANCHOR_HELD_ROWS[id];
    expect(row, `no pinned row ${id}`).toBeDefined();
    return row!.title;
  };
  const matchWith = (a: number, b: number): boolean =>
    claimsMatch(claimOf(title(a), vocab), claimOf(title(b), vocab), THRESHOLD, MIN_TOKENS);

  it('the vocabulary loader maps every live slug to its token sequence (fail-soft on a missing table)', () => {
    expect(vocab.size).toBe(PRODUCTION_SLUGS_2026_09_07.length);
    expect(vocab.get('hadir-system')).toEqual(['hadir', 'system']);
    expect(vocab.get('attendance_app')).toEqual(['attendance_app']); // `_` is not punctuation
    expect(vocab.get('lifeOS')).toEqual(['lifeos']);
    expect(vocab.get('moca-hr-agent')).toEqual(['moca', 'hr', 'agent']);
    expect(vocab.get('animated-fifty.dev')).toEqual(['animated', 'fifty', 'dev']);
    const bare = new Database(':memory:');
    try {
      expect(loadProjectVocabulary(bare).size).toBe(0);
    } finally {
      bare.close();
    }
  });

  it('every pinned pair still MATCHES on the tokeniser alone (the arming half — vocab-free)', () => {
    for (const [a, b] of [...S1_PAIRS, ...S2_PAIRS]) expect(match(title(a), title(b))).toBe(true);
    // TD-458 (2026-09-08) MOVED the S3 half: `claimsMatch` now carries the
    // module gate, so the vocab-free arming assertion for S3 is the SCORE.
    for (const [a, b] of S3_PAIRS) {
      expect(claimSimilarity(claimTokens(title(a)), claimTokens(title(b)))).toBeGreaterThanOrEqual(THRESHOLD);
    }
  });

  it.each([...S1_PAIRS, ...S2_PAIRS])('(a) S1/S2 pair %d/%d no longer matches with the vocabulary — unequal project sets', (a, b) => {
    const pa = claimOf(title(a), vocab).projects;
    const pb = claimOf(title(b), vocab).projects;
    expect(pa.size).toBeGreaterThan(0);
    expect(pb.size).toBeGreaterThan(0);
    expect([...pa].sort()).not.toEqual([...pb].sort());
    expect(matchWith(a, b)).toBe(false);
  });

  it.each(EQUAL_LIST_SAME_PAIRS)('(b) equal-list SAME pair %d/%d still matches with the vocabulary (recall pin)', (a, b) => {
    expect([...claimOf(title(a), vocab).projects].sort()).toEqual([...claimOf(title(b), vocab).projects].sort());
    expect(matchWith(a, b)).toBe(true);
  });

  it.each(S3_PAIRS)('(c) S3 flood pair %d/%d is untouched by the PROJECT-set gate (no project set on the global side) — and separated by the MODULE gate (TD-458, 2026-09-08)', (a, b) => {
    // TD-458 MOVED this pin (was: `matchWith(a, b) === true`, the recorded
    // residual). The project-set gate still cannot see the pair; the
    // module-name gate can, and the S3 residual is closed.
    expect(claimOf(title(b), vocab).projects.size).toBe(0);
    expect(matchWith(a, b)).toBe(false);
  });

  it('(c) family 2 (1801/1888) is unchanged — neither title names a project', () => {
    expect(claimOf(title(1801), vocab).projects.size).toBe(0);
    expect(claimOf(title(1888), vocab).projects.size).toBe(0);
    expect(matchWith(1801, 1888)).toBe(true);
  });

  it('(d) namedProjects: nested slug not double-counted, underscore slug, mixed case, a 2-char inner token, empty vocab', () => {
    // 1434 names attendance_app, lifeOS, hadir-system AND hadir (a separate project).
    expect([...namedProjects(title(1434), vocab)].sort()).toEqual(['attendance_app', 'hadir', 'hadir-system', 'lifeos']);
    // `hadir` inside `hadir-system` is ONE project, not two.
    expect([...namedProjects('hadir-system BR-001 has been In Progress 159 days', vocab)]).toEqual(['hadir-system']);
    // The 2-char inner token `hr` survives because matching runs on the UNFILTERED tokens.
    expect(namedProjects(title(1430), vocab).has('moca-hr-agent')).toBe(true);
    // Mixed case in the title and in the slug both fold.
    expect([...namedProjects('LifeOS and Attendance_App carry stale briefs', vocab)].sort()).toEqual(['attendance_app', 'lifeos']);
    // Empty vocabulary => empty set; no vocabulary at claimOf => empty set (backward compatible).
    expect(namedProjects(title(1434), new Map()).size).toBe(0);
    expect(claimOf(title(1434)).projects.size).toBe(0);
  });

  it('(d) a slug that is also a prose word is a project name to the gate — the R-9 cost is real and measured, not hidden', () => {
    expect(namedProjects('the content pipeline is stalled', vocab).has('content')).toBe(true);
  });

  it('the STORED key is unchanged by the vocabulary — no re-key (findingKey hashes tokens + subject only)', () => {
    for (const id of Object.keys(ANCHOR_HELD_ROWS).map(Number)) {
      const row = ANCHOR_HELD_ROWS[id]!;
      const c = candidateFromRow(row);
      expect(findingKey(c)).toBe(findingKey(c)); // deterministic
      // The key cannot see the projects set: the claim with and without vocab differ only there.
      const withV = claimOf(row.title, vocab);
      const without = claimOf(row.title);
      expect([...withV.tokens].sort()).toEqual([...without.tokens].sort());
      expect([...withV.subject].sort()).toEqual([...without.subject].sort());
    }
  });

  it('(e) the labelled boundary corpus with the production vocabulary: DIFFERENT max stays 0.192 and every SAME group collapse is the pinned one', () => {
    const diff = acrossPairs();
    for (const [, a, b] of diff) {
      expect(claimsMatch(claimOf(a, vocab), claimOf(b, vocab), THRESHOLD, MIN_TOKENS)).toBe(false);
    }
    const collapse = (titles: string[]): number => {
      const anchors: Array<ReturnType<typeof claimOf>> = [];
      for (const t of titles) {
        const c = claimOf(t, vocab);
        if (!anchors.some((anchor) => claimsMatch(c, anchor, THRESHOLD, MIN_TOKENS))) anchors.push(c);
      }
      return anchors.length;
    };
    const expected: Record<string, number> = {
      'project:fifty_eco_system/abandoned': 1,
      'project:fifty_eco_system/duplicate_slug': 1,
      'project:fifty_eco_system/unchecked_ac': 2,
      'project:fifty_eco_system/queue_flood': 1,
      'project:lifeOS/p0_unattended': 1,
      'project:lifeOS/batch_sweep': 1,
      'project:lifeOS/harvest_gap': 1,
    };
    for (const [block, gs] of Object.entries(CORPUS)) {
      for (const [name, titles] of Object.entries(gs)) {
        const label = `${block}/${name}`;
        expect(collapse(titles), label).toBe(expected[label]);
      }
    }
  });

  it('(e) the TD-445 production window keeps its scores and verdicts under the vocabulary (a gate cannot change a score)', () => {
    for (const p of PRODUCTION_PAIRS) {
      expect(claimSimilarity(claimOf(p.a.title, vocab).tokens, claimOf(p.b.title, vocab).tokens)).toBeCloseTo(p.score, 3);
      expect(claimsMatch(claimOf(p.a.title, vocab), claimOf(p.b.title, vocab), THRESHOLD, MIN_TOKENS)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// TD-458 — the MODULE-NAME gate (gate 1c): the S3 residual, closed
// ---------------------------------------------------------------------------

/**
 * TD-454 left one residual: two different queue FLOODS naming no project (S3).
 * The discriminating fact the titles carry and the tokeniser cannot weigh is
 * the MODULE they are about — `stalled`/`gap` vs `edge_inference`. Not the
 * row's own `source_module` column: on `type_inferred = 1` rows that label is
 * re-authored every run (1801 = `suggestion_channel_flooded`, 1888 =
 * `self_referential_finding_risk`, the SAME pair), and AC-4 above pins it out
 * of the key. The vocabulary is a property of the CODE — the v1 CHECK set,
 * the synapse writer's literal and the four internal modules — and the guard
 * below re-derives it from the source so a tenth writer cannot ship unnamed.
 *
 * PRE-REGISTERED RULE, measured 2026-09-08 on the 1,918-row copy
 * (`scripts/td452_anchor_sweep.ts --source-module-gate`; record
 * `scripts/td458_s3_pairs.csv`): P-A all four S3 pairs separated — 4/4;
 * P-B 0 labelled SAME pairs broken in P_new of every design and inside the
 * shipped blocks on C1/C2 — 0; P-C ≥ 1 labelled DIFFERENT pair separated
 * INSIDE a shipped block — 3 (1326/1809 @ 0.258, 1326/1815 @ 0.250,
 * 1384/1809 @ 0.250, all `global`). Ship rule met; the DISJOINT reading is
 * what ships (one empty side is not disjoint; "stalled/gap" vs "stalled"
 * shares a member). `findingKey` hashes tokens + subject only — no re-key.
 */
describe('TD-458 module-name gate (gate 1c)', () => {
  const db = vocabDb(PRODUCTION_SLUGS_2026_09_07);
  let vocab: ReadonlyMap<string, string[]>;
  beforeAll(() => {
    vocab = loadProjectVocabulary(db);
  });
  afterAll(() => {
    db.close();
  });
  const title = (id: number): string => {
    const row = ANCHOR_HELD_ROWS[id];
    expect(row, `no pinned row ${id}`).toBeDefined();
    return row!.title;
  };
  const score = (a: number, b: number): number =>
    claimSimilarity(claimTokens(title(a)), claimTokens(title(b)));
  const matchWith = (a: number, b: number): boolean =>
    claimsMatch(claimOf(title(a), vocab), claimOf(title(b), vocab), THRESHOLD, MIN_TOKENS);
  const mods = (id: number): string[] => [...namedModules(title(id))].sort();

  const S3_ALL = [[1341, 1801], [1355, 1801], [1326, 1888], [1271, 1815]] as const;

  it.each(S3_ALL)('(P-A) S3 pair %d/%d: {gap,stalled} vs {edge_inference}, disjoint — refused with AND without the project vocabulary', (a, b) => {
    // Arming: the tokeniser alone would merge them.
    expect(score(a, b)).toBeGreaterThanOrEqual(THRESHOLD);
    expect(mods(a)).toEqual(['gap', 'stalled']);
    expect(mods(b)).toEqual(['edge_inference']);
    expect(matchWith(a, b)).toBe(false);
    expect(match(title(a), title(b))).toBe(false);
  });

  it('(P-C) the live same-block pair 1326/1815 (global, 0.250, DIFFERENT) is refused — the false merge at HEAD', () => {
    expect(score(1326, 1815)).toBeCloseTo(0.25, 3);
    expect(ANCHOR_HELD_ROWS[1326]!.entity_key).toBe(ANCHOR_HELD_ROWS[1815]!.entity_key);
    expect(matchWith(1326, 1815)).toBe(false);
    // ...and 1326/1809 @ 0.258, the second of the three same-block separations.
    expect(score(1326, 1809)).toBeCloseTo(0.258, 3);
    expect(matchWith(1326, 1809)).toBe(false);
  });

  it('(P-B) SAME controls still match: 1809/1815 (both {edge_inference}) and 1326/1384 ({gap,stalled} vs {gap} — shares a member, NOT disjoint)', () => {
    expect(score(1809, 1815)).toBeCloseTo(0.323, 3);
    expect(mods(1809)).toEqual(['edge_inference']);
    expect(matchWith(1809, 1815)).toBe(true);
    expect(score(1326, 1384)).toBeCloseTo(0.3, 3);
    expect(mods(1384)).toEqual(['gap']);
    expect(matchWith(1326, 1384)).toBe(true);
  });

  it('DISJOINT, not EQUAL: the designed pair "stalled/gap rows" vs "stalled rows" shares a member and still matches', () => {
    const a = '58 of 61 open suggestions are mechanical stalled/gap rows';
    const b = '58 of 61 open suggestions are mechanical stalled rows';
    expect([...namedModules(a)].sort()).toEqual(['gap', 'stalled']);
    expect([...namedModules(b)]).toEqual(['stalled']);
    expect(match(a, b)).toBe(true);
  });

  it('one empty side is NOT disjoint — a re-emission that drops the module word still merges', () => {
    const a = 'the queue holds 40 stalled rows for one dormant project';
    const b = 'the queue holds 40 rows for one dormant project';
    expect([...namedModules(a)]).toEqual(['stalled']);
    expect(namedModules(b).size).toBe(0);
    expect(match(a, b)).toBe(true);
  });

  it('family 2 (1801/1888) is unchanged — both name edge_inference', () => {
    expect(mods(1801)).toEqual(['edge_inference']);
    expect(mods(1888)).toEqual(['edge_inference']);
    expect(matchWith(1801, 1888)).toBe(true);
  });

  it('the EQ pair 1297/1830 names no module — out of every named mechanism\'s reach (recorded, not a criterion)', () => {
    expect(namedModules('Learning capture is concentrated in igris-ai/mbrgea-ai while 8 active projects with open briefs have recorded zero learnings').size).toBe(0);
  });

  it('namedModules is the namedProjects algorithm over the constant list — a module vocabulary passed as a project vocabulary reads the same sets', () => {
    const asVocab = new Map(MODULE_VOCABULARY.map((m) => [m, [m]]));
    for (const id of [1341, 1326, 1801, 1809, 1384, 1297]) {
      const row = ANCHOR_HELD_ROWS[id];
      if (!row) continue;
      expect([...namedModules(row.title)].sort()).toEqual([...namedProjects(row.title, asVocab)].sort());
    }
    // The project vocabulary is untouched by the refactor: TD-454's (d) pins re-run above.
    expect([...namedProjects(title(1434), vocab)].sort()).toEqual(['attendance_app', 'hadir', 'hadir-system', 'lifeos']);
  });

  it('NO RE-KEY: the stored dedupe_key of two module-naming rows reproduces byte-for-byte (2026-09-08 copy)', () => {
    // `findingKey` hashes entity + subject ids + claim tokens; the module set
    // is a discriminator, not a key input. These two digests are the stored
    // `dedupe_key` values on the 2026-09-08 copy — reds if the key ever reads
    // the module set (or anything else new).
    expect(findingKey(candidateFromRow(ANCHOR_HELD_ROWS[1341]!))).toBe('0c3b651542f6d7b52a53ed9625620f884c5916e0');
    expect(findingKey(candidateFromRow(ANCHOR_HELD_ROWS[1801]!))).toBe('ffe3e9401c8c6dc4bb3cfbf580cffc570b480012');
  });

  it('DERIVATION GUARD: the vocabulary equals the v1 CHECK set ∪ every deterministic writer\'s source_module literal (re-derived from source)', () => {
    // (1) the v1 CHECK set.
    const check = /CHECK \(source_module IN \(([^)]+)\)\)/.exec(subconsciousMigrations[0]!.sql);
    expect(check, 'v1 CHECK clause not found').not.toBeNull();
    const fromCheck = [...check![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(fromCheck).toEqual(['stalled', 'conflict', 'gap', 'pattern']);
    // (2) every `INSERT INTO suggestions` writer under engine/components: its
    //     source_module VALUE is either a 'literal' (deterministic writer) or a
    //     bound `?` — and exactly ONE writer binds it (the open-typed LLM
    //     extractor, whose labels are the reason the column is not the lever).
    const root = join(process.cwd(), 'src', 'engine', 'components');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full, out);
        } else if (name.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const literals = new Set<string>();
    const bound: string[] = [];
    let sites = 0;
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8');
      const re = /INSERT INTO suggestions\s*\(\s*source_module,[\s\S]*?VALUES\s*\(\s*('([a-z_]+)'|\?)/g;
      for (const m of src.matchAll(re)) {
        sites += 1;
        if (m[2]) literals.add(m[2]);
        else bound.push(file.slice(root.length + 1));
      }
    }
    expect(sites, 'writer population').toBeGreaterThanOrEqual(8);
    expect(bound).toEqual([join('cognition', 'extractors', 'subconscious.ts')]);
    expect([...literals].sort()).toEqual(['arbiter', 'cartographer', 'curator', 'edge_inference', 'janitor']);
    // (3) the constant IS the union, and nothing else.
    const derived = [...new Set([...fromCheck, ...literals])].sort();
    expect([...MODULE_VOCABULARY].sort()).toEqual(derived);
    expect(MODULE_VOCABULARY).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// TD-457 — the 15 (a-narrow) SAME pairs: the decision set that shipped the anchor
// ---------------------------------------------------------------------------

/**
 * `scripts/td457_pairs_a_narrow.csv` is the (a-narrow) decision set under the
 * TD-454 gate on the 2026-09-08 copy (C2 N = 448): every pair newly comparable
 * once the illustrative evidence brief stops anchoring, matching at 0.25 —
 * 15 pairs, 15 SAME, 0 DIFFERENT (the pre-registered pairwise rule). Each
 * pair's rows are pinned verbatim in `ANCHOR_HELD_ROWS`; this describe reads
 * the CSV and asserts, per pair, that the shipped `entityKey` now puts both
 * rows in ONE block, that `claimsMatch` with the production vocabulary says
 * SAME, and that the recorded score reproduces to 3 dp.
 */
describe('TD-457 — the 15 (a-narrow) SAME pairs (scripts/td457_pairs_a_narrow.csv)', () => {
  const csv = readFileSync(join(process.cwd(), 'scripts', 'td457_pairs_a_narrow.csv'), 'utf8');
  const parse = (text: string): string[][] => {
    const out: string[][] = [];
    let row: string[] = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else q = false; } else field += ch;
        continue;
      }
      if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
    if (field.length || row.length) { row.push(field); out.push(row); }
    return out;
  };
  const [header, ...body] = parse(csv);
  const col = (name: string): number => header!.indexOf(name);
  const pairs = body.filter((r) => r.length >= 6).map((r) => ({
    a: Number(r[col('id_a')]), b: Number(r[col('id_b')]),
    pre: r[col('anchor_pre')]!, post: r[col('anchor_post')]!,
    score: Number(r[col('score')]), label: r[col('label')]!,
  }));
  const db = vocabDb(PRODUCTION_SLUGS_2026_09_07);
  let vocab: ReadonlyMap<string, string[]>;
  beforeAll(() => { vocab = loadProjectVocabulary(db); });
  afterAll(() => { db.close(); });

  it('is the recorded set: 15 pairs, every one labelled SAME, 15 distinct rows', () => {
    expect(pairs).toHaveLength(15);
    expect(pairs.every((p) => p.label === 'SAME')).toBe(true);
    expect(new Set(pairs.flatMap((p) => [p.a, p.b])).size).toBe(15);
  });

  it.each(pairs.map((p) => [p.a, p.b, p] as const))('%d/%d shares ONE anchor now, matches with the production vocabulary, scores as recorded', (a, b, p) => {
    const A = ANCHOR_HELD_ROWS[a];
    const B = ANCHOR_HELD_ROWS[b];
    expect(A, `row ${a} not pinned`).toBeDefined();
    expect(B, `row ${b} not pinned`).toBeDefined();
    const anchorA = entityKey(candidateFromRow(A!));
    const anchorB = entityKey(candidateFromRow(B!));
    expect(anchorA).toBe(anchorB);
    expect(`${anchorA}|${anchorB}`).toBe(p.post);
    // The pre-TD-457 anchors differed (that is why the pair was not comparable).
    const [preA, preB] = p.pre.split('|');
    expect(preA).not.toBe(preB);
    expect(claimSimilarity(claimTokens(A!.title), claimTokens(B!.title))).toBeCloseTo(p.score, 3);
    expect(claimsMatch(claimOf(A!.title, vocab), claimOf(B!.title, vocab), THRESHOLD, MIN_TOKENS)).toBe(true);
  });
});
