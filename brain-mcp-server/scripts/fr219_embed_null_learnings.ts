/**
 * FR-219a — Embed NULL-embedding learnings (COMMITTED MAINTENANCE SCRIPT —
 * MUTATES the live knowledge.db under `--apply`).
 *
 * Purpose: a one-time backfill that generates all-MiniLM-L6-v2 embeddings for
 * every `learnings` row where `embedding IS NULL` — the rows a receiver got via
 * sync (embeddings are deliberately NOT a sync column, so they arrive NULL and
 * must be derived on the receiver). Running this on the VPS closes the observed
 * NULL-embedding gap (the machine that receives via `POST /sync/push` and had
 * hundreds of learnings but only a handful embedded).
 *
 * What it does per NULL row: embeds the TD-087 NORMALIZED fingerprint
 * (`${normalizeForDedup(title)} ${normalizeForDedup(content)}`, via the shared
 * `embedNullLearnings` core) and writes `learnings.embedding` (BLOB +
 * `embedding_model`) AND `learnings_vec` in a single per-row transaction
 * (lockstep). NORMALIZED — not RAW — so the backfilled rows land in the same
 * geometry as the perception write path and the TD-286-canonicalized store,
 * never a raw island (see FR-219 plan §2).
 *
 * Safety contract:
 *   - `--dry-run` is the DEFAULT (#208): reports the NULL count, writes nothing.
 *     `--apply` is the explicit, mutating opt-in.
 *   - HARD-FAILS before any write if sqlite-vec is not actually available on
 *     the connection (#213): writing BLOBs while `learnings_vec` silently
 *     no-ops would break the lockstep. Do not trust a clean exit alone. (The
 *     shared core degrades-not-crashes for tool callers; this mutating script
 *     adds the hard-fail on top.)
 *   - Calls the SHIPPED wrappers for the vec write — BigInt rowid binding
 *     (#212) and delete-then-insert (#935) live inside the core; this script
 *     never hand-rolls the vec0 insert.
 *   - Idempotent / resumable: each row commits in its OWN transaction and the
 *     select is `WHERE embedding IS NULL`, so a re-run embeds only what remains.
 *     A second `--apply` after a clean run embeds 0.
 *
 * Sync note: `embedding` / `embedding_model` are NOT in the `learnings`
 * SYNC_TABLES column list, so backfilling produces no replicated delta / no
 * sync push (same as TD-286).
 *
 * Imports SHIPPED helpers only — no re-implementation of embed / normalize /
 * vec-write (learning #930).
 *
 * Usage:
 *   cd brain-mcp-server
 *   npx tsx scripts/fr219_embed_null_learnings.ts              # DRY-RUN (default)
 *   npx tsx scripts/fr219_embed_null_learnings.ts --apply      # MUTATES live DB
 *   [--batch N]  (default 50 — progress-log granularity)
 *   [IGRIS_DB_PATH=/path/to.db]  (default ~/.igris/memory/knowledge.db)
 *
 * @module scripts/fr219_embed_null_learnings
 */
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  disposeEmbeddingPipeline,
  EMBEDDING_MODEL,
} from '../src/utils/embeddings.js';
import { isVectorSearchAvailable } from '../src/utils/vector-search.js';
import {
  embedNullLearnings,
  type EmbedNullDeps,
  type EmbedNullSummary,
} from '../src/utils/learning-embed.js';

const DEFAULT_BATCH = 50;

/** Count learnings whose embedding is still NULL (the backfill target set). */
function nullCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM learnings WHERE embedding IS NULL')
    .get() as { n: number }).n;
}

/**
 * Script-level runner: the #213 HARD-FAIL wrapper around the shared core.
 *
 * The shared `embedNullLearnings` DEGRADES (returns zero counts) when vec is
 * down so a tool caller can fall back to FTS. A MUTATING SCRIPT must not
 * degrade silently — writing BLOBs while `learnings_vec` no-ops would break the
 * lockstep — so this wrapper HARD-FAILS (#213) before any write. Exported so
 * the guard is unit-testable without invoking `main()`.
 */
export async function runFr219Backfill(
  db: Database.Database,
  options: { apply: boolean; batchSize?: number },
  deps: EmbedNullDeps = {},
): Promise<EmbedNullSummary> {
  if (!isVectorSearchAvailable(db)) {
    throw new Error(
      'sqlite-vec is NOT available on this connection — refusing to run. '
      + 'Writing embedding BLOBs while learnings_vec no-ops would break the '
      + 'learnings.embedding <-> learnings_vec lockstep (#213).',
    );
  }
  return embedNullLearnings(
    db,
    { dryRun: !options.apply, batchSize: options.batchSize },
    deps,
  );
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const batchArg = process.argv.indexOf('--batch');
  const batchSize = batchArg > -1 ? parseInt(process.argv[batchArg + 1], 10) : DEFAULT_BATCH;

  const dbPath = process.env.IGRIS_DB_PATH || path.join(os.homedir(), '.igris/memory/knowledge.db');
  const db = new Database(dbPath); // read-write

  // Load sqlite-vec — same mechanism as db.ts::loadSqliteVec / td286.
  const requireCjs = createRequire(import.meta.url);
  try {
    (requireCjs('sqlite-vec') as { load: (d: Database.Database) => void }).load(db);
  } catch (err) {
    console.error('[fr219] FATAL: could not load sqlite-vec:', err);
    db.close();
    process.exit(1);
  }

  console.log('# FR-219a embed NULL-embedding learnings');
  console.log(`db=${dbPath}`);
  console.log(`mode=${apply ? 'APPLY (mutating live DB)' : 'DRY-RUN (default — no writes)'}`);
  console.log(`EMBEDDING_MODEL=${EMBEDDING_MODEL}  batch=${batchSize}`);
  console.log('');

  try {
    const total = (db.prepare('SELECT COUNT(*) AS n FROM learnings').get() as { n: number }).n;
    const beforeNull = nullCount(db);
    const alreadyEmbedded = total - beforeNull;
    console.log(`learnings total  : ${total}`);
    console.log(`NULL-embedding   : ${beforeNull}  (already embedded: ${alreadyEmbedded})`);
    console.log('');

    // #213 hard-fail lives inside runFr219Backfill, BEFORE any write.
    const summary = await runFr219Backfill(db, { apply, batchSize });
    const afterNull = nullCount(db);

    console.log('');
    console.log('## Summary');
    console.log(`scanned (NULL)          : ${summary.scanned}`);
    console.log(`embedded                : ${summary.embedded}${apply ? '' : '  (dry-run — 0 by design)'}`);
    console.log(`skipped (already embed) : ${alreadyEmbedded}`);
    console.log(`failures                : ${summary.failures}`);
    console.log(`NULL-embedding after    : ${afterNull}`);
    if (!apply) {
      console.log('');
      console.log(`DRY-RUN: no rows were modified. ${summary.scanned} NULL-embedding row(s) WOULD be embedded.`);
      console.log('Re-run with --apply to mutate the live DB.');
    }
  } catch (err) {
    console.error('[fr219] FATAL:', err instanceof Error ? err.message : String(err));
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
    console.error('[fr219] FATAL:', err);
    process.exit(1);
  });
}
