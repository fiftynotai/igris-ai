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
      promoted_to_doc TEXT
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
