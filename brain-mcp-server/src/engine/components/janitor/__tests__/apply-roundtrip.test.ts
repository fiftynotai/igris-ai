/**
 * Janitor merge review round-trip test (FR-119 — AC #2/#3).
 *
 * Proves the merge_learnings apply-action end-to-end via the ALREADY-SHIPPED
 * `igris_suggestion_apply_action` → `applyAction` → `applyMergeLearnings` path:
 *
 *   - a queued `janitor` `merge_learnings` suggestion, applied by the operator,
 *     soft-deletes the duplicate (review_status='merged' + deleted_at +
 *     merged_into), rolls seen_again_count into the survivor, writes a
 *     derived_from edge survivor→duplicate, and marks the suggestion acted;
 *   - the merged duplicate is no longer returned by an approved-filter recall;
 *   - re-applying the same merge on an already-merged row is a NO-OP (idempotent);
 *   - a merge with synthesized_content updates the survivor + NULLs its embedding.
 *
 * `getDb` is mocked so `handleEdgeCreate` (used inside applyMergeLearnings) sees
 * the same in-memory DB.
 *
 * @module engine/components/janitor/__tests__/apply-roundtrip.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applyAction } from '../../subconscious/actions/index.js';
import { applyMergeLearnings } from '../../subconscious/actions/kinds.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { edgeMigrations } from '../../edges/schema.js';
import { janitorMigrations } from '../schema.js';
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
  for (const m of janitorMigrations) db.exec(m.sql); // adds deleted_at + merged_into
  db.prepare(
    `INSERT INTO learnings (id, title, content, seen_again_count)
     VALUES (1,'Survivor','the canonical rule', 2),
            (2,'Duplicate','the same rule restated', 4)`,
  ).run();
  return db;
}

function queueMergeSuggestion(
  db: Database.Database,
  action: Record<string, unknown>,
): number {
  const res = db
    .prepare(
      `INSERT INTO suggestions (source_module, title, evidence, priority, status, suggested_action, type_inferred)
       VALUES ('janitor','merge','{}','low','pending', ?, 1)`,
    )
    .run(JSON.stringify(action));
  return Number(res.lastInsertRowid);
}

describe('FR-119 merge round-trip (propose → apply → soft-delete)', () => {
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

  it('apply_action merges the duplicate into the survivor', () => {
    const id = queueMergeSuggestion(db, {
      kind: 'merge_learnings',
      survivor_id: 1,
      duplicate_id: 2,
      justification: 'same rule',
    });

    const result = applyAction(db, id);
    expect(result.isError).toBeFalsy();

    // Duplicate soft-deleted with audit columns stamped.
    const dup = db
      .prepare(`SELECT review_status, deleted_at, merged_into FROM learnings WHERE id=2`)
      .get() as { review_status: string; deleted_at: string | null; merged_into: number | null };
    expect(dup.review_status).toBe('merged');
    expect(dup.deleted_at).not.toBeNull();
    expect(dup.merged_into).toBe(1);

    // Survivor seen_again_count rolled: 2 + 4 + 1 = 7.
    const surv = db.prepare(`SELECT seen_again_count FROM learnings WHERE id=1`).get() as {
      seen_again_count: number;
    };
    expect(surv.seen_again_count).toBe(7);

    // derived_from edge survivor→duplicate exists (Decision C).
    const edge = db
      .prepare(
        `SELECT from_id, to_id, edge_type, provenance FROM entity_edges
          WHERE from_type='learning' AND to_type='learning'`,
      )
      .get() as { from_id: string; to_id: string; edge_type: string; provenance: string };
    expect(edge).toMatchObject({ from_id: '1', to_id: '2', edge_type: 'derived_from', provenance: 'inferred' });

    // Suggestion marked acted.
    const sugg = db.prepare(`SELECT status FROM suggestions WHERE id=?`).get(id) as { status: string };
    expect(sugg.status).toBe('acted');

    // The merged duplicate drops out of an approved-filter recall.
    const approved = db
      .prepare(`SELECT id FROM learnings WHERE review_status='approved' ORDER BY id`)
      .all() as Array<{ id: number }>;
    expect(approved.map((r) => r.id)).toEqual([1]);
  });

  it('re-applying an already-merged pair is a no-op (idempotent)', () => {
    // Direct executor call twice — the second is a no-op, survivor unchanged.
    const first = applyMergeLearnings(db, { survivor_id: 1, duplicate_id: 2 });
    expect(first.ok).toBe(true);
    const seenAfterFirst = (db.prepare(`SELECT seen_again_count FROM learnings WHERE id=1`).get() as {
      seen_again_count: number;
    }).seen_again_count;

    const second = applyMergeLearnings(db, { survivor_id: 1, duplicate_id: 2 });
    expect(second.ok).toBe(true);
    expect(second.message).toMatch(/already merged/i);
    const seenAfterSecond = (db.prepare(`SELECT seen_again_count FROM learnings WHERE id=1`).get() as {
      seen_again_count: number;
    }).seen_again_count;
    expect(seenAfterSecond).toBe(seenAfterFirst); // not rolled twice
  });

  it('merge with synthesized_content updates the survivor + NULLs its embedding', () => {
    db.prepare(`UPDATE learnings SET embedding = X'00', embedding_model = 'm' WHERE id=1`).run();
    const result = applyMergeLearnings(db, {
      survivor_id: 1,
      duplicate_id: 2,
      synthesized_content: 'the merged canonical rule',
    });
    expect(result.ok).toBe(true);
    const surv = db
      .prepare(`SELECT content, embedding, embedding_model FROM learnings WHERE id=1`)
      .get() as { content: string; embedding: Buffer | null; embedding_model: string | null };
    expect(surv.content).toBe('the merged canonical rule');
    expect(surv.embedding).toBeNull();
    expect(surv.embedding_model).toBeNull();
  });

  it('fails closed on a non-existent survivor/duplicate', () => {
    expect(applyMergeLearnings(db, { survivor_id: 1, duplicate_id: 999 }).ok).toBe(false);
    expect(applyMergeLearnings(db, { survivor_id: 5, duplicate_id: 5 }).ok).toBe(false);
  });
});
