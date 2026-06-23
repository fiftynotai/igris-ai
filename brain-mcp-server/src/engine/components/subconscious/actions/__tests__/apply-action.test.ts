/**
 * Subconscious auto-action APPLY layer tests (FR-118 M3).
 *
 * Covers the apply layer end to end:
 *   - each of the 5 kinds: happy path + malformed params (→ error result,
 *     suggestion NOT marked acted on failure);
 *   - unknown kind → flag_for_review fallback (not a throw), handled gracefully;
 *   - applyAction marks the suggestion `acted` on success, leaves it `pending`
 *     on a failed action;
 *   - human-in-the-loop: create_brief DRAFTS only (no brief row inserted).
 *
 * The suite builds the v3 suggestions table + the backing tables the kinds
 * validate against (brief_files / brief_status / learnings / entity_edges) on a
 * fresh in-memory DB, mocks `getDb` so `handleEdgeCreate` (used by add_edge)
 * sees the same DB, and drives `applyAction` directly.
 *
 * @module engine/components/subconscious/actions/__tests__/apply-action.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { subconsciousMigrations } from '../../schema.js';
import { edgeMigrations } from '../../../edges/schema.js';
import { applyAction } from '../index.js';
import { getDb } from '../../../../../db.js';

vi.mock('../../../../../db.js', () => ({ getDb: vi.fn() }));

const V1 = subconsciousMigrations.find((m) => m.version === 1)!;
const V2 = subconsciousMigrations.find((m) => m.version === 2)!;
const V3 = subconsciousMigrations.find((m) => m.version === 3)!;

interface SuggestionRow {
  id: number;
  status: string;
  acted_at: string | null;
  acted_brief_id: string | null;
}

/** Build the v3 suggestions schema + the backing tables the kinds touch. */
function buildSchema(db: Database.Database): void {
  db.exec(V1.sql);
  db.exec(V2.sql);
  db.exec(V3.sql);
  for (const m of edgeMigrations) db.exec(m.sql);

  // Minimal brief tables (the kinds read brief_files.content + brief_status).
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_files (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
    CREATE TABLE IF NOT EXISTS brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `);
}

/** Insert a suggestion carrying a serialized action; return its id. */
function seedSuggestion(
  db: Database.Database,
  action: Record<string, unknown> | null,
  opts: { project_slug?: string | null; status?: string } = {},
): number {
  const info = db
    .prepare(
      `INSERT INTO suggestions
         (source_module, project_slug, title, evidence, priority, status,
          confidence, suggested_action, type_inferred)
       VALUES ('scope_drift', ?, 'a finding', '{}', 'medium', ?, 0.7, ?, 1)`,
    )
    .run(
      opts.project_slug ?? null,
      opts.status ?? 'pending',
      action ? JSON.stringify(action) : null,
    );
  return Number(info.lastInsertRowid);
}

function parse<T>(result: { content: { text: string }[]; isError?: boolean }): T {
  return JSON.parse(result.content[0].text) as T;
}

function statusOf(db: Database.Database, id: number): SuggestionRow {
  return db
    .prepare('SELECT id, status, acted_at, acted_brief_id FROM suggestions WHERE id = ?')
    .get(id) as SuggestionRow;
}

describe('FR-118 M3 — applyAction', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    buildSchema(db);
    vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // applyAction lifecycle invariants
  // -------------------------------------------------------------------------

  it('rejects a non-existent suggestion id', () => {
    const r = applyAction(db, 999);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not found/i);
  });

  it('rejects a non-positive id', () => {
    expect(applyAction(db, 0).isError).toBe(true);
    expect(applyAction(db, -3).isError).toBe(true);
  });

  it('refuses to re-apply an already-acted suggestion', () => {
    const id = seedSuggestion(db, { kind: 'flag_for_review' }, { status: 'acted' });
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/already acted/i);
  });

  it('refuses to apply a dismissed suggestion', () => {
    const id = seedSuggestion(db, { kind: 'flag_for_review' }, { status: 'dismissed' });
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/already dismissed/i);
  });

  // -------------------------------------------------------------------------
  // flag_for_review (the safe fallback)
  // -------------------------------------------------------------------------

  it('flag_for_review: happy path marks the suggestion acted', () => {
    const id = seedSuggestion(db, {
      kind: 'flag_for_review',
      target_kind: 'brief',
      target_id: 'FR-9',
      concern: 'looks risky',
    });
    const r = applyAction(db, id);
    expect(r.isError).toBeFalsy();
    const out = parse<{ applied: boolean; action_kind: string }>(r);
    expect(out.applied).toBe(true);
    expect(out.action_kind).toBe('flag_for_review');
    expect(statusOf(db, id).status).toBe('acted');
  });

  // -------------------------------------------------------------------------
  // dismiss_existing
  // -------------------------------------------------------------------------

  it('dismiss_existing: happy path dismisses the target + acts the carrier', () => {
    const target = seedSuggestion(db, null); // an open suggestion to dismiss
    const carrier = seedSuggestion(db, {
      kind: 'dismiss_existing',
      suggestion_id: target,
    });
    const r = applyAction(db, carrier);
    expect(r.isError).toBeFalsy();
    expect(statusOf(db, carrier).status).toBe('acted');
    expect(statusOf(db, target).status).toBe('dismissed');
  });

  it('dismiss_existing: malformed (missing suggestion_id) → error, carrier stays pending', () => {
    const carrier = seedSuggestion(db, { kind: 'dismiss_existing' });
    const r = applyAction(db, carrier);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/suggestion_id/i);
    expect(statusOf(db, carrier).status).toBe('pending');
  });

  it('dismiss_existing: target does not exist → error, carrier stays pending', () => {
    const carrier = seedSuggestion(db, { kind: 'dismiss_existing', suggestion_id: 4242 });
    const r = applyAction(db, carrier);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/does not exist/i);
    expect(statusOf(db, carrier).status).toBe('pending');
  });

  it('dismiss_existing: target already acted → error (no touching resolved rows)', () => {
    const target = seedSuggestion(db, null, { status: 'acted' });
    const carrier = seedSuggestion(db, { kind: 'dismiss_existing', suggestion_id: target });
    const r = applyAction(db, carrier);
    expect(r.isError).toBe(true);
    expect(statusOf(db, carrier).status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // tick_ac
  // -------------------------------------------------------------------------

  function seedBrief(briefId: string, project: string, body: string): void {
    db.prepare(
      `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash)
       VALUES (?, ?, ?, ?, ?, 'h0')`,
    ).run(`${project}:${briefId}`, project, briefId, `${briefId}.md`, body);
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, title, status) VALUES (?, ?, ?, 'In Progress')`,
    ).run(project, briefId, `${briefId} title`);
  }

  it('tick_ac: happy path checks the matching AC + stamps acted_brief_id', () => {
    seedBrief(
      'FR-100',
      'igris-ai',
      '# FR-100\n\n## AC\n- [ ] Build the apply layer\n- [ ] Write the tests\n',
    );
    const id = seedSuggestion(
      db,
      { kind: 'tick_ac', brief_id: 'FR-100', ac_text: 'Build the apply layer', justification: 'done' },
      { project_slug: 'igris-ai' },
    );
    const r = applyAction(db, id);
    expect(r.isError).toBeFalsy();
    const out = parse<{ suggestion: { acted_brief_id: string } }>(r);
    expect(out.suggestion.acted_brief_id).toBe('FR-100');
    expect(statusOf(db, id).status).toBe('acted');

    const body = db
      .prepare('SELECT content FROM brief_files WHERE brief_id = ?')
      .get('FR-100') as { content: string };
    expect(body.content).toContain('- [x] Build the apply layer');
    // The OTHER AC stays unchecked.
    expect(body.content).toContain('- [ ] Write the tests');
  });

  it('tick_ac: matches AC text case-insensitively + whitespace-collapsed', () => {
    seedBrief('FR-101', 'igris-ai', '- [ ] Ship   the   Thing\n');
    const id = seedSuggestion(
      db,
      { kind: 'tick_ac', brief_id: 'FR-101', ac_text: 'ship the thing' },
      { project_slug: 'igris-ai' },
    );
    expect(applyAction(db, id).isError).toBeFalsy();
    const body = db
      .prepare('SELECT content FROM brief_files WHERE brief_id = ?')
      .get('FR-101') as { content: string };
    expect(body.content).toContain('- [x] Ship   the   Thing');
  });

  it('tick_ac: hallucinated brief_id → error, suggestion stays pending', () => {
    const id = seedSuggestion(db, {
      kind: 'tick_ac',
      brief_id: 'FR-DOESNOTEXIST',
      ac_text: 'whatever',
    });
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/does not resolve/i);
    expect(statusOf(db, id).status).toBe('pending');
  });

  it('tick_ac: hallucinated ac_text (no matching line) → error, stays pending', () => {
    seedBrief('FR-102', 'igris-ai', '- [ ] A real criterion\n');
    const id = seedSuggestion(
      db,
      { kind: 'tick_ac', brief_id: 'FR-102', ac_text: 'an invented criterion' },
      { project_slug: 'igris-ai' },
    );
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/did not match/i);
    expect(statusOf(db, id).status).toBe('pending');
    // Body unchanged.
    const body = db
      .prepare('SELECT content FROM brief_files WHERE brief_id = ?')
      .get('FR-102') as { content: string };
    expect(body.content).toContain('- [ ] A real criterion');
  });

  it('tick_ac: missing ac_text param → error, stays pending', () => {
    seedBrief('FR-103', 'igris-ai', '- [ ] Something\n');
    const id = seedSuggestion(
      db,
      { kind: 'tick_ac', brief_id: 'FR-103' },
      { project_slug: 'igris-ai' },
    );
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/ac_text/i);
    expect(statusOf(db, id).status).toBe('pending');
  });

  it('tick_ac: ambiguous brief_id across projects (no project_slug) → error', () => {
    seedBrief('FR-DUP', 'proj-a', '- [ ] x\n');
    seedBrief('FR-DUP', 'proj-b', '- [ ] x\n');
    const id = seedSuggestion(db, { kind: 'tick_ac', brief_id: 'FR-DUP', ac_text: 'x' });
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/ambiguous/i);
    expect(statusOf(db, id).status).toBe('pending');
  });

  it('tick_ac: already-checked AC is idempotent (acts, no double-flip)', () => {
    seedBrief('FR-104', 'igris-ai', '- [x] Already done\n');
    const id = seedSuggestion(
      db,
      { kind: 'tick_ac', brief_id: 'FR-104', ac_text: 'Already done' },
      { project_slug: 'igris-ai' },
    );
    const r = applyAction(db, id);
    expect(r.isError).toBeFalsy();
    expect(statusOf(db, id).status).toBe('acted');
  });

  // -------------------------------------------------------------------------
  // create_brief (DRAFTS only — human-in-the-loop)
  // -------------------------------------------------------------------------

  it('create_brief: happy path returns a DRAFT and inserts NO brief row', () => {
    const briefsBefore = (
      db.prepare('SELECT COUNT(*) AS n FROM brief_files').get() as { n: number }
    ).n;
    const id = seedSuggestion(db, {
      kind: 'create_brief',
      proposed: { title: 'New work', type: 'FR', priority: 'P2-Medium', body: 'do it' },
    });
    const r = applyAction(db, id);
    expect(r.isError).toBeFalsy();
    const out = parse<{
      result: { draft: { title: string }; requires_operator_approval: boolean };
    }>(r);
    expect(out.result.draft.title).toBe('New work');
    expect(out.result.requires_operator_approval).toBe(true);
    expect(statusOf(db, id).status).toBe('acted');

    // CRITICAL: no brief was actually created.
    const briefsAfter = (
      db.prepare('SELECT COUNT(*) AS n FROM brief_files').get() as { n: number }
    ).n;
    expect(briefsAfter).toBe(briefsBefore);
  });

  it('create_brief: missing required field (body) → error, stays pending', () => {
    const id = seedSuggestion(db, {
      kind: 'create_brief',
      proposed: { title: 'x', type: 'FR', priority: 'P2-Medium' },
    });
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/proposed\.body/i);
    expect(statusOf(db, id).status).toBe('pending');
  });

  it('create_brief: missing proposed object → error', () => {
    const id = seedSuggestion(db, { kind: 'create_brief' });
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/proposed/i);
    expect(statusOf(db, id).status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // add_edge (validate BOTH nodes exist; reuse handleEdgeCreate)
  // -------------------------------------------------------------------------

  it('add_edge: happy path creates an edge between two real nodes', () => {
    db.prepare(
      `INSERT INTO learnings (id, project, category, title, content)
       VALUES (1, 'p', 'pattern', 't1', 'c1'), (2, 'p', 'pattern', 't2', 'c2')`,
    ).run();
    const id = seedSuggestion(db, {
      kind: 'add_edge',
      from: { type: 'learning', id: '1' },
      to: { type: 'learning', id: '2' },
      edge_type: 'related_to',
      justification: 'they relate',
    });
    const r = applyAction(db, id);
    expect(r.isError).toBeFalsy();
    expect(statusOf(db, id).status).toBe('acted');

    const edge = db
      .prepare(
        `SELECT * FROM entity_edges WHERE from_id='1' AND to_id='2' AND edge_type='related_to'`,
      )
      .get() as { provenance: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.provenance).toBe('inferred');
  });

  it('add_edge: from node does not exist → error, stays pending, NO edge', () => {
    db.prepare(
      `INSERT INTO learnings (id, project, category, title, content)
       VALUES (2, 'p', 'pattern', 't2', 'c2')`,
    ).run();
    const id = seedSuggestion(db, {
      kind: 'add_edge',
      from: { type: 'learning', id: '999' },
      to: { type: 'learning', id: '2' },
      edge_type: 'related_to',
    });
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/from node.*does not exist/i);
    expect(statusOf(db, id).status).toBe('pending');
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it('add_edge: to node does not exist → error, stays pending', () => {
    db.prepare(
      `INSERT INTO learnings (id, project, category, title, content)
       VALUES (1, 'p', 'pattern', 't1', 'c1')`,
    ).run();
    const id = seedSuggestion(db, {
      kind: 'add_edge',
      from: { type: 'learning', id: '1' },
      to: { type: 'learning', id: '999' },
      edge_type: 'related_to',
    });
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/to node.*does not exist/i);
    expect(statusOf(db, id).status).toBe('pending');
  });

  it('add_edge: malformed (missing edge_type) → error, stays pending', () => {
    const id = seedSuggestion(db, {
      kind: 'add_edge',
      from: { type: 'learning', id: '1' },
      to: { type: 'learning', id: '2' },
    });
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/edge_type/i);
    expect(statusOf(db, id).status).toBe('pending');
  });

  it('add_edge: malformed (from missing id) → error, stays pending', () => {
    const id = seedSuggestion(db, {
      kind: 'add_edge',
      from: { type: 'learning' },
      to: { type: 'learning', id: '2' },
      edge_type: 'related_to',
    });
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/from:.*type.*id/i);
    expect(statusOf(db, id).status).toBe('pending');
  });

  it('add_edge: invalid edge_type vocabulary (rejected by handleEdgeCreate) → error', () => {
    db.prepare(
      `INSERT INTO learnings (id, project, category, title, content)
       VALUES (1, 'p', 'pattern', 't1', 'c1'), (2, 'p', 'pattern', 't2', 'c2')`,
    ).run();
    const id = seedSuggestion(db, {
      kind: 'add_edge',
      from: { type: 'learning', id: '1' },
      to: { type: 'learning', id: '2' },
      edge_type: 'totally_made_up',
    });
    const r = applyAction(db, id);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/edge creation failed/i);
    expect(statusOf(db, id).status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // unknown kind → flag_for_review fallback (graceful, not a throw)
  // -------------------------------------------------------------------------

  it('unknown kind → flag_for_review fallback (handled, acted, not thrown)', () => {
    const id = seedSuggestion(db, {
      kind: 'launch_the_missiles',
      target: 'world',
    });
    let r!: ReturnType<typeof applyAction>;
    expect(() => {
      r = applyAction(db, id);
    }).not.toThrow();
    expect(r.isError).toBeFalsy();
    const out = parse<{ action_kind: string; result: { concern: string } }>(r);
    expect(out.action_kind).toBe('flag_for_review');
    expect(out.result.concern).toMatch(/unknown action kind "launch_the_missiles"/);
    expect(statusOf(db, id).status).toBe('acted');
  });

  it('missing suggested_action → graceful flag_for_review (not an error)', () => {
    const id = seedSuggestion(db, null);
    const r = applyAction(db, id);
    expect(r.isError).toBeFalsy();
    const out = parse<{ action_kind: string; result: { concern: string } }>(r);
    expect(out.action_kind).toBe('flag_for_review');
    expect(out.result.concern).toMatch(/no suggested_action/i);
    expect(statusOf(db, id).status).toBe('acted');
  });

  it('malformed (non-JSON) suggested_action → graceful flag_for_review', () => {
    const info = db
      .prepare(
        `INSERT INTO suggestions
           (source_module, title, evidence, priority, status, suggested_action, type_inferred)
         VALUES ('scope_drift', 't', '{}', 'low', 'pending', 'not json{{', 1)`,
      )
      .run();
    const id = Number(info.lastInsertRowid);
    const r = applyAction(db, id);
    expect(r.isError).toBeFalsy();
    const out = parse<{ action_kind: string; result: { concern: string } }>(r);
    expect(out.action_kind).toBe('flag_for_review');
    expect(out.result.concern).toMatch(/malformed/i);
  });
});
