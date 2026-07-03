/**
 * Synapse validator tests (FR-211).
 *
 * Covers `validateSynapseResponse`: cite-check against the candidate pair set,
 * edge_type allow-list (incl. dropping the "none" verdict), confidence cap,
 * direction preservation, fenced-JSON tolerance, and clean rejection of
 * malformed input (→ []).
 *
 * @module engine/components/synapse/__tests__/validator.test
 */

import { describe, it, expect } from 'vitest';
import {
  validateSynapseResponse,
  isSynapseResponseWellFormed,
  SYNAPSE_CONFIDENCE_CAP,
} from '../validator.js';
import type { CandidatePair } from '../types.js';

function pair(from_id: number, to_id: number): CandidatePair {
  return {
    from_id,
    to_id,
    from_title: `L${from_id}`,
    from_snippet: 's',
    to_title: `L${to_id}`,
    to_snippet: 's',
    signal: 'cosine',
  };
}

const PAIRS: CandidatePair[] = [pair(1, 2), pair(3, 7)];

describe('validateSynapseResponse', () => {
  it('accepts a valid proposal citing a candidate pair', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 2, edge_type: 'related_to', confidence: 0.7, justification: 'linked' },
    ]);
    const out = validateSynapseResponse(raw, PAIRS);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      from_id: 1,
      to_id: 2,
      edge_type: 'related_to',
      confidence: 0.7,
      justification: 'linked',
    });
  });

  it('preserves the LLM direction (flipped from/to still cite-checks)', () => {
    const raw = JSON.stringify([
      { from_id: 2, to_id: 1, edge_type: 'supersedes', confidence: 0.6, justification: 'newer' },
    ]);
    const out = validateSynapseResponse(raw, PAIRS);
    expect(out).toHaveLength(1);
    expect(out[0].from_id).toBe(2);
    expect(out[0].to_id).toBe(1);
  });

  it('REJECTS a pair not in the candidate set (hallucination guard)', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 3, edge_type: 'related_to', confidence: 0.7 }, // 1↔3 not a candidate
    ]);
    expect(validateSynapseResponse(raw, PAIRS)).toHaveLength(0);
  });

  it('drops an invalid edge_type and the "none" verdict', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 2, edge_type: 'none', confidence: 0.5 },
      { from_id: 3, to_id: 7, edge_type: 'blocks', confidence: 0.5 }, // valid edge but not in synapse subset
    ]);
    expect(validateSynapseResponse(raw, PAIRS)).toHaveLength(0);
  });

  it('caps confidence at 0.85 and floors at 0', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 2, edge_type: 'duplicates', confidence: 0.99 },
      { from_id: 3, to_id: 7, edge_type: 'related_to', confidence: -1 },
    ]);
    const out = validateSynapseResponse(raw, PAIRS);
    expect(out.find((p) => p.from_id === 1)?.confidence).toBe(SYNAPSE_CONFIDENCE_CAP);
    expect(out.find((p) => p.from_id === 3)?.confidence).toBe(0);
  });

  it('tolerates a ```json fenced array', () => {
    const raw = '```json\n[{"from_id":1,"to_id":2,"edge_type":"related_to","confidence":0.5}]\n```';
    expect(validateSynapseResponse(raw, PAIRS)).toHaveLength(1);
  });

  it('returns [] for non-array / malformed input', () => {
    expect(validateSynapseResponse('not json', PAIRS)).toEqual([]);
    expect(validateSynapseResponse('{"from_id":1}', PAIRS)).toEqual([]);
    expect(validateSynapseResponse('', PAIRS)).toEqual([]);
  });

  it('drops self-loops and non-integer ids', () => {
    const raw = JSON.stringify([
      { from_id: 1, to_id: 1, edge_type: 'related_to', confidence: 0.5 },
      { from_id: 'x', to_id: 2, edge_type: 'related_to', confidence: 0.5 },
    ]);
    expect(validateSynapseResponse(raw, PAIRS)).toHaveLength(0);
  });
});

describe('isSynapseResponseWellFormed (TD-294)', () => {
  it('a well-formed empty array is well-formed (valid-empty judgment)', () => {
    expect(isSynapseResponseWellFormed('[]')).toBe(true);
  });

  it('a well-formed array whose elements are all dropped is still well-formed', () => {
    expect(isSynapseResponseWellFormed('[{}]')).toBe(true);
  });

  it('non-JSON text is malformed', () => {
    expect(isSynapseResponseWellFormed('not json')).toBe(false);
  });

  it('a blank/whitespace-only response is malformed', () => {
    expect(isSynapseResponseWellFormed('   ')).toBe(false);
  });
});
