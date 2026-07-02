/**
 * Synapse engine-integration test (FR-211 — the headline run path).
 *
 * Drives `runSynapse` through the agnostic cognition engine with a MOCKED
 * backend (canned JSON) — no real CLI. Proves:
 *   - INSERT shape: source_module='edge_inference', suggested_action.kind='add_edge',
 *     type_inferred=1, status='pending', confidence carried;
 *   - lifecycle events under the per-instance `cognition.synapse.*` namespace;
 *   - config gate off-by-default (disabled → run_skipped);
 *   - empty candidate set → gate_bytes skip (the cost gate);
 *   - cli_missing / parse_error terminal outcomes;
 *   - input isolation: the backend seam receives only the prompt (never the DB),
 *     and the user prompt carries the candidate digest and nothing more.
 *
 * @module engine/components/synapse/__tests__/engine-integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runSynapse } from '../runner.js';
import { DEFAULT_SYNAPSE_CONFIG, type SynapseConfig } from '../types.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { edgeMigrations } from '../../edges/schema.js';
import type { ResolvedBackend } from '../../cognition/types.js';
import type { BackendRunResult } from '../../cognition/backend/index.js';

interface SuggestionRow {
  source_module: string;
  status: string;
  confidence: number | null;
  suggested_action: string | null;
  type_inferred: number;
  title: string;
}

function makeBrain(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      component TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      machine_hostname TEXT,
      project_slug TEXT,
      instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL DEFAULT 'p',
      category TEXT NOT NULL DEFAULT 'pattern',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_brief TEXT DEFAULT '',
      embedding BLOB
    );
  `);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  for (const m of edgeMigrations) db.exec(m.sql);
  return db;
}

function seedSharedBriefPair(db: Database.Database): void {
  db.prepare(
    `INSERT INTO learnings (id, project, category, title, content, source_brief)
     VALUES (1,'p','pattern','MVVM+GetX','use getx bindings','BR-1'),
            (2,'p','pattern','GetX bindings','bind controllers in route','BR-1')`,
  ).run();
}

const RUNNABLE: SynapseConfig = { ...DEFAULT_SYNAPSE_CONFIG, enabled: true, min_input_bytes: 0 };

function deps(responseText: string) {
  const backend: ResolvedBackend = { harness: 'claude', fallback_order: ['claude'] };
  return {
    resolveBackend: () => backend,
    runBackend: async (): Promise<BackendRunResult> => ({ ok: true, text: responseText }),
    isColdStart: () => false,
  };
}

function eventNames(db: Database.Database): string[] {
  return (db.prepare(`SELECT event_name FROM event_log ORDER BY id`).all() as { event_name: string }[]).map(
    (r) => r.event_name,
  );
}
function components(db: Database.Database): string[] {
  return [
    ...new Set(
      (db.prepare(`SELECT component FROM event_log`).all() as { component: string }[]).map((r) => r.component),
    ),
  ];
}

describe('runSynapse (FR-211 — mocked backend)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeBrain();
  });
  afterEach(() => db.close());

  it('queues a valid proposal as an edge_inference suggestion', async () => {
    seedSharedBriefPair(db);
    const canned = JSON.stringify([
      { from_id: 1, to_id: 2, edge_type: 'related_to', confidence: 0.7, justification: 'same GetX topic' },
    ]);
    const result = await runSynapse(db, 'all', { config: RUNNABLE, deps: deps(canned) });

    expect(result.outcome).toBe('succeeded');
    expect(result.persisted).toBe(1);

    const row = db.prepare(`SELECT * FROM suggestions`).get() as SuggestionRow;
    expect(row.source_module).toBe('edge_inference');
    expect(row.type_inferred).toBe(1);
    expect(row.status).toBe('pending');
    expect(row.confidence).toBe(0.7);
    const action = JSON.parse(row.suggested_action!) as Record<string, unknown>;
    expect(action).toMatchObject({
      kind: 'add_edge',
      from: { type: 'learning', id: '1' },
      to: { type: 'learning', id: '2' },
      edge_type: 'related_to',
      justification: 'same GetX topic',
    });
    // No edge written yet — proposal is review-gated (default auto_approve=false).
    const edges = db.prepare(`SELECT COUNT(*) AS n FROM entity_edges`).get() as { n: number };
    expect(edges.n).toBe(0);
  });

  it('writes exactly one terminal lifecycle event under cognition.synapse.*', async () => {
    seedSharedBriefPair(db);
    const canned = JSON.stringify([{ from_id: 1, to_id: 2, edge_type: 'related_to', confidence: 0.5 }]);
    await runSynapse(db, 'all', { config: RUNNABLE, deps: deps(canned) });

    const names = eventNames(db);
    expect(names).toContain('cognition.synapse.run_started');
    expect(names).toContain('cognition.synapse.run_succeeded');
    expect(names.filter((n) => /run_(succeeded|failed|skipped)$/.test(n))).toHaveLength(1);
    expect(components(db)).toEqual(['cognition.synapse']);
  });

  it('config gate off-by-default: disabled → run_skipped(disabled), zero rows', async () => {
    seedSharedBriefPair(db);
    const result = await runSynapse(db, 'all', {
      config: { ...RUNNABLE, enabled: false },
      deps: deps('[]'),
    });
    expect(result.outcome).toBe('skipped');
    expect(result.skip_reason).toBe('disabled');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM suggestions`).get() as { n: number }).n).toBe(0);
  });

  it('empty candidate set → gate_bytes skip (cost gate), zero rows', async () => {
    // No learnings → no pairs → tiny digest below the 100-byte floor.
    const result = await runSynapse(db, 'all', {
      config: { ...DEFAULT_SYNAPSE_CONFIG, enabled: true }, // min_input_bytes=100
      deps: deps('[]'),
    });
    expect(result.outcome).toBe('skipped');
    expect(result.skip_reason).toBe('gate_bytes');
  });

  it('cli_missing (no harness) → run_skipped(cli_missing)', async () => {
    seedSharedBriefPair(db);
    const result = await runSynapse(db, 'all', {
      config: RUNNABLE,
      deps: {
        resolveBackend: () => ({ harness: null, fallback_order: ['claude'] }),
        isColdStart: () => false,
      },
    });
    expect(result.outcome).toBe('skipped');
    expect(result.skip_reason).toBe('cli_missing');
  });

  it('malformed JSON → run_failed reason=parse_error, zero rows', async () => {
    seedSharedBriefPair(db);
    const result = await runSynapse(db, 'all', { config: RUNNABLE, deps: deps('not json') });
    expect(result.outcome).toBe('failed');
    expect(result.fail_reason).toBe('parse_error');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM suggestions`).get() as { n: number }).n).toBe(0);
  });

  it('the backend seam receives only the prompt (never the DB) — brain isolation', async () => {
    seedSharedBriefPair(db);
    let capturedUser = '';
    await runSynapse(db, 'all', {
      config: RUNNABLE,
      deps: {
        resolveBackend: () => ({ harness: 'claude', fallback_order: ['claude'] }),
        isColdStart: () => false,
        runBackend: async (_h, prompt): Promise<BackendRunResult> => {
          capturedUser = prompt.user;
          return { ok: true, text: '[]' };
        },
      },
    });
    expect(capturedUser).toContain('<pairs>');
    expect(capturedUser).toContain('MVVM+GetX'); // the seeded learning title is in the digest
  });
});
