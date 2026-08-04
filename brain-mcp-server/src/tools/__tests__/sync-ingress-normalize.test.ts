/**
 * TD-338 — replication INGRESS normalization.
 *
 * `mergeRows` is the only row writer for inbound sync in this package, reached
 * from BOTH directions (`handleBrainPull` when we pull a remote, and
 * `processSyncPush` — the body of `POST /sync/push` — when a remote pushes to
 * us). Before TD-338 it copied every non-mergeField column with
 * `row[col] ?? null`, so replication wrote spellings that
 * `igris_brief_create` would have folded, straight into the columns the write
 * boundary defends.
 *
 * These tests drive the REAL `mergeRows` / `processSyncPush` against a REAL
 * in-memory SQLite DB. No mock of the code under test (L-159 / TD-098) — the
 * bug surface IS the merge, so mocking it would erase what is being defended.
 *
 * @module tools/__tests__/sync-ingress-normalize.test
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import {
  mergeRows,
  processSyncPush,
  SYNC_TABLES,
  type SyncTableConfig,
} from '../sync.js';
import { SYNC_NORMALIZED_FIELDS, normalizeSyncRow } from '../brief-normalize.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BRIEF_STATUS_CONFIG: SyncTableConfig = (() => {
  const cfg = SYNC_TABLES.find((c) => c.table === 'brief_status');
  if (!cfg) throw new Error('brief_status missing from SYNC_TABLES');
  return cfg;
})();

const LEARNINGS_CONFIG: SyncTableConfig = (() => {
  const cfg = SYNC_TABLES.find((c) => c.table === 'learnings');
  if (!cfg) throw new Error('learnings missing from SYNC_TABLES');
  return cfg;
})();

/** Production-shaped `brief_status` + a `learnings` table for the scope guard. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_type TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      effort TEXT,
      phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_brief_status_unique ON brief_status(project, brief_id);

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tags TEXT DEFAULT '',
      scope TEXT DEFAULT 'project',
      source_brief TEXT,
      confidence REAL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT,
      review_status TEXT,
      provenance TEXT,
      source_extractor TEXT
    );
  `);
  return db;
}

/** An inbound wire row carrying the exact spellings the live VPS still holds. */
function dirtyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: 'moca-ai-agent',
    brief_id: 'BR-045',
    brief_type: 'TD',
    title: 'HR read tools on mocasmart-mcp',
    status: 'Done',
    priority: 'P2',
    effort: 'L-Large',
    phase: 'building',
    updated_at: '2026-08-04 00:00:00',
    ...overrides,
  };
}

function readRow(db: Database.Database, briefId = 'BR-045'): Record<string, unknown> {
  return db
    .prepare('SELECT * FROM brief_status WHERE brief_id = ?')
    .get(briefId) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// T1 — AC-2 PROOF: an inbound sync row carrying a non-canonical value is folded
// ---------------------------------------------------------------------------

describe('TD-338 T1 — AC-2: inbound sync rows are folded at ingress', () => {
  it('folds on the INSERT branch (no existing local row)', () => {
    const db = makeDb();

    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [dirtyRow()]);

    expect(result.inserted).toBe(1);
    const stored = readRow(db);
    // Assert the EMITTED VALUES, not just the counter.
    expect(stored.priority).toBe('P2-Medium');
    expect(stored.brief_type).toBe('Technical Debt');
    expect(stored.phase).toBe('BUILDING');
    // Untouched columns survive verbatim.
    expect(stored.title).toBe('HR read tools on mocasmart-mcp');
    expect(stored.status).toBe('Done');
    expect(stored.effort).toBe('L-Large');

    expect(result.normalized).toBe(1);
    expect(result.normalizations).toEqual(
      expect.arrayContaining([
        { key: 'moca-ai-agent|BR-045', field: 'priority', from: 'P2', to: 'P2-Medium' },
        { key: 'moca-ai-agent|BR-045', field: 'brief_type', from: 'TD', to: 'Technical Debt' },
        { key: 'moca-ai-agent|BR-045', field: 'phase', from: 'building', to: 'BUILDING' },
      ]),
    );
    expect(result.normalizations).toHaveLength(3);
    expect(result.nonCanonical).toBeUndefined();
  });

  it('folds on the LWW-UPDATE branch (existing OLDER local row)', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
       VALUES ('moca-ai-agent','BR-045','Feature','old title','Ready','P3-Low','S','INIT','2026-01-01 00:00:00')`,
    ).run();

    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [dirtyRow()]);

    expect(result.updated).toBe(1);
    const stored = readRow(db);
    expect(stored.priority).toBe('P2-Medium');
    expect(stored.brief_type).toBe('Technical Debt');
    expect(stored.phase).toBe('BUILDING');
    expect(result.normalized).toBe(1);
  });

  it('folds on the POST /sync/push path too (a remote pushing INTO us)', () => {
    const db = makeDb();

    const { results, ok } = processSyncPush(db, { brief_status: [dirtyRow()] });

    expect(ok).toBe(true);
    expect(readRow(db).priority).toBe('P2-Medium');
    // The pushing machine learns its row was folded on arrival.
    expect(results.brief_status.normalized).toBe(1);
    expect(results.brief_status.normalizations).toBeDefined();
  });

  it('counts ROWS in `normalized`, and lists every field in `normalizations`', () => {
    const db = makeDb();

    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [
      dirtyRow(),
      dirtyRow({ brief_id: 'BR-046', priority: 'P1', brief_type: 'Feature', phase: 'COMPLETE' }),
    ]);

    expect(result.inserted).toBe(2);
    expect(result.normalized).toBe(2); // two rows...
    expect(result.normalizations).toHaveLength(4); // ...3 fields + 1 field
  });
});

// ---------------------------------------------------------------------------
// T3 — AC-3 EXECUTABLE: the no-oscillation property, pinned as a test
// ---------------------------------------------------------------------------

describe('TD-338 T3 — AC-3: the fold does not bump updated_at, so it cannot fight', () => {
  it('stores the INBOUND updated_at byte-for-byte on a folded INSERT', () => {
    const db = makeDb();
    const inbound = dirtyRow({ updated_at: '2026-08-04 11:22:33' });

    mergeRows(db, BRIEF_STATUS_CONFIG, [inbound]);

    expect(readRow(db).updated_at).toBe('2026-08-04 11:22:33');
  });

  it('stores the INBOUND updated_at byte-for-byte on a folded LWW UPDATE', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, phase, updated_at)
       VALUES ('moca-ai-agent','BR-045','Feature','old','Ready','P3-Low','INIT','2026-01-01 00:00:00')`,
    ).run();

    mergeRows(db, BRIEF_STATUS_CONFIG, [dirtyRow({ updated_at: '2026-08-04 11:22:33' })]);

    expect(readRow(db).updated_at).toBe('2026-08-04 11:22:33');
  });

  it('re-merging the SAME inbound row is skipped — equal timestamps, no counter-write', () => {
    const db = makeDb();
    const inbound = dirtyRow();

    const first = mergeRows(db, BRIEF_STATUS_CONFIG, [inbound]);
    expect(first.inserted).toBe(1);
    expect(first.normalized).toBe(1);

    // The remote is unchanged, so it re-serves the same row on any cursor
    // reset. Our stored `updated_at` equals the inbound one, so
    // `remoteTs > localTs` is FALSE and the merge skips — the fixed point is
    // reached on the FIRST arrival of each row version.
    const second = mergeRows(db, BRIEF_STATUS_CONFIG, [inbound]);
    expect(second.skipped).toBe(1);
    expect(second.updated).toBe(0);
    expect(second.normalized).toBe(0); // a skipped row is never counted (T5)
    expect(second.normalizations).toBeUndefined();

    // ...and the stored value stays canonical rather than reverting.
    expect(readRow(db).priority).toBe('P2-Medium');
  });

  it('our next PUSH carries equal timestamps, so an un-migrated remote skips it', () => {
    // Model the remote as a second brain running the SAME mergeRows against a
    // row it already holds at the same timestamp. This is the receiving half
    // of `POST /sync/push`, driven for real rather than argued in prose.
    const remote = makeDb();
    remote
      .prepare(
        `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, phase, updated_at)
         VALUES ('moca-ai-agent','BR-045','TD','HR read tools on mocasmart-mcp','Done','P2','building','2026-08-04 00:00:00')`,
      )
      .run();

    const local = makeDb();
    mergeRows(local, BRIEF_STATUS_CONFIG, [dirtyRow()]);
    const folded = readRow(local);
    expect(folded.priority).toBe('P2-Medium');

    // Push our folded row upstream — the egress SELECT emits what we store.
    const pushed = remote.transaction(() =>
      mergeRows(remote, BRIEF_STATUS_CONFIG, [folded]),
    )();

    expect(pushed.skipped).toBe(1);
    expect(pushed.updated).toBe(0);
    // The remote keeps ITS spelling: a silent content divergence at equal
    // timestamps, which is inert for sync. The fold does not travel up.
    expect(readRow(remote).priority).toBe('P2');
  });

  it('updated_at is not in SYNC_NORMALIZED_FIELDS, so no fold can reach it', () => {
    // The invariant every claim above rests on — asserted, not commented.
    expect(Object.keys(SYNC_NORMALIZED_FIELDS.brief_status)).not.toContain('updated_at');
    expect(SYNC_NORMALIZED_FIELDS.brief_status).toEqual({
      brief_type: 'brief_type',
      priority: 'priority',
      phase: 'phase',
      // TD-333 — `status`, the canonical build-state source, joins the map.
      status: 'status',
    });
    // ...including for a row whose updated_at is itself a foldable-looking string.
    const { row, folds } = normalizeSyncRow('brief_status', {
      project: 'p',
      brief_id: 'b',
      updated_at: 'P2',
    });
    expect(row.updated_at).toBe('P2');
    expect(folds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T4 — unknown values pass through untouched and are REPORTED
// ---------------------------------------------------------------------------

describe('TD-338 T4 — the fold never invents', () => {
  it('stores P4-Trivial / Spike verbatim, counts 0 folds, and reports both', () => {
    const db = makeDb();

    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [
      dirtyRow({ priority: 'P4-Trivial', brief_type: 'Spike', phase: 'COMPLETE' }),
    ]);

    const stored = readRow(db);
    expect(stored.priority).toBe('P4-Trivial');
    expect(stored.brief_type).toBe('Spike');

    expect(result.normalized).toBe(0);
    expect(result.normalizations).toBeUndefined();
    expect(result.nonCanonical).toEqual([
      { key: 'moca-ai-agent|BR-045', field: 'brief_type', value: 'Spike' },
      { key: 'moca-ai-agent|BR-045', field: 'priority', value: 'P4-Trivial' },
    ]);
  });

  it('reports a value that was folded but is STILL not canonical', () => {
    const db = makeDb();
    // `normalizePhase` upper-cases an unknown phase only when it matches a
    // canonical member; 'Deferred' is unknown, so it passes through verbatim.
    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [
      dirtyRow({ priority: 'P1-High', brief_type: 'Feature', phase: 'Deferred' }),
    ]);

    expect(readRow(db).phase).toBe('Deferred');
    expect(result.nonCanonical).toEqual([
      { key: 'moca-ai-agent|BR-045', field: 'phase', value: 'Deferred' },
    ]);
  });

  it('treats a NULL / empty priority as UNSET, not as an offender', () => {
    const db = makeDb();

    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [
      dirtyRow({ priority: null, brief_type: 'Feature', phase: 'COMPLETE' }),
      dirtyRow({ brief_id: 'BR-046', priority: '', brief_type: 'Feature', phase: 'COMPLETE' }),
    ]);

    expect(readRow(db, 'BR-045').priority).toBeNull();
    // The unset family folds to SQL NULL (the dashboard renders NULL "Unset").
    expect(readRow(db, 'BR-046').priority).toBeNull();
    expect(result.nonCanonical).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T5 — LWW precedence is unchanged; a skipped row is never folded
// ---------------------------------------------------------------------------

describe('TD-338 T5 — the fold cannot resurrect a stale row', () => {
  it('skips an OLDER inbound row entirely and leaves the local value alone', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, phase, updated_at)
       VALUES ('moca-ai-agent','BR-045','Feature','current','Ready','P3-Low','INIT','2026-08-04 00:00:00')`,
    ).run();

    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [
      dirtyRow({ updated_at: '2020-01-01 00:00:00' }),
    ]);

    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
    const stored = readRow(db);
    expect(stored.priority).toBe('P3-Low');
    expect(stored.title).toBe('current');
    // The stale row's foldable values never reach the report.
    expect(result.normalized).toBe(0);
    expect(result.normalizations).toBeUndefined();
    expect(result.nonCanonical).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T6 — scope guard: unmapped tables are byte-identical to pre-TD-338 behaviour
// ---------------------------------------------------------------------------

describe('TD-338 T6 — the hook is brief_status-scoped', () => {
  it('copies a learnings row verbatim, with zero folds', () => {
    const db = makeDb();
    const row = {
      project: 'igris-ai',
      title: 'P2',            // a string the priority fold WOULD have rewritten
      category: 'pattern',
      content: 'TD',          // ...and one the brief_type fold would have
      tags: 'b,a',
      scope: 'project',
      source_brief: null,
      confidence: 0.8,
      created_at: '2026-08-04 00:00:00',
      updated_at: '2026-08-04 00:00:00',
      access_count: 3,
      last_accessed_at: null,
      review_status: null,
      provenance: null,
      source_extractor: null,
    };

    const result = mergeRows(db, LEARNINGS_CONFIG, [row]);

    expect(result.inserted).toBe(1);
    expect(result.normalized).toBe(0);
    expect(result.normalizations).toBeUndefined();
    expect(result.nonCanonical).toBeUndefined();
    const stored = db.prepare('SELECT * FROM learnings').get() as Record<string, unknown>;
    expect(stored.title).toBe('P2');
    expect(stored.content).toBe('TD');
  });

  it('normalizeSyncRow returns the SAME object for an unmapped table', () => {
    const row = { project: 'p', title: 'P2' };
    expect(normalizeSyncRow('learnings', row).row).toBe(row);
  });

  it('normalizeSyncRow returns the SAME object for an already-canonical row', () => {
    const row = {
      project: 'p',
      brief_id: 'b',
      priority: 'P2-Medium',
      brief_type: 'Technical Debt',
      phase: 'COMPLETE',
    };
    expect(normalizeSyncRow('brief_status', row).row).toBe(row);
  });

  it('never introduces a key the inbound row did not carry', () => {
    // The INSERT branch filters on `!== undefined`; a fold that materialized an
    // absent column would silently widen the INSERT column list.
    const row = { project: 'p', brief_id: 'b', updated_at: '2026-08-04 00:00:00' };
    const { row: out } = normalizeSyncRow('brief_status', row);
    expect(Object.keys(out).sort()).toEqual(['brief_id', 'project', 'updated_at']);
  });
});

// ---------------------------------------------------------------------------
// Idempotence — the property the whole no-oscillation argument rests on
// ---------------------------------------------------------------------------

describe('TD-338 — normalizeSyncRow is idempotent', () => {
  it('f(f(x)) === f(x) for every alias in the live corpus shapes', () => {
    const inputs = ['P0', 'P1', 'P2', 'P3', 'P1 - High', 'p2-medium', 'Unset', '', 'P4-Trivial'];
    for (const priority of inputs) {
      const once = normalizeSyncRow('brief_status', { priority }).row;
      const twice = normalizeSyncRow('brief_status', once).row;
      expect(twice.priority).toEqual(once.priority);
      // A second pass folds nothing — the first reached the fixed point.
      expect(normalizeSyncRow('brief_status', once).folds).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// TD-333 — `status`, the CANONICAL BUILD-STATE SOURCE, folds at ingress too
// ---------------------------------------------------------------------------

describe('TD-333 T6 — the status fold at the BRAIN ingress door', () => {
  it('folds InProgress -> In Progress on the INSERT branch', () => {
    const db = makeDb();

    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [
      dirtyRow({
        brief_id: 'BR-002',
        status: 'InProgress',
        // hold the other three fields canonical so `status` is the only mover
        brief_type: 'Feature',
        priority: 'P1-High',
        phase: 'BUILDING',
      }),
    ]);

    expect(result.inserted).toBe(1);
    expect(readRow(db, 'BR-002').status).toBe('In Progress');
    expect(result.normalized).toBe(1);
    expect(result.normalizations).toEqual([
      {
        key: 'moca-ai-agent|BR-002',
        field: 'status',
        from: 'InProgress',
        to: 'In Progress',
      },
    ]);
    expect(result.nonCanonical).toBeUndefined();
  });

  it('folds Completed -> Done on the LWW-UPDATE branch', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
       VALUES ('moca-ai-agent','BR-045','Feature','old title','Ready','P3-Low','S','INIT','2026-01-01 00:00:00')`,
    ).run();

    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [
      dirtyRow({ status: 'Completed', brief_type: 'Feature', priority: 'P1-High', phase: 'BUILDING' }),
    ]);

    expect(result.updated).toBe(1);
    expect(readRow(db).status).toBe('Done');
    expect(result.normalized).toBe(1);
  });

  it('folds on the POST /sync/push path too, and tells the pusher', () => {
    const db = makeDb();

    const { results, ok } = processSyncPush(db, {
      brief_status: [dirtyRow({ status: 'Complete' })],
    });

    expect(ok).toBe(true);
    expect(readRow(db).status).toBe('Done');
    expect(results.brief_status.normalizations).toEqual(
      expect.arrayContaining([
        { key: 'moca-ai-agent|BR-045', field: 'status', from: 'Complete', to: 'Done' },
      ]),
    );
  });

  it('stores the INBOUND updated_at byte-for-byte on a status-folded row', () => {
    // THE NO-BUMP GUARANTEE, re-armed for the fourth normalizer. `status` is an
    // LWW-synced column (sync.ts SYNC_TABLES), so a fold that bumped
    // `updated_at` would manufacture a write no operator made.
    const db = makeDb();
    const inbound = dirtyRow({ status: 'Completed', updated_at: '2026-08-04 11:22:33' });

    mergeRows(db, BRIEF_STATUS_CONFIG, [inbound]);

    expect(readRow(db).status).toBe('Done');
    expect(readRow(db).updated_at).toBe('2026-08-04 11:22:33');
  });

  it('re-merging the SAME folded row is skipped — the fixed point holds', () => {
    const db = makeDb();
    const inbound = dirtyRow({ status: 'Completed' });

    mergeRows(db, BRIEF_STATUS_CONFIG, [inbound]);
    const second = mergeRows(db, BRIEF_STATUS_CONFIG, [inbound]);

    expect(second.skipped).toBe(1);
    expect(second.updated).toBe(0);
    expect(readRow(db).status).toBe('Done');
  });
});

describe('TD-333 T8 — the status fold never invents', () => {
  it('stores a MISSING STATE verbatim and REPORTS it', () => {
    const db = makeDb();

    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [
      dirtyRow({ status: 'Cancelled', brief_type: 'Feature', priority: 'P1-High', phase: 'BUILDING' }),
    ]);

    expect(readRow(db).status).toBe('Cancelled');
    expect(result.normalized).toBe(0);
    expect(result.normalizations).toBeUndefined();
    expect(result.nonCanonical).toEqual([
      { key: 'moca-ai-agent|BR-045', field: 'status', value: 'Cancelled' },
    ]);
  });

  it('stores a SENTENCE status verbatim and REPORTS it — no truncation, no fold', () => {
    // TD-333 §5.3: `Done`, `Archived` and `Superseded` are all defensible
    // readings of "split into children" and the operator picked none of them.
    // Choosing one would be a STATE EDIT (TD-311). The 66-character value must
    // survive the wire byte-for-byte.
    const db = makeDb();
    const sentence = 'Split (see FR-161, FR-162, FR-163, FR-164, FR-165, FR-166, FR-167)';

    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [
      dirtyRow({ status: sentence, brief_type: 'Feature', priority: 'P1-High', phase: 'BUILDING' }),
    ]);

    expect(readRow(db).status).toBe(sentence);
    expect(result.normalizations).toBeUndefined();
    expect(result.nonCanonical).toEqual([
      { key: 'moca-ai-agent|BR-045', field: 'status', value: sentence },
    ]);
  });

  it('stores the WELDED-PAYLOAD status verbatim — the sha has no other copy', () => {
    const db = makeDb();
    const welded = 'Done(Resolvedbydec8d1f)';

    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [
      dirtyRow({ status: welded, brief_type: 'Feature', priority: 'P1-High', phase: 'BUILDING' }),
    ]);

    expect(readRow(db).status).toBe(welded);
    expect(result.nonCanonical).toEqual([
      { key: 'moca-ai-agent|BR-045', field: 'status', value: welded },
    ]);
  });

  it('does NOT fold an empty status to NULL — `status` is TEXT NOT NULL', () => {
    // The asymmetry that keeps the never-hard-reject posture true. If
    // `normalizeStatus` folded '' to null the way its three siblings do, this
    // row would violate NOT NULL and mergeRows' per-row try/catch would DROP it
    // — replication silently losing an operator's brief.
    const db = makeDb();

    const result = mergeRows(db, BRIEF_STATUS_CONFIG, [
      dirtyRow({ status: '', brief_type: 'Feature', priority: 'P1-High', phase: 'BUILDING' }),
    ]);

    expect(result.inserted).toBe(1);
    expect(result.errors ?? []).toEqual([]);
    expect(readRow(db).status).toBe('');
    // RESIDUAL, pinned rather than hidden: the shared reporter skips a stored
    // value whose trim() is empty (correct for the three NULLABLE fields), so
    // an empty status arrives unreported. Zero such rows exist in any brain.
    expect(result.nonCanonical).toBeUndefined();
  });
});

describe('TD-333 T15 — the status hook is brief_status-scoped', () => {
  it('leaves a `status`-bearing row in an UNMAPPED table byte-identical', () => {
    // `status` is a column name several tables carry, so the scope guard is
    // load-bearing in a way it was not for `brief_type`/`priority`/`phase`.
    for (const table of ['learnings', 'goals', 'projects', 'not_a_sync_table']) {
      const row = { project: 'p', id: 1, status: 'Completed', phase: 'building' };
      const out = normalizeSyncRow(table, row);
      expect(out.row, table).toBe(row); // SAME object — nothing allocated
      expect(out.row.status, table).toBe('Completed');
      expect(out.folds, table).toEqual([]);
      expect(out.nonCanonical, table).toEqual([]);
    }
  });

  it('copies a learnings row carrying a `status` column verbatim through mergeRows', () => {
    const db = makeDb();
    const before = db.prepare('SELECT * FROM learnings').all();
    expect(before).toEqual([]);

    const result = mergeRows(db, LEARNINGS_CONFIG, [
      {
        project: 'igris-ai',
        title: 'Done',
        category: 'InProgress', // a string the status fold WOULD have rewritten
        content: 'Completed', // ...and another
        tags: '',
        scope: 'project',
        source_brief: null,
        confidence: 0.8,
        created_at: '2026-08-04 00:00:00',
        updated_at: '2026-08-04 00:00:00',
        access_count: 0,
        last_accessed_at: null,
        review_status: null,
        provenance: null,
        source_extractor: null,
      },
    ]);

    expect(result.inserted).toBe(1);
    expect(result.normalized).toBe(0);
    const stored = db.prepare('SELECT * FROM learnings').get() as Record<string, unknown>;
    expect(stored.content).toBe('Completed');
    expect(stored.category).toBe('InProgress');
  });
});
