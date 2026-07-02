/**
 * Arbiter validator tests (FR-116 M2).
 *
 * Covers `validateArbiterResponse`:
 *   - CITE-CHECK: a proposal whose id pair is not a candidate is dropped;
 *   - VERDICT ALLOW-LIST: not_a_contradiction + garbage verdicts dropped;
 *   - winner_id/loser_id MUST be exactly {from_id, to_id};
 *   - evolved_merge REQUIRES a non-empty synthesized_content;
 *   - both_valid_scope REQUIRES at least one non-empty scope;
 *   - confidence clamp to [0, 0.85];
 *   - non-JSON-array → [] (never throws).
 *
 * No mocks (L-159): the validator is pure (raw text + candidate pairs in).
 *
 * @module engine/components/arbiter/__tests__/validator.test
 */

import { describe, it, expect } from 'vitest';
import { validateArbiterResponse, ARBITER_CONFIDENCE_CAP } from '../validator.js';
import type { ContradictionPair } from '../types.js';

function pair(from: number, to: number, cosine = 0.9): ContradictionPair {
  return {
    from_id: from,
    to_id: to,
    from_title: `L${from}`,
    from_snippet: 'a',
    from_created_at: '2026-01-01',
    to_title: `L${to}`,
    to_snippet: 'b',
    to_created_at: '2026-02-01',
    cosine,
    cue: 'negation',
  };
}

const PAIRS = [pair(1, 2), pair(3, 4)];

describe('validateArbiterResponse (FR-116 M2)', () => {
  it('accepts a well-formed newer_wins proposal (winner+loser in the pair)', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'newer_wins', winner_id: 2, loser_id: 1, confidence: 0.7, justification: 'newer' },
    ]);
    const out = validateArbiterResponse(raw, PAIRS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ verdict: 'newer_wins', winner_id: 2, loser_id: 1, cosine: 0.9 });
  });

  it('drops a hallucinated pair not in the candidate set (cite-check)', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 9, verdict: 'newer_wins', winner_id: 1, loser_id: 9, confidence: 0.7 },
    ]);
    expect(validateArbiterResponse(raw, PAIRS)).toHaveLength(0);
  });

  it('drops not_a_contradiction + unknown verdicts', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'not_a_contradiction', confidence: 0.9 },
      { from_id: 3, to_id: 4, verdict: 'merge', confidence: 0.9 },
    ]);
    expect(validateArbiterResponse(raw, PAIRS)).toHaveLength(0);
  });

  it('rejects newer_wins whose winner/loser are not exactly the pair', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'newer_wins', winner_id: 1, loser_id: 3, confidence: 0.7 },
    ]);
    expect(validateArbiterResponse(raw, PAIRS)).toHaveLength(0);
  });

  it('requires synthesized_content for evolved_merge', () => {
    const without = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'evolved_merge', winner_id: 1, loser_id: 2, confidence: 0.7 },
    ]);
    expect(validateArbiterResponse(without, PAIRS)).toHaveLength(0);

    const withContent = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'evolved_merge', winner_id: 1, loser_id: 2, synthesized_content: 'evolved', confidence: 0.7 },
    ]);
    const out = validateArbiterResponse(withContent, PAIRS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ verdict: 'evolved_merge', synthesized_content: 'evolved' });
  });

  it('requires at least one scope for both_valid_scope', () => {
    const empty = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'both_valid_scope', confidence: 0.7 },
    ]);
    expect(validateArbiterResponse(empty, PAIRS)).toHaveLength(0);

    const scoped = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'both_valid_scope', scope_a: 'prod', confidence: 0.7 },
    ]);
    const out = validateArbiterResponse(scoped, PAIRS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ verdict: 'both_valid_scope', learning_a_id: 1, learning_b_id: 2, scope_a: 'prod' });
  });

  it('clamps confidence to [0, 0.85]', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'newer_wins', winner_id: 1, loser_id: 2, confidence: 5 },
    ]);
    expect(validateArbiterResponse(raw, PAIRS)[0].confidence).toBe(ARBITER_CONFIDENCE_CAP);
  });

  it('returns [] on non-JSON-array (never throws)', () => {
    expect(validateArbiterResponse('not json', PAIRS)).toEqual([]);
    expect(validateArbiterResponse('{"from_id":1}', PAIRS)).toEqual([]);
    expect(validateArbiterResponse('', PAIRS)).toEqual([]);
  });
});
