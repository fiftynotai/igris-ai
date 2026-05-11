/**
 * Sync Tool Regression Tests (FR-109 round-2 review)
 *
 * Critical-1 fix verification: pending_review learnings must NOT propagate
 * to the VPS via `igris_brain_push`. Defense-in-depth pair:
 *   1. SYNC_TABLES.learnings.columns now includes review_status, provenance,
 *      and source_extractor — so even when rows are pushed, the receiving
 *      side cannot fall back to defaults that auto-promote pending rows.
 *   2. handleBrainPush SELECT applies `AND review_status = 'approved'` for
 *      the learnings table — pending rows stay LOCAL until a human approves.
 *
 * The receiving-side bug (silent auto-promotion via defaults) was subtle:
 * absent columns mean the VPS INSERT uses the default `review_status='approved'`,
 * effectively bypassing the human-review-as-final-filter property of the
 * perception channel. This test fixture demonstrates the bug-free path.
 *
 * @module tools/__tests__/sync.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports
// ---------------------------------------------------------------------------

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../db.js';
import { handleBrainPush, SYNC_TABLES } from '../sync.js';

const mockedGetDb = vi.mocked(getDb);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Create an in-memory database with the minimum schema needed for handleBrainPush.
 * Includes learnings, sync_state, and sync_queue. We seed only the learnings
 * timestamp/columns relevant to the test — handleBrainPush iterates SYNC_TABLES
 * and queries each table's timestamp column, but missing tables harmlessly return
 * empty results.
 */
function makeMinimalSyncDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Learnings table — full FR-109 schema with review_status + source_extractor.
  db.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      tech_stack TEXT DEFAULT '',
      scope TEXT DEFAULT 'local',
      source_brief TEXT DEFAULT '',
      confidence REAL DEFAULT 0.8,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT,
      provenance TEXT NOT NULL DEFAULT 'observed',
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual'
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
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Each SYNC_TABLES entry will be queried for changed rows. To avoid SQL
  // errors on missing tables, create stubs for every table the iterator
  // visits — empty so they return zero rows.
  for (const config of SYNC_TABLES) {
    if (config.table === 'learnings') continue;
    const colDefs = config.columns
      .map((c) => `${c} TEXT`)
      .join(', ');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS ${config.table} (${colDefs});`);
    } catch {
      // Some columns may collide with reserved words or types — fall back
      // to an even simpler shape: just the timestamp column.
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${config.table} (${config.timestampCol} TEXT);`,
      );
    }
  }

  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sync — FR-109 review_status / source_extractor regression', () => {
  let db: Database.Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = makeMinimalSyncDb();
    mockedGetDb.mockReturnValue(db);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // SYNC_TABLES column-list completeness
  // -------------------------------------------------------------------------

  describe('SYNC_TABLES.learnings.columns', () => {
    it('includes review_status (perception channel gate column)', () => {
      const config = SYNC_TABLES.find((t) => t.table === 'learnings');
      expect(config).toBeDefined();
      expect(config!.columns).toContain('review_status');
    });

    it('includes provenance (FR-107 trust column)', () => {
      const config = SYNC_TABLES.find((t) => t.table === 'learnings');
      expect(config).toBeDefined();
      expect(config!.columns).toContain('provenance');
    });

    it('includes source_extractor (FR-109 extractor identity)', () => {
      const config = SYNC_TABLES.find((t) => t.table === 'learnings');
      expect(config).toBeDefined();
      expect(config!.columns).toContain('source_extractor');
    });
  });

  // -------------------------------------------------------------------------
  // Defense-in-depth: pending rows never reach the wire
  // -------------------------------------------------------------------------

  describe('handleBrainPush filters pending_review learnings', () => {
    it('only approved learnings are included in the push payload', async () => {
      // Seed two learnings: one approved, one pending_review. Both have
      // created_at > 1970, so both would be picked up without the filter.
      const insert = db.prepare(`
        INSERT INTO learnings
          (project, category, title, content, review_status, provenance,
           source_extractor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        'p',
        'pattern',
        'approved finding',
        'visible to push',
        'approved',
        'observed',
        'manual',
        '2026-04-29 10:00:00',
      );
      insert.run(
        'p',
        'pattern',
        'pending finding',
        'should NOT propagate',
        'pending_review',
        'inferred',
        'rule:learned_marker',
        '2026-04-29 10:00:01',
      );

      // Mock fetch to capture the payload. Return ok=true with results so
      // handleBrainPush does not branch into the queueFailedRows fallback.
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, results: { learnings: { inserted: 1 } } }),
        text: async () => '',
        status: 200,
      })) as unknown as typeof globalThis.fetch;
      globalThis.fetch = fetchMock;

      const result = await handleBrainPush({
        remote_url: 'http://test-remote.local',
        api_key: 'test-key',
      });
      // Push completed successfully — no isError flag means the filter worked.
      expect(
        (result as { isError?: boolean }).isError,
      ).toBeFalsy();

      // Inspect the payload sent to the remote.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0];
      const init = call[1] as RequestInit;
      const body = JSON.parse(init.body as string) as {
        tables: Record<string, Array<Record<string, unknown>>>;
      };

      expect(body.tables).toHaveProperty('learnings');
      const learningsRows = body.tables.learnings;
      expect(learningsRows).toHaveLength(1);
      expect(learningsRows[0].title).toBe('approved finding');
      // Belt-and-braces: the pending row is absent.
      const titles = learningsRows.map((r) => r.title as string);
      expect(titles).not.toContain('pending finding');

      // The pushed row carries the new columns explicitly (no relying on
      // remote-side defaults to fill them in).
      expect(learningsRows[0]).toHaveProperty('review_status', 'approved');
      expect(learningsRows[0]).toHaveProperty('provenance', 'observed');
      expect(learningsRows[0]).toHaveProperty('source_extractor', 'manual');
    });

    // -----------------------------------------------------------------------
    // BR-064 Fix B: missing tables are skipped, not thrown
    // -----------------------------------------------------------------------
    // The plan calls for graceful degradation when a SYNC_TABLES entry's
    // table is absent on the local DB (e.g. a partially-migrated install).
    // The pre-fix behaviour was to abort the iteration on the first missing
    // table — including aborting the push of sibling tables. The fix filters
    // SYNC_TABLES against `sqlite_master` once at the top of handleBrainPush
    // and emits a `[brain] sync skip:` line for each absent table.
    // -----------------------------------------------------------------------

    it('BR-064 Fix B: handleBrainPush skips tables that do not exist locally', async () => {
      // Force a partial schema: drop goals after the fixture builds it.
      db.exec('DROP TABLE IF EXISTS goals');

      // Seed an approved learning so the push has SOMETHING to send — proves
      // sibling tables still propagate after the missing-goals skip.
      db.prepare(
        `INSERT INTO learnings (project, category, title, content,
         review_status, provenance, source_extractor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'p',
        'pattern',
        'fix-b sibling',
        'body',
        'approved',
        'observed',
        'manual',
        '2026-04-29 12:00:00',
      );

      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, results: { learnings: { inserted: 1 } } }),
        text: async () => '',
        status: 200,
      })) as unknown as typeof globalThis.fetch;
      globalThis.fetch = fetchMock;

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const result = await handleBrainPush({
          remote_url: 'http://test-remote.local',
          api_key: 'test-key',
        });
        // Push completed (no isError flag) despite missing goals table.
        expect((result as { isError?: boolean }).isError).toBeFalsy();

        // The learnings sibling went through.
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Stderr carries a "sync skip" line for the missing goals table.
        const stderr = errSpy.mock.calls
          .map((c) => c.map(String).join(' '))
          .join('\n');
        expect(stderr).toMatch(/sync skip: table 'goals' not present locally/);
      } finally {
        errSpy.mockRestore();
      }
    });

    it('BR-064 Fix B: handleBrainPush returns "No changes" when ALL sync tables are missing', async () => {
      // Drop EVERY sync table so the filter eliminates them all. We expect
      // handleBrainPush to return the "No changes to push" payload rather
      // than crash, and to NOT issue a fetch call.
      const tableNames = SYNC_TABLES.map((t) => t.table);
      for (const name of tableNames) {
        try {
          db.exec(`DROP TABLE IF EXISTS ${name}`);
        } catch {
          // ignore
        }
      }

      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, results: {} }),
        text: async () => '',
        status: 200,
      })) as unknown as typeof globalThis.fetch;
      globalThis.fetch = fetchMock;

      const result = await handleBrainPush({
        remote_url: 'http://test-remote.local',
        api_key: 'test-key',
      });
      const text = (result.content?.[0]?.text as string) ?? '';
      expect(text).toMatch(/No changes to push/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('payload column list contains review_status, provenance, source_extractor', async () => {
      // Seed a single approved row to force the learnings table into the payload.
      db.prepare(
        `INSERT INTO learnings (project, category, title, content,
         review_status, provenance, source_extractor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'p',
        'pattern',
        'column-shape check',
        'body',
        'approved',
        'human_asserted',
        'manual',
        '2026-04-29 11:00:00',
      );

      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, results: { learnings: { inserted: 1 } } }),
        text: async () => '',
        status: 200,
      })) as unknown as typeof globalThis.fetch;
      globalThis.fetch = fetchMock;

      await handleBrainPush({
        remote_url: 'http://test-remote.local',
        api_key: 'test-key',
      });

      const call = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(((call[1] as RequestInit).body as string)) as {
        tables: Record<string, Array<Record<string, unknown>>>;
      };
      const row = body.tables.learnings[0];

      // The exact value carries through — nothing relies on a remote default.
      expect(row.review_status).toBe('approved');
      expect(row.provenance).toBe('human_asserted');
      expect(row.source_extractor).toBe('manual');
    });
  });
});
