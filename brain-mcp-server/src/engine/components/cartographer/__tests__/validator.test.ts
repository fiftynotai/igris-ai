/**
 * Cartographer validator tests (FR-116 M4).
 *
 * Locks the parse + cite-check contract of `validateCartographerResponse`:
 *   - cite-check: an out-of-range cluster_index is dropped;
 *   - member ids are resolved from the CITED cluster, never from the model;
 *   - a blank summary is dropped; a blank title falls back to a generated one;
 *   - confidence is clamped to [0, 0.85];
 *   - a non-array response yields [] (never throws).
 *
 * @module engine/components/cartographer/__tests__/validator.test
 */

import { describe, it, expect } from 'vitest';
import { validateCartographerResponse, CARTOGRAPHER_CONFIDENCE_CAP } from '../validator.js';
import type { LearningCluster } from '../types.js';

const clusters: LearningCluster[] = [
  {
    cluster_index: 0,
    member_ids: [1, 2, 3],
    members: [
      { id: 1, title: 'a', snippet: 'a' },
      { id: 2, title: 'b', snippet: 'b' },
      { id: 3, title: 'c', snippet: 'c' },
    ],
  },
  {
    cluster_index: 1,
    member_ids: [4, 5, 6],
    members: [
      { id: 4, title: 'd', snippet: 'd' },
      { id: 5, title: 'e', snippet: 'e' },
      { id: 6, title: 'f', snippet: 'f' },
    ],
  },
];

describe('FR-116 M4 validateCartographerResponse', () => {
  it('resolves member ids from the cited cluster (not from the model)', () => {
    const raw = JSON.stringify([
      { cluster_index: 0, title: 'T', summary: 'shared theme', confidence: 0.7 },
    ]);
    const out = validateCartographerResponse(raw, clusters);
    expect(out).toHaveLength(1);
    expect(out[0].cluster_member_ids).toEqual([1, 2, 3]);
    expect(out[0].synthesized_summary).toBe('shared theme');
    expect(out[0].title).toBe('T');
  });

  it('drops proposals citing an out-of-range cluster_index', () => {
    const raw = JSON.stringify([{ cluster_index: 9, title: 'x', summary: 'y', confidence: 0.5 }]);
    expect(validateCartographerResponse(raw, clusters)).toEqual([]);
  });

  it('drops a proposal with a blank summary', () => {
    const raw = JSON.stringify([{ cluster_index: 0, title: 'x', summary: '   ', confidence: 0.5 }]);
    expect(validateCartographerResponse(raw, clusters)).toEqual([]);
  });

  it('falls back to a generated title when title is blank', () => {
    const raw = JSON.stringify([{ cluster_index: 1, title: '', summary: 'body', confidence: 0.5 }]);
    const out = validateCartographerResponse(raw, clusters);
    expect(out).toHaveLength(1);
    expect(out[0].title.length).toBeGreaterThan(0);
  });

  it('clamps confidence to [0, 0.85]', () => {
    const raw = JSON.stringify([{ cluster_index: 0, title: 'x', summary: 'y', confidence: 5 }]);
    const out = validateCartographerResponse(raw, clusters);
    expect(out[0].confidence).toBe(CARTOGRAPHER_CONFIDENCE_CAP);
  });

  it('returns [] for a non-array response (never throws)', () => {
    expect(validateCartographerResponse('not json', clusters)).toEqual([]);
    expect(validateCartographerResponse('{"a":1}', clusters)).toEqual([]);
  });

  it('parses a fenced ```json array', () => {
    const raw = '```json\n[{"cluster_index":0,"title":"t","summary":"s","confidence":0.6}]\n```';
    expect(validateCartographerResponse(raw, clusters)).toHaveLength(1);
  });
});
