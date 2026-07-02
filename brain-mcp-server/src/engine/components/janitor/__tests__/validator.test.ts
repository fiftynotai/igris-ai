/**
 * Janitor validator tests (FR-119).
 *
 * Covers `validateJanitorResponse`: cite-check against the candidate pair set,
 * verdict allow-list (drop keep_both + invalid), survivor resolution per verdict,
 * merge survivor_id must be in the pair, confidence cap, fenced-JSON tolerance,
 * and clean rejection of malformed input (→ []).
 *
 * @module engine/components/janitor/__tests__/validator.test
 */

import { describe, it, expect } from 'vitest';
import {
  validateJanitorResponse,
  isJanitorResponseWellFormed,
  JANITOR_CONFIDENCE_CAP,
} from '../validator.js';
import type { DuplicatePair } from '../types.js';

function pair(from_id: number, to_id: number, cosine = 0.97): DuplicatePair {
  return {
    from_id,
    to_id,
    from_title: `L${from_id}`,
    from_snippet: 's',
    to_title: `L${to_id}`,
    to_snippet: 's',
    cosine,
    overlap: 0.8,
  };
}

const PAIRS: DuplicatePair[] = [pair(1, 2), pair(3, 7)];

describe('validateJanitorResponse', () => {
  it('resolves keep_a → survivor=from_id, duplicate=to_id', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'keep_a', confidence: 0.7, justification: 'A canonical' },
    ]);
    const out = validateJanitorResponse(raw, PAIRS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ survivor_id: 1, duplicate_id: 2, verdict: 'keep_a', cosine: 0.97 });
  });

  it('resolves keep_b → survivor=to_id, duplicate=from_id', () => {
    const raw = JSON.stringify([{ from_id: 1, to_id: 2, verdict: 'keep_b', confidence: 0.6 }]);
    const out = validateJanitorResponse(raw, PAIRS);
    expect(out[0]).toMatchObject({ survivor_id: 2, duplicate_id: 1, verdict: 'keep_b' });
  });

  it('resolves merge with a cited survivor_id + synthesized_content', () => {
    const raw = JSON.stringify([
      {
        from_id: 3,
        to_id: 7,
        verdict: 'merge',
        survivor_id: 7,
        synthesized_content: 'merged statement',
        confidence: 0.8,
      },
    ]);
    const out = validateJanitorResponse(raw, PAIRS);
    expect(out[0]).toMatchObject({
      survivor_id: 7,
      duplicate_id: 3,
      verdict: 'merge',
      synthesized_content: 'merged statement',
    });
  });

  it('REJECTS a merge whose survivor_id is outside the pair', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'merge', survivor_id: 99, confidence: 0.8 },
    ]);
    expect(validateJanitorResponse(raw, PAIRS)).toHaveLength(0);
  });

  it('REJECTS a pair not in the candidate set (hallucination guard)', () => {
    const raw = JSON.stringify([{ from_id: 1, to_id: 3, verdict: 'keep_a', confidence: 0.7 }]);
    expect(validateJanitorResponse(raw, PAIRS)).toHaveLength(0);
  });

  it('drops keep_both and any invalid verdict', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'keep_both', confidence: 0.5 },
      { from_id: 3, to_id: 7, verdict: 'nonsense', confidence: 0.5 },
    ]);
    expect(validateJanitorResponse(raw, PAIRS)).toHaveLength(0);
  });

  it('caps confidence at 0.85 and floors at 0', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'keep_a', confidence: 0.99 },
      { from_id: 3, to_id: 7, verdict: 'keep_b', confidence: -1 },
    ]);
    const out = validateJanitorResponse(raw, PAIRS);
    expect(out.find((p) => p.survivor_id === 1)?.confidence).toBe(JANITOR_CONFIDENCE_CAP);
    expect(out.find((p) => p.survivor_id === 7)?.confidence).toBe(0);
  });

  it('tolerates a ```json fenced array', () => {
    const raw = '```json\n[{"from_id":1,"to_id":2,"verdict":"keep_a","confidence":0.5}]\n```';
    expect(validateJanitorResponse(raw, PAIRS)).toHaveLength(1);
  });

  it('returns [] for non-array / malformed / self-loop input', () => {
    expect(validateJanitorResponse('not json', PAIRS)).toEqual([]);
    expect(validateJanitorResponse('', PAIRS)).toEqual([]);
    const selfLoop = JSON.stringify([{ from_id: 1, to_id: 1, verdict: 'keep_a', confidence: 0.5 }]);
    expect(validateJanitorResponse(selfLoop, PAIRS)).toEqual([]);
  });
});

describe('isJanitorResponseWellFormed (TD-294)', () => {
  it('a well-formed empty array is well-formed (valid-empty judgment)', () => {
    expect(isJanitorResponseWellFormed('[]')).toBe(true);
  });

  it('a well-formed array whose elements are all dropped is still well-formed', () => {
    expect(isJanitorResponseWellFormed('[{}]')).toBe(true);
  });

  it('non-JSON text is malformed', () => {
    expect(isJanitorResponseWellFormed('not json')).toBe(false);
  });

  it('a blank/whitespace-only response is malformed', () => {
    expect(isJanitorResponseWellFormed('   ')).toBe(false);
  });
});
