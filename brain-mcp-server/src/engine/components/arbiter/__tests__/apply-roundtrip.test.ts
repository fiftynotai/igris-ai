/**
 * Arbiter contradiction-resolution round-trip test (FR-116 M2).
 *
 * Proves `resolve_contradiction` end-to-end via the ALREADY-SHIPPED
 * `igris_suggestion_apply_action` → `applyAction` → `applyResolveContradiction`
 * path:
 *
 *   - newer_wins: a queued `arbiter` suggestion, applied by the operator, marks
 *     the OLDER learning review_status='superseded' (+ deleted_at + superseded_by
 *     audit columns), writes a `supersedes` edge winner→loser, leaves the winner
 *     intact, and marks the suggestion acted;
 *   - the superseded learning is EXCLUDED by an approved-filter recall/search/sync
 *     query (Decision #1 — ZERO read-path sweep proof);
 *   - both_valid_scope: NON-DESTRUCTIVE — both learnings stay approved, each gets
 *     a [valid-scope: …] annotation, no delete;
 *   - evolved_merge: the winner's content becomes the synthesized understanding
 *     (embedding NULLed), seen_again_count rolls, the loser is superseded;
 *   - re-applying a newer_wins on an already-superseded loser is a NO-OP;
 *   - fails closed on hallucinated / self ids.
 *
 * `getDb` is mocked so `handleEdgeCreate` (used inside the executor) sees the same
 * in-memory DB.
 *
 * @module engine/components/arbiter/__tests__/apply-roundtrip.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { applyAction } from '../../subconscious/actions/index.js';
import { applyResolveContradiction } from '../../subconscious/actions/kinds.js';
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
  for (const m of janitorMigrations) db.exec(m.sql); // v1 deleted_at/merged_into + v2 superseded_by
  // id1 = older (loser), id2 = newer (winner).
  db.prepare(
    `INSERT INTO learnings (id, title, content, seen_again_count, created_at)
     VALUES (1,'Retry','use retry backoff', 2, datetime('now','-30 days')),
            (2,'Retry','never use retry backoff, it is wrong; use circuit-breaker', 3, datetime('now'))`,
  ).run();
  return db;
}

function queueArbiterSuggestion(db: Database.Database, action: Record<string, unknown>): number {
  const res = db
    .prepare(
      `INSERT INTO suggestions (source_module, title, evidence, priority, status, suggested_action, type_inferred)
       VALUES ('arbiter','resolve','{}','low','pending', ?, 1)`,
    )
    .run(JSON.stringify(action));
  return Number(res.lastInsertRowid);
}

describe('FR-116 M2 resolve_contradiction round-trip (propose → apply)', () => {
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

  it('newer_wins: supersedes the older learning + writes a supersedes edge, winner intact', () => {
    const id = queueArbiterSuggestion(db, {
      kind: 'resolve_contradiction',
      resolution: 'newer_wins',
      winner_id: 2,
      loser_id: 1,
      justification: 'circuit-breaker replaced retry backoff',
    });

    const result = applyAction(db, id);
    expect(result.isError).toBeFalsy();

    // Loser (older) superseded with audit columns stamped.
    const loser = db
      .prepare(`SELECT review_status, deleted_at, superseded_by FROM learnings WHERE id=1`)
      .get() as { review_status: string; deleted_at: string | null; superseded_by: number | null };
    expect(loser.review_status).toBe('superseded');
    expect(loser.deleted_at).not.toBeNull();
    expect(loser.superseded_by).toBe(2);

    // Winner untouched (still approved, content unchanged).
    const winner = db.prepare(`SELECT review_status, content FROM learnings WHERE id=2`).get() as {
      review_status: string;
      content: string;
    };
    expect(winner.review_status).toBe('approved');
    expect(winner.content).toContain('circuit-breaker');

    // supersedes edge winner→loser exists (VALID_EDGE_TYPES already has it — no vocab change).
    const edge = db
      .prepare(
        `SELECT from_id, to_id, edge_type, provenance FROM entity_edges
          WHERE edge_type='supersedes'`,
      )
      .get() as { from_id: string; to_id: string; edge_type: string; provenance: string };
    expect(edge).toMatchObject({ from_id: '2', to_id: '1', edge_type: 'supersedes', provenance: 'inferred' });

    // Suggestion acted.
    const sugg = db.prepare(`SELECT status FROM suggestions WHERE id=?`).get(id) as { status: string };
    expect(sugg.status).toBe('acted');
  });

  it('zero-sweep proof: a superseded row is EXCLUDED by an approved-filter recall/search/sync query', () => {
    applyResolveContradiction(db, { resolution: 'newer_wins', winner_id: 2, loser_id: 1 });
    // The ~10 `review_status='approved'` readers (memory.ts recall/search, digest,
    // sync push) all gate on this exact predicate — no reader edit for 'superseded'.
    const approved = db
      .prepare(`SELECT id FROM learnings WHERE review_status='approved' ORDER BY id`)
      .all() as Array<{ id: number }>;
    expect(approved.map((r) => r.id)).toEqual([2]);
    // The COALESCE variant (digest.ts:248 / sync.ts:952) excludes it too.
    const coalesced = db
      .prepare(`SELECT id FROM learnings WHERE COALESCE(review_status,'approved')='approved' ORDER BY id`)
      .all() as Array<{ id: number }>;
    expect(coalesced.map((r) => r.id)).toEqual([2]);
  });

  it('both_valid_scope: NON-DESTRUCTIVE — both retained, each annotated with a scope', () => {
    const id = queueArbiterSuggestion(db, {
      kind: 'resolve_contradiction',
      resolution: 'both_valid_scope',
      learning_a_id: 1,
      learning_b_id: 2,
      scope_a: 'low-latency internal calls',
      scope_b: 'flaky third-party APIs',
    });
    db.prepare(`UPDATE learnings SET embedding = X'00', embedding_model = 'm' WHERE id IN (1,2)`).run();

    const result = applyAction(db, id);
    expect(result.isError).toBeFalsy();

    // Neither is deleted — both still approved.
    const rows = db
      .prepare(`SELECT id, review_status, content, embedding FROM learnings ORDER BY id`)
      .all() as Array<{ id: number; review_status: string; content: string; embedding: Buffer | null }>;
    expect(rows.every((r) => r.review_status === 'approved')).toBe(true);
    expect(rows[0].content).toContain('[valid-scope: low-latency internal calls]');
    expect(rows[1].content).toContain('[valid-scope: flaky third-party APIs]');
    // Content changed → embedding NULLed for the FR-220 re-embed scan.
    expect(rows[0].embedding).toBeNull();
    expect(rows[1].embedding).toBeNull();
  });

  it('both_valid_scope is idempotent (re-applying does not double-annotate)', () => {
    const action = {
      resolution: 'both_valid_scope',
      learning_a_id: 1,
      learning_b_id: 2,
      scope_a: 'scope-one',
    };
    applyResolveContradiction(db, action);
    const after1 = (db.prepare(`SELECT content FROM learnings WHERE id=1`).get() as { content: string }).content;
    applyResolveContradiction(db, action);
    const after2 = (db.prepare(`SELECT content FROM learnings WHERE id=1`).get() as { content: string }).content;
    expect(after2).toBe(after1);
    expect((after2.match(/\[valid-scope:/g) ?? []).length).toBe(1);
  });

  it('evolved_merge: writes the synthesized understanding onto the winner + supersedes the loser', () => {
    db.prepare(`UPDATE learnings SET embedding = X'00', embedding_model = 'm' WHERE id=2`).run();
    // TD-439 2026-09-04: evolved_merge is hash-guarded; a hash-less action is
    // refused (see td439-merge-guard.test.ts T1b). The action now carries
    // sha256 of the winner's CURRENT content, as `persistArbiterProposal` stamps it.
    const result = applyResolveContradiction(db, {
      resolution: 'evolved_merge',
      winner_id: 2,
      loser_id: 1,
      synthesized_content: 'prefer circuit-breaker; retry backoff only for idempotent calls',
      synthesized_from_hash: createHash('sha256')
        .update('never use retry backoff, it is wrong; use circuit-breaker', 'utf8')
        .digest('hex'),
    });
    expect(result.ok).toBe(true);

    const winner = db
      .prepare(`SELECT content, seen_again_count, embedding, review_status FROM learnings WHERE id=2`)
      .get() as { content: string; seen_again_count: number; embedding: Buffer | null; review_status: string };
    // Neither input carries an executable specific, so the carry-forward appends
    // nothing (measured carried = 0) and the content is the synthesis exactly.
    expect(winner.content).toBe('prefer circuit-breaker; retry backoff only for idempotent calls');
    expect(result.data?.specifics_carried).toBe(0);
    expect(winner.seen_again_count).toBe(2 + 3 + 1); // rolled
    expect(winner.embedding).toBeNull();
    expect(winner.review_status).toBe('approved');

    const loser = db.prepare(`SELECT review_status, superseded_by FROM learnings WHERE id=1`).get() as {
      review_status: string;
      superseded_by: number | null;
    };
    expect(loser.review_status).toBe('superseded');
    expect(loser.superseded_by).toBe(2);

    const edge = db
      .prepare(`SELECT from_id, to_id FROM entity_edges WHERE edge_type='supersedes'`)
      .get() as { from_id: string; to_id: string };
    expect(edge).toMatchObject({ from_id: '2', to_id: '1' });
  });

  it('re-applying a newer_wins on an already-superseded loser is a NO-OP (idempotent)', () => {
    const first = applyResolveContradiction(db, { resolution: 'newer_wins', winner_id: 2, loser_id: 1 });
    expect(first.ok).toBe(true);
    const second = applyResolveContradiction(db, { resolution: 'newer_wins', winner_id: 2, loser_id: 1 });
    expect(second.ok).toBe(true);
    expect(second.message).toMatch(/already superseded/i);
    // Exactly one supersedes edge (idempotent edge create).
    const n = db.prepare(`SELECT COUNT(*) AS n FROM entity_edges WHERE edge_type='supersedes'`).get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('fails closed on non-existent / self ids', () => {
    expect(applyResolveContradiction(db, { resolution: 'newer_wins', winner_id: 2, loser_id: 999 }).ok).toBe(false);
    expect(applyResolveContradiction(db, { resolution: 'newer_wins', winner_id: 5, loser_id: 5 }).ok).toBe(false);
    expect(applyResolveContradiction(db, { resolution: 'evolved_merge', winner_id: 2, loser_id: 1 }).ok).toBe(false); // no synthesized_content
    expect(applyResolveContradiction(db, { resolution: 'bogus', winner_id: 2, loser_id: 1 }).ok).toBe(false);
  });
});
