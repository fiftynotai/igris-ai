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

import { describe, it, expect } from 'vitest';
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
