/**
 * Arbiter extensibility proof (FR-116 M2 — the zero-host-change property).
 *
 * The arbiter was added as a FIFTH cognition instance with NO edit to the
 * agnostic host. This test evidences that:
 *   1. `discoverInstances` surfaces `arbiter` from the extractors barrel
 *      alongside the other four (the one-line registration);
 *   2. the arbiter instance fills the full `CognitionInstance` contract;
 *   3. the engine (`cognition/engine/index.ts`) + registry (`cognition/
 *      registry.ts`) carry NO reference to `arbiter` — it rides `runExtractor`
 *      unchanged; the host never branches on instance identity.
 *
 * @module engine/components/arbiter/__tests__/extensibility.test
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCognitionRegistry, discoverInstances } from '../../cognition/registry.js';

const COGNITION_DIR = resolve(import.meta.dirname, '../../cognition');

describe('FR-116 M2 extensibility — arbiter rides the host with zero engine change', () => {
  it('discoverInstances surfaces arbiter from the barrel (with the other four)', () => {
    const r = createCognitionRegistry();
    discoverInstances(r);
    expect(r.has('arbiter')).toBe(true);
    expect(r.has('janitor')).toBe(true);
    expect(r.has('synapse')).toBe(true);
    expect(r.has('perception')).toBe(true);
    expect(r.has('subconscious')).toBe(true);
    expect(r.get('arbiter')?.id).toBe('arbiter');
  });

  it('the arbiter instance fills the full CognitionInstance contract', () => {
    const r = createCognitionRegistry();
    discoverInstances(r);
    const inst = r.get('arbiter')!;
    expect(typeof inst.buildContext).toBe('function');
    expect(typeof inst.promptBuilder).toBe('function');
    expect(typeof inst.parseResponse).toBe('function');
    expect(typeof inst.persistCandidate).toBe('function');
    expect(typeof inst.inputBytes).toBe('function');
    expect(inst.config).toMatchObject({
      timeout_ms: expect.any(Number),
      daily_budget: expect.any(Number),
      min_input_bytes: expect.any(Number),
      enabled: expect.any(Boolean),
    });
  });

  it('the engine + registry carry NO reference to arbiter (zero-host-change)', () => {
    const engineSrc = readFileSync(resolve(COGNITION_DIR, 'engine/index.ts'), 'utf-8');
    const registrySrc = readFileSync(resolve(COGNITION_DIR, 'registry.ts'), 'utf-8');
    expect(engineSrc.toLowerCase()).not.toContain('arbiter');
    expect(registrySrc.toLowerCase()).not.toContain('arbiter');
  });
});
