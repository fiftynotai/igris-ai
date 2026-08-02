/**
 * TD-328 D6(c) — write-boundary non-canonical `brief_type` echo.
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
import { nonCanonicalBriefTypeNote, CANONICAL_BRIEF_TYPES } from '../brief-normalize.js';

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
