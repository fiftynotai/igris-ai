/**
 * Arbiter config-resolution tests (FR-116 M2).
 *
 * `resolveArbiterConfig` reads `cognition.janitor.contradiction` NESTED-ONLY for
 * the tuning knobs, and DERIVES `enabled` from `cognition.janitor.enabled`
 * (Decision #4A — one flag, no new enabled flag). Pins off-by-default + the
 * shared-gate contract.
 *
 * No mocks (L-159): the resolver takes the parsed config as an argument.
 *
 * @module engine/components/arbiter/__tests__/resolve-config.test
 */

import { describe, it, expect } from 'vitest';
import { resolveArbiterConfig, DEFAULT_ARBITER_CONFIG } from '../types.js';

describe('resolveArbiterConfig — nested-only + janitor-gated (FR-116 M2)', () => {
  it('is OFF by default when cognition is absent', () => {
    const cfg = resolveArbiterConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.enabled).toBe(DEFAULT_ARBITER_CONFIG.enabled);
  });

  it('DERIVES enabled from cognition.janitor.enabled (no separate arbiter flag)', () => {
    const on = resolveArbiterConfig({ cognition: { janitor: { enabled: true } } });
    expect(on.enabled).toBe(true);
    const off = resolveArbiterConfig({ cognition: { janitor: { enabled: false } } });
    expect(off.enabled).toBe(false);
  });

  it('reads the contradiction sub-block tuning knobs, defaulting the rest', () => {
    const cfg = resolveArbiterConfig({
      cognition: {
        janitor: {
          enabled: true,
          contradiction: {
            contradiction_cosine_floor: 0.75,
            contradiction_cosine_ceil: 0.99,
            max_pairs: 50,
            auto_resolve: true,
          },
        },
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.contradiction_cosine_floor).toBe(0.75);
    expect(cfg.contradiction_cosine_ceil).toBe(0.99);
    expect(cfg.max_pairs).toBe(50);
    expect(cfg.auto_resolve).toBe(true);
    expect(cfg.top_k).toBe(DEFAULT_ARBITER_CONFIG.top_k);
    expect(cfg.auto_resolve_threshold).toBe(DEFAULT_ARBITER_CONFIG.auto_resolve_threshold);
  });

  it('defaults auto_resolve to false (review-gated — supersede is destructive)', () => {
    const cfg = resolveArbiterConfig({ cognition: { janitor: { enabled: true } } });
    expect(cfg.auto_resolve).toBe(false);
    expect(cfg.contradiction_cosine_floor).toBe(0.8);
    expect(cfg.contradiction_cosine_ceil).toBe(0.995);
  });

  it('IGNORES a contradiction block outside the janitor namespace', () => {
    const cfg = resolveArbiterConfig({ cognition: { contradiction: { max_pairs: 5 } } });
    expect(cfg.max_pairs).toBe(DEFAULT_ARBITER_CONFIG.max_pairs);
  });
});
