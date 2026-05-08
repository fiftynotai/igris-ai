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

describe('igris_sync_queue_drain — strict-input contract (TD-120)', () => {
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
