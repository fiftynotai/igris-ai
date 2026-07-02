/**
 * Synapse review round-trip test (FR-211 — AC #2/#3).
 *
 * Proves the propose → pending suggestion → apply → edge path end-to-end,
 * reusing the ALREADY-SHIPPED `igris_suggestion_apply_action` → `applyAddEdge`
 * → `handleEdgeCreate(provenance:'inferred')` route (no new review/apply tools):
 *
 *   - runSynapse queues an `edge_inference` suggestion (review-gated default);
 *   - applyAction materialises an `entity_edges` row with `provenance='inferred'`
 *     on a learning↔learning tuple, and marks the suggestion `acted`;
 *   - the auto_approve fork (D5) writes the edge directly, no suggestion row.
 *
 * `getDb` is mocked so `handleEdgeCreate` (used by add_edge + the auto_approve
 * path) sees the same in-memory DB the run wrote to.
 *
 * @module engine/components/synapse/__tests__/apply-roundtrip.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runSynapse } from '../runner.js';
import { DEFAULT_SYNAPSE_CONFIG, type SynapseConfig } from '../types.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { edgeMigrations } from '../../edges/schema.js';
import { applyAction } from '../../subconscious/actions/index.js';
import type { ResolvedBackend } from '../../cognition/types.js';
import type { BackendRunResult } from '../../cognition/backend/index.js';
import { getDb } from '../../../../db.js';

vi.mock('../../../../db.js', () => ({ getDb: vi.fn() }));

function makeBrain(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL, component TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', machine_hostname TEXT,
      project_slug TEXT, instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL DEFAULT 'p', category TEXT NOT NULL DEFAULT 'pattern',
      title TEXT NOT NULL, content TEXT NOT NULL, source_brief TEXT DEFAULT '',
      embedding BLOB
    );
  `);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  for (const m of edgeMigrations) db.exec(m.sql);
  db.prepare(
    `INSERT INTO learnings (id, project, category, title, content, source_brief)
     VALUES (1,'p','pattern','A','alpha','BR-1'),(2,'p','pattern','B','beta','BR-1')`,
  ).run();
  return db;
}

function deps(text: string) {
  const backend: ResolvedBackend = { harness: 'claude', fallback_order: ['claude'] };
  return {
    resolveBackend: () => backend,
    runBackend: async (): Promise<BackendRunResult> => ({ ok: true, text }),
    isColdStart: () => false,
  };
}

const RUNNABLE: SynapseConfig = { ...DEFAULT_SYNAPSE_CONFIG, enabled: true, min_input_bytes: 0 };

interface EdgeRow {
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  edge_type: string;
  provenance: string;
}

describe('FR-211 review round-trip (propose → apply → inferred edge)', () => {
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

  it('propose → pending suggestion → apply_action → entity_edges(provenance=inferred)', async () => {
    // No inferred learning↔learning edge exists before the run.
    const before = db
      .prepare(
        `SELECT COUNT(*) AS n FROM entity_edges
          WHERE provenance='inferred' AND from_type='learning' AND to_type='learning'`,
      )
      .get() as { n: number };
    expect(before.n).toBe(0);

    const canned = JSON.stringify([
      { from_id: 2, to_id: 1, edge_type: 'supersedes', confidence: 0.8, justification: 'B replaces A' },
    ]);
    const run = await runSynapse(db, 'all', { config: RUNNABLE, deps: deps(canned) });
    expect(run.outcome).toBe('succeeded');

    const sugg = db.prepare(`SELECT id, status FROM suggestions WHERE source_module='edge_inference'`).get() as {
      id: number;
      status: string;
    };
    expect(sugg.status).toBe('pending');

    // Operator applies the reviewed suggestion.
    const result = applyAction(db, sugg.id);
    expect(result.isError).toBeFalsy();

    const edge = db
      .prepare(
        `SELECT from_type, from_id, to_type, to_id, edge_type, provenance FROM entity_edges
          WHERE provenance='inferred' AND from_type='learning' AND to_type='learning'`,
      )
      .get() as EdgeRow;
    expect(edge).toMatchObject({
      from_type: 'learning',
      from_id: '2',
      to_type: 'learning',
      to_id: '1',
      edge_type: 'supersedes',
      provenance: 'inferred',
    });

    // Suggestion is now marked acted.
    const after = db.prepare(`SELECT status FROM suggestions WHERE id=?`).get(sugg.id) as { status: string };
    expect(after.status).toBe('acted');
  });

  it('auto_approve=true writes the edge directly, no suggestion row (D5)', async () => {
    const canned = JSON.stringify([
      { from_id: 1, to_id: 2, edge_type: 'related_to', confidence: 0.7, justification: 'linked' },
    ]);
    const run = await runSynapse(db, 'all', {
      config: { ...RUNNABLE, auto_approve: true },
      deps: deps(canned),
    });
    expect(run.outcome).toBe('succeeded');
    expect(run.persisted).toBe(1);

    // No suggestion queued.
    const suggN = db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE source_module='edge_inference'`).get() as {
      n: number;
    };
    expect(suggN.n).toBe(0);

    // Edge written directly with provenance='inferred'.
    const edge = db
      .prepare(
        `SELECT edge_type, provenance FROM entity_edges
          WHERE from_type='learning' AND to_type='learning'`,
      )
      .get() as { edge_type: string; provenance: string };
    expect(edge).toMatchObject({ edge_type: 'related_to', provenance: 'inferred' });
  });
});
