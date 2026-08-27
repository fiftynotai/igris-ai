/**
 * BR-066 — /sync/push per-table isolation regression tests.
 *
 * Background:
 *   The pre-fix /sync/push wrapped every SYNC_TABLES merge in a single
 *   global db.transaction(). One bad row in any table threw → the entire
 *   transaction aborted → the catch returned HTTP 500 → all 500 rows in
 *   the chunk hit retry as a unit, with a generic "HTTP 500" error
 *   message offering zero diagnostic value.
 *
 * Fix (BR-066):
 *   - mergeRows wraps each row's body in its own try/catch and surfaces
 *     {failed, failures: [{key, error}]} so a single bad row no longer
 *     poisons sibling rows in the same call.
 *   - processSyncPush wraps each table's mergeRows call in its own
 *     db.transaction() with a per-table try/catch so a table-level error
 *     (e.g. prepare failure on schema mismatch) does not poison sibling
 *     tables.
 *
 * These tests exercise the real processSyncPush against a real in-memory
 * SQLite DB — NO mocks of the bug-surface code (mergeRows, processSyncPush
 * itself, or the SYNC_TABLES iteration). Per Learning #159, mocking the
 * code under test erases the bug surface this test exists to defend.
 *
 * @module __tests__/sync-push-isolation.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { processSyncPush, SYNC_TABLES } from '../tools/sync.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build an in-memory DB with the columns relevant to this test plus stub
 * tables for the rest of SYNC_TABLES so the iteration finds them. Mirrors
 * the schema from sync.test.ts but adds CHECK constraints we want to
 * trigger (notably learnings.category) and column types that catch the
 * Buffer-binding failure mode (brief_files.content TEXT NOT NULL).
 */
function makeBriefIsolationDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF'); // FK enforcement creates noise across SYNC_TABLES

  // The five tables we test directly. Schemas mirror the production brain.
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

    CREATE TABLE brief_files (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN
        ('pattern','decision','discovery','mistake','optimization')),
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tags TEXT DEFAULT '',
      tech_stack TEXT DEFAULT '',
      scope TEXT DEFAULT 'local' CHECK (scope IN ('local','global')),
      source_brief TEXT DEFAULT '',
      confidence REAL DEFAULT 0.8,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT,
      review_status TEXT DEFAULT 'approved',
      provenance TEXT DEFAULT 'human_asserted',
      source_extractor TEXT,
      promoted_to_doc TEXT,
      UNIQUE(project, category, title)
    );

    CREATE TABLE brief_status (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      status TEXT NOT NULL,
      brief_type TEXT,
      title TEXT,
      priority TEXT,
      effort TEXT,
      phase TEXT,
      tags TEXT DEFAULT '',
      slug TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      UNIQUE(project, brief_id)
    );

    -- BR-083 edges@4 shape: nullable qualifiers and an EXPRESSION unique
    -- index (a table-level UNIQUE would treat two NULL qualifiers as distinct
    -- and break idempotency for every project-less edge). A receiver that has
    -- NOT migrated is a different scenario and has its own test below.
    CREATE TABLE entity_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_type TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_type TEXT NOT NULL,
      to_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      provenance TEXT NOT NULL DEFAULT 'observed',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT NOT NULL DEFAULT '{}',
      from_project TEXT,
      to_project TEXT
    );
    CREATE UNIQUE INDEX idx_edges_unique ON entity_edges(
      from_type, from_id, COALESCE(from_project, ''),
      to_type, to_id, COALESCE(to_project, ''), edge_type);
  `);

  // Stub the rest of SYNC_TABLES so iteration finds them but they are
  // empty. Skip ones we already created above.
  const created = new Set(['event_log','brief_files','learnings','brief_status','entity_edges']);
  for (const config of SYNC_TABLES) {
    if (created.has(config.table)) continue;
    const colDefs = config.columns.map((c) => `${c} TEXT`).join(', ');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS ${config.table} (${colDefs});`);
    } catch {
      db.exec(`CREATE TABLE IF NOT EXISTS ${config.table} (${config.timestampCol} TEXT);`);
    }
  }

  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BR-066 /sync/push per-table isolation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeBriefIsolationDb();
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // The headline regression: bad row in learnings does not kill event_log.
  // (TD-265 retargeted this from the removed `tasks` table to `learnings` —
  // another SYNC_TABLES entry with a CHECK constraint to violate.)
  // -------------------------------------------------------------------------

  it('a bad row in learnings (CHECK violation) does NOT prevent event_log inserts', () => {
    const tables = {
      event_log: [
        { id: 1001, event_name: 'session.started', component: 'monitoring', payload: '{}', created_at: '2026-05-05T10:00:00Z' },
        { id: 1002, event_name: 'session.ended', component: 'monitoring', payload: '{}', created_at: '2026-05-05T10:00:01Z' },
        { id: 1003, event_name: 'brief.synced', component: 'briefs', payload: '{}', created_at: '2026-05-05T10:00:02Z' },
      ],
      learnings: [
        { project: 'p', category: 'pattern', title: 'good learning', content: 'ok', created_at: '2026-05-05T10:00:00Z' },
        { project: 'p', category: 'garbage-not-in-check', title: 'bad learning', content: 'bad', created_at: '2026-05-05T10:00:00Z' },
      ],
      brief_status: [
        { id: 'bs-1', project: 'p', brief_id: 'BR-066', status: 'In Progress', updated_at: '2026-05-05T10:00:00Z' },
      ],
    };

    const result = processSyncPush(db, tables);

    // event_log + brief_status merged cleanly; learnings had 1 row failure but
    // its transaction still committed (because mergeRows row-level catch
    // kept the txn alive).
    expect(result.results.event_log.inserted).toBe(3);
    expect(result.results.brief_status.inserted).toBe(1);
    expect(result.results.learnings.inserted).toBe(1);  // good row inserted
    expect(result.results.learnings.failed).toBe(1);    // bad row recorded
    expect(result.results.learnings.failures).toBeDefined();
    // syncKey is [project, category, title] → composite key joined by '|'.
    expect(result.results.learnings.failures![0].key).toBe('p|garbage-not-in-check|bad learning');
    expect(result.results.learnings.failures![0].error).toMatch(/CHECK constraint/i);

    // No table-level errors — per-table txn isolation worked.
    expect(result.errors).toEqual({});
    expect(result.ok).toBe(true);

    // DB state confirms: event_log rows are present, bad learning is absent.
    const elCount = db.prepare('SELECT COUNT(*) as c FROM event_log').get() as { c: number };
    expect(elCount.c).toBe(3);
    const goodLearning = db.prepare("SELECT id FROM learnings WHERE title='good learning'").get();
    expect(goodLearning).toBeDefined();
    const badLearning = db.prepare("SELECT id FROM learnings WHERE title='bad learning'").get();
    expect(badLearning).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The literal BR-066 wire-format crash: brief_files.content as a Buffer.
  // -------------------------------------------------------------------------

  it('a Buffer-shaped brief_files.content does NOT poison sibling tables', () => {
    const tables = {
      event_log: [
        { id: 2001, event_name: 'brief.synced', component: 'briefs', payload: '{}', created_at: '2026-05-05T11:00:00Z' },
      ],
      brief_files: [
        // The exact failure mode that produced the live BR-066 incident:
        // content is a serialized Node.js Buffer object {type:"Buffer",data:[...]},
        // which better-sqlite3 cannot bind. Pre-fix this threw inside the
        // global transaction and aborted all sibling table merges.
        {
          project: 'p',
          brief_id: 'FR-111',
          filename: 'FR-111.md',
          content: { type: 'Buffer', data: [35, 32, 70, 82] },
          content_hash: 'deadbeef',
          updated_at: '2026-05-05T11:00:00Z',
        },
      ],
      entity_edges: [
        { from_type: 'brief', from_id: 'TD-099', to_type: 'brief', to_id: 'FR-111', edge_type: 'parent_of', confidence: 1, provenance: 'observed', created_at: '2026-05-05T11:00:00Z', metadata: '{}' },
      ],
    };

    const result = processSyncPush(db, tables);

    // event_log and entity_edges merged cleanly.
    expect(result.results.event_log.inserted).toBe(1);
    expect(result.results.entity_edges.inserted).toBe(1);

    // brief_files has 1 row failure with a SPECIFIC error (not "HTTP 500").
    expect(result.results.brief_files.inserted).toBe(0);
    expect(result.results.brief_files.failed).toBe(1);
    expect(result.results.brief_files.failures).toBeDefined();
    expect(result.results.brief_files.failures![0].key).toBe('p|FR-111');
    expect(result.results.brief_files.failures![0].error).toMatch(/Too few parameter values|cannot bind/i);

    // No table-level errors. ok=true because per-table txn committed
    // (row-level catch in mergeRows means the txn never threw).
    expect(result.errors).toEqual({});
    expect(result.ok).toBe(true);

    // DB state: event_log + entity_edges present, brief_files absent.
    const ev = db.prepare('SELECT COUNT(*) as c FROM event_log').get() as { c: number };
    expect(ev.c).toBe(1);
    const ee = db.prepare('SELECT COUNT(*) as c FROM entity_edges').get() as { c: number };
    expect(ee.c).toBe(1);
    const bf = db.prepare('SELECT COUNT(*) as c FROM brief_files').get() as { c: number };
    expect(bf.c).toBe(0);
  });

  // -------------------------------------------------------------------------
  // BR-083 R2 — the deploy-ordering hazard, pinned rather than described.
  // -------------------------------------------------------------------------

  it('BR-083: a receiver that has NOT run edges@4 fails entity_edges ALONE, loudly', () => {
    // THE HAZARD: `SYNC_TABLES.entity_edges.columns` now names two columns a
    // pre-edges@4 receiver does not have, so the VPS MUST migrate before the
    // first push. This test pins what happens if that ordering is broken:
    // entity_edges fails with a message that NAMES the missing column, every
    // sibling table still merges, and the failure is reported rather than
    // swallowed. That is the difference between an operator who reads
    // "no such column: from_project" and one who reads "HTTP 500".
    const stale = makeBriefIsolationDb();
    stale.exec('DROP TABLE entity_edges');
    stale.exec(`
      CREATE TABLE entity_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_type TEXT NOT NULL, from_id TEXT NOT NULL,
        to_type TEXT NOT NULL, to_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        provenance TEXT NOT NULL DEFAULT 'observed',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(from_type, from_id, to_type, to_id, edge_type)
      );
    `);

    const result = processSyncPush(stale, {
      event_log: [
        {
          id: 3001, event_name: 'brief.synced', component: 'briefs',
          payload: '{}', created_at: '2026-05-05T11:00:00Z',
        },
      ],
      entity_edges: [
        {
          from_type: 'brief', from_id: 'TD-099', to_type: 'brief', to_id: 'FR-111',
          edge_type: 'parent_of', confidence: 1, provenance: 'observed',
          created_at: '2026-05-05T11:00:00Z', metadata: '{}',
          from_project: 'igris-ai', to_project: 'igris-ai',
        },
      ],
    });

    // The sibling merged — isolation held.
    expect(result.results.event_log.inserted).toBe(1);

    // entity_edges did NOT, and the reason names the column. Whether the
    // failure surfaces per-table or per-row, it must be VISIBLE and specific.
    const edgeErr =
      result.errors.entity_edges ??
      result.results.entity_edges?.failures?.[0]?.error ??
      '';
    expect(String(edgeErr)).toMatch(/no such column: from_project/i);
    expect(
      (stale.prepare('SELECT COUNT(*) as c FROM entity_edges').get() as { c: number }).c,
    ).toBe(0);
    stale.close();
  });

  // -------------------------------------------------------------------------
  // All-good path remains all-good — no regression for healthy chunks.
  // -------------------------------------------------------------------------

  it('a clean payload still returns ok=true with empty errors', () => {
    const tables = {
      event_log: [
        { id: 3001, event_name: 'a', component: 'c', payload: '{}', created_at: '2026-05-05T12:00:00Z' },
        { id: 3002, event_name: 'b', component: 'c', payload: '{}', created_at: '2026-05-05T12:00:01Z' },
      ],
    };

    const result = processSyncPush(db, tables);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual({});
    expect(result.skipped).toEqual([]); // BR-097: always present
    expect(result.results.event_log.inserted).toBe(2);
    expect(result.results.event_log.failed).toBe(0);
    expect(result.results.event_log.failures).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // BR-064 carry-over: missing local table is skipped, not thrown.
  // -------------------------------------------------------------------------

  it('a SYNC_TABLES entry whose local table was DROPPED is skipped without crashing siblings', () => {
    db.exec('DROP TABLE goals');

    const tables = {
      event_log: [
        { id: 4001, event_name: 'a', component: 'c', payload: '{}', created_at: '2026-05-05T13:00:00Z' },
      ],
      goals: [
        { goal_id: 'g-1', project_slug: 'p', title: 't', status: 'pending', updated_at: '2026-05-05T13:00:00Z' },
      ],
    };

    const result = processSyncPush(db, tables);

    // event_log went through; goals was skipped with a stderr log.
    expect(result.results.event_log.inserted).toBe(1);
    expect(result.results.goals).toBeUndefined();
    // BR-097 (2026-08-27): a skipped table is now VISIBLE — `ok` false (the
    // route answers 207) and `skipped` names it; `errors.goals` stays
    // undefined so a pre-BR-097 client never queues a skip. Pinned `ok: true`
    // before this brief — the skip was invisible, so FR-268's early push could
    // not tell a skipped table from a merged one; the stamp itself was
    // `handleBrainPush`'s unconditional loop (T1 in sync.test.ts pins that
    // half; this pin covers visibility — plan M2 reds this and T6 while T1
    // stays green).
    expect(result.errors.goals).toBeUndefined();
    expect(result.skipped).toEqual(['goals']);
    expect(result.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Empty payload — no-op.
  // -------------------------------------------------------------------------

  it('an empty tables payload returns ok=true with empty results and errors', () => {
    const result = processSyncPush(db, {});
    expect(result.ok).toBe(true);
    expect(result.results).toEqual({});
    expect(result.errors).toEqual({});
    expect(result.skipped).toEqual([]); // BR-097: always present
  });
});

// ---------------------------------------------------------------------------
// handleSyncQueueDrain bisect-on-failure — exercises the full drain path
// through a mocked fetch. Per Learning #159, we mock the EXTERNAL boundary
// (globalThis.fetch) but NOT the bug-surface code (handleSyncQueueDrain
// itself, mergeRows, processSyncPush, the bisect algorithm).
// ---------------------------------------------------------------------------

import { vi } from 'vitest';
import { handleSyncQueueDrain } from '../tools/sync.js';
import { createGateway } from '../engine/gateway.js';
import { createSyncComponent } from '../engine/components/sync/index.js';

// We need handleSyncQueueDrain to read from a real DB. Mock getDb to point
// at the test DB. This is a boundary mock (the DB factory), not the SUT.
vi.mock('../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

import { getDb } from '../db.js';
const mockedGetDb = vi.mocked(getDb);

function makeDrainDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  // Reuse the schema-builder from the isolation test fixtures and add
  // sync_queue + sync_state which are needed by handleSyncQueueDrain.
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
    CREATE TABLE sync_state (
      remote_url TEXT NOT NULL,
      table_name TEXT NOT NULL,
      last_push_at TEXT,
      last_pull_at TEXT,
      PRIMARY KEY (remote_url, table_name)
    );
  `);
  // Stub the rest of SYNC_TABLES so processSyncPush can iterate.
  for (const config of SYNC_TABLES) {
    if (config.table === 'event_log') continue;
    const colDefs = config.columns.map((c) => `${c} TEXT`).join(', ');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS ${config.table} (${colDefs});`);
    } catch {
      db.exec(`CREATE TABLE IF NOT EXISTS ${config.table} (${config.timestampCol} TEXT);`);
    }
  }
  return db;
}

describe('BR-066 handleSyncQueueDrain — bisect-on-failure + 207 partial success', () => {
  let db: Database.Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = makeDrainDb();
    mockedGetDb.mockReturnValue(db);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
    vi.restoreAllMocks();
  });

  /** Seed N actionable event_log rows into sync_queue. */
  function seedPendingRows(count: number): void {
    const insert = db.prepare(`
      INSERT INTO sync_queue (table_name, row_data, status, retry_count, max_retries)
      VALUES (?, ?, 'pending', 0, 5)
    `);
    for (let i = 1; i <= count; i++) {
      insert.run(
        'event_log',
        JSON.stringify({
          id: i,
          event_name: `e${i}`,
          component: 'c',
          payload: '{}',
          created_at: `2026-05-05T00:00:0${i}Z`,
        }),
      );
    }
  }

  /** Count rows in sync_queue by status, read back from the DB. */
  function statusCounts(): Record<string, number> {
    const rows = db
      .prepare('SELECT status, COUNT(*) as c FROM sync_queue GROUP BY status')
      .all() as Array<{ status: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }

  /** Remote that accepts everything. */
  function stubOkFetch(inserted: number): void {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, results: { event_log: { inserted, updated: 0, skipped: 0, failed: 0 } }, errors: {} }),
      text: async () => '',
    })) as unknown as typeof globalThis.fetch;
  }

  it('marks all rows as sent when remote returns ok=true', async () => {
    seedPendingRows(3);
    stubOkFetch(3);

    // BR-080 PRE-STATE ASSERTION — read back from sync_queue, NOT from the
    // insert statement's return. `handleSyncQueueDrain` short-circuits with
    // "Sync queue is empty. No items to drain." when the queue holds nothing
    // actionable, so without this line the post-state assertions below are
    // satisfiable by a fixture that never seeded anything: `map.sent` would be
    // undefined... but so would `map.pending`, and the whole test would be
    // proving that an empty queue stays empty. The pre-check is what makes the
    // post-check mean "the drain MOVED N rows."
    const before = statusCounts();
    expect(before.pending).toBe(3);
    expect(before.sent ?? 0).toBe(0);

    const result = await handleSyncQueueDrain({
      remote_url: 'http://test-remote.local',
      api_key: 'test',
    });

    const text = (result.content?.[0]?.text as string) ?? '';
    expect(text).toMatch(/drain completed successfully/i);
    expect(text).not.toMatch(/queue is empty/i);

    const after = statusCounts();
    expect(after.sent).toBe(3);
    expect(after.pending ?? 0).toBe(0);
  });

  /**
   * BR-080 A2-gw — the SAME fixture routed through the real `gateway.dispatch`
   * with valid args, rather than calling the handler directly.
   *
   * WHAT THIS PROVES: the new missing-required guard sits IN FRONT OF a drain
   * that still works. This is the liveness half of the BR-080 guard — it uses
   * the same wake-up path as the rejection tests in
   * `src/tools/__tests__/sync-queue-drain-contract.test.ts` (a real gateway,
   * the real registered `igris_sync_queue_drain` tool, `gateway.dispatch`), so
   * a guard that had been made unconditional would fail HERE rather than
   * hiding behind a suite of tests that only ever observe rejections.
   *
   * WHAT IT DOES NOT PROVE: anything about the missing-arg case (sibling: the
   * R1 regression test), nor that the remote actually accepted the rows
   * (`globalThis.fetch` is stubbed — the remote boundary is out of scope here).
   */
  it('A2-gw: the same populated queue drains when routed through gateway.dispatch', async () => {
    seedPendingRows(3);
    stubOkFetch(3);

    const gateway = createGateway();
    gateway.register(createSyncComponent().tools());

    const before = statusCounts();
    expect(before.pending).toBe(3);
    expect(before.sent ?? 0).toBe(0);

    const result = await gateway.dispatch('igris_sync_queue_drain', {
      remote_url: 'http://test-remote.local',
      api_key: 'test',
    });

    const text = (result.content?.[0]?.text as string) ?? '';
    expect(text).toMatch(/drain completed successfully/i);
    expect(text).not.toMatch(/queue is empty/i);

    const after = statusCounts();
    expect(after.sent).toBe(3);
    expect(after.pending ?? 0).toBe(0);
  });

  it('on HTTP 207 with per-table errors, marks failed-table rows retrying with table-specific message', async () => {
    const insert = db.prepare(`
      INSERT INTO sync_queue (table_name, row_data, status, retry_count, max_retries)
      VALUES (?, ?, 'pending', 0, 5)
    `);
    insert.run('event_log', JSON.stringify({ id: 1, event_name: 'a', component: 'c', payload: '{}', created_at: '2026-05-05T00:00:00Z' }));
    insert.run('learnings', JSON.stringify({ project: 'p', category: 'INVALID', title: 't', content: 'c' }));

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 207,
      json: async () => ({
        ok: false,
        results: { event_log: { inserted: 1, updated: 0, skipped: 0, failed: 0 } },
        errors: { learnings: 'CHECK constraint failed: category' },
      }),
      text: async () => '',
    })) as unknown as typeof globalThis.fetch;

    await handleSyncQueueDrain({ remote_url: 'http://test-remote.local', api_key: 'test' });

    const sent = db.prepare("SELECT * FROM sync_queue WHERE status='sent'").all() as Array<{table_name:string}>;
    const retrying = db.prepare("SELECT * FROM sync_queue WHERE status='retrying'").all() as Array<{table_name:string;error_message:string}>;
    expect(sent).toHaveLength(1);
    expect(sent[0].table_name).toBe('event_log');
    expect(retrying).toHaveLength(1);
    expect(retrying[0].table_name).toBe('learnings');
    expect(retrying[0].error_message).toMatch(/HTTP 207/);
    expect(retrying[0].error_message).toMatch(/table=learnings/);
    expect(retrying[0].error_message).toMatch(/CHECK constraint/);
  });

  it('on wholesale failure, bisects and surfaces a SPECIFIC row diagnostic when isolated to one row', async () => {
    // Seed 4 event_log rows. Mock fetch to throw a 4xx-prefixed error
    // every time — fetchWithRetry treats `HTTP 4xx` as fatal and skips
    // its exponential backoff, so the bisect runs fast in tests. The
    // production behavior we care about (bisect on wholesale failure)
    // is identical regardless of whether the wholesale failure was a
    // 4xx, 5xx, or network error.
    const insert = db.prepare(`
      INSERT INTO sync_queue (table_name, row_data, status, retry_count, max_retries)
      VALUES (?, ?, 'pending', 0, 5)
    `);
    for (let i = 1; i <= 4; i++) {
      insert.run('event_log', JSON.stringify({ id: i, event_name: 'e', component: 'c', payload: '{}', created_at: `2026-05-05T00:00:0${i}Z` }));
    }

    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      // 4xx-prefixed message → fetchWithRetry rethrows immediately, no backoff.
      throw new Error('HTTP 400: synthetic test wholesale failure');
    }) as unknown as typeof globalThis.fetch;

    await handleSyncQueueDrain({ remote_url: 'http://test-remote.local', api_key: 'test' });

    // 4 rows: bisect tree shape is 1 root + 2 halves + 4 leaves = 7 calls.
    expect(callCount).toBeGreaterThan(1);

    const retrying = db.prepare("SELECT * FROM sync_queue WHERE status='retrying'").all() as Array<{table_name:string;error_message:string}>;
    expect(retrying).toHaveLength(4);
    // Each row carries a SPECIFIC error message (table + key + reason),
    // not the historical generic "HTTP 500".
    for (const r of retrying) {
      expect(r.table_name).toBe('event_log');
      expect(r.error_message).toMatch(/table=event_log/);
      expect(r.error_message).toMatch(/key=/);
    }
  }, 15_000);

  it('does not bisect a single-row chunk further — marks it failed directly', async () => {
    const insert = db.prepare(`
      INSERT INTO sync_queue (table_name, row_data, status, retry_count, max_retries)
      VALUES (?, ?, 'pending', 0, 5)
    `);
    insert.run('event_log', JSON.stringify({ id: 99, event_name: 'a', component: 'c', payload: '{}', created_at: '2026-05-05T00:00:00Z' }));

    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      throw new Error('HTTP 400: synthetic test wholesale failure');
    }) as unknown as typeof globalThis.fetch;

    await handleSyncQueueDrain({ remote_url: 'http://test-remote.local', api_key: 'test' });

    // One row → fetchWithRetry called once (4xx-prefixed = no internal retry).
    expect(callCount).toBe(1);
    const r = db.prepare("SELECT * FROM sync_queue WHERE table_name='event_log'").get() as {status:string;error_message:string};
    expect(r.status).toBe('retrying');
    expect(r.error_message).toMatch(/key=99/);
  });
});

// ---------------------------------------------------------------------------
// chunkTablesForPushSafe behavior — drain-cap parameter is honored.
// ---------------------------------------------------------------------------

import { chunkTablesForPushSafe } from '../tools/sync.js';

describe('BR-066 chunkTablesForPushSafe', () => {
  it('respects a custom byte cap', () => {
    // Build 8 KB of synthetic event_log rows; cap at 1 KB. Expect 8 chunks.
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      // ~1 KB per row when JSON-stringified.
      const filler = 'x'.repeat(950);
      rows.push({ id: i, event_name: 'e', component: 'c', payload: filler, created_at: '2026-05-05T00:00:00Z' });
    }

    const chunks = chunkTablesForPushSafe({ event_log: rows }, 1024);
    expect(chunks.length).toBeGreaterThanOrEqual(7); // some slack for JSON overhead
    expect(chunks.length).toBeLessThanOrEqual(9);
  });

  it('packs into a single chunk under the default 5 MB cap', () => {
    const rows = [{ id: 1, event_name: 'a', component: 'c', payload: '{}', created_at: '2026-05-05T00:00:00Z' }];
    const chunks = chunkTablesForPushSafe({ event_log: rows });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].event_log).toHaveLength(1);
  });

  it('keeps a single oversized row in its own chunk (never splits a row)', () => {
    const big = { id: 1, event_name: 'a', component: 'c', payload: 'x'.repeat(2000), created_at: '2026-05-05T00:00:00Z' };
    const chunks = chunkTablesForPushSafe({ event_log: [big] }, 100);
    expect(chunks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mergeRows row-level isolation — directly invoked.
// ---------------------------------------------------------------------------

import { mergeRows } from '../tools/sync.js';

describe('BR-066 mergeRows row-level try/catch', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeBriefIsolationDb();
  });

  afterEach(() => {
    db.close();
  });

  it('a single bad row in a 5-row batch returns failed=1, inserted=4', () => {
    // TD-265: retargeted from the removed `tasks` table to `learnings`
    // (syncKey [project, category, title]; category has a CHECK constraint).
    const config = SYNC_TABLES.find((c) => c.table === 'learnings');
    expect(config).toBeDefined();

    const rows = [
      { project: 'p', category: 'pattern', title: 't1', content: 'c', created_at: '2026-05-05T00:00:00Z' },
      { project: 'p', category: 'decision', title: 't2', content: 'c', created_at: '2026-05-05T00:00:00Z' },
      { project: 'p', category: 'INVALID-CATEGORY', title: 't3', content: 'c', created_at: '2026-05-05T00:00:00Z' },
      { project: 'p', category: 'discovery', title: 't4', content: 'c', created_at: '2026-05-05T00:00:00Z' },
      { project: 'p', category: 'mistake', title: 't5', content: 'c', created_at: '2026-05-05T00:00:00Z' },
    ];

    const result = mergeRows(db, config!, rows);
    expect(result.inserted).toBe(4);
    expect(result.failed).toBe(1);
    expect(result.failures).toBeDefined();
    expect(result.failures![0].key).toBe('p|INVALID-CATEGORY|t3');
  });

  it('an all-bad batch returns failed=N, inserted=0, with N failure entries', () => {
    const config = SYNC_TABLES.find((c) => c.table === 'learnings');
    const rows = [
      { project: 'p', category: 'INVALID', title: 'b1', content: 'c', created_at: '2026-05-05T00:00:00Z' },
      { project: 'p', category: 'ALSO-INVALID', title: 'b2', content: 'c', created_at: '2026-05-05T00:00:00Z' },
    ];

    const result = mergeRows(db, config!, rows);
    expect(result.inserted).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].key).toBe('p|INVALID|b1');
    expect(result.failures![1].key).toBe('p|ALSO-INVALID|b2');
  });

  it('an all-good batch returns failed=0 and omits the failures field', () => {
    const config = SYNC_TABLES.find((c) => c.table === 'event_log');
    const rows = [
      { id: 5001, event_name: 'a', component: 'c', payload: '{}', created_at: '2026-05-05T00:00:00Z' },
    ];
    const result = mergeRows(db, config!, rows);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.failures).toBeUndefined();
  });
});
