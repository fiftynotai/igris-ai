/**
 * TD-402 — igris_project_register duplicate-path refusal tests.
 *
 * Coverage:
 *   - a SECOND slug registering an already-registered realpath is REFUSED,
 *     the response names the existing slug, and projects count is unchanged
 *   - the SAME slug re-registering its own path still UPSERTS (/boot's
 *     per-session refresh, core/skills/boot/SKILL.md:202-206)
 *   - a symlink whose realpath is an already-registered dir is REFUSED
 *   - a path that does not exist on disk still registers, with a warning
 *   - a brand-new slug at a brand-new path registers unchanged
 *   - the refusal survives gateway dispatch
 *
 * @module engine/components/projects/__tests__/register.test
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
import { handleProjectRegister } from '../../../../tools/projects.js';
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

function text(result: { content: { text: string }[] }): string {
  return result.content[0].text;
}

function count(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }).c;
}

describe('handleProjectRegister duplicate-path refusal (TD-402)', () => {
  let db: Database.Database;
  const dirs: string[] = [];

  function stageDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), `igris-register-${prefix}-`));
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

  it('refuses a second slug at an already-registered path and names the holder', () => {
    const dir = stageDir('shared');
    const first = handleProjectRegister({ slug: 'fifty_eco_system', name: 'Eco', path: dir });
    expect(text(first)).toContain('Project registered successfully.');
    expect(count(db)).toBe(1);

    const second = handleProjectRegister({ slug: 'fifty-eco-system', name: 'Eco', path: dir });
    expect(text(second)).toContain('Error:');
    // The refusal names the slug that already holds the path.
    expect(text(second)).toContain('fifty_eco_system');
    expect(text(second)).toContain('igris_project_update');
    // Nothing was minted.
    expect(count(db)).toBe(1);
    const rows = db.prepare('SELECT slug FROM projects').all() as { slug: string }[];
    expect(rows.map((r) => r.slug)).toEqual(['fifty_eco_system']);
  });

  it('still upserts when the SAME slug re-registers its own path (/boot refresh)', () => {
    const dir = stageDir('boot');
    handleProjectRegister({ slug: 'demo-project', name: 'Demo', path: dir });
    const before = db.prepare('SELECT last_session_at FROM projects WHERE slug = ?').get('demo-project');
    expect(before).toBeDefined();

    const again = handleProjectRegister({ slug: 'demo-project', name: 'Demo Renamed', path: dir, tech_stack: 'dart' });
    expect(text(again)).toContain('Project registered successfully.');
    expect(count(db)).toBe(1);
    const row = db.prepare('SELECT * FROM projects WHERE slug = ?').get('demo-project') as Record<string, unknown>;
    expect(row.name).toBe('Demo Renamed');
    expect(row.tech_stack).toBe('dart');
  });

  it('refuses a symlink whose realpath is an already-registered directory', () => {
    const real = stageDir('realtarget');
    const linkBase = stageDir('linkbase');
    const link = join(linkBase, 'linked-proj');
    symlinkSync(real, link);

    handleProjectRegister({ slug: 'real-target', name: 'Real', path: real });
    const viaLink = handleProjectRegister({ slug: 'via-symlink', name: 'Via Symlink', path: link });
    expect(text(viaLink)).toContain('Error:');
    expect(text(viaLink)).toContain('real-target');
    expect(count(db)).toBe(1);
  });

  it('registers a path that does not exist on disk, with a warning in the response', () => {
    const missing = join(tmpdir(), 'igris-register-does-not-exist-xyzzy');
    const result = handleProjectRegister({ slug: 'ghost', name: 'Ghost', path: missing });
    expect(text(result)).toContain('Project registered successfully.');
    expect(text(result)).toContain('Warning');
    expect(text(result)).toContain(missing);
    expect(count(db)).toBe(1);
  });

  it('registers a brand-new slug at a brand-new path unchanged', () => {
    const a = stageDir('a');
    const b = stageDir('b');
    handleProjectRegister({ slug: 'proj-a', name: 'A', path: a, tech_stack: 'ts', archetype: 'ai-agent-system' });
    const result = handleProjectRegister({ slug: 'proj-b', name: 'B', path: b });
    expect(text(result)).toContain('Project registered successfully.');
    expect(text(result)).toContain('Slug: proj-b');
    expect(count(db)).toBe(2);
    const rowA = db.prepare('SELECT * FROM projects WHERE slug = ?').get('proj-a') as Record<string, unknown>;
    expect(rowA.archetype).toBe('ai-agent-system');
    expect(rowA.tech_stack).toBe('ts');
  });

  it('two DIFFERENT paths under two slugs both register (the guard is path-scoped)', () => {
    const a = stageDir('p1');
    const b = stageDir('p2');
    handleProjectRegister({ slug: 's1', name: 'S1', path: a });
    handleProjectRegister({ slug: 's2', name: 'S2', path: b });
    expect(count(db)).toBe(2);
  });

  it('refuses through the gateway too (dispatch path)', async () => {
    const dir = stageDir('gw');
    const gateway = createGateway();
    const component = createProjectsComponent();
    gateway.register(component.tools());

    await gateway.dispatch('igris_project_register', { slug: 'holder', name: 'Holder', path: dir });
    const result = (await gateway.dispatch('igris_project_register', {
      slug: 'intruder',
      name: 'Intruder',
      path: dir,
    })) as { content: { text: string }[] };
    expect(text(result)).toContain('Error:');
    expect(text(result)).toContain('holder');
    expect(count(db)).toBe(1);
  });
});
