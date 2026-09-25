/**
 * Cognition backend — every extractor child gets an ALLOWLIST env, per harness
 * (TD-472; AC-1 metered keys, AC-2 config pointers).
 *
 * TD-471 stripped the inherited `CLAUDE*` / `ANTHROPIC_*` namespace; everything
 * else the brain inherited still reached every extractor child. TD-472 replaces the
 * strip with one allowlist (plan D1/D2) plus a `*_API_KEY` drop (D3). These
 * cases drive the REAL builders (`buildExtractorSpawn`) and the REAL
 * `runBackend` → `execHarness` path for every extractor harness.
 *
 * Fence (the TD-471 shape, `backend-host-auth-env.test.ts`): HOME is a temp dir
 * (asserted ARMED via `homedir()`), and PATH is `<root>/bin:/usr/bin:/bin` —
 * REPLACED, not prepended — with a names-writer stub installed under every
 * `HARNESS_BIN` name; each name is asserted to resolve into `<root>/bin`, so no
 * real CLI is reachable.
 *
 * D6 (values never reach output): stubs record env NAMES via `awk ENVIRON`;
 * assertions are on name ARRAYS; every stubbed value is `'fx'` or a temp path.
 *
 * Tables: the per-harness metered names (B2) and the pointer names (C1) are the
 * plan's D4/D5 lists plus the Phase 0.2 static reads (names only, 2026-09-24,
 * one machine: `td472-evidence/phase0-static-<cli>.txt`) — e.g.
 * `CODEX_ACCESS_TOKEN`, `GOOGLE_CLOUD_ACCESS_TOKEN`, `OPENCODE_AUTH_CONTENT`.
 *
 * RED-first against HEAD (TD-471's `env.ts`): B2, C1, C2, B3 and S5 fail there
 * (×5 each); T1 (the fence) passes on both.
 *
 * @module engine/components/cognition/__tests__/backend-child-env-allowlist.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExtractorSpawn, runBackend, HARNESS_BIN } from '../backend/index.js';
import type { SpawnOptions } from '../backend/spawn-map.js';
import type { ExtractorHarness, ExtractorPrompt } from '../types.js';
import { isExpectedAllowed } from './fixtures/td472-child-env-allow.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROMPT: ExtractorPrompt = { system: 'extract', user: 'ctx' };

const HARNESSES: ExtractorHarness[] = ['claude', 'codex', 'antigravity', 'opencode'];

/** AC-1: per-harness metered / auth-routing names that must never reach that child (D4 + Phase 0.2). */
const METERED: Record<ExtractorHarness, readonly string[]> = {
  claude: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
  ],
  codex: [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'AZURE_OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ],
  antigravity: [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_ACCESS_TOKEN',
    'ANTIGRAVITY_CSRF_TOKEN',
    'ANTIGRAVITY_SIDECAR_UI_TOKEN',
    'ANTIGRAVITY_PROJECT_ID',
    'USE_ADC',
  ],
  opencode: [
    'OPENCODE_API_KEY',
    'OPENROUTER_API_KEY',
    'GROQ_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'AZURE_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_BEARER_TOKEN_BEDROCK',
    'GITHUB_TOKEN',
  ],
};

/** AC-2: every config-pointer name the plan's D5 marks STRIPPED, plus the Phase 0.2 extras. */
const POINTERS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GEMINI_CLI_HOME',
  'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
  'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
  'GEMINI_CLI_TRUSTED_FOLDERS_PATH',
  'GEMINI_SYSTEM_MD',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_CONFIG',
  'ANTIGRAVITY_EXECUTABLE_DATA_DIR',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_DB',
  'OPENCODE_TEST_HOME',
  'OPENCODE_TEST_MANAGED_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_PROFILE',
  'NODE_OPTIONS',
] as const;

/** The names that escaped TD-471's prefix rule, or are Igris's own credentials/routing. */
const ESCAPED = [
  'USE_LOCAL_OAUTH',
  'USE_STAGING_OAUTH',
  'SSH_AUTH_SOCK',
  'IGRIS_BRAIN_API_KEY',
  'BRAIN_API_KEY',
  'IGRIS_BRAIN_DIR',
] as const;

/**
 * Names a POSIX `/bin/sh` exports to its own children whatever it was given
 * (bash-as-sh on macOS: PWD, SHLVL, `_`), plus the two names GNU awk (gawk,
 * the stub's reader on Linux CI) adds to its own ENVIRON: AWKPATH and
 * AWKLIBPATH (BSD awk adds neither). The stub is a shell script, so the
 * S5 read-back sees these even from an empty env; `SHELL_ADDED` below MEASURES
 * them per run and S5 subtracts only what was measured. The brain-side env is
 * pinned without that subtraction by B3 (and PWD/SHLVL by A0/A2).
 */
const KNOWN_SHELL_BOOKKEEPING = ['PWD', 'SHLVL', '_', 'OLDPWD', 'AWKPATH', 'AWKLIBPATH'];

/** A names-writer stub: drain stdin, record NAMES only, answer `[]`. */
function stubScript(namesOut: string): string {
  return [
    '#!/bin/sh',
    'cat >/dev/null',
    `awk 'BEGIN{for (k in ENVIRON) print k}' > '${namesOut}'`,
    `printf '%s\\n' '${JSON.stringify({ type: 'result', is_error: false, result: '[]' })}'`,
    'exit 0',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Fence
// ---------------------------------------------------------------------------

let root = '';
let bin = '';
let scratch = '';

const namesFile = (h: ExtractorHarness): string => join(root, `names-${HARNESS_BIN[h]}.out`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'td472-stub-'));
  const home = join(root, 'home');
  bin = join(root, 'bin');
  scratch = join(root, 'scratch');
  for (const d of [home, bin, scratch]) mkdirSync(d, { recursive: true });
  for (const h of HARNESSES) {
    const p = join(bin, HARNESS_BIN[h]);
    writeFileSync(p, stubScript(namesFile(h)));
    chmodSync(p, 0o755);
  }

  vi.stubEnv('HOME', home);
  expect(homedir()).toBe(home); // armed, not assumed
  // NOT prepended to the real PATH: no real CLI is reachable even if a stub vanished.
  vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
  for (const h of HARNESSES) {
    const which = spawnSync('/bin/sh', ['-c', `command -v ${HARNESS_BIN[h]}`], {
      env: process.env,
      encoding: 'utf-8',
      timeout: 5_000,
    });
    expect(which.stdout.trim()).toBe(join(bin, HARNESS_BIN[h]));
  }
});

afterEach(() => {
  vi.unstubAllEnvs(); // restores by key — never `process.env = saved` (test_standards)
  rmSync(root, { recursive: true, force: true });
});

/** Spawn options pointing the isolated HOME at the fenced scratch root. */
const scratchOpts = (): SpawnOptions => ({ env: { IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT: scratch } });

/** Stub every name into the parent env with one placeholder value (never token-shaped). */
function stubNames(names: readonly string[], value: string): void {
  for (const n of names) vi.stubEnv(n, value);
}

/** Build one harness's spawn and hand back its env NAMES; the isolated HOME is always reaped. */
function childEnvNames(h: ExtractorHarness): { names: string[]; homeIsCwd: boolean } {
  const spawn = buildExtractorSpawn(h, PROMPT, scratchOpts());
  try {
    return { names: Object.keys(spawn.env), homeIsCwd: spawn.env.HOME === spawn.cwd };
  } finally {
    spawn.cleanup();
  }
}

/** The NAMES the stub for `h` received (never values). */
function receivedNames(h: ExtractorHarness): string[] {
  return readFileSync(namesFile(h), 'utf-8').split('\n').filter((l) => l.length > 0);
}

/** Measure what the stub shell adds on its own: run the claude stub with an EMPTY env. */
function measureShellAdded(): string[] {
  const res = spawnSync(join(bin, HARNESS_BIN.claude), [], { env: {}, input: '', encoding: 'utf-8', timeout: 5_000 });
  expect(res.status).toBe(0);
  return receivedNames('claude');
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('TD-472 — the fence (T1)', () => {
  it('T1: every harness binary resolves to its stub, and the stub shell adds only known bookkeeping names', () => {
    const added = measureShellAdded();
    expect(added.filter((n) => !KNOWN_SHELL_BOOKKEEPING.includes(n))).toEqual([]);
  });
});

describe('TD-472 — no metered credential reaches any extractor child (AC-1, B2)', () => {
  it.each(HARNESSES)('B2: the %s child env carries none of its metered / auth-routing names', (h) => {
    stubNames(METERED[h], 'fx');
    const { names } = childEnvNames(h);
    expect(names.filter((n) => METERED[h].includes(n))).toEqual([]);
  });
});

describe('TD-472 — no inherited variable can point a child at the operator\'s real config (AC-2, C1)', () => {
  it.each(HARNESSES)('C1: the %s child env carries no config-pointer name, and its HOME is the isolated home', (h) => {
    stubNames(POINTERS, join(root, 'operator-config'));
    const { names, homeIsCwd } = childEnvNames(h);
    expect(names.filter((n) => (POINTERS as readonly string[]).includes(n))).toEqual([]);
    expect(homeIsCwd).toBe(true);
  });
});

describe('TD-472 — the names TD-471 missed and Igris\'s own credentials never reach a child (C2)', () => {
  it.each(HARNESSES)('C2: the %s child env carries no escaped / Igris name', (h) => {
    stubNames(ESCAPED, 'fx');
    const { names } = childEnvNames(h);
    expect(names.filter((n) => (ESCAPED as readonly string[]).includes(n))).toEqual([]);
  });
});

describe('TD-472 — the REAL ambient env reduces to the allowlist (B3)', () => {
  it.each(HARNESSES)('B3: every name in the %s child env is allowlisted (the ambient parent env, not a fixture)', (h) => {
    // The fence changes only HOME and PATH; everything else is this worker's real
    // env. A red prints the ambient NAMES only (D6).
    const { names } = childEnvNames(h);
    expect(names.filter((n) => !isExpectedAllowed(n))).toEqual([]);
  });
});

describe('TD-472 — what each stub CLI actually received through the unmodified runBackend (S5)', () => {
  it.each(HARNESSES)('S5: the %s stub received only allowlisted names, HOME and PATH included', { timeout: 20_000 }, async (h) => {
    const shellAdded = measureShellAdded();
    stubNames([...METERED[h], ...ESCAPED], 'fx');
    await runBackend(h, PROMPT, 10_000, scratchOpts());
    const names = receivedNames(h);
    expect(names.filter((n) => !isExpectedAllowed(n) && !shellAdded.includes(n))).toEqual([]);
    expect(['HOME', 'PATH'].filter((n) => !names.includes(n))).toEqual([]);
  });
});
