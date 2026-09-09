/**
 * FR-246 — `hybridSearchBriefs` really has two arms, and each one's absence is
 * visible.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * FR-246's acceptance criterion #1 was originally written as "a result
 * reachable only through the vector arm". Against the pre-FR-246 implementation
 * that sentence is **VACUOUS**: `igris_brief_similar` had exactly ONE arm, so
 * every row it ever returned was "vector-only" and the check could not fail.
 * The operator sign-off (2026-08-03) rewrote it into the construction below,
 * which is `memory-read.test.ts`'s G-HS-1/G-HS-2 transferred to briefs.
 *
 * WHAT THESE GATES PROVE
 * ----------------------
 * The MODE PLUMBING and the ARM ATTRIBUTION: that a row credited to the vector
 * arm could not have come from the lexical one, and that removing the vector
 * arm removes exactly that row.
 *
 * WHAT THEY DO NOT PROVE
 * ----------------------
 *  - **Recall quality.** The vector arm is a DOUBLE — `:memory:` cannot load
 *    sqlite-vec, so `vector-search.js` is mocked and `vec.hits` is whatever the
 *    test says it is. These gates say nothing about whether real embeddings
 *    would rank that row highly. Nothing in this repo can assert that offline;
 *    see the hermetic-world note in `cli/scripts/browser-gate.mjs`.
 *  - **That the v23 DDL and triggers are right.** This fixture creates
 *    `briefs_fts` BY HAND (production creates it in `db.ts`'s v23 block, which
 *    is not exported). **Sibling:** `src/__tests__/db-migration-v23.test.ts`
 *    drives the real migration, the real triggers and all four writer shapes.
 *    If you change the DDL in `db.ts`, change it here too — the coupling is
 *    manual and this sentence is the only thing that says so.
 *  - **That `igris_brief_similar`'s prose survived the extraction.**
 *    **Sibling:** `wrapper-wire-parity.test.ts` and `brief-similar.test.ts`.
 *
 * @module tools/__tests__/briefs-read-search.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

/** Deterministic stand-in; the mock below never inspects the values. */
function fakeEmbedding(text: string): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = ((text.charCodeAt(i % text.length) + i) % 17) / 17;
  return v;
}

/**
 * The vector-arm double. `available` models `SELECT vec_version()` succeeding
 * on the connection; `hits` is the KNN list the extension would return. Both
 * are per-test knobs precisely so the SAME corpus can be driven through both
 * arms — that is what makes G-BS-2 a negative control rather than a second
 * happy path.
 */
const vec = {
  available: false,
  hits: [] as number[],
  embeddingThrows: null as Error | null,
  searchThrows: null as Error | null,
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
  EmbeddingsUnavailableError: class EmbeddingsUnavailableError extends Error {},
}));

vi.mock('../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => vec.available),
  insertEmbedding: vi.fn(),
  deleteEmbedding: vi.fn(),
  vectorSearch: vi.fn(() => []),
  insertEmbeddingInto: vi.fn(),
  deleteEmbeddingFrom: vi.fn(),
  vectorSearchFrom: vi.fn((_db: unknown, _table: string, _q: Float32Array, limit: number) => {
    if (vec.searchThrows) throw vec.searchThrows;
    return vec.hits.slice(0, limit).map((rowid, i) => ({ rowid, distance: (i + 1) * 0.1 }));
  }),
}));

import { hybridSearchBriefs, searchBriefsByVector } from '../briefs-read.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let db: Database.Database;

/**
 * Three briefs. The whole construction turns on brief **3**:
 *
 *   3 — "Ceramic kiln schedule" / "Bisque firing peaks at cone 04 overnight"
 *
 * which shares NO token with the query `wrapper`. 1 and 2 do. So a row-3 hit
 * can only have come from the vector arm — and G-BS-0 below PROVES that premise
 * by running the FTS query rather than trusting the prose above.
 */
function seed(withFts = true): void {
  db.exec(`
    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL, brief_id TEXT NOT NULL, brief_type TEXT,
      title TEXT NOT NULL, status TEXT NOT NULL, priority TEXT, effort TEXT,
      phase TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_bs_unique ON brief_status(project, brief_id);
    CREATE TABLE brief_files (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, brief_id TEXT NOT NULL,
      filename TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
  `);

  const rows: [number, string, string, string, string][] = [
    [1, 'igris-ai', 'FR-001', 'Wrapper extraction', 'The wrapper renders prose while the reader returns rows.'],
    [2, 'igris-ai', 'FR-002', 'Second wrapper note', 'A wrapper is thin by construction.'],
    [3, 'igris-ai', 'FR-003', 'Ceramic kiln schedule', 'Bisque firing peaks at cone 04 overnight.'],
    [4, 'other', 'BR-004', 'Wrapper in another project', 'A wrapper living outside igris-ai.'],
  ];
  const ins = db.prepare(
    `INSERT INTO brief_status (id, project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
     VALUES (?, ?, ?, 'Feature', ?, 'Ready', 'P1-High', 'M', 'READY', '2026-08-01 00:00:00')`,
  );
  const insFile = db.prepare(
    `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash)
     VALUES (?, ?, ?, ?, ?, 'h')`,
  );
  for (const [id, project, briefId, title, content] of rows) {
    ins.run(id, project, briefId, title);
    insFile.run(`f${id}`, project, briefId, `${briefId}.md`, content);
  }

  if (withFts) {
    // MIRRORS `db.ts` v23. Contentless + contentless_delete=1, keyed on
    // `brief_status.id`. See the module header's coupling note.
    db.exec(`
      CREATE VIRTUAL TABLE briefs_fts USING fts5(
        brief_id, title, content, content='', contentless_delete=1
      );
    `);
    db.exec(`
      INSERT INTO briefs_fts(rowid, brief_id, title, content)
      SELECT bs.id, bs.brief_id, bs.title, COALESCE(bf.content, '')
        FROM brief_status bs
        LEFT JOIN brief_files bf
               ON bf.project = bs.project AND bf.brief_id = bs.brief_id;
    `);
  }
}

const ids = (r: { rows: { id: number }[] }): number[] => r.rows.map((e) => e.id);

beforeEach(() => {
  vec.available = false;
  vec.hits = [];
  vec.embeddingThrows = null;
  vec.searchThrows = null;
  db = new Database(':memory:');
  seed();
});

// ---------------------------------------------------------------------------
// AC-1 — the rewritten, discriminating form
// ---------------------------------------------------------------------------

describe('G-BS-0/1/2 — the vector arm demonstrably ran, and its absence is visible', () => {
  /**
   * G-BS-0 — the fixture premise, ASSERTED rather than assumed.
   *
   * Without this, a future fixture edit that gave brief 3 the word "wrapper"
   * would make G-BS-1 and G-BS-2 both pass while proving nothing at all, and
   * nothing would say so.
   */
  it('G-BS-0 — the zero-overlap premise holds (fixture self-check)', () => {
    const hits = db
      .prepare(`SELECT rowid AS id FROM briefs_fts WHERE briefs_fts MATCH 'wrapper' ORDER BY rowid`)
      .all() as { id: number }[];
    expect(hits.map((r) => r.id)).toEqual([1, 2, 4]);
    expect(hits.map((r) => r.id)).not.toContain(3);
  });

  it('G-BS-1 — with the vector arm live, the zero-overlap brief is RETURNED and mode is hybrid', async () => {
    vec.available = true;
    vec.hits = [3, 1];
    const r = await hybridSearchBriefs(db, { query: 'wrapper' });

    expect(r.retrieval.mode).toBe('hybrid');
    expect(r.retrieval.vector_available).toBe(true);
    expect(r.retrieval.embedding_available).toBe(true);
    expect(r.retrieval.bm25_hits).toBe(3);
    expect(r.retrieval.vector_hits).toBe(2);
    expect(r.retrieval.bm25_reason).toBeNull();
    expect(ids(r)).toContain(3);

    // THE DECISIVE CLAIM: brief 3 arrived through the vector arm ONLY. Lexical
    // matching is structurally excluded from having produced it (G-BS-0).
    const three = r.rows.find((e) => e.id === 3);
    expect(three?.vector_rank).not.toBeNull();
    expect(three?.bm25_rank).toBeNull();
    expect(three?.row?.brief_id).toBe('FR-003');
  });

  it('G-BS-2 — with the vector arm removed, the SAME query loses that brief and reports bm25_only', async () => {
    vec.available = false;
    const r = await hybridSearchBriefs(db, { query: 'wrapper' });

    expect(r.retrieval.mode).toBe('bm25_only');
    expect(r.retrieval.vector_available).toBe(false);
    expect(r.retrieval.vector_hits).toBe(0);
    expect(r.retrieval.reason).toBe('sqlite-vec not loaded on this connection');
    // The brief G-BS-1 recovered is GONE. This is what makes G-BS-1's pass
    // attributable to the vector arm rather than to FTS tokenisation luck.
    expect(ids(r)).not.toContain(3);
    expect(ids(r).sort()).toEqual([1, 2, 4]);
  });
});

// ---------------------------------------------------------------------------
// The finding this arm exists for
// ---------------------------------------------------------------------------

describe('the BM25 arm reaches brief BODIES, which no other arm does', () => {
  /**
   * `briefs_vec` is built from the title plus the `## Problem` section only, at
   * CREATE and by the backfill tool, with no update trigger (`db.ts` v23
   * header). So this is not a nice-to-have of the lexical arm: it is the ONLY
   * path by which `brief_files.content` is searchable at all.
   */
  it('matches a term that appears ONLY in the body, never in the title', async () => {
    const r = await hybridSearchBriefs(db, { query: 'bisque' });
    expect(ids(r)).toEqual([3]);
    expect(r.retrieval.mode).toBe('bm25_only');
    // Proving the premise rather than asserting it: 'bisque' is absent from
    // every title in the corpus, so the hit can only have come from the body.
    const titles = db.prepare('SELECT title FROM brief_status').all() as { title: string }[];
    expect(titles.every((t) => !t.title.toLowerCase().includes('bisque'))).toBe(true);
  });

  it('reports a content_length without shipping the body (FR-240 D7)', async () => {
    const r = await hybridSearchBriefs(db, { query: 'bisque' });
    const row = r.rows[0]?.row as Record<string, unknown>;
    expect(row.content_length).toBe('Bisque firing peaks at cone 04 overnight.'.length);
    expect(row).not.toHaveProperty('content');
  });
});

// ---------------------------------------------------------------------------
// AC-3/AC-4 — degraded states are STATED, never silently thin
// ---------------------------------------------------------------------------

describe('degrade states name themselves', () => {
  it('a pre-v23 brain (no briefs_fts) reports vector_only with a reason — it does not throw', async () => {
    db.close();
    db = new Database(':memory:');
    seed(false);
    vec.available = true;
    vec.hits = [3];

    const r = await hybridSearchBriefs(db, { query: 'wrapper' });
    expect(r.retrieval.mode).toBe('vector_only');
    expect(r.retrieval.bm25_hits).toBe(0);
    expect(r.retrieval.bm25_reason).toBe('brain table absent: briefs_fts (schema v23 not applied)');
    expect(ids(r)).toEqual([3]);
  });

  it('neither arm available reports mode "none" carrying BOTH reasons', async () => {
    db.close();
    db = new Database(':memory:');
    seed(false);
    vec.available = false;

    const r = await hybridSearchBriefs(db, { query: 'wrapper' });
    expect(r.retrieval.mode).toBe('none');
    expect(r.retrieval.reason).toBe('sqlite-vec not loaded on this connection');
    expect(r.retrieval.bm25_reason).toBe('brain table absent: briefs_fts (schema v23 not applied)');
    expect(r.rows).toEqual([]);
  });

  it('an empty result on a HEALTHY brain reports mode "none" with NO reasons — degraded and empty are different', async () => {
    vec.available = true;
    vec.hits = [];
    const r = await hybridSearchBriefs(db, { query: 'zzzznomatchterm' });
    expect(r.retrieval.mode).toBe('none');
    expect(r.retrieval.reason).toBeNull();
    expect(r.retrieval.bm25_reason).toBeNull();
    expect(r.retrieval.vector_available).toBe(true);
  });

  it('a vector arm that RAN but matched nothing is bm25_only, not hybrid', async () => {
    vec.available = true;
    vec.hits = [];
    const r = await hybridSearchBriefs(db, { query: 'wrapper' });
    expect(r.retrieval.mode).toBe('bm25_only');
    expect(r.retrieval.vector_available).toBe(true);
  });

  it('an unsanitisable query names itself rather than reporting a missing table', async () => {
    vec.available = false;
    const r = await hybridSearchBriefs(db, { query: '""' });
    expect(r.retrieval.bm25_reason).toBe('query has no searchable tokens after FTS5 sanitisation');
  });
});

// ---------------------------------------------------------------------------
// The project filter has to bite on BOTH arms
// ---------------------------------------------------------------------------

describe('the project filter applies to both arms', () => {
  it('drops an out-of-project BM25 hit', async () => {
    const r = await hybridSearchBriefs(db, { query: 'wrapper', project: 'igris-ai' });
    expect(ids(r).sort()).toEqual([1, 2]);
    expect(ids(r)).not.toContain(4);
  });

  it('drops an out-of-project VECTOR hit — the arm that has no project column', async () => {
    vec.available = true;
    vec.hits = [4, 3];
    const r = await hybridSearchBriefs(db, { query: 'wrapper', project: 'igris-ai' });
    // 4 is `other`; 3 is in-project and vector-only, so it must survive.
    expect(ids(r)).not.toContain(4);
    expect(ids(r)).toContain(3);
    expect(r.retrieval.vector_hits).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D1-b — the dup-check reader stays pure vector
// ---------------------------------------------------------------------------

describe('searchBriefsByVector — pure vector, threshold semantics intact', () => {
  it('never consults the lexical arm, even when one exists and matches', async () => {
    vec.available = true;
    vec.hits = [3];
    const r = await searchBriefsByVector(db, { query: 'wrapper', threshold: 0 });
    expect(r.status).toBe('ok');
    // Briefs 1, 2 and 4 all match 'wrapper' lexically (G-BS-0). If this reader
    // had acquired a BM25 arm they would be here. Only the vector hit is.
    if (r.status === 'ok') expect(r.matches.map((m) => m.rowid)).toEqual([3]);
  });

  it('reports a below-threshold miss distinctly from an empty index', async () => {
    vec.available = true;
    vec.hits = [3];
    // distance 0.1 -> cosine 0.995, so a threshold above that filters it out.
    expect((await searchBriefsByVector(db, { query: 'x', threshold: 0.999 })).status)
      .toBe('below_threshold');
    vec.hits = [];
    expect((await searchBriefsByVector(db, { query: 'x' })).status).toBe('no_vector_hits');
  });

  it('names a MISSING briefs_vec instead of reporting "nothing was similar"', async () => {
    vec.available = true;
    vec.hits = [3];
    vec.searchThrows = new Error('no such table: briefs_vec');
    const r = await searchBriefsByVector(db, { query: 'x' });
    // The fixture has no `briefs_vec`, so the preflight in the failure path
    // resolves this to the named state rather than to a raw SQLite string.
    expect(r.status).toBe('vector_table_absent');
  });

  it('a REAL search failure on a brain that HAS briefs_vec keeps its own message', async () => {
    db.exec('CREATE TABLE briefs_vec (rowid INTEGER PRIMARY KEY, embedding BLOB)');
    vec.available = true;
    vec.searchThrows = new Error('vec0 constraint failed');
    const r = await searchBriefsByVector(db, { query: 'x' });
    // Not `vector_table_absent`: the table IS there, so the preflight must not
    // launder an unrelated fault into a "missing index" diagnosis.
    expect(r.status).toBe('embedding_failed');
    if (r.status === 'embedding_failed') expect(r.error).toBe('vec0 constraint failed');
  });
});
