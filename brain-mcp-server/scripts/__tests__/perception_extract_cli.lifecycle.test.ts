/**
 * Perception CLI lifecycle event integration tests (TD-074).
 *
 * Drives `main()` in-process against a sandboxed in-memory DB and verifies
 * that the detached CLI produces the expected `event_log` rows for every
 * lifecycle path:
 *   - successful run → 1× run_started + 1× run_succeeded
 *   - missing learnings table → 1× run_failed (reason='db_error') + exit 1
 *   - empty transcript → no events written (matches "exit 0 silent" contract)
 *   - process exits 0 on every code path except db_error and malformed args
 *
 * The runner-level lifecycle invariant is covered by
 * `runner.lifecycle.test.ts`; this file focuses on the CLI's own emissions
 * (db_error pre-flight) and asserts the wiring through `main()`.
 *
 * @module scripts/__tests__/perception_extract_cli.lifecycle.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

// Mock embeddings + vector-search before importing the CLI module.
vi.mock('../../src/utils/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(384)),
  embeddingToBuffer: vi.fn((e: Float32Array) => Buffer.from(e.buffer, e.byteOffset, e.byteLength)),
  // BR-060: stub the pipeline disposer so the CLI's finally block can call it
  // without surfacing "No export is defined" warnings at test time.
  disposeEmbeddingPipeline: vi.fn(async () => {}),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DIMENSIONS: 384,
}));
vi.mock('../../src/utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbedding: vi.fn(),
}));
vi.mock('../../src/db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));
// BR-060: mock bootEngine so the CLI's engine.shutdown() in finally is a no-op.
// The test owns the DB lifecycle via afterEach db.close().
vi.mock('../../src/engine/index.js', () => ({
  bootEngine: vi.fn(),
}));
// FR-120: mock handleBrainPush at the I/O boundary so the inline push phase
// in main() does not actually fetch the VPS during lifecycle event tests.
vi.mock('../../src/tools/sync.js', () => ({
  handleBrainPush: vi.fn(async () => ({
    content: [{ type: 'text', text: 'Brain push: 0 changes (test stub)' }],
  })),
}));

import { getDb } from '../../src/db.js';
import { bootEngine } from '../../src/engine/index.js';
import { main } from '../perception_extract_cli.js';

const mockedGetDb = vi.mocked(getDb);
const mockedBootEngine = vi.mocked(bootEngine);

/**
 * Build a no-op Engine shim for tests. shutdown() is a no-op because the test
 * owns the DB lifecycle (afterEach calls db.close()).
 */
function makeEngineShim(): ReturnType<typeof bootEngine> {
  return {
    shutdown: () => {},
    // The CLI never reads these fields — `as any` keeps the shim minimal.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFullSchemaDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
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
      embedding BLOB,
      embedding_model TEXT DEFAULT '',
      provenance TEXT NOT NULL DEFAULT 'observed',
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual'
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
  return db;
}

function tempPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${randomBytes(6).toString('hex')}`);
}

interface PerceptionRow {
  event_name: string;
  payload: Record<string, unknown>;
}

function readPerceptionEvents(db: Database.Database): PerceptionRow[] {
  const rows = db
    .prepare(
      "SELECT event_name, payload FROM event_log WHERE component = 'perception' ORDER BY id ASC",
    )
    .all() as { event_name: string; payload: string }[];
  return rows.map((r) => ({
    event_name: r.event_name,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('perception_extract_cli lifecycle events (TD-074)', () => {
  let db: Database.Database;
  const cleanupFiles: string[] = [];
  let prevLlmEnabled: string | undefined;

  beforeEach(() => {
    db = makeFullSchemaDb();
    mockedGetDb.mockReturnValue(db);
    // BR-060: bootEngine returns a no-op shim. shutdown() does nothing — the
    // test owns DB lifecycle via afterEach db.close().
    mockedBootEngine.mockReturnValue(makeEngineShim());
    // Force the noop LLM extractor so the test does not depend on the
    // `claude` CLI being installed (CI hosts may lack it).
    prevLlmEnabled = process.env.IGRIS_PERCEPTION_LLM_ENABLED;
    process.env.IGRIS_PERCEPTION_LLM_ENABLED = '0';
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    if (prevLlmEnabled === undefined) {
      delete process.env.IGRIS_PERCEPTION_LLM_ENABLED;
    } else {
      process.env.IGRIS_PERCEPTION_LLM_ENABLED = prevLlmEnabled;
    }
    for (const f of cleanupFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    cleanupFiles.length = 0;
  });

  it('writes run_started + run_succeeded for a successful run', async () => {
    const tp = tempPath('content-transcript');
    fs.writeFileSync(tp, 'plain transcript blob — extractor returns []');
    cleanupFiles.push(tp);

    const inbox = tempPath('inbox');
    fs.writeFileSync(inbox, 'old content\n');
    cleanupFiles.push(inbox);

    const exitCode = await main([
      'node',
      'script.ts',
      '--project',
      'igris-ai',
      '--transcript-path',
      tp,
      '--inbox-path',
      inbox,
    ]);

    expect(exitCode).toBe(0);
    // Inbox truncated on success.
    expect(fs.readFileSync(inbox, 'utf-8')).toBe('');

    const lifecycle = readPerceptionEvents(db);
    expect(lifecycle.map((e) => e.event_name)).toEqual([
      'perception.run_started',
      'perception.run_succeeded',
    ]);
    // Trigger threaded as 'detached' from the CLI.
    expect(lifecycle[0].payload.trigger).toBe('detached');
    expect(lifecycle[1].payload.trigger).toBe('detached');
    // candidates_count=0 since the LLM is disabled (forced via env).
    expect(lifecycle[1].payload.candidates_count).toBe(0);
  });

  it('writes run_failed (reason=db_error) and exits 1 when learnings table missing', async () => {
    // Replace the mocked DB with one that has event_log but no learnings.
    const eventOnlyDb = new Database(':memory:');
    eventOnlyDb.pragma('journal_mode = WAL');
    eventOnlyDb.exec(`
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
    mockedGetDb.mockReturnValue(eventOnlyDb);

    const tp = tempPath('any-transcript');
    fs.writeFileSync(tp, 'content');
    cleanupFiles.push(tp);

    try {
      const exitCode = await main([
        'node',
        'script.ts',
        '--project',
        'igris-ai',
        '--transcript-path',
        tp,
      ]);
      expect(exitCode).toBe(1);

      const lifecycle = readPerceptionEvents(eventOnlyDb);
      expect(lifecycle).toHaveLength(1);
      expect(lifecycle[0].event_name).toBe('perception.run_failed');
      expect(lifecycle[0].payload.reason).toBe('db_error');
      expect(lifecycle[0].payload.trigger).toBe('detached');
    } finally {
      eventOnlyDb.close();
    }
  });

  it('writes NO events for an empty transcript (exits 0 silently)', async () => {
    const tp = tempPath('empty-transcript');
    fs.writeFileSync(tp, '');
    cleanupFiles.push(tp);

    const exitCode = await main([
      'node',
      'script.ts',
      '--project',
      'igris-ai',
      '--transcript-path',
      tp,
    ]);

    expect(exitCode).toBe(0);
    expect(readPerceptionEvents(db)).toHaveLength(0);
  });

  it('writes NO events for an absent transcript file (exits 0 silently)', async () => {
    const exitCode = await main([
      'node',
      'script.ts',
      '--project',
      'igris-ai',
      '--transcript-path',
      tempPath('absent'),
    ]);

    expect(exitCode).toBe(0);
    expect(readPerceptionEvents(db)).toHaveLength(0);
  });

  it('exits 1 (NOT 0) for malformed CLI args — no events emitted', async () => {
    // No transcript-path arg at all.
    const exitCode = await main(['node', 'script.ts']);
    expect(exitCode).toBe(1);
    expect(readPerceptionEvents(db)).toHaveLength(0);
  });

  it('lifecycle invariant: every run_started is paired with exactly one terminal event', async () => {
    // Drive 3 successful runs back-to-back. After all complete, every
    // run_started has a matching run_succeeded.
    for (let i = 0; i < 3; i++) {
      const tp = tempPath(`run-${i}`);
      fs.writeFileSync(tp, `transcript ${i}`);
      cleanupFiles.push(tp);
      const exitCode = await main([
        'node',
        'script.ts',
        '--project',
        'igris-ai',
        '--transcript-path',
        tp,
      ]);
      expect(exitCode).toBe(0);
    }

    const lifecycle = readPerceptionEvents(db);
    const startedCount = lifecycle.filter((e) => e.event_name === 'perception.run_started').length;
    const terminalCount = lifecycle.filter((e) =>
      ['perception.run_succeeded', 'perception.run_failed'].includes(e.event_name),
    ).length;
    expect(startedCount).toBe(3);
    expect(terminalCount).toBe(3);
  });
});
