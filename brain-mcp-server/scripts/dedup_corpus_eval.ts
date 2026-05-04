/**
 * TD-087 — Phase 1 corpus evaluation script (THROWAWAY RESEARCH HELPER).
 *
 * Loads the live `learnings` corpus (read-only), computes pairwise cosine
 * similarity in three modalities (full title+content, title-only, normalised
 * title+content), and emits per-pair CSV rows for hand-labelling and an
 * F1/precision/recall comparison across the four candidate options
 * (A=lower threshold; B=title-only embed; C=content normalisation; A+C).
 *
 * Read-only: opens the DB with `{ readonly: true }`, queries `learnings`,
 * never writes. Embeddings are loaded directly from the BLOB via the
 * `bufferToEmbedding` helper (raw Float32Array bytes, not the vec0 path).
 *
 * For options B and C the script must RE-EMBED candidate text (title-only
 * or normalised(title)+normalised(content)) using the same Xenova model.
 * That cost is bounded — ~150 rows × 2 fresh embeds ≈ 300 model calls;
 * runs in ~30-60 seconds on CPU.
 *
 * Usage:
 *   IGRIS_DB_PATH=~/.igris/memory/knowledge.db \
 *     npx tsx brain-mcp-server/scripts/dedup_corpus_eval.ts \
 *     [--out /tmp/td087_corpus_pairs.csv] \
 *     [--limit 200]
 *
 * After running:
 *   1. Hand-label the `label_blank` column in the CSV as TRUE_DUP / DISTINCT / SKIP.
 *   2. Re-run the script with `--score /tmp/td087_corpus_pairs_labeled.csv`
 *      to compute F1 across options.
 *
 * @module scripts/dedup_corpus_eval
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { generateEmbedding, bufferToEmbedding, disposeEmbeddingPipeline } from '../src/utils/embeddings.js';

interface Row {
  id: number;
  project: string;
  title: string;
  content: string;
  embedding: Float32Array;
}

interface PairOut {
  id_a: number;
  id_b: number;
  title_a: string;
  title_b: string;
  cosine_full: number;
  cosine_title_only: number;
  cosine_normalized: number;
  label_blank: string;
}

// ---------------------------------------------------------------------------
// Normalisation rules (mirror what Phase 2 will ship in dedup.ts)
// ---------------------------------------------------------------------------

/**
 * Reference implementation of `normalizeForDedup` for the eval script.
 * Phase 2 will port this verbatim into `dedup.ts`. Rules:
 *  - lowercase
 *  - strip leading bullet markers (- * •) per line
 *  - replace dash variants (- – — −) with space
 *  - drop terminal punctuation (.!?)
 *  - drop punctuation that does not carry semantic load (: ; , " ' ` ( ) [ ])
 *  - collapse all whitespace to single space
 *  - trim
 */
function normalizeForDedup(text: string): string {
  if (!text) return '';
  let t = text.toLowerCase();
  // strip leading bullet markers per line
  t = t.replace(/^[ \t]*[-*•][ \t]+/gm, '');
  // dash variants -> space
  t = t.replace(/[‐‑‒–—―−-]/g, ' ');
  // drop punctuation that is purely structural in prose
  t = t.replace(/[.!?:;,"'`()\[\]{}<>|/\\+=*~^@#$%&]/g, ' ');
  // collapse whitespace (incl. tabs, newlines)
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// ---------------------------------------------------------------------------
// Cosine on raw Float32Array (L-67 pattern)
// ---------------------------------------------------------------------------

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { out: string; limit: number; score?: string; project?: string } {
  let out = '/tmp/td087_corpus_pairs.csv';
  let limit = 500;
  let score: string | undefined;
  let project: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--limit') limit = parseInt(argv[++i], 10);
    else if (a === '--score') score = argv[++i];
    else if (a === '--project') project = argv[++i];
  }
  return { out, limit, score, project };
}

function dbPath(): string {
  if (process.env.IGRIS_DB_PATH) return process.env.IGRIS_DB_PATH;
  return path.join(os.homedir(), '.igris/memory/knowledge.db');
}

async function loadCorpus(project?: string): Promise<Row[]> {
  const db = new Database(dbPath(), { readonly: true });
  const sql = project
    ? `SELECT id, project, title, content, embedding FROM learnings
       WHERE embedding IS NOT NULL AND project = ?`
    : `SELECT id, project, title, content, embedding FROM learnings
       WHERE embedding IS NOT NULL`;
  const stmt = db.prepare(sql);
  const rows = (project ? stmt.all(project) : stmt.all()) as Array<{
    id: number;
    project: string;
    title: string;
    content: string;
    embedding: Buffer;
  }>;
  db.close();
  return rows.map((r) => ({
    id: r.id,
    project: r.project,
    title: r.title,
    content: r.content,
    embedding: bufferToEmbedding(r.embedding),
  }));
}

/**
 * Decide which pairs to emit for hand-labelling:
 *   - Always: pairs where cosine_full >= 0.75 (potential duplicates)
 *   - Plus a stratified sample from each band so DISTINCT pairs are present.
 */
function selectPairs(rows: Row[], limit: number): Array<[number, number, number]> {
  const pairs: Array<[number, number, number]> = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const c = cosine(rows[i].embedding, rows[j].embedding);
      pairs.push([i, j, c]);
    }
  }
  // sort by cosine desc
  pairs.sort((a, b) => b[2] - a[2]);

  const buckets: Record<string, Array<[number, number, number]>> = {
    '0.95+': [],
    '0.90-0.95': [],
    '0.85-0.90': [],
    '0.80-0.85': [],
    '0.75-0.80': [],
    '<0.75': [],
  };
  for (const p of pairs) {
    const c = p[2];
    if (c >= 0.95) buckets['0.95+'].push(p);
    else if (c >= 0.90) buckets['0.90-0.95'].push(p);
    else if (c >= 0.85) buckets['0.85-0.90'].push(p);
    else if (c >= 0.80) buckets['0.80-0.85'].push(p);
    else if (c >= 0.75) buckets['0.75-0.80'].push(p);
    else buckets['<0.75'].push(p);
  }
  console.error('[corpus_eval] band distribution:');
  for (const [k, v] of Object.entries(buckets)) {
    console.error(`  ${k.padEnd(12)} ${v.length} pairs`);
  }

  // emission strategy:
  //   - emit ALL pairs in [0.75, 1.0] up to `limit/2`
  //   - emit a stratified sample of `<0.75` pairs (every Nth) up to limit/2
  const out: Array<[number, number, number]> = [];
  const high = [...buckets['0.95+'], ...buckets['0.90-0.95'], ...buckets['0.85-0.90'], ...buckets['0.80-0.85'], ...buckets['0.75-0.80']];
  const halfLimit = Math.floor(limit / 2);
  for (const p of high.slice(0, halfLimit)) out.push(p);
  const low = buckets['<0.75'];
  if (low.length > 0) {
    const step = Math.max(1, Math.floor(low.length / halfLimit));
    for (let k = 0; k < low.length && out.length < limit; k += step) out.push(low[k]);
  }
  return out;
}

function csvEscape(s: string): string {
  const t = s.replace(/"/g, '""');
  return `"${t}"`;
}

async function main() {
  const { out, limit, score, project } = parseArgs(process.argv);

  if (score) {
    return scoreLabels(score);
  }

  console.error('[corpus_eval] loading corpus from', dbPath());
  const rows = await loadCorpus(project);
  console.error(`[corpus_eval] ${rows.length} rows loaded with embeddings`);

  if (rows.length < 2) {
    console.error('[corpus_eval] not enough rows to form pairs');
    return;
  }

  // Pre-compute fresh embeddings for title-only and normalized inputs.
  console.error('[corpus_eval] generating fresh embeddings (title-only + normalised) ...');
  const titleEmb: Float32Array[] = [];
  const normEmb: Float32Array[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    titleEmb.push(await generateEmbedding(r.title));
    const normInput = `${normalizeForDedup(r.title)} ${normalizeForDedup(r.content)}`.trim();
    normEmb.push(await generateEmbedding(normInput));
    if (i % 25 === 0) console.error(`  embedded ${i}/${rows.length}`);
  }
  console.error(`  embedded ${rows.length}/${rows.length}`);

  const selected = selectPairs(rows, limit);

  // Force-include known reformulation pair (L-143/L-152) for calibration
  const idxById = new Map<number, number>();
  rows.forEach((r, idx) => idxById.set(r.id, idx));
  const i143 = idxById.get(143);
  const i152 = idxById.get(152);
  if (i143 !== undefined && i152 !== undefined) {
    const present = selected.some(([i, j]) =>
      (rows[i].id === 143 && rows[j].id === 152) || (rows[i].id === 152 && rows[j].id === 143));
    if (!present) {
      const a = Math.min(i143, i152);
      const b = Math.max(i143, i152);
      selected.unshift([a, b, cosine(rows[a].embedding, rows[b].embedding)]);
    }
  }

  const records: PairOut[] = [];
  for (const [i, j, cosFull] of selected) {
    records.push({
      id_a: rows[i].id,
      id_b: rows[j].id,
      title_a: rows[i].title.slice(0, 200),
      title_b: rows[j].title.slice(0, 200),
      cosine_full: cosFull,
      cosine_title_only: cosine(titleEmb[i], titleEmb[j]),
      cosine_normalized: cosine(normEmb[i], normEmb[j]),
      label_blank: '',
    });
  }

  // Write CSV
  const header = ['id_a','id_b','title_a','title_b','cosine_full','cosine_title_only','cosine_normalized','label_blank'].join(',');
  const lines = [header];
  for (const r of records) {
    lines.push([
      r.id_a, r.id_b, csvEscape(r.title_a), csvEscape(r.title_b),
      r.cosine_full.toFixed(4), r.cosine_title_only.toFixed(4),
      r.cosine_normalized.toFixed(4), '',
    ].join(','));
  }
  fs.writeFileSync(out, lines.join('\n'));
  console.error(`[corpus_eval] wrote ${records.length} pairs to ${out}`);

  // Sanity check: L-143/L-152 reformulation pair
  const pair = records.find((r) => (r.id_a === 143 && r.id_b === 152) || (r.id_a === 152 && r.id_b === 143));
  if (pair) {
    console.error('[corpus_eval] L-143/L-152 reformulation pair found:');
    console.error(`  cosine_full       = ${pair.cosine_full.toFixed(4)}`);
    console.error(`  cosine_title_only = ${pair.cosine_title_only.toFixed(4)}`);
    console.error(`  cosine_normalized = ${pair.cosine_normalized.toFixed(4)}`);
  } else {
    console.error('[corpus_eval] WARNING: L-143/L-152 pair not in selected sample (maybe both not in same project? maybe outside top-N?)');
  }

  await disposeEmbeddingPipeline();
}

interface LabeledRow {
  id_a: number;
  id_b: number;
  cosine_full: number;
  cosine_title_only: number;
  cosine_normalized: number;
  label: string;
}

function parseCsv(content: string): LabeledRow[] {
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const out: LabeledRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    // Naive CSV parse: quoted fields can contain commas. Walk char by char.
    const row: string[] = [];
    let cur = '';
    let inQ = false;
    const s = lines[i];
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (inQ) {
        if (ch === '"' && s[k + 1] === '"') { cur += '"'; k++; }
        else if (ch === '"') { inQ = false; }
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { row.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    row.push(cur);
    out.push({
      id_a: parseInt(row[0], 10),
      id_b: parseInt(row[1], 10),
      cosine_full: parseFloat(row[4]),
      cosine_title_only: parseFloat(row[5]),
      cosine_normalized: parseFloat(row[6]),
      label: (row[7] || '').trim().toUpperCase(),
    });
  }
  return out;
}

function scoreLabels(file: string): void {
  const content = fs.readFileSync(file, 'utf8');
  const rows = parseCsv(content).filter(r => r.label === 'TRUE_DUP' || r.label === 'DISTINCT');
  const truedups = rows.filter(r => r.label === 'TRUE_DUP');
  const distincts = rows.filter(r => r.label === 'DISTINCT');
  console.error(`[score] labeled rows: ${rows.length} (${truedups.length} TRUE_DUP, ${distincts.length} DISTINCT)`);

  const options: Array<{ name: string; threshold: number; score: (r: LabeledRow) => number }> = [
    { name: 'A only (full @ 0.85)',          threshold: 0.85, score: r => r.cosine_full },
    { name: 'A only (full @ 0.80)',          threshold: 0.80, score: r => r.cosine_full },
    { name: 'A only (full @ 0.75)',          threshold: 0.75, score: r => r.cosine_full },
    { name: 'B only (title @ 0.85)',         threshold: 0.85, score: r => r.cosine_title_only },
    { name: 'B only (title @ 0.80)',         threshold: 0.80, score: r => r.cosine_title_only },
    { name: 'C only (norm @ 0.85)',          threshold: 0.85, score: r => r.cosine_normalized },
    { name: 'C only (norm @ 0.80)',          threshold: 0.80, score: r => r.cosine_normalized },
    { name: 'C only (norm @ 0.75)',          threshold: 0.75, score: r => r.cosine_normalized },
  ];

  console.error('\nOption                                 |  TP |  FP |  FN |  precision | recall  |  F1');
  console.error('---------------------------------------+-----+-----+-----+------------+---------+--------');
  for (const o of options) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const r of rows) {
      const predicted = o.score(r) >= o.threshold;
      const actual = r.label === 'TRUE_DUP';
      if (predicted && actual) tp++;
      else if (predicted && !actual) fp++;
      else if (!predicted && actual) fn++;
      else tn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    console.error(`${o.name.padEnd(38)} | ${String(tp).padStart(3)} | ${String(fp).padStart(3)} | ${String(fn).padStart(3)} |   ${precision.toFixed(3)}    | ${recall.toFixed(3)}   | ${f1.toFixed(3)}`);
  }
}

main().catch((err) => {
  console.error('[corpus_eval] FATAL:', err);
  process.exit(1);
});
