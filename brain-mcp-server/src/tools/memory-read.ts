/**
 * Igris Brain — Learning READ layer (pure, `db`-param).
 *
 * FR-240 D1, the same pure-layer / MCP-wrapper split as `briefs-read.ts`.
 *
 *   **This file MUST NOT import `../db.js`, and MUST NOT write.**
 *
 * Mechanically enforced by `__tests__/pure-read-purity.test.ts`.
 *
 * THE `access_count` CARVE-OUT (G2 / TD-092)
 * ------------------------------------------
 * `handleMemoryGet` and `handleMemoryRecall` both
 * `UPDATE learnings SET access_count = access_count + 1`. TD-092 records that
 * bump as **correct and load-bearing** — it powers the composite-ranking boost
 * and the recall telemetry. So the bump is NOT deleted and NOT moved here: it
 * stays in the wrapper (`memory.ts`), and {@link getLearning} is the
 * non-bumping reader the dashboard uses. `handleMemoryRecall` is deliberately
 * left un-extracted this brief — it is a much larger surface with a transaction
 * in the middle of it.
 *
 * FINGERPRINT PATH — DELIBERATELY UNCHANGED (MAINTAINING row 100)
 * ---------------------------------------------------------------
 * Row 100 names `handleMemoryHybridSearch` as a **residual raw** embedding
 * fingerprint path awaiting a follow-up TD: the query text is embedded as-is,
 * without the normalisation the store path applies. FR-240 MOVES that code; it
 * does not fix it. Normalising here would change recall results for every
 * caller and belongs to row 100's named follow-up, not to a UI brief. The
 * residual path now lives at {@link hybridSearchLearnings} — row 100's citation
 * points here.
 *
 * CONSUMERS (MAINTAINING — the pure `db`-param READ layer row)
 * ------------------------------------------------------------
 * `tools/memory.ts#handleMemoryHybridSearch` / `#handleMemoryGet` (MCP
 * wrappers) · `cli/src/lib/brain-bridge.ts` · `cli/src/lib/dashboard/routes.ts`.
 *
 * @module tools/memory-read
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { sanitizeFts5Query } from '../utils/fts5.js';
import { generateEmbedding } from '../utils/embeddings.js';
import { isVectorSearchAvailable, vectorSearch } from '../utils/vector-search.js';
import type { VectorSearchResult } from '../utils/vector-search.js';
import { computeRRF } from '../utils/hybrid-search.js';

// ---------------------------------------------------------------------------
// Row and option shapes
// ---------------------------------------------------------------------------

/**
 * A hydrated learning row as the search/detail paths return it.
 *
 * Structurally identical to `memory.ts`'s private `Bm25Row` (memory.ts:162) —
 * duplicated rather than exported from there so this module has no import edge
 * back into the wrapper it serves.
 */
export interface LearningRow {
  id: number;
  project: string;
  category: string;
  title: string;
  content: string;
  tags: string;
  tech_stack: string;
  scope: string;
  source_brief: string;
  confidence: number;
  created_at: string;
  access_count: number;
  provenance: string;
  /** Present on the BM25 arm only; the RRF hydration SELECT also returns it. */
  rank?: number;
  /** FR-200 M2 — set when the standard was promoted into a context doc. */
  promoted_to_doc?: string | null;
}

/** Options for {@link hybridSearchLearnings}. Mirrors `HybridSearchInput`. */
export interface HybridSearchOptions {
  query: string;
  project?: string;
  limit?: number;
  bm25_weight?: number;
  vector_weight?: number;
  rrf_k?: number;
}

/**
 * Which retrieval arms actually ran, and what each contributed.
 *
 * FR-240 D3. This block exists because the failure it describes is SILENT:
 * `isVectorSearchAvailable(db)` probes `SELECT vec_version()` on *that
 * connection*, so a handle that never loaded sqlite-vec falls through to the
 * BM25-only arm and still returns plausible results. AC #2 ("demonstrably uses
 * hybrid recall") would then pass review and fail in reality. Reporting the
 * mode makes the degradation assertable and loud.
 */
export interface RetrievalReport {
  /**
   * - `hybrid` — both arms contributed and were RRF-fused.
   * - `vector_only` — the RRF path ran but BM25 matched nothing.
   * - `bm25_only` — the vector arm was unavailable or returned nothing.
   * - `none` — no rows at all.
   */
  mode: 'hybrid' | 'bm25_only' | 'vector_only' | 'none';
  /**
   * `SELECT vec_version()` succeeded on THIS connection — i.e. the CONNECTION
   * can run vector search.
   *
   * Deliberately NOT "the vector arm contributed". Those are different facts
   * with different remedies: a false here means the extension was never loaded
   * onto the handle (a packaging or bridge problem), whereas a true here with
   * `mode: 'bm25_only'` means the extension is fine and something downstream —
   * the embedding, or an absent `learnings_vec` — did not deliver. Collapsing
   * the two into one boolean is exactly the diagnosis-destroying conflation D3
   * exists to prevent. Whether the arm CONTRIBUTED is carried by `mode` and
   * `vector_hits`.
   */
  vector_available: boolean;
  /**
   * An embedding was successfully generated during THIS call. `false` also
   * covers "never attempted" (the vector arm was skipped) — see `reason`.
   */
  embedding_available: boolean;
  bm25_hits: number;
  vector_hits: number;
  rrf_k: number;
  weights: { bm25: number; vector: number };
  /** Why the vector arm degraded, verbatim; null when it ran or was not needed. */
  reason: string | null;
}

/**
 * One entry of the ranked result list, in final display order.
 *
 * `row` is `null` for an id that survived RRF but failed the TD-059 hydration
 * filter (or was deleted between the two queries). The wrapper renders that as
 * `(record not found)` — a case the pre-extraction code already had
 * (memory.ts:1212), so it is preserved rather than silently dropped.
 */
export interface HybridSearchEntry {
  id: number;
  row: LearningRow | null;
  rrf_score: number | null;
  bm25_rank: number | null;
  vector_rank: number | null;
}

/** The structured result of {@link hybridSearchLearnings}. */
export interface HybridSearchResult {
  rows: HybridSearchEntry[];
  retrieval: RetrievalReport;
}

/** Filters and pagination accepted by {@link listLearnings}. */
export interface ListLearningsOptions {
  project?: string;
  category?: string;
  scope?: string;
  provenance?: string;
  /** Defaults to `'approved'` at the CALLER; passing undefined means no filter. */
  review_status?: string;
  limit?: number;
  offset?: number;
}

/**
 * A learning as the LIST view sees it.
 *
 * D7: **no `content` column.** ~1000+ rows × a multi-KB body is the superlinear
 * payload term the FR-237 "returns NO body content" rule exists to remove.
 * `content_length` is served instead so a list row can show a size without the
 * body. Detail is {@link getLearning}'s job.
 */
export interface LearningListRow {
  id: number;
  project: string;
  category: string;
  title: string;
  tags: string;
  tech_stack: string;
  scope: string;
  source_brief: string;
  confidence: number;
  created_at: string;
  access_count: number;
  provenance: string;
  review_status: string;
  source_extractor: string;
  promoted_to_doc: string | null;
  content_length: number;
  /**
   * FR-241 — how many times the perception dedup layer re-discovered this
   * pattern. It is the DESTRUCTIVENESS DISCRIMINATOR for the triage surface:
   * `igris_perception_reject` forks on it (`perception/handlers.ts:661-717`,
   * FR-116 M3) — `> 0` SOFT-deletes (review_status='rejected' + deleted_at,
   * recoverable), `== 0` HARD-deletes the row and its `learnings_vec` entry.
   * A confirmation dialog cannot state which of those it is about to do without
   * this column, and a blanket "irreversible" banner would be a LIE for the
   * recurring rows — which is how an operator learns to click through it.
   * `COALESCE`d because legacy rows predate the column.
   */
  seen_again_count: number;
  /** FR-241 — non-null iff the row is already soft-deleted. Audit-only. */
  deleted_at: string | null;
}

/** The {@link listLearnings} payload. */
export interface ListLearningsResult {
  learnings: LearningListRow[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  /** Set when the `learnings` table is absent (L-133); the arrays are empty. */
  degraded: string | null;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * L-133 preflight — verbatim shape from `handleSessionFileList`
 * (`tools/sessions.ts:316-318`). A brain DB where the migration never ran must
 * yield an empty result, never a throw, and NEVER a `CREATE TABLE`.
 */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/**
 * Fetch one learning by id — the SELECT ONLY.
 *
 * Moved verbatim from `memory.ts:763-769`. The `UPDATE access_count` that
 * followed it there is NOT here and must not be added: see the module header's
 * carve-out note. Returns `null` when absent.
 *
 * INTENTIONAL (verbatim from the origin): no `review_status` filter. The
 * perception-review surface fetches pending rows by id for the approval UI.
 * A caller that must not see pending rows checks `review_status` itself.
 *
 * @param db - A connection. May be read-only; this function never writes.
 */
export function getLearning(
  db: Database.Database,
  id: number,
): Record<string, unknown> | null {
  const row = db.prepare(`
    SELECT id, project, category, title, content, tags,
           tech_stack, scope, source_brief, confidence,
           created_at, access_count, provenance
    FROM learnings
    WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined;
  return row ?? null;
}

/**
 * Browse learnings by filter — **new query, FR-240 G1.**
 *
 * No handler in the memory component offered a query-less, filter-based browse:
 * `igris_memory_search` is FTS-only, `igris_memory_hybrid_search` requires a
 * query, `igris_memory_dashboard` returns counts. The dashboard's brief-style
 * list view had no backing reader, so this is the one genuinely new SELECT in
 * the FR-240 read layer.
 *
 * Ordering is `created_at DESC, id DESC` — `created_at` has second resolution
 * and a `/harvest` run stores several rows inside one second, so `id` is the
 * tiebreak that makes pagination stable. Without it, two pages can show the
 * same row and skip another.
 *
 * @param db - A connection. May be read-only; this function never writes.
 */
export function listLearnings(
  db: Database.Database,
  opts: ListLearningsOptions = {},
): ListLearningsResult {
  const limit = Math.max(1, Math.floor(opts.limit ?? 50));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  if (!tableExists(db, 'learnings')) {
    return {
      learnings: [],
      count: 0,
      total: 0,
      limit,
      offset,
      degraded: 'brain table absent: learnings',
    };
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.project) {
    conditions.push('project = ?');
    params.push(opts.project);
  }
  if (opts.category) {
    conditions.push('category = ?');
    params.push(opts.category);
  }
  if (opts.scope) {
    conditions.push('scope = ?');
    params.push(opts.scope);
  }
  if (opts.provenance) {
    conditions.push('provenance = ?');
    params.push(opts.provenance);
  }
  if (opts.review_status) {
    conditions.push('review_status = ?');
    params.push(opts.review_status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM learnings ${whereClause}`)
    .get(...params) as { total: number };

  // D7 — `content` is deliberately absent from the projection. LENGTH() gives
  // the list a size to render without shipping the body.
  const rows = db.prepare(`
    SELECT id, project, category, title, tags, tech_stack, scope,
           source_brief, confidence, created_at, access_count, provenance,
           review_status, source_extractor, promoted_to_doc,
           COALESCE(seen_again_count, 0) AS seen_again_count, deleted_at,
           LENGTH(content) AS content_length
    FROM learnings
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as LearningListRow[];

  return {
    learnings: rows,
    count: rows.length,
    total: countRow.total,
    limit,
    offset,
    degraded: null,
  };
}

/**
 * Hybrid BM25 + vector recall over `learnings`, RRF-fused.
 *
 * Body lifted whole from `memory.ts:1080-1215` (`handleMemoryHybridSearch`),
 * returning STRUCTURED entries plus a {@link RetrievalReport} instead of prose.
 * The wrapper renders the prose; the dashboard reads the structure. One
 * implementation, two presentations.
 *
 * Preserved exactly:
 *  - the FR-109 `review_status = 'approved'` gate on BOTH arms;
 *  - the TD-059 defence-in-depth gate on the hydration SELECT;
 *  - the `limit * 2` over-fetch on each arm before fusion;
 *  - the raw (un-normalised) query embedding — MAINTAINING row 100, see header.
 *
 * NEVER throws for a vector-arm failure: a missing extension, an absent HF
 * model cache and an offline host are all ordinary states that degrade to
 * `mode: 'bm25_only'`.
 *
 * @param db - A connection. May be read-only; this function never writes.
 */
export async function hybridSearchLearnings(
  db: Database.Database,
  opts: HybridSearchOptions,
): Promise<HybridSearchResult> {
  const limit = opts.limit ?? 10;
  const bm25Weight = opts.bm25_weight ?? 0.5;
  const vectorWeight = opts.vector_weight ?? 0.5;
  const k = opts.rrf_k ?? 60;

  const weights = { bm25: bm25Weight, vector: vectorWeight };

  // --- 1. BM25 search via FTS5 (memory.ts:1086-1118) ----------------------
  const sanitized = sanitizeFts5Query(opts.query);
  let bm25Rows: LearningRow[] = [];

  if (sanitized) {
    // FR-109 filter: hybrid search is part of the conscious channel.
    // Pending_review rows must not surface here — only `igris_perception_*`
    // tools see them.
    let bm25Sql = `
      SELECT l.id, l.project, l.category, l.title, l.content, l.tags,
             l.tech_stack, l.scope, l.source_brief, l.confidence,
             l.created_at, l.access_count, l.provenance, l.promoted_to_doc, rank
      FROM learnings_fts fts
      JOIN learnings l ON l.id = fts.rowid
      WHERE learnings_fts MATCH ?
        AND l.review_status = 'approved'
    `;
    const bm25Params: (string | number)[] = [sanitized];

    if (opts.project) {
      bm25Sql += ' AND l.project = ?';
      bm25Params.push(opts.project);
    }

    bm25Sql += ' ORDER BY rank LIMIT ?';
    bm25Params.push(limit * 2);

    try {
      bm25Rows = db.prepare(bm25Sql).all(...bm25Params) as LearningRow[];
    } catch {
      bm25Rows = [];
    }
  }

  // --- 2. Vector search, with graceful fallback (memory.ts:1120-1150) -----
  let vecResults: VectorSearchResult[] = [];
  let vectorAvailable = false;
  let embeddingAvailable = false;
  let reason: string | null = null;

  const vecProbe = isVectorSearchAvailable(db);
  if (!vecProbe) {
    reason = 'sqlite-vec not loaded on this connection';
  }

  try {
    if (vecProbe) {
      const queryEmbedding = await generateEmbedding(opts.query);
      embeddingAvailable = true;
      vecResults = vectorSearch(db, queryEmbedding, limit * 2);
      vectorAvailable = true;

      // If project filter is set, filter vector results to matching project.
      // FR-109: always gate on review_status='approved' (whether or not the
      // caller passed a project filter) so pending_review rows are hidden
      // from the conscious channel via the vector path too.
      if (vecResults.length > 0) {
        const ids = vecResults.map(r => r.rowid);
        const placeholders = ids.map(() => '?').join(',');
        let filterSql = `SELECT id FROM learnings WHERE id IN (${placeholders}) AND review_status = 'approved'`;
        const filterParams: unknown[] = [...ids];
        if (opts.project) {
          filterSql += ' AND project = ?';
          filterParams.push(opts.project);
        }
        const filterRows = db.prepare(filterSql).all(...filterParams) as { id: number }[];
        const filterIdSet = new Set(filterRows.map(r => r.id));
        vecResults = vecResults.filter(r => filterIdSet.has(r.rowid));
      }
    }
  } catch (err) {
    // Verbatim from memory.ts:1148-1150. `EmbeddingsUnavailableError` (the
    // typed BR-070 degrade signal) lands here, as does an offline cold cache.
    console.error('[memory] Vector search failed, using BM25 only:', err);
    reason = err instanceof Error ? err.message : String(err);
  }

  const noneReport = (): RetrievalReport => ({
    mode: 'none',
    // The PROBE, not the arm's outcome — see the field's doc comment. The
    // internal `vectorAvailable` (arm completed) still drives the branch below,
    // so the control flow is byte-identical to the pre-extraction handler.
    vector_available: vecProbe,
    embedding_available: embeddingAvailable,
    bm25_hits: bm25Rows.length,
    vector_hits: vecResults.length,
    rrf_k: k,
    weights,
    reason,
  });

  // --- 3. No results at all (memory.ts:1152-1160) -------------------------
  if (bm25Rows.length === 0 && vecResults.length === 0) {
    return { rows: [], retrieval: noneReport() };
  }

  // --- 4. BM25-only fallback if vector unavailable (memory.ts:1162-1171) --
  //
  // NOTE the condition is unchanged: `vectorAvailable && vecResults.length > 0`
  // is what selects the fusion arm. A vector arm that RAN but matched nothing
  // is a BM25-only render, and the mode reports that honestly.
  if (!vectorAvailable || vecResults.length === 0) {
    return {
      rows: bm25Rows.slice(0, limit).map((row) => ({
        id: row.id,
        row,
        rrf_score: null,
        bm25_rank: null,
        vector_rank: null,
      })),
      retrieval: { ...noneReport(), mode: 'bm25_only' },
    };
  }

  // --- 5. RRF merge (memory.ts:1173-1214) ---------------------------------
  const rrfEntries = computeRRF(bm25Rows, vecResults, bm25Weight, vectorWeight, k);
  const topEntries = rrfEntries.slice(0, limit);

  const topIds = topEntries.map(e => e.id);
  if (topIds.length === 0) {
    return { rows: [], retrieval: noneReport() };
  }

  const placeholders = topIds.map(() => '?').join(',');
  // TD-059: defense-in-depth `review_status='approved'` filter on the hybrid
  // search hydration path. `bm25Rows` and `vecResults` already exclude
  // pending_review rows upstream, but a future caller bypassing those filters
  // must not leak unapproved rows through this hydration step.
  const fullRows = db.prepare(
    `SELECT id, project, category, title, content, tags, tech_stack, scope,
            source_brief, confidence, created_at, access_count, provenance,
            promoted_to_doc
     FROM learnings
     WHERE id IN (${placeholders})
       AND review_status = 'approved'`,
  ).all(...topIds) as LearningRow[];

  const rowMap = new Map<number, LearningRow>();
  for (const row of fullRows) {
    rowMap.set(row.id, row);
  }

  return {
    rows: topEntries.map((entry) => ({
      id: entry.id,
      row: rowMap.get(entry.id) ?? null,
      rrf_score: entry.score,
      bm25_rank: entry.bm25_rank,
      vector_rank: entry.vector_rank,
    })),
    retrieval: {
      ...noneReport(),
      // `vector_only` and `hybrid` both took THIS branch, so both render as
      // "hybrid BM25 + vector" in the wrapper's prose — which is exactly what
      // the pre-extraction code did. The distinction is reported, not acted on.
      mode: bm25Rows.length > 0 ? 'hybrid' : 'vector_only',
    },
  };
}
