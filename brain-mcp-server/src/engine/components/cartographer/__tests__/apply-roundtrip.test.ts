/**
 * Cartographer cluster_meta apply round-trip + undo (FR-116 M4).
 *
 * Proves the cluster_meta apply-action end-to-end via the ALREADY-SHIPPED
 * `igris_suggestion_apply_action` → `applyAction` → `applyClusterMeta` path:
 *   - a queued `cartographer` `cluster_meta` suggestion, applied by the operator,
 *     CREATES a synthesized meta-learning, wires `cluster_member_of` edges member
 *     → meta (via handleEdgeCreate), writes ONE undo entry, and marks the
 *     suggestion acted;
 *   - undo of the cluster_meta DELETES the meta-learning + removes its
 *     cluster_member_of edges (the CREATE-reversing undo branch);
 *   - validation fails closed on < 2 members / a hallucinated member / a blank
 *     summary.
 *
 * `getDb` is mocked so `handleEdgeCreate` (used inside applyClusterMeta) sees the
 * same in-memory DB.
 *
 * @module engine/components/cartographer/__tests__/apply-roundtrip.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applyAction } from '../../subconscious/actions/index.js';
import { applyClusterMeta } from '../../subconscious/actions/kinds.js';
import { performUndo } from '../../janitor/undo.js';
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
      embedding BLOB,
      embedding_model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  for (const m of edgeMigrations) db.exec(m.sql);
  for (const m of janitorMigrations) db.exec(m.sql);
  db.prepare(
    `INSERT INTO learnings (id, project, title, content) VALUES
      (1,'proj','L1','content 1'),(2,'proj','L2','content 2'),(3,'proj','L3','content 3')`,
  ).run();
  return db;
}

function queueClusterMeta(db: Database.Database, action: Record<string, unknown>): number {
  const res = db
    .prepare(
      `INSERT INTO suggestions (source_module, title, evidence, priority, status, suggested_action, type_inferred)
       VALUES ('cartographer','meta','{}','low','pending', ?, 1)`,
    )
    .run(JSON.stringify(action));
  return Number(res.lastInsertRowid);
}

const ACTION = {
  kind: 'cluster_meta',
  cluster_member_ids: [1, 2, 3],
  title: 'Shared theme',
  synthesized_summary: 'These learnings all describe the same underlying principle.',
  confidence: 0.7,
};

describe('FR-116 M4 cluster_meta round-trip (propose → apply → meta + edges)', () => {
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

  it('apply creates the meta-learning + wires cluster_member_of edges + writes undo', () => {
    const sid = queueClusterMeta(db, ACTION);
    const result = applyAction(db, sid);
    expect(result.isError).toBeFalsy();

    // The meta-learning exists (a 4th learning, approved, carrying the summary).
    const meta = db
      .prepare(`SELECT id, content, review_status FROM learnings WHERE id > 3`)
      .get() as { id: number; content: string; review_status: string };
    expect(meta).toBeDefined();
    expect(meta.content).toContain('underlying principle');
    expect(meta.review_status).toBe('approved');

    // Three cluster_member_of edges member → meta.
    const edges = db
      .prepare(
        `SELECT from_id FROM entity_edges WHERE edge_type='cluster_member_of' AND to_id=? ORDER BY from_id`,
      )
      .all(String(meta.id)) as Array<{ from_id: string }>;
    expect(edges.map((e) => e.from_id)).toEqual(['1', '2', '3']);

    // Suggestion acted.
    const sugg = db.prepare(`SELECT status FROM suggestions WHERE id=?`).get(sid) as { status: string };
    expect(sugg.status).toBe('acted');

    // One undo entry keyed on the meta id.
    const undo = db
      .prepare(`SELECT action_kind, learning_id FROM brain_maintenance_undo WHERE action_kind='cluster_meta'`)
      .get() as { action_kind: string; learning_id: number };
    expect(undo).toMatchObject({ action_kind: 'cluster_meta', learning_id: meta.id });
  });

  it('undo DELETES the meta-learning and removes the cluster_member_of edges', () => {
    const apply = applyClusterMeta(db, ACTION);
    expect(apply.ok).toBe(true);
    const metaId = (apply.data as { meta_learning_id: number }).meta_learning_id;
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM entity_edges WHERE edge_type='cluster_member_of'`).get() as { n: number }).n,
    ).toBe(3);

    const entry = db
      .prepare(`SELECT id FROM brain_maintenance_undo WHERE action_kind='cluster_meta'`)
      .get() as { id: number };
    const r = performUndo(db, { entry_id: entry.id });
    expect(r.ok).toBe(true);
    expect(r.reversed).toBe(1);

    // Meta gone, edges gone, original members untouched.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM learnings WHERE id=?`).get(metaId)).toMatchObject({ n: 0 });
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM entity_edges WHERE edge_type='cluster_member_of'`).get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM learnings WHERE id IN (1,2,3)`).get() as { n: number }).n,
    ).toBe(3);
  });

  it('fails closed on < 2 members / a hallucinated member / a blank summary', () => {
    expect(applyClusterMeta(db, { ...ACTION, cluster_member_ids: [1] }).ok).toBe(false);
    expect(applyClusterMeta(db, { ...ACTION, cluster_member_ids: [1, 2, 999] }).ok).toBe(false);
    expect(applyClusterMeta(db, { ...ACTION, synthesized_summary: '' }).ok).toBe(false);
    // No meta-learning leaked on any failed apply.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM learnings`).get() as { n: number }).n).toBe(3);
  });
});
