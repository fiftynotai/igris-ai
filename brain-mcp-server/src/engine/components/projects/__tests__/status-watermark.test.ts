/**
 * FR-274 — `igris_project_status` renders the knowledge watermark, and
 * `checkKnowledgeWatermark` gives a LOCAL reachability verdict (plan §4.2
 * S1–S10, D5).
 *
 *   - S1 a watermark on `feature/wm` renders `Knowledge as of:` with the
 *     12-char short SHA, the branch and the recorded time;
 *   - S2 the `Since:` line carries the FULL SHA and `origin/feature/wm` (M12);
 *   - S3 a detached watermark renders `(detached HEAD …)` and `origin/HEAD`;
 *     S3b a detached watermark is never DIVERGED, even when origin/HEAD is
 *     present and the SHA is not its ancestor (D5); S3c a `~/`-relative row
 *     path is expanded against HOME before the check (D4.5);
 *   - S4 NULL columns render `no watermark recorded` (the AC7 fixture: a
 *     hadir-system-shaped row — path missing, `repo_url` set);
 *   - S5 a pre-v2 DB (no columns) does not throw and renders the same;
 *   - S6 a history rewrite + a fresh clone at the row path → UNREACHABLE (AC5, M7);
 *   - S7 the old clone after a fetch of the force-pushed branch → DIVERGED;
 *     S7b a watermark AHEAD of origin/<branch> (committed, never pushed — the
 *     normal state at session end) is reachable with an "ahead … not pushed"
 *     note, never DIVERGED (warden B1);
 *   - S8b a stored value that is not a full hex SHA is refused before ANY git
 *     spawn and never reaches a printed command line (option injection once
 *     FR-271 replicates the column);
 *   - S8 a missing path → `not verified` + a `Verify:` line, and NO git spawn;
 *   - S9 a branch named `it's-wm`: the printed `Since:` line, run with `sh -c`
 *     inside the clone, succeeds (M8);
 *   - S10 every line up to and including `Clone:` is byte-identical to the
 *     pre-FR-274 render (the `/boot` §4.3 parse contract);
 *   - plus the exported helpers directly: the `origin/<branch>`-absent note, a
 *     nested directory is `absent`, and an inherited GIT_DIR / GIT_WORK_TREE
 *     cannot redirect the check (M9, brain side).
 *
 * Every git fixture is a real repository under `mkdtemp`; git runs with a
 * scratch `GIT_CONFIG_GLOBAL` (identity + `init.defaultBranch=main`), no system
 * config and every inherited `GIT_*` location variable stripped. The DB is an
 * in-memory fixture behind the mocked `getDb` (the register.test.ts idiom);
 * nothing here opens `~/.igris/memory/knowledge.db`.
 *
 * @module engine/components/projects/__tests__/status-watermark.test
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

// A PASS-THROUGH spy on the git spawn, so "a missing path is never spawned
// for" (S8) is observable. Every call still runs the real `execFileSync`.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

import { getDb } from '../../../../db.js';
import {
  handleProjectStatus,
  checkKnowledgeWatermark,
  renderKnowledgeWatermark,
} from '../../../../tools/projects.js';

const mockedGetDb = vi.mocked(getDb);
const spawn = vi.mocked(execFileSync);

const PROJECTS_BASE = `
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
  repo_url TEXT`;

const SIDE_TABLES = `
  CREATE TABLE learnings (id INTEGER PRIMARY KEY, project TEXT NOT NULL);
  CREATE TABLE errors (id INTEGER PRIMARY KEY, project TEXT NOT NULL);
  CREATE TABLE agent_events (
    agent TEXT, event_type TEXT, phase TEXT, result TEXT, duration_ms INTEGER,
    brief_id TEXT, round INTEGER, model_requested TEXT, created_at TEXT, project TEXT
  );`;

function makeDb(withWatermark: boolean): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE projects (${PROJECTS_BASE}${withWatermark
    ? ',\n  knowledge_sha TEXT,\n  knowledge_branch TEXT,\n  knowledge_recorded_at TEXT'
    : ''}\n);${SIDE_TABLES}`);
  return db;
}

// --- git fixture plumbing ---------------------------------------------------

let root: string;
let gitConfig: string;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']) delete env[k];
  return env;
}

/** Run git in `cwd` (fixture side — not the code under test). */
function git(cwd: string, ...args: string[]): string {
  return String(execFileSync('git', args, { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] })).trim();
}

function dir(name: string): string {
  const d = join(root, name);
  execFileSync('mkdir', ['-p', d]);
  return d;
}

function commit(repo: string, msg: string): string {
  writeFileSync(join(repo, `${msg.replace(/\W/g, '_')}.txt`), msg);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

/** `normal`: two commits, checked out on the non-default `feature/wm`. */
function normalRepo(name: string): { path: string; sha: string } {
  const path = dir(name);
  git(path, 'init', '-q');
  commit(path, 'one');
  git(path, 'checkout', '-q', '-b', 'feature/wm');
  const sha = commit(path, 'two');
  return { path, sha };
}

/** A bare remote with `main` pushed from clone A; returns both plus A's HEAD. */
function remoteAndClone(name: string): { bare: string; a: string; sha: string } {
  const bare = dir(`${name}-remote.git`);
  git(bare, 'init', '-q', '--bare');
  const a = join(root, `${name}-A`);
  git(root, 'clone', '-q', bare, a);
  commit(a, 'base');
  const sha = commit(a, 'watermarked');
  git(a, 'push', '-q', 'origin', 'main');
  return { bare, a, sha };
}

/** Rewrite `main` on the remote so `sha` is no longer reachable from it. */
function rewrite(a: string): void {
  git(a, 'commit', '-q', '--amend', '-m', 'rewritten');
  git(a, 'push', '-q', '--force', 'origin', 'main');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fr274-status-'));
  gitConfig = join(root, 'gitconfig');
  writeFileSync(gitConfig, '[user]\n\tname = fr274\n\temail = fr274@igris.invalid\n[init]\n\tdefaultBranch = main\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// --- DB plumbing --------------------------------------------------------------

let db: Database.Database;

function seed(slug: string, path: string, wm: { sha?: string | null; branch?: string | null; at?: string | null } = {}, repoUrl: string | null = null): void {
  db.prepare(
    `INSERT INTO projects (slug, name, path, tech_stack, igris_version, registered_at, last_session_at, repo_url, knowledge_sha, knowledge_branch, knowledge_recorded_at)
     VALUES (?, ?, ?, 'ts', '7.3.2', '2026-01-01', '2026-01-02', ?, ?, ?, ?)`,
  ).run(slug, `Name ${slug}`, path, repoUrl, wm.sha ?? null, wm.branch ?? null, wm.at ?? null);
}

function statusLines(slug: string): string[] {
  return handleProjectStatus({ slug }).content[0].text.split('\n');
}

function line(lines: string[], label: string): string | undefined {
  return lines.find((l) => l.startsWith(label));
}

beforeEach(() => {
  vi.clearAllMocks();
  db = makeDb(true);
  mockedGetDb.mockReturnValue(db as unknown as ReturnType<typeof getDb>);
});

afterEach(() => {
  db.close();
});

describe('igris_project_status — the knowledge watermark lines (FR-274)', () => {
  it('S1: a watermark on feature/wm renders the 12-char short SHA, the branch and the recorded time', () => {
    const { path, sha } = normalRepo('s1');
    seed('s1', path, { sha, branch: 'feature/wm', at: '2026-09-29 10:00:00' });
    const lines = statusLines('s1');
    expect(line(lines, 'Knowledge as of:')).toBe(`Knowledge as of: ${sha.slice(0, 12)} on feature/wm, 2026-09-29 10:00:00 UTC`);
    expect(sha).toHaveLength(40);
  });

  it('S2: the Since: line carries the FULL SHA and origin/feature/wm (M12)', () => {
    const { path, sha } = normalRepo('s2');
    seed('s2', path, { sha, branch: 'feature/wm', at: '2026-09-29 10:00:00' });
    expect(line(statusLines('s2'), 'Since:')).toBe(`Since: git log --oneline '${sha}..origin/feature/wm'`);
  });

  it('S3: a detached watermark renders (detached HEAD …) and origin/HEAD', () => {
    const { path } = normalRepo('s3');
    git(path, 'checkout', '-q', '--detach', 'HEAD~1');
    const sha = git(path, 'rev-parse', 'HEAD');
    seed('s3', path, { sha, branch: null, at: '2026-09-29 10:00:00' });
    const lines = statusLines('s3');
    expect(line(lines, 'Knowledge as of:')).toBe(`Knowledge as of: ${sha.slice(0, 12)} (detached HEAD, no branch recorded), 2026-09-29 10:00:00 UTC`);
    expect(line(lines, 'Since:')).toBe(`Since: git log --oneline '${sha}..origin/HEAD'`);
  });

  it('S3b (D5): a detached watermark is never DIVERGED — origin/HEAD present, the SHA not its ancestor, still reachable', () => {
    const { bare } = remoteAndClone('s3b');
    const b = join(root, 's3b-B');
    git(root, 'clone', '-q', bare, b); // a clone of a non-empty remote carries origin/HEAD
    expect(git(b, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/HEAD^{commit}')).toMatch(/^[0-9a-f]{40}$/);
    git(b, 'checkout', '-q', '--detach');
    const sha = commit(b, 'local-only'); // not pushed: NOT an ancestor of origin/HEAD
    expect(() => git(b, 'merge-base', '--is-ancestor', sha, 'refs/remotes/origin/HEAD')).toThrow();
    seed('s3b', b, { sha, branch: null, at: '2026-09-29 10:00:00' });
    expect(line(statusLines('s3b'), 'Knowledge check:')).toBe(`Knowledge check: reachable in ${b}`);
  });

  it('S3c (D4.5): a ~/-relative row path is expanded against HOME before the check', () => {
    const home = dir('s3c-home');
    const { sha } = normalRepo('s3c-home/wmrepo');
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      seed('s3c', '~/wmrepo', { sha, branch: 'feature/wm', at: '2026-09-29 10:00:00' });
      expect(line(statusLines('s3c'), 'Knowledge check:')).toBe(
        `Knowledge check: reachable in ${join(home, 'wmrepo')} (origin/feature/wm is not in this clone: run git fetch origin 'feature/wm' first)`,
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
  });

  it('S4 (AC7): NULL watermark columns render "no watermark recorded" — a hadir-system-shaped row, path missing, repo_url set', () => {
    const missing = join(root, 'hadir-system-gone');
    seed('hadir-system', missing, {}, 'https://github.com/o/hadir-system.git');
    spawn.mockClear();
    let lines: string[] = [];
    expect(() => { lines = statusLines('hadir-system'); }).not.toThrow();
    expect(lines).toContain('Knowledge as of: no watermark recorded');
    expect(line(lines, 'Clone:')).toBe(`Clone: git clone -- 'https://github.com/o/hadir-system.git' '${missing}'`);
    expect(line(lines, 'Since:')).toBeUndefined();
    expect(line(lines, 'Knowledge check:')).toBeUndefined();
    expect(line(lines, 'Verify:')).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled(); // no watermark → nothing to check
  });

  it('S5: a pre-v2 DB (no watermark columns) does not throw and renders "no watermark recorded"', () => {
    db.close();
    db = makeDb(false);
    mockedGetDb.mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    db.prepare("INSERT INTO projects (slug, name, path, registered_at) VALUES ('old', 'Old', '/tmp/old', '2026-01-01')").run();
    let lines: string[] = [];
    expect(() => { lines = statusLines('old'); }).not.toThrow();
    expect(lines).toContain('Knowledge as of: no watermark recorded');
  });

  it('S6 (AC5): after a history rewrite, a fresh clone at the row path reports UNREACHABLE … knowledge unverified (M7)', () => {
    const { bare, a, sha } = remoteAndClone('s6');
    rewrite(a);
    // A fresh clone over the git transport (NOT a local hardlink clone, which
    // would copy the now-unreferenced object too) lacks the watermark SHA.
    const b = join(root, 's6-B');
    git(root, 'clone', '-q', `file://${bare}`, b);
    seed('s6', b, { sha, branch: 'main', at: '2026-09-29 10:00:00' });
    const check = line(statusLines('s6'), 'Knowledge check:');
    expect(check).toBe(`Knowledge check: UNREACHABLE: ${sha.slice(0, 12)} is not in the clone at ${b} (history rewritten, a shallow clone, or the commit was never pushed); knowledge unverified`);
    // The control: the same clone reports reachable for its own HEAD.
    expect(checkKnowledgeWatermark(b, git(b, 'rev-parse', 'HEAD'), 'main').state).toBe('reachable');
  });

  it('S7: the old clone after fetching the force-pushed branch reports DIVERGED', () => {
    const { a, sha } = remoteAndClone('s7');
    // Rewrite from a SECOND clone so A keeps the old commit, then fetch into A.
    const c = join(root, 's7-C');
    git(root, 'clone', '-q', join(root, 's7-remote.git'), c);
    rewrite(c);
    git(a, 'fetch', '-q', 'origin');
    seed('s7', a, { sha, branch: 'main', at: '2026-09-29 10:00:00' });
    expect(line(statusLines('s7'), 'Knowledge check:')).toBe(
      `Knowledge check: DIVERGED: ${sha.slice(0, 12)} and origin/main have forked: neither contains the other (history rewritten, or the branch moved on a different line); knowledge unverified`,
    );
  });

  it('S7b: a watermark AHEAD of origin/<branch> (unpushed) is reachable with an ahead note, never DIVERGED', () => {
    const { a } = remoteAndClone('s7b');
    git(a, 'fetch', '-q', 'origin');
    const sha = commit(a, 'unpushed'); // on main, one commit ahead of origin/main, never pushed
    expect(() => git(a, 'merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main')).toThrow(); // the B1 shape
    seed('s7b', a, { sha, branch: 'main', at: '2026-09-29 10:00:00' });
    expect(line(statusLines('s7b'), 'Knowledge check:')).toBe(
      `Knowledge check: reachable in ${a} (ahead of origin/main: not pushed; a fresh clone will not contain ${sha.slice(0, 12)} until it is pushed)`,
    );
    expect(checkKnowledgeWatermark(a, sha, 'main')).toEqual({ state: 'reachable', path: a, remoteRefPresent: true, aheadOfRemote: true });
  });

  it('S8: a missing path → not verified + a Verify: line, and NO git spawn', () => {
    const missing = join(root, 's8-gone');
    const sha = 'a'.repeat(40);
    seed('s8', missing, { sha, branch: 'main', at: '2026-09-29 10:00:00' });
    spawn.mockClear();
    const lines = statusLines('s8');
    expect(line(lines, 'Knowledge check:')).toBe(`Knowledge check: not verified: no git working copy at ${missing}`);
    expect(line(lines, 'Verify:')).toBe(`Verify: git cat-file -e '${sha}^{commit}'`);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('S8b: a stored value that is not a full hex SHA is refused before any git spawn and prints no command', () => {
    const { path } = normalRepo('s8b');
    for (const bad of ['--output=/tmp/x', 'HEAD', 'a'.repeat(39), 'A'.repeat(40), `${'a'.repeat(40)} `]) {
      spawn.mockClear();
      expect(checkKnowledgeWatermark(path, bad, 'main')).toEqual({ state: 'invalid', path, remoteRefPresent: null, aheadOfRemote: false });
      expect(spawn).not.toHaveBeenCalled();
    }
    // A branch that would read as an option in the printed fetch hint is refused the same way.
    spawn.mockClear();
    expect(checkKnowledgeWatermark(path, 'a'.repeat(40), '--upload-pack=x').state).toBe('invalid');
    expect(spawn).not.toHaveBeenCalled();
    // G1: an EMPTY branch is not "detached" (that is NULL) — it is refused the same way.
    expect(checkKnowledgeWatermark(path, 'a'.repeat(40), '').state).toBe('invalid');
    expect(spawn).not.toHaveBeenCalled();
    db.prepare('DELETE FROM projects').run();
    seed('s8b', path, { sha: '--output=/tmp/x', branch: 'main', at: '2026-09-29 10:00:00' });
    spawn.mockClear();
    const lines = statusLines('s8b');
    expect(spawn).not.toHaveBeenCalled();
    expect(line(lines, 'Knowledge as of:')).toBe('Knowledge as of: invalid watermark recorded (not a full commit SHA), 2026-09-29 10:00:00 UTC');
    expect(line(lines, 'Knowledge check:')).toBe('Knowledge check: not verified: the recorded watermark is not a full commit SHA');
    expect(line(lines, 'Since:')).toBeUndefined();
    expect(line(lines, 'Verify:')).toBeUndefined();
    expect(lines.join('\n')).not.toContain('--output');
  });

  it('S9: a branch named it\'s-wm — the printed Since: line runs with sh -c inside the clone (M8)', () => {
    const { a } = remoteAndClone('s9');
    git(a, 'checkout', '-q', '-b', "it's-wm");
    const sha = commit(a, 'quoted-one');
    commit(a, 'quoted-two');
    git(a, 'push', '-q', '-u', 'origin', "it's-wm");
    seed('s9', a, { sha, branch: "it's-wm", at: '2026-09-29 10:00:00' });
    const lines = statusLines('s9');
    const since = line(lines, 'Since:')!;
    expect(since).toBeDefined();
    const cmd = since.slice('Since: '.length);
    const out = String(execFileSync('sh', ['-c', cmd], { cwd: a, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    expect(out.split('\n')).toHaveLength(1); // exactly the one commit after the watermark
    expect(out).toContain('quoted-two');
    expect(line(lines, 'Knowledge check:')).toBe(`Knowledge check: reachable in ${a}`);
  });

  it('S10: every line up to and including Clone: is byte-identical to the pre-FR-274 render; the watermark follows it', () => {
    const { path, sha } = normalRepo('s10');
    seed('s10', path, { sha, branch: 'feature/wm', at: '2026-09-29 10:00:00' }, 'https://example.invalid/o/r.git');
    const lines = statusLines('s10');
    const clone = lines.findIndex((l) => l.startsWith('Clone:'));
    expect(lines.slice(0, clone + 1)).toEqual([
      '# Project Status: s10',
      '',
      '## Project Info',
      'Name: Name s10',
      `Path: ${path}`,
      'Tech Stack: ts',
      'Status: active',
      'Igris Version: 7.3.2',
      'Registered: 2026-01-01',
      'Last Session: 2026-01-02',
      'Repo URL: https://example.invalid/o/r.git',
      `Clone: git clone -- 'https://example.invalid/o/r.git' '${path}'`,
    ]);
    expect(lines[clone + 1].startsWith('Knowledge as of:')).toBe(true);
    expect(lines.slice(clone + 1).findIndex((l) => l === '## Knowledge Base')).toBeGreaterThan(0);
  });
});

describe('checkKnowledgeWatermark / renderKnowledgeWatermark — exported for FR-273', () => {
  it('a reachable watermark whose clone lacks origin/<branch> says so and names the fetch', () => {
    const { path, sha } = normalRepo('r1');
    const check = checkKnowledgeWatermark(path, sha, 'feature/wm');
    expect(check).toEqual({ state: 'reachable', path, remoteRefPresent: false, aheadOfRemote: false });
    const lines = renderKnowledgeWatermark({ path, knowledge_sha: sha, knowledge_branch: 'feature/wm', knowledge_recorded_at: 't' }, check);
    expect(lines.find((l) => l.startsWith('Knowledge check:')))
      .toBe(`Knowledge check: reachable in ${path} (origin/feature/wm is not in this clone: run git fetch origin 'feature/wm' first)`);
    expect(lines).toHaveLength(3); // no Verify: line outside the absent state
  });

  it('a nested directory (not a repo top level) is absent, never the parent repo', () => {
    const { sha } = normalRepo('r2');
    const nested = dir('r2/sub/deeper');
    expect(checkKnowledgeWatermark(nested, sha, 'feature/wm').state).toBe('absent');
  });

  it('an inherited GIT_DIR / GIT_WORK_TREE does not redirect the check (M9, brain side)', () => {
    const { path, sha } = normalRepo('r3');
    const other = normalRepo('r3-other');
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(other.path, '.git');
    process.env.GIT_WORK_TREE = other.path;
    try {
      expect(checkKnowledgeWatermark(path, sha, 'feature/wm').state).toBe('reachable');
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.tree;
    }
  });

  it('no watermark renders exactly one line whatever the check', () => {
    expect(renderKnowledgeWatermark({ path: '/x', knowledge_sha: null, knowledge_branch: null, knowledge_recorded_at: null }, null))
      .toEqual(['Knowledge as of: no watermark recorded']);
  });
});
