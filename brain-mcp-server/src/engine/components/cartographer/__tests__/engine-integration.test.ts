/**
 * Cartographer engine-integration test (FR-116 M4 — the co-scheduled run path).
 *
 * Drives `runJanitor` with a `cartographerConfig` (Decision #4A) and a MOCKED
 * backend — no real CLI. Proves:
 *   - the runner CO-DRIVES the cartographer alongside the near-dupe extractor and
 *     aggregates its counters (clusters_detected / meta_learnings_created) into ONE
 *     `brain_maintenance_runs` audit row;
 *   - the cartographer QUEUES cluster_meta suggestions (review-gated default);
 *   - the auto_fork fork CREATES meta-learnings directly (+ cluster_member_of
 *     edges, undo-logged with the run id), counting meta_learnings_created;
 *   - the cadence throttle SKIPS the expensive pass when a recent successful run
 *     exists;
 *   - the double gate (janitor.enabled AND cluster.enabled) turns it OFF.
 *
 * The near-dupe extractor skips on its bytes gate (no vec → empty digest,
 * min_input_bytes high) so it does not interfere with the cartographer assertions.
 *
 * @module engine/components/cartographer/__tests__/engine-integration.test
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runJanitor } from '../../janitor/runner.js';
import { DEFAULT_JANITOR_CONFIG, type JanitorConfig } from '../../janitor/types.js';
import { DEFAULT_CARTOGRAPHER_CONFIG, type CartographerConfig } from '../types.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { edgeMigrations } from '../../edges/schema.js';
import { janitorMigrations } from '../../janitor/schema.js';
import type { ResolvedBackend } from '../../cognition/types.js';
import type { BackendRunResult } from '../../cognition/backend/index.js';
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
  // Six approved learnings forming two triangles.
  const ins = db.prepare(`INSERT INTO learnings (id, title, content) VALUES (?, ?, ?)`);
  for (let i = 1; i <= 6; i++) ins.run(i, `L${i}`, `content ${i}`);
  const link = (a: string, b: string): void => {
    db.prepare(
      `INSERT OR IGNORE INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
       VALUES ('learning', ?, 'learning', ?, 'related_to')`,
    ).run(a, b);
  };
  for (const [a, b] of [['1', '2'], ['2', '3'], ['1', '3'], ['4', '5'], ['5', '6'], ['4', '6']]) {
    link(a, b);
  }
  return db;
}

// Near-dupe skips (bytes gate); cartographer runs (min 0, cadence off).
const JAN: JanitorConfig = { ...DEFAULT_JANITOR_CONFIG, enabled: true, min_input_bytes: 100_000 };
const CART: CartographerConfig = {
  ...DEFAULT_CARTOGRAPHER_CONFIG,
  enabled: true,
  min_input_bytes: 0,
  cadence_days: 0,
  min_cluster_size: 3,
};

// Canned cartographer response: summarize both clusters.
const CANNED = JSON.stringify([
  { cluster_index: 0, title: 'Theme A', summary: 'the shared idea of cluster A', confidence: 0.8 },
  { cluster_index: 1, title: 'Theme B', summary: 'the shared idea of cluster B', confidence: 0.8 },
]);

function deps(text: string) {
  const backend: ResolvedBackend = { harness: 'claude', fallback_order: ['claude'] };
  return {
    resolveBackend: () => backend,
    runBackend: async (): Promise<BackendRunResult> => ({ ok: true, text }),
    isColdStart: () => false,
  };
}

describe('runJanitor + cartographer (FR-116 M4 — mocked backend)', () => {
  let db: Database.Database;
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('review-gated: queues cluster_meta suggestions into ONE audit row, nothing created', async () => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const result = await runJanitor(db, 'all', { config: JAN, cartographerConfig: CART, deps: deps(CANNED) });

    expect(result.clusters_detected).toBe(2);
    expect(result.meta_learnings_created).toBe(0);
    expect(result.cartographer_outcome).toBe('succeeded');

    const rows = db
      .prepare(`SELECT clusters_detected, meta_learnings_created FROM brain_maintenance_runs`)
      .all() as Array<{ clusters_detected: number; meta_learnings_created: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clusters_detected: 2, meta_learnings_created: 0 });

    const sugg = db
      .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE source_module='cartographer' AND status='pending'`)
      .get() as { n: number };
    expect(sugg.n).toBe(2);
    // No new learnings (still 6 originals).
    expect((db.prepare(`SELECT COUNT(*) AS n FROM learnings`).get() as { n: number }).n).toBe(6);
  });

  it('auto_fork creates meta-learnings directly + wires edges + logs undo with the run id', async () => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const result = await runJanitor(db, 'all', {
      config: JAN,
      cartographerConfig: { ...CART, auto_fork: true },
      deps: deps(CANNED),
    });

    expect(result.meta_learnings_created).toBe(2);
    // Two meta-learnings created (6 → 8).
    expect((db.prepare(`SELECT COUNT(*) AS n FROM learnings`).get() as { n: number }).n).toBe(8);
    // Six cluster_member_of edges (3 per cluster).
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM entity_edges WHERE edge_type='cluster_member_of'`).get() as { n: number }).n,
    ).toBe(6);
    // Undo entries carry the run id (undo-by-run reverses the whole run).
    const undo = db
      .prepare(`SELECT DISTINCT run_id FROM brain_maintenance_undo WHERE action_kind='cluster_meta'`)
      .all() as Array<{ run_id: string | null }>;
    expect(undo).toHaveLength(1);
    expect(undo[0].run_id).toBe(result.run_id);
  });

  it('the cadence throttle SKIPS the expensive pass when a recent run succeeded', async () => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    // Seed a recent successful cartographer run.
    db.prepare(
      `INSERT INTO event_log (event_name, component, created_at)
       VALUES ('cognition.cartographer.run_succeeded','cognition.cartographer', datetime('now','-1 day'))`,
    ).run();

    const result = await runJanitor(db, 'all', {
      config: JAN,
      cartographerConfig: { ...CART, cadence_days: 7 }, // 1-day-old run < 7d → throttled
      deps: deps(CANNED),
    });

    expect(result.cartographer_outcome).toBe('skipped');
    expect(result.clusters_detected).toBe(0);
    const sugg = db
      .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE source_module='cartographer'`)
      .get() as { n: number };
    expect(sugg.n).toBe(0);
  });

  it('the double gate turns the cartographer OFF (enabled=false)', async () => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const result = await runJanitor(db, 'all', {
      config: { ...JAN, enabled: false },
      cartographerConfig: { ...CART, enabled: false },
      deps: deps(CANNED),
    });

    expect(result.clusters_detected).toBe(0);
    expect(result.meta_learnings_created).toBe(0);
    expect(result.cartographer_outcome).toBe('skipped');
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE source_module='cartographer'`)
      .get() as { n: number };
    expect(n.n).toBe(0);
  });
});
