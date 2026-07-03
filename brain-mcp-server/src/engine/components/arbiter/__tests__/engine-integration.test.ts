/**
 * Arbiter engine-integration test (FR-116 M2 — the co-scheduled run path).
 *
 * Drives `runJanitor` with an `arbiterConfig` (Decision #4A) and a MOCKED backend
 * — no real CLI. Proves:
 *   - the runner CO-DRIVES the arbiter alongside the near-dupe extractor and
 *     aggregates BOTH counters into ONE `brain_maintenance_runs` audit row
 *     (merges_proposed + contradictions_proposed both non-zero, single row);
 *   - the arbiter QUEUES a resolve_contradiction suggestion (review-gated default);
 *   - the auto_resolve fork applies the resolution DIRECTLY (supersedes, no
 *     suggestion), counting contradictions_resolved;
 *   - the single cognition.janitor.enabled gate turns the arbiter OFF too;
 *   - event-bus integrity: one terminal lifecycle event under cognition.arbiter.*.
 *
 * @module engine/components/arbiter/__tests__/engine-integration.test
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { runJanitor } from '../../janitor/runner.js';
import { DEFAULT_JANITOR_CONFIG, type JanitorConfig } from '../../janitor/types.js';
import { DEFAULT_ARBITER_CONFIG, type ArbiterConfig } from '../types.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { edgeMigrations } from '../../edges/schema.js';
import { janitorMigrations } from '../../janitor/schema.js';
import { insertEmbeddingInto } from '../../../../utils/vector-search.js';
import type { ResolvedBackend } from '../../cognition/types.js';
import type { BackendRunResult } from '../../cognition/backend/index.js';
import { getDb } from '../../../../db.js';

vi.mock('../../../../db.js', () => ({ getDb: vi.fn() }));

function vecBinaryAvailable(): boolean {
  try {
    const requireCjs = createRequire(import.meta.url);
    const sqliteVec = requireCjs('sqlite-vec') as { getLoadablePath?: () => string };
    if (typeof sqliteVec.getLoadablePath === 'function') {
      const p = sqliteVec.getLoadablePath();
      return typeof p === 'string' && p.length > 0;
    }
    return true;
  } catch {
    return false;
  }
}
const HAS_VEC = vecBinaryAvailable();

function loadVec(db: Database.Database): void {
  const requireCjs = createRequire(import.meta.url);
  const sqliteVec = requireCjs('sqlite-vec') as { load: (db: Database.Database) => void };
  sqliteVec.load(db);
}

function unit(dim: number): Float32Array {
  const arr = new Float32Array(384);
  arr[dim] = 1;
  return arr;
}
function angleVec(): Float32Array {
  const arr = new Float32Array(384);
  arr[0] = 0.92;
  arr[1] = Math.sqrt(1 - 0.92 * 0.92);
  return arr;
}
/** cache → unit(2), backoff → angleVec (0.92 to unit0), else → unit(0). */
async function embedMix(text: string): Promise<Float32Array> {
  if (text.includes('cache')) return unit(2);
  if (text.includes('backoff')) return angleVec();
  return unit(0);
}

function makeBrain(): Database.Database {
  const db = new Database(':memory:');
  loadVec(db);
  db.exec(`CREATE VIRTUAL TABLE learnings_vec USING vec0(embedding float[384]);`);
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
  for (const m of janitorMigrations) db.exec(m.sql);
  // Opposition pair (1,2) at cosine 0.92, negation-XOR, low overlap (janitor rejects).
  // Near-dupe pair (3,4) at cosine 1.0, high overlap (janitor accepts; arbiter ceiling rejects).
  db.prepare(
    `INSERT INTO learnings (id, title, content, created_at) VALUES
       (1,'Retry','use retry policy', datetime('now','-10 days')),
       (2,'Retry','never use retry backoff it is wrong', datetime('now')),
       (3,'Cache','cache ttl policy', datetime('now')),
       (4,'Cache','cache ttl policy setting', datetime('now'))`,
  ).run();
  insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
  insertEmbeddingInto(db, 'learnings_vec', 2, angleVec());
  insertEmbeddingInto(db, 'learnings_vec', 3, unit(2));
  insertEmbeddingInto(db, 'learnings_vec', 4, unit(2));
  return db;
}

const JAN: JanitorConfig = { ...DEFAULT_JANITOR_CONFIG, enabled: true, min_input_bytes: 0 };
const ARB: ArbiterConfig = { ...DEFAULT_ARBITER_CONFIG, enabled: true, min_input_bytes: 0 };

// A response valid for BOTH validators: the (3,4) merge is kept by the janitor
// (dropped by the arbiter cite-check); the (1,2) newer_wins is kept by the
// arbiter (dropped by the janitor verdict allow-list).
const CANNED = JSON.stringify([
  { from_id: 3, to_id: 4, verdict: 'keep_a', confidence: 0.8, justification: 'dup' },
  { from_id: 1, to_id: 2, verdict: 'newer_wins', winner_id: 2, loser_id: 1, confidence: 0.8, justification: 'newer' },
]);

function deps(text: string) {
  const backend: ResolvedBackend = { harness: 'claude', fallback_order: ['claude'] };
  return {
    resolveBackend: () => backend,
    runBackend: async (): Promise<BackendRunResult> => ({ ok: true, text }),
    isColdStart: () => false,
  };
}

describe('runJanitor + arbiter (FR-116 M2 — mocked backend, vec-gated)', () => {
  let db: Database.Database;
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it.skipIf(!HAS_VEC)('aggregates near-dupe + contradiction counters into ONE audit row', async () => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const result = await runJanitor(db, 'all', {
      config: JAN,
      arbiterConfig: ARB,
      embed: embedMix,
      deps: deps(CANNED),
    });

    expect(result.merges_proposed).toBe(1);
    expect(result.contradictions_proposed).toBe(1);
    expect(result.contradictions_resolved).toBe(0);
    expect(result.arbiter_outcome).toBe('succeeded');

    // Exactly ONE brain_maintenance_runs row carrying BOTH counters.
    const rows = db
      .prepare(`SELECT merges_proposed, contradictions_proposed, contradictions_resolved FROM brain_maintenance_runs`)
      .all() as Array<{ merges_proposed: number; contradictions_proposed: number; contradictions_resolved: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ merges_proposed: 1, contradictions_proposed: 1, contradictions_resolved: 0 });

    // The arbiter queued a resolve_contradiction suggestion (review-gated).
    const sugg = db
      .prepare(`SELECT status, suggested_action FROM suggestions WHERE source_module='arbiter'`)
      .get() as { status: string; suggested_action: string };
    expect(sugg.status).toBe('pending');
    expect(JSON.parse(sugg.suggested_action)).toMatchObject({
      kind: 'resolve_contradiction',
      resolution: 'newer_wins',
      winner_id: 2,
      loser_id: 1,
    });

    // Nothing superseded yet (review-gated default).
    const loser = db.prepare(`SELECT review_status FROM learnings WHERE id=1`).get() as { review_status: string };
    expect(loser.review_status).toBe('approved');

    // Exactly one terminal lifecycle event under cognition.arbiter.*.
    const names = (db.prepare(`SELECT event_name FROM event_log ORDER BY id`).all() as { event_name: string }[]).map(
      (r) => r.event_name,
    );
    expect(names).toContain('cognition.arbiter.run_started');
    expect(names.filter((n) => /^cognition\.arbiter\.run_(succeeded|failed|skipped)$/.test(n))).toHaveLength(1);
  });

  it.skipIf(!HAS_VEC)('auto_resolve fork supersedes directly, no arbiter suggestion', async () => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const result = await runJanitor(db, 'all', {
      config: JAN,
      arbiterConfig: { ...ARB, auto_resolve: true, auto_resolve_threshold: 0.9 },
      embed: embedMix,
      deps: deps(CANNED),
    });

    expect(result.contradictions_resolved).toBe(1);
    expect(result.contradictions_proposed).toBe(0);

    // No arbiter suggestion queued; the loser is superseded directly.
    const n = db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE source_module='arbiter'`).get() as { n: number };
    expect(n.n).toBe(0);
    const loser = db.prepare(`SELECT review_status, superseded_by FROM learnings WHERE id=1`).get() as {
      review_status: string;
      superseded_by: number | null;
    };
    expect(loser.review_status).toBe('superseded');
    expect(loser.superseded_by).toBe(2);
  });

  it.skipIf(!HAS_VEC)('the single cognition.janitor.enabled gate turns the arbiter OFF too', async () => {
    vi.clearAllMocks();
    db = makeBrain();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);

    const result = await runJanitor(db, 'all', {
      config: { ...JAN, enabled: false },
      arbiterConfig: { ...ARB, enabled: false }, // derived from janitor.enabled in production
      embed: embedMix,
      deps: deps(CANNED),
    });

    expect(result.contradictions_proposed).toBe(0);
    expect(result.contradictions_resolved).toBe(0);
    expect(result.arbiter_outcome).toBe('skipped');
    const n = db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE source_module='arbiter'`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});
