/**
 * Synapse extensibility proof (FR-211 — AC #1, the zero-host-change property).
 *
 * Synapse was added as a THIRD cognition instance with NO edit to the agnostic
 * host. This test evidences that:
 *   1. `discoverInstances` surfaces `synapse` from the extractors barrel
 *      alongside perception + subconscious (the one-line registration proof);
 *   2. the synapse instance fills the full `CognitionInstance` contract;
 *   3. the engine (`cognition/engine/index.ts`) + registry (`cognition/
 *      registry.ts`) carry NO reference to `synapse` — i.e. the instance rides
 *      `runExtractor` unchanged; the host never branches on instance identity.
 *      (A source-level "byte-unchanged" proxy for the git-diff warden check.)
 *
 * @module engine/components/synapse/__tests__/extensibility.test
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCognitionRegistry, discoverInstances } from '../../cognition/registry.js';

const COGNITION_DIR = resolve(import.meta.dirname, '../../cognition');

describe('FR-211 extensibility — synapse rides the host with zero engine change', () => {
  it('discoverInstances surfaces synapse from the barrel (with perception + subconscious)', () => {
    const r = createCognitionRegistry();
    discoverInstances(r);
    expect(r.has('synapse')).toBe(true);
    expect(r.has('perception')).toBe(true);
    expect(r.has('subconscious')).toBe(true);
    expect(r.get('synapse')?.id).toBe('synapse');
  });

  it('the synapse instance fills the full CognitionInstance contract', () => {
    const r = createCognitionRegistry();
    discoverInstances(r);
    const inst = r.get('synapse')!;
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

  it('the engine + registry carry NO reference to synapse (zero-host-change)', () => {
    const engineSrc = readFileSync(resolve(COGNITION_DIR, 'engine/index.ts'), 'utf-8');
    const registrySrc = readFileSync(resolve(COGNITION_DIR, 'registry.ts'), 'utf-8');
    expect(engineSrc.toLowerCase()).not.toContain('synapse');
    expect(registrySrc.toLowerCase()).not.toContain('synapse');
  });
});
