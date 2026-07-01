/**
 * TD-285 — Dedup recall audit (THROWAWAY, READ-ONLY DIAGNOSTIC).
 *
 * Question: are the acid-test "residual duplicates" a PRE-NORMALIZATION
 * ARTIFACT (stored legacy vectors understate the similarity the live dedup
 * computes) or a LIVE RECALL GAP (reworded restatements genuinely fall below
 * the 0.80 threshold even under text-normalized current-model embeddings)?
 *
 * Method (see ~/.igris/projects/igris-ai/plans/TD-285-plan.md):
 *   The live dedup (`findNearestMatch`) has ASYMMETRIC geometry — it always
 *   normalizes the QUERY text before embedding, but the STORED side holds
 *   whatever geometry was written at persist time. Manual `igris_memory_store`
 *   embeds RAW `${title} ${content}` (memory.ts:283); the perception LLM
 *   channel embeds `normalizeForDedup(title)+normalizeForDedup(content)`
 *   (cognition/extractors/perception.ts:265). So the stored geometry of a
 *   MANUAL row is un-normalized regardless of created_at.
 *
 *   Path A (live-as-is):    normalized query emb  vs  STORED vector geometry.
 *   Path B (post-backfill):  normalized query emb  vs  FRESH normalized re-embed.
 *   Path B >> Path A  ⇒  ARTIFACT (stored-vector staleness).
 *   Residual stays <0.80 under Path B (post-TD-087, twin predates it) ⇒ LIVE GAP.
 *
 * The 16 hard-deleted residual rows are UNRECOVERABLE (reject = local hard
 * DELETE, no event_log entry; pending rows are never pushed to the remote
 * brain — the push SELECT filters review_status='approved' and the sync
 * columns carry no embedding/id). So this audit runs the Risk-1 fallback:
 *   (1) TWIN self-geometry — proves the stored vectors ARE un-normalized;
 *   (2) the 258 surviving pending rows (same LLM class as the residuals) as
 *       the residual proxy for Path A vs Path B catch counts.
 *
 * Read-only: opens the DB with { readonly: true }, never writes. Imports the
 * SHIPPED `normalizeForDedup` and `generateEmbedding` — no re-implementation
 * (learning #930).
 *
 * Usage:
 *   cd brain-mcp-server && npx tsx scripts/td285_dedup_recall_audit.ts
 *   [--pending-limit N]   (default: all 258)
 */
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bufferToEmbedding,
  generateEmbedding,
  disposeEmbeddingPipeline,
  EMBEDDING_MODEL,
} from '../src/utils/embeddings.js';
import { normalizeForDedup } from '../src/engine/components/perception/dedup.js';
import { isVectorSearchAvailable } from '../src/utils/vector-search.js';

const TD087_DATE = '2026-05-04';
const THRESHOLD = 0.8;

// Known residual→twin pairs from the acid test (pending→approved). The
// residual (left) is hard-deleted; the twin (right) survives locally.
const PAIRS: Array<[number, number]> = [
  [484, 480], [483, 479], [482, 478], [357, 356], [513, 504], [453, 451],
  [388, 399], [466, 447], [290, 288], [518, 517], [358, 329], [665, 657],
  [783, 169], [771, 767], [786, 800], [701, 711],
];

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function normFingerprint(title: string, content: string): string {
  return `${normalizeForDedup(title)} ${normalizeForDedup(content)}`.trim();
}

interface Learning {
  id: number;
  title: string;
  content: string;
  embedding: Buffer;
  embedding_model: string;
  created_at: string;
  source_extractor: string;
  review_status: string;
}

async function main() {
  const pendingLimitArg = process.argv.indexOf('--pending-limit');
  const pendingLimit = pendingLimitArg > -1 ? parseInt(process.argv[pendingLimitArg + 1], 10) : Infinity;

  const dbPath = process.env.IGRIS_DB_PATH || path.join(os.homedir(), '.igris/memory/knowledge.db');
  const db = new Database(dbPath, { readonly: true });

  // Load sqlite-vec (same mechanism as db.ts::loadSqliteVec) so the REAL
  // vectorSearch (Path A live path) is exercisable as a sanity cross-check.
  const requireCjs = createRequire(import.meta.url);
  try {
    (requireCjs('sqlite-vec') as { load: (d: Database.Database) => void }).load(db);
  } catch { /* fall through; brute-force Path A still works off the BLOB */ }
  const vecOk = isVectorSearchAvailable(db);

  console.log('# TD-285 dedup recall audit');
  console.log(`db=${dbPath}`);
  console.log(`current EMBEDDING_MODEL=${EMBEDDING_MODEL}  vec0_loaded=${vecOk}  threshold=${THRESHOLD}`);
  console.log('');

  // --- Load approved corpus (Path B re-embed target + Path A stored source) ---
  const approved = db.prepare(
    `SELECT id, title, content, embedding, embedding_model, created_at, source_extractor, review_status
       FROM learnings WHERE review_status='approved' AND embedding IS NOT NULL`,
  ).all() as Learning[];

  console.error(`[audit] embedding ${approved.length} approved rows (stored + fresh-normalized) ...`);
  const storedVec = new Map<number, Float32Array>();
  const normVec = new Map<number, Float32Array>();
  const byId = new Map<number, Learning>();
  for (let i = 0; i < approved.length; i++) {
    const r = approved[i];
    byId.set(r.id, r);
    storedVec.set(r.id, bufferToEmbedding(r.embedding));
    normVec.set(r.id, await generateEmbedding(normFingerprint(r.title, r.content)));
    if (i % 50 === 0) console.error(`  ${i}/${approved.length}`);
  }

  // =====================================================================
  // ANALYSIS 1 — TWIN self-geometry: what does the STORED vector hold?
  //   stored_vs_norm = cosine(stored, fresh normalized re-embed)
  //   stored_vs_raw  = cosine(stored, fresh RAW re-embed)
  // If stored_vs_raw ≈ 1.0 while stored_vs_norm < 1.0, the stored vector is
  // un-normalized geometry → the live (normalized) query is measured against
  // stale geometry → Path A understates. That IS the artifact mechanism.
  // =====================================================================
  console.log('## Analysis 1 — twin stored-vector geometry (proves stale/un-normalized store)');
  console.log('twin_id | extractor | created    | predates_TD087 | model_ok | stored_vs_norm | stored_vs_raw | store_is');
  const twinIds = PAIRS.map(([, t]) => t);
  let rawGeom = 0, normGeom = 0;
  for (const tid of twinIds) {
    const r = byId.get(tid);
    if (!r) { console.log(`${tid} | <MISSING approved row>`); continue; }
    const stored = storedVec.get(tid)!;
    const norm = normVec.get(tid)!;
    const raw = await generateEmbedding(`${r.title} ${r.content}`);
    const svn = cosine(stored, norm);
    const svr = cosine(stored, raw);
    const storeIs = svr > svn ? 'RAW' : 'norm';
    if (storeIs === 'RAW') rawGeom++; else normGeom++;
    const predates = r.created_at < TD087_DATE ? 'YES' : 'no';
    const modelOk = r.embedding_model === EMBEDDING_MODEL ? 'yes' : `NO(${r.embedding_model || 'empty'})`;
    console.log(
      `${String(tid).padStart(4)} | ${r.source_extractor.padEnd(9)} | ${r.created_at.slice(0, 10)} | ${predates.padEnd(14)} | ${modelOk.padEnd(6)} | ${svn.toFixed(4).padStart(14)} | ${svr.toFixed(4).padStart(13)} | ${storeIs}`,
    );
  }
  console.log(`\n[twin store geometry] RAW-stored=${rawGeom}/${twinIds.length}  norm-stored=${normGeom}/${twinIds.length}`);
  console.log('');

  // =====================================================================
  // ANALYSIS 2 — Path A vs Path B on the 258 surviving pending rows
  //   (residual proxy: same LLM extraction class as the deleted residuals).
  //   q = normalized fingerprint of the pending row (exact dedup.ts:245 shape).
  //   Path A: nearest APPROVED by cosine(q, STORED vector)   [brute over approved]
  //   Path B: nearest APPROVED by cosine(q, fresh NORM vector)
  //   caught_* = nearest cosine ≥ 0.80.
  //   Brute-force over ALL approved is an UPPER BOUND on the live K=10 path,
  //   so a miss here is a fortiori a live miss.
  // =====================================================================
  let pending = db.prepare(
    `SELECT id, title, content, embedding, embedding_model, created_at, source_extractor, review_status
       FROM learnings WHERE review_status='pending_review' AND embedding IS NOT NULL
       ORDER BY id`,
  ).all() as Learning[];
  if (Number.isFinite(pendingLimit)) pending = pending.slice(0, pendingLimit);

  console.error(`[audit] scoring ${pending.length} pending rows (Path A vs Path B) ...`);
  console.log('## Analysis 2 — pending (residual proxy) Path A vs Path B');
  console.log('pending_id | cosA | twinA | cosB | twinB | twinB_predates_TD087 | twinB_before_pending | twinB_model | caught_A | caught_B');

  let caughtA = 0, caughtB = 0, surprises = 0;
  const surpriseRows: string[] = [];
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const q = await generateEmbedding(normFingerprint(p.title, p.content));
    let bestA = -1, bestAId = -1, bestB = -1, bestBId = -1;
    for (const a of approved) {
      if (a.id === p.id) continue;
      const ca = cosine(q, storedVec.get(a.id)!);
      if (ca > bestA) { bestA = ca; bestAId = a.id; }
      const cb = cosine(q, normVec.get(a.id)!);
      if (cb > bestB) { bestB = cb; bestBId = a.id; }
    }
    const cA = bestA >= THRESHOLD;
    const cB = bestB >= THRESHOLD;
    if (cA) caughtA++;
    if (cB) caughtB++;
    const twinB = byId.get(bestBId);
    const twinBPredates = twinB && twinB.created_at < TD087_DATE ? 'YES' : 'no';
    const twinBBefore = twinB && twinB.created_at < p.created_at ? 'YES' : 'no';
    const twinBModel = twinB ? (twinB.embedding_model === EMBEDDING_MODEL ? 'ok' : (twinB.embedding_model || 'empty')) : '-';
    if (cB && !cA) {
      surprises++;
      const line = `${String(p.id).padStart(6)} | ${bestA.toFixed(3)} | ${String(bestAId).padStart(4)} | ${bestB.toFixed(3)} | ${String(bestBId).padStart(4)} | ${twinBPredates.padEnd(4)} | ${twinBBefore.padEnd(4)} | ${twinBModel.padEnd(6)} | ${cA ? 'Y' : 'n'} | ${cB ? 'Y' : 'n'}  <== B-only surprise`;
      surpriseRows.push(line);
    }
    if (i % 40 === 0) console.error(`  ${i}/${pending.length}`);
  }

  // Print the B-only surprises (the artifact signal) plus band summary.
  for (const s of surpriseRows) console.log(s);
  console.log('');
  console.log(`## Headline`);
  console.log(`pending scored          : ${pending.length}`);
  console.log(`caught_A (live-as-is)    : ${caughtA}  (${(100 * caughtA / pending.length).toFixed(1)}%)`);
  console.log(`caught_B (post-backfill) : ${caughtB}  (${(100 * caughtB / pending.length).toFixed(1)}%)`);
  console.log(`B-only surprises (B∧¬A)  : ${surprises}   <-- artifact suppression signal`);
  console.log(`twins RAW-stored         : ${rawGeom}/${twinIds.length}`);

  db.close();
  await disposeEmbeddingPipeline();
}

main().catch((err) => {
  console.error('[td285] FATAL:', err);
  process.exit(1);
});
