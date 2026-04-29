/**
 * Subconscious Handlers — unit tests
 *
 * Covers list/dismiss/acted/run plumbing:
 *   - list filters and ordering
 *   - dismiss flips status, writes reason, idempotent on re-dismiss
 *   - acted requires status=pending
 *   - subconscious_run executes the full pipeline against an in-memory
 *     DB and returns the expected counts shape
 *
 * @module engine/components/subconscious/__tests__/handlers.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// Mock db so handlers' getDb() resolves to our in-memory instance.
vi.mock('../../../../db.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../../../db.js';
import {
  handleSuggestionList,
  handleSuggestionDismiss,
  handleSuggestionActed,
  handleSubconsciousRun,
  setHandlerContext,
} from '../handlers.js';
import { subconsciousMigrations } from '../schema.js';
import { DEFAULT_DETECTOR_CONFIG, type Suggestion } from '../types.js';
import { createEventBus } from '../../../bus.js';
import {
  applyMinimalSchema,
  seedBrief,
  seedProject,
} from './fixtures/minimal-schema.js';

interface ListResult {
  suggestions: (Omit<Suggestion, 'evidence'> & { evidence: Record<string, unknown> })[];
  count: number;
  total: number;
  limit: number;
  offset: number;
}

interface MutateResult {
  updated: boolean;
  suggestion: Omit<Suggestion, 'evidence'> & { evidence: Record<string, unknown> };
}

function parse<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  applyMinimalSchema(db);
  for (const m of subconsciousMigrations) db.exec(m.sql);
  return db;
}

function insertSuggestion(
  db: Database.Database,
  fields: Partial<Suggestion> & { source_module: string; title: string },
): number {
  const result = db
    .prepare(
      `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.source_module,
      fields.project_slug ?? null,
      fields.title,
      fields.evidence ?? '{}',
      fields.priority ?? 'medium',
      fields.status ?? 'pending',
    );
  return Number(result.lastInsertRowid);
}

describe('subconscious handlers', () => {
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

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  describe('handleSuggestionList', () => {
    it('returns empty list when no suggestions exist', () => {
      const result = handleSuggestionList({});
      const parsed = parse<ListResult>(result);
      expect(parsed.suggestions).toHaveLength(0);
      expect(parsed.total).toBe(0);
    });

    it('orders by priority then created_at DESC', () => {
      insertSuggestion(db, {
        source_module: 'stalled',
        title: 'low',
        priority: 'low',
      });
      insertSuggestion(db, {
        source_module: 'stalled',
        title: 'medium',
        priority: 'medium',
      });
      insertSuggestion(db, {
        source_module: 'stalled',
        title: 'high',
        priority: 'high',
      });
      const parsed = parse<ListResult>(handleSuggestionList({}));
      expect(parsed.suggestions.map((s) => s.priority)).toEqual(['high', 'medium', 'low']);
    });

    it('filters by status', () => {
      insertSuggestion(db, { source_module: 'stalled', title: 'a', status: 'pending' });
      insertSuggestion(db, { source_module: 'stalled', title: 'b', status: 'dismissed' });
      const pending = parse<ListResult>(handleSuggestionList({ status: 'pending' }));
      expect(pending.suggestions).toHaveLength(1);
      expect(pending.suggestions[0].title).toBe('a');
    });

    it('filters by source_module', () => {
      insertSuggestion(db, { source_module: 'stalled', title: 'sa' });
      insertSuggestion(db, { source_module: 'gap', title: 'ga' });
      const result = parse<ListResult>(handleSuggestionList({ source_module: 'gap' }));
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].source_module).toBe('gap');
    });

    it('filters by project_slug', () => {
      insertSuggestion(db, { source_module: 'stalled', title: 'a', project_slug: 'p1' });
      insertSuggestion(db, { source_module: 'stalled', title: 'b', project_slug: 'p2' });
      const result = parse<ListResult>(handleSuggestionList({ project_slug: 'p1' }));
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].project_slug).toBe('p1');
    });

    it('rejects invalid status filter', () => {
      const result = handleSuggestionList({ status: 'bogus' });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid limit', () => {
      const result = handleSuggestionList({ limit: 0 });
      expect(result.isError).toBe(true);
    });

    it('parses evidence JSON in the response', () => {
      insertSuggestion(db, {
        source_module: 'stalled',
        title: 'with-ev',
        evidence: JSON.stringify({ brief_id: 'BR-1', days_stalled: 35 }),
      });
      const parsed = parse<ListResult>(handleSuggestionList({}));
      expect(parsed.suggestions[0].evidence).toEqual({ brief_id: 'BR-1', days_stalled: 35 });
    });
  });

  // -------------------------------------------------------------------------
  // Dismiss
  // -------------------------------------------------------------------------

  describe('handleSuggestionDismiss', () => {
    it('flips status to dismissed and writes reason', () => {
      const id = insertSuggestion(db, {
        source_module: 'stalled',
        title: 't',
        evidence: JSON.stringify({ brief_id: 'BR-1' }),
      });
      const result = handleSuggestionDismiss({ id, reason: 'noise' });
      const parsed = parse<MutateResult>(result);
      expect(parsed.updated).toBe(true);
      expect(parsed.suggestion.status).toBe('dismissed');
      expect(parsed.suggestion.dismissed_reason).toBe('noise');
      expect(parsed.suggestion.dismissed_at).not.toBeNull();
    });

    it('idempotently no-ops on already-dismissed', () => {
      const id = insertSuggestion(db, {
        source_module: 'stalled',
        title: 't',
        evidence: JSON.stringify({ brief_id: 'BR-1' }),
        status: 'dismissed',
      });
      const result = handleSuggestionDismiss({ id });
      const parsed = parse<MutateResult>(result);
      expect(parsed.updated).toBe(false);
    });

    it('rejects acted suggestion', () => {
      const id = insertSuggestion(db, {
        source_module: 'stalled',
        title: 't',
        evidence: JSON.stringify({ brief_id: 'BR-1' }),
        status: 'acted',
      });
      const result = handleSuggestionDismiss({ id });
      expect(result.isError).toBe(true);
    });

    it('rejects missing id', () => {
      const result = handleSuggestionDismiss({});
      expect(result.isError).toBe(true);
    });

    it('rejects unknown id', () => {
      const result = handleSuggestionDismiss({ id: 99999 });
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Acted
  // -------------------------------------------------------------------------

  describe('handleSuggestionActed', () => {
    it('flips status to acted and records brief_id', () => {
      const id = insertSuggestion(db, {
        source_module: 'stalled',
        title: 't',
        evidence: JSON.stringify({ brief_id: 'BR-1' }),
      });
      const parsed = parse<MutateResult>(
        handleSuggestionActed({ id, brief_id: 'BR-77' }),
      );
      expect(parsed.updated).toBe(true);
      expect(parsed.suggestion.status).toBe('acted');
      expect(parsed.suggestion.acted_brief_id).toBe('BR-77');
    });

    it('rejects already-dismissed suggestion', () => {
      const id = insertSuggestion(db, {
        source_module: 'stalled',
        title: 't',
        status: 'dismissed',
      });
      const result = handleSuggestionActed({ id });
      expect(result.isError).toBe(true);
    });

    it('idempotently no-ops on already-acted', () => {
      const id = insertSuggestion(db, {
        source_module: 'stalled',
        title: 't',
        status: 'acted',
      });
      const parsed = parse<MutateResult>(handleSuggestionActed({ id }));
      expect(parsed.updated).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------------

  describe('handleSubconsciousRun', () => {
    it('runs the full pipeline and returns a summary', () => {
      seedProject(db, { slug: 'p1' });
      seedBrief(db, {
        project: 'p1',
        brief_id: 'BR-1',
        status: 'In Progress',
        updated_days_ago: 35,
      });
      const result = handleSubconsciousRun({});
      const parsed = parse<{
        emitted: number;
        suppressed: number;
        by_module: Record<string, number>;
      }>(result);
      expect(parsed.emitted).toBeGreaterThanOrEqual(1);
      expect(parsed.by_module.stalled).toBeGreaterThanOrEqual(1);
    });

    it('does not duplicate within-run on repeated invocations', () => {
      seedProject(db, { slug: 'p1' });
      seedBrief(db, {
        project: 'p1',
        brief_id: 'BR-1',
        status: 'In Progress',
        updated_days_ago: 35,
      });
      handleSubconsciousRun({});
      const before = db.prepare('SELECT COUNT(*) AS n FROM suggestions').get() as { n: number };
      handleSubconsciousRun({});
      const after = db.prepare('SELECT COUNT(*) AS n FROM suggestions').get() as { n: number };
      expect(after.n).toBe(before.n);
    });

    it('does not duplicate across days when title drifts (days_stalled increments)', () => {
      // Simulates the warden-flagged regression: stalled brief titles include
      // "stalled for N days" which drifts daily. Dedupe must key on
      // evidence_signature (stable) not title (drifts).
      seedProject(db, { slug: 'p1' });
      seedBrief(db, {
        project: 'p1',
        brief_id: 'BR-1',
        status: 'In Progress',
        updated_days_ago: 35,
      });
      handleSubconsciousRun({});
      const before = db.prepare('SELECT COUNT(*) AS n FROM suggestions').get() as { n: number };

      // Hand-mutate the existing pending row's title to simulate a drift in
      // days_stalled (as would happen on a later cron run before TTL clears).
      db.prepare(
        `UPDATE suggestions SET title = 'BR-1 stalled in In Progress for 36 days' WHERE status = 'pending'`,
      ).run();

      handleSubconsciousRun({});
      const after = db.prepare('SELECT COUNT(*) AS n FROM suggestions').get() as { n: number };
      expect(after.n).toBe(before.n);
    });
  });
});
