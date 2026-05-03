/**
 * brain_push_cli unit + integration tests.
 *
 * Covers:
 *   - parseCliArgs() flag handling + error paths
 *   - resolveRemoteConfig() hybrid (config.json default + flag overrides)
 *   - main() exit codes against a REAL in-memory better-sqlite3 connection:
 *     * 0 on success / "remote not configured"
 *     * 0 on "rows queued for retry" (isError=true)
 *     * 1 on malformed args / engine boot failure
 *
 * Test discipline (BR-064 lesson learned):
 *   The previous version of this file mocked `handleBrainPush` outright via
 *   `vi.mock('../../src/tools/sync.js', ...)`. That stubbed the very function
 *   under test — the CLI's wiring to a real DB connection was never exercised,
 *   which let BR-064 ship ("no such table: goals" on a partially-migrated
 *   local DB). The structural fix is to mock at the I/O boundary (network +
 *   the engine boot path), not at the domain boundary. We mirror the
 *   perception_extract_cli.test.ts pattern: real in-memory DB, mocked
 *   `getDb`, mocked `bootEngine` (returns a no-op shim that points at the
 *   pre-built test DB), and stubbed fetch.
 *
 * @module scripts/__tests__/brain_push_cli.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE the SUT imports so the import chain
// picks up the mocked symbols.
//
// Strategy:
//   - `db.js`        → getDb returns whatever in-memory connection the test
//                      wired in via mockedGetDb.
//   - `engine/index.js` → bootEngine is a thin shim that returns an Engine
//                          handle whose shutdown() closes the test DB. We do
//                          NOT actually run all 19 component migrations here:
//                          tests build the schema they need explicitly so the
//                          assertions are surgical.
//   - `globalThis.fetch` → stubbed per-test to capture push payloads or
//                          simulate failure modes (set in beforeEach).
// ---------------------------------------------------------------------------

vi.mock('../../src/db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

vi.mock('../../src/engine/index.js', () => ({
  bootEngine: vi.fn(),
}));

import { getDb, BRAIN_DIR as _BRAIN_DIR } from '../../src/db.js';
import { bootEngine } from '../../src/engine/index.js';
import { SYNC_TABLES } from '../../src/tools/sync.js';
import {
  parseCliArgs,
  resolveRemoteConfig,
  defaultConfigPath,
  main,
  USAGE,
} from '../brain_push_cli.js';

const mockedGetDb = vi.mocked(getDb);
const mockedBootEngine = vi.mocked(bootEngine);

// ---------------------------------------------------------------------------
// Test helpers — temp paths and DB fixtures
// ---------------------------------------------------------------------------

function tempPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${randomBytes(6).toString('hex')}`);
}

/**
 * Build the minimum schema needed for handleBrainPush to iterate without
 * "no such table" errors (Fix B safety net): create empty stubs for every
 * SYNC_TABLES entry plus sync_state + sync_queue. Specific tests then
 * INSERT rows into individual tables to drive the push payload.
 */
function makeFullSyncDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
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
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL UNIQUE,
      project_slug TEXT,
      title TEXT NOT NULL,
      description TEXT,
      outcome TEXT NOT NULL,
      deadline TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      priority TEXT NOT NULL DEFAULT 'P2-Medium',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      achieved_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
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

  // Stub every other SYNC_TABLES entry as an empty shape — handleBrainPush
  // queries each table for `WHERE timestampCol > ?` so the column must
  // exist or SQLite throws. We use TEXT for every column for simplicity;
  // real schema typing is irrelevant for an empty-table query.
  const handled = new Set(['learnings', 'goals', 'event_log']);
  for (const cfg of SYNC_TABLES) {
    if (handled.has(cfg.table)) continue;
    const colDefs = cfg.columns.map((c) => `${c} TEXT`).join(', ');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS ${cfg.table} (${colDefs});`);
    } catch {
      // Reserved word collision — fall back to just the timestamp column.
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${cfg.table} (${cfg.timestampCol} TEXT);`,
      );
    }
  }

  return db;
}

/**
 * Build a v1-v15-only DB that DOES NOT include component-owned tables
 * (no goals, no entity_edges, etc.). Used to verify Fix B's graceful skip
 * — the push of `learnings` should succeed while goals is silently skipped.
 */
function makeLegacyOnlyDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
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
  `);
  // Intentionally NO goals, NO entity_edges, NO tasks, etc. — Fix B should
  // log a "sync skip" line for each missing table and still push learnings.
  return db;
}

/**
 * Build a fetch mock that returns 200 OK with a valid sync response shape.
 * Captures the request body so tests can assert on the payload sent to /sync/push.
 */
function makeFetchSuccessMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ ok: true, results: { learnings: { inserted: 1 } } }),
  })) as unknown as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

describe('parseCliArgs', () => {
  it('parses required --project flag', () => {
    const args = parseCliArgs(['node', 'script.ts', '--project', 'igris-ai']);
    expect(args.project).toBe('igris-ai');
    expect(args.remoteUrlOverride).toBeUndefined();
    expect(args.apiKeyOverride).toBeUndefined();
    expect(args.dbPathOverride).toBeUndefined();
    expect(args.configPathOverride).toBeUndefined();
    expect(args.help).toBe(false);
  });

  it('parses optional override flags', () => {
    const args = parseCliArgs([
      'node',
      'script.ts',
      '--project',
      'p',
      '--db',
      '/tmp/test.db',
      '--remote-url',
      'http://staging.example.com',
      '--api-key',
      'override-key',
      '--config',
      '/tmp/cfg.json',
    ]);
    expect(args.dbPathOverride).toBe('/tmp/test.db');
    expect(args.remoteUrlOverride).toBe('http://staging.example.com');
    expect(args.apiKeyOverride).toBe('override-key');
    expect(args.configPathOverride).toBe('/tmp/cfg.json');
  });

  it('throws when --project is missing', () => {
    expect(() => parseCliArgs(['node', 's'])).toThrow(/--project/);
  });

  it('throws when a flag value is another flag', () => {
    expect(() => parseCliArgs(['node', 's', '--project', '--db', '/x'])).toThrow(/--project/);
  });

  it('returns help sentinel on --help without requiring --project', () => {
    const args = parseCliArgs(['node', 'script.ts', '--help']);
    expect(args.help).toBe(true);
    expect(args.project).toBe('');
  });

  it('returns help sentinel on -h short flag', () => {
    const args = parseCliArgs(['node', 'script.ts', '-h']);
    expect(args.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaultConfigPath
// ---------------------------------------------------------------------------

describe('defaultConfigPath', () => {
  it('builds the canonical config.json path', () => {
    const p = defaultConfigPath();
    expect(p).toContain('.igris');
    expect(p).toContain('config.json');
  });
});

// ---------------------------------------------------------------------------
// resolveRemoteConfig — hybrid config.json + flag override
// ---------------------------------------------------------------------------

describe('resolveRemoteConfig', () => {
  const cleanupFiles: string[] = [];

  afterEach(() => {
    for (const f of cleanupFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    cleanupFiles.length = 0;
  });

  it('returns null when config file is absent and no overrides are given', () => {
    const result = resolveRemoteConfig({
      remoteUrlOverride: undefined,
      apiKeyOverride: undefined,
      configPathOverride: tempPath('absent-cfg'),
    });
    expect(result).toBeNull();
  });

  it('returns null when config has empty url', () => {
    const cfgPath = tempPath('cfg');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ remote_brain: { url: '', api_key: 'has-key' } }),
    );
    const result = resolveRemoteConfig({
      remoteUrlOverride: undefined,
      apiKeyOverride: undefined,
      configPathOverride: cfgPath,
    });
    expect(result).toBeNull();
  });

  it('returns null when config has empty api_key', () => {
    const cfgPath = tempPath('cfg');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ remote_brain: { url: 'http://x', api_key: '' } }),
    );
    const result = resolveRemoteConfig({
      remoteUrlOverride: undefined,
      apiKeyOverride: undefined,
      configPathOverride: cfgPath,
    });
    expect(result).toBeNull();
  });

  it('returns null when config.json is malformed', () => {
    const cfgPath = tempPath('cfg-bad');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(cfgPath, '{not-valid-json');
    const result = resolveRemoteConfig({
      remoteUrlOverride: undefined,
      apiKeyOverride: undefined,
      configPathOverride: cfgPath,
    });
    expect(result).toBeNull();
  });

  it('reads url + key from config.json when both flags are absent', () => {
    const cfgPath = tempPath('cfg-good');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        remote_brain: { url: 'http://config-url', api_key: 'config-key' },
      }),
    );
    const result = resolveRemoteConfig({
      remoteUrlOverride: undefined,
      apiKeyOverride: undefined,
      configPathOverride: cfgPath,
    });
    expect(result).not.toBeNull();
    expect(result?.remoteUrl).toBe('http://config-url');
    expect(result?.apiKey).toBe('config-key');
  });

  it('flag overrides take precedence over config.json values', () => {
    const cfgPath = tempPath('cfg-good');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        remote_brain: { url: 'http://config-url', api_key: 'config-key' },
      }),
    );
    const result = resolveRemoteConfig({
      remoteUrlOverride: 'http://override-url',
      apiKeyOverride: 'override-key',
      configPathOverride: cfgPath,
    });
    expect(result?.remoteUrl).toBe('http://override-url');
    expect(result?.apiKey).toBe('override-key');
  });

  it('uses both flags as the sole source when both are supplied (no config read)', () => {
    const result = resolveRemoteConfig({
      remoteUrlOverride: 'http://flag-only',
      apiKeyOverride: 'flag-only-key',
      configPathOverride: tempPath('does-not-exist'),
    });
    expect(result?.remoteUrl).toBe('http://flag-only');
    expect(result?.apiKey).toBe('flag-only-key');
  });

  it('partial overrides fall back to config.json for the missing field', () => {
    const cfgPath = tempPath('cfg-good');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        remote_brain: { url: 'http://config-url', api_key: 'config-key' },
      }),
    );
    const result = resolveRemoteConfig({
      remoteUrlOverride: 'http://flag-url',
      apiKeyOverride: undefined,
      configPathOverride: cfgPath,
    });
    expect(result?.remoteUrl).toBe('http://flag-url');
    expect(result?.apiKey).toBe('config-key');
  });
});

// ---------------------------------------------------------------------------
// main — end-to-end CLI behavior with REAL in-memory DB
// ---------------------------------------------------------------------------

describe('main — integration against in-memory DB', () => {
  let db: Database.Database;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let originalFetch: typeof globalThis.fetch;
  const cleanupFiles: string[] = [];

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalFetch = globalThis.fetch;
    mockedGetDb.mockReset();
    mockedBootEngine.mockReset();
  });

  afterEach(() => {
    if (db) db.close();
    logSpy.mockRestore();
    errSpy.mockRestore();
    globalThis.fetch = originalFetch;
    for (const f of cleanupFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    cleanupFiles.length = 0;
  });

  // -------------------------------------------------------------------------
  // Edge / error paths
  // -------------------------------------------------------------------------

  it('returns 1 on malformed args', async () => {
    const code = await main(['node', 'brain_push_cli.ts']);
    expect(code).toBe(1);
    expect(mockedBootEngine).not.toHaveBeenCalled();
  });

  it('returns 0 and prints USAGE on --help', async () => {
    const code = await main(['node', 'brain_push_cli.ts', '--help']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(USAGE);
    expect(mockedBootEngine).not.toHaveBeenCalled();
  });

  it('returns 0 silently when remote is not configured', async () => {
    const code = await main([
      'node',
      'brain_push_cli.ts',
      '--project',
      'p',
      '--config',
      tempPath('absent-cfg'),
    ]);
    expect(code).toBe(0);
    expect(mockedBootEngine).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/remote not configured/));
  });

  it('returns 1 when bootEngine throws', async () => {
    mockedBootEngine.mockImplementation(() => {
      throw new Error('simulated engine boot failure');
    });
    const code = await main([
      'node',
      'brain_push_cli.ts',
      '--project',
      'p',
      '--remote-url',
      'http://x',
      '--api-key',
      'k',
    ]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/engine boot failed.*simulated engine boot failure/),
    );
  });

  // -------------------------------------------------------------------------
  // BR-064 Fix A regression — fully-migrated DB succeeds
  // -------------------------------------------------------------------------
  // Goal: verify the CLI exits 0 against a freshly-bootstrapped DB whose
  // schema includes goals + every other SYNC_TABLES entry. Pre-Fix-A this
  // path threw `no such table: goals` because the legacy migrateSchema
  // ladder doesn't create goals.
  // -------------------------------------------------------------------------

  it('BR-064 Fix A: fully-migrated DB pushes goals + learnings + event_log cleanly', async () => {
    db = makeFullSyncDb();
    mockedGetDb.mockReturnValue(db);
    // bootEngine shim: returns a no-op Engine handle. The test pre-built the
    // schema, so all "migrations" are already applied — bootEngine has nothing
    // real to do. shutdown() is intentionally a no-op (the test owns the DB
    // lifecycle via afterEach `db.close()`).
    mockedBootEngine.mockReturnValue({
      shutdown: () => {},
      // The CLI never reads these fields — `as any` keeps the shim minimal.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Seed one row in each of the 3 representative tables so the push payload
    // contains all three table arrays.
    db.prepare(`
      INSERT INTO learnings
        (project, category, title, content, review_status, provenance,
         source_extractor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'p',
      'pattern',
      'br-064 fixA learning',
      'body',
      'approved',
      'observed',
      'manual',
      '2026-04-29 10:00:00',
    );
    db.prepare(`
      INSERT INTO goals (goal_id, title, outcome, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('br-064-goal-1', 'fix the goals push', 'goals propagate to remote', 'active', '2026-04-29 10:00:00', '2026-04-29 10:00:00');
    db.prepare(`
      INSERT INTO event_log (event_name, component, payload, project_slug, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('br_064.fix_applied', 'test', '{}', 'p', '2026-04-29 10:00:00');

    const fetchMock = makeFetchSuccessMock();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const code = await main([
      'node',
      'brain_push_cli.ts',
      '--project',
      'p',
      '--remote-url',
      'http://test-remote',
      '--api-key',
      'test-key',
    ]);

    expect(code).toBe(0);
    // bootEngine MUST be called BEFORE handleBrainPush (Fix A wiring).
    expect(mockedBootEngine).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Inspect the push body — all three tables present.
    const body = JSON.parse(
      ((fetchMock.mock.calls[0][1] as RequestInit).body as string),
    ) as { tables: Record<string, Array<Record<string, unknown>>> };

    expect(body.tables).toHaveProperty('learnings');
    expect(body.tables).toHaveProperty('goals');
    expect(body.tables).toHaveProperty('event_log');
    expect(body.tables.goals[0].goal_id).toBe('br-064-goal-1');
    expect(body.tables.learnings[0].title).toBe('br-064 fixA learning');

    // The "no such table" error from BR-064 must NOT appear in stderr.
    const stderrCombined = errSpy.mock.calls
      .map((c) => c.map(String).join(' '))
      .join('\n');
    expect(stderrCombined).not.toMatch(/no such table/);
  });

  // -------------------------------------------------------------------------
  // BR-064 Fix B regression — partial DB skips missing tables gracefully
  // -------------------------------------------------------------------------
  // Goal: verify Fix B's per-table preflight. With a v1-v15-only DB (no
  // goals, no entity_edges, etc.), pushing learnings should succeed while
  // every missing table is logged as a "sync skip" without aborting.
  // -------------------------------------------------------------------------

  it('BR-064 Fix B: missing component tables are skipped, learnings still pushes', async () => {
    db = makeLegacyOnlyDb();
    mockedGetDb.mockReturnValue(db);
    mockedBootEngine.mockReturnValue({
      shutdown: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    db.prepare(`
      INSERT INTO learnings
        (project, category, title, content, review_status, provenance,
         source_extractor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'p',
      'pattern',
      'partial schema learning',
      'body',
      'approved',
      'observed',
      'manual',
      '2026-04-29 10:00:00',
    );

    const fetchMock = makeFetchSuccessMock();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const code = await main([
      'node',
      'brain_push_cli.ts',
      '--project',
      'p',
      '--remote-url',
      'http://test-remote',
      '--api-key',
      'test-key',
    ]);

    expect(code).toBe(0);
    // The push call DID happen — Fix B did not abort.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse(
      ((fetchMock.mock.calls[0][1] as RequestInit).body as string),
    ) as { tables: Record<string, Array<Record<string, unknown>>> };
    // Learnings made it into the payload despite missing siblings.
    expect(body.tables).toHaveProperty('learnings');
    // Goals (and friends) did NOT — there's no row, no schema, nothing to push.
    expect(body.tables).not.toHaveProperty('goals');

    // Fix B log line: every absent table emits a "sync skip" line.
    const stderrCombined = errSpy.mock.calls
      .map((c) => c.map(String).join(' '))
      .join('\n');
    expect(stderrCombined).toMatch(/sync skip: table 'goals' not present locally/);
    // And the "no such table" error from the broken pre-Fix-B path must NOT appear.
    expect(stderrCombined).not.toMatch(/no such table/);
  });

  // -------------------------------------------------------------------------
  // Successful push with config-derived url + key (legacy success-path test)
  // -------------------------------------------------------------------------

  it('reads remote config from config.json when flags are absent', async () => {
    db = makeFullSyncDb();
    mockedGetDb.mockReturnValue(db);
    mockedBootEngine.mockReturnValue({
      shutdown: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const cfgPath = tempPath('cfg-main-ok');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        remote_brain: { url: 'http://test-url', api_key: 'test-key' },
      }),
    );

    // No rows seeded — push should report "No changes to push" (the empty path).
    const fetchMock = makeFetchSuccessMock();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const code = await main([
      'node',
      'brain_push_cli.ts',
      '--project',
      'igris-ai',
      '--config',
      cfgPath,
    ]);

    expect(code).toBe(0);
    // No rows → no fetch call.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No changes to push'));
  });

  // -------------------------------------------------------------------------
  // isError = true (rows queued) is still exit 0
  // -------------------------------------------------------------------------

  it('returns 0 when handleBrainPush enqueues rows for retry (network failure)', async () => {
    db = makeFullSyncDb();
    mockedGetDb.mockReturnValue(db);
    mockedBootEngine.mockReturnValue({
      shutdown: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    db.prepare(`
      INSERT INTO learnings
        (project, category, title, content, review_status, provenance,
         source_extractor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'p',
      'pattern',
      'network-fail row',
      'body',
      'approved',
      'observed',
      'manual',
      '2026-04-29 10:00:00',
    );

    // Fetch always rejects → handleBrainPush queues the row + returns isError=true.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('simulated network failure');
    }) as unknown as typeof globalThis.fetch;

    const code = await main([
      'node',
      'brain_push_cli.ts',
      '--project',
      'p',
      '--remote-url',
      'http://x',
      '--api-key',
      'k',
    ]);

    // Exit 0 — the queue path is the recovery path, not a hard failure.
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('queued for retry'));

    // The row landed in sync_queue.
    const queueCount = db
      .prepare('SELECT count(*) as n FROM sync_queue WHERE table_name = ?')
      .get('learnings') as { n: number };
    expect(queueCount.n).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Engine shutdown is invoked even when handleBrainPush throws
  // -------------------------------------------------------------------------

  it('always calls engine.shutdown() (even on handleBrainPush throw)', async () => {
    db = makeFullSyncDb();
    mockedGetDb.mockReturnValue(db);

    const shutdownSpy = vi.fn();
    mockedBootEngine.mockReturnValue({
      shutdown: shutdownSpy,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Simulate a hard handler throw by dropping the learnings table AFTER
    // bootEngine returned — handleBrainPush will try to query it inside
    // the iterator and throw a SQLite error. Fix B's preflight catches
    // missing tables, so we instead force-fail by dropping sync_state which
    // handleBrainPush queries first.
    db.exec('DROP TABLE sync_state');

    globalThis.fetch = makeFetchSuccessMock() as unknown as typeof globalThis.fetch;

    const code = await main([
      'node',
      'brain_push_cli.ts',
      '--project',
      'p',
      '--remote-url',
      'http://x',
      '--api-key',
      'k',
    ]);

    expect(code).toBe(1);
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/handleBrainPush threw/),
    );
  });
});

// Suppress unused-import warning when consumers don't import BRAIN_DIR.
void _BRAIN_DIR;
