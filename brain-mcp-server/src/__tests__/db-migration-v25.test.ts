/**
 * Migration v25 Tests — TD-333 (status vocabulary fold)
 *
 * Verifies the one-time idempotent DATA migration that folds the
 * `brief_status.status` spellings to the documented lifecycle: `Completed` /
 * `Complete` -> `Done` and `InProgress` -> `In Progress`, plus a canonical
 * case-fold.
 *
 * `status` is the CANONICAL BUILD-STATE SOURCE, so the load-bearing assertions
 * here are the NEGATIVE ones — what the migration must NOT do:
 *   1. The three folds land, and nothing else moves.
 *   2. `Cancelled` / `Superseded` / `Deferred` are UNTOUCHED. They are MISSING
 *      STATES, not spellings; folding one would be a STATE EDIT (TD-311).
 *   3. `Done(Resolvedbydec8d1f)` is UNTOUCHED — the sha is operator data with
 *      no other copy, so a mechanical fold would destroy it.
 *   4. The two `Split (see FR-...)` SENTENCES are UNTOUCHED — three defensible
 *      targets, and the operator chose none of them.
 *   5. `updated_at` is byte-identical before and after. `status` is an LWW sync
 *      column; a bumped timestamp would make folded local rows fight an
 *      un-migrated remote.
 *   6. Column safety — priority/phase/title/brief_type/claimed_by untouched.
 *   7. Row-count AND (project, brief_id) SET invariance: no row created,
 *      deleted, or moved between briefs.
 *   8. Idempotency, and schema_version advancing to exactly 25.
 *   9. The verified-backup ABORT: an unusable snapshot leaves the DB at v24
 *      with ZERO rows folded (v25 is destructive — the old spelling is
 *      unrecoverable from the row).
 *
 * Gate-dodge proof: this migration is DATA-only with NO vec and NO FTS
 * dependency, so the suite runs WITHOUT loading sqlite-vec. schema_version is
 * driven up to 24 manually — the L-209 re-read gate must still fire v25 from
 * version 24 regardless of how the chain got there.
 *
 * Fixture discipline: every test uses `:memory:` or a temp-file DB under
 * `mkdtemp`. Nothing here reads or writes `~/.igris/memory/knowledge.db`.
 *
 * @module __tests__/db-migration-v25
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSchema } from '../db.js';
import { CANONICAL_STATUSES, STATUS_ALIASES, normalizeStatus } from '../tools/brief-normalize.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'igris-v25-'));
  tmpDirs.push(d);
  return d;
}

function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

/**
 * Build the brain schema (tables) without vec, then force schema_version to
 * exactly 24 so the next migrateSchema() call fires v25.
 */
function buildSchemaAtV24(db: Database.Database): void {
  migrateSchema(db);
  for (let v = 13; v <= 24; v++) {
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

const FIXED_TS = '2026-08-02 10:58:23';

interface SeedRow {
  brief_id: string;
  status: string;
  priority?: string | null;
  brief_type?: string | null;
  title?: string;
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
    r.status,
    r.priority ?? 'P2-Medium',
    r.phase ?? 'DONE',
    r.claimed_by ?? null,
    r.updated_at ?? FIXED_TS,
  );
}

function statusOf(db: Database.Database, briefId: string): string | null {
  const row = db
    .prepare(`SELECT status FROM brief_status WHERE project='p' AND brief_id = ?`)
    .get(briefId) as { status: string | null } | undefined;
  return row?.status ?? null;
}

/** Snapshot every column the migration must NOT touch — updated_at first. */
function untouchedSnapshot(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT brief_id, updated_at, brief_type, title, priority, phase, claimed_by, claimed_at
         FROM brief_status WHERE project='p' ORDER BY brief_id`,
    )
    .all();
}

function statusCensus(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS c FROM brief_status WHERE project='p' GROUP BY status`)
    .all() as Array<{ status: string; c: number }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.c]));
}

const SENTENCE_A = 'Split (see FR-061, FR-062, FR-063)';
const SENTENCE_B = 'Split (see FR-161, FR-162, FR-163, FR-164, FR-165, FR-166, FR-167)';
const WELDED = 'Done(Resolvedbydec8d1f)';

/**
 * The exact census measured read-only on the operator brain (2026-08-04),
 * scaled down but keeping every distinct VALUE and the shape of the three fold
 * families plus every deliberate non-fold.
 */
function seedLiveCensus(db: Database.Database): void {
  // fold sources
  for (let i = 1; i <= 24; i++) {
    seed(db, { brief_id: `BR-0${String(i).padStart(2, '0')}`, status: 'Completed' });
  }
  seed(db, { brief_id: 'TD-001', status: 'Complete' });
  seed(db, { brief_id: 'BR-002x', status: 'InProgress', phase: 'BUILDING' });
  seed(db, { brief_id: 'BR-003x', status: 'InProgress', phase: 'BUILDING' });
  seed(db, { brief_id: 'BR-004x', status: 'InProgress', phase: 'BUILDING' });
  seed(db, { brief_id: 'TS-003', status: 'InProgress', phase: 'BUILDING' });
  // canonical controls
  seed(db, { brief_id: 'FR-001', status: 'Done', phase: 'COMPLETE' });
  seed(db, { brief_id: 'FR-002', status: 'Archived', phase: 'COMPLETE' });
  seed(db, { brief_id: 'FR-003', status: 'Ready', phase: 'INIT' });
  seed(db, { brief_id: 'FR-004', status: 'Draft', phase: 'INIT' });
  seed(db, { brief_id: 'FR-005', status: 'In Progress', phase: 'BUILDING' });
  seed(db, { brief_id: 'FR-006', status: 'Blocked', phase: 'BLOCKED' });
  // MISSING STATES — must NOT fold
  for (let i = 1; i <= 23; i++) {
    seed(db, { brief_id: `CA-${String(i).padStart(3, '0')}`, status: 'Cancelled' });
  }
  for (let i = 1; i <= 18; i++) {
    seed(db, { brief_id: `SU-${String(i).padStart(3, '0')}`, status: 'Superseded' });
  }
  for (let i = 1; i <= 7; i++) {
    seed(db, { brief_id: `DE-${String(i).padStart(3, '0')}`, status: 'Deferred' });
  }
  // welded payload + the two sentences — must NOT fold
  seed(db, { brief_id: 'BR-128', status: WELDED, phase: 'COMMITTING' });
  seed(db, { brief_id: 'FR-054', status: SENTENCE_A, phase: null });
  seed(db, { brief_id: 'FR-160', status: SENTENCE_B, phase: 'COMPLETE' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v25 — status vocabulary fold (TD-333)', () => {
  it('folds the 29 live fold-source rows and advances schema_version to 25', () => {
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    seedLiveCensus(db);
    expect(getSchemaVersion(db)).toBe(24);

    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(25);
    const census = statusCensus(db);
    // The three fold SOURCES are gone.
    expect(census.Completed).toBeUndefined();
    expect(census.Complete).toBeUndefined();
    expect(census.InProgress).toBeUndefined();
    // ...and their rows landed in the right targets: Done 1 + 24 + 1,
    // In Progress 1 + 4.
    expect(census.Done).toBe(26);
    expect(census['In Progress']).toBe(5);
  });

  it('leaves the three MISSING STATES byte-identical — folding one is a STATE EDIT', () => {
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    seedLiveCensus(db);

    migrateSchema(db);

    const census = statusCensus(db);
    expect(census.Cancelled).toBe(23);
    expect(census.Superseded).toBe(18);
    expect(census.Deferred).toBe(7);
    // ...and nothing crept into a terminal bucket to compensate.
    expect(census.Archived).toBe(1);
  });

  it('leaves the WELDED-PAYLOAD status byte-identical — the sha has no other copy', () => {
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    seedLiveCensus(db);

    migrateSchema(db);

    // A mechanical fold to `Done` would destroy the only record of the closing
    // commit. It is hand-migrated instead (payload first, then retype).
    expect(statusOf(db, 'BR-128')).toBe(WELDED);
  });

  it('leaves both SENTENCE statuses byte-identical — no fold, no truncation', () => {
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    seedLiveCensus(db);

    migrateSchema(db);

    expect(statusOf(db, 'FR-054')).toBe(SENTENCE_A);
    expect(statusOf(db, 'FR-160')).toBe(SENTENCE_B);
  });

  it('NEVER bumps updated_at, and touches no other column', () => {
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    seedLiveCensus(db);
    const before = untouchedSnapshot(db);

    migrateSchema(db);

    // THE load-bearing assertion. `status` is in both packages' sync column
    // sets, so a bumped timestamp would manufacture a write no operator made
    // and make the folded rows fight an un-migrated remote.
    expect(untouchedSnapshot(db)).toEqual(before);
  });

  it('preserves the row count AND the (project, brief_id) set exactly', () => {
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    seedLiveCensus(db);
    const keysBefore = db
      .prepare(`SELECT project, brief_id FROM brief_status ORDER BY project, brief_id`)
      .all();
    const countBefore = (
      db.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }
    ).c;

    migrateSchema(db);

    expect((db.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }).c).toBe(
      countBefore,
    );
    expect(
      db
        .prepare(`SELECT project, brief_id FROM brief_status ORDER BY project, brief_id`)
        .all(),
    ).toEqual(keysBefore);
  });

  it('the set of rows that CHANGED equals the fold-source set exactly', () => {
    // "No brief changes which state it is IN", made executable: every row whose
    // status moved must be one the fold table names, and its new value must be
    // exactly what `normalizeStatus` returns for its old one.
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    seedLiveCensus(db);
    const before = new Map(
      (
        db
          .prepare(`SELECT brief_id, status FROM brief_status WHERE project='p'`)
          .all() as Array<{ brief_id: string; status: string }>
      ).map((r) => [r.brief_id, r.status]),
    );

    migrateSchema(db);

    const after = new Map(
      (
        db
          .prepare(`SELECT brief_id, status FROM brief_status WHERE project='p'`)
          .all() as Array<{ brief_id: string; status: string }>
      ).map((r) => [r.brief_id, r.status]),
    );

    const moved: string[] = [];
    for (const [id, oldStatus] of before) {
      const newStatus = after.get(id);
      // Every row's new value is what the SINGLE-SOURCE normalizer would give.
      expect(newStatus, `${id}: ${oldStatus}`).toBe(normalizeStatus(oldStatus));
      if (newStatus !== oldStatus) moved.push(id);
    }
    // ...and only rows whose OLD spelling is a declared alias moved.
    for (const id of moved) {
      const oldStatus = before.get(id) as string;
      expect(
        STATUS_ALIASES[oldStatus.trim().toLowerCase()] !== undefined,
        `${id} moved from a value the fold table does not declare: ${oldStatus}`,
      ).toBe(true);
    }
    expect(moved).toHaveLength(29);
  });

  it('every post-fold value is either canonical or a deliberately-unfolded one', () => {
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    seedLiveCensus(db);

    migrateSchema(db);

    const allowed = new Set<string>([
      ...CANONICAL_STATUSES,
      'Cancelled',
      'Superseded',
      'Deferred',
      WELDED,
      SENTENCE_A,
      SENTENCE_B,
    ]);
    for (const value of Object.keys(statusCensus(db))) {
      expect(allowed.has(value), `unexpected post-fold status: ${value}`).toBe(true);
    }
  });

  it('case-folds a canonical status and leaves an already-canonical row alone', () => {
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    seed(db, { brief_id: 'FR-010', status: 'done' });
    seed(db, { brief_id: 'FR-011', status: '  ARCHIVED  ' });
    seed(db, { brief_id: 'FR-012', status: 'in progress' });
    seed(db, { brief_id: 'FR-013', status: 'Done' });

    migrateSchema(db);

    expect(statusOf(db, 'FR-010')).toBe('Done');
    expect(statusOf(db, 'FR-011')).toBe('Archived');
    expect(statusOf(db, 'FR-012')).toBe('In Progress');
    expect(statusOf(db, 'FR-013')).toBe('Done');
  });

  it('is idempotent — a re-run against an ALREADY-FOLDED corpus changes zero rows', () => {
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    seedLiveCensus(db);

    migrateSchema(db);
    const afterFirst = db
      .prepare(`SELECT brief_id, status, updated_at FROM brief_status ORDER BY brief_id`)
      .all();

    // Re-open the version gate and run the fold statements a second time.
    db.prepare('DELETE FROM schema_version WHERE version = 25').run();
    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(25);
    expect(
      db
        .prepare(`SELECT brief_id, status, updated_at FROM brief_status ORDER BY brief_id`)
        .all(),
    ).toEqual(afterFirst);
  });

  it('a second migrateSchema() is a no-op and leaves the version at 25', () => {
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    seedLiveCensus(db);

    migrateSchema(db);
    const snapshot = db.prepare(`SELECT * FROM brief_status ORDER BY brief_id`).all();
    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(25);
    expect(db.prepare(`SELECT * FROM brief_status ORDER BY brief_id`).all()).toEqual(snapshot);
  });

  it('chains from 23: v24 records, then the L-209 re-read lets v25 fire in the SAME pass', () => {
    const db = new Database(':memory:');
    migrateSchema(db);
    for (let v = 13; v <= 23; v++) {
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
    }
    db.exec('ALTER TABLE brief_status ADD COLUMN claimed_by TEXT');
    db.exec('ALTER TABLE brief_status ADD COLUMN claimed_at TEXT');
    db.prepare(
      `INSERT OR IGNORE INTO projects (slug, name, path, status) VALUES ('p','p','/tmp/p','active')`,
    ).run();
    seed(db, { brief_id: 'BR-001', status: 'Completed', priority: 'P1' });

    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(25);
    expect(statusOf(db, 'BR-001')).toBe('Done');
    // ...and v24 still ran on the way past.
    expect(
      (
        db
          .prepare(`SELECT priority FROM brief_status WHERE brief_id='BR-001'`)
          .get() as { priority: string }
      ).priority,
    ).toBe('P1-High');
  });

  it('SKIPS WITHOUT RECORDING when brief_status is absent (partial/fixture schema)', () => {
    const db = new Database(':memory:');
    migrateSchema(db);
    for (let v = 13; v <= 24; v++) {
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
    }
    expect(getSchemaVersion(db)).toBe(24);
    db.exec('DROP TABLE brief_status');

    migrateSchema(db);

    // Not recorded — the next boot retries once the table is there.
    expect(getSchemaVersion(db)).toBe(24);
  });

  it('the scope guard: no other table with a `status` column is touched', () => {
    // `projects.status` is a live column with its own vocabulary, guarded by
    // `CHECK (status IN ('active','archived','inactive'))` — all LOWERCASE. The
    // canonical case-fold arm would rewrite `archived` to `Archived` if it
    // operated by column NAME rather than by table, which would also violate
    // that CHECK. v25 names `brief_status` explicitly; this proves it.
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    db.prepare(
      `INSERT OR IGNORE INTO projects (slug, name, path, status) VALUES ('q','q','/tmp/q','archived')`,
    ).run();
    seed(db, { brief_id: 'BR-001', status: 'Completed' });
    seed(db, { brief_id: 'BR-002', status: 'archived' });

    migrateSchema(db);

    expect(statusOf(db, 'BR-001')).toBe('Done');
    // The brief_status row DID case-fold...
    expect(statusOf(db, 'BR-002')).toBe('Archived');
    // ...and the projects row did NOT.
    expect(
      (db.prepare(`SELECT status FROM projects WHERE slug='q'`).get() as { status: string })
        .status,
    ).toBe('archived');
  });
});

describe('v25 — the verified-backup ABORT (v25 is DESTRUCTIVE)', () => {
  it('writes and verifies a .pre-v25.bak snapshot for a FILE db, then folds', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'knowledge.db');
    const db = new Database(dbPath);
    buildSchemaAtV24(db);
    seed(db, { brief_id: 'BR-001', status: 'Completed' });

    migrateSchema(db);

    expect(existsSync(`${dbPath}.pre-v25.bak`)).toBe(true);
    expect(getSchemaVersion(db)).toBe(25);
    expect(statusOf(db, 'BR-001')).toBe('Done');

    // The snapshot must hold the PRE-fold spelling — that is what makes it a
    // usable restore point for a destructive fold.
    const bak = new Database(`${dbPath}.pre-v25.bak`, { readonly: true });
    expect(
      (
        bak
          .prepare(`SELECT status FROM brief_status WHERE brief_id='BR-001'`)
          .get() as { status: string }
      ).status,
    ).toBe('Completed');
    bak.close();
    db.close();
  });

  it('ABORTS at v24 and folds NOTHING when the snapshot is unusable', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'knowledge.db');
    const db = new Database(dbPath);
    buildSchemaAtV24(db);
    seed(db, { brief_id: 'BR-001', status: 'Completed' });
    seed(db, { brief_id: 'BR-002', status: 'InProgress' });

    // Plant a pre-existing, CORRUPT snapshot. The migration reuses an existing
    // file rather than overwriting it, then PROVES it — and this one cannot be
    // opened as a database.
    writeFileSync(`${dbPath}.pre-v25.bak`, 'not a sqlite database at all\n');

    migrateSchema(db);

    // The whole point: no verified backup => no destructive fold, and the
    // version does NOT advance, so the next boot retries.
    expect(getSchemaVersion(db)).toBe(24);
    expect(statusOf(db, 'BR-001')).toBe('Completed');
    expect(statusOf(db, 'BR-002')).toBe('InProgress');
    db.close();
  });

  it('ABORTS when the snapshot is a VALID db with the wrong row count', () => {
    // The subtler failure: a snapshot that opens cleanly and passes
    // integrity_check but is not a snapshot of THIS database. Only the row-count
    // proof catches it.
    const dir = makeTmpDir();
    const dbPath = join(dir, 'knowledge.db');
    const db = new Database(dbPath);
    buildSchemaAtV24(db);
    seed(db, { brief_id: 'BR-001', status: 'Completed' });
    seed(db, { brief_id: 'BR-002', status: 'Completed' });

    const decoy = new Database(`${dbPath}.pre-v25.bak`);
    decoy.exec(`CREATE TABLE brief_status (project TEXT, brief_id TEXT, status TEXT)`);
    decoy.close();

    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(24);
    expect(statusOf(db, 'BR-001')).toBe('Completed');
    db.close();
  });

  it('ABORTS when the snapshot cannot be written at all', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'knowledge.db');
    const db = new Database(dbPath);
    buildSchemaAtV24(db);
    seed(db, { brief_id: 'BR-001', status: 'Completed' });

    // Make the directory read-only so VACUUM INTO fails.
    chmodSync(dir, 0o500);
    try {
      migrateSchema(db);
    } finally {
      chmodSync(dir, 0o700);
    }

    expect(getSchemaVersion(db)).toBe(24);
    expect(statusOf(db, 'BR-001')).toBe('Completed');
    db.close();
  });

  it('takes NO snapshot for an in-memory db (nothing to lose, nowhere to put it)', () => {
    const db = new Database(':memory:');
    buildSchemaAtV24(db);
    seed(db, { brief_id: 'BR-001', status: 'Completed' });

    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(25);
    expect(statusOf(db, 'BR-001')).toBe('Done');
    expect(existsSync(':memory:.pre-v25.bak')).toBe(false);
  });
});
