/**
 * Perception index — config resolution tests (TD-066).
 *
 * Exercises `resolvePerceptionConfig` env-var layer:
 *   - IGRIS_PERCEPTION_LLM_ENABLED   ('1'|'0')
 *   - IGRIS_PERCEPTION_AUTO_APPROVE  ('1'|'0')
 *   - IGRIS_PERCEPTION_LLM_TIMEOUT_MS
 *
 * @module engine/components/perception/__tests__/index.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolvePerceptionConfig } from '../index.js';
import { DEFAULT_PERCEPTION_CONFIG } from '../types.js';

const ENV_KEYS = [
  'IGRIS_PERCEPTION_LLM_ENABLED',
  'IGRIS_PERCEPTION_AUTO_APPROVE',
  'IGRIS_PERCEPTION_LLM_TIMEOUT_MS',
] as const;

describe('resolvePerceptionConfig', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = {};
    for (const k of ENV_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = snapshot[k];
      }
    }
  });

  it('returns defaults when no env vars set and no config file overrides', () => {
    const cfg = resolvePerceptionConfig();
    // TD-066 default flips: LLM enabled by default; auto-approve OFF by default.
    expect(cfg.extractor_llm_enabled).toBe(DEFAULT_PERCEPTION_CONFIG.extractor_llm_enabled);
    expect(cfg.auto_approve_enabled).toBe(DEFAULT_PERCEPTION_CONFIG.auto_approve_enabled);
    expect(cfg.extractor_llm_enabled).toBe(true);
    expect(cfg.auto_approve_enabled).toBe(false);
  });

  it('default llm_timeout_ms is 300_000 (TD-079)', () => {
    // Lock the constant directly so a future bump cannot silently regress.
    expect(DEFAULT_PERCEPTION_CONFIG.llm_timeout_ms).toBe(300_000);
    // And verify the resolved config picks it up when no override is set.
    const cfg = resolvePerceptionConfig();
    expect(cfg.llm_timeout_ms).toBe(300_000);
  });

  it('IGRIS_PERCEPTION_LLM_ENABLED=0 disables the LLM extractor', () => {
    process.env.IGRIS_PERCEPTION_LLM_ENABLED = '0';
    const cfg = resolvePerceptionConfig();
    expect(cfg.extractor_llm_enabled).toBe(false);
  });

  it('IGRIS_PERCEPTION_LLM_ENABLED=1 enables the LLM extractor', () => {
    process.env.IGRIS_PERCEPTION_LLM_ENABLED = '1';
    const cfg = resolvePerceptionConfig();
    expect(cfg.extractor_llm_enabled).toBe(true);
  });

  it('IGRIS_PERCEPTION_AUTO_APPROVE=1 enables auto-approve', () => {
    process.env.IGRIS_PERCEPTION_AUTO_APPROVE = '1';
    const cfg = resolvePerceptionConfig();
    expect(cfg.auto_approve_enabled).toBe(true);
  });

  it('IGRIS_PERCEPTION_AUTO_APPROVE=0 disables auto-approve', () => {
    process.env.IGRIS_PERCEPTION_AUTO_APPROVE = '0';
    const cfg = resolvePerceptionConfig();
    expect(cfg.auto_approve_enabled).toBe(false);
  });

  it('IGRIS_PERCEPTION_LLM_TIMEOUT_MS overrides timeout', () => {
    process.env.IGRIS_PERCEPTION_LLM_TIMEOUT_MS = '12345';
    const cfg = resolvePerceptionConfig();
    expect(cfg.llm_timeout_ms).toBe(12345);
  });

  it('ignores invalid timeout values', () => {
    process.env.IGRIS_PERCEPTION_LLM_TIMEOUT_MS = 'not-a-number';
    const cfg = resolvePerceptionConfig();
    expect(cfg.llm_timeout_ms).toBe(DEFAULT_PERCEPTION_CONFIG.llm_timeout_ms);
  });
});
