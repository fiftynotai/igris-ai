/**
 * FR-116 M3 Decision #10 — reject→soft-delete emit flip (activation test).
 *
 * Proves the perception reject-path flip + the dormant re-eval activation:
 *   - a COMMON (first-time) reject of a `seen_again_count == 0` candidate stays a
 *     HARD DELETE (unchanged behavior — the row vanishes, NO recurrence event);
 *   - a RECURRING reject (`seen_again_count > 0`) SOFT-deletes
 *     (review_status='rejected' + deleted_at) and writes a
 *     `perception.rejected_pattern_recurring` event_log row;
 *   - the janitor's `surfaceReEvalRejections` tally now reads those events and
 *     surfaces a `re_evaluate_rejection` suggestion (the previously-dormant path).
 *
 * @module engine/components/curator/__tests__/reject-flip.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import Database from 'better-sqlite3';
import { handlePerceptionReject } from '../../perception/handlers.js';
import { surfaceReEvalRejections } from '../../janitor/hygiene.js';
import { DEFAULT_JANITOR_CONFIG, type JanitorConfig } from '../../janitor/types.js';
import { getDb } from '../../../../db.js';

vi.mock('../../../../db.js', () => ({ getDb: vi.fn() }));

function makeBrain(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      component TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      machine_hostname TEXT,
      project_slug TEXT,
      instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 't',
      content TEXT NOT NULL DEFAULT 'c',
      review_status TEXT NOT NULL DEFAULT 'pending_review',
      seen_again_count INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // TD-440 — `suggestions` comes from the OWNING component's migrations rather
  // than a hand-rolled copy. The copy that used to live here drifted the moment
  // v5 added a column the janitor writer stamps, and a fixture that can drift
  // from the schema it stands in for will do it again.
  for (const m of subconsciousMigrations) db.exec(m.sql);
  return db;
}

describe('FR-116 M3 Decision #10 — reject-flip + dormant re-eval activation', () => {
  let db: Database.Database;
  beforeEach(() => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('a first-time reject (seen_again_count=0) stays a HARD DELETE, no recurrence event', () => {
    db.prepare(`INSERT INTO learnings (id, seen_again_count) VALUES (1, 0)`).run();
    const r = handlePerceptionReject({ learning_id: 1, reason: 'noisy' });
    expect(r.isError).toBeFalsy();
    // Row gone (hard delete — unchanged common path).
    expect(db.prepare(`SELECT id FROM learnings WHERE id=1`).get()).toBeUndefined();
    // No recurrence event fired.
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM event_log WHERE event_name='perception.rejected_pattern_recurring'`)
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('a recurring reject (seen_again_count>0) SOFT-deletes + emits the recurrence event', () => {
    db.prepare(`INSERT INTO learnings (id, seen_again_count) VALUES (1, 3)`).run();
    const r = handlePerceptionReject({ learning_id: 1, reason: 'still noisy' });
    expect(r.isError).toBeFalsy();
    // Soft-deleted, not hard-deleted.
    const row = db.prepare(`SELECT review_status, deleted_at FROM learnings WHERE id=1`).get() as {
      review_status: string;
      deleted_at: string | null;
    };
    expect(row.review_status).toBe('rejected');
    expect(row.deleted_at).not.toBeNull();
    // Recurrence event written to event_log.
    const n = db
      .prepare(
        `SELECT COUNT(*) AS n FROM event_log
          WHERE component='perception' AND event_name='perception.rejected_pattern_recurring'`,
      )
      .get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('the janitor surfaceReEvalRejections tally now surfaces a re_evaluate_rejection suggestion', () => {
    // Five recurring rejections (== reject_recur_n) activate the dormant path.
    for (let i = 1; i <= 5; i++) {
      db.prepare(`INSERT INTO learnings (id, seen_again_count) VALUES (?, 2)`).run(i);
      const r = handlePerceptionReject({ learning_id: i });
      expect(r.isError).toBeFalsy();
    }
    const cfg: JanitorConfig = { ...DEFAULT_JANITOR_CONFIG }; // reject_recur_n = 5
    expect(surfaceReEvalRejections(db, cfg, null)).toBe(1);
    const sugg = db
      .prepare(`SELECT suggested_action FROM suggestions WHERE source_module='janitor'`)
      .get() as { suggested_action: string };
    expect(JSON.parse(sugg.suggested_action).kind).toBe('re_evaluate_rejection');
  });
});
