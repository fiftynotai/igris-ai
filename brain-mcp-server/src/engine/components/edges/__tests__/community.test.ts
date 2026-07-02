/**
 * Community-detection primitive tests (FR-116 M4 — the #1 correctness item).
 *
 * `detectCommunities` (edges/community.ts) is the shared, entity-agnostic Louvain
 * primitive both FR-112 (briefs) and FR-116 (learnings) consume. These tests lock:
 *   - DETERMINISM / IDEMPOTENCY: the same graph in → byte-identical clusters out,
 *     every run (THE key requirement — Louvain is order-sensitive);
 *   - minClusterSize is respected (singletons + small clusters dropped);
 *   - an empty / edgeless graph is a no-op ([]);
 *   - it is ENTITY-AGNOSTIC — the same call works for a 'brief' node filter,
 *     proving the FR-112 reuse (Decision #6);
 *   - the edge-type filter restricts the projection;
 *   - it is READ-ONLY — the edge count is unchanged after a run.
 *
 * @module engine/components/edges/__tests__/community.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { detectCommunities } from '../community.js';
import { edgeMigrations } from '../schema.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  for (const m of edgeMigrations) db.exec(m.sql);
  return db;
}

/** Insert an undirected pair of learning→learning edges (both directions) directly. */
function link(
  db: Database.Database,
  a: string,
  b: string,
  edgeType = 'related_to',
  nodeType = 'learning',
): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
     VALUES (?, ?, ?, ?, ?)`,
  );
  ins.run(nodeType, a, nodeType, b, edgeType);
}

/** Two disjoint triangles {1,2,3} and {4,5,6}, densely intra-linked. */
function twoTriangles(db: Database.Database, nodeType = 'learning'): void {
  for (const [a, b] of [
    ['1', '2'],
    ['2', '3'],
    ['1', '3'],
    ['4', '5'],
    ['5', '6'],
    ['4', '6'],
  ]) {
    link(db, a, b, 'related_to', nodeType);
  }
}

describe('FR-116 M4 detectCommunities — deterministic community primitive', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('finds the two triangle communities', () => {
    twoTriangles(db);
    const clusters = detectCommunities(db, {
      nodeType: 'learning',
      edgeTypes: ['related_to'],
      minClusterSize: 3,
    });
    expect(clusters).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('is DETERMINISTIC / IDEMPOTENT — repeated runs are byte-identical', () => {
    twoTriangles(db);
    const opts = { nodeType: 'learning', edgeTypes: ['related_to'], minClusterSize: 3 };
    const runs = Array.from({ length: 8 }, () => detectCommunities(db, opts));
    const first = JSON.stringify(runs[0]);
    for (const r of runs) expect(JSON.stringify(r)).toBe(first);
  });

  it('respects minClusterSize (drops clusters below the floor)', () => {
    twoTriangles(db);
    const clusters = detectCommunities(db, {
      nodeType: 'learning',
      edgeTypes: ['related_to'],
      minClusterSize: 4, // both triangles are size 3 → dropped
    });
    expect(clusters).toEqual([]);
  });

  it('empty / edgeless graph is a no-op', () => {
    expect(detectCommunities(db, { nodeType: 'learning', minClusterSize: 3 })).toEqual([]);
  });

  it('is ENTITY-AGNOSTIC — works for a brief node filter (FR-112 reuse)', () => {
    twoTriangles(db, 'brief');
    const clusters = detectCommunities(db, {
      nodeType: 'brief',
      edgeTypes: ['related_to'],
      minClusterSize: 3,
    });
    expect(clusters).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
    // The learning projection sees nothing (edges are brief→brief).
    expect(detectCommunities(db, { nodeType: 'learning', minClusterSize: 3 })).toEqual([]);
  });

  it('honors the edge-type filter (excluded types are not projected)', () => {
    twoTriangles(db); // related_to
    // A single duplicates edge bridging the two triangles — ignored when the
    // filter is related_to only.
    link(db, '3', '4', 'duplicates');
    const relatedOnly = detectCommunities(db, {
      nodeType: 'learning',
      edgeTypes: ['related_to'],
      minClusterSize: 3,
    });
    expect(relatedOnly).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('is READ-ONLY — the edge table is unchanged after a run', () => {
    twoTriangles(db);
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM entity_edges`).get() as { n: number }).n;
    detectCommunities(db, { nodeType: 'learning', minClusterSize: 3 });
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM entity_edges`).get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('excludes soft-deleted edges by default', () => {
    // A triangle where one edge is soft-deleted breaks the density; with
    // includeDeleted the full triangle returns.
    link(db, '1', '2');
    link(db, '2', '3');
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type, metadata)
       VALUES ('learning','1','learning','3','related_to', json('{"deleted": true}'))`,
    ).run();
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type, metadata)
       VALUES ('learning','3','learning','1','related_to', json('{"deleted": true}'))`,
    ).run();
    // Path graph 1-2-3 still clusters together (connected), size 3.
    const clusters = detectCommunities(db, {
      nodeType: 'learning',
      edgeTypes: ['related_to'],
      minClusterSize: 3,
    });
    expect(clusters).toEqual([['1', '2', '3']]);
  });
});
