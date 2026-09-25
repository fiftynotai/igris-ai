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
import { HARNESS_BIN, resetHarnessCliProbeCache } from '../backend/index.js';
import { preflightHarness, HELP_ARGV, flagsInHelp } from '../backend/preflight.js';
import { runExtractor } from '../engine/index.js';
import { eventName } from '../lifecycle.js';
import type { CognitionInstance, ExtractorHarness } from '../types.js';

const HARNESSES: ExtractorHarness[] = ['claude', 'codex', 'gemini', 'antigravity', 'opencode'];

/** A help text listing every flag the BR-109 builders pass (claude, codex, gemini, agy; opencode passes none). */
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
  '  --allowed-mcp-server-names  Allowed MCP server names',
  '      --skip-trust                Trust the current workspace for this session.  [boolean] [default: false]',
  '  -p, --prompt             Run in non-interactive (headless) mode',
  '  --print-timeout <secs>',
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
  it('R1: gemini help without --prompt → cli_incompatible naming --prompt; the help ran in the isolated HOME, which is reaped', () => {
    installStub('gemini', { text: FULL_HELP.replace(/^.*--prompt .*$/m, '') });
    const r = preflightHarness('gemini');
    expect(r.usable).toBe(false);
    expect(r.usable === false && r.reason).toBe('cli_incompatible');
    expect(r.usable === false && r.detail).toContain('--prompt');
    const help = calls('gemini').filter((l) => l.endsWith(` ${HELP_ARGV.gemini.join(' ')}`));
    expect(help).toHaveLength(1);
    expect(help[0].startsWith(`${scratch}/`)).toBe(true); // HOME = an isolated home under the scratch root
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('R1 (keep control): the same stub WITH --prompt listed → usable', () => {
    expect(preflightHarness('gemini')).toEqual({ usable: true });
  });

  it('R1: every harness is usable against a stub help listing every flag its builder passes', { timeout: 30_000 }, () => {
    for (const h of HARNESSES) {
      if (h === 'opencode') {
        mkdirSync(join(homedir(), '.local', 'share', 'opencode'), { recursive: true });
        writeFileSync(join(homedir(), '.local', 'share', 'opencode', 'auth.json'), '{}');
      }
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
  it('R2a: help exits 1 (and lacks --prompt) → usable', () => {
    installStub('gemini', { text: 'Usage: fx\n', exit: 1 });
    expect(preflightHarness('gemini')).toEqual({ usable: true });
  });

  it('R2b: help exits 0 but prints nothing → usable', () => {
    installStub('gemini', { text: '' });
    expect(preflightHarness('gemini')).toEqual({ usable: true });
  });

  it('R2c: help outlives the timeout → usable, and the isolated HOME is still reaped', () => {
    installStub('gemini', { sleepSec: 5 });
    expect(preflightHarness('gemini', { helpTimeoutMs: 300 })).toEqual({ usable: true });
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('R2d: --version fails → cli_missing (the existing probe, first)', () => {
    installStub('gemini', { text: FULL_HELP }, false);
    const r = preflightHarness('gemini');
    expect(r.usable === false && r.reason).toBe('cli_missing');
    expect(calls('gemini').filter((l) => l.endsWith(' --help'))).toEqual([]); // no help spawn after a missing CLI
  });
});

describe('BR-109 — preflight is cached per process (R3)', () => {
  it('R3: a second call spawns nothing; resetHarnessCliProbeCache clears it', { timeout: 30_000 }, () => {
    preflightHarness('gemini');
    expect(calls('gemini')).toHaveLength(2); // --version + --help
    preflightHarness('gemini');
    expect(calls('gemini')).toHaveLength(2);
    resetHarnessCliProbeCache();
    preflightHarness('gemini');
    expect(calls('gemini')).toHaveLength(4);
  });
});

describe('BR-109 — opencode\'s sole subscription channel is its auth store (R7b)', () => {
  it('R7b: no .local/share/opencode/auth.json in HOME → not_logged_in; with it → usable (existence only)', () => {
    const r = preflightHarness('opencode');
    expect(r.usable === false && r.reason).toBe('not_logged_in');
    mkdirSync(join(homedir(), '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(homedir(), '.local', 'share', 'opencode', 'auth.json'), '{}');
    resetHarnessCliProbeCache();
    expect(preflightHarness('opencode')).toEqual({ usable: true });
  });

  it('R7b (scope): claude, codex, gemini and agy are never refused for a missing auth file (keychain / keyring stores)', { timeout: 30_000 }, () => {
    for (const h of ['claude', 'codex', 'gemini', 'antigravity'] as ExtractorHarness[]) {
      expect(`${h}:${preflightHarness(h).usable}`).toBe(`${h}:true`);
    }
  });
});

describe('BR-109 — the engine\'s DEFAULT resolver runs the preflight (R7)', () => {
  it('R7: chosen gemini is refused, claude runs, and run_started carries the refusal', { timeout: 30_000 }, async () => {
    installStub('gemini', { text: FULL_HELP.replace(/^.*--prompt .*$/m, '') });
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
      const payload = JSON.parse(started.payload) as { harness: string; refused?: Array<{ harness: string; reason: string }> };
      expect(payload.harness).toBe('claude');
      expect((payload.refused ?? []).map((x) => `${x.harness}:${x.reason}`)).toEqual(['gemini:cli_incompatible']);
    } finally {
      db.close();
    }
  });
});
