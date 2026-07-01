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
  scheduleLearningEmbedAfterMerge,
  runPostMergeEmbedPass,
  SYNC_TABLES,
} from '../sync.js';
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
