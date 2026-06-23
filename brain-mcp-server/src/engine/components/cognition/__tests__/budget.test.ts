/**
 * Cognition daily-budget gate tests (FR-118 M0).
 *
 * Covers:
 *   - counts today's run_started rows per instance
 *   - withinBudget flips at the boundary
 *   - manual + cron share ONE envelope (both write run_started, both counted)
 *   - budget ≤ 0 ⇒ unlimited
 *   - yesterday's runs do NOT count against today
 *
 * @module engine/components/cognition/__tests__/budget.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { evaluateBudget, countRunsToday } from '../budget.js';
import { eventName } from '../lifecycle.js';

function makeEventLogDb(): Database.Database {
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
  `);
  return db;
}

/** Insert N run_started rows for an instance at an optional created_at offset. */
function seedRuns(db: Database.Database, instanceId: string, n: number, when = "datetime('now')"): void {
  const name = eventName(instanceId, 'run_started');
  for (let i = 0; i < n; i += 1) {
    db.prepare(
      `INSERT INTO event_log (event_name, component, payload, created_at) VALUES (?, 'cognition', '{}', ${when})`,
    ).run(name);
  }
}

describe('countRunsToday', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeEventLogDb();
  });
  afterEach(() => db.close());

  it('counts only today, only this instance, only run_started', () => {
    seedRuns(db, 'subconscious', 3);
    seedRuns(db, 'perception', 2); // different instance — not counted
    // a terminal event for subconscious — not a run_started, not counted
    db.prepare(
      `INSERT INTO event_log (event_name, component, payload, created_at)
       VALUES (?, 'cognition', '{}', datetime('now'))`,
    ).run(eventName('subconscious', 'run_succeeded'));
    expect(countRunsToday(db, 'subconscious')).toBe(3);
    expect(countRunsToday(db, 'perception')).toBe(2);
  });

  it('does NOT count yesterday', () => {
    seedRuns(db, 'subconscious', 5, "datetime('now', '-1 day')");
    seedRuns(db, 'subconscious', 2); // today
    expect(countRunsToday(db, 'subconscious')).toBe(2);
  });

  it('returns 0 when event_log is absent (fail-open)', () => {
    db.exec('DROP TABLE event_log');
    expect(countRunsToday(db, 'subconscious')).toBe(0);
  });
});

describe('evaluateBudget', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeEventLogDb();
  });
  afterEach(() => db.close());

  it('is within budget below the cap and out of budget at the cap', () => {
    seedRuns(db, 'subconscious', 7);
    expect(evaluateBudget(db, 'subconscious', 8).withinBudget).toBe(true);
    seedRuns(db, 'subconscious', 1); // now 8 = budget
    const v = evaluateBudget(db, 'subconscious', 8);
    expect(v.withinBudget).toBe(false);
    expect(v.usedToday).toBe(8);
    expect(v.remaining).toBe(0);
  });

  it('manual + cron share ONE envelope (both are run_started rows)', () => {
    // 5 cron runs + 3 manual runs = 8 against a budget of 8 → exhausted
    seedRuns(db, 'subconscious', 5); // cron
    seedRuns(db, 'subconscious', 3); // manual
    expect(evaluateBudget(db, 'subconscious', 8).withinBudget).toBe(false);
  });

  it('budget ≤ 0 means unlimited', () => {
    seedRuns(db, 'subconscious', 1000);
    const v = evaluateBudget(db, 'subconscious', 0);
    expect(v.withinBudget).toBe(true);
    expect(v.remaining).toBe(Number.POSITIVE_INFINITY);
  });
});
