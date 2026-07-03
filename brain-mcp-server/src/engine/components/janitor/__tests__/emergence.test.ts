/**
 * Janitor edge-type EMERGENCE sweep tests (FR-116 M5, op #6 / Decision #3b).
 *
 * Covers the DETERMINISTIC signature-counting pass + the PROPOSAL-ONLY surfacing:
 *   - counting is deterministic + correct: ≥N occurrences of a NOVEL signature →
 *     exactly one proposal; <N → nothing;
 *   - a signature that matches an EXISTING VALID_EDGE_TYPES literal is NEVER
 *     proposed (already canonical);
 *   - `metadata.source` (the writer/provenance) is NOT treated as a signature —
 *     recurring `source` values do NOT produce proposals (only the relation-label
 *     field chain does);
 *   - NON-DESTRUCTIVE: a run mutates NO `entity_edges` row and leaves the
 *     `VALID_EDGE_TYPES` array byte-identical (proposal-only — no vocab change);
 *   - config-gate off-by-default (both `janitor.enabled` AND `emergence.enabled`
 *     required);
 *   - deterministic order + capped sample ids;
 *   - don't-double-queue (a re-run does not re-insert a pending proposal);
 *   - soft-deleted + non-inferred edges excluded.
 *
 * No mocks (L-159): the functions take the DB + config directly.
 *
 * @module engine/components/janitor/__tests__/emergence.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  detectEmergentEdgeTypes,
  surfaceEdgeTypeProposals,
  resolveEmergenceConfig,
  normalizeSignature,
  DEFAULT_EMERGENCE_CONFIG,
  type EmergenceConfig,
} from '../emergence.js';
import { VALID_EDGE_TYPES } from '../../edges/handlers.js';
import { edgeMigrations } from '../../edges/schema.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';

/** Build entity_edges (edgeMigrations) + suggestions (subconscious v1). */
function makeBrain(): Database.Database {
  const db = new Database(':memory:');
  for (const m of edgeMigrations) db.exec(m.sql);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  return db;
}

let _to = 0;
/**
 * Insert `n` inferred edges each carrying `metadata` (merged with `deleted`/etc).
 * Each edge gets a distinct `to_id` so the UNIQUE 5-tuple never collides.
 */
function seedEdges(
  db: Database.Database,
  n: number,
  metadata: Record<string, unknown>,
  opts: { provenance?: string; edge_type?: string } = {},
): number[] {
  const ids: number[] = [];
  const stmt = db.prepare(
    `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type, provenance, metadata)
     VALUES ('learning', '1', 'learning', ?, ?, ?, ?)`,
  );
  for (let i = 0; i < n; i++) {
    _to += 1;
    const info = stmt.run(
      String(_to),
      opts.edge_type ?? 'related_to',
      opts.provenance ?? 'inferred',
      JSON.stringify(metadata),
    );
    ids.push(Number(info.lastInsertRowid));
  }
  return ids;
}

function pendingProposals(db: Database.Database): Array<{ suggested_action: string; title: string }> {
  return db
    .prepare(
      `SELECT title, suggested_action FROM suggestions
        WHERE status = 'pending' AND source_module = 'janitor'
          AND suggested_action LIKE '%"kind":"propose_edge_type"%'
        ORDER BY id ASC`,
    )
    .all() as Array<{ suggested_action: string; title: string }>;
}

const CFG: EmergenceConfig = { enabled: true, min_count: 5, max_proposals: 10, max_sample_ids: 3 };

describe('normalizeSignature', () => {
  it('lower-snakes a raw signature and strips edge chars', () => {
    expect(normalizeSignature('  Authored-By  ')).toBe('authored_by');
    expect(normalizeSignature('caused by')).toBe('caused_by');
    expect(normalizeSignature('X')).toBe('x');
    expect(normalizeSignature('')).toBe('');
    expect(normalizeSignature(42)).toBe('');
    expect(normalizeSignature(undefined)).toBe('');
  });
});

describe('detectEmergentEdgeTypes (deterministic counting)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
  });
  afterEach(() => db.close());

  it('proposes a NOVEL signature that recurs >= min_count (exactly one proposal)', () => {
    seedEdges(db, 5, { detector: 'authored_by' });
    const out = detectEmergentEdgeTypes(db, 5, 10, 3);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      proposed_name: 'authored_by',
      signature: 'authored_by',
      occurrence_count: 5,
    });
    expect(out[0].sample_edge_ids).toHaveLength(3); // capped at max_sample_ids
    // sample ids ascending
    expect([...out[0].sample_edge_ids]).toEqual([...out[0].sample_edge_ids].sort((a, b) => a - b));
  });

  it('does NOT propose a signature below min_count', () => {
    seedEdges(db, 4, { detector: 'authored_by' });
    expect(detectEmergentEdgeTypes(db, 5, 10, 3)).toHaveLength(0);
  });

  it('does NOT propose a signature that matches an EXISTING edge type', () => {
    // 'related_to' is already a canonical VALID_EDGE_TYPES literal.
    seedEdges(db, 20, { detector: 'related_to' });
    expect(detectEmergentEdgeTypes(db, 5, 10, 3)).toHaveLength(0);
  });

  it('does NOT treat metadata.source (the writer/provenance) as a signature', () => {
    // A recurring `source` (e.g. merge_learnings) must NOT propose an edge type.
    seedEdges(db, 20, { source: 'merge_learnings' });
    expect(detectEmergentEdgeTypes(db, 5, 10, 3)).toHaveLength(0);
  });

  it('excludes non-inferred (observed) edges', () => {
    seedEdges(db, 20, { detector: 'authored_by' }, { provenance: 'observed' });
    expect(detectEmergentEdgeTypes(db, 5, 10, 3)).toHaveLength(0);
  });

  it('excludes soft-deleted edges', () => {
    seedEdges(db, 20, { detector: 'authored_by', deleted: true });
    expect(detectEmergentEdgeTypes(db, 5, 10, 3)).toHaveLength(0);
  });

  it('returns proposals sorted by signature ascending (deterministic)', () => {
    seedEdges(db, 6, { detector: 'zeta_rel' });
    seedEdges(db, 6, { detector: 'alpha_rel' });
    seedEdges(db, 6, { detector: 'mid_rel' });
    const out = detectEmergentEdgeTypes(db, 5, 10, 3);
    expect(out.map((p) => p.signature)).toEqual(['alpha_rel', 'mid_rel', 'zeta_rel']);
  });

  it('caps the number of proposals at max_proposals', () => {
    seedEdges(db, 6, { detector: 'a_rel' });
    seedEdges(db, 6, { detector: 'b_rel' });
    seedEdges(db, 6, { detector: 'c_rel' });
    const out = detectEmergentEdgeTypes(db, 5, 2, 3);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.signature)).toEqual(['a_rel', 'b_rel']); // first two ascending
  });

  it('reads the field chain (signature/relation/rel) when detector is absent', () => {
    seedEdges(db, 5, { relation: 'blocks_release' });
    const out = detectEmergentEdgeTypes(db, 5, 10, 3);
    expect(out.map((p) => p.signature)).toEqual(['blocks_release']);
  });
});

describe('surfaceEdgeTypeProposals (proposal-only surfacing)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
  });
  afterEach(() => db.close());

  it('surfaces ONE propose_edge_type suggestion per clearing signature', () => {
    seedEdges(db, 6, { detector: 'caused_by' });
    const n = surfaceEdgeTypeProposals(db, CFG);
    expect(n).toBe(1);
    const rows = pendingProposals(db);
    expect(rows).toHaveLength(1);
    const action = JSON.parse(rows[0].suggested_action) as Record<string, unknown>;
    expect(action).toMatchObject({
      kind: 'propose_edge_type',
      proposed_name: 'caused_by',
      signature: 'caused_by',
      occurrence_count: 6,
    });
    // The proposal text makes the human-code-edit follow-up explicit.
    expect(String(action.rationale)).toContain('VALID_EDGE_TYPES');
    expect(String(action.rationale)).toContain('PROPOSAL-ONLY');
  });

  it('is NON-DESTRUCTIVE: no entity_edges row is mutated + VALID_EDGE_TYPES unchanged', () => {
    const ids = seedEdges(db, 6, { detector: 'caused_by' });
    const before = db.prepare('SELECT id, metadata, edge_type FROM entity_edges ORDER BY id').all();
    const vocabBefore = [...VALID_EDGE_TYPES];

    surfaceEdgeTypeProposals(db, CFG);

    const after = db.prepare('SELECT id, metadata, edge_type FROM entity_edges ORDER BY id').all();
    expect(after).toEqual(before); // edges untouched
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get()).toEqual({ n: ids.length });
    // The vocabulary array is byte-identical (proposal-only — no runtime mutation).
    expect([...VALID_EDGE_TYPES]).toEqual(vocabBefore);
    // And the emergent name was NOT added to the vocabulary.
    expect((VALID_EDGE_TYPES as readonly string[]).includes('caused_by')).toBe(false);
  });

  it('does NOT double-queue: a re-run finds the pending proposal and skips it', () => {
    seedEdges(db, 6, { detector: 'caused_by' });
    expect(surfaceEdgeTypeProposals(db, CFG)).toBe(1);
    // Second run: same signature already pending → no new suggestion.
    expect(surfaceEdgeTypeProposals(db, CFG)).toBe(0);
    expect(pendingProposals(db)).toHaveLength(1);
  });

  it('surfaces nothing when no signature clears the threshold', () => {
    seedEdges(db, 3, { detector: 'caused_by' });
    expect(surfaceEdgeTypeProposals(db, CFG)).toBe(0);
    expect(pendingProposals(db)).toHaveLength(0);
  });
});

describe('resolveEmergenceConfig (config gate)', () => {
  it('defaults OFF (both toggles absent)', () => {
    const cfg = resolveEmergenceConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.min_count).toBe(DEFAULT_EMERGENCE_CONFIG.min_count);
  });

  it('stays OFF when janitor.enabled is true but emergence.enabled is absent (default OFF)', () => {
    const cfg = resolveEmergenceConfig({ cognition: { janitor: { enabled: true } } });
    expect(cfg.enabled).toBe(false);
  });

  it('stays OFF when emergence.enabled is true but janitor.enabled is false (double gate)', () => {
    const cfg = resolveEmergenceConfig({
      cognition: { janitor: { enabled: false, emergence: { enabled: true } } },
    });
    expect(cfg.enabled).toBe(false);
  });

  it('is ON only when BOTH janitor.enabled AND emergence.enabled are true', () => {
    const cfg = resolveEmergenceConfig({
      cognition: {
        janitor: { enabled: true, emergence: { enabled: true, min_count: 25 } },
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.min_count).toBe(25);
  });
});

describe('row-100 invariant — M5 does NOT change VALID_EDGE_TYPES', () => {
  it('the vocabulary is exactly the 10 literals through M4 (cluster_member_of), no M5 addition', () => {
    expect([...VALID_EDGE_TYPES]).toEqual([
      'parent_of',
      'depends_on',
      'blocks',
      'supersedes',
      'related_to',
      'serves_goal',
      'duplicates',
      'derived_from',
      'recurs_with',
      'cluster_member_of',
    ]);
  });
});
