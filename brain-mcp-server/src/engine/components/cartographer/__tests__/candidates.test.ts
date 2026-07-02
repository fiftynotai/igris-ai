/**
 * Cartographer candidate-generation tests (FR-116 M4).
 *
 * Locks `buildClusters` (buildContext source): it runs the deterministic community
 * primitive over the learning subgraph, filters each cluster to APPROVED members,
 * assembles digests, and applies the don't-double-summarize exclusions:
 *   - a cluster with an already-clustered member (existing cluster_member_of edge)
 *     is skipped;
 *   - a cluster already pending as a cartographer suggestion is skipped;
 *   - non-approved members are excluded (and a cluster that drops below
 *     min_cluster_size after that filter is dropped);
 *   - the result is deterministic.
 *
 * @module engine/components/cartographer/__tests__/candidates.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildClusters } from '../candidates.js';
import { DEFAULT_CARTOGRAPHER_CONFIG } from '../types.js';
import { edgeMigrations } from '../../edges/schema.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';

function makeBrain(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL DEFAULT 'p',
      category TEXT NOT NULL DEFAULT 'pattern',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      review_status TEXT NOT NULL DEFAULT 'approved',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  for (const m of edgeMigrations) db.exec(m.sql);
  return db;
}

function seedLearnings(db: Database.Database, ids: number[], status = 'approved'): void {
  const ins = db.prepare(
    `INSERT INTO learnings (id, title, content, review_status) VALUES (?, ?, ?, ?)`,
  );
  for (const id of ids) ins.run(id, `L${id}`, `content of learning ${id}`, status);
}

function link(db: Database.Database, a: string, b: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
     VALUES ('learning', ?, 'learning', ?, 'related_to')`,
  ).run(a, b);
}

function triangle(db: Database.Database, a: string, b: string, c: string): void {
  link(db, a, b);
  link(db, b, c);
  link(db, a, c);
}

const CFG = { ...DEFAULT_CARTOGRAPHER_CONFIG, min_cluster_size: 3 };

describe('FR-116 M4 buildClusters', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
  });
  afterEach(() => db.close());

  it('returns the detected clusters with approved-member digests', () => {
    seedLearnings(db, [1, 2, 3, 4, 5, 6]);
    triangle(db, '1', '2', '3');
    triangle(db, '4', '5', '6');

    const clusters = buildClusters(db, CFG);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].member_ids).toEqual([1, 2, 3]);
    expect(clusters[0].cluster_index).toBe(0);
    expect(clusters[0].members.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(clusters[0].members[0].snippet).toContain('learning 1');
    expect(clusters[1].member_ids).toEqual([4, 5, 6]);
  });

  it('skips a cluster whose member is already summarized (cluster_member_of edge exists)', () => {
    seedLearnings(db, [1, 2, 3, 4, 5, 6, 99]);
    triangle(db, '1', '2', '3');
    triangle(db, '4', '5', '6');
    // Member 1 already belongs to a meta (999) → its whole cluster is skipped.
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
       VALUES ('learning','1','learning','999','cluster_member_of')`,
    ).run();

    const clusters = buildClusters(db, CFG);
    expect(clusters.map((c) => c.member_ids)).toEqual([[4, 5, 6]]);
  });

  it('skips a cluster already pending as a cartographer suggestion', () => {
    seedLearnings(db, [1, 2, 3, 4, 5, 6]);
    triangle(db, '1', '2', '3');
    triangle(db, '4', '5', '6');
    db.prepare(
      `INSERT INTO suggestions (source_module, title, evidence, priority, status, suggested_action, type_inferred)
       VALUES ('cartographer','x','{}','low','pending', ?, 1)`,
    ).run(JSON.stringify({ kind: 'cluster_meta', cluster_member_ids: [4, 5, 6] }));

    const clusters = buildClusters(db, CFG);
    expect(clusters.map((c) => c.member_ids)).toEqual([[1, 2, 3]]);
  });

  it('excludes non-approved members and drops clusters that fall below min_cluster_size', () => {
    seedLearnings(db, [1, 2], 'approved');
    seedLearnings(db, [3], 'pruned'); // not recallable
    triangle(db, '1', '2', '3');

    const clusters = buildClusters(db, CFG);
    // {1,2,3} detected but only {1,2} approved → below min 3 → dropped.
    expect(clusters).toEqual([]);
  });
});
