/**
 * Cognition backend env + harness-selection tests (FR-118 M0).
 *
 * Covers:
 *   - subscriptionOnlyEnv strips ANTHROPIC_API_KEY / OPENAI_API_KEY (fresh env)
 *   - subscriptionOnlyEnv never lets a child INHERIT the harness namespace
 *     (`CLAUDE*` / `ANTHROPIC_*`), keeps the proxy/CA/identity vars, and lets an
 *     explicit `extra` injection survive (TD-471, E1–E5)
 *   - TD-472: the inherited env is an ALLOWLIST (default-deny). E6′ inverts
 *     TD-471's E6 on purpose (a name merely CONTAINING a harness prefix is now
 *     dropped too); A0 pins exact membership against a second literal spelling
 *     (`fixtures/td472-child-env-allow.ts`), A1 the keep half, A2 default-deny,
 *     A3 `LC_` anchoring, A4 the `*_API_KEY` drop over `extra` + inject survival.
 *     Names only on output (D6): fixture values are `'fx'` / non-token literals.
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
  isExtractorHarnessSelection,
  GEMINI_RETIRED_DETAIL,
  type LlmExtractorGlobalConfig,
} from '../backend/env.js';
import { ALL_EXTRACTOR_HARNESSES } from '../types.js';
import type { ExtractorHarness, ExtractorHarnessSelection, HarnessPreflight } from '../types.js';
import { EXPECTED_ALLOW } from './fixtures/td472-child-env-allow.js';

// ---------------------------------------------------------------------------
// TD-474 — gemini retired from the extractor roster (RED-first roster pin)
// ---------------------------------------------------------------------------

describe('TD-474 — gemini retired from the extractor roster', () => {
  it('ALL_EXTRACTOR_HARNESSES is exactly the four runnable harnesses, sorted, and never contains gemini', () => {
    expect([...ALL_EXTRACTOR_HARNESSES].sort()).toEqual(['antigravity', 'claude', 'codex', 'opencode']);
    expect(ALL_EXTRACTOR_HARNESSES).not.toContain('gemini');
  });
});

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

/**
 * Non-harness vars the child legitimately needs (Keychain lookup is keyed by user;
 * proxies; CA files). TD-472 widened this control: `ALL_PROXY`, the four
 * lowercase proxies, `NODE_USE_SYSTEM_CA` (on all 4 live brains, measured),
 * `SSL_CERT_DIR` and `REQUESTS_CA_BUNDLE` joined, and
 * `IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT` left (fork F2: no child reads `IGRIS_*`, and
 * the brain reads the scratch root from its OWN env, never the child's).
 */
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
  'ALL_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_SYSTEM_CA',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
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
    // Green before and after TD-471 and TD-472. What it guards is the ORDER: a
    // filter (TD-471's prefix strip, TD-472's allowlist) applied AFTER the merge
    // (mutation M5 in both plans) would delete the explicit CLAUDE_CODE_OAUTH_TOKEN
    // injection and red here (D3).
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

  it('E6′ (TD-472 inverts TD-471\'s E6): a name merely CONTAINING a harness prefix is dropped too — default-deny', () => {
    // TD-471's E6 pinned "a name merely containing a prefix SURVIVES". Under the
    // TD-472 allowlist nothing survives unless it is allowed, so the old property
    // no longer exists; the anchoring that still matters is `LC_` (A3).
    const keys = Object.keys(subscriptionOnlyEnv(fixtureEnv(['MY_CLAUDE_NOTES', 'XANTHROPIC_X', 'PATH']), {}));
    expect(keys.filter((k) => k === 'MY_CLAUDE_NOTES' || k === 'XANTHROPIC_X')).toEqual([]);
    expect(keys).toEqual(['PATH']);
  });
});

// ---------------------------------------------------------------------------
// TD-472 — the child env is an allowlist
// ---------------------------------------------------------------------------

/**
 * A 20-name drop sample, at least one per plan-D2 drop class. Every name is set
 * to `'fx'` through `fixtureValue` (never a literal NAME: 'value' pair).
 */
const DROP_SAMPLE = [
  'SSH_AUTH_SOCK', // credential channel no CLI uses for its own auth (F7)
  'USE_LOCAL_OAUTH', // claude-auth routing TD-471's prefixes missed
  'USE_STAGING_OAUTH',
  'IGRIS_BRAIN_API_KEY', // Igris credentials + routing (F2)
  'IGRIS_BRAIN_DIR',
  'BRAIN_API_KEY',
  'CODEX_HOME', // config pointers (D5)
  'OPENCODE_CONFIG',
  'XDG_CONFIG_HOME',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GEMINI_API_KEY', // metered (D3)
  'OPENROUTER_API_KEY',
  'NODE_OPTIONS', // code-injection routes
  'DYLD_INSERT_LIBRARIES',
  'TERM', // terminal + launchd bookkeeping
  'XPC_SERVICE_NAME',
  'SECURITYSESSIONID',
  'PWD',
  'SHLVL',
  'CLAUDE_CODE_ENTRYPOINT', // the TD-471 namespace
] as const;

/** Set every name to one short placeholder (gitleaks-safe, never token-shaped). */
function fixtureValue(names: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const n of names) env[n] = 'fx';
  return env;
}

// D6: assertions are on sorted KEY arrays; a red prints names, never values.
describe('subscriptionOnlyEnv — the child env is an allowlist (TD-472)', () => {
  it('A0: exact membership — the inherited keys are EXACTLY the allowlist (+ an LC_ name), whatever else the parent carries', () => {
    expect(DROP_SAMPLE.length).toBe(20);
    const base = fixtureValue([...EXPECTED_ALLOW, 'LC_CTYPE', ...DROP_SAMPLE]);
    const keys = Object.keys(subscriptionOnlyEnv(base)).sort();
    expect(keys).toEqual([...EXPECTED_ALLOW, 'LC_CTYPE'].sort());
  });

  it('A1 (keep control): every allowlisted name passes with its value unchanged, the two Linux names included', () => {
    const base: NodeJS.ProcessEnv = Object.fromEntries(EXPECTED_ALLOW.map((n) => [n, `keep-${n}`]));
    const out = subscriptionOnlyEnv(base);
    expect(EXPECTED_ALLOW.map((n) => [n, out[n]])).toEqual(EXPECTED_ALLOW.map((n) => [n, `keep-${n}`]));
    expect(['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].filter((n) => out[n] === undefined)).toEqual([]);
  });

  it('A2: default-deny — shell bookkeeping, code-injection routes and a never-seen credential name are all dropped', () => {
    const denied = [
      'PWD',
      'SHLVL',
      'TERM',
      'NODE_OPTIONS',
      'DYLD_INSERT_LIBRARIES',
      'XPC_SERVICE_NAME',
      'TD472_FUTURE_CREDENTIAL',
    ];
    const keys = Object.keys(subscriptionOnlyEnv(fixtureValue([...denied, 'PATH'])));
    expect(keys.filter((k) => denied.includes(k))).toEqual([]);
    expect(keys).toEqual(['PATH']);
  });

  it('A3: the LC_ prefix is anchored — LC_ALL/LC_CTYPE kept, MY_LC_X/XLC_ALL dropped', () => {
    const keys = Object.keys(subscriptionOnlyEnv(fixtureValue(['LC_ALL', 'LC_CTYPE', 'MY_LC_X', 'XLC_ALL']))).sort();
    expect(keys).toEqual(['LC_ALL', 'LC_CTYPE']);
  });

  it('A4: every *_API_KEY drops even from extra; a non-metered explicit injection survives (inject, never inherit)', () => {
    const extraNames = [
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'CODEX_API_KEY',
      'OPENROUTER_API_KEY',
      'GOOGLE_GENAI_USE_GCA',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ];
    const out = subscriptionOnlyEnv(fixtureValue(['PATH']), { HOME: '/iso', ...fixtureValue(extraNames) });
    const keys = Object.keys(out);
    expect(keys.filter((k) => k.endsWith('_API_KEY'))).toEqual([]);
    expect(['GOOGLE_GENAI_USE_GCA', 'CLAUDE_CODE_OAUTH_TOKEN'].filter((k) => !keys.includes(k))).toEqual([]);
    expect(out.HOME).toBe('/iso');
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
    const present = new Set<ExtractorHarness>(['claude', 'opencode']);
    const b = resolveBackend(
      { harness: 'opencode' },
      'perception',
      null,
      noEnv,
      (h) => present.has(h),
    );
    expect(b.harness).toBe('opencode');
    expect(b.fallback_order[0]).toBe('opencode'); // chosen first
  });

  it('walks the fallback order when the chosen harness is absent', () => {
    // chosen = codex (absent); fallback order claude→opencode, claude present
    const present = new Set<ExtractorHarness>(['claude']);
    const b = resolveBackend(
      { harness: 'codex', fallback_order: ['claude', 'opencode'] },
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

// ---------------------------------------------------------------------------
// BR-109 — a PREFLIGHT seam: a refused harness is skipped with a named entry (AC-6)
// ---------------------------------------------------------------------------

describe('resolveBackend — a HarnessPreflight seam (BR-109, R4/R5)', () => {
  const noEnv: NodeJS.ProcessEnv = {};
  const refuse = (reason: 'cli_missing' | 'cli_incompatible' | 'not_logged_in', detail: string): HarnessPreflight => ({
    usable: false,
    reason,
    detail,
  });

  it('R4: chosen codex refused (cli_incompatible), claude usable → claude runs, the refusal is named', () => {
    const b = resolveBackend({ harness: 'codex', fallback_order: ['codex', 'claude'] }, 'perception', null, noEnv, (h) =>
      h === 'codex' ? refuse('cli_incompatible', 'builder flags absent from codex --help: --sandbox') : { usable: true },
    );
    expect(b.harness).toBe('claude');
    expect(b.fallback_order.slice(0, 2)).toEqual(['codex', 'claude']);
    expect(b.refused).toEqual([
      { harness: 'codex', reason: 'cli_incompatible', detail: 'builder flags absent from codex --help: --sandbox' },
    ]);
  });

  it('R4: nothing usable → harness:null and every refusal listed in walk order', () => {
    const b = resolveBackend({ harness: 'opencode', fallback_order: ['opencode', 'codex'] }, 'perception', null, noEnv, (h) =>
      h === 'opencode' ? refuse('not_logged_in', 'no auth store') : h === 'codex' ? refuse('cli_incompatible', 'x') : refuse('cli_missing', 'y'),
    );
    expect(b.harness).toBeNull();
    expect((b.refused ?? []).map((r) => `${r.harness}:${r.reason}`).slice(0, 3)).toEqual([
      'opencode:not_logged_in',
      'codex:cli_incompatible',
      'claude:cli_missing',
    ]);
  });

  it('R5 (back-compat control): a boolean seam yields exactly the pre-BR-109 object — no refused key', () => {
    const present = new Set<ExtractorHarness>(['claude']);
    const b = resolveBackend({ harness: 'codex', fallback_order: ['claude'] }, 'perception', null, noEnv, (h) => present.has(h));
    expect(b).toEqual({ harness: 'claude', fallback_order: ['codex', 'claude', 'opencode', 'antigravity'] });
    expect('refused' in b).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TD-474 — the static gemini refusal: loud, never silent, never auto-selected
// ---------------------------------------------------------------------------

describe('resolveBackend — gemini is refused LOUDLY and statically (TD-474)', () => {
  const noEnv: NodeJS.ProcessEnv = {};

  it('an explicit chosen gemini is refused with reason harness_retired, naming antigravity, WITHOUT ever calling the probe — claude runs', () => {
    const probed: ExtractorHarness[] = [];
    const b = resolveBackend({ harness: 'gemini', fallback_order: ['gemini', 'claude'] }, 'perception', null, noEnv, (h) => {
      probed.push(h);
      return true;
    });
    expect(b.harness).toBe('claude');
    expect(b.fallback_order.slice(0, 2)).toEqual(['gemini', 'claude']);
    expect(b.refused).toEqual([{ harness: 'gemini', reason: 'harness_retired', detail: GEMINI_RETIRED_DETAIL }]);
    expect(b.refused?.[0].detail).toContain('antigravity');
    // the static refusal never calls isAvailable/preflightHarness for gemini —
    // it is a permanent, selection-time fact, not a per-machine condition to probe.
    expect(probed).not.toContain('gemini');
    expect(probed).toEqual(['claude']);
  });

  it('gemini named via fallback_order (not chosen) is refused mid-walk, and the walk continues past it', () => {
    const b = resolveBackend(
      { harness: 'claude', fallback_order: ['claude', 'gemini', 'codex'] },
      'perception',
      null,
      noEnv,
      (h) => h === 'codex', // claude fails, gemini would be next but is statically refused, codex succeeds
    );
    expect(b.harness).toBe('codex');
    expect(b.refused).toEqual([{ harness: 'gemini', reason: 'harness_retired', detail: GEMINI_RETIRED_DETAIL }]);
  });

  it('gemini named via the global env override is refused the same way as a config pin', () => {
    const env = { IGRIS_LLM_EXTRACTOR_HARNESS: 'gemini' } as NodeJS.ProcessEnv;
    const b = resolveBackend({}, 'perception', null, env, (h) => (h === 'claude' ? true : false));
    expect(b.harness).toBe('claude');
    expect(b.refused).toEqual([{ harness: 'gemini', reason: 'harness_retired', detail: GEMINI_RETIRED_DETAIL }]);
  });

  it('gemini named via the per-instance config is refused the same way as a global pin', () => {
    const b = resolveBackend({}, 'subconscious', 'gemini', noEnv, (h) => (h === 'claude' ? true : false));
    expect(b.harness).toBe('claude');
    expect(b.refused).toEqual([{ harness: 'gemini', reason: 'harness_retired', detail: GEMINI_RETIRED_DETAIL }]);
  });

  it('gemini named via the per-instance env override (highest layer) is refused the same way', () => {
    const probed: ExtractorHarness[] = [];
    const env = { IGRIS_SUBCONSCIOUS_HARNESS: 'gemini' } as NodeJS.ProcessEnv;
    const b = resolveBackend({ harness: 'codex' }, 'subconscious', 'opencode', env, (h) => {
      probed.push(h);
      return h === 'claude';
    });
    expect(b.harness).toBe('claude');
    expect(b.fallback_order[0]).toBe('gemini');
    expect(b.refused).toEqual([{ harness: 'gemini', reason: 'harness_retired', detail: GEMINI_RETIRED_DETAIL }]);
    expect(probed).not.toContain('gemini');
  });

  it('auto-detection NEVER tries gemini, even with the binary on PATH: no explicit config, default fallback walk', () => {
    const probed: ExtractorHarness[] = [];
    // A stub that would say "present" for a literal 'gemini' string if it were
    // ever asked — proving the default walk structurally never contains it. It
    // returns false for every REAL harness so the walk runs to completion.
    const isAvailable = (h: ExtractorHarness): boolean => {
      probed.push(h);
      return (h as string) === 'gemini';
    };
    const b = resolveBackend({}, 'perception', null, noEnv, isAvailable);
    expect(b.harness).toBeNull(); // nothing the stub would ever say yes to was reachable
    expect(probed).not.toContain('gemini');
    expect(probed).toEqual([...ALL_EXTRACTOR_HARNESSES]); // the default walk order, in full — 'claude' first
  });

  it('isExtractorHarnessSelection recognizes gemini as a selection (not noise) but isHarnessCliAvailable-style typing excludes it', () => {
    expect(isExtractorHarnessSelection('gemini')).toBe(true);
    expect(isExtractorHarnessSelection('claude')).toBe(true);
    expect(isExtractorHarnessSelection('bogus')).toBe(false);
    expect((ALL_EXTRACTOR_HARNESSES as readonly ExtractorHarnessSelection[]).includes('gemini')).toBe(false);
  });
});
