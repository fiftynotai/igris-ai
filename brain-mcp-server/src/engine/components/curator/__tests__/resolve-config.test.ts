/**
 * Curator config-resolution tests (FR-116 M3).
 *
 * `resolveCuratorConfig` reads `cognition.janitor.pruning` NESTED-ONLY for the
 * tuning knobs, and DERIVES `enabled` from `cognition.janitor.enabled`
 * (Decision #4A — one flag, no new enabled flag). Pins off-by-default +
 * auto_prune-off-by-default + the shared-gate contract.
 *
 * No mocks (L-159): the resolver takes the parsed config as an argument.
 *
 * @module engine/components/curator/__tests__/resolve-config.test
 */

import { describe, it, expect } from 'vitest';
import { resolveCuratorConfig, DEFAULT_CURATOR_CONFIG } from '../types.js';

describe('resolveCuratorConfig — nested-only + janitor-gated (FR-116 M3)', () => {
  it('is OFF by default when cognition is absent', () => {
    const cfg = resolveCuratorConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.enabled).toBe(DEFAULT_CURATOR_CONFIG.enabled);
  });

  it('DERIVES enabled from cognition.janitor.enabled (no separate curator flag)', () => {
    const on = resolveCuratorConfig({ cognition: { janitor: { enabled: true } } });
    expect(on.enabled).toBe(true);
    const off = resolveCuratorConfig({ cognition: { janitor: { enabled: false } } });
    expect(off.enabled).toBe(false);
  });

  it('reads the pruning sub-block tuning knobs, defaulting the rest', () => {
    const cfg = resolveCuratorConfig({
      cognition: {
        janitor: {
          enabled: true,
          pruning: {
            stale_months: 12,
            max_access_count: 2,
            deprecated_tags: ['angularjs', 'coffeescript'],
            auto_prune: true,
            anomaly_threshold: 10,
          },
        },
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.stale_months).toBe(12);
    expect(cfg.max_access_count).toBe(2);
    expect(cfg.deprecated_tags).toEqual(['angularjs', 'coffeescript']);
    expect(cfg.auto_prune).toBe(true);
    expect(cfg.anomaly_threshold).toBe(10);
    expect(cfg.max_candidates).toBe(DEFAULT_CURATOR_CONFIG.max_candidates);
  });

  it('defaults auto_prune to false (review-gated — pruning is destructive)', () => {
    const cfg = resolveCuratorConfig({ cognition: { janitor: { enabled: true } } });
    expect(cfg.auto_prune).toBe(false);
    expect(cfg.stale_months).toBe(6);
    expect(cfg.max_access_count).toBe(0);
    expect(cfg.anomaly_threshold).toBe(50);
  });

  it('IGNORES a pruning block outside the janitor namespace', () => {
    const cfg = resolveCuratorConfig({ cognition: { pruning: { stale_months: 1 } } });
    expect(cfg.stale_months).toBe(DEFAULT_CURATOR_CONFIG.stale_months);
  });
});
