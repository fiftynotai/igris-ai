/**
 * Curator engine-integration test (FR-116 M3 — the co-scheduled run path).
 *
 * Drives `runJanitor` with a `curatorConfig` (Decision #4A) and a MOCKED backend
 * — no real CLI, no vec. Proves:
 *   - the runner CO-DRIVES the curator alongside the near-dupe extractor and
 *     aggregates its counters into ONE `brain_maintenance_runs` audit row;
 *   - the curator QUEUES prune_learning suggestions (review-gated default);
 *   - the auto_prune fork applies prunes DIRECTLY (soft-delete, undo-logged with
 *     the run id), counting outdated_pruned;
 *   - the anomaly safety valve caps auto-prune at the threshold + surfaces a
 *     warning (Section F);
 *   - the single cognition.janitor.enabled gate turns the curator OFF too.
 *
 * The near-dupe extractor is skipped on its bytes gate (no vec → empty digest,
 * min_input_bytes high) so it does not interfere with the curator assertions.
 *
 * @module engine/components/curator/__tests__/engine-integration.test
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runJanitor } from '../../janitor/runner.js';
import { DEFAULT_JANITOR_CONFIG, type JanitorConfig } from '../../janitor/types.js';
import { DEFAULT_CURATOR_CONFIG, type CuratorConfig } from '../types.js';
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
      access_count INTEGER DEFAULT 0,
      seen_again_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      tags TEXT,
      tech_stack TEXT,
      embedding BLOB,
      embedding_model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  for (const m of edgeMigrations) db.exec(m.sql);
  for (const m of janitorMigrations) db.exec(m.sql);
  // Three stale (old + never-accessed) approved learnings.
  db.prepare(
    `INSERT INTO learnings (id, title, content, access_count, created_at) VALUES
      (1,'Old A','uses a deprecated API', 0, datetime('now','-9 months')),
      (2,'Old B','an obsolete workaround', 0, datetime('now','-8 months')),
      (3,'Old C','a reversed decision',    0, datetime('now','-7 months'))`,
  ).run();
  return db;
}

// Near-dupe skips (bytes gate: no vec → empty digest); curator runs (min 0).
const JAN: JanitorConfig = { ...DEFAULT_JANITOR_CONFIG, enabled: true, min_input_bytes: 100_000 };
const CUR: CuratorConfig = { ...DEFAULT_CURATOR_CONFIG, enabled: true, min_input_bytes: 0 };

// Canned curator response: prune all three candidates.
const CANNED = JSON.stringify([
  { learning_id: 1, verdict: 'prune', confidence: 0.8, justification: 'deprecated' },
  { learning_id: 2, verdict: 'prune', confidence: 0.8, justification: 'obsolete' },
  { learning_id: 3, verdict: 'prune', confidence: 0.8, justification: 'reversed' },
]);

function deps(text: string) {
  const backend: ResolvedBackend = { harness: 'claude', fallback_order: ['claude'] };
  return {
    resolveBackend: () => backend,
    runBackend: async (): Promise<BackendRunResult> => ({ ok: true, text }),
    isColdStart: () => false,
  };
}

describe('runJanitor + curator (FR-116 M3 — mocked backend)', () => {
  let db: Database.Database;
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('review-gated: queues prune suggestions into ONE audit row, nothing pruned', async () => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const result = await runJanitor(db, 'all', { config: JAN, curatorConfig: CUR, deps: deps(CANNED) });

    expect(result.outdated_proposed).toBe(3);
    expect(result.outdated_pruned).toBe(0);
    expect(result.curator_outcome).toBe('succeeded');
    expect(result.prune_anomaly).toBe(false);

    // Exactly ONE audit row carrying the curator counters.
    const rows = db
      .prepare(`SELECT outdated_proposed, outdated_pruned FROM brain_maintenance_runs`)
      .all() as Array<{ outdated_proposed: number; outdated_pruned: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outdated_proposed: 3, outdated_pruned: 0 });

    // Three curator suggestions queued; nothing pruned yet (review-gated).
    const sugg = db
      .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE source_module='curator' AND status='pending'`)
      .get() as { n: number };
    expect(sugg.n).toBe(3);
    const approved = db
      .prepare(`SELECT COUNT(*) AS n FROM learnings WHERE review_status='approved'`)
      .get() as { n: number };
    expect(approved.n).toBe(3);
  });

  it('auto_prune fork prunes directly (soft-delete) + logs undo entries with the run id', async () => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const result = await runJanitor(db, 'all', {
      config: JAN,
      curatorConfig: { ...CUR, auto_prune: true, anomaly_threshold: 50 },
      deps: deps(CANNED),
    });

    expect(result.outdated_pruned).toBe(3);
    expect(result.outdated_proposed).toBe(0);
    // All three soft-deleted (pruned), none recallable.
    const pruned = db
      .prepare(`SELECT COUNT(*) AS n FROM learnings WHERE review_status='pruned'`)
      .get() as { n: number };
    expect(pruned.n).toBe(3);
    // Undo entries carry the run id (undo-by-run reverses the whole run).
    const undo = db
      .prepare(`SELECT DISTINCT run_id FROM brain_maintenance_undo WHERE action_kind='prune_learning'`)
      .all() as Array<{ run_id: string | null }>;
    expect(undo).toHaveLength(1);
    expect(undo[0].run_id).toBe(result.run_id);
  });

  it('anomaly safety valve caps auto-prune at the threshold + surfaces a warning', async () => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const result = await runJanitor(db, 'all', {
      config: JAN,
      curatorConfig: { ...CUR, auto_prune: true, anomaly_threshold: 2 },
      deps: deps(CANNED),
    });

    expect(result.prune_anomaly).toBe(true);
    expect(result.warning).toMatch(/ANOMALY/);
    // Only 2 auto-applied; the 3rd fell back to review.
    expect(result.outdated_pruned).toBe(2);
    expect(result.outdated_proposed).toBe(1);
  });

  it('the single cognition.janitor.enabled gate turns the curator OFF too', async () => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const result = await runJanitor(db, 'all', {
      config: { ...JAN, enabled: false },
      curatorConfig: { ...CUR, enabled: false }, // derived from janitor.enabled in production
      deps: deps(CANNED),
    });

    expect(result.outdated_proposed).toBe(0);
    expect(result.outdated_pruned).toBe(0);
    expect(result.curator_outcome).toBe('skipped');
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE source_module='curator'`)
      .get() as { n: number };
    expect(n.n).toBe(0);
  });
});
