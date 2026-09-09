/**
 * Dismiss-Reason Learning Loop — unit tests
 *
 * Covers the FR-106 (Q3=B) dismiss-loop bookkeeping that survives FR-118 M4b
 * (the rule-detector pipeline `runAllDetectors` is gone; the dismiss-loop
 * record/signature helpers stay live — the LLM subconscious instance reuses
 * `computeEvidenceSignature` for its pre-insert suppression check):
 *   (a) Dismiss with reason -> dismissed_patterns row, dismiss_count=1.
 *   (b) Dismiss same signature again -> dismiss_count=2, reasons appended.
 *   (c) >5 dismisses -> reasons array capped at the last 5.
 *
 * The detector-pipeline-driven suppression scenarios (new candidate suppressed
 * when dismiss_count >= 2 / cooldown windows / end-to-end re-run) were deleted
 * with `runAllDetectors` in M4b — the rule path that generated those candidates
 * no longer exists. The suppression DECISION itself is now exercised through the
 * subconscious instance's persist path (see cognition/extractors/subconscious).
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
} from '../runner.js';
import { subconsciousMigrations } from '../schema.js';
import { entityKey, findingKey } from '../finding-key.js';
import { applyDismissExisting } from '../actions/kinds.js';
import { isSuppressedByDismissal } from '../runner.js';
import { DEFAULT_DETECTOR_CONFIG, type SuggestionCandidate } from '../types.js';
import { createEventBus } from '../../../bus.js';
import { applyMinimalSchema } from './fixtures/minimal-schema.js';

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
  const candidate: SuggestionCandidate = {
    source_module,
    project_slug,
    title,
    evidence,
    priority: 'medium',
  };
  const result = db
    .prepare(
      `INSERT INTO suggestions
         (source_module, project_slug, title, evidence, priority, status,
          dedupe_key, entity_key, source_instance)
       VALUES (?, ?, ?, ?, 'medium', 'pending', ?, ?, 'subconscious')`,
    )
    .run(
      source_module,
      project_slug,
      title,
      JSON.stringify(evidence),
      findingKey(candidate),
      entityKey(candidate),
    );
  return Number(result.lastInsertRowid);
}

/** The key a dismiss pattern is filed under since TD-440. */
function keyOf(
  source_module: string,
  title: string,
  evidence: Record<string, unknown>,
  project_slug: string | null = 'p1',
): string {
  return findingKey({ source_module, project_slug, title, evidence, priority: 'medium' });
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

    // TD-440 — filed under the PRODUCER and the FINDING KEY. The old key began
    // with `source_module`, which the model re-invents every run, so a
    // re-emission under a fresh label was a different key and the loop could
    // never fire on the rows that most needed it.
    const row = getPattern(db, 'subconscious', keyOf('stalled', 'TD-005 stalled', {
      brief_id: 'TD-005',
    }));
    expect(row).toBeDefined();
    expect(row!.dismiss_count).toBe(1);
    expect(JSON.parse(row!.reasons)).toEqual(['noise']);
  });

  it('files the pattern under the PRODUCER, not the LLM label', () => {
    const id = insertPending(db, 'a_label_the_model_invented', 'BR-9 is stalled 40 days', {
      brief_id: 'BR-9',
    });
    handleSuggestionDismiss({ id, reason: 'noise' });

    const all = db
      .prepare(`SELECT source_module FROM dismissed_patterns`)
      .all() as { source_module: string }[];
    expect(all).toHaveLength(1);
    expect(all[0]!.source_module).toBe('subconscious');
  });

  // -----------------------------------------------------------------------
  // (b) Repeated dismiss -> dismiss_count++ and reasons append
  // -----------------------------------------------------------------------

  it('increments dismiss_count and appends reasons on repeat dismisses', () => {
    const title = 'TD-1 has been In Progress for 40 days';
    // Two independent dismisses of the SAME finding under DIFFERENT labels —
    // which is the case the old key could not collapse and the new one must.
    for (const [label, reason] of [
      ['stalled', 'too-noisy'],
      ['dormant_work_item', 'wrong-priority'],
    ]) {
      const id = insertPending(db, label!, title, { brief_id: 'TD-1' });
      handleSuggestionDismiss({ id, reason });
    }
    const row = getPattern(db, 'subconscious', keyOf('stalled', title, { brief_id: 'TD-1' }));
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
  // Verify the dismiss handler also wrote to dismissed_patterns
  // -----------------------------------------------------------------------

  it('dismiss handler invokes recordDismissPattern within a single transaction', () => {
    const id = insertPending(db, 'stalled', 'X', { brief_id: 'BR-50' });
    handleSuggestionDismiss({ id, reason: 'r' });

    const sug = db
      .prepare('SELECT status FROM suggestions WHERE id = ?')
      .get(id) as { status: string };
    expect(sug.status).toBe('dismissed');

    const row = getPattern(db, 'subconscious', keyOf('stalled', 'X', { brief_id: 'BR-50' }));
    expect(row).toBeDefined();
    expect(row!.dismiss_count).toBe(1);
  });

  // -----------------------------------------------------------------------
  // TD-440 — THE READ SIDE. Until this brief the loop was write-only: nothing
  // anywhere SELECTed `dismissed_patterns` to suppress a candidate, and
  // `dismiss_suppress_count` / `dismiss_cooldown_days` were read by no code at
  // all, while three documents asserted the policy was live.
  // -----------------------------------------------------------------------

  describe('isSuppressedByDismissal — the half that never existed', () => {
    const KEY = 'a-stable-finding-key';

    it('is armed: an UNKNOWN key is never suppressed', () => {
      // The negative control. Without it every assertion below could pass on a
      // function that returns `true` unconditionally.
      expect(isSuppressedByDismissal(db, 'subconscious', 'p1', KEY)).toBe(false);
    });

    it('suppresses a single dismissal for the cooldown window', () => {
      recordDismissPattern(db, 'subconscious', 'p1', KEY, 'noise');
      expect(isSuppressedByDismissal(db, 'subconscious', 'p1', KEY)).toBe(true);
    });

    it('allows it back once the cooldown has passed', () => {
      recordDismissPattern(db, 'subconscious', 'p1', KEY, 'noise');
      db.prepare(
        `UPDATE dismissed_patterns
            SET last_dismissed_at = datetime('now', ?)`,
      ).run(`-${DEFAULT_DETECTOR_CONFIG.dismiss_cooldown_days + 1} days`);
      expect(isSuppressedByDismissal(db, 'subconscious', 'p1', KEY)).toBe(false);
    });

    it('suppresses PERMANENTLY at dismiss_suppress_count, cooldown or not', () => {
      for (let i = 0; i < DEFAULT_DETECTOR_CONFIG.dismiss_suppress_count; i++) {
        recordDismissPattern(db, 'subconscious', 'p1', KEY, `r${i}`);
      }
      db.prepare(
        `UPDATE dismissed_patterns SET last_dismissed_at = datetime('now', '-365 days')`,
      ).run();
      expect(isSuppressedByDismissal(db, 'subconscious', 'p1', KEY)).toBe(true);
    });

    it('is scoped by producer AND project — a dismissal does not leak sideways', () => {
      recordDismissPattern(db, 'subconscious', 'p1', KEY, 'noise');
      expect(isSuppressedByDismissal(db, 'synapse', 'p1', KEY)).toBe(false);
      expect(isSuppressedByDismissal(db, 'subconscious', 'p2', KEY)).toBe(false);
      expect(isSuppressedByDismissal(db, 'subconscious', null, KEY)).toBe(false);
    });

    it('a null project_slug round-trips through the empty-string sentinel', () => {
      recordDismissPattern(db, 'subconscious', null, KEY, 'noise');
      expect(isSuppressedByDismissal(db, 'subconscious', null, KEY)).toBe(true);
    });

    it('degrades to false when the table is absent, rather than throwing', () => {
      const bare = new Database(':memory:');
      try {
        expect(isSuppressedByDismissal(bare, 'subconscious', 'p1', KEY)).toBe(false);
      } finally {
        bare.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // TD-440 — the SECOND dismiss writer. `applyDismissExisting` updated the row
  // and recorded nothing, so a suggestion the model itself superseded taught
  // the loop nothing and came straight back next run.
  // -----------------------------------------------------------------------

  describe('applyDismissExisting also records (the two-writers-one-recorder gap)', () => {
    it('files a dismiss pattern under the same key as the MCP handler', () => {
      const id = insertPending(db, 'stalled', 'BR-77 is stalled 40 days', {
        brief_id: 'BR-77',
      });
      const result = applyDismissExisting(db, { suggestion_id: id });
      expect(result.ok).toBe(true);

      const key = keyOf('stalled', 'BR-77 is stalled 40 days', { brief_id: 'BR-77' });
      const row = getPattern(db, 'subconscious', key);
      expect(row).toBeDefined();
      expect(row!.dismiss_count).toBe(1);
      // ...and the loop now refuses the re-emission.
      expect(isSuppressedByDismissal(db, 'subconscious', 'p1', key)).toBe(true);
    });

    it('the two writers land on ONE row rather than two', () => {
      const title = 'BR-78 is stalled 40 days';
      const evidence = { brief_id: 'BR-78' };
      applyDismissExisting(db, {
        suggestion_id: insertPending(db, 'stalled', title, evidence),
      });
      handleSuggestionDismiss({
        id: insertPending(db, 'dormant_work_item', title, evidence),
        reason: 'noise',
      });

      const row = getPattern(db, 'subconscious', keyOf('stalled', title, evidence));
      expect(row).toBeDefined();
      expect(row!.dismiss_count).toBe(2);
    });
  });
});
