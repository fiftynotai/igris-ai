/**
 * TD-171 M3 — igris_perception_get handler tests.
 *
 * Coverage:
 *   - happy path: returns the full row of a pending_review learning
 *   - errors when learning_id missing
 *   - errors on non-positive integer learning_id
 *   - errors when learning not found
 *   - errors when learning exists but review_status != 'pending_review'
 *     (perception channel scope ends at promotion)
 *   - rejects unknown args via the gateway strict-input contract (TD-128)
 *
 * @module engine/components/perception/__tests__/get.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

import { getDb } from '../../../../db.js';
import { handlePerceptionGet, setHandlerContext } from '../handlers.js';
import { DEFAULT_PERCEPTION_CONFIG } from '../types.js';
import { createGateway } from '../../../gateway.js';
import { createPerceptionComponent } from '../index.js';

const mockedGetDb = vi.mocked(getDb);

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
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

function seedPending(
  db: Database.Database,
  overrides: Partial<{
    project: string;
    category: string;
    title: string;
    content: string;
    review_status: string;
    confidence: number;
    source_extractor: string;
  }> = {},
): number {
  const data = {
    project: 'p',
    category: 'pattern',
    title: 'Pending candidate',
    content: 'detail body',
    review_status: 'pending_review',
    confidence: 0.7,
    source_extractor: 'llm_via_claude_code',
    ...overrides,
  };
  const r = db
    .prepare(
      `INSERT INTO learnings (project, category, title, content, review_status, confidence, source_extractor)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      data.project,
      data.category,
      data.title,
      data.content,
      data.review_status,
      data.confidence,
      data.source_extractor,
    );
  return r.lastInsertRowid as number;
}

const noopBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };

beforeEach(() => {
  setHandlerContext({
    bus: noopBus,
    config: DEFAULT_PERCEPTION_CONFIG,
    llmExtractor: async () => [],
  });
});

describe('handlePerceptionGet (TD-171 M3)', () => {
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

  it('returns the full row for a pending_review learning', () => {
    const id = seedPending(db, { title: 'Hello world', confidence: 0.42 });
    const result = handlePerceptionGet({ learning_id: id });
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(payload.id).toBe(id);
    expect(payload.title).toBe('Hello world');
    expect(payload.confidence).toBe(0.42);
    expect(payload.review_status).toBe('pending_review');
    expect(payload.source_extractor).toBe('llm_via_claude_code');
    expect(payload.content).toBe('detail body');
  });

  it('errors when learning_id is missing', () => {
    const result = handlePerceptionGet({});
    expect(result.content[0].text).toContain('learning_id is required');
    expect(result.isError).toBe(true);
  });

  it('errors on non-positive integer learning_id', () => {
    const result = handlePerceptionGet({ learning_id: 0 });
    expect(result.content[0].text).toContain('learning_id must be a positive integer');
    expect(result.isError).toBe(true);
  });

  it('errors when learning not found', () => {
    const result = handlePerceptionGet({ learning_id: 9999 });
    expect(result.content[0].text).toContain('not found');
    expect(result.isError).toBe(true);
  });

  it('errors when learning exists but review_status is not pending_review', () => {
    const id = seedPending(db, { review_status: 'approved' });
    const result = handlePerceptionGet({ learning_id: id });
    expect(result.content[0].text).toContain('not in pending_review state');
    expect(result.isError).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128) — gateway-level
  // -------------------------------------------------------------------------

  it('rejects unknown args via the gateway strict-input contract (TD-128)', async () => {
    const gateway = createGateway();
    const component = createPerceptionComponent();
    gateway.register(component.tools());

    await expect(
      gateway.dispatch('igris_perception_get', { learning_id: 1, bogus: 'x' }),
    ).rejects.toThrowError(/igris_perception_get: unknown argument 'bogus'/);
  });
});
