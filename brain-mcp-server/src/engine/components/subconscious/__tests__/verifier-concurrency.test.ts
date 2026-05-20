/**
 * Verifier — concurrency-cap tests (BR-067).
 *
 * BR-067 amplifier: the headless verifier spawns one `claude -p` subprocess
 * per conflict pair, and each `claude -p` spawns a brain-mcp-server. With no
 * cap, a misfiring schedules daemon (or a future `Promise.all` batching
 * change in the runner) turns a logic bug into a host-pinning process storm.
 *
 * Phase 3b adds an unconditional process-wide concurrency cap. These tests
 * fire many verifier calls concurrently against a SLOW stub subprocess and
 * assert the in-flight `claude -p` spawn count never exceeds the cap.
 *
 * The stub is `node -e` with a short sleep — no real `claude` invocation.
 *
 * @module engine/components/subconscious/__tests__/verifier-concurrency.test
 */

import { describe, it, expect } from 'vitest';
import {
  makeClaudeHeadlessVerifier,
  verifierInFlightSpawns,
} from '../verifier.js';

// The cap declared in verifier.ts (MAX_CONCURRENT_VERIFIER_SPAWNS). Kept in
// sync intentionally — if the cap changes, this test should be updated to
// match, which is the desired forcing function.
const EXPECTED_CAP = 2;

/**
 * A stub subprocess that sleeps `ms` then emits a valid verifier reply.
 * The sleep keeps the subprocess in flight long enough for overlapping
 * verifier calls to contend for spawn permits.
 */
function slowStubVerifier(ms: number) {
  return makeClaudeHeadlessVerifier({
    command: 'node',
    args: [
      '-e',
      `setTimeout(() => process.stdout.write('{"is_conflict": false, "reason": "stub"}'), ${ms})`,
    ],
    timeoutMs: 10_000,
  });
}

const learningA = { id: 1, content: 'a', created_at: 'x' };
const learningB = { id: 2, content: 'b', created_at: 'y' };

describe('verifier concurrency cap (BR-067)', () => {
  it('never exceeds the spawn cap when many verifier calls race', async () => {
    const verifier = slowStubVerifier(120);

    // Fire 8 verifier calls at once — far more than the cap. The semaphore
    // must queue the excess so in-flight spawns stay <= EXPECTED_CAP.
    const calls = Array.from({ length: 8 }, () => verifier(learningA, learningB));

    // Poll the in-flight gauge while the calls race. Record the peak.
    let peak = 0;
    const poll = setInterval(() => {
      peak = Math.max(peak, verifierInFlightSpawns());
    }, 5);

    const results = await Promise.all(calls);
    clearInterval(poll);
    // One last sample after settle — should be back to zero.
    peak = Math.max(peak, verifierInFlightSpawns());

    expect(peak).toBeGreaterThan(0);            // the gate was actually exercised
    expect(peak).toBeLessThanOrEqual(EXPECTED_CAP);

    // Every call still completed correctly — the cap throttles, never drops.
    expect(results).toHaveLength(8);
    for (const r of results) {
      expect(r.is_conflict).toBe(false);
      expect(r.status).toBe('verified');
    }
  });

  it('drains all permits back to zero after the calls settle', async () => {
    const verifier = slowStubVerifier(30);
    await Promise.all([
      verifier(learningA, learningB),
      verifier(learningA, learningB),
      verifier(learningA, learningB),
      verifier(learningA, learningB),
    ]);
    // If a permit leaked (e.g. release missed on a path) this would be > 0.
    expect(verifierInFlightSpawns()).toBe(0);
  });

  it('releases the permit on the spawn-failure path (cap not starved)', async () => {
    // A missing binary fails the spawn — the permit must still be released
    // so a failed spawn cannot permanently consume a cap slot.
    const failing = makeClaudeHeadlessVerifier({
      command: '/nonexistent/binary/br067',
      args: [],
      timeoutMs: 5_000,
    });
    const results = await Promise.all([
      failing(learningA, learningB),
      failing(learningA, learningB),
      failing(learningA, learningB),
      failing(learningA, learningB),
    ]);
    for (const r of results) {
      expect(r.status).toBe('spawn_failed');
    }
    // All permits released despite every spawn failing.
    expect(verifierInFlightSpawns()).toBe(0);

    // And the gate still works afterwards — a fresh call completes.
    const ok = slowStubVerifier(10);
    const result = await ok(learningA, learningB);
    expect(result.status).toBe('verified');
    expect(verifierInFlightSpawns()).toBe(0);
  });
});
