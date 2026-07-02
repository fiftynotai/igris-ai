/**
 * Janitor deterministic-hygiene tests (FR-119).
 *
 * Covers the three no-LLM duties:
 *   - applyConfidenceBumps: TD-086 bump +0.05 after N rediscoveries, with the
 *     CLAMP at the CHECK 0–1 bound (db.ts:164) and the `since` idempotency window;
 *   - rejectStalePending: flip only pending_review rows older than stale_days;
 *   - surfaceReEvalRejections: dormant (no source events → no-op) + the N-gate.
 *
 * No mocks (L-159): the functions take the DB + config directly.
 *
 * @module engine/components/janitor/__tests__/hygiene.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyConfidenceBumps,
  rejectStalePending,
  surfaceReEvalRejections,
} from '../hygiene.js';
import { DEFAULT_JANITOR_CONFIG, type JanitorConfig } from '../types.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';

function makeBrain(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      component TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 't',
      content TEXT NOT NULL DEFAULT 'c',
      confidence REAL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
      review_status TEXT NOT NULL DEFAULT 'approved',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  return db;
}

function seedRediscovery(db: Database.Database, learningId: number, n: number): void {
  const stmt = db.prepare(
    `INSERT INTO event_log (event_name, component, payload)
     VALUES ('perception.rediscovery', 'perception', ?)`,
  );
  for (let i = 0; i < n; i++) stmt.run(JSON.stringify({ existing_learning_id: learningId }));
}

describe('applyConfidenceBumps (TD-086)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
  });
  afterEach(() => db.close());

  it('bumps confidence +0.05 after N rediscoveries of an approved learning', () => {
    db.prepare(`INSERT INTO learnings (id, confidence) VALUES (1, 0.80)`).run();
    seedRediscovery(db, 1, 3); // == rediscovery_bump_n (3)
    const bumped = applyConfidenceBumps(db, DEFAULT_JANITOR_CONFIG, null);
    expect(bumped).toBe(1);
    const row = db.prepare(`SELECT confidence FROM learnings WHERE id=1`).get() as { confidence: number };
    expect(row.confidence).toBeCloseTo(0.85, 5);
  });

  it('does NOT bump below the N threshold', () => {
    db.prepare(`INSERT INTO learnings (id, confidence) VALUES (1, 0.80)`).run();
    seedRediscovery(db, 1, 2); // < 3
    expect(applyConfidenceBumps(db, DEFAULT_JANITOR_CONFIG, null)).toBe(0);
    const row = db.prepare(`SELECT confidence FROM learnings WHERE id=1`).get() as { confidence: number };
    expect(row.confidence).toBeCloseTo(0.80, 5);
  });

  it('CLAMPS the bump at 1.0 (no CHECK violation) at confidence 0.98', () => {
    db.prepare(`INSERT INTO learnings (id, confidence) VALUES (1, 0.98)`).run();
    seedRediscovery(db, 1, 3);
    expect(() => applyConfidenceBumps(db, DEFAULT_JANITOR_CONFIG, null)).not.toThrow();
    const row = db.prepare(`SELECT confidence FROM learnings WHERE id=1`).get() as { confidence: number };
    expect(row.confidence).toBe(1.0);
  });

  it('does not bump a non-approved learning', () => {
    db.prepare(`INSERT INTO learnings (id, confidence, review_status) VALUES (1, 0.80, 'pending_review')`).run();
    seedRediscovery(db, 1, 5);
    expect(applyConfidenceBumps(db, DEFAULT_JANITOR_CONFIG, null)).toBe(0);
  });

  it('is idempotent via the `since` window (a re-run finds no new events)', () => {
    db.prepare(`INSERT INTO learnings (id, confidence) VALUES (1, 0.80)`).run();
    seedRediscovery(db, 1, 3);
    // First run (since=null) bumps.
    expect(applyConfidenceBumps(db, DEFAULT_JANITOR_CONFIG, null)).toBe(1);
    // Second run windows on "now" — the 3 events are older → no double-bump.
    const since = db.prepare(`SELECT datetime('now', '+1 second') AS ts`).get() as { ts: string };
    expect(applyConfidenceBumps(db, DEFAULT_JANITOR_CONFIG, since.ts)).toBe(0);
    const row = db.prepare(`SELECT confidence FROM learnings WHERE id=1`).get() as { confidence: number };
    expect(row.confidence).toBeCloseTo(0.85, 5);
  });
});

describe('rejectStalePending', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
  });
  afterEach(() => db.close());

  it('flips only pending_review rows older than stale_days', () => {
    db.prepare(
      `INSERT INTO learnings (id, review_status, created_at)
       VALUES (1, 'pending_review', datetime('now','-15 days')),
              (2, 'pending_review', datetime('now','-10 days')),
              (3, 'approved',       datetime('now','-30 days'))`,
    ).run();
    const rejected = rejectStalePending(db, DEFAULT_JANITOR_CONFIG); // stale_days=14
    expect(rejected).toBe(1);
    const s1 = db.prepare(`SELECT review_status FROM learnings WHERE id=1`).get() as { review_status: string };
    const s2 = db.prepare(`SELECT review_status FROM learnings WHERE id=2`).get() as { review_status: string };
    const s3 = db.prepare(`SELECT review_status FROM learnings WHERE id=3`).get() as { review_status: string };
    expect(s1.review_status).toBe('rejected');
    expect(s2.review_status).toBe('pending_review');
    expect(s3.review_status).toBe('approved');
  });
});

describe('surfaceReEvalRejections (Decision D — dormant)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
  });
  afterEach(() => db.close());

  it('no-ops when there are no rejected_pattern_recurring events (dead source)', () => {
    expect(surfaceReEvalRejections(db, DEFAULT_JANITOR_CONFIG, null)).toBe(0);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE source_module='janitor'`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('surfaces ONE suggestion once the N-gate is met (forward-compat path)', () => {
    const stmt = db.prepare(
      `INSERT INTO event_log (event_name, component, payload)
       VALUES ('perception.rejected_pattern_recurring', 'perception', '{}')`,
    );
    for (let i = 0; i < 5; i++) stmt.run(); // == reject_recur_n
    const cfg: JanitorConfig = { ...DEFAULT_JANITOR_CONFIG };
    expect(surfaceReEvalRejections(db, cfg, null)).toBe(1);
    // Re-run does not double-queue (a pending janitor re_evaluate_rejection exists).
    expect(surfaceReEvalRejections(db, cfg, null)).toBe(0);
    const row = db
      .prepare(`SELECT suggested_action FROM suggestions WHERE source_module='janitor'`)
      .get() as { suggested_action: string };
    expect(JSON.parse(row.suggested_action).kind).toBe('re_evaluate_rejection');
  });
});
