/**
 * Migration v23 Tests — FR-246 (`briefs_fts`, the BM25 arm for brief search)
 *
 * Verifies the additive migration that gives briefs a lexical index:
 *   1. `briefs_fts` is created, CONTENTLESS (`content=''`, `contentless_delete=1`)
 *      — the shape chosen because a contentful fts5 measured +11,452,416 B
 *      against +3,846,144 B on the operator's brain, for a second copy of text
 *      the reader never reads.
 *   2. The backfill indexes every `brief_status` row, INCLUDING its body — the
 *      capability `briefs_vec` does not have at all.
 *   3. **All four real writer shapes fire the triggers.** This is the test the
 *      new MAINTAINING row exists to require: a write path that does not
 *      maintain the index leaves it silently stale, and a stale FTS index looks
 *      exactly like a search that legitimately found nothing.
 *   4. Idempotency — a second `migrateSchema()` neither duplicates rows nor
 *      throws. (Contentless fts5 does NOT reject a duplicate rowid — verified,
 *      no UNIQUE constraint fires — so "no duplicates" has to be asserted, not
 *      assumed from the DDL.)
 *   5. `updated_at` is never bumped. It is an LWW sync column; v23 issues no
 *      UPDATE at all, and this asserts that holds.
 *   6. Backup — `.pre-v23.bak` exists, OPENS, and row-count-matches; an
 *      unusable snapshot ABORTS at v22 (the shape FR-246's sign-off required of
 *      v23 even though v23, unlike v22, destroys nothing).
 *   7. `:memory:` skips the snapshot (the v19/v22 precedent).
 *
 * Gate-dodge proof: v23 has NO vec dependency, so this suite runs WITHOUT
 * loading sqlite-vec — on a vec-less machine the v13 backfill stalls the chain
 * at v12, so the ladder is topped up by hand and the L-209 re-read gate must
 * still fire v23 from version 22.
 *
 * Fixture discipline: every test uses a TEMP-FILE DB under `mkdtemp` (a file DB
 * is required to exercise the VACUUM INTO path) or `:memory:`. **Nothing here
 * reads or writes `~/.igris/memory/knowledge.db`.**
 *
 * @module __tests__/db-migration-v23
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateSchema } from '../db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

/** Build the brain schema vec-lessly, then force the ladder to exactly 22. */
function buildSchemaAtV22(db: Database.Database): void {
  migrateSchema(db);
  for (let v = 13; v <= 22; v++) {
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
  }
  db.prepare(
    `INSERT OR IGNORE INTO projects (slug, name, path, status) VALUES ('p', 'p', '/tmp/p', 'active')`,
  ).run();
}

const FIXED_TS = '2026-01-01 00:00:00';

function seed(
  db: Database.Database,
  briefId: string,
  title: string,
  content?: string,
): void {
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, phase, updated_at)
     VALUES ('p', ?, 'Feature', ?, 'Ready', 'P2-Medium', 'INIT', ?)`,
  ).run(briefId, title, FIXED_TS);
  if (content !== undefined) {
    db.prepare(
      `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
       VALUES (?, 'p', ?, ?, ?, 'h', ?)`,
    ).run(`p:${briefId}`, briefId, `${briefId}.md`, content, FIXED_TS);
  }
}

/** rowids the index returns for a query, sorted. The ONLY read the reader does. */
function ftsHits(db: Database.Database, query: string): number[] {
  return (
    db
      .prepare(`SELECT rowid AS id FROM briefs_fts WHERE briefs_fts MATCH ? ORDER BY rowid`)
      .all(query) as { id: number }[]
  ).map((r) => r.id);
}

function idOf(db: Database.Database, briefId: string): number {
  return (
    db.prepare(`SELECT id FROM brief_status WHERE project='p' AND brief_id=?`).get(briefId) as {
      id: number;
    }
  ).id;
}

function ftsCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM briefs_fts').get() as { c: number }).c;
}

// ---------------------------------------------------------------------------

describe('migration v23 — briefs_fts (FR-246)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'igris-v23-'));
    dbPath = path.join(tmpDir, 'knowledge.db');
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    buildSchemaAtV22(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records v23 in the ladder and carries the chain to its terminal', () => {
    expect(getSchemaVersion(db)).toBe(22);
    migrateSchema(db);
    expect(db.prepare('SELECT 1 FROM schema_version WHERE version = 23').get()).toBeDefined();
    expect(getSchemaVersion(db)).toBe(25);
  });

  it('creates briefs_fts as a CONTENTLESS fts5 — the measured storage decision', () => {
    migrateSchema(db);
    const sql = (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='briefs_fts'`)
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain('fts5');
    // Both flags asserted by NAME. `content=''` is what stops the index keeping
    // a second copy of 6.2 MB of brief bodies; `contentless_delete=1` is what
    // makes the DELETE in every trigger below legal at all. Dropping either one
    // silently changes the storage profile or breaks maintenance.
    expect(sql).toContain("content=''");
    expect(sql).toContain('contentless_delete=1');
  });

  it('backfills every brief, and the body is searchable — the capability briefs_vec lacks', () => {
    seed(db, 'FR-001', 'Wrapper extraction', 'The reader returns rows for the dashboard.');
    seed(db, 'FR-002', 'Ceramic kiln schedule', 'Bisque firing peaks at cone 04 overnight.');
    seed(db, 'FR-003', 'Metadata only brief'); // no brief_files row at all

    migrateSchema(db);

    expect(ftsCount(db)).toBe(3);
    // Title match.
    expect(ftsHits(db, 'kiln')).toEqual([idOf(db, 'FR-002')]);
    // BODY match — the whole point of the arm. 'bisque' appears in no title.
    expect(ftsHits(db, 'bisque')).toEqual([idOf(db, 'FR-002')]);
    const titles = db.prepare('SELECT title FROM brief_status').all() as { title: string }[];
    expect(titles.every((t) => !t.title.toLowerCase().includes('bisque'))).toBe(true);
    // A brief with NO file is still indexed by title rather than dropped.
    expect(ftsHits(db, 'metadata')).toEqual([idOf(db, 'FR-003')]);
  });

  it('does not bump updated_at — brief_status is LWW-synced', () => {
    seed(db, 'FR-001', 'Wrapper extraction', 'body');
    const before = db.prepare('SELECT brief_id, updated_at FROM brief_status ORDER BY brief_id').all();
    migrateSchema(db);
    const after = db.prepare('SELECT brief_id, updated_at FROM brief_status ORDER BY brief_id').all();
    expect(after).toEqual(before);
    expect((after[0] as { updated_at: string }).updated_at).toBe(FIXED_TS);
  });

  it('is idempotent — a second migrateSchema() neither duplicates nor throws', () => {
    seed(db, 'FR-001', 'Wrapper extraction', 'body text');
    migrateSchema(db);
    const first = ftsCount(db);
    expect(() => migrateSchema(db)).not.toThrow();
    expect(ftsCount(db)).toBe(first);
    expect(ftsHits(db, 'wrapper')).toEqual([idOf(db, 'FR-001')]);
  });

  // -------------------------------------------------------------------------
  // The trigger contract — all four writer shapes
  // -------------------------------------------------------------------------

  describe('the six triggers follow every real writer shape', () => {
    beforeEach(() => {
      migrateSchema(db);
    });

    /**
     * Shape 1 — `handleBriefCreate` (`briefs.ts:423-457`): brief_files FIRST,
     * brief_status SECOND, both `ON CONFLICT DO UPDATE`, one transaction.
     *
     * This ORDER is the interesting half: at brief_files-insert time the
     * brief_status row does not exist, so that trigger is a silent no-op and
     * the brief_status insert has to pick up BOTH fields.
     */
    it('shape 1 — create writes brief_files BEFORE brief_status and still indexes both fields', () => {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
           VALUES ('x','p','FR-100','FR-100.md','Wrapper body about bisque','h',?)
           ON CONFLICT(project, brief_id) DO UPDATE SET content = excluded.content`,
        ).run(FIXED_TS);
        db.prepare(
          `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, phase, updated_at)
           VALUES ('p','FR-100','Feature','Kiln schedule','Ready','P2-Medium','INIT',?)
           ON CONFLICT(project, brief_id) DO UPDATE SET title = excluded.title`,
        ).run(FIXED_TS);
      })();

      const id = idOf(db, 'FR-100');
      expect(ftsHits(db, 'kiln')).toEqual([id]); // title
      expect(ftsHits(db, 'bisque')).toEqual([id]); // body, resolved by subquery
      expect(ftsCount(db)).toBe(1);
    });

    /** Shape 2 — a plain `UPDATE brief_status` (`briefs.ts:600`/`:615`). */
    it('shape 2 — UPDATE brief_status re-indexes the title and leaves no stale term', () => {
      seed(db, 'FR-101', 'Kiln schedule', 'body about bisque');
      const id = idOf(db, 'FR-101');
      expect(ftsHits(db, 'kiln')).toEqual([id]);

      db.prepare(`UPDATE brief_status SET title = 'Wrapper schedule' WHERE id = ?`).run(id);

      expect(ftsHits(db, 'wrapper')).toEqual([id]);
      // The OLD term is gone. Without the DELETE half of the trigger this would
      // still match and the index would accumulate every title a brief ever had.
      expect(ftsHits(db, 'kiln')).toEqual([]);
      // The body survives the title update — the trigger re-reads brief_files.
      expect(ftsHits(db, 'bisque')).toEqual([id]);
      expect(ftsCount(db)).toBe(1);
    });

    /** Shape 3 — `ON CONFLICT … DO UPDATE` on brief_files (`sync.ts:1595`). */
    it('shape 3 — an upsert of the BODY re-indexes it and drops the old body terms', () => {
      seed(db, 'FR-102', 'Kiln schedule', 'body about bisque');
      const id = idOf(db, 'FR-102');

      db.prepare(
        `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
         VALUES ('y','p','FR-102','FR-102.md','rewritten body about wrappers','h',?)
         ON CONFLICT(project, brief_id) DO UPDATE SET content = excluded.content`,
      ).run(FIXED_TS);

      expect(ftsHits(db, 'wrappers')).toEqual([id]);
      expect(ftsHits(db, 'bisque')).toEqual([]);
      expect(ftsHits(db, 'kiln')).toEqual([id]); // title preserved
      expect(ftsCount(db)).toBe(1);
    });

    /** Shape 4 — `mergeRows`'s plain INSERT / UPDATE (`sync.ts:631-668`). */
    it('shape 4 — mergeRows-style plain INSERT then UPDATE keeps exactly one index row', () => {
      db.prepare(
        `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, phase, updated_at)
         VALUES ('p','FR-103','Feature','Kiln schedule','Ready','P2-Medium','INIT',?)`,
      ).run(FIXED_TS);
      db.prepare(
        `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
         VALUES ('z','p','FR-103','FR-103.md','body about bisque','h',?)`,
      ).run(FIXED_TS);
      const id = idOf(db, 'FR-103');
      expect(ftsHits(db, 'bisque')).toEqual([id]);

      db.prepare(`UPDATE brief_files SET content = 'body about wrappers' WHERE brief_id = 'FR-103'`).run();
      db.prepare(`UPDATE brief_status SET status = 'Done' WHERE id = ?`).run(id);

      expect(ftsHits(db, 'wrappers')).toEqual([id]);
      expect(ftsHits(db, 'bisque')).toEqual([]);
      // FOUR writes to two tables and still ONE row. Contentless fts5 does NOT
      // reject a duplicate rowid, so this count is the only thing standing
      // between a bare INSERT in a trigger and a MATCH returning a brief twice.
      expect(ftsCount(db)).toBe(1);
    });

    it('deleting the brief removes it from the index', () => {
      seed(db, 'FR-104', 'Kiln schedule', 'body about bisque');
      const id = idOf(db, 'FR-104');
      db.prepare(`DELETE FROM brief_files WHERE brief_id = 'FR-104'`).run();
      // The FILE went, the BRIEF did not — so it stays searchable by title.
      expect(ftsHits(db, 'kiln')).toEqual([id]);
      expect(ftsHits(db, 'bisque')).toEqual([]);

      db.prepare(`DELETE FROM brief_status WHERE id = ?`).run(id);
      expect(ftsHits(db, 'kiln')).toEqual([]);
      expect(ftsCount(db)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Backup
  // -------------------------------------------------------------------------

  it('writes a .pre-v23.bak that OPENS and row-count-matches the source', () => {
    seed(db, 'FR-001', 'Wrapper extraction', 'body');
    const preCount = (db.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }).c;

    migrateSchema(db);

    const bakPath = `${dbPath}.pre-v23.bak`;
    expect(fs.existsSync(bakPath)).toBe(true);
    const bak = new Database(bakPath, { readonly: true });
    try {
      expect(
        (bak.pragma('integrity_check') as Array<{ integrity_check: string }>)[0].integrity_check,
      ).toBe('ok');
      expect((bak.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }).c).toBe(
        preCount,
      );
      // And it predates the index — which is what makes it an undo.
      expect(
        bak.prepare(`SELECT name FROM sqlite_master WHERE name='briefs_fts'`).get(),
      ).toBeUndefined();
    } finally {
      bak.close();
    }
  });

  it('ABORTS at v22 when the snapshot is unusable — no index, no version bump', () => {
    seed(db, 'FR-001', 'Wrapper extraction', 'body');
    fs.writeFileSync(`${dbPath}.pre-v23.bak`, 'this is not a sqlite database');

    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(22);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='briefs_fts'`).get()).toBeUndefined();
  });

  it('retries successfully once the bad snapshot is cleared', () => {
    seed(db, 'FR-001', 'Wrapper extraction', 'body about bisque');
    fs.writeFileSync(`${dbPath}.pre-v23.bak`, 'not a database');
    migrateSchema(db);
    expect(getSchemaVersion(db)).toBe(22);

    fs.rmSync(`${dbPath}.pre-v23.bak`);
    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(25);
    expect(ftsHits(db, 'bisque')).toEqual([idOf(db, 'FR-001')]);
  });
});

describe('migration v23 — :memory: DBs skip the snapshot (v19/v22 precedent)', () => {
  it('builds the index on an in-memory DB with no backup file', () => {
    const mem = new Database(':memory:');
    try {
      mem.pragma('foreign_keys = ON');
      buildSchemaAtV22(mem);
      seed(mem, 'FR-001', 'Kiln schedule', 'body about bisque');

      migrateSchema(mem);

      expect(getSchemaVersion(mem)).toBe(25);
      expect(ftsHits(mem, 'bisque')).toEqual([idOf(mem, 'FR-001')]);
    } finally {
      mem.close();
    }
  });
});
