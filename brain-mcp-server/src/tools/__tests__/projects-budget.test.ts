/**
 * Project Budget Handler Tests (FR-072)
 *
 * Tests the per-project budget tracking handlers:
 * 1. handleProjectBudget — token aggregation by agent, budget config parsing
 * 2. handleProjectBudgetSet — budget threshold persistence via json_set
 *
 * @module tools/__tests__/projects-budget.test
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
import { handleProjectBudget, handleProjectBudgetSet } from '../projects.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockedGetDb = vi.mocked(getDb);

/** Create an in-memory database with the tables needed for budget queries. */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      tech_stack TEXT DEFAULT '',
      igris_version TEXT DEFAULT '4.0.0',
      status TEXT DEFAULT 'active',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_session_at TEXT,
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      machine_hostname TEXT NOT NULL,
      machine_os TEXT,
      project_slug TEXT,
      project_path TEXT,
      current_brief TEXT,
      current_phase TEXT,
      current_task TEXT,
      status TEXT DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      event_type TEXT NOT NULL,
      phase TEXT,
      brief_id TEXT,
      duration_ms INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0,
      cache_create INTEGER DEFAULT 0,
      result TEXT,
      error_message TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

/** Seed a project into the test database. */
function seedProject(db: Database.Database, slug: string, metadata = '{}'): void {
  db.prepare(
    `INSERT INTO projects (slug, name, path, metadata) VALUES (?, ?, ?, ?)`
  ).run(slug, `Project ${slug}`, `/path/to/${slug}`, metadata);
}

/** Seed an instance into the test database. */
function seedInstance(db: Database.Database, id: string, projectSlug: string): void {
  db.prepare(
    `INSERT INTO instances (id, machine_hostname, project_slug) VALUES (?, ?, ?)`
  ).run(id, 'test-host', projectSlug);
}

/** Seed an agent event into the test database. */
function seedEvent(
  db: Database.Database,
  instanceId: string,
  agent: string,
  opts: {
    event_type?: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read?: number;
    cache_create?: number;
    created_at?: string;
  } = {},
): void {
  const {
    event_type = 'stop',
    input_tokens = 0,
    output_tokens = 0,
    cache_read = 0,
    cache_create = 0,
    created_at,
  } = opts;

  if (created_at) {
    db.prepare(`
      INSERT INTO agent_events (instance_id, agent, event_type, input_tokens, output_tokens, cache_read, cache_create, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(instanceId, agent, event_type, input_tokens, output_tokens, cache_read, cache_create, created_at);
  } else {
    db.prepare(`
      INSERT INTO agent_events (instance_id, agent, event_type, input_tokens, output_tokens, cache_read, cache_create)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(instanceId, agent, event_type, input_tokens, output_tokens, cache_read, cache_create);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleProjectBudget', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns empty results for a project with no events', () => {
    seedProject(db, 'empty-project');

    const result = handleProjectBudget({ slug: 'empty-project' });

    expect(result.project_slug).toBe('empty-project');
    expect(result.period).toBe('monthly');
    expect(result.budget_limit).toBeNull();
    expect(result.by_agent).toEqual([]);
    expect(result.totals).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read: 0,
      cache_create: 0,
      event_count: 0,
    });
  });

  it('aggregates tokens per agent from stop events', () => {
    seedProject(db, 'my-proj');
    seedInstance(db, 'inst-1', 'my-proj');

    // Two stop events for forger
    seedEvent(db, 'inst-1', 'forger', { input_tokens: 1000, output_tokens: 200, cache_read: 500, cache_create: 100 });
    seedEvent(db, 'inst-1', 'forger', { input_tokens: 2000, output_tokens: 400, cache_read: 300, cache_create: 50 });

    // One stop event for sentinel
    seedEvent(db, 'inst-1', 'sentinel', { input_tokens: 500, output_tokens: 100, cache_read: 200, cache_create: 30 });

    const result = handleProjectBudget({ slug: 'my-proj' });

    expect(result.by_agent).toHaveLength(2);

    // Forger should be first (higher input_tokens)
    const forger = result.by_agent.find(a => a.agent === 'forger');
    expect(forger).toBeDefined();
    expect(forger!.input_tokens).toBe(3000);
    expect(forger!.output_tokens).toBe(600);
    expect(forger!.cache_read).toBe(800);
    expect(forger!.cache_create).toBe(150);
    expect(forger!.event_count).toBe(2);

    const sentinel = result.by_agent.find(a => a.agent === 'sentinel');
    expect(sentinel).toBeDefined();
    expect(sentinel!.input_tokens).toBe(500);
    expect(sentinel!.event_count).toBe(1);

    // Totals
    expect(result.totals.input_tokens).toBe(3500);
    expect(result.totals.output_tokens).toBe(700);
    expect(result.totals.cache_read).toBe(1000);
    expect(result.totals.cache_create).toBe(180);
    expect(result.totals.event_count).toBe(3);
  });

  it('excludes non-stop event types', () => {
    seedProject(db, 'my-proj');
    seedInstance(db, 'inst-1', 'my-proj');

    seedEvent(db, 'inst-1', 'forger', { event_type: 'stop', input_tokens: 1000, output_tokens: 200 });
    seedEvent(db, 'inst-1', 'forger', { event_type: 'start', input_tokens: 500, output_tokens: 100 });
    seedEvent(db, 'inst-1', 'forger', { event_type: 'error', input_tokens: 300, output_tokens: 50 });

    const result = handleProjectBudget({ slug: 'my-proj' });

    // Only the stop event should be counted
    expect(result.totals.input_tokens).toBe(1000);
    expect(result.totals.output_tokens).toBe(200);
    expect(result.totals.event_count).toBe(1);
  });

  it('excludes events from other projects', () => {
    seedProject(db, 'proj-a');
    seedProject(db, 'proj-b');
    seedInstance(db, 'inst-a', 'proj-a');
    seedInstance(db, 'inst-b', 'proj-b');

    seedEvent(db, 'inst-a', 'forger', { input_tokens: 1000, output_tokens: 200 });
    seedEvent(db, 'inst-b', 'forger', { input_tokens: 5000, output_tokens: 900 });

    const result = handleProjectBudget({ slug: 'proj-a' });

    expect(result.totals.input_tokens).toBe(1000);
    expect(result.totals.event_count).toBe(1);
  });

  it('excludes events older than 30 days', () => {
    seedProject(db, 'my-proj');
    seedInstance(db, 'inst-1', 'my-proj');

    // Recent event (uses default created_at = now)
    seedEvent(db, 'inst-1', 'forger', { input_tokens: 1000, output_tokens: 200 });

    // Old event (45 days ago) — use raw SQL so datetime() is evaluated by SQLite
    db.prepare(`
      INSERT INTO agent_events (instance_id, agent, event_type, input_tokens, output_tokens, cache_read, cache_create, created_at)
      VALUES (?, ?, 'stop', ?, ?, 0, 0, datetime('now', '-45 days'))
    `).run('inst-1', 'forger', 9999, 9999);

    db.prepare(`
      INSERT INTO agent_events (instance_id, agent, event_type, input_tokens, output_tokens, cache_read, cache_create, created_at)
      VALUES (?, ?, 'stop', ?, ?, 0, 0, datetime('now', '-45 days'))
    `).run('inst-1', 'sentinel', 8000, 3000);

    const result = handleProjectBudget({ slug: 'my-proj' });

    // Only the recent forger event should be counted; the two old ones are excluded
    expect(result.totals.input_tokens).toBe(1000);
    expect(result.totals.output_tokens).toBe(200);
    expect(result.totals.event_count).toBe(1);
  });

  it('reads budget_limit and budget_period from project metadata', () => {
    seedProject(db, 'budgeted', JSON.stringify({ budget_limit: 75.5, budget_period: 'weekly' }));

    const result = handleProjectBudget({ slug: 'budgeted' });

    expect(result.budget_limit).toBe(75.5);
    expect(result.period).toBe('weekly');
  });

  it('defaults to monthly period and null limit when metadata is empty', () => {
    seedProject(db, 'no-budget', '{}');

    const result = handleProjectBudget({ slug: 'no-budget' });

    expect(result.budget_limit).toBeNull();
    expect(result.period).toBe('monthly');
  });

  it('handles invalid metadata JSON gracefully', () => {
    seedProject(db, 'bad-meta', 'not-json');

    const result = handleProjectBudget({ slug: 'bad-meta' });

    expect(result.budget_limit).toBeNull();
    expect(result.period).toBe('monthly');
  });

  it('handles project not in projects table (no metadata row)', () => {
    // Project not registered but instances exist with events
    seedInstance(db, 'orphan-inst', 'ghost-project');
    seedEvent(db, 'orphan-inst', 'forger', { input_tokens: 1000, output_tokens: 200 });

    const result = handleProjectBudget({ slug: 'ghost-project' });

    // Should still aggregate events
    expect(result.totals.input_tokens).toBe(1000);
    expect(result.budget_limit).toBeNull();
    expect(result.period).toBe('monthly');
  });
});

describe('handleProjectBudgetSet', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('sets budget_limit and budget_period in project metadata', () => {
    seedProject(db, 'my-proj');

    const result = handleProjectBudgetSet({
      slug: 'my-proj',
      budget_limit: 50.0,
      budget_period: 'monthly',
    });

    expect(result.project_slug).toBe('my-proj');
    expect(result.budget_limit).toBe(50.0);
    expect(result.budget_period).toBe('monthly');
    expect(result.updated).toBe(true);

    // Verify in database
    const row = db.prepare('SELECT metadata FROM projects WHERE slug = ?').get('my-proj') as { metadata: string };
    const meta = JSON.parse(row.metadata);
    expect(meta.budget_limit).toBe(50.0);
    expect(meta.budget_period).toBe('monthly');
  });

  it('defaults budget_period to monthly when not specified', () => {
    seedProject(db, 'my-proj');

    const result = handleProjectBudgetSet({
      slug: 'my-proj',
      budget_limit: 100,
    });

    expect(result.budget_period).toBe('monthly');

    const row = db.prepare('SELECT metadata FROM projects WHERE slug = ?').get('my-proj') as { metadata: string };
    const meta = JSON.parse(row.metadata);
    expect(meta.budget_period).toBe('monthly');
  });

  it('preserves existing metadata fields when setting budget', () => {
    seedProject(db, 'my-proj', JSON.stringify({ custom_field: 'keep-me', another: 42 }));

    handleProjectBudgetSet({
      slug: 'my-proj',
      budget_limit: 25.0,
      budget_period: 'weekly',
    });

    const row = db.prepare('SELECT metadata FROM projects WHERE slug = ?').get('my-proj') as { metadata: string };
    const meta = JSON.parse(row.metadata);
    expect(meta.custom_field).toBe('keep-me');
    expect(meta.another).toBe(42);
    expect(meta.budget_limit).toBe(25.0);
    expect(meta.budget_period).toBe('weekly');
  });

  it('returns updated=false for non-existent project slug', () => {
    const result = handleProjectBudgetSet({
      slug: 'does-not-exist',
      budget_limit: 10,
    });

    expect(result.updated).toBe(false);
  });

  it('overwrites existing budget values', () => {
    seedProject(db, 'my-proj', JSON.stringify({ budget_limit: 50, budget_period: 'monthly' }));

    handleProjectBudgetSet({
      slug: 'my-proj',
      budget_limit: 200,
      budget_period: 'weekly',
    });

    const row = db.prepare('SELECT metadata FROM projects WHERE slug = ?').get('my-proj') as { metadata: string };
    const meta = JSON.parse(row.metadata);
    expect(meta.budget_limit).toBe(200);
    expect(meta.budget_period).toBe('weekly');
  });

  it('round-trips with handleProjectBudget', () => {
    seedProject(db, 'my-proj');

    handleProjectBudgetSet({
      slug: 'my-proj',
      budget_limit: 99.99,
      budget_period: 'daily',
    });

    const budget = handleProjectBudget({ slug: 'my-proj' });
    expect(budget.budget_limit).toBe(99.99);
    expect(budget.period).toBe('daily');
  });
});
