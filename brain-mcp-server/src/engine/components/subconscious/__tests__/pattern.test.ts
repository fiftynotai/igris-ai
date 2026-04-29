/**
 * Pattern Detector — unit tests (FR-106 Phase 2)
 *
 * Eight scenarios per plan §"Test Scenarios Summary":
 *   DOW sub-detector
 *     1. N=20 (under sample threshold) → 0 candidates.
 *     2. N=50 uniformly distributed → 0 candidates (effect <0.15).
 *     3. N=50 with 60% Mondays, fresh single run → 0 (smoothing gate).
 *     4. Same as #3 with 2 prior pattern_observations rows → 1 candidate.
 *     5. Same as #4 but oldest observation >14d ago → 0 (window gate).
 *
 *   Agent retry sub-detector
 *     6. forger 50% retries vs ~10% baseline → 1 candidate at
 *        agent_retry:forger.
 *     7. Low effect (≈0.10 above baseline) → 0 candidates.
 *
 *   Combined
 *     8. runAllDetectors over a full fixture → data_version invariant
 *        for the detector phase (covered in integrity.test.ts).
 *
 * Smoothing tests use the runner's `runAllDetectors` because the gate
 * lives in `smoothPatterns` rather than the detector itself. Synthetic
 * `pattern_observations` rows seed prior runs.
 *
 * @module engine/components/subconscious/__tests__/pattern.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { detectPattern } from '../detectors/pattern.js';
import { runAllDetectors } from '../runner.js';
import { makeReadOnlyDb } from '../readonly-db.js';
import { DEFAULT_DETECTOR_CONFIG } from '../types.js';
import { subconsciousMigrations } from '../schema.js';
import {
  applyMinimalSchema,
  daysAgo,
  seedAgentMetric,
  seedProject,
} from './fixtures/minimal-schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  applyMinimalSchema(db);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  return db;
}

/**
 * Seed a brief into a specific weekday by reverse-engineering the offset
 * from today's day-of-week. Avoids fragile wall-clock assumptions:
 * regardless of when the test runs, the resulting timestamp lands on the
 * requested day.
 *
 * Side effect: every brief is given a unique brief_id (passed in) so the
 * UNIQUE(project, brief_id) constraint doesn't fire.
 */
function seedBriefOnDow(
  db: Database.Database,
  briefId: string,
  project: string,
  targetDow: number,
  baseDaysAgo: number,
): void {
  const today = new Date();
  const todayDow = today.getDay(); // 0..6
  // Move BACK to the requested day-of-week (subtract a few days), then
  // bias by `baseDaysAgo` so multiple briefs on the same target_dow
  // don't collide.
  const offset = (todayDow - targetDow + 7) % 7;
  const totalDaysAgo = offset + baseDaysAgo * 7;
  const ts = new Date(today.getTime() - totalDaysAgo * 24 * 60 * 60 * 1000);
  const iso = ts.toISOString().replace('T', ' ').substring(0, 19);
  db.prepare(
    `INSERT INTO brief_status (project, brief_id, title, status, priority, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(project, briefId, briefId, 'In Progress', 'P2-Medium', iso);
}

// ---------------------------------------------------------------------------
// DOW sub-detector
// ---------------------------------------------------------------------------

describe('detectPattern — day-of-week', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedProject(db, { slug: 'igris-ai', registered_days_ago: 400 });
  });

  afterEach(() => db.close());

  it('returns 0 candidates when N=20 (under sample threshold)', () => {
    // Distribute 20 briefs evenly across 7 days. Total < pattern_min_samples(30).
    for (let i = 0; i < 20; i++) {
      seedBriefOnDow(db, `BR-${i}`, 'igris-ai', i % 7, Math.floor(i / 7));
    }
    const result = detectPattern(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toEqual([]);
  });

  it('returns 0 candidates for N=50 uniformly distributed', () => {
    // 50 briefs as evenly as possible across 7 days (7+7+7+7+7+7+8 = 50).
    let counter = 0;
    for (let dow = 0; dow < 7; dow++) {
      const count = dow === 6 ? 8 : 7;
      for (let i = 0; i < count; i++) {
        seedBriefOnDow(db, `BR-${counter++}`, 'igris-ai', dow, i);
      }
    }
    const result = detectPattern(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toEqual([]);
  });

  it('emits a DOW candidate when 60% of 50 briefs are on Mondays', () => {
    // 30 Mondays + 20 spread across other 6 days. Effect = (30 - 50/7)/50 ≈ 0.456
    // Well above pattern_min_effect = 0.15.
    let counter = 0;
    for (let i = 0; i < 30; i++) {
      seedBriefOnDow(db, `BR-${counter++}`, 'igris-ai', 1, i); // Monday
    }
    for (let i = 0; i < 20; i++) {
      seedBriefOnDow(db, `BR-${counter++}`, 'igris-ai', 2 + (i % 5), Math.floor(i / 5));
    }
    const result = detectPattern(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0].source_module).toBe('pattern');
    expect(result[0].priority).toBe('medium'); // patterns always cap at medium
    expect(result[0].project_slug).toBe('igris-ai');
    const ev = result[0].evidence as Record<string, unknown>;
    expect(ev.kind).toBe('dow');
    expect(ev.day).toBe('1'); // Monday in strftime('%w')
    expect(ev.day_name).toBe('Monday');
    expect(ev.pattern_key).toBe('dow:1:igris-ai');
  });

  it('does not emit a DOW candidate when effect is below 0.15', () => {
    // Slightly skew but stay under threshold: 9 Mondays out of 50 -> effect = (9 - 50/7)/50 ≈ 0.037.
    let counter = 0;
    for (let i = 0; i < 9; i++) {
      seedBriefOnDow(db, `BR-${counter++}`, 'igris-ai', 1, i);
    }
    for (let i = 0; i < 41; i++) {
      seedBriefOnDow(db, `BR-${counter++}`, 'igris-ai', 2 + (i % 6), Math.floor(i / 6));
    }
    const result = detectPattern(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Agent retry sub-detector
// ---------------------------------------------------------------------------

describe('detectPattern — agent retry', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedProject(db, { slug: 'igris-ai' });
  });

  afterEach(() => db.close());

  it('emits a candidate when forger retry rate is well above baseline', () => {
    // forger: 100 runs, 50 retries → 50% rate.
    for (let i = 0; i < 100; i++) {
      seedAgentMetric(db, {
        agent: 'forger',
        retry_count: i < 50 ? 1 : 0,
        recorded_days_ago: 5,
      });
    }
    // Other agents: 200 runs, 20 retries → 10% rate. Pulls cross-agent
    // baseline to (50+20)/(100+200) = 23.3%; forger effect = 0.50-0.233 = 0.267 > 0.15.
    for (const agent of ['sentinel', 'warden']) {
      for (let i = 0; i < 100; i++) {
        seedAgentMetric(db, {
          agent,
          retry_count: i < 10 ? 1 : 0,
          recorded_days_ago: 5,
        });
      }
    }
    const result = detectPattern(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    const forgerCandidate = result.find((c) => {
      const ev = c.evidence as Record<string, unknown>;
      return ev.kind === 'agent_retry' && ev.agent === 'forger';
    });
    expect(forgerCandidate).toBeDefined();
    expect(forgerCandidate!.priority).toBe('medium');
    expect(forgerCandidate!.project_slug).toBeNull();
    const ev = forgerCandidate!.evidence as Record<string, unknown>;
    expect(ev.pattern_key).toBe('agent_retry:forger');
    expect(ev.rate as number).toBeCloseTo(0.5, 2);
    expect(ev.effect as number).toBeGreaterThan(0.15);
  });

  it('does not emit when effect is below 0.15 above baseline', () => {
    // Two agents at 30% retry rate → baseline = 30%, effect = 0.0 for each.
    for (const agent of ['forger', 'sentinel']) {
      for (let i = 0; i < 100; i++) {
        seedAgentMetric(db, {
          agent,
          retry_count: i < 30 ? 1 : 0,
          recorded_days_ago: 5,
        });
      }
    }
    const result = detectPattern(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    const retryCandidates = result.filter((c) => {
      const ev = c.evidence as Record<string, unknown>;
      return ev.kind === 'agent_retry';
    });
    expect(retryCandidates).toEqual([]);
  });

  it('returns 0 gracefully when agent_metrics table is missing', () => {
    const empty = new Database(':memory:');
    try {
      // No agent_metrics, no brief_status: detector returns [] for both halves.
      const result = detectPattern(makeReadOnlyDb(empty), DEFAULT_DETECTOR_CONFIG);
      expect(result).toEqual([]);
    } finally {
      empty.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Smoothing — verified end-to-end via runAllDetectors (the gate lives there)
// ---------------------------------------------------------------------------

describe('pattern smoothing (runAllDetectors)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedProject(db, { slug: 'igris-ai', registered_days_ago: 400 });

    // Seed a strong DOW skew (60% Mondays, total 50) — guaranteed to
    // produce a DOW candidate every run.
    let counter = 0;
    for (let i = 0; i < 30; i++) {
      seedBriefOnDow(db, `BR-${counter++}`, 'igris-ai', 1, i);
    }
    for (let i = 0; i < 20; i++) {
      seedBriefOnDow(db, `BR-${counter++}`, 'igris-ai', 2 + (i % 5), Math.floor(i / 5));
    }
  });

  afterEach(() => db.close());

  it('does NOT emit a pattern suggestion on the first run only', async () => {
    const summary = await runAllDetectors(db);
    // Pattern is gated by 3-distinct-runs default; first run records
    // observation #1, count distinct = 1, gate not met.
    expect(summary.by_module.pattern).toBe(0);
    // Other modules can fire normally.
    expect(summary.emitted).toBeGreaterThanOrEqual(0);
  });

  it('emits the pattern suggestion on the 3rd distinct run', async () => {
    // Simulate two prior runs by seeding pattern_observations directly.
    const patternKey = 'dow:1:igris-ai';
    const insertObs = db.prepare(
      `INSERT INTO pattern_observations
         (pattern_key, run_id, observed_at, effect_size, sample_size, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertObs.run(patternKey, '2026-04-26T00:00:00Z', daysAgo(2), 0.46, 50, '{}');
    insertObs.run(patternKey, '2026-04-27T00:00:00Z', daysAgo(1), 0.46, 50, '{}');

    const summary = await runAllDetectors(db);
    // 3rd distinct run inside the 14-day window → emit.
    expect(summary.by_module.pattern).toBeGreaterThanOrEqual(1);
    // Find the suggestion row to confirm shape.
    const rows = db
      .prepare(
        `SELECT * FROM suggestions
         WHERE source_module = 'pattern'
           AND status = 'pending'`,
      )
      .all() as { evidence: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const ev = JSON.parse(rows[0].evidence) as Record<string, unknown>;
    expect(ev.pattern_key).toBe(patternKey);
  });

  it('does NOT emit if oldest observation is outside the 14d window', async () => {
    // Seed two prior observations OUTSIDE the smoothing window.
    const patternKey = 'dow:1:igris-ai';
    const insertObs = db.prepare(
      `INSERT INTO pattern_observations
         (pattern_key, run_id, observed_at, effect_size, sample_size, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertObs.run(patternKey, 'old-run-1', daysAgo(20), 0.46, 50, '{}');
    insertObs.run(patternKey, 'old-run-2', daysAgo(16), 0.46, 50, '{}');

    const summary = await runAllDetectors(db);
    // Window default = 14d; both prior obs are stale (>14d). Distinct
    // runs in-window = 1 (this run). Gate fails → no emission.
    expect(summary.by_module.pattern).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Smoothing decay — pattern_observations TTL
// ---------------------------------------------------------------------------

describe('pattern_observations TTL pruning', () => {
  it('expireStaleRows reports observations pruned in summary', async () => {
    const db = makeDb();
    seedProject(db, { slug: 'igris-ai' });
    // Seed an observation 60 days old — outside the default TTL of 30d.
    db.prepare(
      `INSERT INTO pattern_observations
         (pattern_key, run_id, observed_at, effect_size, sample_size, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('dow:1:igris-ai', 'ancient-run', daysAgo(60), 0.46, 50, '{}');

    const summary = await runAllDetectors(db);
    expect(summary.expired_observations).toBeGreaterThanOrEqual(1);
    db.close();
  });
});
