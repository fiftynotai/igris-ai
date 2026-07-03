/**
 * FR-188 — Ranking + retrieval metrics and lexical-overlap banding.
 *
 * Pure functions over a ranked id list + a relevant (positive) id set. Binary
 * relevance throughout (a learning either answers the query or it does not).
 * The banding logic (content-word Jaccard, low<0.06 / med<0.12 / high) is ported
 * from `scripts/recall_bench.ts` so FR-188's blindness measure is directly
 * comparable to FR-215 B3's.
 *
 * @module eval/memory/metrics
 */

export const K_LEVELS = [1, 3, 5, 10] as const;
export const P_LEVELS = [1, 5] as const;

/** Rank (1-based) of the first relevant id in `ranked`, or null if none hit. */
export function firstHitRank(ranked: number[], positives: Set<number>): number | null {
  for (let i = 0; i < ranked.length; i++) {
    if (positives.has(ranked[i])) return i + 1;
  }
  return null;
}

/** 1 if a relevant id appears within the top k, else 0. */
export function hitAtK(ranked: number[], positives: Set<number>, k: number): 0 | 1 {
  const r = firstHitRank(ranked, positives);
  return r !== null && r <= k ? 1 : 0;
}

/** Fraction of the top k that are relevant. */
export function precisionAtK(ranked: number[], positives: Set<number>, k: number): number {
  let hits = 0;
  const n = Math.min(k, ranked.length);
  for (let i = 0; i < n; i++) if (positives.has(ranked[i])) hits++;
  return hits / k;
}

/** Reciprocal rank of the first hit (0 if no hit). */
export function reciprocalRank(ranked: number[], positives: Set<number>): number {
  const r = firstHitRank(ranked, positives);
  return r ? 1 / r : 0;
}

/**
 * Binary-relevance nDCG@k. IDCG is computed over the number of relevant ids
 * available (capped at k), so a perfect ranking scores 1.0.
 */
export function ndcgAtK(ranked: number[], positives: Set<number>, k: number): number {
  let dcg = 0;
  const n = Math.min(k, ranked.length);
  for (let i = 0; i < n; i++) {
    if (positives.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const ideal = Math.min(k, positives.size);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

// ---------------------------------------------------------------------------
// Lexical-overlap banding (ported from recall_bench.ts — reproducibility parity)
// ---------------------------------------------------------------------------

export const BAND_LOW_MAX = 0.06; // jaccard < 0.06  → low (distinctive tokens stripped)
export const BAND_MED_MAX = 0.12; // 0.06..0.12      → med
//                                   >= 0.12          → high (FTS-assisted, weaker blindness)

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'with', 'as', 'at', 'by', 'from', 'that', 'this',
  'it', 'its', 'i', 'my', 'you', 'your', 'we', 'our', 'they', 'their', 'do', 'does',
  'did', 'how', 'why', 'what', 'when', 'where', 'which', 'who', 'should', 'would',
  'can', 'could', 'will', 'not', 'no', 'so', 'if', 'get', 'got', 'still', 'even',
  'about', 'into', 'out', 'up', 'over', 'some', 'any', 'all', 'each', 'than', 'then',
]);

export function contentWords(text: string): Set<string> {
  const toks = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set<string>();
  for (const t of toks) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export type Band = 'low' | 'med' | 'high';

export function bandOf(j: number): Band {
  if (j < BAND_LOW_MAX) return 'low';
  if (j < BAND_MED_MAX) return 'med';
  return 'high';
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Round to 4 dp for stable, diff-friendly scorecard numbers. */
export function r4(x: number): number {
  return +x.toFixed(4);
}
