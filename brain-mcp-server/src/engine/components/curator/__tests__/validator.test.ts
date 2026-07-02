/**
 * Curator validator tests (FR-116 M3).
 *
 * `validateCuratorResponse` cite-checks learning_ids against the candidate set,
 * enforces the verdict allow-list, requires a positive delta for
 * lower_confidence, caps confidence at 0.85, and rejects a non-array cleanly.
 *
 * @module engine/components/curator/__tests__/validator.test
 */

import { describe, it, expect } from 'vitest';
import {
  validateCuratorResponse,
  isCuratorResponseWellFormed,
  CURATOR_CONFIDENCE_CAP,
} from '../validator.js';
import type { StaleCandidate } from '../types.js';

function cand(id: number): StaleCandidate {
  return {
    id,
    title: `t${id}`,
    snippet: `s${id}`,
    created_at: '2024-01-01',
    access_count: 0,
    confidence: 0.8,
    reason: 'stale',
  };
}

const CANDIDATES: StaleCandidate[] = [cand(1), cand(2), cand(3)];

describe('validateCuratorResponse (FR-116 M3)', () => {
  it('keeps a valid prune verdict', () => {
    const raw = JSON.stringify([{ learning_id: 1, verdict: 'prune', confidence: 0.7, justification: 'obsolete' }]);
    const out = validateCuratorResponse(raw, CANDIDATES);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ learning_id: 1, verdict: 'prune', confidence: 0.7 });
  });

  it('keeps a keep verdict (all three verdicts are actionable)', () => {
    const raw = JSON.stringify([{ learning_id: 2, verdict: 'keep', confidence: 0.6, justification: 'still valid' }]);
    const out = validateCuratorResponse(raw, CANDIDATES);
    expect(out).toHaveLength(1);
    expect(out[0].verdict).toBe('keep');
  });

  it('keeps a lower_confidence verdict with a positive delta', () => {
    const raw = JSON.stringify([
      { learning_id: 3, verdict: 'lower_confidence', confidence_delta: 0.3, confidence: 0.5, justification: 'aging' },
    ]);
    const out = validateCuratorResponse(raw, CANDIDATES);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ verdict: 'lower_confidence', confidence_delta: 0.3 });
  });

  it('DROPS lower_confidence without a positive delta (nothing to lower)', () => {
    const raw = JSON.stringify([
      { learning_id: 3, verdict: 'lower_confidence', confidence_delta: 0, confidence: 0.5, justification: 'x' },
    ]);
    expect(validateCuratorResponse(raw, CANDIDATES)).toHaveLength(0);
  });

  it('CITE-CHECK drops a hallucinated id not in the candidate set', () => {
    const raw = JSON.stringify([{ learning_id: 999, verdict: 'prune', confidence: 0.7, justification: 'x' }]);
    expect(validateCuratorResponse(raw, CANDIDATES)).toHaveLength(0);
  });

  it('drops an invalid verdict', () => {
    const raw = JSON.stringify([{ learning_id: 1, verdict: 'delete_now', confidence: 0.7, justification: 'x' }]);
    expect(validateCuratorResponse(raw, CANDIDATES)).toHaveLength(0);
  });

  it('CLAMPS confidence above 0.85', () => {
    const raw = JSON.stringify([{ learning_id: 1, verdict: 'prune', confidence: 0.99, justification: 'x' }]);
    const out = validateCuratorResponse(raw, CANDIDATES);
    expect(out[0].confidence).toBe(CURATOR_CONFIDENCE_CAP);
  });

  it('clamps a delta above 1', () => {
    const raw = JSON.stringify([
      { learning_id: 1, verdict: 'lower_confidence', confidence_delta: 5, confidence: 0.5, justification: 'x' },
    ]);
    const out = validateCuratorResponse(raw, CANDIDATES);
    expect(out[0].confidence_delta).toBe(1);
  });

  it('returns [] on a non-array response', () => {
    expect(validateCuratorResponse('not json', CANDIDATES)).toEqual([]);
    expect(validateCuratorResponse('{"learning_id":1}', CANDIDATES)).toEqual([]);
  });

  it('parses a fenced ```json array', () => {
    const raw = '```json\n[{"learning_id":1,"verdict":"keep","confidence":0.5,"justification":"ok"}]\n```';
    expect(validateCuratorResponse(raw, CANDIDATES)).toHaveLength(1);
  });
});

describe('isCuratorResponseWellFormed (TD-294)', () => {
  it('a well-formed empty array is well-formed (valid-empty judgment)', () => {
    expect(isCuratorResponseWellFormed('[]')).toBe(true);
  });

  it('a well-formed array whose elements are all dropped is still well-formed', () => {
    expect(isCuratorResponseWellFormed('[{}]')).toBe(true);
  });

  it('non-JSON text is malformed', () => {
    expect(isCuratorResponseWellFormed('not json')).toBe(false);
  });

  it('a blank/whitespace-only response is malformed', () => {
    expect(isCuratorResponseWellFormed('   ')).toBe(false);
  });
});
