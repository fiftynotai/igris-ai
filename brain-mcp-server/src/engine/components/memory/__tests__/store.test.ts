/**
 * FR-210 — igris_memory_store schema + enriched memory.stored payload tests.
 *
 * Coverage:
 *   - the `edges` param is declared with a strict (additionalProperties:false)
 *     item schema and required [to_type,to_id,edge_type]
 *   - a successful store emits the enriched memory.stored payload
 *     { project, id, category, source_brief, edges }
 *   - the internal `learningId` handoff is NOT leaked into the tool response
 *     (response content shape is unchanged — additive contract)
 *   - the gateway strict-input contract still rejects unknown top-level args
 *
 * @module engine/components/memory/__tests__/store.test
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
import { createGateway } from '../../../gateway.js';
import { createMemoryComponent } from '../index.js';
import type { ComponentContext, ToolInputSchema } from '../../../types.js';

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

function makeCtx(bus: ComponentContext['bus']): ComponentContext {
  return {
    storage: undefined as unknown as ComponentContext['storage'],
    bus,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: {},
  };
}

describe('igris_memory_store — FR-210 edges param + enriched payload', () => {
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

  // -------------------------------------------------------------------------
  // Schema surface
  // -------------------------------------------------------------------------

  it('declares an optional edges array with a strict item schema', () => {
    const component = createMemoryComponent();
    const store = component.tools().find((t) => t.name === 'igris_memory_store');
    expect(store).toBeDefined();

    const schema = store!.inputSchema as ToolInputSchema;
    // Top-level contract preserved.
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['project', 'category', 'title', 'content']);
    // edges must NOT be required (opt-in).
    expect(schema.required).not.toContain('edges');

    const edges = schema.properties.edges as {
      type: string;
      items: {
        type: string;
        additionalProperties: boolean;
        properties: Record<string, unknown>;
        required: string[];
      };
    };
    expect(edges.type).toBe('array');
    expect(edges.items.type).toBe('object');
    // Nested strict-input contract on each edge object.
    expect(edges.items.additionalProperties).toBe(false);
    expect(edges.items.required).toEqual(['to_type', 'to_id', 'edge_type']);
    expect(Object.keys(edges.items.properties).sort()).toEqual(
      ['confidence', 'edge_type', 'metadata', 'to_id', 'to_type'],
    );
  });

  // -------------------------------------------------------------------------
  // Enriched memory.stored emit
  // -------------------------------------------------------------------------

  it('emits the enriched memory.stored payload { project, id, category, source_brief, edges }', async () => {
    const emitted: { name: string; data: Record<string, unknown> }[] = [];
    const fakeBus = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn((name: string, data: Record<string, unknown>) => {
        emitted.push({ name, data });
      }),
    };

    const component = createMemoryComponent();
    component.init(makeCtx(fakeBus));

    const store = component.tools().find((t) => t.name === 'igris_memory_store');
    const edges = [{ to_type: 'learning', to_id: '950', edge_type: 'supersedes' }];
    await store!.handler({
      project: 'igris-ai',
      category: 'decision',
      title: 'FR-210 mechanism',
      content: 'Store-side edge population.',
      source_brief: 'FR-210',
      edges,
    });

    expect(fakeBus.emit).toHaveBeenCalledTimes(1);
    expect(emitted[0].name).toBe('memory.stored');
    expect(emitted[0].data).toEqual({
      project: 'igris-ai',
      id: 1,
      category: 'decision',
      source_brief: 'FR-210',
      edges,
    });
  });

  it('does not leak the internal learningId into the tool response content', async () => {
    const fakeBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
    const component = createMemoryComponent();
    component.init(makeCtx(fakeBus));

    const store = component.tools().find((t) => t.name === 'igris_memory_store');
    const result = (await store!.handler({
      project: 'igris-ai',
      category: 'pattern',
      title: 'Shape check',
      content: 'Response content unchanged.',
    })) as Record<string, unknown>;

    // The MCP response exposes only `content` — learningId is an internal handoff.
    expect(Object.keys(result)).toEqual(['content']);
    expect((result.content as { text: string }[])[0].text).toContain('Learning stored successfully');
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128) — gateway-level
  // -------------------------------------------------------------------------

  it('rejects unknown top-level args via the gateway strict-input contract', async () => {
    const gateway = createGateway();
    const component = createMemoryComponent();
    gateway.register(component.tools());

    await expect(
      gateway.dispatch('igris_memory_store', {
        project: 'igris-ai',
        category: 'pattern',
        title: 't',
        content: 'c',
        bogus_extra: 'should-throw',
      }),
    ).rejects.toThrowError(/igris_memory_store: unknown argument 'bogus_extra'/);
  });
});
