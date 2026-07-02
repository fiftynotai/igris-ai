/**
 * Emergence apply-roundtrip tests (FR-116 M5, Decision #3b).
 *
 * The emergence sweep surfaces a PROPOSAL-ONLY `propose_edge_type` suggestion;
 * applying it is INFORMATIONAL — it records the operator's acknowledgement and
 * makes the human follow-up explicit, but MUST NOT grow the edge vocabulary.
 *
 * The load-bearing assertions (Decision #3b):
 *   - applying the suggestion marks it `acted` (durable acknowledgement);
 *   - `VALID_EDGE_TYPES` is byte-identical before AND after the apply (NO runtime
 *     mutation, NO dynamic registry);
 *   - the apply result declares `vocabulary_mutated: false` + points at the file
 *     the human edits;
 *   - the `entity_edges` rows are unchanged by the whole roundtrip.
 *
 * @module engine/components/janitor/__tests__/emergence-apply.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { surfaceEdgeTypeProposals, type EmergenceConfig } from '../emergence.js';
import { applyAction } from '../../subconscious/actions/index.js';
import { VALID_EDGE_TYPES } from '../../edges/handlers.js';
import { edgeMigrations } from '../../edges/schema.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { getDb } from '../../../../db.js';

vi.mock('../../../../db.js', () => ({ getDb: vi.fn() }));

const CFG: EmergenceConfig = { enabled: true, min_count: 5, max_proposals: 10, max_sample_ids: 3 };

function makeBrain(): Database.Database {
  const db = new Database(':memory:');
  for (const m of edgeMigrations) db.exec(m.sql);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  return db;
}

function seedInferredEdges(db: Database.Database, n: number, detector: string): void {
  const stmt = db.prepare(
    `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type, provenance, metadata)
     VALUES ('learning', '1', 'learning', ?, 'related_to', 'inferred', ?)`,
  );
  for (let i = 0; i < n; i++) stmt.run(String(1000 + i), JSON.stringify({ detector }));
}

function parse<T>(result: { content: { text: string }[]; isError?: boolean }): T {
  return JSON.parse(result.content[0].text) as T;
}

describe('FR-116 M5 — propose_edge_type apply is informational (proposal-only)', () => {
  let db: Database.Database;
  beforeEach(() => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });
  afterEach(() => db.close());

  it('applies the proposal without growing VALID_EDGE_TYPES (Decision #3b)', () => {
    seedInferredEdges(db, 6, 'authored_by');
    expect(surfaceEdgeTypeProposals(db, CFG)).toBe(1);

    const suggestionId = (
      db
        .prepare(
          `SELECT id FROM suggestions WHERE suggested_action LIKE '%"kind":"propose_edge_type"%' LIMIT 1`,
        )
        .get() as { id: number }
    ).id;

    // Snapshot the vocabulary + edges BEFORE the apply.
    const vocabBefore = [...VALID_EDGE_TYPES];
    const edgesBefore = db.prepare('SELECT * FROM entity_edges ORDER BY id').all();

    const result = applyAction(db, suggestionId);
    expect(result.isError).toBeFalsy();
    const payload = parse<{
      applied: boolean;
      action_kind: string;
      message: string;
      result: Record<string, unknown>;
      suggestion: { status: string };
    }>(result);

    // Marked acted (durable acknowledgement).
    expect(payload.applied).toBe(true);
    expect(payload.action_kind).toBe('propose_edge_type');
    expect(payload.suggestion.status).toBe('acted');

    // INFORMATIONAL: the result declares the vocabulary was NOT mutated + names
    // the file the human must edit.
    expect(payload.result.vocabulary_mutated).toBe(false);
    expect(payload.result.requires_code_edit).toBe(true);
    expect(payload.result.target_constant).toBe('VALID_EDGE_TYPES');
    expect(payload.message).toContain('VALID_EDGE_TYPES');

    // Decision #3b: the vocabulary array is byte-identical before AND after apply.
    expect([...VALID_EDGE_TYPES]).toEqual(vocabBefore);
    expect((VALID_EDGE_TYPES as readonly string[]).includes('authored_by')).toBe(false);

    // The edges are unchanged by the whole roundtrip (read-only).
    expect(db.prepare('SELECT * FROM entity_edges ORDER BY id').all()).toEqual(edgesBefore);
  });

  it('re-applying is refused (idempotent acknowledgement — already acted)', () => {
    seedInferredEdges(db, 6, 'authored_by');
    surfaceEdgeTypeProposals(db, CFG);
    const suggestionId = (
      db
        .prepare(
          `SELECT id FROM suggestions WHERE suggested_action LIKE '%"kind":"propose_edge_type"%' LIMIT 1`,
        )
        .get() as { id: number }
    ).id;

    expect(applyAction(db, suggestionId).isError).toBeFalsy();
    // Second apply is refused (already acted) — the acted suggestion IS the durable record.
    const second = applyAction(db, suggestionId);
    expect(second.isError).toBe(true);
    // Vocabulary still unchanged.
    expect((VALID_EDGE_TYPES as readonly string[]).includes('authored_by')).toBe(false);
  });
});
