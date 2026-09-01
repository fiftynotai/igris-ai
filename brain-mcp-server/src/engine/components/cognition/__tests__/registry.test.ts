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
    // TD-327: `health` is REQUIRED on the contract — an instance that cannot
    // say how an operator sees it stop cannot be registered. The dummy declares
    // the conventional `cognition.<id>` namespace; perception's LEGACY literals
    // are asserted separately in roster.test.ts.
    health: {
      component: `cognition.${id}`,
      event_prefix: `cognition.${id}`,
      gate_keys: [`cognition.${id}.enabled`],
      gate_default: false,
      driver: 'manual',
      driver_ref: null,
      output: 'nothing (test dummy)',
      produced: 'nothing (test dummy)',
    },
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
  it('M1: the extractors barrel exposes the perception instance', () => {
    // FR-118 M1 landed perception as the first real instance — the barrel is
    // no longer empty (the M0 "ships dormant / empty barrel" assertion was a
    // placeholder for the dormant host). Discovery registers it with ZERO
    // engine/registry edit (the FR-202 zero-host-change extensibility property).
    const r = createCognitionRegistry();
    discoverInstances(r);
    expect(r.has('perception')).toBe(true);
    expect(r.get('perception')?.id).toBe('perception');
  });

  it('registers an injected instance list (the discovery contract)', () => {
    const r = createCognitionRegistry();
    const inst = dummy('discovered');
    discoverInstances(r, [inst]);
    expect(r.get('discovered')).toBe(inst);
  });
});
