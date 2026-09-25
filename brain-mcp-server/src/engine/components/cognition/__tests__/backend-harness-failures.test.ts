/**
 * Cognition backend — every harness's failure is NAMED, from the channel that CLI
 * actually reports it on (BR-109, plan D1/D1a/D2/D3).
 *
 * Each CLI fails differently: codex inside its JSONL event stream (exit 1 with a
 * non-empty stdout that `extractText` used to lift as the answer — the TD-447 class),
 * opencode on stderr with exit 0, and any CLI that rejects a flag through an
 * unknown-argument line. These cases replay each
 * CLI's MEASURED failure bytes (`fixtures/br109-cli-failures.ts`) from a stub binary
 * and drive the REAL `runBackend` → real `buildExtractorSpawn` → real `execHarness`.
 *
 * Fence (test_standards, TD-471/TD-472/BR-108): HOME is `<tmp>/home` (asserted armed and
 * not the passwd home), PATH is `<tmp>/bin:/usr/bin:/bin` — REPLACED, never prepended —
 * and every `HARNESS_BIN` name is asserted to resolve to its stub before each case, so
 * no real CLI is reachable. Each stub drains stdin to a file, writes each argv token to
 * its own file (no `echo -e`, no `awk ENVIRON`), replays its fixture and exits with the
 * fixture's code. The isolated HOMEs land under `<tmp>/scratch` and are asserted reaped.
 *
 * RED at HEAD (recorded in `br109-evidence/red-at-head.txt`): H1, H3, H4, H5, H6b,
 * H11, H12, H13, H14; H2, H6a and H10 are controls that pass on both. TD-474 retired
 * gemini's live/offline classifier entirely (its H7-H9, H15-H18 cases are deleted —
 * the code they pinned no longer exists); H10 (the antigravity control) is kept.
 *
 * @module engine/components/cognition/__tests__/backend-harness-failures.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runBackend, composePrompt, HARNESS_BIN } from '../backend/index.js';
import { classifyCliError } from '../backend/parse-output.js';
import type { SpawnOptions } from '../backend/spawn-map.js';
import { runExtractor, type RunExtractorDeps } from '../engine/index.js';
import { eventName } from '../lifecycle.js';
import type { CognitionInstance, ExtractorHarness, ExtractorPrompt } from '../types.js';
import {
  CLAUDE_UNKNOWN_OPTION,
  CODEX_400_MESSAGE,
  CODEX_MODEL_400,
  CODEX_RETRY_THEN_OK,
  CODEX_SECRET_IN_MESSAGE,
  CODEX_TURN_FAILED_401,
  H11_JWT,
  H11_SK,
  OPENCODE_MODEL_NOT_FOUND,
  OPENCODE_OK,
  OPENCODE_TOKEN_REFRESH_401,
  PRINT_OK,
  type CliOutcome,
} from './fixtures/br109-cli-failures.js';

const PROMPT: ExtractorPrompt = { system: 'extract', user: 'ctx' };
const HARNESSES: ExtractorHarness[] = ['claude', 'codex', 'antigravity', 'opencode'];

// ---------------------------------------------------------------------------
// Fence + stubs
// ---------------------------------------------------------------------------

let root = '';
let bin = '';
let scratch = '';

/** Write `h`'s stub: drain stdin, one file per argv token, replay `outcome`, exit with its code. */
function installStub(h: ExtractorHarness, outcome: CliOutcome): void {
  const b = HARNESS_BIN[h];
  const out = join(root, `fx-${b}.stdout`);
  const err = join(root, `fx-${b}.stderr`);
  const argvDir = join(root, `argv-${b}`);
  writeFileSync(out, outcome.stdout);
  writeFileSync(err, outcome.stderr);
  const script = [
    '#!/bin/sh',
    `cat > '${join(root, `stdin-${b}`)}'`,
    `rm -rf '${argvDir}'`,
    `mkdir '${argvDir}'`,
    'i=0',
    `for a in "$@"; do printf '%s' "$a" > '${argvDir}/'"$i"; i=$((i+1)); done`,
    `cat '${out}'`,
    `cat '${err}' >&2`,
    `exit ${outcome.code}`,
    '',
  ].join('\n');
  const p = join(bin, b);
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

/** The argv tokens `h`'s stub received, in order. */
function receivedArgv(h: ExtractorHarness): string[] {
  const dir = join(root, `argv-${HARNESS_BIN[h]}`);
  return readdirSync(dir)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => readFileSync(join(dir, String(i)), 'utf-8'));
}

/** Bytes `h`'s stub read on stdin. */
const stdinBytes = (h: ExtractorHarness): number => statSync(join(root, `stdin-${HARNESS_BIN[h]}`)).size;

const scratchOpts = (): SpawnOptions => ({ env: { IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT: scratch } });

/** Stub `h` with `outcome`, assert it is the resolved binary, run the real backend, assert the home was reaped. */
async function run(h: ExtractorHarness, outcome: CliOutcome) {
  installStub(h, outcome);
  const which = spawnSync('/bin/sh', ['-c', `command -v ${HARNESS_BIN[h]}`], { env: process.env, encoding: 'utf-8', timeout: 5_000 });
  expect(which.stdout.trim()).toBe(join(bin, HARNESS_BIN[h]));
  const res = await runBackend(h, PROMPT, 10_000, scratchOpts());
  expect(readdirSync(scratch)).toEqual([]); // the isolated HOME is reaped on every path
  return res;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'br109-stub-'));
  const home = join(root, 'home');
  bin = join(root, 'bin');
  scratch = join(root, 'scratch');
  for (const d of [home, bin, scratch]) mkdirSync(d, { recursive: true });
  // A placeholder stub under every name, so a case that forgets to install one still never reaches a real CLI.
  for (const h of HARNESSES) installStub(h, { stdout: '', stderr: 'unconfigured stub\n', code: 99 });
  vi.stubEnv('HOME', home);
  expect(homedir()).toBe(home); // armed, not assumed
  expect(homedir()).not.toBe(userInfo().homedir);
  vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`); // REPLACED: no real CLI is reachable
});

afterEach(() => {
  vi.unstubAllEnvs(); // restores by key — never `process.env = saved`
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------

describe('BR-109 — the fence (H0)', () => {
  it('H0: every harness binary resolves to its stub under the replaced PATH', () => {
    for (const h of HARNESSES) {
      const which = spawnSync('/bin/sh', ['-c', `command -v ${HARNESS_BIN[h]}`], { env: process.env, encoding: 'utf-8', timeout: 5_000 });
      expect(which.stdout.trim()).toBe(join(bin, HARNESS_BIN[h]));
    }
  });
});

// ---------------------------------------------------------------------------
// opencode — stderr, exit 0
// ---------------------------------------------------------------------------

describe('BR-109 — opencode reports failure on stderr with exit 0 (H1-H3)', () => {
  it('H1: the measured stale-login bytes → auth_error, detail = the ANSI-stripped Error line only (no model header)', async () => {
    const res = await run('opencode', OPENCODE_TOKEN_REFRESH_401);
    expect(res.ok).toBe(false);
    expect(res.fail_reason).toBe('auth_error');
    expect(res.detail).toBe('Token refresh failed: 401');
  });

  it('H2 (control): the same header with an answer on stdout and no Error line → ok, text OK', async () => {
    const res = await run('opencode', OPENCODE_OK);
    expect(res.ok).toBe(true);
    expect(res.text).toBe('OK');
  });

  it('H3: an Error line naming a model the provider does not serve → model_unsupported', async () => {
    const res = await run('opencode', OPENCODE_MODEL_NOT_FOUND);
    expect(res.fail_reason).toBe('model_unsupported');
    expect(res.detail).toBe('Model not found: openai/fx');
  });
});

// ---------------------------------------------------------------------------
// codex — the JSONL event stream
// ---------------------------------------------------------------------------

describe('BR-109 — codex reports failure inside its JSONL event stream (H4-H6)', () => {
  it('H4: the measured 400 stream (exit 1, 601 B stdout) → model_unsupported, the server message + " (http 400)"', async () => {
    expect(Buffer.byteLength(CODEX_MODEL_400.stdout)).toBe(601);
    const res = await run('codex', CODEX_MODEL_400);
    expect(res.ok).toBe(false);
    expect(res.text).toBe('');
    expect(res.fail_reason).toBe('model_unsupported');
    expect(res.detail!.startsWith("The 'gpt-5.6-sol' model requires a newer version of Codex")).toBe(true);
    expect(res.detail!.endsWith(' (http 400)')).toBe(true);
    expect(res.detail).toBe(`${CODEX_400_MESSAGE} (http 400)`);
  });

  it('H5: a turn.failed carrying a 401 → auth_error', async () => {
    const res = await run('codex', CODEX_TURN_FAILED_401);
    expect(res.fail_reason).toBe('auth_error');
    expect(res.detail).toBe('Your session has expired. (http 401)');
  });

  it('H6a (control): a transient error event followed by an agent_message answer is NOT a failure', async () => {
    const res = await run('codex', CODEX_RETRY_THEN_OK);
    expect(res.ok).toBe(true);
    expect(res.fail_reason).toBeUndefined();
  });

  it('H6b: the answer text is exactly the agent_message — no thread/turn/reasoning JSON rides along (D1a)', async () => {
    const res = await run('codex', CODEX_RETRY_THEN_OK);
    expect(res.text).toBe('OK');
  });
});

// ---------------------------------------------------------------------------
// antigravity — argv delivery (TD-474: the H7-H9/H15-H18 gemini live/offline
// classifier tests are deleted; the code they pinned — `detectGeminiFailure` —
// no longer exists. H10 is kept as the sole surviving control.)
// ---------------------------------------------------------------------------

describe('BR-109 — antigravity keeps argv delivery (H10)', () => {
  it('H10 (control): agy keeps argv delivery — the prompt is the LAST argv token and stdin is empty', async () => {
    const res = await run('antigravity', PRINT_OK);
    expect(res.ok).toBe(true);
    const argv = receivedArgv('antigravity');
    expect(argv[argv.length - 1]).toBe(composePrompt(PROMPT));
    expect(stdinBytes('antigravity')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The detail slot never carries a secret shape (D2)
// ---------------------------------------------------------------------------

describe('BR-109 — detail is secret-shape scrubbed at runBackend (H11)', () => {
  it('H11: sk- and JWT-shaped substrings inside a codex error message reach detail only as their prefix + …', async () => {
    const res = await run('codex', CODEX_SECRET_IN_MESSAGE);
    expect(res.fail_reason).toBe('api_error');
    expect(res.detail).toContain('sk-…');
    expect(res.detail).toContain('eyJ…');
    expect(res.detail!.includes(H11_SK)).toBe(false);
    expect(res.detail!.includes(H11_JWT)).toBe(false);
    expect(res.detail!.endsWith(' (http 500)')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// H12 — composition: the named reason reaches event_log, the parser never runs
// ---------------------------------------------------------------------------

function makeEventLogDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      component TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      machine_hostname TEXT,
      project_slug TEXT,
      instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('BR-109 — composition: a codex 400 is run_failed model_unsupported, not parse_error (H12)', () => {
  it('H12: real runBackend over the H4 stub inside real runExtractor → run_failed {reason, detail}, no response_bytes, parser never called', async () => {
    installStub('codex', CODEX_MODEL_400);
    const db = makeEventLogDb();
    try {
      const parseResponse = vi.fn(() => [] as { title: string }[]);
      const inst: CognitionInstance<{ bytes: number }, { title: string }> = {
        id: 'dummy',
        health: {
          component: 'cognition.dummy',
          event_prefix: 'cognition.dummy',
          gate_keys: ['cognition.dummy.enabled'],
          gate_default: false,
          driver: 'manual',
          driver_ref: null,
          output: 'nothing (test dummy)',
          produced: 'nothing (test dummy)',
        },
        buildContext: async () => ({ bytes: 4096 }),
        promptBuilder: (ctx) => ({ system: 'extract', user: `ctx bytes=${ctx.bytes}` }),
        parseResponse,
        persistCandidate: async () => {},
        config: { timeout_ms: 10_000, daily_budget: 8, min_input_bytes: 0, enabled: true, harness: null },
        inputBytes: (ctx) => ctx.bytes,
      };
      const deps: RunExtractorDeps = {
        isColdStart: () => false,
        resolveBackend: () => ({ harness: 'codex', fallback_order: ['codex'] }),
        runBackend: (h, p, t) => runBackend(h!, p, t, scratchOpts()),
        autoPush: () => {},
      };
      const r = await runExtractor(db, inst, {}, deps);
      expect(r.outcome).toBe('failed');
      expect(r.fail_reason).toBe('model_unsupported');
      const rows = db.prepare('SELECT event_name, payload FROM event_log ORDER BY id').all() as { event_name: string; payload: string }[];
      expect(rows.map((e) => e.event_name)).toEqual([eventName('dummy', 'run_started'), eventName('dummy', 'run_failed')]);
      const payload = JSON.parse(rows[1].payload) as Record<string, unknown>;
      expect(payload.reason).toBe('model_unsupported');
      expect(payload.detail).toBe(`${CODEX_400_MESSAGE} (http 400)`);
      expect('response_bytes' in payload).toBe(false);
      expect(parseResponse).toHaveBeenCalledTimes(0);
      expect(existsSync(scratch) && readdirSync(scratch).length === 0).toBe(true);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// H13 — the generic unknown-argument rule (every harness)
// ---------------------------------------------------------------------------

describe('BR-109 — an unknown option is cli_incompatible on any harness (H13)', () => {
  it("H13: claude exit 1, empty stdout, commander's `error: unknown option` → cli_incompatible", async () => {
    const res = await run('claude', CLAUDE_UNKNOWN_OPTION);
    expect(res.fail_reason).toBe('cli_incompatible');
    expect(res.detail).toBe("error: unknown option '--fx'");
  });
});

// ---------------------------------------------------------------------------
// H14 — the classifier's false-positive matrix, beside its positive rows
// ---------------------------------------------------------------------------

describe('BR-109 — classifyCliError: false-positive matrix and positive rows (H14)', () => {
  // Real-shaped messages that must NOT be named auth or model (test_standards: a text gate
  // pins a false-positive matrix beside its RED set).
  const FALSE_POSITIVES: Array<[string, { status?: number; code?: string; message: string }]> = [
    ['a bare 500 in the text', { message: 'Request failed (500)' }],
    ['a rate limit', { message: 'rate limit exceeded' }],
    ['model named without an unsupported verb', { message: 'The model is overloaded. Try again later.' }],
    ["model then 'unknown' about something else", { message: 'The model returned an unknown tool name' }],
    ['a 401 that is a line number, with an explicit status 500', { status: 500, message: 'line 401 of file' }],
    ['plural models without an unsupported verb', { message: 'models are busy; retry' }],
    ['an unsupported verb in the NEXT sentence', { message: 'The model timed out. Streaming is not supported here.' }],
  ];
  it.each(FALSE_POSITIVES)('H14 FP: %s → api_error', (_label, input) => {
    expect(classifyCliError(input).kind).toBe('api_error');
  });

  const POSITIVES: Array<[string, { status?: number; code?: string; message: string }, string]> = [
    ['opencode token refresh (H1 text)', { message: 'Token refresh failed: 401' }, 'auth_error'],
    ['a bare 403 in a one-line message', { message: 'request rejected: 403' }, 'auth_error'],
    ['a 401 status beats a model message', { status: 401, message: CODEX_400_MESSAGE }, 'auth_error'],
    ['the codex model-version 400 (H4 text)', { status: 400, message: CODEX_400_MESSAGE }, 'model_unsupported'],
    ['a model code', { status: 404, code: 'model_not_found', message: 'not here' }, 'model_unsupported'],
    ['plural models + not found (recalled gemini 404 shape, unmeasured)', { message: 'models/fx is not found for API version v1beta' }, 'model_unsupported'],
  ];
  it.each(POSITIVES)('H14 positive: %s', (_label, input, kind) => {
    expect(classifyCliError(input).kind).toBe(kind);
  });

  it('H14 detail: the message, capped at 200, then " (http N)" when a status is known', () => {
    expect(classifyCliError({ status: 400, message: 'x'.repeat(300) }).detail).toBe(`${'x'.repeat(200)} (http 400)`);
    expect(classifyCliError({ message: 'plain' }).detail).toBe('plain');
  });
});
