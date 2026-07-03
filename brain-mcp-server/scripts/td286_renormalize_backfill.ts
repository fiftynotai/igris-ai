/**
 * TD-286 — Renormalize backfill (COMMITTED MAINTENANCE SCRIPT — MUTATES THE
 * LIVE knowledge.db under `--apply`).
 *
 * Purpose: realign legacy RAW-stored learning embeddings into the TD-087
 * normalized space so the 0.80 dedup threshold (F1-tuned for that space)
 * measures like-against-like. The manual `igris_memory_store` channel embeds
 * RAW `${title} ${content}` (memory.ts:283) regardless of created_at, while the
 * perception channel embeds `${normalizeForDedup(title)} ${normalizeForDedup(
 * content)}` (cognition/extractors/perception.ts:265). The artifact is
 * therefore CHANNEL-based, not date-based — see TD-285.
 *
 * What it does per RAW-stored row: re-embeds the normalized fingerprint
 * (byte-for-byte the perception path) and rewrites BOTH stores in a single
 * per-row transaction — `learnings.embedding` (BLOB + `embedding_model`) AND
 * `learnings_vec` — so the two never diverge (lockstep).
 *
 * Detection: reuses the TD-285 `storeIs` classifier (svr = cosine(stored, raw
 * re-embed), svn = cosine(stored, norm re-embed); RAW when svr > svn). `norm`
 * rows are skipped — that IS the idempotency mechanism: a re-run reclassifies
 * an already-rewritten row as `norm` and skips it.
 *
 * Safety contract:
 *   - `--dry-run` is the DEFAULT (#208): reports counts, writes nothing.
 *     `--apply` is the explicit, mutating opt-in.
 *   - HARD-FAILS before any write if sqlite-vec is not actually available on
 *     the connection (#213): writing BLOBs while `learnings_vec` silently
 *     no-ops would break the lockstep. Do not trust a clean exit alone.
 *   - Calls the SHIPPED `insertEmbedding` wrapper for the vec write — the
 *     wrapper handles the sqlite-vec v0.1.7 BigInt rowid binding internally
 *     (#212). This script never hand-rolls the vec0 insert.
 *   - Interrupt-safe / resumable: each row commits in its OWN transaction;
 *     there is no cross-row batch transaction to roll back. Interrupting
 *     mid-run leaves rewritten rows classified `norm`, so a re-run skips them
 *     and continues with the remaining RAW rows. No checkpoint file needed.
 *
 * Sync note: `embedding` / `embedding_model` are NOT in the `learnings`
 * SYNC_TABLES column list, and `learnings_au` does not bump `updated_at`, so
 * rewriting the embedding produces no replicated delta / no LWW timestamp
 * change → the backfill does not generate a sync push (see TD-286 plan).
 *
 * Imports SHIPPED helpers only — no re-implementation of embed / normalize /
 * vec-write (learning #930).
 *
 * Usage:
 *   cd brain-mcp-server
 *   npx tsx scripts/td286_renormalize_backfill.ts              # DRY-RUN (default)
 *   npx tsx scripts/td286_renormalize_backfill.ts --apply      # MUTATES live DB
 *   [--batch N]  (default 50)
 *   [IGRIS_DB_PATH=/path/to.db]  (default ~/.igris/memory/knowledge.db)
 *
 * @module scripts/td286_renormalize_backfill
 */
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generateEmbedding,
  embeddingToBuffer,
  bufferToEmbedding,
  disposeEmbeddingPipeline,
  EMBEDDING_MODEL,
} from '../src/utils/embeddings.js';
import { normalizeForDedup } from '../src/engine/components/perception/dedup.js';
import { insertEmbedding, deleteEmbedding, isVectorSearchAvailable } from '../src/utils/vector-search.js';

const DEFAULT_BATCH = 50;

/** An embedder — production default is the shipped `generateEmbedding`. */
export type Embedder = (text: string) => Promise<Float32Array>;

/** A learnings row carrying the stored vector geometry to classify. */
export interface BackfillRow {
  id: number;
  title: string;
  content: string;
  embedding: Buffer;
  embedding_model: string;
  review_status: string;
}

export interface BackfillOptions {
  /** true = mutate the DB; false (default) = dry-run, report only. */
  apply: boolean;
  /** progress-log granularity (rows). Default 50. */
  batchSize?: number;
  /** log sink (default console.log). */
  log?: (msg: string) => void;
}

export interface BackfillDeps {
  /** injectable embedder seam for tests; production uses generateEmbedding. */
  embed?: Embedder;
}

export interface BackfillSummary {
  scanned: number;
  rawDetected: number;
  rawApproved: number;
  rawPending: number;
  rewritten: number;
  skippedNorm: number;
  failures: number;
  modelMismatches: number;
}

/** Cosine similarity of two equal-length vectors (L-67 brute-force pattern). */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The TD-087 normalized fingerprint — byte-for-byte the perception path. */
function normFingerprint(title: string, content: string): string {
  return `${normalizeForDedup(title)} ${normalizeForDedup(content)}`.trim();
}

/**
 * Classify a stored row as RAW- or norm-stored (TD-285 `storeIs`) and return
 * the normalized re-embed so the apply path can reuse it (avoids a 3rd embed).
 */
async function classify(
  row: BackfillRow,
  embed: Embedder,
): Promise<{ isRaw: boolean; normEmbedding: Float32Array }> {
  const stored = bufferToEmbedding(row.embedding);
  const rawEmbedding = await embed(`${row.title} ${row.content}`);
  const normEmbedding = await embed(normFingerprint(row.title, row.content));
  const svr = cosine(stored, rawEmbedding);
  const svn = cosine(stored, normEmbedding);
  return { isRaw: svr > svn, normEmbedding };
}

/**
 * Detect RAW-stored rows and (under `--apply`) rewrite them into the
 * normalized space in lockstep. Pure of process/argv/env — the DB, options,
 * and embedder are all injected so this is unit-testable.
 */
export async function runBackfill(
  db: Database.Database,
  options: BackfillOptions,
  deps: BackfillDeps = {},
): Promise<BackfillSummary> {
  const embed = deps.embed ?? generateEmbedding;
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const log = options.log ?? ((m: string) => console.log(m));

  // #213 guard — refuse to proceed if the vec path is not genuinely alive.
  // Writing BLOBs while learnings_vec silently no-ops would break the lockstep.
  if (!isVectorSearchAvailable(db)) {
    throw new Error(
      '[td286] sqlite-vec is NOT available on this connection — refusing to run. '
      + 'Writing embedding BLOBs while learnings_vec no-ops would break the '
      + 'learnings.embedding <-> learnings_vec lockstep (#213). Load the extension '
      + 'before running the backfill.',
    );
  }

  const rows = db.prepare(
    `SELECT id, title, content, embedding, embedding_model, review_status
       FROM learnings
      WHERE embedding IS NOT NULL
      ORDER BY id`,
  ).all() as BackfillRow[];

  const summary: BackfillSummary = {
    scanned: rows.length,
    rawDetected: 0,
    rawApproved: 0,
    rawPending: 0,
    rewritten: 0,
    skippedNorm: 0,
    failures: 0,
    modelMismatches: 0,
  };

  // Per-row atomic dual-write: the UPDATE and the vec insert commit together,
  // so there is never a partial state where the BLOB moved but learnings_vec
  // did not (lockstep). One transaction PER ROW — no cross-row batch — keeps
  // the run interrupt-safe and resumable.
  const updateStmt = db.prepare(
    'UPDATE learnings SET embedding = ?, embedding_model = ? WHERE id = ?',
  );
  const writeRow = db.transaction((id: number, embedding: Float32Array) => {
    updateStmt.run(embeddingToBuffer(embedding), EMBEDDING_MODEL, id);
    // vec0 rewrite is DELETE-then-INSERT, both shipped wrappers. The
    // perception path calls insertEmbedding (INSERT OR REPLACE) on FRESH
    // rowids only; on an EXISTING learnings_vec rowid, sqlite-vec v0.1.7's
    // INSERT OR REPLACE throws "UNIQUE constraint failed on learnings_vec
    // primary key" (verified at build time — it is NOT an idempotent upsert
    // for pre-existing rowids). deleteEmbedding first is the safe rewrite and
    // keeps BigInt handling inside the shipped wrappers (#212). Both run in
    // this same per-row transaction, so the delete+insert is atomic with the
    // BLOB UPDATE (lockstep preserved).
    deleteEmbedding(db, id);
    insertEmbedding(db, id, embedding);
  });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const { isRaw, normEmbedding } = await classify(row, embed);
      if (!isRaw) {
        summary.skippedNorm++;
      } else {
        summary.rawDetected++;
        if (row.review_status === 'approved') summary.rawApproved++;
        else summary.rawPending++;
        if (row.embedding_model !== EMBEDDING_MODEL) summary.modelMismatches++;
        if (options.apply) {
          writeRow(row.id, normEmbedding);
          summary.rewritten++;
        }
      }
    } catch (err) {
      summary.failures++;
      log(`[td286] row ${row.id} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }

    if ((i + 1) % batchSize === 0 || i === rows.length - 1) {
      log(
        `progress: ${i + 1}/${rows.length}`
        + `  (raw=${summary.rawDetected} rewritten=${summary.rewritten}`
        + ` skipped_norm=${summary.skippedNorm} failures=${summary.failures})`,
      );
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const batchArg = process.argv.indexOf('--batch');
  const batchSize = batchArg > -1 ? parseInt(process.argv[batchArg + 1], 10) : DEFAULT_BATCH;

  const dbPath = process.env.IGRIS_DB_PATH || path.join(os.homedir(), '.igris/memory/knowledge.db');
  const db = new Database(dbPath); // read-write (the diagnostic used { readonly: true } — dropped)

  // Load sqlite-vec — same mechanism as db.ts::loadSqliteVec / td285:94-97.
  const requireCjs = createRequire(import.meta.url);
  try {
    (requireCjs('sqlite-vec') as { load: (d: Database.Database) => void }).load(db);
  } catch (err) {
    console.error('[td286] FATAL: could not load sqlite-vec:', err);
    db.close();
    process.exit(1);
  }

  console.log('# TD-286 renormalize backfill');
  console.log(`db=${dbPath}`);
  console.log(`mode=${apply ? 'APPLY (mutating live DB)' : 'DRY-RUN (default — no writes)'}`);
  console.log(`EMBEDDING_MODEL=${EMBEDDING_MODEL}  batch=${batchSize}`);
  console.log('');

  try {
    const summary = await runBackfill(db, { apply, batchSize });
    console.log('');
    console.log('## Summary');
    console.log(`scanned          : ${summary.scanned}`);
    console.log(
      `RAW detected     : ${summary.rawDetected}`
      + `  (approved=${summary.rawApproved}, pending_review=${summary.rawPending})`,
    );
    console.log(`rewritten        : ${summary.rewritten}${apply ? '' : '  (dry-run — 0 by design)'}`);
    console.log(`skipped (norm)   : ${summary.skippedNorm}`);
    console.log(`model mismatches : ${summary.modelMismatches}  (rewritten rows normalize embedding_model)`);
    console.log(`failures         : ${summary.failures}`);
    if (!apply) {
      console.log('');
      console.log('DRY-RUN: no rows were modified. Re-run with --apply to mutate the live DB.');
    }
  } catch (err) {
    console.error('[td286] FATAL:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    db.close();
    await disposeEmbeddingPipeline();
  }
}

// Run main() only when executed directly — importing (e.g. the test) must not
// open the live DB.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[td286] FATAL:', err);
    process.exit(1);
  });
}
