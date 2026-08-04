/**
 * Migration v24 Tests — TD-338 (priority vocabulary re-fold)
 *
 * Verifies the one-time idempotent DATA migration that folds the bare
 * `brief_status.priority` spellings (`P1`, `P2`, `P1 - High`, …) to their
 * canonical `P{N}-{Word}` form — the seven rows v18 could not have caught,
 * because they were written AFTER v18 ran, by a local writer that did not
 * normalize (see the migration comment for the refuted-sync-hypothesis
 * forensics).
 *
 * Coverage:
 *   1. Bare `P1`/`P2` and the spaced-dash forms fold to canonical.
 *   2. `P4-Trivial` is NOT folded — no fold table declares a target, so folding
 *      would be inventing. It stays and is reported by the validator instead.
 *   3. `updated_at` is byte-identical before and after. `priority` is an LWW
 *      sync column; a bumped timestamp would make folded local rows fight an
 *      un-migrated remote. This is the load-bearing assertion.
 *   4. Column safety — status/phase/title/brief_type/claimed_by untouched (#230).
 *   5. Row-count invariant — a fold never adds or drops a row.
 *   6. Idempotency — a second migrateSchema() changes zero rows.
 *   7. The unset family folds to NULL, and an ALREADY-NULL row is not re-written.
 *   8. schema_version advances to exactly 24.
 *
 * Gate-dodge proof: this migration is DATA-only with NO vec and NO FTS
 * dependency, so the suite runs WITHOUT loading sqlite-vec. schema_version is
 * driven up to 23 manually — the L-209 re-read gate must still fire v24 from
 * version 23 regardless of how the chain got there.
 *
 * Fixture discipline: every test uses `:memory:` or a temp-file DB under
 * `mkdtemp`. Nothing here reads or writes `~/.igris/memory/knowledge.db`.
 *
 * @module __tests__/db-migration-v24
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
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

/**
 * Build the brain schema (tables) without vec, then force schema_version to
 * exactly 23 so the next migrateSchema() call fires v24.
 */
function buildSchemaAtV23(db: Database.Database): void {
  migrateSchema(db);
  for (let v = 13; v <= 23; v++) {
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
  }
  const cols = new Set(
    (db.prepare('PRAGMA table_info(brief_status)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  if (!cols.has('claimed_by')) db.exec('ALTER TABLE brief_status ADD COLUMN claimed_by TEXT');
  if (!cols.has('claimed_at')) db.exec('ALTER TABLE brief_status ADD COLUMN claimed_at TEXT');

  db.prepare(
    `INSERT OR IGNORE INTO projects (slug, name, path, status) VALUES ('p', 'p', '/tmp/p', 'active')`,
  ).run();
}

const FIXED_TS = '2026-06-23 08:02:02'; // the real BR-045 timestamp

interface SeedRow {
  brief_id: string;
  priority: string | null;
  brief_type?: string | null;
  title?: string;
  status?: string;
  phase?: string | null;
  claimed_by?: string | null;
  updated_at?: string;
}

function seed(db: Database.Database, r: SeedRow): void {
  db.prepare(
    `INSERT INTO brief_status
       (project, brief_id, brief_type, title, status, priority, phase, claimed_by, updated_at)
     VALUES ('p', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.brief_id,
    r.brief_type ?? 'Technical Debt',
    r.title ?? `T ${r.brief_id}`,
    r.status ?? 'Done',
    r.priority,
    r.phase ?? 'COMPLETE',
    r.claimed_by ?? null,
    r.updated_at ?? FIXED_TS,
  );
}

function priorityOf(db: Database.Database, briefId: string): string | null {
  const row = db
    .prepare(`SELECT priority FROM brief_status WHERE project='p' AND brief_id = ?`)
    .get(briefId) as { priority: string | null } | undefined;
  return row?.priority ?? null;
}

/** Snapshot every column the migration must NOT touch — updated_at first. */
function untouchedSnapshot(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT brief_id, updated_at, brief_type, title, status, phase, claimed_by, claimed_at
         FROM brief_status WHERE project='p' ORDER BY brief_id`,
    )
    .all();
}

/**
 * The exact eight-row census measured read-only on the operator brain
 * (2026-08-03/04): 5 bare `P2`, 2 bare `P1`, 1 `P4-Trivial`.
 */
function seedLiveCensus(db: Database.Database): void {
  seed(db, { brief_id: 'BR-045', priority: 'P1' });
  seed(db, { brief_id: 'BR-046', priority: 'P1' });
  seed(db, { brief_id: 'BR-047', priority: 'P2' });
  seed(db, { brief_id: 'BR-048', priority: 'P2' });
  seed(db, { brief_id: 'BR-049', priority: 'P2' });
  seed(db, { brief_id: 'TD-277', priority: 'P2' });
  seed(db, { brief_id: 'TD-278', priority: 'P2' });
  seed(db, { brief_id: 'TD-002', priority: 'P4-Trivial' });
  // Canonical + unset controls, so "nothing else moved" is meaningful.
  seed(db, { brief_id: 'FR-001', priority: 'P0-Critical' });
  seed(db, { brief_id: 'FR-002', priority: 'P3-Low' });
  seed(db, { brief_id: 'FR-003', priority: null });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v24 — priority vocabulary re-fold (TD-338)', () => {
  it('folds the seven bare P1/P2 rows and advances schema_version to 24', () => {
    const db = new Database(':memory:');
    buildSchemaAtV23(db);
    expect(getSchemaVersion(db)).toBe(23);
    seedLiveCensus(db);

    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(24);
    expect(priorityOf(db, 'BR-045')).toBe('P1-High');
    expect(priorityOf(db, 'BR-046')).toBe('P1-High');
    expect(priorityOf(db, 'BR-047')).toBe('P2-Medium');
    expect(priorityOf(db, 'BR-048')).toBe('P2-Medium');
    expect(priorityOf(db, 'BR-049')).toBe('P2-Medium');
    expect(priorityOf(db, 'TD-277')).toBe('P2-Medium');
    expect(priorityOf(db, 'TD-278')).toBe('P2-Medium');
    db.close();
  });

  it('does NOT fold P4-Trivial — no fold table declares a target', () => {
    const db = new Database(':memory:');
    buildSchemaAtV23(db);
    seedLiveCensus(db);

    migrateSchema(db);

    // Folding it to P3-Low would be INVENTING (TD-328's reasoning for Spike).
    expect(priorityOf(db, 'TD-002')).toBe('P4-Trivial');
    db.close();
  });

  it('folds the spaced-dash forms and every P{N} alias, including P0/P3', () => {
    const db = new Database(':memory:');
    buildSchemaAtV23(db);
    seed(db, { brief_id: 'A-1', priority: 'P0' });
    seed(db, { brief_id: 'A-2', priority: 'P0 - Critical' });
    seed(db, { brief_id: 'A-3', priority: 'P1 - High' });
    seed(db, { brief_id: 'A-4', priority: 'P2 - Medium' });
    seed(db, { brief_id: 'A-5', priority: 'P3' });
    seed(db, { brief_id: 'A-6', priority: 'P3 - Low' });

    migrateSchema(db);

    expect(priorityOf(db, 'A-1')).toBe('P0-Critical');
    expect(priorityOf(db, 'A-2')).toBe('P0-Critical');
    expect(priorityOf(db, 'A-3')).toBe('P1-High');
    expect(priorityOf(db, 'A-4')).toBe('P2-Medium');
    expect(priorityOf(db, 'A-5')).toBe('P3-Low');
    expect(priorityOf(db, 'A-6')).toBe('P3-Low');
    db.close();
  });

  it('NEVER bumps updated_at, and touches no other column (#230)', () => {
    const db = new Database(':memory:');
    buildSchemaAtV23(db);
    seedLiveCensus(db);
    const before = untouchedSnapshot(db);

    migrateSchema(db);

    // The load-bearing assertion: priority is an LWW sync column. A bumped
    // timestamp would make every folded row fight an un-migrated remote.
    expect(untouchedSnapshot(db)).toEqual(before);
    // ...and stated once more at the value level, so a snapshot-shape change
    // can never quietly make the assertion vacuous.
    const ts = db
      .prepare(`SELECT updated_at FROM brief_status WHERE project='p' AND brief_id='BR-045'`)
      .get() as { updated_at: string };
    expect(ts.updated_at).toBe(FIXED_TS);
    db.close();
  });

  it('preserves the row count exactly', () => {
    const db = new Database(':memory:');
    buildSchemaAtV23(db);
    seedLiveCensus(db);
    const before = (
      db.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }
    ).c;
    expect(before).toBe(11);

    migrateSchema(db);

    const after = (
      db.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }
    ).c;
    expect(after).toBe(before);
    db.close();
  });

  it('leaves already-canonical and already-NULL rows alone', () => {
    const db = new Database(':memory:');
    buildSchemaAtV23(db);
    seedLiveCensus(db);

    migrateSchema(db);

    expect(priorityOf(db, 'FR-001')).toBe('P0-Critical');
    expect(priorityOf(db, 'FR-002')).toBe('P3-Low');
    expect(priorityOf(db, 'FR-003')).toBeNull();
    db.close();
  });

  it("folds the unset family ('Unset' / blank) to NULL", () => {
    const db = new Database(':memory:');
    buildSchemaAtV23(db);
    seed(db, { brief_id: 'U-1', priority: 'Unset' });
    seed(db, { brief_id: 'U-2', priority: '' });
    seed(db, { brief_id: 'U-3', priority: '   ' });

    migrateSchema(db);

    expect(priorityOf(db, 'U-1')).toBeNull();
    expect(priorityOf(db, 'U-2')).toBeNull();
    expect(priorityOf(db, 'U-3')).toBeNull();
    db.close();
  });

  it('is idempotent — a re-run against an ALREADY-FOLDED corpus changes zero rows', () => {
    // Prove it at the statement level, not just via the schema_version gate:
    // re-run the exact fold statements on a v24 DB and assert 0 changes. This
    // is what makes the migration safe if the gate is ever bypassed.
    const db = new Database(':memory:');
    buildSchemaAtV23(db);
    seedLiveCensus(db);
    migrateSchema(db);

    const stmts = [
      `UPDATE brief_status SET priority = 'P0-Critical' WHERE priority IN ('P0', 'P0 - Critical')`,
      `UPDATE brief_status SET priority = 'P1-High' WHERE priority IN ('P1', 'P1 - High')`,
      `UPDATE brief_status SET priority = 'P2-Medium' WHERE priority IN ('P2', 'P2 - Medium')`,
      `UPDATE brief_status SET priority = 'P3-Low' WHERE priority IN ('P3', 'P3 - Low')`,
      `UPDATE brief_status SET priority = NULL
         WHERE priority = 'Unset' OR (priority IS NOT NULL AND TRIM(priority) = '')`,
    ];
    for (const sql of stmts) {
      expect(db.prepare(sql).run().changes, `re-run of ${sql} was not a no-op`).toBe(0);
    }
    db.close();
  });

  it('a second migrateSchema() is a no-op and leaves the version at 24', () => {
    const db = new Database(':memory:');
    buildSchemaAtV23(db);
    seedLiveCensus(db);
    migrateSchema(db);
    const afterFirst = untouchedSnapshot(db);
    const prioritiesAfterFirst = db
      .prepare(`SELECT brief_id, priority FROM brief_status WHERE project='p' ORDER BY brief_id`)
      .all();

    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(24);
    expect(untouchedSnapshot(db)).toEqual(afterFirst);
    expect(
      db
        .prepare(`SELECT brief_id, priority FROM brief_status WHERE project='p' ORDER BY brief_id`)
        .all(),
    ).toEqual(prioritiesAfterFirst);
    db.close();
  });

  it('chains from 22: v23 records, then the L-209 re-read lets v24 fire in the SAME pass', () => {
    // Documenting the real behaviour rather than a guessed one. v24's gate
    // re-reads `schema_version` (L-209) instead of trusting the value captured
    // at the top of migrateSchema, so a brain that enters at 22 leaves at 24 in
    // one call. That is the gate working, not a bypass — v24 still observed 23
    // as RECORDED before running.
    const db = new Database(':memory:');
    migrateSchema(db);
    for (let v = 13; v <= 22; v++) {
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
    }
    // The FR-127 briefs-component columns the `seed` helper writes (the engine
    // does not boot here, so add them by hand as buildSchemaAtV23 does).
    db.exec('ALTER TABLE brief_status ADD COLUMN claimed_by TEXT');
    db.exec('ALTER TABLE brief_status ADD COLUMN claimed_at TEXT');
    db.prepare(
      `INSERT OR IGNORE INTO projects (slug, name, path, status) VALUES ('p','p','/tmp/p','active')`,
    ).run();
    seed(db, { brief_id: 'BR-045', priority: 'P1' });

    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(24);
    expect(priorityOf(db, 'BR-045')).toBe('P1-High');
    db.close();
  });

  it('SKIPS WITHOUT RECORDING when brief_status is absent (partial/fixture schema)', () => {
    // The precondition gate. Recording v24 against a schema that has no
    // brief_status would falsely mark it migrated, and the fold would never run
    // once the table appeared. v13's skip-then-heal precedent.
    const db = new Database(':memory:');
    migrateSchema(db);
    for (let v = 13; v <= 23; v++) {
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
    }
    expect(getSchemaVersion(db)).toBe(23);
    db.exec('DROP TABLE brief_status');

    migrateSchema(db);

    // Not recorded — the next boot retries once the table is there.
    expect(getSchemaVersion(db)).toBe(23);
    db.close();
  });
});
