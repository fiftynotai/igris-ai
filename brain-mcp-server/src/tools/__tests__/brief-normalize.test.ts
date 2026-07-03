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
