/**
 * Janitor config-resolution tests (FR-119).
 *
 * `resolveJanitorConfig` reads `cognition.janitor` NESTED-ONLY (mirrors
 * `resolveSynapseConfig`). Pins the nested-only contract + off-by-default.
 *
 * No mocks (L-159): the resolver takes the parsed config as an argument.
 *
 * @module engine/components/janitor/__tests__/resolve-config.test
 */

import { describe, it, expect } from 'vitest';
import { resolveJanitorConfig } from '../index.js';
import { DEFAULT_JANITOR_CONFIG } from '../types.js';

describe('resolveJanitorConfig — nested-only (FR-119)', () => {
  it('reads enabled from cognition.janitor (nested wins)', () => {
    const cfg = resolveJanitorConfig({ cognition: { janitor: { enabled: true } } });
    expect(cfg.enabled).toBe(true);
  });

  it('is OFF by default when cognition is absent', () => {
    const cfg = resolveJanitorConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.enabled).toBe(DEFAULT_JANITOR_CONFIG.enabled);
  });

  it('IGNORES a legacy top-level janitor block (no fallback)', () => {
    const cfg = resolveJanitorConfig({ janitor: { enabled: true } });
    expect(cfg.enabled).toBe(false);
  });

  it('merges the hygiene + candidate knobs, defaulting the rest', () => {
    const cfg = resolveJanitorConfig({
      cognition: {
        janitor: { enabled: true, dupe_cosine_floor: 0.9, stale_days: 30, auto_merge: true },
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.dupe_cosine_floor).toBe(0.9);
    expect(cfg.stale_days).toBe(30);
    expect(cfg.auto_merge).toBe(true);
    expect(cfg.rediscovery_bump_n).toBe(DEFAULT_JANITOR_CONFIG.rediscovery_bump_n);
    expect(cfg.llm_timeout_ms).toBe(DEFAULT_JANITOR_CONFIG.llm_timeout_ms);
  });

  it('defaults auto_merge to false (Decision B — always review-gated)', () => {
    const cfg = resolveJanitorConfig({ cognition: { janitor: { enabled: true } } });
    expect(cfg.auto_merge).toBe(false);
    expect(cfg.dupe_cosine_floor).toBe(0.95);
  });
});
