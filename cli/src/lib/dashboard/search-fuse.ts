/**
 * FR-248 — PURE inter-layer rank fusion for `GET /api/search`.
 *
 * THIS FILE TAKES NO `db`, ISSUES NO QUERY AND DOES NO I/O. It receives lists
 * that five arms have already produced and decides only what ORDER they go in.
 * That is what keeps `routes.ts`'s zero-SQL rule true with a new module in the
 * server layer rather than by exception, and it is why the whole of the fusion
 * is unit-testable with no socket and no brain (`dashboard-search-fused.test.ts`
 * drives it both ways: directly, and through the endpoint).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE ARITHMETIC LOOKS LIKE A BUG, SAID OUT LOUD SO IT IS NOT FILED AS ONE
 * ─────────────────────────────────────────────────────────────────────────
 * Reciprocal rank fusion normally SUMS a document's reciprocal ranks across the
 * lists it appears in. Here every fused row belongs to exactly ONE layer — a
 * brief is never also a goal — so the sum has exactly one term:
 *
 *     fused_score(row) = weight[layer] / (k + rank_within_layer)
 *
 * With uniform weights that makes the result a **deterministic round-robin
 * interleave by within-layer rank**: every layer's rank-1 row scores
 * identically, then every layer's rank-2 row, and so on. That is CORRECT, and
 * it is exactly what "fuse ranks, never scores" produces over disjoint lists.
 * The first reviewer who expects RRF to "do something" will read it as broken;
 * it is not, and this paragraph is the answer.
 *
 * WHAT IT BUYS, which is the whole of AC-2: three of the five layers are
 * SUBSTRING-only and carry no score at all, and the two that do carry one carry
 * an INTRA-layer RRF score on a scale that means nothing next to another
 * layer's. Any fusion that read those numbers would sink the three scoreless
 * layers as a block while looking like ranking. Fusing ranks is what makes a
 * goal and a brief comparable without inventing a scale for them.
 *
 * TIES ARE BROKEN DETERMINISTICALLY — layer name ASC, then row key ASC — so the
 * order is stable across runs and across machines. An unstable tie-break would
 * make the endpoint's own ordering assertion flaky and would make the browser
 * gate's DOM twin unassertable.
 *
 * @module lib/dashboard/search-fuse
 */

import type {
  FusedRowPayload,
  SearchLayerId,
  SearchRankBasis,
} from "../../types.js";

/**
 * The five layers, in the order they appear in `layers[]` on the wire.
 *
 * ONE definition. `layers[].length === DECLARED_LAYERS.length` on every code
 * path is the structural property that makes a silently dropped layer
 * unrepresentable (AC-4) — a handler that filters this array is a handler that
 * can lose a layer, which is why the endpoint suite asserts the set by hand
 * rather than by importing this constant.
 */
export const DECLARED_LAYERS: readonly SearchLayerId[] = [
  "briefs",
  "learnings",
  "goals",
  "suggestions",
  "context-docs",
];

/**
 * The INTER-layer `k`. D2.
 *
 * REUSED from the intra-layer default (`memory-read.ts` / `briefs-read.ts` both
 * default `rrf_k ?? 60`), NOT inherited from it. Those parameters fuse a
 * layer's BM25 arm against its vector arm; FR-246 defined nothing for fusing
 * layers against each other, so this is a new decision wearing a reused number.
 * It is echoed in a `fusion` block kept structurally distinct from each layer's
 * own `retrieval.rrf_k` so the two stages can never be read as one.
 */
export const FUSION_RRF_K = 60;

/**
 * The per-layer weight. Uniform, and NOT caller-tunable.
 *
 * Tuning weights and `rrf_k` is explicitly out of this brief's scope, so there
 * is no query parameter for either — an un-tunable constant that is ECHOED is
 * honest, where a tunable one nobody validated would be a retrieval decision
 * smuggled in as plumbing.
 */
export const FUSION_LAYER_WEIGHT = 1;

/** `{briefs: 1, learnings: 1, …}` — derived, never hand-listed. */
export function fusionWeights(): Record<SearchLayerId, number> {
  const out = {} as Record<SearchLayerId, number>;
  for (const layer of DECLARED_LAYERS) out[layer] = FUSION_LAYER_WEIGHT;
  return out;
}

/**
 * A row's identity within the fused list: layer, project and id.
 *
 * THE PROJECT SEGMENT IS LOAD-BEARING (BR-078). `BR-001` names a DIFFERENT
 * brief in 25 projects and `briefs_fts` indexes the id, so one query really can
 * return two rows whose `ref.id` is identical. A key of `layer:id` would
 * collide, and a UI keying its list on it would render one row where there are
 * two — a silent drop introduced by the identity function rather than by the
 * fusion. Globally-addressed layers (goals, learnings) contribute an empty
 * middle segment, which costs a character and keeps ONE rule for all five.
 */
export function fusedKey(
  layer: SearchLayerId,
  ref: { project: string | null; id: string },
): string {
  return `${layer}:${ref.project ?? ""}:${ref.id}`;
}

/** The single-term RRF score. See the header for why there is only one term. */
export function fusedScore(rank: number, weight = FUSION_LAYER_WEIGHT): number {
  return weight / (FUSION_RRF_K + rank);
}

/**
 * What one arm hands the fuser: a row stripped of everything the fuser assigns.
 *
 * The arm owns identity and display; the fuser owns position. Keeping those
 * apart is what lets the fusion be tested with synthetic rows that no reader
 * could produce — which is the only way to build the scale-divergence case
 * AC-2 needs.
 */
export interface FusedRowSeed {
  /** The layer-native address. `project` is null for globally-addressed rows. */
  ref: { project: string | null; id: string };
  title: string;
  subtitle: string | null;
  updated_at: string | null;
  /**
   * The layer's own INTRA-layer score, carried for diagnosis only.
   *
   * **The fuser never reads this field.** That is not an accident of the
   * implementation, it is AC-2: reading it would be the ad-hoc score
   * normalisation across types that RRF exists to avoid.
   */
  rrf_score: number | null;
}

/** One layer's ranked contribution, ALREADY in its own rank order. */
export interface LayerRanking {
  layer: SearchLayerId;
  rank_basis: SearchRankBasis;
  rows: readonly FusedRowSeed[];
}

/**
 * Fuse the per-layer lists into one ranked list.
 *
 * @param rankings one entry per CONTRIBUTING layer. A layer that is
 *   unavailable or returned nothing simply does not appear here — its standing
 *   is reported through `layers[]`, which is a different array precisely so
 *   that "contributed no rows" and "is not in the payload" are different facts.
 * @param limit the fused cap. Applied AFTER fusion, so the cap falls on the
 *   fused order rather than on whichever layer happened to be read first.
 */
export function fuseLayers(
  rankings: readonly LayerRanking[],
  limit: number,
): FusedRowPayload[] {
  const rows: FusedRowPayload[] = [];
  for (const ranking of rankings) {
    ranking.rows.forEach((seed, index) => {
      const rank = index + 1;
      rows.push({
        layer: ranking.layer,
        rank_basis: ranking.rank_basis,
        layer_rank: rank,
        fused_score: fusedScore(rank),
        key: fusedKey(ranking.layer, seed.ref),
        ref: seed.ref,
        title: seed.title,
        subtitle: seed.subtitle,
        updated_at: seed.updated_at,
        rrf_score: seed.rrf_score,
      });
    });
  }

  rows.sort((a, b) => {
    if (a.fused_score !== b.fused_score) return b.fused_score - a.fused_score;
    // The tie-break, and it is load-bearing rather than cosmetic: with uniform
    // weights EVERY row at a given rank ties, so this comparison decides the
    // whole visible order of the interleave.
    if (a.layer !== b.layer) return a.layer < b.layer ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return rows.slice(0, limit);
}

/**
 * Is a RETRIEVAL layer searchable at all, and if not, why not?
 *
 * PURE over the report the reader already emits, so the answer is derived from
 * what the arm SAID rather than from a second opinion about the schema.
 *
 * THE DISTINCTION THAT MATTERS: "nothing matched" is NOT "unavailable". A layer
 * whose arms both ran and returned zero rows is available and empty — reporting
 * it as unavailable would be the silent-degrade conflation this brief exists to
 * remove, running backwards. So availability is decided by whether an ARM could
 * run, never by the hit count.
 *
 * @param report `reason` is the VECTOR arm's (non-null exactly when it did not
 *   run); `bm25_reason` is the LEXICAL arm's. `bm25_reason` is `undefined` for
 *   learnings, which is not an oversight: `learnings_fts` has existed since
 *   schema v1 so that reader has no such field, while `briefs_fts` arrives at
 *   v23 and briefs do. An absent field therefore means "this layer's lexical
 *   arm cannot be missing", which is exactly the right reading.
 */
export function retrievalAvailability(report: {
  reason: string | null;
  bm25_reason?: string | null;
}): { available: boolean; reason: string | null } {
  const lexicalOut = (report.bm25_reason ?? null) !== null;
  const vectorOut = report.reason !== null;
  if (!lexicalOut || !vectorOut) return { available: true, reason: null };
  // BOTH arms named, joined. One of the two alone would be a report that is
  // true and misleading — an operator told only about `briefs_fts` would run
  // the migration and still get nothing.
  return {
    available: false,
    reason: `no retrieval arm available — lexical: ${report.bm25_reason}; vector: ${report.reason}`,
  };
}

/**
 * BR-085 — the wire parameter names an arm ACTUALLY bound.
 *
 * DERIVED FROM THE OPTIONS OBJECT BEING PASSED, never from a hand-written list
 * beside the call. That ordering is the fix to BR-085's CLASS: the claim and
 * the call cannot drift because the claim is computed from the call.
 *
 * `boundBy` maps a WIRE name to the option key it binds — a map and not a set,
 * because `q` binds `query` and a name-equality check would report the one
 * parameter the endpoint exists to use as dropped.
 *
 * Typing the values `keyof O` is the compile-time half: a map claiming a
 * binding the options object does not have FAILS TO COMPILE. Removing a key
 * from the options object without removing it here — the way BR-085 comes
 * back — is a type error, and if it somehow were not, the value would be
 * `undefined` and this function would not report it as applied.
 */
export function appliedParams<O extends object>(
  opts: O,
  boundBy: ReadonlyMap<string, keyof O>,
): string[] {
  const applied: string[] = [];
  for (const [wireName, optionKey] of boundBy) {
    if (opts[optionKey] !== undefined) applied.push(wireName);
  }
  return applied.sort();
}
