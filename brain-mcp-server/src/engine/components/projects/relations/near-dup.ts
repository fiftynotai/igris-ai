// FR-273 D3 — near-duplicate kind gates, PURE. Lexical: always on, runs first,
// never fails open. Semantic: advisory-only (A0 found no separating threshold —
// evidence/E0b-calibration.md).

export const LEXICAL_MEANING_THRESHOLD = 0.5;

// null = advisory (never refuses); a caller may inject one per call.
export const SEMANTIC_THRESHOLD: number | null = null;

export const ADVISORY_ONLY: boolean = SEMANTIC_THRESHOLD === null;

const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'be', 'of', 'to', 'for', 'on', 'onto',
  'in', 'into', 'at', 'by', 'from', 'with', 'and', 'or', 'as', 'its', 'it',
  'that', 'this', 'which', 'another', 'same', 'other',
]);

// Light stem: -ing, -ed, -es (after s/x/z/ch/sh), -s.
export function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && /(ss|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

// Notation fold (not vocabulary): trim, lower case, space/hyphen runs → `_`.
export function foldName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function normaliseName(name: string): string[] {
  const out = new Set<string>();
  for (const t of foldName(name).split('_')) {
    if (t === '' || STOP_WORDS.has(t)) continue;
    out.add(stem(t));
  }
  return [...out].sort();
}

// Content tokens; single letters (the A/B endpoints, a possessive s) dropped.
export function meaningTokens(meaning: string): string[] {
  const out = new Set<string>();
  for (const t of meaning.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length < 2 || STOP_WORDS.has(t)) continue;
    out.add(stem(t));
  }
  return [...out].sort();
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function sameTokenSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && a.length === b.length && jaccard(a, b) === 1;
}

// Character-bigram Dice over folded names (typo tolerance).
export function bigramDice(a: string, b: string): number {
  const grams = (s: string): string[] => {
    const f = foldName(s);
    const g: string[] = [];
    for (let i = 0; i < f.length - 1; i++) g.push(f.slice(i, i + 2));
    return g;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.length === 0 || gb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of ga) counts.set(g, (counts.get(g) ?? 0) + 1);
  let inter = 0;
  for (const g of gb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      inter++;
      counts.set(g, c - 1);
    }
  }
  return (2 * inter) / (ga.length + gb.length);
}

export interface KindLike {
  name: string;
  meaning: string;
  aliases: readonly string[];
}

export interface LexicalHit {
  kind: string;
  gate: 'lexical-name' | 'lexical-meaning';
  score: number;
}

// The strongest lexical hit against the ACTIVE kinds, or null. A name
// token-set match scores 1 and outranks any meaning match.
export function lexicalScore(
  candidate: { name: string; meaning: string; aliases?: readonly string[] },
  kinds: readonly KindLike[],
): LexicalHit | null {
  const candNames = [candidate.name, ...(candidate.aliases ?? [])].map(normaliseName);
  const candMeaning = meaningTokens(candidate.meaning);
  let best: LexicalHit | null = null;
  for (const k of kinds) {
    const kNames = [k.name, ...k.aliases].map(normaliseName);
    if (candNames.some((c) => kNames.some((n) => sameTokenSet(c, n)))) {
      return { kind: k.name, gate: 'lexical-name', score: 1 };
    }
    const score = jaccard(candMeaning, meaningTokens(k.meaning));
    if (score >= LEXICAL_MEANING_THRESHOLD && (best === null || score > best.score)) {
      best = { kind: k.name, gate: 'lexical-meaning', score };
    }
  }
  return best;
}

export function nameSimilarity(input: string, k: KindLike): number {
  const inTokens = normaliseName(input);
  let best = 0;
  for (const label of [k.name, ...k.aliases]) {
    best = Math.max(best, jaccard(inTokens, normaliseName(label)), bigramDice(input, label));
  }
  return best;
}

export const CLOSEST_MIN_SCORE = 0.3;

// Best first (ties keep registry order), at most `limit`; never empty while a
// kind exists, so a refusal always names somewhere to go.
export function closestKinds(input: string, kinds: readonly KindLike[], limit = 3): string[] {
  const scored = kinds.map((k, i) => ({ name: k.name, score: nameSimilarity(input, k), i }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const over = scored.filter((s) => s.score >= CLOSEST_MIN_SCORE).slice(0, limit);
  return (over.length > 0 ? over : scored.slice(0, 1)).map((s) => s.name);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
