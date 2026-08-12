/**
 * BR-090 — reconciliation across a WIDENED syncKey, in BOTH directions.
 *
 * BR-083 added `from_project` / `to_project` to `entity_edges` AND to its
 * `SYNC_TABLES` syncKey. A syncKey is an identity claim, so widening one
 * silently redefines identity for every replica that has not migrated: the same
 * logical edge, keyed narrowly on one side and widely on the other, does not
 * match. `mergeRows` took the INSERT branch and `strategy: 'append'` never
 * removed the older row.
 *
 * Measured on the live VPS before the fix (2026-08-11):
 *
 *     lookup (brief, BR-082, goal, GL-006, serves_goal, from_project='igris-ai') : 0
 *     lookup for the SAME edge with from_project NULL (what it holds)            : 1
 *
 * THE TWO DIRECTIONS ARE NOT MIRROR IMAGES. That is the point of this file:
 *
 *   PUSH  incoming QUALIFIED -> stored NULL      : ADOPT the attribution.
 *   PULL  incoming NULL      -> stored QUALIFIED : RETAIN the local one.
 *
 * A "symmetric" fix that copied incoming qualifiers over would, on the pull,
 * null out every attribution on the ORIGIN — 458 of them on this operator's
 * brain — which is strictly worse than the duplication it was written to
 * prevent. `T2` and `T2-direction` exist to make that specific wrong fix fail.
 *
 * These drive the REAL `mergeRows` against a REAL in-memory SQLite DB, and the
 * fixture DDL is the REAL `edges@4` schema (see `EDGES_DDL`). No mocks: the bug
 * surface IS the merge (L-159 / TD-098).
 *
 * @module tools/__tests__/sync-widened-key.test
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { mergeRows, SYNC_TABLES, type SyncTableConfig } from '../sync.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EDGES_CONFIG: SyncTableConfig = (() => {
  const cfg = SYNC_TABLES.find((c) => c.table === 'entity_edges');
  if (!cfg) throw new Error('entity_edges missing from SYNC_TABLES');
  return cfg;
})();

/**
 * The REAL `edges@4` DDL, copied from the live brain's `sqlite_master`.
 *
 * THIS SESSION'S CAUTIONARY TALE: `dashboard-layers-fixture.ts` kept a v1
 * `entity_edges` table while the reader it fed had moved to selecting
 * `e.from_project`. `/api/goal` returned `goal: undefined` and the test still
 * passed, because a fixture that stops mirroring its schema stops testing
 * anything. The expression UNIQUE INDEX below is not decoration — it is what
 * makes "at most one all-NULL row per legacy key" true, which is what makes the
 * adopt in `mergeRows` unambiguous. A fixture without it would let this file
 * pass while the production invariant it relies on was absent.
 */
const EDGES_DDL = `
  CREATE TABLE entity_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_type TEXT NOT NULL,
    from_id   TEXT NOT NULL,
    to_type   TEXT NOT NULL,
    to_id     TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    provenance TEXT NOT NULL DEFAULT 'observed',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata   TEXT NOT NULL DEFAULT '{}',
    from_project TEXT,
    to_project   TEXT
  );
  CREATE UNIQUE INDEX idx_edges_unique ON entity_edges(
    from_type, from_id, COALESCE(from_project, ''),
    to_type,   to_id,   COALESCE(to_project, ''),
    edge_type);
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(EDGES_DDL);
  return db;
}

/** The edge from the live measurement above, parameterised by attribution. */
function edge(
  fromProject: string | null,
  toProject: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    from_type: 'brief',
    from_id: 'BR-082',
    to_type: 'goal',
    to_id: 'GL-006',
    edge_type: 'serves_goal',
    confidence: 1.0,
    provenance: 'observed',
    created_at: '2026-08-01 00:00:00',
    metadata: '{}',
    from_project: fromProject,
    to_project: toProject,
    ...overrides,
  };
}

function insertEdge(db: Database.Database, row: Record<string, unknown>): void {
  const cols = EDGES_CONFIG.columns;
  db.prepare(
    `INSERT INTO entity_edges (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => row[c] ?? null));
}

function allEdges(db: Database.Database): Record<string, unknown>[] {
  return db
    .prepare('SELECT * FROM entity_edges ORDER BY id')
    .all() as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// T0 — the fixture must be capable of showing the bug
// ---------------------------------------------------------------------------

describe('BR-090 T0 — the fixture is not a both-sides-agree tautology', () => {
  /**
   * SELF-NEGATIVE-CONTROL. The brief names the trap explicitly: "a fixture
   * where both sides already agree passes before and after." This test asserts
   * the fixture's two sides genuinely DISAGREE on the widened columns, so
   * weakening any test below into an agreeing pair fails HERE rather than
   * silently passing there.
   */
  it('the stored and incoming rows differ on exactly the widened columns', () => {
    const stored = edge(null, null);
    const incoming = edge('igris-ai', 'igris-ai');

    for (const k of EDGES_CONFIG.legacySyncKey ?? []) {
      expect(stored[k], `legacy key column ${k} must AGREE — else it is a different edge`)
        .toEqual(incoming[k]);
    }
    const qualifiers = EDGES_CONFIG.qualifierCols ?? [];
    expect(qualifiers.length, 'entity_edges must declare qualifierCols').toBeGreaterThan(0);
    for (const q of qualifiers) {
      expect(stored[q], `qualifier ${q} must DISAGREE — that disagreement IS the bug`)
        .not.toEqual(incoming[q]);
    }
  });

  it('the full syncKey lookup genuinely MISSES across the two — the bug precondition', () => {
    const db = makeDb();
    insertEdge(db, edge(null, null));

    const incoming = edge('igris-ai', 'igris-ai');
    const hit = db
      .prepare(
        `SELECT * FROM entity_edges WHERE ${EDGES_CONFIG.syncKey
          .map((k) => `${k} IS ?`)
          .join(' AND ')}`,
      )
      .get(...EDGES_CONFIG.syncKey.map((k) => incoming[k]));

    // If this ever finds a row, the premise of BR-090 evaporated and every
    // test below is vacuous. Pin it.
    expect(hit, 'the widened key must not match the unqualified row').toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T1 — PUSH: incoming qualified, stored NULL
// ---------------------------------------------------------------------------

describe('BR-090 T1 — PUSH adopts the attribution instead of duplicating', () => {
  it('a qualified edge merged over an unqualified one leaves ONE row, carrying the qualifier', () => {
    const db = makeDb();
    insertEdge(db, edge(null, null)); // what the un-migrated VPS holds

    const result = mergeRows(db, EDGES_CONFIG, [edge('igris-ai', 'igris-ai')]);

    const rows = allEdges(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].from_project).toBe('igris-ai');
    expect(rows[0].to_project).toBe('igris-ai');

    // Counted as its own outcome, never as an insert.
    expect(result.reconciled).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.reconciliations?.[0].action).toBe('adopted');
  });

  it('re-merging the same qualified edge is idempotent — it converges, it does not oscillate', () => {
    const db = makeDb();
    insertEdge(db, edge(null, null));

    mergeRows(db, EDGES_CONFIG, [edge('igris-ai', 'igris-ai')]);
    const second = mergeRows(db, EDGES_CONFIG, [edge('igris-ai', 'igris-ai')]);

    expect(allEdges(db)).toHaveLength(1);
    // Second pass matches on the FULL key now, so it is an ordinary append skip.
    expect(second.reconciled).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.inserted).toBe(0);
  });

  it('does not touch created_at — a reconciliation is an identity repair, not a write', () => {
    const db = makeDb();
    insertEdge(db, edge(null, null, { created_at: '2026-01-01 00:00:00' }));

    mergeRows(db, EDGES_CONFIG, [
      edge('igris-ai', 'igris-ai', { created_at: '2026-08-12 00:00:00' }),
    ]);

    // THE ROW-COUNT ASSERT IS LEAD, NOT DECORATION. Without it this test
    // passes WITH THE BUG PRESENT: the unfixed merge inserts a second row, and
    // `[0]` is then the untouched original, so the timestamp check succeeds
    // while nothing was reconciled at all. Caught by running this file red.
    const rows = allEdges(db);
    expect(rows, 'must have reconciled, not inserted — else this test is vacuous').toHaveLength(1);

    // TD-338's discipline: no merge path writes a timestamp it did not receive.
    // If the adopt bumped created_at, the remote's `WHERE created_at > since`
    // would re-select the row forever.
    expect(rows[0].created_at).toBe('2026-01-01 00:00:00');
  });
});

// ---------------------------------------------------------------------------
// T2 — PULL: incoming NULL, stored qualified. THE DANGEROUS DIRECTION.
// ---------------------------------------------------------------------------

describe('BR-090 T2 — PULL retains the local attribution', () => {
  it('an unqualified edge merged over a qualified one leaves ONE row', () => {
    const db = makeDb();
    insertEdge(db, edge('igris-ai', 'igris-ai')); // what the local brain holds

    const result = mergeRows(db, EDGES_CONFIG, [edge(null, null)]); // from the VPS

    expect(allEdges(db)).toHaveLength(1);
    expect(result.reconciled).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.reconciliations?.[0].action).toBe('retained');
  });

  /**
   * THE ONE THAT KILLS THE PLAUSIBLE WRONG FIX.
   *
   * A symmetric implementation — "on a legacy-key match, copy the incoming
   * qualifiers across" — satisfies the row-count test above perfectly. It also
   * nulls out the attribution on the origin. Row count alone cannot tell the
   * two apart, so assert the VALUE.
   */
  it('the surviving row KEEPS the local qualifier and the incoming NULL is discarded', () => {
    const db = makeDb();
    insertEdge(db, edge('igris-ai', 'igris-ai'));

    mergeRows(db, EDGES_CONFIG, [edge(null, null)]);

    const rows = allEdges(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].from_project, 'a pull must never null out a local attribution').toBe('igris-ai');
    expect(rows[0].to_project, 'a pull must never null out a local attribution').toBe('igris-ai');
  });

  it('a genuinely new unqualified edge still inserts — retention is not a swallow-everything', () => {
    const db = makeDb();
    insertEdge(db, edge('igris-ai', 'igris-ai'));

    const result = mergeRows(db, EDGES_CONFIG, [
      edge(null, null, { from_id: 'BR-999' }), // shares no legacy key
    ]);

    expect(allEdges(db)).toHaveLength(2);
    expect(result.inserted).toBe(1);
    expect(result.reconciled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T3 — the conflict guard
// ---------------------------------------------------------------------------

describe('BR-090 T3 — a DIFFERENT attribution is never overwritten', () => {
  /**
   * Two rows sharing the legacy key with different non-NULL attributions are
   * genuinely different edges — `BR-082` in one project vs another is exactly
   * the ambiguity BR-083 existed to fix. Reconciling them would re-fuse what
   * BR-083 separated.
   */
  it('a qualified incoming edge inserts alongside a DIFFERENT qualified stored edge', () => {
    const db = makeDb();
    insertEdge(db, edge('other-project', 'other-project'));

    const result = mergeRows(db, EDGES_CONFIG, [edge('igris-ai', 'igris-ai')]);

    const rows = allEdges(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.from_project).sort()).toEqual(['igris-ai', 'other-project']);
    expect(result.inserted).toBe(1);
    expect(result.reconciled).toBe(0);
  });

  it('adopts ONLY the all-NULL row when both an attributed and an unattributed row exist', () => {
    const db = makeDb();
    insertEdge(db, edge('other-project', 'other-project'));
    insertEdge(db, edge(null, null));

    mergeRows(db, EDGES_CONFIG, [edge('igris-ai', 'igris-ai')]);

    const rows = allEdges(db);
    expect(rows).toHaveLength(2);
    // The foreign attribution is untouched; the NULL one took ours.
    expect(rows.map((r) => r.from_project).sort()).toEqual(['igris-ai', 'other-project']);
  });
});

// ---------------------------------------------------------------------------
// T4 — round-trip conservation, the property the brief asks for
// ---------------------------------------------------------------------------

describe('BR-090 T4 — a full round-trip conserves both counts', () => {
  /**
   * The operator's real shape, scaled down: a local brain with a mix of
   * qualified and unqualified edges, and a remote holding the same edges all
   * unqualified. Push then pull must return the local brain to EXACTLY where it
   * started — same total, same qualified count. A count that moves in either
   * direction is a failure, not a rounding.
   */
  it('push-then-pull leaves local totals and the qualified count unchanged', () => {
    const local = makeDb();
    const remote = makeDb();

    const ids = ['BR-001', 'BR-002', 'BR-003', 'BR-004'];
    // Local: first two qualified (BR-083's backfill), last two left NULL.
    ids.forEach((id, i) =>
      insertEdge(local, edge(i < 2 ? 'igris-ai' : null, i < 2 ? 'igris-ai' : null, { from_id: id })),
    );
    // Remote: every edge, all unqualified — an un-migrated replica.
    ids.forEach((id) => insertEdge(remote, edge(null, null, { from_id: id })));

    const countAll = (db: Database.Database): number =>
      (db.prepare('SELECT COUNT(*) n FROM entity_edges').get() as { n: number }).n;
    const countQualified = (db: Database.Database): number =>
      (
        db
          .prepare('SELECT COUNT(*) n FROM entity_edges WHERE from_project IS NOT NULL')
          .get() as { n: number }
      ).n;

    const localBefore = countAll(local);
    const qualifiedBefore = countQualified(local);
    expect(localBefore).toBe(4);
    expect(qualifiedBefore).toBe(2);

    // PUSH: local rows merged into the remote.
    mergeRows(remote, EDGES_CONFIG, allEdges(local));
    expect(countAll(remote), 'the push must not duplicate').toBe(4);
    expect(countQualified(remote), 'the remote should have gained our attributions').toBe(2);

    // PULL: remote rows merged back into local.
    mergeRows(local, EDGES_CONFIG, allEdges(remote));
    expect(countAll(local), 'the pull must not duplicate').toBe(localBefore);
    expect(
      countQualified(local),
      'the pull must not null out attributions',
    ).toBe(qualifiedBefore);
  });

  /**
   * PULL FIRST — THE SCENARIO THAT ACTUALLY HAPPENS.
   *
   * `/boot` pulls (boot-sync subsumes `igris_brain_pull`, FR-195) and `/hunt`
   * §3.5 pulls. So the FIRST sync any operator performs after BR-083 is a pull
   * into a qualified local brain from an unqualified remote — before any push
   * has had a chance to qualify the remote.
   *
   * The push-then-pull test above does NOT cover this: by the time its pull
   * runs, the push has already qualified the remote, so the retain branch never
   * fires. Found by mutating the fix to the symmetric wrong version and noticing
   * that test stayed green. The order of operations was load-bearing and
   * invisible.
   */
  it('PULL FIRST into a qualified local brain preserves every attribution', () => {
    const local = makeDb();
    const remote = makeDb();

    const ids = ['BR-001', 'BR-002', 'BR-003', 'BR-004'];
    ids.forEach((id, i) =>
      insertEdge(local, edge(i < 2 ? 'igris-ai' : null, i < 2 ? 'igris-ai' : null, { from_id: id })),
    );
    ids.forEach((id) => insertEdge(remote, edge(null, null, { from_id: id })));

    // No push has happened. This is `/boot` on a fresh session.
    const result = mergeRows(local, EDGES_CONFIG, allEdges(remote));

    const rows = allEdges(local);
    expect(rows, 'the pull must not duplicate into the origin').toHaveLength(4);
    expect(
      rows.filter((r) => r.from_project === 'igris-ai'),
      'the pull must not null out the local attributions',
    ).toHaveLength(2);
    // The two qualified rows are the ones reconciled; the two NULL ones match
    // on the full key and are ordinary append skips.
    expect(result.reconciled).toBe(2);
    expect(result.inserted).toBe(0);
    expect(result.reconciliations?.every((r) => r.action === 'retained')).toBe(true);
  });

  it('a SECOND round-trip is a no-op — the system reaches a fixed point', () => {
    const local = makeDb();
    const remote = makeDb();
    insertEdge(local, edge('igris-ai', 'igris-ai'));
    insertEdge(remote, edge(null, null));

    mergeRows(remote, EDGES_CONFIG, allEdges(local));
    mergeRows(local, EDGES_CONFIG, allEdges(remote));

    const second = mergeRows(remote, EDGES_CONFIG, allEdges(local));
    expect(second.reconciled).toBe(0);
    expect(second.inserted).toBe(0);
    expect(allEdges(remote)).toHaveLength(1);
    expect(allEdges(local)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T4b — the counts must add up, and must not lie in either direction
// ---------------------------------------------------------------------------

describe('BR-090 T4b — reconciliations are counted honestly', () => {
  it('every incoming row lands in exactly one outcome bucket', () => {
    const db = makeDb();
    insertEdge(db, edge(null, null, { from_id: 'BR-001' })); // will be adopted
    insertEdge(db, edge('igris-ai', 'igris-ai', { from_id: 'BR-002' })); // will be retained
    insertEdge(db, edge(null, null, { from_id: 'BR-003' })); // exact match -> skip

    const incoming = [
      edge('igris-ai', 'igris-ai', { from_id: 'BR-001' }),
      edge(null, null, { from_id: 'BR-002' }),
      edge(null, null, { from_id: 'BR-003' }),
      edge('igris-ai', 'igris-ai', { from_id: 'BR-004' }), // genuinely new -> insert
    ];
    const r = mergeRows(db, EDGES_CONFIG, incoming);

    // No row may be double-counted or silently dropped: the buckets must
    // partition the input exactly.
    expect(r.inserted + r.updated + r.skipped + r.failed + r.reconciled).toBe(incoming.length);
    expect(r.reconciled).toBe(2);
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('adopted and retained are distinguishable — a caller can tell a write from a no-op', () => {
    const db = makeDb();
    insertEdge(db, edge(null, null, { from_id: 'BR-001' }));
    insertEdge(db, edge('igris-ai', 'igris-ai', { from_id: 'BR-002' }));

    const r = mergeRows(db, EDGES_CONFIG, [
      edge('igris-ai', 'igris-ai', { from_id: 'BR-001' }),
      edge(null, null, { from_id: 'BR-002' }),
    ]);

    const actions = (r.reconciliations ?? []).map((x) => x.action).sort();
    // `handleBrainPull` adds ONLY the adopted ones to `Total merged`. If these
    // ever collapse into one undifferentiated count, that report silently
    // becomes either a lie (retained inflating it) or a lie the other way
    // (adopted vanishing from it).
    expect(actions).toEqual(['adopted', 'retained']);
  });
});

// ---------------------------------------------------------------------------
// T5 — scope: no other table is affected, and none is silently exposed
// ---------------------------------------------------------------------------

describe('BR-090 T5 — the reconciliation is scoped, and the audit is recorded', () => {
  it('entity_edges is the ONLY table declaring a widened key', () => {
    const declaring = SYNC_TABLES.filter((c) => c.legacySyncKey || c.qualifierCols).map(
      (c) => c.table,
    );
    // The brief's AC: "Every other `append` table is checked for a widened
    // syncKey, and the result recorded either way." This IS the record. If a
    // future brief widens another key, it must add the table here deliberately
    // — the failure is the prompt to think about the replica migration.
    expect(declaring).toEqual(['entity_edges']);
  });

  it('every declared config is internally consistent', () => {
    const declared = SYNC_TABLES.filter((c) => c.legacySyncKey || c.qualifierCols);

    // GUARD AGAINST A VACUOUS PASS. Without this, the loop below `continue`s
    // over all 20 tables when nothing declares and the test asserts NOTHING
    // while reporting green — the same empty-iteration failure this session
    // found seven times elsewhere. Caught by running this file red.
    expect(declared.length, 'nothing declared — the loop below would assert nothing').toBeGreaterThan(0);

    for (const cfg of declared) {

      expect(cfg.legacySyncKey, `${cfg.table}: qualifierCols without legacySyncKey`).toBeDefined();
      expect(cfg.qualifierCols, `${cfg.table}: legacySyncKey without qualifierCols`).toBeDefined();

      const legacy = cfg.legacySyncKey ?? [];
      const quals = cfg.qualifierCols ?? [];

      // legacySyncKey + qualifierCols must reconstitute syncKey exactly as a
      // set. If they drift, the fallback would key on the wrong identity —
      // silently, and in the direction of fusing unrelated rows.
      expect(new Set([...legacy, ...quals]), `${cfg.table}: legacy+qualifiers != syncKey`).toEqual(
        new Set(cfg.syncKey),
      );
      for (const q of quals) {
        expect(cfg.syncKey, `${cfg.table}: qualifier ${q} not in syncKey`).toContain(q);
        expect(cfg.columns, `${cfg.table}: qualifier ${q} not in columns`).toContain(q);
      }
    }
  });

  it('a table with NO legacySyncKey still duplicates across a key change — proving scope', () => {
    // Deliberately construct the un-opted-in case: same shape as entity_edges
    // but with the declaration stripped. It MUST insert, which is what makes
    // "only declared tables are affected" a measured claim rather than a hope.
    const db = makeDb();
    insertEdge(db, edge(null, null));

    const stripped: SyncTableConfig = {
      ...EDGES_CONFIG,
      legacySyncKey: undefined,
      qualifierCols: undefined,
    };
    const result = mergeRows(db, stripped, [edge('igris-ai', 'igris-ai')]);

    expect(allEdges(db)).toHaveLength(2);
    expect(result.inserted).toBe(1);
    expect(result.reconciled).toBe(0);
  });
});
