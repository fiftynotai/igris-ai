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
 * TD-402 retry 1 added the duplicate-path half. `PROJECT_UPDATABLE_FIELDS`
 * includes `path`, so before this block `handleProjectUpdate({ slug, path })`
 * would happily point a SECOND slug at a directory another row already held —
 * the exact state TD-402 exists to fold away, reachable through the very tool
 * `handleProjectRegister`'s refusal message recommends. Measured before the fix:
 * `{"updated_fields":["path"]}` and two rows sharing one path.
 *   - refuses a path another slug already holds, naming the holder
 *   - allows re-pointing a row at a FREE path (the legitimate move-a-checkout case)
 *   - allows a no-op self-update of a row's own path (holder check excludes self)
 *   - refuses through the gateway too
 *   - a non-path update is unaffected by the check
 *
 * @module engine/components/projects/__tests__/update.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// ---------------------------------------------------------------------------
// TD-402 — the duplicate-path half of igris_project_update
// ---------------------------------------------------------------------------

describe('handleProjectUpdate duplicate-path refusal (TD-402)', () => {
  let db: Database.Database;
  const dirs: string[] = [];

  function stageDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), `igris-update-${prefix}-`));
    dirs.push(d);
    return d;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    while (dirs.length) {
      try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function pathsOf(dir: string): { slug: string }[] {
    return db.prepare('SELECT slug FROM projects WHERE path = ?').all(dir) as { slug: string }[];
  }

  it('refuses a path another slug already holds and names the holder', () => {
    const held = stageDir('held');
    const mine = stageDir('mine');
    seed(db, { slug: 'holder', path: held });
    seed(db, { slug: 'mover', path: mine });

    const result = handleProjectUpdate({ slug: 'mover', path: held });
    expect(result.content[0].text).toContain('Error:');
    expect(result.content[0].text).toContain('holder');
    // Nothing was written — the refusal is BEFORE the UPDATE.
    expect(pathsOf(held).map((r) => r.slug)).toEqual(['holder']);
    const row = db.prepare('SELECT path FROM projects WHERE slug = ?').get('mover') as { path: string };
    expect(row.path).toBe(mine);
  });

  it('refuses a symlink whose realpath is another slug’s registered directory', () => {
    const real = stageDir('realtarget');
    const linkBase = stageDir('linkbase');
    const link = join(linkBase, 'linked-proj');
    symlinkSync(real, link);
    seed(db, { slug: 'holder', path: real });
    seed(db, { slug: 'mover', path: stageDir('mover') });

    const result = handleProjectUpdate({ slug: 'mover', path: link });
    expect(result.content[0].text).toContain('Error:');
    expect(result.content[0].text).toContain('holder');
  });

  it('ALLOWS re-pointing a row at a free path (moving a checkout)', () => {
    const from = stageDir('from');
    const to = stageDir('to');
    seed(db, { slug: 'mover', path: from });

    const payload = parseJson(handleProjectUpdate({ slug: 'mover', path: to }));
    expect(payload.updated_fields).toEqual(['path']);
    const row = db.prepare('SELECT path FROM projects WHERE slug = ?').get('mover') as { path: string };
    expect(row.path).toBe(to);
  });

  it('ALLOWS a row to re-set its OWN path (the holder check excludes self)', () => {
    const own = stageDir('own');
    seed(db, { slug: 'mover', path: own });

    const payload = parseJson(handleProjectUpdate({ slug: 'mover', path: own }));
    expect(payload.updated_fields).toEqual(['path']);
    expect(pathsOf(own).map((r) => r.slug)).toEqual(['mover']);
  });

  it('does not touch a non-path update even when another row shares nothing', () => {
    const held = stageDir('held2');
    seed(db, { slug: 'holder', path: held });
    seed(db, { slug: 'mover', path: stageDir('mine2') });

    const payload = parseJson(handleProjectUpdate({ slug: 'mover', name: 'Renamed', status: 'archived' }));
    expect((payload.updated_fields as string[]).sort()).toEqual(['name', 'status']);
  });

  it('refuses through the gateway too (dispatch path)', async () => {
    const held = stageDir('gwheld');
    seed(db, { slug: 'holder', path: held });
    seed(db, { slug: 'mover', path: stageDir('gwmine') });

    const gateway = createGateway();
    gateway.register(createProjectsComponent().tools());
    const result = (await gateway.dispatch('igris_project_update', {
      slug: 'mover',
      path: held,
    })) as { content: { text: string }[] };
    expect(result.content[0].text).toContain('Error:');
    expect(result.content[0].text).toContain('holder');
    expect(pathsOf(held).map((r) => r.slug)).toEqual(['holder']);
  });
});
