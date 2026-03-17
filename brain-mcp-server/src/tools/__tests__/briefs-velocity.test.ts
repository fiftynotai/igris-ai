/**
 * Brief Velocity Handler Tests (FR-079)
 *
 * Tests the handleBriefVelocity handler:
 * 1. Weekly completions — Done briefs grouped by ISO week
 * 2. Completion rate — Done vs total, with percentage
 * 3. Trend — week-over-week direction (up/down/flat)
 * 4. Edge cases — empty data, project filter, zero division
 *
 * @module tools/__tests__/briefs-velocity.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

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
import { handleBriefVelocity } from '../briefs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockedGetDb = vi.mocked(getDb);

/** Create an in-memory database with the brief_status table. */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_type TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      effort TEXT,
      phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_brief_status_project ON brief_status(project);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_status_unique ON brief_status(project, brief_id);
  `);

  return db;
}

/** Seed a brief into the test database. */
function seedBrief(
  db: Database.Database,
  project: string,
  briefId: string,
  opts: {
    status?: string;
    updated_at?: string;
    title?: string;
  } = {},
): void {
  const { status = 'Done', updated_at, title = `Brief ${briefId}` } = opts;

  if (updated_at) {
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, title, status, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(project, briefId, title, status, updated_at);
  } else {
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, title, status)
       VALUES (?, ?, ?, ?)`
    ).run(project, briefId, title, status);
  }
}

/** Seed a brief with updated_at relative to now using SQLite datetime(). */
function seedBriefRelative(
  db: Database.Database,
  project: string,
  briefId: string,
  daysAgo: number,
  status = 'Done',
): void {
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status, updated_at)
     VALUES (?, ?, ?, ?, datetime('now', '-' || ? || ' days'))`
  ).run(project, briefId, `Brief ${briefId}`, status, daysAgo);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleBriefVelocity', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Empty / no data
  // -------------------------------------------------------------------------

  it('returns empty results when no briefs exist', () => {
    const result = handleBriefVelocity();

    expect(result.project).toBeNull();
    expect(result.weeks).toBe(4);
    expect(result.weekly).toEqual([]);
    expect(result.completion_rate).toEqual({ done: 0, total: 0, percentage: 0 });
    expect(result.trend).toBeNull();
  });

  it('returns zero done when all briefs are non-Done status', () => {
    seedBrief(db, 'proj-a', 'BR-001', { status: 'Ready' });
    seedBrief(db, 'proj-a', 'BR-002', { status: 'In Progress' });

    const result = handleBriefVelocity({ project: 'proj-a' });

    expect(result.completion_rate).toEqual({ done: 0, total: 2, percentage: 0 });
    expect(result.weekly).toEqual([]);
    expect(result.trend).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Completion rate
  // -------------------------------------------------------------------------

  it('calculates correct completion rate', () => {
    seedBrief(db, 'proj-a', 'BR-001', { status: 'Done' });
    seedBrief(db, 'proj-a', 'BR-002', { status: 'Done' });
    seedBrief(db, 'proj-a', 'BR-003', { status: 'Ready' });
    seedBrief(db, 'proj-a', 'BR-004', { status: 'In Progress' });

    const result = handleBriefVelocity({ project: 'proj-a' });

    expect(result.completion_rate.done).toBe(2);
    expect(result.completion_rate.total).toBe(4);
    expect(result.completion_rate.percentage).toBe(50.0);
  });

  it('returns 100% when all briefs are Done', () => {
    seedBrief(db, 'proj-a', 'BR-001', { status: 'Done' });
    seedBrief(db, 'proj-a', 'BR-002', { status: 'Done' });

    const result = handleBriefVelocity({ project: 'proj-a' });

    expect(result.completion_rate.percentage).toBe(100);
  });

  // -------------------------------------------------------------------------
  // Project filtering
  // -------------------------------------------------------------------------

  it('filters by project when specified', () => {
    seedBrief(db, 'proj-a', 'BR-001', { status: 'Done' });
    seedBrief(db, 'proj-a', 'BR-002', { status: 'Ready' });
    seedBrief(db, 'proj-b', 'BR-001', { status: 'Done' });
    seedBrief(db, 'proj-b', 'BR-002', { status: 'Done' });
    seedBrief(db, 'proj-b', 'BR-003', { status: 'Done' });

    const resultA = handleBriefVelocity({ project: 'proj-a' });
    expect(resultA.project).toBe('proj-a');
    expect(resultA.completion_rate.done).toBe(1);
    expect(resultA.completion_rate.total).toBe(2);

    const resultB = handleBriefVelocity({ project: 'proj-b' });
    expect(resultB.project).toBe('proj-b');
    expect(resultB.completion_rate.done).toBe(3);
    expect(resultB.completion_rate.total).toBe(3);
  });

  it('returns global stats when no project filter', () => {
    seedBrief(db, 'proj-a', 'BR-001', { status: 'Done' });
    seedBrief(db, 'proj-b', 'BR-001', { status: 'Done' });

    const result = handleBriefVelocity();

    expect(result.project).toBeNull();
    expect(result.completion_rate.done).toBe(2);
    expect(result.completion_rate.total).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Weekly completions
  // -------------------------------------------------------------------------

  it('groups recent Done briefs by week', () => {
    // Seed briefs completed recently (within last 28 days)
    seedBriefRelative(db, 'proj-a', 'BR-001', 1);
    seedBriefRelative(db, 'proj-a', 'BR-002', 2);
    seedBriefRelative(db, 'proj-a', 'BR-003', 10);

    const result = handleBriefVelocity({ project: 'proj-a', weeks: 4 });

    // Should have at least 1 week entry with completions
    expect(result.weekly.length).toBeGreaterThan(0);

    // Total completed across all weeks should be 3
    const totalCompleted = result.weekly.reduce((sum, w) => sum + w.completed, 0);
    expect(totalCompleted).toBe(3);
  });

  it('excludes Done briefs older than the weeks window', () => {
    seedBriefRelative(db, 'proj-a', 'BR-001', 1);    // recent — included
    seedBriefRelative(db, 'proj-a', 'BR-002', 60);   // 60 days ago — excluded from 4-week window

    const result = handleBriefVelocity({ project: 'proj-a', weeks: 4 });

    const totalCompleted = result.weekly.reduce((sum, w) => sum + w.completed, 0);
    expect(totalCompleted).toBe(1);
  });

  it('excludes non-Done briefs from weekly counts', () => {
    seedBriefRelative(db, 'proj-a', 'BR-001', 1, 'Done');
    seedBriefRelative(db, 'proj-a', 'BR-002', 2, 'In Progress');
    seedBriefRelative(db, 'proj-a', 'BR-003', 3, 'Ready');

    const result = handleBriefVelocity({ project: 'proj-a', weeks: 4 });

    const totalCompleted = result.weekly.reduce((sum, w) => sum + w.completed, 0);
    expect(totalCompleted).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Trend
  // -------------------------------------------------------------------------

  it('returns trend=up when current week has more completions', () => {
    // 2 briefs completed in last 7 days
    seedBriefRelative(db, 'proj-a', 'BR-001', 1);
    seedBriefRelative(db, 'proj-a', 'BR-002', 3);
    // 1 brief completed 7-14 days ago
    seedBriefRelative(db, 'proj-a', 'BR-003', 10);

    const result = handleBriefVelocity({ project: 'proj-a' });

    expect(result.trend).not.toBeNull();
    expect(result.trend!.current_week).toBe(2);
    expect(result.trend!.previous_week).toBe(1);
    expect(result.trend!.direction).toBe('up');
    expect(result.trend!.change_pct).toBe(100.0);
  });

  it('returns trend=down when current week has fewer completions', () => {
    // 1 brief completed in last 7 days
    seedBriefRelative(db, 'proj-a', 'BR-001', 2);
    // 3 briefs completed 7-14 days ago
    seedBriefRelative(db, 'proj-a', 'BR-002', 8);
    seedBriefRelative(db, 'proj-a', 'BR-003', 10);
    seedBriefRelative(db, 'proj-a', 'BR-004', 12);

    const result = handleBriefVelocity({ project: 'proj-a' });

    expect(result.trend).not.toBeNull();
    expect(result.trend!.current_week).toBe(1);
    expect(result.trend!.previous_week).toBe(3);
    expect(result.trend!.direction).toBe('down');
    expect(result.trend!.change_pct).toBeCloseTo(-66.7, 0);
  });

  it('returns trend=flat when both weeks are equal', () => {
    // 2 briefs in each period
    seedBriefRelative(db, 'proj-a', 'BR-001', 1);
    seedBriefRelative(db, 'proj-a', 'BR-002', 3);
    seedBriefRelative(db, 'proj-a', 'BR-003', 8);
    seedBriefRelative(db, 'proj-a', 'BR-004', 10);

    const result = handleBriefVelocity({ project: 'proj-a' });

    expect(result.trend).not.toBeNull();
    expect(result.trend!.direction).toBe('flat');
    expect(result.trend!.change_pct).toBe(0);
  });

  it('returns trend=up with null change_pct when previous week is zero', () => {
    // Only current week has completions
    seedBriefRelative(db, 'proj-a', 'BR-001', 2);

    const result = handleBriefVelocity({ project: 'proj-a' });

    expect(result.trend).not.toBeNull();
    expect(result.trend!.current_week).toBe(1);
    expect(result.trend!.previous_week).toBe(0);
    expect(result.trend!.direction).toBe('up');
    expect(result.trend!.change_pct).toBeNull();
  });

  it('returns null trend when no briefs completed in last 14 days', () => {
    // Brief completed 30 days ago — outside trend window
    seedBriefRelative(db, 'proj-a', 'BR-001', 30);

    const result = handleBriefVelocity({ project: 'proj-a' });

    expect(result.trend).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Weeks parameter
  // -------------------------------------------------------------------------

  it('defaults to 4 weeks', () => {
    const result = handleBriefVelocity();
    expect(result.weeks).toBe(4);
  });

  it('clamps weeks to minimum of 1', () => {
    const result = handleBriefVelocity({ weeks: 0 });
    expect(result.weeks).toBe(1);
  });

  it('clamps weeks to maximum of 52', () => {
    const result = handleBriefVelocity({ weeks: 100 });
    expect(result.weeks).toBe(52);
  });

  it('uses specified weeks value within range', () => {
    const result = handleBriefVelocity({ weeks: 12 });
    expect(result.weeks).toBe(12);
  });
});
