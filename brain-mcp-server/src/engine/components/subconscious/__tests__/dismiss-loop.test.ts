/**
 * Dismiss-Reason Learning Loop — unit tests
 *
 * Covers the FR-106 Phase 1 (Q3=B) suppression mechanic:
 *   (a) Dismiss with reason -> dismissed_patterns row, dismiss_count=1.
 *   (b) Dismiss same signature again -> dismiss_count=2, reasons appended.
 *   (c) >5 dismisses -> reasons array capped at the last 5.
 *   (d) New candidate, dismiss_count >= 2 -> suppressed.
 *   (e) New candidate, dismiss_count=1, last_dismissed >7d -> emitted.
 *   (f) New candidate, dismiss_count=1, last_dismissed <7d -> suppressed.
 *
 * @module engine/components/subconscious/__tests__/dismiss-loop.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import { handleSuggestionDismiss, setHandlerContext } from '../handlers.js';
import {
  computeEvidenceSignature,
  recordDismissPattern,
  runAllDetectors,
} from '../runner.js';
import { subconsciousMigrations } from '../schema.js';
import { DEFAULT_DETECTOR_CONFIG, type Suggestion } from '../types.js';
import { createEventBus } from '../../../bus.js';
import {
  applyMinimalSchema,
  seedBrief,
  seedProject,
} from './fixtures/minimal-schema.js';

interface DismissedPatternRow {
  id: number;
  source_module: string;
  project_slug: string;
  evidence_signature: string;
  dismiss_count: number;
  last_dismissed_at: string;
  reasons: string;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  applyMinimalSchema(db);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  return db;
}

function insertPending(
  db: Database.Database,
  source_module: string,
  title: string,
  evidence: Record<string, unknown>,
  project_slug: string | null = 'p1',
): number {
  const result = db
    .prepare(
      `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status)
       VALUES (?, ?, ?, ?, 'medium', 'pending')`,
    )
    .run(source_module, project_slug, title, JSON.stringify(evidence));
  return Number(result.lastInsertRowid);
}

function getPattern(
  db: Database.Database,
  module: string,
  signature: string,
  slug = 'p1',
): DismissedPatternRow | undefined {
  return db
    .prepare(
      `SELECT * FROM dismissed_patterns
       WHERE source_module = ? AND project_slug = ? AND evidence_signature = ?`,
    )
    .get(module, slug, signature) as DismissedPatternRow | undefined;
}

describe('dismiss-reason learning loop', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    setHandlerContext({ bus: createEventBus(), config: DEFAULT_DETECTOR_CONFIG });
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // (a) First dismiss -> dismiss_count = 1
  // -----------------------------------------------------------------------

  it('records first dismiss with dismiss_count = 1 and the supplied reason', () => {
    const id = insertPending(db, 'stalled', 'TD-005 stalled', { brief_id: 'TD-005' });
    const result = handleSuggestionDismiss({ id, reason: 'noise' });
    expect(result.isError).toBeUndefined();

    const sig = computeEvidenceSignature('stalled', { brief_id: 'TD-005' });
    const row = getPattern(db, 'stalled', sig);
    expect(row).toBeDefined();
    expect(row!.dismiss_count).toBe(1);
    expect(JSON.parse(row!.reasons)).toEqual(['noise']);
  });

  // -----------------------------------------------------------------------
  // (b) Repeated dismiss -> dismiss_count++ and reasons append
  // -----------------------------------------------------------------------

  it('increments dismiss_count and appends reasons on repeat dismisses', () => {
    const sig = computeEvidenceSignature('stalled', { brief_id: 'TD-1' });
    // Two independent dismisses of the SAME evidence signature: each
    // creates and dismisses a pending suggestion (the engine recreates
    // them each cycle until a project takes action).
    for (const reason of ['too-noisy', 'wrong-priority']) {
      const id = insertPending(db, 'stalled', `pending ${reason}`, { brief_id: 'TD-1' });
      handleSuggestionDismiss({ id, reason });
    }
    const row = getPattern(db, 'stalled', sig);
    expect(row).toBeDefined();
    expect(row!.dismiss_count).toBe(2);
    expect(JSON.parse(row!.reasons)).toEqual(['too-noisy', 'wrong-priority']);
  });

  // -----------------------------------------------------------------------
  // (c) Reasons array capped at config.dismiss_reasons_cap (default 5)
  // -----------------------------------------------------------------------

  it('caps the reasons JSON array at dismiss_reasons_cap entries', () => {
    const sig = 'stalled:cap-test';
    // Use recordDismissPattern directly so we can iterate quickly without
    // re-inserting suggestion rows. This is the exact same code path
    // exercised by handleSuggestionDismiss.
    for (let i = 0; i < 7; i++) {
      recordDismissPattern(
        db,
        'stalled',
        'p1',
        sig,
        `r${i}`,
        DEFAULT_DETECTOR_CONFIG,
      );
    }
    const row = db
      .prepare(
        `SELECT * FROM dismissed_patterns
         WHERE source_module = ? AND project_slug = ? AND evidence_signature = ?`,
      )
      .get('stalled', 'p1', sig) as DismissedPatternRow;
    expect(row.dismiss_count).toBe(7);
    const reasons = JSON.parse(row.reasons) as string[];
    expect(reasons).toHaveLength(DEFAULT_DETECTOR_CONFIG.dismiss_reasons_cap);
    // Should be the LAST 5: r2..r6
    expect(reasons).toEqual(['r2', 'r3', 'r4', 'r5', 'r6']);
  });

  // -----------------------------------------------------------------------
  // (d) Suppression after dismiss_count >= dismiss_suppress_count
  // -----------------------------------------------------------------------

  it('suppresses new suggestions when dismiss_count >= 2', () => {
    seedProject(db, { slug: 'p1' });
    seedBrief(db, {
      project: 'p1',
      brief_id: 'BR-9',
      status: 'In Progress',
      updated_days_ago: 35,
    });
    const sig = computeEvidenceSignature('stalled', { brief_id: 'BR-9' });
    // Pre-load dismissed_patterns with dismiss_count = 2 so the runner
    // sees the signature as already-suppressed before generating.
    db.prepare(
      `INSERT INTO dismissed_patterns
         (source_module, project_slug, evidence_signature, dismiss_count, last_dismissed_at, reasons)
       VALUES ('stalled', 'p1', ?, 2, datetime('now'), '["a","b"]')`,
    ).run(sig);

    const summary = runAllDetectors(db);
    // Stalled detector saw the brief but the suppression filter killed it.
    expect(summary.suppressed).toBeGreaterThanOrEqual(1);
    // No suggestions row because suppression skipped insertion.
    const inserted = db
      .prepare(
        `SELECT COUNT(*) AS n FROM suggestions WHERE source_module = 'stalled' AND project_slug = 'p1'`,
      )
      .get() as { n: number };
    expect(inserted.n).toBe(0);
  });

  // -----------------------------------------------------------------------
  // (e) After cooldown elapses (>7d), single-dismiss signature re-emits
  // -----------------------------------------------------------------------

  it('re-emits when single-dismiss cooldown has elapsed', () => {
    seedProject(db, { slug: 'p1' });
    seedBrief(db, {
      project: 'p1',
      brief_id: 'BR-10',
      status: 'In Progress',
      updated_days_ago: 35,
    });
    const sig = computeEvidenceSignature('stalled', { brief_id: 'BR-10' });
    // Single dismiss, last_dismissed_at = 8 days ago (cooldown is 7).
    db.prepare(
      `INSERT INTO dismissed_patterns
         (source_module, project_slug, evidence_signature, dismiss_count, last_dismissed_at, reasons)
       VALUES ('stalled', 'p1', ?, 1, datetime('now', '-8 days'), '["test"]')`,
    ).run(sig);

    const summary = runAllDetectors(db);
    expect(summary.emitted).toBeGreaterThanOrEqual(1);
    const inserted = db
      .prepare(
        `SELECT COUNT(*) AS n FROM suggestions WHERE source_module = 'stalled' AND project_slug = 'p1'`,
      )
      .get() as { n: number };
    expect(inserted.n).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // (f) Within cooldown window (<7d), single-dismiss signature suppressed
  // -----------------------------------------------------------------------

  it('suppresses within cooldown window for single-dismiss signature', () => {
    seedProject(db, { slug: 'p1' });
    seedBrief(db, {
      project: 'p1',
      brief_id: 'BR-11',
      status: 'In Progress',
      updated_days_ago: 35,
    });
    const sig = computeEvidenceSignature('stalled', { brief_id: 'BR-11' });
    // Single dismiss, last_dismissed_at = 3 days ago (within 7-day cooldown).
    db.prepare(
      `INSERT INTO dismissed_patterns
         (source_module, project_slug, evidence_signature, dismiss_count, last_dismissed_at, reasons)
       VALUES ('stalled', 'p1', ?, 1, datetime('now', '-3 days'), '["test"]')`,
    ).run(sig);

    const summary = runAllDetectors(db);
    expect(summary.suppressed).toBeGreaterThanOrEqual(1);
    const inserted = db
      .prepare(
        `SELECT COUNT(*) AS n FROM suggestions WHERE source_module = 'stalled' AND project_slug = 'p1'`,
      )
      .get() as { n: number };
    expect(inserted.n).toBe(0);
  });

  // -----------------------------------------------------------------------
  // computeEvidenceSignature contracts
  // -----------------------------------------------------------------------

  describe('computeEvidenceSignature', () => {
    it('uses evidence.brief_id for stalled', () => {
      expect(computeEvidenceSignature('stalled', { brief_id: 'TD-7' })).toBe('brief:TD-7');
    });

    it('uses project_slug for gap.project_quiet', () => {
      expect(
        computeEvidenceSignature('gap', {
          gap_kind: 'project_quiet',
          project_slug: 'sleepy',
        }),
      ).toBe('gap:project_quiet:sleepy');
    });

    it('uses brief_id for gap.done_with_unchecked', () => {
      expect(
        computeEvidenceSignature('gap', {
          gap_kind: 'done_with_unchecked',
          brief_id: 'BR-12',
        }),
      ).toBe('gap:done_unchecked:BR-12');
    });

    it('produces stable signatures via fallback for malformed evidence', () => {
      const a = computeEvidenceSignature('stalled', { foo: 1, bar: 2 });
      const b = computeEvidenceSignature('stalled', { bar: 2, foo: 1 });
      expect(a).toBe(b);
      expect(a).toMatch(/^stalled:fallback:/);
    });

    it('disambiguates across modules', () => {
      const a = computeEvidenceSignature('stalled', {});
      const b = computeEvidenceSignature('gap', {});
      expect(a).not.toBe(b);
    });

    // -------------------------------------------------------------------
    // TD-054 Nit 2: conflict signatures sort learning_ids numerically
    // (not lexicographically) so `[2, 10]` and `[10, 2]` both produce
    // `conflict:2:10`. Lex sort would yield `conflict:10:2` for `[10, 2]`
    // — stable but visually inconsistent with the numeric storage in
    // `evidence.learning_ids`.
    // -------------------------------------------------------------------

    it('sorts conflict learning_ids numerically (not lex) for the signature', () => {
      const ascending = computeEvidenceSignature('conflict', { learning_ids: [2, 10] });
      const descending = computeEvidenceSignature('conflict', { learning_ids: [10, 2] });
      expect(ascending).toBe(descending);
      expect(ascending).toBe('conflict:2:10');
    });

    it('numeric conflict sort handles single-digit pairs identically to lex', () => {
      // For ids in [0..9] lex and numeric agree; ensures we didn't break
      // the common case while fixing the multi-digit one.
      expect(computeEvidenceSignature('conflict', { learning_ids: [3, 7] })).toBe(
        'conflict:3:7',
      );
      expect(computeEvidenceSignature('conflict', { learning_ids: [7, 3] })).toBe(
        'conflict:3:7',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Sanity: dismiss-loop flow against the suggestion lifecycle
  // -----------------------------------------------------------------------

  it('end-to-end: dismiss twice then run -> next run suppresses', () => {
    seedProject(db, { slug: 'p1' });
    seedBrief(db, {
      project: 'p1',
      brief_id: 'BR-99',
      status: 'In Progress',
      updated_days_ago: 35,
    });

    // Cycle 1: detector creates the suggestion, user dismisses it.
    runAllDetectors(db);
    const cycle1 = db
      .prepare(
        `SELECT id FROM suggestions WHERE source_module = 'stalled' AND project_slug = 'p1'`,
      )
      .all() as { id: number }[];
    expect(cycle1.length).toBeGreaterThan(0);
    handleSuggestionDismiss({ id: cycle1[0].id, reason: 'cycle-1' });

    // Cycle 2: detector tries again, but signature suppressed via cooldown.
    runAllDetectors(db);
    const cycle2New = db
      .prepare(
        `SELECT COUNT(*) AS n FROM suggestions
         WHERE source_module = 'stalled' AND project_slug = 'p1' AND status = 'pending'`,
      )
      .get() as { n: number };
    expect(cycle2New.n).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Verify the dismiss handler also wrote to dismissed_patterns
  // -----------------------------------------------------------------------

  it('dismiss handler invokes recordDismissPattern within a single transaction', () => {
    const id = insertPending(db, 'stalled', 'X', { brief_id: 'BR-50' });
    handleSuggestionDismiss({ id, reason: 'r' });

    const sug = db
      .prepare('SELECT status FROM suggestions WHERE id = ?')
      .get(id) as { status: string };
    expect(sug.status).toBe('dismissed');

    const sig = computeEvidenceSignature('stalled', { brief_id: 'BR-50' });
    const row = getPattern(db, 'stalled', sig);
    expect(row).toBeDefined();
    expect(row!.dismiss_count).toBe(1);
  });
});
