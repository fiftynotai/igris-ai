/**
 * FR-188 — Memory-system eval runner (one-command orchestrator).
 *
 * Seeds the sealed synthetic corpus into a fresh temp DB via the real
 * `handleMemoryStore` (IGRIS_DB_PATH seam), drives the shipped read handlers
 * over the golden sets, scores the MVP dimensions, and emits a JSON + Markdown
 * scorecard. Deferred dimensions are logged and marked — never silently cut.
 *
 * Usage:
 *   npm run eval:memory -- [--out <path.json>] [--k 10]
 *   npx tsx eval/memory/src/run.ts \
 *     [--corpus <corpus.json>] [--queryset <queryset.jsonl>] \
 *     [--no-answer <no_answer.jsonl>] [--gating <gating.json>] \
 *     [--promotion <promotion.json>] [--out <out.json>] [--k 10]
 *
 * Determinism: pinned embedding model + deterministic RRF + sealed corpus ⇒
 * identical metrics across runs (given the same vector-channel availability).
 *
 * @module eval/memory/run
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposeEmbeddingPipeline } from '../../../src/utils/embeddings.js';
import { seedCorpus, loadCorpus, cleanupSeed, defaultCorpusPath, type CorpusEntry } from './seed.js';
import { runRecallDimension, type GoldenQuery } from './dimensions/recall.js';
import { runNoAnswerDimension, type NoAnswerQuery } from './dimensions/no_answer.js';
import { runGatingDimension, type GatingCasesFile } from './dimensions/gating.js';
import { runPromotionDimension, type PromotionCasesFile } from './dimensions/promotion.js';
import { buildScorecard, renderMarkdown, DEFERRED_DIMENSIONS } from './scorecard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.resolve(__dirname, '..', 'golden');

interface Args {
  corpus: string;
  queryset: string;
  noAnswer: string;
  gating: string;
  promotion: string;
  out?: string;
  k: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    corpus: defaultCorpusPath(),
    queryset: path.join(goldenDir, 'queryset.jsonl'),
    noAnswer: path.join(goldenDir, 'no_answer.jsonl'),
    gating: path.join(goldenDir, 'gating_cases.json'),
    promotion: path.join(goldenDir, 'promotion_cases.json'),
    k: 10,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--corpus') a.corpus = argv[++i];
    else if (arg === '--queryset') a.queryset = argv[++i];
    else if (arg === '--no-answer') a.noAnswer = argv[++i];
    else if (arg === '--gating') a.gating = argv[++i];
    else if (arg === '--promotion') a.promotion = argv[++i];
    else if (arg === '--out') a.out = argv[++i];
    else if (arg === '--k') a.k = parseInt(argv[++i], 10);
  }
  return a;
}

function readJsonl<T>(p: string): T[] {
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const corpus = loadCorpus(args.corpus);
  const queries = readJsonl<GoldenQuery>(args.queryset);
  const noAnswerQueries = readJsonl<NoAnswerQuery>(args.noAnswer);
  const gatingFile = JSON.parse(fs.readFileSync(args.gating, 'utf8')) as GatingCasesFile;
  const promotionFile = JSON.parse(fs.readFileSync(args.promotion, 'utf8')) as PromotionCasesFile;

  console.error(`[eval] corpus=${corpus.length} queries=${queries.length} no-answer=${noAnswerQueries.length} gating=${gatingFile.cases.length} promotion=${promotionFile.cases.length} k=${args.k}`);

  const corpusByKey = new Map<string, CorpusEntry>(corpus.map((c) => [c.key, c]));

  console.error('[eval] seeding fixture DB via real handleMemoryStore (this generates real embeddings) ...');
  const seed = await seedCorpus(corpus);
  console.error(`[eval] seeded ${seed.count} rows → ${seed.dbPath} | vector channel: ${seed.vectorChannel ? 'ON' : 'OFF (BM25-only)'}`);

  try {
    console.error('[eval] dim 1+3 — blind recall + ranking ...');
    const recall = await runRecallDimension(queries, seed.keyToId, corpusByKey, args.k);
    console.error('[eval] dim 2 — no-answer precision ...');
    const noAnswer = await runNoAnswerDimension(noAnswerQueries, args.k);
    console.error('[eval] dim 7 — review-status gating ...');
    const gating = await runGatingDimension(gatingFile.cases, seed.keyToId, args.k);
    console.error('[eval] dim 6 — cross-project promotion ...');
    const promotion = runPromotionDimension(promotionFile.cases, seed.keyToId, seed.promotionNoteFired);

    // DEFERRED dimensions — explicit log lines (no silent scope-cut).
    for (const d of DEFERRED_DIMENSIONS) {
      console.error(`[eval] dimension ${d.dimension} DEFERRED — see FR-188 follow-up`);
    }

    const scorecard = buildScorecard({
      dbPath: seed.dbPath,
      corpusSize: seed.count,
      k: args.k,
      vectorChannel: seed.vectorChannel,
      recall,
      noAnswer,
      gating,
      promotion,
    });

    const outJson = args.out ?? path.join(process.cwd(), 'eval-memory-scorecard.json');
    const outMd = outJson.replace(/\.json$/, '') + '.md';
    fs.writeFileSync(outJson, JSON.stringify(scorecard, null, 2));
    fs.writeFileSync(outMd, renderMarkdown(scorecard));

    // Human summary to stderr (stdout stays clean for piping).
    console.error('\n=== FR-188 memory eval scorecard ===');
    console.error(`vector channel: ${scorecard.vector_channel ? 'ON' : 'OFF (BM25-only)'}`);
    console.error(`HEADLINE blind LOW-band hit@5: ${scorecard.headline.blind_low_band_hit_at_5}`);
    console.error(`recall aggregate: hit@1=${recall.aggregate.hit_at['1']} hit@5=${recall.aggregate.hit_at['5']} MRR=${recall.aggregate.mrr} nDCG@5=${recall.aggregate.ndcg_at_5}`);
    console.error('recall bands:');
    for (const b of recall.bands) {
      console.error(`  ${b.band.padEnd(4)} n=${String(b.n).padStart(2)} hit@5=${b.hit_at_5 ?? '—'} hit@1=${b.hit_at_1 ?? '—'} MRR=${b.mrr ?? '—'}`);
    }
    console.error(`no-answer search-refusal rate: ${noAnswer.headline_search_refusal_rate} (recall/hybrid surface nearest-neighbours by design); search error-rate=${noAnswer.error_rate.search} (FTS5 throws on "?")`);
    console.error(`gating: leaked=${gating.leaked_count} get_returns_all=${gating.get_returns_all} PASS=${gating.pass}`);
    console.error(`promotion: TP=${promotion.tp} FP=${promotion.fp} FN=${promotion.fn} precision=${promotion.precision} recall=${promotion.recall}`);
    console.error(`latency (recall handler ms): mean=${scorecard.latency_ms.mean} p50=${scorecard.latency_ms.p50} max=${scorecard.latency_ms.max}`);
    console.error(`deferred: ${scorecard.deferred.map((d) => d.dimension).join(', ')}`);
    console.error(`\n[eval] wrote ${outJson}`);
    console.error(`[eval] wrote ${outMd}`);
  } finally {
    cleanupSeed(seed);
    await disposeEmbeddingPipeline();
  }
}

main().catch((err) => {
  console.error('[eval] FATAL:', err);
  process.exit(1);
});
