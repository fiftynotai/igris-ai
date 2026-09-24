/**
 * Cognition backend — an extractor child never inherits the harness host's auth
 * channel (TD-471).
 *
 * The brain runs inside the Claude desktop app's harness, so its env carries
 * `CLAUDE_CODE_ENTRYPOINT=claude-desktop` + `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`
 * (names measured on all 4 live brain processes, 2026-09-24, one machine). In the
 * claude CLI that pair hands OAuth refresh to a host; a detached `-p` child has
 * none, so it fails with the TD-447 auth envelope once the stored token expires.
 *
 * A fake `claude` (a `/bin/sh` stub) mimics that gate and is driven through the
 * UNMODIFIED `runBackend` → `buildExtractorSpawn` → `execHarness` path. Fence:
 * HOME is a temp dir (asserted ARMED via `homedir()`), and PATH is
 * `<root>/bin:/usr/bin:/bin` only — not prepended to the real PATH — so the real
 * binary is unreachable and each case asserts `claude` resolves to the stub.
 *
 * D6 (values never reach output): the stub records env NAMES via
 * `awk ENVIRON`, never `env`; assertions are on key/name ARRAYS; fixture values
 * are non-token-shaped literals.
 *
 * RED-first against HEAD: S2 and B1 (×5) fail there; T0, S1 (positive control),
 * S3 (single-variable control) and S4 pass on both.
 *
 * @module engine/components/cognition/__tests__/backend-host-auth-env.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExtractorSpawn, runBackend } from '../backend/index.js';
import type { SpawnOptions } from '../backend/spawn-map.js';
import type { ExtractorHarness, ExtractorPrompt } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The live TD-447 auth envelope's `result` string — 72 chars, the brief's `response_bytes=72`. */
const AUTH_MSG = 'Failed to authenticate: OAuth session expired and could not be refreshed';

const PROMPT: ExtractorPrompt = { system: 'extract', user: 'ctx' };

/** The harness-namespace predicate the fix enforces (D1). */
const isHarnessName = (k: string): boolean => /^(CLAUDE|ANTHROPIC_)/.test(k);

/** Names S2 stubs into process.env: the gate pair plus two host-injected names. */
const S2_STUBBED = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

/**
 * The fake `claude`. The gate mirrors a static reading of the 2.1.281 bundle
 * (`~/.local/share/claude/versions/2.1.281`, 2026-09-24; names only), minified:
 *   `if(a.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH&&$c()){…requestHostAuthTokenRefresh…}`
 *   `function $c(){let e=a.CLAUDE_CODE_ENTRYPOINT;return e!==void 0&&r.has(e)}`
 *   `var r=new Set(["claude-desktop","claude-desktop-3p","local-agent"])`
 * With no host attached, that path prints the live auth envelope and exits 1;
 * otherwise the stub answers `[]`. It writes the NAMES it received to `namesOut`,
 * and `yes`/`no` to `homeOut` for "HOME is under the scratch root".
 */
function stubScript(namesOut: string, homeOut: string, scratch: string): string {
  return [
    '#!/bin/sh',
    'cat >/dev/null',
    `awk 'BEGIN{for (k in ENVIRON) print k}' > '${namesOut}'`,
    `case "$HOME" in '${scratch}'/*) echo yes ;; *) echo no ;; esac > '${homeOut}'`,
    'if [ -n "$CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH" ]; then',
    '  case "$CLAUDE_CODE_ENTRYPOINT" in',
    '    claude-desktop|claude-desktop-3p|local-agent)',
    `      printf '%s\\n' '${JSON.stringify({ type: 'result', is_error: true, result: AUTH_MSG })}'`,
    '      exit 1 ;;',
    '  esac',
    'fi',
    `printf '%s\\n' '${JSON.stringify({ type: 'result', is_error: false, result: '[]' })}'`,
    'exit 0',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Fence
// ---------------------------------------------------------------------------

let root = '';
let scratch = '';
let namesOut = '';
let homeOut = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'td471-stub-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  scratch = join(root, 'scratch');
  namesOut = join(root, 'names.out');
  homeOut = join(root, 'home-under-scratch.out');
  for (const d of [home, bin, scratch]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, 'claude'), stubScript(namesOut, homeOut, scratch));
  chmodSync(join(bin, 'claude'), 0o755);

  vi.stubEnv('HOME', home);
  expect(homedir()).toBe(home); // armed, not assumed
  // NOT prepended to the real PATH: the real `claude` is unreachable even if the stub vanished.
  vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
  const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], {
    env: process.env,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  expect(which.stdout.trim()).toBe(join(bin, 'claude'));
});

afterEach(() => {
  vi.unstubAllEnvs(); // restores by key — never `process.env = saved` (test_standards)
  rmSync(root, { recursive: true, force: true });
});

/** Spawn options pointing the isolated HOME at the fenced scratch root. */
const scratchOpts = (): SpawnOptions => ({ env: { IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT: scratch } });

/** Stub the S2 parent env: the desktop gate pair plus two host-injected names. */
function stubDesktopParentEnv(): void {
  vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'claude-desktop');
  vi.stubEnv('CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', '1');
  vi.stubEnv('CLAUDE_CODE_MESSAGING_TOKEN', 'fx');
  vi.stubEnv('ANTHROPIC_BASE_URL', 'td471-fixture');
}

/** The env NAMES the stub received (never values). */
function receivedNames(): string[] {
  return readFileSync(namesOut, 'utf-8').split('\n').filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('TD-471 — a claude extractor child never inherits the host auth channel', () => {
  it('T0: the live auth message is the 72-char TD-447 fixture', () => {
    expect(AUTH_MSG.length).toBe(72);
  });

  it('S1 (positive control): the stub DOES fail with the auth envelope when handed the gate pair', { timeout: 20_000 }, async () => {
    const res = await runBackend('claude', PROMPT, 10_000, {
      ...scratchOpts(),
      buildSpawn: (h: ExtractorHarness, p: ExtractorPrompt, o?: SpawnOptions) => {
        const spawn = buildExtractorSpawn(h, p, o);
        spawn.env = {
          ...spawn.env,
          CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
          CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
        };
        return spawn;
      },
    });
    expect({ ok: res.ok, fail_reason: res.fail_reason, detail: res.detail }).toEqual({
      ok: false,
      fail_reason: 'auth_error',
      detail: AUTH_MSG,
    });
  });

  it('S2: a desktop-hosted parent env no longer reaches the child — the real path succeeds', { timeout: 20_000 }, async () => {
    stubDesktopParentEnv();
    const res = await runBackend('claude', PROMPT, 10_000, scratchOpts());
    expect({ ok: res.ok, fail_reason: res.fail_reason, text: res.text }).toEqual({
      ok: true,
      fail_reason: undefined,
      text: '[]',
    });
    const names = receivedNames();
    expect(names.filter((n) => (S2_STUBBED as readonly string[]).includes(n))).toEqual([]);
    expect(names.filter(isHarnessName)).toEqual([]);
    expect(['HOME', 'PATH'].filter((n) => !names.includes(n))).toEqual([]);
  });

  it('S3 (single-variable control): without the gate pair the stub path succeeds on both sides', { timeout: 20_000 }, async () => {
    stubDesktopParentEnv();
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    vi.stubEnv('CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', undefined);
    const res = await runBackend('claude', PROMPT, 10_000, scratchOpts());
    expect({ ok: res.ok, fail_reason: res.fail_reason, text: res.text }).toEqual({
      ok: true,
      fail_reason: undefined,
      text: '[]',
    });
  });

  it('S4: the child ran with HOME under the scratch root, and that isolated HOME was reaped', { timeout: 20_000 }, async () => {
    stubDesktopParentEnv();
    await runBackend('claude', PROMPT, 10_000, scratchOpts());
    expect(existsSync(homeOut)).toBe(true);
    expect(readFileSync(homeOut, 'utf-8').trim()).toBe('yes');
    expect(readdirSync(scratch)).toEqual([]);
  });
});

describe('TD-471 — every harness builder strips the inherited namespace (B1)', () => {
  const HARNESSES: ExtractorHarness[] = ['claude', 'codex', 'gemini', 'antigravity', 'opencode'];

  it.each(HARNESSES)('B1: %s child env carries no CLAUDE* / ANTHROPIC_* name', (h) => {
    stubDesktopParentEnv();
    const spawn = buildExtractorSpawn(h, PROMPT, scratchOpts());
    try {
      expect(Object.keys(spawn.env).filter(isHarnessName)).toEqual([]);
    } finally {
      spawn.cleanup();
    }
  });
});
