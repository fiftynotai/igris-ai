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
// TYPE-ONLY, and that matters here rather than being a style choice: this file
// sits in the SHARED `useQFilter` chunk that Layers and Triage both fetch, and a
// value import from `search/model` would pull the fused search's model into it
// for two routes that never render one. `verbatimModuleSyntax` makes the
// erasure explicit, so this line emits nothing and creates no chunk edge.
import type { LayerStanding } from "../../search/model";

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
 * FR-248 — the PER-LAYER variant, for a surface that searched more than one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A THIRD READOUT AND NOT A THIRD CALLER OF THE TWO ABOVE
 * ─────────────────────────────────────────────────────────────────────────
 * `RetrievalBanner` and `SubstringBanner` each describe ONE search. The fused
 * surface ran five, and the fact that matters about it is not any one arm's mode
 * — it is the SET: which layers ran, which the operator excluded, and which are
 * broken. Rendering five stacked banners would say all of it and communicate
 * none of it, and (worse) a layer with nothing to say would render nothing,
 * which is exactly the absence AC-4 forbids.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT RENDERS EVERY ELEMENT IT IS GIVEN, UNCONDITIONALLY
 * ─────────────────────────────────────────────────────────────────────────
 * There is no `.filter()` in this component and there must not be one. The wire
 * guarantees `layers[]` carries one entry per layer on every code path, and
 * `search/model.ts#layerStandings` maps it 1:1; this is the last link in that
 * chain. A layer whose retrieval is unavailable is REPORTED — with the server's
 * own sentence, verbatim — never silently absent.
 *
 * `data-layer-state` is the gate's handle, for the same reason
 * `data-search-mode` is above: a gate that matched on the copy would go stale
 * the first time the copy improved. THREE values, not two, because `excluded`
 * (the operator's own `?layers=` choice) and `unavailable` (a fault) are
 * different facts and the whole surface exists to stop them being rendered as
 * one.
 */
export function LayerAvailability({
  standings,
}: {
  standings: readonly LayerStanding[];
}) {
  return (
    <ul
      className="search-layers"
      aria-label="Which layers this search reached"
      // The count is stamped so a gate can assert that ALL of them are on
      // screen without knowing their names — the property is "one per declared
      // layer", and a gate that enumerated names would pass a payload missing
      // the sixth layer it had never heard of.
      data-layer-count={standings.length}
    >
      {standings.map((s) => (
        <li
          key={s.layer}
          className="search-layer"
          data-layer={s.layer}
          data-layer-state={s.state}
          data-rank-basis={s.rank_basis}
        >
          <span className="search-layer-head">
            <b>{s.label}</b>
            <span className="search-layer-state">{s.state_label}</span>
            <span className="search-layer-basis">{s.basis_label}</span>
            <span className="search-layer-count">
              {s.state === "ok" ? `${s.contributed} OF ${s.hits} SHOWN` : "NO ROWS"}
            </span>
          </span>
          {/*
            BR-085, per layer. `applied` is derived server-side from the arm's
            OWN options object, so this line is what that arm really bound —
            and on a fused surface the interesting case is a filter that binds
            on some arms and not others, which a whole-response list would
            average away.
          */}
          <span className="search-layer-applied">
            BOUND: {s.applied.length > 0 ? s.applied.join(", ") : "—"}
          </span>
          {/* The server's sentence, verbatim. Never re-worded, never summarised. */}
          {s.reason !== null && (
            <span className="search-layer-reason">{s.reason}</span>
          )}
        </li>
      ))}
    </ul>
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
