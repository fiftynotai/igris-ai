/**
 * TD-328 D6(c) — write-boundary non-canonical VOCABULARY echo.
 *
 * Originally `brief_type` only. TD-333 widened it to all three vocabulary
 * fields: `status` gained an echo (and a normalizer), and `priority`'s echo —
 * shipped by TD-338 with ZERO callers — was finally wired to the same three
 * handlers. The `brief_type` name on this file is historical.
 *
 * The observer that makes read-widen a TOLERANCE policy instead of a SILENCE
 * policy. `igris_brief_sync` / `_create` / `_update` append a NOTE to their
 * response when the value they STORED is not canonical, so the 51st spelling is
 * visible at the instant it is minted rather than accumulating for years.
 *
 * The two properties under test, together:
 *   1. the NOTE appears (and names the offending value + the canonical list);
 *   2. the value is STILL STORED UNCHANGED — the echo informs, it never
 *      rejects and never rewrites (D1 option b).
 *
 * Mocked at the I/O boundary (`getDb`), not at the handler under test.
 * Fixture is `:memory:`; nothing here touches the real brain.
 *
 * @module tools/__tests__/brief-type-echo
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

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
import { handleBriefSync, handleBriefCreate, handleBriefUpdate } from '../briefs.js';
import {
  nonCanonicalBriefTypeNote,
  CANONICAL_BRIEF_TYPES,
  CANONICAL_STATUSES,
} from '../brief-normalize.js';

const mockedGetDb = vi.mocked(getDb);

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

function storedCol(db: Database.Database, briefId: string, col: string): string | null {
  const row = db
    .prepare(`SELECT ${col} AS v FROM brief_status WHERE brief_id = ?`)
    .get(briefId) as { v: string | null } | undefined;
  return row?.v ?? null;
}

function storedType(db: Database.Database, briefId: string): string | null {
  const row = db
    .prepare(`SELECT brief_type FROM brief_status WHERE brief_id = ?`)
    .get(briefId) as { brief_type: string | null } | undefined;
  return row?.brief_type ?? null;
}

describe('nonCanonicalBriefTypeNote', () => {
  it('is silent for canonical values (including case variants and the new ones)', () => {
    for (const t of CANONICAL_BRIEF_TYPES) {
      expect(nonCanonicalBriefTypeNote(t), t).toBeNull();
    }
    expect(nonCanonicalBriefTypeNote('feature')).toBeNull();
    expect(nonCanonicalBriefTypeNote('  Refactor ')).toBeNull();
  });

  it('is silent for null/empty (an unset type is not a bad spelling)', () => {
    expect(nonCanonicalBriefTypeNote(null)).toBeNull();
    expect(nonCanonicalBriefTypeNote(undefined)).toBeNull();
    expect(nonCanonicalBriefTypeNote('')).toBeNull();
    expect(nonCanonicalBriefTypeNote('   ')).toBeNull();
  });

  it('names the offending value AND the full canonical list', () => {
    const note = nonCanonicalBriefTypeNote('Bug (pub.dev Score)');
    expect(note).toContain('Bug (pub.dev Score)');
    expect(note).toContain('not a canonical type');
    expect(note).toContain('stored as-is');
    for (const t of CANONICAL_BRIEF_TYPES) {
      expect(note).toContain(t);
    }
  });
});

describe('write-boundary echo (D6(c))', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, title, status) VALUES ('p','X-001','seed','Ready')`,
    ).run();
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it('igris_brief_sync echoes a non-canonical type AND stores it unchanged', () => {
    const res = handleBriefSync({
      project: 'p',
      brief_id: 'BR-777',
      title: 'Odd one',
      status: 'Ready',
      brief_type: 'Bug (pub.dev Score)',
    });

    expect(res.content[0].text).toContain('NOTE: brief_type "Bug (pub.dev Score)"');
    // The load-bearing half: it INFORMS, it does not reject or rewrite.
    expect(res.content[0].text).toContain('Brief status synced successfully.');
    expect(storedType(db, 'BR-777')).toBe('Bug (pub.dev Score)');
  });

  it('igris_brief_sync stays quiet for a canonical type', () => {
    const res = handleBriefSync({
      project: 'p',
      brief_id: 'FR-777',
      title: 'Fine',
      status: 'Ready',
      brief_type: 'Feature',
    });
    expect(res.content[0].text).not.toContain('NOTE: brief_type');
    expect(storedType(db, 'FR-777')).toBe('Feature');
  });

  it('igris_brief_sync stays quiet for a FOLDED alias (the fold made it canonical)', () => {
    const res = handleBriefSync({
      project: 'p',
      brief_id: 'TD-777',
      title: 'Folded',
      status: 'Ready',
      brief_type: 'TechDebt',
    });
    expect(res.content[0].text).not.toContain('NOTE: brief_type');
    expect(storedType(db, 'TD-777')).toBe('Technical Debt');
  });

  it('igris_brief_create echoes at the MINT surface and still creates the brief', async () => {
    const res = await handleBriefCreate({
      project: 'p',
      brief_id: 'BR-778',
      title: 'Compound',
      content: '# BR-778\n\nbody',
      brief_type: 'Feature / Infrastructure',
    });

    expect(res.content[0].text).toContain('Brief created successfully.');
    expect(res.content[0].text).toContain('NOTE: brief_type "Feature / Infrastructure"');
    expect(storedType(db, 'BR-778')).toBe('Feature / Infrastructure');
  });

  it('igris_brief_update echoes when re-typing to a non-canonical value', () => {
    const res = handleBriefUpdate({
      project: 'p',
      brief_id: 'X-001',
      brief_type: 'Frobnicate',
    });
    expect(res.content[0].text).toContain('Brief updated successfully.');
    expect(res.content[0].text).toContain('NOTE: brief_type "Frobnicate"');
    expect(storedType(db, 'X-001')).toBe('Frobnicate');
  });

  it('igris_brief_update stays quiet when brief_type was not part of the update', () => {
    const res = handleBriefUpdate({ project: 'p', brief_id: 'X-001', status: 'Done' });
    expect(res.content[0].text).not.toContain('NOTE: brief_type');
  });
});

// ===========================================================================
// TD-333 — the `status` write boundary: normalize, echo, never reject
// ===========================================================================

describe('TD-333 T4/T5 — the status write boundary', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, title, status) VALUES ('p','X-001','seed','Ready')`,
    ).run();
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  // --- T4: a FOLDED status stores canonical, echoes the STORED value --------

  it('igris_brief_sync STORES the fold and ECHOES the stored value, not the arg', () => {
    const res = handleBriefSync({
      project: 'p',
      brief_id: 'BR-901',
      title: 'Finished',
      status: 'Completed',
      brief_type: 'Bug',
    });

    expect(storedCol(db, 'BR-901', 'status')).toBe('Done');
    // R9 / the plan's briefs.ts:176 finding: this line printed `args.status`,
    // so the response used to say `Status: Completed` while the row held
    // `Done`. A response that contradicts the store is worse than silence.
    expect(res.content[0].text).toContain('Status: Done');
    expect(res.content[0].text).not.toContain('Status: Completed');
    // The fold made it canonical, so there is nothing to report.
    expect(res.content[0].text).not.toContain('NOTE: status');
  });

  it('folds InProgress -> In Progress at _sync', () => {
    handleBriefSync({
      project: 'p',
      brief_id: 'BR-902',
      title: 'Mid hunt',
      status: 'InProgress',
    });
    expect(storedCol(db, 'BR-902', 'status')).toBe('In Progress');
  });

  // --- TD-333 review m3: the SIBLING fields echoed raw while storing folded ---
  // The rule above ("echo what was STORED") was stated for `status` and
  // violated two lines below for `priority` and `phase`, in the same function.
  // These pin the rule for all three. Both assertions matter: the positive one
  // would pass on the old code for an already-canonical input, which is why
  // the inputs here are deliberately NON-canonical.
  it('_sync echoes the STORED priority and phase, not the raw args', () => {
    const res = handleBriefSync({
      project: 'p',
      brief_id: 'BR-905',
      title: 'Raw echo check',
      status: 'Ready',
      priority: 'p1',
      phase: 'building',
    });

    expect(storedCol(db, 'BR-905', 'priority')).toBe('P1-High');
    expect(storedCol(db, 'BR-905', 'phase')).toBe('BUILDING');

    expect(res.content[0].text).toContain('Priority: P1-High');
    expect(res.content[0].text).not.toContain('Priority: p1');
    expect(res.content[0].text).toContain('Phase: BUILDING');
    expect(res.content[0].text).not.toContain('Phase: building');
  });

  // The trap the reviewer named: the unset family is TRUTHY but folds to null,
  // so guarding the echo on `args.priority` while interpolating the normalized
  // value prints the literal string "Priority: null". Guarding on the STORED
  // value omits the line instead, which is what a null column deserves.
  it('_sync omits the line entirely when the unset family folds to null', () => {
    const res = handleBriefSync({
      project: 'p',
      brief_id: 'BR-906',
      title: 'Unset priority',
      status: 'Ready',
      priority: 'Unset',
    });

    expect(storedCol(db, 'BR-906', 'priority')).toBeNull();
    expect(res.content[0].text).not.toContain('Priority: null');
    expect(res.content[0].text).not.toContain('Priority: Unset');
    expect(res.content[0].text).not.toContain('Priority:');
  });

  it('igris_brief_create folds at the MINT surface', async () => {
    const res = await handleBriefCreate({
      project: 'p',
      brief_id: 'BR-903',
      title: 'Minted finished',
      content: '# BR-903\n\nbody',
      status: 'Complete',
    });
    expect(res.content[0].text).toContain('Brief created successfully.');
    expect(storedCol(db, 'BR-903', 'status')).toBe('Done');
    expect(res.content[0].text).toContain('Status: Done');
    expect(res.content[0].text).not.toContain('NOTE: status');
  });

  it('igris_brief_create still defaults an omitted status to Ready', async () => {
    await handleBriefCreate({
      project: 'p',
      brief_id: 'BR-904',
      title: 'No status',
      content: '# BR-904\n\nbody',
    });
    expect(storedCol(db, 'BR-904', 'status')).toBe('Ready');
  });

  it('igris_brief_update folds a provided status', () => {
    handleBriefUpdate({ project: 'p', brief_id: 'X-001', status: 'Completed' });
    expect(storedCol(db, 'X-001', 'status')).toBe('Done');
  });

  // --- T5: a NON-CANONICAL status is stored VERBATIM and reported -----------

  it('_sync stores a MISSING STATE verbatim and echoes the canonical six', () => {
    const res = handleBriefSync({
      project: 'p',
      brief_id: 'BR-905',
      title: 'Abandoned',
      status: 'Cancelled',
    });

    // INFORMS — never rejects, never rewrites. TD-311's boundary: the planner
    // does not decide that `Cancelled` means `Archived`.
    expect(storedCol(db, 'BR-905', 'status')).toBe('Cancelled');
    expect(res.content[0].text).toContain('Brief status synced successfully.');
    expect(res.content[0].text).toContain('NOTE: status "Cancelled"');
    for (const s of CANONICAL_STATUSES) expect(res.content[0].text).toContain(s);
  });

  it('_sync stores a SENTENCE status verbatim and reports it', () => {
    const sentence = 'Split (see FR-061, FR-062, FR-063)';
    const res = handleBriefSync({
      project: 'p',
      brief_id: 'FR-054',
      title: 'Parent brief',
      status: sentence,
    });
    expect(storedCol(db, 'FR-054', 'status')).toBe(sentence);
    expect(res.content[0].text).toContain(`NOTE: status ${JSON.stringify(sentence)}`);
  });

  it('_create echoes a non-canonical status and still creates the brief', async () => {
    const res = await handleBriefCreate({
      project: 'p',
      brief_id: 'BR-906',
      title: 'Superseded work',
      content: '# BR-906\n\nbody',
      status: 'Superseded',
    });
    expect(res.content[0].text).toContain('Brief created successfully.');
    expect(res.content[0].text).toContain('NOTE: status "Superseded"');
    expect(storedCol(db, 'BR-906', 'status')).toBe('Superseded');
  });

  it('_update echoes when re-stating to a non-canonical status', () => {
    const res = handleBriefUpdate({ project: 'p', brief_id: 'X-001', status: 'Deferred' });
    expect(res.content[0].text).toContain('NOTE: status "Deferred"');
    expect(storedCol(db, 'X-001', 'status')).toBe('Deferred');
  });

  it('_update stays quiet when status was NOT part of the update', () => {
    const res = handleBriefUpdate({ project: 'p', brief_id: 'X-001', priority: 'P1-High' });
    expect(res.content[0].text).not.toContain('NOTE: status');
    // ...and the untouched status is exactly what it was.
    expect(storedCol(db, 'X-001', 'status')).toBe('Ready');
  });

  it('never hard-rejects an empty status — it is stored and REPORTED', () => {
    // The NOT NULL asymmetry, end to end. If normalizeStatus folded '' to null
    // the way its three siblings do, this call would throw a NOT NULL
    // constraint error and the operator would lose the write.
    const res = handleBriefSync({
      project: 'p',
      brief_id: 'BR-907',
      title: 'Empty',
      status: '',
    });
    expect(storedCol(db, 'BR-907', 'status')).toBe('');
    expect(res.content[0].text).toContain('NOTE: status ""');
  });
});

describe('TD-333 — the DEAD priority echo is finally wired (TD-338 left it with 0 callers)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    mockedGetDb.mockReturnValue(db);
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, title, status) VALUES ('p','X-001','seed','Ready')`,
    ).run();
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it('_sync reports a non-canonical priority', () => {
    const res = handleBriefSync({
      project: 'p',
      brief_id: 'BR-908',
      title: 'Trivial',
      status: 'Ready',
      priority: 'P4-Trivial',
    });
    expect(res.content[0].text).toContain('NOTE: priority "P4-Trivial"');
    expect(storedCol(db, 'BR-908', 'priority')).toBe('P4-Trivial');
  });

  it('_sync stays quiet for a FOLDED priority alias', () => {
    const res = handleBriefSync({
      project: 'p',
      brief_id: 'BR-909',
      title: 'Bare P1',
      status: 'Ready',
      priority: 'P1',
    });
    expect(res.content[0].text).not.toContain('NOTE: priority');
    expect(storedCol(db, 'BR-909', 'priority')).toBe('P1-High');
  });

  it('_sync stays quiet for an UNSET priority — NULL is not an offender', () => {
    const res = handleBriefSync({
      project: 'p',
      brief_id: 'BR-910',
      title: 'No priority',
      status: 'Ready',
    });
    expect(res.content[0].text).not.toContain('NOTE: priority');
    expect(storedCol(db, 'BR-910', 'priority')).toBeNull();
  });

  it('_update reports only when priority was part of the update', () => {
    expect(
      handleBriefUpdate({ project: 'p', brief_id: 'X-001', priority: 'P9-Made-Up' }).content[0]
        .text,
    ).toContain('NOTE: priority "P9-Made-Up"');
    expect(
      handleBriefUpdate({ project: 'p', brief_id: 'X-001', title: 't' }).content[0].text,
    ).not.toContain('NOTE: priority');
  });
});
