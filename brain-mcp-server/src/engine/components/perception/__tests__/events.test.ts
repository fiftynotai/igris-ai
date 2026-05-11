/**
 * Perception lifecycle events writer tests (TD-074).
 *
 * Covers:
 *   - INSERT shape mirrors monitoring.onEventReceived columns
 *   - payload.project hoisted into project_slug column
 *   - DB error → no throw (defensive fallback to stderr)
 *   - Successive writes accumulate as separate event_log rows
 *
 * Uses in-memory SQLite with the same column shape monitoring/schema.ts
 * defines, so the test exercises the real INSERT path.
 *
 * @module engine/components/perception/__tests__/events.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { writePerceptionEvent } from '../events.js';

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

interface EventLogRow {
  event_name: string;
  component: string;
  payload: string;
  machine_hostname: string | null;
  project_slug: string | null;
  instance_id: string | null;
  created_at: string;
}

describe('writePerceptionEvent', () => {
  let db: Database.Database;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = makeEventLogDb();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('writes a row with the same column shape as monitoring.onEventReceived', () => {
    writePerceptionEvent(db, 'perception.run_started', {
      project: 'igris-ai',
      transcript_bytes: 4096,
      source: 'session_end',
      trigger: 'detached',
    });

    const row = db.prepare('SELECT * FROM event_log LIMIT 1').get() as EventLogRow;
    expect(row.event_name).toBe('perception.run_started');
    expect(row.component).toBe('perception');
    expect(row.machine_hostname).toBeTypeOf('string');
    expect(row.machine_hostname?.length).toBeGreaterThan(0);
    expect(row.instance_id).toBeNull();
    expect(row.created_at).toBeTypeOf('string');
  });

  it('hoists payload.project into the project_slug column', () => {
    writePerceptionEvent(db, 'perception.run_succeeded', {
      project: 'igris-ai',
      candidates_count: 3,
    });

    const row = db.prepare('SELECT project_slug, payload FROM event_log LIMIT 1').get() as EventLogRow;
    expect(row.project_slug).toBe('igris-ai');
    // Payload still carries the project key — the hoist is a column mirror,
    // not a key strip.
    expect(JSON.parse(row.payload)).toMatchObject({
      project: 'igris-ai',
      candidates_count: 3,
    });
  });

  it('uses NULL project_slug when payload.project is absent or non-string', () => {
    writePerceptionEvent(db, 'perception.run_failed', {
      reason: 'unknown',
    });
    writePerceptionEvent(db, 'perception.run_failed', {
      project: 12345 as unknown as string, // wrong type
      reason: 'unknown',
    });

    const rows = db
      .prepare('SELECT project_slug FROM event_log ORDER BY id ASC')
      .all() as { project_slug: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].project_slug).toBeNull();
    expect(rows[1].project_slug).toBeNull();
  });

  it('serializes the full payload as JSON', () => {
    writePerceptionEvent(db, 'perception.run_failed', {
      project: 'igris-ai',
      reason: 'epipe_on_llm_stdin',
      error_message: 'write EPIPE',
      prompt_bytes: 262144,
    });

    const row = db.prepare('SELECT payload FROM event_log LIMIT 1').get() as { payload: string };
    const parsed = JSON.parse(row.payload);
    expect(parsed).toEqual({
      project: 'igris-ai',
      reason: 'epipe_on_llm_stdin',
      error_message: 'write EPIPE',
      prompt_bytes: 262144,
    });
  });

  it('accumulates multiple writes as separate rows', () => {
    writePerceptionEvent(db, 'perception.run_started', { project: 'p' });
    writePerceptionEvent(db, 'perception.run_succeeded', {
      project: 'p',
      candidates_count: 1,
    });

    const count = db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number };
    expect(count.n).toBe(2);

    const names = db
      .prepare('SELECT event_name FROM event_log ORDER BY id ASC')
      .all() as { event_name: string }[];
    expect(names.map((r) => r.event_name)).toEqual([
      'perception.run_started',
      'perception.run_succeeded',
    ]);
  });

  it('does NOT throw when the event_log table is missing', () => {
    const brokenDb = new Database(':memory:');
    try {
      // No CREATE TABLE — INSERT will fail.
      expect(() =>
        writePerceptionEvent(brokenDb, 'perception.run_started', { project: 'p' }),
      ).not.toThrow();

      // Stderr fallback line was written.
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const call = stderrSpy.mock.calls[0][0] as string;
      expect(call).toContain('[perception.events] write failed for perception.run_started');
      expect(call).toContain('payload=');
    } finally {
      brokenDb.close();
    }
  });

  it('does NOT throw when the DB handle is closed mid-flight', () => {
    db.close();
    expect(() =>
      writePerceptionEvent(db, 'perception.run_failed', { project: 'p', reason: 'unknown' }),
    ).not.toThrow();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('writes all four lifecycle event names without DDL friction', () => {
    writePerceptionEvent(db, 'perception.run_started', { project: 'p' });
    writePerceptionEvent(db, 'perception.run_succeeded', { project: 'p' });
    writePerceptionEvent(db, 'perception.run_failed', { project: 'p', reason: 'timeout' });
    writePerceptionEvent(db, 'perception.run_skipped', {
      project: 'p',
      reason: 'min_window_guard',
    });

    const rows = db
      .prepare('SELECT event_name, component FROM event_log ORDER BY id ASC')
      .all() as { event_name: string; component: string }[];
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.component).toBe('perception');
    }
    expect(rows.map((r) => r.event_name)).toEqual([
      'perception.run_started',
      'perception.run_succeeded',
      'perception.run_failed',
      'perception.run_skipped',
    ]);
  });
});
