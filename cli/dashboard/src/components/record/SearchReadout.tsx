/**
 * FR-246 — ONE readout for "what did this search actually do".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY ONE COMPONENT AND NOT TWO
 * ─────────────────────────────────────────────────────────────────────────
 * FR-246 ships one genuinely hybrid search (briefs) beside four honest
 * substring filters (goals, context docs, suggestions, candidates). The brief's
 * named risk is that those four end up looking identical to the real one — four
 * `filter(includes)` boxes wearing a search's clothes.
 *
 * Two components would let that happen quietly, because nothing would force a
 * surface to declare which one it is. One component with two mutually exclusive
 * inputs makes the declaration structural: a caller passes `retrieval` OR
 * `substring`, and the rendered `data-search-mode` says which.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * `data-search-mode` IS THE GATE'S HANDLE
 * ─────────────────────────────────────────────────────────────────────────
 * `G-BR-13b` asserts that no surface whose PAYLOAD says
 * `search.mode === "substring"` ever renders a recall readout. It reads this
 * attribute rather than matching on the copy, because copy is exactly the thing
 * that goes stale when someone swaps the implementation underneath it — and no
 * gate can catch a stale sentence.
 *
 * The `RetrievalBanner` half moved here VERBATIM from `Learnings.tsx`, where it
 * was FR-240 D3's readout. Its one addition is the attribute.
 */

import type { RetrievalReport, SubstringSearch } from "../../lib/api";

/** The hybrid/degraded readout. Moved from `Learnings.tsx`, wording unchanged. */
export function RetrievalBanner({ retrieval }: { retrieval: RetrievalReport }) {
  const degraded = retrieval.mode !== "hybrid";
  const arms = `bm25 ${retrieval.bm25_hits} · vector ${retrieval.vector_hits} · rrf_k ${retrieval.rrf_k} · weights ${retrieval.weights.bm25}/${retrieval.weights.vector}`;

  if (!degraded) {
    return (
      <p className="record-readout" role="status" data-search-mode={retrieval.mode}>
        HYBRID RECALL — {arms}
      </p>
    );
  }

  return (
    <div className="shell-banner" role="status" data-search-mode={retrieval.mode}>
      {retrieval.mode.toUpperCase().replace("_", " ")} — this search did not run
      both arms.{" "}
      {retrieval.vector_available
        ? "sqlite-vec loaded"
        : "sqlite-vec NOT loaded on the read handle"}
      ;{" "}
      {retrieval.embedding_available
        ? "embeddings available"
        : "the embedding model is unavailable (a cold or absent HF cache is normal before postinstall)"}
      .{" "}
      {/*
        FR-246: the BM25 arm can also be missing, which learnings' version never
        had to say. `briefs_fts` arrives at schema v23, so a brain that has not
        booted the migration has a live vector arm and NO lexical one — and the
        result set looks perfectly healthy while being much smaller.
      */}
      {retrieval.bm25_reason != null ? `${retrieval.bm25_reason}. ` : ""}
      {retrieval.reason ?? ""} Results are still real — they are just less
      complete than hybrid recall. · {arms}
    </div>
  );
}

/**
 * The substring readout.
 *
 * It says FILTER, it names the fields, and it says what it is NOT. That last
 * part is the load-bearing sentence: an operator who reads "no results" on a
 * box that looks like search concludes the brain has nothing, when what
 * happened is that their word does not appear literally.
 */
export function SubstringBanner({ substring }: { substring: SubstringSearch }) {
  return (
    <p className="record-readout" role="status" data-search-mode={substring.mode}>
      SUBSTRING FILTER — literal match over {substring.fields.join(", ")}. No
      ranking and no recall; a synonym will not match.
    </p>
  );
}

/**
 * Render whichever readout this surface has, or nothing.
 *
 * Passing BOTH is a caller bug rather than a rendering decision, so the
 * retrieval report wins and the substring block is ignored — a surface with
 * real retrieval must never also claim to be a substring filter.
 */
export function SearchReadout({
  retrieval,
  substring,
}: {
  retrieval?: RetrievalReport | null;
  substring?: SubstringSearch | null;
}) {
  if (retrieval != null) return <RetrievalBanner retrieval={retrieval} />;
  if (substring != null) return <SubstringBanner substring={substring} />;
  return null;
}
