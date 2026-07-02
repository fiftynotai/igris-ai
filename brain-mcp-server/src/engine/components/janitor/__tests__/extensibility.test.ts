/**
 * Janitor extensibility proof (FR-119 — AC #1, the zero-host-change property).
 *
 * Janitor was added as a FOURTH cognition instance with NO edit to the agnostic
 * host. This test evidences that:
 *   1. `discoverInstances` surfaces `janitor` from the extractors barrel
 *      alongside perception + subconscious + synapse (the one-line registration);
 *   2. the janitor instance fills the full `CognitionInstance` contract;
 *   3. the engine (`cognition/engine/index.ts`) + registry (`cognition/
 *      registry.ts`) carry NO reference to `janitor` — i.e. the instance rides
 *      `runExtractor` unchanged; the host never branches on instance identity.
 *
 * @module engine/components/janitor/__tests__/extensibility.test
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCognitionRegistry, discoverInstances } from '../../cognition/registry.js';

const COGNITION_DIR = resolve(import.meta.dirname, '../../cognition');

describe('FR-119 extensibility — janitor rides the host with zero engine change', () => {
  it('discoverInstances surfaces janitor from the barrel (with the other three)', () => {
    const r = createCognitionRegistry();
    discoverInstances(r);
    expect(r.has('janitor')).toBe(true);
    expect(r.has('synapse')).toBe(true);
    expect(r.has('perception')).toBe(true);
    expect(r.has('subconscious')).toBe(true);
    expect(r.get('janitor')?.id).toBe('janitor');
  });

  it('the janitor instance fills the full CognitionInstance contract', () => {
    const r = createCognitionRegistry();
    discoverInstances(r);
    const inst = r.get('janitor')!;
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

  it('the engine + registry carry NO reference to janitor (zero-host-change)', () => {
    const engineSrc = readFileSync(resolve(COGNITION_DIR, 'engine/index.ts'), 'utf-8');
    const registrySrc = readFileSync(resolve(COGNITION_DIR, 'registry.ts'), 'utf-8');
    expect(engineSrc.toLowerCase()).not.toContain('janitor');
    expect(registrySrc.toLowerCase()).not.toContain('janitor');
  });
});
