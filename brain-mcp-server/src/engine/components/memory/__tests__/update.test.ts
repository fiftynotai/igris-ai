/**
 * TD-171 M1 — igris_memory_update handler tests.
 *
 * Coverage:
 *   - happy path (single field, multi-field)
 *   - bumps updated_at on every successful UPDATE
 *   - returns the list of fields actually changed
 *   - rejects unknown args via the gateway strict-input contract (TD-128)
 *   - rejects missing/invalid id with a clear validation message
 *   - rejects no-fields-provided (caller passed only `id`)
 *   - rejects invalid enum values (category, scope) and out-of-range confidence
 *
 * @module engine/components/memory/__tests__/update.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// Mock db module so handleMemoryUpdate resolves getDb() to our in-memory DB.
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

vi.mock('../../../../utils/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(384)),
  embeddingToBuffer: vi.fn((e: Float32Array) => Buffer.from(e.buffer, e.byteOffset, e.byteLength)),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DIMENSIONS: 384,
  processInBatches: vi.fn(),
}));

vi.mock('../../../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbedding: vi.fn(),
  vectorSearch: vi.fn(() => []),
}));

import { getDb } from '../../../../db.js';
import { handleMemoryUpdate } from '../../../../tools/memory.js';
import { createGateway } from '../../../gateway.js';
import { createMemoryComponent } from '../index.js';

const mockedGetDb = vi.mocked(getDb);

function makeTestDb(): Database.Database {
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
      provenance TEXT NOT NULL DEFAULT 'observed',
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual'
    );
  `);
  return db;
}

function seed(
  db: Database.Database,
  overrides: Partial<{
    project: string;
    category: string;
    title: string;
    content: string;
    tags: string;
    scope: string;
    confidence: number;
  }> = {},
): number {
  const data = {
    project: 'test-project',
    category: 'pattern',
    title: 'Original title',
    content: 'Original content',
    tags: 'a,b',
    scope: 'local',
    confidence: 0.8,
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO learnings (project, category, title, content, tags, scope, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(data.project, data.category, data.title, data.content, data.tags, data.scope, data.confidence);
  return result.lastInsertRowid as number;
}

function parseJsonResult(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('handleMemoryUpdate (TD-171 M1)', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('updates a single field and bumps updated_at', () => {
    const id = seed(db);
    const before = db.prepare('SELECT updated_at FROM learnings WHERE id = ?').get(id) as { updated_at: string };

    const result = handleMemoryUpdate({ id, title: 'Sharper title' });
    const payload = parseJsonResult(result);

    expect(payload.id).toBe(id);
    expect(payload.updated_fields).toEqual(['title']);
    expect(typeof payload.updated_at).toBe('string');

    const after = db.prepare('SELECT title, updated_at FROM learnings WHERE id = ?').get(id) as {
      title: string;
      updated_at: string;
    };
    expect(after.title).toBe('Sharper title');
    expect(after.updated_at).toBe(payload.updated_at);
    // The new updated_at should differ from the seeded default (different
    // format: ISO with `T` vs SQLite `datetime('now')` with space).
    expect(after.updated_at).not.toBe(before.updated_at);
  });

  it('updates multiple fields in one call and reports them all', () => {
    const id = seed(db);
    const result = handleMemoryUpdate({
      id,
      title: 'New title',
      content: 'New content',
      tags: 'x,y,z',
      category: 'discovery',
      scope: 'global',
      confidence: 0.95,
    });
    const payload = parseJsonResult(result);

    expect((payload.updated_fields as string[]).sort()).toEqual(
      ['category', 'confidence', 'content', 'scope', 'tags', 'title'].sort(),
    );

    const row = db.prepare('SELECT * FROM learnings WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.title).toBe('New title');
    expect(row.content).toBe('New content');
    expect(row.tags).toBe('x,y,z');
    expect(row.category).toBe('discovery');
    expect(row.scope).toBe('global');
    expect(row.confidence).toBe(0.95);
  });

  it('returns "not found" when the id does not exist', () => {
    const result = handleMemoryUpdate({ id: 999_999, title: 'x' });
    expect(result.content[0].text).toContain('not found');
  });

  it('rejects when no updatable fields are provided (only id)', () => {
    const id = seed(db);
    const result = handleMemoryUpdate({ id });
    expect(result.content[0].text).toContain('no updatable fields');
  });

  it('rejects an invalid category enum value', () => {
    const id = seed(db);
    const result = handleMemoryUpdate({ id, category: 'invalid' as 'pattern' });
    expect(result.content[0].text).toContain('category must be one of');
  });

  it('rejects an out-of-range confidence value', () => {
    const id = seed(db);
    const result = handleMemoryUpdate({ id, confidence: 1.5 });
    expect(result.content[0].text).toContain('confidence must be');
  });

  it('rejects a non-positive id', () => {
    const result = handleMemoryUpdate({ id: 0, title: 'x' });
    expect(result.content[0].text).toContain('id must be a positive integer');
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128) — gateway-level
  // -------------------------------------------------------------------------

  it('rejects unknown args via the gateway strict-input contract (TD-128)', async () => {
    const gateway = createGateway();
    const component = createMemoryComponent();
    gateway.register(component.tools());

    const id = seed(db);
    await expect(
      gateway.dispatch('igris_memory_update', { id, bogus_extra: 'should-throw' }),
    ).rejects.toThrowError(
      /igris_memory_update: unknown argument 'bogus_extra'\. Accepted keys: .*\. \(strict-input contract; TD-128\)/,
    );
  });

  it('dispatches cleanly via the gateway when only allowed args are passed', async () => {
    const gateway = createGateway();
    const component = createMemoryComponent();
    gateway.register(component.tools());

    const id = seed(db);
    const result = await gateway.dispatch('igris_memory_update', { id, tags: 'fresh' });
    const payload = parseJsonResult(result as { content: { text: string }[] });
    expect(payload.updated_fields).toEqual(['tags']);
  });
});
