/**
 * Subconscious Integrity Tests
 *
 * Three distinct invariants:
 *   1. ReadOnlyDb rejection — non-SELECT/WITH SQL throws at prepare().
 *      Includes leading-comment stripping (TD-053 Nit 2) and CTE-then-DML
 *      rejection (TD-053 Nit 1).
 *   2. Detector data_version invariant — running every detector via
 *      `runAllDetectors` does NOT mutate any pre-existing table. The
 *      runner DOES write to `suggestions` (and `dismissed_patterns` on
 *      dismiss), so we measure data_version BEFORE the run, then
 *      explicitly exclude the suggestions/dismissed_patterns tables by
 *      reading their counts and re-running with the runner skipped:
 *      we measure invariance by sandwiching the detector phase only.
 *   3. Bootstrap-failure observability (TD-053 Nit 4) — a rejected
 *      `igris_schedule_create` dispatch fires
 *      `subconscious.bootstrap_failed` so the monitoring component can
 *      log it.
 *
 * Approach for #2: detectors are pure functions that take a
 * `ReadOnlyDb`. We invoke them directly (not through `runAllDetectors`
 * which writes), wrap the bare `Database` in `makeReadOnlyDb`, then
 * compare `data_version` before and after. This is the strongest form
 * of the invariant — the detectors themselves never mutate.
 *
 * @module engine/components/subconscious/__tests__/integrity.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Mock db so `ensureScheduleExists()` reads our test database when the
// subconscious component checks whether `subconscious_engine` already
// exists. Only used by the "bootstrap-failure observability" group; the
// other groups construct `Database` instances directly and never touch
// `getDb()`.
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import { createEventBus } from '../../../bus.js';
import { createSubconsciousComponent } from '../index.js';
import type {
  ComponentContext,
  ComponentLogger,
  EventBus,
  EventPayload,
} from '../../../types.js';

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

    // -----------------------------------------------------------------------
    // CTE-then-DML rejection (TD-053 Nit 1)
    // -----------------------------------------------------------------------

    it('rejects WITH ... DELETE (CTE-then-DML)', () => {
      const ro = makeReadOnlyDb(db);
      expect(() =>
        ro.prepare('WITH cte AS (SELECT 1) DELETE FROM suggestions'),
      ).toThrow(/CTE-then-DML SQL rejected/);
    });

    it('rejects WITH ... INSERT (CTE-then-DML)', () => {
      const ro = makeReadOnlyDb(db);
      expect(() =>
        ro.prepare(
          "WITH cte AS (SELECT 1 AS x) INSERT INTO suggestions (project_slug, title, summary, evidence_json, source_module, evidence_signature, priority) VALUES ('p', 't', 's', '{}', 'stalled', 'sig', 'low')",
        ),
      ).toThrow(/CTE-then-DML SQL rejected/);
    });

    it('rejects WITH ... UPDATE (CTE-then-DML)', () => {
      const ro = makeReadOnlyDb(db);
      expect(() =>
        ro.prepare("WITH cte AS (SELECT 1) UPDATE suggestions SET status = 'dismissed'"),
      ).toThrow(/CTE-then-DML SQL rejected/);
    });

    it('does NOT reject WITH ... SELECT when CTE name contains "deleted" (word-boundary)', () => {
      const ro = makeReadOnlyDb(db);
      // Identifier `is_deleted` must NOT trigger CTE-DML rejection — only
      // the bare DML keywords as whole words should match.
      expect(() =>
        ro.prepare(
          'WITH is_deleted AS (SELECT id FROM suggestions WHERE 1 = 0) SELECT * FROM is_deleted',
        ),
      ).not.toThrow();
    });

    // -----------------------------------------------------------------------
    // Leading SQL comments stripped before whitelist (TD-053 Nit 2)
    // -----------------------------------------------------------------------

    it('accepts SELECT preceded by a block comment', () => {
      const ro = makeReadOnlyDb(db);
      expect(() => ro.prepare('/* note */ SELECT 1 AS x')).not.toThrow();
    });

    it('accepts SELECT preceded by a line comment', () => {
      const ro = makeReadOnlyDb(db);
      expect(() => ro.prepare('-- line comment\nSELECT 1 AS x')).not.toThrow();
    });

    it('accepts SELECT preceded by multiple block comments', () => {
      const ro = makeReadOnlyDb(db);
      expect(() => ro.prepare('/* foo */ /* bar */ SELECT 1 AS x')).not.toThrow();
    });

    it('rejects DML hidden behind a leading block comment', () => {
      const ro = makeReadOnlyDb(db);
      expect(() => ro.prepare('/* foo */ DELETE FROM suggestions')).toThrow(
        /non-SELECT\/WITH SQL rejected/,
      );
    });

    it('rejects WITH ... DELETE behind a leading block comment (Nit 1 + Nit 2 interaction)', () => {
      const ro = makeReadOnlyDb(db);
      expect(() =>
        ro.prepare('/* foo */ WITH cte AS (SELECT 1) DELETE FROM suggestions'),
      ).toThrow(/CTE-then-DML SQL rejected/);
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

// ---------------------------------------------------------------------------
// Bootstrap-failure observability (TD-053 Nit 4)
// ---------------------------------------------------------------------------

/**
 * The subconscious component dispatches `igris_schedule_create` from
 * `engine.ready`. When that dispatch rejects (e.g. schedules component
 * not loaded, daemon offline), the warn-log alone is invisible to
 * monitoring. We expect a `subconscious.bootstrap_failed` event so the
 * event_log row gets written.
 */

function makeLogger(): ComponentLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeCtx(bus: EventBus): ComponentContext {
  return {
    storage: {} as ComponentContext['storage'],
    bus,
    log: makeLogger(),
    config: {},
  };
}

/**
 * Build a DB with just the columns the bootstrap path inspects on
 * `schedules`. The component only reads `id WHERE name = ?` so the
 * minimal column set is fine.
 */
function makeBootstrapDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );
  `);
  return db;
}

describe('subconscious bootstrap-failure observability', () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeBootstrapDb();
    bus = createEventBus();
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('emits subconscious.bootstrap_failed when igris_schedule_create rejects', async () => {
    const captured: EventPayload[] = [];
    bus.on('subconscious.bootstrap_failed', (payload) => {
      captured.push(payload);
    });

    const dispatch = vi.fn().mockRejectedValue(new Error('schedules unavailable'));

    const comp = createSubconsciousComponent();
    comp.init(makeCtx(bus));

    bus.emit('engine.ready', { dispatch });

    // The component fires `void ensureScheduleExists()` which awaits the
    // mocked dispatch. Wait one microtask cycle for the rejection to
    // propagate into the catch block and the bus.emit to fire.
    await new Promise((r) => setImmediate(r));

    expect(dispatch).toHaveBeenCalledWith(
      'igris_schedule_create',
      expect.objectContaining({ name: 'subconscious_engine' }),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].event).toBe('subconscious.bootstrap_failed');
    expect(captured[0].data.error_message).toBe('schedules unavailable');

    comp.destroy();
  });

  it('does NOT emit subconscious.bootstrap_failed on successful dispatch', async () => {
    const captured: EventPayload[] = [];
    bus.on('subconscious.bootstrap_failed', (payload) => {
      captured.push(payload);
    });

    const dispatch = vi.fn().mockResolvedValue({});

    const comp = createSubconsciousComponent();
    comp.init(makeCtx(bus));

    bus.emit('engine.ready', { dispatch });

    await new Promise((r) => setImmediate(r));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);

    comp.destroy();
  });
});
