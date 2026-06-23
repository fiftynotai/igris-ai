/**
 * Cognition OPEN registry tests (FR-118 M0).
 *
 * Covers the open self-describing registry: register/get/all/ids/has/clear,
 * idempotent-by-id replacement, empty-id rejection, and discovery from the
 * extractors barrel (empty in M0).
 *
 * The end-to-end "engine runs a discovered instance with ZERO engine reference"
 * proof lives in engine.test.ts (the extensibility test).
 *
 * @module engine/components/cognition/__tests__/registry.test
 */

import { describe, it, expect } from 'vitest';
import { createCognitionRegistry, discoverInstances } from '../registry.js';
import type { CognitionInstance } from '../types.js';

function dummy(id: string): CognitionInstance {
  return {
    id,
    buildContext: async () => ({}),
    promptBuilder: () => ({ system: 's', user: 'u' }),
    parseResponse: () => [],
    persistCandidate: async () => {},
    config: { timeout_ms: 1000, daily_budget: 8, min_input_bytes: 0, enabled: true, harness: null },
  };
}

describe('createCognitionRegistry', () => {
  it('registers and looks up by id', () => {
    const r = createCognitionRegistry();
    const a = dummy('alpha');
    r.register(a);
    expect(r.get('alpha')).toBe(a);
    expect(r.has('alpha')).toBe(true);
    expect(r.ids()).toEqual(['alpha']);
    expect(r.all()).toEqual([a]);
  });

  it('is OPEN — accepts any id (no closed enum)', () => {
    const r = createCognitionRegistry();
    r.register(dummy('roadmap_drift'));
    r.register(dummy('some_future_extractor'));
    expect(r.ids()).toEqual(['roadmap_drift', 'some_future_extractor']);
  });

  it('is idempotent by id — re-register replaces and moves to the end', () => {
    const r = createCognitionRegistry();
    r.register(dummy('a'));
    r.register(dummy('b'));
    const a2 = dummy('a');
    r.register(a2);
    expect(r.get('a')).toBe(a2);
    expect(r.ids()).toEqual(['b', 'a']); // a moved to the end
  });

  it('REJECTS an empty / missing id', () => {
    const r = createCognitionRegistry();
    expect(() => r.register(dummy(''))).toThrow(/non-empty `id`/);
    expect(() => r.register({ ...dummy('x'), id: '   ' })).toThrow(/non-empty `id`/);
  });

  it('clear empties the registry', () => {
    const r = createCognitionRegistry();
    r.register(dummy('a'));
    r.clear();
    expect(r.all()).toEqual([]);
  });
});

describe('discoverInstances', () => {
  it('M0: the extractors barrel is empty (ships dormant)', () => {
    const r = createCognitionRegistry();
    discoverInstances(r);
    expect(r.all()).toEqual([]);
  });

  it('registers an injected instance list (the discovery contract)', () => {
    const r = createCognitionRegistry();
    const inst = dummy('discovered');
    discoverInstances(r, [inst]);
    expect(r.get('discovered')).toBe(inst);
  });
});
