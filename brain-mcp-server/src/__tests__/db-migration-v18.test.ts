/**
 * Migration v18 Tests — TD-238 (brief metadata normalization + C1 reconciliation)
 *
 * Verifies the one-time idempotent DATA migration:
 *   1. Priority fold — bare/spaced legacy forms → canonical P{N}-{Word};
 *      the "unset" family ('Unset' / empty / whitespace) → NULL.
 *   2. brief_type fold — 'Tech Debt' → 'Technical Debt', 'Bug Fix' → 'Bug';
 *      unknown types pass through untouched.
 *   3. C1 reconciliation — status IN ('Done','Archived') ⇒ phase='COMPLETE'.
 *   4. C3 left UNCHANGED — committed-but-Ready is a deferred human disposition.
 *   5. Content safety (#230) — brief_files.content + content_hash byte-identical.
 *   6. Idempotency — a second migrateSchema() changes zero rows.
 *   7. schema_version advances to exactly 18.
 *
 * Gate-dodge proof: this migration is DATA-only and has NO vec dependency, so
 * the suite runs WITHOUT loading sqlite-vec. On a vec-less machine the v13 vec
 * backfill stops the chain at v12, so we drive schema_version up to 17 manually
 * (INSERT OR IGNORE) before running migrateSchema — the L-209 re-read gate must
 * still fire v18 from version 17 regardless of how the chain reached it.
 *
 * @module __tests__/db-migration-v18
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
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
 * exactly 17 so the next migrateSchema() call fires v18. This works the same
 * whether or not sqlite-vec is present: migrateSchema builds the tables, and we
 * then top up the version ladder to 17 with INSERT OR IGNORE (idempotent).
 */
function buildSchemaAtV17(db: Database.Database): void {
  // First pass: create all tables (vec-less → chain stalls at 12, tables exist).
  migrateSchema(db);
  // Top the version ladder up to 17 so v18's L-209 gate (>=17 && <18) fires.
  for (let v = 13; v <= 17; v++) {
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
  }
  // Sanity: a project row to satisfy the brief_status / brief_files FK shape.
  db.prepare(
    `INSERT OR IGNORE INTO projects (slug, name, path, status) VALUES ('p', 'p', '/tmp/p', 'active')`,
  ).run();
}

interface SeedRow {
  brief_id: string;
  brief_type: string | null;
  status: string;
  priority: string | null;
  phase: string | null;
}

function seedStatus(db: Database.Database, r: SeedRow): void {
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, phase, updated_at)
     VALUES ('p', ?, ?, ?, ?, ?, ?, '2026-01-01 00:00:00')`,
  ).run(r.brief_id, r.brief_type, `T ${r.brief_id}`, r.status, r.priority, r.phase);
}

function readStatus(db: Database.Database, briefId: string): SeedRow {
  return db
    .prepare(
      `SELECT brief_id, brief_type, status, priority, phase
         FROM brief_status WHERE project = 'p' AND brief_id = ?`,
    )
    .get(briefId) as SeedRow;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migration v18 — brief metadata normalization + C1 (TD-238)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    buildSchemaAtV17(db);
  });

  afterEach(() => {
    db.close();
  });

  it('folds priorities to canonical buckets (bare + spaced + Unset → NULL)', () => {
    seedStatus(db, { brief_id: 'TD-001', brief_type: null, status: 'Ready', priority: 'P1', phase: 'BUILDING' });
    seedStatus(db, { brief_id: 'TD-002', brief_type: null, status: 'Ready', priority: 'P1 - High', phase: 'BUILDING' });
    seedStatus(db, { brief_id: 'TD-003', brief_type: null, status: 'Ready', priority: 'P0', phase: 'PLANNING' });
    seedStatus(db, { brief_id: 'TD-004', brief_type: null, status: 'Ready', priority: 'Unset', phase: 'PLANNING' });
    seedStatus(db, { brief_id: 'TD-005', brief_type: null, status: 'Ready', priority: '', phase: 'PLANNING' });
    seedStatus(db, { brief_id: 'TD-006', brief_type: null, status: 'Ready', priority: 'P2-Medium', phase: 'PLANNING' });

    migrateSchema(db);

    expect(readStatus(db, 'TD-001').priority).toBe('P1-High');
    expect(readStatus(db, 'TD-002').priority).toBe('P1-High');
    expect(readStatus(db, 'TD-003').priority).toBe('P0-Critical');
    expect(readStatus(db, 'TD-004').priority).toBeNull();
    expect(readStatus(db, 'TD-005').priority).toBeNull();
    // Already-canonical stays canonical (idempotent in the same run).
    expect(readStatus(db, 'TD-006').priority).toBe('P2-Medium');

    // Dashboard-bucket cleanliness: distinct non-null priorities are exactly
    // the canonical set (no P1 / "P1 - High" ghosts).
    const buckets = db
      .prepare(
        `SELECT DISTINCT priority FROM brief_status
           WHERE priority IS NOT NULL ORDER BY priority`,
      )
      .all() as Array<{ priority: string }>;
    expect(buckets.map((b) => b.priority)).toEqual(['P0-Critical', 'P1-High', 'P2-Medium']);
  });

  it('folds known brief_type aliases and leaves unknown types untouched', () => {
    seedStatus(db, { brief_id: 'TD-010', brief_type: 'Tech Debt', status: 'Ready', priority: null, phase: 'PLANNING' });
    seedStatus(db, { brief_id: 'TD-011', brief_type: 'Bug Fix', status: 'Ready', priority: null, phase: 'PLANNING' });
    seedStatus(db, { brief_id: 'TD-012', brief_type: 'Technical Debt', status: 'Ready', priority: null, phase: 'PLANNING' });
    seedStatus(db, { brief_id: 'TD-013', brief_type: 'Spike', status: 'Ready', priority: null, phase: 'PLANNING' });

    migrateSchema(db);

    expect(readStatus(db, 'TD-010').brief_type).toBe('Technical Debt');
    expect(readStatus(db, 'TD-011').brief_type).toBe('Bug');
    expect(readStatus(db, 'TD-012').brief_type).toBe('Technical Debt');
    // Unknown type survives the migration (read-widen — no operator data dropped).
    expect(readStatus(db, 'TD-013').brief_type).toBe('Spike');
  });

  it('C1 reconciliation: Done/Archived ⇒ phase=COMPLETE; C3 left unchanged', () => {
    // C1: terminal status, non-terminal phase → flip to COMPLETE.
    seedStatus(db, { brief_id: 'TD-020', brief_type: null, status: 'Done', priority: null, phase: 'COMMITTING' });
    seedStatus(db, { brief_id: 'TD-021', brief_type: null, status: 'Archived', priority: null, phase: 'REVIEWING' });
    seedStatus(db, { brief_id: 'TD-022', brief_type: null, status: 'Done', priority: null, phase: null });
    // Already COMPLETE → untouched.
    seedStatus(db, { brief_id: 'TD-023', brief_type: null, status: 'Done', priority: null, phase: 'COMPLETE' });
    // C3 (committed-but-Ready) is a DEFERRED human disposition — phase NOT flipped.
    seedStatus(db, { brief_id: 'TD-024', brief_type: null, status: 'Ready', priority: null, phase: 'BUILDING' });

    migrateSchema(db);

    expect(readStatus(db, 'TD-020').phase).toBe('COMPLETE');
    expect(readStatus(db, 'TD-021').phase).toBe('COMPLETE');
    expect(readStatus(db, 'TD-022').phase).toBe('COMPLETE');
    expect(readStatus(db, 'TD-023').phase).toBe('COMPLETE');
    // C3: a Ready brief keeps its in-flight phase; status NOT touched either.
    expect(readStatus(db, 'TD-024').phase).toBe('BUILDING');
    expect(readStatus(db, 'TD-024').status).toBe('Ready');
  });

  it('never touches content / title / status (#230 content safety)', () => {
    const content = '# TD-030\n\nThis content must be byte-identical after migration.\n';
    const contentHash = createHash('sha256').update(content).digest('hex');
    const now = '2026-01-01 00:00:00';
    db.prepare(
      `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
       VALUES ('f-030', 'p', 'TD-030', 'TD-030.md', ?, ?, ?)`,
    ).run(content, contentHash, now);
    seedStatus(db, { brief_id: 'TD-030', brief_type: 'Tech Debt', status: 'Done', priority: 'P1', phase: 'COMMITTING' });

    migrateSchema(db);

    const file = db
      .prepare(`SELECT content, content_hash FROM brief_files WHERE brief_id = 'TD-030'`)
      .get() as { content: string; content_hash: string };
    expect(file.content).toBe(content);
    expect(file.content_hash).toBe(contentHash);

    // Metadata folded, but title + status preserved verbatim.
    const status = db
      .prepare(`SELECT title, status, brief_type, priority, phase FROM brief_status WHERE brief_id = 'TD-030'`)
      .get() as { title: string; status: string; brief_type: string; priority: string; phase: string };
    expect(status.title).toBe('T TD-030');
    expect(status.status).toBe('Done');
    expect(status.brief_type).toBe('Technical Debt');
    expect(status.priority).toBe('P1-High');
    expect(status.phase).toBe('COMPLETE');
  });

  it('records v18 and advances the chain past it (now to 23 — FR-246)', () => {
    expect(getSchemaVersion(db)).toBe(17);
    migrateSchema(db);
    // v18 is recorded in the ladder...
    const has18 = db
      .prepare('SELECT 1 FROM schema_version WHERE version = 18')
      .get();
    expect(has18).toBeDefined();
    // ...and migrateSchema runs to completion (v19 registry→catalog, v20
    // worker-subsystem teardown, v21 rename, v22 brief_type fold and v23
    // briefs_fts follow v18).
    expect(getSchemaVersion(db)).toBe(23);
  });

  it('is idempotent — a second migration changes zero rows', () => {
    seedStatus(db, { brief_id: 'TD-040', brief_type: 'Tech Debt', status: 'Done', priority: 'P1', phase: 'COMMITTING' });
    seedStatus(db, { brief_id: 'TD-041', brief_type: 'Spike', status: 'Ready', priority: 'Unset', phase: 'BUILDING' });

    migrateSchema(db);
    const after1 = db
      .prepare(`SELECT brief_id, brief_type, status, priority, phase FROM brief_status ORDER BY brief_id`)
      .all();
    // migrateSchema runs to completion (v18 -> v23); terminal is 23 (FR-246).
    expect(getSchemaVersion(db)).toBe(23);

    // Second run: no version bump, no row change.
    expect(() => migrateSchema(db)).not.toThrow();
    const after2 = db
      .prepare(`SELECT brief_id, brief_type, status, priority, phase FROM brief_status ORDER BY brief_id`)
      .all();
    expect(getSchemaVersion(db)).toBe(23);
    expect(after2).toEqual(after1);
  });

  it('applies v18 even when the chain stalled at v12 (vec-less gate dodge)', () => {
    // Fresh DB: build tables but DELETE every schema_version row above 12 to
    // simulate a vec-less machine where v13 never recorded — then force the top
    // to 17 (as a partial migration that ran v14-17 data-only steps would) and
    // assert v18 still fires from the re-read gate.
    const fresh = new Database(':memory:');
    fresh.pragma('foreign_keys = ON');
    migrateSchema(fresh);
    fresh.prepare('DELETE FROM schema_version WHERE version > 12').run();
    for (let v = 13; v <= 17; v++) {
      fresh.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(v);
    }
    fresh.prepare(
      `INSERT OR IGNORE INTO projects (slug, name, path, status) VALUES ('p', 'p', '/tmp/p', 'active')`,
    ).run();
    seedStatus(fresh, { brief_id: 'TD-050', brief_type: 'Tech Debt', status: 'Done', priority: 'P1', phase: 'COMMITTING' });

    migrateSchema(fresh);

    const row = readStatus(fresh, 'TD-050');
    expect(row.priority).toBe('P1-High');
    expect(row.brief_type).toBe('Technical Debt');
    expect(row.phase).toBe('COMPLETE');
    // v18 applied via the re-read gate; chain runs through v19..v23 to completion.
    expect(getSchemaVersion(fresh)).toBe(23);
    fresh.close();
  });
});
