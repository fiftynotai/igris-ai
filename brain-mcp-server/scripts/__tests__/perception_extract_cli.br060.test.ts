/**
 * BR-060 — perception_extract_cli regression test for the sqlite-vec mutex
 * teardown abort.
 *
 * Background:
 *   The pre-fix CLI opened the brain DB via `getDb()` and exited via
 *   `process.exit(0)` without releasing sqlite-vec's native mutex. When LLM
 *   candidates were generated and embeddings were written, the native atexit
 *   handler raced with Node teardown and aborted with `mutex lock failed:
 *   Invalid argument` (libc++abi SIGABRT, exit ~134). The wrapper script
 *   `perception_extract_and_persist.sh` checks `cli_rc -eq 0` before spawning
 *   `brain_push_async.sh` — so the abort silently broke TD-080's session_end
 *   auto-push end-to-end.
 *
 * Fix shape (mirrors BR-064):
 *   1. `bootEngine({ dbPath, components: {} })` BEFORE work.
 *   2. The post-args workflow runs inside `try { ... } finally { ... }`.
 *   3. The finally block disposes the @huggingface/transformers pipeline
 *      first (releases ONNX worker thread), then calls `engine.shutdown()`.
 *   4. A 5-second defensive timer wraps the shutdown — if either step hangs,
 *      force-exit 0 (the success line and lifecycle events are already
 *      persisted at this point).
 *   5. The wrapper script (`perception_extract_and_persist.sh`) prefixes
 *      the npx invocation with `IGRIS_DISABLE_VEC=1` — the load-bearing
 *      Path C from the plan, since `engine.shutdown()` alone could not
 *      eliminate the race against sqlite-vec on macOS / libc++.
 *
 * What this file asserts:
 *   - `bootEngine` is invoked exactly once per `main()` call.
 *   - The engine's `shutdown()` runs on every code path that booted the
 *     engine — success, db_error pre-flight, runPerception throw, and the
 *     empty-transcript silent return.
 *   - The transformers pipeline `dispose()` is called BEFORE `shutdown()`
 *     in the finally block (ordering is load-bearing).
 *   - The CLI returns the same exit codes as the pre-fix tests: 0 on
 *     success / empty / runner throw, 1 on malformed args / engine boot
 *     failure / missing learnings table.
 *   - The work-product (inserted/llm/suppressed counts, llm_status) is
 *     unchanged regardless of vec availability.
 *
 * Test strategy:
 *   We mock `bootEngine` and `disposeEmbeddingPipeline` at the I/O boundary
 *   (mirror brain_push_cli.test.ts) and assert call ordering via
 *   `mock.invocationCallOrder`. The actual native abort cannot be reproduced
 *   inside a single test process without aborting vitest itself — that path
 *   is covered by the live e2e verification step in the brief checklist.
 *
 * @module scripts/__tests__/perception_extract_cli.br060.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE the SUT imports so the import chain
// picks up the mocked symbols. We mock at the I/O / native boundary so the
// test can exercise the CLI's wiring without spawning a subprocess that
// would reproduce the SIGABRT and crash vitest.
// ---------------------------------------------------------------------------

vi.mock('../../src/db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

vi.mock('../../src/engine/index.js', () => ({
  bootEngine: vi.fn(),
}));

vi.mock('../../src/utils/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(384)),
  embeddingToBuffer: vi.fn((e: Float32Array) =>
    Buffer.from(e.buffer, e.byteOffset, e.byteLength),
  ),
  disposeEmbeddingPipeline: vi.fn(async () => {}),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DIMENSIONS: 384,
}));

vi.mock('../../src/utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbedding: vi.fn(),
}));

// FR-120: mock handleBrainPush at the I/O boundary so the inline push phase
// does not actually fetch the VPS. Default is benign success — the BR-060
// regression tests only need the push call to land on the right side of the
// shutdown ordering, not to do real work.
vi.mock('../../src/tools/sync.js', () => ({
  handleBrainPush: vi.fn(async () => ({
    content: [{ type: 'text', text: 'Brain push: 0 changes (test stub)' }],
  })),
}));

import { getDb } from '../../src/db.js';
import { bootEngine } from '../../src/engine/index.js';
import { disposeEmbeddingPipeline } from '../../src/utils/embeddings.js';
import { handleBrainPush } from '../../src/tools/sync.js';
import { main } from '../perception_extract_cli.js';

const mockedGetDb = vi.mocked(getDb);
const mockedBootEngine = vi.mocked(bootEngine);
const mockedDisposePipeline = vi.mocked(disposeEmbeddingPipeline);
const mockedHandleBrainPush = vi.mocked(handleBrainPush);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tempPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${randomBytes(6).toString('hex')}`);
}

/**
 * Build a minimal in-memory brain DB matching the schema needed by the CLI's
 * pre-flight + runPerception path.
 */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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

/**
 * Build a no-op Engine shim so the CLI's `engine.shutdown()` in the finally
 * block is a no-op (the test owns the DB lifecycle via afterEach db.close()).
 * Returns a Vitest mock fn for shutdown so call-order assertions can read
 * `shutdownMock.mock.invocationCallOrder[0]`.
 */
function makeEngineShim(): {
  engine: ReturnType<typeof bootEngine>;
  shutdownMock: ReturnType<typeof vi.fn>;
} {
  const shutdownMock = vi.fn();
  return {
    // The CLI never reads non-`shutdown` engine fields — `as any` keeps this
    // shim minimal. Brain_push_cli.test.ts uses the same trick.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: { shutdown: shutdownMock } as any,
    shutdownMock,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('perception_extract_cli — BR-060 lifecycle wiring', () => {
  let db: Database.Database;
  const cleanupFiles: string[] = [];
  let originalIgrisDbPath: string | undefined;
  let prevLlmEnabled: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
    mockedBootEngine.mockReset();
    mockedDisposePipeline.mockReset();
    mockedDisposePipeline.mockResolvedValue();
    mockedHandleBrainPush.mockClear();
    mockedHandleBrainPush.mockImplementation(async () => ({
      content: [{ type: 'text', text: 'Brain push: 0 changes (test stub)' }],
    }));
    originalIgrisDbPath = process.env.IGRIS_DB_PATH;
    // Force the noop LLM extractor path so the test does not depend on the
    // `claude` CLI being installed — same posture as the lifecycle test.
    prevLlmEnabled = process.env.IGRIS_PERCEPTION_LLM_ENABLED;
    process.env.IGRIS_PERCEPTION_LLM_ENABLED = '0';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (originalIgrisDbPath === undefined) {
      delete process.env.IGRIS_DB_PATH;
    } else {
      process.env.IGRIS_DB_PATH = originalIgrisDbPath;
    }
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

  // -------------------------------------------------------------------------
  // bootEngine must be called for every CLI run that gets past arg parsing
  // -------------------------------------------------------------------------

  it('boots the engine exactly once per main() call (success path)', async () => {
    const { engine } = makeEngineShim();
    mockedBootEngine.mockReturnValue(engine);

    const tp = tempPath('br060-success');
    fs.writeFileSync(tp, 'plain transcript');
    cleanupFiles.push(tp);

    const exitCode = await main([
      'node',
      'perception_extract_cli.ts',
      '--project',
      'br060-test',
      '--transcript-path',
      tp,
    ]);

    expect(exitCode).toBe(0);
    expect(mockedBootEngine).toHaveBeenCalledTimes(1);
  });

  it('does NOT boot the engine on malformed args (exits 1 before boot)', async () => {
    const { engine } = makeEngineShim();
    mockedBootEngine.mockReturnValue(engine);

    const exitCode = await main(['node', 'perception_extract_cli.ts']);

    expect(exitCode).toBe(1);
    expect(mockedBootEngine).not.toHaveBeenCalled();
  });

  it('does NOT boot the engine on --help (exits 0 before boot)', async () => {
    const { engine } = makeEngineShim();
    mockedBootEngine.mockReturnValue(engine);

    const exitCode = await main(['node', 'perception_extract_cli.ts', '--help']);

    expect(exitCode).toBe(0);
    expect(mockedBootEngine).not.toHaveBeenCalled();
  });

  it('returns 1 when bootEngine itself throws (engine boot failure)', async () => {
    mockedBootEngine.mockImplementation(() => {
      throw new Error('simulated engine boot failure');
    });

    const tp = tempPath('br060-bootfail');
    fs.writeFileSync(tp, 'content');
    cleanupFiles.push(tp);

    const exitCode = await main([
      'node',
      'perception_extract_cli.ts',
      '--project',
      'p',
      '--transcript-path',
      tp,
    ]);

    expect(exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/engine boot failed.*simulated engine boot failure/),
    );
    // Pipeline dispose is in the finally block of the post-boot try/finally,
    // so it should NOT be called on a pre-boot failure path.
    expect(mockedDisposePipeline).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // The finally block runs on every code path that booted the engine
  // -------------------------------------------------------------------------

  it('shuts down the engine on the success path', async () => {
    const { engine, shutdownMock } = makeEngineShim();
    mockedBootEngine.mockReturnValue(engine);

    const tp = tempPath('br060-shut-success');
    fs.writeFileSync(tp, 'plain transcript');
    cleanupFiles.push(tp);

    const exitCode = await main([
      'node',
      'perception_extract_cli.ts',
      '--project',
      'p',
      '--transcript-path',
      tp,
    ]);

    expect(exitCode).toBe(0);
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('shuts down the engine on the empty-transcript silent return', async () => {
    const { engine, shutdownMock } = makeEngineShim();
    mockedBootEngine.mockReturnValue(engine);

    const tp = tempPath('br060-empty-transcript');
    fs.writeFileSync(tp, '');
    cleanupFiles.push(tp);

    const exitCode = await main([
      'node',
      'perception_extract_cli.ts',
      '--project',
      'p',
      '--transcript-path',
      tp,
    ]);

    expect(exitCode).toBe(0);
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('shuts down the engine on the absent-transcript silent return', async () => {
    const { engine, shutdownMock } = makeEngineShim();
    mockedBootEngine.mockReturnValue(engine);

    const exitCode = await main([
      'node',
      'perception_extract_cli.ts',
      '--project',
      'p',
      '--transcript-path',
      tempPath('br060-absent'),
    ]);

    expect(exitCode).toBe(0);
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('shuts down the engine on the db_error pre-flight (missing learnings table)', async () => {
    const { engine, shutdownMock } = makeEngineShim();
    mockedBootEngine.mockReturnValue(engine);

    // Replace the mocked DB with one that has only event_log, no learnings.
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

    const tp = tempPath('br060-db-error');
    fs.writeFileSync(tp, 'content');
    cleanupFiles.push(tp);

    try {
      const exitCode = await main([
        'node',
        'perception_extract_cli.ts',
        '--project',
        'p',
        '--transcript-path',
        tp,
      ]);
      expect(exitCode).toBe(1);
      // The finally block STILL runs even though main returned 1 inside the try.
      expect(shutdownMock).toHaveBeenCalledTimes(1);
    } finally {
      eventOnlyDb.close();
    }
  });

  // -------------------------------------------------------------------------
  // Pipeline dispose ordering — load-bearing for native cleanup safety
  // -------------------------------------------------------------------------

  it('disposes the embedding pipeline BEFORE engine.shutdown() in the finally', async () => {
    const { engine, shutdownMock } = makeEngineShim();
    mockedBootEngine.mockReturnValue(engine);

    const tp = tempPath('br060-order');
    fs.writeFileSync(tp, 'plain transcript');
    cleanupFiles.push(tp);

    const exitCode = await main([
      'node',
      'perception_extract_cli.ts',
      '--project',
      'p',
      '--transcript-path',
      tp,
    ]);

    expect(exitCode).toBe(0);
    expect(mockedDisposePipeline).toHaveBeenCalledTimes(1);
    expect(shutdownMock).toHaveBeenCalledTimes(1);
    // BR-060 root cause: dispose MUST happen before shutdown so the
    // transformers worker is gone before sqlite-vec teardown runs. Vitest
    // exposes the global call-order via `mock.invocationCallOrder`.
    const disposeOrder = mockedDisposePipeline.mock.invocationCallOrder[0];
    const shutdownOrder = shutdownMock.mock.invocationCallOrder[0];
    expect(disposeOrder).toBeLessThan(shutdownOrder);
  });

  // -------------------------------------------------------------------------
  // Defensive shutdown timeout — the 5s force-exit safety net
  // -------------------------------------------------------------------------

  it('continues to exit 0 cleanly when engine.shutdown() throws', async () => {
    const { engine } = makeEngineShim();
    // Replace shutdown with one that throws — exercises the inner catch
    // block in the finally. Process should still exit 0.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).shutdown = () => {
      throw new Error('simulated shutdown failure');
    };
    mockedBootEngine.mockReturnValue(engine);

    const tp = tempPath('br060-shutdown-throws');
    fs.writeFileSync(tp, 'plain transcript');
    cleanupFiles.push(tp);

    const exitCode = await main([
      'node',
      'perception_extract_cli.ts',
      '--project',
      'p',
      '--transcript-path',
      tp,
    ]);

    expect(exitCode).toBe(0);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/shutdown failed.*simulated shutdown failure/),
    );
  });

  // -------------------------------------------------------------------------
  // FR-120: inline push must run BEFORE disposeEmbeddingPipeline AND
  // engine.shutdown so handleBrainPush's getDb() resolves to a live
  // connection. Pushing AFTER shutdown would fail (no DB connection).
  // -------------------------------------------------------------------------

  it('FR-120: invokes handleBrainPush BEFORE disposeEmbeddingPipeline and engine.shutdown', async () => {
    // Setup: tmpHome with a config.json fixture so the inline push phase
    // resolves a remote and actually calls handleBrainPush. Without this
    // the test would short-circuit to push=remote_not_configured and the
    // ordering assertion would never fire.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fr120-br060-'));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    const cfgPath = path.join(tmpHome, '.igris', 'config.json');
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        remote_brain: { url: 'http://test:3001', api_key: 'k' },
      }),
    );

    const { engine, shutdownMock } = makeEngineShim();
    mockedBootEngine.mockReturnValue(engine);

    const tp = tempPath('br060-fr120-order');
    fs.writeFileSync(tp, 'plain transcript');
    cleanupFiles.push(tp);

    try {
      const exitCode = await main([
        'node',
        'perception_extract_cli.ts',
        '--project',
        'p',
        '--transcript-path',
        tp,
        '--no-log',
      ]);

      expect(exitCode).toBe(0);
      expect(mockedHandleBrainPush).toHaveBeenCalledTimes(1);
      expect(mockedDisposePipeline).toHaveBeenCalledTimes(1);
      expect(shutdownMock).toHaveBeenCalledTimes(1);

      const pushOrder = mockedHandleBrainPush.mock.invocationCallOrder[0];
      const disposeOrder = mockedDisposePipeline.mock.invocationCallOrder[0];
      const shutdownOrder = shutdownMock.mock.invocationCallOrder[0];

      // Push must complete first; dispose next; shutdown last. The DB
      // connection must still be open during the push, and the
      // transformers worker must still be alive (no race).
      expect(pushOrder).toBeLessThan(disposeOrder);
      expect(disposeOrder).toBeLessThan(shutdownOrder);
    } finally {
      if (origHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = origHome;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
