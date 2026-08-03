/**
 * Migration v22 Tests — TD-328 (brief_type vocabulary fold)
 *
 * Verifies the one-time idempotent DATA migration that folds the historical
 * `brief_status.brief_type` spellings to the canonical vocabulary:
 *   1. Unconditional alias folds (BRIEF_TYPE_ALIASES) + canonical case-fold.
 *   2. GATED compound folds (D4) — a compound folds to its head type only when
 *      the qualifier token survives in the row's own title or brief_files
 *      content; otherwise it is left alone.
 *   3. NULL prefix inference (D5) — FR-/TD-/TS-/PF-/… infer; `BR-` stays NULL.
 *   4. Ambiguous / no-target values pass through untouched (read-widen).
 *   5. Column safety — status/phase/title/claimed_by/updated_at/priority and
 *      brief_files.content byte-identical before and after (#230). `updated_at`
 *      in particular MUST NOT be bumped: brief_type is an LWW sync column, and
 *      a bumped timestamp would make folded local rows fight an un-migrated
 *      remote brain.
 *   6. Idempotency — a second migrateSchema() changes zero rows.
 *   7. Backup — `.pre-v22.bak` exists, OPENS, and its brief_status row count
 *      matches the pre-migration count (AC-2 reversibility).
 *   8. ABORT path — an unusable snapshot leaves the DB at v21 with the data
 *      UNFOLDED. v22 is destructive, so unlike v19 a failed snapshot is fatal.
 *   9. schema_version advances to exactly 22.
 *
 * Gate-dodge proof: this migration is DATA-only and has NO vec dependency, so
 * the suite runs WITHOUT loading sqlite-vec. On a vec-less machine the v13 vec
 * backfill stops the chain at v12, so we drive schema_version up to 21 manually
 * (INSERT OR IGNORE) before running migrateSchema — the L-209 re-read gate must
 * still fire v22 from version 21 regardless of how the chain reached it.
 *
 * Fixture discipline: every test uses a TEMP-FILE DB under `mkdtemp` (a file DB
 * is required to exercise the VACUUM INTO backup path) or `:memory:`. Nothing
 * here reads or writes `~/.igris/memory/knowledge.db`.
 *
 * @module __tests__/db-migration-v22
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

/**
 * Build the brain schema (tables) without vec, then force schema_version to
 * exactly 21 so the next migrateSchema() call fires v22.
 */
function buildSchemaAtV21(db: Database.Database): void {
  // First pass: create all tables (vec-less → chain stalls, tables exist).
  migrateSchema(db);
  // Top the version ladder up to 21 so v22's L-209 gate (>=21 && <22) fires.
  for (let v = 13; v <= 21; v++) {
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
  }
  // `claimed_by`/`claimed_at` live in the BRIEFS COMPONENT migration (FR-127),
  // not the legacy chain, and the component engine does not boot here. Add them
  // by hand so the fixture matches the real terminal shape — the "columns the
  // migration must not touch" assertion is only meaningful if they exist.
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

const FIXED_TS = '2026-01-01 00:00:00';

interface SeedRow {
  brief_id: string;
  brief_type: string | null;
  title?: string;
  status?: string;
  priority?: string | null;
  phase?: string | null;
  claimed_by?: string | null;
  /** Optional brief_files content, for the D4 qualifier check. */
  content?: string;
}

function seed(db: Database.Database, r: SeedRow): void {
  db.prepare(
    `INSERT INTO brief_status
       (project, brief_id, brief_type, title, status, priority, phase, claimed_by, updated_at)
     VALUES ('p', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.brief_id,
    r.brief_type,
    r.title ?? `T ${r.brief_id}`,
    r.status ?? 'Ready',
    r.priority ?? 'P2-Medium',
    r.phase ?? 'INIT',
    r.claimed_by ?? null,
    FIXED_TS,
  );
  if (r.content !== undefined) {
    db.prepare(
      `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
       VALUES (?, 'p', ?, ?, ?, 'h', ?)`,
    ).run(`p:${r.brief_id}`, r.brief_id, `${r.brief_id}.md`, r.content, FIXED_TS);
  }
}

function typeOf(db: Database.Database, briefId: string): string | null {
  const row = db
    .prepare(`SELECT brief_type FROM brief_status WHERE project='p' AND brief_id = ?`)
    .get(briefId) as { brief_type: string | null } | undefined;
  return row?.brief_type ?? null;
}

/** Snapshot every column the migration must NOT touch. */
function untouchedSnapshot(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT brief_id, title, status, priority, phase, claimed_by, updated_at
         FROM brief_status ORDER BY brief_id`,
    )
    .all();
}

/** The full spelling zoo observed in the live brain, in miniature. */
function seedSpellingZoo(db: Database.Database): void {
  // --- tech-debt family ---
  seed(db, { brief_id: 'TD-001', brief_type: 'Technical Debt' });
  seed(db, { brief_id: 'TD-002', brief_type: 'Debt' });
  seed(db, { brief_id: 'TD-003', brief_type: 'TD' });
  seed(db, { brief_id: 'TD-004', brief_type: 'TechDebt' });
  seed(db, { brief_id: 'TD-005', brief_type: 'TechnicalDebt' });
  seed(db, { brief_id: 'TD-006', brief_type: 'tech_debt' });
  seed(db, { brief_id: 'TD-007', brief_type: 'Tech-Debt' });
  seed(db, { brief_id: 'TD-008', brief_type: 'Tech Debt' });
  seed(db, { brief_id: 'TD-009', brief_type: 'debt' });
  seed(db, { brief_id: 'TD-010', brief_type: 'Chore' });
  // --- feature family ---
  seed(db, { brief_id: 'FR-001', brief_type: 'Feature' });
  seed(db, { brief_id: 'FR-002', brief_type: 'Feature Request' });
  seed(db, { brief_id: 'FR-003', brief_type: 'FR' });
  seed(db, { brief_id: 'FR-004', brief_type: 'FeatureRequest' });
  seed(db, { brief_id: 'FR-005', brief_type: 'Enhancement' });
  seed(db, { brief_id: 'FR-006', brief_type: 'Feature Enhancement' });
  // --- bug family ---
  seed(db, { brief_id: 'BR-001', brief_type: 'Bug' });
  seed(db, { brief_id: 'BR-002', brief_type: 'BugFix' });
  seed(db, { brief_id: 'BR-003', brief_type: 'Bug Fix' });
  // --- promoted types + variants ---
  seed(db, { brief_id: 'AC-001', brief_type: 'Architecture' });
  seed(db, { brief_id: 'AC-002', brief_type: 'ArchitectureCleanup' });
  seed(db, { brief_id: 'DU-001', brief_type: 'Dependency Update' });
  seed(db, { brief_id: 'DU-002', brief_type: 'DependencyUpdate' });
  seed(db, { brief_id: 'BR-010', brief_type: 'Refactor' });
  seed(db, { brief_id: 'BR-011', brief_type: 'Refactoring' });
  // --- single-word spellings ---
  seed(db, { brief_id: 'TD-020', brief_type: 'Doc' });
  seed(db, { brief_id: 'TS-001', brief_type: 'Test' });
  seed(db, { brief_id: 'PI-001', brief_type: 'Process' });
  seed(db, { brief_id: 'PI-002', brief_type: 'Release' });
  // --- case variants of canonical ---
  seed(db, { brief_id: 'FR-020', brief_type: 'feature' });
  seed(db, { brief_id: 'BR-020', brief_type: '  BUG  ' });
  // --- deliberately unfolded (ambiguous / no defensible target) ---
  seed(db, { brief_id: 'BR-030', brief_type: 'BR' });
  seed(db, { brief_id: 'BR-031', brief_type: 'Spike' });
  seed(db, { brief_id: 'BR-032', brief_type: 'Investigation' });
  seed(db, { brief_id: 'INT-001', brief_type: 'Integration' });
  seed(db, { brief_id: 'BR-033', brief_type: 'Bug/Feature' });
  seed(db, { brief_id: 'BR-034', brief_type: 'Frobnicate' });
}

/** The D4 compound cases: one recoverable, one not, per head type. */
function seedCompounds(db: Database.Database): void {
  // Qualifier in the TITLE → RECOVERABLE → folds.
  seed(db, {
    brief_id: 'BR-100',
    brief_type: 'Bug Fix / Refactor',
    title: 'Audio Showcase BGM Playlist Refactor',
  });
  // Qualifier in the CONTENT → RECOVERABLE → folds.
  seed(db, {
    brief_id: 'BR-101',
    brief_type: 'Bug Fix / Compliance',
    title: 'Forms Demo — Use fifty_forms Package',
    content: 'The widget must reach compliance with the design system.',
  });
  // Qualifier NOWHERE → NOT RECOVERABLE → left unfolded.
  seed(db, {
    brief_id: 'BR-102',
    brief_type: 'Feature / Infrastructure',
    title: 'Higgsfield MCP Server (Full Platform SDK)',
    content: 'Wire the SDK and ship the tool surface.',
  });
  // Word-boundary token: ' ui ' must not match "build"/"guide".
  seed(db, {
    brief_id: 'BR-103',
    brief_type: 'Feature / UI Enhancement',
    title: 'BGM Playlist UI Redesign',
  });
  seed(db, {
    brief_id: 'BR-104',
    brief_type: 'Feature / UI Enhancement',
    title: 'Build a guide for the requirements',
    content: 'Nothing about the interface here.',
  });
}

/** NULL-type rows across every prefix class. */
function seedNulls(db: Database.Database): void {
  seed(db, { brief_id: 'FR-900', brief_type: null });
  seed(db, { brief_id: 'TD-900', brief_type: null });
  seed(db, { brief_id: 'TS-900', brief_type: null });
  seed(db, { brief_id: 'PF-900', brief_type: null });
  seed(db, { brief_id: 'MG-900', brief_type: null });
  seed(db, { brief_id: 'PI-900', brief_type: null });
  seed(db, { brief_id: 'DU-900', brief_type: null });
  seed(db, { brief_id: 'AC-900', brief_type: null });
  // Ambiguous mint prefix — MUST stay NULL.
  seed(db, { brief_id: 'BR-900', brief_type: null });
  seed(db, { brief_id: 'BR-901', brief_type: null });
  // Not a mint prefix — MUST stay NULL.
  seed(db, { brief_id: 'INT-900', brief_type: null });
  seed(db, { brief_id: 'malformed', brief_type: null });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migration v22 — brief_type vocabulary fold (TD-328)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td328-v22-'));
    dbPath = path.join(tmpDir, 'knowledge.db');
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    buildSchemaAtV21(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records v22 in the ladder and carries the chain to its terminal', () => {
    expect(getSchemaVersion(db)).toBe(21);
    migrateSchema(db);
    // THE CLAIM THIS TEST OWNS is that **v22 applied**, so it asserts v22's own
    // ladder row directly. It used to assert `MAX(version) === 22`, which meant
    // the same thing only while v22 was the last migration — FR-246 added v23
    // and the test went red for a reason that has nothing to do with v22.
    expect(db.prepare('SELECT 1 FROM schema_version WHERE version = 22').get()).toBeDefined();
    // ...and the chain runs to completion in the same call. This number moves
    // with every migration, by design: it is the assertion that notices when a
    // new migration silently fails to run.
    expect(getSchemaVersion(db)).toBe(23);
  });

  it('folds every unconditional alias to its canonical type', () => {
    seedSpellingZoo(db);
    migrateSchema(db);

    for (const id of [
      'TD-001',
      'TD-002',
      'TD-003',
      'TD-004',
      'TD-005',
      'TD-006',
      'TD-007',
      'TD-008',
      'TD-009',
      'TD-010',
    ]) {
      expect(typeOf(db, id), id).toBe('Technical Debt');
    }
    for (const id of ['FR-001', 'FR-002', 'FR-003', 'FR-004', 'FR-005', 'FR-006', 'FR-020']) {
      expect(typeOf(db, id), id).toBe('Feature');
    }
    for (const id of ['BR-001', 'BR-002', 'BR-003', 'BR-020']) {
      expect(typeOf(db, id), id).toBe('Bug');
    }
    expect(typeOf(db, 'AC-001')).toBe('Architecture');
    expect(typeOf(db, 'AC-002')).toBe('Architecture');
    expect(typeOf(db, 'DU-001')).toBe('Dependency Update');
    expect(typeOf(db, 'DU-002')).toBe('Dependency Update');
    // D2 sign-off: Refactor is CANONICAL, Refactoring folds INTO it.
    expect(typeOf(db, 'BR-010')).toBe('Refactor');
    expect(typeOf(db, 'BR-011')).toBe('Refactor');
    expect(typeOf(db, 'TD-020')).toBe('Documentation');
    expect(typeOf(db, 'TS-001')).toBe('Testing');
    expect(typeOf(db, 'PI-001')).toBe('Process Improvement');
    expect(typeOf(db, 'PI-002')).toBe('Process Improvement');
  });

  it('leaves ambiguous / no-target values untouched (read-widen preserved)', () => {
    seedSpellingZoo(db);
    migrateSchema(db);

    // `BR` maps to both bug and feature at the mint surface — folding it would
    // mistype an unknown number of rows.
    expect(typeOf(db, 'BR-030')).toBe('BR');
    expect(typeOf(db, 'BR-031')).toBe('Spike');
    expect(typeOf(db, 'BR-032')).toBe('Investigation');
    expect(typeOf(db, 'INT-001')).toBe('Integration');
    // Two types, no head type.
    expect(typeOf(db, 'BR-033')).toBe('Bug/Feature');
    // A 51st spelling still survives the migration — never drop operator data.
    expect(typeOf(db, 'BR-034')).toBe('Frobnicate');
  });

  it('folds a compound ONLY when its qualifier survives in title/content (D4)', () => {
    seedCompounds(db);
    migrateSchema(db);

    // Qualifier in the title.
    expect(typeOf(db, 'BR-100')).toBe('Bug');
    // Qualifier in brief_files.content.
    expect(typeOf(db, 'BR-101')).toBe('Bug');
    // Qualifier nowhere — left unfolded and reportable, NOT quietly damaged.
    expect(typeOf(db, 'BR-102')).toBe('Feature / Infrastructure');
    // ' ui ' word-boundary token matches "Playlist UI Redesign"…
    expect(typeOf(db, 'BR-103')).toBe('Feature');
    // …but must NOT match "build"/"guide"/"requirements".
    expect(typeOf(db, 'BR-104')).toBe('Feature / UI Enhancement');
  });

  it('infers NULL types from unambiguous mint prefixes and leaves BR- NULL (D5)', () => {
    seedNulls(db);
    migrateSchema(db);

    expect(typeOf(db, 'FR-900')).toBe('Feature');
    expect(typeOf(db, 'TD-900')).toBe('Technical Debt');
    expect(typeOf(db, 'TS-900')).toBe('Testing');
    expect(typeOf(db, 'PF-900')).toBe('Performance');
    expect(typeOf(db, 'MG-900')).toBe('Migration');
    expect(typeOf(db, 'PI-900')).toBe('Process Improvement');
    expect(typeOf(db, 'DU-900')).toBe('Dependency Update');
    expect(typeOf(db, 'AC-900')).toBe('Architecture');

    // The load-bearing negative: /register maps BOTH bug and feature to BR-.
    expect(typeOf(db, 'BR-900')).toBeNull();
    expect(typeOf(db, 'BR-901')).toBeNull();
    // Not a mint prefix / malformed id.
    expect(typeOf(db, 'INT-900')).toBeNull();
    expect(typeOf(db, 'malformed')).toBeNull();
  });

  it('touches ONLY brief_type — every other column is byte-identical', () => {
    seedSpellingZoo(db);
    seedCompounds(db);
    seedNulls(db);
    // A claimed, in-flight, non-default row to make the assertion meaningful.
    seed(db, {
      brief_id: 'TD-777',
      brief_type: 'TechDebt',
      status: 'In Progress',
      priority: 'P0-Critical',
      phase: 'BUILDING',
      claimed_by: 'igris@host',
      content: '# TD-777\n\nbody',
    });

    const before = untouchedSnapshot(db);
    const contentBefore = db
      .prepare('SELECT brief_id, content, content_hash, updated_at FROM brief_files ORDER BY brief_id')
      .all();

    migrateSchema(db);

    // The fold happened…
    expect(typeOf(db, 'TD-777')).toBe('Technical Debt');
    // …and NOTHING else moved. `updated_at` in particular: bumping it would
    // make folded local rows fight an un-migrated remote brain over LWW.
    expect(untouchedSnapshot(db)).toEqual(before);
    expect(
      db
        .prepare('SELECT brief_id, content, content_hash, updated_at FROM brief_files ORDER BY brief_id')
        .all(),
    ).toEqual(contentBefore);
  });

  it('is idempotent — a second migrateSchema() changes zero rows', () => {
    seedSpellingZoo(db);
    seedCompounds(db);
    seedNulls(db);

    migrateSchema(db);
    const afterFirst = db
      .prepare('SELECT brief_id, brief_type, updated_at FROM brief_status ORDER BY brief_id')
      .all();

    migrateSchema(db);
    const afterSecond = db
      .prepare('SELECT brief_id, brief_type, updated_at FROM brief_status ORDER BY brief_id')
      .all();

    expect(afterSecond).toEqual(afterFirst);
    expect(getSchemaVersion(db)).toBe(23);
  });

  it('is idempotent even with the version gate removed (the UPDATEs self-guard)', () => {
    seedSpellingZoo(db);
    migrateSchema(db);
    const afterFirst = db
      .prepare('SELECT brief_id, brief_type FROM brief_status ORDER BY brief_id')
      .all();

    // Force the gate open again and re-run: the WHERE guards must still make
    // every statement a no-op. This is the property that lets the backfill
    // script and the migration both run without fighting.
    db.prepare('DELETE FROM schema_version WHERE version = 22').run();
    migrateSchema(db);

    expect(
      db.prepare('SELECT brief_id, brief_type FROM brief_status ORDER BY brief_id').all(),
    ).toEqual(afterFirst);
  });

  it('writes a .pre-v22.bak that OPENS and row-count-matches the source (AC-2)', () => {
    seedSpellingZoo(db);
    const preCount = (
      db.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }
    ).c;

    migrateSchema(db);

    const bakPath = `${dbPath}.pre-v22.bak`;
    expect(fs.existsSync(bakPath)).toBe(true);

    // "Verified openable" means opened and read, not merely present on disk.
    const bak = new Database(bakPath, { readonly: true });
    try {
      expect((bak.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]
        .integrity_check).toBe('ok');
      const bakCount = (
        bak.prepare('SELECT COUNT(*) AS c FROM brief_status').get() as { c: number }
      ).c;
      expect(bakCount).toBe(preCount);
      // And it holds the PRE-fold spellings — which is what makes it an undo.
      const stale = bak
        .prepare(`SELECT brief_type FROM brief_status WHERE brief_id = 'TD-003'`)
        .get() as { brief_type: string };
      expect(stale.brief_type).toBe('TD');
    } finally {
      bak.close();
    }
  });

  it('ABORTS at v21 when the snapshot is unusable — the fold must not run', () => {
    seedSpellingZoo(db);

    // Plant a corrupt file where the snapshot would go. The migration's
    // existsSync guard skips the VACUUM, then the verification step tries to
    // OPEN it and fails — which is exactly the "snapshot cannot be verified"
    // case. v22 is destructive, so this MUST abort (v19 would have continued).
    fs.writeFileSync(`${dbPath}.pre-v22.bak`, 'this is not a sqlite database');

    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(21);
    // The data is UNFOLDED — no partial mutation.
    expect(typeOf(db, 'TD-003')).toBe('TD');
    expect(typeOf(db, 'FR-002')).toBe('Feature Request');
  });

  it('retries successfully once the bad snapshot is cleared', () => {
    seedSpellingZoo(db);
    fs.writeFileSync(`${dbPath}.pre-v22.bak`, 'not a database');
    migrateSchema(db);
    expect(getSchemaVersion(db)).toBe(21);

    fs.rmSync(`${dbPath}.pre-v22.bak`);
    migrateSchema(db);

    expect(getSchemaVersion(db)).toBe(23);
    expect(typeOf(db, 'TD-003')).toBe('Technical Debt');
  });

  it('collapses the spelling zoo to the canonical types PLUS the enumerated deliberate residue', () => {
    seedSpellingZoo(db);
    seedCompounds(db);
    seedNulls(db);

    const before = (
      db
        .prepare('SELECT COUNT(DISTINCT brief_type) AS c FROM brief_status')
        .get() as { c: number }
    ).c;

    migrateSchema(db);

    const after = db
      .prepare(
        `SELECT DISTINCT brief_type FROM brief_status
           WHERE brief_type IS NOT NULL ORDER BY brief_type`,
      )
      .all() as Array<{ brief_type: string }>;

    expect(after.length).toBeLessThan(before);
    // The exact post-fold set. NOTE: 8 of these 19 are NOT canonical — they are
    // the deliberate residue (ambiguous `BR`, the 3 compounds whose qualifier
    // failed the D4 per-row gate, `Bug/Feature` with no head type, and the
    // no-defensible-target singletons). Pinning them here is the point: the
    // fold must leave EXACTLY this residue and no more, and the D6 validator
    // reports every one of them. A shorter list would mean something folded
    // that should not have.
    expect(after.map((r) => r.brief_type)).toEqual([
      'Architecture',
      'BR',
      'Bug',
      'Bug/Feature',
      'Dependency Update',
      'Documentation',
      'Feature',
      'Feature / Infrastructure',
      'Feature / UI Enhancement',
      'Frobnicate',
      'Integration',
      'Investigation',
      'Migration',
      'Performance',
      'Process Improvement',
      'Refactor',
      'Spike',
      'Technical Debt',
      'Testing',
    ]);
  });
});

describe('migration v22 — :memory: DBs skip the snapshot (v19 precedent)', () => {
  it('folds an in-memory DB with no backup file', () => {
    const mem = new Database(':memory:');
    try {
      mem.pragma('foreign_keys = ON');
      buildSchemaAtV21(mem);
      seed(mem, { brief_id: 'TD-001', brief_type: 'TechDebt' });

      migrateSchema(mem);

      expect(typeOf(mem, 'TD-001')).toBe('Technical Debt');
      // v23 skips its snapshot on `:memory:` for the same reason and by the
      // same branch, so the chain still reaches its terminal here.
      expect(getSchemaVersion(mem)).toBe(23);
    } finally {
      mem.close();
    }
  });
});
