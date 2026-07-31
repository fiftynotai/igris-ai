/**
 * FR-241 — `tools/suggestions-read.ts` unit tests.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE WIRE GOLDEN
 * ----------------------------------------------------
 * `subconscious/__tests__/suggestion-list-wire-parity.test.ts` pins that the MCP
 * wrapper's BYTES did not change across the lift. It explicitly does NOT cover
 * the two things the lift ADDED, because the wrapper deliberately does not emit
 * them:
 *   - the `facets.source_module` count map (the dashboard's filter vocabulary);
 *   - the L-133 `degraded` preflight.
 * A golden cannot assert a field that is absent from the golden, so those are
 * asserted here.
 *
 * WHAT THIS GATE PROVES
 * ---------------------
 * That the reader takes a caller-supplied handle (never `getDb()`), that its
 * filters/ordering/pagination behave, that the facet map is computed over the
 * active filters MINUS its own clause, and that a missing table degrades rather
 * than throws.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 *  - That the reader is TEXTUALLY pure (no `db.js` import, no write verb).
 *    **Sibling:** `pure-read-purity.test.ts`.
 *  - That the MCP wrapper's wire output is unchanged. **Sibling:**
 *    `subconscious/__tests__/suggestion-list-wire-parity.test.ts`.
 *  - Anything about the dashboard's `/api/suggestions` wire shape — a different
 *    contract with a different consumer. **Sibling:** the FR-241 CLI suites.
 *
 * @module tools/__tests__/suggestions-read.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { listSuggestions } from '../suggestions-read.js';

let db: Database.Database;

const DDL = `
  CREATE TABLE suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_module TEXT NOT NULL,
    project_slug TEXT,
    title TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '{}',
    priority TEXT NOT NULL DEFAULT 'medium'
      CHECK (priority IN ('high','medium','low')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','dismissed','acted')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT, dismissed_at TEXT, dismissed_reason TEXT,
    acted_at TEXT, acted_brief_id TEXT,
    confidence REAL, suggested_action TEXT,
    type_inferred INTEGER NOT NULL DEFAULT 0
  );
`;

interface Seed {
  module: string;
  project: string | null;
  priority: string;
  status: string;
  title: string;
  created_at: string;
}

/**
 * A fixture whose facet counts are ASYMMETRIC across every dimension.
 *
 * Load-bearing: if every module had the same count, a facet map computed over
 * the WRONG WHERE clause would still produce the right numbers and the test
 * would pass for the wrong reason.
 */
const SEEDS: Seed[] = [
  { module: 'gap', project: 'a', priority: 'high', status: 'pending', created_at: '2026-07-01 00:00:00' },
  { module: 'gap', project: 'a', priority: 'low', status: 'pending', created_at: '2026-07-02 00:00:00' },
  { module: 'gap', project: 'a', priority: 'high', status: 'dismissed', created_at: '2026-07-03 00:00:00' },
  { module: 'janitor', project: 'a', priority: 'medium', status: 'pending', created_at: '2026-07-04 00:00:00' },
  { module: 'janitor', project: 'b', priority: 'high', status: 'pending', created_at: '2026-07-05 00:00:00' },
  { module: 'missing_followup', project: 'a', priority: 'low', status: 'pending', created_at: '2026-07-06 00:00:00' },
].map((s, i) => ({ ...s, title: `s${i}` }));

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(DDL);
  const stmt = db.prepare(
    `INSERT INTO suggestions (source_module, project_slug, title, priority, status, created_at)
     VALUES (?,?,?,?,?,?)`,
  );
  for (const s of SEEDS) {
    stmt.run(s.module, s.project, s.title, s.priority, s.status, s.created_at);
  }
});

afterEach(() => db.close());

describe('listSuggestions — the lifted query', () => {
  it('takes the CALLER\'s handle and returns every row unfiltered', () => {
    const r = listSuggestions(db, { limit: 100 });
    expect(r.total).toBe(SEEDS.length);
    expect(r.count).toBe(SEEDS.length);
    expect(r.degraded).toBeNull();
  });

  it('works on a query_only handle — the property the dashboard depends on', () => {
    // The FR-240 read door arms `query_only = ON`. If the reader ever acquired
    // its own read-write connection or issued a write, this throws.
    db.pragma('query_only = ON');
    expect(db.pragma('query_only', { simple: true })).toBe(1);
    const r = listSuggestions(db, { limit: 100 });
    expect(r.count).toBe(SEEDS.length);
    // Self-negative-control for the line above: the pragma is really armed, so
    // "it did not throw" is a claim about the reader and not about the pragma.
    expect(() => db.prepare("UPDATE suggestions SET title='x'").run()).toThrow();
  });

  it('collates by priority band, then created_at DESC inside a band', () => {
    const r = listSuggestions(db, { limit: 100 });
    expect(r.suggestions.map((s) => s.priority)).toEqual([
      'high', 'high', 'high', 'medium', 'low', 'low',
    ]);
    const highs = r.suggestions.filter((s) => s.priority === 'high').map((s) => s.created_at);
    expect(highs).toEqual([...highs].sort().reverse());
  });

  it('applies each filter', () => {
    expect(listSuggestions(db, { status: 'pending', limit: 100 }).total).toBe(5);
    expect(listSuggestions(db, { project_slug: 'b', limit: 100 }).total).toBe(1);
    expect(listSuggestions(db, { source_module: 'gap', limit: 100 }).total).toBe(3);
    expect(listSuggestions(db, { priority: 'high', limit: 100 }).total).toBe(3);
  });

  it('`total` is the filtered total while `count` is the page', () => {
    const r = listSuggestions(db, { limit: 2, offset: 1 });
    expect(r.total).toBe(SEEDS.length);
    expect(r.count).toBe(2);
    expect(r.limit).toBe(2);
    expect(r.offset).toBe(1);
  });

  it('does NOT re-clamp limit/offset — clamping is the caller\'s contract', () => {
    // `goals/read.ts` states the same rule. Re-clamping here would silently
    // change the `limit` the MCP wrapper echoes on the wire.
    const r = listSuggestions(db, { limit: 999999, offset: 0 });
    expect(r.limit).toBe(999999);
  });

  it('returns `evidence` as the RAW string — parsing is the wrapper\'s job', () => {
    db.prepare("UPDATE suggestions SET evidence = '{\"k\":1}' WHERE title = 's0'").run();
    const r = listSuggestions(db, { limit: 100 });
    const row = r.suggestions.find((s) => s.title === 's0');
    expect(typeof row?.evidence).toBe('string');
    expect(row?.evidence).toBe('{"k":1}');
  });
});

describe('facets — computed from the DATA, over the filters MINUS its own clause', () => {
  it('unfiltered: every module with its real count, count DESC then name ASC', () => {
    const f = listSuggestions(db, { limit: 100 }).facets.source_module;
    expect(f).toEqual({ gap: 3, janitor: 2, missing_followup: 1 });
    expect(Object.keys(f)).toEqual(['gap', 'janitor', 'missing_followup']);
  });

  it('the OTHER filters DO narrow the facet counts', () => {
    const f = listSuggestions(db, { status: 'pending', limit: 100 }).facets.source_module;
    // The dismissed `gap` row is excluded, so gap drops 3 -> 2.
    expect(f).toEqual({ gap: 2, janitor: 2, missing_followup: 1 });
  });

  it('selecting a source_module does NOT collapse the dropdown to that module', () => {
    // THE POINT OF THE MINUS-ITS-OWN-CLAUSE RULE. If the facet query reused the
    // main WHERE, this would be `{gap: 3}` and the operator could never switch
    // filters — the control would erase its own options on first use.
    const r = listSuggestions(db, { source_module: 'gap', limit: 100 });
    expect(r.total).toBe(3);
    expect(r.facets.source_module).toEqual({ gap: 3, janitor: 2, missing_followup: 1 });
  });

  it('combined: source_module ignored, status honoured', () => {
    const r = listSuggestions(db, { source_module: 'janitor', status: 'pending', limit: 100 });
    expect(r.total).toBe(2);
    expect(r.facets.source_module).toEqual({ gap: 2, janitor: 2, missing_followup: 1 });
  });

  it('a facet key the code has never heard of still appears (L-967)', () => {
    // `source_module` is an OPEN vocabulary since FR-118 M2 — the LLM names the
    // kind. A hand-listed dropdown would hide this row forever.
    db.prepare(
      `INSERT INTO suggestions (source_module, project_slug, title, priority, status)
       VALUES ('a_kind_invented_next_year','a','future','high','pending')`,
    ).run();
    const f = listSuggestions(db, { limit: 100 }).facets.source_module;
    expect(f.a_kind_invented_next_year).toBe(1);
  });
});

describe('L-133 — a missing table DEGRADES, it does not throw', () => {
  it('reports `degraded` with empty data', () => {
    const empty = new Database(':memory:');
    try {
      const r = listSuggestions(empty, { limit: 10, offset: 3 });
      expect(r.degraded).toBe('brain table absent: suggestions');
      expect(r.suggestions).toEqual([]);
      expect(r.count).toBe(0);
      expect(r.total).toBe(0);
      expect(r.facets.source_module).toEqual({});
      // The page window is echoed back so a caller can still render controls.
      expect(r.limit).toBe(10);
      expect(r.offset).toBe(3);
    } finally {
      empty.close();
    }
  });

  it('the preflight NEVER creates the table — self-negative-control', () => {
    // A preflight that repaired what it detected would turn "read the brain"
    // into "migrate the brain", which is exactly what the pure layer exists to
    // prevent. Assert the table is still absent AFTER the degraded read.
    const empty = new Database(':memory:');
    try {
      listSuggestions(empty);
      const found = empty
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suggestions'")
        .get();
      expect(found).toBeUndefined();
    } finally {
      empty.close();
    }
  });

  it('and the degraded branch is REACHABLE only when the table is absent', () => {
    // Without this, "degraded is null on the seeded db" and "degraded is a
    // constant null" are indistinguishable one level up.
    expect(listSuggestions(db).degraded).toBeNull();
  });
});
