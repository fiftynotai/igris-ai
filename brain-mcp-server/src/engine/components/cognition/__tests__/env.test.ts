/**
 * Cognition backend env + harness-selection tests (FR-118 M0).
 *
 * Covers:
 *   - subscriptionOnlyEnv strips ANTHROPIC_API_KEY / OPENAI_API_KEY (fresh env)
 *   - resolveHarness: ALL 4 layers (default → global → per-instance → env)
 *   - env precedence: per-instance env beats global env
 *   - invalid harness at a layer is ignored (the lower layer stands)
 *   - resolveBackend: chosen harness tried first; cli-absent → fallback_order;
 *     none present → harness:null (cli_missing)
 *
 * @module engine/components/cognition/__tests__/env.test
 */

import { describe, it, expect } from 'vitest';
import {
  subscriptionOnlyEnv,
  resolveHarness,
  resolveBackend,
  type LlmExtractorGlobalConfig,
} from '../backend/env.js';
import type { ExtractorHarness } from '../types.js';

describe('subscriptionOnlyEnv', () => {
  it('strips both metered API keys and never mutates base', () => {
    const base = {
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-oai',
      PATH: '/usr/bin',
    } as NodeJS.ProcessEnv;
    const out = subscriptionOnlyEnv(base, { HOME: '/iso' });
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/iso');
    // base untouched
    expect(base.ANTHROPIC_API_KEY).toBe('sk-ant');
  });
});

describe('resolveHarness — the 4-layer chain', () => {
  const noEnv: NodeJS.ProcessEnv = {};

  it('Layer 1: default is claude', () => {
    expect(resolveHarness({}, 'perception', null, noEnv)).toBe('claude');
  });

  it('Layer 2: global config overrides the default', () => {
    const g: LlmExtractorGlobalConfig = { harness: 'gemini' };
    expect(resolveHarness(g, 'perception', null, noEnv)).toBe('gemini');
  });

  it('Layer 3: per-instance config overrides global (null inherits)', () => {
    const g: LlmExtractorGlobalConfig = { harness: 'gemini' };
    expect(resolveHarness(g, 'subconscious', 'codex', noEnv)).toBe('codex');
    // null = inherit the global
    expect(resolveHarness(g, 'subconscious', null, noEnv)).toBe('gemini');
  });

  it('Layer 4a: global env var overrides config', () => {
    const g: LlmExtractorGlobalConfig = { harness: 'gemini' };
    const env = { IGRIS_LLM_EXTRACTOR_HARNESS: 'opencode' } as NodeJS.ProcessEnv;
    expect(resolveHarness(g, 'subconscious', 'codex', env)).toBe('opencode');
  });

  it('Layer 4b: per-instance env beats the global env (highest precedence)', () => {
    const g: LlmExtractorGlobalConfig = { harness: 'gemini' };
    const env = {
      IGRIS_LLM_EXTRACTOR_HARNESS: 'opencode',
      IGRIS_SUBCONSCIOUS_HARNESS: 'antigravity',
    } as NodeJS.ProcessEnv;
    expect(resolveHarness(g, 'subconscious', 'codex', env)).toBe('antigravity');
    // a different instance is NOT affected by IGRIS_SUBCONSCIOUS_HARNESS
    expect(resolveHarness(g, 'perception', 'codex', env)).toBe('opencode');
  });

  it('ignores an invalid harness at any layer (lower layer stands)', () => {
    const g = { harness: 'bogus' as ExtractorHarness };
    const env = { IGRIS_LLM_EXTRACTOR_HARNESS: 'also-bogus' } as NodeJS.ProcessEnv;
    // global invalid → falls back to default claude; per-instance valid wins
    expect(resolveHarness(g, 'perception', 'codex', env)).toBe('codex');
    // everything invalid → default
    expect(resolveHarness(g, 'perception', null, env)).toBe('claude');
  });
});

describe('resolveBackend — availability + fallback_order', () => {
  const noEnv: NodeJS.ProcessEnv = {};

  it('returns the chosen harness when it is available, tried first', () => {
    const present = new Set<ExtractorHarness>(['claude', 'gemini']);
    const b = resolveBackend(
      { harness: 'gemini' },
      'perception',
      null,
      noEnv,
      (h) => present.has(h),
    );
    expect(b.harness).toBe('gemini');
    expect(b.fallback_order[0]).toBe('gemini'); // chosen first
  });

  it('walks the fallback order when the chosen harness is absent', () => {
    // chosen = codex (absent); fallback order claude→gemini, claude present
    const present = new Set<ExtractorHarness>(['claude']);
    const b = resolveBackend(
      { harness: 'codex', fallback_order: ['claude', 'gemini'] },
      'subconscious',
      null,
      noEnv,
      (h) => present.has(h),
    );
    expect(b.harness).toBe('claude');
    // codex (chosen) tried first, then the configured fallback
    expect(b.fallback_order[0]).toBe('codex');
    expect(b.fallback_order).toContain('claude');
  });

  it('returns harness:null when NONE of the fallback order is present (cli_missing)', () => {
    const b = resolveBackend(
      { harness: 'claude' },
      'perception',
      null,
      noEnv,
      () => false, // no CLI present at all
    );
    expect(b.harness).toBeNull();
    // the order tried is recorded for observability
    expect(b.fallback_order.length).toBeGreaterThan(0);
    expect(b.fallback_order[0]).toBe('claude');
  });
});
