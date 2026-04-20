/**
 * Tasks Component Unit Tests — brief_id filter on handleTaskList
 *
 * Verifies that the WhereBuilder correctly filters tasks by brief_id when
 * provided in the args, and returns all tasks when omitted (backward-compat).
 *
 * @module engine/components/tasks/__tests__/task-list-brief-filter.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

// Mock the db module so handleTaskList resolves getDb() to our in-memory DB
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { getDb } from '../../../../db.js';
import { handleTaskList } from '../handlers.js';
import { taskMigrations } from '../schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an in-memory SQLite database with all task migrations applied.
 * Applies migrations v1-v5 sequentially so the final tasks table schema
 * matches production (including the brief_id column).
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  // Apply all task migrations in order. The migration SQL toggles
  // foreign_keys ON at the end of v2 and v4; we disable after so our
  // seeds can insert without needing a projects table.
  for (const migration of taskMigrations) {
    db.exec(migration.sql);
  }
  db.pragma('foreign_keys = OFF');
  return db;
}

/** Insert a task row directly with sensible defaults. */
function insertTask(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    task_type: string;
    scope: string;
    title: string;
    brief_id: string | null;
    project_slug: string | null;
    status: string;
    priority: number;
  }> = {},
): void {
  const defaults = {
    id: 't-' + Math.random().toString(36).slice(2, 10),
    task_type: 'brief',
    scope: 'project',
    title: 'Test task',
    brief_id: null as string | null,
    project_slug: 'igris-ai',
    status: 'pending',
    priority: 3,
  };
  const row = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO tasks (id, task_type, scope, title, brief_id, project_slug, status, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.task_type, row.scope, row.title, row.brief_id, row.project_slug, row.status, row.priority);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleTaskList — brief_id filter', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns only the task matching the given brief_id', () => {
    insertTask(db, { id: 't-a0000001', brief_id: 'BR-001', title: 'Task for BR-001' });
    insertTask(db, { id: 't-a0000002', brief_id: 'BR-002', title: 'Task for BR-002' });
    insertTask(db, { id: 't-a0000003', brief_id: 'BR-003', title: 'Task for BR-003' });

    const result = handleTaskList({ brief_id: 'BR-001' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].id).toBe('t-a0000001');
    expect(parsed.tasks[0].brief_id).toBe('BR-001');
    expect(parsed.total).toBe(1);
  });

  it('returns empty array when no task matches the brief_id', () => {
    insertTask(db, { id: 't-b0000001', brief_id: 'BR-001' });
    insertTask(db, { id: 't-b0000002', brief_id: 'BR-002' });

    const result = handleTaskList({ brief_id: 'BR-999' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.tasks).toHaveLength(0);
    expect(parsed.total).toBe(0);
  });

  it('returns all tasks when brief_id is omitted (backward-compatible)', () => {
    insertTask(db, { id: 't-c0000001', brief_id: 'BR-001' });
    insertTask(db, { id: 't-c0000002', brief_id: 'BR-002' });
    insertTask(db, { id: 't-c0000003', brief_id: null });

    const result = handleTaskList({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.tasks).toHaveLength(3);
    expect(parsed.total).toBe(3);
  });

  it('combines brief_id filter with status filter correctly', () => {
    insertTask(db, { id: 't-d0000001', brief_id: 'BR-010', status: 'pending' });
    insertTask(db, { id: 't-d0000002', brief_id: 'BR-010', status: 'done' });
    insertTask(db, { id: 't-d0000003', brief_id: 'BR-020', status: 'pending' });

    const result = handleTaskList({ brief_id: 'BR-010', status: 'pending' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].id).toBe('t-d0000001');
    expect(parsed.total).toBe(1);
  });

  it('combines brief_id filter with project_slug filter correctly', () => {
    insertTask(db, { id: 't-e0000001', brief_id: 'BR-100', project_slug: 'proj-a' });
    insertTask(db, { id: 't-e0000002', brief_id: 'BR-100', project_slug: 'proj-b' });

    const result = handleTaskList({ brief_id: 'BR-100', project_slug: 'proj-a' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].project_slug).toBe('proj-a');
    expect(parsed.total).toBe(1);
  });
});
