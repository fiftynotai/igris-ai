/**
 * Brief Metadata Normalization Tests (TD-238)
 *
 * Table-driven coverage for the three write-boundary normalizers:
 *   - normalizePhase    — legacy → canonical UPPER; unknown passthrough; null
 *   - normalizePriority — alias fold; Unset family → NULL; unknown passthrough
 *   - normalizeBriefType — alias fold; case-fold; unknown passthrough; null
 *
 * Each suite asserts: legacy → canonical, canonical → canonical (idempotent),
 * unknown → passthrough, and the null/empty policy.
 *
 * @module __tests__/brief-normalize
 */

import { describe, it, expect } from 'vitest';
import {
  CANONICAL_PHASES,
  CANONICAL_PRIORITIES,
  CANONICAL_BRIEF_TYPES,
  BRIEF_TYPE_ALIASES,
  BRIEF_TYPE_COMPOUND_FOLDS,
  BRIEF_ID_PREFIX_TYPES,
  isCanonicalBriefType,
  normalizePhase,
  normalizePriority,
  normalizeBriefType,
  CANONICAL_STATUSES,
  STATUS_ALIASES,
  isCanonicalStatus,
  normalizeStatus,
  nonCanonicalStatusNote,
} from '../brief-normalize.js';

describe('normalizePhase (TD-238)', () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    // legacy / mixed-case → canonical UPPER
    ['building', 'BUILDING'],
    ['Building', 'BUILDING'],
    ['  reviewing  ', 'REVIEWING'],
    ['complete', 'COMPLETE'],
    ['blocked', 'BLOCKED'],
    // canonical → canonical (idempotent)
    ['BUILDING', 'BUILDING'],
    ['COMPLETE', 'COMPLETE'],
    // unknown → passthrough untouched (#228 read-widen)
    ['BUILDING — wip', 'BUILDING — wip'],
    ['SomeNewPhase', 'SomeNewPhase'],
    // null / empty policy
    [null, null],
    [undefined, null],
    ['', null],
    ['   ', null],
  ];

  it.each(cases)('normalizePhase(%j) === %j', (input, expected) => {
    expect(normalizePhase(input)).toBe(expected);
  });

  it('is idempotent for every canonical phase', () => {
    for (const p of CANONICAL_PHASES) {
      expect(normalizePhase(p)).toBe(p);
      expect(normalizePhase(normalizePhase(p))).toBe(p);
    }
  });

  it('idempotent on a double-applied legacy value', () => {
    const once = normalizePhase('building');
    expect(normalizePhase(once)).toBe(once);
  });
});

describe('normalizePriority (TD-238)', () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    // bare P{N} → canonical
    ['P0', 'P0-Critical'],
    ['P1', 'P1-High'],
    ['P2', 'P2-Medium'],
    ['P3', 'P3-Low'],
    // spaced-dash legacy → canonical
    ['P1 - High', 'P1-High'],
    ['P0 - Critical', 'P0-Critical'],
    ['P2 - Medium', 'P2-Medium'],
    ['P3 - Low', 'P3-Low'],
    // case-insensitive fold
    ['p1', 'P1-High'],
    ['p1 - high', 'P1-High'],
    // canonical → canonical (idempotent)
    ['P1-High', 'P1-High'],
    ['P0-Critical', 'P0-Critical'],
    // Unset family → NULL
    ['Unset', null],
    ['unset', null],
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
    // unknown → passthrough untouched
    ['P9-Wat', 'P9-Wat'],
    ['Critical', 'Critical'],
  ];

  it.each(cases)('normalizePriority(%j) === %j', (input, expected) => {
    expect(normalizePriority(input)).toBe(expected);
  });

  it('is idempotent for every canonical priority', () => {
    for (const p of CANONICAL_PRIORITIES) {
      expect(normalizePriority(p)).toBe(p);
      expect(normalizePriority(normalizePriority(p))).toBe(p);
    }
  });

  it('idempotent on a double-applied legacy value', () => {
    const once = normalizePriority('P1');
    expect(normalizePriority(once)).toBe('P1-High');
  });
});

describe('normalizeBriefType (TD-238)', () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    // alias fold
    ['Tech Debt', 'Technical Debt'],
    ['Bug Fix', 'Bug'],
    // case-fold to canonical casing
    ['technical debt', 'Technical Debt'],
    ['feature', 'Feature'],
    ['BUG', 'Bug'],
    ['  migration  ', 'Migration'],
    // canonical → canonical (idempotent)
    ['Technical Debt', 'Technical Debt'],
    ['Feature', 'Feature'],
    ['Process Improvement', 'Process Improvement'],
    // unknown → passthrough untouched (read-widen)
    ['Spike', 'Spike'],
    ['Research', 'Research'],
    // null / empty policy
    [null, null],
    [undefined, null],
    ['', null],
    ['   ', null],
  ];

  it.each(cases)('normalizeBriefType(%j) === %j', (input, expected) => {
    expect(normalizeBriefType(input)).toBe(expected);
  });

  it('is idempotent for every canonical brief type', () => {
    for (const t of CANONICAL_BRIEF_TYPES) {
      expect(normalizeBriefType(t)).toBe(t);
      expect(normalizeBriefType(normalizeBriefType(t))).toBe(t);
    }
  });

  it('idempotent on a double-applied legacy value', () => {
    const once = normalizeBriefType('Tech Debt');
    expect(normalizeBriefType(once)).toBe('Technical Debt');
  });
});

// ---------------------------------------------------------------------------
// TD-328 — the widened fold table
//
// RED-FIRST: every case in `foldCases` below FAILS against the pre-TD-328
// two-entry BRIEF_TYPE_ALIASES map ({'tech debt', 'bug fix'}), which is the
// evidence AC-1 requires ("the unambiguous aliases fold, proven by a test that
// FAILS against the current map"). The live brain carried 50 distinct non-NULL
// spellings for ~10 concepts precisely because these folds did not exist.
// ---------------------------------------------------------------------------

describe('normalizeBriefType — TD-328 widened fold table', () => {
  const foldCases: Array<[string, string]> = [
    // --- tech-debt family (409 + 43 + 38 + 13 + 4 + 3 + 2 + 2 + 1 live rows) --
    ['TD', 'Technical Debt'],
    ['Debt', 'Technical Debt'],
    ['debt', 'Technical Debt'],
    ['TechDebt', 'Technical Debt'],
    ['TechnicalDebt', 'Technical Debt'],
    ['tech_debt', 'Technical Debt'],
    ['Tech-Debt', 'Technical Debt'],
    ['Tech Debt', 'Technical Debt'],
    // Chore has no mint prefix and no distinct consumer (D2).
    ['Chore', 'Technical Debt'],
    // --- bug family --------------------------------------------------------
    ['BugFix', 'Bug'],
    ['Bug Fix', 'Bug'],
    // --- feature family (D3: 136 rows fold; status cross-tab proved there is
    //     no "intake queue" distinction to destroy) ---------------------------
    ['FR', 'Feature'],
    ['Feature Request', 'Feature'],
    ['FeatureRequest', 'Feature'],
    ['Enhancement', 'Feature'],
    ['Feature Enhancement', 'Feature'],
    // --- D2: Refactor is CANONICAL (operator sign-off), Refactoring folds ---
    ['Refactor', 'Refactor'],
    ['Refactoring', 'Refactor'],
    // --- newly canonical types + their spelling variants --------------------
    ['Architecture', 'Architecture'],
    ['ArchitectureCleanup', 'Architecture'],
    ['Dependency Update', 'Dependency Update'],
    ['DependencyUpdate', 'Dependency Update'],
    // --- remaining Tier A spellings ----------------------------------------
    ['Doc', 'Documentation'],
    ['Test', 'Testing'],
    ['Process', 'Process Improvement'],
    // Release work is release-PROCESS work; all 6 live rows were title-checked
    // in Phase 0 and none read as product features (D2 gate).
    ['Release', 'Process Improvement'],
  ];

  it.each(foldCases)('normalizeBriefType(%j) === %j', (input, expected) => {
    expect(normalizeBriefType(input)).toBe(expected);
  });

  it('folds case-insensitively and trims (the write boundary is forgiving)', () => {
    expect(normalizeBriefType('  techdebt  ')).toBe('Technical Debt');
    expect(normalizeBriefType('FEATURE REQUEST')).toBe('Feature');
    expect(normalizeBriefType('refactoring')).toBe('Refactor');
  });

  // --- read-widen is PRESERVED (D1 option b) -------------------------------
  const passthroughCases: Array<[string | null | undefined, string | null]> = [
    // No defensible fold target — folding would be inventing, not normalising.
    ['Spike', 'Spike'],
    ['Investigation', 'Investigation'],
    ['Integration', 'Integration'],
    // Genuinely two types with no head type (D4).
    ['Bug/Feature', 'Bug/Feature'],
    // `BR` maps to BOTH bug and feature at the mint surface — ambiguous by
    // design, so it must NOT fold (same reason BR- is excluded from D5).
    ['BR', 'BR'],
    // Compounds are NOT folded at the write boundary — the D4 qualifier-
    // recoverability check needs the row's title/content, which the pure
    // normalizer does not have. They pass through and trigger the D6(c) echo.
    ['Bug Fix / Compliance', 'Bug Fix / Compliance'],
    ['Feature / UI Enhancement', 'Feature / UI Enhancement'],
    // A brand-new 51st spelling still survives (never drop operator data).
    ['Frobnicate', 'Frobnicate'],
    [null, null],
    [undefined, null],
    ['', null],
    ['   ', null],
  ];

  it.each(passthroughCases)(
    'read-widen preserved: normalizeBriefType(%j) === %j',
    (input, expected) => {
      expect(normalizeBriefType(input)).toBe(expected);
    },
  );

  it('every alias target is itself canonical (catches a typo\'d fold target)', () => {
    for (const [alias, target] of Object.entries(BRIEF_TYPE_ALIASES)) {
      expect(isCanonicalBriefType(target), `alias "${alias}" → "${target}"`).toBe(true);
    }
  });

  it('every alias key is already lowercase (the map is looked up by lower(trim))', () => {
    for (const alias of Object.keys(BRIEF_TYPE_ALIASES)) {
      expect(alias).toBe(alias.toLowerCase());
      expect(alias).toBe(alias.trim());
    }
  });

  it('no alias key collides with a canonical type', () => {
    for (const alias of Object.keys(BRIEF_TYPE_ALIASES)) {
      const clash = CANONICAL_BRIEF_TYPES.find((t) => t.toLowerCase() === alias);
      expect(clash, `alias "${alias}" shadows canonical "${clash}"`).toBeUndefined();
    }
  });

  it('is idempotent across the whole fold table (fold(fold(x)) === fold(x))', () => {
    for (const [input] of foldCases) {
      const once = normalizeBriefType(input);
      expect(normalizeBriefType(once)).toBe(once);
    }
  });

  it('canonical set contains the TD-328 additions and keeps the old members', () => {
    for (const t of [
      'Feature',
      'Bug',
      'Migration',
      'Technical Debt',
      'Testing',
      'Process Improvement',
      'Documentation',
      'Acceptance',
      'Performance',
      // TD-328 additions
      'Architecture',
      'Dependency Update',
      'Refactor',
    ]) {
      expect(isCanonicalBriefType(t), `expected "${t}" canonical`).toBe(true);
    }
    expect(isCanonicalBriefType('Frobnicate')).toBe(false);
    // isCanonicalBriefType is the D6(c) echo's predicate — it must be
    // case-insensitive so "feature" does not trigger a spurious NOTE.
    expect(isCanonicalBriefType('feature')).toBe(true);
  });
});

describe('BRIEF_ID_PREFIX_TYPES — the D5 NULL-inference decode table', () => {
  it('has NO `BR` key — the 17 NULL BR- rows predate TD-331 and cannot be decoded', () => {
    // Guards the D5 ambiguity against a well-meaning future addition.
    //
    // READ THIS BEFORE "FIXING" THE TITLE. TD-331 made the MINT map 1:1
    // (`bug` → BR, `feature` → FR), so it is tempting to conclude BR: 'Bug' is
    // now safe. It is not, and the reason is what this table is FOR: it decodes
    // brief IDs that ALREADY EXIST, and it is applied to every NULL-type row
    // with no date gate (db.ts's v22 UPDATE and normalize_brief_types.ts, which
    // is re-runnable on demand). All 17 NULL BR- rows predate the decision, so
    // adding the key retro-assigns exactly the rows TD-331 scope item 2
    // forbids touching. The ambiguity is a property of WHEN a brief was minted,
    // which this table cannot see.
    expect(BRIEF_ID_PREFIX_TYPES).not.toHaveProperty('BR');
  });

  it('decodes every unambiguous mint prefix to a canonical type', () => {
    expect(BRIEF_ID_PREFIX_TYPES).toEqual({
      FR: 'Feature',
      MG: 'Migration',
      TD: 'Technical Debt',
      TS: 'Testing',
      PI: 'Process Improvement',
      DU: 'Dependency Update',
      PF: 'Performance',
      AC: 'Architecture',
    });
  });

  it('every decoded type is canonical', () => {
    for (const [prefix, type] of Object.entries(BRIEF_ID_PREFIX_TYPES)) {
      expect(isCanonicalBriefType(type), `${prefix}- → ${type}`).toBe(true);
    }
  });
});

describe('BRIEF_TYPE_COMPOUND_FOLDS — the D4 gated fold table', () => {
  it('every head type is canonical and every entry carries at least one token', () => {
    for (const [compound, fold] of Object.entries(BRIEF_TYPE_COMPOUND_FOLDS)) {
      expect(isCanonicalBriefType(fold.head), `${compound} → ${fold.head}`).toBe(true);
      expect(fold.tokens.length, `${compound} has no qualifier token`).toBeGreaterThan(0);
      for (const tok of fold.tokens) {
        expect(tok).toBe(tok.toLowerCase());
      }
    }
  });

  it('keys are lowercase and disjoint from the unconditional alias map', () => {
    for (const compound of Object.keys(BRIEF_TYPE_COMPOUND_FOLDS)) {
      expect(compound).toBe(compound.toLowerCase());
      // A compound must never ALSO be an unconditional alias — that would fold
      // it without the qualifier-recoverability gate D4 requires.
      expect(BRIEF_TYPE_ALIASES).not.toHaveProperty(compound);
    }
  });

  it('does NOT contain `bug/feature` — it has no head type (D4)', () => {
    expect(BRIEF_TYPE_COMPOUND_FOLDS).not.toHaveProperty('bug/feature');
  });
});

// ===========================================================================
// TD-333 — the `status` vocabulary
// ===========================================================================

describe('normalizeStatus (TD-333)', () => {
  // T1 — THE AC-3 PROOF. Every row here is red against the pre-TD-333 module,
  // which exports no `normalizeStatus` at all (the import does not resolve).
  const cases: Array<[string | null | undefined, string | null]> = [
    // the three folds — the entire fold table, one row each
    ['Completed', 'Done'],
    ['Complete', 'Done'],
    ['InProgress', 'In Progress'],
    // case + padding variants of a canonical member
    ['in progress', 'In Progress'],
    ['IN PROGRESS', 'In Progress'],
    ['  Done  ', 'Done'],
    ['done', 'Done'],
    ['ARCHIVED', 'Archived'],
    // case + padding variants of an ALIAS key
    ['  completed ', 'Done'],
    ['inprogress', 'In Progress'],
    ['IN-PROGRESS', 'IN-PROGRESS'], // notation the SQL gates fold; vocabulary does NOT
    // canonical → canonical (idempotent fixed points)
    ['Done', 'Done'],
    ['In Progress', 'In Progress'],
    ['Ready', 'Ready'],
    // unknown → passthrough untouched (read-widen; the fold never invents)
    ['Cancelled', 'Cancelled'],
    ['Superseded', 'Superseded'],
    ['Deferred', 'Deferred'],
    ['Closed', 'Closed'],
    ['WIP', 'WIP'],
    // null policy — the field was not supplied
    [null, null],
    [undefined, null],
  ];

  it.each(cases)('normalizeStatus(%j) === %j', (input, expected) => {
    expect(normalizeStatus(input)).toBe(expected);
  });

  it('does NOT map the empty string to NULL — `status` is TEXT NOT NULL', () => {
    // The deliberate asymmetry with the three sibling normalizers. priority /
    // phase / brief_type are NULLABLE columns where NULL is a legitimate
    // *unset*, so they fold '' → null. `brief_status.status` is NOT NULL, so
    // the same fold would turn a meaningless-but-tolerated write into a
    // constraint violation at the write boundary and a SILENTLY DROPPED ROW at
    // sync ingress. Passthrough keeps the module's never-hard-reject posture.
    expect(normalizeStatus('')).toBe('');
    expect(normalizeStatus('   ')).toBe('   ');
    // ...and the echo still names it, because '' is an offender, not an unset.
    expect(isCanonicalStatus('')).toBe(false);
    expect(nonCanonicalStatusNote('')).toContain('not a canonical status');
    // Contrast, pinned so a future editor sees the asymmetry is intentional:
    expect(normalizePriority('')).toBeNull();
    expect(normalizePhase('')).toBeNull();
    expect(normalizeBriefType('')).toBeNull();
  });

  // T2 — idempotence + closure over the whole table.
  it('is idempotent for every canonical status', () => {
    for (const s of CANONICAL_STATUSES) {
      expect(normalizeStatus(s)).toBe(s);
      expect(normalizeStatus(normalizeStatus(s))).toBe(s);
    }
  });

  it('f(f(x)) === f(x) for every alias key and every alias target', () => {
    const corpus = [...Object.keys(STATUS_ALIASES), ...Object.values(STATUS_ALIASES)];
    for (const input of corpus) {
      const once = normalizeStatus(input);
      expect(normalizeStatus(once), `f(f(${input}))`).toBe(once);
    }
  });

  it('every alias TARGET is itself canonical', () => {
    for (const [alias, target] of Object.entries(STATUS_ALIASES)) {
      expect(isCanonicalStatus(target), `${alias} → ${target}`).toBe(true);
    }
  });

  it('alias KEYS are lowercase, trimmed, and never a canonical spelling', () => {
    for (const key of Object.keys(STATUS_ALIASES)) {
      expect(key).toBe(key.trim().toLowerCase());
      // A key that is already a case-variant of a canonical member would be a
      // no-op row pretending to be a fold.
      expect(
        CANONICAL_STATUSES.some((s) => s.toLowerCase() === key),
        `${key} is already canonical`,
      ).toBe(false);
    }
  });
});

describe('STATUS_ALIASES — the TD-311 exclusion pins (T3)', () => {
  // Every fold below IS a state edit. TD-311 forbids resolving a brief-state
  // contradiction by editing brief data, and these tests are what make that
  // rule mechanical: a well-meaning future addition goes RED here instead of
  // silently retyping live briefs.
  const forbiddenKeys = [
    'cancelled', // → Archived would move "we decided not to" to "we finished it"
    'canceled',
    'superseded', // → Done would claim work happened that another brief carries
    'deferred', // → Blocked confuses postponed with externally prevented
    'draft', // → Ready advances the state machine
    'blocked', // → In Progress advances the state machine
    'closed', // no live rows AND no documented meaning; folding would invent
  ];

  it.each(forbiddenKeys)('has NO `%s` key — that fold would be a STATE EDIT', (key) => {
    expect(STATUS_ALIASES).not.toHaveProperty(key);
  });

  it('leaves the three MISSING STATES byte-identical', () => {
    for (const v of ['Cancelled', 'Superseded', 'Deferred']) {
      expect(normalizeStatus(v)).toBe(v);
      expect(isCanonicalStatus(v)).toBe(false);
    }
  });

  it('leaves the welded-payload and SENTENCE statuses byte-identical', () => {
    // `Done(Resolved…)` carries a commit sha with no other copy — folding it to
    // `Done` is a DATA edit that destroys it. The two `Split (…)` rows are a
    // parent's lineage crammed into the state field, and `Done`/`Archived`/
    // `Superseded` are all defensible readings the operator chose none of.
    const untouchable = [
      'Done(Resolvedbydec8d1f)',
      'Split (see FR-061, FR-062, FR-063)',
      'Split (see FR-161, FR-162, FR-163, FR-164, FR-165, FR-166, FR-167)',
    ];
    for (const v of untouchable) {
      expect(normalizeStatus(v)).toBe(v);
      expect(isCanonicalStatus(v)).toBe(false);
      expect(nonCanonicalStatusNote(v)).toContain('not a canonical status');
    }
  });

  it('the fold table is EXACTLY the three argued entries', () => {
    // A whole-table equality, not a spot check: an added row fails here even if
    // its key is not on the forbidden list above.
    expect(STATUS_ALIASES).toEqual({
      completed: 'Done',
      complete: 'Done',
      inprogress: 'In Progress',
    });
  });
});

describe('CANONICAL_STATUSES — the documented lifecycle, NOT widened by TD-333', () => {
  it('is exactly the six documented statuses, in lifecycle order', () => {
    // The ONE written source is docs/architecture/brief-state-source-of-truth.md
    // and cli/dashboard/src/layers/board.ts mirrors it. TD-333 normalises the
    // vocabulary; it does not change the state machine.
    expect([...CANONICAL_STATUSES]).toEqual([
      'Draft',
      'Ready',
      'In Progress',
      'Blocked',
      'Done',
      'Archived',
    ]);
  });

  it('isCanonicalStatus is case-insensitive and trim-tolerant (the echo pivots on it)', () => {
    for (const s of CANONICAL_STATUSES) {
      expect(isCanonicalStatus(s)).toBe(true);
      expect(isCanonicalStatus(s.toLowerCase())).toBe(true);
      expect(isCanonicalStatus(`  ${s.toUpperCase()}  `)).toBe(true);
      expect(nonCanonicalStatusNote(s)).toBeNull();
    }
    expect(isCanonicalStatus(null)).toBe(false);
    expect(isCanonicalStatus(undefined)).toBe(false);
    expect(nonCanonicalStatusNote(null)).toBeNull();
    expect(nonCanonicalStatusNote(undefined)).toBeNull();
  });

  it('the note names every canonical value so the reader can retype the brief', () => {
    const note = nonCanonicalStatusNote('Cancelled');
    expect(note).not.toBeNull();
    for (const s of CANONICAL_STATUSES) {
      expect(note as string).toContain(s);
    }
  });
});
