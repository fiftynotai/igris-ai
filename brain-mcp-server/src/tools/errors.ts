/**
 * Igris Brain — Error Tools
 *
 * Provides error fingerprinting, solution storage, and lookup.
 * Normalizes error messages to create stable fingerprints that match
 * across different file paths, line numbers, and hex addresses.
 *
 * Tools:
 * - igris_error_lookup: Look up or store error solutions
 *
 * @module tools/errors
 * @author fifty.dev
 */

import { getDb } from '../db.js';
import { sanitizeFts5Query } from '../utils/fts5.js';
import { generateEmbedding, embeddingToBuffer, processInBatches, EMBEDDING_MODEL } from '../utils/embeddings.js';
import { isVectorSearchAvailable, insertEmbeddingInto, vectorSearchFrom } from '../utils/vector-search.js';
import { computeRRF } from '../utils/hybrid-search.js';

/** Input shape for igris_error_lookup */
interface ErrorLookupInput {
  message: string;
  project: string;
  solution?: string;
}

/**
 * Create a simple numeric hash from a string.
 * No cryptographic guarantees -- just deterministic fingerprinting.
 *
 * @param str - The string to hash
 * @returns A base-36 string representation of the hash
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Normalize an error message for fingerprinting.
 *
 * Strips file paths, line/column numbers, hex addresses, and long hashes
 * so that the same logical error produces the same fingerprint regardless
 * of which file or line it occurred on.
 *
 * @param message - Raw error message
 * @returns Normalized message string
 */
function normalizeErrorMessage(message: string): string {
  return message
    .replace(/\/[\w/.-]+/g, '<path>')
    .replace(/:\d+:\d+/g, ':<line>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b[0-9a-f]{6,}\b/gi, '<hash>');
}

/**
 * Create a fingerprint for an error message.
 *
 * @param message - Raw error message
 * @returns Fingerprint string
 */
function createFingerprint(message: string): string {
  const normalized = normalizeErrorMessage(message);
  return simpleHash(normalized);
}

/**
 * Look up or store an error solution.
 *
 * When `solution` is provided, upserts the error record (inserts new or
 * increments occurrence_count and updates the solution for existing).
 * When no solution is provided, searches by fingerprint first, then
 * falls back to FTS5 full-text search.
 *
 * @param args - Error lookup parameters
 * @returns MCP-formatted response with results
 */
/** Max content size: 1 MB */
const MAX_CONTENT_LENGTH = 1_048_576;
const MAX_PROJECT_LENGTH = 255;

async function handleErrorLookup(args: ErrorLookupInput): Promise<{ content: { type: string; text: string }[] }> {
  if (!args.project || args.project.length > MAX_PROJECT_LENGTH) {
    return { content: [{ type: 'text', text: `Validation error: project must be 1-${MAX_PROJECT_LENGTH} characters.` }] };
  }
  if (!args.message || args.message.length > MAX_CONTENT_LENGTH) {
    return { content: [{ type: 'text', text: `Validation error: message must be 1-${MAX_CONTENT_LENGTH} characters (1 MB max).` }] };
  }
  if (args.solution && args.solution.length > MAX_CONTENT_LENGTH) {
    return { content: [{ type: 'text', text: `Validation error: solution must be at most ${MAX_CONTENT_LENGTH} characters (1 MB max).` }] };
  }

  const db = getDb();
  const fingerprint = createFingerprint(args.message);

  if (args.solution) {
    // Upsert mode: store or update the error solution
    const existing = db.prepare(
      'SELECT id, occurrence_count FROM errors WHERE fingerprint = ? AND project = ?'
    ).get(fingerprint, args.project) as { id: number; occurrence_count: number } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE errors
        SET solution = ?,
            occurrence_count = occurrence_count + 1,
            last_seen_at = datetime('now')
        WHERE id = ?
      `).run(args.solution, existing.id);

      // Auto-embed on update (non-blocking)
      let embeddingNote = '';
      try {
        if (isVectorSearchAvailable(db)) {
          const embedding = await generateEmbedding(`${args.message} ${args.solution}`);
          db.prepare('UPDATE errors SET embedding = ?, embedding_model = ? WHERE id = ?')
            .run(embeddingToBuffer(embedding), EMBEDDING_MODEL, existing.id);
          insertEmbeddingInto(db, 'errors_vec', existing.id, embedding);
          embeddingNote = '\nEmbedding: updated';
        }
      } catch (err) {
        console.error('[errors] Auto-embed failed for error', existing.id, ':', err);
      }

      return {
        content: [{
          type: 'text',
          text: `Error solution updated.\n\nID: ${existing.id}\nFingerprint: ${fingerprint}\nOccurrences: ${existing.occurrence_count + 1}\nSolution: ${args.solution}${embeddingNote}`,
        }],
      };
    } else {
      const result = db.prepare(`
        INSERT INTO errors (project, fingerprint, message, solution)
        VALUES (?, ?, ?, ?)
      `).run(args.project, fingerprint, args.message, args.solution);

      const errorId = result.lastInsertRowid as number;

      // Auto-embed on insert (non-blocking)
      let embeddingNote = '';
      try {
        if (isVectorSearchAvailable(db)) {
          const embedding = await generateEmbedding(`${args.message} ${args.solution}`);
          db.prepare('UPDATE errors SET embedding = ?, embedding_model = ? WHERE id = ?')
            .run(embeddingToBuffer(embedding), EMBEDDING_MODEL, errorId);
          insertEmbeddingInto(db, 'errors_vec', errorId, embedding);
          embeddingNote = '\nEmbedding: generated';
        }
      } catch (err) {
        console.error('[errors] Auto-embed failed for error', errorId, ':', err);
      }

      return {
        content: [{
          type: 'text',
          text: `Error solution stored.\n\nID: ${errorId}\nFingerprint: ${fingerprint}\nProject: ${args.project}\nSolution: ${args.solution}${embeddingNote}`,
        }],
      };
    }
  }

  // Lookup mode: search for matching error solutions

  // First try exact fingerprint match
  const exactMatch = db.prepare(`
    SELECT id, project, fingerprint, message, solution, context, occurrence_count,
           first_seen_at, last_seen_at, resolved_at
    FROM errors
    WHERE fingerprint = ?
    ORDER BY occurrence_count DESC
    LIMIT 5
  `).all(fingerprint) as Record<string, unknown>[];

  if (exactMatch.length > 0) {
    const results = exactMatch.map((row, i) => {
      return [
        `--- Match ${i + 1} (fingerprint) ---`,
        `ID: ${row.id}`,
        `Project: ${row.project}`,
        `Message: ${row.message}`,
        `Solution: ${row.solution || '(no solution recorded)'}`,
        `Occurrences: ${row.occurrence_count}`,
        `First Seen: ${row.first_seen_at}`,
        `Last Seen: ${row.last_seen_at}`,
        `Resolved: ${row.resolved_at || 'No'}`,
      ].join('\n');
    });

    return {
      content: [{
        type: 'text',
        text: `Found ${exactMatch.length} matching error(s) by fingerprint:\n\n${results.join('\n\n')}`,
      }],
    };
  }

  // Fallback to FTS5 search
  const sanitized = sanitizeFts5Query(args.message);

  if (sanitized) {
    const ftsResults = db.prepare(`
      SELECT e.id, e.project, e.fingerprint, e.message, e.solution, e.context,
             e.occurrence_count, e.first_seen_at, e.last_seen_at, e.resolved_at,
             rank
      FROM errors_fts fts
      JOIN errors e ON e.id = fts.rowid
      WHERE errors_fts MATCH ?
      ORDER BY rank
      LIMIT 5
    `).all(sanitized) as Record<string, unknown>[];

    if (ftsResults.length > 0) {
      const results = ftsResults.map((row, i) => {
        return [
          `--- Match ${i + 1} (FTS) ---`,
          `ID: ${row.id}`,
          `Project: ${row.project}`,
          `Message: ${row.message}`,
          `Solution: ${row.solution || '(no solution recorded)'}`,
          `Occurrences: ${row.occurrence_count}`,
          `Rank: ${row.rank}`,
        ].join('\n');
      });

      return {
        content: [{
          type: 'text',
          text: `Found ${ftsResults.length} similar error(s) via full-text search:\n\n${results.join('\n\n')}`,
        }],
      };
    }
  }

  return {
    content: [{
      type: 'text',
      text: `No matching error found.\n\nFingerprint searched: ${fingerprint}\nMessage: ${args.message}\n\nTo store a solution for this error, call igris_error_lookup again with the "solution" parameter.`,
    }],
  };
}

// ---------------------------------------------------------------------------
// Error Semantic Search (FR-094)
// ---------------------------------------------------------------------------

/** Input shape for igris_error_similar */
interface ErrorSimilarInput {
  message: string;
  project?: string;
  limit?: number;
  include_cross_project?: boolean;
}

/** Input shape for error backfill */
interface ErrorBackfillInput {
  batch_size?: number;
  project?: string;
}

/**
 * Find semantically similar errors using hybrid BM25 + vector search.
 *
 * Falls back to BM25-only when sqlite-vec is unavailable.
 *
 * @param args - Search parameters
 * @returns MCP-formatted response with similar errors
 */
async function handleErrorSimilar(args: ErrorSimilarInput): Promise<{ content: { type: string; text: string }[] }> {
  if (!args.message || args.message.length > MAX_CONTENT_LENGTH) {
    return { content: [{ type: 'text', text: `Validation error: message must be 1-${MAX_CONTENT_LENGTH} characters (1 MB max).` }] };
  }

  const db = getDb();
  const limit = args.limit ?? 10;
  const includeCrossProject = args.include_cross_project !== false;

  // --- 1. BM25 search via FTS5 ---
  const sanitized = sanitizeFts5Query(args.message);
  let bm25Rows: { id: number; [key: string]: unknown }[] = [];

  if (sanitized) {
    let bm25Sql = `
      SELECT e.id, e.project, e.fingerprint, e.message, e.solution, e.context,
             e.occurrence_count, e.first_seen_at, e.last_seen_at, e.resolved_at,
             rank
      FROM errors_fts fts
      JOIN errors e ON e.id = fts.rowid
      WHERE errors_fts MATCH ?
    `;
    const bm25Params: (string | number)[] = [sanitized];

    if (args.project && !includeCrossProject) {
      bm25Sql += ' AND e.project = ?';
      bm25Params.push(args.project);
    }

    bm25Sql += ' ORDER BY rank LIMIT ?';
    bm25Params.push(limit * 2);

    try {
      bm25Rows = db.prepare(bm25Sql).all(...bm25Params) as { id: number; [key: string]: unknown }[];
    } catch {
      bm25Rows = [];
    }
  }

  // --- 2. Vector search (with graceful fallback) ---
  let vecResults: { rowid: number; distance: number }[] = [];
  let vectorAvailable = false;

  try {
    if (isVectorSearchAvailable(db)) {
      const queryEmbedding = await generateEmbedding(args.message);
      vecResults = vectorSearchFrom(db, 'errors_vec', queryEmbedding, limit * 2);
      vectorAvailable = true;

      // Filter by project if needed
      if (args.project && !includeCrossProject && vecResults.length > 0) {
        const ids = vecResults.map(r => r.rowid);
        const placeholders = ids.map(() => '?').join(',');
        const projectRows = db.prepare(
          `SELECT id FROM errors WHERE id IN (${placeholders}) AND project = ?`,
        ).all(...ids, args.project) as { id: number }[];
        const projectIdSet = new Set(projectRows.map(r => r.id));
        vecResults = vecResults.filter(r => projectIdSet.has(r.rowid));
      }
    }
  } catch (err) {
    console.error('[errors] Vector search failed, using BM25 only:', err);
  }

  // --- 3. No results ---
  if (bm25Rows.length === 0 && vecResults.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No similar errors found for: "${args.message.substring(0, 100)}..."`,
      }],
    };
  }

  // --- 4. Merge results ---
  let finalIds: number[];
  let searchSource: string;

  if (vectorAvailable && vecResults.length > 0 && bm25Rows.length > 0) {
    const rrfEntries = computeRRF(bm25Rows, vecResults);
    finalIds = rrfEntries.slice(0, limit).map(e => e.id);
    searchSource = 'hybrid';
  } else if (bm25Rows.length > 0) {
    finalIds = bm25Rows.slice(0, limit).map(r => r.id);
    searchSource = 'bm25-only';
  } else {
    finalIds = vecResults.slice(0, limit).map(r => r.rowid);
    searchSource = 'vector-only';
  }

  // --- 5. Fetch full records ---
  const placeholders = finalIds.map(() => '?').join(',');
  const fullRows = db.prepare(`
    SELECT id, project, fingerprint, message, solution, context,
           occurrence_count, first_seen_at, last_seen_at, resolved_at
    FROM errors WHERE id IN (${placeholders})
  `).all(...finalIds) as Record<string, unknown>[];

  // Maintain RRF order
  const rowMap = new Map<number, Record<string, unknown>>();
  for (const row of fullRows) {
    rowMap.set(row.id as number, row);
  }

  const results = finalIds
    .map((id, i) => {
      const row = rowMap.get(id);
      if (!row) return null;
      return [
        `--- Match ${i + 1} (${searchSource}) ---`,
        `ID: ${row.id}`,
        `Project: ${row.project}`,
        `Fingerprint: ${row.fingerprint}`,
        `Message: ${row.message}`,
        `Solution: ${row.solution || '(no solution recorded)'}`,
        `Occurrences: ${row.occurrence_count}`,
        `First Seen: ${row.first_seen_at}`,
        `Last Seen: ${row.last_seen_at}`,
        `Resolved: ${row.resolved_at || 'No'}`,
      ].join('\n');
    })
    .filter(Boolean);

  return {
    content: [{
      type: 'text',
      text: `Found ${results.length} similar error(s) (${searchSource}):\n\n${results.join('\n\n')}`,
    }],
  };
}

/**
 * Batch-embed existing errors that lack embeddings.
 *
 * Processes errors where embedding IS NULL and solution is not empty,
 * generating embeddings from message + solution.
 *
 * @param args - Optional batch_size and project filter
 * @returns MCP-formatted response with processing summary
 */
async function handleErrorBackfillEmbeddings(args: ErrorBackfillInput): Promise<{ content: { type: string; text: string }[] }> {
  const db = getDb();
  const batchSize = args.batch_size ?? 50;

  if (!isVectorSearchAvailable(db)) {
    return {
      content: [{
        type: 'text',
        text: 'Backfill skipped: sqlite-vec extension is not available. Vector search is disabled.',
      }],
    };
  }

  let sql = "SELECT id, message, solution FROM errors WHERE embedding IS NULL AND solution IS NOT NULL AND solution != ''";
  const params: unknown[] = [];
  if (args.project) {
    sql += ' AND project = ?';
    params.push(args.project);
  }
  sql += ' ORDER BY id LIMIT ?';

  const errors = db.prepare(sql).all(...params, batchSize) as { id: number; message: string; solution: string }[];

  if (errors.length === 0) {
    let countSql = "SELECT COUNT(*) as total FROM errors WHERE solution IS NOT NULL AND solution != ''";
    const countParams: unknown[] = [];
    if (args.project) {
      countSql += ' AND project = ?';
      countParams.push(args.project);
    }
    const countRow = db.prepare(countSql).get(...countParams) as { total: number };

    return {
      content: [{
        type: 'text',
        text: `Backfill complete -- all ${countRow.total} errors with solutions already have embeddings.`,
      }],
    };
  }

  const startTime = Date.now();

  const { succeeded: processed, failed } = await processInBatches(
    errors,
    async (error) => {
      const embedding = await generateEmbedding(`${error.message} ${error.solution}`);
      db.prepare('UPDATE errors SET embedding = ?, embedding_model = ? WHERE id = ?')
        .run(embeddingToBuffer(embedding), EMBEDDING_MODEL, error.id);
      insertEmbeddingInto(db, 'errors_vec', error.id, embedding);
    },
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Check remaining
  let remainingSql = "SELECT COUNT(*) as remaining FROM errors WHERE embedding IS NULL AND solution IS NOT NULL AND solution != ''";
  const remainingParams: unknown[] = [];
  if (args.project) {
    remainingSql += ' AND project = ?';
    remainingParams.push(args.project);
  }
  const remainingRow = db.prepare(remainingSql).get(...remainingParams) as { remaining: number };

  return {
    content: [{
      type: 'text',
      text: `Backfill batch complete.\n\nProcessed: ${processed}\nFailed: ${failed}\nRemaining: ${remainingRow.remaining}\nTime: ${elapsed}s\n\n${remainingRow.remaining > 0 ? 'Run again to process more.' : 'All errors with solutions now have embeddings.'}`,
    }],
  };
}

// ---------------------------------------------------------------------------
// igris_error_dashboard (TD-171 M3)
// ---------------------------------------------------------------------------

/** Input shape for igris_error_dashboard */
interface ErrorDashboardInput {
  project?: string;
  days?: number;
  summary_only?: boolean;
}

/**
 * Aggregate dashboard over the `errors` table.
 *
 * Mirrors the canonical TD-171 `_dashboard` shape established by M1's
 * `handleMemoryDashboard` and M2's `handleGraphDashboard`:
 *
 *   {
 *     totals: { total, with_solution, without_solution },
 *     recent: { last_n_days: 30, new_errors: N },
 *     samples: {                                 // omitted when summary_only
 *       top_recurring: [{ fingerprint, message, project, hit_count, last_seen }, ...],
 *       by_project: { slug: count, ... },
 *     },
 *     project?: 'foo',                           // echoed when filter set
 *   }
 *
 * Filter semantics:
 *   - `project`: scopes totals + recent + samples to one project.
 *   - `days`: window for `recent.new_errors`. Default 30.
 *   - `summary_only`: omits `samples` (counts still computed).
 *
 * Per L-152, scope is strictly the errors channel — no perception or
 * memory aggregations leak in.
 */
function handleErrorDashboard(args: ErrorDashboardInput): { content: { type: string; text: string }[] } {
  const days = args.days !== undefined ? Number(args.days) : 30;
  if (!Number.isFinite(days) || days < 0) {
    return { content: [{ type: 'text', text: 'Error: days must be a non-negative number' }] };
  }
  const summaryOnly = args.summary_only === true;
  const projectFilter =
    typeof args.project === 'string' && args.project.length > 0 ? args.project : null;

  const db = getDb();

  const projectWhere = projectFilter ? 'WHERE project = ?' : '';
  const projectParams: string[] = projectFilter ? [projectFilter] : [];

  // --- totals.total ---
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM errors ${projectWhere}`)
    .get(...projectParams) as { n: number };

  // --- totals.with_solution / without_solution ---
  const withSolSql = projectFilter
    ? `SELECT COUNT(*) AS n FROM errors WHERE project = ? AND solution IS NOT NULL AND solution <> ''`
    : `SELECT COUNT(*) AS n FROM errors WHERE solution IS NOT NULL AND solution <> ''`;
  const withSolRow = db.prepare(withSolSql).get(...projectParams) as { n: number };
  const withoutSolution = totalRow.n - withSolRow.n;

  // --- recent.new_errors (last `days` window, by first_seen_at) ---
  const recentSql = projectFilter
    ? `SELECT COUNT(*) AS n FROM errors
       WHERE project = ? AND first_seen_at >= datetime('now', ?)`
    : `SELECT COUNT(*) AS n FROM errors WHERE first_seen_at >= datetime('now', ?)`;
  const recentParams: (string | number)[] = projectFilter
    ? [projectFilter, `-${days} days`]
    : [`-${days} days`];
  const recentRow = db.prepare(recentSql).get(...recentParams) as { n: number };

  // --- samples (omitted when summary_only) ---
  let samples: Record<string, unknown> | undefined;
  if (!summaryOnly) {
    // top_recurring: highest occurrence_count rows. Limit 10.
    // Without a solution gets the spotlight — those are mender targets —
    // but we surface ALL rows ordered by occurrence_count so the operator
    // sees the full top-N picture.
    const topSql = projectFilter
      ? `SELECT id, fingerprint, project, message, occurrence_count, last_seen_at,
                CASE WHEN solution IS NULL OR solution = '' THEN 0 ELSE 1 END AS has_solution
         FROM errors
         WHERE project = ?
         ORDER BY occurrence_count DESC, last_seen_at DESC
         LIMIT 10`
      : `SELECT id, fingerprint, project, message, occurrence_count, last_seen_at,
                CASE WHEN solution IS NULL OR solution = '' THEN 0 ELSE 1 END AS has_solution
         FROM errors
         ORDER BY occurrence_count DESC, last_seen_at DESC
         LIMIT 10`;
    const topRows = db.prepare(topSql).all(...projectParams) as {
      id: number;
      fingerprint: string;
      project: string;
      message: string;
      occurrence_count: number;
      last_seen_at: string;
      has_solution: number;
    }[];

    // by_project: error counts grouped by project slug. When filter is
    // set this collapses to a single key; we include it anyway for
    // shape consistency.
    const byProjectSql = projectFilter
      ? `SELECT project, COUNT(*) AS n FROM errors WHERE project = ? GROUP BY project`
      : `SELECT project, COUNT(*) AS n FROM errors GROUP BY project ORDER BY n DESC`;
    const byProjectRows = db.prepare(byProjectSql).all(...projectParams) as {
      project: string;
      n: number;
    }[];
    const byProject: Record<string, number> = {};
    for (const r of byProjectRows) byProject[r.project] = r.n;

    samples = { top_recurring: topRows, by_project: byProject };
  }

  const result: Record<string, unknown> = {
    totals: {
      total: totalRow.n,
      with_solution: withSolRow.n,
      without_solution: withoutSolution,
    },
    recent: {
      last_n_days: days,
      new_errors: recentRow.n,
    },
  };
  if (!summaryOnly) {
    result.samples = samples;
  }
  if (projectFilter) {
    result.project = projectFilter;
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

export {
  handleErrorLookup,
  handleErrorSimilar,
  handleErrorBackfillEmbeddings,
  handleErrorDashboard,
};
export type {
  ErrorLookupInput,
  ErrorSimilarInput,
  ErrorBackfillInput,
  ErrorDashboardInput,
};
