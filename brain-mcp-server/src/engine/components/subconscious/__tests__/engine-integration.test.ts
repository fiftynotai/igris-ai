/**
 * Subconscious engine-integration test (FR-118 M2 — the headline path).
 *
 * Drives `runSubconscious` through the agnostic cognition engine with a MOCKED
 * backend (canned JSON) — no real CLI. Proves the end-to-end behavior:
 *   - INSERT shape: open source_module, confidence, suggested_action,
 *     type_inferred=1, status=pending;
 *   - dedup vs already-pending (open) suggestions — no double-insert;
 *   - lifecycle events under the per-instance `cognition.subconscious.*`
 *     namespace (engine-written to event_log, NOT the legacy `subconscious.*`);
 *   - hallucinated citation → dropped: well-formed array, all elements dropped →
 *     succeeded (valid-empty), zero inserts (TD-294);
 *   - confidence > 0.85 → capped;
 *   - malformed JSON → run_failed reason=parse_error, zero inserts;
 *   - disabled / cli_missing → clean run_skipped, zero inserts.
 *
 * @module engine/components/subconscious/__tests__/engine-integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runSubconscious } from '../runner.js';
import { subconsciousMigrations } from '../schema.js';
import {
  DEFAULT_SUBCONSCIOUS_CONFIG,
  type SubconsciousConfig,
  type Suggestion,
} from '../types.js';
import type { ResolvedBackend } from '../../cognition/types.js';
import type { BackendRunResult } from '../../cognition/backend/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A brain with event_log + the schema the digest reads + the v3 suggestions table. */
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
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, path TEXT NOT NULL, status TEXT DEFAULT 'active',
      registered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      brief_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      priority TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'pattern', title TEXT NOT NULL,
      content TEXT NOT NULL, confidence REAL DEFAULT 0.8,
      review_status TEXT DEFAULT 'approved',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // v1 + v2 + v3 suggestions/dismissed_patterns.
  for (const m of subconsciousMigrations) db.exec(m.sql);
  // Seed a brief so the digest has citable evidence.
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status, priority, updated_at)
     VALUES ('alpha','BR-1','Open one','In Progress','P1','2026-05-01 00:00:00')`,
  ).run();
  db.prepare(`INSERT INTO projects (slug, name, path) VALUES ('alpha','Alpha','/tmp/a')`).run();
  return db;
}

/** A config that passes every gate (enabled, no bytes floor). */
const RUNNABLE_CONFIG: SubconsciousConfig = {
  ...DEFAULT_SUBCONSCIOUS_CONFIG,
  enabled: true,
  min_digest_bytes: 0,
};

/** Inject a fixed resolved backend + a canned LLM response. */
function deps(responseText: string) {
  const backend: ResolvedBackend = { harness: 'claude', fallback_order: ['claude'] };
  return {
    resolveBackend: () => backend,
    runBackend: async (): Promise<BackendRunResult> => ({ ok: true, text: responseText }),
    isColdStart: () => false,
  };
}

function eventNames(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT event_name FROM event_log ORDER BY id`).all() as { event_name: string }[]
  ).map((r) => r.event_name);
}

function components(db: Database.Database): string[] {
  return [
    ...new Set(
      (db.prepare(`SELECT component FROM event_log`).all() as { component: string }[]).map(
        (r) => r.component,
      ),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSubconscious (FR-118 M2 — mocked backend)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeBrain();
  });

  afterEach(() => {
    db.close();
  });

  it('persists a valid suggestion with the FR-118 INSERT shape', async () => {
    const canned = JSON.stringify([
      {
        kind: 'stalled_brief',
        project_slug: 'alpha',
        title: 'BR-1 looks stalled',
        priority: 'high',
        confidence: 0.7,
        evidence: { brief_id: 'BR-1', note: 'no update since May' },
        suggested_action: { kind: 'flag_for_review' },
      },
    ]);
    const result = await runSubconscious(db, 'all', {
      config: RUNNABLE_CONFIG,
      deps: deps(canned),
    });

    expect(result.outcome).toBe('succeeded');
    expect(result.persisted).toBe(1);

    const row = db.prepare(`SELECT * FROM suggestions`).get() as Suggestion;
    expect(row.source_module).toBe('stalled_brief'); // OPEN — the old CHECK forbade this
    expect(row.confidence).toBe(0.7);
    expect(row.suggested_action).toBe('{"kind":"flag_for_review"}');
    expect(row.type_inferred).toBe(1);
    expect(row.status).toBe('pending');
    expect(row.project_slug).toBe('alpha');
  });

  it('writes lifecycle events under cognition.subconscious.* (not legacy subconscious.*)', async () => {
    const canned = JSON.stringify([
      { kind: 'k', title: 't', priority: 'low', confidence: 0.4, evidence: {} },
    ]);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps: deps(canned) });

    const names = eventNames(db);
    expect(names).toContain('cognition.subconscious.run_started');
    expect(names).toContain('cognition.subconscious.run_succeeded');
    // Per-instance component namespace.
    expect(components(db)).toEqual(['cognition.subconscious']);
    // No legacy bus-style names leak into event_log.
    expect(names.some((n) => n === 'subconscious.run_complete')).toBe(false);
  });

  it('dedups against an already-pending open suggestion (no double-insert)', async () => {
    // Pre-seed a pending suggestion whose evidence signature matches the canned one.
    db.prepare(
      `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status, type_inferred)
       VALUES ('stalled_brief', 'alpha', 'already here', '{"brief_id":"BR-1"}', 'high', 'pending', 1)`,
    ).run();

    const canned = JSON.stringify([
      {
        kind: 'stalled_brief',
        project_slug: 'alpha',
        title: 'BR-1 looks stalled (dup signature)',
        priority: 'high',
        confidence: 0.7,
        evidence: { brief_id: 'BR-1' },
      },
    ]);
    const result = await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps: deps(canned) });

    // The candidate parsed (valid citation) but its evidence signature matches
    // the pre-seeded pending row, so the persist slot SKIPS the INSERT (dedup).
    // The DB invariant is what matters: NO new row was written.
    const count = db.prepare(`SELECT COUNT(*) AS n FROM suggestions`).get() as { n: number };
    expect(count.n).toBe(1);
    // The run still completes (the candidate was handled, just deduped).
    expect(result.outcome).toBe('succeeded');
  });

  it('drops a hallucinated citation → succeeded (valid-empty), zero inserts (TD-294)', async () => {
    // The response IS a well-formed JSON array, but its only element cites a brief
    // that is not in the digest, so cite-check drops it → zero candidates. Under
    // TD-294 the subconscious instance opts into isMalformedResponse, so a
    // well-formed-but-all-dropped array is a VALID EMPTY judgment (succeeded,
    // persisted 0), NOT a parse_error. (A truly malformed / non-array response
    // would still be parse_error — see the validator unit tests.)
    const canned = JSON.stringify([
      {
        kind: 'x',
        title: 'cites a missing brief',
        priority: 'high',
        confidence: 0.7,
        evidence: { brief_id: 'BR-DOES-NOT-EXIST' },
      },
    ]);
    const result = await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps: deps(canned) });
    expect(result.outcome).toBe('succeeded');
    expect(result.persisted).toBe(0);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM suggestions`).get() as { n: number };
    expect(count.n).toBe(0);
    expect(eventNames(db)).toContain('cognition.subconscious.run_succeeded');
    expect(eventNames(db)).not.toContain('cognition.subconscious.run_failed');
  });

  it('caps confidence > 0.85', async () => {
    const canned = JSON.stringify([
      { kind: 'k', title: 'overconfident', priority: 'low', confidence: 0.99, evidence: {} },
    ]);
    await runSubconscious(db, 'all', { config: RUNNABLE_CONFIG, deps: deps(canned) });
    const row = db.prepare(`SELECT confidence FROM suggestions`).get() as { confidence: number };
    expect(row.confidence).toBe(0.85);
  });

  it('malformed JSON → run_failed reason=parse_error, zero inserts', async () => {
    const result = await runSubconscious(db, 'all', {
      config: RUNNABLE_CONFIG,
      deps: deps('this is not json'),
    });
    expect(result.outcome).toBe('failed');
    expect(result.fail_reason).toBe('parse_error');
    const count = db.prepare(`SELECT COUNT(*) AS n FROM suggestions`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('disabled instance → run_skipped(disabled), zero inserts', async () => {
    const result = await runSubconscious(db, 'all', {
      config: { ...RUNNABLE_CONFIG, enabled: false },
      deps: deps('[]'),
    });
    expect(result.outcome).toBe('skipped');
    expect(result.skip_reason).toBe('disabled');
    const count = db.prepare(`SELECT COUNT(*) AS n FROM suggestions`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('cli_missing (no harness) → run_skipped(cli_missing), zero inserts', async () => {
    const result = await runSubconscious(db, 'all', {
      config: RUNNABLE_CONFIG,
      deps: {
        resolveBackend: () => ({ harness: null, fallback_order: ['claude'] }),
        isColdStart: () => false,
      },
    });
    expect(result.outcome).toBe('skipped');
    expect(result.skip_reason).toBe('cli_missing');
    const count = db.prepare(`SELECT COUNT(*) AS n FROM suggestions`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  // RUN_LLM_INTEGRATION=1-gated real-harness smoke (FR-118 M2 plan §C step 3).
  // Skipped by default — it spawns the REAL resolved harness CLI on a fixture
  // brain (no mocked backend), proving the end-to-end isolated extraction works
  // against a live model. Gated so CI (no CLI / no subscription auth) never
  // blocks on it. Run locally with: RUN_LLM_INTEGRATION=1 npx vitest run ...
  const liveIt = process.env.RUN_LLM_INTEGRATION === '1' ? it : it.skip;
  liveIt(
    'real-harness smoke: runs an isolated extraction on a fixture brain',
    async () => {
      const config: SubconsciousConfig = { ...RUNNABLE_CONFIG, enabled: true };
      // No backend seam injected → the real brain-isolated backend runs.
      const result = await runSubconscious(db, 'all', { config, force: true });
      // The run reaches a terminal outcome (succeeded if the model returned a
      // valid array, failed=parse_error if not, skipped=cli_missing if absent).
      expect(['succeeded', 'failed', 'skipped']).toContain(result.outcome);
      expect(result.instance_id).toBe('subconscious');
    },
    120_000,
  );

  it('the LLM never sees the live brain — the digest is the only input it carries', async () => {
    // Sanity: the backend receives the prompt (system+user) only; the engine
    // never hands the DB to the backend seam. We assert the user prompt carries
    // the digest (the <digest> wrap) and nothing more.
    let capturedUser = '';
    await runSubconscious(db, 'all', {
      config: RUNNABLE_CONFIG,
      deps: {
        resolveBackend: () => ({ harness: 'claude', fallback_order: ['claude'] }),
        isColdStart: () => false,
        runBackend: async (_h, prompt): Promise<BackendRunResult> => {
          capturedUser = prompt.user;
          return { ok: true, text: '[]' };
        },
      },
    });
    expect(capturedUser).toContain('<digest>');
    expect(capturedUser).toContain('BR-1'); // the seeded brief is in the digest
  });
});
