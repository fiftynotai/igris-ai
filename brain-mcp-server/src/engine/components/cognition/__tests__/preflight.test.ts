/**
 * Cognition backend — the call-free SELECTION PREFLIGHT refuses a structurally broken
 * harness with a named reason, and never refuses on doubt (BR-109, plan D4; AC-6).
 *
 * `preflightHarness(h)` checks, in order: the CLI answers `--version` (`cli_missing`);
 * every flag the REAL builder passes appears in the CLI's own `--help`, run with the
 * builder's env in the isolated HOME (`cli_incompatible`); a harness whose auth store is
 * its SOLE subscription channel has that store (`not_logged_in`, opencode only). A help
 * that fails, times out or prints nothing means USABLE (fail-open), because a misread
 * help must never refuse claude, the production harness. Results are cached per process
 * like the `--version` probe, and `resetHarnessCliProbeCache` clears both.
 *
 * Fence (TD-471/TD-472/BR-108): HOME is `<tmp>/home` (asserted armed), PATH is
 * `<tmp>/bin:/usr/bin:/bin` (REPLACED), every stub asserted to resolve, and the isolated
 * HOMEs land under `<tmp>/scratch` and are asserted reaped. Each stub appends
 * `<HOME> <argv>` to a calls file, answers `--version`, and plays the case's help.
 *
 * RED at HEAD: every case — `backend/preflight.ts` does not exist there.
 *
 * @module engine/components/cognition/__tests__/preflight.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { HARNESS_BIN, resetHarnessCliProbeCache, buildExtractorSpawn, resolveOpencodeModel, runBackend } from '../backend/index.js';
import { preflightHarness, HELP_ARGV, flagsInHelp } from '../backend/preflight.js';
import { runExtractor } from '../engine/index.js';
import { eventName } from '../lifecycle.js';
import type { CognitionInstance, ExtractorHarness } from '../types.js';
import {
  OPENCODE_METERED_PROVIDER,
  OPENCODE_OAUTH_PROVIDER,
  OPENCODE_RESOLVED_MODEL,
  seedOpencodeSubscription,
} from './fixtures/br108-isolated-home.js';

const HARNESSES: ExtractorHarness[] = ['claude', 'codex', 'antigravity', 'opencode'];

/** A help text listing every flag the BR-109/BR-110 builders pass (claude, codex, agy, opencode). */
const FULL_HELP = [
  'Usage: fx [options]',
  '  -p, --print              claude/agy headless',
  '  --output-format <fmt>',
  '  --strict-mcp-config',
  '  --allowedTools <tools...>',
  '  --system-prompt <prompt>',
  '  --json',
  '  --skip-git-repo-check',
  '  --sandbox <mode>',
  '  --print-timeout <secs>',
  '  --model <name>            opencode always passes this now (BR-110)',
  '',
].join('\n');

let root = '';
let bin = '';
let scratch = '';

type HelpPlay = { text?: string; exit?: number; sleepSec?: number };

/** Install `h`'s stub: log `<HOME> <argv>`, answer `--version` (unless `version` is false), play `help`. */
function installStub(h: ExtractorHarness, help: HelpPlay, version = true): void {
  const b = HARNESS_BIN[h];
  const helpFile = join(root, `help-${b}.txt`);
  writeFileSync(helpFile, help.text ?? '');
  const play = help.sleepSec !== undefined ? `exec sleep ${help.sleepSec}` : `cat '${helpFile}'; exit ${help.exit ?? 0}`;
  const script = [
    '#!/bin/sh',
    `printf '%s %s\\n' "$HOME" "$*" >> '${join(root, `calls-${b}`)}'`,
    `if [ "$1" = "--version" ]; then ${version ? "echo 'fx 1.0'; exit 0" : 'exit 127'}; fi`,
    play,
    '',
  ].join('\n');
  const p = join(bin, b);
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

const calls = (h: ExtractorHarness): string[] => {
  const p = join(root, `calls-${HARNESS_BIN[h]}`);
  return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter((l) => l.length > 0) : [];
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'br109-pre-'));
  const home = join(root, 'home');
  bin = join(root, 'bin');
  scratch = join(root, 'scratch');
  for (const d of [home, bin, scratch]) mkdirSync(d, { recursive: true });
  for (const h of HARNESSES) installStub(h, { text: FULL_HELP });
  vi.stubEnv('HOME', home);
  expect(homedir()).toBe(home);
  expect(homedir()).not.toBe(userInfo().homedir);
  vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
  vi.stubEnv('IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT', scratch);
  for (const h of HARNESSES) {
    const which = spawnSync('/bin/sh', ['-c', `command -v ${HARNESS_BIN[h]}`], { env: process.env, encoding: 'utf-8', timeout: 5_000 });
    expect(which.stdout.trim()).toBe(join(bin, HARNESS_BIN[h]));
  }
  resetHarnessCliProbeCache();
});

afterEach(() => {
  resetHarnessCliProbeCache();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('BR-109 — preflight refuses a CLI that lacks a builder flag (R1)', () => {
  it('R1: codex help without --sandbox → cli_incompatible naming --sandbox; the help ran in the isolated HOME, which is reaped', () => {
    installStub('codex', { text: FULL_HELP.replace(/^.*--sandbox .*$/m, '') });
    const r = preflightHarness('codex');
    expect(r.usable).toBe(false);
    expect(r.usable === false && r.reason).toBe('cli_incompatible');
    expect(r.usable === false && r.detail).toContain('--sandbox');
    const help = calls('codex').filter((l) => l.endsWith(` ${HELP_ARGV.codex.join(' ')}`));
    expect(help).toHaveLength(1);
    expect(help[0].startsWith(`${scratch}/`)).toBe(true); // HOME = an isolated home under the scratch root
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('R1 (keep control): the same stub WITH --sandbox listed → usable', () => {
    expect(preflightHarness('codex')).toEqual({ usable: true });
  });

  it('R1: every harness is usable against a stub help listing every flag its builder passes', { timeout: 30_000 }, () => {
    for (const h of HARNESSES) {
      if (h === 'opencode') seedOpencodeSubscription(homedir());
      expect(`${h}:${JSON.stringify(preflightHarness(h))}`).toBe(`${h}:${JSON.stringify({ usable: true })}`);
    }
  });

  it('R1: flagsInHelp reads a flag only as a whole token (the probe\'s regex, one spelling)', () => {
    expect(flagsInHelp('  -p, --prompt  x\n  --print-timeout <s>', ['--prompt', '--print', '-p'])).toEqual({
      '--prompt': true,
      '--print': false,
      '-p': true,
    });
  });
});

describe('BR-109 — preflight is fail-OPEN on a help it cannot read (R2)', () => {
  it('R2a: help exits 1 (and lacks --sandbox) → usable', () => {
    installStub('codex', { text: 'Usage: fx\n', exit: 1 });
    expect(preflightHarness('codex')).toEqual({ usable: true });
  });

  it('R2b: help exits 0 but prints nothing → usable', () => {
    installStub('codex', { text: '' });
    expect(preflightHarness('codex')).toEqual({ usable: true });
  });

  it('R2c: help outlives the timeout → usable, and the isolated HOME is still reaped', () => {
    installStub('codex', { sleepSec: 5 });
    expect(preflightHarness('codex', { helpTimeoutMs: 300 })).toEqual({ usable: true });
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('R2d: --version fails → cli_missing (the existing probe, first)', () => {
    installStub('codex', { text: FULL_HELP }, false);
    const r = preflightHarness('codex');
    expect(r.usable === false && r.reason).toBe('cli_missing');
    expect(calls('codex').filter((l) => l.endsWith(' exec --help'))).toEqual([]); // no help spawn after a missing CLI
  });
});

describe('BR-109 — preflight is cached per process (R3)', () => {
  it('R3: a second call spawns nothing; resetHarnessCliProbeCache clears it', { timeout: 30_000 }, () => {
    preflightHarness('codex');
    expect(calls('codex')).toHaveLength(2); // --version + --help
    preflightHarness('codex');
    expect(calls('codex')).toHaveLength(2);
    resetHarnessCliProbeCache();
    preflightHarness('codex');
    expect(calls('codex')).toHaveLength(4);
  });
});

describe('BR-109 — opencode\'s sole subscription channel is its auth store (R7b)', () => {
  it('R7b: no .local/share/opencode/auth.json in HOME → not_logged_in; with it (+ catalog + oauth model) → usable', () => {
    const r = preflightHarness('opencode');
    expect(r.usable === false && r.reason).toBe('not_logged_in');
    seedOpencodeSubscription(homedir());
    resetHarnessCliProbeCache();
    expect(preflightHarness('opencode')).toEqual({ usable: true });
  });

  it('R7b (scope): claude, codex and agy are never refused for a missing auth file (keychain / keyring stores)', { timeout: 30_000 }, () => {
    for (const h of ['claude', 'codex', 'antigravity'] as ExtractorHarness[]) {
      expect(`${h}:${preflightHarness(h).usable}`).toBe(`${h}:true`);
    }
  });
});

// ---------------------------------------------------------------------------
// BR-110 — opencode's model catalog + explicit model
// ---------------------------------------------------------------------------

describe('BR-110 — preflight refuses opencode with no model catalog (no_model_catalog)', () => {
  it('auth store present with an oauth provider, but no catalog → no_model_catalog', () => {
    mkdirSync(join(homedir(), '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(
      join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ [OPENCODE_OAUTH_PROVIDER]: { type: 'oauth' } }),
    );
    const r = preflightHarness('opencode');
    expect(r.usable === false && r.reason).toBe('no_model_catalog');
    expect(r.usable === false && r.detail).toContain('.cache/opencode/models.json');
    expect(r.usable === false && r.detail).toContain('.cache/opencode/version');
  });

  it('catalog present but only ONE of the two files → still no_model_catalog (both required)', () => {
    mkdirSync(join(homedir(), '.cache', 'opencode'), { recursive: true });
    writeFileSync(join(homedir(), '.cache', 'opencode', 'models.json'), '{}');
    mkdirSync(join(homedir(), '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(
      join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ [OPENCODE_OAUTH_PROVIDER]: { type: 'oauth' } }),
    );
    const r = preflightHarness('opencode');
    expect(r.usable === false && r.reason).toBe('no_model_catalog');
    expect(r.usable === false && r.detail).toContain('.cache/opencode/version');
    expect(r.usable === false && r.detail).not.toContain('.cache/opencode/models.json');
  });
});

describe('BR-110 — preflight refuses opencode with no oauth-backed model (no_subscription_model)', () => {
  it('catalog present, auth.json api-only → no_subscription_model', () => {
    seedOpencodeSubscription(homedir());
    writeFileSync(
      join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ [OPENCODE_METERED_PROVIDER]: { type: 'api' } }),
    );
    const r = preflightHarness('opencode');
    expect(r.usable === false && r.reason).toBe('no_subscription_model');
  });

  it('control: catalog + oauth model → usable, and the production spawn always names --model (AC-1)', () => {
    seedOpencodeSubscription(homedir());
    expect(preflightHarness('opencode')).toEqual({ usable: true });
    const spawn = buildExtractorSpawn('opencode', { system: 'x', user: 'y' }, { env: { IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT: scratch } });
    try {
      const i = spawn.args.indexOf('--model');
      expect(i).toBeGreaterThan(-1);
      expect(spawn.args[i + 1]).toBe(OPENCODE_RESOLVED_MODEL);
    } finally {
      spawn.cleanup();
    }
  });

  it('a builder that throws reaps its isolated HOME, and runBackend reports spawn_error instead of throwing', async () => {
    seedOpencodeSubscription(homedir());
    writeFileSync(
      join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ [OPENCODE_METERED_PROVIDER]: { type: 'api' } }),
    );
    const env = { IGRIS_LLM_EXTRACTOR_SCRATCH_ROOT: scratch };
    expect(() => buildExtractorSpawn('opencode', { system: 'x', user: 'y' }, { env })).toThrow(/no_subscription_model/);
    expect(readdirSync(scratch)).toEqual([]);
    const r = await runBackend('opencode', { system: 'x', user: 'y' }, 5_000, { env });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.fail_reason).toBe('spawn_error');
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('a configured model naming a non-oauth provider is refused (no_subscription_model, resolver unit)', () => {
    seedOpencodeSubscription(homedir());
    const resolved = resolveOpencodeModel(`${OPENCODE_METERED_PROVIDER}/fx`, homedir());
    expect(resolved.usable).toBe(false);
    expect(resolved.usable === false && resolved.reason).toBe('no_subscription_model');
  });
});

describe('TD-474 — the engine\'s DEFAULT resolver statically refuses a chosen gemini (R7)', () => {
  it('R7: chosen gemini is refused LOUDLY (reason harness_retired, detail names antigravity), claude runs, and run_started carries the refusal', { timeout: 30_000 }, async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT NOT NULL, component TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', machine_hostname TEXT, project_slug TEXT, instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    try {
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
        promptBuilder: () => ({ system: 'extract', user: 'ctx' }),
        parseResponse: () => [{ title: 'x' }],
        persistCandidate: async () => {},
        config: { timeout_ms: 5_000, daily_budget: 8, min_input_bytes: 0, enabled: true, harness: 'gemini' },
        inputBytes: (ctx) => ctx.bytes,
      };
      const r = await runExtractor(db, inst, {}, {
        isColdStart: () => false,
        globalConfig: { fallback_order: ['gemini', 'claude'] },
        env: {},
        runBackend: async () => ({ ok: true, text: '[{"title":"x"}]' }),
        autoPush: () => {},
      });
      expect(r.backend?.harness).toBe('claude');
      const started = db.prepare('SELECT payload FROM event_log WHERE event_name = ?').get(eventName('dummy', 'run_started')) as { payload: string };
      const payload = JSON.parse(started.payload) as {
        harness: string;
        refused?: Array<{ harness: string; reason: string; detail: string }>;
      };
      expect(payload.harness).toBe('claude');
      expect((payload.refused ?? []).map((x) => `${x.harness}:${x.reason}`)).toEqual(['gemini:harness_retired']);
      expect(payload.refused?.[0].detail).toContain('antigravity');
    } finally {
      db.close();
    }
  });
});
