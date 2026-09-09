/**
 * FR-237 — composite node key round-trip tests.
 *
 * The escape is load-bearing: `graph_nodes.node_external_id` is free-form
 * operator input, so a naive `split('|')` parser would pass every happy-path
 * case and silently mis-parse an id containing a literal separator. Tests 3
 * and 4 exist solely to kill that implementation.
 *
 * @module engine/components/edges/__tests__/graph-keys.test
 */

import { describe, it, expect } from 'vitest';
import { encodeNodeKey, parseNodeKey, type NodeKeyParts } from '../graph-keys.js';

function roundTrip(parts: NodeKeyParts): NodeKeyParts {
  return parseNodeKey(encodeNodeKey(parts));
}

describe('graph-keys (FR-237)', () => {
  it('round-trips a plain triple', () => {
    const parts: NodeKeyParts = { type: 'brief', project: 'igris-ai', id: 'FR-237' };
    expect(encodeNodeKey(parts)).toBe('brief|igris-ai|FR-237');
    expect(roundTrip(parts)).toEqual(parts);
  });

  it('round-trips a null project as an empty middle segment', () => {
    const parts: NodeKeyParts = { type: 'goal', project: null, id: 'GL-004' };
    expect(encodeNodeKey(parts)).toBe('goal||GL-004');
    expect(roundTrip(parts)).toEqual(parts);
  });

  it('round-trips a literal | inside the id (kills a naive split parser)', () => {
    const parts: NodeKeyParts = { type: 'concept', project: 'p', id: 'concept:a|b' };
    const key = encodeNodeKey(parts);
    expect(key).toBe('concept|p|concept:a\\|b');
    // A naive `key.split('|')` yields 4 segments and reads the project as 'p'
    // but the id as 'concept:a' — silently wrong. The escape-aware parser must
    // return the id verbatim.
    expect(roundTrip(parts)).toEqual(parts);
    expect(roundTrip(parts).id).toBe('concept:a|b');
  });

  it('round-trips a literal backslash inside the id', () => {
    const parts: NodeKeyParts = { type: 'concept', project: 'p', id: 'a\\b' };
    expect(encodeNodeKey(parts)).toBe('concept|p|a\\\\b');
    expect(roundTrip(parts)).toEqual(parts);
  });

  it('round-trips a backslash immediately before a separator', () => {
    // The pathological pair: an id ending in `\` followed by a `|`. Escaping
    // backslashes BEFORE separators is what keeps this unambiguous.
    const parts: NodeKeyParts = { type: 'concept', project: 'p', id: 'a\\|b' };
    expect(roundTrip(parts)).toEqual(parts);
  });

  it('round-trips a | inside the project slug', () => {
    const parts: NodeKeyParts = { type: 'brief', project: 'we|ird', id: 'BR-001' };
    expect(roundTrip(parts)).toEqual(parts);
  });

  it('gives two same-id briefs in different projects DIFFERENT keys', () => {
    const a = encodeNodeKey({ type: 'brief', project: 'proj-a', id: 'BR-001' });
    const b = encodeNodeKey({ type: 'brief', project: 'proj-b', id: 'BR-001' });
    expect(a).not.toBe(b);
    expect(a).toBe('brief|proj-a|BR-001');
    expect(b).toBe('brief|proj-b|BR-001');
    expect(parseNodeKey(a).project).toBe('proj-a');
    expect(parseNodeKey(b).project).toBe('proj-b');
  });

  it('is a total function on malformed input (never throws)', () => {
    expect(() => parseNodeKey('')).not.toThrow();
    expect(() => parseNodeKey('brief')).not.toThrow();
    expect(() => parseNodeKey('brief|p')).not.toThrow();
    expect(() => parseNodeKey('trailing-escape\\')).not.toThrow();
    expect(parseNodeKey('brief')).toEqual({ type: 'brief', project: null, id: '' });
  });
});
