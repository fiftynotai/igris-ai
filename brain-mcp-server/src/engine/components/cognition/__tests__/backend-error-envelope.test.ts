/**
 * Cognition backend — claude `is_error` result envelopes are a BACKEND failure,
 * never model text (TD-447).
 *
 * `claude -p --output-format json` reports API and auth failures INSIDE the
 * result envelope (`{type:"result", is_error:true, api_error_status, result,
 * terminal_reason}`) with exit 1. Before TD-447 `runBackend` only classified
 * `non_zero_exit` on EMPTY stdout, so `extractText` lifted the error string as
 * the answer and the engine recorded `run_failed reason=parse_error
 * response_bytes=147`. These tests drive the REAL `runBackend` through its
 * injectable `buildSpawn` / `runExec` seams (never a CLI) — the first direct
 * `runBackend` suite — and T10 composes it with the REAL `runExtractor` over an
 * in-memory `event_log` to prove the envelope never reaches the instance parser.
 *
 * Fixtures are the brief's live envelopes byte-for-byte (test_standards:
 * "fixtures from reality"). RED-first against HEAD: T1/T2/T5/T7/T8/T10 fail
 * there; T3/T4/T6/T9 are the unchanged-behaviour controls and pass on both.
 *
 * @module engine/components/cognition/__tests__/backend-error-envelope.test
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runBackend } from '../backend/index.js';
import type { ExtractorSpawn, SpawnOptions } from '../backend/spawn-map.js';
import type { ExecResult } from '../backend/exec.js';
import { runExtractor, type RunExtractorDeps } from '../engine/index.js';
import { eventName } from '../lifecycle.js';
import type { CognitionInstance, ExtractorHarness, ExtractorPrompt } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures — the brief's live envelopes, byte-for-byte
// ---------------------------------------------------------------------------

/** The `result` string of the live 529 envelope (2026-09-03). 147 chars — the brief's `response_bytes=147`. */
const LIVE_529_RESULT =
  'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.';

/** The live 529 envelope, key order as the CLI printed it. */
const LIVE_529 = JSON.stringify({
  type: 'result',
  is_error: true,
  api_error_status: 529,
  terminal_reason: 'api_error',
  result: LIVE_529_RESULT,
});

/** The `result` string of the live auth envelope. 72 chars — the brief's `response_bytes=72`. */
const LIVE_AUTH_RESULT = 'Failed to authenticate: OAuth session expired and could not be refreshed';

/** The live auth envelope: no `api_error_status`; its `terminal_reason` was not captured by the brief. */
const LIVE_AUTH = JSON.stringify({ type: 'result', is_error: true, result: LIVE_AUTH_RESULT });

const PROMPT: ExtractorPrompt = { system: 'extract', user: 'ctx' };

// ---------------------------------------------------------------------------
// Seams — a spawn that never touches the filesystem, an exec that never forks
// ---------------------------------------------------------------------------

/** Build a `buildSpawn` seam whose `cleanup` counts its calls (the `finally` contract). */
function makeFakeSpawn(): { buildSpawn: (h: ExtractorHarness, p: ExtractorPrompt, o?: SpawnOptions) => ExtractorSpawn; cleanups: () => number } {
  let n = 0;
  return {
    buildSpawn: (harness, prompt) => ({
      bin: harness,
      args: ['-p'],
      env: {},
      cwd: '/nonexistent',
      delivery: 'stdin',
      prompt: prompt.user,
      cleanup: () => {
        n += 1;
      },
    }),
    cleanups: () => n,
  };
}

/** An `execHarness` seam that resolves the given stdout / exit code without forking. */
function fakeExec(stdout: string, code: number, stderr = ''): () => Promise<ExecResult> {
  return async () => ({ stdout, stderr, code, timed_out: false, duration_ms: 1 });
}

async function run(harness: ExtractorHarness, stdout: string, code: number, stderr = '') {
  const spawn = makeFakeSpawn();
  const res = await runBackend(harness, PROMPT, 1_000, { buildSpawn: spawn.buildSpawn, runExec: fakeExec(stdout, code, stderr) });
  return { res, cleanups: spawn.cleanups() };
}

// ---------------------------------------------------------------------------
// runBackend — classification on the ENVELOPE (T1–T9)
// ---------------------------------------------------------------------------

describe('runBackend classifies a claude is_error result envelope as a backend failure (TD-447)', () => {
  it('T1 — the live 529 envelope, exit 1 → ok:false, api_error, detail = message + " (http 529)", cleanup once', async () => {
    const { res, cleanups } = await run('claude', LIVE_529, 1);
    expect(res.ok).toBe(false);
    expect(res.fail_reason).toBe('api_error');
    expect(res.text).toBe('');
    expect(res.detail).toBe(`${LIVE_529_RESULT} (http 529)`);
    expect(res.detail!.startsWith('API Error: 529 Overloaded')).toBe(true);
    expect(res.detail!.endsWith('(http 529)')).toBe(true);
    expect(cleanups).toBe(1);
  });

  it('T1b — a stream-json variant (assistant lines, then the same result event) is still api_error', async () => {
    const stdout = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }),
      LIVE_529,
    ].join('\n');
    const { res } = await run('claude', stdout, 1);
    expect(res.fail_reason).toBe('api_error');
    expect(res.detail).toBe(`${LIVE_529_RESULT} (http 529)`);
  });

  it('T2 — the live auth envelope (no status), exit 1 → auth_error, detail is the 72-char message verbatim', async () => {
    const { res, cleanups } = await run('claude', LIVE_AUTH, 1);
    expect(res.ok).toBe(false);
    expect(res.fail_reason).toBe('auth_error');
    expect(res.detail).toBe(LIVE_AUTH_RESULT);
    expect(res.detail).toHaveLength(72);
    expect(cleanups).toBe(1);
  });

  it('T3 (AC-3) — a result envelope with is_error:false, exit 0 → ok:true, the answer text is lifted as before', async () => {
    const { res } = await run('claude', JSON.stringify({ type: 'result', is_error: false, result: '[{"title":"x"}]' }), 0);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('[{"title":"x"}]');
    expect(res.fail_reason).toBeUndefined();
  });

  it('T4 (AC-3) — a result envelope with is_error ABSENT, exit 0 → ok:true (the pre-TD-447 shape is untouched)', async () => {
    const { res } = await run('claude', JSON.stringify({ type: 'result', result: '[{"title":"x"}]' }), 0);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('[{"title":"x"}]');
  });

  it('T5 — the live 529 envelope with exit 0 is STILL api_error: the envelope, not the exit code, is the signal', async () => {
    const { res } = await run('claude', LIVE_529, 0);
    expect(res.ok).toBe(false);
    expect(res.fail_reason).toBe('api_error');
  });

  it('T6 (AC-4 control) — the SAME 529 line under harness codex → ok:true, text lifted: classification is claude-scoped', async () => {
    // The harness guard is what keeps codex/gemini/opencode/antigravity on the
    // unchanged extractText path. This control OBSERVES the guard: delete it and
    // this case goes red (mutation M2).
    const { res } = await run('codex', LIVE_529, 1);
    expect(res.ok).toBe(true);
    expect(res.text).toBe(LIVE_529_RESULT);
    expect(res.fail_reason).toBeUndefined();
  });

  it('T7 — a 600-char result: the message half of detail is exactly 200 chars, the status suffix survives the cut', async () => {
    const long = 'x'.repeat(600);
    const { res } = await run('claude', JSON.stringify({ type: 'result', is_error: true, api_error_status: 500, result: long }), 1);
    expect(res.fail_reason).toBe('api_error');
    const suffix = ' (http 500)';
    expect(res.detail!.endsWith(suffix)).toBe(true);
    expect(res.detail!.length).toBe(200 + suffix.length);
    expect(res.detail!.slice(0, 200)).toBe(long.slice(0, 200));
  });

  describe('T8 — the auth_error predicate, one arm at a time', () => {
    it('T8a — status 401 with a generic message → auth_error (status arm)', async () => {
      const { res } = await run('claude', JSON.stringify({ type: 'result', is_error: true, api_error_status: 401, result: 'Request failed' }), 1);
      expect(res.fail_reason).toBe('auth_error');
      expect(res.detail).toBe('Request failed (http 401)');
    });

    it('T8b — status 403 with a generic message → auth_error (status arm)', async () => {
      const { res } = await run('claude', JSON.stringify({ type: 'result', is_error: true, api_error_status: 403, result: 'Request failed' }), 1);
      expect(res.fail_reason).toBe('auth_error');
    });

    it('T8c — status 500 with a message mentioning OAuth → auth_error (message arm)', async () => {
      const { res } = await run('claude', JSON.stringify({ type: 'result', is_error: true, api_error_status: 500, result: 'OAuth token refresh failed upstream' }), 1);
      expect(res.fail_reason).toBe('auth_error');
    });

    it('T8d — a generic message with terminal_reason naming authentication → auth_error (terminal_reason arm)', async () => {
      const { res } = await run('claude', JSON.stringify({ type: 'result', is_error: true, terminal_reason: 'authentication_failed', result: 'Request failed' }), 1);
      expect(res.fail_reason).toBe('auth_error');
    });

    it('T8e — the SAME generic message as T8a/b/d, status 500 + terminal_reason api_error → api_error (no arm matches)', async () => {
      // Negative control holding the message constant across T8a/T8b/T8d: a
      // non-401/403 status, a terminal_reason the regex does not match and a
      // message with no auth vocabulary. The live 529 envelope's api_error
      // verdict is T1's; this pins that the predicate is the ARMS, not the fixture.
      const { res } = await run('claude', JSON.stringify({ type: 'result', is_error: true, api_error_status: 500, terminal_reason: 'api_error', result: 'Request failed' }), 1);
      expect(res.fail_reason).toBe('api_error');
      expect(res.detail).toBe('Request failed (http 500)');
    });

    it('T8f — is_error:true with NO result string → api_error with a stated placeholder detail', async () => {
      const { res } = await run('claude', JSON.stringify({ type: 'result', is_error: true, api_error_status: 502 }), 1);
      expect(res.fail_reason).toBe('api_error');
      expect(res.detail).toBe('claude result envelope is_error=true (no result text) (http 502)');
    });
  });

  describe('T9 — regression pins for the paths that predate TD-447', () => {
    it('T9a — exit 1 + EMPTY stdout → non_zero_exit with the stderr tail (unchanged)', async () => {
      const { res, cleanups } = await run('claude', '', 1, 'boom');
      expect(res.ok).toBe(false);
      expect(res.fail_reason).toBe('non_zero_exit');
      expect(res.detail).toBe('exit 1: boom');
      expect(cleanups).toBe(1);
    });

    it('T9b — exit 0 + bare prose → ok:true, prose is the text (unchanged)', async () => {
      const { res } = await run('claude', 'just an answer', 0);
      expect(res.ok).toBe(true);
      expect(res.text).toBe('just an answer');
    });

    it('T9c — exit 0 + whitespace-only stdout → empty_response (unchanged)', async () => {
      const { res } = await run('claude', '  \n ', 0);
      expect(res.fail_reason).toBe('empty_response');
    });
  });
});

// ---------------------------------------------------------------------------
// T10 — composition: real runBackend → real runExtractor over a real event_log
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

describe('composition (AC-1, AC-2): the envelope never reaches the instance parser (TD-447)', () => {
  it('T10 — real runBackend inside real runExtractor: run_failed {reason:api_error, detail}, NO response_bytes, parseResponse never called', async () => {
    const db = makeEventLogDb();
    try {
      const parseResponse = vi.fn((raw: string) => {
        try {
          const arr = JSON.parse(raw) as { title: string }[];
          return Array.isArray(arr) ? arr : [];
        } catch {
          return [];
        }
      });
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
        config: { timeout_ms: 1000, daily_budget: 8, min_input_bytes: 0, enabled: true, harness: null },
        inputBytes: (ctx) => ctx.bytes,
      };
      const spawn = makeFakeSpawn();
      const deps: RunExtractorDeps = {
        isColdStart: () => false,
        resolveBackend: () => ({ harness: 'claude', fallback_order: ['claude'] }),
        // The REAL backend, with only the process boundary faked.
        runBackend: (h, p, t) => runBackend(h!, p, t, { buildSpawn: spawn.buildSpawn, runExec: fakeExec(LIVE_529, 1) }),
        autoPush: () => {},
      };

      const r = await runExtractor(db, inst, {}, deps);

      // Against HEAD this reproduces the live defect exactly: outcome failed,
      // fail_reason 'parse_error', payload.response_bytes === 147 (the lifted
      // message's length) and parseResponse called ONCE with the error text.
      expect(r.outcome).toBe('failed');
      expect(r.fail_reason).toBe('api_error');
      const rows = db.prepare('SELECT event_name, payload FROM event_log ORDER BY id').all() as { event_name: string; payload: string }[];
      expect(rows.map((e) => e.event_name)).toEqual([eventName('dummy', 'run_started'), eventName('dummy', 'run_failed')]);
      const payload = JSON.parse(rows[1].payload) as Record<string, unknown>;
      expect(payload.reason).toBe('api_error');
      expect(payload.detail).toBe(`${LIVE_529_RESULT} (http 529)`);
      expect('response_bytes' in payload).toBe(false);
      expect(parseResponse).toHaveBeenCalledTimes(0);
      expect(spawn.cleanups()).toBe(1);
      // The fixture really is the brief's 147-byte message.
      expect(LIVE_529_RESULT).toHaveLength(147);
    } finally {
      db.close();
    }
  });
});
