/**
 * TD-477 — unit tests for the TD-472 probe's `--egress` mode: the local
 * listener, the fetch-eliciting prompt shape, and the verdict logic. No real
 * harness CLI is ever spawned here and no third-party network is reached —
 * the listener binds to `127.0.0.1` on an OS-assigned port and every request
 * in this file is made by the test itself, over loopback, to prove the
 * counting mechanism (test_standards: no live network calls means no call to
 * a real harness / a real remote host, not "no local socket").
 *
 * Cases:
 *   egressPrompt(url) — a light pure-function shape pin (no live network).
 *   egressVerdict(n)  — the pure hit/miss → EGRESS_HIT/NO_EGRESS mapping.
 *   startLocalListener() — a request to the nonce path is counted, a request
 *     to a DIFFERENT path is not, and the server closes cleanly.
 *   agyStreamSteps(stdout, stderr) — the stream-json tool-step + stderr
 *     auto-deny parser, over canned text (never a live agy call).
 *
 * @module scripts/__tests__/td472_egress.test
 */

import { get as httpGet } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { agyStreamSteps, egressPrompt, egressVerdict, startLocalListener } from '../td472_child_env_probe.js';

describe('TD-477 — egressPrompt shape', () => {
  it('names the URL in a tool-eliciting user body, with a NEUTRAL system body (never the benign "reply OK")', () => {
    const url = 'http://127.0.0.1:54321/deadbeef';
    const prompt = egressPrompt(url);
    expect(prompt).toEqual({
      system: 'You are a connectivity test harness.',
      user: `Use any web or URL-fetch tool you have to GET ${url} and reply with exactly the response body. If you cannot fetch URLs, reply exactly NO_FETCH.`,
    });
    // the benign system body makes a model answer OK without trying a tool (measured)
    expect(prompt.system).not.toMatch(/Reply with exactly: OK/);
  });

  it('carries a DIFFERENT url verbatim — the prompt is a pure function of its argument', () => {
    const url = 'http://127.0.0.1:1/another-nonce';
    expect(egressPrompt(url).user).toContain(`GET ${url} and reply`);
  });
});

describe('TD-477 — egressVerdict', () => {
  it('reads NO_EGRESS at zero hits', () => {
    expect(egressVerdict(0)).toBe('NO_EGRESS');
  });

  it('reads EGRESS_HIT at one hit', () => {
    expect(egressVerdict(1)).toBe('EGRESS_HIT');
  });

  it('reads EGRESS_HIT at more than one hit — any hit overrides', () => {
    expect(egressVerdict(7)).toBe('EGRESS_HIT');
  });
});

describe('TD-477 — startLocalListener', () => {
  let closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.map((close) => close()));
    closers = [];
  });

  it('binds to 127.0.0.1 with an OS-assigned port and a per-run nonce path', async () => {
    const listener = await startLocalListener();
    closers.push(listener.close);
    expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    expect(listener.hits()).toBe(0);
  });

  it('counts a request to the nonce path as a hit', async () => {
    const listener = await startLocalListener();
    closers.push(listener.close);
    await new Promise<void>((resolveGet, rejectGet) => {
      httpGet(listener.url, (res) => {
        res.resume();
        res.on('end', resolveGet);
      }).on('error', rejectGet);
    });
    expect(listener.hits()).toBe(1);
  });

  it('does NOT count a request to a different path on the same listener', async () => {
    const listener = await startLocalListener();
    closers.push(listener.close);
    const otherUrl = listener.url.replace(/\/[0-9a-f]{32}$/, '/not-the-nonce');
    await new Promise<void>((resolveGet, rejectGet) => {
      httpGet(otherUrl, (res) => {
        res.resume();
        res.on('end', resolveGet);
      }).on('error', rejectGet);
    });
    expect(listener.hits()).toBe(0);
  });

  it('two independent listeners mint two different nonces and ports', async () => {
    const a = await startLocalListener();
    const b = await startLocalListener();
    closers.push(a.close, b.close);
    expect(a.url).not.toBe(b.url);
  });

  it('close() releases the port — a fresh listener can bind again immediately after', async () => {
    const first = await startLocalListener();
    await first.close();
    const second = await startLocalListener();
    closers.push(second.close);
    expect(second.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
  });
});

describe('TD-477 — agyStreamSteps', () => {
  // Fixtures follow agy 1.2.11's MEASURED stream-json shape (plans/td476-evidence/agy-stream-json-reads-*,
  // td477-evidence/egress-agy-stream-*): step types live under `step_update`, not a top-level `type`.
  const step = (step_type: string, state: string) =>
    JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'fx', step_index: 1, state, step_type } });
  it('reads tool step states, deduplicated in first-seen order, over the measured stream-json shape', () => {
    const stdout = [
      JSON.stringify({ event: 'init', init: { cwd: 'fx', tools: ['view_file'], permission_mode: 'request-review' } }),
      step('user_input', 'DONE'),
      step('agent_response', 'DONE'),
      step('tool', 'ACTIVE'),
      step('tool', 'ACTIVE'),
      step('tool', 'ERROR'),
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }),
      '',
    ].join('\n');
    const result = agyStreamSteps(stdout, '');
    expect(result.steps).toEqual(['tool:ACTIVE', 'tool:ERROR']);
    expect(result.stderr_auto_denied).toBe(false);
  });

  it('ignores non-tool step types, other events and unparseable lines', () => {
    const stdout = [step('user_input', 'DONE'), step('agent_response', 'ACTIVE'), 'not json at all', '{"type":"tool_call","status":"DONE"}'].join('\n');
    expect(agyStreamSteps(stdout, '').steps).toEqual([]);
  });

  it('flags the measured stderr auto-deny phrasing', () => {
    const stderr = 'a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.';
    expect(agyStreamSteps('', stderr).stderr_auto_denied).toBe(true);
  });

  it('does not flag ordinary stderr text', () => {
    expect(agyStreamSteps('', 'warning: something unrelated').stderr_auto_denied).toBe(false);
  });
});
