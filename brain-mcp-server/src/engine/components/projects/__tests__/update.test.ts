/**
 * TD-171 M3 — igris_project_update handler tests.
 *
 * Coverage:
 *   - happy path (single field, multi-field UPDATE)
 *   - returns the list of fields actually updated
 *   - partial update only touches provided fields (omitted fields preserved)
 *   - rejects on missing slug (slug is required)
 *   - rejects when target project does not exist
 *   - rejects no-fields-provided (caller passed only `slug`)
 *   - rejects invalid status enum value
 *   - rejects unknown args via the gateway strict-input contract (TD-128)
 *
 * @module engine/components/projects/__tests__/update.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

import { getDb } from '../../../../db.js';
import { handleProjectUpdate } from '../../../../tools/projects.js';
import { createGateway } from '../../../gateway.js';
import { createProjectsComponent } from '../index.js';

const mockedGetDb = vi.mocked(getDb);

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      tech_stack TEXT DEFAULT '',
      archetype TEXT DEFAULT 'unclassified',
      igris_version TEXT DEFAULT '7.0.0',
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'inactive')),
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_session_at TEXT,
      metadata TEXT DEFAULT '{}'
    );
  `);
  return db;
}

function seed(
  db: Database.Database,
  overrides: Partial<{
    slug: string;
    name: string;
    path: string;
    tech_stack: string;
    archetype: string;
    status: string;
  }> = {},
): void {
  const data = {
    slug: 'demo-project',
    name: 'Demo Project',
    path: '/tmp/demo',
    tech_stack: 'typescript,node',
    archetype: 'ai-agent-system',
    status: 'active',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO projects (slug, name, path, tech_stack, archetype, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(data.slug, data.name, data.path, data.tech_stack, data.archetype, data.status);
}

function parseJson(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('handleProjectUpdate (TD-171 M3)', () => {
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

  it('updates a single field and reports it in updated_fields', () => {
    seed(db);
    const result = handleProjectUpdate({ slug: 'demo-project', status: 'archived' });
    const payload = parseJson(result);
    expect(payload.slug).toBe('demo-project');
    expect(payload.updated_fields).toEqual(['status']);

    const row = db.prepare('SELECT * FROM projects WHERE slug = ?').get('demo-project') as Record<string, unknown>;
    expect(row.status).toBe('archived');
    // omitted fields preserved
    expect(row.name).toBe('Demo Project');
    expect(row.path).toBe('/tmp/demo');
    expect(row.tech_stack).toBe('typescript,node');
    expect(row.archetype).toBe('ai-agent-system');
  });

  it('updates multiple fields atomically', () => {
    seed(db);
    const result = handleProjectUpdate({
      slug: 'demo-project',
      name: 'Renamed',
      tech_stack: 'dart,flutter',
      archetype: 'enterprise-mvvm-mobile',
    });
    const payload = parseJson(result);
    expect((payload.updated_fields as string[]).sort()).toEqual(['archetype', 'name', 'tech_stack']);

    const row = db.prepare('SELECT * FROM projects WHERE slug = ?').get('demo-project') as Record<string, unknown>;
    expect(row.name).toBe('Renamed');
    expect(row.tech_stack).toBe('dart,flutter');
    expect(row.archetype).toBe('enterprise-mvvm-mobile');
    // status untouched
    expect(row.status).toBe('active');
  });

  it('rejects on missing slug', () => {
    const result = handleProjectUpdate({} as never);
    expect(result.content[0].text).toContain('slug is required');
  });

  it('rejects when project does not exist', () => {
    seed(db);
    const result = handleProjectUpdate({ slug: 'no-such-project', status: 'archived' });
    expect(result.content[0].text).toContain('not found');
  });

  it('rejects no-fields-provided (caller passed only slug)', () => {
    seed(db);
    const result = handleProjectUpdate({ slug: 'demo-project' });
    expect(result.content[0].text).toContain('no updatable fields provided');
  });

  it('rejects invalid status enum value', () => {
    seed(db);
    const result = handleProjectUpdate({ slug: 'demo-project', status: 'bogus' as never });
    expect(result.content[0].text).toContain('invalid status');
  });

  // -------------------------------------------------------------------------
  // Strict-input contract (TD-128) — gateway-level
  // -------------------------------------------------------------------------

  it('rejects unknown args via the gateway strict-input contract (TD-128)', async () => {
    const gateway = createGateway();
    const component = createProjectsComponent();
    gateway.register(component.tools());

    seed(db);
    await expect(
      gateway.dispatch('igris_project_update', {
        slug: 'demo-project',
        bogus_extra: 'should-throw',
      }),
    ).rejects.toThrowError(/igris_project_update: unknown argument 'bogus_extra'/);
  });

  it('dispatches cleanly via the gateway with valid args', async () => {
    const gateway = createGateway();
    const component = createProjectsComponent();
    gateway.register(component.tools());

    seed(db);
    const result = await gateway.dispatch('igris_project_update', {
      slug: 'demo-project',
      name: 'Via Gateway',
    });
    const payload = parseJson(result as { content: { text: string }[] });
    expect(payload.updated_fields).toEqual(['name']);
  });
});
