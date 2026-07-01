/**
 * Igris Brain — Learning Embedding Core (FR-219a)
 *
 * The ONE place that derives a learning's stored embedding fingerprint and
 * back-fills embeddings for NULL-embedding rows in lockstep across both
 * stores (`learnings.embedding` BLOB + `learnings_vec` vec0 rowid).
 *
 * Why this module exists:
 *   The manual `igris_memory_store` channel historically embedded the RAW
 *   `${title} ${content}`, while the perception channel and TD-286 canonicalize
 *   the NORMALIZED fingerprint `${normalizeForDedup(title)} ${normalizeForDedup(
 *   content)}`. Embedding NULL rows as RAW would create a raw island inside a
 *   normalized store — inconsistent recall ranking depending on a row's origin
 *   channel. FR-219 resolves this by ALWAYS embedding the normalized
 *   fingerprint (matches the dedup query path `dedup.ts:245`, the perception
 *   write path `perception.ts:265`, and the TD-286 canonical store geometry).
 *
 * Consumers (see MAINTAINING.md — normalized learning-embedding fingerprint row):
 *   - `handleMemoryBackfillEmbeddings` (`tools/memory.ts`) — delegates here.
 *   - `scripts/fr219_embed_null_learnings.ts` — the one-time maintenance script.
 *   - (FR-219b, future) the brain post-merge hook in `tools/sync.ts`.
 *
 * Imports SHIPPED helpers only — no re-implementation of embed / normalize /
 * vec-write (learning #930): `generateEmbedding`, `normalizeForDedup`,
 * `insertEmbedding`.
 *
 * @module utils/learning-embed
 */
import type Database from 'better-sqlite3';
import {
  generateEmbedding,
  embeddingToBuffer,
  EMBEDDING_MODEL,
} from './embeddings.js';
import {
  isVectorSearchAvailable,
  insertEmbedding,
  deleteEmbedding,
} from './vector-search.js';
import { normalizeForDedup } from '../engine/components/perception/dedup.js';

/** An embedder — production default is the shipped `generateEmbedding`. */
export type Embedder = (text: string) => Promise<Float32Array>;

/**
 * The TD-087 normalized learning-embedding fingerprint — the ONE canonical
 * derivation. Byte-for-byte the perception write path (`perception.ts:265`)
 * and the dedup query path (`dedup.ts:245`). Any new learning embedding write
 * or query path MUST embed this fingerprint (or document a reconciliation).
 *
 * Imports `normalizeForDedup` from `dedup.ts` — never re-implements the
 * normalization (learning #930).
 */
export function normalizedFingerprint(title: string, content: string): string {
  return `${normalizeForDedup(title)} ${normalizeForDedup(content)}`.trim();
}

export interface EmbedNullOptions {
  /** true = report only, write nothing (#208 default at the callers). */
  dryRun: boolean;
  /** SELECT LIMIT — cap rows processed per call (the tool's batch). undefined = all. */
  limit?: number;
  /** optional project filter (mirrors the backfill tool's `project` arg). */
  project?: string;
  /** progress-log granularity (rows). Default 50. */
  batchSize?: number;
  /** log sink (default console.log). */
  log?: (msg: string) => void;
}

export interface EmbedNullDeps {
  /** injectable embedder seam for tests; production uses generateEmbedding. */
  embed?: Embedder;
}

export interface EmbedNullSummary {
  /** NULL-embedding rows selected (the would-embed count; also true on dry-run). */
  scanned: number;
  /** rows written to BOTH stores in lockstep (0 on dry-run). */
  embedded: number;
  /** scanned rows not embedded for a non-failure reason (dry-run → all scanned). */
  skipped: number;
  /** per-row errors (embed or write threw); logged and skipped, run continues. */
  failures: number;
}

/**
 * Row selected for backfill — NULL embedding by construction of the query.
 */
interface NullRow {
  id: number;
  title: string;
  content: string;
}

const DEFAULT_BATCH = 50;

/**
 * Embed every `WHERE embedding IS NULL` learning using the normalized
 * fingerprint and write `learnings.embedding` + `embedding_model` AND
 * `learnings_vec` per-row in a single synchronous `db.transaction` (the async
 * embed happens BEFORE the txn — better-sqlite3 transactions must be sync).
 *
 * Lockstep: the UPDATE and the vec write commit together, so there is never a
 * partial state where the BLOB moved but `learnings_vec` did not. One
 * transaction PER ROW (no cross-row batch) keeps a run interrupt-safe and
 * resumable — re-running skips already-embedded rows (idempotent).
 *
 * Fresh NULL rows are first inserts, but the vec write is DELETE-then-INSERT
 * DEFENSIVELY: sqlite-vec v0.1.7's `INSERT OR REPLACE` (what `insertEmbedding`
 * runs) throws `UNIQUE constraint failed` on an EXISTING `learnings_vec` rowid
 * (#935), so a partial prior run that wrote the vec rowid but not the BLOB
 * would otherwise crash on re-run. `deleteEmbedding` is a no-op on a missing
 * rowid, so this is safe for both the fresh and the partial-prior case.
 * BigInt rowid binding stays inside the shipped wrappers (#212).
 *
 * Degrades (does NOT hard-fail) if sqlite-vec is unavailable: returns
 * all-zero counts and logs, so a tool caller can fall back to FTS. The
 * mutating SCRIPT wrapper adds its own #213 HARD-FAIL before calling here.
 *
 * Pure of process/argv/env — DB, options and embedder are injected so this is
 * unit-testable with a deterministic fake embedder.
 */
export async function embedNullLearnings(
  db: Database.Database,
  options: EmbedNullOptions,
  deps: EmbedNullDeps = {},
): Promise<EmbedNullSummary> {
  const embed = deps.embed ?? generateEmbedding;
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const log = options.log ?? ((m: string) => console.log(m));

  const summary: EmbedNullSummary = {
    scanned: 0,
    embedded: 0,
    skipped: 0,
    failures: 0,
  };

  // Degrade-not-crash if vec is down: writing BLOBs while learnings_vec silently
  // no-ops would break the lockstep. The mutating script wrapper hard-fails
  // (#213) before ever reaching here; a tool caller degrades to FTS.
  if (!isVectorSearchAvailable(db)) {
    log('[fr219] sqlite-vec unavailable — skipping embed backfill (degrade to FTS).');
    return summary;
  }

  let sql = 'SELECT id, title, content FROM learnings WHERE embedding IS NULL';
  const params: unknown[] = [];
  if (options.project) {
    sql += ' AND project = ?';
    params.push(options.project);
  }
  sql += ' ORDER BY id';
  if (options.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params) as NullRow[];
  summary.scanned = rows.length;

  // Dry-run: report the would-embed count and write nothing. Short-circuit
  // BEFORE any embedding — the count is just the NULL-row cardinality, so a
  // dry-run must not pay the (slow, model-loading) per-row inference cost.
  if (options.dryRun) {
    summary.skipped = summary.scanned;
    log(`[fr219] dry-run: ${summary.scanned} NULL-embedding row(s) would be embedded (no writes).`);
    return summary;
  }

  // Per-row atomic dual-write. DELETE-then-INSERT defensively (#935); both are
  // shipped wrappers, BigInt handled inside (#212), and both run in the same
  // per-row transaction so the vec write is atomic with the BLOB UPDATE.
  const updateStmt = db.prepare(
    'UPDATE learnings SET embedding = ?, embedding_model = ? WHERE id = ?',
  );
  const writeRow = db.transaction((id: number, embedding: Float32Array) => {
    updateStmt.run(embeddingToBuffer(embedding), EMBEDDING_MODEL, id);
    deleteEmbedding(db, id);
    insertEmbedding(db, id, embedding);
  });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      // Async embed BEFORE the sync transaction (better-sqlite3 txns are sync).
      const embedding = await embed(normalizedFingerprint(row.title, row.content));
      writeRow(row.id, embedding);
      summary.embedded++;
    } catch (err) {
      summary.failures++;
      log(`[fr219] row ${row.id} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }

    if ((i + 1) % batchSize === 0 || i === rows.length - 1) {
      log(
        `progress: ${i + 1}/${rows.length}`
        + `  (embedded=${summary.embedded} skipped=${summary.skipped}`
        + ` failures=${summary.failures})`,
      );
    }
  }

  return summary;
}
