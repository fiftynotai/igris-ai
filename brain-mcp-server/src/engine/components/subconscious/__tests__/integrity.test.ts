/**
 * Subconscious Integrity Tests
 *
 * Two distinct invariants:
 *   1. ReadOnlyDb rejection — non-SELECT/WITH SQL throws at prepare().
 *   2. Detector data_version invariant — running every detector via
 *      `runAllDetectors` does NOT mutate any pre-existing table. The
 *      runner DOES write to `suggestions` (and `dismissed_patterns` on
 *      dismiss), so we measure data_version BEFORE the run, then
 *      explicitly exclude the suggestions/dismissed_patterns tables by
 *      reading their counts and re-running with the runner skipped:
 *      we measure invariance by sandwiching the detector phase only.
 *
 * Approach for #2: detectors are pure functions that take a
 * `ReadOnlyDb`. We invoke them directly (not through `runAllDetectors`
 * which writes), wrap the bare `Database` in `makeReadOnlyDb`, then
 * compare `data_version` before and after. This is the strongest form
 * of the invariant — the detectors themselves never mutate.
 *
 * @module engine/components/subconscious/__tests__/integrity.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { detectStalled } from '../detectors/stalled.js';
import { detectGap } from '../detectors/gap.js';
import { detectConflict } from '../detectors/conflict.js';
import { detectPattern } from '../detectors/pattern.js';
import { makeReadOnlyDb } from '../readonly-db.js';
import { DEFAULT_DETECTOR_CONFIG } from '../types.js';
import { subconsciousMigrations } from '../schema.js';
import {
  applyMinimalSchema,
  seedBrief,
  seedBriefFile,
  seedLearning,
  seedProject,
} from './fixtures/minimal-schema.js';

function makeFullTestDb(): Database.Database {
  const db = new Database(':memory:');
  applyMinimalSchema(db);
  for (const m of subconsciousMigrations) db.exec(m.sql);

  // Seed a realistic-ish fixture so the detectors actually do work.
  seedProject(db, { slug: 'p1', registered_days_ago: 200 });
  seedProject(db, { slug: 'p2', registered_days_ago: 50 });
  seedLearning(db, { project: 'p2', title: 'recent', created_days_ago: 5 });
  seedBrief(db, {
    project: 'p2',
    brief_id: 'BR-1',
    status: 'In Progress',
    updated_days_ago: 35,
  });
  seedBrief(db, {
    project: 'p2',
    brief_id: 'BR-2',
    status: 'Done',
    updated_days_ago: 2,
  });
  seedBriefFile(db, {
    project: 'p2',
    brief_id: 'BR-2',
    content: 'Body\n- [ ] forgot one',
  });
  return db;
}

function dataVersion(db: Database.Database): number {
  const row = db.prepare('PRAGMA data_version').get() as { data_version: number };
  return row.data_version;
}

describe('subconscious integrity', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeFullTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // ReadOnlyDb rejection
  // -----------------------------------------------------------------------

  describe('ReadOnlyDb rejection', () => {
    it('rejects INSERT', () => {
      const ro = makeReadOnlyDb(db);
      expect(() => ro.prepare('INSERT INTO projects (slug, name, path) VALUES (?, ?, ?)'))
        .toThrow(/non-SELECT\/WITH SQL rejected/);
    });

    it('rejects UPDATE', () => {
      const ro = makeReadOnlyDb(db);
      expect(() => ro.prepare('UPDATE projects SET name = ?')).toThrow(/non-SELECT\/WITH/);
    });

    it('rejects DELETE', () => {
      const ro = makeReadOnlyDb(db);
      expect(() => ro.prepare('DELETE FROM projects')).toThrow(/non-SELECT\/WITH/);
    });

    it('rejects DROP', () => {
      const ro = makeReadOnlyDb(db);
      expect(() => ro.prepare('DROP TABLE projects')).toThrow(/non-SELECT\/WITH/);
    });

    it('rejects PRAGMA writes', () => {
      const ro = makeReadOnlyDb(db);
      expect(() => ro.prepare('PRAGMA user_version = 7')).toThrow(/non-SELECT\/WITH/);
    });

    it('accepts SELECT', () => {
      const ro = makeReadOnlyDb(db);
      const stmt = ro.prepare('SELECT 1 AS x');
      expect((stmt.get() as { x: number }).x).toBe(1);
    });

    it('accepts WITH (CTE)', () => {
      const ro = makeReadOnlyDb(db);
      const rows = ro.prepare(
        'WITH cte AS (SELECT slug FROM projects) SELECT * FROM cte',
      ).all();
      expect(Array.isArray(rows)).toBe(true);
    });

    it('accepts case-insensitive SELECT/WITH', () => {
      const ro = makeReadOnlyDb(db);
      expect(() => ro.prepare('  Select 1')).not.toThrow();
      expect(() => ro.prepare('\n\twith x as (select 1) select * from x')).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Detector data_version invariance
  // -----------------------------------------------------------------------

  describe('detector data_version invariance', () => {
    it('detectStalled does not change data_version', () => {
      const before = dataVersion(db);
      detectStalled(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
      const after = dataVersion(db);
      expect(after).toBe(before);
    });

    it('detectGap does not change data_version', () => {
      const before = dataVersion(db);
      detectGap(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
      const after = dataVersion(db);
      expect(after).toBe(before);
    });

    it('detectConflict does not change data_version', () => {
      const before = dataVersion(db);
      detectConflict(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
      const after = dataVersion(db);
      expect(after).toBe(before);
    });

    it('detectPattern does not change data_version', () => {
      const before = dataVersion(db);
      detectPattern(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
      const after = dataVersion(db);
      expect(after).toBe(before);
    });

    it('all detectors composed do not change data_version', () => {
      const before = dataVersion(db);
      detectStalled(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
      detectGap(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
      detectConflict(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
      detectPattern(makeReadOnlyDb(db), DEFAULT_DETECTOR_CONFIG);
      const after = dataVersion(db);
      expect(after).toBe(before);
    });
  });
});
