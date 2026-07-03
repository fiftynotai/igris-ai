/**
 * Curator staleness-detector + candidate-generation tests (FR-116 M3).
 *
 * Covers the DETERMINISTIC `detectOutdatedLearnings` duty (age + access + the
 * deprecated-tag signal, approved-only, last_reviewed_at exclusion) and the
 * `buildStaleCandidates` wrapper (don't-double-queue exclusion).
 *
 * No mocks (L-159): the functions take the DB + config directly.
 *
 * @module engine/components/curator/__tests__/candidates.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { detectOutdatedLearnings } from '../../janitor/hygiene.js';
import { buildStaleCandidates, loadPendingPruneIds } from '../candidates.js';
import { DEFAULT_CURATOR_CONFIG, type CuratorConfig } from '../types.js';

function makeBrain(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 't',
      content TEXT NOT NULL DEFAULT 'c',
      confidence REAL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
      review_status TEXT NOT NULL DEFAULT 'approved',
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT,
      last_reviewed_at TEXT,
      tags TEXT,
      tech_stack TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_module TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      suggested_action TEXT
    );
  `);
  return db;
}

const OPTS = {
  stale_months: 6,
  max_access_count: 0,
  deprecated_tags: [] as string[],
  max_candidates: 200,
};

describe('detectOutdatedLearnings (FR-116 M3 — Decision #5)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
  });
  afterEach(() => db.close());

  it('flags a 7-month-old, never-accessed, approved learning (reason=stale)', () => {
    db.prepare(
      `INSERT INTO learnings (id, access_count, created_at) VALUES (1, 0, datetime('now','-7 months'))`,
    ).run();
    const out = detectOutdatedLearnings(db, OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1, reason: 'stale', access_count: 0 });
  });

  it('does NOT flag a recently-accessed learning (access_count above threshold)', () => {
    db.prepare(
      `INSERT INTO learnings (id, access_count, created_at) VALUES (1, 5, datetime('now','-7 months'))`,
    ).run();
    expect(detectOutdatedLearnings(db, OPTS)).toHaveLength(0);
  });

  it('does NOT flag a recently-created learning (younger than the window)', () => {
    db.prepare(
      `INSERT INTO learnings (id, access_count, created_at) VALUES (1, 0, datetime('now','-1 months'))`,
    ).run();
    expect(detectOutdatedLearnings(db, OPTS)).toHaveLength(0);
  });

  it('flags a deprecated-tech-tagged learning regardless of age/access', () => {
    db.prepare(
      `INSERT INTO learnings (id, access_count, tech_stack, created_at)
       VALUES (1, 99, 'AngularJS, jQuery', datetime('now','-1 days'))`,
    ).run();
    const out = detectOutdatedLearnings(db, { ...OPTS, deprecated_tags: ['angularjs'] });
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('deprecated_tag');
  });

  it('reports stale+deprecated_tag when both signals fire', () => {
    db.prepare(
      `INSERT INTO learnings (id, access_count, tags, created_at)
       VALUES (1, 0, 'coffeescript', datetime('now','-8 months'))`,
    ).run();
    const out = detectOutdatedLearnings(db, { ...OPTS, deprecated_tags: ['coffeescript'] });
    expect(out[0].reason).toBe('stale+deprecated_tag');
  });

  it('excludes non-approved rows (pruned / merged / rejected / pending)', () => {
    db.prepare(
      `INSERT INTO learnings (id, access_count, review_status, created_at) VALUES
        (1, 0, 'pruned',         datetime('now','-9 months')),
        (2, 0, 'merged',         datetime('now','-9 months')),
        (3, 0, 'rejected',       datetime('now','-9 months')),
        (4, 0, 'pending_review', datetime('now','-9 months'))`,
    ).run();
    expect(detectOutdatedLearnings(db, OPTS)).toHaveLength(0);
  });

  it('excludes a recently-reviewed row (keep verdict stamped last_reviewed_at)', () => {
    db.prepare(
      `INSERT INTO learnings (id, access_count, created_at, last_reviewed_at)
       VALUES (1, 0, datetime('now','-9 months'), datetime('now','-1 days'))`,
    ).run();
    expect(detectOutdatedLearnings(db, OPTS)).toHaveLength(0);
  });

  it('respects max_candidates', () => {
    for (let i = 1; i <= 5; i++) {
      db.prepare(
        `INSERT INTO learnings (id, access_count, created_at) VALUES (?, 0, datetime('now','-9 months'))`,
      ).run(i);
    }
    expect(detectOutdatedLearnings(db, { ...OPTS, max_candidates: 3 })).toHaveLength(3);
  });
});

describe('buildStaleCandidates — don\'t-double-queue (FR-116 M3)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
  });
  afterEach(() => db.close());

  it('excludes a learning already pending a curator prune suggestion', () => {
    db.prepare(
      `INSERT INTO learnings (id, access_count, created_at) VALUES
        (1, 0, datetime('now','-9 months')),
        (2, 0, datetime('now','-9 months'))`,
    ).run();
    db.prepare(
      `INSERT INTO suggestions (source_module, status, suggested_action)
       VALUES ('curator', 'pending', ?)`,
    ).run(JSON.stringify({ kind: 'prune_learning', verdict: 'prune', learning_id: 1 }));

    const cfg: CuratorConfig = { ...DEFAULT_CURATOR_CONFIG };
    const out = buildStaleCandidates(db, cfg);
    expect(out.map((c) => c.id)).toEqual([2]);
    expect(loadPendingPruneIds(db).has(1)).toBe(true);
  });
});
