/**
 * BR-066 — auto-push pushTables HTTP 207 partial-success handling.
 *
 * Background:
 *   The pre-fix `pushTables` (engine/components/sync/index.ts) discarded the
 *   Response from fetchWithRetry. With the new server semantics, /sync/push
 *   returns HTTP 207 (status 2xx, response.ok=true) when one or more tables
 *   error at the table-level, with `body.ok=false` and `body.errors[table]`
 *   populated. Because `response.ok` is true the function never entered its
 *   catch block — it advanced sync_state for ALL tables (including failed
 *   ones) and never queued the failed rows. Result: silent data loss for
 *   the exact class BR-066 was meant to fix.
 *
 * BR-066 fix (superseded in part by BR-097 — see the block before T7):
 *   BR-097 (2026-08-27): pushTables no longer branches on body.ok; a table advances iff it is named in body.results and not in body.errors (T7/T8 below).
 *   (BR-066) pushTables read `response.json()` and branched on `body.ok`:
 *     - body.ok=true                                    → advance every table
 *     - body.ok=false with body.errors populated        → advance only OK
 *                                                          tables, queue
 *                                                          failed-table rows
 *                                                          with the SPECIFIC
 *                                                          per-table error
 *     - body.results missing                            → throw (network/5xx
 *                                                          existing catch
 *                                                          path queues all)
 *
 * Per Learning #159, this test does NOT mock pushTables, queueFailedRows, or
 * chunkTablesForPush — those are the bug surface. We mock only the external
 * boundaries: node:fs (config load), node:os (homedir), db.js (point at a
 * real in-memory DB), and globalThis.fetch (network).
 *
 * @module engine/components/sync/__tests__/auto-push-207.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createEventBus } from '../../../bus.js';
import type { EventBus, ComponentContext, ComponentLogger } from '../../../types.js';

// ---------------------------------------------------------------------------
// Boundary mocks — declared before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}));

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

// NOTE: tools/sync.js is INTENTIONALLY NOT mocked. We exercise real
// queueFailedRows, chunkTablesForPush, and fetchWithRetry against a stubbed
// globalThis.fetch — keeping the bug surface live.

// ---------------------------------------------------------------------------
// Imports (after mock declarations)
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createSyncComponent } from '../index.js';
import { getDb } from '../../../../db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CONFIG = JSON.stringify({
  auto_push: true,
  remote_brain: {
    url: 'https://brain.example.com',
    api_key: 'test-key-123',
  },
});

function makeLogger(): ComponentLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeCtx(bus: EventBus): ComponentContext {
  return {
    storage: {} as ComponentContext['storage'],
    bus,
    log: makeLogger(),
    config: {},
  };
}

/**
 * Build an in-memory DB with the columns auto-push touches plus sync_state
 * and sync_queue. brief_status carries multiple seed rows so onImmediateEvent
 * → queryTableRows finds them; tasks carries one good row so the chunked
 * payload includes the table name.
 */
function makeAutoPushDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');

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
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'project',
      title TEXT NOT NULL,
      description TEXT,
      brief_id TEXT,
      project_slug TEXT,
      parent_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 3,
      assignee TEXT,
      due_at TEXT,
      defer_until TEXT,
      created_by TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      required_capabilities TEXT DEFAULT '[]',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      fail_reason TEXT
    );
    CREATE TABLE sync_state (
      remote_url TEXT NOT NULL,
      table_name TEXT NOT NULL,
      last_push_at TEXT,
      last_pull_at TEXT,
      PRIMARY KEY (remote_url, table_name)
    );
    CREATE TABLE sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_data TEXT NOT NULL,
      operation TEXT DEFAULT 'push' CHECK (operation IN ('push', 'pull')),
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'sent', 'failed')),
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 5,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_retry_at TEXT,
      sent_at TEXT
    );
    CREATE INDEX idx_sync_queue_status ON sync_queue(status);
  `);

  return db;
}

/** Wait one tick so the fire-and-forget pushTables() promise settles. */
async function flushAsync(): Promise<void> {
  // Two ticks: one for the fetch promise, one for the body.json() promise.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BR-066 auto-push HTTP 207 partial-success handling', () => {
  let db: Database.Database;
  let bus: EventBus;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeAutoPushDb();
    bus = createEventBus();
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(readFileSync).mockReturnValue(VALID_CONFIG);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // The headline: 207 with one failed table → that table queued, others
  // advance, error message is table-specific (not generic "HTTP 500").
  // -------------------------------------------------------------------------

  it('on HTTP 207 with body.errors[tasks], advances OK tables and queues failed-table rows with table-specific message', async () => {
    // Seed two brief_status rows so the brief.synced handler queries them.
    db.prepare(`
      INSERT INTO brief_status (id, project, brief_id, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('bs-1', 'p', 'BR-066', 'In Progress', '2026-05-05T10:00:00Z');
    db.prepare(`
      INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('bf-1', 'p', 'BR-066', 'BR-066.md', '# brief', 'cafef00d', '2026-05-05T10:00:00Z');

    // Seed a tasks row so we can simulate /sync/push reporting a tasks
    // failure on the auto-push payload. We synthesize the auto-push payload
    // by emitting brief.synced AND seeding tasks via a manual queryTableRows
    // path — but onImmediateEvent for brief.synced only pulls brief_status
    // and brief_files, NOT tasks. So we instead trigger a batched push that
    // covers tasks via a differently-shaped fetch payload below.
    //
    // Simpler approach: stub fetch to simulate the server returning 207
    // with errors keyed on a table that IS in the payload (brief_files).

    const fetchSpy = vi.fn(async (_url: unknown, init: RequestInit) => {
      // Inspect the payload to confirm what the server "saw".
      const body = JSON.parse(init.body as string) as {
        tables: Record<string, unknown[]>;
      };
      const sentTables = Object.keys(body.tables);

      // Build a fake 207 response: brief_status OK, brief_files errored
      // with a SPECIFIC server-side message (no "HTTP 500" generic).
      const results: Record<string, unknown> = {};
      const errors: Record<string, string> = {};
      for (const t of sentTables) {
        if (t === 'brief_files') {
          errors[t] = 'mergeRows failure: Too few parameter values supplied for column content';
        } else {
          results[t] = { inserted: 1, updated: 0, skipped: 0, failed: 0 };
        }
      }

      return {
        ok: true,
        status: 207,
        json: async () => ({ ok: false, results, errors }),
        text: async () => '',
      } as Response;
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const comp = createSyncComponent();
    comp.init(makeCtx(bus));

    bus.emit('brief.synced', { project: 'p', brief_id: 'BR-066' });
    await flushAsync();

    // Inspect post-state.
    const stateRows = db.prepare(`
      SELECT table_name, last_push_at FROM sync_state WHERE remote_url = ?
    `).all('https://brain.example.com') as Array<{ table_name: string; last_push_at: string }>;
    const stateMap = Object.fromEntries(stateRows.map((r) => [r.table_name, r.last_push_at]));

    // brief_status (OK) advanced, brief_files (failed) did NOT.
    expect(stateMap.brief_status).toBeDefined();
    expect(stateMap.brief_status).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(stateMap.brief_files).toBeUndefined();

    // sync_queue: brief_files row enqueued with the SPECIFIC server message,
    // brief_status NOT enqueued.
    const queue = db.prepare(`
      SELECT table_name, status, error_message FROM sync_queue
    `).all() as Array<{ table_name: string; status: string; error_message: string }>;

    const queuedTables = queue.map((r) => r.table_name);
    expect(queuedTables).toContain('brief_files');
    expect(queuedTables).not.toContain('brief_status');

    const briefFilesQueued = queue.find((r) => r.table_name === 'brief_files')!;
    expect(briefFilesQueued.status).toBe('pending');
    // Critical: the error message carries the table-specific server message
    // (NOT a generic "HTTP 500"). The fix prepends "HTTP 207 — table=...:"
    // so post-drain inspection knows exactly which table failed and why.
    expect(briefFilesQueued.error_message).toMatch(/HTTP 207/);
    expect(briefFilesQueued.error_message).toMatch(/table=brief_files/);
    expect(briefFilesQueued.error_message).toMatch(/Too few parameter values/);

    comp.destroy();
  });

  // -------------------------------------------------------------------------
  // Regression: the all-good path is unchanged — every table advances,
  // nothing enters sync_queue.
  // -------------------------------------------------------------------------

  it('on plain HTTP 200 with every table named in results, advances every table and queues nothing', async () => {
    db.prepare(`
      INSERT INTO brief_status (id, project, brief_id, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('bs-2', 'p', 'BR-067', 'Done', '2026-05-05T11:00:00Z');
    db.prepare(`
      INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('bf-2', 'p', 'BR-067', 'BR-067.md', '# brief', 'feedface', '2026-05-05T11:00:00Z');

    const fetchSpy = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { tables: Record<string, unknown[]> };
      const results: Record<string, unknown> = {};
      for (const t of Object.keys(body.tables)) {
        results[t] = { inserted: 1, updated: 0, skipped: 0, failed: 0 };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, results, errors: {} }),
        text: async () => '',
      } as Response;
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const comp = createSyncComponent();
    comp.init(makeCtx(bus));

    bus.emit('brief.synced', { project: 'p', brief_id: 'BR-067' });
    await flushAsync();

    // Every table advanced.
    const stateRows = db.prepare(`
      SELECT table_name FROM sync_state WHERE remote_url = ?
    `).all('https://brain.example.com') as Array<{ table_name: string }>;
    const stateTables = stateRows.map((r) => r.table_name).sort();
    expect(stateTables).toEqual(['brief_files', 'brief_status']);

    // Nothing in the queue.
    const queueCount = db.prepare(
      'SELECT COUNT(*) as c FROM sync_queue'
    ).get() as { c: number };
    expect(queueCount.c).toBe(0);

    comp.destroy();
  });

  // -------------------------------------------------------------------------
  // Defense-in-depth: malformed response (no `results` field) falls into
  // the existing catch path and queues everything. Keeps the behavior of
  // the prior implementation for genuinely broken servers.
  // -------------------------------------------------------------------------

  it('on a malformed response (no results field), throws into catch and queues everything', async () => {
    db.prepare(`
      INSERT INTO brief_status (id, project, brief_id, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('bs-3', 'p', 'BR-068', 'In Progress', '2026-05-05T12:00:00Z');
    db.prepare(`
      INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('bf-3', 'p', 'BR-068', 'BR-068.md', '# brief', 'baadf00d', '2026-05-05T12:00:00Z');

    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      // Genuinely broken: no `results`, no `errors`, no `ok`.
      json: async () => ({ unexpected: 'shape' }),
      text: async () => '',
    } as Response));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const comp = createSyncComponent();
    comp.init(makeCtx(bus));

    bus.emit('brief.synced', { project: 'p', brief_id: 'BR-068' });
    await flushAsync();

    // Nothing advanced.
    const stateCount = db.prepare(
      'SELECT COUNT(*) as c FROM sync_state'
    ).get() as { c: number };
    expect(stateCount.c).toBe(0);

    // Both tables queued (matches the original catch-block behavior).
    const queue = db.prepare(`
      SELECT table_name, status FROM sync_queue ORDER BY table_name
    `).all() as Array<{ table_name: string; status: string }>;
    const tables = queue.map((r) => r.table_name).sort();
    expect(tables).toEqual(['brief_files', 'brief_status']);
    expect(queue.every((r) => r.status === 'pending')).toBe(true);

    comp.destroy();
  });

  // -------------------------------------------------------------------------
  // BR-097 — the auto-push client stamps a table only when the remote named
  // it in `results` and not in `errors`. A table the remote SKIPS (it lacks
  // the table — named in `skipped[]`, HTTP 207, NOT in `errors`) is held: not
  // stamped and NOT queued (queue + re-select would double-send). An old
  // remote (no `skipped` field, table absent from `results`) is held the same
  // way. Same read-back idiom as the 207 case above.
  // -------------------------------------------------------------------------

  it('BR-097 T7: a remote-skipped table (skipped[], not in errors) is neither stamped nor queued, and is warned once', async () => {
    db.prepare(`
      INSERT INTO brief_status (id, project, brief_id, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('bs-4', 'p', 'BR-097', 'In Progress', '2026-08-27 07:00:00');
    db.prepare(`
      INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('bf-4', 'p', 'BR-097', 'BR-097.md', '# brief', 'c0ffee', '2026-08-27 07:00:00');

    const fetchSpy = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { tables: Record<string, unknown[]> };
      const results: Record<string, unknown> = {};
      const skipped: string[] = [];
      for (const t of Object.keys(body.tables)) {
        if (t === 'brief_files') skipped.push(t);
        else results[t] = { inserted: 1, updated: 0, skipped: 0, failed: 0 };
      }
      return {
        ok: true,
        status: 207,
        json: async () => ({ ok: false, results, errors: {}, skipped }),
        text: async () => '',
      } as Response;
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const comp = createSyncComponent();
    const ctx = makeCtx(bus);
    comp.init(ctx);

    bus.emit('brief.synced', { project: 'p', brief_id: 'BR-097' });
    await flushAsync();

    const stateRows = db.prepare(`
      SELECT table_name, last_push_at FROM sync_state WHERE remote_url = ?
    `).all('https://brain.example.com') as Array<{ table_name: string; last_push_at: string }>;
    const stateMap = Object.fromEntries(stateRows.map((r) => [r.table_name, r.last_push_at]));
    expect(stateMap.brief_status).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(stateMap.brief_files).toBeUndefined();

    // NOT queued — a skip is a deploy state, not a failure.
    const queueCount = db.prepare('SELECT COUNT(*) as c FROM sync_queue').get() as { c: number };
    expect(queueCount.c).toBe(0);

    // Exactly one warn line names the held table.
    const warns = vi.mocked(ctx.log.warn).mock.calls.map((c) => String(c[0]));
    const held = warns.filter((w) => /table=brief_files not on remote yet/.test(w));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatch(/deploy first; rows retained locally/);

    comp.destroy();
  });

  it('BR-097 T8: an old-remote body (no skipped field, table absent from results) holds the table: not stamped, not queued', async () => {
    db.prepare(`
      INSERT INTO brief_status (id, project, brief_id, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('bs-5', 'p', 'BR-098', 'In Progress', '2026-08-27 07:00:00');
    db.prepare(`
      INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('bf-5', 'p', 'BR-098', 'BR-098.md', '# brief', 'd00d', '2026-08-27 07:00:00');

    const fetchSpy = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { tables: Record<string, unknown[]> };
      const results: Record<string, unknown> = {};
      for (const t of Object.keys(body.tables)) {
        if (t !== 'brief_files') results[t] = { inserted: 1, updated: 0, skipped: 0, failed: 0 };
      }
      // Pre-BR-097 remote: `ok: true`, no `skipped`, the absent table simply unnamed.
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, results, errors: {} }),
        text: async () => '',
      } as Response;
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const comp = createSyncComponent();
    const ctx = makeCtx(bus);
    comp.init(ctx);

    bus.emit('brief.synced', { project: 'p', brief_id: 'BR-098' });
    await flushAsync();

    const stateTables = (db.prepare(`
      SELECT table_name FROM sync_state WHERE remote_url = ?
    `).all('https://brain.example.com') as Array<{ table_name: string }>).map((r) => r.table_name);
    expect(stateTables).toEqual(['brief_status']);

    const queueCount = db.prepare('SELECT COUNT(*) as c FROM sync_queue').get() as { c: number };
    expect(queueCount.c).toBe(0);

    const warns = vi.mocked(ctx.log.warn).mock.calls.map((c) => String(c[0]));
    expect(warns.filter((w) => /table=brief_files sent but not acknowledged by the remote/.test(w))).toHaveLength(1);

    comp.destroy();
  });
});
