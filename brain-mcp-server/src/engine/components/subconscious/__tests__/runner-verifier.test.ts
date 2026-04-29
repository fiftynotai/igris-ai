/**
 * Runner — Verifier integration tests (FR-108)
 *
 * Verifies the runner threads `RunOptions.verifier` through the conflict
 * pipeline correctly:
 *   1. Verifier confirms heuristic candidate → suggestion persisted with
 *      verifier_status=verified evidence.
 *   2. Verifier rejects with explicit `{is_conflict:false, status:verified}`
 *      → suggestion NOT persisted; rejection event emitted.
 *   3. Verifier throws → suggestion still persisted; evidence
 *      verifier_status=spawn_failed.
 *   4. Default `noopVerifier` (CLI missing) → all candidates pass through
 *      with verifier_status=cli_missing.
 *   5. Non-conflict candidates (stalled/gap/pattern) never invoke verifier.
 *
 * Tests inject stub verifiers via `RunOptions.verifier` — never spawns
 * the real `claude` binary.
 *
 * @module engine/components/subconscious/__tests__/runner-verifier.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runAllDetectors } from '../runner.js';
import { subconsciousMigrations } from '../schema.js';
import { DEFAULT_DETECTOR_CONFIG, type DetectorConfig } from '../types.js';
import { type ConflictVerifier, type VerifierResult } from '../verifier.js';
import {
  applyMinimalSchema,
  seedLearningWithEmbedding,
  seedProject,
} from './fixtures/minimal-schema.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const DIM = 384;

function basisVec(axis: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  return v;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  applyMinimalSchema(db);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  return db;
}

/**
 * Seed two learnings with cosine=1.0 (identical embeddings) and disjoint
 * vocabulary (Jaccard=0) so the heuristic conflict detector emits exactly
 * one candidate. The verifier then has a deterministic input to ratify.
 */
function seedConflictPair(db: Database.Database, project = 'p1'): void {
  seedProject(db, { slug: project });
  const a = basisVec(0);
  seedLearningWithEmbedding(db, {
    project,
    title: 'Use React for SPA',
    content: 'react frontend single page application client',
    embedding: a,
  });
  seedLearningWithEmbedding(db, {
    project,
    title: 'Use SvelteKit instead',
    content: 'svelte alternative compile time minimal bundle',
    embedding: a,
  });
}

/** Skinny config that disables non-conflict detectors so tests stay focused. */
function conflictOnlyConfig(): DetectorConfig {
  return {
    ...DEFAULT_DETECTOR_CONFIG,
    // Drop other detectors to massive thresholds so they emit nothing.
    stalled_in_progress_medium_days: 9999,
    stalled_in_progress_high_days: 9999,
    stalled_ready_medium_days: 9999,
    stalled_ready_high_days: 9999,
    gap_quiet_medium_days: 9999,
    gap_quiet_high_days: 9999,
    pattern_min_samples: 9999,
    pattern_min_effect: 999,
    pattern_smoothing_runs: 999,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAllDetectors — verifier integration (FR-108)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('verifier confirms candidate → suggestion persisted with verifier_status=verified', async () => {
    seedConflictPair(db);

    const stub: ConflictVerifier = async () => ({
      is_conflict: true,
      reason: 'real contradiction',
      status: 'verified',
    });

    const summary = await runAllDetectors(db, {
      config: conflictOnlyConfig(),
      verifier: stub,
    });

    expect(summary.by_module.conflict).toBe(1);
    const row = db
      .prepare(`SELECT evidence FROM suggestions WHERE source_module = 'conflict'`)
      .get() as { evidence: string };
    const ev = JSON.parse(row.evidence) as Record<string, unknown>;
    expect(ev.verifier).toBe('claude-headless');
    expect(ev.verifier_status).toBe('verified');
    expect(ev.verifier_reason).toBe('real contradiction');
    expect(typeof ev.verified_at).toBe('string');

    // Companion verified event should be present.
    const verifiedEvents = summary.events.filter((e) => e.kind === 'suggestion_verified');
    expect(verifiedEvents).toHaveLength(1);
  });

  it('verifier rejects with verified-false → suggestion NOT persisted; rejection event emitted', async () => {
    seedConflictPair(db);

    const stub: ConflictVerifier = async () => ({
      is_conflict: false,
      reason: 'different scopes',
      status: 'verified',
    });

    const summary = await runAllDetectors(db, {
      config: conflictOnlyConfig(),
      verifier: stub,
    });

    expect(summary.by_module.conflict).toBe(0);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE source_module = 'conflict'`)
      .get() as { n: number };
    expect(row.n).toBe(0);

    // Rejection event must surface for observability.
    const rejected = summary.events.filter(
      (e) => e.kind === 'suggestion_rejected_by_verifier',
    );
    expect(rejected).toHaveLength(1);
    if (rejected[0].kind === 'suggestion_rejected_by_verifier') {
      expect(rejected[0].verifier_reason).toBe('different scopes');
    }
  });

  it('verifier throws → suggestion still persisted with verifier_status=spawn_failed', async () => {
    seedConflictPair(db);

    const stub: ConflictVerifier = async () => {
      throw new Error('subprocess died');
    };

    const summary = await runAllDetectors(db, {
      config: conflictOnlyConfig(),
      verifier: stub,
    });

    expect(summary.by_module.conflict).toBe(1);
    const row = db
      .prepare(`SELECT evidence FROM suggestions WHERE source_module = 'conflict'`)
      .get() as { evidence: string };
    const ev = JSON.parse(row.evidence) as Record<string, unknown>;
    expect(ev.verifier_status).toBe('spawn_failed');
    expect(ev.verifier_reason).toContain('subprocess died');
  });

  it('verifier returns parse_failed → suggestion still persisted with that status', async () => {
    seedConflictPair(db);

    const stub: ConflictVerifier = async () => ({
      is_conflict: true,
      reason: 'parse failed: garbage',
      status: 'parse_failed',
    });

    const summary = await runAllDetectors(db, {
      config: conflictOnlyConfig(),
      verifier: stub,
    });

    expect(summary.by_module.conflict).toBe(1);
    const row = db
      .prepare(`SELECT evidence FROM suggestions WHERE source_module = 'conflict'`)
      .get() as { evidence: string };
    const ev = JSON.parse(row.evidence) as Record<string, unknown>;
    expect(ev.verifier_status).toBe('parse_failed');
  });

  it('verifier returns timeout → suggestion still persisted with timeout status', async () => {
    seedConflictPair(db);

    const stub: ConflictVerifier = async () => ({
      is_conflict: true,
      reason: 'verifier timeout after 45000ms',
      status: 'timeout',
    });

    const summary = await runAllDetectors(db, {
      config: conflictOnlyConfig(),
      verifier: stub,
    });

    expect(summary.by_module.conflict).toBe(1);
    const row = db
      .prepare(`SELECT evidence FROM suggestions WHERE source_module = 'conflict'`)
      .get() as { evidence: string };
    const ev = JSON.parse(row.evidence) as Record<string, unknown>;
    expect(ev.verifier_status).toBe('timeout');
  });

  it('default verifier (noopVerifier) passes candidates through with cli_missing status', async () => {
    seedConflictPair(db);

    // Omit `verifier` field — runner uses noopVerifier default.
    const summary = await runAllDetectors(db, {
      config: conflictOnlyConfig(),
    });

    expect(summary.by_module.conflict).toBe(1);
    const row = db
      .prepare(`SELECT evidence FROM suggestions WHERE source_module = 'conflict'`)
      .get() as { evidence: string };
    const ev = JSON.parse(row.evidence) as Record<string, unknown>;
    expect(ev.verifier_status).toBe('cli_missing');
  });

  it('does not invoke verifier for non-conflict candidates (stalled/gap)', async () => {
    seedProject(db, { slug: 'p1' });
    // Force a stalled brief by inserting directly. The minimal schema has
    // brief_status; we want the stalled detector to pick this up.
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, title, status, priority, updated_at)
       VALUES ('p1', 'BR-1', 'Stuck', 'In Progress', 'P2-Medium', datetime('now', '-35 days'))`,
    ).run();

    let callCount = 0;
    const stub: ConflictVerifier = async () => {
      callCount += 1;
      return { is_conflict: true, reason: '', status: 'verified' };
    };

    await runAllDetectors(db, {
      config: { ...DEFAULT_DETECTOR_CONFIG },
      verifier: stub,
    });

    expect(callCount).toBe(0);
  });

  it('respects the per-project conflict cap when invoking verifier', async () => {
    // Construct 6 learnings with identical embeddings and disjoint
    // vocabulary so the heuristic emits exactly conflict_max_pairs_emitted
    // (5 by default) candidates.
    seedProject(db, { slug: 'p1' });
    const a = basisVec(0);
    const wordPool = [
      'apple', 'banana', 'cherry', 'durian', 'elderberry', 'fig',
      'grape', 'honeydew', 'iceberg', 'jackfruit', 'kiwi', 'lime',
    ];
    for (let i = 0; i < 6; i++) {
      seedLearningWithEmbedding(db, {
        project: 'p1',
        title: `learning-${i}`,
        content: `${wordPool[i * 2]} ${wordPool[i * 2 + 1]}`,
        embedding: a,
      });
    }

    let callCount = 0;
    const stub: ConflictVerifier = async () => {
      callCount += 1;
      return { is_conflict: true, reason: '', status: 'verified' };
    };

    await runAllDetectors(db, {
      config: conflictOnlyConfig(),
      verifier: stub,
    });

    // Verifier must be called at most conflict_max_pairs_emitted times
    // per project (the heuristic caps the candidate pool BEFORE the
    // verifier sees them).
    expect(callCount).toBeLessThanOrEqual(
      DEFAULT_DETECTOR_CONFIG.conflict_max_pairs_emitted,
    );
    expect(callCount).toBeGreaterThan(0);
  });

  it('passes the correct learning content to the verifier', async () => {
    seedConflictPair(db);

    const calls: { a: { id: number; content: string }; b: { id: number; content: string } }[] = [];
    const stub: ConflictVerifier = async (a, b) => {
      calls.push({
        a: { id: a.id, content: a.content },
        b: { id: b.id, content: b.content },
      });
      return { is_conflict: true, reason: '', status: 'verified' };
    };

    await runAllDetectors(db, {
      config: conflictOnlyConfig(),
      verifier: stub,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].a.content).toContain('react');
    expect(calls[0].b.content).toContain('svelte');
  });

  it('verifier rejection emits NO suggestion_verified event for that candidate', async () => {
    seedConflictPair(db);

    const stub: ConflictVerifier = async () => ({
      is_conflict: false,
      reason: 'not a conflict',
      status: 'verified',
    });

    const summary = await runAllDetectors(db, {
      config: conflictOnlyConfig(),
      verifier: stub,
    });

    const verifiedEvents = summary.events.filter((e) => e.kind === 'suggestion_verified');
    expect(verifiedEvents).toHaveLength(0);
  });

  it('short-circuits verifier on candidates whose dedupe key is already pending (TD-055 nit 1)', async () => {
    // Perf guard: a verified-conflict that survived a previous run is still
    // pending in `suggestions`. On the next 6h cron, the heuristic re-emits
    // the same candidate. Without the short-circuit, we'd burn ~3-7s + tokens
    // on an LLM call just to dedupe pre-INSERT in the main loop.
    //
    // Setup: seed a conflict pair, then pre-seed a pending suggestion with
    // the SAME evidence_signature (`conflict:1:2`) the heuristic will produce.
    // The runner's `existingPending` snapshot must include this row, and
    // `verifyConflictCandidates` must skip the LLM call for that candidate.
    seedConflictPair(db);

    // Pre-seed pending suggestion. seedConflictPair inserts learning ids 1,2,
    // so the conflict detector will produce evidence.learning_ids=[1,2] and
    // computeEvidenceSignature returns 'conflict:1:2'. The dedupe key is
    // 'conflict|p1|conflict:1:2'.
    db.prepare(
      `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status)
       VALUES ('conflict', 'p1', 'Possible contradiction: Learning #1 vs #2',
               ?, 'medium', 'pending')`,
    ).run(JSON.stringify({ learning_ids: [1, 2] }));

    let callCount = 0;
    const stub: ConflictVerifier = async () => {
      callCount += 1;
      return { is_conflict: true, reason: 'should not be called', status: 'verified' };
    };

    const summary = await runAllDetectors(db, {
      config: conflictOnlyConfig(),
      verifier: stub,
    });

    // Verifier MUST NOT have been invoked — short-circuit kicked in.
    expect(callCount).toBe(0);

    // No new suggestion persisted; the existing pending row dedupes it out.
    expect(summary.by_module.conflict).toBe(0);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE source_module = 'conflict'`)
      .get() as { n: number };
    expect(row.n).toBe(1); // only the pre-seeded row
  });
});

// Mark the local helper as used to avoid lint complaints in case the
// type narrowing branch above is removed.
type _Unused = VerifierResult;
