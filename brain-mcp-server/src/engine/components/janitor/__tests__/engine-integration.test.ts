/**
 * Janitor engine-integration test (FR-119 — the headline run path).
 *
 * Drives `runJanitor` (deterministic sweep + near-dupe LLM extractor) with a
 * MOCKED backend — no real CLI. Proves:
 *   - config gate off-by-default: disabled → run_skipped(disabled) AND the
 *     deterministic sweep is GATED (no confidence bump), maintenance row skipped;
 *   - the deterministic sweep runs when enabled (confidence bump + stale reject
 *     recorded on the brain_maintenance_runs audit row) even without vec;
 *   - one brain_maintenance_runs row per invocation with the aggregated counters;
 *   - (vec-gated) a near-dupe merge is QUEUED as a janitor suggestion, and the
 *     lifecycle writes exactly one terminal event under cognition.janitor.*;
 *   - (vec-gated) the auto_merge fork merges directly, no suggestion row.
 *
 * @module engine/components/janitor/__tests__/engine-integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { runJanitor } from '../runner.js';
import { DEFAULT_JANITOR_CONFIG, type JanitorConfig } from '../types.js';
import { subconsciousMigrations } from '../../subconscious/schema.js';
import { edgeMigrations } from '../../edges/schema.js';
import { janitorMigrations } from '../schema.js';
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
async function fakeEmbed(text: string): Promise<Float32Array> {
  return text.includes('alpha') ? unit(0) : unit(1);
}

function makeBrain(withVec: boolean): Database.Database {
  const db = new Database(':memory:');
  if (withVec) {
    loadVec(db);
    db.exec(`CREATE VIRTUAL TABLE learnings_vec USING vec0(embedding float[384]);`);
  }
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
  return db;
}

const RUNNABLE: JanitorConfig = { ...DEFAULT_JANITOR_CONFIG, enabled: true, min_input_bytes: 0 };

function deps(text: string) {
  const backend: ResolvedBackend = { harness: 'claude', fallback_order: ['claude'] };
  return {
    resolveBackend: () => backend,
    runBackend: async (): Promise<BackendRunResult> => ({ ok: true, text }),
    isColdStart: () => false,
  };
}

function latestRun(db: Database.Database): {
  status: string;
  confidence_bumps: number;
  stale_rejected: number;
  merges_proposed: number;
  merges_applied: number;
} {
  return db
    .prepare(
      `SELECT status, confidence_bumps, stale_rejected, merges_proposed, merges_applied
         FROM brain_maintenance_runs ORDER BY id DESC LIMIT 1`,
    )
    .get() as ReturnType<typeof latestRun>;
}

describe('runJanitor (FR-119 — mocked backend)', () => {
  let db: Database.Database;
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('disabled → skipped, deterministic sweep GATED (no confidence bump)', async () => {
    vi.clearAllMocks();
    db = makeBrain(false);
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    db.prepare(`INSERT INTO learnings (id, title, content, confidence) VALUES (1, 't', 'c', 0.80)`).run();
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO event_log (event_name, component, payload)
         VALUES ('perception.rediscovery','perception', ?)`,
      ).run(JSON.stringify({ existing_learning_id: 1 }));
    }

    const result = await runJanitor(db, 'all', {
      config: { ...DEFAULT_JANITOR_CONFIG, enabled: false },
      deps: deps('[]'),
    });
    expect(result.outcome).toBe('skipped');
    expect(result.confidence_bumps).toBe(0);
    const conf = db.prepare(`SELECT confidence FROM learnings WHERE id=1`).get() as { confidence: number };
    expect(conf.confidence).toBeCloseTo(0.80, 5);
    expect(latestRun(db).status).toBe('skipped');
  });

  it('enabled: runs the deterministic sweep + writes the maintenance audit row', async () => {
    vi.clearAllMocks();
    db = makeBrain(false); // no vec → extractor skips gate_bytes, but the sweep runs
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    db.prepare(`INSERT INTO learnings (id, title, content, confidence) VALUES (1, 't', 'c', 0.80)`).run();
    db.prepare(
      `INSERT INTO learnings (id, title, content, review_status, created_at)
       VALUES (2, 't2', 'c2', 'pending_review', datetime('now','-20 days'))`,
    ).run();
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO event_log (event_name, component, payload)
         VALUES ('perception.rediscovery','perception', ?)`,
      ).run(JSON.stringify({ existing_learning_id: 1 }));
    }

    const result = await runJanitor(db, 'all', { config: RUNNABLE, deps: deps('[]') });
    expect(result.confidence_bumps).toBe(1);
    expect(result.stale_rejected).toBe(1);
    const row = latestRun(db);
    expect(row.confidence_bumps).toBe(1);
    expect(row.stale_rejected).toBe(1);
    // Exactly one maintenance row for this single invocation.
    const n = db.prepare(`SELECT COUNT(*) AS n FROM brain_maintenance_runs`).get() as { n: number };
    expect(n.n).toBe(1);
  });

  it.skipIf(!HAS_VEC)('queues a near-dupe merge as a janitor suggestion + one terminal event', async () => {
    vi.clearAllMocks();
    db = makeBrain(true);
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    db.prepare(
      `INSERT INTO learnings (id, title, content) VALUES (1,'A','alpha rule'),(2,'B','alpha rule again')`,
    ).run();
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, unit(0));

    const canned = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'keep_a', confidence: 0.8, justification: 'same rule' },
    ]);
    const result = await runJanitor(db, 'all', { config: RUNNABLE, embed: fakeEmbed, deps: deps(canned) });
    expect(result.outcome).toBe('succeeded');
    expect(result.merges_proposed).toBe(1);
    expect(result.merges_applied).toBe(0);

    const sugg = db
      .prepare(`SELECT source_module, status, suggested_action FROM suggestions WHERE source_module='janitor'`)
      .get() as { source_module: string; status: string; suggested_action: string };
    expect(sugg.status).toBe('pending');
    const action = JSON.parse(sugg.suggested_action) as Record<string, unknown>;
    expect(action).toMatchObject({ kind: 'merge_learnings', survivor_id: 1, duplicate_id: 2 });

    // No merge applied yet (review-gated default).
    const dup = db.prepare(`SELECT review_status FROM learnings WHERE id=2`).get() as { review_status: string };
    expect(dup.review_status).toBe('approved');

    // Exactly one terminal lifecycle event under cognition.janitor.*.
    const names = (db.prepare(`SELECT event_name FROM event_log ORDER BY id`).all() as { event_name: string }[]).map(
      (r) => r.event_name,
    );
    expect(names).toContain('cognition.janitor.run_started');
    expect(names).toContain('cognition.janitor.run_succeeded');
    expect(names.filter((n) => /run_(succeeded|failed|skipped)$/.test(n))).toHaveLength(1);
  });

  it.skipIf(!HAS_VEC)('auto_merge fork applies the merge directly, no suggestion row', async () => {
    vi.clearAllMocks();
    db = makeBrain(true);
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    db.prepare(
      `INSERT INTO learnings (id, title, content, seen_again_count) VALUES (1,'A','alpha rule',0),(2,'B','alpha rule again',0)`,
    ).run();
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, unit(0));

    const canned = JSON.stringify([
      { from_id: 1, to_id: 2, verdict: 'keep_a', confidence: 0.8, justification: 'same rule' },
    ]);
    const result = await runJanitor(db, 'all', {
      config: { ...RUNNABLE, auto_merge: true, auto_merge_threshold: 0.9 },
      embed: fakeEmbed,
      deps: deps(canned),
    });
    expect(result.outcome).toBe('succeeded');
    expect(result.merges_applied).toBe(1);
    expect(result.merges_proposed).toBe(0);

    // No suggestion queued; the duplicate is merged directly.
    const n = db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE source_module='janitor'`).get() as {
      n: number;
    };
    expect(n.n).toBe(0);
    const dup = db.prepare(`SELECT review_status, merged_into FROM learnings WHERE id=2`).get() as {
      review_status: string;
      merged_into: number | null;
    };
    expect(dup.review_status).toBe('merged');
    expect(dup.merged_into).toBe(1);
  });

  it.skipIf(!HAS_VEC)('the backend seam receives only the prompt (never the DB) — brain isolation', async () => {
    vi.clearAllMocks();
    db = makeBrain(true);
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    db.prepare(
      `INSERT INTO learnings (id, title, content) VALUES (1,'MVVM+GetX','alpha rule'),(2,'B','alpha rule again')`,
    ).run();
    insertEmbeddingInto(db, 'learnings_vec', 1, unit(0));
    insertEmbeddingInto(db, 'learnings_vec', 2, unit(0));

    let capturedUser = '';
    await runJanitor(db, 'all', {
      config: RUNNABLE,
      embed: fakeEmbed,
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
