/**
 * Strict-input contract for igris_sync_queue_drain (TD-120).
 *
 * Decision: Option A1 (zero-dep allow-list guard).
 * Rationale: the brain has no Zod dep; adding one for a single tool's
 *   strict-mode is scope creep. The explicit Object.keys() walk gives
 *   the same guarantee with no runtime additions.
 *
 * AC bullets evidenced here:
 *   - AC-1: contract decision is recorded inline (this docstring +
 *     ALLOWED_DRAIN_KEYS docstring in sync.ts).
 *   - AC-2: ≥2 contract tests covering reject-and-no-mutation +
 *     happy-path-still-works.
 *   - AC-3: existing brain regression suite (specifically
 *     sync-push-isolation.test.ts which calls handleSyncQueueDrain
 *     with `{remote_url, api_key}` only) MUST still pass — exercised
 *     by the broader test suite.
 *
 * @module tools/__tests__/sync-queue-drain-contract.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

import { handleSyncQueueDrain } from '../sync.js';
import { getDb } from '../../db.js';
import { createGateway } from '../../engine/gateway.js';
import { createSyncComponent } from '../../engine/components/sync/index.js';

// Module-scope fixture: shared by the TD-120 (unknown-arg) block and the
// BR-080 (missing-required) block below. Both need the same seeded sync_queue
// so each can assert that a rejected call left the rows untouched.
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  // Minimal schema for the drain handler. We only need sync_queue —
  // the contract reject MUST happen BEFORE any DB work.
  db.exec(`
    CREATE TABLE sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_data TEXT NOT NULL,
      operation TEXT NOT NULL DEFAULT 'push',
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 5,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_retry_at TEXT,
      sent_at TEXT
    );
  `);
  // Seed two known rows so we can assert non-mutation post-reject.
  db.exec(`
    INSERT INTO sync_queue (table_name, row_data, operation, status, retry_count, max_retries) VALUES
      ('learnings', '{"id":1,"title":"a"}', 'push', 'pending', 0, 5),
      ('learnings', '{"id":2,"title":"b"}', 'push', 'pending', 0, 5);
  `);
  vi.mocked(getDb).mockReturnValue(db);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('igris_sync_queue_drain — strict-input contract (TD-120)', () => {
  it('rejects unknown argument key with informative error AND does NOT mutate sync_queue', async () => {
    await expect(
      handleSyncQueueDrain({
        remote_url: 'http://test.local',
        api_key: 'k',
        // The exact silent-data-loss class M4 self-heal exposed.
        local_entries: [{ bogus: true }],
      } as unknown as Parameters<typeof handleSyncQueueDrain>[0]),
    ).rejects.toThrow(/unknown argument 'local_entries'/);

    // Pre-existing rows MUST NOT have been mutated.
    const rowsAfter = db
      .prepare('SELECT id, status, retry_count FROM sync_queue ORDER BY id')
      .all();
    expect(rowsAfter).toEqual([
      { id: 1, status: 'pending', retry_count: 0 },
      { id: 2, status: 'pending', retry_count: 0 },
    ]);
  });

  it('rejects multiple unknown keys with the FIRST offending key in the error', async () => {
    // The Object.keys() order isn't strictly portable across runtimes
    // but Node guarantees insertion order for string keys. Test that
    // the FIRST extra key (in insertion order) is what surfaces.
    await expect(
      handleSyncQueueDrain({
        remote_url: 'http://test.local',
        api_key: 'k',
        bogus_first: 1,
        bogus_second: 2,
      } as unknown as Parameters<typeof handleSyncQueueDrain>[0]),
    ).rejects.toThrow(/unknown argument 'bogus_first'/);
  });
});

/**
 * BR-080 — the missing-required half of the strict-input contract.
 *
 * The bug: a no-arg `igris_sync_queue_drain()` reached the handler and blew up
 * on `args.remote_url.replace(...)` (`sync.ts`) with a bare
 * `TypeError: Cannot read properties of undefined (reading 'replace')`, because
 * `gateway.dispatch` validated only UNKNOWN keys and never read
 * `inputSchema.required`.
 *
 * WHAT THIS GATE PROVES: routed through the real `gateway.dispatch` — the same
 * entrypoint production uses from both transports (`src/index.ts` stdio
 * `CallToolRequestSchema` handler and the HTTP direct-dispatch fallback) — a
 * no-arg drain call is rejected by the gateway with a message that NAMES the
 * missing key, and the handler is never entered.
 *
 * WHAT IT DOES NOT PROVE: that any OTHER tool's `required` list is enforced
 * (sibling: the parameterized coverage gate in
 * `engine/__tests__/gateway-strict-input.test.ts`), nor that the drain still
 * works when the args ARE supplied (sibling: the `A2-gw` gateway-routed drain in
 * `src/__tests__/sync-push-isolation.test.ts`).
 *
 * WHY THE `.not.toMatch` HALF IS MANDATORY: the call ALREADY throws against the
 * unfixed build. A bare `rejects.toThrow()` would be GREEN before the fix and
 * would prove nothing — the mis-titled-guard class. The negative assertion is
 * what makes this test red-first.
 */
describe('igris_sync_queue_drain — missing-required contract (BR-080)', () => {
  function makeGateway() {
    const gateway = createGateway();
    gateway.register(createSyncComponent().tools());
    return gateway;
  }

  /** Reject-capture that fails loudly if the call unexpectedly RESOLVES. */
  async function captureRejection(p: Promise<unknown>): Promise<Error> {
    return p.then(
      () => {
        throw new Error(
          'expected gateway.dispatch to REJECT, but it resolved — the guard did not fire',
        );
      },
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    );
  }

  it('no-arg call through gateway.dispatch names the missing key and is NOT the raw TypeError', async () => {
    const gateway = makeGateway();

    const err = await captureRejection(
      gateway.dispatch('igris_sync_queue_drain', {}),
    );

    // The NEW, actionable message.
    expect(err.message).toMatch(
      /igris_sync_queue_drain: missing required argument 'remote_url'/,
    );
    expect(err.message).toMatch(/Required: remote_url, api_key/);
    // The OLD symptom must be gone. Without this half the test is satisfied by
    // the pre-fix TypeError and is a vacuous gate (BR-080 R1).
    expect(err.message).not.toMatch(/Cannot read properties of undefined/);

    // The guard fires BEFORE the handler: seeded rows are untouched.
    const rowsAfter = db
      .prepare('SELECT id, status, retry_count FROM sync_queue ORDER BY id')
      .all();
    expect(rowsAfter).toEqual([
      { id: 1, status: 'pending', retry_count: 0 },
      { id: 2, status: 'pending', retry_count: 0 },
    ]);
  });

  it('partial args (remote_url only) reject on the SECOND missing key, api_key', async () => {
    const gateway = makeGateway();

    const err = await captureRejection(
      gateway.dispatch('igris_sync_queue_drain', {
        remote_url: 'http://test.local',
      }),
    );

    expect(err.message).toMatch(
      /igris_sync_queue_drain: missing required argument 'api_key'/,
    );
    expect(err.message).not.toMatch(/Cannot read properties of undefined/);
  });

  it('guard error never echoes an argument VALUE (secrets stay out of messages)', async () => {
    const gateway = makeGateway();
    // api_key present, remote_url missing → the guard reports remote_url. The
    // supplied value must not appear anywhere in the message.
    //
    // THE LITERAL IS DELIBERATELY SCANNER-SAFE. `.gitleaks.toml` rule
    // `igris-api-key-assignment` matches any `api_key: '<20+ chars of
    // [A-Za-z0-9+/_=-]>'`, and the pre-commit hook runs `gitleaks protect
    // --staged --config .gitleaks.toml` — so a realistic-looking literal here
    // blocks the commit. This value clears the rule twice over: it is under
    // 20 characters AND it carries the allowlisted `fake` token. The test's
    // meaning is unchanged; it needs a distinctive value, not a plausible one.
    const suppliedValue = 'fake-secret-value';
    const err = await captureRejection(
      gateway.dispatch('igris_sync_queue_drain', {
        api_key: suppliedValue,
      }),
    );

    expect(err.message).toMatch(/missing required argument 'remote_url'/);
    expect(err.message).not.toContain(suppliedValue);
  });
});
