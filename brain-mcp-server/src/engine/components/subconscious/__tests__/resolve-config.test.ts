/**
 * resolve-config.test.ts — FR-191 subconscious config resolution.
 *
 * `resolveSubconsciousConfig` reads `cognition.subconscious` NESTED-ONLY.
 * FR-191 dropped the legacy top-level `subconscious` fallback (no installs to
 * migrate). These tests pin the nested-only contract:
 *   - nested enabled=true wins
 *   - nested absent → typed default (OFF)
 *   - a config carrying ONLY the legacy top-level block resolves to the typed
 *     default (proving the fallback is gone)
 *
 * No mocks (L-159): the resolver takes the parsed config as an argument, so we
 * pass plain objects directly.
 */

import { describe, it, expect } from 'vitest';
import { resolveSubconsciousConfig } from '../index.js';
import { DEFAULT_SUBCONSCIOUS_CONFIG } from '../types.js';

describe('resolveSubconsciousConfig — nested-only (FR-191)', () => {
  it('reads enabled from cognition.subconscious (nested wins)', () => {
    const cfg = resolveSubconsciousConfig({
      cognition: { subconscious: { enabled: true } },
    });
    expect(cfg.enabled).toBe(true);
  });

  it('resolves OFF from cognition.subconscious.enabled=false', () => {
    const cfg = resolveSubconsciousConfig({
      cognition: { subconscious: { enabled: false } },
    });
    expect(cfg.enabled).toBe(false);
  });

  it('falls back to the typed default (OFF) when cognition is absent', () => {
    const cfg = resolveSubconsciousConfig({});
    expect(cfg.enabled).toBe(DEFAULT_SUBCONSCIOUS_CONFIG.enabled);
    expect(cfg.enabled).toBe(false);
  });

  it('IGNORES a legacy top-level subconscious block (fallback dropped)', () => {
    // The legacy top-level key, even set to true, must NOT flip the resolver —
    // the nested path is the sole source under FR-191.
    const cfg = resolveSubconsciousConfig({ subconscious: { enabled: true } });
    expect(cfg.enabled).toBe(DEFAULT_SUBCONSCIOUS_CONFIG.enabled);
    expect(cfg.enabled).toBe(false);
  });

  it('merges nested tuning keys, defaulting the rest', () => {
    const cfg = resolveSubconsciousConfig({
      cognition: { subconscious: { enabled: true, llm_daily_budget: 3 } },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.llm_daily_budget).toBe(3);
    expect(cfg.llm_timeout_ms).toBe(DEFAULT_SUBCONSCIOUS_CONFIG.llm_timeout_ms);
  });
});
