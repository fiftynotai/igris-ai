/**
 * FR-240 — `tools/memory-read.ts` unit tests, including the AC #2 recall gates.
 *
 * AC #2 says the learnings search must "demonstrably use hybrid BM25+vector
 * recall, not substring matching". The plan (§4) names silent BM25 fallback as
 * the brief's single most likely INVISIBLE failure: `isVectorSearchAvailable`
 * probes `SELECT vec_version()` on THAT connection, so a handle that never
 * loaded sqlite-vec quietly takes the BM25-only arm and still returns plausible
 * rows. The `retrieval` block exists to make that observable, and the paired
 * gates below exist to make the observation trustworthy.
 *
 * GATE PAIRING (FR-239 learnings 1092/1093)
 * -----------------------------------------
 *   G-HS-1 (vector arm ran) is asserted against a ZERO-LEXICAL-OVERLAP row —
 *   a row BM25 provably cannot return for the query.
 *   G-HS-2 (negative control) reruns the identical corpus and query with the
 *   vector arm removed and asserts the row DISAPPEARS. Without G-HS-2, G-HS-1
 *   passes on a lucky FTS tokenisation and proves nothing.
 *
 * WHAT THESE GATES DO NOT PROVE
 * -----------------------------
 *  - Ranking quality, or that the RRF weights are right — unchanged by FR-240.
 *  - That the MCP wrapper's prose is unchanged. **Sibling:**
 *    `wrapper-wire-parity.test.ts`.
 *  - That a REAL sqlite-vec extension behaves like this double. The vector arm
 *    is faked here (the brain's own suites do the same — `:memory:` DBs have no
 *    extension). The real-extension question is a RUNTIME one and is answered
 *    by the FR-240 Phase-2 bridge probe, not by a unit test. Stated so nobody
 *    reads a green here as "sqlite-vec works on a readonly handle".
 *
 * @module tools/__tests__/memory-read.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

const { fakeEmbedding } = vi.hoisted(() => {
  function fakeEmbedding(text: string): Float32Array {
    const arr = new Float32Array(384);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < 384; i++) {
      hash = ((hash << 5) - hash + i) | 0;
      arr[i] = (hash & 0xffff) / 0xffff;
    }
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < 384; i++) arr[i] /= norm;
    return arr;
  }
  return { fakeEmbedding };
});

/**
 * The vector-arm double.
 *
 * `available` models `SELECT vec_version()` succeeding on the connection;
 * `hits` is the KNN result the extension would return. Both are per-test knobs
 * precisely so the SAME corpus can be driven through both arms.
 */
const vec = {
  available: false,
  hits: [] as number[],
  embeddingThrows: null as Error | null,
};

vi.mock('../../utils/embeddings.js', () => ({
  generateEmbedding: vi.fn(async (text: string) => {
    if (vec.embeddingThrows) throw vec.embeddingThrows;
    return fakeEmbedding(text);
  }),
  embeddingToBuffer: vi.fn(),
  bufferToEmbedding: vi.fn(),
  isEmbeddingAvailable: vi.fn(() => true),
  processInBatches: vi.fn(),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DIMENSIONS: 384,
}));

vi.mock('../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => vec.available),
  insertEmbedding: vi.fn(),
  deleteEmbedding: vi.fn(),
  vectorSearch: vi.fn((_db: unknown, _q: Float32Array, limit: number) =>
    vec.hits.slice(0, limit).map((rowid, i) => ({ rowid, distance: (i + 1) * 0.1 })),
  ),
  insertEmbeddingInto: vi.fn(),
  deleteEmbeddingFrom: vi.fn(),
  vectorSearchFrom: vi.fn(() => []),
}));

import {
  listLearnings,
  getLearning,
  hybridSearchLearnings,
} from '../memory-read.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let db: Database.Database;

/**
 * Rows chosen so filters DISAGREE (G-EP-1) and so one row has ZERO lexical
 * overlap with the probe query (the FR-215 low-overlap-band construction).
 *
 *  id | project  | category | scope  | provenance | review_status | note
 *   1 | igris-ai | pattern  | global | observed   | approved      | contains "wrapper"
 *   2 | igris-ai | mistake  | local  | inferred   | approved      | contains "wrapper"
 *   3 | other    | decision | local  | observed   | approved      | ZERO overlap with "wrapper"
 *   4 | igris-ai | discovery| local  | inferred   | pending_review| contains "wrapper"
 */
function makeDb(): Database.Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, tags TEXT DEFAULT '', tech_stack TEXT DEFAULT '',
      scope TEXT DEFAULT 'local', source_brief TEXT DEFAULT '',
      confidence REAL DEFAULT 0.8,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      access_count INTEGER DEFAULT 0, last_accessed_at TEXT,
      provenance TEXT NOT NULL DEFAULT 'observed',
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual',
      -- FR-241: perception/schema.ts:106 (TD-086) and janitor/schema.ts:109
      -- (FR-116 M3). listLearnings projects both so a triage caller can tell
      -- a SOFT reject (seen_again_count > 0) from a HARD one before it fires.
      seen_again_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      promoted_to_doc TEXT,
      deleted_at TEXT
    );
    CREATE VIRTUAL TABLE learnings_fts USING fts5(
      title, content, tags, tech_stack, content=learnings, content_rowid=id
    );
    CREATE TRIGGER learnings_ai AFTER INSERT ON learnings BEGIN
      INSERT INTO learnings_fts(rowid, title, content, tags, tech_stack)
      VALUES (new.id, new.title, new.content, new.tags, new.tech_stack);
    END;
  `);
  const ins = d.prepare(
    `INSERT INTO learnings
       (project, category, title, content, tags, tech_stack, scope, source_brief,
        confidence, created_at, updated_at, access_count, provenance,
        review_status, source_extractor, promoted_to_doc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run('igris-ai', 'pattern', 'Wrapper split', 'The MCP handler becomes a thin wrapper over the reader.', 'brain', 'ts', 'global', 'FR-237', 0.9, '2026-07-01 10:00:00', '2026-07-01 10:00:00', 5, 'observed', 'approved', 'manual', null);
  ins.run('igris-ai', 'mistake', 'Wrapper drift', 'A wrapper that reimplements its reader drifts silently.', 'brain', 'ts', 'local', 'FR-240', 0.8, '2026-07-02 10:00:00', '2026-07-02 10:00:00', 0, 'inferred', 'approved', 'manual', null);
  ins.run('other', 'decision', 'Ceramic kiln schedule', 'Bisque firing peaks at cone 04 overnight.', 'pottery', '', 'local', '', 0.7, '2026-07-03 10:00:00', '2026-07-03 10:00:00', 2, 'observed', 'approved', 'manual', 'doc.md#1');
  ins.run('igris-ai', 'discovery', 'Pending wrapper note', 'A pending wrapper candidate awaiting review.', 'perception', '', 'local', '', 0.4, '2026-07-04 10:00:00', '2026-07-04 10:00:00', 0, 'inferred', 'pending_review', 'llm', null);
  return d;
}

beforeEach(() => {
  db = makeDb();
  vec.available = false;
  vec.hits = [];
  vec.embeddingThrows = null;
});

afterEach(() => {
  db.close();
  vi.clearAllMocks();
});

const ids = (r: { rows: { id: number }[] }): number[] => r.rows.map((e) => e.id);

// ---------------------------------------------------------------------------
// listLearnings — the NEW query (G1)
// ---------------------------------------------------------------------------

describe('listLearnings — the query FR-240 added (G1)', () => {
  it('lists newest-first with count/total/limit/offset', () => {
    const r = listLearnings(db);
    expect(r.learnings.map((l) => l.id)).toEqual([4, 3, 2, 1]);
    expect(r.count).toBe(4);
    expect(r.total).toBe(4);
    expect(r.limit).toBe(50);
    expect(r.offset).toBe(0);
    expect(r.degraded).toBeNull();
  });

  it('D7 — a list row carries NO content, only its length', () => {
    const row = listLearnings(db, { limit: 1 }).learnings[0];
    expect(Object.keys(row)).not.toContain('content');
    expect(row.content_length).toBe(
      (db.prepare('SELECT LENGTH(content) AS n FROM learnings WHERE id = 4').get() as { n: number })
        .n,
    );
  });

  it('paginates stably even when created_at ties (the id tiebreak)', () => {
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, created_at, updated_at)
       VALUES ('igris-ai','pattern','Tie A','a','2026-07-04 10:00:00','2026-07-04 10:00:00')`,
    ).run();
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, created_at, updated_at)
       VALUES ('igris-ai','pattern','Tie B','b','2026-07-04 10:00:00','2026-07-04 10:00:00')`,
    ).run();
    const seen: number[] = [];
    for (let offset = 0; offset < 6; offset += 2) {
      seen.push(...listLearnings(db, { limit: 2, offset }).learnings.map((l) => l.id));
    }
    // Every row exactly once — the property a `created_at`-only ORDER BY loses
    // the moment two rows share a second.
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('each filter binds — assert the exclusions, not just the inclusions', () => {
    expect(listLearnings(db, { project: 'other' }).learnings.map((l) => l.id)).toEqual([3]);
    expect(listLearnings(db, { category: 'mistake' }).learnings.map((l) => l.id)).toEqual([2]);
    expect(listLearnings(db, { scope: 'global' }).learnings.map((l) => l.id)).toEqual([1]);
    expect(listLearnings(db, { provenance: 'inferred' }).learnings.map((l) => l.id)).toEqual([4, 2]);
    expect(listLearnings(db, { review_status: 'approved' }).learnings.map((l) => l.id)).toEqual([3, 2, 1]);
    expect(listLearnings(db, { review_status: 'pending_review' }).learnings.map((l) => l.id)).toEqual([4]);
  });

  /**
   * FR-241 — the two columns the triage surface's confirmation dialog needs.
   *
   * WHAT THIS PROVES: `seen_again_count` and `deleted_at` reach a list row with
   * their real per-row values, so a caller can partition a selection into
   * "SOFT delete on reject" and "HARD delete on reject" before firing.
   * WHAT IT DOES NOT PROVE: that `igris_perception_reject` actually forks on
   * the column — that is `perception/handlers.ts:661-717` and its own tests.
   * The FR-241 CLI suites re-assert the fork end to end.
   */
  it('FR-241 — projects seen_again_count and deleted_at, per row', () => {
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, created_at, updated_at,
                              review_status, seen_again_count, deleted_at)
       VALUES ('igris-ai','pattern','Recurring','r','2026-07-05 10:00:00','2026-07-05 10:00:00',
               'pending_review', 3, '2026-07-06 10:00:00')`,
    ).run();
    const rows = listLearnings(db, { review_status: 'pending_review' }).learnings;
    const recurring = rows.find((l) => l.title === 'Recurring');
    const firstTime = rows.find((l) => l.title === 'Pending wrapper note');

    // The DISCRIMINATING pair: same query, different values. A projection bug
    // that returned a constant would satisfy either assertion alone.
    expect(recurring?.seen_again_count).toBe(3);
    expect(firstTime?.seen_again_count).toBe(0);
    expect(recurring?.deleted_at).toBe('2026-07-06 10:00:00');
    expect(firstTime?.deleted_at).toBeNull();
  });

  it('FR-241 — a legacy NULL seen_again_count reads as 0, not null', () => {
    // The column arrived by ALTER (perception/schema.ts:106) with a NOT NULL
    // DEFAULT 0, but the reader COALESCEs anyway: a null here would make the
    // client's `count > 0` test evaluate false-y and silently classify a
    // RECURRING candidate as a hard delete — the destructive direction.
    db.exec(`
      CREATE TABLE legacy AS SELECT * FROM learnings WHERE 0;
      DROP TABLE learnings;
      CREATE TABLE learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
        content TEXT NOT NULL, tags TEXT DEFAULT '', tech_stack TEXT DEFAULT '',
        scope TEXT DEFAULT 'local', source_brief TEXT DEFAULT '',
        confidence REAL DEFAULT 0.8,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        access_count INTEGER DEFAULT 0, last_accessed_at TEXT,
        provenance TEXT NOT NULL DEFAULT 'observed',
        review_status TEXT NOT NULL DEFAULT 'approved',
        source_extractor TEXT NOT NULL DEFAULT 'manual',
        seen_again_count INTEGER,
        promoted_to_doc TEXT, deleted_at TEXT
      );
      INSERT INTO learnings (project, category, title, content, created_at, updated_at, seen_again_count)
      VALUES ('igris-ai','pattern','Legacy','x','2026-01-01 00:00:00','2026-01-01 00:00:00', NULL);
    `);
    expect(listLearnings(db).learnings[0]!.seen_again_count).toBe(0);
  });

  it('filters compose with AND and `total` respects them', () => {
    const r = listLearnings(db, { project: 'igris-ai', provenance: 'inferred', review_status: 'approved' });
    expect(r.learnings.map((l) => l.id)).toEqual([2]);
    expect(r.total).toBe(1);
  });

  it('L-133 — an absent learnings table degrades to empty, never a throw', () => {
    const bare = new Database(':memory:');
    try {
      const r = listLearnings(bare);
      expect(r.learnings).toEqual([]);
      expect(r.total).toBe(0);
      expect(r.degraded).toBe('brain table absent: learnings');
      // Never DDL: the preflight must not create the table it found missing.
      const created = bare
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learnings'")
        .get();
      expect(created).toBeUndefined();
    } finally {
      bare.close();
    }
  });
});

// ---------------------------------------------------------------------------
// getLearning
// ---------------------------------------------------------------------------

describe('getLearning', () => {
  it('returns the full row including content', () => {
    const row = getLearning(db, 1);
    expect(row?.title).toBe('Wrapper split');
    expect(row?.content).toBe('The MCP handler becomes a thin wrapper over the reader.');
  });

  it('does NOT bump access_count (G2 — the bump stays wrapper-side, TD-092)', () => {
    const before = (db.prepare('SELECT access_count FROM learnings WHERE id = 1').get() as {
      access_count: number;
    }).access_count;
    getLearning(db, 1);
    getLearning(db, 1);
    const after = (db.prepare('SELECT access_count, last_accessed_at FROM learnings WHERE id = 1').get() as {
      access_count: number;
      last_accessed_at: string | null;
    });
    expect(after.access_count).toBe(before);
    expect(after.last_accessed_at).toBeNull();
  });

  it('has no review_status filter — the perception approval UI needs pending rows', () => {
    expect(getLearning(db, 4)?.title).toBe('Pending wrapper note');
  });

  it('returns null for an unknown id', () => {
    expect(getLearning(db, 999)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listLearnings `q` — FR-246's honest substring filter
// ---------------------------------------------------------------------------

describe('listLearnings q — a FILTER that says it is a filter', () => {
  it('matches title OR content, and composes with the other filters', () => {
    // "bisque" is in row 3's CONTENT only; "drift" is in row 2's title.
    expect(listLearnings(db, { q: 'bisque' }).learnings.map((l) => l.id)).toEqual([3]);
    expect(listLearnings(db, { q: 'drift' }).learnings.map((l) => l.id)).toEqual([2]);
    expect(
      listLearnings(db, { q: 'wrapper', review_status: 'pending_review' }).learnings.map((l) => l.id),
    ).toEqual([4]);
  });

  it('narrows `total`, not just the page — a filtered count that lies is a broken pager', () => {
    expect(listLearnings(db).total).toBe(4);
    expect(listLearnings(db, { q: 'wrapper' }).total).toBe(3);
  });

  it('q="%" matches NOTHING here rather than everything — the wildcard is escaped', () => {
    // No fixture row contains a literal per-cent sign. An unescaped LIKE would
    // return all four and look like a working search.
    expect(listLearnings(db, { q: '%' }).learnings).toEqual([]);
    expect(listLearnings(db, { q: '%' }).total).toBe(0);
  });

  it('reports mode "substring" in the PAYLOAD, and null when no q was given', () => {
    expect(listLearnings(db, { q: 'wrapper' }).search).toEqual({
      mode: 'substring',
      fields: ['title', 'content'],
    });
    expect(listLearnings(db).search).toBeNull();
  });

  it('a pending_review row is reachable by q and NOT by DEFAULT-scoped hybrid search', async () => {
    // The D3 argument for candidates, narrowed by BR-085 to what is still true:
    // recall DEFAULTS to `approved` on both arms (FR-109), so the triage queue
    // is invisible to a caller that does not ask for it. It is no longer
    // structurally unreachable — see the BR-085 block below.
    expect(listLearnings(db, { q: 'pending' }).learnings.map((l) => l.id)).toEqual([4]);
    vec.available = false;
    const hybrid = await hybridSearchLearnings(db, { query: 'pending' });
    expect(hybrid.rows.map((e) => e.id)).not.toContain(4);
  });
});

// ---------------------------------------------------------------------------
// hybridSearchLearnings — the AC #2 gates
// ---------------------------------------------------------------------------

describe('G-HS-1 / G-HS-2 — the vector arm demonstrably ran, and its absence is visible', () => {
  /**
   * Row 3 ("Ceramic kiln schedule / Bisque firing peaks at cone 04 overnight")
   * shares no token with the query "wrapper". Confirmed below rather than
   * asserted by eye — if a future fixture edit gave it lexical overlap, the
   * whole construction would quietly stop discriminating.
   */
  it('the zero-overlap premise holds (fixture self-check)', () => {
    const bm25Only = db
      .prepare(
        `SELECT l.id FROM learnings_fts fts JOIN learnings l ON l.id = fts.rowid
         WHERE learnings_fts MATCH 'wrapper' AND l.review_status = 'approved'`,
      )
      .all() as { id: number }[];
    expect(bm25Only.map((r) => r.id).sort()).toEqual([1, 2]);
    expect(bm25Only.map((r) => r.id)).not.toContain(3);
  });

  it('G-HS-1 — with the vector arm live, the zero-overlap row is RETURNED and mode is hybrid', async () => {
    vec.available = true;
    vec.hits = [3, 1];
    const r = await hybridSearchLearnings(db, { query: 'wrapper' });

    expect(r.retrieval.mode).toBe('hybrid');
    expect(r.retrieval.vector_available).toBe(true);
    expect(r.retrieval.embedding_available).toBe(true);
    expect(r.retrieval.vector_hits).toBe(2);
    expect(r.retrieval.bm25_hits).toBe(2);
    expect(ids(r)).toContain(3);

    // The decisive claim: row 3 arrived through the vector arm ONLY. Substring
    // matching is structurally excluded from having produced it.
    const three = r.rows.find((e) => e.id === 3);
    expect(three?.vector_rank).not.toBeNull();
    expect(three?.bm25_rank).toBeNull();
  });

  it('G-HS-2 — with the vector arm removed, the SAME query loses that row and reports bm25_only', async () => {
    vec.available = false;
    const r = await hybridSearchLearnings(db, { query: 'wrapper' });

    expect(r.retrieval.mode).toBe('bm25_only');
    expect(r.retrieval.vector_available).toBe(false);
    expect(r.retrieval.vector_hits).toBe(0);
    expect(r.retrieval.reason).toBe('sqlite-vec not loaded on this connection');
    // The row that G-HS-1 recovered is GONE. This is what makes G-HS-1's pass
    // attributable to the vector arm rather than to FTS tokenisation luck.
    expect(ids(r)).not.toContain(3);
    expect(ids(r).sort()).toEqual([1, 2]);
  });

  it('vector_only — the arm ran but BM25 matched nothing', async () => {
    vec.available = true;
    vec.hits = [3];
    const r = await hybridSearchLearnings(db, { query: 'zzzznomatchterm' });
    expect(r.retrieval.mode).toBe('vector_only');
    expect(r.retrieval.bm25_hits).toBe(0);
    expect(ids(r)).toEqual([3]);
  });

  it('none — neither arm produced anything', async () => {
    const r = await hybridSearchLearnings(db, { query: 'zzzznomatchterm' });
    expect(r.retrieval.mode).toBe('none');
    expect(r.rows).toEqual([]);
  });
});

describe('hybridSearchLearnings — degradation is reported, never thrown', () => {
  it('an embedding cold-start failure degrades to bm25_only with the reason verbatim', async () => {
    vec.available = true;
    vec.hits = [3];
    vec.embeddingThrows = new Error('embeddings backend unavailable: transformers absent');

    const r = await hybridSearchLearnings(db, { query: 'wrapper' });
    expect(r.retrieval.mode).toBe('bm25_only');
    expect(r.retrieval.embedding_available).toBe(false);
    expect(r.retrieval.reason).toBe('embeddings backend unavailable: transformers absent');
    // FIELD SEPARATION (D3). `vector_available` reports the CONNECTION probe, so
    // it stays TRUE here: the extension is fine and the EMBEDDING is what
    // failed. An implementation that reported "the arm contributed" would say
    // `false` and send an operator hunting for a packaging problem that does not
    // exist. `mode` and `vector_hits` are what carry the arm's outcome.
    expect(r.retrieval.vector_available).toBe(true);
    expect(r.retrieval.vector_hits).toBe(0);
    // Still useful: BM25 rows survive the vector-arm failure.
    expect(ids(r).sort()).toEqual([1, 2]);
  });

  it('SELF-NEGATIVE-CONTROL — vector_available IS false when the probe fails', async () => {
    // The paired control: without it, "vector_available: true" above could be a
    // constant rather than a probe result.
    vec.available = false;
    const r = await hybridSearchLearnings(db, { query: 'wrapper' });
    expect(r.retrieval.vector_available).toBe(false);
    expect(r.retrieval.reason).toBe('sqlite-vec not loaded on this connection');
  });

  it('a pure-punctuation query sanitises to nothing and returns mode none', async () => {
    const r = await hybridSearchLearnings(db, { query: '???' });
    expect(r.retrieval.mode).toBe('none');
    expect(r.rows).toEqual([]);
  });
});

describe('hybridSearchLearnings — the FR-109 / TD-059 gates survived the move', () => {
  it('a pending_review row never surfaces through the BM25 arm', async () => {
    const r = await hybridSearchLearnings(db, { query: 'wrapper' });
    // Self-negative-control: the row IS matchable by FTS; the gate is what
    // removes it. Without this, "absent" could mean "never indexed".
    const ungated = db
      .prepare(
        `SELECT l.id FROM learnings_fts fts JOIN learnings l ON l.id = fts.rowid
         WHERE learnings_fts MATCH 'wrapper'`,
      )
      .all() as { id: number }[];
    expect(ungated.map((x) => x.id)).toContain(4);
    expect(ids(r)).not.toContain(4);
  });

  it('a pending_review row never surfaces through the VECTOR arm either', async () => {
    vec.available = true;
    vec.hits = [4];
    const r = await hybridSearchLearnings(db, { query: 'zzzznomatchterm' });
    expect(r.retrieval.vector_hits).toBe(0);
    expect(ids(r)).not.toContain(4);
  });

  /**
   * TD-059 — the hydration SELECT's `review_status='approved'` clause is
   * DEFENCE IN DEPTH. Both arms already exclude pending rows upstream, so in a
   * single-threaded fixture no id can reach hydration and be refused there: the
   * `row: null` entry is a genuine race state (a row flipped or deleted between
   * the arm query and the hydration query).
   *
   * There is therefore NO honest fixture for it, and a test that constructed
   * one by mutating mid-call would be asserting the mutation, not the gate. It
   * is stated here rather than faked. What IS asserted: the gate's *effect* is
   * covered by the two tests above (BM25 arm, vector arm), and the wrapper's
   * rendering of a null row is pinned by the `(record not found)` branch in
   * `wrapper-wire-parity.test.ts`'s formatter path.
   */
  it('TD-059 — the hydration gate refuses non-approved ids (asserted directly)', () => {
    db.prepare("UPDATE learnings SET review_status = 'pending_review' WHERE id = 1").run();
    const hydrated = db
      .prepare(
        `SELECT id FROM learnings WHERE id IN (1, 2) AND review_status = 'approved'`,
      )
      .all() as { id: number }[];
    expect(hydrated.map((r) => r.id)).toEqual([2]);
  });

  it('project filter narrows both arms', async () => {
    vec.available = true;
    vec.hits = [3, 1];
    const r = await hybridSearchLearnings(db, { query: 'wrapper', project: 'igris-ai' });
    expect(ids(r)).not.toContain(3);
    expect(r.retrieval.vector_hits).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// BR-085 — the review gate is a PARAMETER, and it binds both arms + hydration
// ---------------------------------------------------------------------------

describe('BR-085 — review_status scopes recall, on BOTH arms', () => {
  /**
   * THE TRAP THIS BLOCK EXISTS FOR.
   *
   * `computeRRF` scores a row by its POSITION in each arm's list. A review gate
   * applied to one arm (or only at hydration) therefore does not merely return
   * the wrong SET — it hands the fusion ranks computed over rows the other arm
   * could never contribute, and every surviving row's rank shifts. The result
   * looks ordered and is wrong. So the assertions below are not only about
   * membership: `bm25_hits` / `vector_hits` / the per-row ranks are asserted
   * because those are what witness the filter landing BEFORE the fusion.
   *
   * Fixture recap: 1, 2 and 3 are `approved`, 4 is `pending_review`. 1, 2 and 4
   * all contain "wrapper"; 3 shares no token with it.
   */

  it('the DEFAULT is unchanged — omitting the option is the FR-109 conscious channel', async () => {
    // The MCP wrapper (`memory.ts:1086`) enumerates its arguments and passes no
    // `review_status`, and `igris_memory_hybrid_search`'s input schema has no
    // such property under `additionalProperties: false`. So this call IS the
    // conscious channel, and it must behave exactly as it did before BR-085.
    vec.available = true;
    vec.hits = [4, 3];
    const r = await hybridSearchLearnings(db, { query: 'wrapper' });
    expect(ids(r)).not.toContain(4);
    expect(r.review_status).toBe('approved');
    expect(r.retrieval.bm25_hits).toBe(2);
    // The vector arm offered 4 and it was refused there too — `vector_hits`
    // counts POST-filter, so this is the arm's own gate, not hydration's.
    expect(r.retrieval.vector_hits).toBe(1);
  });

  it('the BM25 arm binds it — a pending scope returns the pending row and REFUSES the approved ones', async () => {
    vec.available = false;
    const r = await hybridSearchLearnings(db, {
      query: 'wrapper',
      review_status: 'pending_review',
    });
    expect(ids(r)).toEqual([4]);
    expect(r.review_status).toBe('pending_review');
    // EXACT, not `>= 1`: the ungated arm would report 3 (rows 1, 2 and 4 all
    // match "wrapper"), so this is the number that witnesses a PRE-fusion
    // filter rather than a post-hoc drop.
    expect(r.retrieval.bm25_hits).toBe(1);
    // The row carries its body — but note this branch is BM25-only, which
    // returns the arm's own SELECT and never reaches the hydration SELECT. The
    // hydration gate has its own test below, for exactly that reason.
    expect(r.rows[0].row?.title).toBe('Pending wrapper note');
  });

  it('the HYDRATION gate binds it too — the fused branch returns a hydrated row, not a null one', async () => {
    // THE THIRD GATE, and the one with no other witness. Hydration runs ONLY on
    // the fused branch (`vectorAvailable && vecResults.length > 0`), so every
    // assertion on a BM25-only result is vacuous for it: those rows come from
    // the arm's own SELECT. Driven red by pinning the hydration SELECT back to
    // the 'approved' literal, which leaves ids intact and the ranks intact and
    // turns `row` into null — a result the dashboard renders as ZERO items
    // while `retrieval` reports hits. An empty list that reports a non-zero hit
    // count is the shape this assertion exists to refuse.
    vec.available = true;
    vec.hits = [3, 4];
    const r = await hybridSearchLearnings(db, {
      query: 'wrapper',
      review_status: 'pending_review',
    });
    expect(r.retrieval.mode).toBe('hybrid');
    expect(ids(r)).toEqual([4]);
    expect(r.rows[0].row).not.toBeNull();
    expect(r.rows[0].row?.title).toBe('Pending wrapper note');
  });

  it('the VECTOR arm binds it too — the approved rows the KNN offered are refused', async () => {
    // Zero-overlap query, so BM25 contributes NOTHING and anything that arrives
    // came through the vector arm. The KNN offers all four rows.
    vec.available = true;
    vec.hits = [1, 2, 3, 4];
    const r = await hybridSearchLearnings(db, {
      query: 'zzzznomatchterm',
      review_status: 'pending_review',
    });
    expect(r.retrieval.bm25_hits).toBe(0);
    expect(ids(r)).toEqual([4]);
    // 4 of 4 offered, 1 survived the arm's own gate.
    expect(r.retrieval.vector_hits).toBe(1);
    expect(r.rows[0].vector_rank).not.toBeNull();
    expect(r.rows[0].bm25_rank).toBeNull();
  });

  it('a row outside the scope cannot arrive via EITHER arm — offered by both, refused by both', async () => {
    // THE AC #2 ASSERTION. Row 1 is `approved`; the scope is `pending_review`.
    // It is offered by the BM25 arm (it contains "wrapper") AND by the vector
    // arm (the KNN returns it), so a gate missing from either one would let it
    // through. The paired control below proves both offers were real.
    vec.available = true;
    vec.hits = [1, 2, 3];
    const scoped = await hybridSearchLearnings(db, {
      query: 'wrapper',
      review_status: 'pending_review',
    });
    expect(ids(scoped)).toEqual([4]);
    expect(scoped.rows.every((e) => e.row !== null)).toBe(true);

    // PAIRED CONTROL — the same corpus, the same query, the same KNN hits, one
    // option changed. Row 1 arrives through BOTH arms here, which is what makes
    // its absence above attributable to the gate rather than to a corpus, a
    // tokenisation or a KNN that never offered it.
    vec.available = true;
    vec.hits = [1, 2, 3];
    const control = await hybridSearchLearnings(db, { query: 'wrapper' });
    const one = control.rows.find((e) => e.id === 1);
    expect(one?.bm25_rank).not.toBeNull();
    expect(one?.vector_rank).not.toBeNull();
  });

  it('the ranks are computed over the FILTERED arms, not filtered after fusion', async () => {
    // The ranking half of the trap, made observable. Both arms offer row 3
    // (approved) ahead of row 4 (pending) in the vector list; under the pending
    // scope row 4 must rank FIRST in that arm. A gate applied after fusion
    // would leave 3 in the list, push 4 to vector_rank 2, and then drop 3 at
    // hydration — same set, different order, and only this assertion sees it.
    vec.available = true;
    vec.hits = [3, 4];
    const r = await hybridSearchLearnings(db, {
      query: 'wrapper',
      review_status: 'pending_review',
    });
    expect(ids(r)).toEqual([4]);
    expect(r.rows[0].vector_rank).toBe(1);
    expect(r.rows[0].bm25_rank).toBe(1);
    expect(r.retrieval.vector_hits).toBe(1);
    expect(r.retrieval.bm25_hits).toBe(1);
  });

  it('an EMPTY scope is not an UNFILTERED one — the un-scoped read is unreachable', async () => {
    // `listLearnings` treats `undefined`/'' as "no filter"; this door must not,
    // or `?review_status=` would put rejected rows into conscious recall. Row 2
    // is rejected here, so an unfiltered read would return [1, 2].
    db.prepare("UPDATE learnings SET review_status = 'rejected' WHERE id = 2").run();
    const empty = await hybridSearchLearnings(db, { query: 'wrapper', review_status: '' });
    expect(ids(empty)).toEqual([1]);
    expect(empty.review_status).toBe('approved');

    // Self-negative-control: the rejected row IS lexically matchable, so its
    // absence is the gate's doing and not the index's.
    const ungated = db
      .prepare(
        `SELECT l.id FROM learnings_fts fts JOIN learnings l ON l.id = fts.rowid
         WHERE learnings_fts MATCH 'wrapper'`,
      )
      .all() as { id: number }[];
    expect(ungated.map((x) => x.id)).toContain(2);
  });

  it('the applied scope is echoed on EVERY exit, including the empty ones', async () => {
    // The echo is what the dashboard banners from, so an exit that omits it is
    // an exit where the UI would fall back to describing the REQUEST — BR-085's
    // original defect, reintroduced through a return statement.
    const none = await hybridSearchLearnings(db, {
      query: 'zzzznomatchterm',
      review_status: 'pending_review',
    });
    expect(none.retrieval.mode).toBe('none');
    expect(none.rows).toEqual([]);
    expect(none.review_status).toBe('pending_review');

    vec.available = false;
    const bm25Only = await hybridSearchLearnings(db, {
      query: 'wrapper',
      review_status: 'pending_review',
    });
    expect(bm25Only.retrieval.mode).toBe('bm25_only');
    expect(bm25Only.review_status).toBe('pending_review');

    vec.available = true;
    vec.hits = [4];
    const fused = await hybridSearchLearnings(db, {
      query: 'wrapper',
      review_status: 'pending_review',
    });
    expect(fused.retrieval.mode).toBe('hybrid');
    expect(fused.review_status).toBe('pending_review');
  });

  it('the CONSCIOUS channel cannot ask for a scope — no such property on the tool schema', () => {
    // FR-109's boundary, asserted where it is actually enforced. Widening the
    // reader is only safe because the MCP surface has no way to reach the new
    // option: the tool declares `additionalProperties: false`, so a caller that
    // sent `review_status` would be REFUSED by the gateway rather than served
    // pending rows. Source-scanned because the schema is data, not behaviour.
    const src = readFileSync(
      new URL('../../engine/components/memory/index.ts', import.meta.url),
      'utf-8',
    );
    const start = src.indexOf("name: 'igris_memory_hybrid_search'");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("name: 'igris_memory_", start + 10);
    const block = src.slice(start, end === -1 ? undefined : end);
    // Self-negative-control for the SLICE: a mis-anchored window would be empty
    // or point at another tool, and "review_status is absent" would be vacuous.
    expect(block).toContain('rrf_k');
    expect(block).toContain('additionalProperties: false');
    expect(block).not.toContain('review_status');
  });
});

describe('hybridSearchLearnings — the retrieval block reports its own knobs', () => {
  it('echoes rrf_k and the weights actually used', async () => {
    vec.available = true;
    vec.hits = [1];
    const r = await hybridSearchLearnings(db, {
      query: 'wrapper',
      rrf_k: 17,
      bm25_weight: 0.3,
      vector_weight: 0.7,
    });
    expect(r.retrieval.rrf_k).toBe(17);
    expect(r.retrieval.weights).toEqual({ bm25: 0.3, vector: 0.7 });
  });

  it('defaults are k=60 and 0.5/0.5', async () => {
    const r = await hybridSearchLearnings(db, { query: 'wrapper' });
    expect(r.retrieval.rrf_k).toBe(60);
    expect(r.retrieval.weights).toEqual({ bm25: 0.5, vector: 0.5 });
  });

  it('limit caps the returned rows', async () => {
    const r = await hybridSearchLearnings(db, { query: 'wrapper', limit: 1 });
    expect(r.rows).toHaveLength(1);
  });
});

describe('the reader never writes (AC #7, structurally)', () => {
  it('all three readers work on a query_only handle', async () => {
    db.pragma('query_only = ON');
    expect(() => listLearnings(db)).not.toThrow();
    expect(() => getLearning(db, 1)).not.toThrow();
    await expect(hybridSearchLearnings(db, { query: 'wrapper' })).resolves.toBeDefined();

    // Self-negative-control — prove the pragma is armed on THIS handle.
    expect(() =>
      db.prepare('UPDATE learnings SET access_count = 99 WHERE id = 1').run(),
    ).toThrow();
  });
});
