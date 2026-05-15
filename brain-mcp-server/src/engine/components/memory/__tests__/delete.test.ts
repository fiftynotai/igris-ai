/**
 * TD-171 M1 — igris_memory_delete handler tests.
 *
 * Coverage:
 *   - happy path (row gone after call, JSON payload shape)
 *   - emits memory.deleted bus event with id + reason
 *   - returns "not found" without emitting on missing id
 *   - rejects unknown args via gateway strict-input contract (TD-128)
 *   - rejects non-positive id
 *
 * @module engine/components/memory/__tests__/delete.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

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
import { handleMemoryDelete } from '../../../../tools/memory.js';
import { createGateway } from '../../../gateway.js';
import { createMemoryComponent } from '../index.js';
import type { ComponentContext } from '../../../types.js';

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

function seed(db: Database.Database, title = 'Doomed learning'): number {
  const result = db
    .prepare(
      `INSERT INTO learnings (project, category, title, content)
       VALUES ('test-project', 'pattern', ?, 'content')`,
    )
    .run(title);
  return result.lastInsertRowid as number;
}

function parseJsonResult(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('handleMemoryDelete (TD-171 M1)', () => {
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

  it('hard-deletes the row and returns the canonical JSON payload', () => {
    const id = seed(db, 'Bye now');
    expect(db.prepare('SELECT COUNT(*) AS n FROM learnings WHERE id = ?').get(id)).toEqual({ n: 1 });

    const result = handleMemoryDelete({ id, reason: 'duplicates ID 5' });
    const payload = parseJsonResult(result);

    expect(payload).toEqual({
      deleted: true,
      id,
      title: 'Bye now',
      reason: 'duplicates ID 5',
    });

    // Row is gone.
    expect(db.prepare('SELECT COUNT(*) AS n FROM learnings WHERE id = ?').get(id)).toEqual({ n: 0 });
  });

  it('returns "not found" when the id does not exist (and does not throw)', () => {
    const result = handleMemoryDelete({ id: 999_999 });
    expect(result.content[0].text).toContain('not found');
  });

  it('rejects a non-positive id', () => {
    const result = handleMemoryDelete({ id: -1 });
    expect(result.content[0].text).toContain('id must be a positive integer');
  });

  it('omits the reason field cleanly when not provided', () => {
    const id = seed(db);
    const result = handleMemoryDelete({ id });
    const payload = parseJsonResult(result);
    expect(payload.reason).toBe('');
  });

  // -------------------------------------------------------------------------
  // Bus-event integration via the registered tool wrapper
  // -------------------------------------------------------------------------

  it('emits memory.deleted via the bus on successful delete', async () => {
    const emitted: { name: string; data: Record<string, unknown> }[] = [];
    const fakeBus = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn((name: string, data: Record<string, unknown>) => {
        emitted.push({ name, data });
      }),
    };

    const component = createMemoryComponent();
    component.init({
      storage: undefined as unknown as ComponentContext['storage'],
      bus: fakeBus,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: {},
    });

    const tool = component.tools().find((t) => t.name === 'igris_memory_delete');
    expect(tool).toBeDefined();

    const id = seed(db, 'Audit me');
    await tool!.handler({ id, reason: 'test' });

    expect(fakeBus.emit).toHaveBeenCalledTimes(1);
    expect(emitted[0]).toEqual({
      name: 'memory.deleted',
      data: { id, reason: 'test' },
    });
  });

  it('does NOT emit memory.deleted when the row is not found', async () => {
    const fakeBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
    const component = createMemoryComponent();
    component.init({
      storage: undefined as unknown as ComponentContext['storage'],
      bus: fakeBus,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: {},
    });

    const tool = component.tools().find((t) => t.name === 'igris_memory_delete');
    await tool!.handler({ id: 999_999 });

    expect(fakeBus.emit).not.toHaveBeenCalled();
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
      gateway.dispatch('igris_memory_delete', { id, bogus_extra: 'should-throw' }),
    ).rejects.toThrowError(
      /igris_memory_delete: unknown argument 'bogus_extra'\. Accepted keys: .*\. \(strict-input contract; TD-128\)/,
    );
  });

  it('declares memory.deleted in the component events.emits list', () => {
    const component = createMemoryComponent();
    const emits = component.events().emits.map((e) => e.name);
    expect(emits).toContain('memory.deleted');
    // Ensure memory.stored is still declared (regression check on TD-171
    // not nuking the existing emit list).
    expect(emits).toContain('memory.stored');
  });
});
