/**
 * Igris Brain — Brief READ layer (pure, `db`-param).
 *
 * FR-240 D1. This module is the second instance of the pure-layer / MCP-wrapper
 * split that `whole-graph.ts` / `whole-graph-tool.ts` established (FR-237) and
 * that `architecture_map.md` § "Brain Engine — Pure Data Layer vs MCP Wrapper"
 * records as the convention. The rule it exists to hold:
 *
 *   **This file MUST NOT import `../db.js`, and MUST NOT write.**
 *
 * Mechanically enforced by `__tests__/pure-read-purity.test.ts`.
 *
 * WHY THE SPLIT
 * -------------
 * `getDb()` opens the brain READ-WRITE and runs `migrateSchema` (`db.ts:1309`).
 * Any consumer that is not the MCP gateway — the FR-238 dashboard server, a CLI
 * verb, a fixture-backed test — would mutate the brain before reading a single
 * row. Taking the handle as a parameter lets those callers bring their own
 * `{readonly:true, query_only:ON}` connection while the SQL stays defined
 * exactly ONCE.
 *
 * PROVENANCE
 * ----------
 * Every SELECT below was MOVED verbatim from `briefs.ts` and is annotated with
 * its pre-extraction origin line. The one deliberate addition is the `effort`
 * filter in {@link listBriefs} (FR-240 closes that gap; the column already
 * exists in `brief_status`, only the filter was missing).
 *
 * CONSUMERS (MAINTAINING — the pure `db`-param READ layer row)
 * ------------------------------------------------------------
 * `tools/briefs.ts#handleBriefList` / `#handleBriefGet` (MCP wrappers) ·
 * `cli/src/lib/brain-bridge.ts` (type facade + runtime import) ·
 * `cli/src/lib/dashboard/routes.ts`. A change to a signature or a returned row
 * shape MUST sweep all of them in the same commit.
 *
 * @module tools/briefs-read
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { sanitizeFts5Query } from '../utils/fts5.js';
import { generateEmbedding, EmbeddingsUnavailableError } from '../utils/embeddings.js';
import { isVectorSearchAvailable, vectorSearchFrom } from '../utils/vector-search.js';
import type { VectorSearchResult } from '../utils/vector-search.js';
import { computeRRF, l2ToCosine } from '../utils/hybrid-search.js';
// Type-only: erased at compile, so this adds NO runtime import edge between the
// two pure read modules. The report shape is DEFINED ONCE in `memory-read.ts`;
// duplicating it here is exactly the drift the pure-layer split exists to stop.
import type { RetrievalReport } from './memory-read.js';

// ---------------------------------------------------------------------------
// Row and option shapes
// ---------------------------------------------------------------------------

/** Filters and pagination accepted by {@link listBriefs}. */
export interface ListBriefsOptions {
  project?: string;
  status?: string;
  brief_type?: string;
  priority?: string;
  /** FR-240 addition — the column existed in `brief_status`, the filter did not. */
  effort?: string;
  /** When true, LEFT JOIN `brief_files` and include `content`/`filename`/`content_hash`. */
  include_content?: boolean;
  /**
   * `0` means "no LIMIT clause at all" — the `igris_brief_list` semantic, kept
   * verbatim (briefs.ts:409). Callers that must not be able to ask for the
   * whole table (the dashboard) clamp before calling.
   */
  limit?: number;
  offset?: number;
}

/**
 * The `igris_brief_list` payload, key-for-key.
 *
 * The MCP wrapper `JSON.stringify`s this object DIRECTLY, so the key ORDER here
 * is part of the wire contract the SKILLS parse. Verified by grep at FR-240,
 * not assumed: `igris_brief_list` is called by the `register`, `audit` and
 * `team` skills and `igris_brief_get` by `hunt`, `archive` and `team`.
 * Re-derive rather than trust this list — the FR-240 plan named `/awaken` and
 * `/distill` here and BOTH were wrong (`/awaken` calls neither tool, and
 * `/distill` is the retired name of `/harvest`):
 *   grep -rl igris_brief_list ~/.igris/core/skills/
 * Pinned by `__tests__/wrapper-wire-parity.test.ts`.
 */
export interface ListBriefsResult {
  briefs: Record<string, unknown>[];
  count: number;
  total: number;
  limit: number;
  offset: number;
}

/**
 * One brief as `igris_brief_get` returns it.
 *
 * Both the JOIN path and the metadata-only fallback produce this identical key
 * set in this identical order (briefs.ts:341-354 / :370-383) — that symmetry is
 * why one interface suffices, and it must be preserved.
 */
export interface BriefRecord {
  project: string;
  brief_id: string;
  content: unknown;
  filename: unknown;
  content_hash: unknown;
  title: unknown;
  status: unknown;
  priority: unknown;
  effort: unknown;
  phase: unknown;
  brief_type: unknown;
  updated_at: unknown;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * List briefs with optional filters, `updated_at DESC`, and a `total` count.
 *
 * SQL moved verbatim from `briefs.ts:405-476` (`handleBriefList`).
 *
 * @param db - A connection. May be read-only; this function never writes.
 * @param opts - Filters + pagination.
 */
export function listBriefs(
  db: Database.Database,
  opts: ListBriefsOptions = {},
): ListBriefsResult {
  // briefs.ts:409 — 0 = return all, default 25, clamped to non-negative ints.
  const limit = opts.limit === 0 ? 0 : Math.max(1, Math.floor(opts.limit ?? 25));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  const conditions: string[] = [];
  const params: unknown[] = [];

  // briefs.ts:415-430 — one AND-ed equality per supplied filter.
  if (opts.project) {
    conditions.push('bs.project = ?');
    params.push(opts.project);
  }
  if (opts.status) {
    conditions.push('bs.status = ?');
    params.push(opts.status);
  }
  if (opts.brief_type) {
    conditions.push('bs.brief_type = ?');
    params.push(opts.brief_type);
  }
  if (opts.priority) {
    conditions.push('bs.priority = ?');
    params.push(opts.priority);
  }
  // FR-240 — the added filter. Same parameterised shape as its four siblings.
  if (opts.effort) {
    conditions.push('bs.effort = ?');
    params.push(opts.effort);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // briefs.ts:435-438 — total under the same filters, before pagination.
  const countRow = db.prepare(`
    SELECT COUNT(*) AS total FROM brief_status bs ${whereClause}
  `).get(...params) as { total: number };
  const total = countRow.total;

  const includeContent = opts.include_content === true;

  // briefs.ts:442-451
  const selectCols = includeContent
    ? `bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
       bs.priority, bs.effort, bs.phase, bs.updated_at,
       bf.content, bf.filename, bf.content_hash`
    : `bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
       bs.priority, bs.effort, bs.phase, bs.updated_at`;

  const joinClause = includeContent
    ? 'LEFT JOIN brief_files bf ON bf.project = bs.project AND bf.brief_id = bs.brief_id'
    : '';

  // briefs.ts:453-459
  const dataParams = [...params];
  let limitClause = '';
  if (limit > 0) {
    limitClause = 'LIMIT ? OFFSET ?';
    dataParams.push(limit, offset);
  }

  // briefs.ts:461-468
  const rows = db.prepare(`
    SELECT ${selectCols}
    FROM brief_status bs
    ${joinClause}
    ${whereClause}
    ORDER BY bs.updated_at DESC
    ${limitClause}
  `).all(...dataParams) as Record<string, unknown>[];

  return { briefs: rows, count: rows.length, total, limit, offset };
}

/**
 * Fetch one brief by the `(project, brief_id)` pair.
 *
 * SQL moved verbatim from `briefs.ts:315-394` (`handleBriefGet`). Returns
 * `null` when neither table has the row — the caller owns the not-found
 * message, because that string is a wire contract and belongs with the wrapper.
 *
 * BR-078: `project` is REQUIRED. `BR-001` names a different brief in 25
 * projects, so an id-only lookup would fuse records across projects.
 *
 * @param db - A connection. May be read-only; this function never writes.
 */
export function getBrief(
  db: Database.Database,
  project: string,
  briefId: string,
): BriefRecord | null {
  // briefs.ts:328-335 — JOIN first for full data (content + metadata).
  const joined = db.prepare(`
    SELECT bf.content, bf.filename, bf.content_hash, bf.updated_at AS file_updated_at,
           bs.title, bs.status, bs.priority, bs.effort, bs.phase, bs.brief_type,
           bs.updated_at AS status_updated_at
    FROM brief_files bf
    LEFT JOIN brief_status bs ON bs.project = bf.project AND bs.brief_id = bf.brief_id
    WHERE bf.project = ? AND bf.brief_id = ?
  `).get(project, briefId) as Record<string, unknown> | undefined;

  if (joined) {
    // briefs.ts:341-354 — key order is the wire contract.
    return {
      project,
      brief_id: briefId,
      content: joined.content,
      filename: joined.filename,
      content_hash: joined.content_hash,
      title: joined.title ?? null,
      status: joined.status ?? null,
      priority: joined.priority ?? null,
      effort: joined.effort ?? null,
      phase: joined.phase ?? null,
      brief_type: joined.brief_type ?? null,
      updated_at: joined.status_updated_at ?? joined.file_updated_at,
    };
  }

  // briefs.ts:360-364 — metadata-only fallback from brief_status.
  const statusOnly = db.prepare(`
    SELECT title, status, priority, effort, phase, brief_type, updated_at
    FROM brief_status
    WHERE project = ? AND brief_id = ?
  `).get(project, briefId) as Record<string, unknown> | undefined;

  if (statusOnly) {
    // briefs.ts:370-383 — note `title` is NOT `?? null` here; verbatim.
    return {
      project,
      brief_id: briefId,
      content: null,
      filename: null,
      content_hash: null,
      title: statusOnly.title,
      status: statusOnly.status,
      priority: statusOnly.priority ?? null,
      effort: statusOnly.effort ?? null,
      phase: statusOnly.phase ?? null,
      brief_type: statusOnly.brief_type ?? null,
      updated_at: statusOnly.updated_at,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// FR-246 — brief RETRIEVAL
// ---------------------------------------------------------------------------
//
// TWO readers, deliberately, sharing one vector arm ({@link briefVectorArm}).
// D1-b, operator sign-off 2026-08-03:
//
//   - {@link searchBriefsByVector} backs `igris_brief_similar`, which is
//     `/register`'s DUPLICATE CHECK. It filters by *cosine similarity >=
//     threshold*. A BM25 hit has no cosine similarity to threshold against, so
//     making that path hybrid would silently change what counts as a duplicate.
//     It stays PURE VECTOR.
//   - {@link hybridSearchBriefs} backs the dashboard's `/api/briefs/search`,
//     mirroring `hybridSearchLearnings` field for field.
//
// "Unify them" is the tempting move and is the wrong one: they answer different
// questions. What they DO share is the one call to `vectorSearchFrom(...,
// 'briefs_vec', ...)` below — two call sites of that in one file is precisely
// the drift MAINTAINING row 110 exists to stop.
//
// WHAT THE BM25 ARM REACHES THAT THE VECTOR ARM CANNOT. `briefs_vec` is built
// by `extractBriefProblem` (`briefs.ts:838-851`) from the title plus the
// `## Problem` section only, at CREATE and by the backfill tool and nowhere
// else, with no update trigger (`db.ts` v23 header carries the full reading).
// So `briefs_fts` is NOT merely the offline fallback for the vector arm — it is
// the ONLY arm that sees a brief's BODY, and the only one that is current after
// an edit.

/**
 * The `reason` string {@link briefVectorArm} emits when `briefs_vec` is
 * missing. A named constant because two readers BRANCH on it — comparing
 * against a repeated string literal is how that branch goes silently dead when
 * someone rewords the message.
 */
const BRIEFS_VEC_ABSENT = 'brain table absent: briefs_vec';

/** L-133 preflight — same shape as `memory-read.ts#tableExists`. */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/** Options for {@link searchBriefsByVector}. Mirrors `BriefSimilarInput`. */
export interface SearchBriefsByVectorOptions {
  query: string;
  project?: string;
  threshold?: number;
  limit?: number;
}

/** One threshold-passing vector match, hydrated from `brief_status`. */
export interface BriefVectorMatch {
  rowid: number;
  similarity: number;
  row: Record<string, unknown> | null;
}

/**
 * The outcome of {@link searchBriefsByVector}.
 *
 * A DISCRIMINATED UNION rather than a row list because `handleBriefSimilar`
 * renders a DIFFERENT sentence for each of these states, and those sentences
 * are a wire contract `/register` reads. Collapsing "the extension is missing"
 * and "nothing was similar enough" into one empty array would make the wrapper
 * unable to reproduce its own output — `wrapper-wire-parity.test.ts` pins that.
 */
export type BriefVectorSearchResult =
  | { status: 'vector_unavailable' }
  /**
   * sqlite-vec IS loaded but `briefs_vec` does not exist.
   *
   * THE ONE DELIBERATE BEHAVIOUR CHANGE IN THIS EXTRACTION, stated rather than
   * buried: pre-FR-246 this state THREW out of `handleBriefSimilar`, because
   * `vectorSearchFrom` sat OUTSIDE the try that guarded `generateEmbedding`
   * (`briefs.ts:899` vs `:876-899`). The L-133 preflight converts that crash
   * into a capability sentence. It cannot regress any consumer: nothing was
   * parsing a thrown exception, so the sentence is new only in a state that
   * previously produced no sentence at all. Reporting it as
   * `no_vector_hits` — i.e. "nothing was similar" — was rejected: a missing
   * index answering "no matches" is the silent-degrade this brief exists to
   * remove.
   */
  | { status: 'vector_table_absent' }
  | { status: 'embeddings_unavailable' }
  | { status: 'embedding_failed'; error: string }
  | { status: 'no_vector_hits' }
  | { status: 'below_threshold' }
  | { status: 'ok'; matches: BriefVectorMatch[] };

/** Options for {@link hybridSearchBriefs}. Mirrors `HybridSearchOptions`. */
export interface BriefHybridSearchOptions {
  query: string;
  project?: string;
  limit?: number;
  bm25_weight?: number;
  vector_weight?: number;
  rrf_k?: number;
}

/**
 * A brief row as the SEARCH result list returns it.
 *
 * FR-240 D7 applies unchanged: **no `content` column.** A ranked list of briefs
 * whose bodies average ~3.9 KB (measured: 6,211,271 B over 1,597 rows) is the
 * superlinear payload term the "returns NO body content" rule removes.
 * `content_length` gives the row a size to render; the detail view fetches the
 * body.
 */
export interface BriefSearchRow {
  id: number;
  project: string;
  brief_id: string;
  brief_type: string | null;
  title: string;
  status: string;
  priority: string | null;
  effort: string | null;
  phase: string | null;
  updated_at: string;
  content_length: number;
  /** Present on the BM25 arm only. */
  rank?: number;
}

/**
 * {@link RetrievalReport} plus the one fact briefs have and learnings do not:
 * the BM25 arm itself can be missing.
 *
 * `learnings_fts` has existed since schema v1, so `hybridSearchLearnings` may
 * assume it. `briefs_fts` arrives at **v23**, so a brain that has not booted the
 * new migration — or one where v23 aborted on an unverifiable backup — has a
 * live vector arm and NO lexical arm. That state must be REPORTED, not silently
 * rendered as a thin result set, which is the same reasoning that produced
 * `vector_available` in the first place.
 */
export interface BriefRetrievalReport extends RetrievalReport {
  /** Why the BM25 arm could not run; `null` when `briefs_fts` was queryable. */
  bm25_reason: string | null;
}

/** One entry of the ranked brief list, in final display order. */
export interface BriefSearchEntry {
  id: number;
  row: BriefSearchRow | null;
  rrf_score: number | null;
  bm25_rank: number | null;
  vector_rank: number | null;
}

/** The structured result of {@link hybridSearchBriefs}. */
export interface BriefHybridSearchResult {
  rows: BriefSearchEntry[];
  retrieval: BriefRetrievalReport;
}

/**
 * The ONE `briefs_vec` call site. Both readers go through here.
 *
 * Never throws: a missing extension, an absent `briefs_vec` table, an
 * un-cached HF model and an offline host are all ORDINARY states. Each is
 * reported through `reason` so the caller can say which one happened.
 */
async function briefVectorArm(
  db: Database.Database,
  query: string,
  limit: number,
): Promise<{
  hits: VectorSearchResult[];
  probe: boolean;
  embedded: boolean;
  ran: boolean;
  reason: string | null;
  embeddingsUnavailable: boolean;
}> {
  const probe = isVectorSearchAvailable(db);
  if (!probe) {
    return {
      hits: [],
      probe: false,
      embedded: false,
      ran: false,
      reason: 'sqlite-vec not loaded on this connection',
      embeddingsUnavailable: false,
    };
  }
  // The two failure scopes are kept SEPARATE, mirroring the pre-extraction code
  // (`briefs.ts:876-899` wrapped `generateEmbedding` alone; `vectorSearchFrom`
  // sat outside it). One shared catch was written first and was WRONG: with the
  // vec table absent it reported a genuine `generateEmbedding` crash as
  // "briefs_vec is missing", swallowing the real message. Caught by
  // `brief-similar.test.ts`'s "should still surface non-unavailable embedding
  // errors with detail", which is exactly the test that should have caught it.
  let embedding: Float32Array;
  try {
    embedding = await generateEmbedding(query);
  } catch (err) {
    return {
      hits: [],
      probe: true,
      embedded: false,
      ran: false,
      reason: err instanceof Error ? err.message : String(err),
      embeddingsUnavailable: err instanceof EmbeddingsUnavailableError,
    };
  }

  try {
    const hits = vectorSearchFrom(db, 'briefs_vec', embedding, limit);
    return { hits, probe: true, embedded: true, ran: true, reason: null, embeddingsUnavailable: false };
  } catch (err) {
    // The L-133 preflight is consulted HERE, in the vector-search failure path,
    // rather than as a gate before the arm. Two reasons, the second decisive:
    //   1. `sqlite_master` is only interesting once something has ALREADY gone
    //      wrong — it turns an opaque "no such table: briefs_vec" into a named
    //      state WITHOUT matching on SQLite's error text, which is not a
    //      contract.
    //   2. Gating the happy path on the table's PHYSICAL existence would break
    //      every caller that legitimately doubles the vector layer. The brain's
    //      own suites do exactly that (`:memory:` cannot load sqlite-vec, so
    //      `vector-search.js` is `vi.mock`ed), and a preflight would have made
    //      those doubles unreachable — a check that forces the tests to fake
    //      MORE of the world has stopped describing the world.
    const absent = !tableExists(db, 'briefs_vec');
    return {
      hits: [],
      probe: true,
      // The embedding DID succeed; only the search failed. Reporting otherwise
      // would point diagnosis at the model instead of at the index.
      embedded: true,
      ran: false,
      reason: absent ? BRIEFS_VEC_ABSENT : err instanceof Error ? err.message : String(err),
      embeddingsUnavailable: false,
    };
  }
}

/**
 * Find briefs semantically similar to a query — **pure vector, by design.**
 *
 * Body moved from `briefs.ts:862-990` (`handleBriefSimilar`), which is what
 * gets that handler off `getDb()`. Threshold semantics preserved exactly:
 * `limit * 3` over-fetch, L2 → cosine via `l2ToCosine`, `>= threshold`, results
 * emitted in SIMILARITY order and capped at `limit` AFTER the project filter
 * drops non-matching rows.
 *
 * @param db - A connection. May be read-only; this function never writes.
 */
export async function searchBriefsByVector(
  db: Database.Database,
  opts: SearchBriefsByVectorOptions,
): Promise<BriefVectorSearchResult> {
  const threshold = opts.threshold ?? 0.85;
  const limit = opts.limit ?? 5;

  // briefs.ts:866-873 — the probe is checked BEFORE the embedding, so a host
  // without sqlite-vec never pays for a model load.
  const arm = await briefVectorArm(db, opts.query, limit * 3);
  if (!arm.probe) return { status: 'vector_unavailable' };
  if (!arm.ran) {
    // briefs.ts:884-899 — BR-070's typed degrade gets a capability sentence;
    // anything else surfaces its detail for diagnosis.
    if (arm.embeddingsUnavailable) return { status: 'embeddings_unavailable' };
    if (arm.reason === BRIEFS_VEC_ABSENT) return { status: 'vector_table_absent' };
    return { status: 'embedding_failed', error: arm.reason ?? 'unknown' };
  }

  // briefs.ts:904-910
  if (arm.hits.length === 0) return { status: 'no_vector_hits' };

  // briefs.ts:913-925
  const candidates = arm.hits
    .map((r) => ({ rowid: r.rowid, similarity: l2ToCosine(r.distance) }))
    .filter((r) => r.similarity >= threshold);

  if (candidates.length === 0) return { status: 'below_threshold' };

  // briefs.ts:928-947 — hydrate, then re-order by similarity.
  const ids = candidates.map((c) => c.rowid);
  const placeholders = ids.map(() => '?').join(',');
  let sql = `
    SELECT bs.id, bs.project, bs.brief_id, bs.title, bs.status, bs.priority, bs.brief_type
    FROM brief_status bs
    WHERE bs.id IN (${placeholders})
  `;
  const params: unknown[] = [...ids];
  if (opts.project) {
    sql += ' AND bs.project = ?';
    params.push(opts.project);
  }
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  const rowMap = new Map<number, Record<string, unknown>>();
  for (const row of rows) rowMap.set(row.id as number, row);

  // briefs.ts:952-968 — similarity order, `continue` on a filtered-out row, cap
  // at `limit`. The empty case is the CALLER's to phrase: it has two different
  // sentences depending on whether a project filter was supplied.
  const matches: BriefVectorMatch[] = [];
  for (const candidate of candidates) {
    const row = rowMap.get(candidate.rowid);
    if (!row) continue;
    matches.push({ rowid: candidate.rowid, similarity: candidate.similarity, row });
    if (matches.length >= limit) break;
  }

  return { status: 'ok', matches };
}

/**
 * Hybrid BM25 + vector recall over briefs, RRF-fused.
 *
 * Mirrors {@link hybridSearchLearnings} field for field — `sanitizeFts5Query`,
 * `limit * 2` over-fetch per arm, `computeRRF` at `k = 60`, and a report of
 * which arms actually ran. The differences from the learnings twin are only the
 * two the domain forces:
 *
 *   1. **No `review_status` gate.** Briefs have no such column; there is no
 *      FR-109 conscious/subconscious split to honour here.
 *   2. **The BM25 arm can be absent** (pre-v23), so the report carries
 *      `bm25_reason` — see {@link BriefRetrievalReport}.
 *
 * NEVER throws for an arm failure. A missing extension, a missing table, an
 * absent HF model cache and an offline host are all ordinary states that
 * degrade to a stated mode.
 *
 * @param db - A connection. May be read-only; this function never writes.
 */
export async function hybridSearchBriefs(
  db: Database.Database,
  opts: BriefHybridSearchOptions,
): Promise<BriefHybridSearchResult> {
  const limit = Math.max(1, Math.floor(opts.limit ?? 10));
  const bm25Weight = opts.bm25_weight ?? 0.5;
  const vectorWeight = opts.vector_weight ?? 0.5;
  const k = opts.rrf_k ?? 60;
  const weights = { bm25: bm25Weight, vector: vectorWeight };

  // --- 1. BM25 arm -------------------------------------------------------
  let bm25Rows: BriefSearchRow[] = [];
  let bm25Reason: string | null = null;

  if (!tableExists(db, 'briefs_fts')) {
    // L-133: a pre-v23 brain reports a REASON. It must not throw, and it must
    // not silently return a thinner result set that reads like "no matches".
    bm25Reason = 'brain table absent: briefs_fts (schema v23 not applied)';
  } else {
    const sanitized = sanitizeFts5Query(opts.query);
    if (!sanitized) {
      bm25Reason = 'query has no searchable tokens after FTS5 sanitisation';
    } else {
      let bm25Sql = `
        SELECT bs.id, bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
               bs.priority, bs.effort, bs.phase, bs.updated_at,
               COALESCE(LENGTH(bf.content), 0) AS content_length, rank
        FROM briefs_fts fts
        JOIN brief_status bs ON bs.id = fts.rowid
        LEFT JOIN brief_files bf ON bf.project = bs.project AND bf.brief_id = bs.brief_id
        WHERE briefs_fts MATCH ?
      `;
      const bm25Params: (string | number)[] = [sanitized];
      if (opts.project) {
        bm25Sql += ' AND bs.project = ?';
        bm25Params.push(opts.project);
      }
      bm25Sql += ' ORDER BY rank LIMIT ?';
      bm25Params.push(limit * 2);
      try {
        bm25Rows = db.prepare(bm25Sql).all(...bm25Params) as BriefSearchRow[];
      } catch (err) {
        bm25Rows = [];
        bm25Reason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // --- 2. Vector arm, graceful ------------------------------------------
  const arm = await briefVectorArm(db, opts.query, limit * 2);
  let vecResults = arm.hits;

  // Project filter on the vector arm. `briefs_vec` carries no project column,
  // so the filter is a second lookup against `brief_status` — the same shape
  // `hybridSearchLearnings` uses, minus its `review_status` clause.
  if (opts.project && vecResults.length > 0) {
    const ids = vecResults.map((r) => r.rowid);
    const placeholders = ids.map(() => '?').join(',');
    const filterRows = db
      .prepare(`SELECT id FROM brief_status WHERE id IN (${placeholders}) AND project = ?`)
      .all(...ids, opts.project) as { id: number }[];
    const keep = new Set(filterRows.map((r) => r.id));
    vecResults = vecResults.filter((r) => keep.has(r.rowid));
  }

  const baseReport = (): BriefRetrievalReport => ({
    mode: 'none',
    // The PROBE, not the arm's outcome — see `RetrievalReport.vector_available`.
    vector_available: arm.probe,
    embedding_available: arm.embedded,
    bm25_hits: bm25Rows.length,
    vector_hits: vecResults.length,
    rrf_k: k,
    weights,
    reason: arm.reason,
    bm25_reason: bm25Reason,
  });

  // --- 3. Nothing at all -------------------------------------------------
  if (bm25Rows.length === 0 && vecResults.length === 0) {
    return { rows: [], retrieval: baseReport() };
  }

  // --- 4. BM25-only fallback --------------------------------------------
  //
  // Condition mirrors the learnings twin exactly: a vector arm that RAN but
  // matched nothing is a BM25-only render, and the mode says so honestly.
  if (!arm.ran || vecResults.length === 0) {
    return {
      rows: bm25Rows.slice(0, limit).map((row) => ({
        id: row.id,
        row,
        rrf_score: null,
        bm25_rank: null,
        vector_rank: null,
      })),
      retrieval: { ...baseReport(), mode: 'bm25_only' },
    };
  }

  // --- 5. RRF merge ------------------------------------------------------
  const rrfEntries = computeRRF(bm25Rows, vecResults, bm25Weight, vectorWeight, k);
  const topEntries = rrfEntries.slice(0, limit);
  const topIds = topEntries.map((e) => e.id);
  if (topIds.length === 0) {
    return { rows: [], retrieval: baseReport() };
  }

  const placeholders = topIds.map(() => '?').join(',');
  const fullRows = db
    .prepare(
      `SELECT bs.id, bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
              bs.priority, bs.effort, bs.phase, bs.updated_at,
              COALESCE(LENGTH(bf.content), 0) AS content_length
         FROM brief_status bs
         LEFT JOIN brief_files bf
                ON bf.project = bs.project AND bf.brief_id = bs.brief_id
        WHERE bs.id IN (${placeholders})`,
    )
    .all(...topIds) as BriefSearchRow[];

  const rowMap = new Map<number, BriefSearchRow>();
  for (const row of fullRows) rowMap.set(row.id, row);

  return {
    rows: topEntries.map((entry) => ({
      id: entry.id,
      // `null` for an id that vanished between RRF and hydration — the same
      // case the learnings twin carries rather than silently dropping.
      row: rowMap.get(entry.id) ?? null,
      rrf_score: entry.score,
      bm25_rank: entry.bm25_rank,
      vector_rank: entry.vector_rank,
    })),
    retrieval: {
      ...baseReport(),
      // `vector_only` and `hybrid` both took THIS branch. The distinction is
      // REPORTED, not acted on — identical to the learnings twin.
      mode: bm25Rows.length > 0 ? 'hybrid' : 'vector_only',
    },
  };
}
