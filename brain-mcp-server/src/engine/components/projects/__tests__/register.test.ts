/**
 * TD-402 — igris_project_register duplicate-path refusal tests.
 * TD-365 — handler-side truthiness validation + the conflict-arm semantics.
 * FR-265 — `repo_url` detection, sanitisation and the COALESCE arm.
 *
 * Coverage:
 *   - a SECOND slug registering an already-registered realpath is REFUSED,
 *     the response names the existing slug, and projects count is unchanged
 *   - the SAME slug re-registering its own path still UPSERTS (/boot's
 *     per-session refresh, `core/skills/boot/SKILL.md` §4.3 Query Brain for
 *     Context)
 *   - a symlink whose realpath is an already-registered dir is REFUSED
 *   - a path that does not exist on disk still registers, with a warning
 *   - a brand-new slug at a brand-new path registers unchanged
 *   - the refusal survives gateway dispatch
 *   - TD-365 S1/S2: a null / empty / whitespace `slug`, `name` or `path` is an
 *     in-band `Validation error` naming the key — directly and through the
 *     gateway — never a raw SQLite NOT NULL error, and never a silent '' write
 *   - TD-365 S4/S6: a register call that OMITS `tech_stack` preserves the
 *     curated value; an explicit value (including '') still wins; a new row
 *     with it omitted stores ''; `archetype` keeps its COALESCE
 *   - TD-365 S7: `igris_project_status` adds `Repo URL:` / `Clone:` AFTER the
 *     lines `/boot` parses, which stay byte-identical
 *   - FR-265 M2: `repo_url` is detected from `git remote get-url origin` only
 *     for a path that is a repo's TOP level, with credentials stripped; an
 *     absent path is never spawned for; an omitted `repo_url` never blanks a
 *     stored one (AC8)
 *   - FR-274 M4: a register upsert leaves the knowledge watermark triple
 *     (`knowledge_sha` / `knowledge_branch` / `knowledge_recorded_at`) unchanged
 *
 * The migration (projects:1) and TD-365 S3 (every NOT NULL no-default column is
 * validated) boot the REAL legacy chain, so they live in `repo-url-v1.test.ts`,
 * which does not mock `db.js`.
 *
 * @module engine/components/projects/__tests__/register.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

// FR-265 M2: a PASS-THROUGH spy on the git spawn, so "a missing path is never
// spawned for" is observable. Every call still runs the real `execFileSync`.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

import { getDb } from '../../../../db.js';
import {
  handleProjectRegister,
  handleProjectStatus,
  sanitizeRepoUrl,
} from '../../../../tools/projects.js';
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
      metadata TEXT DEFAULT '{}',
      repo_url TEXT
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

// ---------------------------------------------------------------------------
// TD-365 — presence is not content: the handler validates what the gateway
// cannot, and a register call that omits a curated column preserves it.
// ---------------------------------------------------------------------------
describe('handleProjectRegister input validation + conflict arm (TD-365)', () => {
  let db: Database.Database;
  const dirs: string[] = [];

  function stageDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), `igris-register-${prefix}-`));
    dirs.push(d);
    return d;
  }

  function row(slug: string): Record<string, unknown> {
    return db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as Record<string, unknown>;
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

  it('S1: a null / empty / whitespace slug, name or path is a Validation error naming the key — no row, no SQLite error', () => {
    const dir = stageDir('s1');
    const good = { slug: 's1-proj', name: 'S1', path: dir };
    const bad: Array<[string, unknown]> = [
      ['name', null], ['name', ''], ['name', '   '],
      ['slug', null], ['slug', ''], ['slug', '\t'],
      ['path', null], ['path', ''], ['path', ' '],
    ];
    for (const [key, value] of bad) {
      let result: { content: { text: string }[] } | undefined;
      expect(
        () => { result = handleProjectRegister({ ...good, [key]: value } as never); },
        `${key}=${JSON.stringify(value)} threw instead of answering in-band`,
      ).not.toThrow();
      expect(text(result!)).toBe(`Validation error: Invalid ${key}: must be a non-empty string.`);
      expect(count(db)).toBe(0);
    }
    // Control: the same call with all three present registers.
    expect(text(handleProjectRegister(good))).toContain('Project registered successfully.');
    expect(count(db)).toBe(1);
  });

  it('S1b: an optional key of the wrong type is refused the same way; null means "omitted"', () => {
    const dir = stageDir('s1b');
    const base = { slug: 's1b', name: 'S1b', path: dir };
    expect(text(handleProjectRegister({ ...base, tech_stack: 42 } as never)))
      .toBe('Validation error: Invalid tech_stack: must be a string when provided.');
    expect(text(handleProjectRegister({ ...base, repo_url: {} } as never)))
      .toBe('Validation error: Invalid repo_url: must be a string when provided.');
    expect(count(db)).toBe(0);
    expect(text(handleProjectRegister({ ...base, tech_stack: null, archetype: null } as never)))
      .toContain('Project registered successfully.');
  });

  it('S2: through the gateway, name:null comes back as in-band text, not a rejection', async () => {
    const dir = stageDir('s2');
    const gateway = createGateway();
    gateway.register(createProjectsComponent().tools());
    const result = (await gateway.dispatch('igris_project_register', {
      slug: 's2-proj',
      name: null,
      path: dir,
    })) as { content: { text: string }[] };
    expect(text(result)).toBe('Validation error: Invalid name: must be a non-empty string.');
    expect(count(db)).toBe(0);
  });

  it('S4: a THREE-argument register does NOT blank a curated tech_stack (before/after read)', () => {
    const dir = stageDir('s4');
    handleProjectRegister({ slug: 's4-proj', name: 'S4', path: dir, tech_stack: 'dart,flutter' });
    expect(row('s4-proj').tech_stack).toBe('dart,flutter');
    handleProjectRegister({ slug: 's4-proj', name: 'S4', path: dir });
    expect(row('s4-proj').tech_stack).toBe('dart,flutter');
  });

  it('S6: explicit values still win (including an explicit clear); a NEW row with tech_stack omitted stores \'\'; archetype keeps its COALESCE', () => {
    const dir = stageDir('s6');
    handleProjectRegister({ slug: 's6', name: 'S6', path: dir, tech_stack: 'dart', archetype: 'design-kit' });
    handleProjectRegister({ slug: 's6', name: 'S6', path: dir, tech_stack: 'go' });
    expect(row('s6').tech_stack).toBe('go');
    expect(row('s6').archetype).toBe('design-kit');
    handleProjectRegister({ slug: 's6', name: 'S6', path: dir, tech_stack: '' });
    expect(row('s6').tech_stack).toBe('');

    const fresh = stageDir('s6-fresh');
    handleProjectRegister({ slug: 's6-fresh', name: 'Fresh', path: fresh });
    expect(row('s6-fresh').tech_stack).toBe('');
    // name and path keep "explicit value wins" (both are required, validated).
    handleProjectRegister({ slug: 's6', name: 'S6 Renamed', path: dir });
    expect(row('s6').name).toBe('S6 Renamed');
  });

  it('S7: igris_project_status appends Repo URL / Clone AFTER the lines /boot parses, which are byte-unchanged', () => {
    db.exec(`
      CREATE TABLE learnings (id INTEGER PRIMARY KEY, project TEXT NOT NULL);
      CREATE TABLE errors (id INTEGER PRIMARY KEY, project TEXT NOT NULL);
      CREATE TABLE agent_events (
        agent TEXT, event_type TEXT, phase TEXT, result TEXT, duration_ms INTEGER,
        brief_id TEXT, round INTEGER, model_requested TEXT, created_at TEXT, project TEXT
      );
    `);
    db.prepare(
      "INSERT INTO projects (slug, name, path, tech_stack, igris_version, registered_at, last_session_at, repo_url) VALUES (?, ?, ?, ?, '7.3.2', '2026-01-01', '2026-01-02', ?)",
    ).run('st', 'Status Proj', '/tmp/with space/st', 'ts', 'https://example.invalid/o/r.git');
    db.prepare(
      "INSERT INTO projects (slug, name, path, tech_stack, igris_version, registered_at) VALUES ('nourl', 'No Url', '/tmp/nourl', '', '7.3.2', '2026-01-01')",
    ).run();

    const lines = handleProjectStatus({ slug: 'st' }).content[0].text.split('\n');
    const at = (label: string): number => lines.findIndex((l) => l.startsWith(label));
    expect(lines[at('Name:')]).toBe('Name: Status Proj');
    expect(lines[at('Path:')]).toBe('Path: /tmp/with space/st');
    expect(lines[at('Tech Stack:')]).toBe('Tech Stack: ts');
    expect(lines[at('Repo URL:')]).toBe('Repo URL: https://example.invalid/o/r.git');
    expect(lines[at('Clone:')]).toBe("Clone: git clone -- 'https://example.invalid/o/r.git' '/tmp/with space/st'");
    expect(at('Repo URL:')).toBeGreaterThan(at('Last Session:'));

    const none = handleProjectStatus({ slug: 'nourl' }).content[0].text.split('\n');
    expect(none).toContain('Repo URL: (none)');
    expect(none.some((l) => l.startsWith('Clone:'))).toBe(false);
    expect(none).toContain('Tech Stack: (none)');
  });
});

// ---------------------------------------------------------------------------
// FR-265 M2 — repo_url detection, sanitisation, and the COALESCE arm (AC2/AC8)
// ---------------------------------------------------------------------------
describe('handleProjectRegister repo_url (FR-265)', () => {
  let db: Database.Database;
  const dirs: string[] = [];
  const spawn = vi.mocked(execFileSync);

  function stageDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), `igris-repourl-${prefix}-`));
    dirs.push(d);
    return d;
  }

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
  }

  function repoUrl(slug: string): unknown {
    return (db.prepare('SELECT repo_url FROM projects WHERE slug = ?').get(slug) as { repo_url: unknown }).repo_url;
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

  it('M2a: a repo with a credentialled origin stores the URL WITHOUT the credentials', () => {
    const repo = stageDir('creds');
    git(repo, 'init', '-q');
    git(repo, 'remote', 'add', 'origin', 'https://u:tok@github.com/o/r.git');
    const result = handleProjectRegister({ slug: 'creds', name: 'Creds', path: repo });
    expect(text(result)).toContain('Project registered successfully.');
    expect(repoUrl('creds')).toBe('https://github.com/o/r.git');
    expect(text(result)).not.toContain('tok');
  });

  it('M2b: a non-git dir, a repo without origin, and a SUB-directory of a repo all store NULL and succeed', () => {
    const plain = stageDir('plain');
    expect(text(handleProjectRegister({ slug: 'plain', name: 'P', path: plain }))).toContain('registered successfully');
    expect(repoUrl('plain')).toBeNull();

    const noOrigin = stageDir('noorigin');
    git(noOrigin, 'init', '-q');
    expect(text(handleProjectRegister({ slug: 'noorigin', name: 'N', path: noOrigin }))).toContain('registered successfully');
    expect(repoUrl('noorigin')).toBeNull();

    const top = stageDir('top');
    git(top, 'init', '-q');
    git(top, 'remote', 'add', 'origin', 'https://github.com/o/top.git');
    const sub = join(top, 'packages', 'sub');
    mkdirSync(sub, { recursive: true });
    // A clone of the origin would not recover `sub` at its registered path.
    expect(text(handleProjectRegister({ slug: 'sub', name: 'Sub', path: sub }))).toContain('registered successfully');
    expect(repoUrl('sub')).toBeNull();
  });

  it('M2c: a path that does not exist is registered with NULL and NO git spawn', () => {
    const missing = join(tmpdir(), 'igris-repourl-does-not-exist-xyzzy');
    spawn.mockClear();
    const result = handleProjectRegister({ slug: 'ghost-url', name: 'Ghost', path: missing });
    expect(text(result)).toContain('Project registered successfully.');
    expect(repoUrl('ghost-url')).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('M2d: an explicit repo_url wins over the detected one, and is sanitised too', () => {
    const repo = stageDir('explicit');
    git(repo, 'init', '-q');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/o/detected.git');
    handleProjectRegister({ slug: 'explicit', name: 'E', path: repo, repo_url: 'https://x:secret@gitlab.example/o/explicit.git' });
    expect(repoUrl('explicit')).toBe('https://gitlab.example/o/explicit.git');
  });

  it('M2e (AC8): an OMITTED repo_url never blanks a stored one on re-register', () => {
    const dir = stageDir('keep');
    handleProjectRegister({ slug: 'keep', name: 'K', path: dir, repo_url: 'https://github.com/o/keep.git' });
    expect(repoUrl('keep')).toBe('https://github.com/o/keep.git');
    // A non-git path: detection yields nothing, the call omits repo_url.
    handleProjectRegister({ slug: 'keep', name: 'K', path: dir });
    expect(repoUrl('keep')).toBe('https://github.com/o/keep.git');
    // ...and a path that is gone (the source-reclaimed case) keeps it as well,
    // and the missing-path warning names the class doctor will actually report.
    const gone = handleProjectRegister({ slug: 'keep', name: 'K', path: join(dir, 'gone') });
    expect(repoUrl('keep')).toBe('https://github.com/o/keep.git');
    expect(text(gone)).toContain('reports this as source-reclaimed');
  });

  it('M2f: sanitizeRepoUrl vectors', () => {
    expect(sanitizeRepoUrl('https://user:tok@host/o/r.git')).toBe('https://host/o/r.git');
    expect(sanitizeRepoUrl('https://ghp_token@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(sanitizeRepoUrl('http://tok@host/o/r')).toBe('http://host/o/r');
    // ssh:// — a USER is not a credential and the clone needs it; a password is.
    expect(sanitizeRepoUrl('ssh://git@host/o/r.git')).toBe('ssh://git@host/o/r.git');
    expect(sanitizeRepoUrl('ssh://git:pw@host:2222/o/r.git')).toBe('ssh://git@host:2222/o/r.git');
    expect(sanitizeRepoUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    expect(sanitizeRepoUrl('/srv/git/r.git')).toBe('/srv/git/r.git');
    expect(sanitizeRepoUrl('  https://host/o/r.git \n')).toBe('https://host/o/r.git');
    expect(sanitizeRepoUrl('   ')).toBeNull();
    expect(sanitizeRepoUrl('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FR-274 M4 — a register upsert never touches the knowledge watermark triple.
// Its own DB carries the three projects:2 columns; the register conflict arm
// must leave a recorded watermark exactly as it was.
// ---------------------------------------------------------------------------
describe('handleProjectRegister leaves the knowledge watermark alone (FR-274 M4)', () => {
  let db: Database.Database;
  const dirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    db.exec(`
      ALTER TABLE projects ADD COLUMN knowledge_sha TEXT;
      ALTER TABLE projects ADD COLUMN knowledge_branch TEXT;
      ALTER TABLE projects ADD COLUMN knowledge_recorded_at TEXT;
    `);
    mockedGetDb.mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    while (dirs.length) {
      try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function triple(slug: string): unknown {
    return db.prepare('SELECT knowledge_sha, knowledge_branch, knowledge_recorded_at FROM projects WHERE slug = ?').get(slug);
  }

  it('a same-slug re-register (the /boot refresh) leaves all three watermark columns unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igris-register-wm-'));
    dirs.push(dir);
    handleProjectRegister({ slug: 'wm', name: 'WM', path: dir });
    db.prepare("UPDATE projects SET knowledge_sha = ?, knowledge_branch = 'main', knowledge_recorded_at = '2026-09-29 10:00:00' WHERE slug = 'wm'")
      .run('b'.repeat(40));
    const before = triple('wm');
    expect(before).toEqual({ knowledge_sha: 'b'.repeat(40), knowledge_branch: 'main', knowledge_recorded_at: '2026-09-29 10:00:00' });

    expect(text(handleProjectRegister({ slug: 'wm', name: 'WM Renamed', path: dir, tech_stack: 'ts' }))).toContain('Project registered successfully.');
    expect(triple('wm')).toEqual(before);
    // The upsert DID apply — the pin is not vacuous.
    expect((db.prepare("SELECT name FROM projects WHERE slug = 'wm'").get() as { name: string }).name).toBe('WM Renamed');
  });
});
