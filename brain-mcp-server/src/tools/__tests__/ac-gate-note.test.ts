/**
 * TD-325 — the AC-completion OBSERVER note on the brief write boundary.
 *
 * `acGateNote` is the fourth sibling of the three `nonCanonical*Note` calls in
 * `handleBriefSync`. It reports that a brief reached a TERMINAL status with
 * unmet acceptance criteria. It does not reject, and it does not touch the row.
 *
 * WHY IT IS AN OBSERVER — the property this file exists to prove.
 * Both of /hunt's terminal syncs happen AFTER the commit has landed:
 *   Phase 7:  7.1 phase=COMMITTING -> 7.2 git commit -> 7.4 status=Done
 *             -> 7.5 sync(status='Done', phase='COMMITTING')
 *   Phase 8:  8.2 sync(status='Done', phase='COMPLETE')
 * A rejecting gate here could not un-close anything; it could only refuse to
 * RECORD something already true. Refusing at 7.5 leaves a landed commit with the
 * store saying open (C3); refusing at 8.2 manufactures C1 — the contradiction
 * TD-257 shipped 8.2 to eliminate, and one TD-311 forbids fixing by editing
 * brief data. So the refusal lives in scripts/git-hooks/commit-msg instead, and
 * AC #4 ("/hunt's own Phase-7-then-Phase-8 double sync does not trip it") is
 * satisfied STRUCTURALLY: nothing in the two-step can trip, because nothing in
 * the two-step can refuse. `P1` below is that proof.
 *
 * The parser is the SHARED script (core/scripts/brief_ac_check.sh) reached via
 * `IGRIS_AC_CHECK`, not a TypeScript reimplementation — a second parser would
 * mean a second population, which is the failure TD-325 removes. Pointing the
 * env var at the repo copy is also what keeps this test hermetic: it never
 * depends on what the operator's runtime mirror happens to contain.
 *
 * Mocked at the I/O boundary (`getDb`), like its siblings. Fixture is
 * `:memory:`; nothing here touches the real brain.
 *
 * @module tools/__tests__/ac-gate-note
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

vi.mock('../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbeddingInto: vi.fn(),
  vectorSearchFrom: vi.fn(() => []),
  insertEmbedding: vi.fn(),
  deleteEmbedding: vi.fn(),
  vectorSearch: vi.fn(() => []),
}));

import { getDb } from '../../db.js';
import { handleBriefSync, acGateNote } from '../briefs.js';
import { isTerminalBriefStatus } from '../brief-normalize.js';

const mockedGetDb = vi.mocked(getDb);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AC_CHECK = resolve(REPO_ROOT, 'core/scripts/brief_ac_check.sh');

const UNTICKED_BRIEF = [
  '# TD-900: a brief with open criteria',
  '',
  '## Acceptance Criteria',
  '- [ ] the first criterion is not met',
  '- [x] the second one is',
  '',
].join('\n');

const COMPLETE_BRIEF = [
  '# TD-901: a brief whose criteria are all resolved',
  '',
  '## Acceptance Criteria',
  '- [x] met, with evidence in the closing commit',
  '- [~] **DEFERRED: the maintenance window moved.** -> TD-999',
  '',
].join('\n');

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_type TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      effort TEXT,
      phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      embedding BLOB,
      embedding_model TEXT DEFAULT '',
      UNIQUE(project, brief_id)
    );
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
  `);
  return db;
}

function seedContent(db: Database.Database, briefId: string, content: string): void {
  db.prepare(
    `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash)
     VALUES (?, 'p', ?, ?, ?, 'h')`,
  ).run(`f-${briefId}`, briefId, `${briefId}.md`, content);
}

function row(db: Database.Database, briefId: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM brief_status WHERE brief_id = ?').get(briefId) as
    | Record<string, unknown>
    | undefined;
}

function textOf(res: { content: { type: string; text: string }[] }): string {
  return res.content[0].text;
}

// The whole suite is meaningless if the shared parser is not where we think it
// is — every assertion would pass vacuously through acGateNote's fail-open
// `script === null` branch. Assert the precondition rather than assume it.
beforeAll(() => {
  expect(
    existsSync(AC_CHECK),
    `the shared parser must exist at ${AC_CHECK}; without it every note below is vacuously null`,
  ).toBe(true);
});

describe('isTerminalBriefStatus (the shared terminal-set predicate)', () => {
  it('accepts the two canonical terminal statuses and their retained synonyms', () => {
    for (const s of ['Done', 'Archived', 'Completed', 'Complete']) {
      expect(isTerminalBriefStatus(s), s).toBe(true);
    }
  });

  it('folds NOTATION — case, space, hyphen, underscore', () => {
    for (const s of ['done', 'ARCHIVED', 'Com pleted', 'com-plete', 'com_plete']) {
      expect(isTerminalBriefStatus(s), s).toBe(true);
    }
  });

  it('does NOT fold vocabulary — a different WORD stays non-terminal', () => {
    // Cancelled/Superseded/Deferred are the three DOCUMENTED GAP statuses.
    // Whether they are terminal is TD-342's lifecycle question; folding them
    // here would answer it by accident.
    for (const s of ['In Progress', 'Blocked', 'Ready', 'Draft', 'Cancelled', 'Superseded', 'Deferred', '', null, undefined]) {
      expect(isTerminalBriefStatus(s), String(s)).toBe(false);
    }
  });
});

describe('acGateNote', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
    process.env.IGRIS_AC_CHECK = AC_CHECK;
  });

  afterEach(() => {
    db.close();
    delete process.env.IGRIS_AC_CHECK;
    vi.clearAllMocks();
  });

  it('reports a terminal brief whose criteria are still open', () => {
    seedContent(db, 'TD-900', UNTICKED_BRIEF);
    const note = acGateNote(db, 'p', 'TD-900', 'Done');
    expect(note).not.toBeNull();
    expect(note).toContain('TD-900');
    expect(note).toContain('VERDICT=FAIL');
    expect(note).toContain('unticked=1');
    // The healthy alternative is shown, not just the complaint.
    expect(note).toContain('DEFERRED');
  });

  it('is silent for a terminal brief whose criteria are ticked or deferred', () => {
    seedContent(db, 'TD-901', COMPLETE_BRIEF);
    expect(acGateNote(db, 'p', 'TD-901', 'Done')).toBeNull();
  });

  // The single most important negative: a mid-hunt sync must say NOTHING.
  // Unticked criteria during BUILDING are the normal state of the world, and a
  // note there would train everyone to ignore the note that matters.
  it('is silent for a NON-terminal status, even with open criteria', () => {
    seedContent(db, 'TD-900', UNTICKED_BRIEF);
    for (const s of ['In Progress', 'Ready', 'Blocked', 'Draft']) {
      expect(acGateNote(db, 'p', 'TD-900', s), s).toBeNull();
    }
  });

  it('is silent when the brief has no stored content', () => {
    expect(acGateNote(db, 'p', 'TD-902', 'Done')).toBeNull();
  });

  it('does not throw when brief_files does not exist at all', () => {
    const bare = new Database(':memory:');
    bare.exec(`CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, brief_id TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL)`);
    expect(() => acGateNote(bare, 'p', 'TD-900', 'Done')).not.toThrow();
    expect(acGateNote(bare, 'p', 'TD-900', 'Done')).toBeNull();
    bare.close();
  });

  it('is silent when no parser is installed (fail-open)', () => {
    seedContent(db, 'TD-900', UNTICKED_BRIEF);
    process.env.IGRIS_AC_CHECK = '/nonexistent/brief_ac_check.sh';
    expect(acGateNote(db, 'p', 'TD-900', 'Done')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P1 — AC #4: the Phase-7-then-Phase-8 double sync
// ---------------------------------------------------------------------------
describe('handleBriefSync: the /hunt double sync (AC #4)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
    process.env.IGRIS_AC_CHECK = AC_CHECK;
    seedContent(db, 'TD-900', UNTICKED_BRIEF);
  });

  afterEach(() => {
    db.close();
    delete process.env.IGRIS_AC_CHECK;
    vi.clearAllMocks();
  });

  const base = {
    project: 'p',
    brief_id: 'TD-900',
    title: 'a brief with open criteria',
    brief_type: 'Tech Debt',
    priority: 'P2-Medium',
    effort: 'M-Medium',
  };

  it('neither sync throws, and each lands its phase', () => {
    // Phase 7 step 5 — status Done, phase still COMMITTING.
    const res7 = handleBriefSync({ ...base, status: 'Done', phase: 'COMMITTING' });
    expect(res7.content[0].text).toContain('Brief status synced successfully.');
    expect(row(db, 'TD-900')).toMatchObject({ status: 'Done', phase: 'COMMITTING' });

    // Phase 8 step 2 — the terminal-phase flip.
    const res8 = handleBriefSync({ ...base, status: 'Done', phase: 'COMPLETE' });
    expect(res8.content[0].text).toContain('Brief status synced successfully.');
    expect(row(db, 'TD-900')).toMatchObject({ status: 'Done', phase: 'COMPLETE' });
  });

  it('the note appears at BOTH moments — it informs, it does not gate one of them', () => {
    const res7 = handleBriefSync({ ...base, status: 'Done', phase: 'COMMITTING' });
    const res8 = handleBriefSync({ ...base, status: 'Done', phase: 'COMPLETE' });
    expect(textOf(res7)).toContain('unmet acceptance criteria');
    expect(textOf(res8)).toContain('unmet acceptance criteria');
  });

  // The strongest form of "never alters what was stored": run the identical
  // two-step with the note path DISABLED (no parser resolvable) and compare the
  // rows field by field. Anything the note touched would show up here.
  it('stores a row identical to a control run with the note path disabled', () => {
    handleBriefSync({ ...base, status: 'Done', phase: 'COMMITTING' });
    handleBriefSync({ ...base, status: 'Done', phase: 'COMPLETE' });
    const withNote = row(db, 'TD-900') as Record<string, unknown>;

    const control = makeTestDb();
    mockedGetDb.mockReturnValue(control);
    seedContent(control, 'TD-900', UNTICKED_BRIEF);
    process.env.IGRIS_AC_CHECK = '/nonexistent/brief_ac_check.sh';
    handleBriefSync({ ...base, status: 'Done', phase: 'COMMITTING' });
    handleBriefSync({ ...base, status: 'Done', phase: 'COMPLETE' });
    const withoutNote = row(control, 'TD-900') as Record<string, unknown>;

    // Arm the control: it must genuinely have taken the disabled path, or this
    // comparison is two identical runs proving nothing.
    expect(acGateNote(control, 'p', 'TD-900', 'Done')).toBeNull();

    for (const col of ['project', 'brief_id', 'brief_type', 'title', 'status', 'priority', 'effort', 'phase']) {
      expect(withNote[col], col).toEqual(withoutNote[col]);
    }
    control.close();
  });

  it('leaves the brief CONTENT untouched — the note reads, it never writes', () => {
    handleBriefSync({ ...base, status: 'Done', phase: 'COMMITTING' });
    handleBriefSync({ ...base, status: 'Done', phase: 'COMPLETE' });
    const stored = db
      .prepare('SELECT content FROM brief_files WHERE brief_id = ?')
      .get('TD-900') as { content: string };
    expect(stored.content).toBe(UNTICKED_BRIEF);
  });
});
