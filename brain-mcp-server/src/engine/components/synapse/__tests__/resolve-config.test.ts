/**
 * Synapse config-resolution tests (FR-211).
 *
 * `resolveSynapseConfig` reads `cognition.synapse` NESTED-ONLY (mirrors
 * `resolveSubconsciousConfig`). Pins the nested-only contract + off-by-default.
 *
 * No mocks (L-159): the resolver takes the parsed config as an argument.
 *
 * @module engine/components/synapse/__tests__/resolve-config.test
 */

import { describe, it, expect } from 'vitest';
import { resolveSynapseConfig } from '../index.js';
import { DEFAULT_SYNAPSE_CONFIG } from '../types.js';

describe('resolveSynapseConfig — nested-only (FR-211)', () => {
  it('reads enabled from cognition.synapse (nested wins)', () => {
    const cfg = resolveSynapseConfig({ cognition: { synapse: { enabled: true } } });
    expect(cfg.enabled).toBe(true);
  });

  it('is OFF by default when cognition is absent', () => {
    const cfg = resolveSynapseConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.enabled).toBe(DEFAULT_SYNAPSE_CONFIG.enabled);
  });

  it('IGNORES a legacy top-level synapse block (no fallback)', () => {
    const cfg = resolveSynapseConfig({ synapse: { enabled: true } });
    expect(cfg.enabled).toBe(false);
  });

  it('merges the candidate knobs, defaulting the rest', () => {
    const cfg = resolveSynapseConfig({
      cognition: { synapse: { enabled: true, cosine_floor: 0.9, max_pairs: 50, auto_approve: true } },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.cosine_floor).toBe(0.9);
    expect(cfg.max_pairs).toBe(50);
    expect(cfg.auto_approve).toBe(true);
    expect(cfg.top_k).toBe(DEFAULT_SYNAPSE_CONFIG.top_k);
    expect(cfg.llm_timeout_ms).toBe(DEFAULT_SYNAPSE_CONFIG.llm_timeout_ms);
  });

  it('defaults auto_approve to false (D5 — always review-gated)', () => {
    const cfg = resolveSynapseConfig({ cognition: { synapse: { enabled: true } } });
    expect(cfg.auto_approve).toBe(false);
  });
});
