/**
 * FR-248 — `#/search`: one box over every layer, fused by RANK.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FIFTH LAZY ROUTE AND NOT THE SHELL'S SEARCH BOX (D6)
 * ─────────────────────────────────────────────────────────────────────────
 * `App.tsx` says of the nav's shared search state: *"Both consumers treat it as
 * a MUTE over data in memory, never as a query — so sharing one state cannot
 * make one of them silently issue a request the other would not."* Wiring that
 * box to `/api/search` breaks that property BY CONSTRUCTION, and it would make
 * the graph route's box a network call as a side effect. It would also put this
 * whole surface in the EAGER chunk, because the chrome is eager.
 *
 * So the shell box stays what it is, this page brings its own, and the nav slot
 * is deliberately EMPTY on this route (`Nav.tsx` renders it for `graph` and
 * `layers` only). Two search boxes on one screen, one of which quietly means
 * something else, is worse than one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SURFACE'S ONE JOB, WHICH IS NOT "SHOW RESULTS"
 * ─────────────────────────────────────────────────────────────────────────
 * A fused list mixes two kinds of "rank 1": two layers ran real ranked recall,
 * three ran a literal `LIKE '%q%'` and kept their own list order. The operator
 * chose to fuse all five ANYWAY, over two narrower alternatives, on the explicit
 * basis that labelling each row is necessary and NOT sufficient. This page
 * therefore renders, above the rows and unconditionally:
 *
 *   1. the RANK-BASIS readout — "N of M layers contributed by recency, not
 *      relevance", named. Mandatory: it renders for every payload, including
 *      the one with nothing to warn about;
 *   2. the PER-LAYER standings — all five, always, with the server's reason
 *      verbatim for any that could not run (AC-4);
 *
 * and every row carries its layer and its rank basis, twice (a readable gloss in
 * the eye line, the wire word in the metadata).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT REUSES THE RECORD TIER, IT DOES NOT FORK IT
 * ─────────────────────────────────────────────────────────────────────────
 * `RecordList`, `FilterBar` (through `RecordList`'s `filters` prop), `EmptyCopy`
 * and `ProjectScope` are the SAME components the four layer views and the triage
 * surface use — a fused result row is a record row, and a list that looked
 * different would be a second list vocabulary for the same gesture. Those
 * components already sit in the shared async chunk that Layers and Triage fetch,
 * so a third async importer adds no duplicate bytes.
 *
 * All the decisions live in `search/model.ts`, which is pure and unit-tested.
 * This file holds state and markup, and nothing that could be wrong quietly.
 */

import { useEffect, useState } from "react";
import { ProjectScope } from "../components/chrome/ProjectScope";
import { Chip } from "../components/ui/Chip";
import { RecordList, type RecordListRow } from "../components/record/RecordList";
import {
  LayerAvailability,
  SearchReadout,
} from "../components/record/SearchReadout";
import { api, ApiError, type FusedSearchPayload, type SearchLayerId } from "../lib/api";
import { useProjectScope } from "../lib/useProjectScope";
import type { Live } from "../lib/useLive";
import {
  FUSED_LIMIT,
  SEARCH_LAYERS,
  displayRow,
  faults,
  fusedEmpty,
  fusedSearchQuery,
  layerStandings,
  recencyReadout,
  toggleLayer,
} from "../search/model";

export interface SearchProps {
  live: Live;
}

export function Search({ live }: SearchProps) {
  const scope = useProjectScope(live.tick);
  const { project, fatal } = scope;

  /** The SUBMITTED query. `null` = nothing searched yet. */
  const [query, setQuery] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<SearchLayerId[]>(
    SEARCH_LAYERS.map((l) => l.id),
  );
  const [payload, setPayload] = useState<FusedSearchPayload | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Keyed on the SUBMITTED query, never on the draft — and NOT on `live.tick`.
   *
   * Two reasons, and they are different reasons. Search-as-you-type would queue
   * one embedding-model cold start per keystroke across TWO hybrid arms
   * (`Learnings.tsx` learned this first). And re-running on the 5-second beat
   * would re-issue a five-arm read forever while the operator reads the results
   * — the beat is right for a LIST that goes stale, and wrong for an answer to a
   * question that was asked once.
   *
   * The project scope and the layer selection ARE dependencies: both change what
   * was asked, so a stale answer under a new scope would be a lie about which
   * rows exist.
   */
  useEffect(() => {
    if (query === null) {
      setPayload(null);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    setError(null);
    api
      .fusedSearch(
        fusedSearchQuery({
          query,
          project,
          layers: selected,
          limit: FUSED_LIMIT,
        }),
        ctrl.signal,
      )
      .then((p) => {
        if (!ctrl.signal.aborted) setPayload(p);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setSearching(false);
      });
    return () => ctrl.abort();
  }, [query, project, selected]);

  if (fatal !== null) {
    // Same copy and same shape as `Layers.tsx`'s transport failure — this is the
    // server being gone, which is not a search outcome.
    return (
      <RecordList
        eye="// SEARCH"
        heading="SEARCH"
        rows={[]}
        empty={{
          kind: "degraded",
          headline: "server unreachable.",
          message:
            "The dashboard server stopped answering. Restart it with `igris dashboard`.",
          meta: fatal,
        }}
      />
    );
  }

  const standings = payload === null ? [] : layerStandings(payload.layers);
  const readout = payload === null ? null : recencyReadout(payload);
  const rows: RecordListRow[] = (payload?.items ?? []).map((item) => {
    const view = displayRow(item);
    return {
      key: view.key,
      eye: view.eye,
      title: view.title,
      trail: view.trail,
      href: view.href,
      // A suggestion has no record route (see `recordLayerFor`), so its row is
      // rendered UNOPENABLE rather than linked somewhere approximate. `disabled`
      // is what stops `RecordRow` emitting a dead `<button>`.
      disabled: view.href === null,
      meta: view.meta,
    };
  });

  const degradedReason = payload?.degraded?.reason ?? error;
  const dead = faults(standings);

  return (
    <>
      <ProjectScope scope={scope} />

      {/*
        THE LAYER SELECTOR — the `?layers=` control, and the reason `excluded`
        is a state this UI can actually reach.

        Not a `FilterBar` control: those are single-value radiogroups where
        re-clicking the active chip CLEARS it, and this is a multi-select where
        clearing the last one is refused (`toggleLayer` — an empty `?layers=`
        reads as ALL FIVE server-side, so it would silently un-narrow).
        `aria-pressed` rather than `aria-checked` for the same reason: these are
        five independent toggles, not one choice among five.
      */}
      <div className="search-scope">
        <span className="record-filter-label">layers</span>
        <div className="tweaks-chips">
          {SEARCH_LAYERS.map((l) => (
            <Chip
              key={l.id}
              variant="tweak"
              active={selected.includes(l.id)}
              data-layer-chip={l.id}
              onClick={() => setSelected((cur) => toggleLayer(cur, l.id))}
            >
              {l.label}
            </Chip>
          ))}
        </div>
      </div>

      <RecordList
        eye="// SEARCH"
        heading="SEARCH"
        lede="One query, five layers, one ranked list. Ranks are fused; scores never are."
        loading={searching && payload === null}
        banners={
          <>
            {degradedReason != null && (
              <div className="shell-banner" role="status">
                SEARCH DEGRADED — {degradedReason}
              </div>
            )}

            {/*
              AC-4's LOUD half. The standings strip below reports every layer
              including the dead ones, but a fault also gets a banner: a reader
              scanning results should not have to audit a five-row strip to
              discover that a layer is missing from them.

              EXCLUDED layers get no banner, on purpose. The operator turned
              them off two elements up the page; bannering their own click back
              at them is how a banner stops being read.
            */}
            {dead.length > 0 && (
              <div className="shell-banner" role="status">
                {dead.length} OF {standings.length} LAYERS COULD NOT BE SEARCHED —{" "}
                {dead.map((d) => d.label).join(", ")}. THESE RESULTS ARE INCOMPLETE;
                THE CAUSE FOR EACH IS STATED BELOW.
              </div>
            )}

            {/*
              D1's mandatory readout. Rendered for EVERY payload — including the
              one where nothing ranked by recency, which is the case a
              conditional banner would drop and thereby train the operator to
              stop looking for it.
            */}
            {readout !== null && (
              <p className="record-readout" role="status" data-rank-readout="">
                {readout.text}
              </p>
            )}

            {/* All five layers, always, with the server's reasons verbatim. */}
            {payload !== null && <LayerAvailability standings={standings} />}

            {/*
              The two RETRIEVAL layers' own intra-layer reports, through the
              SAME component the per-layer views use. `retrieval` is non-null
              exactly on the `rrf` layers, so this loop renders two readouts and
              cannot render one for a substring layer — which is the property
              `G-BR-13b` asserts by reading `data-search-mode`.
            */}
            {standings.length > 0 &&
              payload?.layers
                .filter((l) => l.retrieval !== null)
                .map((l) => (
                  <SearchReadout key={l.layer} retrieval={l.retrieval} />
                ))}

            {payload !== null && payload.params.length > 0 && (
              // The server's own notes about what it did NOT bind (BR-085) —
              // including the `offset` refusal and TD-326's brain-level warning.
              <div className="shell-banner" role="status">
                REQUEST ADJUSTED — {payload.params.join(" · ")}
              </div>
            )}
          </>
        }
        filters={{
          controls: [],
          onChange: () => undefined,
          search: {
            label: "fused search",
            value: draft,
            placeholder: "ASK EVERY LAYER",
            help:
              query === null
                ? "Briefs and learnings answer by relevance; goals, suggestions and context docs match literally. A first search may load the embedding model."
                : `Fused search for "${query}" — ${payload?.count ?? 0} row(s) from ${
                    standings.filter((s) => s.contributed > 0).length
                  } layer(s). CLEAR to start over.`,
            busy: searching,
            onChange: setDraft,
            onSubmit: () => setQuery(draft.trim().length > 0 ? draft.trim() : null),
            onClear: () => {
              setDraft("");
              setQuery(null);
            },
          },
          readout:
            payload === null
              ? undefined
              : `${payload.count} ROW(S) · RRF_K ${payload.fusion.rrf_k} · CAP ${FUSED_LIMIT}`,
        }}
        rows={rows}
        /*
         * NO PAGINATION, and this is the same argument `Learnings.tsx` makes
         * about recall — one level up. Rank fusion over five arms has no stable
         * offset semantics, so a "page 2" would not be the continuation of page
         * 1. The server states the same refusal in `params` when `?offset=` is
         * sent, so the two halves agree rather than one silently absorbing it.
         */
        empty={fusedEmpty({
          query,
          rows: rows.length,
          degraded: degradedReason ?? null,
          standings,
          project,
        })}
      />
    </>
  );
}
