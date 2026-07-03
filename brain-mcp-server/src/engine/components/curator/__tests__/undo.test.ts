/**
 * Maintenance UNDO round-trip tests (FR-116 M3, Decision #2 — the critical piece).
 *
 * Proves `performUndo` reverses EACH destructive/mutating kind to its EXACT
 * pre-state, including content re-embed-NULL and edge removal:
 *   - prune_learning       → review_status restored to 'approved', deleted_at cleared;
 *   - lower_confidence      → confidence restored;
 *   - confidence_bump       → confidence restored (undo-by-RUN);
 *   - merge_learnings       → duplicate un-merged, survivor content + seen_again
 *                             restored + embedding NULLed for re-embed, derived_from
 *                             edge removed (the hardest case — synthesized merge);
 *   - resolve_contradiction → loser un-superseded, supersedes edge removed;
 * plus: idempotent undo (already-undone = no-op), undo of a nonexistent run errors
 * cleanly, undo-by-run bumps the run's `undone` counter.
 *
 * `getDb` is mocked so `handleEdgeCreate` (used inside merge/contradiction) sees
 * the same in-memory DB.
 *
 * @module engine/components/curator/__tests__/undo.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyMergeLearnings,
  applyPruneLearning,
  applyResolveContradiction,
} from '../../subconscious/actions/kinds.js';
import { applyConfidenceBumps } from '../../janitor/hygiene.js';
import { performUndo } from '../../janitor/undo.js';
import { DEFAULT_JANITOR_CONFIG } from '../../janitor/types.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { edgeMigrations } from '../../edges/schema.js';
import { janitorMigrations } from '../../janitor/schema.js';
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
      last_seen_at TEXT,
      embedding BLOB,
      embedding_model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  for (const m of edgeMigrations) db.exec(m.sql);
  for (const m of janitorMigrations) db.exec(m.sql);
  return db;
}

describe('FR-116 M3 UNDO — exact pre-state restore per destructive kind', () => {
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

  it('prune_learning: undo restores approved + clears deleted_at', () => {
    db.prepare(`INSERT INTO learnings (id, title, content) VALUES (1,'t','c')`).run();
    applyPruneLearning(db, { verdict: 'prune', learning_id: 1 });
    const entry = db.prepare(`SELECT id FROM brain_maintenance_undo WHERE learning_id=1`).get() as { id: number };

    const r = performUndo(db, { entry_id: entry.id });
    expect(r.ok).toBe(true);
    expect(r.reversed).toBe(1);
    const row = db.prepare(`SELECT review_status, deleted_at FROM learnings WHERE id=1`).get() as {
      review_status: string;
      deleted_at: string | null;
    };
    expect(row.review_status).toBe('approved');
    expect(row.deleted_at).toBeNull();
    // undone_at stamped.
    const undone = db.prepare(`SELECT undone_at FROM brain_maintenance_undo WHERE id=?`).get(entry.id) as {
      undone_at: string | null;
    };
    expect(undone.undone_at).not.toBeNull();
  });

  it('lower_confidence: undo restores the exact prior confidence', () => {
    db.prepare(`INSERT INTO learnings (id, title, content, confidence) VALUES (1,'t','c',0.9)`).run();
    applyPruneLearning(db, { verdict: 'lower_confidence', learning_id: 1, confidence_delta: 0.4 });
    expect((db.prepare(`SELECT confidence FROM learnings WHERE id=1`).get() as { confidence: number }).confidence).toBeCloseTo(0.5, 5);
    const entry = db.prepare(`SELECT id FROM brain_maintenance_undo WHERE learning_id=1`).get() as { id: number };

    performUndo(db, { entry_id: entry.id });
    expect((db.prepare(`SELECT confidence FROM learnings WHERE id=1`).get() as { confidence: number }).confidence).toBeCloseTo(0.9, 5);
  });

  it('confidence_bump: undo-by-RUN restores confidence + bumps the run undone counter', () => {
    db.prepare(`INSERT INTO learnings (id, title, content, confidence) VALUES (1,'t','c',0.80)`).run();
    // seed 3 rediscovery events for id 1.
    const ev = db.prepare(
      `INSERT INTO event_log (event_name, component, payload) VALUES ('perception.rediscovery','perception', ?)`,
    );
    for (let i = 0; i < 3; i++) ev.run(JSON.stringify({ existing_learning_id: 1 }));
    // Open a run row so undo-by-run can bump its `undone` counter.
    db.prepare(`INSERT INTO brain_maintenance_runs (run_id, trigger, status) VALUES ('run-x','test','running')`).run();

    const bumped = applyConfidenceBumps(db, DEFAULT_JANITOR_CONFIG, null, 'run-x');
    expect(bumped).toBe(1);
    expect((db.prepare(`SELECT confidence FROM learnings WHERE id=1`).get() as { confidence: number }).confidence).toBeCloseTo(0.85, 5);

    const r = performUndo(db, { run_id: 'run-x' });
    expect(r.ok).toBe(true);
    expect((db.prepare(`SELECT confidence FROM learnings WHERE id=1`).get() as { confidence: number }).confidence).toBeCloseTo(0.80, 5);
    const run = db.prepare(`SELECT undone FROM brain_maintenance_runs WHERE run_id='run-x'`).get() as { undone: number };
    expect(run.undone).toBe(1);
  });

  it('merge_learnings (synthesized): undo restores both rows + removes the derived_from edge', () => {
    db.prepare(
      `INSERT INTO learnings (id, title, content, seen_again_count) VALUES
        (1,'Survivor','original survivor content', 2),
        (2,'Duplicate','the duplicate content', 4)`,
    ).run();
    const merge = applyMergeLearnings(db, {
      survivor_id: 1,
      duplicate_id: 2,
      synthesized_content: 'the synthesized merged content',
    });
    expect(merge.ok).toBe(true);
    // Post-merge: survivor content changed + seen rolled to 7, duplicate merged.
    expect((db.prepare(`SELECT content FROM learnings WHERE id=1`).get() as { content: string }).content).toBe('the synthesized merged content');
    expect((db.prepare(`SELECT seen_again_count FROM learnings WHERE id=1`).get() as { seen_again_count: number }).seen_again_count).toBe(7);
    expect((db.prepare(`SELECT review_status FROM learnings WHERE id=2`).get() as { review_status: string }).review_status).toBe('merged');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM entity_edges WHERE edge_type='derived_from'`).get() as { n: number }).n).toBe(1);

    // Undo BOTH entries of the merge (operator-applied → run_id null; undo by entry).
    const entries = db.prepare(`SELECT id FROM brain_maintenance_undo ORDER BY id`).all() as Array<{ id: number }>;
    for (const e of entries) performUndo(db, { entry_id: e.id });

    // Survivor restored to EXACT pre-state: content + seen_again_count + embedding NULLed for re-embed.
    const surv = db.prepare(`SELECT content, seen_again_count, embedding FROM learnings WHERE id=1`).get() as {
      content: string;
      seen_again_count: number;
      embedding: Buffer | null;
    };
    expect(surv.content).toBe('original survivor content');
    expect(surv.seen_again_count).toBe(2);
    expect(surv.embedding).toBeNull(); // NULLed → FR-220 async re-embed picks up the restored content

    // Duplicate un-merged.
    const dup = db.prepare(`SELECT review_status, deleted_at, merged_into FROM learnings WHERE id=2`).get() as {
      review_status: string;
      deleted_at: string | null;
      merged_into: number | null;
    };
    expect(dup.review_status).toBe('approved');
    expect(dup.deleted_at).toBeNull();
    expect(dup.merged_into).toBeNull();

    // derived_from edge removed.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM entity_edges WHERE edge_type='derived_from'`).get() as { n: number }).n).toBe(0);
  });

  it('resolve_contradiction (newer_wins): undo un-supersedes the loser + removes the supersedes edge', () => {
    db.prepare(
      `INSERT INTO learnings (id, title, content) VALUES (1,'Loser','old claim'), (2,'Winner','new claim')`,
    ).run();
    const r = applyResolveContradiction(db, { resolution: 'newer_wins', winner_id: 2, loser_id: 1 });
    expect(r.ok).toBe(true);
    expect((db.prepare(`SELECT review_status, superseded_by FROM learnings WHERE id=1`).get() as { review_status: string; superseded_by: number | null }).review_status).toBe('superseded');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM entity_edges WHERE edge_type='supersedes'`).get() as { n: number }).n).toBe(1);

    const entry = db.prepare(`SELECT id FROM brain_maintenance_undo WHERE learning_id=1`).get() as { id: number };
    performUndo(db, { entry_id: entry.id });

    const loser = db.prepare(`SELECT review_status, deleted_at, superseded_by FROM learnings WHERE id=1`).get() as {
      review_status: string;
      deleted_at: string | null;
      superseded_by: number | null;
    };
    expect(loser.review_status).toBe('approved');
    expect(loser.deleted_at).toBeNull();
    expect(loser.superseded_by).toBeNull();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM entity_edges WHERE edge_type='supersedes'`).get() as { n: number }).n).toBe(0);
  });

  it('undo is idempotent (already-undone reverses nothing)', () => {
    db.prepare(`INSERT INTO learnings (id, title, content) VALUES (1,'t','c')`).run();
    applyPruneLearning(db, { verdict: 'prune', learning_id: 1 });
    const entry = db.prepare(`SELECT id FROM brain_maintenance_undo WHERE learning_id=1`).get() as { id: number };
    expect(performUndo(db, { entry_id: entry.id }).reversed).toBe(1);
    const second = performUndo(db, { entry_id: entry.id });
    expect(second.ok).toBe(false); // no reversible entries left
    expect(second.reversed).toBe(0);
  });

  it('undo of a nonexistent run errors cleanly', () => {
    const r = performUndo(db, { run_id: 'does-not-exist' });
    expect(r.ok).toBe(false);
    expect(r.reversed).toBe(0);
    expect(r.message).toMatch(/no reversible undo entries/i);
  });

  it('undo with neither run_id nor entry_id errors cleanly', () => {
    const r = performUndo(db, {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/requires a run_id or entry_id/i);
  });
});
