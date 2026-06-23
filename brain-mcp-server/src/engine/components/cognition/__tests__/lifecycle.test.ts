/**
 * Cognition lifecycle writer + one-terminal-event invariant tests (FR-118 M0).
 *
 * Covers:
 *   - writeExtractorEvent: row shape, component = cognition.<instance>, project hoist
 *   - DB error → no throw (defensive fallback to stderr)
 *   - makeRunEmitter: the ONE-TERMINAL-EVENT-PER-RUN invariant (TD-074)
 *
 * @module engine/components/cognition/__tests__/lifecycle.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  writeExtractorEvent,
  makeRunEmitter,
  componentName,
  eventName,
} from '../lifecycle.js';

function makeEventLogDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
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

interface Row {
  event_name: string;
  component: string;
  payload: string;
  project_slug: string | null;
}

function rows(db: Database.Database): Row[] {
  return db
    .prepare('SELECT event_name, component, payload, project_slug FROM event_log ORDER BY id')
    .all() as Row[];
}

describe('componentName / eventName', () => {
  it('namespaces the component per instance', () => {
    expect(componentName('perception')).toBe('cognition.perception');
    expect(componentName('subconscious')).toBe('cognition.subconscious');
    expect(eventName('perception', 'run_started')).toBe('cognition.perception.run_started');
  });
});

describe('writeExtractorEvent', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeEventLogDb();
  });
  afterEach(() => db.close());

  it('writes a row with component=cognition.<instance> and hoists project', () => {
    writeExtractorEvent(db, 'perception', 'run_started', { project: 'demo', foo: 1 });
    const [r] = rows(db);
    expect(r.event_name).toBe('cognition.perception.run_started');
    expect(r.component).toBe('cognition.perception');
    expect(r.project_slug).toBe('demo');
    expect(JSON.parse(r.payload)).toMatchObject({ project: 'demo', foo: 1 });
  });

  it('varies the component column per instance id', () => {
    writeExtractorEvent(db, 'perception', 'run_started', {});
    writeExtractorEvent(db, 'subconscious', 'run_started', {});
    writeExtractorEvent(db, 'roadmap_drift', 'run_started', {});
    expect(rows(db).map((r) => r.component)).toEqual([
      'cognition.perception',
      'cognition.subconscious',
      'cognition.roadmap_drift',
    ]);
  });

  it('null project_slug when no project field', () => {
    writeExtractorEvent(db, 'perception', 'run_skipped', { reason: 'disabled' });
    expect(rows(db)[0].project_slug).toBeNull();
  });

  it('does NOT throw when the INSERT fails (defensive fallback)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    db.exec('DROP TABLE event_log');
    expect(() => writeExtractorEvent(db, 'perception', 'run_started', {})).not.toThrow();
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(String(stderrSpy.mock.calls[0][0])).toContain('[cognition.lifecycle] write failed');
    stderrSpy.mockRestore();
  });
});

describe('makeRunEmitter — one-terminal-event-per-run invariant (TD-074)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeEventLogDb();
  });
  afterEach(() => db.close());

  it('writes run_started then exactly one terminal event', () => {
    const e = makeRunEmitter(db, 'perception', { project: 'demo', trigger: 'cron' });
    e.emit('run_started', {});
    e.emit('run_succeeded', { persisted: 3 });
    const all = rows(db);
    expect(all.map((r) => r.event_name)).toEqual([
      'cognition.perception.run_started',
      'cognition.perception.run_succeeded',
    ]);
    // base fields stamped on every event
    expect(JSON.parse(all[1].payload)).toMatchObject({ project: 'demo', trigger: 'cron', persisted: 3 });
    expect(JSON.parse(all[1].payload).duration_ms).toBeTypeOf('number');
  });

  it('SUPPRESSES a trailing terminal event after the first (pre-emitted failure wins)', () => {
    const e = makeRunEmitter(db, 'subconscious');
    e.emit('run_started', {});
    e.emit('run_failed', { reason: 'timeout' }); // backend pre-emits failure
    e.emit('run_succeeded', { persisted: 1 }); // engine's trailing success — SUPPRESSED
    expect(e.terminalEmitted).toBe(true);
    const names = rows(db).map((r) => r.event_name);
    expect(names).toEqual([
      'cognition.subconscious.run_started',
      'cognition.subconscious.run_failed',
    ]);
    // the suppressed success never lands
    expect(names).not.toContain('cognition.subconscious.run_succeeded');
  });

  it('treats run_skipped as terminal (suppresses any later terminal)', () => {
    const e = makeRunEmitter(db, 'perception');
    e.emit('run_skipped', { reason: 'budget' });
    e.emit('run_failed', { reason: 'timeout' }); // suppressed
    expect(rows(db).map((r) => r.event_name)).toEqual(['cognition.perception.run_skipped']);
  });

  it('allows run_started even if it is called after a terminal (non-terminal never suppressed)', () => {
    const e = makeRunEmitter(db, 'perception');
    e.emit('run_skipped', { reason: 'disabled' });
    e.emit('run_started', {}); // non-terminal — still written
    expect(rows(db).map((r) => r.event_name)).toEqual([
      'cognition.perception.run_skipped',
      'cognition.perception.run_started',
    ]);
  });
});
