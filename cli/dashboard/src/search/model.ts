/**
 * FR-248 — the fused search surface's PURE logic: the query builder, the
 * row→display mapper, the per-layer standings, and the two readouts.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN MODULE AND NOT PART OF `layers/model.ts`
 * ─────────────────────────────────────────────────────────────────────────
 * Two reasons, and the second one is the load-bearing one.
 *
 * 1. `layers/model.ts` is in the **INITIAL** chunk (`dashboard-chunks.test.ts`'s
 *    composition table puts it beside `App.tsx` and `router.tsx`). `#/search` is
 *    a LAZY route, so everything written for it belongs behind that boundary or
 *    the split buys nothing. Adding these functions to `layers/model.ts` would
 *    charge them to BOTH ceilings instead of the total one.
 * 2. The vocabularies genuinely differ. `LayerId` is FR-240's FOUR browsable
 *    layers; `SearchLayerId` is FR-248's FIVE searchable ones, and the fifth
 *    (`suggestions`) has no record route at all. Merging them would mean one
 *    union with holes in it, and every consumer narrowing at the call site.
 *
 * What IS reused rather than re-implemented: `recordHash`. The record address is
 * BR-078's `(project, id)` pair and `dashboard-layers-source.test.ts` asserts
 * that no shipped file outside `layers/model.ts` builds a `#/layers/` string. A
 * fused row that opens the wrong project's `BR-001` would be this brief
 * reintroducing the defect the composite address exists to prevent.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE THING THIS FILE EXISTS TO GET RIGHT (D1)
 * ─────────────────────────────────────────────────────────────────────────
 * The fused list mixes two kinds of "rank 1". Two of the five layers ran real
 * ranked recall; the other three ran a literal `LIKE '%q%'` and kept their own
 * list order. So a substring layer's rank 1 is the NEWEST (or the nearest
 * deadline, or the first catalog entry) — **not the best answer to the query**.
 *
 * The operator chose that all five fuse anyway, and chose it against two
 * alternatives, ON THE BASIS that labelling each row is necessary and NOT
 * SUFFICIENT. Hence `recencyReadout`, which is **mandatory**: it returns a
 * sentence for every payload, including the one where no substring layer
 * contributed. A readout that disappears when it has nothing to warn about is a
 * readout the operator learns to read as decoration.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND THE ONE THING IT MUST NOT DO (AC-4)
 * ─────────────────────────────────────────────────────────────────────────
 * `payload.layers` carries one entry per layer on EVERY code path. Nothing here
 * filters that array — `layerStandings` maps it 1:1 and the component renders
 * every element. A layer that could not be searched is REPORTED, with the
 * server's own `reason` verbatim; it is never simply absent from the screen.
 *
 * `requested: false` is NOT a fault. It means `?layers=` excluded the layer, at
 * the operator's own request. It arrives with `available: false` (so the wire
 * invariant `available === false ⟺ reason !== null` holds), which is exactly why
 * a renderer keying only on `available` would paint the operator's own choice as
 * a broken layer. `layerState` reads `requested` FIRST for that reason.
 *
 * @module search/model
 */

import { recordHash, type EmptyCopy, type LayerId } from "../layers/model";
import type {
  FusedLayerReport,
  FusedRow,
  FusedSearchPayload,
  SearchLayerId,
  SearchRankBasis,
} from "../lib/api";

/**
 * The five layers, with their display labels, in the order the server declares
 * them (`search-fuse.ts#DECLARED_LAYERS`).
 *
 * This is the ONE place the client names the set, and it exists because the
 * layer chips must render BEFORE the first response — there is no payload to
 * derive them from yet. Everywhere a payload IS in hand, the set is read from
 * `payload.layers` instead, so a sixth layer appears on screen even on a client
 * that has not been taught its name.
 */
export const SEARCH_LAYERS: readonly { id: SearchLayerId; label: string }[] = [
  { id: "briefs", label: "BRIEFS" },
  { id: "learnings", label: "LEARNINGS" },
  { id: "goals", label: "GOALS" },
  { id: "suggestions", label: "SUGGESTIONS" },
  { id: "context-docs", label: "CONTEXT DOCS" },
];

/**
 * The fused cap. Applied by the server AFTER fusion, so it falls on the fused
 * order rather than on whichever layer was read first.
 *
 * Matches `layers/model.ts#SEARCH_LIMIT` in value and is declared separately in
 * fact: this is one page of a FIVE-arm read, and coupling it to the per-layer
 * recall limit would mean tuning one surface moved the other.
 */
export const FUSED_LIMIT = 20;

/**
 * Where a row's context line is cut.
 *
 * TRUNCATION, NOT ELLIPSIS-FITTING — the cut point is predictable rather than
 * measured, which is the same rule (and the same reason) as the board's
 * `LABEL_MAX`. The value is pinned by a literal expected string in
 * `__tests__/model.test.ts`, the way `record.test.tsx` R2 pins the board's, so
 * changing it reds a test rather than silently re-cutting every row.
 *
 * 96 rather than the board's 22 because this line is a full-width grep SNIPPET
 * or a status/deadline pair, not a column header in a 280px column.
 */
export const TRAIL_MAX = 96;

/** A layer's display label, falling back to the wire id for an unknown layer. */
export function layerLabel(id: string): string {
  return SEARCH_LAYERS.find((l) => l.id === id)?.label ?? id.toUpperCase();
}

/**
 * The human word for a rank basis.
 *
 * `substring` becomes RECENCY rather than SUBSTRING because the operator's
 * question is "can I trust this position", not "which SQL ran". The wire value
 * is still rendered verbatim in the row's metadata — see `displayRow` — so the
 * payload's own word is on screen too and this is a gloss rather than a rename.
 */
export function basisWord(basis: SearchRankBasis): string {
  return basis === "rrf" ? "RELEVANCE" : "RECENCY";
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * Toggle one layer in the selection, refusing to empty it.
 *
 * **THE REFUSAL IS THE POINT, and it is a real server behaviour rather than a
 * defensive habit.** `params.ts#parseLayers` treats an absent, blank or
 * all-unknown `?layers=` as **all five, not narrowed**. So a client that let the
 * operator deselect the last layer would send `?layers=` and get every layer
 * back — a narrowing that looks applied, reports `requested: true` on all five,
 * and is silently the opposite of what was clicked. Turning the last chip off
 * is therefore a no-op here, and the chip stays visibly on.
 */
export function toggleLayer(
  selected: readonly SearchLayerId[],
  id: SearchLayerId,
): SearchLayerId[] {
  if (!selected.includes(id)) return [...selected, id];
  if (selected.length === 1) return [...selected];
  return selected.filter((l) => l !== id);
}

/**
 * Build the query string for `GET /api/search`.
 *
 * BINDS `q` + `project` + `limit` + `layers` AND NOTHING ELSE, because that is
 * exactly what the endpoint binds (BR-085). Anything else sent would come back
 * as `unknown filter: <name>` in `params`, i.e. the UI reporting its own bug to
 * the operator.
 *
 * `layers` is emitted ONLY for a proper non-empty subset. Sending all five is
 * equivalent on the wire but not in the payload — `parseLayers` would report
 * `narrowed: true` for a search that narrowed nothing — and sending zero is the
 * silent un-narrowing `toggleLayer` exists to prevent. Belt and braces: this
 * function refuses an empty array too, since it is reachable from a caller that
 * does not go through `toggleLayer`.
 */
export function fusedSearchQuery(input: {
  query: string;
  project: string | null;
  /** The selected subset. An empty array is read as "all five". */
  layers: readonly SearchLayerId[];
  limit: number;
}): URLSearchParams {
  const q = new URLSearchParams();
  q.set("q", input.query);
  if (input.project !== null && input.project.length > 0) {
    q.set("project", input.project);
  }
  const narrowed =
    input.layers.length > 0 && input.layers.length < SEARCH_LAYERS.length;
  if (narrowed) q.set("layers", [...input.layers].join(","));
  q.set("limit", String(input.limit));
  return q;
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

/** A fused row, mapped onto the shared `RecordListRow` vocabulary. */
export interface RowDisplay {
  key: string;
  eye: string;
  title: string;
  trail: string | null;
  /** The layer-native address, or `null` for a layer with no record route. */
  href: string | null;
  meta: { k: string; v: string }[];
}

/**
 * Which FR-240 layer view opens this row, or `null`.
 *
 * `suggestions` is the `null`: the triage queue has no per-row address (its rows
 * are acted on in bulk on `#/triage`), so a suggestion row is rendered WITHOUT a
 * link rather than with one that goes somewhere approximate. The four that do
 * map are the four `LayerId`s, and the ids are identical by construction.
 */
export function recordLayerFor(layer: SearchLayerId): LayerId | null {
  return layer === "suggestions" ? null : layer;
}

/** The `#/layers/...` address for a fused row, or `null` (see `recordLayerFor`). */
export function rowHref(row: FusedRow): string | null {
  const layer = recordLayerFor(row.layer);
  if (layer === null) return null;
  // `recordHash`, never a template literal: ONE definition of the BR-078
  // three-segment form, and `dashboard-layers-source.test.ts` asserts it.
  return recordHash({ layer, project: row.ref.project, id: row.ref.id });
}

/** Cut at a fixed character count and mark the cut. See `TRAIL_MAX`. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * One row, ready to render.
 *
 * THE LAYER AND THE RANK BASIS ARE ON EVERY ROW, TWICE OVER — the eye line
 * carries them as prose (`// GOALS · RANK 1 BY RECENCY`) and `meta` carries the
 * wire values (`rank basis: substring`). D1 requires the row to state what its
 * position MEANS without the reader holding the whole payload in their head, and
 * a gloss alone would leave the payload's own word unrendered.
 *
 * `rrf_score` is shown and is NEVER an ordering input — it is null on three
 * layers and on a BM25-only arm, and the two layers that do carry one carry it
 * on scales that mean nothing next to each other. Displaying it is diagnosis;
 * sorting by it would be the cross-type score normalisation RRF exists to avoid.
 */
export function displayRow(row: FusedRow): RowDisplay {
  return {
    key: row.key,
    eye: `// ${layerLabel(row.layer)} · RANK ${row.layer_rank} BY ${basisWord(row.rank_basis)}`,
    title: row.title,
    trail: row.subtitle === null ? null : truncate(row.subtitle, TRAIL_MAX),
    href: rowHref(row),
    meta: [
      { k: "layer", v: row.layer },
      { k: "rank basis", v: row.rank_basis },
      { k: "layer rank", v: String(row.layer_rank) },
      { k: "fused", v: row.fused_score.toFixed(5) },
      { k: "project", v: row.ref.project ?? "—" },
      { k: "id", v: row.ref.id },
      {
        k: "layer rrf",
        v: row.rrf_score === null ? "—" : row.rrf_score.toFixed(4),
      },
      { k: "updated", v: row.updated_at ?? "—" },
    ],
  };
}

// ---------------------------------------------------------------------------
// AC-4 — the per-layer standings
// ---------------------------------------------------------------------------

/**
 * The THREE states a layer can be in on screen, which is one more than the wire
 * has booleans for.
 *
 * `excluded` and `unavailable` are both `available: false` on the wire, and
 * collapsing them is the exact conflation this brief removes: one is the
 * operator's own `?layers=` choice, the other is a fault. `ok` is the layer that
 * ran — INCLUDING one that ran and matched nothing, which is emphatically not a
 * fault either.
 */
export type LayerState = "ok" | "excluded" | "unavailable";

/**
 * The word for each state, and it is deliberately not three synonyms for "off".
 *
 * `EXCLUDED` says WHO did it, because the whole point of separating it from
 * `UNAVAILABLE` is that one of them is not a problem. A strip reading
 * "unavailable / unavailable / searched" for a search the operator narrowed
 * themselves is the conflation with better styling.
 */
const STATE_LABEL: Record<LayerState, string> = {
  ok: "SEARCHED",
  excluded: "EXCLUDED BY YOU",
  unavailable: "UNAVAILABLE",
};

export interface LayerStanding {
  layer: SearchLayerId;
  label: string;
  state: LayerState;
  rank_basis: SearchRankBasis;
  /** The server's own sentence, VERBATIM. Null exactly when `state === "ok"`. */
  reason: string | null;
  hits: number;
  contributed: number;
  /** BR-085 — the wire params this arm actually bound. */
  applied: readonly string[];
  /**
   * The rendered words, COMPUTED HERE rather than in the component.
   *
   * `SearchReadout.tsx` lives in the SHARED `useQFilter` chunk — the one Layers
   * and Triage already fetch — so a runtime `import { basisWord }` from this
   * module would drag the fused search's model into a chunk two routes load and
   * neither uses. Passing the words as data keeps that edge type-only, and it
   * puts the vocabulary in the file the unit test can reach.
   */
  state_label: string;
  basis_label: string;
}

/** `requested` is read FIRST — see this module's header. */
export function layerState(report: FusedLayerReport): LayerState {
  if (!report.requested) return "excluded";
  return report.available ? "ok" : "unavailable";
}

/**
 * Every layer in the payload, in payload order, mapped 1:1.
 *
 * **NOTHING IS FILTERED HERE AND NOTHING MAY BE.** The wire's guarantee is that
 * `layers[]` has one entry per declared layer on every code path; the render
 * side's half of AC-4 is that all of them reach the screen. A `.filter()` in
 * this function would move the silent drop from the server to the client, where
 * the endpoint suite cannot see it.
 */
export function layerStandings(
  layers: readonly FusedLayerReport[],
): LayerStanding[] {
  return layers.map((report) => {
    const state = layerState(report);
    return {
      layer: report.layer,
      label: layerLabel(report.layer),
      state,
      rank_basis: report.rank_basis,
      reason: report.reason,
      hits: report.hits,
      contributed: report.contributed,
      applied: report.applied,
      state_label: STATE_LABEL[state],
      basis_label: `RANKS BY ${basisWord(report.rank_basis)}`,
    };
  });
}

/** The standings that are FAULTS — never the excluded ones. */
export function faults(standings: readonly LayerStanding[]): LayerStanding[] {
  return standings.filter((s) => s.state === "unavailable");
}

/** The standings the operator excluded on purpose. */
export function excluded(standings: readonly LayerStanding[]): LayerStanding[] {
  return standings.filter((s) => s.state === "excluded");
}

// ---------------------------------------------------------------------------
// D1 — the MANDATORY rank-basis readout
// ---------------------------------------------------------------------------

export interface RecencyReadout {
  /** Substring layers that CONTRIBUTED rows — `fusion.substring_layers`, verbatim. */
  contributing: SearchLayerId[];
  /** Every substring layer in the payload, contributing or not. */
  declared: SearchLayerId[];
  /** The denominator, read off `layers.length` — never the literal 5. */
  total: number;
  /** Always a sentence. There is no state in which this is empty. */
  text: string;
}

/**
 * "N of M layers contributed by recency rather than relevance."
 *
 * MANDATORY (D1). It returns a sentence for every payload, including the
 * all-relevance one, because a warning that only appears when it applies is a
 * warning nobody has learned to look for by the time it does.
 *
 * `contributing` comes from `fusion.substring_layers` — the server's own answer
 * to "which substring layers actually put rows in this list" — rather than from
 * a hard-coded list of the three. That is why a change to which layers are
 * substring-only shows up here with no client edit at all. `declared` is derived
 * from `layers[].rank_basis` for the same reason.
 *
 * THE SECOND SENTENCE IS NOT DECORATION. "Recency" is the honest headline but it
 * is not the whole truth: goals order by DEADLINE and context docs by CATALOG
 * POSITION. Saying only "newest first" would be precise-sounding and wrong for
 * two of the three, so the copy names the family of orderings and then says the
 * thing that is true of all of them — rank 1 is not the best answer.
 */
export function recencyReadout(payload: FusedSearchPayload): RecencyReadout {
  const declared = payload.layers
    .filter((l) => l.rank_basis === "substring")
    .map((l) => l.layer);
  const contributing = payload.fusion.substring_layers;
  const total = payload.layers.length;
  const names = (ids: readonly SearchLayerId[]): string =>
    ids.map(layerLabel).join(", ");

  if (contributing.length > 0) {
    return {
      contributing: [...contributing],
      declared,
      total,
      text:
        `RANK BASIS — ${contributing.length} OF ${total} LAYERS CONTRIBUTED BY RECENCY, ` +
        `NOT RELEVANCE: ${names(contributing)}. THESE RAN A LITERAL SUBSTRING MATCH AND KEPT ` +
        `THEIR OWN LIST ORDER (NEWEST FIRST, A DEADLINE, OR A CATALOG POSITION), SO THEIR ` +
        `RANK 1 IS NOT THE BEST ANSWER TO THIS QUERY.`,
    };
  }

  if (declared.length > 0) {
    return {
      contributing: [],
      declared,
      total,
      text:
        `RANK BASIS — 0 OF ${total} LAYERS CONTRIBUTED BY RECENCY. ` +
        `${names(declared)} RANK BY SUBSTRING MATCH AND PUT NO ROW IN THIS LIST, SO EVERY ` +
        `ROW BELOW CAME FROM A RANKED ARM.`,
    };
  }

  return {
    contributing: [],
    declared,
    total,
    text: `RANK BASIS — ALL ${total} LAYERS IN THIS RESPONSE RANK BY RELEVANCE.`,
  };
}

// ---------------------------------------------------------------------------
// The empty states — five, and the ladder between them is the interesting part
// ---------------------------------------------------------------------------

/**
 * Which "nothing to show" this is.
 *
 * Reuses FR-240's four `EmptyKind`s rather than inventing a fifth vocabulary,
 * and the precedence is where the thinking is:
 *
 *   1. a WHOLE-RESPONSE degrade — nothing ran at all;
 *   2. no query submitted yet — the resting state of the page, not an outcome;
 *   3. **zero rows while a layer is UNAVAILABLE** → `degraded`, NOT `empty`.
 *      This is the AC-4 case that matters most and the one a naive ladder gets
 *      wrong: "no results" over a broken layer is indistinguishable on screen
 *      from "the brain knows nothing about this", and the second is the reading
 *      an operator acts on. A dead layer makes an empty result INCOMPLETE, and
 *      the copy says so;
 *   4. zero rows while narrowed (a project scope, or `?layers=`) → `filtered`;
 *   5. zero rows, five live layers, no narrowing → genuinely `empty`.
 *
 * An `excluded` layer is deliberately NOT a fault in (3) — it is narrowing, so
 * it lands in (4) with the rest of the narrowing.
 */
export function fusedEmpty(input: {
  /** The submitted query, or `null` when the operator has not searched yet. */
  query: string | null;
  rows: number;
  /** The whole-response `degraded.reason`, verbatim, or null. */
  degraded: string | null;
  standings: readonly LayerStanding[];
  project: string | null;
}): EmptyCopy {
  if (input.degraded !== null) {
    return {
      kind: "degraded",
      headline: "the search could not run.",
      message:
        "No layer answered. This is a whole-response failure, not an empty result — the reason below is the server's own.",
      meta: input.degraded,
    };
  }

  if (input.query === null) {
    return {
      kind: "empty",
      headline: "nothing searched yet.",
      message:
        "One query, all five layers, one ranked list. Type a query and press RUN — a first search may load the embedding model.",
      meta: "awaiting a query",
    };
  }

  const dead = faults(input.standings);
  if (input.rows === 0 && dead.length > 0) {
    return {
      kind: "degraded",
      headline: "no results — and the search was incomplete.",
      message: `${dead.length} of ${input.standings.length} layer(s) could not be searched, so "nothing matched" is not the same as "nothing exists". Fix the layer(s) named above and search again.`,
      meta: `unavailable: ${dead.map((d) => d.layer).join(", ")}`,
    };
  }

  const off = excluded(input.standings);
  const scoped = input.project !== null && input.project.length > 0;
  if (input.rows === 0 && (off.length > 0 || scoped)) {
    return {
      kind: "filtered",
      headline: "no results in this scope.",
      message:
        "Every layer that ran is healthy — the scope is what is narrow. Re-enable a layer, or clear the project scope, and search again.",
      meta: [
        scoped ? `project: ${input.project ?? ""}` : null,
        off.length > 0 ? `excluded: ${off.map((o) => o.layer).join(", ")}` : null,
      ]
        .filter((s): s is string => s !== null)
        .join(" · "),
    };
  }

  if (input.rows === 0) {
    return {
      kind: "empty",
      headline: "no results.",
      message:
        "All five layers ran and none matched. Two of them rank by relevance and three match literally, so a synonym will not reach the substring three — try the word the record itself would use.",
      meta: `no match for "${input.query}"`,
    };
  }

  // Rows exist; `RecordList` never renders an empty state in that case, but the
  // function is total so a caller cannot get `undefined` back on the happy path.
  return {
    kind: "empty",
    headline: "no results.",
    message: "",
    meta: "",
  };
}
