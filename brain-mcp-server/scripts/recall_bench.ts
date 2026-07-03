/**
 * FR-215 B3 — recall-quality benchmark harness (REPRODUCIBLE RESEARCH HELPER).
 *
 * Sibling of `dedup_corpus_eval.ts`: same read-only DB-load + `generateEmbedding`
 * shape, but instead of pairwise cosine it exercises the SHIPPED hybrid-recall
 * path (`handleMemoryRecall`, memory.ts:~443) against a frozen labeled query set
 * and scores recall@k / precision@k / MRR, binned by query↔target lexical overlap.
 *
 * SAFETY: never opens the live `knowledge.db` writable. It takes a consistent
 * SNAPSHOT of the DB (better-sqlite3 online-backup) into a temp file, opens the
 * COPY, and runs everything there. The live brain is untouched.
 *
 * The recall path reproduced here is byte-faithful to production:
 *   - the exact memory.ts BM25 composite SQL (composite_score w/ access_count
 *     boost + the FR-109 `review_status='approved'` filter),
 *   - `vectorSearch` KNN (sqlite-vec) with the same scope filter,
 *   - `computeRRF` fusion (k=60, weights 0.5/0.5) + the project-local (1.5x),
 *     tech-stack (1.3x) and archetype (1.2x) boosts,
 * so the number reflects shipped behavior, not a re-implementation. It fetches
 * k*2, RRF-fuses, and takes top-k — identical to `handleMemoryRecall`.
 *
 * The HEADLINE is recall@5 on the LOW lexical-overlap band: a query that shares
 * no distinctive tokens with its target yet still retrieves it = genuine
 * semantic recall (recall #163 — cosine 0.85 misses LLM rephrasing; the
 * low-overlap band is exactly that adversarial case).
 *
 * Usage:
 *   npx tsx brain-mcp-server/scripts/recall_bench.ts \
 *     --queryset brain-mcp-server/scripts/fixtures/recall_bench_queryset.jsonl \
 *     [--db ~/.igris/memory/knowledge.db] \
 *     [--k 10] \
 *     [--project igris-ai] \
 *     [--out /tmp/recall_bench_results.json]
 *
 * Determinism: embeddings + RRF are deterministic and the snapshot pins the
 * corpus, so two runs against the same DB + queryset yield IDENTICAL metrics.
 *
 * @module scripts/recall_bench
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { generateEmbedding, disposeEmbeddingPipeline } from '../src/utils/embeddings.js';
import { computeRRF } from '../src/utils/hybrid-search.js';
import { l2ToCosine } from '../src/utils/hybrid-search.js';
import { isVectorSearchAvailable, vectorSearch } from '../src/utils/vector-search.js';
import type { VectorSearchResult } from '../src/utils/vector-search.js';
import { sanitizeFts5Query } from '../src/utils/fts5.js';

const requireCjs = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueryRow {
  qid: string;
  query: string;
  target_ids: number[];
  sibling_ids: number[];
  author: string;
  notes?: string;
}

interface Bm25Row {
  id: number;
  project: string;
  scope: string;
  title: string;
  content: string;
}

interface QueryResult {
  qid: string;
  tier: string;
  author: string;
  query: string;
  target_ids: number[];
  ranked_ids: number[];
  first_hit_rank: number | null;
  reciprocal_rank: number;
  hit_at: Record<string, 0 | 1>;
  precision_at: Record<string, number>;
  overlap_jaccard: number;
  overlap_containment: number;
  band: 'low' | 'med' | 'high';
  top_vector_cosine: number | null;
}

// ---------------------------------------------------------------------------
// Overlap bands (FROZEN thresholds — do not tune per-run, reproducibility)
// ---------------------------------------------------------------------------

const BAND_LOW_MAX = 0.06;   // jaccard < 0.06  → low  (distinctive tokens stripped)
const BAND_MED_MAX = 0.12;   // 0.06..0.12      → med
                             // >= 0.12         → high (FTS-assisted, weaker evidence)

const K_LEVELS = [1, 3, 5, 10];
const P_LEVELS = [1, 5];

// Small English stopword set for content-word extraction.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'with', 'as', 'at', 'by', 'from', 'that', 'this',
  'it', 'its', 'i', 'my', 'you', 'your', 'we', 'our', 'they', 'their', 'do', 'does',
  'did', 'how', 'why', 'what', 'when', 'where', 'which', 'who', 'should', 'would',
  'can', 'could', 'will', 'not', 'no', 'so', 'if', 'get', 'got', 'still', 'even',
  'about', 'into', 'out', 'up', 'over', 'some', 'any', 'all', 'each', 'than', 'then',
]);

function contentWords(text: string): Set<string> {
  const toks = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set<string>();
  for (const t of toks) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Fraction of query content-words that appear in the target (leakage measure). */
function containment(query: Set<string>, target: Set<string>): number {
  if (query.size === 0) return 0;
  let inter = 0;
  for (const x of query) if (target.has(x)) inter++;
  return inter / query.size;
}

function bandOf(j: number): 'low' | 'med' | 'high' {
  if (j < BAND_LOW_MAX) return 'low';
  if (j < BAND_MED_MAX) return 'med';
  return 'high';
}

// ---------------------------------------------------------------------------
// Tech-stack overlap (ported verbatim from memory.ts — production ranking parity)
// ---------------------------------------------------------------------------

function computeTechStackOverlap(stackA: string | null, stackB: string | null): number {
  if (!stackA || !stackB) return 0;
  const setA = new Set(stackA.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const setB = new Set(stackB.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  queryset: string;
  db: string;
  k: number;
  project: string;
  out?: string;
} {
  let queryset = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'fixtures',
    'recall_bench_queryset.jsonl',
  );
  let db = path.join(os.homedir(), '.igris/memory/knowledge.db');
  let k = 10;
  let project = 'igris-ai';
  let out: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--queryset') queryset = argv[++i];
    else if (a === '--db') db = argv[++i].replace(/^~/, os.homedir());
    else if (a === '--k') k = parseInt(argv[++i], 10);
    else if (a === '--project') project = argv[++i];
    else if (a === '--out') out = argv[++i];
  }
  return { queryset, db, k, project, out };
}

/**
 * Snapshot the live DB into a temp WRITABLE copy via better-sqlite3 online
 * backup (consistent even under WAL). The live DB is opened READONLY and never
 * mutated. Returns the temp path (caller deletes).
 */
async function snapshotDb(srcPath: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall_bench_snap_'));
  const dest = path.join(dir, 'snapshot.db');
  const src = new Database(srcPath, { readonly: true });
  try {
    await src.backup(dest);
  } finally {
    src.close();
  }
  return dest;
}

function loadSqliteVec(db: Database.Database): boolean {
  try {
    const sqliteVec = requireCjs('sqlite-vec') as { load: (db: Database.Database) => void };
    sqliteVec.load(db);
    db.prepare('SELECT vec_version()').get();
    return true;
  } catch (err) {
    console.error('[recall_bench] sqlite-vec not available — vector channel disabled:', err);
    return false;
  }
}

// The exact production BM25 composite SQL, COPIED from memory.ts:~443 (bm25Sql).
// COUPLING (FR-215): this must stay byte-identical to handleMemoryRecall's SQL +
// composite_score formula + the FR-109 approved/scope filter. If that SQL, its
// boosts, or the RRF weights change, update this harness in lockstep or the
// benchmark silently drifts from production recall.
const BM25_SQL = `
    SELECT l.id, l.project, l.category, l.title, l.content, l.tags,
           l.tech_stack, l.scope, l.source_brief, l.confidence,
           l.created_at, l.access_count, l.provenance, l.promoted_to_doc,
           rank,
           (rank * 0.6 - l.confidence * 0.2 - MIN(l.access_count, 100) / 100.0 * 0.2) AS composite_score
    FROM learnings_fts fts
    JOIN learnings l ON l.id = fts.rowid
    WHERE learnings_fts MATCH ?
      AND (l.project = ? OR l.scope = 'global')
      AND l.review_status = 'approved'
    ORDER BY composite_score
    LIMIT ?
`;

/**
 * Reproduce `handleMemoryRecall`'s ranking against a snapshot DB. Returns the
 * top-k learning ids in production rank order + the best vector cosine seen.
 * (No access_count UPDATE — read-only benchmark; the update does not affect a
 * single query's own ranking, only future queries, so omitting it keeps the
 * run deterministic and side-effect free.)
 */
async function recall(
  db: Database.Database,
  query: string,
  project: string,
  k: number,
  vecEnabled: boolean,
  projectStacks: Map<string, string>,
  projectArchetypes: Map<string, string>,
): Promise<{ ranked: number[]; topVectorCosine: number | null }> {
  const sanitized = sanitizeFts5Query(query);
  if (!sanitized) return { ranked: [], topVectorCosine: null };

  // --- 1. BM25 ---
  let bm25Rows: { id: number }[] = [];
  try {
    bm25Rows = db.prepare(BM25_SQL).all(sanitized, project, k * 2) as { id: number }[];
  } catch {
    bm25Rows = [];
  }

  // --- 2. Vector KNN with scope filter (memory.ts parity) ---
  let vecResults: VectorSearchResult[] = [];
  let vectorAvailable = false;
  let topVectorCosine: number | null = null;
  try {
    if (vecEnabled && isVectorSearchAvailable(db)) {
      const queryEmbedding = await generateEmbedding(query);
      vecResults = vectorSearch(db, queryEmbedding, k * 2);
      vectorAvailable = true;
      if (vecResults.length > 0) {
        topVectorCosine = l2ToCosine(vecResults[0].distance);
        const ids = vecResults.map(r => r.rowid);
        const placeholders = ids.map(() => '?').join(',');
        const scopeRows = db.prepare(
          `SELECT id FROM learnings WHERE id IN (${placeholders}) AND (project = ? OR scope = 'global') AND review_status = 'approved'`,
        ).all(...ids, project) as { id: number }[];
        const scopeIdSet = new Set(scopeRows.map(r => r.id));
        vecResults = vecResults.filter(r => scopeIdSet.has(r.rowid));
      }
    }
  } catch (err) {
    console.error('[recall_bench] vector search failed, BM25 only:', err);
  }

  if (bm25Rows.length === 0 && vecResults.length === 0) {
    return { ranked: [], topVectorCosine };
  }

  const currentStack = projectStacks.get(project) ?? null;
  const currentArchetype = projectArchetypes.get(project) ?? null;

  let ranked: number[];
  if (vectorAvailable && vecResults.length > 0) {
    const rrfEntries = computeRRF(bm25Rows, vecResults);

    // Hydrate project/scope for the fused id set to drive the boosts.
    const topIds = rrfEntries.map(e => e.id);
    const placeholders = topIds.map(() => '?').join(',');
    const fullRows = db.prepare(
      `SELECT id, project FROM learnings WHERE id IN (${placeholders}) AND review_status = 'approved'`,
    ).all(...topIds) as { id: number; project: string }[];
    const rowMap = new Map<number, { id: number; project: string }>();
    for (const r of fullRows) rowMap.set(r.id, r);

    for (const entry of rrfEntries) {
      const row = rowMap.get(entry.id);
      if (!row) continue;
      // Boost 1: project-local (1.5x) vs tech-stack affinity (1.3x) — exclusive.
      if (row.project === project) {
        entry.score *= 1.5;
      } else if (currentStack) {
        const rowStack = projectStacks.get(row.project) ?? null;
        if (computeTechStackOverlap(currentStack, rowStack) >= 0.5) entry.score *= 1.3;
      }
      // Boost 2: archetype affinity (1.2x, stacks with above).
      if (currentArchetype && currentArchetype !== 'unclassified' && row.project !== project) {
        const rowArchetype = projectArchetypes.get(row.project) ?? null;
        if (rowArchetype && rowArchetype === currentArchetype) entry.score *= 1.2;
      }
    }
    rrfEntries.sort((a, b) => b.score - a.score);
    ranked = rrfEntries.filter(e => rowMap.has(e.id)).slice(0, k).map(e => e.id);
  } else {
    // BM25-only fallback.
    ranked = bm25Rows.slice(0, k).map(r => r.id);
  }

  return { ranked, topVectorCosine };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreQuery(
  q: QueryRow,
  ranked: number[],
  targetContent: string,
  topVectorCosine: number | null,
): QueryResult {
  const positives = new Set<number>([...q.target_ids, ...q.sibling_ids]);
  let firstHitRank: number | null = null;
  for (let i = 0; i < ranked.length; i++) {
    if (positives.has(ranked[i])) {
      firstHitRank = i + 1;
      break;
    }
  }

  const hit_at: Record<string, 0 | 1> = {};
  for (const n of K_LEVELS) {
    hit_at[String(n)] = firstHitRank !== null && firstHitRank <= n ? 1 : 0;
  }
  const precision_at: Record<string, number> = {};
  for (const n of P_LEVELS) {
    let hits = 0;
    for (let i = 0; i < Math.min(n, ranked.length); i++) if (positives.has(ranked[i])) hits++;
    precision_at[String(n)] = hits / n;
  }

  const qWords = contentWords(q.query);
  const tWords = contentWords(targetContent);
  const oj = jaccard(qWords, tWords);
  const oc = containment(qWords, tWords);

  return {
    qid: q.qid,
    tier: q.qid.startsWith('A') ? 'A' : 'B',
    author: q.author,
    query: q.query,
    target_ids: q.target_ids,
    ranked_ids: ranked,
    first_hit_rank: firstHitRank,
    reciprocal_rank: firstHitRank ? 1 / firstHitRank : 0,
    hit_at,
    precision_at,
    overlap_jaccard: +oj.toFixed(4),
    overlap_containment: +oc.toFixed(4),
    band: bandOf(oj),
    top_vector_cosine: topVectorCosine === null ? null : +topVectorCosine.toFixed(4),
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { queryset, db: dbPath, k, project, out } = parseArgs(process.argv);

  const raw = fs.readFileSync(queryset, 'utf8');
  const queries: QueryRow[] = raw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l) as QueryRow);
  console.error(`[recall_bench] loaded ${queries.length} labeled queries from ${queryset}`);

  console.error(`[recall_bench] snapshotting ${dbPath} (read-only) → temp writable copy ...`);
  const snapPath = await snapshotDb(dbPath);
  console.error(`[recall_bench] snapshot at ${snapPath}`);

  const db = new Database(snapPath);
  const vecEnabled = loadSqliteVec(db);

  // Corpus reference (for target content lookup + row count).
  const corpusCount = (db.prepare(
    "SELECT count(*) c FROM learnings WHERE review_status='approved' AND (project=? OR scope='global') AND embedding IS NOT NULL",
  ).get(project) as { c: number }).c;
  console.error(`[recall_bench] corpus: ${corpusCount} approved (${project}+global) learnings with embeddings`);

  const contentById = new Map<number, string>();
  const allTargets = new Set<number>();
  for (const q of queries) for (const t of q.target_ids) allTargets.add(t);
  if (allTargets.size > 0) {
    const ph = [...allTargets].map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, content FROM learnings WHERE id IN (${ph})`).all(...allTargets) as { id: number; content: string }[];
    for (const r of rows) contentById.set(r.id, r.content);
  }

  // Project stacks/archetypes for the production boosts.
  const projectStacks = new Map<string, string>();
  const projectArchetypes = new Map<string, string>();
  const stackRows = db.prepare(
    'SELECT slug, tech_stack, archetype FROM projects WHERE tech_stack IS NOT NULL OR archetype IS NOT NULL',
  ).all() as { slug: string; tech_stack: string; archetype: string | null }[];
  for (const sr of stackRows) {
    if (sr.tech_stack) projectStacks.set(sr.slug, sr.tech_stack);
    if (sr.archetype) projectArchetypes.set(sr.slug, sr.archetype);
  }

  const results: QueryResult[] = [];
  for (const q of queries) {
    const { ranked, topVectorCosine } = await recall(db, q.query, project, k, vecEnabled, projectStacks, projectArchetypes);
    const targetContent = contentById.get(q.target_ids[0]) ?? '';
    results.push(scoreQuery(q, ranked, targetContent, topVectorCosine));
  }

  db.close();
  fs.rmSync(path.dirname(snapPath), { recursive: true, force: true });
  await disposeEmbeddingPipeline();

  // --- Aggregate ---
  const agg = {
    n: results.length,
    recall_at: {} as Record<string, number>,
    precision_at: {} as Record<string, number>,
    mrr: +mean(results.map(r => r.reciprocal_rank)).toFixed(4),
  };
  for (const n of K_LEVELS) agg.recall_at[String(n)] = +mean(results.map(r => r.hit_at[String(n)])).toFixed(4);
  for (const n of P_LEVELS) agg.precision_at[String(n)] = +mean(results.map(r => r.precision_at[String(n)])).toFixed(4);

  const bands: Record<string, QueryResult[]> = { low: [], med: [], high: [] };
  for (const r of results) bands[r.band].push(r);
  const bandTable = Object.entries(bands).map(([band, rs]) => ({
    band,
    n: rs.length,
    recall_at_5: rs.length ? +mean(rs.map(r => r.hit_at['5'])).toFixed(4) : null,
    recall_at_1: rs.length ? +mean(rs.map(r => r.hit_at['1'])).toFixed(4) : null,
    mrr: rs.length ? +mean(rs.map(r => r.reciprocal_rank)).toFixed(4) : null,
  }));
  const headline = bands.low.length ? +mean(bands.low.map(r => r.hit_at['5'])).toFixed(4) : null;

  // --- Report ---
  console.error('\n=== FR-215 B3 recall benchmark ===');
  console.error(`corpus rows (approved ${project}+global, embedded): ${corpusCount}`);
  console.error(`queries: ${agg.n}  |  k=${k}  |  vector channel: ${vecEnabled ? 'ON' : 'OFF (BM25-only)'}`);
  console.error('\nAggregate:');
  console.error(`  recall@1=${agg.recall_at['1']}  recall@3=${agg.recall_at['3']}  recall@5=${agg.recall_at['5']}  recall@10=${agg.recall_at['10']}`);
  console.error(`  precision@1=${agg.precision_at['1']}  precision@5=${agg.precision_at['5']}  MRR=${agg.mrr}`);
  console.error('\nLexical-overlap bands (Jaccard content-words; low<0.06, med<0.12, high>=0.12):');
  console.error('  band | n  | recall@5 | recall@1 | MRR');
  console.error('  -----+----+----------+----------+------');
  for (const b of bandTable) {
    console.error(`  ${b.band.padEnd(4)} | ${String(b.n).padStart(2)} | ${String(b.recall_at_5 ?? '—').padStart(8)} | ${String(b.recall_at_1 ?? '—').padStart(8)} | ${b.mrr ?? '—'}`);
  }
  console.error(`\nHEADLINE — recall@5 on LOW-overlap band: ${headline === null ? 'n/a (no low-band queries)' : headline}`);

  // Calibration check: the A20 near-dup pair (L-817/L-878) must be recalled.
  const calib = results.find(r => r.qid === 'A20');
  if (calib) {
    console.error(`\nCalibration (A20 near-dup L-817/L-878): first_hit_rank=${calib.first_hit_rank ?? 'MISS'} — ${calib.first_hit_rank ? 'OK' : 'HARNESS SUSPECT'}`);
  }

  console.error('\nPer-query:');
  console.error('  qid  tier author           rank ovlpJ  band  hit@5');
  for (const r of results) {
    console.error(
      `  ${r.qid.padEnd(4)} ${r.tier}    ${r.author.padEnd(15)} ${String(r.first_hit_rank ?? 'MISS').padStart(4)} ${String(r.overlap_jaccard).padStart(5)}  ${r.band.padEnd(4)}  ${r.hit_at['5']}`,
    );
  }

  const outObj = {
    generated_at: new Date().toISOString(),
    db: dbPath,
    queryset,
    k,
    project,
    corpus_rows: corpusCount,
    vector_channel: vecEnabled,
    aggregate: agg,
    band_table: bandTable,
    headline_low_band_recall_at_5: headline,
    per_query: results,
  };
  if (out) {
    fs.writeFileSync(out, JSON.stringify(outObj, null, 2));
    console.error(`\n[recall_bench] wrote JSON results to ${out}`);
  }
}

main().catch((err) => {
  console.error('[recall_bench] FATAL:', err);
  process.exit(1);
});
