/**
 * Stalled Detector — unit tests
 *
 * Verifies the priority bands defined in FR-106 plan Concern 7:
 *   In Progress >30d -> high; 14-30d -> medium; <14d -> nothing.
 *   Ready       >60d -> high; 30-60d -> medium; <30d -> nothing.
 * Also verifies that terminal-status briefs (Done/Archived) are ignored
 * and that the detector tolerates a missing `brief_status` table.
 *
 * @module engine/components/subconscious/__tests__/stalled.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { detectStalled } from '../detectors/stalled.js';
import { makeReadOnlyDb } from '../readonly-db.js';
import { DEFAULT_DETECTOR_CONFIG } from '../types.js';
import { applyMinimalSchema, seedBrief, seedProject } from './fixtures/minimal-schema.js';

describe('detectStalled', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMinimalSchema(db);
    seedProject(db, { slug: 'igris-ai' });
  });

  afterEach(() => {
    db.close();
  });

  it('returns [] when no In Progress / Ready briefs exist', () => {
    seedBrief(db, { project: 'igris-ai', brief_id: 'BR-001', status: 'Done', updated_days_ago: 5 });
    const result = detectStalled(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toEqual([]);
  });

  it('returns [] when In Progress briefs are below the medium threshold', () => {
    seedBrief(db, {
      project: 'igris-ai',
      brief_id: 'BR-002',
      status: 'In Progress',
      updated_days_ago: 5,
    });
    const result = detectStalled(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toEqual([]);
  });

  it('emits medium for In Progress at 15 days', () => {
    seedBrief(db, {
      project: 'igris-ai',
      brief_id: 'BR-003',
      status: 'In Progress',
      updated_days_ago: 15,
    });
    const result = detectStalled(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBe('medium');
    expect(result[0].source_module).toBe('stalled');
    expect(result[0].project_slug).toBe('igris-ai');
    const evidence = result[0].evidence as Record<string, unknown>;
    expect(evidence.brief_id).toBe('BR-003');
    expect(evidence.status).toBe('In Progress');
  });

  it('emits high for In Progress at 35 days', () => {
    seedBrief(db, {
      project: 'igris-ai',
      brief_id: 'BR-004',
      status: 'In Progress',
      updated_days_ago: 35,
    });
    const result = detectStalled(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBe('high');
    expect(result[0].title).toMatch(/BR-004 stalled in In Progress for \d+ days/);
  });

  it('returns [] for Ready briefs below 30 days', () => {
    seedBrief(db, {
      project: 'igris-ai',
      brief_id: 'BR-005',
      status: 'Ready',
      updated_days_ago: 20,
    });
    const result = detectStalled(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toEqual([]);
  });

  it('emits medium for Ready at 45 days', () => {
    seedBrief(db, {
      project: 'igris-ai',
      brief_id: 'BR-006',
      status: 'Ready',
      updated_days_ago: 45,
    });
    const result = detectStalled(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBe('medium');
  });

  it('emits high for Ready at 65 days', () => {
    seedBrief(db, {
      project: 'igris-ai',
      brief_id: 'BR-007',
      status: 'Ready',
      updated_days_ago: 65,
    });
    const result = detectStalled(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBe('high');
  });

  it('ignores Done and Archived briefs entirely', () => {
    seedBrief(db, {
      project: 'igris-ai',
      brief_id: 'BR-008',
      status: 'Done',
      updated_days_ago: 100,
    });
    seedBrief(db, {
      project: 'igris-ai',
      brief_id: 'BR-009',
      status: 'Archived',
      updated_days_ago: 200,
    });
    const result = detectStalled(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toEqual([]);
  });

  it('respects custom config overrides', () => {
    seedBrief(db, {
      project: 'igris-ai',
      brief_id: 'BR-010',
      status: 'In Progress',
      updated_days_ago: 5,
    });
    const result = detectStalled(makeReadOnlyDb(db), {
      ...DEFAULT_DETECTOR_CONFIG,
      stalled_in_progress_medium_days: 3,
      stalled_in_progress_high_days: 10,
    });
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBe('medium');
  });

  it('returns [] when brief_status table does not exist (graceful)', () => {
    const emptyDb = new Database(':memory:');
    try {
      const result = detectStalled(makeReadOnlyDb(emptyDb), DEFAULT_DETECTOR_CONFIG);
      expect(result).toEqual([]);
    } finally {
      emptyDb.close();
    }
  });
});
