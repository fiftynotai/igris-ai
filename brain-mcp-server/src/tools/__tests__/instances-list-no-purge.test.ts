/**
 * FR-267 — `agent_events` is durable: listing instances must not purge it.
 *
 * Until FR-267, `handleInstanceList` (the `igris_instance_list` tool) and the
 * HTTP `GET /api/instances` route both ran a 7-day purge of `agent_events` as
 * a side effect of LISTING. One call wiped the hunt-cost record this brief
 * exists to keep (R1). Two gates:
 *
 *   1. Behavioral — a 30-day-old row survives `handleInstanceList`.
 *      Red on the pre-FR-267 handler (count 0), green after the purge is gone.
 *   2. Static — no file under `src/` contains the purge statement at all,
 *      so a re-added purge at ANY call site (not just the two known ones)
 *      reds this file. The scanner is armed against a scratch file that DOES
 *      contain the statement, so its "0 matches" is a measurement, not silence.
 *
 * `getDb` is mocked the way `projects-budget.test.ts` does it: an in-memory
 * better-sqlite3 handle stands in for the brain DB.
 *
 * @module tools/__tests__/instances-list-no-purge.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../db.js';
import { handleInstanceList } from '../instances.js';

const mockedGetDb = vi.mocked(getDb);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * In-memory brain with the two tables the list handler touches: `instances`
 * (already at the TD-277 `last_activity_at` shape, so the activity-column
 * helper has nothing to rename) and `agent_events` at the legacy v9 shape.
 */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE instances (
      id TEXT PRIMARY KEY,
      machine_hostname TEXT NOT NULL,
      machine_os TEXT,
      project_slug TEXT,
      project_path TEXT,
      current_brief TEXT,
      current_phase TEXT,
      current_task TEXT,
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'stale')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('start', 'stop', 'error', 'retry')),
      phase TEXT,
      brief_id TEXT,
      duration_ms INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0,
      cache_create INTEGER DEFAULT 0,
      result TEXT,
      error_message TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

/** Recursively collect every `.ts` file under `dir`. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The purge statement, matched loosely (any whitespace, any case). Assembled
 * from two halves so THIS file's own source never matches its own scanner.
 */
const PURGE_PATTERN = new RegExp('DELETE' + '\\s+FROM\\s+agent_events', 'i');

/** Count files under `dir` whose source matches the purge pattern. */
function scanForPurge(dir: string): { visited: number; offenders: string[] } {
  const files = listTsFiles(dir);
  const offenders = files.filter((f) => PURGE_PATTERN.test(readFileSync(f, 'utf8')));
  return { visited: files.length, offenders };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FR-267 — listing instances does not purge agent_events', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('a 30-day-old agent_events row survives handleInstanceList', () => {
    db.prepare(
      "INSERT INTO instances (id, machine_hostname, project_slug) VALUES ('inst-1', 'host', 'igris-ai')",
    ).run();
    db.prepare(
      `INSERT INTO agent_events (instance_id, agent, event_type, brief_id, created_at)
       VALUES ('inst-1', 'forger', 'start', 'FR-267', datetime('now', '-30 days'))`,
    ).run();

    // Precondition: the row is there before the list call.
    const before = db.prepare('SELECT COUNT(*) AS c FROM agent_events').get() as { c: number };
    expect(before.c).toBe(1);

    const result = handleInstanceList({});
    expect(result.content[0].text).toContain('inst-1');

    // The row must still be there AFTER listing — the pre-FR-267 handler
    // deleted it here (created_at older than 7 days).
    const after = db.prepare('SELECT COUNT(*) AS c FROM agent_events').get() as { c: number };
    expect(after.c).toBe(1);
  });

  it('a 30-day-old row also survives the include_stale / filtered list paths', () => {
    db.prepare(
      "INSERT INTO instances (id, machine_hostname, project_slug, status) VALUES ('inst-2', 'host', 'igris-ai', 'stale')",
    ).run();
    db.prepare(
      `INSERT INTO agent_events (instance_id, agent, event_type, created_at)
       VALUES ('inst-2', 'sentinel', 'stop', datetime('now', '-30 days'))`,
    ).run();

    handleInstanceList({ include_stale: true, project: 'igris-ai', status: 'all' });

    const after = db.prepare('SELECT COUNT(*) AS c FROM agent_events').get() as { c: number };
    expect(after.c).toBe(1);
  });
});

describe('FR-267 — no purge statement anywhere under src/', () => {
  // __tests__ → tools → src
  const SRC_DIR = resolve(import.meta.dirname, '../..');

  it('the scanner is armed: it finds the statement in a scratch file that contains it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr267-purge-scan-'));
    try {
      writeFileSync(
        join(dir, 'planted.ts'),
        `db.prepare("DELETE FROM` + ` agent_events WHERE created_at < datetime('now', '-7 days')").run();\n`,
      );
      writeFileSync(join(dir, 'clean.ts'), `db.prepare('SELECT 1').run();\n`);
      const { visited, offenders } = scanForPurge(dir);
      expect(visited).toBe(2);
      expect(offenders.map((f) => f.endsWith('planted.ts'))).toEqual([true]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('zero source files under src/ contain the purge statement', () => {
    const { visited, offenders } = scanForPurge(SRC_DIR);
    // The scan must have reached the two former purge sites at all.
    const visitedFiles = listTsFiles(SRC_DIR);
    expect(visitedFiles).toContain(join(SRC_DIR, 'tools', 'instances.ts'));
    expect(visitedFiles).toContain(join(SRC_DIR, 'index.ts'));
    expect(visited).toBeGreaterThan(100);

    expect(
      offenders,
      `purge statement found in: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
