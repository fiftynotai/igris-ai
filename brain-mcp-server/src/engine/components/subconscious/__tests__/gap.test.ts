/**
 * Gap Detector — unit tests
 *
 * Covers both halves of the detector:
 *   - project-quiet (priority bands per FR-106 Concern 7)
 *   - done-with-unchecked-AC (always high)
 * Plus the graceful-failure path when dependent tables are missing.
 *
 * @module engine/components/subconscious/__tests__/gap.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { detectGap } from '../detectors/gap.js';
import { makeReadOnlyDb } from '../readonly-db.js';
import { DEFAULT_DETECTOR_CONFIG } from '../types.js';
import {
  applyMinimalSchema,
  seedBrief,
  seedBriefFile,
  seedLearning,
  seedProject,
} from './fixtures/minimal-schema.js';

describe('detectGap — project quiet', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMinimalSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns no project-quiet entries when all projects are active', () => {
    seedProject(db, { slug: 'p1', registered_days_ago: 10 });
    seedLearning(db, { project: 'p1', title: 'recent', created_days_ago: 5 });
    const result = detectGap(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result.filter((s) => (s.evidence as Record<string, unknown>).gap_kind === 'project_quiet'))
      .toHaveLength(0);
  });

  it('emits medium when activity is 95 days old', () => {
    seedProject(db, { slug: 'sleepy', registered_days_ago: 200 });
    seedLearning(db, { project: 'sleepy', title: 'old', created_days_ago: 95 });
    const result = detectGap(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBe('medium');
    expect((result[0].evidence as Record<string, unknown>).gap_kind).toBe('project_quiet');
    expect(result[0].project_slug).toBe('sleepy');
  });

  it('emits high when activity is 200 days old', () => {
    seedProject(db, { slug: 'frozen', registered_days_ago: 300 });
    seedLearning(db, { project: 'frozen', title: 'ancient', created_days_ago: 200 });
    const result = detectGap(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    const hit = result.find((s) => s.project_slug === 'frozen');
    expect(hit).toBeDefined();
    expect(hit!.priority).toBe('high');
  });

  it('uses brief_status updated_at when no learnings exist', () => {
    seedProject(db, { slug: 'just-briefs', registered_days_ago: 200 });
    seedBrief(db, {
      project: 'just-briefs',
      brief_id: 'BR-1',
      status: 'Ready',
      updated_days_ago: 100,
    });
    const result = detectGap(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result.find((s) => s.project_slug === 'just-briefs')).toBeDefined();
  });

  it('skips archived projects', () => {
    seedProject(db, { slug: 'shelved', status: 'archived', registered_days_ago: 400 });
    seedLearning(db, { project: 'shelved', title: 'x', created_days_ago: 300 });
    const result = detectGap(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result.find((s) => s.project_slug === 'shelved')).toBeUndefined();
  });

  it('excludes recently active projects below the medium threshold', () => {
    seedProject(db, { slug: 'busy', registered_days_ago: 50 });
    seedLearning(db, { project: 'busy', title: 'recent', created_days_ago: 30 });
    const result = detectGap(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(result.find((s) => s.project_slug === 'busy')).toBeUndefined();
  });
});

describe('detectGap — done with unchecked AC', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMinimalSchema(db);
    seedProject(db, { slug: 'p1' });
  });

  afterEach(() => {
    db.close();
  });

  it('emits high for Done brief with unchecked AC', () => {
    seedBrief(db, {
      project: 'p1',
      brief_id: 'BR-100',
      status: 'Done',
      updated_days_ago: 1,
    });
    seedBriefFile(db, {
      project: 'p1',
      brief_id: 'BR-100',
      content: '# Brief\n\n## Acceptance\n- [x] Done thing\n- [ ] Forgot this',
    });
    const result = detectGap(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    const hit = result.find(
      (s) => (s.evidence as Record<string, unknown>).gap_kind === 'done_with_unchecked',
    );
    expect(hit).toBeDefined();
    expect(hit!.priority).toBe('high');
    expect((hit!.evidence as Record<string, unknown>).brief_id).toBe('BR-100');
  });

  it('does not emit when all AC are checked', () => {
    seedBrief(db, {
      project: 'p1',
      brief_id: 'BR-101',
      status: 'Done',
      updated_days_ago: 1,
    });
    seedBriefFile(db, {
      project: 'p1',
      brief_id: 'BR-101',
      content: '- [x] Thing\n- [x] Other',
    });
    const result = detectGap(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(
      result.find(
        (s) => (s.evidence as Record<string, unknown>).gap_kind === 'done_with_unchecked',
      ),
    ).toBeUndefined();
  });

  it('does not emit for non-terminal briefs even if AC is unchecked', () => {
    seedBrief(db, {
      project: 'p1',
      brief_id: 'BR-102',
      status: 'In Progress',
      updated_days_ago: 1,
    });
    seedBriefFile(db, {
      project: 'p1',
      brief_id: 'BR-102',
      content: '- [ ] Not done yet',
    });
    const result = detectGap(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    expect(
      result.find(
        (s) => (s.evidence as Record<string, unknown>).gap_kind === 'done_with_unchecked',
      ),
    ).toBeUndefined();
  });

  it('also matches Archived status with unchecked AC', () => {
    seedBrief(db, {
      project: 'p1',
      brief_id: 'BR-103',
      status: 'Archived',
      updated_days_ago: 1,
    });
    seedBriefFile(db, {
      project: 'p1',
      brief_id: 'BR-103',
      content: '- [ ] Forgot',
    });
    const result = detectGap(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
    const hit = result.find(
      (s) => (s.evidence as Record<string, unknown>).brief_id === 'BR-103',
    );
    expect(hit).toBeDefined();
  });
});

describe('detectGap — graceful failure', () => {
  it('returns [] when none of the dependent tables exist', () => {
    const empty = new Database(':memory:');
    try {
      const result = detectGap(makeReadOnlyDb(empty), DEFAULT_DETECTOR_CONFIG);
      expect(result).toEqual([]);
    } finally {
      empty.close();
    }
  });
});
