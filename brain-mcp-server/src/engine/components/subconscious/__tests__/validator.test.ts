/**
 * Subconscious validator test (FR-118 M2).
 *
 * The validator is the `parseResponse` slot — three hard rules:
 *   1. citation cross-check (hallucination guard) — a cited brief_id/learning_id
 *      not in the digest REJECTS the suggestion;
 *   2. confidence cap [0, 0.85] — out-of-range values are clamped;
 *   3. reject-malformed-cleanly — a non-array response yields [] (the engine
 *      maps that to parse_error).
 *
 * @module engine/components/subconscious/__tests__/validator.test
 */

import { describe, it, expect } from 'vitest';
import {
  validateSubconsciousResponse,
  buildCitationIndex,
  SUBCONSCIOUS_CONFIDENCE_CAP,
} from '../validator.js';
import type { BrainDigest } from '../digest.js';

/** A digest whose citation whitelist is BR-1 + learning 7. */
function fixtureDigest(): BrainDigest {
  return {
    scope: 'all',
    generated_at: '2026-06-20 12:00:00',
    open_briefs: [
      { brief_id: 'BR-1', project: 'p', title: 't', status: 'In Progress', priority: 'P1', days_since_update: 5 },
    ],
    recent_learnings: [
      { id: 7, project: 'p', category: 'pattern', title: 'L', confidence: 0.8 },
    ],
    open_suggestions: [],
    projects: [],
    recent_commits: [],
    size_hint: { bytes: 100, truncated: false },
  };
}

describe('validateSubconsciousResponse (FR-118 M2)', () => {
  it('builds the citation whitelist from open_briefs + recent_learnings', () => {
    const index = buildCitationIndex(fixtureDigest());
    expect(index.briefIds.has('BR-1')).toBe(true);
    expect(index.learningIds.has(7)).toBe(true);
    expect(index.briefIds.has('BR-999')).toBe(false);
  });

  it('accepts a well-formed suggestion citing an id present in the digest', () => {
    const raw = JSON.stringify([
      {
        kind: 'stalled_brief',
        project_slug: 'p',
        title: 'BR-1 is stalling',
        priority: 'high',
        confidence: 0.7,
        evidence: { brief_id: 'BR-1', note: 'no update in 5 days' },
      },
    ]);
    const out = validateSubconsciousResponse(raw, fixtureDigest());
    expect(out).toHaveLength(1);
    expect(out[0].source_module).toBe('stalled_brief');
    expect(out[0].confidence).toBe(0.7);
    expect(out[0].priority).toBe('high');
  });

  it('REJECTS a suggestion citing a brief_id NOT in the digest (hallucination guard)', () => {
    const raw = JSON.stringify([
      { kind: 'x', title: 't', priority: 'low', confidence: 0.5, evidence: { brief_id: 'BR-999' } },
    ]);
    expect(validateSubconsciousResponse(raw, fixtureDigest())).toEqual([]);
  });

  it('REJECTS a suggestion citing a learning_id NOT in the digest', () => {
    const raw = JSON.stringify([
      { kind: 'x', title: 't', priority: 'low', confidence: 0.5, evidence: { learning_id: 99 } },
    ]);
    expect(validateSubconsciousResponse(raw, fixtureDigest())).toEqual([]);
  });

  it('caps confidence above 0.85 to the ceiling', () => {
    const raw = JSON.stringify([
      { kind: 'x', title: 't', priority: 'medium', confidence: 0.99, evidence: {} },
    ]);
    const out = validateSubconsciousResponse(raw, fixtureDigest());
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(SUBCONSCIOUS_CONFIDENCE_CAP);
  });

  it('clamps a negative confidence to 0', () => {
    const raw = JSON.stringify([
      { kind: 'x', title: 't', priority: 'medium', confidence: -0.4, evidence: {} },
    ]);
    const out = validateSubconsciousResponse(raw, fixtureDigest());
    expect(out[0].confidence).toBe(0);
  });

  it('rejects malformed (non-array) responses cleanly → [] (engine maps to parse_error)', () => {
    expect(validateSubconsciousResponse('not json at all', fixtureDigest())).toEqual([]);
    expect(validateSubconsciousResponse('{"not":"an array"}', fixtureDigest())).toEqual([]);
    expect(validateSubconsciousResponse('', fixtureDigest())).toEqual([]);
  });

  it('parses a fenced ```json array', () => {
    const raw = '```json\n[{"kind":"x","title":"t","priority":"low","confidence":0.3,"evidence":{}}]\n```';
    const out = validateSubconsciousResponse(raw, fixtureDigest());
    expect(out).toHaveLength(1);
  });

  it('drops unusable elements (missing kind/title) without rescuing them', () => {
    const raw = JSON.stringify([
      { title: 'no kind', priority: 'low', confidence: 0.3, evidence: {} },
      { kind: 'no title', priority: 'low', confidence: 0.3, evidence: {} },
      { kind: 'ok', title: 'keeps', priority: 'low', confidence: 0.3, evidence: {} },
    ]);
    const out = validateSubconsciousResponse(raw, fixtureDigest());
    expect(out.map((c) => c.title)).toEqual(['keeps']);
  });

  it('retains a suggested_action with a string kind; drops one without', () => {
    const raw = JSON.stringify([
      {
        kind: 'a',
        title: 'with action',
        priority: 'low',
        confidence: 0.3,
        evidence: {},
        suggested_action: { kind: 'flag_for_review', note: 'x' },
      },
      {
        kind: 'b',
        title: 'bad action',
        priority: 'low',
        confidence: 0.3,
        evidence: {},
        suggested_action: { note: 'no kind' },
      },
    ]);
    const out = validateSubconsciousResponse(raw, fixtureDigest());
    const withAction = out.find((c) => c.title === 'with action');
    const badAction = out.find((c) => c.title === 'bad action');
    expect(withAction?.suggested_action).toEqual({ kind: 'flag_for_review', note: 'x' });
    expect(badAction?.suggested_action).toBeUndefined();
  });

  it('coerces an invalid priority to medium', () => {
    const raw = JSON.stringify([
      { kind: 'x', title: 't', priority: 'urgent', confidence: 0.3, evidence: {} },
    ]);
    expect(validateSubconsciousResponse(raw, fixtureDigest())[0].priority).toBe('medium');
  });
});
