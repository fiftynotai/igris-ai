/**
 * TD-171 M3 — igris_error_dashboard handler tests.
 *
 * Coverage:
 *   - canonical _dashboard shape: totals + recent + samples blocks
 *   - totals.with_solution / without_solution computed correctly
 *   - summary_only=true omits the samples block
 *   - project filter narrows totals + recent + samples
 *   - days window narrows recent.new_errors
 *   - top_recurring ordered by occurrence_count DESC
 *   - empty DB returns zeroed shape without throwing
 *   - rejects negative days
 *   - rejects unknown args via gateway strict-input contract (TD-128)
 *
 * @module engine/components/errors/__tests__/dashboard.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
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
  insertEmbeddingInto: vi.fn(),
  vectorSearchFrom: vi.fn(() => []),
}));

import { getDb } from '../../../../db.js';
import { handleErrorDashboard } from '../../../../tools/errors.js';
import { createGateway } from '../../../gateway.js';
import { createErrorsComponent } from '../index.js';

const mockedGetDb = vi.mocked(getDb);

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      message TEXT NOT NULL,
      solution TEXT DEFAULT '',
      context TEXT DEFAULT '',
      occurrence_count INTEGER DEFAULT 1,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seedError(
  db: Database.Database,
  overrides: Partial<{
    project: string;
    fingerprint: string;
    message: string;
    solution: string;
    occurrence_count: number;
    first_seen_at: string | null;
  }> = {},
): number {
  const data = {
    project: 'p',
    fingerprint: 'fp',
    message: 'msg',
    solution: '',
    occurrence_count: 1,
    first_seen_at: null as string | null,
    ...overrides,
  };
  const sql = data.first_seen_at
    ? `INSERT INTO errors (project, fingerprint, message, solution, occurrence_count, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    : `INSERT INTO errors (project, fingerprint, message, solution, occurrence_count)
       VALUES (?, ?, ?, ?, ?)`;
  const params: unknown[] = [
    data.project,
    data.fingerprint,
    data.message,
    data.solution,
    data.occurrence_count,
  ];
  if (data.first_seen_at) params.push(data.first_seen_at);
  const r = db.prepare(sql).run(...params);
  return r.lastInsertRowid as number;
}

function parseJson(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('handleErrorDashboard (TD-171 M3)', () => {
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

  it('returns the canonical _dashboard shape with totals + recent + samples', () => {
    seedError(db, { project: 'p', fingerprint: 'a', solution: 'fixed', occurrence_count: 5 });
    seedError(db, { project: 'p', fingerprint: 'b', solution: '', occurrence_count: 3 });
    seedError(db, { project: 'q', fingerprint: 'c', solution: 'fixed', occurrence_count: 1 });

    const result = handleErrorDashboard({});
    const payload = parseJson(result);

    expect(Object.keys(payload).sort()).toEqual(['recent', 'samples', 'totals'].sort());

    const totals = payload.totals as Record<string, number>;
    expect(totals.total).toBe(3);
    expect(totals.with_solution).toBe(2);
    expect(totals.without_solution).toBe(1);

    const recent = payload.recent as Record<string, unknown>;
    expect(recent.last_n_days).toBe(30);
    expect(recent.new_errors).toBe(3);

    const samples = payload.samples as Record<string, unknown>;
    const top = samples.top_recurring as { fingerprint: string; occurrence_count: number }[];
    // ordered by occurrence_count DESC: 5, 3, 1
    expect(top[0].occurrence_count).toBe(5);
    expect(top[0].fingerprint).toBe('a');
    expect(top[1].occurrence_count).toBe(3);
    expect(top[2].occurrence_count).toBe(1);

    const byProject = samples.by_project as Record<string, number>;
    expect(byProject.p).toBe(2);
    expect(byProject.q).toBe(1);
  });

  it('omits samples when summary_only=true', () => {
    seedError(db);
    seedError(db, { fingerprint: 'b' });
    const result = handleErrorDashboard({ summary_only: true });
    const payload = parseJson(result);
    expect(payload.samples).toBeUndefined();
    const totals = payload.totals as Record<string, number>;
    expect(totals.total).toBe(2);
  });

  it('narrows totals + recent + samples when project filter is set', () => {
    seedError(db, { project: 'project-a', fingerprint: 'a' });
    seedError(db, { project: 'project-a', fingerprint: 'b' });
    seedError(db, { project: 'project-b', fingerprint: 'c' });

    const result = handleErrorDashboard({ project: 'project-a' });
    const payload = parseJson(result);

    expect(payload.project).toBe('project-a');
    const totals = payload.totals as Record<string, number>;
    expect(totals.total).toBe(2);
    const samples = payload.samples as Record<string, unknown>;
    const top = samples.top_recurring as { project: string }[];
    expect(top.every((r) => r.project === 'project-a')).toBe(true);
  });

  it('echoes the days filter and limits recent.new_errors accordingly', () => {
    // Two recent rows + one old row (60 days ago)
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    seedError(db, { fingerprint: 'a' });
    seedError(db, { fingerprint: 'b' });
    seedError(db, { fingerprint: 'c', first_seen_at: oldDate });

    const result = handleErrorDashboard({ days: 30 });
    const payload = parseJson(result);
    const recent = payload.recent as Record<string, unknown>;
    expect(recent.last_n_days).toBe(30);
    expect(recent.new_errors).toBe(2);
    // Total still counts ALL rows
    const totals = payload.totals as Record<string, number>;
    expect(totals.total).toBe(3);
  });

  it('returns zero-counts for an empty DB without throwing', () => {
    const result = handleErrorDashboard({});
    const payload = parseJson(result);
    const totals = payload.totals as Record<string, number>;
    expect(totals.total).toBe(0);
    expect(totals.with_solution).toBe(0);
    expect(totals.without_solution).toBe(0);
    const samples = payload.samples as Record<string, unknown>;
    expect(samples.top_recurring).toEqual([]);
    expect(samples.by_project).toEqual({});
  });

  it('rejects negative days', () => {
    const result = handleErrorDashboard({ days: -5 });
    expect(result.content[0].text).toContain('days must be a non-negative number');
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128) — gateway-level
  // -------------------------------------------------------------------------

  it('rejects unknown args via the gateway strict-input contract (TD-128)', async () => {
    const gateway = createGateway();
    const component = createErrorsComponent();
    gateway.register(component.tools());

    await expect(
      gateway.dispatch('igris_error_dashboard', { bogus: 'x' }),
    ).rejects.toThrowError(/igris_error_dashboard: unknown argument 'bogus'/);
  });

  it('dispatches cleanly via the gateway with no args (defaults applied)', async () => {
    const gateway = createGateway();
    const component = createErrorsComponent();
    gateway.register(component.tools());

    seedError(db);
    const result = await gateway.dispatch('igris_error_dashboard', {});
    const payload = parseJson(result as { content: { text: string }[] });
    const totals = payload.totals as Record<string, number>;
    expect(totals.total).toBe(1);
  });
});
