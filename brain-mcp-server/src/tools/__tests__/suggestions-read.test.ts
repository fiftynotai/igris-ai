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
import { subconsciousMigrations } from '../../engine/components/subconscious/schema.js';

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

describe('listSuggestions q — the FR-246 substring filter', () => {
  /**
   * Seeded HERE, not in the shared `beforeEach`: `SEEDS` is deliberately
   * asymmetric so a facet computed over the wrong WHERE clause cannot produce
   * the right numbers by luck, and every facet assertion in this file is
   * written against those exact six rows. The outer `beforeEach` rebuilds `db`
   * per test, so these three cannot leak.
   *
   * Asymmetric in their own way too: one matches by TITLE only, one by
   * EVIDENCE only, one carries a literal per-cent sign. A corpus where every
   * match came from the same column could not tell a title-only predicate from
   * a title-OR-evidence one.
   */
  beforeEach(() => {
    const q = db.prepare(
      `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    q.run('gap', 'a', 'kiln schedule', '{}', 'low', 'pending', '2026-07-07 00:00:00');
    q.run('gap', null, 's-brain', '{"note":"bisque firing"}', 'low', 'pending', '2026-07-08 00:00:00');
    q.run('gap', 'a', '100% coverage', '{}', 'low', 'pending', '2026-07-09 00:00:00');
  });

  it('matches title OR evidence', () => {
    const byTitle = listSuggestions(db, { q: 'kiln', limit: 100 });
    expect(byTitle.suggestions.map((r) => r.title)).toEqual(['kiln schedule']);
    const byEvidence = listSuggestions(db, { q: 'bisque', limit: 100 });
    expect(byEvidence.suggestions.map((r) => r.title)).toEqual(['s-brain']);
  });

  it('q="%" matches only the row with a literal per-cent sign', () => {
    const r = listSuggestions(db, { q: '%', limit: 100 });
    expect(r.suggestions.map((s) => s.title)).toEqual(['100% coverage']);
    // 9 rows exist; an unescaped LIKE would have returned all of them.
    expect(listSuggestions(db, { limit: 100 }).total).toBe(9);
  });

  it('reports mode "substring" in the payload, null without q', () => {
    expect(listSuggestions(db, { q: 'kiln', limit: 100 }).search).toEqual({
      mode: 'substring',
      fields: ['title', 'evidence'],
    });
    expect(listSuggestions(db, { limit: 100 }).search).toBeNull();
  });

  /**
   * The DELIBERATE DIVERGENCE from the FR-246 plan, pinned so it is a decision
   * rather than an accident. The plan asked for `q` to be EXCLUDED from
   * `brain_level`; the reader applies it. `brain_level`'s question is "how many
   * rows the project scope is hiding", and with a text filter active the only
   * useful answer is "how many MATCHING rows" — an unfiltered 8 next to a
   * filtered list of 1 is a number about a population the operator is not
   * looking at.
   */
  it('q narrows the brain_level facet too — the divergence, asserted', () => {
    const scoped = listSuggestions(db, { project_slug: 'a', q: 'bisque', limit: 100 });
    // The matching row is brain-level (project_slug IS NULL) so the scoped list
    // cannot show it...
    expect(scoped.suggestions).toEqual([]);
    // ...and the facet says exactly how many matching rows the scope hid.
    expect(scoped.facets.brain_level).toBe(1);
    // The DISCRIMINATING line is the next one, not this one. Unfiltered, this
    // fixture's brain-level population happens to be 1 as well, so the
    // `q: 'bisque'` reading above is NOT attributable to `q` on its own — an
    // earlier revision of this comment claimed it was ("without `q` the same
    // scope hides more"), which the asserted value contradicts.
    expect(listSuggestions(db, { project_slug: 'a', limit: 100 }).facets.brain_level).toBe(1);
    // THIS is the one that can only hold if `q` reached the facet query: a term
    // that matches a PROJECT-BEARING row and no brain-level one drives the
    // facet to 0, where an unfiltered facet would still report 1.
    expect(listSuggestions(db, { project_slug: 'a', q: 'kiln', limit: 100 }).facets.brain_level).toBe(0);
  });
});

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

/**
 * TD-326 — the project axis's third state.
 *
 * THE VACUOUS GATE THIS BRIEF NAMES is a test that passes because there
 * happened to be zero project-less rows, so every assertion below runs against
 * a population that is asserted NON-EMPTY first.
 *
 * The base `SEEDS` deliberately have NO project-less row (the FR-241 state), so
 * these tests seed their own — which also makes the "before" reading available
 * as a control.
 */
describe('TD-326 — project_is_null and the brain_level facet', () => {
  /** Three project-less rows: 2 `gap` pending, 1 `janitor` dismissed. */
  function seedProjectLess(): void {
    const stmt = db.prepare(
      `INSERT INTO suggestions (source_module, project_slug, title, priority, status, created_at)
       VALUES (?, NULL, ?, ?, ?, ?)`,
    );
    stmt.run('gap', 'brain-level gap 1', 'high', 'pending', '2026-07-10 00:00:00');
    stmt.run('gap', 'brain-level gap 2', 'low', 'pending', '2026-07-11 00:00:00');
    stmt.run('janitor', 'brain-level janitor', 'medium', 'dismissed', '2026-07-12 00:00:00');
  }

  it('the fixture starts with NO project-less rows — the control this brief needs', () => {
    // Without this reading, every assertion below could be satisfied by a
    // reader that always returned 0 and a seed that never landed.
    expect(listSuggestions(db, { limit: 100 }).facets.brain_level).toBe(0);
    expect(listSuggestions(db, { project_is_null: true, limit: 100 }).total).toBe(0);
  });

  it('the population is NON-EMPTY once seeded, and project_is_null lists exactly it', () => {
    seedProjectLess();
    const r = listSuggestions(db, { project_is_null: true, limit: 100 });
    expect(r.total).toBe(3);
    expect(r.suggestions).toHaveLength(3);
    // EVERY returned row, not a sample: `IS NULL` is the whole claim.
    expect(r.suggestions.every((s) => s.project_slug === null)).toBe(true);
    expect(r.suggestions.map((s) => s.title).sort()).toEqual([
      'brain-level gap 1',
      'brain-level gap 2',
      'brain-level janitor',
    ]);
  });

  it('project_is_null REPLACES project_slug rather than intersecting with it', () => {
    seedProjectLess();
    // The intersection would be empty. The route drops `project` and says so;
    // the reader's contract is that the flag wins.
    const r = listSuggestions(db, { project_is_null: true, project_slug: 'a', limit: 100 });
    expect(r.total).toBe(3);
  });

  it('a PROJECT scope can neither list nor total them — the defect, measured', () => {
    seedProjectLess();
    const scoped = listSuggestions(db, { project_slug: 'a', status: 'pending', limit: 100 });
    expect(scoped.total).toBe(4);
    expect(scoped.suggestions.some((s) => s.project_slug === null)).toBe(false);
    // ...and the SAME payload now carries the count of what it cannot show.
    expect(scoped.facets.brain_level).toBe(2);
  });

  it('brain_level drops the PROJECT clause and keeps every other one', () => {
    seedProjectLess();
    // Same `status` filter, three different project scopes -> the SAME count.
    // That is the minus-its-own-axis rule, and it is what makes the number
    // meaningful from inside a scope.
    const pending = { status: 'pending', limit: 100 } as const;
    expect(listSuggestions(db, { ...pending, project_slug: 'a' }).facets.brain_level).toBe(2);
    expect(listSuggestions(db, { ...pending, project_slug: 'b' }).facets.brain_level).toBe(2);
    expect(listSuggestions(db, pending).facets.brain_level).toBe(2);
    // ...while a NON-project filter DOES narrow it: 2 pending project-less rows
    // are `gap`, 0 are `janitor` (the janitor one is dismissed).
    expect(
      listSuggestions(db, { ...pending, source_module: 'janitor' }).facets.brain_level,
    ).toBe(0);
    expect(listSuggestions(db, { ...pending, priority: 'high' }).facets.brain_level).toBe(1);
    // ...and dropping `status` admits the dismissed one.
    expect(listSuggestions(db, { limit: 100 }).facets.brain_level).toBe(3);
  });

  it('under project_is_null the facet EQUALS total — the stated identity', () => {
    seedProjectLess();
    const r = listSuggestions(db, { project_is_null: true, status: 'pending', limit: 100 });
    expect(r.facets.brain_level).toBe(r.total);
    expect(r.total).toBe(2);
  });

  it('the source_module facet still drops its OWN clause under project_is_null', () => {
    seedProjectLess();
    const r = listSuggestions(db, {
      project_is_null: true,
      source_module: 'gap',
      limit: 100,
    });
    expect(r.total).toBe(2);
    // `janitor` is still offered — but ONLY the project-less one, because the
    // project axis is still applied to the source_module facet.
    expect(r.facets.source_module).toEqual({ gap: 2, janitor: 1 });
  });

  it('brain-level is NOT the unscoped read — the two sets differ, here by 6', () => {
    seedProjectLess();
    // `everything` (no predicate) vs `brain-level` (`IS NULL`). Blurring these
    // two is the labelling error TD-326 exists to prevent, so the difference is
    // asserted as a number rather than described.
    const everything = listSuggestions(db, { limit: 100 }).total;
    const brainOnly = listSuggestions(db, { project_is_null: true, limit: 100 }).total;
    expect(everything).toBe(9);
    expect(brainOnly).toBe(3);
    expect(everything - brainOnly).toBe(6);
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
      expect(r.facets.brain_level).toBe(0);
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

// ---------------------------------------------------------------------------
// TD-440 — the PRODUCER facet
// ---------------------------------------------------------------------------

/**
 * The fixture above is deliberately PRE-v5 — it hand-rolls the FR-118 column
 * set — and that is now load-bearing coverage rather than staleness: the
 * dashboard opens the operator's brain `{readonly:true}` and cannot migrate it,
 * so a brain that has not booted subconscious v5 must read exactly as it did
 * before rather than throwing `no such column`. These tests use a v5 table.
 */
describe('facets.source_instance — the producer axis (TD-440)', () => {
  let v5: Database.Database;

  /**
   * 20 rows, 16 distinct `source_module` values, 3 producers. The asymmetry is
   * the point: the two facets must disagree, or a producer facet computed off
   * the wrong column would still look right.
   */
  const ROWS: Array<[string, string, string]> = [
    ['abandoned_project', 'subconscious', 'pending'],
    ['project_abandonment', 'subconscious', 'pending'],
    ['portfolio_overload', 'subconscious', 'pending'],
    ['stalled_epidemic', 'subconscious', 'pending'],
    ['duplicate_project_slug', 'subconscious', 'pending'],
    ['systemic_process_gap', 'subconscious', 'pending'],
    ['suggestion_queue_flood', 'subconscious', 'pending'],
    ['unchecked_criteria_root_cause', 'subconscious', 'pending'],
    ['learning_capture_gap', 'subconscious', 'pending'],
    ['stale_brief_backlog', 'subconscious', 'dismissed'],
    ['edge_inference', 'synapse', 'pending'],
    ['edge_inference', 'synapse', 'pending'],
    ['edge_inference', 'synapse', 'pending'],
    ['edge_inference', 'synapse', 'dismissed'],
    ['janitor', 'janitor', 'pending'],
    ['janitor', 'janitor', 'pending'],
    ['re_evaluate_rejection', 'janitor', 'pending'],
    ['propose_edge_type', 'janitor', 'pending'],
    ['near_dupe', 'janitor', 'pending'],
    ['outdated_knowledge', 'janitor', 'pending'],
  ];

  beforeEach(() => {
    v5 = new Database(':memory:');
    for (const m of subconsciousMigrations) v5.exec(m.sql);
    const ins = v5.prepare(
      `INSERT INTO suggestions
         (source_module, project_slug, title, evidence, priority, status, source_instance)
       VALUES (?, 'a', 't', '{}', 'medium', ?, ?)`,
    );
    for (const [mod, inst, status] of ROWS) ins.run(mod, status, inst);
  });

  afterEach(() => {
    v5.close();
  });

  it('the fixture is asymmetric — 16 labels but 3 producers', () => {
    // The arming check. If the two axes agreed, every assertion below could
    // pass off the wrong column.
    expect(new Set(ROWS.map((r) => r[0])).size).toBe(16);
    expect(new Set(ROWS.map((r) => r[1])).size).toBe(3);
  });

  it('reports ONE key per producer, not one per label', () => {
    const r = listSuggestions(v5, { status: 'pending' });
    expect(Object.keys(r.facets.source_instance).sort()).toEqual([
      'janitor',
      'subconscious',
      'synapse',
    ]);
    expect(r.facets.source_instance).toEqual({ janitor: 6, subconscious: 9, synapse: 3 });
    // ...while the module facet still reports the full open vocabulary.
    expect(Object.keys(r.facets.source_module).length).toBeGreaterThan(3);
  });

  it('is ordered count DESC then name ASC, like its sibling', () => {
    const r = listSuggestions(v5, { status: 'pending' });
    expect(Object.keys(r.facets.source_instance)).toEqual([
      'subconscious',
      'janitor',
      'synapse',
    ]);
  });

  it('OMITS ITS OWN axis — selecting a producer does not collapse the control', () => {
    const r = listSuggestions(v5, { status: 'pending', source_instance: 'synapse' });
    expect(r.total).toBe(3);
    // The list narrowed...
    expect(r.suggestions.every((s) => s.source_instance === 'synapse')).toBe(true);
    // ...but the control still offers every producer, or the operator is stranded.
    expect(r.facets.source_instance).toEqual({ janitor: 6, subconscious: 9, synapse: 3 });
  });

  it('KEEPS every other filter — the other half of the minus-its-own-axis rule', () => {
    const all = listSuggestions(v5, {}).facets.source_instance;
    const pending = listSuggestions(v5, { status: 'pending' }).facets.source_instance;
    expect(all).toEqual({ janitor: 6, subconscious: 10, synapse: 4 });
    expect(pending).toEqual({ janitor: 6, subconscious: 9, synapse: 3 });
    expect(pending).not.toEqual(all);
  });

  it('a source_module filter DOES narrow the producer facet (it is not its own axis)', () => {
    const r = listSuggestions(v5, { status: 'pending', source_module: 'edge_inference' });
    expect(r.facets.source_instance).toEqual({ synapse: 3 });
    // ...and symmetrically, the module facet drops the module clause and keeps
    // the producer one.
    const byProducer = listSuggestions(v5, {
      status: 'pending',
      source_instance: 'synapse',
    });
    expect(byProducer.facets.source_module).toEqual({ edge_inference: 3 });
  });

  it('the source_instance FILTER round-trips', () => {
    expect(listSuggestions(v5, { source_instance: 'janitor' }).total).toBe(6);
    expect(listSuggestions(v5, { source_instance: 'nobody' }).total).toBe(0);
  });

  it('a NULL producer surfaces as the empty-string bucket, never as "null"', () => {
    v5.prepare(
      `INSERT INTO suggestions (source_module, project_slug, title, evidence, priority, status)
       VALUES ('legacy_label', 'a', 't', '{}', 'medium', 'pending')`,
    ).run();
    const r = listSuggestions(v5, { status: 'pending' });
    expect(r.facets.source_instance['']).toBe(1);
    expect(r.facets.source_instance).not.toHaveProperty('null');
  });

  it('the row carries the six v5 columns onto the wire', () => {
    const row = listSuggestions(v5, { source_instance: 'synapse', limit: 1 }).suggestions[0]!;
    expect(row.source_instance).toBe('synapse');
    expect(row.seen_count).toBe(1);
    expect(row.recurrence_titles).toBe('[]');
    expect(row.dedupe_key).toBeNull();
    expect(row.entity_key).toBeNull();
    expect(row.last_seen_at).toBeNull();
  });
});

describe('TD-440 — a PRE-v5 brain degrades instead of throwing', () => {
  it('omits the producer facet entirely rather than failing the read', () => {
    const old = new Database(':memory:');
    try {
      old.exec(DDL);
      old
        .prepare(
          `INSERT INTO suggestions (source_module, project_slug, title, priority, status)
           VALUES ('gap', 'a', 't', 'medium', 'pending')`,
        )
        .run();

      const r = listSuggestions(old, {});
      // The read SUCCEEDS — this is the dashboard's path on an unmigrated brain.
      expect(r.total).toBe(1);
      expect(r.degraded).toBeNull();
      expect(r.facets.source_instance).toEqual({});
      // ...and the sibling facets are untouched.
      expect(r.facets.source_module).toEqual({ gap: 1 });
    } finally {
      old.close();
    }
  });

  it('a source_instance FILTER on a pre-v5 brain is ignored, not an error', () => {
    const old = new Database(':memory:');
    try {
      old.exec(DDL);
      old
        .prepare(
          `INSERT INTO suggestions (source_module, project_slug, title, priority, status)
           VALUES ('gap', 'a', 't', 'medium', 'pending')`,
        )
        .run();
      // A stale bookmark carrying `?source_instance=synapse` must not 500 the
      // queue on a brain that has never heard of the column.
      expect(() => listSuggestions(old, { source_instance: 'synapse' })).not.toThrow();
      expect(listSuggestions(old, { source_instance: 'synapse' }).total).toBe(1);
    } finally {
      old.close();
    }
  });
});
