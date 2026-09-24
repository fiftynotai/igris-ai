/**
 * Cognition backend env + harness-selection tests (FR-118 M0).
 *
 * Covers:
 *   - subscriptionOnlyEnv strips ANTHROPIC_API_KEY / OPENAI_API_KEY (fresh env)
 *   - subscriptionOnlyEnv never lets a child INHERIT the harness namespace
 *     (`CLAUDE*` / `ANTHROPIC_*`), keeps every non-harness var, and lets an
 *     explicit `extra` injection survive (TD-471, E1–E6)
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
  it('drops both metered API keys (inherited or passed in extra) and never mutates base', () => {
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

// ---------------------------------------------------------------------------
// TD-471 — the inherited harness namespace never reaches a child
// ---------------------------------------------------------------------------

/**
 * The 24 desktop-host names the TD-471 probe found in the parent env (names from
 * `probe-run1.jsonl` arm A, 2026-09-24 12:22Z, one machine, values never read).
 * Fixture values are non-token-shaped literals.
 */
const PROBE_DESKTOP_NAMES = [
  'ANTHROPIC_BASE_URL',
  'CLAUDECODE',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_CODE_DISABLE_CRON',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_CODE_EAGER_FLUSH',
  'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_REPORT_FINDINGS',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDE_PREVIEW_CLASSIFIER_FLOOR',
] as const;

/** Non-harness vars the child legitimately needs (Keychain lookup is keyed by user; proxies; CA files). */
const KEEP_SET = [
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT',
] as const;

/**
 * Host-managed names read from the 2.1.281 bundle that were NOT in the probed env,
 * plus one synthetic future name — the denylist-rot guard (E4).
 */
const HOST_MANAGED_NOT_YET_SEEN = [
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_HOST_FUTURE_TD471',
] as const;

/** A fixture env: every listed name set to a non-token-shaped literal. */
function fixtureEnv(names: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const n of names) env[n] = 'td471-fixture';
  return env;
}

// D6: every assertion below is on KEY ARRAYS or on fixture literals, never
// `toHaveProperty` / `toEqual` over an env, so a red prints names, not values.
describe('subscriptionOnlyEnv — the inherited harness namespace never reaches a child (TD-471)', () => {
  it('E1: none of the 24 probed desktop-host names survive; the gate pair is gone', () => {
    const base: NodeJS.ProcessEnv = {
      ...fixtureEnv(PROBE_DESKTOP_NAMES),
      ...fixtureEnv(KEEP_SET),
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
    };
    const keys = Object.keys(subscriptionOnlyEnv(base, { HOME: '/iso' }));
    expect(keys.filter((k) => (PROBE_DESKTOP_NAMES as readonly string[]).includes(k))).toEqual([]);
    expect(keys.includes('CLAUDE_CODE_ENTRYPOINT')).toBe(false);
    expect(keys.includes('CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH')).toBe(false);
  });

  it('E2: every non-harness var passes through with its value unchanged (the over-strip guard)', () => {
    const base: NodeJS.ProcessEnv = {
      ...fixtureEnv(PROBE_DESKTOP_NAMES),
      ...Object.fromEntries(KEEP_SET.map((k) => [k, `td471-keep-${k}`])),
    };
    const out = subscriptionOnlyEnv(base, { HOME: '/iso' });
    expect(KEEP_SET.map((k) => [k, out[k]])).toEqual(KEEP_SET.map((k) => [k, `td471-keep-${k}`]));
    expect(out.HOME).toBe('/iso');
  });

  it('E3: ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are not inherited (D1)', () => {
    const keys = Object.keys(
      subscriptionOnlyEnv(fixtureEnv(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'PATH']), {}),
    );
    expect(keys.filter((k) => k.startsWith('ANTHROPIC_'))).toEqual([]);
    expect(keys).toContain('PATH');
  });

  it('E4: host-managed names absent from today\'s env, and a future one, are stripped too (denylist-rot guard)', () => {
    const keys = Object.keys(subscriptionOnlyEnv(fixtureEnv([...HOST_MANAGED_NOT_YET_SEEN, 'PATH']), {}));
    expect(keys.filter((k) => (HOST_MANAGED_NOT_YET_SEEN as readonly string[]).includes(k))).toEqual([]);
    expect(keys).toContain('PATH');
  });

  it('E5: base is never mutated; extra.HOME wins; metered keys drop even from extra; an explicit CLAUDE* injection survives', () => {
    // Green at HEAD too (HEAD strips only the two metered keys). What it guards is
    // the ORDER: a namespace strip applied AFTER the merge (mutation M5) would
    // delete the explicit CLAUDE_CODE_OAUTH_TOKEN injection and red here (D3).
    const base: NodeJS.ProcessEnv = { HOME: '/real', PATH: '/usr/bin', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' };
    const before = Object.entries(base);
    const out = subscriptionOnlyEnv(base, {
      HOME: '/iso',
      ANTHROPIC_API_KEY: 'fx',
      OPENAI_API_KEY: 'fx',
      CLAUDE_CODE_OAUTH_TOKEN: 'fx',
    });
    expect(Object.entries(base)).toEqual(before);
    expect(out.HOME).toBe('/iso');
    const keys = Object.keys(out);
    expect(keys.filter((k) => k === 'ANTHROPIC_API_KEY' || k === 'OPENAI_API_KEY')).toEqual([]);
    expect(keys.includes('CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
  });

  it('E6: the prefixes are anchored — a name merely CONTAINING one survives', () => {
    const keys = Object.keys(subscriptionOnlyEnv(fixtureEnv(['MY_CLAUDE_NOTES', 'XANTHROPIC_X']), {}));
    expect(keys).toEqual(expect.arrayContaining(['MY_CLAUDE_NOTES', 'XANTHROPIC_X']));
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
