/**
 * Subconscious schema v3 migration test (FR-118 M2).
 *
 * The v3 migration REBUILDS the `suggestions` table to OPEN the source_module
 * CHECK and add `suggested_action` / `confidence` / `type_inferred`. This test
 * proves the rebuild is data-preserving:
 *   - old rule-emitted rows (the closed-enum source_modules) SURVIVE with
 *     `type_inferred=0`, NULL confidence, NULL suggested_action;
 *   - they remain listable + dismissable through the handlers after the rebuild;
 *   - the post-rebuild table ACCEPTS an open source_module the old CHECK forbade.
 *
 * @module engine/components/subconscious/__tests__/schema-v3-migration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { subconsciousMigrations } from '../schema.js';
import {
  handleSuggestionList,
  handleSuggestionDismiss,
  setHandlerContext,
} from '../handlers.js';
import { DEFAULT_DETECTOR_CONFIG, type Suggestion } from '../types.js';
import { createEventBus } from '../../../bus.js';
import { getDb } from '../../../../db.js';

vi.mock('../../../../db.js', () => ({ getDb: vi.fn() }));

const V1 = subconsciousMigrations.find((m) => m.version === 1)!;
const V2 = subconsciousMigrations.find((m) => m.version === 2)!;
const V3 = subconsciousMigrations.find((m) => m.version === 3)!;
const V4 = subconsciousMigrations.find((m) => m.version === 4)!;

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .all(name).length > 0
  );
}

/** Apply ONLY v1 + v2 (the pre-FR-118 schema). */
function applyPreV3(db: Database.Database): void {
  db.exec(V1.sql);
  db.exec(V2.sql);
}

function parse<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

describe('subconscious schema v3 rebuild (FR-118 M2)', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
    setHandlerContext({ bus: createEventBus(), config: DEFAULT_DETECTOR_CONFIG });
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('the pre-v3 table rejects an open source_module (sanity — the CHECK exists)', () => {
    applyPreV3(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO suggestions (source_module, title) VALUES ('llm_open_kind', 't')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
  });

  it('preserves old rule-emitted rows across the rebuild (type_inferred=0, NULL new cols)', () => {
    applyPreV3(db);
    // Seed the four legacy rule kinds.
    const seed = db.prepare(
      `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    seed.run('stalled', 'p1', 'BR-1 stalled', '{"brief_id":"BR-1"}', 'high', 'pending');
    seed.run('gap', 'p1', 'p1 quiet', '{"gap_kind":"project_quiet"}', 'medium', 'pending');
    seed.run('conflict', null, 'pair', '{"learning_ids":[1,2]}', 'low', 'dismissed');
    seed.run('pattern', 'p2', 'retry pattern', '{"pattern_key":"k"}', 'medium', 'acted');

    const before = db.prepare('SELECT COUNT(*) AS n FROM suggestions').get() as { n: number };
    expect(before.n).toBe(4);

    // Apply v3 (the rebuild).
    db.exec(V3.sql);

    const rows = db
      .prepare('SELECT * FROM suggestions ORDER BY id')
      .all() as Suggestion[];
    expect(rows).toHaveLength(4);

    // Every legacy row survives with type_inferred=0, NULL confidence/action.
    for (const r of rows) {
      expect(r.type_inferred).toBe(0);
      expect(r.confidence).toBeNull();
      expect(r.suggested_action).toBeNull();
    }
    // Field-by-field preservation on the first row.
    expect(rows[0].source_module).toBe('stalled');
    expect(rows[0].project_slug).toBe('p1');
    expect(rows[0].title).toBe('BR-1 stalled');
    expect(rows[0].priority).toBe('high');
    expect(rows[0].status).toBe('pending');
    // Status spread preserved.
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending', 'dismissed', 'acted']);
  });

  it('keeps surviving rows listable + dismissable after the rebuild', () => {
    applyPreV3(db);
    db.prepare(
      `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status)
       VALUES ('stalled', 'p1', 'BR-9 stalled', '{"brief_id":"BR-9"}', 'high', 'pending')`,
    ).run();
    db.exec(V3.sql);

    // Listable.
    const listed = parse<{ suggestions: Suggestion[]; total: number }>(
      handleSuggestionList({ status: 'pending' }),
    );
    expect(listed.total).toBe(1);
    expect(listed.suggestions[0].title).toBe('BR-9 stalled');
    const id = listed.suggestions[0].id;

    // Dismissable.
    const dismissed = parse<{ updated: boolean; suggestion: Suggestion }>(
      handleSuggestionDismiss({ id, reason: 'no longer relevant' }),
    );
    expect(dismissed.updated).toBe(true);
    expect(dismissed.suggestion.status).toBe('dismissed');

    // The dismiss-loop recorded the pattern (still active in M2).
    const dp = db
      .prepare('SELECT COUNT(*) AS n FROM dismissed_patterns')
      .get() as { n: number };
    expect(dp.n).toBe(1);
  });

  it('the rebuilt table ACCEPTS an open source_module + the new columns', () => {
    applyPreV3(db);
    db.exec(V3.sql);
    expect(() =>
      db
        .prepare(
          `INSERT INTO suggestions
             (source_module, project_slug, title, evidence, priority, status,
              confidence, suggested_action, type_inferred)
           VALUES ('scope_drift', 'p1', 'open kind', '{}', 'medium', 'pending',
                   0.7, '{"kind":"flag_for_review"}', 1)`,
        )
        .run(),
    ).not.toThrow();

    const row = db
      .prepare(`SELECT * FROM suggestions WHERE source_module = 'scope_drift'`)
      .get() as Suggestion;
    expect(row.type_inferred).toBe(1);
    expect(row.confidence).toBe(0.7);
    expect(row.suggested_action).toBe('{"kind":"flag_for_review"}');
  });

  it('preserves the priority + status CHECKs (only source_module opened)', () => {
    applyPreV3(db);
    db.exec(V3.sql);
    expect(() =>
      db.prepare(`INSERT INTO suggestions (source_module, title, priority) VALUES ('k','t','urgent')`).run(),
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      db.prepare(`INSERT INTO suggestions (source_module, title, status) VALUES ('k','t','weird')`).run(),
    ).toThrow(/CHECK constraint/i);
  });
});

describe('subconscious schema v4 drop (FR-118 M4b)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  /** Apply the full pre-v4 chain (v1 → v2 → v3). */
  function applyThroughV3(db: Database.Database): void {
    db.exec(V1.sql);
    db.exec(V2.sql);
    db.exec(V3.sql);
  }

  it('drops pattern_observations while leaving suggestions + dismissed_patterns intact', () => {
    applyThroughV3(db);
    // Sanity: the table the drop targets is present after v2.
    expect(tableExists(db, 'pattern_observations')).toBe(true);

    // Seed a row in each of the two tables that MUST survive the drop.
    db.prepare(
      `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status)
       VALUES ('scope_drift', 'p1', 'survives the drop', '{"k":1}', 'high', 'pending')`,
    ).run();
    db.prepare(
      `INSERT INTO dismissed_patterns
         (source_module, project_slug, evidence_signature, dismiss_count, last_dismissed_at, reasons)
       VALUES ('stalled', 'p1', 'brief:BR-1', 2, datetime('now'), '["noise"]')`,
    ).run();

    // Apply v4 (the drop).
    db.exec(V4.sql);

    // pattern_observations is gone.
    expect(tableExists(db, 'pattern_observations')).toBe(false);

    // suggestions + dismissed_patterns are untouched (table present + row intact).
    expect(tableExists(db, 'suggestions')).toBe(true);
    expect(tableExists(db, 'dismissed_patterns')).toBe(true);

    const sug = db
      .prepare(`SELECT title, priority, status FROM suggestions WHERE source_module = 'scope_drift'`)
      .get() as { title: string; priority: string; status: string };
    expect(sug.title).toBe('survives the drop');
    expect(sug.priority).toBe('high');
    expect(sug.status).toBe('pending');

    const dp = db
      .prepare(`SELECT dismiss_count, reasons FROM dismissed_patterns WHERE evidence_signature = 'brief:BR-1'`)
      .get() as { dismiss_count: number; reasons: string };
    expect(dp.dismiss_count).toBe(2);
    expect(JSON.parse(dp.reasons)).toEqual(['noise']);
  });

  it('is idempotent on a brain that never applied v2 (table already absent)', () => {
    // v1 + v3 only — never created pattern_observations.
    db.exec(V1.sql);
    db.exec(V3.sql);
    expect(tableExists(db, 'pattern_observations')).toBe(false);

    // DROP TABLE IF EXISTS must NOT throw on the absent table.
    expect(() => db.exec(V4.sql)).not.toThrow();
    expect(tableExists(db, 'pattern_observations')).toBe(false);
    // suggestions still present.
    expect(tableExists(db, 'suggestions')).toBe(true);
  });
});
