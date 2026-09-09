/**
 * TD-414 — the brief-file projection is GUARDED, and there is one writer.
 *
 * The cache component is bound to BOTH `brief.created` and `brief.synced`, and
 * `igris_brief_sync` (a STATUS call /hunt makes at every phase transition)
 * emits `brief.synced`. At HEAD the listener did an unconditional
 * `writeFileSync` of `brief_files.content` over
 * `~/.igris/projects/{project}/briefs/{ID}.md` — so a status sync re-materialised
 * the disk file from the brain and destroyed every local edit (measured twice on
 * BR-095: 8 ticked criteria → 0, 12324 → 7872 bytes).
 *
 * The fix is in the ONE writer, `cache/handlers.ts`: a classifier
 * `diskEditState` → 'absent' | 'same' | 'local-newer' | 'brain-newer', and a
 * projection that writes only on 'absent' / 'brain-newer'. 'same' short-circuits
 * before any write (the file's mtime stops bumping on every status sync);
 * 'local-newer' is REFUSED and surfaced as a `warn`. `igris_cache_rebuild`
 * reuses the same guarded writer and gains the ONLY override, `force`.
 *
 * Why the comparison is mtime vs `brief_files.updated_at`: all three brain
 * writers stamp `updated_at` in the same `YYYY-MM-DD HH:MM:SS` UTC shape and the
 * DDL default matches; an unparseable stamp reads NaN and is treated as
 * 'local-newer' (refuse bias — never clobber on an unknown). A local edit in the
 * same wall-clock second as a brain write reads local-newer because the DB stamp
 * is floored to the second: the safe direction, and `force` recovers.
 *
 * Fixture idiom: the projection root is call-time `cacheRoot()` honouring
 * `IGRIS_BRAIN_DIR` (the documented sandbox seam — MAINTAINING row 134). This
 * file ALSO fences `HOME` (hoisted, before any import; restored in `afterAll`)
 * and sets `IGRIS_BRAIN_DIR = $HOME/.igris`, so the seam root and the
 * pre-TD-414 `os.homedir()` root are the SAME path. That coincidence is what
 * makes T1/T2/T4 red at HEAD for the right reason (the clobber) rather than
 * vacuously green because the old writer landed somewhere the test never read
 * — the first RED run showed exactly that, with HEAD writing under `$HOME`
 * while the test read its mkdtemp. T7 proves the seam is honoured with a
 * DISTINCT directory. Nothing here touches the real `~/.igris` in either
 * world. mtime DIRECTION is always set explicitly with `utimesSync`; no case
 * relies on the wall-clock ordering of two writes inside one test (same-second
 * granularity would make T3 flaky).
 *
 * RED-first record (HEAD a3d8a4a): T1, T2, T4, T6, T7, T9 and the four
 * classifier cases red; T3, T5, T8 green (the over-refusal and scope controls).
 *
 * Mocked at the I/O boundary (`getDb`), like `tools/__tests__/ac-gate-note.test.ts`.
 *
 * @module engine/components/cache/__tests__/projection-guard
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Fence HOME before ANY module loads: the pre-TD-414 writer resolved its root
// from os.homedir() at module load, so a fence set later could not reach it.
const { FAKE_HOME, REAL_HOME } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const REAL_HOME = process.env.HOME;
  const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'td414-home-'));
  process.env.HOME = FAKE_HOME;
  return { FAKE_HOME, REAL_HOME };
});

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

import { getDb } from '../../../../db.js';
import { createEventBus } from '../../../bus.js';
import type { ComponentContext, EventBus } from '../../../types.js';
import { createCacheComponent } from '../index.js';
import { cacheRoot, diskEditState, handleCacheRebuild } from '../handlers.js';

const mockedGetDb = vi.mocked(getDb);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const UNTICKED = [
  '# TD-900: a brief with open criteria',
  '',
  '## Acceptance Criteria',
  '- [ ] the first criterion is not met',
  '- [ ] the second one is not met either',
  '',
].join('\n');

const TICKED = UNTICKED.replace(/- \[ \]/g, '- [x]');

/** A stamp in the shape all three brain writers use (UTC, floored to the second). */
const BRAIN_STAMP = '2026-09-01 10:00:00';
/** One hour BEFORE the brain stamp — the disk side of a legitimate refresh. */
const OLDER_MTIME = new Date('2026-09-01T09:00:00Z');

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE brief_files (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
    CREATE TABLE session_files (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, filename)
    );
  `);
  return db;
}

function seedFile(db: Database.Database, briefId: string, content: string, updatedAt: string): void {
  db.prepare(
    `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
     VALUES (?, 'p', ?, ?, ?, 'h', ?)`,
  ).run(`f-${briefId}`, briefId, `${briefId}.md`, content, updatedAt);
}

function seedSession(db: Database.Database, filename: string, content: string): void {
  db.prepare(
    `INSERT INTO session_files (id, project, filename, content) VALUES (?, 'p', ?, ?)`,
  ).run(`s-${filename}`, filename, content);
}

/** Write a disk file and, when given, pin its mtime explicitly. */
function putDisk(path: string, text: string, mtime?: Date): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf-8');
  if (mtime) utimesSync(path, mtime, mtime);
}

interface RecordingLog {
  info: string[];
  warn: string[];
  error: string[];
}

function makeCtx(bus: EventBus, log: RecordingLog): ComponentContext {
  return {
    storage: {} as unknown as ComponentContext['storage'],
    bus,
    log: {
      info: (m: string) => { log.info.push(m); },
      warn: (m: string) => { log.warn.push(m); },
      error: (m: string) => { log.error.push(m); },
    },
    config: {},
  };
}

describe('TD-414 — brief-file projection guard (one writer, classified)', () => {
  let db: Database.Database;
  let bus: EventBus;
  let log: RecordingLog;
  let root: string;
  let briefPath: string;
  let sessionPath: string;
  let comp: ReturnType<typeof createCacheComponent>;
  const savedBrainDir = process.env.IGRIS_BRAIN_DIR;

  afterAll(() => {
    if (REAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = REAL_HOME;
    rmSync(FAKE_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // The fence must be ARMED or every write below lands in the real ~/.igris.
    expect(homedir()).toBe(FAKE_HOME);
    root = join(FAKE_HOME, '.igris');
    rmSync(join(root, 'projects'), { recursive: true, force: true });
    process.env.IGRIS_BRAIN_DIR = root;
    briefPath = join(root, 'projects', 'p', 'briefs', 'TD-900.md');
    sessionPath = join(root, 'projects', 'p', 'session', 'CURRENT_SESSION.md');
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    bus = createEventBus();
    log = { info: [], warn: [], error: [] };
    comp = createCacheComponent();
    comp.init(makeCtx(bus, log));
  });

  afterEach(() => {
    comp.destroy();
    db.close();
    rmSync(join(root, 'projects'), { recursive: true, force: true });
    if (savedBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
    else process.env.IGRIS_BRAIN_DIR = savedBrainDir;
  });

  // The seam is proved with a DISTINCT directory (the fixture's root coincides
  // with $HOME/.igris on purpose, so equality there would not tell the seam
  // apart from the fallback). The fallback is asserted by string only.
  it('T7 — cacheRoot() is call-time and honours IGRIS_BRAIN_DIR; the fallback is ~/.igris/projects (string only)', () => {
    const other = mkdtempSync(join(tmpdir(), 'td414-seam-'));
    try {
      process.env.IGRIS_BRAIN_DIR = other;
      expect(cacheRoot()).toBe(join(other, 'projects'));
      expect(cacheRoot()).not.toBe(join(homedir(), '.igris', 'projects'));
      delete process.env.IGRIS_BRAIN_DIR;
      expect(cacheRoot()).toBe(join(homedir(), '.igris', 'projects'));
      process.env.IGRIS_BRAIN_DIR = '';
      expect(cacheRoot()).toBe(join(homedir(), '.igris', 'projects'));
    } finally {
      process.env.IGRIS_BRAIN_DIR = root;
      rmSync(other, { recursive: true, force: true });
    }
  });

  // AC-1: a status sync must not destroy the ticks on disk.
  it('T1 — brief.synced keeps a local file that is newer than the brain copy', () => {
    seedFile(db, 'TD-900', UNTICKED, BRAIN_STAMP);
    putDisk(briefPath, TICKED); // mtime = now, which is after BRAIN_STAMP
    expect(statSync(briefPath).mtimeMs).toBeGreaterThan(Date.parse('2026-09-01T10:00:00Z'));

    bus.emit('brief.synced', { project: 'p', brief_id: 'TD-900' });

    expect(readFileSync(briefPath, 'utf-8')).toBe(TICKED);
    expect(log.error).toEqual([]);
  });

  // AC-5: the twin binding. brief.created fires from brief_sync when the status
  // row is NEW but a brief_files row already exists (briefs/index.ts:123).
  it('T2 — brief.created keeps a local file that is newer than the brain copy', () => {
    seedFile(db, 'TD-900', UNTICKED, BRAIN_STAMP);
    putDisk(briefPath, TICKED);

    bus.emit('brief.created', { project: 'p', brief_id: 'TD-900', title: 't' });

    expect(readFileSync(briefPath, 'utf-8')).toBe(TICKED);
    expect(log.error).toEqual([]);
  });

  // The over-refusal control: a genuinely stale disk copy is still refreshed.
  it('T3 — an OLDER, different disk file is overwritten by the brain copy', () => {
    seedFile(db, 'TD-900', UNTICKED, BRAIN_STAMP);
    putDisk(briefPath, '# stale local copy\n', OLDER_MTIME);
    expect(statSync(briefPath).mtimeMs).toBe(OLDER_MTIME.getTime());

    bus.emit('brief.synced', { project: 'p', brief_id: 'TD-900' });

    expect(readFileSync(briefPath, 'utf-8')).toBe(UNTICKED);
    expect(log.warn).toEqual([]);
  });

  // The 'same' short-circuit: identical content is not rewritten, so the mtime
  // does not bump on every status sync (the brief's "only that brief's mtime
  // changed" symptom).
  it('T4 — identical content is not rewritten (mtime unchanged)', () => {
    seedFile(db, 'TD-900', UNTICKED, BRAIN_STAMP);
    putDisk(briefPath, UNTICKED, OLDER_MTIME);
    const before = statSync(briefPath).mtimeMs;
    expect(before).toBe(OLDER_MTIME.getTime());

    bus.emit('brief.synced', { project: 'p', brief_id: 'TD-900' });

    expect(statSync(briefPath).mtimeMs).toBe(before);
    expect(readFileSync(briefPath, 'utf-8')).toBe(UNTICKED);
  });

  it('T5 — an absent disk file is written from the brain copy', () => {
    seedFile(db, 'TD-900', UNTICKED, BRAIN_STAMP);
    expect(existsSync(briefPath)).toBe(false);

    bus.emit('brief.synced', { project: 'p', brief_id: 'TD-900' });

    expect(readFileSync(briefPath, 'utf-8')).toBe(UNTICKED);
  });

  // The explicit override lives on the rebuild tool, and ONLY there.
  it('T6 — igris_cache_rebuild refuses local-newer and reports it; force overwrites', () => {
    seedFile(db, 'TD-900', UNTICKED, BRAIN_STAMP);
    putDisk(briefPath, TICKED);

    const kept = handleCacheRebuild({ project: 'p', scope: 'briefs' });
    expect(kept.isError).toBeFalsy();
    expect(readFileSync(briefPath, 'utf-8')).toBe(TICKED);
    expect(JSON.parse(kept.content[0].text)).toMatchObject({ briefs_cached: 0, briefs_skipped: 1 });

    const forced = handleCacheRebuild({ project: 'p', scope: 'briefs', force: true });
    expect(forced.isError).toBeFalsy();
    expect(readFileSync(briefPath, 'utf-8')).toBe(UNTICKED);
    expect(JSON.parse(forced.content[0].text)).toMatchObject({ briefs_cached: 1, briefs_skipped: 0 });
  });

  // Scope pin: SESSION files are deliberately OUT of scope. Their two-copy
  // question belongs to the session bundle (TD-360/410/411); a brief that moves
  // them under the guard must flip this test on purpose.
  it('T8 — session.file.updated still overwrites a newer, different session file', () => {
    seedSession(db, 'CURRENT_SESSION.md', '# from brain\n');
    putDisk(sessionPath, '# local edit\n');

    bus.emit('session.file.updated', { project: 'p', filename: 'CURRENT_SESSION.md' });

    expect(readFileSync(sessionPath, 'utf-8')).toBe('# from brain\n');
  });

  // TD-447: a new state the classifier can return must be OBSERVABLE. The
  // refusal is a warn naming the brief and the event that would have clobbered it.
  it('T9 — a refused projection is surfaced as one warn naming the brief and the event', () => {
    seedFile(db, 'TD-900', UNTICKED, BRAIN_STAMP);
    putDisk(briefPath, TICKED);

    bus.emit('brief.synced', { project: 'p', brief_id: 'TD-900' });

    expect(log.warn).toHaveLength(1);
    expect(log.warn[0]).toContain('TD-900');
    expect(log.warn[0]).toContain('brief.synced');
    expect(log.error).toEqual([]);
  });

  describe('diskEditState — the classifier', () => {
    const row = { content: UNTICKED, updated_at: BRAIN_STAMP };

    it('absent / same / local-newer / brain-newer, in that order of checks', () => {
      expect(diskEditState('p', 'TD-900.md', row)).toBe('absent');
      putDisk(briefPath, UNTICKED, OLDER_MTIME);
      expect(diskEditState('p', 'TD-900.md', row)).toBe('same');
      putDisk(briefPath, TICKED, OLDER_MTIME);
      expect(diskEditState('p', 'TD-900.md', row)).toBe('brain-newer');
      putDisk(briefPath, TICKED); // now
      expect(diskEditState('p', 'TD-900.md', row)).toBe('local-newer');
    });

    it('accepts the ISO T…Z stamp shape a sync-ingested row may carry', () => {
      putDisk(briefPath, TICKED, OLDER_MTIME);
      expect(diskEditState('p', 'TD-900.md', { content: UNTICKED, updated_at: '2026-09-01T10:00:00Z' })).toBe('brain-newer');
      expect(diskEditState('p', 'TD-900.md', { content: UNTICKED, updated_at: '2026-09-01T08:00:00Z' })).toBe('local-newer');
    });

    it('an unparseable stamp is refuse-biased: a differing file reads local-newer', () => {
      putDisk(briefPath, TICKED, OLDER_MTIME);
      expect(diskEditState('p', 'TD-900.md', { content: UNTICKED, updated_at: 'not a date' })).toBe('local-newer');
      expect(diskEditState('p', 'TD-900.md', { content: UNTICKED, updated_at: '' })).toBe('local-newer');
    });

    it('the same-second boundary reads local-newer (stamp floored; refuse bias)', () => {
      putDisk(briefPath, TICKED, new Date('2026-09-01T10:00:00.500Z'));
      expect(diskEditState('p', 'TD-900.md', row)).toBe('local-newer');
      putDisk(briefPath, TICKED, new Date('2026-09-01T10:00:00.000Z'));
      expect(diskEditState('p', 'TD-900.md', row)).toBe('brain-newer');
    });
  });
});
