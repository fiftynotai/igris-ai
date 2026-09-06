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
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports
// ---------------------------------------------------------------------------

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

// FR-220: the post-merge embed helper calls `embedNullLearnings`, which uses
// the shipped `generateEmbedding` singleton (no dep-injection seam threads
// through the helper). Mock ONLY `generateEmbedding` with a deterministic fake
// (FNV-1a → xorshift32 → L2-normalise; identical text → identical unit vector),
// keeping every other embeddings export ACTUAL (embeddingToBuffer, EMBEDDING_MODEL).
// The fake + its control state live in vi.hoisted so the mock factory (hoisted
// above imports) and the test bodies share one instance.
const H = vi.hoisted(() => {
  function fakeVector(text: string): Float32Array {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    let state = h || 1;
    const v = new Float32Array(384);
    let norm = 0;
    for (let i = 0; i < 384; i++) {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      const x = state / 0xffffffff - 0.5;
      v[i] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 384; i++) v[i] /= norm;
    return v;
  }
  const control = {
    throwNext: false,
    gate: null as Promise<void> | null,
    embedCount: 0,
  };
  const embed = async (text: string): Promise<Float32Array> => {
    control.embedCount++;
    if (control.throwNext) throw new Error('fr220 fake embedder boom');
    if (control.gate) await control.gate;
    return fakeVector(text);
  };
  return { fakeVector, control, embed };
});

vi.mock('../../utils/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/embeddings.js')>();
  return {
    ...actual,
    generateEmbedding: (text: string) => H.embed(text),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../db.js';
import {
  handleBrainPush,
  handleBrainPull,
  handleSessionFilePull,
  processSyncPush,
  mergeRows,
  scheduleLearningEmbedAfterMerge,
  runPostMergeEmbedPass,
  relativizeEgressPath,
  redactTablesForEgress,
  SYNC_TABLES,
  type SyncPushResult,
} from '../sync.js';
import { createInstancesComponent } from '../../engine/components/instances/index.js';
import {
  embeddingToBuffer,
  bufferToEmbedding,
  EMBEDDING_MODEL,
} from '../../utils/embeddings.js';
import { insertEmbedding } from '../../utils/vector-search.js';
import { normalizedFingerprint } from '../../utils/learning-embed.js';

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
      source_extractor TEXT NOT NULL DEFAULT 'manual',
      -- FR-200 M2: nullable promotion pointer (db.ts v16); now in SYNC_TABLES.
      promoted_to_doc TEXT
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

    it('includes promoted_to_doc (FR-200 M2 doc-promotion pointer)', () => {
      const config = SYNC_TABLES.find((t) => t.table === 'learnings');
      expect(config).toBeDefined();
      expect(config!.columns).toContain('promoted_to_doc');
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
      // FR-200 M2: promoted_to_doc replicates (null for this unpromoted row).
      expect(row).toHaveProperty('promoted_to_doc');
      expect(row.promoted_to_doc).toBeNull();
    });
  });
});

describe('Sync — TD-280 handleSessionFilePull coerces BLOB content to string', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE session_files (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        filename TEXT NOT NULL,
        content TEXT,
        content_hash TEXT,
        updated_at TEXT,
        instance_id TEXT,
        state TEXT
      );
    `);
    mockedGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it('returns content as a string (never a Buffer-JSON shape) for a BLOB row', () => {
    // Seed a row whose content is bound as a Buffer → better-sqlite3 stores a
    // genuine BLOB (the pre-existing bad-row shape this fix tolerates on read).
    db.prepare(
      `INSERT INTO session_files (id, project, filename, content, content_hash, updated_at, instance_id, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'blob-1',
      'igris-ai',
      'instances/blob.md',
      Buffer.from('**Mode:** REST MODE', 'utf8'),
      'hash',
      '2026-06-29 00:00:00',
      null,
      'rested',
    );
    expect(
      (db.prepare("SELECT typeof(content) AS t FROM session_files WHERE filename = ?")
        .get('instances/blob.md') as { t: string }).t,
    ).toBe('blob');

    const result = handleSessionFilePull({ project: 'igris-ai' });
    const payload = JSON.parse(result.content[0].text) as {
      files: { filename: string; content: unknown }[];
    };
    expect(payload.files).toHaveLength(1);
    expect(typeof payload.files[0].content).toBe('string');
    expect(payload.files[0].content).toBe('**Mode:** REST MODE');
  });
});

// ---------------------------------------------------------------------------
// FR-220 — post-merge learning-embedding hook (both merge sites)
// ---------------------------------------------------------------------------
//
// A synced-in learning arrives with a NULL embedding (embeddings are NOT a
// `learnings` SYNC_TABLES column — the receiver derives them locally). This
// suite drives the EXPORTED helper directly (no Express) against a real
// sqlite-vec DB with a deterministic fake embedder (mocked generateEmbedding),
// asserting:
//   - both sites (push via processSyncPush, pull via handleBrainPull) schedule
//     a pass that embeds a NULL row;
//   - a throwing embedder never rejects out of the helper / fails the merge;
//   - a text-changed LWW update NULLs the stale embedding in-merge and the pass
//     re-embeds via the normalized fingerprint;
//   - a clean all-embedded merge schedules no pass;
//   - two overlapping schedule calls coalesce to at most one follow-up pass with
//     no double-write.
describe('Sync — FR-220 post-merge learning embedding', () => {
  const requireCjs = createRequire(import.meta.url);
  let dir: string;
  let db: Database.Database;

  const T = { project: 'test-proj', category: 'pattern', title: 'A Title' };

  function makeVecSyncDb(): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr220-'));
    const dbPath = path.join(dir, `sync-${randomBytes(4).toString('hex')}.db`);
    db = new Database(dbPath);
    (requireCjs('sqlite-vec') as { load: (d: Database.Database) => void }).load(db);
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
        source_extractor TEXT NOT NULL DEFAULT 'manual',
        promoted_to_doc TEXT,
        embedding BLOB,
        embedding_model TEXT DEFAULT ''
      );
      CREATE VIRTUAL TABLE learnings_vec USING vec0(embedding float[384]);
      CREATE TRIGGER learnings_vec_ad AFTER DELETE ON learnings BEGIN
        DELETE FROM learnings_vec WHERE rowid = old.id;
      END;
      CREATE TABLE sync_state (
        remote_url TEXT NOT NULL,
        table_name TEXT NOT NULL,
        last_push_at TEXT,
        last_pull_at TEXT,
        PRIMARY KEY (remote_url, table_name)
      );
    `);
  }

  /** A full learnings wire row (all NOT NULL columns present for LWW UPDATE). */
  function wireRow(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      project: T.project,
      category: T.category,
      title: T.title,
      content: 'body',
      tags: '',
      tech_stack: '',
      scope: 'local',
      source_brief: '',
      confidence: 0.8,
      created_at: '2025-01-01 00:00:00',
      updated_at: '2025-01-01 00:00:00',
      access_count: 0,
      provenance: 'observed',
      review_status: 'approved',
      source_extractor: 'manual',
      ...overrides,
    };
  }

  function seedEmbeddedRow(content: string, createdAt: string): number {
    const vec = H.fakeVector(normalizedFingerprint(T.title, content));
    const res = db.prepare(
      `INSERT INTO learnings (project, category, title, content, created_at, updated_at, embedding, embedding_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(T.project, T.category, T.title, content, createdAt, createdAt, embeddingToBuffer(vec), EMBEDDING_MODEL);
    const id = Number(res.lastInsertRowid);
    insertEmbedding(db, id, vec);
    return id;
  }

  const nullCount = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM learnings WHERE embedding IS NULL').get() as { n: number }).n;
  const vecCount = (id: number): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM learnings_vec WHERE rowid = ?').get(BigInt(id)) as { n: number }).n;
  const embeddingOf = (id: number): Buffer | null =>
    (db.prepare('SELECT embedding FROM learnings WHERE id = ?').get(id) as { embedding: Buffer | null }).embedding;

  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
  async function waitFor(pred: () => boolean, tries = 50): Promise<void> {
    for (let i = 0; i < tries; i++) {
      if (pred()) return;
      await tick();
    }
  }

  beforeEach(() => {
    makeVecSyncDb();
    mockedGetDb.mockReturnValue(db);
    H.control.throwNext = false;
    H.control.gate = null;
    H.control.embedCount = 0;
  });

  afterEach(async () => {
    // Let any in-flight pass drain so the module-level coalescing guard resets
    // (embedInFlight clears in the pass's finally) before the next test.
    await waitFor(() => nullCount() === 0, 10);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('push site: a merged-in NULL-embedding learning is embedded after the pass', async () => {
    const { results, ok } = processSyncPush(db, {
      learnings: [wireRow({ content: 'a fresh synced learning' })],
    });
    expect(ok).toBe(true);
    expect(results['learnings'].inserted).toBe(1);
    const id = (db.prepare('SELECT id FROM learnings WHERE content = ?').get('a fresh synced learning') as { id: number }).id;
    expect(embeddingOf(id)).toBeNull(); // synced in with NULL embedding

    scheduleLearningEmbedAfterMerge(db, results);
    await waitFor(() => nullCount() === 0);

    expect(embeddingOf(id)).not.toBeNull();
    expect(vecCount(id)).toBe(1); // lockstep vec write
    const model = (db.prepare('SELECT embedding_model FROM learnings WHERE id = ?').get(id) as { embedding_model: string }).embedding_model;
    expect(model).toBe(EMBEDDING_MODEL);
    // stored the NORMALIZED fingerprint, not a raw concat.
    const stored = embeddingOf(id)!;
    expect(stored.equals(embeddingToBuffer(H.fakeVector(normalizedFingerprint(T.title, 'a fresh synced learning'))))).toBe(true);
  });

  it('pull site: handleBrainPull merges a NULL row and the pass embeds it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ tables: { learnings: [wireRow({ content: 'pulled learning body' })] } }),
      text: async () => '',
    })));

    await handleBrainPull({ remote_url: 'https://brain.example', api_key: 'k' });

    const id = (db.prepare('SELECT id FROM learnings WHERE content = ?').get('pulled learning body') as { id: number }).id;
    await waitFor(() => nullCount() === 0);

    expect(embeddingOf(id)).not.toBeNull();
    expect(vecCount(id)).toBe(1);
  });

  it('non-blocking on failure: a throwing embedder never rejects out / never fails the merge', async () => {
    H.control.throwNext = true;
    const { results, ok } = processSyncPush(db, {
      learnings: [wireRow({ content: 'will fail to embed' })],
    });
    expect(ok).toBe(true); // merge succeeded regardless
    expect(results['learnings'].inserted).toBe(1);
    const id = (db.prepare('SELECT id FROM learnings WHERE content = ?').get('will fail to embed') as { id: number }).id;

    // schedule() returns synchronously (void) and must not throw.
    expect(() => scheduleLearningEmbedAfterMerge(db, results)).not.toThrow();
    // let the pass run + fail internally.
    await tick(); await tick(); await tick();

    expect(H.control.embedCount).toBeGreaterThan(0); // the embedder WAS invoked (and threw)
    expect(embeddingOf(id)).toBeNull(); // row left NULL for the next pass
    // the failing pass cleared the in-flight guard: a clean retry now embeds it.
    H.control.throwNext = false;
    await runPostMergeEmbedPass(db);
    expect(embeddingOf(id)).not.toBeNull();
  });

  it('text-changed re-embed: an LWW content change NULLs the stale embedding, pass re-embeds via normalized fingerprint', async () => {
    const id = seedEmbeddedRow('original body', '2024-01-01 00:00:00');
    const before = embeddingOf(id)!;
    expect(before).not.toBeNull();
    expect(vecCount(id)).toBe(1);

    // LWW UPDATE: same syncKey (project/category/title), NEWER created_at, changed content.
    const { results } = processSyncPush(db, {
      learnings: [wireRow({ content: 'a rewritten body', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' })],
    });
    expect(results['learnings'].updated).toBe(1);

    // In-merge invalidation: embedding NULLed + vec row deleted, lockstep, pre-pass.
    expect(embeddingOf(id)).toBeNull();
    expect(vecCount(id)).toBe(0);

    scheduleLearningEmbedAfterMerge(db, results);
    await waitFor(() => nullCount() === 0);

    const after = embeddingOf(id)!;
    expect(after).not.toBeNull();
    expect(vecCount(id)).toBe(1);
    // re-embedded from the NEW content via the normalized fingerprint …
    expect(after.equals(embeddingToBuffer(H.fakeVector(normalizedFingerprint(T.title, 'a rewritten body'))))).toBe(true);
    // … and differs from the stale embedding of the old content.
    expect(after.equals(before)).toBe(false);
  });

  it('clean all-embedded merge = no pass scheduled', async () => {
    // Seed an already-embedded row with a NEWER timestamp than the incoming row →
    // the merge SKIPS (older remote), so inserted+updated === 0.
    seedEmbeddedRow('stable body', '2027-01-01 00:00:00');
    const { results } = processSyncPush(db, {
      learnings: [wireRow({ content: 'older losing body', created_at: '2020-01-01 00:00:00' })],
    });
    expect(results['learnings'].inserted + results['learnings'].updated).toBe(0);

    scheduleLearningEmbedAfterMerge(db, results);
    await tick(); await tick();
    // no embedder run — the guard short-circuited on the clean merge.
    expect(H.control.embedCount).toBe(0);

    // learnings absent entirely is also a no-op.
    expect(() => scheduleLearningEmbedAfterMerge(db, {})).not.toThrow();
    await tick();
    expect(H.control.embedCount).toBe(0);
  });

  it('coalescing: two schedule calls while a pass is in flight → one follow-up pass, no double-write', async () => {
    // Two NULL rows to embed.
    processSyncPush(db, { learnings: [wireRow({ content: 'row one body' })] });
    processSyncPush(db, { learnings: [wireRow({ title: 'B Title', content: 'row two body' })] });
    expect(nullCount()).toBe(2);

    // Gate the embedder so the first pass stays in flight while we fire a 2nd schedule.
    let release!: () => void;
    H.control.gate = new Promise<void>((r) => { release = r; });

    scheduleLearningEmbedAfterMerge(db, { learnings: { inserted: 1, updated: 0, skipped: 0, failed: 0 } });
    await tick(); // let the setImmediate pass start and reach the gated embed
    expect(H.control.embedCount).toBeGreaterThan(0); // pass is in flight, awaiting the gate

    // Second schedule call arrives while in flight → coalesced into one rerun.
    scheduleLearningEmbedAfterMerge(db, { learnings: { inserted: 1, updated: 0, skipped: 0, failed: 0 } });

    release(); // let the gated pass drain
    await waitFor(() => nullCount() === 0);

    // Final state fully embedded; the follow-up pass found nothing to re-embed
    // (idempotent NULL-scan) so embedCount is exactly the two rows — no double-write.
    expect(nullCount()).toBe(0);
    expect(H.control.embedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TD-253 — Egress path redaction
// ---------------------------------------------------------------------------

describe('TD-253 — relativizeEgressPath', () => {
  const home = os.homedir();

  it('maps the home directory itself to ~', () => {
    expect(relativizeEgressPath(home)).toBe('~');
  });

  it('relativizes a path under home to ~ + suffix', () => {
    expect(relativizeEgressPath(`${home}/code/app`)).toBe('~/code/app');
  });

  it('reduces a foreign-absolute path to its basename', () => {
    expect(relativizeEgressPath('/opt/work/some-app')).toBe('some-app');
  });

  it('leaves an already-relative value unchanged', () => {
    expect(relativizeEgressPath('code/app')).toBe('code/app');
  });

  it('is idempotent (re-applying is a no-op)', () => {
    const once = relativizeEgressPath(`${home}/code/app`);
    expect(relativizeEgressPath(once)).toBe(once);
    const foreignOnce = relativizeEgressPath('/opt/work/some-app');
    expect(relativizeEgressPath(foreignOnce)).toBe(foreignOnce);
  });

  it('passes non-string / empty values through untouched', () => {
    expect(relativizeEgressPath(null)).toBeNull();
    expect(relativizeEgressPath(42)).toBe(42);
    expect(relativizeEgressPath('')).toBe('');
  });
});

describe('TD-253 — redactTablesForEgress', () => {
  const home = os.homedir();

  it('relativizes only the redactCols of configured tables, in place', () => {
    const projectsRow = { slug: 'app', path: `${home}/code/app`, name: 'App' };
    const instanceRow = { id: 'i1', project_path: '/opt/work/app' };
    const learningRow = { project: 'app', title: 't', content: `${home}/keep/me` };
    const tables = {
      projects: [projectsRow],
      instances: [instanceRow],
      learnings: [learningRow],
    };

    const returned = redactTablesForEgress(tables);

    // Same reference returned (in-place mutation — the load-bearing contract).
    expect(returned).toBe(tables);
    expect(projectsRow.path).toBe('~/code/app');
    expect(instanceRow.project_path).toBe('app');
    // A non-redact table's path-shaped value is untouched.
    expect(learningRow.content).toBe(`${home}/keep/me`);
  });

  it('is idempotent across a double application', () => {
    const tables = { projects: [{ slug: 'a', path: `${home}/x/y` }] };
    redactTablesForEgress(tables);
    redactTablesForEgress(tables);
    expect(tables.projects[0].path).toBe('~/x/y');
  });
});

describe('TD-253 — handleBrainPush redacts before egress AND before the retry queue', () => {
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

  function seedProject(): void {
    db.prepare(
      `INSERT INTO projects (slug, name, path, last_session_at)
       VALUES (?, ?, ?, ?)`,
    ).run('app', 'App', `${os.homedir()}/code/app`, '2026-04-29 10:00:00');
  }

  it('the pushed payload carries the relativized project path (not the absolute local path)', async () => {
    seedProject();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, results: { projects: { inserted: 1 } } }),
      text: async () => '',
      status: 200,
    })) as unknown as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    await handleBrainPush({ remote_url: 'http://test-remote.local', api_key: 'k' });

    const call = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string) as {
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    expect(body.tables.projects[0].path).toBe('~/code/app');
    expect(JSON.stringify(body)).not.toContain(os.homedir());
  });

  it('the failure-path retry queue row is ALSO redacted (ordering guarantee)', async () => {
    seedProject();
    // 4xx → fetchWithRetry throws immediately (no backoff) → queueFailedRows.
    const fetchMock = vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
      text: async () => 'bad request',
      status: 400,
    })) as unknown as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    const result = await handleBrainPush({
      remote_url: 'http://test-remote.local',
      api_key: 'k',
    });
    expect((result as { isError?: boolean }).isError).toBe(true);

    const queued = db
      .prepare(`SELECT table_name, row_data FROM sync_queue WHERE table_name = 'projects'`)
      .all() as { table_name: string; row_data: string }[];
    expect(queued.length).toBeGreaterThan(0);
    const row = JSON.parse(queued[0].row_data) as { path: string };
    // The queued row must NOT carry the absolute local path — redaction ran
    // BEFORE queueFailedRows, so retries never leak.
    expect(row.path).toBe('~/code/app');
    expect(row.path).not.toContain(os.homedir());
  });
});

// ---------------------------------------------------------------------------
// FR-267 §4.4 — the push carries the hunt-cost record, and a v3 remote merges it
// ---------------------------------------------------------------------------
// The stub `agent_events` table `makeMinimalSyncDb` builds from SYNC_TABLES is
// all-TEXT, which would turn `round: 2` into `'2'` on the wire; these tests
// replace it with the REAL shape from the instances component's own v1 + v3
// migrations (v2 is skipped: it ALTERs `instances`, which the stub already
// carries at its SYNC_TABLES column set). Nothing here is hand-copied DDL.

/** Real `agent_events` (v9 shape) on a DB that already has an `instances` stub. */
function installAgentEventsV1(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS agent_events');
  const migrations = createInstancesComponent().schema();
  db.exec(migrations.find((m) => m.version === 1)!.sql);
}

/** Apply the FR-267 v3 migration on top of v1. */
function installAgentEventsV3(db: Database.Database): void {
  installAgentEventsV1(db);
  const migrations = createInstancesComponent().schema();
  db.exec(migrations.find((m) => m.version === 3)!.sql);
}

/** One post-v3 stop row, as the local brain writes it. */
const FR267_ROW = {
  instance_id: 'inst-1',
  agent: 'forger',
  event_type: 'stop',
  phase: 'BUILDING',
  brief_id: 'FR-267',
  duration_ms: 1834000,
  input_tokens: null,
  output_tokens: null,
  cache_read: null,
  cache_create: null,
  result: 'success',
  error_message: null,
  metadata: '{}',
  created_at: '2026-08-26 17:00:00',
  model_requested: 'claude-fable-5',
  model_resolved: null,
  round: 2,
  project: 'igris-ai',
};

describe('FR-267 — agent_events sync carries model_requested / round / project', () => {
  let db: Database.Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = makeMinimalSyncDb();
    installAgentEventsV3(db);
    mockedGetDb.mockReturnValue(db);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
    vi.restoreAllMocks();
  });

  it('SYNC_TABLES.agent_events names the four v3 columns and keeps its syncKey', () => {
    const config = SYNC_TABLES.find((t) => t.table === 'agent_events');
    expect(config).toBeDefined();
    expect(config!.columns).toEqual(
      expect.arrayContaining(['model_requested', 'model_resolved', 'round', 'project']),
    );
    expect(config!.syncKey).toEqual(['instance_id', 'agent', 'event_type', 'created_at']);
    expect(config!.strategy).toBe('append');
  });

  it('handleBrainPush payload tables.agent_events[0] has model_requested, round and project', async () => {
    const cols = Object.keys(FR267_ROW);
    db.prepare(
      `INSERT INTO agent_events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ).run(...cols.map((c) => (FR267_ROW as Record<string, unknown>)[c]));

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, results: { agent_events: { inserted: 1 } } }),
      text: async () => '',
      status: 200,
    })) as unknown as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    const result = await handleBrainPush({
      remote_url: 'http://test-remote.local',
      api_key: 'test-key',
    });
    expect((result as { isError?: boolean }).isError).toBeFalsy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      tables: Record<string, Array<Record<string, unknown>>>;
    };

    expect(body.tables).toHaveProperty('agent_events');
    expect(body.tables.agent_events).toHaveLength(1);
    const pushed = body.tables.agent_events[0];
    expect(pushed).toHaveProperty('model_requested', 'claude-fable-5');
    expect(pushed).toHaveProperty('round', 2);
    expect(pushed).toHaveProperty('project', 'igris-ai');
    expect(pushed).toHaveProperty('duration_ms', 1834000);
    // NULL tokens travel as explicit nulls, so the remote never falls back to a DEFAULT 0.
    expect(pushed).toHaveProperty('input_tokens', null);
  });

  it('mergeRows on a v3 remote inserts the row with its new columns; a pre-v3 remote fails it per-row', () => {
    const config = SYNC_TABLES.find((t) => t.table === 'agent_events')!;

    const remoteV3 = new Database(':memory:');
    remoteV3.exec('CREATE TABLE instances (id TEXT PRIMARY KEY, project_slug TEXT)');
    installAgentEventsV3(remoteV3);
    const merged = mergeRows(remoteV3, config, [{ ...FR267_ROW }]);
    expect(merged.inserted).toBe(1);
    expect(merged.failed).toBe(0);
    const stored = remoteV3.prepare('SELECT * FROM agent_events').get() as Record<string, unknown>;
    expect(stored).toMatchObject({
      model_requested: 'claude-fable-5',
      model_resolved: null,
      round: 2,
      project: 'igris-ai',
      duration_ms: 1834000,
      input_tokens: null,
    });
    remoteV3.close();

    // The deploy-first reason (plan §6.1): an un-migrated remote rejects the
    // row per-row (BR-066). SQLite's INSERT wording is "has no column named",
    // not the "no such column" a SELECT would say.
    const remoteV1 = new Database(':memory:');
    installAgentEventsV1(remoteV1);
    const rejected = mergeRows(remoteV1, config, [{ ...FR267_ROW }]);
    expect(rejected.inserted).toBe(0);
    expect(rejected.failed).toBe(1);
    expect(rejected.failures[0].error).toMatch(/table agent_events has no column named model_requested/);
    remoteV1.close();
  });
});

// ---------------------------------------------------------------------------
// BR-097 — a push advances a table's watermark only on remote acknowledgement
// ---------------------------------------------------------------------------
// FR-268 shipped `ceremony_events` and the perception extractor pushed before
// the VPS had the table: the remote `continue`d over it (no `results`, no
// `errors`, HTTP 200) and `handleBrainPush` stamped `sync_state.last_push_at`
// for every table it SENT — the rows were never re-selected (L-1366's class).
// T1–T3 and T6 drive the REAL `processSyncPush` over a second in-memory DB
// built by the same `makeMinimalSyncDb()` (the live `SYNC_TABLES` shape on
// both sides — L-849), through the fetch boundary; T4/T5 hand-shape the body
// because they are about the CLIENT's reading of an old remote / of `errors`.

/** The fixture remote: the full SYNC_TABLES shape, optionally missing one real table. */
function makeFixtureRemote(dropTable?: string): Database.Database {
  const remote = makeMinimalSyncDb();
  if (dropTable) remote.exec(`DROP TABLE ${dropTable}`);
  return remote;
}

/** A fetch whose `json()` is the real `/sync/push` body computed over `remote`. */
function fetchViaRemote(
  remote: Database.Database,
  captured: SyncPushResult[],
): typeof globalThis.fetch {
  return vi.fn(async (_url: unknown, init: RequestInit) => {
    const payload = JSON.parse(init.body as string) as {
      tables: Record<string, Record<string, unknown>[]>;
    };
    const r = processSyncPush(remote, payload.tables);
    captured.push(r);
    // The route: `status = ok ? 200 : 207`; both are 2xx so fetchWithRetry resolves.
    return { ok: true, status: r.ok ? 200 : 207, json: async () => r, text: async () => '' };
  }) as unknown as typeof globalThis.fetch;
}

/** A hand-shaped response body (old remote / explicit 207), one per call. */
function fetchWithBody(body: Record<string, unknown>, status = 200): typeof globalThis.fetch {
  return vi.fn(async () => ({
    ok: true,
    status,
    json: async () => body,
    text: async () => '',
  })) as unknown as typeof globalThis.fetch;
}

const CEREMONY_ROW = {
  project: 'igris-ai',
  ceremony: 'boot',
  event_type: 'start',
  machine_hostname: 'host-a',
  instance_id: 'inst-1',
  brief_id: null,
  duration_ms: null,
  metadata: '{}',
  created_at: '2026-08-27 07:00:00',
};

describe("BR-097 — a push advances a table's watermark only on remote acknowledgement", () => {
  const REMOTE = 'http://test-remote.local';
  let db: Database.Database;
  let originalFetch: typeof globalThis.fetch;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = makeMinimalSyncDb();
    mockedGetDb.mockReturnValue(db);
    originalFetch = globalThis.fetch;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    errSpy.mockRestore();
    db.close();
    vi.restoreAllMocks();
  });

  function seedLearning(title = 'br097 learning'): void {
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, review_status,
         provenance, source_extractor, created_at)
       VALUES (?, ?, ?, ?, 'approved', 'observed', 'manual', ?)`,
    ).run('p', 'pattern', title, 'body', '2026-08-27 07:00:00');
  }

  function seedCeremonyEvent(): void {
    const cols = Object.keys(CEREMONY_ROW);
    db.prepare(
      `INSERT INTO ceremony_events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ).run(...cols.map((c) => (CEREMONY_ROW as Record<string, unknown>)[c]));
  }

  function seedGoal(): void {
    db.prepare(
      `INSERT INTO goals (goal_id, project_slug, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('g-br097', 'p', 'goal', 'pending', '2026-08-27 07:00:00', '2026-08-27 07:00:00');
  }

  /** `sync_state.last_push_at` per table for the test remote (absent key = never stamped). */
  function stamps(): Record<string, string> {
    const rows = db
      .prepare('SELECT table_name, last_push_at FROM sync_state WHERE remote_url = ?')
      .all(REMOTE) as { table_name: string; last_push_at: string }[];
    return Object.fromEntries(rows.map((r) => [r.table_name, r.last_push_at]));
  }

  function stderrLines(): string {
    return errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  }

  async function push(): Promise<{ text: string; isError?: boolean }> {
    const result = await handleBrainPush({ remote_url: REMOTE, api_key: 'k' });
    return {
      text: (result.content?.[0]?.text as string) ?? '',
      isError: (result as { isError?: boolean }).isError,
    };
  }

  // T1 — the AC-1 red: the remote lacks `ceremony_events`; its watermark must NOT move.
  it('T1: a table the fixture remote lacks is NOT stamped (its sync_state row stays absent)', async () => {
    seedLearning();
    seedCeremonyEvent();
    const remote = makeFixtureRemote('ceremony_events');
    const captured: SyncPushResult[] = [];
    globalThis.fetch = fetchViaRemote(remote, captured);

    const { isError } = await push();
    expect(isError).toBeFalsy();

    // The sibling table merged and was acknowledged.
    expect((remote.prepare('SELECT COUNT(*) AS c FROM learnings').get() as { c: number }).c).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0].results).toHaveProperty('learnings');
    expect(captured[0].results).not.toHaveProperty('ceremony_events');

    const st = stamps();
    expect(st.learnings).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // THE assertion: no acknowledgement → no watermark. On HEAD this stamped.
    expect(st).not.toHaveProperty('ceremony_events');
    remote.close();
  });

  // T2 — positive control for the stamp: a full remote acknowledges both.
  it('T2: a remote that has every table acknowledges both, skipped is [], headline unchanged', async () => {
    seedLearning();
    seedCeremonyEvent();
    const remote = makeFixtureRemote();
    const captured: SyncPushResult[] = [];
    globalThis.fetch = fetchViaRemote(remote, captured);

    const { text, isError } = await push();
    expect(isError).toBeFalsy();
    expect(captured[0].skipped).toEqual([]);
    expect(captured[0].ok).toBe(true);
    expect(text.split('\n')[0]).toBe('Brain push completed successfully.');
    expect(text).toMatch(/- ceremony_events: 1 row\(s\)/);

    const st = stamps();
    expect(Object.keys(st).sort()).toEqual(['ceremony_events', 'learnings']);
    remote.close();
  });

  // T3 — recovery WITHOUT the DELETE: deploy the table, push again, the row arrives.
  it('T3: after the remote gains the table, the next push carries the held rows and stamps it', async () => {
    seedLearning();
    seedCeremonyEvent();
    const remote = makeFixtureRemote('ceremony_events');
    const captured: SyncPushResult[] = [];
    globalThis.fetch = fetchViaRemote(remote, captured);

    await push();
    expect(stamps()).not.toHaveProperty('ceremony_events');

    // "Deploy": the same stub shape makeMinimalSyncDb builds from SYNC_TABLES.
    const cfg = SYNC_TABLES.find((t) => t.table === 'ceremony_events')!;
    remote.exec(`CREATE TABLE ceremony_events (${cfg.columns.map((c) => `${c} TEXT`).join(', ')})`);

    const { text, isError } = await push();
    expect(isError).toBeFalsy();
    expect(text.split('\n')[0]).toBe('Brain push completed successfully.');

    // The second push re-selected ONLY the held table (learnings' watermark held it back).
    expect(captured).toHaveLength(2);
    expect(Object.keys(captured[1].results)).toEqual(['ceremony_events']);
    expect((remote.prepare('SELECT COUNT(*) AS c FROM ceremony_events').get() as { c: number }).c).toBe(1);
    expect((remote.prepare('SELECT COUNT(*) AS c FROM learnings').get() as { c: number }).c).toBe(1);
    expect(stamps()).toHaveProperty('ceremony_events');
    remote.close();
  });

  // T4 — compat: new client ↔ old remote (no `skipped` field at all).
  it('T4: an old remote body (no skipped field) stamps only the results names and reports UNACKNOWLEDGED', async () => {
    seedLearning();
    seedCeremonyEvent();
    globalThis.fetch = fetchWithBody({ ok: true, results: { learnings: { inserted: 1 } } });

    const { text, isError } = await push();
    expect(isError).toBeFalsy();

    const st = stamps();
    expect(st).toHaveProperty('learnings');
    expect(st).not.toHaveProperty('ceremony_events');
    expect(text.split('\n')[0]).toBe(
      'Brain push completed — 1 table(s) not merged by the remote (rows retained locally).',
    );
    expect(text).toMatch(/- ceremony_events: UNACKNOWLEDGED — remote returned no result \(pre-BR-097 remote\?\); rows retained locally/);
    expect(text).toMatch(/- learnings: 1 row\(s\)/);
    expect(stderrLines()).toMatch(/ceremony_events sent but not acknowledged by the remote/);
  });

  // T5 — an errored table on a 207 is NOT stamped (and never was queued: this path has no catch).
  it('T5: a 207 with errors.goals leaves goals unstamped, stamps learnings, isError stays falsy', async () => {
    seedLearning();
    seedGoal();
    globalThis.fetch = fetchWithBody(
      { ok: false, results: { learnings: { inserted: 1 } }, errors: { goals: 'boom' }, skipped: [] },
      207,
    );

    const { text, isError } = await push();
    expect(isError).toBeFalsy();

    const st = stamps();
    expect(st).toHaveProperty('learnings');
    expect(st).not.toHaveProperty('goals');
    expect(text.split('\n')[0]).toMatch(/^Brain push completed — 1 table\(s\) not merged/);
    expect(text).toMatch(/- goals: ERROR — boom \(rows retained locally\)/);
    expect(stderrLines()).toMatch(/goals: remote error boom; rows retained locally/);
  });

  // T5b — the union rule's conjunction: acked in one chunk AND errored in another → NOT stamped.
  // (A real split needs > 5 MB; the body carries both keys to pin `acked && !failed`.)
  it('T5b: a table named in BOTH results and errors is not stamped', async () => {
    seedLearning();
    seedGoal();
    globalThis.fetch = fetchWithBody(
      {
        ok: false,
        results: { learnings: { inserted: 1 }, goals: { inserted: 1 } },
        errors: { goals: 'boom' },
        skipped: [],
      },
      207,
    );

    const { isError } = await push();
    expect(isError).toBeFalsy();
    const st = stamps();
    expect(st).toHaveProperty('learnings');
    expect(st).not.toHaveProperty('goals');
  });

  // T6 — visibility is a separate property from the stamp (M2 kills this, not T1).
  it('T6: the response names the skipped table and the text carries the SKIPPED line', async () => {
    seedLearning();
    seedCeremonyEvent();
    const remote = makeFixtureRemote('ceremony_events');
    const captured: SyncPushResult[] = [];
    globalThis.fetch = fetchViaRemote(remote, captured);

    const { text, isError } = await push();
    expect(isError).toBeFalsy();

    expect(captured[0].skipped).toEqual(['ceremony_events']);
    expect(captured[0].ok).toBe(false);
    expect(captured[0].errors).toEqual({});
    expect(text.split('\n')[0]).toBe(
      'Brain push completed — 1 table(s) not merged by the remote (rows retained locally).',
    );
    expect(text).toMatch(/- ceremony_events: SKIPPED — not on remote yet \(deploy first; rows retained locally\)/);
    expect(text).toMatch(/- learnings: 1 row\(s\)/);
    // One operator-visible line per unstamped table.
    const lines = stderrLines().split('\n').filter((l) => /ceremony_events not on remote yet/.test(l));
    expect(lines).toHaveLength(1);
    remote.close();
  });

  // T9 — L-1366 by construction: a table with nothing to send is never stamped.
  it('T9: a table the client did not send (0 rows) gets no sync_state row', async () => {
    seedLearning();
    const remote = makeFixtureRemote();
    const captured: SyncPushResult[] = [];
    globalThis.fetch = fetchViaRemote(remote, captured);

    await push();
    expect(Object.keys(captured[0].results)).toEqual(['learnings']);
    expect(captured[0].skipped).toEqual([]);
    expect(Object.keys(stamps())).toEqual(['learnings']);
    remote.close();
  });
});

// ---------------------------------------------------------------------------
// BR-100 — machine_id never crosses the wire, in either direction
// ---------------------------------------------------------------------------
// The three legs of coding_guidelines §7's "per-machine value stays OUT of
// SYNC_TABLES", read at the MECHANISM rather than at the intention:
//   1. push: `handleBrainPush` SELECTs `config.columns ∩ existing columns`, so a
//      local row carrying machine_id egresses WITHOUT the key;
//   2. merge/INSERT: an inbound row for a NEW id lands with machine_id NULL;
//   3. merge/LWW UPDATE: an inbound NEWER copy of MY OWN row (instances is in
//      BOOT_SYNC_PULL_TABLES, so this round trip happens at every boot) leaves
//      my local machine_id intact — the UPDATE iterates `config.columns` only.

describe('BR-100 — machine_id is not replicated (push payload, inbound INSERT, LWW round trip)', () => {
  let db: Database.Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = makeMinimalSyncDb();
    // The stub tables carry the SYNC_TABLES column set; the BR-100 column sits
    // beside it exactly as monitoring v2 / instances v5 leave it on a real brain.
    db.exec('ALTER TABLE event_log ADD COLUMN machine_id TEXT');
    db.exec('ALTER TABLE instances ADD COLUMN machine_id TEXT');
    mockedGetDb.mockReturnValue(db);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
    vi.restoreAllMocks();
  });

  it('leg 1 — a pushed event_log row carries machine_hostname but NO machine_id key', async () => {
    db.prepare(
      `INSERT INTO event_log (event_name, component, payload, machine_hostname, project_slug, instance_id, created_at, machine_id)
       VALUES ('cognition.synapse.run_succeeded', 'cognition.synapse', '{}', 'MacBookAir', 'p', NULL, '2026-09-06 10:00:00', 'my-machine-id')`,
    ).run();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, results: { event_log: { inserted: 1 } }, skipped: [] }),
      text: async () => '',
      status: 200,
    })) as unknown as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    const result = await handleBrainPush({ remote_url: 'http://test-remote.local', api_key: 'k' });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const init = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as { tables: Record<string, Array<Record<string, unknown>>> };
    expect(body.tables.event_log).toHaveLength(1);
    const pushed = body.tables.event_log[0];
    expect(pushed).toHaveProperty('machine_hostname', 'MacBookAir');
    expect(pushed).not.toHaveProperty('machine_id');
    // The whole payload, every table: the key appears nowhere.
    expect(JSON.stringify(body)).not.toContain('machine_id');
  });

  it('leg 2 — an inbound instances row for a NEW id lands with machine_id NULL', () => {
    const config = SYNC_TABLES.find((t) => t.table === 'instances')!;
    const merged = mergeRows(db, config, [{
      id: 'i-remote', machine_hostname: 'vps-host', machine_os: 'linux', project_slug: 'p',
      project_path: null, current_brief: null, current_phase: null, current_task: null, status: 'active',
      started_at: '2026-09-06 09:00:00', last_activity_at: '2026-09-06 09:00:00', metadata: '{}',
      harness: null, harness_session_id: null, owner_pid: null, owner_started_at: null,
      liveness_method: null, liveness_status: null, liveness_checked_at: null, lease_expires_at: null,
      state_updated_at: null,
      // A remote that DID stamp its own id sends it anyway? No — it is not in its
      // columns either; but even a hand-crafted payload carrying one is dropped:
      machine_id: 'remote-machine-id',
    }]);
    expect(merged.inserted).toBe(1);
    expect(merged.failed).toBe(0);
    const row = db.prepare("SELECT machine_hostname, machine_id FROM instances WHERE id = 'i-remote'").get() as Record<string, unknown>;
    expect(row).toEqual({ machine_hostname: 'vps-host', machine_id: null });
  });

  it('leg 3 — a NEWER inbound copy of MY OWN row updates the LWW columns and leaves my machine_id intact', () => {
    const config = SYNC_TABLES.find((t) => t.table === 'instances')!;
    db.prepare(
      `INSERT INTO instances (id, machine_hostname, project_slug, status, last_activity_at, current_phase, machine_id)
       VALUES ('i-mine', 'Mohameds-MacBook-Air-2', 'p', 'active', '2026-09-06 09:00:00', 'BUILDING', 'my-machine-id')`,
    ).run();
    const merged = mergeRows(db, config, [{
      id: 'i-mine', machine_hostname: 'Mohameds-MacBook-Air-2', machine_os: null, project_slug: 'p',
      project_path: null, current_brief: 'BR-100', current_phase: 'TESTING', current_task: null, status: 'active',
      started_at: null, last_activity_at: '2026-09-06 10:00:00', metadata: '{}',
      harness: null, harness_session_id: null, owner_pid: null, owner_started_at: null,
      liveness_method: null, liveness_status: null, liveness_checked_at: null, lease_expires_at: null,
      state_updated_at: null,
    }]);
    expect(merged.updated).toBe(1);
    const row = db.prepare("SELECT current_phase, last_activity_at, machine_id FROM instances WHERE id = 'i-mine'").get() as Record<string, unknown>;
    expect(row).toEqual({ current_phase: 'TESTING', last_activity_at: '2026-09-06 10:00:00', machine_id: 'my-machine-id' });
  });
});
