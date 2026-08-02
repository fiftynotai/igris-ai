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
  it('has NO `BR` key — /register maps BOTH bug and feature to BR-', () => {
    // Guards the D5 ambiguity against a well-meaning future addition. Inferring
    // BR- → Bug would silently mistype an unknown number of features, and BR-
    // is the oldest and largest prefix in the corpus.
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
