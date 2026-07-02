/**
 * Curator prune review round-trip test (FR-116 M3).
 *
 * Proves the prune_learning apply-action end-to-end via the ALREADY-SHIPPED
 * `igris_suggestion_apply_action` → `applyAction` → `applyPruneLearning` path:
 *
 *   - a queued `curator` `prune_learning` (prune) suggestion, applied by the
 *     operator, soft-deletes the learning (review_status='pruned' + deleted_at),
 *     writes an undo-log row, and marks the suggestion acted;
 *   - the pruned learning is excluded by BOTH `='approved'` and
 *     `COALESCE(...)='approved'` recall filters (Decision #1 — ZERO read-path
 *     sweep, verified);
 *   - re-pruning an already-pruned row is a NO-OP (idempotent);
 *   - lower_confidence clamps to [0, 1] and stays recallable;
 *   - keep stamps last_reviewed_at and is non-destructive.
 *
 * @module engine/components/curator/__tests__/apply-roundtrip.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applyAction } from '../../subconscious/actions/index.js';
import { applyPruneLearning } from '../../subconscious/actions/kinds.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { edgeMigrations } from '../../edges/schema.js';
import { janitorMigrations } from '../../janitor/schema.js';
import { getDb } from '../../../../db.js';

vi.mock('../../../../db.js', () => ({ getDb: vi.fn() }));

function makeBrain(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL DEFAULT 'p',
      category TEXT NOT NULL DEFAULT 'pattern',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
      review_status TEXT NOT NULL DEFAULT 'approved',
      access_count INTEGER DEFAULT 0,
      seen_again_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      embedding BLOB,
      embedding_model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  for (const m of edgeMigrations) db.exec(m.sql);
  for (const m of janitorMigrations) db.exec(m.sql); // deleted_at + superseded_by + undo + last_reviewed_at
  db.prepare(
    `INSERT INTO learnings (id, title, content, confidence)
     VALUES (1,'Old rule','use the deprecated API', 0.8),
            (2,'Aging rule','probably still fine', 0.6)`,
  ).run();
  return db;
}

function queuePruneSuggestion(db: Database.Database, action: Record<string, unknown>): number {
  const res = db
    .prepare(
      `INSERT INTO suggestions (source_module, title, evidence, priority, status, suggested_action, type_inferred)
       VALUES ('curator','prune','{}','low','pending', ?, 1)`,
    )
    .run(JSON.stringify(action));
  return Number(res.lastInsertRowid);
}

describe('FR-116 M3 prune round-trip (propose → apply → soft-delete)', () => {
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

  it('apply_action prunes the learning (review_status=pruned) + writes an undo row', () => {
    const id = queuePruneSuggestion(db, { kind: 'prune_learning', verdict: 'prune', learning_id: 1 });
    const result = applyAction(db, id);
    expect(result.isError).toBeFalsy();

    const row = db
      .prepare(`SELECT review_status, deleted_at FROM learnings WHERE id=1`)
      .get() as { review_status: string; deleted_at: string | null };
    expect(row.review_status).toBe('pruned');
    expect(row.deleted_at).not.toBeNull();

    // Suggestion marked acted.
    const sugg = db.prepare(`SELECT status FROM suggestions WHERE id=?`).get(id) as { status: string };
    expect(sugg.status).toBe('acted');

    // Undo-log row captured the pre-state.
    const undo = db
      .prepare(`SELECT action_kind, learning_id, prior_review_status FROM brain_maintenance_undo WHERE learning_id=1`)
      .get() as { action_kind: string; learning_id: number; prior_review_status: string };
    expect(undo).toMatchObject({ action_kind: 'prune_learning', learning_id: 1, prior_review_status: 'approved' });
  });

  it('a pruned row is excluded by BOTH approved-filter shapes (ZERO read-path sweep)', () => {
    applyPruneLearning(db, { verdict: 'prune', learning_id: 1 });

    const strict = db
      .prepare(`SELECT id FROM learnings WHERE review_status='approved' ORDER BY id`)
      .all() as Array<{ id: number }>;
    const coalesced = db
      .prepare(`SELECT id FROM learnings WHERE COALESCE(review_status,'approved')='approved' ORDER BY id`)
      .all() as Array<{ id: number }>;
    expect(strict.map((r) => r.id)).toEqual([2]);
    expect(coalesced.map((r) => r.id)).toEqual([2]);
  });

  it('re-pruning an already-pruned row is a NO-OP (idempotent)', () => {
    const first = applyPruneLearning(db, { verdict: 'prune', learning_id: 1 });
    expect(first.ok).toBe(true);
    const second = applyPruneLearning(db, { verdict: 'prune', learning_id: 1 });
    expect(second.ok).toBe(true);
    expect(second.message).toMatch(/already pruned/i);
    // Only one undo row (the second is a no-op that logged nothing).
    const n = db.prepare(`SELECT COUNT(*) AS n FROM brain_maintenance_undo WHERE learning_id=1`).get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('lower_confidence subtracts the delta, clamped to [0, 1], and stays recallable', () => {
    const r = applyPruneLearning(db, { verdict: 'lower_confidence', learning_id: 2, confidence_delta: 0.4 });
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT confidence, review_status FROM learnings WHERE id=2`).get() as {
      confidence: number;
      review_status: string;
    };
    expect(row.confidence).toBeCloseTo(0.2, 5);
    expect(row.review_status).toBe('approved'); // non-destructive
  });

  it('lower_confidence clamps at the 0 floor (never violates the CHECK)', () => {
    const r = applyPruneLearning(db, { verdict: 'lower_confidence', learning_id: 2, confidence_delta: 5 });
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT confidence FROM learnings WHERE id=2`).get() as { confidence: number };
    expect(row.confidence).toBe(0);
  });

  it('keep stamps last_reviewed_at without deleting or changing confidence', () => {
    const before = db.prepare(`SELECT confidence FROM learnings WHERE id=1`).get() as { confidence: number };
    const r = applyPruneLearning(db, { verdict: 'keep', learning_id: 1 });
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT confidence, review_status, last_reviewed_at FROM learnings WHERE id=1`).get() as {
      confidence: number;
      review_status: string;
      last_reviewed_at: string | null;
    };
    expect(row.confidence).toBe(before.confidence);
    expect(row.review_status).toBe('approved');
    expect(row.last_reviewed_at).not.toBeNull();
  });

  it('fails closed on a non-existent learning / unknown verdict', () => {
    expect(applyPruneLearning(db, { verdict: 'prune', learning_id: 999 }).ok).toBe(false);
    expect(applyPruneLearning(db, { verdict: 'nuke', learning_id: 1 }).ok).toBe(false);
  });
});
